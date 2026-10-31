# Webapp privada (cuentas, organizaciones, roles y cobro): plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el embudo anónimo termine en una webapp privada de pago. Para la demo de mañana, todo funcionando y verificado en `mock`: registro después del assessment con reclamo del análisis, organizaciones con roles y permisos, bloqueo hasta pagar con pago simulado, solicitud de borrado con revisión humana, precio configurable, cimientos del panel de ARCA, y la migración SQL probada en PGlite.

**Architecture:**
- **Back.** Un módulo `apps/api/src/webapp/` con:
  - contrato de permisos en `@arca/contracts`;
  - repositorio en memoria;
  - servicio con todas las reglas;
  - proveedores enchufables de autenticación y cobro (mock ahora, Supabase/Stripe después);
  - rutas Hono.

  `compose` solo los construye en `mock`. En los demás modos, las rutas de la webapp responden 501 `not_configured`. El login y el pago simulados son rutas `/__debug/*` que solo existen en `mock`.
- **Front.** Rutas `/app/...` en Arca-front, como esqueleto sin diseño. El login y el pago simulados pasan por el puente de debug de DN-09, para que el build de producción siga sin código de debug.

**Tech Stack:**
- Back: Node 22, Hono 4.13, zod 3, jose, vitest 3, PGlite.
- Front: Next 16.2, React 19, Tailwind 4, vitest 5 con jsdom; Playwright (del back) para el smoke.

**Spec:** `Arca-back/docs/design-notes/DN-10-webapp-organizaciones-y-cobro.md` (manda en caso de duda), que se apoya en DN-09 (`DN-09-modos-mock-y-live-debug.md`).

## Global Constraints

- Repos: `C:\Users\jesus\projects\Arca-back` y `C:\Users\jesus\projects\Arca-front`, rama `feat/webapp-orgs` (ya creada desde `feat/arca-modes`). **Solo commits locales: nunca `push`, nunca deploy.** Rutas absolutas y `git -C`.
- Los `.env.local` tienen secretos reales: no se leen sus valores, no se imprimen, no se editan.
- Nada de esto puede llamar a Stripe ni a Supabase Auth reales: el alcance de mañana es `mock` (DN-10 §10).
- Las rutas `/__debug/auth/login` y `/__debug/billing/pay`:
  - existen **solo** con `ARCA_MODE=mock`;
  - exigen la cabecera `X-Arca-Debug: 1`;
  - en producción y en `live-debug` dan 404.
- Fuera de `mock` (por ahora), las rutas de la webapp dan **501** `{ error: 'not_configured' }`: `/me`, `/claims`, `/orgs`, `/orgs/*`, `/plans`, `/invitations/*`, `/admin/*`, `/billing/*`.
- CORS:
  - `allowHeaders` en producción sigue exactamente `Content-Type,Authorization`, porque el token del scan viaja en el cuerpo de `POST /claims`;
  - `allowMethods` añade `PATCH` y `DELETE`.
- Las reglas de DN-09 siguen vigentes en el front:
  - la frontera de ESLint;
  - las guardas literales `=== "mock"`;
  - `npm run build` con 0 fugas en producción;
  - fuera de `components/debug` y `lib/debug` solo se importan `DebugMount` y `lib/debug/bridge`.
- UI de la webapp:
  - es un esqueleto: textos en inglés, solo tokens de paleta (`marino`, `cielo`, `oro`, `bruma`, `rojo`, `white`), lucide-react, sin diseño;
  - nunca muestra tokens completos;
  - el contenido de terceros se pinta como texto.
- Precios de ejemplo, en el código y en la semilla SQL, siempre etiquetados "(example price)":
  - `monthly`: 49 900 céntimos, `usd`, `month`;
  - `annual`: 499 000 céntimos, `usd`, `year`.
- Errores JSON `{ error, message }` con estos códigos y estados:
  - `invalid_request` 400, `unauthorized` 401, `payment_required` 402, `forbidden` 403, `not_found` 404, `conflict` 409, `gone` 410, `not_configured` 501.
- Tests:
  - back: `npm run build && npm test` en la raíz de Arca-back (los tests leen `@arca/*` desde `dist`);
  - front: `npm test && npm run typecheck && npm run lint` (0 errores; los 6 avisos que ya existían) y `npm run build` sin modo, con 0 fugas.
- Estilo: el del código que rodea. Comentarios escasos que explican el porqué, en inglés, como el resto del código.

## Review Focus

1. **Aislamiento entre organizaciones.** Un usuario de la organización A pide recursos de la B por id. Se espera **404**, no 403, para no revelar que existe. Lo prueba la Task 4.
2. **El último owner.** Degradar o quitar al último owner, o que un admin toque a un owner o dé `owner`, se rechaza con 409 o 403. Siempre queda un owner. Lo prueban las Tasks 2 y 3.
3. **Reusar un reclamo.** El mismo `claimId` usado dos veces, un scan ya reclamado o un ticket de otro email dan **409** y **403**, y no se crea ninguna organización. Lo prueban las Tasks 3 y 4.
4. **Evento de cobro repetido.** Un pago simulado repetido no procesa nada dos veces, y un evento para una organización inexistente no rompe nada. Lo prueba la Task 3.
5. **Organización borrada o con borrado pendiente.** Borrada da **410** en todo, también en cobro. Con la solicitud pendiente se mantiene el acceso, y una segunda solicitud da 409. Lo prueba la Task 4.

---

### Task 1: Contrato de la webapp y matriz de permisos

