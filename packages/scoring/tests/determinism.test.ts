import { describe, expect, it } from 'vitest';
import type { Layer1Evidence } from '@arca/contracts';
import { evaluateLayer1Evidence, mean, scoreEvidence } from '../src/index.js';
import { ambiguousDirectory, firmFallback, mockEvidence, multiState, OBSERVED_AT, ratingBoundary, reorder, reorderPeople, seeded,
  sevenAttorneys, sharedSearchedName, shuffle } from './fixtures/determinism.js';

const MOCKS = ['robust', 'minimal', 'sanctioned', 'partial'] as const;
const SYNTHETIC: [string, (observedAt?: string) => Layer1Evidence][] = [['seven attorneys averaging exactly 8.0', sevenAttorneys],
  ['three attorneys averaging exactly 7.0', ratingBoundary], ['cross-checked and ambiguous lookups', ambiguousDirectory],
  ['firm-wide Bar roster', firmFallback], ['two Avvo lookups for one normalised name', sharedSearchedName],
  ['attorneys licensed in several states', multiState]];
const FIXTURES: [string, (observedAt?: string) => Layer1Evidence][] = [...SYNTHETIC,
  ...MOCKS.map((name): [string, (observedAt?: string) => Layer1Evidence] => [`mock ${name}`, observedAt => mockEvidence(name, observedAt)])];
const PERMUTATIONS = 500;
const scored = (result: ReturnType<typeof evaluateLayer1Evidence>) => ({ preScore: result.preScore, multipliers: result.multipliers,
  website: result.signals.website, avvo: result.signals.avvo, bar: { ...result.signals.bar, attorneys: null } });

describe('Layer 1 gives one result for one set of evidence', () => {
  it.each(FIXTURES)('evaluates %s twice with identical output and leaves the input untouched', (_name, build) => {
    const evidence = build(), before = structuredClone(evidence);
    const first = evaluateLayer1Evidence(evidence);
    expect(evaluateLayer1Evidence(evidence)).toEqual(first);
    expect(evaluateLayer1Evidence(structuredClone(evidence))).toEqual(first);
    expect(JSON.stringify(evaluateLayer1Evidence(build()))).toBe(JSON.stringify(first));
    expect(evidence).toEqual(before);
  });

  it.each(SYNTHETIC)(`gives the same result for %s in ${PERMUTATIONS} different orders`, (_name, build) => {
    const evidence = build(), expected = evaluateLayer1Evidence(evidence), expectedJson = JSON.stringify(expected);
    const random = seeded(20261109);
    for (let run = 0; run < PERMUTATIONS; run++) {
      const result = evaluateLayer1Evidence(reorder(evidence, random));
      expect(result, `permutation ${run}`).toEqual(expected);
      expect(JSON.stringify(result), `permutation ${run}`).toBe(expectedJson);
    }
  });

  it.each(MOCKS)('gives the same result for the %s mock in different orders', name => {
    const evidence = mockEvidence(name), expected = evaluateLayer1Evidence(evidence);
    const random = seeded(7);
    for (let run = 0; run < 25; run++) expect(evaluateLayer1Evidence(reorder(evidence, random)), `permutation ${run}`).toEqual(expected);
  });

  it.each(SYNTHETIC)('does not let the order inside a person\'s own lists move the score of %s', (_name, build) => {
    const evidence = build(), expected = scored(evaluateLayer1Evidence(evidence));
    const random = seeded(99);
    for (let run = 0; run < 100; run++) {
      expect(scored(evaluateLayer1Evidence(reorderPeople(evidence, random))), `permutation ${run}`).toEqual(expected);
    }
  });

  it('cross-checks the Bar against the same Avvo lookup whichever order two lookups for one name arrive in', () => {
    // 'Ana Perez Ana Perez' and 'Ana Pérez' normalise to the Bar's 'Ana Perez Esq.'. The cross-check takes the first
    // of them, so without one fixed order before it the Bar namesake accepted (admitted 2005 or 2020) follows the provider.
    const evidence = sharedSearchedName(), [first, second] = evidence.avvo!;
    const swapped = { ...evidence, avvo: [second!, first!] };
    const expected = evaluateLayer1Evidence(evidence);
    expect(expected.signals.bar.attorneys?.map(match => match.attorney?.barNumber)).toEqual(['500001']);
    expect(evaluateLayer1Evidence(swapped)).toEqual(expected);
    const random = seeded(2026);
    for (let run = 0; run < 50; run++) {
      const shuffled = { ...evidence, avvo: shuffle(evidence.avvo!, random), bar: evidence.bar!.map(match =>
        ({ ...match, candidates: shuffle(match.candidates ?? [], random) })) };
      expect(evaluateLayer1Evidence(shuffled), `permutation ${run}`).toEqual(expected);
    }
  });

  it('scores directly supplied matches the same in any order', () => {
    // scoreEvidence is exported too, and must not depend on a caller sorting first.
    const evidence = sevenAttorneys();
    const input = (source: Layer1Evidence) => ({ website: source.website, bar: source.bar, avvo: source.avvo,
      sources: source.sources, now: source.observedAt, barJurisdiction: 'FL' });
    const expected = scoreEvidence(input(evidence));
    const random = seeded(3);
    for (let run = 0; run < 200; run++) expect(scoreEvidence(input(reorder(evidence, random))), `permutation ${run}`).toEqual(expected);
  });
});

