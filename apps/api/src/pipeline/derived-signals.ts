import type { EvidenceReference, WebsiteData } from '@arca/contracts';
import type { CrawlResult } from './crawler.js';
import { heuristicPageType, type PageType } from './page-types.js';

/** Signals decided by rules over extracted facts, never by a model judgment. */
export const DERIVED_FIELDS: readonly string[] = ['team_page_quality', 'website_quality'];
export type TeamPageDerivation = { value: 'detailed' | 'names_only' | null; teamPages: string[]; members: number;
  withProfile: number; reason: string; evidence: EvidenceReference[] };
export type WebsiteDerivation = { value: 'robust' | 'basic' | null; present: PageType[]; reason: string; evidence: EvidenceReference[] };

const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const typeOf = (types: Map<string, PageType>, url: string) => types.get(url) ?? heuristicPageType(url);
const withoutSlash = (url: string) => url.replace(/\/$/, '');

function hasProfile(page: CrawlResult['pages'][number], name: string, others: string[]): boolean {
  const full = fold(name);
  const tokens = full.split(' ').filter(token => token.length > 1);
  if (tokens.length < 2) return false;
  const [first, last] = [tokens[0]!, tokens.at(-1)!];
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  for (const match of page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let target: URL;
    try { target = new URL(match[1]!, page.url); } catch { continue; }
    if (target.hostname.replace(/^www\./, '') !== host || withoutSlash(target.href) === withoutSlash(page.url)) continue;
    const label = fold(match[2]!.replace(/<[^>]+>/g, ' '));
    let path = target.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep the raw path */ }
    const slug = new Set(fold(path).split(' '));
    if ((label && label.includes(full)) || (slug.has(first) && slug.has(last))) return true;
  }
  // A long paragraph about one person counts as an inline biography; a roster line naming several people does not.
  const otherNames = others.map(fold);
  return page.text.split(/\n+/).some(line => {
    const text = fold(line);
    return line.length >= 300 && (text.includes(full) || text.includes(`${first} ${last}`)) && !otherNames.some(other => text.includes(other));
  });
}

export function deriveTeamPageQuality(crawl: CrawlResult, types: Map<string, PageType>, members: WebsiteData['team_members']): TeamPageDerivation {
  const pages = crawl.pages.filter(page => page.kind !== 'document' && typeOf(types, page.url) === 'team');
  const people = members ?? [];
  const base = { teamPages: pages.map(page => page.url), members: people.length };
  if (!pages.length) return { ...base, value: null, withProfile: 0, reason: 'No se leyó ninguna página de equipo', evidence: [] };
  if (!people.length) return { ...base, value: null, withProfile: 0, reason: 'No hay abogados aceptados', evidence: [] };
  const names = people.map(person => person.full_name);
  const withProfile = names.filter(name => pages.some(page => hasProfile(page, name, names.filter(other => other !== name)))).length;
  const value = withProfile / people.length >= 0.5 ? 'detailed' : 'names_only';
  const reason = `${withProfile} de ${people.length} abogados aceptados tienen perfil enlazado o biografía en la página de equipo`;
  return { ...base, value, withProfile, reason, evidence: [{ sourceUrl: pages[0]!.url, excerpt: reason, method: 'derived' }] };
}

export function deriveWebsiteQuality(urls: string[], types: Map<string, PageType>, data: WebsiteData,
  team: TeamPageDerivation['value']): WebsiteDerivation {
  const present = [...new Set(urls.map(url => typeOf(types, url)))];
  const identity = data.firm_name !== null;
  const contact = present.includes('contact') || data.phone !== null;
  const services = present.includes('services') || Boolean(data.practice_areas?.length);
  const value = identity && contact && services ? team === 'detailed' ? 'robust' : 'basic' : null;
  const missing = [!identity && 'identidad', !contact && 'contacto', !services && 'servicios'].filter(Boolean).join(', ');
  const reason = value === null ? `Falta evidencia de: ${missing}`
    : `Identidad, contacto y servicios presentes${value === 'robust' ? ', y equipo con perfiles' : ', pero el equipo no tiene perfiles'}`;
  return { value, present, reason, evidence: value && urls[0] ? [{ sourceUrl: urls[0], excerpt: reason, method: 'derived' }] : [] };
}
