import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { WebsiteData, AttorneyMatch, SourceStatus, type WebsiteSource, type DirectorySource, type SourceResult } from '@arca/contracts';

export const MOCK_DOMAINS = ['robust.arca.example', 'minimal.arca.example', 'sanctioned.arca.example',
  'partial.arca.example', 'failed.arca.example'] as const;
const Scenario = z.object({ website: WebsiteData.nullable(), bar: z.array(AttorneyMatch).nullable(),
  avvo: z.array(AttorneyMatch).nullable(), sources: z.object({ website: SourceStatus, bar: SourceStatus, avvo: SourceStatus }) });
async function load(domain: string) {
  if (!(MOCK_DOMAINS as readonly string[]).includes(domain)) throw new Error('Unknown mock domain');
  const name = domain.split('.')[0]!;
  const raw = await readFile(new URL(`../../mocks/${name}.json`, import.meta.url), 'utf8');
  return Scenario.parse(JSON.parse(raw.replaceAll('$RECENT_SANCTION_DATE', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))));
}
export function mockSources(): { website: WebsiteSource; bar: DirectorySource; avvo: DirectorySource } {
  const directory = (source: 'bar' | 'avvo'): DirectorySource => ({
    ...(source === 'bar' ? { jurisdiction: 'FL' } : {}), run: async (query, signal) => {
    signal.throwIfAborted(); const scenario = await load(query.canonicalDomain);
    return { data: scenario[source], rawContent: JSON.stringify(scenario[source]), status: scenario.sources[source] };
  } });
  return {
    website: { run: async (domain, signal) => {
      signal.throwIfAborted(); const scenario = await load(domain);
      return { data: scenario.website, rawContent: JSON.stringify(scenario.website), status: scenario.sources.website };
    } },
    bar: directory('bar'), avvo: directory('avvo'),
  };
}