describe('thresholds do not depend on summation order', () => {
  it('pins the firm whose ratings average exactly 8.0 to the top rating band', () => {
    const { preScore, signals } = evaluateLayer1Evidence(sevenAttorneys());
    expect(signals.avvo.A1_avgRating).toBe(8);
    expect(preScore.categories.reputation.rules.find(rule => rule.id === 'A1')?.points).toBe(9);
    expect({ total: preScore.total, tier: preScore.tier }).toEqual({ total: 81, tier: 'FORTRESS' });
    const random = seeded(12345);
    const tiers = new Set(Array.from({ length: 2000 }, () => {
      const result = evaluateLayer1Evidence(reorder(sevenAttorneys(), random)).preScore;
      return `${result.total} ${result.tier} ${result.decision}`;
    }));
    expect([...tiers]).toEqual([`81 FORTRESS ${preScore.decision}`]);
  });
  it('rates 2.2, 9.1 and 9.7 as an average of exactly 7 in every order', () => {
    const ratings = [2.2, 9.1, 9.7];
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      expect(mean(order.map(index => ratings[index]!))).toBe(7);
    }
    const { preScore, signals } = evaluateLayer1Evidence(ratingBoundary());
    expect(signals.avvo).toMatchObject({ A1_avgRating: 7, A3_avgReviewRating: 4 });
    const points = (id: string) => preScore.categories.reputation.rules.find(rule => rule.id === id)?.points;
    expect([points('A1'), points('A3')]).toEqual([6, 5]);
  });
  it('agrees with decimal arithmetic for every three-rating case on the 7.0 and 8.0 edges', () => {
    let cases = 0;
    for (let a = 10; a <= 100; a++) for (let b = a; b <= 100; b++) for (let c = b; c <= 100; c++) {
      if (a + b + c !== 240 && a + b + c !== 210) continue;
      cases++;
      const values = [a / 10, b / 10, c / 10], exact = (a + b + c) / 30;
      for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        expect(mean(order.map(index => values[index]!)), values.join(', ')).toBe(exact);
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });
  it('averages long lists of one-decimal values without drift', () => {
    const random = seeded(42);
    for (let round = 0; round < 200; round++) {
      const tenths = Array.from({ length: 2 + Math.floor(random() * 40) }, () => 10 + Math.floor(random() * 91));
      const expected = mean(tenths.map(value => value / 10));
      // The same total in integer tenths, where addition is exact.
      expect(expected).toBeCloseTo(tenths.reduce((sum, value) => sum + value, 0) / tenths.length / 10, 9);
      for (let run = 0; run < 10; run++) expect(mean(shuffle(tenths, random).map(value => value / 10))).toBe(expected);
    }
  });
  it('keeps unknown values out of the average and an empty list unknown', () => {
    expect(mean([null, 4, null, 2])).toBe(3);
    expect(mean([])).toBeNull();
    expect(mean([1 / 3, 1 / 3, 1 / 3])).toBe(0.333333333);
  });
});

