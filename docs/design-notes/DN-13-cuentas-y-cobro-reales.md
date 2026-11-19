# DN-13 · Cuentas y cobro reales: Supabase Auth y Stripe

- **Fecha:** 2026-11-17
- **Estado (2026-11-19):** en implementación en la rama `feat/real-accounts`. Fase 1 hecha (datos: T3, T4 y T12, §12.1).
  De la fase 2, hechas T6 y T10 (§16) y la parte del back de T7 y T11 (§17); falta el front (T9) y la configuración de
  `Arca-dev` (T8). La migración nueva solo se ha aplicado a Supabase local; a ninguna base real. No hay cuentas, claves ni
  webhooks creados, y producción sigue en 501.
  Las migraciones de esta nota necesitan la aprobación del founder antes de tocar cualquier base (§5.2).
- **Repos:** `Arca-back` (casi todo el peso) y `Arca-front`. La nota vive en la rama `docs/auth-billing-design`,
  creada desde `fix/score-stability`.
- **Parte de:** DN-10 §10, pasos 1 a 3 (repositorios de Supabase, Supabase Auth real y Stripe real) y una parte del
  paso 4 (correos reales de invitación). Respeta DN-11 (vistas por rol), DN-09 (modos) y DN-12 §7 (webapp simulada
  en `live-debug`).

Las marcas siguen la convención de DN-10: **[Jesús]** decidido por Jesús o por el founder, **[mía]** propuesto por el
asistente y revisable. Las decisiones que solo puede tomar el founder están en la §14 con un código **F1…F14** y se
citan así en el texto.

---

## 1. Por qué

La webapp privada (DN-10, DN-11) existe y está probada, pero solo como simulación: el login lo firma el propio back
(`MockAppAuth`), el pago lo hace un botón (`MockBillingProvider` + `POST /__debug/billing/pay`) y los datos viven en la
memoria del proceso (`InMemoryWebappRepository`). En producción, `compose.ts` no construye la webapp y sus 22 rutas
responden **501 `not_configured`** (`notConfiguredWebapp()` en `apps/api/src/webapp/routes.ts`).

El embudo real termina hoy en `/assessment/results` sin salida: el CTA "Save your results" solo se pinta en los modos
de debug. Para cobrar a un despacho hacen falta tres piezas reales, y esta nota las diseña para que se puedan
implementar tarea por tarea:

1. **Identidad:** cuentas de Supabase Auth, sin contraseña.
2. **Datos:** las tablas de DN-10 y DN-11 en Postgres, detrás de un repositorio de Supabase con operaciones atómicas.
3. **Cobro:** suscripciones de Stripe, con Checkout, Customer Portal y webhooks.

## 2. Resumen de recomendaciones

| # | Recomendación | Marca |
|---|---|---|
| R1 | **Sin contraseña**, como ya decidió el founder. El correo lleva un **código de 6 dígitos** que se escribe en la misma pestaña; el enlace es de respaldo y lleva a una página que pide un clic. Motivo: los filtros de correo de los despachos (Microsoft 365 Safe Links, Mimecast, Proofpoint) abren los enlaces y gastan los de un solo uso | [Jesús] sin contraseña; [mía] el código |
| R2 | **Alta cerrada.** El registro público de Supabase se apaga. Solo el back crea usuarios, y solo para el email de un reclamo válido o de una invitación válida (`POST /auth/enroll`). Ninguna cuenta nace "en frío" (DN-10 §1) | [mía] |
| R3 | El back verifica el JWT de Supabase con `jose`, contra el **JWKS** del proyecto y solo con algoritmos asimétricos (ES256/RS256). No hay secreto JWT compartido: DN-10 §4.8 deja de ofrecer `SUPABASE_JWT_SECRET` | [mía] |
| R4 | El navegador nunca toca las tablas de la webapp. RLS activado sin políticas, y permisos solo para `service_role`, como hoy. La clave de servicio solo vive en el back | [mía], sigue a DN-10 |
| R5 | Las escrituras de varias filas pasan a **funciones RPC** de Postgres (`security definer`, ejecutables solo por `service_role`), como `create_assessment`. Cierran también las carreras que dejó anotadas DN-10/DN-11 | [mía] |
| R6 | **Dos proyectos de Supabase**: producción (con plan de pago, sin pausa) y `Arca-dev` (local, `live-debug`, previews). Con cuentas reales, compartir la base deja de ser aceptable (§5.2) | [mía]; decide el founder (F9) |
| R7 | **Precios de catálogo en Stripe** (Product + dos Prices con `lookup_key`) en vez de `price_data`. Cambia la decisión 10 de DN-10: el Customer Portal solo cambia de plan entre precios de catálogo. El precio sigue editándose desde `/admin`: el back crea un Price nuevo | [mía] |
| R8 | El webhook **lee el estado actual de la suscripción** en Stripe y lo aplica, en vez de fiarse del orden de los eventos. Idempotente por id de evento, y atómico: registrar el evento y aplicarlo van en la misma transacción | [mía] |
| R9 | Producción enciende la webapp con un interruptor (`WEBAPP_ENABLED`). Sin él, todo sigue igual que hoy: 501. `mock` sigue siempre simulado; `live-debug` sigue simulado por defecto y puede usar los adaptadores reales contra `Arca-dev` con claves de test (`WEBAPP_PROVIDERS=real`) | [mía] |
| R10 | Correos de invitación enviados por el back con un proveedor transaccional (recomendado: Amazon SES, ya estamos en AWS). Supabase usa ese mismo proveedor como SMTP propio para los códigos | [mía]; decide el founder (F11) |

## 3. Objetivos, no objetivos y antiobjetivos

**Objetivos**
1. Que un despacho pueda, en producción: terminar el embudo, guardar sus resultados, crear su organización, pagar y
   entrar a `/app`; invitar a su equipo; gestionar la suscripción; pedir el borrado de la organización o de su cuenta.
2. Sustituir los tres simulados por adaptadores reales detrás de las interfaces que ya existen: `AppAuth`,
   `BillingProvider` y `WebappRepository`. `WebappService` conserva todas sus reglas.
3. Que `mock` siga entero sin red, y que `live-debug` siga funcionando como hoy por defecto.
4. Dejar cada paso verificable con tests: unitarios, PGlite, Supabase local, Stripe en modo test con test clocks y un
   E2E de navegador.

**No objetivos**
- Diseño visual definitivo (lo pule otra persona, DN-10 §2).
- Login con Google o SSO SAML. Queda preparado: el back solo ve un JWT de Supabase (DN-10 §4.1).
- Planes por número de usuarios, cupones o facturas a 30 días (`send_invoice`). Se mencionan como decisiones futuras.
- Mudar la app a `app.arcacover.com` (DN-10 §8).
- Borrado físico de los datos de una organización. DN-10 §4.6 lo dejó fuera por implicaciones legales; esta nota
  propone una política de retención, pero no la ejecuta (F13).

**Antiobjetivos**
- Que la clave de servicio de Supabase, la clave secreta de Stripe o el secreto del webhook lleguen al navegador o al
  bundle del front.
- Que el front decida permisos o acceso: el back sigue siendo quien niega (DN-10, DN-11 D3).
- Que una clave **live** de Stripe funcione fuera de producción, o una de test en producción sin decirlo.
- Que las pruebas de desarrollo creen usuarios o cobros en el proyecto y la cuenta de producción.
- Que un evento de Stripe repetido, tardío o desordenado cambie el acceso dos veces o hacia atrás.

### 3.1 Encaje en el flujo actual

```
/quote → scan → /score → /assessment → /assessment/results              (anónimo, sin cambios)
                                             │ CTA "Save your results and activate your account"
                                             ▼ (en producción solo si NEXT_PUBLIC_WEBAPP_ENABLED=true)
                         POST /claims { scanToken }  → claimId (un uso, 24 h)            (sin cambios)
                                             │
                                             ▼
                         /app/signup?claim=…   email bloqueado = email del scan
                         POST /auth/enroll { claimId }  → el back crea el usuario si no existe     (NUEVO)
                         supabase.auth.signInWithOtp({ email, shouldCreateUser: false })            (NUEVO)
                         la persona escribe el código → verifyOtp → sesión de Supabase              (NUEVO)
                                             │
                                             ▼
                         POST /orgs { name, claimId }  + Bearer <access_token de Supabase>  (sin cambios)
                                             │
                                             ▼
                         /app/billing → POST /orgs/:id/billing/checkout → Stripe Checkout   (REAL)
                                             │  success_url
                                             ▼
                         /app/billing/return?session_id=… → POST /orgs/:id/billing/sync      (NUEVO)
                         + webhook de Stripe → billing_status = active                       (REAL)
                                             │
                                             ▼
                                           /app
```

El reclamo en dos pasos de DN-10 §4.7 no cambia. Lo que demuestra que la persona es dueña del email del scan (que
nadie verificó al escanear) es el código que recibe en ese buzón: el back exige que el email de la sesión coincida
con el del ticket.

### 3.2 Qué hay en cada modo

| | `production` con `WEBAPP_ENABLED=false` | `production` con `WEBAPP_ENABLED=true` | `live-debug` (por defecto) | `live-debug` con `WEBAPP_PROVIDERS=real` | `mock` |
|---|---|---|---|---|---|
| Rutas de la webapp | 501, como hoy | reales | simuladas (DN-12 §7) | reales | simuladas |
| Identidad | — | Supabase Auth (proyecto de producción) | `MockAppAuth` | Supabase Auth de `Arca-dev` | `MockAppAuth` |
| Datos de la webapp | — | Postgres de producción | memoria | Postgres de `Arca-dev` | memoria |
| Cobro | — | Stripe **live** | `MockBillingProvider` | Stripe **test** (obligatorio) | `MockBillingProvider` |
| Correos | — | proveedor real | ninguno (enlace en pantalla) | proveedor real o buzón de pruebas | ninguno |
| `/__debug/auth/login`, `/__debug/billing/pay` | 404 | 404 | sí | **404** | sí |
| `POST /billing/webhook` | 501 | real | 501 | real (vía `stripe listen`) | 501 |
| CTA en resultados | no | sí | sí, etiquetado "simulado" | sí, etiquetado "Stripe test" | sí |

**[mía]** `live-debug` con adaptadores reales solo arranca si la clave de Stripe es de test (`sk_test_`/`rk_test_`) y
existen todas las variables de §9.1; si no, el back se niega a arrancar, como ya hace DN-09 con las combinaciones
inválidas. Se recomienda usarlo solo contra `Arca-dev` (R6): el back no puede saber a qué proyecto apunta la URL, así
que la línea de arranque lo dice (`webapp=real stripe=test`) y la persona lo comprueba.

## 4. Autenticación (Supabase Auth)

### 4.1 Método

El founder ya decidió "magic links, sin contraseña nunca" (CLAUDE.md del front, §3). En Supabase, "magic link" y
"OTP por email" son el mismo mecanismo: `signInWithOtp` manda un correo, y la plantilla decide si lleva un enlace, un
código (`{{ .Token }}`) o los dos. La pregunta real es qué usa la persona para entrar.

| Opción | A favor | En contra para un despacho |
|---|---|---|
| Contraseña | Familiar | Descartada por el founder; reutilización de contraseñas, relleno de credenciales, soporte de "olvidé mi contraseña" |
| Enlace mágico solo | Un clic | Los filtros de correo corporativos (Safe Links de Microsoft 365, Mimecast, Proofpoint) abren el enlace para analizarlo y **gastan el token de un solo uso**: la persona ve "enlace inválido o caducado". Con PKCE, el enlace tiene que abrirse en el mismo navegador que lo pidió |
| **Código de 6 dígitos (recomendado)** | Inmune a los filtros (no hay nada que abrir); funciona aunque el correo se lea en el móvil y la app esté en el portátil; la pestaña conserva el reclamo en `sessionStorage` | Hay que escribir 6 dígitos |
| Google / Microsoft (OAuth) | Sin correo | Muchos despachos usan Microsoft 365; útil más adelante. No en esta fase |
| SSO SAML | Lo que pide un despacho grande | Complemento de pago de Supabase; para cuando haya clientes que lo exijan |

**Recomendación [mía]:** el correo lleva **el código, en grande, y debajo un enlace de respaldo**. El enlace no inicia
sesión al abrirse: lleva a `/app/auth/confirm`, una página que muestra un botón "Continue signing in" y solo entonces
llama a `verifyOtp({ token_hash, type: 'email' })`. Un escáner que abre enlaces no pulsa botones, así que no gasta el
token. Con `token_hash` no hace falta el verificador PKCE, así que el enlace también funciona en otro dispositivo.

- Caducidad del código: **10 minutos** (`Email OTP Expiration = 600`). El valor por defecto de Supabase es una hora;
  para un código de 6 dígitos sobra. **[mía]**
- Un envío por email cada 60 segundos (valor por defecto de Supabase), más los límites del back (§7.4).
- **MFA (TOTP)** queda para la fase 6: obligatoria para los admins de plataforma (`aal2` en `/admin/*`) y opcional para
  los owners (F14).

### 4.2 Alta cerrada: quién puede tener cuenta

DN-10 §4.7 ya dice que `/app/login` nunca crea usuarios (`shouldCreateUser: false`). Pero con el registro público de
Supabase encendido, cualquiera con la clave publicable del front puede llamar a la API de Auth y crear usuarios para
cualquier email, o usarla para mandar correos a terceros. **[mía]** Se cierra así:

1. En el proyecto de Supabase se apaga **"Allow new users to sign up"**. Ningún cliente puede crear usuarios.
2. El back crea el usuario, con la API de administración de Supabase (`auth.admin.createUser({ email, email_confirm: true })`
   con la clave secreta que ya tiene), solo en `POST /auth/enroll`, y solo si:
   - recibe un `claimId` válido (existe, no caducó, no se usó y su scan se puede reclamar: las mismas comprobaciones de
     `redeemable`, sin gastarlo), y el email es el del ticket; o
   - recibe un token de invitación válido (existe, pendiente y no caducada), y el email es el de la invitación.
3. Si el usuario ya existe, `enroll` no hace nada y responde igual (204 o el email). No revela si había cuenta.
4. El front llama después a `signInWithOtp({ email, options: { shouldCreateUser: false } })`.

`email_confirm: true` no regala nada: la única forma de obtener una sesión es el código que llega a ese buzón.

**Alternativa descartada [mía]:** que el back genere el código con `auth.admin.generateLink` y lo mande él. Pone un
secreto de login en memoria del back y duplica lo que Supabase ya hace.

