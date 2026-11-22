# Precios especiales por pedido

## Alcance de esta entrega

El administrador puede ajustar el precio unitario de una línea individual desde el menú de tres puntos del producto en un pedido.

- Disponible mientras el pedido esté en `received`, `accepted`, `preparing` o `ready`.
- El ajuste registra un acuerdo directo (por ejemplo, teléfono o WhatsApp).
- El administrador debe indicar un motivo.
- Se recalcula el subtotal de la línea y el total del pedido dentro de una sola transacción.
- El cambio no modifica `product_variants.price_cents`, los lotes ni los costos de inventario.
- Se conserva precio anterior, precio nuevo, subtotales, total anterior/nuevo, motivo, actor y fecha en `admin_order_price_events`.
- No se permite el ajuste ordinario una vez despachado/entregado/cancelado ni cuando ya existe un pago registrado.

## Seguridad e idempotencia

La interfaz llama `admin_adjust_order_line_price` con un `request_id` UUID nuevo. La función exige un perfil activo de administrador, bloquea el pedido y la línea, limita el ajuste a estados previos a la entrega y registra el evento de auditoría atómicamente. Los reintentos idénticos con el mismo `request_id` devuelven el evento existente; reutilizarlo con datos diferentes se rechaza.

La tabla de auditoría tiene RLS y lectura exclusiva de administradores. La escritura ocurre únicamente dentro de la función `SECURITY DEFINER`; no se concede escritura directa al navegador.

## Pendiente separado

Esta entrega cubre el modo de acuerdo directo. El modo de enviar el nuevo total al cliente y esperar su aceptación requiere un flujo seguro de confirmación del cliente y no se considera implementado todavía.
