# Inmensa Mar

Aplicación web para la operación de mostrador de Inmensa Mar.

## Estado

Versión inicial de desarrollo. Incluye catálogo de ejemplo, carrito, ventas simuladas en efectivo, consulta de existencias y resumen local. Los datos se guardan en el navegador (`localStorage`) y no se comparten entre dispositivos.

El módulo de pedidos, la autenticación, las reservas y la conexión con Supabase aún no están implementados. El archivo SQL es un borrador de diseño y no debe ejecutarse en producción.

## Requisitos

- Node.js 22 o posterior
- npm

## Ejecutar

```bash
npm install
npm run dev
```

Para verificar tipos y generar una compilación:

```bash
npm run build
```

## Configuración

`.env.example` documenta las variables previstas para una futura conexión con Supabase. La versión actual no las utiliza. Nunca guardar credenciales privadas en el repositorio ni usar claves de servidor en variables `VITE_`.

## Estructura

- `src/main.tsx`: interfaz y lógica local de la versión inicial.
- `src/styles.css`: estilos responsive.
- `supabase/migrations/`: borradores de esquema; no aplicables a producción.

## Antes de usar en el negocio

Se requieren autenticación, políticas de acceso, operaciones transaccionales, respaldo y recuperación de datos, y pruebas funcionales y de seguridad.