**Files:**
- Create: `Arca-back/packages/contracts/src/webapp.ts`
- Modify: `Arca-back/packages/contracts/src/index.ts` (`export * from './webapp.js';`, porque el código de producción lo usa)
- Test: `Arca-back/packages/contracts/tests/webapp.test.ts`

**Interfaces (Produces):**
- `ROLES = ['owner','admin','member','viewer'] as const` y `type Role`.
- `PERMISSIONS = ['org.read','analysis.create','members.invite','members.remove','members.set_role','billing.manage','org.transfer_ownership','org.request_deletion'] as const` y `type Permission`.
- `ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>>`, exactamente la matriz de DN-10 §4.3:
  - owner: todos;
  - admin: `org.read`, `analysis.create`, `members.invite`, `members.remove`, `members.set_role`;
  - member: `org.read`, `analysis.create`;
  - viewer: `org.read`.
- `can(role: Role, permission: Permission): boolean`.
- `canManageMember(actor: Role, target: Role, nextRole?: Role): boolean`:
  - owner: siempre;
  - admin: solo si `target !== 'owner'` y `nextRole !== 'owner'`;
  - member y viewer: nunca.
- `BILLING_STATUSES = ['pending_payment','active','past_due','canceled'] as const` y `type BillingStatus`. `hasPaidAccess(status): boolean`, verdadero para `active` y `past_due`.
- Schemas zod `.strict()`, con su `type` del mismo nombre:
  - `PlanView { code, name, amountCents: int>=0, currency: /^[a-z]{3}$/, interval: 'month'|'year' }`
  - `OrgView { id, name, domain: string|null, billingStatus, role, deletionPending: boolean, paidAccess: boolean }`
  - `MeResponse { user: { id, email }, organizations: OrgView[], platformAdmin: boolean }`
  - `MemberView { userId, email, role, joinedAt }`
  - `InvitationView { id, email, role, expiresAt, inviteUrl: string.optional() }`. `role` es cualquier rol menos `owner`.
  - `AnalysisView { scanId, domain, scanStatus: 'COMPLETED'|'PARTIAL', claimedAt, layer1: Layer1Result, assessment: AssessmentResult|null }`
  - `ClaimResponse { claimId, email, expiresAt }`
  - `UrlResponse { url }`
  - `DeletionRequestView { id, orgId, reason, status: 'pending'|'approved'|'rejected', requestedAt, reviewedAt: string|null, reviewNote: string|null }`
  - `AdminOrgView { id, name, billingStatus, deleted: boolean, members: int }`
  - Peticiones:
    - `CreateClaimRequest { scanToken: string.min(1) }`
    - `CreateOrgRequest { name: 1..120, claimId }`
    - `AttachAnalysisRequest { claimId }`
    - `InviteRequest { email: email(), role }` (sin `owner`)
    - `SetRoleRequest { role }`
    - `DeletionRequestBody { reason: 1..2000 }`
    - `CheckoutRequest { planCode }`
    - `ReviewRequest { note: string.max(2000).optional() }`
    - `UpdatePlanRequest { name?, amountCents?, currency?, interval?, active? }`, que exige al menos una clave.

- [ ] **Step 1: Write the failing tests** (`webapp.test.ts`):
  - `the matrix is exactly DN-10 §4.3`: `it.each` sobre las 32 combinaciones rol × permiso, con la tabla esperada escrita literal en el test.
  - `admins cannot touch owners or grant ownership`:
    - `canManageMember('admin','owner')`, `('admin','member','owner')`, `('member','viewer','viewer')` y `('viewer','viewer')` son false;
    - `('owner','owner','member')` y `('admin','member','viewer')` son true.
  - `paid access`: true solo para `active` y `past_due`.
  - `invitations cannot grant ownership`: `InviteRequest.safeParse({ email:'a@b.co', role:'owner' }).success === false`.
  - `schemas are strict`: `OrgView` con una clave extra no valida.
  - `UpdatePlanRequest needs a change`: `{}` no valida.
- [ ] **Step 2: Run** `npm run build && npx vitest run packages/contracts/tests/webapp.test.ts`. Expected: FAIL (el módulo no existe).
- [ ] **Step 3: Implement** `webapp.ts` y el export.
- [ ] **Step 4: Run** el mismo comando. Expected: PASS. Después, la suite completa: `npm run build && npm test` → todo en verde.
- [ ] **Step 5: Commit** — `"Add the webapp contract and the role permission matrix"`

---

### Task 2: Modelo de la webapp y repositorio en memoria

**Files:**
- Create:
  - `Arca-back/apps/api/src/webapp/types.ts`
  - `Arca-back/apps/api/src/webapp/in-memory.ts`
  - `Arca-back/apps/api/src/webapp/plans.ts`
- Test: `Arca-back/apps/api/tests/unit/webapp-repository.test.ts`

**Interfaces:**
- Consumes: `Role` y `BillingStatus` (Task 1).
- Produces, en `types.ts`, registros en snake_case como los de `repositories/types.ts`:
  - `ProfileRecord { user_id, email, full_name: string|null, last_org_id: string|null, created_at }`
  - `OrganizationRecord { id, name, domain: string|null, billing_status: BillingStatus, deleted_at: string|null, created_by, created_at }`
  - `MembershipRecord { org_id, user_id, role: Role, invited_by: string|null, created_at }`
  - `InvitationRecord { id, org_id, email, role: Exclude<Role,'owner'>, token_hash, invited_by, expires_at, accepted_at: string|null, revoked_at: string|null, created_at }`
  - `OrgAnalysisRecord { org_id, scan_id, assessment_id: string|null, claimed_by, claimed_at }`
  - `ClaimTicketRecord { id_hash, scan_id, email, expires_at, used_at: string|null }`
  - `PlanRecord { code, name, amount_cents, currency, interval: 'month'|'year', active: boolean }`
  - `SubscriptionRecord { org_id, plan_code, customer_id: string|null, subscription_id: string|null, status: BillingStatus, current_period_end: string|null, updated_at }`
  - `DeletionRequestRecord { id, org_id, requested_by, reason, status: 'pending'|'approved'|'rejected', reviewed_by: string|null, reviewed_at: string|null, review_note: string|null, created_at }`
  - `AuditRecord { id, actor_user_id: string|null, org_id: string|null, action, target: string|null, data: Record<string,unknown>, created_at }`
