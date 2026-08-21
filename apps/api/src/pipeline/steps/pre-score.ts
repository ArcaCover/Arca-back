import type { Layer1Observations, PreScore, QuickReport, Signal } from '@arca/contracts';
import { tierForScore, type Confidence } from '@arca/scoring';

/** Cuántas señales chequeadas hacen falta para cada nivel de confianza. */
const HIGH_CONFIDENCE_SIGNALS = 5;
const MEDIUM_CONFIDENCE_SIGNALS = 3;

/** Una señal candidata: `checked` decide si entra al numerador y al denominador. */
type SignalCheck = Signal & { checked: boolean };

/** Qué pasos lograron correr; determina qué señales se consideran chequeadas. */
export type SignalAvailability = {
  website_checked: boolean;
  dns_checked: boolean;
  bar_checked: boolean;
};

/**
 * Traduce las observaciones a la tabla de puntos del handbook. Una señal que no se pudo
 * chequear queda fuera del máximo posible, así el score se normaliza sobre lo que sí sabemos.
 */
export function buildSignals(
  observations: Layer1Observations,
  availability: SignalAvailability,
): SignalCheck[] {
  const { website_checked, dns_checked, bar_checked } = availability;
  const enterpriseEmail =
    observations.email_provider === 'google' || observations.email_provider === 'microsoft';

  return [
    {
      id: 'ai_policy',
      category: 'governance',
      type: observations.ai_policy_found ? 'positive' : 'warning',
      title: observations.ai_policy_found ? 'AI Use Policy found' : 'No AI Use Policy found',
      detail: observations.ai_policy_found
        ? `Policy published at ${observations.ai_policy_url ?? 'the firm website'}`
        : 'No substantial AI policy section detected on the website',
      points: observations.ai_policy_found ? 8 : 0,
      max_points: 8,
      checked: website_checked,
    },
    {
      id: observations.ai_policy_found ? 'ai_in_services_governed' : 'ai_in_services_no_detail',
      category: 'governance',
      type: observations.ai_policy_found ? 'positive' : 'warning',
      title: observations.ai_policy_found
        ? 'Promotes AI in services and documents its controls'
        : 'Mentions AI in services without detailing controls',
      detail: observations.ai_policy_found
        ? 'Services pages reference AI and the firm publishes a governing policy'
        : 'Services pages reference AI with no reference to internal controls',
      points: observations.ai_policy_found ? 5 : -5,
      max_points: observations.ai_policy_found ? 5 : 0,
      // Ninguna de las dos filas aplica si la firma no menciona IA en sus servicios.
      checked: website_checked && observations.ai_in_services,
    },
    {
      id: 'blog_ai_content',
      category: 'content',
      type: observations.blog_ai_content ? 'positive' : 'neutral',
      title: observations.blog_ai_content
        ? 'Publishes content about AI and the law'
        : 'No AI-related editorial content found',
      detail: observations.blog_ai_content
        ? 'Blog or news section covers AI topics'
        : 'Blog or news section does not cover AI topics',
      points: observations.blog_ai_content ? 3 : 0,
      max_points: 3,
      checked: website_checked,
    },
    {
      id: 'legal_platform',
      category: 'tech',
      type: observations.legal_platform ? 'positive' : 'neutral',
      title: observations.legal_platform
        ? `Uses ${observations.legal_platform} (enterprise legal platform)`
        : 'No enterprise legal platform detected',
      detail: observations.legal_platform
        ? 'Detected via tech stack fingerprinting of the website'
        : 'No Clio, PracticePanther or MyCase fingerprints in the website',
      points: observations.legal_platform ? 5 : 0,
      max_points: 5,
      checked: website_checked,
    },
    {
      id: 'email_provider',
      category: 'tech',
      type: enterpriseEmail ? 'positive' : 'warning',
      title: enterpriseEmail
        ? `Enterprise email provider (${observations.email_provider})`
        : 'No enterprise email provider detected',
      detail: enterpriseEmail
        ? 'MX records point to a managed enterprise mail platform'
        : 'MX records do not point to Google Workspace or Microsoft 365',
      points: enterpriseEmail ? 3 : 0,
      max_points: 3,
      checked: dns_checked,
    },
    {
      id: 'dmarc',
      category: 'tech',
      type: observations.dmarc_configured ? 'positive' : 'warning',
      title: observations.dmarc_configured ? 'DMARC configured' : 'No DMARC configured',
      detail: observations.dmarc_configured
        ? 'A DMARC record is published in DNS'
        : 'No DMARC record detected in DNS',
      points: observations.dmarc_configured ? 2 : 0,
      max_points: 2,
      checked: dns_checked,
    },
    {
      id: 'bar_standing',
      category: 'regulatory',
      type: observations.bar_verified ? 'positive' : 'neutral',
      title: observations.bar_verified
        ? 'Attorneys verified in good standing'
        : 'Bar verification pending manual review',
      detail: observations.bar_verified
        ? 'All listed attorneys are active with no recent sanctions'
        : 'Automated bar association checks are not available in this phase',
      points: observations.bar_verified ? 8 : 0,
      max_points: 8,
      checked: bar_checked,
    },
    {
      id: 'job_posts_ai',
      category: 'content',
      type: observations.job_posts_ai ? 'positive' : 'neutral',
      title: observations.job_posts_ai
        ? 'Hiring for AI-related roles'
        : 'No AI-related job postings checked',
      detail: 'Job board scraping is not part of this phase',
      points: observations.job_posts_ai ? 3 : 0,
      max_points: 3,
      // No scrapeamos bolsas de trabajo todavía, así que la señal nunca se chequea.
      checked: false,
    },
  ];
}

