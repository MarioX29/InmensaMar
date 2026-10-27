# Inmensa Mar

Sistema interno de ventas, inventario y pedidos.

## Desarrollo

```bash
npm install
npm run dev
```

Configurar `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` para la compilación.

## Pedidos de clientes en develop

`pedidos.html` es la entrada pública del catálogo y envío de pedidos, sin cuenta de personal. Usa las Pages Functions de `functions/api/customer-*.js`; las claves de servidor se usan exclusivamente en `server/storefront.js`.

La activación requiere la nueva migración, el QA de Supabase y `PUBLIC_ORDERING_ENABLED=true` en Preview. Sin esa configuración el API no acepta pedidos. La guía completa está en [docs/PEDIDOS_PUBLICOS_DEVELOP.md](docs/PEDIDOS_PUBLICOS_DEVELOP.md).

La bandeja del personal mantiene el ingreso manual y las operaciones existentes. El inventario se reserva al aceptar; enviar un pedido público no lo reserva ni cobra. Las etiquetas de entorno de prueba se conservan porque esta entrega sigue en develop. No se ha promovido main a producción.
