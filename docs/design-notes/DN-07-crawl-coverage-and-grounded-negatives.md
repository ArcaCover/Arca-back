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

*Nota (2026-11-12):* los números de grupo de esta sección ya no son los vigentes. El orden actual, con un
tope también para las noticias, está en §6, "Orden del crawl".

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
  se descargaba de nuevo en cada página pedida por el agente. `www` y el dominio desnudo son orígenes distintos:
  un sitemap alojado en `www` se comprueba con las reglas de `www`, no con las del dominio desnudo.
- Las peticiones que una página hace a su propio host (scripts, XHR, fetch) también pasan por robots. Antes
  solo se comprobaban las navegaciones, y un `fetch("/wp-json/…")` salía aunque estuviera excluido.
  Un `iframe` del propio sitio excluido por robots queda anotado igual, con `scope: request`.
- El destino de una redirección se comprueba antes de entregársela al navegador. Cuando la navegación termina, se
  comprueba además cada salto de la cadena (`redirectedFrom()` hasta la primera petición): si alguno sale del sitio,
  la página termina como `OFF_SITE_REDIRECT`; si robots excluye alguno del sitio, como `ROBOTS_DISALLOWED`. La URL
  actual de la página solo entra en la comprobación de host, no en la de robots: un script puede reescribir la
  dirección en el mismo documento (`history.replaceState`, `pushState`) sin pedir nada a la red, y robots.txt no
  tiene nada que decir de una petición que no existe. Antes de este arreglo, un `replaceState` a `/?lang=en` con
  `Disallow: /*?` descartaba una portada leída desde una URL permitida, y el sitio podía acabar como ilegible
  (`WEBSITE_UNAVAILABLE`) sin serlo. En los dos casos su contenido no se guarda (ver el límite de abajo). La comprobación va antes de
  mirar el estado, así que una cadena que sale a otro host termina como `OFF_SITE_REDIRECT` aunque el último salto
  responda 503 con un desafío: el desafío es de otro host, no la negativa de la firma.
- La página puede navegar sola después de cargar (un `meta refresh`, un `location.href` en un script) mientras el
  crawler espera a que la red se calme. Por eso el crawler apunta todas las respuestas de navegación del marco
  principal (`page.on('response')`) y, después de leer el contenido, vuelve a revisar la cadena de cada una (y la URL
  actual, solo contra el host). Si alguna sale del sitio o pasa por una URL excluida, la página termina igual que arriba y lo leído se
  descarta. Antes de la segunda revisión, un `meta refresh` a `/private` → `www/private` → `/private/` con
  `Disallow: /private/` se guardaba como página de la firma, y uno que acababa en otro host también.
- El lector de sitemaps sigue las redirecciones él mismo, salto a salto y como mucho 5. Cada salto tiene que quedarse en
  el host de la firma y estar permitido por el `robots.txt` de su origen antes de pedirlo; si no, ese sitemap se salta.
  Antes seguía las redirecciones sin mirar ni robots ni el host, y `/sitemap.xml` → `/private/sitemap.xml` con
  `Disallow: /private/` se leía y sus enlaces se usaban.
- **`Crawl-delay` se respeta como separación entre inicios de página, no leyendo una página cada vez.** Si el
  grupo de `ArcaBot` (o `*`) lo declara, dos páginas del sitio nunca empiezan más cerca que esa pausa, pero
  las que ya empezaron siguen cargando a la vez (hasta 6). La pausa tiene un tope de `(plazo / 4) / páginas`
  (375 ms con 30 s y 20 páginas), y lo que la separación añade a todo el crawl, reintentos incluidos, no pasa
  de `plazo / 4` (7,5 s): agotado ese presupuesto, nadie espera más (`createPacer`). La versión anterior (una
  página cada vez, tope de 1,5 s) agotaba el plazo en cualquier sitio real: con 700 ms por página y
  `Crawl-delay: 10` leía 19 páginas en 30 s y salía `partial`; ahora lee las 20 en 12,8 s (sin `Crawl-delay`,
  7,8 s). Así el `Crawl-delay` no decide cuántas páginas entran ni deja el website `partial` por el plazo.
  El precio: a un sitio que pide 10 s le damos 375 ms. Las lecturas del agente (`site-access.ts`) son un
  crawl de una página por llamada y no esperan la pausa entre una llamada y la siguiente.
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
| Enlace que redirige fuera del sitio (`OFF_SITE_REDIRECT`: `/pay`, `/book` o `/reviews` hacia LawPay, Calendly o Google) | No |
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
| Las páginas responden 401 o 403, o una página de desafío (con cualquier estado: 200, 403, 429 o 503) | `error` / `ACCESS_BLOCKED` | DEFINITIVE |
| La portada responde otro 4xx (404 y 410 incluidos), no es HTML o no tiene texto | `error` / `NO_READABLE_EVIDENCE` | TRANSIENT |
| La portada redirige a otro dominio (un cambio de marca, por ejemplo) | `error` / `NO_READABLE_EVIDENCE` | TRANSIENT |
| Plazo o abort | `timeout` / `DEADLINE_REACHED` | TRANSIENT |
| robots.txt inalcanzable, 429, 5xx, error de red o causa desconocida | `error` / `PROVIDER_ERROR` | TRANSIENT |

