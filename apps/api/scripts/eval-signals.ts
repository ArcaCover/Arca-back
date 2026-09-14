import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { ExtractionFailure, NvidiaNimEvidenceProvider } from '../src/pipeline/nvidia-evidence-provider.js';
import { LLM_ENDPOINTS } from '../src/pipeline/llm-endpoint.js';
import { GoldLabels, evaluateWebsiteData } from '../src/pipeline/signal-evaluation.js';

if (existsSync('.env.local')) loadEnvFile('.env.local');
const endpoint = LLM_ENDPOINTS[process.env.SIGNAL_LLM_ENDPOINT === 'openai' ? 'openai' : 'nvidia'];
const keyName = endpoint.id === 'openai' ? 'OPENAI_API_KEY' : 'NVIDIA_NIM_API_KEY';
const key = process.env[keyName]?.trim();
if (!key) throw new Error(`${keyName} is required`);
const model = process.env.SIGNAL_LLM_MODEL?.trim() || (endpoint.id === 'nvidia' ? process.env.NVIDIA_NIM_MODEL?.trim() : undefined) || undefined;
if (endpoint.id === 'openai' && !model) throw new Error('SIGNAL_LLM_MODEL is required for the openai endpoint');
const args = process.argv.slice(2);
const runsFlag = args.indexOf('--runs');
const runs = runsFlag >= 0 ? Number(args[runsFlag + 1]) : 3;
const domains = args.filter((arg, index) => !arg.startsWith('--') && !(runsFlag >= 0 && index === runsFlag + 1));
if (!domains.length || !Number.isInteger(runs) || runs < 1) throw new Error('Usage: npm run eval:signals -- <domain> [...] --runs 3');

// Latency is out of scope for evaluation: use a longer per-call timeout than the provider's default 120 s,
// since one deepseek-v4-pro extraction call can take ~125 s.
const client = new OpenAI({ apiKey: key, baseURL: endpoint.baseURL, maxRetries: 0, timeout: 600_000 });

const output = resolve('output', 'eval', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const summary: Array<Record<string, unknown>> = [];
let incorrectTotal = 0;
for (const domain of domains) {
  const gold = GoldLabels.parse(JSON.parse(readFileSync(`apps/api/tests/fixtures/gold/${domain}.json`, 'utf8')));
  const crawl = JSON.parse(readFileSync(`output/eval/snapshots/${domain}.crawl.json`, 'utf8'));
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const provider = new NvidiaNimEvidenceProvider(key, model, client as never, undefined, endpoint);
    try {
      const result = await provider.extractDetailed(crawl, AbortSignal.timeout(2_700_000));
      const evaluation = evaluateWebsiteData(result.websiteData, gold);
      incorrectTotal += evaluation.incorrect;
      await writeFile(resolve(output, `${domain}-run${run}.json`), JSON.stringify({ evaluation, diagnostics: result.diagnostics,
        websiteData: result.websiteData }, null, 2));
      summary.push({ domain, run, status: 'completed', durationMs: Date.now() - started, correct: evaluation.correct,
        incorrect: evaluation.incorrect, attorneyRecall: evaluation.attorneyRecall,
        incorrectValues: evaluation.outcomes.filter(item => item.verdict === 'incorrect') });
    } catch (error) {
      await writeFile(resolve(output, `${domain}-run${run}.error.json`), JSON.stringify({ message: String(error),
        attempts: error instanceof ExtractionFailure ? error.attempts : [] }, null, 2));
      summary.push({ domain, run, status: 'failed', durationMs: Date.now() - started, error: String(error) });
    }
  }
}
await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.table(summary.map(({ incorrectValues: _omit, ...row }) => row));
console.log(`incorrect accepted values: ${incorrectTotal}; report: ${output}`);
if (incorrectTotal > 0 || summary.some(row => row.status === 'failed')) process.exitCode = 1;
