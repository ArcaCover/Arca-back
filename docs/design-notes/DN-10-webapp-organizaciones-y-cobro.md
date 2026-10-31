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
7. **Cimientos para un panel de administración de ARCA:** rol de plataforma, auditoría, cola de solicitudes y planes editables. Del panel solo hay una prueba de concepto en `/app/admin`, con los precios de los planes y la cola de borrados (§4.6); el panel completo queda para después. **[Jesús]**
8. **Front: un esqueleto funcional mock**, para recorrer el flujo en la demo. **[Jesús]**

**No-objetivos (por ahora)**
- Diseño, UI y UX finales: los pule otra persona. **[Jesús]**
- Login con Google: queda **preparado** (§4.1), no activado.
- Panel de administración de ARCA completo, más allá de la prueba de concepto de `/app/admin`.
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
                       POST /claims { scanToken }   (el token del scan va en el cuerpo)
                       → claimId de un solo uso, válido 24 h
                                             │
                                             ▼
                       /app/signup?claim=<claimId>  (email → magic link)
                                             │  al volver del magic link, ya con sesión:
                                             ▼
           POST /orgs { name, claimId }  + Bearer de Supabase
           (o POST /orgs/:id/analyses { claimId } si ya tiene organización)
           → crea la organización, al usuario como owner y reclama scan + assessment
                                             │
                                             ▼
                          /app/billing → Stripe Checkout → webhook → org activa
                                             │
                                             ▼
                                     /app  (panel de la organización)
