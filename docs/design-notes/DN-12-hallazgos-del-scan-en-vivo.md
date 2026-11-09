# DN-12 · Hallazgos del scan en vivo

- **Fecha:** 2026-11-09
- **Estado:** en implementación. Cada arreglo tiene su sección (§3 a §8) y la amplía la tarea que lo hace.
  Hoy están hechos §3 y la parte de scoring de §4.
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

**Caché.** Un PARTIAL de web bloqueada entra en la caché de scans como cualquier PARTIAL: hoy se sirve
durante 1 hora y después se vuelve a ejecutar. Que se sirva los 7 días es D5 (§4).

**Tests.** `packages/scoring/tests/unreadable-website.test.ts`, `apps/api/tests/unit/pipeline.test.ts`
(definitiva frente a transitoria, con el website source real sobre un crawl inyectado),
`apps/api/tests/integration/unreadable-website.test.ts` (por HTTP: scan, poll PARTIAL, PDF, assessment
completo y `failed.arca.example` FAILED, todo validado con los esquemas estrictos de 0.4.0),
`mock-scenarios.test.ts`, `debug-mode.test.ts`, `debug-sources.test.ts` y `report.test.ts`.

**Pendiente en el front.** La lista de dominios mock, el texto de la pantalla FAILED (ya no es "la web nos
bloqueó") y el aviso de web ilegible en `/score` y en `/assessment/results`.

## 4. Mismo despacho, mismo score (F5, D5)

Hecho: la misma evidencia da el mismo resultado en cualquier orden (DN-03, "Mismo resultado en cualquier orden").

Pendiente: servir un PARTIAL estructural o definitivo durante toda la ventana de caché.

## 5. Control de coste (F6)

Pendiente.

## 6. PDF de Capa 2 y botón de exportar (F1, D8)

Pendiente. Ruta fijada: `GET /assessment/:assessmentId/report.pdf`, con el Bearer de la sesión del scan y
`Content-Disposition` `arca-assessment-<dominio>-<aaaa-mm-dd>.pdf`.

## 7. Webapp simulada en live-debug (F2, D7)

Pendiente.

## 8. Textos de la interfaz (F3, D8)

Pendiente.

## 9. Lo que no cambia

- El contrato publicado: `@arca/contracts` sigue en 0.4.0, sin campos ni valores nuevos (D6).
- La identidad: el dominio sigue sin convertirse en nombre de firma (DN-04).
- Producción: nada de mock ni de debug llega a ella (DN-09).
