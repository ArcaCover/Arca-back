# DN-05 — Extracción agéntica de señales con NVIDIA NIM

Fecha: 12 de septiembre de 2026. Revisión: 2.
Estado: diseño corregido para implementación; activación del reemplazo condicionada a la sección 12.

Esta revisión sustituye el diseño inicial y resuelve en especificación los hallazgos R01–R15 de
[DN-05-review](DN-05-review.md). Las correcciones todavía no son funcionalidades implementadas ni
resultados de evaluación. No implica despliegue ni cambios operativos en EC2.

## 1. Objetivo y límites

Reemplazar la extracción semántica por reglas con un workflow que usa un LLM para identificar señales,
decidir qué evidencia adicional recuperar y revisar el soporte de sus afirmaciones. Layer 1 continúa
evaluando datos estructurados de forma determinista.

Los escaneos históricos de Gallardo y Duque motivan el cambio, pero no sirven como benchmark del código
actual: el repositorio ya corrige algunos títulos SEO y la prioridad de páginas en español. Medir el
extractor vigente sobre los mismos snapshots usados para evaluar NIM.

Decisiones:

- Modelo inicial probado: `nvidia/nemotron-3-super-120b-a12b`; endpoint
  `https://integrate.api.nvidia.com/v1`; credenciales en `NVIDIA_NIM_API_KEY`.
- Una ronda adicional de adquisición elegida por el LLM, con herramientas de lectura controladas.
- Comprobación literal determinista y revisión semántica separadas. `accepted` significa que una
  afirmación pasó la política de aceptación; no significa verdad externa demostrada.
- Mantener fórmulas, umbrales y pesos de scoring, y la forma de `WebsiteData`, `FirmIdentity` y
  `Layer1Evidence`. Ampliar solo metadatos de resultado para identificar la versión de extracción.
- Demo local con CLI y HTML; cero consultas reales a Apify. Scoring offline con fixtures.
- Conservar reglas durante la comparación y retirarlas del runtime al pasar los gates. No habrá
  fallback silencioso a reglas ni al adaptador OpenAI antiguo ante fallos de NIM.

La API ya devuelve `202` y permite consultar el estado del scan. El workflow puede durar más que el
pipeline actual; actualizar su ciclo de vida completo, no solo el timeout del SDK.

## 2. Máquina de estados y agencia

```text
dominio normalizado
  → adquirir páginas iniciales y enlaces
  → construir corpus con manifiesto de cobertura
  → LLM extractor: candidatos + vacíos/conflictos + acción fetch_pages | finish
  → validar estructura, citas y acción
      ├─ fetch_pages permitido y con presupuesto
      │    → recuperar páginas → ampliar corpus → LLM reextrae → validar
      └─ finish / acción inválida / límite alcanzado
  → LLM revisor: juzgar soporte de cada afirmación en su contexto
  → aceptación determinista: soporte + citas + invariantes + contradicciones
  → WebsiteData + diagnósticos → FirmIdentity → DirectoryQuery
      ├─ demo: inputs de actores, sent:false → reporte
      └─ live habilitado: directorios → persistencia → Layer 1
```

`SignalExtractionWorkflow` controla el proceso. El modelo no ejecuta código ni accede a credenciales,
directorios pagados, scoring o repositorios. Herramientas:

- `fetch_pages({ linkIds, targetFields, reason })`: propone hasta cuatro enlaces observados en el sitio;
  el backend resuelve los IDs a URLs y valida cada navegación y redirección.
- `finish({ reason })`: finaliza la adquisición con la evidencia disponible.

La primera respuesta contiene candidatos y una acción como unión discriminada. La segunda extracción
ya no ofrece herramientas: devuelve candidatos sobre el corpus ampliado. No permitir URLs inventadas
ni volver a leer URLs ya recuperadas. Una acción inválida se registra y no se ejecuta; candidatos
válidos pueden seguir a revisión. Un JSON inválido usa la reparación acotada de la sección 7.

Priorizar identidad/afiliación, contradicciones, equipo/contacto, políticas/áreas y luego otras señales.
`unknown` no obliga por sí solo a buscar más. Parar al agotar una ronda adicional, páginas, tokens,
llamadas, tiempo o enlaces pertinentes. Registrar `SUFFICIENT_FOR_EXTRACTION`, `NO_RELEVANT_LINKS`,
`ROUND_LIMIT`, `PAGE_LIMIT`, `TOKEN_LIMIT`, `DEADLINE` o `PROVIDER_FAILURE`. Suficiencia para
extracción no implica suficiencia para una decisión comercial.

## 3. Adquisición, corpus y cobertura

Refactorizar `crawler.ts` para compartir una sesión entre crawl inicial y páginas dirigidas. Reutilizar
el transporte público y las protecciones de DNS/IP, redirects, robots, tamaño de respuesta, bloqueo de
websockets y cierre del browser al abortar.

- Inicial: hasta ocho páginas, 20 segundos y concurrencia máxima de tres navegaciones.
- Adicional: hasta cuatro páginas propuestas, 10 segundos y la misma sesión/visitados.
- Máximo: doce páginas distintas. Reintentos de transporte consumen tiempo y tienen su propio límite;
  no crean otra ronda agéntica. Revalidar seguridad y dominio en cada navegación.
