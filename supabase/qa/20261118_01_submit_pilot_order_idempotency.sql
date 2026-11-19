-- QA: submit_pilot_order idempotency. All fixtures are rolled back.
BEGIN;

DO $qa$
DECLARE
    v_counter_id uuid := gen_random_uuid();
    v_variant_id uuid;
    v_base_unit text;
    v_each_qty numeric;
    v_total_qty numeric;
    v_request_id uuid := gen_random_uuid();
    v_first_order_id uuid;
    v_retry_order_id uuid;
    v_order_count integer;
BEGIN
    INSERT INTO auth.users (id, email)
    VALUES (v_counter_id, 'qa-idempotency-' || v_counter_id || '@example.invalid');

    INSERT INTO public.staff_profiles (user_id, display_name, role, active)
    VALUES (v_counter_id, 'QA Counter Idempotency', 'counter', true);

    SELECT id, base_unit INTO v_variant_id, v_base_unit
    FROM public.product_variants
    WHERE active
    ORDER BY id
    LIMIT 1;

    IF v_variant_id IS NULL THEN
        RAISE EXCEPTION 'QA BLOCKED: no active product variant exists';
    END IF;

    v_each_qty := CASE WHEN v_base_unit IN ('unit', 'package') THEN 1 ELSE 0.5 END;
    v_total_qty := v_each_qty * 2;

    PERFORM set_config(
        'request.jwt.claims',
        jsonb_build_object('role', 'authenticated', 'sub', v_counter_id)::text,
        true
    );

    v_first_order_id := public.submit_pilot_order(
        v_request_id,
        'QA Idempotency Customer',
        '55551234',
        'Direccion QA zona 1',
        'Prueba de idempotencia',
        jsonb_build_array(
            jsonb_build_object('variant_id', v_variant_id, 'quantity', v_each_qty),
            jsonb_build_object('variant_id', v_variant_id, 'quantity', v_each_qty)
        )
    );

    IF v_first_order_id IS NULL THEN
        RAISE EXCEPTION 'FAIL: initial order returned NULL';
    END IF;

    v_retry_order_id := public.submit_pilot_order(
        v_request_id,
        'QA Idempotency Customer',
        '55551234',
        'Direccion QA zona 1',
        'Prueba de idempotencia',
        jsonb_build_array(
            jsonb_build_object('variant_id', v_variant_id, 'quantity', v_total_qty)
        )
    );

    IF v_retry_order_id IS DISTINCT FROM v_first_order_id THEN
        RAISE EXCEPTION 'FAIL: identical retry returned a different order';
    END IF;

    SELECT count(*) INTO v_order_count
    FROM public.customer_orders WHERE request_id = v_request_id;

    IF v_order_count <> 1 THEN
        RAISE EXCEPTION 'FAIL: identical retry created a duplicate order';
    END IF;

    BEGIN
        PERFORM public.submit_pilot_order(
            v_request_id, 'QA Idempotency Customer', '55551234',
            'Direccion QA zona 2', 'Prueba de idempotencia',
            jsonb_build_array(jsonb_build_object('variant_id', v_variant_id, 'quantity', v_total_qty))
        );
        RAISE EXCEPTION 'FAIL: modified address was accepted';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'Request ID already used' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM public.submit_pilot_order(
            v_request_id, 'QA Idempotency Customer', '55551234',
            'Direccion QA zona 1', 'Prueba de idempotencia',
            jsonb_build_array(jsonb_build_object('variant_id', v_variant_id, 'quantity', v_total_qty + v_each_qty))
        );
        RAISE EXCEPTION 'FAIL: modified quantity was accepted';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'Request ID already used' THEN RAISE; END IF;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM public.customer_orders o
        JOIN public.customer_order_lines l ON l.order_id = o.id
        WHERE o.id = v_first_order_id
          AND o.delivery_address = 'Direccion QA zona 1'
          AND l.variant_id = v_variant_id
          AND l.quantity = v_total_qty
    ) THEN
        RAISE EXCEPTION 'FAIL: original order was changed';
    END IF;

    RAISE NOTICE 'PASS: identical retry returns the original order';
    RAISE NOTICE 'PASS: duplicate variant lines normalize consistently';
    RAISE NOTICE 'PASS: modified address is rejected';
    RAISE NOTICE 'PASS: modified quantity is rejected';
    RAISE NOTICE 'PASS: existing order remains unchanged';
END;
$qa$;

ROLLBACK;
