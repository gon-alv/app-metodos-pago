# App Personalización de Métodos de Pago (`app-metodos-pago`)

Aplicación embebida de Shopify que permite definir reglas dinámicas para **ocultar o restringir los métodos de pago mostrados al cliente en el checkout**, evaluando los campos estándar y metacampos de los productos presentes en el carrito mediante una **Shopify Function en Rust** (`cart.payment-methods.transform.run`, API `2026-07`).

---

## Funcionalidades principales

### 1. Acciones de visibilidad en el checkout
Cada regla aplica una acción sobre los métodos de pago disponibles en el checkout:
- **Ocultar métodos seleccionados (`hide_selected`)**: oculta los métodos que coincidan con los patrones indicados.
- **Mostrar solo los seleccionados (`allow_only_selected`)**: oculta todos los demás métodos del checkout, dejando visibles únicamente los seleccionados.

**Ejemplos de uso incluidos como plantillas de 1 clic:**
- Si `tag = "reacondicionado"` → mostrar solo `"Transferencia directa"` (oculta el resto).
- Si `tag = "servicio-tecnico"` → ocultar `"Pago en tienda"`.

### 2. Condiciones sobre productos y metacampos
- **Lógica por producto**: combina múltiples condiciones con **Y (`all`)** o **O (`any`)**.
- **Alcance en el carrito**:
  - `any`: la regla se activa si **al menos un producto** del carrito cumple las condiciones.
  - `all`: la regla se activa solo si **todos los productos** del carrito las cumplen.
- **Campos soportados**:
  - Estándar: Etiqueta (`tag`), Colección (`collection`), Precio unitario (`price`), Tipo de producto (`product_type`), Proveedor (`vendor`), SKU de variante (`sku`) y Título del producto (`title`).
  - Metacampos de producto (`metafield`): seleccionables desde las definiciones de la tienda o ingresando `namespace` y `key` manualmente (hasta **4 metacampos distintos** activos en paralelo).
- **Operadores**:
  - Texto: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with` (insensibles a mayúsculas, minúsculas, tildes y espacios al inicio/final).
  - Pertenencia: `in`, `not_in` (para colecciones y etiquetas).
  - Presencia: `is_empty`, `is_not_empty`.
  - Numéricos: `equals`, `not_equals`, `gt`, `gte`, `lt`, `lte` (para `price` y valores de metacampos numéricos).

### 3. Resolución acumulativa y protección anti-bloqueo (`failSafe`)
- **Evaluación acumulativa**: cuando un carrito activa más de una regla simultáneamente, se combinan todas sus restricciones (cualquier método ocultado o excluido por al menos una regla queda oculto).
- **Protección anti-bloqueo (`failSafe`)**: activada por defecto. Si la combinación de reglas llegara a ocultar **todos** los métodos de pago disponibles en el checkout (dejando 0 opciones), la Function devuelve `operations: []` para no bloquear la compra del cliente.

### 4. Catálogo reutilizable de métodos de pago
Dado que la Admin API de Shopify no expone la lista de métodos de pago activos del checkout, la app mantiene un catálogo reutilizable donde defines cada método con su nombre visible y patrón de coincidencia:
- **Contiene texto (`contains`)**: recomendado; coincide si el nombre en checkout incluye el texto (ej. `"transferencia directa"`).
- **Nombre exacto (`exact`)**: coincide exactamente (insensible a mayúsculas, tildes y espacios).

#### Equivalencias automáticas para métodos nativos de Shopify
Aunque Shopify envía internamente sus métodos manuales/nativos en inglés a la Function, la app reconoce automáticamente sus equivalentes en español (ignorando mayúsculas, tildes y espacios):

| Nombre interno de Shopify | Equivalente(s) en español reconocidos |
| --- | --- |
| `Bank Deposit` | `Depósito bancario` |
| `Money Order` | `Giro postal` |
| `Cash on Delivery (COD)` | `Pago contra entrega (COD)`, `Pago contra entrega` |
| `Cash on Delivery` | `Pago contra entrega` |
| `Gift card` | `Tarjeta de regalo` |
| `Deferred` | `Pago diferido` |
| `(for testing) Bogus Gateway` | `(para pruebas) pasarela simulada`, `Pasarela simulada` |

### 5. Vistas de la aplicación (`/app`)
- **Panel principal (`app/routes/app._index.jsx`)**: activar/pausar la personalización en el checkout, activar/desactivar la protección anti-bloqueo, cargar reglas de ejemplo, gestionar reglas (editar, activar/pausar, duplicar, eliminar) y monitorear los límites de Shopify Functions en tiempo real.
- **Editor de reglas (`app/routes/app.rules.$ruleId.jsx`)**: constructor de condiciones con autocompletado de etiquetas, tipos, proveedores, colecciones y definiciones de metacampos de la tienda, selector de métodos guardados, agregado rápido de métodos personalizados y vista previa legible en español.
- **Catálogo de métodos de pago (`app/routes/app.methods.jsx`)**: alta, eliminación y restauración de métodos sugeridos reutilizables en las reglas.

---

## Arquitectura técnica

### Stack
- **App embebida**: React Router v7, React 18, App Bridge v4 y Polaris Web Components v2 (`@shopify/polaris-types`).
- **Base de datos de sesiones**: Prisma + SQLite (`prisma/schema.prisma`, modelo `Session` para desarrollo local).
- **Shopify Function**: Rust (`shopify_function` 2.3.0) compilado a WebAssembly (`wasm32-unknown-unknown`) en `extensions/personalizacion-pagos`.

### Almacenamiento en Shopify (`$app:payment-filter`)
Toda la configuración vive en 3 metafields de tipo `json` asociados al propietario `PaymentCustomization`, escritos de forma atómica desde `app/services/payment-customization.server.js`:
1. `ui-config`: configuración completa para la interfaz (incluye reglas pausadas, etiquetas legibles y catálogo de métodos). La Function no lo consulta.
2. `rules-config`: configuración mínima compilada solo con las reglas activas y los índices de slot de metacampos (`0..3`), leída por la Function vía `jsonValue`.
3. `input-vars`: variables de entrada vinculadas mediante `input_variables` en `shopify.extension.toml` con las 10 claves fijas de la consulta GraphQL (`watchedTags`, `watchedCollections`, `mf0Ns`/`mf0Key` … `mf3Ns`/`mf3Key`).

### Permisos y límites
- **Scopes requeridos (`shopify.app.toml`)**: `read_products`, `write_payment_customizations`.
- **Presupuesto de Shopify Functions**:
  - Máximo **4 metacampos de producto** distintos entre todas las reglas activas (las reglas pausadas no consumen espacios).
  - Máximo **100 etiquetas** únicas (`watchedTags`) y **100 colecciones** únicas (`watchedCollections`) activas.
  - Tamaño seguro máximo de `rules-config`: **9,800 bytes** UTF-8 (límite de plataforma: 10,000 bytes).
  - Costo de la input query (`cart_payment_methods_transform_run.graphql`): **29 / 30**.

### Estructura principal del proyecto
```text
app/
├── lib/
│   ├── payment-rules.js                # Esquema, validadores, plantillas y compilador de metafields
│   └── payment-rules.test.js           # Tests unitarios del compilador y validadores
├── routes/
│   ├── app.jsx                         # Layout embebido y navegación (/app, /app/methods)
│   ├── app._index.jsx                  # Panel principal de reglas y estado en checkout
│   ├── app.rules.$ruleId.jsx           # Editor/creador de reglas
│   └── app.methods.jsx                 # Catálogo de métodos de pago
└── services/
    └── payment-customization.server.js # Lectura y guardado GraphQL Admin (2026-07)