- `class WebappConflict extends Error { constructor(readonly reason: 'scan_claimed'|'last_owner'|'already_member'|'deletion_pending') }`.
- `interface WebappRepository`, todo `async`:
  - Perfiles y organizaciones:
    - `upsertProfile(p: ProfileRecord)`, `getProfile(userId)`.
    - `createOrganization(org: OrganizationRecord, owner: MembershipRecord, analysis: OrgAnalysisRecord|null): Promise<void>`. Es atómica: si `analysis.scan_id` ya fue reclamado, lanza `WebappConflict('scan_claimed')` y no escribe nada.
    - `getOrganization(id)`, `listOrganizationsForUser(userId): Promise<Array<{ org: OrganizationRecord; role: Role }>>`, `listOrganizations()`.
  - Miembros:
    - `getMembership(orgId, userId)`, `listMembers(orgId)`.
    - `addMember(m)`: si ya es miembro, `WebappConflict('already_member')`.
    - `setRole(orgId, userId, role)` y `removeMember(orgId, userId)`: si dejan la organización sin owner, `WebappConflict('last_owner')`.
  - Invitaciones: `createInvitation(i)`, `findInvitationByHash(hash)`, `listInvitations(orgId)` (solo las pendientes), `updateInvitation(id, patch: Partial<Pick<InvitationRecord,'accepted_at'|'revoked_at'>>)`.
  - Análisis: `claimAnalysis(a)` (`scan_claimed` si se repite), `listAnalyses(orgId)`.
  - Tickets de reclamo: `createClaimTicket(t)`, `getClaimTicket(idHash)`, `markClaimTicketUsed(idHash, at): Promise<boolean>` (false si ya estaba usado).
  - Planes: `listPlans()`, `getPlan(code)`, `updatePlan(code, patch: Partial<Omit<PlanRecord,'code'>>)`.
  - Suscripciones: `getSubscription(orgId)`, `upsertSubscription(s)`, `setBillingStatus(orgId, status)`.
  - `recordBillingEvent(id, type): Promise<boolean>`: false si ya se había visto ese id.
  - Borrado:
    - `createDeletionRequest(r)`: `WebappConflict('deletion_pending')` si ya hay una pendiente.
    - `getPendingDeletionRequest(orgId)`, `listDeletionRequests()`, `getDeletionRequest(id)`.
    - `reviewDeletionRequest(id, status: 'approved'|'rejected', reviewedBy, note, at)`.
    - `markOrganizationDeleted(orgId, at)`.
  - Plataforma y auditoría: `isPlatformAdmin(userId)`, `grantPlatformAdmin(userId, grantedBy)`, `appendAudit(r)`, `listAudit(orgId)`.
- `class InMemoryWebappRepository implements WebappRepository { constructor(plans: PlanRecord[]); clear(): void }`:
  - devuelve copias (`structuredClone`), como `InMemoryRepository`;
  - `clear()` vacía todo y vuelve a sembrar los planes iniciales.
- `plans.ts`: `export const DEFAULT_PLANS: readonly PlanRecord[]` con los dos planes de ejemplo de las Global Constraints.

- [ ] **Step 1: Write the failing tests:**
  - `an organization is created with its owner and its claimed analysis, atomically`: crear con un `scan_id` ya reclamado lanza `WebappConflict('scan_claimed')`, y después `getOrganization(newId)` es null.
  - `the last owner can be neither demoted nor removed`: con un solo owner, `setRole(...,'admin')` y `removeMember` lanzan `last_owner`; con dos owners, sí se puede.
  - `a claim ticket is used once`: `markClaimTicketUsed` da true y luego false.
  - `billing events are recorded once`: `recordBillingEvent('evt_1','x')` da true y luego false.
  - `one pending deletion request per organization`.
  - `clear() empties everything and reseeds the plans`.
  - `returns copies`: mutar lo devuelto no cambia lo guardado.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/unit/webapp-repository.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** los tres archivos.
- [ ] **Step 4: Run** el mismo comando: PASS. Después, la suite completa.
- [ ] **Step 5: Commit** — `"Add the webapp records and the in-memory repository"`

---

### Task 3: Autenticación y cobro simulados, y el servicio con las reglas

**Files:**
- Create:
  - `Arca-back/apps/api/src/webapp/auth.ts`
  - `Arca-back/apps/api/src/webapp/billing.ts`
  - `Arca-back/apps/api/src/webapp/service.ts`
