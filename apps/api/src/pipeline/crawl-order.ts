/** The order a crawl reads a site in: which page comes first, and which sitemap pages it starts from. */
/**
 * Languages a site may serve under a leading path segment (/en, /es-mx, /pt-br). Listed rather than any two letters,
 * so a two-letter section such as /ai/ is never taken for a language.
 */
const LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ca', 'gl', 'eu', 'zh', 'ja', 'ko', 'ru', 'ar', 'pl',
  'sv', 'da', 'fi', 'no', 'nb', 'tr', 'he', 'el', 'cs', 'hu', 'ro', 'uk', 'vi', 'th', 'id', 'hi']);
/** The path without a leading language segment: /en/offices is /offices, and /en alone is the home page. */
export function withoutLocale(path: string): string {
  const match = /^\/([a-z]{2})(?:-[a-z]{2})?(?=\/|$)/i.exec(path);
  return match && LANGUAGES.has(match[1]!.toLowerCase()) ? path.slice(match[0].length) || '/' : path;
}
/** Whole words of a path: separated by "/", "-", "_" or ".", so "firm" never matches "affirmative". */
const words = (...stems: string[]) => new RegExp(`(?:^|[/._-])(?:${stems.join('|')})(?=[/._-]|$)`);
/** The priority groups, in crawl order. `other` is every page no group names. */
export const PAGE_GROUPS = { home: 0, ai: 1, about: 2, people: 3, offices: 4, services: 5, privacy: 6, other: 7, news: 8 } as const;
// Spanish stems carry the same weight as their English equivalents. Without them a Spanish site has no ranked page at
// all, the whole crawl ties at the lowest priority and the budget goes to whatever sorts first alphabetically.
const RANKED: Array<[number, RegExp[]]> = [
  [PAGE_GROUPS.ai, [/artificial-intelligence|inteligencia-artificial|legal-?tech|innovat|innovaci/,
    words('ai', 'ia')]],
  [PAGE_GROUPS.about, [/about|nosotros|quienes-somos|acerca|la-firma|who-we-are/, words('firm', 'history', 'historia')]],
  [PAGE_GROUPS.people, [/team|attorney|lawyer|people|professionals|abogad|equipo|socios/, words('bios?')]],
  [PAGE_GROUPS.offices, [/offices|location|contact|oficinas|ubicaci/]],
  [PAGE_GROUPS.services, [/service|practice|servicio|practica/]],
  [PAGE_GROUPS.privacy, [/privacy|privacidad|aviso-legal/]],
];
const NEWS = words('blogs?', 'news', 'insights?', 'events?', 'press', 'noticias', 'eventos', 'prensa');
const rank = (path: string) => RANKED.find(([, patterns]) => patterns.some(pattern => pattern.test(path)))?.[0];
/**
 * Where a page stands in the crawl, lowest first. The language prefix a site may keep its whole tree under is set aside
 * first, so /en is the home page and /en/offices an office page. Then:
 * home, AI (the subject of the score), about the firm, people, offices and contact, services and practices, privacy,
 * every page no group names, and last blog, news, insights, events and press. A page inside a news section stays
 * there whatever its slug says: a firm with thirty alerts about AI would otherwise spend the whole budget on them.
 * A page is ranked by its own last segment before its section, so /firm/legal/privacy is a privacy page and
 * /about/team a people page.
 */
export function pagePriority(raw: string): number {
  const path = withoutLocale(new URL(raw).pathname.toLowerCase());
  if (path === '/') return PAGE_GROUPS.home;
  if (NEWS.test(path)) return PAGE_GROUPS.news;
  const leaf = path.split('/').filter(Boolean).at(-1) ?? '';
  return rank(`/${leaf}`) ?? rank(path) ?? PAGE_GROUPS.other;
}
/**
 * Caps how many pages of one priority group a single crawl will visit, while other groups still have pages queued.
 * People: a firm with many attorney bios (muscalaw.com had 15) would fill the budget before privacy ever got a turn;
 * three is the directory page and two bios, and the directory already names every attorney. News: depth comes before
 * priority, so without a cap the news a home page links to (13 of 20 pages on one live scan) beat every page one level
 * deeper. Neither cap leaves a slot unused: with nothing else queued, the capped pages fill the rest.
 */
export const GROUP_PAGE_LIMITS: Partial<Record<number, number>> = { [PAGE_GROUPS.people]: 3, [PAGE_GROUPS.news]: 3 };
/** Sitemap pages the crawl starts from, at most. */
export const MAX_SITEMAP_SEEDS = 8;
const SEED_GROUPS: number[] = [PAGE_GROUPS.ai, PAGE_GROUPS.about, PAGE_GROUPS.people, PAGE_GROUPS.offices];
/**
 * The sitemap pages worth reading before any link of the home page says so: AI, about, people and offices, the groups
 * a home page often reaches only through a menu the crawler does not see or a page one level too deep. Taken in
 * turns across those groups, the shortest path of each first (a directory before the bios it lists), one language
 * version of each page, never one already `taken`.
 */
export function sitemapSeeds(links: Array<{ url: string; kind: 'page' | 'document' }>, rootUrl: string,
  taken: ReadonlySet<string> = new Set(), max = MAX_SITEMAP_SEEDS): string[] {
  const buckets = new Map<number, Array<{ url: string; path: string }>>(SEED_GROUPS.map(group => [group, []]));
  for (const link of links) {
    const url = link.kind === 'page' ? canonicalUrl(link.url, rootUrl) : null;
    if (url && !taken.has(url)) buckets.get(pagePriority(url))?.push({ url, path: withoutLocale(new URL(url).pathname).replace(/\/$/, '') });
  }
  const depth = (path: string) => path.split('/').length;
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => depth(a.path) - depth(b.path) || a.path.length - b.path.length || a.url.localeCompare(b.url));
  }
  const seeds: string[] = [], paths = new Set<string>();
  for (let turn = 0; seeds.length < max && [...buckets.values()].some(bucket => bucket.length); turn++) {
    for (const group of SEED_GROUPS) {
      const bucket = buckets.get(group)!;
      let next = bucket.shift();
      while (next && paths.has(next.path)) next = bucket.shift();
      if (!next || seeds.length >= max) continue;
      paths.add(next.path); seeds.push(next.url);
    }
  }
  return seeds;
}
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
