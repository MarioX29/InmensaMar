# Inmensa Mar — paquete acumulativo de develop

Este paquete se construyó sobre el archivo de `develop` que compartió Mario desde GitHub (commit de referencia: `779af6153a377329df8d42e638fa8a0a94ac8533`). Conserva su historial de seguridad del 18 de noviembre y añade, en una sola entrega, la gestión de personal, unidades comerciales, captura de peso en libras/onzas y ajustes negociados de precio por línea de pedido.

## Antes de integrar

- Este ZIP no contiene `.git`. Descomprimilo en una carpeta temporal y copiá/sincronizá su contenido sobre tu clon Git existente en la rama `develop`; **no reemplaces ni borres la carpeta `.git`**.
- No aplicar migraciones en Supabase Cloud directamente. Validar primero el orden y los resultados en una base de prueba/Local.
- La administración de personal requiere `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` como secretos de servidor de Cloudflare Pages. Nunca usar prefijo `VITE_` para la service-role key.
- El build completo debe ejecutarse con dependencias instaladas antes de publicar.

## Cambios incluidos

- Administración dinámica de personal con roles `admin`, `counter` y `driver` y creación segura desde Cloudflare Pages.
- Unidades de presentación: libra, unidad, docena, paquete y caja. No se convierten automáticamente unas en otras; cada presentación mantiene inventario y precio propios.
- Captura de peso con dos campos: libras y onzas. La interfaz normaliza las onzas (16 oz = 1 lb) y envía al backend la cantidad equivalente en libras decimales.
- Edición administrativa del precio de una línea en pedidos mediante menú de tres puntos, con motivo y auditoría. Esta versión implementa el modo de acuerdo directo; la modalidad de aceptación del cliente aún requiere desarrollo.
- Se conserva la validación de personal activo del endpoint de prueba de notificaciones incluida en el archivo GitHub original.

## Pruebas

```sh
npm ci
npm run test:all
npm run build
```

`npm run test:all` ejecuta pruebas unitarias de funciones de Cloudflare y pruebas de las nuevas funcionalidades. En esta consolidación se ejecutaron 27 pruebas y pasaron las 27. No sustituye la prueba de integración en un proyecto Supabase de prueba ni la revisión visual en navegador.

## Orden de migraciones incrementales

Después de revisar el estado real de la base y de confirmar que ninguna migración equivalente se aplicó manualmente, las migraciones nuevas se organizan así:

1. `20261118_01_submit_pilot_order_idempotency.sql`
2. `20261118_02_function_permissions_hardening.sql`
3. `20261118_03_table_default_privileges_hardening.sql`
4. `20261120_02_order_line_price_adjustments.sql`
5. `20261121_01_commercial_units.sql`

Las tres primeras ya se probaron en la restauración local durante la auditoría anterior, pero la tercera instala un event trigger y no debe repetirse si ya existe. Comprobar previamente el estado remoto/local y `supabase_migrations` antes de aplicar. `supabase/reference/schema-before-release.sql` es referencia, no una migración ejecutable.

## Pendientes antes de producción

- Ejecutar `npm ci`, `npm run test:all` y `npm run build` en un entorno con instalación de dependencias funcional.
- Ejecutar las verificaciones SQL de las migraciones de unidades y precios en PostgreSQL de prueba.
- Probar `/api/staff` en Cloudflare Preview con secretos de servidor y cuentas QA; no habilitar en producción antes de validar el flujo de alta y cambio de contraseña.
- Implementar el flujo de aceptación/rechazo del nuevo precio por parte del cliente web.
- Implementar precio especial opcional para ventas de mostrador (todavía no incluido en este paquete).
- QA visual y operativo completo de administrador, mostrador y repartidor.
- Definir el procedimiento de clasificación/archivo de registros QA antes del inicio de operaciones reales.

Este paquete no ha sido desplegado a Cloudflare, no ha modificado Supabase Cloud y no contiene un commit Git. Integra los cambios para que se pueda preparar **un solo commit** en el clon existente después de revisar el diff y completar las validaciones.
