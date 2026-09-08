import { Layer1Result } from '@arca/contracts';
import { category } from '@arca/scoring';
export function fixtureResult(): Layer1Result {
  const unknown = category(35, [{ id: 'unknown', points: null, reason: 'Unknown' }]);
  return Layer1Result.parse({ canonicalDomain: 'firm.com',
    preScore: { total: null, categories: { aiGovernance: unknown, professionalStanding: { ...unknown, max: 30 },
      reputation: { ...unknown, max: 20 }, firmMaturity: { ...unknown, max: 15 } },
      tier: 'UNKNOWN', decision: 'UNKNOWN', confidence: 'LOW', overrides: [], flags: [] },
    signals: {
      website: { W1_aiPolicy: { found: null, depth: null, points: null }, W2_aiInServices: { found: null, tools: null, points: null },
        W3_aiDisclosure: { found: null, points: null }, W4_aiBlog: { found: null, count: null, points: null }, W5_teamSize: null,
        W5a_teamPageQuality: null, W6_privacyPolicy: { found: null, mentionsClientData: null, points: null }, W7_websiteQuality: null,
        W8_firmEstablished: null, W9_practiceAreas: null },
      bar: { B1_allActive: null, B2_worstDisciplinary: null, B3_consistency: null, B4_avgExperience: null, attorneys: null },
      avvo: { A1_avgRating: null, A2_practiceAreas: null, A3_avgReviewRating: null, A3_totalReviews: null, A5_avgEndorsements: null, A6_hasAwards: null },
    },
    multipliers: { practiceArea: { area: null, value: 1, known: false }, jurisdiction: { state: null, value: 1, known: false }, size: { teamSize: null, value: 1, known: false } },
    sources: Object.fromEntries(['website', 'bar', 'avvo'].map(source => [source, { status: 'error', dataStatus: 'UNKNOWN', durationMs: 0 }])),
    meta: { scanDurationMs: 10, cached: false, completedAt: new Date().toISOString() },
  });
}
