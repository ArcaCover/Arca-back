# DN-11 · Vistas por rol en la webapp

- **Fecha:** 2026-11-05
- **Estado:** diseño aprobado por Jesús y revisado contra el código (4 revisores y un crítico, 64
  hallazgos incorporados); en implementación
- **Repos:** `Arca-back` y `Arca-front`, rama `feat/role-views` en ambos
- **Parte de:** DN-10 (webapp, organizaciones y cobro) y la vista previa de `/app`
  (`Arca-front/docs/superpowers/specs/2026-10-29-webapp-ui-mock-design.md`)

Las marcas siguen la convención de DN-10: **[Jesús]** decidido por Jesús, **[mía]** decidido por
Claude y revisable.

## 1. Por qué

DN-10 definió cuatro roles de organización (owner, admin, member y viewer), una tabla de permisos en
`@arca/contracts` y un rol aparte de plataforma para la gente de ARCA. El back aplica esa tabla en
cada ruta. El front, en cambio, muestra casi lo mismo a todos:

- Las pantallas reales solo deshabilitan algunos botones.
- Las pantallas de muestra no distinguen rol.
- En los modos de debug, DN-10 §5 deja **activos** todos los botones a propósito, para mostrar el 403
  del back.

Esta nota hace que cada rol vea su propia webapp. También vuelve real lo que distingue a un `member`
(marcar acciones), completa el panel de ARCA y da a la demo usuarios de cada rol listos para entrar.

## 2. Decisiones

| # | Decisión | Quién |
|---|---|---|
| D1 | Alcance: los cuatro roles más el admin de plataforma. El broker queda fuera; si entra, con su propia DN | **[Jesús]** |
| D2 | El `member` solo ve y marca acciones. Pierde `analysis.create`. Tampoco reporta incidentes ni sube evidencia | **[Jesús]** |
| D3 | Lo que un rol no puede hacer se oculta, en todos los modos. En mock, el interruptor "Show forbidden actions" del panel de debug lo vuelve a mostrar (controles, ítems de la barra y pantallas) para probar el 403 del back. Reemplaza la regla de DN-10 §5 | **[Jesús]** |
| D4 | El plan de acción pasa a ser real en el back: estado, responsable y fecha, con permiso y auditoría | **[Jesús]** |
| D5 | La actividad de la organización (`/app/activity`) es real, sale de `audit_log` y no exige pago: el owner conserva su rastro aunque no pague | **[mía]** |
| D6 | Renombrar la organización es real (`org.update`), sin exigir pago. El resto del perfil de la firma sigue de muestra | **[mía]** |
| D7 | El rol se prueba entrando como usuarios reales de una organización de semilla. No hay "ver como" ni suplantación | **[mía]** |
| D8 | El front no muestra primas ni decisión comercial (`CLAUDE.md` del front). El back sigue enviando la decisión en los análisis, como hoy. Quién las ve se decide con las DN de capa 1 y 2 | **[mía]** |
| D9 | Alcance técnico como DN-10: el back funciona solo en mock, la migración se prueba en PGlite sin aplicarse, y no hay Supabase, Stripe ni email reales | **[mía]** |
| D10 | Billing se abre para todos los roles: el owner gestiona y los demás ven el estado en solo lectura. Así, una organización sin pagar no deja sin salida al `member` ni al `viewer`. El ítem de la barra lo ven solo el owner y el admin | **[mía]** |
| D11 | Solo se puede asignar una acción a quien puede marcarla: owner, admin o member | **[mía]** |
| D12 | Cualquiera con `actions.update` cambia el estado de cualquier acción, asignada a quien sea. Cada cambio queda auditado | **[mía]** |
| D13 | Las acciones propias se pueden borrar (`actions.assign`). Las del assessment no, solo cambian de estado | **[mía]** |
| D14 | Un análisis nuevo trae un plan nuevo: el progreso no se arrastra por `action_key`. Los estados del plan anterior se guardan y ya no se muestran ni se editan | **[mía]** |
| D15 | Quitar a un miembro libera sus asignaciones: el servicio pone en null su responsable (desde la segunda revisión, el repositorio, en la misma llamada que lo quita). Si vuelve, no las recupera. Tras la revisión final (hecho): pasarlo a `viewer`, que no puede marcar acciones (D11), también las libera, y recuperar el rol no se las devuelve | **[mía]** |
| D16 | Marcar una acción no cambia el score: el plan es seguimiento. El texto lo dice ("A new analysis updates the score") | **[mía]** |
| D17 | "Create action" desde una alerta de muestra abre el formulario de acción propia con el texto sugerido. La persona la confirma y se guarda real | **[mía]** |

## 3. Objetivos, no objetivos y antiobjetivos

**Objetivos.** Lo siguiente, más los cambios de DN-10 que trae (§9):

