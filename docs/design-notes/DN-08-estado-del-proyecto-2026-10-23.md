# DN-08 — Estado del proyecto ARCA al 2026-10-23

**Estado:** foto fija del proyecto **antes de DN-09** (modos `mock` y `live-debug`). Describe lo que hay; no propone cambios. Lo que cambie DN-09 se documenta en DN-09.
**Para:** Jesús (back).
**Fuentes:**
- Código de `Arca-back` en `5123b00` y de `Arca-front` en `64a67b0` (rama `main`; las ramas `feat/arca-modes` de los dos repos están en el mismo commit).
- Ocho informes de lectura hechos el 2026-10-23 sobre los dos repos. Uno de ellos es un crítico que revisó a los otros siete; donde los corrige, esta nota sigue al crítico.
- Consultas de solo lectura del mismo día a GitHub (`gh`) y a la red (`curl`), y comprobaciones puntuales en el código donde los informes no coincidían.

**Marcas de evidencia:**
- **[código]**: comprobado leyendo el código en esos commits.
- **[GitHub]** / **[red]**: comprobado con `gh` o `curl` el 2026-10-23.
- **[doc]**: lo afirma un documento; no se verificó.
- **[notas]**: viene de notas locales de sesiones anteriores; no se puede verificar desde el repo.
- **[inferencia]**: deducido del código, sin ejecutarlo.

Sin marca: hechos de código que varios informes contrastaron. Las rutas son relativas al repo (`Arca-back/` o `Arca-front/`) salvo aviso. Esta nota no contiene ningún valor de `.env.local`, de SSM ni ningún otro secreto; solo nombres de variables y valores de modo.

---

## 1. Resumen ejecutivo

### Qué es ARCA

Según `Arca-front/CLAUDE.md` **[doc]**, ARCA es una MGA de *surplus lines* que asegura a despachos de abogados frente a los errores de la IA. Técnicamente hoy tiene dos capas:

- **Layer 1 (Quick Scan).** Recibe un dominio y un email. Rastrea la web del despacho con Playwright y extrae señales con un LLM (OpenAI, proveedor `agentic`). Busca a los abogados en Florida Bar y Avvo vía Apify. Con eso calcula un Pre-Score determinista de 0 a 100, con tier, decisión, overrides y flags, y genera un PDF de una página.
- **Layer 2 (assessment adaptativo).** Es un cuestionario de 10 a 12 preguntas sacadas de un banco fijo de 14, con un score compuesto L1/L2. **Es demo por contrato.**
- **Layer 3** (monitorización continua) solo existe como idea de negocio.

### Qué funciona de punta a punta hoy (en local)

- **El embudo completo está cableado:** `/quote` → `POST /scan` → `/quote/scanning` (polling) → `/score` (más el PDF) → `/assessment` → `/assessment/results`. Front y back comparten contratos zod `.strict()`.
- **El CI del back pasó en verde el 2026-10-16:** 42 archivos y 387 tests **[GitHub]**. El front tiene 9 archivos de test y **no tiene CI**.
- **El modo `mock` del back recorre el flujo en milisegundos** con cinco dominios `*.arca.example`, sin OpenAI, Apify ni DNS, y con el scoring real.
- **No hay ninguna medición documentada de un scan live completo con el código actual.** Las últimas son del 2026-09-15, con código anterior: 1 min 48 s (FAILED) y 7 min 13 s (PARTIAL) **[doc]**.

### Qué es solo demo

- **Todo Layer 2.**
  - `bankStatus: 'DEMO'` y `commercialDecisionBlocked: true` son literales del contrato (`packages/contracts/src/layer2.ts:36,55-56`).
  - La fórmula del compuesto (30/70) es provisional.
  - La decisión de L2 nunca es `AUTO_BIND`.
  - Meter un banco real obliga a cambiar el contrato.
- **Contenido de marketing del front:** testimonios ficticios (`lib/mock/testimonials.ts`) y primas y scores ilustrativos (`components/OceanPanel.tsx`).
- **No existe:** pricing, binding, cuentas de usuario, magic links ni el PDF del assessment.

### Producción: caída

- **La API no responde.** `api.arcacover.com` resuelve, pero `/health` agota el tiempo por HTTPS **[red]**. Según **[notas]**, el stack de AWS (EC2, Elastic IP y ECR) se desmontó el 2026-10-02 con `arca-aws.ps1 down`, y el DNS de Vercel sigue apuntando a la IP antigua.
- **El auto-deploy está apagado.** La variable de repo `AWS_DEPLOY_ROLE_ARN` no existe **[GitHub]**, y el job `deploy` solo corre si existe (`.github/workflows/deploy-api.yml:64-66`). El último deploy bueno fue el 2026-10-01, con el commit `ae8c143`.
- **Layer 2 nunca llegó a producción.** El push de `5123b00` pasó los tests y el deploy se saltó **[GitHub]**.
- **`arcacover.com` (el front en Vercel) responde 200** **[red]**. No se sabe qué commit sirve.
- **Cuidado al volver a levantarlo.** `arca-aws.ps1 up` vuelve a fijar `AWS_DEPLOY_ROLE_ARN`. A partir de ahí, cada push a `main` que toque `apps/**`, `packages/**`, `deploy/**` y similares despliega solo, y no hay CI en los PR.

### Riesgos y decisiones pendientes más importantes

El orden es mío.

1. **El desarrollo local comparte datos y gasto con producción.**
   - El `.env.local` del back está en `SOURCE_MODE=live` y `STORAGE_BACKEND=supabase`. Un `npm run dev` sin overrides rastrea webs reales, paga OpenAI y Apify y escribe en Supabase.
   - Según **[notas]**, ese proyecto de Supabase es el único y lo usa también producción. Su URL coincide con la versionada en `.env.example` **[código]**.
   - Un proceso local puede marcar como FAILED scans de otro proceso (`recoverInterrupted`), cerrar assessments en PLANNING y tocar el ledger de Apify (§10).
2. **El gasto de Apify no tiene tope.** Se registra pero no se limita: los topes se retiraron el 2026-09-21. El único freno a un `POST /scan` anónimo es un rate limit en memoria de 10 por IP y 3 por email cada hora.
3. **En live, Layer 1 casi nunca da una decisión comercial** **[código]**.
   - El parser de Florida Bar nunca devuelve `hasDisciplinaryHistory: false` (`apps/api/src/pipeline/directories.ts:58-70`). Por eso Professional Standing queda PARTIAL, `assessmentStatus` = `INSUFFICIENT_EVIDENCE` y `decision` = `UNKNOWN`, salvo overrides. Los mocks traen `false` y no lo reproducen.
   - Además, las firmas de fuera de Florida salen penalizadas.
   - El extractor `agentic` es el default sin haber pasado los gates de DN-05.
4. **Restaurar producción no es solo ejecutar `up`.** Hay que resolver:
   - la IP nueva y el DNS;
   - las imágenes de rollback, probablemente borradas con el ECR **[notas]**;
   - que la migración de Layer 2 esté aplicada en la base real, sin verificar porque no hay migraciones en el pipeline;
   - que el arranque se bloquea si Supabase está pausado;
   - que el auto-deploy se vuelve a encender.
5. **El front de `main` probablemente no compila fuera de esta máquina** **[inferencia]**. Depende de `file:../Arca-back/packages/contracts` (la versión 0.2.0 no tiene tag ni release) y exige `NEXT_PUBLIC_API_URL` en el build.
6. **Hay exposición en repos públicos y en el contrato.** Los dos repos son PUBLIC **[GitHub]**.
   - El runbook trae en claro dos emails de alerta.
   - El ID de la cuenta de AWS aparece en 5 archivos.
   - La URL del proyecto Supabase está en `.env.example`.
   - La respuesta de `GET /scan/:id` incluye `providerRuns` y costes de Apify.
   - Detalle en §10.
7. **Layer 2 depende de decisiones de negocio:** el contenido del banco (Juan José), la fórmula del compuesto, qué flags bloquean la decisión y la reanudación más allá de 24 h.
8. **La documentación engaña en puntos operativos.** El README del back, `Arca-front/CLAUDE.md` y el DN-07 de Layer 2 ("nada implementado") contradicen el código en el proveedor por defecto, los tiempos, la forma de instalar los contratos y el estado de Layer 2. Además hay dos DN-07 distintos.

---

## 2. Repos, ramas y cómo se conectan

| | Arca-back | Arca-front |
|---|---|---|
| Remoto | `ArcaCover/Arca-back`, **PUBLIC** | `ArcaCover/Arca-front`, **PUBLIC**; también tiene un remoto `fork` |
| `main` | `5123b00`, 2026-10-16, merge del PR #13 (Layer 2) | `64a67b0`, 2026-10-16, merge del PR #25 (UI de Layer 2) |
| Rama actual | `feat/arca-modes`, creada para DN-09 a partir de `5123b00`. Lleva el diseño de DN-09, esta nota y el plan de implementación | `feat/arca-modes` en `64a67b0` |
| Otras ramas locales | `fix/oidc-immutable-subject`, `fix/ps-cdk-shim` y `fix/settle-directory-status`: fusionadas y con el upstream borrado. `docs/dn-07-layer2-assessment`: fusionada, pero sigue viva en local y en remoto | `claude/layer1-integration-spec` y `claude/quick-scan-report`: ya fusionadas en `main` |
| Tags | Solo `contracts-v0.1.0` | — |
| Stack | Node ≥20 (`engines`; CI usa 22), TypeScript, Hono sobre `@hono/node-server` 1.19.17, zod, jose, Playwright, Supabase y vitest | Next 16.2.10, React 19.2.7, Tailwind 4.3.2, TypeScript 6.0.3 y vitest 5.0.1 |

**De dónde viene Layer 2.** Los dos PR salen del fork `jesushoneybeeevals01/feat/layer2-adaptive-assessment`. La documentación los presenta como "prototipo aislado", pero están fusionados en el `main` de `ArcaCover` **[GitHub]**.

**Cómo consume el front los contratos:**
- `Arca-front/package.json:16` declara `"@arca/contracts": "file:../Arca-back/packages/contracts"`. `node_modules/@arca/contracts` es un symlink al checkout hermano.
- `exports` apunta a `dist/`, así que **hay que ejecutar `npm run build` en el back antes de usar el front**.
- `next.config.ts:7` fija `turbopack.root` en el directorio padre (`C:\Users\jesus\projects`) para resolver el symlink.

**Historia de los contratos:**
1. GitHub Packages.
2. Tarball del release `contracts-v0.1.0` (2026-09-25).
3. `file:` desde `a741a2b` (2026-10-12).

`packages/contracts/package.json:3` dice `0.2.0`, pero esa versión no tiene tag ni release.

**El back en dev y el front no leen el mismo código de contratos.** `npm run dev` del back usa `tsx watch --conditions=arca-source`, que lee `packages/contracts/src`. El front y los tests del back resuelven a `dist`. Si cambias un contrato y no compilas:
- el back emite la forma nueva;
- el front la rechaza con el error `contract`;
- en `/quote/scanning` eso se convierte en 11 minutos de reintentos.

**Red entre los dos.** El navegador llama a la API directamente, sin BFF ni proxy, por el rate limit por IP. Solo los orígenes de `CORS_ALLOWED_ORIGINS` pueden leer las respuestas.

---

## 3. Back

### 3.1 Arquitectura

```
Navegador ──> Arca-front (Next 16, Vercel)          [solo páginas; no hay rutas /api]
    │
    └─ fetch directo con Bearer ──> Caddy (TLS, basic auth en /docs) ──> API Hono (un proceso)
                                                                          ├─ Supabase (scans, raw, ledger Apify, assessments)
                                                                          ├─ Webs de despachos (DNS + Playwright/Chromium)
                                                                          ├─ OpenAI (extracción agentic; planner L2 opcional)
                                                                          └─ Apify (Florida Bar, Avvo)
```

**Monorepo de npm workspaces:**

| Paquete | Qué contiene |
|---|---|
| `apps/api` | La API Hono. Raíz de composición en `src/server.ts` y rutas en `src/http/app.ts`. Layer 2 vive en `src/assessment/` y el pipeline en `src/pipeline/`. |
| `packages/contracts` | Esquemas zod `.strict()` del contrato HTTP, `Layer1Result`, Layer 2 y las vistas (`views.ts`). |
| `packages/scoring` | Scoring determinista de L1 (`score.ts`, `categories.ts`, `math.ts`, `discipline.ts`) y de L2 (`layer2.ts`). |
| `packages/questions` | Banco, motor de visibilidad y planner de L2. |
| `infra/aws` | Stack CDK, con lockfile propio. |
| `deploy/` | `production.env`, `Caddyfile`, `render-env.py`, `activate.sh` y `deploy-image.sh`. |
| `supabase/` | Migraciones y `config.toml`. |

