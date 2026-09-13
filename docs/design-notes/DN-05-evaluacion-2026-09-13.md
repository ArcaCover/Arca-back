# DN-05 — Evaluación con firmas reales (13 de septiembre de 2026)

Estado: **evaluación exploratoria, no cumple los gates de la sección 12 de DN-05.** Dos sitios, sin
etiquetas humanas completas y con corridas incompletas. Sirve para elegir modelo de trabajo y detectar
defectos, no para autorizar la sustitución del extractor.

Sitios: `duqueimmigration.com` (español) y `gallardolawyers.com` (bilingüe). Crawls congelados en
`output/demo/*-2026-09-13T04-34-1*` y reutilizados en todas las comparaciones, sin volver a rastrear.

## 1. Primera ejecución de la demo (modelo por defecto `nvidia/nemotron-3-super-120b-a12b`)

| Firma | Resultado | Duración |
| --- | --- | --- |
| Duque | Falla: `extract response failed schema validation` | 72.7 s |
| Gallardo | Falla: `extract-roster response failed schema validation` | 147.8 s |

Ambos crawls fueron correctos (12 páginas, sin issues). Los intentos del modelo **se perdían** al fallar
una fase: `attempts/` quedaba vacío. Se corrigió (ver sección 5).

Reproducir la extracción de Duque con el mismo crawl **sí pasó el esquema**: el fallo es intermitente
incluso con `temperature: 0`.

Gallardo superó el p95 de 120 s exigido por DN-05 §12.1.

## 2. Benchmark de modelos del catálogo NVIDIA

Fase medida: solo `extract` (la primera llamada), mismo prompt y mismos corpus. Luego se aplicó la
aceptación determinista real (`acceptClaims`: cita literal, valor presente en la cita, guardas
semánticas) con veredictos de revisión sintéticos marcados como `supported`, para aislar el efecto del
modelo. No incluye la pasada de roster ni la revisión semántica real.

| Modelo | Firma | Latencia | Esquema | Aceptados / rechazados | Observación |
| --- | --- | --- | --- | --- | --- |
| nemotron-3-super-120b | Duque | 33.6 s | ok | 7 / 9 | **Aceptó a Diana Posada (paralegal) como abogada** |
| nemotron-3-super-120b | Gallardo | 41.6 s | ok | 7 / 4 | 0 abogados aceptados |
| deepseek-v4-flash | Gallardo | 17.7 s | ok | 16 / 25 | 8 abogados reales; 18 citas inexistentes (rechazadas) |
| deepseek-v4-flash | Duque | — | — | — | No respondió en la ventana; corrida detenida |
| deepseek-v4-pro | Duque | 124.7 s | ok | 9 / 6 | Correcto: 1 abogado, conteo 1, sin año |
| deepseek-v4-pro | Gallardo | 83.2 s | ok | 12 / 1 | 7 áreas, 0 abogados |
| kimi-k3 | Duque | 96.7 s | ok | 8 / 1 | Correcto: 1 abogado |
| kimi-k3 | Gallardo | — | — | — | **HTTP 429** |
| glm-5.3-flash | Duque | 36.5 s | ok | 12 / 3 | Correcto: 1 abogado, sin paralegales, sin año |
| glm-5.3-flash | Gallardo | 67.7 s | ok | 13 / 25 | 3 abogados reales; 22 afirmaciones sin cita (rechazadas) |
| gemma-4-31b-it | ambas | — | — | — | No respondió en la ventana; corrida detenida |
| nemotron-3.5-lightning | ambas | — | — | — | No respondió en la ventana; corrida detenida |

Lectura: los rechazos por cita inexistente o ausente son un **modo de fallo seguro** (el verificador los
descarta). Lo que importa son las aceptaciones incorrectas. En esta muestra, solo el modelo por defecto
aceptó una afirmación falsa.

**Modelo de trabajo elegido para las pruebas: `z-ai/glm-5.3-flash`.** Sin aceptaciones incorrectas
observadas, esquema válido en ambas firmas y latencia intermedia. `deepseek-v4-pro` fue más preciso pero
su latencia de una sola llamada ya roza el límite del workflow completo.

