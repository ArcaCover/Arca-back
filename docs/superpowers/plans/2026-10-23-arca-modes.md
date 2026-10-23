# Modos `mock` y `live-debug`: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dos modos de desarrollo seleccionables por variable de entorno, `mock` y `live-debug`, compartidos entre Arca-back y Arca-front. Traen etiquetas visibles, un panel de estado e inyección de fallos. Producción no puede alcanzar nada de esto.

**Architecture:**
- **Back.** Lee `ARCA_MODE` en `loadEnv`. Solo fuera de producción, `server.ts` construye un objeto `DebugTools` y se lo pasa a `createApp`. Sin `debug`, `createApp` no registra rutas `/__debug`, no lee la cabecera de escenario y no la admite en CORS.
  - Un scan con escenario corre por un `InProcessPipeline` con fuentes envueltas.
  - Vive en repositorios en memoria enrutados por `scanId`.
- **Front.** Fija `NEXT_PUBLIC_ARCA_MODE` como literal en `next.config.ts`. Carga el UI de debug con `next/dynamic` dentro de una comparación literal con allowlist, y un `postbuild` verifica que el build de producción no contiene ningún centinela de debug.

**Tech Stack:**
- Back: Node 22, Hono 4.13, zod 3, vitest 3, tsx.
- Front: Next 16.2 (Turbopack en build), React 19, Tailwind 4, vitest 5 con jsdom.
- E2E: Playwright de `Arca-back/node_modules`.

**Spec:** `Arca-back/docs/design-notes/DN-09-modos-mock-y-live-debug.md`. El ejecutor lee el spec y este plan; el spec manda sobre cualquier duda de intención.

## Global Constraints

- Repos: `C:\Users\jesus\projects\Arca-back` y `C:\Users\jesus\projects\Arca-front`. Las dos ramas son `feat/arca-modes`, ya creadas. **Solo commits locales: nunca `push`, nunca deploy.**
- Usa siempre rutas absolutas y `git -C <repo>`. Las shells paralelas comparten cwd.
- `.env.local` (back y front) tiene secretos reales:
  - nunca imprimas, cites ni copies sus valores;
  - nunca lo edites.
- Los modos:
  - valores exactos: `production`, `live-debug`, `mock`;
  - variable del back: `ARCA_MODE`; del front: `NEXT_PUBLIC_ARCA_MODE`;
  - si falta, se asume `production`; un valor inválido aborta el arranque o el build.
- Marcador de despliegue: `ARCA_DEPLOYMENT=aws`, en `deploy/production.env`. Si existe y el modo no es `production`, el back no arranca.
- Cabecera de escenario: `X-Arca-Debug-Scenario`, con JSON. Solo se lee en `POST /scan` y solo cuando `deps.debug` existe.
- Rutas de debug: `GET /__debug/mode`, `GET /__debug/scan/:scanId` (Bearer del scan) y `POST /__debug/reset`.
- En modos de debug, el back escucha en `127.0.0.1`. En producción, el comportamiento actual: todas las interfaces.
- UI de debug:
  - texto en inglés;
  - solo tokens de la paleta: `oro`, `marino`, `rojo`, `bruma`, `cielo`, `white`;
  - sin fuente monoespaciada;
  - todo contenido de terceros como texto, nunca `dangerouslySetInnerHTML`;
  - nunca muestra el email ni el token completo.
- Etiquetas exactas:
  - `MOCK · no real APIs · in-memory data`;
  - `LIVE DEBUG · real APIs & real database`;
  - `MODE MISMATCH · front=<f>, back=<b>`, o `MODE MISMATCH · front=<f>, back unreachable or production`.
- Centinela de debug del front: la cadena `arca-debug-sentinel-7f3c`. Aparece **solo** en código de debug; el build de producción no puede contenerla.
- Tests del back: `npm run build && npm test` desde la raíz de Arca-back. Los tests importan `@arca/*` vía `dist`, así que hay que compilar después de tocar `packages/*`.
- Tests del front: `npm test`, `npm run typecheck` y `npm run lint` en Arca-front. El build necesita antes `packages/contracts/dist` compilado en el back.
- Estilo: el del código que rodea. El back usa líneas largas, comentarios escasos que explican el porqué y TS estricto. El front usa Tailwind con tokens, y componentes de cliente con `"use client"`.

## Review Focus

1. **Variable de modo ausente en el build del front** (por ejemplo, `next build` en Vercel sin configurar). Lo esperado: modo `production`, cero código de debug en `.next`. Lo prueba la Task 7, ejecutando `check-no-debug` sobre un build con la variable sin definir.
2. **El `.env.local` real del back dice `live`/`supabase` y se arranca con `ARCA_MODE=mock`.** Lo esperado: mock/memory efectivo, sin clientes reales, y un aviso en el log. Lo prueban la Task 1 (`loadEnv`) y la Task 6 (sin red con ese mismo env).
3. **Un escenario en `live-debug` deja un directorio en `default`.** Lo esperado: el directorio real corre y reserva en el ledger con `scanId` indefinido, sin error inyectado de rebote. Lo prueba la Task 3 (el wrapper quita `scanId`) y la Task 5 (la reserva no lleva `scanId`).
4. **Una cabecera de escenario malformada o con claves desconocidas.** Lo esperado: `400 invalid_request` en modos de debug, y que producción la ignore por completo. Lo prueba la Task 5.
5. **El front en mock contra un back en producción, o apagado.** Lo esperado: la franja dice MODE MISMATCH, nunca MOCK. Lo prueban la Task 8 (`checkModes`) y la Task 10 (e2e).

---

### Task 1: Modo del back en la configuración

**Files:**
- Create: `Arca-back/apps/api/src/config/mode.ts`
- Modify: `Arca-back/apps/api/src/config/env.ts`, `Arca-back/deploy/production.env`, `Arca-back/.env.example`
- Test: `Arca-back/apps/api/tests/unit/env.test.ts` (añadir un bloque `describe('ARCA_MODE', …)`)

**Interfaces:**
- Produces:
  - `export const ARCA_MODES = ['production', 'live-debug', 'mock'] as const`
  - `export type ArcaMode = typeof ARCA_MODES[number]`
  - `export function listenHostname(mode: ArcaMode): string | undefined`. Devuelve `'127.0.0.1'` fuera de producción y `undefined` en producción.
  - `loadEnv()` devuelve además `mode: ArcaMode` y `overridden: string[]`. `overridden` son los nombres pisados por mock, p. ej. `['SOURCE_MODE=live→mock', 'STORAGE_BACKEND=supabase→memory']`.

