# DN-12 · Hallazgos del scan en vivo

- **Fecha:** 2026-11-09
- **Estado:** hecho en las dos ramas, sin publicar. Cada arreglo tiene su sección (§3 a §8); la verificación
  conjunta en mock está en §10. La §12 (2026-11-12) trata la evidencia insuficiente y la §13 los arreglos tras dos scans en vivo de una firma grande
  que dieron scores distintos. La §14 (2026-11-17) sustituye a D4: una web ilegible, por cualquier causa del sitio,
  es confianza baja y no alto riesgo.
- **Repos:** `Arca-back` y `Arca-front`, rama `fix/live-scan-findings` en ambos
- **Parte de:** DN-07 de crawl (§6, robots y web ilegible), DN-09 (modos), DN-10 y DN-11 (webapp)

Las marcas siguen la convención de DN-10: **[Jesús]** decidido por Jesús, **[mía]** decidido por
Claude y revisable.

## 1. Por qué

El 2026-11-06 Jesús hizo un scan real en `live-debug` y anotó seis hallazgos:

| # | Hallazgo | Qué era |
|---|---|---|
| F1 | No vio cómo exportar el PDF | En Capa 1 existe, pero es un enlace tenue al final de `/score`. En Capa 2 no hay PDF |
| F2 | No hay forma de registrarse al terminar | Por diseño: la webapp solo existe en mock (DN-10). En `live-debug` nada lo dice |
| F3 | Demasiados avisos de demo y mensajes internos | El aviso de datos provisionales se repite muchas veces por pantalla, y se ven flags de máquina |
| F4 | "Algo pasó con robots.txt", y qué pasa si la web no se puede leer | La gestión de robots era más estricta que el RFC, y una web ilegible terminaba FAILED sin salida |
| F5 | El mismo despacho debería dar el mismo score | Un PARTIAL se vuelve a ejecutar cada hora, con un crawl y una extracción nuevos |
| F6 | Control de coste | No hay tope de gasto por scan |

Una investigación de solo lectura explicó cada uno antes de tocar código.

Dato fijado después: el scan de Jesús **no tuvo ningún problema de robots**. Su website salió `partial`
por un enlace muerto (HTTP 404) y un script de terceros que no resolvió DNS, con 19 páginas leídas bien.
Los arreglos de robots de §3.1 son endurecimiento, no la causa de lo que vio.

## 2. Decisiones

| # | Decisión | Quién |
|---|---|---|
| D1 | `robots.txt` sigue RFC 9309: 2xx se interpreta; un 4xx distinto de 429 significa que no hay reglas; 429, 5xx, error de red, bucle de redirecciones o timeout significan inalcanzable (no se lee nada, causa transitoria). Nunca se suplanta el User-Agent de un navegador | **[mía]** |
| D2 | Una página decidida o muerta (enlace excluido por robots, 404/410, contenido que no es HTML) y un subrecurso de terceros fallido se anotan, pero no dejan el crawl `partial`. `partial` queda para el plazo y para fallos del propio sitio que agotaron sus reintentos | **[mía]** |
| D3 | Todo resultado de cero páginas se clasifica una vez, en un solo sitio: DEFINITIVE (robots excluye el sitio, 401/403 o página de desafío) o TRANSIENT (abort, plazo, error de red, robots inalcanzable, 429, 5xx, errores del proveedor) | **[mía]** |
| D4 | Una web ilegible DEFINITIVE ya no hace fallar el scan: termina PARTIAL, con el resultado completo marcado de alto riesgo usando solo valores que el contrato ya tenía, el flag `WEBSITE_UNAVAILABLE` y un override `REFERRAL_SENIOR`. La Capa 2 puede empezar desde ahí. Lo transitorio y lo nuestro sigue FAILED ("try again"). **Sustituida el 2026-11-17 por §14** | **[mía]** |
| D5 | Mismo despacho, mismo score: dentro de la ventana de caché (7 días) el resultado guardado es la respuesta, también un PARTIAL de causa estructural o definitiva. La reparación de 1 hora queda solo para causas transitorias. Para forzar otra ejecución se usan variables de entorno, sin cabecera nueva | **[mía]** |
| D6 | Ningún cambio en `packages/contracts/src` que altere el formato, ninguna versión nueva, y `LAYER1_CONTRACT_VERSION` no se toca (la caché de scans filtra por ella). Flags, ids de override y motivos son texto libre y se usan | **[mía]** |
| D7 | Solo en `live-debug`, la webapp corre sobre el repositorio en memoria con login y pago simulados, leyendo scans y assessments de los repositorios reales, y dice que es simulada. La semilla de demo sigue solo en mock. Producción no cambia: 501 y ningún control de registro | **[Jesús]** |
| D8 | Textos: un solo aviso de demo por pantalla en Capa 2, avisos de evidencia más simples en `/score`, y el PDF como botón con etiqueta en `/score` y en `/assessment/results`. La banda de debug y el panel State se quedan como están | **[Jesús]** |

Nombres fijados entre repos: flag e id de override `WEBSITE_UNAVAILABLE`; ruta
`GET /assessment/:assessmentId/report.pdf`; dominio mock `blocked.arca.example`.

## 3. Web que no se puede leer (F4)

### 3.1 Robots y qué deja el crawl `partial` (D1, D2)

Hecho. El detalle está en el DN-07 de crawl, §6.

### 3.2 Definitiva o transitoria (D3)

Hecho. `website-outcome.ts` elige el código según la causa y `classifyUnreadableWebsite`
(`@arca/scoring`) clasifica solo por el código: DEFINITIVE es `error` con `ACCESS_BLOCKED`, y todo lo
demás es TRANSIENT. La tabla de causas está en el DN-07 de crawl, §6.

### 3.3 Scan PARTIAL de alto riesgo (D4)

> **Sustituida por §14 (2026-11-17).** Lo que sigue es la historia de D4. Hoy cualquier causa del sitio termina
> PARTIAL, sin override ni grupo de mayor riesgo, y la Capa 2 puntúa solo con las respuestas.

Hecho en el back.

**Antes.** Sin web no hay identidad, Bar y Avvo se omiten y ninguna fuente sirve. El scan terminaba
FAILED, el resultado ya calculado se descartaba, el assessment no podía empezar y el visitante solo veía
"try another scan".

**Ahora.** `in-process-pipeline.ts` pregunta a `classifyUnreadableWebsite`:

| Web | Scan | Resultado |
|---|---|---|
| Leída (`ok` o `partial`) | Como antes | Como antes |
| DEFINITIVE | **PARTIAL** | Completo y guardado; el assessment puede empezar |
| TRANSIENT o fallo nuestro | FAILED | Ninguno; se reintenta |

El resultado de una web DEFINITIVE usa solo valores que el contrato 0.4.0 ya tenía:

- `preScore.total` con lo que se sabe (0 si no hay más fuentes) y `tier` por las bandas de siempre, que
  con 0 es `CRITICAL`;
- `confidence: LOW`, `assessmentStatus: INSUFFICIENT_EVIDENCE` y los flags `INCOMPLETE_SOURCES`,
  `INCOMPLETE_EVIDENCE` y `COMMERCIAL_DECISION_BLOCKED`;
- el flag `WEBSITE_UNAVAILABLE`;
- el override `{ id: 'WEBSITE_UNAVAILABLE', decision: 'REFERRAL_SENIOR', reason: 'The firm website could not be read' }`,
  que deja `decision` en `REFERRAL_SENIOR`. Solo restringe: un `DECLINE` disciplinario se queda en `DECLINE`;
- `sources.website` con `error` / `ACCESS_BLOCKED` y el motivo real; Bar y Avvo `skipped` /
  `INSUFFICIENT_IDENTITY`, con coste 0.

El flag y el override los pone `scoreEvidence` (`packages/scoring/src/score.ts`), no el pipeline. Por eso
también aparecen si la web es DEFINITIVE y un directorio resultó utilizable, cosa que el pipeline real no
produce hoy porque sin web no consulta directorios.

**Coste.** Una web DEFINITIVE no llama a OpenAI ni a Apify: no hay páginas que extraer ni identidad que buscar.

**Capa 2.** `layer2.ts` no cambió. Ya copiaba los flags de Capa 1 y conservaba los overrides restrictivos,
y ahora hay tests que lo prueban: con las mejores respuestas, el resultado sigue con `decision: REFERRAL_SENIOR`
y el flag. El compuesto es 0 × 0,3 + Capa 2 × 0,7, así que llega como mucho a 70.

**Límite conocido.** Con respuestas perfectas el resultado de Capa 2 muestra 70 y `FORTIFIED`, y ninguna
pantalla lee hoy `decision` ni `overrides`. Que el visitante vea que su web no se pudo leer depende del aviso
del front (§8).

**PDF de Capa 1.** Cuando el resultado lleva el flag, `report/quick-scan.ts` pone el aviso de `/score` en tercera
persona en lugar del aviso genérico de fuentes incompletas. Con tier `CRITICAL` (en la práctica, siempre con este
flag): "We could not read the firm's website during the scan. What we could not verify counts as unknown, which
places the firm in the highest-risk group for now. Answers to the assessment also count, and because the website
could not be read, the case will need a manual review." Con otro tier, la misma frase sin el grupo: "...What we
could not verify counts as unknown. Answers to the assessment also count, ...". No nombra decisión ni precio. La
frase que dice que no hay decisión de suscripción sigue debajo.

**Regla del texto (revisión del 2026-11-10, igual en los dos repos).** El grupo de riesgo sigue al score, también al
compuesto de Capa 2: unas respuestas buenas pueden sacar al despacho de `CRITICAL` y unas flojas no. Por eso ningún
texto promete que completar el assessment lo saque del grupo, ni que el grupo se mantenga "whatever your answers
show". Lo único que se mantiene diga lo que diga el cuestionario es la revisión manual (el override
`REFERRAL_SENIOR`). Antes el PDF decía "until the assessment is completed" y el de Capa 2 "stays in the
highest-risk group ... whatever the answers show"; las dos cosas eran falsas para alguna combinación de respuestas.

**Mock y debug.**

| Qué | Causa | Scan |
|---|---|---|
| `blocked.arca.example` (nuevo) | robots.txt excluye el sitio: `ACCESS_BLOCKED`, definitiva | PARTIAL, alto riesgo |
| `failed.arca.example` | No se pudo llegar a la web: `PROVIDER_ERROR`, transitoria. Antes su fixture decía `ACCESS_BLOCKED` | FAILED |
| Eje `website: blocked` | `ACCESS_BLOCKED`, definitiva | PARTIAL, alto riesgo |
| Eje `website: error` | `PROVIDER_ERROR`, transitoria | FAILED |
| Eje `website: timeout` | `DEADLINE_REACHED`, transitoria | FAILED |
| Eje `website: no_identity` | No es una web ilegible: se leyó | PARTIAL, como antes |

El preajuste "Every source down" usa `website: error`, así que sigue dando FAILED. No se añadió ningún
preajuste para la web bloqueada: los preajustes viven en `@arca/contracts/debug` y D6 no deja tocarlo. El eje
`blocked` ya se puede elegir en el panel.

**Caché.** Un PARTIAL de web bloqueada es de causa definitiva, así que se sirve de la caché de scans durante
toda la ventana de 7 días (D5, §4.2).

**Tests.** `packages/scoring/tests/unreadable-website.test.ts`, `apps/api/tests/unit/pipeline.test.ts`
(definitiva frente a transitoria, con el website source real sobre un crawl inyectado),
`apps/api/tests/integration/unreadable-website.test.ts` (por HTTP: scan, poll PARTIAL, PDF, assessment
completo y `failed.arca.example` FAILED, todo validado con los esquemas estrictos de 0.4.0),
`mock-scenarios.test.ts`, `debug-mode.test.ts`, `debug-sources.test.ts` y `report.test.ts`.

**Front.** Hecho: la lista de dominios mock, el texto de la pantalla FAILED (ya no es "la web nos bloqueó") y el
aviso de web ilegible en `/score` y en `/assessment/results` (§8).

## 4. Mismo despacho, mismo score (F5, D5)

Hecho en el back. La garantía tiene tres capas, de arriba abajo:

| Capa | Qué garantiza | Dónde |
|---|---|---|
| Caché de scans | Dentro de la ventana (`SCAN_CACHE_TTL_MS`, 7 días) el resultado guardado **es** la respuesta, también un PARTIAL de causa estructural o definitiva | `apps/api/src/http/scan-cache.ts`, usado por `startScan` en `app.ts` |
| Señales del website | Si el scan se vuelve a ejecutar y el sitio dice lo mismo, se reutiliza el análisis guardado: mismas señales, misma identidad, mismas consultas a Apify, cero llamadas al modelo | `apps/api/src/pipeline/website-source.ts` |
| Scoring | La misma evidencia da el mismo resultado en cualquier orden | `packages/scoring` (DN-03, "Mismo resultado en cualquier orden") |

Solo la primera capa garantiza el caso de Jesús. Las otras dos hacen que una re-ejecución (reparación,
fin de la ventana, ejecución forzada) cambie el score solo cuando cambió algo real.

### 4.1 Qué pasaba

Un PARTIAL se servía de caché 1 hora y después se re-ejecutaba entero: crawl nuevo y extracción nueva con un
modelo de razonamiento sin semilla. El scan de Jesús era PARTIAL por causas que ningún reintento arregla
(Avvo omitido porque la web no muestra ciudad ni abogados), así que nunca podía llegar a COMPLETED y cada
hora volvía a tirar los dados.

### 4.2 Tabla de causas (D5) **[mía]**

La tabla está escrita una sola vez, en `scan-cache.ts`. Lee solo `status` y `code` de cada fuente del
resultado guardado: el código lo elige quien construye el estado según la causa, igual que en §3.2.

**Website**

| Estado guardado | Clase | Por qué |
|---|---|---|
| `ok` | — | Se leyó entero |
| `partial` sin código | ESTRUCTURAL | Se leyó hasta donde el sitio deja: una página responde 401/403 o un desafío (con cualquier estado) o da otro 4xx. El crawler no reintenta esas páginas y un segundo scan tampoco las leería |
| `partial` + `DEADLINE_REACHED` | TRANSITORIA | El plazo cortó el crawl |
| `partial` + `PROVIDER_ERROR` | TRANSITORIA | Una página propia falló por algo pasajero y agotó sus reintentos (error de red, 5xx, 429, robots inalcanzable para esa página), o vino sin texto legible |
| `error` + `ACCESS_BLOCKED` | ESTRUCTURAL | El resultado `WEBSITE_UNAVAILABLE` (D4) |
| Cualquier otro `error` o `timeout` | TRANSITORIA | En la práctica el scan terminó FAILED y no está en la caché |

**Bar y Avvo**

