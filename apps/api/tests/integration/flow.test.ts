import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { fixtureResult } from '../fixtures/result.js';
import { PollResponse, ScanResponse } from '../../src/http/schemas.js';
import type { PipelineResult } from '@arca/contracts';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
const domainResolver = new PublicDomainResolver(async () => {});
const secret = 's'.repeat(40);
const post = (email = 'user@firm.com') => new Request('http://localhost/scan', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, domain: 'firm.com' }) });
describe('asynchronous scan API', () => {
  it('allows only the configured local and production frontend origins', async () => {
    const { app } = createApp({ domainResolver, repository: new InMemoryRepository(), pipeline: { run: vi.fn() },
      sessionSecret: secret, corsOrigins: ['http://localhost:3000', 'https://arcacover.com'], clientIp: () => '127.0.0.1' });
    for (const origin of ['http://localhost:3000', 'https://arcacover.com']) {
      const response = await app.request('/health', { headers: { Origin: origin } });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    const preflight = await app.request('/scan', { method: 'OPTIONS', headers: {
      Origin: 'https://arcacover.com', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://arcacover.com');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization');
    const rejected = await app.request('/health', { headers: { Origin: 'https://example.com' } });
    expect(rejected.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
  it('returns 202 before completion and supports authenticated terminal polling', async () => {
    let resolve!: (result: PipelineResult) => void;
    const promise = new Promise<PipelineResult>(r => { resolve = r; });
    const repository = new InMemoryRepository();
    const { app, drain } = createApp({ domainResolver, repository, pipeline: { run: () => promise }, sessionSecret: secret, corsOrigins: [], clientIp: () => '127.0.0.1' });
    const start = await app.request(post());
    expect(start.status).toBe(202);
    const body = ScanResponse.parse(await start.json());
    expect((await repository.get(body.scanId))?.status).toBe('RUNNING');
    expect((await app.request(`/scan/${body.scanId}`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${body.sessionToken}` };
    const running = PollResponse.parse(await (await app.request(`/scan/${body.scanId}`, { headers })).json());
    expect(running.status).toBe('RUNNING');
    resolve({ status: 'PARTIAL', result: fixtureResult() });
    await drain();
    const final = PollResponse.parse(await (await app.request(`/scan/${body.scanId}`, { headers })).json());
    expect(final.status).toBe('PARTIAL');
    expect(final.result?.preScore.total).toBe(0);
    expect(final.result).toMatchObject({ scanId: body.scanId, domain: 'firm.com', email: 'user@firm.com' });
    const wrongToken = await issueSessionToken('sc_other', 'user@firm.com', secret);
    expect((await app.request(`/scan/${body.scanId}`, { headers: { Authorization: `Bearer ${wrongToken}` } })).status).toBe(401);
  });
  it('reuses a domain result without exposing the previous email or extending evidence TTL', async () => {
    const repository = new InMemoryRepository();
    const now = Date.now();
    const oldTime = new Date(now - 86300000).toISOString();
    const original = fixtureResult('sc_original', 'original@firm.com');
    original.meta.completedAt = oldTime;
    await repository.create({ id: randomUUID(), scan_id: 'sc_original', canonical_domain: 'firm.com', email: 'original@firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
      status: 'COMPLETED', result: original, created_at: oldTime, completed_at: oldTime, duration_ms: 10, cached: false });
    const run = vi.fn();
    let clock = now;
    const { app } = createApp({ domainResolver, repository, pipeline: { run }, sessionSecret: secret, corsOrigins: [], clientIp: () => '127.0.0.1', now: () => clock });
    const response = await app.request(post('second@gmail.com'));
    expect(response.status).toBe(200);
    const body = ScanResponse.parse(await response.json());
    expect(body.cached).toBe(true);
    expect(body.result?.email).toBe('second@gmail.com');
    expect(body.result?.preScore).toEqual(original.preScore);
    expect(body.result?.meta.completedAt).toBe(oldTime);
    expect(body.scanId).not.toBe('sc_original');
    expect(JSON.stringify(body)).not.toContain('original@firm.com');
    expect(run).not.toHaveBeenCalled();
    clock += 200000;
    expect(await repository.cached('firm.com', new Date(clock - 86400000).toISOString())).toBeNull();
  });
  it('repairs a partial cache entry instead of returning stale partial evidence', async () => {
    const repository = new InMemoryRepository();
    const now = Date.now();
    const oldTime = new Date(now - 86300000).toISOString();
    const original = fixtureResult('sc_partial', 'original@firm.com');
    original.meta.completedAt = oldTime;
    await repository.create({ id: randomUUID(), scan_id: 'sc_partial', canonical_domain: 'firm.com', email: 'original@firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null },
      status: 'PARTIAL', result: original, created_at: oldTime, completed_at: oldTime, duration_ms: 10, cached: false });
    const repaired = fixtureResult();
    const run = vi.fn(async () => ({ status: 'PARTIAL' as const, result: repaired }));
    const { app, drain } = createApp({ domainResolver, repository, pipeline: { run }, sessionSecret: secret,
      corsOrigins: [], clientIp: () => '127.0.0.1', now: () => now });
    const response = await app.request(post('second@gmail.com'));
    expect(response.status).toBe(202);
    const body = ScanResponse.parse(await response.json());
    expect(body).toMatchObject({ status: 'RUNNING' });
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(repository.scans.get(body.scanId)?.status).toBe('PARTIAL');
    expect(repository.scans.get(body.scanId)?.cached).toBe(false);
  });
  it('reports failures as terminal HTTP 200 instead of leaving RUNNING forever', async () => {
    const repository = new InMemoryRepository();
    const { app, drain } = createApp({ domainResolver, repository, pipeline: { run: async () => { throw new Error('Fixture failure'); } },
      sessionSecret: secret, corsOrigins: [], clientIp: () => '127.0.0.1' });
    const body = await (await app.request(post())).json();
    await drain();
    const response = await app.request(`/scan/${body.scanId}`, { headers: { Authorization: `Bearer ${body.sessionToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scanId: body.scanId, status: 'FAILED', cached: false });
  });
  it('coalesces simultaneous scans for the same domain', async () => {
    let resolve!: (result: PipelineResult) => void;
    const pending = new Promise<PipelineResult>(done => { resolve = done; });
    const run = vi.fn(() => pending);
    const repository = new InMemoryRepository();
    const { app, drain } = createApp({ domainResolver, repository, pipeline: { run }, sessionSecret: secret,
      corsOrigins: [], clientIp: () => '127.0.0.1' });
    const first = ScanResponse.parse(await (await app.request(post('first@firm.com'))).json());
    await Promise.resolve();
    const second = ScanResponse.parse(await (await app.request(post('second@firm.com'))).json());
    resolve({ status: 'PARTIAL', result: fixtureResult() });
    await drain();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await repository.get(first.scanId))?.result?.meta.reusedEvidence).toBe(false);
    expect((await repository.get(second.scanId))?.result?.meta.reusedEvidence).toBe(true);
  });
  it('documents only the current scan contract', async () => {
    const { app } = createApp({ domainResolver, repository: new InMemoryRepository(), pipeline: { run: vi.fn() }, sessionSecret: secret, corsOrigins: [], clientIp: () => '127.0.0.1' });
    const document = await (await app.request('/openapi.json')).json();
    expect(Object.keys(document.paths).sort()).toEqual(['/scan', '/scan/{scanId}']);
    expect(document.paths['/scan'].post.description).toContain('Cache identity is the normalized domain');
    expect(document.paths['/scan'].post.responses['200'].description).toContain('Domain cache hit');
    expect(document.paths['/scan'].post.responses['202'].description).toContain('Fresh scan started');
    expect(document.paths['/scan/{scanId}'].get.security).toEqual([{ sessionToken: [] }]);
    expect((await app.request('/docs')).status).toBe(200);
  });
  it('returns Retry-After when email rate limiting rejects a request', async () => {
    const { app, drain } = createApp({ domainResolver, repository: new InMemoryRepository(),
      pipeline: { run: async () => ({ status: 'FAILED', result: fixtureResult() }) },
      sessionSecret: secret, corsOrigins: [], clientIp: () => '127.0.0.1' });
    for (let i = 0; i < 3; i++) expect((await app.request(post())).status).toBe(202);
    const response = await app.request(post());
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    await drain();
  });
});
