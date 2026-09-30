import { domainToASCII } from 'node:url';
import type { DomainResolution, DomainResolver } from '@arca/contracts';
import { assertPublicUrl } from './network.js';

// Identity resolution only. This list never enters scoring or multiplier inputs.
export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com',
]);
export function normalizeDomain(value: string): string {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    const host = domainToASCII(url.hostname).toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : '';
  } catch { return ''; }
}
export class PublicDomainResolver implements DomainResolver {
  constructor(private readonly checkPublic: (url: string) => Promise<void> = assertPublicUrl) {}
  async resolve(input: { domain?: string; email: string }): Promise<DomainResolution> {
    const source = input.domain !== undefined ? 'request' as const : 'email' as const;
    const candidate = source === 'request' ? input.domain! : input.email.slice(input.email.lastIndexOf('@') + 1);
    const canonicalDomain = normalizeDomain(candidate);
    if (!canonicalDomain) return { status: 'UNRESOLVED', canonicalDomain: null, source, reason: 'INVALID_DOMAIN' };
    // A mail provider is never a firm, whether it came from the email or was typed in as the website.
    if (PERSONAL_EMAIL_DOMAINS.has(canonicalDomain)) {
      return { status: 'UNRESOLVED', canonicalDomain: null, source, reason: 'PERSONAL_EMAIL' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.checkPublic(`https://${canonicalDomain}`),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Domain resolution timed out')), 3000); })]);
      return { status: 'RESOLVED', canonicalDomain, source, reason: null };
    } catch { return { status: 'UNRESOLVED', canonicalDomain: null, source, reason: 'DOMAIN_UNAVAILABLE' }; }
    finally { clearTimeout(timer); }
  }
}
