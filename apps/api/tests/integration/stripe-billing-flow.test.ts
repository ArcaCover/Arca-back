import { describe, expect, it, vi } from 'vitest';
import { BillingView, OrgView, PlanView, UrlResponse } from '@arca/contracts';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { MockAppAuth } from '../../src/webapp/auth.js';
import { billingStatusFor } from '../../src/webapp/billing-events.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import type { PlanRecord } from '../../src/webapp/types.js';
import { webappRoutes } from '../../src/webapp/routes.js';
import { WebappService } from '../../src/webapp/service.js';
import { StripeBillingProvider } from '../../src/webapp/stripe.js';
import { WEBHOOK_SECRET, fakeStripe, type SubscriptionFixture } from '../fixtures/stripe.js';
import { fixtureResult } from '../fixtures/result.js';

// The real billing of DN-13 §6 end to end inside the process: StripeBillingProvider over a fake Stripe, the service, the routes
// and the in-memory repository (the SQL one runs the same contract in the conformance suite). No network.
const secret = 'stripe-billing-flow-secret-'.repeat(2);
const APP = 'https://arcacover.com';
const T0 = Date.UTC(2026, 10, 20, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function scene(options: { mode?: 'test' | 'live'; untaggedPrices?: boolean; plans?: PlanRecord[] } = {}) {
  let clock = T0;
  const now = () => clock;
  const live = options.mode === 'live';
  const stripe = fakeStripe({ now, livemode: live });
  stripe.addProduct();
  // untaggedPrices: prices without plan_code in their metadata, so a subscription's plan is found by its price id.
  const tag = (planCode: string) => options.untaggedPrices ? undefined : planCode;
  const monthly = stripe.addPrice({ lookupKey: 'arca_monthly', amount: 49_900, interval: 'month', planCode: tag('monthly') });
  const annual = stripe.addPrice({ lookupKey: 'arca_annual', amount: 499_000, interval: 'year', planCode: tag('annual') });
  // The catalog of the key's mode is this Stripe's; the other mode's slot holds ids it does not know (DN-13 §20).
  const priceOf = (code: string) => code === 'monthly' ? monthly.id : code === 'annual' ? annual.id : null;
  const repository = new InMemoryWebappRepository([...DEFAULT_PLANS, ...options.plans ?? []].map(plan => live
    ? { ...plan, stripe_product_id: 'arca', stripe_price_id: `price_1Test${plan.code}`, stripe_live_product_id: 'arca', stripe_live_price_id: priceOf(plan.code) }
    : { ...plan, stripe_product_id: 'arca', stripe_price_id: priceOf(plan.code) }));
  const scans = new InMemoryRepository();
  const billing = new StripeBillingProvider({ secretKey: options.mode === 'live' ? 'rk_live_fixture' : 'rk_test_fixture', webhookSecret: WEBHOOK_SECRET,
    mode: options.mode ?? 'test', appBaseUrl: APP }, { fetch: stripe.fetch, now, maxNetworkRetries: 0 });
  const service = new WebappService({ repository, scans, assessments: new InMemoryAssessmentRepository(), billing, sessionSecret: secret,
    appBaseUrl: APP, now });
  const auth = new MockAppAuth(secret, now);
  const app = webappRoutes({ service, auth, now });
  let scanCount = 0;

  async function call(method: string, path: string, input: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
    const response = await app.request(path, { method, body: input.raw ?? (input.body === undefined ? undefined : JSON.stringify(input.body)),
      headers: { 'Content-Type': 'application/json', ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}), ...input.headers } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
  }
  async function owner(email = 'owner@firm.com') {
    const session = await auth.issue(email);
    const scanId = `sc_flow${++scanCount}`;
    await scans.create({ id: `id_${scanId}`, scan_id: scanId, email, canonical_domain: 'firm.com',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null }, status: 'COMPLETED',
      result: fixtureResult(scanId, email), created_at: new Date(clock).toISOString(), completed_at: new Date(clock).toISOString(),
      duration_ms: 10, cached: false });
    const { claimId } = await service.issueClaim(await issueSessionToken(scanId, email, secret));
    const org = await service.createOrganization(session.user, { name: 'Smith & Co', claimId });
    return { token: session.token, user: session.user, org };
  }
  async function checkout(token: string, orgId: string, planCode = 'monthly') {
    const response = await call('POST', `/orgs/${orgId}/billing/checkout`, { token, body: { planCode } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const { url } = UrlResponse.parse(response.body);
    const session = [...stripe.sessions.values()].find(candidate => candidate.url === url)!;
    return { url, sessionId: session.id };
  }
  /** Stripe delivers the event: signed now, unless the test says otherwise. */
  async function deliver(event: unknown, input: { timestamp?: number; secret?: string; signature?: string | null } = {}) {
    const signed = stripe.signed(event, { timestamp: input.timestamp, secret: input.secret });
    const signature = input.signature === undefined ? signed.signature : input.signature;
    return call('POST', '/billing/webhook', { raw: signed.body, headers: signature === null ? {} : { 'Stripe-Signature': signature } });
  }
  /** An org that paid through Stripe Checkout, its subscription and the event that told the back. */
  async function paidOrg() {
    const o = await owner();
    const { sessionId } = await checkout(o.token, o.org.id);
    const subscription = stripe.completeCheckout(sessionId);
    const delivered = await deliver(stripe.event('checkout.session.completed', stripe.sessions.get(sessionId)));
    expect(delivered).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    return { ...o, sessionId, subscription };
  }
  const orgView = async (token: string, orgId: string) => OrgView.parse((await call('GET', `/orgs/${orgId}`, { token })).body);
  const audit = async (orgId: string) => (await repository.listAudit(orgId, { limit: 200 })).reverse().map(row => row.action);
  return { stripe, repository, service, billing, call, owner, checkout, deliver, paidOrg, orgView, audit, monthly, annual,
    advance: (ms: number) => { clock += ms; }, now };
}

describe('the billing status of a Stripe subscription (DN-13 §6.6)', () => {
  it('maps every provider status, keeping what an incomplete subscription would otherwise undo', () => {
    const live = { current: 'active', otherLiveSubscription: false } as const;
    const fresh = { current: 'pending_payment', otherLiveSubscription: false } as const;
    expect(billingStatusFor('active', fresh)).toBe('active');
    expect(billingStatusFor('trialing', fresh)).toBe('active');
    expect(billingStatusFor('past_due', live)).toBe('past_due');
    expect(billingStatusFor('unpaid', live)).toBe('canceled');
    expect(billingStatusFor('paused', live)).toBe('canceled');
    expect(billingStatusFor('canceled', live)).toBe('canceled');
    expect(billingStatusFor('incomplete', fresh)).toBe('pending_payment');
    expect(billingStatusFor('incomplete', { current: 'canceled', otherLiveSubscription: false })).toBe('canceled');
    expect(billingStatusFor('incomplete_expired', fresh)).toBe('pending_payment');
    expect(billingStatusFor('incomplete_expired', { current: 'canceled', otherLiveSubscription: false })).toBe('canceled');
    // Another subscription that is not paying never reads as access, so it cannot pass for a double charge.
    expect(billingStatusFor('incomplete', { current: 'active', otherLiveSubscription: true })).toBe('pending_payment');
    expect(billingStatusFor('some_new_status', live)).toBe('canceled');
  });
});

describe('Stripe Checkout (DN-13 §6.2)', () => {
  it('opens one session per organization: the same click again, or a second owner, gets the same URL', async () => {
    const s = await scene();
    const o = await s.owner();
    const first = await s.checkout(o.token, o.org.id);
    expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(s.stripe.customers.size).toBe(1);
    expect([...s.stripe.customers.values()][0]).toMatchObject({ name: 'Smith & Co', email: 'owner@firm.com', metadata: { org_id: o.org.id } });
    s.advance(10 * MINUTE);
    expect((await s.checkout(o.token, o.org.id)).url).toBe(first.url);
    // Two clicks at once start one session at Stripe.
    const other = await s.owner('second@firm.com');
    const [a, b] = await Promise.all([s.checkout(other.token, other.org.id), s.checkout(other.token, other.org.id)]);
    expect(a.url).toBe(b.url);
    expect(s.stripe.sessions.size).toBe(2);
    expect(s.stripe.customers.size).toBe(2);
    expect(await s.audit(o.org.id)).toEqual(['org.created', 'billing.checkout_started']);
    const session = s.stripe.sessions.get(first.sessionId)!;
    expect(session).toMatchObject({ client_reference_id: o.org.id, success_url: `${APP}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP}/app/billing` });
  });

  it('opens a new session once the open one expired, and expires the open one when the plan changes', async () => {
    const s = await scene();
    const o = await s.owner();
    const first = await s.checkout(o.token, o.org.id);
    s.advance(HOUR + MINUTE);
    const second = await s.checkout(o.token, o.org.id);
    expect(second.sessionId).not.toBe(first.sessionId);
    // A single customer for the organization, reused.
    expect(s.stripe.customers.size).toBe(1);
    const annual = await s.checkout(o.token, o.org.id, 'annual');
    expect(annual.sessionId).not.toBe(second.sessionId);
    expect(s.stripe.sessions.get(second.sessionId)!.status).toBe('expired');
    expect((await s.repository.getCheckoutSession(second.sessionId))?.status).toBe('expired');
    expect((await s.repository.getCheckoutSession(annual.sessionId))).toMatchObject({ status: 'open', plan_code: 'annual' });
  });

  it('refuses a checkout to an organization that pays, to anyone but the owner, and for a plan with no Stripe price', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    expect(await s.call('POST', `/orgs/${paid.org.id}/billing/checkout`, { token: paid.token, body: { planCode: 'monthly' } }))
      .toMatchObject({ status: 409 });
    const o = await s.owner('third@firm.com');
    await s.repository.updatePlan('annual', { stripe_price_id: null });
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'annual' } }))
      .toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(s.stripe.sessions.size).toBe(1);
  });

  it('answers 502 when Stripe is down, and writes nothing', async () => {
    const s = await scene();
    const o = await s.owner();
    s.stripe.failNext(call => call.path === '/v1/checkout/sessions');
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'monthly' } }))
      .toEqual({ status: 502, body: { error: 'billing_unavailable', message: expect.any(String) } });
    expect(await s.repository.getOpenCheckoutSession(o.org.id, new Date(s.now()).toISOString())).toBeNull();
    expect(await s.audit(o.org.id)).toEqual(['org.created']);
  });
});

