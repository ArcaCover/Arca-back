import { describe, expect, it, vi } from 'vitest';
import { AgenticEvidenceProvider } from '../../src/pipeline/agentic-evidence-provider.js';

const reply = (body: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(body) } }] });

describe('agentic page plan', () => {
  it('classifies pages, reads the team page before the first round and derives team quality instead of trusting the model', async () => {
    const home = { url: 'https://firm.com/', text: 'Smith Law is a law firm.',
      html: '<title>Smith Law</title><a href="/our-lawyers">Our lawyers</a><a href="/privacy.pdf">Privacy</a>' };
    const team = { url: 'https://firm.com/our-lawyers', text: 'Jane Doe\nLawyer\nJohn Roe\nLawyer',
      html: '<a href="/jane-doe">Jane Doe</a><a href="/john-roe">John Roe</a>' };
    const classifications: string[] = [];
    let firstExtraction = '';
    const create = vi.fn(async (request: Record<string, unknown>) => {
      const [system, user] = (request.messages as Array<{ content: string }>).map(message => message.content) as [string, string];
      if (system.startsWith('Classify pages')) {
        classifications.push(user);
        const pages = [...user.matchAll(/\[(C\d+)\] (?:PAGE|DOCUMENT) (?:READ|LINK) (\S+)/g)].map(([, id, url]) =>
          ({ id, type: url!.endsWith('/our-lawyers') ? 'team' : url!.endsWith('.pdf') ? 'privacy' : 'other' }));
        return reply({ pages });
      }
      if (user.startsWith('CANDIDATE CLAIMS')) {
        const claims = JSON.parse(user.slice('CANDIDATE CLAIMS\n'.length, user.indexOf('\n\nSNAPSHOT'))) as Array<{ id: string; citations: unknown[] }>;
        return reply({ verdicts: claims.map(claim => ({ claimId: claim.id, verdict: 'supported', reason: 'listed', citations: claim.citations })) });
      }
      const segmentId = /\[(D-[^\]]+)\] URL=https:\/\/firm\.com\/our-lawyers/.exec(user)?.[1] ?? '';
      if (system.includes('This pass is only for attorneys')) {
        const person = (name: string) => ({ id: `att-${name}`, field: 'attorneys', explanation: 'listed as lawyer',
          value: [{ full_name: name, title: 'Lawyer', role: 'attorney', affiliation: 'current' }], citations: [{ segmentId, quote: `${name}\nLawyer` }] });
        return reply({ claims: [person('Jane Doe'), person('John Roe')], action: { type: 'finish', reason: 'done' } });
      }
      firstExtraction ||= user;
      return reply({ claims: [{ id: 'team', field: 'team_page_quality', value: 'names_only', explanation: 'names only',
        citations: [{ segmentId, quote: 'Jane Doe' }] }], action: { type: 'finish', reason: 'done' } });
    });
    const access = {
      fetchPages: vi.fn(async (urls: string[]) => ({ pages: urls.filter(url => url === team.url).map(() => team),
        calls: urls.map(target => ({ tool: 'fetch_pages' as const, target, status: 'read' as const, detail: null })) })),
      readDocuments: vi.fn(async (urls: string[]) => ({ pages: [],
        calls: urls.map(target => ({ tool: 'read_document' as const, target, status: 'failed' as const, detail: 'HTTP_ERROR' })) })),
      readSitemap: vi.fn(),
    };
    const provider = new AgenticEvidenceProvider('key', undefined, { chat: { completions: { create } } }, access as never);
    const result = await provider.extractDetailed({ pages: [home], partial: false }, new AbortController().signal);
    expect(classifications).toHaveLength(3);
    expect(access.fetchPages).toHaveBeenCalledWith(['https://firm.com/our-lawyers'], expect.anything());
    expect(access.readDocuments).toHaveBeenCalledWith(['https://firm.com/privacy.pdf'], expect.anything());
    expect(result.diagnostics.toolCalls[0]).toMatchObject({ round: 0, tool: 'fetch_pages', target: 'https://firm.com/our-lawyers', status: 'read' });
    expect(firstExtraction).toContain('Jane Doe');
    expect(result.websiteData.team_members?.map(member => member.full_name).sort()).toEqual(['Jane Doe', 'John Roe']);
    expect(result.websiteData.team_page_quality).toBe('detailed');
  });
});
