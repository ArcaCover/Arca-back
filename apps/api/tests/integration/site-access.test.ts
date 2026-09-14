import { expect, it } from 'vitest';
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
