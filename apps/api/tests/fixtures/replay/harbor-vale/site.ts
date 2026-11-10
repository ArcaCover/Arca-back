import type { CrawledPage } from '../../../../src/pipeline/crawler.js';

// A hand-written firm that does not exist, on a reserved domain. `text` is what the crawler would take from the
// rendered page (navigation and footer removed); `html` carries the title, the metadata and the links.
export const DOMAIN = 'harborvale.example';
const url = (path: string) => `https://${DOMAIN}${path}`;
const NAV = '<nav><a href="/attorneys">Our attorneys</a><a href="/about">About the firm</a><a href="/contact">Contact</a>'
  + '<a href="/ai-use-policy">AI use policy</a><a href="/privacy-policy">Privacy policy</a></nav>';
const html = (title: string, head: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${NAV}<main>${body}</main></body></html>`;
const paragraphs = (lines: string[]) => lines.map(line => `<p>${line}</p>`).join('');

const HOME = ['Harbor Vale Law',
  'Harbor Vale Law is a law firm in Miami, Florida. Founded in 2009, we handle immigration and family law matters.',
  'Call us at (305) 555-0142.'];
const ATTORNEYS = ['Our attorneys',
  'Maria Vale, Managing Partner. Maria Vale is an immigration attorney admitted to the Florida Bar.',
  'Daniel Harbor, Associate Attorney. Daniel Harbor is a family law attorney admitted to the Florida Bar.'];
const AI_POLICY = ['AI use policy',
  'Harbor Vale Law has a written policy for artificial intelligence. Our attorneys use CoCounsel for legal research. '
  + 'Every AI output is reviewed by a licensed attorney before it reaches a client.',
  'We tell clients when AI tools assist with their matter.'];
const PRIVACY = ['Privacy policy', 'Harbor Vale Law protects client data. We never sell personal information.'];
const ABOUT = ['About the firm', 'Harbor Vale Law was founded in 2009 by Maria Vale. The firm has one office in Miami.'];
const CONTACT = ['Contact', 'Harbor Vale Law, 200 Bay Street, Miami, FL 33131.', 'Phone: (305) 555-0142.'];

const page = (path: string, title: string, lines: string[], head = '', extra = ''): CrawledPage =>
  ({ url: url(path), html: html(title, head, paragraphs(lines) + extra), text: lines.join('\n') });

/** What the crawl read. */
export const PAGES: CrawledPage[] = [
  page('/', 'Harbor Vale Law | Immigration and Family Law in Miami',
    HOME, '<meta name="description" content="Harbor Vale Law is a Miami law firm for immigration and family law.">'
    + '<script type="application/ld+json">{"@type":"LegalService","name":"Harbor Vale Law","telephone":"(305) 555-0142",'
    + '"address":{"streetAddress":"200 Bay Street","addressLocality":"Miami","addressRegion":"FL"}}</script>'),
  page('/ai-use-policy', 'AI use policy | Harbor Vale Law', AI_POLICY),
  page('/attorneys', 'Our attorneys | Harbor Vale Law', ATTORNEYS,
    '', '<ul><li><a href="/attorneys/maria-vale">Maria Vale</a></li><li><a href="/attorneys/daniel-harbor">Daniel Harbor</a></li></ul>'),
  page('/privacy-policy', 'Privacy policy | Harbor Vale Law', PRIVACY),
];

/** What the crawl did not reach and the extraction asks for: the page plan always reads the about and contact pages. */
export const ACCESS_PAGES: CrawledPage[] = [
  page('/about', 'About the firm | Harbor Vale Law', ABOUT),
  page('/contact', 'Contact | Harbor Vale Law', CONTACT),
];

/**
 * The same site on another visit: a new nonce, a new timestamp, another analytics script, a session attribute.
 * Nothing a visitor or the model reads has changed.
 */
export function withHtmlNoise(pages: CrawledPage[], visit: string): CrawledPage[] {
  return pages.map(item => ({ ...item, html: item.html
    .replace('<head>', `<head><script nonce="${visit}">window.__renderedAt="2026-11-${visit.slice(0, 2)}T08:00:00Z"</script>`)
    .replace('<body>', `<body data-session="${visit}"><!-- cache ${visit} --><script src="https://analytics.example/a.js?v=${visit}"></script>`) }));
}

/** The firm now says it also takes personal injury matters: one sentence of one page reads differently. */
export function withChangedText(pages: CrawledPage[]): CrawledPage[] {
  const from = 'we handle immigration and family law matters', to = 'we handle immigration, family law and personal injury matters';
  return pages.map(item => ({ ...item, html: item.html.replace(from, to), text: item.text.replace(from, to) }));
}
