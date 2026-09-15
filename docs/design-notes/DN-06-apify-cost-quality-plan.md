# DN-06 — Plan de precisión y costo de adquisición con Apify

Fecha: 14 de septiembre de 2026. Estado: implementación y primer E2E terminados; canario posterior a las correcciones y benchmark ampliado pendientes.

## 1. Decisión recomendada

Mantener GPT-5.6 Luna como extractor mientras se corrige la adquisición de directorios: identidad verificable, consultas dirigidas, recuperación de resultados y presupuesto monetario. Medir costo por identidad correcta y por campo útil, además de costo por scan. Cambiar de modelo o elegir otro actor solo por su precio publicado no resuelve los fallos observados.

El flujo actual es: sitio → extracción y revisión → identidad → Bar y Avvo en paralelo → reconciliación → scoring. Luna no decide las llamadas Apify: `buildDirectoryInputs` las construye de forma determinista.

## 2. Evidencia disponible y límites del diagnóstico

Se revisaron código, DN-01 a DN-05, pruebas, resultados locales y documentación pública. No se iniciaron ejecuciones pagadas ni se consultó la facturación de la cuenta. Las corridas guardadas son evidencia histórica, no una reproducción de la versión actual: existe un script posterior de diagnóstico de entradas Bar y el código ya usa primer nombre completo.

| Evidencia local | Observación | Interpretación válida |
| --- | --- | --- |
| `output/integrated/duqueimmigration.com-2026-09-14T22-25-53-960Z/raw-bar.json` | Run `LERZej6eYZy2VseHa`, SUCCEEDED, mensaje No lawyers matched, costo reportado 0 | La consulta no obtuvo candidatos; no prueba inexistencia de licencia ni fallo específico de nombres en el código actual |
| `output/integrated/duqueimmigration.com-2026-09-14T22-25-53-960Z/raw-avvo.json` | Run `6XkjtVZRbrHzbN8a9`, TIMED-OUT, costo reportado USD 0,89775, cero aceptados | Hay gasto registrado sin evidencia aprovechada. El cliente no lee datasets de runs fallidos: no sabemos si Apify había producido filas |
| Resultado integrado de Duque, misma carpeta | Website 139,335 s; Avvo 55,610 s; total 194,961 s | La prueba tenía 45 minutos globales, pero seguía vigente el timeout de 55 s de cada actor |
| `output/integrated/gallardolawyers.com-2026-09-14T22-22-54-741Z/result.json` | Falla website; ambos directorios skipped | Ese fallo nace antes de Apify; no atribuirle costo ni ausencia de perfiles |
| `output/compare/duqueimmigration.com-2026-09-14T22-28-33-523Z/consistency.json` | Ciudad null/null/Miami; dirección con Doral en dos variantes | La consulta Avvo puede cambiar entre corridas. No establecer la ciudad correcta sin revisar la evidencia de dirección |
| Summary de la misma comparación | Tres extracciones Luna: 85,479–111,528 s | Con esa configuración, la extracción sola supera el presupuesto global predeterminado. No es una medición del servidor desplegado |
| `output/compare/gallardolawyers.com-2026-09-14T22-22-53-589Z/summary.json` | Roster de 25/24/25 abogados | El costo potencial varía con la extracción; validar completitud y pertenencia antes de gastar |

No hay muestra suficiente para estimar gasto mensual, ahorro porcentual ni tasa real de falsos positivos. Tampoco se confirmó aquí el esquema completo de entrada/salida vigente de Avvo: la página de input no pudo recuperarse. Debe verificarse antes de cambiar sus parámetros.

## 3. Hallazgos de implementación

### P0 — Integridad del resultado y visibilidad del gasto

- `apify-client.ts` lanza error antes de leer el dataset si el run no terminó SUCCEEDED. Un timeout puede dejar evidencia ya pagada sin aprovechar. Leerla como parcial requiere validar cada fila y conservar cobertura desconocida.
- `in-process-pipeline.ts` usa 55 s globales, con cancelación de fuentes a los 50 s por defecto. `server.ts` no amplía ese presupuesto. La web termina antes de iniciar directorios. Además, `apify-client.ts` impone 55 s por actor.
- La carrera de cancelación de `bounded()` puede devolver un resultado genérico antes de que el adaptador entregue raw, runId y costo; ese trabajo debe persistirse independientemente del resultado del scan.
- `directories.ts` suma costos desconocidos como cero. Si una fila lanza una excepción de esquema, la metadata del run puede perderse porque se agrega después del parsing. Registrar ejecución y raw antes de interpretar filas; informar costo conocido y completitud contable por separado.
- Las corridas no fijan un build del actor ni pasan límite monetario. `BUDGET_EXCEEDED` existe como tipo, pero no como política efectiva.

