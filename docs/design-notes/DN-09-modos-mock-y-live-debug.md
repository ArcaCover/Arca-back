# DN-09 — Modos `mock` y `live-debug`

**Estado:** diseño, pendiente de aprobación (2026-10-23). Las secciones 11 y 12 (cómo correrlo y qué se verificó) se completan al implementar.
**Alcance:** Arca-back y Arca-front, los dos repos a la vez. Todo queda en local: nada se despliega ni se sube.
**Autor de las decisiones:** Jesús (marcadas **[Jesús]**) y el asistente que lo implementa (marcadas **[mía]**, revisables).

---

## 1. Por qué

Probar el flujo completo (`/quote` → scan → `/score` → assessment → resultados) hoy depende de servicios reales. El scan tarda de 2 a 7 minutos, cuesta crédito de Apify y OpenAI, y cuando Apify se queda sin crédito el flujo se cae antes de llegar a lo que querías probar. **[Jesús]**

Lo que más falta no es saltarse la espera sino **provocar los fallos a propósito**: ver cómo responden el front y el back cuando Apify no tiene crédito, cuando una fuente se cae, cuando el scan termina PARTIAL o FAILED. **[Jesús]**

## 2. Objetivos, no-objetivos y anti-objetivos

**Objetivos**
1. **`mock`:** recorrer el flujo entero sin tocar ninguna API real (ni OpenAI, ni Apify, ni Supabase, ni webs de terceros), en segundos, con fallos inyectables a voluntad.
2. **`live-debug`:** el flujo real (APIs y Supabase reales) con la misma etiqueta, el mismo panel de estado y la misma inyección de fallos. Por ejemplo, simular que Apify se quedó sin crédito aunque lo tenga. **[Jesús]**
3. Las dos se distinguen de un vistazo, entre sí y de producción.
4. **En producción no queda nada accesible:** ni rutas de debug en el back, ni panel, etiquetas o botones en el front. **[Jesús]**

**No-objetivos**
- Desplegar `live-debug` en un staging o en un preview de Vercel. Solo corre en la máquina de Jesús, por ahora. **[Jesús]**
- Cambiar el comportamiento de producción, el contrato público o el scoring.
- Separar Supabase de dev y de producción. Queda como recomendación (§10).

**Anti-objetivos.** Esto sería un fracaso aunque funcione:
- Un fallo inyectado en `live-debug` termina en la caché de 7 días que producción sirve a clientes reales.
- Un despliegue de producción arranca con el modo de debug activo por un `.env` mal copiado.
- La etiqueta dice MOCK mientras el back corre en live, o al revés.

## 3. Los tres modos

| | `production` | `live-debug` | `mock` |
|---|---|---|---|
| Fuentes (website, Bar, Avvo) | reales | reales, salvo las que inyectes | fixtures locales |
| LLM (OpenAI) | real | real | ninguno |
| Apify | real | real, salvo lo inyectado | ninguno |
| Base de datos | Supabase | Supabase para lo limpio; **memoria para todo scan con fallo inyectado** | memoria |
| Etiqueta en el front | ninguna | **LIVE DEBUG** (rojo) | **MOCK** (ámbar a rayas) |
| Panel de estado y botones | no existen | sí | sí |
| Rutas `/__debug/*` en el back | no existen (404 de Hono) | sí, solo en `127.0.0.1` | sí, solo en `127.0.0.1` |

Nombres **[mía]**. `live-debug` es lo que en la conversación se llamó "dev-live": el nombre dice "real + depuración". Evito "demo" a propósito, porque en este proyecto ya significa dos cosas: el contenido DEMO visible en producción y la infraestructura `arca-demo`.

## 4. Configuración

**Una variable por repo, con los mismos valores:**
- back: `ARCA_MODE`;
- front: `NEXT_PUBLIC_ARCA_MODE`.

**Reglas comunes**
- Si la variable **falta**, el modo es `production`.
- Un valor **desconocido** (`Mock`, `debug`, `live`…) **impide arrancar**, con un error que lista los valores válidos. Nunca se cae en un modo por accidente.