## 3. Hallazgos de calidad

**Año de fundación inferido de la carrera del abogado.** En Duque, el modelo por defecto propuso 2007 a
partir de «se graduó… (Cum Laude 2007)» y «ha estado ejerciendo… desde 2007». La guarda semántica de
`signal-grounding.ts` lo rechaza (`UNSUPPORTED_CLAIM`) porque la cita no dice «fundado» ni equivalente.
La defensa en profundidad funcionó.

**Personal clasificado como abogado.** Melina Ocampo («Coordinadora de casos humanitarios») y Diana
Posada («Paralegal en inmigración»), ambas «con licencia para ejercer únicamente en Colombia», llegaron
con `role: "Attorney"`. `normalizeClaims` agrava el error: busca `attorney` en rol y cargo concatenados
antes que `paralegal`/`coordinador`, así que el rol que declara el modelo gana sobre el cargo citado.
Para un producto que consulta el Florida Bar, **la señal relevante es la licencia en Florida**, y el
contrato no la modela.

**Roster: el cuello de botella no es el corpus.** La página `/attorneys` de Gallardo lista **25 abogados
con rótulo «Lawyer»** y los 25 llegaron al corpus enviado al modelo. (Corrección: un primer conteo
automático dio 29 porque la expresión regular tomó cuatro rótulos de servicio como nombres.) Ningún modelo pasó de 8 en la fase
`extract`. La recuperación del roster depende del modelo y de la pasada dedicada de roster, no del
recorte del corpus.

**El Florida Bar tampoco es un roster confiable.** De los 7 abogados que devolvió la búsqueda por despacho
el 12 de septiembre, **Paul J Agbeyegbe, Christopher Delgado y Asad Mitri Demetree no aparecen en el
sitio**, y la mayoría de los 25 del sitio no estaban en esa respuesta. Ninguna de las dos fuentes sirve
sola como verdad de terreno.

**Presupuesto del corpus mal repartido.** De 24,000 caracteres, cinco páginas de servicios de Gallardo
entraron con 0 caracteres y otras dos con menos de 70, mientras la portada y `/about` ocupan casi 5,700
cada una.

## 4. Workflow completo con `glm-5.3-flash`

Tres ejecuciones por firma del workflow completo (extracción, `fetch_pages`, roster, revisión semántica
y aceptación), las seis en paralelo y sin llamadas a Apify.

| Corrida | Resultado | Duración | Causa |
| --- | --- | --- | --- |
| Duque 1, 2 y 3 | Falla | 82–129 s | `fetch_pages` pidió el PDF de privacidad y el crawler lo rechaza |
| Gallardo 1 | **Completa** | 202 s | 35 afirmaciones aceptadas, 2 rechazadas |
| Gallardo 2 | Falla | 228 s | Timeout del cliente (120 s por llamada) |
| Gallardo 3 | Falla | 210 s | HTTP 500 del API de NVIDIA, sin reintento |

**Tasa de éxito: 1 de 6. Ninguna corrida quedó bajo el p95 de 120 s.** Con seis navegadores en paralelo
los crawls trajeron 8–10 páginas en lugar de 12, así que las corridas no parten del mismo corpus.

Todos los intentos quedaron en `output/demo/*-2026-09-13T06-35-44-*/attempts/`.

### 4.1 Bug determinista en `fetch_pages`

En las tres corridas de Duque el agente pidió la política de privacidad, que en ese sitio es
`/wp-content/uploads/2023/05/DuqueImmigrationPoliticaPrivacidad.pdf`. La decisión fue correcta.

`evidence-corpus.ts` ofrece cualquier link del mismo host, PDFs incluidos. `crawlWebsite` los rechaza en
`crawler.ts:64` porque `canonicalUrl` excluye extensiones de archivo, y el error se propaga hasta abortar
el workflow completo.