extensions/personalizacion-pagos/
├── shopify.extension.toml              # Target cart.payment-methods.transform.run e input_variables
├── src/
│   ├── main.rs                         # Registro de schema y custom_scalar_overrides
│   ├── cart_payment_methods_transform_run.graphql
│   └── cart_payment_methods_transform_run.rs
└── tests/
    ├── default.test.js                 # Runner Vitest sobre el binario WASM
    └── fixtures/                       # Casos de prueba JSON de integración
```

---

## Desarrollo local y pruebas

### Prerrequisitos
- **Node.js** `>= 22.12`
- **Shopify CLI** (`shopify`)
- **Rust** con el target `wasm32-unknown-unknown` instalado:
  ```powershell
  rustup target add wasm32-unknown-unknown
  ```

### Ejecutar en tienda de desarrollo
```powershell
shopify app dev
```

### Validaciones, compilación y tests
```powershell
# Compilar la Shopify Function a WebAssembly y ejecutar sus tests unitarios en Rust
cd extensions/personalizacion-pagos
cargo test
cargo build --target=wasm32-unknown-unknown --release

# Ejecutar tests de integración WASM con Vitest
npx vitest run
cd ../..

# Tests unitarios del compilador de reglas (Node)
node --test app/lib/payment-rules.test.js

# Build, lint, typecheck y validación de configuración Shopify
npm run build
npm run lint
npm run typecheck
shopify app config validate
```

*(En PowerShell de Windows, si la política de ejecución bloquea scripts `.ps1`, utiliza `npm.cmd`, `npx.cmd` y `shopify.cmd`.)*

---

## Despliegue y publicación (Unlisted / Custom)

Consulta la guía paso a paso en [DEPLOY.md](./DEPLOY.md) para ver cómo subir la aplicación a un servidor **con Docker** o **sin Docker** (Node.js + systemd/PM2 + Nginx/Caddy).

1. **Hosting de la app web**: `shopify app deploy` sube la configuración y el módulo `.wasm` de la Shopify Function, pero el servidor Node/React Router debe desplegarse en un hosting HTTPS propio (el proyecto incluye `Dockerfile`).
2. **Base de datos y webhooks de cumplimiento**: antes de publicar como app pública con visibilidad limitada (*Unlisted* / *Limited visibility*), configura una base de datos persistente para producción (por ejemplo PostgreSQL en `prisma/schema.prisma`) y agrega los webhooks obligatorios de privacidad (`customers/data_request`, `customers/redact`, `shop/redact`) en `shopify.app.toml`.
3. **Tipo de distribución**:
   - **Tiendas Basic / Shopify / Advanced**: requieren **Public distribution** (puedes configurarla como **Limit visibility / Unlisted** en el Partner Dashboard tras pasar la revisión de la App Store para que solo sea accesible por enlace directo).
   - **Tiendas Shopify Plus**: pueden usar **Custom distribution** sin pasar por revisión de la App Store.
