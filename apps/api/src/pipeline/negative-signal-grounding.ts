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
