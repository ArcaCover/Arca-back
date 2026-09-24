import { describe, expect, it } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { groundNegativeSignals } from '../../src/pipeline/negative-signal-grounding.js';

const noClaims = new Set<string>();

describe('groundNegativeSignals', () => {
  it('grounds privacy_policy to found:true when the privacy page was read, matching the rule-based provider', () => {
    // website-evidence-provider.ts already treats a privacy-typed page's existence as proof a policy
    // exists (found: true). A page read in full and cited as evidence is not proof of the opposite.
    const crawl = { pages: [{ url: 'https://firm.com/privacy-policy', html: '', text: 'We do not sell your data.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map(), noClaims);
    expect(result.privacy_policy).toEqual({ found: true, mentions_client_data: null });
    expect(result.provenance.privacy_policy?.[0]).toMatchObject({ sourceUrl: 'https://firm.com/privacy-policy', method: 'derived' });
  });

  it('grounds ai_blog_posts to false when a blog index page was read and the field was never claimed', () => {
    const crawl = { pages: [{ url: 'https://firm.com/blog', html: '', text: 'Recent case wins.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map(), noClaims);
    expect(result.ai_blog_posts).toEqual({ found: false, count: 0, titles: [] });
  });

  it('does not ground ai_blog_posts from a single article, category or tag page', () => {
    // The blog PageType also covers a single post, /category/x, /tag/x and /author/x (page-types.ts).
    // One non-AI article is not evidence the whole site has zero AI-related posts.
    for (const url of ['https://firm.com/blog/dui-defense-tips', 'https://firm.com/category/news', 'https://firm.com/tag/dui']) {
      const crawl = { pages: [{ url, html: '', text: 'Case update.' }], partial: false };
      const result = groundNegativeSignals(unknownWebsite(), crawl, new Map(), noClaims);
      expect(result.ai_blog_posts.found, url).toBeNull();
    }
  });

  it('does not ground ai_blog_posts when the model proposed a claim for it that review rejected', () => {
    // A rejected claim means the model saw something ambiguous, not nothing at all — different from
    // never having proposed anything, and too uncertain to ground as a confident false.
    const crawl = { pages: [{ url: 'https://firm.com/blog', html: '', text: 'Recent case wins.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map(), new Set(['ai_blog_posts']));
    expect(result.ai_blog_posts.found).toBeNull();
  });

  it('leaves both signals null when no matching page was read', () => {
    const crawl = { pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map(), noClaims);
    expect(result.privacy_policy.found).toBeNull();
    expect(result.ai_blog_posts.found).toBeNull();
  });

  it('never overrides a signal the model already claimed', () => {
    const data = { ...unknownWebsite(), privacy_policy: { found: false, mentions_client_data: null } };
    const crawl = { pages: [{ url: 'https://firm.com/privacy-policy', html: '', text: 'We use your data for marketing.' }], partial: false };
    const result = groundNegativeSignals(data, crawl, new Map(), noClaims);
    expect(result.privacy_policy).toEqual({ found: false, mentions_client_data: null });
  });

  it('uses the page-type classification map over the URL heuristic when both are available', () => {
    // The URL alone reads as neither privacy nor blog (heuristicPageType would call it "other"); the
    // agent's own classification vote is what tells us this specific page is the privacy page.
    const crawl = { pages: [{ url: 'https://firm.com/legal-info', html: '', text: 'No AI use disclosed.' }], partial: false };
    const result = groundNegativeSignals(unknownWebsite(), crawl, new Map([['https://firm.com/legal-info', 'privacy']]), noClaims);
    expect(result.privacy_policy.found).toBe(true);
    expect(result.ai_blog_posts.found).toBeNull();
  });
});
