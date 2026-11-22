# Unidades comerciales y precios — Inmensa Mar 2.0

## Decisión implementada en esta fase

Cada presentación (`product_variants`) conserva su propio inventario, unidad base y precio. Las unidades admitidas son:

- `lb` — libra: admite cantidades fraccionarias.
- `unit` — unidad: cantidades enteras.
- `dozen` — docena: cantidades enteras.
- `package` — paquete: cantidades enteras.
- `box` — caja: cantidades enteras.

Cada presentación guarda su propio `price_cents`; por eso una caja puede tener un precio independiente del precio por libra. No se calcula el precio de caja multiplicando el precio por libra.

## Inventario y conversión

En esta fase no hay conversión automática entre unidades. Una presentación configurada como caja tiene existencias en cajas. Una presentación configurada como libra tiene existencias en libras. No se asumirá que una caja contiene una cantidad fija de libras.

Si el negocio confirma que una presentación de compra y otra de venta comparten físicamente el mismo inventario y una equivalencia fija, se diseñará una segunda fase de conversiones explícitas. Esa fase tendrá que convertir cantidades y costos de forma coherente en compras, reservas, ventas, mermas, devoluciones y reportes.

## Precios especiales

Los precios especiales por operación se implementarán aparte del precio de catálogo. Cada transacción conservará el precio aplicado y su total; el historial registrará el precio de catálogo de referencia, precio acordado, usuario autorizador, motivo y modalidad de aprobación. El catálogo nunca se actualizará como consecuencia de una negociación individual.

## UX

En productos cuya unidad base es libra, el POS y los formularios de pedido capturan la cantidad en dos campos: libras y onzas. Cada 16 onzas se convierten automáticamente en una libra; el exceso se normaliza (por ejemplo, 36 oz → 2 lb + 4 oz). El cálculo interno, los precios, las reservas y los movimientos continúan usando una única cantidad decimal en libras. Las onzas son una ayuda de captura, no una unidad independiente del catálogo ni de inventario.

Para unidad, docena, paquete y caja se muestra un único campo de cantidad entera. El usuario puede aplicar la cantidad antes de continuar; la conversión de libras y onzas se confirma sin pedirle que haga la operación mentalmente.
