import { z } from 'zod';
import { Layer1Result } from './layer1.js';
import { AssessmentResult, DomainKey } from './layer2.js';

// The HTTP surface of the private webapp (DN-10, DN-11): organizations, members, billing, the action plan, the activity
// and the platform admin.
// Like http.ts, it lives in contracts because the frontend consumes exactly these shapes.

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read', 'org.update', 'analysis.create', 'actions.update', 'actions.assign', 'activity.read',
  'members.invite', 'members.remove', 'members.set_role',
  'billing.manage', 'org.transfer_ownership', 'org.request_deletion',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The single permission table (DN-10 §4.3, as DN-11 §4.1 changes it). The backend is the one that denies; the frontend
// only reads it to hide what a role cannot do. A member tracks the action plan but saves no analysis (DN-11 D2).
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...PERMISSIONS]),
  admin: Object.freeze<Permission[]>(['org.read', 'org.update', 'analysis.create', 'actions.update', 'actions.assign', 'activity.read',
    'members.invite', 'members.remove', 'members.set_role']),
  member: Object.freeze<Permission[]>(['org.read', 'actions.update']),
  viewer: Object.freeze<Permission[]>(['org.read']),
});

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

// Holding members.set_role is not enough: an admin may not act on an owner nor hand out ownership.
// `nextRole` is the role the target would get; leave it out when removing a member.
export function canManageMember(actor: Role, target: Role, nextRole?: Role): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'owner' && nextRole !== 'owner';
  return false;
}

export const BILLING_STATUSES = ['pending_payment', 'active', 'past_due', 'canceled'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

// past_due keeps its access (DN-10 §4.5): one failed payment does not lock a customer out.
export function hasPaidAccess(status: BillingStatus): boolean {
  return status === 'active' || status === 'past_due';
}

const role = z.enum(ROLES);
const invitableRole = z.enum(['admin', 'member', 'viewer']);
const billingStatus = z.enum(BILLING_STATUSES);
const timestamp = z.string().datetime();
const currency = z.string().regex(/^[a-z]{3}$/);
const interval = z.enum(['month', 'year']);
const amountCents = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
// A calendar date with no time of day, as Postgres `date` prints it.
const isoDate = z.string().date();
// The `seq` of an audit_log row (DN-11 §4.3). Identity values start at 1, and a page goes backwards from one.
const auditSeq = z.number().int().positive();
const orgName = z.string().trim().min(1).max(120);

export const PlanView = z.object({
  code: z.string().min(1), name: z.string().min(1), amountCents, currency, interval,
}).strict();
export const OrgView = z.object({
  id: z.string().min(1), name: z.string(), domain: z.string().nullable(), billingStatus, role,
  deletionPending: z.boolean(), paidAccess: z.boolean(),
}).strict();
export const MeResponse = z.object({
  user: z.object({ id: z.string().min(1), email: z.string().email() }).strict(),
  organizations: z.array(OrgView), platformAdmin: z.boolean(),
}).strict();
export const MemberView = z.object({
  userId: z.string().min(1), email: z.string().email(), role, joinedAt: timestamp,
}).strict();
// inviteUrl is present only in the response that creates the invitation: the token is never stored in clear.
export const InvitationView = z.object({
  id: z.string().min(1), email: z.string().email(), role: invitableRole, expiresAt: timestamp, inviteUrl: z.string().min(1).optional(),
}).strict();
export const AnalysisView = z.object({
  scanId: z.string().min(1), domain: z.string().min(1), scanStatus: z.enum(['COMPLETED', 'PARTIAL']), claimedAt: timestamp,
  layer1: Layer1Result, assessment: AssessmentResult.nullable(),
}).strict();
export const ClaimResponse = z.object({ claimId: z.string().min(1), email: z.string().email(), expiresAt: timestamp }).strict();
export const UrlResponse = z.object({ url: z.string().min(1) }).strict();
export const DeletionRequestView = z.object({
  id: z.string().min(1), orgId: z.string().min(1), reason: z.string(), status: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: timestamp, reviewedAt: timestamp.nullable(), reviewNote: z.string().nullable(),
}).strict();
export const AdminOrgView = z.object({
  id: z.string().min(1), name: z.string(), billingStatus, deleted: z.boolean(), members: count,
}).strict();

export const ACTION_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
const actionStatus = z.enum(ACTION_STATUSES);

// Public action keys (DN-11 §4.2): `a.<scanId>.<actionKey>` for an action of the assessment, whose action key may itself
// hold dots and colons (`improve:D1.1`), and `c.<uuid>` for an action the organization wrote itself.
const assessmentActionKey = z.string().regex(/^a\.sc_[a-zA-Z0-9]+\..+$/);
const customActionKey = z.string().regex(/^c\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const tracking = {
  status: actionStatus,
  assignee: z.object({ userId: z.string().min(1), email: z.string().email() }).strict().nullable(),
  dueDate: isoDate.nullable(),
  // Null while nothing has changed: an action of the assessment has no row until then and reads as todo.
  updatedAt: timestamp.nullable(),
};
/** One action of the plan. An action of the assessment always has a domain and points; the organization's own never have points. */
export const ActionItemView = z.discriminatedUnion('source', [
  z.object({
    key: assessmentActionKey, source: z.literal('assessment'), title: z.string().min(1), detail: z.string(), domain: DomainKey,
    pointsGain: z.number().nonnegative(), ...tracking,
  }).strict(),
  z.object({
    key: customActionKey, source: z.literal('custom'), title: z.string().min(1), detail: z.string().nullable(),
    domain: DomainKey.nullable(), pointsGain: z.null(), ...tracking,
  }).strict(),
]);
/**
 * The current plan (DN-11 §4.2): the assessment's actions from the latest analysis that has one, plus the organization's
 * own. It leaves the analysis out, so the plan never repeats its decision, and an action of an older plan never shows (D14).
 */
export const ActionPlanResponse = z.object({
  source: z.object({
    scanId: z.string().regex(/^sc_[a-zA-Z0-9]+$/), domain: z.string().min(1), claimedAt: timestamp,
  }).strict().nullable(),
  items: z.array(ActionItemView),
}).strict().superRefine(({ source, items }, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const path = ['items', index, 'key'];
    if (seen.has(item.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Duplicate action key' });
    seen.add(item.key);
    if (item.source === 'assessment' && (source === null || !item.key.startsWith(`a.${source.scanId}.`))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Not an action of the current plan' });
    }
  });
});

/**
 * Who acted, as the organization sees it (DN-11 §4.3). Only a member carries an email, even after leaving; ARCA staff and
 * the system never do. A member whose profile is gone has none either.
 */
const ActivityActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), email: z.string().email().nullable() }).strict(),
  z.object({ kind: z.literal('arca'), email: z.null() }).strict(),
  z.object({ kind: z.literal('system'), email: z.null() }).strict(),
]);
/**
 * The raw `data` of an audit row never leaves the back: `change` holds only an allowed field (a role, an action status, a
 * name or a date).
 */
