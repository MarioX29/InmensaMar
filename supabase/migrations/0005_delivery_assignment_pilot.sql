BEGIN;
-- Core 0.5A: solo asignacion de rutas; NO despacha ni cobra pedidos.
CREATE TABLE public.delivery_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 2 AND 80),
 driver_id uuid NOT NULL REFERENCES public.staff_profiles(user_id),
 created_by uuid NOT NULL REFERENCES public.staff_profiles(user_id),
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','closed'))
);
CREATE TABLE public.delivery_assignments (
 order_id uuid PRIMARY KEY REFERENCES public.customer_orders(id),
 route_id uuid NOT NULL REFERENCES public.delivery_routes(id),
 assigned_by uuid NOT NULL REFERENCES public.staff_profiles(user_id),
 assigned_at timestamptz NOT NULL DEFAULT now(),
 stop_order integer NOT NULL DEFAULT 1 CHECK (stop_order > 0)
);
CREATE INDEX delivery_assignments_route_idx ON public.delivery_assignments(route_id);
REVOKE ALL ON public.delivery_routes, public.delivery_assignments FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.delivery_routes, public.delivery_assignments TO authenticated;
ALTER TABLE public.delivery_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY routes_staff_read ON public.delivery_routes FOR SELECT TO authenticated
 USING (public.staff_has_role(ARRAY['admin','counter']) OR (driver_id=auth.uid() AND public.staff_has_role(ARRAY['admin','driver'])));
CREATE POLICY assignments_staff_read ON public.delivery_assignments FOR SELECT TO authenticated
 USING (public.staff_has_role(ARRAY['admin','counter']) OR EXISTS (
  SELECT 1 FROM public.delivery_routes dr WHERE dr.id=route_id AND dr.driver_id=auth.uid() AND public.staff_has_role(ARRAY['admin','driver'])
 ));

CREATE FUNCTION public.create_delivery_route(p_label text,p_driver_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'Invalid route name'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id=p_driver_id AND role IN ('admin','driver') AND active) THEN
  RAISE EXCEPTION 'Select an active driver'; END IF;
 INSERT INTO public.delivery_routes(label,driver_id,created_by)
 VALUES(btrim(p_label),p_driver_id,auth.uid()) RETURNING id INTO v_id;
 RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.create_delivery_route(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_delivery_route(text,uuid) TO authenticated;

CREATE FUNCTION public.assign_ready_order(p_order_id uuid,p_route_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_status text;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_order_id IS NULL OR p_route_id IS NULL THEN RAISE EXCEPTION 'Invalid assignment'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
 IF v_status<>'ready' THEN RAISE EXCEPTION 'Only ready orders can be assigned'; END IF;
 PERFORM 1 FROM public.delivery_routes dr JOIN public.staff_profiles sp ON sp.user_id=dr.driver_id
 WHERE dr.id=p_route_id AND dr.status='planning' AND sp.active AND sp.role IN ('admin','driver');
 IF NOT FOUND THEN RAISE EXCEPTION 'Route has no active driver'; END IF;
 INSERT INTO public.delivery_assignments(order_id,route_id,assigned_by,stop_order)
 VALUES(p_order_id,p_route_id,auth.uid(),
   (SELECT COALESCE(MAX(stop_order),0)+1 FROM public.delivery_assignments WHERE route_id=p_route_id));
EXCEPTION WHEN unique_violation THEN
 RAISE EXCEPTION 'Order already assigned. Refresh routes.';
END; $$;
REVOKE ALL ON FUNCTION public.assign_ready_order(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.assign_ready_order(uuid,uuid) TO authenticated;

-- No entrega coordenadas ni datos de otros pedidos al repartidor.
CREATE FUNCTION public.my_delivery_orders()
RETURNS TABLE(order_id uuid,route_label text,customer_name text,customer_phone text,delivery_address text,total_cents bigint,stop_order integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY
 SELECT o.id,dr.label,o.customer_name,o.customer_phone,o.delivery_address,o.total_cents,a.stop_order
 FROM public.delivery_assignments a
 JOIN public.delivery_routes dr ON dr.id=a.route_id
 JOIN public.customer_orders o ON o.id=a.order_id
 WHERE dr.driver_id=auth.uid() AND o.status='ready'
 ORDER BY dr.created_at,a.stop_order,o.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.my_delivery_orders() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.my_delivery_orders() TO authenticated;
-- Ordenar entregas solo antes de despacho; no cambia stock ni estado de pedido.
CREATE FUNCTION public.reorder_delivery_route(p_route_id uuid,p_order_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_driver uuid; v_id uuid; v_position integer := 0;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT driver_id INTO v_driver FROM public.delivery_routes WHERE id=p_route_id AND status='planning' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not found or closed'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver<>auth.uid() THEN RAISE EXCEPTION 'Not your route'; END IF;
 IF p_order_ids IS NULL OR cardinality(p_order_ids)=0
   OR cardinality(p_order_ids)<>(SELECT COUNT(*) FROM public.delivery_assignments WHERE route_id=p_route_id)
   OR (SELECT COUNT(DISTINCT x) FROM unnest(p_order_ids) x)<>cardinality(p_order_ids)
   OR EXISTS(SELECT 1 FROM unnest(p_order_ids) x WHERE NOT EXISTS
      (SELECT 1 FROM public.delivery_assignments a WHERE a.route_id=p_route_id AND a.order_id=x))
 THEN RAISE EXCEPTION 'Route orders mismatch'; END IF;
 FOREACH v_id IN ARRAY p_order_ids LOOP
   v_position:=v_position+1;
   UPDATE public.delivery_assignments SET stop_order=v_position
   WHERE route_id=p_route_id AND order_id=v_id;
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) TO authenticated;
COMMIT;
