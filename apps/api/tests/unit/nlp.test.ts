import { describe, expect, it } from 'vitest';
import {
  analyzeContent,
  countAttorneys,
  countOccurrences,
  detectPracticeAreas,
} from '../../src/pipeline/steps/nlp.js';
import { analyzeTechStack } from '../../src/pipeline/steps/tech-stack.js';
import { htmlToText, type FetchedPage } from '../../src/pipeline/page-fetcher.js';
import { bareDomain } from '../../src/pipeline/steps/dns.js';
import { candidateUrls, toBaseUrl } from '../../src/pipeline/steps/scrape.js';

/** Construye una página como la devolvería el fetcher, con texto ya extraído del HTML. */
function pageOf(path: string, html: string, headers: Record<string, string> = {}): FetchedPage {
  return {
    url: `https://firm.com${path}`,
    status: 200,
    html,
    text: htmlToText(html),
    headers,
  };
}

describe('conteo de términos', () => {
  it('exige límites de palabra', () => {
    // "first", "chairs" y "affairs" contienen "irs" y no deben contar como menciones al IRS.
    expect(countOccurrences('the first chairs of foreign affairs', 'irs')).toBe(0);
    expect(countOccurrences('we litigate against the irs every year', 'irs')).toBe(1);
  });

  it('cuenta todas las apariciones de un término compuesto', () => {
    expect(countOccurrences('personal injury and personal injury again', 'personal injury')).toBe(2);
  });

  it('no rompe con caracteres especiales de regex', () => {
    expect(countOccurrences('mergers (and) acquisitions', '(and)')).toBe(1);
  });
});

describe('detección de áreas de práctica', () => {
  it('no confunde una firma de personal injury con una fiscal', () => {
    // Antes del arreglo, "first" activaba la keyword "irs" y ganaba tax_regulatory.
    const page = pageOf(
      '/practice-areas',
      `<p>The first choice for personal injury claims: car accident, wrongful death and
       medical malpractice cases across the state.</p>`,
    );
    const { primary_practice } = detectPracticeAreas([page]);
    expect(primary_practice).toBe('personal_injury');
  });

  it('prioriza el área con más keywords distintas sobre una repetida', () => {
    const page = pageOf(
      '/services',
      `<p>Divorce, divorce, divorce, divorce and divorce.
       Criminal defense, felony charges, misdemeanor charges and DUI representation.</p>`,
    );
    const { primary_practice, practice_areas } = detectPracticeAreas([page]);
    expect(primary_practice).toBe('criminal_defense');
    expect(practice_areas).toContain('family_law');
  });

  it('devuelve null cuando no hay evidencia de ningún área', () => {
    const { primary_practice, practice_areas } = detectPracticeAreas([
      pageOf('/', '<p>Welcome to our website.</p>'),
    ]);
    expect(primary_practice).toBeNull();
    expect(practice_areas).toEqual([]);
  });

  it('prefiere las páginas de servicios cuando existen', () => {
    const pages = [
      pageOf('/', '<p>Immigration, visa, green card, asylum and deportation defense.</p>'),
      pageOf('/practice-areas', '<p>Real estate, zoning, landlord disputes and title insurance.</p>'),
    ];
    expect(detectPracticeAreas(pages).primary_practice).toBe('real_estate');
  });
});

describe('conteo de abogados', () => {
  it('usa la declaración explícita del sitio', () => {
    expect(countAttorneys([pageOf('/about', '<p>Our team of 24 attorneys serves the region.</p>')])).toBe(24);
    expect(countAttorneys([pageOf('/about', '<p>More than 120 lawyers nationwide.</p>')])).toBe(120);
  });

  it('cae a contar títulos en la página de equipo', () => {
    const team = pageOf(
      '/attorneys',
      `<ul><li>A — Managing Partner</li><li>B — Partner</li><li>C — Associate</li></ul>`,
    );
    expect(countAttorneys([team])).toBe(3);
  });

  it('devuelve null si no hay ninguna señal de tamaño', () => {
    expect(countAttorneys([pageOf('/', '<p>Contact us today.</p>')])).toBeNull();
  });
});

