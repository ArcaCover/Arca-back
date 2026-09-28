# Crawl Robustness and Grounded Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Layer 1 website extraction survive the real-world crawl behavior that broke on `muscalaw.com` — a duplicated home page, a page budget consumed entirely by attorney bios, and a transient provider 503 that discarded the whole scan — and stop reporting "unknown" for two signals the crawl actually settled.

**Architecture:** Four independent, surgical fixes inside the existing Capa 1 pipeline, none of which touch the LLM prompts or the deterministic scoring core (`packages/scoring`). Two live in `crawler.ts` (URL identity, page budget). One lives in `nvidia-evidence-provider.ts`'s single HTTP call site (`complete()`). One is a new pure function (`negative-signal-grounding.ts`) wired in right after claims are grounded into `WebsiteData`. A closing design note records the decision to *not* force a verdict for the three AI-usage signals that cannot yet be certified the same way, and the accepted limit that a content-poor site is Layer 2's job, not Layer 1's.

**Tech Stack:** TypeScript, Vitest, Playwright (real Chromium via existing route-mocking harness), zod (`@arca/contracts`).

**Spec:** No separate spec file — this plan follows directly from the diagnosis reached in conversation (session of 2026-09-23/24) after two live scans of `muscalaw.com` on `SOURCE_MODE=live`. The four points and the evidence behind each are restated at the top of the task that implements them; the closing design note (Task 5) is the durable record.

## Global Constraints

- All code and comments in English; commit messages in English (CLAUDE.md §3 project convention, applies repo-wide to `Arca-back`).
- No change to `packages/scoring`: it stays a pure function of `Layer1Evidence` (DN-03). Everything here operates upstream, in evidence acquisition.
- No change to any LLM prompt (`SIGNAL_EXTRACTION_PROMPT`, `SIGNAL_REVIEW_PROMPT`, `ROSTER_PROMPT`, `PAGE_CLASSIFICATION_PROMPT`). All four fixes are deterministic, rule-based code.
- `maxRetries: 0` on the OpenAI client stays as-is (DN-05 §294/§530 forbid hidden SDK retries). Task 3 adds a bounded retry *above* the SDK, in application code, which is a different layer and does not contradict that decision.
- Every new test must run offline: no real network calls, no real Apify/OpenAI credentials. Playwright integration tests fake the transport exactly as `apps/api/tests/integration/crawler.test.ts` already does.
- Run `npm test` (full suite, from the repo root) after every task and confirm the count of passing tests only goes up, never down.

## Review Focus

- **A site with no privacy page and no blog at all** must keep `privacy_policy.found` and `ai_blog_posts.found` at `null`, not `false` — grounding requires having actually read a page of that type, never absence-of-evidence. Pinned in Task 4, "leaves both signals null when no matching page was read".
- **A page already carrying an accepted claim** (the model said `privacy_policy.found: true`) must never be overwritten by the grounding step. Pinned in Task 4, "never overrides a signal the model already claimed".
- **A permanent (non-transient) provider error**, such as a malformed request, must fail on the first attempt, not retry three times and waste the phase's time budget. Pinned in Task 3, "does not retry a non-transient provider error".
- **A crawl budget of `maxPages: 20` with far more than 20 discoverable links** must still terminate (not hang, not exceed the cap) once a per-group limit is introduced — the cap changes *which* pages fill the budget, never *whether* the loop terminates. Pinned in Task 2, by asserting `result.pages.length` stays within `maxPages`.
- **A relative link back to the page itself** (e.g. `<a href="/">`) must still canonicalize and dedupe correctly after the `www` normalization change — the fix must not regress the ordinary, non-`www` case. Pinned in Task 1's pure unit test, "strips the hash and query string as before".

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/pipeline/crawler.ts` | Modify | `canonicalUrl` gains `www` normalization (Task 1); the crawl loop gains a per-priority-group page cap (Task 2) |
| `apps/api/tests/unit/crawler.test.ts` | Create | Fast, browser-free unit tests for the pure `canonicalUrl` function |
| `apps/api/tests/integration/crawler.test.ts` | Modify | Two new real-browser tests: no duplicate home page, budget reserved for low-volume page types |
| `apps/api/src/pipeline/nvidia-evidence-provider.ts` | Modify | `complete()` gains a bounded retry for transient provider errors (Task 3); wires in `groundNegativeSignals` (Task 4) |
| `apps/api/tests/unit/nvidia-evidence-provider.test.ts` | Modify | New tests for the retry behavior (Task 3) and for the grounded-negative wiring (Task 4) |
| `apps/api/src/pipeline/negative-signal-grounding.ts` | Create | Pure function: turns an unknown `privacy_policy`/`ai_blog_posts` into a grounded `false` when the relevant page type was actually read |
| `apps/api/tests/unit/negative-signal-grounding.test.ts` | Create | Pure unit tests for `groundNegativeSignals`, no LLM mocking |
| `docs/design-notes/DN-07-crawl-coverage-and-grounded-negatives.md` | Create | Design note recording all four decisions, what was deliberately deferred, and the accepted limit for content-poor sites |

---

### Task 1: Canonicalize `www` so a redirect-linked home page is never fetched twice

**Root cause, verified against a real scan:** `muscalaw.com`'s crawl fetched `https://www.muscalaw.com/` twice, wasting one of its 20 pages. `canonicalUrl` strips `www.` only to *compare* hostnames, not in the string it *returns* — so a page reached as `https://muscalaw.com/` (the seed, no `www`) that links back to itself as `https://www.muscalaw.com/` (a common absolute logo/home link) produces a canonical URL that does not match the seed already in `visited`, and gets queued and crawled again as if it were a new page.