**Login de alguien con cuenta** (`/app/login`): `signInWithOtp` con `shouldCreateUser: false`. Para un email sin
cuenta, Supabase responde con un error; el front muestra **el mismo mensaje** en los dos casos ("If an account exists
for this email, we sent you a code"), para no revelar quién es cliente.

### 4.3 Sesión en el front

Hoy el token simulado vive en `localStorage` (`arca.app.session`, `lib/app/session.ts`) y `lib/app/client.ts` lo manda
como `Authorization: Bearer`. Con Supabase:

- **Paquete:** `@supabase/ssr` con `createBrowserClient(url, publishableKey)`. Guarda la sesión en cookies del dominio
  del front (legibles por JS) y la refresca sola. `lib/supabase.ts` pasa a usarlo.
- **El token para la API** sale de `supabase.auth.getSession()` justo antes de cada llamada (`session.access_token`). La
  API vive en otro origen (`api.arcacover.com`) y no recibe cookies, así que sigue siendo un Bearer.
- **Estado:** `onAuthStateChange` alimenta el `AppContext`. `SIGNED_OUT` o `TOKEN_REFRESHED` fallido llevan a
  `/app/login`.
- **Cerrar sesión:** `supabase.auth.signOut({ scope: 'local' })`, y además `forgetOrg()` y `clearPendingClaim()`, como
  hoy.
- **Sin `proxy.ts` por ahora.** Next.js 16 renombró `middleware.ts` a `proxy.ts`, y la guía de Supabase para SSR lo usa
  para refrescar la sesión en componentes de servidor. Las páginas de `/app` son componentes de cliente y no leen
  datos en el servidor, así que no hace falta. Si algún día un componente de servidor lee datos del usuario, entra
  el `proxy.ts` de la guía, y la regla de esa guía: proteger con `getClaims()`, nunca con `getSession()` en el servidor.
- **`lib/app/session.ts`** deja de guardar el token en producción. `loadAppSession()` sigue existiendo (lo usan
  `SaveResultsCta` y el registro) pero lee del cliente de Supabase en producción y del almacenamiento simulado en los
  modos de debug.
- **Duración [mía]:** el access token de Supabase dura una hora por defecto; se mantiene. La rotación de refresh tokens
  con detección de reutilización queda encendida. El límite de inactividad y la duración máxima de sesión son
  opciones del plan de pago de Supabase; propuesta: 7 días de inactividad, 30 días como máximo (F14).

### 4.4 Cómo verifica la API al usuario

`AppAuth` no cambia: `verify(token) → { userId, email } | null`. Se añade `SupabaseJwtAuth` en
`apps/api/src/webapp/auth.ts`:

```ts
const jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: `${SUPABASE_URL}/auth/v1`, audience: 'authenticated',
  algorithms: ['ES256', 'RS256'], requiredClaims: ['exp', 'sub', 'email'],
});
// además: payload.role === 'authenticated', payload.is_anonymous !== true, sub es un UUID
return { userId: payload.sub, email: payload.email.toLowerCase(), aal: payload.aal, sessionId: payload.session_id };
```

- **Requisito:** el proyecto tiene que usar **claves de firma asimétricas** (sección "JWT Signing Keys" del panel). Con
  el secreto HS256 heredado, el JWKS sale vacío y nada verifica: el back no arranca en `real` si el JWKS no tiene ninguna
  clave (comprobación al arrancar, sin bloquear si Supabase no responde: reintenta y registra).
- **Por qué `jose` y no `getClaims()` en el back:** `jose` ya es dependencia y hace lo mismo que `getClaims()` con claves
  asimétricas (verificación local contra el JWKS, en caché). `getUser()` haría una petición a Supabase en cada
  llamada; no hace falta, porque los permisos se leen de la base en cada petición.
- **Rotación de claves:** `createRemoteJWKSet` vuelve a pedir el JWKS cuando llega un `kid` desconocido. Rotar en
  Supabase con una clave en espera ("standby") no corta sesiones.
- **Un proceso, un emisor.** El verificador lo elige `compose`: el real con `WEBAPP_PROVIDERS=real` o en producción, el
  simulado en los demás casos. Nunca los dos a la vez, así que un token de `arca-mock-auth` jamás vale donde vale uno de
  Supabase.
- **Revocación.** Un access token sigue siendo válido hasta su `exp` aunque se cierre la sesión. No importa para los
  permisos, que se leen de `memberships` en cada petición: quitar a alguien de una organización surte efecto en la
  siguiente petición. Para una cuenta borrada, el back responde 401 si el perfil tiene `deleted_at` (§4.8).
- **Sin claims de rol en el JWT [mía].** No se usa el "custom access token hook" para meter organización o rol en el
  token: quedarían viejos hasta una hora después de un cambio de rol.

### 4.5 Enlace entre `auth.users` y el modelo de la webapp

- `profiles.user_id` = `auth.users.id` = `sub` del JWT. `memberships`, `invitations.invited_by`, `audit_log.actor_user_id`
  y los demás ids de usuario ya son UUID sin clave foránea (migración de DN-10). Se mantiene así **[mía]**: la migración
  sigue aplicándose en PGlite sin el esquema `auth`, y la coherencia la da el back, que escribe el perfil en cada
  petición (`ensureProfile`).
- `ensureProfile` actualiza el email del perfil con el del JWT. Se desactiva el cambio de email en la interfaz (y se
  deja encendido "Secure email change" en Supabase); si algún día se permite, el perfil lo sigue solo.
- **Admin de plataforma.** DN-10 §4.6 cita `npm run admin:grant -- <email>`, pero ese script **no existía** en
  `package.json`. **Hecho en la fase 1 (T12, §12.1):** busca el perfil por email (la persona tiene que haber entrado una vez),
  inserta en `platform_admins` y escribe `platform_admin.granted` en `audit_log` con `actor_kind = 'platform'`. Se
  corre en local contra `Arca-dev`; contra producción, solo con la aprobación del founder y desde el host (SSM), nunca
  copiando la clave de producción a un portátil.

### 4.6 Invitaciones y cambios de rol

Las reglas de DN-10 §4.7 (una invitación pendiente por email y organización, revocar al reinvitar, al aceptar y al
quitar al miembro, 7 días de validez, solo se guarda el hash) no cambian. Cambia el transporte:

1. `POST /orgs/:id/invitations` crea la invitación como hoy y, **después de confirmar la escritura**, el back manda el
   correo con el enlace `${APP_BASE_URL}/app/invite/<token>`, el nombre de la organización, quién invita y el rol.
   La respuesta sigue llevando `inviteUrl` **[mía]**: si el correo se pierde en un filtro, el owner puede copiar el
   enlace. Un fallo del envío no deshace la invitación: se registra y la respuesta lo dice (`emailSent: false`).
2. En `/app/invite/[token]`, la página llama a `POST /auth/enroll { invitationToken }`, que crea el usuario si hace falta
   y devuelve el email de la invitación. La página lo muestra bloqueado, pide el código y, con la sesión, llama a
   `POST /invitations/:token/accept` (sin cambios: exige que el email de la sesión sea el de la invitación).
3. **Cambios de rol y bajas** surten efecto en la siguiente petición, porque el rol se lee de la base (§4.4).
4. **La carrera anotada en `types.ts`** (un admin que degrada o quita a alguien a la vez que un owner lo asciende a
   owner) se cierra en las RPC `set_member_role` y `remove_member` (§5.4): vuelven a comprobar `canManageMember` contra el
   rol leído bajo `for update`, y no escriben nada si ya no se cumple.

### 4.7 Reclamo del scan

Sin cambios de regla respecto a DN-10 §4.7. Detalles nuevos:

- El ticket del reclamo se lee en `POST /auth/enroll` (sin gastarlo) y se gasta en `POST /orgs` o
  `POST /orgs/:id/analyses`, como hoy.
- Con el código, la persona no sale de la pestaña: el `claimId` sigue en `sessionStorage`.
- Con el enlace de respaldo, el reclamo viaja en la URL de vuelta: `emailRedirectTo` es
  `${origin}/app/auth/confirm?next=/app/signup%3Fclaim%3D<claimId>`. La página de confirmación solo acepta un `next`
  que empiece por `/app/` (nunca una URL absoluta), y `/app/signup` quita el `claim` de la barra de direcciones en cuanto
  lo lee (`router.replace`), para que no quede en el historial ni en un `Referer`.
- En otro dispositivo no hay ticket en `sessionStorage`: `/app/signup` usa el `claim` de la URL y el email de la sesión.
  Si no coinciden, el back responde 403 como hoy.

### 4.8 Borrado de cuenta y retención

DN-10 solo tiene el borrado de **organizaciones** (solicitud + revisión humana). Falta el de una **persona**. **[mía]**

`DELETE /me` (con la sesión):
1. Si la persona es la **única owner** de alguna organización no borrada: **409 `sole_owner`**. Tiene que transferir la
   propiedad o pedir el borrado de la organización.
2. Si no, la RPC `delete_account` en una transacción: quita todas sus membresías (y libera sus acciones asignadas, como
   `removeMember`), revoca las invitaciones pendientes a su email, marca el perfil con `deleted_at` y vacía su email y
   su nombre, y escribe `account.deleted` en `audit_log` de cada organización afectada.
3. Después, el back borra el usuario de Supabase con `auth.admin.deleteUser(id)`. Si falla, se reintenta (el perfil ya
   está marcado y el back responde 401 a ese usuario).
4. La actividad sigue mostrando sus filas, con `email: null` ("Former member"); el contrato ya lo admite
   (`ActivityActor.email` es nullable).

**Retención propuesta** (requiere el visto bueno del founder y, si es posible, de un abogado: F13):

| Dato | Dónde | Propuesta |
|---|---|---|
| Cuenta (email, nombre) | `auth.users`, `profiles` | Se borra o vacía al borrar la cuenta |
| Organización, análisis, plan de acción, actividad | tablas de DN-10/DN-11 | Se conservan mientras la organización exista; tras un borrado aprobado, N años (propuesta: 7) y después purga física. Hoy no hay purga (DN-10 §4.6) |
| `audit_log` | Postgres | Igual que la organización; nunca se edita |
| Facturas y pagos | Stripe | Los conserva Stripe por obligación legal; ARCA solo guarda ids |
| Tickets de reclamo usados o caducados | `claim_tickets` | Purga a los 30 días |
| Invitaciones aceptadas, revocadas o caducadas | `invitations` | Purga a los 180 días |
| Eventos de Stripe | `stripe_events` | Purga al año |
| Leads del embudo (scans) | `scans` | Sin cambios en esta nota |

### 4.9 Plantillas de correo y URLs de vuelta

**Plantillas de Supabase** (en inglés, como toda la interfaz):

| Plantilla | Uso | Contenido |
|---|---|---|
| Magic Link | `signInWithOtp` para usuarios existentes, que con el alta cerrada son todos | Asunto "Your ARCA sign-in code"; el código `{{ .Token }}` en grande; "expires in 10 minutes"; enlace de respaldo `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`; aviso "If you didn't request this, ignore this email" |
| Confirm signup | no se usa (alta cerrada) | Se deja con un texto neutro |
| Invite user | no se usa: las invitaciones las manda el back | Se deja con un texto neutro |
| Change email address | desactivado en la interfaz | Texto neutro |

El enlace de respaldo concatena con `&` porque `emailRedirectTo` siempre lleva ya `?next=…`. Si Supabase no acepta la
URL de vuelta (no está en la lista), usa la Site URL y el enlace sale roto: la lista de URLs se prueba en cada entorno
(§11).

**Configuración de URLs por proyecto:**

| Proyecto | Site URL | Redirect URLs permitidas |
|---|---|---|
| Producción | `https://arcacover.com` | `https://arcacover.com/app/auth/confirm**` |
| `Arca-dev` | `http://localhost:3000` | `http://localhost:3000/**`; la URL de staging solo si staging tiene su propia API (§8.3) |
| Previews de Vercel | — | **No** se añaden a producción. Los previews no tienen webapp (§8.3) |

**SMTP propio obligatorio.** El SMTP de Supabase es para pruebas: tiene un límite de envíos muy bajo y no sirve para
clientes. Se configura un proveedor (R10, F11) con remitente `no-reply@arcacover.com`, y SPF, DKIM y DMARC en el DNS
del dominio (que vive en Vercel). Los correos de invitación del back salen por el mismo proveedor y el mismo remitente.

## 5. Base de datos

### 5.1 Punto de partida

Ya existen, **sin aplicar a ninguna base**, las dos migraciones de la webapp:
`20261025200000_webapp_organizations.sql` (DN-10) y `20261105120000_role_views.sql` (DN-11). Están probadas en PGlite y
cubren `profiles`, `organizations`, `memberships`, `invitations`, `org_analyses`, `claim_tickets`, `plans`,
`subscriptions`, `stripe_events`, `deletion_requests`, `platform_admins`, `audit_log` y `org_actions`, con RLS, permisos
solo para `service_role`, la guarda de "al menos un owner" y el `audit_log` de solo añadir.

Esta nota **no las reescribe**: añade una tercera migración con lo que falta para el cobro real, las RPC y los índices.
Las tres se aplican juntas y en orden.

### 5.2 Un proyecto o dos

Hoy dev (`live-debug`) y producción comparten el mismo proyecto de Supabase (DN-09 §5.5), que además está en el plan
gratuito y **se pausa solo** por inactividad. Con cuentas reales:

| | Un proyecto compartido | **Dos proyectos (recomendado)** |
|---|---|---|
| Usuarios de prueba | Se crean en el Auth de producción, junto a los clientes | Solo en `Arca-dev` |
| URLs de vuelta | La lista de producción tendría que admitir `localhost` | Producción solo admite `arcacover.com` |
| Migraciones | Cada prueba de migración toca producción | Se ensayan en `Arca-dev` |
| Stripe | Clientes de test y live apuntando a la misma tabla | Cada proyecto con su modo de Stripe |
| Coste | 0 | El de producción pasa al plan de pago (sin pausas, copias diarias); `Arca-dev` puede seguir gratis |

**Recomendación [mía]:** dos proyectos, y producción en plan de pago **antes** de tener un solo cliente: un proyecto que
se pausa deja fuera a quien paga. DN-09 §11.7 ya describe cómo crear `Arca-dev`. Decisión del founder: F9 y F10.

**Regla de aprobación [Jesús, de DN-10]:** ninguna migración se aplica a producción sin el visto bueno explícito del
founder. Orden: `Arca-dev` → pruebas de §11 → aprobación → `supabase link` al proyecto de producción → `npm run db:push`
→ `npm run db:verify` → volver a enlazar `Arca-dev` (DN-09 §11.7 avisa de este cambio de enlace).

### 5.3 Migración nueva (`20261118000000_real_accounts_billing.sql`, hecha en T3: §12.1)

Lo que añade, en el estilo de las dos anteriores (comentarios en inglés, `begin`/`commit`, RLS y permisos al final):

```sql
-- Stripe customer of an organization: created by the API on the first checkout, never by the browser.
create table public.billing_customers (
  org_id uuid primary key references public.organizations(id) on delete restrict,
  customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode boolean not null,
  created_at timestamptz not null default now()
);

-- One open checkout per organization, so two owners clicking "Pay" do not start two subscriptions.
create table public.checkout_sessions (
  id text primary key check (id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  org_id uuid not null references public.organizations(id) on delete restrict,
  plan_code text not null references public.plans(code) on delete restrict,
  url text not null,
  status text not null default 'open' check (status in ('open','complete','expired')),
  created_by uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index checkout_sessions_open_idx on public.checkout_sessions(org_id) where status = 'open';

-- The catalog price a plan charges. amount_cents, currency and interval mirror it for display; a price change creates a
-- new Stripe price and moves these columns together (§6.1).
alter table public.plans
  add column stripe_product_id text,
  add column stripe_price_id text unique;

-- What Stripe last said, kept raw beside the mapped status (§6.6).
alter table public.subscriptions
  add column provider_status text,
  add column price_id text,
  add column cancel_at_period_end boolean not null default false,
  add column current_period_start timestamptz,
  add column livemode boolean;
create unique index subscriptions_subscription_idx on public.subscriptions(subscription_id) where subscription_id is not null;

-- An event is "seen" when inserted and "done" when processed_at is set; only a processed event is skipped (§6.5).
alter table public.stripe_events
  add column livemode boolean,
  add column org_id uuid,
  add column attempts integer not null default 0,
  add column last_error text;
create index stripe_events_received_idx on public.stripe_events(received_at);

-- Account deletion (§4.8): the profile stays as a tombstone with no email.
alter table public.profiles
  add column deleted_at timestamptz,
  alter column email drop not null,
  add constraint profiles_email_unless_deleted check ((deleted_at is null) = (email is not null));
create unique index profiles_email_idx on public.profiles(lower(email)) where deleted_at is null;

-- Lookups the service does today by scanning lists.
create index invitations_email_idx on public.invitations(lower(email)) where accepted_at is null and revoked_at is null;
create index claim_tickets_expiry_idx on public.claim_tickets(expires_at);
```

Notas:
- Los nombres `billing_customers.customer_id` y `subscriptions.subscription_id` siguen la regla de DN-10: los ids del
  proveedor van sin prefijo `stripe_`. `plans.stripe_price_id` lleva el prefijo porque es configuración del catálogo y
  convive con columnas propias del plan. **[mía]**
- La semilla de planes de DN-10 (precios de ejemplo) se queda. En producción, antes de encender la webapp, los dos
  planes se actualizan con los precios reales y sus `stripe_price_id` (§12, T20). Con `WEBAPP_ENABLED=true`, el back no
  arranca si un plan activo no tiene `stripe_price_id`. **[mía]**
- `organizations.billing_status` sigue siendo **el** derecho de acceso (la "entitlement"): no hace falta una tabla
  aparte, porque hoy solo hay un derecho (entrar o no). Solo lo escribe la RPC de cobro. Si mañana hay planes con
  funciones distintas, se añade `plans.features jsonb` y una vista.

### 5.4 Funciones RPC

`SupabaseRepository` usa el cliente de datos de `supabase-js` (PostgREST), que no abre transacciones de varias
sentencias. Cada escritura que DN-10/DN-11 exige atómica pasa a una función, con el patrón de `create_assessment`:
`language plpgsql security definer set search_path = pg_catalog, public`, `revoke all … from public, anon,
authenticated` y `grant execute … to service_role`. El repositorio traduce los `raise exception` con un código propio
(`using errcode = 'P0001'` y un mensaje fijo como `webapp_conflict:scan_claimed`) a `WebappConflict` o
`IneligibleAssignee`.

| Función | Qué hace en una transacción | Bloqueos |
|---|---|---|
| `create_organization(p_org, p_owner, p_analysis)` | Organización + owner + análisis reclamado; `scan_claimed` si el scan ya es de alguien | La `UNIQUE` de `org_analyses.scan_id` |
| `claim_analysis(p_analysis)` | Añadir un análisis a una organización existente | Igual |
| `redeem_claim_ticket(p_id_hash, p_at)` | Gastar el ticket; devuelve si lo gastó esta llamada | `update … where used_at is null returning` |
| `accept_invitation(p_invitation_id, p_user, p_role, p_at)` | Membresía + aceptar + revocar las demás pendientes de ese email + auditoría | `for update` sobre la invitación |
| `set_member_role(p_org, p_target, p_role, p_actor, p_actor_role)` | Cambiar rol, re-comprobando `canManageMember` contra el rol leído bajo bloqueo; liberar acciones si pasa a `viewer`; auditoría | `select … for update` sobre la membresía (DN-11 en `types.ts`) |
| `remove_member(p_org, p_target, p_actor, p_actor_role)` | Igual, borrando; revoca invitaciones de su email | Igual |
| `upsert_assessment_action`, `create_custom_action`, `update_action` | Las escrituras del plan de acción con la regla del responsable (DN-11 D11) | `for share` sobre la membresía del responsable; `for update` sobre la organización al crear (límite de 100) |
| `apply_billing_state(p_event, p_state)` | Registrar el evento como procesado + upsert de `subscriptions` + `billing_status` + `audit_log`, todo o nada (§6.5) | `for update` sobre la organización |
| `review_deletion_request(...)` | Revisar + `deleted_at` + auditoría; resuelve la doble revisión que hoy da 500 en vez de 409 | `for update` sobre la solicitud |
| `delete_account(p_user, p_at)` | §4.8 | `for update` sobre las membresías del usuario |

`canManageMember` vive en `@arca/contracts` (TypeScript). Dentro de la RPC se reescribe como una expresión SQL de la
misma tabla, y un test de PGlite recorre la matriz entera contra las dos versiones para que no diverjan. **[mía]**

### 5.5 Row Level Security

- **Todas** las tablas de la webapp ya tienen RLS activado y ninguna política: para `anon` y `authenticated` la
  respuesta es "ninguna fila". Además, no tienen ningún permiso (`revoke all`). Se mantiene. **[mía, sigue a DN-10]**
- La clave publicable del front (antes "anon") solo sirve para la API de Auth. Aunque alguien la use contra la API de
  datos, no lee ni escribe ninguna tabla.
- Las funciones nuevas revocan `execute` de `public`: en Postgres toda función nueva es ejecutable por `PUBLIC` salvo que
  se revoque, y PostgREST expone las funciones del esquema `public` como `/rpc/…`.
- Un test de PGlite (y otro contra Supabase local) comprueba, con los roles `anon` y `authenticated`, que `select`,
  `insert` y `rpc` fallan en cada tabla y función de la webapp.
- **Si algún día** el front leyera directamente de la base (no se recomienda), las políticas serían de pertenencia, con
  `(select auth.uid())` para que Postgres lo evalúe una vez: `using (exists (select 1 from public.memberships m where
  m.org_id = <tabla>.org_id and m.user_id = (select auth.uid())))`. Esta nota no las crea.

### 5.6 Limpieza

PGlite no tiene `pg_cron`, así que la limpieza la hace el back **[mía]**: un temporizador cada hora, en el único
proceso de producción, borra lo que §4.8 marca para purga y pone `expired` a los `checkout_sessions` vencidos. Cada
borrado es una sentencia acotada (`delete … where … limit` vía RPC) y escribe una línea de log con el recuento.

## 6. Stripe

### 6.1 Productos y precios

| Plan (`plans.code`) | Producto Stripe | Price | `lookup_key` | Precio hoy en `plans.ts` (ejemplo) |
|---|---|---|---|---|
| `monthly` | "ARCA" | recurrente, mensual, USD | `arca_monthly` | 499,00 USD/mes |
| `annual` | "ARCA" | recurrente, anual, USD | `arca_annual` | 4.990,00 USD/año |

Los importes son los de ejemplo de la semilla; los reales son la decisión F1.

**Por qué precios de catálogo y no `price_data` (cambia DN-10 D10) [mía]:**
- El Customer Portal solo deja cambiar entre precios configurados en el catálogo. Con `price_data`, cada checkout crea un
  precio suelto y el cliente no puede pasar de mensual a anual por su cuenta.
- Los informes de Stripe (ingresos por plan, MRR) se agrupan por precio.
- Stripe Tax necesita un código fiscal en el producto (el de SaaS para uso empresarial; se confirma en el panel).

**Lo que se conserva de DN-10:** el precio se cambia desde `/admin` (`PUT /admin/plans/:code`). Con un importe nuevo,
el back:
1. crea un Price nuevo en el mismo producto, con `transfer_lookup_key: true` para quedarse con la `lookup_key`;
2. desactiva el anterior (`active: false`);
3. actualiza `plans` (`stripe_price_id`, `amount_cents`, `currency`, `interval`) y audita `plan.updated`.

Los suscriptores existentes siguen con su precio anterior hasta que alguien los migre (F2). Si el paso 1 funciona y el
3 falla, el reintento es seguro: el back busca primero un Price activo con esa `lookup_key` y ese importe.

### 6.2 Checkout

`POST /orgs/:id/billing/checkout { planCode }` (`billing.manage`, sin exigir pago):

1. `authorize` como hoy. Si `hasPaidAccess`: 409 (cambiar de plan es cosa del portal).
2. Si hay un `checkout_sessions` abierto y sin vencer para la organización: devuelve **su misma URL** (200). Así, dos
   clics o dos owners no crean dos suscripciones.
3. Cliente de Stripe: el de `billing_customers` o uno nuevo con `customers.create({ name: org.name, email: <email del
   owner que paga>, metadata: { org_id } }, { idempotencyKey: 'customer:<orgId>' })`.
4. `checkout.sessions.create(params, { idempotencyKey: 'checkout:<orgId>:<planCode>:<minuto>' })` con:

| Parámetro | Valor | Por qué |
|---|---|---|
| `mode` | `subscription` | |
| `customer` | el del paso 3 | Un cliente por organización |
| `client_reference_id` | `org.id` | Para reconciliar |
| `line_items` | `[{ price: plan.stripe_price_id, quantity: 1 }]` | Precio de catálogo (§6.1) |
| `metadata`, `subscription_data.metadata` | `{ org_id }` | El webhook resuelve la organización sin depender del cliente |
| `success_url` | `${APP_BASE_URL}/app/billing/return?session_id={CHECKOUT_SESSION_ID}` | §6.3 |
| `cancel_url` | `${APP_BASE_URL}/app/billing` | Como hoy |
| `billing_address_collection` | `required` | Factura con dirección; base de Stripe Tax |
| `customer_update` | `{ name: 'auto', address: 'auto' }` | Guarda lo que escribe en el cliente |
| `tax_id_collection` | `{ enabled: true }` si F3 lo pide | |
| `automatic_tax` | `{ enabled: true }` solo si F3 = Stripe Tax | |
| `allow_promotion_codes` | según F4 | |
| `subscription_data.trial_period_days` | solo si F4 = prueba | |
| `expires_at` | ahora + 1 h | Un checkout abierto bloquea otros (paso 2) |

5. Guarda la sesión en `checkout_sessions` y audita `billing.checkout_started`. Devuelve `{ url }`.

Métodos de pago: **solo tarjeta** al principio **[mía]**. Los métodos asíncronos (ACH) obligan a manejar
`checkout.session.async_payment_*` y un estado intermedio; se pueden añadir para el plan anual (F5).

### 6.3 Vuelta del checkout

El webhook puede tardar unos segundos. Para que la persona no aterrice en un `/app` bloqueado:

- `/app/billing/return` llama a `POST /orgs/:id/billing/sync { sessionId }` (`billing.manage`). El back recupera la
  sesión de Stripe (`checkout.sessions.retrieve(id, { expand: ['subscription'] })`), comprueba que su
  `client_reference_id` es esa organización y aplica el estado **por el mismo camino que el webhook** (§6.5). Es
  idempotente.
- Después la página consulta `GET /orgs/:id` hasta ver `paidAccess: true` (como mucho 30 s) y entra a `/app?paid=1`. Si
  no llega, muestra "Your payment is being confirmed" con un botón para reintentar. El acceso solo lo da el back.

### 6.4 Customer Portal

`POST /orgs/:id/billing/portal` (`billing.manage`, sin exigir pago): `billingPortal.sessions.create({ customer,
return_url: '${APP_BASE_URL}/app/billing' })`. Si la organización no tiene cliente todavía: 409 `no_customer`.

Configuración del portal (en el panel de Stripe, una vez por modo, test y live):

| Función | Valor propuesto [mía] |
|---|---|
| Actualizar método de pago | sí |
| Historial de facturas | sí |
| Datos del cliente (nombre, dirección, NIF) | sí |
| Cancelar suscripción | sí, **al final del periodo**, con motivo |
| Cambiar de plan | entre `arca_monthly` y `arca_annual`; prorrateo según F6 |
| Pausar | no |

Al volver del portal no hace falta `sync`: los cambios llegan por webhook y `/app/billing` lee el estado al cargar.

### 6.5 Webhook

`POST /billing/webhook`, público, en `https://api.arcacover.com/billing/webhook`. Se registra en el panel de Stripe
(un endpoint en test para `Arca-dev`, otro en live para producción), con la **misma versión de API** que fija el SDK.

**Procesamiento:**

1. Lee el cuerpo **crudo** (`await c.req.text()`), antes de cualquier parseo, y verifica con
   `stripe.webhooks.constructEvent(raw, c.req.header('Stripe-Signature'), STRIPE_WEBHOOK_SECRET)`. Firma inválida o
   ausente: **400**, sin tocar la base. La tolerancia por defecto es de 5 minutos, así que el reloj del host tiene que
   estar sincronizado (en EC2 lo está por defecto).
2. `event.livemode` tiene que coincidir con el modo de la clave del proceso. Si no: 400 y log de error.
3. Si el tipo no está en la tabla de abajo: **200** sin más (Stripe no reintenta).
4. Inserta el evento en `stripe_events` si no estaba (`on conflict do nothing`) y suma un intento. Si ya tiene
   `processed_at`: **200** (duplicado).
5. Resuelve la organización: `metadata.org_id` de la sesión o de la suscripción; si no, por `billing_customers`. Sin
   organización: marca el evento procesado con `last_error = 'unknown_org'`, 200 y log de aviso.
6. **Lee el estado actual** de la suscripción en Stripe (`subscriptions.retrieve`). No se fía del contenido del evento,
   que puede llegar tarde o desordenado. **[mía]**
7. Aplica con la RPC `apply_billing_state`, que en una transacción marca el evento procesado, hace el upsert de
   `subscriptions`, mueve `organizations.billing_status` y audita `billing.event_applied` (`actor_kind = 'system'`).
8. Responde **200**. Cualquier excepción: **500**, el evento queda sin `processed_at` y Stripe reintenta (en live, con
   espera creciente durante días).

**Arreglo frente al código actual:** `WebappService.applyBillingEvent` registra el evento (`recordBillingEvent`) antes de
aplicarlo. Si el proceso cae entre los dos pasos, el reintento se ve como duplicado y el cambio se pierde. La RPC del
paso 7 lo resuelve, porque registrar y aplicar son la misma transacción.

**Orden y concurrencia.** El paso 6 hace que el orden de llegada dé igual, salvo en un caso: dos entregas
simultáneas para la misma organización leen el estado en momentos distintos y la más vieja confirma la última. Como
producción es un solo proceso, el back serializa el procesamiento por organización con una cola en memoria **[mía]**.
Si un día hay varias instancias, hará falta un candado de la base que cubra la lectura de Stripe. Lo que se escape lo
corrige la reconciliación diaria (§9.5).

**Una suscripción vieja no pisa a la nueva.** `subscriptions` tiene una fila por organización. Un evento de una
suscripción distinta de la guardada solo se aplica si la guardada está en `canceled` (es una suscripción nueva tras
cancelar). Si las dos están activas, hay un cobro doble: no se aplica, se audita `billing.duplicate_subscription` y se
avisa (§9.5) para que una persona cancele y reembolse.

**Eventos:**

| Evento | Acción |
|---|---|
| `checkout.session.completed` | `checkout_sessions.status = complete`; enlaza `subscription_id`; lee y aplica la suscripción |
| `checkout.session.expired` | `checkout_sessions.status = expired`. No cambia el acceso |
| `customer.subscription.created` / `updated` / `deleted` | Lee y aplica |
| `invoice.paid` | Lee y aplica (renovación confirmada); audita `billing.invoice_paid` con el importe |
| `invoice.payment_failed` | Lee y aplica (normalmente pasa a `past_due`); audita `billing.payment_failed` |
| `invoice.payment_action_required` | Audita; Stripe avisa al cliente para autenticar el pago (3DS) |
| `customer.subscription.trial_will_end` | Solo si F4 = prueba: audita; Stripe avisa al cliente |
| `charge.refunded` | Audita `billing.refunded`. No cambia el acceso |
| `charge.dispute.created` | Audita y avisa (§9.5) |
| `checkout.session.async_payment_succeeded` / `_failed` | Solo si F5 añade métodos asíncronos |

Con la versión de API `2025-03-31.basil` y posteriores, `current_period_start` y `current_period_end` ya no están en la
suscripción sino en cada elemento (`items.data[].current_period_end`), y la suscripción de una factura se lee en
`invoice.parent.subscription_details.subscription`. El traductor lo tiene en cuenta: hay un solo elemento por
suscripción.

### 6.6 Estado de cobro

| `subscription.status` de Stripe | `billing_status` | Acceso | En pantalla |
|---|---|---|---|
| `incomplete` | `pending_payment` si nunca pagó; si no, sin cambio | no | "Payment pending" |
| `incomplete_expired` | `pending_payment` si nunca pagó; si no, `canceled` | no | "Payment not completed" |
| `trialing` (solo con F4) | `active` | sí | "Trial until …" |
| `active` | `active` | sí | "Active, renews …" o "Cancels on …" si `cancel_at_period_end` |
| `past_due` | `past_due` | sí, con aviso (DN-10 §4.5) | "Payment failed, update your card" |
| `unpaid` | `canceled` | no | "Subscription suspended" |
| `paused` | `canceled` | no | (no se ofrece pausar) |
| `canceled` | `canceled` | no | "Canceled": puede volver a pagar |

```
pending_payment ──checkout pagado──▶ active ◀──────── invoice.paid ────────┐
      ▲                               │   │                                │
      │                               │   └──renovación falla──▶ past_due ─┘
  (nunca pagó)                        │                             │
                                      └──cancelada / fin de periodo─┤ reintentos agotados
                                                                    ▼
                                                                canceled ──nuevo checkout──▶ active
```

- `billing_status` solo lo mueve `apply_billing_state`. El borrado aprobado no lo toca: pone `deleted_at` y cancela en
  Stripe; el webhook que llega después mueve el estado a `canceled` (DN-10 §4.4).
- **Reintentos (configuración de Stripe, "Manage failed payments") [mía]:** reintentos inteligentes durante 2 semanas
  y, al agotarse, **cancelar la suscripción**. Así `unpaid` casi no aparece y `past_due` dura como mucho esas dos
  semanas. La duración es la decisión F7.
- `provider_status` guarda el estado crudo de Stripe para soporte y para la reconciliación.

### 6.7 Modo test y modo live

| | Clave | Webhook | Base |
|---|---|---|---|
| Local y `live-debug` real | `sk_test_…` o restringida `rk_test_…` | `stripe listen` (secreto `whsec_` local) | `Arca-dev` |
| Producción | **restringida** `rk_live_…` | endpoint live | producción |

- El back deduce el modo del prefijo de la clave. Producción se niega a arrancar con una clave de test salvo
  `STRIPE_ALLOW_TEST_MODE=true` (para un ensayo en el host antes del lanzamiento); los modos de debug se niegan a
  arrancar con una clave live. **[mía]**
- **Clave restringida [mía]:** escritura en Customers, Checkout Sessions, Customer Portal, Subscriptions (para cancelar
  al aprobar un borrado) y Prices (para `/admin`); lectura en Products, Invoices y Events. Nada más.
- Las **test clocks** de Stripe (`testHelpers.testClocks`) permiten adelantar el tiempo de un cliente de test para
  probar renovaciones, fallos y cancelaciones sin esperar (§11).

### 6.8 Impuestos, recibos y facturas (puntos de decisión)

- **Impuestos (F3).** Vender SaaS a despachos de EE. UU. puede estar sujeto a impuesto de ventas según el estado, y la
  obligación nace al registrarse o superar umbrales en cada estado. Opciones: (a) Stripe Tax con `automatic_tax` y
  registros donde toque; (b) sin impuestos al principio y revisar con un asesor fiscal. No somos asesores fiscales: la
  decisión necesita a uno.
- **Recibos.** Stripe manda recibo y factura por email si se activan en el panel ("Email customers about successful
  payments" y los correos de facturas). Recomendado **[mía]**: activados, con la marca de ARCA, en vez de mandarlos
  desde el back.
- **Datos de factura (F12).** Razón social del despacho, dirección, identificador fiscal y un email de facturación que
  puede no ser el del owner. Checkout recoge los tres primeros; el email de facturación se cambia en el portal.

### 6.9 Reembolsos, disputas y borrado

- **Reembolsos (F8):** al principio, a mano desde el panel de Stripe, con una política escrita. El webhook solo audita
  `charge.refunded`; el acceso no cambia por un reembolso.
- **Disputas:** se responden desde el panel de Stripe; el back audita y avisa.
- **Aprobar un borrado** llama hoy a `billing.cancel(orgId)`. En real: `subscriptions.cancel(subscription_id)` inmediata
  y, según F8, con o sin reembolso prorrateado.

### 6.10 Interfaz `BillingProvider`

La interfaz de `apps/api/src/webapp/billing.ts` crece (y el simulado la implementa igual):

```ts
interface BillingProvider {
  ensureCustomer(input: { orgId: string; name: string; email: string }): Promise<{ customerId: string }>;
  createCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; successUrl: string; cancelUrl: string })
    : Promise<{ sessionId: string; url: string; expiresAt: string }>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  cancel(subscriptionId: string): Promise<void>;
  /** The provider's current state of a subscription, mapped (§6.6). */
  subscriptionState(subscriptionId: string): Promise<BillingState>;
  checkoutState(sessionId: string): Promise<{ orgId: string; subscriptionId: string | null; status: string }>;
  /** Verifies and parses a webhook; null when the signature is wrong. */
  parseWebhook(raw: string, signature: string | undefined): Promise<ProviderEvent | null>;
  createPrice(input: { plan: PlanRecord; amountCents: number }): Promise<{ priceId: string }>;
}
```

`StripeBillingProvider` usa el paquete `stripe` de npm con la versión de API fijada en el constructor, `maxNetworkRetries: 2`
y `timeout: 10_000`.

## 7. API

### 7.1 Composición

`compose.ts` construye la webapp así:

| Condición | Repositorio | Auth | Cobro | Correo |
|---|---|---|---|---|
| `production`, `WEBAPP_ENABLED=false` (por defecto) | — (501, como hoy) | — | — | — |
| `production`, `WEBAPP_ENABLED=true` | `SupabaseWebappRepository` | `SupabaseJwtAuth` | `StripeBillingProvider` | `SesMailer` (o el de F11) |
| debug, `WEBAPP_PROVIDERS=simulated` (por defecto) | `InMemoryWebappRepository` | `MockAppAuth` | `MockBillingProvider` | `MemoryMailer` |
| `live-debug`, `WEBAPP_PROVIDERS=real` | `SupabaseWebappRepository` | `SupabaseJwtAuth` | `StripeBillingProvider` (test) | el real o `MemoryMailer` |
| `mock`, `WEBAPP_PROVIDERS=real` | **no arranca** (mock nunca llama a servicios reales, DN-10 §2) | | | |

La línea de arranque dice qué se construyó: `webapp=real stripe=live`, `webapp=real stripe=test`,
`webapp=simulated-in-memory` o nada si no hay webapp.

### 7.2 Rutas

| Ruta | Estado | Cambio |
|---|---|---|
| `POST /auth/enroll { claimId } \| { invitationToken }` | **nueva**, pública | Crea el usuario de Supabase si hace falta (§4.2). Responde `{ email }`. Ticket o invitación inválidos: 410, como `redeemable` |
| `GET /orgs/:id/billing` | **nueva**, miembro, sin exigir pago | `BillingView`: estado, plan, fin del periodo, `cancelAtPeriodEnd`, `manageable` (si el rol tiene `billing.manage`). Lo leen todos los roles (DN-11 D10) |
| `POST /orgs/:id/billing/sync { sessionId }` | **nueva**, `billing.manage` | §6.3 |
| `DELETE /me` | **nueva**, sesión | §4.8 |
| `POST /billing/webhook` | 501 → **real** | §6.5. Fuera de `noStore` no cambia nada; fuera de CORS tampoco |
| `POST /orgs/:id/billing/checkout` | real | Stripe; devuelve la sesión abierta si la hay (§6.2) |
| `POST /orgs/:id/billing/portal` | real | Stripe; 409 `no_customer` sin cliente |
| `POST /orgs/:id/invitations` | cambia | Manda el correo; añade `emailSent` a la respuesta |
| `PUT /admin/plans/:code` | cambia | Un importe nuevo crea un Price (§6.1); 502 `billing_unavailable` si Stripe falla, sin tocar la tabla |
| `POST /admin/deletion-requests/:id/approve` | cambia | Cancela en Stripe (§6.9) |
| `/admin/*` | cambia en la fase 6 | Exige `aal2` (MFA) |
| Todas las demás de DN-10/DN-11 | sin cambios | Pasan de 501 a reales en producción |
| `POST /__debug/auth/login`, `POST /__debug/billing/pay` | sin cambios | Solo con proveedores simulados; con `WEBAPP_PROVIDERS=real`, 404 |

### 7.3 Contrato de errores

El formato no cambia: `{ error, message }` con los códigos de `WebappFailure`. Nuevos:

| HTTP | `error` | Cuándo |
|---|---|---|
| 401 | `unauthorized` | Token ausente, inválido, caducado, de otro emisor, o cuenta borrada |
| 403 | `mfa_required` | `/admin/*` con `aal1` (fase 6) |
| 409 | `conflict` (mensaje `sole_owner`) | `DELETE /me` siendo único owner |
| 409 | `conflict` (mensaje `no_customer`) | Portal sin cliente |
| 429 | `rate_limited` | §7.4, con `Retry-After` |
| 502 | `billing_unavailable` | Stripe no respondió o dio error 5xx; nada se escribió |
| 503 | `auth_unavailable` | `enroll` no pudo hablar con Supabase |

El webhook responde 400 (`invalid_signature`), 200 (aplicado, duplicado o ignorado) o 500 (reintentar). Nunca 401/403.

### 7.4 Límites de peticiones

En memoria por proceso, como `ScanLimiter` (producción es un proceso):

| Ruta | Límite propuesto [mía] |
|---|---|
| `POST /claims` | 20/h por IP |
| `POST /auth/enroll` | 10/h por IP y 5/h por ticket o invitación |
| `POST /orgs/:id/invitations` | 30/día por organización (cada una manda un correo) |
| `POST /orgs/:id/billing/checkout`, `/portal` | 10/h por organización |
| `POST /orgs/:id/billing/sync` | 30/h por organización |
| `DELETE /me` | 3/h por usuario |
| `POST /billing/webhook` | sin límite (lo protege la firma) |

Del lado de Supabase: un código cada 60 s por email, el límite de correos por hora del proyecto (se sube al poner el
SMTP propio) y el de verificaciones por IP. CAPTCHA (Turnstile) en `enroll` y en el login, en la fase 6 si aparece abuso.

### 7.5 CORS y CSRF

- La API autentica con `Authorization: Bearer` y no usa cookies, así que una web ajena no puede hacer peticiones
  autenticadas en nombre del usuario: no hay superficie de CSRF. `allowHeaders` sigue siendo exactamente
  `Content-Type,Authorization` en producción.
- **Recomendación [mía]:** quitar `http://localhost:3000` de `CORS_ALLOWED_ORIGINS` en `deploy/production.env` cuando la
  webapp se encienda. Con cuentas reales, un front local no tiene por qué hablar con la API de producción.
- El webhook no lo llama un navegador; CORS no le afecta.
- El front pone `Referrer-Policy: strict-origin-when-cross-origin` (o `no-referrer`) en `/app/*`, porque `/app/invite/[token]`
  y el `?claim=` llevan secretos en la URL (§4.7).

### 7.6 Contratos 0.5.0 y orden de publicación

Cambios en `packages/contracts/src`:

| Esquema | Cambio |
|---|---|
| `EnrollRequest`, `EnrollResponse` | nuevos (`webapp.ts`) |
| `BillingView` | nuevo: `{ billingStatus, plan: PlanView \| null, currentPeriodEnd, cancelAtPeriodEnd, manageable }` |
| `BillingSyncRequest` | nuevo: `{ sessionId }` |
| `InvitationView` | `emailSent: boolean` opcional (solo en la respuesta que crea) |
| `DebugModeResponse` (`debug.ts`) | `webapp: 'simulated' \| 'real'` y `billing: 'simulated' \| 'test'`, como anticipó DN-12 §7.4 |

Los campos nuevos de vistas existentes son opcionales, para que un front con 0.4.0 siga leyendo un back nuevo (el
front parsea estricto). `DebugModeResponse` gana campos obligatorios: solo afecta a los modos de debug en local.

**Ya en `packages/contracts/src` (T7, §17), sin publicar:** `EnrollRequest` (unión estricta: `{ claimId }` o
`{ invitationToken }`, cada uno de 1 a 512 caracteres) y `EnrollResponse` (`{ email }`), con sus tipos, como exportaciones
nuevas de `webapp.ts`. `DELETE /me` no tiene cuerpo ni respuesta (204), así que no añade esquema. Ningún esquema que el
front ya parsea cambió. Salen con 0.5.0 (T18).

**Orden** (el de DN-11, guardado en la memoria del proyecto):
1. Se fusiona el PR del back, con todo detrás de `WEBAPP_ENABLED=false`: producción sigue en 501.
2. Se crea el tag `contracts-v0.5.0`; `contracts-release.yml` publica el `.tgz`.
3. El PR del front apunta la dependencia a la URL de la release; el founder lo fusiona cuando pase Vercel.
4. Se enciende el back (`WEBAPP_ENABLED=true` en `production.env`) y después el front (`NEXT_PUBLIC_WEBAPP_ENABLED=true`
   en Vercel, producción). En ese orden: un front encendido con el back apagado mostraría el CTA y recibiría 501.

## 8. Front

### 8.1 Páginas y componentes

| Pieza | Hoy | Con la webapp real |
|---|---|---|
| `lib/supabase.ts` | `createClient` dormido | `createBrowserClient` de `@supabase/ssr` |
| `lib/app/auth.ts` | `signIn` → `debugSignIn` o `not_configured` | `requestCode(email)`, `verifyCode(email, code)`, `confirmLink(tokenHash)`, `signOut()`; en debug, el simulado como hoy |
| `lib/app/session.ts` | token en `localStorage` | token del cliente de Supabase en producción; el reclamo y la última organización, como hoy |
| `lib/app/client.ts` | Bearer de `loadAppSession()` | Bearer de `getSession()`; 401 → cerrar sesión y `/app/login` |
| `components/app/SaveResultsCta.tsx` | solo en debug | también en producción si `NEXT_PUBLIC_WEBAPP_ENABLED === "true"`; `SimulationNotice` solo en debug |
| `/app/signup` | email bloqueado + nombre → login simulado | 1) `enroll` + enviar código; 2) escribir código; 3) nombre de la organización → `POST /orgs` |
| `/app/login` | email → login simulado | email → código; mensaje neutro (§4.2); la casilla de admin simulado sigue solo en mock |
| `/app/auth/confirm` | — | **nueva**: botón que llama a `verifyOtp({ token_hash, type: 'email' })` y va a `next` (solo rutas `/app/`) |
| `/app/invite/[token]` | escribir email → login simulado → aceptar | `enroll` → email bloqueado → código → aceptar |
| `/app/billing` | planes + "Pay" → checkout simulado | estado desde `GET /orgs/:id/billing`; "Pay" → Stripe; "Manage subscription" → portal; los demás roles en solo lectura (DN-11 D10) |
| `/app/billing/return` | — | **nueva**: `sync` + espera (§6.3) |
| `/app/billing/mock-checkout` | debug | sin cambios: 404 y fuera del bundle en producción |
| `/app/settings` | renombrar, pedir borrado de la organización | además "Delete my account" (§4.8) |
| `/app/members` | invitar y copiar enlace | además "Invitation email sent" o "Email could not be sent, copy the link" |
| `/app/admin` | prueba de concepto | sin cambios; en la fase 6, pantalla de alta de MFA |

