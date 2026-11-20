import Stripe from 'stripe';
import { BillingUnavailable, type BillingProvider, type CustomerDetails, type ProviderCheckout, type ProviderEvent, type ProviderSubscription } from './billing.js';
import type { PlanRecord } from './types.js';

/**
 * The Stripe API version this code reads (DN-13 §6.5, §13): the one the SDK pins, written out so an SDK upgrade that moves it fails
 * the typecheck instead of changing the shape of the objects underneath. The webhook endpoints are created with this same version.
 * Since 2025-03-31.basil the billing period lives on each subscription item and an invoice names its subscription under
 * `parent.subscription_details`; this code reads them there.
 */
export const STRIPE_API_VERSION = '2026-10-28.endive' as const;
/** The one Product of the catalog (DN-13 §6.1), created with this fixed id so a retry finds it. */
export const CATALOG_PRODUCT_ID = 'arca';
export const CATALOG_PRODUCT_NAME = 'ARCA';
/** The lookup key of a plan's current catalog price: arca_monthly, arca_annual. */
export const lookupKeyOf = (planCode: string) => `arca_${planCode}`;
// A checkout blocks the next one while it is open (DN-13 §6.2), so it lives one hour. Stripe accepts 30 minutes to 24 hours.
const CHECKOUT_TTL_S = 60 * 60;

/** The SDK client, with the pinned version, two retries and a 10 s timeout (DN-13 §6.10). Tests pass their own `fetch`. */
export function stripeClient(secretKey: string, options: { fetch?: typeof fetch; maxNetworkRetries?: number } = {}): Stripe {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: options.maxNetworkRetries ?? 2, timeout: 10_000,
    ...(options.fetch ? { httpClient: Stripe.createFetchHttpClient(options.fetch) } : {}) });
}

const iso = (seconds: number | null | undefined) => typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
const idOf = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const intervalOf = (value: string | null | undefined) => value === 'month' || value === 'year' ? value : null;

/**
 * Stripe's failures that say nothing was done and a retry later may work: no answer, a 5xx, a rate limit, or a key that is wrong or
 * lacks a permission (an operator's fix). They become BillingUnavailable (502 billing_unavailable); a 4xx about the request itself
 * stays a plain error.
 */
function translate(error: unknown): unknown {
  const { errors } = Stripe;
  if (error instanceof errors.StripeConnectionError || error instanceof errors.StripeAPIError || error instanceof errors.StripeRateLimitError
    || error instanceof errors.StripeAuthenticationError || error instanceof errors.StripePermissionError
    || (error instanceof errors.StripeError && (error.statusCode ?? 0) >= 500)) {
    return new BillingUnavailable(`Stripe did not answer (${(error as Stripe.errors.StripeError).type})`, { cause: error });
  }
  return error;
}
async function call<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw translate(error); }
}
const isMissing = (error: unknown) => error instanceof Stripe.errors.StripeInvalidRequestError
  && (error.statusCode === 404 || error.code === 'resource_missing');
/** A read of something that may not exist: null for Stripe's 404. */
async function found<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch (error) {
    if (isMissing(error)) return null;
    throw translate(error);
  }
}

/** The customer's own fields, from the pre-checkout's profile when there is one (DN-13 §19): a US address, the phone as typed. */
function customerFields(input: CustomerDetails): Stripe.CustomerUpdateParams {
  return { name: input.name, email: input.email, ...(input.phone ? { phone: input.phone } : {}),
    ...(input.address ? { address: { line1: input.address.line1, city: input.address.city, state: input.address.state,
      postal_code: input.address.postalCode, country: 'US' } } : {}) };
}

/** The subscription as DN-13 §6.5 reads it: one item, whose price and period are the subscription's. */
export function subscriptionOf(subscription: Stripe.Subscription): ProviderSubscription {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  return { subscriptionId: subscription.id, customerId: idOf(subscription.customer)!, orgId: subscription.metadata?.org_id ?? null,
    status: subscription.status, priceId: price?.id ?? null, planCode: price?.metadata?.plan_code ?? null, interval: intervalOf(price?.recurring?.interval),
    currentPeriodStart: iso(item?.current_period_start), currentPeriodEnd: iso(item?.current_period_end),
    // A cancellation scheduled for the end of the period, however it was asked for (the flag, or a cancel_at date).
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true || subscription.cancel_at != null, livemode: subscription.livemode };
}

