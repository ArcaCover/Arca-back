# ARCA — Score Engine API (Fase 1)

Backend del Score Engine de ARCA: recibe el dominio de una firma de abogados, corre el pipeline
de Capa 1, adapta el cuestionario de Capa 2 y devuelve score, tier, decisión de suscripción y
tres opciones de precio.

## Requisitos

- Node 20+
- [Supabase CLI](https://supabase.com/docs/guides/cli) para las migraciones
- Chromium de Playwright (solo para correr scans reales; los tests no lo necesitan)

## Levantar en local

```bash
npm install
npx playwright install chromium     # solo si vas a escanear dominios reales
cp .env.example .env.local          # completar SUPABASE_* y SESSION_TOKEN_SECRET
npm run dev
```

El servidor queda en `http://localhost:8080`. `GET /health` responde `{ "status": "ok" }`.

Las variables se validan al arrancar: si falta alguna, el proceso falla con el detalle de cuál.

## Migraciones

El schema se versiona en git. Nunca editar tablas desde el dashboard de Supabase.

```bash
npm run db:new nombre_de_la_migracion   # crea supabase/migrations/<timestamp>_nombre.sql
npm run db:push                         # aplica las pendientes
```

Las cuatro tablas de esta fase son `firms`, `leads`, `scans` y `assessments`. Todas quedan con
RLS habilitado y sin políticas: el backend entra con `SERVICE_ROLE_KEY` y `anon` no lee nada.
Cada migración lleva un `-- TODO RLS` con lo que falta definir antes de exponer el anon key.

## Tests

```bash
npm test                # toda la suite
npm run test:coverage   # cobertura de packages/scoring y packages/questions
```

No hay tests que salgan a internet: el flujo completo corre contra un sitio HTML servido en
`localhost` desde `apps/api/tests/fixtures/site.ts`.

## Endpoints

| Método | Ruta | Auth |
| --- | --- | --- |
| `POST` | `/api/v1/scan` | pública, con rate limit de 5/min y 20/hora por IP |
| `GET` | `/api/v1/scan/{scan_id}` | `Authorization: Bearer <session_token>` |
| `GET` | `/api/v1/assessment/{scan_id}/questions` | `Authorization: Bearer <session_token>` |
| `POST` | `/api/v1/assessment/{scan_id}/submit` | `Authorization: Bearer <session_token>` |

`POST /scan` devuelve un `session_token` (JWT HS256, 24h) que contiene solo el `scan_id`. Los
demás endpoints lo exigen y verifican que corresponda al scan de la ruta: un token válido de otro
scan devuelve 401.

## Estructura

```
packages/scoring/      función pura de scoring y pricing — sin I/O, sin reloj, sin red
packages/questions/    banco de preguntas + lógica adaptativa, también pura
packages/contracts/    tipos Zod compartidos y los dos puertos (Layer1Pipeline, MemoryStore)
apps/api/              handlers HTTP, pipeline de Capa 1 y repositorios de Supabase
supabase/migrations/   schema versionado
```

`packages/scoring` no importa nada del resto: se puede ejecutar con un objeto de respuestas y
devuelve siempre lo mismo. Ahí vive la fórmula de prima, así que cualquier cambio necesita su test.

## Los dos puertos

Toda la parte de agentes y de memoria vive detrás de una interfaz. Hoy hay una sola
implementación de cada una, y las dos están pensadas para poder salir del proceso sin tocar
handlers ni scoring.

### `Layer1Pipeline` → posible servicio HTTP

```ts
interface Layer1Pipeline {
  run(input: { domain: string; scan_id?: string }): Promise<Layer1Result>;
}
```

Implementación actual: `InProcessPipeline` (`apps/api/src/pipeline/`), que hace scraping con
Playwright, análisis por keywords, DNS y fingerprinting de tech stack dentro del mismo proceso.

`Layer1Result` es un objeto plano validado con Zod: sin clases, sin `Date`, sin funciones. Eso es
a propósito — es exactamente lo que viajaría como body de un POST.

**Para mover el pipeline a un servicio aparte (por ejemplo, Python):**

1. Agregar `HttpPipeline implements Layer1Pipeline` que haga `POST /run` al servicio y valide la
   respuesta con `Layer1Result.parse()`.
2. Cambiar qué implementación se instancia en `apps/api/src/server.ts`.
3. Nada más. Los handlers reciben `Layer1Pipeline` por constructor y el scoring nunca vio el
   pipeline.

El servicio remoto tiene que devolver el mismo shape que valida `Layer1Result`; el `parse()` en el
borde es lo que evita que una diferencia de contrato se filtre al scoring.

### `MemoryStore` → MongoDB

```ts
interface MemoryStore {
  saveEvidence(scanId: string, items: EvidenceItem[]): Promise<void>;
  saveRunRecord(scanId: string, record: RunRecord): Promise<void>;
}
```

Implementación actual: `NoopMemoryStore`, que loguea a stdout en desarrollo y no persiste nada.
El pipeline ya llama a los dos métodos en los puntos correctos: la evidencia cruda del scraping y
del DNS después de recolectarla, y el run record al cerrar el scan.

**Para conectar el Memory System cuando esté definido el diseño de Mongo:**

1. Agregar el driver y `MongoMemoryStore implements MemoryStore`.
2. Instanciarlo en `apps/api/src/server.ts` y pasarlo al pipeline, que lo recibe inyectado.
3. Nada más.

`EvidenceItem` y `RunRecord` también son JSON plano (los timestamps son strings ISO), así que
sirven igual para Mongo que para un servicio HTTP intermedio.

No hay ningún dato de memoria escrito en Supabase ni ninguna dependencia de MongoDB en el
`package.json`. Esa separación es la que hace que conectar Mongo después sea un archivo nuevo y
no una migración de datos.

## Fuera de alcance en esta fase

Auth de usuarios, magic links, Stripe, endpoints de broker/admin/partnership, organizaciones,
generación de PDF, RAG, change detection, scrapers de bar associations y dashboard. El bar check
devuelve `bar_verified: false` con `bar_check: "manual_pending"` y sus 8 puntos no entran al
máximo posible del pre-score.
