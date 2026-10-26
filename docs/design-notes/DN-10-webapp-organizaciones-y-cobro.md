# DN-10 — Webapp privada: cuentas, organizaciones, roles y cobro

**Estado:** diseño aprobado en conversación (2026-10-25); alcance de la demo en §10. Hay presentación mañana (2026-10-26). La §10 separa lo que tiene que funcionar para la demo de lo que solo queda preparado.
**Alcance:** Arca-back (todo el peso) y Arca-front (esqueleto mock). Ramas locales `feat/webapp-orgs`, creadas desde `feat/arca-modes`, porque se apoya en los modos de DN-09.
**Decisiones:** de Jesús, marcadas **[Jesús]**; del asistente, marcadas **[mía]** (revisables).

---

## 1. Por qué

Hoy el embudo es anónimo. `/quote` → scan → `/score` → deep assessment → resultados vive con un token temporal de 24 h y no pertenece a nadie. ARCA necesita una webapp privada donde una organización que paga vea y conserve su análisis de riesgo, y donde varias personas de la misma firma trabajen con permisos claros. **[Jesús]**

**El análisis de riesgo va primero.** La cuenta se crea **después** del deep assessment, nunca en frío. **[Jesús]**

## 2. Objetivos, no-objetivos, anti-objetivos

**Objetivos**
1. **Registro después de los resultados.** Al registrarse, el análisis anónimo (scan + assessment) se **reclama** y pasa a pertenecer a una organización nueva, con quien se registra como owner.
2. **Login con Supabase Auth** (magic link por email) y sesiones gestionadas por Supabase. **[Jesús]**
3. **Organizaciones con roles otorgables y permisos explícitos.** Los aplica el back en cada endpoint. **[Jesús]**
4. **Cobro por organización con Stripe**, como suscripción mensual o anual. El precio y los planes se configuran en la base de datos, nunca en el código. **[Jesús]**
5. **Pagar para entrar.** Sin suscripción activa, la webapp queda bloqueada, salvo lo necesario para pagar. **[Jesús]**
6. **Borrado con revisión humana.** El owner **solicita** borrar la organización; nada se borra hasta que una persona de ARCA lo apruebe. **[Jesús]**
7. **Cimientos para un panel de administración de ARCA:** rol de plataforma, auditoría, cola de solicitudes y planes editables. Sin construir la UI del panel. **[Jesús]**
8. **Front: un esqueleto funcional mock**, para recorrer el flujo en la demo. **[Jesús]**

**No-objetivos (por ahora)**
- Diseño, UI y UX finales: los pule otra persona. **[Jesús]**
- Login con Google: queda **preparado** (§4.1), no activado.
- Panel de administración de ARCA con UI.
- Precio definitivo, planes por número de usuarios, pruebas gratuitas, facturas propias.
- Subdominio `app.arcacover.com`: la app vive en Arca-front bajo `/app` mientras sea MVP, preparada para mudarse (§8). **[Jesús]**

**Anti-objetivos**
- Que alguien sin pagar vea datos de la app, aunque sea editando la URL o llamando a la API.
- Que el front decida permisos: el front solo refleja; el back es quien niega.
- Que se borre una organización, o sus datos legales, sin revisión humana.
- Que se pueda reclamar un análisis ajeno.
- Que el modo `mock` (DN-09) llame a Stripe o a Supabase Auth de verdad.

## 3. Flujo

```
/quote → scan → /score → /assessment → /assessment/results   (anónimo, como hoy)
                                             │
                                             ▼  CTA "Guarda tus resultados y activa tu cuenta"
                                   /app/signup  (email → magic link)
                                             │  al volver del magic link:
                                             ▼
                POST /orgs  { name }  + Bearer de Supabase + X-Arca-Scan-Token del scan
                → crea la organización, al usuario como owner y reclama scan + assessment
                                             │
                                             ▼
                          /app/billing → Stripe Checkout → webhook → org activa
                                             │
                                             ▼
                                     /app  (panel de la organización)
```

