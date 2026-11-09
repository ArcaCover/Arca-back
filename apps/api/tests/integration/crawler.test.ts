import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { it, expect } from 'vitest';
import { MAX_PAGE_ATTEMPTS, crawlWebsite, type CrawlResult } from '../../src/pipeline/crawler.js';
import { crawlNotes, unreadableWebsite } from '../../src/pipeline/website-outcome.js';

// Every test here drives a real headless Chromium against fixture transports: no request leaves the machine.
// Nothing below asserts on elapsed time, and the timeouts are wide, so a loaded machine slows them without failing them.
const html = (body: string, status = 200) => ({ status, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<body>${body}</body>`) });
const path = (url: string) => new URL(url).pathname;
const listed = (result: CrawlResult) => (result.issues ?? [])
  .map(issue => `${issue.scope} ${issue.code} ${issue.status} ${new URL(issue.url).host}${path(issue.url)}`).sort();

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
  // The excluded link is on record, but obeying robots.txt is not a failed crawl.
  expect(result.partial).toBe(false);
  expect(listed(result)).toEqual(['page ROBOTS_DISALLOWED null fixture.example/blocked']);
  expect(visited.some(url => /blocked|other.example|too-deep/.test(url))).toBe(false);
  const home = result.pages.find(page => new URL(page.url).pathname === '/')!;
  expect(home.text).toContain('Rendered team');
  expect(home.text).not.toMatch(/Ignore nav|Hidden policy/);
  expect(home.html).toContain('Hidden policy');
}, 30_000);

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
}, 30_000);

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
}, 30_000);

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
}, 30_000);

it('records decided pages, a refused XHR and a failed third-party script without calling the crawl partial', async () => {
  const requested: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /wp-admin/\nDisallow: /wp-json/' }),
    response: async raw => {
      requested.push(raw);
      const url = new URL(raw);
      // The founder's scan: a widget script on another host that does not resolve.
      if (url.hostname !== 'fixture.example') throw new Error('getaddrinfo ENOTFOUND widgets.example');
      switch (url.pathname) {
        case '/': return html('<h1>Smith Law</h1><a href="/about">About</a><a href="/wp-admin/">Admin</a><a href="/gone">Old</a>'
          + '<a href="/retired">Retired</a><a href="/feed">Feed</a><a href="/brochure.docx">Brochure</a>'
          + '<script src="https://widgets.example/w.js"></script><script>fetch("/wp-json/private/data").catch(() => {})</script>'
          + '<iframe src="/wp-admin/frame"></iframe>');
        case '/about': return html('About the firm');
        case '/gone': return html('Not found', 404);
        case '/retired': return html('Gone', 410);
        case '/feed': return { status: 200, headers: { 'content-type': 'application/rss+xml' }, body: Buffer.from('<rss></rss>') };
        default: return { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
          body: Buffer.from('PK') };
      }
    },
  });
  expect(result.pages.map(page => path(page.url))).toEqual(['/', '/about']);
  expect(result.partial).toBe(false);
  expect(result.aborted).toBe(false);
  expect(listed(result)).toEqual([
    'page HTTP_ERROR 404 fixture.example/gone',
    'page HTTP_ERROR 410 fixture.example/retired',
    'page NOT_HTML 200 fixture.example/brochure.docx',
    'page NOT_HTML 200 fixture.example/feed',
    'page ROBOTS_DISALLOWED null fixture.example/wp-admin/',
    'request REQUEST_FAILED null widgets.example/w.js',
    // A frame inside a page is not a page of the crawl: it is on record like the script's request.
    'request ROBOTS_DISALLOWED null fixture.example/wp-admin/frame',
    'request ROBOTS_DISALLOWED null fixture.example/wp-json/private/data',
  ]);
  // What robots.txt excludes is never requested, as a page or from a page's own script.
  expect(requested.some(url => /wp-admin|wp-json/.test(url))).toBe(false);
  // A decided page is asked once: retrying it would only spend the deadline.
  for (const decided of ['/gone', '/retired', '/feed', '/brochure.docx']) {
    expect([decided, requested.filter(url => path(url) === decided).length]).toEqual([decided, 1]);
  }
}, 30_000);

it('takes a file behind a redirect for a link to non-HTML content, not for a page that failed', async () => {
  // A site that redirects its bare domain to www answers every link with a 301 first, and the browser follows a
  // redirect with its own network stack, so the file arrives as a download. A loopback server stands for the www
  // host: no request leaves the machine.
  const files: Record<string, Record<string, string>> = {
    '/card': { 'content-type': 'text/vcard', 'content-disposition': 'attachment; filename="jane.vcf"' },
    '/brochure': { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    '/report': { 'content-type': 'application/pdf' },
    '/feed': { 'content-type': 'application/rss+xml' },
  };
  const served: string[] = [];
  const server = createServer((request, response) => {
    served.push(request.url ?? '');
    response.writeHead(200, files[request.url ?? '']).end(request.url === '/feed' ? '<rss></rss>' : 'PK');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const requested: string[] = [];
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => {
        requested.push(path(raw));
        if (path(raw) === '/') return html(`Smith Law<a href="/about">About</a>${Object.keys(files).map(file => `<a href="${file}">File</a>`).join('')}`);
        if (path(raw) === '/about') return html('About the firm');
        return { status: 301, headers: { location: `http://127.0.0.1:${port}${path(raw)}` }, body: Buffer.alloc(0) };
      },
    });
    expect(result.pages.map(page => path(page.url))).toEqual(['/', '/about']);
    expect(result.partial).toBe(false);
    expect(listed(result)).toEqual([
      // The download carries no status the crawler can see; the feed is rendered by the browser, so it has one.
      'page NOT_HTML 200 fixture.example/feed',
      'page NOT_HTML null fixture.example/brochure',
      'page NOT_HTML null fixture.example/card',
      'page NOT_HTML null fixture.example/report',
    ]);
    expect(crawlNotes(result)).toBe('4 links to non-HTML content');
    // Asked once each: a download is an answer, and retrying it would only spend the deadline.
    expect(requested.sort()).toEqual(['/', '/about', '/brochure', '/card', '/feed', '/report']);
    expect(served.sort()).toEqual(['/brochure', '/card', '/feed', '/report']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}, 30_000);

