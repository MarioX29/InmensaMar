# Detalle de salida de reparto

## Objetivo

La tarjeta de una salida activa funciona como acceso al detalle de esa salida. La lista principal ya no despliega pedidos dentro de la tarjeta ni muestra el texto «Ver pedidos de esta salida».

## Vista principal

Cada tarjeta muestra únicamente el resumen operativo: identificador/etiqueta de salida, repartidor, estado, cantidad de pedidos, resumen por estado y progreso de entregas activas. El progreso excluye los pedidos cancelados y el texto lo indica explícitamente.

Al seleccionar la tarjeta se abre la vista de detalle. La tarjeta completa es accesible con teclado como un botón.

## Detalle de salida

La vista dedicada incluye:

- Acción para volver a la lista de salidas.
- Etiqueta, estado, repartidor y fecha de creación.
- Resumen de pedidos, entregados, en curso, cancelados y otros estados relevantes.
- Progreso calculado sobre pedidos activos (los cancelados no cuentan en el denominador).
- Acción de confirmar despacho cuando la salida sigue en planificación.
- Cada parada con nombre del cliente, identificador, estado, teléfono, dirección, productos, cantidades, subtotal y total.
- Indicaciones y preferencias de entrega/pago cuando están disponibles.
- Estado de cobro: pendiente, efectivo recibido, transferencia por verificar o transferencia verificada.

Los datos proceden de las tablas y RPC existentes. No se agrega ni modifica una operación de negocio ni se introduce una migración SQL.

## Datos y límites

- Se conservan los RPC de despacho, entrega, cobro, devolución y reporte de incidencias existentes.
- Las líneas de pedido se consultan desde `customer_order_lines` y sus nombres/unidades desde `product_variants`.
- Las preferencias de entrega se consultan mediante `order_delivery_preferences`.
- No se implementan cobros parciales en esta actualización.
- La vista utiliza los pedidos y asignaciones recuperados por la pantalla; la carga de la consulta de pedidos se amplía a 500 para cubrir las asignaciones devueltas por la consulta actual (también limitada a 500).

## Validación

- Pruebas automatizadas de funciones de presentación y estructura de interfaz.
- Transpilación sintáctica de `DeliveryPanel.tsx`.
- El build integral debe volver a ejecutarse en el entorno de CI/Cloudflare porque el entorno local no tiene instaladas todas las dependencias ni definiciones de tipos.
