import type { PlanRecord } from './types.js';

// The price lives in the plans table (DN-10 §4.4); these are only the seed. Example prices, to be changed there. The Stripe ids are
// written by `npm run stripe:catalog -- --apply` (DN-13 §6.1).
export const DEFAULT_PLANS: readonly PlanRecord[] = Object.freeze([
  Object.freeze<PlanRecord>({ code: 'monthly', name: 'Monthly (example price)', amount_cents: 49_900, currency: 'usd', interval: 'month', active: true,
    stripe_product_id: null, stripe_price_id: null }),
  Object.freeze<PlanRecord>({ code: 'annual', name: 'Annual (example price)', amount_cents: 499_000, currency: 'usd', interval: 'year', active: true,
    stripe_product_id: null, stripe_price_id: null }),
]);
