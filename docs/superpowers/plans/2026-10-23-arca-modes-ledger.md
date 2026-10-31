# SDD ledger — plan: docs/superpowers/plans/2026-10-23-arca-modes.md

Spec: docs/design-notes/DN-09-modos-mock-y-live-debug.md (binding).
Repos: Arca-back (plan + Tasks 1-6, 10 docs) and Arca-front (Tasks 7-10), both on local branch feat/arca-modes.
Base before Task 1: back 431ce81 (plan commit; branch started at 5123b00), front 64a67b0.

## Pre-flight scan

| Tasks | Shared file / interface | Producer → consumer | Finding |
|---|---|---|---|
| T1 ↔ T6 | `listenHostname`, `env.mode`, `env.overridden` | T1 produces, T6 consumes in compose/server | consistent |
| T2 ↔ T3,T5,T8,T9 | `DebugScenario`, `isInjected`, `DEBUG_*` | T2 produces | **conflict**: T2 exported debug contracts from the contracts root index; front prod code imports `@arca/contracts`, so zod schemas/presets (non-pure calls) would ship in the prod bundle and `X-Arca-Debug-Scenario` could trip T7's leak check → Ruling 1 |
| T3 ↔ T5 | `injectWebsite(real, scenario, {latency})`, `injectDirectory` | T3 → T5 `pipelineFor` | consistent |
| T4 ↔ T5 | `RoutingScanRepository.isolate/overlay`, `RoutingAssessmentRepository.overlay`, `clear()` | T4 → T5 `beginScan`/reset | consistent |
| T4 ↔ T6 | routing repos in compose | T6 text wrapped only live-debug explicitly while T5's `createDebugTools` requires routing repos always | ambiguity → Ruling 2 |
| T5 ↔ T6 | `createDebugTools` options, `AppDeps.debug` | T5 → T6 | consistent |
| T7 ↔ T8 | `DebugRoot.tsx` (T7 minimal, T8 completes), store API | T7 → T8 | consistent (T8 modifies the file T7 created, by design) |
| T7 ↔ T9 | `bridge.ts` (`publishDebugState`, `debugScenarioHeaders`, `SCENARIO_STORAGE_KEY`), `client.ts` | T7 → T9 | consistent |
| T8 ↔ T9 | `StatePanel.tsx` (T8 creates, T9 mounts controls) | T8 → T9 | consistent |
| T7 ↔ T10 | `check-no-debug.mjs` patterns vs strings used by T8/T9 debug-only UI | — | consistent: "LIVE DEBUG", "MODE MISMATCH", "/__debug/" only appear in debug-only modules |
| T1 | own tests vs code | — | consistent (mock override before credential checks so ASSESSMENT_PLANNER=agent w/o key passes) |
| T2 | own tests vs code | — | consistent after Ruling 1 (adds subpath test) |
| T3 | own tests vs code | — | consistent; `APIFY_QUOTA_REASON` export touches directories.ts (listed) |
| T4 | own tests vs code | — | consistent |
| T5 | own tests vs code | — | consistent; tests need a domain resolver accepting mock domains |
| T6 | own tests vs code | — | consistent; risk: patching `net.Socket.prototype.connect` may disturb vitest IPC — implementer may adapt the network trap, must keep "0 outbound attempts" assertion |
| T7 | own tests vs code | — | consistent; risk: Next may reject some `env` keys — implementer verifies |
| T8, T9, T10 | own tests vs code | — | consistent |

Ruling 1: debug contracts live only in the subpath `@arca/contracts/debug` (package.json `exports["./debug"]`), never re-exported from the root index; plan Tasks 2, 8, 9 amended in place — why: keeps zod debug schemas, presets and the header name out of the production front bundle (prod code imports the root), so the "no debug code in production" guarantee and T7's leak check hold — cost if wrong: one more export entry to maintain; if a bundler cannot resolve the subpath, imports switch to a relative path inside Arca-back only.
Plan amended for Ruling 1 in commit ee73e81.