**Usuario con cuenta.** Hace login (magic link) y entra **directo al panel** de su organización. Toda cuenta pertenece al menos a una organización. **[Jesús]** Si pertenece a varias, elige una; la última usada queda recordada.

**Invitados.** Un owner o admin invita por email y con un rol. La persona recibe un enlace, hace login con magic link y la invitación se acepta. No pasa por el embudo ni por el pago: la organización ya paga. **[mía]**

**Botón principal del sitio** ("Get a quote" y similares): siempre lleva a `/quote`. El registro solo se ofrece al terminar los resultados. **[Jesús]**

## 4. Backend

### 4.1 Autenticación (Supabase Auth)

- **El front** usa `@supabase/supabase-js` con la clave *anon* para `signInWithOtp` (magic link) y para mantener la sesión (refresh incluido).
- **El back** no gestiona contraseñas ni sesiones propias:
  - verifica en cada petición el `Authorization: Bearer <access_token de Supabase>`, un JWT firmado por el proyecto;
  - **[mía]** lo hace con `jose`, contra el JWKS del proyecto o, si el proyecto usa secreto compartido, con `SUPABASE_JWT_SECRET`;
  - comprueba `aud = authenticated`, la expiración y `sub` = user id.
- **Google** queda listo para el futuro: es activar el proveedor en Supabase y añadir un botón. El back no cambia, porque solo ve un JWT de Supabase.
- **Dos tokens, sin mezclarlos.** El token de sesión **del scan** (DN-01) sigue igual, para el embudo anónimo. El de Supabase es para la webapp.
- **Modo `mock` (DN-09).** No hay Supabase Auth real:
  - `POST /__debug/auth/login { email, platformAdmin? }`, que existe **solo en `mock`**, emite un JWT firmado con un secreto local, con el mismo formato y claims (en `live-debug` el login es el real de Supabase);
  - el verificador del back acepta ese emisor **solo** en mock;
  - en producción, ese emisor y esa ruta no existen.

### 4.2 Modelo de datos (migración nueva en `supabase/migrations/`)

`auth.users` es de Supabase. Las tablas nuevas van en `public`, con RLS activado y sin acceso para `anon` ni `authenticated`: solo el back, con la clave de servicio, como las tablas actuales.

| Tabla | Columnas clave | Notas |
|---|---|---|
| `profiles` | `user_id` (PK → `auth.users`), `email`, `full_name`, `last_org_id`, `created_at` | Datos propios del usuario |
| `organizations` | `id`, `name`, `domain`, `billing_status`, `deleted_at`, `created_by`, `created_at` | `billing_status`: `pending_payment`, `active`, `past_due`, `canceled`; solo lo cambia el webhook. El ciclo de vida va aparte: una solicitud pendiente vive en `deletion_requests` y el borrado aprobado pone `deleted_at` [mía] |
| `memberships` | `org_id`, `user_id`, `role`, `invited_by`, `created_at`; PK (`org_id`, `user_id`) | `role`: `owner`, `admin`, `member`, `viewer`. Siempre queda al menos un owner (trigger o check en la RPC) |
| `invitations` | `id`, `org_id`, `email`, `role`, `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at` | Se guarda solo el hash del token; caduca a los 7 días [mía] |
| `org_analyses` | `org_id`, `scan_id` (UNIQUE), `assessment_id`, `claimed_by`, `claimed_at` | Un scan solo se reclama una vez |
| `claim_tickets` | `id_hash`, `scan_id`, `email`, `expires_at`, `used_at` | Puente del embudo anónimo al registro (§4.7): sobrevive al magic link aunque se abra en otra pestaña o dispositivo [mía] |
| `plans` | `id`, `code`, `name`, `amount_cents`, `currency`, `interval` (`month`/`year`), `active`, `created_at` | El precio vive **solo** aquí: el checkout le pasa a Stripe el importe con `price_data`, así que cambiar la tabla cambia el cobro sin tocar Stripe [mía]. Sembrado con planes de ejemplo |
| `subscriptions` | `org_id` (PK), `plan_id`, `stripe_customer_id`, `stripe_subscription_id`, `status`, `current_period_end`, `updated_at` | Lo escribe solo el webhook de Stripe |
| `stripe_events` | `id` (el id del evento de Stripe), `type`, `received_at`, `processed_at` | Idempotencia: un evento repetido no se procesa dos veces |
| `deletion_requests` | `id`, `org_id`, `requested_by`, `reason`, `status` (`pending`, `approved`, `rejected`), `reviewed_by`, `reviewed_at`, `review_note` | La cola para la revisión humana |
| `platform_admins` | `user_id` (PK), `granted_by`, `created_at` | Personas de ARCA. Rol de plataforma, separado de los roles de organización |
| `audit_log` | `id`, `actor_user_id`, `org_id`, `action`, `target`, `data` (jsonb), `created_at` | Solo admite añadir filas, como `assessment_answer_events` |

