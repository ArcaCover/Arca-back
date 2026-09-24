import { createHash } from 'node:crypto';
import { WebsiteData, type WebsiteSource, type SourceResult } from '@arca/contracts';
import { crawlWebsite, type CrawlResult } from './crawler.js';
import type { ScanRepository } from '../repositories/types.js';
import { OpenAIEvidenceProvider, type WebsiteEvidenceProvider } from './website-evidence-provider.js';
import type OpenAI from 'openai';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Crawling/extraction orchestration. This is upstream from the deterministic Layer 1 core. */
export class WebsiteExtractionSource implements WebsiteSource {
  constructor(private readonly repository: ScanRepository, private readonly provider: WebsiteEvidenceProvider,
    private readonly crawl: (domain: string, signal: AbortSignal) => Promise<CrawlResult> = crawlWebsite) {}

  async run(domain: string, signal: AbortSignal): Promise<SourceResult<WebsiteData>> {
    const start = Date.now();
    const crawl = await this.crawl(domain, signal);
    const base = { provider: this.provider.id, version: this.provider.version, pages: crawl.pages, issues: crawl.issues ?? [] };
    const accessBlocked = crawl.issues?.some(issue => issue.code === 'ACCESS_BLOCKED') ?? false;
    if (!crawl.pages.length) return { data: null, rawContent: JSON.stringify({ ...base, analysis: null }),
      status: { status: 'error', dataStatus: 'UNKNOWN', durationMs: Date.now() - start, pagesCrawled: 0,
        code: accessBlocked ? 'ACCESS_BLOCKED' : 'NO_READABLE_EVIDENCE',
        reason: accessBlocked ? 'Website access was blocked' : 'No readable website evidence' } };
    const contentHash = hash(JSON.stringify(crawl.pages.map(({ url, html }) => ({ url, html }))));
    const previous = await this.repository.latestRaw(domain, 'website');
    let analysis: WebsiteData | null = null;
    let diagnostics: unknown = null;
    if (previous) {
      try {
        const record = JSON.parse(previous.raw_content);
        if (record.provider === this.provider.id && record.version === this.provider.version && record.contentHash === contentHash) {
          analysis = WebsiteData.parse(record.analysis);
          diagnostics = record.diagnostics ?? null;
        }
      } catch { /* Invalid or incompatible historic evidence cannot supply an analysis. */ }
    }
    if (!analysis) {
      try {
        const detailed = this.provider as WebsiteEvidenceProvider & { extractDetailed?: (crawl: CrawlResult,
          signal: AbortSignal) => Promise<{ websiteData: WebsiteData; diagnostics: unknown }> };
        if (detailed.extractDetailed) {
          const result = await detailed.extractDetailed(crawl, signal);
          analysis = WebsiteData.parse(result.websiteData); diagnostics = result.diagnostics;
        } else analysis = WebsiteData.parse(await this.provider.extract(crawl, signal));
      }
      catch (error) {
        // A failed extraction is not a local setback: without website data the identity is
        // insufficient, the directories are skipped and the whole scan ends FAILED. Keep the
        // provider's own message in the stored evidence, or there is no way to tell a token
        // limit from a timeout afterwards. It stays out of `reason`, which the API returns.
        const message = error instanceof Error ? error.message : String(error);
        return { data: null, rawContent: JSON.stringify({ ...base, contentHash, analysis: null,
            diagnostics: { ...(diagnostics as object ?? {}), error: message, pagesCrawled: crawl.pages.length } }),
          status: { status: signal.aborted ? 'timeout' : 'error', dataStatus: 'UNKNOWN', durationMs: Date.now() - start,
            pagesCrawled: crawl.pages.length, code: signal.aborted ? 'DEADLINE_REACHED' : 'PROVIDER_ERROR',
            reason: 'Website evidence extraction unavailable' } };
      }
    }
    return { data: analysis, rawContent: JSON.stringify({ ...base, contentHash, analysis, diagnostics }),
      status: { status: crawl.partial ? 'partial' : 'ok', dataStatus: 'PRESENT', durationMs: Date.now() - start,
        pagesCrawled: crawl.pages.length, reason: null } };
  }
}

/** Backward-compatible OpenAI adapter; new wiring should prefer WebsiteExtractionSource. */
export class RagWebsiteSource extends WebsiteExtractionSource {
  constructor(apiKey: string, repository: ScanRepository,
    crawl: (domain: string, signal: AbortSignal) => Promise<CrawlResult> = crawlWebsite, client?: OpenAI) {
    super(repository, new OpenAIEvidenceProvider(apiKey, client), crawl);
  }
}

export { WEBSITE_PROMPT } from './website-evidence-provider.js';
