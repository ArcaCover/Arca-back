import { describe, expect, it } from 'vitest';
import { ScanMeter, meterScan, scanCostLine, scanMeter } from '../../src/pipeline/scan-cost.js';

// DN-12 §5.4: what one pipeline run spent, and the one log line that says it.
describe('scan cost meter', () => {
  it('starts at nothing spent, with the tokens unknown rather than zero', () => {
    expect(new ScanMeter().cost()).toEqual({
      apify: { started: 0, refused: 0, resumed: 0, chargedUsd: 0, reservedUsd: 0, cachedUsd: 0 },
      openai: { requests: 0, inputTokens: null, outputTokens: null },
      cacheHits: { apifyRuns: 0, websiteAnalysis: false } });
  });

  it('adds up what the Apify client and the model client report', () => {
    const meter = new ScanMeter();
    meter.apifyStarted(1); meter.apifyCharged(.1); meter.apifyStarted(1); meter.apifyCharged(.2);
    // A run whose cost Apify has not reported yet adds nothing to what was charged.
    meter.apifyStarted(1); meter.apifyCharged(null);
    meter.apifyCached(.045); meter.apifyCached(null); meter.apifyResumed(); meter.apifyRefused(); meter.apifyRefused();
    for (let request = 0; request < 3; request++) meter.openAiRequested();
    meter.openAiAnswered({ usage: { prompt_tokens: 1200, completion_tokens: 300 } });
    meter.openAiAnswered({ usage: { prompt_tokens: 800, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 40 } } });
    // An answer without a usage block, and one that failed, leave the totals as they were.
    meter.openAiAnswered({ choices: [] }); meter.openAiAnswered(null);
    meter.websiteAnalysisReused();
    expect(meter.cost()).toEqual({
      // 0.1 + 0.2 is 0.30000000000000004 in floating point; the line carries 0.3.
      apify: { started: 3, refused: 2, resumed: 1, chargedUsd: .3, reservedUsd: 3, cachedUsd: .045 },
      openai: { requests: 3, inputTokens: 2000, outputTokens: 400 },
      cacheHits: { apifyRuns: 2, websiteAnalysis: true } });
  });

  it('gives each scan its own meter, however their work interleaves, and none outside a scan', async () => {
    expect(scanMeter()).toBeUndefined();
    const scan = (requests: number) => {
      const meter = new ScanMeter();
      return meterScan(meter, async () => {
        for (let request = 0; request < requests; request++) {
          await new Promise(resolve => setTimeout(resolve, 1));
          scanMeter()!.openAiRequested();
        }
        expect(scanMeter()).toBe(meter);
        return meter.cost().openai.requests;
      });
    };
    expect(await Promise.all([scan(5), scan(2), scan(9)])).toEqual([5, 2, 9]);
    expect(scanMeter()).toBeUndefined();
  });

  it('writes one tagged JSON line that names the scan by its id only', () => {
    const line = scanCostLine({ scanId: 'sc_1', status: 'PARTIAL', durationMs: 73_500 }, new ScanMeter().cost());
    expect(line.startsWith('[scan-cost] {')).toBe(true);
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line.slice('[scan-cost] '.length));
    expect(Object.keys(parsed)).toEqual(['scanId', 'status', 'durationMs', 'apify', 'openai', 'cacheHits']);
    expect(parsed).toMatchObject({ scanId: 'sc_1', status: 'PARTIAL', durationMs: 73_500 });
  });
});
