import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';

/**
 * A small Stripe for the tests (DN-13 §11): a `fetch` that the SDK's fetch client calls instead of api.stripe.com, so the real
 * StripeBillingProvider runs its real requests with no network. It answers only what ARCA sends, with objects shaped as the API
 * version the SDK pins (2026-10-28.endive: the billing period on each subscription item, the subscription of an invoice under
 * `parent.subscription_details`). Each object is typed against the SDK's own types (deeply partial), so a field that moved or
 * was renamed in the pinned version fails the typecheck here. Idempotency keys replay the first answer, as Stripe does.
 */
export const WEBHOOK_SECRET = 'whsec_fixture';

type DeepPartial<T> = T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type SubscriptionFixture = DeepPartial<Stripe.Subscription> & { id: string; status: Stripe.Subscription.Status; customer: string;
  metadata: Record<string, string> };
export type CheckoutFixture = DeepPartial<Stripe.Checkout.Session> & { id: string; status: 'open' | 'complete' | 'expired' };
export type PriceFixture = DeepPartial<Stripe.Price> & { id: string; product: string; active: boolean; lookup_key: string | null;
  unit_amount: number; currency: string; metadata: Record<string, string> };
export type Call = { method: string; path: string; form: Record<string, unknown>; query: Record<string, unknown>; idempotencyKey: string | null;
  stripeVersion: string | null };

const DAY = 86_400;
const randomId = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

/** `a[b][0][c]=d` form or query fields as the nested object they stand for. */
export function parseForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const path = key.replace(/\]/g, '').split('[');
    let node: Record<string, unknown> = root;
    for (const [index, part] of path.entries()) {
      if (index === path.length - 1) { node[part] = value; break; }
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
  }
  return root;
}
const list = (value: unknown): string[] => value && typeof value === 'object' ? Object.values(value as Record<string, string>) : [];

function stripeError(status: number, type: string, message: string, code?: string) {
  return Response.json({ error: { type, message, ...(code ? { code } : {}) } }, { status, headers: { 'request-id': randomId('req') } });
}
const missing = (what: string, id: string) => stripeError(404, 'invalid_request_error', `No such ${what}: '${id}'`, 'resource_missing');