**Back (`apps/api/src/config/env.ts`)**
- `ARCA_MODE=mock` es el interruptor maestro en la dirección segura:
  - **impone** `SOURCE_MODE=mock`, `STORAGE_BACKEND=memory` y el planner por reglas, aunque el `.env.local` diga `live`/`supabase` (hoy lo dice);
  - el arranque imprime qué valores pisó;
  - no exige `OPENAI_API_KEY`, `APIFY_API_TOKEN` ni claves de Supabase. Si están en el `.env.local`, no se usan, porque no se construye ningún cliente;
  - lo que importa para que la etiqueta no mienta es que el back reporta su modo **efectivo** (§5.2), no lo que decía el archivo.
- `ARCA_MODE=live-debug` va en la dirección cara, así que **no impone nada**:
  - exige que `SOURCE_MODE` y `STORAGE_BACKEND` ya resuelvan a `live` y `supabase`;
  - si resuelven a otra cosa, el back no arranca y explica el conflicto;
  - el resto de la configuración es la misma que en producción.
- `ARCA_MODE=production` (o ausente): exactamente lo de hoy. El combo heredado `SOURCE_MODE=mock` + `STORAGE_BACKEND=memory` sigue funcionando para CI y para `test:container`, pero **sin** debug.

**Guarda de despliegue [mía]**
- Se añade `ARCA_DEPLOYMENT=aws` a `deploy/production.env`, que viaja dentro de la imagen.
- Si `ARCA_DEPLOYMENT` tiene cualquier valor y `ARCA_MODE` no es `production`, el back no arranca.
- Así, un `.env` de debug copiado por error a producción tumba el arranque en vez de abrir el debug.
- No uso `NODE_ENV`: el Dockerfile lo fija en `production` y el smoke del contenedor corre mock con él.

**Front (`next.config.ts`)**
- Valida `NEXT_PUBLIC_ARCA_MODE` al arrancar `next dev` y `next build`.
- Lo **fija como literal** con la clave `env` del config, con `production` por defecto. Una `NEXT_PUBLIC_*` no definida no se sustituye en el bundle; con el literal, el compilador puede eliminar las ramas muertas.
- Si `VERCEL` está definido (cualquier build en Vercel, preview o producción) y el modo no es `production`, **el build falla**. `live-debug` es solo local. **[Jesús]**

**Arrancar los dos en el mismo modo [mía]**
- Cada repo tiene `npm run dev:mock` y `npm run dev:live-debug`, que fijan la variable en el proceso; las del shell ganan al `.env.local`.
- Arca-back añade además un lanzador que arranca back y front a la vez en el mismo modo: `npm run stack -- mock`. Así no hay forma de olvidarse de uno de los dos.
- Lo que no se toca: los `.env.local` de Jesús. Los modos funcionan sin editarlos.

## 5. Back

### 5.1 Cableado

`server.ts` decide y `createApp` obedece:
- `createApp` recibe una dependencia opcional `debug`.
- **Sin ella (producción) no se registra ninguna ruta de debug, no se lee ninguna cabecera de escenario y el CORS no admite la cabecera de debug.** El gate actúa al registrar, no en cada petición: en producción ese código no es alcanzable.
- Con modo no-producción, `server.ts`:
  1. escucha solo en `127.0.0.1` (hoy escucha en todas las interfaces);
  2. construye `debug` con el modo, el catálogo de escenarios y los repositorios de aislamiento (§5.5);
  3. imprime una línea de arranque inequívoca, p. ej. `[api] MODE=live-debug (debug routes on 127.0.0.1 only)`.

### 5.2 Rutas `/__debug/*` (solo en mock y live-debug)

| Ruta | Auth | Qué devuelve / hace |
|---|---|---|
| `GET /__debug/mode` | ninguna (solo loopback) | `{ mode, sourceMode, storageBackend, websiteEvidenceProvider, assessmentPlanner, signalLlmModel, configured: { openai, apify, supabase } }`. Los `configured` son solo booleanos, **nunca** valores ni URLs. |
| `GET /__debug/scan/:scanId` | Bearer del scan, igual que el poll | Estado interno: el `ScanRecord` (tiempos, resolución de dominio, `cached`), el escenario inyectado, si está en el overlay de memoria y el resumen de diagnósticos crudos (fuentes, códigos, razones, duraciones). Todo como JSON; el front lo pinta como texto. |
| `POST /__debug/reset` | ninguna (solo loopback) | Vacía el rate limiter. En `mock` también vacía los repositorios en memoria. **No toca Supabase.** |

### 5.3 Escenarios de fallo

