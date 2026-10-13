# DN-07 — Capa 2: cuestionario adaptativo

Fecha: 8 de octubre de 2026. Estado: **propuesta para revisión**. Nada implementado.

Este documento junta en un solo sitio el banco de preguntas, el agente que arma el cuestionario,
los contratos, los endpoints, el modelo de datos y las vistas del frontend. Las **reglas de
negocio** (qué se pregunta, cuánto vale cada respuesta y qué límites tiene el producto) son de
Juan José: aquí solo se define la **estructura** que las contiene y el motor que las ejecuta.
Los ejemplos de preguntas de la §3.3 son ilustrativos y están para mostrar la forma, no el contenido final.

---

## 1. Decisión

**Banco de preguntas fijo + agente que selecciona, ordena y contextualiza. El agente nunca
inventa preguntas que puntúan.**


| Opción                                                  | Personalización | Puntuable y auditable | Riesgo     |
| -------------------------------------------------------- | ---------------- | --------------------- | ---------- |
| A. El agente redacta las preguntas libremente            | Máxima          | No                    | Alto       |
| B. Banco fijo con reglas (el mock actual)                | Baja             | Sí                   | Bajo       |
| **C. Banco fijo + agente planificador (esta propuesta)** | **Alta**         | **Sí**               | **Bajo**   |
| D. Chat libre con un LLM que extrae las respuestas       | Máxima          | Parcial               | Medio-alto |

Por qué no la A: dos firmas con la misma realidad podrían recibir preguntas distintas y
puntuar distinto según cómo las redactara el modelo; un carrier o Lloyd's pedirá saber con qué
criterios se tarificó a cada cliente; y un modelo generativo puede formular preguntas fuera del
alcance del negocio o indebidas. La D puede construirse más adelante **encima** de la C: es otra
forma de presentar el mismo plan sobre el mismo banco.

Principios:

1. **Lo que puntúa es determinista.** Enunciado oficial, opciones, puntos y pesos viven en el
   banco versionado. El scoring es código en `packages/scoring`, sin LLM.
2. **El LLM solo decide qué preguntar y cómo presentarlo**, dentro de un esquema validado.
3. **Todo lo que el LLM afirma sobre la firma cita evidencia de la Capa 1**, y lo verifica el
   mismo grounding que ya usa la extracción de la web (DN-05).
4. **Nunca se cae:** si el agente falla, el plan se arma con reglas, sin LLM.
5. **Todo queda auditado:** el plan, el modelo, la versión del prompt, el texto exacto que vio el
   cliente y lo que respondió.

---

## 2. Flujo

```
/quote ─▶ Capa 1 (scan) ─▶ /score (Pre-Score)
                               │  "Refine your score" ─▶ POST /scan/:scanId/assessment
                               │                           │ 202 { assessmentId, status: PLANNING }
                               ▼                           ▼
                        /assessment?scan=…&a=…      Agente planificador (1 llamada LLM)
                               │   polling hasta READY      │ valida ─▶ plan  (o fallback por reglas)
                               ▼                           ▼
                 Una pregunta por pantalla  ◀── GET /assessment/:id  (preguntas visibles + respuestas)
                               │
                               │  PUT /assessment/:id/answers/:questionId   (guarda al instante)
                               │  ◀── devuelve las preguntas visibles recalculadas (saltos deterministas)
                               ▼
                 Revisión + declaración de veracidad ─▶ POST /assessment/:id/complete
                               ▼
                 /assessment/results  ◀── GET /assessment/:id/result  (score compuesto, dominios, plan de acción)
```

El plan se puede pedir en cuanto termina la Capa 1, mientras el cliente mira su Pre-Score, así
que la espera es prácticamente cero cuando pulsa el botón.

---

## 3. Banco de preguntas

### 3.1 Dónde vive y quién lo mantiene

- Paquete `packages/questions` del back, hoy vacío. Un archivo de datos por dominio
  (`src/bank/governance.ts`, …) validado con zod al cargar, y tests que fallan si el banco se rompe.
