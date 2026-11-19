# Actualización de auditoría — 18 de noviembre de 2026

## Cambios de aplicación incluidos

- `functions/api/push-test.js` exige perfil de personal activo (`admin`, `counter` o `driver`) después de validar el token de Supabase y antes de consultar suscripciones push.
- La consulta de elegibilidad se realiza en servidor mediante `SUPABASE_SERVICE_ROLE_KEY`; la clave no se expone al navegador.
- `functions/api/push-test.test.js` cubre cuenta sin perfil, perfil inactivo, personal activo y fallo al verificar elegibilidad.
- `npm run test:unit` ejecuta las pruebas unitarias Node.
- Vite está fijado en `6.4.5` en `package.json` y `package-lock.json`.

## Evidencia de Supabase Local reportada el 18-11-2026

- 23/23 release checks aprobados.
- 5/5 pruebas de idempotencia aprobadas.
- Permisos de `submit_pilot_order` comprobados: `anon=false`, `authenticated=true`, `service_role=false`, `postgres=true`.
- 64/64 funciones `SECURITY DEFINER` ajustadas y verificadas: `anon=0`, `authenticated=49`, `service_role=5`, `PUBLIC=0`.
- Defaults de funciones endurecidos para que funciones nuevas requieran permisos explícitos.
- Defaults de tablas endurecidos: nuevas tablas creadas por `postgres` no heredan privilegios para `anon` ni `authenticated`; `service_role` conserva los privilegios previstos.
- Event trigger local `inmensa_mar_auto_enable_rls` creado y probado: habilita RLS al crear tablas públicas.
- Prueba transaccional de tabla nueva completada y tabla de prueba eliminada.

## Evidencia frontend en la copia Develop 56 validada por el usuario

- `npm ci` completó con 79 paquetes instalados.
- `npm run test:unit`: 4/4 PASS.
- `npm run build`: `tsc -b` y Vite 6.4.5 completaron; 1,669 módulos transformados.
- `npm audit`: 0 vulnerabilidades reportadas.

## Pendientes antes de desplegar

- Integrar esta entrega en el clon Git original, branch `develop`; el ZIP no contiene `.git`.
- Verificar el esquema remoto y la existencia/propiedad de `public.rls_auto_enable()` antes de aplicar migraciones.
- Probar event trigger y defaults en Preview/entorno remoto equivalente; no inferir compatibilidad remota a partir de Docker.
- Ejecutar los nuevos QA SQL y volver a ejecutar los 23 release checks en Preview.
- QA funcional de mostrador, administrador, repartidor, pedidos públicos, pagos, devoluciones y caja.
- Verificar secretos Web Push, incluido el secreto del webhook que produjo advertencias en QA.
- Probar backup y restauración en un proyecto aislado.

## Alcance

Esta entrega no modifica Supabase remoto, no contiene datos de negocio ni secretos, no publica automáticamente y no constituye autorización para desplegar a producción.