Antes, un robots que excluye el sitio, un robots inalcanzable, un error de red y el plazo salían todos como
`NO_READABLE_EVIDENCE` ("No readable website evidence"). Si hay una sola causa transitoria, el resultado es
TRANSIENT: no se marca una firma como ilegible mientras otro scan pueda leerla.

El desafío se reconoce antes de mirar el estado, por su texto ("Just a moment", "Checking your browser"…) o por la
cabecera `cf-mitigated: challenge`. Cloudflare sirve el suyo con 403, 429 o 503, y antes un desafío con 503 salía
como `HTTP_ERROR`, se reintentaba y el scan terminaba FAILED en cada intento. Ahora es `ACCESS_BLOCKED` con
`detail: 'challenge page'`, sin reintentos. Un 503 o un 429 sin desafío siguen siendo transitorios. Solo cuenta el
desafío del propio sitio: la cadena de redirecciones se revisa antes (arriba), y una que acaba en el desafío de otro
host es `OFF_SITE_REDIRECT`, transitoria.

Solo es DEFINITIVE la negativa del sitio, es decir, `ACCESS_BLOCKED`. Una portada sin texto no lo es: es
también lo que deja un script que falló una vez (un 503 del propio bundle, un CDN que no resuelve DNS) o un
contenido que aún no había llegado cuando se leyó la página, y después no se pueden distinguir. Cuando
hubo peticiones fallidas o excluidas por robots detrás de esa página, el `reason` lo dice:
`The website returned a page with no readable text (1 of its requests failed; 2 excluded by robots.txt)`.
Lo mismo vale para una página vacía dentro de un crawl que sí leyó otras: el website queda `partial` con
`PROVIDER_ERROR`, transitorio, y la caché de scans lo repara pasado el cooldown en vez de fijarlo 7 días (DN-12
§4.2). Una portada 404/410 o que no es HTML también queda fuera, porque la decisión D3 no las incluye. Meterlas
exigiría decidirlo antes y darles un código distinto del de la página vacía, porque la clase se lee solo del código.

Qué hace cada clase con el scan está en DN-12 §14 (antes §3): desde el 2026-11-17 las dos terminan PARTIAL con el
flag `WEBSITE_UNAVAILABLE` y confianza baja, sin override; la clase solo decide cuánto lo guarda la caché de scans
(DEFINITIVE toda la ventana, TRANSIENT hasta el cooldown de reparación). FAILED queda para los fallos nuestros.

**Redirecciones fuera del sitio.** Playwright no pasa por el manejador de peticiones los saltos de una
redirección HTTP: Chromium los sigue con su propia red, fuera de `network.ts` (anti-SSRF con IP fijada).
Antes, un enlace de la firma que redirigía a otro host se seguía igual: el probe de la revisión leyó como
página de la firma el contenido de `http://127.0.0.1:<puerto>/latest/meta-data`, y un `/book` hacia
Calendly se pedía tres veces, dejaba el crawl `partial` y descargaba el `robots.txt` de Calendly. Ahora:

- Si una navegación redirige fuera del sitio (otro host, otro puerto u otro esquema), el manejador corta la
  redirección antes de entregarla al navegador y la página termina como `OFF_SITE_REDIRECT`, con el host de
  destino en `detail`. Es una respuesta del sitio: sin reintentos, sin `partial`, sin pedir nada al otro host.