- Test:
  - `Arca-back/apps/api/tests/unit/webapp-auth-billing.test.ts`
  - `Arca-back/apps/api/tests/unit/webapp-service.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1 y 2;
  - `verifySessionToken` (`apps/api/src/auth/session-token.ts`);
  - `ScanRepository` (`repositories/types.ts`);
  - `AssessmentRepository` (`assessment/repository.ts`).
- Produces, en `auth.ts`:
  - `type AppUser = { userId: string; email: string }`;
  - `interface AppAuth { verify(token: string): Promise<AppUser | null> }`;
  - `class MockAppAuth implements AppAuth { constructor(secret: string, now?: () => number); issue(email: string): Promise<{ token: string; user: AppUser; expiresAt: string }> }`:
    - JWT HS256 con `jose`, `iss: 'arca-mock-auth'`, `aud: 'authenticated'`, `sub` = un UUID estable por email (derivado de sha256 del email en minúsculas), `email` en minúsculas y `exp` a 12 h;
    - `verify` exige ese algoritmo, emisor y audiencia.
- Produces, en `billing.ts`:
  - `type BillingEvent = { id: string; type: 'checkout.completed'|'subscription.updated'|'subscription.canceled'|'payment.failed'; orgId: string; status: BillingStatus; planCode: string|null; customerId: string|null; subscriptionId: string|null; currentPeriodEnd: string|null }`;
  - `interface BillingProvider { createCheckout(input: { orgId: string; plan: PlanRecord; successUrl: string; cancelUrl: string }): Promise<{ sessionId: string; url: string }>; createPortal(input: { orgId: string; returnUrl: string }): Promise<{ url: string }>; cancel(orgId: string): Promise<void> }`;
  - `class MockBillingProvider implements BillingProvider { constructor(appBaseUrl: string, now?: () => number); pay(sessionId: string): BillingEvent | null }`:
    - el checkout devuelve `${appBaseUrl}/app/billing/mock-checkout?session=<sessionId>`;
    - el portal devuelve `${appBaseUrl}/app/billing`;
    - `pay` devuelve un único `checkout.completed` activo, con `currentPeriodEnd` = ahora + 1 intervalo del plan; un segundo `pay` del mismo id devuelve null;
    - `cancel` se registra en `canceled: string[]`, para los tests.
- Produces, en `service.ts`:
  - `class WebappFailure extends Error { constructor(readonly code: 'invalid_request'|'unauthorized'|'payment_required'|'forbidden'|'not_found'|'conflict'|'gone', message: string, readonly status: 400|401|402|403|404|409|410) }`.
  - `class WebappService { constructor(deps: { repository: WebappRepository; scans: ScanRepository; assessments: AssessmentRepository; billing: BillingProvider; sessionSecret: string; appBaseUrl: string; isDurableScan?: (scanId: string) => boolean; now?: () => number }) }`, con estos métodos:
    - `authorize(user: AppUser, orgId: string, permission: Permission | null, opts: { payment: boolean }): Promise<{ org: OrganizationRecord; role: Role }>`. Comprueba en este orden:
      1. sin membresía → 404 `not_found`;
      2. `deleted_at` → 410 `gone`;
      3. falta el permiso → 403 `forbidden`;
      4. `opts.payment` y sin `hasPaidAccess` → 402 `payment_required`.
    - `requirePlatformAdmin(user)`: 403 si no lo es.
    - `issueClaim(scanToken): Promise<ClaimResponse>`:
      - token del scan válido y con el email del scan; si no, 401;
      - scan COMPLETED o PARTIAL; si no, 409;
      - `isDurableScan` no false; si no, 409;
      - aún no reclamado; si no, 409;
      - `claimId` = 32 bytes aleatorios en base64url; se guarda su sha256; expira en 24 h.
    - `me(user): Promise<MeResponse>`: hace upsert del perfil.
    - `createOrganization(user, req: CreateOrgRequest): Promise<OrgView>`:
      - ticket inexistente o caducado → 410 `gone`; ya usado → 409;
      - email distinto (sin distinguir mayúsculas) → 403;
      - `markClaimTicketUsed` solo después de crear la organización;
      - la organización nace `pending_payment`, con `domain` = dominio canónico del scan y `assessment_id` = `assessments.getByScan(scanId)?.id ?? null`;
      - audita `org.created`.
    - `attachAnalysis(user, orgId, claimId): Promise<AnalysisView>`: mismas validaciones del ticket.
    - `orgView(user, orgId): Promise<OrgView>`.
    - `listAnalyses(orgId): Promise<AnalysisView[]>`: lee el `result` del scan desde `scans.get`, sin pasar por la caducidad de 24 h, y el resultado del assessment si está COMPLETED.
    - `listMembers(orgId): Promise<{ members: MemberView[]; invitations: InvitationView[] }>`.
    - `invite(actor: AppUser, orgId, req: InviteRequest): Promise<InvitationView>`: token aleatorio y su hash; expira a los 7 días; `inviteUrl` = `${appBaseUrl}/app/invite/<token>`; audita `member.invited`.
    - `revokeInvitation(actor, orgId, invitationId)`.
    - `acceptInvitation(user, token): Promise<OrgView>`:
      - hash desconocido → 404;
      - aceptada, revocada o caducada → 410;
      - email distinto → 403;
      - si ya es miembro, idempotente: devuelve la vista;
      - audita `member.joined`.
    - `setRole(actor, orgId, targetUserId, role)` y `removeMember(actor, orgId, targetUserId)`:
      - `canManageMember(actorRole, targetRole, role)` o 403;
      - `last_owner` → 409;
      - auditan `member.role_changed` y `member.removed`.
    - `checkout(actor, orgId, planCode): Promise<{ url }>`:
      - plan inactivo o inexistente → 400;
      - `successUrl` = `${appBaseUrl}/app?paid=1` y `cancelUrl` = `${appBaseUrl}/app/billing`.
    - `portal(actor, orgId)`.
    - `applyBillingEvent(event: BillingEvent): Promise<'applied'|'duplicate'|'unknown_org'>`:
      - idempotente por `recordBillingEvent`;
      - actualiza la suscripción y `billing_status`;
      - nunca toca el borrado.
    - `requestDeletion(actor, orgId, reason): Promise<DeletionRequestView>`: 409 si ya hay una pendiente; audita `org.deletion_requested`.
    - Admin:
      - `listOrganizations()`, `listDeletionRequests()`;
      - `reviewDeletion(admin, id, decision: 'approve'|'reject', note?)`:
        - aprobar → `markOrganizationDeleted` + `billing.cancel`;
        - rechazar → solo cierra la solicitud;
        - ya revisada → 409;
        - audita;
      - `listAllPlans()`, `updatePlan(admin, code, patch)`: audita `plan.updated`.

- [ ] **Step 1: Write the failing tests.**

  `webapp-auth-billing.test.ts`:
  - `a mock token round-trips and is stable per email`: mismo `sub` para `A@x.co` y `a@x.co`.
  - `a token with another issuer, audience or algorithm is rejected`: verificar un token de sesión de scan (`issueSessionToken`) da null.
  - `an expired token is rejected` (reloj inyectado).
  - `a checkout is paid once`.

  `webapp-service.test.ts`, con escenas construidas sobre `InMemoryRepository` con un scan COMPLETED y su token, `InMemoryAssessmentRepository` y `MockBillingProvider`:
  - `the funnel claim creates an organization owned by the claimant` (estado `pending_payment`, con el análisis).
  - `a claim ticket works once`: la segunda vez da 409.
  - `a claim for another email is refused and creates nothing` (403; el usuario no tiene organizaciones).
  - `a failed or injected scan cannot be claimed` (409).
  - `a scan claimed twice through two tickets is refused` (409).
  - `access checks run in order`:
    - un ajeno → 404;
    - organización borrada → 410;
    - un viewer con `members.invite` → 403;
    - un owner sin pagar en una ruta de pago → 402.
  - `admins cannot touch owners, and the last owner stays`.
  - `an invitation is accepted once, by its own email`.
  - `a repeated billing event is applied once and an unknown organization is ignored`.
  - `a payment activates the organization and a cancellation keeps the deletion state untouched`.
  - `deletion is only requested`: estado intacto, una segunda solicitud da 409, aprobar la marca borrada y cancela el cobro, y rechazar no cambia nada más.
  - `a plan price change is what the next checkout charges`: tras `updatePlan('monthly', { amountCents: 1000 })`, el `plan` que recibe `createCheckout` lleva 1000.
  - `every change writes the audit log`.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/unit/webapp-auth-billing.test.ts apps/api/tests/unit/webapp-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** los tres archivos.
- [ ] **Step 4: Run** los mismos tests: PASS. Después, `npm run build && npm test`.
- [ ] **Step 5: Commit** — `"Add mock auth, mock billing and the webapp rules"`

---

### Task 4: Rutas HTTP, cableado y rutas de debug

**Files:**
- Create: `Arca-back/apps/api/src/webapp/routes.ts`
- Modify:
  - `Arca-back/apps/api/src/http/app.ts`: `AppDeps.webapp?: { service: WebappService; auth: AppAuth }`; si existe, monta `webappRoutes`; si no, `notConfiguredWebapp()` (501). `allowMethods` añade `PATCH` y `DELETE`;
  - `Arca-back/apps/api/src/debug/tools.ts`: opción `webapp?: { auth: MockAppAuth; billing: MockBillingProvider; service: WebappService; repository: InMemoryWebappRepository }`. Rutas `POST /auth/login` y `POST /billing/pay` **solo si la opción existe**. El reset en mock también vacía el repositorio de la webapp;
  - `Arca-back/apps/api/src/compose.ts`: solo en `mock` construye el repositorio con `DEFAULT_PLANS`, `MockAppAuth(env.SESSION_TOKEN_SECRET)`, `MockBillingProvider(env.APP_BASE_URL)` y `WebappService` (con `isDurableScan: id => !scans.isIsolated(id)`), y se los pasa a `createApp` y a `createDebugTools`;
  - `Arca-back/apps/api/src/config/env.ts`: `APP_BASE_URL: z.string().url().default('http://localhost:3000')`;
  - `Arca-back/.env.example`: una línea comentada para `APP_BASE_URL`.
- Test: `Arca-back/apps/api/tests/integration/webapp.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3; `compose`, `loadEnv` y `createDebugTools`, tal como están hoy.
- Produces `webappRoutes(deps: { service: WebappService; auth: AppAuth }): Hono` con estas rutas. Todas responden JSON con `Cache-Control: no-store`. Las que piden auth exigen `Authorization: Bearer <token de la app>` (sin él, 401). Los cuerpos se validan con los schemas de la Task 1 (inválido → 400 `invalid_request`).

