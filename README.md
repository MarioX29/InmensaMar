# Inmensa Mar

Aplicación web para la operación de mostrador de Inmensa Mar.

## Estado

La aplicación incluye autenticación de personal con Supabase y un mostrador demostrativo. Las ventas, existencias y reportes del mostrador siguen siendo locales; **no se registran en PostgreSQL**. No utilizar para operaciones reales.

## Requisitos

- Node.js 20 o superior
- npm
- Proyecto Supabase con la migración Core V2 aplicada
- Usuario creado en Supabase Authentication y perfil activo en `public.staff_profiles`

## Desarrollo

1. Copiar `.env.example` a `.env.local`.
2. Completar `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Ejecutar `npm install` y `npm run dev`.
4. Ejecutar `npm run build` antes de publicar.

## Despliegue en Cloudflare Pages

- Comando de compilación: `npm run build`
- Directorio de salida: `dist`
- Variables de entorno: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`

Utilizar únicamente la clave **publishable** de Supabase en el frontend. No incluir contraseñas de base de datos, tokens personales ni claves `service_role`/secretas en el repositorio o en variables `VITE_`.

## Seguridad

El inicio de sesión comprueba el perfil activo del personal. Las políticas RLS y las funciones de base de datos son la barrera de autorización para operaciones reales; ocultar pantallas en React no sustituye permisos del servidor. La integración de ventas e inventario está pendiente.