Correcciones necesarias: construir el catálogo de links con el mismo `canonicalUrl` que usa el crawler, y
aislar el fallo de cada link recuperado para que un link inválido no descarte la extracción ya hecha.
Aparte, el crawler no lee PDFs, así que hoy la señal de privacidad de Duque es inalcanzable.

### 4.2 Resultado de la corrida exitosa de Gallardo

- Identidad `VERIFIED`: Gallardo Law Firm, Miami, (305) 261-7000, fundación 2012, 7 áreas canónicas.
- **24 abogados aceptados de los 25 que lista el sitio.** Las reglas aceptaban 2 y la fase `extract` sola
  llegaba a 8. La pasada de roster más la revisión semántica resuelven el recall.
- Solo 2 rechazos, ambos `UNCERTAIN_ATTRIBUTION`: un modo de fallo seguro.
- Gobernanza de IA y privacidad quedaron desconocidas: no estaban en las 8 páginas rastreadas.

### 4.3 Sesgo alfabético en la ruta dirigida (resuelto)

El harness originalmente reducía `identity.attorneyNames` a 15 y `maxTargets` a 2, por lo que una firma
grande solo consultaba los primeros nombres alfabéticos. La ruta dirigida ahora conserva cada identidad
normalizada y programa una consulta por abogado; los máximos de los actores son solo sus techos documentados
(`1,000,000` para Florida Bar y `100,000` para Avvo) y el cliente pagina el dataset de Apify hasta agotarlo.

### 4.4 Resiliencia y latencia

`maxRetries: 0` hace que un 500 o un timeout transitorio descarte más de 200 s de trabajo ya pagado en
tokens. No hay reintento acotado por fase ni checkpoint. Las fases `extract`, `refine` y `extract-roster`
son secuenciales; solo los lotes de revisión corren en paralelo.

El caso de la paralegal de Duque no llegó a evaluarse en el workflow completo: las tres corridas fallaron
antes de la revisión semántica.

## 4.5 Score parcial sin directorios

Calculado con `evaluateLayer1Evidence` y `bar`/`avvo` en `skipped`, para medir cuánto aporta la web sola.

| Escenario | Score | Tier | Decisión |
| --- | --- | --- | --- |
| Gallardo, workflow completo `glm-5.3-flash` | 9 / 100 | CRITICAL | UNKNOWN |
| Duque, aproximación (extract `glm` + aceptación, sin revisión ni roster) | 3 / 100 | CRITICAL | UNKNOWN |
| Techo teórico: todas las señales web al máximo | 47 / 100 | GUARDED | UNKNOWN |

Gallardo solo puntúa en madurez (W7 = 3, W5a = 3, W8 = 3). **Los 24 abogados verificados no suman nada sin
Apify**: solo alimentan Situación profesional, que se calcula con el Florida Bar. **53 puntos dependen de los
directorios** (Situación profesional 30, Reputación 20, W9_A2 3), así que ningún despacho obtiene una decisión
automática con evidencia web únicamente.

## 4.6 Hallazgo: negativos aceptados a partir del silencio

En Duque, `glm-5.3-flash` propuso los cuatro negativos de Gobernanza de IA sin evidencia:

| Afirmación | Justificación del modelo | Cita usada |
| --- | --- | --- |
| `ai_policy: {found: false, depth: none}` | «No AI policy mentioned anywhere on the site» | «Duque Immigration Law, PLLC» |
| `ai_in_services: {found: false}` | «No AI tools mentioned in service descriptions» | «Residencia permanente» |
| `ai_disclosure: {found: false}` | «No AI disclosure found on the site» | «Duque Immigration Law, PLLC» |
| `ai_blog_posts: {found: false}` | «No AI-related blog posts found» | «Últimos artículos» |

