# Guía de despliegue en servidor (`app-metodos-pago`)

Esta guía explica paso a paso cómo desplegar y subir la aplicación a producción utilizando **Docker** (Opción 1) o **sin Docker** directamente sobre Linux (Opción 2).

---

## Cómo funciona el despliegue de esta app (2 partes separadas)

Esta aplicación se compone de dos piezas que se despliegan en lugares distintos:

1. **En Shopify (`shopify app deploy`):**
   Compila la *Shopify Function* en Rust (`extensions/personalizacion-pagos`) a WebAssembly (`.wasm`) y registra la configuración de `shopify.app.toml` (URLs, scopes y webhooks) en la infraestructura de Shopify.
   - Se ejecuta desde tu PC local (o un pipeline CI).
   - **No** necesitas instalar Rust ni Shopify CLI en el servidor Linux de producción.
2. **En tu servidor (puerto interno `3000` detrás de HTTPS):**
   Aloja únicamente el panel administrativo embebido (React Router v7 sobre Node.js `>= 22.12` + Prisma) y recibe los webhooks `/webhooks/app/uninstalled` y `/webhooks/app/scopes_update`.

---

## Paso 0 (Común a ambas opciones): Preparación previa

Completa estos cuatro puntos antes de seguir con la Opción 1 (Docker) o la Opción 2 (sin Docker).

### 0.1 Dominio, DNS y puertos
- Crea un registro DNS tipo `A` apuntando tu subdominio (por ejemplo, `pagos.tudominio.com`) a la IP pública de tu servidor.
- Asegúrate de que el firewall del servidor/proveedor tenga abiertos los puertos **`80` (HTTP)** y **`443` (HTTPS)**, además del puerto SSH (`22`).
- Mantén el puerto `3000` cerrado al exterior: solo el reverse proxy (Caddy o Nginx) debe comunicarse con él internamente.

### 0.2 Configurar la URL de base de datos en `prisma/schema.prisma`
Actualmente, `prisma/schema.prisma` (líneas 11–14) tiene la ruta de SQLite fija para desarrollo local:

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:dev.sqlite"
}
```

#### Opción A — SQLite (recomendada si la usa 1 sola tienda)
1. Edita `prisma/schema.prisma` para leer la URL desde la variable de entorno `DATABASE_URL`:
   ```prisma
   datasource db {
     provider = "sqlite"
     url      = env("DATABASE_URL")
   }
   ```
2. Para seguir desarrollando en local sin problemas, agrega `DATABASE_URL="file:./dev.sqlite"` en tu `.env` local.
3. En producción, apunta `DATABASE_URL` a una ubicación persistente (`file:/data/prod.sqlite` en Docker o `file:./prod.sqlite` sin Docker).

> **Advertencia importante para Docker:** **no** montes un volumen vacío directamente sobre `/app/prisma`. Si lo haces, el volumen ocultará los archivos `/app/prisma/schema.prisma` y `/app/prisma/migrations` incluidos en la imagen y fallará `npm run setup` (`prisma migrate deploy`). Monta el volumen en una carpeta aparte como `/data` y usa `DATABASE_URL="file:/data/prod.sqlite"`.

#### Opción B — PostgreSQL (si usas un PaaS efímero o varias réplicas)
Si tu proveedor no ofrece disco persistente o escalará múltiples instancias, cambia el proveedor en `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

*(Recuerda regenerar las migraciones de Prisma para PostgreSQL antes de construir la imagen o desplegar.)*

### 0.3 Configurar `shopify.app.toml` y publicar la Function en Shopify (desde tu PC local)
1. Edita `shopify.app.toml` reemplazando `https://example.com` por tu dominio HTTPS real e incluye las rutas de callback de OAuth usadas por `@shopify/shopify-app-react-router` (`authPathPrefix: "/auth"` en `app/shopify.server.js` y `app/routes/auth.$.jsx`):

   ```toml
   application_url = "https://pagos.tudominio.com"
   ...
   [auth]
   redirect_urls = [
     "https://pagos.tudominio.com/auth/callback",
     "https://pagos.tudominio.com/auth/shopify/callback",
     "https://pagos.tudominio.com/api/auth/callback"
   ]
   ```

