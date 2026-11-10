import { describe, expect, it, vi } from 'vitest';
import { createRobotsCache } from '../../src/pipeline/robots.js';
import { readSitemap } from '../../src/pipeline/sitemap-reader.js';

describe('sitemap reader', () => {
  it('follows robots and one sitemap index level, keeping same-host readable targets', async () => {
    const files: Record<string, string> = {
      'https://firm.com/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://firm.com/sitemap_index.xml',
      'https://firm.com/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://firm.com/page-sitemap.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>',
      'https://firm.com/page-sitemap.xml': '<urlset><url><loc>https://firm.com/nosotros/</loc></url><url><loc>https://www.firm.com/politica.pdf</loc></url><url><loc>https://other.com/x</loc></url><url><loc>https://firm.com/img.png</loc></url></urlset>',
    };
    const fetchText = async (url: string) => files[url] ? { status: 200, text: files[url]! } : { status: 404, text: '' };
    const result = await readSitemap('firm.com', new AbortController().signal, { text: fetchText, robots: fetchText });
    expect(result.links).toEqual([{ url: 'https://firm.com/nosotros/', kind: 'page' }, { url: 'https://www.firm.com/politica.pdf', kind: 'document' }]);
  });

  const sitemap = '<urlset><url><loc>https://firm.com/about</loc></url><url><loc>https://firm.com/private/memo</loc></url></urlset>';

  it('drops the URLs robots.txt excludes and does not fetch a sitemap it excludes', async () => {
    const text = vi.fn(async (url: string) => url.endsWith('/sitemap.xml') ? { status: 200, text: sitemap } : { status: 404, text: '' });
    const robots = async () => ({ status: 200, text: 'User-agent: *\nDisallow: /private\nDisallow: /wp-sitemap.xml' });
    const result = await readSitemap('firm.com', new AbortController().signal, { text, robots });
    expect(result.links).toEqual([{ url: 'https://firm.com/about', kind: 'page' }]);
    expect(text.mock.calls.map(call => call[0])).toEqual(['https://firm.com/sitemap.xml', 'https://firm.com/sitemap_index.xml']);
  });

  it('reads the sitemap of a site whose robots.txt answers 403: no rules were published', async () => {
    const text = async (url: string) => url.endsWith('/sitemap.xml') ? { status: 200, text: sitemap } : { status: 404, text: '' };
    const result = await readSitemap('firm.com', new AbortController().signal, { text, robots: async () => ({ status: 403, text: 'Forbidden' }) });
    expect(result.links).toHaveLength(2);
  });

  it('fetches nothing when robots.txt is unreachable', async () => {
    const text = vi.fn(async () => ({ status: 200, text: sitemap }));
    const result = await readSitemap('firm.com', new AbortController().signal, { text, robots: async () => ({ status: 503, text: '' }) });
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
    const result = await readSitemap('firm.com', new AbortController().signal, { text, robots });
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
    await readSitemap('firm.com', new AbortController().signal, { text, robots }, cache);
    await readSitemap('firm.com', new AbortController().signal, { text, robots }, cache);
    expect(robots).toHaveBeenCalledTimes(1);
  });
});
