# Develop 57 — consolidación de seguridad y QA

## Propósito

Esta entrega integra en el árbol de trabajo `develop` los cambios de aplicación validados en Develop 56 y las tres migraciones de Supabase ejecutadas y comprobadas en la restauración local el 18 de noviembre de 2026. No contiene `.git`; debe integrarse sobre el clon Git existente para conservar su historial.

## Orden de migraciones

Aplicar únicamente después de confirmar que el proyecto remoto corresponde al esquema de referencia actual y que no se aplicaron ya estos cambios:

1. `supabase/migrations/20261118_01_submit_pilot_order_idempotency.sql`
2. `supabase/migrations/20261118_02_function_permissions_hardening.sql`
3. `supabase/migrations/20261118_03_table_default_privileges_hardening.sql`

La tercera migración requiere que `public.rls_auto_enable()` exista, sea `SECURITY DEFINER`, tenga propietario `postgres` y `search_path=pg_catalog`. En Supabase administrado la creación del event trigger depende del mecanismo de privilegios/Supautils disponible en ese proyecto. No asumir que el éxito en Docker garantiza que el proyecto remoto permite la misma operación. Ejecutar primero en Preview o en una restauración equivalente y detenerse si la comprobación previa falla.

**Importante sobre la restauración local ya auditada:** allí los cambios de las migraciones se aplicaron manualmente durante la sesión. En particular, el event trigger `inmensa_mar_auto_enable_rls` ya existe en esa restauración; no ejecutar la migración 03 otra vez sobre esa misma base, porque está diseñada para instalarlo una sola vez y detendrá la transacción si el nombre ya está ocupado. Para una base nueva/restauración limpia, seguir el orden anterior y comprobar el historial antes de aplicar.

No ejecutar `supabase/reference/schema-before-release.sql` sobre una base existente: es una referencia de esquema, no una migración incremental.

## QA SQL

Después de las migraciones:

- `supabase/qa/release_checks.sql` — 23 comprobaciones de flujo que ya pasaron en la restauración local.
- `supabase/qa/20261118_01_submit_pilot_order_idempotency.sql` — cinco comprobaciones de idempotencia con `ROLLBACK`.
- `supabase/qa/20261118_02_security_hardening_regression.sql` — matriz de permisos, defaults, RLS y event trigger; transacción de QA con `ROLLBACK`.

El test de release y el test de idempotencia pasaron después de la matriz de funciones en la restauración local. El script de regresión nuevo está incluido para repetir esas comprobaciones de forma persistente; no se afirma que se haya ejecutado desde este paquete.

## Validación frontend ya reportada

En la copia Develop 56 validada en Windows:

- `npm ci` completó.
- `npm run test:unit`: 4/4 PASS.
- `npm run build`: TypeScript y Vite 6.4.5 completaron.
- `npm audit`: 0 vulnerabilidades.

Estos resultados corresponden a la copia validada adjunta, no a un despliegue remoto.

## Integración a Git `develop`

1. Localizar el clon original `MarioX29/InmensaMar` y confirmar `git branch --show-current` devuelve `develop`.
2. Revisar `git status`; no sobrescribir cambios locales no guardados.
3. Copiar el contenido de esta entrega sobre el árbol del clon, conservando `.git` y cualquier archivo local no incluido.
4. Revisar `git diff`, ejecutar `npm ci`, `npm run test:unit`, `npm run build` y `npm audit`.
5. Probar las tres migraciones y los QA SQL en una restauración/Preview antes de cualquier push o deploy.
6. Hacer commit solo en `develop`. No modificar ni fusionar a `main` en esta fase.

## No hacer todavía

- No aplicar migraciones a producción.
- No ejecutar `schema-before-release.sql` sobre la base actual.
- No borrar datos QA ni usuarios Auth.
- No rotar ni copiar secretos en el repositorio.
- No declarar listo el release hasta completar la comparación del esquema remoto, pruebas funcionales de mostrador/reparto/caja y verificación de backups/restauración.


### SQL review corrections (2026-11-19)

- `customer_order_lines` is defined with `UNIQUE(order_id, variant_id)` in the baseline migration, and no later supplied migration drops that constraint. Therefore duplicate persisted variant lines are not a valid legacy fixture under this schema. The idempotency function defensively groups persisted lines, while the QA verifies normalization of duplicate incoming items.
- The table-hardening migration now revokes only elevated table privileges (`TRUNCATE`, `REFERENCES`, `TRIGGER`, `MAINTAIN`) from `anon` and `authenticated` on existing public tables. It preserves intentional ordinary CRUD/SELECT grants and RLS policies.
- The RLS event-trigger installation is idempotent when the named trigger already exists in the exact expected enabled configuration; a conflicting or disabled trigger fails closed for manual inspection.
- Security regression QA now checks elevated privileges on existing tables and tests automatic RLS on a temporary table inside a rolled-back transaction.