- permisos 0.4.0;
- vistas por rol;
- plan de acción, actividad y renombrar, reales;
- panel de ARCA completo;
- herramientas mock para la demo.

**No objetivos**

- Broker, leads, enlaces compartidos, el formulario de `/partners` y PDF con marca.
- Persistir alertas, documentos, notificaciones o el perfil de la firma.
- Cambiar la Capa 1 o la Capa 2.

**Antiobjetivos**

- Un botón oculto cuya acción el back permita: el que niega es el back.
- Cualquier forma de actuar en nombre de otro.
- Herramientas de debug en un build de producción. El chequeo de fugas debe poder detectarlas (§6.4).
- Romper el claim, el pago, las invitaciones, el borrado o el cambio de organización de DN-10.

## 4. Back

### 4.1 Permisos 0.4.0

| Permiso | owner | admin | member | viewer |
|---|---|---|---|---|
| `org.read`: panel, análisis, plan, miembros | ✓ | ✓ | ✓ | ✓ |
| `org.update` (nuevo): renombrar; acciones comerciales y de cobertura en el front | ✓ | ✓ | — | — |
| `analysis.create`: guardar un análisis en la organización | ✓ | ✓ | — (D2) | — |
| `actions.update` (nuevo): cambiar el estado | ✓ | ✓ | ✓ | — |
| `actions.assign` (nuevo): responsable, fecha, crear y borrar acciones propias | ✓ | ✓ | — | — |
| `activity.read` (nuevo): actividad de la organización | ✓ | ✓ | — | — |
| `members.invite` / `members.remove` / `members.set_role` | ✓ | ✓ (sin tocar owners ni dar `owner`) | — | — |
| `billing.manage` | ✓ | — | — | — |
| `org.transfer_ownership` | ✓ | — | — | — |
| `org.request_deletion` | ✓ | — | — | — |

`can()` y `canManageMember()` no cambian de forma. Hay una sola tabla, en
`packages/contracts/src/webapp.ts`.

### 4.2 Plan de acción

**Plan vigente.**

- **Acciones del assessment:** salen del análisis de la organización con assessment completado y
  `claimed_at` más reciente. Se resuelve en vivo con `assessments.getByScan(scan_id)` y estado
  `COMPLETED`, porque `org_analyses.assessment_id` se fija al reclamar y puede quedar viejo. Si dos
  análisis empatan, desempata `scan_id`.
- **Sin análisis con assessment:** `source` es null y solo se listan las acciones propias.
- **Acciones propias:** se listan siempre.

**Claves públicas.**

- Del assessment: `a.<scanId>.<actionKey>`, donde `actionKey` es `ActionItem.id`. El `scanId` cumple
  `^sc_[a-zA-Z0-9]+$`; el `actionKey` puede llevar `.` y `:`, por ejemplo `improve:D1.1`.
- Propias: `c.<uuid>`.
- **Cómo se separa:** por los dos primeros puntos. El front codifica la clave con `encodeURIComponent`
  en la ruta.

**Validación de la clave** (sin esto hay IDOR):

- Una clave `a.` vale solo si su `scanId` es el del plan vigente de **esta** organización y el
  `actionKey` está en su `actionPlan`. Así una clave de un plan viejo da 404 (D14).
- Una clave `c.` vale solo si existe con `org_id` igual a la organización de la ruta.
- Cualquier otra cosa da 404, sin crear filas ni escribir en la auditoría.

**Registro (`org_actions`).**

- `id` (uuid), `org_id`, `source` (`assessment` | `custom`)
- `scan_id` y `action_key`, solo en las del assessment
- `title` (1–200), `detail` (≤2000) y `domain` (`DomainKey` o null), solo en las propias
- `status` (`todo` | `in_progress` | `done`)
- `assignee_user_id` y `due_date` (fecha)
- `created_by`, `created_at`, `updated_by` y `updated_at`

La fila de una acción del assessment se crea la primera vez que algo cambia. Hasta entonces se lee
con `todo`, sin responsable y sin fecha. Como máximo hay 100 acciones propias por organización; la
101 da 409.

**Tras la revisión final (hecho):** el tope lo hace cumplir el repositorio al insertar.
`createCustomAction` cuenta e inserta en un solo paso y da `WebappConflict('action_limit')`, que el
servicio traduce al mismo 409, así dos altas a la vez con 99 no pasan las dos. Un repositorio SQL
bloquea la fila de la organización (`select ... for update`) y cuenta e inserta en esa misma
transacción. El conteo previo del servicio queda solo como respuesta temprana, que no gasta escritura.

**`PATCH /orgs/:id/actions/:key`.** Recibe `{ status?, assigneeUserId?, dueDate? }`. Las dos últimas
aceptan null, que significa borrar. El orden es fijo:

