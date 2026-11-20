import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileReport } from '../../src/webapp/billing-events.js';
import { RECONCILE_FIRST_DELAY_MS, RECONCILE_INTERVAL_MS, scheduleReconciliation } from '../../src/webapp/reconcile-schedule.js';

// The daily Stripe reconciliation of DN-13 §9.5 (T26), as server.ts schedules it: once shortly after start and then once a day, one
// run at a time, never taking the process down, and one `[billing]` line per run for the CloudWatch alarms.
const DAY = 24 * 60 * 60 * 1000;
const REPORT: ReconcileReport = { checked: 3, mismatched: 1, applied: 1, failed: 0 };

describe('the scheduled billing reconciliation (DN-13 §9.5, T26)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const lines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map(call => call.join(' '));

  it('runs a few minutes after start and then once a day', async () => {
    expect(RECONCILE_FIRST_DELAY_MS).toBeGreaterThanOrEqual(60_000);
    expect(RECONCILE_FIRST_DELAY_MS).toBeLessThanOrEqual(15 * 60_000);
    expect(RECONCILE_INTERVAL_MS).toBe(DAY);
    const reconcile = vi.fn(async () => REPORT);
    const schedule = scheduleReconciliation(reconcile);
    await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_DELAY_MS - 1);
    expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(reconcile).toHaveBeenCalledTimes(5);
    schedule.stop();
  });

  it('logs one structured [billing] line per run with the counts of its report', async () => {
    let clock = 0;
    const reconcile = vi.fn(async () => { clock += 1234; return REPORT; });
    const schedule = scheduleReconciliation(reconcile, { now: () => clock });
    await vi.advanceTimersByTimeAsync(RECONCILE_FIRST_DELAY_MS);
    expect(lines(log)).toEqual(['[billing] reconcile done checked=3 mismatched=1 applied=1 failed=0 duration_ms=1234']);
    expect(error).not.toHaveBeenCalled();
    schedule.stop();
  });

  it('never overlaps: the next run waits for the one still going', async () => {
    let release!: () => void;
    const reconcile = vi.fn(() => new Promise<ReconcileReport>(resolve => { release = () => resolve(REPORT); }));
    const schedule = scheduleReconciliation(reconcile, { firstDelayMs: 1000, intervalMs: DAY });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    // A run stuck for three days starts no other.
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(reconcile).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines(log)).toHaveLength(1);
    // The next one is a day after that run ended.
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    schedule.stop();
  });

  it('logs a distinct line when a run fails, by the error name only, and keeps the schedule', async () => {
    const reconcile = vi.fn<() => Promise<ReconcileReport>>()
      .mockRejectedValueOnce(Object.assign(new Error('Invalid API Key provided: rk_test_****1234'), { name: 'BillingUnavailable' }))
      .mockImplementationOnce(() => { throw new TypeError('not even a promise'); })
      .mockResolvedValue(REPORT);
    const schedule = scheduleReconciliation(reconcile, { firstDelayMs: 1000, intervalMs: DAY });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(lines(error)).toEqual(['[billing] reconcile failed (BillingUnavailable); next run in 24 h',
      '[billing] reconcile failed (TypeError); next run in 24 h']);
    expect(lines(error).join(' ')).not.toMatch(/rk_test|Invalid API Key/);
    expect(lines(log)).toEqual([]);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(lines(log)).toEqual([expect.stringMatching(/^\[billing\] reconcile done checked=3 /)]);
    schedule.stop();
  });

  it('stops: no run after stop, and a run in flight schedules no other', async () => {
    const reconcile = vi.fn(async () => REPORT);
    scheduleReconciliation(reconcile, { firstDelayMs: 1000, intervalMs: DAY }).stop();
    await vi.advanceTimersByTimeAsync(10 * DAY);
    expect(reconcile).not.toHaveBeenCalled();
    let release!: () => void;
    const slow = vi.fn(() => new Promise<ReconcileReport>(resolve => { release = () => resolve(REPORT); }));
    const schedule = scheduleReconciliation(slow, { firstDelayMs: 1000, intervalMs: DAY });
    await vi.advanceTimersByTimeAsync(1000);
    schedule.stop();
    release();
    await vi.advanceTimersByTimeAsync(10 * DAY);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('never holds the process open', async () => {
    const unref = vi.fn();
    const setTimer = vi.fn((_run: () => void, _ms: number) => ({ unref }) as unknown as ReturnType<typeof setTimeout>);
    scheduleReconciliation(async () => REPORT, { setTimer, clearTimer: () => undefined });
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), RECONCILE_FIRST_DELAY_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
