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

  it('reuses the robots.txt the scan already fetched', async () => {
    const robots = vi.fn(async () => ({ status: 404, text: '' }));
    const text = async () => ({ status: 200, text: sitemap });
    const cache = createRobotsCache();
    await readSitemap('firm.com', new AbortController().signal, { text, robots }, cache);
    await readSitemap('firm.com', new AbortController().signal, { text, robots }, cache);
    expect(robots).toHaveBeenCalledTimes(1);
  });
});
