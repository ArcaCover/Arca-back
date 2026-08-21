import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpPageFetcher, type FetchedPage, type PageFetcher } from '../../src/pipeline/page-fetcher.js';

/** Envuelve el contenido en una página completa, con el widget de Clio que dispara el fingerprint. */
function page(title: string, body: string, withClio = false): string {
  const clio = withClio
    ? '<script src="https://grow.clio.com/scheduler/embed.js" async></script>'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${clio}</head><body>${body}</body></html>`;
}

const NAV = `
  <nav>
    <a href="/about">About</a>
    <a href="/attorneys">Attorneys</a>
    <a href="/practice-areas">Practice Areas</a>
    <a href="/services">Services</a>
    <a href="/ai-governance">AI Governance</a>
    <a href="/blog">Blog</a>
  </nav>`;

/** Policy de IA con más de 200 palabras: por debajo de ese umbral el pipeline la descarta. */
const AI_POLICY_BODY = `
  <h1>Artificial Intelligence Policy</h1>
  <p>This AI use policy governs how attorneys and staff at Smith and Associates apply generative
  artificial intelligence to client work. Our responsible AI program rests on four commitments:
  human accountability, confidentiality, verification, and disclosure. Every output produced with
  the assistance of an AI system remains the professional work product of the supervising attorney,
  who is solely responsible for its accuracy and for compliance with the rules of professional
  conduct in every jurisdiction where the firm practices.</p>
  <p>Approved tools are limited to the enterprise instances licensed by the firm. Attorneys may not
  use consumer accounts, free public chat interfaces, or browser extensions for any matter that
  involves client information. Requests to add a tool go through the technology committee, which
  reviews the vendor security posture, the data retention terms, and the jurisdiction where
  processing takes place before granting approval to anyone at the firm.</p>
  <p>Confidential client information may never be entered into a system that has not been approved
  and covered by a signed data processing agreement. Where a matter requires analysis of privileged
  material, attorneys must use the redaction workflow documented in the firm handbook. Our data loss
  prevention controls monitor outbound traffic and block uploads that match privileged patterns.</p>
  <p>Every citation, quotation, and statutory reference generated with AI assistance must be verified
  against a primary source before it appears in a filing, a client memorandum, or correspondence.
  Verification is documented in the matter file. A second attorney reviews any brief prepared with
  substantial AI assistance before it is filed with a court.</p>
  <p>Suspected incidents must be reported to the general counsel within twenty-four hours. The firm
  maintains an incident response plan that is rehearsed annually, and every attorney completes
  mandatory recurring training on the responsible use of artificial intelligence in legal practice.</p>`;

/** Páginas del sitio de prueba: una firma de criminal defense en Miami con policy y Clio. */
export const SITE_PAGES: Record<string, string> = {
  '/': page(
    'Smith & Associates | Miami Criminal Defense Attorneys',
    `${NAV}
     <h1>Smith &amp; Associates</h1>
     <p>Criminal defense attorneys serving Miami, FL and the surrounding counties since 1998.</p>`,
    true,
  ),
  '/about': page(
    'About | Smith & Associates',
    `${NAV}<h1>About the firm</h1>
     <p>Smith &amp; Associates is a criminal defense firm based in Miami, FL. Our team of 10 attorneys
     has tried felony and misdemeanor cases across South Florida for more than two decades.</p>`,
  ),
  '/attorneys': page(
    'Our Attorneys | Smith & Associates',
    `${NAV}<h1>Our Attorneys</h1>
     <ul>
       <li>John Smith — Managing Partner</li>
       <li>Ana Rivera — Partner</li>
       <li>Marcus Bell — Associate</li>
       <li>Dana Cole — Of Counsel</li>
     </ul>
     <p>Our team of 10 attorneys practices in Miami, FL.</p>`,
  ),
  '/practice-areas': page(
    'Practice Areas | Smith & Associates',
    `${NAV}<h1>Practice Areas</h1>
     <p>Criminal defense, felony and misdemeanor trial work, DUI defense, white collar investigations,
     and commercial litigation support for business clients.</p>`,
  ),
  '/services': page(
    'Services | Smith & Associates',
    `${NAV}<h1>Services</h1>
     <p>We combine trial experience with AI-powered legal research to prepare cases faster, using
     artificial intelligence for document review under attorney supervision.</p>`,
  ),
  '/ai-governance': page('AI Governance | Smith & Associates', `${NAV}${AI_POLICY_BODY}`),
  '/blog': page(
    'Insights | Smith & Associates',
    `${NAV}<h1>Insights</h1>
     <article><h2>What artificial intelligence means for criminal defense</h2>
     <p>Courts are beginning to sanction filings that rely on machine learning tools without
     verification. Here is how our firm approaches AI-assisted research.</p></article>`,
  ),
};

export type TestSite = { port: number; close: () => Promise<void> };

/** Levanta el sitio fixture en un puerto libre. Las rutas no definidas responden 404. */
export async function startTestSite(pages = SITE_PAGES): Promise<TestSite> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').replace(/\?.*$/, '').replace(/\/+$/, '') || '/';
    const html = pages[path];
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Fetcher que reescribe cualquier host al sitio local. Permite ejercitar el pipeline real
 * (incluido el descubrimiento de subpáginas) sin salir a internet ni levantar un browser.
 */
export class LocalSiteFetcher implements PageFetcher {
  private readonly inner = new HttpPageFetcher();

  constructor(private readonly port: number) {}

  async fetch(url: string, timeoutMs: number): Promise<FetchedPage> {
    const target = new URL(url);
    const local = `http://127.0.0.1:${this.port}${target.pathname}${target.search}`;
    const page = await this.inner.fetch(local, timeoutMs);
    // Devuelve la URL original para que el análisis por rutas siga viendo el dominio real.
    return { ...page, url: `${target.origin}${new URL(page.url).pathname}` };
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/** Sitio que no responde: simula un dominio caído sin depender de la red. */
export class UnreachableFetcher implements PageFetcher {
  async fetch(): Promise<FetchedPage> {
    throw new Error('ENOTFOUND');
  }

  async close(): Promise<void> {}
}