1. Valida el body; si no hay ningún campo, 400.
2. Decide el permiso por los campos **presentes**. Si llega `assigneeUserId` o `dueDate` (aunque sea
   null), es `actions.assign`; si no, `actions.update`. Es todo o nada: no hay aplicación parcial.
3. Llama una sola vez a `authorize(permiso, { payment: true })`, que conserva el orden
   404/410/403/402.
4. Valida la clave; si no es válida, 404.
5. Valida el responsable. Debe ser miembro actual con `actions.update` (D11); si no, 400 con el mismo
   mensaje exista o no el usuario.
6. Si nada cambió, devuelve la vista sin escribir ni auditar.
7. Si cambió algo, escribe y audita `action.updated` con la clave y los valores antes y después.

Responde la `ActionItemView` actualizada.

**Tras la revisión final (hecho):** se escriben solo los campos enviados que difieren de lo leído.
En una fila que ya existe, de antes o creada por otra petición a la vez, el upsert cambia solo esas
columnas, así dos cambios simultáneos a campos distintos se conservan los dos. La auditoría guarda
solo esos campos: el antes según lo leído y el después según la fila que devuelve la escritura, que
es también la respuesta.

**Tras la segunda revisión (hecho):**

- **El responsable se comprueba en la escritura.** El paso 5 queda como respuesta temprana. La
  escritura (`updateAction`, `upsertAssessmentAction` y también `createCustomAction`) vuelve a mirar
  el rol actual del responsable y rechaza a quien no es owner, admin ni member con
  `IneligibleAssignee`, que el servicio traduce al mismo 400. En SQL va en la misma transacción, con
  `select role from memberships ... for share` antes de escribir.
- **La liberación va en la misma llamada que el cambio de rol.** `setRole` a un rol que no marca
  acciones (`viewer`) y `removeMember` ponen en null las asignaciones de esa persona en esa misma
  llamada al repositorio, no en una aparte. En SQL es una transacción con `for update` sobre la fila
  de la membresía. Las dos cerraduras chocan, así que una asignación y un cambio de rol a la vez
  nunca dejan una acción en manos de un `viewer` ni de un ex miembro (D11, D15). La fila de auditoría
  se escribe después, como en los demás cambios.
- **Una acción que desaparece da 404.** Si otra petición borró una acción propia entre la lectura y
  la escritura, `updateAction` devuelve null y `deleteCustomAction` false. El `PATCH`, o el segundo
  de dos `DELETE`, responde 404 y no audita nada.
- **Sin cambios, una lectura nueva.** El paso 6 responde con la acción leída otra vez, tal como está
  ahora, y no con lo leído antes, que puede haber cambiado. Sigue sin escribir ni auditar.

**Otras rutas.**

- `POST /orgs/:id/actions` (`actions.assign` + pago) crea una acción propia y responde 201 con su
  vista.
- `DELETE /orgs/:id/actions/:key` (`actions.assign` + pago) solo acepta claves `c.` (D13). Una clave
  `a.` da 400. Audita `action.deleted`.
- **Tope de escritura:** como máximo 60 escrituras de acciones por usuario y minuto. Por encima
  responde 429 `rate_limited`, un código nuevo en el servicio.
- **Quitar un miembro** pone en null sus asignaciones en esa organización (D15). Tras la revisión
  final (hecho), pasarlo a `viewer` también. Tras la segunda revisión (hecho), en la misma llamada
  al repositorio que el cambio (arriba). Tras la tercera revisión (hecho), si otra petición ya lo
  quitó, el cambio de rol o la segunda baja responde 404 y no audita, como una acción que desaparece.

### 4.3 Actividad

`audit_log` gana dos columnas en la migración de esta nota:

- `seq`, `bigint generated always as identity`, que da un orden estricto;
- `actor_kind` (`member` | `platform` | `system`), que el servicio fija al escribir. Es `platform` si
  actuó un admin de ARCA desde `/admin/*`, y `system` si fue un evento de cobro o la semilla.

El repositorio en memoria imita `seq` con un contador. El orden siempre es `created_at desc, seq desc`.

**`GET /orgs/:id/activity?before=&limit=`.** Pide `activity.read` y no exige pago (D5).

- **Paginación:** `before` es un `seq`. `limit` va de 1 a 200; por defecto 50; fuera de rango, 400.
- **Respuesta:** `{ events, nextBefore }`.

Cada evento expone:

- **actor:** `{ kind: 'member' | 'arca' | 'system', email }`. El email aparece solo si el actor es un
  miembro, aunque ya no pertenezca a la organización. Nunca se expone el email del personal de ARCA.
- **action:** la acción tal cual.
- **targetLabel:** el back traduce el destino a algo legible. Un id de usuario pasa a su email, un
  scan a su dominio, una clave de acción a su título, una organización a su nombre y un plan a su
  código. Lo que no se pueda traducir queda en null.
