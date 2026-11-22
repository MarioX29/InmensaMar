# Reparto: salidas y cobros sencillos

## Salidas en curso

Cada salida permanece en la pantalla principal como una tarjeta plegable. Al abrirla, se muestran debajo los pedidos asignados, con cliente, teléfono, dirección, productos, cantidades, indicaciones, estado de entrega y estado de pago. No se navega a otra pantalla ni se muestra un enlace redundante.

La tarjeta muestra la etiqueta de salida, repartidor, estado, cantidad de pedidos, resumen por estado y progreso de pedidos activos. Los pedidos cancelados se excluyen del denominador del progreso y se muestran por separado. Si existe una sola salida, utiliza todo el ancho disponible; con varias salidas, la cuadrícula se adapta al tamaño de pantalla.

La acción de confirmar despacho permanece dentro del detalle plegado y solo aparece para salidas en planificación que tengan pedidos asignados.

## Cobros de entregas

La pantalla ya no muestra una tarjeta por cada pedido con cobro pendiente. Muestra dos importes resumidos: efectivo pendiente y transferencias por verificar.

Los pedidos con efectivo pendiente se pueden consultar en una lista plegable, donde cada fila conserva la acción de registrar cobro. Las transferencias reportadas se verifican desde Finanzas; Reparto informa cuántas y el monto agregado, sin duplicar la gestión bancaria.

Los cobros registrados y su historial se consultan desde Finanzas. El backend actual no admite abonos parciales; esta actualización no agrega ni simula esa capacidad.

## Devoluciones e historial

Se conservan los flujos existentes. Las devoluciones requieren conteo físico explícito antes de confirmar y registran la diferencia como pérdida. El historial mantiene filtros y la tabla de escritorio con su presentación adaptable.

## Datos y seguridad

No se agregan migraciones ni RPC. La implementación reutiliza las consultas y operaciones existentes de rutas, asignaciones, pedidos, líneas de pedido, pagos y devoluciones. No se modifica Supabase Cloud.

## Validación

Las pruebas de interfaz verifican el despliegue inline de salidas, la información del detalle, el progreso, los resúmenes de cobros y la confirmación física de devoluciones. El build completo debe comprobarse en CI/Cloudflare.
