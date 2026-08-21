import type { PracticeArea } from '@arca/scoring';
import { decodeEntities, type FetchedPage } from '../page-fetcher.js';

/** Términos que identifican una política de IA publicada. */
const AI_POLICY_TERMS = [
  'artificial intelligence policy',
  'ai use policy',
  'ai usage policy',
  'responsible ai',
  'ai governance',
  'generative ai guidelines',
  'ai acceptable use',
];

/** Términos que indican que la firma promociona IA en sus servicios. */
const AI_SERVICE_TERMS = [
  'ai-powered',
  'ai powered',
  'artificial intelligence',
  'machine learning',
  'ai-assisted',
  'ai assisted',
  'leveraging ai',
  'automated review',
];

/** Una policy real desarrolla el tema; una mención suelta no alcanza. */
const MIN_POLICY_WORDS = 200;

const POLICY_PATHS = ['/ai', '/ai-policy', '/ai-governance', '/technology'];
const SERVICE_PATHS = ['/services', '/practice-areas', '/areas-of-practice'];
const BLOG_PATHS = ['/blog', '/news', '/insights'];
const TEAM_PATHS = ['/our-team', '/attorneys', '/lawyers', '/people', '/about'];

/** Palabras clave por categoría del handbook, usadas para inferir el área de práctica. */
const PRACTICE_KEYWORDS: Record<PracticeArea, string[]> = {
  criminal_defense: ['criminal defense', 'criminal law', 'dui', 'felony', 'misdemeanor', 'white collar'],
  immigration: ['immigration', 'visa', 'green card', 'deportation', 'asylum', 'naturalization'],
  personal_injury: ['personal injury', 'car accident', 'wrongful death', 'medical malpractice', 'slip and fall'],
  family_law: ['family law', 'divorce', 'child custody', 'alimony', 'adoption'],
  commercial_litigation: ['commercial litigation', 'business litigation', 'civil litigation', 'contract dispute'],
  employment_law: ['employment law', 'labor law', 'wrongful termination', 'discrimination', 'wage and hour'],
  corporate_ma: ['corporate law', 'mergers', 'acquisitions', 'securities', 'venture capital', 'business formation'],
  real_estate: ['real estate', 'landlord', 'zoning', 'title insurance', 'property law'],
  tax_regulatory: ['tax law', 'taxation', 'irs', 'regulatory compliance', 'estate planning'],
};

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

export type ContentAnalysis = {
  ai_policy_found: boolean;
  ai_policy_url: string | null;
  ai_in_services: boolean;
  blog_ai_content: boolean;
  job_posts_ai: boolean;
  attorneys_count: number | null;
  practice_areas: PracticeArea[];
  primary_practice: PracticeArea | null;
  firm_name: string | null;
  city: string | null;
  state: string | null;
};

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
};

const matchesPath = (page: FetchedPage, paths: string[]) => paths.includes(pathOf(page.url));

const containsAny = (text: string, terms: string[]) => terms.some((term) => text.includes(term));

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Busca la policy priorizando las páginas dedicadas, pero acepta encontrarla en cualquier otra. */
function findAiPolicy(pages: FetchedPage[]): { found: boolean; url: string | null } {
  const ordered = [...pages].sort((a, b) => {
    const score = (p: FetchedPage) => (matchesPath(p, POLICY_PATHS) ? 0 : 1);
    return score(a) - score(b);
  });

  for (const page of ordered) {
    const text = page.text.toLowerCase();
    if (!containsAny(text, AI_POLICY_TERMS)) continue;
    if (wordCount(page.text) < MIN_POLICY_WORDS) continue;
    return { found: true, url: page.url };
  }
  return { found: false, url: null };
}

/** Cuenta abogados por declaración explícita y, si no la hay, por títulos en la página de equipo. */
export function countAttorneys(pages: FetchedPage[]): number | null {
  for (const page of pages) {
    const declared = page.text.match(
      /\b(?:team|firm|group|staff)\s+of\s+(?:over\s+|more\s+than\s+|nearly\s+)?(\d{1,4})\s+(?:attorneys|lawyers)/i,
    );
    if (declared?.[1]) return Number(declared[1]);

    const inline = page.text.match(/\b(\d{1,4})\+?\s+(?:attorneys|lawyers)\b/i);
    if (inline?.[1]) return Number(inline[1]);
  }

  // Fallback: contar títulos en la página de equipo. Es aproximado y puede sobrecontar menciones.
  const teamPage = pages.find((p) => matchesPath(p, TEAM_PATHS));
  if (!teamPage) return null;
  const titles = teamPage.text.match(
    /\b(?:Managing Partner|Senior Partner|Partner|Associate|Of Counsel|Shareholder)\b/g,
  );
  return titles && titles.length > 0 ? titles.length : null;
}

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/** Cuenta apariciones de un término exigiendo límites de palabra donde el término los admite. */
export function countOccurrences(corpus: string, keyword: string): number {
  const escaped = keyword.replace(REGEX_SPECIAL_CHARS, (char) => `\\${char}`);
  // Sin límites de palabra un término corto como "irs" matchearía dentro de "first". Solo se
  // aplican en los extremos alfanuméricos: un \b junto a un paréntesis nunca matchearía.
  const prefix = /^\w/.test(keyword) ? '\\b' : '';
  const suffix = /\w$/.test(keyword) ? '\\b' : '';
  return corpus.match(new RegExp(`${prefix}${escaped}${suffix}`, 'g'))?.length ?? 0;
}

