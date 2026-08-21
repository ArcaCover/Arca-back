import type { FetchedPage, PageFetcher } from '../page-fetcher.js';

/** Subpáginas candidatas del handbook, agrupadas por lo que aportan al análisis. */
export const CANDIDATE_PATHS = [
  '/about',
  '/our-team',
  '/attorneys',
  '/lawyers',
  '/people',
  '/practice-areas',
  '/services',
  '/areas-of-practice',
  '/ai',
  '/ai-policy',
  '/ai-governance',
  '/technology',
  '/blog',
  '/news',
  '/insights',
];

/** Tope de páginas por scan: acota el tiempo del paso más caro del pipeline. */
export const MAX_PAGES = 10;

/** La home es lo único imprescindible, así que se lleva como mucho dos tercios del presupuesto. */
export const HOME_TIMEOUT_RATIO = 2 / 3;

/** Piso de tiempo para las subpáginas: por debajo de esto no vale la pena ni intentarlas. */
export const MIN_SUBPAGE_MS = 1_000;

export type ScrapeResult = {
  website_found: boolean;
  pages: FetchedPage[];
};

/** Normaliza un dominio suelto a una URL https absoluta. */
export function toBaseUrl(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Links internos de la home que coinciden con las rutas candidatas, sin duplicar. */
export function candidateUrls(base: string, homeHtml: string): string[] {
  const origin = new URL(base).origin;
  const found = new Set<string>();

  for (const match of homeHtml.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue; // href malformado: se ignora en vez de romper el scan
    }
    if (resolved.origin !== origin) continue;
    const path = resolved.pathname.replace(/\/+$/, '').toLowerCase();
    if (CANDIDATE_PATHS.includes(path)) found.add(`${origin}${path}`);
  }

  // Las rutas que no estaban linkeadas se prueban igual: muchos sitios no las exponen en el menú.
  for (const path of CANDIDATE_PATHS) {
    if (found.size >= MAX_PAGES - 1) break;
    found.add(`${origin}${path}`);
  }
  return [...found].slice(0, MAX_PAGES - 1);
}

/**
 * Descarga la home y las subpáginas candidatas dentro de su propio presupuesto. Devuelve lo que
 * haya conseguido: quedarse sin tiempo baja la confianza del scan, nunca lo tira entero.
 */
export async function scrapeSite(
  fetcher: PageFetcher,
  domain: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<ScrapeResult> {
  const base = toBaseUrl(domain);
  const deadline = now() + budgetMs;

  let home: FetchedPage;
  try {
    home = await fetcher.fetch(base, Math.round(budgetMs * HOME_TIMEOUT_RATIO));
  } catch {
    return { website_found: false, pages: [] };
  }
  // Un 4xx/5xx en la home cuenta como sitio no encontrado: no hay contenido que analizar.
  if (home.status >= 400 || home.text.length === 0) return { website_found: false, pages: [] };

  const remaining = deadline - now();
  if (remaining < MIN_SUBPAGE_MS) return { website_found: true, pages: [home] };

  // Las subpáginas van en paralelo y comparten el tiempo que sobró; las que no llegan se descartan.
  const settled = await Promise.allSettled(
    candidateUrls(base, home.html).map((url) => fetcher.fetch(url, remaining)),
  );
  const pages = settled
    .filter(
      (r): r is PromiseFulfilledResult<FetchedPage> =>
        r.status === 'fulfilled' && r.value.status < 400 && r.value.text.length > 0,
    )
    .map((r) => r.value);

  return { website_found: true, pages: [home, ...pages] };
}
