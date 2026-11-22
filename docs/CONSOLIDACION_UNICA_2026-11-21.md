# Consolidación única — 21 de noviembre de 2026

## Fuente de verdad

El punto de partida fue el ZIP real de `develop` compartido desde GitHub (commit `779af6153a377329df8d42e638fa8a0a94ac8533`). No se asumió que las entregas ZIP 55–58 anteriores hubieran sido integradas por el usuario. Las funcionalidades se incorporaron desde sus implementaciones preparadas, conservando las migraciones de seguridad del archivo GitHub original y su restricción de personal activo en `push-test.js`.

## Funcionalidades integradas

- Gestión de empleados, alta de usuario Auth desde Cloudflare Pages, perfil `staff_profiles`, roles, edición y baja lógica.
- Unidades `lb`, `unit`, `dozen`, `package`, `box`, sin conversión automática entre presentaciones.
- Componente compartido de captura de cantidades en libras + onzas en POS, pedido interno y carrito público. Conversión: `lb + oz / 16`; el valor interno se guarda como libra decimal.
- Precio negociado por línea de pedido, solo administración y antes del despacho, con motivo e historial de auditoría; no altera el precio del catálogo.

## Migraciones

Se conservaron las tres migraciones de seguridad del 18/11/2026 del ZIP de GitHub. Se añadieron migraciones del precio de línea de pedido (20/11) y unidades comerciales (21/11), más sus SQL de comprobación. Ver README para el orden y advertencias.

## Pruebas ejecutadas en esta consolidación

- Pruebas de funcionalidades nuevas: 23 casos.
- Pruebas existentes de endpoint de notificaciones: 4 casos.
- Total comprobado al ejecutar `npm run test:all`: 27 (23 funcionalidades nuevas + 4 regresiones del endpoint de notificaciones).
- El build TypeScript/Vite no queda certificado en este entorno: el `node_modules` incluido en un ZIP intermedio estaba incompleto, con paquetes de tipos vacíos. Ejecutar `npm ci` desde el clon existente y luego `npm run build` antes de publicar.

## No incluido / pendiente

- Confirmación de precio por parte del cliente web.
- Precio especial opcional en ventas POS.
- QA visual de los nuevos formularios y QA integral de la jornada.
- Aplicación y verificación de migraciones sobre la base remota.

No subir esta entrega directamente a producción. Revisar diff, completar instalación/build, validar migraciones en entorno de prueba y hacer un único commit en `develop`.
