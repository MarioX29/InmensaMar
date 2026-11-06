


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."accept_and_prepare_pilot_order"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."accept_and_prepare_pilot_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_pilot_order"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.customer_orders%rowtype;
  v_line record;
  v_lot record;
  v_remaining numeric(14,4);
  v_take numeric(14,4);
begin
  if not public.staff_has_role(array['admin','counter']) then raise exception 'Not authorized'; end if;
  select * into v_order from public.customer_orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='accepted' then return; end if;
  if v_order.status<>'received' then raise exception 'Order cannot be accepted'; end if;
  for v_line in select variant_id,id,quantity from public.customer_order_lines
    where order_id=p_order_id order by variant_id,id loop
    -- Same variant lock order used by counter sales.
    perform 1 from public.product_variants where id=v_line.variant_id for update;
    v_remaining := v_line.quantity;
    for v_lot in select id,qty_on_hand,qty_reserved from public.inventory_lots
      where variant_id=v_line.variant_id and status='available'
        and (use_by is null or use_by >= current_date) and qty_on_hand>qty_reserved
      order by use_by nulls last,received_at,id for update loop
      v_take := least(v_remaining,v_lot.qty_on_hand-v_lot.qty_reserved);
      update public.inventory_lots set qty_reserved=qty_reserved+v_take where id=v_lot.id;
      insert into public.order_reservations(order_line_id,lot_id,quantity)
        values(v_line.id,v_lot.id,v_take);
      v_remaining := v_remaining-v_take;
      exit when v_remaining=0;
    end loop;
    if v_remaining>0 then raise exception 'Insufficient available inventory'; end if;
  end loop;
  update public.customer_orders set status='accepted',accepted_by=auth.uid(),updated_at=now() where id=p_order_id;
end; $$;


ALTER FUNCTION "public"."accept_pilot_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_catalog_change"("p_request_id" "uuid", "p_action" "text", "p_family_id" "uuid" DEFAULT NULL::"uuid", "p_variant_id" "uuid" DEFAULT NULL::"uuid", "p_name" "text" DEFAULT NULL::"text", "p_base_unit" "text" DEFAULT NULL::"text", "p_price_cents" integer DEFAULT NULL::integer, "p_active" boolean DEFAULT NULL::boolean) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid := auth.uid(); v_event public.admin_catalog_events%ROWTYPE;
 v_family uuid; v_variant uuid; v_old text; v_new text; v_name text := btrim(p_name);
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_action NOT IN ('create_family','rename_family','create_variant','rename_variant','set_variant_active') OR p_action IS NULL THEN RAISE EXCEPTION 'Invalid request'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 42));
 SELECT * INTO v_event FROM public.admin_catalog_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_event.action<>p_action OR v_event.family_id IS DISTINCT FROM p_family_id AND p_action NOT IN ('create_family','create_variant')
     OR v_event.variant_id IS DISTINCT FROM p_variant_id AND p_action NOT IN ('create_family','create_variant') THEN
   RAISE EXCEPTION 'Request ID already used'; END IF;
  -- Payload fingerprint stored in new_value for all actions, to reject altered retries.
  IF v_event.new_value <> jsonb_build_object('name',p_name,'unit',p_base_unit,'price',p_price_cents,'active',p_active,'family',p_family_id,'variant',p_variant_id)::text THEN
   RAISE EXCEPTION 'Request ID already used with different data'; END IF;
  RETURN coalesce(v_event.variant_id,v_event.family_id);
 END IF;
 IF p_action IN ('create_family','rename_family','create_variant','rename_variant') AND (v_name IS NULL OR length(v_name)=0 OR length(v_name)>100) THEN RAISE EXCEPTION 'Invalid name'; END IF;
 IF p_action='create_family' THEN
  IF p_family_id IS NOT NULL OR p_variant_id IS NOT NULL THEN RAISE EXCEPTION 'Unexpected identifiers'; END IF;
  INSERT INTO public.product_families(name) VALUES(v_name) RETURNING id INTO v_family;
 ELSIF p_action='rename_family' THEN
  IF p_family_id IS NULL OR p_variant_id IS NOT NULL THEN RAISE EXCEPTION 'Family required'; END IF;
  SELECT name INTO v_old FROM public.product_families WHERE id=p_family_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Family not found'; END IF;
  UPDATE public.product_families SET name=v_name WHERE id=p_family_id;
  v_family:=p_family_id;
 ELSIF p_action='create_variant' THEN
  IF p_family_id IS NULL OR p_variant_id IS NOT NULL OR p_base_unit NOT IN ('lb','unit','package') OR p_price_cents IS NULL OR p_price_cents<0 THEN RAISE EXCEPTION 'Invalid variant'; END IF;
  PERFORM 1 FROM public.product_families WHERE id=p_family_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Family not found'; END IF;
  INSERT INTO public.product_variants(family_id,name,base_unit,price_cents,active) VALUES(p_family_id,v_name,p_base_unit,p_price_cents,true) RETURNING id INTO v_variant;
  v_family:=p_family_id;
 ELSIF p_action='rename_variant' THEN
  IF p_variant_id IS NULL THEN RAISE EXCEPTION 'Variant required'; END IF;
  SELECT name,family_id INTO v_old,v_family FROM public.product_variants WHERE id=p_variant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found'; END IF;
  UPDATE public.product_variants SET name=v_name WHERE id=p_variant_id;
  v_variant:=p_variant_id;
 ELSIF p_action='set_variant_active' THEN
  IF p_variant_id IS NULL OR p_active IS NULL THEN RAISE EXCEPTION 'Variant and active state required'; END IF;
  SELECT active::text,family_id INTO v_old,v_family FROM public.product_variants WHERE id=p_variant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Variant not found'; END IF;
  UPDATE public.product_variants SET active=p_active WHERE id=p_variant_id;
  v_variant:=p_variant_id;
 END IF;
 v_new:=jsonb_build_object('name',p_name,'unit',p_base_unit,'price',p_price_cents,'active',p_active,'family',p_family_id,'variant',p_variant_id)::text;
 INSERT INTO public.admin_catalog_events(request_id,action,family_id,variant_id,old_value,new_value,actor_id)
 VALUES(p_request_id,p_action,v_family,v_variant,v_old,v_new,v_actor);
 RETURN coalesce(v_variant,v_family);
END; $$;


ALTER FUNCTION "public"."admin_catalog_change"("p_request_id" "uuid", "p_action" "text", "p_family_id" "uuid", "p_variant_id" "uuid", "p_name" "text", "p_base_unit" "text", "p_price_cents" integer, "p_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_record_expense"("p_request_id" "uuid", "p_amount_cents" bigint, "p_category" "text", "p_payment_source" "text", "p_note" "text" DEFAULT NULL::"text", "p_expense_date" "date" DEFAULT NULL::"date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid:=auth.uid();v_prior public.operating_expenses%ROWTYPE;v_id uuid;
 v_date date:=COALESCE(p_expense_date,(now() AT TIME ZONE 'America/Guatemala')::date);
 v_note text:=NULLIF(btrim(p_note),'');
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents<=0 OR p_amount_cents>100000000000
 OR p_category IS NULL OR p_category NOT IN ('ice','packaging','fuel','transport','utilities','other')
 OR p_payment_source IS NULL OR p_payment_source NOT IN ('business_cash','business_transfer','personal','other')
 OR char_length(COALESCE(v_note,''))>250 OR v_date > (now() AT TIME ZONE 'America/Guatemala')::date
 THEN RAISE EXCEPTION 'Invalid expense'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,121));
 SELECT * INTO v_prior FROM public.operating_expenses WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.actor_id<>v_actor OR v_prior.amount_cents<>p_amount_cents OR v_prior.category<>p_category
  OR v_prior.payment_source<>p_payment_source OR v_prior.note IS DISTINCT FROM v_note
  OR v_prior.expense_date<>v_date THEN RAISE EXCEPTION 'Request ID already used'; END IF;
  RETURN v_prior.id;
 END IF;
 INSERT INTO public.operating_expenses(request_id,amount_cents,category,payment_source,note,expense_date,actor_id)
 VALUES(p_request_id,p_amount_cents,p_category,p_payment_source,v_note,v_date,v_actor) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."admin_record_expense"("p_request_id" "uuid", "p_amount_cents" bigint, "p_category" "text", "p_payment_source" "text", "p_note" "text", "p_expense_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reduce_inventory"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_reason" "text", "p_note" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
 v_actor uuid := auth.uid();
 v_existing public.admin_inventory_adjustments%ROWTYPE;
 v_adjustment_id uuid;
 v_lot record;
 v_remaining numeric(14,4);
 v_take numeric(14,4);
 v_unit text;
 v_note text := nullif(btrim(p_note),'');
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_variant_id IS NULL OR p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 100000
   OR scale(p_quantity) > 4 OR p_reason IS NULL OR p_reason NOT IN ('waste','count_difference','other')
   OR length(coalesce(v_note,'')) > 250 THEN RAISE EXCEPTION 'Invalid adjustment'; END IF;
 -- Serialize with sales, which lock the variant before the inventory lots.
 SELECT base_unit INTO v_unit FROM public.product_variants WHERE id=p_variant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Product unavailable'; END IF;
 IF v_unit <> 'lb' AND p_quantity <> trunc(p_quantity) THEN RAISE EXCEPTION 'Whole units required'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,27));
 SELECT * INTO v_existing FROM public.admin_inventory_adjustments WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_existing.variant_id <> p_variant_id OR v_existing.quantity <> p_quantity
     OR v_existing.reason <> p_reason OR v_existing.note IS DISTINCT FROM v_note OR v_existing.actor_id <> v_actor
  THEN RAISE EXCEPTION 'Request ID already used for another adjustment'; END IF;
  RETURN v_existing.id;
 END IF;
 v_remaining := p_quantity;
 -- Lock all candidate lots before creating the event. If insufficient, transaction rolls back.
 PERFORM 1 FROM public.inventory_lots WHERE variant_id=p_variant_id AND status='available'
   AND (use_by IS NULL OR use_by >= current_date) AND qty_on_hand > qty_reserved
   ORDER BY use_by ASC NULLS LAST,received_at,id FOR UPDATE;
 IF (SELECT coalesce(sum(qty_on_hand-qty_reserved),0) FROM public.inventory_lots
   WHERE variant_id=p_variant_id AND status='available'
   AND (use_by IS NULL OR use_by >= current_date) AND qty_on_hand > qty_reserved) < p_quantity
 THEN RAISE EXCEPTION 'Insufficient unreserved inventory'; END IF;
 INSERT INTO public.admin_inventory_adjustments(request_id,variant_id,quantity,reason,note,actor_id)
 VALUES(p_request_id,p_variant_id,p_quantity,p_reason,v_note,v_actor) RETURNING id INTO v_adjustment_id;
 FOR v_lot IN SELECT id,qty_on_hand,qty_reserved FROM public.inventory_lots
   WHERE variant_id=p_variant_id AND status='available' AND (use_by IS NULL OR use_by >= current_date)
   AND qty_on_hand > qty_reserved ORDER BY use_by ASC NULLS LAST,received_at,id
 LOOP
  v_take := least(v_remaining,v_lot.qty_on_hand-v_lot.qty_reserved);
  IF v_take <= 0 THEN CONTINUE; END IF;
  UPDATE public.inventory_lots SET qty_on_hand=qty_on_hand-v_take,
    status=CASE WHEN qty_on_hand-v_take=0 THEN 'depleted' ELSE status END WHERE id=v_lot.id;
  INSERT INTO public.inventory_movements(lot_id,qty_change,reason,actor_id)
  VALUES(v_lot.id,-v_take,CASE WHEN p_reason='waste' THEN 'waste' ELSE 'adjustment' END,v_actor);
  INSERT INTO public.admin_inventory_adjustment_lines(adjustment_id,lot_id,quantity)
  VALUES(v_adjustment_id,v_lot.id,v_take);
  v_remaining := v_remaining-v_take;
  EXIT WHEN v_remaining=0;
 END LOOP;
 IF v_remaining<>0 THEN RAISE EXCEPTION 'Inventory changed during adjustment'; END IF;
 RETURN v_adjustment_id;
END;
$$;


ALTER FUNCTION "public"."admin_reduce_inventory"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_reason" "text", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_register_purchase"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_unit_cost_cents" integer, "p_use_by" "date" DEFAULT NULL::"date") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid:=auth.uid(); v_prior public.admin_purchase_events%ROWTYPE; v_lot uuid; v_unit text;
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_variant_id IS NULL OR p_quantity IS NULL OR p_quantity<=0 OR p_quantity>100000 OR scale(p_quantity)>4 OR p_unit_cost_cents IS NULL OR p_unit_cost_cents<0 THEN RAISE EXCEPTION 'Invalid purchase'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 91));
 SELECT * INTO v_prior FROM public.admin_purchase_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.actor_id<>v_actor OR v_prior.variant_id<>p_variant_id OR v_prior.quantity<>p_quantity OR v_prior.unit_cost_cents<>p_unit_cost_cents OR v_prior.use_by IS DISTINCT FROM p_use_by THEN RAISE EXCEPTION 'Request ID already used'; END IF;
  RETURN v_prior.lot_id;
 END IF;
 SELECT base_unit INTO v_unit FROM public.product_variants WHERE id=p_variant_id AND active=true FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Product unavailable'; END IF;
 IF v_unit IN ('unit','package') AND p_quantity<>trunc(p_quantity) THEN RAISE EXCEPTION 'Whole units required'; END IF;
 INSERT INTO public.inventory_lots(variant_id,qty_received,qty_on_hand,qty_reserved,cost_cents_per_base_unit,status,use_by)
 VALUES(p_variant_id,p_quantity,p_quantity,0,p_unit_cost_cents,'available',p_use_by) RETURNING id INTO v_lot;
 INSERT INTO public.admin_purchase_events(request_id,lot_id,variant_id,quantity,unit_cost_cents,use_by,actor_id)
 VALUES(p_request_id,v_lot,p_variant_id,p_quantity,p_unit_cost_cents,p_use_by,v_actor);
 RETURN v_lot;
END; $$;


ALTER FUNCTION "public"."admin_register_purchase"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_unit_cost_cents" integer, "p_use_by" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_stock_minimum"("p_request_id" "uuid", "p_variant_id" "uuid", "p_minimum" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_old numeric; v_prior public.admin_stock_minimum_events%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_variant_id IS NULL OR p_minimum IS NULL OR p_minimum < 0 OR p_minimum > 100000 OR scale(p_minimum)>4 THEN RAISE EXCEPTION 'Invalid minimum'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 97));
 SELECT * INTO v_prior FROM public.admin_stock_minimum_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.variant_id<>p_variant_id OR v_prior.new_minimum<>p_minimum OR v_prior.actor_id<>auth.uid() THEN RAISE EXCEPTION 'Request ID already used'; END IF;
  RETURN;
 END IF;
 SELECT minimum_stock INTO v_old FROM public.product_variants WHERE id=p_variant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
 UPDATE public.product_variants SET minimum_stock=p_minimum WHERE id=p_variant_id;
 INSERT INTO public.admin_stock_minimum_events(request_id,variant_id,old_minimum,new_minimum,actor_id)
 VALUES(p_request_id,p_variant_id,v_old,p_minimum,auth.uid());
END;$$;


ALTER FUNCTION "public"."admin_set_stock_minimum"("p_request_id" "uuid", "p_variant_id" "uuid", "p_minimum" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_price"("p_request_id" "uuid", "p_variant_id" "uuid", "p_new_price_cents" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid:=auth.uid(); v_prior public.admin_price_events%ROWTYPE; v_old integer; v_event uuid;
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_variant_id IS NULL OR p_new_price_cents IS NULL OR p_new_price_cents<0 THEN RAISE EXCEPTION 'Invalid price'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,92));
 SELECT * INTO v_prior FROM public.admin_price_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.actor_id<>v_actor OR v_prior.variant_id<>p_variant_id OR v_prior.new_price_cents<>p_new_price_cents THEN RAISE EXCEPTION 'Request ID already used'; END IF;
  RETURN v_prior.id;
 END IF;
 SELECT price_cents INTO v_old FROM public.product_variants WHERE id=p_variant_id AND active=true FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Product unavailable'; END IF;
 IF v_old=p_new_price_cents THEN RAISE EXCEPTION 'Price unchanged'; END IF;
 UPDATE public.product_variants SET price_cents=p_new_price_cents WHERE id=p_variant_id;
 INSERT INTO public.admin_price_events(request_id,variant_id,old_price_cents,new_price_cents,actor_id)
 VALUES(p_request_id,p_variant_id,v_old,p_new_price_cents,v_actor) RETURNING id INTO v_event;
 RETURN v_event;
END; $$;


ALTER FUNCTION "public"."admin_update_price"("p_request_id" "uuid", "p_variant_id" "uuid", "p_new_price_cents" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_pilot_order"("p_order_id" "uuid", "p_expected_status" "text", "p_new_status" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."advance_pilot_order"("p_order_id" "uuid", "p_expected_status" "text", "p_new_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_order_and_cleanup"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."cancel_order_and_cleanup"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_pilot_order"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."cancel_pilot_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cash_day_reconciliation"("p_cash_day_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; v_start timestamptz; v_end timestamptz; recipient uuid;
 counter_cash bigint; direct_cash bigint; handoffs bigint; issued bigint;
 withdrawals bigint; expenses bigint; personal bigint; business bigint; driver_difference bigint;
 expected bigint; pending bigint; unconfirmed_float bigint; blockers text[]:=ARRAY[]::text[];
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Jornada no encontrada'; END IF;
 IF d.status='closed' THEN
  IF d.closing_breakdown IS NULL THEN RAISE EXCEPTION 'Este cierre histórico no tiene desglose integrado'; END IF;
  RETURN d.closing_breakdown;
 END IF;
 v_start:=d.business_date::timestamp AT TIME ZONE 'America/Guatemala';
 v_end:=(d.business_date+1)::timestamp AT TIME ZONE 'America/Guatemala';
 SELECT recipient_user_id INTO recipient FROM public.delivery_cash_config WHERE singleton=true FOR SHARE;
 IF recipient IS NULL THEN RAISE EXCEPTION 'Responsable de Caja no configurado'; END IF;
 SELECT coalesce(sum(p.amount_cents),0)::bigint INTO counter_cash FROM public.sale_payments p
 JOIN public.sales s ON s.id=p.sale_id WHERE p.method='cash' AND p.status='received'
 AND s.status='completed' AND p.created_at>=v_start AND p.created_at<v_end;
 SELECT coalesce(sum(p.amount_cents),0)::bigint INTO direct_cash FROM public.delivery_payment_events p
 WHERE p.method='cash' AND p.event_kind='payment' AND p.cash_received_by=recipient
 AND p.created_at>=v_start AND p.created_at<v_end;
 SELECT coalesce(sum(h.amount_cents),0)::bigint INTO handoffs FROM public.delivery_cash_handoffs h
 WHERE h.cash_day_id=d.id AND h.to_user_id=recipient;
 SELECT coalesce(sum(s.float_cents),0)::bigint,coalesce(sum(s.difference_cents),0)::bigint
 INTO issued,driver_difference FROM public.driver_day_settlements s WHERE s.cash_day_id=d.id;
 SELECT coalesce(sum(s.float_cents),0)::bigint INTO unconfirmed_float FROM public.driver_day_settlements s
 WHERE s.cash_day_id=d.id AND s.float_cents>0 AND s.float_origin_confirmed_by IS NULL;
 SELECT coalesce(sum(w.amount_cents),0)::bigint INTO withdrawals FROM public.cash_withdrawals w
 WHERE w.cash_day_id=d.id AND w.source_errand_id IS NULL;
 SELECT coalesce(sum(e.amount_cents),0)::bigint INTO expenses FROM public.operating_expenses e
 WHERE e.expense_date=d.business_date AND e.payment_source='business_cash' AND e.source_errand_id IS NULL;
 SELECT coalesce(sum(e.amount_cents) FILTER(WHERE e.category='personal'),0)::bigint,
        coalesce(sum(e.amount_cents) FILTER(WHERE e.category='business'),0)::bigint
 INTO personal,business FROM public.driver_cash_errands e WHERE e.cash_day_id=d.id AND e.status='approved';
 -- Incluye personas inactivas: un cambio de perfil no puede ocultar efectivo pendiente.
 SELECT count(*) INTO pending FROM (
  SELECT f.driver_id uid FROM public.driver_cash_floats f WHERE f.cash_day_id=d.id
  UNION SELECT e.driver_id FROM public.driver_cash_errands e WHERE e.cash_day_id=d.id AND e.status<>'rejected'
  UNION SELECT p.cash_received_by FROM public.delivery_payment_events p
   JOIN public.staff_profiles sp ON sp.user_id=p.cash_received_by AND sp.role='driver'
   WHERE p.event_kind='payment' AND p.method='cash' AND p.created_at>=v_start AND p.created_at<v_end
 ) holders WHERE NOT EXISTS(SELECT 1 FROM public.driver_day_settlements s WHERE s.cash_day_id=d.id AND s.driver_id=holders.uid);
 IF pending>0 THEN blockers:=array_append(blockers,'Hay repartidores pendientes de liquidación.'); END IF;
 IF EXISTS(SELECT 1 FROM public.cash_float_transfers WHERE cash_day_id=d.id)
 OR EXISTS(SELECT 1 FROM public.driver_float_confirmations WHERE cash_day_id=d.id) THEN
  blockers:=array_append(blockers,'Hay movimientos de sencillo del flujo anterior. Requieren conciliación separada.'); END IF;
 IF EXISTS(SELECT 1 FROM public.driver_cash_errands WHERE cash_day_id=d.id AND status='reported') THEN
  blockers:=array_append(blockers,'Hay compras pendientes de revisión en la liquidación.'); END IF;
 IF EXISTS(SELECT 1 FROM public.driver_day_settlements s
  LEFT JOIN public.delivery_cash_handoffs h ON h.id=s.handoff_id
  WHERE s.cash_day_id=d.id AND (
    s.float_cents<>coalesce((SELECT f.amount_cents FROM public.driver_cash_floats f WHERE f.cash_day_id=d.id AND f.driver_id=s.driver_id),0)
    OR s.collected_cents<>(SELECT coalesce(sum(p.amount_cents),0)::bigint FROM public.delivery_payment_events p
      WHERE p.method='cash' AND p.event_kind='payment' AND p.cash_received_by=s.driver_id AND p.created_at>=v_start AND p.created_at<v_end)
    OR s.purchases_cents<>(SELECT coalesce(sum(e.amount_cents),0)::bigint FROM public.driver_cash_errands e
      WHERE e.cash_day_id=d.id AND e.driver_id=s.driver_id AND e.status='approved')
    OR s.expected_cents<>s.float_cents+s.collected_cents-s.purchases_cents
    OR s.difference_cents<>s.counted_cents-s.expected_cents
    OR (s.counted_cents=0 AND s.handoff_id IS NOT NULL)
    OR (s.counted_cents>0 AND (h.id IS NULL OR h.cash_day_id IS DISTINCT FROM d.id
       OR h.amount_cents<>s.counted_cents OR h.to_user_id<>recipient OR h.from_user_id<>s.driver_id))
  )) THEN blockers:=array_append(blockers,'Una liquidación no coincide con sus cobros, compras o entrega vinculada.'); END IF;
 -- Los cobros de otros responsables requieren una entrega manual completa.
 IF EXISTS(SELECT 1 FROM public.delivery_payment_events p
   WHERE p.event_kind='payment' AND p.method='cash' AND p.cash_received_by<>recipient
   AND p.created_at>=v_start AND p.created_at<v_end
   AND NOT EXISTS(SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id=p.cash_received_by AND sp.role='driver')
   GROUP BY p.cash_received_by HAVING sum(p.amount_cents)<>
    (SELECT coalesce(sum(h.amount_cents),0) FROM public.delivery_cash_handoffs h
      WHERE h.cash_day_id=d.id AND h.from_user_id=p.cash_received_by AND h.to_user_id=recipient)) THEN
  blockers:=array_append(blockers,'Hay efectivo cobrado por otro responsable sin entrega completa a Caja.'); END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_cash_handoffs h
  JOIN public.staff_profiles sp ON sp.user_id=h.from_user_id AND sp.role='driver'
  WHERE h.cash_day_id=d.id AND NOT EXISTS(SELECT 1 FROM public.driver_day_settlements s WHERE s.handoff_id=h.id)) THEN
  blockers:=array_append(blockers,'Hay entregas manuales de repartidores fuera de la liquidación única.'); END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_cash_handoffs h WHERE h.cash_day_id=d.id AND h.to_user_id<>recipient) THEN
  blockers:=array_append(blockers,'Hay entregas dirigidas a otro responsable de Caja.'); END IF;
 expected:=d.opening_float_cents+counter_cash+direct_cash+handoffs-issued-withdrawals-expenses;
 IF expected<0 THEN blockers:=array_append(blockers,'El efectivo esperado es negativo. Revisá los movimientos.'); END IF;
 RETURN jsonb_build_object('cash_day_id',d.id,'business_date',d.business_date,
  'opening_cents',d.opening_float_cents,'counter_sales_cents',counter_cash,
  'direct_delivery_cents',direct_cash,'received_handoffs_cents',handoffs,'float_out_cents',issued,
  'withdrawals_cents',withdrawals,'cash_expenses_cents',expenses,
  'personal_purchases_cents',personal,'business_purchases_cents',business,
  'driver_difference_cents',driver_difference,'expected_cents',expected,
  'unsettled_drivers',pending,'unconfirmed_float_cents',unconfirmed_float,'requires_float_confirmation',unconfirmed_float>0,'blockers',to_jsonb(blockers),'can_close',cardinality(blockers)=0);
