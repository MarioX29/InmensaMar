# Inmensa Mar

Aplicación web de operación para el mostrador.

## Requisitos

- Node.js 22
- Proyecto Supabase con migración `0002_core_v2.sql` aplicada
- Usuario activo en `staff_profiles` con rol `admin` o `counter`

## Desarrollo

```bash
npm install
cp .env.example .env.local
npm run dev
```

Variables requeridas: `VITE_SUPABASE_URL` (URL base, sin `/rest/v1`) y `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Estado de Core 0.3

- Autenticación de personal con Supabase Auth.
- Catálogo, existencias y últimas 100 ventas consultadas desde PostgreSQL.
- Venta de mostrador mediante RPC `register_counter_sale`.
- Cobro en efectivo mediante RPC `record_sale_payment`.
- Recuperación de intentos de venta/cobro con identificadores persistidos localmente.
- Actualización manual y cada 15 segundos mientras la pestaña esté visible.

**Limitaciones:** no incluye pedidos, preparación de productos, pagos por transferencia ni cierre de caja. El registro de venta y el registro de pago son dos transacciones separadas; si el pago falla, debe reintentarse o conciliarse antes de continuar. No se debe utilizar en producción hasta completar pruebas de seguridad, concurrencia, restauración y conciliación.

## Datos de prueba

`supabase/seed_test.sql` agrega cinco variantes ficticias y sus lotes, solo si aún no existen lotes para esas variantes. Ejecutar únicamente en una base destinada a pruebas. Los datos son ficticios.

## Despliegue

Cloudflare Pages: `npm run build`, salida `dist`. Configurar las variables de entorno en Production y Preview según corresponda.