### P1 — Relevancia de consultas y matching

- `directories.ts` divide el nombre en primer y último token para Bar: pierde apellidos compuestos. Ya usa primer nombre completo; no repetir como solución una corrección existente.
- Bar no recibe contexto de firma/localización en las consultas nominales. Avvo depende de una sola ciudad extraída y asume Florida.
- `DirectoryQuery` transporta menos información que `FirmIdentity`: no aprovecha teléfono, dirección, county y alias disponibles para planificar/reconciliar.
- `packages/scoring/src/matching.ts` privilegia Miami/Miami-Dade para desambiguar. Un nombre exacto único se acepta sin soporte adicional; un homónimo fuera de la firma puede pasar. Reemplazar el sesgo fijo por contexto observado y tratar contradicciones como ambiguas.
- Fallback por firma exige igualdad normalizada; no usa alias de firma y puede perder personas legítimas. Relajar sin corroboración introduciría falsos positivos.

### P1 — Costo y repetición

- Se planea un run por abogado por fuente: N abogados → hasta 2N runs iniciales si hay tiempo. Para 25 abogados, hasta 50. No equivale a 50 cargos fijos: depende del modelo de cobro y resultados.
- Cada consulta activa detalles y máximos técnicos de 1.000.000 en Bar y 100.000 en Avvo. Son techos, no volúmenes observados; dejan poca contención ante consultas amplias.
- Ya hay caché de scans de 24 horas por dominio, reutilización de extracción web por hash y deduplicación simultánea por dominio dentro del proceso. Falta caché por consulta/identidad y coordinación entre procesos.
- Un PARTIAL puede reutilizarse desde caché sin reparar la fuente fallida. Hay que conservar evidencia buena y refrescar solo faltantes, sin extender la vigencia original de lo reutilizado.
- DN-04 aún describe límites de dos identidades y siete registros que no están en el código actual. DN-02 y tests actuales exigen roster completo: no reintroducir muestreo silencioso para ahorrar.

## 4. Horizontes de resolución

Plazos orientativos para una persona; comienzan al implementar y dependen del acceso a ejecuciones y fixtures.

### H0 — Diagnóstico reproducible y contención: 1–2 días

1. Recuperar de los dos run IDs históricos input exacto, build, estado, logs, dataset y desglose de cargos. No lanzar nuevos runs para recuperar resultados existentes. Comparar la consulta Bar histórica con el código corregido.
2. Crear fixtures sanitizadas y etiquetadas por etapa: identidad, búsqueda, transporte, esquema, matching y campos finales. Separar no-match de timeout, bloqueo, input inválido, contrato incompatible y truncamiento.
3. Instrumentar un registro durable por run: scan, identidad, input normalizado, actor/build, datasetId, estado, timestamps, intento, costo reportado, costo reconciliado y razones de descarte por fila. Registrar antes del parser y sobrevivir a cancelaciones.
4. Añadir presupuesto por run, scan y día, con reserva atómica antes de iniciar trabajo concurrente y liquidación posterior. Los importes se calibran con la línea base; un costo desconocido no libera una reserva como si fuera cero.
5. Aplicar límites de costo compatibles con el actor y cortar nuevas ejecuciones al agotar presupuesto; devolver PARTIAL/UNKNOWN con pendientes explícitos.

**Salida:** todo run iniciado queda trazable; los dos fallos históricos tienen causa o incertidumbre identificada; ninguna búsqueda amplia se inicia sin presupuesto. Sin prometer un importe universal antes de reconciliar cargos.

### H1 — Recuperar evidencia y mejorar consultas: 3–5 días

