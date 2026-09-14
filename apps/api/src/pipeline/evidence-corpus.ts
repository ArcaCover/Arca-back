import { createHash } from 'node:crypto';
import { canonicalUrl, type CrawlResult } from './crawler.js';
import { MAX_DOCUMENT_CHARS } from './document-reader.js';

export type EvidenceSegment = { id: string; pageId: string; url: string;
  kind: 'text' | 'json_ld' | 'meta' | 'footer' | 'document' | 'search'; text: string };
export type EvidenceLink = { id: string; url: string; sourceUrl: string; label: string; kind: 'page' | 'document' };
export type EvidenceCorpus = { version: 'corpus-v2'; snapshotId: string; segments: EvidenceSegment[];
  links: EvidenceLink[]; truncated: boolean; omittedUrls: string[]; totalChars: number;
  documents: Array<{ url: string; complete: boolean; chars: number }> };

/** Offer the agent only links the backend can actually read, typed by the tool that reads them. */
export function classifyLink(raw: string, base: string): { url: string; kind: 'page' | 'document' } | null {
  const page = canonicalUrl(raw, base);
  if (page) return { url: page, kind: 'page' };
  try {
    const url = new URL(raw, base);
    url.hash = ''; url.search = '';
    const host = new URL(base).hostname.replace(/^www\./, '');
    if (['http:', 'https:'].includes(url.protocol) && url.hostname.replace(/^www\./, '') === host &&
      !url.username && !url.password && !url.port && /\.pdf$/i.test(url.pathname)) return { url: url.href, kind: 'document' };
  } catch { /* Malformed links are not acquisition targets. */ }
  return null;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const decode = (value: string) => value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ').trim();

function metadata(html: string): Array<{ kind: 'meta' | 'json_ld'; locator: string; text: string }> {
  const found: Array<{ kind: 'meta' | 'json_ld'; locator: string; text: string }> = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title && decode(title)) found.push({ kind: 'meta', locator: 'title', text: decode(title) });
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key && content && ['og:site_name', 'description', 'og:title'].includes(key)) {
      found.push({ kind: 'meta', locator: key, text: decode(content) });
    }
  }
  let index = 0;
  for (const match of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]!);
      const roots = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value['@graph'])
        ? value['@graph'] : Array.isArray(value) ? value : [value];
      for (const root of roots) if (root && typeof root === 'object') {
        found.push({ kind: 'json_ld', locator: `jsonld:${index++}`, text: JSON.stringify(root) });
      }
    } catch { /* Invalid metadata is retained only in the raw crawl. */ }
  }
  return found;
}

function paragraphs(text: string, max = 800): string[] {
  const result: string[] = [], lines = text.split(/\r?\n/).map(value => value.replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= 2);
  let block = '';
  for (const line of lines) {
    for (let start = 0; start < line.length; start += max) {
      const part = line.slice(start, start + max);
      if (block && block.length + part.length + 1 > max) { result.push(block); block = ''; }
      block += `${block ? '\n' : ''}${part}`;
    }
  }
  if (block) result.push(block);
  return result;
}