it('drops the download of a file it will not read', async () => {
  // The server never finishes the file, so only the browser giving the download up closes the connection.
  let drop!: () => void;
  const dropped = new Promise<true>(resolve => { drop = () => resolve(true); });
  const server = createServer((_request, response) => {
    response.on('close', drop);
    response.writeHead(200, { 'content-type': 'application/zip' }).write('PK');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let droppedBeforeNextPage = false;
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => {
        if (path(raw) === '/') return html('Smith Law<a href="/archive">Archive</a><a href="/later">Later</a>');
        if (path(raw) === '/archive') return { status: 301, headers: { location: `http://127.0.0.1:${port}/archive` }, body: Buffer.alloc(0) };
        // One page at a time, so this page is asked for after the file. The wait ends as soon as the connection
        // closes; the timer only bounds a crawler that kept the download running.
        droppedBeforeNextPage = await Promise.race([dropped, sleep(5000, false, { ref: false })]);
        return html('Later');
      },
    }, { concurrency: 1 });
    expect(result.pages.map(page => path(page.url))).toEqual(['/', '/later']);
    expect(listed(result)).toEqual(['page NOT_HTML null fixture.example/archive']);
    expect(result.partial).toBe(false);
    expect(droppedBeforeNextPage).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}, 30_000);

it('does not spend the page budget on links robots.txt excludes', async () => {
  // Excluded links sort before the readable pages here. They cost no request, so they must not take their place.
  const excluded = Array.from({ length: 5 }, (_, index) => `<a href="/category/c${index}">Category</a>`).join('');
  const readable = ['/contact', '/results', '/visas'];
  const requested: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /category/' }),
    response: async raw => {
      requested.push(path(raw));
      // Every page repeats the menu, as real sites do.
      return html(`Page ${path(raw)}${excluded}${readable.map(link => `<a href="${link}">Page</a>`).join('')}`);
    },
  }, { maxPages: 4 });
  expect(result.pages.map(page => path(page.url))).toEqual(['/', ...readable]);
  expect(requested.sort()).toEqual(['/', ...readable]);
  expect(result.partial).toBe(false);
  expect(crawlNotes(result)).toBe('5 pages excluded by robots.txt');
}, 30_000);

it('does not ask another host for its robots.txt before loading what a page takes from it', async () => {
  const robots: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    // The CDN excludes every crawler. It is not being crawled: the page is, and it needs its script to render.
    robots: async url => { robots.push(url); return { status: 200, text: new URL(url).hostname === 'cdn.example' ? 'User-agent: *\nDisallow: /' : '' }; },
    response: async raw => new URL(raw).hostname === 'cdn.example'
      ? { status: 200, headers: { 'content-type': 'text/javascript' }, body: Buffer.from('document.getElementById("root").textContent = "Smith Law"') }
      : html('<div id="root"></div><script src="https://cdn.example/app.js"></script>'),
  });
  expect(result.pages.map(page => page.text)).toEqual(['Smith Law']);
  expect(robots).toEqual(['https://fixture.example/robots.txt']);
  expect(listed(result)).toEqual([]);
}, 30_000);

it('calls the crawl partial when a page of the site keeps failing', async () => {
  let attempts = 0;
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => {
      if (path(raw) === '/') return html('Smith Law<a href="/team">Team</a>');
      attempts++;
      return html('Server error', 500);
    },
  });
  expect(result.pages.map(page => path(page.url))).toEqual(['/']);
  expect(result.partial).toBe(true);
  expect(attempts).toBe(MAX_PAGE_ATTEMPTS);
  expect(listed(result)).toEqual(['page HTTP_ERROR 500 fixture.example/team', 'request HTTP_ERROR 500 fixture.example/team']);
}, 30_000);

