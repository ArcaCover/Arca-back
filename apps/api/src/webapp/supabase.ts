import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { AUDIT_ACTOR_KINDS, type BillingStatus, type Role } from '@arca/contracts';
import { IneligibleAssignee, MemberChangeRefused, WebappConflict, type ActionPatch, type AssessmentActionRecord, type AuditActor,
  type AuditPageQuery, type AuditRecord, type BillingApplyOutcome, type BillingStateRecord, type ClaimTicketRecord, type CustomActionRecord,
  type DeletionRequestRecord, type InvitationRecord, type MemberChange, type MembershipRecord, type NewAuditRecord, type OrgActionRecord,
  type OrgAnalysisRecord, type OrganizationRecord, type PlanRecord, type ProfileRecord, type SubscriptionRecord, type WebappConflictReason,
  type WebappRepository } from './types.js';

// The columns each record reads, so a new column of a table (DN-13 §5.3) never leaks into a record, and the timestamps among them,
// which Postgres prints its own way ('2026-10-25T12:00:00+00:00') and the records carry as ISO with Z, as the in-memory store does.
const TABLES = {
  profiles: { columns: ['user_id', 'email', 'full_name', 'last_org_id', 'created_at'], times: ['created_at'] },
  organizations: { columns: ['id', 'name', 'domain', 'billing_status', 'deleted_at', 'created_by', 'created_at'], times: ['deleted_at', 'created_at'] },
  memberships: { columns: ['org_id', 'user_id', 'role', 'invited_by', 'created_at'], times: ['created_at'] },
  invitations: { columns: ['id', 'org_id', 'email', 'role', 'token_hash', 'invited_by', 'expires_at', 'accepted_at', 'revoked_at', 'created_at'],
    times: ['expires_at', 'accepted_at', 'revoked_at', 'created_at'] },
  org_analyses: { columns: ['org_id', 'scan_id', 'assessment_id', 'claimed_by', 'claimed_at'], times: ['claimed_at'] },
  claim_tickets: { columns: ['id_hash', 'scan_id', 'email', 'expires_at', 'used_at'], times: ['expires_at', 'used_at'] },
  plans: { columns: ['code', 'name', 'amount_cents', 'currency', 'interval', 'active'], times: [] },
  subscriptions: { columns: ['org_id', 'plan_code', 'customer_id', 'subscription_id', 'status', 'current_period_end', 'updated_at'],
    times: ['current_period_end', 'updated_at'] },
  deletion_requests: { columns: ['id', 'org_id', 'requested_by', 'reason', 'status', 'reviewed_by', 'reviewed_at', 'review_note', 'created_at'],
    times: ['reviewed_at', 'created_at'] },
  org_actions: { columns: ['id', 'org_id', 'source', 'scan_id', 'action_key', 'title', 'detail', 'domain', 'status', 'assignee_user_id',
    'due_date', 'created_by', 'created_at', 'updated_by', 'updated_at'], times: ['created_at', 'updated_at'] },
  audit_log: { columns: ['id', 'seq', 'actor_kind', 'actor_user_id', 'org_id', 'action', 'target', 'data', 'created_at'], times: ['created_at'] },
} as const;
type Table = keyof typeof TABLES;
const select = (table: Table) => TABLES[table].columns.join(',');
const PLAN_FIELDS = ['name', 'amount_cents', 'currency', 'interval', 'active'] as const;
const TRACKED_FIELDS = ['status', 'assignee_user_id', 'due_date', 'updated_by', 'updated_at'] as const;

/** One row as its record: only the record's columns, timestamps as ISO with Z, seq as a number. */
function record<T>(table: Table, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const column of TABLES[table].columns) out[column] = row[column] ?? null;
  for (const column of TABLES[table].times) if (typeof out[column] === 'string') out[column] = new Date(out[column] as string).toISOString();
  if (table === 'audit_log') out.seq = Number(out.seq);
  return out as T;
}
const records = <T>(table: Table, rows: unknown): T[] => ((rows ?? []) as Array<Record<string, unknown>>).map(row => record<T>(table, row));

const CONFLICTS: readonly WebappConflictReason[] = ['scan_claimed', 'last_owner', 'already_member', 'already_invited', 'deletion_pending',
  'action_limit', 'already_reviewed', 'invitation_closed'];