**Los resultados reclamados no caducan.** El assessment anónimo devuelve 410 a las 24 h, pero una organización lee sus análisis por pertenencia y no por el token del scan. El back lee el `result` congelado directamente del repositorio. **[mía]**

### 4.3 Roles y permisos

Hay una sola tabla de permisos en código (`permissions.ts`) y un helper `requirePermission(orgId, permission)` en cada ruta. **[Jesús + mía]**

| Permiso | owner | admin | member | viewer |
|---|---|---|---|---|
| `org.read`: panel, análisis, resultados | ✓ | ✓ | ✓ | ✓ |
| `analysis.create`: lanzar un nuevo scan o assessment para la organización | ✓ | ✓ | ✓ | — |
| `members.invite` / `members.remove` / `members.set_role` | ✓ | ✓ (no puede tocar owners ni dar `owner`) | — | — |
| `billing.manage`: checkout, portal de Stripe | ✓ | — | — | — |
| `org.transfer_ownership` | ✓ | — | — | — |
| `org.request_deletion` | ✓ | — | — | — |

- Lo que la matriz no permite se responde con **403**.
- Cada cambio de rol, invitación, eliminación de miembro o solicitud de borrado escribe en `audit_log`.
- `platform_admin` no es un rol de organización. Habilita las rutas `/admin/*` (§4.6).

### 4.4 Cobro (Stripe)

- **Checkout.** `POST /orgs/:id/billing/checkout { planCode }` (`billing.manage`) crea un Checkout Session de Stripe en modo `subscription`, con `price_data` (importe, moneda e intervalo leídos de `plans`), y devuelve la URL.
- **Portal.** `POST /orgs/:id/billing/portal` (`billing.manage`) devuelve la URL del Customer Portal, para cancelar o cambiar el método de pago.
- **Webhook.** `POST /billing/webhook` es público, pero **verifica la firma** con `STRIPE_WEBHOOK_SECRET`. Procesa:
  - `checkout.session.completed`;
  - `customer.subscription.created`, `customer.subscription.updated` y `customer.subscription.deleted`;
  - `invoice.payment_failed`.

  Con ellos actualiza `subscriptions` y `organizations.billing_status`, y nunca toca el borrado. Es idempotente por `stripe_events`.
- **Planes.** `GET /plans` es público y devuelve los planes activos (nombre, precio, intervalo). El precio se cambia en la tabla `plans` (o con `PUT /admin/plans`) y el siguiente checkout ya lo usa.
- **Modo `mock` (DN-09).** Sin Stripe real: el checkout devuelve una URL local `/app/billing/mock-success` y activa la suscripción en memoria. La demo puede usar **Stripe en modo test**, si hay claves de test, en `live-debug`.

### 4.5 Bloqueo hasta pagar

