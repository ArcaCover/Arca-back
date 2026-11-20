import type Stripe from 'stripe';
import { CATALOG_PRODUCT_ID, catalogPrice, catalogProduct, createCatalogPrice, retirePrice } from './stripe.js';
import type { PlanRecord, WebappRepository } from './types.js';

/** A refusal of `npm run stripe:catalog` that the script prints as it is: what to set or which flag to add. */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

export type CatalogArgs = { apply: boolean; allowLive: boolean };
/** `--apply` creates and writes (the default is a dry run); `--allow-live` lets a live key through. Nothing else is accepted. */
export function parseCatalogArgs(argv: readonly string[]): CatalogArgs {
  const args: CatalogArgs = { apply: false, allowLive: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-live') args.allowLive = true;
    else throw new CatalogError(`Unknown argument ${arg}. Usage: npm run stripe:catalog [-- --apply] [--allow-live]`);
  }
  return args;
}

export type CatalogPlanReport = { code: string; priceId: string | null; price: 'exists' | 'created' | 'would_create'; amountCents: number;
  currency: string; interval: 'month' | 'year'; plan: 'written' | 'unchanged' | 'would_write' };
export type CatalogReport = { productId: string; product: 'exists' | 'created' | 'would_create'; plans: CatalogPlanReport[] };

/**
 * The Stripe catalog of DN-13 §6.1 for the plans of plans.ts (T13): the Product `arca` and, per plan, an active recurring Price with
 * the lookup key `arca_<code>`, `plan_code` in its metadata, and the amount, currency and interval the plans table holds (the
 * seed's example prices unless an admin changed them). A price that already matches is kept; one with another amount gets a new
 * price that takes the lookup key, and the old one is archived (its subscribers keep paying it, F2). Then the plans table points
 * each plan at its price.
 *
 * A dry run (the default) only reads: it says what it would create and write. It refuses a live key without `allowLive`, and
 * `apply` without the plans table, before calling Stripe. It logs ids, amounts and the mode; never a key.
 */
export async function syncStripeCatalog(input: { stripe: Stripe; mode: 'test' | 'live'; plans: readonly PlanRecord[];
  repository: WebappRepository | null; apply: boolean; allowLive: boolean; log: (line: string) => void }): Promise<CatalogReport> {
  const { stripe, repository, apply, log } = input;
  if (input.mode === 'live' && !input.allowLive) {
    throw new CatalogError('This is a live Stripe key: the live catalog is the founder\'s call (DN-13 T23). Add --allow-live only with that approval');
  }
  if (apply && !repository) {
    throw new CatalogError('--apply writes the price ids to the plans table: set SUPABASE_URL and SUPABASE_SECRET_KEY of the database whose plans they are');
  }
  log(`Stripe ${input.mode} mode${apply ? '' : ' (dry run: nothing is created or written; add --apply)'}`);
  const found = await catalogProduct(stripe, apply);
  const productId = found?.productId ?? CATALOG_PRODUCT_ID;
  const product = found ? (found.existed ? 'exists' : 'created') : 'would_create';
  log(`product ${productId}: ${product}`);
  const plans: CatalogPlanReport[] = [];
  for (const seed of input.plans) {
    const plan = (repository && await repository.getPlan(seed.code)) || seed;
    const price = { planCode: plan.code, amountCents: plan.amount_cents, currency: plan.currency, interval: plan.interval };
    const { match, holder } = await catalogPrice(stripe, price);
    let priceId: string | null = match?.id ?? null;
    let priceAction: CatalogPlanReport['price'] = match ? 'exists' : 'would_create';
    if (!match && apply) {
      const created = await createCatalogPrice(stripe, { ...price, productId, replaces: holder?.id ?? plan.stripe_price_id });
      if (holder && holder.id !== created.id) await retirePrice(stripe, holder.id);
      [priceId, priceAction] = [created.id, 'created'];
    }
    const current = priceId !== null && plan.stripe_price_id === priceId && plan.stripe_product_id === productId;
    let planAction: CatalogPlanReport['plan'] = current ? 'unchanged' : 'would_write';
    if (!current && apply && priceId) {
      await repository!.updatePlan(plan.code, { stripe_price_id: priceId, stripe_product_id: productId });
      planAction = 'written';
    }
    plans.push({ code: plan.code, priceId, price: priceAction, amountCents: plan.amount_cents, currency: plan.currency, interval: plan.interval,
      plan: planAction });
    log(`${plan.code}: ${plan.amount_cents} ${plan.currency}/${plan.interval}, price ${priceId ?? '(new)'} ${priceAction}; `
      + `plans.${plan.code}.stripe_price_id ${planAction}`);
  }
  return { productId, product, plans };
}
