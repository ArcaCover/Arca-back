import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Layer1Result, type PipelineResult } from '@arca/contracts';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { InProcessPipeline } from '../../src/pipeline/in-process-pipeline.js';
import { WebsiteExtractionSource } from '../../src/pipeline/website-source.js';
import { AgenticEvidenceProvider } from '../../src/pipeline/agentic-evidence-provider.js';
import { ApifyClient } from '../../src/pipeline/apify-client.js';
import { ApifyDirectorySource } from '../../src/pipeline/directories.js';
import type { CrawledPage } from '../../src/pipeline/crawler.js';
import { canonicalJson, replayAccess, replayApify, replayModel, type ApifyRecording, type ModelRecordings } from '../fixtures/replay/replay.js';
import { ACCESS_PAGES, DOMAIN, PAGES, SITEMAP, withChangedText, withHtmlNoise } from '../fixtures/replay/harbor-vale/site.js';
import { scriptedModel } from '../fixtures/replay/harbor-vale/scripted-model.js';

// DN-12 §4.5. The real pipeline (website source, agentic extraction, grounding, Apify client and ledger, directory
// sources, scoring) over recordings: no network, no Chromium, no provider. A model response is found by the hash of
// its prompt, so a prompt that changes by one character has no recording and the test names it. After a deliberate
// change to a prompt or to the corpus, record again:
//   REPLAY_RECORD=1 npx vitest run apps/api/tests/integration/replay-determinism.test.ts
// That run answers from fixtures/replay/harbor-vale/scripted-model.ts, hand-written answers, never from a model.
const RECORDING = process.env.REPLAY_RECORD === '1';
const fixture = (name: string) => new URL(`../fixtures/replay/harbor-vale/${name}`, import.meta.url);
const model: ModelRecordings = RECORDING ? {} : JSON.parse(readFileSync(fixture('llm.json'), 'utf8'));
const apifyRecordings: ApifyRecording[] = JSON.parse(readFileSync(fixture('apify.json'), 'utf8'));
afterAll(() => {
  if (RECORDING) writeFileSync(fixture('llm.json'), `${JSON.stringify(Object.fromEntries(Object.entries(model).sort(([a], [b]) => a < b ? -1 : 1)), null, 1)}\n`);
});

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
let scans = 0;
/** One scan through the real pipeline, stored the way POST /scan stores it. Every scan gets fresh clients and counters. */
async function scan(repository: InMemoryRepository, pages: CrawledPage[] = PAGES) {
  const llm = replayModel(model, RECORDING ? scriptedModel : undefined), reader = replayAccess(ACCESS_PAGES, SITEMAP), apify = replayApify(apifyRecordings);
  const website = new WebsiteExtractionSource(repository,
    new AgenticEvidenceProvider('replay-key', undefined, llm.client, reader.access),
    async () => ({ pages: structuredClone(pages), partial: false, issues: [], aborted: false }), { now: () => NOW });
  const client = new ApifyClient('replay-token', apify.request, 16, { store: repository });
  const pipeline = new InProcessPipeline({ website, bar: new ApifyDirectorySource('bar', client), avvo: new ApifyDirectorySource('avvo', client),
    repository, timeoutMs: 30_000, now: () => NOW });
  const scanId = `sc_replay${++scans}`, at = new Date(NOW).toISOString();
  await repository.create({ id: scanId, scan_id: scanId, email: 'owner@harborvale.example', canonical_domain: DOMAIN,
    domain_resolution: { status: 'RESOLVED', canonicalDomain: DOMAIN, source: 'request', reason: null },
    status: 'RUNNING', result: null, created_at: at, completed_at: null, duration_ms: null, cached: false });
  const outcome = await pipeline.run({ scanId, canonicalDomain: DOMAIN, email: 'owner@harborvale.example' });
  await repository.complete(scanId, { status: outcome.status, result: outcome.result, completed_at: outcome.result.meta.completedAt,
    duration_ms: outcome.result.meta.scanDurationMs });
  // Anything the recordings did not hold: a drifted prompt, an unrecorded page or an unrecorded directory query.
  expect([...llm.unexpected, ...reader.unexpected, ...apify.unexpected]).toEqual([]);
  return { outcome, llm, reader, apify };
}
/** A result without what legitimately differs between two runs: ids, timestamps and durations. */
function comparable({ status, result }: PipelineResult) {
  const { scanId: _scanId, meta: { completedAt: _completedAt, scanDurationMs: _duration, ...meta }, sources, ...rest } = result;
  return canonicalJson({ status, ...rest, meta, sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    const { durationMs: _durationMs, ...kept } = source;
    return [name, kept];
  })) });
}

