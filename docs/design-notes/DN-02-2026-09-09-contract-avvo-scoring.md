# DN-02 — Contrato HTTP, Avvo y scoring del 9 de septiembre

Referencia: `Arca - Capa 1 - Jesús (1).html`. Para Avvo prevalece el bloque fechado el 9 de
septiembre de 2026 sobre el bloque anterior duplicado.

## Aplicado

- `POST /scan` exige `email` y `domain` y devuelve `202` con `scanId`, `sessionToken` y `status`.
- El polling terminal devuelve `result`; el resultado incluye `scanId`, `domain` y `email`.
- Avvo usa `scrapers_lat/avvo-lawyers-scraper` con `searchQueries`, `cities: ["Miami, FL"]`,
  `withDetails: true` y su máximo técnico documentado de 100,000 resultados; el roster no se recorta y
  el dataset de Apify se pagina hasta agotarse.
- El adaptador consume rating, reviews, awards, disciplina y campos de cross-reference del actor nuevo.
- Reputation elimina A5, asigna 9/6/2/-5 por rating, hasta 5 por reviews y 6 por awards.
- Una investigación regulatoria activa fuerza score 0, decisión DECLINE y tier cuantitativo CRITICAL.
- La ausencia total de evidencia produce score 0 con confianza LOW; los campos desconocidos siguen null.
- La caché de resultados se identifica exclusivamente por dominio canónico y permanece en PostgreSQL/Supabase.
  Se reutiliza `scans` y su índice parcial; no se agrega Redis ni caché en archivos para la demo.
- Un match de abogado se acepta únicamente si el nombre completo es exacto o si la aproximación queda
  respaldada por firma, county, dirección o teléfono. Sin soporte inequívoco se devuelve `no_match`.
- Si el website no entrega abogados se conserva el fallback por nombre de firma.
- El escenario mock mínimo debe permanecer de forma general en el rango 20–35; actualmente produce 25.
- W10 permanece excluido porque el score y la caché deben depender del dominio, no del email solicitante.
- En `POST /scan`, un miss de caché devuelve `202 RUNNING`; un hit de dominio dentro de 24 horas devuelve
  `200 COMPLETED`, `cached: true`, el resultado inmediato y una nueva sesión vinculada a la solicitud.

## Standby por ambigüedad

- Si REFERRAL y REFERRAL_SENIOR deben modificar `tier` o únicamente `decision`.