- **change:** `{ from, to }` o null. Sale de una lista permitida de campos del `data`: rol, estado de
  acción, nombre y fecha. El `data` crudo nunca sale.

**Tras la revisión final (hecho):**

- Las acciones que solo hacen el personal de ARCA (`org.deletion_approved`, `org.deletion_rejected`
  y `plan.updated`) o el sistema (`billing.event_applied`) se muestran con ese tipo de actor, sea
  cual sea el que guarda la fila. Así una fila mal escrita nunca expone el email del personal. La
  auditoría de ARCA (§4.5) usa la misma regla.
- La fila de `before` se busca solo dentro del mismo filtro: un `seq` de otra organización da una
  página vacía, no una posición en su registro.

### 4.4 Renombrar la organización

`PATCH /orgs/:id { name }` usa la misma regla de nombre que `CreateOrgRequest`, exige `org.update` y
no exige pago. Audita `org.renamed` con el nombre de antes y el de después.

### 4.5 Panel de ARCA

Solo para `platform_admins`. `requirePlatformAdmin` llama a `ensureProfile`, así el email del personal
de ARCA queda en su perfil y aparece en la auditoría de ARCA.

- `GET /admin/organizations/:id`: id, nombre, dominio, estado de cobro, si está borrada, fecha de
  creación, plan de la suscripción, número de análisis, solicitud de borrado pendiente y miembros
  (email, rol, alta).
- `GET /admin/audit?orgId=&before=&limit=`: el orden de la §4.3. `limit` va de 1 a 500, por defecto
  100. Cada evento lleva `orgName` (null en eventos sin organización), `actorKind`, `actorEmail`,
  `action` y `targetLabel`. Un `orgId` desconocido devuelve una lista vacía.
- **Tras la revisión final (hecho):** un `orgId` que no es UUID da la lista vacía, y un `:id` que no
  es UUID da 404 en el detalle, los dos sin consultar el repositorio: una columna uuid rechazaría el
  valor con un error en vez de no encontrarlo. Un UUID vale en mayúsculas o en minúsculas, como lo
  lee Postgres.
- `GET /admin/metrics`, solo conteos:
  - organizaciones por estado de cobro, con las borradas aparte;
  - miembros;
  - análisis;
  - solicitudes de borrado pendientes;
  - acciones por estado, contadas sobre el plan vigente de cada organización no borrada (acciones del
    assessment con sus valores por defecto más las propias).

### 4.6 Herramientas mock

**`POST /__debug/seed`.**

- **Dónde existe:** solo en mock, con `X-Arca-Debug: 1`, dentro de la sección webapp de las
  herramientas de debug, como `/auth/login`. Fuera de mock es 404 (no existe); **nunca** entra en
  `WEBAPP_PATHS`. Las piezas que necesita le llegan solo por las dependencias mock de la webapp.
  **Tras la revisión final (hecho):** `createApp` construye el ejecutor del scan de la semilla, que
  salta el limitador, y se lo pasa con su `AssessmentService` a las rutas de debug solo cuando las
  herramientas traen las piezas mock de la webapp (`DebugTools.seeds`, verdadero solo en mock). En
  live-debug no se construye, y `routes()` rechaza una pieza sin la otra.
- **Usa el flujo real**, sin resultados escritos a mano y sin pasar por el limitador de scans:
  1. Escanea `robust.arca.example` con el pipeline mock, como `owner@demo.arca.example`, y espera a
     que termine.
  2. Hace el assessment con el `AssessmentService`: espera a `READY`, responde y lo completa.
  3. Reclama el análisis y crea la organización "Robust Law (demo)".
  4. La paga con el evento de cobro simulado.
  5. Agrega `admin@`, `member@` y `viewer@demo.arca.example` con su rol.
  6. Hace a `ops@demo.arca.example` admin de plataforma.

  **Tras la revisión final (hecho):** antes del paso 1 comprueba que hay un plan activo y obtiene
  las identidades de los usuarios. Lo que puede fallar sin escribir falla antes de crear la
  organización, así un fallo no deja una organización sin pagar, ni una más en cada reintento.
- **Respuestas del assessment:** una política determinista, portada del Auto-answer del front, que
  deja **al menos 3** acciones en el plan. Si no se cumple, la semilla falla.
- **Tiempo:** espera como máximo 60 s; si se pasa, responde 504.
- **Identidad:** la organización sembrada se recuerda en las herramientas de debug. Volver a pedir la
  semilla la devuelve tal cual, con nombre o roles cambiados durante la demo. Se crea una nueva solo
  si no hay, si se borró o tras un `/reset`. Dos pedidos a la vez se resuelven en uno solo.
- **Respuesta (`DebugSeedResponse`, en `debug.ts`):** el id y el nombre de la organización, y los
  usuarios con su email y su rol (`owner` | `admin` | `member` | `viewer` | `platform_admin`). Nunca
  tokens.