END;$$;


ALTER FUNCTION "public"."cash_day_reconciliation"("p_cash_day_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."push_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_key" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "reference_id" "uuid" NOT NULL,
    "recipient_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "claim_token" "uuid",
    "claimed_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    CONSTRAINT "push_events_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "push_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['delivery_assigned'::"text", 'customer_order_created'::"text"]))),
    CONSTRAINT "push_events_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'sent'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."push_events" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_push_events"("p_limit" integer DEFAULT 10) RETURNS SETOF "public"."push_events"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
        RAISE EXCEPTION 'Invalid batch size';
    END IF;

    RETURN QUERY
    WITH selected AS (
        SELECT e.id
        FROM public.push_events e
        WHERE (
            (
                e.status IN ('pending', 'failed')
                AND (
                    e.next_attempt_at IS NULL
                    OR e.next_attempt_at <= now()
                )
                AND e.attempts < 5
            )
            OR (
                e.status = 'processing'
                AND e.claimed_at < now() - interval '5 minutes'
                AND e.attempts < 5
            )
        )
        ORDER BY e.created_at, e.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    )
    UPDATE public.push_events e
    SET
        status = 'processing',
        attempts = e.attempts + 1,
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        next_attempt_at = NULL
    FROM selected s
    WHERE e.id = s.id
    RETURNING e.*;
END;
$$;


ALTER FUNCTION "public"."claim_push_events"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; prior public.cash_close_counts%ROWTYPE; b jsonb; expected bigint;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_cash_day_id IS NULL OR p_request_id IS NULL OR p_counted_cents IS NULL OR p_next_day_float_cents IS NULL
 OR p_counted_cents<0 OR p_next_day_float_cents<0 OR p_next_day_float_cents>p_counted_cents THEN RAISE EXCEPTION 'Invalid cash closing'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,301));
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash day not found'; END IF;
 SELECT * INTO prior FROM public.cash_close_counts WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.cash_day_id=p_cash_day_id AND prior.counted_cents=p_counted_cents AND prior.counted_by=auth.uid()
   AND d.status='closed' AND d.next_day_float_cents=p_next_day_float_cents THEN RETURN d.id; END IF;
  RAISE EXCEPTION 'Request ID already used'; END IF;
 IF d.status<>'open' THEN RAISE EXCEPTION 'Cash day already closed'; END IF;
 PERFORM public.sync_driver_day_purchases(d.id);
 b:=public.cash_day_reconciliation(d.id);
 IF NOT (b->>'can_close')::boolean THEN RAISE EXCEPTION '%',b->'blockers'; END IF;
 IF (b->>'requires_float_confirmation')::boolean THEN
  RAISE EXCEPTION 'El sencillo de liquidaciones anteriores requiere confirmar que salió de Caja.';
 END IF;
 expected:=(b->>'expected_cents')::bigint;
 b:=b||jsonb_build_object('counted_cents',p_counted_cents,'drawer_difference_cents',p_counted_cents-expected,
  'owner_withdrawal_cents',p_counted_cents-p_next_day_float_cents,'next_day_float_cents',p_next_day_float_cents,
  'total_difference_cents',p_counted_cents-expected+(b->>'driver_difference_cents')::bigint);
 INSERT INTO public.cash_close_counts(request_id,cash_day_id,counted_by,counted_cents)
 VALUES(p_request_id,d.id,auth.uid(),p_counted_cents);
 UPDATE public.cash_days SET status='closed',closed_by=auth.uid(),closed_at=now(),
  closing_expected_cents=expected,closing_counted_cents=p_counted_cents,
  next_day_float_cents=p_next_day_float_cents,closing_breakdown=b WHERE id=d.id;
 -- El retiro final es counted-next_float y queda en closing_breakdown.
 -- NO se inserta otro cash_withdrawal que vuelva a reducir el esperado.
 RETURN d.id;
END;$$;


ALTER FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint, "p_reviewed_balance" "jsonb", "p_confirm_float_origin" boolean) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; b jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Invalid cash closing'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,301));
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash day not found'; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_close_counts WHERE request_id=p_request_id) THEN
  RETURN public.close_cash_day(p_cash_day_id,p_request_id,p_counted_cents,p_next_day_float_cents);
 END IF;
 b:=public.cash_day_reconciliation(d.id);
 IF p_reviewed_balance IS NULL OR b IS DISTINCT FROM p_reviewed_balance THEN
  RAISE EXCEPTION 'El saldo cambió. Actualizá Caja y revisá el conteo antes de cerrar.';
 END IF;
 IF (b->>'requires_float_confirmation')::boolean THEN
  IF p_confirm_float_origin IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Confirmá que el sencillo declarado de esas liquidaciones fue entregado desde Caja. Si era dinero externo, no confirmés este cierre.';
  END IF;
  UPDATE public.driver_day_settlements SET float_origin_confirmed_by=auth.uid(),float_origin_confirmed_at=now()
   WHERE cash_day_id=d.id AND float_cents>0 AND float_origin_confirmed_by IS NULL;
 END IF;
 RETURN public.close_cash_day(p_cash_day_id,p_request_id,p_counted_cents,p_next_day_float_cents);
END;$$;


ALTER FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint, "p_reviewed_balance" "jsonb", "p_confirm_float_origin" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_push_event"("p_event_id" "uuid", "p_claim_token" "uuid", "p_success" boolean, "p_error" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_attempts integer;
BEGIN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_event_id IS NULL
       OR p_claim_token IS NULL
       OR p_success IS NULL THEN
        RAISE EXCEPTION 'Invalid completion request';
    END IF;

    SELECT attempts
    INTO v_attempts
    FROM public.push_events
    WHERE id = p_event_id
      AND claim_token = p_claim_token
      AND status = 'processing'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE public.push_events
    SET
        status = CASE
            WHEN p_success THEN 'sent'
            ELSE 'failed'
        END,
        processed_at = CASE
            WHEN p_success THEN now()
            ELSE NULL
        END,
        last_error = CASE
            WHEN p_success THEN NULL
            ELSE left(
                COALESCE(p_error, 'Push delivery failed'),
                250
            )
        END,
        next_attempt_at = CASE
            WHEN p_success OR v_attempts >= 5 THEN NULL
            ELSE now() + (
                LEAST(300, 15 * power(2, v_attempts - 1))
                * interval '1 second'
            )
        END,
        claim_token = NULL,
        claimed_at = NULL
    WHERE id = p_event_id;

    RETURN true;
END;
$$;


ALTER FUNCTION "public"."complete_push_event"("p_event_id" "uuid", "p_claim_token" "uuid", "p_success" boolean, "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_delivery"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_route_id uuid;v_driver_id uuid;v_status text;
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT a.route_id,r.driver_id INTO v_route_id,v_driver_id FROM public.delivery_assignments a JOIN public.delivery_routes r ON r.id=a.route_id WHERE a.order_id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order is not assigned'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Not your delivery'; END IF;
 PERFORM 1 FROM public.delivery_routes WHERE id=v_route_id AND dispatched_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not dispatched'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 IF v_status='delivered' THEN RETURN; END IF;
 IF v_status<>'out_for_delivery' THEN RAISE EXCEPTION 'Order not out for delivery'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND ((event_kind='payment' AND method IN ('cash','transfer_reported')) OR (event_kind='pending' AND method='pending'))) THEN RAISE EXCEPTION 'Delivery requires a payment or pending record'; END IF;
 UPDATE public.customer_orders SET status='delivered',updated_at=now() WHERE id=p_order_id;
 IF NOT EXISTS(SELECT 1 FROM public.delivery_assignments a JOIN public.customer_orders o ON o.id=a.order_id WHERE a.route_id=v_route_id AND o.status NOT IN ('delivered','cancelled')) THEN
  UPDATE public.delivery_routes SET status='closed',completed_at=COALESCE(completed_at,now()) WHERE id=v_route_id;
 END IF;
END;$$;


ALTER FUNCTION "public"."confirm_delivery"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_delivery_return"("p_order_id" "uuid", "p_request_id" "uuid", "p_lines" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_route uuid; v_status text; v_receipt uuid; v_previous public.delivery_return_receipts%ROWTYPE; v_item record; v_mov record; v_lot record; v_good numeric; v_bad numeric; v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_order_id IS NULL OR p_request_id IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid return'; END IF;
 SELECT route_id INTO v_route FROM public.delivery_assignments WHERE order_id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not assigned'; END IF;
 PERFORM 1 FROM public.delivery_routes WHERE id=v_route AND dispatched_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not dispatched'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 SELECT * INTO v_previous FROM public.delivery_return_receipts WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_previous.order_id=p_order_id AND v_previous.payload=p_lines THEN RETURN; END IF;
  RAISE EXCEPTION 'Request ID already used';
 END IF;
 IF v_status<>'return_pending' THEN RAISE EXCEPTION 'Order is not pending return'; END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND event_kind='payment') THEN RAISE EXCEPTION 'Paid order requires reconciliation'; END IF;
 SELECT count(*) INTO v_count FROM public.delivery_inventory_movements WHERE order_id=p_order_id;
 IF v_count=0 OR jsonb_array_length(p_lines)<>v_count THEN RAISE EXCEPTION 'Return must include every dispatched movement'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) x WHERE jsonb_typeof(x->'movement_id')<>'string' OR jsonb_typeof(x->'good')<>'number' OR jsonb_typeof(x->'damaged')<>'number') THEN RAISE EXCEPTION 'Invalid return quantities'; END IF;
 IF (SELECT count(DISTINCT x->>'movement_id') FROM jsonb_array_elements(p_lines) x)<>v_count THEN RAISE EXCEPTION 'Duplicate or missing movement'; END IF;
 -- Lock all original lots deterministically, avoiding double restoration and racing inventory edits.
 FOR v_lot IN SELECT DISTINCT l.id FROM public.delivery_inventory_movements m JOIN public.inventory_lots l ON l.id=m.lot_id WHERE m.order_id=p_order_id ORDER BY l.id LOOP
  PERFORM 1 FROM public.inventory_lots WHERE id=v_lot.id FOR UPDATE;
 END LOOP;
 INSERT INTO public.delivery_return_receipts(request_id,order_id,payload,actor_id) VALUES(p_request_id,p_order_id,p_lines,auth.uid()) RETURNING id INTO v_receipt;
 FOR v_item IN SELECT * FROM jsonb_to_recordset(p_lines) AS x(movement_id uuid,good numeric,damaged numeric) ORDER BY movement_id LOOP
  SELECT * INTO v_mov FROM public.delivery_inventory_movements WHERE id=v_item.movement_id AND order_id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movement not in order'; END IF;
  v_good:=v_item.good;v_bad:=v_item.damaged;
  IF v_good IS NULL OR v_bad IS NULL OR v_good<0 OR v_bad<0 OR v_good+v_bad<>v_mov.quantity OR scale(v_good)>4 OR scale(v_bad)>4 THEN RAISE EXCEPTION 'Return quantities do not match dispatch'; END IF;
  SELECT * INTO v_lot FROM public.inventory_lots WHERE id=v_mov.lot_id;
  IF v_good>0 AND (v_lot.use_by<current_date OR v_lot.status IN ('blocked','quarantine')) THEN RAISE EXCEPTION 'Lot cannot be returned to available inventory'; END IF;
  IF v_good>0 THEN
   UPDATE public.inventory_lots SET qty_on_hand=qty_on_hand+v_good,status=CASE WHEN status='depleted' THEN 'available' ELSE status END WHERE id=v_mov.lot_id AND qty_on_hand+v_good<=qty_received;
   IF NOT FOUND THEN RAISE EXCEPTION 'Return exceeds original lot capacity'; END IF;
  END IF;
  INSERT INTO public.delivery_return_lines(receipt_id,movement_id,lot_id,qty_good,qty_damaged,cost_cents_per_base_unit)
  VALUES(v_receipt,v_mov.id,v_mov.lot_id,v_good,v_bad,v_lot.cost_cents_per_base_unit);
 END LOOP;
 UPDATE public.customer_orders SET status='cancelled',updated_at=now() WHERE id=p_order_id;
 IF NOT EXISTS(SELECT 1 FROM public.delivery_assignments a JOIN public.customer_orders o ON o.id=a.order_id WHERE a.route_id=v_route AND o.status NOT IN ('delivered','cancelled')) THEN
  UPDATE public.delivery_routes SET status='closed',completed_at=COALESCE(completed_at,now()) WHERE id=v_route;
 END IF;
END;$$;


ALTER FUNCTION "public"."confirm_delivery_return"("p_order_id" "uuid", "p_request_id" "uuid", "p_lines" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_delivery_with_payment"("p_order_id" "uuid", "p_request_id" "uuid", "p_method" "text", "p_cash_tendered_cents" bigint DEFAULT 0, "p_cash_received_by" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_route uuid;
  v_driver uuid;
  v_status text;
  v_total bigint;
  v_kind text;
  v_amount bigint;
  v_change bigint;
  v_previous public.delivery_payment_events%ROWTYPE;
  v_cash_receiver uuid;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_order_id IS NULL OR p_request_id IS NULL OR p_method IS NULL
     OR p_method NOT IN ('cash','transfer_reported','pending')
     OR p_cash_tendered_cents IS NULL OR p_cash_tendered_cents < 0 THEN
    RAISE EXCEPTION 'Invalid payment details';
  END IF;
  SELECT a.route_id,dr.driver_id INTO v_route,v_driver
    FROM public.delivery_assignments a JOIN public.delivery_routes dr ON dr.id=a.route_id
    WHERE a.order_id=p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order is not assigned'; END IF;
  IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver<>auth.uid() THEN
    RAISE EXCEPTION 'Not your delivery';
  END IF;
  -- Stable lock order: route, then order, consistent with existing confirm_delivery.
  PERFORM 1 FROM public.delivery_routes WHERE id=v_route AND dispatched_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Route not dispatched'; END IF;
  SELECT status,total_cents INTO v_status,v_total FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_status NOT IN ('out_for_delivery','delivered') THEN RAISE EXCEPTION 'Order not eligible for collection'; END IF;
  IF v_total <= 0 THEN RAISE EXCEPTION 'Invalid order total'; END IF;

  v_kind:=CASE WHEN p_method='pending' THEN 'pending' ELSE 'payment' END;
  v_amount:=CASE WHEN p_method='pending' THEN 0 ELSE v_total END;
  IF p_method='cash' THEN
    v_cash_receiver:=COALESCE(p_cash_received_by,auth.uid());
    IF v_cash_receiver<>auth.uid() AND NOT public.staff_has_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admin can record cash received by another person';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id=v_cash_receiver AND active) THEN
      RAISE EXCEPTION 'Cash receiver must be active staff';
    END IF;
    IF p_cash_tendered_cents < v_total THEN RAISE EXCEPTION 'Insufficient cash'; END IF;
    v_change:=p_cash_tendered_cents-v_total;
  ELSE
    IF p_cash_received_by IS NOT NULL THEN RAISE EXCEPTION 'Cash receiver is only valid for cash'; END IF;
    v_cash_receiver:=NULL;
    IF p_cash_tendered_cents<>0 THEN RAISE EXCEPTION 'Cash must be zero for this method'; END IF;
    v_change:=0;
  END IF;

  -- Request IDs are idempotent only for identical parameters, never for a different order.
  SELECT * INTO v_previous FROM public.delivery_payment_events WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_previous.order_id=p_order_id AND v_previous.event_kind=v_kind
       AND v_previous.method=p_method AND v_previous.amount_cents=v_amount
       AND v_previous.cash_tendered_cents=p_cash_tendered_cents
       AND v_previous.cash_received_by IS NOT DISTINCT FROM v_cash_receiver THEN RETURN; END IF;
    RAISE EXCEPTION 'Request ID already used';
  END IF;

  IF v_status='delivered' THEN
    IF p_method='pending' THEN RAISE EXCEPTION 'Already delivered; select a payment method'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND event_kind='pending') THEN
      RAISE EXCEPTION 'Late payment requires a pending record';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND event_kind='payment') THEN
    RAISE EXCEPTION 'Payment already recorded';
  END IF;
  IF v_kind='pending' AND EXISTS (
    SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND event_kind='pending'
  ) THEN RAISE EXCEPTION 'Pending record already exists'; END IF;

  INSERT INTO public.delivery_payment_events
    (order_id,request_id,event_kind,method,amount_cents,cash_tendered_cents,change_cents,recorded_by,cash_received_by)
  VALUES (p_order_id,p_request_id,v_kind,p_method,v_amount,p_cash_tendered_cents,v_change,auth.uid(),v_cash_receiver);
  IF v_status='out_for_delivery' THEN PERFORM public.confirm_delivery(p_order_id); END IF;
END;$$;