- **Rutas protegidas.** Todas las rutas de datos de la webapp (`/orgs/:id/...`, salvo `billing/*`, `deletion-request` y la lectura mínima de la organización) exigen `billing_status` en (`active`, `past_due`). Si no, **402** `payment_required`.
- **Solicitud de borrado pendiente:** el acceso sigue igual, con un aviso. **Organización borrada** (`deleted_at`): **410** en todo. [mía]
- **`past_due`** sigue entrando, con un aviso; no se bloquea a un cliente por un pago fallido puntual. **[mía]**
- **En el front**, `/app` redirige a `/app/billing` ante un 402. El bloqueo real es el del back.

### 4.6 Cimientos del panel de ARCA (sin UI)

Hay rutas `/admin/*` que solo responden a `platform_admins`:
- `GET /admin/organizations`;
- `GET /admin/deletion-requests`;
- `POST /admin/deletion-requests/:id/approve` y `/reject`;
- `GET` y `PUT /admin/plans`.

Para la demo bastan los endpoints, probados con tests. La UI del panel es trabajo futuro. **Quién es admin de plataforma:** se otorga con un script del back (`npm run admin:grant -- <email>`); en `mock`, con `platformAdmin: true` en el login simulado. **Aprobar un borrado** pone `deleted_at` y cancela la suscripción en Stripe. **Rechazarlo** solo cierra la solicitud: el estado de cobro nunca cambió. El borrado físico de datos queda fuera de alcance, por implicaciones legales. **[mía]**

### 4.7 Endpoints (resumen)

| Método y ruta | Auth | Qué hace |
|---|---|---|
| `GET /me` | Supabase | Usuario y organizaciones con su rol |
| `POST /claims` | `X-Arca-Scan-Token` (token del scan) | Emite un ticket de reclamo de un solo uso (24 h) para ese scan y su email |
| `POST /orgs` | Supabase + `claimId` | Crea la organización, el owner y reclama el análisis |
| `POST /orgs/:id/analyses` | `analysis.create` + pago + `claimId` | Añade un análisis nuevo a una organización existente |
| `GET /orgs/:id` | miembro | Organización, estado de la suscripción y tu rol (sin bloqueo por pago) |
| `GET /orgs/:id/analyses` | `org.read` + pago | Análisis reclamados, con sus resultados |
| `GET/POST/PATCH/DELETE /orgs/:id/members…` | según la matriz + pago | Miembros, roles e invitaciones |
| `POST /invitations/:token/accept` | Supabase | Acepta una invitación |
| `POST /orgs/:id/billing/checkout`, `/portal` | `billing.manage` | Stripe |
| `POST /billing/webhook` | firma de Stripe | Estado de la suscripción |
| `GET /plans` | pública | Planes activos |
| `POST /orgs/:id/deletion-request` | `org.request_deletion` | Pasa a `deletion_requested` |
| `/admin/*` | `platform_admin` | Cimientos del panel de ARCA |
| `POST /__debug/auth/login` | solo mock | Login simulado (§4.1) |

**Reclamar el análisis [mía].** Va en dos pasos, para que sobreviva al magic link (que puede abrirse en otra pestaña o dispositivo) sin guardar el token del scan fuera de `sessionStorage`:
1. En los resultados, `POST /claims` con el token del scan devuelve un `claimId` aleatorio de un solo uso, válido 24 h. El back guarda su hash, el `scan_id` y el email del scan.
2. El magic link vuelve con `?claim=<claimId>`. Ya con sesión, `POST /orgs { name, claimId }` (o `POST /orgs/:id/analyses { claimId }`) comprueba que:
   - el ticket existe, no caducó y no se usó;
   - el email del ticket coincide con el del usuario de Supabase, sin distinguir mayúsculas (el registro lleva ese email prefijado y bloqueado);
   - el scan está COMPLETED o PARTIAL, está en almacenamiento durable (un scan con fallo inyectado, que vive en memoria, da **409**) y no fue reclamado ya (`org_analyses.scan_id` UNIQUE).

Si falla una condición, la organización **no** se crea. Un scan puede reclamarse aunque no tenga assessment.

