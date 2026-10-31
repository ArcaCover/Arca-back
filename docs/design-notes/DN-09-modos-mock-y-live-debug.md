# DN-09 — Modos `mock` y `live-debug`

**Estado:** implementado (2026-10-23), en la rama local `feat/arca-modes` de los dos repos, sin subir ni desplegar. La §11 explica cómo correrlo y la §12 recoge lo que se verificó.
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
| `GET /__debug/mode` | ninguna (solo loopback) | `{ mode, sourceMode, storageBackend, websiteEvidenceProvider, assessmentPlanner, signalLlmModel, inUse: { openai, apify, supabase } }`. Describe lo que el proceso **construyó**, no lo que dice la configuración: `websiteEvidenceProvider` es `agentic`, `openai`, `rules` o `mock`; `signalLlmModel` es el modelo de OpenAI que llama un componente construido, o `null` si ninguno lo llama; `inUse` dice para qué servicios se construyó un cliente. Solo enums, booleanos y el nombre del modelo, **nunca** claves ni URLs. |
| `GET /__debug/scan/:scanId` | Bearer del scan, igual que el poll | Estado interno: el `ScanRecord` (tiempos, resolución de dominio, `cached`), el escenario inyectado, si está en el overlay de memoria y el resumen de diagnósticos crudos (fuentes, códigos, razones, duraciones). Todo como JSON; el front lo pinta como texto. |
| `POST /__debug/reset` | cabecera `X-Arca-Debug: 1` (solo loopback) | Vacía el rate limiter. **Solo en `mock`** vacía además los repositorios en memoria; en `live-debug` los scans inyectados siguen en memoria. **No toca Supabase.** Sin la cabecera responde 400: así deja de ser una petición CORS simple, el navegador hace preflight y solo pasan los orígenes permitidos. |

### 5.3 Escenarios de fallo

El front manda el escenario en la cabecera `X-Arca-Debug-Scenario` (JSON) **solo** en `POST /scan`.
- Es de **un solo uso**: el front lo saca del `sessionStorage` de la pestaña al mandarlo con el próximo `POST /scan`, aunque ese arranque falle. El siguiente scan es normal salvo que se vuelva a elegir uno. Así un escenario olvidado no sigue cambiando scans sin que nadie lo vea.
- El back lo valida con zod; si es inválido responde 400 `invalid_request`.
- Fuera de `mock`, el back pone `latency` en `instant` antes de decidir si el escenario inyecta algo. Un `latency` que sobró de una sesión mock en la misma pestaña ya no aísla un scan limpio de `live-debug`.
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
- los ids aislados, de scan y de assessment, no se olvidan nunca, ni tras un reset: un id que ya no está en memoria responde 404 y nunca cae a Supabase;
- **no lee la caché de dominio**, porque si no se vería el resultado cacheado y no el fallo, y **no entra en ella**: nunca se escribe en Supabase;
- no comparte el pipeline en vuelo con un scan limpio del mismo dominio;
- las fuentes inyectadas no llaman a Apify, así que no dejan rastro en el ledger de gasto.

Las fuentes **no** inyectadas del mismo scan sí corren de verdad, pero no todo lo que producen dura:
- la caché de consultas de Apify y el ledger de gasto son durables, como hoy;
- el análisis de la web de un scan inyectado se guarda con su `scanId`, así que vive y muere en memoria. El próximo scan limpio de ese dominio vuelve a pagar la extracción con OpenAI.

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
| Comprobando | `bruma` liso con texto `marino`, sin rayas ni icono: no pertenece a ningún modo | Checking the back's mode · front=`mock` |

- El front pregunta `GET /__debug/mode` al cargar y vuelve a preguntar en cada cambio de página, cuando la pestaña recupera el foco o vuelve a ser visible, y cada 10 s mientras está visible. Así, si el back se reinicia en otro modo con la pestaña abierta, la barra lo dice.
- Mientras una pregunta está en curso, la barra conserva el último estado confirmado; cualquier cambio se ve en cuanto llega la respuesta.
- Si el back no tiene esa ruta (404: producción) o responde otro modo, la barra pasa a desalineado. **Nunca afirma un modo que no comprobó**, ni con el texto ni con el aspecto: las rayas y el rojo esperan a que el back confirme el modo.
- Mientras hay un escenario armado para el próximo scan, la barra lo añade: `· next scan injects: Bar apify_quota, Avvo apify_quota`. En `live-debug` no nombra `latency`, que allí no existe.
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
- Cada página publica su estado junto con el `scanId` al que pertenece. Si la URL lleva otro `?scan`, el panel dice `Nothing published for this scan yet` en vez de enseñar el estado de otro scan. `/quote` no lleva scan en la URL, así que enseña el último arranque que hizo, con el escenario que mandó (`sentScenario`).

### 6.4 Botones especiales