### 8.2 Variables de entorno

| Variable | Pública | Dónde | Valor |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | sí | Vercel (prod) y `.env.local` | URL del proyecto de producción o de `Arca-dev` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | sí | Igual | Clave publicable (`sb_publishable_…`). Sustituye a `NEXT_PUBLIC_SUPABASE_ANON_KEY` del `.env.example` |
| `NEXT_PUBLIC_WEBAPP_ENABLED` | sí | Vercel (prod) | `true` solo cuando el back esté encendido (§7.6 paso 4) |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_ARCA_MODE` | sí | Igual que hoy | Sin cambios |

**Ninguna variable de servidor nueva en el front.** El front no usa Stripe.js (Checkout es una página de Stripe), así
que no necesita ni la clave publicable de Stripe. El chequeo `check-no-debug` del build se amplía para fallar si el
bundle contiene `sb_secret_`, `sk_live_`, `sk_test_`, `rk_live_`, `rk_test_` o `whsec_`. **[mía]**

### 8.3 Previews y staging

Los previews de Vercel se construyen en modo producción y hablan con la API de producción. Con la webapp real,
necesitarían el Supabase de producción (el JWT tiene que ser de ese emisor) y apuntar a Stripe live. **[mía]**
`NEXT_PUBLIC_WEBAPP_ENABLED` queda **sin definir en el entorno Preview** de Vercel, y también en `staging.arcacover.com`
mientras staging no tenga su propia API. La webapp real se prueba en local con `live-debug` y `WEBAPP_PROVIDERS=real`.

### 8.4 Panel de debug

- **`mock`:** igual que hoy (login como rol de la semilla, pago simulado, "Show forbidden actions", reset).
- **`live-debug` simulado:** igual que hoy (DN-12 §7).
- **`live-debug` real:** el panel lee `webapp` y `billing` de `/__debug/mode`. Oculta el login y el pago simulados (las
  rutas dan 404), muestra "Webapp: real · Stripe test" y enlaza a la tarjeta de test 4242 y a `stripe listen`. La
  franja dice `LIVE DEBUG · real accounts (Arca-dev) · Stripe test`.

## 9. Secretos e infraestructura

### 9.1 Variables nuevas del back

| Variable | Secreta | Producción | Local / `live-debug` real |
|---|---|---|---|
| `WEBAPP_ENABLED` | no | `deploy/production.env` (`false` hasta el lanzamiento) | — |
| `WEBAPP_PROVIDERS` | no | — (producción siempre real) | `simulated` (por defecto) o `real` |
| `APP_BASE_URL` | no | `production.env`: `https://arcacover.com` | `http://localhost:3000` (por defecto) |
| `STRIPE_SECRET_KEY` | **sí** | SSM `/arca/prod/STRIPE_SECRET_KEY` (clave restringida live) | terminal o `.env.local` (test) |
| `STRIPE_WEBHOOK_SECRET` | **sí** | SSM `/arca/prod/STRIPE_WEBHOOK_SECRET` | el que imprime `stripe listen` |
| `STRIPE_ALLOW_TEST_MODE` | no | solo para un ensayo en el host | — |
| `EMAIL_FROM` | no | `production.env`: `ARCA <no-reply@arcacover.com>` | igual o buzón de pruebas |
| `EMAIL_PROVIDER` | no | `ses` (o el de F11) | `memory` |
| Credencial del correo | según F11 | Con SES: **ninguna**, permiso `ses:SendEmail` en el rol de la instancia, limitado a la identidad `arcacover.com`. Con otro proveedor: SSM `/arca/prod/EMAIL_API_KEY` | — |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | ya existen | Ya en SSM; la clave secreta pasa a usarse también para la API de administración de Auth | Las de `Arca-dev` |

