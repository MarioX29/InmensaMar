-- Inmensa Mar — 2026-11-18
-- Restrict table defaults, remove elevated client grants from existing public
-- tables, and install the automatic public-table RLS event trigger.
-- Requires public.rls_auto_enable() SECURITY DEFINER owned by postgres.
-- Apply with the Supabase postgres migration role in a Supautils-enabled env.
-- Safe to re-run when the named event trigger already exists in the expected state.
BEGIN;

DO $$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Run this migration as the Supabase postgres migration role';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'rls_auto_enable'
          AND p.prorettype = 'event_trigger'::regtype
          AND p.prosecdef
          AND p.proowner = 'postgres'::regrole
          AND p.proconfig @> ARRAY['search_path=pg_catalog']
    ) THEN
        RAISE EXCEPTION 'Expected public.rls_auto_enable() SECURITY DEFINER function owned by postgres with locked search_path was not found';
    END IF;
END;
$$;

-- Future tables created by postgres must not grant any table privileges
-- automatically to anon or authenticated. service_role defaults are retained.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
IN SCHEMA public
REVOKE ALL ON TABLES FROM anon, authenticated;

-- Also remove elevated administrative privileges from existing public tables.
-- Preserve ordinary SELECT/INSERT/UPDATE/DELETE grants because the app relies
-- on intentional table grants plus RLS for authenticated staff operations.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
ON ALL TABLES IN SCHEMA public
FROM anon, authenticated;

-- Reconcile the event trigger idempotently. Never replace an object with the
-- same name if it points elsewhere or has a different event scope.
DO $$
DECLARE
    v_trigger record;
    v_expected_tags text[] := ARRAY['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'];
BEGIN
    SELECT evtname, evtevent, evtenabled, evttags, evtfoid
    INTO v_trigger
    FROM pg_event_trigger
    WHERE evtname = 'inmensa_mar_auto_enable_rls';

    IF NOT FOUND THEN
        EXECUTE $ddl$
            CREATE EVENT TRIGGER inmensa_mar_auto_enable_rls
            ON ddl_command_end
            WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
            EXECUTE FUNCTION public.rls_auto_enable()
        $ddl$;
    ELSE
        IF v_trigger.evtevent <> 'ddl_command_end'
           OR v_trigger.evtenabled <> 'O'
           OR v_trigger.evtfoid <> 'public.rls_auto_enable()'::regprocedure::oid
           OR v_trigger.evttags IS NULL
           OR cardinality(v_trigger.evttags) <> cardinality(v_expected_tags)
           OR NOT (v_trigger.evttags @> v_expected_tags) THEN
            RAISE EXCEPTION 'Existing event trigger inmensa_mar_auto_enable_rls does not match the expected enabled RLS trigger; inspect it manually';
        END IF;
        RAISE NOTICE 'Existing RLS event trigger already matches expected configuration; keeping it';
    END IF;
END;
$$;

-- Probe a newly created public table. The event trigger must enable RLS, and
-- role defaults must leave client access closed while preserving service_role.
CREATE TABLE public._inmensa_mar_rls_probe_20261118 (
    id bigint PRIMARY KEY,
    probe_value text
);

DO $$
DECLARE
    v_probe regclass := 'public._inmensa_mar_rls_probe_20261118'::regclass;
    v_privilege text;
    v_privileges text[] := ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
    ];
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_probe) THEN
        RAISE EXCEPTION 'Automatic RLS activation failed for newly created public table';
    END IF;

    FOREACH v_privilege IN ARRAY v_privileges LOOP
        IF has_table_privilege('anon', v_probe, v_privilege) THEN
            RAISE EXCEPTION 'anon inherited % on new public table', v_privilege;
        END IF;
        IF has_table_privilege('authenticated', v_probe, v_privilege) THEN
            RAISE EXCEPTION 'authenticated inherited % on new public table', v_privilege;
        END IF;
        IF NOT has_table_privilege('service_role', v_probe, v_privilege) THEN
            RAISE EXCEPTION 'service_role lost default % on new public table', v_privilege;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS: new public table receives RLS and safe default privileges';
END;
$$;

DROP TABLE public._inmensa_mar_rls_probe_20261118;

COMMIT;