**Composición** (`apps/api/src/server.ts`):
1. Carga `.env.local` (`:22-23`) y ejecuta `loadEnv()`.
2. Crea los repositorios (`:25-27`) y lanza `recoverInterrupted` con `await` (`:29`).
3. Monta proveedores y fuentes (`:30-44`), el resolver de dominios (`:45-47`, que en mock solo admite los dominios mock) y el planner agente (`:50-51`).
4. Ejecuta `createApp`, luego `recoverAssessments` con `await` (`:57`) y después `serve()` (`:58`).
5. Arranca dos temporizadores de 60 s: recuperación (`:65-68`) y conciliación de costes de Apify (`:71-73`).

**Todo el estado vive en un solo proceso:** el limitador, la deduplicación en vuelo, los jobs de planificación y la pausa por cuota de Apify están en memoria (`README.md:175-176` lo reconoce). Para escalar a más de una instancia hace falta almacenamiento compartido.

**Puntos de inyección ya existentes.** `AppDeps` (`app.ts:16-25`) acepta `pipeline`, `repository`, `domainResolver`, `clientIp`, `limiter`, `now`, `renderReport`, `assessmentAgent`, `assessmentPlanningTimeoutMs` y los TTL. Hoy solo los usan los tests; `server.ts` solo pasa los TTL.

### 3.2 Layer 1: pipeline

**Flujo de `POST /scan`** (síncrono hasta la respuesta; `app.ts:44-121`):

1. **Valida** `ScanRequest`, que es estricto: `domain` entre 1 y 2048 caracteres y `email` pasado a minúsculas. Si falla, `400 invalid_request`.
2. **Rate limit en memoria:** 10 por IP y hora, 3 por email y hora (`http/rate-limit.ts:10`). Se cuenta **antes** de resolver el dominio y de mirar la caché, así que los cache hits también consumen cupo.
3. **Resuelve el dominio** (`pipeline/domain-resolution.ts`).
   - Normaliza: quita `www.`, aplica punycode y rechaza puertos, credenciales e IPs.
   - Rechaza los dominios de correo personal con `400 personal_email_domain`.
   - Ejecuta `assertPublicUrl`: todas las IPs resueltas tienen que ser unicast públicas, con un tope de 3 s. Si no, `400 invalid_domain`.
4. **Emite `scanId`** (`sc_<uuid>`) y un JWT de 24 h.
5. **Mira la caché por dominio** (ver la tabla de cachés). Un hit COMPLETED responde `200` al instante con un `scanId` y un token nuevos.
6. **Si no hay hit:** crea el registro RUNNING, responde `202` y lanza el job en segundo plano.

**Job asíncrono** (`pipeline/in-process-pipeline.ts`):
- **Dedupe en vuelo por dominio** dentro del proceso: los concurrentes comparten la ejecución y llevan `meta.reusedEvidence=true`.
- **Presupuesto:** `PIPELINE_TIMEOUT_MS` = 600 s. El abort salta a los 595 s y descarta el raw que llegue tarde.
- **Website:**
  - crawl con Playwright: 20 páginas, profundidad 2, 6 en paralelo, 30 s en total y como máximo 3 páginas del grupo de equipo;
  - toda petición pasa por `network.ts`, con anti-SSRF y la IP fijada;
  - después, la extracción `agentic`: clasificación con 3 votos, un "suelo de adquisición" de hasta 4 páginas más 2 PDFs (cada una lanza otro Chromium, en secuencia), roster, hasta 3 rondas con herramientas, revisión semántica y grounding determinista;
  - cada llamada a OpenAI tiene 120 s y hasta 3 intentos.
- **Identidad:** VERIFIED, PARTIAL o INSUFFICIENT. **Con INSUFFICIENT no se llama a Bar ni a Avvo**, que quedan `skipped/INSUFFICIENT_IDENTITY`.
- **Bar y Avvo en paralelo vía Apify:**
  - actores `scrapers_lat/florida-bar-lawyers-scraper` y `scrapers_lat/avvo-lawyers-scraper`;
  - una búsqueda por abogado, con el roster completo;
  - máximo 25 resultados en Bar y 10 en Avvo;
  - 8 búsquedas en vuelo por fuente y 16 en total;
  - cada búsqueda reserva en el ledger con la RPC `reserve_apify_run`.
- **Cierre:** persiste el raw, ejecuta el núcleo determinista (`evaluateLayer1Evidence`) y llama a `repository.complete`.

**Estados del scan** (`packages/contracts/src/layer1.ts:6`; la regla está en `in-process-pipeline.ts:72-73`):

| Estado | Cuándo |
|---|---|
| `RUNNING` | Desde `create` hasta el final del job. También es lo que responde un `POST` cuyo PARTIAL cacheado está dentro del cooldown. |
| `COMPLETED` | Las tres fuentes en `ok`, después de `settle()`, que puede convertir un TRUNCATED o un NO_MATCH confirmados. |
| `PARTIAL` | Al menos una fuente `ok`/`partial`, pero no las tres `ok`. **Cualquier** página no recuperable del crawl (un 404, robots o algo que no es HTML) marca el website como `partial`. |
| `FAILED` | Ninguna fuente útil, en la práctica cualquier fallo del website. También una excepción en el job o `recoverInterrupted` sobre un RUNNING de más de `PIPELINE_TIMEOUT_MS` + 120 s. **Nunca lleva `result`.** |

**Cachés:**

| Caché | Clave y TTL | Peculiaridades |
|---|---|---|
| Scan por dominio | Dominio, misma `contractVersion`, COMPLETED o PARTIAL; `SCAN_CACHE_TTL_MS` = 7 días | Un COMPLETED se re-sella para el nuevo solicitante. Un PARTIAL se vuelve a ejecutar si la última reparación tiene más de 1 h. Un FAILED nunca se reutiliza. El TTL no puede valer 0. |
| Análisis del website | `provider.id`, `version` y el sha256 del HTML | Es frágil: un nonce en el HTML obliga a pagar el LLM otra vez, y solo se mira el **último** raw del dominio. |
| Búsquedas de Apify | sha256 de actor, build e input; 7 días | Estados reuse, resume, failed (15 min de cooldown) y start. Un run truncado o parcial queda cacheado 7 días, así que reparar ese PARTIAL repite el mismo resultado. |

**Tiempos:**

| Paso | Tope en código | Medido **[doc]** |
|---|---|---|
| DNS del dominio | 3 s | — |
| Cada petición a Supabase | 5 s | — |
| Crawl inicial | 30 s | 19 páginas en 14 s (Gallardo, `8659d6b`) |
| Cada llamada a OpenAI | 120 s × 3 intentos | 155 s en 12 llamadas (Gallardo, 2026-09-15) |
| Cada run de Apify | 300 s en remoto | ~4 min para 46 runs con concurrencia 2, antes de subirla a 16 |
| Scan completo | 600 s | 1 min 48 s (FAILED) y 7 min 13 s (PARTIAL), 2026-09-15, con el código anterior |
| Front | Sondea cada 2 s y luego cada 5 s; abandona a los 660 s | — |

La UI y `CLAUDE.md` prometen "menos de 60 s" y no se corresponden con nada de esto (§9).

**Scoring de L1** (`packages/scoring/src`):

- **Categorías:**
  - AI Governance (35): W1 a W4.
  - Professional Standing (30): B1 a B4 y B2_sanction.
  - Reputation (20): A1, A3 y A6.
  - Firm Maturity (15): W7, W6, W5a, W8 y W9_A2.
- **Cómo se calcula una categoría.** Una regla sin evidencia vale `null` y no suma. La categoría es la suma acotada a [0, máx.], y es KNOWN solo si todas sus reglas lo son.
- **Total:** la suma de las categorías. Con una investigación activa confirmada, el total es 0.
- **Tiers y decisión base:**

  | Total | Tier | Decisión base |
  |---|---|---|
  | ≥80 | FORTRESS | AUTO_BIND |
  | ≥65 | FORTIFIED | AUTO_BIND_CONDITIONAL |
  | ≥45 | GUARDED | REFERRAL |
  | ≥25 | EXPOSED | REFERRAL_SENIOR |
  | <25 | CRITICAL | DECLINE |
- **`assessmentStatus`** es `SUFFICIENT` solo si las 4 categorías son KNOWN y no hay `AMBIGUOUS_IDENTITY_MATCH`. Si no, `decision` = `UNKNOWN` y se añade el flag `COMMERCIAL_DECISION_BLOCKED`.
- **Overrides** (solo restringen la decisión):
  - suspendido o expulsado → REFERRAL;
  - sanción de menos de 12 meses → REFERRAL_SENIOR;
  - investigación activa → DECLINE.
- **Confianza:** HIGH con 3 fuentes `ok`, MEDIUM con 2 y LOW con menos.
- **Multiplicadores** (área de práctica, jurisdicción y tamaño): se calculan pero **no se aplican** al score.
- **`preScore.total` nullable y tier `UNKNOWN`: código muerto.** El contrato admite `null`, pero el código nunca lo produce (`score.ts:57` usa `sum()`, que siempre devuelve un número). Layer 1 nunca emite el tier `UNKNOWN`. Pasa lo mismo con `compositeScore` en L2.

**Consecuencias de producto verificadas en código** **[código]**:
1. **Una firma limpia nunca llega a SUFFICIENT en live.** `parseBar` solo devuelve `hasDisciplinaryHistory` = `true` o `null` (`directories.ts:62-70`; el comentario dice que un "None" de 10 años no prueba un historial limpio). Entonces `cleanRecord` queda `null`, B2 queda `null`, Professional Standing queda PARTIAL y la decisión es `UNKNOWN` salvo overrides. La intención está en DN-01:63, pero ese documento no cuenta la consecuencia.
2. **Sesgo contra firmas de fuera de Florida.** Bar solo consulta la Florida Bar. Las búsquedas sin match quedan `ok/EMPTY` con consistencia 0, lo que da B3 −5 y el flag `LOW_BAR_CONSISTENCY`. La etiqueta "Florida Bar" está fija en `views.ts:22` y `report/quick-scan.ts:23`.
3. **Una sanción reciente resta menos que una antigua.** Menos de 12 meses resta 0 puntos (la cubre el override); de 1 a 3 años resta −12 (`discipline.ts:51`). No hay justificación documentada.
4. **El extractor `agentic` no puede producir dos penalizaciones:** `website_quality: 'minimal'` (W7 −3) ni `no_team_page` (W5a −2). Solo existen con `rules`, `openai` o los mocks (`derived-signals.ts:47,58`).
5. **Es fácil quedar en PARTIAL para siempre.** Un 404 estable dentro del crawl, o un run de Apify truncado y cacheado 7 días, deja el scan en PARTIAL de forma persistente.
6. **El abort descarta el raw del website.** El run de Apify queda en el ledger, pero el raw se pierde (también lo señala DN-06:33).

**El modo mock de hoy** (`SOURCE_MODE=mock`; `server.ts:30-47`, `pipeline/mock-sources.ts`):
- **Qué sustituye:** las tres fuentes, a nivel de interfaz, por `apps/api/mocks/<prefijo>.json`. Los archivos se leen en cada scan, así que editarlos no exige reiniciar.
- **Qué sigue siendo real:** identidad, reconciliación, scoring, persistencia y estados. El mock devuelve evidencia, no un resultado fijo.
- **Dominios:** el resolver solo acepta los 5 de `MOCK_DOMAINS` y no hace DNS. Cualquier otro dominio da `400 invalid_domain`.
- **Qué desactiva:** no se crean ni Apify ni el proveedor LLM, y el planner de L2 siempre es `rules`.
- **Qué no desactiva:**
  - la caché de 7 días y el rate limit;
  - **Supabase, si `STORAGE_BACKEND` no es `memory`**: el almacenamiento es independiente del modo de fuentes;
  - Chromium, que `report.pdf` sigue lanzando en local, sin red.
- **Latencia:** ninguna; todas las fuentes llevan `durationMs: 1`.

| Dominio `.arca.example` | Estado | Total / tier | Decisión |
|---|---|---|---|
| `robust` | COMPLETED | 82 FORTRESS | AUTO_BIND (HIGH) |
| `minimal` | COMPLETED | 25 EXPOSED | UNKNOWN (INSUFFICIENT_EVIDENCE) |
| `sanctioned` | COMPLETED | 72 FORTIFIED | REFERRAL_SENIOR (RECENT_SANCTION; la fecha es hoy − 30 días) |
| `partial` | PARTIAL (Avvo `error/PROVIDER_ERROR`) | 17 CRITICAL, calculado a mano | UNKNOWN (MEDIUM) |
| `failed` | FAILED, sin `result` | — | El website da `error/ACCESS_BLOCKED`; los bloques `bar` y `avvo` de `failed.json` nunca se leen |

