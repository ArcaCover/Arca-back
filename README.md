# ARCA — Layer 1

Backend TypeScript que evalúa evidencia pública estructurada de una firma por dominio: website, Florida Bar y Avvo.
Implementa el handbook del 4 de septiembre de 2026 y las decisiones confirmadas por el usuario.
Las diferencias y sus motivos se concentran en [DN-01](docs/design-notes/DN-01-layer1-handbook-resolution.md).

Layer 1 es determinista respecto a su DTO `Layer1Evidence`: normaliza, hace matching y aplica reglas,
scoring, overrides, tier y decisión sin conocer crawlers, prompts ni clientes de OpenAI. La extracción
de website ocurre antes de ese límite mediante un `EvidenceProvider`. El proveedor predeterminado es
`rules`; OpenAI se conserva como adaptador opcional. La decisión está documentada en
[DN-03](docs/design-notes/DN-03-provider-agnostic-layer1.md).

## Ejecutar localmente

Requiere Node.js 22 y npm. Desde la raíz:

```powershell
npm ci
Copy-Item .env.example .env.local
# Asignar SESSION_TOKEN_SECRET en .env.local: un secreto aleatorio de al menos 32 caracteres.
npm run dev
```

`.env.example` activa `SOURCE_MODE=mock` y `STORAGE_BACKEND=memory`: usa fixtures y persistencia local,
sin credenciales externas ni llamadas pagadas. Datos y caché desaparecen al reiniciar.
Swagger está en http://localhost:8080/docs.

Desde Swagger se puede ejecutar el flujo completo:

1. Ejecutar `POST /scan` con `email` y `domain`.
2. Si responde `202 RUNNING`, copiar `sessionToken`, usar **Authorize** con el Bearer token y consultar
   `GET /scan/{scanId}` hasta alcanzar un estado terminal.
3. Si el dominio está en caché, `POST /scan` responde directamente `200 COMPLETED`, `cached: true` y `result`.

Cada operación incluye ejemplos para inicio, cache hit, polling, resultado completo y errores.

```powershell
$scan = Invoke-RestMethod http://localhost:8080/scan -Method Post -ContentType 'application/json' -Body '{"email":"owner@robust.arca.example","domain":"robust.arca.example"}'
Invoke-RestMethod "http://localhost:8080/scan/$($scan.scanId)" -Headers @{ Authorization = "Bearer $($scan.sessionToken)" }
```

| Dominio mock | Score | Resultado relevante |
| --- | --- | --- |
| robust.arca.example | 82 | FORTRESS |
| minimal.arca.example | 25 | EXPOSED; evidencia incompleta |
| sanctioned.arca.example | 72 | FORTIFIED; decisión REFERRAL_SENIOR por sanción reciente |

Los fixtures están en `apps/api/mocks`; la sanción reciente se fecha al cargar el escenario.

## Contrato HTTP

`email` y `domain` son obligatorios. El dominio explícito se normaliza y debe resolver a un
destino público utilizable; esto no verifica propiedad. Una solicitud inválida o un dominio
que no pueda resolverse devuelve `400` y no crea ni ejecuta un scan.
Una vez resuelta la identidad, el email no interviene en señales, score ni multipliers.

| Método | Ruta | Comportamiento |
| --- | --- | --- |
| POST | `/scan` | 202 RUNNING con scanId y sessionToken; 200 con `result` cacheado y una sesión nueva |
| GET | `/scan/:scanId` | Polling con Bearer JWT de 24 horas vinculado al scan y solicitante |
| GET | `/openapi.json` | Contrato generado OpenAPI 3.1 |
| GET | `/docs` | Swagger UI |
| GET | `/health` | Salud del proceso |

COMPLETED, PARTIAL y FAILED son terminales: detener polling en cualquiera.
El resultado separa `preScore.tier` de `preScore.decision`; los overrides solo restringen la decisión.
Los campos y reglas desconocidos siguen siendo null, pero aportan cero puntos. Una categoría completamente
desconocida tiene score 0; los parciales suman únicamente reglas evaluables y muestran estado y flags de cobertura.
`sources.status` indica éxito técnico, `dataStatus` indica presencia de datos.
La confianza HIGH/MEDIUM/LOW corresponde al número de fuentes técnicamente completas, no certifica veracidad.
`preScore.assessmentStatus=INSUFFICIENT_EVIDENCE` bloquea la decisión comercial automática y devuelve
`decision=UNKNOWN`, salvo que evidencia disciplinaria conocida imponga una restricción explícita.