**Cuenta sin organización.** Si un reclamo falla, la cuenta de Supabase ya existe pero no tiene organización. `/app` le muestra "Completa un análisis para crear tu organización", con enlace a `/quote`. `/app/login` nunca crea usuarios (`shouldCreateUser: false`); solo el registro desde los resultados los crea.

**Cliente que ya tiene organización.** Si repite el embudo con sesión iniciada, el CTA de resultados ofrece **añadir el análisis a su organización** (`analysis.create`) en vez de crear otra.

### 4.8 Configuración nueva

| Variable | Dónde | Para qué |
|---|---|---|
| `SUPABASE_JWT_SECRET` o la URL del JWKS | back | Verificar los JWT de Supabase |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | back | Stripe (claves de test para la demo) |
| `APP_BASE_URL` | back | Para las URL de retorno de Stripe y los enlaces de invitación |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | front | Supabase Auth en el navegador (ya existen en el `.env.example`) |
| `NEXT_PUBLIC_APP_BASE_PATH` | front | `/app` hoy; preparado para mudarse a un subdominio |

En `mock` no hace falta ninguna de las claves. Todas siguen las reglas de DN-09: el back reporta en `/__debug/mode` si Stripe y Auth están en uso, sin revelar valores.

## 5. Front (esqueleto funcional mock)

- **Rutas nuevas bajo `/app`:**
  - `/app/signup`: email → magic link; vuelve a crear la organización con el análisis.
  - `/app/login`.
  - `/app/billing`: planes y botón de pago.
  - `/app`: panel con los análisis reclamados (scores, dominios, plan de acción, reutilizando los componentes que ya existen).
  - `/app/members`: lista, invitar, cambiar rol y quitar.
  - `/app/settings`: datos de la organización y "Solicitar eliminación".
  - `/app/invite/[token]`.
- **En `/assessment/results`:** un CTA "Save your results and activate your account" que lleva a `/app/signup` y conserva el token del scan.
- **Sin diseño:** componentes simples con los tokens de la marca. Los botones que el rol no permite se ocultan o se deshabilitan en producción, pero **el back es el que niega**. En los modos de debug (guarda literal de DN-09) se muestran activos, para que la demo enseñe el 403 del back. [mía]
- **El código de la app** vive en carpetas propias: `app/app/...`, `components/app/...` y `lib/app/...`.

## 6. Seguridad

| Amenaza | Defensa |
|---|---|
| Entrar sin pagar | 402 en el back en cada ruta de datos; el front solo redirige |
| Escalar privilegios | Matriz en el back; un admin no puede tocar owners ni dar `owner`; siempre queda al menos un owner |
| Reclamar el análisis de otro | Token del scan, email coincidente, un solo reclamo |
| Webhook de Stripe falso | Verificación de la firma; idempotencia |
| JWT falso o caducado | Verificación de la firma, `aud` y `exp`; el emisor mock solo existe en mock |
| Borrado malicioso o accidental | Solo solicitud, con revisión humana y auditoría |
| Invitación robada | Solo se guarda el hash del token, con expiración de 7 días; se acepta con el login del email invitado |
| Fuga de datos entre organizaciones | Cada consulta filtra por `org_id` de una membresía verificada; tests de "otra organización da 404" |

## 7. Tests

**Back:**
- **Unitarios:** la matriz de permisos completa, celda por celda.
- **Integración** (como `debug-mode.test.ts`):
  - registro y reclamo (ok, email distinto, ya reclamado, scan FAILED);
  - 402 antes de pagar y 200 después del webhook;
  - el webhook con una firma inválida da 400, y un evento repetido no hace nada;
  - cada rol contra cada ruta (403);
  - aislamiento entre organizaciones;
  - la solicitud de borrado no borra nada;
  - el admin de plataforma aprueba;
  - en producción, las rutas `/__debug/auth/*` dan 404.
- **Migración:** se aplica en PGlite, como `assessment-database.test.ts`.

**Front:** tests de redirección (402 → `/app/billing`, sin sesión → `/app/login`) y el recorrido de la demo en navegador, en mock.

