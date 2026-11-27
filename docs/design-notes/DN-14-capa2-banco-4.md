# DN-14 — Capa 2, banco 4.0: reglas de underwriting y tres entornos

Fecha: 2026-11-27. Estado: implementado en `feat/layer2-v4` (back y front), pendiente de revisión antes de `main`.

Fuente: los tres archivos del founder (`arca-capa2-uw-rules.md`, `capa2_config.json` 1.0.0 y `validate_capa2.py`). No se
recibió el final de su mensaje ("Qué necesito que hagas") ni sus respuestas a las preguntas pendientes, así que Jesús
pidió decidir con dos criterios: **que el score sea más fiable** (determinista, verificable y sin datos inventados) y que
el motor **sirva para distintos usos** (web, broker, un chat futuro, repetir el cálculo con otra configuración).

## 1. Qué se construyó

- **Motor** en `packages/questions/src/underwriting/`, que se exporta como `underwriting` desde `@arca/questions`. Es una
  función pura: recibe el resultado de la Capa 1, los IDs de opción y el config, y devuelve el output del §15 del spec.
  Hace la clasificación P0–P4, la selección con tope de 10, los puntos por categoría, la confianza (que solo baja), los
  knockouts, la exposición E1–E4, el orden de decisión, la prima por unidades de exposición, la auditoría y el resumen
  para el underwriter.
- **Config 1.1.0** (`config.ts`): es el 1.0.0 del founder con los huecos rellenados (§3). No cambia ninguna cifra del
  1.0.0. Cada assessment congela el config en `bank_snapshot`, así que cualquier assessment se puede repetir.
- **Validador**: `validateConfig()` es un port a TypeScript de `validate_capa2.py`. El original está en
  `tools/underwriting/`, y una prueba corre los dos sobre el mismo config y compara sus cifras:
  - preguntas por perfil: 7/10/10/10/10;
  - mejores casos: 43/40/43/44/48 en AIDG;
  - suelos: 57–60.
- **Precio**: los dos ejemplos del §14 dan $10,855 (unos $11,941 con confianza MEDIUM) y $218,347.
- **API**: `ASSESSMENT_ENGINE=underwriting` es el valor por defecto (`demo` vuelve al banco anterior).
  - Una assessment 4.0 nace `READY`, sin paso de planificación.
  - Un cambio en G1 o G2 invalida, con su evento, las respuestas que dejan de preguntarse.
  - Caben en las tablas actuales: sin migración.
- **Contratos 0.6.0** (publicados como pre-release `contracts-v0.6.0-dev.1`):
  - `AssessmentResult` es una unión del resultado 4.0 (`UnderwritingResult`) y el anterior (`LegacyAssessmentResult`).
  - `AnswerValue` admite `text`.
  - `DomainKey` añade las tres categorías y `firm_profile`.
  - Layer 1 v3.
- **Front**:
  - `/assessment/results` lee los dos tipos de resultado; el componente `UnderwritingOutcome` muestra la cotización
    con su selector de límite, o la agenda o el rechazo, sin cifras.
  - `/score` marca Reputation como contexto.
  - La tarjeta de pregunta admite la respuesta abierta.

## 2. Decisiones de producto

1. **El Pre-Score también pasa a 3 categorías.** AI Governance 40, Professional Standing 35 y Firm Maturity 25 se
   reescalan desde 35/30/15. Reputation se sigue mostrando con `scored: false` y no suma.
   - Los máximos viven solo en el config, que leen las dos capas.
   - Cada regla de la Capa 1 conserva sus puntos originales; solo se mueven la puntuación y el máximo de la categoría.
   - Los scans viejos (v2) siguen siendo legibles, y el motor los reescala igual (`score / max × nuevo máximo`).
   - Ejemplos: el mock robusto pasa de 82 a 86,29; el `minimal` pasa de 25 a 24,83, y su tier de Pre-Score pasa a
     CRITICAL.
2. **Botones, no chat.** El motor solo recibe IDs de opción, así que un chat futuro, o un broker rellenando por el
   cliente, entran por la misma puerta sin cambiar el motor.
3. **El resumen para el underwriter sale de una plantilla**, sin IA: se escribe desde la auditoría, así que los mismos
   datos dan las mismas palabras.
4. **El config vive en el repo, versionado, y nunca se edita en su sitio.**
   - Cada assessment guarda los IDs de opción y la versión del config, así que "¿qué habría pasado con el umbral en
     68?" se responde repitiendo los assessments reales.
   - Mover el config a la base, para cambiarlo sin desplegar, queda para cuando se recalibre a menudo.
5. **Precio visible con aviso.**
   - Sale la prima con "Indicative estimate, not an offer of insurance.".
   - Hay un selector de límite de $250K a $5M, con $1M por defecto.
   - Todas las primas las calcula el back; el front no calcula nada, solo cambia entre las primas ya calculadas.
   - El enlace de agenda es `UNDERWRITING_BOOKING_URL`, por defecto el Calendly de discovery.
   - Esta prima va aparte de la suscripción a la app, y no hay botón de compra del seguro porque no hay carrier.
   - `/score` sigue sin mencionar precios; una prueba lo exige.