- [ ] **Step 1: Write the failing tests** en `env.test.ts`:
  - `defaults to production when ARCA_MODE is absent`: `loadEnv({ ...base, SOURCE_MODE:'mock', STORAGE_BACKEND:'memory' }).mode === 'production'`.
  - `rejects an unknown mode, listing the valid ones`: `ARCA_MODE:'Mock'` lanza un error que contiene `production`, `live-debug` y `mock`.
  - `mock forces mock sources, memory storage and rules planning over live settings`: con `{ ...base, ...database, ARCA_MODE:'mock', SOURCE_MODE:'live', STORAGE_BACKEND:'supabase', ASSESSMENT_PLANNER:'agent' }` el resultado cumple `toMatchObject({ mode:'mock', sourceMode:'mock', storageBackend:'memory', ASSESSMENT_PLANNER:'rules' })` y `overridden` contiene `'SOURCE_MODE=live→mock'`. Sin APIFY ni OPENAI no lanza.
  - `live-debug never forces: it requires live sources and Supabase`:
    - `{ ...base, ARCA_MODE:'live-debug', SOURCE_MODE:'mock' }` lanza con `/live-debug requires SOURCE_MODE=live/`;
    - con `STORAGE_BACKEND:'memory'` lanza con `/live-debug requires STORAGE_BACKEND=supabase/`;
    - con live, supabase y las claves → `mode:'live-debug'`.
  - `refuses any debug mode inside a deployment`:
    - `{ ...base, ARCA_MODE:'mock', ARCA_DEPLOYMENT:'aws' }` lanza con `/ARCA_DEPLOYMENT/`;
    - `{ ...base, SOURCE_MODE:'mock', STORAGE_BACKEND:'memory', ARCA_DEPLOYMENT:'aws' }` → `mode:'production'`.
  - `listens on loopback only in debug modes`: `listenHostname('mock') === '127.0.0.1'`, `listenHostname('live-debug') === '127.0.0.1'`, `listenHostname('production') === undefined`.

- [ ] **Step 2: Run** `npx vitest run apps/api/tests/unit/env.test.ts`. Expected: FAIL (no `mode`, ni `listenHostname`).

- [ ] **Step 3: Implement.**
  - En el schema: `ARCA_MODE: z.enum(ARCA_MODES).default('production')` y `ARCA_DEPLOYMENT: z.string().optional()`.
  - Mock resuelve **antes** de las validaciones de credenciales existentes:
    - `sourceMode='mock'`, `storageBackend='memory'` y `ASSESSMENT_PLANNER='rules'`;
    - registra en `overridden` cada valor distinto que pisó;
    - las validaciones de Supabase y Apify siguen dependiendo de `sourceMode`/`storageBackend` ya resueltos.
  - `live-debug` comprueba después de resolver los defaults heredados.
  - El chequeo de `ARCA_DEPLOYMENT` va primero.
  - `deploy/production.env`: añade `ARCA_DEPLOYMENT=aws` con un comentario de una línea. `ARCA_MODE` no se pone: ausente = production.
  - `.env.example`: un bloque comentado que explique `ARCA_MODE` (production | live-debug | mock) y apunte a DN-09.

- [ ] **Step 4: Run** `npx vitest run apps/api/tests/unit/env.test.ts`. Expected: PASS, incluidos los tests previos del archivo.

- [ ] **Step 5: Commit** — `git -C …/Arca-back commit -m "Read ARCA_MODE: production by default, mock forces safe settings, live-debug forces nothing"`

---

### Task 2: Contrato de debug compartido

**Files:**
- Create: `Arca-back/packages/contracts/src/debug.ts`
- Modify: `Arca-back/packages/contracts/src/index.ts` (añadir `export * from './debug.js';`)
- Test: `Arca-back/packages/contracts/tests/debug.test.ts`

**Interfaces:**
- Produces (todo exportado desde `@arca/contracts`):
  - `DEBUG_SCENARIO_HEADER = 'X-Arca-Debug-Scenario'`
  - `DebugScenario`, zod `.strict()` con defaults:
    - `website: z.enum(['default','no_identity','blocked','error','timeout']).default('default')`
    - `bar` y `avvo`: `z.enum(['default','empty','apify_quota','error','timeout']).default('default')`
    - `latency: z.enum(['instant','normal','slow']).default('instant')`
    - `http: z.object({ start: z.enum(['none','rate_limited','server_error']).default('none'), poll: z.enum(['none','unauthorized','server_error','hang']).default('none'), report: z.enum(['none','unavailable']).default('none') }).strict().default({})`
    - `planner: z.enum(['default','timeout']).default('default')`
  - `type DebugScenario = z.infer<…>`.
  - `isInjected(scenario: DebugScenario): boolean`. Es true si algún eje difiere de su default. `latency` cuenta.
  - `DebugModeResponse`, `.strict()`: `{ mode: z.enum(['mock','live-debug']), sourceMode: z.enum(['mock','live']), storageBackend: z.enum(['memory','supabase']), websiteEvidenceProvider: z.string(), assessmentPlanner: z.enum(['rules','agent']), signalLlmModel: z.string(), configured: z.object({ openai: z.boolean(), apify: z.boolean(), supabase: z.boolean() }).strict() }`.
  - `DebugScanState`, `.strict()`: `{ scanId, status: ScanStatus, canonicalDomain: z.string(), createdAt: z.string(), completedAt: z.string().nullable(), durationMs: z.number().nullable(), cached: z.boolean(), storage: z.enum(['memory','supabase']), injected: z.boolean(), scenario: DebugScenario.nullable(), sources: Layer1Result.shape.sources.nullable() }`. Sin email, por diseño.
  - `DEBUG_PRESETS: Record<'apify_quota'|'partial'|'identity_failed'|'all_down'|'session_expired', { label: string; scenario: Partial<DebugScenario> }>`, con las etiquetas en inglés:
    - "Apify out of credit": `{ bar:'apify_quota', avvo:'apify_quota' }`;
    - "Partial scan": `{ avvo:'error' }`;
    - "Failed: no firm identity": `{ website:'no_identity' }`;
    - "Every source down": `{ website:'error', bar:'error', avvo:'error' }`;
    - "Session expired": `{ http:{ poll:'unauthorized' } }`.

