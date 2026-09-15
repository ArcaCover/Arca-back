import { describe, expect, it } from 'vitest';
import { readSitemap } from '../../src/pipeline/sitemap-reader.js';

describe('sitemap reader', () => {
  it('follows robots and one sitemap index level, keeping same-host readable targets', async () => {
    const files: Record<string, string> = {
      'https://firm.com/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://firm.com/sitemap_index.xml',
      'https://firm.com/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://firm.com/page-sitemap.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>',
      'https://firm.com/page-sitemap.xml': '<urlset><url><loc>https://firm.com/nosotros/</loc></url><url><loc>https://www.firm.com/politica.pdf</loc></url><url><loc>https://other.com/x</loc></url><url><loc>https://firm.com/img.png</loc></url></urlset>',
    };
    const fetchText = async (url: string) => files[url] ? { status: 200, text: files[url]! } : { status: 404, text: '' };
    const result = await readSitemap('firm.com', new AbortController().signal, fetchText);
    expect(result.links).toEqual([{ url: 'https://firm.com/nosotros/', kind: 'page' }, { url: 'https://www.firm.com/politica.pdf', kind: 'document' }]);
  });
});
