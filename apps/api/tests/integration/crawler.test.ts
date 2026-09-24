import { it, expect } from 'vitest';
import { crawlWebsite } from '../../src/pipeline/crawler.js';

it('renders real browser pages, respects robots, depth and text visibility without external traffic', async () => {
  const visited: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /blocked' }),
    response: async raw => {
      visited.push(raw);
      const path = new URL(raw).pathname;
      const html = path === '/' ? '<body><nav>Ignore nav</nav><h1>Smith Law</h1><span style="display:none">Hidden policy</span><script>document.body.insertAdjacentHTML("beforeend", "<p>Rendered team</p>")</script><a href="/about">About</a><a href="/blocked">Restricted</a><a href="https://other.example/">External</a></body>'
        : path === '/about' ? '<body>About firm<a href="/team">Team</a></body>' : '<body>Jane Smith<a href="/too-deep">Deep</a></body>';
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
    },
  });
  expect(result.pages).toHaveLength(3);
  expect(result.partial).toBe(true);
  expect(visited.some(url => /blocked|other.example|too-deep/.test(url))).toBe(false);
  const home = result.pages.find(page => new URL(page.url).pathname === '/')!;
  expect(home.text).toContain('Rendered team');
  expect(home.text).not.toMatch(/Ignore nav|Hidden policy/);
  expect(home.html).toContain('Hidden policy');
}, 15_000);

it('does not requeue the home page under its own www link', async () => {
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      // A logo link back to the www form is common on real sites (this is literally what
      // muscalaw.com does). Without www normalization it looks like a second, unvisited page
      // even though it points at the page already read.
      body: Buffer.from('<body>Home<a href="https://www.fixture.example/">Home</a></body>'),
    }),
  });
  expect(result.pages).toHaveLength(1);
}, 15_000);

it('reserves budget for privacy and blog pages instead of letting many attorney bios crowd them out', async () => {
  const body = (path: string) => {
    if (path === '/') {
      const bios = Array.from({ length: 6 }, (_, i) => `<a href="/team/person-${i + 1}">Person ${i + 1}</a>`).join('');
      return `<body>${bios}<a href="/privacy">Privacy</a><a href="/blog">Blog</a></body>`;
    }
    if (path === '/privacy') return '<body>Privacy policy text</body>';
    if (path === '/blog') return '<body>Blog index</body>';
    return '<body>Attorney bio</body>';
  };
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(body(new URL(raw).pathname)),
    }),
  }, { maxPages: 6 });
  const paths = result.pages.map(page => new URL(page.url).pathname).sort();
  expect(paths).toContain('/privacy');
  expect(paths).toContain('/blog');
  const attorneyPages = paths.filter(path => path.startsWith('/team/person-'));
  expect(attorneyPages.length).toBeLessThanOrEqual(3);
  expect(paths).toHaveLength(6);
}, 15_000);

it('records a redirected page under its canonical (bare) url, not the raw post-redirect www form', async () => {
  // muscalaw.com's own server redirects the bare domain to www. Chromium follows the redirect and
  // page.url() reports the final, www-prefixed address. If that raw address were stored as-is, it
  // would no longer match the bare form every discovered link canonicalizes to (crawler.ts's own
  // canonicalUrl), and the page would look unread the next time a link to it surfaces — wasting a
  // floor-fetch slot re-reading content already in hand. A client-side redirect (rather than an HTTP
  // 3xx, which route.fulfill cannot reliably simulate against a fake hostname in this harness) drives
  // the browser through the exact same page.url()-diverges-from-the-request scenario.
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => {
      if (new URL(raw).hostname === 'fixture.example') {
        return { status: 200, headers: { 'content-type': 'text/html' },
          body: Buffer.from('<body><script>location.href="https://www.fixture.example/"</script></body>') };
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<body>Home</body>') };
    },
  });
  expect(result.pages).toHaveLength(1);
  expect(result.pages[0]!.url).toBe('https://fixture.example/');
}, 15_000);