- **El contenido lo define el CEO** (su skill de políticas y reglas de negocio). Nosotros
  mantenemos el esquema, el validador y el motor.
- El banco lleva **versión semántica** (`bankVersion`). Cada evaluación guarda la versión con la que
  se hizo, así que un cambio de pesos nunca reescribe un score pasado.

### 3.2 Esquema

```ts
// packages/questions/src/schema.ts
export const DomainKey = z.enum(['governance', 'tools', 'oversight', 'data_protection', 'training',
  'incident_preparedness']);

// Pesos de §6.3 del CLAUDE.md del front: D1 25 · D2 20 · D3 20 · D4 15 · D5 10 · D6 10.
export const Domain = z.object({
  key: DomainKey,
  label: z.string(),             // "AI Governance & Policy"
  weight: z.number().positive(), // los pesos de todos los dominios suman 100
  minQuestions: z.number().int().min(1), // cobertura mínima que el agente debe respetar
}).strict();

export const AnswerOption = z.object({
  id: z.string(),                // estable: 'written_policy'
  label: z.string(),             // texto que ve el cliente
  points: z.number(),            // contribución dentro del dominio; puede ser negativa
  flag: z.string().optional(),   // marca de suscripción: 'NO_HUMAN_REVIEW'
  exclusive: z.boolean().optional(), // en multi_select: "None of these" anula las demás
}).strict();

export const QuestionType = z.enum(['single_select', 'multi_select', 'yes_no', 'scale', 'number']);

// Condición sobre la Capa 1 o sobre respuestas anteriores. Lenguaje pequeño y cerrado,
// evaluado en código: nada de expresiones libres ni de eval.
export const Condition: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ signal: SignalPath, op: z.enum(['eq', 'neq', 'in', 'gte', 'lte', 'known', 'unknown']),
    value: z.unknown().optional() }).strict(),
  z.object({ answer: z.string(), op: z.enum(['eq', 'neq', 'includes', 'excludes', 'gte', 'lte']),
    value: z.unknown() }).strict(),
  z.object({ all: z.array(Condition) }).strict(),
  z.object({ any: z.array(Condition) }).strict(),
  z.object({ not: Condition }).strict(),
]));
// SignalPath: lista cerrada de rutas de Layer1Result.signals, p. ej. 'website.W1_aiPolicy.found',
// 'website.W2_aiInServices.tools', 'website.W5_teamSize', 'avvo.A8_disciplined'.

export const Question = z.object({
  id: z.string().regex(/^D[1-6]\.\d+[a-z]?$/), // 'D1.1', 'D1.1a' (seguimiento)
  domain: DomainKey,
  type: QuestionType,
  text: z.string(),              // enunciado OFICIAL: el agente no lo cambia
  help: z.string().nullable(),   // tooltip
  options: z.array(AnswerOption).optional(),  // select y yes_no
  scale: z.object({ min: z.number(), max: z.number(), step: z.number(),
    minLabel: z.string(), maxLabel: z.string(), points: z.array(z.number()) }).strict().optional(),
  number: z.object({ min: z.number(), max: z.number(), unit: z.string(),
    bands: z.array(z.object({ upTo: z.number(), points: z.number() }).strict()) }).strict().optional(),
  maxPoints: z.number().positive(), // tope dentro del dominio, para normalizar
  priority: z.number().int().min(1).max(5), // orden por defecto y criterio del fallback
  // Cuándo NO se hace (la Capa 1 ya lo sabe) y qué respuesta se da por buena en ese caso.
  skipWhen: z.object({ when: Condition, impliedOption: z.string().nullable(),
    creditText: z.string() }).strict().optional(),
  // Cuándo se muestra: un seguimiento depende de una respuesta anterior.
  showWhen: Condition.optional(),
  // Evidencia de la Capa 1 que permite proponer una respuesta ("vimos X, ¿sigue así?").
  prefillFrom: z.object({ when: Condition, option: z.string() }).strict().array().optional(),
  // Contradicciones con la Capa 1 que se marcan para revisión (§9).
  contradicts: z.object({ option: z.string(), when: Condition, flag: z.string() }).strict().array().optional(),
}).strict();

export const QuestionBank = z.object({
  bankVersion: z.string(),       // '1.0.0'
  domains: z.array(Domain).length(6),
  questions: z.array(Question),
  limits: z.object({ minQuestions: z.number().int(), maxQuestions: z.number().int() }).strict(), // 8 y 12
}).strict();
```