| Estado guardado | Clase | Por qué |
|---|---|---|
| `ok` (con o sin `NO_MATCH`) | — | Respondió |
| `skipped` + `INSUFFICIENT_IDENTITY` | ESTRUCTURAL | No hay a quién buscar: la web no muestra abogados ni ciudad |
| `NO_MATCH` en un estado que no es `ok` | ESTRUCTURAL | Nadie coincide |
| `partial` + `TRUNCATED` | ESTRUCTURAL | Página de resultados llena. El run de Apify queda cacheado 7 días, así que repetir da lo mismo |
| `timeout`, o cualquier estado con `DEADLINE_REACHED` | TRANSITORIA | Plazo |
| `PROVIDER_ERROR` | TRANSITORIA | Fallo del proveedor, incluido el límite de uso de Apify |
| `PROVIDER_CONTRACT_ERROR` | TRANSITORIA | El actor devolvió otra forma: es un fallo del proveedor o nuestro, no un dato de la firma |
| Sin código, o un código desconocido | TRANSITORIA | Ante la duda se repara, que es lo que se hacía con todo PARTIAL |

La clase del resultado es la peor de las tres fuentes: **una sola causa transitoria basta para repararlo**.

| Scan guardado dentro de la ventana | Qué hace `POST /scan` |
|---|---|
| COMPLETED | 200 con el resultado guardado y `cached: true`, como antes |
| PARTIAL, todo estructural | 202 y el resultado guardado llega por polling con `cached: true`, **toda la ventana** |
| PARTIAL con alguna causa transitoria | Igual durante `SCAN_PARTIAL_REPAIR_COOLDOWN_MS` (1 hora) desde que terminó; después se ejecuta de nuevo, y esa ejecución pasa a ser la respuesta |
| FAILED, o nada | Se ejecuta |

**Página vacía. [mía]** Una página propia sin texto legible (`NO_READABLE_CONTENT`) es TRANSITORIA tanto si es todo
el sitio (§3.2, `NO_READABLE_EVIDENCE`) como si el crawl leyó otras páginas: es lo que deja un script que falló una
vez, y las dos situaciones no pueden decir cosas distintas. Hasta la revisión del 2026-11-10 la segunda quedaba sin
código, ESTRUCTURAL, y se fijaba 7 días sin reparación. Ahora lleva `PROVIDER_ERROR` y se repara una vez por cooldown.

Para que la caché pueda distinguir, el website `partial` ahora lleva código (`partialCrawlCode`, en
`website-outcome.ts`). Son valores que el enum del contrato 0.4.0 ya tenía y el front no lee el código de
las fuentes, así que no cambia nada en el formato (D6).

**Resultados guardados antes de este cambio.** Un website `partial` antiguo no lleva código y no puede decir
si lo cortó el plazo o un enlace muerto. **[mía]** Se trata como estructural y se sirve tal cual: lo que D5
protege es el score que el despacho ya vio, la ambigüedad desaparece sola 7 días después del despliegue (esas
filas caducan), y si alguna hiciera falta rehacerla está §4.4. El scan de Jesús (`immigrationlawfla.com`,
2026-11-06: website `partial` con datos y sin código, Avvo `skipped` por `INSUFFICIENT_IDENTITY`, Bar `ok`)
no tiene registrada ninguna causa transitoria, así que **se sirve hasta el final de su ventana**, alrededor
del 2026-11-13 19:32 UTC. De hecho su `partial` era un enlace muerto, que hoy ni siquiera cuenta (D2).

**Riesgo aceptado.** Un resultado mal extraído también queda fijado 7 días, y no hay forma pública de
refrescarlo. La salida es §4.4.

### 4.3 Reutilización de señales del website

Debajo de la caché de scans, `WebsiteExtractionSource` reutiliza el análisis guardado en `scan_raw_data`.
Antes la clave era el sha256 del HTML crudo y solo se miraba la fila más reciente: cualquier nonce o marca
de tiempo obligaba a pagar el modelo otra vez, con otro resultado posible.

- **Clave.** Un hash del contenido propio del despacho tal como lo lee el modelo, no del HTML
  (`corpusFingerprint`, en `evidence-corpus.ts`), más `provider.id` y `provider.version`. Desde el
  2026-11-12 es `wsk2-` y deja fuera lo que cambia sin que cambie el despacho; el detalle está en
  "Clave estable" más abajo.
- **Versión de extracción.** La del extractor agéntico es ahora
  `agentic-signals-v5:openai:<modelo>:<esfuerzo de razonamiento>:<hash>`, donde el hash cubre los cuatro
  prompts y los parámetros de la petición (`extractionVersion`). Editar un prompt invalida los análisis
  guardados sin que nadie tenga que acordarse de subir `EXTRACTION_VERSION`, que sigue siendo manual para
  lo que el hash no ve (el flujo, las reglas de grounding). Los proveedores `openai` (una pasada) y `rules`
  conservan su versión fija.
- **Búsqueda.** El registro guardado lleva dos marcas de texto plano: `wsk2-<hash>` (la clave) y
  `wsf1-<hash>` (versión de extracción, solo si el crawl fue completo). `findRaw` le pide a la base de datos
  las filas del dominio que contienen la marca (un `LIKE` sobre `raw_content`) y devuelve solo ids; después
  `rawOf` lee **una** fila. Un acierto cuesta una lectura grande y un fallo ninguna (antes: una lectura
  grande siempre). Se miran como mucho 3 candidatas.
- **Filas sin análisis.** Una extracción fallida no lleva marca, así que nunca se elige. Una fila dañada o
  de otra versión se salta y se prueba la siguiente.
- **Edad máxima.** `WEBSITE_SIGNAL_REUSE_MAX_AGE_MS`, 30 días, contados desde el día en que el modelo
  produjo el análisis (`reuse.analyzedAt`), no desde la última vez que se reutilizó: reutilizar no
  rejuvenece. `0` desactiva la reutilización.
- **Si falla la búsqueda.** Se registra en el log y se extrae de nuevo. Cuesta una llamada al modelo,
  nunca el scan. Antes, un timeout de Supabase en esa lectura dejaba la fuente en `error`.
- **Nunca a peor.** Si el crawl nuevo quedó `partial` y hay un análisis de un crawl completo dentro de la
  edad máxima (misma versión, con al menos tantas páginas), se conserva ese. El estado sigue describiendo
  el crawl de hoy (`partial`, sus páginas, su código) y el motivo añade "signals kept from the complete
  reading of <fecha>".
- **Sin migración.** Todo vive dentro del JSON de `raw_content`. Las filas anteriores a este cambio no
  llevan marca: la primera re-ejecución de cada dominio extrae una vez y a partir de ahí reutiliza.
- **Auditoría.** La fila que reutiliza guarda `reuse.from` con el scan que pagó la extracción y no copia
  los intentos del modelo (`diagnostics`), que siguen en aquella fila.

