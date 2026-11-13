import { describe, expect, it } from 'vitest';
import { canonicalUrl, pagePriority, sitemapSeeds } from '../../src/pipeline/crawler.js';

describe('canonicalUrl', () => {
  it('canonicalizes the www and bare-domain forms of the same page identically', () => {
    const base = 'https://muscalaw.com/';
    expect(canonicalUrl('https://www.muscalaw.com/', base)).toBe('https://muscalaw.com/');
    expect(canonicalUrl('https://muscalaw.com/', base)).toBe('https://muscalaw.com/');
  });

  it('still rejects a link to a different domain', () => {
    expect(canonicalUrl('https://other.example/', 'https://muscalaw.com/')).toBeNull();
  });

  it('strips the hash and query string as before', () => {
    expect(canonicalUrl('https://muscalaw.com/about?x=1#team', 'https://muscalaw.com/')).toBe('https://muscalaw.com/about');
  });
});

describe('pagePriority', () => {
  const priority = (path: string) => pagePriority(`https://firm.com${path}`);

  it('treats a bare language prefix as the home page', () => {
    for (const path of ['/', '/en', '/en/', '/es', '/en-us', '/es-MX/', '/pt-br']) expect(priority(path)).toBe(0);
  });

  it('classifies the page under a language prefix, not the prefix itself', () => {
    // The paths of a firm whose whole site lives under /en: on the live scan they all tied below the news.
    expect(priority('/en/general-pages/firm-health-artificial-intelligence-navigator')).toBe(1);
    expect(priority('/en/firm/client-payment-information')).toBe(2);
    expect(priority('/en/professionals')).toBe(3);
    expect(priority('/en/offices')).toBe(4);
    expect(priority('/en/services/practices')).toBe(5);
    expect(priority('/en/firm/legal/privacy')).toBe(6);
    expect(priority('/en/careers')).toBe(7);
    expect(priority('/en/insights/publications/2026/11/embracing-statutes-of-repose')).toBe(8);
    expect(priority('/en/news/pressreleases/2026/10/firm-ranked-for-platform-strength')).toBe(8);
    expect(priority('/en/events')).toBe(8);
  });

  it('does not take a two-letter section such as /ai/ for a language prefix', () => {
    expect(priority('/ai')).toBe(1);
    expect(priority('/ai/governance')).toBe(1);
    expect(priority('/ai-practice')).toBe(1);
    expect(priority('/services/generative-ai')).toBe(1);
    expect(priority('/legal-tech')).toBe(1);
    expect(priority('/innovation')).toBe(1);
  });

  it('orders AI, about, people, offices, services and privacy before the rest, and news after everything', () => {
    const ordered = ['/', '/artificial-intelligence', '/our-firm', '/attorneys', '/locations', '/practice-areas',
      '/privacy-policy', '/careers', '/blog/a-post'];
    expect(ordered.map(priority)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const path of ['/who-we-are', '/history', '/about-us']) expect(priority(path)).toBe(2);
    for (const path of ['/our-people', '/bios/jane-doe', '/lawyers', '/team', '/professionals/jane-doe']) expect(priority(path)).toBe(3);
    for (const path of ['/contact', '/contact-us', '/offices/miami']) expect(priority(path)).toBe(4);
    for (const path of ['/news', '/insights', '/events/webinar', '/press-releases', '/firm-news']) expect(priority(path)).toBe(8);
  });

  it('keeps an article in a news section last even when its slug names AI or the firm', () => {
    expect(priority('/en/insights/publications/2026/11/ai-governance-update')).toBe(8);
    expect(priority('/blog/about-our-firm')).toBe(8);
  });

  it('ranks a page by its own segment before its section', () => {
    // A privacy page filed under the firm section is a privacy page.
    expect(priority('/en/firm/legal/privacy')).toBe(6);
    expect(priority('/about/team')).toBe(3);
  });

  it('does not read a word that merely contains a stem as that stem', () => {
    expect(priority('/practices/affirmative-defense')).toBe(5);
    expect(priority('/newsletter-signup')).toBe(7);
    expect(priority('/biotech')).toBe(7);
  });

  it('never takes a careers, jobs or recruiting page for the people directory', () => {
    // A live scan ranked /en/careers/business-professionals as the firm's people page (DN-12 §13.8).
    for (const path of ['/en/careers/business-professionals', '/careers/experienced-attorneys', '/careers/lawyers',
      '/careers/attorneys/summer-associates', '/join-our-team', '/jobs/paralegal', '/recruiting/our-people', '/career-opportunities/team',
      '/es/trabaja-con-nosotros/abogados', '/empleo/abogados']) {
      expect(priority(path), path).toBe(7);
    }
  });

  it('reads a people word only as a whole segment or the head of one, not inside a compound', () => {
    for (const path of ['/business-professionals', '/experienced-attorneys', '/en/industries/sports-team-ownership']) {
      expect(priority(path), path).toBe(7);
    }
    for (const path of ['/our-people', '/meet-the-team', '/meet-our-team', '/our-attorneys', '/team-members', '/attorneys/jane-doe',
      '/en/professionals/d/doe-jane', '/nuestros-abogados', '/abogados-de-inmigracion-miami/', '/people-search']) {
      expect(priority(path), path).toBe(3);
    }
  });

  it('gives Spanish pages the same standing as their English equivalents', () => {
    expect(priority('/es/inteligencia-artificial')).toBe(1);
    expect(priority('/es/innovacion')).toBe(1);
    expect(priority('/la-firma')).toBe(2);
    expect(priority('/equipo')).toBe(3);
    expect(priority('/es/oficinas')).toBe(4);
    expect(priority('/contacto')).toBe(4);
    expect(priority('/servicios')).toBe(5);
    expect(priority('/aviso-legal')).toBe(6);
    for (const path of ['/noticias/x', '/eventos', '/prensa']) expect(priority(path)).toBe(8);
  });
});