describe('detección de policy de IA', () => {
  const longPolicy = `<h1>AI Governance</h1><p>${'responsible ai governance for our attorneys. '.repeat(40)}</p>`;

  it('exige una sección sustancial, no una mención suelta', () => {
    const brief = analyzeContent([pageOf('/ai', '<p>We have an AI governance policy.</p>')]);
    expect(brief.ai_policy_found).toBe(false);

    const substantial = analyzeContent([pageOf('/ai-governance', longPolicy)]);
    expect(substantial.ai_policy_found).toBe(true);
    expect(substantial.ai_policy_url).toContain('/ai-governance');
  });

  it('marca ai_in_services solo desde páginas de servicios', () => {
    const onlyBlog = analyzeContent([pageOf('/blog', '<p>AI-powered research is changing law.</p>')]);
    expect(onlyBlog.ai_in_services).toBe(false);
    expect(onlyBlog.blog_ai_content).toBe(true);

    const services = analyzeContent([pageOf('/services', '<p>AI-powered document review.</p>')]);
    expect(services.ai_in_services).toBe(true);
  });
});

describe('nombre y ubicación de la firma', () => {
  it('saltea títulos genéricos', () => {
    const generic = analyzeContent([
      pageOf('/', '<html><head><title>Homepage | Rivera &amp; Partners</title></head><body>x</body></html>'),
    ]);
    expect(generic.firm_name).toBe('Rivera & Partners');
  });

  it('toma el primer segmento significativo del título', () => {
    const named = analyzeContent([
      pageOf('/', '<html><head><title>Smith &amp; Associates | Miami Attorneys</title></head><body>x</body></html>'),
    ]);
    expect(named.firm_name).toBe('Smith & Associates');
  });

  it('extrae ciudad y estado de un patrón City, ST válido', () => {
    const located = analyzeContent([pageOf('/about', '<p>Our office is in Orlando, FL near downtown.</p>')]);
    expect(located.city).toBe('Orlando');
    expect(located.state).toBe('FL');
  });

  it('ignora pares de mayúsculas que no son estados', () => {
    const bogus = analyzeContent([pageOf('/about', '<p>Serving Madrid, ES since 1998.</p>')]);
    expect(bogus.state).toBeNull();
  });
});

describe('tech stack', () => {
  it('detecta cada plataforma legal por su fingerprint', () => {
    expect(
      analyzeTechStack([pageOf('/', '<script src="https://grow.clio.com/embed.js"></script>')])
        .legal_platform,
    ).toBe('clio');
    expect(
      analyzeTechStack([pageOf('/', '<a href="https://app.practicepanther.com/intake">Intake</a>')])
        .legal_platform,
    ).toBe('practicepanther');
    expect(
      analyzeTechStack([pageOf('/', '<iframe src="https://www.mycase.com/widget"></iframe>')])
        .legal_platform,
    ).toBe('mycase');
  });

  it('no inventa una plataforma cuando no hay señales', () => {
    const result = analyzeTechStack([pageOf('/', '<p>Plain website</p>')]);
    expect(result.legal_platform).toBeNull();
    expect(result.cloud_tools_detected).toBe(false);
  });

  it('marca herramientas cloud también por otros proveedores', () => {
    const result = analyzeTechStack([pageOf('/', '<script src="https://js.hubspot.com/x.js"></script>')]);
    expect(result.legal_platform).toBeNull();
    expect(result.cloud_tools_detected).toBe(true);
  });

  it('mira los headers además del HTML', () => {
    const result = analyzeTechStack([pageOf('/', '<p>x</p>', { 'x-powered-by': 'Clio Grow' })]);
    expect(result.legal_platform).toBe('clio');
  });
});

describe('normalización de URLs', () => {
  it('convierte un dominio suelto en URL https', () => {
    expect(toBaseUrl('firm.com')).toBe('https://firm.com');
    expect(toBaseUrl('http://firm.com/')).toBe('http://firm.com');
  });

  it('limpia el dominio para consultas DNS', () => {
    expect(bareDomain('https://www.Firm.com/about?x=1')).toBe('firm.com');
  });

  it('prioriza los links reales de la home y completa con rutas candidatas', () => {
    const html = '<a href="/attorneys">Team</a><a href="https://other.com/blog">External</a>';
    const urls = candidateUrls('https://firm.com', html);
    expect(urls[0]).toBe('https://firm.com/attorneys');
    expect(urls.every((u) => u.startsWith('https://firm.com'))).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(9);
  });

  it('ignora hrefs malformados sin romper', () => {
    const urls = candidateUrls('https://firm.com', '<a href="ht tp://%%%">bad</a>');
    expect(urls.length).toBeGreaterThan(0);
  });
});
