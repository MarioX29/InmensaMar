-- QA: security hardening regression for the 2026-11-18 migrations.
-- Run after migrations 01, 02 and 03. All probe DDL is rolled back.
BEGIN;

DO $$
DECLARE
    v_auth_names text[] := ARRAY[
        'accept_and_prepare_pilot_order',
        'accept_pilot_order',
        'admin_catalog_change',
        'admin_record_expense',
        'admin_reduce_inventory',
        'admin_register_purchase',
        'admin_set_stock_minimum',
        'admin_update_price',
        'advance_pilot_order',
        'cancel_order_and_cleanup',
        'cancel_pilot_order',
        'cash_day_reconciliation',
        'confirm_delivery',
        'confirm_delivery_return',
        'confirm_delivery_with_payment',
        'confirm_driver_float',
        'declare_driver_cash_float',
        'delivery_cash_overview',
        'delivery_cash_positions',
        'dispatch_delivery_route',
        'driver_day_settlement_preview',
        'driver_money_summary',
        'driver_ready_orders',
        'driver_reorder_active_route',
        'driver_take_ready_orders',
        'finance_period_summary',
        'my_delivery_orders',
        'my_delivery_orders_v2',
        'open_cash_day',
        'owner_growth_dashboard',
        'pending_delivery_returns',
        'prepare_and_dispatch_outing',
        'prepare_delivery_outing',
        'record_cash_withdrawal',
        'record_delivery_cash_handoff',
        'record_sale_payment',
        'register_counter_sale',
        'reorder_delivery_route',
        'report_delivery_failure',
        'report_driver_cash_errand',
        'review_driver_cash_errand',
        'set_delivery_transfer_issue',
        'staff_has_role',
        'verify_delivery_transfer',
        'verify_transfer_payment',
        'order_delivery_preferences',
        'submit_pilot_order'
    ];
    v_service_names text[] := ARRAY[
        'claim_push_events',
        'complete_push_event',
        'storefront_catalog',
        'submit_storefront_order',
        'submit_storefront_order_v2'
    ];
    f record;
    v_auth_expected boolean;
    v_service_expected boolean;
    v_public boolean;
    v_function_count integer;
    v_table_count integer;
    v_bad_privilege_count integer;
BEGIN
    SELECT count(*) INTO v_function_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' AND p.prosecdef;
    IF v_function_count <> 64 THEN
        RAISE EXCEPTION 'FAIL: expected 64 SECURITY DEFINER functions, found %',v_function_count;
    END IF;

    FOR f IN
        SELECT p.oid,p.proname,p.pronargs,p.proowner,p.proacl,p.oid::regprocedure AS signature
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f' AND p.prosecdef
    LOOP
        v_auth_expected := f.proname=ANY(v_auth_names)
            OR (f.proname='close_cash_day' AND f.pronargs=6)
            OR (f.proname='settle_driver_day' AND f.pronargs=5);
        v_service_expected := f.proname=ANY(v_service_names);
        SELECT EXISTS (
            SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a
            WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
        ) INTO v_public;

        IF v_public
           OR has_function_privilege('anon',f.oid,'EXECUTE')
           OR has_function_privilege('authenticated',f.oid,'EXECUTE') IS DISTINCT FROM v_auth_expected
           OR has_function_privilege('service_role',f.oid,'EXECUTE') IS DISTINCT FROM v_service_expected
           OR NOT has_function_privilege('postgres',f.oid,'EXECUTE') THEN
            RAISE EXCEPTION 'FAIL: function permission mismatch: %',f.signature;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: 64 SECURITY DEFINER functions match the permission matrix';

    IF EXISTS (
        SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole='postgres'::regrole
          AND d.defaclnamespace='public'::regnamespace
          AND d.defaclobjtype='f'
          AND a.privilege_type='EXECUTE'
          AND a.grantee IN (0,'anon'::regrole,'authenticated'::regrole,'service_role'::regrole)
    ) THEN
        RAISE EXCEPTION 'FAIL: unsafe default function EXECUTE privilege remains';
    END IF;
    RAISE NOTICE 'PASS: future functions require explicit EXECUTE grants';

    IF EXISTS (
        SELECT 1 FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole='postgres'::regrole
          AND d.defaclnamespace='public'::regnamespace
          AND d.defaclobjtype='r'
          AND a.grantee IN (0,'anon'::regrole,'authenticated'::regrole)
    ) THEN
        RAISE EXCEPTION 'FAIL: unsafe default table privileges remain';
    END IF;
    RAISE NOTICE 'PASS: future tables do not grant privileges to anon/authenticated';

    SELECT count(*) INTO v_table_count
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p');

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relkind IN ('r','p')
          AND NOT c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'FAIL: at least one existing public table has RLS disabled';
    END IF;
    RAISE NOTICE 'PASS: RLS enabled on all % existing public tables',v_table_count;

    SELECT count(*) INTO v_bad_privilege_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (VALUES ('anon'),('authenticated')) r(role_name)
    CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) p(privilege)
    WHERE n.nspname='public'
      AND c.relkind IN ('r','p')
      AND has_table_privilege(r.role_name,c.oid,p.privilege);

    IF v_bad_privilege_count <> 0 THEN
        RAISE EXCEPTION 'FAIL: found % effective elevated table privileges for anon/authenticated',v_bad_privilege_count;
    END IF;
    RAISE NOTICE 'PASS: existing public tables grant no elevated privileges to anon/authenticated';

    IF NOT EXISTS (
        SELECT 1 FROM pg_event_trigger e
        WHERE e.evtname='inmensa_mar_auto_enable_rls'
          AND e.evtevent='ddl_command_end'
          AND e.evtenabled='O'
          AND e.evtfoid='public.rls_auto_enable()'::regprocedure
          AND e.evttags @> ARRAY['CREATE TABLE','CREATE TABLE AS','SELECT INTO']
          AND cardinality(e.evttags)=3
    ) THEN
        RAISE EXCEPTION 'FAIL: automatic RLS event trigger missing, disabled or incorrectly scoped';
    END IF;
    RAISE NOTICE 'PASS: automatic public-table RLS event trigger enabled';
END;
$$;

-- Exercise the DDL event trigger inside this rollback-only QA transaction.
CREATE TABLE public._inmensa_mar_security_qa_probe_20261118 (
    id bigint PRIMARY KEY,
    probe_value text
);

DO $$
DECLARE
    v_probe regclass := 'public._inmensa_mar_security_qa_probe_20261118'::regclass;
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=v_probe) THEN
        RAISE EXCEPTION 'FAIL: new public table did not receive automatic RLS';
    END IF;
    IF has_table_privilege('anon',v_probe,'SELECT')
       OR has_table_privilege('authenticated',v_probe,'SELECT') THEN
        RAISE EXCEPTION 'FAIL: new public table inherited client SELECT privileges';
    END IF;
    IF NOT has_table_privilege('service_role',v_probe,'SELECT') THEN
        RAISE EXCEPTION 'FAIL: new public table lost service_role SELECT';
    END IF;
    RAISE NOTICE 'PASS: newly created public table receives RLS and expected default grants';
END;
$$;

DROP TABLE public._inmensa_mar_security_qa_probe_20261118;

ROLLBACK;