- [ ] **Step 1: Write the failing tests:**
  - `DebugScenario.parse({})` da todo en default;
  - `isInjected(DebugScenario.parse({})) === false`;
  - `isInjected(DebugScenario.parse({ bar:'apify_quota' })) === true`;
  - `DebugScenario.safeParse({ bar:'nope' }).success === false`;
  - `DebugScenario.safeParse({ extra:1 }).success === false`;
  - cada preset parsea con `DebugScenario.parse(preset.scenario)`;
  - `DebugScanState` rechaza un objeto con `email`.
- [ ] **Step 2: Run** `npx vitest run packages/contracts/tests/debug.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `debug.ts` y el export.
- [ ] **Step 4: Run** `npm run build && npx vitest run packages/contracts/tests/debug.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `"Add the debug scenario and debug view contracts"`

---

### Task 3: Fuentes con fallos inyectados

**Files:**
- Create: `Arca-back/apps/api/src/debug/sources.ts`
- Test: `Arca-back/apps/api/tests/unit/debug-sources.test.ts`

**Interfaces:**
- Consumes: `DebugScenario` (Task 2); `WebsiteSource`, `DirectorySource`, `unknownWebsite` de `@arca/contracts`.
- Produces:
  - `export const LATENCY_MS = { instant: 0, normal: 8_000, slow: 70_000 } as const`
  - `export function injectWebsite(real: WebsiteSource, scenario: DebugScenario, options: { latency: boolean }): WebsiteSource`
  - `export function injectDirectory(name: 'bar' | 'avvo', real: DirectorySource, scenario: DebugScenario): DirectorySource`. Conserva `jurisdiction`.
  - `export const APIFY_QUOTA_REASON` lo reexporta `directories.ts`. Hay que exportar desde `directories.ts` la constante que hoy está inline en la línea 244, sin cambiar su texto.

Comportamiento (en todos los casos sin datos, `rawContent` es JSON con `{ injected: '<valor>' }`, salvo donde se indica):

| Eje / valor | Resultado |
|---|---|
| website `default` | Espera la latencia si `options.latency` (respetando `signal`) y delega en `real`. |
| website `no_identity` | `data: unknownWebsite()`, `status: { status:'ok', dataStatus:'EMPTY', durationMs:0, pagesCrawled:1, reason:null }`. |
| website `blocked` | `data:null`, `status:'error'`, `dataStatus:'UNKNOWN'`, `pagesCrawled:0`, `code:'ACCESS_BLOCKED'`, `reason:'Website access was blocked'`. |
| website `error` | `throw new Error('Injected website failure')`. El `bounded()` real lo convierte. |
| website `timeout` | `status:'timeout'`, `dataStatus:'UNKNOWN'`, `code:'DEADLINE_REACHED'`, `reason:'Deadline reached'`. |
| directorio `default` | Delega en `real.run({ ...query, scanId: undefined }, signal)`. |
| directorio `empty` | `data:[]`, `status:'ok'`, `dataStatus:'EMPTY'`, `code:'NO_MATCH'`, `attorneysSearched: query.names.length`, `attorneysFound:0`, `providerRuns:[]`, `costUsd:0`, `reason:'Provider completed successfully with no accepted identity match'`. |
| directorio `apify_quota` | El mismo `status` que produce `ApifyDirectorySource` cuando el cliente lanza `PROVIDER_QUOTA_EXCEEDED` en todas las búsquedas. `rawContent` = `{ queries: names.map(target => ({ target, items:null, error:'provider_quota_exceeded' })), providerRuns: [] }`. |
| directorio `error` | `throw new Error('Injected directory failure')`. |
| directorio `timeout` | Como website `timeout`. |

- [ ] **Step 1: Write the failing tests:**
  - `website default delegates and waits the latency`: con fake timers, `latency:'normal'` no resuelve antes de 8000 ms; `real.run` se llama una vez.
  - `website no_identity yields insufficient identity through the real pipeline`: un `InProcessPipeline` con `injectWebsite` y directorios espía termina `FAILED`, y los dos directorios salen con `code === 'INSUFFICIENT_IDENTITY'` y sin llamadas.
  - `website error goes through the pipeline's own unavailable path`: `result.sources.website.status === 'error'` y `code === 'PROVIDER_ERROR'`.
  - `apify_quota matches the real directory source at the usage limit`:
    - construye `new ApifyDirectorySource('bar', fakeClient)`, con un `fakeClient.run` que lanza `new ApifyClientError('PROVIDER_QUOTA_EXCEEDED', …)` (usa el constructor real de `apify-client.ts`);
    - corre la misma query por los dos caminos;
    - compara los `status` con `durationMs` puesto a 0: `expect(injected.status).toEqual(real.status)`;
    - y `injected.data === real.data`.
  - `default directories drop the scan id so the ledger never points at an in-memory scan`: `real.run` recibe `scanId === undefined` cuando la query traía `scanId:'sc_x'`.
  - `jurisdiction survives the wrapper`: `injectDirectory('bar', { jurisdiction:'FL', run }, s).jurisdiction === 'FL'`.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/unit/debug-sources.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sources.ts` y el export de `APIFY_QUOTA_REASON` en `directories.ts`.
- [ ] **Step 4: Run** el mismo comando más `npx vitest run apps/api/tests/unit/sources.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `"Add fault-injecting wrappers around the scan sources"`

---

### Task 4: Repositorios de aislamiento

**Files:**
- Create: `Arca-back/apps/api/src/debug/isolation.ts`
- Modify:
  - `Arca-back/apps/api/src/repositories/in-memory.ts`: añade `clear(): void`;
  - `Arca-back/apps/api/src/assessment/repository.ts`: añade `clear(): void` a `InMemoryAssessmentRepository`;
  - `Arca-back/apps/api/src/http/rate-limit.ts`: añade `clear(): void` a `ScanLimiter`.
- Test: `Arca-back/apps/api/tests/unit/debug-isolation.test.ts`

**Interfaces:**
- Produces:
  - `export class RoutingScanRepository implements ScanRepository { constructor(durable: ScanRepository, overlay: InMemoryRepository); isolate(scanId: string): void; isIsolated(scanId: string): boolean; readonly overlay: InMemoryRepository }`. Enruta así:
    - `create`, `get`, `complete` y `saveRaw` → overlay si el scan está aislado, si no durable;
    - `cached` y `latestRaw` → solo durable;
    - `recoverInterrupted` → los dos;
    - todos los métodos de Apify → solo durable.
  - `export class RoutingAssessmentRepository implements AssessmentRepository { constructor(durable: AssessmentRepository, overlay: InMemoryAssessmentRepository, scans: RoutingScanRepository); readonly overlay: InMemoryAssessmentRepository }`. Enruta así:
    - `create(record)` → overlay si `scans.isIsolated(record.scan_id)`;
    - `get` y `commit` → overlay si el id existe en overlay, si no durable;
    - `getByScan(scanId)` → overlay si aislado;
    - `planningBefore` → la concatenación de los dos.

