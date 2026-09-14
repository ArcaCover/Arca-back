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
  it('keeps a complete document whole and records its completeness', () => {
    const text = 'Privacy Policy\n' + 'Clause. '.repeat(1200);
    const corpus = buildCorpus({ pages: [{ url: 'https://firm.com/policy.pdf', html: '', text, kind: 'document', complete: true }], partial: false });
    expect(corpus.segments.every(segment => segment.kind === 'document')).toBe(true);
    expect(corpus.documents).toEqual([{ url: 'https://firm.com/policy.pdf', complete: true, chars: expect.any(Number) }]);
    // Segments are cut every 800 characters, sometimes mid-word, so compare content without whitespace.
    expect(corpus.segments.map(segment => segment.text).join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
  const longPage = (url: string, paragraphs: number) => ({ url, html: '',
    text: Array.from({ length: paragraphs }, (_, i) => `${url} paragraph ${i} ${'detail '.repeat(90)}`).join('\n\n') });
  it('keeps the about page ahead of a low-value page the agent requested', () => {
    const corpus = buildCorpus({ pages: [longPage('https://firm.com/about', 3), { ...longPage('https://firm.com/blog', 3), requested: true }],
      partial: false }, 2_100);
    expect(corpus.segments.some(segment => segment.url === 'https://firm.com/about')).toBe(true);
    expect(corpus.omittedUrls).toContain('https://firm.com/blog');
  });
  it('includes a page the agent requested before pages the crawler found', () => {
    const corpus = buildCorpus({ pages: [longPage('https://firm.com/practice-a', 3), longPage('https://firm.com/practice-b', 3),
      { url: 'https://firm.com/carmen-gallardo', html: '', text: `Carmen Gallardo, Esq. Founding Partner. ${'Biography '.repeat(70)}`, requested: true }],
    partial: false }, 2_000);
    expect(corpus.segments.some(segment => segment.url === 'https://firm.com/carmen-gallardo')).toBe(true);
  });
});
