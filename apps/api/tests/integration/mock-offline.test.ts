import dns from 'node:dns';
import { lookup as namedLookup } from 'node:dns/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentResult, AssessmentView, PollResponse, ScanResponse, StartedAssessmentResponse, type AnswerValue,
  type RenderedQuestion } from '@arca/contracts';
import { loadEnv } from '../../src/config/env.js';
import { compose } from '../../src/compose.js';

// DN-09 8.3: mock builds no real client, so a whole scan and assessment runs with every way out of the process refused.
// fetch covers Supabase, OpenAI and Apify; Socket.prototype.connect is under every TCP and TLS client (http, https,
// undici, tls.connect, net.connect); the two lookups are DNS. Each attempt is recorded before it throws, so one that
// some caller swallows still fails the test.
const attempts: string[] = [];
const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, lookup: dns.lookup, promisesLookup: dns.promises.lookup };
// net.connect hands Socket.connect its normalized argument list, so the options are its first entry.
const target = (value: unknown): string => Array.isArray(value) ? target(value[0]) : value instanceof Request ? value.url
  : typeof value === 'object' && value !== null ? JSON.stringify(value, ['host', 'hostname', 'port', 'path']) : String(value);
const refuse = (name: string) => (...args: unknown[]): never => {
  attempts.push(`${name} ${target(args[0])}`);
  throw new Error(`Network access refused in mock mode (${name})`);
};

beforeAll(() => {
  globalThis.fetch = refuse('fetch');
  net.Socket.prototype.connect = refuse('net.Socket.connect');
  dns.lookup = refuse('dns.lookup') as typeof dns.lookup;
  dns.promises.lookup = refuse('dns.promises.lookup');
  // Named imports such as `import { lookup } from 'node:dns/promises'` only see the replacement after a sync.
  syncBuiltinESMExports();
});

afterAll(() => {
  globalThis.fetch = original.fetch;
  net.Socket.prototype.connect = original.connect;
  dns.lookup = original.lookup;
  dns.promises.lookup = original.promisesLookup;
  syncBuiltinESMExports();
});

// The real back .env.local says live sources and Supabase, with every key present. ARCA_MODE=mock must win over all of it.
const liveSettings = { ARCA_MODE: 'mock', SOURCE_MODE: 'live', STORAGE_BACKEND: 'supabase', SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_x', OPENAI_API_KEY: 'sk-x', APIFY_API_TOKEN: 'x', SESSION_TOKEN_SECRET: 's'.repeat(40),
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000' };
const DOMAIN = 'robust.arca.example';

function firstValidAnswer(question: RenderedQuestion): AnswerValue {
  if (question.type === 'multi_select') return { kind: 'options', optionIds: [question.options![0]!.id] };
  if (question.type === 'scale') return { kind: 'scale', value: question.scale!.min };
  if (question.type === 'number') return { kind: 'number', value: question.number!.min };
  return { kind: 'option', optionId: question.options![0]!.id };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Gave up waiting');
}

describe('mock mode with the network cut off', () => {
  it('runs scan, poll, assessment, answers, complete and result without a single outbound attempt', async () => {
    const env = loadEnv(liveSettings);
    const { app, drain, banner } = await compose(env);
    expect(banner).toContain('MODE=mock');
    expect(banner).toContain('overrides: SOURCE_MODE=live→mock');

    const scanResponse = await app.request('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `owner@${DOMAIN}`, domain: DOMAIN }) });
    expect(scanResponse.status).toBe(202);
    const started = ScanResponse.parse(await scanResponse.json());
    const auth = { Authorization: `Bearer ${started.sessionToken}`, 'Content-Type': 'application/json' };
    const poll = await until(async () => PollResponse.parse(await (await app.request(`/scan/${started.scanId}`, { headers: auth })).json()),
      value => value.status !== 'RUNNING');
    expect(poll.status).toBe('COMPLETED');

    const assessmentResponse = await app.request(`/scan/${started.scanId}/assessment`, { method: 'POST', headers: auth });
    expect(assessmentResponse.status).toBe(202);
    const { assessmentId } = StartedAssessmentResponse.parse(await assessmentResponse.json());
    const view = () => app.request(`/assessment/${assessmentId}`, { headers: auth }).then(async response => {
      expect(response.status).toBe(200);
      return AssessmentView.parse(await response.json());
    });
    expect((await until(view, value => value.status !== 'PLANNING')).status).toBe('READY');

    let answered = 0;
    for (let current = await view(); ; current = await view()) {
      const question = current.questions.find(candidate => !current.answers[candidate.id]);
      if (!question) break;
      const saved = await app.request(`/assessment/${assessmentId}/answers/${question.id}`, { method: 'PUT', headers: auth,
        body: JSON.stringify({ answer: firstValidAnswer(question) }) });
      expect(saved.status).toBe(200);
      expect(++answered).toBeLessThan(50);
    }
    expect(answered).toBeGreaterThan(0);

    const completed = await app.request(`/assessment/${assessmentId}/complete`, { method: 'POST', headers: auth,
      body: JSON.stringify({ attestation: true }) });
    expect(completed.status).toBe(200);
    const completedResult = AssessmentResult.parse(await completed.json());
    const result = await app.request(`/assessment/${assessmentId}/result`, { headers: auth });
    expect(result.status).toBe(200);
    expect(AssessmentResult.parse(await result.json())).toEqual(completedResult);

    await drain();
    expect(attempts).toEqual([]);
  });

  // Guards the guard: a trap that never fires would let the test above pass for the wrong reason.
  it('records and refuses every kind of outbound attempt it traps', () => {
    const before = attempts.length;
    expect(() => fetch('https://x.supabase.co/rest/v1/scans')).toThrow('refused');
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow('refused');
    expect(() => dns.promises.lookup('example.com')).toThrow('refused');
    expect(() => dns.lookup('example.com', () => {})).toThrow('refused');
    // The binding pipeline/network.ts resolves domains with.
    expect(() => namedLookup('example.com')).toThrow('refused');
    expect(attempts.splice(before)).toEqual(['fetch https://x.supabase.co/rest/v1/scans',
      'net.Socket.connect {"host":"example.com","port":443}', 'dns.promises.lookup example.com', 'dns.lookup example.com',
      'dns.promises.lookup example.com']);
  });
});
