import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, type HttpBindings } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { createApp } from './http/app.js';
import { InMemoryRepository } from './repositories/in-memory.js';
import { createRepository } from './repositories/supabase.js';
import { InProcessPipeline } from './pipeline/in-process-pipeline.js';
import { WebsiteExtractionSource } from './pipeline/website-source.js';
import { OpenAIEvidenceProvider, RuleBasedEvidenceProvider } from './pipeline/website-evidence-provider.js';
import { NvidiaNimEvidenceProvider } from './pipeline/nvidia-evidence-provider.js';
import { LLM_ENDPOINTS, openAiEndpoint } from './pipeline/llm-endpoint.js';
import { ApifyClient } from './pipeline/apify-client.js';
import { ApifyDirectorySource } from './pipeline/directories.js';
import { PublicDomainResolver } from './pipeline/domain-resolution.js';
import { mockSources, MOCK_DOMAINS } from './pipeline/mock-sources.js';
import { renderPdf } from './report/pdf.js';

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
const env = loadEnv();
const repository = env.storageBackend === 'memory' ? new InMemoryRepository() : createRepository(env.SUPABASE_URL!, env.supabaseKey!);
const interruptedBefore = () => new Date(Date.now() - env.PIPELINE_TIMEOUT_MS - 120_000).toISOString();
await repository.recoverInterrupted(interruptedBefore());
const websiteEvidenceProvider = env.sourceMode === 'mock' ? null : env.WEBSITE_EVIDENCE_PROVIDER === 'openai'
  ? new OpenAIEvidenceProvider(env.OPENAI_API_KEY!) : env.WEBSITE_EVIDENCE_PROVIDER === 'rules'
    ? new RuleBasedEvidenceProvider() : new NvidiaNimEvidenceProvider(
      env.SIGNAL_LLM_ENDPOINT === 'openai' ? env.OPENAI_API_KEY! : env.NVIDIA_NIM_API_KEY!, env.signalModel, undefined, undefined,
      env.SIGNAL_LLM_ENDPOINT === 'openai' ? openAiEndpoint(env.SIGNAL_LLM_REASONING_EFFORT) : LLM_ENDPOINTS.nvidia);
const apify = env.sourceMode === 'live' ? new ApifyClient(env.APIFY_API_TOKEN!, fetch, env.MAX_APIFY_CONCURRENCY, {
  store: repository, build: env.APIFY_ACTOR_BUILD, expectedCostUsdPerRun: env.APIFY_EXPECTED_COST_USD_PER_RUN,
  cacheTtlMs: env.APIFY_QUERY_CACHE_TTL_MS, activeTtlMs: env.APIFY_ACTIVE_RUN_TTL_MS,
  runTimeoutSecs: env.APIFY_RUN_TIMEOUT_SECS,
  maxCachedItems: env.APIFY_MAX_CACHED_ITEMS,
}) : null;
const sources = env.sourceMode === 'mock' ? mockSources() : {
  website: new WebsiteExtractionSource(repository, websiteEvidenceProvider!),
  bar: new ApifyDirectorySource('bar', apify!, { targetedMaxLawyers: env.APIFY_BAR_TARGETED_MAX_RESULTS }),
  avvo: new ApifyDirectorySource('avvo', apify!, { targetedMaxLawyers: env.APIFY_AVVO_TARGETED_MAX_RESULTS }),
};
const domainResolver = env.sourceMode === 'mock' ? new PublicDomainResolver(async url => {
  if (!(MOCK_DOMAINS as readonly string[]).includes(new URL(url).hostname)) throw new Error('Unknown mock domain');
}) : new PublicDomainResolver();
const clientIps = new WeakMap<Request, string>();
const { app, drain } = createApp({ repository, domainResolver,
  pipeline: new InProcessPipeline({ ...sources, repository, timeoutMs: env.PIPELINE_TIMEOUT_MS }),
  sessionSecret: env.SESSION_TOKEN_SECRET, corsOrigins: env.corsOrigins,
  renderReport: renderPdf,
  scanCacheTtlMs: env.SCAN_CACHE_TTL_MS, partialRepairCooldownMs: env.SCAN_PARTIAL_REPAIR_COOLDOWN_MS,
  clientIp: request => clientIps.get(request) ?? 'unknown' });
const server = serve({ port: env.PORT, fetch: (request, bindings) => {
  const connection = bindings as HttpBindings;
  const remote = connection.incoming.socket.remoteAddress ?? 'unknown';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  clientIps.set(request, env.TRUST_PROXY_HOPS > 0 ? [...forwarded, remote].at(-(env.TRUST_PROXY_HOPS + 1)) ?? remote : remote);
  return app.fetch(request);
} }, info => console.log(`[api] sources=${env.sourceMode} storage=${env.storageBackend} on port ${info.port}`));
const recoverTimer = setInterval(() => {
  void repository.recoverInterrupted(interruptedBefore()).catch(() => console.error('[api] recovery failed'));
}, 60_000);
recoverTimer.unref();
// Books what Apify finally charged for each run: the ledger is the only record of directory spend.
const costTimer = apify ? setInterval(() => {
  void apify.reconcileCosts().catch(() => console.error('[api] Apify cost reconciliation failed'));
}, 60_000) : undefined;
costTimer?.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(recoverTimer);
  clearInterval(costTimer);
  server.close();
  const shutdownTimer = setTimeout(() => process.exit(1), 60_000);
  shutdownTimer.unref();
  void drain().finally(() => { clearTimeout(shutdownTimer); process.exit(0); });
});