2. Desde tu máquina local (con Rust `wasm32-unknown-unknown` y Shopify CLI), compila la Function y publica la versión en Shopify:

   ```bash
   cd extensions/personalizacion-pagos
   cargo build --target=wasm32-unknown-unknown --release
   cd ../..
   shopify app deploy
   ```

   *(En Windows PowerShell, si la política de ejecución bloquea scripts `.ps1`, utiliza `shopify.cmd app deploy`.)*

### 0.4 Obtener credenciales y preparar el `.env` de producción
Obtén `SHOPIFY_API_KEY` (Client ID) y `SHOPIFY_API_SECRET` (Client Secret) ejecutando en tu PC local:

```bash
shopify app env show
```

*(También puedes verlos en **Shopify Partners Dashboard → Apps → app-metodos-pago → Settings / Overview**).*

Prepara un archivo `.env` con el siguiente contenido para subirlo o crearlo en tu servidor:

```env
NODE_ENV=production
PORT=3000
SHOPIFY_API_KEY=tu_client_id_de_shopify
SHOPIFY_API_SECRET=tu_client_secret_de_shopify
SHOPIFY_APP_URL=https://pagos.tudominio.com
SCOPES=read_products,write_payment_customizations

# Con Docker (SQLite en volumen montado en /data):
DATABASE_URL="file:/data/prod.sqlite"

# Sin Docker (SQLite relativo a prisma/ en el servidor):
# DATABASE_URL="file:./prod.sqlite"

# Opcional: solo si usas un dominio personalizado para la tienda
# SHOP_CUSTOM_DOMAIN=mitienda.com
```

---

## Opción 1: Despliegue CON Docker

El proyecto ya incluye un `Dockerfile` basado en `node:22-alpine` con `openssl`, que compila el frontend/backend con `npm run build` y arranca ejecutando `npm run docker-start` (`prisma generate && prisma migrate deploy && react-router-serve ./build/server/index.js`).

### Prerrequisitos en el servidor
- **Docker Engine** y el plugin **Docker Compose** instalados (`docker --version` y `docker compose version`).
- Al menos **1–2 GB de RAM** (o swap) si vas a construir la imagen (`docker compose build`) directamente en el servidor.

### 1.1 Ajustar `.dockerignore` (recomendado)
Antes de subir o construir la imagen, agrega estas líneas a `.dockerignore` para evitar copiar secretos o la base de datos local dentro del contenedor:

```text
.cache
.env
.shopify
build
node_modules
prisma/*.sqlite
prisma/*.sqlite-journal
```

### 1.2 Subir el proyecto al servidor y crear `.env`
Conéctate por SSH al servidor, clona o sube el repositorio (por ejemplo en `/opt/app-metodos-pago`) y crea el archivo `.env` del Paso 0.4 con `DATABASE_URL="file:/data/prod.sqlite"`:

```bash
sudo mkdir -p /opt/app-metodos-pago
cd /opt/app-metodos-pago
# Clona tu repo o copia los archivos (sin node_modules ni build)
git clone <URL_DE_TU_REPO> .

nano .env
chmod 600 .env
```

### 1.3 Variante A (Recomendada): `docker compose` + Caddy con HTTPS automático
Caddy obtiene y renueva automáticamente los certificados TLS de Let's Encrypt sin configuración manual de Nginx ni Certbot.

1. Crea `Caddyfile` en `/opt/app-metodos-pago/Caddyfile`:
   ```caddyfile
   pagos.tudominio.com {
       reverse_proxy app:3000
   }
   ```
   *(Caddy reenvía automáticamente `Host`, `X-Forwarded-For` y `X-Forwarded-Proto` y no agrega `X-Frame-Options` que bloquee el iframe en Shopify Admin.)*

2. Crea `compose.yaml` en `/opt/app-metodos-pago/compose.yaml`:
   ```yaml
   services:
     app:
       build: .
       container_name: app-metodos-pago
       restart: unless-stopped
       env_file:
         - .env
       volumes:
         - app_data:/data
       expose:
         - "3000"

     caddy:
       image: caddy:2-alpine
       container_name: app-metodos-pago-caddy
       restart: unless-stopped
       depends_on:
         - app
       ports:
         - "80:80"
         - "443:443"
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy_data:/data
         - caddy_config:/config

   volumes:
     app_data:
     caddy_data:
     caddy_config:
   ```

