/** Una página ya descargada y reducida a texto plano. */
export type FetchedPage = {
  url: string;
  status: number;
  html: string;
  text: string;
  headers: Record<string, string>;
};

/**
 * Puerto de descarga. Playwright es la implementación real; el fetcher HTTP existe para que
 * los tests corran contra un fixture local sin arrancar un browser.
 */
export interface PageFetcher {
  fetch(url: string, timeoutMs: number): Promise<FetchedPage>;
  close(): Promise<void>;
}

/** User-Agent de browser normal: el handbook prohíbe bypasses agresivos. */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Decodifica las entidades HTML más comunes. Sin esto, un "&amp;" llega tal cual a la DB. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; va última para no re-decodificar lo que produjeron las anteriores.
    .replace(/&amp;/g, '&');
}

/** Extrae texto legible de un HTML sin depender de un DOM completo. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** Fetcher HTTP puro: sin browser, sin JS. Suficiente para sitios estáticos y para tests. */
export class HttpPageFetcher implements PageFetcher {
  async fetch(url: string, timeoutMs: number): Promise<FetchedPage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });
      const html = await response.text();
      return {
        url: response.url || url,
        status: response.status,
        html,
        text: htmlToText(html),
        headers: Object.fromEntries(response.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Sin recursos que liberar: fetch nativo no mantiene estado propio.
  }
}

/**
 * Fetcher con browser real. Carga Playwright de forma perezosa para que el resto de la app
 * (y los tests) no paguen el costo de importarlo ni requieran browsers instalados.
 */
export class PlaywrightPageFetcher implements PageFetcher {
  private browser: import('playwright').Browser | null = null;

  private async ensureBrowser(): Promise<import('playwright').Browser> {
    if (this.browser) return this.browser;
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true });
    return this.browser;
  }

  async fetch(url: string, timeoutMs: number): Promise<FetchedPage> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      const html = await page.content();
      return {
        url: page.url(),
        status: response?.status() ?? 0,
        html,
        text: htmlToText(html),
        headers: response ? await response.allHeaders() : {},
      };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}
