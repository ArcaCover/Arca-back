import { describe, expect, it } from 'vitest';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { CatalogError, parseCatalogArgs, syncStripeCatalog } from '../../src/webapp/stripe-catalog.js';
import { stripeClient } from '../../src/webapp/stripe.js';
import type { PlanRecord } from '../../src/webapp/types.js';
import { fakeStripe } from '../fixtures/stripe.js';

// npm run stripe:catalog (DN-13 §6.1, T13): the Product and the monthly and annual Prices of plans.ts at Stripe, and their ids in
// the plans table. Against a fake Stripe; no network.
const KEY = 'rk_test_catalogsecret';

function setup(options: { mode?: 'test' | 'live'; plans?: PlanRecord[] } = {}) {
  const stripe = fakeStripe({ livemode: options.mode === 'live' });
  const repository = new InMemoryWebappRepository(options.plans ?? DEFAULT_PLANS);
  const lines: string[] = [];
  const run = (input: { apply?: boolean; allowLive?: boolean; repository?: InMemoryWebappRepository | null } = {}) => syncStripeCatalog({
    stripe: stripeClient(KEY, { fetch: stripe.fetch, maxNetworkRetries: 0 }), mode: options.mode ?? 'test', plans: DEFAULT_PLANS,
    repository: input.repository === undefined ? repository : input.repository, apply: input.apply ?? false, allowLive: input.allowLive ?? false,
    log: line => lines.push(line) });
  return { stripe, repository, lines, run };
}