| Dónde | Botón | Qué hace |
|---|---|---|
| `/quote` | Selector de escenario y preajustes (§5.3) | Se guarda en `sessionStorage` y viaja en la cabecera del próximo `POST /scan`, y solo en ese: el envío lo borra. En mock también rellena email y dominio con un `*.arca.example`. |
| `/quote` | Reset | `POST /__debug/reset` con `X-Arca-Debug: 1`: libera el rate limit y, en mock, la memoria. |
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
| Una página de producción importa un módulo de debug que el centinela no conoce | Regla de ESLint: fuera de `components/debug` y `lib/debug` solo se importan `DebugMount` y `lib/debug/bridge`, y `@arca/contracts/debug` en ningún otro sitio, también con `import()` |
| Una página ajena, abierta en el navegador del desarrollador, dispara `POST /__debug/reset` | El reset exige `X-Arca-Debug: 1`: deja de ser una petición simple, y el preflight solo lo pasan los orígenes permitidos |
| Fuga de secretos por `/__debug/mode` | Solo enums, booleanos y el nombre del modelo |
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

Todo en PowerShell, en Windows. Los scripts fijan el modo solo dentro del proceso que lanzan: la terminal queda limpia y los `.env.local` no se tocan. Las variables puestas en el shell ganan a las del `.env.local`, tanto en el back como en el front.

**Antes de la primera vez**, y cada vez que cambie `packages/*` del back, compila el back: el front importa `@arca/contracts` ya compilado.

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run build
```

### 11.1 Mock con un solo comando (recomendado)

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run stack -- mock
```

- Arranca los dos en la misma terminal y marca cada línea con `[back]` o `[front]`:
  - el back con `ARCA_MODE=mock`, que impone `SOURCE_MODE=mock` y `STORAGE_BACKEND=memory`;
  - el front con `NEXT_PUBLIC_ARCA_MODE=mock`, `NEXT_PUBLIC_API_URL=http://localhost:8080` y `next dev --webpack`, porque Turbopack se cuelga en esta máquina.
- Está listo cuando salen `[back] [api] MODE=mock sources=mock storage=memory (debug routes on 127.0.0.1 only)` y `[front] ✓ Ready`. Abre `http://localhost:3000/quote`.
- `Ctrl+C` para los dos.
- Si un proceso termina, el lanzador para el otro. Pero un error de arranque del back no lo termina: `tsx watch` se queda esperando cambios. El error del back pasa entre las líneas del front, el front sigue corriendo y la franja dice MODE MISMATCH. Si la ves así nada más arrancar, busca el error en las líneas `[back]`.

### 11.2 Mock con cada repo en su terminal

Terminal 1:

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run dev:mock
```

Terminal 2:

```powershell
cd C:\Users\jesus\projects\Arca-front
$env:NEXT_PUBLIC_API_URL = 'http://localhost:8080'
npm run dev:mock
```

- La línea de `NEXT_PUBLIC_API_URL` solo hace falta si el `.env.local` del front apunta a otra API. Vale para esa terminal y desaparece al cerrarla.
- El back de debug escucha solo en `127.0.0.1`. El navegador llega igual por `localhost`, y el `CORS_ALLOWED_ORIGINS` del back tiene que incluir `http://localhost:3000`, como en `.env.example`.

### 11.3 Live-debug

Usa servicios reales y de pago: OpenAI, Apify y el Supabase compartido con producción (§5.5).

```powershell
cd C:\Users\jesus\projects\Arca-back
npm run stack -- live-debug
```

O por separado: `npm run dev:live-debug` en Arca-back y `npm run dev:live-debug` en Arca-front.

- Por separado vale lo mismo que en la §11.2: si el `.env.local` del front apunta a otra API, pon antes `$env:NEXT_PUBLIC_API_URL = 'http://localhost:8080'` en la terminal del front. Si no, el front habla con esa otra API y la franja dice MODE MISMATCH.
- El back no arranca si `SOURCE_MODE` y `STORAGE_BACKEND` no resuelven a `live` y `supabase`, y el error explica el conflicto. Con el `.env.local` de Jesús resuelven bien.
- Línea de arranque: `[api] MODE=live-debug sources=live storage=supabase (debug routes on 127.0.0.1 only)`.
- Al arrancar recupera los scans y assessments interrumpidos contra la base compartida, igual que hoy `npm run dev`.
- Un scan **sin** escenario es un scan real: escribe en Supabase y gasta crédito.
- Un scan **con** escenario vive en memoria (§5.5). Aun así, sus fuentes en `default` (que el panel llama "real") llaman a las APIs reales.
- El escenario es de un solo uso: el scan siguiente vuelve a ser real si no eliges otro. Mira la franja antes de lanzar: si dice `next scan injects: …`, el próximo scan lleva ese escenario.

### 11.4 Comprobar que back y front están en el mismo modo

