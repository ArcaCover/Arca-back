import { expect, it, vi } from 'vitest';
import { createRobotsCache } from '../../src/pipeline/robots.js';
import { crawlWebsite } from '../../src/pipeline/crawler.js';
import { createSiteAccess } from '../../src/pipeline/site-access.js';

const transport = {
  robots: async () => ({ status: 404, text: '' }),
  response: async (raw: string) => {
    const path = new URL(raw).pathname;
    const html = path === '/' ? '<body>Home page</body>' : `<body>Profile at ${path}</body>`;
    return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
  },
};

it('reads only the seed page when the crawl is limited to it', async () => {
  const result = await crawlWebsite('https://fixture.example/carmen-gallardo', new AbortController().signal, transport as never,
    { maxPages: 1, maxDepth: 0, seedOnly: true });
  expect(result.pages.map(page => new URL(page.url).pathname)).toEqual(['/carmen-gallardo']);
}, 30_000);

it('fetches the page the agent asked for, not the home page', async () => {
  const result = await createSiteAccess(transport as never).fetchPages(['https://fixture.example/carmen-gallardo'], new AbortController().signal);
  expect(result.pages.map(page => new URL(page.url).pathname)).toEqual(['/carmen-gallardo']);
  expect(result.pages[0]!.text).toContain('Profile at /carmen-gallardo');
  expect(result.calls).toEqual([{ tool: 'fetch_pages', target: 'https://fixture.example/carmen-gallardo', status: 'read', detail: null }]);
}, 30_000);

it('downloads robots.txt once for every tool call of a scan', async () => {
  const pdf = Buffer.from('%PDF-1.7 fake');
  const robots = vi.fn(async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private/' }));
  const access = createSiteAccess({
    robots,
    response: async (raw: string) => new URL(raw).pathname.endsWith('.pdf')
      ? { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf } : await transport.response(raw),
    extract: async () => ({ totalPages: 1, text: ['Privacy policy'] }),
    text: async () => ({ status: 200, text: '<urlset><url><loc>https://fixture.example/team</loc></url><url><loc>https://fixture.example/private/x</loc></url></urlset>' }),
  }).withRobots!(createRobotsCache());
  const signal = new AbortController().signal;
  const pages = await access.fetchPages(['https://fixture.example/about', 'https://fixture.example/team', 'https://fixture.example/private/memo'], signal);
  const documents = await access.readDocuments(['https://fixture.example/policy.pdf', 'https://fixture.example/private/fees.pdf'], signal);
  const sitemap = await access.readSitemap('fixture.example', signal);
  expect(pages.calls.map(call => [call.status, call.detail])).toEqual([['read', null], ['read', null], ['failed', 'ROBOTS_DISALLOWED']]);
  expect(documents.calls.map(call => [call.status, call.detail])).toEqual([['read', 'complete'], ['failed', 'ROBOTS_DISALLOWED']]);
  expect(sitemap.links).toEqual([{ url: 'https://fixture.example/team', kind: 'page' }]);
  expect(robots).toHaveBeenCalledTimes(1);
}, 60_000);

it('keeps no robots answer between scans: an access without a scan cache asks every time', async () => {
  const robots = vi.fn(async () => ({ status: 404, text: '' }));
  const access = createSiteAccess({ ...transport, robots });
  await access.fetchPages(['https://fixture.example/about'], new AbortController().signal);
  await access.fetchPages(['https://fixture.example/team'], new AbortController().signal);
  expect(robots).toHaveBeenCalledTimes(2);
}, 60_000);