### 4.7 Migración

`supabase/migrations/<fecha>_role_views.sql` hace dos cosas:

1. Crea `org_actions`:
   - FK de `org_id` a `organizations`.
   - Las del assessment llevan FK compuesta (`org_id`, `scan_id`) a `org_analyses`, que necesita su
     índice único compuesto.
   - Checks de `source` con sus columnas, de `status` y de los largos.
   - Índice único parcial por (`org_id`, `scan_id`, `action_key`) para las del assessment.
   - Sin FK en `assignee_user_id`, como el resto de usuarios en DN-10.
2. Agrega a `audit_log` las columnas `seq` y `actor_kind`, y un índice por (`org_id`, `seq`).

En RLS se copia DN-10 exactamente: RLS activado, sin políticas, `revoke` a `public`, `anon` y
`authenticated`, y permisos solo para `service_role`. `org_actions` se suma a la lista de tablas de
`webapp-database.test.ts`.

**Tras la revisión final (hecho):**

- **Índices.** Siguen el orden de lectura (§4.3). (`org_id`, `created_at desc`, `seq desc`) sirve a
  la actividad de una organización y reemplaza al (`org_id`, `seq`) de arriba y al (`org_id`,
  `created_at`) de DN-10, que cubre. (`created_at desc`, `seq desc`) sirve a `/admin/audit`. `seq`
  sigue siendo único, y por él se busca el cursor.
- **Filas ya escritas.** Las de DN-10 se corrigen: `platform` para `org.deletion_approved`,
  `org.deletion_rejected` y `plan.updated`, y `system` para `billing.event_applied`. El trigger
  append-only se desactiva solo para esa sentencia y se vuelve a activar enseguida.
- **Sin default.** Después se quita el default `member` de `actor_kind`: una escritura sin tipo de
  actor falla en vez de pasar por la de un miembro. En el repositorio, `actor_kind` es obligatorio.
- **Secuencia.** La de la identidad, `audit_log_seq_seq`, se revoca a `public`, `anon`,
  `authenticated` y `service_role`: insertar no necesita ningún permiso sobre ella. La prueba en
  PGlite corre con los privilegios por defecto que Supabase da a las secuencias nuevas, y comprueba
  que no hay políticas.

**Tras la segunda revisión (hecho):** el `audit()` del servicio tampoco tiene default. Cada llamada
nombra el tipo de actor, así una acción nueva del personal de ARCA que lo olvide no pasa el
typecheck. `ACTOR_KIND_OF_ACTION` y la tabla de destinos de la §4.3 se consultan solo por claves
propias (`Object.hasOwn`): una acción que se llame como una propiedad de todo objeto
(`constructor`) no encuentra entrada y queda como la de un miembro.

### 4.8 Repositorio

Métodos nuevos (en la interfaz y en memoria):

- `updateOrganizationName`;
- `listActions(orgId)`, `getCustomAction(orgId, id)`, `getAssessmentAction(orgId, scanId, actionKey)`;
- `upsertAssessmentAction` (único por la terna);
- `createCustomAction`, `countCustomActions(orgId)`, `updateAction`, `deleteCustomAction`;
- `clearAssignee(orgId, userId)`;
- `listAudit(orgId, { before, limit })`, que reemplaza la firma actual;
- `listAllAudit({ orgId?, before, limit })`.

`clear()` borra también las acciones.

**Tras la segunda revisión (hecho):** `clearAssignee` desaparece, porque la liberación va dentro de
`setRole` y `removeMember` (§4.2). `updateAction` devuelve la fila o null, y `deleteCustomAction`
un booleano. La interfaz dice qué transacción y qué cerraduras necesita un repositorio SQL. Tras la
tercera revisión (hecho), `setRole` y `removeMember` también devuelven un booleano: false si la
membresía ya no existe.

### 4.9 Rutas nuevas

| Método y ruta | Permiso y pago |
|---|---|
| `PATCH /orgs/:id` | `org.update`, sin pago |
| `GET /orgs/:id/actions` | `org.read` + pago |
| `POST /orgs/:id/actions` | `actions.assign` + pago |
| `PATCH /orgs/:id/actions/:key` | según la §4.2 + pago |
| `DELETE /orgs/:id/actions/:key` | `actions.assign` + pago |
| `GET /orgs/:id/activity` | `activity.read`, sin pago |
| `GET /admin/organizations/:id`, `GET /admin/audit`, `GET /admin/metrics` | admin de plataforma |
| `POST /__debug/seed` | solo mock (§4.6) |

Las rutas de la webapp ya caen bajo `/orgs/*` y `/admin/*` de `WEBAPP_PATHS`, así que fuera de mock
responden 501. `PATCH /orgs/:id` y la actividad se suman a las rutas exentas de pago de DN-10 §4.5 y
a su prueba en tabla.