| Ruta | Acceso | Respuesta |
|---|---|---|
| `GET /plans` | pública | `PlanView[]` (activos) |
| `POST /claims` | pública, `CreateClaimRequest` | 201 `ClaimResponse` |
| `GET /me` | auth | `MeResponse` |
| `POST /orgs` | auth, `CreateOrgRequest` | 201 `OrgView` |
| `GET /orgs/:id` | miembro (sin pago) | `OrgView` |
| `GET /orgs/:id/analyses` | `org.read` + pago | `AnalysisView[]` |
| `POST /orgs/:id/analyses` | `analysis.create` + pago | 201 `AnalysisView` |
| `GET /orgs/:id/members` | `org.read` + pago | `{ members, invitations }` |
| `POST /orgs/:id/invitations` | `members.invite` + pago | 201 `InvitationView` con `inviteUrl` |
| `DELETE /orgs/:id/invitations/:invitationId` | `members.invite` + pago | 204 |
| `PATCH /orgs/:id/members/:userId` | `members.set_role` + pago | `MemberView` |
| `DELETE /orgs/:id/members/:userId` | `members.remove` + pago | 204 |
| `POST /invitations/:token/accept` | auth | `OrgView` |
| `POST /orgs/:id/billing/checkout` | `billing.manage` (sin pago) | `UrlResponse` |
| `POST /orgs/:id/billing/portal` | `billing.manage` (sin pago) | `UrlResponse` |
| `POST /orgs/:id/deletion-request` | `org.request_deletion` (sin pago) | 201 `DeletionRequestView` |
| `GET /admin/organizations`, `GET /admin/deletion-requests`, `GET /admin/plans` | admin de plataforma | listas |
| `POST /admin/deletion-requests/:id/approve` y `/reject` | admin de plataforma, `ReviewRequest` | `DeletionRequestView` |
| `PUT /admin/plans/:code` | admin de plataforma, `UpdatePlanRequest` | `PlanView` |
| `POST /billing/webhook` | — | 501 `not_configured` también en mock (Stripe va después) |

