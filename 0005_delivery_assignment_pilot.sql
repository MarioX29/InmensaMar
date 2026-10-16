BEGIN;
-- Initial install ONLY. Do not run if delivery_routes or delivery_assignments exist.
-- Pilot: prepares a delivery outing; DOES NOT dispatch, charge or consume stock.
CREATE TABLE public.delivery_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL UNIQUE,
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
 stop_order integer NOT NULL CHECK (stop_order > 0),
 UNIQUE(route_id,stop_order)
);
CREATE INDEX delivery_assignments_route_idx ON public.delivery_assignments(route_id);
REVOKE ALL ON public.delivery_routes,public.delivery_assignments FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.delivery_routes,public.delivery_assignments TO authenticated;
ALTER TABLE public.delivery_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY routes_staff_read ON public.delivery_routes FOR SELECT TO authenticated
 USING (public.staff_has_role(ARRAY['admin','counter']) OR (driver_id=auth.uid() AND public.staff_has_role(ARRAY['admin','driver'])));
CREATE POLICY assignments_staff_read ON public.delivery_assignments FOR SELECT TO authenticated
 USING (public.staff_has_role(ARRAY['admin','counter']) OR EXISTS (
 SELECT 1 FROM public.delivery_routes dr WHERE dr.id=route_id AND dr.driver_id=auth.uid() AND public.staff_has_role(ARRAY['admin','driver'])));

-- One atomic request: all orders are assigned, or none are.
-- request_id permits safe retry after a lost response.
CREATE FUNCTION public.prepare_delivery_outing(p_request_id uuid,p_driver_id uuid,p_order_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_route uuid; v_order uuid; v_pos integer:=0; v_status text;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_driver_id IS NULL OR p_order_ids IS NULL
    OR cardinality(p_order_ids) NOT BETWEEN 1 AND 30
    OR array_position(p_order_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(p_order_ids) AS x) <> cardinality(p_order_ids)
 THEN RAISE EXCEPTION 'Invalid delivery selection'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,5));
 SELECT id INTO v_route FROM public.delivery_routes WHERE request_id=p_request_id;
 IF FOUND THEN
   IF NOT EXISTS (SELECT 1 FROM public.delivery_routes WHERE id=v_route AND driver_id=p_driver_id)
      OR EXISTS (SELECT 1 FROM public.delivery_assignments WHERE route_id=v_route AND order_id<>ALL(p_order_ids))
      OR (SELECT count(*) FROM public.delivery_assignments WHERE route_id=v_route)<>cardinality(p_order_ids)
   THEN RAISE EXCEPTION 'Request already used for a different outing'; END IF;
   RETURN v_route;
 END IF;
 PERFORM 1 FROM public.staff_profiles WHERE user_id=p_driver_id AND role IN ('admin','driver') AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Select an active driver'; END IF;
 -- Lock orders in canonical order, including when concurrent staff prepare overlapping outings.
 FOR v_order IN SELECT x FROM unnest(p_order_ids) AS x ORDER BY x LOOP
   SELECT status INTO v_status FROM public.customer_orders WHERE id=v_order FOR UPDATE;
   IF NOT FOUND OR v_status<>'ready' THEN RAISE EXCEPTION 'An order is no longer ready. Refresh.'; END IF;
   IF EXISTS (SELECT 1 FROM public.delivery_assignments WHERE order_id=v_order) THEN
     RAISE EXCEPTION 'An order is already assigned. Refresh.';
   END IF;
 END LOOP;
 INSERT INTO public.delivery_routes(request_id,label,driver_id,created_by)
 VALUES(p_request_id,'Salida '||to_char(clock_timestamp(),'DD/MM HH24:MI'),p_driver_id,auth.uid()) RETURNING id INTO v_route;
 FOREACH v_order IN ARRAY p_order_ids LOOP
   v_pos:=v_pos+1;
   INSERT INTO public.delivery_assignments(order_id,route_id,assigned_by,stop_order)
   VALUES(v_order,v_route,auth.uid(),v_pos);
 END LOOP;
 RETURN v_route;
END; $$;
REVOKE ALL ON FUNCTION public.prepare_delivery_outing(uuid,uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.prepare_delivery_outing(uuid,uuid,uuid[]) TO authenticated;

CREATE FUNCTION public.my_delivery_orders()
RETURNS TABLE(order_id uuid,route_id uuid,route_label text,customer_name text,customer_phone text,delivery_address text,total_cents bigint,stop_order integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,dr.id,dr.label,o.customer_name,o.customer_phone,o.delivery_address,o.total_cents,a.stop_order
 FROM public.delivery_assignments a JOIN public.delivery_routes dr ON dr.id=a.route_id
 JOIN public.customer_orders o ON o.id=a.order_id
 WHERE dr.driver_id=auth.uid() AND dr.status='planning' AND o.status='ready'
 ORDER BY dr.created_at,a.stop_order,o.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.my_delivery_orders() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.my_delivery_orders() TO authenticated;

CREATE FUNCTION public.reorder_delivery_route(p_route_id uuid,p_order_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_driver uuid; v_id uuid; v_pos integer:=0;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT driver_id INTO v_driver FROM public.delivery_routes WHERE id=p_route_id AND status='planning' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not found or closed'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver<>auth.uid() THEN RAISE EXCEPTION 'Not your route'; END IF;
 IF p_order_ids IS NULL OR cardinality(p_order_ids)=0 OR array_position(p_order_ids,NULL) IS NOT NULL
 OR cardinality(p_order_ids)<>(SELECT count(*) FROM public.delivery_assignments WHERE route_id=p_route_id)
 OR (SELECT count(DISTINCT x) FROM unnest(p_order_ids) AS x)<>cardinality(p_order_ids)
 OR EXISTS (SELECT 1 FROM unnest(p_order_ids) AS x WHERE NOT EXISTS
 (SELECT 1 FROM public.delivery_assignments a JOIN public.customer_orders o ON o.id=a.order_id
  WHERE a.route_id=p_route_id AND a.order_id=x AND o.status='ready'))
 THEN RAISE EXCEPTION 'Route orders mismatch'; END IF;
 -- Two-phase update to avoid unique(route_id,stop_order) conflicts during swaps.
 UPDATE public.delivery_assignments SET stop_order=stop_order+1000000 WHERE route_id=p_route_id;
 FOREACH v_id IN ARRAY p_order_ids LOOP
   v_pos:=v_pos+1;
   UPDATE public.delivery_assignments SET stop_order=v_pos WHERE route_id=p_route_id AND order_id=v_id;
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.reorder_delivery_route(uuid,uuid[]) TO authenticated;
COMMIT;
