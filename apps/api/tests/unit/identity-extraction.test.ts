import { describe, it, expect } from 'vitest';
import { firmNameFromSiteName } from '../../src/pipeline/website-evidence-provider.js';
import { pagePriority } from '../../src/pipeline/crawler.js';

describe('firm name recovered from og:site_name', () => {
  it('drops the marketing tail a site packs into its title', () => {
    expect(firmNameFromSiteName('Duque Immigration Law | Miami Immigration Attorney'))
      .toBe('Duque Immigration Law');
  });

  it('treats the usual title separators as separators', () => {
    expect(firmNameFromSiteName('Smith Law – Miami Trial Attorneys')).toBe('Smith Law');
    expect(firmNameFromSiteName('Smith Law — Miami')).toBe('Smith Law');
    expect(firmNameFromSiteName('Smith Law - Miami')).toBe('Smith Law');
  });

  it('leaves a plain firm name untouched', () => {
    expect(firmNameFromSiteName('Gallardo Law Firm')).toBe('Gallardo Law Firm');
    expect(firmNameFromSiteName('Smith & Jones, P.A.')).toBe('Smith & Jones, P.A.');
  });

  it('does not split a hyphenated name that has no separator spacing', () => {
    expect(firmNameFromSiteName('Smith-Jones Law')).toBe('Smith-Jones Law');
  });

  it('keeps the original when the leading segment is not a usable name', () => {
    expect(firmNameFromSiteName('FL | Duque Immigration Law')).toBe('FL | Duque Immigration Law');
    expect(firmNameFromSiteName('   ')).toBeNull();
  });
});

describe('crawl priority across languages', () => {
  const priority = (path: string) => pagePriority(`https://firm.com${path}`);

  it('keeps the established English ordering', () => {
    expect(priority('/')).toBe(0);
    expect(priority('/about-us')).toBe(1);
    expect(priority('/our-team')).toBe(2);
    expect(priority('/practice-areas')).toBe(3);
    expect(priority('/privacy-policy')).toBe(4);
    expect(priority('/blog/some-post')).toBe(5);
  });

  it('gives Spanish pages the same standing as their English equivalents', () => {
    expect(priority('/nosotros')).toBe(1);
    expect(priority('/quienes-somos')).toBe(1);
    expect(priority('/abogados-de-inmigracion-miami/')).toBe(2);
    expect(priority('/equipo')).toBe(2);
    expect(priority('/areas-de-practica/')).toBe(3);
    expect(priority('/servicios')).toBe(3);
    expect(priority('/politica-de-privacidad/')).toBe(4);
  });

  it('ranks the attorney page of a Spanish site above its blog', () => {
    const attorneys = priority('/abogados-de-inmigracion-miami/');
    for (const noise of ['/blog/', '/category/asilo-politico-en-usa/', '/author/cdadmin/',
      '/a-quien-puedo-incluir-en-mi-solicitud-de-asilo/', '/deportados-de-estados-unidos/']) {
      expect(attorneys).toBeLessThan(priority(noise));
    }
  });
});
