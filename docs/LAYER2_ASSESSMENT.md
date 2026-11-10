# Layer 2 assessment implementation

This isolated implementation follows DN-07's fixed-bank, deterministic-score architecture.
The bank and 30% Layer 1 / 70% Layer 2 composite are **engineering demo fixtures**, not approved
underwriting policy. Every result carries `bankStatus: DEMO`, `commercialDecisionBlocked: true`,
and demo flags. A questionnaire cannot erase a known Layer 1 restriction (a disciplinary override, or
`WEBSITE_UNAVAILABLE` when the firm website refused to be read: DN-12) or
make missing public evidence sufficient. No pricing, binding, or magic-link flow is implemented.
A completed assessment can be downloaded as a PDF report (see "Assessment report" below).

## Local operation

Use `SOURCE_MODE=mock`, `STORAGE_BACKEND=memory`, and `ASSESSMENT_PLANNER=rules`.
Start with the usual `npm ci`, `npm run build`, and `npm run dev`. Scan a documented mock domain,
then keep the returned scan session token for every assessment request. Swagger at `/docs`
contains the six assessment routes.

1. `POST /scan/:scanId/assessment` starts planning, returning `202` and an assessment ID.
2. Poll `GET /assessment/:assessmentId` until `READY`.
3. `PUT /assessment/:assessmentId/answers/:questionId` with `{ "answer": ... }` saves immediately.
4. `POST /assessment/:assessmentId/complete` with `{ "attestation": true }` stores the result.
5. `GET /assessment/:assessmentId/result` reads that exact stored result.
6. `GET /assessment/:assessmentId/report.pdf` downloads the report of that stored assessment.

All six require `Authorization: Bearer <sessionToken>`. The token's scan ID and requester email
must match the original scan. Assessment views/results use `Cache-Control: no-store`.
A scan that is `COMPLETED` or `PARTIAL` with a result can start an assessment. A running or failed
scan cannot. Repeated create requests always return the same assessment, including after completion.
Repeated completion requests return the original result and completion timestamp.

## Questionnaire and evidence boundaries

The fixed bank determines official wording, options, validation, score contribution and visibility.
The planner may order and choose informational content but cannot omit scored coverage or latent
follow-ups. Conditional questions remain in the stored plan so answering a parent can reveal them.
Public website evidence does not prove internal AI practices: there is no automatic score credit or
skip based on a public policy alone. Proposed answers require an explicit user confirmation.

Each assessment freezes its complete bank, Layer 1 result, evidence, validated plan, model/prompt
provenance and exact rendered question objects. Every answer event stores the exact rendered
question and whether the suggested answer was accepted. Questions exposed later append to the
rendered snapshot; previously displayed wording cannot be rewritten.

Changing an answer recalculates visibility and removes newly hidden answers in the same atomic
write, adding invalidation events. Showing the question again requires a fresh answer. Completion
requires every currently visible question to be answered with the correct answer kind, allowed
options, exclusivity and numeric range/step, plus explicit truthfulness attestation.

## Assessment report

`GET /assessment/:assessmentId/report.pdf` renders a completed assessment with the Chromium renderer
and the layout of the Quick Scan Report (`apps/api/src/report/`). It is built from the stored record
alone: the Layer 1 snapshot for the firm name and domain, the frozen bank and plan to know which
questions the firm ended on, the rendered questions for their exact wording, the answers and the
stored result. Nothing is scored again and no provider is called.

| Case | Answer |
|---|---|
| Completed assessment | `200 application/pdf`, `Cache-Control: no-store`, `Content-Disposition: attachment; filename="arca-assessment-<domain>-<yyyy-mm-dd>.pdf"` (the completion date, UTC) |
| Missing or invalid token, another scan's token, another email | `401 unauthorized` |
| Unknown assessment | `404 not_found` |
| Not completed yet | `409 incomplete` |
| The 24-hour session ended | `410 expired` |
| No renderer configured, the renderer failed, or an injected debug report fault | `503 report_unavailable` |

