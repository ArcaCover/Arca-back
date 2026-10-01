import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { crawlWebsite } from '../src/pipeline/crawler.js';
import { AgenticEvidenceProvider, ExtractionFailure } from '../src/pipeline/agentic-evidence-provider.js';
import { DEFAULT_SIGNAL_LLM_MODEL, openAiEndpoint } from '../src/pipeline/llm-endpoint.js';
import { buildFirmIdentity } from '../src/pipeline/firm-identity.js';
import { buildDirectoryInputs } from '../src/pipeline/directories.js';

if (existsSync('.env.local')) loadEnvFile('.env.local');
const key = process.env.OPENAI_API_KEY?.trim();
if (!key) throw new Error('OPENAI_API_KEY is required');
const targets = process.argv.slice(2);
if (!targets.length) throw new Error('Usage: npm run demo:signals -- <domain-or-url> [...]');

const safe = (value: string) => value.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const html = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const json = (value: unknown) => JSON.stringify(value, null, 2);

for (const target of targets) {
  const url = /^[a-z]+:\/\//i.test(target) ? new URL(target) : new URL(`https://${target}/`);
  const domain = url.hostname.replace(/^www\./, '');
  const output = resolve('output', 'demo', `${safe(domain)}-${stamp()}`);
  await mkdir(resolve(output, 'attempts'), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Demo deadline reached')), 300_000);
  const started = Date.now();
  console.log(`[${domain}] 1/5 crawling ${url.href}`);
  try {
    const crawl = await crawlWebsite(url.href, controller.signal, undefined, { maxPages: 12, maxDepth: 2, timeoutMs: 30_000 });
    await writeFile(resolve(output, 'crawl.json'), json(crawl));
    console.log(`[${domain}] 2/5 extracting and reviewing ${crawl.pages.length} pages`);
    const provider = new AgenticEvidenceProvider(key, process.env.SIGNAL_LLM_MODEL?.trim() || DEFAULT_SIGNAL_LLM_MODEL,
      undefined, undefined, openAiEndpoint());
    const result = await provider.extractDetailed(crawl, controller.signal);
    await writeFile(resolve(output, 'corpus.json'), json(result.diagnostics.corpus));
    for (const [index, attempt] of result.diagnostics.attempts.entries()) {
      await writeFile(resolve(output, 'attempts', `${String(index + 1).padStart(2, '0')}-${safe(attempt.phase)}.json`), json(attempt));
    }
    await writeFile(resolve(output, 'candidates.json'), json(result.diagnostics.extraction));
    await writeFile(resolve(output, 'review.json'), json(result.diagnostics.review));
    await writeFile(resolve(output, 'acceptance.json'), json(result.diagnostics.grounding));
    await writeFile(resolve(output, 'tool-calls.json'), json({ rounds: result.diagnostics.rounds,
      stopReason: result.diagnostics.stopReason, calls: result.diagnostics.toolCalls }));
    await writeFile(resolve(output, 'website-data.json'), json(result.websiteData));
    console.log(`[${domain}] 3/5 building verified identity`);
    const identity = buildFirmIdentity(domain, result.websiteData);
    const query = { canonicalDomain: domain, names: identity.attorneyNames, firmName: identity.firmName,
      city: identity.city, state: 'FL' as const };
    const directoryInputs = identity.status === 'INSUFFICIENT' ? [] : [
      ...buildDirectoryInputs('bar', query), ...buildDirectoryInputs('avvo', query),
    ];
    await writeFile(resolve(output, 'identity.json'), json(identity));
    await writeFile(resolve(output, 'directory-query.json'), json({ sent: false, query }));
    await writeFile(resolve(output, 'directory-inputs.json'), json({ sent: false, inputs: directoryInputs }));
    const durationMs = Date.now() - started;
    const manifest = { target: url.href, domain, sentToApify: false, pages: crawl.pages.length,
      acceptedClaims: result.diagnostics.grounding.accepted, rejectedClaims: result.diagnostics.grounding.rejected,
      model: result.diagnostics.model, version: result.diagnostics.version, durationMs };
    await writeFile(resolve(output, 'manifest.json'), json(manifest));
    const rows = result.diagnostics.grounding.items.map(item => `<tr><td>${html(item.field)}</td><td>${html(item.claimId)}</td><td>${html(item.status)}</td><td>${html(item.reason)}</td></tr>`).join('');
    const report = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>ARCA signal report</title><style>body{font:15px system-ui;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.45rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem}strong{color:#8b0000}</style></head><body><h1>${html(domain)}</h1><p><strong>No se envió nada a Apify.</strong> ${html(durationMs)} ms; modelo ${html(result.diagnostics.model)}.</p><h2>Identidad</h2><pre>${html(json(identity))}</pre><h2>Señales aceptadas</h2><pre>${html(json(result.websiteData))}</pre><h2>Grounding</h2><table><thead><tr><th>Campo</th><th>Claim</th><th>Estado</th><th>Motivo</th></tr></thead><tbody>${rows}</tbody></table><h2>Payloads no enviados</h2><pre>${html(json(directoryInputs))}</pre></body></html>`;
    await writeFile(resolve(output, 'report.html'), report);
    console.log(`[${domain}] 4/5 accepted=${manifest.acceptedClaims} rejected=${manifest.rejectedClaims}`);
    console.log(`[${domain}] 5/5 APIFY NOT SENT; report=${resolve(output, 'report.html')}`);
  } catch (error) {
    const attempts = error instanceof ExtractionFailure ? error.attempts : [];
    for (const [index, attempt] of attempts.entries()) {
      await writeFile(resolve(output, 'attempts', `${String(index + 1).padStart(2, '0')}-${safe(attempt.phase)}.json`), json(attempt));
    }
    await writeFile(resolve(output, 'error.json'), json({ name: error instanceof Error ? error.name : 'Error',
      attempts: attempts.map(({ phase, durationMs, validationIssues }) => ({ phase, durationMs, validationIssues })),
      message: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }));
    console.error(`[${domain}] failed; diagnostics=${resolve(output, 'error.json')}`);
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