- [ ] **Step 1: Write the failing tests:**
  - **Durable espía.** Un objeto con `vi.fn()` en cada método del interfaz; `cached` devuelve `null`.
  - `an isolated scan never touches durable storage`: tras `isolate('sc_i')`, se llama a `create`, `get`, `complete` y `saveRaw` con `scan_id:'sc_i'`. Ninguno de esos espías del durable se llama, y `overlay.get('sc_i')` devuelve el registro.
  - `a clean scan goes to durable storage`: lo mismo con `sc_c` y sin `isolate` → los espías del durable se llaman.
  - `cache and analysis reuse read only durable storage`: `cached` y `latestRaw` llaman al durable, aunque haya un scan aislado del mismo dominio en el overlay.
  - `assessments of isolated scans stay in memory`:
    - `create` de un registro con `scan_id:'sc_i'` no llama a `durable.create`;
    - `get(id)` y `commit(id, …)` resuelven en el overlay;
    - `getByScan('sc_c')` va al durable.
  - `clear empties memory repositories and the limiter`:
    - tras `clear()`, `InMemoryRepository.get` devuelve `null`;
    - `ScanLimiter.check` vuelve a permitir después de agotar los 3 intentos por email.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/unit/debug-isolation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** el mismo comando. Expected: PASS.
- [ ] **Step 5: Commit** — `"Route scans with injected faults to in-memory storage"`

---

### Task 5: `DebugTools`, rutas `/__debug` y cableado en `createApp`

**Files:**
- Create: `Arca-back/apps/api/src/debug/tools.ts` (fábrica y rutas)
- Modify:
  - `Arca-back/apps/api/src/http/app.ts`: `AppDeps.debug?: DebugTools`; cabecera; faults; CORS; ruta; sin dedupe para inyectados;
  - `Arca-back/apps/api/src/assessment/service.ts`: opción `agentFor?: (scanId: string) => AssessmentAgent | undefined`, usada en `prepare()` como `this.options.agentFor?.(record.scan_id) ?? this.options.agent`.
- Test: `Arca-back/apps/api/tests/integration/debug-mode.test.ts`, y en el mismo archivo un `describe('production wiring')`.

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces:
  - `createDebugTools(options: { mode: 'mock' | 'live-debug'; describe: DebugModeResponse; sources: { website: WebsiteSource; bar: DirectorySource; avvo: DirectorySource }; scans: RoutingScanRepository; assessments: RoutingAssessmentRepository; pipelineTimeoutMs: number; clearDurableMemory?: () => void }): DebugTools`.
  - `DebugTools`:
    - `parseScenario(header: string | undefined): { ok: true; scenario: DebugScenario | null } | { ok: false }`. Da `null` si no hay cabecera o si `!isInjected`, y `ok:false` con JSON inválido o con schema que no valida.
    - `beginScan(scanId: string, scenario: DebugScenario): void`. Hace `scans.isolate` y guarda el escenario.
    - `pipelineFor(scenario: DebugScenario): Layer1Pipeline`. Es un `InProcessPipeline` con `injectWebsite(…, { latency: mode === 'mock' })`, `injectDirectory` y `repository: scans`.
    - `takePollFault(scanId: string): 'unauthorized' | 'server_error' | 'hang' | null`. `unauthorized` es permanente; `server_error` y `hang` solo en los 2 primeros polls de ese scan.
    - `reportFault(scanId: string): boolean`
    - `assessmentAgentFor(scanId: string): AssessmentAgent | undefined`. Con `planner:'timeout'` devuelve un agente que nunca resuelve, salvo por su `signal`.
    - `routes(context: { limiter: ScanLimiter; sessionSecret: string }): Hono`
- Lo que hace `createApp`:
  - **CORS.** `allowHeaders` añade `DEBUG_SCENARIO_HEADER` **solo** si `deps.debug`.
  - **`POST /scan`.** Con el body ya validado:
    1. `parseScenario`. Si es inválido: `400 { error:'invalid_request', message:'Invalid debug scenario' }`.
    2. `http.start` → `rate_limited` responde `429` con `Retry-After: 120`; `server_error` responde `500 internal_error`. En los dos casos, antes del limiter y sin crear scan.
    3. Si hay escenario: no se consulta `cached`; `beginScan` va antes de `repository.create`; el job usa `pipelineFor` y nunca `inFlightByDomain`.
  - **`GET /scan/:id` y `report.pdf`.** Después de autorizar, aplica `takePollFault` (solo en el poll) o `reportFault` (solo en el PDF):
    - `unauthorized` → `401 unauthorized`;
    - `server_error` → `500 internal_error`;
    - `hang` → espera 16 000 ms y responde normal;
    - `reportFault` → `503 { error:'report_unavailable', message:'Injected report failure' }`.
  - **Rutas.** `app.route('/__debug', deps.debug.routes({ limiter, sessionSecret }))`.
  - **`AssessmentService`.** Recibe `agentFor: deps.debug ? id => deps.debug.assessmentAgentFor(id) : undefined`.
- Las rutas que expone `routes()`:
  - `GET /mode` → `describe`.
  - `GET /scan/:scanId` → `DebugScanState`, con el Bearer igual que el poll: 401 o 404.
  - `POST /reset` → limpia el limiter, `scans.overlay`, `assessments.overlay` y `clearDurableMemory?.()`, y responde `{ ok: true }`.