1. **La franja de arriba del front:**
   - `MOCK · no real APIs · in-memory data` (oro a rayas): los dos en mock;
   - `LIVE DEBUG · real APIs & real database` (rojo): los dos en live-debug;
   - `MODE MISMATCH · front=<f>, back=<b>` o `MODE MISMATCH · front=<f>, back unreachable or production` (marino): no coinciden, el back no responde o está en producción;
   - mientras pregunta al back por primera vez dice `Checking the back's mode · front=<f>` sobre bruma liso, porque nunca afirma un modo que el back no confirmó;
   - si al final lleva `· next scan injects: …`, hay un escenario armado para el próximo scan;
   - sin franja: el front está en producción.

   La franja vuelve a preguntar en cada cambio de página, al volver a la pestaña y cada 10 s, así que reiniciar el back en otro modo se ve sin recargar.
2. **El back mismo:**

   ```powershell
   Invoke-RestMethod http://127.0.0.1:8080/__debug/mode
   # o bien
   curl.exe -s http://127.0.0.1:8080/__debug/mode
   ```

   - Responde `mode`, `sourceMode`, `storageBackend`, `websiteEvidenceProvider`, `assessmentPlanner`, `signalLlmModel` e `inUse`.
   - Son los valores efectivos: en mock, `websiteEvidenceProvider: "mock"`, `signalLlmModel: null` e `inUse` todo en `false`, aunque el `.env.local` tenga todas las claves. `inUse` solo lleva booleanos, nunca valores.
   - En producción la ruta no existe: 404. Con `Invoke-RestMethod`, el 404 sale como error.
3. **El panel:** el botón `State` de la franja lo abre, y su fila "Back mode" muestra esa misma respuesta.

### 11.5 Volver a producción local

1. Para los procesos de debug con `Ctrl+C`.
2. Si pusiste a mano variables en esa terminal (las de modo, las del paso 5 o las de Supabase de la §11.7), quítalas:

   ```powershell
   Remove-Item Env:ARCA_MODE, Env:NEXT_PUBLIC_ARCA_MODE, Env:SOURCE_MODE, Env:STORAGE_BACKEND, Env:SUPABASE_URL, Env:SUPABASE_SECRET_KEY -ErrorAction SilentlyContinue
   ```

   Con `SOURCE_MODE` o `STORAGE_BACKEND` puestas, `live-debug` no arranca y producción local corre con lo que digan, no con el `.env.local`. Con las de Supabase, apunta a `Arca-dev` en vez de a lo que diga el `.env.local`.

3. Arranca en producción, con los dos a la vez:

   ```powershell
   cd C:\Users\jesus\projects\Arca-back
   npm run stack -- production
   ```

   O por separado: `npm run dev` en Arca-back y `npm run dev -- --webpack` en Arca-front.
4. Producción local usa el `.env.local` tal cual: hoy, APIs reales y Supabase, sin franja y sin rutas `/__debug`.
5. Para una producción local que no gasta nada (la combinación de CI, sin debug), solo en el back:

   ```powershell
   cd C:\Users\jesus\projects\Arca-back
   Remove-Item Env:ARCA_MODE -ErrorAction SilentlyContinue; $env:SOURCE_MODE = 'mock'; $env:STORAGE_BACKEND = 'memory'; npm run dev
   ```

   Es la que se usó en §12 (e).
6. Comprobación: `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8080/__debug/mode` devuelve `404`, y el front no muestra franja.

### 11.6 Smoke de navegador

Con `npm run stack -- mock` corriendo:

```powershell
cd C:\Users\jesus\projects\Arca-front
npm run test:browser:modes
```

