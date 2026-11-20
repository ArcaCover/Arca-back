import type { BillingStatus } from '@arca/contracts';
import { randomUUID } from 'node:crypto';
import type { BillingProvider, ProviderEvent, ProviderSubscription } from './billing.js';
import { catalogIdsOf, catalogModeOf } from './plans.js';
import type { BillingApplyOutcome, BillingStateRecord, OrganizationRecord, WebappRepository } from './types.js';

/**
 * What a webhook delivery came to (DN-13 §6.5), all answered 200: `applied` (a subscription state, through apply_billing_state),
 * `recorded` (an event that moves no subscription, through close_billing_event), `duplicate`, `ignored` (a type the back does not
 * act on, never recorded), `unknown_org`, and the two refusals of apply_billing_state.
 */
export type WebhookOutcome = BillingApplyOutcome | 'recorded' | 'ignored' | 'unknown_org';
export type ReconcileReport = { checked: number; mismatched: number; applied: number; failed: number };
/** What the return from Checkout read of the session at Stripe. */
export type CheckoutToSync = { sessionId: string; subscriptionId: string | null; status: string | null; livemode: boolean };

/** A delivery the back refuses before reading it: a signature that does not verify, or an event of the other mode. Always a 400. */
export class WebhookRejected extends Error {
  constructor(readonly reason: 'invalid_signature' | 'livemode_mismatch', message: string) {
    super(message);
    this.name = 'WebhookRejected';
  }
}

// The events of DN-13 §6.5 the back acts on. Everything else is acknowledged and forgotten.
const SUBSCRIPTION_EVENTS = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
const AUDITED_EVENTS: Readonly<Record<string, string>> = {
  'invoice.payment_action_required': 'billing.payment_action_required', 'charge.refunded': 'billing.refunded',
  'charge.dispute.created': 'billing.dispute',
};
// After a subscription event is applied, the audit row of the money it moved.
const AFTER_APPLY: Readonly<Record<string, string>> = { 'invoice.paid': 'billing.invoice_paid', 'invoice.payment_failed': 'billing.payment_failed' };
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([...SUBSCRIPTION_EVENTS, ...Object.keys(AUDITED_EVENTS), 'checkout.session.expired']);
const RECONCILE_WINDOW_MS = 48 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS = new Set<BillingStatus>(['active', 'past_due']);

/**
 * The billing status a provider status leads to (DN-13 §6.6). `incomplete` and `incomplete_expired` read "never paid" from the
 * organization's current status: before a first payment it stays pending_payment; after one, an incomplete subscription changes
 * nothing and an expired one cancels. A subscription other than the live one never reads as access unless it pays, so
 * apply_billing_state can tell a double charge from a stale one. An unknown status gives no access.
 */
export function billingStatusFor(status: string, context: { current: BillingStatus; otherLiveSubscription: boolean }): BillingStatus {
  switch (status) {
    case 'active': case 'trialing': return 'active';
    case 'past_due': return 'past_due';
    case 'incomplete':
      return context.current === 'pending_payment' || context.otherLiveSubscription ? 'pending_payment' : context.current;
    case 'incomplete_expired':
      return context.current === 'pending_payment' ? 'pending_payment' : 'canceled';
    default: return 'canceled';
  }
}

/** Runs one task at a time per key, in arrival order. Per process: production runs one (DN-13 §6.5). */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }
}

/**
 * Stripe's events and the subscription state behind them (DN-13 §6.5, §6.3, §9.5). Each event names a subscription; the back reads
 * that subscription's current state from Stripe and applies it with apply_billing_state, which records the event and applies the
 * state in one transaction, idempotent by event id. Events of one organization are processed one at a time, so an older read never
 * lands after a newer one. The return from Checkout and the daily reconciliation go through the same path.
 */
export class BillingEvents {
  private readonly queue = new KeyedQueue();
  private readonly now: () => number;

