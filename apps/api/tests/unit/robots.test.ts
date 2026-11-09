import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { collectBody, fetchPublicText, USER_AGENT as SENT_USER_AGENT, type PublicResponse } from '../../src/pipeline/network.js';
import { ROBOTS_MAX_BYTES, USER_AGENT, createRobotsCache, robotsPolicy, robotsStateForStatus,
  type RobotsFetch, type RobotsOptions } from '../../src/pipeline/robots.js';

const signal = () => new AbortController().signal;
const serving = (status: number, text = '') => vi.fn<RobotsFetch>(async () => ({ status, text }));
const rules = (text: string) => robotsPolicy('https://firm.com', signal(), { fetchText: serving(200, text) });
// How every reader asks: the policy of the URL's own origin, then the URL.
const robotsAllows = async (url: string, options: RobotsOptions) => (await robotsPolicy(new URL(url).origin, signal(), options)).allows(url);

describe('robots.txt fetch outcomes (RFC 9309)', () => {
  it('parses a 2xx answer and obeys it', async () => {
    const policy = await robotsPolicy('https://firm.com', signal(), { fetchText: serving(200, 'User-agent: *\nDisallow: /private') });
    expect(policy).toMatchObject({ url: 'https://firm.com/robots.txt', state: 'rules', status: 200, detail: null });
    expect(policy.allows('https://firm.com/private/a')).toBe(false);
    expect(policy.allows('https://firm.com/about')).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 451])('reads a %i as a site without rules: crawling is allowed', async status => {
    // The body of an error page is never parsed as rules, whatever it says.
    const policy = await robotsPolicy('https://firm.com', signal(), { fetchText: serving(status, 'User-agent: *\nDisallow: /') });
    expect(policy).toMatchObject({ state: 'none', status, detail: null });
    expect(policy.allows('https://firm.com/')).toBe(true);
  });

  it.each([429, 500, 503])('reads a %i as unreachable rules: nothing is allowed', async status => {
    const policy = await robotsPolicy('https://firm.com', signal(), { fetchText: serving(status, 'User-agent: *\nAllow: /') });
    expect(policy).toMatchObject({ state: 'unreachable', status, detail: `HTTP ${status}` });
    expect(policy.allows('https://firm.com/')).toBe(false);
  });

  it('sorts every status into one of the three states', () => {
    expect([200, 204, 299].map(robotsStateForStatus)).toEqual(['rules', 'rules', 'rules']);
    expect([400, 401, 403, 404, 410, 451, 499].map(robotsStateForStatus)).toEqual(Array(7).fill('none'));
    expect([100, 301, 304, 429, 500, 502, 503, 599].map(robotsStateForStatus)).toEqual(Array(8).fill('unreachable'));
  });

  it('follows a 301 chain and keeps the rules bound to the origin that was asked', async () => {
    const hops: string[] = [];
    const fetchResponse = async (url: string): Promise<PublicResponse> => {
      hops.push(url);
      if (url === 'https://firm.com/robots.txt') return { status: 301, headers: { location: 'https://www.firm.com/robots.txt' }, body: Buffer.alloc(0) };
      if (url === 'https://www.firm.com/robots.txt') return { status: 301, headers: { location: '/rules.txt' }, body: Buffer.alloc(0) };
      return { status: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow: /private') };
    };
    const policy = await robotsPolicy('https://firm.com', signal(),
      { fetchText: (url, abort) => fetchPublicText(url, abort, { fetchResponse }) });
    expect(hops).toEqual(['https://firm.com/robots.txt', 'https://www.firm.com/robots.txt', 'https://www.firm.com/rules.txt']);
    expect(policy).toMatchObject({ url: 'https://firm.com/robots.txt', state: 'rules', status: 200 });
    expect(policy.allows('https://firm.com/private')).toBe(false);
  });

  it('treats a redirect loop and a redirect that leads nowhere as unreachable', async () => {
    const loop = async (): Promise<PublicResponse> => ({ status: 301, headers: { location: '/robots.txt' }, body: Buffer.alloc(0) });
    const looping = await robotsPolicy('https://firm.com', signal(),
      { fetchText: (url, abort) => fetchPublicText(url, abort, { fetchResponse: loop }) });
    expect(looping).toMatchObject({ state: 'unreachable', status: null, detail: 'Too many redirects' });
    expect(looping.allows('https://firm.com/')).toBe(false);
    const nowhere = await robotsPolicy('https://firm.com', signal(), { fetchText: serving(301) });
    expect(nowhere).toMatchObject({ state: 'unreachable', status: 301 });
  });

  it('treats a network error as unreachable', async () => {
    const policy = await robotsPolicy('https://firm.com', signal(), { fetchText: async () => { throw new Error('ECONNRESET'); } });
    expect(policy).toMatchObject({ state: 'unreachable', status: null, detail: 'ECONNRESET' });
    expect(policy.allows('https://firm.com/')).toBe(false);
  });

  it('gives up on a robots.txt that hangs after its own timeout, even if the transport ignores the signal', async () => {
    const aborted: boolean[] = [];
    const started = Date.now();
    const policy = await robotsPolicy('https://firm.com', signal(), { timeoutMs: 30,
      fetchText: (_url, abort) => { abort.addEventListener('abort', () => aborted.push(true)); return new Promise(() => {}); } });
    expect(policy).toMatchObject({ state: 'unreachable', status: null, detail: 'robots.txt timed out' });
    expect(policy.allows('https://firm.com/')).toBe(false);
    expect(aborted).toEqual([true]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('lets the caller\'s own abort surface as an abort, not as a verdict about the site', async () => {
    const controller = new AbortController();
    const cache = createRobotsCache();
    const pending = robotsPolicy('https://firm.com', controller.signal, { cache, fetchText: () => new Promise(() => {}) });
    controller.abort(new Error('Crawl deadline'));
    await expect(pending).rejects.toThrow('Crawl deadline');
    // The origin is asked again by the next reader of the scan.
    const fetchText = serving(404);
    expect((await robotsPolicy('https://firm.com', signal(), { cache, fetchText })).state).toBe('none');
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('cuts an oversized body at the cap instead of failing, and drops the rule the cut broke', async () => {
    const head = 'User-agent: *\nDisallow: /private\n';
    // Whole comment lines up to 12 bytes before the cap, so the next rule starts on its own line and straddles the cap.
    const room = ROBOTS_MAX_BYTES - 12 - head.length;
    const filler = `#${'x'.repeat(room % 10 + 8)}\n`;
    const before = `${head}${filler}${'# padding\n'.repeat((room - filler.length) / 10)}`;
    expect(Buffer.byteLength(before)).toBe(ROBOTS_MAX_BYTES - 12);
    // Only "Disallow: /t" of the next rule fits, and that would also block /terms.
    const text = `${before}Disallow: /team-directory\nDisallow: /beyond-the-cap\n`;
    const policy = await rules(text);
    expect(policy.state).toBe('rules');
    expect(policy.allows('https://firm.com/private')).toBe(false);
    expect(policy.allows('https://firm.com/terms')).toBe(true);
    expect(policy.allows('https://firm.com/team-directory')).toBe(true);
    expect(policy.allows('https://firm.com/beyond-the-cap')).toBe(true);
  });

  it('cuts an oversized body at the last line end of any kind', async () => {
    // Old Mac line ends: with no LF to cut at, the rules before the cap must still be obeyed, not thrown away.
    const policy = await rules(`User-agent: *\rDisallow: /private\r${'#'.repeat(ROBOTS_MAX_BYTES)}`);
    expect(policy.allows('https://firm.com/private')).toBe(false);
    expect(policy.allows('https://firm.com/about')).toBe(true);
  });
});

describe('response body limits', () => {
  it('keeps what fits and stops reading when asked to truncate', async () => {
    const stream = Readable.from([Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ijkl')]);
    expect((await collectBody(stream, { maxBytes: 6, truncate: true })).toString()).toBe('abcdef');
    expect(stream.destroyed).toBe(true);
  });

  it('fails past the limit otherwise, and returns a body within it untouched', async () => {
    await expect(collectBody(Readable.from([Buffer.from('abcd'), Buffer.from('efgh')]), { maxBytes: 6 })).rejects.toThrow('Response too large');
    expect((await collectBody(Readable.from([Buffer.from('abcd'), Buffer.from('ef')]), { maxBytes: 6 })).toString()).toBe('abcdef');
  });

  it('asks the transport for a truncated body only when the caller wants one', async () => {
    const limits: unknown[] = [];
    const fetchResponse = async (_url: string, _signal: AbortSignal, _method?: string, _body?: Buffer | null, limit?: unknown): Promise<PublicResponse> => {
      limits.push(limit);
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    };
    await fetchPublicText('https://firm.com/robots.txt', signal(), { fetchResponse, maxBytes: 10, truncate: true });
    await fetchPublicText('https://firm.com/sitemap.xml', signal(), { fetchResponse });
    expect(limits).toEqual([{ maxBytes: 10, truncate: true }, undefined]);
    const large = async (): Promise<PublicResponse> => ({ status: 200, headers: {}, body: Buffer.alloc(11) });
    await expect(fetchPublicText('https://firm.com/sitemap.xml', signal(), { fetchResponse: large, maxBytes: 10 })).rejects.toThrow('Response too large');
  });
});

describe('robots.txt matching', () => {
  it('matches the rules against the user agent this service sends', () => {
    expect(USER_AGENT).toBe(SENT_USER_AGENT);
    expect(USER_AGENT).toMatch(/^ArcaBot\//);
  });

  it('names the crawler in exactly one place', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
    const src = join(import.meta.dirname, '../../src');
    const naming = files(src).filter(file => /ArcaBot/.test(readFileSync(file, 'utf8'))).map(file => file.slice(src.length + 1).replace(/\\/g, '/'));
    expect(naming).toEqual(['pipeline/network.ts']);
  });

  it('obeys its own group instead of the wildcard group, in both directions', async () => {
    const stricter = await rules('User-agent: *\nAllow: /\n\nUser-agent: ArcaBot\nDisallow: /');
    expect(stricter.allows('https://firm.com/about')).toBe(false);
    const looser = await rules('User-agent: *\nDisallow: /\n\nUser-agent: ArcaBot\nAllow: /');
    expect(looser.allows('https://firm.com/about')).toBe(true);
  });

  it('matches its product token whatever the case or version written in the file', async () => {
    for (const name of ['arcabot', 'ARCABOT', 'ArcaBot/1.0', 'ArcaBot/2.3']) {
      const policy = await rules(`User-agent: ${name}\nDisallow: /private\n\nUser-agent: *\nDisallow: /`);
      expect([name, policy.allows('https://firm.com/about'), policy.allows('https://firm.com/private')]).toEqual([name, true, false]);
    }
  });

  it('ignores a group written for another crawler', async () => {
    const policy = await rules('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/');
    expect(policy.allows('https://firm.com/about')).toBe(true);
    expect(policy.allows('https://firm.com/wp-admin/x')).toBe(false);
  });

  it('lets the longest matching rule win, and Allow win a tie', async () => {
    const policy = await rules('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /team\nAllow: /team\nAllow: /docs\nDisallow: /docs/internal');
    expect(policy.allows('https://firm.com/wp-admin/')).toBe(false);
    expect(policy.allows('https://firm.com/wp-admin/admin-ajax.php')).toBe(true);
    expect(policy.allows('https://firm.com/team')).toBe(true);
    expect(policy.allows('https://firm.com/docs/guide')).toBe(true);
    expect(policy.allows('https://firm.com/docs/internal/memo')).toBe(false);
  });

  it('understands the * and $ wildcards, a BOM and CRLF line ends', async () => {
    const policy = await rules('﻿User-agent: *\r\nDisallow: /*.pdf$\r\nDisallow: /search*results\r\n');
    expect(policy.allows('https://firm.com/files/policy.pdf')).toBe(false);
    expect(policy.allows('https://firm.com/files/policy.pdf.html')).toBe(true);
    expect(policy.allows('https://firm.com/search/all/results')).toBe(false);
    expect(policy.allows('https://firm.com/search')).toBe(true);
  });

  it('reads Crawl-delay for its own group, else the wildcard group, else nothing', async () => {
    expect((await rules('User-agent: *\nCrawl-delay: 10')).crawlDelayMs).toBe(10_000);
    expect((await rules('User-agent: *\nCrawl-delay: 10\n\nUser-agent: ArcaBot\nCrawl-delay: 0.5\nDisallow:')).crawlDelayMs).toBe(500);
    expect((await rules('User-agent: *\nDisallow: /private')).crawlDelayMs).toBeNull();
    expect((await rules('User-agent: *\nCrawl-delay: soon')).crawlDelayMs).toBeNull();
    expect((await robotsPolicy('https://firm.com', signal(), { fetchText: serving(404, 'Crawl-delay: 10') })).crawlDelayMs).toBeNull();
  });

  it('lists the sitemaps the file declares', async () => {
    expect((await rules('Sitemap: https://firm.com/sitemap_index.xml\nUser-agent: *\nAllow: /')).sitemaps()).toEqual(['https://firm.com/sitemap_index.xml']);
  });
});

describe('per-scan robots cache', () => {
  it('downloads robots.txt once per origin however many URLs are checked', async () => {
    const fetchText = serving(200, 'User-agent: *\nDisallow: /private');
    const cache = createRobotsCache();
    const answers = await Promise.all(['https://firm.com/', 'https://firm.com/about', 'https://firm.com/private/x']
      .map(url => robotsAllows(url, { fetchText, cache })));
    answers.push(await robotsAllows('https://firm.com/team', { fetchText, cache }));
    expect(answers).toEqual([true, true, false, true]);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('keeps one answer per origin: www and the bare domain each have their own robots.txt', async () => {
    const fetchText = vi.fn<RobotsFetch>(async url => ({ status: 200, text: url.includes('www.') ? 'User-agent: *\nDisallow: /' : '' }));
    const cache = createRobotsCache();
    expect(await robotsAllows('https://firm.com/about', { fetchText, cache })).toBe(true);
    expect(await robotsAllows('https://www.firm.com/about', { fetchText, cache })).toBe(false);
    expect(await robotsAllows('https://www.firm.com/team', { fetchText, cache })).toBe(false);
    expect(fetchText.mock.calls.map(call => call[0])).toEqual(['https://firm.com/robots.txt', 'https://www.firm.com/robots.txt']);
  });

  it('keeps an unreachable answer for the scan instead of asking a failing server again', async () => {
    const fetchText = serving(503);
    const cache = createRobotsCache();
    expect(await robotsAllows('https://firm.com/', { fetchText, cache })).toBe(false);
    expect(await robotsAllows('https://firm.com/about', { fetchText, cache })).toBe(false);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it('fetches again without a cache', async () => {
    const fetchText = serving(404);
    await robotsAllows('https://firm.com/', { fetchText });
    await robotsAllows('https://firm.com/about', { fetchText });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});
