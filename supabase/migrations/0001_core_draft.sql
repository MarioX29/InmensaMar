-- DESIGN DRAFT ONLY. DO NOT APPLY TO PRODUCTION BEFORE RLS, ROLE POLICIES,
-- TRANSACTIONAL SALE/RESERVATION FUNCTIONS, AND SECURITY REVIEW.
create extension if not exists pgcrypto;
create table if not exists product_families(id uuid primary key default gen_random_uuid(),name text not null unique);
create table if not exists product_variants(id uuid primary key default gen_random_uuid(),family_id uuid not null references product_families(id),name text not null,unit text not null check(unit in ('lb','unit','package')),price_cents integer not null check(price_cents>=0),active boolean not null default true);
create table if not exists inventory_lots(id uuid primary key default gen_random_uuid(),variant_id uuid not null references product_variants(id),received_at timestamptz not null default now(),qty_received numeric(12,3) not null check(qty_received>=0),qty_on_hand numeric(12,3) not null check(qty_on_hand>=0),qty_reserved numeric(12,3) not null default 0 check(qty_reserved>=0),cost_cents_per_base_unit integer not null check(cost_cents_per_base_unit>=0),status text not null default 'available' check(status in ('available','quarantine','blocked','depleted')),check(qty_reserved<=qty_on_hand));
create table if not exists sales(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),total_cents integer not null check(total_cents>=0),status text not null check(status in ('completed','voided')));
create table if not exists sale_lines(id uuid primary key default gen_random_uuid(),sale_id uuid not null references sales(id),variant_id uuid not null references product_variants(id),quantity numeric(12,3) not null check(quantity>0),unit_price_cents integer not null check(unit_price_cents>=0));
-- RLS deliberately not enabled here because the schema is NOT deployable yet.
-- Do not expose these tables to client requests until proper policies are defined.
