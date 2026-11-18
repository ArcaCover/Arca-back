import { createHash, createHmac } from 'node:crypto';
import { SignJWT, createLocalJWKSet, errors, jwtVerify, type JWK, type JWTHeaderParameters } from 'jose';

/**
 * Who calls the webapp: the subject of the token and its email, nothing that grants anything. What the user may do is read from
 * the repository on every request (DN-13 §4.4). `aal` and `sessionId` come only from Supabase, for MFA later (phase 6).
 */
export type AppUser = { userId: string; email: string; aal?: string; sessionId?: string };

/**
 * Who calls the webapp. `null` for any token that is not one of this verifier's issuer. It throws `AuthUnavailable` only when it
 * cannot tell, because it has no key to check against. One process builds one verifier, never both (DN-13 §4.4).
 */
export interface AppAuth {
  verify(token: string): Promise<AppUser | null>;
}

/** The verifier holds no key to check a token against: the routes answer 503, so the front does not sign the user out over it. */
export class AuthUnavailable extends Error {
  constructor() {
    super('Sign-in cannot be checked right now');
    this.name = 'AuthUnavailable';
  }
}

// Same claim shape as a Supabase access token, under an issuer and audience of its own, and signed with a key derived
// from the scan session secret rather than the secret itself: a token of one kind never verifies as the other.
const ISSUER = 'arca-mock-auth';
const AUDIENCE = 'authenticated';
const TTL_SECONDS = 12 * 60 * 60;

/** Name-based (RFC 9562 version 8): logging in again with the same email, in any case, is the same user. */
function userIdFor(email: string): string {
  const hex = createHash('sha256').update(email).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class MockAppAuth implements AppAuth {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly now: () => number = Date.now) {
    // Derived, not random: stable across restarts, so the front's stored token keeps verifying while the memory lives.
    this.key = createHmac('sha256', secret).update('arca-mock-auth').digest();
  }

  async issue(email: string): Promise<{ token: string; user: AppUser; expiresAt: string }> {
    const normalized = email.trim().toLowerCase();
    const user = { userId: userIdFor(normalized), email: normalized };
    const issuedAt = Math.floor(this.now() / 1000);
    const expiresAt = issuedAt + TTL_SECONDS;
    const token = await new SignJWT({ email: user.email }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.userId)
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(this.key);
    return { token, user, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  async verify(token: string): Promise<AppUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE,
        requiredClaims: ['exp'], currentDate: new Date(this.now()) });
      return typeof payload.sub === 'string' && typeof payload.email === 'string' ? { userId: payload.sub, email: payload.email } : null;
    } catch { return null; }
  }
}

/** Reads the project's JWKS. The tests inject one; the default reads it over HTTP. */
export type JwksFetcher = (url: URL) => Promise<unknown>;

const fetchJwksOverHttp: JwksFetcher = async url => {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`the key set answered ${response.status}`);
  return response.json();
};

