import { SignJWT, jwtVerify } from 'jose';
const key = (secret: string) => new TextEncoder().encode(secret);
export async function issueSessionToken(scanId: string, email: string, secret: string) {
  return new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setSubject(scanId)
    .setIssuer('arca-api').setAudience('arca-scan').setIssuedAt().setExpirationTime('24h').sign(key(secret));
}
export async function verifySessionToken(token: string, secret: string): Promise<{ scanId: string; email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'], issuer: 'arca-api', audience: 'arca-scan' });
    return typeof payload.sub === 'string' && typeof payload.email === 'string' ? { scanId: payload.sub, email: payload.email } : null;
  } catch { return null; }
}