No hacen falta `SUPABASE_JWT_SECRET` ni una URL de JWKS: el JWKS sale de `SUPABASE_URL` (§4.4).

`deploy/render-env.py`: si `production.env` tiene `WEBAPP_ENABLED=true`, añade `STRIPE_SECRET_KEY` y
`STRIPE_WEBHOOK_SECRET` a los parámetros obligatorios (y `EMAIL_API_KEY` si el proveedor lo pide), como ya hace con
`OPENAI_API_KEY`. Un despliegue sin ellos se niega en el host con un mensaje que los nombra.

`infra/aws` (CDK): si F11 = SES, la identidad de dominio, el permiso de envío del rol de la instancia y un tema SNS para
rebotes y quejas. La política del rol ya lee `/arca/prod/*`; no cambia.

**Configuración que no es un secreto pero hay que dejar escrita** (en el runbook `docs/deployment/AWS_DEMO_RUNBOOK.md`,
una sección nueva): en Supabase, el alta cerrada, las claves de firma asimétricas, las plantillas, las URLs, el SMTP, la
caducidad del código y los límites; en Stripe, el producto, los precios, el portal, los reintentos, los correos al
cliente y los dos endpoints de webhook.

### 9.2 Caddy

`deploy/Caddyfile` limita hoy el cuerpo de **todas** las peticiones a 32 KB. Un evento de Stripe suele ocupar pocos KB,
pero una factura con muchas líneas o una suscripción expandida puede pasar de ese límite, y un 413 haría que Stripe
reintentara sin fin. **[mía]** Se separa el webhook:

