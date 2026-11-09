# DN-07 — Crawl coverage and grounded negatives

Written after two live scans of `muscalaw.com` on `SOURCE_MODE=live` (2026-09-23/24) surfaced three
distinct failures in one session: a duplicated home page, a page budget consumed entirely by attorney
bios, and a transient NVIDIA 503 that discarded the whole scan. None of the three were about the LLM's
capability — switching models (`gpt-4.1-mini`, `gpt-6-luna`) changed nothing, because the crawl never
handed either model a privacy page, a blog page, or anything resembling AI-usage content to read.

## 1. www is one identity, not two

`canonicalUrl` stripped `www.` only to compare hostnames, never in the string it returned. A page
reached without `www` that links back to itself with `www` (muscalaw.com's own logo link) produced two
different canonical strings for one page, and the second spelling got queued and crawled again. Fixed
by normalizing the returned hostname too, so both spellings always canonicalize identically.

## 2. One page type must not be able to starve every other

muscalaw.com's 20-page budget went to the home page, three service pages, and fifteen individual
attorney bios — all priority group 2 in `pagePriority`. Privacy (group 4) and blog (group 5) were never
reached. `ai_policy`, `ai_in_services`, `ai_disclosure`, `ai_blog_posts` and `privacy_policy` all came
back `null` because the crawler never looked, not because the content wasn't there.

Fix: cap group 2 (team/attorney pages) at 3 visits per crawl. Only that group is capped — it is the one
observed to explode in page count on a real site; every other group is unchanged. The cap yields budget
back to lower-priority groups only once it is reached, and never wastes budget on a site that has fewer
than 3 such pages to begin with.

**Not addressed here, flagged for calibration:** the cap of 3 is a first value, chosen because a team
listing page plus one or two individual profiles is enough for `W5a_teamPageQuality`'s own judgment
(`derived-signals.ts`), not derived from measurement across many real sites. Revisit once there is
outcome data from more than one firm.

## 3. A transient provider error must not discard the whole scan

`maxRetries: 0` on the OpenAI-compatible client is deliberate (§294/§530 of DN-05): the SDK's own
blind retries are forbidden. But DN-05's own evaluation on 2026-09-13 already found what that leaves
unhandled — a 500 or a timeout discards more than 200 seconds of already-paid token work, with no
retry at any phase (§4.4), and recommended a bounded, per-phase retry within the global budget (#9).

That recommendation is now implemented, once, at `complete()` — the one call site every phase already
funnels through. Up to `MAX_TRANSIENT_ATTEMPTS` (3) tries per phase, short fixed backoff (250ms,
750ms) between them, and only for 5xx or a client-side connection timeout — never for a 4xx, which
means the request itself is wrong and retrying only wastes the phase's budget. This is a different
layer from the SDK's own retry: DN-05 forbids the SDK silently retrying *without our knowledge*; this
retry is explicit, bounded, and every failed attempt is still recorded in `diagnostics.attempts` for
audit, exactly as a schema-repair attempt already was.

**Not addressed here:** the backoff values (250ms, 750ms) are a reasonable starting guess, not
calibrated against real provider recovery times. DN-05's larger, still-open item — a genuine
per-phase *deadline* budget threaded through `InProcessPipeline` (§6 of DN-05-agentic-signal-extraction)
— is unrelated in scope and not attempted here; this retry respects the existing `AbortSignal` only.

## 4. A read page is evidence; an unread page is not

The extraction leaves a field `null` whenever no claim was made about it. That's correct when the
relevant page was never reached — wrong once we know it was. `privacy_policy` and `ai_blog_posts` are
grounded to `false` when the page-type classification (`pageTypes`, already computed in `runWorkflow`)
shows a `privacy`- or `blog`-typed page was actually fetched and no claim was accepted from it. Nothing
here adds a new LLM call or changes a prompt; it's a pure post-processing step over data the pipeline
already produces.

**Deliberately not grounded:** `ai_policy`, `ai_in_services` and `ai_disclosure`. Unlike a privacy
policy or a blog, these can appear on *any* page — the home page, an "about" page, a dedicated policy
page, or nowhere identifiable at all. Certifying their absence honestly would require knowing the crawl
covered the whole site, not just that it didn't fail. `CrawlResult.partial` does not mean that today:
it means a page of the site failed after its retries or the deadline cut the crawl (see section 6), and
the loop can legitimately exit with `partial: false` while
pages remained queued, simply because `maxPages` was reached first. Grounding these three signals needs
an explicit "queue exhausted vs. budget exhausted" flag on `CrawlResult` that does not exist yet. Until
it does, they stay `null` when the model finds nothing — an honest unknown, not a manufactured false
that would either wrongly clear a firm that never published anything, or wrongly penalize one whose
policy lives on a page this crawl didn't happen to reach.

## 5. A quiet site is Layer 2's problem, not Layer 1's

Some firm websites will always fail to say much of anything — a single-page brochure site, or one that
renders entirely client-side in a way the crawler cannot read. That is not a Layer 1 defect to keep
chasing with more crawling cleverness: `preScore.assessmentStatus = INSUFFICIENT_EVIDENCE` already
exists precisely to say "we don't know, ask more", and Capa 2's questionnaire (§6.3 of CLAUDE.md) is
where a firm with no readable public content gets the chance to answer directly. Layer 1's job is to
read what a normal, crawlable site publishes and ground what it certifiably didn't find — not to
guarantee a verdict for every site regardless of what it published.

## 6. robots.txt y qué significa `partial` (2026-11-09)

Añadido tras el scan real de `immigrationlawfla.com` (hallazgo F4). Ese scan no tuvo ningún problema de
robots: leyó 19 páginas y quedó `partial` por un enlace muerto (HTTP 404). Un script de terceros que no
resolvía DNS quedó anotado. La revisión sí encontró reglas que había que corregir.

**robots.txt (RFC 9309), en un solo módulo.** `pipeline/robots.ts` es la única implementación. La usan el
crawler, el lector de PDFs, el lector de sitemaps y las herramientas del agente (`site-access.ts`).
`site-search.ts` no hace peticiones: busca en texto ya leído.

| Respuesta de `/robots.txt` | Qué se hace |
|---|---|
| 2xx | Se interpreta y se obedece. |
| 4xx salvo 429 (401 y 403 incluidos) | El sitio no publica reglas: se puede leer. |
| 429, 5xx, error de red, bucle de redirecciones o timeout | Reglas inalcanzables: no se lee nada de ese origen. Es una causa **transitoria**. |

- El User-Agent es uno solo, `USER_AGENT` (`ArcaBot/1.0`), definido en `network.ts`. Es la cabecera que se
  envía y el nombre con el que se buscan las reglas. Nunca se suplanta el de un navegador.
- `robots.txt` tiene su propio plazo de 6 s (`ROBOTS_TIMEOUT_MS`). Si se cuelga, ya no consume los 30 s del crawl.
- El cuerpo se corta en 500 KiB (`ROBOTS_MAX_BYTES`) en vez de fallar. La regla que queda partida se descarta.
  El corte busca el último fin de línea de cualquier tipo (LF, CRLF o CR solo).
- Hay una caché por scan y por origen (`RobotsCache`). La crea `WebsiteExtractionSource` y la comparten el
  crawl y todas las lecturas del agente, así que `robots.txt` se descarga una vez por origen y scan. Antes
  se descargaba de nuevo en cada página pedida por el agente. `www` y el dominio desnudo son orígenes distintos.
- Las peticiones que una página hace a su propio host (scripts, XHR, fetch) también pasan por robots. Antes
  solo se comprobaban las navegaciones, y un `fetch("/wp-json/…")` salía aunque estuviera excluido.
  Un `iframe` del propio sitio excluido por robots queda anotado igual, con `scope: request`.
- El destino de una redirección se comprueba antes de entregársela al navegador (ver el límite de abajo).
- **`Crawl-delay` se respeta de forma acotada.** Si el grupo de `ArcaBot` (o `*`) lo declara, el crawl lee
  una página cada vez y espera esa pausa entre el inicio de una página y el de la siguiente. La pausa tiene
  un tope de `plazo / páginas` (1,5 s con 30 s y 20 páginas), para que la espera sola no pueda agotar el
  plazo. Consecuencia medida con páginas de fixture sin latencia: con una pausa declarada de 1,5 s o más,
  20 páginas tardan 29,6 s de los 30 s. Un sitio real con esa pausa y 20 páginas alcanzables termina por
  tanto en el plazo: website `partial` con `Crawl deadline reached`, y cuántas páginas entran depende del
  tiempo de carga. La causa es estructural, pero el plazo se lee como transitorio. **Pendiente de decisión
  del founder** antes de aplicar D5 (reparación cada hora). Las lecturas del agente (`site-access.ts`) son
  un crawl de una página por llamada y no esperan la pausa entre una llamada y la siguiente.
- Los enlaces que robots excluye no gastan el presupuesto de 20 páginas. Se resuelven antes de elegir cada
  tanda, porque no cuestan ninguna petición. Antes, 19 enlaces excluidos dejaban el crawl en la portada y el
  website salía `ok`. Un 404/410 o un fichero sí cuentan: hubo que pedirlos para saberlo.

**Qué marca el crawl como `partial`.** Cada incidencia lleva ahora un `scope`: `page` (cómo terminó una
página del crawl), `request` (una petición del navegador, de cualquier host) o `robots` (el
`robots.txt` de un origen). Solo las de `page` deciden.

| Incidencia | ¿`partial`? |
|---|---|
| Enlace excluido por robots (`ROBOTS_DISALLOWED`) | No |
| Enlace muerto, HTTP 404 o 410 | No |
| Enlace a algo que no es HTML (`NOT_HTML`: un feed, un `.docx`, una vCard), con o sin redirección delante | No |
| Subrecurso fallido, propio o de terceros (`scope: request`) | No |
| Página del propio sitio que falla tras sus reintentos (red, 5xx, 429) | Sí |
| Página con 401/403, página de desafío o sin texto legible | Sí |
| Plazo del crawl (`aborted`) | Sí |

Todas quedan en `issues` del raw. El `reason` del website las cuenta, por ejemplo
`2 pages excluded by robots.txt; 1 dead link (HTTP 404/410)`, también cuando el estado es `ok`.
Las peticiones que responden 401, 403, 429 o 5xx y las que fallan por transporte se anotan con
`scope: request`, sean del host que sean.

Un fichero detrás de una redirección no pasa por el manejador de peticiones (ver el límite de abajo), y en un
sitio que redirige el dominio desnudo a `www` eso son todos los enlaces. Llega a Chromium, que corta la
navegación con `Download is starting`. El crawler lo reconoce como `NOT_HTML` con `status: null`, sin
reintentos. Antes salía como `REQUEST_FAILED`, se reintentaba tres veces y dejaba el website `partial`.
El contexto del navegador rechaza las descargas (`acceptDownloads: false`): nunca se guarda un fichero.

**Web ilegible: definitiva o transitoria.** Cuando el crawl no lee ninguna página, `website-outcome.ts`
elige el código y el motivo según la causa, y `classifyUnreadableWebsite` (`@arca/scoring`) clasifica solo
por el código. Es el único sitio donde se decide. No hay códigos nuevos en el contrato.

| Causa | Estado y código | Clase |
|---|---|---|
| robots.txt excluye el sitio | `error` / `ACCESS_BLOCKED` | DEFINITIVE |
| Las páginas responden 401 o 403, o una página de desafío | `error` / `ACCESS_BLOCKED` | DEFINITIVE |
| La portada responde otro 4xx (404 y 410 incluidos), no es HTML o no tiene texto | `error` / `NO_READABLE_EVIDENCE` | TRANSIENT |
| Plazo o abort | `timeout` / `DEADLINE_REACHED` | TRANSIENT |
| robots.txt inalcanzable, 429, 5xx, error de red o causa desconocida | `error` / `PROVIDER_ERROR` | TRANSIENT |

Antes, un robots que excluye el sitio, un robots inalcanzable, un error de red y el plazo salían todos como
`NO_READABLE_EVIDENCE` ("No readable website evidence"). Si hay una sola causa transitoria, el resultado es
TRANSIENT: no se marca una firma como ilegible mientras otro scan pueda leerla.

Solo es DEFINITIVE la negativa del sitio, es decir, `ACCESS_BLOCKED`. Una portada sin texto no lo es: es
también lo que deja un script que falló una vez (un 503 del propio bundle, un CDN que no resuelve DNS) o un
contenido que aún no había llegado cuando se leyó la página, y después no se pueden distinguir. Cuando
hubo peticiones fallidas o excluidas por robots detrás de esa página, el `reason` lo dice:
`The website returned a page with no readable text (1 of its requests failed; 2 excluded by robots.txt)`.
Una portada 404/410 o que no es HTML también queda fuera, porque la decisión D3 no las incluye. Meterlas
exigiría decidirlo antes y darles un código distinto del de la página vacía, porque la clase se lee solo del código.

Qué hace cada clase con el scan está en DN-12 §3: DEFINITIVE termina PARTIAL con el resultado de alto riesgo
(flag y override `WEBSITE_UNAVAILABLE`) y TRANSIENT sigue terminando FAILED.

**Límite conocido, sin resolver aquí.** Playwright no pasa por el manejador de peticiones los saltos de
una redirección HTTP: Chromium los sigue con su propia red. Por eso el destino de una redirección no pasa
por `network.ts` (anti-SSRF con IP fijada), y los saltos posteriores al primero tampoco pasan por robots.
Seguir las redirecciones desde el backend lo cerraría, pero hoy las cookies que un sitio fija al redirigir
solo las conserva el navegador, y sin ellas algunos sitios entrarían en bucle. Queda pendiente de decisión.
