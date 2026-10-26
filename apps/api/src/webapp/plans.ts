import type { PlanRecord } from './types.js';

// The price lives in the plans table (DN-10 §4.4); these are only the seed. Example prices, to be changed there.
export const DEFAULT_PLANS: readonly PlanRecord[] = Object.freeze([
  Object.freeze<PlanRecord>({ code: 'monthly', name: 'Monthly (example price)', amount_cents: 49_900, currency: 'usd', interval: 'month', active: true }),
  Object.freeze<PlanRecord>({ code: 'annual', name: 'Annual (example price)', amount_cents: 499_000, currency: 'usd', interval: 'year', active: true }),
]);