ALTER FUNCTION "public"."confirm_delivery_with_payment"("p_order_id" "uuid", "p_request_id" "uuid", "p_method" "text", "p_cash_tendered_cents" bigint, "p_cash_received_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_driver_float"("p_request_id" "uuid", "p_driver_id" "uuid", "p_amount_cents" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_day public.cash_days%ROWTYPE; v_declaration public.driver_cash_floats%ROWTYPE; v_prior public.driver_float_confirmations%ROWTYPE; v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_driver_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents<0 THEN RAISE EXCEPTION 'Invalid float'; END IF;
 SELECT * INTO v_day FROM public.cash_days WHERE status='open' ORDER BY business_date DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR v_day.business_date <> (now() AT TIME ZONE 'America/Guatemala')::date THEN RAISE EXCEPTION 'No current open cash day'; END IF;
 SELECT * INTO v_prior FROM public.driver_float_confirmations WHERE request_id=p_request_id;
 IF FOUND THEN
   IF v_prior.cash_day_id=v_day.id AND v_prior.driver_id=p_driver_id AND v_prior.amount_cents=p_amount_cents AND v_prior.confirmed_by=auth.uid() THEN RETURN v_prior.id; END IF;
   RAISE EXCEPTION 'Request ID already used';
 END IF;
 SELECT * INTO v_declaration FROM public.driver_cash_floats WHERE cash_day_id=v_day.id AND driver_id=p_driver_id;
 IF NOT FOUND OR v_declaration.amount_cents<>p_amount_cents THEN RAISE EXCEPTION 'Driver declaration does not match'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id=p_driver_id AND active AND role='driver') THEN RAISE EXCEPTION 'Driver not active'; END IF;
 -- Do not issue more cash than the cashier's available cash. This is a QA safeguard.
 IF EXISTS(SELECT 1 FROM public.driver_float_confirmations WHERE cash_day_id=v_day.id AND driver_id=p_driver_id) THEN RAISE EXCEPTION 'Float already confirmed'; END IF;
 INSERT INTO public.driver_float_confirmations(request_id,cash_day_id,driver_id,amount_cents,confirmed_by)
 VALUES(p_request_id,v_day.id,p_driver_id,p_amount_cents,auth.uid()) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."confirm_driver_float"("p_request_id" "uuid", "p_driver_id" "uuid", "p_amount_cents" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."declare_driver_cash_float"("p_request_id" "uuid", "p_amount_cents" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_driver_id uuid;
    v_cash_day_id uuid;
    v_existing public.driver_cash_floats%ROWTYPE;
    v_id uuid;
BEGIN
    v_driver_id := auth.uid();

    -- Solo repartidores autenticados y activos
    IF v_driver_id IS NULL
       OR NOT public.staff_has_role(ARRAY['driver']) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.staff_profiles
        WHERE user_id = v_driver_id
          AND role = 'driver'
          AND active = true
    ) THEN
        RAISE EXCEPTION 'Driver is not active';
    END IF;

    -- Validar la solicitud
    IF p_request_id IS NULL
       OR p_amount_cents IS NULL
       OR p_amount_cents < 0 THEN
        RAISE EXCEPTION 'Invalid cash float declaration';
    END IF;

    -- Serializar declaraciones de este repartidor
    PERFORM 1
    FROM public.staff_profiles
    WHERE user_id = v_driver_id
    FOR UPDATE;

    -- Permitir reintentos sin duplicar registros
    SELECT *
    INTO v_existing
    FROM public.driver_cash_floats
    WHERE request_id = p_request_id;

    IF FOUND THEN
        IF v_existing.driver_id = v_driver_id
           AND v_existing.amount_cents = p_amount_cents THEN
            RETURN v_existing.id;
        END IF;

        RAISE EXCEPTION 'Request ID already used';
    END IF;

    -- Debe existir una jornada abierta
    SELECT id
    INTO v_cash_day_id
    FROM public.cash_days
    WHERE status = 'open'
      AND business_date =
          (now() AT TIME ZONE 'America/Guatemala')::date;

    IF v_cash_day_id IS NULL THEN
        RAISE EXCEPTION 'No open cash day';
    END IF;

    -- Una declaración inicial por repartidor y jornada
    IF EXISTS (
        SELECT 1
        FROM public.driver_cash_floats
        WHERE cash_day_id = v_cash_day_id
          AND driver_id = v_driver_id
    ) THEN
        RAISE EXCEPTION 'Cash float already declared for this day';
    END IF;

    INSERT INTO public.driver_cash_floats (
        request_id,
        cash_day_id,
        driver_id,
        amount_cents
    )
    VALUES (
        p_request_id,
        v_cash_day_id,
        v_driver_id,
        p_amount_cents
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."declare_driver_cash_float"("p_request_id" "uuid", "p_amount_cents" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delivery_cash_overview"() RETURNS TABLE("cash_cents" bigint, "transfer_reported_cents" bigint, "pending_cents" bigint, "open_issues" bigint, "handed_off_cents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY
 WITH payments AS (
  SELECT coalesce(sum(amount_cents) FILTER (WHERE method='cash' AND event_kind='payment'),0)::bigint AS cash_total,
  coalesce(sum(amount_cents) FILTER (WHERE method='transfer_reported' AND event_kind='payment'),0)::bigint AS transfer_total
  FROM public.delivery_payment_events
 ), pending AS (
  SELECT coalesce(sum(o.total_cents),0)::bigint AS pending_total FROM public.customer_orders o
  WHERE EXISTS(SELECT 1 FROM public.delivery_payment_events p WHERE p.order_id=o.id AND p.event_kind='pending')
  AND NOT EXISTS(SELECT 1 FROM public.delivery_payment_events p WHERE p.order_id=o.id AND p.event_kind='payment')
 ), issues AS (
  SELECT count(*)::bigint AS issue_total FROM (
   SELECT DISTINCT ON (payment_id) payment_id,action
   FROM public.delivery_transfer_issue_events ORDER BY payment_id,event_seq DESC
  ) latest WHERE action='reported'
 ), handed AS (
  SELECT coalesce(sum(amount_cents),0)::bigint AS handed_total FROM public.delivery_cash_handoffs
 )
 SELECT payments.cash_total,payments.transfer_total,pending.pending_total,issues.issue_total,handed.handed_total
 FROM payments,pending,issues,handed;
END; $$;


ALTER FUNCTION "public"."delivery_cash_overview"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delivery_cash_positions"() RETURNS TABLE("user_id" "uuid", "display_name" "text", "collected_cents" bigint, "handed_off_cents" bigint, "remaining_cents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY WITH collected AS (
  SELECT cash_received_by uid,coalesce(sum(amount_cents),0)::bigint amount FROM public.delivery_payment_events
  WHERE event_kind='payment' AND method='cash' AND cash_received_by IS NOT NULL GROUP BY cash_received_by
 ), incoming AS (
  SELECT to_user_id uid,sum(amount_cents)::bigint amount FROM public.delivery_cash_handoffs GROUP BY to_user_id
 ), outgoing AS (
  SELECT from_user_id uid,sum(amount_cents)::bigint amount FROM public.delivery_cash_handoffs GROUP BY from_user_id
 ), floats AS (
  SELECT driver_id uid,sum(amount_cents)::bigint amount FROM public.driver_float_confirmations GROUP BY driver_id
 ), purchases AS (
  SELECT driver_id uid,sum(amount_cents)::bigint amount FROM public.driver_cash_errands WHERE status='approved' GROUP BY driver_id
 )
 SELECT sp.user_id,sp.display_name::text,coalesce(c.amount,0)::bigint,coalesce(o.amount,0)::bigint,
 (coalesce(c.amount,0)+coalesce(i.amount,0)+coalesce(f.amount,0)-coalesce(e.amount,0)-coalesce(o.amount,0))::bigint
 FROM public.staff_profiles sp
 LEFT JOIN collected c ON c.uid=sp.user_id LEFT JOIN incoming i ON i.uid=sp.user_id
 LEFT JOIN outgoing o ON o.uid=sp.user_id LEFT JOIN floats f ON f.uid=sp.user_id LEFT JOIN purchases e ON e.uid=sp.user_id
 WHERE c.uid IS NOT NULL OR i.uid IS NOT NULL OR o.uid IS NOT NULL OR f.uid IS NOT NULL OR e.uid IS NOT NULL
 ORDER BY sp.display_name;
END;$$;


ALTER FUNCTION "public"."delivery_cash_positions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_delivery_route"("p_route_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."dispatch_delivery_route"("p_route_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_day_settlement_preview"() RETURNS TABLE("cash_day_id" "uuid", "driver_id" "uuid", "driver_name" "text", "float_cents" bigint, "collected_cents" bigint, "purchases_cents" bigint, "expected_cents" bigint, "settled" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; v_start timestamptz; v_end timestamptz;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT * INTO d FROM public.cash_days WHERE status='open' ORDER BY business_date DESC LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 v_start:=d.business_date::timestamp AT TIME ZONE 'America/Guatemala'; v_end:=(d.business_date+1)::timestamp AT TIME ZONE 'America/Guatemala';
 RETURN QUERY WITH cash AS (
  SELECT p.cash_received_by uid,sum(p.amount_cents)::bigint amt FROM public.delivery_payment_events p
  WHERE p.method='cash' AND p.event_kind='payment' AND p.created_at>=v_start AND p.created_at<v_end GROUP BY 1
 ), purchases AS (
  SELECT e.driver_id uid,sum(e.amount_cents)::bigint amt FROM public.driver_cash_errands e
  WHERE e.cash_day_id=d.id AND e.status IN ('reported','approved') GROUP BY 1
 ) SELECT d.id,sp.user_id,sp.display_name::text,coalesce(f.amount_cents,0)::bigint,coalesce(c.amt,0)::bigint,coalesce(e.amt,0)::bigint,
 (coalesce(f.amount_cents,0)+coalesce(c.amt,0)-coalesce(e.amt,0))::bigint,(s.id IS NOT NULL)
 FROM public.staff_profiles sp LEFT JOIN public.driver_cash_floats f ON f.driver_id=sp.user_id AND f.cash_day_id=d.id
 LEFT JOIN cash c ON c.uid=sp.user_id LEFT JOIN purchases e ON e.uid=sp.user_id
 LEFT JOIN public.driver_day_settlements s ON s.cash_day_id=d.id AND s.driver_id=sp.user_id
 WHERE sp.role='driver' AND (f.id IS NOT NULL OR c.uid IS NOT NULL OR e.uid IS NOT NULL OR s.id IS NOT NULL) ORDER BY sp.display_name;
END;$$;


ALTER FUNCTION "public"."driver_day_settlement_preview"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_money_summary"() RETURNS TABLE("driver_id" "uuid", "confirmed_float_cents" bigint, "approved_personal_cents" bigint, "approved_business_cents" bigint, "reported_cents" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
 SELECT sp.user_id,
  coalesce((SELECT sum(f.amount_cents) FROM public.driver_float_confirmations f WHERE f.driver_id=sp.user_id),0)::bigint,
  coalesce((SELECT sum(e.amount_cents) FROM public.driver_cash_errands e WHERE e.driver_id=sp.user_id AND e.status='approved' AND e.category='personal'),0)::bigint,
  coalesce((SELECT sum(e.amount_cents) FROM public.driver_cash_errands e WHERE e.driver_id=sp.user_id AND e.status='approved' AND e.category='business'),0)::bigint,
  coalesce((SELECT sum(e.amount_cents) FROM public.driver_cash_errands e WHERE e.driver_id=sp.user_id AND e.status='reported'),0)::bigint
 FROM public.staff_profiles sp
 WHERE public.staff_has_role(ARRAY['admin']) AND sp.role='driver';
$$;


ALTER FUNCTION "public"."driver_money_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_ready_orders"() RETURNS TABLE("order_id" "uuid", "customer_name" "text", "delivery_address" "text", "total_cents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.staff_profiles WHERE user_id=auth.uid() AND role IN ('driver','admin') AND active) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,o.customer_name,o.delivery_address,o.total_cents
 FROM public.customer_orders o WHERE o.status='ready'
 AND NOT EXISTS(SELECT 1 FROM public.delivery_assignments a WHERE a.order_id=o.id)
 ORDER BY o.created_at LIMIT 100;
END; $$;


ALTER FUNCTION "public"."driver_ready_orders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_reorder_active_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid:=auth.uid();v_id uuid;v_pos integer:=0;
BEGIN
 IF v_actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.staff_profiles WHERE user_id=v_actor AND active AND role IN ('driver','admin')) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 PERFORM 1 FROM public.delivery_routes WHERE id=p_route_id AND driver_id=v_actor AND dispatched_at IS NOT NULL AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active route unavailable'; END IF;
 IF p_order_ids IS NULL OR cardinality(p_order_ids)=0 OR array_position(p_order_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_order_ids) x)<>cardinality(p_order_ids)
 OR cardinality(p_order_ids)<>(SELECT count(*) FROM public.delivery_assignments WHERE route_id=p_route_id)
 OR EXISTS(SELECT 1 FROM unnest(p_order_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.delivery_assignments WHERE route_id=p_route_id AND order_id=x))
 THEN RAISE EXCEPTION 'Route orders mismatch'; END IF;
 SET CONSTRAINTS delivery_assignments_route_id_stop_order_key DEFERRED;
 FOREACH v_id IN ARRAY p_order_ids LOOP
  v_pos:=v_pos+1;
  UPDATE public.delivery_assignments SET stop_order=v_pos WHERE route_id=p_route_id AND order_id=v_id;
 END LOOP;
END; $$;


ALTER FUNCTION "public"."driver_reorder_active_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_take_ready_orders"("p_request_id" "uuid", "p_order_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid:=auth.uid();v_route uuid;v_order uuid;v_status text;v_pos integer:=0;v_variant record;v_res record;v_count integer;
BEGIN
 IF v_actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.staff_profiles WHERE user_id=v_actor AND active AND role IN ('driver','admin')) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_order_ids IS NULL OR cardinality(p_order_ids) NOT BETWEEN 1 AND 30
 OR array_position(p_order_ids,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(p_order_ids) x)<>cardinality(p_order_ids)
 THEN RAISE EXCEPTION 'Invalid delivery selection'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,87));
 SELECT id INTO v_route FROM public.delivery_routes WHERE request_id=p_request_id;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.delivery_routes WHERE id=v_route AND driver_id=v_actor AND dispatched_at IS NOT NULL)
  OR (SELECT count(*) FROM public.delivery_assignments WHERE route_id=v_route)<>cardinality(p_order_ids)
  OR EXISTS(SELECT 1 FROM public.delivery_assignments WHERE route_id=v_route AND NOT(order_id=ANY(p_order_ids)))
  THEN RAISE EXCEPTION 'Request ID already used for different outing'; END IF;
  RETURN v_route;
 END IF;
 -- Lock all selected orders in canonical order, before touching their inventory.
 FOR v_order IN SELECT x FROM unnest(p_order_ids) AS x ORDER BY x LOOP
  SELECT status INTO v_status FROM public.customer_orders WHERE id=v_order FOR UPDATE;
  IF NOT FOUND OR v_status<>'ready' THEN RAISE EXCEPTION 'Order unavailable; refresh'; END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_assignments WHERE order_id=v_order) THEN RAISE EXCEPTION 'Order already taken; refresh'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customer_order_lines WHERE order_id=v_order) OR EXISTS(
   SELECT 1 FROM public.customer_order_lines l LEFT JOIN public.order_reservations r ON r.order_line_id=l.id AND r.released_at IS NULL
   WHERE l.order_id=v_order GROUP BY l.id,l.quantity HAVING coalesce(sum(r.quantity),0)<>l.quantity
  ) THEN RAISE EXCEPTION 'Order reservations mismatch'; END IF;
 END LOOP;
 INSERT INTO public.delivery_routes(request_id,label,driver_id,created_by)
 VALUES(p_request_id,'Salida '||to_char(pg_catalog.clock_timestamp(),'DD/MM HH24:MI'),v_actor,v_actor) RETURNING id INTO v_route;
 FOREACH v_order IN ARRAY p_order_ids LOOP
  v_pos:=v_pos+1;
  INSERT INTO public.delivery_assignments(order_id,route_id,assigned_by,stop_order) VALUES(v_order,v_route,v_actor,v_pos);
 END LOOP;
 -- Stable variant locks, then reservation/lot locks; same order as manual dispatch.
 FOR v_variant IN SELECT DISTINCT l.variant_id FROM public.customer_order_lines l WHERE l.order_id=ANY(p_order_ids) ORDER BY l.variant_id LOOP
  PERFORM 1 FROM public.product_variants WHERE id=v_variant.variant_id FOR UPDATE;
 END LOOP;
 FOR v_res IN SELECT r.id AS reservation_id,r.lot_id,r.quantity,l.order_id
  FROM public.order_reservations r JOIN public.customer_order_lines l ON l.id=r.order_line_id
  WHERE l.order_id=ANY(p_order_ids) AND r.released_at IS NULL ORDER BY r.lot_id,r.id FOR UPDATE OF r
 LOOP
  UPDATE public.inventory_lots SET qty_on_hand=qty_on_hand-v_res.quantity,qty_reserved=qty_reserved-v_res.quantity
  WHERE id=v_res.lot_id AND qty_reserved>=v_res.quantity AND qty_on_hand>=v_res.quantity;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inventory changed; refresh'; END IF;
  INSERT INTO public.delivery_inventory_movements(order_id,reservation_id,lot_id,quantity,actor_id)
  VALUES(v_res.order_id,v_res.reservation_id,v_res.lot_id,v_res.quantity,v_actor);
  UPDATE public.order_reservations SET released_at=now() WHERE id=v_res.reservation_id;
 END LOOP;
 UPDATE public.customer_orders SET status='out_for_delivery',updated_at=now() WHERE id=ANY(p_order_ids);
 UPDATE public.delivery_routes SET dispatched_at=now(),dispatched_by=v_actor WHERE id=v_route;
 RETURN v_route;
END; $$;


