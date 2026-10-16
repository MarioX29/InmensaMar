# Inmensa Mar

Sistema interno de ventas, inventario y pedidos.

## Desarrollo

```bash
npm install
npm run dev
```

Configurar `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` para la compilación.

## Pedidos piloto

La pestaña Pedidos del sistema interno incluye bandeja y creación de pedidos de prueba. Requiere la migración `0003_orders_pilot.sql` después de revisarla y ejecutarla en el entorno de prueba. No permite pedidos anónimos de clientes.
