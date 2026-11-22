-- Read-only structural checks for the order price adjustment migration.
DO $$
BEGIN
  IF to_regclass('public.admin_order_price_events') IS NULL THEN
    RAISE EXCEPTION 'FAIL: audit table is missing';
  END IF;
  IF to_regprocedure('public.admin_adjust_order_line_price(uuid,uuid,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'FAIL: adjustment RPC is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.admin_order_price_events'::regclass) THEN
    RAISE EXCEPTION 'FAIL: RLS is disabled on audit table';
  END IF;
  IF has_function_privilege('anon', 'public.admin_adjust_order_line_price(uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute adjustment RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_adjust_order_line_price(uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot execute adjustment RPC';
  END IF;
  RAISE NOTICE 'PASS: order price adjustment schema, RLS and grants are present';
END $$;