3. Construye y levanta los servicios:
   ```bash
   docker compose up -d --build
   ```

4. Verifica que Prisma aplicó las migraciones y el servidor arrancó escuchando en el puerto `3000`:
   ```bash
   docker compose logs -f app
   ```

5. **Cómo actualizar en el futuro:**
   ```bash
   cd /opt/app-metodos-pago
   git pull
   docker compose up -d --build
   ```
   *(El volumen `app_data` conserva intacto `/data/prod.sqlite` entre reconstrucciones.)*

### 1.4 Variante B: `docker build` + `docker run` directo (si ya tienes Nginx en el host)
Si tu servidor ya usa Nginx para otros sitios y solo quieres correr el contenedor expuesto localmente:

```bash
cd /opt/app-metodos-pago

docker build -t app-metodos-pago:latest .

docker volume create app_metodos_data

docker run -d \
  --name app-metodos-pago \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  -v app_metodos_data:/data \
  app-metodos-pago:latest
```

Luego configura Nginx con Certbot siguiendo el **Paso 2.5** para exponer `http://127.0.0.1:3000` por HTTPS.

---

## Opción 2: Despliegue SIN Docker (Node.js directo en Linux)

Recomendada si prefieres administrar el proceso directamente con **systemd** o **PM2** detrás de **Nginx + Certbot**.

### Prerrequisitos en el servidor (Ubuntu / Debian)
Instala las herramientas base, `openssl`, `nginx`, `certbot` y **Node.js 22 LTS** (`>= 22.12` requerido por `package.json`):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git openssl nginx certbot python3-certbot-nginx

# Instalar Node.js 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # Debe mostrar v22.12.0 o superior
npm -v
```

### 2.1 Swap opcional (recomendado en VPS con 512 MB – 1 GB de RAM)
Para evitar que `npm run build` (Vite) se quede sin memoria durante la compilación en un VPS pequeño, crea 2 GB de swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 2.2 Subir el código y crear `.env`
```bash
sudo mkdir -p /var/www/app-metodos-pago
sudo chown -R $USER:$USER /var/www/app-metodos-pago
cd /var/www/app-metodos-pago

# Clona el repositorio o sube los archivos mediante scp/rsync (sin node_modules ni build)
git clone <URL_DE_TU_REPO> .

nano .env
chmod 600 .env
```

Asegúrate de usar en `.env`:
```env
DATABASE_URL="file:./prod.sqlite"
```

### 2.3 Instalar dependencias, migrar la base de datos y compilar
Ten en cuenta que `vite` y herramientas de build están en `devDependencies`, por lo que primero se instalan todas las dependencias para compilar y luego se limpian las de desarrollo:

```bash
cd /var/www/app-metodos-pago
npm ci
npm run setup    # Ejecuta: prisma generate && prisma migrate deploy
npm run build    # Compila el cliente y el servidor SSR en ./build
npm prune --omit=dev
```

### 2.4 Ejecutar la aplicación en segundo plano (systemd o PM2)

> **Advertencia clave sobre `.env`:** el script `npm run start` (`react-router-serve ./build/server/index.js`) **no** carga automáticamente el archivo `.env`. Debes inyectar las variables con `EnvironmentFile=` en `systemd` o con `--env-file=.env` en Node 22 / PM2.

#### Alternativa A: `systemd` (nativo de Linux, sin dependencias extra)
1. Verifica la ruta real de `npm` (`which npm`, normalmente `/usr/bin/npm`).
2. Crea el archivo `/etc/systemd/system/app-metodos-pago.service`:
   ```ini
   [Unit]
   Description=App Metodos de Pago Shopify (React Router SSR)
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/var/www/app-metodos-pago
   EnvironmentFile=/var/www/app-metodos-pago/.env
   ExecStart=/usr/bin/npm run start
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
3. Ajusta permisos para el usuario `www-data`, habilita y arranca el servicio:
   ```bash
   sudo chown -R www-data:www-data /var/www/app-metodos-pago
   sudo chmod 600 /var/www/app-metodos-pago/.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now app-metodos-pago
   sudo systemctl status app-metodos-pago
   ```
   Para ver logs en vivo: `sudo journalctl -u app-metodos-pago -f`.

