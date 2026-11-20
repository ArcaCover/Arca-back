import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { FLORIDA_ONLY_NOTE, WEBSITE_UNREAD_NOTE, hasInsufficientEvidence, renderQuickScanHtml, reportFilename, scoreWithheld }
  from '../../src/report/quick-scan.js';
import { Layer1Result } from '@arca/contracts';
import { evaluateLayer1Evidence } from '@arca/scoring';
import { multiState } from '../../../../packages/scoring/tests/fixtures/determinism.js';
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

  it.each(['blocked.arca.example', 'down.arca.example'])(
    'shows %s as low confidence: no number, no tier, one notice, no highest-risk group or manual review', async domain => {
      const { status, result } = await new InProcessPipeline({ ...mockSources(), repository: new InMemoryRepository() })
        .run({ scanId: 'sc_unread', canonicalDomain: domain, email: `owner@${domain}` });
      expect(status).toBe('PARTIAL');
      const html = renderQuickScanHtml(result, 'PARTIAL');
      expect(html).toContain('<div class="tier">No score from public evidence</div>');
      expect(html).toContain('We could not read the firm&#39;s website, so there is no public evidence to score. A full assessment ' +
        'gives a score based on the firm&#39;s answers, marked as low confidence.');
      expect(html.match(/could not read/g)).toHaveLength(1);
      expect(html).toContain('Confidence: low');
      // No Layer 1 number and no tier: a 0 and CRITICAL here would read as a verdict on a firm we could not see.
      expect(html).not.toMatch(/<div class="total">/);
      expect(html).not.toMatch(/CRITICAL|Very few positive public signals/);
      expect(html).not.toMatch(/highest-risk|manual review|until the assessment|whatever/i);
      // The score block says why; the generic notice about sources is not repeated, and no decision is implied.
      expect(html).not.toMatch(/did not answer in full/i);
      expect(html).toMatch(/not enough public evidence yet for an underwriting decision/i);
      expect(html).toMatch(/not an offer of insurance, a quote or an underwriting decision/i);
      // The firm name falls back to the domain, the one thing known about a site that was not read.
      expect(html).toContain(`<h1>${domain}</h1>`);
      expect(html.match(new RegExp(domain.replaceAll('.', '\.'), 'g'))).toHaveLength(2);
      expect(html).toContain('Firm website: unavailable');
      // The directories were never asked: they were skipped, not unavailable.
      expect(html).toContain('Florida Bar: not searched; we could not look the firm up there');
      expect(html).toContain('Avvo: not searched; we could not look the firm up there');
      expect(html).not.toMatch(/REFERRAL|referral|declin|premium|\$|approved|eligible|coverage/);
    });

  it('never says the firm could not be identified when a directory was skipped for want of a city', () => {
    // The live scan of 2026-11-06 (flow.test.ts): the firm was named and the Bar found it, but Avvo was not run
    // because a firm-wide search needs a verified city. The code is INSUFFICIENT_IDENTITY all the same.
    const result = fixtureResult();
    result.sources = { website: { status: 'partial', dataStatus: 'PRESENT', durationMs: 73456, pagesCrawled: 19 },
      bar: { status: 'ok', dataStatus: 'PRESENT', durationMs: 10 },
      avvo: { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY',
        reason: 'A firm-wide search needs a verified city; a nationwide search is not run' } };
    const html = renderQuickScanHtml(result, 'PARTIAL');
    expect(html).toContain('<h1>Smith Law</h1>');
    expect(html).toContain('Florida Bar: complete');
    expect(html).toContain('Avvo: not searched; we could not look the firm up there');
    expect(html).not.toMatch(/could not be identified/i);
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

  it('dates the report and its file by the day in Florida, not in UTC', () => {
    // 10:30 p.m. in Miami on November 9 is already November 10 in UTC.
    const evening = fixtureResult();
    evening.meta.completedAt = '2026-11-10T03:30:00.000Z';
    expect(reportFilename(evening)).toBe('arca-quick-scan-smithlaw.com-2026-11-09.pdf');
    expect(renderQuickScanHtml(evening, 'COMPLETED')).toContain('Scanned November 9, 2026');
    expect(renderQuickScanHtml(evening, 'COMPLETED')).toMatch(/observed on November 9, 2026/);
  });

  it('words the unreadable website in the third person, as the low-confidence state of /score', () => {
    expect(WEBSITE_UNREAD_NOTE).toBe("We could not read the firm's website, so there is no public evidence to score. " +
      "A full assessment gives a score based on the firm's answers, marked as low confidence.");
  });

  it('prints the domain under a firm name the scan found', () => {
    const html = renderQuickScanHtml(fixtureResult(), 'COMPLETED');
    expect(html).toContain('<h1>Smith Law</h1>');
    expect(html).toMatch(/<div class="meta">smithlaw\.com( · [^<]+)?<br>Scanned/);
  });
});

