import type { EvidenceReference } from '@arca/contracts';
import type { CrawledPage } from './crawler.js';

/** Titles kept in ai_blog_posts, at most. The count covers every post found. */
export const AI_PUBLICATION_TITLES = 5;

// A post lives under one of these sections of the firm's own site, below the section itself.
const SECTION = /^(blogs?|news|insights?|publications?|articles?|alerts?|client-alerts|legal-alerts|updates|newsletters?|podcasts?|media|media-entities|thought-leadership|noticias|publicaciones|articulos|novedades)$/;
// Listing pages (a category, a tag, an author, a page of results) and events are not posts.
const NOT_A_POST = /^(category|categories|categoria|categorias|tags?|topics?|authors?|autor|page|events?|eventos|webinars?)$/;
const AI_TOKENS: Record<string, string> = { ai: 'AI', genai: 'GenAI', llm: 'LLM', llms: 'LLMs', chatgpt: 'ChatGPT' };
const AI_PHRASES = [['artificial', 'intelligence'], ['machine', 'learning'], ['large', 'language', 'model'], ['large', 'language', 'models'],
  ['inteligencia', 'artificial']];
// In a title, "AI" counts only in capitals: "Ai Weiwei" or "Aid" are not about AI.
const AI_TITLE_CAPITALS = /\b(?:AI|GenAI|LLMs?)\b/;
const AI_TITLE_WORDS = /\b(?:artificial intelligence|generative ai|machine learning|large language models?|chatgpt|inteligencia artificial)\b/i;

const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '');
const tokensOf = (slug: string) => slug.split(/[-_.]+/).filter(Boolean);
/** A slug about AI: one of its whole words is AI vocabulary, never a word that merely contains "ai" (said, maid, chair). */
function slugAboutAi(slug: string): boolean {
  const tokens = tokensOf(slug);
  return tokens.some(token => token in AI_TOKENS) ||
    AI_PHRASES.some(phrase => tokens.some((_, start) => phrase.every((word, offset) => tokens[start + offset] === word)));
}
const titleAboutAi = (title: string) => AI_TITLE_CAPITALS.test(title) || AI_TITLE_WORDS.test(title);

/** The post slug of a URL of the firm's publications, or null when the URL is no single post. */
function postSlug(segments: string[]): string | null {
  const section = segments.findIndex(segment => SECTION.test(segment));
  if (section < 0 || segments.length <= section + 1 || segments.some(segment => NOT_A_POST.test(segment))) return null;
  const slug = segments.at(-1)!;
  // A one-word slug under a section (/insights/ai, /blog/2026/05/ai) reads as a topic listing, not a post.
  if (SECTION.test(slug) || /^\d+$/.test(slug) || tokensOf(slug).length < 2) return null;
  return slug;
}
const decode = (text: string) => text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;|&#8217;|&rsquo;/gi, "'").replace(/&#8211;|&ndash;/gi, '–').replace(/\s+/g, ' ').trim();
/** The page's own title, without the site name a "Title | Firm" title ends with. */
function pageTitle(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = raw ? decode(raw.replace(/<[^>]+>/g, ' ')).split(/\s+\|\s+/)[0]!.trim() : '';
  return title || null;
}
/** "new-rules-for-generative-ai" reads "New rules for generative AI". */
function humanize(slug: string): string {
  const text = tokensOf(slug).map(token => AI_TOKENS[token] ?? token).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
/** Year and month of a dated path (/2026/11/), for newest first; 0 when the path has none. */
const dateOf = (segments: string[]) => {
  const index = segments.findIndex((segment, at) => /^(19|20)\d{2}$/.test(segment) && /^(0?[1-9]|1[0-2])$/.test(segments[at + 1] ?? ''));
  return index < 0 ? 0 : Number(segments[index]) * 100 + Number(segments[index + 1]);
};

export type AiPublications = { count: number; titles: string[]; references: EvidenceReference[] };

/**
 * The firm's own publications about AI that the scan knows of, read by rule (DN-12 §13.8): pages it read and URLs it
 * saw (links of the pages read and the sitemap), on the firm's host only, that are a single post under a blog, news,
 * insights or publications section (never an event, a listing or a practice page) and whose slug, or the title of a
 * page it read, is about AI. Whole words only: "ai", "genai", "llm", "chatgpt", "artificial intelligence", "machine
 * learning", "large language model" and "inteligencia artificial". A name spelled with the word "ai" in a slug
 * (ai-weiwei) would count; that is an accepted risk, since a title needs "AI" in capitals.
 * The count is the distinct URLs; the titles are the page titles where the page was read, otherwise the slug in words,
 * newest first, at most AI_PUBLICATION_TITLES. Null when none is found.
 */
export function aiPublications(pages: CrawledPage[], links: Array<{ url: string; kind: 'page' | 'document' }>): AiPublications | null {
  const firm = pages[0] ? (() => { try { return host(new URL(pages[0]!.url)); } catch { return null; } })() : null;
  if (!firm) return null;
  const found = new Map<string, { url: string; title: string; read: boolean; date: number; path: string }>();
  const consider = (raw: string, html: string | null) => {
    let url: URL;
    try { url = new URL(raw); } catch { return; }
    if (host(url) !== firm || !['http:', 'https:'].includes(url.protocol)) return;
    let path: string;
    try { path = decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, ''); } catch { return; }
    const segments = path.split('/').filter(Boolean);
    const slug = postSlug(segments);
    if (slug === null || found.has(path)) return;
    const title = html === null ? null : pageTitle(html);
    if (!slugAboutAi(slug) && !(title && titleAboutAi(title))) return;
    found.set(path, { url: raw, title: title ?? humanize(slug), read: html !== null, date: dateOf(segments), path });
  };
  for (const page of pages) if (page.kind !== 'document') consider(page.url, page.html);
  for (const link of links) if (link.kind === 'page') consider(link.url, null);
  if (!found.size) return null;
  const posts = [...found.values()].sort((a, b) => Number(b.read) - Number(a.read) || b.date - a.date || a.path.localeCompare(b.path));
  return { count: posts.length, titles: posts.slice(0, AI_PUBLICATION_TITLES).map(post => post.title),
    references: posts.map(post => ({ sourceUrl: post.url, excerpt: post.title, method: 'derived' as const })) };
}
