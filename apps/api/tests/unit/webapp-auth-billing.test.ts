import { describe, expect, it } from 'vitest';
import { SignJWT, UnsecuredJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { issueSessionToken } from '../../src/auth/session-token.js';
import { MockAppAuth } from '../../src/webapp/auth.js';
import { MockBillingProvider } from '../../src/webapp/billing.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';

const secret = 'webapp-auth-test-secret-'.repeat(2);
const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const APP = 'http://localhost:3000';
const [monthly, annual] = DEFAULT_PLANS as [typeof DEFAULT_PLANS[number], typeof DEFAULT_PLANS[number]];

// Signs a token by hand, so each test changes exactly one of the things the verifier must insist on.
async function forge(claims: { iss?: string; aud?: string; alg?: string; key?: string; exp?: boolean } = {}) {
  const jwt = new SignJWT({ email: 'a@x.co' }).setProtectedHeader({ alg: claims.alg ?? 'HS256' })
    .setSubject('00000000-0000-8000-8000-000000000000').setIssuer(claims.iss ?? 'arca-mock-auth')
    .setAudience(claims.aud ?? 'authenticated').setIssuedAt();
  if (claims.exp !== false) jwt.setExpirationTime('1h');
  return jwt.sign(new TextEncoder().encode(claims.key ?? secret));
}

describe('mock app auth', () => {
  it('a mock token round-trips and is stable per email', async () => {
    const auth = new MockAppAuth(secret, () => T0);
    const upper = await auth.issue('A@x.co');
    const lower = await auth.issue('a@x.co');
    expect(upper.user).toEqual({ userId: lower.user.userId, email: 'a@x.co' });
    expect(upper.user.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await auth.issue('b@x.co')).user.userId).not.toBe(upper.user.userId);
    expect(upper.expiresAt).toBe('2026-10-26T00:00:00.000Z');
    expect(await auth.verify(upper.token)).toEqual(upper.user);
    expect(await auth.verify(lower.token)).toEqual(upper.user);

    expect(decodeProtectedHeader(upper.token).alg).toBe('HS256');
    const claims = decodeJwt(upper.token);
    expect(claims).toMatchObject({ iss: 'arca-mock-auth', aud: 'authenticated', sub: upper.user.userId, email: 'a@x.co' });
    expect(claims.exp! - claims.iat!).toBe(12 * 60 * 60);

    // A fresh verifier with the same secret accepts it: nothing lives in the issuing object.
    expect(await new MockAppAuth(secret, () => T0).verify(upper.token)).toEqual(upper.user);
  });

  it('a token with another issuer, audience or algorithm is rejected', async () => {
    const auth = new MockAppAuth(secret);
    expect(await auth.verify(await forge())).toEqual({ userId: '00000000-0000-8000-8000-000000000000', email: 'a@x.co' });

    expect(await auth.verify(await issueSessionToken('sc_1', 'a@x.co', secret))).toBeNull();
    expect(await auth.verify(await forge({ iss: 'arca-api' }))).toBeNull();
    expect(await auth.verify(await forge({ aud: 'arca-scan' }))).toBeNull();
    expect(await auth.verify(await forge({ alg: 'HS512' }))).toBeNull();
    expect(await auth.verify(await forge({ key: 'another-secret-'.repeat(3) }))).toBeNull();
    expect(await auth.verify(await forge({ exp: false }))).toBeNull();
    expect(await auth.verify(new UnsecuredJWT({ email: 'a@x.co' }).setSubject('u').setIssuer('arca-mock-auth')
      .setAudience('authenticated').setExpirationTime('1h').encode())).toBeNull();
    expect(await auth.verify('not-a-token')).toBeNull();
  });

  it('an expired token is rejected', async () => {
    let clock = T0;
    const auth = new MockAppAuth(secret, () => clock);
    const { token, user } = await auth.issue('a@x.co');
    clock = T0 + 12 * HOUR - 1000;
    expect(await auth.verify(token)).toEqual(user);
    clock = T0 + 12 * HOUR;
    expect(await auth.verify(token)).toBeNull();
  });
});

describe('mock billing', () => {
  const urls = { successUrl: `${APP}/app?paid=1`, cancelUrl: `${APP}/app/billing` };

  it('a checkout is paid once', async () => {
    const billing = new MockBillingProvider(APP, () => T0);
    const first = await billing.createCheckout({ orgId: 'org_1', plan: monthly, ...urls });
    const second = await billing.createCheckout({ orgId: 'org_2', plan: annual, ...urls });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.url).toBe(`${APP}/app/billing/mock-checkout?session=${first.sessionId}`);

    const paid = billing.pay(first.sessionId);
    expect(paid).toEqual({ id: expect.any(String), type: 'checkout.completed', orgId: 'org_1', status: 'active', planCode: 'monthly',
      customerId: expect.any(String), subscriptionId: expect.any(String), currentPeriodEnd: '2026-11-25T12:00:00.000Z' });
    expect(billing.pay(first.sessionId)).toBeNull();
    expect(billing.pay('cs_unknown')).toBeNull();

    const yearly = billing.pay(second.sessionId);
    expect(yearly).toMatchObject({ orgId: 'org_2', planCode: 'annual', currentPeriodEnd: '2027-10-25T12:00:00.000Z' });
    expect(yearly!.id).not.toBe(paid!.id);
  });

  it('the portal returns to billing and a cancellation is recorded', async () => {
    const billing = new MockBillingProvider(`${APP}/`);
    expect(await billing.createPortal({ orgId: 'org_1', returnUrl: `${APP}/app/billing` })).toEqual({ url: `${APP}/app/billing` });
    expect(billing.canceled).toEqual([]);
    await billing.cancel('org_1');
    expect(billing.canceled).toEqual(['org_1']);
  });
});
