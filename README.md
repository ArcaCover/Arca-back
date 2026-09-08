# ARCA — Layer 1

Backend TypeScript que evalúa evidencia pública de una firma por dominio: website, Florida Bar y Avvo.
Implementa el handbook del 4 de septiembre de 2026 y las decisiones confirmadas por el usuario.
Las diferencias y sus motivos se concentran en [DN-01](docs/design-notes/DN-01-layer1-handbook-resolution.md).

## Ejecutar localmente

Requiere Node.js 22 y npm. Desde la raíz:

```powershell
npm ci
Copy-Item .env.example .env.local
# Asignar SESSION_TOKEN_SECRET en .env.local: un secreto aleatorio de al menos 32 caracteres.
npm run dev
```

`.env.example` activa `MOCK_MODE=true`: usa persistencia en memoria y fixtures locales,
sin credenciales externas ni llamadas pagadas. Datos y caché desaparecen al reiniciar.
Swagger está en http://localhost:8080/docs.

```powershell
$scan = Invoke-RestMethod http://localhost:8080/scan -Method Post -ContentType 'application/json' -Body '{"email":"owner@robust.arca.example"}'
Invoke-RestMethod "http://localhost:8080/scan/$($scan.scanId)" -Headers @{ Authorization = "Bearer $($scan.sessionToken)" }
```

| Dominio mock | Score | Resultado relevante |
| --- | --- | --- |
| robust.arca.example | 84 | FORTRESS |
| minimal.arca.example | 25 | EXPOSED; evidencia incompleta |
| sanctioned.arca.example | 74 | FORTIFIED; decisión REFERRAL_SENIOR por sanción reciente |

Los fixtures están en `apps/api/mocks`; la sanción reciente se fecha al cargar el escenario.

## Contrato HTTP

`Request → DomainResolution → Assessment`. `email` es obligatorio; `domain` es opcional.
Se prioriza el dominio explícito normalizado. En su ausencia, se intenta resolver el dominio
de un email corporativo. Se exige DNS público utilizable; esto no verifica propiedad.
Email personal sin dominio explícito, dominio inválido o resolución fallida producen
`canonicalDomain: null` y `assessment: null`, sin crear ni ejecutar un scan.
Una vez resuelta la identidad, el email no interviene en señales, score ni multipliers.

| Método | Ruta | Comportamiento |
| --- | --- | --- |
| POST | `/scan` | 202 RUNNING con scanId y sessionToken; 200 con assessment cacheado o UNRESOLVED sin assessment |
| GET | `/scan/:scanId` | Polling con Bearer JWT de 24 horas vinculado al scan y solicitante |
| GET | `/openapi.json` | Contrato generado OpenAPI 3.1 |
| GET | `/docs` | Swagger UI |
| GET | `/health` | Salud del proceso |

COMPLETED, PARTIAL y FAILED son terminales: detener polling en cualquiera.
El resultado separa `preScore.tier` de `preScore.decision`; los overrides solo restringen la decisión.
Los campos desconocidos siguen siendo null. Una categoría completamente desconocida tiene score null;
los parciales suman únicamente reglas evaluables y muestran estado y flags de cobertura.
`sources.status` indica éxito técnico, `dataStatus` indica presencia de datos.
La confianza HIGH/MEDIUM/LOW corresponde al número de fuentes técnicamente completas, no certifica veracidad.

La caché dura 24 horas por dominio canónico y solo reutiliza scans COMPLETED originales.
Cada reutilización crea un registro y token propios, conserva la fecha de evidencia y no renueva el TTL.
Los límites en memoria son 10 solicitudes por IP/hora y 3 por email/hora.

## Reglas

| Categoría | Máximo |
| --- | --- |
| AI Governance | 35 |
| Professional Standing | 30 |
| Reputation | 20 |
| Firm Maturity | 15 |

Firm Maturity concede hasta 3 puntos por cada uno: website robusto, privacidad de datos del cliente,
equipo detallado, firma con más de diez años y áreas consistentes. Se eliminó W10 (tipo de email).
Se mantienen las penalizaciones observables de las tablas y los límites por categoría.
Las áreas se normalizan y se comparan con Jaccard ≥0.8. Los directorios usan una muestra estable
de hasta 15 abogados; el denominador de consistencia es el número consultado.
Las fechas de sanción usan aniversarios de calendario, no años de 365 días.
Los multipliers permanecen en el resultado; desconocido devuelve 1.0 con `known: false`.
Su aplicación comercial queda señalada para revisión en DN-01.

## Fuentes reales y despliegue

Usar `MOCK_MODE=false`, configurar Supabase, OpenAI y Apify según `.env.example`, e instalar Chromium:

```powershell
npx playwright install chromium
npm run build
node apps/api/dist/server.js
```

Website: Playwright, máximo 20 páginas y profundidad 2; robots y resolución pública fijada al socket.
Extracción estructurada GPT-4o-mini, con caché del análisis por hash de contenido y versión.
Directorios: `scrapers_lat/florida-bar-lawyers-scraper` y `solidcode/avvo-scraper` mediante Apify.
Las respuestas originales disponibles se guardan con hash SHA-256 antes de devolver el resultado.
El pipeline reserva 5 segundos de sus 55 segundos para persistencia y cancela fuentes al agotar su plazo.
Si no puede persistir evidencia, el scan termina FAILED en vez de publicar un resultado sin respaldo.
La escritura de estado HTTP tiene además el timeout de Supabase de 5 segundos.
El servidor recupera scans RUNNING interrumpidos al arrancar y periódicamente.

El baseline `supabase/migrations/20260908151940_create_layer1.sql` crea `scans` y `scan_raw_data`
en una base vacía. Activa RLS, restringe acceso directo de anon/authenticated y concede acceso al service role.
No adapta una base con tablas antiguas. Para un Supabase local nuevo (requiere Docker):

```powershell
npx supabase start
npx supabase db reset --local
```

El Dockerfile incluye Node 22 y Chromium. Configurar variables en el proveedor al desplegar.
Mantener secretos solo en backend y CORS con orígenes exactos.
`TRUST_PROXY_HOPS=0` utiliza la conexión directa; configurar otro valor solo para una topología conocida
sin acceso directo que eluda el proxy. El rate limiter y la ejecución en proceso requieren una sola instancia;
escalar horizontalmente necesita almacenamiento compartido para límites y coordinación de trabajos.

## Validación

```powershell
npm run build
npm test
npm run test:coverage
```

Las pruebas cubren matemáticas, incertidumbre, identidad, sesiones, caché, límites, pipeline,
proveedores simulados, Chromium real con transporte de fixtures y el SQL/RLS en PostgreSQL embebido (PGlite).
La prueba de crawling necesita Chromium instalado. Los tests no consumen APIs pagadas.
El modo real, una base remota y el despliegue requieren validación con sus credenciales e infraestructura.
Los documentos históricos de `private` se conservan sin cambios.