- Corre los escenarios 1 a 4 y deja las capturas en `Arca-front\artifacts\modes\`.
- Cada escenario pulsa "Reset limits", que en mock también vacía la memoria del back: los scans hechos a mano en esa sesión desaparecen.
- Los escenarios con preajuste comprueban que la franja nombra el escenario armado y que el scan se lo lleva: después, la pestaña no guarda ninguno y la franja ya no lo nombra. El escenario 2 lanza además un segundo scan, que tiene que salir sin cabecera.
- El escenario 5 (desalineado) necesita el back parado. El front fija su URL de la API al compilar, así que no basta con apuntar el smoke a otro puerto. Se corre así:
  1. para el stack;
  2. arranca solo el front: `$env:NEXT_PUBLIC_API_URL = 'http://localhost:8080'; npm run dev:mock` en Arca-front;
  3. en otra terminal: `npm run test:browser:modes -- mismatch`.

### 11.7 Supabase separado para dev (recomendado; lo hace Jesús)

Con un proyecto propio, desaparecen los riesgos de compartir la base que lista la §10: la caché leída por producción, la reconciliación del ledger y `recoverInterrupted`.

1. En el panel de Supabase, crea el proyecto `Arca-dev`.
2. Aplícale las mismas migraciones de `supabase/migrations`:

   ```powershell
   cd C:\Users\jesus\projects\Arca-back
   supabase link --project-ref <ref-de-Arca-dev>
   npm run db:push
   ```

   `link` deja enlazado ese proyecto. Antes de la próxima migración de producción, enlaza otra vez el de producción con `supabase link --project-ref <ref-de-producción>`.
3. Para correr live-debug contra `Arca-dev`, pon su URL y su clave secreta solo en esa terminal. Ganan al `.env.local`, que no se edita. La clave se lee con `Read-Host -AsSecureString`, que no la muestra en pantalla y no la deja en el historial de PowerShell:

   ```powershell
   $env:SUPABASE_URL = 'https://<ref-de-Arca-dev>.supabase.co'
   $s = Read-Host -AsSecureString 'Arca-dev secret key'; $env:SUPABASE_SECRET_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   npm run stack -- live-debug
   ```

   - No escribas la clave en la línea de comandos: esta máquina usa PSReadLine 2.0.0, que guarda cada línea en texto plano en el historial, sin filtrar las que parecen secretas.
   - Si ya la escribiste así, bórrala del historial. `(Get-PSReadLineOption).HistorySavePath` dice dónde está el archivo (normalmente `ConsoleHost_history.txt`). Ábrelo, borra esa línea y guarda; después cierra la terminal, porque la sesión abierta la conserva en memoria.
4. Comprueba el destino en el panel de `Arca-dev`: la fila de un scan de prueba tiene que aparecer en su tabla `scans`. `/__debug/mode` no lo puede decir, porque solo informa `inUse.supabase: true`, nunca la URL.
5. OpenAI y Apify siguen siendo reales y gastan crédito. El ledger de Apify pasa a ser el de `Arca-dev`.

## 12. Verificaciones de seguridad realizadas

Hechas el 2026-10-23 en la máquina de Jesús (Windows 11, Node 22.19.0), sobre `feat/arca-modes`: back desde `395f1fe` y front desde `088645e`, más el commit de esta verificación. Las salidas están recortadas y no llevan ningún valor secreto.

Tras la revisión final de la rama se corrigieron los hallazgos F1 a F13 (back `87b224f`, front `16b6a2f` y `c6136da`), y se repitieron las verificaciones a las que afectan: la columna "Repetido" lo dice paso a paso.

### 12.1 Resumen

| Paso | Punto de §8 | Qué se comprobó | Repetido | Resultado |
|---|---|---|---|---|
| (a) | 1 a 8 | `npm run build && npm test` en Arca-back | sí | OK: 49 archivos, 501 tests |
| (b) | 11 | `npm test`, `npm run typecheck` y `npm run lint` en Arca-front | sí | OK: 23 archivos y 270 tests; typecheck limpio; lint con 0 errores y los 6 avisos previos |
| (c) | 9 | build de producción del front, sin modo, más búsqueda manual en `.next` | sí | OK: `0 debug leak(s)`; la búsqueda manual no encuentra nada |
| (d) | 10 | build con `VERCEL=1` y mock; build con un modo inválido | no: `next.config.ts` no cambió | OK: los dos fallan, con `local-only` y `is not a mode` |
| (e) | 1 | back en producción local (`SOURCE_MODE=mock`, `STORAGE_BACKEND=memory`, sin `ARCA_MODE`) | no; el preflight de producción lo fija un test, en (a) | OK: las tres rutas `/__debug` dan 404; el scan con cabecera de escenario es normal (202); el preflight no admite la cabecera |
| (f) | 2 | `ARCA_MODE=mock` (y `live-debug`) con `ARCA_DEPLOYMENT=aws` | no: `env.ts` no cambió | OK: el arranque falla |
| (g) | 7 | `netstat` con el stack en mock | sí | OK: el back solo en `127.0.0.1:8080` |
| (h) | 3 | test `mock-offline` | sí, dentro de (a) | OK: 0 intentos de red |
| (i) | — | arranque de live-debug, **sin ningún scan** | no: tocaría el Supabase compartido; la forma nueva la fija `compose.test.ts` | OK: banner `MODE=live-debug`; `/__debug/mode` responde |
| (j) | 1, 8 | stack en mock con el `.env.local` de Jesús: `/__debug/mode`, reset sin cabecera, preflight | nuevo | OK: valores efectivos (`mock`, `null`, `inUse` en `false`); reset sin cabecera → 400; el preflight admite las dos cabeceras de debug |
| (k) | — | frontera de imports del front: test `lint-boundary.test.mjs` y `npm run lint` | nuevo | OK: 15 tests; lint con 0 errores |
| (l) | — | marcador de despliegue: test `deploy-marker.test.ts` | nuevo, dentro de (a) | OK: `ARCA_DEPLOYMENT=aws` y ninguna clave `ARCA_MODE` |
| (m) | — | el script `build` del front lleva el chequeo de fugas y no hay `postbuild` | nuevo, dentro de (b) | OK |
| smoke | 12 | `npm run test:browser:modes`, escenarios 1 a 5 | sí | OK: 5 de 5, con las comprobaciones nuevas de la franja y del escenario de un solo uso |

Qué test cubre cada punto de §8 del back:
- **8.1:** `debug-mode.test.ts`, en "production wiring":
  - "registers no debug route";
  - "runs a scan that carries a scenario header as a normal scan";
  - "ignores a malformed scenario header instead of rejecting the scan";
  - "never admits the scenario header in CORS";
  - "never admits the debug request header in CORS either".
- **8.2:** `env.test.ts`, en el bloque `ARCA_MODE`:
  - producción por defecto;
  - un modo desconocido;
  - mock impone mock, memoria y reglas;
  - live-debug nunca impone;
  - live-debug conserva las comprobaciones de credenciales;
  - ningún modo de debug dentro de un despliegue.
- **8.3:** `mock-offline.test.ts` (paso h).
- **8.4:**
  - `debug-isolation.test.ts`: un scan aislado nunca toca el durable, y uno limpio sí;
  - `debug-mode.test.ts`: "a scan without a scenario still uses the durable repository and the cache".
- **8.5:**
  - `debug-mode.test.ts`: "injected scans never share an in-flight pipeline";
  - `debug-sources.test.ts`: "default directories drop the scan id so the ledger never points at an in-memory scan".
- **8.6:** `debug-sources.test.ts`, "apify_quota matches the real directory source at the usage limit". Compara con `ApifyDirectorySource` y un cliente que lanza `PROVIDER_QUOTA_EXCEEDED`.
- **8.7:** `env.test.ts` "listens on loopback only in debug modes", más el paso (g).
- **8.8:** `debug-mode.test.ts`, "/__debug/scan requires the scan token and never returns the email".

En el front, el punto **8.11** lo cubren estos tests:
- `client.test.ts`: "sends no scenario header in production, even with a scenario stored";
- `mode-check.test.ts`: un 404 es "absent", y un modo distinto nombra los dos;
- `StatePanel.test.tsx`: "never prints an email or a session token that a page published".

Protecciones añadidas en la revisión final, con su test:
- **La franja vuelve a preguntar (F1):** `DebugRoot.test.tsx`: un 404 da desalineado y `State` abre el panel; nueva pregunta al cambiar de página, al recuperar el foco, al volver a ser visible y cada 10 s (nunca oculta); el último estado confirmado se mantiene mientras una pregunta está en curso.
- **Escenario de un solo uso y visible (F2):** `bridge.test.ts` ("is one-shot"), `client.test.ts` ("sends the scenario with the next scan only"), `DebugRoot.test.tsx` (la franja nombra el escenario armado y lo suelta cuando un scan se lo lleva), `ModeBanner.test.tsx`, `page-state.test.tsx` (`/quote` publica `sentScenario`). Producción: `bridge.test.ts` comprueba que no lee, no borra y no informa nada.
- **`latency` fuera de mock (F3):** `debug-mode.test.ts`, "a leftover latency injects nothing in live-debug" y "live-debug stores an injected scenario without its latency"; en el front, `ScenarioControls.test.tsx` y `scenario.test.ts`.
- **`/__debug/mode` efectivo (F4):** `compose.test.ts`: mock con todas las claves → `mock`/`null`/todo `false`; live-debug con cada combinación de extracción y planner. El contrato rechaza proveedores desconocidos y la forma vieja con `configured` (`debug.test.ts`, `mode-check.test.ts`).
- **Reset (F5, F7):** `debug-mode.test.ts`, bloque "reset": en mock vacía límites y memoria; en live-debug solo límites; sin `X-Arca-Debug: 1` responde 400 y no vacía nada; el preflight de debug admite las dos cabeceras.
- **Assessments aislados tras un reset (F6):** `debug-isolation.test.ts`, "an isolated assessment never reaches durable storage, even after the overlay is wiped".
- **Franja neutra mientras comprueba (F8):** `ModeBanner.test.tsx`.
- **Estado por scan (F9):** `StatePanel.test.tsx` y `page-state.test.tsx`.
- **Marcador de despliegue (F10):** `deploy-marker.test.ts`.
- **Frontera de imports (F11):** `lint-boundary.test.mjs`.
- **Script `build` (F12):** `check-no-debug.test.mjs`, "the build script".

### 12.2 Salidas

**(a) Back completo.** `npm run build && npm test` en Arca-back, repetido sobre `87b224f`:

```
> tsc -b
 Test Files  49 passed (49)
      Tests  501 passed (501)