// Asymmetric only (DN-13 R3): a project still on the shared HS256 secret publishes no key here, and there is no secret path.
const SIGNING_ALGORITHMS = ['ES256', 'RS256'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 30 * 1000;
const reason = (error: unknown) => error instanceof Error ? error.message : 'unknown error';

/** The signing keys of a fetched set: EC P-256 or RSA, with a kid, for signatures, under an allowed algorithm. The rest is dropped. */
function signingKeys(body: unknown): JWK[] {
  const keys = body !== null && typeof body === 'object' ? (body as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new Error('the response is not a JSON Web Key Set');
  return keys.filter((key): key is JWK => key !== null && typeof key === 'object' && !Array.isArray(key)
    && ((key.kty === 'EC' && key.crv === 'P-256') || key.kty === 'RSA') && typeof key.kid === 'string'
    && (key.alg === undefined || SIGNING_ALGORITHMS.includes(key.alg)) && (key.use === undefined || key.use === 'sig'));
}

/**
 * Supabase Auth access tokens (DN-13 §4.4), verified locally against the project's JWKS, derived from SUPABASE_URL alone. The set
 * is kept for ten minutes. An unknown `kid` reads it again, so a rotated key verifies, but at most once every 30 s, so made-up kids
 * cannot make the API hammer Supabase. While Supabase is unreachable, the last keys read keep serving.
 */
export class SupabaseJwtAuth implements AppAuth {
  readonly issuer: string;
  readonly jwksUrl: URL;
  private readonly fetchJwks: JwksFetcher;
  private readonly now: () => number;
  private keys: { set: ReturnType<typeof createLocalJWKSet>; fetchedAt: number } | null = null;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;

  constructor(supabaseUrl: string, options: { fetchJwks?: JwksFetcher; now?: () => number } = {}) {
    const base = new URL(supabaseUrl);
    this.issuer = `${base.origin}${base.pathname.replace(/\/+$/, '')}/auth/v1`;
    this.jwksUrl = new URL(`${this.issuer}/.well-known/jwks.json`);
    this.fetchJwks = options.fetchJwks ?? fetchJwksOverHttp;
    this.now = options.now ?? Date.now;
  }

  /**
   * At start: refuses a project that publishes no asymmetric signing key, since no token could ever verify. An unreachable
   * Supabase does not block the start: the first request reads the set again.
   */
  async checkSigningKeys(): Promise<'ready' | 'unreachable'> {
    let body: unknown;
    try { body = await this.fetchJwks(this.jwksUrl); } catch (error) {
      console.warn(`[auth] the Supabase key set is unreachable at start (${reason(error)}); the first request reads it again`);
      return 'unreachable';
    }
    const keys = signingKeys(body);
    if (keys.length === 0) {
      throw new Error(`The Supabase project publishes no asymmetric signing key (ES256 or RS256) at ${this.jwksUrl.href}: `
        + 'switch it to JWT signing keys (DN-13 §4.4)');
    }
    this.store(keys);
    return 'ready';
  }

  async verify(token: string): Promise<AppUser | null> {
    let payload: Record<string, unknown>;
    try {
      // jose checks the algorithm before it asks for a key: an HS256 or unsigned token never reaches the key set.
      ({ payload } = await jwtVerify(token, header => this.key(header), { issuer: this.issuer, audience: 'authenticated',
        algorithms: SIGNING_ALGORITHMS, requiredClaims: ['exp', 'sub', 'email'], currentDate: new Date(this.now()) }));
    } catch (error) {
      if (error instanceof AuthUnavailable) throw error;
      return null;
    }
    const { sub, email, role, is_anonymous: anonymous, aal, session_id: sessionId } = payload;
    if (role !== 'authenticated' || anonymous === true || typeof sub !== 'string' || !UUID.test(sub)) return null;
    if (typeof email !== 'string' || email.length > 320 || !EMAIL.test(email.trim())) return null;
    return { userId: sub.toLowerCase(), email: email.trim().toLowerCase(), ...(typeof aal === 'string' ? { aal } : {}),
      ...(typeof sessionId === 'string' ? { sessionId } : {}) };
  }

  private async key(header: JWTHeaderParameters) {
    const stale = !this.keys || this.now() - this.keys.fetchedAt >= CACHE_MAX_AGE_MS;
    if (stale && (!this.keys || this.now() - this.attemptedAt >= COOLDOWN_MS)) await this.refresh();
    try { return await this.keys!.set(header); } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || this.now() - this.attemptedAt < COOLDOWN_MS) throw error;
      await this.refresh();
      return this.keys!.set(header);
    }
  }

  /** One read at a time. Without any key it throws `AuthUnavailable`; with older ones it keeps them. */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      this.attemptedAt = this.now();
      try {
        const keys = signingKeys(await this.fetchJwks(this.jwksUrl));
        if (keys.length === 0) console.error('[auth] the Supabase key set has no asymmetric signing key: no token can verify');
        this.store(keys);
      } catch (error) {
        console.error(`[auth] reading the Supabase key set failed (${reason(error)})`);
        if (!this.keys) throw new AuthUnavailable();
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private store(keys: JWK[]) {
    this.keys = { set: createLocalJWKSet({ keys }), fetchedAt: this.now() };
    this.attemptedAt = this.keys.fetchedAt;
  }
}