  constructor(private readonly deps: { repository: WebappRepository; billing: BillingProvider; now?: () => number }) {
    this.now = deps.now ?? Date.now;
  }

  /** One organization's billing work at a time: the webhook, the return from Checkout and a checkout itself. */
  forOrg<T>(orgId: string, task: () => Promise<T>): Promise<T> { return this.queue.run(`org:${orgId}`, task); }

  /** POST /billing/webhook. Throws WebhookRejected (400); any other error means "retry" (500), and nothing was recorded. */
  async webhook(raw: string | Uint8Array, signature: string | undefined): Promise<WebhookOutcome> {
    const event = await this.deps.billing.parseWebhook(raw, signature);
    if (!event) throw new WebhookRejected('invalid_signature', 'The Stripe signature does not verify');
    if (event.livemode !== (this.deps.billing.mode === 'live')) {
      console.error(`[billing] event ${event.id} ${event.type} refused: livemode=${event.livemode} does not match this process's ${this.deps.billing.mode} key`);
      throw new WebhookRejected('livemode_mismatch', 'The event is of the other Stripe mode');
    }
    try {
      const outcome = await this.handle(event);
      const log = outcome === 'unknown_org' ? console.warn : outcome === 'duplicate_subscription' ? console.error : console.log;
      log(`[billing] event ${event.id} ${event.type} ${outcome}`);
      return outcome;
    } catch (error) {
      console.error(`[billing] event ${event.id} ${event.type} failed (${error instanceof Error ? error.name : 'unknown error'})`);
      throw error;
    }
  }

  async handle(event: ProviderEvent): Promise<WebhookOutcome> {
    if (!HANDLED_EVENT_TYPES.has(event.type)) return 'ignored';
    const repo = this.deps.repository;
    // A duplicate does not even read Stripe; apply_billing_state checks again in its transaction.
    if (await repo.isBillingEventProcessed(event.id)) return 'duplicate';
    if (event.type === 'charge.dispute.created') {
      console.error(`[billing] dispute ${event.objectId} of event ${event.id}: answer it in the Stripe dashboard`);
    }
    const org = await this.organizationOf(event);
    if (!org) {
      await repo.closeBillingEvent(event, null, { error: 'unknown_org', audit: null }, this.timestamp());
      return 'unknown_org';
    }
    return this.forOrg(org.id, async () => {
      if (event.checkoutSessionId && event.type === 'checkout.session.completed') await repo.closeCheckoutSession(event.checkoutSessionId, 'complete');
      if (event.checkoutSessionId && event.type === 'checkout.session.expired') await repo.closeCheckoutSession(event.checkoutSessionId, 'expired');
      if (SUBSCRIPTION_EVENTS.has(event.type) && event.subscriptionId) {
        const outcome = await this.applySubscription(org.id, event, event.subscriptionId);
        const after = AFTER_APPLY[event.type];
        if (outcome === 'applied' && after) {
          await repo.appendAudit({ id: randomUUID(), actor_kind: 'system', actor_user_id: null, org_id: org.id, action: after, target: event.id,
            data: { amountCents: event.amountCents, currency: event.currency }, created_at: this.timestamp() });
        }
        if (outcome === 'duplicate_subscription') {
          console.error(`[billing] duplicate_subscription org ${org.id}: subscription ${event.subscriptionId} pays beside the live one; cancel and refund it`);
        }
        return outcome;
      }
      const action = AUDITED_EVENTS[event.type];
      return repo.closeBillingEvent(event, org.id, { error: null,
        audit: action ? { action, data: { amountCents: event.amountCents, currency: event.currency } } : null }, this.timestamp());
    });
  }