// The live scan of lemonlawgrouppartners.com: eleven of the fourteen attorneys are licensed outside Florida (DN-12 §15, §15.5).
function multiStateResult() {
  return Layer1Result.parse({ scanId: 'sc_multistate', domain: 'harborlemon.example', email: 'owner@harborlemon.example',
    ...evaluateLayer1Evidence(multiState()), meta: { scanDurationMs: 10, cached: false, completedAt: '2026-11-18T23:10:55.852Z' } });
}

describe('Quick Scan Report for a firm with attorneys licensed outside Florida', () => {
  it('says once that Professional Standing covers Florida only, and how many attorneys it left out', () => {
    const html = renderQuickScanHtml(multiStateResult(), 'PARTIAL');
    expect(html).toContain('Professional Standing covers Florida only. 11 of the firm&#39;s 14 attorneys are licensed outside '
      + 'Florida, so they were not scored against the Florida Bar.');
    expect(html.match(/covers Florida only/g)).toHaveLength(1);
    expect(FLORIDA_ONLY_NOTE({ outside: 10, total: 14 })).toBe('Professional Standing covers Florida only. 10 of the '
      + "firm's 14 attorneys are licensed outside Florida, so they were not scored against the Florida Bar.");
  });

  it('names the Florida attorneys in the bar-record finding', () => {
    const html = renderQuickScanHtml(multiStateResult(), 'PARTIAL');
    expect(html).toContain('100% of the firm&#39;s Florida attorneys matched a Florida Bar record');
    expect(html).not.toContain('100% of the firm&#39;s attorneys matched a bar record');
  });

  it('keeps its words without a count, and says nothing for a firm without the flag', () => {
    const result = multiStateResult();
    const b3 = result.preScore.categories.professionalStanding.rules.find(rule => rule.id === 'B3')!;
    b3.reason = 'Evaluated from observed evidence';
    expect(renderQuickScanHtml(result, 'PARTIAL')).toContain('Professional Standing covers Florida only. Attorneys licensed '
      + 'outside Florida were not scored against the Florida Bar.');
    expect(FLORIDA_ONLY_NOTE(null)).toBe('Professional Standing covers Florida only. Attorneys licensed outside Florida were '
      + 'not scored against the Florida Bar.');
    expect(renderQuickScanHtml(fixtureResult(), 'COMPLETED')).not.toContain('covers Florida only');
  });
});

// The live scan of hklaw.com: only Professional Standing could be evaluated, and only in part, so the engine printed
// 3 / 100, CRITICAL, with low confidence. The website was read in part; Avvo was never searched.
function thinEvidence() {
  const result = fixtureResult();
  const unknown = (max: number, rules: string[]) => ({ score: null, max, status: 'UNKNOWN' as const,
    rules: rules.map(id => ({ id, points: null, reason: 'Evidence unavailable or ambiguous' })) });
  result.domain = 'hklaw.example';
  result.preScore = { ...result.preScore, total: 3, tier: 'CRITICAL', decision: 'UNKNOWN', confidence: 'LOW',
    assessmentStatus: 'INSUFFICIENT_EVIDENCE', flags: ['INCOMPLETE_SOURCES', 'INCOMPLETE_EVIDENCE', 'COMMERCIAL_DECISION_BLOCKED'],
    categories: {
      aiGovernance: unknown(35, ['W1', 'W2', 'W3', 'W4']),
      professionalStanding: { score: 3, max: 30, status: 'PARTIAL', rules: [
        { id: 'B1', points: 3, reason: 'Evaluated from observed evidence' },
        { id: 'B2_clean', points: null, reason: 'Evidence unavailable or ambiguous' }] },
      reputation: unknown(20, ['A1', 'A3', 'A6']),
      firmMaturity: unknown(15, ['W7', 'W6', 'W5a', 'W8', 'W9_A2']),
    } };
  result.sources = { website: { status: 'partial', dataStatus: 'PRESENT', durationMs: 60000, code: 'DEADLINE_REACHED' },
    bar: { status: 'ok', dataStatus: 'PRESENT', durationMs: 10 },
    avvo: { status: 'skipped', dataStatus: 'UNKNOWN', durationMs: 0, code: 'INSUFFICIENT_IDENTITY' } };
  return result;
}

