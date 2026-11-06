# Pedidos públicos en develop

Este paquete agrega una página de clientes a la app real. No es el HTML de demostración. Sigue siendo una entrega para validar en **develop**; no habilita producción ni cambia main.

## Qué contiene

- `/pedidos.html`: catálogo, cantidades, datos de entrega y envío sin cuenta de personal.
- El pedido entra a `customer_orders` con estado `received`; aparece en **Pedidos → En tienda → Nuevos**.
- Precio calculado en PostgreSQL y comprobado contra el precio que vio el cliente. Si cambió, se exige revisar el catálogo; no se acepta silenciosamente.
- No reserva ni descuenta al enviar. Se reserva al aceptar con las funciones existentes. Disponibilidad y entrega requieren confirmación del negocio.
- Recibo con referencia y total. Reintentos con la misma solicitud no duplican pedidos, incluso después de una respuesta perdida.
- En tienda / En reparto, más historial; sin asignar salidas nuevas desde mostrador. El repartidor toma los pedidos.
- Compras en el menú del repartidor. Reparto y Compras permanecen montados al navegar para conservar borradores y operaciones por verificar.
- Se conserva el despacho de una salida antigua preparada si aún existe. No se crean nuevas salidas manuales.
- Últimas ventas dentro de Administración → Finanzas → Ventas. Caja y sus funciones financieras no cambian.

## Activación (solo develop)

1. En la base Supabase que usa develop, ejecutar **una vez** `supabase/migrations/20261027_public_customer_orders.sql`. No ejecutar migraciones históricas otra vez. El script nuevo no cambia los RPC de ventas, reservas, cobros, reparto ni cierre.
2. Ejecutar `supabase/qa_public_customer_orders.sql`. Debe devolver 13 filas PASS y terminar con ROLLBACK. Sus datos de prueba no se conservan.
3. En Cloudflare Pages → Settings → Variables and Secrets, ámbito **Preview** (develop), comprobar las variables de servidor existentes:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (secreto de servidor, el mismo tipo que ya usa push).
   - Agregar `PUBLIC_ORDERING_ENABLED` con valor `true`.
   Nunca colocar la service role key en una variable VITE_, en React, en el ZIP ni en GitHub. No hace falta entregársela al desarrollador.
4. Subir todos los archivos del paquete a sus rutas en **develop**, en un solo commit si es posible. Esperar build exitoso en Cloudflare.
5. Abrir `https://develop.inmensamar.pages.dev/pedidos.html` en incógnito, sin sesión. Para el API usar Pages, no solo `vite dev`: las Functions no corren con Vite solo.

Sin la variable de activación o sin las credenciales de servidor, el API responde no disponible. Para suspender pedidos, cambiar `PUBLIC_ORDERING_ENABLED` a `false` y volver a desplegar, según aplique la configuración de Pages. No se habilita un RPC para anon ni se abre lectura pública de pedidos.

## Cambio de esquema

`customer_orders.created_by` admite NULL para pedidos de clientes sin cuenta. Los RPC internos siguen escribiendo el usuario autenticado. La tabla `storefront_order_requests` distingue los envíos públicos; no se inventa un usuario de personal. RLS y permisos anteriores de las tablas del negocio se conservan. El catálogo público solo muestra familias, presentaciones activas con precio positivo, unidad, precio y un indicador de disponibilidad; no muestra costos, cantidades por lote ni datos de clientes.

El límite inicial es 5 pedidos nuevos por conexión y ventana de 15 minutos. El servidor calcula un HMAC de la IP de Cloudflare; no guarda la IP en claro. Varias personas en una misma red comparten límite. Es protección básica y puede requerir Turnstile o controles adicionales según el abuso observado; no garantiza detener bots distribuidos. Los reintentos idénticos no consumen otro cupo. Las ventanas anteriores a dos días se limpian al aceptar otro pedido.

## Prueba manual necesaria

1. Cliente sin login: crear un pedido de 0.5 lb con teléfono y dirección de prueba.
2. Mostrador: confirmar que aparece una sola vez en Nuevos, que productos y total coinciden; aceptar y marcar listo sin cambiar de filtro.
3. Repartidor: tomarlo, entregar y registrar el cobro. Simular una entrega fallida y recibir la devolución con mostrador en otro pedido.
4. Dueño: revisar la compra del repartidor, liquidar y cerrar la jornada de pruebas según el flujo existente.
5. Antes de confirmar un envío, simular un cambio de precio desde admin: debe pedir revisar el catálogo.
6. Probar pérdida de respuesta y “Verificar mi envío”: debe devolver la misma referencia, sin otro pedido.
7. Verificar separación de roles y presentación en teléfono. Confirmar que el enlace de pedidos no expone pantallas de personal sin login.

El SQL de QA prueba una transacción. No certifica concurrencia real entre conexiones, push remoto ni la integración publicada; esas comprobaciones se registran al realizarlas. No hay pago en línea, tarifa automática de entrega, cobertura geográfica automática ni seguimiento público de pedidos en este paquete. El negocio confirma las condiciones de entrega; el total mostrado es de productos.

Referencias técnicas: [Supabase — datos y claves de servidor](https://supabase.com/docs/guides/database/secure-data), [Vite 6 — aplicaciones multipágina](https://v6.vite.dev/guide/build.html#multi-page-app).
