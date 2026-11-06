# Entrega integrada para develop — candidata a validación

Base: InmensaMar-develop (53).zip y supabase-schema.sql exportado el 5 de noviembre de 2026. El ZIP de actualización contiene todos los cambios de esta entrega sobre esa base, incluidas copias del SQL para mantener el repositorio completo. Ejecutar únicamente el archivo de migración separado una vez, no ambas copias. No hay que aplicar el ZIP anterior de Ubicación y Pago ni combinar paquetes.

## Aplicación

1. Conservar el ZIP original y el esquema exportado. El esquema no incluye datos, cuentas de Auth ni secretos: no sustituye un respaldo de datos.
2. En el mismo Supabase `inmensa-mar`, ejecutar una vez `InmensaMar-Entrega-Integrada-Migracion.sql`. Incluye ubicación/pago y endurecimiento de permisos en una transacción. No ejecutar el esquema completo sobre la base actual ni repetir migraciones históricas.
3. Ejecutar `InmensaMar-Entrega-Integrada-QA.sql`. Debe devolver **23 PASS**. Todos sus usuarios, ventas y pedidos ficticios se revierten con ROLLBACK; no usar los fixtures como cuentas permanentes. Si falla, conservar el error y no seguir con la subida.
4. Extraer el ZIP con «Extraer todo». Subir su contenido a la raíz de develop conservando carpetas, reemplazando los archivos coincidentes y sin borrar el resto del repositorio. Hacer un solo commit. No cambiar main.
5. Conservar en Cloudflare Preview `PUBLIC_ORDERING_ENABLED=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` como Secret y las variables VITE_ existentes. La clave de servicio nunca lleva prefijo VITE_. Configurar además al menos un contacto público: `PUBLIC_CONTACT_WHATSAPP` con código de país (ejemplo de formato: 502 seguido del número real), o `PUBLIC_CONTACT_EMAIL`. Estos dos valores son públicos; no usar credenciales en ellos.
6. Confirmar que el build de Cloudflare pase. Abrir pedidos.html en incógnito y probar la aplicación en teléfono y laptop. Revisar la página privacidad.html y el contacto antes de compartir el catálogo con clientes.

El contacto es dato del negocio que debe completar su dueño. El aviso describe el historial actual: no promete eliminación automática que aún no existe. El negocio debe decidir y aplicar su conservación de datos y revisar el aviso antes de operar; esta entrega no certifica cumplimiento legal.

## Cambios incluidos

- Cliente: dirección e indicaciones; ubicación opcional por GPS o enlace de Maps; efectivo exacto o importe para vuelto; transferencia como intención de pago pendiente de verificar.
- Mostrador y reparto: ubicación, indicaciones y preferencia de pago visibles. Vuelto recalculado con el total del pedido; aviso si el monto indicado ya no alcanza.
- Los reintentos públicos anteriores siguen usando el RPC original con su mismo identificador. Los nuevos incluyen las preferencias. No se inventan cuentas de clientes.
- Mostrador: el selector lb/oz existente se conserva; los botones cambian una onza en modo oz. En lb siguen usando media libra. Stock guardado en libras a cuatro decimales.
- Catálogo móvil: títulos e importes más compactos, campos de 16 px y controles cómodos.
- Seguridad: se revocan TRUNCATE, TRIGGER, REFERENCES y MAINTAIN de anon/authenticated en tablas públicas y en los valores por defecto del propietario postgres. Las firmas internas de cierre y liquidación ya no se ejecutan directamente desde el cliente. Las firmas revisadas siguen disponibles.
- Transferencias: el registro de una venta por transferencia exige estado pendiente. Solo admin verifica. Administración → Finanzas → Transferencias permite revisar tanto mostrador como reparto y confirmar después de consultar el banco. No hay verificación bancaria automática.
- Navegador: CSP con scripts propios, conexión restringida a Supabase y mismo origen, bloqueo de incrustación, geolocalización solo del propio sitio, cámara y micrófono deshabilitados.
- Privacidad: aviso público y enlace desde el pedido. Contacto desde variables públicas; el endpoint no devuelve secretos. Si falta contacto, conserva instrucciones para contactar por el medio en que se compartió el enlace; completar el contacto directo antes de producción.

## Qué se comprobó

150 pruebas locales de interfaz, API y recuperación con dependencias simuladas. Transpilación de 36 archivos TypeScript y enlace de main.tsx mediante esbuild. Los cuerpos de las ocho funciones asíncronas originales de Pedidos y Reparto se conservaron; la cola administrativa nueva agrega verificación de transferencias. Las funciones SQL corregidas se derivaron del esquema exportado, no de migraciones antiguas.

**No comprobado todavía:** ejecución de las 23 comprobaciones SQL en Supabase, tipado completo, build de producción de Vite, comportamiento visual real en navegador, integraciones remotas ni restauración de datos. `npm ci` quedó bloqueado por HTTP 403 del registro. La infraestructura de navegador disponible no permite revisión visual en este entorno. Las pruebas locales no certifican seguridad ni ausencia de errores en producción.

## Prueba publicada requerida

1. Crear un pedido público ficticio de 0.5 lb, con ubicación y efectivo para vuelto. Reintentar tras una respuesta perdida: misma referencia.
2. Verlo en mostrador, aceptar, preparar y marcar listo. Confirmar reserva correcta y datos de entrega.
3. Tomarlo con repartidor A, abrir la ubicación, entregar y cobrar. Repartidor B no debe leer ni operar esa entrega.
4. Repetir con transferencia, comprobar que no aparece verificada hasta que admin revise el banco y use Finanzas → Transferencias.
5. Hacer otra entrega fallida y devolución; revisar existencias y reservas.
6. Registrar compra de reparto, revisar su clasificación, liquidar, conciliar y cerrar Caja. Comprobar valores tras recargar.
7. En mostrador, registrar 1 oz y otra venta en lb; comprobar importe, stock y vuelto.
8. Confirmar restricciones con cuentas de mostrador, repartidor, usuario inactivo y visitante sin sesión.
9. Revisar en móvil que no haya desbordamiento, campos tapados ni pérdida del pedido al abrir privacidad.

## Para operar con la familia

Completar catálogo, precios, existencias iniciales y cuentas reales; definir el contacto de privacidad y el criterio de conservación; revisar autenticación/inscripciones desde el dashboard; respaldar datos actuales y probar su restauración en un proyecto aislado. Ejecutar una jornada completa acompañada antes de promover develop a main.

Esta entrega no borra datos de prueba existentes, no rota claves ni cambia usuarios reales y no publica automáticamente. No ejecutar scripts de borrado masivo para preparar la operación.