- Si la cadena pasa fuera del sitio tras un salto que el manejador no vio (`www` que redirige otra vez), la
  página tampoco se guarda: mismo `OFF_SITE_REDIRECT`. Vale también para una navegación que la página empieza sola
  después de cargar (`meta refresh` o script).

**Límite conocido, sin resolver aquí.** Los saltos posteriores al primero no pasan por el manejador de peticiones:
Chromium los sigue con su propia red, fuera de `network.ts` (sin la IP fijada) y sin preguntar a robots antes de
pedirlos. Desde el 2026-11-10 **el contenido de esos saltos no se guarda** si salen del sitio o pasan por una URL que
robots excluye: el crawler revisa la cadena de cada navegación del marco principal antes de mirar el estado y otra vez
después de leer el contenido, también la de una navegación que la página empezó sola (arriba). Una navegación que
empiece después de esa lectura ya no cambia lo que se guardó. Pero Chromium **sí llega a pedir** ese salto una vez,
y los tests de la cadena `/private` → `www/private` → `/private/` (directa, por `meta refresh` y por script) lo
comprueban así. Tampoco
pasan por `network.ts` ni por robots las redirecciones de subrecursos (scripts, XHR). Seguir las redirecciones desde
el backend lo cerraría (resolver la cadena en el manejador y entregar al navegador una sola redirección a la URL final
ya comprobada), pero hoy las cookies que un sitio fija al redirigir solo las conserva el navegador, y sin ellas
algunos sitios entrarían en bucle. Queda pendiente de decisión. Una firma cuya portada redirige a otro dominio
termina FAILED (TRANSIENT) en vez de leer la portada del dominio nuevo.

**Orden del crawl (2026-11-12).** Dos scans reales de `hklaw.com` con minutos de diferencia dieron 3 y 0. Todo el
sitio vive bajo `/en/…`, y `pagePriority` miraba la ruta entera: `/en` no contaba como portada, `/en/professionals`
(el directorio de abogados) y `/en/offices` no caían en ningún grupo, y la página de IA de la firma
(`/en/general-pages/…-artificial-intelligence-navigator`) tampoco. Las noticias y los artículos (`/en/news/…`,
`/en/insights/…`) sí tenían grupo, así que ganaban: 13 de las 20 páginas leídas eran noticias. Además la portada se
leyó dos veces (`/` redirigía a `/en`, y luego el enlace a `/en` se encolaba como no visitado). Cambios, en
`crawl-order.ts` (el crawler lo reexporta):

- **Prefijo de idioma.** Antes de clasificar se quita un primer segmento de idioma: `/en`, `/es`, `/en-us`, `/es-mx`,
  `/pt-br`. Son dos letras de una lista de idiomas, con región opcional, y no dos letras cualquiera, para que una
  sección `/ai/` no se tome por idioma. `/en` solo es la portada (prioridad 0).
- **Orden nuevo**, de primero a último:

  | Prioridad | Grupo | Raíces (inglés y español) |
  |---|---|---|
  | 0 | Portada | `/`, `/en`, `/es-mx`… |
  | 1 | IA | `artificial-intelligence`, `inteligencia-artificial`, la palabra `ai` o `ia` (`/ai/`, `/ai-…`, `…-ai`, `generative-ai`), `legal-tech`, `innovat…`, `innovaci…` |
  | 2 | Sobre la firma | `about`, `firm`, `our-firm`, `history`, `who-we-are`, `nosotros`, `quienes-somos`, `acerca`, `la-firma`, `historia` |
  | 3 | Personas (tope 3) | `team`, `attorney`, `lawyer`, `people`, `our-people`, `professionals`, `bios`, `abogad…`, `equipo`, `socios` |
  | 4 | Oficinas y contacto | `offices`, `location`, `contact`, `oficinas`, `contacto`, `ubicaci…` |
  | 5 | Servicios y áreas | `service`, `practice`, `servicio`, `practica` |
  | 6 | Privacidad | `privacy`, `privacidad`, `aviso-legal` |
  | 7 | Cualquier otra página | lo que no cae en ningún grupo |
  | 8 | Noticias (tope 3) | `blog`, `news`, `insights`, `events`, `press`, `noticias`, `eventos`, `prensa` |

