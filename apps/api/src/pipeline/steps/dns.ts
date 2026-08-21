import { Resolver } from 'node:dns/promises';
import type { EmailProvider } from '@arca/contracts';

export type DnsAnalysis = {
  email_provider: EmailProvider | null;
  dmarc_configured: boolean;
};

/** Fingerprints de MX conocidos: identifican al proveedor sin llamar a ninguna API paga. */
const MX_FINGERPRINTS: Array<{ pattern: RegExp; provider: EmailProvider }> = [
  { pattern: /aspmx.*\.google\.com|googlemail\.com/i, provider: 'google' },
  { pattern: /\.outlook\.com|\.protection\.outlook\.com|office365/i, provider: 'microsoft' },
];

/** Puerto de DNS, para poder inyectar respuestas en tests sin tocar la red. */
export interface DnsLookup {
  resolveMx(hostname: string): Promise<Array<{ exchange: string }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

export class NodeDnsLookup implements DnsLookup {
  private readonly resolver = new Resolver();

  resolveMx(hostname: string) {
    return this.resolver.resolveMx(hostname);
  }

  resolveTxt(hostname: string) {
    return this.resolver.resolveTxt(hostname);
  }
}

/** Limpia el dominio de esquema y www para consultarlo tal como está registrado. */
export function bareDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

/**
 * MX → proveedor de email, TXT de _dmarc → política DMARC. Cada consulta falla por separado:
 * un dominio sin MX igual puede tener DMARC, y viceversa.
 */
export async function analyzeDns(lookup: DnsLookup, domain: string): Promise<DnsAnalysis> {
  const host = bareDomain(domain);

  const [mx, dmarc] = await Promise.allSettled([
    lookup.resolveMx(host),
    lookup.resolveTxt(`_dmarc.${host}`),
  ]);

  let email_provider: EmailProvider | null = null;
  if (mx.status === 'fulfilled' && mx.value.length > 0) {
    const exchanges = mx.value.map((r) => r.exchange).join(' ');
    email_provider =
      MX_FINGERPRINTS.find((f) => f.pattern.test(exchanges))?.provider ?? 'other';
  }

  const dmarc_configured =
    dmarc.status === 'fulfilled' &&
    dmarc.value.some((chunks) => chunks.join('').toLowerCase().includes('v=dmarc1'));

  return { email_provider, dmarc_configured };
}
