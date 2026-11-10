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
// The browser follows a redirect with its own network, so a loopback server stands for the www host behind one.
async function loopback(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { port, hostResolverRules: `MAP www.fixture.example 127.0.0.1:${port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

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
  // redirect with its own network stack, so the file arrives as a download. No request leaves the machine.
  const files: Record<string, Record<string, string>> = {
    '/card': { 'content-type': 'text/vcard', 'content-disposition': 'attachment; filename="jane.vcf"' },
    '/brochure': { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    '/report': { 'content-type': 'application/pdf' },
    '/feed': { 'content-type': 'application/rss+xml' },
  };
  const served: string[] = [];
  const www = await loopback((request, response) => {
    served.push(request.url ?? '');
    response.writeHead(200, files[request.url ?? '']).end(request.url === '/feed' ? '<rss></rss>' : 'PK');
  });
  const requested: string[] = [];
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => {
        requested.push(path(raw));
        if (path(raw) === '/') return html(`Smith Law<a href="/about">About</a>${Object.keys(files).map(file => `<a href="${file}">File</a>`).join('')}`);
        if (path(raw) === '/about') return html('About the firm');
        return { status: 301, headers: { location: `http://www.fixture.example${path(raw)}` }, body: Buffer.alloc(0) };
      },
    }, { hostResolverRules: www.hostResolverRules });
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
    await www.close();
  }
}, 30_000);

it('drops the download of a file it will not read', async () => {
  // The server never finishes the file, so only the browser giving the download up closes the connection.
  let drop!: () => void;
  const dropped = new Promise<true>(resolve => { drop = () => resolve(true); });
  const www = await loopback((_request, response) => {
    response.on('close', drop);
    response.writeHead(200, { 'content-type': 'application/zip' }).write('PK');
  });
  let droppedBeforeNextPage = false;
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => {
        if (path(raw) === '/') return html('Smith Law<a href="/archive">Archive</a><a href="/later">Later</a>');
        if (path(raw) === '/archive') return { status: 301, headers: { location: 'http://www.fixture.example/archive' }, body: Buffer.alloc(0) };
        // One page at a time, so this page is asked for after the file. The wait ends as soon as the connection
        // closes; the timer only bounds a crawler that kept the download running.
        droppedBeforeNextPage = await Promise.race([dropped, sleep(5000, false, { ref: false })]);
        return html('Later');
      },
    }, { concurrency: 1, hostResolverRules: www.hostResolverRules });
    expect(result.pages.map(page => path(page.url))).toEqual(['/', '/later']);
    expect(listed(result)).toEqual(['page NOT_HTML null fixture.example/archive']);
    expect(result.partial).toBe(false);
    expect(droppedBeforeNextPage).toBe(true);
  } finally {
    await www.close();
  }
}, 30_000);

it('does not follow a link that redirects off the site, and does not count it as a failure', async () => {
  // Law firm sites send /pay, /book or /reviews to LawPay, Calendly or Google. That is the site's answer about the link.
  const robots: string[] = [], requested: string[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async url => { robots.push(url); return { status: 404, text: '' }; },
    response: async raw => {
      requested.push(raw);
      if (path(raw) === '/') return html('Smith Law<a href="/book">Book</a><a href="/about">About</a>');
      if (path(raw) === '/book') return { status: 302, headers: { location: 'https://calendly.example/smith' }, body: Buffer.alloc(0) };
      return html('About the firm');
    },
  });
  expect(result.pages.map(page => path(page.url))).toEqual(['/', '/about']);
  expect(result.partial).toBe(false);
  expect(listed(result)).toEqual(['page OFF_SITE_REDIRECT 302 fixture.example/book']);
  expect(result.issues?.find(issue => issue.code === 'OFF_SITE_REDIRECT')?.detail).toBe('calendly.example');
  expect(crawlNotes(result)).toBe('1 link redirecting to another site');
  // Asked once, and the other host is never asked for anything, its robots.txt included.
  expect(requested.filter(url => path(url) === '/book')).toHaveLength(1);
  expect(requested.some(url => url.includes('calendly'))).toBe(false);
  expect(robots).toEqual(['https://fixture.example/robots.txt']);
}, 30_000);

it('keeps a redirect to an address outside the site away from the browser and out of the firm\'s pages', async () => {
  const hits: string[] = [];
  const internal = await loopback((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<body>INTERNAL ONLY CONTENT</body>');
  });
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => path(raw) === '/' ? html('Smith Law<a href="/go">Go</a>')
        : { status: 302, headers: { location: `http://127.0.0.1:${internal.port}/latest/meta-data` }, body: Buffer.alloc(0) },
    });
    expect(result.pages.map(page => path(page.url))).toEqual(['/']);
    expect(result.pages.some(page => page.text.includes('INTERNAL'))).toBe(false);
    expect(listed(result)).toEqual(['page OFF_SITE_REDIRECT 302 fixture.example/go']);
    expect(result.partial).toBe(false);
    expect(hits).toEqual([]);
  } finally {
    await internal.close();
  }
}, 30_000);

