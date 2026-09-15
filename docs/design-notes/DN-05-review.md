# Revisión adversarial de DN-05

Fecha: 12 de septiembre de 2026. Dictamen: **no implementar DN-05 tal como está escrito**.

**Nota posterior:** este dictamen corresponde a la versión inicial de 192 líneas. La
[revisión 2 de DN-05](DN-05-agentic-signal-extraction.md) incorpora las correcciones de diseño y una
tabla de trazabilidad R01–R15. Se conserva este informe como antecedente; sus referencias de línea
son históricas. La implementación y los gates de evaluación siguen pendientes.

La separación entre extracción y scoring, las citas por señal y la demo sin directorios pagados son buenas decisiones. El bloqueo principal es la garantía de evidencia: el verificador descrito comprueba presencia textual, pero permite que una interpretación incorrecta llegue al scoring como `verified`. Además, el flujo no contiene decisiones de adquisición tomadas por el agente.

Esta revisión corresponde al DN-05 de 192 líneas presente en el workspace. No modifica ese documento ni implementa el proveedor. P1 significa corregir antes de sustituir el extractor; P2 significa cerrar antes de aprobar el entregable o su integración.

## Hallazgos

### R01 — P1: una cita auténtica puede acreditar una señal falsa

**DN-05:124–127.** El verificador acepta enums con cualquier cita válida y comprueba nombres, años y herramientas por aparición textual. No verifica la relación entre la firma, la afirmación y su contexto.

Contraejemplos que cumplen esas comprobaciones:

| Texto del sitio | Extracción incorrecta que no queda excluida |
| --- | --- |
| «Asesoramos a clientes sobre políticas de IA.» | `ai_policy.depth = comprehensive` |
| «No usamos ChatGPT.» | Uso de IA positivo y herramienta `ChatGPT` |
| «Jane Doe — Office Manager» | Jane Doe con `role = attorney` |
| «© 2026 Smith Law» | Fundación en 2026 |
| «Representamos a un cliente contra Competitor Law.» | `firm_name = Competitor Law` |

Esto tiene efectos reales: `categories.ts:9` asigna 15 puntos a `comprehensive` sin reinterpretar la cita; `firm-identity.ts:9` declara `VERIFIED` por tener nombre de firma y personas. Dejar esos consumidores deterministas es correcto; exige resolver la atribución antes de entregarles datos.

**Corrección:** separar `citation_valid` de `claim_supported`. Por afirmación, exigir evidencia del sujeto, relación, negación, cargo/afiliación actual y alcance. Los juicios semánticos necesitan criterios explícitos y evaluación; una segunda pasada del LLM puede ayudar, pero tampoco constituye una prueba determinista. Si no se puede justificar el valor, conservar `unknown`. No presentar la mera presencia de una cita como garantía de verdad.

### R02 — P1: la política de negativos es contradictoria y puede bloquear la evaluación

**DN-05:96–99,128–129.** Se admite `false` sobre datos de clientes con una cita de privacidad, aunque un fragmento no prueba que el resto de la política no los mencione. Al mismo tiempo se rechazan todos los demás negativos, incluso una declaración explícita como «Nuestro despacho no utiliza IA».

El resultado puede ser tanto un falso negativo en privacidad como incertidumbre artificial en W2/W3/W4. El scoring exige reglas conocidas para permitir una decisión automática (`score.ts`, cálculo de `assessmentStatus`). No debe aumentarse cobertura convirtiendo silencios en negativos, pero tampoco descartarse una negación explícita y atribuida.

**Corrección:** representar `observed`/`unknown` y un valor que pueda ser `false` o `0`, o definir invariantes equivalentes. Diferenciar negación explícita, ausencia comprobada en un ámbito completo y falta de evidencia. «No menciona datos de clientes» requiere revisar la política completa y su cobertura, no una cita seleccionada. Un crawl de 20 páginas no establece ausencia en todo el sitio.

### R03 — P1: el límite de `attorney_count` está invertido para una lista parcial

**DN-05:125–126.** Si una página dice «Contamos con 25 abogados» y el corpus incluye tres biografías, `count <= abogados verificados` rechaza un total explícito válido. En cambio, `count = 1` puede pasar el límite cuando ya se han verificado tres abogados distintos. La desigualdad tampoco demuestra que el listado sea completo.

