import type { WebsiteData } from '@arca/contracts';
import type { CrawlResult } from './crawler.js';
import { heuristicPageType, type PageType } from './page-types.js';

// A blog-typed page also covers a single article, /category/x, /tag/x and /author/x (page-types.ts).
// Only a page that reads as the section root — /blog, /news, /insights, no further path segment —
// is treated as an index: reading one unrelated article is not evidence the whole site publishes
// zero AI-related posts.
const BLOG_INDEX_PATH = /^\/(blog|news|insights|noticias)\/?$/i;

/**
 * Converts an unknown signal into a grounded value when a page the pipeline actually read settles
 * it, without adding a new LLM call or changing a prompt. The extraction leaves a field null
 * whenever the model made no claim about it; that is correct when the relevant page was never
 * reached, but throws away information once we know it was.
 *
 * privacy_policy grounds to found:true, never false: website-evidence-provider.ts (the deterministic
 * fallback) already treats a privacy-typed page's existence as proof a policy exists, and a page read
 * in full and cited as evidence of nothing is not proof of the opposite — content-level questions
 * (does it cover client data specifically) stay unknown, matching that same provider's own
 * conservative default for that sub-field.
 *
 * ai_blog_posts grounds to found:false only from an index-like page, and only when the field was
 * never claimed at all (accepted or rejected) — a claim review rejected means the model saw
 * something ambiguous, which is a different, less certain case than nothing having been proposed.
 *
 * ai_policy, ai_in_services and ai_disclosure are not grounded here: they can appear on any page, so
 * certifying their absence would require knowing the crawl covered the whole site, which CrawlResult
 * does not yet track — see DN-07.
 */
export function groundNegativeSignals(data: WebsiteData, crawl: CrawlResult, pageTypes: Map<string, PageType>,
  claimedFields: ReadonlySet<string>): WebsiteData {
  const typeOf = (url: string) => pageTypes.get(url) ?? heuristicPageType(url);
  const provenance = { ...data.provenance };

  let privacy_policy = data.privacy_policy;
  if (privacy_policy.found === null) {
    const privacyUrl = crawl.pages.find(page => typeOf(page.url) === 'privacy')?.url;
    if (privacyUrl) {
      privacy_policy = { found: true, mentions_client_data: null };
      provenance.privacy_policy = [{ sourceUrl: privacyUrl,
        excerpt: 'Privacy page was read; its existence is the evidence for found', method: 'derived' }];
    }
  }

  let ai_blog_posts = data.ai_blog_posts;
  if (ai_blog_posts.found === null && !claimedFields.has('ai_blog_posts')) {
    const blogIndexUrl = crawl.pages.find(page => typeOf(page.url) === 'blog' && BLOG_INDEX_PATH.test(new URL(page.url).pathname))?.url;
    if (blogIndexUrl) {
      ai_blog_posts = { found: false, count: 0, titles: [] };
      provenance.ai_blog_posts = [{ sourceUrl: blogIndexUrl,
        excerpt: 'Blog index page was read; no AI-related post was accepted from it', method: 'derived' }];
    }
  }

  return { ...data, privacy_policy, ai_blog_posts, provenance };
}
