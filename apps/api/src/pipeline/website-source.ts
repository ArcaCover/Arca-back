import { createHash } from 'node:crypto';
import { WebsiteData, type WebsiteSource, type SourceResult } from '@arca/contracts';
import { crawlWebsite, type CrawlResult } from './crawler.js';
import { corpusFingerprint } from './evidence-corpus.js';
import { createRobotsCache, type RobotsCache } from './robots.js';
import { crawlNotes, partialCrawlCode, unreadableWebsite } from './website-outcome.js';
import type { ScanRepository } from '../repositories/types.js';
import { OpenAIEvidenceProvider, type WebsiteEvidenceProvider } from './website-evidence-provider.js';
import type OpenAI from 'openai';
import { scanMeter } from './scan-cost.js';
import { STORED_PAGE_FORMAT, storedPages } from './stored-pages.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Crawl = (domain: string, signal: AbortSignal, robots: RobotsCache) => Promise<CrawlResult>;
const crawlSite: Crawl = (domain, signal, robots) => crawlWebsite(domain, signal, undefined, { robots });

/** How long a stored analysis may stand in for a new extraction, counted from the day the provider produced it. */
export const WEBSITE_SIGNAL_REUSE_MAX_AGE_MS = 30 * 86_400_000;
/** Stored records read, at most, to find one analysis. Each is megabytes, so the number stays small. */
const REUSE_CANDIDATES = 3;
/**
 * What a stored website record says about the analysis it holds, so a later scan can find it and trust it.
 * `key` names the evidence the analysis was extracted from and the provider version that read it; `full` is set
 * only when that evidence came from a complete crawl. Both are plain tokens the repository can search for without
 * reading the record. A record that reuses an analysis copies all of this and points `from` at the scan that
 * extracted it, so reuse never makes an analysis look younger than it is.
 */
type Reuse = { key: string; full: string | null; pages: number; analyzedAt: string; from: string | null };
type Stored = { analysis: WebsiteData; reuse: Reuse };

/** Crawling/extraction orchestration. This is upstream from the deterministic Layer 1 core. */
export class WebsiteExtractionSource implements WebsiteSource {
  constructor(private readonly repository: ScanRepository, private readonly provider: WebsiteEvidenceProvider,
    private readonly crawl: Crawl = crawlSite,
    /** `reuseMaxAgeMs`: 0 extracts on every scan. */
    private readonly options: { reuseMaxAgeMs?: number; now?: () => number } = {}) {}

  /**
   * The newest stored analysis of the domain that carries `marker` and is still inside the age cap. A record that
   * cannot be read or does not hold a valid analysis is skipped, and so is the whole lookup when storage fails:
   * the caller then extracts, which costs a model call but never the scan.
   */
  private async stored(domain: string, field: 'key' | 'full', marker: string, since: string): Promise<Stored | null> {
    try {
      for (const candidate of await this.repository.findRaw(domain, 'website', marker, since, REUSE_CANDIDATES)) {
        const raw = await this.repository.rawOf(candidate.scan_id, 'website');
        if (!raw) continue;
        try {
          const record = JSON.parse(raw.raw_content);
          const reuse = record.reuse as Reuse;
          if (record.provider !== this.provider.id || record.version !== this.provider.version || reuse[field] !== marker) continue;
          if (!(Date.parse(reuse.analyzedAt) >= Date.parse(since))) continue;
          return { analysis: WebsiteData.parse(record.analysis), reuse: { ...reuse, from: reuse.from ?? raw.scan_id } };
        } catch { /* Invalid or incompatible historic evidence cannot supply an analysis. */ }
      }
    } catch (error) {
      console.error('[website] stored analysis lookup failed', error instanceof Error ? error.message : 'Unknown error');
    }
    return null;
  }

