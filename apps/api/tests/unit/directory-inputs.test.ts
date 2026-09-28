import { expect, it } from 'vitest';
import { buildDirectoryInputs } from '../../src/pipeline/directories.js';

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
