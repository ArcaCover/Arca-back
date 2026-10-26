# SDD ledger — plan: docs/superpowers/plans/2026-10-25-webapp-orgs.md

Spec: docs/design-notes/DN-10-webapp-organizaciones-y-cobro.md (binding), on DN-09. Branch feat/webapp-orgs in both repos. Base: back 83a3b8a, front 025fc8e. Time budget: 4 h from 21:32 (user).

## Pre-flight scan
| Tasks | Shared | Producer → consumer | Finding |
|---|---|---|---|
| T1 → T2,T3,T4,T6,T7 | contract (Role, Permission, can, canManageMember, views) | T1 | consistent |
| T2 → T3,T5 | WebappRepository, record column names | T2 → SQL in T5 uses same names | consistent |
| T3 → T4 | WebappService, MockAppAuth, MockBillingProvider | T3 | consistent |
| T4 → T6,T7,T8 | HTTP routes and debug routes | T4 | consistent |
| T4 ↔ DN-09 | debug/tools.ts reset, compose, CORS | T4 modifies DN-09 files; DN-09 tests must stay green | consistent (gate in T4 step 4) |
| T6 → T7 | lib/app client/session/auth, bridge debugSignIn/debugPay | T6 | consistent |
| T5 ∥ T6 | different repos, no shared files | run in parallel after T4 | ok |
| each task | own tests vs code | — | consistent |

Ruling: T5 (back migration) and T6 (front client) run in parallel after T4 — why: different repos, no shared files, saves ~25 min of the 4 h budget — cost if wrong: none (separate git trees)
Ruling: maxRounds 2 per task review loop and sonnet reviewers except T3/T4 (opus) — why: 4 h budget; T3/T4 hold the security rules — cost if wrong: residual findings are parked for the user's review tomorrow
Execution: one workflow runs T1→T4, then T5∥T6, then T7, T8 (wf_152c651b-dbe, started 21:34); a first launch was stopped after a minute to fix the T8 review base (no changes left)
Task 1: complete (83a3b8a..a3618b7, review clean) — 558 back tests
Task 2: complete (a3618b7..8ee7fbb, review clean) — 586 tests
Task 3: complete (8ee7fbb..4df757a, review clean) — 609 tests; 8 mutation checks on security rules
Task 4: implemented 47f1a74, in review (22:29)
Task 4: complete (4df757a..47f1a74, review clean)
Task 5: complete (back 47f1a74..7027fb0, review clean) — migration in PGlite
Task 6: complete (front 025fc8e..25eab2f, review clean)
Task 7: implemented 1a26a72; review: 1 Important (org switch keeps page state: provider without key) → fix round running (23:14)
Task 7: fix round 1/2 (1 addressed, 0 open — provider keyed by org id; commits 1a26a72..eb8d054); complete
Task 8: complete (front eb8d054..9e9c4ee, back 7027fb0..95ff868, review clean) — smoke 5/5 twice; back 663 tests, front 389
All task minors and concerns: task-results-summary.txt (from the workflow journal)
Ruling: /app/billing shows the changed price; the mock checkout page shows no amount (back test proves createCheckout receives the new price) — cost if wrong: demo point 4 shown on the billing page, not on the checkout page
Final review: dispatched 23:46
User: machine shuts down at 01:50; nothing may keep running from 01:40 (no servers, no agents, no timers); do not leave mock running
Final review (3 opus lenses + adversarial verify, 00:00): 0 Critical; confirmed Important: invitation dedupe/removal leaves old links live; 402 table test missing; results CTA ignores email/role/payment; CTA + mock-checkout ship outside mock; paid panel drops demo disclosures/PARTIAL/action plan; DN-10 drift (claims header) verified as Minor
Ruling: final fix wave split into two parallel fixers, one per repo (final-fix-back.md, final-fix-front.md) instead of one — why: 01:40 hard stop; repos share no files — cost if wrong: two fixers instead of one
Ruling: the webapp CTA renders only in mock (literal guard) and mock-checkout is notFound outside mock — why: outside mock the back answers 501 until the real adapters land — cost if wrong: re-enable the CTA when adapters ship
Ruling: re-invite revokes the previous pending invitation (matches the migration comment); accept and remove revoke the email's other pending links — cost if wrong: an owner cannot keep two live links for one email
Final fix wave: dispatched 23:59 (back 95ff868, front 9e9c4ee)
Final fix wave: back 95ff868..ab0202d (8 commits, 670/670), front 9e9c4ee..7f2535c (10 commits, 412 tests, prod build 0 leaks); re-review: B1-B8 and F1-F8 all ADDRESSED, no new Critical/Important
Final: 2 re-review minors sent to a last short fixer (00:28): mock-checkout UI still in the production bundle (inert, 404); DN-10 missing the CTA rules
Final: parked — SaveResultsCta keeps busy after a 402 redirect (cosmetic, page navigates away)
Final: parked — F4 strip padding measured from CSS only; mock-checkout prerender .meta not 404-status (route answers notFound)
Last fixer: front 6838d6a (mock checkout out of the production bundle), back 9b23eb0 (DN-10 CTA rules)
Final verification by the controller (00:31-00:34): back build + 670/670; front 412 tests (1 failure in the first of 3 full runs, not reproducible: passed alone and in the next two full runs; test name not captured — likely the known timing flake), typecheck clean, lint 0 errors (6 pre-existing warnings), production build '[check-no-debug] 0 debug leak(s)'; ports 8080/3000 free; nothing left running
