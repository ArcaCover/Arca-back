# DN-01 — Reconstrucción de capa 1: evidencia, identidad e incertidumbre

Referencia principal: **Arca - Capa 1 - Jesús.html**, 4 de septiembre de 2026.
Decisiones confirmadas por el usuario en esta conversación, 5 de septiembre de 2026.
Esta es la única nota activa de contradicciones, ambigüedades, cambios y resolución de la reconstrucción.
Los documentos de `private` permanecen intactos como contexto histórico.

> Las decisiones de contrato HTTP, Avvo y scoring actualizadas el 9 de septiembre de 2026
> están en [DN-02](DN-02-2026-09-09-contract-avvo-scoring.md) y prevalecen sobre esta nota.
> La separación entre Layer 1 y extracción, decidida el 12 de septiembre de 2026, está en
> [DN-03](DN-03-provider-agnostic-layer1.md) y reemplaza la decisión anterior de usar GPT como extractor predeterminado.

## Principio rector

La falta de información no acredita ni refuta una característica. Se representa mediante `null`,
`UNKNOWN`, `PARTIAL` y flags de cobertura. Solo evidencia conocida habilita puntos o penalizaciones.
Un cero observado es distinto de un campo ausente. Una categoría sin reglas evaluables conserva score null.
Un score parcial suma puntos conocidos sin imputar puntos a los desconocidos; sus reglas y estado exponen
la cobertura. La confianza técnica no reemplaza esa incertidumbre.

## Resoluciones confirmadas

| Contradicción o ambigüedad | Cambio y resolución | Mejora buscada |
| --- | --- | --- |
| El proyecto anterior incluía capa 2, cuestionarios, respuestas, primas y resultados combinados | Retirar implementación, contratos, endpoints, tests, migraciones, scripts y documentación activa de ese comportamiento; conservar `private` | Una responsabilidad ejecutable: evaluar evidencia pública |
| Esquema antiguo incompatible con el nuevo flujo | Baseline para base vacía, sin preservar datos anteriores, autorizado por el usuario | No trasladar resultados de reglas obsoletas; no se ejecutó un borrado remoto |
| Overrides antes del score y una investigación activa lo convierte en cero | Score primero, override después; `tier` y `decision` separados; score y tier no se alteran | Distinguir medición de restricciones de decisión |
| Ejemplos y tests numéricos contradicen tablas; todo positivo se describe como 80–87 | Tablas matemáticas como única fuente de verdad; máximo completo 100; fixtures corregidos | Las pruebas verifican reglas reproducibles |
| Una mención de IA parece equivaler a una política | `mention_only` conserva sus 3 puntos de mención, pero no acredita política para W2 | Evitar premiar controles inexistentes |
| Rangos temporales superpuestos o sin límites exactos | Calendario: [0,12 meses), [12 meses,3 años), [3 años,5 años], >5 años | Clasificación consistente en aniversarios y años bisiestos |
| «Peor sanción» carece de orden | disbarment > suspension > public_reprimand > admonishment > none; entre iguales, fecha más reciente; etiquetas y fechas desconocidas siguen null | Resultado estable sin inventar severidad o antigüedad |
| Muestra máxima 15 frente a denominador de todos los abogados de la firma | Muestra estable normalizada de máximo 15, proporción sobre consultados; consultas fallidas/ambiguas o fallback sin denominador conservan null | No penalizar tamaño ni fallos del proveedor |
| Éxito de una fuente confundido con hallazgo de datos | `status` técnico separado de `dataStatus`; PARTIAL si faltan fuentes; respuesta exitosa vacía no acredita actividad profesional | No inventar datos a partir de un HTTP exitoso |
| Áreas libres comparadas literalmente | Normalizar alias y aplicar Jaccard ≥0.8; sin conjuntos comparables, null | Comparación auditable del contenido |
| Multiplicador desconocido sin regla | 1.0 neutral y `known: false`, con característica null cuando corresponda | Evitar recargos/descuentos por falta de datos |
| Caché por dominio y puntaje dependiente del solicitante | Score y caché vinculados a `canonicalDomain` | La misma identidad y evidencia producen el mismo assessment |
| Domain opcional permitiría puntuar una identidad desconocida | `Request → DomainResolution → Assessment`; canonicalDomain obligatorio para ejecutar; null implica assessment null | No puntuar una firma que no se ha identificado |
| Regla de resolución no definida | Dominio explícito normalizado primero; si falta, host del email corporativo con DNS público. Email personal, dominio inválido o resolución fallida dejan null con motivo. No verifica propiedad | Separación explícita entre identidad utilizable y autorización del solicitante |
| W10 usa email corporativo/personal como Firm Maturity | Excluir completamente W10 de señales y scoring. El email solo ayuda a resolver dominio y gestiona sesión/límites | Evitar que dos solicitantes alteren el riesgo de la misma firma |
| Retirar W10 reduce el máximo de maturity a 13 | Con aprobación expresa, antigüedad >10 años pasa de +2 a +3 y áreas consistentes de +2 a +3; otros tres positivos +3; máximo 15 | Mantener escala 100 sin sustituir el email por una inferencia |
| Multipliers mezclan descripción con política comercial | Conservarlos como salida de capa 1 por confirmación del usuario, separados del score | Mantener el contrato solicitado y hacer visible la decisión de negocio |