  /**
   * Reads the subscription from Stripe now and applies it under the event's id (DN-13 §6.5, step 6–7). The caller holds the
   * organization's turn. A subscription Stripe no longer knows is recorded and changes nothing.
   */
  async applySubscription(orgId: string, event: { id: string; type: string; livemode?: boolean | null }, subscriptionId: string)
    : Promise<BillingApplyOutcome | 'recorded'> {
    const repo = this.deps.repository;
    const subscription = await this.deps.billing.subscriptionState(subscriptionId);
    if (!subscription) {
      return (await repo.closeBillingEvent(event, orgId, { error: 'unknown_subscription', audit: null }, this.timestamp())) === 'duplicate'
        ? 'duplicate' : 'recorded';
    }
    return repo.applyBillingState(event, orgId, await this.stateOf(orgId, subscription), this.timestamp());
  }

  /** The return from Checkout (DN-13 §6.3): the session's subscription, applied by the webhook's path, under an id of its own. */
  syncCheckout(orgId: string, checkout: CheckoutToSync) {
    return this.forOrg(orgId, () => this.applyCheckout(orgId, checkout));
  }

  /**
   * syncCheckout for a caller that already holds the organization's turn (a checkout that finds its open session paid). Closes the
   * session as Stripe says, and applies its subscription, if any, under `sync:<session>:<status>`: a second return with nothing new is
   * a duplicate, a later state applies. Returns the subscription it read.
   */
  async applyCheckout(orgId: string, checkout: CheckoutToSync): Promise<ProviderSubscription | null> {
    if (checkout.status === 'complete') await this.deps.repository.closeCheckoutSession(checkout.sessionId, 'complete');
    if (checkout.status === 'expired') await this.deps.repository.closeCheckoutSession(checkout.sessionId, 'expired');
    if (!checkout.subscriptionId) return null;
    const subscription = await this.deps.billing.subscriptionState(checkout.subscriptionId);
    if (!subscription) return null;
    const outcome = await this.deps.repository.applyBillingState({ id: `sync:${checkout.sessionId}:${subscription.status}`, type: 'checkout.sync',
      livemode: checkout.livemode }, orgId, await this.stateOf(orgId, subscription), this.timestamp());
    if (outcome === 'duplicate_subscription') {
      console.error(`[billing] duplicate_subscription org ${orgId}: subscription ${subscription.subscriptionId} pays beside the live one; cancel and refund it`);
    }
    return subscription;
  }

  /**
   * The daily reconciliation (DN-13 §9.5): every subscription Stripe changed in the last 48 hours is read again and compared with the
   * row the back holds; one that disagrees is logged (`[billing] reconcile mismatch`) and applied by the webhook's path, under an id
   * that names what was seen, so the same disagreement is applied (and audited) once. Scheduling it is the caller's.
   */
  async reconcile(options: { windowMs?: number } = {}): Promise<ReconcileReport> {
    const report: ReconcileReport = { checked: 0, mismatched: 0, applied: 0, failed: 0 };
    const since = new Date(this.now() - (options.windowMs ?? RECONCILE_WINDOW_MS));
    for (const subscriptionId of await this.deps.billing.recentSubscriptionIds(since)) {
      report.checked++;
      try {
        const subscription = await this.deps.billing.subscriptionState(subscriptionId);
        const org = subscription && await this.organizationOf({ orgId: subscription.orgId, customerId: subscription.customerId });
        if (!subscription || !org) {
          console.warn(`[billing] reconcile: subscription ${subscriptionId} names no organization of this back`);
          continue;
        }
        await this.forOrg(org.id, async () => {
          const current = (await this.deps.repository.getOrganization(org.id)) ?? org;
          const state = await this.stateOf(org.id, subscription, current);
          if (await this.agrees(current, state)) return;
          report.mismatched++;
          console.error(`[billing] reconcile mismatch org ${org.id} subscription ${subscriptionId}: Stripe says ${subscription.status}`);
          const outcome = await this.deps.repository.applyBillingState({ id: `reconcile:${subscriptionId}:${subscription.status}:`
            + `${subscription.currentPeriodEnd ?? ''}:${subscription.cancelAtPeriodEnd}`, type: 'reconcile', livemode: subscription.livemode },
          org.id, state, this.timestamp());
          if (outcome === 'applied') report.applied++;
          if (outcome === 'duplicate_subscription') {
            console.error(`[billing] duplicate_subscription org ${org.id}: subscription ${subscriptionId} pays beside the live one; cancel and refund it`);
          }
        });
      } catch (error) {
        report.failed++;
        console.error(`[billing] reconcile of subscription ${subscriptionId} failed (${error instanceof Error ? error.name : 'unknown error'})`);
      }
    }
    console.log(`[billing] reconcile checked ${report.checked} mismatched ${report.mismatched} applied ${report.applied} failed ${report.failed}`);
    return report;
  }

