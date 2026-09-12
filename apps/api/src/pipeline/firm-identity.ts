import { FirmIdentity, type WebsiteData } from '@arca/contracts';
import { stableSample } from '@arca/scoring';

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