- Profundidad dos para descubrimiento inicial. Permitir una página dirigida enlazada desde un documento
  leído aunque esté a profundidad tres. Solo host canónico y variante `www` admitida por el crawler.
- Conservar HTML crudo; separar texto principal, footer/contacto visible, metadatos y JSON-LD. No enviar
  HTML al modelo. Etiquetar navegación como descubrimiento y footer como evidencia de contacto.

`EvidenceCorpus` incluye dominio, `snapshotId`, versión del parser, páginas, segmentos, enlaces y
manifiesto. Cada documento identifica URL canónica/final, `fetchedAt`, hash y estado de lectura.
Cada segmento identifica documento, canal, texto canónico y localizador en la captura: offsets para
texto o ruta JSON. Conservar encabezados y relaciones entre bloques vecinos.

IDs derivados de URL + versión/hash del documento + localizador; no del índice en un array. Insertar
otras páginas no cambia IDs de documentos existentes; cambiar contenido sí cambia su versión.
Conservar texto del segmento y captura para reproducir validación.

Reutilizar helpers actuales solo donde sean correctos: usar un parser HTML que tolere atributos y
entidades válidos; evitar duplicar contenedores `@graph` y nodos; preservar relaciones organización,
dirección y persona. JSON-LD no tiene precedencia absoluta sobre evidencia contradictoria.

Segmentos de aproximadamente 800 caracteres, sin perder relación nombre/cargo. Deduplicar boilerplate
conservando todas sus ubicaciones. Seleccionar por campos objetivo, no por alfabeto. Reservar espacio
para identidad/equipo, contacto/políticas y servicios.

Medir tokens con el tokenizer del modelo y su serialización, incluyendo mensajes, esquema y salida
reservada. Validar el contador frente al uso reportado por el endpoint y aplicar margen de seguridad.
Si no se puede validar el tokenizer, no activar live. Límite inicial de entrada por llamada: 24.000
tokens, sujeto al límite efectivo comprobado del servicio. No asumir 256k ni una razón fija
caracteres/tokens.

El manifiesto registra URLs descubiertas, intentadas, leídas, bloqueadas y omitidas; segmentos
recortados, motivo, tokens y cobertura por campo: `observed`, `partial` o `unknown`. Ningún valor
significa que se recorrió todo el sitio. Para juzgar una política completa o listado completo, incluir
todo el documento relevante en el contexto del revisor; si no cabe, abstenerse de afirmar ausencia
o completitud.

## 4. Contrato interno de afirmaciones

Crear `packages/contracts/src/signals.ts`, exportado desde `index.ts`. Zod con objetos `.strict()`,
uniones discriminadas, tipos acotados y validaciones cruzadas. Contrato interno:

```ts
type Citation = {
  documentId: string;
  segmentId: string;
  quote: string; // no vacío, copiado del segmento canónico
};
type Claim<T> =
  | { status: 'observed'; value: T; citations: Citation[];
      explanation: string; basis: 'explicit' | 'classification' | 'complete_scope' }
  | { status: 'unknown'; value: null; citations: []; reason: string };
```

`observed` es un candidato, todavía no aceptado. `false` y `0` son valores posibles cuando el tipo
los admite, no sinónimos de desconocido. Ningún `observed` admite null o citas vacías. Acotar strings,
arrays y citas; rechazar fragmentos vacíos o solo puntuación. `explanation` es justificación breve
con sujeto, relación y alcance; no se solicitan cadenas de pensamiento.

Cada booleano/enum compuesto es una afirmación independiente para preservar aceptación parcial.
Colecciones tienen `items` con citas por elemento y completitud separada; `[]` no demuestra ausencia.
Conservar IDs de elementos rechazados para no mezclar procedencias.

Incluir en el esquema límites de tamaño acordes con el presupuesto de salida. Priorizar identidad y
campos de scoring cuando no quepa todo; registrar elementos/campos omitidos y completitud desconocida.
Una respuesta truncada nunca se toma como un listado completo. Los límites y prioridades forman parte
del fingerprint y se evalúan con firmas de equipos grandes.

| Candidatos | Tipo y criterio | Destino en WebsiteData |
| --- | --- | --- |
| `firm_name`, aliases | Operador del sitio; cada alias con relación explícita | `firm_name`, `firm_aliases` |
| `city`, `county`, `address_street`, `phone` | Oficina principal declarada o única oficina observada; no mezclar sedes | Campos homónimos |
| `attorneys.items` | `full_name`, `title`, `role: attorney/staff/unclear`, `affiliation: current/former/unclear`, cada componente con soporte | `team_members`, solo nombre, rol legal y afiliación actual aceptados; título puede ser null |
| `attorney_total`, `roster_complete` | Entero declarado o listado cuya completitud se acepta | `team_size` |
| `office_total`, `offices_complete` | Total declarado o inventario completo de oficinas propias | `office_count` |
| `team_page_quality` | `detailed/names_only/no_team_page` | Campo homónimo |
| `firm_established_year` | Entero entre 1000 y año de observación, referido a la firma | Campo homónimo |
| `practice_areas.items` | Etiqueta canónica y cita original | `practice_areas` |
| `website_quality` | `robust/basic/minimal` | Campo homónimo |
| `ai_policy.found`, `.depth` | Booleano y `comprehensive/basic/mention_only/none` separados | `found`, `depth`; `text_excerpt` de citas aceptadas |
| `ai_in_services.found`, `.tools.items`, `.integration_depth` | Uso propio; `core_service/supplementary/experimental/none_detected` | `found`, `tools_mentioned`, `integration_depth` |
| `ai_disclosure.found` | Comunicación sobre IA propia y revisión/limitaciones | `found`, `text_excerpt` |
| `ai_blog_posts.found`, `.items`, `.total` | Posts únicos por URL canónica; título por post; total declarado/completo | `found`, `titles`, `count` |
| `privacy_policy.found`, `.mentions_client_data` | Existencia y tratamiento de datos de clientes, separados | Campos homónimos |

