import { describe, expect, it, vi } from 'vitest';
import { ExtractionFailure, NvidiaNimEvidenceProvider } from '../../src/pipeline/nvidia-evidence-provider.js';

describe('NVIDIA evidence provider', () => {
  it('uses the probed endpoint parameters and maps reviewed grounded claims', async () => {
    const page = { url: 'https://firm.com/', html: '', text: 'Smith Law is a law firm.' };
    let segmentId = '';
    const create = vi.fn(async (request: Record<string, unknown>) => {
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      segmentId ||= /\[(D-[^\]]+)\]/.exec(user)?.[1] ?? '';
      const content = user.startsWith('CANDIDATE CLAIMS')
        ? JSON.stringify({ verdicts: [{ claimId: 'firm', verdict: 'supported', reason: 'operator', citations: [{ segmentId, quote: 'Smith Law' }] }] })
        : JSON.stringify({ claims: [{ id: 'firm', field: 'firm_name', value: 'Smith Law', explanation: 'operator', citations: [{ segmentId, quote: 'Smith Law' }] }], action: { type: 'finish', reason: 'enough' } });
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    });
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } });
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(result.websiteData.firm_name).toBe('Smith Law');
    expect(result.websiteData.provenance.firm_name?.[0]?.method).toBe('provider');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: false, response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false } });
  });

  it('keeps every rejected attempt when the answer never matches the schema', async () => {
    const create = vi.fn(async () => ({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ claims: 'not-an-array' }) } }] }));
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } });
    const failure = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }],
      partial: false }, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtractionFailure);
    const attempts = (failure as ExtractionFailure).attempts;
    expect(attempts.map(attempt => attempt.phase)).toEqual(['extract-round-1', 'extract-round-1-repair']);
    expect(attempts.every(attempt => attempt.rawContent.includes('not-an-array') && attempt.validationIssues)).toBe(true);
  });

  it('records a link that cannot be fetched and keeps the extraction', async () => {
    const page = { url: 'https://firm.com/', html: '<a href="/about">About</a>', text: 'Smith Law is a law firm.' };
    let segmentId = '';
    const create = vi.fn(async (request: Record<string, unknown>) => {
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      segmentId ||= /\[(D-[^\]]+)\]/.exec(user)?.[1] ?? '';
      const linkId = /\[(L-[^\]]+)\] PAGE/.exec(user)?.[1] ?? '';
      const claims = [{ id: 'firm', field: 'firm_name', value: 'Smith Law', explanation: 'operator', citations: [{ segmentId, quote: 'Smith Law' }] }];
      const content = user.startsWith('CANDIDATE CLAIMS')
        ? JSON.stringify({ verdicts: [{ claimId: 'firm', verdict: 'supported', reason: 'operator', citations: claims[0]!.citations }] })
        : JSON.stringify({ claims, action: { type: 'fetch_pages', linkIds: [linkId], targetFields: ['firm_name'], reason: 'about' } });
      return { choices: [{ finish_reason: 'stop', message: { content } }] };
    });
    const access = { fetchPages: vi.fn(async (urls: string[]) => ({ pages: [],
      calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: 'failed' as const, detail: 'boom' })) })),
      readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(result.websiteData.firm_name).toBe('Smith Law');
    expect(result.diagnostics.toolCalls).toEqual([{ round: 1, tool: 'fetch_pages', target: 'https://firm.com/about', status: 'failed', detail: 'boom' }]);
    expect(result.diagnostics.stopReason).toBe('NO_NEW_EVIDENCE');
  });

  const scripted = (rounds: Array<(user: string) => Record<string, unknown>>) => {
    let extractCalls = 0;
    return vi.fn(async (request: Record<string, unknown>) => {
      const user = (request.messages as Array<{ content: string }>)[1]!.content;
      if (user.startsWith('CANDIDATE CLAIMS')) {
        const claims = JSON.parse(user.slice('CANDIDATE CLAIMS\n'.length, user.indexOf('\n\nSNAPSHOT'))) as Array<{ id: string; citations: unknown[] }>;
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdicts: claims.map(claim =>
          ({ claimId: claim.id, verdict: 'supported', reason: 'ok', citations: claim.citations })) }) } }] };
      }
      const body = rounds[Math.min(extractCalls++, rounds.length - 1)]!(user);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] };
    });
  };

  it('reads a privacy PDF the agent asked for and cites it in the next round', async () => {
    const home = { url: 'https://firm.com/', text: 'Smith Law.', html: '<a href="/policy.pdf">Privacy</a>' };
    const create = scripted([
      user => ({ claims: [], action: { type: 'read_document', linkIds: [/\[(L-[^\]]+)\] DOCUMENT/.exec(user)![1]], targetFields: ['privacy_policy'], reason: 'policy' } }),
      user => ({ claims: [{ id: 'privacy', field: 'privacy_policy', value: { found: true, mentions_client_data: null }, explanation: 'policy document',
        citations: [{ segmentId: /\[([^\]]+)\] URL=https:\/\/firm\.com\/policy\.pdf KIND=document/.exec(user)![1], quote: 'Privacy Policy' }] }],
        action: { type: 'finish', reason: 'done' } }),
    ]);
    const access = { fetchPages: vi.fn(), readSitemap: vi.fn(), readDocuments: vi.fn(async (urls: string[]) => ({
      pages: [{ url: urls[0]!, html: '', text: 'Privacy Policy. We keep client information confidential.', kind: 'document' as const, complete: true }],
      calls: [{ tool: 'read_document' as const, target: urls[0]!, status: 'read' as const, detail: 'complete' }] })) };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [home], partial: false }, new AbortController().signal);
    expect(result.websiteData.privacy_policy.found).toBe(true);
    expect(result.diagnostics).toMatchObject({ rounds: 2, stopReason: 'SUFFICIENT_FOR_EXTRACTION',
      toolCalls: [{ round: 1, tool: 'read_document', target: 'https://firm.com/policy.pdf', status: 'read' }] });
  });

  it('skips unknown link IDs and stops when a round brings no new evidence', async () => {
    const create = scripted([() => ({ claims: [], action: { type: 'fetch_pages', linkIds: ['L-invented'], targetFields: ['attorneys'], reason: 'guess' } })]);
    const access = { fetchPages: vi.fn(), readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false }, new AbortController().signal);
    expect(access.fetchPages).not.toHaveBeenCalled();
    expect(result.diagnostics).toMatchObject({ stopReason: 'NO_NEW_EVIDENCE',
      toolCalls: [{ round: 1, tool: 'fetch_pages', target: 'L-invented', status: 'skipped', detail: 'UNKNOWN_LINK' }] });
  });

  it('never reads the sitemap twice and ends at the round limit', async () => {
    const create = scripted([() => ({ claims: [], action: { type: 'read_sitemap', targetFields: ['attorneys'], reason: 'map' } })]);
    const access = { fetchPages: vi.fn(), readDocuments: vi.fn(), readSitemap: vi.fn(async () => ({
      links: [{ url: 'https://firm.com/equipo/', kind: 'page' as const }],
      calls: [{ tool: 'read_sitemap' as const, target: 'https://firm.com/', status: 'read' as const, detail: '1 urls' }] })) };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false }, new AbortController().signal);
    expect(access.readSitemap).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.stopReason).toBe('NO_NEW_EVIDENCE');
    expect(result.diagnostics.toolCalls.at(-1)).toMatchObject({ round: 2, tool: 'read_sitemap', status: 'skipped', detail: 'ALREADY_READ' });
  });
});
