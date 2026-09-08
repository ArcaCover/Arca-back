import { describe, it, expect } from 'vitest';
import { decodeJwt, SignJWT } from 'jose';
import { issueSessionToken, verifySessionToken } from '../../src/auth/session-token.js';
import { ScanLimiter } from '../../src/http/rate-limit.js';
import { ScanRequest } from '../../src/http/schemas.js';
import { assertPublicUrl } from '../../src/pipeline/network.js';
import { normalizeDomain } from '../../src/pipeline/domain-resolution.js';
const secret = 's'.repeat(40);
describe('scan boundaries', () => {
  it('issues scoped 24-hour sessions', async () => {
    const token = await issueSessionToken('sc_123', 'user@firm.com', secret);
    const payload = decodeJwt(token);
    expect(payload.sub).toBe('sc_123');
    expect(payload.email).toBe('user@firm.com');
    expect(payload.exp! - payload.iat!).toBe(86400);
    expect(await verifySessionToken(token, 'x'.repeat(40))).toBeNull();
  });
  it('rejects expired tokens', async () => {
    const token = await new SignJWT({ email: 'user@firm.com' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject('sc_123').setIssuer('arca-api').setAudience('arca-scan').setExpirationTime(1).sign(new TextEncoder().encode(secret));
    expect(await verifySessionToken(token, secret)).toBeNull();
  });
  it('enforces independent IP and email limits and allows requests after expiry', () => {
    let now = 0; const limiter = new ScanLimiter(() => now);
    for (let i = 0; i < 3; i++) expect(limiter.check(`ip${i}`, 'one@firm.com').allowed).toBe(true);
    expect(limiter.check('other', 'one@firm.com')).toEqual({ allowed: false, retryAfter: 3600 });
    for (let i = 0; i < 10; i++) expect(limiter.check('shared', `user${i}@firm.com`).allowed).toBe(true);
    expect(limiter.check('shared', 'new@firm.com').allowed).toBe(false);
    now = 3600000;
    expect(limiter.check('shared', 'one@firm.com').allowed).toBe(true);
  });
  it('normalizes domains and validates email', () => {
    expect(normalizeDomain('HTTPS://WWW.Firm.com/about')).toBe('firm.com');
    expect(ScanRequest.parse({ email: 'Test@Firm.com' })).toEqual({ email: 'test@firm.com' });
    expect(normalizeDomain('localhost')).toBe('');
    expect(ScanRequest.safeParse({ domain: 'firm.com' }).success).toBe(false);
    expect(normalizeDomain('https://user:pass@firm.com')).toBe('');
  });
  it.each(['http://127.0.0.1', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd'])('rejects non-public target %s before navigation', async url => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });
});
