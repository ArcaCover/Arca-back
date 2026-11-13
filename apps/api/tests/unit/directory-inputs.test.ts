import { describe, expect, it, vi } from 'vitest';
import { ApifyDirectorySource, AVVO_OFFICE_SAMPLE_MAX_LAWYERS, AVVO_TECHNICAL_MAX_LAWYERS, BAR_MAX_OFFICE_SEARCHES,
  BAR_OFFICE_SAMPLE_MAX_LAWYERS, BAR_TECHNICAL_MAX_LAWYERS, buildDirectoryInputs } from '../../src/pipeline/directories.js';

const query = (names: string[]) => ({ canonicalDomain: 'firm.com', names, firmName: 'Duque Immigration Law, PLLC', city: 'Miami', state: 'FL' as const });

it('searches the Florida Bar with the full first name, which the actor needs to match', () => {
  // Live probe 2026-09-14: firstName "C" returned "No lawyers matched"; "Carlos" returned Carlos Mauricio Duque.
  const inputs = buildDirectoryInputs('bar', query(['Carlos Mauricio Duque', 'Jesús Novo', 'Mariangeli Mercado-Torres']));
  expect(inputs.map(item => [item.target, item.input.firstName, item.input.lastNames])).toEqual([
    ['Carlos Mauricio Duque', 'Carlos', ['Duque']], ['Jesús Novo', 'Jesus', ['Novo']], ['Mariangeli Mercado-Torres', 'Mariangeli', ['Mercado-Torres']]]);
});

it('keeps the firm fallback without person names', () => {
  const [input] = buildDirectoryInputs('bar', query([]));
  expect(input).toMatchObject({ target: 'Duque Immigration Law, PLLC', fallback: true, input: { lastNames: [], firstName: '', firm: 'Duque Immigration Law, PLLC' } });
});

it('keeps recognized surname particles in a Bar lookup', () => {
  const [input] = buildDirectoryInputs('bar', query(['María de la Cruz']));
  expect(input?.input).toMatchObject({ firstName: 'Maria', lastNames: ['De La Cruz'] });
});

// DN-06: "si falta ciudad, evitar expansión nacional automática no presupuestada". The provider
// cap that used to bound it is gone (D8), so the guard has to hold on its own.
it('does not plan a nationwide Avvo firm search when no city was verified', () => {
  expect(buildDirectoryInputs('avvo', { ...query([]), city: null })).toEqual([]);
});

it('keeps the Avvo firm search when a city scopes it', () => {
  const [input] = buildDirectoryInputs('avvo', query([]));
  expect(input).toMatchObject({ fallback: true, input: { searchQueries: ['Duque Immigration Law, PLLC'], cities: ['Miami, FL'] } });
});

it('keeps named Avvo lookups without a city, because the targeted cap bounds each one', () => {
  const [input] = buildDirectoryInputs('avvo', { ...query(['Carlos Mauricio Duque']), city: null });
  expect(input).toMatchObject({ fallback: false, input: { searchQueries: ['Carlos Mauricio Duque'], maxLawyers: 10 } });
  expect(input?.input).not.toHaveProperty('cities');
});

it('scopes the Avvo city to the jurisdiction of the query', () => {
  const [input] = buildDirectoryInputs('avvo', { ...query([]), state: 'GA' });
  expect(input?.input).toMatchObject({ cities: ['Miami, GA'] });
});

