-- Admin-only negotiated prices for individual order lines.
-- This migration records direct agreements; customer-acceptance workflow is separate.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_order_price_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE RESTRICT,
  order_line_id uuid NOT NULL REFERENCES public.customer_order_lines(id) ON DELETE RESTRICT,
  previous_unit_price_cents integer NOT NULL CHECK (previous_unit_price_cents >= 0),
  new_unit_price_cents integer NOT NULL CHECK (new_unit_price_cents >= 0),
  previous_line_total_cents bigint NOT NULL CHECK (previous_line_total_cents >= 0),
  new_line_total_cents bigint NOT NULL CHECK (new_line_total_cents >= 0),
  previous_order_total_cents bigint NOT NULL CHECK (previous_order_total_cents >= 0),
  new_order_total_cents bigint NOT NULL CHECK (new_order_total_cents >= 0),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 250),
  agreement_mode text NOT NULL DEFAULT 'direct_agreement'
    CHECK (agreement_mode = 'direct_agreement'),
  actor_id uuid NOT NULL REFERENCES public.staff_profiles(user_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_order_price_events_order_idx
  ON public.admin_order_price_events(order_id, created_at DESC);

ALTER TABLE public.admin_order_price_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_order_price_events_read ON public.admin_order_price_events;
CREATE POLICY admin_order_price_events_read
  ON public.admin_order_price_events
  FOR SELECT TO authenticated
  USING (public.staff_has_role(ARRAY['admin']::text[]));

REVOKE ALL ON TABLE public.admin_order_price_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_order_price_events TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_adjust_order_line_price(
  p_request_id uuid,
  p_order_line_id uuid,
  p_new_unit_price_cents integer,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_prior public.admin_order_price_events%ROWTYPE;
  v_order public.customer_orders%ROWTYPE;
  v_line public.customer_order_lines%ROWTYPE;
  v_previous_order_total bigint;
  v_new_line_total bigint;
  v_new_order_total bigint;
  v_event_id uuid;
  v_reason text := NULLIF(btrim(p_reason), '');
BEGIN
  IF v_actor IS NULL OR NOT public.staff_has_role(ARRAY['admin']::text[]) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_request_id IS NULL OR p_order_line_id IS NULL
     OR p_new_unit_price_cents IS NULL
     OR p_new_unit_price_cents < 0
     OR p_new_unit_price_cents > 100000000
     OR v_reason IS NULL
     OR char_length(v_reason) NOT BETWEEN 3 AND 250 THEN
    RAISE EXCEPTION 'Invalid negotiated price';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 411)
  );

  SELECT * INTO v_prior
  FROM public.admin_order_price_events
  WHERE request_id = p_request_id;

  IF FOUND THEN
    IF v_prior.order_line_id = p_order_line_id
       AND v_prior.new_unit_price_cents = p_new_unit_price_cents
       AND v_prior.reason = v_reason
       AND v_prior.actor_id = v_actor THEN
      RETURN v_prior.id;
    END IF;
    RAISE EXCEPTION 'Request ID already used';
  END IF;

  -- Serialize price edits against order transitions and other line edits.
  SELECT * INTO v_order
  FROM public.customer_orders
  WHERE id = (SELECT order_id FROM public.customer_order_lines WHERE id = p_order_line_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order line not found';
  END IF;

  IF v_order.status NOT IN ('received', 'accepted', 'preparing', 'ready') THEN
    RAISE EXCEPTION 'Price can only be adjusted before delivery';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.delivery_payment_events
    WHERE order_id = v_order.id AND event_kind = 'payment'
  ) THEN
    RAISE EXCEPTION 'Order with a recorded payment requires administrative reconciliation';
  END IF;

  SELECT * INTO v_line
  FROM public.customer_order_lines
  WHERE id = p_order_line_id AND order_id = v_order.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order line not found';
  END IF;

  IF v_line.unit_price_cents = p_new_unit_price_cents THEN
    RAISE EXCEPTION 'Price is unchanged';
  END IF;

  v_previous_order_total := v_order.total_cents;
  v_new_line_total := round(v_line.quantity * p_new_unit_price_cents)::bigint;

  UPDATE public.customer_order_lines
  SET unit_price_cents = p_new_unit_price_cents,
      line_total_cents = v_new_line_total
  WHERE id = v_line.id;

  SELECT COALESCE(sum(line_total_cents), 0)::bigint
  INTO v_new_order_total
  FROM public.customer_order_lines
  WHERE order_id = v_order.id;

  UPDATE public.customer_orders
  SET total_cents = v_new_order_total,
      updated_at = now()
  WHERE id = v_order.id;

  INSERT INTO public.admin_order_price_events (
    request_id, order_id, order_line_id,
    previous_unit_price_cents, new_unit_price_cents,
    previous_line_total_cents, new_line_total_cents,
    previous_order_total_cents, new_order_total_cents,
    reason, agreement_mode, actor_id
  ) VALUES (
    p_request_id, v_order.id, v_line.id,
    v_line.unit_price_cents, p_new_unit_price_cents,
    v_line.line_total_cents, v_new_line_total,
    v_previous_order_total, v_new_order_total,
    v_reason, 'direct_agreement', v_actor
  ) RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_order_line_price(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_order_line_price(uuid, uuid, integer, text) TO authenticated;

COMMIT;
