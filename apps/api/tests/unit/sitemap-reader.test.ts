import { describe, expect, it, vi } from 'vitest';
import { createRobotsCache } from '../../src/pipeline/robots.js';
import { readSitemap } from '../../src/pipeline/sitemap-reader.js';

type Reply = { status: number; text: string; location?: string };
// The reader asks for one response at a time and follows redirects itself; these fixtures speak in text.
const viaText = (text: (url: string) => Promise<Reply>) => async (url: string) => {
  const reply = await text(url);
  return { status: reply.status, headers: reply.location ? { location: reply.location } : {} as Record<string, string>, body: Buffer.from(reply.text) };
};

describe('sitemap reader', () => {
  it('follows robots and one sitemap index level, keeping same-host readable targets', async () => {
    const files: Record<string, string> = {
      'https://firm.com/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://firm.com/sitemap_index.xml',
      'https://firm.com/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://firm.com/page-sitemap.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>',
      'https://firm.com/page-sitemap.xml': '<urlset><url><loc>https://firm.com/nosotros/</loc></url><url><loc>https://www.firm.com/politica.pdf</loc></url><url><loc>https://other.com/x</loc></url><url><loc>https://firm.com/img.png</loc></url></urlset>',
    };
    const fetchText = async (url: string) => files[url] ? { status: 200, text: files[url]! } : { status: 404, text: '' };
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(fetchText), robots: fetchText });
    expect(result.links).toEqual([{ url: 'https://firm.com/nosotros/', kind: 'page' }, { url: 'https://www.firm.com/politica.pdf', kind: 'document' }]);
  });

  const sitemap = '<urlset><url><loc>https://firm.com/about</loc></url><url><loc>https://firm.com/private/memo</loc></url></urlset>';

  it('drops the URLs robots.txt excludes and does not fetch a sitemap it excludes', async () => {
    const text = vi.fn(async (url: string) => url.endsWith('/sitemap.xml') ? { status: 200, text: sitemap } : { status: 404, text: '' });
    const robots = async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private\nDisallow: /wp-sitemap.xml' });
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots });
    expect(result.links).toEqual([{ url: 'https://firm.com/about', kind: 'page' }]);
    expect(text.mock.calls.map(call => call[0])).toEqual(['https://firm.com/sitemap.xml', 'https://firm.com/sitemap_index.xml']);
  });

  it('reads the sitemap of a site whose robots.txt answers 403: no rules were published', async () => {
    const text = async (url: string) => url.endsWith('/sitemap.xml') ? { status: 200, text: sitemap } : { status: 404, text: '' };
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots: async () => ({ status: 403, text: 'Forbidden' }) });
    expect(result.links).toHaveLength(2);
  });

  it('fetches nothing when robots.txt is unreachable', async () => {
    const text = vi.fn(async () => ({ status: 200, text: sitemap }));
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots: async () => ({ status: 503, text: '' }) });
    expect(result).toEqual({ links: [], detail: 'ROBOTS_UNAVAILABLE' });
    expect(text).not.toHaveBeenCalled();
  });

  it('checks a sitemap on the www host against the rules of the www origin', async () => {
    const index = '<sitemapindex><sitemap><loc>https://www.firm.com/private-sitemap.xml</loc></sitemap>'
      + '<sitemap><loc>https://www.firm.com/page-sitemap.xml</loc></sitemap></sitemapindex>';
    const text = vi.fn(async (url: string) => {
      if (url === 'https://firm.com/sitemap_index.xml') return { status: 200, text: index };
      if (url === 'https://www.firm.com/page-sitemap.xml') return { status: 200, text: sitemap };
      return { status: 404, text: '' };
    });
    // The bare domain publishes no rules; the www host, where the sitemaps live, excludes one of them.
    const robots = vi.fn(async (url: string) => url === 'https://www.firm.com/robots.txt'
      ? { status: 200, text: 'User-agent: *\nDisallow: /private-sitemap.xml\nDisallow: /wp-sitemap.xml' } : { status: 404, text: '' });
    const declared = 'User-agent: *\nSitemap: https://www.firm.com/wp-sitemap.xml';
    robots.mockImplementationOnce(async () => ({ status: 200, text: declared }));
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots });
    expect(result.links).toHaveLength(2);
    expect(text.mock.calls.map(call => call[0])).not.toContain('https://www.firm.com/private-sitemap.xml');
    expect(text.mock.calls.map(call => call[0])).not.toContain('https://www.firm.com/wp-sitemap.xml');
    expect(text.mock.calls.map(call => call[0])).toContain('https://www.firm.com/page-sitemap.xml');
    // Each origin's rules once.
    expect(robots.mock.calls.map(call => call[0])).toEqual(['https://firm.com/robots.txt', 'https://www.firm.com/robots.txt']);
  });

  it('reuses the robots.txt the scan already fetched', async () => {
    const robots = vi.fn(async () => ({ status: 404, text: '' }));
    const text = async () => ({ status: 200, text: sitemap });
    const cache = createRobotsCache();
    await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots }, cache);
    await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots }, cache);
    expect(robots).toHaveBeenCalledTimes(1);
  });

  it('checks every redirect hop of a sitemap against robots.txt and the firm host before fetching it', async () => {
    const urlset = (path: string) => `<urlset><url><loc>https://firm.com${path}</loc></url></urlset>`;
    const replies: Record<string, Reply> = {
      // Into a path robots.txt excludes: never fetched, and its links are not used.
      'https://firm.com/sitemap.xml': { status: 301, text: '', location: '/private/sitemap.xml' },
      'https://firm.com/private/sitemap.xml': { status: 200, text: urlset('/team') },
      // Onto another host: never fetched.
      'https://firm.com/sitemap_index.xml': { status: 302, text: '', location: 'https://cdn.example/sitemap.xml' },
      'https://cdn.example/sitemap.xml': { status: 200, text: urlset('/elsewhere') },
      // To the www host, then to an allowed path there: followed.
      'https://firm.com/wp-sitemap.xml': { status: 301, text: '', location: 'https://www.firm.com/wp-sitemap.xml' },
      'https://www.firm.com/wp-sitemap.xml': { status: 301, text: '', location: '/sitemaps/pages.xml' },
      'https://www.firm.com/sitemaps/pages.xml': { status: 200, text: urlset('/about') },
    };
    const text = vi.fn(async (url: string) => replies[url] ?? { status: 404, text: '' });
    const robots = vi.fn(async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private/' }));
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots });
    expect(result.links).toEqual([{ url: 'https://firm.com/about', kind: 'page' }]);
    expect(text.mock.calls.map(call => call[0]).sort()).toEqual(['https://firm.com/sitemap.xml', 'https://firm.com/sitemap_index.xml',
      'https://firm.com/wp-sitemap.xml', 'https://www.firm.com/sitemaps/pages.xml', 'https://www.firm.com/wp-sitemap.xml']);
    // The other host's rules are not even asked for.
    expect(robots.mock.calls.map(call => call[0])).toEqual(['https://firm.com/robots.txt', 'https://www.firm.com/robots.txt']);
  });

  it('gives up on a sitemap that keeps redirecting', async () => {
    let hops = 0;
    const text = vi.fn(async (url: string) => url.includes('/loop/') || url.endsWith('/sitemap.xml')
      ? { status: 302, text: '', location: `/loop/${++hops}.xml` } : { status: 404, text: '' });
    const result = await readSitemap('firm.com', new AbortController().signal, { response: viaText(text), robots: async () => ({ status: 404, text: '' }) });
    expect(result).toEqual({ links: [], detail: 'NO_SITEMAP_URLS' });
    // The first request and five redirects for /sitemap.xml, then one request for each of the other two names.
    expect(text).toHaveBeenCalledTimes(6 + 2);
  });
});
