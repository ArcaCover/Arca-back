import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { BillingUnavailable } from '../../src/webapp/billing.js';
import { STRIPE_API_VERSION, StripeBillingProvider, providerEventOf } from '../../src/webapp/stripe.js';
import type { PlanRecord } from '../../src/webapp/types.js';
import { WEBHOOK_SECRET, fakeStripe } from '../fixtures/stripe.js';

// StripeBillingProvider against a fake Stripe (DN-13 §6, §11): the real SDK, its real requests, no network.
const T0 = Date.UTC(2026, 10, 20, 12);
const ORG = '3f0c2a52-6a1e-4f43-9d3a-0c1b2a3d4e5f';
const APP = 'https://arcacover.com';

function setup(options: { now?: () => number; mode?: 'test' | 'live' } = {}) {
  const now = options.now ?? (() => T0);
  const stripe = fakeStripe({ now, livemode: options.mode === 'live' });
  stripe.addProduct();
  const price = stripe.addPrice({ id: 'price_monthly1', lookupKey: 'arca_monthly', amount: 49_900, interval: 'month', planCode: 'monthly' });
  const plan: PlanRecord = { code: 'monthly', name: 'Monthly', amount_cents: 49_900, currency: 'usd', interval: 'month', active: true,
    stripe_product_id: 'arca', stripe_price_id: price.id };
  const provider = new StripeBillingProvider({ secretKey: options.mode === 'live' ? 'rk_live_fixture' : 'rk_test_fixture', webhookSecret: WEBHOOK_SECRET,
    mode: options.mode ?? 'test', appBaseUrl: APP }, { fetch: stripe.fetch, now, maxNetworkRetries: 0 });
  return { stripe, provider, plan, price };
}

