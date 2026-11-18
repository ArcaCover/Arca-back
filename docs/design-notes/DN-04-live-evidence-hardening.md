# DN-04 — Endurecimiento de evidencia real antes del despliegue

Fecha: 12 de septiembre de 2026.

## Decisiones implementadas

- La identidad de firma se construye únicamente con evidencia estructurada. El dominio canónico no se
  transforma en nombre de firma.
- Sin firma ni abogados respaldados, las fuentes pagadas se omiten con `INSUFFICIENT_IDENTITY`.
- JSON-LD y `og:site_name` pueden acreditar identidad; los abogados requieren `Person` y un cargo legal.
- El bloqueo HTTP se conserva como `ACCESS_BLOCKED`, con sus incidencias en la evidencia cruda.
  **Actualización 2026-11-09 (DN-12):** una web que se niega a ser leída (`ACCESS_BLOCKED`: robots.txt excluye el
  sitio, 401/403 o página de desafío) ya no hace fallar el scan. Termina PARTIAL con el resultado completo, el flag
  `WEBSITE_UNAVAILABLE` y un override que restringe la decisión a `REFERRAL_SENIOR`. Las fuentes pagadas se siguen
  omitiendo: sin web no hay identidad, y el dominio sigue sin convertirse en nombre de firma. Un fallo transitorio o
  nuestro (plazo, red, 429, 5xx, proveedor) sigue terminando FAILED.
- `No lawyers matched` es una consulta exitosa vacía. Errores desconocidos y filas incompatibles se
  distinguen mediante `PROVIDER_ERROR` y `PROVIDER_CONTRACT_ERROR`.
- Cada ejecución Apify conserva actor, run ID, fingerprint, estado, registros, aceptados y coste reportado.
- Se consulta todo el roster verificado, con hasta dos ejecuciones remotas simultáneas. Las búsquedas nominales
  tienen límites de resultados configurables; el fallback de firma conserva el roster completo. El presupuesto
  monetario, la reserva atómica y la caché por fingerprint de DN-06 limitan el gasto sin convertir una muestra
  en cobertura completa. Un run pagado nunca se reintenta a ciegas.
- Solicitudes simultáneas del mismo dominio comparten el trabajo externo; cada solicitud conserva su propio
  scan y sesión, y `meta.reusedEvidence` informa la reutilización.
- La falta de evidencia mantiene el score cuantitativo, pero marca `INSUFFICIENT_EVIDENCE` y bloquea la
  decisión automática con `UNKNOWN`. Overrides disciplinarios explícitos conservan precedencia.
  Desde el 2026-11-09 hay un override que no es disciplinario, `WEBSITE_UNAVAILABLE` (DN-12). Como los demás, solo
  restringe: nunca afloja un `DECLINE`.

## Extracción conservadora

El proveedor por reglas solo acredita uso o gobierno de IA cuando el texto vincula explícitamente a la firma
con esa conducta. Una mención de una herramienta, una frase aislada de revisión humana o el número de páginas
crawleadas no acreditan por sí solos una señal. Las afirmaciones positivas incluyen URL, fragmento y método
en `WebsiteData.provenance`.

## Persistencia

Los cambios viven dentro de los JSONB existentes de resultado y evidencia cruda. No requieren cambios al
esquema. Supabase continúa siendo la persistencia del modo desplegado y usa exclusivamente una clave secreta
del backend; `anon` y `authenticated` permanecen sin acceso directo.