describe('sitemapSeeds', () => {
  const root = 'https://firm.com/';
  const page = (path: string) => ({ url: `https://firm.com${path}`, kind: 'page' as const });

  it('keeps only AI, about, people and office pages, the shortest of each group first, in turns', () => {
    const links = [
      page('/blog/post'), page('/practice-areas'), page('/privacy'), page('/careers'),
      ...Array.from({ length: 10 }, (_, index) => page(`/en/professionals/person-${index}`)), page('/en/professionals'),
      page('/en/our-firm'), page('/en/our-firm/history'), page('/en/offices'), page('/en/offices/miami'),
      page('/en/general-pages/artificial-intelligence-navigator'), { url: 'https://firm.com/ai-guide.pdf', kind: 'document' as const },
    ];
    expect(sitemapSeeds(links, root).map(url => new URL(url).pathname)).toEqual([
      '/en/general-pages/artificial-intelligence-navigator', '/en/our-firm', '/en/professionals', '/en/offices',
      '/en/our-firm/history', '/en/professionals/person-0', '/en/offices/miami', '/en/professionals/person-1',
    ]);
  });

  it('does not seed a careers page as the people directory', () => {
    expect(sitemapSeeds([page('/en/careers/business-professionals'), page('/en/professionals')], root))
      .toEqual(['https://firm.com/en/professionals']);
  });

  it('takes one language version of a page', () => {
    expect(sitemapSeeds([page('/en/our-firm'), page('/es/our-firm'), page('/our-firm')], root)).toHaveLength(1);
  });

  it('leaves out other hosts and what is already queued', () => {
    expect(sitemapSeeds([{ url: 'https://other.com/about', kind: 'page' }, page('/about'), page('/team')], root,
      new Set(['https://firm.com/about']))).toEqual(['https://firm.com/team']);
  });
});