The report states the firm and domain, the completion date, the combined score and tier, the
Layer 1 and Layer 2 parts, the six areas with their weights, the action plan, the answers as they
were asked (marking follow-ups that are context only), and the bank and scoring versions. It carries
exactly one demo disclosure: "Demo assessment. The questions and the scoring are provisional, so
these results are illustrative. This is not an insurance offer, a price or an underwriting decision."
It never prints the decision, the overrides, the raw flags, the requester's email or a price. When
the result carries `WEBSITE_UNAVAILABLE` it adds one sentence saying that the website could not be
read and that the result needs a manual review; it names the highest-risk group only when the tier
is `CRITICAL`, so the sentence cannot contradict the tier printed above it (DN-12 section 6).

CORS exposes `Content-Disposition` for every route, so the browser can read the filename. In the
debug modes the scenario axis `http.report: unavailable` applies to this route as it does to the
scan report. Each request launches its own Chromium and there is no rate limit, as for the scan
report.

Action plan items carry only their own step (`Next step: <option>.`). The caveat that each gain is a
provisional estimate on its own is said once by the screen and once by the report, not on every item.
Results completed before this change keep the longer text they were stored with.

## Planning and recovery

Rules are the default. Only explicit `SOURCE_MODE=live` and `ASSESSMENT_PLANNER=agent` enable
`createOpenAIPlanner`, using `OPENAI_API_KEY` and `SIGNAL_LLM_MODEL`. Mock mode never creates that
provider, even if the agent setting is selected. Tests inject local transports; no paid calls are
necessary to verify the implementation.

The optional planner validates strict structured output and retries once. Firm-specific context is
restricted to exact approved evidence templates; novel claims are discarded. The API caps planning
at 15 seconds and falls back to rules. Startup and periodic recovery detect persisted `PLANNING`
records older than 30 seconds and finish them using the frozen bank and evidence with rules.
A failed persistence operation never publishes an uncommitted plan or answer. If planning storage
fails, the record stays `PLANNING` for recovery rather than claiming readiness.

## Session lifetime, persistence and limits

The assessment expires 24 hours after its scan was created. Creating an assessment or repeating a
request does not extend the deadline. The original bearer token also independently expires after
24 hours. The current frontend keeps this capability in the current tab's session storage; there
is no cross-device or next-day recovery link.

`STORAGE_BACKEND=memory` is deliberately ephemeral: restarting the API process loses scans,
assessments, answers and audit events. Browser reload within the same session can resume while the
same API process remains alive. This mode is not restart persistence.

The Supabase adapter provides durable state through migration
`20261013030000_layer2_assessments.sql`. It uses a unique scan ID, transaction-scoped create lock,
row lock and revision compare-and-swap. Each mutation and all its answer/audit changes commit in
one RPC transaction. Completed results and source snapshots are immutable. RLS denies direct
client access; only service-role RPCs mutate assessment data. The API never sends its service key
to the browser. Apply migrations through the project's normal reviewed deployment workflow; no
live migration is part of local implementation or test execution.

Answers are limited to 120 write attempts per assessment per minute within one API process and
1,000 accepted writes per assessment in the repository. A request body can be at most 16 KiB.
Per-minute rate limiting and background planning dispatch still assume a single API process;
database CAS protects persisted writes across processes but is not a distributed queue or rate
limiter. The durable lifetime limit is enforced in PostgreSQL as well as the service.

## Verification

- `npm run build`: TypeScript project references and production imports.
- `npx vitest run apps/api/tests/integration/assessment.test.ts`: local HTTP workflow, bearer scope,
  expiry, invalid answers, concurrency, hidden-answer invalidation, resume, failure recovery and limits.
- `npx vitest run apps/api/tests/integration/assessment-report.test.ts`: the report route (download
  headers, token scope, not completed, expiry, renderer failures) and the report's content, with an
  injected renderer. No Chromium is launched.
- `npx vitest run apps/api/tests/integration/assessment-database.test.ts`: PGlite schema/RLS,
  immutable snapshots, transactional audit rollback, CAS and durable write limits.
- `npm test`: full backend regression suite. Browser integration tests require the matching
  Playwright Chromium; AWS infrastructure tests also require `npm ci --prefix infra/aws`.

PGlite exercises conflicting CAS calls in a single embedded connection. It does not establish
multi-connection PostgreSQL lock behavior, live Supabase permissions, live OpenAI compatibility,
or production restart recovery. Those require separate authorized environment validation.
