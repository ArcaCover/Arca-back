import { adaptScore, type Layer1Result } from '@arca/contracts';
import { WEBSITE_UNAVAILABLE } from '@arca/scoring';
import { BASE_STYLE, COLORS, escape, isoDay, longDate } from './layout.js';

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

// Shown when the result carries the WEBSITE_UNAVAILABLE flag, in the words of the /score notice, in the third person
// (DN-12 §3.3). The risk group follows the score, the Layer 2 composite included, so the group is named only when the
// tier printed above is CRITICAL (in practice always, for this flag) and is never promised to change or to hold. Only
// the manual review holds, whatever the answers are.
export function websiteUnreadNote(tier: Layer1Result['preScore']['tier']) {
  return ["We could not read the firm's website during the scan.",
    tier === 'CRITICAL' ? 'What we could not verify counts as unknown, which places the firm in the highest-risk group for now.'
      : 'What we could not verify counts as unknown.',
    'Answers to the assessment also count, and because the website could not be read, the case will need a manual review.'].join(' ');
}

const SOURCE_NAMES: Record<string, string> = { website: 'Firm website', bar: 'Florida Bar', avvo: 'Avvo' };

function sourceLine(name: string, source: Layer1Result['sources'][keyof Layer1Result['sources']]) {
  const searched = source.attorneysSearched ?? null;
  const found = source.attorneysFound ?? null;
  const coverage = searched && found !== null ? `, ${found} of ${searched} attorneys matched` : '';
  // A directory that was skipped was never asked, so it was not unavailable. It is said the way /score says it ("We
  // could not look your firm up on Avvo."), whatever the reason: INSUFFICIENT_IDENTITY also covers a firm that was
  // identified but has no attorney names and no verified city, so "the firm could not be identified" would be false.
  const state = source.status === 'ok' ? 'complete' : source.status === 'partial' ? 'partial'
    : source.status === 'skipped' ? 'not searched; we could not look the firm up there' : 'unavailable';
  return `${SOURCE_NAMES[name] ?? name}: ${state}${coverage}`;
}

// The scan day in Florida, where the firms are (layout.ts): the same day the report prints.
export function reportFilename(result: Layer1Result) {
  return `arca-quick-scan-${result.domain}-${isoDay(result.meta.completedAt)}.pdf`;
}

export function renderQuickScanHtml(result: Layer1Result, status: 'COMPLETED' | 'PARTIAL') {
  const view = adaptScore(result, status);
  const date = longDate(result.meta.completedAt);
  const place = [view.firm.city, view.firm.state].filter(Boolean).join(', ');
  const facts = [place, view.firm.practice, view.firm.attorneys ? `${view.firm.attorneys} attorneys` : null].filter(Boolean) as string[];
  // When the firm name fell back to the domain, the title already is the domain: the line under it does not repeat it.
  const details = [...(view.firm.name === result.domain ? [] : [result.domain]), ...facts];
  const helping = view.signals.filter(signal => signal.positive);
  const holding = view.signals.filter(signal => !signal.positive);
  const list = (items: typeof helping, mark: string) => items.length
    ? `<ul>${items.map(item => `<li><span class="dot" style="background:${mark}"></span><span>${escape(item.label)} <em>${escape(item.source)}</em></span></li>`).join('')}</ul>`
    : '<p class="none">Nothing observed.</p>';
  // The cause replaces the generic notice about incomplete sources. It says what was observed and what that does to
  // the score, never a decision or a price.
  const websiteUnread = result.preScore.flags.includes(WEBSITE_UNAVAILABLE);
  const notes = [
    websiteUnread ? websiteUnreadNote(result.preScore.tier)
      : view.incomplete ? 'Some sources did not answer in full, so this score rests on partial evidence.' : null,
    view.decisionWithheld ? 'There is not enough public evidence yet for an underwriting decision.' : null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arca Quick Scan Report: ${escape(view.firm.name ?? result.domain)}</title>
<style>${BASE_STYLE}</style></head>
<body>
  <header><span class="brand">Arca</span><span class="kind">Quick Scan Report</span></header>
  <h1>${escape(view.firm.name ?? result.domain)}</h1>
  <div class="meta">${details.length ? `${escape(details.join(' · '))}<br>` : ''}Scanned ${escape(date)}</div>

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
