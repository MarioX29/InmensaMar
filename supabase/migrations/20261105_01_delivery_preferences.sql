-- Run once after 20261027_public_customer_orders.sql. Existing checkout and cash RPCs stay intact.
BEGIN;
ALTER TABLE public.customer_orders ADD COLUMN delivery_preferences jsonb;
ALTER TABLE public.customer_orders ADD CONSTRAINT customer_orders_delivery_preferences_object
 CHECK (delivery_preferences IS NULL OR jsonb_typeof(delivery_preferences)='object');

CREATE FUNCTION public.submit_storefront_order_v2(p_request_id uuid,p_customer_name text,p_customer_phone text,
 p_delivery_address text,p_notes text,p_items jsonb,p_client_hash text,p_delivery_preferences jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v_result jsonb; v_prior public.customer_orders%ROWTYPE; v_lat numeric; v_lng numeric;
 v_cash numeric; v_url text; v_method text; v_mode text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR jsonb_typeof(p_delivery_preferences) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_delivery_preferences) key)
  IS DISTINCT FROM ARRAY['cash_mode','cash_tendered_cents','latitude','longitude','maps_url','payment_method']::text[]
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF jsonb_typeof(p_delivery_preferences->'maps_url') IS DISTINCT FROM 'string'
  OR jsonb_typeof(p_delivery_preferences->'payment_method') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 v_url:=p_delivery_preferences->>'maps_url'; v_method:=p_delivery_preferences->>'payment_method';
 v_mode:=p_delivery_preferences->>'cash_mode';
 IF char_length(v_url)>500 OR (v_url<>'' AND v_url !~ '^https://(maps\.app\.goo\.gl/[A-Za-z0-9_-]+|goo\.gl/maps/[A-Za-z0-9_-]+|(www\.)?google\.com/maps([/?#][^[:space:]]*)?|maps\.google\.com/[^[:space:]]*)$')
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF p_delivery_preferences->'latitude'<>'null'::jsonb OR p_delivery_preferences->'longitude'<>'null'::jsonb THEN
  IF jsonb_typeof(p_delivery_preferences->'latitude') IS DISTINCT FROM 'number' OR jsonb_typeof(p_delivery_preferences->'longitude') IS DISTINCT FROM 'number'
  THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  v_lat:=(p_delivery_preferences->>'latitude')::numeric; v_lng:=(p_delivery_preferences->>'longitude')::numeric;
  IF v_lat NOT BETWEEN -90 AND 90 OR v_lng NOT BETWEEN -180 AND 180 OR v_url<>'' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 END IF;
 IF v_method='transfer' THEN
  IF p_delivery_preferences->'cash_mode'<>'null'::jsonb OR p_delivery_preferences->'cash_tendered_cents'<>'null'::jsonb THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 ELSIF v_method='cash' AND v_mode='exact' THEN
  IF p_delivery_preferences->'cash_tendered_cents'<>'null'::jsonb THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 ELSIF v_method='cash' AND v_mode='change' THEN
  IF jsonb_typeof(p_delivery_preferences->'cash_tendered_cents') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  v_cash:=(p_delivery_preferences->>'cash_tendered_cents')::numeric;
  IF v_cash<>trunc(v_cash) OR v_cash NOT BETWEEN 1 AND 2147483647 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 ELSE RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 -- Same lock as v1: both endpoints serialize retries, including during a deployment.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,307));
 SELECT o.* INTO v_prior FROM public.customer_orders o JOIN public.storefront_order_requests s ON s.order_id=o.id WHERE s.request_id=p_request_id;
 IF FOUND AND v_prior.delivery_preferences IS DISTINCT FROM p_delivery_preferences THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
 -- v1 still owns pricing, limits, idempotency and stock validation. No reservations or payments here.
 v_result:=public.submit_storefront_order(p_request_id,p_customer_name,p_customer_phone,p_delivery_address,p_notes,p_items,p_client_hash);
 IF v_cash IS NOT NULL AND v_cash<(v_result->>'total_cents')::numeric THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 UPDATE public.customer_orders SET delivery_preferences=p_delivery_preferences
 WHERE id=(v_result->>'order_id')::uuid AND delivery_preferences IS NULL;
 RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.submit_storefront_order_v2(uuid,text,text,text,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_storefront_order_v2(uuid,text,text,text,text,jsonb,text,jsonb) TO service_role;

-- Read only the preferences needed by staff; never grant public table access.
CREATE FUNCTION public.order_delivery_preferences(p_order_ids uuid[])
RETURNS TABLE(order_id uuid,delivery_preferences jsonb,notes text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF coalesce(cardinality(p_order_ids),0)>100 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 RETURN QUERY SELECT o.id,o.delivery_preferences,o.notes FROM public.customer_orders o
 WHERE o.id=ANY(p_order_ids) AND (
  public.staff_has_role(ARRAY['admin','counter']) OR (
   public.staff_has_role(ARRAY['driver']) AND (
    (o.status='ready' AND NOT EXISTS (SELECT 1 FROM public.delivery_assignments a WHERE a.order_id=o.id))
    OR (o.status IN ('ready','out_for_delivery','return_pending') AND EXISTS (
     SELECT 1 FROM public.delivery_assignments a JOIN public.delivery_routes r ON r.id=a.route_id
      WHERE a.order_id=o.id AND r.driver_id=auth.uid()))
   )
  )
 );
END; $$;
REVOKE ALL ON FUNCTION public.order_delivery_preferences(uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.order_delivery_preferences(uuid[]) TO authenticated;
COMMIT;