El front manda el escenario en la cabecera `X-Arca-Debug-Scenario` (JSON) **solo** en `POST /scan`.
- El back lo valida con zod; si es inválido responde 400 `invalid_request`.
- Lo guarda junto al scan y lo aplica a ese scan y a todo lo que cuelga de él: los polls, el PDF y su assessment.
- Sin cabecera, el scan es normal: los fixtures por dominio en `mock`, todo real en `live-debug`.

Catálogo:

| Eje | Valores | Notas |
|---|---|---|
| `website` | `default`, `no_identity`, `blocked`, `error`, `timeout` | `default` es el fixture en mock y el crawler real en live-debug. `no_identity`: se leyó la web pero no hay firma ni abogados, así que la identidad sale INSUFFICIENT y Bar y Avvo quedan `skipped` (`INSUFFICIENT_IDENTITY`). El código real cuenta la web legible como fuente útil, así que el scan termina **PARTIAL**. El FAILED de muscalaw vino de que falló la extracción: eso es `website: error`. `blocked` imita un sitio que bloquea el crawler (`ACCESS_BLOCKED`). |
| `bar`, `avvo` | `default`, `empty`, `apify_quota`, `error`, `timeout` | `apify_quota` devuelve **exactamente** el `SourceResult` que produce hoy `ApifyDirectorySource` al llegar al límite de uso: status `error`, code `PROVIDER_ERROR` y la misma `reason`. **No pasa por el `ApifyClient`**, porque su cortacircuitos de cuota es compartido por todo el proceso y bloquearía también los scans limpios. |
| `latency` | `instant`, `normal` (~8 s), `slow` (~70 s) | Solo en mock. `slow` cruza los 60 s para ver el mensaje de "más lento de lo habitual". |
| `http.start` | `none`, `rate_limited`, `server_error` | `POST /scan` responde 429 con `Retry-After`, o 500, sin crear el scan. |
| `http.poll` | `none`, `unauthorized`, `server_error`, `hang` | Afecta a los polls de ese scan. `unauthorized` dura siempre (sesión vencida). `server_error` y `hang` solo afectan a los 2 primeros polls, para ver cómo el front se recupera de un corte. `hang` retiene la respuesta 16 s, así que el front la ve como caída de red. |
| `http.report` | `none`, `unavailable` | El PDF responde 503 `report_unavailable`. |
| `planner` | `default`, `timeout` | Un planner que no responde a tiempo, para ver el fallback a reglas del assessment. |

El desenlace global (COMPLETED, PARTIAL o FAILED) **no se elige: sale de lo anterior**, con la misma lógica de `in-process-pipeline.ts`. Así se prueba el código real y no un atajo.

El panel trae preajustes con nombre, que solo rellenan los ejes:
- "Apify sin crédito": Bar y Avvo en `apify_quota`;
- "PARTIAL": solo Avvo en `error`;
- "Sin identidad de firma": website en `no_identity` (PARTIAL, directorios saltados);
- "Todo cae": las tres fuentes en `error`;
- "Sesión vencida": `http.poll` en `unauthorized`.

### 5.4 Cómo se inyecta

- Para un scan con escenario, `createApp` pide a `debug` un pipeline para ese scan.
- Es el mismo `InProcessPipeline`, con cada fuente envuelta: el envoltorio devuelve el resultado fabricado o delega en la fuente real.
- El escenario nunca atraviesa el código de producción de las fuentes.

### 5.5 Aislamiento en `live-debug` (la base es la de producción) **[Jesús + mía]**

Jesús confirmó que dev y producción comparten el mismo Supabase. Regla: **un scan con cualquier eje inyectado vive entero en memoria.** Eso implica:
- su registro, su evidencia cruda y su assessment van a repositorios en memoria del proceso, enrutados por `scanId`;
- **no lee la caché de dominio**, porque si no se vería el resultado cacheado y no el fallo, y **no entra en ella**: nunca se escribe en Supabase;
- no comparte el pipeline en vuelo con un scan limpio del mismo dominio;
- las fuentes inyectadas no llaman a Apify, así que no dejan rastro en el ledger de gasto.

Las fuentes **no** inyectadas del mismo scan sí corren de verdad. Lo que escriben en la caché de consultas de Apify o en el análisis del crawler es evidencia genuina, igual que hoy.

