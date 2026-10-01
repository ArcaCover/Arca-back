import { Layer1Evidence, type SourceStatus } from '@arca/contracts';
import { scoreEvidence } from './score.js';
import { independentlyConfirmed, reconcileAvvoMatches, reconcileBarMatches } from './matching.js';

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
  // Each directory reported its status before this cross-check, so it can still say NO_MATCH or
  // TRUNCATED about a person the other directory has just confirmed. Settle those two verdicts here.
  const settle = (status: SourceStatus, matches: typeof bar, other: typeof bar): SourceStatus => {
    if (matches === null) return status;
    const found = matches.filter(match => match.attorney !== null).length;
    const { code: _code, reason: _reason, ...rest } = status;
    if (status.code === 'NO_MATCH' && found > 0) {
      return { ...rest, attorneysFound: found, dataStatus: 'PRESENT', reason: 'Accepted after cross-checking the other directory' };
    }
    // A truncated page only matters if the missing candidates could change who was accepted.
    if (status.code === 'TRUNCATED' && matches.length > 0 && matches.every(match => independentlyConfirmed(match, other, evidence.identity))) {
      return { ...rest, attorneysFound: found, status: 'ok', dataStatus: 'PRESENT',
        reason: 'Result page was full, but every accepted attorney is confirmed by address, phone or admission year' };
    }
    return { ...status, attorneysFound: found };
  };
  const sources = {
    website: evidence.sources.website,
    bar: settle(evidence.sources.bar, bar, avvo),
    avvo: settle(evidence.sources.avvo, avvo, bar),
  };
  return { identity: evidence.identity,
    ...scoreEvidence({ website: evidence.website, bar, avvo, sources, now: evidence.observedAt,
      barJurisdiction: evidence.barJurisdiction ?? null }), sources };
}
