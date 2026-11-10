import { PAGE_CLASSIFICATION_PROMPT } from '../../../../src/pipeline/page-types.js';
import { SIGNAL_EXTRACTION_PROMPT, SIGNAL_REVIEW_PROMPT } from '../../../../src/pipeline/agentic-evidence-provider.js';
import type { Answer } from '../replay.js';

// Hand-written answers for the Harbor Vale site, standing in for the model when `llm.json` is recorded
// (REPLAY_RECORD=1). No model was ever called for this fixture. It reads the prompt only to copy the segment and
// candidate ids, which hash the page content, into answers a careful reader of these pages would give.

type Segment = { id: string; url: string; kind: string; text: string };
function segments(user: string): Segment[] {
  const body = user.slice(user.indexOf('SEGMENTS\n') + 'SEGMENTS\n'.length, user.indexOf('\n\nDISCOVERED LINKS'));
  return body.split(/\n\n(?=\[)/).flatMap(block => {
    const match = /^\[([^\]]+)\] URL=(\S+) KIND=(\w+)\n([\s\S]*)$/.exec(block);
    return match ? [{ id: match[1]!, url: match[2]!, kind: match[3]!, text: match[4]! }] : [];
  });
}
type Draft = { id: string; field: string; value: unknown; explanation: string; quotes: string[] };
/** A claim is made only when every quote is on the page: a sentence the site dropped takes its claim with it. */
function claims(user: string, drafts: Draft[]) {
  const corpus = segments(user);
  return drafts.flatMap(({ quotes, ...claim }) => {
    const citations = quotes.map(quote => ({ segmentId: corpus.find(item => item.kind === 'text' && item.text.includes(quote))?.id, quote }));
    return citations.every(citation => citation.segmentId) ? [{ ...claim, citations }] : [];
  });
}

const PAGE_TYPES: Array<[RegExp, string]> = [[/\/attorneys\/[^/]+$/, 'profile'], [/\/attorneys$/, 'team'], [/\/about$/, 'about'],
  [/\/contact$/, 'contact'], [/\/privacy-policy$/, 'privacy']];

export const scriptedModel: Answer = (system, user) => {
  if (system === PAGE_CLASSIFICATION_PROMPT) {
    const pages = [...user.matchAll(/^\[(C\d+)\] \w+ \w+ (\S+) ::/gm)].map(match =>
      ({ id: match[1]!, type: PAGE_TYPES.find(([path]) => path.test(match[2]!))?.[1] ?? 'other' }));
    return { phase: 'classify-pages', response: { pages } };
  }
  if (system === SIGNAL_REVIEW_PROMPT) {
    const candidates = JSON.parse(user.slice('CANDIDATE CLAIMS\n'.length, user.indexOf('\n\nSNAPSHOT'))) as Array<{ id: string; citations: unknown[] }>;
    return { phase: 'review', response: { verdicts: candidates.map(claim =>
      ({ claimId: claim.id, verdict: 'supported', reason: 'The quoted sentence says this about the firm.', citations: claim.citations })) } };
  }
  if (system.includes('This pass is only for attorneys')) {
    const person = (id: string, full_name: string, title: string): Draft => ({ id, field: 'attorneys',
      value: [{ full_name, title, role: 'attorney', affiliation: 'current' }], explanation: 'Listed on the team page with a legal role.',
      quotes: [`${full_name}, ${title}`] });
    return { phase: 'extract-roster', response: { action: { type: 'finish', reason: 'The team page was read in full.' },
      claims: claims(user, [person('roster-daniel-harbor', 'Daniel Harbor', 'Associate Attorney'), person('roster-maria-vale', 'Maria Vale', 'Managing Partner')]) } };
  }
  if (system === SIGNAL_EXTRACTION_PROMPT) {
    const injury = user.includes('we handle immigration, family law and personal injury matters');
    return { phase: 'extract-round', response: { action: { type: 'finish', reason: 'Every page that could settle a field was read.' },
      claims: claims(user, [
        { id: 'firm-name', field: 'firm_name', value: 'Harbor Vale Law', explanation: 'The site operator names itself.',
          quotes: ['Harbor Vale Law is a law firm in Miami, Florida'] },
        { id: 'city', field: 'city', value: 'Miami', explanation: 'The home page states where the firm is.',
          quotes: ['Harbor Vale Law is a law firm in Miami, Florida'] },
        { id: 'address', field: 'address_street', value: '200 Bay Street', explanation: 'The contact page gives the office address.',
          quotes: ['Harbor Vale Law, 200 Bay Street, Miami, FL 33131'] },
        { id: 'phone', field: 'phone', value: '(305) 555-0142', explanation: 'The home page gives the firm phone.',
          quotes: ['Call us at (305) 555-0142'] },
        { id: 'offices', field: 'office_count', value: 1, explanation: 'The about page states the number of offices.',
          quotes: ['The firm has one office in Miami'] },
        { id: 'established', field: 'firm_established_year', value: 2009, explanation: 'The home page states the founding year.',
          quotes: ['Founded in 2009'] },
        injury
          ? { id: 'practice-areas', field: 'practice_areas', value: ['Immigration', 'Family Law', 'Personal Injury'],
            explanation: 'The home page lists the matters the firm handles.', quotes: ['we handle immigration, family law and personal injury matters'] }
          : { id: 'practice-areas', field: 'practice_areas', value: ['Immigration', 'Family Law'],
            explanation: 'The home page lists the matters the firm handles.', quotes: ['we handle immigration and family law matters'] },
        { id: 'ai-policy', field: 'ai_policy', value: { found: true, depth: 'basic' }, explanation: 'The firm states it has a written AI policy.',
          quotes: ['Harbor Vale Law has a written policy for artificial intelligence'] },
        { id: 'ai-services', field: 'ai_in_services', value: { found: true, tools_mentioned: ['CoCounsel'], integration_depth: 'supplementary' },
          explanation: 'The firm states its attorneys use a named AI tool for research.', quotes: ['Our attorneys use CoCounsel for legal research'] },
        { id: 'ai-disclosure', field: 'ai_disclosure', value: { found: true }, explanation: 'The firm tells clients when AI assists.',
          quotes: ['We tell clients when AI tools assist with their matter'] },
        { id: 'privacy', field: 'privacy_policy', value: { found: true, mentions_client_data: true }, explanation: 'The privacy policy covers client data.',
          quotes: ['Harbor Vale Law protects client data'] },
      ]) } };
  }
  throw new Error('The scripted model has no answer for this prompt');
};