**Gasto real dentro de un scan inyectado [mía, sobre lo que pidió Jesús: "registrar el gasto internamente"].**

Si un directorio queda en `default`, sus búsquedas reales a Apify pasan por el ledger de Supabase **sin `scanId`**. `reserve_apify_run` ya admite `p_scan_id` nulo: registra el run en `apify_runs` y no lo enlaza en `scan_apify_runs`.

Hace falta así porque `scan_apify_runs.scan_id` tiene clave foránea a `scans`. Con el `scanId` de un scan que solo vive en memoria, la reserva fallaría, y Bar o Avvo saldrían en `error` sin que nadie lo inyectara: la etiqueta mentiría.

Con este camino:
- el gasto real queda registrado;
- la caché de consultas de 7 días se reutiliza como en producción;
- no se escribe ninguna fila que apunte a un scan inexistente.

Un test lo comprueba (§8).

Un scan **sin** escenario en `live-debug` se comporta exactamente como uno de producción: lee y escribe Supabase.

Los scans inyectados se pierden al reiniciar el back. Es aceptable para pruebas.

### 5.6 Layer 2

- El assessment de un scan inyectado usa el repositorio en memoria (§5.5).
- `planner: timeout` sustituye el agente de ese assessment por uno que nunca responde, así el servicio cae en su fallback de reglas.
- El auto-responder vive en el front (§6.4) y usa la API normal: no necesita ruta de debug.

## 6. Front

### 6.1 Modo y eliminación en producción

- El modo es un literal fijado al compilar (§4).
- Todo el código de debug (barra, panel, controles, puente de estado) está en `lib/debug/` y `components/debug/`.
- Solo se carga con `next/dynamic` **dentro de** una comparación literal escrita en cada sitio, del tipo `process.env.NEXT_PUBLIC_ARCA_MODE !== "production"`.
- En un build de producción esa rama es código muerto, y el chunk del panel no se emite.
- Los puntos donde las páginas publican su estado llaman a una función puente cuyo cuerpo, en producción, se reduce a `return`.
- Así no hace falta aliasar módulos, cosa que ataría el diseño a Turbopack o a webpack. **[mía]**
- **Esto se verifica, no se supone:** un test compila en producción y busca en `.next` un centinela que solo existe en el código de debug (§8).

### 6.2 Barra de modo (siempre visible en mock y live-debug)

Una franja fija arriba, sobre todo lo demás. Se mantiene dentro de la paleta de `globals.css`, porque CLAUDE.md prohíbe hex sueltos y ampliar la paleta. Aun así, cada modo se distingue por su forma y no solo por el color: rayas, sólido o invertido. **[mía]**

| Modo | Aspecto | Texto |
|---|---|---|
| `mock` | `oro` con rayas diagonales `marino` (patrón que no aparece en ningún otro sitio de la UI) | **MOCK** · no real APIs · in-memory data |
| `live-debug` | `rojo` sólido con texto blanco (el rojo ya está reservado para alertas) | **LIVE DEBUG** · real APIs & real database |
| Desalineado | `marino` sólido con texto `oro` e icono de alerta | **MODE MISMATCH** · front=`mock`, back=`live-debug` (o "back unreachable / production") |

- El front pregunta `GET /__debug/mode` al cargar.
- Si el back no tiene esa ruta (404: producción) o responde otro modo, la barra pasa a desalineado. **Nunca afirma un modo que no comprobó.**
- El texto de debug va en inglés, como el código y la UI del producto. **[mía]**

### 6.3 Panel de estado

- Desplegable desde la barra.
- Muestra, por página, las variables que hoy son invisibles:

| Página | Variables |
|---|---|
| `/quote` | escenario elegido, último error (`code`, `retryAfter`), respuesta de `startScan` (`status`, `cached`) |
| `/quote/scanning` | `status` y `elapsed` del último poll, tiempo de espera local, cadencia de poll, fase |
| `/score` | `meta` (`cached`, `reusedEvidence`, `scanDurationMs`, `contractVersion`), por fuente (`status`, `dataStatus`, `code`, `reason`, `durationMs`, `pagesCrawled`, `attorneysSearched`/`Found`, `costUsd`), `preScore` (`tier`, `decision`, `confidence`, `flags`), `identity.status` |
| `/assessment` | `assessmentId`, `status`, `planner`, `bankVersion`, `expiresAt`, progreso, tiempo en PLANNING |
| `/assessment/results` | `layer1Score`, `layer2Score`, `compositeScore`, `tier`, `flags`, versiones |
| Siempre | modo del back (`/__debug/mode`), `scanId`, `iat` y `exp` del token (**nunca el email ni el token completo**), botón "ver estado interno" (`GET /__debug/scan/:id`) |