## 5. Contratos 0.4.0

En `packages/contracts/src/webapp.ts`, con zod estricto. `DomainKey` sale de `layer2.ts`.

- **Permisos:** `PERMISSIONS` y `ROLE_PERMISSIONS` según la §4.1.
- **`ActionItemView`:**
  - `key`, `source`;
  - `title`, `detail` (o null), `domain` (`DomainKey` o null);
  - `pointsGain` (número, o null en las propias);
  - `status`;
  - `assignee` (`{ userId, email }` o null);
  - `dueDate` (`YYYY-MM-DD` o null);
  - `updatedAt` (o null).
- **`ActionPlanResponse`:** `{ source: { scanId, domain, claimedAt } | null, items }`. No incluye el
  análisis entero, así no repite la decisión.
- **`UpdateActionRequest`:** `{ status?, assigneeUserId?: string | null, dueDate?: string | null }`,
  con al menos un campo distinto de `undefined`.
- **`CreateActionRequest`:** `{ title, detail?, domain? }`.
- **`UpdateOrgRequest`:** `{ name }`.
- **`ActivityEventView`:** `{ id, at, actor: { kind, email }, action, targetLabel, change }`.
- **`ActivityPage`:** `{ events, nextBefore }`.
- **Vistas de admin:** `AdminOrgDetailView`, `AdminAuditEventView` (más su página) y
  `AdminMetricsView`, según la §4.5.
- **`DebugSeedResponse`:** en `debug.ts`.

**Tras la revisión final (hecho):**

- `UpdateActionRequest.assigneeUserId` es un UUID de cualquier versión, o null. Se acepta en
  cualquier caso y se pasa a minúsculas, como lo escribe Postgres. Uno mal formado da 400 con el
  cuerpo, antes del permiso, y nunca llega a una columna uuid.
- `CreateActionRequest.detail` acepta null, y un detalle vacío una vez recortado se lee como null.
  El servicio guarda null y el plan nunca muestra un detalle vacío.
- `AdminAuditEventView` rechaza un email en un actor `system`, como la actividad. Las filas de un
  miembro y del personal de ARCA pueden llevarlo (§4.5).
- `DOMAIN_LABELS` se exporta junto a `DomainKey`, en `layer2.ts`: una sola fuente para el nombre de
  cada dominio, en el banco de demo y en la webapp. También se exporta el esquema `ActivityActor`.

**Tras la segunda revisión (hecho):** los ids de la ruta siguen la regla de los UUID de la §4.5. El
`:id` de `/orgs/:id/*`, el `:userId` de un miembro, el `:invitationId` y el `:id` de una solicitud
de borrado van a columnas uuid. Uno que no es UUID da el mismo 404 que uno desconocido, sin
consultar el repositorio, y después de los controles que ya iban antes: el orden 404/410/403/402
de la organización, y el 403 de quien no es admin de plataforma en las solicitudes de borrado. Se
aceptan en cualquier caso, y lo que sigue usa el id guardado. El `orgId` de un evento de cobro sigue
la misma regla (`unknown_org`). El `scanId` de una clave `a.` no es un UUID (es texto `sc_...` en la
base) y ya se valida con su patrón; el `:code` de un plan y los tokens tampoco van a columnas uuid.

**Orden de publicación.**

1. Se fusiona el PR del back.
2. Se crea el tag `contracts-v0.4.0`.
3. El PR del front cambia la URL de la dependencia.

Mientras tanto, el front trabaja con `npm install ../Arca-back/packages/contracts --no-save`. Su PR
no se abre para revisar la vista previa hasta que la release exista.

## 6. Front

### 6.1 Acceso

`lib/app/access.ts` es **el único archivo** con las reglas de vista. Exporta:

- `canOpen(role, pathname)`: si un rol abre una pantalla.
- `navItems(role)`: los ítems de la barra lateral. La búsqueda de la barra superior usa la misma
  lista.
- `useCan(permission, { target?, nextRole? })`: combina `can()` y `canManageMember()` del contrato con
  el interruptor.
- La variante del Overview para cada rol.

Todas ceden ante el interruptor. Las comparaciones literales del modo que hoy están en las páginas
(DN-10 §5) desaparecen: ahora todo pasa por `useCan`.

Una pantalla que el rol no abre muestra "Your role can't open this page". El chequeo lo hace el
layout, por `pathname`, y también cede ante el interruptor. **Solo la actividad la niega además el
back**; las demás pantallas ocultas son decisión del front.

Una pantalla en solo lectura quita los controles y explica, una sola vez arriba, quién puede hacer el
cambio: "Only the owner can manage billing", "Ask an owner or admin to change this".

### 6.2 Qué ve cada rol