ALTER FUNCTION "public"."driver_take_ready_orders"("p_request_id" "uuid", "p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_period_summary"("p_from" "date", "p_to" "date") RETURNS TABLE("counter_sales_cents" bigint, "delivery_sales_cents" bigint, "counter_cogs_cents" numeric, "delivery_cogs_cents" numeric, "waste_cost_cents" numeric, "expenses_cents" bigint, "counter_cash_received_cents" bigint, "delivery_cash_received_cents" bigint, "delivery_transfer_verified_cents" bigint, "delivery_transfer_reported_unverified_cents" bigint, "delivered_without_payment_cents" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_start timestamptz;
    v_end timestamptz;
BEGIN
    IF auth.uid() IS NULL
       OR NOT public.staff_has_role(ARRAY['admin']) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_from IS NULL
       OR p_to IS NULL
       OR p_to < p_from
       OR p_to - p_from > 366 THEN
        RAISE EXCEPTION 'Invalid reporting period';
    END IF;

    v_start := p_from::timestamp
        AT TIME ZONE 'America/Guatemala';

    v_end := (p_to + 1)::timestamp
        AT TIME ZONE 'America/Guatemala';

    RETURN QUERY
    WITH delivered_dates AS (
        SELECT order_id, MIN(created_at) AS delivered_at
        FROM public.customer_order_events
        WHERE new_status = 'delivered'
        GROUP BY order_id
    ),
    counter_sales AS (
        SELECT id, total_cents
        FROM public.sales
        WHERE status = 'completed'
          AND created_at >= v_start
          AND created_at < v_end
    ),
    counter_cost_by_sale AS (
        SELECT
            sl.sale_id,
            SUM(
                -im.qty_change *
                lot.cost_cents_per_base_unit
            ) AS cost_cents
        FROM public.sale_lines sl
        JOIN public.inventory_movements im
            ON im.sale_line_id = sl.id
           AND im.reason = 'sale'
           AND im.qty_change < 0
        JOIN public.inventory_lots lot
            ON lot.id = im.lot_id
        JOIN counter_sales cs
            ON cs.id = sl.sale_id
        GROUP BY sl.sale_id
    ),
    delivered AS (
        SELECT o.id, o.total_cents
        FROM public.customer_orders o
        JOIN delivered_dates d
            ON d.order_id = o.id
        WHERE o.status = 'delivered'
          AND d.delivered_at >= v_start
          AND d.delivered_at < v_end
    ),
    delivery_cost_by_order AS (
        SELECT
            m.order_id,
            SUM(
                m.quantity *
                lot.cost_cents_per_base_unit
            ) AS cost_cents
        FROM public.delivery_inventory_movements m
        JOIN public.inventory_lots lot
            ON lot.id = m.lot_id
        JOIN delivered d
            ON d.id = m.order_id
        GROUP BY m.order_id
    ),
    payment_by_order AS (
        SELECT
            d.id,
            d.total_cents,
            COALESCE(SUM(p.amount_cents) FILTER (
                WHERE p.event_kind = 'payment'
                  AND p.method = 'cash'
            ), 0)::bigint AS cash_cents,
            COALESCE(SUM(p.amount_cents) FILTER (
                WHERE p.event_kind = 'payment'
                  AND p.method = 'transfer_reported'
                  AND p.verified_at IS NOT NULL
            ), 0)::bigint AS verified_cents,
            COALESCE(SUM(p.amount_cents) FILTER (
                WHERE p.event_kind = 'payment'
                  AND p.method = 'transfer_reported'
                  AND p.verified_at IS NULL
            ), 0)::bigint AS reported_cents
        FROM delivered d
        LEFT JOIN public.delivery_payment_events p
            ON p.order_id = d.id
        GROUP BY d.id, d.total_cents
    )
    SELECT
        (SELECT COALESCE(SUM(total_cents), 0)::bigint
         FROM counter_sales),

        (SELECT COALESCE(SUM(total_cents), 0)::bigint
         FROM delivered),

        (SELECT COALESCE(SUM(cost_cents), 0)
         FROM counter_cost_by_sale),

        (SELECT COALESCE(SUM(cost_cents), 0)
         FROM delivery_cost_by_order),

        (
            SELECT COALESCE(SUM(
                -im.qty_change *
                lot.cost_cents_per_base_unit
            ), 0)
            FROM public.inventory_movements im
            JOIN public.inventory_lots lot
                ON lot.id = im.lot_id
            WHERE im.reason = 'waste'
              AND im.qty_change < 0
              AND im.created_at >= v_start
              AND im.created_at < v_end
        )
        +
        (
            SELECT COALESCE(SUM(
                rl.qty_damaged *
                rl.cost_cents_per_base_unit
            ), 0)
            FROM public.delivery_return_lines rl
            JOIN public.delivery_return_receipts rr
                ON rr.id = rl.receipt_id
            WHERE rr.created_at >= v_start
              AND rr.created_at < v_end
        ),

        (SELECT COALESCE(SUM(amount_cents), 0)::bigint
         FROM public.operating_expenses
         WHERE expense_date BETWEEN p_from AND p_to),

        (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
         FROM public.sale_payments p
         JOIN public.sales s ON s.id = p.sale_id
         WHERE s.status = 'completed'
           AND p.status = 'received'
           AND p.method = 'cash'
           AND p.created_at >= v_start
           AND p.created_at < v_end),

        (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
         FROM public.delivery_payment_events p
         JOIN public.customer_orders o
             ON o.id = p.order_id
         WHERE o.status = 'delivered'
           AND p.event_kind = 'payment'
           AND p.method = 'cash'
           AND p.created_at >= v_start
           AND p.created_at < v_end),

        (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
         FROM public.delivery_payment_events p
         JOIN public.customer_orders o
             ON o.id = p.order_id
         WHERE o.status = 'delivered'
           AND p.event_kind = 'payment'
           AND p.method = 'transfer_reported'
           AND p.verified_at IS NOT NULL
           AND p.verified_at >= v_start
           AND p.verified_at < v_end),

        (SELECT COALESCE(SUM(reported_cents), 0)::bigint
         FROM payment_by_order),

        (SELECT COALESCE(SUM(
            GREATEST(
                total_cents
                - cash_cents
                - verified_cents
                - reported_cents,
                0
            )
        ), 0)::bigint
         FROM payment_by_order);
END;
$$;


ALTER FUNCTION "public"."finance_period_summary"("p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_cash_day_entry"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE j jsonb; docs jsonb[]; v_day public.cash_days%ROWTYPE;
 v_id uuid; v_date date; v_driver uuid; v_cash boolean;
BEGIN
 IF TG_OP='INSERT' THEN docs:=ARRAY[to_jsonb(NEW)];
 ELSIF TG_OP='DELETE' THEN docs:=ARRAY[to_jsonb(OLD)];
 ELSE docs:=ARRAY[to_jsonb(OLD),to_jsonb(NEW)]; END IF;
 FOREACH j IN ARRAY docs LOOP
  v_id:=NULL; v_date:=NULL; v_driver:=NULL; v_cash:=true;
  IF TG_TABLE_NAME='sale_payments' THEN
   v_cash:=j->>'method'='cash' AND j->>'status'='received';
   v_date:=((j->>'created_at')::timestamptz AT TIME ZONE 'America/Guatemala')::date;
  ELSIF TG_TABLE_NAME='delivery_payment_events' THEN
   v_cash:=j->>'method'='cash' AND j->>'event_kind'='payment';
   v_date:=((j->>'created_at')::timestamptz AT TIME ZONE 'America/Guatemala')::date;
   v_driver:=(j->>'cash_received_by')::uuid;
  ELSIF TG_TABLE_NAME='operating_expenses' THEN
   v_cash:=j->>'payment_source'='business_cash';
   v_id:=(j->>'cash_day_id')::uuid; v_date:=(j->>'expense_date')::date;
  ELSE
   v_id:=(j->>'cash_day_id')::uuid;
   IF TG_TABLE_NAME='delivery_cash_handoffs' THEN
    v_date:=((j->>'created_at')::timestamptz AT TIME ZONE 'America/Guatemala')::date;
   END IF;
  END IF;
  IF NOT coalesce(v_cash,false) THEN CONTINUE; END IF;
  IF v_id IS NOT NULL THEN
   SELECT * INTO v_day FROM public.cash_days WHERE id=v_id FOR UPDATE;
  ELSE
   SELECT * INTO v_day FROM public.cash_days WHERE business_date=v_date FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
   -- Mostrador y gastos pueden registrarse antes de abrir, como en el flujo actual.
   IF TG_TABLE_NAME IN ('sale_payments','delivery_payment_events','operating_expenses') THEN CONTINUE; END IF;
   RAISE EXCEPTION 'No hay jornada de Caja para este movimiento';
  END IF;
  IF v_day.status<>'open' THEN RAISE EXCEPTION 'La jornada de Caja está cerrada'; END IF;
  IF v_driver IS NOT NULL AND EXISTS(SELECT 1 FROM public.driver_day_settlements s
    WHERE s.cash_day_id=v_day.id AND s.driver_id=v_driver) THEN
   RAISE EXCEPTION 'La persona ya fue liquidada; no se admiten nuevos cobros para esa jornada';
  END IF;
 END LOOP;
 IF TG_TABLE_NAME='delivery_cash_handoffs' AND TG_OP='INSERT' THEN
  IF NEW.cash_day_id IS NULL THEN NEW.cash_day_id:=v_day.id; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;$$;


ALTER FUNCTION "public"."guard_cash_day_entry"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_customer_order_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.customer_order_events(order_id,previous_status,new_status,changed_by) VALUES(NEW.id,'created',NEW.status,auth.uid());
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  INSERT INTO public.customer_order_events(order_id,previous_status,new_status,changed_by) VALUES(NEW.id,OLD.status,NEW.status,auth.uid());
 END IF;
 RETURN NEW;
END; $$;


ALTER FUNCTION "public"."log_customer_order_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_delivery_orders"() RETURNS TABLE("order_id" "uuid", "route_id" "uuid", "route_label" "text", "customer_name" "text", "customer_phone" "text", "delivery_address" "text", "total_cents" bigint, "stop_order" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,dr.id,dr.label,o.customer_name,o.customer_phone,o.delivery_address,o.total_cents,a.stop_order
 FROM public.delivery_assignments a JOIN public.delivery_routes dr ON dr.id=a.route_id
 JOIN public.customer_orders o ON o.id=a.order_id
 WHERE dr.driver_id=auth.uid() AND dr.status='planning' AND o.status='ready'
 ORDER BY dr.created_at,a.stop_order,o.created_at;
END; $$;


ALTER FUNCTION "public"."my_delivery_orders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_delivery_orders_v2"() RETURNS TABLE("order_id" "uuid", "route_id" "uuid", "route_label" "text", "customer_name" "text", "customer_phone" "text", "delivery_address" "text", "total_cents" bigint, "stop_order" integer, "order_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,dr.id,dr.label,o.customer_name,o.customer_phone,o.delivery_address,o.total_cents,a.stop_order,o.status
 FROM public.delivery_assignments a JOIN public.delivery_routes dr ON dr.id=a.route_id
 JOIN public.customer_orders o ON o.id=a.order_id
 WHERE dr.driver_id=auth.uid() AND o.status IN ('ready','out_for_delivery')
 ORDER BY dr.created_at,a.stop_order,o.created_at;
END; $$;


ALTER FUNCTION "public"."my_delivery_orders_v2"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_push_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_secret text;
    v_request_id bigint;
BEGIN
    IF NEW.event_type NOT IN (
        'delivery_assigned',
        'customer_order_created'
    ) THEN
        RETURN NEW;
    END IF;

    SELECT decrypted_secret
    INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'push_webhook_secret';

    IF v_secret IS NULL THEN
        RAISE WARNING 'Push webhook secret not configured';
        RETURN NEW;
    END IF;

    SELECT net.http_post(
        url := 'https://develop.inmensamar.pages.dev/api/push-webhook',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-push-webhook-secret', v_secret
        ),
        body := jsonb_build_object(
            'type', 'INSERT',
            'table', 'push_events',
            'schema', 'public',
            'record', jsonb_build_object(
                'id', NEW.id,
                'event_type', NEW.event_type
            )
        ),
        timeout_milliseconds := 5000
    )
    INTO v_request_id;

    RETURN NEW;

EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Unable to queue push webhook';
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_push_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."open_cash_day"("p_request_id" "uuid", "p_opening_float_cents" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_user_id uuid;
    v_business_date date;
    v_day_id uuid;
    v_existing public.cash_days%ROWTYPE;
BEGIN
    IF NOT public.staff_has_role(ARRAY['admin', 'counter']) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_request_id IS NULL
       OR p_opening_float_cents IS NULL
       OR p_opening_float_cents < 0 THEN
        RAISE EXCEPTION 'Invalid cash opening';
    END IF;

    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    v_business_date :=
        (now() AT TIME ZONE 'America/Guatemala')::date;

    -- Revisar si la solicitud ya fue registrada
    SELECT *
    INTO v_existing
    FROM public.cash_days
    WHERE request_id = p_request_id;

    IF FOUND THEN
        IF v_existing.opening_float_cents = p_opening_float_cents
           AND v_existing.opened_by = v_user_id THEN
            RETURN v_existing.id;
        END IF;

        RAISE EXCEPTION 'Request ID already used';
    END IF;

    -- Registrar apertura
    INSERT INTO public.cash_days (
        request_id,
        business_date,
        opening_float_cents,
        opened_by
    )
    VALUES (
        p_request_id,
        v_business_date,
        p_opening_float_cents,
        v_user_id
    )
    RETURNING id INTO v_day_id;

    RETURN v_day_id;
END;
$$;


ALTER FUNCTION "public"."open_cash_day"("p_request_id" "uuid", "p_opening_float_cents" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."owner_growth_dashboard"("p_from" "date", "p_to" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>366 THEN RAISE EXCEPTION 'Invalid date range'; END IF;
 WITH bounds AS (
  SELECT (p_from::timestamp AT TIME ZONE 'America/Guatemala') AS start_at,
   ((p_to+1)::timestamp AT TIME ZONE 'America/Guatemala') AS end_at,
   ((p_from-(p_to-p_from+1))::timestamp AT TIME ZONE 'America/Guatemala') AS previous_at
 ),
 delivery_dates AS (
  SELECT o.id,o.total_cents,MIN(e.created_at) AS delivered_at
  FROM public.customer_orders o JOIN public.customer_order_events e ON e.order_id=o.id AND e.new_status='delivered'
  WHERE o.status='delivered' GROUP BY o.id,o.total_cents
 ),
 sales_all AS (
  SELECT s.id,'counter'::text AS source,s.created_at AS sold_at,s.total_cents FROM public.sales s WHERE s.status='completed'
  UNION ALL
  SELECT d.id,'delivery',d.delivered_at,d.total_cents FROM delivery_dates d
 ),
 daily AS (
  SELECT (sold_at AT TIME ZONE 'America/Guatemala')::date AS day,COUNT(*) AS operations,SUM(total_cents) AS cents
  FROM sales_all,bounds b WHERE sold_at>=b.start_at AND sold_at<b.end_at GROUP BY 1
 ),
 current_sales AS (SELECT COALESCE(SUM(total_cents),0) AS cents FROM sales_all,bounds b WHERE sold_at>=b.start_at AND sold_at<b.end_at),
 previous_sales AS (SELECT COALESCE(SUM(total_cents),0) AS cents FROM sales_all,bounds b WHERE sold_at>=b.previous_at AND sold_at<b.start_at),
 revenue_by_variant AS (
  SELECT sl.variant_id,SUM(sl.line_total_cents)::numeric AS revenue_cents,SUM(sl.quantity) AS qty
  FROM public.sale_lines sl JOIN public.sales s ON s.id=sl.sale_id CROSS JOIN bounds b
  WHERE s.status='completed' AND s.created_at>=b.start_at AND s.created_at<b.end_at GROUP BY sl.variant_id
  UNION ALL
  SELECT l.variant_id,SUM(l.line_total_cents)::numeric,SUM(l.quantity)
  FROM public.customer_order_lines l JOIN delivery_dates d ON d.id=l.order_id CROSS JOIN bounds b
  WHERE d.delivered_at>=b.start_at AND d.delivered_at<b.end_at GROUP BY l.variant_id
 ),
 cost_by_variant AS (
  SELECT sl.variant_id,SUM(-m.qty_change*lot.cost_cents_per_base_unit)::numeric AS cost_cents
  FROM public.inventory_movements m JOIN public.sale_lines sl ON sl.id=m.sale_line_id
  JOIN public.sales s ON s.id=sl.sale_id JOIN public.inventory_lots lot ON lot.id=m.lot_id CROSS JOIN bounds b
  WHERE s.status='completed' AND m.reason='sale' AND m.qty_change<0 AND s.created_at>=b.start_at AND s.created_at<b.end_at GROUP BY sl.variant_id
  UNION ALL
  SELECT lot.variant_id,SUM(m.quantity*lot.cost_cents_per_base_unit)::numeric
  FROM public.delivery_inventory_movements m JOIN public.inventory_lots lot ON lot.id=m.lot_id
  JOIN delivery_dates d ON d.id=m.order_id CROSS JOIN bounds b
  WHERE d.delivered_at>=b.start_at AND d.delivered_at<b.end_at GROUP BY lot.variant_id
 ),
 product_totals AS (
  SELECT variant_id,SUM(revenue_cents) AS revenue_cents,SUM(qty) AS qty FROM revenue_by_variant GROUP BY variant_id
 ),
 product_costs AS (SELECT variant_id,SUM(cost_cents) AS cost_cents FROM cost_by_variant GROUP BY variant_id),
 product_rank AS (
  SELECT v.id, f.name AS family,v.name,v.base_unit,t.qty,t.revenue_cents,
   COALESCE(c.cost_cents,0) AS cost_cents,t.revenue_cents-COALESCE(c.cost_cents,0) AS margin_cents
  FROM product_totals t JOIN public.product_variants v ON v.id=t.variant_id
  JOIN public.product_families f ON f.id=v.family_id LEFT JOIN product_costs c ON c.variant_id=v.id
 ),
 available AS (
  SELECT v.id,COALESCE(SUM(GREATEST(l.qty_on_hand-l.qty_reserved,0)) FILTER (
   WHERE l.status='available' AND (l.use_by IS NULL OR l.use_by>=(now() AT TIME ZONE 'America/Guatemala')::date)),0) AS available_qty
  FROM public.product_variants v LEFT JOIN public.inventory_lots l ON l.variant_id=v.id GROUP BY v.id
 ),
 critical AS (
  SELECT v.id,f.name AS family,v.name,v.base_unit,v.minimum_stock,a.available_qty
  FROM public.product_variants v JOIN public.product_families f ON f.id=v.family_id
  JOIN available a ON a.id=v.id WHERE v.active=true AND v.minimum_stock>0 AND a.available_qty<=v.minimum_stock
 )
 SELECT jsonb_build_object(
  'from',p_from,'to',p_to,
  'sales_cents',(SELECT cents FROM current_sales),
  'previous_sales_cents',(SELECT cents FROM previous_sales),
  'daily',COALESCE((SELECT jsonb_agg(jsonb_build_object('date',d.day,'operations',COALESCE(x.operations,0),'sales_cents',COALESCE(x.cents,0)) ORDER BY d.day)
    FROM generate_series(p_from,p_to,'1 day'::interval) AS d(day) LEFT JOIN daily x ON x.day=d.day::date),'[]'::jsonb),
  'products',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'family',family,'name',name,'unit',base_unit,'quantity',qty,'revenue_cents',revenue_cents,'cost_cents',cost_cents,'margin_cents',margin_cents) ORDER BY revenue_cents DESC) FROM product_rank),'[]'::jsonb),
  'critical',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'family',family,'name',name,'unit',base_unit,'minimum',minimum_stock,'available',available_qty) ORDER BY available_qty) FROM critical),'[]'::jsonb)
 ) INTO v_result;
 RETURN v_result;
END;$$;


ALTER FUNCTION "public"."owner_growth_dashboard"("p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pending_delivery_returns"() RETURNS TABLE("order_id" "uuid", "customer_name" "text", "movement_id" "uuid", "lot_id" "uuid", "quantity" numeric, "product_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 RETURN QUERY SELECT o.id,o.customer_name,m.id,m.lot_id,m.quantity,v.name
 FROM public.customer_orders o JOIN public.delivery_inventory_movements m ON m.order_id=o.id
 JOIN public.inventory_lots l ON l.id=m.lot_id JOIN public.product_variants v ON v.id=l.variant_id
 WHERE o.status='return_pending' ORDER BY o.created_at,m.id;
END;$$;


ALTER FUNCTION "public"."pending_delivery_returns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prepare_and_dispatch_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."prepare_and_dispatch_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prepare_delivery_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."prepare_delivery_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_post_settlement_cash_entries"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.driver_day_settlements s WHERE s.cash_day_id=NEW.cash_day_id AND s.driver_id=NEW.driver_id)
 THEN RAISE EXCEPTION 'Driver day already settled'; END IF;
 RETURN NEW;
END;$$;


ALTER FUNCTION "public"."prevent_post_settlement_cash_entries"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_delivery_push"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    IF NEW.dispatched_at IS NOT NULL
       AND OLD.dispatched_at IS NULL THEN

        INSERT INTO public.push_events (
            event_key,
            event_type,
            reference_id,
            recipient_user_id
        )
        VALUES (
            'delivery_assigned:' || NEW.id::text,
            'delivery_assigned',
            NEW.id,
            NEW.driver_id
        )
        ON CONFLICT (event_key) DO NOTHING;

    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."queue_delivery_push"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_new_order_push"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE recipient record;
BEGIN
  IF NEW.status = 'received' THEN
    FOR recipient IN
      SELECT user_id FROM public.staff_profiles
      WHERE active IS TRUE AND role IN ('admin', 'counter')
    LOOP
      BEGIN
        INSERT INTO public.push_events
          (event_key, event_type, reference_id, recipient_user_id)
        VALUES
          ('customer_order_created:' || NEW.id::text || ':' || recipient.user_id::text,
           'customer_order_created', NEW.id, recipient.user_id)
        ON CONFLICT (event_key) DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Unable to queue new order push for one recipient';
      END;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."queue_new_order_push"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_cash_withdrawal"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_amount_cents" bigint, "p_note" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; prior public.cash_withdrawals%ROWTYPE; b jsonb; v_id uuid; v_note text:=nullif(btrim(p_note),'');
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_cash_day_id IS NULL OR p_request_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents<=0
 OR char_length(coalesce(v_note,''))>250 THEN RAISE EXCEPTION 'Invalid withdrawal'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,302));
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash day not found'; END IF;
 SELECT * INTO prior FROM public.cash_withdrawals WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.cash_day_id=p_cash_day_id AND prior.amount_cents=p_amount_cents AND prior.note IS NOT DISTINCT FROM v_note
   AND prior.recorded_by=auth.uid() AND prior.source_errand_id IS NULL THEN RETURN prior.id; END IF;
  RAISE EXCEPTION 'Request ID already used'; END IF;
 IF d.status<>'open' THEN RAISE EXCEPTION 'Cash day is closed'; END IF;
 IF d.business_date<>(now() AT TIME ZONE 'America/Guatemala')::date THEN RAISE EXCEPTION 'Withdrawals must belong to the current business date'; END IF;
 PERFORM public.sync_driver_day_purchases(d.id);
 b:=public.cash_day_reconciliation(d.id);
 IF NOT (b->>'can_close')::boolean THEN RAISE EXCEPTION 'Antes del retiro, resolvé la conciliación: %',b->'blockers'; END IF;
 IF (b->>'requires_float_confirmation')::boolean THEN RAISE EXCEPTION 'El sencillo de liquidaciones anteriores requiere revisar su origen antes de retirar.'; END IF;
 IF p_amount_cents>(b->>'expected_cents')::bigint THEN RAISE EXCEPTION 'Withdrawal exceeds expected cash'; END IF;
 INSERT INTO public.cash_withdrawals(request_id,cash_day_id,amount_cents,note,recorded_by)
 VALUES(p_request_id,d.id,p_amount_cents,v_note,auth.uid()) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."record_cash_withdrawal"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_amount_cents" bigint, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_delivery_cash_handoff"("p_request_id" "uuid", "p_from_user_id" "uuid", "p_amount_cents" bigint, "p_note" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; prior public.delivery_cash_handoffs%ROWTYPE;
 recipient uuid; v_role text; c bigint; handed bigint; v_id uuid; v_note text:=nullif(btrim(p_note),'');
 v_start timestamptz; v_end timestamptz;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_from_user_id IS NULL OR p_amount_cents IS NULL OR p_amount_cents<=0
 OR char_length(coalesce(v_note,''))>250 THEN RAISE EXCEPTION 'Invalid cash handoff'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,304));
 SELECT * INTO prior FROM public.delivery_cash_handoffs WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.from_user_id=p_from_user_id AND prior.amount_cents=p_amount_cents AND prior.note IS NOT DISTINCT FROM v_note
    AND prior.recorded_by=auth.uid() THEN RETURN prior.id; END IF;
  RAISE EXCEPTION 'Request ID already used'; END IF;
 SELECT * INTO d FROM public.cash_days WHERE status='open'
  AND business_date=(now() AT TIME ZONE 'America/Guatemala')::date FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No current open cash day'; END IF;
 SELECT recipient_user_id INTO recipient FROM public.delivery_cash_config WHERE singleton=true FOR SHARE;
 IF recipient IS NULL OR p_from_user_id=recipient THEN RAISE EXCEPTION 'Invalid cash recipient'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_profiles WHERE user_id=recipient AND active AND role='admin') THEN
  RAISE EXCEPTION 'Cash recipient is not an active admin'; END IF;
 SELECT role INTO v_role FROM public.staff_profiles WHERE user_id=p_from_user_id AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash holder must be active staff'; END IF;
 IF v_role='driver' THEN RAISE EXCEPTION 'Usá la liquidación única para recibir dinero del repartidor'; END IF;
 v_start:=d.business_date::timestamp AT TIME ZONE 'America/Guatemala'; v_end:=(d.business_date+1)::timestamp AT TIME ZONE 'America/Guatemala';
 SELECT coalesce(sum(amount_cents),0)::bigint INTO c FROM public.delivery_payment_events
 WHERE method='cash' AND event_kind='payment' AND cash_received_by=p_from_user_id AND created_at>=v_start AND created_at<v_end;
 SELECT coalesce(sum(amount_cents),0)::bigint INTO handed FROM public.delivery_cash_handoffs WHERE cash_day_id=d.id AND from_user_id=p_from_user_id;
 IF p_amount_cents>c-handed THEN RAISE EXCEPTION 'Amount exceeds recorded outstanding cash'; END IF;
 INSERT INTO public.delivery_cash_handoffs(request_id,from_user_id,to_user_id,amount_cents,recorded_by,note,cash_day_id)
 VALUES(p_request_id,p_from_user_id,recipient,p_amount_cents,auth.uid(),v_note,d.id) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."record_delivery_cash_handoff"("p_request_id" "uuid", "p_from_user_id" "uuid", "p_amount_cents" bigint, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_sale_payment"("p_request_id" "uuid", "p_sale_id" "uuid", "p_method" "text", "p_amount_cents" bigint, "p_pending_verification" boolean DEFAULT false) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_payment public.sale_payments%rowtype;
  v_received bigint;
  v_payment_id uuid;
begin
  if v_user is null or not public.staff_has_role(array['admin','counter']) then
    raise exception 'Not authorized to record payments';
  end if;
  if p_request_id is null or p_sale_id is null or p_method not in ('cash','transfer')
    or p_method is null or p_amount_cents is null or p_amount_cents <= 0
    or (p_method = 'cash' and p_pending_verification) then
    raise exception 'Invalid payment';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,1));
  select * into v_payment from public.sale_payments where request_id = p_request_id;
  if found then
    if v_payment.sale_id <> p_sale_id or v_payment.method <> p_method
       or v_payment.amount_cents <> p_amount_cents or v_payment.recorded_by <> v_user
       or (not p_pending_verification and v_payment.status = 'pending_verification') then
      raise exception 'Payment request ID already used';
    end if;
    return v_payment.id;
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found or v_sale.status <> 'completed' then raise exception 'Sale unavailable'; end if;
  select coalesce(sum(amount_cents),0) into v_received
  from public.sale_payments where sale_id = p_sale_id;
  if v_received + p_amount_cents > v_sale.total_cents then
    raise exception 'Payment exceeds outstanding balance';
  end if;
  insert into public.sale_payments
    (request_id,sale_id,method,amount_cents,status,recorded_by,verified_at,verified_by)
  values
    (p_request_id,p_sale_id,p_method,p_amount_cents,
     case when p_pending_verification then 'pending_verification' else 'received' end,
     v_user,case when p_pending_verification then null else now() end,
     case when p_pending_verification then null else v_user end)
  returning id into v_payment_id;
  return v_payment_id;