/**
 * A verified event reduced to where its object keeps the organization, the customer and the subscription (DN-13 §6.5). The
 * organization is the `org_id` of the metadata the checkout set on the session and on the subscription (an invoice copies the
 * subscription's into `parent.subscription_details.metadata`); a refund or a dispute names a customer or nothing.
 */
export function providerEventOf(event: Stripe.Event): ProviderEvent {
  const object = event.data.object as unknown as { id?: unknown };
  const base: ProviderEvent = { id: event.id, type: event.type, livemode: event.livemode, created: iso(event.created)!,
    objectId: typeof object.id === 'string' ? object.id : null, orgId: null, customerId: null, subscriptionId: null, checkoutSessionId: null,
    amountCents: null, currency: null };
  switch (event.type) {
    case 'checkout.session.completed': case 'checkout.session.expired':
    case 'checkout.session.async_payment_succeeded': case 'checkout.session.async_payment_failed': {
      const session = event.data.object;
      return { ...base, orgId: session.metadata?.org_id ?? session.client_reference_id ?? null, customerId: idOf(session.customer),
        subscriptionId: idOf(session.subscription), checkoutSessionId: session.id };
    }
    case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted':
    case 'customer.subscription.paused': case 'customer.subscription.resumed': case 'customer.subscription.trial_will_end': {
      const subscription = event.data.object;
      return { ...base, orgId: subscription.metadata?.org_id ?? null, customerId: idOf(subscription.customer), subscriptionId: subscription.id };
    }
    case 'invoice.paid': case 'invoice.payment_failed': case 'invoice.payment_action_required': {
      const invoice = event.data.object;
      const details = invoice.parent?.subscription_details;
      // An endpoint or `stripe listen` on an account version older than basil still sends the subscription at the top of the invoice.
      const legacy = invoice as unknown as { subscription?: string | { id: string } | null; subscription_details?: { metadata?: Record<string, string> | null } };
      return { ...base, orgId: details?.metadata?.org_id ?? legacy.subscription_details?.metadata?.org_id ?? null, customerId: idOf(invoice.customer),
        subscriptionId: idOf(details?.subscription) ?? idOf(legacy.subscription),
        amountCents: event.type === 'invoice.paid' ? invoice.amount_paid : invoice.amount_due, currency: invoice.currency };
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      return { ...base, customerId: idOf(charge.customer), amountCents: charge.amount_refunded, currency: charge.currency };
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      return { ...base, amountCents: dispute.amount, currency: dispute.currency };
    }
    default:
      return base;
  }
}

/** Finds the catalog Product, or creates it when `create` is set (DN-13 §6.1). */
export async function catalogProduct(stripe: Stripe, create: boolean): Promise<{ productId: string; existed: boolean } | null> {
  const product = await found(() => stripe.products.retrieve(CATALOG_PRODUCT_ID));
  if (product) return { productId: product.id, existed: true };
  if (!create) return null;
  const created = await call(() => stripe.products.create({ id: CATALOG_PRODUCT_ID, name: CATALOG_PRODUCT_NAME, metadata: { catalog: 'arca' } },
    { idempotencyKey: `product:${CATALOG_PRODUCT_ID}` }));
  return { productId: created.id, existed: false };
}

/** The active catalog price of a plan with this amount, currency and interval, among those that hold its lookup key. */
export async function catalogPrice(stripe: Stripe, input: { planCode: string; amountCents: number; currency: string; interval: 'month' | 'year' })
  : Promise<{ match: Stripe.Price | null; holder: Stripe.Price | null }> {
  const prices = await call(() => stripe.prices.list({ lookup_keys: [lookupKeyOf(input.planCode)], active: true, limit: 10 }));
  const match = prices.data.find(price => price.unit_amount === input.amountCents && price.currency === input.currency
    && price.recurring?.interval === input.interval) ?? null;
  return { match, holder: prices.data[0] ?? null };
}

