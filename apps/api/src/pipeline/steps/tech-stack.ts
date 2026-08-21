import type { LegalPlatform } from '@arca/contracts';
import type { FetchedPage } from '../page-fetcher.js';

/**
 * Fingerprints al estilo Wappalyzer para las plataformas legales del handbook. Se detectan
 * sobre el HTML y los headers, sin depender del paquete npm de Wappalyzer, que ya no se mantiene.
 */
const PLATFORM_FINGERPRINTS: Array<{
  platform: LegalPlatform;
  html: RegExp[];
  headers?: RegExp[];
}> = [
  {
    platform: 'clio',
    html: [
      /clio\.com/i,
      /app\.goclio\.(?:com|eu)/i,
      /grow\.clio\.com/i,
      /clio[-_]?(?:grow|manage|scheduler)/i,
    ],
    headers: [/clio/i],
  },
  {
    platform: 'practicepanther',
    html: [/practicepanther\.com/i, /practice[-_]?panther/i],
  },
  {
    platform: 'mycase',
    html: [/mycase\.com/i, /\bmycase[-_]?(?:widget|intake|form)\b/i],
  },
];

/** Otras tecnologías cloud que justifican preguntar por residencia de datos. */
const CLOUD_FINGERPRINTS = [
  /hubspot/i,
  /salesforce/i,
  /\.amazonaws\.com/i,
  /\.azurewebsites\.net/i,
  /googleapis\.com/i,
  /cloudflare/i,
  /wixstatic\.com/i,
  /squarespace/i,
];

export type TechStackAnalysis = {
  legal_platform: LegalPlatform | null;
  cloud_tools_detected: boolean;
};

/** Concatena HTML y headers en un solo corpus buscable. */
function corpusOf(pages: FetchedPage[]): string {
  return pages
    .map((page) => `${page.html} ${Object.entries(page.headers).map(([k, v]) => `${k}:${v}`).join(' ')}`)
    .join(' ');
}

export function analyzeTechStack(pages: FetchedPage[]): TechStackAnalysis {
  const corpus = corpusOf(pages);

  const match = PLATFORM_FINGERPRINTS.find(
    (f) => f.html.some((r) => r.test(corpus)) || (f.headers?.some((r) => r.test(corpus)) ?? false),
  );

  return {
    legal_platform: match?.platform ?? null,
    // Una plataforma legal ya es SaaS, así que cuenta como herramienta cloud.
    cloud_tools_detected: match !== undefined || CLOUD_FINGERPRINTS.some((r) => r.test(corpus)),
  };
}
