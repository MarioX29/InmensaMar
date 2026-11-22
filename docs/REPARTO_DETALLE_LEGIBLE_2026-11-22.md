# Reparto: presentación legible de pedidos dentro de una salida

## Alcance

Esta corrección mantiene el modelo simple acordado: la salida se despliega dentro de la misma pantalla y cada pedido aparece como un bloque compacto, sin navegar a otra página.

- El encabezado de la salida utiliza el texto breve `Detalles de la salida`; la cantidad de pedidos ya se muestra en el resumen.
- Los pedidos se organizan en dos columnas en pantallas amplias y una columna en móviles.
- Cada pedido separa cliente/identificador, teléfono/dirección, productos/cantidades/importes, indicaciones y estado de pago.
- Los importes quedan alineados y los textos largos pueden envolver sin romper la tarjeta.
- El detalle de la salida sigue contraído inicialmente.

## Sin cambios funcionales

- No se modifican RPC, tablas, permisos ni migraciones.
- No se alteran estados, cálculos, cobros ni devoluciones.
- No se agrega otra pantalla ni navegación.

## Validación

- Pruebas automatizadas: 56/56 PASS.
- La instalación de dependencias agotó el tiempo en el entorno de preparación; el build completo debe confirmarse con Cloudflare Pages después del commit.
