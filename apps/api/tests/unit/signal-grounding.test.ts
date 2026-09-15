import { describe, expect, it } from 'vitest';
import type { Claim, SignalReview } from '@arca/contracts';
import { acceptClaims, toWebsiteData } from '../../src/pipeline/signal-grounding.js';
import { buildCorpus } from '../../src/pipeline/evidence-corpus.js';

describe('signal grounding', () => {
  const corpus = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/team', html: '',
    text: 'Smith Law was founded in 2001. Jane Doe is an Attorney at Smith Law.' }] });
  const segment = corpus.segments[0]!;
  const firm: Claim = { id: 'firm', field: 'firm_name', value: 'Smith Law', explanation: 'site operator',
    citations: [{ segmentId: segment.id, quote: 'Smith Law' }] };
  const review = (verdict: 'supported' | 'unsupported' | 'uncertain'): SignalReview => ({ verdicts: [{ claimId: 'firm', verdict,
    reason: verdict, citations: [{ segmentId: segment.id, quote: 'Smith Law' }] }] });
  it('accepts a literal value only after semantic support', () => {
    const result = acceptClaims([firm], review('supported'), corpus);
    expect(result.report).toMatchObject({ accepted: 1, rejected: 0 });
    expect(toWebsiteData(result.accepted, corpus).firm_name).toBe('Smith Law');
  });
  it('rejects invented quotes, values outside quotes and unsupported attribution', () => {
    expect(acceptClaims([{ ...firm, citations: [{ segmentId: segment.id, quote: 'Invented' }] }], review('supported'), corpus)
      .report.items[0]?.reason).toBe('QUOTE_NOT_IN_SOURCE');
    expect(acceptClaims([{ ...firm, value: 'Other Law' }], review('supported'), corpus).report.items[0]?.reason).toBe('VALUE_NOT_IN_QUOTE');
    expect(acceptClaims([firm], review('unsupported'), corpus).report.items[0]?.reason).toBe('UNSUPPORTED_CLAIM');
  });

  it('does not identify the firm city from a privacy policy mailing address plus a different marketed city', () => {
    const policy = buildCorpus({ partial: false, pages: [
      { url: 'https://firm.com/privacy-policy.pdf', html: '',
        text: 'Privacy Policy. Mail: Smith Law, 10 Main Street, Doral, FL 33166.', kind: 'document', complete: true },
      { url: 'https://firm.com/', html: '', text: 'Miami immigration attorneys.' },
    ] });
    const item: Claim = { id: 'city', field: 'city', value: 'Doral, FL', explanation: 'mailing address',
      citations: [{ segmentId: policy.segments.find(segment => segment.url === 'https://firm.com/privacy-policy.pdf')!.id, quote: 'Doral, FL' },
        { segmentId: policy.segments.find(segment => segment.url === 'https://firm.com/')!.id, quote: 'Miami immigration attorneys.' }] };
    const supported: SignalReview = { verdicts: [{ claimId: item.id, verdict: 'supported', reason: 'address',
      citations: item.citations }] };
    expect(acceptClaims([item], supported, policy).report.items[0]).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_CLAIM' });
  });

  it('does not expose an attorney count as the total team size', () => {
    const item: Claim = { id: 'attorney-count', field: 'attorney_count', value: 1, explanation: 'one attorney',
      citations: [{ segmentId: segment.id, quote: 'Jane Doe is an Attorney' }] };
    const supported: SignalReview = { verdicts: [{ claimId: item.id, verdict: 'supported', reason: 'listed attorney',
      citations: item.citations }] };
    const result = acceptClaims([item], supported, corpus);
    expect(result.report.items[0]).toMatchObject({ status: 'accepted', reason: null });
    expect(toWebsiteData(result.accepted, corpus).team_size).toBeNull();
  });

  it('rejects a practice-area list when any canonical area is absent from its evidence', () => {
    const item: Claim = { id: 'areas', field: 'practice_areas', value: ['Personal Injury', 'Medical Malpractice'],
      explanation: 'services', citations: [{ segmentId: segment.id, quote: 'Smith Law was founded in 2001. Jane Doe is an Attorney at Smith Law.' }] };
    const supported: SignalReview = { verdicts: [{ claimId: item.id, verdict: 'supported', reason: 'services',
      citations: item.citations }] };
    expect(acceptClaims([item], supported, corpus).report.items[0]).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_CLAIM' });
  });

  it('does not treat medical-negligence case language as a medical-malpractice practice area', () => {
    const areas = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/', html: '',
      text: 'We represent clients in medical negligence cases.' }] });
    const item: Claim = { id: 'medical', field: 'practice_areas', value: ['Medical Malpractice'], explanation: 'case type',
      citations: [{ segmentId: areas.segments[0]!.id, quote: 'medical negligence cases' }] };
    const supported: SignalReview = { verdicts: [{ claimId: item.id, verdict: 'supported', reason: 'case type',
      citations: item.citations }] };
    expect(acceptClaims([item], supported, areas).report.items[0]).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_CLAIM' });
  });

  it('rejects a phone claim that combines separate phone numbers', () => {
    const phones = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/', html: '',
      text: 'Main line: (305) 436-0155. Detention hotline: (645) 236-3669.' }] });
    const item: Claim = { id: 'phone', field: 'phone', value: '(305) 436-0155; detention hotline (645) 236-3669',
      explanation: 'contacts', citations: [{ segmentId: phones.segments[0]!.id, quote: 'Main line: (305) 436-0155. Detention hotline: (645) 236-3669.' }] };
    const supported: SignalReview = { verdicts: [{ claimId: item.id, verdict: 'supported', reason: 'contacts',
      citations: item.citations }] };
    expect(acceptClaims([item], supported, phones).report.items[0]).toMatchObject({ status: 'rejected', reason: 'UNSUPPORTED_CLAIM' });
  });
});

