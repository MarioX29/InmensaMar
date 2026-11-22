> Nota histórica de Develop 56. La captura de libras y onzas se añadió en Develop 57; consultá `docs/CAPTURA_PESO_LIBRAS_ONZAS.md` para el comportamiento vigente.

# Nota de integración — versión 56

Esta versión amplía las unidades de inventario por presentación a libra, unidad, docena, paquete y caja. Cada presentación mantiene su propio precio y su propio inventario, expresado en esa unidad. Por lo tanto, una presentación por caja no hereda ni calcula su precio desde una presentación por libra.

No se habilitan conversiones automáticas entre caja y libra ni entre paquete y unidad. Si luego el negocio confirma una equivalencia fija, se diseñará y probará un modelo de conversión separado antes de usarlo.

## Orden de validación

1. Aplicar `supabase/migrations/20261121_01_commercial_units.sql` únicamente en Supabase Local.
2. Ejecutar `supabase/qa/commercial_units_checks.sql` en esa base.
3. Ejecutar `npm test`.
4. Ejecutar `npm run build` cuando se hayan instalado correctamente las dependencias.
5. Probar catálogo, compra, venta, pedido web, merma y stock mínimo con una presentación de cada unidad.

No aplicar la migración a Supabase Cloud hasta completar la validación local y revisar el respaldo vigente.