El prompt prohíbe inferir ausencia de la falta de texto, y las citas no guardan relación con la afirmación. El
verificador las aceptaba porque en campos objeto no comparaba cita y valor, y no exigía negación explícita para
un `false`. Resultado: Gobernanza de IA salía `KNOWN` con W1–W4 = 0 en lugar de `UNKNOWN`. El total no cambia,
pero un cero conocido cuenta como evidencia evaluada y puede habilitar una decisión automática indebida. Es la
confirmación con datos reales del hallazgo R02 de la revisión.

**Corrección implementada** (`signal-grounding.ts`, función `checkAbsences`):

- Un negativo de IA (`found: false`, `depth: none`, `none_detected`, conteo 0, lista vacía) solo se acepta si
  alguna cita contiene una negación explícita cercana a un término de IA, en español o inglés, con acentos
  normalizados («No utilizamos inteligencia artificial», «We do not use ChatGPT»).
- Las ausencias que dependen de todo un documento o sitio nunca se aceptan desde una cita: sin política de
  privacidad, política que no menciona datos de clientes, `no_team_page` y conteos en cero.
- En afirmaciones mixtas se conserva la parte positiva y se anula solo el negativo sin sustento; el ítem registra
  los subcampos anulados en `degradedFields`.
- Si no queda información, el ítem pasa a `unknown` con motivo nuevo `UNSUPPORTED_ABSENCE` y no llega al scoring.
- La prueba de negación es necesaria, no suficiente: quién niega usar IA (el despacho o un consejo a clientes)
  sigue a cargo de la revisión semántica.

Verificación: al recalcular el score parcial de Duque, Gobernanza de IA pasa de `KNOWN` (W1–W4 = 0) a `UNKNOWN`,
con el mismo total de 3. Gallardo y el techo teórico no cambian.

## 5. Cambios aplicados durante la evaluación

- `nvidia-evidence-provider.ts`: cada intento se registra antes de validarse; los fallos lanzan
  `ExtractionFailure` con todos los intentos y los errores de validación.
- `demo-signals.ts`: escribe `attempts/` y un resumen de validación también cuando la demo falla.
- Prueba nueva: `keeps every rejected attempt when the answer never matches the schema`.
- Build limpio y suite en verde tras los cambios.

Scripts de diagnóstico (no versionados) en `output/diag/`: `replay-extract.ts`, `compare.ts`,
`corpus-coverage.ts`. Resultados crudos en `output/diag/bench/`.

## 6. Pendientes antes de cualquier sustitución

1. Etiquetas humanas por campo para ambas firmas; los rosters del sitio y del Bar no coinciden.
2. Corregir la clasificación de rol en `normalizeClaims` y modelar la jurisdicción de la licencia.
3. Medir la pasada de roster sobre los 25 abogados de Gallardo.
4. Repartir el presupuesto del corpus por relevancia, no por orden de llegada.
5. Completar el benchmark de `gemma-4-31b-it`, `nemotron-3.5-lightning` y `deepseek-v4-flash` en Duque.
6. Las gates de DN-05 §12 siguen sin cumplirse: faltan 20 snapshots, casos adversariales y tres corridas
   medidas en un conjunto reservado.
7. **Bloqueante:** filtrar links no recuperables en el corpus y aislar fallos por link en `fetch_pages`.
8. Vigilar costes y duración de directorios para rosters grandes; ya no se reduce el roster para respetar un
   presupuesto artificial de consultas.
9. Reintento acotado por fase ante 5xx y timeout, dentro del presupuesto global.
10. Reducir la latencia: 202 s en la única corrida completa, frente a un p95 exigido de 120 s.
11. Repetir las seis corridas en serie, no en paralelo, para separar el efecto de la concurrencia.

## 7. Línea base de precisión

Con el evaluador y las etiquetas verificadas de la Tarea 1 (`signal-evaluation.ts`,
`apps/api/tests/fixtures/gold/*.json`) ya en verde, se ejecutó la línea base exigida antes de tocar el
workflow.

### Intento 1 — `z-ai/glm-5.3-flash`: HTTP 404

```
NVIDIA_NIM_MODEL=z-ai/glm-5.3-flash npm run eval:signals -- duqueimmigration.com gallardolawyers.com --runs 3
```

