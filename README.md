# ARCA — Layer 1

Backend TypeScript que evalúa evidencia pública estructurada de una firma por dominio: website, Florida Bar y Avvo.
Implementa el handbook del 4 de septiembre de 2026 y las decisiones confirmadas por el usuario.
Las diferencias y sus motivos se concentran en [DN-01](docs/design-notes/DN-01-layer1-handbook-resolution.md).

Layer 1 es determinista respecto a su DTO `Layer1Evidence`: normaliza, hace matching y aplica reglas,
scoring, overrides, tier y decisión sin conocer crawlers, prompts ni clientes de OpenAI. La extracción
de website ocurre antes de ese límite mediante un `EvidenceProvider`. El proveedor predeterminado es
`rules`; OpenAI se conserva como adaptador opcional. La decisión está documentada en
[DN-03](docs/design-notes/DN-03-provider-agnostic-layer1.md).

## Ejecutar localmente

Requiere Node.js 22 y npm. El front ([ArcaCover/Arca-front](https://github.com/ArcaCover/Arca-front)) importa
los contratos desde este repo con `file:../Arca-back/packages/contracts`, así que los dos repos tienen que
estar clonados uno al lado del otro, en la misma carpeta y con esos nombres.

```powershell
git clone https://github.com/ArcaCover/Arca-back.git
git clone https://github.com/ArcaCover/Arca-front.git

cd Arca-back
npm ci
npx playwright install chromium   # el PDF del Quick Scan y los tests lo usan, también en mock
npm run build                     # compila packages/contracts/dist, que el front necesita
Copy-Item .env.example .env.local
# En .env.local, asignar SESSION_TOKEN_SECRET: un secreto aleatorio de al menos 32 caracteres, por ejemplo
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

cd ..\Arca-front
npm ci
Copy-Item .env.example .env.local

cd ..\Arca-back
npm run stack -- mock             # back en 127.0.0.1:8080 y front en http://localhost:3000, los dos en mock
```

Después, abrir http://localhost:3000/quote. La franja amarilla a rayas `MOCK` confirma que el back también
corre en mock, y su botón **State** abre el panel con el estado de cada pantalla, los escenarios de fallo y
los atajos del assessment.

Los modos (`ARCA_MODE` aquí y `NEXT_PUBLIC_ARCA_MODE` en el front) son `mock`, `live-debug` y `production`.
Si faltan, el modo es `production`. Los dos `.env.example` arrancan en `mock`, que no necesita ninguna
credencial ni hace llamadas pagadas. Datos y caché viven en memoria y desaparecen al reiniciar. `live-debug`
usa las APIs reales y Supabase, y necesita sus claves; su webapp (cuentas, organizaciones y cobro) es
simulada y vive en memoria, como en `mock` (DN-12 §7). Comandos, comprobaciones y reglas de seguridad:
[DN-09](docs/design-notes/DN-09-modos-mock-y-live-debug.md), §11 y §12.

Cada repo también tiene `npm run dev:mock` y `npm run dev:live-debug` para arrancarlo por separado. Sin
modo de debug, `npm run dev` arranca el back solo. Swagger está en http://localhost:8080/docs.

Desde Swagger se puede ejecutar el flujo completo:

1. Ejecutar `POST /scan` con `email` y `domain`.
2. Si responde `202 RUNNING`, copiar `sessionToken`, usar **Authorize** con el Bearer token y consultar
   `GET /scan/{scanId}` hasta alcanzar un estado terminal.
3. Si el dominio está en caché, `POST /scan` responde directamente `200` con `cached: true`, `result` y el
   estado terminal almacenado, que puede ser `COMPLETED` o `PARTIAL`.

Cada operación incluye ejemplos para inicio, cache hit, polling, resultado completo y errores.

```powershell
$scan = Invoke-RestMethod http://localhost:8080/scan -Method Post -ContentType 'application/json' -Body '{"email":"owner@robust.arca.example","domain":"robust.arca.example"}'
Invoke-RestMethod "http://localhost:8080/scan/$($scan.scanId)" -Headers @{ Authorization = "Bearer $($scan.sessionToken)" }
```

| Dominio mock | Estado terminal | Resultado relevante |
| --- | --- | --- |
| robust.arca.example | COMPLETED | Score 82, FORTRESS |
| minimal.arca.example | COMPLETED | Score 25, EXPOSED; evidencia incompleta |
| sanctioned.arca.example | COMPLETED | Score 72, FORTIFIED; decisión REFERRAL_SENIOR por sanción reciente |
| partial.arca.example | PARTIAL | Avvo caído; `INSUFFICIENT_EVIDENCE` y decisión `UNKNOWN` |
| blocked.arca.example | PARTIAL | La web se niega a ser leída (robots.txt, causa definitiva): flag `WEBSITE_UNAVAILABLE`, confianza LOW, decisión `UNKNOWN`; el assessment puntúa solo con las respuestas |
| down.arca.example | PARTIAL | No se pudo llegar a la web (causa transitoria): lo mismo que `blocked`, pero la caché lo repara pasado el cooldown |
| failed.arca.example | FAILED | Fallo nuestro: la extracción falló sobre páginas que sí se leyeron; sin `result` en la respuesta |

Los cuatro últimos existen para que el frontend pueda desarrollar sus ramas de error sin
desenchufar la red.

Los fixtures están en `apps/api/mocks`; la sanción reciente se fecha al cargar el escenario.

## Contrato HTTP

`email` y `domain` son obligatorios. El dominio explícito se normaliza y debe resolver a un
destino público utilizable; esto no verifica propiedad. Una solicitud inválida o un dominio
que no pueda resolverse devuelve `400` y no crea ni ejecuta un scan.
Una vez resuelta la identidad, el email no interviene en señales, score ni multipliers.

| Método | Ruta | Comportamiento |
| --- | --- | --- |
| POST | `/scan` | 202 RUNNING con scanId y sessionToken; 200 con `result` cacheado, su estado terminal y una sesión nueva |
| GET | `/scan/:scanId` | Polling con Bearer JWT de 24 horas vinculado al scan y solicitante |
| GET | `/openapi.json` | Contrato generado OpenAPI 3.1 |
| GET | `/docs` | Swagger UI |
| GET | `/health` | Salud del proceso |

COMPLETED, PARTIAL y FAILED son terminales: detener polling en cualquiera.
El resultado separa `preScore.tier` de `preScore.decision`; los overrides solo restringen la decisión.
Los campos y reglas desconocidos siguen siendo null, pero aportan cero puntos. Una categoría completamente
desconocida tiene score 0; los parciales suman únicamente reglas evaluables y muestran estado y flags de cobertura.
`sources.status` indica éxito técnico, `dataStatus` indica presencia de datos.
La confianza HIGH/MEDIUM/LOW corresponde al número de fuentes técnicamente completas, no certifica veracidad.
`preScore.assessmentStatus=INSUFFICIENT_EVIDENCE` bloquea la decisión comercial automática y devuelve
`decision=UNKNOWN`, salvo que evidencia disciplinaria conocida imponga una restricción explícita.

Una web que no se puede leer no hace fallar el scan si la causa es del propio sitio (DN-12 §14):

- **Ninguna página leída, por cualquier causa del sitio** (robots.txt excluye el sitio, 401/403 o una página de
  desafío, DNS que no resuelve, conexión rechazada o cortada, plazo del crawl, 5xx, 429, robots.txt inalcanzable,
  portada vacía o que redirige a otro dominio): el scan termina **PARTIAL** con el resultado, el flag
  `WEBSITE_UNAVAILABLE` y confianza LOW. Sin override: la decisión queda `UNKNOWN` salvo una restricción
  disciplinaria. El front y el PDF del Quick Scan no enseñan número ni tier (confianza baja, no alto riesgo). El
  assessment puede empezar y puntúa solo con las respuestas: `layer1Score: null`, `compositeScore = layer2Score` y
  el flag `LAYER1_UNAVAILABLE`.
- **Fallo nuestro** (la fuente lanzó, el plazo del pipeline, la extracción del modelo falló sobre páginas que sí se
  leyeron, el almacenamiento): sigue **FAILED**, sin `result`, y el visitante puede reintentar.

La línea la marca `sources.website.pagesCrawled`: solo un crawl que no leyó ninguna página pone `0`
(`isWebsiteUnavailable` en `@arca/scoring`). Definitiva o transitoria solo decide cuánto lo guarda la caché (abajo).
La clase (definitiva o transitoria) está en un solo sitio, `classifyUnreadableWebsite` (`@arca/scoring`); la tabla de causas, en el DN-07 de crawl, §6.

La caché dura `SCAN_CACHE_TTL_MS` por dominio canónico, 7 días por defecto, y nunca reutiliza FAILED.
**Mismo despacho, mismo score (DN-12 §4).** Dentro de la ventana, el resultado guardado es la respuesta:

- Un COMPLETED se devuelve en el 200 rápido con `cached=true`.
- Un PARTIAL cuyos huecos volvería a encontrar un segundo scan (un directorio omitido por
  `INSUFFICIENT_IDENTITY`, `NO_MATCH`, `TRUNCATED`, la web que no se deja leer, un website leído hasta
  donde el sitio permite) se sirve tal cual **toda la ventana**, siempre por polling (202 y después
  `GET /scan/:scanId`), nunca en el 200 rápido.
- Un PARTIAL con una causa transitoria (plazo, error del proveedor, límite de uso de Apify, crawl cortado
  por el plazo, una web que no se pudo alcanzar) se sirve durante `SCAN_PARTIAL_REPAIR_COOLDOWN_MS` (1 hora por defecto) y después se
  re-ejecuta, una vez por intervalo: una fuente que sigue fallando se reintenta, pero no a costa de hacer
  esperar a cada visitante.

La tabla de causas está en un solo sitio, `apps/api/src/http/scan-cache.ts`. Una re-ejecución reutiliza
el análisis de website guardado mientras el sitio diga lo mismo (clave: lo que lee el modelo, no el HTML;
edad máxima `WEBSITE_SIGNAL_REUSE_MAX_AGE_MS`, 30 días) y las consultas de directorio vigentes, así que
solo se repara la evidencia que falta. Para forzar una ejecución nueva de un despacho ya cacheado se
arranca el back con `SCAN_CACHE_TTL_MS=1`, `SCAN_PARTIAL_REPAIR_COOLDOWN_MS=0` y, si además debe leer
el modelo otra vez, `WEBSITE_SIGNAL_REUSE_MAX_AGE_MS=0` (DN-12 §4.4).
Un scan solo queda PARTIAL después de que cada página recuperable agotó sus reintentos.
`APIFY_QUERY_CACHE_TTL_MS` se mantiene acoplado a `SCAN_CACHE_TTL_MS`: si expirara antes, cada
reparación volvería a pagar las consultas de directorio que debía reutilizar.
Cada reutilización crea un registro y token propios, conserva la fecha de evidencia y no renueva el TTL.
La caché vive en PostgreSQL/Supabase usando `scans`; no requiere Redis ni archivos locales. La consulta
está respaldada por un índice parcial sobre dominio y fecha para scans reutilizables no cacheados.
Los límites en memoria son 10 solicitudes por IP/hora y 3 por email/hora.

En producción el gasto de Apify se **registra pero no se limita**. El ledger (`apify_runs`, `scan_apify_runs`,
`cost_usd`, `reserved_usd`, `accounting_complete`, `charged_to_scan`) atribuye el coste por scan;
`APIFY_EXPECTED_COST_USD_PER_RUN` es la cifra provisional que se reserva por cada búsqueda por firma hasta que
Apify liquida su coste real, minutos después de que termine; una búsqueda dirigida de unos pocos nombres reserva
`APIFY_EXPECTED_COST_USD_PER_TARGETED_RUN` (0,10) o, en Avvo, `APIFY_AVVO_EXPECTED_COST_USD_PER_TARGETED_RUN`
(0,40) (DN-06 §10.2). Sin techo no hay tope por run, por scan ni por
día, y tampoco `maxTotalChargeUsd` del lado del proveedor: lo único que acota un run individual es
`APIFY_RUN_TIMEOUT_SECS`.

**Guardas de gasto (DN-12 §5).** Activas por defecto solo en `live-debug`; producción no las tiene si su
entorno no las fija.

- `APIFY_SPEND_CEILING_USD` (`live-debug`: 2): techo en USD sobre lo que el ledger tiene comprometido en
  las últimas 24 horas, lo haya arrancado quien lo haya arrancado. Un run sin liquidar cuenta su reserva
  entera. Si un run nuevo no cabe, se rechaza antes de enviar nada a Apify, el directorio informa
  `PROVIDER_ERROR` (causa transitoria) y el scan queda PARTIAL. Las consultas cacheadas se siguen
  sirviendo. `0` no arranca ningún run. Con techo, cada run lleva además `maxTotalChargeUsd` igual a su
  reserva, así que los límites de los runs en vuelo nunca suman más que el techo; va en la URL, así que ni
  el input ni el fingerprint cambian. Para que una búsqueda por firma pueda gastar más, se sube la reserva.
- `OPENAI_MAX_REQUESTS_PER_SCAN` (`live-debug`: 30): máximo de chat completions de la extracción del
  website de un scan. Si se pasa, la fuente falla por causa transitoria y el scan termina FAILED.

Cada ejecución del pipeline deja una línea `[scan-cost] {...}` en el log, en todos los modos: runs de
Apify arrancados, rechazados y servidos de caché, USD informados y reservados, peticiones y tokens de
OpenAI. Nombra el scan solo por su id.

## Reglas

| Categoría | Máximo |
| --- | --- |
| AI Governance | 35 |
| Professional Standing | 30 |
| Reputation | 20 |
| Firm Maturity | 15 |

Firm Maturity concede hasta 3 puntos por cada uno: website robusto, privacidad de datos del cliente,
equipo detallado, firma con más de diez años y áreas consistentes. Se eliminó W10 (tipo de email).
Se mantienen las penalizaciones observables de las tablas y los límites por categoría.
Las áreas se normalizan y se comparan con Jaccard ≥0.8. Los directorios consultan una muestra estable
de hasta dos identidades y cada actor devuelve como máximo siete candidatos; el denominador de consistencia
es el número de coincidencias aceptadas.
La identidad de firma debe proceder de evidencia del website; nunca se deriva del fragmento del dominio.
Sin nombre de firma ni abogados respaldados, Bar y Avvo se omiten con `INSUFFICIENT_IDENTITY` para evitar
consultas pagadas ambiguas. Un abogado solo se acepta por nombre completo exacto o por una coincidencia aproximada confirmada
con firma, county, dirección o teléfono. Una coincidencia fuzzy sin soporte se descarta como `no_match`.
Las fechas de sanción usan aniversarios de calendario, no años de 365 días.
Los multipliers permanecen en el resultado; desconocido devuelve 1.0 con `known: false`.
Su aplicación comercial queda señalada para revisión en DN-01.

## Fuentes reales y despliegue

Usar `SOURCE_MODE=live`, configurar Supabase y Apify según `.env.example`, e instalar Chromium:

```powershell
npx playwright install chromium
npm run build
node apps/api/dist/server.js
```

Website: Playwright, máximo 20 páginas y profundidad 2; robots y resolución pública fijada al socket.
`robots.txt` sigue RFC 9309: un 4xx distinto de 429 significa que no hay reglas; un 429, un 5xx, un error de
red o un timeout significan que no se lee nada de ese origen. Se descarga una vez por origen y scan.
Una página que falla por transporte, error 5xx o 429 se reintenta hasta completar tres intentos antes de
marcar el rastreo parcial; robots, 4xx y contenido ilegible no se reintentan. Un enlace excluido por robots,
un 404/410 o un enlace a algo que no es HTML quedan anotados, pero no marcan el rastreo parcial
(DN-07 de crawl, §6). El rastreo tiene su propio
plazo de 30 segundos, y al agotarse el resultado es parcial aunque queden reintentos disponibles.
La prioridad de rastreo reconoce vocabulario en inglés y en español, para que un sitio en español no empate
todas sus páginas en la prioridad mínima y gaste el plazo en el blog.
El nombre del despacho se toma de `JSON-LD` cuando existe; al recurrir a `og:site_name` se descarta la cola
de título posterior al separador, porque ese texto viaja como identidad a las búsquedas pagadas.
La extracción estructurada usa reglas conservadoras por defecto, con caché por hash, proveedor y versión.
`WEBSITE_EVIDENCE_PROVIDER=openai` habilita opcionalmente GPT-4o-mini y exige `OPENAI_API_KEY`.
Directorios: `scrapers_lat/florida-bar-lawyers-scraper` y `scrapers_lat/avvo-lawyers-scraper` mediante Apify.
Cada scan consulta como máximo dos identidades, cuatro ejecuciones entre ambos directorios y dos actores
simultáneos. Cada ejecución solicita como máximo diez registros al actor. En búsqueda por nombre acepta una
coincidencia por objetivo; en fallback por despacho acepta todos los registros devueltos que pertenecen a ese
despacho, porque son evidencia de una sola ejecución ya pagada. Run ID, fingerprint de consulta, conteos y coste reportado quedan junto a la evidencia.
Los mensajes conocidos de cero resultados son `EMPTY/NO_MATCH`; errores de actor o contrato permanecen errores.
Las respuestas originales disponibles se guardan con hash SHA-256 antes de devolver el resultado.
El pipeline reserva 5 segundos de sus 55 segundos para persistencia y cancela fuentes al agotar su plazo.
Si no puede persistir evidencia, el scan termina FAILED en vez de publicar un resultado sin respaldo.
La escritura de estado HTTP tiene además el timeout de Supabase de 5 segundos.
El servidor recupera scans RUNNING interrumpidos al arrancar y periódicamente.

El baseline `supabase/migrations/20260908151940_create_layer1.sql` crea `scans` y `scan_raw_data`
en una base vacía. Activa RLS, restringe acceso directo de anon/authenticated y concede acceso al service role.
No adapta una base con tablas antiguas. Para un Supabase local nuevo (requiere Docker):

```powershell
npx supabase start
npx supabase db reset --local
```

El contenedor de producción usa Node 22, Chromium y un runtime no-root. La demo AWS usa una única EC2
con ECR, Elastic IP, SSM y Caddy; no crea load balancer. El procedimiento está en
[`AWS_DEMO_RUNBOOK`](docs/deployment/AWS_DEMO_RUNBOOK.md).
Mantener secretos solo en backend y CORS con orígenes exactos.
Los orígenes habilitados para la demo son `http://localhost:3000` y `https://arcacover.com`;
subdominios, otros puertos y variantes HTTP no se aceptan implícitamente.
`TRUST_PROXY_HOPS=0` utiliza la conexión directa; configurar otro valor solo para una topología conocida
sin acceso directo que eluda el proxy. El rate limiter y la ejecución en proceso requieren una sola instancia;
escalar horizontalmente necesita almacenamiento compartido para límites y coordinación de trabajos.

La especificación para reemplazar el contenedor prototipo y desplegar la demo está en
[DEMO_CONTAINERIZATION_SPEC](docs/deployment/DEMO_CONTAINERIZATION_SPEC.md).

## Validación

```powershell
npm run build
npm test
npm run test:coverage
```

Las pruebas cubren matemáticas, incertidumbre, identidad, sesiones, caché, límites, pipeline,
proveedores simulados, Chromium real con transporte de fixtures y el SQL/RLS en PostgreSQL embebido (PGlite).
La prueba de crawling necesita Chromium instalado. Los tests no consumen APIs pagadas.
El modo real, incluyendo la extracción por reglas y el despliegue, requiere validación con sus credenciales
e infraestructura. Supabase se valida directamente con `npm run db:verify`; el script escribe registros
sintéticos, comprueba evidencia/caché y elimina únicamente esos registros. El adaptador OpenAI no forma parte
de la validación inicial.
Los documentos históricos de `private` se conservan sin cambios.


## Layer 2: cuestionario adaptativo de demostración

El backend incluye el banco fijo versionado, planificador por reglas (agente opcional), validación
por tipo, preguntas condicionales, guardado auditado y resultado determinista de Layer 2.
El banco y la fórmula compuesta son fixtures de ingeniería pendientes de aprobación de negocio:
todos los resultados bloquean la decisión comercial automática. La evidencia pública no acredita
por sí sola prácticas internas ni contesta preguntas sin confirmación.

Usar `SOURCE_MODE=mock`, `STORAGE_BACKEND=memory` y `ASSESSMENT_PLANNER=rules` para desarrollo sin
servicios externos. El modo memory pierde los datos al reiniciar el proceso; el adaptador Supabase
usa una migración nueva con CAS y transacciones para persistencia durable.

Las seis rutas nuevas se documentan en Swagger y en
[Layer 2: operación, persistencia y límites](docs/LAYER2_ASSESSMENT.md). Usan el mismo Bearer del scan,
con una ventana de 24 horas, creación/completado idempotentes y registro de invalidaciones cuando
una pregunta deja de ser visible. Un assessment completado tiene su informe PDF
(`GET /assessment/:assessmentId/report.pdf`, ver la sección "Assessment report" de
[LAYER2_ASSESSMENT.md](docs/LAYER2_ASSESSMENT.md)). Los enlaces de reanudación quedan fuera de esta entrega.