```
handle /billing/webhook {
	request_body {
		max_size 1MB
	}
	reverse_proxy api:8080
}
handle {
	request_body {
		max_size 32KB
	}
	# lo de hoy: basic_auth de /docs y reverse_proxy con health checks
}
```

(Se comprueba con `caddy validate` en el test del stack y en `container-smoke.mjs`.) No hace falta lista blanca de IPs
de Stripe: la firma es la defensa. El webhook queda expuesto en el mismo host y certificado que la API.

### 9.3 Desarrollo local

**Supabase:** dos opciones, que se complementan **[mía]**:
- **Supabase local** (`supabase start`, necesita Docker): para los tests de integración de las RPC, la RLS y la API de
  Auth. Trae un buzón de pruebas (Mailpit) donde se leen los códigos, así que el E2E puede iniciar sesión sin correo
  real.
- **`Arca-dev`**: para `live-debug` real con scans reales (DN-09 §11.7).

**Stripe** (PowerShell):

```powershell
stripe login                                    # una vez, abre el navegador; sin claves en la terminal
stripe listen --forward-to http://127.0.0.1:8080/billing/webhook
# imprime el secreto whsec_ de esta sesión: se pega en la terminal del back, nunca en el historial
$s = Read-Host -AsSecureString 'Stripe webhook secret'
$env:STRIPE_WEBHOOK_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$env:WEBAPP_PROVIDERS = 'real'
npm run stack -- live-debug
stripe trigger checkout.session.completed       # eventos de prueba sueltos
```

La regla de DN-09 §11.7 para las claves (leerlas con `Read-Host -AsSecureString`, nunca escribirlas en la línea de
comandos) vale igual para `STRIPE_SECRET_KEY`.

### 9.4 Supabase: lista de ajustes por proyecto

| Ajuste | Producción | `Arca-dev` |
|---|---|---|
| Allow new users to sign up | **off** | off |
| Email provider | on; Confirm email on | on |
| JWT Signing Keys | asimétricas (ECC P-256) | asimétricas |
| Email OTP Expiration / Length | 600 s / 6 | 600 s / 6 |
| SMTP | propio (F11) | propio o el de pruebas |
| Site URL / Redirect URLs | §4.9 | §4.9 |
| Secure email change | on | on |
| Plan | de pago (F10) | gratuito |

**Pasos en el panel de cada proyecto real** (`Arca-dev` en T8, producción en T24; nada de esto se ha hecho todavía):

1. **Authentication → Sign In / Providers → "Allow new users to sign up": off.** Es el alta cerrada (§4.2). El back sigue
   creando usuarios con la API de administración (que no mira este ajuste), y `signInWithOtp` con `shouldCreateUser: false`
   sigue mandando códigos a los usuarios que ya existen.
2. En la misma pantalla, el **proveedor Email sigue encendido** (es el que manda los códigos), con "Confirm email" encendido.
   Ojo con la confusión de nombres: en el `config.toml` local, `[auth.email] enable_signup` es este interruptor del proveedor
   (no el del alta) y tiene que quedarse en `true`; el alta cerrada es `[auth] enable_signup = false`.
3. **Email OTP Expiration = 600** y **Email OTP Length = 6** (en Authentication → Providers → Email, o en "Auth" según la
   versión del panel).
4. **Project Settings → JWT Keys:** migrar a claves de firma asimétricas (ECC P-256) y rotar para que la nueva firme. Comprobar
   que `https://<proyecto>.supabase.co/auth/v1/.well-known/jwks.json` lista una clave `ES256`; si sale vacío, el back no
   arranca en `real` (§16.1).
5. **Authentication → Email Templates → Magic Link:** asunto "Your ARCA sign-in code" y el cuerpo de §4.9, con `{{ .Token }}`
   (el código) y el enlace de respaldo `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`. El de Supabase local está en
   `supabase/templates/magic_link.html` y sirve de modelo. "Confirm signup", "Invite user" y "Change email address" con un texto
   neutro.
6. **Authentication → URL Configuration:** Site URL y Redirect URLs de la tabla de §4.9.
7. **SMTP propio** (F11) y, con él, subir el límite de correos por hora.

**Supabase local** (`supabase/config.toml`, T7): alta cerrada (`[auth] enable_signup = false`), códigos de 10 minutos
(`otp_expiry = 600`), la plantilla con el código (`[auth.email.template.magic_link]`) y las URLs de vuelta del front local
(`http://localhost:3000/**`, `http://127.0.0.1:3000/**`). Se aplican al reiniciar el stack (`supabase stop` y `supabase start`);
el stack que corrió las pruebas de §17 seguía con la configuración anterior.

### 9.5 Monitorización y alertas

- **Logs estructurados** de cobro: `[billing] event <id> <type> applied|duplicate|ignored|failed`, sin emails ni
  importes de tarjeta.
- **Stripe** avisa por email cuando un endpoint de webhook falla de forma continuada; se pone el email del founder.
- **Reconciliación diaria [mía]:** un temporizador del back lista las suscripciones de Stripe cambiadas en las últimas
  48 h, las compara con `subscriptions` y registra `[billing] reconcile mismatch` y las corrige por el camino del
  webhook.
- **Alertas:** hoy solo hay alarmas de estado del EC2 hacia el tema SNS `alerts`. Se propone mandar los logs de Docker a
  CloudWatch Logs (driver `awslogs`) con filtros de métricas sobre `[billing] failed`, `reconcile mismatch`,
  `duplicate_subscription` y `dispute`, cada uno con una alarma al mismo tema SNS.
- **Correo:** rebotes y quejas del proveedor a SNS; un rebote de un código de login se ve en los logs de Auth de
  Supabase.

## 10. Seguridad y privacidad

### 10.1 Datos personales

| Dato | Dónde vive | Quién lo ve |
|---|---|---|
| Email y nombre de cada persona | `auth.users`, `profiles` | El back; los miembros de su organización; el admin de plataforma |
| Nombre y dominio del despacho, análisis, plan de acción | Tablas de la webapp | Los miembros (según rol); el admin de plataforma |
| Dirección de facturación, NIF, últimos 4 dígitos de la tarjeta | **Solo Stripe** | El owner en el portal; ARCA en el panel de Stripe |
| Número completo de la tarjeta | **Nunca en ARCA**: Checkout es de Stripe (ámbito PCI mínimo, SAQ A) | — |
| IP y user agent de los logins | Logs de Auth de Supabase | ARCA |
| Actividad | `audit_log` | owner y admin de la organización; el admin de plataforma |

### 10.2 Lo que espera un despacho

Un despacho de abogados trata información confidencial y tiene deberes de diligencia tecnológica con sus proveedores
(en EE. UU., las reglas de conducta profesional sobre confidencialidad y competencia tecnológica). Aunque ARCA no reciba
información de los clientes del despacho, el análisis de riesgo es sensible (es la base de un seguro), y los despachos
medianos mandan cuestionarios de seguridad. Lo que esta nota deja preparado para responderlos:
- autenticación sin contraseña y MFA disponible (fase 6), con SSO como camino futuro;
- permisos por rol aplicados en el servidor y un registro de actividad que no se puede editar;
- cifrado en tránsito y en reposo (Supabase y Stripe), datos en EE. UU. (región del proyecto);
- lista de subencargados: Supabase, Stripe, AWS (y el proveedor de correo), con sus acuerdos de tratamiento de datos,
  que el founder firma o acepta (F13);
- borrado de cuenta y una política de retención escrita.

No es asesoría legal; los textos de privacidad y términos los revisa un abogado.

### 10.3 Amenazas y defensas

| Amenaza | Defensa |
|---|---|
| Cuenta para un email ajeno | Alta cerrada (§4.2); solo se entra con el código que llega a ese buzón |
| Filtro de correo gasta el enlace | Código como camino principal; enlace con botón (§4.1) |
| Robo de sesión por XSS | Cookies de sesión legibles por JS (limitación de `@supabase/ssr`): CSP estricta en `/app` cuando se mude a su subdominio (DN-10 §8); tokens de una hora |
| Token de Supabase de otro proyecto | `iss` exacto del proyecto y JWKS propio |
| Token simulado en producción | El verificador simulado no se construye en producción (§4.4) |
| Clave de servicio o de Stripe filtrada al front | Solo en SSM y en el back; `check-no-debug` busca sus prefijos en el bundle (§8.2) |
| Lectura directa de tablas con la clave publicable | RLS sin políticas y sin permisos para `anon`/`authenticated`; test que lo prueba (§5.5) |
| Webhook falso | Firma sobre el cuerpo crudo; `livemode` coherente |
| Webhook repetido, tardío o desordenado | `stripe_events` + `processed_at`; leer el estado actual; serialización por organización (§6.5) |
| Doble suscripción | Una sesión abierta por organización; detección en el webhook y alerta |
| Escalada de rol en carrera | RPC con re-comprobación bajo bloqueo (§5.4) |
| Enumeración de clientes por el login | Mismo mensaje para email con y sin cuenta; `enroll` no dice si existía |
| Abuso de correo (invitaciones, códigos) | Límites de §7.4; límites de Supabase; CAPTCHA en la fase 6 |
| Admin de plataforma comprometido | MFA obligatoria (`aal2`) en `/admin/*` (fase 6); alta solo por script y auditada |
| Secretos en URLs | `claim` se borra de la barra; `Referrer-Policy` en `/app` (§7.5) |

### 10.4 Mínimo privilegio

- Clave de Stripe **restringida** (§6.7).
- La clave secreta de Supabase solo en el contenedor de la API; las funciones RPC solo ejecutables por `service_role`.
- El front no tiene ninguna variable de servidor nueva.
- Con SES, sin credenciales: permiso del rol de la instancia limitado a la identidad del dominio.

### 10.5 Auditoría

Se añaden a `audit_log` (con `actor_kind`): `billing.checkout_started`, `billing.event_applied` (ya existe),
`billing.invoice_paid`, `billing.payment_failed`, `billing.refunded`, `billing.duplicate_subscription`,
`billing.dispute`, `account.deleted`, `platform_admin.granted`. Los eventos de cobro son `system`; `TARGETS` y
`ACTOR_KIND_OF_ACTION` de `service.ts` se amplían para que la actividad los nombre.

## 11. Plan de pruebas

**Unitarios (back)**
- `SupabaseJwtAuth` con un JWKS local generado con `jose` (`generateKeyPair('ES256')`): token válido; caducado; otro
  `iss`; otro `aud`; `alg: HS256` o `none`; `kid` desconocido (refetch); `is_anonymous: true`; sin `email`.
- Traductor de Stripe → `BillingState`: una fila por estado de §6.6, con objetos de la versión de API fijada (periodo en
  los elementos).
- Algoritmo del webhook con un `BillingProvider` falso: firma inválida → 400; tipo ignorado → 200; duplicado → 200 sin
  efecto; excepción a mitad → 500 y el reintento aplica; suscripción vieja no pisa a la nueva; doble suscripción →
  alerta.
- Guardas de arranque: clave live en debug, clave test en producción, `mock` + `real`, plan activo sin `stripe_price_id`.

**Migración y RPC**
- PGlite (como `assessment-database.test.ts`): las tres migraciones en orden; cada RPC con sus conflictos; la matriz
  `canManageMember` SQL contra la de TypeScript; `anon` y `authenticated` sin acceso (§5.5).
- **Suite de conformidad del repositorio [mía]:** los tests que hoy fijan `InMemoryWebappRepository` se corren también
  contra `SupabaseWebappRepository` sobre Supabase local. Las dos implementaciones cumplen el mismo contrato.

**Integración con Stripe en modo test** (con clave de test, sin tocar live; marcados para correr a mano o en un job
aparte, no en cada `npm test`)
- Checkout → `stripe listen` → `active`. La sesión se completa creando la suscripción por API con la tarjeta de prueba
  `pm_card_visa`: Stripe desaconseja automatizar sus páginas alojadas.
- **Test clocks:** cliente con reloj, suscripción mensual; adelantar un mes → `invoice.paid` → sigue `active`; cambiar a
  una tarjeta que falla (`pm_card_chargeCustomerFail`) y adelantar → `past_due` con acceso; agotar los reintentos →
  `canceled` y 402.
- Cancelar al final del periodo desde el portal (por API) → `cancelAtPeriodEnd: true`, acceso hasta el fin.
- Cambio de precio desde `/admin` → Price nuevo con la `lookup_key`; el siguiente checkout lo usa.
- Webhook firmado a mano con `stripe.webhooks.generateTestHeaderString` para los casos de borde.

**E2E de navegador** (Playwright, ampliando `npm run test:browser:webapp`)
- Contra el stack en `live-debug` real con Supabase local y Stripe test: resultados → CTA → código leído de Mailpit →
  organización → 402 → redirección a `checkout.stripe.com` comprobada → suscripción creada por API → `/app` activo.
- Invitado: correo en Mailpit → enlace → código → acepta → ve lo que su rol permite.
- Enlace de respaldo: abrir `/app/auth/confirm` sin pulsar no inicia sesión; pulsar sí.
- El smoke de mock sigue pasando sin cambios (5 de 5).

**Front**
- Tests de la página de confirmación (`next` solo con `/app/`), del mensaje neutro del login, de `return` (espera y
  reintento), y de que el CTA no se pinta en producción sin `NEXT_PUBLIC_WEBAPP_ENABLED`.
- Build de producción: `check-no-debug` con los prefijos de secretos (§8.2).

**Antes del lanzamiento (manual, en producción con la webapp encendida)**
- El founder compra el plan mensual con una tarjeta real, comprueba factura, recibo, portal y cancelación, y se
  reembolsa desde el panel.
- Un correo de código llega a una cuenta de Microsoft 365 y a una de Google sin ir a spam.

## 12. Despliegue por fases

Esfuerzo en días de una persona, aproximado. "Founder" marca lo que solo puede hacer él (cuentas, pagos de planes,
aprobaciones).

