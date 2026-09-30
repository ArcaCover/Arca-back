import { chromium } from 'playwright';

// Renders a self-contained HTML page to a PDF with the Chromium the crawler already ships.
// JavaScript is off and every request is refused: the page needs nothing outside itself, and
// a report must never fetch anything, whatever text a scanned website put into it.
export async function renderPdf(html: string): Promise<Uint8Array<ArrayBuffer>> {
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });
    return new Uint8Array(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close();
  }
}
