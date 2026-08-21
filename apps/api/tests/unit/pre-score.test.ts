import type { Layer1Observations } from '@arca/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildQuickReport,
  calculatePreScore,
  type SignalAvailability,
} from '../../src/pipeline/steps/pre-score.js';

const baseObservations: Layer1Observations = {
  website_found: true,
  pages_scraped: ['https://firm.com'],
  ai_policy_found: false,
  ai_policy_url: null,
  ai_in_services: false,
  blog_ai_content: false,
  job_posts_ai: false,
  legal_platform: null,
  email_provider: null,
  dmarc_configured: false,
  bar_verified: false,
  bar_check: 'manual_pending',
  cloud_tools_detected: false,
};

const observations = (overrides: Partial<Layer1Observations>): Layer1Observations => ({
  ...baseObservations,
  ...overrides,
});

const availability = (overrides: Partial<SignalAvailability> = {}): SignalAvailability => ({
  website_checked: true,
  dns_checked: true,
  bar_checked: false,
  ...overrides,
});

describe('tabla de puntos del pre-score', () => {
  it('todas las señales positivas dan 100', () => {
    const { pre_score } = calculatePreScore(
      observations({
        ai_policy_found: true,
        ai_policy_url: 'https://firm.com/ai',
        ai_in_services: true,
        blog_ai_content: true,
        legal_platform: 'clio',
        email_provider: 'google',
        dmarc_configured: true,
      }),
      availability(),
    );
    // 8 + 5 + 3 + 5 + 3 + 2 = 26 sobre 26 posibles.
    expect(pre_score.points_earned).toBe(26);
    expect(pre_score.points_possible).toBe(26);
    expect(pre_score.value).toBe(100);
    expect(pre_score.tier).toBe('FORTRESS');
  });

  it('promocionar IA sin policy resta 5 puntos y no suma al máximo', () => {
    const withPenalty = calculatePreScore(
      observations({ ai_in_services: true, email_provider: 'google', dmarc_configured: true }),
      availability(),
    );
    const withoutMention = calculatePreScore(
      observations({ email_provider: 'google', dmarc_configured: true }),
      availability(),
    );

    // La fila negativa aporta -5 al numerador y 0 al máximo.
    expect(withPenalty.pre_score.points_earned).toBe(withoutMention.pre_score.points_earned - 5);
    expect(withPenalty.pre_score.points_possible).toBe(withoutMention.pre_score.points_possible);
    expect(withPenalty.pre_score.value).toBeLessThan(withoutMention.pre_score.value);
  });

  it('nunca devuelve un score negativo', () => {
    const { pre_score } = calculatePreScore(
      observations({ ai_in_services: true }),
      availability({ dns_checked: false }),
    );
    expect(pre_score.value).toBe(0);
  });

  it('no suma los puntos de bar al máximo si no se chequeó', () => {
    const withoutBar = calculatePreScore(
      observations({ ai_policy_found: true, email_provider: 'google', dmarc_configured: true }),
      availability({ bar_checked: false }),
    );
    const withBar = calculatePreScore(
      observations({
        ai_policy_found: true,
        email_provider: 'google',
        dmarc_configured: true,
        bar_verified: true,
      }),
      availability({ bar_checked: true }),
    );

    expect(withoutBar.pre_score.points_possible).toBe(withBar.pre_score.points_possible - 8);
    expect(withoutBar.signals.some((s) => s.id === 'bar_standing')).toBe(false);
  });

  it('las señales no chequeadas no aparecen en la respuesta', () => {
    const { signals } = calculatePreScore(baseObservations, availability({ dns_checked: false }));
    const ids = signals.map((s) => s.id);
    expect(ids).not.toContain('dmarc');
    expect(ids).not.toContain('email_provider');
    expect(ids).not.toContain('job_posts_ai');
    expect(ids).toContain('ai_policy');
  });
});

describe('confianza según señales chequeadas', () => {
  it('5 o más señales dan HIGH', () => {
    const { pre_score } = calculatePreScore(baseObservations, availability());
    expect(pre_score.signals_detected).toBeGreaterThanOrEqual(5);
    expect(pre_score.confidence).toBe('HIGH');
  });

  it('solo DNS deja la confianza en LOW', () => {
    const { pre_score } = calculatePreScore(
      observations({ website_found: false }),
      availability({ website_checked: false }),
    );
    expect(pre_score.signals_detected).toBe(2);
    expect(pre_score.confidence).toBe('LOW');
  });

  it('sin ninguna señal el score es 0 y la confianza LOW', () => {
    const { pre_score } = calculatePreScore(
      observations({ website_found: false }),
      availability({ website_checked: false, dns_checked: false }),
    );
    expect(pre_score.points_possible).toBe(0);
    expect(pre_score.value).toBe(0);
    expect(pre_score.confidence).toBe('LOW');
  });
});

describe('quick report', () => {
  it('separa fortalezas de riesgos', () => {
    const { signals } = calculatePreScore(
      observations({ ai_policy_found: true, legal_platform: 'mycase', email_provider: 'google' }),
      availability(),
    );
    const report = buildQuickReport(signals, baseObservations);

    expect(report.top_strengths).toContain('AI Use Policy found');
    expect(report.top_risks).toContain('No DMARC configured');
    expect(report.summary).toContain('assessment');
  });

  it('explica cuando no se pudo alcanzar el sitio', () => {
    const { signals } = calculatePreScore(
      observations({ website_found: false }),
      availability({ website_checked: false }),
    );
    const report = buildQuickReport(signals, observations({ website_found: false }));
    expect(report.summary).toContain('could not reach');
  });
});
