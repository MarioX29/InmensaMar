BEGIN;
-- Requires 0003, 0004, 0005 and 0006 already installed.
-- One database transaction per RPC: no split client-side writes.
CREATE OR REPLACE FUNCTION public.accept_and_prepare_pilot_order(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_status text;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_status='preparing' THEN RETURN; END IF;
  IF v_status='received' THEN
    PERFORM public.accept_pilot_order(p_order_id);
    v_status:='accepted';
  END IF;
  IF v_status='accepted' THEN
    PERFORM public.advance_pilot_order(p_order_id,'accepted','preparing');
  ELSE
    RAISE EXCEPTION 'Order cannot be accepted from current status';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.accept_and_prepare_pilot_order(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_and_prepare_pilot_order(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.prepare_and_dispatch_outing(
  p_request_id uuid,p_driver_id uuid,p_order_ids uuid[]
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_route uuid;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  -- prepare_delivery_outing uses request_id for safe retries.
  v_route:=public.prepare_delivery_outing(p_request_id,p_driver_id,p_order_ids);
  -- dispatch_delivery_route is idempotent for a dispatched route.
  -- If dispatch fails, PostgreSQL rolls back BOTH operations.
  PERFORM public.dispatch_delivery_route(v_route);
  RETURN v_route;
END; $$;
REVOKE ALL ON FUNCTION public.prepare_and_dispatch_outing(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_and_dispatch_outing(uuid,uuid,uuid[]) TO authenticated;

-- Cancel unshipped order and remove its active assignment atomically.
-- A route is locked before the order to match dispatch's lock order.
-- Prior cancelled orders are not deleted by this migration.
CREATE OR REPLACE FUNCTION public.cancel_order_and_cleanup(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_route uuid;v_dispatched timestamptz;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT a.route_id INTO v_route FROM public.delivery_assignments a WHERE a.order_id=p_order_id;
  IF v_route IS NOT NULL THEN
    SELECT dispatched_at INTO v_dispatched FROM public.delivery_routes WHERE id=v_route FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Route not found'; END IF;
    IF v_dispatched IS NOT NULL THEN RAISE EXCEPTION 'Dispatched order requires a return workflow'; END IF;
  END IF;
  PERFORM public.cancel_pilot_order(p_order_id);
  IF v_route IS NOT NULL THEN
    DELETE FROM public.delivery_assignments WHERE order_id=p_order_id AND route_id=v_route;
    IF NOT EXISTS(SELECT 1 FROM public.delivery_assignments WHERE route_id=v_route) THEN
      UPDATE public.delivery_routes SET status='closed',completed_at=now() WHERE id=v_route AND dispatched_at IS NULL;
    END IF;
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.cancel_order_and_cleanup(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order_and_cleanup(uuid) TO authenticated;
COMMIT;
