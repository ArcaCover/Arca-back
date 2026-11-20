import { describe, expect, it } from 'vitest';
import { EmbeddedCheckoutResponse, OrgView, UrlResponse } from '@arca/contracts';
import { InMemoryAssessmentRepository } from '../../src/assessment/repository.js';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';
import { MockAppAuth } from '../../src/webapp/auth.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';
import { webappRoutes } from '../../src/webapp/routes.js';
import { WebappService } from '../../src/webapp/service.js';
import { StripeBillingProvider } from '../../src/webapp/stripe.js';
import { WEBHOOK_SECRET, fakeStripe } from '../fixtures/stripe.js';
import { fixtureResult } from '../fixtures/result.js';

// The pre-checkout of DN-13 §19 inside the process: POST /orgs with the firm profile, then Checkout embedded in ARCA's page, through
// the routes, the service and StripeBillingProvider over the fake Stripe. No network.
const secret = 'embedded-checkout-secret-'.repeat(2);
const APP = 'https://arcacover.com';
const RETURN = `${APP}/app/billing/return?session_id={CHECKOUT_SESSION_ID}`;
const T0 = Date.UTC(2026, 10, 21, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const PROFILE = {
  contactName: 'Ana Smith', contactRole: 'managing_partner', phone: '+1 (305) 555-0100', legalName: 'Smith & Co LLP', ein: '123456789',
  billingAddress: { line1: '100 Main St', city: 'Miami', state: 'FL', postalCode: '33101' }, attorneyRange: '6-20', practiceStates: ['FL', 'NY'],
};

async function scene(options: { simulated?: boolean } = {}) {
  let clock = T0;
  const now = () => clock;
  const stripe = fakeStripe({ now });
  stripe.addProduct();
  const monthly = stripe.addPrice({ lookupKey: 'arca_monthly', amount: 49_900, interval: 'month', planCode: 'monthly' });
  const annual = stripe.addPrice({ lookupKey: 'arca_annual', amount: 499_000, interval: 'year', planCode: 'annual' });
  const repository = new InMemoryWebappRepository(DEFAULT_PLANS.map(plan => ({ ...plan, stripe_product_id: 'arca',
    stripe_price_id: plan.code === 'monthly' ? monthly.id : annual.id })));
  const scans = new InMemoryRepository();
  const billing = options.simulated ? new MockBillingProvider(APP, now)
    : new StripeBillingProvider({ secretKey: 'rk_test_fixture', webhookSecret: WEBHOOK_SECRET, mode: 'test', appBaseUrl: APP },
      { fetch: stripe.fetch, now, maxNetworkRetries: 0 });
  const service = new WebappService({ repository, scans, assessments: new InMemoryAssessmentRepository(), billing, sessionSecret: secret,
    appBaseUrl: APP, now });
  const auth = new MockAppAuth(secret, now);
  const app = webappRoutes({ service, auth, now });
  let scanCount = 0;

  async function call(method: string, path: string, input: { token?: string; body?: unknown } = {}) {
    const response = await app.request(path, { method, body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers: { 'Content-Type': 'application/json', ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}) } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
  }
  /** Someone whose finished scan was claimed, signed in with its email, before the organization exists. */
  async function claimant(email = 'ana@smith.law') {
    const session = await auth.issue(email);
    const scanId = `sc_embedded${++scanCount}`;
    await scans.create({ id: `id_${scanId}`, scan_id: scanId, email, canonical_domain: 'smith.law',
      domain_resolution: { status: 'RESOLVED', canonicalDomain: 'smith.law', source: 'request', reason: null }, status: 'COMPLETED',
      result: fixtureResult(scanId, email), created_at: new Date(clock).toISOString(), completed_at: new Date(clock).toISOString(),
      duration_ms: 10, cached: false });
    const { claimId } = await service.issueClaim(await issueSessionToken(scanId, email, secret));
    return { token: session.token, user: session.user, claimId };
  }
  async function owner(input: { profile?: unknown; email?: string } = {}) {
    const person = await claimant(input.email);
    const created = await call('POST', '/orgs', { token: person.token, body: { name: 'Smith & Co LLP', claimId: person.claimId,
      ...(input.profile === undefined ? {} : { profile: input.profile }) } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { ...person, org: OrgView.parse(created.body) };
  }
  async function embedded(token: string, orgId: string, planCode = 'monthly') {
    const response = await call('POST', `/orgs/${orgId}/billing/checkout`, { token, body: { planCode, uiMode: 'embedded' } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return EmbeddedCheckoutResponse.parse(response.body);
  }
  const audit = async (orgId: string) => (await repository.listAudit(orgId, { limit: 200 })).reverse().map(row => row.action);
  const sessionCreates = () => stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions');
  return { stripe, repository, service, call, claimant, owner, embedded, audit, sessionCreates, advance: (ms: number) => { clock += ms; } };
}

describe('POST /orgs with the firm profile (DN-13 §19)', () => {
  it('keeps the profile beside the organization, normalized, and creates the organization as before', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    expect(o.org).toMatchObject({ name: 'Smith & Co LLP', role: 'owner', billingStatus: 'pending_payment', paidAccess: false });
    expect(await s.repository.getOrgProfile(o.org.id)).toEqual({ org_id: o.org.id, contact_name: 'Ana Smith', contact_role: 'managing_partner',
      contact_phone: '+1 (305) 555-0100', legal_name: 'Smith & Co LLP', ein: '12-3456789', address_line1: '100 Main St', address_city: 'Miami',
      address_state: 'FL', address_postal_code: '33101', address_country: 'US', attorney_range: '6-20', practice_states: ['FL', 'NY'],
      created_by: o.user.userId, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() });
    // Nothing of it lands in the audit row, which every owner and admin reads.
    const [created] = await s.repository.listAudit(o.org.id, { limit: 5 });
    expect(JSON.stringify(created!.data)).not.toMatch(/Ana|555|3456789|Main St/);
  });

  it('still takes the request without a profile, as every caller before the pre-checkout', async () => {
    const s = await scene();
    const o = await s.owner();
    expect(await s.repository.getOrgProfile(o.org.id)).toBeNull();
  });

  it('refuses a profile that breaks a rule with a 400, creating nothing and keeping the claim', async () => {
    const s = await scene();
    const person = await s.claimant();
    for (const profile of [{ ...PROFILE, ein: '12-34' }, { ...PROFILE, practiceStates: [] }, { ...PROFILE, billingAddress: { ...PROFILE.billingAddress, state: 'XX' } },
      { ...PROFILE, contactRole: 'associate' }, { ...PROFILE, phone: 'none' }, { ...PROFILE, extra: 1 }]) {
      const refused = await s.call('POST', '/orgs', { token: person.token, body: { name: 'Smith & Co LLP', claimId: person.claimId, profile } });
      expect(refused).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await s.repository.listOrganizations()).toEqual([]);
    // The claim was not spent: the same person creates the organization with a valid profile.
    const created = await s.call('POST', '/orgs', { token: person.token, body: { name: 'Smith & Co LLP', claimId: person.claimId, profile: PROFILE } });
    expect(created.status).toBe(201);
  });
});

describe('Checkout embedded in the pre-checkout (DN-13 §19)', () => {
  it('creates the customer from the profile, with the EIN as a us_ein tax id, then an embedded session that returns to /app/billing/return', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    const checkout = await s.embedded(o.token, o.org.id);
    expect(checkout.clientSecret).toMatch(/^cs_test_\w+_secret_\w+$/);
    const [customer] = [...s.stripe.customers.values()];
    expect(customer).toMatchObject({ name: 'Smith & Co LLP', email: 'ana@smith.law', phone: '+1 (305) 555-0100', metadata: { org_id: o.org.id },
      address: { line1: '100 Main St', city: 'Miami', state: 'FL', postal_code: '33101', country: 'US' } });
    expect(s.stripe.taxIds(customer!.id)).toEqual([{ type: 'us_ein', value: '12-3456789' }]);
    const [create] = s.sessionCreates();
    expect(create!.form).toMatchObject({ ui_mode: 'embedded_page', return_url: RETURN, customer: customer!.id, client_reference_id: o.org.id,
      adaptive_pricing: { enabled: 'false' }, managed_payments: { enabled: 'false' }, allowed_payment_method_types: { 0: 'card' },
      // The firm's address is on the customer: Checkout asks only what the card needs, and never offers Link or its bank option.
      billing_address_collection: 'auto', wallet_options: { link: { display: 'never' } } });
    expect(create!.form).not.toHaveProperty('success_url');
    expect(create!.form).not.toHaveProperty('cancel_url');
    expect(await s.repository.getCheckoutSession(checkout.sessionId)).toMatchObject({ ui_mode: 'embedded', url: null, status: 'open', plan_code: 'monthly' });
    expect(await s.audit(o.org.id)).toEqual(['org.created', 'billing.checkout_started']);
  });

  it('gives the same open session again, with its client secret, to a second click or a reload', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    const first = await s.embedded(o.token, o.org.id);
    s.advance(10 * MINUTE);
    expect(await s.embedded(o.token, o.org.id)).toEqual(first);
    const [a, b] = await Promise.all([s.embedded(o.token, o.org.id), s.embedded(o.token, o.org.id)]);
    expect([a, b]).toEqual([first, first]);
    expect(s.sessionCreates()).toHaveLength(1);
    expect(s.stripe.customers.size).toBe(1);
  });

  it('keeps one open session per organization across the two kinds: asking for the other expires the open one', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    const embedded = await s.embedded(o.token, o.org.id);
    const hosted = await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'monthly' } });
    expect(hosted.status).toBe(200);
    expect(UrlResponse.parse(hosted.body).url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(s.stripe.sessions.get(embedded.sessionId)!.status).toBe('expired');
    expect(await s.repository.getCheckoutSession(embedded.sessionId)).toMatchObject({ status: 'expired' });
    const again = await s.embedded(o.token, o.org.id, 'annual');
    expect(again.sessionId).not.toBe(embedded.sessionId);
    expect([...s.stripe.sessions.values()].filter(session => session.status === 'open')).toHaveLength(1);
  });

  it('resumes an abandoned payment from billing: a new session once the old one expired, on the same customer brought up to the profile', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    const first = await s.embedded(o.token, o.org.id);
    s.advance(HOUR + MINUTE);
    const resumed = await s.embedded(o.token, o.org.id);
    expect(resumed.sessionId).not.toBe(first.sessionId);
    expect(s.stripe.customers.size).toBe(1);
    const customerId = [...s.stripe.customers.keys()][0]!;
    expect(s.stripe.calls.some(c => c.method === 'POST' && c.path === `/v1/customers/${customerId}`)).toBe(true);
    expect(s.stripe.taxIds(customerId)).toEqual([{ type: 'us_ein', value: '12-3456789' }]);
    expect(await s.audit(o.org.id)).toEqual(['org.created', 'billing.checkout_started', 'billing.checkout_started']);
  });

  it('applies the payment of an embedded session when the return page syncs it', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    const { sessionId } = await s.embedded(o.token, o.org.id);
    s.stripe.completeCheckout(sessionId);
    const synced = await s.call('POST', `/orgs/${o.org.id}/billing/sync`, { token: o.token, body: { sessionId } });
    expect(synced).toMatchObject({ status: 200, body: { billingStatus: 'active', paidAccess: true } });
    expect(await s.repository.getCheckoutSession(sessionId)).toMatchObject({ status: 'complete' });
    // Paid: a second checkout of either kind is the portal's job.
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'monthly', uiMode: 'embedded' } }))
      .toMatchObject({ status: 409 });
  });

  it('works for an organization made without a profile: the customer of before, named after it', async () => {
    const s = await scene();
    const o = await s.owner();
    await s.embedded(o.token, o.org.id);
    const [customer] = [...s.stripe.customers.values()];
    expect(customer).toMatchObject({ name: 'Smith & Co LLP', email: 'ana@smith.law', phone: null, address: null });
    expect(s.stripe.taxIds(customer!.id)).toEqual([]);
    // No address on the customer: Checkout asks for it.
    expect(s.sessionCreates()[0]!.form).toMatchObject({ billing_address_collection: 'required' });
  });

  it('asks for billing.manage like the hosted checkout, and refuses an unknown kind of Checkout', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'monthly', uiMode: 'embedded_page' } }))
      .toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { body: { planCode: 'monthly', uiMode: 'embedded' } }))
      .toMatchObject({ status: 401 });
    const stranger = await s.claimant('someone@else.law');
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: stranger.token, body: { planCode: 'monthly', uiMode: 'embedded' } }))
      .toMatchObject({ status: 404 });
    expect(s.sessionCreates()).toHaveLength(0);
  });

  it('answers 502 when Stripe is down, with nothing stored', async () => {
    const s = await scene();
    const o = await s.owner({ profile: PROFILE });
    s.stripe.failNext(c => c.path === '/v1/checkout/sessions');
    expect(await s.call('POST', `/orgs/${o.org.id}/billing/checkout`, { token: o.token, body: { planCode: 'monthly', uiMode: 'embedded' } }))
      .toMatchObject({ status: 502, body: { error: 'billing_unavailable' } });
    expect(await s.repository.getOpenCheckoutSession(o.org.id, new Date(T0).toISOString())).toBeNull();
  });

  it('runs the same rules with the simulated provider of the debug modes', async () => {
    const s = await scene({ simulated: true });
    const o = await s.owner({ profile: PROFILE });
    const first = await s.embedded(o.token, o.org.id);
    expect(first.clientSecret).toMatch(/_secret_mock$/);
    expect(await s.embedded(o.token, o.org.id)).toEqual(first);
  });
});