  /** The state to apply: Stripe's subscription, mapped with what the organization holds now (DN-13 §6.6). */
  private async stateOf(orgId: string, subscription: ProviderSubscription, org?: OrganizationRecord): Promise<BillingStateRecord> {
    const repo = this.deps.repository;
    const current = org ?? await repo.getOrganization(orgId);
    if (!current) throw new Error('Organization not found');
    const stored = await repo.getSubscription(orgId);
    const otherLiveSubscription = !!stored?.subscription_id && stored.subscription_id !== subscription.subscriptionId && stored.status !== 'canceled';
    return { status: billingStatusFor(subscription.status, { current: current.billing_status, otherLiveSubscription }),
      plan_code: await this.planCodeOf(subscription), customer_id: subscription.customerId, subscription_id: subscription.subscriptionId,
      current_period_end: subscription.currentPeriodEnd, current_period_start: subscription.currentPeriodStart, provider_status: subscription.status,
      price_id: subscription.priceId, cancel_at_period_end: subscription.cancelAtPeriodEnd, livemode: subscription.livemode };
  }

  /** Whether the back already holds this state: nothing for the reconciliation to correct. */
  private async agrees(org: OrganizationRecord, state: BillingStateRecord): Promise<boolean> {
    const stored = await this.deps.repository.getSubscription(org.id);
    if (stored?.subscription_id && stored.subscription_id !== state.subscription_id && stored.status !== 'canceled') {
      // Another subscription is the live one: one that does not pay is stale, and stays out; one that pays is a double charge.
      return !ACCESS.has(state.status);
    }
    return !!stored && stored.subscription_id === state.subscription_id && stored.provider_status === state.provider_status
      && stored.current_period_end === state.current_period_end && stored.cancel_at_period_end === state.cancel_at_period_end
      && org.billing_status === state.status;
  }

  /**
   * The plan of the price: its `plan_code`, or the plan that charges that price in the key's mode (DN-13 §20), or the only active plan
   * of its interval.
   */
  private async planCodeOf(subscription: ProviderSubscription): Promise<string | null> {
    const plans = await this.deps.repository.listPlans();
    if (subscription.planCode && plans.some(plan => plan.code === subscription.planCode)) return subscription.planCode;
    const mode = catalogModeOf(this.deps.billing.mode);
    const byPrice = subscription.priceId ? plans.find(plan => catalogIdsOf(plan, mode).priceId === subscription.priceId) : undefined;
    if (byPrice) return byPrice.code;
    const byInterval = plans.filter(plan => plan.active && plan.interval === subscription.interval);
    return byInterval.length === 1 ? byInterval[0]!.code : null;
  }

  /** The organization an event names: by the `org_id` of its metadata, or else by the customer the back created for it. */
  private async organizationOf(event: Pick<ProviderEvent, 'orgId' | 'customerId'>): Promise<OrganizationRecord | null> {
    const repo = this.deps.repository;
    if (event.orgId && UUID.test(event.orgId)) {
      const org = await repo.getOrganization(event.orgId.toLowerCase());
      if (org) return org;
    }
    const customer = event.customerId ? await repo.findBillingCustomer(event.customerId) : null;
    return customer ? repo.getOrganization(customer.org_id) : null;
  }

  private timestamp() { return new Date(this.now()).toISOString(); }
}
