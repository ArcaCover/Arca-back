import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, type HttpBindings } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { listenHostname } from './config/mode.js';
import { compose, interruptedBefore } from './compose.js';

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
const env = loadEnv();
const { app, drain, recoverAssessments, repository, apify, banner, clientIps } = await compose(env);
await recoverAssessments();
// The debug modes listen on loopback only; production keeps every interface (DN-09 5.1).
const server = serve({ port: env.PORT, hostname: listenHostname(env.mode), fetch: (request, bindings) => {
  const connection = bindings as HttpBindings;
  const remote = connection.incoming.socket.remoteAddress ?? 'unknown';
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  clientIps.set(request, env.TRUST_PROXY_HOPS > 0 ? [...forwarded, remote].at(-(env.TRUST_PROXY_HOPS + 1)) ?? remote : remote);
  return app.fetch(request);
} }, info => {
  console.log(banner);
  console.log(`[api] listening on ${info.address} port ${info.port}`);
});
const recoverTimer = setInterval(() => {
  void repository.recoverInterrupted(interruptedBefore(env.PIPELINE_TIMEOUT_MS)).catch(() => console.error('[api] recovery failed'));
  void recoverAssessments().catch(() => console.error('[api] assessment recovery failed'));
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
