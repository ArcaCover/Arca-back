# DN-12 · Hallazgos del scan en vivo

- **Fecha:** 2026-11-09
- **Estado:** en implementación. Cada arreglo tiene su sección (§3 a §8) y la amplía la tarea que lo hace.
  Hoy están hechos §3, §4, §5, §6 y §7 (back).
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
| D4 | Una web ilegible DEFINITIVE ya no hace fallar el scan: termina PARTIAL, con el resultado completo marcado de alto riesgo usando solo valores que el contrato ya tenía, el flag `WEBSITE_UNAVAILABLE` y un override `REFERRAL_SENIOR`. La Capa 2 puede empezar desde ahí. Lo transitorio y lo nuestro sigue FAILED ("try again") | **[mía]** |
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

**PDF de Capa 1.** Cuando el resultado lleva el flag, `report/quick-scan.ts` pone una frase en lugar del
aviso genérico de fuentes incompletas: "The firm's website could not be read, so everything that could not be
verified counts as unknown and the firm sits in the highest-risk group until the assessment is completed."
No nombra decisión ni precio. La frase que dice que no hay decisión de suscripción sigue debajo.

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

**Pendiente en el front.** La lista de dominios mock, el texto de la pantalla FAILED (ya no es "la web nos
bloqueó") y el aviso de web ilegible en `/score` y en `/assessment/results`.

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
| `partial` sin código | ESTRUCTURAL | Se leyó hasta donde el sitio deja: una página responde 401/403 o un desafío, viene vacía o da otro 4xx. El crawler no reintenta esas páginas y un segundo scan tampoco las leería |
| `partial` + `DEADLINE_REACHED` | TRANSITORIA | El plazo cortó el crawl |
| `partial` + `PROVIDER_ERROR` | TRANSITORIA | Una página propia falló por algo pasajero y agotó sus reintentos (error de red, 5xx, 429, robots inalcanzable para esa página) |
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

- **Clave.** Un hash de lo que el modelo lee, no del HTML: por página y en orden de URL, el texto tal como
  lo parte el corpus, los metadatos que el corpus extrae (título, descripción, JSON-LD) y los enlaces que
  ofrece (`corpusFingerprint`, en `evidence-corpus.ts`), más `provider.id` y `provider.version`.
- **Versión de extracción.** La del extractor agéntico es ahora
  `agentic-signals-v5:openai:<modelo>:<esfuerzo de razonamiento>:<hash>`, donde el hash cubre los cuatro
  prompts y los parámetros de la petición (`extractionVersion`). Editar un prompt invalida los análisis
  guardados sin que nadie tenga que acordarse de subir `EXTRACTION_VERSION`, que sigue siendo manual para
  lo que el hash no ve (el flujo, las reglas de grounding). Los proveedores `openai` (una pasada) y `rules`
  conservan su versión fija.
- **Búsqueda.** El registro guardado lleva dos marcas de texto plano: `wsk1-<hash>` (la clave) y
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

**Límites conocidos.**

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
| Nunca arrancada (rechazada por el techo o por el límite de uso, caducada) | 0 |

La regla es: `comprometido por las demás filas + reserva de este run > techo` significa rechazo.

- **Las consultas cacheadas no cuentan de nuevo y se siguen sirviendo**, también con el techo agotado. Una
  consulta cacheada es una fila del ledger: se cuenta una vez, la sirva quien la sirva.
- **La suma es del ledger, no de la memoria del proceso.** Incluye lo que arrancó este proceso, uno anterior
  (el back se reinicia con cada cambio de código) y cualquier otro que escriba en la misma base.
- **Sin migración.** Es un `select` de ocho columnas sobre `apify_runs`, sin `items`, solo cuando un run
  va a arrancar y solo si hay techo. Producción sin techo no hace esa lectura.
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

**Límite de cargo por run.** Con techo, cada run arranca con `maxTotalChargeUsd` igual a lo que al techo le
queda en ese momento. Va en la URL del arranque, no en el input: **el input guardado y el fingerprint de la
consulta son los mismos con o sin límite**, así que los runs cacheados antes de este cambio siguen valiendo
(hay un test que lo fija). Es lo que acota la búsqueda por firma: su input no se tocó y sigue pidiendo
1.000.000 de abogados, pero el run no puede cobrar más de lo que queda.

Un run que gasta todo su límite pudo parar antes de tener todas las filas. Sus filas se conservan como
evidencia parcial para ese scan (el directorio queda `partial`, causa transitoria) y **la consulta no se
cachea**. Se comprueba dos veces: al terminar el run y otra vez cuando se liquida su coste, porque el coste
leído al terminar puede ser 0.

**Cuántos runs caben.** Cada run sin liquidar cuenta su reserva entera, y Apify tarda unos tres minutos en
liquidar (dos de espera más el siguiente pase de `reconcileCosts`, que corre cada minuto mientras el back
siga encendido).

| Configuración | Runs nuevos que caben hasta que se liquiden |
|---|---|
| Por defecto (`2` y reserva `1`) | 2. Es el scan de Jesús (una búsqueda por firma en el Bar) o una firma de un abogado (Bar y Avvo) |
| `APIFY_SPEND_CEILING_USD=5` | 5 |
| `APIFY_SPEND_CEILING_USD=5` y `APIFY_EXPECTED_COST_USD_PER_RUN=0.5` | 10: cinco abogados en los dos directorios |
| `APIFY_SPEND_CEILING_USD=0` | 0: solo caché |

Una vez liquidados cuentan por lo que costaron de verdad. Lo observado hasta hoy son dos datos: USD 0,045
por un run del Bar con 1 resultado y USD 0,38475 por uno de Avvo con 10. El techo por defecto es estrecho a
propósito: para una firma con plantilla hay que subirlo a mano y sabiendo cuánto se va a gastar.

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
  ledger que arranquen un run en el mismo instante pueden admitir uno de más cada uno.
- **Dos runs que arrancan juntos pueden sumar más límite que techo.** El límite del segundo descuenta la
  reserva del primero, no su límite. El exceso máximo es el techo menos una reserva (USD 1 con los valores
  por defecto) y solo se da si los dos son búsquedas por firma, las únicas que pueden pasar de su reserva.
- **Una plantilla cortada por el límite.** Solo afecta a la búsqueda por firma de una firma con muchos
  abogados (con USD 2, del orden de 40, extrapolando del único run del Bar medido). Si el coste al terminar
  leyó 0, el corte no se ve
  hasta la liquidación: ese scan usó el dataset como completo y su resultado queda en la caché de scans.
  La consulta sí deja de reutilizarse en cuanto se liquida.
- **El límite con que arrancó cada run vive en memoria.** Tras un reinicio, la segunda comprobación (al
  liquidar) no existe para los runs anteriores.
- **Más de 1.000 runs en 24 horas** no se pueden sumar con una lectura: el run se rechaza.

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
  límite no cambia input ni fingerprint; la búsqueda por firma sigue pidiendo 1.000.000 y lleva límite; un
  run que agotó su límite no se cachea; el directorio informa causa transitoria sin parar la cola.
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
| Assessment `COMPLETED` | `200 application/pdf`, `Cache-Control: no-store`, `Content-Disposition: attachment; filename="arca-assessment-<dominio>-<aaaa-mm-dd>.pdf"` (fecha de finalización, en UTC) |
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

**Web ilegible.** Con el flag `WEBSITE_UNAVAILABLE` hay una frase, con las dos redacciones de la pantalla:

| Tier del resultado | Frase |
|---|---|
| `CRITICAL` | "The firm's website could not be read during the scan. Until it can be read, this result stays in the highest-risk group and needs a manual review, whatever the answers show." |
| Cualquier otro | "The firm's website could not be read during the scan. Until it can be read, this result needs a manual review, whatever the answers show." |

Así la frase no contradice el tier que hay justo encima (el límite conocido de §3.3: con buenas respuestas el
compuesto llega a 70). No nombra la decisión ni un precio.

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
- **Un Chromium por petición, sin límite.** Es la segunda ruta que lo hace: duplica la superficie del riesgo 12
  de DN-08. No se añadió tope de concurrencia.
- **No es el Full Assessment Report del roadmap.** Usa el banco y la fórmula demo, y lo dice. El informe
  definitivo sigue en la fase 5 de DN-07.
- **El texto vive en dos sitios.** Las frases del informe están en el back y las de la pantalla en el front,
  copiadas a mano. Pueden divergir.
- **"1 hours per lawyer / year".** La unidad viene del banco y se imprime tal cual.

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
- `packages/scoring/tests/layer2.test.ts`: el texto de cada paso del plan.

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

Pendiente.

## 9. Lo que no cambia

- El contrato publicado: `@arca/contracts` sigue en 0.4.0, sin campos ni valores nuevos (D6).
- La identidad: el dominio sigue sin convertirse en nombre de firma (DN-04).
- Producción: nada de mock ni de debug llega a ella (DN-09), y su gasto de Apify sigue sin techo (§5).
- El input de las consultas a Apify y su fingerprint: los runs ya cacheados siguen valiendo (§5.1).
