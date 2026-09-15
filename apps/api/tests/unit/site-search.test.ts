import { describe, expect, it } from 'vitest';
import { findPassages } from '../../src/pipeline/site-search.js';

describe('site search', () => {
  const text = 'Servicios legales. ' + 'Relleno. '.repeat(80) + 'Nuestro despacho utiliza Inteligencia Artificial con revisión humana. ' + 'Fin. '.repeat(40);
  const pages = [{ url: 'https://firm.com/servicios', html: '', text }];

  it('returns verbatim passages whatever the case or accents of the term', () => {
    const passages = findPassages(pages, ['inteligencia artificial', 'REVISION HUMANA']);
    expect(passages).toHaveLength(1);
    expect(text.slice(passages[0]!.start, passages[0]!.end)).toBe(passages[0]!.text);
    expect(passages[0]!.text).toContain('Inteligencia Artificial con revisión humana');
  });

  it('caps the number of passages', () => {
    const repeated = [{ url: 'https://firm.com/a', html: '', text: Array.from({ length: 30 }, (_, i) => `IA ${i}. ${'x'.repeat(700)}`).join(' ') }];
    expect(findPassages(repeated, ['IA'], { maxPassages: 5 })).toHaveLength(5);
  });
});