| Pantalla | owner | admin | member | viewer |
|---|---|---|---|---|
| Overview | §6.3 | §6.3 | §6.3 | §6.3 |
| Analyses (lista y detalle) | ver + "Run a new analysis" | ver + "Run a new analysis" | ver | ver |
| Action plan | todo | todo | cambiar estado | solo lectura |
| Monitoring (muestra) | todo | todo | marcar leído | marcar leído |
| Coverage (muestra) | todos los botones | todos los botones | solo lectura | solo lectura |
| Documents | descargar + subir evidencia | descargar + subir evidencia | descargar | descargar |
| Members | gestiona | gestiona (sin owners) | solo lectura | solo lectura |
| Billing (D10) | gestiona | solo lectura | solo lectura, fuera de la barra | solo lectura, fuera de la barra |
| Settings | todo | todo menos borrado y transferencia | personal; general en lectura | personal; general en lectura |
| Activity | ✓ | ✓ | no la abre | no la abre |
| Help | ✓ | ✓ | ✓ | ✓ |
| `/app/admin` | solo admin de plataforma | | | |

En los controles:

- Todo enlace a `/quote` sigue `analysis.create`.
- En Monitoring, "Create action" y "Dismiss" siguen `actions.assign`. "Mark as read" es personal.
- En Coverage, todos los botones (cotización, broker e incidente) siguen `org.update`.
- En Documents, subir evidencia sigue `org.update`.
- En Billing, las facturas de muestra solo las ven owner y admin.
- En Settings, Notifications y Security son personales y los ven todos.

### 6.3 Overview por rol

Lo que ven **todos**:

- el último análisis;
- la tendencia del score y el benchmark, de muestra;
- el monitoreo.

Por rol, tarjeta por tarjeta:

| Rol | Indicadores | Acciones rápidas | "Next actions" |
|---|---|---|---|
| owner | acciones abiertas, alertas, miembros, cobertura | todas | casillas |
| admin | acciones abiertas, alertas, miembros, cobertura | todas | casillas |
| member | "My open actions", alertas, cobertura | "Book a call" y Help | sus acciones primero, con casillas |
| viewer | acciones abiertas, cobertura | "Book a call" | lista sin casillas |

Las tarjetas de cobro no existen en Overview. El texto de pago recibido de DN-10 se conserva.

### 6.4 Datos reales y herramientas de debug

**`ActionsProvider`.**

- Vive en el layout, dentro de `AppContext` y con el mismo `key` por organización.
- Pide el plan solo si `org.paidAccess`. Un 402 o un 403 no redirigen desde el proveedor: el contador
  simplemente no aparece.
- Expone `refresh()`.
- Es la única fuente de la barra lateral, el Overview, la búsqueda y Monitoring ("ya en el plan").
- Los eventos `action.*` salen de `SampleState`; las alertas siguen de muestra.

**Action plan.**

- Conectado a la API: listar, cambiar, crear y borrar las acciones propias.
- Textos según D16.
- `AnalysisCard` conserva su lista estática del plan, que las pruebas de DN-10 nombran
  "Action plan". En el análisis vigente agrega un enlace "Track these in the Action plan".
- La pestaña del detalle dice "Recommended at the time of this analysis".

**Activity.** Real: los textos de cada `action` viven en un solo mapa del front. Los filtros que
quedan son por persona y por tipo de evento, más "Load more" con `nextBefore`.

**Settings.** Renombrar es real (`org.update`).

**"Save your results"** sigue mirando **solo la organización activa**, como hoy (DN-10 §4.7). Si el
rol activo no tiene `analysis.create`, ofrece crear una organización nueva. Se agregan casos de
prueba para `member` y `viewer`.

**`/app/admin`.**

- Tiene pestañas con estado local.
- La pestaña por defecto, "Operations", muestra **lo que hoy existe tal cual**: precios, cola de
  borrados y el encabezado "Platform admin (proof of concept)". Así las pruebas y el smoke de DN-10 no
  cambian.
- Las otras pestañas son Organizations (lista, con el detalle en la misma página), Audit (con
  filtro por organización y "Load more") y Metrics.
- La guarda `STAFF` sigue siendo una coincidencia exacta de ruta.

**Panel de debug.**

- Un bloque nuevo aparece en todo `pathname.startsWith("/app")`, separado de `SECTIONS`, **solo en
  mock**. En live-debug la webapp responde 501, así que no tiene efecto.
- Trae "Seed demo organization", botones etiquetados por rol ("Sign in as owner" y los demás, sin
  emails a la vista), "Sign in as ARCA admin" y el interruptor "Show forbidden actions".
- **Entrar como** hace `signOut()`, guarda la nueva sesión y navega a `/app` (o a `/app/admin`) con
  `window.location.assign`. Una navegación completa evita arrastrar el `/me` y el estado del usuario
  anterior.