/**
 * Mapea el contenido a las 9 categorías del handbook. Ordena por cantidad de keywords distintas
 * antes que por ocurrencias: un término repetido en un menú no debería ganarle a un área con
 * evidencia variada, porque el área principal define el multiplier de la prima.
 */
export function detectPracticeAreas(pages: FetchedPage[]): {
  practice_areas: PracticeArea[];
  primary_practice: PracticeArea | null;
} {
  const relevant = pages.filter((p) => matchesPath(p, SERVICE_PATHS) || matchesPath(p, TEAM_PATHS));
  const corpus = (relevant.length > 0 ? relevant : pages).map((p) => p.text.toLowerCase()).join(' ');

  const hits = (Object.entries(PRACTICE_KEYWORDS) as Array<[PracticeArea, string[]]>)
    .map(([area, keywords]) => {
      const counts = keywords.map((keyword) => countOccurrences(corpus, keyword));
      return {
        area,
        distinct: counts.filter((count) => count > 0).length,
        total: counts.reduce((sum, count) => sum + count, 0),
      };
    })
    .filter((hit) => hit.total > 0)
    .sort((a, b) => b.distinct - a.distinct || b.total - a.total);

  return {
    practice_areas: hits.map((hit) => hit.area),
    primary_practice: hits[0]?.area ?? null,
  };
}

/** Segmentos de título que no identifican a nadie y hay que saltear. */
const GENERIC_TITLE_PARTS = ['home', 'homepage', 'welcome', 'index', 'main', 'start'];

/** Nombre de la firma desde el título de la home, salteando los segmentos genéricos. */
function extractFirmName(home: FetchedPage | undefined): string | null {
  if (!home) return null;
  const title = home.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!title) return null;

  // El título sale del HTML crudo, así que hay que decodificar sus entidades a mano.
  const parts = decodeEntities(title)
    .split(/[|–—]|\s-\s/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 1);

  return parts.find((part) => !GENERIC_TITLE_PARTS.includes(part.toLowerCase())) ?? null;
}

/** Ubicación desde el primer patrón "City, ST" que aparezca en el sitio. */
function extractLocation(pages: FetchedPage[]): { city: string | null; state: string | null } {
  for (const page of pages) {
    const match = page.text.match(/\b([A-Z][a-zA-Z.'-]+(?: [A-Z][a-zA-Z.'-]+)?),\s*([A-Z]{2})\b/);
    if (match?.[1] && match[2] && US_STATES.includes(match[2])) {
      return { city: match[1], state: match[2] };
    }
  }
  return { city: null, state: null };
}

/**
 * Análisis por keywords y regex, sin llamadas a modelos. Es la opción MVP del handbook:
 * más barata y determinista, a costa de precisión en menciones ambiguas.
 */
export function analyzeContent(pages: FetchedPage[]): ContentAnalysis {
  if (pages.length === 0) {
    return {
      ai_policy_found: false,
      ai_policy_url: null,
      ai_in_services: false,
      blog_ai_content: false,
      job_posts_ai: false,
      attorneys_count: null,
      practice_areas: [],
      primary_practice: null,
      firm_name: null,
      city: null,
      state: null,
    };
  }

  const policy = findAiPolicy(pages);
  const servicePages = pages.filter((p) => matchesPath(p, SERVICE_PATHS));
  const blogPages = pages.filter((p) => matchesPath(p, BLOG_PATHS));
  const { practice_areas, primary_practice } = detectPracticeAreas(pages);
  const { city, state } = extractLocation(pages);

  return {
    ai_policy_found: policy.found,
    ai_policy_url: policy.url,
    ai_in_services: servicePages.some((p) => containsAny(p.text.toLowerCase(), AI_SERVICE_TERMS)),
    blog_ai_content: blogPages.some((p) => containsAny(p.text.toLowerCase(), AI_SERVICE_TERMS)),
    // No scrapeamos bolsas de trabajo en esta fase, así que la señal queda sin chequear.
    job_posts_ai: false,
    attorneys_count: countAttorneys(pages),
    practice_areas,
    primary_practice,
    firm_name: extractFirmName(pages[0]),
    city,
    state,
  };
}