Reporte completo: `output/eval/2026-09-13T17-26-28-777Z/summary.json` (no versionado, `output/` está en
`.gitignore`).

| Firma | Corrida | Estado | Duración | Correctos | Incorrectos | Recall de abogados |
| --- | --- | --- | --- | --- | --- | --- |
| duqueimmigration.com | 1 | Falló | 120.1 s | — | — | — |
| duqueimmigration.com | 2 | Falló | 120.1 s | — | — | — |
| duqueimmigration.com | 3 | Falló | 15.2 s | — | — | — |
| gallardolawyers.com | 1 | Falló | 0.7 s | — | — | — |
| gallardolawyers.com | 2 | Falló | 1.7 s | — | — | — |
| gallardolawyers.com | 3 | Falló | 1.0 s | — | — | — |

**Valores incorrectos:** ninguno; ninguna corrida llegó a `evaluateWebsiteData` porque las seis fallaron
antes de producir `WebsiteData`.

**Mensajes de error de las corridas fallidas:**

- Duque 1 y 2: `ExtractionFailure: Request timed out.` (se agotó el `timeout: 120_000` del cliente OpenAI
  en `nvidia-evidence-provider.ts` antes de recibir respuesta).
- Duque 3, Gallardo 1, 2 y 3: `ExtractionFailure: 404 status code (no body)`, en 0.7–15.2 s, sin ningún
  intento registrado en `attempts` (el fallo ocurrió en la primera llamada al API, antes de cualquier
  intento de extracción).

**Causa raíz identificada (diagnóstico, no se tocó código de producción):** una llamada directa al API de
NVIDIA NIM con el mismo `NVIDIA_NIM_API_KEY` confirma que el modelo `z-ai/glm-5.3-flash` —el mismo elegido
en la sección 2 y usado con éxito en la sección 4 el mismo día— responde **404 sin cuerpo** para
`POST /v1/chat/completions`, mientras que el modelo por defecto (`nvidia/nemotron-3-super-120b-a12b`)
responde `200` con el mismo payload. El modelo sigue listado en `/v1/models` pero no se sirve. Los dos
timeouts de Duque son compatibles con la misma causa: una ruta de modelo que empezó a responder lento o de
forma intermitente antes de dejar de servirse. Este intento se conserva como referencia histórica; no
produjo cifras de precisión.

### Intento 2 — `deepseek-ai/deepseek-v4-pro-0813`

Modelo de reemplazo confirmado disponible (llamada directa al API: HTTP 200) y con la mejor precisión del
benchmark de la sección 2. La latencia queda fuera de alcance para esta medición: el cliente OpenAI que
construye el script de evaluación usa un timeout de 600 s por llamada en lugar de los 120 s por defecto
del proveedor, inyectado por el tercer parámetro del constructor de `NvidiaNimEvidenceProvider` (sin tocar
`nvidia-evidence-provider.ts`), porque una extracción con `deepseek-v4-pro` puede tardar ~125 s.

```
NVIDIA_NIM_MODEL=deepseek-ai/deepseek-v4-pro-0813 npm run eval:signals -- duqueimmigration.com gallardolawyers.com --runs 3
```

Reporte completo: `output/eval/2026-09-13T17-45-51-008Z/summary.json` (no versionado, `output/` está en
`.gitignore`).

| Firma | Corrida | Estado | Duración | Correctos | Incorrectos | Recall de abogados |
| --- | --- | --- | --- | --- | --- | --- |
| duqueimmigration.com | 1 | Completa | 347.6 s | 5 | 0 | 1 |
| duqueimmigration.com | 2 | Completa | 267.6 s | 5 | 1 | 1 |
| duqueimmigration.com | 3 | Completa | 310.9 s | 5 | 0 | 1 |
| gallardolawyers.com | 1 | Completa | 375.3 s | 36 | 0 | 1 |
| gallardolawyers.com | 2 | Falló | 546.2 s | — | — | — |
| gallardolawyers.com | 3 | Completa | 325.7 s | 23 | 0 | 0.76 |