**Files:**
- Modify: `apps/api/src/pipeline/crawler.ts:44-51` (`canonicalUrl`)
- Test: `apps/api/tests/unit/crawler.test.ts` (new file)
- Test: `apps/api/tests/integration/crawler.test.ts` (add one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `canonicalUrl(raw: string, base: string): string | null` — same signature, now returns the `www`-stripped form for every URL on the canonical domain, so two spellings of the same page always produce the identical string.

- [x] **Step 1: Write the failing pure unit test**

Create `apps/api/tests/unit/crawler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalUrl } from '../../src/pipeline/crawler.js';

describe('canonicalUrl', () => {
  it('canonicalizes the www and bare-domain forms of the same page identically', () => {
    const base = 'https://muscalaw.com/';
    expect(canonicalUrl('https://www.muscalaw.com/', base)).toBe('https://muscalaw.com/');
    expect(canonicalUrl('https://muscalaw.com/', base)).toBe('https://muscalaw.com/');
  });

  it('still rejects a link to a different domain', () => {
    expect(canonicalUrl('https://other.example/', 'https://muscalaw.com/')).toBeNull();
  });

  it('strips the hash and query string as before', () => {
    expect(canonicalUrl('https://muscalaw.com/about?x=1#team', 'https://muscalaw.com/')).toBe('https://muscalaw.com/about');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/tests/unit/crawler.test.ts`
Expected: FAIL on the first test — `canonicalUrl('https://www.muscalaw.com/', base)` currently returns `'https://www.muscalaw.com/'` (keeps the `www`), not `'https://muscalaw.com/'`.

- [x] **Step 3: Fix `canonicalUrl`**

In `apps/api/src/pipeline/crawler.ts`, replace:

```ts
export function canonicalUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    const host = new URL(base).hostname.replace(/^www\./, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname.replace(/^www\./, '') !== host ||
      url.username || url.password || url.port || /\.(pdf|jpg|jpeg|png|gif|webp|zip|svg|mp4|css|js)$/i.test(url.pathname)) return null;
    url.hash = ''; url.search = '';
    return url.href;
  } catch { return null; }
}
```

with:

```ts
export function canonicalUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    const host = new URL(base).hostname.replace(/^www\./, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname.replace(/^www\./, '') !== host ||
      url.username || url.password || url.port || /\.(pdf|jpg|jpeg|png|gif|webp|zip|svg|mp4|css|js)$/i.test(url.pathname)) return null;
    url.hash = ''; url.search = '';
    // The same page reached with and without "www." must canonicalize to one identical string, or a
    // self-link in the other form (common on real sites: muscalaw.com's own home link) gets queued
    // and crawled a second time, spending a page of budget on content already read.
    url.hostname = host;
    return url.href;
  } catch { return null; }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/tests/unit/crawler.test.ts`
Expected: PASS, all three tests.

- [x] **Step 5: Write the failing integration test proving the duplicate fetch is gone**

In `apps/api/tests/integration/crawler.test.ts`, add a second `it` block after the existing one:

```ts
it('does not requeue the home page under its own www link', async () => {
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      // A logo link back to the www form is common on real sites (this is literally what
      // muscalaw.com does). Without www normalization it looks like a second, unvisited page
      // even though it points at the page already read.
      body: Buffer.from('<body>Home<a href="https://www.fixture.example/">Home</a></body>'),
    }),
  });
  expect(result.pages).toHaveLength(1);
}, 15_000);
```

- [x] **Step 6: Run the integration test to verify it passes**

Run: `npx vitest run apps/api/tests/integration/crawler.test.ts`
Expected: PASS, both tests in the file. (Step 3 already applied the fix, so this test should pass immediately — it exists to pin the fix at the real-browser level, not to drive a second implementation change.)

- [x] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: every test passes; total test count is higher than before this task.

```bash
git add apps/api/src/pipeline/crawler.ts apps/api/tests/unit/crawler.test.ts apps/api/tests/integration/crawler.test.ts
git commit -m "Canonicalize www so a self-linked home page is never crawled twice"
```

---

### Task 2: Reserve crawl budget so one deep page type cannot starve the others

**Root cause, verified against the same scan:** `muscalaw.com`'s 20-page budget was consumed by the home page (once Task 1 lands) plus criminal-defense service pages plus **15 individual attorney bio pages** — all ranked priority group 2 by `pagePriority`, ahead of `privacy` (group 4) and `blog` (group 5). No privacy page and no blog page were ever reached, which is why `ai_policy`, `ai_in_services`, `ai_disclosure`, `ai_blog_posts` and `privacy_policy` all came back `null`: the crawler never even looked.

**Files:**
- Modify: `apps/api/src/pipeline/crawler.ts:131-134` (the crawl loop's batch selection)
- Test: `apps/api/tests/integration/crawler.test.ts` (add one test)

**Interfaces:**
- Consumes: `pagePriority(url: string): number` (already exported, unchanged).
- Produces: no new exported symbol. The crawl loop's *behavior* changes: a priority-2 page (`team`/`attorney`) is capped at 3 visits per crawl; every other group is uncapped, as before.

- [x] **Step 1: Write the failing integration test**

In `apps/api/tests/integration/crawler.test.ts`, add a third `it` block:

```ts
it('reserves budget for privacy and blog pages instead of letting many attorney bios crowd them out', async () => {
  const body = (path: string) => {
    if (path === '/') {
      const bios = Array.from({ length: 6 }, (_, i) => `<a href="/team/person-${i + 1}">Person ${i + 1}</a>`).join('');
      return `<body>${bios}<a href="/privacy">Privacy</a><a href="/blog">Blog</a></body>`;
    }
    if (path === '/privacy') return '<body>Privacy policy text</body>';
    if (path === '/blog') return '<body>Blog index</body>';
    return '<body>Attorney bio</body>';
  };
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(body(new URL(raw).pathname)),
    }),
  }, { maxPages: 6 });
  const paths = result.pages.map(page => new URL(page.url).pathname).sort();
  expect(paths).toContain('/privacy');
  expect(paths).toContain('/blog');
  const attorneyPages = paths.filter(path => path.startsWith('/team/person-'));
  expect(attorneyPages.length).toBeLessThanOrEqual(3);
  expect(paths).toHaveLength(6);
}, 15_000);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/tests/integration/crawler.test.ts`
Expected: FAIL — with a budget of 6 and no per-group cap, the sort order (`depth`, then `pagePriority`, then URL) fills all remaining 5 slots with `/team/person-1` through `/team/person-5` before `/privacy` (priority 4) or `/blog` (priority 5) ever get a turn. `paths` will not contain `/privacy` or `/blog`.

- [x] **Step 3: Add the per-group cap to the crawl loop**

In `apps/api/src/pipeline/crawler.ts`, add this constant right after `pagePriority`'s definition (after the closing brace that currently ends around line 42, before `export function canonicalUrl`):

```ts
/** Caps how many pages of one priority group a single crawl will visit. Without it a firm with many
    attorney bios (priority group 2, muscalaw.com had 15) fills the whole page budget before privacy
    or blog — lower-priority groups that settle real signals — ever get a turn. Only group 2 is capped:
    it is the one observed to explode in page count; the others stay uncapped as before. */
const GROUP_PAGE_LIMITS: Partial<Record<number, number>> = { 2: 3 };
```

Then replace the loop body at `crawler.ts:131-134`:

```ts
    while (queue.length && visited.size < maxPages && !signal.aborted) {
      queue.sort((a, b) => a.depth - b.depth || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url));
      const batch = queue.splice(0, Math.min(3, maxPages - visited.size)).filter(item => !visited.has(item.url));
      for (const item of batch) visited.add(item.url);
```

with:

```ts
    const groupCounts = new Map<number, number>();
    while (queue.length && visited.size < maxPages && !signal.aborted) {
      queue.sort((a, b) => a.depth - b.depth || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url));
      const underGroupLimit = (item: { url: string }) => {
        const limit = GROUP_PAGE_LIMITS[pagePriority(item.url)];
        return limit === undefined || (groupCounts.get(pagePriority(item.url)) ?? 0) < limit;
      };
      const capacity = Math.min(3, maxPages - visited.size);
      const eligible = queue.filter(underGroupLimit);
      // Falling back to over-limit items only once nothing else is queued keeps the reservation from
      // wasting budget: a site with no blog or privacy page should not leave slots unused.
      const pool = eligible.length ? eligible : queue;
      const batch = pool.slice(0, capacity).filter(item => !visited.has(item.url));
      for (const item of batch) queue.splice(queue.indexOf(item), 1);
      for (const item of batch) {
        visited.add(item.url);
        groupCounts.set(pagePriority(item.url), (groupCounts.get(pagePriority(item.url)) ?? 0) + 1);
      }
```

The rest of the loop body (the `await Promise.all(batch.map(...))` block and everything after it, `crawler.ts:135` onward) is unchanged — `batch` still has the same shape and meaning, just a different selection rule feeding it.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/api/tests/integration/crawler.test.ts`
Expected: PASS, all three tests in the file. With the cap, the batch selection at each round prefers non-team-group pages once 3 team pages are visited, so `/privacy` and `/blog` (both uncapped, lower numeric priority than nothing left to compete with once team hits its cap) fill the remaining 2 of the 6-page budget.

- [x] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: every test passes, including the three existing `pagePriority`-only tests in `apps/api/tests/unit/identity-extraction.test.ts` (unaffected — this task never touches `pagePriority` itself, only how the queue consumes its output).

```bash
git add apps/api/src/pipeline/crawler.ts apps/api/tests/integration/crawler.test.ts
git commit -m "Cap attorney-bio pages per crawl so privacy and blog pages are not starved"
```

---

### Task 3: Bounded retry for a transient provider error, per phase

**Root cause, verified against a real scan:** `muscalaw.com`'s second live scan failed with `analysis: null`, `diagnostics.error: "503 Service temporarily overloaded"` at page 7 of the crawl (7 pages, not the 20 from Task 2's scenario — this was a genuinely different failure, a transient upstream error, not the page-budget problem Tasks 1–2 fix). The provider client is built with `maxRetries: 0` (`nvidia-evidence-provider.ts:142`), a deliberate choice per DN-05 §294/§530 to forbid the SDK's own hidden retries. But DN-05's own evaluation (§4.4, 2026-09-13) already found the gap this leaves: *"`maxRetries: 0` hace que un 500 o un timeout transitorio descarte más de 200 s de trabajo ya pagado en tokens. No hay reintento acotado por fase ni checkpoint."* — and its recommendation #9: *"Reintento acotado por fase ante 5xx y timeout, dentro del presupuesto global."* This task implements exactly that recommendation, once, at the one call site every phase already funnels through.

**Files:**
- Modify: `apps/api/src/pipeline/nvidia-evidence-provider.ts:1` (imports), `nvidia-evidence-provider.ts:146-157` (`complete()`)
- Test: `apps/api/tests/unit/nvidia-evidence-provider.test.ts` (add four tests)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `export const MAX_TRANSIENT_ATTEMPTS = 3` and `export function isTransientProviderError(error: unknown): boolean`, both from `nvidia-evidence-provider.ts`, importable by tests. `complete()`'s external behavior (return type, what it throws on permanent failure) is unchanged — only how many times it tries before throwing.

- [x] **Step 1: Write the failing tests**

In `apps/api/tests/unit/nvidia-evidence-provider.test.ts`, add these four tests inside the existing `describe('NVIDIA evidence provider', () => { ... })` block, after the existing `'records a link that cannot be fetched and keeps the extraction'` test (or anywhere else inside the same `describe`):

```ts
  it('retries a transient provider error within one phase and keeps the failed attempt for audit', async () => {
    let calls = 0;
    const create = vi.fn(async (request: Record<string, unknown>) => {
      calls++;
      if (calls === 1) {
        const error = Object.assign(new Error('Service temporarily overloaded'), { status: 503 });
        throw error;
      }
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      const content = user.startsWith('CANDIDATE CLAIMS') ? JSON.stringify({ verdicts: [] })
        : JSON.stringify({ claims: [], action: { type: 'finish', reason: 'done' } });
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    });
    const provider = withoutPagePlan('key', undefined, { chat: { completions: { create } } });
    const result = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }],
      partial: false }, new AbortController().signal);
    expect(result.websiteData.firm_name).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
    const failed = result.diagnostics.attempts.find(attempt => attempt.validationIssues?.includes('503'));
    expect(failed).toBeDefined();
  });

  it('retries a client-side timeout the same as a 5xx', async () => {
    let calls = 0;
    const create = vi.fn(async (request: Record<string, unknown>) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Request timed out'), { name: 'APIConnectionTimeoutError' });
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      const content = user.startsWith('CANDIDATE CLAIMS') ? JSON.stringify({ verdicts: [] })
        : JSON.stringify({ claims: [], action: { type: 'finish', reason: 'done' } });
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    });
    const provider = withoutPagePlan('key', undefined, { chat: { completions: { create } } });
    await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }],
      partial: false }, new AbortController().signal);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient provider error', async () => {
    const create = vi.fn(async () => { throw Object.assign(new Error('Invalid request'), { status: 400 }); });
    const provider = withoutPagePlan('key', undefined, { chat: { completions: { create } } });
    const failure = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }],
      partial: false }, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtractionFailure);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting the bounded retries for a persistent transient error', async () => {
    const create = vi.fn(async () => { throw Object.assign(new Error('Service temporarily overloaded'), { status: 503 }); });
    const provider = withoutPagePlan('key', undefined, { chat: { completions: { create } } });
    const failure = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }],
      partial: false }, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtractionFailure);
    expect(create).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS);
  });