describe('StripeBillingProvider', () => {
  it('pins the API version of the SDK it was written against', async () => {
    expect(STRIPE_API_VERSION).toBe('2026-10-28.endive');
    expect(Stripe.API_VERSION).toBe(STRIPE_API_VERSION);
    const { stripe, provider } = setup();
    await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    expect(stripe.calls[0]!.stripeVersion).toBe(STRIPE_API_VERSION);
    expect(provider.mode).toBe('test');
    expect(provider.webhooks).toBe(true);
  });

  it('creates one customer per organization, named after it, with an idempotency key of the organization', async () => {
    const { stripe, provider } = setup();
    const first = await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    const again = await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    expect(again).toEqual(first);
    expect(first.customerId).toMatch(/^cus_/);
    expect(stripe.customers.size).toBe(1);
    expect(stripe.calls[0]).toMatchObject({ method: 'POST', path: '/v1/customers', idempotencyKey: `customer:${ORG}`,
      form: { name: 'Smith & Co', email: 'owner@firm.com', metadata: { org_id: ORG } } });
  });

  it('opens a subscription checkout on the catalog price, with the organization on the session and on the subscription', async () => {
    const { stripe, provider, plan } = setup();
    const { customerId } = await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    const checkout = await provider.createCheckout({ orgId: ORG, customerId, plan,
      successUrl: `${APP}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${APP}/app/billing` });
    expect(checkout).toEqual({ sessionId: expect.stringMatching(/^cs_test_/), url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
      expiresAt: new Date(T0 + 60 * 60 * 1000).toISOString() });
    const call = stripe.calls.at(-1)!;
    expect(call.path).toBe('/v1/checkout/sessions');
    expect(call.idempotencyKey).toBe(`checkout:${ORG}:monthly:${Math.floor(T0 / 60_000)}`);
    expect(call.form).toEqual({ mode: 'subscription', customer: customerId, client_reference_id: ORG,
      line_items: { 0: { price: plan.stripe_price_id, quantity: '1' } }, metadata: { org_id: ORG }, subscription_data: { metadata: { org_id: ORG } },
      success_url: `${APP}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP}/app/billing`,
      billing_address_collection: 'required', customer_update: { name: 'auto', address: 'auto' }, allowed_payment_method_types: { 0: 'card' },
      expires_at: String(Math.floor(T0 / 1000) + 3600) });
    // The same click in the same minute is the same session.
    expect(await provider.createCheckout({ orgId: ORG, customerId, plan,
      successUrl: `${APP}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${APP}/app/billing` })).toEqual(checkout);
    expect(stripe.sessions.size).toBe(1);
    await expect(provider.createCheckout({ orgId: ORG, customerId, plan: { ...plan, stripe_price_id: null }, successUrl: 's', cancelUrl: 'c' }))
      .rejects.toThrow(/no Stripe price/);
  });

  it('reads a checkout back, expires an open one, and says when it completed first', async () => {
    const { stripe, provider, plan } = setup();
    const { customerId } = await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    const open = await provider.createCheckout({ orgId: ORG, customerId, plan, successUrl: 's', cancelUrl: 'c' });
    expect(await provider.checkoutState(open.sessionId)).toEqual({ sessionId: open.sessionId, orgId: ORG, customerId, subscriptionId: null,
      status: 'open', livemode: false });
    expect(await provider.expireCheckout(open.sessionId)).toBe('expired');
    expect(stripe.sessions.get(open.sessionId)!.status).toBe('expired');
    const paid = await provider.createCheckout({ orgId: ORG, customerId, plan: { ...plan, code: 'monthly2' }, successUrl: 's', cancelUrl: 'c' });
    const subscription = stripe.completeCheckout(paid.sessionId);
    expect(await provider.expireCheckout(paid.sessionId)).toBe('complete');
    expect(await provider.checkoutState(paid.sessionId)).toMatchObject({ status: 'complete', subscriptionId: subscription.id });
    expect(await provider.checkoutState('cs_test_unknown')).toBeNull();
  });

  it('opens the customer portal and cancels a subscription, once', async () => {
    const { stripe, provider, price } = setup();
    const { customerId } = await provider.ensureCustomer({ orgId: ORG, name: 'Smith & Co', email: 'owner@firm.com' });
    expect(await provider.createPortal({ customerId, returnUrl: `${APP}/app/billing` }))
      .toEqual({ url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\//) });
    expect(stripe.calls.at(-1)).toMatchObject({ path: '/v1/billing_portal/sessions', form: { customer: customerId, return_url: `${APP}/app/billing` } });
    const subscription = stripe.addSubscription({ customer: customerId, price, orgId: ORG });
    await provider.cancel({ orgId: ORG, subscriptionId: subscription.id });
    expect(stripe.subscriptions.get(subscription.id)!.status).toBe('canceled');
    // Already canceled (by the dashboard, or a retry) is done, not an error.
    await expect(provider.cancel({ orgId: ORG, subscriptionId: subscription.id })).resolves.toBeUndefined();
  });

  it('reads the current subscription with its period from the item, as the pinned version puts it', async () => {
    const { stripe, provider, price } = setup();
    const subscription = stripe.addSubscription({ customer: 'cus_1', price, orgId: ORG, status: 'past_due' });
    stripe.setSubscription(subscription.id, { cancel_at_period_end: true });
    const item = subscription.items!.data![0]!;
    expect(await provider.subscriptionState(subscription.id)).toEqual({ subscriptionId: subscription.id, customerId: 'cus_1', orgId: ORG,
      status: 'past_due', priceId: price.id, planCode: 'monthly', interval: 'month', cancelAtPeriodEnd: true, livemode: false,
      currentPeriodStart: new Date(item.current_period_start! * 1000).toISOString(),
      currentPeriodEnd: new Date(item.current_period_end! * 1000).toISOString() });
    expect(await provider.subscriptionState('sub_unknown')).toBeNull();
  });

  it('turns Stripe being down into BillingUnavailable, and its 4xx into a plain error', async () => {
    const { stripe, provider } = setup();
    stripe.failNext(call => call.path === '/v1/customers');
    await expect(provider.ensureCustomer({ orgId: ORG, name: 'x', email: 'a@b.co' })).rejects.toBeInstanceOf(BillingUnavailable);
    stripe.failNext(call => call.path === '/v1/customers', () => { throw new TypeError('fetch failed'); });
    await expect(provider.ensureCustomer({ orgId: ORG, name: 'x', email: 'a@b.co' })).rejects.toBeInstanceOf(BillingUnavailable);
    stripe.failNext(call => call.path === '/v1/customers', () => Response.json({ error: { type: 'invalid_request_error', message: 'Bad' } },
      { status: 400 }));
    const refused = await provider.ensureCustomer({ orgId: ORG, name: 'x', email: 'a@b.co' }).catch(error => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(BillingUnavailable);
  });

  describe('webhooks', () => {
    it('verifies the signature over the raw body and refuses a wrong, missing or stale one', async () => {
      let clock = T0;
      const { stripe, provider, price } = setup({ now: () => clock });
      const subscription = stripe.addSubscription({ customer: 'cus_1', price, orgId: ORG });
      const event = stripe.event('customer.subscription.updated', subscription);
      const { body, signature } = stripe.signed(event);
      expect(await provider.parseWebhook(Buffer.from(body), signature)).toMatchObject({ id: event.id, type: 'customer.subscription.updated',
        subscriptionId: subscription.id, orgId: ORG, customerId: 'cus_1', livemode: false });
      // Re-serialized JSON is a different body: the signature covers the bytes Stripe sent.
      expect(await provider.parseWebhook(JSON.stringify(JSON.parse(body)), signature)).toBeNull();
      expect(await provider.parseWebhook(body, stripe.signed(event, { secret: 'whsec_other' }).signature)).toBeNull();
      expect(await provider.parseWebhook(body, undefined)).toBeNull();
      expect(await provider.parseWebhook(body, 'garbage')).toBeNull();
      // Five minutes of tolerance, on the process clock.
      clock = T0 + 6 * 60 * 1000;
      expect(await provider.parseWebhook(body, signature)).toBeNull();
      clock = T0 + 4 * 60 * 1000;
      expect(await provider.parseWebhook(body, signature)).not.toBeNull();
    });

    it('translates the events DN-13 §6.5 acts on, finding the subscription and the organization where each object keeps them', async () => {
      const { stripe, provider, plan, price } = setup();
      const subscription = stripe.addSubscription({ customer: 'cus_1', price, orgId: ORG });
      const { customerId } = await provider.ensureCustomer({ orgId: ORG, name: 'x', email: 'a@b.co' });
      const checkout = await provider.createCheckout({ orgId: ORG, customerId, plan, successUrl: 's', cancelUrl: 'c' });
      const completed = stripe.completeCheckout(checkout.sessionId);
      const translated = (type: string, object: unknown) => providerEventOf(stripe.event(type, object) as unknown as Stripe.Event);
      expect(translated('checkout.session.completed', stripe.sessions.get(checkout.sessionId))).toMatchObject({ type: 'checkout.session.completed',
        orgId: ORG, customerId, subscriptionId: completed.id, checkoutSessionId: checkout.sessionId });
      expect(translated('checkout.session.expired', { ...stripe.sessions.get(checkout.sessionId), status: 'expired', subscription: null }))
        .toMatchObject({ orgId: ORG, subscriptionId: null, checkoutSessionId: checkout.sessionId });
      for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
        expect(translated(type, subscription)).toMatchObject({ type, orgId: ORG, customerId: 'cus_1', subscriptionId: subscription.id });
      }
      const invoice = stripe.invoice(subscription, { amount: 49_900 });
      expect(translated('invoice.paid', invoice)).toMatchObject({ orgId: ORG, customerId: 'cus_1', subscriptionId: subscription.id,
        amountCents: 49_900, currency: 'usd' });
      expect(translated('invoice.payment_failed', stripe.invoice(subscription, { paid: false }))).toMatchObject({ subscriptionId: subscription.id,
        amountCents: 49_900 });
      // An endpoint on an account version from before basil sends the subscription at the top of the invoice: still found.
      expect(translated('invoice.paid', { id: 'in_old', object: 'invoice', customer: 'cus_1', subscription: subscription.id,
        subscription_details: { metadata: { org_id: ORG } }, amount_paid: 100, currency: 'usd' })).toMatchObject({ subscriptionId: subscription.id,
        orgId: ORG, amountCents: 100 });
      expect(translated('charge.refunded',{ id: 'ch_1', object: 'charge', customer: 'cus_1', amount_refunded: 1000, currency: 'usd' }))
        .toMatchObject({ orgId: null, customerId: 'cus_1', subscriptionId: null, amountCents: 1000 });
      expect(translated('charge.dispute.created', { id: 'dp_1', object: 'dispute', charge: 'ch_1', amount: 49_900, currency: 'usd' }))
        .toMatchObject({ orgId: null, customerId: null, objectId: 'dp_1', amountCents: 49_900 });
      // Anything else keeps its type and names nothing.
      expect(translated('customer.updated', { id: 'cus_1', object: 'customer' })).toMatchObject({ type: 'customer.updated', orgId: null,
        subscriptionId: null });
    });

    it('lists the subscriptions that changed since a time, from the events Stripe keeps', async () => {
      const { stripe, provider, price } = setup();
      const [a, b] = [stripe.addSubscription({ customer: 'cus_1', price }), stripe.addSubscription({ customer: 'cus_2', price })];
      stripe.event('customer.subscription.updated', a, { created: Math.floor(T0 / 1000) - 3600 });
      stripe.event('invoice.paid', stripe.invoice(b), { created: Math.floor(T0 / 1000) - 60 });
      stripe.event('customer.subscription.updated', b, { created: Math.floor(T0 / 1000) - 30 });
      stripe.event('customer.subscription.updated', a, { created: Math.floor(T0 / 1000) - 3 * 86_400 });
      expect((await provider.recentSubscriptionIds(new Date(T0 - 2 * 3600 * 1000))).sort()).toEqual([a.id, b.id].sort());
      expect(await provider.recentSubscriptionIds(new Date(T0 - 10 * 60 * 1000))).toEqual([b.id]);
    });
  });

  describe('catalog prices', () => {
    it('creates a new catalog price for a new amount, moves the lookup key to it and retires the old one', async () => {
      const { stripe, provider, plan } = setup();
      const created = await provider.createPrice({ plan, amountCents: 59_900, currency: 'usd', interval: 'month' });
      expect(created).toEqual({ priceId: expect.stringMatching(/^price_/), productId: 'arca' });
      const fresh = stripe.prices.get(created.priceId)!;
      expect(fresh).toMatchObject({ unit_amount: 59_900, lookup_key: 'arca_monthly', product: 'arca', metadata: { plan_code: 'monthly' },
        recurring: { interval: 'month' } });
      expect(stripe.prices.get(plan.stripe_price_id!)).toMatchObject({ active: false, lookup_key: null });
      expect(stripe.calls.find(call => call.method === 'POST' && call.path === '/v1/prices')).toMatchObject({
        form: { transfer_lookup_key: 'true', lookup_key: 'arca_monthly' } });
      // A retry after the plan row failed to change finds that price instead of making another.
      const writes = stripe.writes().length;
      expect(await provider.createPrice({ plan, amountCents: 59_900, currency: 'usd', interval: 'month' })).toEqual(created);
      expect(stripe.writes().length).toBe(writes);
    });

    it('creates the catalog product for a plan that has none yet', async () => {
      const { stripe, provider, plan } = setup();
      stripe.products.clear();
      const created = await provider.createPrice({ plan: { ...plan, stripe_product_id: null, stripe_price_id: null }, amountCents: 499_000,
        currency: 'usd', interval: 'year' });
      expect(created.productId).toBe('arca');
      expect(stripe.products.get('arca')).toMatchObject({ name: 'ARCA' });
    });
  });

  it('never sends the key anywhere but in the Authorization header to api.stripe.com', async () => {
    const seen: string[] = [];
    const stripe = fakeStripe({ now: () => T0 });
    const spy = vi.fn<typeof fetch>(async (input, init) => {
      seen.push(JSON.stringify([String(input), init?.body ?? '']));
      return stripe.fetch(input, init);
    });
    const provider = new StripeBillingProvider({ secretKey: 'rk_test_secretvalue', webhookSecret: WEBHOOK_SECRET, mode: 'test', appBaseUrl: APP },
      { fetch: spy, now: () => T0, maxNetworkRetries: 0 });
    await provider.ensureCustomer({ orgId: ORG, name: 'x', email: 'a@b.co' });
    expect(seen.join('')).not.toContain('rk_test_secretvalue');
  });
});