end;
$$;


ALTER FUNCTION "public"."record_sale_payment"("p_request_id" "uuid", "p_sale_id" "uuid", "p_method" "text", "p_amount_cents" bigint, "p_pending_verification" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_counter_sale"("p_request_id" "uuid", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_user uuid := auth.uid();
  v_existing public.sales%rowtype;
  v_sale_id uuid;
  v_item record;
  v_variant record;
  v_lot record;
  v_remaining numeric(14,4);
  v_take numeric(14,4);
  v_line_id uuid;
  v_line_total bigint;
  v_total bigint := 0;
  v_fingerprint text;
begin
  if v_user is null or not public.staff_has_role(array['admin','counter']) then
    raise exception 'Not authorized to register sales';
  end if;
  if p_request_id is null or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'Invalid sale request';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) x
    where jsonb_typeof(x) <> 'object'
      or not (x ? 'variant_id' and x ? 'quantity')
      or jsonb_typeof(x->'variant_id') <> 'string'
      or jsonb_typeof(x->'quantity') <> 'number'
      or (x->>'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Invalid sale item format';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) x
    where (x->>'quantity')::numeric <= 0
       or (x->>'quantity')::numeric > 100000
       or scale((x->>'quantity')::numeric) > 4
  ) then
    raise exception 'Invalid quantity';
  end if;

  select md5(coalesce(jsonb_agg(jsonb_build_array(variant_id, quantity) order by variant_id)::text,'[]'))
    into v_fingerprint
  from (
    select (x->>'variant_id')::uuid variant_id, sum((x->>'quantity')::numeric) quantity
    from jsonb_array_elements(p_items) x
    group by (x->>'variant_id')::uuid
  ) canonical;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
  select * into v_existing from public.sales where request_id = p_request_id;
  if found then
    if v_existing.cashier_id <> v_user or v_existing.request_fingerprint <> v_fingerprint then
      raise exception 'Request ID already used for a different sale';
    end if;
    return v_existing.id;
  end if;

  insert into public.sales(request_id,request_fingerprint,cashier_id,total_cents)
  values(p_request_id,v_fingerprint,v_user,0) returning id into v_sale_id;

  for v_item in
    select (x->>'variant_id')::uuid variant_id, sum((x->>'quantity')::numeric) quantity
    from jsonb_array_elements(p_items) x
    group by (x->>'variant_id')::uuid
    order by (x->>'variant_id')::uuid
  loop
    select id,price_cents,base_unit into v_variant
    from public.product_variants
    where id = v_item.variant_id and active for update;
    if not found then raise exception 'Product unavailable'; end if;
    if v_variant.base_unit in ('unit','package') and v_item.quantity <> trunc(v_item.quantity) then
      raise exception 'Whole units required';
    end if;
    v_line_total := round(v_item.quantity * v_variant.price_cents)::bigint;
    v_total := v_total + v_line_total;
    insert into public.sale_lines(sale_id,variant_id,quantity,unit_price_cents,line_total_cents)
    values(v_sale_id,v_item.variant_id,v_item.quantity,v_variant.price_cents,v_line_total)
    returning id into v_line_id;
    v_remaining := v_item.quantity;
    for v_lot in
      select id,qty_on_hand,qty_reserved from public.inventory_lots
      where variant_id = v_item.variant_id and status = 'available'
        and (use_by is null or use_by >= current_date)
        and qty_on_hand > qty_reserved
      order by use_by asc nulls last, received_at, id for update
    loop
      v_take := least(v_remaining,v_lot.qty_on_hand-v_lot.qty_reserved);
      update public.inventory_lots set qty_on_hand = qty_on_hand - v_take where id = v_lot.id;
      insert into public.inventory_movements(lot_id,sale_line_id,qty_change,reason,actor_id)
      values(v_lot.id,v_line_id,-v_take,'sale',v_user);
      v_remaining := v_remaining-v_take;
      exit when v_remaining = 0;
    end loop;
    if v_remaining > 0 then raise exception 'Insufficient available inventory'; end if;
  end loop;
  update public.sales set total_cents = v_total where id = v_sale_id;
  return v_sale_id;
end;
$_$;


ALTER FUNCTION "public"."register_counter_sale"("p_request_id" "uuid", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reorder_delivery_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."reorder_delivery_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."report_delivery_failure"("p_order_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_route uuid; v_driver uuid; v_status text; v_prior public.delivery_failure_events%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin','counter','driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_order_id IS NULL OR p_request_id IS NULL OR p_action NOT IN ('retry','return') OR p_reason NOT IN ('absent','no_answer','wrong_address','rejected','other') THEN RAISE EXCEPTION 'Invalid failure report'; END IF;
 SELECT a.route_id,r.driver_id INTO v_route,v_driver FROM public.delivery_assignments a JOIN public.delivery_routes r ON r.id=a.route_id WHERE a.order_id=p_order_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not assigned'; END IF;
 IF NOT public.staff_has_role(ARRAY['admin','counter']) AND v_driver IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Not your delivery'; END IF;
 PERFORM 1 FROM public.delivery_routes WHERE id=v_route AND dispatched_at IS NOT NULL AND status<>'closed' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Route not active'; END IF;
 SELECT status INTO v_status FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
 SELECT * INTO v_prior FROM public.delivery_failure_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.order_id=p_order_id AND v_prior.action=p_action AND v_prior.reason=p_reason AND v_prior.actor_id=auth.uid() THEN RETURN; END IF;
  RAISE EXCEPTION 'Request ID already used';
 END IF;
 IF v_status<>'out_for_delivery' THEN RAISE EXCEPTION 'Order not out for delivery'; END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_payment_events WHERE order_id=p_order_id AND event_kind='payment') THEN RAISE EXCEPTION 'Paid order requires admin reconciliation'; END IF;
 INSERT INTO public.delivery_failure_events(request_id,order_id,action,reason,actor_id) VALUES(p_request_id,p_order_id,p_action,p_reason,auth.uid());
 IF p_action='return' THEN UPDATE public.customer_orders SET status='return_pending',updated_at=now() WHERE id=p_order_id; END IF;
END;$$;


ALTER FUNCTION "public"."report_delivery_failure"("p_order_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."report_driver_cash_errand"("p_request_id" "uuid", "p_description" "text", "p_amount_cents" bigint, "p_category" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_actor uuid := auth.uid(); v_day uuid; v_old public.driver_cash_errands%ROWTYPE; v_id uuid; v_desc text := btrim(p_description);
BEGIN
 IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['driver']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR v_desc IS NULL OR char_length(v_desc) NOT BETWEEN 2 AND 250 OR p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_category NOT IN ('personal','business') OR p_category IS NULL THEN RAISE EXCEPTION 'Invalid errand'; END IF;
 PERFORM 1 FROM public.staff_profiles WHERE user_id=v_actor AND role='driver' AND active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Driver is not active'; END IF;
 SELECT * INTO v_old FROM public.driver_cash_errands WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_old.driver_id=v_actor AND v_old.description=v_desc AND v_old.amount_cents=p_amount_cents AND v_old.category=p_category THEN RETURN v_old.id; END IF;
  RAISE EXCEPTION 'Request ID already used';
 END IF;
 SELECT id INTO v_day FROM public.cash_days WHERE status='open' AND business_date=(now() AT TIME ZONE 'America/Guatemala')::date FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'No open cash day'; END IF;
 INSERT INTO public.driver_cash_errands(request_id,cash_day_id,driver_id,description,amount_cents,category)
 VALUES(p_request_id,v_day,v_actor,v_desc,p_amount_cents,p_category) RETURNING id INTO v_id;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."report_driver_cash_errand"("p_request_id" "uuid", "p_description" "text", "p_amount_cents" bigint, "p_category" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."review_driver_cash_errand"("p_errand_id" "uuid", "p_approve" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_old public.driver_cash_errands%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_errand_id IS NULL OR p_approve IS NULL THEN RAISE EXCEPTION 'Invalid review'; END IF;
 SELECT * INTO v_old FROM public.driver_cash_errands WHERE id=p_errand_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Errand not found'; END IF;
 IF v_old.status <> 'reported' THEN
  IF (p_approve AND v_old.status = 'approved') OR (NOT p_approve AND v_old.status = 'rejected') THEN RETURN; END IF;
  RAISE EXCEPTION 'Errand already reviewed';
 END IF;
 UPDATE public.driver_cash_errands SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,reviewed_by=auth.uid(),reviewed_at=now() WHERE id=p_errand_id;
END;$$;


ALTER FUNCTION "public"."review_driver_cash_errand"("p_errand_id" "uuid", "p_approve" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
  tbl name;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        SELECT c.relname INTO tbl FROM pg_catalog.pg_class c WHERE c.oid = cmd.objid;
        EXECUTE format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_delivery_transfer_issue"("p_order_id" "uuid", "p_action" "text", "p_reason" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_payment public.delivery_payment_events%ROWTYPE;
  v_last_action text;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_order_id IS NULL OR p_action IS NULL
     OR p_action NOT IN ('reported','resolved')
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Invalid issue details';
  END IF;

  -- Serialize issue changes per payment, including concurrent admin requests.
  SELECT * INTO v_payment
  FROM public.delivery_payment_events
  WHERE order_id=p_order_id AND event_kind='payment'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_payment.method<>'transfer_reported' THEN
    RAISE EXCEPTION 'Only transfers can be flagged';
  END IF;
  IF v_payment.verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'Verified transfer requires separate administrative correction';
  END IF;

  SELECT action INTO v_last_action
  FROM public.delivery_transfer_issue_events
  WHERE payment_id=v_payment.id
  ORDER BY event_seq DESC LIMIT 1;

  IF p_action='reported' AND COALESCE(v_last_action,'')='reported' THEN
    RAISE EXCEPTION 'Transfer already has an open issue';
  END IF;
  IF p_action='resolved' AND COALESCE(v_last_action,'')<>'reported' THEN
    RAISE EXCEPTION 'Transfer has no open issue';
  END IF;

  INSERT INTO public.delivery_transfer_issue_events
    (order_id,payment_id,action,reason,actor_id)
  VALUES (p_order_id,v_payment.id,p_action,btrim(p_reason),auth.uid());
END;
$$;


ALTER FUNCTION "public"."set_delivery_transfer_issue"("p_order_id" "uuid", "p_action" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; prior public.driver_day_settlements%ROWTYPE;
 f bigint; c bigint; purchases bigint; expected bigint; recipient uuid; handoff uuid; v_id uuid;
 v_start timestamptz; v_end timestamptz;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_cash_day_id IS NULL OR p_driver_id IS NULL OR p_counted_cents IS NULL OR p_counted_cents<0 THEN RAISE EXCEPTION 'Invalid settlement'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,303));
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash day not found'; END IF;
 SELECT * INTO prior FROM public.driver_day_settlements WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.cash_day_id=p_cash_day_id AND prior.driver_id=p_driver_id AND prior.counted_cents=p_counted_cents
    AND prior.settled_by=auth.uid() THEN RETURN prior.id; END IF;
  RAISE EXCEPTION 'Request ID already used'; END IF;
 -- Permite completar una jornada anterior que sigue abierta; usa su fecha, no hoy.
 IF d.status<>'open' OR d.business_date>(now() AT TIME ZONE 'America/Guatemala')::date THEN RAISE EXCEPTION 'Cash day is not open'; END IF;
 PERFORM 1 FROM public.staff_profiles WHERE user_id=p_driver_id AND role='driver' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Driver not found'; END IF;
 IF EXISTS(SELECT 1 FROM public.driver_day_settlements WHERE cash_day_id=d.id AND driver_id=p_driver_id) THEN RAISE EXCEPTION 'Driver already settled for this day'; END IF;
 SELECT recipient_user_id INTO recipient FROM public.delivery_cash_config WHERE singleton=true FOR SHARE;
 IF recipient IS NULL OR recipient<>auth.uid() THEN RAISE EXCEPTION 'Signed-in admin must be configured cash recipient'; END IF;
 IF EXISTS(SELECT 1 FROM public.driver_float_confirmations WHERE cash_day_id=d.id)
 OR EXISTS(SELECT 1 FROM public.cash_float_transfers WHERE cash_day_id=d.id) THEN RAISE EXCEPTION 'Hay sencillo del flujo anterior; requiere conciliación separada'; END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_cash_handoffs WHERE cash_day_id=d.id AND from_user_id=p_driver_id) THEN RAISE EXCEPTION 'Manual handoff exists; reconcile before unified settlement'; END IF;
 SELECT coalesce(amount_cents,0) INTO f FROM public.driver_cash_floats WHERE cash_day_id=d.id AND driver_id=p_driver_id;
 f:=coalesce(f,0);
 v_start:=d.business_date::timestamp AT TIME ZONE 'America/Guatemala';
 v_end:=(d.business_date+1)::timestamp AT TIME ZONE 'America/Guatemala';
 SELECT coalesce(sum(amount_cents),0)::bigint INTO c FROM public.delivery_payment_events
 WHERE event_kind='payment' AND method='cash' AND cash_received_by=p_driver_id AND created_at>=v_start AND created_at<v_end;
 SELECT coalesce(sum(amount_cents),0)::bigint INTO purchases FROM public.driver_cash_errands
 WHERE cash_day_id=d.id AND driver_id=p_driver_id AND status IN ('reported','approved');
 expected:=f+c-purchases;
 IF expected<0 THEN RAISE EXCEPTION 'Purchases exceed recorded cash'; END IF;
 UPDATE public.driver_cash_errands SET status='approved',reviewed_by=coalesce(reviewed_by,auth.uid()),reviewed_at=coalesce(reviewed_at,now())
 WHERE cash_day_id=d.id AND driver_id=p_driver_id AND status='reported';
 IF p_counted_cents>0 THEN
  INSERT INTO public.delivery_cash_handoffs(request_id,from_user_id,to_user_id,amount_cents,recorded_by,note,cash_day_id)
  VALUES(p_request_id,p_driver_id,recipient,p_counted_cents,auth.uid(),'Liquidación única de jornada '||d.business_date::text,d.id)
  RETURNING id INTO handoff;
 END IF;
 INSERT INTO public.driver_day_settlements(request_id,cash_day_id,driver_id,float_cents,collected_cents,purchases_cents,expected_cents,counted_cents,difference_cents,handoff_id,settled_by)
 VALUES(p_request_id,d.id,p_driver_id,f,c,purchases,expected,p_counted_cents,p_counted_cents-expected,handoff,auth.uid()) RETURNING id INTO v_id;
 PERFORM public.sync_driver_day_purchases(d.id);
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint, "p_reviewed_preview" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE d public.cash_days%ROWTYPE; preview jsonb; v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Invalid settlement'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,303));
 SELECT * INTO d FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Cash day not found'; END IF;
 IF EXISTS(SELECT 1 FROM public.driver_day_settlements WHERE request_id=p_request_id) THEN
  RETURN public.settle_driver_day(p_request_id,p_cash_day_id,p_driver_id,p_counted_cents);
 END IF;
 SELECT to_jsonb(p) INTO preview FROM public.driver_day_settlement_preview() p WHERE p.cash_day_id=d.id AND p.driver_id=p_driver_id;
 IF preview IS NULL OR p_reviewed_preview IS NULL OR preview IS DISTINCT FROM p_reviewed_preview THEN
  RAISE EXCEPTION 'La liquidación cambió. Actualizá y revisá sencillo, cobros y compras antes de confirmar.';
 END IF;
 v_id:=public.settle_driver_day(p_request_id,p_cash_day_id,p_driver_id,p_counted_cents);
 -- Esta firma es la usada por React: su confirmación revisa expresamente el origen.
 UPDATE public.driver_day_settlements SET float_origin_confirmed_by=auth.uid(),float_origin_confirmed_at=now()
  WHERE id=v_id AND float_cents>0 AND float_origin_confirmed_by IS NULL;
 RETURN v_id;
END;$$;


ALTER FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint, "p_reviewed_preview" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."staff_has_role"("allowed_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.staff_profiles s
    where s.user_id = (select auth.uid()) and s.active and s.role = any(allowed_roles)
  );
$$;


ALTER FUNCTION "public"."staff_has_role"("allowed_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."storefront_catalog"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Not authorized'; END IF;
 SELECT jsonb_build_object('products',coalesce(jsonb_agg(jsonb_build_object(
  'id',v.id,'family',f.name,'name',v.name,'unit',v.base_unit,'price_cents',v.price_cents,
  'available',coalesce(a.qty,0)>0) ORDER BY f.name,v.name,v.id),'[]'::jsonb)) INTO v_result
 FROM public.product_variants v JOIN public.product_families f ON f.id=v.family_id
 LEFT JOIN LATERAL (SELECT sum(l.qty_on_hand-l.qty_reserved) qty FROM public.inventory_lots l
  WHERE l.variant_id=v.id AND l.status='available'
   AND (l.use_by IS NULL OR l.use_by >= (now() AT TIME ZONE 'America/Guatemala')::date)
   AND l.qty_on_hand>l.qty_reserved) a ON true
 WHERE v.active AND v.price_cents>0;
 RETURN v_result;
END; $$;


ALTER FUNCTION "public"."storefront_catalog"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_pilot_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_uid uuid := auth.uid();
  v_order uuid;
  v_item record;
  v_variant record;
  v_total bigint := 0;
  v_amount bigint;
begin
  if not public.staff_has_role(array['admin','counter']) then raise exception 'Not authorized'; end if;
  if p_request_id is null then raise exception 'Request ID required'; end if;
  if char_length(btrim(coalesce(p_customer_name,''))) not between 2 and 120
    or coalesce(p_customer_phone,'') !~ '^\+?[0-9 ()-]{8,22}$'
    or char_length(btrim(coalesce(p_delivery_address,''))) not between 5 and 300
    or char_length(coalesce(p_notes,'')) > 500 then raise exception 'Invalid customer details'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'Invalid order items'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x) <> 'object'
    or jsonb_typeof(x->'variant_id') <> 'string' or jsonb_typeof(x->'quantity') <> 'number'
    or (x->>'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'Invalid order item format'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
    where (x->>'quantity')::numeric <= 0 or (x->>'quantity')::numeric > 10000
    or scale((x->>'quantity')::numeric) > 4) then raise exception 'Invalid quantity'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 1));
  select id into v_order from public.customer_orders where request_id=p_request_id;
  if found then return v_order; end if;
  insert into public.customer_orders(request_id,customer_name,customer_phone,delivery_address,notes,total_cents,created_by)
    values (p_request_id,btrim(p_customer_name),p_customer_phone,btrim(p_delivery_address),coalesce(p_notes,''),0,v_uid)
    returning id into v_order;
  for v_item in select (x->>'variant_id')::uuid as variant_id,sum((x->>'quantity')::numeric) as quantity
    from jsonb_array_elements(p_items) x group by 1 order by 1 loop
    select id,base_unit,price_cents into v_variant from public.product_variants
      where id=v_item.variant_id and active for share;
    if not found then raise exception 'Product unavailable'; end if;
    if v_variant.base_unit in ('unit','package') and v_item.quantity <> trunc(v_item.quantity) then
      raise exception 'Whole units required'; end if;
    v_amount := round(v_item.quantity * v_variant.price_cents)::bigint;
    v_total := v_total + v_amount;
    insert into public.customer_order_lines(order_id,variant_id,quantity,unit_price_cents,line_total_cents)
      values (v_order,v_item.variant_id,v_item.quantity,v_variant.price_cents,v_amount);
  end loop;
  update public.customer_orders set total_cents=v_total where id=v_order;
  return v_order;
