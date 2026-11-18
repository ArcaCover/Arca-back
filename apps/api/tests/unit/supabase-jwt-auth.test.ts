import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, UnsecuredJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { AuthUnavailable, MockAppAuth, SupabaseJwtAuth } from '../../src/webapp/auth.js';

// DN-13 §4.4: Supabase access tokens, verified locally against the project's JWKS, asymmetric algorithms only. No test here
// reaches the network: the key set is served by an injected fetcher.
const PROJECT = 'https://ref.supabase.co';
const ISSUER = `${PROJECT}/auth/v1`;
const JWKS_URL = `${PROJECT}/auth/v1/.well-known/jwks.json`;
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const SECOND = 1000;
const USER_ID = '7b5e2f0e-3c1a-4d8e-9f00-1a2b3c4d5e6f';

type Signer = { kid: string; alg: 'ES256' | 'RS256'; privateKey: KeyLike; jwk: JWK };
async function signer(kid: string, alg: 'ES256' | 'RS256'): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  return { kid, alg, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

type Claims = Record<string, unknown> & { iss?: string; aud?: string; sub?: string; exp?: number; iat?: number };
/** A token as Supabase Auth issues one; each test changes exactly the part the verifier must insist on. */
async function token(key: Signer, overrides: Claims = {}, header: { kid?: string | null } = {}) {
  const iat = Math.floor(T0 / 1000);
  const { iss = ISSUER, aud = 'authenticated', sub = USER_ID, exp = iat + 3600, ...rest } = overrides;
  const claims = { email: 'Owner@Firm.com', role: 'authenticated', aal: 'aal1', session_id: 'f0e1d2c3-0000-4000-8000-000000000001',
    is_anonymous: false, ...rest };
  for (const [name, value] of Object.entries(claims)) if (value === undefined) delete (claims as Record<string, unknown>)[name];
  const kid = header.kid === undefined ? key.kid : header.kid;
  return new SignJWT(claims).setProtectedHeader({ alg: key.alg, typ: 'JWT', ...(kid === null ? {} : { kid }) })
    .setIssuer(iss).setAudience(aud).setSubject(sub).setIssuedAt(iat).setExpirationTime(exp).sign(key.privateKey);
}

/** The project's key set as the test says it is now, and every time the verifier asked for it. */
function project(...keys: Signer[]) {
  const state = { keys: keys.map(key => key.jwk) as unknown[], fail: false };
  const fetchJwks = vi.fn(async (url: URL) => {
    if (state.fail) throw new Error('connect ECONNREFUSED');
    expect(url.href).toBe(JWKS_URL);
    return { keys: state.keys };
  });
  return { state, fetchJwks };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('SupabaseJwtAuth', () => {
  it('verifies an ES256 and an RS256 access token, and maps the subject to the webapp user', async () => {
    const ec = await signer('ec-1', 'ES256'), rsa = await signer('rsa-1', 'RS256');
    const { fetchJwks } = project(ec, rsa);
    const auth = new SupabaseJwtAuth(`${PROJECT}/`, { fetchJwks, now: () => T0 });
    const user = { userId: USER_ID, email: 'owner@firm.com', aal: 'aal1', sessionId: 'f0e1d2c3-0000-4000-8000-000000000001' };
    expect(await auth.verify(await token(ec))).toEqual(user);
    expect(await auth.verify(await token(rsa))).toEqual(user);
    // The key set is read once and kept: verifying is local.
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    // A subject in capitals is the same user.
    expect((await auth.verify(await token(ec, { sub: USER_ID.toUpperCase() })))?.userId).toBe(USER_ID);
  });

  it('refuses an expired token, a token from another project and one for another audience', async () => {
    const ec = await signer('ec-1', 'ES256');
    let clock = T0;
    const auth = new SupabaseJwtAuth(PROJECT, { ...project(ec), now: () => clock });
    const valid = await token(ec);
    clock = T0 + 3600 * SECOND - SECOND;
    expect(await auth.verify(valid)).not.toBeNull();
    clock = T0 + 3600 * SECOND;
    expect(await auth.verify(valid)).toBeNull();
    clock = T0;
    expect(await auth.verify(await token(ec, { iss: 'https://other.supabase.co/auth/v1' }))).toBeNull();
    expect(await auth.verify(await token(ec, { iss: PROJECT }))).toBeNull();
    expect(await auth.verify(await token(ec, { aud: 'anon' }))).toBeNull();
    // A token with no expiry is refused, however right the rest is.
    const forever = await new SignJWT({ email: 'owner@firm.com', role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'ec-1' })
      .setIssuer(ISSUER).setAudience('authenticated').setSubject(USER_ID).setIssuedAt(T0 / 1000).sign(ec.privateKey);
    expect(await auth.verify(forever)).toBeNull();
  });

  it('refuses HS256 and unsigned tokens without ever asking for the key set', async () => {
    const ec = await signer('ec-1', 'ES256');
    const { fetchJwks } = project(ec);
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => T0 });
    const claims = { email: 'owner@firm.com', role: 'authenticated' };
    const hs256 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'ec-1' }).setIssuer(ISSUER).setAudience('authenticated')
      .setSubject(USER_ID).setIssuedAt(T0 / 1000).setExpirationTime(T0 / 1000 + 3600).sign(new TextEncoder().encode('legacy-jwt-secret-'.repeat(3)));
    expect(await auth.verify(hs256)).toBeNull();
    expect(await auth.verify(new UnsecuredJWT(claims).setIssuer(ISSUER).setAudience('authenticated').setSubject(USER_ID)
      .setExpirationTime(T0 / 1000 + 3600).encode())).toBeNull();
    // A token of the simulated issuer never verifies where Supabase's do (one process, one issuer).
    expect(await auth.verify((await new MockAppAuth('s'.repeat(40), () => T0).issue('owner@firm.com')).token)).toBeNull();
    expect(await auth.verify('not-a-token')).toBeNull();
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it('refuses tokens that are not a signed-in, non-anonymous user with an email and a UUID subject', async () => {
    const ec = await signer('ec-1', 'ES256');
    const auth = new SupabaseJwtAuth(PROJECT, { ...project(ec), now: () => T0 });
    expect(await auth.verify(await token(ec, { role: 'anon' }))).toBeNull();
    expect(await auth.verify(await token(ec, { role: 'service_role' }))).toBeNull();
    expect(await auth.verify(await token(ec, { is_anonymous: true }))).toBeNull();
    expect(await auth.verify(await token(ec, { email: undefined }))).toBeNull();
    expect(await auth.verify(await token(ec, { email: '' }))).toBeNull();
    expect(await auth.verify(await token(ec, { email: 'not-an-email' }))).toBeNull();
    expect(await auth.verify(await token(ec, { sub: 'user-1' }))).toBeNull();
    // Claims that a token may carry say nothing about permissions: the role in the database decides (DN-13 §4.4).
    expect(await auth.verify(await token(ec, { app_metadata: { role: 'owner' }, user_role: 'admin' })))
      .toEqual({ userId: USER_ID, email: 'owner@firm.com', aal: 'aal1', sessionId: expect.any(String) });
  });

  it('takes only asymmetric signing keys from the key set', async () => {
    const ec = await signer('ec-1', 'ES256');
    const { state, fetchJwks } = project(ec);
    state.keys.push({ kty: 'oct', kid: 'legacy', k: 'c2VjcmV0', alg: 'HS256' }, 'not-a-key', null);
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => T0 });
    expect(await auth.verify(await token(ec))).not.toBeNull();
    // A key the set publishes for encryption is not a signing key.
    const enc = await signer('enc-1', 'ES256');
    state.keys = [{ ...enc.jwk, use: 'enc' }];
    const fresh = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => T0 });
    expect(await fresh.verify(await token(enc))).toBeNull();
  });

  it('fetches the key set again for an unknown kid, so a rotated key verifies, at most once per cooldown', async () => {
    const current = await signer('key-a', 'ES256'), next = await signer('key-b', 'ES256'), stranger = await signer('key-x', 'ES256');
    const { state, fetchJwks } = project(current);
    let clock = T0;
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => clock });
    expect(await auth.verify(await token(current))).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    // Supabase rotates: the standby key becomes the signing key and the old one stays published for a while.
    state.keys = [current.jwk, next.jwk];
    clock = T0 + 31 * SECOND;
    expect(await auth.verify(await token(next))).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    expect(await auth.verify(await token(current))).not.toBeNull();

    // Made-up kids cannot make the API hammer Supabase: one refetch per cooldown, then they are simply refused.
    clock += 31 * SECOND;
    expect(await auth.verify(await token(stranger))).toBeNull();
    expect(await auth.verify(await token(stranger))).toBeNull();
    expect(await auth.verify(await token(stranger, {}, { kid: 'key-y' }))).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(3);
  });

  it('reads the key set again once its cache ages out, so a revoked key stops verifying', async () => {
    const old = await signer('key-a', 'ES256'), current = await signer('key-b', 'ES256');
    const { state, fetchJwks } = project(old, current);
    let clock = T0;
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => clock });
    const signedWithOld = await token(old, { exp: Math.floor(T0 / 1000) + 3600 });
    expect(await auth.verify(signedWithOld)).not.toBeNull();
    state.keys = [current.jwk];
    clock = T0 + 5 * 60 * SECOND;
    expect(await auth.verify(signedWithOld)).not.toBeNull();
    clock = T0 + 10 * 60 * SECOND;
    expect(await auth.verify(signedWithOld)).toBeNull();
    expect(await auth.verify(await token(current, { exp: Math.floor(T0 / 1000) + 3600 }))).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it('keeps verifying with the keys it has while Supabase is unreachable, and is unavailable when it has none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ec = await signer('ec-1', 'ES256');
    const { state, fetchJwks } = project(ec);
    let clock = T0;
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => clock });
    expect(await auth.verify(await token(ec))).not.toBeNull();
    state.fail = true;
    clock = T0 + 11 * 60 * SECOND;
    expect(await auth.verify(await token(ec, { exp: Math.floor(clock / 1000) + 600 }))).not.toBeNull();

    const cold = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => clock });
    await expect(cold.verify(await token(ec, { exp: Math.floor(clock / 1000) + 600 }))).rejects.toBeInstanceOf(AuthUnavailable);
    // Once Supabase answers again, the same verifier recovers.
    state.fail = false;
    expect(await cold.verify(await token(ec, { exp: Math.floor(clock / 1000) + 600 }))).not.toBeNull();
    // Nothing about the token or the user is logged.
    for (const [line] of vi.mocked(console.error).mock.calls) expect(String(line)).not.toContain('owner@firm.com');
  });

  it('checks at start that the project publishes an asymmetric signing key, without blocking when Supabase is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ec = await signer('ec-1', 'ES256');
    const { state, fetchJwks } = project(ec);
    const auth = new SupabaseJwtAuth(PROJECT, { fetchJwks, now: () => T0 });
    expect(await auth.checkSigningKeys()).toBe('ready');
    // The keys read at start serve the first request.
    expect(await auth.verify(await token(ec))).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(1);

    // A project still on the legacy HS256 secret publishes an empty set: nothing could ever verify, so the start is refused.
    state.keys = [];
    await expect(new SupabaseJwtAuth(PROJECT, { fetchJwks }).checkSigningKeys()).rejects.toThrow(/asymmetric signing key/);
    state.keys = [{ kty: 'oct', kid: 'legacy', k: 'c2VjcmV0' }];
    await expect(new SupabaseJwtAuth(PROJECT, { fetchJwks }).checkSigningKeys()).rejects.toThrow(/asymmetric signing key/);
    state.fail = true;
    expect(await new SupabaseJwtAuth(PROJECT, { fetchJwks }).checkSigningKeys()).toBe('unreachable');
  });

  it('derives the issuer and the key set from SUPABASE_URL alone', () => {
    expect(new SupabaseJwtAuth('https://ref.supabase.co/').issuer).toBe(ISSUER);
    expect(new SupabaseJwtAuth('http://127.0.0.1:54321').issuer).toBe('http://127.0.0.1:54321/auth/v1');
    expect(new SupabaseJwtAuth('http://127.0.0.1:54321').jwksUrl.href).toBe('http://127.0.0.1:54321/auth/v1/.well-known/jwks.json');
  });
});