export function normalizeForGrounding(value: string): string {
  return value.normalize('NFC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

// Measured on live sites: 24,000 characters of pages already make a ~13,000-token extraction prompt, and 60,000 made
// ~25,000 tokens, over DN-05's 24,000-token limit per call, and the endpoint answered with 5xx. Requested pages rank first instead.
export function buildCorpus(crawl: CrawlResult, budgetChars = 24_000): EvidenceCorpus {
  const segments: EvidenceSegment[] = [], links: EvidenceLink[] = [], omittedUrls: string[] = [];
  let used = 0, truncated = false;
  const seenText = new Set<string>();
  const documents: EvidenceCorpus['documents'] = []; let documentChars = 0;
  const priority = (url: string) => {
    const path = new URL(url).pathname.toLowerCase();
    if (path === '/') return 0;
    if (/\/(team|attorneys?|lawyers?|abogados?|equipo|socios)(?:\/|$)/.test(path)) return 1;
    if (/about|nosotros|quienes-somos|acerca|firma/.test(path)) return 2;
    if (/privacy|privacidad/.test(path)) return 3;
    if (/service|practice|servicio|practica|defensa-criminal|immigration/.test(path)) return 4;
    if (/blog|author|category/.test(path)) return 7;
    return 6;
  };
  // A page the agent asked for ranks with the team pages: it was requested because a field needs it.
  const rank = (page: CrawlResult['pages'][number]) => page.requested ? 1 : priority(page.url);
  const pages = [...crawl.pages].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url));
  for (const page of pages) {
    const pageHash = digest(`${page.url}\n${page.html}`), pageId = `D-${pageHash}`;
    const isDocument = page.kind === 'document';
    const pageCap = isDocument ? MAX_DOCUMENT_CHARS : 6_000;
    let dropped = false;
    const candidates = [
      ...metadata(page.html),
      ...paragraphs(page.text).map((text, index) => ({ kind: isDocument ? 'document' as const : 'text' as const, locator: `text:${index}`, text })),
    ];
    let included = false, pageUsed = 0;
    for (const candidate of candidates) {
      const contentKey = normalizeForGrounding(candidate.text).toLocaleLowerCase();
      if (!isDocument && seenText.has(contentKey)) continue;
      const overGlobal = isDocument ? documentChars + candidate.text.length > 120_000 : used + candidate.text.length > budgetChars;
      if (pageUsed + candidate.text.length > pageCap || overGlobal) { truncated = true; dropped = true; continue; }
      included = true; pageUsed += candidate.text.length;
      if (isDocument) documentChars += candidate.text.length; else used += candidate.text.length;
      seenText.add(contentKey);
      segments.push({ id: `${pageId}-${digest(`${candidate.locator}:${candidate.text}`)}`, pageId, url: page.url,
        kind: candidate.kind, text: candidate.text });
    }
    if (!included && candidates.length) omittedUrls.push(page.url);
    if (isDocument) documents.push({ url: page.url, complete: page.complete !== false && !dropped, chars: pageUsed });
    for (const match of page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const target = classifyLink(match[1]!, page.url);
      if (!target) continue;
      const id = `L-${digest(target.url)}`;
      if (!links.some(link => link.id === id)) links.push({ id, url: target.url, sourceUrl: page.url, label: decode(match[2]!), kind: target.kind });
    }
  }
  const snapshotId = digest(crawl.pages.map(page => `${page.url}:${digest(page.html)}`).sort().join('|'));
  return { version: 'corpus-v2', snapshotId, segments, links, truncated: truncated || omittedUrls.length > 0 || used >= budgetChars,
    omittedUrls, totalChars: used, documents };
}

export function withLinks(corpus: EvidenceCorpus, targets: Array<{ url: string; kind: 'page' | 'document' }>, sourceUrl: string): EvidenceCorpus {
  const links = [...corpus.links];
  for (const target of targets) {
    const id = `L-${digest(target.url)}`;
    if (!links.some(link => link.id === id)) links.push({ id, url: target.url, sourceUrl, label: new URL(target.url).pathname, kind: target.kind });
  }
  return { ...corpus, links };
}

export function withPassages(corpus: EvidenceCorpus, passages: Array<{ url: string; start: number; end: number; text: string }>): EvidenceCorpus {
  const segments = [...corpus.segments];
  for (const passage of passages) {
    const id = `S-${digest(`${passage.url}:${passage.start}:${passage.end}`)}`;
    if (!segments.some(segment => segment.id === id)) {
      segments.push({ id, pageId: `D-${digest(passage.url)}`, url: passage.url, kind: 'search', text: passage.text });
    }
  }
  return { ...corpus, segments };
}

export function serializeCorpus(corpus: EvidenceCorpus): string {
  const segments = corpus.segments.map(segment => `[${segment.id}] URL=${segment.url} KIND=${segment.kind}\n${segment.text}`).join('\n\n');
  const linkPriority = (link: EvidenceLink) => /team|attorney|lawyer|abogad|equipo|about|nosotros|quienes|privacy|privacidad|contact/i.test(`${link.url} ${link.label}`) ? 0 : 1;
  const links = [...corpus.links].sort((a, b) => linkPriority(a) - linkPriority(b) || a.url.localeCompare(b.url)).slice(0, 80)
    .map(link => `[${link.id}] ${link.kind.toUpperCase()} ${link.url} :: ${link.label.slice(0, 120)}`).join('\n');
  return `SNAPSHOT ${corpus.snapshotId}\nSEGMENTS\n${segments}\n\nDISCOVERED LINKS\n${links}`;
}