**Corrección:** separar personas únicas observadas, total declarado y completitud del equipo. Una lista parcial ofrece un mínimo, no un máximo. Mapear a `team_size` únicamente un total sustentado, nunca el tamaño de la muestra. Deducir el total del listado exige una prueba de completitud. Resolver duplicados, exmiembros, sedes y contradicciones antes del conteo. Extender el mismo criterio a oficinas y publicaciones.

### R04 — P1: falta un contrato semántico completo para mapear sin cambiar Layer 1

**DN-05:70–84,136–138.** `.strict()` impide claves extra; no establece coherencia entre `status`, `value` y citas. Tampoco están definidos todos los tipos y enums, la nulabilidad de subcampos ni qué sucede al rechazar solo una parte de una señal compuesta.

Ejemplo: existe política de privacidad, pero no se sabe si habla de clientes. El contenedor debe preservar el positivo de existencia sin inventar el otro booleano. El contrato actual exige además `ai_in_services.integration_depth`, `tools_mentioned` y los `text_excerpt`; el plan usa `tools` y no especifica todos esos destinos.

Hay una regresión especialmente concreta: `practice_areas` queda como lista libre. `normalizeAreas` solo reconoce los aliases existentes, principalmente ingleses. Ejecuté `jaccard(['Derecho de inmigracion'], ['Immigration'])`: devuelve **0**. Dos áreas equivalentes podrían producir una penalización de W9_A2 por diferencia de idioma.

**Corrección:** tabla exhaustiva origen → destino, enums compartidos, validación de rangos y consistencia entre subcampos, señales atómicas o citas por subcampo, y procedencia por elemento. Emitir áreas canónicas compatibles con `PRACTICE_AREAS`, conservando la cita original en español. Inicializar desde `unknownWebsite()` y validar el resultado con `WebsiteData.parse`; esto resuelve la forma, no sustituye la validación semántica.

### R05 — P1: el presupuesto de tiempo no permite el workflow propuesto

**DN-05:108–112.** El cliente NIM permite 60 segundos y una reparación adicional. `InProcessPipeline` aborta el trabajo externo a los **50 segundos** dentro de un presupuesto total de 55 (`in-process-pipeline.ts:20–21`). El crawler dispone de hasta 20 segundos (`crawler.ts:56`). Apify empieza después de la extracción.

Con un crawl de 20 segundos y un LLM de 30 segundos, el pipeline puede agotar todo el tiempo de fuentes antes de consultar directorios. Una CLI que termina correctamente en 80 segundos no valida esta integración. Aumentar solo el timeout del pipeline también debe coordinarse con recuperación de scans y apagado del servidor.

**Corrección:** presupuesto global compartido, límites por fase y reserva explícita para directorios y persistencia. Reparar únicamente si queda tiempo. Medir p50/p95 con corpus representativos antes de fijar límites. Si la extracción necesita más tiempo, revisar también los umbrales de recuperación en `server.ts:21,46` y el ciclo de vida del trabajo. Probar cancelación durante inferencia y reparación, sin invocar directorios después del deadline.

### R06 — P1: falta el ciclo agéntico que resolvería evidencia faltante

**DN-05:24–33,139–141.** El diseño es una secuencia fija: un crawl, una extracción y un validador. El único bucle repara JSON; no decide qué investigar ni recupera evidencia faltante. Usar un LLM en esa secuencia es válido, pero no cubre el objetivo de un agente que adapte la búsqueda.

El crawler conserva límites de 20 páginas, profundidad 2 y 20 segundos. Además elimina `footer` y `nav` antes de obtener `text` (`crawler.ts:136`); el corpus solo recuperaría del HTML los metadatos y JSON-LD previstos. Un teléfono o dirección presentes únicamente en el footer podrían desaparecer del input del LLM.

**Corrección:** definir un ciclo acotado: extracción inicial → identificar vacíos/conflictos → seleccionar páginas pertinentes → recuperarlas → reextraer campos afectados → detenerse por suficiencia o presupuesto. Exponer herramientas de lectura controladas; el agente propone la adquisición y el backend aplica dominio permitido, robots, seguridad de red, deduplicación y presupuesto. Preservar contacto del footer como evidencia etiquetada. Si se prefiere una primera fase sin agente, declararla como extracción LLM y delimitar lo que resuelve.