### 3.3 Ejemplos (ilustrativos)

```ts
{
  id: 'D1.1', domain: 'governance', type: 'single_select', priority: 1, maxPoints: 10,
  text: 'Does your firm have a written policy on how lawyers may use AI tools?',
  help: 'A short internal memo counts, as long as it is written down and shared with the team.',
  options: [
    { id: 'written_shared', label: 'Yes, written and shared with everyone', points: 10 },
    { id: 'written_partial', label: 'Written, but not everyone has seen it', points: 6 },
    { id: 'informal', label: 'Only informal guidance', points: 2 },
    { id: 'none', label: 'No policy yet', points: 0, flag: 'NO_AI_POLICY' },
  ],
  // Si la web ya muestra una política, no se pregunta: se da por buena y se pasa al seguimiento.
  skipWhen: { when: { signal: 'website.W1_aiPolicy.found', op: 'eq', value: true },
    impliedOption: 'written_shared', creditText: 'We found your AI policy on your website.' },
},
{
  id: 'D1.1a', domain: 'governance', type: 'single_select', priority: 2, maxPoints: 5,
  text: 'How often is your AI policy reviewed?',
  showWhen: { any: [
    { signal: 'website.W1_aiPolicy.found', op: 'eq', value: true },
    { answer: 'D1.1', op: 'eq', value: 'written_shared' },
    { answer: 'D1.1', op: 'eq', value: 'written_partial' } ] },
  options: [
    { id: 'quarterly', label: 'Every quarter or more often', points: 5 },
    { id: 'yearly', label: 'Once a year', points: 3 },
    { id: 'never', label: 'It has not been reviewed since it was written', points: 0 },
  ],
},
{
  id: 'D2.1', domain: 'tools', type: 'multi_select', priority: 1, maxPoints: 10,
  text: 'Which AI tools does your firm use for client work?',
  options: [
    { id: 'legal_enterprise', label: 'Legal AI platforms (e.g. a research or drafting assistant)', points: 4 },
    { id: 'enterprise_general', label: 'Enterprise AI with a business agreement', points: 3 },
    { id: 'consumer', label: 'Free or personal AI accounts', points: -4, flag: 'CONSUMER_AI_IN_CLIENT_WORK' },
    { id: 'none', label: 'None', points: 0, exclusive: true },
  ],
  prefillFrom: [{ when: { signal: 'website.W2_aiInServices.found', op: 'eq', value: true }, option: 'legal_enterprise' }],
  contradicts: [{ option: 'none', when: { signal: 'website.W2_aiInServices.found', op: 'eq', value: true },
    flag: 'ANSWER_CONTRADICTS_WEBSITE' }],
},
{
  id: 'D3.1', domain: 'oversight', type: 'scale', priority: 1, maxPoints: 10,
  text: 'How much AI-assisted work is reviewed by a lawyer before it reaches a client?',
  scale: { min: 0, max: 4, step: 1, minLabel: 'None', maxLabel: 'All of it', points: [0, 2, 5, 8, 10] },
},
```

Fíjate en que los nombres de marca no van en las opciones: el cliente ve categorías y el agente
puede nombrar la herramienta en la frase de contexto solo si la web la menciona (§4.3).

---

## 4. Agente planificador

### 4.1 Entrada

- El `Layer1Result` del scan: señales, categorías, multiplicadores, identidad y evidencia (con URLs y extractos).
- Las preguntas **elegibles** del banco: las que el código ya filtró aplicando `skipWhen` y
  `showWhen` contra la Capa 1. El agente nunca ve una pregunta que no se pueda hacer.
