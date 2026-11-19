# Inmensa Mar Develop 57 — patch para el clon Git existente

Contiene solo archivos nuevos o modificados respecto a InmensaMar-develop (55). No incluye `.git`, dependencias, artefactos de build ni secretos.

1. Confirma que estás en el clon original de InmensaMar y en la rama `develop`.
2. Antes de extraer, ejecuta `git status --short --branch`; guarda o revisa los cambios locales existentes.
3. Extrae este ZIP en la raíz del clon, sobrescribiendo solo los archivos incluidos. No borres archivos ni la carpeta `.git`.
4. Revisa `git status --short --branch` y `git diff --stat`; inspecciona el diff antes del commit.
5. Ejecuta `npm ci`, `npm run test:unit`, `npm run build` y `npm audit`.
6. Revisa `docs/RELEASE_CANDIDATE_57.md` antes de aplicar SQL. La restauración local ya auditada recibió estos cambios manualmente; no vuelvas a ejecutar la migración 03 allí porque el event trigger ya existe.
7. No hagas push ni despliegues hasta completar la verificación SQL/QA en un entorno Preview y revisar el diff. No modificar `main`.