/**
 * A new catalog price for a plan (DN-13 §6.1): on the catalog product, with the plan's lookup key moved to it and `plan_code` in its
 * metadata, under an idempotency key of the price it replaces. Subscribers keep paying the old price (F2).
 */
export async function createCatalogPrice(stripe: Stripe, input: { planCode: string; productId: string; amountCents: number; currency: string;
  interval: 'month' | 'year'; replaces: string | null }): Promise<Stripe.Price> {
  return call(() => stripe.prices.create({ product: input.productId, unit_amount: input.amountCents, currency: input.currency,
    recurring: { interval: input.interval }, lookup_key: lookupKeyOf(input.planCode), transfer_lookup_key: true,
    metadata: { plan_code: input.planCode } },
  { idempotencyKey: `price:${input.planCode}:${input.replaces ?? 'none'}:${input.amountCents}:${input.currency}:${input.interval}` }));
}

/** Retires a replaced price from new checkouts. Best effort: the lookup key already moved, so nothing offers it any more. */
export async function retirePrice(stripe: Stripe, priceId: string): Promise<void> {
  try {
    await stripe.prices.update(priceId, { active: false });
  } catch (error) {
    console.warn(`[billing] price ${priceId} was replaced but could not be archived (${(error as Error).name}); archive it in the dashboard`);
  }
}

