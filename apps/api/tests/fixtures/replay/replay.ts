import { createHash } from 'node:crypto';
import type { CrawledPage } from '../../../src/pipeline/crawler.js';
import type { SiteAccess } from '../../../src/pipeline/site-access.js';

// The seams of the real pipeline, answered from recordings: the model client, the page reader the extraction
// calls, and the HTTP transport of the Apify client. Nothing here opens a socket or a browser, and anything
// the recordings do not hold is listed in `unexpected`, so a test can say exactly what drifted.

/** JSON with object keys in a fixed order, so two values compare equal whatever order they were built in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** A recorded model response is found by the hash of the whole prompt: the system text and the user text. */
export const promptKey = (system: string, user: string) => createHash('sha256').update(`${system}\n\n${user}`).digest('hex');
export type ModelRecordings = Record<string, { phase: string; response: unknown }>;
/** Stands in for the model while recording. A replay never has one. */
export type Answer = (system: string, user: string) => { phase: string; response: unknown };

export function replayModel(recordings: ModelRecordings, answer?: Answer) {
  const calls: string[] = [], unexpected: string[] = [];
  const create = async (body: Record<string, unknown>) => {
    const [system, user] = (body.messages as Array<{ content: string }>).map(message => message.content) as [string, string];
    const key = promptKey(system, user);
    calls.push(key);
    if (!recordings[key] && answer) recordings[key] = answer(system, user);
    const recorded = recordings[key];
    if (!recorded) {
      unexpected.push(`model prompt ${key.slice(0, 12)} (${user.slice(0, 60).replace(/\s+/g, ' ')})`);
      throw new Error(`No recorded model response for prompt ${key}`);
    }
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(recorded.response) } }] };
  };
  return { calls, unexpected, client: { chat: { completions: { create } } } };
}

export function replayAccess(pages: CrawledPage[]) {
  const fetched: string[] = [], unexpected: string[] = [];
  const access: SiteAccess = {
    async fetchPages(urls) {
      const found: CrawledPage[] = [], calls: Awaited<ReturnType<SiteAccess['fetchPages']>>['calls'] = [];
      for (const url of urls) {
        const page = pages.find(item => item.url === url);
        fetched.push(url);
        if (page) found.push(structuredClone(page)); else unexpected.push(`page ${url}`);
        calls.push({ tool: 'fetch_pages', target: url, status: page ? 'read' : 'failed', detail: page ? null : 'NOT_RECORDED' });
      }
      return { pages: found, calls };
    },
    async readDocuments(urls) {
      unexpected.push(...urls.map(url => `document ${url}`));
      return { pages: [], calls: urls.map(url => ({ tool: 'read_document' as const, target: url, status: 'failed' as const, detail: 'NOT_RECORDED' })) };
    },
    async readSitemap(domain) {
      unexpected.push(`sitemap ${domain}`);
      return { links: [], calls: [{ tool: 'read_sitemap', target: `https://${domain}/`, status: 'failed', detail: 'NOT_RECORDED' }] };
    },
  };
  return { access, fetched, unexpected };
}

export type ApifyRecording = { actor: string; input: Record<string, unknown>;
  run: { id: string; status: string; defaultDatasetId: string; usageTotalUsd: number; buildId?: string; buildNumber?: string };
  items: unknown[] };

/** `posts` counts actor starts, the calls that cost money; `requests` counts everything sent to Apify. */
export function replayApify(recordings: ApifyRecording[]) {
  const posts: string[] = [], requests: string[] = [], unexpected: string[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const start = /^\/v2\/acts\/([^/]+)\/runs$/.exec(url.pathname);
    if (start && init?.method === 'POST') {
      const actor = decodeURIComponent(start[1]!).replace('~', '/'), sent = canonicalJson(JSON.parse(String(init.body)));
      posts.push(`${actor} ${sent}`);
      const recorded = recordings.find(item => item.actor === actor && canonicalJson(item.input) === sent);
      if (recorded) return Response.json({ data: recorded.run });
      unexpected.push(`actor start ${actor} ${sent}`);
      return Response.json({ error: { type: 'record-not-found' } }, { status: 404 });
    }
    const dataset = /^\/v2\/datasets\/([^/]+)\/items$/.exec(url.pathname);
    const recorded = dataset && recordings.find(item => item.run.defaultDatasetId === decodeURIComponent(dataset[1]!));
    if (recorded) {
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
      return Response.json(recorded.items.slice(offset, offset + limit));
    }
    unexpected.push(`request ${init?.method ?? 'GET'} ${url.pathname}`);
    return Response.json({ error: { type: 'record-not-found' } }, { status: 404 });
  };
  return { posts, requests, unexpected, request: request as typeof fetch };
}