```

**(b) Front completo.** En Arca-front, repetido sobre `c6136da`:

```
npm test            → Test Files  23 passed (23) · Tests  270 passed (270)
npm run typecheck   → tsc --noEmit, sin errores
npm run lint        → ✖ 6 problems (0 errors, 6 warnings)
```

Los 6 avisos son los `react-hooks/set-state-in-effect` que ya existían: la página de assessment, la de resultados, AiGapSection, OceanPanel, ScoreGauge y useInView. La revisión final no añadió ninguno.

**(c) Build de producción del front, sin modo.**
- Se corrió con `Remove-Item Env:NEXT_PUBLIC_ARCA_MODE` antes de `npm run build`. El `build` es `next build && node scripts/check-no-debug.mjs`.

  ```
  ○ /quote  ○ /quote/scanning  ○ /score  ○ /assessment  ○ /assessment/results  …
  [check-no-debug] 0 debug leak(s) in the production build
  ```

- Búsqueda manual de `arca-debug-sentinel|__arcaDebug|/__debug/`:
  - `Select-String -Path .next\static\**\*.js -Pattern '…'`: 0 coincidencias en 24 archivos. En PowerShell 5.1, `**` vale lo mismo que `*`, así que esta forma baja un solo nivel.
  - La misma búsqueda recursiva, `Get-ChildItem .next\static -Recurse -Filter *.js | Select-String …`: 0 coincidencias en 24 archivos.
  - En todo el `.js` de `.next\static` y `.next\server`, añadiendo `x-arca-debug-scenario`, `LIVE DEBUG` y `MODE MISMATCH`: 0.
  - Control positivo: `Scan my firm` sí aparece en 1 archivo, así que la búsqueda recorre el código que se publica.
- Repetido tras la revisión final, con el front ya en `16b6a2f` (`c6136da` solo toca la configuración de ESLint y su test):

  ```
  ○ /assessment  ○ /assessment/results  ○ /quote  ○ /quote/scanning  ○ /score
  [check-no-debug] 0 debug leak(s) in the production build
  ```

  Búsqueda manual en todo el `.js` de `.next\static` y `.next\server`: 0 archivos para `arca-debug-sentinel`, `/__debug/`, `LIVE DEBUG`, `MODE MISMATCH`, `__arcaDebug`, `x-arca-debug` (sin distinguir mayúsculas, cubre la cabecera nueva `X-Arca-Debug`), `next scan injects`, `Nothing published for this scan` y `arca.debug.scenario`. Control positivo: `Scan my firm` aparece en 2 archivos.

**(d) Builds que deben fallar.**

```
$env:VERCEL='1'; $env:NEXT_PUBLIC_ARCA_MODE='mock'; npm run build      → exit 1
  Error: NEXT_PUBLIC_ARCA_MODE=mock is local-only and cannot build on Vercel