describe('values that describe the run, not the firm, stay out of the score', () => {
  const fresh = () => {
    const evidence = ambiguousDirectory();
    for (const status of [evidence.sources.bar, evidence.sources.avvo]) {
      Object.assign(status, { accountingComplete: false, costUsd: null, cachedRuns: 0, costPerAcceptedAttorneyUsd: null,
        providerRuns: status.providerRuns!.map(run => ({ ...run, cached: false, chargedToScan: true, accountingComplete: false, costUsd: null })) });
    }
    return evidence;
  };
  const cached = () => {
    const evidence = ambiguousDirectory();
    for (const status of [evidence.sources.bar, evidence.sources.avvo]) {
      Object.assign(status, { accountingComplete: true, costUsd: 0, cachedRuns: status.providerRuns!.length, costPerAcceptedAttorneyUsd: 0,
        providerRuns: status.providerRuns!.map(run => ({ ...run, cached: true, chargedToScan: false, accountingComplete: true, costUsd: .01 })) });
    }
    return evidence;
  };
  it('gives a freshly charged run and a run served from cached provider results the same score and flags', () => {
    const first = evaluateLayer1Evidence(fresh()), again = evaluateLayer1Evidence(cached());
    expect(first.preScore.flags).not.toContain('PROVIDER_COST_UNKNOWN');
    expect(again.preScore).toEqual(first.preScore);
    expect({ signals: again.signals, multipliers: again.multipliers, identity: again.identity })
      .toEqual({ signals: first.signals, multipliers: first.multipliers, identity: first.identity });
    // The open accounting is still reported, on the source it belongs to.
    expect(first.sources.bar.accountingComplete).toBe(false);
    expect(again.sources.bar.accountingComplete).toBe(true);
  });
  it('lists provider runs by query fingerprint, whatever order they finished in', () => {
    const { sources } = evaluateLayer1Evidence(ambiguousDirectory());
    expect(sources.bar.providerRuns?.map(run => run.queryFingerprint[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(sources.avvo.providerRuns?.map(run => run.runId)).toEqual(['run-x', 'run-y', 'run-z']);
  });
});

describe('lists that reach the result have a defined order', () => {
  it('orders matches by searched name and then by the person, and candidates by registry number', () => {
    const { signals } = evaluateLayer1Evidence(ambiguousDirectory());
    expect(signals.bar.attorneys?.map(match => match.searchedName))
      .toEqual(['Briana Mauri', 'C. Ortega', 'Carlos Ortega', 'Dana Reyes', 'Evan Flores']);
    expect(signals.bar.attorneys?.find(match => match.searchedName === 'Dana Reyes')?.candidates?.map(person => person.barNumber))
      .toEqual(['400401', '400402']);
    const roster = evaluateLayer1Evidence(firmFallback()).signals.bar.attorneys!;
    expect(roster.map(match => match.attorney?.barNumber)).toEqual(['f4', 'f5', 'f6', 'f7', 'f8', 'f9']);
  });
  it('names the top award of the most awarded attorney, and breaks a tie by the award text', () => {
    expect(evaluateLayer1Evidence(sevenAttorneys()).signals.avvo.A6_topAward).toBe('Award 3');
    const tied = sevenAttorneys();
    for (const match of tied.avvo!) if (match.attorney?.awardsCount) match.attorney.awardsCount = 1;
    const random = seeded(5);
    for (let run = 0; run < 50; run++) {
      expect(evaluateLayer1Evidence(reorder(tied, random)).signals.avvo.A6_topAward).toBe('Award 1');
    }
    // Within one profile the provider's own order stands: its first award is its top award.
    expect(evaluateLayer1Evidence(ratingBoundary()).signals.avvo.A6_topAward).toBe('Rising Star');
  });
  it('lists the AI tools and the identity lists in a fixed order', () => {
    const { signals, identity } = evaluateLayer1Evidence(ambiguousDirectory());
    expect(signals.website.W2_aiInServices.tools).toEqual(['Casetext', 'ChatGPT', 'Lexis+ AI']);
    expect(identity.aliases).toEqual(['MO Law', 'Mauri Ortega']);
    expect(identity.attorneyNames).toEqual(['Briana Mauri', 'C. Ortega', 'Carlos Ortega', 'Dana Reyes', 'Evan Flores']);
    expect(identity.evidence.map(reference => reference.excerpt)).toEqual(['about', 'contact', 'team']);
  });
});

describe('date-driven values', () => {
  it('reports average experience to one decimal, so the next day shows the same result', () => {
    // The three-attorney fixture sits on the ten year threshold on purpose; it is checked below.
    for (const [name, build] of FIXTURES.filter(([, fixture]) => fixture !== ratingBoundary)) {
      const today = evaluateLayer1Evidence(build(OBSERVED_AT));
      const tomorrow = evaluateLayer1Evidence(build('2026-11-10T10:00:00.000Z'));
      expect(tomorrow, name).toEqual(today);
      const experience = today.signals.bar.B4_avgExperience;
      if (experience !== null) expect(experience, name).toBe(Math.round(experience * 10) / 10);
    }
  });
  it('changes from one day to the next only when a real threshold is crossed', () => {
    // Average experience is exactly ten years on the observation day and "more than ten" the day after.
    const today = evaluateLayer1Evidence(ratingBoundary(OBSERVED_AT));
    const tomorrow = evaluateLayer1Evidence(ratingBoundary('2026-11-10T10:00:00.000Z'));
    const b4 = (result: typeof today) => result.preScore.categories.professionalStanding.rules.find(rule => rule.id === 'B4')?.points;
    expect([b4(today), b4(tomorrow)]).toEqual([0, 3]);
    expect(tomorrow.preScore.total).toBe(today.preScore.total! + 3);
    expect(tomorrow.signals).toEqual(today.signals);
  });
  it('still applies the experience rule at the real ten and three year thresholds', () => {
    const b4 = (admissionDate: string, observedAt = OBSERVED_AT) => {
      const evidence = mockEvidence('robust', observedAt);
      evidence.bar![0]!.attorney!.admissionDate = admissionDate;
      const result = evaluateLayer1Evidence(evidence);
      return [result.signals.bar.B4_avgExperience, result.preScore.categories.professionalStanding.rules.find(rule => rule.id === 'B4')?.points];
    };
    // Two weeks either side of ten years: both read 10.0, only the one past the anniversary is "more than ten".
    expect(b4('2016-10-26')).toEqual([10, 3]);
    expect(b4('2016-11-23')).toEqual([10, 0]);
    expect(b4('2016-11-09')).toEqual([10, 0]);
    expect(b4('2023-11-23')).toEqual([3, -3]);
    expect(b4('2023-11-09')).toEqual([3, 0]);
    // An average of exactly ten years over three attorneys is not more than ten, in any order.
    const boundary = evaluateLayer1Evidence(ratingBoundary());
    expect(boundary.signals.bar.B4_avgExperience).toBe(10);
    expect(boundary.preScore.categories.professionalStanding.rules.find(rule => rule.id === 'B4')?.points).toBe(0);
  });
});