export type PreScoreResult = {
  pre_score: PreScore;
  signals: Signal[];
};

export function calculatePreScore(
  observations: Layer1Observations,
  availability: SignalAvailability,
): PreScoreResult {
  const checked = buildSignals(observations, availability).filter((s) => s.checked);
  const points_earned = checked.reduce((sum, s) => sum + s.points, 0);
  const points_possible = checked.reduce((sum, s) => sum + s.max_points, 0);

  // Sin señales chequeadas el score es 0: no hay evidencia sobre la que normalizar.
  const raw = points_possible === 0 ? 0 : (points_earned / points_possible) * 100;
  const value = Math.round(Math.min(100, Math.max(0, raw)));

  const signals_detected = checked.length;
  const confidence: Confidence =
    signals_detected >= HIGH_CONFIDENCE_SIGNALS
      ? 'HIGH'
      : signals_detected >= MEDIUM_CONFIDENCE_SIGNALS
        ? 'MEDIUM'
        : 'LOW';

  return {
    pre_score: {
      value,
      tier: tierForScore(value),
      confidence,
      signals_detected,
      points_earned,
      points_possible,
    },
    // El frontend recibe las señales sin el flag interno de chequeo.
    signals: checked.map(({ checked: _checked, ...signal }) => signal),
  };
}

/** Quick report por template: determinista y sin costo, como recomienda el handbook para el MVP. */
export function buildQuickReport(
  signals: Signal[],
  observations: Layer1Observations,
): QuickReport {
  const top_strengths = signals.filter((s) => s.type === 'positive').map((s) => s.title);
  const top_risks = signals
    .filter((s) => s.type === 'warning' || s.type === 'negative')
    .map((s) => s.title);

  if (!observations.website_found) {
    return {
      summary:
        'We could not reach this firm website, so the pre-score is based on DNS signals alone. ' +
        'Complete the assessment to get an accurate score.',
      top_strengths,
      top_risks,
    };
  }

  const strengthText =
    top_strengths.length > 0
      ? `On the positive side: ${top_strengths.slice(0, 3).join('; ').toLowerCase()}.`
      : 'We found no positive AI governance signals on the website.';
  const riskText =
    top_risks.length > 0
      ? ` Areas of concern: ${top_risks.slice(0, 3).join('; ').toLowerCase()}.`
      : '';

  return {
    summary: `${strengthText}${riskText} For a complete score and a quote, complete the 5-minute assessment.`,
    top_strengths,
    top_risks,
  };
}