export const ActivityEventView = z.object({
  id: z.string().min(1), at: timestamp, actor: ActivityActor, action: z.string().min(1), targetLabel: z.string().nullable(),
  change: z.object({ from: z.string().nullable(), to: z.string().nullable() }).strict().nullable(),
}).strict();
/** `nextBefore` is the `before` that asks for the next, older page; null on the last one. */
export const ActivityPage = z.object({ events: z.array(ActivityEventView), nextBefore: auditSeq.nullable() }).strict();

/** One organization as the platform admin sees it (DN-11 §4.5). */
export const AdminOrgDetailView = z.object({
  id: z.string().min(1), name: z.string(), domain: z.string().nullable(), billingStatus, deleted: z.boolean(), createdAt: timestamp,
  // The plan of its subscription; null while it has none.
  planCode: z.string().min(1).nullable(),
  analysisCount: count,
  pendingDeletion: DeletionRequestView.nullable(),
  members: z.array(MemberView.omit({ userId: true })),
}).strict();
// audit_log.actor_kind: `platform` is ARCA staff acting from /admin/*, `system` a billing event or the seed.
export const AUDIT_ACTOR_KINDS = ['member', 'platform', 'system'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];
/** ARCA's own audit, across organizations. Unlike an organization's activity, it shows the email of ARCA staff too. */
export const AdminAuditEventView = z.object({
  id: z.string().min(1), at: timestamp, orgId: z.string().min(1).nullable(), orgName: z.string().nullable(),
  actorKind: z.enum(AUDIT_ACTOR_KINDS), actorEmail: z.string().email().nullable(), action: z.string().min(1),
  targetLabel: z.string().nullable(),
}).strict();
export const AdminAuditPage = z.object({ events: z.array(AdminAuditEventView), nextBefore: auditSeq.nullable() }).strict();
/** Counts only, never a figure about money (DN-11 §4.5). */
export const AdminMetricsView = z.object({
  // The four billing statuses count the organizations that are not deleted; the deleted ones are counted apart.
  organizations: z.object({ pending_payment: count, active: count, past_due: count, canceled: count, deleted: count }).strict(),
  members: count,
  analyses: count,
  pendingDeletionRequests: count,
  // Over the current plan of every organization that is not deleted, untouched actions of the assessment counted as todo.
  actions: z.object({ todo: count, in_progress: count, done: count }).strict(),
}).strict();