Los tests afirman los totales 82, 25 y 72 y los estados de `robust`, `partial` y `failed` (`tests/unit/pipeline.test.ts`, `tests/integration/mock-scenarios.test.ts`).

**Lo que el mock no cubre:**
- website `partial` o timeout;
- TRUNCATED o NO_MATCH;
- identidad INSUFFICIENT con el website ok;
- `ACTIVE_INVESTIGATION` y `SUSPENDED_OR_DISBARRED`;
- `AMBIGUOUS_IDENTITY_MATCH`;
- coincidencias `fuzzy` o `cross_ref`;
- latencia.

**La imagen Docker no lleva `apps/api/mocks`**, porque el `Dockerfile` solo copia `apps/api/src` (`:18`). En un contenedor, un scan mock terminaría FAILED **[inferencia]**.

### 3.3 Layer 2: assessment adaptativo

**Ciclo de vida** (`packages/contracts/src/layer2.ts:30`):
- `PLANNING → READY → IN_PROGRESS → COMPLETED`.
- `EXPIRED` se aplica de forma perezosa al leer.
- `FAILED` está en el contrato y en el CHECK de SQL, pero **ningún camino del código lo asigna**.

**Cómo se recorre** (`apps/api/src/assessment/service.ts`):
1. **Crear** (`POST /scan/:scanId/assessment`).
   - Exige que el scan esté COMPLETED o PARTIAL y tenga `result`.
   - Si ya existe una evaluación, la devuelve: es idempotente y hay **una sola por scan para siempre**, porque `scan_id` es UNIQUE.
   - Si no existe, congela copias del banco, del `Layer1Result` y de la evidencia, crea el registro `PLANNING` con id `as_<uuid>` y agenda la planificación. Solo la agenda el creador ganador.
2. **Planificar** con un job en memoria. Hace commit CAS a `READY` con el plan, la procedencia del planner y las preguntas ya renderizadas.
3. **Responder** (`PUT .../answers/:questionId`).
   - Primero cuenta contra el límite de 120 escrituras por minuto en memoria. Se cuenta **antes** de comprobar el estado, la visibilidad y `validateAnswer`, así que esos intentos fallidos también suman. No suman los 400 de esquema, los 413 ni los 401/404, que se cortan antes (`routes.ts:60-61`).
   - Exige estado READY o IN_PROGRESS, menos de 1000 escrituras aceptadas y una pregunta visible y válida.
   - Después reconcilia: borra las respuestas que hayan quedado ocultas y emite eventos `saved` e `invalidated`. Hace CAS con hasta 12 reintentos y, si no lo logra, `409 conflict`.
4. **Completar** (`POST .../complete` con `{attestation: true}`). Exige que **todas** las preguntas visibles tengan respuesta, incluidas las informativas. Puntúa y congela el resultado; si se repite, devuelve el mismo.

**Caducidad:**
- El JWT del scan dura 24 h; pasado ese plazo, `401`.
- La evaluación caduca a las 24 h de la creación del **scan**; pasado ese plazo, `410`. Le pasa también a un COMPLETED: **el resultado deja de poder leerse a las 24 h**.

**Planner:**
- **`rules`, el default** (`packages/questions/src/planner.ts:15-25`). Con el `DEMO_BANK` siempre produce el mismo plan de 12 ítems:
  - las 8 preguntas puntuadas;
  - los seguimientos latentes D1.1a y D2.1a;
  - D3.3 y D4.2.
- **`agent`.**
  - Solo se activa con `SOURCE_MODE=live` y `ASSESSMENT_PLANNER=agent` (`server.ts:50-51`); en mock se ignora sin avisar.
  - Hace un `POST` a la URL fija `https://api.openai.com/v1/chat/completions` (`planner.ts:72`).
  - Tiene dos intentos dentro de un mismo plazo de **15 s**: `service.ts:90` pasa `15_000`, y los 10 s del planner solo son su default si no se le pasa nada.
  - Si falla o vence el plazo, cae a `rules`.
  - La validación en código solo le deja reordenar y cambiar las 2 informativas opcionales. Aporta poco a cambio de una llamada de pago.
  - El plazo no se puede configurar por entorno. Producción no fija `ASSESSMENT_PLANNER`, así que usa `rules`.
- **Recuperación.** Los registros PLANNING con más de 30 s se replanifican con reglas al arrancar (con `await`) y cada 60 s, como mucho 100 por pasada en Supabase. Un fallo determinista deja el registro en PLANNING hasta que caduca.

**Banco** (`packages/questions/src/bank.ts`):
- **Versiones y estado:** `bankVersion` `0.1.0-demo.1` y `bankStatus` `DEMO`, obligados por el esquema (`schema.ts:35`). El comentario del archivo dice "Engineering fixtures only".
- **14 preguntas en 6 dominios:**

  | Dominio | Peso | Preguntas |
  |---|---|---|
  | governance | 25 | D1.1, D1.2 (puntuadas); D1.1a (seguimiento) |
  | tools | 20 | D2.1 (puntuada); D2.1a (seguimiento) |
  | oversight | 20 | D3.1, D3.2 (puntuadas); D3.3 (informativa) |
  | data_protection | 15 | D4.1 (puntuada); D4.2 (informativa) |
  | training | 10 | D5.1 (puntuada); D5.2 (informativa) |
  | incident_preparedness | 10 | D6.1 (puntuada); D6.2 (informativa) |

  Las 8 puntuadas valen hasta 10 puntos cada una.
- **Seguimientos:**
  - D1.1a aparece si D1.1 ∈ {`written_shared`, `written_partial`, `public_only`} (`bank.ts:34`, comprobado). Como `public_only` es la sugerencia por defecto cuando W1 está detectada, en ese caso hay un PUT más.
  - D2.1a aparece si D2.1 incluye `consumer`.
- **Un usuario contesta entre 10 y 12 preguntas.**
- **Sugerencias:** D1.1 propone `public_only` (3 puntos) si `website.W1_aiPolicy.found`. No hay crédito automático ni preguntas saltadas: `skippedQuestions` siempre devuelve `[]`.
- **Evidencia:** solo 5 hechos booleanos de plantilla, con `sourceUrl: null`.

**Scoring de L2** (`packages/scoring/src/layer2.ts`):
- **Dominio:** suma de sus preguntas puntuadas, normalizada a 100.
- **`layer2Score`:** Σ score × peso / 100.
- **`compositeScore`:** 0,3 × L1 + 0,7 × L2, marcado como demo.
- **`tier`:** las mismas bandas que L1.
- **`decision`:** `restrictDecision('UNKNOWN', overrides de L1)`, así que **nunca hay AUTO_BIND**.
- **Flags:** siempre `DEMO_BANK_NOT_APPROVED`, `DEMO_COMPOSITE_FORMULA` y `COMMERCIAL_DECISION_BLOCKED`, más las que añadan las respuestas.
- **Plan de acción:** el "siguiente escalón" de cada pregunta puntuada, con su ganancia en puntos del compuesto.

### 3.4 Superficie HTTP y modelo de seguridad

| Método y ruta | Auth | Qué hace | Notas |
|---|---|---|---|
| `GET /health` | — | `{status:'ok'}` fijo | No comprueba Supabase ni dice en qué modo corre. Lo usan Docker, Caddy y el workflow. |
| `GET /openapi.json`, `GET /docs` | — en la API | OpenAPI 3.1 y Swagger UI | El basic auth solo lo pone Caddy en producción. Los assets de Swagger se cargan desde jsDelivr en el navegador. |
| `POST /scan` | **Pública** | Crea un scan o sirve la caché | `200` (caché COMPLETED), `202`, `400`, `429` con `Retry-After`. No comprueba `Content-Type` y no tiene límite de cuerpo en la API (Caddy corta a 32 KB). |
| `GET /scan/:scanId` | Bearer del scan | Polling | `200`, `401`, `404`. Sin `Cache-Control: no-store`. |
| `GET /scan/:scanId/report.pdf` | Bearer | PDF del Quick Scan | **Un Chromium nuevo por petición y sin rate limit.** `409 report_unavailable` si no hay resultado. |
| `POST /scan/:scanId/assessment` | Bearer | Crea o reanuda | `202`/`200`; `401` también si el scan no existe; `409 scan_not_ready`; `410`. |
| `GET /assessment/:id` | Bearer del scan dueño | Vista | `404` se comprueba antes que la pertenencia; `410`. |
| `PUT /assessment/:id/answers/:questionId` | Igual | Guarda una respuesta | `400`, `409` (`not_visible`, `not_ready`, `already_completed`, `conflict`), `413` (más de 16 KiB), `429`. |
| `POST /assessment/:id/complete` | Igual | Atestar y puntuar | Idempotente. |
| `GET /assessment/:id/result` | Igual | Resultado guardado | `409 incomplete`. |
| `OPTIONS *` | — | Preflight de CORS | — |
| Ruta desconocida | — | `404 Not Found` en **texto plano** | No sigue el JSON de error del contrato. |

**No existe ningún endpoint de debug, admin, seed ni reset** **[código]**.

**Modelo de autorización.** Es una capability por scan; no hay cuentas.
- `POST /scan` no verifica el email ni la propiedad del dominio (lo dice `README.md:58-59`). Un cache hit le entrega a un tercero el resultado de otro solicitante, re-sellado con el email del tercero.
- El token es un JWT HS256 con `sub`=scanId, `email`, `iss`=`arca-api` y `aud`=`arca-scan`, y dura 24 h. No lleva `jti` ni claim de entorno. No se puede revocar salvo rotando `SESSION_TOKEN_SECRET`.
- Las lecturas exigen que `sub` coincida con `:scanId` y que el `email` coincida con el del registro.
- Las rutas de assessment exigen que `record.scan_id` coincida con `sub` y que el email coincida.

**Rate limits:**

| Alcance | Límite | Dónde vive |
|---|---|---|
| `POST /scan` | 10 por IP y hora, 3 por email y hora | Memoria del proceso; no se puede configurar |
| Escrituras de assessment | 120 por minuto | Memoria |
| Escrituras aceptadas por assessment | 1000 en total | Servicio y SQL |
| Lecturas y `report.pdf` | Sin límite | — |

**IP del cliente.** Sale de `TRUST_PROXY_HOPS`: 0 en local (el socket) y 1 en producción (la última entrada de XFF, que añade Caddy). Si algo llama a `app.fetch` sin pasar por `serve`, la IP es `'unknown'` y todas esas peticiones comparten un mismo cupo.

**CORS.**
- Lista exacta de orígenes, sin `credentials`.
- Métodos `GET`, `POST`, `PUT` y `OPTIONS`.
- Expone solo `Retry-After` y `Content-Disposition`.
- **Producción admite `http://localhost:3000`** (`deploy/production.env:19`).

**Red saliente y SSRF** (`pipeline/network.ts`):
- solo `http` y `https`, sin credenciales en la URL y solo puertos 80 y 443;
- solo IPs unicast públicas, fijadas en el socket;
- respuestas de 5 MB como máximo y 5 redirecciones revalidadas;
- el crawler pasa todas sus peticiones por ese transporte.

**Escapado de contenido de terceros.** El PDF escapa el contenido rastreado (`report/quick-scan.ts:7-8`) y Chromium lo renderiza con JS desactivado y todas las peticiones abortadas. El front no usa `dangerouslySetInnerHTML`.

**Errores.** `onError` registra solo `error.message` y responde `500 internal_error` genérico. El sub-app de assessment tiene su propio `onError`.

**Ni la API ni el front ponen cabeceras de seguridad ni CSP.** En producción, Caddy añade HSTS, `nosniff` y `Referrer-Policy`, y quita `Server`.

### 3.5 Configuración y variables de entorno

**Carga y precedencia.**
- `server.ts:22-23` carga `Arca-back/.env.local` con `process.loadEnvFile` si existe.
- **Las variables del shell ganan, incluso las vacías.** El crítico lo verificó con Node 22.19.0. Dos consecuencias:
  - exportar `SOURCE_MODE=mock` y `STORAGE_BACKEND=memory` en el shell sí se impone al `.env.local`;
  - un `SOURCE_MODE=` vacío en el shell **rompe el arranque**, porque el enum de zod rechaza `''`.
- El esquema (`apps/api/src/config/env.ts:3-47`) no es `.strict()`: **una variable mal escrita se descarta sin aviso** y entra el default.
- `loadEnv` devuelve el objeto completo, con los secretos dentro (`env.ts:74`).

**Obligatorias por modo** **[código]**:

| Cuándo | Variables |
|---|---|
| **Siempre**, también en mock/memory | `SESSION_TOKEN_SECRET` (al menos 32 caracteres) y `CORS_ALLOWED_ORIGINS` (`env.ts:16,23`) |
| `STORAGE_BACKEND=supabase` | `SUPABASE_URL` y `SUPABASE_SECRET_KEY` (o la legacy `SUPABASE_SERVICE_ROLE_KEY`; se rechaza una clave `sb_publishable_`) |
| `SOURCE_MODE=live` | `APIFY_API_TOKEN`, más `OPENAI_API_KEY` si el proveedor no es `rules` o si el planner es `agent` |
| Fuera del esquema | Chromium de Playwright instalado: para el crawl en live y para `report.pdf` en cualquier modo |

**Variables que importan:**

| Variable | Default | Efecto |
|---|---|---|
| `SOURCE_MODE` | `live`, o `mock` si `MOCK_MODE=true` | Todo o nada: no hay modo mixto. |
| `STORAGE_BACKEND` | `supabase`, o `memory` si `MOCK_MODE=true` | Independiente del anterior. |
| `MOCK_MODE` | — | Legacy: solo cambia los dos defaults de arriba. |
| `WEBSITE_EVIDENCE_PROVIDER` | **`agentic`** | `agentic`, `openai` (`gpt-4o-mini`, una pasada) o `rules` (sin LLM, pero sigue rastreando). Se ignora en mock. |
| `SIGNAL_LLM_MODEL` | `gpt-6-luna` | Modelo del extractor y del planner agente. |
| `SIGNAL_LLM_REASONING_EFFORT` | — | Solo para modelos de razonamiento; el planner no lo usa. |
| `ASSESSMENT_PLANNER` | `rules` | `agent` solo actúa en live. |
| `PIPELINE_TIMEOUT_MS` | 600 000 | Presupuesto del pipeline; +120 s es el umbral de recuperación. |
| `SCAN_CACHE_TTL_MS` / `SCAN_PARTIAL_REPAIR_COOLDOWN_MS` | 7 días / 1 h | El TTL tiene que ser > 0. |
| `MAX_APIFY_CONCURRENCY` | 16 | Limita la concurrencia, **no el gasto**. |
| `APIFY_ACTOR_BUILD` | `latest` | Sin fijar. |
| `APIFY_EXPECTED_COST_USD_PER_RUN` | 1 | Reserva contable, **no es un tope**. |
| `TRUST_PROXY_HOPS` | 0 | Producción usa 1. |
| `NODE_ENV` | `development` | **Se valida pero ningún código la lee.** No distingue dev de producción. |

**Defaults peligrosos.** Sin `SOURCE_MODE`, `STORAGE_BACKEND` ni `MOCK_MODE`, el back arranca en **`live` + `supabase`** (`env.ts:50-51`). Para producción es la dirección segura; para desarrollo, la cara.

**Variables fuera del esquema que cambian el destino del tráfico.** El SDK `openai` lee de `process.env` `OPENAI_BASE_URL`, `OPENAI_ORG_ID` y `OPENAI_PROJECT_ID`, entre otras. Los extractores lo instancian sin `baseURL` (`agentic-evidence-provider.ts:162`, `website-evidence-provider.ts:38`), así que **esas variables pueden redirigir la extracción y su API key**. El planner no se ve afectado, porque tiene la URL fija.

**El `.env.local` del back hoy** (solo nombres y valores de modo):
- **Con valor:** `NODE_ENV`, `PORT`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_TOKEN_SECRET`, `APIFY_API_TOKEN`, `NVIDIA_NIM_API_KEY`, `OPENAI_API_KEY`, `CORS_ALLOWED_ORIGINS`, `SOURCE_MODE`, `STORAGE_BACKEND`, `TRUST_PROXY_HOPS`, `SIGNAL_LLM_ENDPOINT` y `SIGNAL_LLM_MODEL`.
- **Modos:** `SOURCE_MODE=live`, `STORAGE_BACKEND=supabase`, `NODE_ENV=development` y `TRUST_PROXY_HOPS=0`. `WEBSITE_EVIDENCE_PROVIDER` y `ASSESSMENT_PLANNER` no están, así que valen `agentic` y `rules`.
- **`NVIDIA_NIM_API_KEY` y `SIGNAL_LLM_ENDPOINT` están muertas:** ningún código las lee desde `21410dd`. Una de ellas es un secreto vivo que no se usa.
- `SUPABASE_URL` es **igual** a la que está versionada en `.env.example:5` (se comparó sin imprimirla).
- **Los tres documentos que dicen cómo desarrollar piden mock/memory** (`README.md:24-25`, `.env.example:24-25` y `Arca-front/docs/implementation/layer2-isolated-demo.md:27`). El `.env.local` real no lo sigue.

**Producción:**
- **`deploy/production.env`**, versionado y copiado dentro de la imagen: `NODE_ENV=production`, `SOURCE_MODE=live`, `STORAGE_BACKEND=supabase`, `WEBSITE_EVIDENCE_PROVIDER=agentic`, `SIGNAL_LLM_MODEL=gpt-6-luna`, `CORS_ALLOWED_ORIGINS` (`https://arcacover.com`, `https://staging.arcacover.com` y `http://localhost:3000`), `TRUST_PROXY_HOPS=1`, `APIFY_ACTOR_BUILD=latest`, y los límites y TTL.
- **Secretos en SSM `/arca/prod/*`:** obligatorios `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_TOKEN_SECRET`, `APIFY_API_TOKEN` y `DOCS_AUTH_HASH`, más `OPENAI_API_KEY` si el proveedor no es `rules`.
- **`render-env.py`**:
  - aborta si una clave está en los dos sitios o si el hash no es bcrypt;
  - **acepta cualquier otro parámetro** de `/arca/prod` cuyo nombre cumpla `^[A-Z][A-Z0-9_]*$` (§10).
- **No hay ninguna guarda en código entre producción y mock.** Si producción arrancara en mock, fallaría por casualidad: los dominios reales darían 400 y los fixtures no están en la imagen. El chequeo de después del deploy solo pide `/health`, que responde `ok` en cualquier modo.

### 3.6 Almacenamiento

**Supabase** (`supabase/migrations/`):

| Migración | Contenido |
|---|---|
| `20260908151940_create_layer1.sql` | Tablas `scans` y `scan_raw_data`; RLS; se revoca a `anon` y `authenticated`; `grant all` a `service_role` |
| `20260912231500_cache_partial_scans.sql` | Índice de la caché que admite PARTIAL |
| `20260914234000_apify_run_ledger.sql` | Tablas `apify_runs` y `scan_apify_runs`; RPC `reserve_apify_run` |
| `20260921120000_record_apify_spend_without_capping.sql` | Quita los topes de gasto: registrar sin limitar |
| `20261013030000_layer2_assessments.sql` | Tablas `assessments` (con `scan_id` UNIQUE e instantáneas jsonb) y `assessment_answer_events` (solo admite añadir); triggers de inmutabilidad; RPC `create_assessment` y `update_assessment`. **`service_role` solo tiene `SELECT`**: las RPC son la única vía de escritura (`:241-246`) |

- **La API usa la clave de servicio, que se salta RLS.** Cada petición tiene un timeout de 5 s.
- **Ninguna tabla tiene columna de entorno.** Los scans `*.arca.example` de un proceso mock con Supabase se mezclan con los reales.
- **Las migraciones se aplican a mano** con `npm run db:push`, que necesita la CLI de `supabase`; no está en devDependencies. Ningún workflow las aplica.
  - **No está verificado si la migración de Layer 2 está aplicada en el proyecto real.** Según **[notas]**, se aplicó a mano el 2026-10-16.
  - `db:verify` no comprueba las tablas de L2.
  - Si no estuviera aplicada, crear un assessment daría `500`.
- **Arranque.** `server.ts:29` y `:57` esperan a Supabase antes de `serve()`. Si el proyecto está pausado (plan gratuito que se pausa solo, según **[notas]**), el proceso no arranca.
- **Validación.** El adaptador de assessments no valida con zod lo que lee de la base: hace un cast.
- **"Reiniciar" un assessment no se puede en Supabase**, por el UNIQUE y por los permisos de solo lectura. Solo se puede en `memory` o creando un scan nuevo.
- **`supabase/config.toml:67-70` apunta a `./seed.sql`, que no existe.**

**Memoria** (`STORAGE_BACKEND=memory`):
- Cubre scans, el ledger de Apify y los assessments, con las mismas invariantes que el SQL (CAS, un evento `saved` por commit, tope de 1000).
- Todo se pierde al reiniciar, y `tsx watch` reinicia con cada edición. Los tokens que queden en `sessionStorage` reciben 404 y el front vuelve a `/quote`.
- Los Maps crecen sin desalojo.

---

## 4. Front

### 4.1 Mapa de rutas y recorrido

| Ruta | Tipo | Llamadas al back |
|---|---|---|
| `/` | Server, con hijos cliente | — |
| `/coverage`, `/industries/legal` | Server | — |
| `/partners`, `/platforms` | Server; el formulario es cliente | — (solo `console.log`) |
| `/quote` | Cliente | `POST /scan` |
| `/quote/scanning?scan=` | Cliente + Suspense | `GET /scan/:id` en polling |
| `/score?scan=` | Cliente + Suspense | `GET /scan/:id`, `report.pdf` y la precarga `POST /scan/:id/assessment` |
| `/assessment?scan=&a=` | Cliente + Suspense | `POST` de creación, `GET`, `PUT` de respuestas y `POST complete` |
| `/assessment/results?scan=&a=` | Cliente + Suspense | `GET /assessment/:id/result` |

No hay `error.tsx`, `not-found.tsx`, `loading.tsx`, `middleware.ts`/`proxy.ts` ni Route Handlers. "My account" es `href="#"`.

**Recorrido:**
1. **`/quote`.**
   - Valida el email y la lista de proveedores de correo, que debe coincidir con `PERSONAL_EMAIL_DOMAINS` del back.
   - Llama a `startScan` y guarda el token.
   - Si la respuesta es COMPLETED (caché), va directa a `/score`; si no, a `/quote/scanning`.
   - **Cualquier error no previsto muestra `error.message` tal cual** (`app/quote/page.tsx:100`). Eso incluye `misconfigured` y `contract`, que son mensajes para desarrolladores.
2. **`/quote/scanning`.**
   - Sondea cada 2 s mientras el tiempo esperado sea menor de 30 s, y luego cada 5 s.
   - A los 60 s muestra "taking a little longer" y **abandona a los 660 s**.
   - Con 401 o 404 vuelve a `/quote`.
   - **Cualquier otro error, incluidos `contract` e `internal_error`, se trata como un corte de red y se reintenta cada 5 s durante 11 minutos** (`scanning/page.tsx:123-127`).
3. **`/score`.**
   - Hace un solo poll y adapta el resultado con `lib/api/adapt.ts`: 4 categorías y el tier que da la API.
   - Muestra el aviso de evidencia incompleta y la descarga del PDF.
   - `RefineCta` precarga el assessment al montar, sin avisar si falla.
4. **`/assessment`.**
   - En PLANNING reintenta cada 1,2 s hasta 45 s.
   - Guarda solo al pulsar "Continue" o "Save change"; la vista que devuelve el servidor sustituye a la lista.
   - Termina con una revisión y una atestación obligatoria.
5. **`/assessment/results`.**
   - Muestra el compuesto, L1 y L2, 6 dominios, el plan de acción, los flags y las versiones.

**Ramas que el back nunca alimenta:** el front maneja `planning_failed`, `assessment_exists` y el estado `FAILED` del assessment, y el back no emite ninguno de los tres.

### 4.2 Cliente API (`lib/api/client.ts`)

- **Un único cuello de botella de red:** `send()` (`:108-121`), con `AbortSignal.timeout(15000)`. Cualquier excepción se convierte en `ApiError("network")`.
- **Validación de respuestas:** cada respuesta OK se valida con el esquema zod de `@arca/contracts` (`parse()`, `:125-134`). Como son `.strict()`, **un campo extra en el back rompe el front** con el error `contract`.
- **Códigos de error:** los 18 del servidor más tres de cliente: `network`, `contract` y `misconfigured`.
- **Reintentos:** el cliente no reintenta nunca; lo hacen las páginas.
- **URL base:** `baseUrl()` exige `NEXT_PUBLIC_API_URL` y, si no está, lanza `misconfigured`. **No hay fallback en ningún entorno.** El fallback a `api.arcacover.com` existió entre `226fb02` (09-30) y `a741a2b` (10-12).

### 4.3 Dónde vive el estado