**Valores incorrectos (1 en total):**

- Duque, corrida 2 — campo `team_size`, valor `1`: la etiqueta dorada dice `correct: []` (no hay tamaño de
  equipo verificable), así que cualquier valor aceptado es incorrecto.

**Mensaje de error de la corrida fallida:**

- Gallardo, corrida 2: `ExtractionFailure: 504 status code (no body)`, a los 546.2 s, dentro del timeout
  de evaluación de 600 s (el API de NVIDIA devolvió el error, no un timeout del cliente).

**Lectura:** este es el número de referencia. 5 de 6 corridas completaron con el workflow actual (sin
cambios), 74 valores correctos evaluados en total y una sola aceptación incorrecta (`team_size` en Duque).
El recall de abogados fue 1.0 en Duque y Gallardo corrida 1, y 0.76 en Gallardo corrida 3 (variación entre
corridas del mismo modelo con el mismo corpus, sin re-muestreo del crawl). No se interpreta ni se ajusta
nada del workflow ni del extractor a partir de esta corrida; queda como línea base para comparar contra
tareas posteriores del plan.

## 8. Evaluación con harness

Evaluación posterior al harness con snapshots congelados y `z-ai/glm-5.3-flash`:
`output/eval/2026-09-13T21-31-27-584Z/summary.json` (no versionado). Tras cada falso positivo observado
se añadió una prueba y una guarda determinista: no confundir `attorney_count` con `team_size`, no usar una
dirección postal de política de privacidad como ciudad primaria, exigir evidencia por cada área de práctica y
rechazar teléfonos concatenados.

| Firma | Corrida | Estado | Duración | Herramientas | Correctos / outcomes | Incorrectos | Recall abogados |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Duque | 1 | Completa | 397.1 s | `read_document` ×2, `fetch_pages` | 3 / 13 | 0 | 1 / 1 |
| Duque | 2 | Completa | 435.9 s | `read_document` ×2, `fetch_pages` | 3 / 13 | 0 | 1 / 1 |
| Duque | 3 | Completa | 618.1 s | `read_document` ×2, `read_sitemap` | 2 / 13 | 0 | 1 / 1 |
| Gallardo | 1 | Completa | 397.7 s | `fetch_pages` ×4 | 29 / 37 | 0 | 25 / 25 |
| Gallardo | 2 | Completa | 373.2 s | `fetch_pages` ×4 | 29 / 37 | 0 | 25 / 25 |
| Gallardo | 3 | Falló | 338.7 s | — | — | — | — |

En las cinco corridas completas hubo **66 valores correctos de 113 outcomes**, **0 valores incorrectos**,
37 ausentes y 10 no verificados. Duque leyó ambas políticas de privacidad en las tres corridas (`read_document`
sobre `DuqueImmigrationPoliticaPrivacidad.pdf` y `DuqueImmigrationPrivacyPolicyEN.pdf`); `team_members` solo
incluyó a Carlos Mauricio Duque, sin nadie de `notAttorneys`.

Gallardo 3 no superó el gate: `ExtractionFailure: extract-roster response failed schema validation` después de
tres intentos (`extract-round-1`, `extract-roster`, `extract-roster-repair`). No fue un timeout ni un 5xx, por
lo que no se reintentó bajo la regla de la tarea. La comparación con la línea base de la sección 7 mejora de
1 aceptación incorrecta entre 5 corridas completas a 0 entre 5, y eleva el recall observado de Gallardo de
0.76–1.0 a 1.0 en las dos completas; sin embargo, ambas mediciones tuvieron 5/6 corridas completas.

**Decisión del gate: no pasa.** Aunque `incorrect accepted values: 0`, una de las seis corridas falló. Además,
las duraciones de 338.7–618.1 s están fuera del p95 de 120 s y esta evaluación exploratoria sigue teniendo solo
dos snapshots, no los 20 casos, adversariales ni conjunto reservado exigidos por DN-05 §12.