describe('the real pipeline replayed from recordings', () => {
  it('reads the hand-written firm into a complete, sufficient result', async () => {
    const { outcome, llm, reader, apify } = await scan(new InMemoryRepository());
    expect(Layer1Result.parse(outcome.result)).toEqual(outcome.result);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.result.identity).toMatchObject({ status: 'VERIFIED', firmName: 'Harbor Vale Law', city: 'Miami',
      attorneyNames: ['Daniel Harbor', 'Maria Vale'] });
    expect(outcome.result.signals.website).toMatchObject({ W1_aiPolicy: { found: true, depth: 'basic' },
      W2_aiInServices: { found: true, tools: ['CoCounsel'] }, W3_aiDisclosure: { found: true },
      W5a_teamPageQuality: 'detailed', W6_privacyPolicy: { found: true, mentionsClientData: true }, W7_websiteQuality: 'robust',
      W8_firmEstablished: 2009, W9_practiceAreas: ['Family Law', 'Immigration'] });
    expect(outcome.result.signals.bar).toMatchObject({ B1_allActive: true });
    expect(outcome.result.signals.avvo.A1_avgRating).toBeCloseTo(8.8);
    expect(outcome.result.sources).toMatchObject({ website: { status: 'ok', pagesCrawled: 4 }, bar: { status: 'ok', attorneysFound: 2 },
      avvo: { status: 'ok', attorneysFound: 2 } });
    // The whole workflow ran: three page-type votes, one extraction round, the roster, and two reviews.
    expect(llm.calls).toHaveLength(7);
    expect(reader.fetched).toEqual([`https://${DOMAIN}/about`, `https://${DOMAIN}/contact`]);
    expect(apify.posts).toHaveLength(4);
  });

  it('gives two fresh runs the same result, apart from ids, timestamps and durations', async () => {
    const a = await scan(new InMemoryRepository()), b = await scan(new InMemoryRepository());
    expect(a.outcome.result.scanId).not.toBe(b.outcome.result.scanId);
    expect(comparable(b.outcome)).toBe(comparable(a.outcome));
  });

  it('runs again on the same storage without a model call or an actor start, and scores the same', async () => {
    const repository = new InMemoryRepository();
    const a = await scan(repository), c = await scan(repository);
    expect(a.llm.calls.length).toBeGreaterThan(0);
    expect(c.llm.calls).toEqual([]);
    expect(c.reader.fetched).toEqual([]);
    expect(c.apify.posts).toEqual([]);
    expect(c.apify.requests).toEqual([]);
    expect(c.outcome.status).toBe(a.outcome.status);
    expect(c.outcome.result.preScore).toEqual(a.outcome.result.preScore);
    expect(c.outcome.result.signals).toEqual(a.outcome.result.signals);
    expect(c.outcome.result.preScore.flags).toEqual(a.outcome.result.preScore.flags);
    expect(c.outcome.result.identity).toEqual(a.outcome.result.identity);
    // What does differ is the account of the run itself: nothing was paid for the second time.
    expect(a.outcome.result.sources.bar).toMatchObject({ cachedRuns: 0 });
    expect(c.outcome.result.sources.bar).toMatchObject({ cachedRuns: 2, costUsd: 0 });
  });

  it('still reuses the signals when the HTML of every page changed but nothing it says did', async () => {
    const repository = new InMemoryRepository();
    const a = await scan(repository);
    const d = await scan(repository, withHtmlNoise(PAGES, '09f3a1'));
    const again = await scan(repository, withHtmlNoise(PAGES, '10c7e2').reverse());
    for (const later of [d, again]) {
      expect(later.llm.calls).toEqual([]);
      expect(later.apify.posts).toEqual([]);
      expect(later.outcome.result.preScore).toEqual(a.outcome.result.preScore);
      expect(later.outcome.result.signals).toEqual(a.outcome.result.signals);
    }
  });

  it('reads the site again when a page says something else', async () => {
    const repository = new InMemoryRepository();
    const a = await scan(repository);
    const e = await scan(repository, withChangedText(PAGES));
    expect(e.llm.calls.length).toBeGreaterThan(0);
    expect(e.outcome.result.signals.website.W9_practiceAreas).toEqual(['Family Law', 'Immigration', 'Personal Injury']);
    expect(a.outcome.result.signals.website.W9_practiceAreas).toEqual(['Family Law', 'Immigration']);
    // The firm and its attorneys read the same, so the directory answers are the ones already paid for.
    expect(e.apify.posts).toEqual([]);
    expect(e.outcome.result.signals.bar).toEqual(a.outcome.result.signals.bar);
  });
});
