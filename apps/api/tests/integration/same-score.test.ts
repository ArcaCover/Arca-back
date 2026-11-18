import { describe, expect, it, vi } from 'vitest';
import { PollResponse, ScanResponse, type DirectorySource, type Layer1Result } from '@arca/contracts';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { nothingToLookUp } from '../../src/pipeline/directories.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';

// DN-12 §4 (D5): the same firm gets the same score for the whole cache window. Driven through POST /scan and the poll
// as the front does, with the real pipeline and scoring over the mock sources, and a clock the test moves.
const HOUR = 3_600_000, DAY = 24 * HOUR;

function setup(sources = mockSources()) {
  const repository = new InMemoryRepository();
  let clock = Date.parse('2026-11-09T12:00:00.000Z');
  const pipeline = new InProcessPipeline({ ...sources, repository, timeoutMs: 30_000, now: () => clock });
  const run = vi.spyOn(pipeline, 'run');
  const { app, drain } = createApp({ repository, pipeline, sessionSecret: 's'.repeat(40), corsOrigins: [],
    // Each request comes from its own visitor, so the limiter never stands in for the cache.
    clientIp: request => request.headers.get('X-Test-Visitor') ?? 'unknown', now: () => clock,
    domainResolver: new PublicDomainResolver(async () => {}), scanCacheTtlMs: 7 * DAY, partialRepairCooldownMs: HOUR });
  let visitor = 0;
  async function scan(domain: string): Promise<{ http: number; status: string; cached: boolean; result: Layer1Result }> {
    visitor++;
    const response = await app.request('/scan', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-Visitor': `visitor-${visitor}` },
      body: JSON.stringify({ email: `visitor${visitor}@${domain}`, domain }) });
    const started = ScanResponse.parse(await response.json());
    await drain();
    const poll = PollResponse.parse(await (await app.request(`/scan/${started.scanId}`,
      { headers: { Authorization: `Bearer ${started.sessionToken}` } })).json());
    if (poll.status !== 'COMPLETED' && poll.status !== 'PARTIAL') throw new Error(`The scan ended ${poll.status}`);
    return { http: response.status, status: poll.status, cached: poll.cached, result: poll.result };
  }
  return { scan, run, advance: (ms: number) => { clock += ms; } };
}

describe('same firm, same score inside the cache window', () => {
  it('answers a completed scan from the stored result', async () => {
    const s = setup();
    const first = await s.scan('robust.arca.example');
    s.advance(6 * DAY);
    const second = await s.scan('robust.arca.example');
    expect(first).toMatchObject({ http: 202, status: 'COMPLETED', cached: false });
    expect(second).toMatchObject({ http: 200, status: 'COMPLETED', cached: true });
    expect(second.result.preScore).toEqual(first.result.preScore);
    expect(second.result.signals).toEqual(first.result.signals);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('answers a structural partial from the stored result, long after the repair cooldown', async () => {
    // The website shows a firm but no city, so Avvo has nothing to look up: scanning again would find the same.
    const sources = mockSources();
    const avvo: DirectorySource = { run: async query => nothingToLookUp({ ...query, names: [] }) };
    const s = setup({ ...sources, avvo });
    const first = await s.scan('robust.arca.example');
    expect(first).toMatchObject({ status: 'PARTIAL', cached: false });
    expect(first.result.sources.avvo).toMatchObject({ status: 'skipped', code: 'INSUFFICIENT_IDENTITY' });
    s.advance(6 * DAY);
    const second = await s.scan('robust.arca.example');
    // A partial never takes the fast 200: it arrives through the poll, as before.
    expect(second).toMatchObject({ http: 202, status: 'PARTIAL', cached: true });
    expect(second.result.preScore).toEqual(first.result.preScore);
    expect(second.result.signals).toEqual(first.result.signals);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('answers a website that refuses to be read from the stored result', async () => {
    const s = setup();
    const first = await s.scan('blocked.arca.example');
    expect(first.result.preScore.flags).toContain('WEBSITE_UNAVAILABLE');
    s.advance(6 * DAY);
    const second = await s.scan('blocked.arca.example');
    expect(second).toMatchObject({ http: 202, status: 'PARTIAL', cached: true });
    expect(second.result.preScore).toEqual(first.result.preScore);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('repairs a website that could not be reached once the cooldown has ended (DN-12 §14)', async () => {
    // down.arca.example: no page read for a passing cause on the site's side. PARTIAL with WEBSITE_UNAVAILABLE, but the
    // site may answer in an hour, so it is not kept for the window as a refusal is.
    const s = setup();
    const first = await s.scan('down.arca.example');
    expect(first).toMatchObject({ status: 'PARTIAL', cached: false });
    expect(first.result.preScore.flags).toContain('WEBSITE_UNAVAILABLE');
    s.advance(10 * 60_000);
    expect(await s.scan('down.arca.example')).toMatchObject({ http: 202, status: 'PARTIAL', cached: true });
    expect(s.run).toHaveBeenCalledTimes(1);
    s.advance(HOUR);
    expect(await s.scan('down.arca.example')).toMatchObject({ status: 'PARTIAL', cached: false });
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it('runs a partial with a passing failure again once the cooldown has ended, and only then', async () => {
    // partial.arca.example: Avvo was down (PROVIDER_ERROR). A second scan could find it up.
    const s = setup();
    const first = await s.scan('partial.arca.example');
    expect(first).toMatchObject({ status: 'PARTIAL', cached: false });
    expect(first.result.sources.avvo).toMatchObject({ status: 'error', code: 'PROVIDER_ERROR' });
    s.advance(10 * 60_000);
    expect(await s.scan('partial.arca.example')).toMatchObject({ status: 'PARTIAL', cached: true });
    expect(s.run).toHaveBeenCalledTimes(1);
    s.advance(HOUR);
    expect(await s.scan('partial.arca.example')).toMatchObject({ http: 202, status: 'PARTIAL', cached: false });
    expect(s.run).toHaveBeenCalledTimes(2);
    // The repair is the new answer of record, and its own cooldown starts with it.
    s.advance(10 * 60_000);
    expect(await s.scan('partial.arca.example')).toMatchObject({ status: 'PARTIAL', cached: true });
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it('runs every scan again once the cache window has ended', async () => {
    const s = setup();
    await s.scan('blocked.arca.example');
    s.advance(7 * DAY + 1);
    expect(await s.scan('blocked.arca.example')).toMatchObject({ status: 'PARTIAL', cached: false });
    expect(s.run).toHaveBeenCalledTimes(2);
  });
});
