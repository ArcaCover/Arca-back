import { describe, expect, it } from 'vitest';
import { buildCorpus, normalizeForGrounding } from '../../src/pipeline/evidence-corpus.js';

describe('evidence corpus', () => {
  const page = (url: string, text: string) => ({ url, text, html: `<title>Firm &amp; Co</title><body>${text}</body>` });
  it('keeps document-derived IDs stable when another page is inserted', () => {
    const a = buildCorpus({ pages: [page('https://firm.com/team', 'Jane Doe Attorney')], partial: false });
    const b = buildCorpus({ pages: [page('https://firm.com/about', 'About'), page('https://firm.com/team', 'Jane Doe Attorney')], partial: false });
    expect(b.segments.find(segment => segment.url.endsWith('/team'))?.id).toBe(a.segments.find(segment => segment.url.endsWith('/team'))?.id);
  });
  it('extracts metadata and same-domain link IDs while enforcing the budget', () => {
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/', text: 'A'.repeat(200),
      html: '<title>Firm &amp; Co</title><a href="/team">Team</a><a href="https://other.com">Other</a>' }], partial: false }, 40);
    expect(corpus.segments.some(segment => segment.text === 'Firm & Co')).toBe(true);
    expect(corpus.links).toHaveLength(1);
    expect(corpus.truncated).toBe(true);
  });
  it('preserves accents and negation while normalizing presentation spaces', () => {
    expect(normalizeForGrounding('No   usamos  IA')).toBe('No usamos IA');
    expect(normalizeForGrounding('inmigración')).not.toBe(normalizeForGrounding('inmigracion'));
  });
  it('offers PDFs as documents and drops links the crawler cannot read', () => {
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/', text: 'Home', html:
      '<a href="/team">Team</a><a href="/files/Policy.pdf">Privacy</a><a href="/logo.png">Logo</a><a href="mailto:a@firm.com">Mail</a>' }],
    partial: false });
    expect(corpus.links.map(link => [new URL(link.url).pathname, link.kind])).toEqual([['/team', 'page'], ['/files/Policy.pdf', 'document']]);
  });
});
