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
