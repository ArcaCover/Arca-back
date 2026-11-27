import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentView, isUnderwritingResult, type AnswerValue } from '@arca/contracts';
import { fixtureResult } from '../../../../packages/contracts/tests/fixture.js';
import { SupabaseAssessmentRepository } from '../../src/assessment/repository.js';
import { AssessmentService } from '../../src/assessment/service.js';
import type { ScanRecord } from '../../src/repositories/types.js';
import { pglitePostgrest } from '../fixtures/pglite-postgrest.js';

// Bank 4.0 (DN-14) against the real assessment tables, their guards and their RPCs, through supabase-js and the PostgREST
// stand-in over PGlite: a record that starts READY with its plan, answers saved one by one, a profile change that
// invalidates answers with their events, and completion. The in-memory repository alone cannot prove the guards accept it.
const directory = new URL('../../../../supabase/migrations/', import.meta.url);
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const one = (optionId: string): AnswerValue => ({ kind: 'option', optionId });
const many = (...optionIds: string[]): AnswerValue => ({ kind: 'options', optionIds });
const answers: Record<string, AnswerValue> = {
  G1: many('G1-legal-research', 'G1-case-software'), G2: many('G2-research'), C1: many('C1-none'), C2: one('C2-yes'),
  F1: one('F1-6-15'), C3: one('C3-never'), 'P3-1': one('P31-always'), 'P3-2': one('P32-always'), 'DG-1': one('DG1-anon'),
  'P3-3': one('P33-owner'), 'P1-1': one('P11-review-before'), 'P1-2': one('P12-isolated'), 'P1-4': one('P14-reviewed'),
};

describe('bank 4.0 on the assessment tables', () => {
  let db: PGlite;
  let service: AssessmentService;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(name, directory), 'utf8'));
    }
    const client = createClient('http://pglite.test', 'sb_secret_fixture',
      { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: pglitePostgrest(db) } });
    service = new AssessmentService({ repository: new SupabaseAssessmentRepository(client), now: () => NOW, engine: 'underwriting' });
  });
  afterAll(async () => { await db?.close(); });

  async function scan(scanId: string): Promise<ScanRecord> {
    const result = fixtureResult({ scanId });
    await db.query(`insert into public.scans (scan_id,email,canonical_domain,domain_resolution,status,result,created_at,completed_at)
      values ($1,'contact@smithlaw.com','smithlaw.com',$2,'COMPLETED',$3,$4,$4)`,
    [scanId, JSON.stringify({ status: 'RESOLVED', canonicalDomain: 'smithlaw.com', source: 'request', reason: null }),
      JSON.stringify(result), new Date(NOW - 60_000).toISOString()]);
    return { id: scanId, scan_id: scanId, email: 'contact@smithlaw.com', canonical_domain: 'smithlaw.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'smithlaw.com', source: 'request', reason: null },
      status: 'COMPLETED', result, created_at: new Date(NOW - 60_000).toISOString(), completed_at: new Date(NOW - 60_000).toISOString(),
      duration_ms: 1000, cached: false };
  }
  async function answerPending(id: string) {
    for (let i = 0; i < 20; i++) {
      const view = AssessmentView.parse(service.view(await service.get(id)));
      const pending = view.questions.find(q => !view.answers[q.id]);
      if (!pending) return view;
      await service.save(id, pending.id, answers[pending.id]!);
    }
    throw new Error('Too many questions');
  }

  it('creates the record READY, saves, invalidates on a profile change with its events, and completes', async () => {
    const started = await service.start(await scan('sc_uwdb1'));
    expect(started.status).toBe('READY');
    expect(started.bank_version).toBe('4.0');
    await answerPending(started.id);
    // G2 now says client-facing only: the P3 questions are no longer asked, and each loses its answer with an event.
    await service.save(started.id, 'G2', many('G2-client-questions'));
    const events = (await db.query<{ question_id: string; kind: string }>(
      'select question_id, kind from public.assessment_answer_events where assessment_id=$1 order by id', [started.id])).rows;
    expect(events.filter(e => e.kind === 'invalidated').map(e => e.question_id).sort()).toEqual(['P3-1', 'P3-2', 'P3-3']);
    const view = await answerPending(started.id);
    expect(view.questions.map(q => q.id)).toContain('P1-1');
    const result = await service.complete(started.id);
    expect(isUnderwritingResult(result) && result.exposure.usageProfile).toBe('P1');
    const stored = (await db.query<{ status: string; result: { audit: { decisionRuleFired: string } } }>(
      'select status, result from public.assessments where id=$1', [started.id])).rows[0]!;
    expect(stored.status).toBe('COMPLETED');
    expect(stored.result.audit.decisionRuleFired).toBeTruthy();
    // Completed records are immutable: a later save is refused by the service, and the table's guard stands behind it.
    await expect(service.save(started.id, 'C2', one('C2-no'))).rejects.toMatchObject({ code: 'already_completed' });
  });
});