describe('scoreWithheld', () => {
  it('withholds the score of an unreadable website, whatever else the evidence shows', () => {
    const { preScore } = thinEvidence();
    expect(scoreWithheld({ ...preScore, flags: [...preScore.flags, 'WEBSITE_UNAVAILABLE'] })).toBe('WEBSITE_UNAVAILABLE');
    expect(scoreWithheld({ ...fixtureResult().preScore, flags: ['WEBSITE_UNAVAILABLE'] })).toBe('WEBSITE_UNAVAILABLE');
  });
  it('withholds it for thin evidence, and not for a firm it can rate', () => {
    expect(scoreWithheld(thinEvidence().preScore)).toBe('INSUFFICIENT_EVIDENCE');
    expect(scoreWithheld(fixtureResult().preScore)).toBeNull();
  });
});

describe('hasInsufficientEvidence', () => {
  it('is true for the hklaw.com shape: low confidence and one category, partly, evaluated', () => {
    expect(hasInsufficientEvidence(thinEvidence().preScore)).toBe(true);
  });

  it('is true when no category could be evaluated and the website was read', () => {
    const { preScore } = thinEvidence();
    preScore.categories.professionalStanding = { ...preScore.categories.reputation, max: 30 };
    expect(hasInsufficientEvidence(preScore)).toBe(true);
  });

  it('is false once two categories are known or partial, even with low confidence', () => {
    const { preScore } = thinEvidence();
    preScore.categories.reputation = { ...preScore.categories.reputation, score: 10, status: 'KNOWN' };
    expect(hasInsufficientEvidence(preScore)).toBe(false);
  });

  it('is false when confidence is not low', () => {
    expect(hasInsufficientEvidence({ ...thinEvidence().preScore, confidence: 'MEDIUM' })).toBe(false);
  });

  it('is false with WEBSITE_UNAVAILABLE, which has its own withheld state', () => {
    const { preScore } = thinEvidence();
    expect(hasInsufficientEvidence({ ...preScore, flags: [...preScore.flags, 'WEBSITE_UNAVAILABLE'] })).toBe(false);
  });

  it('is false for a fully read firm', () => {
    expect(hasInsufficientEvidence(fixtureResult().preScore)).toBe(false);
  });
});

describe('Quick Scan Report with too little evidence to rate', () => {
  it('prints no number and no tier, and says how many areas could be evaluated', () => {
    const html = renderQuickScanHtml(thinEvidence(), 'PARTIAL');
    expect(html).toContain('Not enough evidence to rate');
    expect(html).toContain('We could evaluate only 1 of 4 areas from public sources, so we are not showing a score. ' +
      'A full assessment fills in what public sources cannot show.');
    expect(html).not.toMatch(/<small> \/ 100/);
    expect(html).not.toContain('CRITICAL');
    expect(html).not.toContain('Very few positive public signals');
    expect(html).not.toMatch(/Confidence: low/);
  });

  it('keeps the categories, the findings and the sources, and does not speak of a score it does not show', () => {
    const html = renderQuickScanHtml(thinEvidence(), 'PARTIAL');
    expect(html).toContain('Professional Standing');
    expect(html).toContain('3 / 30');
    expect(html).toContain('Avvo: not searched; we could not look the firm up there');
    expect(html).toMatch(/not enough public evidence yet for an underwriting decision/i);
    expect(html).toContain('<li>Some sources did not answer in full.</li>');
    expect(html).not.toMatch(/score rests on partial evidence/);
    expect(html).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  it('says no area could be evaluated when none was', () => {
    const result = thinEvidence();
    result.preScore.categories.professionalStanding = { ...result.preScore.categories.reputation, max: 30 };
    expect(renderQuickScanHtml(result, 'PARTIAL'))
      .toContain('We could not evaluate any of the 4 areas from public sources, so we are not showing a score.');
  });

  it('rates the firm as before once two categories could be evaluated', () => {
    const result = thinEvidence();
    result.preScore.categories.reputation = { ...result.preScore.categories.reputation, score: 10, status: 'KNOWN' };
    const html = renderQuickScanHtml(result, 'PARTIAL');
    expect(html).toMatch(/>3<small> \/ 100/);
    expect(html).toContain('CRITICAL');
    expect(html).not.toContain('Not enough evidence to rate');
  });

  it('gives an unreadable website its own words, whatever else is thin', () => {
    const result = thinEvidence();
    result.preScore.flags = [...result.preScore.flags, 'WEBSITE_UNAVAILABLE'];
    const html = renderQuickScanHtml(result, 'PARTIAL');
    expect(html).toContain('No score from public evidence');
    expect(html).not.toContain('Not enough evidence to rate');
    expect(html).not.toContain('CRITICAL');
    expect(html).not.toMatch(/>3<small> \/ 100/);
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
