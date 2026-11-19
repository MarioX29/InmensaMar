-- Inmensa Mar — 2026-11-18
-- Hardens pilot-order request idempotency.
-- Apply to the existing Inmensa Mar schema after the 2026-11-05 baseline.
-- Does not modify existing orders or historical line prices.
BEGIN;

CREATE OR REPLACE FUNCTION public.submit_pilot_order(
    p_request_id uuid,
    p_customer_name text,
    p_customer_phone text,
    p_delivery_address text,
    p_notes text,
    p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_uid uuid := auth.uid();
    v_existing public.customer_orders%ROWTYPE;
    v_order uuid;
    v_item record;
    v_variant record;
    v_total bigint := 0;
    v_amount bigint;
    v_existing_items jsonb;
    v_requested_items jsonb;
BEGIN
    IF NOT public.staff_has_role(ARRAY['admin', 'counter']) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_request_id IS NULL THEN
        RAISE EXCEPTION 'Request ID required';
    END IF;

    IF char_length(btrim(coalesce(p_customer_name, ''))) NOT BETWEEN 2 AND 120
       OR coalesce(p_customer_phone, '') !~ '^\+?[0-9 ()-]{8,22}$'
       OR char_length(btrim(coalesce(p_delivery_address, ''))) NOT BETWEEN 5 AND 300
       OR char_length(coalesce(p_notes, '')) > 500 THEN
        RAISE EXCEPTION 'Invalid customer details';
    END IF;

    IF p_items IS NULL
       OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 30 THEN
        RAISE EXCEPTION 'Invalid order items';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS x(item)
        WHERE jsonb_typeof(x.item) <> 'object'
           OR jsonb_typeof(x.item->'variant_id') <> 'string'
           OR jsonb_typeof(x.item->'quantity') <> 'number'
           OR (x.item->>'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
        RAISE EXCEPTION 'Invalid order item format';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS x(item)
        WHERE (x.item->>'quantity')::numeric <= 0
           OR (x.item->>'quantity')::numeric > 10000
           OR scale((x.item->>'quantity')::numeric) > 4
    ) THEN
        RAISE EXCEPTION 'Invalid quantity';
    END IF;

    -- Serialize concurrent retries using the same request ID.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::text, 1)
    );

    SELECT *
    INTO v_existing
    FROM public.customer_orders
    WHERE request_id = p_request_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.customer_name IS DISTINCT FROM btrim(p_customer_name)
           OR v_existing.customer_phone IS DISTINCT FROM p_customer_phone
           OR v_existing.delivery_address IS DISTINCT FROM btrim(p_delivery_address)
           OR v_existing.notes IS DISTINCT FROM coalesce(p_notes, '') THEN
            RAISE EXCEPTION 'Request ID already used';
        END IF;

        -- Compare normalized item payloads. Do not re-price existing orders.
        -- Group persisted lines defensively as well as requested lines.
        -- The current schema enforces UNIQUE(order_id, variant_id), so duplicate
        -- persisted variants should not exist; grouping keeps comparison stable
        -- if that constraint is ever changed in a later schema version.
        SELECT coalesce(
            jsonb_agg(
                jsonb_build_array(q.variant_id, q.quantity)
                ORDER BY q.variant_id
            ),
            '[]'::jsonb
        )
        INTO v_existing_items
        FROM (
            SELECT l.variant_id, sum(l.quantity) AS quantity
            FROM public.customer_order_lines AS l
            WHERE l.order_id = v_existing.id
            GROUP BY l.variant_id
        ) AS q;

        SELECT coalesce(
            jsonb_agg(
                jsonb_build_array(q.variant_id, q.quantity)
                ORDER BY q.variant_id
            ),
            '[]'::jsonb
        )
        INTO v_requested_items
        FROM (
            SELECT
                (x.item->>'variant_id')::uuid AS variant_id,
                sum((x.item->>'quantity')::numeric) AS quantity
            FROM jsonb_array_elements(p_items) AS x(item)
            GROUP BY 1
        ) AS q;

        IF v_existing_items IS DISTINCT FROM v_requested_items THEN
            RAISE EXCEPTION 'Request ID already used';
        END IF;

        RETURN v_existing.id;
    END IF;

    INSERT INTO public.customer_orders (
        request_id,
        customer_name,
        customer_phone,
        delivery_address,
        notes,
        total_cents,
        created_by
    )
    VALUES (
        p_request_id,
        btrim(p_customer_name),
        p_customer_phone,
        btrim(p_delivery_address),
        coalesce(p_notes, ''),
        0,
        v_uid
    )
    RETURNING id INTO v_order;

    FOR v_item IN
        SELECT
            (x.item->>'variant_id')::uuid AS variant_id,
            sum((x.item->>'quantity')::numeric) AS quantity
        FROM jsonb_array_elements(p_items) AS x(item)
        GROUP BY 1
        ORDER BY 1
    LOOP
        SELECT id, base_unit, price_cents
        INTO v_variant
        FROM public.product_variants
        WHERE id = v_item.variant_id
          AND active
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product unavailable';
        END IF;

        IF v_variant.base_unit IN ('unit', 'package')
           AND v_item.quantity <> trunc(v_item.quantity) THEN
            RAISE EXCEPTION 'Whole units required';
        END IF;

        v_amount := round(v_item.quantity * v_variant.price_cents)::bigint;
        v_total := v_total + v_amount;

        INSERT INTO public.customer_order_lines (
            order_id,
            variant_id,
            quantity,
            unit_price_cents,
            line_total_cents
        )
        VALUES (
            v_order,
            v_item.variant_id,
            v_item.quantity,
            v_variant.price_cents,
            v_amount
        );
    END LOOP;

    UPDATE public.customer_orders
    SET total_cents = v_total
    WHERE id = v_order;

    RETURN v_order;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_pilot_order(uuid,text,text,text,text,jsonb)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.submit_pilot_order(uuid,text,text,text,text,jsonb)
TO authenticated;

COMMIT;
