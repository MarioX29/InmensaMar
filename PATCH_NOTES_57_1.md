# Inmensa Mar Develop 57.1 — SQL review corrections

This is a focused patch for the existing `develop` working tree. It replaces four files only:

- `supabase/migrations/20261118_01_submit_pilot_order_idempotency.sql`
- `supabase/migrations/20261118_03_table_default_privileges_hardening.sql`
- `supabase/qa/20261118_02_security_hardening_regression.sql`
- `docs/RELEASE_CANDIDATE_57.md`

## Corrections

1. The persisted-line comparison in `submit_pilot_order` now groups by variant, defensively normalizing existing rows as well as incoming items.
2. The baseline `customer_order_lines` table has `UNIQUE(order_id, variant_id)` and the supplied migrations do not drop that constraint. Thus duplicate persisted lines are not a valid legacy fixture under this schema. The existing QA continues to test duplicate incoming item normalization.
3. Table hardening now revokes only elevated privileges (`TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`) from `anon` and `authenticated` on existing public tables. Ordinary CRUD/SELECT grants are preserved.
4. The RLS event-trigger migration is idempotent when the named trigger already exists in the exact expected enabled configuration. If the name is occupied by a disabled or differently configured trigger, it fails closed for manual inspection.
5. Security regression QA now checks elevated privileges on existing tables and creates a temporary public table to verify automatic RLS and default grants. The QA rolls back all probe DDL.

## Apply locally

1. Confirm `git branch --show-current` returns `develop`.
2. Review `git status --short --branch` and keep a copy of any local changes.
3. Extract this patch into the repository root, replacing only the listed files.
4. Do not run the migrations against a database where their effects have not been backed up. On the already-audited local restore, migration 01 and 02 have previously been applied manually, and the RLS event trigger already exists. Migration 03 is designed to accept that exact trigger state, apply the remaining default/elevated table privilege corrections, and verify them.
5. Run the SQL QA scripts after confirming migration state. Do not apply anything to remote Supabase or production as part of this patch review.
6. Do not commit or push until the SQL has been executed and reviewed in the local restore.
