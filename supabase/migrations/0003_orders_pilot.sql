-- Inmensa Mar: pedidos internos de prueba. No habilita envios anonimos.
begin;

create table public.customer_orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  customer_name text not null check (char_length(btrim(customer_name)) between 2 and 120),
  customer_phone text not null check (customer_phone ~ '^\+?[0-9 ()-]{8,22}$'),
  delivery_address text not null check (char_length(btrim(delivery_address)) between 5 and 300),
  notes text not null default '' check (char_length(notes) <= 500),
  status text not null default 'received' check (status in ('received','accepted','preparing','ready','out_for_delivery','delivered','cancelled')),
  total_cents bigint not null check (total_cents >= 0),
  created_by uuid not null references auth.users(id),
  accepted_by uuid references public.staff_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customer_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.customer_orders(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id),
  quantity numeric(14,4) not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  unique(order_id,variant_id)
);

create table public.order_reservations (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid not null references public.customer_order_lines(id),
  lot_id uuid not null references public.inventory_lots(id),
  quantity numeric(14,4) not null check (quantity > 0),
  released_at timestamptz,
  unique(order_line_id,lot_id)
);
create index customer_orders_recent_idx on public.customer_orders(created_at desc);
create index order_reservations_active_idx on public.order_reservations(lot_id) where released_at is null;

revoke all on public.customer_orders, public.customer_order_lines, public.order_reservations from anon,authenticated;
grant select on public.customer_orders, public.customer_order_lines, public.order_reservations to authenticated;
alter table public.customer_orders enable row level security;
alter table public.customer_order_lines enable row level security;
alter table public.order_reservations enable row level security;
create policy orders_staff_read on public.customer_orders for select to authenticated
 using (public.staff_has_role(array['admin','counter']));
create policy order_lines_staff_read on public.customer_order_lines for select to authenticated
 using (public.staff_has_role(array['admin','counter']));
create policy order_reservations_staff_read on public.order_reservations for select to authenticated
 using (public.staff_has_role(array['admin','counter']));

-- Prueba interna: solo personal autorizado puede generar pedidos.
create function public.submit_pilot_order(p_request_id uuid,p_customer_name text,p_customer_phone text,p_delivery_address text,p_notes text,p_items jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
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
end; $$;
revoke all on function public.submit_pilot_order(uuid,text,text,text,text,jsonb) from public,anon;
grant execute on function public.submit_pilot_order(uuid,text,text,text,text,jsonb) to authenticated;

-- La reserva se realiza al aceptar; no se descuenta qty_on_hand.
create function public.accept_pilot_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.accept_pilot_order(uuid) from public,anon;
grant execute on function public.accept_pilot_order(uuid) to authenticated;

-- Cancelar libera las reservas sin afectar existencias fisicas.
create function public.cancel_pilot_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order public.customer_orders%rowtype;
  v_res record;
begin
  if not public.staff_has_role(array['admin','counter']) then raise exception 'Not authorized'; end if;
  select * into v_order from public.customer_orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status='cancelled' then return; end if;
  if v_order.status not in ('received','accepted') then raise exception 'Order cannot be cancelled here'; end if;
  for v_res in select r.id,r.lot_id,r.quantity from public.order_reservations r
    join public.customer_order_lines l on l.id=r.order_line_id
    where l.order_id=p_order_id and r.released_at is null order by r.lot_id for update of r loop
    update public.inventory_lots set qty_reserved=qty_reserved-v_res.quantity where id=v_res.lot_id;
    update public.order_reservations set released_at=now() where id=v_res.id;
  end loop;
  update public.customer_orders set status='cancelled',updated_at=now() where id=p_order_id;
end; $$;
revoke all on function public.cancel_pilot_order(uuid) from public,anon;
grant execute on function public.cancel_pilot_order(uuid) to authenticated;
commit;
