import { describe, expect, it } from 'vitest';
import { unknownWebsite } from '@arca/contracts';
import { deriveTeamPageQuality, deriveWebsiteQuality } from '../../src/pipeline/derived-signals.js';

const teamUrl = 'https://firm.com/attorneys';
const crawlWith = (html: string, text: string) => ({ partial: false,
  pages: [{ url: 'https://firm.com/', html: '', text: 'Home' }, { url: teamUrl, html, text }] });
const members = (...names: string[]) => names.map(full_name => ({ full_name, title: 'Lawyer' }));

describe('derived team page quality', () => {
  it('calls a team page detailed when most attorneys link to their own profile', () => {
    const crawl = crawlWith('<a href="/carmen-gallardo">Carmen Gallardo</a><a href="/lorena-krewson"><img alt=""></a><a href="/contact">Contact</a>',
      'Carmen Gallardo\nLawyer\nLorena Gaona Krewson\nLawyer\nJane Doe\nLawyer');
    expect(deriveTeamPageQuality(crawl, new Map(), members('Carmen Gallardo', 'Lorena Gaona Krewson', 'Jane Doe')))
      .toMatchObject({ value: 'detailed', members: 3, withProfile: 2, teamPages: [teamUrl] });
  });

  it('counts a biography paragraph on the team page as a profile', () => {
    const bio = `Carlos Mauricio Duque es un abogado licenciado en Florida y Colombia. ${'Representa a clientes ante las cortes de inmigración. '.repeat(6)}`;
    const crawl = { partial: false, pages: [{ url: 'https://firm.com/abogados-de-inmigracion-miami/', html: '',
      text: `CARLOS MAURICIO DUQUE\n${bio}\nNUESTRO EQUIPO\nAndrea Herrera\nCoordinadora` }] };
    expect(deriveTeamPageQuality(crawl, new Map(), members('Carlos Mauricio Duque'))).toMatchObject({ value: 'detailed', withProfile: 1 });
  });

  it('calls a list of names without profiles names_only', () => {
    const crawl = crawlWith('<a href="/contact">Contact</a>', 'Jane Doe\nLawyer\nJohn Roe\nLawyer');
    expect(deriveTeamPageQuality(crawl, new Map(), members('Jane Doe', 'John Roe'))).toMatchObject({ value: 'names_only', withProfile: 0 });
  });

  it('derives nothing without a team page or without attorneys', () => {
    const homeOnly = { partial: false, pages: [{ url: 'https://firm.com/', html: '', text: 'Jane Doe' }] };
    expect(deriveTeamPageQuality(homeOnly, new Map(), members('Jane Doe')).value).toBeNull();
    expect(deriveTeamPageQuality(crawlWith('', 'Team'), new Map(), null).value).toBeNull();
  });
});

describe('derived website quality', () => {
  it('derives website quality from identity, contact, services and team profiles', () => {
    const urls = ['https://firm.com/', 'https://firm.com/contact', 'https://firm.com/civil/breach-of-contract'];
    const types = new Map([['https://firm.com/civil/breach-of-contract', 'services' as const]]);
    const data = { ...unknownWebsite(), firm_name: 'Smith Law' };
    expect(deriveWebsiteQuality(urls, types, data, 'detailed').value).toBe('robust');
    expect(deriveWebsiteQuality(urls, types, data, 'names_only').value).toBe('basic');
    expect(deriveWebsiteQuality(urls.slice(0, 2), new Map(), data, 'detailed').value).toBeNull();
    expect(deriveWebsiteQuality(urls, types, { ...data, firm_name: null }, 'detailed').value).toBeNull();
  });
});
