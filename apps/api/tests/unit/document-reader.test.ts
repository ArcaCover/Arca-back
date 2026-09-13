import { describe, expect, it } from 'vitest';
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

  it('marks an oversized document as incomplete', async () => {
    const result = await readDocument('https://firm.com/a.pdf', new AbortController().signal, transport({
      extract: async () => ({ totalPages: 1, text: ['x'.repeat(MAX_DOCUMENT_CHARS + 1)] }) }));
    expect(result.page).toMatchObject({ complete: false });
    expect(result.page!.text.length).toBe(MAX_DOCUMENT_CHARS);
  });
});