```

Add `MAX_TRANSIENT_ATTEMPTS` to the existing import from the provider module at the top of the file:

```ts
import { ExtractionFailure, NvidiaNimEvidenceProvider } from '../../src/pipeline/nvidia-evidence-provider.js';
```

becomes:

```ts
import { ExtractionFailure, MAX_TRANSIENT_ATTEMPTS, NvidiaNimEvidenceProvider } from '../../src/pipeline/nvidia-evidence-provider.js';
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/tests/unit/nvidia-evidence-provider.test.ts`
Expected: FAIL. The first two new tests fail because `create` is only ever called once today (no retry exists) — `extractDetailed` throws `ExtractionFailure` instead of returning a result, since the synthetic error propagates straight out of `complete()`. The import of `MAX_TRANSIENT_ATTEMPTS` fails to resolve (not yet exported), which alone is enough to fail the whole file — that is expected at this step.

- [x] **Step 3: Add the bounded retry to `complete()`**

In `apps/api/src/pipeline/nvidia-evidence-provider.ts`, add `delay` to the imports. Replace line 1:

```ts
import OpenAI from 'openai';
```

with:

```ts
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
```

Add the exported constant and classifier function right after `export const MAX_AGENT_ROUNDS = 3;` (currently `nvidia-evidence-provider.ts:17`):

```ts
export const MAX_AGENT_ROUNDS = 3;
/** Bounded so one flaky call cannot loop forever; each phase gets its own budget of attempts. */
export const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_RETRY_BACKOFF_MS = [250, 750];