it('does not keep a page whose redirect chain ended off the site after a hop the handler never saw', async () => {
  // The www host is on the site, so its redirect is handed to the browser; its own redirect onwards is followed by
  // the browser alone. What it lands on is not the firm's page.
  const www = await loopback((request, response) => {
    if (request.url === '/elsewhere') response.writeHead(302, { location: `http://127.0.0.1:${(request.socket.localPort)}/foreign` }).end();
    else response.writeHead(200, { 'content-type': 'text/html' }).end('<body>FOREIGN CONTENT</body>');
  });
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async raw => path(raw) === '/' ? html('Smith Law<a href="/elsewhere">Elsewhere</a>')
        : { status: 301, headers: { location: 'http://www.fixture.example/elsewhere' }, body: Buffer.alloc(0) },
    }, { hostResolverRules: www.hostResolverRules });
    expect(result.pages.map(page => path(page.url))).toEqual(['/']);
    expect(result.pages.some(page => page.text.includes('FOREIGN'))).toBe(false);
    expect(listed(result)).toEqual(['page OFF_SITE_REDIRECT 200 fixture.example/elsewhere']);
    expect(result.issues?.find(issue => issue.code === 'OFF_SITE_REDIRECT')?.detail).toBe('127.0.0.1');
    expect(result.partial).toBe(false);
  } finally {
    await www.close();
  }
}, 30_000);

it('does not keep a page whose redirect chain ends on a path robots.txt excludes, after hops the handler never saw', async () => {
  // The usual WordPress chain: a slashless link goes to www, and www adds the trailing slash. Only the last URL is
  // excluded, and the browser follows that hop with its own network, out of the request handler's sight.
  const served: string[] = [];
  const www = await loopback((request, response) => {
    served.push(request.url ?? '');
    if (request.url === '/private') response.writeHead(301, { location: '/private/' }).end();
    else response.writeHead(200, { 'content-type': 'text/html' }).end('<body>SECRET PRIVATE PAGE</body>');
  });
  try {
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private/' }),
      response: async raw => path(raw) === '/' ? html('Smith Law<a href="/private">Private</a>')
        : { status: 301, headers: { location: `http://www.fixture.example${path(raw)}` }, body: Buffer.alloc(0) },
    }, { hostResolverRules: www.hostResolverRules });
    expect(result.pages.map(page => path(page.url))).toEqual(['/']);
    expect(result.pages.some(page => page.text.includes('SECRET'))).toBe(false);
    // The site's answer about the link, as for a link robots.txt excludes outright: not a failure, not partial.
    expect(listed(result)).toEqual(['page ROBOTS_DISALLOWED null fixture.example/private']);
    expect(result.partial).toBe(false);
    // The known limit (DN-07 §6): the browser still fetched the excluded URL once. Only its content is dropped.
    expect(served).toEqual(['/private', '/private/']);
  } finally {
    await www.close();
  }
}, 30_000);

it('takes a challenge page for a refusal whatever status carries it, and asks for it once', async () => {
  const challenge = 'Just a moment...<p>Checking your browser before accessing fixture.example.</p>';
  const cases: Array<[number, Record<string, string>, string]> = [
    [503, {}, challenge], [429, {}, challenge], [403, {}, challenge],
    // Cloudflare marks its own challenge with a header, whatever the page says.
    [503, { 'cf-mitigated': 'challenge' }, '<div id="challenge-form"></div>'],
  ];
  for (const [status, headers, body] of cases) {
    let asked = 0;
    const result = await crawlWebsite('fixture.example', new AbortController().signal, {
      robots: async () => ({ status: 404, text: '' }),
      response: async () => { asked++; return { status, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(`<body>${body}</body>`) }; },
    });
    expect(result.pages).toEqual([]);
    expect([status, asked]).toEqual([status, 1]);
    expect(result.issues?.find(issue => issue.scope === 'page')).toMatchObject({ code: 'ACCESS_BLOCKED', status, detail: 'challenge page' });
    expect(unreadableWebsite(result)).toMatchObject({ classification: 'DEFINITIVE', status: 'error', code: 'ACCESS_BLOCKED' });
  }
  // A 503 without a challenge stays a passing failure of the site, retried and transient.
  let asked = 0;
  const busy = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 404, text: '' }),
    response: async () => { asked++; return html('Service temporarily unavailable', 503); },
  });
  expect(asked).toBe(MAX_PAGE_ATTEMPTS);
  expect(listed(busy)).toEqual(['page HTTP_ERROR 503 fixture.example/', 'request HTTP_ERROR 503 fixture.example/']);
  expect(unreadableWebsite(busy)).toMatchObject({ classification: 'TRANSIENT', code: 'PROVIDER_ERROR' });
}, 90_000);

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

it('spaces the pages of a site that declares a long Crawl-delay and still reads the whole page budget', async () => {
  // A 10 s Crawl-delay on a site whose pages take 4.5 s to answer. Read one at a time, as before, 7 pages need more
  // than the 30 s deadline, so the crawl came back partial on every scan. Spaced, they take about half of it.
  const links = Array.from({ length: 10 }, (_, index) => `<a href="/p${index}">Page</a>`).join('');
  const starts: number[] = [];
  const result = await crawlWebsite('fixture.example', new AbortController().signal, {
    robots: async () => ({ status: 200, text: 'User-agent: *\nCrawl-delay: 10' }),
    response: async raw => {
      starts.push(Date.now());
      await sleep(4_500);
      return path(raw) === '/' ? html(`Home${links}`) : html(`Page ${path(raw)}`);
    },
  }, { maxPages: 7 });
  expect(result.pages).toHaveLength(7);
  expect(result.aborted).toBe(false);
  expect(result.partial).toBe(false);
  // The pause is capped at 30 s / 4 / 7 pages = 1071 ms, so the 6 pages after the home page span 5 pauses at least.
  // A slow machine only spreads them further; a second of slack absorbs how long each request takes to leave.
  expect(starts).toHaveLength(7);
  expect(starts.at(-1)! - starts[1]!).toBeGreaterThanOrEqual(5 * 1_071 - 1_000);
}, 60_000);
