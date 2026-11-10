import { describe, expect, it, vi } from 'vitest';
import { createRobotsCache } from '../../src/pipeline/robots.js';
import { readSitemap } from '../../src/pipeline/sitemap-reader.js';
import { MAX_DOCUMENT_CHARS, readDocument } from '../../src/pipeline/document-reader.js';

const pdf = Buffer.from('%PDF-1.7 fake');
const transport = (overrides: Partial<Parameters<typeof readDocument>[2]> = {}) => ({
  robots: async () => ({ status: 404, text: '' }),
  response: async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf }),
  extract: async () => ({ totalPages: 2, text: ['Política de privacidad', 'No compartimos datos de clientes.'] }),
  ...overrides,
});

describe('document reader', () => {
  it('reads a same-host PDF completely', async () => {
    const result = await readDocument('https://firm.com/files/policy.pdf', new AbortController().signal, transport());
    expect(result.page).toMatchObject({ url: 'https://firm.com/files/policy.pdf', kind: 'document', complete: true });
    expect(result.page?.text).toContain('No compartimos datos de clientes.');
  });

  it('refuses non-PDF bodies, off-host redirects and robots exclusions', async () => {
    const html = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      response: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }) }));
    expect(html).toEqual({ page: null, detail: 'NOT_PDF' });
    const redirect = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      response: async () => ({ status: 302, headers: { location: 'https://evil.com/a.pdf' }, body: Buffer.alloc(0) }) }));
    expect(redirect).toEqual({ page: null, detail: 'OFF_HOST_REDIRECT' });
    const robots = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      robots: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /' }) }));
    expect(robots).toEqual({ page: null, detail: 'ROBOTS_DISALLOWED' });
  });

  it('reads a document when robots.txt answers 403, and nothing when it is unreachable', async () => {
    const forbidden = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      robots: async () => ({ status: 403, text: 'Forbidden' }) }));
    expect(forbidden.page).toMatchObject({ kind: 'document' });
    const response = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf }));
    const unreachable = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      response, robots: async () => ({ status: 503, text: '' }) }));
    expect(unreachable).toEqual({ page: null, detail: 'ROBOTS_UNAVAILABLE' });
    expect(response).not.toHaveBeenCalled();
  });

  it('checks the rules of the origin a redirect lands on', async () => {
    const result = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      response: async (url: string) => ({ body: pdf, ...(url.startsWith('https://www.')
        ? { status: 200, headers: { 'content-type': 'application/pdf' } as Record<string, string> }
        : { status: 301, headers: { location: 'https://www.firm.com/a.pdf' } as Record<string, string> }) }),
      robots: async (url: string) => ({ status: 200, text: url.startsWith('https://www.') ? 'User-agent: *\nDisallow: /' : '' }) }));
    expect(result).toEqual({ page: null, detail: 'ROBOTS_DISALLOWED' });
  });

  it('shares one robots.txt download per origin with the other readers of the scan', async () => {
    const robots = vi.fn(async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private' }));
    const cache = createRobotsCache();
    const first = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({ robots }), cache);
    const second = await readDocument('https://firm.com/private/b.pdf', new AbortController().signal, transport({ robots }), cache);
    await readSitemap('firm.com', new AbortController().signal, { response: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), robots }, cache);
    expect(first.page).not.toBeNull();
    expect(second).toEqual({ page: null, detail: 'ROBOTS_DISALLOWED' });
    expect(robots).toHaveBeenCalledTimes(1);
  });

  it('marks an oversized document as incomplete', async () => {
    const result = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      extract: async () => ({ totalPages: 1, text: ['x'.repeat(MAX_DOCUMENT_CHARS + 1)] }) }));
    expect(result.page).toMatchObject({ complete: false });
    expect(result.page!.text.length).toBe(MAX_DOCUMENT_CHARS);
  });
});