Ruling 2: both debug modes (mock and live-debug) wrap storage in RoutingScanRepository/RoutingAssessmentRepository; in mock the durable side is an InMemoryRepository — why: `createDebugTools` takes routing repos unconditionally and a single code path is simpler to verify — cost if wrong: negligible extra indirection in mock.
Task 1: dispatched (BASE ee73e81, implementer sonnet)
Task 1: implementer DONE_WITH_CONCERNS (8383df9; 395/395) — concerns: overridden baseline counts implicit defaults; empty ARCA_MODE= aborts; .env.example claims loopback before T6. Review dispatched (sonnet).
Task 1: complete (commits ee73e81..8383df9, review clean)
Task 1: minor (deferred): env.ts:95 return spread keeps raw SOURCE_MODE/STORAGE_BACKEND (still live/supabase under mock) — carry to T5/T6: /__debug/mode must use sourceMode/storageBackend/mode only
Task 1: minor (deferred): env.ts:79 ASSESSMENT_PLANNER→assessmentPlanner rename is a no-op change
Task 1: minor (deferred): env.ts:71-72 overridden built from untyped triples; a typed helper would read better
Task 1: minor (deferred): overridden reports implicit defaults (SOURCE_MODE=live→mock with nothing set) — T6 banner wording should not claim the var was set
Task 1: minor (deferred): ARCA_DEPLOYMENT empty-string branch untested
Ruling: back rejects an empty ARCA_MODE= as unknown while the front (T7) treats empty as production — both fail safe (back refuses to start, front builds without debug); kept as is — cost if wrong: a dev who exports ARCA_MODE= gets a startup error instead of production
Task 2: dispatched (BASE 8383df9, implementer sonnet)
Task 2: implementer DONE (cb61e03; 411/411) — deviation: preset type is z.input (DebugScenarioInput) since Partial<output> fails TS for nested http
Process: from Task 2 review on, each task runs as a Workflow (scripts/sdd-task-wf_6259e314-b15.js): implementer → task review → fix rounds (fresh fixer; r4-5 opus) → scoped re-review; controller adjudicates residuals. Task 2 review launched (wf_6259e314-b15).
Task 2: complete (commits 8383df9..cb61e03, review clean)
Task 2: minor (deferred): debug.ts:116 presets typed DebugScenarioInput — T9 must apply presets via DebugScenario.parse({...current, ...preset.scenario}) and use DebugScenarioInput for drafts
Task 2: minor (deferred): debug.ts:79 isInjected `differs` indexes without a null guard (unreachable for parsed input)
Task 2: minor (deferred): DEBUG_PRESETS mutable shared objects (Object.freeze / as const satisfies)
Task 2: minor (deferred): debug.test.ts no negative cases for DebugModeResponse/DebugScanState enums besides mode
Task 3: dispatched via workflow wf_936ee1a7-518 (BASE cb61e03, sonnet)
Task 3: implementer DONE_WITH_CONCERNS (e68a907; 435/435); review approved (spec ✅, 0 critical/important)
Ruling: website `no_identity` must keep status 'ok'/dataStatus 'EMPTY' (brief) — the implementer switched it to 'error' to force FAILED, but the real InProcessPipeline counts a readable site as a useful source, so "readable site, no identity" really ends PARTIAL with bar/avvo skipped INSUFFICIENT_IDENTITY; DN-09 §5.3's "→ FAILED" was a factual error in the spec (muscalaw's FAILED came from a failed extraction = website:error). Spec principle "the outcome emerges from the real pipeline" wins; DN-09, plan T2/T3/T5/T10 corrected (commit below); preset key identity_failed → no_identity, label "No firm identity"; FAILED coverage moves to "Every source down" — cost if wrong: the identity preset no longer shows the FAILED screen (all_down still does)
Ruling: apify_quota must mirror the real source when it has no lookup targets (real returns skipped/INSUFFICIENT_IDENTITY at directories.ts:148-152) — the label must never show a quota error where production would not call Apify — cost if wrong: one more branch in sources.ts
Ruling (carry to T5): pipelineFor passes timeoutMs: pipelineTimeoutMs to InProcessPipeline; default 55 s budget would abort latency 'slow' (70 s) — plan T5 amended
Task 3: minor (deferred): sources.ts:89 `empty` uses names.length/data [] vs real null + no_match rows (brief-literal)
Task 3: minor (deferred): only website default waits the latency; faults + slow are instant — T9 panel should not imply faults are delayed
Task 3: minor (deferred): debug-sources.test.ts:358 unused _case param in it.each
Task 3: fix round 1/5 dispatched (FIX_BASE 9cfaddc; 3 findings: no_identity revert, preset rename, quota-with-no-targets mirror)
Task 3: fix round 1 implemented (bf9b469; 438/438) — re-review dispatched
Task 3: fix round 1/5 (3 addressed, 0 open — no_identity revert, preset rename, quota-no-targets mirror via exported nothingToLookUp; commits 9cfaddc..bf9b469)
Task 3: complete (commits cb61e03..bf9b469, review clean)
Task 4: dispatched via workflow (BASE bf9b469, sonnet)
Task 4: complete (commits bf9b469..f702220, review clean)
Task 4: minor (deferred): isolation.ts:55 doc comment cites "Task 5" (plan task number in production source) — reword as contract
Task 4: minor (deferred): isolation.ts:58 isolated Set survives overlay.clear() by design (wiped id → 404, never durable) — add a comment saying so
Task 4: minor (deferred): isolation.ts:95 commit existence check clones the whole record (negligible, debug-only)
Task 4: minor (deferred): debug-isolation.test.ts:174 spy factories untyped — add `satisfies ScanRepository/AssessmentRepository`
Task 4: minor (deferred): isolation.ts:72 recoverInterrupted: overlay skipped if durable throws
Task 5: dispatched via workflow (BASE f702220, implementer opus, reviewer opus)
Task 5: review (opus) — spec ❌ 2 Important: no test that default directories in an injected scan reach the real source with scanId undefined; /__debug/scan lacked domain resolution and FAILED-scan per-source diagnostics (DN-09 §5.2)
Task 5: fix round 1/5 (2 addressed, 0 open — scanId-free ledger path pinned by spy tests; DebugScanState.domainResolution + keepFailedSources; commits 08abb65..0cfa14a)
Ruling: kept DN-09 §5.2 as written — DebugScanState gains domainResolution and FAILED scans keep their per-source diagnostics in the debug tools (keepFailedSources, no-op in production since debug is absent) instead of narrowing the contract — why: the panel exists for failure cases, and a FAILED scan stores no result — cost if wrong: one extra field in the debug contract and an unbounded in-process map in debug modes
Task 5: complete (commits f702220..0cfa14a, review clean after round 1)
Task 5: minor (deferred): tools.ts:151-158 /__debug/scan duplicates authorizedScan from app.ts — extract a shared helper
Task 5: minor (deferred): app.ts:341 hang path returns the scan read before the 16 s wait (stale RUNNING) — re-read after wait
Task 5: minor (deferred): debug-mode.test.ts:565-576 slow-latency test does not prove latency applied (assert RUNNING at slow-1 ms; live-debug ignores latency)
Task 5: minor (deferred): tools.ts scenarios/polls/failedSources maps never pruned, /reset does not clear them
Task 5: minor (deferred): reset during a running injected scan logs a spurious '[scan] persistence failed'
Task 5: minor (deferred): debug-mode.test.ts PollResponse union access (.result) is type debt (tests not typechecked by tsc -b)
Task 6: dispatched via workflow wf_6f40fc8b-cbb (BASE cdc9eeb, opus/opus)
Task 6: complete (commits cdc9eeb..d977ade, review clean) — 483/483; mock dev server verified on 127.0.0.1:8080 only
Task 6: minor (deferred, TRIAGE FIRST in final review): compose.ts:88 /__debug/mode in mock reports websiteEvidenceProvider 'agentic' + signalLlmModel although mock builds no provider/LLM — panel would show 'agentic' under MOCK (label-honesty, DN-09 §4)
Task 6: minor (deferred): with-mode.mjs/stack.mjs mock pair omits ASSESSMENT_PLANNER=rules → dev:mock may still print an override if .env.local sets agent
Task 6: minor (deferred): mode list + mock env pair duplicated across with-mode.mjs, stack.mjs, mode.ts, env.ts
Task 6: minor (deferred): stack.mjs POSIX process-group kill can throw ESRCH; no SIGHUP handling (Windows unaffected)
Task 6: minor (deferred): server.ts loopback binding only covered by listenHostname unit tests + manual netstat (record netstat in DN-09 §12)
Task 6: minor (deferred): with-mode.mjs command.join(' ') under shell:true loses argument quoting
Task 6: note: next dev in the stack listens on all interfaces (front-side, not required by DN-09)
Task 7: dispatched via workflow wf_2938f7db-1a7 (front BASE 64a67b0, opus/opus)
Task 7: review (opus) — 3 Important: postbuild hook skipped under the user's ~/.npmrc ignore-scripts=true; blanket .map exclusion narrowed DN-09 §8.9 without a ruling; CLI entry guard failed open through a junction
Task 7: fix round 1/5 (3 addressed, 0 open — check inside `build` script, maps scanned for debug-only markers, unconditional CLI + findDebugLeaks in scripts/debug-leaks.mjs; commits 3811712..18caaae)
Ruling: the leak check runs inside the `build` script (`next build && node scripts/check-no-debug.mjs`), not as `postbuild` — why: the user's ~/.npmrc has ignore-scripts=true, which silently skips pre/post hooks — cost if wrong: none functionally; one less npm convention
Ruling: source maps are scanned only for debug-only markers (sentinel, /__debug/, LIVE DEBUG, MODE MISMATCH); the bridge-owned names (__arcaDebug, X-Arca-Debug-Scenario) are skipped in .map files only — why: server maps embed the original source of bridge.ts once production pages import it, while the compiled code is clean; the sentinel/UI strings never appear in production module source — cost if wrong: a leak of only the bridge names inside a .map would go unreported (compiled .js is still fully scanned); to be recorded in DN-09 §12 by Task 10
Ruling: findDebugLeaks lives in scripts/debug-leaks.mjs and check-no-debug.mjs is an unconditional CLI — why: removes the fail-open entry guard — cost if wrong: none
Task 7: complete (commits 64a67b0..18caaae front, review clean after round 1) — front 174 tests; production build 0 leaks; mock build ≥1 leak detected; VERCEL=1+mock fails 'local-only'; invalid mode fails
Task 7: minor (deferred → carried into T9): lib/debug/bridge.ts:25 sessionStorage.getItem unguarded (SSR ReferenceError / blocked storage) — must be try/catch before T9 wires it into startScan
Task 7: minor (deferred → carried into T8): store installed lazily after hydration drops one-shot publishes; installDebugStore replaces an existing store — buffer last payload per section until a store installs; reuse existing store
Task 7: minor (deferred): mode rule copied in check-no-debug.mjs and with-mode.mjs (plain Node cannot import .ts)
Task 7: minor (deferred): entry.parentPath needs Node ≥20.12; no engines field
Task 7: minor (deferred): with-mode.mjs command.join(' ') under shell:true
Task 7: minor (deferred): no test pins scripts.build containing check-no-debug.mjs
Task 8: dispatched via workflow wf_2db58ff2-e75 (front BASE 18caaae, opus/sonnet; carries store-buffer ruling)
Task 8: complete (commits 18caaae..233fff2 front, review clean) — 195 tests; production build 0 leaks
Task 8: note: added a pending banner state "Checking the back's mode · front=<f>" (not one of the three exact labels; never asserts an unconfirmed mode)
Task 8: note: pre-existing flaky test lib/assessment-flow.test.tsx 'isolates pending assessment creation when the scan query changes on the same route' (failed 1/22 under load; untouched by this work)
Task 8: minor (deferred): DebugRoot.tsx has no test wiring probe→checkModes→ModeBanner + State toggle
Task 8: minor (deferred): store.ts:741 cast over weaker window type; declare __arcaDebug?: DebugStore via import type
Task 8: minor (deferred): StatePanel 'View internal state' disabled unless tokenTimes decodes (couples query to display)
Task 8: minor (deferred → carried into T9): published state is printed unfiltered — T9 payloads must never carry email; redact `email` keys in Json as defence in depth
Task 8: minor (deferred): 'State' toggle bg-marino merges with the mismatch strip
Task 8: minor (deferred): StatePanel/token/ModeBanner coverage gaps (non-ok branches, -/_ base64url, lucide class coupling)
Task 9: dispatched via workflow (front BASE 233fff2, opus/opus)
Task 9: complete (commits 233fff2..088645e front, review clean) — 225 tests; production build 0 leaks
Ruling: /score publishes the raw poll fields inline when the poll arrives instead of keeping a ref — why: the Task 8 bridge buffer already holds the publish until the lazy panel installs, so the ref would be written and never read — cost if wrong: none (two-line add if wanted)
Task 9: minor (deferred, TRIAGE FIRST in final review): stale `latency` from a mock session is still sent in live-debug and isInjected counts latency → a live scan is silently isolated in memory (safe direction, but surprising); normalise latency in live-debug (front and/or back parseScenario)
Task 9: minor (deferred): /score publishes nothing for FAILED/catch paths
Task 9: minor (deferred): /assessment planningMs measured even when not PLANNING; state published only from load()
Task 9: minor (deferred): scanning page re-derives cadence/phase for publishing (could drift); no page-state test for scanning
Task 9: minor (deferred): bridge.test.ts spy restore not in finally/afterEach
Task 9: minor (deferred): Scenario/AssessmentControls coverage gaps (reset failure, missing form notice, partial auto-answer failure)
Task 9: minor (deferred): 6 pre-existing react-hooks/set-state-in-effect lint warnings remain
Task 10: dispatched via workflow (BASE back 395f1fe, front 088645e; opus/opus)
Task 10: complete (front 088645e..a291bcf, back 395f1fe..e903d60, review clean) — smoke 4/4 + mismatch 1/1 on the real mock stack; checks a-i recorded in DN-09 §12
Task 10: note: scenario 5 (mismatch) needs its own run with the back stopped (NEXT_PUBLIC_API_URL is baked at build time)
Task 10: minor (deferred): DN-09 §11.7 tells to type the Arca-dev secret key on the PS command line (persists in PSReadLine history) — use Read-Host
Task 10: minor (deferred): DN-09 §11.3 omits the NEXT_PUBLIC_API_URL override caveat for separate-terminal live-debug
Task 10: minor (deferred): smoke off-host guard does not cover WebSockets; POST /scan capture compares exact URL string; artifactDir cwd-relative; no hint for the separate mismatch run; until() check not guarded
Task 10: minor (deferred): DN-09 §11.5 cleanup leaves SOURCE_MODE/STORAGE_BACKEND set in the terminal
Final review: packages final-back.diff (5123b00..e903d60) and final-front.diff (64a67b0..a291bcf)
Final review (3 opus lenses + adversarial verify): verdict "With fixes" from all three; 0 Critical; confirmed Important: one-shot probe (stale strip), invisible persistent scenario, live-debug latency isolation, /__debug/mode raw config
Ruling: one fix wave (final-fix-findings.md) covering F1-F4 (Important) plus F5-F13 minors ruled must-fix: reset keeps live-debug overlays (spec §5.2), assessment routing by isolated id set, X-Arca-Debug header on reset (CSRF), neutral checking strip, per-scan published state, deploy-marker test, ESLint import boundary, build-script pin test, DN-09 doc fixes — why: label honesty and the "nothing reachable/polluting" guarantees are the feature's core — cost if wrong: one larger fix wave
Ruling: the armed scenario becomes ONE-SHOT (consumed by the next POST /scan) and is shown on the strip — why: DN-09 §5.3/§6.4 say "el próximo POST /scan"; a persistent invisible scenario silently alters later scans — cost if wrong: re-arming a preset for each injected scan
Ruling: parked — validating an old stored scenario in the bridge (one-shot makes it self-clearing; bridge must not import zod into production)
Final fix wave: dispatched (opus) — back BASE e903d60, front BASE a291bcf
Final fix wave: DONE (back e903d60..5730211, front a291bcf..c6136da; back 501 tests, front 270, prod build 0 leaks, smoke 5/5); scoped re-review dispatched
Final fix wave re-review (opus): F1-F13 all ADDRESSED, no new Critical/Important breakage
Final: parked — open ScenarioControls panel keeps showing a spent scenario after a failed start (re-arms on next select change) — Ruling: the strip (authoritative, re-read on publish) shows nothing armed; closing/reopening the panel resyncs — cost if wrong: a developer could re-arm a stale scenario by editing a select with the panel left open
Final: parked — /__debug/mode signalLlmModel names only the extraction model when provider=openai and planner=agent — Ruling: inUse.openai stays correct and DN-09 §12.3 documents the precedence — cost if wrong: the panel under-reports one of two models in an unusual config
Final: parked — ESLint dynamic-import selector misses relative ./debug/ paths (static rule catches them) — Ruling: production code has no dynamic imports of debug modules; the leak check still scans the build — cost if wrong: a future relative dynamic import of debug code passes lint (the build leak check remains)
Final: verified by controller — back 501/501, front 270/270, typecheck clean, lint 0 errors (6 pre-existing warnings), production front build 0 debug leaks; mock stack running (back 127.0.0.1:8080, front :3000), strip shows MOCK