/**
 * A raw transport failure the OpenAI SDK did not retry itself (maxRetries: 0, by design — DN-05
 * §294/§530 forbid hidden SDK retries). Only 5xx and a client-side connection timeout are worth one
 * more try: a 4xx means the request itself is wrong, and repeating it only wastes the phase's budget.
 * Duck-typed rather than `instanceof OpenAI.APIError` so a plain test double does not need to
 * construct a real SDK error to exercise this path.
 */
export function isTransientProviderError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'APIConnectionTimeoutError' || name === 'APIConnectionError';
}
```

Then replace `complete()` (`nvidia-evidence-provider.ts:146-157`):

```ts
  private async complete(phase: string, system: string, user: string, signal: AbortSignal, attempts: Attempt[]) {
    const request = { model: this.model, stream: false, ...this.endpoint.requestParams(this.model),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' } };
    const started = Date.now();
    const response = await this.client.chat.completions.create(request, { signal });
    // Record the attempt before validating it: truncated or malformed answers are the ones worth auditing.
    const attempt: Attempt = { phase, request, response, rawContent: '', durationMs: Date.now() - started };
    attempts.push(attempt);
    attempt.rawContent = responseText(response);
    return json(attempt.rawContent);
  }
```

with:

```ts
  private async complete(phase: string, system: string, user: string, signal: AbortSignal, attempts: Attempt[]) {
    const request = { model: this.model, stream: false, ...this.endpoint.requestParams(this.model),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' } };
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const label = attempt === 1 ? phase : `${phase}-attempt-${attempt}`;
      try {
        const response = await this.client.chat.completions.create(request, { signal });
        // Record the attempt before validating it: truncated or malformed answers are the ones worth auditing.
        const record: Attempt = { phase: label, request, response, rawContent: '', durationMs: Date.now() - started };
        attempts.push(record);
        record.rawContent = responseText(response);
        return json(record.rawContent);
      } catch (error) {
        if (!isTransientProviderError(error) || attempt >= MAX_TRANSIENT_ATTEMPTS || signal.aborted) throw error;
        const status = (error as { status?: unknown }).status;
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ phase: label, request, response: null, rawContent: '', durationMs: Date.now() - started,
          validationIssues: `Transient provider error${typeof status === 'number' ? ` (status ${status})` : ''}: ${message}` });
        await delay(TRANSIENT_RETRY_BACKOFF_MS[attempt - 1] ?? TRANSIENT_RETRY_BACKOFF_MS.at(-1)!, undefined, { signal });
      }
    }
  }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/tests/unit/nvidia-evidence-provider.test.ts`
Expected: PASS, all tests in the file — the four new ones and every pre-existing one (the schema-repair test in particular: a schema-invalid-but-HTTP-successful response never enters the `catch` branch, so its `attempts` sequence of `['extract-round-1', 'extract-round-1-repair']` is unaffected).

- [x] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: every test passes; total test count is higher than before this task.

```bash
git add apps/api/src/pipeline/nvidia-evidence-provider.ts apps/api/tests/unit/nvidia-evidence-provider.test.ts
git commit -m "Retry a transient provider error up to three times per phase"
```

---

### Task 4: Ground `privacy_policy` and `ai_blog_posts` to false when the deciding page was actually read

**Design decision, not a bug fix:** today the extraction leaves a field `null` whenever the model made no claim about it. That is correct when the relevant page was never reached — but once we *know* it was reached, staying `null` throws away information the crawl already paid for. `privacy_policy` and `ai_blog_posts` are the two signals where "the one page that would answer this" is identifiable after the fact from the page-type classification the pipeline already computes (`pageTypes`, built in `runWorkflow` from `majorityPageTypes` — see `page-types.ts`). `ai_policy`, `ai_in_services` and `ai_disclosure` are deliberately **not** touched here: they can appear on any page, so certifying their absence would require knowing the crawl covered the *whole* site, and `CrawlResult` does not yet expose that (`crawl.partial` means "a page failed unrecoverably", not "the queue ran out before the budget did" — confirmed by reading `crawler.ts`'s loop: it can exit with `partial: false` while pages remained queued, simply because `maxPages` was reached). This gap is recorded, not silently dropped, in Task 5.

**Files:**
- Create: `apps/api/src/pipeline/negative-signal-grounding.ts`
- Test: `apps/api/tests/unit/negative-signal-grounding.test.ts` (new file)
- Modify: `apps/api/src/pipeline/nvidia-evidence-provider.ts:6` (imports), `nvidia-evidence-provider.ts:292` (wiring)
- Test: `apps/api/tests/unit/nvidia-evidence-provider.test.ts` (add one integration-style test)

**Interfaces:**
- Consumes: `heuristicPageType(url: string): PageType` and `type PageType` (already exported from `page-types.ts`, unchanged). `WebsiteData` from `@arca/contracts` (unchanged). `CrawlResult` from `crawler.ts` (unchanged).
- Produces: `export function groundNegativeSignals(data: WebsiteData, crawl: CrawlResult, pageTypes: Map<string, PageType>): WebsiteData` from the new file `negative-signal-grounding.ts`.

- [x] **Step 1: Write the failing pure unit tests**

Create `apps/api/tests/unit/negative-signal-grounding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { groundNegativeSignals } from '../../src/pipeline/negative-signal-grounding.js';