describe('the return from Checkout (DN-13 §6.3)', () => {
  it('applies the subscription by the webhook path before the webhook arrives, only for the organization of the session', async () => {
    const s = await scene();
    const o = await s.owner();
    const { sessionId } = await s.checkout(o.token, o.org.id);
    // Not paid yet: nothing changes.
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/sync`, { token: o.token, body: { sessionId } }))
      .toMatchObject({ status: 200, body: { billingStatus: 'pending_payment', paidAccess: false } });
    const subscription = s.stripe.completeCheckout(sessionId);
    const synced = await s.call('POST', `/orgs/${o.org.id}/billing/sync`, { token: o.token, body: { sessionId } });
    expect(OrgView.parse(synced.body)).toMatchObject({ billingStatus: 'active', paidAccess: true });
    expect(await s.repository.getSubscription(o.org.id)).toMatchObject({ subscription_id: subscription.id, plan_code: 'monthly',
      provider_status: 'active', status: 'active' });
    expect((await s.repository.getCheckoutSession(sessionId))?.status).toBe('complete');
    // Again, and then the webhook: the same state, applied once more at most, never twice from the same sync.
    await s.call('POST', `/orgs/${o.org.id}/billing/sync`, { token: o.token, body: { sessionId } });
    expect((await s.audit(o.org.id)).filter(action => action === 'billing.event_applied')).toHaveLength(1);
    expect(await s.deliver(s.stripe.event('checkout.session.completed', s.stripe.sessions.get(sessionId))))
      .toMatchObject({ status: 200, body: { outcome: 'applied' } });
    expect(await s.orgView(o.token, o.org.id)).toMatchObject({ billingStatus: 'active' });
    // Another organization's session, or one that does not exist, is not found; a malformed id is a 400.
    const other = await s.owner('other@firm.com');
    expect(await s.call('POST', `/orgs/${other.org.id}/billing/sync`, { token: other.token, body: { sessionId } })).toMatchObject({ status: 404 });
    expect(await s.call('POST', `/orgs/${other.org.id}/billing/sync`, { token: other.token, body: { sessionId: 'cs_test_missing' } }))
      .toMatchObject({ status: 404 });
    expect(await s.call('POST', `/orgs/${other.org.id}/billing/sync`, { token: other.token, body: { sessionId: 'nope' } })).toMatchObject({ status: 400 });
    expect(await s.orgView(other.token, other.org.id)).toMatchObject({ billingStatus: 'pending_payment' });
  });
});

describe('the customer portal and the billing view (DN-13 §6.4, §7.2)', () => {
  it('opens the portal only once the organization is a Stripe customer, and shows every member the billing state', async () => {
    const s = await scene();
    const o = await s.owner();
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/portal`, { token: o.token }))
      .toMatchObject({ status: 409, body: { error: 'conflict', message: expect.stringMatching(/customer/i) } });
    const before = BillingView.parse((await s.call('GET', `/orgs/${o.org.id}/billing`, { token: o.token })).body);
    expect(before).toEqual({ billingStatus: 'pending_payment', plan: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, manageable: true });
    const { sessionId } = await s.checkout(o.token, o.org.id);
    const subscription = s.stripe.completeCheckout(sessionId);
    await s.deliver(s.stripe.event('checkout.session.completed', s.stripe.sessions.get(sessionId)));
    const portal = await s.call('POST', `/orgs/${o.org.id}/billing/portal`, { token: o.token });
    expect(UrlResponse.parse(portal.body).url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    s.stripe.setSubscription(subscription.id, { cancel_at_period_end: true });
    await s.deliver(s.stripe.event('customer.subscription.updated', s.stripe.subscriptions.get(subscription.id)));
    const periodEnd = new Date(subscription.items!.data![0]!.current_period_end! * 1000).toISOString();
    const monthly = PlanView.parse({ code: 'monthly', name: 'Monthly (example price)', amountCents: 49_900, currency: 'usd', interval: 'month' });
    expect(BillingView.parse((await s.call('GET', `/orgs/${o.org.id}/billing`, { token: o.token })).body))
      .toEqual({ billingStatus: 'active', plan: monthly, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: true, manageable: true });
    // A viewer reads it too, with nothing to manage.
    const invitation = await s.service.invite(o.user, o.org.id, { email: 'viewer@firm.com', role: 'viewer' });
    const viewer = await new MockAppAuth(secret, s.now).issue('viewer@firm.com');
    await s.service.acceptInvitation(viewer.user, invitation.inviteUrl!.split('/').at(-1)!);
    expect(await s.call('GET', `/orgs/${o.org.id}/billing`, { token: viewer.token }))
      .toMatchObject({ status: 200, body: { billingStatus: 'active', manageable: false } });
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/portal`, { token: viewer.token })).toMatchObject({ status: 403 });
  });
});

describe('POST /billing/webhook (DN-13 §6.5)', () => {
  it('verifies the signature over the raw body: wrong, missing or stale is a 400 that writes nothing', async () => {
    const s = await scene();
    const o = await s.owner();
    const { sessionId } = await s.checkout(o.token, o.org.id);
    s.stripe.completeCheckout(sessionId);
    const event = s.stripe.event('checkout.session.completed', s.stripe.sessions.get(sessionId));
    for (const input of [{ secret: 'whsec_wrong' }, { signature: null }, { signature: 't=1,v1=00' },
      { timestamp: Math.floor(s.now() / 1000) - 10 * 60 }]) {
      expect(await s.deliver(event, input), JSON.stringify(input)).toEqual({ status: 400, body: { error: 'invalid_signature', message: expect.any(String) } });
    }
    expect(await s.repository.isBillingEventProcessed(event.id)).toBe(false);
    expect(await s.orgView(o.token, o.org.id)).toMatchObject({ billingStatus: 'pending_payment' });
    expect(await s.deliver(event)).toMatchObject({ status: 200, body: { received: true, outcome: 'applied' } });
  });

  it('refuses an event of the other mode, acknowledges a type it does not act on, and a duplicate changes nothing', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const live = s.stripe.event('customer.subscription.updated', paid.subscription, { livemode: true });
    expect(await s.deliver(live)).toMatchObject({ status: 400 });
    expect(error.mock.calls.flat().join(' ')).toMatch(/livemode/);
    const ignored = s.stripe.event('customer.updated', { id: 'cus_1', object: 'customer' });
    expect(await s.deliver(ignored)).toMatchObject({ status: 200, body: { outcome: 'ignored' } });
    expect(await s.repository.isBillingEventProcessed(ignored.id)).toBe(false);
    const update = s.stripe.event('customer.subscription.updated', paid.subscription);
    expect(await s.deliver(update)).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    const retrieves = s.stripe.calls.filter(call => call.path.startsWith('/v1/subscriptions/')).length;
    expect(await s.deliver(update)).toMatchObject({ status: 200, body: { outcome: 'duplicate' } });
    // A duplicate does not even read Stripe.
    expect(s.stripe.calls.filter(call => call.path.startsWith('/v1/subscriptions/')).length).toBe(retrieves);
    expect((await s.audit(paid.org.id)).filter(action => action === 'billing.event_applied')).toHaveLength(2);
    error.mockRestore();
  });

  it('acknowledges an event of an organization it cannot find, and records it as such', async () => {
    const s = await scene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stray = s.stripe.addSubscription({ customer: 'cus_unknown', price: s.monthly });
    const event = s.stripe.event('customer.subscription.updated', stray);
    expect(await s.deliver(event)).toMatchObject({ status: 200, body: { outcome: 'unknown_org' } });
    expect(await s.repository.isBillingEventProcessed(event.id)).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unknown_org/);
    warn.mockRestore();
  });

  it('reads the subscription from Stripe instead of trusting the order of the events', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    // At Stripe the subscription was renewed, then canceled. The events arrive the other way round, each carrying its snapshot.
    const renewed = s.stripe.event('customer.subscription.updated', s.stripe.setSubscription(paid.subscription.id, { periodEnd: Math.floor(s.now() / 1000) + 60 * 86_400 }));
    const canceled = s.stripe.event('customer.subscription.deleted', s.stripe.setSubscription(paid.subscription.id, { status: 'canceled' }));
    expect(await s.deliver(canceled)).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'canceled', paidAccess: false });
    // The late renewal says "active" in its snapshot; Stripe says canceled now, and that is what stays.
    expect((renewed.data as { object: SubscriptionFixture }).object.status).toBe('active');
    expect(await s.deliver(renewed)).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'canceled', paidAccess: false });
    expect(await s.repository.getSubscription(paid.org.id)).toMatchObject({ provider_status: 'canceled', status: 'canceled' });
  });

  it('follows a subscription through incomplete, active, past due, unpaid, active again and canceled', async () => {
    const s = await scene();
    const o = await s.owner();
    const { sessionId } = await s.checkout(o.token, o.org.id);
    const subscription = s.stripe.completeCheckout(sessionId, 'incomplete');
    const step = async (status: Parameters<typeof s.stripe.setSubscription>[1]['status'], type = 'customer.subscription.updated') => {
      s.stripe.setSubscription(subscription.id, { status });
      expect(await s.deliver(s.stripe.event(type, s.stripe.subscriptions.get(subscription.id)))).toMatchObject({ status: 200 });
      return s.orgView(o.token, o.org.id);
    };
    expect(await step('incomplete', 'customer.subscription.created')).toMatchObject({ billingStatus: 'pending_payment', paidAccess: false });
    expect(await step('active')).toMatchObject({ billingStatus: 'active', paidAccess: true });
    expect(await step('past_due')).toMatchObject({ billingStatus: 'past_due', paidAccess: true });
    expect(await step('unpaid')).toMatchObject({ billingStatus: 'canceled', paidAccess: false });
    expect(await step('active')).toMatchObject({ billingStatus: 'active', paidAccess: true });
    expect(await step('canceled', 'customer.subscription.deleted')).toMatchObject({ billingStatus: 'canceled', paidAccess: false });
    expect(await s.repository.getSubscription(o.org.id)).toMatchObject({ subscription_id: subscription.id, provider_status: 'canceled' });
    // Canceled, the organization can pay again with a new checkout and a new subscription.
    const again = await s.checkout(o.token, o.org.id);
    const second = s.stripe.completeCheckout(again.sessionId);
    await s.deliver(s.stripe.event('checkout.session.completed', s.stripe.sessions.get(again.sessionId)));
    expect(await s.orgView(o.token, o.org.id)).toMatchObject({ billingStatus: 'active' });
    expect(await s.repository.getSubscription(o.org.id)).toMatchObject({ subscription_id: second.id });
  });

  it('never applies a second paying subscription over the live one: it audits it and raises the alarm', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const customer = paid.subscription.customer;
    const double = s.stripe.addSubscription({ customer, price: s.annual, orgId: paid.org.id });
    expect(await s.deliver(s.stripe.event('customer.subscription.created', double)))
      .toMatchObject({ status: 200, body: { outcome: 'duplicate_subscription' } });
    expect(await s.repository.getSubscription(paid.org.id)).toMatchObject({ subscription_id: paid.subscription.id, plan_code: 'monthly' });
    expect(await s.audit(paid.org.id)).toContain('billing.duplicate_subscription');
    expect(error.mock.calls.flat().join(' ')).toMatch(/duplicate_subscription/);
    error.mockRestore();
  });

  it('answers 500 when something fails half way, so Stripe retries, and the retry applies', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    s.stripe.setSubscription(paid.subscription.id, { status: 'past_due' });
    const event = s.stripe.event('invoice.payment_failed', s.stripe.invoice(paid.subscription, { paid: false }));
    s.stripe.failNext(call => call.path === `/v1/subscriptions/${paid.subscription.id}`);
    expect(await s.deliver(event)).toMatchObject({ status: 500 });
    expect(await s.repository.isBillingEventProcessed(event.id)).toBe(false);
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'active' });
    expect(error.mock.calls.flat().join(' ')).toMatch(new RegExp(`\\[billing\\] event ${event.id} invoice.payment_failed failed`));
    expect(await s.deliver(event)).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'past_due', paidAccess: true });
    expect((await s.audit(paid.org.id)).slice(-2)).toEqual(['billing.event_applied', 'billing.payment_failed']);
    error.mockRestore();
  });

  it('processes one organization at a time: a delivery waits for the one in flight, so the older read never lands last', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const path = `/v1/subscriptions/${paid.subscription.id}`;
    // The first delivery reads Stripe while the subscription is still active, and its answer is held.
    const reads = () => s.stripe.calls.filter(call => call.path === path).length;
    const before = reads();
    const release = s.stripe.hold(call => call.path === path);
    const first = s.deliver(s.stripe.event('customer.subscription.updated', paid.subscription));
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    // Meanwhile the customer cancels at Stripe and its event arrives.
    s.stripe.setSubscription(paid.subscription.id, { status: 'canceled' });
    const second = s.deliver(s.stripe.event('customer.subscription.deleted', s.stripe.subscriptions.get(paid.subscription.id)));
    await new Promise(resolve => setTimeout(resolve, 20));
    // The second has not read Stripe yet: it waits for the first.
    expect(reads()).toBe(before + 1);
    release();
    expect(await first).toMatchObject({ status: 200 });
    expect(await second).toMatchObject({ status: 200 });
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'canceled' });
  });

  it('records the events that only leave a trace: invoices, refunds, disputes, an expired checkout', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const customer = paid.subscription.customer;
    expect(await s.deliver(s.stripe.event('invoice.paid', s.stripe.invoice(paid.subscription)))).toMatchObject({ status: 200, body: { outcome: 'applied' } });
    expect(await s.deliver(s.stripe.event('invoice.payment_action_required', s.stripe.invoice(paid.subscription, { paid: false }))))
      .toMatchObject({ status: 200, body: { outcome: 'recorded' } });
    expect(await s.deliver(s.stripe.event('charge.refunded', { id: 'ch_1', object: 'charge', customer, amount_refunded: 49_900, currency: 'usd' })))
      .toMatchObject({ status: 200, body: { outcome: 'recorded' } });
    expect(await s.deliver(s.stripe.event('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 49_900, currency: 'usd' })))
      .toMatchObject({ status: 200 });
    expect(error.mock.calls.flat().join(' ')).toMatch(/dispute/);
    expect((await s.audit(paid.org.id)).slice(-4)).toEqual(['billing.event_applied', 'billing.invoice_paid', 'billing.payment_action_required',
      'billing.refunded']);
    // A refund does not change the access.
    expect(await s.orgView(paid.token, paid.org.id)).toMatchObject({ billingStatus: 'active' });
    const rows = await s.repository.listAudit(paid.org.id, { limit: 5 });
    expect(rows.find(row => row.action === 'billing.invoice_paid')).toMatchObject({ actor_kind: 'system', data: { amountCents: 49_900, currency: 'usd' } });

    const o = await s.owner('late@firm.com');
    const open = await s.checkout(o.token, o.org.id);
    expect(await s.deliver(s.stripe.event('checkout.session.expired', { ...s.stripe.sessions.get(open.sessionId), status: 'expired' })))
      .toMatchObject({ status: 200, body: { outcome: 'recorded' } });
    expect((await s.repository.getCheckoutSession(open.sessionId))?.status).toBe('expired');
    expect(await s.orgView(o.token, o.org.id)).toMatchObject({ billingStatus: 'pending_payment' });
    error.mockRestore();
  });
});

describe('the daily reconciliation (DN-13 §9.5)', () => {
  it('corrects what a lost webhook left behind, through the webhook path, and leaves what agrees alone', async () => {
    const s = await scene();
    const lost = await s.paidOrg();
    const fine = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A failed renewal whose webhook never arrived, and an update of the other subscription that did.
    s.stripe.setSubscription(lost.subscription.id, { status: 'past_due' });
    s.stripe.event('invoice.payment_failed', s.stripe.invoice(lost.subscription, { paid: false }));
    const delivered = s.stripe.event('customer.subscription.updated', fine.subscription);
    await s.deliver(delivered);
    const before = await s.audit(fine.org.id);
    const report = await s.service.reconcileBilling();
    expect(report).toEqual({ checked: 2, mismatched: 1, applied: 1, failed: 0 });
    expect(error.mock.calls.flat().join(' ')).toMatch(new RegExp(`\\[billing\\] reconcile mismatch org ${lost.org.id}`));
    expect(await s.orgView(lost.token, lost.org.id)).toMatchObject({ billingStatus: 'past_due' });
    expect(await s.audit(fine.org.id)).toEqual(before);
    // Run again: nothing left to correct.
    expect(await s.service.reconcileBilling()).toEqual({ checked: 2, mismatched: 0, applied: 0, failed: 0 });
    // Only the last 48 hours are read.
    s.advance(3 * 24 * HOUR);
    expect(await s.service.reconcileBilling()).toEqual({ checked: 0, mismatched: 0, applied: 0, failed: 0 });
    error.mockRestore();
  });

  it('counts a subscription it could not read as failed, under the line the alarm watches, and leaves the summary to its scheduler', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    s.stripe.event('customer.subscription.updated', paid.subscription);
    s.stripe.failNext(call => call.method === 'GET' && call.path === `/v1/subscriptions/${paid.subscription.id}`);
    expect(await s.service.reconcileBilling()).toEqual({ checked: 1, mismatched: 0, applied: 0, failed: 1 });
    expect(error.mock.calls.map(call => call.join(' ')))
      .toContain(`[billing] reconcile failed for subscription ${paid.subscription.id} (BillingUnavailable)`);
    // One line per run, written by the schedule (reconcile-schedule.ts) with the report's counts.
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/\[billing\] reconcile/);
    error.mockRestore();
    log.mockRestore();
  });
});

describe('prices and deletions at Stripe (DN-13 §6.1, §6.9)', () => {
  async function admin(s: Awaited<ReturnType<typeof scene>>) {
    const session = await new MockAppAuth(secret, s.now).issue('ops@arca.example');
    await s.repository.grantPlatformAdmin(session.user.userId, null);
    return session;
  }

  it('a new price from /admin is a new catalog price that the next checkout charges; Stripe down leaves the plan as it was', async () => {
    const s = await scene();
    const ops = await admin(s);
    s.stripe.failNext(call => call.method === 'POST' && call.path === '/v1/prices');
    expect(await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { amountCents: 59_900 } }))
      .toMatchObject({ status: 502, body: { error: 'billing_unavailable' } });
    expect(await s.repository.getPlan('monthly')).toMatchObject({ amount_cents: 49_900, stripe_price_id: s.monthly.id });
    const updated = await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { amountCents: 59_900 } });
    expect(updated).toMatchObject({ status: 200, body: { amountCents: 59_900 } });
    const plan = (await s.repository.getPlan('monthly'))!;
    expect(plan.stripe_price_id).not.toBe(s.monthly.id);
    expect(s.stripe.prices.get(plan.stripe_price_id!)).toMatchObject({ unit_amount: 59_900, lookup_key: 'arca_monthly', active: true });
    expect(s.stripe.prices.get(s.monthly.id)).toMatchObject({ active: false });
    // A change that is not a price does not touch Stripe.
    const writes = s.stripe.writes().length;
    expect(await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { name: 'Monthly' } })).toMatchObject({ status: 200 });
    expect(s.stripe.writes().length).toBe(writes);
    const o = await s.owner();
    const { sessionId } = await s.checkout(o.token, o.org.id);
    const created = s.stripe.calls.find(call => call.path === '/v1/checkout/sessions' && call.form.client_reference_id === o.org.id)!;
    expect(created.form.line_items).toEqual({ 0: { price: plan.stripe_price_id, quantity: '1' } });
    expect(sessionId).toMatch(/^cs_test_/);
  });

  it('approving a deletion cancels the subscription at Stripe, and the webhook that follows moves the status', async () => {
    const s = await scene();
    const paid = await s.paidOrg();
    const ops = await admin(s);
    const request = await s.call('POST', `/orgs/${paid.org.id}/deletion-request`, { token: paid.token, body: { reason: 'Closing the firm' } });
    const id = (request.body as { id: string }).id;
    expect(await s.call('POST', `/admin/deletion-requests/${id}/approve`, { token: ops.token })).toMatchObject({ status: 200 });
    expect(s.stripe.subscriptions.get(paid.subscription.id)!.status).toBe('canceled');
    await s.deliver(s.stripe.event('customer.subscription.deleted', s.stripe.subscriptions.get(paid.subscription.id)));
    expect((await s.repository.getOrganization(paid.org.id))).toMatchObject({ billing_status: 'canceled', deleted_at: expect.any(String) });
  });
});

describe('the catalog of the mode of the key (DN-13 §20)', () => {
  async function admin(s: Awaited<ReturnType<typeof scene>>) {
    const session = await new MockAppAuth(secret, s.now).issue('ops@arca.example');
    await s.repository.grantPlatformAdmin(session.user.userId, null);
    return session;
  }

  it('with a live key charges the live price, and a plan with only a test price cannot be bought', async () => {
    const s = await scene({ mode: 'live' });
    const o = await s.owner();
    const { sessionId } = await s.checkout(o.token, o.org.id);
    expect(sessionId).toMatch(/^cs_live_/);
    const created = s.stripe.calls.find(call => call.path === '/v1/checkout/sessions' && call.form.client_reference_id === o.org.id)!;
    expect(created.form.line_items).toEqual({ 0: { price: s.monthly.id, quantity: '1' } });
    const other = await s.owner('second@firm.com');
    await s.repository.updatePlan('annual', { stripe_live_price_id: null });
    expect(await s.call('POST', `/orgs/${other.org.id}/billing/checkout`, { token: other.token, body: { planCode: 'annual' } }))
      .toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  it('with a live key a new price from /admin moves the live price and leaves the test one', async () => {
    const s = await scene({ mode: 'live' });
    const ops = await admin(s);
    expect(await s.call('PUT', '/admin/plans/monthly', { token: ops.token, body: { amountCents: 59_900 } })).toMatchObject({ status: 200 });
    const plan = (await s.repository.getPlan('monthly'))!;
    expect(plan.stripe_price_id).toBe('price_1Testmonthly');
    expect(plan.stripe_live_price_id).not.toBe(s.monthly.id);
    expect(s.stripe.prices.get(plan.stripe_live_price_id!)).toMatchObject({ unit_amount: 59_900, livemode: true, active: true });
  });

  it('finds the plan of a subscription by the price of its own mode when the price names no plan', async () => {
    // Two monthly plans, so the interval alone cannot tell them apart.
    const extra: PlanRecord = { code: 'monthly_team', name: 'Team', amount_cents: 99_900, currency: 'usd', interval: 'month', active: true,
      stripe_product_id: null, stripe_price_id: null, stripe_live_product_id: null, stripe_live_price_id: null };
    for (const mode of ['test', 'live'] as const) {
      const s = await scene({ mode, untaggedPrices: true, plans: [extra] });
      s.stripe.addPrice({ id: 'price_1Teammonthly', amount: 99_900, interval: 'month' });
      await s.repository.updatePlan('monthly_team', mode === 'live' ? { stripe_live_price_id: 'price_1Teammonthly' } : { stripe_price_id: 'price_1Teammonthly' });
      const paid = await s.paidOrg();
      expect((await s.repository.getSubscription(paid.org.id))?.plan_code, mode).toBe('monthly');
    }
  });
});
