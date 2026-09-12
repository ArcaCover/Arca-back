import { Layer1Evidence, type SourceStatus } from '@arca/contracts';
import { scoreEvidence } from './score.js';
import { reconcileAvvoMatches, reconcileBarMatches } from './matching.js';

/**
 * Deterministic Layer 1 boundary. It knows structured evidence, never crawlers,
 * provider SDKs, prompts or OpenAI clients.
 */
export function evaluateLayer1Evidence(rawEvidence: Layer1Evidence) {
  const evidence = Layer1Evidence.parse(rawEvidence);
  const bar = reconcileBarMatches(evidence.bar, evidence.identity.firmName);
  const avvo = reconcileAvvoMatches(evidence.avvo, bar, evidence.identity.firmName);
  const withFound = (status: SourceStatus, matches: typeof bar): SourceStatus => matches === null ? status : ({
    ...status, attorneysFound: matches.filter(match => match.attorney !== null).length,
  });
  const sources = {
    website: evidence.sources.website,
    bar: withFound(evidence.sources.bar, bar),
    avvo: withFound(evidence.sources.avvo, avvo),
  };
  return { identity: evidence.identity,
    ...scoreEvidence({ website: evidence.website, bar, avvo, sources, now: evidence.observedAt }), sources };
}
