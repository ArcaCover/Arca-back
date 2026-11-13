import { describe, expect, it } from 'vitest';
import { unknownWebsite, type WebsiteData } from '@arca/contracts';
import { FLORIDA_OFFICES_KEY, LARGE_FIRM_KEY, NEWS_ONLY_TEAM_KEY, buildFirmIdentity, directoryScope } from '../../src/pipeline/firm-identity.js';

const reference = (sourceUrl: string, excerpt: string) => ({ sourceUrl, excerpt, method: 'page_text' as const });
const site = (overrides: Partial<WebsiteData> = {}, provenance: WebsiteData['provenance'] = {}): WebsiteData =>
  ({ ...unknownWebsite(), firm_name: 'Holland & Knight', ...overrides, provenance: { ...provenance } });
const scope = (website: WebsiteData, jurisdiction: string | null = 'FL') =>
  directoryScope(buildFirmIdentity('bigfirm.com', website), website, jurisdiction);
const offices = { [FLORIDA_OFFICES_KEY]: [reference('https://bigfirm.com/offices/tampa', 'Tampa'),
  reference('https://bigfirm.com/offices/miami', 'Miami'), reference('https://bigfirm.com/offices', 'Tampa')] };
const team = [{ full_name: 'Jane Doe', title: 'Partner' }, { full_name: 'John Roe', title: 'Partner' }];

describe('directory scope', () => {
  it('keeps today\'s behaviour without a Florida office city', () => {
    expect(scope(site({ team_members: team }))).toEqual({ names: ['Jane Doe', 'John Roe'], officeCities: [] });
    expect(scope(site({}, { [LARGE_FIRM_KEY]: [reference('https://bigfirm.com/', 'approximately 2,200 attorneys')] })))
      .toEqual({ names: [], officeCities: [] });
  });

  it('searches the Florida offices of a firm that states a large attorney count, keeping roster names for Avvo', () => {
    const website = site({ team_members: team }, { ...offices, [LARGE_FIRM_KEY]: [reference('https://bigfirm.com/', 'approximately 2,200 attorneys')] });
    expect(scope(website)).toEqual({ names: ['Jane Doe', 'John Roe'], officeCities: ['Miami', 'Tampa'] });
  });

  it('searches the Florida offices instead of names taken only from news pages, and drops those names', () => {
    const website = site({ team_members: team }, { ...offices, [NEWS_ONLY_TEAM_KEY]: [reference('https://bigfirm.com/news/award', 'Jane Doe')] });
    expect(scope(website)).toEqual({ names: [], officeCities: ['Miami', 'Tampa'] });
  });

  it('keeps names taken only from news pages when nothing else exists', () => {
    const website = site({ team_members: team }, { [NEWS_ONLY_TEAM_KEY]: [reference('https://bigfirm.com/news/award', 'Jane Doe')] });
    expect(scope(website)).toEqual({ names: ['Jane Doe', 'John Roe'], officeCities: [] });
  });

  it('scopes a firm search without names to the Florida offices', () => {
    expect(scope(site({}, offices))).toEqual({ names: [], officeCities: ['Miami', 'Tampa'] });
  });

  it('keeps named lookups for a small firm with a roster, even with an office list', () => {
    expect(scope(site({ team_members: team }, offices))).toEqual({ names: ['Jane Doe', 'John Roe'], officeCities: [] });
  });

  it('puts the verified city first, then the others in a stable order', () => {
    const website = site({ city: 'Tampa' }, { [FLORIDA_OFFICES_KEY]: [reference('https://bigfirm.com/o', 'Orlando'),
      reference('https://bigfirm.com/m', 'Miami'), reference('https://bigfirm.com/t', 'tampa')] });
    expect(scope(website).officeCities).toEqual(['tampa', 'Miami', 'Orlando']);
  });

  it('uses no Florida office for a registry of another state', () => {
    expect(scope(site({}, offices), 'GA')).toEqual({ names: [], officeCities: [] });
    expect(scope(site({}, offices), null)).toEqual({ names: [], officeCities: [] });
  });
});
