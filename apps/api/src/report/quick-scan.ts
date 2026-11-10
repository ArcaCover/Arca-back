import { adaptScore, type Layer1Result } from '@arca/contracts';
import { WEBSITE_UNAVAILABLE } from '@arca/scoring';
import { BASE_STYLE, COLORS, escape, longDate } from './layout.js';

// The Quick Scan Report: the /score screen on one A4 page. Every sentence comes from adaptScore
// and signalsToCards, the same code the screen renders, so the PDF can never say more than the
// scan observed. The page is self-contained: no external font, image or script is fetched.

const TIER_LINES: Record<string, string> = {
  FORTRESS: 'Strong public governance signals',
  FORTIFIED: 'Solid public signals with room to improve',
  GUARDED: 'Mixed public signals',
  EXPOSED: 'Weak public signals',
  CRITICAL: 'Very few positive public signals',
  UNKNOWN: 'Not enough public evidence to place the firm in a tier',
};

// Shown when the result carries the WEBSITE_UNAVAILABLE flag (DN-12).
export const WEBSITE_UNREAD_NOTE = "The firm's website could not be read, so everything that could not be verified counts as unknown " +
  'and the firm sits in the highest-risk group until the assessment is completed.';

const SOURCE_NAMES: Record<string, string> = { website: 'Firm website', bar: 'Florida Bar', avvo: 'Avvo' };

function sourceLine(name: string, source: Layer1Result['sources'][keyof Layer1Result['sources']]) {
  const searched = source.attorneysSearched ?? null;
  const found = source.attorneysFound ?? null;
  const coverage = searched && found !== null ? `, ${found} of ${searched} attorneys matched` : '';
  const state = source.status === 'ok' ? 'complete' : source.status === 'partial' ? 'partial' : 'unavailable';
  return `${SOURCE_NAMES[name] ?? name}: ${state}${coverage}`;
}

export function reportFilename(result: Layer1Result) {
  return `arca-quick-scan-${result.domain}-${result.meta.completedAt.slice(0, 10)}.pdf`;
}

export function renderQuickScanHtml(result: Layer1Result, status: 'COMPLETED' | 'PARTIAL') {
  const view = adaptScore(result, status);
  const date = longDate(result.meta.completedAt);
  const place = [view.firm.city, view.firm.state].filter(Boolean).join(', ');
  const facts = [place, view.firm.practice, view.firm.attorneys ? `${view.firm.attorneys} attorneys` : null].filter(Boolean) as string[];
  const helping = view.signals.filter(signal => signal.positive);
  const holding = view.signals.filter(signal => !signal.positive);
  const list = (items: typeof helping, mark: string) => items.length
    ? `<ul>${items.map(item => `<li><span class="dot" style="background:${mark}"></span><span>${escape(item.label)} <em>${escape(item.source)}</em></span></li>`).join('')}</ul>`
    : '<p class="none">Nothing observed.</p>';
  // The cause replaces the generic notice about incomplete sources. It says what was observed and what that does to
  // the score, never a decision or a price.
  const websiteUnread = result.preScore.flags.includes(WEBSITE_UNAVAILABLE);
  const notes = [
    websiteUnread ? WEBSITE_UNREAD_NOTE
      : view.incomplete ? 'Some sources did not answer in full, so this score rests on partial evidence.' : null,
    view.decisionWithheld ? 'There is not enough public evidence yet for an underwriting decision.' : null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arca Quick Scan Report: ${escape(view.firm.name ?? result.domain)}</title>
<style>${BASE_STYLE}</style></head>
<body>
  <header><span class="brand">Arca</span><span class="kind">Quick Scan Report</span></header>
  <h1>${escape(view.firm.name ?? result.domain)}</h1>
  <div class="meta">${escape([result.domain, ...facts].join(' · '))}<br>Scanned ${escape(date)}</div>

  <section class="score">
    <div class="total">${view.score === null ? '—' : view.score}<small> / 100</small></div>
    <div><div class="tier">${escape(view.tier)}</div><div class="tier-line">${escape(TIER_LINES[view.tier] ?? '')}</div>
      <div class="meta">Confidence: ${escape(view.confidence.toLowerCase())}</div></div>
  </section>
  ${notes.length ? `<ul class="notes">${notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : ''}

  <h2>AI Governance Score by category</h2>
  ${view.categories.map(category => {
    const share = category.score === null ? 0 : Math.max(0, Math.min(100, (category.score / category.max) * 100));
    const partial = category.status === 'KNOWN' ? '' : `<div class="partial">${category.status === 'PARTIAL' ? 'partial evidence' : 'not enough evidence'}</div>`;
    return `<div class="category"><div>${escape(category.label)}${partial}</div><div class="bar"><span style="width:${share}%"></span></div><div class="points">${category.score ?? '—'} / ${category.max}</div></div>`;
  }).join('')}

  <div class="columns">
    <section><h2>What supports the score</h2>${list(helping, COLORS.cielo)}</section>
    <section><h2>What holds it back</h2>${list(holding, COLORS.oroOscuro)}</section>
  </div>

  <h2>Sources</h2>
  <ul class="sources">${(['website', 'bar', 'avvo'] as const).map(name => `<li>${escape(sourceLine(name, result.sources[name]))}</li>`).join('')}</ul>

  <footer>This pre-score is based only on public information observed on ${escape(date)}: the firm's website, the Florida Bar
  directory and Avvo. It is not an offer of insurance, a quote or an underwriting decision. A full assessment adds what public
  sources cannot show, such as how the firm reviews AI-assisted work. Scan ${escape(result.scanId)}.</footer>
</body></html>`;
}
