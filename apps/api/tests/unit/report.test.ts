import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { renderQuickScanHtml, reportFilename } from '../../src/report/quick-scan.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { mockSources } from '../../src/pipeline/mock-sources.js';
import { fixtureResult } from '../../../../packages/contracts/tests/fixture.js';

const secret = 's'.repeat(40);

describe('Quick Scan Report content', () => {
  it('states the score, tier, categories and findings the /score screen shows', () => {
    const html = renderQuickScanHtml(fixtureResult(), 'COMPLETED');
    expect(html).toContain('Smith Law');
    expect(html).toContain('smithlaw.com');
    expect(html).toMatch(/>82</);
    expect(html).toContain('FORTRESS');
    for (const label of ['AI Governance &amp; Policy', 'Professional Standing', 'Reputation', 'Firm Maturity']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('AI usage policy published on the website');
    expect(html).toMatch(/not an offer of insurance/i);
  });

  it('says plainly when evidence is partial and no decision can be made', () => {
    const result = fixtureResult({});
    result.preScore.assessmentStatus = 'INSUFFICIENT_EVIDENCE';
    result.preScore.decision = 'UNKNOWN';
    const html = renderQuickScanHtml(result, 'PARTIAL');
    expect(html).toMatch(/partial evidence/i);
    expect(html).toMatch(/not enough public evidence/i);
    expect(html).not.toMatch(/website could not be read/i);
  });

  it('says in one sentence that the website could not be read, without a decision or a price', async () => {
    const { status, result } = await new InProcessPipeline({ ...mockSources(), repository: new InMemoryRepository() })
      .run({ scanId: 'sc_blocked', canonicalDomain: 'blocked.arca.example', email: 'owner@blocked.arca.example' });
    expect(status).toBe('PARTIAL');
    const html = renderQuickScanHtml(result, 'PARTIAL');
    const notes = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map(match => match[1]).filter(text => /website could not be read/.test(text!));
    expect(notes).toEqual(['The firm&#39;s website could not be read, so everything that could not be verified counts as unknown ' +
      'and the firm sits in the highest-risk group until the assessment is completed.']);
    // The cause stands in for the generic notice, and the report still says no decision was made.
    expect(html).not.toMatch(/did not answer in full/i);
    expect(html).toMatch(/not enough public evidence yet for an underwriting decision/i);
    expect(html).toMatch(/not an offer of insurance, a quote or an underwriting decision/i);
    // The firm name falls back to the domain, the one thing known about a site that was not read.
    expect(html).toContain('<h1>blocked.arca.example</h1>');
    expect(html).toMatch(/>0<small> \/ 100/);
    expect(html).toContain('CRITICAL');
    expect(html).toContain('Firm website: unavailable');
    // Nothing in the report names the restriction, a premium or a coverage outcome.
    expect(html).not.toMatch(/REFERRAL|referral|declin|premium|\$|approved|eligible|coverage/);
  });

  it('never lets scanned text become markup', () => {
    const result = fixtureResult();
    result.identity!.firmName = '<script>alert(1)</script> & Co';
    const html = renderQuickScanHtml(result, 'COMPLETED');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
  });

  it('names the file after the domain and the scan date', () => {
    expect(reportFilename(fixtureResult())).toBe('arca-quick-scan-smithlaw.com-2026-09-11.pdf');
  });
});

describe('GET /scan/:scanId/report.pdf', () => {
  const setup = async (status: 'COMPLETED' | 'PARTIAL' | 'RUNNING' | 'FAILED') => {
    const repository = new InMemoryRepository();
    const result = { ...fixtureResult(), scanId: 'sc_report', email: 'owner@smithlaw.com' };
    await repository.create({ id: randomUUID(), scan_id: 'sc_report', email: 'owner@smithlaw.com', canonical_domain: 'smithlaw.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'smithlaw.com', source: 'request', reason: null },
      status, result: status === 'COMPLETED' || status === 'PARTIAL' ? result : null,
      created_at: new Date().toISOString(), completed_at: null, duration_ms: null, cached: false });
    const renderReport = vi.fn(async (_html: string) => new Uint8Array([37, 80, 68, 70]));
    const { app } = createApp({ repository, pipeline: { run: vi.fn() }, sessionSecret: secret, corsOrigins: ['http://localhost:3000'],
      domainResolver: new PublicDomainResolver(async () => {}), clientIp: () => '127.0.0.1', renderReport });
    const token = await issueSessionToken('sc_report', 'owner@smithlaw.com', secret);
    return { app, token, renderReport };
  };

  it('returns the PDF of a finished scan as a download', async () => {
    const { app, token, renderReport } = await setup('COMPLETED');
    const response = await app.request('/scan/sc_report/report.pdf', {
      headers: { Authorization: `Bearer ${token}`, Origin: 'http://localhost:3000' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="arca-quick-scan-smithlaw.com-2026-09-11.pdf"');
    // The browser can only read the filename if CORS exposes the header.
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(renderReport.mock.calls[0]![0]).toContain('Smith Law');
  });

  it('serves a partial scan too, since /score shows it', async () => {
    const { app, token } = await setup('PARTIAL');
    const response = await app.request('/scan/sc_report/report.pdf', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it('refuses without the scan token, or with a token for another scan', async () => {
    const { app } = await setup('COMPLETED');
    expect((await app.request('/scan/sc_report/report.pdf')).status).toBe(401);
    const other = await issueSessionToken('sc_other', 'owner@smithlaw.com', secret);
    expect((await app.request('/scan/sc_report/report.pdf', { headers: { Authorization: `Bearer ${other}` } })).status).toBe(401);
  });

  it('has no report while the scan runs or after it failed', async () => {
    for (const status of ['RUNNING', 'FAILED'] as const) {
      const { app, token, renderReport } = await setup(status);
      const response = await app.request('/scan/sc_report/report.pdf', { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'report_unavailable' });
      expect(renderReport).not.toHaveBeenCalled();
    }
  });
});
