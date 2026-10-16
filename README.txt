Inmensa Mar - Pedidos internos de prueba (Core 0.4, fase 1)

Contenido
- supabase/migrations/0003_orders_pilot.sql: tablas, politicas y funciones para pedidos internos.
- pedidos.html, vite.config.ts, src/orders/*: pagina de pedidos de prueba.
- src/main.tsx: enlace desde la seccion Pedidos del mostrador.

Alcance
- El personal autorizado crea pedidos de prueba.
- Mostrador acepta y reserva inventario al aceptar, o cancela y libera reservas.
- No descuenta existencias fisicas al aceptar.
- No se permiten pedidos anonimos ni acceso publico de clientes.
- No implementa preparacion, reparto, entrega, cobro ni notificaciones.
- Los pedidos se guardan en la base de datos; no son simulados.

Instalacion segura
1. Subir archivos en rama develop. No mezclar con main.
2. Antes de ejecutar SQL, revisar la migracion completa en el SQL Editor del proyecto de pruebas.
3. Ejecutar 0003_orders_pilot.sql una sola vez si las tablas no existen.
4. Esperar compilacion exitosa en Cloudflare Preview.
5. Abrir /pedidos.html con usuario admin/counter y probar creacion, aceptacion, rechazo por stock y cancelacion.
6. No ingresar clientes reales; usar datos ficticios. No abrir pedidos al publico.

Pruebas recomendadas
- Pedido recibido no reserva stock.
- Aceptacion reserva exactamente la cantidad requerida.
- Aceptacion repetida no reserva dos veces.
- Cancelacion libera la reserva una sola vez.
- Stock insuficiente al aceptar no crea reservas parciales.
- Un usuario driver o anon no puede crear/aceptar pedidos.
- La venta del mostrador respeta qty_reserved.
- Una solicitud duplicada con el mismo request_id devuelve el mismo pedido.

Pendiente antes de produccion
- Seguridad anti-spam, Turnstile/rate limits, API publica para clientes sin cuenta,
  estado y seguimiento de pedidos con token no adivinable, notificaciones,
  procesamiento de entrega y consumo final de reservas, pagos y auditoria.
- QA de PostgreSQL real y pruebas de concurrencia. No se ha ejecutado esta migracion.
- Retirar .env.production temporal de develop antes de fusionar a main.