Las áreas canónicas son exactamente los nombres `area` de `PRACTICE_AREAS` del scoring actual.
Inyectar esa lista versionada en la política y probar paridad; evitar copias divergentes.
«Derecho de inmigración» se clasifica como `Immigration`, conservando la cita española. Áreas fuera
de taxonomía quedan en diagnóstico como `unmapped`. Si hay áreas explícitas materiales sin representar
o conflictos en ese campo, mapear `practice_areas=null` para no comparar una lista artificialmente
incompleta como si fuera fiel. Nunca inventar equivalencias para aumentar cobertura.

Conteos enteros no negativos. Deduplicar por identidad/afiliación, no solo nombre; homónimos inciertos
producen conflicto. `observed_attorney_count` es diagnóstico, no `team_size`. Un total declarado de
25 puede coexistir con tres perfiles. Si el total declarado es menor que personas distintas actuales
aceptadas bajo el mismo alcance, el total queda desconocido. No estimar desde muestras. Aplicar el
mismo criterio a oficinas y posts.

## 5. Política de soporte y aceptación

### 5.1 Comprobación literal

`validateCitations` verifica IDs del snapshot, citas y localizadores. Usar normalización NFC y espacios
de presentación con mapa reversible a offsets; conservar acentos, negación y puntuación significativa.
No usar matching aproximado para acreditar citas. Normalizar nombres/teléfonos por separado para
comparar valores, conservando originales. Toda cita de una afirmación debe ser válida.

Esta etapa prueba presencia textual y consistencia de tipos/rangos. No decide si un párrafo acredita
política propia, afiliación o fundación.

### 5.2 Revisión semántica obligatoria

Una llamada separada al mismo modelo revisa los candidatos finales. Recibe valores, citas, corpus,
manifiesto y rúbrica; no recibe la explicación persuasiva del extractor. Delimitar candidatos y sitio
como datos no confiables. Por ID emite `supported/unsupported/uncertain`, motivo breve y citas propias.
No puede editar valores.

Comprobar sujeto, afiliación actual, negación, alcance temporal, rol de página y contradicciones.
Buscar evidencia incompatible en todo el corpus seleccionado, no solo en citas propuestas.
Si el contexto relevante no cabe íntegro, el campo queda `uncertain`.

La misma familia de modelos puede repetir errores correlacionados. La revisión reduce riesgo y se
evalúa con el benchmark; no es una prueba determinista de verdad.

### 5.3 Rúbricas y coherencia

| Campo | Condición de aceptación |
| --- | --- |
| Firma/persona/contacto | Relación con el operador del sitio respaldada por contexto; excluir clientes, rivales, testimonios y exmiembros. Metadata aislada contradictoria no basta. |
| Fundación | Declaración sobre fundación de la firma; excluir copyright, experiencia acumulada y admisión de un abogado. |
| Política IA | `basic`: pautas concretas de uso interno. `comprehensive`: documento dedicado con uso, protección de datos y revisión/responsabilidad. `mention_only`: mención propia sin reglas; no acredita política. Asesoría a clientes no acredita gobierno propio. |
| Uso IA | Uso propio actual; excluir noticias, recomendaciones y negaciones. `core_service`: central al servicio; `supplementary`: apoyo; `experimental`: piloto declarado. No inferir profundidad por marca. |
| Equipo | `detailed`: listado identificado del equipo con perfiles y biografías sustantivas. `names_only`: listado sin biografías en su ámbito completo. Perfil aislado no clasifica todo el equipo. `no_team_page`: solo declaración explícita, no falta de URLs visitadas. |
| Calidad web | Calidad informativa, no estética. `robust`: identidad/contacto, servicios explicados y equipo con perfiles. `basic`: identidad/contacto y servicios, con cobertura para evaluar el resto. `minimal`: ámbito completo de sitio explícitamente de una página y escaso contenido. Si la cobertura no permite clasificar, null. |
| Privacidad | Existencia no implica datos de clientes. Un negativo de mención requiere política identificada completa, sin omisiones y revisada íntegramente. |

