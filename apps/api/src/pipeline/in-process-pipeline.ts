import type {
  EvidenceItem,
  Layer1Firm,
  Layer1Observations,
  Layer1Pipeline,
  Layer1Result,
  MemoryStore,
  PipelineStep,
} from '@arca/contracts';
import { analyzeContent, type ContentAnalysis } from './steps/nlp.js';
import { analyzeDns, type DnsAnalysis, type DnsLookup } from './steps/dns.js';
import { analyzeTechStack } from './steps/tech-stack.js';
import { buildQuickReport, calculatePreScore } from './steps/pre-score.js';
import { scrapeSite, type ScrapeResult } from './steps/scrape.js';
import type { FetchedPage, PageFetcher } from './page-fetcher.js';

/** Timeout individual de cada paso, según el kickoff. */
export const STEP_TIMEOUT_MS = 15_000;
/** Presupuesto total del scan: pasada esta marca, lo que quede se salta. */
export const GLOBAL_BUDGET_MS = 60_000;

/** Margen sobre el timeout del paso: el scraping ya se autolimita, esto es solo red de seguridad. */
export const SCRAPE_GRACE_MS = 2_000;

/** Bar association: en esta fase se devuelve pendiente, sin scraping automático. */
export const BAR_CHECK_STATUS = 'manual_pending';

export type PipelineDeps = {
  fetcher: PageFetcher;
  dns: DnsLookup;
  /** Se inyecta siempre: el pipeline nunca instancia su propio MemoryStore. */
  memoryStore: MemoryStore;
  stepTimeoutMs?: number;
  globalBudgetMs?: number;
  /** Reloj inyectable para que los tests no dependan del tiempo real. */
  now?: () => number;
};

export type PipelineInput = { domain: string; scan_id?: string };

type StepOutcome<T> = { value: T; step: PipelineStep };

