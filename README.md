# Inmensa Mar

Sistema de ventas, inventario, pedidos, reparto y Caja para el negocio Inmensa Mar. Rama de trabajo: **develop**. Esta versión integra los cambios pendientes y requiere validación publicada antes de promoverse a producción.

La guía actual es [docs/ENTREGA_INTEGRADA.md](docs/ENTREGA_INTEGRADA.md): incluye SQL, permisos, variables, pruebas realizadas y pendientes. No aplicar los ZIP anteriores sobre esta entrega.

```sh
npm ci
npm run build
```

Variables de cliente: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Solo el servidor utiliza `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (Secret). Para pedidos públicos se requiere `PUBLIC_ORDERING_ENABLED=true` en Preview. Nunca poner claves privadas en variables `VITE_` ni en el repositorio.

Contacto público de privacidad: `PUBLIC_CONTACT_WHATSAPP` o `PUBLIC_CONTACT_EMAIL` en Cloudflare. No son credenciales y se mostrarán a los clientes.

`pedidos.html` carga el catálogo y permite enviar pedidos sin cuenta de personal. `privacidad.html` informa sobre el uso de datos. La selección de transferencia es una preferencia; el cobro y la verificación se registran por personal autorizado.

El esquema de referencia previo es solo documentación; no es una migración para ejecutar sobre una base existente. La recuperación de datos se describe en docs/RECUPERACION_Y_RESPALDOS.md y todavía requiere una prueba aislada.