describe('stripe:catalog', () => {
  it('reads its flags: a dry run unless --apply, and live keys only with --allow-live', () => {
    expect(parseCatalogArgs([])).toEqual({ apply: false, allowLive: false });
    expect(parseCatalogArgs(['--apply'])).toEqual({ apply: true, allowLive: false });
    expect(parseCatalogArgs(['--apply', '--allow-live'])).toEqual({ apply: true, allowLive: true });
    expect(() => parseCatalogArgs(['--force'])).toThrow(CatalogError);
  });

  it('by default only says what it would create, and creates and writes nothing', async () => {
    const { stripe, repository, lines, run } = setup();
    const report = await run();
    expect(report).toEqual({ productId: 'arca', product: 'would_create', plans: [
      { code: 'monthly', priceId: null, price: 'would_create', amountCents: 49_900, currency: 'usd', interval: 'month', plan: 'would_write' },
      { code: 'annual', priceId: null, price: 'would_create', amountCents: 499_000, currency: 'usd', interval: 'year', plan: 'would_write' }] });
    expect(stripe.writes()).toEqual([]);
    expect(await repository.getPlan('monthly')).toMatchObject({ stripe_price_id: null, stripe_product_id: null });
    expect(lines.join('\n')).toMatch(/dry run/i);
  });

  it('with --apply creates the product and one price per plan with its lookup key, writes their ids, and is idempotent', async () => {
    const { stripe, repository, run } = setup();
    const report = await run({ apply: true });
    expect(stripe.products.get('arca')).toMatchObject({ name: 'ARCA' });
    const monthly = (await repository.getPlan('monthly'))!;
    const annual = (await repository.getPlan('annual'))!;
    expect(monthly).toMatchObject({ stripe_product_id: 'arca', stripe_price_id: expect.stringMatching(/^price_/) });
    expect(stripe.prices.get(monthly.stripe_price_id!)).toMatchObject({ unit_amount: 49_900, currency: 'usd', lookup_key: 'arca_monthly',
      product: 'arca', metadata: { plan_code: 'monthly' }, recurring: { interval: 'month' } });
    expect(stripe.prices.get(annual.stripe_price_id!)).toMatchObject({ unit_amount: 499_000, lookup_key: 'arca_annual', recurring: { interval: 'year' } });
    expect(report.plans.map(plan => [plan.code, plan.price, plan.plan])).toEqual([['monthly', 'created', 'written'], ['annual', 'created', 'written']]);
    const writes = stripe.writes().length;
    const again = await run({ apply: true });
    expect(stripe.writes().length).toBe(writes);
    expect(again).toMatchObject({ product: 'exists', plans: [{ price: 'exists', plan: 'unchanged', priceId: monthly.stripe_price_id },
      { price: 'exists', plan: 'unchanged', priceId: annual.stripe_price_id }] });
  });

  it('takes the amount the plans table holds, and gives a changed amount a new price with the lookup key', async () => {
    const { stripe, repository, run } = setup();
    await run({ apply: true });
    const old = (await repository.getPlan('monthly'))!.stripe_price_id!;
    await repository.updatePlan('monthly', { amount_cents: 59_900 });
    await run({ apply: true });
    const fresh = (await repository.getPlan('monthly'))!.stripe_price_id!;
    expect(fresh).not.toBe(old);
    expect(stripe.prices.get(fresh)).toMatchObject({ unit_amount: 59_900, lookup_key: 'arca_monthly' });
    expect(stripe.prices.get(old)).toMatchObject({ lookup_key: null });
  });

  // One Supabase project serves the test key of development and the live key of production (DN-13 §20): each run writes the ids of
  // its own mode and leaves the other mode's.
  it('with a live key and --allow-live writes the live pair, and leaves the test ids where they are', async () => {
    const withTestIds = DEFAULT_PLANS.map(plan => ({ ...plan, stripe_product_id: 'arca', stripe_price_id: `price_1Test${plan.code}` }));
    const { stripe, repository, lines, run } = setup({ mode: 'live', plans: withTestIds });
    const report = await run({ apply: true, allowLive: true });
    const monthly = (await repository.getPlan('monthly'))!;
    expect(monthly).toMatchObject({ stripe_product_id: 'arca', stripe_price_id: 'price_1Testmonthly', stripe_live_product_id: 'arca',
      stripe_live_price_id: expect.stringMatching(/^price_/) });
    expect(stripe.prices.get(monthly.stripe_live_price_id!)).toMatchObject({ livemode: true, lookup_key: 'arca_monthly', unit_amount: 49_900 });
    expect((await repository.getPlan('annual'))).toMatchObject({ stripe_price_id: 'price_1Testannual', stripe_live_price_id: expect.stringMatching(/^price_/) });
    expect(report.plans.map(plan => [plan.code, plan.price, plan.plan])).toEqual([['monthly', 'created', 'written'], ['annual', 'created', 'written']]);
    const printed = lines.join(' | ');
    expect(printed).toMatch(/Stripe live mode/);
    expect(printed).toMatch(/plans\.monthly\.stripe_live_price_id written/);
    // Idempotent in its mode too: the live ids it wrote are current.
    const again = await run({ apply: true, allowLive: true });
    expect(again.plans.map(plan => plan.plan)).toEqual(['unchanged', 'unchanged']);
  });

  it('with a test key writes the test pair and never touches the live one', async () => {
    const withLiveIds = DEFAULT_PLANS.map(plan => ({ ...plan, stripe_live_product_id: 'arca', stripe_live_price_id: `price_1Live${plan.code}` }));
    const { repository, lines, run } = setup({ plans: withLiveIds });
    await run({ apply: true });
    expect(await repository.getPlan('monthly')).toMatchObject({ stripe_price_id: expect.stringMatching(/^price_/), stripe_live_product_id: 'arca',
      stripe_live_price_id: 'price_1Livemonthly' });
    expect((await repository.getPlan('monthly'))!.stripe_price_id).not.toBe('price_1Livemonthly');
    expect(lines.join(' | ')).toMatch(/plans\.monthly\.stripe_price_id written/);
  });

  it('refuses a live key without --allow-live, and --apply without the plans table, before calling Stripe', async () => {
    const live = setup({ mode: 'live' });
    await expect(live.run({ apply: true })).rejects.toThrow(CatalogError);
    await expect(live.run()).rejects.toThrow(/--allow-live/);
    expect(live.stripe.calls).toEqual([]);
    const test = setup();
    await expect(test.run({ apply: true, repository: null })).rejects.toThrow(/SUPABASE/);
    expect(test.stripe.calls).toEqual([]);
    // A dry run works from plans.ts alone.
    await expect(test.run({ repository: null })).resolves.toMatchObject({ product: 'would_create' });
  });

  it('prints ids and amounts, never the key', async () => {
    const { lines, run } = setup();
    await run({ apply: true });
    const printed = lines.join('\n');
    expect(printed).toMatch(/price_/);
    expect(printed).not.toContain(KEY);
    expect(printed).not.toMatch(/(sk|rk)_(test|live)_/);
  });
});