- Todo lo que viene de webs de terceros (razones, nombres) se pinta como texto, nunca como HTML.

### 6.4 Botones especiales

| Dónde | Botón | Qué hace |
|---|---|---|
| `/quote` | Selector de escenario y preajustes (§5.3) | Se guarda en `sessionStorage` y viaja en la cabecera del próximo `POST /scan`. En mock también rellena email y dominio con un `*.arca.example`. |
| `/quote` | Reset | `POST /__debug/reset`: libera el rate limit y, en mock, la memoria. |
| `/assessment` | Auto-responder | Contesta cada pregunta visible con su respuesta sugerida (o la primera válida) por la API normal, hasta completar. |
| `/assessment` | Atestar y completar | Marca la atestación y llama a `complete`. |
| Panel | Ver estado interno | Muestra el JSON de `GET /__debug/scan/:id`. |

## 7. Seguridad: amenazas y defensas

| Amenaza | Defensa |
|---|---|
| Rutas de debug alcanzables en producción | No se registran sin `debug` (§5.1). Producción nunca construye `debug`, porque `ARCA_MODE` falta o vale `production`. |
| Un `.env` de debug llega al servidor de producción | `ARCA_DEPLOYMENT=aws` dentro de la imagen + fail-fast (§4) |
| Valor del modo mal escrito | Error al arrancar, en back y en front (§4) |
| Un atacante manda `X-Arca-Debug-Scenario` a producción | Ninguna línea de producción lee esa cabecera, y el CORS de producción no la admite |
| Debug alcanzable desde la red local | El back escucha solo en `127.0.0.1` en los modos de debug |
| Fallo inyectado contamina la caché o el ledger de producción (Supabase compartido) | Overlay en memoria + sin caché + sin Apify para lo inyectado (§5.5) |
| Panel de debug en un build de producción o en un preview de Vercel | Literal + eliminación de código muerto; el build falla en Vercel con modo de debug; centinela verificado (§6.1, §8) |
| Fuga de secretos por `/__debug/mode` | Solo enums y booleanos |
| Fuga del email por el panel | Del token solo se muestran `iat` y `exp` |
| XSS con contenido de webs ajenas en el panel | Siempre texto, nunca `dangerouslySetInnerHTML`; la API de debug responde solo JSON |
| Mock que sale a la red | No se construye ningún cliente real; un test bloquea toda salida de red y recorre el flujo entero |

## 8. Verificación prevista (cada punto es un test o un comando con salida registrada en §12)

**Back**
1. `createApp` sin `debug`:
   - `/__debug/mode`, `/__debug/scan/x` y `/__debug/reset` → 404;
   - un `POST /scan` con `X-Arca-Debug-Scenario` se procesa como un scan normal;
   - el preflight CORS no admite esa cabecera.
2. `loadEnv`:
   - sin `ARCA_MODE` → `production`;
   - con un valor inválido → lanza error;
   - `mock` con `SOURCE_MODE=live` y `STORAGE_BACKEND=supabase` → resuelve a mock/memory;
   - `live-debug` con `SOURCE_MODE=mock` → lanza error;
   - `ARCA_DEPLOYMENT` + modo de debug → lanza error;
   - `mock` sin claves → arranca.
3. **Mock sin red:** con `fetch`, `net.connect` y `dns.lookup` sustituidos por funciones que lanzan error, se recorre scan → poll → assessment → complete → result y nada sale.
4. **Aislamiento live-debug** (repositorio durable espía):
   - un scan inyectado nunca llama a `create`, `complete`, `cached` ni `saveRaw` del durable, y la fuente Apify inyectada nunca llama al cliente;
   - un scan limpio sí usa el durable.
