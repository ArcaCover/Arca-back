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
