import { randomUUID } from 'node:crypto';
import type { BillingStatus } from '@arca/contracts';
import { catalogIdsOf } from './plans.js';
import type { PlanRecord } from './types.js';

/**
 * The event the simulated checkout sends (DN-12 §7): the debug modes pay through POST /__debug/billing/pay, which applies it through
 * the service. The real provider never produces one: its webhook reads Stripe instead (DN-13 §6.5).
 */
export type BillingEvent = {
  id: string; type: 'checkout.completed' | 'subscription.updated' | 'subscription.canceled' | 'payment.failed'; orgId: string;
  status: BillingStatus; planCode: string | null; customerId: string | null; subscriptionId: string | null; currentPeriodEnd: string | null;
  /** The simulated checkout that was paid, so its session closes. */
  checkoutSessionId?: string | null;
};

/** A subscription as the provider holds it now (DN-13 §6.5, step 6), before it is mapped to a billing status (§6.6). */
export type ProviderSubscription = {
  subscriptionId: string; customerId: string;
  /** The organization the checkout put in the subscription's metadata, when it did. */
  orgId: string | null;
  /** The provider's own status, raw: active, past_due, unpaid, canceled, incomplete, incomplete_expired, trialing, paused. */
  status: string;
  priceId: string | null;
  /** The plan the price names in its metadata (`plan_code`), as every catalog price ARCA creates does. */
  planCode: string | null;
  interval: 'month' | 'year' | null;
  currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; livemode: boolean;
};

export type ProviderCheckout = {
  sessionId: string; orgId: string | null; customerId: string | null; subscriptionId: string | null;
  status: 'open' | 'complete' | 'expired' | null; livemode: boolean;
  /** Hosted (Stripe's page) or embedded in ARCA's page (DN-13 §19); null for a kind ARCA does not open. */
  uiMode: 'hosted' | 'embedded' | null;
  /** What Stripe.js mounts an embedded session with; null for any other. Never stored by the back. */
  clientSecret: string | null;
};

/**
 * Who the Stripe customer of an organization is (DN-13 §6.2, §19): the organization's name and the payer's email, and, when the
 * firm gave its profile in the pre-checkout, its legal name, phone, US billing address and EIN, so Checkout asks none of it again.
 */
export type CustomerDetails = {
  orgId: string; name: string; email: string; phone?: string | null;
  address?: { line1: string; city: string; state: string; postalCode: string } | null;
  /** 12-3456789; Stripe keeps it as the customer's us_ein tax id. */
  ein?: string | null;
};

/** A verified webhook event, reduced to where its object keeps the organization, the customer and the subscription. */
export type ProviderEvent = {
  id: string; type: string; livemode: boolean; created: string;
  /** The id of the object the event is about (a session, a subscription, an invoice, a charge, a dispute). */
  objectId: string | null;
  orgId: string | null; customerId: string | null; subscriptionId: string | null; checkoutSessionId: string | null;
  /** An invoice's, a refund's or a dispute's amount, for the audit row; never a card detail. */
  amountCents: number | null; currency: string | null;
};

/** The provider did not answer, or answered with its own failure (a 5xx, a timeout, a rate limit): nothing was done (DN-13 §7.3, 502). */
export class BillingUnavailable extends Error {
  constructor(message = 'The billing provider is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BillingUnavailable';
  }
}

/**
 * The payment provider of the webapp (DN-13 §6.10): Stripe in the real webapp, the simulated one in the debug modes. Every call that
 * writes at the provider is idempotent on its side, so a retry never makes a second customer, session or price.
 */
