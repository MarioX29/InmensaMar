Inmensa Mar - Configuracion temporal de Preview

1. Subir .env.production y .gitignore a la raiz de la rama develop.
2. No subir estos archivos a main ni incluir .env.production en un merge.
3. Cloudflare: restaurar Build command a npm run build.
4. Confirmar que el nuevo despliegue corresponde a develop.
5. Probar el login sin usar ventas reales.

El archivo .env.production contiene exclusivamente la URL del proyecto y una clave publicable.
No incluir contrasenas, service_role, sb_secret ni datos de clientes.

Esta es una solucion temporal para validar Preview. Antes de fusionar develop a main,
retirar .env.production y configurar correctamente las variables de Preview en Cloudflare.
