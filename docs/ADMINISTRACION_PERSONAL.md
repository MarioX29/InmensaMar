# Administración de personal en Inmensa Mar

La pantalla Administración → Personal utiliza `functions/api/staff.js`. La función se ejecuta en Cloudflare Pages y usa la clave `SUPABASE_SERVICE_ROLE_KEY` exclusivamente del lado servidor; nunca debe exponerse con un prefijo `VITE_` ni incorporarse al repositorio.

## Variables del servidor

En Cloudflare Pages, tanto en Preview como en Production cuando se vaya a habilitar la función, configurar:

- `SUPABASE_URL`: URL HTTPS del proyecto `inmensa-mar`.
- `SUPABASE_SERVICE_ROLE_KEY`: clave service-role como Secret.

La función verifica el JWT del usuario contra Supabase Auth y vuelve a comprobar en `staff_profiles` que sea un administrador activo en cada solicitud. Los usuarios de mostrador y reparto no pueden consultar ni modificar el personal.

## Crear una cuenta

1. El administrador entra a Administración → Personal y elige Agregar persona.
2. Captura nombre, correo y rol (`admin`, `counter` o `driver`).
3. El servidor crea la cuenta Auth y su fila en `staff_profiles`.
4. La interfaz muestra una contraseña temporal una sola vez. El administrador debe entregarla directamente a la persona por un medio privado; no enviarla en un canal público.
5. En el primer ingreso, `AuthGate` exige reemplazarla por una contraseña personal de al menos 12 caracteres.

La creación marca el correo como confirmado por decisión del administrador (`email_confirm: true`); por ello el administrador debe verificar que el correo esté escrito correctamente antes de crear la cuenta. Esta modalidad no depende del SMTP de Supabase.

## Cambiar o desactivar

- Se puede cambiar el nombre, el rol y el estado activo.
- No se borra la cuenta Auth ni el perfil: las operaciones históricas conservan su referencia.
- No se permite desactivar o degradar la cuenta que está gestionando el cambio.
- Debe permanecer al menos un administrador activo.
- El backend siempre vuelve a validar el rol administrador; ocultar la pantalla en React no es el control de seguridad.

## Validación antes de publicar

1. Configurar las dos variables anteriores en Cloudflare Preview.
2. Probar el listado con administrador y confirmar que mostrador/reparto reciben `403`.
3. Crear una cuenta de prueba con correo controlado, copiar la contraseña temporal, iniciar sesión y cambiarla.
4. Confirmar que la persona llega a la interfaz correcta según su rol.
5. Cambiar el rol y desactivar/reactivar el usuario de prueba.
6. Confirmar que no se puede desactivar el último administrador ni la propia cuenta.
7. Eliminar la cuenta de prueba solo después de comprobar que no tiene operaciones; para pruebas con movimientos, conservar la cuenta y desactivarla.

No desplegar esta función en Cloudflare Production hasta completar las pruebas anteriores en Preview.