- [ ] **Step 1: Write the failing tests.**

  **Production wiring** (`createApp` sin `debug`):
  - `/__debug/mode`, `/__debug/scan/sc_x` y `POST /__debug/reset` → 404;
  - un `POST /scan` con `X-Arca-Debug-Scenario: {"bar":"apify_quota"}` → 202. El pipeline espía recibe la llamada normal, y el escenario no afecta: el resultado viene del pipeline espía;
  - un `POST /scan` con cabecera basura → 202, no 400;
  - preflight con `Access-Control-Request-Headers: x-arca-debug-scenario` → `Access-Control-Allow-Headers` es exactamente `'Content-Type,Authorization'`.

  **Debug wiring.** Las fuentes base son `mockSources()`. Usa `RoutingScanRepository(durableSpy, new InMemoryRepository())` y dominio `robust.arca.example`:
  - `injected scan is isolated and ends as its sources dictate`: con `{ avvo:'error' }` → el poll final es `PARTIAL` y ningún espía de escritura del durable se llama.
  - `apify quota preset ends PARTIAL with the real quota reason`: `result.sources.bar.reason` contiene `'Apify usage limit reached'`.
  - `identity preset ends FAILED`: con `{ website:'no_identity' }` → `FAILED`.
  - `a scan without a scenario still uses the durable repository and the cache`: `durableSpy.create` se llama una vez y `cached` se consulta.
  - `injected scans never share an in-flight pipeline`: dos POST concurrentes al mismo dominio, uno limpio y otro con escenario, dan resultados distintos; el inyectado tiene `meta.reusedEvidence === false`.
  - `start faults answer before the limiter`: `rate_limited` da 429 con `Retry-After: '120'` y 4 llamadas seguidas con el mismo email no agotan el limiter real; `server_error` da 500.
  - `poll faults`:
    - `server_error` → los 2 primeros polls dan 500 y el tercero 200;
    - `unauthorized` → 401 en cada poll;
    - `hang` → con fake timers, la respuesta no llega antes de 16 000 ms.
  - `report fault`: `report.pdf` → 503 `report_unavailable`, con `renderReport` espía que no se llama.
  - `planner timeout falls back to rules`: con `assessmentPlanningTimeoutMs: 50` y `{ planner:'timeout' }`, el assessment llega a `READY` con `planner === 'rules'`.
  - `/__debug/scan requires the scan token and never returns the email`: sin token 401; con token, `DebugScanState.parse(body)` pasa y `JSON.stringify(body)` no contiene el email.
  - `/__debug/mode answers with the description only`: `DebugModeResponse.parse(body)` pasa.
  - `invalid scenario header → 400 invalid_request`: JSON roto, y también `{"bar":"nope"}`.
  - `reset clears the limiter`: 3 POST con el mismo email, el 4º da 429; tras `POST /__debug/reset`, el siguiente da 202.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/integration/debug-mode.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `tools.ts` y los cambios en `app.ts` y `service.ts`. El `jobs`/`drain` existente debe seguir esperando a los scans inyectados.
- [ ] **Step 4: Run** `npm run build && npm test`. Expected: PASS, toda la suite (387 previos más los nuevos).
- [ ] **Step 5: Commit** — `"Wire debug tools into the API: scenarios, faults and /__debug routes, absent in production"`

---

### Task 6: Composición, servidor y lanzadores

**Files:**
- Create:
  - `Arca-back/apps/api/src/compose.ts`: la composición que hoy vive en `server.ts:24-56`, convertida en función;
  - `Arca-back/scripts/with-mode.mjs`;
  - `Arca-back/scripts/stack.mjs`.
- Modify:
  - `Arca-back/apps/api/src/server.ts`: solo carga el env, llama a `compose`, `serve` con `hostname: listenHostname(env.mode)`, los timers y las señales;
  - `Arca-back/package.json`: scripts.
- Test: `Arca-back/apps/api/tests/integration/mock-offline.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces:
  - `export async function compose(env: ReturnType<typeof loadEnv>): Promise<{ app: Hono; drain: () => Promise<void>; recoverAssessments: () => Promise<void>; repository: ScanRepository; apify: ApifyClient | null; banner: string }>`.
  - `banner`: `` `[api] MODE=${mode} sources=${sourceMode} storage=${storageBackend}` ``, más ` (debug routes on 127.0.0.1 only)` si no es producción, más ` overrides: …` si `overridden` no está vacío.
  - En `live-debug`, `compose` envuelve:
    - `new RoutingScanRepository(supabaseRepo, new InMemoryRepository())`;
    - `new RoutingAssessmentRepository(supabaseAssessments, new InMemoryAssessmentRepository(), routing)`.

    El `ApifyClient.store` y `recoverInterrupted` usan el repositorio enrutado. `WebsiteExtractionSource` recibe el enrutado: su `latestRaw` va al durable.
  - En `mock`, el durable es un `InMemoryRepository` y se pasa `clearDurableMemory`.
  - Scripts:
    - `"dev:mock": "node scripts/with-mode.mjs mock npm run dev"`;
    - `"dev:live-debug": "node scripts/with-mode.mjs live-debug npm run dev"`;
    - `"stack": "node scripts/stack.mjs"`.
  - `with-mode.mjs <mode> <cmd…>`:
    - valida el modo contra la lista;
    - pone `ARCA_MODE`;
    - en `mock` pone también `SOURCE_MODE=mock` y `STORAGE_BACKEND=memory`, para que el log no muestre overrides;
    - hace spawn con `shell:true` y `stdio:'inherit'`, y propaga el código de salida.
  - `stack.mjs <mode>`:
    - lanza `npm run dev` en Arca-back con `ARCA_MODE` (y lo de mock);
    - lanza `npm run dev -- --webpack` en `../Arca-front`, con `NEXT_PUBLIC_ARCA_MODE=<mode>` y `NEXT_PUBLIC_API_URL=http://localhost:${PORT ?? 8080}`;
    - prefija cada línea con `[back]` o `[front]`;
    - con Ctrl+C mata los dos;
    - sin modo, o con uno inválido, sale con código 1 e imprime el uso.

- [ ] **Step 1: Write the failing test** `mock-offline.test.ts`:
  - `beforeAll` sustituye `globalThis.fetch`, `net.Socket.prototype.connect` y `dns.promises.lookup` / `dns.lookup` por funciones que **lanzan** y registran cada intento en un array `attempts`;
  - `afterAll` los restaura;
  - el env es `loadEnv({ ARCA_MODE:'mock', SOURCE_MODE:'live', STORAGE_BACKEND:'supabase', SUPABASE_URL:'https://x.supabase.co', SUPABASE_SECRET_KEY:'sb_secret_x', OPENAI_API_KEY:'sk-x', APIFY_API_TOKEN:'x', SESSION_TOKEN_SECRET:'s'.repeat(40), CORS_ALLOWED_ORIGINS:'http://localhost:3000' })`. Simula el `.env.local` real;
  - recorre: `POST /scan` (`robust.arca.example`), `GET /scan/:id` hasta terminal, `POST /scan/:id/assessment`, `GET /assessment/:id` hasta READY, un PUT por pregunta visible (primera opción válida) hasta completar, `POST complete`, `GET result`;
  - comprueba que `attempts` queda en `[]` y que `compose(env).banner` contiene `'MODE=mock'` y `'overrides: SOURCE_MODE=live→mock'`.