export const CreateClaimRequest = z.object({ scanToken: z.string().min(1) }).strict();
export const CreateOrgRequest = z.object({ name: orgName, claimId: z.string().min(1) }).strict();
export const UpdateOrgRequest = z.object({ name: orgName }).strict();
export const AttachAnalysisRequest = z.object({ claimId: z.string().min(1) }).strict();
// An invitation can never grant ownership; ownership only moves with org.transfer_ownership.
export const InviteRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(320), role: invitableRole,
}).strict();
export const SetRoleRequest = z.object({ role }).strict();
export const DeletionRequestBody = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
export const CheckoutRequest = z.object({ planCode: z.string().min(1) }).strict();
export const ReviewRequest = z.object({ note: z.string().max(2000).optional() }).strict();
export const UpdatePlanRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(), amountCents: amountCents.optional(),
  currency: currency.optional(), interval: interval.optional(), active: z.boolean().optional(),
}).strict().refine(change => Object.values(change).some(value => value !== undefined), { message: 'Nothing to update' });
// Null clears the assignee or the due date. Sending either of them, even as null, takes actions.assign (DN-11 §4.2).
export const UpdateActionRequest = z.object({
  status: actionStatus.optional(), assigneeUserId: z.string().min(1).nullable().optional(), dueDate: isoDate.nullable().optional(),
}).strict().refine(change => Object.values(change).some(value => value !== undefined), { message: 'Nothing to update' });
export const CreateActionRequest = z.object({
  title: z.string().trim().min(1).max(200), detail: z.string().trim().max(2000).optional(), domain: DomainKey.nullable().optional(),
}).strict();

export type PlanView = z.infer<typeof PlanView>;
export type OrgView = z.infer<typeof OrgView>;
export type MeResponse = z.infer<typeof MeResponse>;
export type MemberView = z.infer<typeof MemberView>;
export type InvitationView = z.infer<typeof InvitationView>;
export type AnalysisView = z.infer<typeof AnalysisView>;
export type ClaimResponse = z.infer<typeof ClaimResponse>;
export type UrlResponse = z.infer<typeof UrlResponse>;
export type DeletionRequestView = z.infer<typeof DeletionRequestView>;
export type AdminOrgView = z.infer<typeof AdminOrgView>;
export type ActionItemView = z.infer<typeof ActionItemView>;
export type ActionPlanResponse = z.infer<typeof ActionPlanResponse>;
export type ActivityEventView = z.infer<typeof ActivityEventView>;
export type ActivityPage = z.infer<typeof ActivityPage>;
export type AdminOrgDetailView = z.infer<typeof AdminOrgDetailView>;
export type AdminAuditEventView = z.infer<typeof AdminAuditEventView>;
export type AdminAuditPage = z.infer<typeof AdminAuditPage>;
export type AdminMetricsView = z.infer<typeof AdminMetricsView>;
export type CreateClaimRequest = z.infer<typeof CreateClaimRequest>;
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;
export type AttachAnalysisRequest = z.infer<typeof AttachAnalysisRequest>;
export type InviteRequest = z.infer<typeof InviteRequest>;
export type SetRoleRequest = z.infer<typeof SetRoleRequest>;
export type DeletionRequestBody = z.infer<typeof DeletionRequestBody>;
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;
export type ReviewRequest = z.infer<typeof ReviewRequest>;
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequest>;
export type UpdateOrgRequest = z.infer<typeof UpdateOrgRequest>;
export type UpdateActionRequest = z.infer<typeof UpdateActionRequest>;
export type CreateActionRequest = z.infer<typeof CreateActionRequest>;