#### Alternativa B: `PM2`
Si prefieres PM2 con Node 22:

```bash
sudo npm install -g pm2
cd /var/www/app-metodos-pago

pm2 start ./node_modules/.bin/react-router-serve \
  --name app-metodos-pago \
  --interpreter node \
  --node-args="--env-file=.env" \
  -- ./build/server/index.js

pm2 save
pm2 startup   # Ejecuta el comando que imprima PM2 para habilitar el arranque automático
```

### 2.5 Configurar Reverse Proxy HTTPS con Nginx + Certbot
1. Crea `/etc/nginx/sites-available/app-metodos-pago`:
   ```nginx
   server {
       listen 80;
       server_name pagos.tudominio.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
       }
   }
   ```
   > **Importante:** **no** agregues cabeceras `X-Frame-Options: DENY` ni `X-Frame-Options: SAMEORIGIN` en Nginx, ya que la app se abre embebida dentro de un `<iframe>` en el Admin de Shopify (la app ya configura `Content-Security-Policy` por tienda mediante `addDocumentResponseHeaders`).

2. Activa el sitio y verifica la sintaxis:
   ```bash
   sudo ln -s /etc/nginx/sites-available/app-metodos-pago /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. Emite el certificado SSL/HTTPS gratuito con Certbot:
   ```bash
   sudo certbot --nginx -d pagos.tudominio.com
   ```
   Certbot configurará la redirección HTTP → HTTPS y la renovación automática.

### 2.6 Cómo actualizar sin Docker
```bash
cd /var/www/app-metodos-pago
git pull
npm ci
npm run setup
npm run build
npm prune --omit=dev

# Si usas systemd:
sudo systemctl restart app-metodos-pago

# Si usas PM2:
# pm2 restart app-metodos-pago
```

---

## Paso final: Instalar en la tienda y verificación

### 1. Instalar la app en la tienda (1 tienda / Custom distribution)
1. Ingresa al **Shopify Partners Dashboard** → **Apps** → **app-metodos-pago**.
2. Ve a **Distribution** → **Choose distribution** → selecciona **Custom distribution** (si la tienda es Shopify Plus o quieres instalarla de forma privada en una sola tienda; si es un plan Standard/Basic/Advanced que no admita Custom distribution, usa distribución pública con visibilidad limitada / *Unlisted* tras revisión).
3. Ingresa el dominio `.myshopify.com` de tu tienda y genera el **enlace de instalación**.
4. Abre ese enlace desde la sesión de administrador de la tienda, acepta los permisos (`read_products`, `write_payment_customizations`) y verifica que carga el panel de reglas sin errores.
5. Activa la personalización en el checkout desde el panel principal de la app (`/app`).

---

## Solución de problemas frecuentes

| Problema | Causa probable | Solución |
| --- | --- | --- |
| `redirect_uri is not whitelisted` al instalar | `redirect_urls` en `shopify.app.toml` no coincide con el callback real | Verifica las 3 URLs del Paso 0.3 en `shopify.app.toml` y vuelve a ejecutar `shopify app deploy`. |
| El panel queda en blanco o rechazado dentro de Shopify Admin | El proxy (Nginx/Cloudflare) está inyectando `X-Frame-Options: DENY` o `SAMEORIGIN` | Elimina `X-Frame-Options` de la configuración del servidor proxy o WAF. |
| Error al arrancar indicando `SHOPIFY_API_KEY` indefinida | `react-router-serve` se ejecutó sin leer `.env` | Usa `EnvironmentFile=` en `systemd`, `--node-args="--env-file=.env"` en PM2 o `--env-file .env` en Docker. |
| Al reiniciar Docker vuelve a pedir OAuth / pierde sesiones | El contenedor SQLite no tiene volumen persistente o montaste `/app/prisma` directamente | Usa `DATABASE_URL="file:/data/prod.sqlite"` y monta el volumen únicamente en `/data`. |
| Cambié código del panel React vs. cambié código Rust de la Function | No saber qué desplegar en cada caso | Si cambias rutas/UI en `app/`, solo actualiza tu servidor. Si cambias `extensions/personalizacion-pagos/` o `shopify.app.toml`, debes ejecutar `shopify app deploy` desde local. |
