import { chromium } from 'playwright';

/** Renders one report. It gives up, and closes what it opened, once `signal` aborts. */
export type PdfRender = (html: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
/** What the report routes call: rejects when the render fails or runs out of time, and both answer 503. */
export type ReportRenderer = (html: string) => Promise<Uint8Array<ArrayBuffer>>;

/** Renders at once, for both report routes together: each one is a whole headless Chromium. */
export const MAX_CONCURRENT_RENDERS = 2;
/**
 * How long one request may take, waiting for a slot included. Under the front's 15 s request timeout, so the visitor
 * gets the route's 503 ("try again") rather than a dropped connection. A render takes under a second.
 */
export const RENDER_TIMEOUT_MS = 12_000;

export class ReportRenderTimeout extends Error {
  constructor() { super('Report rendering timed out'); }
}

// Renders a self-contained HTML page to a PDF with the Chromium the crawler already ships.
// JavaScript is off and every request is refused: the page needs nothing outside itself, and
// a report must never fetch anything, whatever text a scanned website put into it.
export const renderPdfOnce: PdfRender = async (html, signal) => {
  signal.throwIfAborted();
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  // Closing the browser ends whatever step is running (setContent, or page.pdf, which has no timeout of its own).
  const close = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 });
    return new Uint8Array(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    signal.removeEventListener('abort', close);
    await browser.close().catch(() => {});
  }
};

/**
 * At most `maxConcurrent` renders at once in this process; a request over the cap waits for a slot, in arrival order.
 * Each request has `timeoutMs` in all, waiting included: past it the request is rejected with `ReportRenderTimeout`
 * (the routes answer 503), a request still waiting leaves the queue, and a render still running is aborted and its
 * slot handed on.
 */
export function limitRenders(render: PdfRender, options: { maxConcurrent?: number; timeoutMs?: number } = {}): ReportRenderer {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_RENDERS, timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else running--;
  };
  return html => new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, holding = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Settle this request first: handing the slot on starts the next render, which must not be able to keep it open.
      outcome();
      if (holding) release();
    };
    const start = () => {
      holding = true;
      // A renderer that throws before returning a promise fails like one that rejects, and frees its slot the same way.
      Promise.resolve().then(() => render(html, controller.signal))
        .then(pdf => finish(() => resolve(pdf)), (error: unknown) => finish(() => reject(error)));
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      controller.abort();
      finish(() => reject(new ReportRenderTimeout()));
    }, timeoutMs);
    if (running < maxConcurrent) { running++; start(); } else waiting.push(start);
  });
}

/** The renderer both report routes share (compose passes this one function to both). */
export const renderPdf: ReportRenderer = limitRenders(renderPdfOnce);