- Debug, solo en mock, con `X-Arca-Debug: 1` (si falta, 400):
  - `POST /__debug/auth/login { email, platformAdmin?: boolean }` → `{ token, user, expiresAt }`; con `platformAdmin`, `grantPlatformAdmin`;
  - `POST /__debug/billing/pay { sessionId }` → aplica el evento con `service.applyBillingEvent` → `{ ok: true }`. Sesión desconocida o ya pagada: 409.

- [ ] **Step 1: Write the failing tests** (`webapp.test.ts`). App armada con `compose(loadEnv({ ARCA_MODE:'mock', SESSION_TOKEN_SECRET:'s'.repeat(40), CORS_ALLOWED_ORIGINS:'http://localhost:3000' }))`, scans reales de mock (`robust.arca.example`) y logins con `/__debug/auth/login`:
  - `the demo flow works end to end`:
    1. scan → assessment completado con respuestas válidas (reutiliza el patrón de `mock-offline.test.ts`) → `POST /claims` → login → `POST /orgs`;
    2. `GET /orgs/:id/analyses` da 402;
    3. checkout → `/__debug/billing/pay` → analyses da 200, con `layer1.preScore.total === 82` y `assessment` no null;
    4. invite member → login del invitado → accept → `GET /orgs/:id/analyses` como member da 200;
    5. el member hace checkout → 403, y `PATCH` de rol → 403;
    6. como admin de plataforma, `PUT /admin/plans/monthly { amountCents: 1000 }` → `GET /plans` lo refleja;
    7. `POST /deletion-request` → 201 → `GET /orgs/:id` da `deletionPending: true` y analyses sigue en 200.
  - `organizations are isolated`: el owner de A pide `/orgs/<idB>/...` y recibe 404 en cada ruta.
  - `a deleted organization answers 410 everywhere`, también en billing y deletion-request.
  - `routes refuse every role the matrix refuses`: `it.each` sobre (rol, ruta) con 403 esperado.
  - `without a token the app answers 401`, y con un token de sesión de scan también 401.
  - `production wiring`: con `compose(loadEnv({ SOURCE_MODE:'mock', STORAGE_BACKEND:'memory', ... }))`, sin `ARCA_MODE`:
    - `/me` → 501 `not_configured`;
    - `POST /__debug/auth/login` → 404;
    - el preflight en `/orgs` mantiene `Access-Control-Allow-Headers` exactamente `Content-Type,Authorization`.
  - `live-debug has no mock login`: con `createDebugTools` en modo `live-debug` sin `webapp`, `/__debug/auth/login` → 404.
- [ ] **Step 2: Run** `npm run build && npx vitest run apps/api/tests/integration/webapp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** las rutas y el cableado.
- [ ] **Step 4: Run** el mismo test: PASS. Después, `npm run build && npm test`: toda la suite en verde, incluidos los tests de DN-09 (`debug-mode`, `compose`, `mock-offline`).
- [ ] **Step 5: Commit** — `"Serve the webapp API in mock, with mock login and payment, and 501 elsewhere"`

---

### Task 5: Migración SQL probada en PGlite

**Files:**
- Create:
  - `Arca-back/supabase/migrations/20261025200000_webapp_organizations.sql`
  - `Arca-back/apps/api/tests/integration/webapp-database.test.ts`

**Interfaces:**
- Consumes: el modelo de la Task 2. Columnas en snake_case, mismos nombres.
- Produces las tablas de DN-10 §4.2, más `claim_tickets` y `platform_admins`:
  - **Claves:** `user_id`, `created_by`, etc. son `uuid` **sin** FK a `auth.users`. Ruling: así la migración se aplica en PGlite con el resto, y el back es el único que escribe (por eso usa la clave de servicio).
  - **Referencias:** `org_analyses.scan_id` es UNIQUE y referencia `public.scans(scan_id)`; `claim_tickets.scan_id` también referencia `scans`.
  - **Checks:**
    - roles;
    - `billing_status`;
    - `interval` en (`month`, `year`);
    - `amount_cents >= 0`;
    - `currency ~ '^[a-z]{3}$'`;
    - una invitación nunca es `owner`;
    - estado de las solicitudes de borrado.
  - **Únicos parciales:**
    - una invitación pendiente por `(org_id, lower(email))`;
    - una solicitud `pending` por organización.
  - **Último owner:** un trigger en `memberships` rechaza un UPDATE o DELETE que deje una organización sin owner.
  - **Auditoría:** `audit_log` solo admite añadir; UPDATE y DELETE se rechazan con un trigger, como `assessment_answer_events`.
  - **Semilla:** los dos planes de ejemplo de las Global Constraints.
  - **Permisos:** RLS activado en todas las tablas; `revoke all` a `public`, `anon` y `authenticated`; `grant select, insert, update, delete` a `service_role`, salvo `audit_log`, que solo recibe `select, insert`.

- [ ] **Step 1: Write the failing test** (`webapp-database.test.ts`). Mismo arranque que `assessment-database.test.ts`: crea los roles y aplica todas las migraciones en orden. Casos:
  - `applies on top of the existing schema` (y `assessment-database.test.ts` sigue verde);
  - `seeds the example plans`;
  - `keeps at least one owner`: degradar al único owner falla; con dos owners funciona;
  - `a scan is claimed once`;
  - `an invitation cannot grant ownership`;
  - `one pending deletion request per organization`;
  - `the audit log is append-only`;
  - `anon and authenticated cannot read the tables` (`set role anon; select …` falla).
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/integration/webapp-database.test.ts`. Expected: FAIL (no hay migración).
- [ ] **Step 3: Write** la migración.
- [ ] **Step 4: Run** `npx vitest run apps/api/tests/integration/webapp-database.test.ts apps/api/tests/integration/assessment-database.test.ts apps/api/tests/integration/database.test.ts`: PASS. Después, `npm run build && npm test`.
- [ ] **Step 5: Commit** — `"Add the webapp schema migration, tested in PGlite (not applied anywhere)"`

