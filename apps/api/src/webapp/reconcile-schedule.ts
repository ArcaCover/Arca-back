import type { ReconcileReport } from './billing-events.js';

/** The first run, a few minutes after start: the process is serving by then, and a deploy does not wait a day to reconcile. */
export const RECONCILE_FIRST_DELAY_MS = 5 * 60 * 1000;
/** Then once a day, counted from the end of the previous run. The reconciliation reads 48 hours, so a missed day loses nothing. */
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;

/**
 * Schedules the daily Stripe reconciliation of the real webapp (DN-13 §9.5, T26) in this process. The next run is set only when the
 * previous one ends, so two never overlap, however long one takes. A run that throws or rejects never reaches the process: it is
 * logged and the schedule goes on. Each run logs exactly one line, which the CloudWatch metric filters of infra/aws read:
 *
 *   [billing] reconcile done checked=<n> mismatched=<n> applied=<n> failed=<n> duration_ms=<n>
 *   [billing] reconcile failed (<error name>); next run in 24 h
 *
 * Only the error's name is logged, never its message (Stripe's may quote a masked key). The timers are unref'd, so the schedule
 * never keeps a stopping process alive; `stop` cancels the next run and an in-flight one schedules no other.
 */
export function scheduleReconciliation(reconcile: () => Promise<ReconcileReport>, options: { firstDelayMs?: number; intervalMs?: number;
  now?: () => number; setTimer?: (run: () => void, ms: number) => Timer; clearTimer?: (timer: Timer) => void } = {}) {
  const intervalMs = options.intervalMs ?? RECONCILE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: Timer) => clearTimeout(timer));
  let timer: Timer | null = null;
  let stopped = false;
  const hours = Math.round(intervalMs / 3_600_000);

  const next = (ms: number) => {
    if (stopped) return;
    timer = setTimer(() => { timer = null; void run(); }, ms);
    timer.unref?.();
  };
  const run = async () => {
    const started = now();
    try {
      const report = await reconcile();
      console.log(`[billing] reconcile done checked=${report.checked} mismatched=${report.mismatched} applied=${report.applied} `
        + `failed=${report.failed} duration_ms=${now() - started}`);
    } catch (error) {
      console.error(`[billing] reconcile failed (${error instanceof Error ? error.name : 'unknown error'}); next run in ${hours} h`);
    }
    next(intervalMs);
  };

  next(options.firstDelayMs ?? RECONCILE_FIRST_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
