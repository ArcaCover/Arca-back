import { adaptScore, type Layer1Result } from '@arca/contracts';

// The Quick Scan Report: the /score screen on one A4 page. Every sentence comes from adaptScore
// and signalsToCards, the same code the screen renders, so the PDF can never say more than the
// scan observed. The page is self-contained: no external font, image or script is fetched.

const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Brand palette (Arca-front CLAUDE.md §5). Red stays reserved for alerts, so findings that hold
// the score back are marked in dark gold, as /assessment/results does.
const COLORS = { marino: '#1C2C5B', cielo: '#6CABDD', oro: '#FFC659', oroOscuro: '#D4A12A', bruma: '#E4F4F7' };

const TIER_LINES: Record<string, string> = {
  FORTRESS: 'Strong public governance signals',
  FORTIFIED: 'Solid public signals with room to improve',
  GUARDED: 'Mixed public signals',
  EXPOSED: 'Weak public signals',
  CRITICAL: 'Very few positive public signals',
  UNKNOWN: 'Not enough public evidence to place the firm in a tier',
};

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
  const date = new Date(result.meta.completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const place = [view.firm.city, view.firm.state].filter(Boolean).join(', ');
  const facts = [place, view.firm.practice, view.firm.attorneys ? `${view.firm.attorneys} attorneys` : null].filter(Boolean) as string[];
  const helping = view.signals.filter(signal => signal.positive);
  const holding = view.signals.filter(signal => !signal.positive);
  const list = (items: typeof helping, mark: string) => items.length
    ? `<ul>${items.map(item => `<li><span class="dot" style="background:${mark}"></span><span>${escape(item.label)} <em>${escape(item.source)}</em></span></li>`).join('')}</ul>`
    : '<p class="none">Nothing observed.</p>';
  const notes = [
    view.incomplete ? 'Some sources did not answer in full, so this score rests on partial evidence.' : null,
    view.decisionWithheld ? 'There is not enough public evidence yet for an underwriting decision.' : null,
  ].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arca Quick Scan Report: ${escape(view.firm.name ?? result.domain)}</title>
<style>
  @page { size: A4; margin: 12mm 14mm 11mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: ${COLORS.marino}; font-size: 9.5pt; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid ${COLORS.oro}; padding-bottom: 8px; }
  .brand { font-size: 20pt; font-weight: 700; letter-spacing: -0.02em; }
  .kind { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.12em; color: ${COLORS.oroOscuro}; font-weight: 700; }
  h1 { font-size: 16pt; margin: 12px 0 2px; letter-spacing: -0.01em; }
  .meta { color: rgba(28,44,91,.65); font-size: 9.5pt; }
  .score { display: flex; gap: 22px; align-items: center; margin: 12px 0 4px; padding: 12px 18px; background: ${COLORS.bruma}; border-radius: 14px; }
  .total { font-size: 34pt; font-weight: 700; line-height: 1; }
  .total small { font-size: 12pt; font-weight: 400; color: rgba(28,44,91,.6); }
  .tier { font-size: 12pt; font-weight: 700; letter-spacing: 0.06em; }
  .tier-line { color: rgba(28,44,91,.75); }
  .notes { margin: 10px 0 0; padding: 0; list-style: none; }
  .notes li { font-size: 9pt; padding: 5px 10px; border-left: 3px solid ${COLORS.oroOscuro}; background: rgba(212,161,42,.08); margin-top: 5px; }
  h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.1em; margin: 14px 0 6px; color: rgba(28,44,91,.8); }
  .category { display: grid; grid-template-columns: 190px 1fr 58px; gap: 12px; align-items: center; margin: 5px 0; }
  .bar { height: 8px; background: ${COLORS.bruma}; border-radius: 99px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: ${COLORS.cielo}; }
  .points { text-align: right; font-variant-numeric: tabular-nums; }
  .partial { font-size: 8.5pt; color: rgba(28,44,91,.55); }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 8px; margin: 3px 0; break-inside: avoid; }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; }
  small { display: block; font-size: 8pt; color: rgba(28,44,91,.55); }
  em { font-style: normal; font-size: 8pt; color: rgba(28,44,91,.5); white-space: nowrap; }
  .none { color: rgba(28,44,91,.55); }
  .sources li { display: block; margin: 3px 0; }
  footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid ${COLORS.bruma}; font-size: 8.5pt; color: rgba(28,44,91,.6); }
</style></head>
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
