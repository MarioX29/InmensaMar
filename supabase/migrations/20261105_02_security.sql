-- Harden existing privileges and the payment verification boundary. Apply after 20261105_01.
BEGIN;

REVOKE TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON TABLES FROM anon,authenticated;
-- Older signatures are internal helpers. The reviewed signatures call them as SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.close_cash_day(uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_driver_day(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;

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
  if p_method = 'transfer' and p_pending_verification is distinct from true then
    raise exception 'Las transferencias deben registrarse pendientes de verificación';
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



CREATE OR REPLACE FUNCTION "public"."verify_transfer_payment"("p_payment_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not public.staff_has_role(array['admin']) then
    raise exception 'Not authorized to verify payments';
  end if;
  update public.sale_payments
    set status = 'received', verified_at = now(), verified_by = v_user
  where id = p_payment_id and method = 'transfer' and status = 'pending_verification';
  if not found and not exists (select 1 from public.sale_payments where id=p_payment_id and method='transfer' and status='received' and verified_at is not null) then
    raise exception 'Transfer not found';
  end if;
end;
$$;



COMMIT;