| # | Tarea | Fase | Esfuerzo | Depende de |
|---|---|---|---|---|
| T0 | Decisiones F1–F14 (§14) | 0 · founder | — | — |
| T1 | Crear `Arca-dev`; pasar producción a plan de pago; activar la cuenta de Stripe (datos de empresa) | 0 · founder | 0,5 | F9, F10 |
| T2 | Dominio de correo: SPF, DKIM, DMARC; alta del proveedor (salir del sandbox si es SES) | 0 · founder + 0,5 | 0,5 | F11 |
| T3 | ✅ Migración nueva + RPC + tests de PGlite (§5.3, §5.4, §5.5). Hecho: §12.1 | 1 · datos | 3 | — |
| T4 | ✅ `SupabaseWebappRepository` + suite de conformidad sobre Supabase local. Hecho: §12.1 | 1 · datos | 4 | T3 |
| T5 | Aplicar las tres migraciones a `Arca-dev` | 1 · datos | 0,25 | T3, T1 |
| T6 | `SupabaseJwtAuth`, `WEBAPP_PROVIDERS`, guardas de arranque y línea de arranque (§4.4, §7.1). **Hecha (§16.1)** | 2 · auth | 1,5 | — |
| T7 | ✅ `POST /auth/enroll` con la API de administración de Supabase y límites (§4.2). Hecho: §17 | 2 · auth | 1,5 | T4 |
| T8 | Configurar Auth en `Arca-dev`: alta cerrada, claves asimétricas, plantillas, URLs, SMTP (§9.4) | 2 · auth | 1 | T2 |
| T9 | Front: `@supabase/ssr`, módulo de sesión, login, signup, confirm, invite (§8.1) | 2 · auth | 4 | T6, T7 |
| T10 | `Mailer` + correo de invitación (§4.6). **Hecha en el back, sin el SDK de SES (§16.2)** | 2 · auth | 1,5 | T2 |
| T11 | `DELETE /me` + RPC + pantalla en settings (§4.8). **Back hecho (§17)**; la pantalla va con el front (T9) | 2 · auth | 1,5 | T4 |
| T12 | ✅ Script `admin:grant` (§4.5). Hecho en la fase 1: §12.1 | 2 · auth | 0,5 | T4 |
| T13 | Catálogo de Stripe en test; `plans` con `stripe_price_id`; cambio de precio desde `/admin` (§6.1) | 3 · cobro | 1,5 | T4 |
| T14 | `StripeBillingProvider`: cliente, checkout, portal, sync, cancelar (§6.2–§6.4, §6.10) | 3 · cobro | 2 | T13 |
| T15 | Webhook: firma, traductor, RPC `apply_billing_state`, cola por organización (§6.5, §6.6) | 3 · cobro | 2,5 | T14 |
| T16 | Front: `GET /orgs/:id/billing`, `/app/billing` real, `/app/billing/return`, portal (§8.1) | 3 · cobro | 1,5 | T14 |
| T17 | Caddy: ruta del webhook con su límite de cuerpo (§9.2) | 3 · cobro | 0,5 | — |
| T18 | Contratos 0.5.0 y publicación (§7.6) | 4 · integración | 0,5 | T6–T16 |
| T19 | `/__debug/mode` con `webapp` y `billing`; panel y franja (§8.4) | 4 · integración | 1 | T18 |
| T20 | E2E en `live-debug` real + suite de Stripe con test clocks (§11) | 4 · integración | 3 | T9–T19 |
| T21 | SSM (`STRIPE_*`), `render-env.py`, `production.env` con `WEBAPP_ENABLED=false`, CDK si SES (§9.1) | 5 · producción | 0,5 | T20 |
| T22 | **Aprobación del founder** y aplicación de las migraciones a producción (§5.2) | 5 · founder | 0,5 | T21 |
| T23 | Stripe live: producto, precios reales, portal, reintentos, correos, endpoint del webhook | 5 · founder + 0,5 | 0,5 | F1–F8 |
| T24 | Supabase de producción: ajustes de §9.4 | 5 · producción | 0,5 | T22 |
| T25 | Encender back y después front; compra real de prueba y reembolso (§11) | 5 · producción | 0,5 | T22–T24 |
| T26 | Monitorización: logs a CloudWatch, filtros, alarmas, reconciliación diaria (§9.5) | 5 · producción | 2 | T15 |
| T27 | Limpieza programada (§5.6) | 6 · endurecer | 1 | T4 |
| T28 | MFA (TOTP) obligatoria para admins de plataforma, opcional para owners (§4.1) | 6 · endurecer | 1,5 | T9 |
| T29 | CAPTCHA en `enroll` y login si hay abuso | 6 · endurecer | 1 | T9 |
| T30 | Quitar `localhost` de CORS de producción; `Referrer-Policy` en `/app` (§7.5) | 6 · endurecer | 0,25 | T25 |

**Total aproximado:** 38 a 40 días de trabajo técnico, más el tiempo del founder para cuentas, decisiones y
aprobaciones. El camino crítico es T3 → T4 → T7 → T9 → T14 → T15 → T20 → T22 → T25.

**Puertas entre fases:**
- Fin de la fase 1: suite de conformidad verde contra Supabase local.
- Fin de la fase 3: un recorrido completo en `live-debug` real contra `Arca-dev` y Stripe test.
- Fin de la fase 4: E2E y test clocks verdes, y la release `contracts-v0.5.0` publicada.
- Antes de T25: el founder aprueba precios, términos y privacidad.

### 12.1 Fase 1 hecha: T3, T4 y T12 (2026-11-18)

Rama `feat/real-accounts-data` (desde `feat/real-accounts`). Nada se conecta todavía en `compose.ts`: producción sigue en 501
y `mock`/`live-debug` siguen con `InMemoryWebappRepository`. El repositorio nuevo se registra en la fase 2 (el punto de
enganche `apps/api/src/webapp/real-adapters.ts` de la rama de auth). `packages/contracts` no cambia.

**T3 · Migración y RPC.** `supabase/migrations/20261118000000_real_accounts_billing.sql`:
- Las tablas, columnas e índices de §5.3 tal cual.
- Funciones, todas `security definer` con `search_path` fijo, ejecutables solo por `service_role` y revocadas a `public`,
  `anon` y `authenticated`. Errores con `errcode P0001` y mensaje fijo (`webapp_conflict:<motivo>`, `webapp_refused:member_change`,
  `webapp_ineligible_assignee`, `webapp_missing:<registro>`, `webapp_duplicate:<registro>`, `webapp_invalid:organization`):
  `create_organization`, `claim_analysis`, `redeem_claim_ticket`, `accept_invitation`, `set_member_role`, `remove_member`,
  `revoke_invitation`, `upsert_assessment_action`, `create_custom_action`, `update_action`, `apply_billing_state`,
  `review_deletion_request`, `delete_account`, `grant_platform_admin`, `revoke_platform_admin` y `list_audit`.
- Ayudantes internos, sin permiso para ningún rol cliente ni para `service_role`: `can_manage_member` (la matriz de
  `canManageMember` en SQL), `can_hold_actions`, `append_audit`, `require_assignee`, `patched_action` y `lock_member_change`.
- RLS activado en las dos tablas nuevas, sin políticas y con permisos solo para `service_role` (§5.5).
- Tests: `apps/api/tests/integration/real-accounts-database.test.ts` (PGlite, 33 tests): cada función con sus conflictos; la
  matriz `canManageMember` SQL contra TypeScript; `anon`/`authenticated` sin acceso a tablas ni funciones; la migración sobre
  filas ya escritas; y los casos de concurrencia de §5.4 como intercalados: doble revisión → `already_reviewed` (409, no 500),
  doble revocación → la segunda no escribe ni audita, cambio de rol que pierde contra una baja → `null` sin auditoría, admin que
  degrada a alguien recién ascendido a owner → `webapp_refused`, el mismo evento de Stripe dos veces → `duplicate`.

**T4 · Repositorio y conformidad.**
- `apps/api/src/webapp/supabase.ts`: `SupabaseWebappRepository` sobre `supabase-js` con la clave de servicio. Lecturas y
  escrituras de una fila van a las tablas; toda escritura de varias filas, a su RPC. Lee solo las columnas de cada registro y
  devuelve las fechas en ISO con `Z`, como el repositorio en memoria.
- Suite de conformidad compartida: `apps/api/tests/conformance/webapp-repository.ts` (43 tests). Corre contra el repositorio en
  memoria (`apps/api/tests/unit/webapp-repository.test.ts`), contra `SupabaseWebappRepository` sobre PGlite a través de un
  sustituto de PostgREST (`apps/api/tests/fixtures/pglite-postgrest.ts`, en
  `apps/api/tests/integration/webapp-repository-database.test.ts`, dentro de `npm test`, sin red) y contra un Supabase real
  (`apps/api/tests/integration/webapp-repository-supabase.test.ts`), que se salta salvo que existan
  `ARCA_CONFORMANCE_SUPABASE_URL` y `ARCA_CONFORMANCE_SUPABASE_KEY`, y que solo acepta un host local salvo
  `ARCA_CONFORMANCE_SUPABASE_ALLOW_REMOTE=1` (para `Arca-dev`, nunca producción). Los pasos para correrla están en la cabecera
  de ese archivo: `supabase db reset` en local, la URL y la clave de servicio de `supabase status -o env` en esas dos
  variables, y `npx vitest run` de ese archivo. La suite no supone una base vacía: ids nuevos en cada test, listas filtradas a lo
  que escribió, y fechas de un reloj lejano en el futuro que avanza de una ejecución a la siguiente. Deja sus filas (el
  `audit_log` es de solo añadir); `supabase db reset` las borra. Cambia una sola fila compartida, el plan `monthly`, y la deja
  como estaba.
- **Resultado contra Supabase local:** verde, 43 de 43, dos veces seguidas (la segunda con las filas de la primera), contra Supabase local
  (CLI 2.122.1, Postgres 17, PostgREST v14.5) tras `supabase db reset`, que aplicó las ocho migraciones sin errores. Además, con
  la clave publicable (`anon`) la API de datos responde 401 a las tablas de la webapp, a las dos tablas nuevas y a las funciones
  (`list_audit`, `delete_account`), y `delete_account` probada a mano en esa base (único owner → `sole_owner`; un miembro → baja
  y perfil sin email). Las pruebas de RPC de T3 corren en PGlite; en Supabase local las cubren la suite y esa prueba a mano.

**T12 · `admin:grant`.** `npm run admin:grant -- <email> [--revoke] [--dry-run]` (`apps/api/scripts/admin-grant.ts`, lógica en
`apps/api/src/webapp/admin-grant.ts`, tests en `apps/api/tests/unit/admin-grant.test.ts` contra el repositorio en memoria). Lee
`SUPABASE_URL` y `SUPABASE_SECRET_KEY` (o `SUPABASE_SERVICE_ROLE_KEY`) del entorno o de `.env.local`, como `db:verify`. Imprime
el host de destino, nunca la clave. Sin perfil para ese email, se niega: la persona tiene que haber entrado una vez. Concede o
retira con `grant_platform_admin`/`revoke_platform_admin`, que auditan `platform_admin.granted`/`platform_admin.revoked` con
`actor_kind = 'platform'` y sin usuario, en el mismo paso y solo si algo cambió. `--dry-run` no escribe nada. Las reglas de §4.5
siguen: en local contra `Arca-dev`, y contra producción solo con el visto bueno del founder y desde el host.

**Desviaciones respecto a §5.4 y por qué [mía]:**
- **Firmas.** `set_member_role(p_org_id, p_user_id, p_role, p_actor_user_id, p_actor_role, p_audit, p_at)` y `remove_member`
  igual sin rol nuevo. Además de `p_actor_role`, reciben al actor: la función comprueba bajo bloqueo que **el actor sigue teniendo
  ese rol** (si lo degradaron mientras tanto, se niega) y que `canManageMember` sigue valiendo contra el rol del objetivo leído
  con `for update`. `p_audit` es `{ actor_kind, actor_user_id }`: quién firma la auditoría lo decide el servicio (la semilla de
  mock audita como `system`). Los cambios de dueño de una organización se serializan con el mismo candado consultivo que
  `guard_last_owner`, así la comprobación del último owner es exacta.
- **Funciones nuevas que §5.4 no listaba:** `revoke_invitation` (la doble revocación que pedía el encargo), `grant_platform_admin`
  y `revoke_platform_admin` (T12) y `list_audit` (el orden por `(created_at, seq)` con cursor no se puede expresar con los
  filtros de PostgREST).
- **La auditoría va dentro de la transacción** en `accept_invitation`, `set_member_role`, `remove_member`, `revoke_invitation`,
  `apply_billing_state`, `review_deletion_request`, `delete_account` y las de admin. `create_organization` y `claim_analysis` no
  auditan: lo sigue haciendo el servicio después, como hoy.
- **`apply_billing_state(p_event, p_org_id, p_state, p_at)`** inserta el evento si no estaba (no hace falta un paso previo), suma
  un intento, y si ya estaba procesado devuelve `duplicate`. Aplica "una suscripción vieja no pisa a la nueva" (§6.5) dentro de
  la transacción: devuelve `duplicate_subscription` (y audita `billing.duplicate_subscription`) si otra suscripción que da acceso
  llega con la guardada viva, y `stale_subscription` si la otra no da acceso; las dos marcan el evento procesado con
  `last_error = 'other_subscription'`. `p_state` llega ya traducido a `billing_status` (§6.6): la traducción es de T15. Un campo
  nulo conserva lo guardado, como hoy.
- **`delete_account`** conserva las membresías de las organizaciones **ya borradas** (su historia y su último owner; el trigger del
  último owner impediría quitarlas). Revoca las invitaciones pendientes a su email en todas las organizaciones (motivo
  `account_deleted`) y audita `account.deleted` en cada organización viva que pierde al miembro. Es idempotente.
- **Interfaz del repositorio** (`apps/api/src/webapp/types.ts`), con el repositorio en memoria al mismo nivel: `setRole` y
  `removeMember` reciben un `MemberChange` y devuelven el rol que encontraron (o `null`), y lanzan `MemberChangeRefused`;
  nuevos `acceptInvitation`, `revokeInvitation`, `applyBillingState`, `findProfileByEmail` y `revokePlatformAdmin`;
  `reviewDeletionRequest` marca el borrado y audita en el mismo paso y lanza `already_reviewed`; `grantPlatformAdmin` devuelve si
  cambió. El repositorio en memoria impone además lo que ya imponían los índices SQL: una invitación pendiente por email y
  organización, un perfil por email y una suscripción del proveedor por organización.
- **Servicio** (`service.ts`): aceptar, cambiar rol, quitar, revocar, revisar un borrado y aplicar un evento de cobro pasan por
  esas operaciones atómicas. Respuestas nuevas: 403 cuando la nueva comprobación del almacén niega el cambio, 409 en la segunda
  revisión, 410 en la segunda aceptación, 404 en la segunda revocación. Esto cierra la carrera que `types.ts` dejaba anotada
  (DN-11) y el fallo de §6.5 (registrar el evento antes de aplicarlo) también para el pago simulado. La actividad de ARCA nombra
  el usuario de `platform_admin.*`.
- **Orden de `listPlans` en SQL:** por importe y código, lo que mantiene el orden de la semilla (mensual y luego anual).

**Pendiente, de otras tareas:** usar `delete_account` (T11, que también añade `deleted_at` y el email nulo a `ProfileRecord`),
leer y escribir los campos nuevos de `subscriptions` desde el webhook real (T15), `billing_customers` y `checkout_sessions`
(T14), registrar el repositorio en `compose.ts` (fase 2) y aplicar las tres migraciones a `Arca-dev` (T5).

## 13. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| El proyecto de producción sigue en el plan gratuito y se pausa | Clientes que pagan sin acceso | F10 antes del lanzamiento |
| Base compartida entre dev y producción | Usuarios y pagos de prueba mezclados con los reales | R6, F9 |
| Correos de código en spam o bloqueados por el filtro del despacho | No pueden entrar | SMTP propio con SPF/DKIM/DMARC; código en vez de enlace; enlace de invitación copiable |
| Webhook caído o lento | Pagó y no entra | `sync` al volver; reintentos de Stripe; reconciliación diaria; alerta |
| Doble suscripción | Cobro doble | Una sesión abierta por organización; detección y alerta |
| Cambio de versión de la API de Stripe | Campos que se mueven (como el periodo en basil) | Versión fijada en el SDK y en el endpoint; los tests usan objetos de esa versión |
| Impuestos mal configurados | Deuda fiscal | F3 con un asesor |
| Front y back con contratos distintos (parseo estricto) | Pantallas que fallan | Orden de §7.6; campos nuevos opcionales |
| Un solo proceso (límites y cola en memoria) | Se pierden al reiniciar; no escala a varias instancias | Aceptable para el MVP; anotado en §6.5 y §7.4 |
| Borrado de cuenta o de datos con implicaciones legales | Reclamaciones | Política de retención escrita (F13); borrado físico fuera de alcance |
| Cookies de sesión legibles por JS | Robo de sesión si hay XSS | CSP y mudanza a subdominio (DN-10 §8); tokens de una hora |
| La API de administración de Auth falla en `enroll` | No se puede registrar | 503 explícito y reintento; nada a medias |