**Revisión de diseño pendiente, sin bloquear esta implementación:** reconsiderar los valores y el uso
comercial de `multipliers`. Convertir tamaño, área o jurisdicción en un factor aplicado al negocio
es una política de utilización de características, no una observación de la fuente. Su permanencia
en capa 1 no implica que deban aplicarse automáticamente a una prima o decisión.

## Proveedores: incompatibilidades y adaptación

Los actores citados por el HTML no exponen la búsqueda por nombre que requiere el flujo:
[Bar original](https://apify.com/jungle_synthesizer/multi-state-bar-scraper/input-schema)
usa número/rango en Florida;
[Avvo original](https://apify.com/jungle_synthesizer/avvo-scraper/input-schema)
expone directorios y URLs, no búsqueda de nombres. Se sustituyeron los adaptadores por
[Florida Bar](https://apify.com/scrapers_lat/florida-bar-lawyers-scraper/input-schema) y
[Avvo](https://apify.com/solidcode/avvo-scraper/input-schema), que permiten consultas dirigidas.
Se mantienen las tres fuentes lógicas y el matching solicitado; no se simula una búsqueda por nombre
mediante barridos de registros. Contratos públicos revisados el 5 de septiembre de 2026;
las llamadas pagadas reales todavía necesitan validación operacional.

| Diferencia de la fuente | Resolución y motivo |
| --- | --- |
| Bar informa `disciplineHistory10Year`, no toda la carrera | «None» en diez años no acredita historial limpio de por vida: `hasDisciplinaryHistory` y clean record siguen null cuando no existe evidencia adicional |
| Resumen de sanción en texto | Reconocer solo severidad y fecha inequívocas; múltiples candidatos o fecha inválida dejan null; conservar descripción original |
| Casos disciplinarios pendientes no equivalen necesariamente a investigación activa | Solo una declaración explícita confirma o niega `activeInvestigation`; «None» de casos pendientes no inventa esa conclusión |
| Valores vacíos, mensajes de error y límites del actor | Campos ausentes null; errores no son búsquedas exitosas; resultados truncados/parciales quedan PARTIAL; raw original retenido |
| Actor ofrece primera inicial y apellido, o búsqueda textual amplia | Matching local exacto, luego fuzzy y filtro Miami; homónimos restantes quedan ambiguos sin atribuir una persona |

## Otras ambigüedades y tratamiento

| Problema | Resolución y mejora |
| --- | --- |
| Prompt admite solo booleanos/números aunque falte evidencia | Esquema nullable y prompt de incertidumbre; errores no producen objetos llenos de falsos o ceros |
| «Sin dato no penalizar» frente a filas negativas | Aplicar negativos solo a observaciones conocidas; regla desconocida tiene points null |
| Rangos Avvo 7–7.9 y 5–6.9 dejan huecos en promedios | Usar ≥8, ≥7, ≥5 y <5 sin redondeo que cambie bandas |
| Promedios, sumas y predicados sobre listas vacías | Null cuando no hay datos; agregar valores conocidos sin rellenar ausentes, con flags de cobertura |
| «Todos activos» con abogados no encontrados | Inactivo conocido refuta; todos conocidos activos acreditan; incógnitas restantes conservan null |
| Mismo abogado asociado a más de un nombre | Deduplicar por identificador disponible; segunda atribución ambigua, sin doble conteo |
| Año de fundación no ofrece fecha exacta | Puntuar antigüedad solo si el intervalo posible completo cae en la misma banda; no usar copyright como fundación |
| Política para clientes o blog confundidos con controles internos | Exigir que la política gobierne el uso de IA de la propia firma |
| HTML llama «RAG» a concatenar páginas y extraer JSON | Implementar extracción estructurada GPT-4o-mini, sin añadir una base vectorial no requerida |
| Heurísticas históricas y mínimos de palabras | Retirar criterios antiguos; una página breve no pierde validez por longitud. Analizar texto visible y ejecutar JavaScript |
| Hash «antes de re-scrapear» no detecta cambios remotos | Descargar, comparar hash de contenido y versión del analizador, reutilizar análisis validado; no confundirlo con la caché de assessment de 24 horas |
| Caché devuelve identidad/token del primer solicitante | Nuevo registro y sesión por solicitud; reutilizar solo assessment, conservar fecha original y no extender TTL |
| POST ejemplifica solo RUNNING pero requiere caché | 202 fresco; 200 caché con assessment y sesión nueva; 200 UNRESOLVED sin scan ni sesión |
| Polling «hasta COMPLETED» omite finales parciales/fallidos | Documentar COMPLETED, PARTIAL y FAILED como terminales |
| RLS y magic links no explican scans sin login | Backend valida JWT temporal por scan/solicitante; tablas cerradas a anon/authenticated. No crear flujo de contraseñas ajeno al scan |
| Caída de proceso deja RUNNING indefinido | Recuperación al arrancar y periódica; ejecución en proceso con parada que drena trabajos |
| Fallo del análisis puede perder páginas descargadas | Adaptador conserva páginas en raw aun si falla el modelo; el orquestador persiste respuestas disponibles antes de devolver assessment. Una fuente cancelada que aún no entregó respuesta puede no aportar raw |
| Timeout global frente a I/O que ignora cancelación | Fuentes con plazo acotado; reservar 5 de 55 segundos para raw. Persistencia vencida falla explícitamente; adaptadores reciben señal de cancelación |
| Contenido web incluye instrucciones | Tratarlo como material no confiable y extraer evidencia; no obedecer órdenes del documento o sitio |
| DNS válido no basta para cada solicitud de red | Validar direcciones públicas y fijarlas al socket, validar redirecciones y robots; bloquear websockets y servicios internos |
| Límites por IP detrás de proxy | Conexión directa por defecto; saltos confiables configurables solo con topología conocida; límites en memoria para una instancia |

## Implementación y verificación

Reconstruidos contratos, motor puro de cuatro categorías, resolución de dominio, API asíncrona,
sesiones, caché por dominio, persistencia Supabase/memoria, crawling, extracción estructurada,
adaptadores Apify, cancelación, recuperación y tres escenarios mock.
Retirados módulos anteriores y su documentación activa; no se reescribió historial Git ni se modificó `private`.
El baseline se creó mediante Supabase CLI y se valida en PostgreSQL embebido con roles y RLS.

Las pruebas incluyen reglas matemáticas y fechas límite, incertidumbre, overrides que no alteran score,
dominio opcional sin assessment desconocido, caché entre solicitantes, tokens, límites, fallos parciales,
persistencia, ciclo Apify simulado y Chromium real con transporte local de fixtures.
Los mocks producen 84, 25 y 74; el último conserva tier FORTIFIED y aplica decisión REFERRAL_SENIOR.

Verificación final local: compilación correcta, 96 pruebas aprobadas en 10 archivos,
83.05% de cobertura de líneas global y 99.24% en el motor de scoring.
Prueba HTTP del servidor compilado: resolución desde email, scan COMPLETED con score 84,
email personal sin dominio devuelve UNRESOLVED/assessment null y otro solicitante obtiene
caché del mismo dominio con sesión distinta y score idéntico.

No se ha aplicado la migración a una base remota ni desplegado el contenedor. El daemon Docker no
estaba disponible y no se realizaron llamadas con credenciales de proveedores reales. Estas son
validaciones operacionales pendientes, distintas de las decisiones funcionales ya resueltas.