describe('groundNegativeSignals', () => {
  it('grounds privacy_policy to false when the privacy page was read and made no claim', () => {
    const crawl = { pages: [{ url: 'https://firm.com/privacy-policy', html: '', text: 'We do not sell your data.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map());
    expect(result.privacy_policy).toEqual({ found: false, mentions_client_data: null });
    expect(result.provenance.privacy_policy?.[0]).toMatchObject({ sourceUrl: 'https://firm.com/privacy-policy', method: 'derived' });
  });

  it('grounds ai_blog_posts to false when a blog page was read and made no claim', () => {
    const crawl = { pages: [{ url: 'https://firm.com/blog', html: '', text: 'Recent case wins.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map());
    expect(result.ai_blog_posts).toEqual({ found: false, count: 0, titles: [] });
  });

  it('leaves both signals null when no matching page was read', () => {
    const crawl = { pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map());
    expect(result.privacy_policy.found).toBeNull();
    expect(result.ai_blog_posts.found).toBeNull();
  });

  it('never overrides a signal the model already claimed', () => {
    const data = { ...unknownWebsite(), privacy_policy: { found: true, mentions_client_data: true } };
    const crawl = { pages: [{ url: 'https://firm.com/privacy-policy', html: '', text: 'We use your data for marketing.' }], partial: false };
    const result = groundNegativeSignals(data, crawl, new Map());
    expect(result.privacy_policy).toEqual({ found: true, mentions_client_data: true });
  });

  it('uses the page-type classification map over the URL heuristic when both are available', () => {
    // The URL alone reads as neither privacy nor blog (heuristicPageType would call it "other"); the
    // agent's own classification vote is what tells us this specific page is the privacy page.
    const crawl = { pages: [{ url: 'https://firm.com/legal-info', html: '', text: 'No AI use disclosed.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map([['https://firm.com/legal-info', 'privacy']]));
    expect(result.privacy_policy.found).toBe(false);
    expect(result.ai_blog_posts.found).toBeNull();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/tests/unit/negative-signal-grounding.test.ts`
Expected: FAIL — the module `../../src/pipeline/negative-signal-grounding.js` does not exist yet.

- [x] **Step 3: Implement `groundNegativeSignals`**

Create `apps/api/src/pipeline/negative-signal-grounding.ts`:

```ts
import type { WebsiteData } from '@arca/contracts';
import type { CrawlResult } from './crawler.js';
import { heuristicPageType, type PageType } from './page-types.js';

/**
 * Converts an unknown signal into a grounded false when the one page that would answer it was
 * actually read and said nothing that supports it. The extraction leaves a field null whenever the
 * model made no claim about it; that is correct when the relevant page was never reached, but wrong
 * once we know it was — a privacy page read in full with no policy claim IS evidence of no policy,
 * not an unknown. Only privacy_policy and ai_blog_posts are grounded here: both have one page type
 * that settles them (the privacy page; the blog index). ai_policy, ai_in_services and ai_disclosure
 * can appear on any page, so certifying their absence would require knowing the crawl covered the
 * whole site, which CrawlResult does not yet track — see DN-07.
 */
export function groundNegativeSignals(data: WebsiteData, crawl: CrawlResult, pageTypes: Map<string, PageType>): WebsiteData {
  const typeOf = (url: string) => pageTypes.get(url) ?? heuristicPageType(url);
  const readUrlOfType = (type: PageType) => crawl.pages.find(page => typeOf(page.url) === type)?.url;
  const provenance = { ...data.provenance };

  let privacy_policy = data.privacy_policy;
  if (privacy_policy.found === null) {
    const privacyUrl = readUrlOfType('privacy');
    if (privacyUrl) {
      privacy_policy = { found: false, mentions_client_data: null };
      provenance.privacy_policy = [{ sourceUrl: privacyUrl,
        excerpt: 'Privacy page was read; no policy claim was accepted from it', method: 'derived' }];
    }
  }

  let ai_blog_posts = data.ai_blog_posts;
  if (ai_blog_posts.found === null) {
    const blogUrl = readUrlOfType('blog');
    if (blogUrl) {
      ai_blog_posts = { found: false, count: 0, titles: [] };
      provenance.ai_blog_posts = [{ sourceUrl: blogUrl,
        excerpt: 'Blog page was read; no AI-related post was accepted from it', method: 'derived' }];
    }
  }

  return { ...data, privacy_policy, ai_blog_posts, provenance };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/tests/unit/negative-signal-grounding.test.ts`
Expected: PASS, all five tests.

- [x] **Step 5: Write the failing wiring test**

In `apps/api/tests/unit/nvidia-evidence-provider.test.ts`, add one more test inside the `describe('NVIDIA evidence provider', ...)` block:

```ts
  it('grounds privacy_policy and ai_blog_posts to false when their pages were read end to end', async () => {
    const pages = [
      { url: 'https://firm.com/', html: '', text: 'Smith Law is a law firm.' },
      { url: 'https://firm.com/privacy-policy', html: '', text: 'We collect basic analytics.' },
      { url: 'https://firm.com/blog', html: '', text: 'Recent wins in court.' },
    ];
    const create = vi.fn(async (request: Record<string, unknown>) => {
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      const content = user.startsWith('CANDIDATE CLAIMS') ? JSON.stringify({ verdicts: [] })
        : JSON.stringify({ claims: [], action: { type: 'finish', reason: 'done' } });
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    });
    const provider = withoutPagePlan('key', undefined, { chat: { completions: { create } } });
    const result = await provider.extractDetailed({ pages, partial: false }, new AbortController().signal);
    expect(result.websiteData.privacy_policy).toEqual({ found: false, mentions_client_data: null });
    expect(result.websiteData.ai_blog_posts).toEqual({ found: false, count: 0, titles: [] });
    expect(result.websiteData.provenance.privacy_policy?.[0]).toMatchObject({
      sourceUrl: 'https://firm.com/privacy-policy', method: 'derived',
    });
  });
```

- [x] **Step 6: Run the test to verify it fails**

Run: `npx vitest run apps/api/tests/unit/nvidia-evidence-provider.test.ts`
Expected: FAIL — `result.websiteData.privacy_policy` is currently `{ found: null, mentions_client_data: null }` (nothing grounds it yet).

- [x] **Step 7: Wire `groundNegativeSignals` into the workflow**

In `apps/api/src/pipeline/nvidia-evidence-provider.ts`, add the import. Replace line 6:

```ts
import { acceptClaims, toWebsiteData } from './signal-grounding.js';
```

with:

```ts
import { acceptClaims, toWebsiteData } from './signal-grounding.js';
import { groundNegativeSignals } from './negative-signal-grounding.js';
```

Then replace the single line at `nvidia-evidence-provider.ts:292`:

```ts
    const accepted = toWebsiteData(grounded.accepted, corpus);
```

with:

```ts
    const accepted = groundNegativeSignals(toWebsiteData(grounded.accepted, corpus), crawl, pageTypes);
```

`crawl` and `pageTypes` are already in scope at this point in `runWorkflow` (verify: `crawl` is assigned at the top of the method and updated by `merge()`; `pageTypes` is assigned by `majorityPageTypes(...)` a few lines above `acquisitionFloor` and never reassigned after).

- [x] **Step 8: Run the test to verify it passes**

Run: `npx vitest run apps/api/tests/unit/nvidia-evidence-provider.test.ts`
Expected: PASS, all tests in the file, including every test from Task 3.

- [x] **Step 9: Run the full suite and commit**

Run: `npm test`
Expected: every test passes; total test count is higher than before this task.

```bash
git add apps/api/src/pipeline/negative-signal-grounding.ts apps/api/tests/unit/negative-signal-grounding.test.ts apps/api/src/pipeline/nvidia-evidence-provider.ts apps/api/tests/unit/nvidia-evidence-provider.test.ts
git commit -m "Ground privacy_policy and ai_blog_posts to false when their page was actually read"
```

---

### Task 5: Record the decisions in a design note

This task has no code. Its deliverable is the durable record of *why* Tasks 1–4 look the way they do, what was deliberately left out of Task 4's scope, and the explicit acceptance — the fourth point from the original conversation — that a site with genuinely little content is not a Layer 1 defect to chase further; it is what Layer 2's questionnaire exists for.

**Files:**
- Create: `docs/design-notes/DN-07-crawl-coverage-and-grounded-negatives.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks.

- [x] **Step 1: Write the design note**

Create `docs/design-notes/DN-07-crawl-coverage-and-grounded-negatives.md`:

```markdown
# DN-07 — Crawl coverage and grounded negatives

Written after two live scans of `muscalaw.com` on `SOURCE_MODE=live` (2026-09-23/24) surfaced three
distinct failures in one session: a duplicated home page, a page budget consumed entirely by attorney
bios, and a transient NVIDIA 503 that discarded the whole scan. None of the three were about the LLM's
capability — switching models (`gpt-4.1-mini`, `gpt-6-luna`) changed nothing, because the crawl never
handed either model a privacy page, a blog page, or anything resembling AI-usage content to read.

## 1. www is one identity, not two

`canonicalUrl` stripped `www.` only to compare hostnames, never in the string it returned. A page
reached without `www` that links back to itself with `www` (muscalaw.com's own logo link) produced two
different canonical strings for one page, and the second spelling got queued and crawled again. Fixed
by normalizing the returned hostname too, so both spellings always canonicalize identically.

## 2. One page type must not be able to starve every other

muscalaw.com's 20-page budget went to the home page, three service pages, and fifteen individual
attorney bios — all priority group 2 in `pagePriority`. Privacy (group 4) and blog (group 5) were never
reached. `ai_policy`, `ai_in_services`, `ai_disclosure`, `ai_blog_posts` and `privacy_policy` all came
back `null` because the crawler never looked, not because the content wasn't there.

Fix: cap group 2 (team/attorney pages) at 3 visits per crawl. Only that group is capped — it is the one
observed to explode in page count on a real site; every other group is unchanged. The cap yields budget
back to lower-priority groups only once it is reached, and never wastes budget on a site that has fewer
than 3 such pages to begin with.

**Not addressed here, flagged for calibration:** the cap of 3 is a first value, chosen because a team
listing page plus one or two individual profiles is enough for `W5a_teamPageQuality`'s own judgment
(`derived-signals.ts`), not derived from measurement across many real sites. Revisit once there is
outcome data from more than one firm.

## 3. A transient provider error must not discard the whole scan

`maxRetries: 0` on the OpenAI-compatible client is deliberate (§294/§530 of DN-05): the SDK's own
blind retries are forbidden. But DN-05's own evaluation on 2026-09-13 already found what that leaves
unhandled — a 500 or a timeout discards more than 200 seconds of already-paid token work, with no
retry at any phase (§4.4), and recommended a bounded, per-phase retry within the global budget (#9).

That recommendation is now implemented, once, at `complete()` — the one call site every phase already
funnels through. Up to `MAX_TRANSIENT_ATTEMPTS` (3) tries per phase, short fixed backoff (250ms,
750ms) between them, and only for 5xx or a client-side connection timeout — never for a 4xx, which
means the request itself is wrong and retrying only wastes the phase's budget. This is a different
layer from the SDK's own retry: DN-05 forbids the SDK silently retrying *without our knowledge*; this
retry is explicit, bounded, and every failed attempt is still recorded in `diagnostics.attempts` for
audit, exactly as a schema-repair attempt already was.

**Not addressed here:** the backoff values (250ms, 750ms) are a reasonable starting guess, not
calibrated against real provider recovery times. DN-05's larger, still-open item — a genuine
per-phase *deadline* budget threaded through `InProcessPipeline` (§6 of DN-05-agentic-signal-extraction)
— is unrelated in scope and not attempted here; this retry respects the existing `AbortSignal` only.

## 4. A read page is evidence; an unread page is not

The extraction leaves a field `null` whenever no claim was made about it. That's correct when the
relevant page was never reached — wrong once we know it was. `privacy_policy` and `ai_blog_posts` are
grounded to `false` when the page-type classification (`pageTypes`, already computed in `runWorkflow`)
shows a `privacy`- or `blog`-typed page was actually fetched and no claim was accepted from it. Nothing
here adds a new LLM call or changes a prompt; it's a pure post-processing step over data the pipeline
already produces.

**Deliberately not grounded:** `ai_policy`, `ai_in_services` and `ai_disclosure`. Unlike a privacy
policy or a blog, these can appear on *any* page — the home page, an "about" page, a dedicated policy
page, or nowhere identifiable at all. Certifying their absence honestly would require knowing the crawl
covered the whole site, not just that it didn't fail. `CrawlResult.partial` does not mean that today:
it means a page failed unrecoverably, and the loop can legitimately exit with `partial: false` while
pages remained queued, simply because `maxPages` was reached first. Grounding these three signals needs
an explicit "queue exhausted vs. budget exhausted" flag on `CrawlResult` that does not exist yet. Until
it does, they stay `null` when the model finds nothing — an honest unknown, not a manufactured false
that would either wrongly clear a firm that never published anything, or wrongly penalize one whose
policy lives on a page this crawl didn't happen to reach.

## 5. A quiet site is Layer 2's problem, not Layer 1's

Some firm websites will always fail to say much of anything — a single-page brochure site, or one that
renders entirely client-side in a way the crawler cannot read. That is not a Layer 1 defect to keep
chasing with more crawling cleverness: `preScore.assessmentStatus = INSUFFICIENT_EVIDENCE` already
exists precisely to say "we don't know, ask more", and Capa 2's questionnaire (§6.3 of CLAUDE.md) is
where a firm with no readable public content gets the chance to answer directly. Layer 1's job is to
read what a normal, crawlable site publishes and ground what it certifiably didn't find — not to
guarantee a verdict for every site regardless of what it published.
```

- [x] **Step 2: Commit**

```bash
git add docs/design-notes/DN-07-crawl-coverage-and-grounded-negatives.md
git commit -m "Add DN-07: crawl coverage and grounded negatives design note"
```
