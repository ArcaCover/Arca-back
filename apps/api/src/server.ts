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
import { LLM_ENDPOINTS } from './pipeline/llm-endpoint.js';
import { ApifyClient } from './pipeline/apify-client.js';
import { ApifyDirectorySource } from './pipeline/directories.js';
import { PublicDomainResolver } from './pipeline/domain-resolution.js';
import { mockSources, MOCK_DOMAINS } from './pipeline/mock-sources.js';

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
const env = loadEnv();
const repository = env.storageBackend === 'memory' ? new InMemoryRepository() : createRepository(env.SUPABASE_URL!, env.supabaseKey!);
await repository.recoverInterrupted(new Date(Date.now() - 60_000).toISOString());
const websiteEvidenceProvider = env.sourceMode === 'mock' ? null : env.WEBSITE_EVIDENCE_PROVIDER === 'openai'
  ? new OpenAIEvidenceProvider(env.OPENAI_API_KEY!) : env.WEBSITE_EVIDENCE_PROVIDER === 'rules'
    ? new RuleBasedEvidenceProvider() : new NvidiaNimEvidenceProvider(
      env.SIGNAL_LLM_ENDPOINT === 'openai' ? env.OPENAI_API_KEY! : env.NVIDIA_NIM_API_KEY!, env.signalModel, undefined, undefined,
      LLM_ENDPOINTS[env.SIGNAL_LLM_ENDPOINT]);
const apify = env.sourceMode === 'live' ? new ApifyClient(env.APIFY_API_TOKEN!, fetch, env.MAX_APIFY_CONCURRENCY) : null;
const sources = env.sourceMode === 'mock' ? mockSources() : {
  website: new WebsiteExtractionSource(repository, websiteEvidenceProvider!),
  bar: new ApifyDirectorySource('bar', apify!),
  avvo: new ApifyDirectorySource('avvo', apify!),
};
const domainResolver = env.sourceMode === 'mock' ? new PublicDomainResolver(async url => {
  if (!(MOCK_DOMAINS as readonly string[]).includes(new URL(url).hostname)) throw new Error('Unknown mock domain');
}) : new PublicDomainResolver();
const clientIps = new WeakMap<Request, string>();
const { app, drain } = createApp({ repository, domainResolver, pipeline: new InProcessPipeline({ ...sources, repository }),
  sessionSecret: env.SESSION_TOKEN_SECRET, corsOrigins: env.corsOrigins,
  clientIp: request => clientIps.get(request) ?? 'unknown' });
const server = serve({ port: env.PORT, fetch: (request, bindings) => {
  const connection = bindings as HttpBindings;
  const remote = connection.incoming.socket.remoteAddress ?? 'unknown';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  clientIps.set(request, env.TRUST_PROXY_HOPS > 0 ? [...forwarded, remote].at(-(env.TRUST_PROXY_HOPS + 1)) ?? remote : remote);
  return app.fetch(request);
} }, info => console.log(`[api] sources=${env.sourceMode} storage=${env.storageBackend} on port ${info.port}`));
const recoverTimer = setInterval(() => {
  void repository.recoverInterrupted(new Date(Date.now() - 120_000).toISOString()).catch(() => console.error('[api] recovery failed'));
}, 60_000);
recoverTimer.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(recoverTimer);
  server.close();
  const shutdownTimer = setTimeout(() => process.exit(1), 60_000);
  shutdownTimer.unref();
  void drain().finally(() => { clearTimeout(shutdownTimer); process.exit(0); });
});
