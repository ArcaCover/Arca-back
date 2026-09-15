import { extractText, getDocumentProxy } from 'unpdf';
import { fetchPublicResponse, fetchPublicText } from './network.js';
import { robotsAllows } from './robots.js';
import type { CrawledPage } from './crawler.js';

export const MAX_DOCUMENT_CHARS = 60_000;
export type DocumentTransport = {
  response: typeof fetchPublicResponse; robots: typeof fetchPublicText;
  extract: (bytes: Uint8Array) => Promise<{ totalPages: number; text: string[] }>;
};
const defaults: DocumentTransport = { response: fetchPublicResponse, robots: fetchPublicText,
  extract: async bytes => { const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
    const result = await extractText(pdf, { mergePages: false });
    return { totalPages: result.totalPages, text: result.text as string[] }; } };
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');

/** Reads a same-host PDF. `complete` is true only when every extracted character is kept. */
export async function readDocument(url: string, signal: AbortSignal, transport: DocumentTransport = defaults):
  Promise<{ page: CrawledPage | null; detail: string | null }> {
  try {
    if (!(await robotsAllows(url, signal, transport.robots))) return { page: null, detail: 'ROBOTS_DISALLOWED' };
    let next = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await transport.response(next, signal);
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        const target = new URL(response.headers.location, next).href;
        if (host(target) !== host(url)) return { page: null, detail: 'OFF_HOST_REDIRECT' };
        next = target;
        continue;
      }
      if (response.status !== 200) return { page: null, detail: `HTTP_${response.status}` };
      const isPdf = /application\/pdf/i.test(response.headers['content-type'] ?? '') || response.body.subarray(0, 5).toString('latin1') === '%PDF-';
      if (!isPdf) return { page: null, detail: 'NOT_PDF' };
      const { text } = await transport.extract(new Uint8Array(response.body));
      const full = text.map(pageText => pageText.trim()).filter(Boolean).join('\n\n');
      return { page: { url: next, html: '', text: full.slice(0, MAX_DOCUMENT_CHARS), kind: 'document',
        complete: full.length <= MAX_DOCUMENT_CHARS }, detail: null };
    }
    return { page: null, detail: 'TOO_MANY_REDIRECTS' };
  } catch (error) {
    return { page: null, detail: error instanceof Error ? error.message.slice(0, 200) : 'DOCUMENT_READ_FAILED' };
  }
}
