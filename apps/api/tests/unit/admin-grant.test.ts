import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdminGrantError, adminGrant, parseAdminGrantArgs } from '../../src/webapp/admin-grant.js';
import { InMemoryWebappRepository } from '../../src/webapp/in-memory.js';
import { DEFAULT_PLANS } from '../../src/webapp/plans.js';

// `npm run admin:grant -- <email> [--revoke] [--dry-run]` (DN-10 §4.6, DN-13 §4.5), on the in-memory store.
const NOW = Date.parse('2026-11-18T12:00:00.000Z');

async function setup() {
  const repository = new InMemoryWebappRepository(DEFAULT_PLANS);
  const userId = randomUUID();
  await repository.upsertProfile({ user_id: userId, email: 'ops@arca.example', full_name: null, last_org_id: null, created_at: new Date(NOW).toISOString() });
  return { repository, userId, now: () => NOW };
}
const auditRows = async (repository: InMemoryWebappRepository) => (await repository.listAllAudit({ limit: 50 })).reverse()
  .map(({ action, actor_kind, actor_user_id, org_id, target, data, created_at }) => ({ action, actor_kind, actor_user_id, org_id, target, data, created_at }));

describe('admin:grant', () => {
  it('grants the platform role by email, in any case, auditing it as ARCA with no user', async () => {
    const { repository, userId, now } = await setup();
    expect(await adminGrant(repository, { email: '  Ops@ARCA.example ', now })).toEqual({ action: 'grant', email: 'ops@arca.example', userId,
      result: 'granted' });
    expect(await repository.isPlatformAdmin(userId)).toBe(true);
    expect(await auditRows(repository)).toEqual([{ action: 'platform_admin.granted', actor_kind: 'platform', actor_user_id: null, org_id: null,
      target: userId, data: {}, created_at: new Date(NOW).toISOString() }]);
    // Again: nothing changes and nothing more is audited.
    expect(await adminGrant(repository, { email: 'ops@arca.example', now })).toMatchObject({ result: 'unchanged' });
    expect(await auditRows(repository)).toHaveLength(1);
  });

  it('revokes it, and says so when there was nothing to revoke', async () => {
    const { repository, userId, now } = await setup();
    expect(await adminGrant(repository, { email: 'ops@arca.example', revoke: true, now })).toMatchObject({ action: 'revoke', result: 'unchanged' });
    await adminGrant(repository, { email: 'ops@arca.example', now });
    expect(await adminGrant(repository, { email: 'ops@arca.example', revoke: true, now })).toEqual({ action: 'revoke', email: 'ops@arca.example',
      userId, result: 'revoked' });
    expect(await repository.isPlatformAdmin(userId)).toBe(false);
    expect((await auditRows(repository)).map(row => row.action)).toEqual(['platform_admin.granted', 'platform_admin.revoked']);
  });

  it('with --dry-run says what it would do and writes nothing', async () => {
    const { repository, userId, now } = await setup();
    expect(await adminGrant(repository, { email: 'ops@arca.example', dryRun: true, now })).toMatchObject({ result: 'would_grant', userId });
    expect(await repository.isPlatformAdmin(userId)).toBe(false);
    await adminGrant(repository, { email: 'ops@arca.example', now });
    expect(await adminGrant(repository, { email: 'ops@arca.example', revoke: true, dryRun: true, now })).toMatchObject({ result: 'would_revoke' });
    expect(await adminGrant(repository, { email: 'ops@arca.example', dryRun: true, now })).toMatchObject({ result: 'unchanged' });
    expect(await repository.isPlatformAdmin(userId)).toBe(true);
    expect(await auditRows(repository)).toHaveLength(1);
  });

  it('refuses an email with no profile: the person signs in once first', async () => {
    const { repository, now } = await setup();
    await expect(adminGrant(repository, { email: 'nobody@arca.example', now })).rejects.toThrow(AdminGrantError);
    await expect(adminGrant(repository, { email: 'nobody@arca.example', now })).rejects.toThrow('sign in to the webapp once');
    await expect(adminGrant(repository, { email: 'not-an-email', now })).rejects.toThrow('valid email');
    expect(await auditRows(repository)).toEqual([]);
  });

  it('reads one email and the two flags from the command line, and nothing else', () => {
    expect(parseAdminGrantArgs(['ops@arca.example'])).toEqual({ email: 'ops@arca.example', revoke: false, dryRun: false });
    expect(parseAdminGrantArgs(['--dry-run', 'ops@arca.example', '--revoke'])).toEqual({ email: 'ops@arca.example', revoke: true, dryRun: true });
    for (const argv of [[], ['a@arca.example', 'b@arca.example'], ['ops@arca.example', '--force'], ['--revoke']]) {
      expect(() => parseAdminGrantArgs(argv), argv.join(' ')).toThrow('Usage: npm run admin:grant');
    }
  });
});