## 14. Decisiones abiertas para el founder

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| F1 | Precios | Importes y moneda de `monthly` y `annual` (hoy de ejemplo: 499 USD/mes y 4.990 USD/año) | USD; anual con descuento de unos dos meses |
| F2 | Cambios de precio a clientes existentes | Mantener su precio / migrarlos con aviso | Mantenerlo (por defecto en Stripe) |
| F3 | Impuestos | Stripe Tax desde el día 1 / sin impuestos y revisar con un asesor | Consultar a un asesor fiscal antes del lanzamiento; dejar `automatic_tax` listo |
| F4 | Prueba gratuita y cupones | Sin prueba / N días con tarjeta / cupones de lanzamiento | Sin prueba (el análisis gratuito ya es la prueba); cupones permitidos para pilotos |
| F5 | Métodos de pago | Solo tarjeta / también transferencia ACH para el anual | Solo tarjeta al principio |
| F6 | Cambio de plan en el portal | Con prorrateo / sin él | Con prorrateo |
| F7 | Margen de impago | Reintentos durante 1 / 2 / 3 semanas antes de cancelar | 2 semanas, con acceso y aviso mientras tanto |
| F8 | Reembolsos | Ninguno / prorrateados / a criterio | A criterio, escrito en los términos; al aprobar un borrado, cancelación inmediata sin reembolso salvo excepción |
| F9 | Proyectos de Supabase | Uno compartido / dos (producción y `Arca-dev`) | Dos |
| F10 | Plan de Supabase de producción | Gratuito (se pausa) / de pago | De pago antes del primer cliente |
| F11 | Proveedor de correo | Amazon SES / Postmark / Resend | SES (ya en AWS, sin credenciales con el rol de la instancia) |
| F12 | Quién paga y datos de factura | Solo el owner (hoy) / también admin; email de facturación propio; NIF | Solo el owner; dirección y NIF obligatorios en Checkout |
| F13 | Retención y privacidad | Años de conservación tras un borrado; textos de privacidad y términos; acuerdos de tratamiento con Supabase, Stripe y AWS | 7 años y revisión de un abogado (§4.8) |
| F14 | Sesiones y MFA | Duración de la sesión; MFA obligatoria u opcional para owners | 7 días de inactividad, 30 de máximo; MFA obligatoria para ARCA y opcional para clientes |

## 15. Cambios que esta nota propone sobre DN-10, DN-11 y DN-12

- **DN-10 §4.1 y §4.8:** la verificación del JWT es solo por JWKS con algoritmos asimétricos; desaparece la opción
  `SUPABASE_JWT_SECRET`. `/app/login` sigue sin crear usuarios y, además, el registro público de Supabase se apaga
  (§4.2).
- **DN-10 §4.2:** tablas nuevas `billing_customers` y `checkout_sessions`; columnas nuevas en `plans`,
  `subscriptions`, `stripe_events` y `profiles` (§5.3).
- **DN-10 §4.4 y decisión 10:** el precio vive en `plans` **y** en un Price de catálogo de Stripe; `price_data` se
  sustituye por `stripe_price_id`. Cambiar el precio desde `/admin` sigue funcionando (§6.1).
- **DN-10 §4.4:** el webhook lee el estado actual de Stripe y registra y aplica en la misma transacción (§6.5).
- **DN-10 §4.6:** el script `admin:grant` que se cita no existe; se escribe (§4.5).
- **DN-10 §4.7:** las invitaciones se mandan por correo; `inviteUrl` se mantiene (§4.6). Ruta nueva `POST /auth/enroll`.
- **DN-10 §10:** pasos 1 a 3 diseñados aquí; el paso 4 solo en lo que toca a los correos.
- **DN-11:** la carrera de `setRole`/`removeMember` y la doble revisión de un borrado se cierran en las RPC (§5.4). La
  actividad nombra los eventos de cobro nuevos (§10.5).
- **DN-12 §7.4:** `DebugModeResponse` gana `webapp` y `billing`, como esa nota anticipó (§7.6).

## 16. Implementación

### 16.1 T6: verificación de Supabase Auth, proveedores de la webapp y guardas (2026-11-18)

**Hecho** en `feat/real-accounts-auth` (sale de `feat/real-accounts`), commit `5313a91`. Sin contratos
nuevos: `packages/contracts/src` no cambia y ninguna respuesta que parsee el front cambia de forma.

**Ficheros**

| Fichero | Qué |
|---|---|
| `apps/api/src/webapp/auth.ts` | `SupabaseJwtAuth`, `AuthUnavailable`, `JwksFetcher`; `AppUser` gana `aal` y `sessionId` opcionales |
| `apps/api/src/webapp/real-adapters.ts` | **nuevo**: `RealWebappAdapters` (la costura) y `REAL_WEBAPP_ADAPTERS`, hoy vacío |
| `apps/api/src/config/env.ts` | `WEBAPP_ENABLED`, `WEBAPP_PROVIDERS`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ALLOW_TEST_MODE`, `EMAIL_PROVIDER`, `EMAIL_FROM`; devuelve `webapp`, `stripeMode`, `emailProvider`, `emailFrom` |
| `apps/api/src/compose.ts` | `realWebapp()` junto a `simulatedWebapp()`; tercer parámetro `adapters`; línea de arranque |
| `apps/api/src/webapp/routes.ts` | `AuthUnavailable` → **503** `auth_unavailable` |
| `apps/api/src/debug/tools.ts`, `apps/api/src/http/app.ts` | el buzón en memoria y el reset; comentarios |
| `deploy/production.env` | `WEBAPP_ENABLED=false`, explícito (parte de T21) |
| `.env.example` | las variables nuevas, comentadas |

**Verificación del JWT** (§4.4). `jwtVerify` de `jose` (ya era dependencia, `^5.9.6`; no se añadió nada) con
`issuer = ${SUPABASE_URL}/auth/v1`, `audience: 'authenticated'`, `algorithms: ['ES256', 'RS256']` y
`requiredClaims: ['exp', 'sub', 'email']`; después, `role === 'authenticated'`, `is_anonymous !== true`, `sub` UUID y un
email con forma de email. `userId` es el `sub` en minúsculas y el email va en minúsculas (§4.5). Ningún claim da permisos:
el rol sigue saliendo de `memberships` en cada petición. No existe camino con `SUPABASE_JWT_SECRET`.

**El JWKS.** Se lee de `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` y solo se quedan las claves EC P-256 o RSA con
`kid`, de firma y con un algoritmo permitido (una `oct` se descarta). Caché de 10 minutos; un `kid` desconocido vuelve a
leerlo, como mucho una vez cada 30 s (la rotación con clave en espera verifica sin cortar sesiones, y un `kid` inventado
no hace que la API martillee a Supabase). Si Supabase no responde, siguen valiendo las últimas claves leídas; si no hay
ninguna, la ruta responde 503 `auth_unavailable` y no 401, para que el front no cierre la sesión por un fallo nuestro.
`jose` comprueba el algoritmo antes de pedir la clave: un token HS256 o sin firma nunca llega al JWKS.

**Al arrancar** (`checkSigningKeys`): un JWKS sin ninguna clave asimétrica detiene el arranque (el proyecto sigue con el
secreto HS256 heredado); un Supabase que no responde no lo bloquea: se registra `[auth] …` y la primera petición lo lee.

**Qué construye cada modo** (§3.2, §7.1), resuelto en `loadEnv` como `webapp: 'none' | 'simulated' | 'real'`:

| | `webapp` | Línea de arranque |
|---|---|---|
| `production` (por defecto o `WEBAPP_ENABLED=false`) | `none`: 501 en las 22 rutas, como hoy | sin cambios |
| `production` con `WEBAPP_ENABLED=true` | `real` | `webapp=real stripe=live email=ses` |
| `mock`, `live-debug` (por defecto, o `WEBAPP_PROVIDERS=simulated`) | `simulated`: idéntico a hoy, más el buzón en memoria | sin cambios (`webapp=simulated-in-memory` en `live-debug`) |
| `live-debug` con `WEBAPP_PROVIDERS=real` | `real`; `/__debug/auth/login`, `/__debug/billing/pay` y `/__debug/seed` dan 404 | `webapp=real stripe=test email=memory` |

**Guardas de arranque** (todas con un mensaje que nombra la variable):
- `production` con cualquier `WEBAPP_PROVIDERS` (producción siempre es real y se enciende con `WEBAPP_ENABLED`).
- `mock` con `WEBAPP_PROVIDERS=real`.
- Una clave live de Stripe (`sk_live_`/`rk_live_`) en **cualquier** modo de debug, aunque no use Stripe: una clave live
  en `.env.local` se rechaza, no se ignora. `STRIPE_ALLOW_TEST_MODE` no lo cambia nunca.
- `production` real con clave de test, salvo `STRIPE_ALLOW_TEST_MODE=true`.
- Una clave que no sea `sk_`/`rk_` + `live_`/`test_` (una publicable `pk_…` incluida), y un secreto de webhook sin `whsec_`.
- La webapp real sin `STORAGE_BACKEND=supabase` (y por tanto sin `SUPABASE_URL` y clave secreta), sin
  `STRIPE_SECRET_KEY` o sin `STRIPE_WEBHOOK_SECRET`.
- `production` real sin `EMAIL_FROM` explícito, con `EMAIL_PROVIDER=memory`, o con un `APP_BASE_URL` que no sea `https`
  (el valor por defecto es el front local: los enlaces de invitación y las vueltas de Stripe irían a localhost).
- `EMAIL_PROVIDER=ses` con la webapp simulada; un `EMAIL_FROM` que no sea una dirección o `Nombre <dirección>`.

**La costura.** `compose(env, storage?, adapters = REAL_WEBAPP_ADAPTERS)`. `RealWebappAdapters` tiene `repository`
(`client => WebappRepository`, el cliente de servicio de los scans), `billing` (`{ secretKey, webhookSecret, mode,
appBaseUrl } => BillingProvider`), `sesSendEmail` y `fetchJwks`. Hoy `REAL_WEBAPP_ADAPTERS` está vacío: con la webapp real
pedida, `compose` se niega a arrancar y nombra lo que falta ("the Supabase webapp repository (DN-13 T4)", "the Stripe
billing provider (DN-13 T14)", "the SES sender"), **antes** de tocar Supabase. Nunca cae a una pieza simulada. T4 solo
tiene que añadir `repository: client => new SupabaseWebappRepository(client)` en ese fichero, y T14 el `billing`.

**Desviaciones respecto a la nota**
1. **Caché propia sobre `createLocalJWKSet`** en vez de `createRemoteJWKSet`: `jose` 5 no deja inyectar el `fetch`, y los
   tests tenían que servir el JWKS sin red. Mismos tiempos que los de `jose` (10 min, 30 s), y además conserva las claves
   viejas si Supabase no responde.
2. **503 `auth_unavailable`** también para un verificador sin claves, no solo en `enroll` (§7.3).
3. **Sin bucle de reintentos** al arrancar: si Supabase no responde, se registra y la primera petición vuelve a leer.
4. **`live-debug` real todavía no arranca**: exige Stripe (§3.2), y el proveedor de Stripe es T14. La guarda lo dice.
5. La línea de arranque añade `email=<proveedor>` a lo que propone la §7.1.
6. `WEBAPP_ENABLED` solo lo lee producción; en los modos de debug no hace nada (siempre hay webapp).
7. `POST /billing/webhook` sigue en 501 también con la webapp real: es T15.
8. **No hecho aquí:** el 401 para una cuenta con `deleted_at` (§4.4, es T11), `admin:grant` (T12), `/__debug/mode` con
   `webapp` y `billing` (T19, contratos 0.5.0) y `render-env.py` con los secretos de Stripe (T21).

### 16.2 T10: `Mailer` y correo de invitación (2026-11-18)

**Hecho** en el mismo commit, salvo el SDK de SES.

| Fichero | Qué |
|---|---|
| `apps/api/src/webapp/mailer.ts` | **nuevo**: `Mailer`, `EmailMessage`, `MemoryMailer`, `SesMailer` con un `SesSendEmail` inyectado |
| `apps/api/src/webapp/invitation-email.ts` | **nuevo**: `invitationEmail()` y `MailingWebappService` |

- **`EMAIL_PROVIDER`**: `memory` (por defecto en los modos de debug) o `ses` (por defecto en producción, y la única
  opción allí). **`EMAIL_FROM`**: por defecto `ARCA <no-reply@arcacover.com>`; en producción, obligatorio.
- **`MemoryMailer`** guarda los mensajes en el proceso. Lo usan la webapp simulada (ahora también "manda" sus
  invitaciones ahí) y `live-debug` real con `EMAIL_PROVIDER=memory`. El reset de `/__debug/reset` lo vacía con el resto
  de la memoria de la webapp. Ninguna ruta lo expone todavía: el panel lo leerá cuando exista su contrato (T19).
- **`SesMailer`** traduce el mensaje a la entrada de `SendEmail` de SES v2 (un destinatario, texto y HTML en UTF-8,
  `ConfigurationSetName` opcional para rebotes y quejas). `@aws-sdk/client-sesv2` **no** es dependencia y no se añadió:
  el envío llega inyectado (`RealWebappAdapters.sesSendEmail`). El cableado (`new SESv2Client(...)` +
  `SendEmailCommand`) está escrito en el comentario de `SesMailer`; con SES no hay credencial, el rol de la instancia
  da `ses:SendEmail` (§9.1, §10.4). Mientras no esté, producción con `EMAIL_PROVIDER=ses` se niega a arrancar.
- **El correo** (§4.6), en inglés. Asunto `You're invited to join <organización> on ARCA`. Cuerpo: quién invita (su email:
  no hay nombre que mostrar), la organización, el rol ("as an admin", "a member", "a viewer"), el enlace
  `${APP_BASE_URL}/app/invite/<token>` (el mismo `inviteUrl` de la respuesta), la fecha de caducidad y "If you weren't
  expecting this invitation, you can ignore this email". Ningún otro dato personal. El nombre de la organización lo
  escribe un cliente: se le quitan los saltos de línea y caracteres de control antes del asunto y se escapa en el HTML.
- **Cuándo se manda**: después de que la invitación quede escrita (y auditada). Un fallo del envío no la deshace: se
  registra `[mail] invitation <id> was created but its email was not sent (<nombre del error>)`, sin email ni enlace.

**Desviaciones**
1. **`MailingWebappService` extiende `WebappService`** y envuelve `invite()`, en vez de tocar `service.ts`, que está
   cambiando en paralelo (T4). Para el nombre de la organización vuelve a leerla con `orgView` tras la escritura: una
   lectura más por invitación. Cuando llegue `emailSent`, la lógica puede entrar en el servicio.
2. **Sin `emailSent` en la respuesta**: `InvitationView` es estricto y el front lo parsea; el campo llega con los
   contratos 0.5.0 (§7.6). `inviteUrl` sigue igual.
3. El asunto no lleva el email de quien invita (solo el cuerpo), para que no salga en las vistas previas.

### 16.3 Pruebas

Sin red, sin Supabase, Stripe ni AWS reales. Se escribieron antes que el código y fallaron primero.

| Fichero | Tests nuevos | Qué fija |
|---|---|---|
| `apps/api/tests/unit/supabase-jwt-auth.test.ts` | 10 | ES256 y RS256 válidos con claves generadas con `jose` y un JWKS inyectado; caducado; sin `exp`; otro emisor; otra audiencia; HS256, sin firma y token simulado rechazados sin pedir el JWKS; `role`, `is_anonymous`, sin email, `sub` no UUID; solo claves asimétricas; `kid` desconocido → rotación verificada, con un refetch por enfriamiento; caché de 10 min; Supabase caído con y sin claves (503); comprobación de arranque |
| `apps/api/tests/unit/env.test.ts` | 11 | Las guardas de arriba, modo por modo |
| `apps/api/tests/integration/compose.test.ts` | 7 | Cada modo: `mock` y `live-debug` simulados idénticos y sin tocar la costura; `live-debug` real (Supabase verifica, simulaciones en 404, token simulado 401); producción apagada (501, nada construido); producción encendida (repositorios durables, CORS exacto, invitación por SES); arranque negado sin adaptadores; JWKS vacío o caído |
| `apps/api/tests/unit/mailer.test.ts` | 8 | `MemoryMailer`, la entrada de SES v2, el correo (contenido, cabeceras y HTML seguros) y el envío tras la escritura, con fallo y con invitación rechazada |
| `apps/api/tests/unit/deploy-marker.test.ts` | 1 | `production.env` deja la webapp apagada y sin `WEBAPP_PROVIDERS` |

`npm run typecheck` limpio. `npm test` completo: 1437 de 1438; fallaron `infra/aws/lib/arca-demo-stack.test.ts` (no hay
`aws-cdk-lib` en un worktree, esperado) y, una vez, un test de `crawler.test.ts` por carga, que pasa solo (29 de 29).

## 17. Implementación de T7 y T11 en el back (2026-11-19)

**Hecho** en `feat/real-accounts`, commit `421a773`. Producción sigue en 501 (las dos rutas nuevas también: `/auth/*` y
`DELETE /me` están detrás de `WEBAPP_ENABLED`), y `live-debug` real sigue sin arrancar hasta que exista el proveedor de Stripe
(T14).

