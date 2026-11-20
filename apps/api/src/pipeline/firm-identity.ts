import { FirmIdentity, type WebsiteData } from '@arca/contracts';
import { FIRM_OFFICE_CITIES_KEY, compareText, stableSample } from '@arca/scoring';

/**
 * Provenance keys the website extraction writes about where to look a firm up (DN-06 §10). They are evidence, not
 * WebsiteData fields: the contract stays as it is (DN-12 D6). Scoring reads only the office cities, to tie a directory
 * record to the firm (DN-12 §15.5).
 * - FLORIDA_OFFICES_KEY: one reference per Florida city the site lists an office in; the excerpt is the city.
 * - LARGE_FIRM_KEY: the site states an attorney count above LARGE_FIRM_ATTORNEYS; the excerpt quotes it.
 * - NEWS_ONLY_TEAM_KEY: every attorney name was cited from news, press or blog pages only.
 */
export const FLORIDA_OFFICES_KEY = FIRM_OFFICE_CITIES_KEY;
export const LARGE_FIRM_KEY = 'large_firm';
export const NEWS_ONLY_TEAM_KEY = 'team_members_news_only';
/** Above this many attorneys a name sample from the website says little about the firm's Florida licences. */
export const LARGE_FIRM_ATTORNEYS = 50;

export function buildFirmIdentity(canonicalDomain: string, website: WebsiteData | null): FirmIdentity {
  const firmName = website?.firm_name?.trim() || null;
  const attorneyNames = stableSample(website?.team_members?.map(person => person.full_name) ?? []);
  const evidenceKeys = ['firm_name', 'team_members', 'city', 'county', 'address_street', 'phone'];
  const evidence = evidenceKeys.flatMap(key => website?.provenance[key] ?? []);
  const status = firmName && attorneyNames.length ? 'VERIFIED' : firmName || attorneyNames.length ? 'PARTIAL' : 'INSUFFICIENT';
  return FirmIdentity.parse({ canonicalDomain, firmName, aliases: website?.firm_aliases ?? [],
    city: website?.city ?? null, county: website?.county ?? null,
    addressStreet: website?.address_street ?? null, phone: website?.phone ?? null,
    attorneyNames, status, evidence });
}

/**
 * The names and the Florida office cities the directories search with (DN-06 §10).
 *
 * The Florida Bar is searched by firm in each Florida office city when the site lists such offices and a name sample
 * is the wrong source: the site states a large attorney count, names no attorney, or names them only in news pages.
 * Names seen only in news pages then feed no lookup at all. Without a Florida office city nothing changes: names are
 * looked up one by one, and a firm without names gets today's firm search.
 */
export function directoryScope(identity: FirmIdentity, website: WebsiteData | null, jurisdiction: string | null):
  { names: string[]; officeCities: string[] } {
  const provenance = website?.provenance ?? {};
  const seen = new Set<string>();
  const cities = jurisdiction !== 'FL' ? [] : (provenance[FLORIDA_OFFICES_KEY] ?? [])
    .map(reference => reference.excerpt?.trim() ?? '').filter(city => {
      const key = city.toLocaleLowerCase();
      if (!city || seen.has(key)) return false;
      seen.add(key); return true;
    });
  // The verified city first: it is where the site places the firm. The rest in a stable order, so a second scan
  // searches the same offices whatever order the pages were read in.
  const home = identity.city?.trim().toLocaleLowerCase();
  cities.sort((a, b) => Number(b.toLocaleLowerCase() === home) - Number(a.toLocaleLowerCase() === home) || compareText(a, b));
  const newsOnly = Boolean(provenance[NEWS_ONLY_TEAM_KEY]?.length);
  const large = Boolean(provenance[LARGE_FIRM_KEY]?.length);
  const byOffice = cities.length > 0 && (large || newsOnly || identity.attorneyNames.length === 0);
  return { names: byOffice && newsOnly ? [] : identity.attorneyNames, officeCities: byOffice ? cities : [] };
}