| Dato | Dónde | Vida |
|---|---|---|
| `sessionToken` del scan (capability Bearer) | `sessionStorage`, clave `arca.scan.<scanId>`, en claro | La pestaña; el servidor lo caduca a las 24 h |
| Id del assessment | `sessionStorage`, `arca.assessment.<scanId>` = `{assessmentId, expiresAt}` | La pestaña; tope de 24 h |
| `scanId` / `assessmentId` | URL (`?scan=`, `?a=`) | El historial |
| Email y dominio | Estado React de `/quote` y el body del POST | Nunca en la URL ni en storage |
| Borradores y atestación | Estado React | Hasta pulsar "Continue" |
| localStorage / cookies | No se usan | — |

No hay estado global: cada página usa `useState` local, y abrir otra pestaña reinicia el embudo. **El JWT lleva el email en un payload decodificable.**

### 4.4 Variables de entorno

| Variable | Dónde se lee | Notas |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `lib/api/client.ts:21` | Obligatoria y se incrusta en el build. En `.env.local` tiene valor y apunta a un host local. `.env.example` trae `http://localhost:8080`. |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx:24,36` | El default `https://arcacover.com` se aplica con `??`, y `??` no salta con un string vacío. **`.env.example:14` la deja vacía**, y `layer2-isolated-demo.md:22` manda copiar `.env.example`. `new URL('')` lanza error y rompe todas las páginas. Hoy no pasa porque el `.env.local` no la define. |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | `lib/supabase.ts` | Código muerto: nadie lo importa. |
| `NODE_ENV` | Solo en los tests | Ya no cambia nada en la app. |
| `ARCA_FRONTEND_URL`, `ARCA_API_URL`, `ARCA_ARTIFACT_DIR`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Solo `scripts/assessment-browser-smoke.mjs` | — |

### 4.5 Suposiciones de despliegue

- **Vercel no tiene nada en el repo:** ni `vercel.json`, ni `.vercel/`, ni `.github/`. La configuración vive en el dashboard. Según **[notas]**, el proyecto de Vercel de `arcacover.com` no está en la cuenta conectada.
- **Requisitos del build actual:**
  - el checkout hermano `../Arca-back` con `packages/contracts/dist` compilado;
  - `NEXT_PUBLIC_API_URL` definida, porque cambiarla obliga a recompilar.

  Un build que solo clone Arca-front fallaría al resolver `file:` **[inferencia]**.
- **Las previews de Vercel quedan fuera de CORS** (spec 2026-09-21, D4).
- **Puertos y CORS no cuadran:**
  - `layer2-isolated-demo.md:27` usa `127.0.0.1:3001`;
  - el CORS de `.env.example` del back solo admite `localhost:3000`;
  - `.claude/launch.json` usa el 3000.
- **`next/font/google`** (`app/layout.tsx:3`) descarga Space Grotesk y Mulish de Google durante `next dev` y `next build`. Es la única llamada externa del front aparte del enlace a Calendly.
- **La carpeta `.next/` local tiene un build del 2026-09-30,** anterior a Layer 2. Un `npm start` sin recompilar sirve código viejo.
- **Turbopack.** Según **[notas]**, con la raíz en `C:\Users\jesus\projects` se colgó en dev. Se usa `npm run dev -- --webpack`.

### 4.6 Lo que ya hay de mock, fixture o demo

- **Fixtures de test:** `lib/api/fixture.ts` y `lib/test-fixtures/assessment.ts`, que solo importan los tests. `fixture.ts` usa `smithlaw.com`, un dominio de apariencia real, mientras el back usa `*.arca.example`.
- **Smoke de navegador:** `scripts/assessment-browser-smoke.mjs`. Lanza Playwright con una API sintética interceptada, bloquea la red no local e inyecta el token en `sessionStorage`. Es el único precedente de "API falsa sin back".
- **Rotulación "DEMO" de Layer 2:** la píldora "DEMO WORKSPACE", `DemoNotice` y los textos "Demo business rules". Va en producción por diseño.
- **No existe** ningún panel de debug, feature flag, `?debug` ni rama por `NODE_ENV`.

---

## 5. Infra, deploy y CI: estado real

### 5.1 Cómo está diseñado (cuando está levantado)

- **Host:** una EC2 `t3.medium` en `us-east-1`, con Amazon Linux 2023, IMDSv2 obligatorio y EBS cifrado. Está definida en el stack CDK `ArcaDemoStack` (`infra/aws/lib/arca-demo-stack.ts`).
- **Acceso y red:** Elastic IP, sin ALB, NAT ni SSH; la administración va por SSM. El security group solo abre 80, 443 y 443/udp.
- **Imágenes:** ECR `arca-demo`, con lifecycle de 20 imágenes, que es la ventana de rollback.
- **Rol del host:** `AmazonSSMManagedInstanceCore`, pull de ECR y `ssm:GetParametersByPath` sobre `/arca/prod`.
- **Despliegue desde GitHub:** OIDC con el rol `arca-github-deploy`, que solo se puede asumir desde `main` de `ArcaCover/Arca-back`.
- **Alarmas:** dos de status check (`recover` y `reboot`) con SNS.
- **Compose** (`compose.yaml`):
  - `api`: solo `expose 8080`, raíz de solo lectura, `cap_drop ALL` y `shm` de 512 MB;
  - `proxy`: Caddy 2.10.2 fijado por digest. Hace TLS automático, corta el body a 32 KB, añade cabeceras y pone basic auth en `/docs` y `/openapi.json`.
- **Dominio:** `api.arcacover.com`. El registro A se crea a mano en Vercel.
- **El nombre "demo" designa producción:** ECR `arca-demo`, `.env.demo`, `DEMO_HOSTNAME`. Ojo al leer DN-09, que introduce sus propias etiquetas.

### 5.2 Pipeline de deploy (`.github/workflows/deploy-api.yml`)

- **Disparadores:**
  - push a `main` que toque `apps/**`, `packages/**`, `deploy/**`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `package.json` o `package-lock.json` de la raíz, `tsconfig*.json` o el propio workflow;
  - `workflow_dispatch` con `image_tag`, para hacer rollback.
  - **No lo disparan** `infra/**`, `supabase/**` ni `scripts/**`.
- **Job `test`:** `npm ci` (raíz e `infra/aws`), Chromium, `typecheck` y `test`.
- **Job `deploy`:** solo si existe `vars.AWS_DEPLOY_ROLE_ARN`.
  1. Construye la imagen con la etiqueta del SHA y la sube a ECR.
  2. Lanza `ssm send-command` → `deploy-image.sh` → `activate.sh`.
  3. `activate.sh` lee **todo** `/arca/prod`, genera `.env.demo` con `render-env.py`, ejecuta `docker compose up --wait` y limpia las imágenes.
  4. El workflow termina con `curl $DemoUrl/health`.
- **Imagen:** `node:22-bookworm-slim` fijada por digest y multi-stage. Lleva Chromium, corre como usuario `node` y tiene `HEALTHCHECK /health`. **No incluye `apps/api/mocks/`.**

### 5.3 Estado a 2026-10-23