export function fakeStripe(options: { now?: () => number; livemode?: boolean } = {}) {
  const now = () => Math.floor((options.now ?? Date.now)() / 1000);
  const livemode = options.livemode ?? false;
  const calls: Call[] = [];
  const customers = new Map<string, DeepPartial<Stripe.Customer> & { id: string; metadata: Record<string, string> }>();
  const sessions = new Map<string, CheckoutFixture>();
  const subscriptions = new Map<string, SubscriptionFixture>();
  const prices = new Map<string, PriceFixture>();
  const products = new Map<string, DeepPartial<Stripe.Product> & { id: string }>();
  const events: Array<DeepPartial<Stripe.Event> & { id: string; type: string; created: number }> = [];
  const replays = new Map<string, { status: number; body: unknown }>();
  // A failure for the next calls that match, as Stripe would send it: a 5xx, a network error, a stall.
  const failures: Array<{ match: (call: Call) => boolean; respond: () => Response | Promise<Response> }> = [];
  // A gate a call waits on before it is answered, to let a test hold a request in flight.
  const gates: Array<{ match: (call: Call) => boolean; open: Promise<void> }> = [];

  function priceOf(id: string): PriceFixture | undefined { return prices.get(id); }
  function subscriptionObject(id: string, input: { customer: string; price: PriceFixture; metadata: Record<string, string>;
    status?: Stripe.Subscription.Status; start?: number }): SubscriptionFixture {
    const start = input.start ?? now();
    const end = start + (input.price.recurring?.interval === 'year' ? 365 : 30) * DAY;
    return { id, object: 'subscription', customer: input.customer, status: input.status ?? 'active', livemode, metadata: input.metadata,
      cancel_at: null, cancel_at_period_end: false, canceled_at: null, collection_method: 'charge_automatically', created: start, currency: input.price.currency,
      start_date: start, ended_at: null, latest_invoice: randomId('in'), billing_cycle_anchor: start,
      items: { object: 'list', has_more: false, url: `/v1/subscription_items?subscription=${id}`, data: [{ id: randomId('si'), object: 'subscription_item',
        created: start, current_period_start: start, current_period_end: end, metadata: {}, price: input.price, quantity: 1, subscription: id }] } };
  }
  function checkoutObject(form: Record<string, unknown>): CheckoutFixture {
    const id = `cs_${livemode ? 'live' : 'test'}_${randomBytes(16).toString('hex')}`;
    const metadata = (form.metadata ?? {}) as Record<string, string>;
    return { id, object: 'checkout.session', mode: 'subscription', status: 'open', livemode, customer: form.customer as string,
      client_reference_id: (form.client_reference_id as string | undefined) ?? null, metadata, subscription: null,
      success_url: form.success_url as string, cancel_url: form.cancel_url as string, url: `https://checkout.stripe.com/c/pay/${id}`,
      expires_at: Number(form.expires_at ?? now() + DAY), created: now(), payment_status: 'unpaid' };
  }

  async function answer(call: Call): Promise<{ status: number; body: unknown } | Response> {
    const { method, path, form, query } = call;
    const parts = path.replace(/^\/v1\//, '').split('/');
    const ok = (body: unknown) => ({ status: 200, body });
    if (method === 'POST' && path === '/v1/customers') {
      const customer = { id: randomId('cus'), object: 'customer' as const, name: form.name as string, email: form.email as string,
        metadata: (form.metadata ?? {}) as Record<string, string>, livemode, created: now() };
      customers.set(customer.id, customer);
      return ok(customer);
    }
    if (parts[0] === 'checkout' && parts[1] === 'sessions') {
      if (method === 'POST' && parts.length === 2) {
        if (!customers.has(form.customer as string)) return missing('customer', String(form.customer));
        const items = (form.line_items ?? {}) as Record<string, { price: string }>;
        const price = items['0']?.price;
        if (!price || !priceOf(price)) return missing('price', String(price));
        // Like the test account of the first real run (DN-13 §18.10): Managed Payments is on by default, and Stripe refuses a
        // payment method list on a session that does not turn it off.
        if (form.allowed_payment_method_types !== undefined && (form.managed_payments as { enabled?: string } | undefined)?.enabled !== 'false') {
          return stripeError(400, 'invalid_request_error', 'allowed_payment_method_types cannot be used with Managed Payments, which is enabled by default on your account. Remove allowed_payment_method_types, or pass managed_payments[enabled]=false to disable it for this request.');
        }
        const session = checkoutObject(form);
        sessions.set(session.id, session);
        return ok(session);
      }
      const session = sessions.get(parts[2]!);
      if (!session) return missing('checkout.session', parts[2]!);
      if (method === 'GET') return ok(session);
      if (method === 'POST' && parts[3] === 'expire') {
        if (session.status !== 'open') {
          return stripeError(400, 'invalid_request_error', `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${session.status}".`);
        }
        session.status = 'expired';
        return ok(session);
      }
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') {
      if (!customers.has(form.customer as string)) return missing('customer', String(form.customer));
      const id = randomId('bps');
      return ok({ id, object: 'billing_portal.session', customer: form.customer as string, return_url: form.return_url as string, livemode,
        url: `https://billing.stripe.com/p/session/${id}`, created: now() } satisfies DeepPartial<Stripe.BillingPortal.Session>);
    }
    if (parts[0] === 'subscriptions' && parts[1]) {
      const subscription = subscriptions.get(parts[1]);
      if (!subscription) return missing('subscription', parts[1]);
      if (method === 'GET') return ok(subscription);
      if (method === 'DELETE') {
        if (subscription.status === 'canceled') {
          return stripeError(400, 'invalid_request_error', `A canceled subscription can only update its cancellation_details and metadata.`);
        }
        Object.assign(subscription, { status: 'canceled', canceled_at: now(), ended_at: now() });
        return ok(subscription);
      }
    }
    if (parts[0] === 'prices') {
      if (method === 'GET' && parts.length === 1) {
        const keys = list(query.lookup_keys);
        const found = [...prices.values()].filter(price => (!keys.length || (price.lookup_key !== null && keys.includes(price.lookup_key)))
          && (query.active === undefined || String(price.active) === query.active));
        return ok({ object: 'list', data: found, has_more: false, url: '/v1/prices' });
      }
      if (method === 'POST' && parts.length === 1) {
        const lookupKey = (form.lookup_key as string | undefined) ?? null;
        if (lookupKey && form.transfer_lookup_key !== 'true' && [...prices.values()].some(price => price.lookup_key === lookupKey)) {
          return stripeError(400, 'invalid_request_error', `A price (\`${lookupKey}\`) already uses that lookup key.`);
        }
        if (lookupKey) for (const price of prices.values()) if (price.lookup_key === lookupKey) price.lookup_key = null;
        if (!products.has(form.product as string)) return missing('product', String(form.product));
        const recurring = form.recurring as { interval: 'month' | 'year' };
        const price: PriceFixture = { id: randomId('price'), object: 'price', active: true, product: form.product as string, lookup_key: lookupKey,
          unit_amount: Number(form.unit_amount), currency: form.currency as string, type: 'recurring', livemode, created: now(),
          recurring: { interval: recurring.interval, interval_count: 1, usage_type: 'licensed' }, metadata: (form.metadata ?? {}) as Record<string, string> };
        prices.set(price.id, price);
        return ok(price);
      }
      const price = prices.get(parts[1]!);
      if (!price) return missing('price', parts[1]!);
      if (method === 'GET') return ok(price);
      if (method === 'POST') {
        if (form.active !== undefined) price.active = form.active === 'true';
        return ok(price);
      }
    }
    if (parts[0] === 'products') {
      if (method === 'POST' && parts.length === 1) {
        const id = (form.id as string | undefined) ?? randomId('prod');
        if (products.has(id)) return stripeError(400, 'invalid_request_error', `Product already exists.`, 'resource_already_exists');
        const product = { id, object: 'product' as const, name: form.name as string, active: true, livemode, created: now(),
          metadata: (form.metadata ?? {}) as Record<string, string> };
        products.set(id, product);
        return ok(product);
      }
      const product = products.get(parts[1]!);
      if (!product) return missing('product', parts[1]!);
      if (method === 'GET') return ok(product);
    }
    if (method === 'GET' && path === '/v1/events') {
      const types = list(query.types);
      const since = Number((query.created as Record<string, string> | undefined)?.gte ?? 0);
      const found = events.filter(event => event.created >= since && (!types.length || types.includes(event.type)))
        .sort((a, b) => b.created - a.created);
      const after = query.starting_after as string | undefined;
      const start = after ? found.findIndex(event => event.id === after) + 1 : 0;
      const limit = Number(query.limit ?? 10);
      return ok({ object: 'list', data: found.slice(start, start + limit), has_more: start + limit < found.length, url: '/v1/events' });
    }
    return stripeError(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path}).`);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
    const body = typeof init?.body === 'string' ? init.body : '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, path: url.pathname, form: parseForm(body), query: parseForm(url.search.slice(1)),
      idempotencyKey: headers.get('Idempotency-Key'), stripeVersion: headers.get('Stripe-Version') };
    if (url.host !== 'api.stripe.com') throw new Error(`The fake Stripe only answers api.stripe.com, not ${url.host}`);
    calls.push(call);
    for (const gate of gates.splice(0)) {
      if (gate.match(call)) await gate.open; else gates.push(gate);
    }
    const failure = failures.findIndex(entry => entry.match(call));
    if (failure >= 0) return failures.splice(failure, 1)[0]!.respond();
    const replayKey = call.idempotencyKey && `${method} ${call.path} ${call.idempotencyKey}`;
    const replay = replayKey ? replays.get(replayKey) : undefined;
    const result = replay ?? await answer(call);
    if (result instanceof Response) return result;
    if (replayKey && !replay && result.status < 500) replays.set(replayKey, result);
    return Response.json(structuredClone(result.body), { status: result.status,
      headers: { 'request-id': randomId('req'), ...(replay ? { 'Idempotent-Replayed': 'true' } : {}) } });
  };

  const signer = new Stripe('sk_test_signer');
  return {
    fetch, calls, customers, sessions, subscriptions, prices, products, events,
    /** The calls that changed something at Stripe. */
    writes: () => calls.filter(call => call.method !== 'GET'),
    /** The next call that matches gets this answer instead (one use). */
    failNext(match: (call: Call) => boolean, respond: () => Response | Promise<Response> = () => stripeError(500, 'api_error', 'Something went wrong on Stripe\'s end.')) {
      failures.push({ match, respond });
    },
    /** Holds the next call that matches until the returned function is called. */
    hold(match: (call: Call) => boolean): () => void {
      let release!: () => void;
      gates.push({ match, open: new Promise<void>(resolve => { release = resolve; }) });
      return release;
    },
    addProduct(id = 'arca') {
      const product = { id, object: 'product' as const, name: 'ARCA', active: true, livemode, created: now(), metadata: {} };
      products.set(id, product);
      return product;
    },
    addPrice(input: { id?: string; product?: string; lookupKey?: string | null; amount: number; interval: 'month' | 'year'; planCode?: string;
      currency?: string; active?: boolean }): PriceFixture {
      const price: PriceFixture = { id: input.id ?? randomId('price'), object: 'price', active: input.active ?? true, product: input.product ?? 'arca',
        lookup_key: input.lookupKey ?? null, unit_amount: input.amount, currency: input.currency ?? 'usd', type: 'recurring', livemode, created: now(),
        recurring: { interval: input.interval, interval_count: 1, usage_type: 'licensed' }, metadata: input.planCode ? { plan_code: input.planCode } : {} };
      prices.set(price.id, price);
      return price;
    },
    /** What the customer does on Stripe's page: the session completes and its subscription exists, in the given status. */
    completeCheckout(sessionId: string, status: Stripe.Subscription.Status = 'active'): SubscriptionFixture {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No checkout session ${sessionId}`);
      const form = calls.find(call => call.method === 'POST' && call.path === '/v1/checkout/sessions'
        && (call.form.client_reference_id as string | undefined) === session.client_reference_id)?.form;
      const priceId = ((form?.line_items ?? {}) as Record<string, { price: string }>)['0']!.price;
      const subscriptionMetadata = ((form?.subscription_data ?? {}) as { metadata?: Record<string, string> }).metadata ?? {};
      const subscription = subscriptionObject(randomId('sub'), { customer: session.customer as string, price: priceOf(priceId)!,
        metadata: subscriptionMetadata, status });
      subscriptions.set(subscription.id, subscription);
      Object.assign(session, { status: 'complete', subscription: subscription.id, payment_status: status === 'active' ? 'paid' : 'unpaid' });
      return subscription;
    },
    /** A subscription Stripe holds, made outside a checkout (a second subscription, or one created by the dashboard). */
    addSubscription(input: { customer: string; price: PriceFixture; orgId?: string; status?: Stripe.Subscription.Status }): SubscriptionFixture {
      const subscription = subscriptionObject(randomId('sub'), { customer: input.customer, price: input.price,
        metadata: input.orgId ? { org_id: input.orgId } : {}, status: input.status });
      subscriptions.set(subscription.id, subscription);
      return subscription;
    },
    /** Moves a subscription at Stripe: a renewal, a failed payment, a cancellation. */
    setSubscription(id: string, patch: { status?: Stripe.Subscription.Status; cancel_at_period_end?: boolean; periodEnd?: number }) {
      const subscription = subscriptions.get(id)!;
      if (patch.status) subscription.status = patch.status;
      if (patch.cancel_at_period_end !== undefined) subscription.cancel_at_period_end = patch.cancel_at_period_end;
      if (patch.periodEnd !== undefined) {
        const item = subscription.items!.data![0]!;
        item.current_period_start = item.current_period_end;
        item.current_period_end = patch.periodEnd;
      }
      return subscription;
    },
    /**
     * An event as Stripe sends it, with a snapshot of the object at that moment (which may be stale by the time it arrives). It is
     * also listed by /v1/events, for the reconciliation.
     */
    event(type: string, object: unknown, input: { id?: string; created?: number; livemode?: boolean } = {}) {
      const event = { id: input.id ?? randomId('evt'), object: 'event' as const, api_version: Stripe.API_VERSION, created: input.created ?? now(),
        livemode: input.livemode ?? livemode, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type,
        data: { object: structuredClone(object) } } as DeepPartial<Stripe.Event> & { id: string; type: string; created: number };
      events.push(event);
      return event;
    },
    /** The body and Stripe-Signature header of a delivery of the event, signed now or at `timestamp` (seconds). */
    signed(event: unknown, input: { timestamp?: number; secret?: string } = {}) {
      const body = JSON.stringify(event, null, 2);
      return { body, signature: signer.webhooks.generateTestHeaderString({ payload: body, secret: input.secret ?? WEBHOOK_SECRET,
        timestamp: input.timestamp ?? now() }) };
    },
    /** An invoice of a subscription, shaped as the pinned version: the subscription under parent.subscription_details. */
    invoice(subscription: SubscriptionFixture, input: { paid?: boolean; amount?: number } = {}): DeepPartial<Stripe.Invoice> {
      const amount = input.amount ?? subscription.items?.data?.[0]?.price?.unit_amount ?? 0;
      return { id: randomId('in'), object: 'invoice', customer: subscription.customer, livemode, currency: 'usd', status: input.paid === false ? 'open' : 'paid',
        amount_due: amount, amount_paid: input.paid === false ? 0 : amount, billing_reason: 'subscription_cycle', created: now(),
        parent: { type: 'subscription_details', quote_details: null, subscription_details: { metadata: subscription.metadata, subscription: subscription.id } } };
    },
  };
}
export type FakeStripe = ReturnType<typeof fakeStripe>;