Aceptar negativos explícitos bien atribuidos: «No usamos IA» puede acreditar uso `false`.
Ausencia por inspección solo en ámbito cerrado comprobado; agotar el crawl no demuestra ausencia
en el sitio. Nunca convertir falta de mención en `false`, `0`, `none`, `none_detected` o
`no_team_page`.

Invariantes: política `basic/comprehensive` implica `found=true`. `mention_only` conserva
`found=null` salvo negación explícita de política propia; el consumidor actual interpreta ese
depth como mención y no política. `none` requiere ausencia explícita de política propia. Una mención
no sobreescribe política aceptada. Uso `false` y herramientas propias actuales no pueden coexistir;
`none_detected` solo con uso negativo respaldado. Blog positivo requiere al menos un post aceptado.
Mención positiva a datos de clientes requiere política existente aceptada. Conflictos irresueltos
anulan únicamente campos dependientes.

### 5.4 Aceptación y mapeo

`acceptClaims` es puro: exige estructura válida, citas válidas, dictamen `supported` con citas válidas,
invariantes y ausencia de contradicciones sin resolver. El resto queda `unknown`. Estados del reporte:
`accepted/rejected/unknown`, sin etiqueta genérica `verified`. Motivos:
`MISSING_CITATION`, `UNKNOWN_SEGMENT`, `QUOTE_NOT_IN_SOURCE`, `UNSUPPORTED_CLAIM`,
`UNCERTAIN_ATTRIBUTION`, `CONFLICT`, `INCOMPLETE_SCOPE`, `UNMAPPED_AREA`, `BUDGET_LIMIT`,
`PROVIDER_ERROR`.

`toWebsiteData` inicia con `unknownWebsite()`, aplica la tabla y termina con `WebsiteData.parse`.
Arrays desconocidos son null; vacíos exigen ausencia/completitud aceptadas. Guardar citas aceptadas
por campo en `provenance` como URL, fragmento y `method:'provider'`. Procedencia por elemento/ID
también vive en diagnósticos. Excerpts copiados de citas, no generados. Ningún candidato rechazado
participa en identidad o consultas.

## 6. Presupuesto de ejecución y cancelación

Valores iniciales de ingeniería, sujetos a medición; no son promesas de latencia del proveedor:

| Recurso | Límite |
| --- | --- |
| Scan completo | 300 segundos desde inicio del pipeline |
| Website: adquisición, LLM, revisión y mapeo | 150 segundos |
| Directorios | Hasta 140 segundos, siempre antes del segundo 290 |
| Persistencia y finalización | Reserva final de 10 segundos |
| Llamadas LLM por website | Cuatro en total: extracción, refinamiento opcional, revisión y una reparación opcional |
| Cada llamada LLM | 25 segundos como máximo y nunca más que el deadline restante |
| Tokens por llamada | Hasta 24.000 de entrada total y 4.000 de salida; reducir si el endpoint tiene límites menores |
| Tokens por website | Hasta 100.000 de entrada acumulada y 16.000 de salida acumulada |
| Inferencias simultáneas por proceso | Dos; espera en cola máxima cinco segundos, incluida en el presupuesto |

Cada llamada, incluida una reparación o error HTTP, consume un intento del máximo de cuatro.
No se reintentan errores de transporte/429 automáticamente. El límite de tokens se comprueba antes
de cada solicitud usando el máximo reservado; no esperar a gastar el presupuesto para detectarlo.
Registrar tokens estimados y uso real cuando exista. Si el uso real contradice el presupuesto, detener
el workflow y revisar el contador antes de activar nuevos casos live.

Reservar 30 segundos para revisión final y mapeo. No iniciar adquisición/refinamiento/reparación si
deja sin esa reserva, salvo que la reparación corresponda a la propia revisión y quepa en el límite
restante. Sin revisión semántica válida no se publica ningún candidato. Un refinamiento fallido puede
conservar candidatos iniciales, pero deben revisarse contra el corpus final incluyendo contradicciones
descubiertas; no reciclar un dictamen anterior.

Implementar un contexto por ejecución con reloj monotónico, deadline absoluto, contadores, signal y
registro de trazas. Los límites locales se combinan con cancelación del padre. Al vencer website,
terminar su trabajo y devolver datos ya aceptados o desconocimiento con diagnóstico; directorios pueden
usar el tiempo reservado si existe identidad aceptada. Nunca iniciar runs pagados tras el deadline.

Actualizar conjuntamente:

- `InProcessPipeline`: deadline global y de fases; el límite previo de 55 segundos ya no aplica a NIM.
- `server.ts`: recuperación por antigüedad a 360 segundos, tanto al iniciar como periódicamente;
  derivar desde presupuesto global + 60, evitando constantes 60/120 antiguas.
- Drain: dejar terminar trabajo activo hasta el presupuesto global + cinco segundos. Coordinar gracia
  del proceso/contenedor/servicio para que no mate el trabajo a los 10/60 segundos anteriores.
- Documentación del polling y mocks de reloj: scans en curso no deben recuperarse como interrumpidos.
- Cola NIM compartida con cancelación de waiters y liberación en `finally`, independiente de Apify.

