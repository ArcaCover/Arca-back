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