$env:NEXT_PUBLIC_ARCA_MODE='Mock'; npm run build                        → exit 1
  Error: NEXT_PUBLIC_ARCA_MODE="Mock" is not a mode; use one of production, live-debug, mock
```

**(e) Back en producción local.**
- Se arrancó así: `Remove-Item Env:ARCA_MODE; $env:SOURCE_MODE='mock'; $env:STORAGE_BACKEND='memory'; npm run dev`.
- El `.env.local` se carga igual, pero sus `live` y `supabase` pierden frente a las variables del shell.
- Las peticiones salieron de un script de Node que solo imprime estados, nunca el token.

```
[api] MODE=production sources=mock storage=memory
[api] listening on :: port 8080
curl.exe GET /__debug/mode -> 404
GET /__debug/mode -> 404
GET /__debug/scan/sc_x -> 404
POST /__debug/reset -> 404
OPTIONS /scan (requesting x-arca-debug-scenario) -> 204 | access-control-allow-headers: Content-Type,Authorization | allow-origin: http://localhost:3000
POST /scan with X-Arca-Debug-Scenario: {"website":"error","bar":"error","avvo":"error"} -> 202 RUNNING
POST /scan with X-Arca-Debug-Scenario: not-json -> 200 COMPLETED
scan started with every source "error" ended COMPLETED | sources: website=ok bar=ok avvo=ok
```

- La cabecera no se lee: el scan que pedía las tres fuentes caídas termina COMPLETED con las tres `ok`.
- Una cabecera que ni siquiera es JSON no da el 400 de los modos de debug. Ese 200 es la caché de dominio del primer scan.
- Producción escucha en todas las interfaces (`0.0.0.0:8080` y `[::]:8080`), igual que antes.

**(f) Marcador de despliegue.** Se arrancó la entrada de producción, `node apps/api/dist/server.js`, con `$env:ARCA_DEPLOYMENT='aws'`, el mismo valor que `deploy/production.env:13`:

```
ARCA_MODE=mock        → exit 1  Error: ARCA_MODE=mock cannot start while ARCA_DEPLOYMENT is set: a deployment only runs production
ARCA_MODE=live-debug  → exit 1  Error: ARCA_MODE=live-debug cannot start while ARCA_DEPLOYMENT is set: a deployment only runs production
```

**(g) Escucha en mock.** `netstat -ano`, con `npm run stack -- mock` corriendo:

```
TCP    0.0.0.0:3000     0.0.0.0:0   LISTENING   (front, next dev)
TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING   (back)
TCP    [::]:3000        [::]:0      LISTENING   (front, next dev)
```

- El back solo escucha en loopback.
- `next dev` escucha en todas las interfaces, como siempre; la §5.1 no lo cambia. Desde otra máquina, el panel llamaría a `localhost:8080` de esa máquina, no a este back.

**(h) Mock sin red.** `npx vitest run apps/api/tests/integration/mock-offline.test.ts --reporter=verbose`:

```
✓ mock mode with the network cut off > runs scan, poll, assessment, answers, complete and result without a single outbound attempt
✓ mock mode with the network cut off > records and refuses every kind of outbound attempt it traps
Tests  2 passed (2)
```

El primer test sustituye `fetch`, `net.connect` y `dns.lookup` por trampas que registran y lanzan error, y termina con `expect(attempts).toEqual([])`.

**(i) Live-debug, solo el arranque.** `npm run dev:live-debug` en Arca-back:
- No se lanzó ningún scan. El proceso se paró justo después de comprobarlo.
- Conectó al Supabase compartido e hizo la recuperación de arranque de siempre, sin errores.

```
[api] MODE=live-debug sources=live storage=supabase (debug routes on 127.0.0.1 only)
[api] listening on 127.0.0.1 port 8080
curl.exe -s http://127.0.0.1:8080/__debug/mode
{"mode":"live-debug","sourceMode":"live","storageBackend":"supabase","websiteEvidenceProvider":"agentic","assessmentPlanner":"rules","signalLlmModel":"gpt-6-luna","configured":{"openai":true,"apify":true,"supabase":true}}
TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING
```

- Esa respuesta es de antes de la revisión final, con el campo `configured`. No se repitió, porque el arranque de live-debug toca el Supabase compartido.
- Con esta configuración (extracción agéntica, planner por reglas), la respuesta ahora lleva `"inUse":{"openai":true,"apify":true,"supabase":true}` en lugar de `configured`. Lo fija `compose.test.ts`, "/__debug/mode in live-debug reports what compose built: the default agentic extraction".

**(j) Mock con claves reales en el `.env.local`.** Con `npm run stack -- mock` corriendo sobre `87b224f`/`16b6a2f`. El `.env.local` de Jesús tiene las claves de OpenAI, Apify y Supabase, y no se usan:

```
curl -s http://127.0.0.1:8080/__debug/mode
{"mode":"mock","sourceMode":"mock","storageBackend":"memory","websiteEvidenceProvider":"mock","assessmentPlanner":"rules","signalLlmModel":null,"inUse":{"openai":false,"apify":false,"supabase":false}}
curl -X POST http://127.0.0.1:8080/__debug/reset                      → 400
OPTIONS /__debug/reset (Origin http://localhost:3000, pide x-arca-debug) → 204 | access-control-allow-headers: Content-Type,Authorization,X-Arca-Debug-Scenario,X-Arca-Debug
```

`netstat -ano` con ese stack: `0.0.0.0:3000` y `[::]:3000` (front), `127.0.0.1:8080` (back), igual que en (g).

**Smoke de navegador (§8.12).**
- Usa el Chromium de Playwright de Arca-back contra los servidores reales.
- Cualquier petición a un host que no sea local (salvo las fuentes de Google) se bloquea y hace fallar el escenario. Un control negativo con `ARCA_FRONTEND_URL=http://example.com` falló los 4 escenarios con `requested hosts off this machine: example.com`.

Escenarios 1 a 4, con `npm run stack -- mock`, repetidos tras la revisión final (back `87b224f`, front `16b6a2f`):

```
  compositeScore 70.63 (layer 1 82, layer 2 65.75), tier FORTIFIED
PASS 1 happy path in mock
  status PARTIAL; bar error/PROVIDER_ERROR: Apify usage limit reached for the current billing cycle; lookups after it were not started
  one-shot: the second POST /scan carried no scenario header
PASS 2 preset "Apify out of credit"
PASS 3 preset "Every source down"
PASS 4 preset "Session expired"
4/4 scenario(s) passed; screenshots in C:\Users\jesus\projects\Arca-front\artifacts\modes
```

Qué comprueba cada escenario:
1. **Recorrido feliz:**
   - la franja dice MOCK;
   - "Reset limits" y "Fill mock firm" funcionan, y el `POST /scan` sale sin cabecera;
   - `/score` llega con `status: COMPLETED` en el panel;
   - "Refine your score" abre el assessment, que el panel muestra planificado;
   - "Auto-answer" deja respondidas todas las preguntas (`answered = total`) y recarga en el repaso;
   - "Attest & complete" lleva a `/assessment/results`, con `compositeScore` numérico en el panel y el mismo número en el indicador de la página.
2. **"Apify out of credit":**
   - antes de lanzar, la franja dice `MOCK · no real APIs · in-memory data · next scan injects: Bar apify_quota, Avvo apify_quota`;
   - la cabecera lleva `bar` y `avvo` en `apify_quota`;
   - después, la pestaña ya no guarda escenario, la franja vuelve a `MOCK · no real APIs · in-memory data` y `/quote` publicó ese escenario como `sentScenario`;
   - `/score` muestra el aviso de evidencia incompleta;
   - `sources.bar.reason` contiene "Apify usage limit reached";
   - un segundo scan desde la misma pestaña, sin elegir nada, sale sin cabecera.
3. **"Every source down":** la franja nombra las tres fuentes en `error`, la cabecera las lleva y `/quote/scanning` muestra "We couldn't finish your scan".
4. **"Session expired":**
   - la franja nombra `Polls unauthorized` y la cabecera lleva `http.poll: unauthorized`;
   - tras pasar por `/quote/scanning`, vuelve a `/quote`, donde ya no queda escenario armado;
   - el token rechazado ya no está en `sessionStorage`.

Escenario 5:
- Se paró el stack y se arrancó solo el front: `$env:NEXT_PUBLIC_API_URL='http://localhost:8080'; npm run dev:mock`. En `:8080` no quedó nada (`/health` → sin respuesta).
- Después: `npm run test:browser:modes -- mismatch`.

```
PASS 5 mode mismatch
1/1 scenario(s) passed; screenshots in C:\Users\jesus\projects\Arca-front\artifacts\modes
```

Repetido tras la revisión final, de la misma forma: `PASS 5 mode mismatch`, `1/1`.

- El smoke exige que el front haya pedido `http://localhost:8080/__debug/mode` y que esa petición fallara.
- Control negativo: con el back corriendo y `ARCA_API_URL=http://localhost:8099`, la franja siguió en MOCK y el escenario falló. Eso confirma que apuntar el smoke a un puerto vacío no basta: hay que parar el back.

### 12.3 Decisiones tomadas al implementar

- **El chequeo de fugas va dentro del script `build`** (`next build && node scripts/check-no-debug.mjs`), no en `postbuild`. El `~/.npmrc` de Jesús tiene `ignore-scripts=true`, que se salta los hooks `pre`/`post` sin avisar.
- **En los source maps solo se buscan las marcas exclusivas del debug:** el centinela, `/__debug/`, `LIVE DEBUG` y `MODE MISMATCH`. Los nombres del puente (`__arcaDebug` y `X-Arca-Debug-Scenario`) se omiten solo en los `.map`, porque los mapas del servidor guardan el fuente original de `bridge.ts`, que las páginas de producción importan. En el `.js` compilado se buscan todas.
- **`website: no_identity` termina PARTIAL, no FAILED.** Bar y Avvo quedan `skipped` (`INSUFFICIENT_IDENTITY`). El código real cuenta la web legible como fuente útil; la pantalla FAILED la da el preajuste "Every source down" (§5.3 ya corregida).
- **Gasto real dentro de un scan inyectado:** los directorios en `default` reservan en el ledger de Apify con `scanId` nulo (§5.5).
- **El escenario 5 del smoke se corre aparte, con el back parado.** El front fija su URL de la API al compilar, así que no se puede apuntar a un puerto vacío sin reiniciarlo.

Decisiones de la revisión final:
- **`configured` pasa a llamarse `inUse`.** El valor cambió de significado (un cliente construido, no una clave presente), así que el nombre viejo habría mentido. El cambio toca el contrato, `compose.ts`, sus tests y los del front. Un back que todavía mande la forma vieja es "absent" para el front nuevo, así que la franja dice MODE MISMATCH en vez de dar por bueno un modo.
- **`signalLlmModel`:** el modelo de la extracción si llama a OpenAI (la agéntica usa `SIGNAL_LLM_MODEL`; la de una pasada, su modelo fijo `gpt-4o-mini`); si no, el del planner `agent`; si no, `null`.
- **El escenario se gasta al enviarse, aunque el arranque falle** (429, 500 o red). Así un `http.start` inyectado tampoco se queda armado, y para repetir basta con volver a elegirlo. Si `sessionStorage` no deja borrarlo, no se envía: mejor ningún escenario que uno en cada scan.
- **La franja relee el escenario armado** al montar, en cada nueva pregunta al back, cada vez que una página publica (que es cuando un scan se lo lleva) y cuando lo cambian los controles del panel. Un valor que no entiende lo señala como `an unreadable scenario`, porque el puente lo enviaría igual y el back respondería 400.
- **Estado por scan:** con un `?scan` en la URL, el panel solo enseña el estado publicado para ese scan. `/quote` no tiene scan en la URL y enseña su último arranque. `/assessment/results` publica también su error.
- **Frontera de imports:** `no-restricted-imports` no mira `import()`, así que la frontera añade una regla `no-restricted-syntax` para las importaciones dinámicas. Los imports relativos se cubren cuando la ruta nombra `components/debug` o `lib/debug`, o es `./debug/…` desde un archivo de `components/` o `lib/`.

Ya no queda nada pendiente de esta verificación. Lo único que se había dejado abierto (en mock, `/__debug/mode` decía `agentic` y `gpt-6-luna`) quedó resuelto con `inUse` y los valores efectivos: ver (j).
