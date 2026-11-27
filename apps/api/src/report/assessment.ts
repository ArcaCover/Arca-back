import type { AnswerValue, AssessmentResult, LegacyAssessmentResult, RenderedQuestion, UnderwritingResult } from '@arca/contracts';
import { underwriting, visibleQuestions, type AgentPlan, type QuestionBank } from '@arca/questions';
import { LAYER1_UNAVAILABLE, numberLabel } from '@arca/scoring';
import { isUnderwriting, type AssessmentPlan, type AssessmentRecord } from '../assessment/repository.js';
import { BASE_STYLE, COLORS, escape, isoDay, longDate } from './layout.js';

// The Assessment Report: what /assessment/results shows, plus the answers behind it. It is built from the stored
// record alone (the frozen bank, the questions exactly as they were rendered, the answers and the result), so it
// cannot say more than the firm was asked and answered. It never prints the decision, a price, the raw flags or
// the requester's email.

export type CompletedAssessment = AssessmentRecord & { status: 'COMPLETED'; result: AssessmentResult; plan: AssessmentPlan };
export const isCompleted = (record: AssessmentRecord): record is CompletedAssessment =>
  record.status === 'COMPLETED' && record.result !== null && record.plan !== null;

// The report's only demo disclosure. Nothing else on the page repeats it.
export const DEMO_DISCLOSURE = 'The questions and the scoring are provisional, so these results are illustrative. ' +
  'This is not an insurance offer, a price or an underwriting decision.';

// The line under the score when the website could not be read and the composite is the answers alone (LAYER1_UNAVAILABLE):
// the results screen's line in the third person (DN-12 §14). Low confidence, not high risk: no group, no manual review.
export const ANSWERS_ONLY_LINE = "Based only on the firm's answers; no public evidence could be verified (low confidence).";

// The completion day in Florida, the same day the report prints (layout.ts).
export function assessmentReportFilename(record: CompletedAssessment) {
  return `arca-assessment-${record.layer1_snapshot.domain}-${isoDay(record.result.completedAt)}.pdf`;
}

/** The combined score as the results screen's gauge shows it: a whole number from 0 to 100. */
export const displayedScore = (score: number) => Math.min(100, Math.max(0, Math.round(score)));

function answerText(question: RenderedQuestion, answer: AnswerValue | undefined) {
  if (!answer) return 'No answer';
  const label = (id: string) => question.options?.find(option => option.id === id)?.label ?? id;
  if (answer.kind === 'option') return label(answer.optionId);
  if (answer.kind === 'options') return answer.optionIds.map(label).join('; ');
  if (answer.kind === 'text') return answer.value;
  if (answer.kind === 'scale') {
    return question.scale ? `${answer.value} on a scale from ${question.scale.min} (${question.scale.minLabel}) ` +
      `to ${question.scale.max} (${question.scale.maxLabel})` : String(answer.value);
  }
  return question.number ? numberLabel(answer.value, question.number.unit) : String(answer.value);
}