it('does not take a home page left empty by a script that failed to load for a site that refuses to be read', async () => {
  const shell = (script: string) => html(`<div id="root"></div><script src="${script}"></script>`);
  // The firm's own bundle answers 503 this once.
  const own = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => path(raw) === '/' ? shell('/app.js')
      : { status: 503, headers: { 'content-type': 'text/plain' }, body: Buffer.from('busy') },
  });
  expect(own.pages).toEqual([]);
  expect(listed(own)).toEqual(['page NO_READABLE_CONTENT 200 fixture.example/', 'request HTTP_ERROR 503 fixture.example/app.js']);
  expect(unreadableWebsite(own)).toMatchObject({ classification: 'TRANSIENT', code: 'NO_READABLE_EVIDENCE',
    reason: 'The website returned a page with no readable text (1 of its requests failed)' });

  // The bundle is on another host that does not resolve: the kind of failure the founder's scan had.
  const thirdParty = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async raw => {
      if (new URL(raw).hostname !== 'fixture.example') throw new Error('getaddrinfo ENOTFOUND cdn.example');
      return shell('https://cdn.example/app.js');
    },
  });
  expect(thirdParty.pages).toEqual([]);
  expect(listed(thirdParty)).toEqual(['page NO_READABLE_CONTENT 200 fixture.example/', 'request REQUEST_FAILED null cdn.example/app.js']);
  expect(unreadableWebsite(thirdParty)).toMatchObject({ classification: 'TRANSIENT', code: 'NO_READABLE_EVIDENCE',
    reason: 'The website returned a page with no readable text (1 of its requests failed)' });
}, 30_000);

it('does not take a page whose content had not arrived yet for a site that refuses to be read', async () => {
  // No request fails here: the page fills itself in later than the crawler waits. A long timer stands for the
  // slow script, so the outcome does not depend on how fast the machine is.
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async () => html('<script>setTimeout(() => { document.body.textContent = "Smith Law"; }, 600000)</script>'),
  });
  expect(result.pages).toEqual([]);
  expect(listed(result)).toEqual(['page NO_READABLE_CONTENT 200 fixture.example/']);
  expect(unreadableWebsite(result)).toMatchObject({ classification: 'TRANSIENT', code: 'NO_READABLE_EVIDENCE',
    reason: 'The website returned a page with no readable text' });
}, 30_000);

it('reads a site whose robots.txt answers 403, and nothing from one whose robots.txt answers 503', async () => {
  const crawl = async (robotsStatus: number) => {
    const robots: string[] = [], requested: string[] = [];
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async url => { robots.push(url); return { status: robotsStatus, text: 'Forbidden' }; },
      response: async raw => { requested.push(raw); return path(raw) === '/' ? html('Smith Law<a href="/about">About</a>') : html('About the firm'); },
    });
    return { result, robots, requested };
  };
  const forbidden = await crawl(403);
  expect(forbidden.result.pages.map(page => path(page.url))).toEqual(['/', '/about']);
  expect(forbidden.result.partial).toBe(false);
  expect(listed(forbidden.result)).toEqual([]);
  expect(forbidden.robots).toEqual(['https://fixture.example/robots.txt']);

  const unreachable = await crawl(503);
  expect(unreachable.result.pages).toEqual([]);
  expect(unreachable.result.partial).toBe(true);
  expect(unreachable.requested).toEqual([]);
  // Asked once: the answer stands for the scan, and the page is not retried against it.
  expect(unreachable.robots).toEqual(['https://fixture.example/robots.txt']);
  expect(listed(unreachable.result)).toEqual([
    'page ROBOTS_UNAVAILABLE 503 fixture.example/',
    'robots ROBOTS_UNAVAILABLE 503 fixture.example/robots.txt',
  ]);
}, 30_000);

it('does not follow a redirect into an origin whose robots.txt excludes the page', async () => {
  const requested: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async url => ({ status: 200, text: new URL(url).hostname.startsWith('www.') ? 'User-agent: *\nDisallow: /' : '' }),
    response: async raw => {
      requested.push(raw);
      return { status: 301, headers: { location: 'https://www.fixture.example/' }, body: Buffer.alloc(0) };
    },
  });
  expect(result.pages).toEqual([]);
  // The site's answer, reported as such: not a failed navigation retried three times.
  expect(listed(result)).toEqual(['page ROBOTS_DISALLOWED null fixture.example/']);
  expect(result.partial).toBe(false);
  expect(requested).toEqual(['https://fixture.example/']);
}, 30_000);

it('reads one page at a time when the site declares a Crawl-delay', async () => {
  let open = 0, widest = 0;
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 200, text: 'User-agent: *\nCrawl-delay: 0.05' }),
    response: async raw => {
      widest = Math.max(widest, ++open);
      await new Promise(resolve => setTimeout(resolve, 100));
      open--;
      return path(raw) === '/' ? html('Home<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>') : html(`Page ${path(raw)}`);
    },
  });
  expect(result.pages.map(page => path(page.url))).toEqual(['/', '/a', '/b', '/c']);
  expect(widest).toBe(1);
  expect(result.partial).toBe(false);
}, 30_000);
