# Inmensa-Mar Xela — actualización acumulativa

Base de trabajo: ZIP `InmensaMar-develop (58).zip` compartido por el usuario.
Destino previsto: rama `develop` del repositorio `MarioX29/InmensaMar`.

## Incluye

- Logo oficial de Inmensa-Mar Xela en encabezado, acceso y página pública; iconos de aplicación actualizados con el logo proporcionado.
- Desde Inventario, el acceso Registrar compra abre el formulario de compra existente en un diálogo, sin navegar a Administración ni duplicar la operación.
- Stock mínimo: texto dinámico según el valor; cero indica alertas desactivadas y un campo vacío solicita ingresar un mínimo.
- Resumen de Mi negocio: estado vacío cuando no hay ventas en el período y una referencia visual para inventario crítico.
- Reparto: pedidos cancelados agrupados y contraídos; resumen de transferencias abre Finanzas; se mantienen los detalles de ruta y el flujo de devoluciones existentes.
- Caja: los desplegables conservan el clic en su encabezado para abrir/cerrar; usan una flecha giratoria en lugar del símbolo que parecía una X.
- Finanzas: detalle de líneas y pagos en ventas de mostrador; filtros de fecha, estado, origen y búsqueda en transferencias; gastos recientes expandibles.
- Pruebas automatizadas nuevas y actualizadas.

## No incluido / límites

- No se agregan migraciones SQL ni se modifica Supabase.
- No se agregan abonos parciales a pedidos de reparto; el flujo de reparto actual no admite esa operación.
- No se ejecuta despliegue ni se modifica GitHub automáticamente.

## Validación realizada

- `npm run test:all`: 65/65 pruebas aprobadas.
- Transpilación sintáctica: 32 archivos TSX revisados, 0 errores de sintaxis.
- `npm run build`: no completó porque la instalación local de dependencias está incompleta; TypeScript reporta definiciones ausentes de `react`, `react-dom`, `babel__core`, `babel__generator`, `babel__template`, `babel__traverse` y `estree`. Se intentó reinstalar con `npm ci`, pero la instalación agotó el tiempo.

Por tanto, esta actualización todavía requiere que Cloudflare confirme el build cuando se suba a `develop`.
