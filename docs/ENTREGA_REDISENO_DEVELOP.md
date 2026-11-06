# Rediseño y pedidos públicos para develop

Entrega acumulativa sobre el ZIP 52. Sustituye el paquete anterior de pedidos públicos: no hace falta combinar ambos ZIP.

## Subir

Descomprimir y subir el contenido desde la raíz de develop, conservando sus rutas y reemplazando archivos coincidentes. No borrar carpetas ni archivos restantes. No cambiar main.

Incluye sistema del personal, catálogo público, API de pedidos y configuración. DESIGN.md documenta las decisiones visuales. Los scripts SQL siguen separados y no deben pegarse en archivos de la app.

## Estado

- 119 pruebas locales vigentes aprobadas con dependencias simuladas.
- Transpilación de 34 archivos TypeScript y enlace de main.tsx mediante esbuild aprobados. No equivale a comprobación completa de tipos ni al build de producción de Vite.
- 57 cuerpos de funciones asíncronas existentes sin cambios respecto al paquete de pedidos públicos; API, servidor y SQL idénticos.
- Falta revisión visual real en teléfono y laptop: no hubo navegador ejecutable disponible.
- Falta ejecutar migración y QA en Supabase, completar build en Cloudflare y probar el recorrido publicado.
- No desplegado. La etiqueta de entorno de prueba permanece; cambiar apariencia no certifica operación real.

## Apariencia

Superficies blancas, azul marino y turquesa de la marca; controles con radio de 4 px, botones escritos y cómodos, importes legibles, navegación inferior móvil y lateral en escritorio. Administración ofrece Mi negocio, Operaciones y Finanzas; elegir una tarea abre sus herramientas.

## Activación de pedidos

Seguir docs/PEDIDOS_PUBLICOS_DEVELOP.md. Ejecutar primero la migración separada y luego el QA (13 PASS con rollback). Activar solo en Preview PUBLIC_ORDERING_ENABLED=true, con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de servidor. Nunca poner la clave de servicio en variables VITE_. La página será /pedidos.html sin cuenta de personal. El rediseño no necesita nuevos cambios SQL adicionales a los del paquete de pedidos públicos.