---

### Task 6: Cliente de la app, sesión y login y pago simulados en el front

**Files:**
- Create:
  - `Arca-front/lib/app/session.ts`
  - `Arca-front/lib/app/client.ts`
  - `Arca-front/lib/app/auth.ts`
  - `Arca-front/lib/debug/mock-auth.ts`
  - `Arca-front/lib/debug/mock-billing.ts`
- Modify:
  - `Arca-front/lib/api/client.ts`: exporta `apiSend`, `apiFailure` y `apiParse` (los `send`, `failure` y `parse` actuales) y añade los códigos `payment_required`, `forbidden`, `not_configured` y `gone` a `ApiErrorCode` y a `ERROR_CODES`;
  - `Arca-front/lib/debug/bridge.ts`: añade `debugSignIn` y `debugPay`.
- Test:
  - `Arca-front/lib/app/session.test.ts`
  - `Arca-front/lib/app/client.test.ts`
  - `Arca-front/lib/debug/bridge.test.ts` (añadir casos)

**Interfaces:**
- Consumes: el contrato de la Task 1 (`@arca/contracts`, raíz) y la API de la Task 4.
- Produces:
  - `session.ts`:
    - `saveAppSession({ token, email, expiresAt })`, `loadAppSession(): { token; email; expiresAt } | null` (null si caducó) y `clearAppSession()`, en `localStorage['arca.app.session']`;
    - `savePendingClaim({ claimId, email, expiresAt })`, `loadPendingClaim()` y `clearPendingClaim()`, en `sessionStorage['arca.app.claim']`;
    - `rememberOrg(id)` y `recallOrg()`, en `localStorage['arca.app.org']`.

    Todo dentro de try/catch, como `lib/api/session.ts`.
  - `client.ts`: una función por ruta de la Task 4. Todas con el Bearer de `loadAppSession()` (sin sesión, `ApiError('unauthorized')` sin hacer fetch) y parseadas con los schemas del contrato. Nombres:
    - `getPlans`, `createClaim(scanToken)`, `getMe`, `createOrg(name, claimId)`, `getOrg(id)`;
    - `listAnalyses(orgId)`, `attachAnalysis(orgId, claimId)`;
    - `listMembers(orgId)`, `invite(orgId, email, role)`, `revokeInvitation(orgId, id)`, `setMemberRole(orgId, userId, role)`, `removeMember(orgId, userId)`, `acceptInvitation(token)`;
    - `checkout(orgId, planCode)`, `portal(orgId)`, `requestDeletion(orgId, reason)`;
    - `adminListOrganizations`, `adminListDeletionRequests`, `adminReviewDeletion(id, decision, note?)`, `adminListPlans`, `adminUpdatePlan(code, patch)`.
  - `auth.ts`: `signIn(email, opts?: { platformAdmin?: boolean }): Promise<'signed_in' | 'not_configured'>` y `signOut()`:
    - en mock, `debugSignIn` del puente guarda la sesión;
    - si no, `'not_configured'`, porque Supabase Auth llega después de la demo.
  - `bridge.ts`:
    - `debugSignIn(email, platformAdmin?): Promise<{ token; email; expiresAt } | null>` y `debugPay(sessionId): Promise<boolean | null>`;
    - el guard es literal, `process.env.NEXT_PUBLIC_ARCA_MODE !== "mock"` → `return null`, y va **antes** del `import("./mock-auth")` o `import("./mock-billing")` dinámico;
    - `mock-auth.ts` y `mock-billing.ts` hacen el `fetch` a `/__debug/...` con `X-Arca-Debug: 1`.