- Las raíces nuevas cortas (`firm`, `history`, `bios`, `ai`, y las de noticias) se comparan como **palabra entera**
  de la ruta (separada por `/`, `-`, `_` o `.`): `affirmative` no es `firm`, `biotech` no es `bios` y `newsletter`
  no es `news`. Las raíces que ya existían siguen comparándose como subcadena, como antes.
- **Una página dentro de una sección de noticias es noticia**, diga lo que diga su slug: una firma con treinta
  alertas sobre IA gastaría el presupuesto entero en ellas. Fuera de las noticias, una página se clasifica primero
  por su **último segmento** y después por la ruta entera: `/en/firm/legal/privacy` es privacidad y `/about/team`
  es personas.
- **Topes.** Personas sigue en 3 (el directorio y dos fichas; el directorio ya nombra a todos, ver §2). Las
  noticias tienen ahora tope 3: el crawl ordena primero por profundidad y después por prioridad, así que sin tope
  las noticias que enlaza la portada (profundidad 1) ganaban a cualquier página de profundidad 2. Ningún tope deja
  huecos: si no queda nada más en la cola, las páginas por encima del tope rellenan el resto, como antes.
- **La portada una vez.** Al guardar una página se apunta su URL canónica final, después de las redirecciones. Un
  enlace a esa URL ya no se encola, y si dos enlaces de la misma tanda acaban en la misma página, se guarda una sola
  vez. Esas URLs no cuentan contra el presupuesto de 20: solo cuentan los enlaces que se siguen.

**El sitemap como semilla.** Antes de la primera tanda, el crawl lee el sitemap con `readSitemap`, el mismo lector
del agente: respeta robots igual que antes (si el `robots.txt` de la raíz es inalcanzable no se pide nada), sigue
un solo nivel de índice, comprueba cada salto de redirección y guarda como mucho 400 URLs. De ellas encola, a
profundidad 1, hasta 8 páginas (`MAX_SITEMAP_SEEDS`) de los grupos IA, sobre la firma, personas y oficinas
(`sitemapSeeds`): por turnos entre los cuatro grupos, la ruta más corta de cada uno primero (el directorio antes que
las fichas) y una sola versión de idioma de cada página. Así entran páginas a las que la portada solo llega por un
menú que el crawler no ve, o que están un nivel demasiado hondo.

- Tiene su propio plazo de 4 s (`SITEMAP_SEED_TIMEOUT_MS`). Un sitemap que no existe, falla o no responde a tiempo no
  añade nada, no es una incidencia del crawl y no lo deja `partial`: el crawl empieza desde la portada, como antes.
- Lee con una copia de la caché de robots, para que su plazo no pueda cortar una descarga de `robots.txt` que el
  crawl espera. Si termina a tiempo, las respuestas de robots que obtuvo pasan a la caché del scan (una descarga por
  origen, como siempre). El `robots.txt` de la raíz se resuelve antes, con la señal del propio crawl.
- No se lee en las lecturas de una página del agente (`seedOnly`) ni con `maxDepth: 0`. Los tests que cuentan las
  peticiones del transporte lo apagan con `sitemap: false`.
- Coste: algunas peticiones más por scan: los tres nombres habituales (`/sitemap.xml`, `/sitemap_index.xml`,
  `/wp-sitemap.xml`), los que declare `robots.txt` y hasta 10 hijos de un índice, 20 ficheros como mucho. El agente
  puede volver a leer el mismo sitemap con su herramienta.

**Reintento de DNS.** El router local pierde una búsqueda de DNS de cada 60, medido. En el segundo scan de
`hklaw.com` un `getaddrinfo ENOTFOUND www.hklaw.com` al pedir `robots.txt` dejó las reglas inalcanzables, y con
ellas el sitio entero y el scan FAILED (transitorio). Ahora `network.ts` repite la búsqueda hasta dos veces más,
tras 250 ms y 750 ms (`DNS_RETRY_DELAYS_MS`), cuando falla con `ENOTFOUND`, `EAI_AGAIN` o un timeout de búsqueda
(`ETIMEOUT`, `ETIMEDOUT`). Cualquier otro error falla a la primera, como antes. La comprobación de direcciones
públicas se hace sobre la respuesta de la última búsqueda, que es la que se fija al socket. La espera se corta si el
llamante aborta. Un dominio que de verdad no existe tarda ahora un segundo más en fallar. Las búsquedas que hace
Chromium para los saltos que sigue él mismo (ver el límite de arriba) no pasan por aquí.