- [ ] **Step 2: Run** `npx vitest run apps/api/tests/integration/mock-offline.test.ts`. Expected: FAIL (`compose` no existe).
- [ ] **Step 3: Implement** `compose.ts`, adelgaza `server.ts` sin cambiar el comportamiento de producción y escribe los dos scripts.
- [ ] **Step 4: Run** `npm run build && npm test`. Expected: PASS. Luego, a mano:
  - `node scripts/with-mode.mjs mock npm run dev` → el log muestra `MODE=mock` y el listen en 127.0.0.1;
  - `netstat -ano | findstr :8080` → solo `127.0.0.1:8080` en LISTENING;
  - detén el proceso.
- [ ] **Step 5: Commit** — `"Compose the API from its environment and add mode launchers; bind debug modes to loopback"`

---

### Task 7: Modo del front, puente y verificación del bundle

**Files:**
- Create:
  - `Arca-front/lib/arca-mode.ts`;
  - `Arca-front/lib/debug/bridge.ts`;
  - `Arca-front/lib/debug/store.ts`;
  - `Arca-front/components/debug/DebugMount.tsx`;
  - `Arca-front/components/debug/DebugRoot.tsx` (mínimo en esta task: contiene el centinela y la franja de modo);
  - `Arca-front/scripts/check-no-debug.mjs`;
  - `Arca-front/scripts/with-mode.mjs`.
- Modify:
  - `Arca-front/next.config.ts`: `resolveArcaMode(process.env)` + `env: { NEXT_PUBLIC_ARCA_MODE: mode }`;
  - `Arca-front/app/layout.tsx`: `<DebugMount />` dentro de `<body>`, después de `{children}`;
  - `Arca-front/package.json`: `"postbuild": "node scripts/check-no-debug.mjs"`, `"dev:mock": "node scripts/with-mode.mjs mock next dev --webpack"` y `"dev:live-debug"` igual;
  - `Arca-front/vitest.config.mts`: `include` añade `"components/**/*.test.{ts,tsx}"` y `"scripts/**/*.test.mjs"`.
- Test: `Arca-front/lib/arca-mode.test.ts`, `Arca-front/lib/debug/bridge.test.ts`, `Arca-front/scripts/check-no-debug.test.mjs`

**Interfaces:**
- Produces:
  - `export const ARCA_MODES = ["production", "live-debug", "mock"] as const; export type ArcaMode = …`
  - `export function resolveArcaMode(env: Record<string, string | undefined>): ArcaMode`:
    - vacío o ausente → `"production"`;
    - inválido → lanza un error que lista los tres valores;
    - `env.VERCEL` definido y modo ≠ production → lanza un error que contiene `"local-only"`.
  - `bridge.ts`:
    - `publishDebugState(section: "quote" | "scanning" | "score" | "assessment" | "results", data: Record<string, unknown>): void`;
    - `debugScenarioHeaders(): Record<string, string>`;
    - `export const SCENARIO_STORAGE_KEY = "arca.debug.scenario"`.

    Las dos funciones empiezan con el guard literal: `if (process.env.NEXT_PUBLIC_ARCA_MODE !== "mock" && process.env.NEXT_PUBLIC_ARCA_MODE !== "live-debug") return …`. Es fail-closed, con allowlist. Después, `publishDebugState` llama a `window.__arcaDebug?.publish(section, data)` dentro de try/catch, y `debugScenarioHeaders` lee `sessionStorage[SCENARIO_STORAGE_KEY]` → `{ "X-Arca-Debug-Scenario": value }` o `{}`.
  - `store.ts`: `createDebugStore()` → `{ publish, subscribe, getSnapshot }` para `useSyncExternalStore`, y `installDebugStore()`, que asigna `window.__arcaDebug`.
  - `DebugMount.tsx` (`"use client"`): `const DebugRoot = process.env.NEXT_PUBLIC_ARCA_MODE === "mock" || process.env.NEXT_PUBLIC_ARCA_MODE === "live-debug" ? dynamic(() => import("./DebugRoot"), { ssr: false }) : null;` y devuelve `DebugRoot ? <DebugRoot /> : null`.
  - `check-no-debug.mjs`:
    - exporta `findDebugLeaks(dir: string): string[]` (los archivos con alguna coincidencia);
    - patrones: `arca-debug-sentinel-7f3c`, `__arcaDebug`, `X-Arca-Debug-Scenario` (sin distinguir mayúsculas), `/__debug/`, `LIVE DEBUG`, `MODE MISMATCH`;
    - como script: resuelve el modo con la misma regla que `resolveArcaMode`; si es `production`, analiza `.next/static` y `.next/server`, imprime las fugas y sale con 1 si hay alguna; si no, imprime `skipped (mode=<m>)` y sale con 0.

- [ ] **Step 1: Write the failing tests:**
  - `resolveArcaMode`:
    - `{}` → production;
    - `{NEXT_PUBLIC_ARCA_MODE:""}` → production;
    - `"mock"` → mock;
    - `"Mock"` lanza con `/production, live-debug, mock/`;
    - `{NEXT_PUBLIC_ARCA_MODE:"mock", VERCEL:"1"}` lanza con `/local-only/`;
    - `{VERCEL:"1"}` → production.
  - `bridge` (jsdom):
    - con `vi.stubEnv("NEXT_PUBLIC_ARCA_MODE","production")`, `debugScenarioHeaders()` devuelve `{}` aunque sessionStorage tenga escenario, y `publishDebugState` no llama a `window.__arcaDebug.publish` (espía);
    - con `"mock"`, devuelve la cabecera y publica;
    - con la variable sin definir, se comporta como production.
  - `findDebugLeaks`, sobre un directorio temporal: un archivo con `arca-debug-sentinel-7f3c` aparece en la lista; un directorio limpio da `[]`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `DebugRoot` en esta task es mínimo: el centinela en un atributo `data-arca-debug="arca-debug-sentinel-7f3c"` y una franja de modo estática. La Task 8 la completa.
