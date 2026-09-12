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
