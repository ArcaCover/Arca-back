# Informe E2E — Duque Immigration y Gallardo Law Firm

Fecha de ejecución: 2026-09-15 UTC
Modelo: `gpt-5.6-luna` con `reasoning_effort=low`
Modalidad: crawl nuevo, repositorio en memoria nuevo por dominio y llamadas nuevas a OpenAI/Apify.

## Resumen

| Firma | Estado | Duración | Resultado | Costo Apify |
|---|---:|---:|---|---:|
| duqueimmigration.com | FAILED | 1m 48.6s | score 0, decisión UNKNOWN, evidencia insuficiente | USD 0.0000 |
| gallardolawyers.com | PARTIAL | 7m 13.2s | score 11, tier CRITICAL, decisión UNKNOWN, evidencia insuficiente | USD 2.1375 |

## Duque Immigration

- El crawl recuperó 20 entradas, correspondientes a 18 URLs únicas. Dos URLs se procesaron dos veces.
- La extracción de identidad con OpenAI falló después del crawl.
- El error quedó clasificado como `PROVIDER_ERROR`, pero la excepción y los intentos parciales no fueron persistidos. Por eso no se puede distinguir con estos artefactos entre error de API, parseo o validación.
- Al no existir identidad verificada, Florida Bar y Avvo se omitieron correctamente. No hubo costo Apify.

## Gallardo Law Firm

### Website y OpenAI

- Se extrajeron correctamente nombre, ciudad, teléfono, año de fundación y los 25 abogados del roster de referencia.
- Evaluación contra el gold set: 29 correctos, 0 incorrectos, recall de abogados 100%.
- Quedaron ausentes `team_size` y `practice_areas`; las señales de gobierno de IA y privacidad quedaron desconocidas.
- Se hicieron 12 llamadas al modelo: 84,628 tokens de entrada, 17,264 de salida y 101,892 totales. Hubo 8,956 tokens de entrada cacheados.
- Las llamadas al modelo acumularon 155.3s. No fue necesaria ninguna reparación de JSON.

### Florida Bar

- 25 búsquedas, 31 candidatos válidos, 3 perfiles aceptados y costo reportado de USD 0.
- Aceptados: Carmen Gallardo, Ismael Jose Labrador y Leisy Jiménez; los tres activos.
- La respuesta cruda contiene 13 perfiles con vínculo fuerte a la firma mediante dirección, teléfono o dominio de email. El reconciliador retuvo solo 3.
- La causa principal está en el código: `parseBar` usa `mailAddress` como calle aunque el actor entrega `mailStreet`. El prefijo con nombre/firma crea una contradicción artificial. La comparación estricta de nombres también descarta nombres con segundo apellido, inicial, sufijo o alias duplicado.

### Avvo

- 25 búsquedas, 198 candidatos válidos, 5 perfiles aceptados.
- Aceptados: Amanda Hernandez, Dianelys Cala, Dianet Torres, Ismael Jose Labrador y Yiana Arenal. Todos coinciden con la dirección y teléfono de Gallardo.
- 17 de 25 búsquedas llegaron al máximo configurado de 10 resultados, por lo que la fuente quedó `PARTIAL/TRUNCATED`.
- Costo total: USD 2.1375; costo contable por aceptado: USD 0.4275.
- Solo 7 runs tuvieron costo mayor que cero. De ellos, uno produjo un aceptado. USD 1.9665, equivalente al 92% del gasto, se destinó a búsquedas sin match aceptado.

## Resultado funcional

El pipeline se comportó de forma conservadora y no emitió una decisión comercial con evidencia incompleta. La optimización de contabilidad y límites funcionó: todos los runs tienen costo completo, build real y atribución al scan. La cobertura todavía no es suficiente para producción: Duque pierde el error del proveedor y Gallardo muestra falsos negativos del reconciliador y un patrón costoso de búsquedas amplias en Avvo.

## Correcciones prioritarias reveladas por la prueba

1. Persistir excepción, fase e intentos parciales de OpenAI para poder diagnosticar y reintentar Duque desde el mismo crawl.
2. Corregir Florida Bar para usar `mailStreet`, normalizar sufijos/alias y ponderar dirección, teléfono y email antes de descartar un candidato.
3. Ejecutar Avvo en una segunda etapa sobre los abogados que sigan sin evidencia suficiente y reducir el límite por consulta; los runs que llegan al cap deben refinar la consulta antes de ampliar resultados.
4. Deduplicar URLs canonizadas antes de consumir el límite de páginas del crawl.

## Artefactos

- `output/integrated/duqueimmigration.com-2026-09-15T00-09-37-935Z/`
- `output/integrated/gallardolawyers.com-2026-09-15T00-11-26-608Z/`
- Análisis offline: `output/diag/analyze-e2e-results.json`

## Adenda: reconciliación corregida sobre los mismos datos

Después del E2E se corrigió la reconciliación de nombres y contexto. No se hicieron nuevas llamadas a OpenAI ni Apify para esta comprobación; se volvieron a procesar los artefactos crudos de Gallardo.

El caso de control fue Briana Mauri. El roster del sitio usa ese nombre abreviado, mientras que Bar y Avvo devolvieron `Briana Nicole Mauri`. Ambos perfiles comparten nombre completo, dirección y año de admisión. La lógica anterior descartaba cada candidato antes de permitir que una fuente corroborara a la otra. La nueva lógica conserva el candidato compatible y lo acepta como `cross_ref` cuando ambas fuentes coinciden en identidad y al menos una señal adicional.

| Fuente | Aceptados en el E2E | Aceptados con parsing corregido | Resultado final con corroboración cruzada |
|---|---:|---:|---:|
| Florida Bar | 3/25 | 14/25 | 21/25 |
| Avvo | 5/25 | 13/25 | 21/25 |

También se corrigieron `mailStreet`, nombres repetidos, segundos nombres, iniciales, sufijos, apellidos compuestos, variantes de la firma y valores de relleno como `Not Available`. Las coincidencias flexibles todavía requieren dos señales, por lo que cuatro integrantes permanecen sin match seguro: Christopher Rivera, Lorena Gaona Krewson, Mariangeli Mercado y Nelson Vladimir Jaramillo.

Esta repetición tuvo costo adicional de USD 0 y no cambia los costos ni tiempos medidos durante el E2E original. Su objetivo fue aislar el efecto del código de matching sobre la misma evidencia. La cobertura y el costo con respuestas actuales de los actores deben confirmarse en un canario posterior.
