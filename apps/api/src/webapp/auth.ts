import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export type AppUser = { userId: string; email: string };

/** Who calls the webapp. Supabase Auth verifies in production (DN-10 §4.1); the mock issuer exists only in mock. */
export interface AppAuth {
  verify(token: string): Promise<AppUser | null>;
}

// Same claim shape as a Supabase access token, under an issuer of its own: the scan session token shares the secret
// in mock, and its issuer and audience are what keep the two apart.
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
    this.key = new TextEncoder().encode(secret);
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