1. Persistir trabajos de directorio y separarlos del plazo de la petición/worker actual. El HTTP ya devuelve 202 y permite polling: conservar ese contrato; falta ejecución recuperable, no introducir polling de nuevo.
2. Ajustar timeout por actor usando duración real y costo marginal. Consultar estado del mismo run tras fallos de red; nunca repetir un POST a ciegas. Si el inicio quedó incierto, reconciliar antes de crear otra ejecución.
3. Recuperar datasets de runs incompletos con validación por fila. Un registro malformado no debe borrar los válidos. Conservar estado parcial y no afirmar cobertura completa.
4. Establecer una identidad canónica con evidencia: nombre y variantes observadas, firma/alias, dirección, ciudad, teléfono, jurisdicción y número Bar cuando exista. No inventar identificadores ni variantes para expandir consultas.
5. Planificador determinista: reutilización → identificador/perfil conocido cuando el actor lo soporte → nombre con contexto verificado → fallback acotado con nueva evidencia. Si falta ciudad, evitar expansión nacional automática no presupuestada.
6. Desambiguar por número Bar o múltiples señales coherentes. Nombre exacto sirve como candidato; una contradicción de firma/localización requiere resolución. Cambiar reglas y pruebas de scoring explícitamente, preservando desconocidos.
7. Normalizar apellidos compuestos y localizaciones desde evidencia. Validar serialización real de cada actor con pruebas de contrato; fijar build verificado.

**Salida:** Duque se resuelve o queda desconocido con causa comprobable; pruebas de homónimos no aceptan una persona equivocada; las filas parciales y costos no desaparecen.

### H2 — Reducir trabajo repetido: 1–2 semanas

1. Caché por actor/build + versión del adaptador + consulta canónica, y caché de perfil por identificador. Separar vigencia de identidad, contacto, rating y estado profesional; no conservar indefinidamente datos sensibles al tiempo. TTL iniciales se definen con requisitos de frescura.
2. Deduplicación durable por consulta en curso. Reanudar el roster pendiente; no volver a consultar abogados resueltos al repetir un scan parcial.
3. Evaluar discovery sin detalles seguido de detalle solo para candidatos corroborados. Adoptarlo únicamente si soporta consultas dirigidas y cuesta menos en conjunto: dos fases también pueden duplicar cargos.
4. Evaluar lotes compatibles con el contrato. Bar comparte `firstName` entre apellidos, por lo que agrupar nombres arbitrarios puede cambiar la consulta. Exigir atribución de cada resultado a su búsqueda y recuperación por elemento.
5. Coordinar Bar → Avvo cuando los identificadores/contexto de Bar reduzcan ambigüedad. Mantener paralelismo cuando no existe dependencia útil; medir latencia y precisión antes de generalizar.
6. Agotar paginación de lo ya generado. Un límite de gasto puede dejar adquisición pendiente, pero nunca convertir una muestra en el roster completo ni desconocidos en negativos.

**Salida:** una consulta equivalente vigente no crea un segundo run; reparar PARTIAL solo consume lo necesario para los faltantes; reportar cobertura sobre todo el roster.

### H3 — Decidir proveedores: 2–4 semanas

Comparar con el mismo conjunto etiquetado: actor actual corregido, un actor alternativo por fuente y acceso directo a perfiles oficiales donde resulte viable. Evaluar costo total: datos útiles, operación, bloqueos, cambios de esquema y mantenimiento. Un crawler propio se justifica solo si mejora ese costo a volumen real y conserva calidad.

Luna puede ayudar a extraer alias y clasificar evidencia. El backend conserva autoridad sobre presupuesto y aceptación. Escalar a otro modelo solo casos ambiguos identificados por evaluaciones; ninguna explicación del modelo sustituye evidencia del perfil.

**Salida:** mantener, sustituir o usar respaldo por fuente según benchmark; no hacer sustitución global por tarifa anunciada.

## 5. Métricas y puertas de aceptación

- Costo por identidad correcta única = gasto reconciliado total / identidades verificadas únicas. Si no hay aciertos, informar gasto y cero aciertos, no costo unitario cero.
- Precisión = identidades correctas aceptadas / identidades aceptadas. Medir separado de cobertura = identidades resueltas / identidades verificables esperadas.
- Campos útiles = campos correctos requeridos por scoring, con procedencia, fecha y alcance. No premiar volumen de filas irrelevantes.
- Costos por fuente, runs duplicados, timeouts, fallos de contrato, cache hits, p50/p95 de duración y costo, y costo aún desconocido.
- Dataset inicial propuesto: al menos 30 identidades de 10 firmas, incluyendo Duque, Gallardo, homónimos, apellidos compuestos, multiubicación, perfiles ausentes y respuestas parciales. Separar casos de desarrollo de un conjunto reservado.
- Gate inicial: cero falsas identidades aceptadas en el conjunto reservado; campos erróneos identificados no pasan al scoring; cobertura no inferior a la línea base sobre los mismos casos. Cero errores en una muestra pequeña no garantiza precisión universal.
- Gate operativo: una ejecución concurrente por fingerprint; recuperación tras reinicio; filas inválidas aisladas; cancelación conserva evidencia; presupuestos respetados; faltantes y truncamiento explícitos.
- Ahorro objetivo a validar: 30% menos costo por identidad correcta frente a línea base comparable. Es una meta experimental, no una proyección. Reportar por separado caché fría y caliente y no excluir runs fallidos del numerador.