## 8. Mudanza futura a `app.arcacover.com`

Se recomienda cuando la app tenga usuarios reales. Separa riesgos, aísla las cookies, permite cabeceras de seguridad (CSP) más estrictas y da despliegues independientes. Para que mudarla sea barato:
- todo el código de la app vive en sus carpetas;
- la base de la ruta y la URL de la app vienen de variables;
- el back no asume que el front vive en el mismo origen.

## 9. Decisiones tomadas por el asistente (revisar)

1. El back verifica el JWT de Supabase con `jose` (JWKS o secreto) en vez de llamar a `auth.getUser` en cada petición.
2. Login simulado en mock, con un emisor local que solo existe en modos de debug.
3. Los invitados no pasan por el embudo ni por el pago.
4. Las invitaciones caducan a los 7 días.
5. `past_due` sigue entrando, con un aviso.
6. Aprobar un borrado marca la organización `deleted` y cancela la suscripción; no hay borrado físico.
7. Los resultados reclamados se leen por pertenencia y no caducan.
8. Si el reclamo falla, no se crea la organización.
9. Los planes de ejemplo se siembran en la migración (precios de ejemplo; se cambian en la tabla).
10. El precio vive solo en `plans` y Stripe lo recibe con `price_data`; no hay `stripe_price_id` que mantener.
11. Cobro y ciclo de vida van separados: `billing_status` (lo cambia solo el webhook) y borrado (`deletion_requests` + `deleted_at`). Con una solicitud pendiente se mantiene el acceso; borrada da 410.
12. Reclamo en dos pasos con un ticket de un solo uso, para sobrevivir al magic link; email del registro prefijado y bloqueado; el login no crea usuarios.
13. Un cliente con organización que repite el embudo añade el análisis a su organización (`analysis.create`), no crea otra.
14. Admin de plataforma por script (`admin:grant`) o, en mock, desde el login simulado.
15. El login simulado existe solo en `mock`; en `live-debug` el login es el real.
16. En los modos de debug los botones sin permiso se ven activos para mostrar el 403 del back.

## 10. Alcance de la demo de mañana y lo que viene después

**Alcance elegido por Jesús (2026-10-25 20:15): mock + migración.** **[Jesús]**

**Tiene que funcionar mañana, en `mock`, verificado:**
1. Embudo → resultados → CTA → registro (login simulado) → organización creada con el análisis reclamado.
2. `/app` bloqueado (402) → `/app/billing` → pago simulado → `/app` con el análisis.
3. Invitar a un `member` → entra con el enlace → no puede pagar ni cambiar roles; el back responde 403 y la demo lo muestra.
4. Cambiar el precio de un plan con `PUT /admin/plans`, como admin de plataforma simulado → `/app/billing` y el checkout simulado lo reflejan.
5. "Solicitar eliminación" → queda una solicitud pendiente, sin borrar nada; el acceso sigue con un aviso.

**Se entrega mañana, pero sin conectar a nada real:**
- La migración SQL completa (tablas, restricciones, RLS, la regla de al menos un owner y la semilla de planes), probada en PGlite como `assessment-database.test.ts`. **No se aplica a ninguna base.**

**Después de la demo, en este orden:**
1. Repositorios de Supabase para las tablas nuevas, con las RPC atómicas (crear organización con owner y reclamo, aceptar invitación, aplicar webhook).
2. Verificación de JWT de Supabase real, y Supabase Auth en el front (magic link; después Google).
3. Stripe real: checkout con `price_data`, portal y webhook con firma. Primero en `live-debug` con claves de test, sobre un proyecto **Arca-dev**, no sobre la base de producción.
4. UI del panel de ARCA, correos reales de invitación y la mudanza a `app.arcacover.com` cuando toque.

En `live-debug` las rutas de la webapp responden 501 `not_configured` mientras falten los adaptadores reales, para que nunca parezca que funcionan contra servicios que no existen. **[mía]**
