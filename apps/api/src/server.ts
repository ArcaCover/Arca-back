import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { createApp } from './http/app.js';
import { NoopMemoryStore } from './memory/noop-memory-store.js';
import { InProcessPipeline } from './pipeline/in-process-pipeline.js';
import { PlaywrightPageFetcher } from './pipeline/page-fetcher.js';
import { NodeDnsLookup } from './pipeline/steps/dns.js';
import { createSupabaseClient, createSupabaseRepositories } from './repositories/supabase.js';

const env = loadEnv();

// El MemoryStore se inyecta desde acá: el pipeline nunca elige su propia implementación.
const memoryStore = new NoopMemoryStore(
  env.NODE_ENV === 'development' ? (message) => console.log(message) : undefined,
);

const pipeline = new InProcessPipeline({
  fetcher: new PlaywrightPageFetcher(),
  dns: new NodeDnsLookup(),
  memoryStore,
});

const app = createApp({
  pipeline,
  repositories: createSupabaseRepositories(
    createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  ),
  sessionSecret: env.SESSION_TOKEN_SECRET,
  corsOrigins: env.corsOrigins,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port}`);
});

/** Cierre ordenado: hay un browser de Playwright que hay que apagar. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
