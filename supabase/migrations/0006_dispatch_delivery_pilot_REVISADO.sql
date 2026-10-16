BEGIN;
-- Core 0.5B, PILOT ONLY: despacho fisico y confirmacion de entrega.
-- NO registra cobros ni liquidaciones. Ejecutar UNA VEZ despues de 0005.
ALTER TABLE public.delivery_routes ADD COLUMN dispatched_at timestamptz;
ALTER TABLE public.delivery_routes ADD COLUMN dispatched_by uuid REFERENCES public.staff_profiles(user_id);
ALTER TABLE public.delivery_routes ADD COLUMN completed_at timestamptz;

-- Separate immutable stock ledger for delivery orders; never fake a counter sale.
CREATE TABLE public.delivery_inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.customer_orders(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES public.order_reservations(id),
  lot_id uuid NOT NULL REFERENCES public.inventory_lots(id),
  quantity numeric(14,4) NOT NULL CHECK (quantity > 0),
  actor_id uuid NOT NULL REFERENCES public.staff_profiles(user_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.delivery_inventory_movements FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.delivery_inventory_movements TO authenticated;
ALTER TABLE public.delivery_inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_inventory_admin_read ON public.delivery_inventory_movements
 FOR SELECT TO authenticated USING (public.staff_has_role(ARRAY['admin']));

CREATE FUNCTION public.dispatch_delivery_route(p_route_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_route public.delivery_routes%ROWTYPE;
 v_order record;
 v_variant record;
 v_res record;
 v_count integer;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_route_id IS NULL THEN RAISE EXCEPTION 'Route required'; END IF;
 SELECT * INTO v_route FROM public.delivery_routes WHERE id=p_route_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not found'; END IF;
 IF v_route.dispatched_at IS NOT NULL THEN RETURN; END IF;
 IF v_route.status<>'planning' THEN RAISE EXCEPTION 'Route is not open'; END IF;
 SELECT count(*) INTO v_count FROM public.delivery_assignments WHERE route_id=p_route_id;
 IF v_count=0 THEN RAISE EXCEPTION 'Route has no orders'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id=v_route.driver_id AND active AND role IN ('admin','driver')) THEN
  RAISE EXCEPTION 'Driver is not active'; END IF;
 -- The route is locked before its orders. Every route-mutating RPC must
 -- follow route -> orders -> variants -> reservations -> lots.
 -- Existing prepare_delivery_outing creates a new route only AFTER locking
 -- its previously unassigned orders, so it cannot race with this existing route.
 -- Future move/remove RPCs must lock their route(s) first in UUID order.
 -- Lock all orders in stable order before consuming any stock.
 FOR v_order IN SELECT o.id,o.status FROM public.customer_orders o
   JOIN public.delivery_assignments a ON a.order_id=o.id
   WHERE a.route_id=p_route_id ORDER BY o.id FOR UPDATE OF o
 LOOP
  IF v_order.status<>'ready' THEN RAISE EXCEPTION 'An order is not ready'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customer_order_lines WHERE order_id=v_order.id)
  THEN RAISE EXCEPTION 'Order has no lines'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_order_lines l
    LEFT JOIN public.order_reservations r ON r.order_line_id=l.id AND r.released_at IS NULL
    WHERE l.order_id=v_order.id GROUP BY l.id,l.quantity
    HAVING coalesce(sum(r.quantity),0)<>l.quantity
  ) THEN RAISE EXCEPTION 'Reservation mismatch'; END IF;
 END LOOP;
 -- Lock variants in deterministic order, as in counter sales and reservations.
 FOR v_variant IN SELECT DISTINCT l.variant_id FROM public.customer_order_lines l
  JOIN public.delivery_assignments a ON a.order_id=l.order_id
  WHERE a.route_id=p_route_id ORDER BY l.variant_id
 LOOP
  PERFORM 1 FROM public.product_variants WHERE id=v_variant.variant_id FOR UPDATE;
 END LOOP;
 -- Consume exact reserved lots, atomically. No partial dispatch on error.
 FOR v_res IN SELECT r.id AS reservation_id,r.lot_id,r.quantity,l.order_id
  FROM public.order_reservations r
  JOIN public.customer_order_lines l ON l.id=r.order_line_id
  JOIN public.delivery_assignments a ON a.order_id=l.order_id
  WHERE a.route_id=p_route_id AND r.released_at IS NULL
  ORDER BY r.lot_id,r.id FOR UPDATE OF r
 LOOP
  UPDATE public.inventory_lots
  SET qty_on_hand=qty_on_hand-v_res.quantity,
      qty_reserved=qty_reserved-v_res.quantity
  WHERE id=v_res.lot_id AND qty_reserved>=v_res.quantity AND qty_on_hand>=v_res.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inventory changed; refresh before dispatch'; END IF;
  INSERT INTO public.delivery_inventory_movements(order_id,reservation_id,lot_id,quantity,actor_id)
  VALUES(v_res.order_id,v_res.reservation_id,v_res.lot_id,v_res.quantity,auth.uid());
  UPDATE public.order_reservations SET released_at=now() WHERE id=v_res.reservation_id;
 END LOOP;
 UPDATE public.customer_orders SET status='out_for_delivery',updated_at=now()
 WHERE id IN (SELECT order_id FROM public.delivery_assignments WHERE route_id=p_route_id);
 UPDATE public.delivery_routes SET dispatched_at=now(),dispatched_by=auth.uid() WHERE id=p_route_id;