/**
 * Stripe behind the webapp's BillingProvider (DN-13 §6.2–§6.5, §6.10): one customer per organization, subscription Checkout on the
 * catalog price, the Customer Portal, cancellation, and the current state of a subscription or a checkout. Never logs a key, an email
 * or a card detail.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly mode: 'test' | 'live';
  readonly webhooks = true;
  readonly needsCatalogPrice = true;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly now: () => number;

  constructor(config: { secretKey: string; webhookSecret: string; mode: 'live' | 'test'; appBaseUrl: string },
    options: { fetch?: typeof fetch; now?: () => number; maxNetworkRetries?: number } = {}) {
    this.mode = config.mode;
    this.webhookSecret = config.webhookSecret;
    this.now = options.now ?? Date.now;
    this.stripe = stripeClient(config.secretKey, { fetch: options.fetch, maxNetworkRetries: options.maxNetworkRetries });
  }

  async ensureCustomer(input: CustomerDetails) {
    // The organization is in the key, so two requests that race within Stripe's 24 h of idempotency get one customer. What the firm
    // gave in the pre-checkout (DN-13 §19) goes with it, so Checkout asks none of it again.
    const customer = await call(() => this.stripe.customers.create({ ...customerFields(input),
      ...(input.ein ? { tax_id_data: [{ type: 'us_ein' as const, value: input.ein }] } : {}), metadata: { org_id: input.orgId } },
    { idempotencyKey: `customer:${input.orgId}` }));
    return { customerId: customer.id };
  }

  /**
   * The customer of an organization brought up to its profile before a new Checkout (DN-13 §19): name, email, phone and address, and
   * the EIN as its only us_ein tax id. Updating is idempotent; the tax ids are read first, so a retry adds none.
   */
  async updateCustomer(customerId: string, input: CustomerDetails) {
    await call(() => this.stripe.customers.update(customerId, customerFields(input)));
    if (!input.ein) return;
    const ein = input.ein;
    const held = await call(() => this.stripe.customers.listTaxIds(customerId, { limit: 100 }));
    const eins = held.data.filter(taxId => taxId.type === 'us_ein');
    for (const stale of eins.filter(taxId => taxId.value !== ein)) await call(() => this.stripe.customers.deleteTaxId(customerId, stale.id));
    if (!eins.some(taxId => taxId.value === ein)) {
      await call(() => this.stripe.customers.createTaxId(customerId, { type: 'us_ein', value: ein },
        { idempotencyKey: `tax_id:${customerId}:us_ein:${ein}` }));
    }
  }

  async createCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; successUrl: string; cancelUrl: string; after?: string | null }) {
    const session = await this.openSession(input, { success_url: input.successUrl, cancel_url: input.cancelUrl },
      `checkout:${input.orgId}:${input.plan.code}:${Math.floor(this.now() / 60_000)}${input.after ? `:${input.after}` : ''}`);
    if (!session.url) throw new Error('Stripe returned a checkout session without a URL');
    return { sessionId: session.id, url: session.url, expiresAt: iso(session.expires_at)! };
  }

  /**
   * Checkout embedded in ARCA's page (DN-13 §19): the same session as the hosted one, mounted by Stripe.js with its client secret,
   * coming back to `returnUrl` (with {CHECKOUT_SESSION_ID}) instead of the success and cancel pages. Its idempotency key names the
   * mode, so a hosted session asked for in the same minute is another one.
   */
  async createEmbeddedCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; returnUrl: string; after?: string | null }) {
    const session = await this.openSession(input, { ui_mode: 'embedded_page', return_url: input.returnUrl },
      `checkout:${input.orgId}:${input.plan.code}:embedded:${Math.floor(this.now() / 60_000)}${input.after ? `:${input.after}` : ''}`);
    if (!session.client_secret) throw new Error('Stripe returned an embedded checkout session without a client secret');
    return { sessionId: session.id, clientSecret: session.client_secret, expiresAt: iso(session.expires_at)! };
  }

  /** What every subscription Checkout of ARCA carries (DN-13 §6.2), hosted or embedded; `page` is where it is paid and where it ends. */
  private async openSession(input: { orgId: string; customerId: string; plan: PlanRecord },
    page: Pick<Stripe.Checkout.SessionCreateParams, 'ui_mode' | 'success_url' | 'cancel_url' | 'return_url'>,
    idempotencyKey: string): Promise<Stripe.Checkout.Session> {
    const price = input.plan.stripe_price_id;
    if (!price) throw new Error(`The plan ${input.plan.code} has no Stripe price yet: run npm run stripe:catalog`);
    const nowS = Math.floor(this.now() / 1000);
    const session = await call(() => this.stripe.checkout.sessions.create({
      mode: 'subscription', ...(page.ui_mode ? { ui_mode: page.ui_mode } : {}), customer: input.customerId, client_reference_id: input.orgId,
      line_items: [{ price, quantity: 1 }],
      // The webhook finds the organization on the session and on the subscription, whatever the customer.
      metadata: { org_id: input.orgId }, subscription_data: { metadata: { org_id: input.orgId } },
      ...(page.success_url ? { success_url: page.success_url, cancel_url: page.cancel_url } : {}),
      ...(page.return_url ? { return_url: page.return_url } : {}),
      billing_address_collection: 'required', customer_update: { name: 'auto', address: 'auto' },
      // Card only for now (DN-13 §6.2, F5): an asynchronous method would need the async_payment events and a state in between.
      allowed_payment_method_types: ['card'],
      // ARCA is the seller (taxes are F3). An account can have Managed Payments (Stripe as merchant of record) on by default, and
      // then Stripe refuses a payment method list; this session says so explicitly instead of taking the account's default.
      managed_payments: { enabled: false },
      // Always charged and shown in USD (decision of 2026-11-20): an account with Adaptive Pricing on offered the visitor their
      // local currency (COP in the first test-mode run). Explicit here so a change in the dashboard cannot turn it back on.
      adaptive_pricing: { enabled: false },
      expires_at: nowS + CHECKOUT_TTL_S,
      // Taxes (F3), promotion codes and a trial (F4) wait for the founder's decisions.
    }, { idempotencyKey }));
    // An idempotent replay of a session that is no longer open would hand out a link that cannot be paid.
    if (session.status !== 'open') throw new Error(`Stripe returned a checkout session that is ${session.status}, not open`);
    return session;
  }

  async expireCheckout(sessionId: string) {
    const session = await found(() => this.stripe.checkout.sessions.retrieve(sessionId));
    if (!session || session.status === 'expired') return 'expired' as const;
    if (session.status === 'complete') return 'complete' as const;
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
      return 'expired' as const;
    } catch (error) {
      // Paid between the read and the expiry.
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        const again = await found(() => this.stripe.checkout.sessions.retrieve(sessionId));
        if (again?.status === 'complete') return 'complete' as const;
        if (again?.status === 'expired') return 'expired' as const;
      }
      throw translate(error);
    }
  }

  async createPortal(input: { customerId: string; returnUrl: string }) {
    const session = await call(() => this.stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl }));
    return { url: session.url };
  }

  async cancel(input: { orgId: string; subscriptionId: string }) {
    try {
      await this.stripe.subscriptions.cancel(input.subscriptionId);
    } catch (error) {
      // Canceled already (by the dashboard, the portal, or an earlier try), or gone: done.
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        const current = await this.subscriptionState(input.subscriptionId);
        if (!current || current.status === 'canceled' || current.status === 'incomplete_expired') return;
      }
      throw translate(error);
    }
  }

  async subscriptionState(subscriptionId: string) {
    const subscription = await found(() => this.stripe.subscriptions.retrieve(subscriptionId));
    return subscription && subscriptionOf(subscription);
  }

  async checkoutState(sessionId: string): Promise<ProviderCheckout | null> {
    const session = await found(() => this.stripe.checkout.sessions.retrieve(sessionId));
    if (!session) return null;
    const status = (['open', 'complete', 'expired'] as const).find(known => known === session.status) ?? null;
    const uiMode = session.ui_mode === 'embedded_page' ? 'embedded' as const : session.ui_mode === 'hosted_page' ? 'hosted' as const : null;
    return { sessionId: session.id, orgId: session.client_reference_id ?? session.metadata?.org_id ?? null, customerId: idOf(session.customer),
      subscriptionId: idOf(session.subscription), status, livemode: session.livemode, uiMode,
      clientSecret: uiMode === 'embedded' ? session.client_secret ?? null : null };
  }

  async parseWebhook(raw: string | Uint8Array, signature: string | undefined) {
    if (!signature) return null;
    let event: Stripe.Event;
    try {
      // Over the bytes Stripe sent, with its 5 minutes of tolerance measured on this process's clock.
      event = this.stripe.webhooks.constructEvent(raw, signature, this.webhookSecret, undefined, undefined, this.now());
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) return null;
      throw error;
    }
    return providerEventOf(event);
  }

  async createPrice(input: { plan: PlanRecord; amountCents: number; currency: string; interval: 'month' | 'year' }) {
    const { match } = await catalogPrice(this.stripe, { planCode: input.plan.code, amountCents: input.amountCents, currency: input.currency,
      interval: input.interval });
    // A retry after the plans table failed to change finds the price the first try made.
    if (match) return { priceId: match.id, productId: idOf(match.product)! };
    const productId = input.plan.stripe_product_id ?? (await catalogProduct(this.stripe, true))!.productId;
    const created = await createCatalogPrice(this.stripe, { planCode: input.plan.code, productId, amountCents: input.amountCents,
      currency: input.currency, interval: input.interval, replaces: input.plan.stripe_price_id });
    if (input.plan.stripe_price_id && input.plan.stripe_price_id !== created.id) await retirePrice(this.stripe, input.plan.stripe_price_id);
    return { priceId: created.id, productId };
  }

  async recentSubscriptionIds(since: Date) {
    const ids = new Set<string>();
    await call(() => this.stripe.events.list({ created: { gte: Math.floor(since.getTime() / 1000) }, types: [...RECONCILED_EVENT_TYPES], limit: 100 })
      .autoPagingEach(event => {
        const subscriptionId = providerEventOf(event).subscriptionId;
        if (subscriptionId) ids.add(subscriptionId);
        // A bound on one run; a backlog this large is an incident for a person, not for this job.
        return ids.size < 1000;
      }));
    return [...ids];
  }
}

/** The events whose subscription the reconciliation reads again (DN-13 §9.5). */
export const RECONCILED_EVENT_TYPES = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'] as const;