### R07 — P1: la interfaz no permite la auditoría prometida

**DN-05:113–114,145.** `extract()` devuelve exclusivamente `WebsiteData`; `WebsiteExtractionSource` llama a ese método (`website-source.ts:36`). Por ese camino no recibe `extraction`, `grounding`, corpus ni respuestas, aunque luego se le exige persistirlos.

El `catch` actual conserva páginas y `analysis: null`, pero no las respuestas inválidas, intentos ni motivos de rechazo del proveedor. También falta especificar qué evidencia diagnóstica se retiene cuando el trabajo termina por timeout.

**Corrección:** retorno interno explícito `{ data, diagnostics }` o un mecanismo de trazas por ejecución, integrado también en errores y caché. Conservar corpus/hash y versiones, parámetros, respuestas de cada intento, errores y decisiones. No usar un campo mutable `lastExtraction` del proveedor: el servidor comparte la instancia entre solicitudes y podría mezclar dominios. Los secretos quedan fuera de las trazas.

### R08 — P1: caché y estados pueden ocultar la nueva validación

**DN-05:115–116,145.** La clave propuesta contiene modelo y prompt, pero omite versiones del corpus, contrato, verificador y mapper. Cambiar una regla de rechazo podría reutilizar un análisis que la versión nueva ya no aceptaría. Además, la caché HTTP de 24 horas (`http/app.ts:51`) puede devolver el resultado anterior antes de ejecutar el proveedor, independientemente de su versión.

`WebsiteExtractionSource` también marca `ok/PRESENT` según `crawl.partial`, aunque se haya truncado el corpus o se hayan rechazado todas las señales (`website-source.ts:44–46`). El documento solo muestra la truncación en el reporte de la demo.

**Corrección:** fingerprint de toda la extracción y estrategia explícita para la caché del resultado completo. Preservar diagnósticos en cache hits, o volver a verificar evidencia histórica con el verificador vigente. Definir estados para cero evidencia aceptada, truncación, campos rechazados y fallos técnicos; no confundir una respuesta JSON válida con evidencia suficiente. Probar ambas capas de caché.

### R09 — P1: el modelo predeterminado no coincide con el identificador publicado

**DN-05:18,109.** El documento usa `nvidia/nemotron-nano-3-30b-a3b`. La [referencia oficial del endpoint](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer) publica **`nvidia/nemotron-3-nano-30b-a3b`**. Corregir el identificador antes de la sonda.