END; $$;
REVOKE ALL ON FUNCTION public.dispatch_delivery_route(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_delivery_route(uuid) TO authenticated;

CREATE FUNCTION public.confirm_delivery(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_route_id uuid;v_driver_id uuid;v_status text;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT a.route_id,r.driver_id INTO v_route_id,v_driver_id
 FROM public.delivery_assignments a JOIN public.delivery_routes r ON r.id=a.route_id
 WHERE a.order_id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order is not assigned'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver_id<>auth.uid() THEN
   RAISE EXCEPTION 'Not your delivery'; END IF;
 -- Route lock first so route close and dispatch cannot race.
 PERFORM 1 FROM public.delivery_routes WHERE id=v_route_id AND dispatched_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not dispatched'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 IF v_status='delivered' THEN RETURN; END IF;
 IF v_status<>'out_for_delivery' THEN RAISE EXCEPTION 'Order not out for delivery'; END IF;
 UPDATE public.customer_orders SET status='delivered',updated_at=now() WHERE id=p_order_id;
 IF NOT EXISTS (
  SELECT 1 FROM public.delivery_assignments a JOIN public.customer_orders o ON o.id=a.order_id
  WHERE a.route_id=v_route_id AND o.status<>'delivered'
 ) THEN
  UPDATE public.delivery_routes SET status='closed',completed_at=now() WHERE id=v_route_id;
 END IF;
END; $$;
REVOKE ALL ON FUNCTION public.confirm_delivery(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_delivery(uuid) TO authenticated;

-- The original UNIQUE(route_id,stop_order) is immediate and can reject swaps.
-- Replace it with a DEFERRABLE unique constraint. Existing rows are preserved.
-- This is a schema change: verify the constraint name in your database first.
ALTER TABLE public.delivery_assignments
  DROP CONSTRAINT delivery_assignments_route_id_stop_order_key;
ALTER TABLE public.delivery_assignments
  ADD CONSTRAINT delivery_assignments_route_id_stop_order_key
  UNIQUE(route_id,stop_order) DEFERRABLE INITIALLY IMMEDIATE;

-- Prevent reordering after physical dispatch.
CREATE OR REPLACE FUNCTION public.reorder_delivery_route(p_route_id uuid,p_order_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_driver uuid; v_id uuid; v_pos integer:=0;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT driver_id INTO v_driver FROM public.delivery_routes WHERE id=p_route_id AND status='planning' AND dispatched_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not found or closed'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver<>auth.uid() THEN RAISE EXCEPTION 'Not your route'; END IF;
 IF p_order_ids IS NULL OR cardinality(p_order_ids)=0 OR array_position(p_order_ids,NULL) IS NOT NULL
 OR cardinality(p_order_ids)<>(SELECT count(*) FROM public.delivery_assignments WHERE route_id=p_route_id)
 OR (SELECT count(DISTINCT x) FROM unnest(p_order_ids) AS x)<>cardinality(p_order_ids)
 OR EXISTS (SELECT 1 FROM unnest(p_order_ids) AS x WHERE NOT EXISTS
 (SELECT 1 FROM public.delivery_assignments a JOIN public.customer_orders o ON o.id=a.order_id
  WHERE a.route_id=p_route_id AND a.order_id=x AND o.status='ready'))
 THEN RAISE EXCEPTION 'Route orders mismatch'; END IF;
 -- Defer the route-position uniqueness check until transaction commit.
 -- No arbitrary offsets, no integer overflow and no transient swap conflict.
 SET CONSTRAINTS delivery_assignments_route_id_stop_order_key DEFERRED;
 FOREACH v_id IN ARRAY p_order_ids LOOP
   v_pos:=v_pos+1;
   UPDATE public.delivery_assignments SET stop_order=v_pos WHERE route_id=p_route_id AND order_id=v_id;
 END LOOP;
END; $$;

REVOKE ALL ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) TO authenticated;

-- New RPC instead of altering existing return type.
CREATE FUNCTION public.my_delivery_orders_v2()
RETURNS TABLE(order_id uuid,route_id uuid,route_label text,customer_name text,customer_phone text,delivery_address text,total_cents bigint,stop_order integer,order_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,dr.id,dr.label,o.customer_name,o.customer_phone,o.delivery_address,o.total_cents,a.stop_order,o.status
 FROM public.delivery_assignments a JOIN public.delivery_routes dr ON dr.id=a.route_id
 JOIN public.customer_orders o ON o.id=a.order_id
 WHERE dr.driver_id=auth.uid() AND o.status IN ('ready','out_for_delivery')
 ORDER BY dr.created_at,a.stop_order,o.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.my_delivery_orders_v2() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.my_delivery_orders_v2() TO authenticated;
COMMIT;
