import type { PlanRecord } from './types.js';

// The price lives in the plans table (DN-10 §4.4); these are only the seed. Example prices, to be changed there. The Stripe ids are
// written by `npm run stripe:catalog -- --apply` (DN-13 §6.1), each in the slot of the key's mode (§20).
export const DEFAULT_PLANS: readonly PlanRecord[] = Object.freeze([
  Object.freeze<PlanRecord>({ code: 'monthly', name: 'Monthly (example price)', amount_cents: 49_900, currency: 'usd', interval: 'month', active: true,
    stripe_product_id: null, stripe_price_id: null, stripe_live_product_id: null, stripe_live_price_id: null }),
  Object.freeze<PlanRecord>({ code: 'annual', name: 'Annual (example price)', amount_cents: 499_000, currency: 'usd', interval: 'year', active: true,
    stripe_product_id: null, stripe_price_id: null, stripe_live_product_id: null, stripe_live_price_id: null }),
]);

/** The Stripe mode whose catalog ids a plan holds (DN-13 §20). */
export type CatalogMode = 'test' | 'live';

/**
 * The mode of the catalog a billing provider charges: Stripe's own, and the test slot for the simulated provider, which charges no
 * catalog price but records the ids its admin price changes make where a test key would.
 */
export const catalogModeOf = (billingMode: 'simulated' | 'test' | 'live'): CatalogMode => billingMode === 'live' ? 'live' : 'test';

const COLUMNS = {
  test: { productId: 'stripe_product_id', priceId: 'stripe_price_id' },
  live: { productId: 'stripe_live_product_id', priceId: 'stripe_live_price_id' },
} as const satisfies Record<CatalogMode, { productId: keyof PlanRecord; priceId: keyof PlanRecord }>;

/** The column that holds a plan's catalog price in a mode, for the messages that send someone to fix it. */
export const priceColumnOf = (mode: CatalogMode) => COLUMNS[mode].priceId;

/**
 * A plan's catalog Product and Price in one Stripe mode (DN-13 §20). One database serves the test key of development and the live
 * key of production, so a plan keeps both: the test pair in stripe_product_id and stripe_price_id (where the ids were before there
 * were two modes), the live pair in stripe_live_product_id and stripe_live_price_id.
 */
export function catalogIdsOf(plan: PlanRecord, mode: CatalogMode): { productId: string | null; priceId: string | null } {
  return { productId: plan[COLUMNS[mode].productId], priceId: plan[COLUMNS[mode].priceId] };
}

/** The plans-table patch that writes catalog ids in one mode's slot and leaves the other mode's; an undefined id is not changed. */
export function catalogPatchOf(mode: CatalogMode, ids: { productId?: string | null; priceId?: string | null })
  : Partial<Pick<PlanRecord, 'stripe_product_id' | 'stripe_price_id' | 'stripe_live_product_id' | 'stripe_live_price_id'>> {
  return { [COLUMNS[mode].productId]: ids.productId, [COLUMNS[mode].priceId]: ids.priceId };
}
