# Vinito — Sistema de gestión de proveedores (multiusuario)

Migración del HTML único (localStorage) a una app real con backend, para que
vos, tus socios y la contadora vean y editen los mismos datos desde
cualquier lugar.

**Stack:** Node.js + Express + PostgreSQL (mismo patrón que usás en
Wheelwright), pensado para desplegar en Railway.

## Qué cambió respecto al HTML original

- Los datos (proveedores, boletas, cheques) ahora viven en una base
  PostgreSQL compartida, no en la memoria del navegador.
- El login sigue siendo admin/lector con contraseña, pero ahora se valida
  en el servidor (`/api/auth/login`) y queda una sesión con cookie.
- Toda acción de alta/baja/edición pasa por la API (`/api/...`) en vez de
  tocar un array local.
- Cada usuario conectado recibe un refresco automático cada 45 segundos
  para ver cambios que haya cargado otra persona sin tener que recargar
  la página a mano.
- El diseño, los colores, el logo y toda la UI quedaron exactamente
  iguales al HTML original.

## Estructura

```
vinito-gestion/
  server.js        -> API + servidor de archivos estáticos
  schema.sql        -> Esquema de la base (correr una sola vez)
  package.json
  .env.example       -> Variables de entorno de ejemplo
  public/
    index.html      -> Frontend (mismo diseño, ahora habla con la API)
```

## Deploy en Railway (paso a paso)

1. **Creá un repo nuevo en GitHub** (por ejemplo `vinito-gestion`) y subí
   esta carpeta completa.
2. En Railway, **"New Project" → "Deploy from GitHub repo"** y elegí ese
   repo.
3. Agregá un plugin de **PostgreSQL** al mismo proyecto de Railway
   ("New" → "Database" → "Add PostgreSQL"). Railway va a inyectar la
   variable `DATABASE_URL` automáticamente al servicio de Node — no hace
   falta que la copies vos.
4. En el servicio de Node, andá a **Variables** y agregá:
   - `SESSION_SECRET` → cualquier string largo y random.
   - `ADMIN_PASSWORD` → la contraseña que van a usar los administradores
     (vos, tus socios).
   - `READER_PASSWORD` → la contraseña para la contadora / perfil de solo
     lectura.
   - (opcional) `NODE_ENV=production`.
5. **Cargá el esquema una sola vez.** Desde tu compu, con `psql` o desde
   la pestaña "Query" del plugin de Postgres en Railway, pegá el
   contenido de `schema.sql` y ejecutalo. Esto crea las tablas
   `proveedores`, `boletas`, `cheques` y `alert_emails`.
6. Railway va a detectar el `package.json` y correr `npm install` +
   `npm start` solo. Cuando termine el build, te da una URL pública
   (algo como `vinito-gestion-production.up.railway.app`).
7. (Opcional) Si querés que quede bajo tu dominio, en Railway →
   Settings → Networking → Custom Domain, agregás algo como
   `gestion.vinitorosario.com` y armás el CNAME en Cloudflare, igual que
   hiciste con Wheelwright.

Listo: compartís esa URL con tus socios y la contadora. Cada uno entra
con su usuario (Administrador o Lector) y contraseña.

## Desarrollo local

```bash
cp .env.example .env
# completá DATABASE_URL con una Postgres local o la de Railway
npm install
npm start
```

Abrí `http://localhost:3000`.

## Notas

- El botón "Exportar Excel" sigue funcionando igual que antes (se genera
  en el navegador, no toca el servidor).
- Las contraseñas demo del HTML original (`vinito2025` / `lector123`)
  siguen siendo el valor por defecto si no configurás `ADMIN_PASSWORD` /
  `READER_PASSWORD` en Railway — te recomiendo cambiarlas antes de
  compartir el link con la contadora.