Esta configuración supone el único proceso API de la demo actual. Escalar a múltiples workers requiere
propiedad/lease de jobs y coordinación de concurrencia; no afirmar que el límite por proceso es global.
Si las mediciones no caben, reducir corpus/rondas o cambiar el presupuesto de forma explícita y
versionada; no extender deadlines durante una ejecución.

## 7. Cliente NIM y sonda reproducible

Crear `nvidia-signal-client.ts` como transporte sin lógica de scoring ni persistencia. Configurar el SDK
compatible ya instalado con baseURL fija, clave explícita, `maxRetries:0`, `stream:false`,
`temperature:0`, `max_tokens:4000` y timeout derivado de la sección 6. Modelo:
`NVIDIA_NIM_MODEL?.trim() || 'nvidia/nemotron-3-super-120b-a12b'`.

La sonda del 12 de septiembre de 2026 confirmó que `nvidia/nemotron-3-nano-30b-a3b` fue retirado el
1 de septiembre (HTTP 410). `nvidia/nemotron-3.5-lightning-30b-a3b` agotó 30–120 segundos incluso
en sondas pequeñas el 12 de septiembre; el modelo Super configurado respondió correctamente.
Las capacidades efectivas de
`chat_template_kwargs: { enable_thinking:false }` y `response_format` se prueban con el SDK y servicio
exactos; soporte en otra implementación del modelo no acredita soporte aquí.

Crear un script versionado `probe-nvidia.ts`, sin secretos incrustados. Salidas saneadas a `output/probe/`.
Probar separadamente:

1. Identificador y respuesta no streaming con una entrada mínima.
2. Flag de thinking y separación de contenido final; registrar comportamiento observable. Si no puede
   comprobarse que está desactivado, dejarlo como capacidad no confirmada y medir tokens/latencia reales.
3. JSON mode y, si está disponible, JSON Schema con nuestro esquema real. Aceptación HTTP no demuestra
   cumplimiento; validar las respuestas. Mantener perfil explícito `json_schema/json_object/prompt_json`.
4. Esquema representativo en español/inglés, contador de tokens, límite efectivo de entrada/salida y
   comportamiento ante truncación, rechazo y cancelación. No son pruebas de calidad semántica.

No negociar formatos silenciosamente en cada scan: elegir y versionar el perfil probado. Zod valida
siempre. Recibir solo el JSON final; tolerar únicamente un bloque markdown exterior si el perfil lo
requiere y lo prueba. No extraer el primer objeto con una regex de una respuesta ambigua. Rechazar
contenido vacío, múltiples objetos, refusal, respuesta pendiente no completada o
`finish_reason` incompatible con una terminación completa.

Una sola reparación global para errores de JSON/esquema, con respuesta fallida, errores y corpus
necesario, manteniendo el presupuesto de tokens/tiempo. Reparar formato no autoriza inventar evidencia.
Toda respuesta reparada vuelve a todas las validaciones. Si falla el revisor, no aceptar afirmaciones.
Prompts, esquemas, parámetros y perfiles deben quedar versionados para comparar ejecuciones.

## 8. Interfaces, auditoría y estados de fuente

No implementar un método que devuelve solo `WebsiteData` y luego intentar recuperar su diagnóstico
desde estado mutable. El diseño interno nuevo es:

```ts
interface SignalModelClient {
  readonly id: string;
  readonly version: string;
  complete(request: SignalModelRequest, context: RunContext): Promise<ModelAttempt>;
}
interface WebsiteEvidenceWorkflow {
  run(domain: string, context: RunContext): Promise<ExtractionOutcome>;
}
type ExtractionOutcome = {
  data: WebsiteData | null;
  diagnostics: ExtractionDiagnostics;
  status: SourceStatus;
};
```

`SignalExtractionWorkflow` compone adquisición, corpus, cliente, validación, revisión y mapper.
`WebsiteExtractionSource` recibe el workflow y adapta el resultado al contrato existente
`SourceResult<WebsiteData>`. La demo usa el mismo workflow y un sink de archivos. La interfaz antigua
se mantiene solo para comparación temporal de reglas y se elimina de la ruta nueva al migrar.

`ExtractionDiagnostics` incluye run ID/dominio, versiones/fingerprint, manifiesto, capturas/corpus,
acciones propuestas/ejecutadas/rechazadas, candidatos, dictámenes, aceptación por campo y todas las
solicitudes/respuestas, uso, tiempos y errores de intentos. No incluir headers de autorización ni keys.

Registro incremental y aislado por ejecución: el contexto emite eventos antes/después de cada fase y
el propietario guarda la traza ya recibida. Al cancelar o fallar, el resultado conserva la traza parcial
sin esperar a una promesa remota que no termine. `WebsiteExtractionSource` serializa datos y diagnóstico
en `rawContent`; la persistencia del pipeline sigue siendo obligatoria antes del resultado final.
Evitar `lastExtraction` compartido. Errores inesperados también conservan eventos acumulados.

Estados, usando los enums existentes:

| Resultado | status / dataStatus | Código |
| --- | --- | --- |
| Datos aceptados; objetivos de adquisición resueltos; sin fallos/recortes/rechazos | ok / PRESENT | Sin código |
| Datos aceptados y cobertura incompleta, rechazo o fallo recuperable | partial / PRESENT | Motivo específico en reason/diagnósticos |
| Ningún dato aceptado, sin fallo técnico | partial / UNKNOWN, data:null | NO_READABLE_EVIDENCE |
| Todo bloqueado o sin páginas legibles | error / UNKNOWN | ACCESS_BLOCKED o NO_READABLE_EVIDENCE |
| Presupuesto o timeout sin datos aceptados | error o timeout / UNKNOWN | BUDGET_EXCEEDED o DEADLINE_REACHED |
| Fallo del proveedor/contrato sin datos aceptados | error / UNKNOWN | PROVIDER_ERROR o PROVIDER_CONTRACT_ERROR |

`ok` no significa que todas las señales sean conocidas; null por incertidumbre legítima permanece.
Nunca `EMPTY` por no encontrar evidencia en un crawl parcial. No publicar `PRESENT` por haber obtenido
JSON válido. Una fuente partial puede aportar datos aceptados al scoring sin ocultar sus limitaciones.

## 9. Caché, configuración y sustitución

Crear `extractionFingerprint` de proveedor/modelo, perfil del endpoint, prompts de extractor/revisor,
esquema, parser/segmentación, rúbricas, mapper, taxonomía, selección y límites que afectan evidencia.
Añadir una revisión de despliegue explícita para invalidar resultados si cambia un alias de modelo
hospedado; el nombre del modelo no garantiza pesos inmutables.

Cachés:

- Ampliar `Layer1Result.meta` con `extractionFingerprint` opcional para leer históricos y presente en
  nuevos resultados. Un resultado sin fingerprint o diferente es cache miss, también antes del retorno
  temprano de `http/app.ts`. Comprobar compatibilidad antes de hacer parse estricto con la versión nueva;
  un histórico incompatible es miss, no error HTTP. Actualizar versión del contrato y sus fixtures.
- Mantener TTL de 24 horas para resultados compatibles, documentando que es evidencia histórica.
  Mantener `completedAt`/procedencia originales y `cached:true`; no aparentar una nueva inspección.
- Desactivar reutilización de análisis vía `latestRaw` para el workflow NIM v2. Es deliberado: el hash
  de las páginas iniciales no valida páginas adicionales ni cobertura anterior. No reutilizar análisis
  solo por modelo/prompt. Reintroducir esa optimización exige revalidar el manifiesto completo en otro
  cambio. Los raws siguen guardándose para auditoría/replay offline.
- El replay offline exige snapshot y fingerprint exactos, y conserva diagnósticos; no se presenta como
  una nueva llamada al modelo. Cambios de política invalidan tanto replay como resultados.
- La reutilización de scans simultáneos usa dominio + fingerprint; no mezclar configuraciones.

Transición:

1. Durante evaluación: mantener defaults actuales y añadir NIM explícitamente para CLI y pruebas.
   Capturar baseline de reglas sin modificar sus resultados para favorecer la comparación.
2. Gate aprobado: seleccionar NIM por defecto y retirar `RuleBasedEvidenceProvider` del runtime.
   Conservar fixtures y resultados del baseline; retirar solo pruebas exclusivas de helpers eliminados.
3. Para evitar una ruta sin revisión, retirar también la selección del adaptador OpenAI antiguo del
   runtime final. Una futura alternativa debe implementar `SignalModelClient` y usar el mismo workflow.
   En la versión final `WEBSITE_EVIDENCE_PROVIDER` admite únicamente `nvidia`; valores antiguos dan un
   error de migración explícito. El uso del SDK compatible no equivale a activar el proveedor OpenAI.
4. Construir clientes solo en live; mock no requiere claves NIM/Apify. CLI usa configuración mínima y
   no importa el entrypoint del servidor ni su validación de almacenamiento/directorios.
5. Actualizar envs de ejemplo, README, DN-03/DN-04 donde describan comportamiento sustituido, smoke de
   contenedor y pruebas de arranque. Normalizar variables vacías antes de aplicar defaults.
6. Preparar instrucciones de migración de entorno antes de un despliegue separado; no cambiar la
   instancia, ECR, DNS ni el entorno remoto como parte de esta implementación local.

## 10. Demo, directorios y reporte

Script: `npm run demo:signals -- duqueimmigration.com`. Cargar `.env.local` si existe y permitir
variables de proceso sin exigir archivo. Requerir solo clave NIM para demo live y dependencias del
crawler. Modo `--replay <snapshot>` funciona sin claves ni red. Dominio normalizado antes de usarlo
en red o rutas; timestamp compatible con Windows, sin dos puntos.

Extraer funciones puras `buildDirectoryQuery(identity, limits)` y
`buildDirectoryInputs(source, query)` a un módulo sin dependencias de red. El pipeline y la demo
comparten selección de targets, muestreo, fallback, límite y parámetros. Los inputs devuelven
`{ target, actor, input }` para conservar correlación con respuestas. Mantener payloads actuales y
`maxTargets=2`; `INSUFFICIENT` produce cero targets. No crear un LLM que redacte inputs de Apify.

Salida `output/demo/<domain>-<timestamp>/`, ya ignorada por Git:

- `manifest.json`: versiones, tiempos, uso, cobertura, motivo de parada y `sent:false`.
- `crawl/`, `corpus.json`, `attempts/`: capturas, segmentos y cada solicitud/respuesta/error.
- `candidates.json`, `review.json`, `acceptance.json`, `website-data.json`.
- `identity.json`, `directory-query.json`, `directory-inputs.json` y `report.html`.

Escribir artefactos parciales también si falla una fase. El reporte muestra valores, abstenciones,
motivos, citas localizables, contexto, uso/latencia y payloads no enviados. Distinguir cita válida,
soporte semántico y aceptación. No mostrar explicaciones como prueba de verdad.

HTML autocontenido: texto mediante nodos/textContent o escape por contexto, resaltados como nodos
seguros; nunca interpolar texto crudo como HTML. URLs solo http/https. Si se incrusta JSON, escapar
cierres de script. CSP sin conexiones externas, sin CDN, sin recursos remotos automáticos.

La demo no recibe transporte/credenciales Apify. Prueba con transporte espía que falla ante cualquier
intento de llamada a Apify; comprobar cero invocaciones. `sent:false` documenta el resultado, no lo
demuestra por sí solo. Scoring offline se ejecuta en el evaluador con directorios congelados, no con
consultas pagadas ocultas en la demo.

## 11. Orden de implementación

1. **Baseline y especificación ejecutable:** fixtures etiquetadas, captura de resultados vigentes,
   esquema de claims/invariantes, tabla de mapeo, taxonomía y casos adversariales.
2. **Adquisición y corpus:** sesión reutilizable, recuperación por link ID, footer, IDs/localizadores,
   deduplicación, tokenizer y manifiesto. Verificar protecciones y límites de red existentes.
3. **Cliente y capacidad:** sonda versionada, perfiles, prompts, parseo, cancelación, cola y budgets.
4. **Workflow:** extracción/acción, adquisición adicional, revisión, aceptación y mapper; salida con
   diagnósticos aislados. Sin cambiar aún defaults del servidor.
5. **Demo y evaluación:** helpers puros de directorios, reporte seguro, replay y evaluación contra
   baseline. Iterar por errores documentados, sin ajustar etiquetas del conjunto reservado.
6. **Integración:** fuente, trazas de error, deadlines/recuperación/drain, fingerprint, caché HTTP y
   arranque mock. Ejecutar scoring offline con la misma salida que consume producción.
7. **Sustitución:** pasar gates, cambiar defaults, retirar rutas antiguas del runtime y actualizar docs
   y smoke. Preparar migración; el despliegue queda como trabajo separado.

Archivos principales nuevos en `apps/api/src/pipeline/`: `evidence-corpus.ts`,
`signal-extraction-workflow.ts`, `nvidia-signal-client.ts`, `signal-grounding.ts`,
`signal-policy.ts`, `signal-mapper.ts`, `directory-inputs.ts` y `extraction-context.ts`.
Modificar crawler, website-source, wiring/env, pipeline, HTTP/metadatos y sus pruebas como se indica.
El mapa de módulos puede ajustarse al implementar sin eliminar responsabilidades ni gates.

## 12. Evaluación y condiciones de aceptación

### 12.1 Datos y métricas

Antes de optimizar prompts, congelar al menos 20 snapshots: al menos ocho en español y ocho en inglés,
con ambos dominios de la demo si son accesibles, y al menos 40 casos adversariales focalizados. Separar
diez sitios de desarrollo y diez de evaluación reservada, equilibrados por idioma; no ajustar prompts
con el conjunto reservado. Los casos adversariales pueden ser sintéticos y se reportan por separado.

Etiquetas humanas por afirmación, sujeto/alcance, citas y resultado esperado (positivo, negativo,
desconocido). No usar exclusivamente otro LLM como ground truth. Si las etiquetas no están disponibles
o faltan suficientes ejemplos por campo, el gate correspondiente queda pendiente; no declararlo pasado.
El listado histórico del Bar no se asume exhaustivo ni actual para el sitio.

Comparar dos aspectos por separado: extracción sobre corpus idéntico y workflow completo con páginas
adicionales. Reportar métricas micro, por sitio, campo e idioma; distinguir omisiones de adquisición,
extracción, rechazo e imposibilidad de representar taxonomía. Incluir precisión de afirmaciones
aceptadas, recall de hechos recuperables, abstención, conflictos, latencia p50/p95, llamadas y tokens.

Gates iniciales, medidos en el conjunto reservado y tres ejecuciones por snapshot:

- Cero aceptaciones falsas en los casos críticos de identidad, afiliación, negación, conteos,
  copyright y políticas ajenas del conjunto adversarial, en cada ejecución.
- Precisión de afirmaciones aceptadas de al menos 98% global y 95% por grupo con al menos 20
  afirmaciones aceptadas distintas evaluadas; si falta muestra, ampliar el conjunto antes de activar.
  Reportar como grupos identidad/afiliación, contacto, conteos, gobierno/uso IA, privacidad y madurez/áreas,
  con desglose por idioma. Repeticiones de la misma afirmación no aumentan el tamaño de muestra;
  los umbrales deben cumplirse en cada una de las tres ejecuciones.