- [ ] **Step 4: Verify.** `npm test` → PASS. Después, en Arca-back, `npm run build` para tener `contracts/dist`. Luego:
  - `npm run build` en Arca-front sin definir la variable (`Remove-Item Env:NEXT_PUBLIC_ARCA_MODE -ErrorAction SilentlyContinue`) → el `postbuild` imprime 0 fugas y sale con 0;
  - `$env:NEXT_PUBLIC_ARCA_MODE='mock'; npm run build` → OK y `skipped (mode=mock)`;
  - `node -e` que importe `findDebugLeaks` sobre ese `.next` de mock → **al menos 1** fuga. Eso prueba que el detector detecta;
  - `$env:VERCEL='1'; $env:NEXT_PUBLIC_ARCA_MODE='mock'; npm run build` → falla con `local-only`;
  - limpia las variables. Guarda las salidas para DN-09 §12.

  Si el build de producción contiene fugas, la DCE no funcionó. En ese caso pasa al plan B y repite la verificación: `turbopack.resolveAlias` condicional de `components/debug/DebugRoot` a un stub vacío cuando el modo es production.
- [ ] **Step 5: Commit** (Arca-front) — `"Add the build-time mode, the debug bridge and a postbuild check that production ships no debug code"`

---

### Task 8: Franja de modo y panel de estado

**Files:**
- Create:
  - `Arca-front/lib/debug/mode-check.ts`;
  - `Arca-front/lib/debug/token.ts`;
  - `Arca-front/components/debug/ModeBanner.tsx`;
  - `Arca-front/components/debug/StatePanel.tsx`.
- Modify: `Arca-front/components/debug/DebugRoot.tsx`
- Test: `Arca-front/lib/debug/mode-check.test.ts`, `Arca-front/lib/debug/token.test.ts`, `Arca-front/components/debug/ModeBanner.test.tsx`

**Interfaces:**
- Consumes: `DebugModeResponse`, `DebugScanState` (Task 2); `installDebugStore` y `createDebugStore` (Task 7).
- Produces:
  - `type BackModeProbe = { kind: "ok"; body: DebugModeResponse } | { kind: "absent" } | { kind: "unreachable" }`
  - `probeBackMode(baseUrl: string, fetcher = fetch): Promise<BackModeProbe>`. Un 404 o un body que no parsea da `absent`; un error de red da `unreachable`. Timeout de 5 s.
  - `checkModes(front: "mock" | "live-debug", probe: BackModeProbe): { state: "match"; mode } | { state: "mismatch"; label: string }`. El label sigue exactamente las Global Constraints.
  - `tokenTimes(token: string): { issuedAt: string; expiresAt: string } | null`. Decodifica el payload base64url y devuelve solo `iat` y `exp` en ISO. **Nunca** devuelve otros claims.
  - `ModeBanner` (props `{ front, check }`):
    - mock: `bg-oro` con rayas `marino` mediante `repeating-linear-gradient` en un `style` que use las variables CSS de los tokens, no hex;
    - live-debug: `bg-rojo text-white`;
    - mismatch: `bg-marino text-oro` con el icono `AlertTriangle` de lucide.
    - `role="status"` y `data-arca-debug="arca-debug-sentinel-7f3c"`.
  - `StatePanel`:
    - se pliega y despliega desde la franja;
    - muestra la sección publicada de la página actual (`usePathname`), el modo del back, el `scanId` (leído de `?scan`) y `tokenTimes` del token en `sessionStorage["arca.scan.<id>"]`;
    - tiene un botón "View internal state" que hace `GET /__debug/scan/:id` con Bearer y pinta el JSON con `JSON.stringify(…, null, 2)` dentro de un `<pre className="font-body whitespace-pre-wrap">`, siempre como texto.

- [ ] **Step 1: Write the failing tests:**
  - `checkModes("mock", {kind:"absent"})` → mismatch con label `MODE MISMATCH · front=mock, back unreachable or production`;
  - `checkModes("mock", ok live-debug)` → mismatch con `front=mock, back=live-debug`;
  - `checkModes("mock", ok mock)` → match;
  - `tokenTimes` con un JWT de prueba cuyo payload tiene `email` devuelve solo `issuedAt` y `expiresAt`, y `JSON.stringify(result)` no contiene `@`;
  - `tokenTimes("garbage")` → null;
  - `ModeBanner` (jsdom) pinta el texto exacto de cada modo y el de mismatch.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint`. Expected: PASS, sin avisos nuevos de lint.
- [ ] **Step 5: Commit** — `"Show the mode banner, back-mode check and state panel in debug builds"`

---

### Task 9: Escenarios, auto-respuesta y estado publicado por cada página

**Files:**
- Create:
  - `Arca-front/lib/debug/auto-answer.ts`;
  - `Arca-front/components/debug/ScenarioControls.tsx`;
  - `Arca-front/components/debug/AssessmentControls.tsx`.
- Modify:
  - `Arca-front/lib/api/client.ts`: en `startScan`, `headers: { "Content-Type": "application/json", ...debugScenarioHeaders() }`;
  - `Arca-front/components/debug/StatePanel.tsx`: monta los controles según la ruta;
  - `Arca-front/app/quote/page.tsx`, `app/quote/scanning/page.tsx`, `app/score/page.tsx`, `app/assessment/page.tsx` y `app/assessment/results/page.tsx`: llamadas a `publishDebugState`.
- Test: `Arca-front/lib/debug/auto-answer.test.ts`, `Arca-front/lib/api/client.test.ts` (añadir casos)

**Interfaces:**
- Consumes: `DEBUG_PRESETS`, `DebugScenario`, `RenderedQuestion`, `AnswerValue` y `AssessmentView` de `@arca/contracts`; las funciones de `lib/api/client.ts`; `SCENARIO_STORAGE_KEY`.
- Produces:
  - `chooseAnswer(question: RenderedQuestion): AnswerValue`. Usa `question.suggestedAnswer` si existe. Si no:
    - `single_select` / `yes_no` → la primera opción;
    - `multi_select` → la primera opción no exclusiva o, si solo hay exclusivas, la primera exclusiva sola;
    - `scale` → `max`;
    - `number` → `min`.
  - `autoAnswer(assessmentId: string, token: string, client = { getAssessment, saveAnswer }): Promise<AssessmentView>`. Responde cada pregunta visible sin respuesta y usa la vista de cada PUT para descubrir los seguimientos. Se detiene cuando no quedan pendientes; corta a 50 iteraciones lanzando error.
  - `ScenarioControls` (en `/quote`):
    - un select por eje; en `live-debug` oculta `latency` y las opciones `default` se rotulan "real";
    - botones de preset que rellenan los ejes;
    - "Clear" borra la clave;
    - en mock, "Fill mock firm" escribe un email `debug+<n>@arca.example` y el dominio `robust.arca.example` en los inputs del formulario. Usa el setter nativo de `value` más `dispatchEvent(new Event("input", { bubbles: true }))`;
    - "Reset limits" → `POST /__debug/reset`.
  - `AssessmentControls` (en `/assessment`):
    - "Auto-answer" → `autoAnswer` y luego `location.reload()`;
    - "Attest & complete" → `completeAssessment` y luego `router.push(resultsHref)`.
  - Qué publica cada página, con nombres exactos, en el punto donde el dato llega:

| Página | Datos |
|---|---|
| quote | `{ lastError: { code, retryAfter } \| null, response: { status, cached } \| null }` |
| scanning | `{ status, elapsed, waitedMs, pollEveryMs, phase }` |
| score | `{ status, cached, meta, sources, preScore: { total, tier, decision, confidence, assessmentStatus, flags }, identity: { status } }` |
| assessment | `{ assessmentId, status, planner, bankVersion, expiresAt, progress, planningMs }` |
| results | `{ layer1Score, layer2Score, compositeScore, tier, flags, bankVersion, scoringVersion }` |

  `/score` tiene que guardar el `PollResponse` crudo en una ref para publicarlo; hoy solo guarda la vista adaptada.

- [ ] **Step 1: Write the failing tests:**
  - `chooseAnswer` para los 5 tipos, con fixtures de `lib/test-fixtures/assessment.ts` o variantes mínimas, y para el caso con `suggestedAnswer`;
  - `autoAnswer` con un cliente falso: la 1ª vista tiene 2 pendientes; tras el 1er PUT aparece un seguimiento; termina con 3 PUTs y devuelve la vista final;
  - `client.test.ts`:
    - con `NEXT_PUBLIC_ARCA_MODE` sin definir y un escenario en sessionStorage, `startScan` llama a `fetch` **sin** la cabecera `X-Arca-Debug-Scenario`;
    - con `"mock"`, la lleva con el valor guardado.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint`, y repite la verificación de producción de la Task 7: `npm run build` sin modo → 0 fugas.
