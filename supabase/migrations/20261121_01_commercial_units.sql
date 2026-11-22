-- Inmensa Mar: expanded commercial units (no implicit cross-unit conversion).
-- The stock quantity for every presentation remains expressed in its own base unit.
-- A box has its own stock and price; it is not converted to pounds automatically.
BEGIN;

ALTER TABLE public.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_base_unit_check;
ALTER TABLE public.product_variants
  ADD CONSTRAINT product_variants_base_unit_check
  CHECK (base_unit IN ('lb','unit','dozen','package','box'));

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
  IF p_family_id IS NULL OR p_variant_id IS NOT NULL OR p_base_unit NOT IN ('lb','unit','dozen','package','box') OR p_price_cents IS NULL OR p_price_cents<0 THEN RAISE EXCEPTION 'Invalid variant'; END IF;
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
 IF v_unit <> 'lb' AND p_quantity<>trunc(p_quantity) THEN RAISE EXCEPTION 'Whole units required'; END IF;
 INSERT INTO public.inventory_lots(variant_id,qty_received,qty_on_hand,qty_reserved,cost_cents_per_base_unit,status,use_by)
 VALUES(p_variant_id,p_quantity,p_quantity,0,p_unit_cost_cents,'available',p_use_by) RETURNING id INTO v_lot;
 INSERT INTO public.admin_purchase_events(request_id,lot_id,variant_id,quantity,unit_cost_cents,use_by,actor_id)
 VALUES(p_request_id,v_lot,p_variant_id,p_quantity,p_unit_cost_cents,p_use_by,v_actor);
 RETURN v_lot;
END; $$;

CREATE OR REPLACE FUNCTION "public"."admin_set_stock_minimum"("p_request_id" "uuid", "p_variant_id" "uuid", "p_minimum" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_old numeric; v_unit text; v_prior public.admin_stock_minimum_events%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL OR NOT public.staff_has_role(ARRAY['admin']) THEN RAISE EXCEPTION 'Not authorized'; END IF;
 IF p_request_id IS NULL OR p_variant_id IS NULL OR p_minimum IS NULL OR p_minimum < 0 OR p_minimum > 100000 OR scale(p_minimum)>4 THEN RAISE EXCEPTION 'Invalid minimum'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 97));
 SELECT * INTO v_prior FROM public.admin_stock_minimum_events WHERE request_id=p_request_id;
 IF FOUND THEN
  IF v_prior.variant_id<>p_variant_id OR v_prior.new_minimum<>p_minimum OR v_prior.actor_id<>auth.uid() THEN RAISE EXCEPTION 'Request ID already used'; END IF;
  RETURN;
 END IF;
 SELECT minimum_stock,base_unit INTO v_old,v_unit FROM public.product_variants WHERE id=p_variant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
 IF v_unit <> 'lb' AND p_minimum <> trunc(p_minimum) THEN RAISE EXCEPTION 'Whole units required'; END IF;
 UPDATE public.product_variants SET minimum_stock=p_minimum WHERE id=p_variant_id;
 INSERT INTO public.admin_stock_minimum_events(request_id,variant_id,old_minimum,new_minimum,actor_id)
 VALUES(p_request_id,p_variant_id,v_old,p_minimum,auth.uid());
END;$$;

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
    if v_variant.base_unit <> 'lb' and v_item.quantity <> trunc(v_item.quantity) then
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
    if v_variant.base_unit <> 'lb' and v_item.quantity <> trunc(v_item.quantity) then
      raise exception 'Whole units required'; end if;
    v_amount := round(v_item.quantity * v_variant.price_cents)::bigint;
    v_total := v_total + v_amount;
    insert into public.customer_order_lines(order_id,variant_id,quantity,unit_price_cents,line_total_cents)
      values (v_order,v_item.variant_id,v_item.quantity,v_variant.price_cents,v_amount);
  end loop;
  update public.customer_orders set total_cents=v_total where id=v_order;
  return v_order;
end; $_$;

COMMIT;
