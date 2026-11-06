# Respaldo y recuperación

El archivo supabase-schema.sql recibido contiene estructura y permisos del esquema público; no contiene los registros del negocio. Mantenerlo junto al ZIP original como referencia de la fecha de exportación. No ejecutarlo sobre la base actual.

Antes de aplicar cambios en operación, obtener también un respaldo de datos y conservarlo fuera del repositorio público. Las cuentas Auth, archivos de Storage, variables Cloudflare y secretos Vault requieren su propia estrategia de recuperación. Nunca subirlos al repositorio ni adjuntar claves al chat.

La restauración debe probarse en un proyecto aislado: habilitar las extensiones y servicios usados (incluidos pg_net y Vault si se prueban notificaciones), reconstruir la estructura, restaurar los datos con sus relaciones y verificar login, stock, ventas, cobros y una jornada de Caja. Mantener los webhooks y envíos externos deshabilitados durante la prueba para evitar notificaciones o pedidos reales.

La prueba queda pendiente; tener un archivo exportado no demuestra que la recuperación funcione. Registrar fecha, quién la ejecutó, qué se restauró y resultado. Después definir la frecuencia de respaldos y dónde se conservarán con acceso restringido.