end; $_$;


ALTER FUNCTION "public"."submit_pilot_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_storefront_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb", "p_client_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
 v_prior public.storefront_order_requests%ROWTYPE;
 v_order uuid; v_item record; v_variant record; v_fingerprint text; v_canonical jsonb;
 v_total bigint:=0; v_amount bigint; v_window timestamptz; v_count integer; v_available numeric;
 v_name text:=btrim(p_customer_name); v_phone text:=btrim(p_customer_phone);
 v_address text:=btrim(p_delivery_address); v_notes text:=btrim(coalesce(p_notes,''));
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$'
  OR char_length(coalesce(v_name,'')) NOT BETWEEN 2 AND 120
  OR coalesce(v_phone,'') !~ '^\+?[0-9 ()-]{8,22}$'
  OR char_length(regexp_replace(coalesce(v_phone,''),'[^0-9]','','g')) NOT BETWEEN 8 AND 15
  OR char_length(coalesce(v_address,'')) NOT BETWEEN 5 AND 300
  OR char_length(coalesce(p_notes,''))>500 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x
  WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
   OR jsonb_typeof(x->'variant_id') IS DISTINCT FROM 'string'
   OR (x->>'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(x->'quantity') IS DISTINCT FROM 'number'
   OR jsonb_typeof(x->'expected_unit_price_cents') IS DISTINCT FROM 'number')
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x
  WHERE (x->>'quantity')::numeric<=0 OR (x->>'quantity')::numeric>1000 OR scale((x->>'quantity')::numeric)>4
   OR (x->>'expected_unit_price_cents')::numeric<0 OR (x->>'expected_unit_price_cents')::numeric>2147483647
   OR (x->>'expected_unit_price_cents')::numeric<>trunc((x->>'expected_unit_price_cents')::numeric))
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 IF (SELECT count(DISTINCT (x->>'variant_id')::uuid) FROM jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items)
 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
 SELECT jsonb_agg(jsonb_build_array((x->>'variant_id')::uuid,(x->>'quantity')::numeric,
  (x->>'expected_unit_price_cents')::integer) ORDER BY (x->>'variant_id')::uuid) INTO v_canonical
 FROM jsonb_array_elements(p_items) x;
 v_fingerprint:=md5(jsonb_build_array(v_name,v_phone,v_address,v_notes,v_canonical)::text);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,307));
 SELECT * INTO v_prior FROM public.storefront_order_requests WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.payload_fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
  SELECT total_cents INTO v_total FROM public.customer_orders WHERE id=v_prior.order_id;
  RETURN jsonb_build_object('order_id',v_prior.order_id,'total_cents',v_total);
 END IF;
 IF EXISTS(SELECT 1 FROM public.customer_orders WHERE request_id=p_request_id) THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_client_hash,311));
 v_window:=to_timestamp(floor(extract(epoch FROM now())/900)*900);
 SELECT orders_count INTO v_count FROM public.storefront_rate_windows WHERE client_hash=p_client_hash AND window_start=v_window;
 IF coalesce(v_count,0)>=5 THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;
 -- Lock variants canonically, like stock writers. No reservations are taken here.
 FOR v_item IN SELECT (x->>'variant_id')::uuid variant_id,(x->>'quantity')::numeric quantity,
   (x->>'expected_unit_price_cents')::integer expected_price FROM jsonb_array_elements(p_items) x ORDER BY 1 LOOP
  SELECT id,price_cents,base_unit INTO v_variant FROM public.product_variants WHERE id=v_item.variant_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_UNAVAILABLE'; END IF;
  IF v_variant.price_cents<>v_item.expected_price THEN RAISE EXCEPTION 'PRICE_CHANGED'; END IF;
  IF v_variant.base_unit<>'lb' AND v_item.quantity<>trunc(v_item.quantity) THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  SELECT coalesce(sum(qty_on_hand-qty_reserved),0) INTO v_available FROM public.inventory_lots
   WHERE variant_id=v_item.variant_id AND status='available'
    AND (use_by IS NULL OR use_by>=(now() AT TIME ZONE 'America/Guatemala')::date) AND qty_on_hand>qty_reserved;
  IF v_available<v_item.quantity THEN RAISE EXCEPTION 'STOCK_UNAVAILABLE'; END IF;
  v_total:=v_total+round(v_item.quantity*v_variant.price_cents)::bigint;
 END LOOP;
 IF v_total<=0 THEN RAISE EXCEPTION 'PRODUCT_UNAVAILABLE'; END IF;
 INSERT INTO public.customer_orders(request_id,customer_name,customer_phone,delivery_address,notes,status,total_cents,created_by)
 VALUES(p_request_id,v_name,v_phone,v_address,v_notes,'received',v_total,NULL) RETURNING id INTO v_order;
 FOR v_item IN SELECT (x->>'variant_id')::uuid variant_id,(x->>'quantity')::numeric quantity,
   (x->>'expected_unit_price_cents')::integer price FROM jsonb_array_elements(p_items) x ORDER BY 1 LOOP
  v_amount:=round(v_item.quantity*v_item.price)::bigint;
  INSERT INTO public.customer_order_lines(order_id,variant_id,quantity,unit_price_cents,line_total_cents)
   VALUES(v_order,v_item.variant_id,v_item.quantity,v_item.price,v_amount);
 END LOOP;
 INSERT INTO public.storefront_order_requests(request_id,order_id,payload_fingerprint) VALUES(p_request_id,v_order,v_fingerprint);
 INSERT INTO public.storefront_rate_windows(client_hash,window_start,orders_count) VALUES(p_client_hash,v_window,1)
 ON CONFLICT(client_hash,window_start) DO UPDATE SET orders_count=public.storefront_rate_windows.orders_count+1;
 DELETE FROM public.storefront_rate_windows WHERE window_start<now()-interval '2 days';
 RETURN jsonb_build_object('order_id',v_order,'total_cents',v_total);
END; $_$;


ALTER FUNCTION "public"."submit_storefront_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb", "p_client_hash" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_driver_day_purchases"("p_cash_day_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE e record; v_day public.cash_days%ROWTYPE;
BEGIN
 SELECT * INTO v_day FROM public.cash_days WHERE id=p_cash_day_id FOR UPDATE;
 IF NOT FOUND OR v_day.status<>'open' THEN RAISE EXCEPTION 'La jornada debe estar abierta'; END IF;
 FOR e IN SELECT x.*,s.settled_by FROM public.driver_cash_errands x
  JOIN public.driver_day_settlements s ON s.cash_day_id=x.cash_day_id AND s.driver_id=x.driver_id
  WHERE x.cash_day_id=p_cash_day_id AND x.status='approved' ORDER BY x.id LOOP
  IF e.category='personal' THEN
   INSERT INTO public.cash_withdrawals(request_id,cash_day_id,amount_cents,note,recorded_by,source_errand_id)
   VALUES(e.id,p_cash_day_id,e.amount_cents,left('Compra personal: '||e.description,250),e.settled_by,e.id)
   ON CONFLICT(source_errand_id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.cash_withdrawals w WHERE w.source_errand_id=e.id
      AND w.cash_day_id=p_cash_day_id AND w.amount_cents=e.amount_cents)
      OR EXISTS(SELECT 1 FROM public.operating_expenses x WHERE x.source_errand_id=e.id) THEN
    RAISE EXCEPTION 'La compra personal no coincide con su retiro vinculado'; END IF;
  ELSE
   INSERT INTO public.operating_expenses(request_id,amount_cents,category,payment_source,note,
     expense_date,actor_id,source_errand_id,cash_day_id)
   VALUES(e.id,e.amount_cents,'other','business_cash',left('Compra de reparto: '||e.description,250),
     v_day.business_date,e.settled_by,e.id,p_cash_day_id)
   ON CONFLICT(source_errand_id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.operating_expenses x WHERE x.source_errand_id=e.id
      AND x.cash_day_id=p_cash_day_id AND x.amount_cents=e.amount_cents
      AND x.expense_date=v_day.business_date AND x.payment_source='business_cash')
      OR EXISTS(SELECT 1 FROM public.cash_withdrawals w WHERE w.source_errand_id=e.id) THEN
    RAISE EXCEPTION 'La compra del negocio no coincide con su gasto vinculado'; END IF;
  END IF;
 END LOOP;
END;$$;


ALTER FUNCTION "public"."sync_driver_day_purchases"("p_cash_day_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_delivery_transfer"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_payment public.delivery_payment_events%ROWTYPE;
BEGIN
  IF NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT * INTO v_payment FROM public.delivery_payment_events
   WHERE order_id=p_order_id AND event_kind='payment' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_payment.method<>'transfer_reported' THEN RAISE EXCEPTION 'Not a reported transfer'; END IF;
  IF v_payment.verified_at IS NOT NULL THEN RETURN; END IF;
  UPDATE public.delivery_payment_events SET verified_by=auth.uid(),verified_at=now() WHERE id=v_payment.id;
END;$$;


ALTER FUNCTION "public"."verify_delivery_transfer"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_transfer_payment"("p_payment_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not public.staff_has_role(array['admin','counter']) then
    raise exception 'Not authorized to verify payments';
  end if;
  update public.sale_payments
    set status = 'received', verified_at = now(), verified_by = v_user
  where id = p_payment_id and method = 'transfer' and status = 'pending_verification';
  if not found then raise exception 'Transfer not found or already verified'; end if;
end;
$$;


ALTER FUNCTION "public"."verify_transfer_payment"("p_payment_id" "uuid") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_catalog_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "family_id" "uuid",
    "variant_id" "uuid",
    "old_value" "text",
    "new_value" "text" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_catalog_events_action_check" CHECK (("action" = ANY (ARRAY['create_family'::"text", 'rename_family'::"text", 'create_variant'::"text", 'rename_variant'::"text", 'set_variant_active'::"text"])))
);


ALTER TABLE "public"."admin_catalog_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_inventory_adjustment_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "adjustment_id" "uuid" NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    CONSTRAINT "admin_inventory_adjustment_lines_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."admin_inventory_adjustment_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_inventory_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "reason" "text" NOT NULL,
    "note" "text",
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_inventory_adjustments_note_check" CHECK ((("note" IS NULL) OR ("length"("note") <= 250))),
    CONSTRAINT "admin_inventory_adjustments_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "admin_inventory_adjustments_reason_check" CHECK (("reason" = ANY (ARRAY['waste'::"text", 'count_difference'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."admin_inventory_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_price_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "old_price_cents" integer NOT NULL,
    "new_price_cents" integer NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_price_events_new_price_cents_check" CHECK (("new_price_cents" >= 0))
);


ALTER TABLE "public"."admin_price_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_purchase_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "unit_cost_cents" integer NOT NULL,
    "use_by" "date",
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_purchase_events_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "admin_purchase_events_unit_cost_cents_check" CHECK (("unit_cost_cents" >= 0))
);


ALTER TABLE "public"."admin_purchase_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_stock_minimum_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "old_minimum" numeric(14,4) NOT NULL,
    "new_minimum" numeric(14,4) NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_stock_minimum_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_close_counts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "counted_by" "uuid" NOT NULL,
    "counted_cents" bigint NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cash_close_counts_counted_cents_check" CHECK (("counted_cents" >= 0)),
    CONSTRAINT "cash_close_counts_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 250)))
);


ALTER TABLE "public"."cash_close_counts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_days" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_date" "date" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "opening_float_cents" bigint NOT NULL,
    "opened_by" "uuid" NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_by" "uuid",
    "closed_at" timestamp with time zone,
    "closing_expected_cents" bigint,
    "closing_counted_cents" bigint,
    "next_day_float_cents" bigint,
    "request_id" "uuid",
    "closing_breakdown" "jsonb",
    CONSTRAINT "cash_days_closing_counted_cents_check" CHECK (("closing_counted_cents" >= 0)),
    CONSTRAINT "cash_days_closing_expected_cents_check" CHECK (("closing_expected_cents" >= 0)),
    CONSTRAINT "cash_days_closure_consistency" CHECK (((("status" = 'open'::"text") AND ("closed_by" IS NULL) AND ("closed_at" IS NULL) AND ("closing_expected_cents" IS NULL) AND ("closing_counted_cents" IS NULL) AND ("next_day_float_cents" IS NULL)) OR (("status" = 'closed'::"text") AND ("closed_by" IS NOT NULL) AND ("closed_at" IS NOT NULL) AND ("closing_expected_cents" IS NOT NULL) AND ("closing_counted_cents" IS NOT NULL) AND ("next_day_float_cents" IS NOT NULL) AND ("next_day_float_cents" <= "closing_counted_cents")))),
    CONSTRAINT "cash_days_next_day_float_cents_check" CHECK (("next_day_float_cents" >= 0)),
    CONSTRAINT "cash_days_opening_float_cents_check" CHECK (("opening_float_cents" >= 0)),
    CONSTRAINT "cash_days_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."cash_days" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_float_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "movement_kind" "text" NOT NULL,
    "recorded_by" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cash_float_distinct_holders" CHECK (("from_user_id" <> "to_user_id")),
    CONSTRAINT "cash_float_transfers_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "cash_float_transfers_movement_kind_check" CHECK (("movement_kind" = ANY (ARRAY['float_issue'::"text", 'float_return'::"text"]))),
    CONSTRAINT "cash_float_transfers_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 250)))
);


ALTER TABLE "public"."cash_float_transfers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cash_withdrawals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "note" "text",
    "recorded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_errand_id" "uuid",
    CONSTRAINT "cash_withdrawals_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "cash_withdrawals_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 250)))
);


ALTER TABLE "public"."cash_withdrawals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_order_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "previous_status" "text" NOT NULL,
    "new_status" "text" NOT NULL,
    "changed_by" "uuid",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customer_order_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_order_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "unit_price_cents" integer NOT NULL,
    "line_total_cents" bigint NOT NULL,
    CONSTRAINT "customer_order_lines_line_total_cents_check" CHECK (("line_total_cents" >= 0)),
    CONSTRAINT "customer_order_lines_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "customer_order_lines_unit_price_cents_check" CHECK (("unit_price_cents" >= 0))
);


ALTER TABLE "public"."customer_order_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "customer_name" "text" NOT NULL,
    "customer_phone" "text" NOT NULL,
    "delivery_address" "text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "total_cents" bigint NOT NULL,
    "created_by" "uuid",
    "accepted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_orders_customer_name_check" CHECK ((("char_length"("btrim"("customer_name")) >= 2) AND ("char_length"("btrim"("customer_name")) <= 120))),
    CONSTRAINT "customer_orders_customer_phone_check" CHECK (("customer_phone" ~ '^\+?[0-9 ()-]{8,22}$'::"text")),
    CONSTRAINT "customer_orders_delivery_address_check" CHECK ((("char_length"("btrim"("delivery_address")) >= 5) AND ("char_length"("btrim"("delivery_address")) <= 300))),
    CONSTRAINT "customer_orders_notes_check" CHECK (("char_length"("notes") <= 500)),
    CONSTRAINT "customer_orders_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'accepted'::"text", 'preparing'::"text", 'ready'::"text", 'out_for_delivery'::"text", 'return_pending'::"text", 'delivered'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "customer_orders_total_cents_check" CHECK (("total_cents" >= 0))
);


ALTER TABLE "public"."customer_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_assignments" (
    "order_id" "uuid" NOT NULL,
    "route_id" "uuid" NOT NULL,
    "assigned_by" "uuid" NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stop_order" integer NOT NULL,
    CONSTRAINT "delivery_assignments_stop_order_check" CHECK (("stop_order" > 0))
);


ALTER TABLE "public"."delivery_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_cash_config" (
    "singleton" boolean DEFAULT true NOT NULL,
    "recipient_user_id" "uuid" NOT NULL,
    "configured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_cash_config_singleton_check" CHECK ("singleton")
);


ALTER TABLE "public"."delivery_cash_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_cash_handoffs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "from_user_id" "uuid" NOT NULL,
    "to_user_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "recorded_by" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cash_day_id" "uuid",
    CONSTRAINT "delivery_cash_handoffs_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "delivery_cash_handoffs_check" CHECK (("from_user_id" <> "to_user_id")),
    CONSTRAINT "delivery_cash_handoffs_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 250)))
);


