BEGIN;
CREATE TABLE IF NOT EXISTS public.customer_order_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
 previous_status text NOT NULL, new_status text NOT NULL,
 changed_by uuid REFERENCES auth.users(id), reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_order_events_order_idx ON public.customer_order_events(order_id,created_at DESC);
REVOKE ALL ON public.customer_order_events FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.customer_order_events TO authenticated;
ALTER TABLE public.customer_order_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_events_staff_read ON public.customer_order_events;
CREATE POLICY order_events_staff_read ON public.customer_order_events FOR SELECT TO authenticated USING (public.staff_has_role(ARRAY['admin','counter']));
CREATE OR REPLACE FUNCTION public.log_customer_order_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.customer_order_events(order_id,previous_status,new_status,changed_by) VALUES(NEW.id,'created',NEW.status,auth.uid());
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.customer_order_events(order_id,previous_status,new_status,changed_by) VALUES(NEW.id,OLD.status,NEW.status,auth.uid());
 END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.log_customer_order_status() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS customer_order_status_audit ON public.customer_orders;
CREATE TRIGGER customer_order_status_audit AFTER INSERT OR UPDATE OF status ON public.customer_orders FOR EACH ROW EXECUTE FUNCTION public.log_customer_order_status();
CREATE OR REPLACE FUNCTION public.advance_pilot_order(p_order_id uuid,p_expected_status text,p_new_status text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old text;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_order_id IS NULL OR NOT ((p_expected_status='accepted' AND p_new_status='preparing') OR (p_expected_status='preparing' AND p_new_status='ready')) THEN RAISE EXCEPTION 'Invalid order transition'; END IF;
 SELECT status INTO v_old FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
 IF v_old=p_new_status THEN RETURN; END IF;
 IF v_old<>p_expected_status THEN RAISE EXCEPTION 'Order status changed. Refresh orders.'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.customer_order_lines WHERE order_id=p_order_id) OR EXISTS (
  SELECT 1 FROM public.customer_order_lines l LEFT JOIN public.order_reservations r ON r.order_line_id=l.id AND r.released_at IS NULL
  WHERE l.order_id=p_order_id GROUP BY l.id,l.quantity HAVING COALESCE(SUM(r.quantity),0)<>l.quantity
 ) THEN RAISE EXCEPTION 'Order reservations do not match requested quantities'; END IF;
 UPDATE public.customer_orders SET status=p_new_status,updated_at=now() WHERE id=p_order_id;
END; $$;
REVOKE ALL ON FUNCTION public.advance_pilot_order(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.advance_pilot_order(uuid,text,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.cancel_pilot_order(p_order_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status text; v_variant record; v_res record;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
 IF v_status='cancelled' THEN RETURN; END IF;
 IF v_status NOT IN ('received','accepted','preparing','ready') THEN RAISE EXCEPTION 'Order cannot be cancelled here'; END IF;
 FOR v_variant IN SELECT DISTINCT variant_id FROM public.customer_order_lines WHERE order_id=p_order_id ORDER BY variant_id LOOP
  PERFORM 1 FROM public.product_variants WHERE id=v_variant.variant_id FOR UPDATE;
 END LOOP;
 FOR v_res IN SELECT r.id,r.lot_id,r.quantity FROM public.order_reservations r JOIN public.customer_order_lines l ON l.id=r.order_line_id
  WHERE l.order_id=p_order_id AND r.released_at IS NULL ORDER BY r.lot_id,r.id FOR UPDATE OF r LOOP
  UPDATE public.inventory_lots SET qty_reserved=qty_reserved-v_res.quantity WHERE id=v_res.lot_id AND qty_reserved>=v_res.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation mismatch. Contact administrator.'; END IF;
  UPDATE public.order_reservations SET released_at=now() WHERE id=v_res.id;
 END LOOP;
 UPDATE public.customer_orders SET status='cancelled',updated_at=now() WHERE id=p_order_id;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_pilot_order(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pilot_order(uuid) TO authenticated;
COMMIT;