export interface BillingProvider {
  /** `simulated` is MockBillingProvider; otherwise the mode of the Stripe key (DN-13 §6.7). */
  readonly mode: 'simulated' | 'test' | 'live';
  /** Whether the provider signs webhooks: without them, POST /billing/webhook stays 501 (the simulated provider pays through debug). */
  readonly webhooks: boolean;
  /** Whether a checkout charges a catalog price, so a plan without a price in the provider's mode cannot be sold (DN-13 §21). */
  readonly needsCatalogPrice: boolean;
  ensureCustomer(input: CustomerDetails): Promise<{ customerId: string }>;
  /** Brings a customer made before up to the organization's profile, its EIN included, before a new Checkout (DN-13 §19). */
  updateCustomer(customerId: string, input: CustomerDetails): Promise<void>;
  /**
   * The plan travels whole, so the provider charges the price in the plans table and nothing else (DN-10 §4.4). The same request
   * within a minute is the same session (DN-13 §6.2); `after` names what came before this one (the session it replaces, or the
   * subscription it follows), so a deliberate new session is never a replay of a closed one.
   */
  createCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; successUrl: string; cancelUrl: string; after?: string | null;
    /** The customer already holds the billing address (the firm profile): Checkout does not ask for it again. */
    prefilled?: boolean }): Promise<{ sessionId: string; url: string; expiresAt: string }>;
  /** The same session embedded in ARCA's page (DN-13 §19): a client secret instead of a URL, and one return URL for every outcome. */
  createEmbeddedCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; returnUrl: string; after?: string | null;
    prefilled?: boolean }): Promise<{ sessionId: string; clientSecret: string; expiresAt: string }>;
  /** Closes an open checkout so it can no longer be paid; says `complete` when the customer paid it first. */
  expireCheckout(sessionId: string): Promise<'expired' | 'complete'>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Cancels at once (DN-13 §6.9); a subscription already canceled is done, not an error. */
  cancel(input: { orgId: string; subscriptionId: string }): Promise<void>;
  /** The provider's current state of a subscription; null when it does not know it. */
  subscriptionState(subscriptionId: string): Promise<ProviderSubscription | null>;
  checkoutState(sessionId: string): Promise<ProviderCheckout | null>;
  /** Verifies and parses a webhook delivery; null when the signature is missing, wrong or too old. */
  parseWebhook(raw: string | Uint8Array, signature: string | undefined): Promise<ProviderEvent | null>;
  /** A catalog price for a new amount of the plan (DN-13 §6.1), or the one a retry already created. */
  createPrice(input: { plan: PlanRecord; amountCents: number; currency: string; interval: 'month' | 'year' }): Promise<{ priceId: string; productId: string }>;
  /** The subscriptions whose state changed since then, for the daily reconciliation (DN-13 §9.5). */
  recentSubscriptionIds(since: Date): Promise<string[]>;
  /**
   * A catalog price as the provider holds it, for the check at start (DN-13 §21): whether it is active and of which mode; null when
   * the account does not know it. Throws BillingUnavailable when the provider cannot be asked.
   */
  priceState(priceId: string): Promise<{ active: boolean; livemode: boolean } | null>;
}

const id = (prefix: string) => `${prefix}_mock_${randomUUID().replaceAll('-', '')}`;
const CHECKOUT_TTL_MS = 60 * 60 * 1000;

/** Stripe stand-in for the debug modes (DN-09): nothing leaves the process, and a checkout is paid through the debug route. */
export class MockBillingProvider implements BillingProvider {
  readonly mode = 'simulated' as const;
  readonly webhooks = false;
  readonly needsCatalogPrice = false;
  /** Organizations whose subscription was canceled, for the tests. */
  readonly canceled: string[] = [];
  private readonly sessions = new Map<string, { orgId: string; plan: PlanRecord; customerId: string; status: 'open' | 'complete' | 'expired';
    subscriptionId: string | null; clientSecret: string | null }>();
  private readonly subscriptions = new Map<string, ProviderSubscription>();
  private readonly appBaseUrl: string;

  constructor(appBaseUrl: string, private readonly now: () => number = Date.now) {
    this.appBaseUrl = appBaseUrl.replace(/\/+$/, '');
  }