// The record names the RPC functions use (`webapp_missing:deletion_request`), as the in-memory store words them.
const RECORD_NAMES: Readonly<Record<string, string>> = { organization: 'Organization', invitation: 'Invitation', analysis: 'Analysis',
  deletion_request: 'Deletion request', action: 'action', plan: 'Plan' };
const constraintOf = (error: PostgrestError) => /unique constraint "([^"]+)"/.exec(error.message)?.[1] ?? null;

/**
 * The errors of the RPC functions (supabase/migrations/*_real_accounts_billing.sql) as the errors of the contract: a fixed message
 * with errcode P0001. Anything else stays a plain Error that names the operation, with the database error as its cause.
 */
function translate(error: PostgrestError, operation: string): Error {
  if (error.code === 'P0001') {
    const [kind, name = ''] = error.message.split(':');
    if (kind === 'webapp_conflict' && (CONFLICTS as readonly string[]).includes(name)) return new WebappConflict(name as WebappConflictReason);
    if (kind === 'webapp_refused') return new MemberChangeRefused();
    if (kind === 'webapp_ineligible_assignee') return new IneligibleAssignee();
    if (kind === 'webapp_missing') return new Error(`${RECORD_NAMES[name] ?? name} not found`);
    if (kind === 'webapp_duplicate') return new Error(`Duplicate ${RECORD_NAMES[name]?.toLowerCase() ?? name}`);
    if (kind === 'webapp_invalid' && name === 'organization') return new Error('Invalid organization');
  }
  return new Error(`Unable to ${operation}`, { cause: error });
}

/**
 * The webapp over Supabase (DN-13 §5.4): the Data API (supabase-js, PostgREST) with the service key, from the back only. Single-row
 * reads and writes go to the tables; every write DN-10 and DN-11 need atomic is one RPC function, since the Data API opens no
 * transaction across statements. The client roles reach none of it (RLS with no policies and no grants, §5.5).
 */
