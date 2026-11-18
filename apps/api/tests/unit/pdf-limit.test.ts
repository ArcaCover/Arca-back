import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { createApp } from '../../src/http/app.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { limitRenders, ReportRenderTimeout, type PdfRender } from '../../src/report/pdf.js';
import { fixtureResult } from '../../../../packages/contracts/tests/fixture.js';

// Every renderer here is injected: no Chromium is launched.
const PDF = new Uint8Array([37, 80, 68, 70]);
function controlled() {
  const calls: Array<{ html: string; signal: AbortSignal; finish: () => void; fail: (error: Error) => void }> = [];
  const render = vi.fn<PdfRender>((html, signal) => new Promise((resolve, reject) => {
    calls.push({ html, signal, finish: () => resolve(PDF), fail: reject });
  }));
  return { render, calls };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('PDF renders share a small cap and a deadline', () => {
  it('runs at most two renders at once; the next request waits for a slot and then renders', async () => {
    const { render, calls } = controlled();
    const limited = limitRenders(render, { maxConcurrent: 2, timeoutMs: 60_000 });
    const requests = ['a', 'b', 'c', 'd'].map(html => limited(html));
    await tick();
    expect(calls.map(call => call.html)).toEqual(['a', 'b']);
    calls[0]!.finish();
    await expect(requests[0]).resolves.toEqual(PDF);
    expect(calls.map(call => call.html)).toEqual(['a', 'b', 'c']);
    // A failed render frees its slot as well.
    calls[1]!.fail(new Error('Chromium did not start'));
    await expect(requests[1]).rejects.toThrow('Chromium did not start');
    expect(calls.map(call => call.html)).toEqual(['a', 'b', 'c', 'd']);
    calls[2]!.finish(); calls[3]!.finish();
    await expect(Promise.all(requests.slice(2))).resolves.toEqual([PDF, PDF]);
  });

  it('gives up on a render that hangs, aborts it and hands its slot on', async () => {
    vi.useFakeTimers();
    try {
      const { render, calls } = controlled();
      const limited = limitRenders(render, { maxConcurrent: 1, timeoutMs: 1_000 });
      const hung = limited('hung');
      const hungResult = hung.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      const next = limited('next');
      expect(render).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(await hungResult).toBeInstanceOf(ReportRenderTimeout);
      expect(calls[0]!.signal.aborted).toBe(true);
      // The waiting request got the slot as soon as the hung one gave up, with its own time left.
      expect(calls.map(call => call.html)).toEqual(['hung', 'next']);
      calls[1]!.finish();
      await expect(next).resolves.toEqual(PDF);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the wait for a slot against the deadline, so no request outlives it', async () => {
    vi.useFakeTimers();
    try {
      const { render, calls } = controlled();
      const limited = limitRenders(render, { maxConcurrent: 1, timeoutMs: 1_000 });
      const first = limited('first').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(600);
      const second = limited('second').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(400);
      expect(await first).toBeInstanceOf(ReportRenderTimeout);
      expect(calls.map(call => call.html)).toEqual(['first', 'second']);
      // It waited 400 ms of its 1000, so it renders for 600 ms at most, not another full second.
      await vi.advanceTimersByTimeAsync(600);
      expect(await second).toBeInstanceOf(ReportRenderTimeout);
      expect(calls[1]!.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles every request when the next render throws before returning a promise', async () => {
    const calls: Array<() => void> = [];
    let count = 0;
    const render = vi.fn<PdfRender>(() => {
      count++;
      if (count === 2) throw new Error('renderer threw at once');
      return new Promise(resolve => calls.push(() => resolve(PDF)));
    });
    const limited = limitRenders(render, { maxConcurrent: 1, timeoutMs: 60_000 });
    const first = limited('first'), second = limited('second'), third = limited('third');
    const secondResult = second.catch((error: unknown) => error);
    await tick();
    calls[0]!();
    // The request that handed its slot on still gets its PDF, the throwing one is rejected, and the slot moves on.
    await expect(first).resolves.toEqual(PDF);
    expect(await secondResult).toEqual(new Error('renderer threw at once'));
    await tick();
    calls[1]!();
    await expect(third).resolves.toEqual(PDF);
  });
});

describe('GET /scan/:scanId/report.pdf with a render that runs out of time', () => {
  it('answers 503 report_unavailable, not an unexpected server error', async () => {
    const repository = new InMemoryRepository();
    const result = { ...fixtureResult(), scanId: 'sc_slow', email: 'owner@smithlaw.com' };
    await repository.create({ id: randomUUID(), scan_id: 'sc_slow', email: 'owner@smithlaw.com', canonical_domain: 'smithlaw.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'smithlaw.com', source: 'request', reason: null },
      status: 'COMPLETED', result, created_at: new Date().toISOString(), completed_at: null, duration_ms: null, cached: false });
    const secret = 's'.repeat(40);
    const { render } = controlled();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp({ repository, pipeline: { run: vi.fn() }, sessionSecret: secret, corsOrigins: ['http://localhost:3000'],
      domainResolver: new PublicDomainResolver(async () => {}), clientIp: () => '127.0.0.1',
      renderReport: limitRenders(render, { timeoutMs: 20 }) });
    const token = await issueSessionToken('sc_slow', 'owner@smithlaw.com', secret);
    const response = await app.request('/scan/sc_slow/report.pdf', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'report_unavailable' });
    expect(errors).toHaveBeenCalledWith('[api] report rendering failed', 'sc_slow', 'Report rendering timed out');
    errors.mockRestore();
  });
});
