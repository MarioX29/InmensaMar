-- Inmensa Mar: initial operational schema. Run only on a new Supabase project.
begin;

create extension if not exists pgcrypto;

create table public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role text not null check (role in ('admin','counter','driver')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.product_families (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0)
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.product_families(id),
  name text not null check (length(btrim(name)) > 0),
  base_unit text not null check (base_unit in ('lb','unit','package')),
  price_cents integer not null check (price_cents >= 0),
  active boolean not null default true,
  unique(family_id,name)
);

create table public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id),
  received_at timestamptz not null default now(),
  use_by date,
  qty_received numeric(14,4) not null check (qty_received > 0),
  qty_on_hand numeric(14,4) not null check (qty_on_hand >= 0),
  qty_reserved numeric(14,4) not null default 0 check (qty_reserved >= 0),
  cost_cents_per_base_unit integer not null check (cost_cents_per_base_unit >= 0),
  status text not null default 'available' check (status in ('available','quarantine','blocked','depleted')),
  check (qty_reserved <= qty_on_hand),
  check (qty_on_hand <= qty_received)
);
create index inventory_lots_sellable_idx on public.inventory_lots
  (variant_id, use_by, received_at, id) where status = 'available';

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_fingerprint text not null,
  cashier_id uuid not null references public.staff_profiles(user_id),
  created_at timestamptz not null default now(),
  total_cents bigint not null check (total_cents >= 0),
  status text not null default 'completed' check (status in ('completed','voided'))
);

create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id),
  variant_id uuid not null references public.product_variants(id),
  quantity numeric(14,4) not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0)
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.inventory_lots(id),
  sale_line_id uuid references public.sale_lines(id),
  qty_change numeric(14,4) not null check (qty_change <> 0),
  reason text not null check (reason in ('sale','receipt','adjustment','waste','return')),
  actor_id uuid references public.staff_profiles(user_id),
  created_at timestamptz not null default now()
);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  sale_id uuid not null references public.sales(id),
  method text not null check (method in ('cash','transfer')),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null check (status in ('received','pending_verification')),
  recorded_by uuid not null references public.staff_profiles(user_id),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid references public.staff_profiles(user_id),
  check ((status = 'received' and verified_at is not null and verified_by is not null)
      or (status = 'pending_verification' and verified_at is null and verified_by is null))
);
create index sale_payments_sale_idx on public.sale_payments(sale_id);

-- Deny direct writes: mutations must pass through audited server-side functions.
revoke all on public.staff_profiles, public.product_families, public.product_variants,
 public.inventory_lots, public.sales, public.sale_lines, public.inventory_movements,
 public.sale_payments from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.staff_profiles, public.product_families, public.product_variants,
 public.inventory_lots, public.sales, public.sale_lines, public.inventory_movements,
 public.sale_payments to authenticated;

alter table public.staff_profiles enable row level security;
alter table public.product_families enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory_lots enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.sale_payments enable row level security;

create function public.staff_has_role(allowed_roles text[])
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.staff_profiles s
    where s.user_id = (select auth.uid()) and s.active and s.role = any(allowed_roles)
  );
$$;
revoke all on function public.staff_has_role(text[]) from public, anon;
grant execute on function public.staff_has_role(text[]) to authenticated;

create policy staff_self_read on public.staff_profiles for select to authenticated
  using (user_id = (select auth.uid()));
create policy family_staff_read on public.product_families for select to authenticated
  using (public.staff_has_role(array['admin','counter','driver']));
create policy variants_staff_read on public.product_variants for select to authenticated
  using (public.staff_has_role(array['admin','counter','driver']));
create policy lots_counter_read on public.inventory_lots for select to authenticated
  using (public.staff_has_role(array['admin','counter']));
create policy sales_counter_read on public.sales for select to authenticated
  using (public.staff_has_role(array['admin','counter']));
create policy lines_counter_read on public.sale_lines for select to authenticated
  using (public.staff_has_role(array['admin','counter']));
create policy movements_admin_read on public.inventory_movements for select to authenticated
  using (public.staff_has_role(array['admin']));
create policy payments_counter_read on public.sale_payments for select to authenticated
  using (public.staff_has_role(array['admin','counter']));

-- An idempotent sale locks product variants and lots in deterministic order.
-- Prices are read from the database; the client supplies only quantities and IDs.
create function public.register_counter_sale(p_request_id uuid, p_items jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
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
$$;
revoke all on function public.register_counter_sale(uuid,jsonb) from public, anon;
grant execute on function public.register_counter_sale(uuid,jsonb) to authenticated;

-- A recorded transfer is not treated as received until it is verified.
create function public.record_sale_payment(
 p_request_id uuid, p_sale_id uuid, p_method text, p_amount_cents bigint,
 p_pending_verification boolean default false
) returns uuid language plpgsql security definer set search_path = ''
as $$
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
revoke all on function public.record_sale_payment(uuid,uuid,text,bigint,boolean) from public, anon;
grant execute on function public.record_sale_payment(uuid,uuid,text,bigint,boolean) to authenticated;

create function public.verify_transfer_payment(p_payment_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
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
revoke all on function public.verify_transfer_payment(uuid) from public, anon;
grant execute on function public.verify_transfer_payment(uuid) to authenticated;

commit;