- Recall de hechos explícitos representables y presentes en el corpus de al menos 85%, sin caída
  respecto a reglas en identidad/contacto por idioma. Reportar abstención para impedir pasar
  precisión devolviendo todo desconocido.
- Equivalencias español/inglés del benchmark producen el mismo valor canónico; ninguna penalización
  de áreas por traducción o pérdida silenciosa de categorías no representables.
- p95 de website como máximo 120 segundos, medido con inferencia real sobre snapshots; ninguna
  ejecución supera su deadline de 150 segundos más un segundo de cierre local. La ruta con crawl real
  también debe respetar ese límite. Cumplimiento del presupuesto global y de tokens en todas las pruebas.
- Aceptar datos parciales solo según la política documentada; no elevar resultados desconocidos a
  `SUFFICIENT` para mejorar una métrica. Scoring comparado con directorios fijos y etiquetas esperadas.

Son umbrales de liberación, no garantías estadísticas universales. Publicar denominadores, ejemplos
de fallos y variación entre ejecuciones. Si hay que cambiar rúbricas o umbrales, versionar la decisión
y justificarla antes de volver a medir; no relajar silenciosamente para pasar.

### 12.2 Pruebas obligatorias

- Corpus: IDs independientes del orden de páginas, trazabilidad exacta, JSON-LD sin duplicar, entidades
  HTML, footer, selección por relevancia, presupuestos, documento incompleto y cobertura.
- Agencia: falta página del equipo → selecciona link observado → recupera → añade personas respaldadas;
  enlaces inválidos/bloqueados, ciclos, ausencia de enlaces y budget agotado no producen más acciones.
- Grounding: cita inventada, vacía, segmento ajeno, negación recortada y valor sin relación no se aceptan.
  Probar validación literal y revisión semántica por separado; la inyección se evalúa también con LLM.
- Semántica: staff/exmiembro/rival, copyright, «no usamos ChatGPT», blog sobre políticas de clientes,
  política parcial, metadata contradictoria, conteo 25 con tres perfiles, duplicados y homónimos.
- Mapping: todos los destinos de la sección 4, aceptación parcial de objetos, invariantes, arrays
  desconocidos y traducción canónica; contrato final y procedencia por persona.
- Cliente: JSON mal formado, reparación única, timeout, 429, respuesta truncada/vacía, error en revisión,
  cuota de llamadas/tokens, cola cancelada y ausencia de reintentos ocultos del SDK.
- Integración: trazas ante error/cancelación, dos dominios simultáneos sin contaminación, fingerprint
  distinto/histórico sin fingerprint → cache miss; raw antiguo no evita revisión nueva.
- Ciclo de vida: no recuperar scan activo antes del umbral; cancelación global; drain; reserva de
  persistencia y cero inicio de directorios tras deadline, usando relojes/transporte controlados.
- Configuración: mock arranca sin claves, valores vacíos usan defaults, live exige key NIM, migración
  de provider antiguo explícita y smoke de contenedor actualizado.
- Demo: cero transporte Apify, replay sin red y HTML hostil se muestra como texto sin ejecución.

Ejecutar `npm run build`, `npm test`, `npm run test:container` y el evaluador nuevo. La suite actual
de 142 pruebas es baseline histórico, no un número fijo esperado tras agregar cobertura.
Guardar informe reproducible de sonda y evaluación en output, y resumen saneado/versionado de métricas
en docs. No activar el reemplazo si una herramienta necesaria para un gate no pudo ejecutarse.

## 13. Trazabilidad de la revisión

| Hallazgo original | Resolución en esta revisión |
| --- | --- |
| R01: citas sin soporte | Sección 5: revisión semántica, invariantes y aceptación separadas |
| R02: negativos contradictorios | Secciones 4–5: observed/unknown, negativos explícitos y alcance completo |
| R03: conteos | Sección 4: muestras, totales y completitud separados |
| R04: mapping/taxonomía | Sección 4: tabla de destinos y áreas canónicas |
| R05: deadlines | Sección 6: presupuesto completo y ciclo de vida |
| R06: falta agencia | Secciones 2–3: ronda dirigida, herramientas y footer |
| R07: auditoría | Sección 8: outcome y trazas incrementales por ejecución |
| R08: caché/estados | Secciones 8–9: estados y fingerprint; desactivar raw-cache NIM |
| R09: modelo/capacidades | Secciones 1 y 7: ID corregido, sonda y límites explícitos |
| R10: mock/smoke | Secciones 9 y 12: construcción live y migración probada |
| R11: corpus | Sección 3: relevancia, tokens, IDs y localizadores |
| R12: evaluación insuficiente | Sección 12: benchmark etiquetado, gates y pruebas de integración |
| R13: ruta OpenAI antigua | Sección 9: retirada del runtime; futuros clientes usan revisión común |
| R14: HTML/Apify | Sección 10: escape y aislamiento probado del transporte |
| R15: EC2/estado | Secciones 1 y 9: diseño local, sin interrupción del servicio |

Cerrar un hallazgo en el diseño no cierra su prueba de implementación. Registrar el resultado de cada
gate al implementar y conservar [la revisión original](DN-05-review.md) como antecedente.
