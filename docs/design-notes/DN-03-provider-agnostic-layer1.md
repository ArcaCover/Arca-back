# DN-03 — Layer 1 determinista y extracción desacoplada

Fecha: 12 de septiembre de 2026.

## Decisión

Layer 1 no depende conceptualmente de OpenAI. Su entrada es el DTO validado `Layer1Evidence`, que
contiene la identidad de firma usada para matching, evidencia estructurada de website, Florida Bar y Avvo,
estados técnicos de las fuentes y la
fecha de observación. Para las mismas entradas, Layer 1 produce el mismo matching, reglas, score,
overrides, tier y decisión.

El crawling, parsing y cualquier extracción semántica ocurren antes del límite de Layer 1:

```text
Fuentes públicas
      |
      v
Crawler / adapters / EvidenceProvider
      |
      v
Layer1Evidence DTO
      |
      v
Layer 1: matching -> reglas -> scoring -> overrides -> tier/decision
      |
      v
Resultado
```

## Contratos y componentes

- `Layer1Evidence` es el contrato entre adquisición y evaluación.
- `evaluateLayer1Evidence` es el punto de entrada determinista al núcleo.
- `EvidenceProvider<Input, Evidence>` abstrae la conversión de contenido en evidencia.
- `RuleBasedEvidenceProvider` es el proveedor predeterminado y no usa APIs de IA.
- `OpenAIEvidenceProvider` queda disponible como adaptador opcional.
- `WebsiteExtractionSource` compone crawler, caché y proveedor sin introducir esas dependencias en
  el núcleo de Layer 1.

## Configuración

`WEBSITE_EVIDENCE_PROVIDER=rules` es el valor predeterminado. El modo live exige Apify para los
directorios, pero no exige una clave de OpenAI. Únicamente `WEBSITE_EVIDENCE_PROVIDER=openai` requiere
`OPENAI_API_KEY`.

El proveedor por reglas es deliberadamente conservador: acredita únicamente señales positivas
explícitas y conserva como `null` aquello que no puede establecer. Se deberá ampliar con parsers
estructurados o entrada humana conforme aparezcan casos reales, sin cambiar el contrato del núcleo.

El endurecimiento posterior de identidad, proveedores y evidencia insuficiente se documenta en
[DN-04](DN-04-live-evidence-hardening.md) y prevalece para esos temas.

## Mismo resultado en cualquier orden (9 de noviembre de 2026)

«Las mismas entradas» incluye la misma evidencia entregada en otro orden. Antes no se cumplía: las
calificaciones 2.2, 9.1 y 9.7 promediaban 7 o 6.999999999999999 según el orden de suma (6 o 2 puntos
en A1), y una firma de siete abogados con promedio exacto de 8.0 alternaba entre 81 FORTRESS y
78 FORTIFIED. Reglas vigentes en `packages/scoring`:

- **Orden canónico en la frontera.** `evaluateLayer1Evidence` ordena los matches de Bar y Avvo por
  nombre buscado normalizado y luego por persona (número de colegiado, URL de perfil, nombre), y los
  candidatos de cada match por persona. `scoreEvidence` aplica el mismo orden. Se compara por unidades
  de código, no con `localeCompare`, para no depender del locale del proceso. Qué duplicado de una
  misma persona se descarta y qué consulta toma el cruce entre directorios dependen de ese orden fijo.
- **Promedios.** `mean` suma en orden ascendente y redondea a nueve decimales antes de comparar con
  un umbral. No cambia ninguna banda de [DN-01](DN-01-layer1-handbook-resolution.md): solo elimina el
  ruido de coma flotante.
- **Experiencia promedio.** `B4_avgExperience` se publica con un decimal para que el resultado no
  cambie cada día; la regla B4 sigue leyendo el promedio exacto, de modo que los umbrales reales de
  tres y diez años no se mueven.
- **Premio principal.** `A6_topAward` es el del abogado con más premios; el empate se resuelve por el
  texto del premio, nunca por la posición en la lista.
- **Listas del resultado.** Herramientas de IA (W2), alias, nombres de abogados y referencias de
  identidad, y `sources.*.providerRuns` (por `queryFingerprint`) salen ordenados. Las listas propias
  de una persona (premios, áreas de práctica, sanciones) conservan el orden del proveedor: el score
  no depende de él.
- **`PROVIDER_COST_UNKNOWN` deja de ser un flag.** Describía la ejecución y no a la firma: aparecía
  en un scan recién cobrado y desaparecía en uno servido desde la caché de Apify.
  `sources.*.accountingComplete` sigue informando la contabilidad pendiente.

`packages/scoring/tests/determinism.test.ts` lo prueba con permutaciones de semilla fija sobre varios
casos, incluidos los dos umbrales anteriores. Los resultados ya guardados en la caché de scans
conservan su forma anterior hasta que vencen.