- **Tras la revisión final (hecho):** cada "Sign in as" pide primero la semilla, que es idempotente
  (§4.6): devuelve la misma organización o la vuelve a crear tras un reset. Después entra con la
  cuenta nueva, y solo con esa sesión en mano cierra la del usuario anterior y guarda la nueva. Si el
  login falla, el usuario actual sigue dentro.

**Puente del interruptor.**

- `lib/debug/bridge.ts` suma `showForbidden()` y `subscribeShowForbidden()`. Las dos empiezan con la
  comparación literal del modo; en producción la primera devuelve siempre `false`.
- La clave `arca.debug.showForbidden` aparece **solo dentro de esas funciones**.
- El panel escribe la clave y emite un evento; las páginas se suscriben con `useSyncExternalStore`.
- `useCan` nunca toca `sessionStorage` por su cuenta.
- **Tras la revisión final (hecho):** el puente tiene una tercera función, `setShowForbidden()`, que
  también empieza con la comparación literal del modo. Escribe o borra la clave y emite el evento, y
  el panel escribe la clave solo a través de ella. Así la clave aparece solo en esas tres funciones
  del puente, y el panel nunca la escribe directamente.

**Guardas.**

- La frontera de ESLint suma las importaciones relativas desde carpetas anidadas (`../debug/*` salvo
  el puente) y su variante con `import()`. `scripts/lint-boundary.test.mjs` gana un caso para
  `lib/app/access.ts`.
- `check-no-debug.mjs` suma la marca de puente `arca.debug.showForbidden` y las marcas solo de debug
  `Show forbidden actions`, `Seed demo organization` y `demo.arca.example`, cada una con su prueba.
- Una prueba comprueba que, en producción, con la clave puesta en `sessionStorage`, nada oculto
  aparece.

## 7. Verificación

1. **Back.** `typecheck` y `npm test`; el back no tiene paso de lint.
   - Pruebas de servicio y rutas para cada regla de la §4.
   - Una **prueba en tabla de rol × ruta** que recorre cada ruta de la webapp con cada rol. En el
     `beforeAll`, el assessment se completa antes del claim, y la prueba lee una clave real de
     `GET /orgs/:id/actions` y crea una `c.` como owner. Comprueba el orden 404/410/403/402.
   - La matriz de permisos pasa a 12×4.
   - Casos de IDOR (claves de otra organización y del plan viejo), de no-op sin auditoría, del 429 y
     de la actividad sin el email del personal de ARCA.
   - La semilla: plan con 3 acciones o más, idempotencia y 404 fuera de mock (en las dos pruebas de
     404 de debug).
   - La migración en PGlite.
2. **Front.** `typecheck`, `lint`, `npm test` y `npm run build` con 0 fugas.
   - Pruebas por rol de navegación, pantallas y controles, con el interruptor apagado y encendido.
   - Plan de acción y actividad contra el cliente simulado.
   - Pruebas de fugas para las marcas nuevas.
   - **Pruebas que cambian a propósito:**
     - las que codifican DN-10 §5 (botones activos en debug);
     - las del plan de acción y el Overview de muestra;
     - las de SaveResultsCta para `member`.
3. **Smoke de navegador por rol** (`scripts/role-views-smoke.mjs`) contra el stack mock:
   - semilla;
   - entrar como cada rol y comprobar la barra lateral y los controles;
   - el member marca una acción y el owner la ve;
   - el viewer no puede marcarla;
   - con el interruptor, el viewer ve el control y el back responde 403;
   - el admin ve la actividad;
   - ARCA ve la organización, su auditoría y sus métricas.
4. **Smoke de DN-10** (`npm run test:browser:webapp`): en el punto 3, el contexto del member enciende
   el interruptor antes de ir a Billing y Members. El resto queda igual.
5. Revisión con varios agentes antes de cada PR.

## 8. Fuera o en otra nota

- **Broker** (D1).
- **Capa 1 y capa 2,** con sus DN (D8). Que el back deje de enviar la decisión a los miembros se
  decide allí.

## 9. Cambios que esta nota hace en DN-10 y en la spec de la UI

Se escriben en el mismo PR:

- **DN-10:**
  - §4.3: el `member` pierde `analysis.create` y hay cuatro permisos nuevos.
  - §4.5: `PATCH /orgs/:id` y la actividad se suman a las rutas exentas de pago.
  - §5: la regla de los botones activos la reemplaza D3.
  - §11 (punto 3): el member enciende el interruptor.
  - Una nota al inicio apunta a esta.
- **Spec de la UI (2026-10-29):**
  - el puente gana funciones nuevas;
  - el plan de acción y la actividad pasan a ser reales;
  - el estado compartido pasa a `ActionsProvider`;
  - la regla de los botones activos queda reemplazada.