ALTER TABLE "public"."delivery_cash_handoffs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_failure_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "order_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_failure_events_action_check" CHECK (("action" = ANY (ARRAY['retry'::"text", 'return'::"text"]))),
    CONSTRAINT "delivery_failure_events_reason_check" CHECK (("reason" = ANY (ARRAY['absent'::"text", 'no_answer'::"text", 'wrong_address'::"text", 'rejected'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."delivery_failure_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "reservation_id" "uuid" NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_inventory_movements_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."delivery_inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_payment_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "event_kind" "text" NOT NULL,
    "method" "text" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "cash_tendered_cents" bigint DEFAULT 0 NOT NULL,
    "change_cents" bigint DEFAULT 0 NOT NULL,
    "recorded_by" "uuid" NOT NULL,
    "cash_received_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    CONSTRAINT "delivery_payment_events_amount_cents_check" CHECK (("amount_cents" >= 0)),
    CONSTRAINT "delivery_payment_events_cash_tendered_cents_check" CHECK (("cash_tendered_cents" >= 0)),
    CONSTRAINT "delivery_payment_events_change_cents_check" CHECK (("change_cents" >= 0)),
    CONSTRAINT "delivery_payment_events_event_kind_check" CHECK (("event_kind" = ANY (ARRAY['pending'::"text", 'payment'::"text"]))),
    CONSTRAINT "delivery_payment_events_method_check" CHECK (("method" = ANY (ARRAY['pending'::"text", 'cash'::"text", 'transfer_reported'::"text"]))),
    CONSTRAINT "delivery_payment_valid_values" CHECK (((("event_kind" = 'pending'::"text") AND ("method" = 'pending'::"text") AND ("amount_cents" = 0) AND ("cash_tendered_cents" = 0) AND ("change_cents" = 0) AND ("verified_at" IS NULL) AND ("cash_received_by" IS NULL)) OR (("event_kind" = 'payment'::"text") AND ("method" = 'cash'::"text") AND ("amount_cents" > 0) AND ("cash_tendered_cents" >= "amount_cents") AND ("change_cents" = ("cash_tendered_cents" - "amount_cents")) AND ("verified_at" IS NULL) AND ("cash_received_by" IS NOT NULL)) OR (("event_kind" = 'payment'::"text") AND ("method" = 'transfer_reported'::"text") AND ("amount_cents" > 0) AND ("cash_tendered_cents" = 0) AND ("change_cents" = 0) AND ("cash_received_by" IS NULL)))),
    CONSTRAINT "delivery_payment_verify_pair" CHECK ((("verified_by" IS NULL) = ("verified_at" IS NULL)))
);


ALTER TABLE "public"."delivery_payment_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_return_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "receipt_id" "uuid" NOT NULL,
    "movement_id" "uuid" NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "qty_good" numeric NOT NULL,
    "qty_damaged" numeric NOT NULL,
    "cost_cents_per_base_unit" integer NOT NULL,
    CONSTRAINT "delivery_return_lines_check" CHECK ((("qty_good" + "qty_damaged") > (0)::numeric)),
    CONSTRAINT "delivery_return_lines_cost_cents_per_base_unit_check" CHECK (("cost_cents_per_base_unit" >= 0)),
    CONSTRAINT "delivery_return_lines_qty_damaged_check" CHECK (("qty_damaged" >= (0)::numeric)),
    CONSTRAINT "delivery_return_lines_qty_good_check" CHECK (("qty_good" >= (0)::numeric))
);


ALTER TABLE "public"."delivery_return_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_return_receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "order_id" "uuid" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."delivery_return_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_routes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'planning'::"text" NOT NULL,
    "dispatched_at" timestamp with time zone,
    "dispatched_by" "uuid",
    "completed_at" timestamp with time zone,
    CONSTRAINT "delivery_routes_label_check" CHECK ((("char_length"("btrim"("label")) >= 2) AND ("char_length"("btrim"("label")) <= 80))),
    CONSTRAINT "delivery_routes_status_check" CHECK (("status" = ANY (ARRAY['planning'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."delivery_routes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."delivery_transfer_issue_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_seq" bigint NOT NULL,
    "order_id" "uuid" NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "delivery_transfer_issue_events_action_check" CHECK (("action" = ANY (ARRAY['reported'::"text", 'resolved'::"text"]))),
    CONSTRAINT "delivery_transfer_issue_events_reason_check" CHECK ((("char_length"("btrim"("reason")) >= 3) AND ("char_length"("btrim"("reason")) <= 500)))
);


ALTER TABLE "public"."delivery_transfer_issue_events" OWNER TO "postgres";


ALTER TABLE "public"."delivery_transfer_issue_events" ALTER COLUMN "event_seq" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."delivery_transfer_issue_events_event_seq_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."driver_cash_errands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "description" "text" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "category" "text" NOT NULL,
    "status" "text" DEFAULT 'reported'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "driver_cash_errands_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "driver_cash_errands_category_check" CHECK (("category" = ANY (ARRAY['personal'::"text", 'business'::"text"]))),
    CONSTRAINT "driver_cash_errands_description_check" CHECK ((("char_length"("btrim"("description")) >= 2) AND ("char_length"("btrim"("description")) <= 250))),
    CONSTRAINT "driver_cash_errands_review_pair" CHECK ((("reviewed_by" IS NULL) = ("reviewed_at" IS NULL))),
    CONSTRAINT "driver_cash_errands_status_check" CHECK (("status" = ANY (ARRAY['reported'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."driver_cash_errands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_cash_floats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "declared_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "driver_cash_floats_amount_cents_check" CHECK (("amount_cents" >= 0))
);


ALTER TABLE "public"."driver_cash_floats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_day_settlements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "float_cents" bigint NOT NULL,
    "collected_cents" bigint NOT NULL,
    "purchases_cents" bigint NOT NULL,
    "expected_cents" bigint NOT NULL,
    "counted_cents" bigint NOT NULL,
    "difference_cents" bigint NOT NULL,
    "handoff_id" "uuid",
    "settled_by" "uuid" NOT NULL,
    "settled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "float_origin_confirmed_by" "uuid",
    "float_origin_confirmed_at" timestamp with time zone,
    CONSTRAINT "driver_day_settlements_collected_cents_check" CHECK (("collected_cents" >= 0)),
    CONSTRAINT "driver_day_settlements_counted_cents_check" CHECK (("counted_cents" >= 0)),
    CONSTRAINT "driver_day_settlements_expected_cents_check" CHECK (("expected_cents" >= 0)),
    CONSTRAINT "driver_day_settlements_float_cents_check" CHECK (("float_cents" >= 0)),
    CONSTRAINT "driver_day_settlements_purchases_cents_check" CHECK (("purchases_cents" >= 0))
);


ALTER TABLE "public"."driver_day_settlements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_float_confirmations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "cash_day_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "confirmed_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "driver_float_confirmations_amount_cents_check" CHECK (("amount_cents" >= 0))
);


ALTER TABLE "public"."driver_float_confirmations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_lots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "use_by" "date",
    "qty_received" numeric(14,4) NOT NULL,
    "qty_on_hand" numeric(14,4) NOT NULL,
    "qty_reserved" numeric(14,4) DEFAULT 0 NOT NULL,
    "cost_cents_per_base_unit" integer NOT NULL,
    "status" "text" DEFAULT 'available'::"text" NOT NULL,
    CONSTRAINT "inventory_lots_check" CHECK (("qty_reserved" <= "qty_on_hand")),
    CONSTRAINT "inventory_lots_check1" CHECK (("qty_on_hand" <= "qty_received")),
    CONSTRAINT "inventory_lots_cost_cents_per_base_unit_check" CHECK (("cost_cents_per_base_unit" >= 0)),
    CONSTRAINT "inventory_lots_qty_on_hand_check" CHECK (("qty_on_hand" >= (0)::numeric)),
    CONSTRAINT "inventory_lots_qty_received_check" CHECK (("qty_received" > (0)::numeric)),
    CONSTRAINT "inventory_lots_qty_reserved_check" CHECK (("qty_reserved" >= (0)::numeric)),
    CONSTRAINT "inventory_lots_status_check" CHECK (("status" = ANY (ARRAY['available'::"text", 'quarantine'::"text", 'blocked'::"text", 'depleted'::"text"])))
);


ALTER TABLE "public"."inventory_lots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "sale_line_id" "uuid",
    "qty_change" numeric(14,4) NOT NULL,
    "reason" "text" NOT NULL,
    "actor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_movements_qty_change_check" CHECK (("qty_change" <> (0)::numeric)),
    CONSTRAINT "inventory_movements_reason_check" CHECK (("reason" = ANY (ARRAY['sale'::"text", 'receipt'::"text", 'adjustment'::"text", 'waste'::"text", 'return'::"text"])))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operating_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "category" "text" NOT NULL,
    "payment_source" "text" NOT NULL,
    "note" "text",
    "expense_date" "date" DEFAULT (("now"() AT TIME ZONE 'America/Guatemala'::"text"))::"date" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_errand_id" "uuid",
    "cash_day_id" "uuid",
    CONSTRAINT "operating_expenses_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "operating_expenses_category_check" CHECK (("category" = ANY (ARRAY['ice'::"text", 'packaging'::"text", 'fuel'::"text", 'transport'::"text", 'utilities'::"text", 'other'::"text"]))),
    CONSTRAINT "operating_expenses_note_check" CHECK ((("note" IS NULL) OR ("char_length"("note") <= 250))),
    CONSTRAINT "operating_expenses_payment_source_check" CHECK (("payment_source" = ANY (ARRAY['business_cash'::"text", 'business_transfer'::"text", 'personal'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."operating_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_line_id" "uuid" NOT NULL,
    "lot_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "released_at" timestamp with time zone,
    CONSTRAINT "order_reservations_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."order_reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_families" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    CONSTRAINT "product_families_name_check" CHECK (("length"("btrim"("name")) > 0))
);


ALTER TABLE "public"."product_families" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "family_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "base_unit" "text" NOT NULL,
    "price_cents" integer NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "minimum_stock" numeric(14,4) DEFAULT 0 NOT NULL,
    CONSTRAINT "product_variants_base_unit_check" CHECK (("base_unit" = ANY (ARRAY['lb'::"text", 'unit'::"text", 'package'::"text"]))),
    CONSTRAINT "product_variants_minimum_stock_check" CHECK ((("minimum_stock" >= (0)::numeric) AND ("minimum_stock" <= (100000)::numeric))),
    CONSTRAINT "product_variants_name_check" CHECK (("length"("btrim"("name")) > 0)),
    CONSTRAINT "product_variants_price_cents_check" CHECK (("price_cents" >= 0))
);


ALTER TABLE "public"."product_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_preferences" (
    "user_id" "uuid" NOT NULL,
    "new_orders" boolean DEFAULT true NOT NULL,
    "deliveries" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "variant_id" "uuid" NOT NULL,
    "quantity" numeric(14,4) NOT NULL,
    "unit_price_cents" integer NOT NULL,
    "line_total_cents" bigint NOT NULL,
    CONSTRAINT "sale_lines_line_total_cents_check" CHECK (("line_total_cents" >= 0)),
    CONSTRAINT "sale_lines_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "sale_lines_unit_price_cents_check" CHECK (("unit_price_cents" >= 0))
);


ALTER TABLE "public"."sale_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sale_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "method" "text" NOT NULL,
    "amount_cents" bigint NOT NULL,
    "status" "text" NOT NULL,
    "recorded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "verified_at" timestamp with time zone,
    "verified_by" "uuid",
    CONSTRAINT "sale_payments_amount_cents_check" CHECK (("amount_cents" > 0)),
    CONSTRAINT "sale_payments_check" CHECK (((("status" = 'received'::"text") AND ("verified_at" IS NOT NULL) AND ("verified_by" IS NOT NULL)) OR (("status" = 'pending_verification'::"text") AND ("verified_at" IS NULL) AND ("verified_by" IS NULL)))),
    CONSTRAINT "sale_payments_method_check" CHECK (("method" = ANY (ARRAY['cash'::"text", 'transfer'::"text"]))),
    CONSTRAINT "sale_payments_status_check" CHECK (("status" = ANY (ARRAY['received'::"text", 'pending_verification'::"text"])))
);


ALTER TABLE "public"."sale_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "cashier_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "total_cents" bigint NOT NULL,
    "status" "text" DEFAULT 'completed'::"text" NOT NULL,
    CONSTRAINT "sales_status_check" CHECK (("status" = ANY (ARRAY['completed'::"text", 'voided'::"text"]))),
    CONSTRAINT "sales_total_cents_check" CHECK (("total_cents" >= 0))
);


ALTER TABLE "public"."sales" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_profiles" (
    "user_id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "role" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "staff_profiles_display_name_check" CHECK ((("length"("btrim"("display_name")) >= 1) AND ("length"("btrim"("display_name")) <= 120))),
    CONSTRAINT "staff_profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'counter'::"text", 'driver'::"text"])))
);


ALTER TABLE "public"."staff_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."storefront_order_requests" (
    "request_id" "uuid" NOT NULL,
    "order_id" "uuid" NOT NULL,
    "payload_fingerprint" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."storefront_order_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."storefront_rate_windows" (
    "client_hash" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "orders_count" integer NOT NULL,
    CONSTRAINT "storefront_rate_windows_client_hash_check" CHECK (("client_hash" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "storefront_rate_windows_orders_count_check" CHECK ((("orders_count" >= 1) AND ("orders_count" <= 5)))
);


ALTER TABLE "public"."storefront_rate_windows" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_catalog_events"
    ADD CONSTRAINT "admin_catalog_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_catalog_events"
    ADD CONSTRAINT "admin_catalog_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."admin_inventory_adjustment_lines"
    ADD CONSTRAINT "admin_inventory_adjustment_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_inventory_adjustments"
    ADD CONSTRAINT "admin_inventory_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_inventory_adjustments"
    ADD CONSTRAINT "admin_inventory_adjustments_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."admin_price_events"
    ADD CONSTRAINT "admin_price_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_price_events"
    ADD CONSTRAINT "admin_price_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_lot_id_key" UNIQUE ("lot_id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."admin_stock_minimum_events"
    ADD CONSTRAINT "admin_stock_minimum_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_stock_minimum_events"
    ADD CONSTRAINT "admin_stock_minimum_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."cash_close_counts"
    ADD CONSTRAINT "cash_close_counts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_close_counts"
    ADD CONSTRAINT "cash_close_counts_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."cash_days"
    ADD CONSTRAINT "cash_days_business_date_key" UNIQUE ("business_date");



ALTER TABLE ONLY "public"."cash_days"
    ADD CONSTRAINT "cash_days_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."cash_withdrawals"
    ADD CONSTRAINT "cash_withdrawals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cash_withdrawals"
    ADD CONSTRAINT "cash_withdrawals_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."customer_order_events"
    ADD CONSTRAINT "customer_order_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_order_lines"
    ADD CONSTRAINT "customer_order_lines_order_id_variant_id_key" UNIQUE ("order_id", "variant_id");



ALTER TABLE ONLY "public"."customer_order_lines"
    ADD CONSTRAINT "customer_order_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_assignments"
    ADD CONSTRAINT "delivery_assignments_pkey" PRIMARY KEY ("order_id");



ALTER TABLE ONLY "public"."delivery_assignments"
    ADD CONSTRAINT "delivery_assignments_route_id_stop_order_key" UNIQUE ("route_id", "stop_order") DEFERRABLE;



ALTER TABLE ONLY "public"."delivery_cash_config"
    ADD CONSTRAINT "delivery_cash_config_pkey" PRIMARY KEY ("singleton");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_failure_events"
    ADD CONSTRAINT "delivery_failure_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_failure_events"
    ADD CONSTRAINT "delivery_failure_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_reservation_id_key" UNIQUE ("reservation_id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_return_lines"
    ADD CONSTRAINT "delivery_return_lines_movement_id_key" UNIQUE ("movement_id");



ALTER TABLE ONLY "public"."delivery_return_lines"
    ADD CONSTRAINT "delivery_return_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_return_receipts"
    ADD CONSTRAINT "delivery_return_receipts_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."delivery_return_receipts"
    ADD CONSTRAINT "delivery_return_receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_return_receipts"
    ADD CONSTRAINT "delivery_return_receipts_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."delivery_transfer_issue_events"
    ADD CONSTRAINT "delivery_transfer_issue_events_event_seq_key" UNIQUE ("event_seq");



ALTER TABLE ONLY "public"."delivery_transfer_issue_events"
    ADD CONSTRAINT "delivery_transfer_issue_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_cash_errands"
    ADD CONSTRAINT "driver_cash_errands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_cash_errands"
    ADD CONSTRAINT "driver_cash_errands_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."driver_cash_floats"
    ADD CONSTRAINT "driver_cash_floats_one_per_day" UNIQUE ("cash_day_id", "driver_id");



ALTER TABLE ONLY "public"."driver_cash_floats"
    ADD CONSTRAINT "driver_cash_floats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_cash_floats"
    ADD CONSTRAINT "driver_cash_floats_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_cash_day_id_driver_id_key" UNIQUE ("cash_day_id", "driver_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_handoff_id_key" UNIQUE ("handoff_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_cash_day_id_driver_id_key" UNIQUE ("cash_day_id", "driver_id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."inventory_lots"
    ADD CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operating_expenses"
    ADD CONSTRAINT "operating_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operating_expenses"
    ADD CONSTRAINT "operating_expenses_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."order_reservations"
    ADD CONSTRAINT "order_reservations_order_line_id_lot_id_key" UNIQUE ("order_line_id", "lot_id");



ALTER TABLE ONLY "public"."order_reservations"
    ADD CONSTRAINT "order_reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_families"
    ADD CONSTRAINT "product_families_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."product_families"
    ADD CONSTRAINT "product_families_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_family_id_name_key" UNIQUE ("family_id", "name");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_events"
    ADD CONSTRAINT "push_events_event_key_key" UNIQUE ("event_key");



ALTER TABLE ONLY "public"."push_events"
    ADD CONSTRAINT "push_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."push_preferences"
    ADD CONSTRAINT "push_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE ("endpoint");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_lines"
    ADD CONSTRAINT "sale_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_payments"
    ADD CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sale_payments"
    ADD CONSTRAINT "sale_payments_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_request_id_key" UNIQUE ("request_id");



ALTER TABLE ONLY "public"."staff_profiles"
    ADD CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."storefront_order_requests"
    ADD CONSTRAINT "storefront_order_requests_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."storefront_order_requests"
    ADD CONSTRAINT "storefront_order_requests_pkey" PRIMARY KEY ("request_id");



ALTER TABLE ONLY "public"."storefront_rate_windows"
    ADD CONSTRAINT "storefront_rate_windows_pkey" PRIMARY KEY ("client_hash", "window_start");



CREATE INDEX "admin_inventory_adjustments_variant_idx" ON "public"."admin_inventory_adjustments" USING "btree" ("variant_id", "created_at" DESC);



CREATE INDEX "cash_close_counts_day_idx" ON "public"."cash_close_counts" USING "btree" ("cash_day_id", "created_at");



CREATE UNIQUE INDEX "cash_days_one_open_idx" ON "public"."cash_days" USING "btree" ("status") WHERE ("status" = 'open'::"text");



CREATE UNIQUE INDEX "cash_days_request_id_idx" ON "public"."cash_days" USING "btree" ("request_id");



CREATE INDEX "cash_float_transfers_day_idx" ON "public"."cash_float_transfers" USING "btree" ("cash_day_id", "created_at");



CREATE INDEX "cash_float_transfers_from_idx" ON "public"."cash_float_transfers" USING "btree" ("from_user_id", "created_at");



CREATE INDEX "cash_float_transfers_to_idx" ON "public"."cash_float_transfers" USING "btree" ("to_user_id", "created_at");



CREATE INDEX "cash_withdrawals_day_idx" ON "public"."cash_withdrawals" USING "btree" ("cash_day_id", "created_at");



CREATE UNIQUE INDEX "cash_withdrawals_source_errand_key" ON "public"."cash_withdrawals" USING "btree" ("source_errand_id");



CREATE INDEX "customer_order_events_order_idx" ON "public"."customer_order_events" USING "btree" ("order_id", "created_at" DESC);



CREATE INDEX "customer_orders_recent_idx" ON "public"."customer_orders" USING "btree" ("created_at" DESC);



CREATE INDEX "delivery_assignments_route_idx" ON "public"."delivery_assignments" USING "btree" ("route_id");



CREATE INDEX "delivery_cash_handoffs_from_idx" ON "public"."delivery_cash_handoffs" USING "btree" ("from_user_id", "created_at" DESC);



CREATE INDEX "delivery_cash_handoffs_to_idx" ON "public"."delivery_cash_handoffs" USING "btree" ("to_user_id", "created_at" DESC);



CREATE INDEX "delivery_failure_events_order_idx" ON "public"."delivery_failure_events" USING "btree" ("order_id", "created_at" DESC);



CREATE UNIQUE INDEX "delivery_payment_one_payment_per_order" ON "public"."delivery_payment_events" USING "btree" ("order_id") WHERE ("event_kind" = 'payment'::"text");



CREATE UNIQUE INDEX "delivery_payment_one_pending_per_order" ON "public"."delivery_payment_events" USING "btree" ("order_id") WHERE ("event_kind" = 'pending'::"text");



CREATE INDEX "delivery_payment_order_recent_idx" ON "public"."delivery_payment_events" USING "btree" ("order_id", "created_at" DESC);



CREATE INDEX "delivery_transfer_issue_events_payment_idx" ON "public"."delivery_transfer_issue_events" USING "btree" ("payment_id", "event_seq" DESC);



CREATE INDEX "driver_cash_floats_driver_idx" ON "public"."driver_cash_floats" USING "btree" ("driver_id", "declared_at");



CREATE INDEX "inventory_lots_sellable_idx" ON "public"."inventory_lots" USING "btree" ("variant_id", "use_by", "received_at", "id") WHERE ("status" = 'available'::"text");



CREATE UNIQUE INDEX "operating_expenses_source_errand_key" ON "public"."operating_expenses" USING "btree" ("source_errand_id");



CREATE INDEX "order_reservations_active_idx" ON "public"."order_reservations" USING "btree" ("lot_id") WHERE ("released_at" IS NULL);



CREATE INDEX "push_events_pending_idx" ON "public"."push_events" USING "btree" ("created_at") WHERE ("status" = ANY (ARRAY['pending'::"text", 'failed'::"text"]));



CREATE INDEX "push_events_recovery_idx" ON "public"."push_events" USING "btree" ("claimed_at") WHERE ("status" = 'processing'::"text");



CREATE INDEX "push_subscriptions_user_idx" ON "public"."push_subscriptions" USING "btree" ("user_id");



CREATE INDEX "sale_payments_sale_idx" ON "public"."sale_payments" USING "btree" ("sale_id");



CREATE INDEX "storefront_rate_windows_cleanup_idx" ON "public"."storefront_rate_windows" USING "btree" ("window_start");



CREATE OR REPLACE TRIGGER "customer_order_status_audit" AFTER INSERT OR UPDATE OF "status" ON "public"."customer_orders" FOR EACH ROW EXECUTE FUNCTION "public"."log_customer_order_status"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."cash_float_transfers" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."cash_withdrawals" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."delivery_cash_handoffs" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."delivery_payment_events" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."driver_cash_errands" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."driver_cash_floats" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."driver_day_settlements" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."driver_float_confirmations" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."operating_expenses" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_cash_day_guard" BEFORE INSERT OR DELETE OR UPDATE ON "public"."sale_payments" FOR EACH ROW EXECUTE FUNCTION "public"."guard_cash_day_entry"();



CREATE OR REPLACE TRIGGER "trg_no_float_after_settlement" BEFORE INSERT OR UPDATE ON "public"."driver_cash_floats" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_post_settlement_cash_entries"();



CREATE OR REPLACE TRIGGER "trg_no_purchase_after_settlement" BEFORE INSERT OR UPDATE ON "public"."driver_cash_errands" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_post_settlement_cash_entries"();



CREATE OR REPLACE TRIGGER "trg_notify_push_event" AFTER INSERT ON "public"."push_events" FOR EACH ROW EXECUTE FUNCTION "public"."notify_push_event"();



CREATE OR REPLACE TRIGGER "trg_queue_delivery_push" AFTER UPDATE OF "dispatched_at" ON "public"."delivery_routes" FOR EACH ROW WHEN ((("old"."dispatched_at" IS NULL) AND ("new"."dispatched_at" IS NOT NULL))) EXECUTE FUNCTION "public"."queue_delivery_push"();



CREATE OR REPLACE TRIGGER "trg_queue_new_order_push" AFTER INSERT ON "public"."customer_orders" FOR EACH ROW WHEN (("new"."status" = 'received'::"text")) EXECUTE FUNCTION "public"."queue_new_order_push"();



ALTER TABLE ONLY "public"."admin_catalog_events"
    ADD CONSTRAINT "admin_catalog_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."admin_catalog_events"
    ADD CONSTRAINT "admin_catalog_events_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."product_families"("id");



ALTER TABLE ONLY "public"."admin_catalog_events"
    ADD CONSTRAINT "admin_catalog_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."admin_inventory_adjustment_lines"
    ADD CONSTRAINT "admin_inventory_adjustment_lines_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "public"."admin_inventory_adjustments"("id");



ALTER TABLE ONLY "public"."admin_inventory_adjustment_lines"
    ADD CONSTRAINT "admin_inventory_adjustment_lines_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."admin_inventory_adjustments"
    ADD CONSTRAINT "admin_inventory_adjustments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."admin_inventory_adjustments"
    ADD CONSTRAINT "admin_inventory_adjustments_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."admin_price_events"
    ADD CONSTRAINT "admin_price_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."admin_price_events"
    ADD CONSTRAINT "admin_price_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."admin_purchase_events"
    ADD CONSTRAINT "admin_purchase_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."admin_stock_minimum_events"
    ADD CONSTRAINT "admin_stock_minimum_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."admin_stock_minimum_events"
    ADD CONSTRAINT "admin_stock_minimum_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."cash_close_counts"
    ADD CONSTRAINT "cash_close_counts_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."cash_close_counts"
    ADD CONSTRAINT "cash_close_counts_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_days"
    ADD CONSTRAINT "cash_days_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_days"
    ADD CONSTRAINT "cash_days_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_float_transfers"
    ADD CONSTRAINT "cash_float_transfers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_withdrawals"
    ADD CONSTRAINT "cash_withdrawals_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."cash_withdrawals"
    ADD CONSTRAINT "cash_withdrawals_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."cash_withdrawals"
    ADD CONSTRAINT "cash_withdrawals_source_errand_id_fkey" FOREIGN KEY ("source_errand_id") REFERENCES "public"."driver_cash_errands"("id");



ALTER TABLE ONLY "public"."customer_order_events"
    ADD CONSTRAINT "customer_order_events_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."customer_order_events"
    ADD CONSTRAINT "customer_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."customer_order_lines"
    ADD CONSTRAINT "customer_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."customer_order_lines"
    ADD CONSTRAINT "customer_order_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."delivery_assignments"
    ADD CONSTRAINT "delivery_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_assignments"
    ADD CONSTRAINT "delivery_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_assignments"
    ADD CONSTRAINT "delivery_assignments_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."delivery_routes"("id");



ALTER TABLE ONLY "public"."delivery_cash_config"
    ADD CONSTRAINT "delivery_cash_config_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_cash_handoffs"
    ADD CONSTRAINT "delivery_cash_handoffs_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_failure_events"
    ADD CONSTRAINT "delivery_failure_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_failure_events"
    ADD CONSTRAINT "delivery_failure_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_inventory_movements"
    ADD CONSTRAINT "delivery_inventory_movements_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "public"."order_reservations"("id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_cash_received_by_fkey" FOREIGN KEY ("cash_received_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_payment_events"
    ADD CONSTRAINT "delivery_payment_events_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_return_lines"
    ADD CONSTRAINT "delivery_return_lines_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."delivery_return_lines"
    ADD CONSTRAINT "delivery_return_lines_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "public"."delivery_inventory_movements"("id");



ALTER TABLE ONLY "public"."delivery_return_lines"
    ADD CONSTRAINT "delivery_return_lines_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "public"."delivery_return_receipts"("id");



ALTER TABLE ONLY "public"."delivery_return_receipts"
    ADD CONSTRAINT "delivery_return_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_return_receipts"
    ADD CONSTRAINT "delivery_return_receipts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_dispatched_by_fkey" FOREIGN KEY ("dispatched_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_routes"
    ADD CONSTRAINT "delivery_routes_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_transfer_issue_events"
    ADD CONSTRAINT "delivery_transfer_issue_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."delivery_transfer_issue_events"
    ADD CONSTRAINT "delivery_transfer_issue_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



ALTER TABLE ONLY "public"."delivery_transfer_issue_events"
    ADD CONSTRAINT "delivery_transfer_issue_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."delivery_payment_events"("id");



ALTER TABLE ONLY "public"."driver_cash_errands"
    ADD CONSTRAINT "driver_cash_errands_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."driver_cash_errands"
    ADD CONSTRAINT "driver_cash_errands_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_cash_errands"
    ADD CONSTRAINT "driver_cash_errands_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_cash_floats"
    ADD CONSTRAINT "driver_cash_floats_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."driver_cash_floats"
    ADD CONSTRAINT "driver_cash_floats_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_float_origin_confirmed_by_fkey" FOREIGN KEY ("float_origin_confirmed_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_handoff_id_fkey" FOREIGN KEY ("handoff_id") REFERENCES "public"."delivery_cash_handoffs"("id");



ALTER TABLE ONLY "public"."driver_day_settlements"
    ADD CONSTRAINT "driver_day_settlements_settled_by_fkey" FOREIGN KEY ("settled_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."driver_float_confirmations"
    ADD CONSTRAINT "driver_float_confirmations_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."inventory_lots"
    ADD CONSTRAINT "inventory_lots_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_sale_line_id_fkey" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id");



ALTER TABLE ONLY "public"."operating_expenses"
    ADD CONSTRAINT "operating_expenses_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."operating_expenses"
    ADD CONSTRAINT "operating_expenses_cash_day_id_fkey" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id");



ALTER TABLE ONLY "public"."operating_expenses"
    ADD CONSTRAINT "operating_expenses_source_errand_id_fkey" FOREIGN KEY ("source_errand_id") REFERENCES "public"."driver_cash_errands"("id");



ALTER TABLE ONLY "public"."order_reservations"
    ADD CONSTRAINT "order_reservations_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id");



ALTER TABLE ONLY "public"."order_reservations"
    ADD CONSTRAINT "order_reservations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "public"."customer_order_lines"("id");



ALTER TABLE ONLY "public"."product_variants"
    ADD CONSTRAINT "product_variants_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."product_families"("id");



ALTER TABLE ONLY "public"."push_events"
    ADD CONSTRAINT "push_events_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."push_preferences"
    ADD CONSTRAINT "push_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sale_lines"
    ADD CONSTRAINT "sale_lines_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id");



ALTER TABLE ONLY "public"."sale_lines"
    ADD CONSTRAINT "sale_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id");



ALTER TABLE ONLY "public"."sale_payments"
    ADD CONSTRAINT "sale_payments_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."sale_payments"
    ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id");



ALTER TABLE ONLY "public"."sale_payments"
    ADD CONSTRAINT "sale_payments_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."sales"
    ADD CONSTRAINT "sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."staff_profiles"("user_id");



ALTER TABLE ONLY "public"."staff_profiles"
    ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."storefront_order_requests"
    ADD CONSTRAINT "storefront_order_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id");



CREATE POLICY "admin_adjustment_lines_read" ON "public"."admin_inventory_adjustment_lines" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "admin_adjustments_read" ON "public"."admin_inventory_adjustments" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."admin_catalog_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_catalog_events_read" ON "public"."admin_catalog_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "admin_history_catalog_read" ON "public"."admin_catalog_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "admin_history_price_read" ON "public"."admin_price_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "admin_history_purchase_read" ON "public"."admin_purchase_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."admin_inventory_adjustment_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_inventory_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_price_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_price_read" ON "public"."admin_price_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."admin_purchase_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_purchase_read" ON "public"."admin_purchase_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."admin_stock_minimum_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "assignments_staff_read" ON "public"."delivery_assignments" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]) OR (EXISTS ( SELECT 1
   FROM "public"."delivery_routes" "dr"
  WHERE (("dr"."id" = "delivery_assignments"."route_id") AND ("dr"."driver_id" = "auth"."uid"()) AND "public"."staff_has_role"(ARRAY['admin'::"text", 'driver'::"text"]))))));



ALTER TABLE "public"."cash_close_counts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cash_close_counts_staff_read" ON "public"."cash_close_counts" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."cash_days" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cash_days_driver_open_read" ON "public"."cash_days" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['driver'::"text"]) AND ("status" = 'open'::"text") AND ("business_date" = (("now"() AT TIME ZONE 'America/Guatemala'::"text"))::"date")));



CREATE POLICY "cash_days_staff_read" ON "public"."cash_days" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."cash_float_transfers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cash_float_transfers_staff_read" ON "public"."cash_float_transfers" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."cash_withdrawals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cash_withdrawals_read" ON "public"."cash_withdrawals" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."customer_order_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customer_order_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customer_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_cash_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_cash_handoffs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_cash_handoffs_admin_read" ON "public"."delivery_cash_handoffs" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."delivery_failure_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_inventory_admin_read" ON "public"."delivery_inventory_movements" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."delivery_inventory_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_payment_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_payment_read" ON "public"."delivery_payment_events" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]) OR ("public"."staff_has_role"(ARRAY['driver'::"text"]) AND (EXISTS ( SELECT 1
   FROM ("public"."delivery_assignments" "a"
     JOIN "public"."delivery_routes" "dr" ON (("dr"."id" = "a"."route_id")))
  WHERE (("a"."order_id" = "delivery_payment_events"."order_id") AND ("dr"."driver_id" = "auth"."uid"())))))));



ALTER TABLE "public"."delivery_return_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_return_receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."delivery_routes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "delivery_transfer_issue_admin_read" ON "public"."delivery_transfer_issue_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."delivery_transfer_issue_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_cash_errands" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "driver_cash_errands_read" ON "public"."driver_cash_errands" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"])));