```

El reclamo va en dos pasos (§4.7). El token del scan viaja en el cuerpo de `POST /claims`, nunca en una cabecera propia, así que `allowHeaders` de CORS sigue siendo exactamente `Content-Type,Authorization`.

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
  - `POST /__debug/auth/login { email, platformAdmin? }`, que existe **solo en `mock`**, emite un JWT con el mismo formato y claims (en `live-debug` el login es el real de Supabase);
  - ese JWT se firma con una clave derivada de `SESSION_TOKEN_SECRET` (HMAC-SHA256 de `arca-mock-auth`), nunca con el secreto mismo, y lleva su propio emisor (`arca-mock-auth`) y audiencia (`authenticated`): un token de la app nunca vale como token del scan, ni al revés;
  - el verificador del back acepta ese emisor **solo** en mock;
  - en producción, ese emisor y esa ruta no existen.

### 4.2 Modelo de datos (migración nueva en `supabase/migrations/`)

`auth.users` es de Supabase. Las tablas nuevas van en `public`, con RLS activado y sin acceso para `anon` ni `authenticated`: solo el back, con la clave de servicio, como las tablas actuales.

| Tabla | Columnas clave | Notas |
|---|---|---|
| `profiles` | `user_id` (PK → `auth.users`), `email`, `full_name`, `last_org_id`, `created_at` | Datos propios del usuario |
| `organizations` | `id`, `name`, `domain`, `billing_status`, `deleted_at`, `created_by`, `created_at` | `billing_status`: `pending_payment`, `active`, `past_due`, `canceled`; solo lo cambia el webhook. El ciclo de vida va aparte: una solicitud pendiente vive en `deletion_requests` y el borrado aprobado pone `deleted_at` [mía] |
| `memberships` | `org_id`, `user_id`, `role`, `invited_by`, `created_at`; PK (`org_id`, `user_id`) | `role`: `owner`, `admin`, `member`, `viewer`. Siempre queda al menos un owner (trigger o check en la RPC) |
| `invitations` | `id`, `org_id`, `email`, `role`, `token_hash`, `invited_by`, `expires_at`, `accepted_at`, `revoked_at`, `created_at` | Se guarda solo el hash del token; caduca a los 7 días [mía]. Una sola pendiente por email y organización (`invitations_pending_email_idx`, §4.7) |
| `org_analyses` | `org_id`, `scan_id` (UNIQUE), `assessment_id`, `claimed_by`, `claimed_at` | Un scan solo se reclama una vez |
| `claim_tickets` | `id_hash`, `scan_id`, `email`, `expires_at`, `used_at` | Puente del embudo anónimo al registro (§4.7): sobrevive al magic link aunque se abra en otra pestaña o dispositivo [mía] |
| `plans` | `code` (PK), `name`, `amount_cents`, `currency`, `interval` (`month`/`year`), `active`, `created_at` | El precio vive **solo** aquí: el checkout le pasa a Stripe el importe con `price_data`, así que cambiar la tabla cambia el cobro sin tocar Stripe [mía]. Sembrado con planes de ejemplo |
| `subscriptions` | `org_id` (PK), `plan_code` (→ `plans.code`), `customer_id`, `subscription_id`, `status`, `current_period_end`, `updated_at` | Lo escribe solo el webhook de Stripe. Los ids del proveedor van sin prefijo `stripe_` |
| `stripe_events` | `id` (el id del evento de Stripe), `type`, `received_at`, `processed_at` | Idempotencia: un evento repetido no se procesa dos veces |
| `deletion_requests` | `id`, `org_id`, `requested_by`, `reason`, `status` (`pending`, `approved`, `rejected`), `reviewed_by`, `reviewed_at`, `review_note` | La cola para la revisión humana |
| `platform_admins` | `user_id` (PK), `granted_by`, `created_at` | Personas de ARCA. Rol de plataforma, separado de los roles de organización |
| `audit_log` | `id`, `actor_user_id`, `org_id`, `action`, `target`, `data` (jsonb), `created_at` | Solo admite añadir filas, como `assessment_answer_events` |

**Los resultados reclamados no caducan.** El assessment anónimo devuelve 410 a las 24 h, pero una organización lee sus análisis por pertenencia y no por el token del scan. El back lee el `result` congelado directamente del repositorio. **[mía]**

### 4.3 Roles y permisos

Hay una sola tabla de permisos en código, en `@arca/contracts` (`packages/contracts/src/webapp.ts`): `can(role, permission)` y `canManageMember(actor, target, nextRole?)`, compartidas con el front. En el back, `WebappService.authorize(user, orgId, permission, { payment })` las aplica en cada ruta, en este orden: quien no es miembro recibe 404, la organización borrada 410, el rol sin permiso 403 y la falta de pago 402. **[Jesús + mía]**

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

- **Checkout.** `POST /orgs/:id/billing/checkout { planCode }` (`billing.manage`) crea un Checkout Session de Stripe en modo `subscription`, con `price_data` (importe, moneda e intervalo leídos de `plans`), y devuelve la URL. Si la organización ya paga (`active` o `past_due`), responde **409**: cambiar de plan o de tarjeta se hace en el portal.
- **Portal.** `POST /orgs/:id/billing/portal` (`billing.manage`) devuelve la URL del Customer Portal, para cancelar o cambiar el método de pago.
- **Webhook.** `POST /billing/webhook` es público, pero **verifica la firma** con `STRIPE_WEBHOOK_SECRET`. Procesa:
  - `checkout.session.completed`;
  - `customer.subscription.created`, `customer.subscription.updated` y `customer.subscription.deleted`;
  - `invoice.payment_failed`.

  Con ellos actualiza `subscriptions` y `organizations.billing_status`, y nunca toca el borrado. Es idempotente por `stripe_events`.
- **Planes.** `GET /plans` es público y devuelve los planes activos (nombre, precio, intervalo). El precio se cambia en la tabla `plans` (o con `PUT /admin/plans`) y el siguiente checkout ya lo usa.
- **Modo `mock` (DN-09).** Sin Stripe real: el checkout devuelve una URL local, `/app/billing/mock-checkout?session=<id>`, y no activa nada por sí solo. La suscripción se activa en memoria solo con el pago simulado, `POST /__debug/billing/pay { sessionId }` (solo en `mock` y con `X-Arca-Debug: 1`); pagar dos veces la misma sesión da 409. **Stripe en modo test** llegará después, en `live-debug` (§10).

### 4.5 Bloqueo hasta pagar

- **Rutas protegidas.** Todas las rutas de datos de la webapp (`/orgs/:id/...`, salvo `billing/*`, `deletion-request` y la lectura mínima de la organización) exigen `billing_status` en (`active`, `past_due`). Si no, **402** `payment_required`.
- **Solicitud de borrado pendiente:** el acceso sigue igual, con un aviso. **Organización borrada** (`deleted_at`): **410** en todo. [mía]
- **`past_due`** sigue entrando, con un aviso; no se bloquea a un cliente por un pago fallido puntual. **[mía]**
- **En el front**, `/app` redirige a `/app/billing` ante un 402. El bloqueo real es el del back.

### 4.6 Cimientos del panel de ARCA (con una prueba de concepto)

Hay rutas `/admin/*` que solo responden a `platform_admins`:
- `GET /admin/organizations`;
- `GET /admin/deletion-requests`;
- `POST /admin/deletion-requests/:id/approve` y `/reject`;
- `GET` y `PUT /admin/plans`.

Los endpoints están probados con tests. Hay además una prueba de concepto en `/app/admin`, que solo cubre los precios de los planes y la cola de solicitudes de borrado (§12.3); el panel completo es trabajo futuro. **Quién es admin de plataforma:** se otorga con un script del back (`npm run admin:grant -- <email>`); en `mock`, con `platformAdmin: true` en el login simulado. **Aprobar un borrado** pone `deleted_at` y cancela la suscripción en Stripe. **Rechazarlo** solo cierra la solicitud: el estado de cobro nunca cambió. El borrado físico de datos queda fuera de alcance, por implicaciones legales. **[mía]**

### 4.7 Endpoints (resumen)

| Método y ruta | Auth | Qué hace |
|---|---|---|
| `GET /me` | Supabase | Usuario y organizaciones con su rol |
| `POST /claims { scanToken }` | token del scan, en el cuerpo | Emite un ticket de reclamo de un solo uso (24 h) para ese scan y su email |
| `POST /orgs { name, claimId }` | Supabase + `claimId` | Crea la organización, el owner y reclama el análisis |
| `POST /orgs/:id/analyses { claimId }` | `analysis.create` + pago + `claimId` | Añade un análisis nuevo a una organización existente |
| `GET /orgs/:id` | miembro | Organización, estado de la suscripción y tu rol (sin bloqueo por pago) |
| `GET /orgs/:id/analyses` | `org.read` + pago | Análisis reclamados, con sus resultados |
| `GET/POST/PATCH/DELETE /orgs/:id/members…` | según la matriz + pago | Miembros, roles e invitaciones |
| `POST /invitations/:token/accept` | Supabase | Acepta una invitación |
| `POST /orgs/:id/billing/checkout`, `/portal` | `billing.manage` | Stripe (sin bloqueo por pago; el checkout de una organización que ya paga da 409) |
| `POST /billing/webhook` | firma de Stripe | Estado de la suscripción |
| `GET /plans` | pública | Planes activos |
| `POST /orgs/:id/deletion-request` | `org.request_deletion` | Pasa a `deletion_requested` |
| `/admin/*` | `platform_admin` | Cimientos del panel de ARCA |
| `POST /__debug/auth/login` | solo mock | Login simulado (§4.1) |
| `POST /__debug/billing/pay` | solo mock | Pago simulado de una sesión del checkout simulado (§4.4) |

**Reclamar el análisis [mía].** Va en dos pasos, para que sobreviva al magic link (que puede abrirse en otra pestaña o dispositivo) sin guardar el token del scan fuera de `sessionStorage`:
1. En los resultados, `POST /claims { scanToken }`, con el token del scan en el cuerpo, devuelve un `claimId` aleatorio de un solo uso, válido 24 h. El back guarda su hash, el `scan_id` y el email del scan. Como el token no va en una cabecera, `allowHeaders` de CORS sigue siendo exactamente `Content-Type,Authorization`.
2. El magic link vuelve con `?claim=<claimId>`. Ya con sesión, `POST /orgs { name, claimId }` (o `POST /orgs/:id/analyses { claimId }`) comprueba que:
   - el ticket existe, no caducó y no se usó;
   - el email del ticket coincide con el del usuario de Supabase, sin distinguir mayúsculas (el registro lleva ese email prefijado y bloqueado);
   - el scan está COMPLETED o PARTIAL, está en almacenamiento durable (un scan con fallo inyectado, que vive en memoria, da **409**) y no fue reclamado ya (`org_analyses.scan_id` UNIQUE).

Si falla una condición, la organización **no** se crea. Un scan puede reclamarse aunque no tenga assessment.

**Invitaciones [mía].** Un enlace de invitación vivo es una puerta de entrada, así que el back deja como mucho uno por email y organización:
- un email que ya es miembro de la organización no se invita: **409** (`already_member`);
- invitar otra vez a un email con una invitación pendiente, caducada o no, revoca la anterior y crea una nueva; el enlace viejo responde **410**. En SQL lo asegura `invitations_pending_email_idx`, y el repositorio traduce ese choque a `already_invited` (409), que solo puede darse en una carrera;
- al aceptar, se revocan las demás invitaciones pendientes de ese email en la organización, también si la persona ya era miembro;
- al quitar a un miembro, se revocan las invitaciones pendientes de su email en la organización: un enlace viejo no le sirve para volver;
- cada revocación automática queda en `audit_log` como `invitation.revoked`, con el motivo.

**Cuenta sin organización.** Si un reclamo falla, la cuenta de Supabase ya existe pero no tiene organización. `/app` le muestra "Completa un análisis para crear tu organización", con enlace a `/quote`. `/app/login` nunca crea usuarios (`shouldCreateUser: false`); solo el registro desde los resultados los crea.

**Cliente que ya tiene organización.** Si repite el embudo con sesión iniciada, el CTA de resultados (que solo existe en `mock`, §5) pide primero el reclamo (`POST /claims`) y solo entonces decide adónde va el análisis:
- se **añade a la organización activa** (`POST /orgs/:id/analyses { claimId }`) solo si se cumplen las tres condiciones: el email de la sesión es el del reclamo, sin distinguir mayúsculas; su rol tiene `analysis.create`; y la organización tiene acceso pagado (`paidAccess`);
- si falta cualquiera de las tres, el flujo va al **registro con el reclamo** (`/app/signup?claim=<claimId>`), que inicia sesión con el email del reclamo;
- si el back responde **402** (la organización dejó de estar pagada después de leer `/me`), el front lleva a `/app/billing`.

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
  - `/app/billing/mock-checkout`: la página que hace de Stripe en `mock`, con el botón del pago simulado. Fuera de `mock` responde **404** (componente de servidor con `notFound()`) y **no está en el bundle de producción**: el componente del pago se carga con `next/dynamic` dentro de la guarda literal, así que el build de producción no emite su chunk.
  - `/app/admin`: prueba de concepto del panel de ARCA, solo para admins de plataforma: precios de los planes y cola de solicitudes de borrado.
- **En `/assessment/results`:** un CTA "Save your results and activate your account". **Solo existe en `mock`** (guarda literal `process.env.NEXT_PUBLIC_ARCA_MODE === "mock"`, DN-09) hasta que lleguen los adaptadores reales de Auth y Stripe; fuera de `mock` no se pinta. Al pulsarlo cambia el token del scan por un reclamo (`POST /claims`, con el token en el cuerpo) y aplica las reglas de §4.7: el análisis se añade a la organización activa solo si el email de la sesión coincide con el del reclamo (sin distinguir mayúsculas), el rol tiene `analysis.create` y la organización tiene acceso pagado; si no, va a `/app/signup` con el reclamo, y un **402** lleva a `/app/billing`.
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
| Invitación robada o vieja | Solo se guarda el hash del token, con expiración de 7 días; se acepta con el login del email invitado; reinvitar, aceptar o quitar al miembro revoca los demás enlaces de ese email (§4.7) |
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
4. El panel de ARCA completo (hoy solo la prueba de concepto de `/app/admin`), correos reales de invitación y la mudanza a `app.arcacover.com` cuando toque.

En `live-debug` las rutas de la webapp responden 501 `not_configured` mientras falten los adaptadores reales, para que nunca parezca que funcionan contra servicios que no existen. **[mía]**

## 11. Cómo correr la demo

Todo en PowerShell, en Windows, y todo en `mock`: no se llama a Stripe ni a Supabase Auth, y los datos de la webapp viven en la memoria del back. Si el back se para, se pierden las organizaciones, los precios cambiados y los admins de plataforma.

**Antes de la primera vez**, y cada vez que cambie `packages/*` del back, compila el back, porque el front importa `@arca/contracts` ya compilado:

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run build
```

**Arrancar los dos en mock** (DN-09 §11.1):

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run stack -- mock
```

Está listo cuando salen `[back] [api] MODE=mock sources=mock storage=memory (debug routes on 127.0.0.1 only)` y `[front] ✓ Ready`. `Ctrl+C` para los dos.

**Ventanas.** La sesión de la app vive en el `localStorage` del navegador, así que cada persona necesita su propia ventana:
- **owner:** una ventana normal;
- **invitado:** una ventana de incógnito;
- **admin de ARCA:** otro navegador, o la misma ventana de incógnito después de "Sign out" del invitado.

### 11.1 Guion paso a paso

**Preparación** (ventana del owner):
1. Abre `http://localhost:3000/quote`. La franja dice `MOCK · no real APIs · in-memory data`.
2. Pulsa `State` en la franja y, en el panel, "Reset limits". En mock también vacía la memoria del back, la de la webapp incluida.
3. Pulsa "Fill mock firm": rellena un email `debug+…@arca.example` y la web `robust.arca.example`.
4. Cierra el panel y pulsa "Scan my firm".

**Punto 1. Del embudo a la organización.**
1. En `/score`, pulsa "Refine your score".
2. En `/assessment`, abre el panel y pulsa "Auto-answer"; la página se recarga con todo respondido.
3. Abre el panel otra vez y pulsa "Attest & complete".
4. En `/assessment/results`, cierra el panel y pulsa "Save your results and activate your account".
5. En `/app/signup`, el email del scan sale prefijado y bloqueado. Escribe el nombre de la organización (por ejemplo, "Robust Law (demo)") y pulsa "Create organization".
6. Llegas a `/app/billing` con "Status: Pending payment" y el nombre de la organización en la cabecera. El login simulado se hizo solo, con el email del scan.

**Punto 2. Bloqueo hasta pagar.**
1. Pulsa "Analyses". El back responde 402 a los análisis y la app te devuelve a `/app/billing`.
2. Pulsa "Pay" en "Monthly (example price)". Vas a `/app/billing/mock-checkout`, la página que hace de Stripe.
3. Pulsa "Simulated payment". Vuelves a `/app` con "Payment received. Your organization is active." y el análisis de `robust.arca.example`, con el mismo score que en los resultados.

**Punto 3. Un invitado sin permisos.**
1. En "Members", escribe un email (por ejemplo, `member@arca.example`), deja el rol `member` y pulsa "Send invitation".
2. Pulsa "Copy invite link". La página solo enseña el principio del enlace, nunca el token entero.
3. En la ventana de incógnito, pega el enlace, escribe ese mismo email y pulsa "Sign in and accept". Entra directo a `/app` y ve el análisis: no pasa por el embudo ni paga.
4. En "Billing", pulsa "Pay". Sale "Your role does not allow this": es el 403 del back.
5. En "Members", cambia el rol del owner. Sale el mismo aviso y el rol no cambia.

En mock los botones salen activos a propósito, para que se vea que quien niega es el back (§5).

**Punto 4. Cambiar un precio como admin de ARCA.**
1. En la ventana del admin, abre `http://localhost:3000/app/login`.
2. Escribe un email (por ejemplo, `ops@arca.example`), marca "Sign in as an ARCA platform admin (mock)" y pulsa "Sign in". Llegas a `/app/admin`.
3. Cambia el precio de "Monthly (example price)" (por ejemplo, a `399.00`) y pulsa "Save". Sale "Monthly (example price) now costs $399.00 / month.".
4. En la ventana del owner, "Billing" ya enseña `$399.00 / month`.

El siguiente checkout cobra ese importe, porque el plan viaja entero al proveedor de cobro; lo fija `webapp-service.test.ts`. La página del checkout simulado no enseña el importe (§12.3).

**Punto 5. Solicitar la eliminación.**
1. En la ventana del owner, ve a "Settings", escribe un motivo y pulsa "Request deletion".
2. Sale "Deletion requested. It is pending review by ARCA…". En "Analyses" el análisis sigue ahí, con el aviso de la solicitud pendiente.
3. En la ventana del admin, recarga `/app/admin`. Aparece la solicitud, con su motivo y los botones "Approve" y "Reject".

Para la demo, **no la apruebes**: aprobar marca la organización como borrada y desde ese momento todo responde 410. "Reject" cierra la solicitud y el aviso desaparece.

Un usuario sin el rol de plataforma que abra `/app/admin` ve "Not available", y las rutas `/admin/*` le responden 403.

### 11.2 Smoke de navegador

Con `npm run stack -- mock` corriendo:

```powershell
cd C:\Users\jesus\projects\Arca-front
npm run test:browser:webapp
```

- Recorre los cinco puntos de §10 con el guion de §11.1, en un solo navegador y con un contexto para el owner, otro para el invitado y otro para el admin. Cada punto parte del anterior: si uno falla, el smoke se para ahí.
- Al final del punto 5, el admin rechaza la solicitud, para comprobar que el panel actúa y que el acceso sigue. Nunca la aprueba.
- Bloquea cualquier host que no sea `localhost`, `127.0.0.1` o `[::1]`, y falla si se pide alguno.
- Deja las capturas en `Arca-front\artifacts\webapp\`.
- Empieza pulsando "Reset limits": borra lo que se hubiera hecho a mano en esa sesión del stack.

## 12. Verificación

Hecha el 2026-10-25 en la máquina de Jesús (Windows 11, Node 22.19.0, Playwright 1.62.1), sobre `feat/webapp-orgs`: back desde `7027fb0` y front desde `eb8d054`, más los commits de la Task 8. Las salidas están recortadas y no llevan ningún valor secreto.

### 12.1 Resumen

| Paso | Qué se comprobó | Resultado |
|---|---|---|
| (a) | `npm run build && npm test` en Arca-back | OK: 55 archivos, 663 tests |
| (b) | `npm test`, `npm run typecheck` y `npm run lint` en Arca-front | OK: 27 archivos y 389 tests; typecheck limpio; lint con 0 errores y los 6 avisos previos |
| (c) | build de producción del front, sin modo | OK: `0 debug leak(s)`; `/app/admin` está en el build y la casilla de admin simulado no |
| smoke | `npm run test:browser:webapp` con `npm run stack -- mock` | OK: 5 de 5; ningún host fuera de la máquina; ningún error de página no capturado |

Qué test fija cada regla de la demo:
- **Back**, `apps/api/tests/integration/webapp.test.ts`:
  - "the demo flow works end to end": el recorrido de §10 contra la API;
  - aislamiento entre organizaciones (404), organización borrada (410), cada rol contra cada ruta (403), sin token o con el token del scan (401);
  - "production wiring": todas las rutas de la webapp dan 501, no hay login simulado y CORS sigue exacto;
  - "live-debug has no mock login": `/__debug/auth/login` y `/__debug/billing/pay` dan 404.
- **Back**, `webapp-service.test.ts`: el checkout recibe el plan con el precio nuevo después de `updatePlan`.
- **Front**, `components/app/app-flow.test.tsx`, bloque "the platform admin page (proof of concept)":
  - "Not available" para quien no es admin de plataforma, sin llamar a la API de admin;
  - la página abre para un admin sin organización;
  - el cambio de precio llama a `adminUpdatePlan` en céntimos y enseña el precio nuevo;
  - Approve y Reject cierran la solicitud;
  - el motivo del back se enseña cuando niega.
- **Front**, el mismo archivo: `/app/admin` sin sesión va a `/app/login`; la casilla de admin solo existe en mock y lleva a `/app/admin`.

### 12.2 Salidas

**(a) Back completo.** `npm run build && npm test` en Arca-back:

```
> tsc -b
 Test Files  55 passed (55)
      Tests  663 passed (663)
```

**(b) Front completo.** En Arca-front:

```
npm test            → Test Files  27 passed (27) · Tests  389 passed (389)
npm run typecheck   → tsc --noEmit, sin errores
npm run lint        → ✖ 6 problems (0 errors, 6 warnings)
```

Los 6 avisos son los `react-hooks/set-state-in-effect` que ya existían (DN-09 §12.2).

**Las suites dependen de la carga de la máquina.** Corridas a la vez, back y front, fallan tests que ya existían, todos por tiempo:
- en el back, `arca-demo-stack.test.ts` (20 s) y `crawler.test.ts`;
- en el front, `lint-boundary.test.mjs` (5 s) y un caso de `assessment-flow.test.tsx`.

Cada suite por separado pasa entera, que es lo que recoge esta tabla. Los tests nuevos de la Task 8 pasaron también con la máquina cargada.

**(c) Build de producción del front, sin modo.** `Remove-Item Env:NEXT_PUBLIC_ARCA_MODE -ErrorAction SilentlyContinue` antes de `npm run build`:

```
├ ○ /app
├ ○ /app/admin
├ ○ /app/billing
├ ○ /app/billing/mock-checkout
├ ƒ /app/invite/[token]
├ ○ /app/login
├ ○ /app/members
├ ○ /app/settings
├ ○ /app/signup
[check-no-debug] 0 debug leak(s) in the production build
```

Búsqueda manual en el `.js` de `.next\static`:
- `ARCA platform admin (mock)`, el texto de la casilla de admin simulado: 0 archivos;
- `Platform admin (proof of concept)`, como control positivo: 1 archivo.

**Smoke.** `npm run test:browser:webapp`, con el stack arrancado por `npm run stack -- mock` y parado al terminar:

```
  "Robust Law (demo)" created for the scan's email; the results scored 71
PASS 1 sign-up from the results claims the analysis
  402 before paying; after the simulated payment /app shows robust.arca.example at 71
PASS 2 /app is blocked (402) until the simulated payment
  the member joined by the link and sees the analysis; checkout 403, role change 403, both shown
PASS 3 an invited member joins and the back refuses them (403)
  Monthly (example price) set to $399.00 on /app/admin; the owner's /app/billing shows $399.00 / month
PASS 4 the platform admin changes a price and billing shows it
  pending request with access and notice; ARCA saw it and rejected it; the organization was never deleted
PASS 5 a deletion request stays pending while access continues
5/5 demo point(s) passed; screenshots in C:\Users\jesus\projects\Arca-front\artifacts\webapp
```

### 12.3 Decisiones tomadas al implementar (revisar)

1. **El login simulado de admin está en `/app/login`.** En mock, la página ofrece la casilla "Sign in as an ARCA platform admin (mock)", que manda `platformAdmin: true` (§4.6) y lleva a `/app/admin`. Va detrás de la guarda literal `=== "mock"`, así que el build de producción no la lleva (§12.2 c).
2. **`/app/admin` no exige organización.** Una persona de ARCA no tiene por qué pertenecer a ninguna, así que el layout de `/app` pinta esa página con sesión pero sin organización. Por la misma razón, la página pide `/me` ella misma. Las rutas `/admin/*` siguen negando con 403 a cualquiera que no sea admin de plataforma.
3. **La página de admin enseña el nombre de la organización** en cada solicitud de borrado, con `GET /admin/organizations`. El id solo no dice nada en una demo.
4. **El precio se escribe en dólares y viaja en céntimos** (`399.00` → `amountCents: 39900`). No hay campo para la nota de revisión: `ReviewRequest.note` sigue siendo opcional.
5. **El formato del precio vive en `lib/app/price.ts`**, compartido por billing y admin.
6. **Pendiente:** la página del checkout simulado no enseña el importe, porque su URL solo lleva la sesión. Que "el checkout simulado lo refleje" (§10, punto 4) se comprueba hoy en el back, no en pantalla. Para enseñarlo habría que añadir el plan a esa URL o una consulta de la sesión simulada.