- [ ] **Step 5: Commit** — `"Add scenario presets, auto-answer and per-page debug state"`

---

### Task 10: E2E en navegador, verificación de seguridad y documentación

**Files:**
- Create: `Arca-front/scripts/debug-modes-smoke.mjs`
- Modify:
  - `Arca-back/docs/design-notes/DN-09-modos-mock-y-live-debug.md`: rellena §11 y §12 y cambia el estado a "implementado";
  - `Arca-front/docs/implementation/arca-modes.md`: nuevo; un puntero de una pantalla a DN-09 con los comandos;
  - `Arca-front/package.json`: `"test:browser:modes": "node scripts/debug-modes-smoke.mjs"`.

**Interfaces:**
- Consumes: todo lo anterior, con los dos servidores corriendo.
- El smoke usa el Chromium de Playwright de `../Arca-back/node_modules/playwright`, igual que `assessment-browser-smoke.mjs`. Variables: `ARCA_FRONTEND_URL` (por defecto `http://localhost:3000`) y `ARCA_API_URL` (por defecto `http://localhost:8080`). Bloquea toda petición a hosts no locales, salvo `fonts.gstatic.com` y `fonts.googleapis.com`; si no, falla. Escenarios:
  1. **Recorrido feliz en mock:**
     - la franja dice `MOCK · no real APIs · in-memory data`;
     - "Fill mock firm" + submit;
     - llega a `/score` con estado COMPLETED en el panel;
     - abre el assessment, pulsa "Auto-answer" y luego "Attest & complete";
     - llega a `/assessment/results` con un `compositeScore` visible.
  2. **Preset "Apify out of credit":** `/score` muestra el aviso de evidencia incompleta, y el panel muestra `bar.reason` con "Apify usage limit reached".
  3. **Preset "Failed: no firm identity":** pantalla "We couldn't finish your scan".
  4. **Preset "Session expired":** vuelve a `/quote`.
  5. **Desalineación:** con `ARCA_API_URL` apuntando a un puerto sin servidor, la franja dice `MODE MISMATCH · front=mock, back unreachable or production`.

- [ ] **Step 1: Run the stack in mock.** `npm run stack -- mock` desde Arca-back, en segundo plano; espera a `/health` y a `:3000`.
- [ ] **Step 2: Write and run the smoke.** `node scripts/debug-modes-smoke.mjs` en Arca-front. Expected: los 5 escenarios en PASS y capturas en `artifacts/modes/`. Arregla en la task dueña lo que falle.
- [ ] **Step 3: Security verification.** Ejecuta cada comando y copia en DN-09 §12 la salida relevante, sin secretos:
  - (a) `npm test` en el back → total en verde;
  - (b) `npm test`, `typecheck` y `lint` en el front;
  - (c) `npm run build` del front sin modo → `check-no-debug` con 0 fugas, y búsqueda manual `Select-String -Path .next\static\**\*.js -Pattern 'arca-debug-sentinel|__arcaDebug|/__debug/'` → nada;
  - (d) build con `VERCEL=1` y mock → falla con `local-only`;
  - (e) back en producción local (`SOURCE_MODE=mock`, `STORAGE_BACKEND=memory`, sin `ARCA_MODE`) → `curl /__debug/mode` da 404; `curl -X POST /scan` con la cabecera de escenario da 202 normal; el preflight no admite la cabecera;
  - (f) `ARCA_MODE=mock` con `ARCA_DEPLOYMENT=aws` → el arranque falla;
  - (g) `netstat` en mock → solo `127.0.0.1:8080`;
  - (h) el test `mock-offline` en verde, con 0 intentos de red;
  - (i) `live-debug` **sin ejecutar scans reales**: arranca, el banner dice `MODE=live-debug` y `/__debug/mode` responde. No se lanza ningún scan pagado sin que Jesús lo pida.
- [ ] **Step 4: Docs.**
  - DN-09 §11: los comandos exactos de PowerShell para mock, `live-debug` y `stack`; cómo comprobar que los modos coinciden (la franja, más `curl http://127.0.0.1:8080/__debug/mode`); cómo volver a producción local.
  - DN-09 §12: la tabla de verificaciones con resultado.
  - Arca-front `docs/implementation/arca-modes.md`: el puntero.
- [ ] **Step 5: Commit** en cada repo — `"Verify the modes end to end and document how to run them (DN-09)"`. Deja `mock` corriendo para Jesús.