describe('Florida Bar search scoped to the firm\'s Florida offices', () => {
  const big = { canonicalDomain: 'bigfirm.com', names: [], firmName: 'Holland & Knight', city: null, state: 'FL' as const };

  it('searches the firm in each Florida office city instead of the whole registry, with a fixed sample per city', () => {
    // Live 2026-11-13: uncapped city searches of hklaw.com charged USD 0.98-1.00 each and were cut by the charge limit
    // (24, 47 and 50 lawyers); a cut dataset is not reused, so every scan paid again and read a different roster.
    // A run that stops at its own maxLawyers ends SUCCEEDED, is cached and reads the same lawyers next time.
    const inputs = buildDirectoryInputs('bar', { ...big, officeCities: ['Miami', 'Tampa'] });
    expect(inputs.map(item => item.target)).toEqual(['Holland & Knight (Miami)', 'Holland & Knight (Tampa)']);
    expect(BAR_OFFICE_SAMPLE_MAX_LAWYERS).toBe(20);
    for (const [index, city] of ['Miami', 'Tampa'].entries()) {
      expect(inputs[index]).toMatchObject({ fallback: true, kind: 'firm', firm: 'Holland & Knight', resultLimit: BAR_OFFICE_SAMPLE_MAX_LAWYERS,
        input: { lastNames: [], firstName: '', firm: 'Holland & Knight', locationType: 'city', locations: [city], maxLawyers: BAR_OFFICE_SAMPLE_MAX_LAWYERS } });
    }
    expect(buildDirectoryInputs('bar', { ...big, officeCities: ['Miami'] }, undefined, 7)[0])
      .toMatchObject({ resultLimit: 7, input: { maxLawyers: 7 } });
  });

  it('keeps the whole registry search uncapped for a firm with no Florida office city (DN-06)', () => {
    expect(buildDirectoryInputs('bar', big)[0]).toMatchObject({ resultLimit: BAR_TECHNICAL_MAX_LAWYERS, input: { maxLawyers: BAR_TECHNICAL_MAX_LAWYERS } });
  });

  it('samples the Avvo firm search when its city came from an office list, and not when the city was verified', () => {
    expect(AVVO_OFFICE_SAMPLE_MAX_LAWYERS).toBe(10);
    expect(buildDirectoryInputs('avvo', { ...big, officeCities: ['Tampa'] })[0])
      .toMatchObject({ resultLimit: AVVO_OFFICE_SAMPLE_MAX_LAWYERS, input: { maxLawyers: AVVO_OFFICE_SAMPLE_MAX_LAWYERS } });
    expect(buildDirectoryInputs('avvo', { ...big, city: 'Miami' })[0])
      .toMatchObject({ resultLimit: AVVO_TECHNICAL_MAX_LAWYERS, input: { maxLawyers: AVVO_TECHNICAL_MAX_LAWYERS } });
  });

  it('caps the number of city searches and keeps the order it was given', () => {
    const inputs = buildDirectoryInputs('bar', { ...big, officeCities: ['Miami', 'Tampa', 'Orlando', 'Jacksonville', 'miami'] });
    expect(inputs).toHaveLength(BAR_MAX_OFFICE_SEARCHES);
    expect(BAR_MAX_OFFICE_SEARCHES).toBe(3);
    expect(inputs.map(item => item.input.locations)).toEqual([['Miami'], ['Tampa'], ['Orlando']]);
  });

  it('uses the offices even when the website named some attorneys', () => {
    const inputs = buildDirectoryInputs('bar', { ...big, names: ['Jane Doe'], officeCities: ['Miami'] });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ fallback: true, input: { locations: ['Miami'] } });
  });

  it('keeps today\'s behaviour when no Florida office city is known', () => {
    expect(buildDirectoryInputs('bar', { ...big, officeCities: [] })).toEqual(buildDirectoryInputs('bar', big));
    expect(buildDirectoryInputs('bar', big)[0]).toMatchObject({ kind: 'firm', input: { firm: 'Holland & Knight' } });
    expect(buildDirectoryInputs('bar', big)[0]!.input).not.toHaveProperty('locations');
    expect(buildDirectoryInputs('bar', { ...big, names: ['Jane Doe'] })[0]).toMatchObject({ kind: 'targeted', fallback: false });
  });

  it('leaves the Avvo plan to names and the verified city, using an office city only when no city was verified', () => {
    expect(buildDirectoryInputs('avvo', { ...big, names: ['Jane Doe'], officeCities: ['Tampa'] })[0])
      .toMatchObject({ kind: 'targeted', input: { searchQueries: ['Jane Doe'] } });
    expect(buildDirectoryInputs('avvo', { ...big, officeCities: ['Tampa'] })[0])
      .toMatchObject({ kind: 'firm', input: { searchQueries: ['Holland & Knight'], cities: ['Tampa, FL'] } });
    expect(buildDirectoryInputs('avvo', { ...big, city: 'Miami', officeCities: ['Tampa'] })[0])
      .toMatchObject({ input: { cities: ['Miami, FL'] } });
  });

  it('keeps every attorney of the firm the city searches return, once, and says which offices it covered', async () => {
    const rows: Record<string, Array<Record<string, unknown>>> = {
      Miami: [{ name: 'Ana Ruiz', firm: 'Holland & Knight LLP', barNumber: '1' }, { name: 'Bob Other', firm: 'Other LLP', barNumber: '2' }],
      Tampa: [{ name: 'Carl Diaz', firm: 'Holland & Knight LLP', barNumber: '3' }, { name: 'Ana Ruiz', firm: 'Holland & Knight LLP', barNumber: '1' }],
      Orlando: [],
    };
    const run = vi.fn(async (_actor: string, input: Record<string, unknown>) => rows[(input.locations as string[])[0]!]!);
    const result = await new ApifyDirectorySource('bar', { run })
      .run({ ...big, officeCities: ['Miami', 'Tampa', 'Orlando', 'Jacksonville'] }, new AbortController().signal);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.data?.map(match => match.attorney?.name)).toEqual(['Ana Ruiz', 'Carl Diaz']);
    expect(result.data?.every(match => match.matchConfidence === 'firm_fallback')).toBe(true);
    expect(result.status).toMatchObject({ status: 'ok', attorneysSearched: null, attorneysFound: 2 });
    expect(result.status.reason).toBe('Firm searched in 3 of its 4 Florida office cities: Miami, Tampa, Orlando; up to 20 lawyers per city');
  });
});