export function renderAssessmentHtml(record: CompletedAssessment) {
  if (isUnderwriting(record) && 'outcome' in record.result) return renderUnderwritingHtml(record, record.result);
  const { layer1_snapshot: layer1 } = record;
  const result = record.result as LegacyAssessmentResult;
  const bank = record.bank_snapshot as QuestionBank;
  const plan = record.plan as AgentPlan;
  const firmName = layer1.identity?.firmName ?? null;
  const firm = firmName ?? layer1.domain;
  const completed = longDate(result.completedAt);
  const scored = result.compositeScore !== null;
  const answersOnly = result.flags.includes(LAYER1_UNAVAILABLE);
  // The questions the firm ended on, in the order the questionnaire showed them and in their stored wording.
  const asked = visibleQuestions(bank, plan, layer1, record.answers)
    .flatMap(question => record.rendered.filter(rendered => rendered.id === question.id));
  const part = (label: string, score: number | null) =>
    `<div class="part"><div class="meta">${escape(label)}</div><div class="part-score">${score === null ? 'Not scored' : `${score}<small> / 100</small>`}</div></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arca Assessment Report: ${escape(firm)}</title>
<style>${BASE_STYLE}
  .disclosure { margin: 10px 0 0; padding: 7px 12px; border: 1px solid ${COLORS.oro}; background: rgba(255,198,89,.12); border-radius: 10px; font-size: 9pt; }
  .parts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
  .part { padding: 8px 14px; border: 1px solid ${COLORS.bruma}; border-radius: 12px; }
  .part-score { font-size: 15pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .part-score small { display: inline; font-size: 9pt; font-weight: 400; color: rgba(28,44,91,.6); }
  h2 { break-after: avoid; }
  .lead { margin: 0 0 6px; color: rgba(28,44,91,.75); }
  .category, .step, .answer { break-inside: avoid; }
  .step { display: grid; grid-template-columns: 20px 1fr 110px; gap: 10px; align-items: start; padding: 6px 0; border-top: 1px solid ${COLORS.bruma}; }
  .step-number { font-weight: 700; color: ${COLORS.oroOscuro}; }
  .step-title, .question { font-weight: 700; }
  .gain { text-align: right; font-size: 8.5pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .answer { padding: 6px 0; border-top: 1px solid ${COLORS.bruma}; }
</style></head>
<body>
  <header><span class="brand">Arca</span><span class="kind">Assessment Report</span></header>
  <h1>${escape(firm)}</h1>
  <div class="meta">${firmName ? `${escape(layer1.domain)}<br>` : ''}Assessment completed ${escape(completed)}</div>
  <p class="disclosure"><strong>Demo assessment.</strong> ${escape(DEMO_DISCLOSURE)}</p>

  <section class="score">
    <div class="total">${result.compositeScore !== null ? displayedScore(result.compositeScore) : '—'}<small> / 100</small></div>
    <div><div class="tier">${scored ? escape(result.tier) : 'NOT SCORED'}</div>
      <div class="tier-line">${answersOnly ? escape(ANSWERS_ONLY_LINE) : scored ? "Combined from the public evidence and the firm's answers"
        : 'The quick scan did not support a combined score. The questionnaire score is shown below.'}</div></div>
  </section>
  <div class="parts">${part('Public evidence · Layer 1', result.layer1Score)}${part("The firm's answers · Layer 2", result.layer2Score)}</div>

  <h2>Governance profile by area</h2>
  ${result.domains.map(domain => `<div class="category"><div>${escape(domain.label)}<small>${domain.weight}% weight${
    domain.status === 'PARTIAL' ? ' · partial evidence' : ''}</small></div><div class="bar"><span style="width:${domain.score}%"></span></div><div class="points">${domain.score} / 100</div></div>`).join('')}

  <h2>Action plan</h2>
  ${result.actionPlan.length ? `<p class="lead">Suggested improvements based on the answers. Each point gain is an estimate on its own, not a promised outcome.</p>
  ${result.actionPlan.map((item, index) => `<div class="step"><div class="step-number">${index + 1}</div><div><div class="step-title">${escape(item.title)}</div>${
    escape(item.detail)}</div><div class="gain">Up to +${item.pointsGain} points</div></div>`).join('')}`
    : '<p class="none">No additional improvements were identified from the answers. This is not an assurance that all risks are addressed.</p>'}

  <h2>Answers as asked</h2>
  <p class="lead">Attested as true by the firm on ${escape(longDate(record.attested_at ?? result.completedAt))}.</p>
  ${asked.map(question => `<div class="answer"><div class="question">${escape(question.text)}</div>${
    escape(answerText(question, record.answers[question.id]))}<small>${escape(question.domainLabel)}${
    question.scored ? '' : ' · context only, not scored'}</small></div>`).join('')}

  <footer>Built from the Quick Scan of ${escape(layer1.domain)} and the answers above. Question bank ${escape(result.bankVersion)} ·
  Scoring model ${escape(result.scoringVersion)} · Assessment ${escape(result.assessmentId)} · Scan ${escape(result.scanId)}.</footer>
</body></html>`;
}

// Bank 4.0 (DN-14): the report says what /assessment/results says. A quote prints its indicative premium per limit and its
// conditions; a schedule or a decline prints no number at all (rules §13). The underwriter's audit and summary never print.
export const PROVISIONAL_DISCLOSURE = 'The questions, the weights and the rates are provisional until a carrier sets them. ' +
  'Any premium shown is an indicative estimate, not an offer of insurance.';
const usd = (value: number) => '$' + value.toLocaleString('en-US');
const limitLabel = (limit: number) => limit >= 1_000_000 ? `$${limit / 1_000_000}M` : `$${limit / 1000}K`;

