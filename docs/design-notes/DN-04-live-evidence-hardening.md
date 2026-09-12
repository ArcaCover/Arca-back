# DN-04 — Endurecimiento de evidencia real antes del despliegue

Fecha: 12 de septiembre de 2026.

## Decisiones implementadas

- La identidad de firma se construye únicamente con evidencia estructurada. El dominio canónico no se
  transforma en nombre de firma.
- Sin firma ni abogados respaldados, las fuentes pagadas se omiten con `INSUFFICIENT_IDENTITY`.
- JSON-LD y `og:site_name` pueden acreditar identidad; los abogados requieren `Person` y un cargo legal.
- El bloqueo HTTP se conserva como `ACCESS_BLOCKED`, con sus incidencias en la evidencia cruda.
- `No lawyers matched` es una consulta exitosa vacía. Errores desconocidos y filas incompatibles se
  distinguen mediante `PROVIDER_ERROR` y `PROVIDER_CONTRACT_ERROR`.
- Cada ejecución Apify conserva actor, run ID, fingerprint, estado, registros, aceptados y coste reportado.
- Se consultan como máximo dos identidades por directorio y el cliente admite dos ejecuciones simultáneas.
  Cada run solicita como máximo siete registros al proveedor y Layer 1 acepta hasta dos coincidencias. Por
  construcción, un scan inicia como máximo cuatro runs de directorio y no reintenta runs pagados.
- Solicitudes simultáneas del mismo dominio comparten el trabajo externo; cada solicitud conserva su propio
  scan y sesión, y `meta.reusedEvidence` informa la reutilización.
- La falta de evidencia mantiene el score cuantitativo, pero marca `INSUFFICIENT_EVIDENCE` y bloquea la
  decisión automática con `UNKNOWN`. Overrides disciplinarios explícitos conservan precedencia.

## Extracción conservadora

El proveedor por reglas solo acredita uso o gobierno de IA cuando el texto vincula explícitamente a la firma
con esa conducta. Una mención de una herramienta, una frase aislada de revisión humana o el número de páginas
crawleadas no acreditan por sí solos una señal. Las afirmaciones positivas incluyen URL, fragmento y método
en `WebsiteData.provenance`.

## Persistencia

Los cambios viven dentro de los JSONB existentes de resultado y evidencia cruda. No requieren cambios al
esquema. Supabase continúa siendo la persistencia del modo desplegado y usa exclusivamente una clave secreta
del backend; `anon` y `authenticated` permanecen sin acceso directo.
