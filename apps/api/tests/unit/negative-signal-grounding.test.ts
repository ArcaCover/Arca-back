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

describe('ai_blog_posts from the firm\'s own AI publications', () => {
  // Shaped like a large firm's site (DN-12 §13.8): synthetic slugs, the sections and dating of the real one.
  const ORIGIN = 'https://www.bigfirm.com';
  const home = { url: `${ORIGIN}/en`, html: '<title>Big Firm</title>', text: 'Big Firm is a global law firm.' };
  const page = (path: string) => ({ url: `${ORIGIN}${path}`, kind: 'page' as const });
  const aiPosts = [
    '/en/news/intheheadlines/2026/10/ai-regulation-push-gains-steam-ahead-of-midterms',
    '/en/insights/media-entities/2026/02/the-legal-risks-of-ai-use-in-medical-practices',
    '/en/insights/media-entities/2026/11/regulating-artificial-intelligence-compliance-management',
    '/en/insights/publications/2025/01/novel-settlement-reached-in-generative-ai-deceptive-trade-practices',
    '/en/insights/publications/2026/11/new-york-enacts-ai-chatbot-safeguards-for-minors',
    '/en/insights/media-entities/2023/08/podcast-inteligencia-artificial',
  ];
  const noise = [
    '/en/insights/publications/2026/11/embracing-statutes-of-repose',
    '/en/services/practices/technology-and-cybersecurity/artificial-intelligence',
    '/en/events/2026/11/trust-in-the-age-of-ai-navigating-identity-fraud-and-privacy',
    '/en/general-pages/firm-health-artificial-intelligence-navigator',
    '/en/insights/topics/artificial-intelligence',
    '/en/insights/ai',
    '/en/insights',
    '/en/careers/business-professionals',
  ];
  const links = [...aiPosts, ...noise].map(page);

  it('derives found:true with the distinct count, titles and the source URLs', () => {
    // The same post twice (trailing slash, other host spelling) and a post on another host.
    const extra = [page(`${aiPosts[0]}/`), { url: `https://bigfirm.com${aiPosts[1]}`, kind: 'page' as const },
      { url: 'https://other.example/blog/2026/01/generative-ai-trends', kind: 'page' as const }];
    const result = groundNegativeSignals(unknownWebsite(), { pages: [home], partial: false }, new Map(), noClaims, [...links, ...extra]);
    expect(result.ai_blog_posts.found).toBe(true);
    expect(result.ai_blog_posts.count).toBe(aiPosts.length);
    expect(result.ai_blog_posts.titles).toHaveLength(5);
    expect(result.ai_blog_posts.titles).toContain('New york enacts AI chatbot safeguards for minors');
    const sources = result.provenance.ai_blog_posts!;
    expect(sources).toHaveLength(aiPosts.length);
    expect(sources.every(reference => reference.method === 'derived')).toBe(true);
    expect(new Set(sources.map(reference => new URL(reference.sourceUrl).pathname))).toEqual(new Set(aiPosts));
  });

  it('reads the title of a post the crawl read, and recognizes a post by its title alone', () => {
    const read = { url: `${ORIGIN}/en/insights/publications/2026/03/client-alert-new-federal-rules`,
      html: '<html><head><title>New Federal Rules on Generative AI in Hiring | Big Firm</title></head></html>', text: 'Alert.' };
    const result = groundNegativeSignals(unknownWebsite(), { pages: [home, read], partial: false }, new Map(), noClaims, noise.map(page));
    expect(result.ai_blog_posts).toEqual({ found: true, count: 1, titles: ['New Federal Rules on Generative AI in Hiring'] });
    expect(result.provenance.ai_blog_posts).toEqual([{ sourceUrl: read.url,
      excerpt: 'New Federal Rules on Generative AI in Hiring', method: 'derived' }]);
  });

  it('finds no AI post in words that merely contain "ai" or in pages that are not the firm\'s posts', () => {
    const words = ['/blog/what-the-maid-said', '/blog/chair-of-the-board-steps-down', '/blog/mail-fraud-defense',
      '/news/aid-and-abet-liability', '/blog/2026/04/air-travel-claims', '/blog/daily-update'].map(page);
    const readNoise = { url: `${ORIGIN}/blog/air-travel`, html: '<title>Air travel and Aid claims</title>', text: '' };
    const result = groundNegativeSignals(unknownWebsite(), { pages: [home, readNoise], partial: false }, new Map(), noClaims,
      [...words, ...noise.map(page)]);
    expect(result.ai_blog_posts.found).toBeNull();
  });

  it('recognizes the AI vocabulary as whole words of the slug', () => {
    for (const path of ['/blog/genai-in-the-courtroom', '/blog/llm-contract-review', '/blog/chatgpt-and-privilege',
      '/news/machine-learning-in-ediscovery', '/blog/large-language-models-explained', '/noticias/el-uso-de-la-inteligencia-artificial',
      '/blog/2026/05/ai']) {
      const result = groundNegativeSignals(unknownWebsite(), { pages: [home], partial: false }, new Map(), noClaims, [page(path)]);
      expect(result.ai_blog_posts.found, path).toBe(path === '/blog/2026/05/ai' ? null : true);
    }
  });

  it('keeps the found:false derivation from a blog index when no AI post is known', () => {
    const index = { url: `${ORIGIN}/blog`, html: '', text: 'Recent case wins.' };
    const none = groundNegativeSignals(unknownWebsite(), { pages: [index], partial: false }, new Map(), noClaims, noise.map(page));
    expect(none.ai_blog_posts).toEqual({ found: false, count: 0, titles: [] });
    const some = groundNegativeSignals(unknownWebsite(), { pages: [index], partial: false }, new Map(), noClaims, links);
    expect(some.ai_blog_posts.found).toBe(true);
  });

  it('never overrides an accepted claim, whatever it says', () => {
    for (const accepted of [{ found: true, count: 2, titles: ['Our AI policy'] }, { found: false, count: 0, titles: [] }]) {
      const data = { ...unknownWebsite(), ai_blog_posts: accepted };
      const result = groundNegativeSignals(data, { pages: [home], partial: false }, new Map(), new Set(['ai_blog_posts']), links);
      expect(result.ai_blog_posts).toEqual(accepted);
      expect(result.provenance.ai_blog_posts).toBeUndefined();
    }
  });

  it('derives found:true when a claim was proposed and rejected: the URLs are their own evidence', () => {
    const result = groundNegativeSignals(unknownWebsite(), { pages: [home], partial: false }, new Map(), new Set(['ai_blog_posts']), links);
    expect(result.ai_blog_posts.found).toBe(true);
    expect(result.ai_blog_posts.count).toBe(aiPosts.length);
  });
});
