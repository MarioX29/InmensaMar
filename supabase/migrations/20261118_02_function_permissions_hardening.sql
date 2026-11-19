-- Inmensa Mar — 2026-11-18
-- Explicit EXECUTE matrix for existing public SECURITY DEFINER functions.
-- Expected local baseline: 64 functions; 49 authenticated, 5 service_role,
-- 10 owner-only (including old close/settlement overloads and trigger helpers).
-- Apply after 20261118_01_submit_pilot_order_idempotency.sql.
BEGIN;

DO $$
DECLARE
    v_total integer;
BEGIN
    SELECT count(*) INTO v_total
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prosecdef;

    IF v_total <> 64 THEN
        RAISE EXCEPTION 'Expected 64 SECURITY DEFINER functions; found %', v_total;
    END IF;
END;
$$;

-- Future functions created by postgres must receive explicit grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
    f record;
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
    v_expected_auth boolean;
    v_expected_service boolean;
    v_processed integer := 0;
BEGIN
    IF cardinality(v_auth_names) <> 47 OR cardinality(v_service_names) <> 5 THEN
        RAISE EXCEPTION 'Permission matrix definition is invalid';
    END IF;

    FOR f IN
        SELECT p.oid, p.proname, p.pronargs, p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.prosecdef
    LOOP
        v_expected_auth := f.proname = ANY(v_auth_names)
            OR (f.proname = 'close_cash_day' AND f.pronargs = 6)
            OR (f.proname = 'settle_driver_day' AND f.pronargs = 5);
        v_expected_service := f.proname = ANY(v_service_names);

        IF v_expected_auth AND v_expected_service THEN
            RAISE EXCEPTION 'Conflicting permissions: %', f.signature;
        END IF;

        EXECUTE format(
            'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
            f.signature
        );

        IF v_expected_auth THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
        ELSIF v_expected_service THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
        END IF;

        v_processed := v_processed + 1;
    END LOOP;

    IF v_processed <> 64 THEN
        RAISE EXCEPTION 'Expected 64 processed functions; got %', v_processed;
    END IF;
END;
$$;

DO $$
DECLARE
    f record;
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
    v_expected_auth boolean;
    v_expected_service boolean;
    v_public_execute boolean;
BEGIN
    FOR f IN
        SELECT p.oid, p.proname, p.pronargs, p.proowner, p.proacl,
               p.oid::regprocedure AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.prosecdef
    LOOP
        v_expected_auth := f.proname = ANY(v_auth_names)
            OR (f.proname = 'close_cash_day' AND f.pronargs = 6)
            OR (f.proname = 'settle_driver_day' AND f.pronargs = 5);
        v_expected_service := f.proname = ANY(v_service_names);

        SELECT EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) INTO v_public_execute;

        IF v_public_execute
           OR has_function_privilege('anon', f.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', f.oid, 'EXECUTE') IS DISTINCT FROM v_expected_auth
           OR has_function_privilege('service_role', f.oid, 'EXECUTE') IS DISTINCT FROM v_expected_service
           OR NOT has_function_privilege('postgres', f.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'Permission validation failed: %', f.signature;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS: all 64 SECURITY DEFINER functions match the approved permission matrix';
END;
$$;

COMMIT;

SELECT
    count(*) AS total_functions,
    count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_executable,
    count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authenticated_executable,
    count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) AS service_executable,
    count(*) FILTER (
        WHERE EXISTS (
            SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        )
    ) AS public_executable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef;