  async ensureCustomer(_input: CustomerDetails) { return { customerId: id('cus') }; }
  async updateCustomer(_customerId: string, _input: CustomerDetails) { /* nothing leaves the process */ }
  async createCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; successUrl: string; cancelUrl: string }) {
    const sessionId = id('cs');
    this.sessions.set(sessionId, { orgId: input.orgId, plan: structuredClone(input.plan), customerId: input.customerId, status: 'open',
      subscriptionId: null, clientSecret: null });
    return { sessionId, url: `${this.appBaseUrl}/app/billing/mock-checkout?session=${encodeURIComponent(sessionId)}`,
      expiresAt: new Date(this.now() + CHECKOUT_TTL_MS).toISOString() };
  }
  /** The front never mounts it (the debug modes pay through the simulated checkout), but the back's rules are the same. */
  async createEmbeddedCheckout(input: { orgId: string; customerId: string; plan: PlanRecord; returnUrl: string }) {
    const sessionId = id('cs');
    const clientSecret = `${sessionId}_secret_mock`;
    this.sessions.set(sessionId, { orgId: input.orgId, plan: structuredClone(input.plan), customerId: input.customerId, status: 'open',
      subscriptionId: null, clientSecret });
    return { sessionId, clientSecret, expiresAt: new Date(this.now() + CHECKOUT_TTL_MS).toISOString() };
  }
  async expireCheckout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.status === 'complete') return 'complete' as const;
    if (session) session.status = 'expired';
    return 'expired' as const;
  }
  // The stand-in has no portal: the billing page is where the customer would land again.
  async createPortal(_input: { customerId: string; returnUrl: string }) { return { url: `${this.appBaseUrl}/app/billing` }; }
  async cancel(input: { orgId: string; subscriptionId: string }) {
    this.canceled.push(input.orgId);
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (subscription) subscription.status = 'canceled';
  }
  async subscriptionState(subscriptionId: string) { return structuredClone(this.subscriptions.get(subscriptionId) ?? null); }
  async checkoutState(sessionId: string): Promise<ProviderCheckout | null> {
    const session = this.sessions.get(sessionId);
    return session ? { sessionId, orgId: session.orgId, customerId: session.customerId, subscriptionId: session.subscriptionId,
      status: session.status, livemode: false, uiMode: session.clientSecret ? 'embedded' : 'hosted', clientSecret: session.clientSecret } : null;
  }
  async parseWebhook() { return null; }
  async createPrice(_input: { plan: PlanRecord; amountCents: number; currency: string; interval: 'month' | 'year' }) {
    return { priceId: id('price'), productId: 'prod_mock' };
  }
  async recentSubscriptionIds() { return []; }
  // It charges no catalog price (needsCatalogPrice is false), so it knows none and nothing asks it.
  async priceState(_priceId: string) { return null; }

  /** The event a completed checkout would send; null for an unknown session or one already paid. */
  pay(sessionId: string): BillingEvent | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'open') return null;
    const start = new Date(this.now());
    const periodEnd = new Date(this.now());
    if (session.plan.interval === 'year') periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    const subscriptionId = id('sub');
    session.status = 'complete';
    session.subscriptionId = subscriptionId;
    this.subscriptions.set(subscriptionId, { subscriptionId, customerId: session.customerId, orgId: session.orgId, status: 'active',
      priceId: catalogIdsOf(session.plan, 'test').priceId, planCode: session.plan.code, interval: session.plan.interval, currentPeriodStart: start.toISOString(),
      currentPeriodEnd: periodEnd.toISOString(), cancelAtPeriodEnd: false, livemode: false });
    return { id: id('evt'), type: 'checkout.completed', orgId: session.orgId, status: 'active', planCode: session.plan.code,
      customerId: session.customerId, subscriptionId, currentPeriodEnd: periodEnd.toISOString(), checkoutSessionId: sessionId };
  }
}