5. Un scan inyectado no comparte el pipeline en vuelo con uno limpio del mismo dominio, y sus directorios reales (`default`) reservan en el ledger con `scanId` nulo.
6. `apify_quota` produce un `SourceResult` igual al real del límite de uso (comparado con el que genera `ApifyDirectorySource` con un cliente que lanza `PROVIDER_QUOTA_EXCEEDED`).
7. En modo de debug el servidor escucha en `127.0.0.1`.
8. `GET /__debug/scan/:id` exige el token del scan.

**Front**
9. `next build` en modo `production` + búsqueda del centinela y de cadenas como `__debug` o `LIVE DEBUG` en `.next/` → cero coincidencias.
10. `next build` con `VERCEL=1` y modo `mock` → falla. Con un valor inválido → falla.
11. Tests unitarios:
    - el cliente no añade la cabecera de escenario en producción;
    - la barra pasa a desalineado ante 404 o un modo distinto;
    - el panel no muestra el email.
12. Smoke de navegador en mock (Playwright): flujo completo con los botones, más los preajustes "Apify sin crédito", "Todo cae" (FAILED) y "Sesión vencida".

## 9. Decisiones tomadas por el asistente (revisar)

1. Nombres `mock` y `live-debug`; variables `ARCA_MODE` y `NEXT_PUBLIC_ARCA_MODE`.
2. Una variable ausente significa producción, y un valor inválido aborta el arranque.
3. `mock` impone `SOURCE_MODE=mock` y `STORAGE_BACKEND=memory` por encima del `.env.local` (dirección segura) y lo avisa en el arranque. `live-debug` nunca impone: exige que ya estén en `live`/`supabase` o aborta (dirección cara).
4. Marcador `ARCA_DEPLOYMENT=aws` en `deploy/production.env`. Es el único cambio en archivos de despliegue y no cambia el comportamiento de producción.
5. Escenario por cabecera en `POST /scan`, no en un endpoint aparte, para que el scan inyectado pase por el código real: rate limit, resolver y estados.
6. El desenlace global no se elige: emerge de las fuentes.
7. Colores de la paleta, distinguibles por patrón: `oro` a rayas para MOCK, `rojo` sólido para LIVE DEBUG y `marino` invertido para desalineado. Texto en inglés, como el resto de la UI; sin fuente monoespaciada (CLAUDE.md la excluye).
8. Eliminación en el front por literal + `next/dynamic`, verificada con centinela, en vez de alias de módulos.
9. El código de debug del back vive en `apps/api/src/debug/` y se compila a la imagen, pero es **inalcanzable**: no se registra sin `debug`, y `debug` no puede construirse con el marcador de despliegue. Sacarlo de la imagen choca con `rootDir` de TypeScript y no añade una barrera real.
10. El documento de diseño y la nota final son uno solo (este), en `docs/design-notes/`, con un puntero desde Arca-front.
11. En `live-debug`, el gasto real de un scan inyectado se registra en el ledger sin `scanId` (§5.5).
12. DN-08 (estado del proyecto) se escribe en este mismo trabajo, en `docs/design-notes/`.

## 10. Fuera de alcance y recomendaciones

- **Supabase separado para dev (recomendado).** Compartir la base con producción tiene riesgos que existen hoy, con o sin este feature:
  - si el código local cambia la forma de un resultado, producción puede leer esa fila de la caché y fallar al validarla;
  - un proceso local reconcilia el ledger de Apify compartido cada 60 s y puede tocar filas que lanzó producción;
  - `recoverInterrupted` marca como FAILED los scans colgados de cualquiera.

  Con un proyecto `Arca-dev` (mismas migraciones), `live-debug` pasa a ser cambiar `SUPABASE_URL` y su clave. Los pasos irán en §11. Crear el proyecto le toca a Jesús.
- Fugas de diagnóstico que ya existen en producción y no son parte de este feature:
  - `providerRuns` y los costes de Apify en el contrato público;
  - `console.log` con datos personales en los formularios de partners y plataformas;
  - `/docs` registrado siempre y protegido solo en Caddy.

  Se listan en DN-08.
- `next/font/google` descarga fuentes al compilar, incluso en mock. Es un recurso estático, no una API del producto; se deja así.

## 11. Cómo correrlo

*(Se completa al implementar: comandos para back y front en cada modo, cómo ponerlos en el mismo modo a la vez y cómo comprobar que coinciden.)*

## 12. Verificaciones de seguridad realizadas

*(Se completa al implementar: cada punto de §8 con el comando, el resultado y la salida relevante.)*
