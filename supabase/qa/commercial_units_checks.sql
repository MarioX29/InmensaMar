-- Read-only contract checks for commercial units. Run after 20261121_01_commercial_units.sql.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid='public.product_variants'::regclass
    AND c.conname='product_variants_base_unit_check';
  IF v_def IS NULL OR NOT (v_def LIKE '%dozen%' AND v_def LIKE '%box%') THEN
    RAISE EXCEPTION 'FAIL: commercial unit constraint';
  END IF;

  SELECT pg_get_functiondef('public.admin_catalog_change(uuid,text,uuid,uuid,text,text,integer,boolean)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%dozen%' OR v_def NOT LIKE '%box%' THEN
    RAISE EXCEPTION 'FAIL: catalog RPC does not admit dozen and box';
  END IF;

  SELECT pg_get_functiondef('public.admin_register_purchase(uuid,uuid,numeric,integer,date)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%v_unit <> ''lb''%' THEN
    RAISE EXCEPTION 'FAIL: purchase RPC must reject fractional non-weight units';
  END IF;

  SELECT pg_get_functiondef('public.register_counter_sale(uuid,jsonb)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%base_unit <> ''lb''%' THEN
    RAISE EXCEPTION 'FAIL: counter sale RPC must reject fractional non-weight units';
  END IF;

  SELECT pg_get_functiondef('public.submit_pilot_order(uuid,text,text,text,text,jsonb)'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%base_unit <> ''lb''%' THEN
    RAISE EXCEPTION 'FAIL: pilot order RPC must reject fractional non-weight units';
  END IF;
END;
$$;

SELECT 'PASS: five units are admitted; only pounds allow fractional quantities' AS result;
