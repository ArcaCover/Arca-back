import type { Layer1Observations, Layer1Result } from '@arca/contracts';

/** Observaciones de una firma sin ninguna señal detectada: el piso desde el que se construye. */
export const emptyObservations: Layer1Observations = {
  website_found: true,
  pages_scraped: ['https://example-law.com'],
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

/** Construye un Layer1Result válido variando solo lo que el test necesita. */
export function layer1Result(
  overrides: {
    pre_score?: number;
    observations?: Partial<Layer1Observations>;
  } = {},
): Layer1Result {
  const value = overrides.pre_score ?? 60;
  return {
    domain: 'example-law.com',
    firm: {
      name: 'Example Law',
      domain: 'example-law.com',
      city: null,
      state: 'FL',
      attorneys_count: 8,
      practice_areas: ['commercial_litigation'],
      primary_practice: 'commercial_litigation',
    },
    pre_score: {
      value,
      tier: value >= 70 ? 'FORTIFIED' : value >= 50 ? 'GUARDED' : 'EXPOSED',
      confidence: 'MEDIUM',
      signals_detected: 4,
      points_earned: value,
      points_possible: 100,
    },
    signals: [],
    observations: { ...emptyObservations, ...overrides.observations },
    quick_report: { summary: 'test fixture', top_strengths: [], top_risks: [] },
    steps: [],
    duration_ms: 1200,
  };
}

/** Firma con AI policy publicada: Q1.1 se salta. */
export const firmWithAiPolicy = layer1Result({
  pre_score: 68,
  observations: { ai_policy_found: true, ai_policy_url: 'https://example-law.com/ai-governance' },
});

/** Firma sin policy alguna: Q1.1 se pregunta. */
export const firmWithoutAiPolicy = layer1Result({ pre_score: 60 });

/** Firma con plataforma legal detectada: Q2.1 se salta. */
export const firmWithLegalPlatform = layer1Result({
  pre_score: 65,
  observations: { legal_platform: 'clio', cloud_tools_detected: true },
});

/** Pre-score bajo: entra Q3.3. */
export const firmWithLowPreScore = layer1Result({ pre_score: 42 });

/** Pre-score alto: entra Q5.2. */
export const firmWithHighPreScore = layer1Result({
  pre_score: 78,
  observations: { ai_policy_found: true, ai_policy_url: 'https://example-law.com/ai' },
});

/** Sitio caído: el scan sigue, pero sin ninguna señal de contenido. */
export const firmWithoutWebsite = layer1Result({
  pre_score: 0,
  observations: { website_found: false, pages_scraped: [] },
});