La misma referencia documenta streaming activado por defecto y un límite de salida configurable. El plan no fija `stream: false`, presupuesto de salida ni manejo de `finish_reason`. La [ficha de NVIDIA](https://build.nvidia.com/nvidia/nemotron-3-nano-30b-a3b/modelcard) muestra cómo desactivar thinking en implementaciones compatibles, pero eso no demuestra por sí solo el comportamiento del endpoint hospedado seleccionado.

**Corrección:** sonda reproducible con el SDK/endpoint exactos, esquema real y límites explícitos; comprobar contenido, `finish_reason`, tokens y salida truncada. Un HTTP 200 no basta para demostrar que un parámetro tuvo efecto. Registrar capacidades efectivas y comportamiento sin `response_format`; JSON mode no garantiza el esquema. No asumir que el límite efectivo del servicio coincide con el contexto del modelo.

### R10 — P1: cambiar el default rompe el arranque mock si se conserva el wiring actual

**DN-05:142–144.** `server.ts:22` construye el proveedor antes de comprobar `SOURCE_MODE=mock`. Con el nuevo default NIM y sin key, el constructor del SDK puede lanzar antes de seleccionar `mockSources`. Reproduje localmente el constructor sin credenciales: falla con `Missing credentials`.

Además, `scripts/container-smoke.mjs:30` sigue inyectando `WEBSITE_EVIDENCE_PROVIDER=rules`, valor que el nuevo enum rechazaría. Ese script no figura entre las actualizaciones y `npm test` no lo ejecuta.

**Corrección:** construir clientes externos solo en la rama live; actualizar el smoke de contenedor y probar arranque mock sin claves de proveedores. Normalizar `NVIDIA_NIM_MODEL` vacío a su default; `.env.example` lo define como cadena vacía. Mantener las pruebas funcionales del extractor como fixtures de regresión, aunque se retiren las pruebas de sus helpers.

### R11 — P2: el recorte del corpus descarta por alfabeto y no controla tokens

**DN-05:54–63.** `crawl.pages` se devuelve ordenado por URL (`crawler.ts:155`). Recortar desde el final puede conservar muchos posts bajo `/blog/` y descartar `/team/` o `/privacy/`, aunque el crawler haya priorizado esas páginas. Los IDs basados en índices son estables para el mismo snapshot ordenado; insertar una URL cambia los IDs posteriores.

400.000 caracteres no equivalen a un límite garantizado de tokens y no reservan espacio para esquema, prompt, salida ni reparación. JSON-LD compacto puede ser mucho mayor que los segmentos de texto; el helper actual conserva tanto el contenedor `@graph` como sus objetos, duplicando contenido.

**Corrección:** selección por finalidad de evidencia, deduplicación de boilerplate y JSON-LD, presupuesto total de tokens con margen y manifiesto de cobertura/omisiones. Definir si la estabilidad es por snapshot o entre crawls; usar identificadores derivados del documento y referencias a una versión/hash del corpus. Conservar offsets o rutas JSON para reconstruir citas. La normalización de grounding debe rechazar citas vacías y no ocultar cambios significativos.

### R12 — P1: las pruebas propuestas no demuestran que la extracción sea correcta

**DN-05:173–191.** Un cliente falso demuestra integración; una cita localizable demuestra presencia textual. Ninguno demuestra que el nombre pertenezca a la firma, que alguien sea abogado vigente o que una política sea interna. Un test de inyección sobre una función determinista tampoco mide si el LLM obedece el contenido malicioso.

Dos dominios no cubren los errores descritos. Los siete abogados devueltos antes por un directorio no constituyen automáticamente un listado exhaustivo y actual del sitio. Tampoco están aportados en DN-05 los raws de los escaneos iniciales. El código ya contiene correcciones para títulos SEO y prioridad española, con pruebas; esos fallos históricos no son una medición del baseline actual.

**Corrección:** dataset congelado con etiquetas humanas por campo, citas y casos esperados de abstención. Incluir español/inglés, equipos parciales, homónimos, staff, exmiembros, negaciones, blogs de terceros, metadata contradictoria, inyección y truncación. Comparar reglas actuales y NIM sobre el mismo corpus, separando fallos de adquisición y extracción. Medir precisión, recuperación, falsos `verified`, abstención, latencia, tokens y efecto sobre scoring. Definir umbrales antes de retirar reglas; pasar el conjunto finito no equivale a garantizar ausencia de errores futuros.

### R13 — P2: OpenAI conserva una ruta sin el nuevo verificador

**DN-05:142.** Se permite `WEBSITE_EVIDENCE_PROVIDER=openai`, pero el adaptador actual devuelve directamente `WebsiteData`, sin el contrato de señales ni el verificador nuevo (`website-evidence-provider.ts:40–46`). La promesa global «solo señales verificadas» no se cumpliría en esa configuración.

**Corrección:** hacer que ambos proveedores produzcan el mismo contrato de candidatos y pasen por la misma política de aceptación, o declarar explícitamente que la garantía corresponde solo a NIM y restringir la otra ruta donde esa garantía sea obligatoria. No reutilizar resultados entre rutas con niveles de validación distintos.

### R14 — P2: el reporte HTML convierte contenido no confiable en un nuevo punto de ejecución

**DN-05:163–169.** Citas, razonamientos y títulos contienen texto controlado por sitios o por el modelo. Interpolarlos directamente para resaltar citas permite que marcado como `<img ... onerror=...>` se interprete al abrir el reporte. «Autocontenido» no implica escape seguro.

**Corrección:** insertar texto como texto, escapar según contexto y crear los resaltados con nodos seguros. Validar protocolos de enlaces y, si se incrusta JSON, escapar cierres de `script`. Añadir una fixture de marcado hostil. Registrar `sent: false` expresa intención; la prueba de ausencia de llamadas pagadas debe verificar que ningún transporte a Apify se invocó. Importar una clase no ejecuta por sí mismo una consulta.

### R15 — P2: detener EC2 no es un requisito de validación local

**DN-05:42–44,192.** El propio documento reconoce que esa acción deja la API caída. Una revisión o demo local no la necesita. Incluirla como paso de aceptación mezcla disponibilidad del servicio con corrección del extractor y puede provocar una interrupción innecesaria al seguir el plan.

**Corrección:** separar cualquier decisión operativa previamente autorizada del trabajo técnico de DN-05. No usar el estado `stopped` como criterio de éxito del workflow. Cambiar «aprobado, en implementación» por el estado real de revisión antes de usar este documento como autorización de trabajo.

## Diseño mínimo que sí llevaría a implementación

1. **Contrato de evidencia:** afirmaciones por campo/subcampo, citas con identidad del documento, estados coherentes, totales separados de muestras y vocabulario canónico compatible con Layer 1.
2. **Adquisición dirigida:** crawl inicial con cobertura observable y recuperación adicional acotada por vacíos/conflictos. El agente opera herramientas de lectura; el backend controla el acceso y los presupuestos.
3. **Extracción y evaluación:** el LLM propone afirmaciones; la validación estructural, la comprobación de citas y la evaluación de soporte son pasos diferenciados. La incertidumbre y los conflictos sobreviven al mapeo.
4. **Integración auditable:** resultado interno con datos y diagnóstico, aislamiento por ejecución, cachés versionadas y deadlines compatibles con el pipeline completo.
5. **Demo y evaluación:** la misma ruta de extracción usada por producción, directorios simulados, reporte seguro y evaluación offline del impacto en Layer 1. La implementación del scoring puede permanecer intacta aunque sus resultados deban probarse.
6. **Sustitución:** activar el nuevo proveedor y retirar reglas después de cumplir los criterios acordados. Conservar fixtures y resultados del baseline para detectar regresiones.

## Condiciones de aprobación

| Área | Evidencia exigida |
| --- | --- |
| Soporte semántico | Los contraejemplos R01–R03 no llegan como afirmaciones aceptadas a `WebsiteData`; los positivos reales se conservan. |
| Contrato | Tabla completa de mapeo, nulabilidad y rubricas de calidad; áreas españolas e inglesas equivalentes producen el mismo valor canónico. |
| Agencia | Fixture donde falta una página: el workflow la solicita dentro del presupuesto, o declara el límite que impide obtenerla. |
| Rendimiento | Latencias y tokens medidos con un corpus representativo; cancelación y reserva de tiempo para las fases restantes. |
| Integración | Arranque mock sin claves; smoke actualizado; persistencia de trazas y cache hits con la política vigente. |
| Evaluación | Baseline congelado y comparación campo por campo con umbrales explícitos; pruebas de scoring con directorios simulados. |
| Demo | Reporte con texto escapado y prueba de cero invocaciones al transporte de Apify. |

## Verificación realizada durante esta revisión

- `npm run build`: correcto.
- `npm test`: **142 pruebas aprobadas en 16 archivos**. Son pruebas del código actual; todavía no existe la implementación de DN-05.
- Ejecución local de funciones existentes: áreas equivalentes en español/inglés producen Jaccard 0; `comprehensive` recibe W1 = 15; nombre de firma y una persona bastan para `FirmIdentity.status = VERIFIED`; construir el SDK sin credenciales falla.
- Los ejemplos anteriores demuestran cómo reaccionan los consumidores actuales. Los bypasses del grounding son contraejemplos del algoritmo escrito en el plan, no pruebas ejecutadas contra un verificador que ya exista.
- Referencia pública de NVIDIA consultada para verificar el identificador y los parámetros publicados. No se ejecutó la sonda autenticada de NIM ni se midió su latencia/calidad real.
- No se detuvo EC2, no se ejecutaron directorios pagados y no se cambiaron archivos de implementación. Los resultados históricos de Gallardo y Duque siguen pendientes de contrastar con sus snapshots.
