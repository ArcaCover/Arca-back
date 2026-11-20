import { describe, expect, it, vi } from 'vitest';
import { unknownAttorney, unknownWebsite, type Attorney, type AttorneyMatch, type DirectorySource } from '@arca/contracts';
import { BAR_FIRM_EMAIL_KEY } from '@arca/scoring';
import { barFirmEmails } from '../../src/pipeline/directories.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

// Florida Bar actor rows as the actor returns them (fields trimmed to the ones read here). Synthetic people and addresses.
const profile = (barNumber: string) => `https://www.floridabar.org/directories/find-mbr/profile/?num=${barNumber}`;
const row = (name: string, barNumber: string, email: string | null, extra: Record<string, unknown> = {}) => ({ name, barNumber,
  email, profileUrl: profile(barNumber), status: 'Member in Good Standing', ...extra });
const raw = (queries: Array<{ target: string; items: unknown[] | null }>) => JSON.stringify({ queries, providerRuns: [] });
const candidate = (name: string, barNumber: string, fields: Partial<Attorney> = {}): Attorney =>
  ({ ...unknownAttorney(name), barNumber, profileUrl: profile(barNumber), barStatus: 'active', ...fields });

describe('Bar records whose email is at the firm\'s own domain', () => {
  const content = raw([{ target: 'Mason Fox', items: [row('Mason Hollister Fox', '800001', 'mfox@wealth.example'),
    row('Mason Kevin Fox', '800003', 'MFox@HarborLemon.Example'), row('Mason James Fox', '800002', null)] },
  { target: 'Jordan Hale', items: [row('Jordan S. Hale', '800010', 'jordan@harborlemon.example.attacker.example')] },
  { target: 'Nobody', items: null }]);
  const ambiguous: AttorneyMatch = { searchedName: 'Mason Fox', matchConfidence: 'no_match', ambiguous: true, attorney: null,
    candidates: [candidate('Mason Hollister Fox', '800001'), candidate('Mason Kevin Fox', '800003'), candidate('Mason James Fox', '800002')] };

  it('names the profiles at the firm\'s domain, compared on the domain only and never on the address', () => {
    const found = barFirmEmails(content, [ambiguous, { searchedName: 'Jordan Hale', matchConfidence: 'exact', ambiguous: false,
      attorney: candidate('Jordan S. Hale', '800010') }], 'harborlemon.example');
    expect(found).toEqual([{ sourceUrl: profile('800003'), excerpt: 'harborlemon.example', method: 'provider' }]);
    expect(JSON.stringify(found)).not.toContain('@');
    // A www. domain is the same firm.
    expect(barFirmEmails(content, [ambiguous], 'www.harborlemon.example')).toHaveLength(1);
  });

  it('says nothing of a profile no match or candidate names, or of an answer it cannot read', () => {
    expect(barFirmEmails(content, [], 'harborlemon.example')).toEqual([]);
    expect(barFirmEmails(content, null, 'harborlemon.example')).toEqual([]);
    expect(barFirmEmails(null, [ambiguous], 'harborlemon.example')).toEqual([]);
    expect(barFirmEmails('not json', [ambiguous], 'harborlemon.example')).toEqual([]);
  });
});

describe('the pipeline hands the Bar email ties to scoring', () => {
  const website = { run: async () => ({ data: { ...unknownWebsite(), firm_name: 'Harbor Lemon Partners',
    team_members: [{ full_name: 'Mason Fox', title: 'Attorney' }] }, rawContent: '{}',
    status: { status: 'ok' as const, dataStatus: 'PRESENT' as const, durationMs: 0, pagesCrawled: 1 } }) };
  const namesakes = [candidate('Mason Hollister Fox', '800001', { firmName: 'Focus Partners Wealth', admissionDate: '2013-04-18' }),
    candidate('Mason Kevin Fox', '800003', { firmName: 'Brooks, LeBoeuf, Fox, P.A.', admissionDate: '1994-09-21' })];
  const bar = (email: string): DirectorySource => ({ jurisdiction: 'FL', run: async () => ({
    data: [{ searchedName: 'Mason Fox', matchConfidence: 'no_match', ambiguous: true, attorney: null, candidates: namesakes }],
    rawContent: raw([{ target: 'Mason Fox', items: [row('Mason Hollister Fox', '800001', 'm@wealth.example'),
      row('Mason Kevin Fox', '800003', email)] }]),
    status: { status: 'ok', dataStatus: 'EMPTY', durationMs: 0, attorneysSearched: 1, attorneysFound: 0 } }) });
  const avvo: DirectorySource = { run: async () => ({ data: [], rawContent: null,
    status: { status: 'ok', dataStatus: 'EMPTY', durationMs: 0, attorneysSearched: 1, attorneysFound: 0 } }) };
  const scan = (email: string) => new InProcessPipeline({ repository: new InMemoryRepository(), website, bar: bar(email), avvo })
    .run({ scanId: 'sc_email', canonicalDomain: 'harborlemon.example', email: 'owner@harborlemon.example' });

  it('accepts the one namesake whose Bar email is at the firm\'s domain, and logs no address', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { result } = await scan('mason@harborlemon.example');
    expect(result.signals.bar.attorneys?.[0]).toMatchObject({ matchConfidence: 'cross_ref', attorney: { barNumber: '800003' } });
    expect(log.mock.calls.flat().join(' ')).not.toContain('mason@');
    expect(JSON.stringify(result)).not.toContain('mason@harborlemon.example');
    log.mockRestore();
  });

  it('leaves the lookup ambiguous when the email is elsewhere', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { result } = await scan('mason@kevinfoxlaw.example');
    expect(result.signals.bar.attorneys?.[0]).toMatchObject({ attorney: null, ambiguous: true });
    log.mockRestore();
  });

  it('keeps the key out of the stored website record', async () => {
    const repository = new InMemoryRepository();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new InProcessPipeline({ repository, website, bar: bar('mason@harborlemon.example'), avvo })
      .run({ scanId: 'sc_email', canonicalDomain: 'harborlemon.example', email: 'owner@harborlemon.example' });
    log.mockRestore();
    expect(repository.raw.find(record => record.source === 'website')?.raw_content).not.toContain(BAR_FIRM_EMAIL_KEY);
  });
});