- Los límites: 8–12 preguntas, cobertura mínima por dominio, tope de longitud de la frase de contexto.

### 4.2 Salida (esquema estricto, con *structured output*)

```ts
export const PlannedItem = z.object({
  questionId: z.string(),        // debe existir y ser elegible
  // Una frase que conecta la pregunta con la firma. No reemplaza el enunciado oficial.
  context: z.string().max(180).nullable(),
  // Evidencia de la Capa 1 en la que se apoya la frase (ids de la evidencia del scan).
  evidenceIds: z.array(z.string()).max(3),
  // Respuesta que se propone a partir de la evidencia. Solo opciones que `prefillFrom` autoriza.
  suggestedOption: z.string().nullable(),
}).strict();

export const AgentPlan = z.object({
  items: z.array(PlannedItem).min(8).max(12),
  intro: z.string().max(240),    // saludo de la primera pantalla
}).strict();
```

### 4.3 Guardarraíles (en código, no en el prompt)

1. Cada `questionId` existe en el banco, es elegible y aparece una sola vez.
2. Entre `limits.minQuestions` y `limits.maxQuestions` preguntas, y se cumple `minQuestions` de cada dominio.
3. `context` solo puede afirmar cosas presentes en la evidencia citada: se verifica con el grounding
   de DN-05. Si una frase no pasa, se descarta la frase (no la pregunta).
4. Lista de bloqueo en `context`: precio, cobertura, garantías de aceptación, competidores y datos
   personales (§7 y §8 del CLAUDE.md del front).
5. `suggestedOption` solo si `prefillFrom` de esa pregunta lo permite y su condición se cumple.
6. Si el plan no valida, se reintenta una vez; si vuelve a fallar, **fallback por reglas**: las
   elegibles ordenadas por `priority` y por el peso de los huecos de la Capa 1, sin frases de contexto.

### 4.4 Coste y latencia

Una llamada por evaluación al mismo modelo de la Capa 1 (`SIGNAL_LLM_MODEL`). Entrada de unos
pocos miles de tokens y salida pequeña, así que cuesta centavos y tarda unos segundos. El paso a
paso conversacional (una llamada por respuesta) queda para una fase posterior, si se demuestra
que mejora la tasa de finalización.

---

## 5. Contratos (`@arca/contracts`, archivo nuevo `layer2.ts`)

Siguen la convención actual: zod `.strict()`, tipos inferidos y validación en runtime en el front.

