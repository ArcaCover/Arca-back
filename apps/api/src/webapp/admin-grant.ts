import type { AuditActor, WebappRepository } from './types.js';

// `npm run admin:grant -- <email> [--revoke] [--dry-run]` (DN-10 §4.6, DN-13 §4.5): who is ARCA staff. The script is the only way
// to grant the platform role outside the debug modes; it is audited as ARCA with no user, since no one is signed in.
const USAGE = 'Usage: npm run admin:grant -- <email> [--revoke] [--dry-run]';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRIPT: AuditActor = { actor_kind: 'platform', actor_user_id: null };

export class AdminGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminGrantError';
  }
}

export type AdminGrantRequest = { email: string; revoke?: boolean; dryRun?: boolean; now?: () => number };
export type AdminGrantOutcome = { action: 'grant' | 'revoke'; email: string; userId: string;
  result: 'granted' | 'revoked' | 'unchanged' | 'would_grant' | 'would_revoke' };

export function parseAdminGrantArgs(argv: readonly string[]): { email: string; revoke: boolean; dryRun: boolean } {
  const flags = argv.filter(arg => arg.startsWith('--'));
  const emails = argv.filter(arg => !arg.startsWith('--'));
  if (emails.length !== 1 || flags.some(flag => flag !== '--revoke' && flag !== '--dry-run')) throw new AdminGrantError(USAGE);
  return { email: emails[0]!, revoke: flags.includes('--revoke'), dryRun: flags.includes('--dry-run') };
}

/**
 * Grants (or with `revoke`, takes away) the platform role of the person with this email. They need a profile, which the back writes
 * the first time they sign in: the role is never given to an email nobody has used. With `dryRun` nothing is written.
 */
export async function adminGrant(repository: WebappRepository, request: AdminGrantRequest): Promise<AdminGrantOutcome> {
  const email = request.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new AdminGrantError(`Not a valid email: ${request.email}`);
  const profile = await repository.findProfileByEmail(email);
  if (!profile) throw new AdminGrantError(`No profile for ${email}: the person has to sign in to the webapp once first`);
  const action = request.revoke ? 'revoke' : 'grant';
  const isAdmin = await repository.isPlatformAdmin(profile.user_id);
  const outcome = (result: AdminGrantOutcome['result']): AdminGrantOutcome => ({ action, email, userId: profile.user_id, result });
  if (isAdmin === (action === 'grant')) return outcome('unchanged');
  if (request.dryRun) return outcome(action === 'grant' ? 'would_grant' : 'would_revoke');
  const audit = { actor: SCRIPT, at: new Date((request.now ?? Date.now)()).toISOString() };
  // The store says whether it changed: a grant or revoke that raced this one changes and audits nothing.
  const changed = action === 'grant' ? await repository.grantPlatformAdmin(profile.user_id, null, audit)
    : await repository.revokePlatformAdmin(profile.user_id, audit);
  return outcome(changed ? (action === 'grant' ? 'granted' : 'revoked') : 'unchanged');
}