  async run(domain: string, signal: AbortSignal): Promise<SourceResult<WebsiteData>> {
    const start = Date.now();
    // One robots cache for the whole scan: the crawl and every page, document or sitemap the extraction asks for share it.
    const robots = createRobotsCache();
    const crawl = await this.crawl(domain, signal, robots);
    // The record keeps each page's text and the parts of its HTML the backend reads, not the full HTML (DN-12 §15.5).
    // Everything below, the extraction and the reuse key included, reads `crawl` itself.
    const base = { provider: this.provider.id, version: this.provider.version, pageFormat: STORED_PAGE_FORMAT,
      pages: storedPages(crawl.pages), issues: crawl.issues ?? [],
      // How the sitemap read that seeded the crawl went: a crawl that started from other pages is explained by it.
      ...(crawl.sitemap ? { sitemap: crawl.sitemap } : {}) };
    if (!crawl.pages.length) {
      const { classification, ...outcome } = unreadableWebsite(crawl);
      return { data: null, rawContent: JSON.stringify({ ...base, analysis: null, unreadable: classification }),
        status: { ...outcome, dataStatus: 'UNKNOWN', durationMs: Date.now() - start, pagesCrawled: 0 } };
    }
    // Same firm, same signals (DN-12 §4.3): an analysis is reused when the provider would read the same evidence
    // again. The key is the firm's own content as the extraction reads it (text, metadata, links), without the
    // furniture every page repeats and without the bodies of news and blog pages, and never the HTML, which changes
    // on every visit to most sites. It changes with the provider version, which covers the model and its prompts.
    // wsk2- names that reading; a record keyed wsk1- (every page's full text) is never found by a wsk2- key, so it
    // is simply not reused. `full` does not depend on the fingerprint and keeps its name: a complete reading stored
    // under wsk1- still stands in for a crawl that was cut short.
    const version = JSON.stringify([this.provider.id, this.provider.version]);
    const key = `wsk2-${hash(`${version}\n${corpusFingerprint(crawl)}`)}`, full = `wsf1-${hash(version)}`;
    const now = (this.options.now ?? Date.now)(), maxAge = this.options.reuseMaxAgeMs ?? WEBSITE_SIGNAL_REUSE_MAX_AGE_MS;
    const since = new Date(now - maxAge).toISOString();
    // A crawl that was cut short never replaces what a complete one gave: its thinner evidence would only lose
    // signals the firm still shows. The stored analysis stands until a complete crawl reads the site again.
    const lookup = (field: 'key' | 'full', marker: string) => maxAge > 0 ? this.stored(domain, field, marker, since) : null;
    const fuller = crawl.partial ? await lookup('full', full) : null;
    const kept = fuller && fuller.reuse.pages >= crawl.pages.length ? fuller : null;
    const found = kept ?? await lookup('key', key);
    let analysis: WebsiteData | null = found?.analysis ?? null;
    if (found) scanMeter()?.websiteAnalysisReused();
    let diagnostics: unknown = null;
    if (!analysis) {
      try {
        const detailed = this.provider as WebsiteEvidenceProvider & { extractDetailed?: (crawl: CrawlResult,
          signal: AbortSignal, context: { robots: RobotsCache }) => Promise<{ websiteData: WebsiteData; diagnostics: unknown }> };
        if (detailed.extractDetailed) {
          const result = await detailed.extractDetailed(crawl, signal, { robots });
          analysis = WebsiteData.parse(result.websiteData); diagnostics = result.diagnostics;
        } else analysis = WebsiteData.parse(await this.provider.extract(crawl, signal));
      }
      catch (error) {
        // A failed extraction is not a local setback: without website data the identity is
        // insufficient, the directories are skipped and the whole scan ends FAILED. Keep the
        // provider's own message in the stored evidence, or there is no way to tell a token
        // limit from a timeout afterwards. It stays out of `reason`, which the API returns.
        // The record carries no `reuse`, so no later scan takes it for an analysis. The model's attempts of a failed
        // extraction (ExtractionFailure) are kept as a finished one keeps them: phase, request, response with its usage
        // and finish reason, and the issue found, so a cut answer or a cap reached can be read from the record.
        const message = error instanceof Error ? error.message : String(error);
        const attempts = (error as { attempts?: unknown } | null)?.attempts;
        return { data: null, rawContent: JSON.stringify({ ...base, analysis: null,
            diagnostics: { ...(diagnostics as object ?? {}), ...(Array.isArray(attempts) ? { attempts } : {}), error: message,
              pagesCrawled: crawl.pages.length } }),
          status: { status: signal.aborted ? 'timeout' : 'error', dataStatus: 'UNKNOWN', durationMs: Date.now() - start,
            pagesCrawled: crawl.pages.length, code: signal.aborted ? 'DEADLINE_REACHED' : 'PROVIDER_ERROR',
            reason: 'Website evidence extraction unavailable' } };
      }
    }
    // The same evidence read by a crawl that completed is a complete reading, whoever extracted it first.
    const reuse: Reuse = found ? { ...found.reuse, full: found.reuse.full ?? (crawl.partial ? null : full) }
      : { key, full: crawl.partial ? null : full, pages: crawl.pages.length, analyzedAt: new Date(now).toISOString(), from: null };
    const code = crawl.partial ? partialCrawlCode(crawl) : undefined;
    const notes = [crawlNotes(crawl), ...(kept ? [`signals kept from the complete reading of ${kept.reuse.analyzedAt.slice(0, 10)}`] : [])]
      .filter(note => note !== null).join('; ');
    // The model's attempts stay with the scan that paid for them: a record that reuses an analysis points there.
    return { data: analysis, rawContent: JSON.stringify({ ...base, reuse, analysis, diagnostics }),
      status: { status: crawl.partial ? 'partial' : 'ok', dataStatus: 'PRESENT', durationMs: Date.now() - start,
        pagesCrawled: crawl.pages.length, ...(code ? { code } : {}), reason: notes ? notes[0]!.toUpperCase() + notes.slice(1) : null } };
  }
}

/** Backward-compatible OpenAI adapter; new wiring should prefer WebsiteExtractionSource. */
export class RagWebsiteSource extends WebsiteExtractionSource {
  constructor(apiKey: string, repository: ScanRepository,
    crawl: Crawl = crawlSite, client?: OpenAI) {
    super(repository, new OpenAIEvidenceProvider(apiKey, client), crawl);
  }
}

export { WEBSITE_PROMPT } from './website-evidence-provider.js';