- [ ] **Step 1: Write the failing tests:**
  - `session`: la sesión caducada da null; el storage bloqueado no lanza error; el reclamo pendiente vive en sessionStorage.
  - `client`:
    - manda `Authorization: Bearer <token>`;
    - un 402 se convierte en `ApiError('payment_required')`;
    - un 501, en `not_configured`;
    - sin sesión no hace fetch;
    - un cuerpo fuera de contrato da `contract`.
  - `bridge`:
    - con `NEXT_PUBLIC_ARCA_MODE` sin definir, `production` o `live-debug`, `debugSignIn` y `debugPay` devuelven null sin hacer fetch;
    - con `mock`, llaman a `/__debug/auth/login` con `X-Arca-Debug: 1`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` y el build de producción sin modo → `[check-no-debug] 0 debug leak(s)`. Si aparece una fuga de `/__debug/`, revisa que el `import()` dinámico esté dentro del guard literal.
- [ ] **Step 5: Commit** (Arca-front) — `"Add the app client, the app session and mock sign-in and payment through the debug bridge"`

---

### Task 7: Pantallas esqueleto de `/app` y el CTA de resultados

**Files:**
- Create, en `Arca-front/app/app/`:
  - `layout.tsx` (`"use client"`): exige sesión, salvo en `login`, `signup` e `invite`, y lleva un encabezado mínimo con la organización activa y "Sign out";
  - `page.tsx`: panel con los análisis (score, tier y dominios, reutilizando `ScoreGauge`, `TierBadge` y `DomainBar`), aviso de borrado pendiente y "Add an analysis" con el CTA de resultados;
  - `login/page.tsx`;
  - `signup/page.tsx`: email prefijado y bloqueado desde el reclamo pendiente, y nombre de la organización;
  - `billing/page.tsx`: planes de `getPlans`, estado y botón de pago;
  - `billing/mock-checkout/page.tsx`: "Simulated payment" → `debugPay` → `/app?paid=1`;
  - `members/page.tsx`;
  - `settings/page.tsx`: datos y "Request deletion" con motivo;
  - `invite/[token]/page.tsx`.
- Create: `Arca-front/components/app/SaveResultsCta.tsx`, montado en `app/assessment/results/page.tsx`.
- Modify: `Arca-front/app/assessment/results/page.tsx` (solo montar el CTA).
- Test: `Arca-front/components/app/app-flow.test.tsx`

**Interfaces:**
- Consumes: Task 6 y los componentes de `components/score`.
- Comportamiento que el test fija:
  - sin sesión, `/app` y sus páginas privadas redirigen a `/app/login`;
  - una respuesta 402 de `listAnalyses` lleva a `/app/billing`;
  - `/app/signup` con un reclamo pendiente muestra el email en un input `readOnly`;
  - tras `createOrg`, la pantalla siguiente es `/app/billing`;
  - el usuario sin organizaciones ve "Complete an analysis to create your organization" con un enlace a `/quote`;
  - en `members`, los botones que el rol no permite (`can()` del contrato) están deshabilitados, **salvo** en `mock` o `live-debug` (guarda literal en el sitio), donde quedan activos para mostrar el 403 del back;
  - `SaveResultsCta`:
    - sin sesión → `createClaim(recallSession(scanId))` → `savePendingClaim` → `/app/signup?claim=<id>`;
    - con sesión y organización → `attachAnalysis(org, claimId)` → `/app`;
  - el texto de `login` y `signup` en modos no-mock, cuando `signIn` da `not_configured`, es "Sign-in is not available yet in this environment."
- Reglas: esqueleto sin diseño, con los tokens de paleta. Nada de `components/debug` ni `@arca/contracts/debug`. Los textos van en inglés.

- [ ] **Step 1: Write the failing tests** (`app-flow.test.tsx`, jsdom, con `next/navigation` y el cliente mockeados como en `lib/assessment-flow.test.tsx`): un caso por cada comportamiento de la lista anterior.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** las páginas y el CTA.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint` y el build de producción sin modo → 0 fugas.
- [ ] **Step 5: Commit** (Arca-front) — `"Add the /app skeleton and the save-results call to action"`

---

### Task 8: Panel de ARCA (prueba de concepto), smoke de la demo y documentación

**Files:**
- Create:
  - `Arca-front/app/app/admin/page.tsx`: "Platform admin (proof of concept)". Lista los planes con su precio editable (`adminUpdatePlan`) y las solicitudes de borrado con Approve y Reject. Si `me.platformAdmin` es false, muestra "Not available";
  - `Arca-front/scripts/webapp-demo-smoke.mjs`: Playwright de `../Arca-back/node_modules/playwright`, contra el stack en mock;
  - `Arca-front/docs/implementation/webapp.md`: puntero corto a DN-10.
- Modify:
  - `Arca-front/package.json`: `"test:browser:webapp": "node scripts/webapp-demo-smoke.mjs"`;
  - `Arca-back/docs/design-notes/DN-10-webapp-organizaciones-y-cobro.md`: §11 "Cómo correr la demo" (comandos de PowerShell y guion paso a paso) y §12 "Verificación" (salidas reales, sin secretos).

**Interfaces:**
- Consumes: todo lo anterior.
- El smoke recorre, en un solo navegador con contextos separados para el owner, el invitado y el admin, los cinco puntos de DN-10 §10. Bloquea los hosts no locales y falla si alguno se pide. Usa `robust.arca.example` y "Fill mock firm" del panel de DN-09.

- [ ] **Step 1: Escribe la página admin y el smoke.**
- [ ] **Step 2: Levanta** `npm run stack -- mock` desde Arca-back en segundo plano. Espera a `/health` y a `:3000`, y corre `npm run test:browser:webapp` → 5 PASS. Arregla en la task dueña lo que falle. Al final detén lo que levantaste.
- [ ] **Step 3: Verificación final:**
  - back: `npm run build && npm test`;
  - front: `npm test`, `typecheck`, `lint` y el build de producción sin modo → 0 fugas;
  - copia las salidas a DN-10 §12.
- [ ] **Step 4: Escribe** DN-10 §11 y §12 y la página de docs del front.
- [ ] **Step 5: Commit** en cada repo — `"Add the platform admin proof of concept, the webapp demo smoke and how to run the demo (DN-10)"`