## 6. Orden de cambios y validación

1. PR de ledger/diagnóstico/presupuesto: `apify-client.ts`, contratos de estado y persistencia de runs.
2. PR de recuperación: pipeline, worker durable, cancelación y datasets parciales.
3. PR de identidad y planner: `firm-identity.ts`, `directories.ts`, `packages/scoring/src/matching.ts` y contratos de consulta.
4. PR de caché/reanudación y reparación parcial: repositorios y orquestación HTTP.
5. Benchmark pagado acotado después de fixtures, con presupuesto explícito por campaña, y decisión de proveedor.

En cada PR: fixtures offline, tests de regresión, validación de tipos y un canario limitado cuando cambie el contrato externo. La revisión presente ejecutó 23/23 pruebas de `sources.test.ts` con Vitest local; no validan disponibilidad ni precisión real de Apify. El lanzador npm local falló por ruta ausente y se ejecutó Vitest directamente con Node.

Actualizar DN-04 para retirar límites obsoletos y documentar cualquier cambio deliberado a DN-02. Preservar las decisiones de no muestrear el roster y no transformar falta de información en hechos.

## 7. Fuentes externas consultadas

- [OpenAI: GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): referencia del modelo utilizado; no se propone migración.
- [Florida Bar: input del actor](https://apify.com/scrapers_lat/florida-bar-lawyers-scraper/input-schema): admite filtros de firma, ubicación y números Bar; `withDetails` amplía el contenido. Usar identificadores cuando están respaldados.
- [Avvo: descripción del actor](https://apify.com/scrapers_lat/avvo-lawyers-scraper): documenta búsqueda nominal y geográfica; sin ciudad puede ampliar a todo el país. La tarifa pública por resultado no explica por sí sola el cargo histórico registrado: reconciliar dataset y facturación.
- [Apify: iniciar Actor](https://docs.apify.com/api/v2/actors-runs-post): `maxTotalChargeUsd` limita costo; `maxItems` limita cobro por resultados para actores pay-per-result y no garantiza truncar la salida. `build` permite fijar la versión ejecutada. Validar límites y mínimos del actor antes de lanzar el canario.

## 8. Implementación del 14 de septiembre

Implementado sin llamadas a OpenAI ni Apify:

- Ledger PostgreSQL `apify_runs` y relación `scan_apify_runs`, con RLS y acceso exclusivo de `service_role`.
- Reserva atómica por fingerprint de actor, build e input; presupuesto por run, scan y día. Un costo desconocido conserva la reserva completa.
- `maxTotalChargeUsd` en el inicio del actor. Los límites y TTL son configuración validada; por defecto: USD 1/run, USD 10/scan y USD 100/día.
- Separación correcta entre `waitForFinish=60` y `timeout=300`. El cliente anterior establecía por error `timeout=55` como duración máxima remota.
- Conservación del run remoto al vencer el caller. Una consulta equivalente recupera el mismo `runId`; un inicio de resultado incierto queda bloqueado hasta expirar en lugar de repetir el POST.
- Lectura y validación de datasets de runs terminales no exitosos. Si contienen filas, se publican como evidencia parcial; cada fila inválida se aísla.
- Caché por consulta. Un hit no vuelve a atribuir el costo histórico al scan nuevo. Se informa costo desconocido, hits, reanudaciones y costo por abogado aceptado.
- Los datasets de hasta 1.000 filas se conservan en el ledger; para datasets mayores se conserva `datasetId` y se vuelve a leer el mismo dataset sin iniciar otro actor.
- Los scans parciales ya no se devuelven inmediatamente desde la caché de dominio: se ejecuta una reparación que reutiliza análisis web y consultas de directorio vigentes.
- Contexto completo de identidad en las consultas internas y matching: alias, county, dirección y teléfono. Se retiró la preferencia fija por Miami, se rechazan contradicciones de identidad y se preservan partículas reconocidas en apellidos.
- Límites configurables de 25 resultados Bar y 10 Avvo para búsquedas nominales. Alcanzarlos marca `TRUNCATED`; el fallback de firma mantiene el máximo técnico y no muestrea el roster.
- El pipeline asíncrono dispone de 10 minutos por defecto y la recuperación de scans interrumpidos respeta ese plazo más dos minutos de gracia.

Pendiente, por requerir red, credenciales, evidencia nueva o una decisión basada en el benchmark:

1. Recuperar en Apify los dos run IDs históricos y reconciliar su factura.
2. Fijar `APIFY_ACTOR_BUILD` a un número validado; `latest` se mantiene hasta el canario para no inventar un build.
3. Calibrar presupuestos, TTL y límites nominales con costo y cobertura reales.
4. Evaluar discovery sin detalles, lotes, secuenciación Bar → Avvo y actores alternativos. No se implementaron a ciegas porque pueden aumentar costo o cambiar cobertura.
5. Ejecutar el conjunto reservado y decidir proveedor con la puerta de precisión/costo de la sección 5.

## 9. Resultado del primer E2E y corrección de identidad

El 15 de septiembre de 2026 se ejecutó desde cero un E2E real sobre Duque Immigration y Gallardo Law Firm. Duque falló durante la extracción de identidad, antes de consultar directorios. Gallardo recuperó correctamente los 25 integrantes del sitio, pero el reconciliador inicial solo aceptó 3 perfiles de Florida Bar y 5 de Avvo. Ese resultado constituye la línea base real previa a las correcciones descritas a continuación.

El caso de Briana Mauri hizo visible el defecto principal. Ambos directorios devolvieron a `Briana Nicole Mauri`, con la misma dirección y el mismo año de admisión, pero el sitio publicaba el nombre abreviado `Briana Mauri`. El candidato era razonable por nombre y estaba corroborado entre fuentes; aun así, cada fuente se descartaba de forma aislada por no coincidir con el contexto de oficina esperado.

Se implementaron estas correcciones:

- Conservar como candidatos los nombres compatibles aunque una fuente aislada todavía no tenga contexto suficiente para aceptarlos.
- Reconciliar Bar y Avvo entre sí mediante nombre completo normalizado y una segunda señal compartida: dirección, teléfono o año de admisión.
- Hacer la reconciliación en tres pasos: Avvo provisional contra Bar crudo, Bar contra Avvo provisional y Avvo final contra Bar reconciliado.
- Usar `mailStreet` de Florida Bar como calle estructurada en lugar de anteponer nombre y firma mediante `mailAddress`.
- Normalizar nombres repetidos, segundos nombres, iniciales, sufijos y apellidos compuestos sin convertir una coincidencia nominal aislada en evidencia suficiente.
- Convertir valores de relleno como `Not Available`, `unknown`, `n/a` y `none` a ausencia de dato.
- Exigir al menos dos señales para coincidencias nominales flexibles. Se mantiene la excepción de una consulta explícita por inicial, que puede desambiguarse con ciudad.
- Reconocer como relacionadas variantes de firma como `Gallardo Law Office` y `Gallardo Law Firm`, y no usar como firma corroborante un campo que solo repite el nombre del abogado.

La repetición offline sobre exactamente los mismos artefactos crudos, sin nuevas llamadas a OpenAI ni Apify, produjo este cambio:

| Métrica | E2E original | Repetición offline corregida |
| --- | ---: | ---: |
| Bar aceptados antes de reconciliar fuentes | 3/25 | 14/25 |
| Avvo aceptados antes de reconciliar fuentes | 5/25 | 13/25 |
| Bar después de corroboración cruzada | 3/25 | 21/25 |
| Avvo después de corroboración cruzada | 5/25 | 21/25 |
| Briana Mauri | descartada | aceptada en ambas fuentes como `Briana Nicole Mauri` (`cross_ref`) |
| Costo adicional de la repetición | — | USD 0; solo procesamiento local |

Los cuatro nombres que siguen sin match seguro son Christopher Rivera, Lorena Gaona Krewson, Mariangeli Mercado y Nelson Vladimir Jaramillo. La corrección los conserva como desconocidos porque los artefactos disponibles no contienen una corroboración cruzada suficiente. Falta un canario real, limitado por presupuesto, para comprobar que el resultado se mantiene con respuestas actuales de los actores y medir el costo posterior a la corrección.