```ts
export const AssessmentStatus = z.enum(['PLANNING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED']);

// Lo que el front pinta. Ya trae el enunciado oficial, las opciones y el contexto del agente.
export const RenderedQuestion = z.object({
  id: z.string(), domain: DomainKey, domainLabel: z.string(),
  type: QuestionType, text: z.string(), help: z.string().nullable(),
  context: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), exclusive: z.boolean() }).strict()).nullable(),
  scale: z.object({ min: z.number(), max: z.number(), step: z.number(),
    minLabel: z.string(), maxLabel: z.string() }).strict().nullable(),
  number: z.object({ min: z.number(), max: z.number(), unit: z.string() }).strict().nullable(),
  suggestedAnswer: AnswerValue.nullable(),   // "We found X — is that still right?"
}).strict();
// Nota: los puntos NO viajan al front. El cliente no ve cuánto vale cada opción.

export const AnswerValue = z.union([
  z.object({ kind: z.literal('option'), optionId: z.string() }).strict(),
  z.object({ kind: z.literal('options'), optionIds: z.array(z.string()).min(1) }).strict(),
  z.object({ kind: z.literal('scale'), value: z.number() }).strict(),
  z.object({ kind: z.literal('number'), value: z.number() }).strict(),
]);

export const SkippedQuestion = z.object({ id: z.string(), text: z.string(), creditText: z.string() }).strict();

export const AssessmentView = z.object({
  assessmentId: z.string(), scanId: z.string(), status: AssessmentStatus,
  intro: z.string().nullable(),
  questions: z.array(RenderedQuestion),          // visibles ahora mismo, en orden
  answers: z.record(z.string(), AnswerValue),    // las ya guardadas, para reanudar
  skipped: z.array(SkippedQuestion),             // "Skipped for you" (crédito a la Capa 1)
  progress: z.object({ answered: z.number().int(), total: z.number().int() }).strict(),
  estimatedMinutes: z.number().int(),
}).strict();

export const SaveAnswerRequest = z.object({ answer: AnswerValue }).strict();
export const CompleteRequest = z.object({ attestation: z.literal(true) }).strict();

export const DomainScore = z.object({
  key: DomainKey, label: z.string(), weight: z.number(),
  score: z.number().min(0).max(100), status: z.enum(['KNOWN', 'PARTIAL']),
}).strict();

export const ActionItem = z.object({
  id: z.string(), domain: DomainKey, title: z.string(), detail: z.string(),
  pointsGain: z.number(),        // cuánto subiría el score; el impacto en prima queda fuera hasta que haya pricing
}).strict();

export const AssessmentResult = z.object({
  assessmentId: z.string(), scanId: z.string(), bankVersion: z.string(), scoringVersion: z.string(),
  layer1Score: z.number(), layer2Score: z.number(),
  compositeScore: z.number(),    // combinación de ambas: la fórmula la fija negocio (§11)
  tier: Tier, decision: Decision, // los mismos enums de la Capa 1
  domains: z.array(DomainScore).length(6),
  flags: z.array(z.string()),    // NO_HUMAN_REVIEW, ANSWER_CONTRADICTS_WEBSITE, …
  actionPlan: z.array(ActionItem),
  completedAt: z.string(),
}).strict();

export const AssessmentError = z.object({ error: z.enum(['scan_not_ready', 'assessment_exists',
  'not_found', 'invalid_answer', 'not_visible', 'incomplete', 'already_completed', 'expired',
  'unauthorized']), message: z.string() }).strict();
```

Requiere publicar una versión nueva de los contratos (`contracts-v0.2.0`) y que el front apunte a ella.

---

## 6. Endpoints nuevos

Autenticación: el mismo `sessionToken` del scan (Bearer, atado al `scanId`). La evaluación queda
atada a su scan, así que el token del scan sirve para ella.