function renderUnderwritingHtml(record: CompletedAssessment, result: UnderwritingResult) {
  const layer1 = record.layer1_snapshot;
  const firmName = layer1.identity?.firmName ?? null;
  const firm = firmName ?? layer1.domain;
  const config = (record.bank_snapshot as { config: underwriting.UnderwritingConfig }).config;
  const facts = underwriting.layer1Facts(layer1, config);
  const asked = underwriting.reconcile(config, facts, record.answers).selection.asked
    .flatMap(id => record.rendered.filter(rendered => rendered.id === id));
  const outcome = result.outcome;
  let outcomeHtml: string;
  if (outcome.type === 'quote') {
    const { quote } = outcome;
    const rows = quote.limits.map(l => `<div class="category"><div>${escape(limitLabel(l.limit))} per claim${
      l.limit === quote.defaultLimit ? '<small>shown by default</small>' : ''}</div><div></div><div class="points">${escape(usd(l.annualPremium))}</div></div>`).join('');
    const conditions = quote.conditions.length ? `<h2>Conditions to keep within 90 days</h2>${quote.conditions.map((c, i) =>
      `<div class="step"><div class="step-number">${i + 1}</div><div><div class="step-title">${escape(c.what)}</div>${escape(c.why)}</div><div class="gain">${c.dueDays} days</div></div>`).join('')}` : '';
    outcomeHtml = `<h2>Indicative quote</h2><p class="lead">Annual premium by limit of liability. ${escape(PROVISIONAL_DISCLOSURE)}</p>${rows}${conditions}`;
  } else if (outcome.type === 'schedule') {
    outcomeHtml = `<h2>Next step</h2><p>${escape(outcome.schedule.message)}</p><p class="lead">Book a time: ${escape(outcome.schedule.bookingUrl)}</p>`;
  } else {
    outcomeHtml = `<h2>Next step</h2><p>${escape(outcome.declined.message)}</p><p class="lead">Talk to us: ${escape(outcome.declined.bookingUrl)}</p>`;
  }
  const answersOnly = result.flags.includes(LAYER1_UNAVAILABLE);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Arca Assessment Report: ${escape(firm)}</title>
<style>${BASE_STYLE}
  .disclosure { margin: 10px 0 0; padding: 7px 12px; border: 1px solid ${COLORS.oro}; background: rgba(255,198,89,.12); border-radius: 10px; font-size: 9pt; }
  h2 { break-after: avoid; }
  .lead { margin: 0 0 6px; color: rgba(28,44,91,.75); }
  .category, .step, .answer { break-inside: avoid; }
  .step { display: grid; grid-template-columns: 20px 1fr 110px; gap: 10px; align-items: start; padding: 6px 0; border-top: 1px solid ${COLORS.bruma}; }
  .step-number { font-weight: 700; color: ${COLORS.oroOscuro}; }
  .step-title, .question { font-weight: 700; }
  .gain { text-align: right; font-size: 8.5pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .answer { padding: 6px 0; border-top: 1px solid ${COLORS.bruma}; }
</style></head>
<body>
  <header><span class="brand">Arca</span><span class="kind">Assessment Report</span></header>
  <h1>${escape(firm)}</h1>
  <div class="meta">${firmName ? `${escape(layer1.domain)}<br>` : ''}Assessment completed ${escape(longDate(result.completedAt))}</div>
  <p class="disclosure">${escape(PROVISIONAL_DISCLOSURE)}</p>

  <section class="score">
    <div class="total">${displayedScore(result.compositeScore)}<small> / 100</small></div>
    <div><div class="tier">${escape(result.tier)}</div>
      <div class="tier-line">Confidence: ${escape(result.confidence.level.toLowerCase())}. ${answersOnly ? escape(ANSWERS_ONLY_LINE)
        : "Public evidence and the firm's answers, category by category."}</div></div>
  </section>

  <h2>Score by category</h2>
  ${result.categories.map(c => `<div class="category"><div>${escape(c.label)}</div><div class="bar"><span style="width:${Math.round(c.score / c.max * 100)}%"></span></div><div class="points">${Math.round(c.score)} / ${c.max}</div></div>`).join('')}

  ${outcomeHtml}

  <h2>Action plan</h2>
  ${result.actionPlan.length ? `<p class="lead">Improvements drawn from the answers. Each point gain is an estimate on its own, not a promised outcome.</p>
  ${result.actionPlan.map((item, index) => `<div class="step"><div class="step-number">${index + 1}</div><div><div class="step-title">${escape(item.title)}</div>${
    escape(item.detail)}</div><div class="gain">Up to +${Math.round(item.pointsGain)} points</div></div>`).join('')}`
    : '<p class="none">No additional improvements were identified from the answers. This is not an assurance that all risks are addressed.</p>'}

  <h2>Answers as asked</h2>
  <p class="lead">Attested as true by the firm on ${escape(longDate(record.attested_at ?? result.completedAt))}.</p>
  ${asked.map(question => `<div class="answer"><div class="question">${escape(question.text)}</div>${
    escape(answerText(question, record.answers[question.id]))}<small>${escape(question.domainLabel)}${
    question.scored ? '' : ' · context only, not scored'}</small></div>`).join('')}

  <footer>Built from the Quick Scan of ${escape(layer1.domain)} and the answers above. Question bank ${escape(result.bankVersion)} ·
  Configuration ${escape(result.configVersion)} · Assessment ${escape(result.assessmentId)} · Scan ${escape(result.scanId)}.</footer>
</body></html>`;
}