### 17.1 Ficheros

| Fichero | Qué |
|---|---|
| `apps/api/src/webapp/auth-admin.ts` | **nuevo**: `AuthAdmin` (`createUser(email) → 'created' \| 'exists'`, `deleteUser(id) → 'deleted' \| 'missing'`), `AuthAdminUnavailable`, `SupabaseAuthAdmin` (`auth.admin` de supabase-js) e `InMemoryAuthAdmin` |
| `apps/api/src/webapp/service.ts` | `enroll`, `deleteAccount`, `requireLiveAccount`; `authAdmin` en las dependencias; código `auth_unavailable` (503) y conflicto `sole_owner`; listas de miembros sin cuentas cerradas; `account.deleted` en la actividad |
| `apps/api/src/webapp/routes.ts` | `POST /auth/enroll`, `DELETE /me`, el 401 de una cuenta cerrada, los límites de §7.4 y `/auth/*` entre las rutas que dan 501 |
| `apps/api/src/webapp/types.ts` | `ProfileRecord` con `deleted_at` y `email` nulo; `ProfileWrite`; `WebappRepository.deleteAccount`; `sole_owner` |
| `apps/api/src/webapp/in-memory.ts`, `supabase.ts` | `deleteAccount` (en memoria, igual que la RPC; en Supabase, la RPC `delete_account`); `upsertProfile` nunca resucita un perfil cerrado; `deleted_at` en las lecturas |
| `apps/api/src/webapp/real-adapters.ts`, `apps/api/src/compose.ts` | `authAdmin` en la costura (`client => new SupabaseAuthAdmin(client)`, el mismo cliente de servicio que el repositorio); sin él, la webapp real no arranca y lo nombra |
| `apps/api/src/http/rate-limit.ts`, `apps/api/src/http/app.ts` | `WindowLimiter` (ventana deslizante por clave, en memoria); la IP del cliente llega a las rutas |
| `apps/api/src/debug/tools.ts`, `apps/api/src/webapp/auth.ts` | el reset de debug olvida también los límites y los usuarios simulados; `mockUserIdFor`; el login simulado responde 409 a una cuenta cerrada |
| `packages/contracts/src/webapp.ts` | `EnrollRequest`, `EnrollResponse` (exportaciones nuevas, §7.6) |
| `supabase/config.toml`, `supabase/templates/magic_link.html` | Supabase local: alta cerrada, códigos de 10 minutos, plantilla con el código, URLs de vuelta (§9.4) |

### 17.2 `POST /auth/enroll` (§4.2)

- **Pública.** Cuerpo: exactamente uno de `{ claimId }` o `{ invitationToken }` (cualquier otra forma: 400 `invalid_request`).
- **Reclamo:** las comprobaciones de `redeemable` sin gastarlo y sin usuario con el que comparar: existe, no caducó, no se usó,
  y su scan está terminado y no es uno aislado por un fallo inyectado. El email es el del ticket.
- **Invitación:** existe, ni aceptada, ni revocada, ni caducada, y su organización no está borrada. El email es el de la
  invitación.
- Con eso, `auth.admin.createUser({ email, email_confirm: true })` con la clave de servicio. Si el email ya tiene usuario
  (`email_exists`, o el mensaje "already registered" de versiones anteriores de GoTrue), es el mismo éxito.
- **Respuesta: 200 `{ email }`**, la misma tenga o no cuenta ese email. No se escribe nada más: el perfil lo crea `ensureProfile`
  en la primera petición con sesión, con `profiles.user_id = sub = auth.users.id` (§4.5; comprobado contra Supabase local).
- **Un solo 410 `gone`** (mismo cuerpo, mismo mensaje) para todo reclamo o invitación que no sirve, sea cual sea el motivo.
- **503 `auth_unavailable`** si la API de administración falla o no responde. Antes no se ha escrito nada y el reclamo sigue
  sin gastar: reintentar es seguro.
- **Límites (§7.4):** 10 por hora por IP y 5 por hora por reclamo o invitación (la clave del límite es el hash, nunca el
  secreto). Pasado el límite, 429 `rate_limited` con `Retry-After` en segundos. Un cuerpo inválido (400) no cuenta.

### 17.3 `DELETE /me` (§4.8)

1. Si la persona no tiene perfil todavía (nunca pasó por una ruta que lo escriba), se crea primero, para que quede la lápida.
2. `deleteAccount` → RPC `delete_account` en una transacción. Única owner de alguna organización no borrada: **409 `conflict`**
   con un mensaje que lo explica, sin escribir nada. Es el único 409 de esta ruta.
3. `auth.admin.deleteUser(id, false)`: borrado físico; GoTrue borra con el usuario sus sesiones, refresh tokens e
   identidades. Así se revocan las sesiones (comprobado: tras el borrado, el refresh token ya no sirve). Un usuario que ya no
   existe cuenta como hecho.
4. **204** sin cuerpo.

Si el paso 3 falla dos veces seguidas dentro de la misma petición, la cuenta ya está cerrada (el paso 2 se confirmó) y la
respuesta es **503 `auth_unavailable`**. `DELETE /me` es la única ruta que acepta el token de una cuenta cerrada, precisamente
para que el front (o la persona) repita la petición con el mismo token: los dos pasos son idempotentes. Se registra
`[auth] account <id> was closed but its Auth user was not deleted` (sin email). Límite: 3 por hora por usuario (429).

**Cuenta cerrada = 401.** Toda ruta con sesión, salvo `DELETE /me`, lee el perfil y responde **401 `unauthorized`** si tiene
`deleted_at`, aunque el access token siga vivo hasta su `exp`. Cuesta una lectura de `profiles` por petición. Además,
`upsertProfile` no reescribe nunca un perfil cerrado (en SQL lo impide `profiles_email_unless_deleted`, porque el upsert no
manda `deleted_at`): una petición que pasó la comprobación justo antes del borrado falla en vez de devolver el email al perfil.

**Lo que ve el resto:** los miembros de la organización dejan de verlo; la actividad muestra `account.deleted` con
`actor.email: null`, `targetLabel: null` y `change: { from: <rol>, to: null }`; las invitaciones pendientes a su email se
revocan (`invitation.revoked`, motivo `account_deleted`). En una organización **ya borrada** la membresía se conserva (§12.1),
pero la ficha del admin de plataforma no la lista: `MemberView.email` es obligatorio en el contrato y la persona ya no existe.

### 17.4 Modos simulados

`mock` y `live-debug` simulado usan `InMemoryAuthAdmin` con los mismos ids que el login simulado (`mockUserIdFor`), así que
`enroll` y `DELETE /me` funcionan igual sin red. Como el login simulado deriva el id del email, una cuenta cerrada volvería como
ella misma y recibiría 401 en todo: `POST /__debug/auth/login` responde **409** a ese email hasta un `POST /__debug/reset`, que
olvida también los límites de la webapp y los usuarios simulados.

### 17.5 Desviaciones respecto a la nota

1. **`enroll` responde 200 `{ email }`**, nunca 204 (§4.2 dejaba elegir), y **un reclamo ya usado también es 410** (en
   `redeemable` es 409): todos los rechazos tienen la misma respuesta.
2. **`enroll` no crea el perfil.** El enlace con `auth.users` lo hace `ensureProfile` con el `sub` del token, como ya hacía.
3. **Reintento del borrado en Auth:** dos intentos dentro de la petición y, si fallan, 503 y reintento desde el cliente. No hay
   cola en segundo plano. Si nadie reintenta, queda un usuario de Auth huérfano: puede pedir un código, pero todas las rutas le
   dan 401, y ese email no puede volver a registrarse (`enroll` lo ve como "ya existe"). Pendiente para T27: un barrido que
   borre en Auth los usuarios cuyo perfil está cerrado.
4. **Sesiones:** se revocan con el borrado físico del usuario, sin una llamada aparte a `signOut`.
5. **La 503 reutiliza `auth_unavailable`**, el código que T6 ya usa cuando el verificador no tiene claves (§16.1).
6. **El 409 de `DELETE /me`** lleva un mensaje legible, no la palabra `sole_owner`: la ruta no tiene otro 409.
7. **Privacidad (F13):** cerrar la cuenta vacía `profiles` y borra el usuario de Auth, pero el email sigue en
   `invitations.email` y en el `target` de las filas `invitation.revoked` del `audit_log` (las escribe la RPC de la fase 1).
   Queda para la política de retención.
8. **Configuración local:** se cambió además la caducidad del código (`otp_expiry = 600`), la plantilla y las URLs de vuelta,
   no solo el alta cerrada (§9.4).

### 17.6 Pruebas

Escritas antes que el código; fallaron primero (módulos y métodos inexistentes).

| Fichero | Tests | Qué fija |
|---|---|---|
| `apps/api/tests/unit/auth-admin.test.ts` | 6 | La petición exacta a `/auth/v1/admin/users` (POST con `email_confirm`, DELETE con `should_soft_delete: false`); "ya existe" y "ya no existe" como éxito; 500, 502, 401 y fallo de red como `AuthAdminUnavailable`, sin el email en el log; el admin en memoria |
| `apps/api/tests/integration/webapp-accounts.test.ts` | 13 | `enroll` por reclamo y por invitación, misma respuesta si ya existía, el reclamo sigue sin gastar; un único 410 para nueve motivos; 400; 503 sin nada escrito; límites con `Retry-After`. `DELETE /me`: 409 al único owner; cierre completo y 401 en todas las rutas; owner con otro owner; 503 y reintento; límite; ficha del admin de una organización borrada; sin sesión |
| `apps/api/tests/conformance/webapp-repository.ts` | +4 (×3 destinos) | `deleteAccount`: `sole_owner` sin cambios; cierre de membresías vivas, acciones, enlaces y perfil con su auditoría; idempotente, el perfil no resucita y el email queda libre; único owner de una organización borrada y usuario sin perfil |
| `apps/api/tests/integration/compose.test.ts` | +2 y ampliados | La costura entrega `authAdmin` con el mismo cliente; sin él no arranca; producción apagada da 501 en las dos rutas; `mock` simula y el login simulado da 409 tras cerrar la cuenta |
| `apps/api/tests/integration/real-accounts-supabase.test.ts` | 2 | Contra Supabase local (ver abajo); se salta sin `ARCA_AUTH_SUPABASE_*` |

`npm run typecheck` limpio. `npm test` completo una vez: 1564 pasan, 49 se saltan (la suite de conformidad sobre Supabase real y
esta prueba, sin sus variables) y 1 falla: `infra/aws/lib/arca-demo-stack.test.ts` por tiempo bajo carga; sola pasa 7 de 7.

### 17.7 Resultado contra Supabase local

Stack local de la CLI 2.122.1 con GoTrue v2.196.0, las ocho migraciones aplicadas.

- **Suite de conformidad** (`webapp-repository-supabase.test.ts`): **47 de 47**, con los cuatro casos nuevos de `deleteAccount`
  sobre la RPC real.
- **Prueba de punta a punta** (`real-accounts-supabase.test.ts`): **2 de 2**, dos veces. Arranca la webapp real de `live-debug`
  con `compose` y los adaptadores que se entregan (el repositorio de Supabase y `SupabaseAuthAdmin`; el cobro simulado en lugar
  de T14). Recorrido: scan terminado en la tabla `scans` → `POST /claims` → antes de `enroll`, `signInWithOtp` con
  `shouldCreateUser: false` falla → `POST /auth/enroll` crea el usuario (confirmado) y repetirlo da la misma respuesta → inicio
  de sesión con el correo que GoTrue dejó en Mailpit → **el token es ES256 y su `kid` está en el JWKS local**, y
  `SupabaseJwtAuth` lo verifica → `GET /me` con `id = sub` y el perfil enlazado → `POST /orgs` → `DELETE /me` del owner: 409.
  Después: invitación → `enroll` con el token de invitación → inicio de sesión → aceptar → `DELETE /me`: 204, `GET /me` con el
  mismo token: 401, el refresh token ya no sirve, el usuario de Auth no existe, `signInWithOtp` vuelve a fallar, repetir el
  borrado da 204, y el owner ve la baja en miembros y en la actividad.
- **El proyecto local firma con clave asimétrica:** el JWKS publica una clave EC P-256 (`ES256`), y la CLI configura GoTrue con
  `GOTRUE_JWT_KEYS`. No hizo falta tocar el verificador ni configurar nada.
- **El código de 6 dígitos:** la plantilla por defecto de GoTrue v2.196 solo lleva el enlace (`token` = hash del código), no
  `{{ .Token }}`. Como el stack no se podía reiniciar, la prueba usa lo que trae el correo: el código si la plantilla lo lleva y,
  si no, el hash del enlace (`verifyOtp({ token_hash, type: 'email' })`, el camino del enlace de respaldo). Ambas veces entró por
  el enlace. El camino del código se comprobó aparte con el mismo GoTrue: un código de 6 dígitos de `auth.admin.generateLink`
  verificado con `verifyOtp({ email, token, type: 'email' })`, la llamada exacta del front, da una sesión del mismo usuario.
  Con la plantilla nueva (`supabase/templates/magic_link.html`, tras reiniciar) el correo de Mailpit traerá el código.
- **Alta pública:** el stack que corrió las pruebas seguía con `enable_signup = true` (lo dice la prueba al empezar); el
  `config.toml` nuevo la apaga en el siguiente reinicio.

Cómo correrla: la cabecera de `apps/api/tests/integration/real-accounts-supabase.test.ts` (URL, clave secreta y clave publicable
de `supabase status -o env` en `ARCA_AUTH_SUPABASE_URL`, `ARCA_AUTH_SUPABASE_SECRET_KEY` y `ARCA_AUTH_SUPABASE_PUBLISHABLE_KEY`;
solo hosts locales).

### 17.8 Lo que necesita el front (T9)

| Llamada | Petición | Respuestas |
|---|---|---|
| `POST /auth/enroll` (sin sesión) | `{ claimId }` o `{ invitationToken }` (`EnrollRequest`) | 200 `{ email }` (`EnrollResponse`); 400 `invalid_request`; 410 `gone` (el enlace ya no vale: volver a los resultados o pedir otra invitación); 429 `rate_limited` con `Retry-After`; 503 `auth_unavailable` (reintentar) |
| `DELETE /me` (Bearer) | sin cuerpo | 204; 401 `unauthorized`; 409 `conflict` (único owner: transferir o pedir el borrado de la organización); 429; 503 `auth_unavailable` (la cuenta ya está cerrada: repetir la misma petición) |
| Cualquier ruta con sesión | — | además, 401 `unauthorized` si la cuenta está cerrada |

**Secuencia de alta y entrada** (`@supabase/ssr`, `createBrowserClient(url, publishableKey)`):

1. Reclamo: `POST /claims { scanToken }` → `claimId` (como hoy, en `sessionStorage`). Invitación: el `token` de
   `/app/invite/<token>`.
2. `POST /auth/enroll` con uno de los dos → `{ email }`. La pantalla muestra ese email bloqueado. Una sola vez por flujo; para
   reenviar el código no hace falta repetirlo.
3. `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo:
   '${origin}/app/auth/confirm?next=<ruta /app/...>' } })`. Un error aquí se muestra con el mensaje neutro de §4.2.
4. La persona escribe el código: `supabase.auth.verifyOtp({ email, token, type: 'email' })` → sesión. Enlace de respaldo:
   `/app/auth/confirm` pide un clic y llama a `verifyOtp({ token_hash, type: 'email' })`.
5. Cada llamada a la API lleva `Authorization: Bearer ${(await supabase.auth.getSession()).data.session.access_token}`.
6. Reclamo: `POST /orgs { name, claimId }`. Invitación: `POST /invitations/:token/accept`.
7. **Login** de alguien con cuenta (`/app/login`): solo los pasos 3 a 5, sin `enroll`.
8. **Borrar la cuenta** (`/app/settings`): `DELETE /me`; con 204, `supabase.auth.signOut({ scope: 'local' })`, `forgetOrg()`,
   `clearPendingClaim()` y a la portada. Con 409, explicar lo de la propiedad. Con 503, ofrecer reintentar (el token sigue
   valiendo para esa ruta).

### 17.9 Pendiente

- **T9** (front) y **T8** (configurar `Arca-dev`: los pasos de §9.4).
- Reiniciar Supabase local para aplicar el `config.toml` nuevo, y entonces la prueba de §17.7 entra con el código del correo.
- El barrido de usuarios de Auth huérfanos (§17.5, punto 3), con la limpieza de T27.
- La pantalla "Delete my account" (parte de T11 en el front).
