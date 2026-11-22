# Reparto: consolidación de interfaz

## Alcance

Esta actualización reorganiza las vistas administrativas de Reparto sin cambiar los RPC existentes ni requerir una migración SQL.

- **Salidas en curso:** tarjetas independientes y responsivas. Cada tarjeta resume repartidor, cantidad de pedidos, estados y progreso; el detalle de paradas queda plegado.
- **Devoluciones:** tarjetas por pedido. El personal debe introducir explícitamente la cantidad recibida en buen estado para cada producto. La diferencia se calcula como pérdida y se conserva la confirmación física antes de llamar `confirm_delivery_return`.
- **Historial:** tabla para escritorio y tarjetas compactas en móvil. Se conservan los filtros y el aviso del límite de 100 salidas cargadas.
- **Cobros:** se distinguen efectivo recibido, pago pendiente, transferencia por verificar y transferencia verificada. Los cobros pendientes posteriores mantienen la acción existente para registrar el pago.

## Límite funcional conocido

El RPC `confirm_delivery_with_payment` registra el total completo del pedido o un evento de pago pendiente. No admite abonos parciales ni pagos acumulados parciales. La interfaz no presenta una acción de abono parcial; esa capacidad requiere un diseño y cambio de backend independiente.

## Seguridad e integridad

- No se modifica la base de datos ni se ejecutan migraciones.
- Las devoluciones continúan usando `confirm_delivery_return` con `request_id` idempotente.
- Si una devolución queda con resultado incierto, la interfaz conserva y permite reintentar la misma solicitud, incluso después de recargar la página.
- La cantidad recuperada en buen estado nunca se presupone: debe ingresarse expresamente.

## Validación

Se agregan pruebas de resumen de rutas, estados de cobro, cálculo de devolución, reintento idempotente y distribución responsiva. El build completo debe validarse en Cloudflare Pages; el entorno local de esta preparación tiene definiciones de tipos incompletas en `node_modules`.