| Hecho | Evidencia |
|---|---|
| `api.arcacover.com` resuelve, pero `/health` agota el tiempo | **[red]**, hoy |
| `arcacover.com` responde 200 | **[red]**, hoy |
| `AWS_DEPLOY_ROLE_ARN` no existe; el job `deploy` se salta | **[GitHub]**: `gh variable list` vacío; el run de `5123b00` tiene `test` en success y `deploy` en skipped |
| Último deploy con éxito: 2026-10-01, `ae8c143` (PR #11) | **[GitHub]** |
| Layer 2 (`f78828a`, fusionado en `5123b00`) nunca se desplegó | **[GitHub]** |
| Stack, EIP y ECR borrados el 2026-10-02 con `arca-aws.ps1 down`; se conservan 6 secretos en `/arca/prod`, `CDKToolkit` y el usuario IAM; el DNS apunta a la IP vieja | **[notas]**. Encaja con `arca-aws.ps1:276-292`, que borra el ECR y la variable de GitHub |
| Las imágenes de rollback ya no existirían | **[inferencia]** a partir de lo anterior |

**Volver a levantar** con `scripts/arca-aws.ps1 up` (PowerShell 5.1, perfil `arca-deploy`):
1. Sube los secretos a SSM.
2. Ejecuta `cdk deploy` con `--require-approval broadening`.
3. Comprueba el DNS.
4. **Fija `AWS_DEPLOY_ROLE_ARN`**, lo que reactiva el auto-deploy.
5. Lanza el workflow.

Implica una IP nueva y cambiar el registro A en Vercel. Las políticas de CDK y del usuario de despliegue tienen un `Deny` explícito sobre billing, budgets y account.

### 5.4 Qué comprueba el CI y qué no

| Comprueba | No comprueba |
|---|---|
| `typecheck` (`tsc -b`) y `npm test` en push a `main` (Node 22) | **Ningún trigger `pull_request`.** #6 y #7 se fusionaron y los tests fallaron después del merge |
| `contracts-release.yml` con tag `contracts-v*` (Node 20) | Lint o formato: no hay eslint ni prettier en el back |
| — | Cobertura, `test:container` y `cdk synth --strict` |
| — | Aplicación o comprobación de migraciones |
| — | Dependabot. Las actions están fijadas por tag mayor (`@v4`), no por SHA |
| — | **El front no tiene ningún CI** |

---

## 6. Tests

### 6.1 Back (42 archivos; 387 tests en verde en CI el 2026-10-16 **[GitHub]**)

| Área | Archivos | Casos aprox. | Requisitos |
|---|---|---|---|
| `apps/api/tests/unit` | 25 | ~206 | Nada externo: los clientes de Apify, Supabase y OpenAI reciben un `fetch` inyectado |
| `apps/api/tests/integration` | 8 | ~56 | `crawler` y `site-access` necesitan Chromium real (con transporte de fixtures, sin red). `database` y `assessment-database` usan PGlite en proceso y aplican todas las migraciones. `flow`, `mock-scenarios` y `assessment` usan HTTP en proceso |
| `packages/contracts/tests` | 3 | ~15 | — |
| `packages/scoring/tests` | 4 | ~40 | — |
| `packages/questions/tests` | 1 | ~12 | — |
| `infra/aws/lib/arca-demo-stack.test.ts` | 1 | 7 | `npm ci --prefix infra/aws` |

**Ningún test hace llamadas de red reales.**

**Ojo con `dist`.** `vitest.config.ts:6` usa la condición `development` con el comentario "without requiring a build first". Pero desde `5f3efb8` los paquetes exponen la fuente bajo `arca-source`, así que los tests resuelven `@arca/*` a `dist/`. En CI funciona porque `typecheck` emite `dist` antes. **En local, con un `dist` viejo, los tests prueban contratos desactualizados.**

**Cobertura:** v8, solo sobre `packages/scoring/src` y `apps/api/src`. `contracts` y `questions` quedan fuera.

### 6.2 Front (9 archivos, unas 89 declaraciones `it`)

| Archivo | Cubre |
|---|---|
| `lib/api/client.test.ts` | Base URL obligatoria; `downloadReport` |
| `lib/api/assessment-client.test.ts` | Endpoints de L2, timeout, deriva de contrato, errores tipados, `Retry-After` |
| `lib/api/assessment-session.test.ts` | Caducidad a 24 h, storage bloqueado, que no use localStorage |
| `lib/api/adapt.test.ts`, `lib/signals-view.test.ts` | Adaptación de `/score` y señales |
| `lib/email-providers.test.ts`, `lib/assessment.test.ts` | Helpers |
| `lib/question-card.test.tsx` (jsdom) | Los 5 tipos de pregunta |
| `lib/assessment-flow.test.tsx` (jsdom) | `/assessment`, `/results` y la navegación score→assessment con el cliente mockeado |

- **Sin cubrir:** `/quote`, el polling de `/quote/scanning`, `startScan`/`pollScan`, `lib/api/session.ts` y las páginas institucionales.
- **Recuento:** `layer2-isolated-demo.md:65` habla de "154 tests" contando los `it.each` expandidos **[doc]**; no se ejecutó.
- **Lint:** `react-hooks/set-state-in-effect` está en `warn`, con 6 avisos **[doc]**.

Cómo ejecutarlos, en §11.

---

## 7. Catálogo de documentación

Los estados son: **vigente** (coincide con el código), **parcial** (mezcla lo vigente con lo superado), **superado** (el código o una decisión posterior lo sustituyó) e **histórico** (registro de un momento; no hay que actualizarlo).

### Arca-back

| Documento | Fecha | Estado | Nota |
|---|---|---|---|
| `README.md` ("ARCA — Layer 1") | Sin fecha; última sección del 2026-10-12 | parcial | Bien: mocks 82/25/72, caché de 7 días, gasto sin tope y rutas de L2. Mal: proveedor por defecto `rules`, presupuesto de 55 s, crawl de 20 s, muestreo de directorios, CORS sin staging; falta `report.pdf`; el título dice solo "Layer 1". |
| `DN-01-layer1-handbook-resolution.md` | 2026-09-05 | parcial | Siguen vigentes el principio de incertidumbre, `status`/`dataStatus` y W10 fuera. Superado: retirar L2, muestra de 15, actor de Avvo, caché de 24 h, mocks 84/25/74, `200 UNRESOLVED` y "los overrides no tocan el score". |
| `DN-02-2026-09-09-contract-avvo-scoring.md` | 2026-09-09 | parcial | Implementado en lo funcional. Superado: caché de 24 h. Pendiente: si REFERRAL debe cambiar el tier. |
| `DN-03-provider-agnostic-layer1.md` | 2026-09-12 | parcial | El núcleo determinista existe. Superado: el default `rules` y que "live no exige OpenAI". |
| `DN-04-live-evidence-hardening.md` | 2026-09-12 | parcial | La mayoría está implementada. Superado: el párrafo de topes de gasto y las "dos ejecuciones simultáneas". |
| `DN-05-agentic-signal-extraction.md` | 2026-09-12 | superado | Proveedor NVIDIA retirado en `21410dd`. La arquitectura está implementada en parte sobre OpenAI. **Los gates del §12 no se cumplieron**, y aun así `agentic` es el default. |
| `DN-05-review.md` | 2026-09-12 | histórico | Revisión adversarial con los hallazgos R01 a R15. En código siguen abiertos R05 (no hay deadline por fase), R08 (estado según `crawl.partial`) y R13 (ruta `openai` sin revisión). |
| `DN-05-evaluacion-2026-09-13.md` | 2026-09-13 | histórico | Evaluación con Duque y Gallardo. Gate no superado. Latencia de 338 a 618 s por corrida. |
| `DN-05-plan-harness-agentico.md` | 2026-09-13 | histórico | Implementado (commits `1cb73f0` a `f726f10`), pero las casillas siguen sin marcar y usa nombres NVIDIA. |
| `DN-06-apify-cost-quality-plan.md` | 2026-09-14/15 | parcial | Siguen el ledger, el pipeline de 10 min y los límites 25/10. **Los topes se revirtieron el 2026-09-21.** Pendientes en el §8. |
| `DN-07-crawl-coverage-and-grounded-negatives.md` | 2026-09-23 | vigente | Implementado. Diverge en `privacy_policy`: el doc dice `false`; el código fija `found:true`, "never false". |
| `DN-07-layer2-adaptive-assessment.md` | 2026-10-08 | superado | Dice "Nada implementado". Lo sustituye la implementación demo (`f78828a`), con desviaciones deliberadas: sin `skipWhen`, banco de 14, compuesto 30/70 y `scan_id` UNIQUE. Sus pendientes de negocio (§11) siguen vivos. |
| **Colisión DN-07** | — | — | **Hay dos DN-07.** `LAYER2_ASSESSMENT.md:3` cita "DN-07" sin decir cuál. Además, DN-05 tiene cuatro documentos bajo el mismo número. |
| `DN-08-estado-del-proyecto-2026-10-23.md` (esta nota) | 2026-10-23 | vigente | Foto fija previa a DN-09. Sin versionar. |
| `DN-09-modos-mock-y-live-debug.md` | 2026-10-23 | borrador | Diseño pendiente de aprobación. Sin versionar, en `feat/arca-modes`. |
| `LAYER2_ASSESSMENT.md` | ~2026-10-12/13 | vigente | Coincide con el código: 5 rutas, 15 s, 30 s, 120/1000, 16 KiB, 24 h. Matices: dice que las migraciones las aplica "el workflow de despliegue" (falso); el plazo de 15 s no se puede configurar; no menciona el 410 de un COMPLETED. |
| `deployment/AWS_DEMO_RUNBOOK.md` | 2026-09-29 | parcial | Coincide con el código de infra, pero el stack no existe hoy. **Las líneas 93-94 llevan emails de alerta en claro.** |
| `deployment/DEMO_CONTAINERIZATION_SPEC.md` | Sin fecha | parcial | Los artefactos están implementados. "AWS provisioning pending" está desfasado. La aceptación del §8 (puntos 3 a 8) sigue abierta. "Validación del contenedor solo en mock": el smoke nunca escanea. |
| `reports/e2e-apify-duque-gallardo-2026-09-15.md` y su `.pdf` | 2026-09-15 | histórico | Duque terminó FAILED y Gallardo PARTIAL (score 11). Avvo costó USD 2,14. De sus correcciones, 3 se hicieron; Avvo en una segunda etapa no. |
| `superpowers/plans/2026-09-24-crawl-robustness-and-grounded-signals.md` | 2026-09-24 | histórico | Implementado, con todas las casillas en `[x]`. Cita nombres NVIDIA. |

### Arca-front

| Documento | Fecha | Estado | Nota |
|---|---|---|---|
| `CLAUDE.md` | Vivo; la última sección es del 2026-10-13 | parcial | La sección final ("Isolated Layer 2 prototype") es la más fiable, aunque dice que los repos originales no cambian y sí cambiaron. El cuerpo está desfasado: tarball de contratos, fallback a producción, L2 "mock", `lib/mock/assessment-*`, `lib/types/`, `tierForScore`, "21 TODO" (hay 13), "`packages/questions` vacío", "banco de 20", "<60 s" y el tier `UNKNOWN` en L1. |
| `docs/copy-deck.md` | 2026-08-28 | superado | El CTA del hero, el email del footer y el número de secciones ya no coinciden. La tabla "Qué no puede salir así" sigue siendo útil. |
| `docs/superpowers/specs/2026-09-21-arca-front-layer1-integration-design.md` | 2026-09-21 | vigente | Implementado, pero su línea de estado dice "pendiente de plan". Desviación: el front abandona a los 660 s y el spec dice "no abandona". |
| `docs/implementation/layer2-isolated-demo.md` | ~2026-10-13 | parcial | El contenido es correcto. Se declara "aislado" y está fusionado. Manda copiar `.env.example`, con lo que `NEXT_PUBLIC_SITE_URL` queda vacía. Usa el puerto 3001, que no está en el CORS por defecto. |

---

## 8. Pendientes consolidados

La prioridad es mi criterio (Alta, Media o Baja). La columna "Fuente" indica dónde está documentado o, si no lo está, dónde se ve en el código.

### Infra y operación

| Prio | Pendiente | Fuente |
|---|---|---|
| Alta | Decidir si se vuelve a levantar producción, cuándo y con qué checklist: IP y DNS, rollback sin imágenes, auto-deploy que se reactiva, migración de L2 y Supabase activo | `deploy-api.yml:64-66`; `arca-aws.ps1:276-292`; §5.3 |
| Alta | Separar el Supabase de desarrollo del de producción | Recomendación de DN-09 §10; `.env.example:5` |
| Alta | Meter las migraciones en el proceso de deploy, o al menos verificarlas; confirmar que la de L2 está aplicada en la base real | `LAYER2_ASSESSMENT.md:76-77,95-97`; `apps/api/scripts/verify-supabase.ts` |
| Alta | CI en `pull_request` para el back y algún CI para el front | `deploy-api.yml:6-8`; el front no tiene `.github/` |
| Media | Publicar los contratos 0.2.0 (tag) y decidir cómo los instala el front en Vercel: `file:` o tarball | `Arca-front/package.json:16`; `contracts-release.yml`; `CLAUDE.md:142` |
| Media | Aceptación del despliegue: HTTPS, Supabase desplegado, scan pagado preaprobado, caché sin coste y recuperación tras reinicio | `DEMO_CONTAINERIZATION_SPEC.md` §8-9; `AWS_DEMO_RUNBOOK.md:137` |
| Media | Que los fixtures mock entren en la imagen, o asumir que no; y que el smoke del contenedor lance un scan | `Dockerfile:18,35-44`; `scripts/container-smoke.mjs:37-41` |
| Media | El arranque depende de que Supabase responda | `server.ts:29,57` |
| Baja | Escalar más allá de un proceso: limitador, dedupe, jobs y pausa de Apify | `README.md:175-176`; `LAYER2_ASSESSMENT.md:81-83` |
| Baja | Dominio de staging (está en CORS, no se sabe si existe) y CORS para previews | Spec front 0.7, A10 |
| Baja | Quitar del `.env.local` `NVIDIA_NIM_API_KEY` (y revocarla) y `SIGNAL_LLM_ENDPOINT` | `env.test.ts:37-42` |

### Producto y negocio

| Prio | Pendiente | Fuente |
|---|---|---|
| Alta | Contenido definitivo del banco de L2: preguntas, puntos, pesos y reglas de salto (Juan José) | DN-07L §11.1; `bank.ts:3`; `LAYER2_ASSESSMENT.md:4-5` |
| Alta | Fórmula del compuesto L1/L2 (hoy 30/70 de demo) | DN-07L §11.2; `scoring/src/layer2.ts:7-8` |
| Alta | Qué flags bloquean la decisión y cuáles solo informan | DN-07L §11.3 |
| Alta | Decidir si un historial disciplinario limpio puede acreditarse en live. Hoy es imposible, así que la decisión es siempre UNKNOWN salvo overrides | DN-01:63 (intención, sin la consecuencia); `directories.ts:58-70` |
| Media | Firmas de fuera de Florida: B3 −5 y `LOW_BAR_CONSISTENCY` | `categories.ts:29`; `score.ts:30-32` |
| Media | Sanción reciente (0 puntos) frente a una de 1 a 3 años (−12) | `discipline.ts:51` |
| Media | Uso comercial de los `multipliers`, que se calculan pero no se aplican | DN-01:43-46 |
| Media | Reanudación más allá de 24 h (magic link) y que el resultado siga legible después de 24 h | DN-07L §11.5; `service.ts:59-61` |
| Baja | Si REFERRAL y REFERRAL_SENIOR cambian el tier o solo la decisión | DN-02:30 |
| Baja | Preguntas abiertas sin puntuar | DN-07L §11.4 |
| Baja | Pricing, binding, derivación a broker y PDF del assessment | `CLAUDE.md` §6.3, §9.2, §12; DN-07L §6; `README.md:214` |

### Layer 1: extracción web

| Prio | Pendiente | Fuente |
|---|---|---|
| Alta | Gates de DN-05 §12 sin cumplir (20 snapshots, ≥40 casos adversariales, conjunto reservado, 3 corridas, p95 ≤120 s) con `agentic` ya por defecto | DN-05:474-542; DN-05-evaluacion §6.6, §8 |
| Media | Latencia: no hay medición después de `8659d6b`; la última daba de 338 a 618 s | DN-05-evaluacion §6.10, §8 |
| Media | Deadline por fase en `InProcessPipeline`, y no descartar el raw al abortar | DN-05 §6; DN-07c:49-51; DN-05-review R05; DN-06:33 |
| Media | Estado de la fuente según la cobertura real, no según `crawl.partial` (un 404 deja PARTIAL para siempre) | DN-05 §8; DN-05-review R08; `crawler.ts:135-143` |
| Media | Flag "cola agotada" frente a "presupuesto agotado", para poder fijar los negativos de IA | DN-07c:68-71 |
| Media | Que `agentic` pueda producir W7 `minimal` y W5a `no_team_page` | `derived-signals.ts:47,58` |
| Baja | `extractionFingerprint` y política de caché (hash frágil, solo el último raw) | DN-05 §9; `website-source.ts:24-36` |
| Baja | Retirar o limitar la ruta `openai` de una sola pasada | DN-05-review R13 |
| Baja | Calibrar las 3 páginas de equipo y el backoff de 250/750 ms | DN-07c:28-31,48-49 |
| Baja | Jurisdicción de la licencia, gold set más allá de 2 firmas y corridas en serie | DN-05-evaluacion §6.1, §6.2, §6.11 |
| Baja | Ampliar el proveedor `rules` | DN-03:47-49 |

### Apify y directorios

| Prio | Pendiente | Fuente |
|---|---|---|
| Alta | Tope o alerta de gasto: no hay tope diario y la alerta sobre `daily_reserved` no está implementada | Spec front R1 (`:133-138`); `README.md:97-102` |
| Media | Fijar `APIFY_ACTOR_BUILD`, que hoy es `latest` | DN-06:148; `production.env:24` |
| Media | Canario real acotado tras las correcciones de reconciliación | DN-06:181 |
| Media | Calibrar TTL y límites; un run truncado o parcial repite el mismo PARTIAL durante 7 días | DN-06:149; `apify-client.ts:191-199` |
| Baja | Secuencia Bar→Avvo, discovery sin detalles, lotes, actores alternativos y conjunto reservado de al menos 30 identidades | DN-06:150-151; informe E2E, corrección 3 |
| Baja | Recuperar los dos run IDs históricos; 4 abogados de Gallardo siguen sin match seguro | DN-06:147,181 |

### Front y contenido

| Prio | Pendiente | Fuente |
|---|---|---|
| Alta | Que `main` se pueda construir en Vercel (`file:` y `NEXT_PUBLIC_API_URL`) | `package.json:16`; `client.ts:20-29` |
| Media | No mostrar al usuario mensajes de desarrollador (`misconfigured`, `contract`); no reintentar 11 min ante `contract` | `app/quote/page.tsx:100`; `scanning/page.tsx:123-127` |
| Media | Que `NEXT_PUBLIC_SITE_URL` vacía no rompa todas las páginas | `layout.tsx:24,36`; `.env.example:14` |
| Media | Copy "<60 s" frente a una realidad de minutos | `CLAUDE.md:365`; `app/quote/page.tsx:113-114`; `scanning/page.tsx:248` |
| Media | Contenido ficticio: testimonios, primas y scores ilustrativos, "Checking your tech stack" (`OceanPanel.tsx:30`); dejar claro que Lloyd's es aspiración | `copy-deck.md:408-417`; `CLAUDE.md` §7, §9 |
| Baja | Formularios de Partners y Platforms sin conectar (y con `console.log`), páginas legales, salida del embudo al home, `lib/supabase.ts` muerto, contraste del eyebrow 2,35:1, `SignalCard` en rojo, 6 avisos de lint | `CLAUDE.md` §9 |
| Baja | Quitar la duplicación de `adaptScore`/`signalsToCards` con `packages/contracts/src/views.ts` | `CLAUDE.md:1075` |
| Baja | Actualizar `CLAUDE.md` y `copy-deck.md` | §7 de esta nota |

---

## 9. Contradicciones doc↔código y deuda técnica

### 9.1 Contradicciones que vale la pena corregir

| Doc | Dice | El código dice |
|---|---|---|
| `README.md:9-10`, DN-03:43 | Proveedor por defecto `rules`; live no necesita OpenAI | `agentic` (`env.ts:12`), y exige `OPENAI_API_KEY` salvo con `rules` explícito (`env.ts:59-61`) |
| `README.md:154`, DN-01:90 | Presupuesto del pipeline de 55 s | 600 s (`env.ts:40`); 55 s es solo el default de la clase |
| `README.md:140`, DN-05 §3 | Crawl de 20 s | 30 s (`crawler.ts:82`) |
| `README.md:116-118,148-150`, DN-01:32 | 2 identidades, 7 candidatos, 2 actores, 10 registros; muestra de 15 | Roster completo; 8 por directorio y 16 en total; 25 en Bar y 10 en Avvo |
| `README.md:63-69` | 5 rutas HTTP | 11 rutas (§3.4) |
| DN-01:27, `README.md:72` | Los overrides no tocan el score | Una investigación activa pone el total a 0 (`score.ts:56-57`) |
| DN-01:106 | Mocks 84/25/74 | 82/25/72 |
| DN-01, DN-02, DN-05 §9 | Caché de 24 h | 7 días |
| DN-04:16-18, DN-06:133-134 | Topes de gasto de 1, 10 y 100 USD y `maxTotalChargeUsd` | Sin topes desde el 2026-09-21 |
| DN-05 (×4), plan de crawl | NVIDIA NIM, `nvidia-evidence-provider.ts` | Retirado en `21410dd`; hoy es `agentic-evidence-provider.ts` |
| DN-05 §9 y §12 | No activar el reemplazo sin pasar los gates | `agentic` es el default en local y en producción |
| DN-07 (crawl):56-58 | `privacy_policy` se fija a `false` | Se fija a `found:true` (`negative-signal-grounding.ts:17-21`) |
| DN-07 (L2):3 | "Nada implementado" | Implementado y fusionado |
| `LAYER2_ASSESSMENT.md:76-77` | Las migraciones las aplica el workflow | Se aplican a mano con `db:push` |
| `DEMO_CONTAINERIZATION_SPEC.md:3,45` | AWS pendiente; el smoke valida el modo mock | Hubo deploys y luego se desmontó; el smoke no lanza ningún scan |
| `vitest.config.ts:5-6` | "without requiring a build first" | Los tests resuelven a `dist` |
| `openapi.ts:91,92-105` | 404 en `POST /scan/:id/assessment`; 503 en `report.pdf` | 401 si el scan no existe; el 503 solo ocurre en tests |
| `deploy/production.env:5-6` | `deploy-image.sh` mezcla los secretos | Lo hacen `activate.sh` y `render-env.py` |
| `.gitignore:77`, `supabase/config.toml:70` | `!.env.demo.example`, `seed.sql` | Ninguno de los dos archivos existe |
| `Arca-front/CLAUDE.md:142-153` | Contratos por tarball; fallback a `api.arcacover.com` en producción | `file:`; sin fallback (lo corrige `CLAUDE.md:1422`) |
| `Arca-front/CLAUDE.md:741-767,1031-1034` | L2 mock, `lib/mock/assessment-*`, `lib/types/`, endpoints que "no existen", `packages/questions` vacío | Todo eso es real o ya no existe |
| `Arca-front/CLAUDE.md:365,375,438` | L1 en <60 s; banco de 20; L1 emite el tier `UNKNOWN` | Minutos; 14 preguntas; nunca lo emite |
| `Arca-front/CLAUDE.md:1419`, `layer2-isolated-demo.md:3,57` | Los repos originales no cambian | Fusionado en `ArcaCover/*` `main` |
| Spec del front, 2026-09-21 (`:4`, `:274`) | "Pendiente de plan"; "no abandona" el polling | Implementado; abandona a los 660 s |

### 9.2 Código muerto o ramas inalcanzables

- **Layer 1:** `preScore.total` nullable y el tier `UNKNOWN`. El contrato los admite; el código nunca los produce.
- **Layer 2:**
  - el estado `FAILED`, el código `assessment_exists` y `skippedQuestions`, que siempre devuelve `[]`;
  - las rutas de `SignalPath` que el banco no usa (`W2.tools`, `W5_teamSize`, `A8_disciplined`);
  - el índice `assessments_expiry_idx`, sin ningún barrido que lo use.
- **Front:** las ramas de `planning_failed`, `assessment_exists` y `FAILED`, y `lib/supabase.ts`.
- **Mocks:** los bloques `bar` y `avvo` de `mocks/failed.json`.
- **Variables:** `NODE_ENV` en el back; `NVIDIA_NIM_API_KEY` y `SIGNAL_LLM_ENDPOINT` en `.env.local`.

### 9.3 Deuda técnica

- **Contratos en dos sitios:** el back en dev lee `src` y el front y los tests leen `dist`. Un contrato sin compilar rompe el front sin que nadie avise.
- **`adaptScore` y `signalsToCards` están duplicados** en el front y en `packages/contracts/src/views.ts`.
- **El adaptador de Supabase de L2 no valida con zod lo que lee.** Una vista a la que le falte una pregunta en `rendered` da un 500 genérico (`service.ts:117`).
- **`report.pdf` abre un Chromium por petición**, sin límite.
- **Los suelos de adquisición del extractor lanzan un Chromium por página**, en secuencia (`site-access.ts:18-31`).
- **`GET /scan/:id` no lleva `no-store`.** Las rutas desconocidas dan un 404 en texto plano. `POST /scan` no tiene límite de cuerpo en la API.
- **Parámetros de L2 sin variable de entorno:** `planningTimeoutMs` y `maxWritesPerMinute`. El rate limit de L1 está fijo en el código.
- **El esquema de entorno no es estricto:** una variable mal escrita se descarta sin aviso.
- **Errores del front:** `/quote` muestra mensajes internos; `/quote/scanning` confunde `contract` con red. Faltan `error.tsx` y `not-found.tsx`.
- **Higiene del repo del back:**
  - `tmp/pdfs/` está versionado (13 archivos, ~1,5 MB, desde `e193237`) y `tmp/` no está en `.gitignore`;
  - `docs/reports/*.pdf` es un binario dentro de `docs`;
  - `output/` ocupa 328 MB, está ignorado y `eval:signals` depende de él;
  - `apps/api/dist` arrastra `nvidia-evidence-provider.*`, porque `tsc -b` no borra lo eliminado;
  - `coverage/` y `cdk.out/` de la raíz están obsoletos;
  - quedan ramas locales fusionadas, y `docs/dn-07-layer2-assessment` sigue viva en el remoto;
  - `package.json:22-23` tiene una coma al principio de línea;
  - la release de contratos usa Node 20.
- **Higiene del front:** el `.next/` local es del 2026-09-30, los fixtures usan `smithlaw.com` y `next/font/google` necesita red en build.

---

## 10. Riesgos de seguridad y exposición existentes

Son independientes de DN-09. La severidad es mi criterio.

| # | Riesgo | Evidencia | Sev. | Qué haría |
|---|---|---|---|---|
| 1 | **Los dos repos son públicos.** Todo lo versionado (infra, políticas, scripts, docs) es legible por cualquiera | `gh repo view`: `PUBLIC` ×2 **[GitHub]** | Alta | Asumirlo en todo lo que se escriba; valorar si deben ser privados |
| 2 | **Emails de alerta en claro en el runbook**, en contra de la intención declarada de dejarlos fuera | `docs/deployment/AWS_DEMO_RUNBOOK.md:93-94`; `infra/aws/bin/arca-demo.ts:11`; `.gitignore:155-156` | Media | Quitarlos (siguen en el historial de git) |
| 3 | **ID de la cuenta de AWS** en 5 archivos versionados y **URL del proyecto Supabase** en `.env.example:5`. No son credenciales, pero facilitan apuntar | `cdk.context.json`, `cdk-execution-policy.json`, `deploy-user-policy.json`, `scripts/arca-aws.ps1:25`, runbook | Baja | Usar un placeholder en `.env.example` |
| 4 | **`providerRuns`, costes y `reason` de Apify en el contrato público.** `GET /scan/:id` y el 200 de caché devuelven el actor, `runId`, `datasetId`, `costUsd`, `costPerAcceptedAttorneyUsd` y textos como "Apify usage limit reached". Cualquiera consigue un token con un `POST /scan`. El front no lo usa | `packages/contracts/src/sources.ts:84-109`; `directories.ts:175-176,241-244`; `app.ts:88,150` | Media | Sacarlo de la respuesta pública (implica cambiar el contrato) |
| 5 | **El resultado se sirve a quien lo pida.** Sin verificar el email ni la propiedad del dominio, un cache hit entrega el resultado de otro solicitante y revela que ese dominio se escaneó en los últimos 7 días | `app.ts:73-74`; `README.md:58-59` | Baja (por diseño) | Decisión de producto |
| 6 | **PII en la consola del navegador.** Los formularios de Partners y Platforms hacen `console.log` de nombre, empresa y email en producción | `components/partners/PartnerForm.tsx:25`; `components/platforms/PlatformForm.tsx:28` | Media | Quitar los `console.log` |
| 7 | **`/docs` y `/openapi.json` solo se protegen en Caddy.** Están abiertos en local, en el smoke y en cualquier despliegue sin Caddy | `app.ts:42-43`; `Caddyfile:21-24` | Baja | No registrarlos en producción, o registrarlos aparte |
| 8 | **La API escucha en todas las interfaces.** `serve({port, fetch})` sin `hostname` escucha en `::`/`0.0.0.0`. En dev, con el `.env.local` live, cualquiera en la LAN puede lanzar scans que pagas tú | `server.ts:58`; `@hono/node-server` 1.19.17 | Media | `hostname: '127.0.0.1'` en desarrollo |
| 9 | **`render-env.py` acepta cualquier clave de SSM** con el formato `^[A-Z][A-Z0-9_]*$`, sin pasar por git: `NODE_OPTIONS` (precargar módulos, abrir el inspector), `OPENAI_BASE_URL` (mandar la clave de OpenAI y el contenido rastreado a otro host) o `ASSESSMENT_PLANNER` | `deploy/render-env.py:15,42-46,63`; solo bloquea los solapamientos (`:56-58`) | Media | Lista blanca de claves SSM |
| 10 | **Supabase compartido entre local y producción** **[notas]**, con la clave de servicio, sin columna de entorno. Un proceso local puede: (a) marcar FAILED scans RUNNING de producción con un `PIPELINE_TIMEOUT_MS` menor; (b) cerrar con reglas assessments PLANNING ajenos; (c) reanudar o reutilizar runs de Apify de producción y, con otro token, escribir `UNAVAILABLE` en filas compartidas; (d) alimentar la caché de 7 días que sirve producción. Si `SESSION_TOKEN_SECRET` coincide (no verificable), un token de dev vale en producción | `server.ts:28-29,65-68`; `repositories/supabase.ts:40-44`; `assessment/service.ts:20,106-110`; `apify-client.ts:207-233` | **Alta** | Separar las bases (pendiente de infra) |
| 11 | **El CORS de producción admite `http://localhost:3000`.** Cualquier cosa servida en el 3000 de una máquina de desarrollo puede leer las respuestas de la API de producción | `deploy/production.env:19` | Baja | Quitarlo de producción |
| 12 | **DoS con `report.pdf`:** un Chromium por petición, sin rate limit, en una t3.medium. Basta un token, que se obtiene con un cache hit | `report/pdf.ts:7`; `app.ts:132-143` | Media | Límite por token o IP, o cola |
| 13 | **`POST /scan` acepta POST "simples" de cualquier origen.** No exige `Content-Type` y CORS solo impide leer la respuesta. En producción da igual porque es público; en local, cualquier web que visites puede gastar tu Apify contra `localhost:8080`. Hono no valida `Host` | `app.ts:44-46` | Media (en local) | Exigir `application/json` |
| 14 | **El gasto de Apify no tiene tope.** El único freno es el rate limit en memoria; reiniciar el proceso lo resetea | `apify-client.ts:152`; `env.ts:29-31`; `rate-limit.ts:10` | **Alta** | Tope diario o alerta |
| 15 | **Variables del SDK de OpenAI fuera del esquema** (`OPENAI_BASE_URL` y otras) pueden redirigir la extracción, tanto en local como vía SSM (punto 9) | `node_modules/openai/client.js:171,198`; `agentic-evidence-provider.ts:162` | Baja | Fijar `baseURL` en código |
| 16 | **Secreto vivo sin uso** en `.env.local`: `NVIDIA_NIM_API_KEY` | Inspección de nombres | Baja | Revocarlo y quitarlo |
| 17 | **JWT:** lleva el email en un payload decodificable, vive en `sessionStorage`, no se puede revocar y no lleva claim de entorno | `auth/session-token.ts:4-5`; `lib/api/session.ts:13` | Baja | — |
| 18 | **Sin CSP ni cabeceras de seguridad** en la API ni en el front. Hoy el contenido de terceros se trata bien: React escapa, el PDF escapa y no hay `dangerouslySetInnerHTML`. Hay que mantenerlo así | `next.config.ts` sin `headers()`; `report/quick-scan.ts:7-8` | Baja | — |
| 19 | **SSRF hacia IMDS desde el contenedor** **[inferencia]**: AL2023 con hop limit 2 por defecto. Solo importa si algún día se añade un "fetch URL" que no pase por `network.ts` | `arca-demo-stack.ts:102,106` | Baja (hoy) | Hop limit a 1 al levantar |
| 20 | **Cadena de suministro del CI:** actions fijadas por tag, no por SHA; sin Dependabot; sin CI en los PR | `deploy-api.yml` | Baja | — |

---

## 11. Cómo correr cada cosa hoy

Comandos para PowerShell, el shell de esta máquina. **DN-09 añadirá los modos `mock` y `live-debug`;** esto es lo que hay antes.

### Back (`C:\Users\jesus\projects\Arca-back`)

```powershell
npm ci
npm run build                  # tsc -b: emite dist de los 4 proyectos (lo necesitan el front y los tests)

# Modo mock sin servicios externos. Las variables del shell ganan a .env.local.
$env:SOURCE_MODE = 'mock'; $env:STORAGE_BACKEND = 'memory'; npm run dev    # API en :8080
# Dominios válidos: robust|minimal|sanctioned|partial|failed.arca.example
# Al terminar: Remove-Item Env:SOURCE_MODE, Env:STORAGE_BACKEND
```

- **Sin esos overrides, `npm run dev` arranca en `live` + `supabase`:** paga OpenAI y Apify y escribe en Supabase.
- **`SESSION_TOKEN_SECRET` y `CORS_ALLOWED_ORIGINS` salen del `.env.local`.** Son obligatorias también en mock.
- **En bash, no dejes un `SOURCE_MODE=` vacío:** rompe el arranque.
- **En mock siguen activos la caché de 7 días y el rate limit** de 3 por email y 10 por IP cada hora. Con `memory`, reiniciar el proceso los borra.
- **Si cambias `packages/contracts`, ejecuta `npm run build`.** El back en dev lee `src`, pero el front y los tests leen `dist`.

**Tests** (siempre desde la raíz):

```powershell
npx playwright install chromium
npm ci --prefix infra/aws
npm run build; npm test
npx vitest run <ruta>          # un solo archivo
npm run test:coverage          # solo scoring y apps/api
npm run test:container         # necesita Docker; arranca la imagen en mock/memory
```

**Otros comandos:**

| Comando | Qué hace | Coste o riesgo |
|---|---|---|
| `npm run db:push` | Aplica las migraciones | Necesita la CLI de Supabase (global o `npx`). Es a mano y actúa sobre la base configurada |
| `npm run db:verify` | Escribe 2 scans sintéticos y los borra | Exige mock + supabase |
| `npm run demo:signals`, `npm run eval:signals` | Extracción con OpenAI | **De pago.** `eval:signals` solo funciona en esta máquina, porque depende de `output/eval/snapshots` |
| `scripts/arca-aws.ps1 status` | Estado del stack | Ninguno |
| `scripts/arca-aws.ps1 up` / `down` | Levanta o desmonta el stack | **No es un comando inocuo:** `up` reactiva el auto-deploy (§5.3) |

### Front (`C:\Users\jesus\projects\Arca-front`)

```powershell
# Requisito: contratos compilados en el back (npm ci; npm run build en Arca-back)
npm ci
npm run dev -- --webpack       # :3000; con Turbopack se colgó [notas]
```

- **`.env.local`:** basta con `NEXT_PUBLIC_API_URL`, que apunte a la API local (por ejemplo `http://localhost:8080`). **No copies `.env.example` tal cual:** deja `NEXT_PUBLIC_SITE_URL=` vacía y rompe todas las páginas.
- **CORS:** el back tiene que admitir `http://localhost:3000`.
- **Comprobaciones:**

  ```powershell
  npm test; npm run typecheck; npm run lint; npm run build
  ```
- **Smoke de navegador:** `npm run test:browser:assessment`. No necesita el back, pero:
  - hay que servir el front compilado en `127.0.0.1:3001`, con `NEXT_PUBLIC_API_URL` igual a `ARCA_API_URL`;
  - en Windows hay que fijar `PLAYWRIGHT_CHROMIUM_EXECUTABLE`;
  - usa Playwright de `../Arca-back/node_modules`.

### Hechos verificados que condicionan DN-09

Son de referencia; el diseño está en DN-09.

1. **`NODE_ENV` no sirve como discriminador.** No decide nada en el back, el `Dockerfile` lo fija a `production` y el smoke del contenedor corre mock con `NODE_ENV=production`.
2. **En el front, una `NEXT_PUBLIC_*` que no exista en el build no se convierte en literal.** Un gate como `!== 'off'` falla abierto. Hay que comparar contra una lista blanca y hacer fallar el build si el valor no es válido.
3. **`apps/api/tsconfig.json` tiene `rootDir: ./src`.** Importar con ruta literal un módulo de fuera de `src` hace fallar `tsc -b` (TS6059), y con él el CI.
4. **Un centinela anti-debug en el front tiene que correr dentro de `npm run build`.** El front no tiene CI, y el del back solo corre en push a `main`.
5. **`serve()` escucha en todas las interfaces.** Las tablas de L2 solo admiten escrituras por RPC, así que un "reset" solo es posible en `memory`. El mock no tiene latencia.

---

## 12. Glosario

| Término | Significado |
|---|---|
| **Layer 1 / Quick Scan** | Evaluación automática por dominio a partir del website, la Florida Bar y Avvo. Produce el `Layer1Result`: `preScore` (0-100), 4 categorías, señales, overrides y multiplicadores. Es determinista respecto a `Layer1Evidence` (DN-03). |
| **Quick Scan Report** | El PDF A4 de Layer 1 (`GET /scan/:id/report.pdf`), generado con Chromium. No es el *Full Assessment Report* de L2, que no existe. |
| **Pre-Score** | `preScore.total`. El contrato lo declara nullable, pero el código siempre da un número. |
| **Categorías (L1)** | AI Governance 35, Professional Standing 30, Reputation 20 y Firm Maturity 15. |
| **Señales W/B/A** | W1-W9 (website; W10 está eliminada), B1-B4 (Bar) y A1-A8 (Avvo). |
| **Tier** | FORTRESS ≥80, FORTIFIED ≥65, GUARDED ≥45, EXPOSED ≥25 y CRITICAL <25. `UNKNOWN` existe en el contrato, pero L1 nunca lo emite. Siempre lo dicta el back. |
| **Decision** | AUTO_BIND, AUTO_BIND_CONDITIONAL, REFERRAL, REFERRAL_SENIOR, DECLINE o UNKNOWN. Sale del tier; los overrides solo la restringen. |
| **Overrides** | SUSPENDED_OR_DISBARRED → REFERRAL; RECENT_SANCTION → REFERRAL_SENIOR; ACTIVE_INVESTIGATION → DECLINE (y total 0). |
| **assessmentStatus** | `SUFFICIENT` o `INSUFFICIENT_EVIDENCE`. El segundo fuerza `decision=UNKNOWN` y añade `COMMERCIAL_DECISION_BLOCKED`. |
| **confidence** | HIGH, MEDIUM o LOW según cuántas fuentes terminaron `ok`. No certifica que los datos sean ciertos. |
| **status / dataStatus** | Resultado técnico de la fuente (ok, partial, error, timeout, skipped) frente a presencia de datos (PRESENT, EMPTY, UNKNOWN). |
| **Estados de scan** | RUNNING; terminales COMPLETED, PARTIAL y FAILED. |
| **PARTIAL repair** | Un PARTIAL cacheado se vuelve a ejecutar, como mucho una vez por hora, reutilizando el análisis web y las consultas de Apify vigentes. |
| **FirmIdentity** | Firma y abogados respaldados por evidencia estructurada. `INSUFFICIENT` salta los directorios (`INSUFFICIENT_IDENTITY`). |
| **TRUNCATED** | Una búsqueda llegó a su límite de resultados: 25 en Bar, 10 en Avvo. |
| **Ledger de Apify** | Tablas `apify_runs` y `scan_apify_runs`, con el coste reservado y el real. Registra, no limita. |
| **EvidenceProvider** | `agentic` (el default: rondas de herramientas sobre OpenAI con revisión semántica), `openai` (una pasada con `gpt-4o-mini`) o `rules` (determinista). |
| **Grounding / grounded negatives** | Cada afirmación del LLM lleva citas literales que se comprueban. Los negativos se fijan sin LLM cuando se leyó la página que decide la señal. |
| **Gold set / gate** | Etiquetas humanas de Duque y Gallardo. El gate exige 0 valores incorrectos aceptados en 3 corridas por firma; no se ha cumplido. |
| **Layer 2 / assessment** | Cuestionario adaptativo sobre un banco fijo (`0.1.0-demo.1`, `DEMO`) de 14 preguntas en 6 dominios, con un compuesto 30/70 de demo. |
| **Dominios (L2)** | governance 25, tools 20, oversight 20, data_protection 15, training 10, incident_preparedness 10. No hay que confundirlos con las categorías de L1. |
| **Planner** | `rules` (el default) o `agent` (OpenAI, solo en live, 15 s y vuelta a reglas). Elige y ordena; nunca redacta preguntas puntuables. |
| **suggestedAnswer / attestation / invalidación** | Respuesta propuesta a partir de evidencia, que no viene preseleccionada; declaración de veracidad obligatoria; borrado auditado de respuestas que dejan de estar visibles. |
| **sessionToken** | JWT de 24 h ligado al `scanId` y al email. Sirve también para L2 y viaja en `sessionStorage`. |
| **SOURCE_MODE / STORAGE_BACKEND / MOCK_MODE** | `mock\|live`, `memory\|supabase` y el selector legacy. Sin ninguno de los tres: `live` + `supabase`. |
| **"Demo" (ambigüedad)** | Significa dos cosas: el contenido de L2 marcado DEMO por contrato, y la infraestructura de **producción** (`arca-demo`, `.env.demo`, `DEMO_HOSTNAME`). |
| **Layer 3 / Living Score** | Monitorización continua tras el bind. Solo existe como diseño de negocio. |
| **MGA / surplus lines / coverholder** | El modelo de negocio **[doc]**. Ser coverholder de Lloyd's es una aspiración, no un logro. |
