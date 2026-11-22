# Captura de peso en libras y onzas

## Comportamiento

Para presentaciones cuyo inventario se maneja en libras, el POS, el formulario interno de nuevo pedido y el carrito público permiten capturar la cantidad en dos campos: **Libras** y **Onzas**.

La persona introduce la cantidad como la recibe del cliente. Al aplicar, la interfaz normaliza automáticamente cada grupo de 16 onzas como una libra y conserva cualquier excedente. Ejemplos:

| Entrada | Cantidad normalizada | Valor enviado al inventario |
|---|---|---:|
| 1 lb + 4 oz | 1 lb + 4 oz | 1.25 lb |
| 0 lb + 32 oz | 2 lb | 2 lb |
| 0 lb + 36 oz | 2 lb + 4 oz | 2.25 lb |
| 2 lb + 40 oz | 4 lb + 8 oz | 4.5 lb |

La conversión es exacta en la escala actual de cuatro decimales (`numeric(14,4)`). El backend sigue recibiendo una única cantidad decimal en libras; no se crea una unidad de inventario `oz`, ni se cambia el precio por libra.

Para unidad, docena, paquete y caja se mantiene un único campo de cantidad entera. Las cajas conservan su propia unidad, precio e inventario; no se convierten automáticamente a libras.

## Validación realizada

- Pruebas de conversión y normalización: 5 casos cubiertos.
- Integración estática: POS de mostrador, pedido interno y carrito público usan el mismo componente.
- Pruebas automatizadas del proyecto: 15 PASS.
- Transpilación sintáctica de los cuatro TSX modificados: PASS.
- Build completo de Vite/TypeScript: pendiente porque las dependencias locales `@types/react`, `@types/react-dom` y otras están incompletas. No desplegar hasta completar `npm ci` y `npm run build`.

No se ha aplicado ningún cambio a Supabase Cloud ni se necesita una migración SQL para esta captura: las operaciones continúan enviando libras decimales al esquema y RPC actuales.
