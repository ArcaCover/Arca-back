import { describe, expect, it, vi } from 'vitest';
import { ExtractionFailure, NvidiaNimEvidenceProvider } from '../../src/pipeline/nvidia-evidence-provider.js';
import { LLM_ENDPOINTS } from '../../src/pipeline/llm-endpoint.js';

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

  it('never reads the sitemap twice and stops when the repeat brings no new evidence', async () => {
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

  it('searches the site across rounds and stops at the round limit', async () => {
    const filler = 'x'.repeat(700);
    const page = { url: 'https://firm.com/', html: '',
      text: `Criminal Defense info. ${filler} 555-1234 contact info.` };
    const create = scripted([
      () => ({ claims: [], action: { type: 'find_in_site', terms: ['Criminal Defense'], targetFields: ['practice_areas'], reason: 'r1' } }),
      () => ({ claims: [], action: { type: 'find_in_site', terms: ['555-1234'], targetFields: ['phone'], reason: 'r2' } }),
      () => ({ claims: [], action: { type: 'read_sitemap', targetFields: ['attorneys'], reason: 'r3' } }),
    ]);
    const access = { fetchPages: vi.fn(), readDocuments: vi.fn(), readSitemap: vi.fn(async () => ({
      links: [{ url: 'https://firm.com/equipo/', kind: 'page' as const }],
      calls: [{ tool: 'read_sitemap' as const, target: 'https://firm.com/', status: 'read' as const, detail: '1 urls' }] })) };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(result.diagnostics).toMatchObject({ rounds: 3, stopReason: 'ROUND_LIMIT' });
    const findCalls = result.diagnostics.toolCalls.filter(call => call.tool === 'find_in_site');
    expect(findCalls).toHaveLength(2);
    expect(findCalls.every(call => call.status === 'read')).toBe(true);
    expect(result.diagnostics.toolCalls.some(call => call.tool === 'read_sitemap')).toBe(false);
    expect(access.readSitemap).not.toHaveBeenCalled();
  });

  it('deduplicates repeated link IDs before reading them', async () => {
    const page = { url: 'https://firm.com/', html: '<a href="/about">About</a>', text: 'Smith Law is a law firm.' };
    const create = scripted([
      user => ({ claims: [], action: { type: 'fetch_pages', linkIds: Array(2).fill(/\[(L-[^\]]+)\] PAGE/.exec(user)![1]), targetFields: ['firm_name'], reason: 'about' } }),
      () => ({ claims: [], action: { type: 'finish', reason: 'done' } }),
    ]);
    const access = { fetchPages: vi.fn(async (urls: string[]) => ({
      pages: urls.map(url => ({ url, html: '', text: 'About Smith Law.' })),
      calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: 'read' as const, detail: null })) })),
      readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(access.fetchPages).toHaveBeenCalledWith(['https://firm.com/about'], expect.anything());
    expect(result.diagnostics.toolCalls).toEqual([{ round: 1, tool: 'fetch_pages', target: 'https://firm.com/about', status: 'read', detail: null }]);
  });

  it('never retries a URL whose earlier tool call already failed', async () => {
    const page = { url: 'https://firm.com/', html: '<a href="/about">About</a><a href="/team">Team</a>', text: 'Smith Law is a law firm.' };
    const create = scripted([
      user => ({ claims: [], action: { type: 'fetch_pages',
        linkIds: [/\[(L-[^\]]+)\] PAGE https:\/\/firm\.com\/about/.exec(user)![1], /\[(L-[^\]]+)\] PAGE https:\/\/firm\.com\/team/.exec(user)![1]],
        targetFields: ['firm_name'], reason: 'r1' } }),
      user => ({ claims: [], action: { type: 'fetch_pages',
        linkIds: [/\[(L-[^\]]+)\] PAGE https:\/\/firm\.com\/team/.exec(user)![1]], targetFields: ['firm_name'], reason: 'retry' } }),
    ]);
    const access = { fetchPages: vi.fn(async (urls: string[]) => ({
      pages: urls.filter(url => url.endsWith('/about')).map(url => ({ url, html: '', text: 'About Smith Law.' })),
      calls: urls.map(url => url.endsWith('/about')
        ? { tool: 'fetch_pages' as const, target: url, status: 'read' as const, detail: null }
        : { tool: 'fetch_pages' as const, target: url, status: 'failed' as const, detail: 'boom' }) })),
      readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [page], partial: false }, new AbortController().signal);
    expect(access.fetchPages).toHaveBeenCalledTimes(1);
    expect(result.diagnostics).toMatchObject({ rounds: 2, stopReason: 'NO_NEW_EVIDENCE' });
    expect(result.diagnostics.toolCalls).toEqual([
      { round: 1, tool: 'fetch_pages', target: 'https://firm.com/about', status: 'read', detail: null },
      { round: 1, tool: 'fetch_pages', target: 'https://firm.com/team', status: 'failed', detail: 'boom' },
      { round: 2, tool: 'fetch_pages', target: 'https://firm.com/team', status: 'skipped', detail: 'ALREADY_FAILED' },
    ]);
  });

  it('truncates an unbounded unknown link ID before recording it', async () => {
    const longId = `L-${'x'.repeat(100)}`;
    const create = scripted([() => ({ claims: [], action: { type: 'fetch_pages', linkIds: [longId], targetFields: ['attorneys'], reason: 'guess' } })]);
    const access = { fetchPages: vi.fn(), readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false }, new AbortController().signal);
    expect(access.fetchPages).not.toHaveBeenCalled();
    expect(result.diagnostics.toolCalls).toEqual([{ round: 1, tool: 'fetch_pages', target: longId.slice(0, 64), status: 'skipped', detail: 'UNKNOWN_LINK' }]);
  });

  it('extracts again after reading a document even when the crawl repeated a URL', async () => {
    const home = { url: 'https://firm.com/', text: 'Smith Law.', html: '<a href="/policy.pdf">Privacy</a>' };
    const create = scripted([
      user => ({ claims: [], action: { type: 'read_document', linkIds: [/\[(L-[^\]]+)\] DOCUMENT/.exec(user)![1]], targetFields: ['privacy_policy'], reason: 'policy' } }),
      () => ({ claims: [], action: { type: 'finish', reason: 'done' } }),
    ]);
    const access = { fetchPages: vi.fn(), readSitemap: vi.fn(), readDocuments: vi.fn(async (urls: string[]) => ({
      pages: [{ url: urls[0]!, html: '', text: 'Privacy Policy.', kind: 'document' as const, complete: true }],
      calls: [{ tool: 'read_document' as const, target: urls[0]!, status: 'read' as const, detail: 'complete' }] })) };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [home, { ...home }], partial: false }, new AbortController().signal);
    expect(result.diagnostics).toMatchObject({ rounds: 2, stopReason: 'SUFFICIENT_FOR_EXTRACTION' });
  });

  it('shows a fetched page in the next round even when crawled pages fill the corpus', async () => {
    const practice = (n: number) => ({ url: `https://firm.com/practice-${n}`, html: '',
      text: Array.from({ length: 8 }, (_, i) => `Practice ${n} paragraph ${i} ${'detail '.repeat(100)}`).join('\n\n') });
    const home = { url: 'https://firm.com/', html: '<a href="/carmen-gallardo">Carmen Gallardo</a>', text: 'Smith Law.' };
    let secondRound = '';
    const create = scripted([
      user => ({ claims: [], action: { type: 'fetch_pages', linkIds: [/\[(L-[^\]]+)\] PAGE https:\/\/firm\.com\/carmen-gallardo/.exec(user)![1]],
        targetFields: ['attorneys'], reason: 'bio' } }),
      user => { secondRound = user; return { claims: [], action: { type: 'finish', reason: 'done' } }; },
    ]);
    const access = { fetchPages: vi.fn(async (urls: string[]) => ({
      pages: urls.map(url => ({ url, html: '', text: `Carmen Gallardo, Esq. Attorney | Founding Partner. ${'Biography '.repeat(75)}` })),
      calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: 'read' as const, detail: null })) })),
      readDocuments: vi.fn(), readSitemap: vi.fn() };
    const provider = new NvidiaNimEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    await provider.extractDetailed({ pages: [home, ...Array.from({ length: 14 }, (_, n) => practice(n))], partial: false }, new AbortController().signal);
    expect(secondRound).toContain('Founding Partner');
  });

  const finishing = () => vi.fn(async (request: Record<string, unknown>) => {
    const user = (request.messages as Array<{ content: string }>)[1]!.content;
    const content = user.startsWith('CANDIDATE CLAIMS') ? JSON.stringify({ verdicts: [] })
      : JSON.stringify({ claims: [], action: { type: 'finish', reason: 'done' } });
    return { choices: [{ finish_reason: 'stop', message: { content } }] };
  });
  const firstRequest = async (endpoint: (typeof LLM_ENDPOINTS)[keyof typeof LLM_ENDPOINTS], model: string) => {
    const create = finishing();
    const provider = new NvidiaNimEvidenceProvider('key', model, { chat: { completions: { create } } }, undefined, endpoint);
    await provider.extractDetailed({ pages: [{ url: 'https://firm.com/', html: '', text: 'Smith Law.' }], partial: false }, new AbortController().signal);
    return { provider, request: create.mock.calls[0]![0] };
  };

  it('sends only parameters an OpenAI reasoning model accepts', async () => {
    const { provider, request } = await firstRequest(LLM_ENDPOINTS.openai, 'gpt-5.6-luna');
    expect(request).toMatchObject({ model: 'gpt-5.6-luna', max_completion_tokens: expect.any(Number), response_format: { type: 'json_object' } });
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('max_tokens');
    expect(request).not.toHaveProperty('chat_template_kwargs');
    expect(provider.version).toContain('openai:gpt-5.6-luna');
  });

  it('keeps a deterministic temperature for OpenAI models that support it', async () => {
    const { request } = await firstRequest(LLM_ENDPOINTS.openai, 'gpt-4.1-mini');
    expect(request).toMatchObject({ model: 'gpt-4.1-mini', temperature: 0, max_completion_tokens: expect.any(Number) });
    expect(request).not.toHaveProperty('chat_template_kwargs');
  });

  it('keeps the NIM request profile by default', async () => {
    const { provider, request } = await firstRequest(LLM_ENDPOINTS.nvidia, 'z-ai/glm-5.3-flash');
    expect(request).toMatchObject({ temperature: 0, max_tokens: 8000, chat_template_kwargs: { enable_thinking: false } });
    expect(provider.id).toBe('nvidia-nim');
  });
});