**Clave estable (`wsk2-`, 2026-11-12). [mía]** Dos scans en vivo de hklaw.com con diez minutos de diferencia
dieron score 3 y después 0. Los dos crawls leyeron las mismas 20 URLs con el mismo texto salvo un titular del
bloque "Latest News and Headlines", repetido en el índice de noticias y en cada nota de prensa ("How Banks Can
Prepare For Democrats Oversight Era" pasó a "...for Democrats' Oversight Era"). La clave `wsk1-` era un hash
exacto de todo el texto, así que cambió, el modelo volvió a leer el sitio y respondió otra cosa. La clave nueva:

- **Siempre las URLs.** Cada página aporta su URL: una página de más o de menos sigue siendo otra clave.
- **Publicaciones: solo el título.** Una página cuya ruta tiene una sección de publicaciones (`news`,
  `insights`, `events`, `blog`, `press`, `publications`, `alerts`, `noticias`, `eventos`, `prensa`…;
  `isPublicationUrl`) aporta la URL y su `<title>` (o el primer `<h1` si no tiene), nunca el cuerpo: el
  cuerpo y las listas de un índice cambian con cada entrada. El test es propio y no el `pagePriority` del
  crawler, que sirve para otra cosa y puede cambiar. `media` queda fuera a propósito: hklaw.com guarda sus PDF
  bajo `/-/media/files/`.
- **Mobiliario fuera.** Del resto se toman las líneas de texto, los metadatos (título, descripción, JSON-LD) y
  los enlaces, sin los que aparecen en **3 o más páginas** distintas del crawl: navegación, pie, un bloque de
  "últimas noticias". Una página guardada dos veces cuenta una.
- **Texto normalizado.** Mayúsculas, comillas, apóstrofos, guiones tipográficos y espacios no distinguen dos
  lecturas.
- **Registros anteriores.** Una fila `wsk1-` nunca coincide con una clave `wsk2-` (la búsqueda es por la marca),
  así que la primera re-ejecución de cada dominio extrae una vez más y a partir de ahí reutiliza. `wsf1-` no
  depende de la huella y no cambia: una lectura completa guardada con `wsk1-` sigue valiendo para un crawl
  cortado (la fila que la reutiliza copia su `reuse`, con la clave antigua, y la siguiente lectura completa
  extrae).

El test usa una versión reducida de los dos crawls reales (`apps/api/tests/fixtures/hklaw-recrawl.ts`: URLs,
títulos, navegación y una línea por página, sin el texto completo) y comprueba que dan la misma clave y que la
dan distinta un cambio en una página que no es publicación, una página añadida y una quitada
(`evidence-corpus.test.ts`, "corpus fingerprint"; `sources.test.ts`, "website signal reuse"). Contra los dos
registros guardados completos también coinciden.

**Citas que cruzan un corte de segmento (2026-11-12).** En esos mismos dos scans la política de privacidad se
perdía por `QUOTE_NOT_IN_SOURCE`: el aviso en PDF se corta cada ~800 caracteres a mitad de frase y el modelo citaba
el segmento siguiente al que tenía la frase. Ahora una cita vale también en el segmento citado unido a su anterior y
su siguiente de la misma página; nada más se relaja. Detalle y motivo de no tocar la segmentación en DN-05 §5.4.
Con los dos registros guardados, la afirmación de privacidad pasa a `accepted` en ambos.

**Límites conocidos.**

- **El precio de la clave estable.** Un cambio que solo se ve en el mobiliario (un teléfono nuevo en el pie de
  todas las páginas) o en el cuerpo de una publicación (un artículo sobre IA reescrito sin cambiar el título) no
  invalida el análisis guardado; lo acota la edad máxima de 30 días. Un bloque volátil que solo enseñan una o dos
  páginas que no son publicaciones (unas "últimas noticias" solo en la portada) sigue cambiando la clave.
- La clave cubre las páginas del crawl inicial. Lo que el agente lee después (la página "about" que pide
  el plan de páginas, un PDF) queda fuera: un cambio solo ahí no se ve hasta que caduca la edad máxima.
- Sigue dependiendo del conjunto de páginas: un crawl con una página de más o de menos es otra clave. Por
  eso es un ahorro y un estabilizador, no la garantía; la garantía es §4.2.
- El `LIKE` no se pudo probar contra PostgREST real (la única base de datos es producción). El test del
  adaptador fija la consulta exacta que se envía. Si en `live-debug` un segundo scan del mismo sitio vuelve
  a llamar al modelo sin que el texto haya cambiado, hay que mirar esa consulta primero.

### 4.4 Forzar una ejecución nueva

Solo con variables de entorno del arranque, sin cabecera y sin cambio de contrato (D5, D6). Las variables
del shell ganan a `.env.local`, que no se toca.

| Variable | Valor | Efecto |
|---|---|---|
| `SCAN_CACHE_TTL_MS` | `1` | Ningún scan guardado cae dentro de la ventana: todo `POST /scan` ejecuta el pipeline |
| `SCAN_PARTIAL_REPAIR_COOLDOWN_MS` | `0` | Obligatoria junto a la anterior: el cooldown no puede superar al TTL y el arranque lo rechaza |
| `WEBSITE_SIGNAL_REUSE_MAX_AGE_MS` | `0` | Opcional: además el modelo vuelve a leer el sitio. Sin ella se re-ejecuta el crawl pero se reutilizan las señales si el texto no cambió |

En PowerShell, para una sesión de `live-debug`:

```powershell
$env:SCAN_CACHE_TTL_MS='1'; $env:SCAN_PARTIAL_REPAIR_COOLDOWN_MS='0'; $env:WEBSITE_SIGNAL_REUSE_MAX_AGE_MS='0'
npm run stack -- live-debug
```

Después se escanea el despacho una vez, se para el back y se arranca sin esas variables (en una terminal
nueva, o con `Remove-Item Env:SCAN_CACHE_TTL_MS, Env:SCAN_PARTIAL_REPAIR_COOLDOWN_MS, Env:WEBSITE_SIGNAL_REUSE_MAX_AGE_MS`).
El scan nuevo es la fila más reciente del dominio y pasa a ser la respuesta de la ventana.

Lo que estas variables **no** fuerzan: las consultas de Apify. Cada run guarda su caducidad al terminar (7
días), y `APIFY_QUERY_CACHE_TTL_MS` solo afecta a los runs que terminen a partir de ahora. Es deliberado:
esa parte cuesta dinero y la evidencia de un directorio no cambia en días.

Mientras el back corre con esos valores, **todos** los scans se ejecutan de nuevo, no solo el que interesa.
No hay que dejarlos puestos, y nunca van en `deploy/production.env`.

### 4.5 Test de repetición

`apps/api/tests/integration/replay-determinism.test.ts` ejecuta el pipeline real (website source,
extracción agéntica, grounding, cliente y libro de Apify, directorios, scoring) sobre grabaciones, sin red,
sin Chromium y sin proveedores:

- un sitio pequeño escrito a mano (`fixtures/replay/harbor-vale/site.ts`), de una firma que no existe;
- respuestas del modelo indexadas por el hash del prompt (`llm.json`);
- items de Apify indexados por actor e input (`apify.json`).

Comprueba que dos ejecuciones sobre almacenamientos nuevos dan el mismo resultado salvo ids, fechas y
duraciones; que una tercera sobre el almacenamiento de la primera no llama al modelo ni arranca ningún
actor y da el mismo `preScore`, señales y flags; que un crawl con ruido en el HTML (nonce, marca de
tiempo, script) reutiliza las señales, y que un texto cambiado no.

Las respuestas grabadas están **escritas a mano** (`scripted-model.ts`): nunca se llamó a un modelo. Como la
clave es el hash del prompt, el test también avisa de un prompt que cambió: falla y dice cuál. Tras un
cambio deliberado de prompt o de corpus se regraba con
`REPLAY_RECORD=1 npx vitest run apps/api/tests/integration/replay-determinism.test.ts`.

**Otros tests.** `apps/api/tests/unit/scan-cache.test.ts` (cada fila de la tabla),
`apps/api/tests/integration/same-score.test.ts` (por HTTP: COMPLETED, PARTIAL estructural y web bloqueada
devuelven el mismo `preScore` a los 6 días; un PARTIAL transitorio se re-ejecuta al acabar el cooldown),
`flow.test.ts` (la forma del scan de Jesús), `sources.test.ts` ("website signal reuse"),
`website-outcome.test.ts` (el código del `partial`) y `supabase-repository.test.ts` (las dos consultas nuevas).

### 4.6 Lo que queda fuera

- **Procedencia en el resultado** (`meta.evidence` con la versión de extracción y el hash del corpus) y
  una **cabecera de re-ejecución forzada**: las dos necesitan publicar una versión nueva del contrato.
- **Versión de scoring en la clave de caché.** Los resultados guardados conservan el `preScore` con el que
  se calcularon hasta 7 días después de un cambio de scoring. La única palanca de invalidación es
  `LAYER1_CONTRACT_VERSION`, que D6 no deja tocar.
- **Variación del modelo en origen** (semilla, votos): cuesta tokens y no se pudo medir sin llamar a OpenAI.
- **Reglas que dependen de la fecha** (experiencia, antigüedad de una sanción, edad de la firma): usan la
  fecha del scan por diseño (DN-01). Dentro de la ventana no se nota porque se sirve el resultado guardado.

Límites conocidos que la revisión del 2026-11-10 dejó como están:

- **Plantilla cortada y fijada 7 días.** Un run del Bar cortado por su límite de cargo, cuyo coste leyó 0 al terminar,
  deja un scan que usa la plantilla como completa; con D5 ese resultado es la respuesta de toda la ventana, no de
  una hora. La liquidación solo saca la consulta de la caché de Apify, no el scan (§5.1).
- **Filas `partial` antiguas sin código.** Se sirven como ESTRUCTURALES toda su ventana, aunque alguna fuera un plazo
  cortado (§4.2, "Resultados guardados antes de este cambio"); desaparecen solas 7 días después del despliegue.
- **Un sitio que siempre llega al plazo** nunca tiene lectura completa: cada reparación horaria puede volver a pagar
  la extracción y sustituir una lectura parcial más rica por otra más pobre, porque solo se prefiere la completa
  (§4.3).

## 5. Control de coste (F6)

Hecho en el back. Son tres piezas: un techo de gasto de Apify (§5.1), un tope de peticiones a OpenAI por
scan (§5.2) y una línea de log con el coste de cada scan (§5.4). Las dos primeras están **activas por
defecto solo en `live-debug`**. Producción no cambia si su entorno no las fija.

**Decisión. [mía]** El 2026-09-21 se decidió que el gasto de Apify se registra y no se limita (DN-06). Eso
sigue así en producción. `live-debug` es el modo que paga proveedores reales desde la máquina de quien
desarrolla, con USD 20 de crédito de pruebas, y desde hoy trae sus propios guardas.

| Variable | Producción | `live-debug` | `mock` |
|---|---|---|---|
| `APIFY_SPEND_CEILING_USD` | sin valor: sin techo | `2` si no se fija otra cosa | no aplica: no construye cliente de Apify |
| `OPENAI_MAX_REQUESTS_PER_SCAN` | sin valor: sin tope | `30` si no se fija otra cosa | no aplica: no llama a ningún modelo |

Un valor explícito gana en cualquier modo. Una línea vacía en el `.env` cuenta como "sin valor", nunca
como 0. La línea de arranque de `live-debug` dice qué está activo:

```
[api] MODE=live-debug sources=live storage=supabase webapp=simulated-in-memory (debug routes on 127.0.0.1 only) spend guards: Apify ceiling USD 2 per 24 h, OpenAI cap 30 requests per scan
```

(`webapp=simulated-in-memory` es de §7.)

### 5.1 Techo de gasto de Apify

> **Actualización del 2026-11-12 (§13.4 y §13.5).** La reserva ya no es USD 1 para todo run: depende del tipo
> (USD 1 una búsqueda por firma, USD 0,10 una dirigida del Bar, USD 0,40 una dirigida de Avvo), y el techo
> exige que quepa cada una. Un arranque cuyo nombre de host no resolvió no salió de la máquina: se reintenta y,
> si nunca resuelve, cuenta 0 en vez de quedar `START_UNCERTAIN`. Las tablas de abajo describen el 2026-11-09;
> donde dicen `APIFY_EXPECTED_COST_USD_PER_RUN` o USD 1, léase la reserva del tipo de run.

**Qué pasaba.** Desde el 2026-09-21 el gasto de Apify se registra en el ledger pero nada lo limita (DN-06;
DN-08, "Riesgos y decisiones pendientes", punto 2). Un scan lanza un run por abogado y por directorio (2N runs), y cuando la web da nombre de
firma pero ningún abogado lanza una sola búsqueda por firma en el Bar que pide hasta 1.000.000 de
abogados. Ese run era el único capaz de gastar por sí solo los USD 20 de crédito de pruebas.

**Ahora.** Antes de arrancar un run, `ApifyClient` suma lo que el ledger tiene comprometido en las últimas
24 horas y lo rechaza si su reserva ya no cabe bajo el techo. El rechazo ocurre **antes de enviar ninguna
petición a Apify**.

Cómo cuenta cada fila de `apify_runs` (`committedUsd`, en `apify-client.ts`):

| Fila | Cuenta |
|---|---|
| Liquidada (`accounting_complete`) | Lo que Apify cobró (`cost_usd`) |
| Arrancada y sin liquidar (en vuelo o terminada) | Su reserva entera (`reserved_usd`, `APIFY_EXPECTED_COST_USD_PER_RUN`, 1 USD), o el coste ya leído si es mayor |
| Reservada y a punto de arrancar | Su reserva, hasta que caduca |
| Arranque sin respuesta (`START_UNCERTAIN`: la petición salió y la respuesta se perdió) | Su reserva, durante toda la ventana de 24 horas |
| Nunca arrancada (rechazada por el límite de uso o por Apify con un error HTTP, nombre de host sin resolver, caducada) | 0 |
| Rechazada por el techo | No se lee |

La regla es: `comprometido por las demás filas + reserva de este run > techo` significa rechazo.

- **Las consultas cacheadas no cuentan de nuevo y se siguen sirviendo**, también con el techo agotado. Una
  consulta cacheada es una fila del ledger: se cuenta una vez, la sirva quien la sirva.
- **La suma es del ledger, no de la memoria del proceso.** Incluye lo que arrancó este proceso, uno anterior
  (el back se reinicia con cada cambio de código) y cualquier otro que escriba en la misma base.
- **Sin migración.** Es un `select` de ocho columnas sobre `apify_runs`, sin `items` y sin las filas que el
  techo rechazó, solo cuando un run va a arrancar y solo si hay techo. Producción sin techo no hace esa
  lectura.
- **Con `0` no arranca ningún run** y se sirve solo lo cacheado. Sirve para una sesión de `live-debug`
  que no debe gastar nada en Apify.

**Qué ve el scan.** El directorio termina con `PROVIDER_ERROR` y el motivo `Apify spend ceiling reached;
lookups it had no room for were not started`. Es una causa transitoria en la tabla de §4.2, así que el scan
queda PARTIAL, no se concluye nada sobre la firma (ni flag ni override) y la caché lo repara pasado el
cooldown. A diferencia del límite de uso de Apify, el techo **no para la cola** del directorio: cada búsqueda
se intenta, las cacheadas se responden gratis y las demás se rechazan sin petición.

**Qué dice el log**, como mucho una vez por minuto:

```
[apify] Apify spend ceiling reached: USD 2.00 held by the ledger over the last 24 hours, the ceiling is USD 2.00 and a run reserves USD 1.00 (APIFY_SPEND_CEILING_USD, APIFY_EXPECTED_COST_USD_PER_RUN). No new run starts; cached queries are still served.
```

**Límite de cargo por run.** Con techo, cada run arranca con `maxTotalChargeUsd` igual a **su reserva**
(`APIFY_EXPECTED_COST_USD_PER_RUN`, USD 1 por defecto, en centavos enteros). Va en la URL del arranque, no en
el input: **el input guardado y el fingerprint de la consulta son los mismos con o sin límite**, así que los
runs cacheados antes de este cambio siguen valiendo (hay un test que lo fija). Es lo que acota la búsqueda
por firma: su input no se tocó y sigue pidiendo 1.000.000 de abogados, pero el run no puede cobrar más de
su reserva.

Por qué la reserva y no lo que al techo le queda (la primera versión enviaba eso). Cada run sin liquidar
cuenta su reserva, así que varios runs admitidos a la vez recibían cada uno casi todo el techo como límite:
C, C − r, C − 2r… La revisión lo midió con 30 búsquedas por firma simultáneas sobre el cliente real y un
transporte falso: con techo 2 y reserva 1 los límites sumaban USD 3; con techo 5 y reserva 0,5 (la
configuración que esta nota recomendaba para una firma con plantilla) sumaban USD 27,50, más que los USD 20
de crédito; con techo 20 y reserva 1, USD 210. Con la reserva como límite, **los límites de los runs que
este proceso tiene sin liquidar nunca suman más que el techo**, con cualquier configuración; un test lo fija
con 2/1, 5/0,5, 20/1 y 2/0,3. Mientras no se liquida, un run de este proceso cuenta además, como mínimo, el
límite con que arrancó (solo difiere de la reserva si esta es menor de un centavo).

Un run que gasta todo su límite pudo parar antes de tener todas las filas. Sus filas se conservan como
evidencia parcial para ese scan (el directorio queda `partial`, causa transitoria) y **la consulta no se
cachea**. Se comprueba dos veces: al terminar el run y otra vez cuando se liquida su coste, porque el coste
leído al terminar puede ser 0.

**Cuántos runs caben.** Cada run sin liquidar cuenta su reserva entera, y Apify tarda unos tres minutos en
liquidar (dos de espera más el siguiente pase de `reconcileCosts`, que corre cada minuto mientras el back
siga encendido).

| Configuración | Runs nuevos que caben hasta que se liquiden | Lo más que puede cobrar cada uno |
|---|---|---|
| Por defecto (`2` y reserva `1`) | 2. Es el scan de Jesús (una búsqueda por firma en el Bar) o una firma de un abogado (Bar y Avvo) | USD 1 |
| `APIFY_SPEND_CEILING_USD=5` | 5 | USD 1 |
| `APIFY_SPEND_CEILING_USD=5` y `APIFY_EXPECTED_COST_USD_PER_RUN=0.5` | 10: cinco abogados en los dos directorios | USD 0,50 |
| `APIFY_SPEND_CEILING_USD=5` y `APIFY_EXPECTED_COST_USD_PER_RUN=2.5` | 2: una búsqueda por firma grande y poco más | USD 2,50 |
| `APIFY_SPEND_CEILING_USD=0` | 0: solo caché | — |

Una vez liquidados cuentan por lo que costaron de verdad. Lo observado hasta hoy son dos datos: USD 0,045
por un run del Bar con 1 resultado y USD 0,38475 por uno de Avvo con 10. El techo por defecto es estrecho a
propósito: para una firma con plantilla hay que subirlo a mano y sabiendo cuánto se va a gastar.

**Cómo elegir.** La reserva es a la vez lo que cada run aparta del techo y lo más que puede cobrar. Bajarla
deja caber más runs, pero cada uno puede cobrar menos: con `0.5`, una búsqueda dirigida del Bar que devuelva
sus 25 resultados detallados (unos USD 0,04 por resultado, extrapolando del único dato) puede quedarse corta,
y una búsqueda por firma se corta hacia los 11 abogados. Subirla deja llegar más lejos a la búsqueda por
firma a cambio de menos runs a la vez. Un run cortado no se cachea y su directorio queda `partial` por causa
transitoria (arriba). En ninguna fila los límites en vuelo suman más que el techo.

En PowerShell, para una sesión:

```powershell
$env:APIFY_SPEND_CEILING_USD='5'; $env:APIFY_EXPECTED_COST_USD_PER_RUN='0.5'
npm run stack -- live-debug
```

**Decisiones. [mía]**

- **La reserva entera hasta liquidar**, no el coste leído al terminar el run. Ese coste llega tarde y lee de
  menos: un run del Bar lee 0 al terminar (el de Jesús leyó 0 y se liquidó en USD 0,045), y un scan en vivo
  de septiembre leyó ocho veces menos de lo cobrado. Con el coste provisional, un scan de 25 abogados habría
  pasado entero bajo un techo de 2.
- **Ventana de 24 horas sobre el ledger**, no un contador en memoria: el back se reinicia con cada cambio y
  un contador en memoria volvería a cero.
- **Un techo menor que la reserva de un run no arranca el back** (salvo `0`): ningún run cabría nunca y
  parecería un presupuesto. El error dice qué variable cambiar.
- **Si el ledger no se puede leer, el run no arranca** (`PROVIDER_ERROR`, sin cooldown para la consulta). Un
  techo que deja pasar cuando no puede sumar no es un techo.
- **El límite de cada run es su reserva**, no lo que al techo le queda: es lo único que mantiene la suma de
  los límites en vuelo por debajo del techo sin parar la concurrencia. Contar cada run por su límite y darle
  lo que queda dejaría un solo run a la vez y rechazaría el segundo directorio de una firma de un abogado.
- **Producción no lo usa.** La decisión del 2026-09-21 sigue vigente allí. Quien fije
  `APIFY_SPEND_CEILING_USD` en producción obtiene el techo y también el límite por run, con el riesgo de
  plantillas cortadas que se describe abajo.

**Límites conocidos.**

- **No se pudo comprobar que los dos actores respeten `maxTotalChargeUsd`**: habría hecho falta un run de
  pago. El código anterior al 2026-09-21 ya lo enviaba en cada arranque, con USD 1 por run. El freno
  duro sigue siendo el límite de uso de la cuenta, que se fija en la consola de Apify; el back ya trata ese
  corte como causa transitoria.
- **Si `live-debug` y producción comparten base de datos**, el gasto de producción de las últimas 24 horas
  también cuenta contra el techo de `live-debug`. Es conservador, pero puede rechazar todo un día con tráfico
  real. La salida es subir el techo o usar una base separada (DN-09 §11.7).
- **La comprobación se hace de una en una dentro del proceso, no entre procesos.** Dos back sobre el mismo
  ledger que arranquen un run en el mismo instante pueden admitir uno de más cada uno: el exceso es de una
  reserva por proceso, no más, porque cada run arrancado con techo lleva su reserva como límite.
- **Un run arrancado sin techo no lleva límite.** Si producción comparte el ledger, sus runs sin liquidar
  cuentan su reserva pero pueden cobrar más; la cuenta lo corrige al liquidarse.
- **Una plantilla cortada por el límite.** Afecta a la búsqueda por firma de una firma con muchos abogados
  (con la reserva por defecto de USD 1, del orden de 20, extrapolando del único run del Bar medido) y, con
  una reserva baja, a una búsqueda dirigida con muchos resultados (ver "Cómo elegir"). Si el coste al
  terminar leyó 0, el corte no se ve hasta la liquidación: ese scan usó el dataset como completo y su
  resultado queda en la caché de scans. La consulta sí deja de reutilizarse en cuanto se liquida.
- **El límite con que arrancó cada run vive en memoria.** Tras un reinicio, la segunda comprobación (al
  liquidar) no existe para los runs anteriores.
- **Un arranque sin respuesta cuenta su reserva 24 horas.** Si la petición de arranque salió y la respuesta
  se perdió (red, plazo del scan), no hay id de run que liquidar: puede que Apify no arrancara nada, o que
  arrancara un run que cobra hasta su límite. Se cuenta lo segundo durante toda la ventana, también si otro
  scan viene a retomarlo. Es conservador. Un error HTTP de Apify, en cambio, prueba que no arrancó y cuenta 0.
- **Más de 1.000 runs en 24 horas** no se pueden sumar con una lectura: el run se rechaza. Los rechazos del
  techo no cuentan para ese límite (la lectura los deja fuera), así que una plantilla larga rechazada scan
  tras scan no llena la ventana. Las filas de producción sobre una base compartida sí cuentan.

### 5.2 Tope de peticiones a OpenAI por scan

**Qué pasaba.** La extracción agéntica está acotada en rondas (3), no en llamadas: cada fase puede añadir
una reparación y hasta tres intentos ante un 5xx. La mayor extracción grabada (25 abogados) hizo 12
llamadas; reparando todas sus fases habrían sido 26.

**Ahora.** `AgenticEvidenceProvider` cuenta las chat completions de cada extracción, reintentos y
reparaciones incluidos, y con `OPENAI_MAX_REQUESTS_PER_SCAN` se niega a enviar la que pasa del tope. La
cuenta es por scan: el proveedor es un objeto compartido y dos scans simultáneos no se la reparten.

| Qué | Resultado |
|---|---|
| Dentro del tope | Nada cambia |
| Pasa del tope | La extracción falla con `OpenAI request cap reached: one scan may make 30 chat completions`. Ninguna petición más sale |
| Website source | `error` / `PROVIDER_ERROR`, motivo `Website evidence extraction unavailable`: transitoria (§3.2) |
| Scan | FAILED, "try again": sin web no hay identidad y los directorios se omiten. No se concluye nada sobre la firma |
| Evidencia guardada | `diagnostics.error` con el mensaje del tope; el API no lo devuelve |
| Log | `[openai] request cap reached: ...`, una vez por extracción |

- **No forma parte de la versión de extracción.** El tope cambia cuándo para una extracción, no lo que dice
  una que terminó: los análisis guardados se siguen reutilizando igual (§4.3). Hay un test que lo fija.
- **30 por defecto en `live-debug`. [mía]** Es más del doble de lo esperado (entre 5 y 13 según el tamaño de
  la firma; la única medida real son esas 12) y está por encima de las 26 del peor caso. Corta un bucle, no
  un scan normal.
- **Fuera.** Los tokens no se limitan, solo se cuentan (§5.4). El planner de Capa 2 (`ASSESSMENT_PLANNER=agent`,
  como mucho 2 llamadas por assessment) y el proveedor `openai` de una pasada (1 llamada) no lo necesitan.

### 5.3 Qué hacer antes de un scan real

1. Fijar el límite de uso de la cuenta en la consola de Apify. Es el único freno que también cubre scripts,
   producción y errores fuera de este código. **Lo hace Jesús**; desde aquí no se puede.
2. Arrancar `live-debug` y leer la línea de arranque: debe nombrar los dos guardas.
3. Para no gastar nada en Apify, `APIFY_SPEND_CEILING_USD=0`. Para una firma con plantilla, subir el techo
   con la tabla de §5.1.
4. Dejar el back encendido al menos tres minutos después del scan, para que el coste se liquide y el techo
   cuente lo real en vez de la reserva.

### 5.4 Línea de coste por scan

Cada ejecución del pipeline deja **una** línea en el log, termine como termine:

```
[scan-cost] {"scanId":"sc_cost1","status":"COMPLETED","durationMs":0,"apify":{"started":4,"refused":0,"resumed":0,"chargedUsd":0.1,"reservedUsd":4,"cachedUsd":0},"openai":{"requests":7,"inputTokens":7000,"outputTokens":1400},"cacheHits":{"apifyRuns":0,"websiteAnalysis":false}}
```

Esa es la línea del test de integración, con grabaciones escritas a mano y el reloj fijo: no son cifras de
un scan real.

| Campo | Qué es |
|---|---|
| `scanId`, `status`, `durationMs` | El scan, cómo terminó (`FAILED` también si el pipeline lanzó una excepción) y cuánto duró |
| `apify.started` | Runs que este scan arrancó: los que cuestan |
| `apify.refused` | Búsquedas que el techo rechazó |
| `apify.resumed` | Runs de otro scan que este retomó |
| `apify.chargedUsd` | Lo que Apify había informado al terminar esos runs. **Es un suelo**: los cargos se liquidan minutos después |
| `apify.reservedUsd` | Lo que el ledger reserva por esos runs hasta que se liquiden. Es lo que cuenta contra el techo |
| `apify.cachedUsd` | Lo que costaron en su día las respuestas servidas de la caché. Este scan no pagó nada por ellas |
| `openai.requests` | Chat completions pedidas por la extracción del website |
| `openai.inputTokens`, `outputTokens` | Suma de lo que informó cada respuesta; `null` si ninguna lo informó |
| `cacheHits.apifyRuns` | Consultas de directorio servidas de la caché |
| `cacheHits.websiteAnalysis` | `true` si se reutilizó el análisis guardado (§4.3) y el modelo no leyó el sitio |

- **Sin email, sin dominio y sin claves.** El scan se nombra solo por su id, como en los demás logs.
- **Una por ejecución del pipeline.** Un scan servido de la caché de scans no ejecuta el pipeline y no deja
  línea. Dos peticiones del mismo dominio que comparten una ejecución dejan una, con el id de la primera.
- **En todos los modos**, también en producción y en mock (donde todo vale 0).
- **Una fuente cortada por el plazo** se cuenta hasta el momento de escribir la línea.
- **No incluye dólares de OpenAI**: el precio por token no está en el código y no se inventa.

**Cómo llega la cuenta.** Las fuentes hablan con sus proveedores a través de las interfaces del contrato,
que no tienen sitio para un contador (D6), y una fuente cortada por el plazo no devuelve nada. Por eso el
contador (`ScanMeter`, en `scan-cost.ts`) viaja en el contexto asíncrono del scan (`AsyncLocalStorage`): el
cliente de Apify y el del modelo le informan si existe, y fuera de un scan (un script, la liquidación de
costes) no hay ninguno.

### 5.5 Tests

Todos con clientes inyectados: ninguno toca Apify ni OpenAI.

- `apps/api/tests/unit/sources.test.ts`, "Apify spend ceiling": el rechazo ocurre antes de la petición y se
  registra una vez; de seis runs simultáneos arrancan exactamente los dos que caben; las consultas cacheadas
  se sirven y no cuentan de nuevo; la reserva se mantiene hasta liquidar; cuenta el gasto de otro proceso y
  no el de hace más de 24 horas; `0` no arranca nada; sin techo no hay lectura ni `maxTotalChargeUsd`; el
  límite es la reserva y no cambia input ni fingerprint; la búsqueda por firma sigue pidiendo 1.000.000 y
  lleva límite; 30 búsquedas por firma simultáneas nunca reciben más límite que el techo (2/1, 5/0,5, 20/1 y
  2/0,3); un arranque sin respuesta sigue contando pasada su caducidad, también si otro scan lo retoma, y uno
  que Apify rechazó no cuenta; mil rechazos del techo no llenan la ventana; un run que agotó su límite no se
  cachea; el directorio informa causa transitoria sin parar la cola. `supabase-repository.test.ts` fija que
  la lectura deja fuera los rechazos.
- `apps/api/tests/unit/env.test.ts`, "spend guards": producción sin valor, `live-debug` con 2 y 30, valor
  explícito, línea vacía, valores inválidos.
- `apps/api/tests/unit/agentic-evidence-provider.test.ts`, "request cap per scan".
- `apps/api/tests/unit/scan-cost.test.ts` y `apps/api/tests/integration/scan-cost.test.ts`: la forma de la
  línea sobre el pipeline real con las grabaciones de §4.5, un segundo scan servido de las cachés, dos
  scans simultáneos sin mezclar cuentas, un scan con el techo alcanzado, un pipeline que lanza, y ninguna
  línea para un scan servido de la caché.
- `compose.test.ts` (el techo y el tope llegan a los clientes; producción los construye sin ellos),
  `supabase-repository.test.ts` (la consulta exacta de la lectura nueva) y `debug-isolation.test.ts` (el
  ledger sigue siendo durable).

### 5.6 Lo que queda fuera

- **Acotar el input de la búsqueda por firma** (`maxLawyers`): cambia el fingerprint y pierde el run que
  Jesús ya pagó. Además un tope ahí tendría que salir como `TRUNCATED`, no como plantilla completa (DN-02, DN-06).
- **Techo por scan.** El techo es por ventana de 24 horas. Un scan solo no puede pasar de él.
- **Límite de tokens o de dólares de OpenAI.** Se cuentan peticiones y tokens; el límite de gasto de OpenAI
  se fija en su panel.
- **Guardar el límite de cada run en el ledger**, para que la comprobación al liquidar sobreviva a un
  reinicio: necesita una columna y una migración sobre la base compartida.

## 6. PDF de Capa 2 y botón de exportar (F1, D8)

Hecho en el back. El botón es del front y ya llama a esta ruta desde `/assessment/results`.

**Antes.** La Capa 2 no tenía PDF: ni ruta, ni función en el cliente, ni botón. Fue un recorte deliberado del
prototipo y DN-07 lo dejaba para una fase posterior. Además, cada paso del plan de acción traía pegada la misma
frase de aviso, que en pantalla se leía hasta ocho veces.

### 6.1 La ruta

`GET /assessment/:assessmentId/report.pdf`, con el Bearer de la sesión del scan como el resto de rutas del
assessment: el middleware de `/assessment/:assessmentId/*` exige que el scan y el email del token coincidan con
los del assessment.

| Caso | Respuesta |
|---|---|
| Assessment `COMPLETED` | `200 application/pdf`, `Cache-Control: no-store`, `Content-Disposition: attachment; filename="arca-assessment-<dominio>-<aaaa-mm-dd>.pdf"` (día de finalización en `America/New_York`) |
| Sin token, token inválido, de otro scan o de otro email | `401 unauthorized` |
| Assessment que no existe | `404 not_found` |
| Sin completar | `409 incomplete` |
| Sesión de 24 horas vencida | `410 expired` |
| Sin renderer, Chromium falla o hay un fallo de debug inyectado | `503 report_unavailable` |

- **CORS.** `exposeHeaders` ya incluía `Content-Disposition` para todas las rutas. Un test lo comprueba en esta.
- **Contrato (D6).** Es una ruta binaria: no cambia nada en `@arca/contracts`. `report_unavailable` no está en
  `AssessmentError`, que solo documenta; el OpenAPI describe el 503 con el esquema genérico de error, como en Capa 1.
  El front ya conocía todos los códigos.
- **Fallo del renderer.** Si Chromium falla, la ruta responde 503 ella misma. Si lo dejara pasar, el manejador de
  errores del assessment diría "Unable to save or load the assessment", que no es lo que ocurrió. **[mía]**
- **Fallo de debug.** El eje `http.report: unavailable` se aplica también a esta ruta, por el scan del
  assessment y antes de mirar si está completo, igual que en el informe del scan. No hubo que tocar
  `@arca/contracts/debug`: `app.ts` pasa `debug.reportFault` a las rutas del assessment, y sin `debug`
  (producción) no pasa nada.

### 6.2 De dónde sale y qué lleva

Solo del registro guardado. No se recalcula nada y no se llama a ningún proveedor.

| Dato del informe | Origen en el registro |
|---|---|
| Nombre de la firma (o el dominio, si el scan no encontró nombre) y dominio | `layer1_snapshot` |
| Fecha, score combinado, tier, partes de Capa 1 y Capa 2, las seis áreas, plan de acción, versiones | `result` |
| Qué preguntas se imprimen y en qué orden | `bank_snapshot`, `plan` y `answers`: las que quedaron visibles, en el orden del cuestionario |
| El texto de cada pregunta y de cada opción | `rendered`, tal como se mostró |
| La respuesta y la fecha de la declaración de veracidad | `answers`, `attested_at` |

Una pregunta que se mostró, se respondió y luego quedó oculta al cambiar la respuesta de su pregunta padre sigue
en `rendered`, pero no se imprime: no es una respuesta del resultado. Las preguntas de seguimiento llevan la
marca "context only, not scored".

**Lo que no lleva.** `decision`, los overrides, los flags de máquina, el email, la evidencia de terceros, un
precio, ni los pesos 30/70 de la fórmula demo. Si el score combinado es nulo, pone una raya, "NOT SCORED" y
"Not scored" en la parte de Capa 1, nunca `UNKNOWN`.

**Un solo aviso (D8).** Arriba, bajo el nombre: "Demo assessment. The questions and the scoring are provisional,
so these results are illustrative. This is not an insurance offer, a price or an underwriting decision." Sigue
el aviso de la pantalla. El pie solo dice de dónde sale el informe y las versiones. La frase del plan de acción
("Each point gain is an estimate on its own, not a promised outcome.") no es un aviso de demo: explica que las
ganancias no se suman, y es la misma de la pantalla. **[mía]**

**Web ilegible.** Con el flag `WEBSITE_UNAVAILABLE` hay una frase, la del aviso de `/assessment/results` en tercera
persona:

| Tier del resultado | Frase |
|---|---|
| `CRITICAL` | "We could not read the firm's website during the scan. This outlook is in the highest-risk group, and because the website could not be read, it needs a manual review whatever the answers show. This is not a coverage decision or a price." |
| Cualquier otro | "We could not read the firm's website during the scan. Until it can be read, this outlook needs a manual review, whatever the answers show. This is not a coverage decision or a price." |

Así la frase no contradice el tier que hay justo encima (el límite conocido de §3.3: con buenas respuestas el
compuesto llega a 70), y lo que se mantiene "whatever the answers show" es solo la revisión manual, nunca el grupo
(regla de §3.3). No nombra la decisión ni un precio.

**Score, fechas y respuestas.** El score combinado se imprime redondeado a un entero entre 0 y 100, como el
indicador de la pantalla (antes salía 52.15 donde la pantalla dice 52). Las fechas de los dos PDF y sus nombres de
fichero usan el día de `America/New_York`, no el de UTC: un scan acabado una noche en Miami salía con la fecha del
día siguiente. Una respuesta numérica de 1 dice "1 hour per lawyer / year".

**Aspecto.** `apps/api/src/report/layout.ts` reúne lo que comparten los dos informes: el escapado, la paleta,
el formato de fecha y el CSS base. El HTML del informe de Capa 1 sale idéntico byte a byte al de antes
(comprobado con el fixture, `robust.arca.example` y `blocked.arca.example`). En el de Capa 2 ninguna fila se
parte entre páginas.

Medido en local con Chromium real sobre `robust.arca.example` y `blocked.arca.example`: dos páginas A4, unos
73 KB y entre 0,7 y 0,8 s por informe.

### 6.3 El plan de acción sin la frase repetida

`packages/scoring/src/layer2.ts` generaba cada paso así: "Illustrative next step: X. This estimate is
independent of other steps and is not a pricing or coverage promise." Ahora genera "Next step: X.", que es lo
que la pantalla ya mostraba tras recortar la frase. El significado del paso no cambia.

- `LAYER2_SCORING_VERSION` no cambia: la puntuación es la misma, solo cambia un texto. **[mía]**
- Los resultados ya guardados conservan el texto antiguo, porque son inmutables. La pantalla lo recorta
  (`nextStep` en el front) y el PDF lo imprime tal cual. Solo afecta a las sesiones de 24 horas abiertas en el
  momento del despliegue.
- El plan de acción de la webapp (DN-10) muestra `detail` sin tocar, así que también pierde la frase.

### 6.4 Límites conocidos

- **Solo durante la sesión.** La descarga pide el token del scan y el assessment vence a las 24 horas. La
  webapp no guarda ese token, así que desde ella no se puede descargar.
- **Un Chromium por informe, con tope.** Desde el 2026-11-10 los dos informes comparten un semáforo en el proceso
  (`limitRenders`, en `report/pdf.ts`): como mucho 2 renders a la vez, y los demás esperan su turno por orden. Cada
  petición tiene 12 s en total, espera incluida (por debajo de los 15 s del front); pasado ese plazo el render se
  aborta (se cierra su Chromium), su hueco pasa al siguiente y la ruta responde `503 report_unavailable`. El informe
  de Capa 1 también responde 503 cuando el render falla (antes, 500). Sigue sin haber límite por token o IP: un
  token puede llenar la cola, aunque ya no abrir más de dos Chromium. Es el riesgo 12 de DN-08, acotado.
- **No es el Full Assessment Report del roadmap.** Usa el banco y la fórmula demo, y lo dice. El informe
  definitivo sigue en la fase 5 de DN-07.
- **El texto vive en dos sitios.** Las frases del informe están en el back y las de la pantalla en el front,
  copiadas a mano. Pueden divergir.
- **"1 hours per lawyer / year".** Resuelto el 2026-11-10: con 1, la primera palabra de la unidad va en singular
  (`numberLabel`, en `layer2.ts`), en el plan de acción y en las respuestas del PDF.

### 6.5 Tests

- `apps/api/tests/integration/assessment-report.test.ts`: la ruta (descarga y cabeceras, token ausente, mal
  formado, de otro email y de otro scan, assessment inexistente, sin completar, sesión vencida, sin renderer,
  renderer que falla, OpenAPI) y el contenido (firma, fecha, score y partes, áreas, plan de acción, respuestas
  en orden y sin las ocultas, un solo aviso, sin precio ni decisión ni email, score nulo, las dos frases de la
  web, escapado y nombre del fichero). El renderer va inyectado: no se lanza Chromium.
- `apps/api/tests/integration/unreadable-website.test.ts`: `blocked.arca.example` de principio a fin, ahora
  también con el informe del assessment.
- `apps/api/tests/integration/debug-mode.test.ts`: el fallo de informe inyectado en la ruta nueva.
- `apps/api/tests/integration/flow.test.ts`: la lista de rutas del OpenAPI.
- `packages/scoring/tests/layer2.test.ts`: el texto de cada paso del plan y el singular de la unidad.
- `apps/api/tests/unit/pdf-limit.test.ts`: el tope de 2, la espera por orden, el plazo que cuenta la espera, el
  render colgado que se aborta y cede su hueco, y el 503 del informe de Capa 1. Renderer inyectado.

## 7. Webapp simulada en live-debug (F2, D7)

Hecho en el back. Las pantallas, el botón de registro y las etiquetas de "simulado" son del front.

**Antes.** La webapp privada (cuentas, organizaciones y cobro: DN-10 y DN-11) solo se construía en `mock`. En
`live-debug` todas sus rutas respondían 501 y `/__debug/auth/login` y `/__debug/billing/pay` no existían. Era
una decisión de DN-10 §10 **[mía]**: que nunca pareciera que funcionaba contra servicios que no existen. El
efecto fue que, tras un scan real, el embudo terminaba sin salida y nada lo explicaba (F2).

**Ahora (D7, [Jesús]).** `live-debug` construye las mismas piezas que `mock`: `InMemoryWebappRepository`,
`MockAppAuth` y `MockBillingProvider`. Lo que cambia es de dónde lee:

| | `production` | `live-debug` | `mock` |
|---|---|---|---|
| Scans y assessments | Supabase | Supabase (reales) | memoria |
| Cuentas, organizaciones, miembros, planes, cobro | no hay: 501 | **memoria, simulados** | memoria, simulados |
| `POST /__debug/auth/login` | no existe (404) | sí | sí |
| `POST /__debug/billing/pay` | no existe (404) | sí | sí |
| `POST /__debug/seed` (DN-11 §4.6) | no existe (404) | **no existe (404)** | sí |

Sigue sin haber repositorio de Supabase para la webapp, verificador de Supabase Auth ni Stripe. Eso es el
trabajo de DN-10 §10 y no cambia: en producción no hay registro.

### 7.1 Un reclamo no escribe nada en Supabase

`WebappService` solo **lee** de los repositorios de scans y assessments: `scans.get` y
`assessments.getByScan`. Que un scan esté reclamado se guarda en el repositorio de la webapp
(`org_analyses`), que aquí es memoria. La tabla `scans` no tiene ninguna marca de reclamado.

Un test lo fija con repositorios espía en el lugar de Supabase: durante login, reclamo, organización, pago,
lista de análisis y plan de acción, las únicas llamadas son `get` y `getByScan`. Otro test, con el
`SupabaseRepository` de verdad y un `fetch` falso, comprueba que el login, `/me`, `/plans` y un reset no
mandan ninguna petición a Supabase.

### 7.2 Guardas

Las mismas que en `mock`, sin ninguna nueva:

- **Modo.** Las rutas `/__debug/*` solo se registran cuando `compose` construye las herramientas de debug, y
  eso no ocurre en producción. La webapp simulada depende de los repositorios de enrutado, que producción
  tampoco construye. `ARCA_DEPLOYMENT` impide arrancar un modo de debug en un despliegue (DN-09 §4).
- **Loopback.** El servidor de los modos de debug escucha solo en `127.0.0.1` (DN-09 §5.1). Es una guarda del
  socket, no de cada petición.
- **Cabecera.** Login, pago y reset piden `X-Arca-Debug: 1`. Sin ella responden **400**, igual que en mock: así
  la petición deja de ser "simple" para CORS y solo pasan los orígenes permitidos. El 404 es para las rutas que
  no existen en ese modo.
- **Semilla solo en mock.** La semilla lanza un scan que se salta el limitador. En `live-debug` leería una web
  real, gastaría crédito y escribiría en la base compartida. `DebugTools.seeds` es verdadero solo en mock con la
  webapp, `createApp` solo construye ese ejecutor cuando lo es, y `routes()` rechaza recibirlo en otro caso.
- **Scan inyectado.** Un scan con fallo inyectado vive en memoria (DN-09 §5.5) y sigue sin poder reclamarse: 409.

### 7.3 Reset

`POST /__debug/reset` en `live-debug` vacía el limitador, como antes, y ahora también **la memoria de la
webapp**. No toca Supabase ni los scans inyectados que alguien esté mirando. **[mía]**

Motivo: la regla de "un scan se reclama una sola vez" vive en esa memoria. Sin el reset, repetir el recorrido
de registro con el mismo scan real exigiría reiniciar el back o pagar otro scan.

### 7.4 Lo que dice el propio back

- **Línea de arranque.** `storage=supabase` habla de los scans. Cuando la webapp no vive ahí, la línea lo
  dice: `webapp=simulated-in-memory`. En mock no aparece, porque allí todo es memoria y `storage=memory` ya
  lo dice. En producción tampoco: no hay webapp.
- **`GET /__debug/mode` no cambia (D6).** `DebugModeResponse` es un objeto estricto y no tiene campo para la
  webapp. `storageBackend` e `inUse.supabase` siguen describiendo dónde viven los scans y assessments. No
  hizo falta un campo nuevo: en los dos modos de debug la webapp es la simulada, así que `mode` ya lo
  determina. Si algún día un modo de debug usa la webapp real, hará falta un campo (por ejemplo
  `webapp: 'simulated' | 'real'`) y una versión nueva del contrato.
- **Comentarios y mensajes** que decían "solo en mock" para el login y el pago dicen ahora "modos de debug".

### 7.5 Límites conocidos

- **Se pierde al reiniciar.** Organizaciones, miembros, invitaciones, precios cambiados y admins de plataforma
  viven en el proceso. El back corre con `tsx watch`: guardar un fichero lo reinicia y lo borra todo. El
  navegador conserva su token, que sigue siendo válido (su clave sale de `SESSION_TOKEN_SECRET`), y verá una
  cuenta sin organización. El mismo scan se puede volver a reclamar.
- **Hace falta el token del scan.** El reclamo pide el token de sesión del scan, que dura 24 horas y vive en la
  pestaña que hizo el scan. Un scan antiguo no se puede reclamar sin él.
- **Admin de plataforma.** El login simulado acepta `platformAdmin: true` también en `live-debug`. Ese panel
  solo ve organizaciones de la memoria, que nacen de un reclamo hecho con el token de un scan. No abre ninguna
  lectura nueva sobre los leads de Supabase.
- **El checkout simulado** devuelve una URL bajo `APP_BASE_URL`. Si ese valor no apunta al front local, el
  navegador sale a otro sitio.
- **El webhook** `POST /billing/webhook` sigue respondiendo 501 en todos los modos.

### 7.6 Tests

`apps/api/tests/integration/webapp.test.ts`:

- "production wiring": sin cambios. Producción responde 501 en las 22 rutas, no tiene login, pago ni semilla
  (404) y su CORS sigue exacto.
- "live-debug: real scans, a simulated webapp held in memory": la app compuesta en `live-debug` con
  repositorios en memoria en el lugar de Supabase y un `fetch` que falla si alguien lo llama. Ningún test
  lanza un scan: el scan se deja guardado como lo dejaría una ejecución real.
  - login → reclamo → organización → 402 → pago simulado → el análisis aparece, con su assessment y su plan;
    las únicas llamadas a los repositorios son lecturas (§7.1);
  - la semilla responde 404;
  - login y pago sin la cabecera responden 400, y `/me` sin token 401 (ya no 501);
  - el reset olvida la webapp, no llama a los repositorios y deja reclamar el mismo scan otra vez;
  - un scan aislado en memoria no se puede reclamar (409);
  - con el `SupabaseRepository` real, la única petición a Supabase es la de arranque;
  - las herramientas de debug no reciben el ejecutor de la semilla ni lo aceptan.

`apps/api/tests/integration/compose.test.ts`: producción no pasa `webapp` a `createApp`; los dos modos de
debug pasan la simulada y las herramientas de debug comparten ese mismo servicio; la línea de arranque.

`compose` acepta un segundo argumento opcional, `storage`, que sustituye a los repositorios durables. Solo
lo usan los tests.

## 8. Textos de la interfaz (F3, D8)

Todo en `Arca-front`; su `CLAUDE.md` y `docs/copy-deck.md` llevan el detalle y los textos exactos.

- **`/score`.** Un solo aviso de evidencia, en frases, sin flags de máquina. Con `WEBSITE_UNAVAILABLE` dice que
  la web no se pudo leer, que lo no verificado cuenta como desconocido y eso pone al despacho en el grupo de mayor
  riesgo "for now" (solo si el tier es CRITICAL), que las respuestas del assessment también cuentan, que el caso
  necesitará una revisión manual y que no es una decisión de cobertura; el assessment pasa a ser la acción
  principal. Ya no dice "until you complete the assessment" (regla de §3.3). El PDF es un botón con
  etiqueta, "Download report (PDF)", junto al dominio.
- **Scan FAILED.** El texto ya no culpa a la web: algo falló de nuestro lado o una fuente no respondió, y se
  pide otro intento una sola vez.
- **Capa 2.** Un solo aviso de demo por pantalla, en el armazón (`AssessmentShell`); se quitaron las otras
  menciones de "demo" y "provisional". La versión del banco y del modelo sale una vez, en pequeño.
- **`/assessment/results`.** Botón "Download report (PDF)" sobre la ruta de §6. Con `WEBSITE_UNAVAILABLE`, un
  aviso que solo nombra el grupo de mayor riesgo si el tier es CRITICAL: el back calcula el tier de Capa 2 con
  el compuesto, y unas buenas respuestas pueden sacarlo de ahí, así que la frase no contradice la insignia
  **[mía]**. Lo que se mantiene "whatever your answers show" es la revisión manual, no el grupo, y las dos formas
  acaban en "This is not a coverage decision or a price." El PDF de §6.2 dice lo mismo en tercera persona.
- El panel State no cambia. La banda de `live-debug` cambia solo su texto, a "LIVE DEBUG · real scans · simulated
  accounts & billing": con D7 la webapp de ese modo es simulada y la banda no puede decir "real database". Es la
  única excepción a D8, y es corta para que quepa en una línea en un móvil. DN-09 §11 cita el mismo texto.

## 9. Lo que no cambia

- El contrato publicado: `@arca/contracts` sigue en 0.4.0, sin campos ni valores nuevos (D6).
- La identidad: el dominio sigue sin convertirse en nombre de firma (DN-04).
- Producción: nada de mock ni de debug llega a ella (DN-09), y su gasto de Apify sigue sin techo (§5).
- El input de las consultas a Apify y su fingerprint: los runs ya cacheados siguen valiendo (§5.1).

## 10. Verificación (2026-11-09)

Back en `a56826d`, front en `572d0cb`, las dos en `fix/live-scan-findings`. Solo mock: ninguna llamada a
OpenAI, Apify, Supabase ni a webs reales.

| Comprobación | Resultado |
|---|---|
| Back `npm run typecheck` | Sin errores |
| Back `npm test` | 1217 de 1218. Falló por tiempo `infra/aws/lib/arca-demo-stack.test.ts` (flake conocido bajo carga); solo pasa 7 de 7 |
| Front `npm run typecheck` y `npm run lint` | Sin errores; los 6 avisos de react-hooks conocidos |
| Front `npm test`, dos veces | 930 de 930 en 47 ficheros, las dos veces |
| Front `npm run build` (producción) | `[check-no-debug] 0 debug leak(s)`. En `.next/static`, 0 ficheros con cadenas de debug, de la webapp simulada, de la semilla o "Keep these results"; "Download report (PDF)" está en 2 (control) |
| Contrato | Las respuestas de la API mock para `robust`, `minimal`, `partial`, `sanctioned`, `failed` y `blocked` (scan, poll y, salvo `failed`, el assessment de principio a fin) pasan los esquemas de `@arca/contracts` 0.4.0 instalado en el front: 37 de 37 |
| Smokes del front | `assessment` sin errores de página; `modes` 4 de 4; `webapp` 5 de 5; `roles` 6 de 6 |
| Recorrido en Chromium a 1280×900 | 6 de 6, abajo |

Recorrido:

- `robust.arca.example`: `/score` 82, FORTRESS. El botón del PDF cabe en la primera pantalla (y 361 a 403) y
  baja un fichero que empieza por `%PDF`. Assessment completo, un solo aviso de demo en los resultados, el PDF
  de Capa 2 baja bien, y "Keep these results" lleva al registro, al pago simulado y a `/app` con el análisis.
- `blocked.arca.example`: termina PARTIAL y llega a `/score` (no a la pantalla de fallo) con 0, CRITICAL,
  confianza baja, el override `WEBSITE_UNAVAILABLE` → `REFERRAL_SENIOR` y el aviso de web ilegible. El
  assessment es la acción principal, dentro de la primera pantalla. Resultados: 52, GUARDED, un solo aviso de
  demo y el aviso de web en su forma sin "highest-risk group", porque el tier no es CRITICAL (§8). El resto,
  como en `robust`.
- `failed.arca.example`: termina FAILED con el texto de "try again" y sin culpar a la web.
- El mismo dominio escaneado dos veces da el mismo score (82 y 82; 0 y 0).

Notas:

- El puerto 8080 lo ocupaba otro proceso local ajeno a ARCA. La pila mock corrió con el mismo
  `scripts/stack.mjs` y `PORT=8081`, y los smokes con `ARCA_API_URL=http://localhost:8081`.
- Quedaba a la vista "Next step: 1 hours per lawyer / year." en el plan de acción; resuelto el 2026-11-10 (§6.4).

## 11. Segunda revisión (2026-11-10)

Arreglos del back tras la revisión final de la rama. Todos con tests nuevos que fallan sin el arreglo.

| Qué | Dónde | Detalle |
|---|---|---|
| Robots en los saltos posteriores de una redirección | `crawler.ts` | La cadena de cada navegación del marco principal se comprueba antes de mirar el estado y otra vez después de leer el contenido, también la de un `meta refresh` o un script que navega solo; el contenido de un salto excluido o de otro host no se guarda (DN-07 §6, con su límite) |
| Robots y host en las redirecciones de un sitemap | `sitemap-reader.ts` | Salto a salto, como mucho 5; uno que no pasa salta ese sitemap |
| Desafío servido con 403, 429 o 503 | `crawler.ts`, `website-outcome.ts` | Negativa (`ACCESS_BLOCKED`, DEFINITIVE) sin reintentos, solo si es del propio sitio: una cadena que acaba en el desafío de otro host es `OFF_SITE_REDIRECT`, transitoria (DN-07 §6) |
| Página vacía en un crawl `partial` | `website-outcome.ts` | TRANSITORIA, como cuando es todo el sitio (§4.2) |
| Aviso de web ilegible en los dos PDF | `report/` | El grupo sigue al score; solo la revisión manual se mantiene (§3.3, §6.2) |
| Tope de renders PDF | `report/pdf.ts`, `app.ts` | 2 a la vez, 12 s por petición, 503 al agotarse (§6.4) |
| Score, fechas, dominio y directorios en los PDF | `report/` | Entero como la pantalla, día de `America/New_York`, el dominio una vez, y un directorio omitido dice "not searched; we could not look the firm up there", como `/score` ("We could not look your firm up on Avvo."). No dice que la firma no se pudo identificar: `INSUFFICIENT_IDENTITY` también sale con la firma identificada y sin ciudad verificada, la forma del scan del 2026-11-06 (§6.2) |
| "1 hours" | `packages/scoring/src/layer2.ts` | `numberLabel` (§6.4) |
| Orden canónico antes del cruce de directorios | `packages/scoring/tests/determinism.test.ts` | Test que falla si se quita el orden de `evaluateLayer1Evidence` |
| `ScanRepository.latestRaw` | repositorios | Eliminado: nadie lo llamaba |

Verificación: back `npm run typecheck` sin errores; `npm test` 1244 de 1244 en 69 ficheros, y en una segunda pasada
1243 de 1244 con el flake conocido de `infra/aws/lib/arca-demo-stack.test.ts`, que solo pasa 7 de 7. Sin red: los
tests del crawler usan transportes inyectados y servidores en loopback, y los del PDF un renderer inyectado.

Tras la revisión de estos arreglos se corrigieron tres cosas más, cada una con su test visto fallar antes: la
navegación que la página empieza sola después de cargar (`meta refresh` o script) saltaba la comprobación de la
cadena y guardaba el contenido de un salto excluido o de otro host; el desafío de otro host al final de una cadena
contaba como negativa de la firma (DEFINITIVE, 7 días fijado), y el PDF del Quick Scan decía que la firma no se pudo
identificar cuando el directorio solo se omitió por falta de ciudad. Con ellos, `npm test` da 1248 de 1249; el único
fallo es el mismo flake de `arca-demo-stack.test.ts`, que solo pasa 7 de 7.

Una tercera pasada de revisión encontró una regresión de esos arreglos, ya corregida con su test: la URL actual de
la página se comparaba con robots.txt, así que un script que reescribe la dirección en el mismo documento
(`history.replaceState` o `pushState`, sin petición de red) hacia una URL excluida descartaba una página leída desde
una URL permitida, y una web legible podía acabar con `WEBSITE_UNAVAILABLE`. Ahora robots solo se pregunta por los
saltos que se pidieron a la red, y la URL actual solo entra en la comprobación de host (DN-07 §6). En la misma pasada:
`numberLabel` ya no recorta palabras que solo acaban en "ss" ("1 busines days"), y el tope de renders PDF resuelve
la petición antes de pasar el turno y trata un renderer que lanza antes de devolver la promesa como uno que rechaza.
Con ellos, `npm test` da 1252 de 1252.

Lo que no cambió, a propósito: los límites de §4.6 (plantilla cortada, filas antiguas sin código, sitio que siempre
llega al plazo).

## 12. Evidencia insuficiente para puntuar (2026-11-12)

Rama `fix/score-stability` en los dos repos. Decisión **[Jesús]**.

**Por qué.** Un scan real de hklaw.com mostró "3 / 100 CRITICAL" cuando solo se pudo evaluar una de las cuatro
categorías (Professional Standing, `PARTIAL`) y la confianza era `LOW`. El número y el tier se leían como un
juicio sobre la firma, y eran un hueco en lo que pudimos ver.

**Regla (igual en los dos repos).** Hay evidencia insuficiente cuando `preScore.confidence === 'LOW'` **y**
menos de 2 de las 4 categorías tienen un estado distinto de `UNKNOWN` (una `PARTIAL` cuenta como evaluada).
Back: `hasInsufficientEvidence` en `apps/api/src/report/quick-scan.ts`. Front: `hasInsufficientEvidence` en
`lib/api/adapt.ts`.

**Excepción.** Con el flag `WEBSITE_UNAVAILABLE` la regla no se aplica: ese caso se muestra a propósito como el
grupo de mayor riesgo con revisión manual (§3.3 y §8), y el aviso de la web nombra el tier. *Desde §14 la web
ilegible tiene su propio estado hermano, también sin número ni tier (`scoreWithheld`).* El front deja fuera,
además, todo resultado al que pinta el aviso de web ilegible, también una web caída sin el flag, para no
esconder el tier que ese aviso nombra; el PDF solo pone ese aviso con el flag, así que con el flag le basta.

**Qué se muestra en lugar del número y el tier.**

- `/score`: "Not enough evidence to rate" y "We could evaluate only {n} of 4 areas from public sources, so we
  are not showing a score. The assessment below fills in what public sources cannot show." (con 0: "We could
  not evaluate any of the 4 areas…"). "Refine your score" sube, como con la web ilegible. Las barras, las
  señales y el botón del PDF siguen. El aviso de evidencia solo dice qué fuentes fallaron y cierra con "This is
  not a coverage decision.", sin hablar de "this score".
- PDF del Quick Scan: en el bloque del score, "Not enough evidence to rate" y la misma frase, con "A full
  assessment fills in what public sources cannot show." en vez de "The assessment below…". Sin número, sin tier,
  sin línea de tier y sin línea de confianza. La nota de fuentes incompletas queda en "Some sources did not
  answer in full." (sin "so this score rests on partial evidence"), y la de que no hay decisión de suscripción
  sigue. Las categorías, los hallazgos y las fuentes no cambian.
- Webapp: un análisis guardado solo con scan sale con "—" y "NOT SCORED" en la lista, la comparación y la
  tarjeta, que además dice la primera frase.
- `/assessment/results` no cambia: su tier es el del compuesto, y la Capa 1 solo aparece como número en
  "Public evidence · Layer 1". `AssessmentResult` no trae la confianza ni las categorías de la Capa 1, así que
  la regla no se puede evaluar ahí sin otra lectura del scan. El PDF de la Capa 2 tampoco cambia.

**Lo que no cambia.** El contrato (`@arca/contracts` 0.4.0, D6): el score y el tier siguen en el resultado, en
el panel State y en la caché; solo las pantallas y el PDF dejan de presentarlos. El pipeline y el scoring no se
tocaron.

**Tests.** `apps/api/tests/unit/report.test.ts` (la regla: forma de hklaw → insuficiente; 2 categorías → no;
confianza no baja → no; `WEBSITE_UNAVAILABLE` → no; y el texto del PDF). En el front, `lib/api/adapt.test.ts`,
`lib/scan-flow.test.tsx` y `components/app/analyses-pages.test.tsx`.

## 13. Mismo despacho, dos scores: firma grande (2026-11-12)

### 13.1 Qué pasó

Dos scans en vivo de `hklaw.com` (Holland & Knight, unos 2.200 abogados y 36 oficinas), con minutos de
diferencia y las mismas 20 páginas leídas, dieron score 3 y 0. Los registros guardados del website (páginas,
diagnósticos con las llamadas a herramientas, extracción, revisión y grounding) explican la diferencia:

| # | Causa | Evidencia |
|---|---|---|
| 1 | La extracción agéntica elige sus herramientas, y el modelo (`gpt-6-luna`, de razonamiento: sin `temperature` ni `seed`) no elige igual dos veces | El primer scan leyó el sitemap (400 URLs) y buscó en el sitio; el segundo no leyó el sitemap y paró con `NO_NEW_EVIDENCE` |
| 2 | `find_in_site` solo busca en lo ya leído | La búsqueda de IA devolvió 3 pasajes de noticias; la página de IA de la firma, enlazada desde la portada, nunca se leyó. Gobernanza de IA (35 de 100 puntos) quedó desconocida |
| 3 | Los abogados de una firma grande salieron de un comunicado de prensa | 5 de los 6 buscados no eran miembros del Bar de Florida. El roster leía como página de equipo un comunicado cuya URL contiene `attorneys` |
| 4a | Cada run de Apify reservaba USD 1 contra el techo de USD 2 de `live-debug` | El primer scan se cortó tras dos runs que costaron USD 0,045 |
| 4b | El arranque de la búsqueda por firma del segundo scan falló en 1,3 s sin respuesta HTTP | Quedó `START_UNCERTAIN` sin el error de fondo. Reproducido en esta máquina: `getaddrinfo ENOTFOUND api.apify.com`, más o menos 1 de cada 60 |

### 13.2 Pasos fijos de evidencia antes de las rondas del modelo (A)

**Decisión. [mía]** Lo que no necesita al modelo se hace siempre y en el mismo orden, antes de la primera ronda
de afirmaciones, y no añade ninguna llamada al modelo:

1. Leer el sitemap (`read_sitemap`, el mismo camino de siempre). Sus URLs entran en los candidatos que el plan
   de páginas clasifica. Si el modelo lo pide después, encuentra `ALREADY_READ`.
2. El plan de páginas de siempre (tres votos de clasificación y el suelo de equipo, about, contacto y PDF de
   privacidad).
3. Leer hasta 4 páginas no leídas del propio sitio (`FIXED_FETCH_LIMIT`), sacadas del sitemap y de los enlaces
   de las páginas leídas: primero las de IA, innovación o tecnología legal de la firma, después su directorio de
   personas y su página de oficinas. Nunca noticias, eventos, publicaciones ni nada fechado por año y mes; una
   página de práctica sobre IA (consejo a clientes) solo ocupa un hueco de IA si no hay nada mejor. Pasan por la
   misma herramienta `fetch_pages`, que respeta robots.txt y el host. Entran como páginas pedidas, así que el
   corpus las coloca por delante de noticias y prácticas dentro del presupuesto de 24.000 caracteres.
4. Una búsqueda de IA fija (`AI_SEARCH_TERMS`) sobre todo lo leído, primero las páginas recién leídas, como
   mucho 8 pasajes: comparten el prompt con el corpus y el límite de 24.000 tokens por llamada de DN-05 sigue.

Las llamadas quedan en el historial como ronda 0. El modelo solo decide qué afirmar con lo reunido y puede pedir
más herramientas en las rondas siguientes, como antes. El tope de peticiones a OpenAI por scan (§5.2) no cambia:
estos pasos no hacen ninguna. Van con el plan de páginas (`planPages`); `EXTRACTION_VERSION` pasa a
`agentic-signals-v6`, así que los análisis guardados con la v5 no se reutilizan (§4.3).

Comprobado sobre los dos registros reales, sin red: en ambos los pasos fijos eligen la página de IA de la firma,
su directorio de profesionales y su página de oficinas, y leen Miami y Tampa como oficinas de Florida.

### 13.3 De dónde salen los nombres de abogados (B)

- El roster ya no lee como página de equipo una de noticias, comunicados o blog, aunque su URL diga
  `attorneys`. Sí lee `/people` y `/professionals`.
- Un nombre citado solo desde noticias, comunicados o blog se descarta si alguna otra página nombra abogados
  (diagnóstico `attorneySource`: `roster`, `site`, `news_only` o `none`). Si nada más los nombra, se quedan y la
  website data lo marca con `provenance.team_members_news_only`.
- El roster ya no borra un total de abogados que el sitio declara en otra página cuando él no da uno: el
  grounding lo sigue rechazando frente a un roster incompleto, y es lo que distingue una firma grande.

### 13.4 Firma grande en el Bar y reserva por tipo de run (C, D)

En [DN-06](DN-06-apify-cost-quality-plan.md) §10: para una firma que declara más de 50 abogados, o cuyos nombres
solo salen de noticias, o sin nombres, el Bar se busca por firma en cada ciudad de Florida donde el sitio lista
una oficina, como mucho 3; los nombres solo de noticias no alimentan ninguna búsqueda. Sin ciudad de Florida,
nada cambia. Y la reserva depende del tipo de run:

| Con el techo por defecto de USD 2 | Antes | Ahora |
|---|---|---|
| Búsquedas dirigidas del Bar | 2 | 20 (USD 0,10 cada una) |
| Búsquedas dirigidas de Avvo | 2 | 5 (USD 0,40) |
| Búsquedas por firma (todo el registro o una ciudad) | 2 | 2 (USD 1) |
| Firma grande con 3 oficinas en Florida | — | Caben 2 búsquedas por firma hasta que se liquiden, entre las del Bar por ciudad y la de Avvo por firma si la hay; el resto se rechaza y el directorio queda `partial` por causa transitoria. Para una firma así hay que subir el techo (§5.3) |

### 13.5 Arranque de Apify que no salió de la máquina (E)

Si el POST de arranque falla con un error de DNS (`ENOTFOUND` o `EAI_AGAIN` en la causa del error de `fetch`),
la petición no salió: ningún run pudo arrancar y repetirla es seguro. Se reintenta 2 veces, a los 0,5 s y a los
1,5 s. Si nunca resuelve, la fila del ledger queda `UNAVAILABLE`, caducada en el acto: no cuenta contra el techo,
no deja la consulta en cooldown y el siguiente scan vuelve a intentarlo. El directorio sale `PROVIDER_ERROR`,
causa transitoria. Cualquier otro fallo sin respuesta HTTP (conexión cortada, plazo, respuesta perdida) sigue
siendo `START_UNCERTAIN`, sin reintento, como en §5.1.

`last_error` guarda ahora el error de fondo, recortado a 300 caracteres: `Actor start response unavailable: fetch
failed (read ECONNRESET)` o `Actor start not sent: the Apify host name did not resolve: fetch failed (getaddrinfo
ENOTFOUND api.apify.com)`. El reintento de DNS del crawler (`network.ts`) es otro cambio, de otra rama.

### 13.6 Tests

Sin red, sin OpenAI y sin Apify: clientes y transportes inyectados.

- `apps/api/tests/unit/agentic-fixed-evidence.test.ts`: orden fijo (sitemap, lectura, búsqueda) antes de la
  primera ronda y sin ninguna llamada más al modelo; la página de IA llega al prompt por delante de las noticias;
  la misma evidencia pida lo que pida el modelo después; selección de destinos; ciudades de Florida por enlace y
  por texto, sin las de fuera; nombres solo de noticias descartados o marcados; un comunicado con `attorneys` en
  la URL no es página de equipo. Fixtures sintéticas: URLs y frases cortas escritas para el test.
- `directory-inputs.test.ts` y `directory-scope.test.ts`: búsqueda del Bar por ciudad, tope y orden, sin ciudad
  como antes, Avvo, deduplicado y motivo; reglas de `directoryScope`. `pipeline.test.ts`: la consulta lleva las
  ciudades.
- `apify-reservations.test.ts`: reserva por tipo, cuántas caben bajo el techo y que los límites de cargo nunca lo
  pasan, los dos tipos contra un mismo techo, la variable que nombra el log; reintento de DNS hasta que resuelve,
  abandono sin `START_UNCERTAIN`, sin reintento para otros fallos, recorte del error y parada si el llamador
  cancela. `env.test.ts` y `compose.test.ts`: variables nuevas y validación contra el techo.
- Actualizados: versión v6, las grabaciones de la repetición determinista (`harbor-vale`, regrabadas con el
  modelo escrito a mano de la fixture, ninguna llamada real) con un sitemap grabado, y la línea de coste (cuatro
  búsquedas dirigidas reservan USD 0,40; el test del techo usa USD 0,20).

### 13.7 Lo que queda fuera

- **Sin canario real.** Nada de esto se ha probado contra `hklaw.com` ni contra Apify: el comportamiento del actor
  del Bar con `locationType: 'city'` sale de su esquema de entrada publicado, no de un run.
- **El directorio de personas de una firma grande** suele ser un buscador sin nombres: la lectura fija lo trae,
  pero no garantiza un roster. Por eso la firma grande va por oficinas.
- **Ciudades de Florida** se leen contra una lista cerrada de ciudades con despachos y con "Ciudad, FL" en
  páginas de oficinas o contacto. Una ciudad pequeña que solo aparece como enlace, sin el estado, no se reconoce.
- **El total de abogados** sigue sin pasar a `team_size` (scoring); solo marca la firma grande.

### 13.8 Respuesta cortada, fallo sin diagnóstico, posts de IA y carreras (2026-11-12)

Al verificar la rama en vivo, un scan de `hklaw.com` (`sc_c5c465d176f94c448d12b379866a6d2a`) terminó `FAILED`: la
extracción del website lanzó "The model returned an incomplete response". El registro guardado solo tenía
`{error, pagesCrawled}`. Repetir la extracción sin red sobre el mismo crawl salió bien en 6 llamadas (la salida
más larga, 2.400 tokens), así que el corte es intermitente. Esa repetición dejó a la vista dos huecos más: el
modelo no afirmó nada de `ai_blog_posts` aunque el sitemap traía más de 40 publicaciones de la firma sobre IA, y el
crawler ordenaba `/en/careers/business-professionals` como página de personas.

| # | Causa | Cambio |
|---|---|---|
| F | El modelo (de razonamiento) gasta parte de `max_completion_tokens` (16.000) en razonar y la llamada para con `finish_reason: 'length'` sin JSON utilizable | Un solo reintento de esa llamada con más presupuesto |
| G | `website-source.ts` guardaba `diagnostics`, que es `null` cuando `extractDetailed` lanza, aunque `ExtractionFailure` lleva los intentos | El registro guarda los intentos del fallo |
| H | `ai_blog_posts` depende de que el modelo lo afirme; W4 (5 puntos) quedaba desconocido | Se deriva por regla de las URLs de publicaciones de la firma |
| I | El grupo de personas del orden de crawl buscaba `professionals` o `attorney` como subcadena | Carreras nunca son personas y la palabra tiene que ser el segmento o su cabeza |

**Respuesta cortada (F). [mía]** Cuando una llamada termina con `finish_reason: 'length'`, se manda otra vez la
misma llamada, mismos mensajes, con `max_completion_tokens` a 32.000 para los modelos de razonamiento (GPT-5 en
adelante, muy por debajo de su límite de salida) y a 16.000 para los demás (por debajo de los 16.384 de
`gpt-4o-mini`, el menor de esa familia). Lo da `lengthRetryParams` del endpoint (`llm-endpoint.ts`). Si vuelve a
cortarse, falla como antes. Solo hay un reintento por llamada, y la fase pasa a llamarse `<fase>-length-retry`, con
su propio presupuesto de reintentos transitorios. El reintento es una petición más: cuenta contra el tope por scan
(§5.2, `OPENAI_MAX_REQUESTS_PER_SCAN`) y contra la línea de coste, y si el tope no deja sitio no se manda. Los dos
intentos quedan en el historial: el cortado con su respuesta, el contenido parcial y
`Incomplete response: finish_reason length after N completion tokens (M reasoning) with max_completion_tokens 16000`.
Cualquier otra respuesta incompleta (sin contenido, `content_filter`) falla sin reintento, como antes. El perfil
de parámetros de la petición normal no cambia.

**Diagnóstico de un fallo (G).** Si el error trae `attempts` (un `ExtractionFailure`), el registro raw guarda
`diagnostics: { attempts, error, pagesCrawled }`. Los intentos van igual que en una extracción que termina: fase,
petición, respuesta (con `usage` y `finish_reason`), contenido y el problema encontrado. La extracción que termina
ya guarda los prompts completos, así que el fallo no los recorta. Un error sin intentos se guarda como antes. El
registro sigue sin `reuse` y el motivo sigue fuera de lo que devuelve la API.

**Posts de IA de la firma (H). [mía]** Si ninguna afirmación de `ai_blog_posts` fue aceptada, el grounding
negativo (`groundNegativeSignals`, con la regla en `ai-publications.ts`) busca entre las páginas leídas y las URLs
conocidas: los enlaces de las páginas leídas y las del sitemap, que llegan como `corpus.links`.

- Cuenta una URL del mismo host que la firma (con o sin `www`) que sea un post. Tiene que estar bajo una sección
  de blog, noticias, insights, publicaciones, artículos, alertas, podcasts o media, por debajo de la sección.
  Quedan fuera eventos, webinars, categorías, etiquetas, temas, autores, páginas de práctica y cualquier slug de una
  sola palabra (`/insights/ai` es un listado).
- El post tiene que tratar de IA por su slug o por el título de la página, si se leyó. En el slug cuentan palabras
  enteras: `ai`, `genai`, `llm(s)`, `chatgpt`, `artificial-intelligence`, `machine-learning`,
  `large-language-model(s)` e `inteligencia-artificial`. Nunca una palabra que solo contiene "ai" (said, maid,
  chair, aid, air). En el título, "AI" solo cuenta en mayúsculas.
- Resultado: `{found: true, count, titles}`. `count` cuenta URLs distintas (sin barra final ni `www`). `titles` son
  como mucho 5, más recientes primero por el año y mes de la URL: el título de la página si se leyó (sin el
  " | Firma" final) y, si no, el slug en palabras. La procedencia lleva todas las URLs con `method: 'derived'`.
- Si no hay ninguno, sigue la regla de antes: `found: false` desde un índice de blog leído, solo si el campo no se
  afirmó nunca.

**Precedencia.** Una afirmación aceptada gana siempre, diga `true` o `false`. Si el modelo afirmó algo y la
revisión lo rechazó, la regla sí pone `found: true`. Lo rechazado era la lectura del modelo de un pasaje (su cita,
su cuenta o su alcance), y cada URL de un post de la firma prueba por sí misma que el post existe. Lo que no cambia
es `found: false`: un rechazo sigue impidiendo derivarlo desde un índice.

**Riesgo aceptado.** Un nombre propio escrito con la palabra "ai" en el slug (`ai-weiwei-exhibit`) contaría. En el
título no, porque "Ai" no va en mayúsculas. Una noticia de "In the headlines" (prensa que cita a la firma, servida
en su propio sitio) cuenta como publicación suya.

Sobre la repetición de hklaw, sin red: 42 posts, desde
`/en/insights/media-entities/2026/11/regulating-artificial-intelligence-compliance-management` hasta
`/en/insights/media-entities/2023/08/podcast-inteligencia-artificial`. Ninguno es la página de práctica, el
navegador de IA ni un evento.

**Carreras no son personas (I).** En `crawl-order.ts` una ruta con un segmento de carreras, empleo o selección
(`careers`, `jobs`, `recruiting`, `join-our-team`, `internships`, `summer-associates`, `trabaja-con-nosotros`,
`empleo`, `bolsa-de-trabajo`, `carreras`…) va al grupo de lo que ningún grupo nombra, diga lo que diga su slug. La
palabra de personas (`team`, `attorneys`, `lawyers`, `people`, `professionals`, `abogados`, `equipo`, `socios`)
tiene que ser el segmento entero o su cabeza, con `our-`, `the-`, `meet-our-`, `meet-the-` o `nuestros-` delante
si lo hay. Así, `our-people`, `meet-the-team`, `attorneys-and-staff` y `abogados-de-inmigracion-miami` siguen
siendo personas, y `business-professionals`, `experienced-attorneys` o `sports-team-ownership` ya no. Los pasos
fijos (`fixedTargets`) y el roster (`isTeamUrl`) tampoco toman una página de carreras como directorio de personas.

**Versión.** `EXTRACTION_VERSION` pasa a `agentic-signals-v7`: para la misma evidencia la extracción ya puede
devolver `ai_blog_posts` derivado, así que los análisis guardados con la v6 no se reutilizan (§4.3). El reintento
por corte no entra en el hash de parámetros: solo cambia si una extracción falla, no lo que dice una que termina.

**Tests.** Sin red y sin OpenAI, con clientes inyectados.

- `agentic-evidence-provider.test.ts`: `length` y luego `stop` (dos intentos, mismos mensajes, 16.000 y luego
  32.000, el primero con su respuesta y el contenido parcial); `length` dos veces (falla con el mensaje de
  siempre y los dos intentos); el reintento cuenta contra el tope (con tope 1 no se manda); `content_filter` no
  se reintenta; presupuesto por familia; el registro raw de un fallo guarda los intentos, y uno sin intentos
  queda como antes. Versión v7.
- `negative-signal-grounding.test.ts`: URLs con la forma de las de hklaw (slugs sintéticos), duplicados por barra
  y `www`, otro host, título de una página leída, vocabulario de IA por palabras enteras, falsos positivos (maid,
  chair, mail, aid, air), páginas que no son posts, el `false` desde un índice, una afirmación aceptada gana y un
  rechazo no impide el `true`.
- `crawler.test.ts`: carreras, empleo y selección no son personas; compuestos frente a segmentos enteros; el
  sitemap no siembra una página de carreras. `agentic-fixed-evidence.test.ts`: los pasos fijos no la eligen.

**Lo que queda fuera.**

- **Sin canario real.** Ni el reintento por corte ni los posts derivados se han probado contra OpenAI ni contra
  `hklaw.com` en vivo. Las cifras salen de la repetición sin red.
- **Un segundo corte** sigue tumbando el website y el scan. No se reduce el corpus ni se parte la llamada.
- **Posts sin URL conocida.** Solo cuentan los que el scan vio: un blog que solo se pagina con JavaScript o no
  está en el sitemap no aporta nada.

### 13.9 Muestra fija por ciudad en las búsquedas de una firma grande (2026-11-13)

**Qué pasó.** En la verificación en vivo, las tres búsquedas por ciudad de hklaw.com (Fort Lauderdale, Jacksonville,
Miami) se lanzaron con el máximo técnico de abogados y las cortó el límite de cobro de USD 1 de cada run: 24, 47 y 50
abogados, a USD 0,98-1,00 cada una (unos USD 0,02-0,04 por abogado con detalle). Un dataset cortado no se reutiliza
(`reached its charge limit … is not reused`), así que cada scan volvía a pagarlo y leía otra lista. Leer el roster de
Florida completo de una firma de 2.200 abogados costaría más de USD 10 por scan.

**Cambio.** Una búsqueda por ciudad de una firma grande lee una muestra fija: `APIFY_BAR_OFFICE_SAMPLE_MAX_RESULTS`
(20 por defecto) en el Bar y `APIFY_AVVO_OFFICE_SAMPLE_MAX_RESULTS` (10) en Avvo cuando la ciudad sale de una oficina y
no de una ciudad verificada. El run termina por su propio `maxLawyers`, por debajo de la reserva, queda `SUCCEEDED` y
entra en la caché de consultas: el siguiente scan lee los mismos abogados sin pagar. El motivo de la fuente lo dice
(`…; up to 20 lawyers per city`). La búsqueda de una firma sin ciudad de oficina conserva el máximo técnico (DN-06).

**Decisión para el founder.** Professional Standing de una firma grande sale de una muestra de hasta 60 abogados de
Florida (3 ciudades × 20), no del roster completo. Subir los dos valores amplía la muestra a costa de cada scan.

### 13.10 Lectura del sitemap reproducible (2026-11-13)

**Qué pasó.** Dos scans de hklaw.com con minutos de diferencia rastrearon páginas distintas (6 de 20) y, con ello,
sacaron claves de reutilización distintas: uno volvió a llamar al modelo. El sitemap de hklaw.com es un índice de 11
ficheros. Se leían de uno en uno y en el orden del índice, con un tope de 400 URLs: `events` (490 KB) llenaba el tope
antes de llegar a `offices` y `professionals`, y la lectura completa tardaba 7-8 s frente a los 4 s que el crawl la
esperaba. Según el tiempo de red, la siembra llegaba o no.

**Cambio.**
- `readSitemap` lee 4 ficheros a la vez y los procesa en el orden de la cola, respondan en el orden que respondan.
- Los hijos de un índice se ordenan por utilidad (`sitemapRank`): firma, personas, oficinas, servicios y páginas
  generales primero; noticias, eventos, publicaciones y empleo al final. Lee hasta 16 hijos.
- Cada fichero aporta como mucho 60 URLs (`MAX_URLS_PER_SITEMAP`), así que ninguno se come el tope.
- El crawl espera la siembra hasta 10 s (`SITEMAP_SEED_TIMEOUT_MS`).
- Un fichero que no se puede leer (más de 1 MB, conexión caída) se salta; ya no hace fallar la lectura entera. La
  verificación en vivo lo destapó: el sitemap `insights` de hklaw.com pesa 1,4 MB, y con todos los hijos leídos la
  lectura fallaba siempre (`Response too large`), tanto la siembra del crawl como la herramienta del agente.
- El resultado guarda cómo fue la lectura (`sitemap: { status, urls, seeded, ms }`, `read` / `timeout` / `failed` /
  `skipped`), también en el registro de evidencia del website: un crawl que empezó distinto queda explicado.

**Tests.** `sitemap-reader.test.ts` (índice con la forma del de hklaw: se leen los 11 hijos, oficinas y personas
antes que noticias, mismo resultado con respuestas en otro orden) y `crawler.test.ts` (el desenlace del sitemap queda
en el resultado: `read`, `failed`, `timeout`).

## 14. Web ilegible: confianza baja, no alto riesgo (2026-11-17)

Rama `feat/unreachable-website-layer2` en los dos repos, cortada de `fix/score-stability`. Decisión **[Jesús]**.
**Sustituye a D4** (§3.3): una web que no se pudo leer ya no es "grupo de mayor riesgo" con el override
`REFERRAL_SENIOR` y revisión manual. El texto de §3.3, §8 y §12 sobre ese tratamiento queda como historia.

### 14.1 Qué se decidió

1. **Cualquier causa del sitio termina PARTIAL.** Si la web de la firma no da ninguna página por algo del propio
   sitio (robots.txt lo excluye, 401/403 o desafío, DNS que no resuelve, conexión rechazada o cortada, plazo del
   crawl, 5xx, 429, robots.txt inalcanzable, portada vacía, 404 o que redirige a otro dominio), el scan ya no falla:
   termina `PARTIAL` con el resultado, el flag `WEBSITE_UNAVAILABLE` y confianza `LOW`, y la Capa 2 puede empezar.
   Antes solo lo hacían las causas DEFINITIVE; las TRANSIENT terminaban `FAILED`.
2. **Se presenta como confianza baja.** En `/score` y en el PDF del Quick Scan no hay número ni tier: un estado
   "No score from public evidence" con "Confidence: low" y un solo aviso. El assessment es la acción principal.
   Se quitan el override `WEBSITE_UNAVAILABLE` → `REFERRAL_SENIOR` y los textos de "highest-risk group" y
   "manual review".
3. **Compuesto = Capa 2.** Con `WEBSITE_UNAVAILABLE` en la Capa 1, `AssessmentResult.layer1Score` es `null`,
   `compositeScore` es el `layer2Score` y el resultado lleva el flag `LAYER1_UNAVAILABLE`. Antes era 0 × 0,3 +
   Capa 2 × 0,7, así que no pasaba de 70.
4. **Lo transitorio se puede reparar.** La caché de scans sirve ese PARTIAL solo hasta el cooldown de reparación
   (1 hora) y después lo vuelve a ejecutar. Las negativas definitivas (robots.txt, 401/403, desafío) son
   estructurales y se sirven toda la ventana.
5. **Mock.** `blocked.arca.example` (negativa definitiva) y el nuevo `down.arca.example` (web inalcanzable,
   transitoria) terminan PARTIAL con el flag y confianza baja. `failed.arca.example` sigue terminando FAILED,
   ahora como fallo nuestro.

Sin cambios en `packages/contracts/src` (D6): los dos flags son texto libre y `layer1Score` ya admitía `null`.

### 14.2 Dónde está la línea entre el sitio y nosotros **[mía]**

La línea la traza un dato que ya existía: `sources.website.pagesCrawled`. El website source solo pone
`pagesCrawled: 0` cuando el crawl terminó sin leer ninguna página, sea cual sea la causa del sitio
(`website-source.ts`, rama `!crawl.pages.length`). Lo comprueba `isWebsiteUnavailable` en `@arca/scoring`:
`status` `error` o `timeout` **y** `pagesCrawled === 0`.

| Qué pasó | Estado del website | Scan |
|---|---|---|
| El sitio no dio ninguna página, por cualquier causa suya (tabla del DN-07 de crawl, §6), también el plazo **propio del crawl** (30 s) sin nada leído | `error`/`timeout`, `pagesCrawled: 0` | **PARTIAL**, `WEBSITE_UNAVAILABLE`, `LOW` |
| La extracción del modelo falló, o se quedó sin tiempo, **sobre páginas que sí se leyeron** | `error`/`timeout`, `pagesCrawled` > 0 | FAILED |
| El website source lanzó (Chromium no arrancó, un error nuestro) | `error` sin `pagesCrawled` (lo pone `bounded()` del pipeline) | FAILED |
| El plazo **del pipeline** (`PIPELINE_TIMEOUT_MS`) cortó la fuente | `timeout` sin `pagesCrawled` | FAILED |
| Falló guardar la evidencia (almacenamiento) | el pipeline lanza antes de decidir | FAILED (lo guarda quien lo llama) |

Por qué así:

- **Ningún código nuevo.** El código (`ACCESS_BLOCKED`, `PROVIDER_ERROR`, `NO_READABLE_EVIDENCE`,
  `DEADLINE_REACHED`) sigue diciendo la causa, y con ella si es definitiva o transitoria; pero `PROVIDER_ERROR` y
  `DEADLINE_REACHED` los usan tanto el sitio como nosotros, así que el código solo no basta. El número de páginas sí
  distingue, y todos los resultados guardados ya lo llevan.
- **El plazo.** El crawl tiene su propio plazo de 30 s, muy por debajo del del pipeline (600 s por defecto). Un sitio
  que no responde en 30 s es "timeout" del sitio y termina PARTIAL. Si alguna vez el plazo del pipeline llegara
  antes (configurado por debajo de 30 s), `bounded()` resuelve sin `pagesCrawled` y el scan termina FAILED: no se
  puede saber si el crawl había leído algo, y ante la duda se trata como nuestro.
- **El eje `website` del panel de debug.** `blocked` (pone `pagesCrawled: 0`) termina PARTIAL; `error` (lanza) y
  `timeout` (imita al `unavailable('timeout')` del pipeline) son fallos nuestros y terminan FAILED, como el preajuste
  "Every source down". No hay un valor "sitio caído" en el eje porque vive en `@arca/contracts/debug` (D6); para eso
  está `down.arca.example`.

### 14.3 Qué cambia en cada pieza

- **Pipeline** (`in-process-pipeline.ts`): sin ninguna fuente útil, PARTIAL si `isWebsiteUnavailable`, si no
  FAILED. `website-outcome.ts` no cambia de tabla: sigue eligiendo código y clase por causa.
- **Scoring** (`score.ts`): el flag `WEBSITE_UNAVAILABLE` sale de `isWebsiteUnavailable`, no de la clase
  DEFINITIVE, y ya no añade override. `preScore` sigue llevando `total` 0 y tier `CRITICAL` (las bandas de
  siempre): son datos del contrato y de la caché, no lo que se presenta. `decision` queda en `UNKNOWN` salvo una
  restricción disciplinaria, que sale de los directorios.
- **Capa 2** (`layer2.ts`): con el flag en la Capa 1, `layer1Score: null`, `compositeScore = layer2Score`, flag
  `LAYER1_UNAVAILABLE` y tier por las bandas sobre ese compuesto. Los puntos de cada paso del plan de acción se
  cuentan con peso 1 (antes × 0,7), porque el compuesto es la Capa 2 entera.
- **Caché** (`scan-cache.ts`): la tabla de §4.2 ya clasificaba así; no cambió código, solo el comentario y los
  tests. `error` + `ACCESS_BLOCKED` es ESTRUCTURAL (toda la ventana); cualquier otro website sin páginas es
  TRANSITORIO (se repara pasado el cooldown).
- **PDF del Quick Scan** (`quick-scan.ts`): `scoreWithheld` devuelve `WEBSITE_UNAVAILABLE`, `INSUFFICIENT_EVIDENCE`
  o `null`; la web ilegible va primero. En el bloque del score: "No score from public evidence", "We could not read
  the firm's website, so there is no public evidence to score. A full assessment gives a score based on the firm's
  answers, marked as low confidence." y "Confidence: low". Sin número, sin tier y sin la nota de fuentes
  incompletas; la de que no hay decisión de suscripción sigue. `hasInsufficientEvidence` no cambió (sigue
  excluyendo el flag: tiene su estado hermano).
- **PDF de la Capa 2** (`assessment.ts`): con `LAYER1_UNAVAILABLE`, la línea bajo el tier es "Based only on the
  firm's answers; no public evidence could be verified (low confidence)." y "Public evidence · Layer 1" dice "Not
  scored". Ya no hay aviso de web aparte.
- **Front** (detalle en su `CLAUDE.md` y `docs/copy-deck.md`): `notRated` lleva `reason` (`website_unavailable`
  o `thin_evidence`). `/score`: aviso "We could not read your firm's website, so we have no public evidence to
  score. The assessment below gives you a score based on your answers, marked as low confidence. This is not a
  coverage decision." y, en el lugar del gauge, "No score from public evidence" / "Confidence: low".
  `/assessment/results` y la tarjeta de la webapp: "Based only on your answers; no public evidence could be
  verified (low confidence)." La webapp enseña "—" y "NOT SCORED" para un scan solo de web ilegible.
- **Mock**: `apps/api/mocks/down.json` (website `error` / `PROVIDER_ERROR`, `pagesCrawled: 0`, "The website
  could not be reached"). `failed.json` pasa a ser una extracción fallida sobre 6 páginas leídas ("Website evidence
  extraction unavailable"). La herramienta "Fill mock firm" del front solo escribe `robust.arca.example`: no hay
  lista de dominios que tocar en el front.

### 14.4 Tests

Cada test nuevo se vio fallar antes del cambio, salvo los de la clasificación de la caché, que pasaron a la primera
porque la tabla de §4.2 ya clasificaba así (los de `same-score.test.ts` sobre `down.arca.example` sí fallaron antes).

- `packages/scoring/tests/website-outcome.test.ts`: `isWebsiteUnavailable` para cada causa del sitio y para cada
  fallo nuestro.
- `packages/scoring/tests/unreadable-website.test.ts`: flag, confianza baja y sin override para cada causa del
  sitio; nada para los fallos nuestros; la restricción disciplinaria se mantiene; compuesto = Capa 2,
  `layer1Score: null`, `LAYER1_UNAVAILABLE`, decisión `UNKNOWN`, plan de acción con peso 1, y el 30/70 intacto con
  la web leída.
- `apps/api/tests/unit/pipeline.test.ts`: la tabla de causas entera (17 casos, cada uno con su estado y código) →
  PARTIAL; fuente que lanza, extracción sin tiempo sobre páginas leídas y fallo de almacenamiento → FAILED; los tres
  dominios mock.
- `apps/api/tests/unit/scan-cache.test.ts`: con el estado real de `unreadableWebsite`, las negativas se sirven
  toda la ventana y DNS, plazo, 503, 429, robots.txt inalcanzable y portada vacía se reparan pasado el cooldown.
- `apps/api/tests/integration/same-score.test.ts`: `down.arca.example` se sirve de caché dentro del cooldown y se
  re-ejecuta después.
- `apps/api/tests/unit/report.test.ts` y `apps/api/tests/integration/assessment-report.test.ts`: texto de los dos
  PDF, sin número ni tier, sin grupo de riesgo ni revisión manual.
- `apps/api/tests/integration/unreadable-website.test.ts`: por HTTP y con los esquemas estrictos de 0.4.0,
  `blocked` y `down` de punta a punta (scan, PDF, assessment, resultado, PDF de la Capa 2); `failed` FAILED.
- Actualizados: `mock-scenarios.test.ts`, `debug-mode.test.ts`, `debug-sources.test.ts`.
- Front: `lib/api/adapt.test.ts`, `lib/scan-flow.test.tsx`, `lib/assessment-flow.test.tsx`,
  `components/assessment/result-notes.test.ts`, `components/app/analyses-pages.test.tsx`.

### 14.5 Verificación (2026-11-17)

Solo mock: ninguna llamada a OpenAI, Apify, Supabase ni a webs reales (`/__debug/mode` dijo `inUse` todo `false`).

| Comprobación | Resultado |
|---|---|
| Back `npm run typecheck` | Sin errores |
| Back `npm test` | 1408 de 1408 en 73 ficheros |
| Front `typecheck`, `lint` | Sin errores; los 6 avisos conocidos |
| Front `npm test` | 965 de 965 en 48 ficheros |
| Front `npm run build` sin `NEXT_PUBLIC_ARCA_MODE` | `[check-no-debug] 0 debug leak(s)` |
| Recorrido en Chromium, pila mock (API 8080, front 3000), 1280×900 | Abajo |

- `blocked.arca.example` y `down.arca.example`: `/score` con el aviso nuevo, "No score from public evidence",
  "Confidence: low", sin gauge, sin `CRITICAL`, sin "highest-risk" ni "manual review"; PDF del Quick Scan igual.
  Assessment completo: 85 (gauge) / 84,5 (Capa 2), FORTRESS, "Public evidence · Layer 1: Not scored" y la línea
  "Based only on your answers…"; el PDF de la Capa 2 lo dice en tercera persona. Sin errores de página.
- `failed.arca.example`: pantalla de "try again" ("Something went wrong on our side…", "Try another scan").

### 14.6 Lo que queda fuera

- **La pantalla de FAILED** sigue diciendo "Something went wrong on our side, or a source we rely on was temporarily
  unavailable." Sigue siendo verdad (el modelo es una fuente de la que dependemos), así que no se tocó.
- **Las barras de `/score` y del PDF** siguen enseñando 0 / 35… con "no evidence" / "not enough evidence" para la
  web ilegible, como para cualquier categoría desconocida.
- **El eje `website` del panel de debug** no tiene un valor "sitio caído" (D6); se usa `down.arca.example`.
- **Resultados guardados con D4.** Ningún entorno desplegado tiene esta rama ni D4 (no están en `main`), así que no
  hay assessments antiguos con el flag y el 30/70 que atender. Si los hubiera, la pantalla de resultados ya no
  enseña el aviso de web para ellos (solo mira `LAYER1_UNAVAILABLE`).
