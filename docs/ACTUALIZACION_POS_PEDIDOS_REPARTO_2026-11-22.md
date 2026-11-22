# Actualización visual consolidada: POS, Pedidos y Reparto

## Alcance

Este paquete reúne cambios visuales pendientes para una sola integración en `develop`.

### POS
- Los campos de libras y onzas recalculan la cantidad y el subtotal automáticamente.
- Se eliminó el botón Aplicar.
- La línea del carrito se elimina con una X accesible.
- Se redujo el texto redundante alrededor de la equivalencia de peso.

### Pedidos
- Tarjetas individuales en cuadrícula adaptable (una columna en teléfono, dos en tablet y tres en escritorio).
- Se resuelve la regla heredada de una sola columna del contenedor principal.
- Detalle de productos y datos de entrega/pago permanecen plegados inicialmente.
- Las acciones generales del pedido y las acciones de cada producto permanecen separadas.
- Los menús contextuales se cierran al hacer clic fuera, al pulsar Escape y después de seleccionar una acción. Solo se mantiene un menú abierto a la vez.

### Reparto
- Salidas en tarjetas independientes; una sola salida utiliza todo el ancho con resumen horizontal.
- Varias salidas usan cuadrícula adaptable de tres, dos o una columna.
- El progreso se etiqueta como progreso de pedidos activos; los pedidos cancelados no se incluyen en su denominador.
- Una sola tarea de cobro pendiente utiliza todo el ancho; varias se distribuyen en cuadrícula.
- Se distinguen pagos pendientes, efectivo recibido, transferencia reportada y transferencia verificada.
- Devoluciones requieren un conteo físico explícito de la cantidad recibida en buen estado antes de confirmar; la diferencia se registra como pérdida.
- El historial conserva filtros y aviso del límite de 100 salidas cargadas; usa tabla en escritorio y tarjetas en móvil.

## Límites funcionales conocidos

- No se agregan abonos parciales: el RPC actual `confirm_delivery_with_payment` registra el pago total o un estado pendiente. Los pagos parciales requieren un cambio separado del modelo financiero y del backend.
- Las transferencias reportadas siguen verificándose desde Finanzas.
- No hay migraciones SQL nuevas en este paquete.

## Validación ejecutada

- `npm run test:all`: 54 pruebas aprobadas.
- Build completo: no verificado en este entorno. La instalación de dependencias quedó incompleta y TypeScript reportó definiciones de tipos faltantes (`react`, `react-dom`, Babel y Estree). Cloudflare Pages debe ejecutar el build después del commit.
- No se aplicaron cambios a Supabase Cloud ni se desplegó nada desde este entorno.