export class SupabaseWebappRepository implements WebappRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>, operation: string): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw translate(error, operation);
    return data as T;
  }
  private async one<T>(table: Table, operation: string, filters: Record<string, string | boolean>): Promise<T | null> {
    let query = this.client.from(table).select(select(table));
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query.maybeSingle();
    if (error) throw translate(error, operation);
    return data ? record<T>(table, data as unknown as Record<string, unknown>) : null;
  }
  private async insert(table: Table, row: object, operation: string, duplicates: Readonly<Record<string, () => Error>>): Promise<void> {
    const { error } = await this.client.from(table).insert(row);
    if (!error) return;
    const duplicate = error.code === '23505' ? duplicates[constraintOf(error) ?? ''] : undefined;
    throw duplicate ? duplicate() : translate(error, operation);
  }
  /** An update by key that says whether it found the row. */
  private async patch(table: Table, key: Record<string, string>, patch: object, operation: string): Promise<boolean> {
    let query = this.client.from(table).update(patch);
    for (const [column, value] of Object.entries(key)) query = query.eq(column, value);
    const { data, error } = await query.select(Object.keys(key).join(','));
    if (error) throw translate(error, operation);
    return (data ?? []).length > 0;
  }

  async upsertProfile(profile: ProfileRecord) {
    const { error } = await this.client.from('profiles').upsert(profile, { onConflict: 'user_id' });
    if (error) throw error.code === '23505' ? new Error('Duplicate profile email', { cause: error }) : translate(error, 'write profile');
  }
  getProfile(userId: string) { return this.one<ProfileRecord>('profiles', 'read profile', { user_id: userId }); }
  // Every profile is written with its email in lower case (ensureProfile), and a deleted one has none.
  findProfileByEmail(email: string) { return this.one<ProfileRecord>('profiles', 'find profile', { email: email.toLowerCase() }); }

  async createOrganization(org: OrganizationRecord, owner: MembershipRecord, analysis: OrgAnalysisRecord | null) {
    await this.rpc('create_organization', { p_org: org, p_owner: owner, p_analysis: analysis }, 'create organization');
  }
  getOrganization(id: string) { return this.one<OrganizationRecord>('organizations', 'read organization', { id }); }
  async updateOrganizationName(orgId: string, name: string) {
    if (!(await this.patch('organizations', { id: orgId }, { name }, 'rename organization'))) throw new Error('Organization not found');
  }
  async listOrganizationsForUser(userId: string) {
    const { data, error } = await this.client.from('memberships').select('org_id,role').eq('user_id', userId);
    if (error) throw translate(error, 'list memberships');
    const roles = new Map((data ?? []).map(row => [row.org_id as string, row.role as Role]));
    if (roles.size === 0) return [];
    const orgs = await this.list<OrganizationRecord>('organizations', 'list organizations', query => query.in('id', [...roles.keys()])
      .order('created_at').order('id'));
    return orgs.map(org => ({ org, role: roles.get(org.id)! }));
  }
  listOrganizations() {
    return this.list<OrganizationRecord>('organizations', 'list organizations', query => query.order('created_at').order('id'));
  }

  getMembership(orgId: string, userId: string) {
    return this.one<MembershipRecord>('memberships', 'read membership', { org_id: orgId, user_id: userId });
  }
  listMembers(orgId: string) {
    return this.list<MembershipRecord>('memberships', 'list members', query => query.eq('org_id', orgId).order('created_at').order('user_id'));
  }
  async addMember(member: MembershipRecord) {
    await this.insert('memberships', member, 'add member', { memberships_pkey: () => new WebappConflict('already_member') });
  }
  async setRole(orgId: string, userId: string, role: Role, change: MemberChange) {
    return this.rpc<Role | null>('set_member_role', { p_org_id: orgId, p_user_id: userId, p_role: role, p_actor_user_id: change.actorUserId,
      p_actor_role: change.actorRole, p_audit: change.audit, p_at: change.at }, 'change role');
  }
  async removeMember(orgId: string, userId: string, change: MemberChange) {
    return this.rpc<Role | null>('remove_member', { p_org_id: orgId, p_user_id: userId, p_actor_user_id: change.actorUserId,
      p_actor_role: change.actorRole, p_audit: change.audit, p_at: change.at }, 'remove member');
  }

  async createInvitation(invitation: InvitationRecord) {
    const duplicate = () => new Error('Duplicate invitation');
    await this.insert('invitations', invitation, 'create invitation', { invitations_pkey: duplicate, invitations_token_hash_key: duplicate,
      invitations_pending_email_idx: () => new WebappConflict('already_invited') });
  }
  findInvitationByHash(tokenHash: string) { return this.one<InvitationRecord>('invitations', 'read invitation', { token_hash: tokenHash }); }
  listInvitations(orgId: string) {
    return this.list<InvitationRecord>('invitations', 'list invitations', query => query.eq('org_id', orgId).is('accepted_at', null)
      .is('revoked_at', null).order('created_at').order('id'));
  }
  async updateInvitation(id: string, patch: Partial<Pick<InvitationRecord, 'accepted_at' | 'revoked_at'>>) {
    const fields = Object.fromEntries((['accepted_at', 'revoked_at'] as const).filter(field => patch[field] !== undefined)
      .map(field => [field, patch[field]]));
    const found = Object.keys(fields).length > 0 ? await this.patch('invitations', { id }, fields, 'update invitation')
      : (await this.one('invitations', 'read invitation', { id })) !== null;
    if (!found) throw new Error('Invitation not found');
  }
  acceptInvitation(invitationId: string, userId: string, at: string, actor: AuditActor) {
    return this.rpc<{ joined: boolean; role: Role }>('accept_invitation', { p_invitation_id: invitationId, p_user_id: userId, p_actor: actor,
      p_at: at }, 'accept invitation');
  }
  revokeInvitation(orgId: string, invitationId: string, at: string, actor: AuditActor, reason: 'reinvited' | null) {
    return this.rpc<boolean>('revoke_invitation', { p_org_id: orgId, p_invitation_id: invitationId, p_reason: reason, p_audit: actor, p_at: at },
      'revoke invitation');
  }

  async claimAnalysis(analysis: OrgAnalysisRecord) { await this.rpc('claim_analysis', { p_analysis: analysis }, 'claim analysis'); }
  listAnalyses(orgId: string) {
    return this.list<OrgAnalysisRecord>('org_analyses', 'list analyses', query => query.eq('org_id', orgId).order('claimed_at').order('scan_id'));
  }
  getAnalysisByScan(scanId: string) { return this.one<OrgAnalysisRecord>('org_analyses', 'read analysis', { scan_id: scanId }); }

  async createClaimTicket(ticket: ClaimTicketRecord) {
    await this.insert('claim_tickets', ticket, 'create claim ticket', { claim_tickets_pkey: () => new Error('Duplicate claim ticket') });
  }
  getClaimTicket(idHash: string) { return this.one<ClaimTicketRecord>('claim_tickets', 'read claim ticket', { id_hash: idHash }); }
  markClaimTicketUsed(idHash: string, at: string) {
    return this.rpc<boolean>('redeem_claim_ticket', { p_id_hash: idHash, p_at: at }, 'spend claim ticket');
  }

  // Cheapest first, which keeps the seed's order (monthly, then annual).
  listPlans() { return this.list<PlanRecord>('plans', 'list plans', query => query.order('amount_cents').order('code')); }
  getPlan(code: string) { return this.one<PlanRecord>('plans', 'read plan', { code }); }
  async updatePlan(code: string, patch: Partial<Omit<PlanRecord, 'code'>>) {
    const fields = Object.fromEntries(PLAN_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field]]));
    const found = Object.keys(fields).length > 0 ? await this.patch('plans', { code }, fields, 'update plan') : (await this.getPlan(code)) !== null;
    if (!found) throw new Error('Plan not found');
  }

  getSubscription(orgId: string) { return this.one<SubscriptionRecord>('subscriptions', 'read subscription', { org_id: orgId }); }
  async upsertSubscription(subscription: SubscriptionRecord) {
    const { error } = await this.client.from('subscriptions').upsert(subscription, { onConflict: 'org_id' });
    if (error) throw error.code === '23505' ? new Error('Duplicate subscription', { cause: error }) : translate(error, 'write subscription');
  }
  async setBillingStatus(orgId: string, status: BillingStatus) {
    if (!(await this.patch('organizations', { id: orgId }, { billing_status: status }, 'set billing status'))) throw new Error('Organization not found');
  }
  async recordBillingEvent(id: string, type: string) {
    const { data, error } = await this.client.from('stripe_events').upsert({ id, type }, { onConflict: 'id', ignoreDuplicates: true }).select('id');
    if (error) throw translate(error, 'record billing event');
    return (data ?? []).length === 1;
  }
  applyBillingState(event: { id: string; type: string; livemode?: boolean | null }, orgId: string, state: BillingStateRecord, at: string) {
    return this.rpc<BillingApplyOutcome>('apply_billing_state', { p_event: { id: event.id, type: event.type, livemode: event.livemode ?? null },
      p_org_id: orgId, p_state: state, p_at: at }, 'apply billing state');
  }

  async createDeletionRequest(request: DeletionRequestRecord) {
    await this.insert('deletion_requests', request, 'create deletion request', {
      deletion_requests_pkey: () => new Error('Duplicate deletion request'),
      deletion_requests_pending_idx: () => new WebappConflict('deletion_pending') });
  }
  getPendingDeletionRequest(orgId: string) {
    return this.one<DeletionRequestRecord>('deletion_requests', 'read deletion request', { org_id: orgId, status: 'pending' });
  }
  listDeletionRequests() {
    return this.list<DeletionRequestRecord>('deletion_requests', 'list deletion requests', query => query.order('created_at').order('id'));
  }
  getDeletionRequest(id: string) { return this.one<DeletionRequestRecord>('deletion_requests', 'read deletion request', { id }); }
  async reviewDeletionRequest(id: string, status: 'approved' | 'rejected', reviewedBy: string, note: string | null, at: string, actor: AuditActor) {
    await this.rpc('review_deletion_request', { p_request_id: id, p_status: status, p_reviewed_by: reviewedBy, p_note: note, p_audit: actor,
      p_at: at }, 'review deletion request');
  }
  async markOrganizationDeleted(orgId: string, at: string) {
    // Only an organization not deleted yet is marked, so the first deletion time stays.
    const { data, error } = await this.client.from('organizations').update({ deleted_at: at }).eq('id', orgId).is('deleted_at', null).select('id');
    if (error) throw translate(error, 'mark organization deleted');
    if ((data ?? []).length === 0 && !(await this.getOrganization(orgId))) throw new Error('Organization not found');
  }

  async isPlatformAdmin(userId: string) {
    const { data, error } = await this.client.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
    if (error) throw translate(error, 'read platform admin');
    return data !== null;
  }
  grantPlatformAdmin(userId: string, grantedBy: string | null, audit?: { actor: AuditActor; at: string }) {
    return this.rpc<boolean>('grant_platform_admin', { p_user_id: userId, p_granted_by: grantedBy, p_audit: audit?.actor ?? null,
      p_at: audit?.at ?? new Date().toISOString() }, 'grant platform admin');
  }
  revokePlatformAdmin(userId: string, audit?: { actor: AuditActor; at: string }) {
    return this.rpc<boolean>('revoke_platform_admin', { p_user_id: userId, p_audit: audit?.actor ?? null, p_at: audit?.at ?? new Date().toISOString() },
      'revoke platform admin');
  }

  listActions(orgId: string) {
    return this.list<OrgActionRecord>('org_actions', 'list actions', query => query.eq('org_id', orgId).order('created_at').order('id'));
  }
  getCustomAction(orgId: string, id: string) {
    return this.one<CustomActionRecord>('org_actions', 'read action', { org_id: orgId, id, source: 'custom' });
  }
  getAssessmentAction(orgId: string, scanId: string, actionKey: string) {
    return this.one<AssessmentActionRecord>('org_actions', 'read action', { org_id: orgId, scan_id: scanId, action_key: actionKey, source: 'assessment' });
  }
  async upsertAssessmentAction(action: AssessmentActionRecord, patch: ActionPatch) {
    const row = await this.rpc<Record<string, unknown>>('upsert_assessment_action', { p_action: action, p_patch: tracked(patch) }, 'write action');
    return record<AssessmentActionRecord>('org_actions', row);
  }
  async createCustomAction(action: CustomActionRecord) { await this.rpc('create_custom_action', { p_action: action }, 'create action'); }
  async countCustomActions(orgId: string) {
    const { data, error } = await this.client.from('org_actions').select('id').eq('org_id', orgId).eq('source', 'custom');
    if (error) throw translate(error, 'count actions');
    return (data ?? []).length;
  }
  async updateAction(orgId: string, id: string, patch: ActionPatch) {
    const row = await this.rpc<Record<string, unknown> | null>('update_action', { p_org_id: orgId, p_action_id: id, p_patch: tracked(patch) },
      'update action');
    return row ? record<OrgActionRecord>('org_actions', row) : null;
  }
  async deleteCustomAction(orgId: string, id: string) {
    const { data, error } = await this.client.from('org_actions').delete().eq('org_id', orgId).eq('id', id).eq('source', 'custom').select('id');
    if (error) throw translate(error, 'delete action');
    return (data ?? []).length > 0;
  }

  async appendAudit(row: NewAuditRecord) {
    // Refused before the insert, in the in-memory store's words; the column refuses it too.
    if (!(AUDIT_ACTOR_KINDS as readonly unknown[]).includes(row.actor_kind)) throw new Error('An audit row names its actor kind');
    await this.insert('audit_log', row, 'append audit', {});
  }
  async listAudit(orgId: string, { before, limit }: AuditPageQuery) {
    return records<AuditRecord>('audit_log', await this.rpc('list_audit', { p_org_id: orgId, p_scoped: true, p_before: before ?? null,
      p_limit: limit }, 'list audit'));
  }
  async listAllAudit({ orgId, before, limit }: AuditPageQuery & { orgId?: string }) {
    return records<AuditRecord>('audit_log', await this.rpc('list_audit', { p_org_id: orgId ?? null, p_scoped: orgId !== undefined,
      p_before: before ?? null, p_limit: limit }, 'list audit'));
  }

  private async list<T>(table: Table, operation: string, shape: (query: ReturnType<ReturnType<SupabaseClient['from']>['select']>) =>
    PromiseLike<{ data: unknown; error: PostgrestError | null }>): Promise<T[]> {
    const { data, error } = await shape(this.client.from(table).select(select(table)));
    if (error) throw translate(error, operation);
    return records<T>(table, data);
  }
}

/** Only the tracked fields a patch names travel: the functions move a column only when its key is there (null included). */
const tracked = (patch: ActionPatch) => Object.fromEntries(TRACKED_FIELDS.filter(field => patch[field] !== undefined).map(field => [field, patch[field]]));