ALTER TABLE "public"."driver_cash_floats" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "driver_cash_floats_read" ON "public"."driver_cash_floats" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"])));



ALTER TABLE "public"."driver_day_settlements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "driver_day_settlements_admin_read" ON "public"."driver_day_settlements" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "driver_float_confirmation_admin_read" ON "public"."driver_float_confirmations" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."driver_float_confirmations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "failure_staff_read" ON "public"."delivery_failure_events" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]) OR ("public"."staff_has_role"(ARRAY['driver'::"text"]) AND (EXISTS ( SELECT 1
   FROM ("public"."delivery_assignments" "a"
     JOIN "public"."delivery_routes" "r" ON (("r"."id" = "a"."route_id")))
  WHERE (("a"."order_id" = "delivery_failure_events"."order_id") AND ("r"."driver_id" = "auth"."uid"())))))));



CREATE POLICY "family_staff_read" ON "public"."product_families" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text", 'driver'::"text"]));



ALTER TABLE "public"."inventory_lots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lines_counter_read" ON "public"."sale_lines" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "lots_counter_read" ON "public"."inventory_lots" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "movements_admin_read" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."operating_expenses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "operating_expenses_admin_read" ON "public"."operating_expenses" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



CREATE POLICY "order_events_staff_read" ON "public"."customer_order_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "order_lines_staff_read" ON "public"."customer_order_lines" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."order_reservations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_reservations_staff_read" ON "public"."order_reservations" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "orders_staff_read" ON "public"."customer_orders" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "payments_counter_read" ON "public"."sale_payments" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



ALTER TABLE "public"."product_families" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_variants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."push_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "push_preferences_own_insert" ON "public"."push_preferences" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "push_preferences_own_select" ON "public"."push_preferences" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "push_preferences_own_update" ON "public"."push_preferences" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "push_subscriptions_delete" ON "public"."push_subscriptions" FOR DELETE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "push_subscriptions_insert" ON "public"."push_subscriptions" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "push_subscriptions_select" ON "public"."push_subscriptions" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "push_subscriptions_update" ON "public"."push_subscriptions" FOR UPDATE TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "return_lines_staff_read" ON "public"."delivery_return_lines" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "returns_staff_read" ON "public"."delivery_return_receipts" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "routes_staff_read" ON "public"."delivery_routes" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]) OR (("driver_id" = "auth"."uid"()) AND "public"."staff_has_role"(ARRAY['admin'::"text", 'driver'::"text"]))));



ALTER TABLE "public"."sale_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sale_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sales_counter_read" ON "public"."sales" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]));



CREATE POLICY "staff_dispatch_read" ON "public"."staff_profiles" FOR SELECT TO "authenticated" USING (("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text"]) AND ("active" = true) AND ("role" = ANY (ARRAY['admin'::"text", 'driver'::"text"]))));



ALTER TABLE "public"."staff_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff_self_read" ON "public"."staff_profiles" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "stock_minimum_events_admin_read" ON "public"."admin_stock_minimum_events" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text"]));



ALTER TABLE "public"."storefront_order_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."storefront_rate_windows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "variants_staff_read" ON "public"."product_variants" FOR SELECT TO "authenticated" USING ("public"."staff_has_role"(ARRAY['admin'::"text", 'counter'::"text", 'driver'::"text"]));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_and_prepare_pilot_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_and_prepare_pilot_order"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."accept_pilot_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_pilot_order"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_catalog_change"("p_request_id" "uuid", "p_action" "text", "p_family_id" "uuid", "p_variant_id" "uuid", "p_name" "text", "p_base_unit" "text", "p_price_cents" integer, "p_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_catalog_change"("p_request_id" "uuid", "p_action" "text", "p_family_id" "uuid", "p_variant_id" "uuid", "p_name" "text", "p_base_unit" "text", "p_price_cents" integer, "p_active" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_record_expense"("p_request_id" "uuid", "p_amount_cents" bigint, "p_category" "text", "p_payment_source" "text", "p_note" "text", "p_expense_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_record_expense"("p_request_id" "uuid", "p_amount_cents" bigint, "p_category" "text", "p_payment_source" "text", "p_note" "text", "p_expense_date" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_reduce_inventory"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_reason" "text", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reduce_inventory"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_reason" "text", "p_note" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_register_purchase"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_unit_cost_cents" integer, "p_use_by" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_register_purchase"("p_request_id" "uuid", "p_variant_id" "uuid", "p_quantity" numeric, "p_unit_cost_cents" integer, "p_use_by" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_set_stock_minimum"("p_request_id" "uuid", "p_variant_id" "uuid", "p_minimum" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_stock_minimum"("p_request_id" "uuid", "p_variant_id" "uuid", "p_minimum" numeric) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_update_price"("p_request_id" "uuid", "p_variant_id" "uuid", "p_new_price_cents" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_price"("p_request_id" "uuid", "p_variant_id" "uuid", "p_new_price_cents" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."advance_pilot_order"("p_order_id" "uuid", "p_expected_status" "text", "p_new_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."advance_pilot_order"("p_order_id" "uuid", "p_expected_status" "text", "p_new_status" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."cancel_order_and_cleanup"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_order_and_cleanup"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."cancel_pilot_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_pilot_order"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."cash_day_reconciliation"("p_cash_day_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cash_day_reconciliation"("p_cash_day_id" "uuid") TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."push_events" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_push_events"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_push_events"("p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint, "p_reviewed_balance" "jsonb", "p_confirm_float_origin" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."close_cash_day"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_counted_cents" bigint, "p_next_day_float_cents" bigint, "p_reviewed_balance" "jsonb", "p_confirm_float_origin" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."complete_push_event"("p_event_id" "uuid", "p_claim_token" "uuid", "p_success" boolean, "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_push_event"("p_event_id" "uuid", "p_claim_token" "uuid", "p_success" boolean, "p_error" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_delivery"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_delivery"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_delivery_return"("p_order_id" "uuid", "p_request_id" "uuid", "p_lines" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_delivery_return"("p_order_id" "uuid", "p_request_id" "uuid", "p_lines" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_delivery_with_payment"("p_order_id" "uuid", "p_request_id" "uuid", "p_method" "text", "p_cash_tendered_cents" bigint, "p_cash_received_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_delivery_with_payment"("p_order_id" "uuid", "p_request_id" "uuid", "p_method" "text", "p_cash_tendered_cents" bigint, "p_cash_received_by" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."confirm_driver_float"("p_request_id" "uuid", "p_driver_id" "uuid", "p_amount_cents" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_driver_float"("p_request_id" "uuid", "p_driver_id" "uuid", "p_amount_cents" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."declare_driver_cash_float"("p_request_id" "uuid", "p_amount_cents" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."declare_driver_cash_float"("p_request_id" "uuid", "p_amount_cents" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delivery_cash_overview"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delivery_cash_overview"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."delivery_cash_positions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delivery_cash_positions"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."dispatch_delivery_route"("p_route_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispatch_delivery_route"("p_route_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."driver_day_settlement_preview"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_day_settlement_preview"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."driver_money_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_money_summary"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."driver_ready_orders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_ready_orders"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."driver_reorder_active_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_reorder_active_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."driver_take_ready_orders"("p_request_id" "uuid", "p_order_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_take_ready_orders"("p_request_id" "uuid", "p_order_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."finance_period_summary"("p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finance_period_summary"("p_from" "date", "p_to" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."guard_cash_day_entry"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."log_customer_order_status"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."my_delivery_orders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_delivery_orders"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."my_delivery_orders_v2"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_delivery_orders_v2"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."notify_push_event"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."open_cash_day"("p_request_id" "uuid", "p_opening_float_cents" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."open_cash_day"("p_request_id" "uuid", "p_opening_float_cents" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."owner_growth_dashboard"("p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."owner_growth_dashboard"("p_from" "date", "p_to" "date") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."pending_delivery_returns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pending_delivery_returns"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."prepare_and_dispatch_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prepare_and_dispatch_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."prepare_delivery_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prepare_delivery_outing"("p_request_id" "uuid", "p_driver_id" "uuid", "p_order_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."queue_delivery_push"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."queue_new_order_push"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."record_cash_withdrawal"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_amount_cents" bigint, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_cash_withdrawal"("p_cash_day_id" "uuid", "p_request_id" "uuid", "p_amount_cents" bigint, "p_note" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_delivery_cash_handoff"("p_request_id" "uuid", "p_from_user_id" "uuid", "p_amount_cents" bigint, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_delivery_cash_handoff"("p_request_id" "uuid", "p_from_user_id" "uuid", "p_amount_cents" bigint, "p_note" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."record_sale_payment"("p_request_id" "uuid", "p_sale_id" "uuid", "p_method" "text", "p_amount_cents" bigint, "p_pending_verification" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_sale_payment"("p_request_id" "uuid", "p_sale_id" "uuid", "p_method" "text", "p_amount_cents" bigint, "p_pending_verification" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."register_counter_sale"("p_request_id" "uuid", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_counter_sale"("p_request_id" "uuid", "p_items" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."reorder_delivery_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reorder_delivery_route"("p_route_id" "uuid", "p_order_ids" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."report_delivery_failure"("p_order_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."report_delivery_failure"("p_order_id" "uuid", "p_request_id" "uuid", "p_action" "text", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."report_driver_cash_errand"("p_request_id" "uuid", "p_description" "text", "p_amount_cents" bigint, "p_category" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."report_driver_cash_errand"("p_request_id" "uuid", "p_description" "text", "p_amount_cents" bigint, "p_category" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."review_driver_cash_errand"("p_errand_id" "uuid", "p_approve" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."review_driver_cash_errand"("p_errand_id" "uuid", "p_approve" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_delivery_transfer_issue"("p_order_id" "uuid", "p_action" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_delivery_transfer_issue"("p_order_id" "uuid", "p_action" "text", "p_reason" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint, "p_reviewed_preview" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_driver_day"("p_request_id" "uuid", "p_cash_day_id" "uuid", "p_driver_id" "uuid", "p_counted_cents" bigint, "p_reviewed_preview" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."staff_has_role"("allowed_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."staff_has_role"("allowed_roles" "text"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."storefront_catalog"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."storefront_catalog"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."submit_pilot_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_pilot_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."submit_storefront_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb", "p_client_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_storefront_order"("p_request_id" "uuid", "p_customer_name" "text", "p_customer_phone" "text", "p_delivery_address" "text", "p_notes" "text", "p_items" "jsonb", "p_client_hash" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_driver_day_purchases"("p_cash_day_id" "uuid") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."verify_delivery_transfer"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_delivery_transfer"("p_order_id" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."verify_transfer_payment"("p_payment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_transfer_payment"("p_payment_id" "uuid") TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_catalog_events" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_catalog_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_inventory_adjustment_lines" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_inventory_adjustment_lines" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_inventory_adjustments" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_inventory_adjustments" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_price_events" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_price_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_purchase_events" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_purchase_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_stock_minimum_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_stock_minimum_events" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."admin_stock_minimum_events" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."cash_close_counts" TO "service_role";
GRANT SELECT ON TABLE "public"."cash_close_counts" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."cash_days" TO "service_role";
GRANT SELECT ON TABLE "public"."cash_days" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."cash_float_transfers" TO "service_role";
GRANT SELECT ON TABLE "public"."cash_float_transfers" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."cash_withdrawals" TO "service_role";
GRANT SELECT ON TABLE "public"."cash_withdrawals" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."customer_order_events" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_order_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."customer_order_lines" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_order_lines" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."customer_orders" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_orders" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_assignments" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_assignments" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_cash_config" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_cash_handoffs" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_cash_handoffs" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_failure_events" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_failure_events" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_failure_events" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_inventory_movements" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_inventory_movements" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_payment_events" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_payment_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_lines" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_lines" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_lines" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_receipts" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_receipts" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_return_receipts" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_routes" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_routes" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."delivery_transfer_issue_events" TO "service_role";
GRANT SELECT ON TABLE "public"."delivery_transfer_issue_events" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."driver_cash_errands" TO "service_role";
GRANT SELECT ON TABLE "public"."driver_cash_errands" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."driver_cash_floats" TO "service_role";
GRANT SELECT ON TABLE "public"."driver_cash_floats" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."driver_day_settlements" TO "service_role";
GRANT SELECT ON TABLE "public"."driver_day_settlements" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."driver_float_confirmations" TO "service_role";
GRANT SELECT ON TABLE "public"."driver_float_confirmations" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_lots" TO "service_role";
GRANT SELECT ON TABLE "public"."inventory_lots" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."inventory_movements" TO "service_role";
GRANT SELECT ON TABLE "public"."inventory_movements" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."operating_expenses" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."operating_expenses" TO "authenticated";
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."operating_expenses" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."order_reservations" TO "service_role";
GRANT SELECT ON TABLE "public"."order_reservations" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."product_families" TO "service_role";
GRANT SELECT ON TABLE "public"."product_families" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."product_variants" TO "service_role";
GRANT SELECT ON TABLE "public"."product_variants" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."push_preferences" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."push_preferences" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."push_subscriptions" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."push_subscriptions" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sale_lines" TO "service_role";
GRANT SELECT ON TABLE "public"."sale_lines" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sale_payments" TO "service_role";
GRANT SELECT ON TABLE "public"."sale_payments" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."sales" TO "service_role";
GRANT SELECT ON TABLE "public"."sales" TO "authenticated";



GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."staff_profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."staff_profiles" TO "authenticated";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."storefront_order_requests" TO "service_role";



GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."storefront_rate_windows" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";







