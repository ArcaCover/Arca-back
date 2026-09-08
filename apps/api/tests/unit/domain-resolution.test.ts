import { describe, expect, it, vi } from 'vitest';
import { PublicDomainResolver } from '../../src/pipeline/domain-resolution.js';
import { createApp } from '../../src/http/app.js';
import { InMemoryRepository } from '../../src/repositories/in-memory.js';

describe('Request → DomainResolution → Assessment', () => {
  it('prefers the explicit identity regardless of requester email', async () => {
    const check = vi.fn(async () => {}), resolver = new PublicDomainResolver(check);
    const resolved = await resolver.resolve({ domain: 'https://www.firm.com/team', email: 'user@gmail.com' });
    expect(resolved).toEqual({ status: 'RESOLVED', canonicalDomain: 'firm.com', source: 'request', reason: null });
    expect(check).toHaveBeenCalledWith('https://firm.com');
  });
  it('uses a corporate email only to resolve the missing domain', async () => {
    const resolver = new PublicDomainResolver(async () => {});
    expect(await resolver.resolve({ email: 'user@firm.com' })).toMatchObject({ canonicalDomain: 'firm.com', source: 'email' });
  });
  it('does not consult a personal email provider as a firm', async () => {
    const check = vi.fn(), resolver = new PublicDomainResolver(check);
    expect(await resolver.resolve({ email: 'user@gmail.com' })).toMatchObject({ canonicalDomain: null, reason: 'PERSONAL_EMAIL' });
    expect(check).not.toHaveBeenCalled();
  });
  it('does not fall back to another identity after an explicitly invalid domain', async () => {
    const resolver = new PublicDomainResolver(async () => {});
    expect(await resolver.resolve({ domain: 'bad domain', email: 'user@firm.com' })).toMatchObject({ canonicalDomain: null, reason: 'INVALID_DOMAIN' });
  });
  it('preserves uncertainty on network failure', async () => {
    const resolver = new PublicDomainResolver(async () => { throw new Error('SERVFAIL'); });
    expect(await resolver.resolve({ email: 'user@firm.com' })).toMatchObject({ canonicalDomain: null, reason: 'DOMAIN_UNAVAILABLE' });
  });
  it('never creates a scan or calls scoring without a canonical domain', async () => {
    const run = vi.fn(), repository = new InMemoryRepository();
    const { app } = createApp({ repository, pipeline: { run }, domainResolver: new PublicDomainResolver(async () => {}),
      sessionSecret: 's'.repeat(40), corsOrigins: [], clientIp: () => '127.0.0.1' });
    const response = await app.request('/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@gmail.com' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'UNRESOLVED', domainResolution: { status: 'UNRESOLVED', source: 'email', canonicalDomain: null, reason: 'PERSONAL_EMAIL' }, assessment: null });
    expect(run).not.toHaveBeenCalled();
    expect(repository.scans.size).toBe(0);
  });
});
