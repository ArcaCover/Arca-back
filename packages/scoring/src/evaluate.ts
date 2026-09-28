import { Layer1Evidence, type SourceStatus } from '@arca/contracts';
import { scoreEvidence } from './score.js';
import { reconcileAvvoMatches, reconcileBarMatches } from './matching.js';

/**
 * Deterministic Layer 1 boundary. It knows structured evidence, never crawlers,
 * provider SDKs, prompts or OpenAI clients.
 */
export function evaluateLayer1Evidence(rawEvidence: Layer1Evidence) {
  const evidence = Layer1Evidence.parse(rawEvidence);
  // Let either directory corroborate a longer legal name. A profile may use a personal address and omit
  // the current firm, while Bar and Avvo still agree on full name plus address, phone or admission year.
  const provisionalAvvo = reconcileAvvoMatches(evidence.avvo, evidence.bar, evidence.identity);
  const bar = reconcileBarMatches(evidence.bar, evidence.identity, provisionalAvvo);
  const avvo = reconcileAvvoMatches(evidence.avvo, bar, evidence.identity);
  const withFound = (status: SourceStatus, matches: typeof bar): SourceStatus => matches === null ? status : ({
    ...status, attorneysFound: matches.filter(match => match.attorney !== null).length,
  });
  const sources = {
    website: evidence.sources.website,
    bar: withFound(evidence.sources.bar, bar),
    avvo: withFound(evidence.sources.avvo, avvo),
  };
  return { identity: evidence.identity,
    ...scoreEvidence({ website: evidence.website, bar, avvo, sources, now: evidence.observedAt,
      barJurisdiction: evidence.barJurisdiction ?? null }), sources };
}