| Método y ruta                                      | Qué hace                                                                                                                                                       | Respuestas                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /scan/:scanId/assessment`                     | Crea la evaluación y arranca el plan en segundo plano. Idempotente: si ya existe una abierta, la devuelve.                                                     | `202 { assessmentId, status: 'PLANNING' }` · `409 scan_not_ready` si el scan sigue en curso o falló |
| `GET /assessment/:assessmentId`                     | Estado, preguntas visibles, respuestas guardadas, saltadas y progreso (`AssessmentView`). Mientras `PLANNING`, el front hace polling como en `/quote/scanning`. | `200` · `404`                                                                                        |
| `PUT /assessment/:assessmentId/answers/:questionId` | Guarda (o cambia) una respuesta y devuelve el`AssessmentView` recalculado: un seguimiento puede aparecer o desaparecer.                                         | `200` · `400 invalid_answer` · `409 not_visible` · `409 already_completed`                         |
| `POST /assessment/:assessmentId/complete`           | Exige declaración de veracidad y todas las visibles respondidas. Puntúa y guarda el resultado.                                                                | `200 AssessmentResult` · `409 incomplete`                                                            |
| `GET /assessment/:assessmentId/result`              | El resultado, para recargar`/assessment/results`.                                                                                                               | `200` · `409` si no está completa                                                                   |
| `GET /assessment/:assessmentId/report.pdf`          | *(fase posterior)* Full Assessment Report con el mismo renderer de Chromium del Quick Scan.                                                                     | `application/pdf`                                                                                     |

Límites: las mismas protecciones de abuso que `/scan`. Un `PUT` es barato (no llama al LLM), así
que se limita por evaluación, no por IP.

**Ojo con la caducidad:** el token dura 24 h. Para "guardar y seguir otro día" hará falta un
enlace por email (magic link, ya previsto con Supabase Auth). Mientras no exista, la evaluación se
puede reanudar dentro de esas 24 h.

---

## 7. Modelo de datos (Supabase)

```sql
create table public.assessments (
  id text primary key,                         -- 'as_…'
  scan_id text not null references public.scans(scan_id),
  status text not null check (status in ('PLANNING','READY','IN_PROGRESS','COMPLETED','FAILED','EXPIRED')),
  bank_version text not null,
  planner text not null check (planner in ('agent','rules')),
  planner_model text,                          -- null en el fallback por reglas
  prompt_version text,
  plan jsonb not null default '[]',            -- los PlannedItem validados
  rendered jsonb not null default '[]',        -- el texto exacto mostrado, por pregunta
  result jsonb,                                -- AssessmentResult
  attested_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index assessments_one_open_per_scan on public.assessments (scan_id)
  where status in ('PLANNING','READY','IN_PROGRESS');

create table public.assessment_answers (
  assessment_id text not null references public.assessments(id) on delete cascade,
  question_id text not null,
  answer jsonb not null,
  suggested boolean not null default false,    -- aceptó la respuesta propuesta sin cambiarla
  answered_at timestamptz not null default now(),
  primary key (assessment_id, question_id)
);
-- Historial: cada cambio de respuesta se conserva para auditoría.
create table public.assessment_answer_events (
  id bigserial primary key, assessment_id text not null, question_id text not null,
  answer jsonb not null, created_at timestamptz not null default now()
);
```

RLS cerrado como en `scans`: solo la API (clave secreta) lee y escribe.

---

## 8. Scoring

- **Por dominio:** suma de puntos de las preguntas respondidas o implícitas (`skipWhen.impliedOption`),
  normalizada a 0–100 contra la suma de `maxPoints` de esas mismas preguntas.
- Un dominio sin ninguna pregunta respondida queda `PARTIAL`, igual que en la Capa 1, y bloquea la
  decisión comercial (`COMMERCIAL_DECISION_BLOCKED`) en vez de inventar un valor.
- **Score de la Capa 2:** media ponderada de los dominios con los pesos del banco.
- **Score compuesto:** combinación de la Capa 1 y la Capa 2 (fórmula pendiente, §11). Tier y
  decisión salen de `packages/scoring/src/math.ts`, los mismos que la Capa 1.
- **Plan de acción:** por cada pregunta con margen, la siguiente opción mejor y los puntos que
  sumaría, ordenados por ganancia en el compuesto.
- Todo versionado (`scoringVersion`), con tests de tabla como los de la Capa 1.

---

## 9. Antifraude y coherencia

- **Contradicciones con la Capa 1** (`contradicts`): no cambian la respuesta, añaden una marca para
  revisión del suscriptor. Ejemplo: responde "no usamos IA" y la web anuncia herramientas de IA.
- **Respuesta propuesta aceptada sin cambios** queda marcada (`suggested`), para distinguir lo que
  el cliente declaró de lo que aceptó.
- **Declaración de veracidad** obligatoria antes de puntuar, con fecha.
- **Tiempo por respuesta** (opcional): respuestas en menos de un segundo de forma sistemática se marcan.

---

## 10. Vistas del frontend

Inspiración Lemonade en la mecánica, no en la marca: una pregunta por pantalla, respuestas grandes
que se tocan, una "voz" que habla al cliente y progreso guardado. La voz encaja con el orbe/ojo de
la identidad de Arca. Todo el texto visible en inglés.


| Ruta                                           | Vista                                                                                                                                     | Componentes                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `/score`                                       | Botón "Refine your score" bajo el Pre-Score. Pide el plan en cuanto carga la página.                                                    | `RefineCta`                             |
| `/assessment?scan=…&a=…` (estado `PLANNING`) | Pantalla breve de preparación con el orbe y el`intro` del agente.                                                                        | `AssessmentIntro`                       |
| idem (`READY` / `IN_PROGRESS`)                 | Una pregunta por pantalla. Arriba, el dominio y el progreso; en medio, la frase de contexto como voz y el enunciado; abajo, la respuesta. | `QuestionScreen` + una tarjeta por tipo |
| idem, al final                                 | Revisión: lista de respuestas editables, las saltadas con su crédito ("Skipped for you") y la casilla de veracidad.                     | `ReviewScreen`, `AttestationCheckbox`   |
| `/assessment/results`                          | Score compuesto, gauge, tier, 6 dominios, plan de acción y siguientes pasos. Reutiliza`ScoreGauge`, `TierBadge` y `DomainBar`.           | ya existe, pasa a datos reales          |

**Tarjetas por tipo de pregunta:**


| Tipo                 | Interacción                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `yes_no`             | Dos botones grandes; un toque responde y avanza.                                                           |
| `single_select`      | Tarjetas apiladas; un toque responde y avanza.                                                             |
| `multi_select`       | Chips seleccionables + "Continue". La opción`exclusive` desmarca las demás.                              |
| `scale`              | Slider con etiquetas en los extremos y el valor en palabras.                                               |
| `number`             | Stepper con límites y unidad ("12 lawyers").                                                              |
| Con`suggestedAnswer` | Tarjeta de confirmación: "We found X on your website — is that still right?" con**Yes** / **Change it**. |

**Comportamiento:**

- Cada respuesta se guarda al momento (`PUT`). Si se cierra la pestaña, al volver se retoma donde iba.
- Atrás siempre disponible; cambiar una respuesta puede hacer aparecer o desaparecer un seguimiento,
  y el progreso se recalcula con lo que devuelve la API.
- Transiciones cortas entre preguntas y respeto a `prefers-reduced-motion` (§11 del CLAUDE.md del front).
- Teclado completo: flechas para opciones, Enter para continuar.
- El embudo sigue viajando por ids en la URL, nunca con datos de la firma (§8 del CLAUDE.md del front).
- Estados de error: plan que tarda (mensaje y reintento), sesión caducada (volver a `/quote`),
  respuesta rechazada (mensaje junto a la pregunta).

**Cliente:** `lib/api/client.ts` gana `startAssessment`, `getAssessment`, `saveAnswer`,
`completeAssessment` y `getAssessmentResult`, todos validando con los esquemas de `@arca/contracts`.
Desaparecen `lib/mock/assessment-questions.ts`, `lib/mock/assessment-results.ts` y los tipos
escritos a mano de `lib/types/assessment*.ts`.

---

## 11. Decisiones pendientes (negocio)

1. **Contenido del banco:** preguntas, opciones, puntos, pesos y reglas de salto (Juan José).
2. **Fórmula del score compuesto:** cuánto pesa la Capa 1 frente a la Capa 2.
3. **Qué marcas bloquean la decisión** (p. ej. `CONSUMER_AI_IN_CLIENT_WORK`) y cuáles solo informan.
4. **Si se permiten preguntas abiertas sin puntuar** ("anything else we should know?") para el suscriptor.
5. **Política de reanudación** más allá de 24 h (magic link).
6. **Los ajustes de puntuación de la Capa 1** que están pendientes: conviene cerrarlos antes, porque
   el agente y las reglas de salto se alimentan de esas señales.

---

## 12. Fases


| Fase | Entrega                                                                                                  | Depende de             |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0    | Ajustes de puntuación de la Capa 1                                                                      | Parámetros de negocio |
| 1    | Esquema del banco, validador y motor de saltos con un banco de prueba; contratos`v0.2.0`                 | —                     |
| 2    | Endpoints, tablas y scoring de la Capa 2 con**plan por reglas** (sin agente)                             | Fase 1                 |
| 3    | Front conectado: vistas de §10 sobre datos reales                                                       | Fase 2                 |
| 4    | Agente planificador con guardarraíles y grounding; métricas de finalización frente al plan por reglas | Fase 2                 |
| 5    | Banco definitivo de Juan José, Full Assessment Report en PDF                                            | Decisiones §11        |

Con este orden, el producto funciona de punta a punta antes de que entre el agente, y el agente
se puede medir contra el plan por reglas en vez de darlo por bueno.
