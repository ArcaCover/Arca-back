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
    expect(attempts.map(attempt => attempt.phase)).toEqual(['extract', 'extract-repair']);
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
      calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: 'failed' as const, detail: 'boom' })) })) };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(result.websiteData.firm_name).toBe('Smith Law');
    expect(result.diagnostics.toolCalls).toEqual([{ round: 1, tool: 'fetch_pages', target: 'https://firm.com/about', status: 'failed', detail: 'boom' }]);
  });
});