La caché dura 24 horas por dominio canónico y solo reutiliza scans COMPLETED originales.
Cada reutilización crea un registro y token propios, conserva la fecha de evidencia y no renueva el TTL.
La caché vive en PostgreSQL/Supabase usando `scans`; no requiere Redis ni archivos locales. La consulta
está respaldada por un índice parcial sobre dominio y fecha para scans COMPLETED no cacheados.
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
Las áreas se normalizan y se comparan con Jaccard ≥0.8. Los directorios consultan una muestra estable
de hasta dos identidades y cada actor devuelve como máximo siete candidatos; el denominador de consistencia
es el número de coincidencias aceptadas.
La identidad de firma debe proceder de evidencia del website; nunca se deriva del fragmento del dominio.
Sin nombre de firma ni abogados respaldados, Bar y Avvo se omiten con `INSUFFICIENT_IDENTITY` para evitar
consultas pagadas ambiguas. Un abogado solo se acepta por nombre completo exacto o por una coincidencia aproximada confirmada
con firma, county, dirección o teléfono. Una coincidencia fuzzy sin soporte se descarta como `no_match`.
Las fechas de sanción usan aniversarios de calendario, no años de 365 días.
Los multipliers permanecen en el resultado; desconocido devuelve 1.0 con `known: false`.
Su aplicación comercial queda señalada para revisión en DN-01.

## Fuentes reales y despliegue

Usar `SOURCE_MODE=live`, configurar Supabase y Apify según `.env.example`, e instalar Chromium:

```powershell
npx playwright install chromium
npm run build
node apps/api/dist/server.js
```

Website: Playwright, máximo 20 páginas y profundidad 2; robots y resolución pública fijada al socket.
La extracción estructurada usa reglas conservadoras por defecto, con caché por hash, proveedor y versión.
`WEBSITE_EVIDENCE_PROVIDER=openai` habilita opcionalmente GPT-4o-mini y exige `OPENAI_API_KEY`.
Directorios: `scrapers_lat/florida-bar-lawyers-scraper` y `scrapers_lat/avvo-lawyers-scraper` mediante Apify.
Cada scan consulta como máximo dos identidades, cuatro ejecuciones entre ambos directorios y dos actores
simultáneos. Cada ejecución solicita como máximo siete registros al actor y Layer 1 acepta como máximo dos
coincidencias. Run ID, fingerprint de consulta, conteos y coste reportado quedan junto a la evidencia.
Los mensajes conocidos de cero resultados son `EMPTY/NO_MATCH`; errores de actor o contrato permanecen errores.
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

El contenedor de producción usa Node 22, Chromium y un runtime no-root. La demo AWS usa una única EC2
con ECR, Elastic IP, SSM y Caddy; no crea load balancer. El procedimiento está en
[`AWS_DEMO_RUNBOOK`](docs/deployment/AWS_DEMO_RUNBOOK.md).
Mantener secretos solo en backend y CORS con orígenes exactos.
Los orígenes habilitados para la demo son `http://localhost:3000` y `https://arcacover.com`;
subdominios, otros puertos y variantes HTTP no se aceptan implícitamente.
`TRUST_PROXY_HOPS=0` utiliza la conexión directa; configurar otro valor solo para una topología conocida
sin acceso directo que eluda el proxy. El rate limiter y la ejecución en proceso requieren una sola instancia;
escalar horizontalmente necesita almacenamiento compartido para límites y coordinación de trabajos.

La especificación para reemplazar el contenedor prototipo y desplegar la demo está en
[DEMO_CONTAINERIZATION_SPEC](docs/deployment/DEMO_CONTAINERIZATION_SPEC.md).

## Validación

```powershell
npm run build
npm test
npm run test:coverage
```

Las pruebas cubren matemáticas, incertidumbre, identidad, sesiones, caché, límites, pipeline,
proveedores simulados, Chromium real con transporte de fixtures y el SQL/RLS en PostgreSQL embebido (PGlite).
La prueba de crawling necesita Chromium instalado. Los tests no consumen APIs pagadas.
El modo real, incluyendo la extracción por reglas y el despliegue, requiere validación con sus credenciales
e infraestructura. Supabase se valida directamente con `npm run db:verify`; el script escribe registros
sintéticos, comprueba evidencia/caché y elimina únicamente esos registros. El adaptador OpenAI no forma parte
de la validación inicial.
Los documentos históricos de `private` se conservan sin cambios.
