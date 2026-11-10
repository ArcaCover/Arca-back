// What the two reports share, so the assessment report looks like the Quick Scan Report: the escaping, the palette,
// the date format and the A4 page both are laid out on.

export const escape = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Brand palette (Arca-front CLAUDE.md §5). Red stays reserved for alerts, so findings that hold
// the score back are marked in dark gold, as /assessment/results does.
export const COLORS = { marino: '#1C2C5B', cielo: '#6CABDD', oro: '#FFC659', oroOscuro: '#D4A12A', bruma: '#E4F4F7' };

export const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export const BASE_STYLE = `
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
`;