describe('absence claims', () => {
  const corpus = buildCorpus({ partial: false, pages: [
    { url: 'https://firm.com/', html: '', text: [
      'Smith Law, PLLC', 'Residencia permanente',
      'No utilizamos inteligencia artificial en nuestros servicios.',
      'We do not use ChatGPT for client work.', 'No cobramos la consulta inicial.',
    ].join('\n') },
    { url: 'https://firm.com/privacy', html: '', text: 'Privacy Policy. We protect the information you share with us.' },
  ] });
  const segmentFor = (url: string) => corpus.segments.find(segment => segment.url === url)!.id;
  const claim = (field: Claim['field'], value: unknown, quote: string, url = 'https://firm.com/'): Claim =>
    ({ id: field, field, value, explanation: 'test', citations: [{ segmentId: segmentFor(url), quote }] });
  const supported = (claims: Claim[]): SignalReview => ({ verdicts: claims.map(item =>
    ({ claimId: item.id, verdict: 'supported' as const, reason: 'test', citations: item.citations })) });
  const accept = (item: Claim) => acceptClaims([item], supported([item]), corpus);

  it('does not accept an absence inferred from silence', () => {
    // Real Duque output: "No AI policy mentioned anywhere on the site", citing the firm's own name.
    const result = accept(claim('ai_policy', { found: false, depth: 'none' }, 'Smith Law, PLLC'));
    expect(result.accepted).toHaveLength(0);
    expect(result.report).toMatchObject({ accepted: 0, rejected: 0, unknown: 1 });
    expect(result.report.items[0]).toMatchObject({ status: 'unknown', reason: 'UNSUPPORTED_ABSENCE' });
    expect(toWebsiteData(result.accepted, corpus).ai_policy.depth).toBeNull();
  });

  it('accepts an explicit negation about AI use in Spanish or English', () => {
    const value = { found: false, tools_mentioned: null, integration_depth: 'none_detected' };
    const spanish = accept(claim('ai_in_services', value, 'No utilizamos inteligencia artificial en nuestros servicios.'));
    const english = accept(claim('ai_in_services', value, 'We do not use ChatGPT for client work.'));
    expect(spanish.report.items[0]).toMatchObject({ status: 'accepted', reason: null });
    expect(english.report.items[0]).toMatchObject({ status: 'accepted', reason: null });
    expect(toWebsiteData(spanish.accepted, corpus).ai_in_services.found).toBe(false);
  });

  it('recognises an accented Spanish negation', () => {
    const accented = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/', html: '',
      text: 'Jamás empleamos IA para redactar documentos.' }] });
    const item: Claim = { id: 'ai_disclosure', field: 'ai_disclosure', value: { found: false }, explanation: 'test',
      citations: [{ segmentId: accented.segments[0]!.id, quote: 'Jamás empleamos IA para redactar documentos.' }] };
    expect(acceptClaims([item], supported([item]), accented).report.items[0]).toMatchObject({ status: 'accepted', reason: null });
  });

  it('does not let a negation about something else support an AI absence', () => {
    const result = accept(claim('ai_disclosure', { found: false }, 'No cobramos la consulta inicial.'));
    expect(result.report.items[0]).toMatchObject({ status: 'unknown', reason: 'UNSUPPORTED_ABSENCE' });
  });

  it('keeps the positive part of a claim and drops its unsupported negative', () => {
    const result = accept(claim('privacy_policy', { found: true, mentions_client_data: false }, 'Privacy Policy.',
      'https://firm.com/privacy'));
    expect(result.report.items[0]).toMatchObject({ status: 'accepted', degradedFields: ['mentions_client_data'] });
    expect(toWebsiteData(result.accepted, corpus).privacy_policy).toEqual({ found: true, mentions_client_data: null });
  });

  it('never treats a missing page or a zero count as observed from a single quote', () => {
    for (const item of [
      claim('privacy_policy', { found: false, mentions_client_data: null }, 'Smith Law, PLLC'),
      claim('team_page_quality', 'no_team_page', 'Smith Law, PLLC'),
      claim('attorney_count', 0, 'Smith Law, PLLC'),
    ]) {
      expect(accept(item).report.items[0]).toMatchObject({ status: 'unknown', reason: 'UNSUPPORTED_ABSENCE' });
    }
  });

  it('accepts a client-data negative only from a complete privacy document', () => {
    const policy = (complete: boolean) => buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/privacy-policy.pdf', html: '',
      text: 'Privacy Policy. We use contact details to answer your requests.', kind: 'document', complete }] });
    const judge = (documents: ReturnType<typeof buildCorpus>) => {
      const item: Claim = { id: 'privacy_policy', field: 'privacy_policy', value: { found: true, mentions_client_data: false },
        explanation: 'whole policy read', citations: [{ segmentId: documents.segments[0]!.id, quote: 'Privacy Policy.' }] };
      return acceptClaims([item], supported([item]), documents);
    };
    const complete = judge(policy(true));
    expect(complete.report.items[0]).toMatchObject({ status: 'accepted', reason: null });
    expect(complete.report.items[0]).not.toHaveProperty('degradedFields');
    expect(toWebsiteData(complete.accepted, policy(true)).privacy_policy).toEqual({ found: true, mentions_client_data: false });
    expect(judge(policy(false)).report.items[0]).toMatchObject({ status: 'accepted', degradedFields: ['mentions_client_data'] });
  });

  it('still never accepts a missing privacy policy', () => {
    const documents = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/terms.pdf', html: '',
      text: 'Terms of Service.', kind: 'document', complete: true }] });
    const item: Claim = { id: 'privacy_policy', field: 'privacy_policy', value: { found: false, mentions_client_data: null },
      explanation: 'none found', citations: [{ segmentId: documents.segments[0]!.id, quote: 'Terms of Service.' }] };
    expect(acceptClaims([item], supported([item]), documents).report.items[0]).toMatchObject({ status: 'unknown', reason: 'UNSUPPORTED_ABSENCE' });
  });

  it('does not treat a complete non-privacy document that mentions privacy as the policy', () => {
    const documents = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/terms.pdf', html: '',
      text: 'Terms of Service. We respect your privacy.', kind: 'document', complete: true }] });
    const item: Claim = { id: 'privacy_policy', field: 'privacy_policy', value: { found: true, mentions_client_data: false },
      explanation: 'test', citations: [{ segmentId: documents.segments[0]!.id, quote: 'We respect your privacy.' }] };
    expect(acceptClaims([item], supported([item]), documents).report.items[0]).toMatchObject({ status: 'accepted', degradedFields: ['mentions_client_data'] });
  });

  it('keeps the negative degraded when any citation is not the complete privacy document', () => {
    const documents = buildCorpus({ partial: false, pages: [
      { url: 'https://firm.com/privacy-policy.pdf', html: '', text: 'Privacy Policy. We use contact details to answer your requests.', kind: 'document', complete: true },
      { url: 'https://firm.com/contact', html: '', text: 'Contact us for a consultation.' },
    ] });
    const privacySegmentId = documents.segments.find(s => s.url === 'https://firm.com/privacy-policy.pdf')!.id;
    const contactSegmentId = documents.segments.find(s => s.url === 'https://firm.com/contact')!.id;
    const item: Claim = { id: 'privacy_policy', field: 'privacy_policy', value: { found: true, mentions_client_data: false },
      explanation: 'test', citations: [{ segmentId: privacySegmentId, quote: 'Privacy Policy.' }, { segmentId: contactSegmentId, quote: 'Contact us' }] };
    expect(acceptClaims([item], supported([item]), documents).report.items[0]).toMatchObject({ status: 'accepted', degradedFields: ['mentions_client_data'] });
  });

  it('never accepts a missing policy even when citing a complete privacy document', () => {
    const documents = buildCorpus({ partial: false, pages: [{ url: 'https://firm.com/privacy-policy.pdf', html: '',
      text: 'Privacy Policy. We use contact details to answer your requests.', kind: 'document', complete: true }] });
    const item: Claim = { id: 'privacy_policy', field: 'privacy_policy', value: { found: false, mentions_client_data: null },
      explanation: 'none found', citations: [{ segmentId: documents.segments[0]!.id, quote: 'Privacy Policy.' }] };
    expect(acceptClaims([item], supported([item]), documents).report.items[0]).toMatchObject({ status: 'unknown', reason: 'UNSUPPORTED_ABSENCE' });
  });
});