/** Corre un paso con timeout propio; si falla o vence, devuelve el fallback y lo deja registrado. */
async function runStep<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs: number,
  now: () => number,
): Promise<StepOutcome<T>> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('step timeout')), timeoutMs);
    });
    const value = await Promise.race([fn(), timeout]);
    return { value, step: { step: name, status: 'ok', duration_ms: now() - started, error: null } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      value: fallback,
      step: {
        step: name,
        status: message === 'step timeout' ? 'timeout' : 'failed',
        duration_ms: now() - started,
        error: message,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const emptyContent: ContentAnalysis = {
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

/** Evidencia cruda que se entrega al Memory System (hoy no-op). */
function evidenceFrom(
  pages: FetchedPage[],
  dns: DnsAnalysis,
  collected_at: string,
): EvidenceItem[] {
  const pageEvidence: EvidenceItem[] = pages.map((page) => ({
    kind: 'page_text',
    source_url: page.url,
    content: page.text,
    metadata: { status: page.status, html_length: page.html.length },
    collected_at,
  }));

  const dnsEvidence: EvidenceItem[] = [
    {
      kind: 'dns_record',
      source_url: 'dns://mx',
      content: dns.email_provider ?? 'none',
      metadata: { dmarc_configured: dns.dmarc_configured },
      collected_at,
    },
  ];

  return [...pageEvidence, ...dnsEvidence];
}

/**
 * Única implementación de Layer1Pipeline en esta fase. Todo el I/O vive acá adentro: los
 * handlers HTTP hablan solo con la interfaz, así que mover esto a un servicio aparte no los toca.
 */
export class InProcessPipeline implements Layer1Pipeline {
  private readonly stepTimeoutMs: number;
  private readonly globalBudgetMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: PipelineDeps) {
    this.stepTimeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
    this.globalBudgetMs = deps.globalBudgetMs ?? GLOBAL_BUDGET_MS;
    this.now = deps.now ?? Date.now;
  }

  async run(input: PipelineInput): Promise<Layer1Result> {
    const started = this.now();
    const startedIso = new Date(started).toISOString();
    const scanId = input.scan_id ?? 'unassigned';
    const steps: PipelineStep[] = [];

    // Scraping y DNS son independientes: se lanzan juntos y ninguno puede tumbar al otro.
    const [scrape, dns] = await Promise.all([
      runStep<ScrapeResult>(
        'scrape',
        () => scrapeSite(this.deps.fetcher, input.domain, this.stepTimeoutMs, this.now),
        { website_found: false, pages: [] },
        this.stepTimeoutMs + SCRAPE_GRACE_MS,
        this.now,
      ),
      runStep<DnsAnalysis>(
        'dns',
        () => analyzeDns(this.deps.dns, input.domain),
        { email_provider: null, dmarc_configured: false },
        this.stepTimeoutMs,
        this.now,
      ),
    ]);
    steps.push(scrape.step, dns.step);

    const pages = scrape.value.pages;
    const withinBudget = this.now() - started < this.globalBudgetMs;

    // El análisis de contenido es local y barato, pero respeta el presupuesto global igual.
    const content = withinBudget
      ? await runStep<ContentAnalysis>(
          'nlp',
          async () => analyzeContent(pages),
          emptyContent,
          this.stepTimeoutMs,
          this.now,
        )
      : { value: emptyContent, step: skipped('nlp') };
    steps.push(content.step);

    const tech = withinBudget
      ? await runStep(
          'tech_stack',
          async () => analyzeTechStack(pages),
          { legal_platform: null, cloud_tools_detected: false },
          this.stepTimeoutMs,
          this.now,
        )
      : { value: { legal_platform: null, cloud_tools_detected: false }, step: skipped('tech_stack') };
    steps.push(tech.step);

    // Bar association: sin scraping automático en esta fase, se devuelve pendiente.
    steps.push({ step: 'bar_check', status: 'skipped', duration_ms: 0, error: null });

    const observations: Layer1Observations = {
      website_found: scrape.value.website_found,
      pages_scraped: pages.map((p) => p.url),
      ai_policy_found: content.value.ai_policy_found,
      ai_policy_url: content.value.ai_policy_url,
      ai_in_services: content.value.ai_in_services,
      blog_ai_content: content.value.blog_ai_content,
      job_posts_ai: content.value.job_posts_ai,
      legal_platform: tech.value.legal_platform,
      email_provider: dns.value.email_provider,
      dmarc_configured: dns.value.dmarc_configured,
      bar_verified: false,
      bar_check: BAR_CHECK_STATUS,
      cloud_tools_detected: tech.value.cloud_tools_detected,
    };

    const { pre_score, signals } = calculatePreScore(observations, {
      // Sin sitio accesible no chequeamos ninguna señal de contenido.
      website_checked: scrape.value.website_found && content.step.status === 'ok',
      dns_checked: dns.step.status === 'ok' && dns.value.email_provider !== null,
      bar_checked: false,
    });

    const firm: Layer1Firm = {
      name: content.value.firm_name,
      domain: input.domain,
      city: content.value.city,
      state: content.value.state,
      attorneys_count: content.value.attorneys_count,
      practice_areas: content.value.practice_areas,
      primary_practice: content.value.primary_practice,
    };

    const finished = this.now();
    const duration_ms = finished - started;

    // El Memory System recibe la evidencia y el run record desde el día uno, aunque hoy no persista.
    await this.deps.memoryStore.saveEvidence(
      scanId,
      evidenceFrom(pages, dns.value, new Date(finished).toISOString()),
    );
    await this.deps.memoryStore.saveRunRecord(scanId, {
      domain: input.domain,
      pipeline: 'InProcessPipeline',
      started_at: startedIso,
      finished_at: new Date(finished).toISOString(),
      duration_ms,
      steps,
      pre_score: pre_score.value,
      confidence: pre_score.confidence,
      signals_detected: pre_score.signals_detected,
    });

    return {
      domain: input.domain,
      firm,
      pre_score,
      signals,
      observations,
      quick_report: buildQuickReport(signals, observations),
      steps,
      duration_ms,
    };
  }
}

function skipped(step: string): PipelineStep {
  return { step, status: 'skipped', duration_ms: 0, error: 'global budget exhausted' };
}