6. **Una restricción de la Capa 1 sigue limitando el resultado.** Una restricción del Bar funciona como un knockout más.
   Un DECLINE de la Capa 1 pasa a senior referral, porque según el §5 la única declinación automática es la del suelo
   de score.

## 3. Huecos del spec que se rellenaron

7. **Opciones de G1, G2, F1 y F2**: se tomaron literalmente del texto del documento.
   - "None of these", "Nowhere" y "Not sure" no se combinan con otras opciones.
   - La clasificación sigue la tabla y el desempate del §7.
8. **F1 a número.**
   - La banda de tamaño sale del rango, porque los cortes coinciden con las bandas.
   - Para el precio se usa el punto medio: 1, 4, 11, 23, 53, 113 y 150. "Más de 150" cuenta como 150 y se marca como
     valor mínimo.
   - Si la Capa 1 vio más abogados que el máximo del rango, se usa la cifra de la Capa 1 y se registra la contradicción.
9. **Área → pregunta de área** (`area_question` del config).
   - Commercial litigation, securities, employment y bankruptcy usan E-litigation.
   - PI y medmal usan E-medmal-pi.
   - Corporate, real estate, tax, consumer y cualquier otra usan E-other.
   - El área principal es la de mayor factor (§14 C).
10. **Orden de selección: manda el config.** Se queda la guía escrita (P3-3) y cae la pregunta de área cuando una P3
    llega al tope.
11. **"Pasar a un humano".**
    - Un "Not sure" en C1 o en C2 lleva a agenda, justo después de los knockouts.
    - La respuesta abierta de E-other solo va al resumen.
    - Un assessment abandonado queda como `completed: false` y lleva a agenda.
12. **C1 con varias casillas**: se aplica la penalización más grave, no la suma, porque las casillas se solapan y una
    reclamación contaría dos veces. Si saltan varios knockouts, gana el más severo.
13. **"Contradice a la Capa 1"** (baja la confianza un nivel) solo cuenta en dos casos:
    - una herramienta que la Capa 1 nombró en la web y cuya categoría la firma no marca en G1;
    - un tamaño de F1 menor que los abogados que vio la Capa 1.

    Si la Capa 1 vio herramientas y la firma dice "None of these", la confianza pasa a LOW, como dice el spec.

## 4. Decisiones que surgieron al programar

14. **Caché de scans**: un scan solo se reutiliza con el mismo contrato y la misma `meta.scoringVersion`
    (`LAYER1_SCORING_VERSION`). Así un cambio de reglas nunca sirve un score viejo durante 7 días; es lo que pasó con
    lemonlaw.
15. **Assessments viejos**: se siguen leyendo con su forma y sus 6 dominios. Los que estaban a medias continúan con el
    banco con el que empezaron.
16. **Tope que tira una pregunta con opción de knockout**: cuenta como "knockout question dropped" y manda a REFERRAL.
    Pasa en P4 con el Bar fallido (cae DG-1) y en P3 o P4 sin áreas y con el Bar fallido. El spec dice que el tope nunca
    justifica vincular lo que no se terminó de evaluar.
17. **Redactar sin plataforma de casos**: G2 "drafting" sin "case management" en G1 es P3. Es trabajo legal hecho con
    una herramienta general, y el P2 del spec exige plataforma.
18. **Automatización solo de billing o marketing**, o herramientas marcadas en G1 con "Nowhere" en G2: van a P2, el
    perfil por defecto del spec.
19. **Plan de acción**: incluye todas las respuestas que perdieron puntos, con la ganancia real de score.
    - Esa ganancia es 0 cuando la Capa 1 ya llena la categoría; la pantalla no muestra la insignia "+0".
    - El §10 suma la Capa 1 y la Capa 2 con tope por categoría, así que en una firma con mucha evidencia pública las
      respuestas buenas no suben la categoría, pero las malas sí la bajan.
20. **Lo que recibe la firma** no lleva `audit` ni `underwriterSummary`; se guardan en el registro. Los modos de
    depuración sí los devuelven, para el panel State.
21. **Web ilegible** (DN-12 §14):
    - No hay número de Capa 1 (`layer1Score: null`, flag `LAYER1_UNAVAILABLE`).
    - La Capa 1 llega con confianza LOW, así que el resultado es agenda, no cotización.
    - El premio P0 queda como no verificado (+16) y baja la confianza.

## 5. Tres entornos

Decidido por Jesús:

| Entorno | Rama | Modo | Contraseña |
|---|---|---|---|
| Producción | `main` | production | no |
| Pilot | `pilot` | live-debug | sí |
| Dev | `dev` | demo | sí |

- **Producción** usa la base Supabase "Arca-base".
- **Pilot**:
  - Su back corre en el mismo EC2, con Postgres y PostgREST locales en lugar de Supabase. MySQL no sirve: el back
    habla PostgREST y usa funciones plpgsql.
  - Las cuentas son simuladas.
  - La API exige un token de acceso.
- **Dev** no tiene back: el front responde desde una grabación del mock.

Detalle y estado en `docs/deployment/ENVIRONMENTS.md`.
