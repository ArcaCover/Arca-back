import { describe, expect, it } from 'vitest';
import { acquisitionFloor, heuristicPageType, majorityPageTypes, pageCandidates, type PageCandidate } from '../../src/pipeline/page-types.js';
import { buildCorpus } from '../../src/pipeline/evidence-corpus.js';

const candidates: PageCandidate[] = [
  { id: 'C1', url: 'https://firm.com/', kind: 'page', label: 'Home', read: true },
  { id: 'C2', url: 'https://firm.com/nuestro-equipo', kind: 'page', label: 'Equipo', read: false },
  { id: 'C3', url: 'https://firm.com/quienes-somos', kind: 'page', label: 'Quiénes somos', read: false },
  { id: 'C4', url: 'https://firm.com/contacto', kind: 'page', label: 'Contacto', read: false },
  { id: 'C5', url: 'https://firm.com/blog/post', kind: 'page', label: 'Post', read: false },
  { id: 'C6', url: 'https://firm.com/files/politica.pdf', kind: 'document', label: 'Política', read: false },
];

describe('page types', () => {
  it('takes the majority type of three votes and falls back to the URL heuristic without one', () => {
    const vote = (types: Record<string, string>) => ({ pages: Object.entries(types).map(([id, type]) => ({ id, type })) });
    const types = majorityPageTypes(candidates, [vote({ C2: 'team', C3: 'about', C5: 'blog', C9: 'team' }),
      vote({ C2: 'team', C3: 'contact', C5: 'services' }), vote({ C2: 'profile', C3: 'other', C5: 'other' })] as never);
    expect(types.get('https://firm.com/nuestro-equipo')).toBe('team');
    expect(types.get('https://firm.com/quienes-somos')).toBe('about');
    expect(types.get('https://firm.com/blog/post')).toBe('blog');
    expect(types.size).toBe(candidates.length);
  });

  it('recognises team, about, contact, privacy and blog paths in English and Spanish', () => {
    expect(heuristicPageType('https://firm.com/abogados-de-inmigracion-miami/')).toBe('team');
    expect(heuristicPageType('https://firm.com/attorneys')).toBe('team');
    expect(heuristicPageType('https://firm.com/consejos-de-abogados-de-inmigracion/')).toBe('other');
    expect(heuristicPageType('https://firm.com/attorney-video/car-accident')).toBe('blog');
    expect(heuristicPageType('https://firm.com/about')).toBe('about');
    expect(heuristicPageType('https://firm.com/contacto/')).toBe('contact');
    expect(heuristicPageType('https://firm.com/wp-content/Politica-Privacidad.pdf')).toBe('privacy');
    expect(heuristicPageType('https://firm.com/category/asilo/')).toBe('blog');
  });

  it('lists read pages first and every discovered URL once', () => {
    const crawl = { partial: false, pages: [{ url: 'https://firm.com/', text: 'Smith Law.',
      html: '<title>Smith Law</title><a href="/team">Team</a><a href="/team">Our team</a><a href="/policy.pdf">Privacy</a>' }] };
    const list = pageCandidates(crawl, buildCorpus(crawl));
    expect(list.map(item => [item.id, item.url, item.kind, item.read])).toEqual([
      ['C1', 'https://firm.com/', 'page', true], ['C2', 'https://firm.com/team', 'page', false], ['C3', 'https://firm.com/policy.pdf', 'document', false]]);
    expect(list[0]!.label).toBe('Smith Law');
  });

  it('plans the unread team, about and contact pages and the unread privacy documents', () => {
    const types = new Map([['https://firm.com/', 'about'], ['https://firm.com/nuestro-equipo', 'team'], ['https://firm.com/quienes-somos', 'about'],
      ['https://firm.com/contacto', 'contact'], ['https://firm.com/blog/post', 'blog'], ['https://firm.com/files/politica.pdf', 'privacy']] as const);
    expect(acquisitionFloor(candidates, new Map(types))).toEqual({
      pages: ['https://firm.com/nuestro-equipo', 'https://firm.com/quienes-somos', 'https://firm.com/contacto'],
      documents: ['https://firm.com/files/politica.pdf'] });
  });
});
