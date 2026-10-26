import { z } from 'zod';
import { Layer1Result } from './layer1.js';
import { AssessmentResult } from './layer2.js';

// The HTTP surface of the private webapp (DN-10): organizations, members, billing and the platform admin.
// Like http.ts, it lives in contracts because the frontend consumes exactly these shapes.

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read', 'analysis.create', 'members.invite', 'members.remove', 'members.set_role',
  'billing.manage', 'org.transfer_ownership', 'org.request_deletion',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The single permission table (DN-10 §4.3). The backend is the one that denies; the frontend only reads it to hide buttons.
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: Object.freeze([...PERMISSIONS]),
  admin: Object.freeze<Permission[]>(['org.read', 'analysis.create', 'members.invite', 'members.remove', 'members.set_role']),
  member: Object.freeze<Permission[]>(['org.read', 'analysis.create']),
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
  id: z.string().min(1), name: z.string(), billingStatus, deleted: z.boolean(), members: z.number().int().nonnegative(),
}).strict();

export const CreateClaimRequest = z.object({ scanToken: z.string().min(1) }).strict();
export const CreateOrgRequest = z.object({ name: z.string().trim().min(1).max(120), claimId: z.string().min(1) }).strict();
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
export type CreateClaimRequest = z.infer<typeof CreateClaimRequest>;
export type CreateOrgRequest = z.infer<typeof CreateOrgRequest>;
export type AttachAnalysisRequest = z.infer<typeof AttachAnalysisRequest>;
export type InviteRequest = z.infer<typeof InviteRequest>;
export type SetRoleRequest = z.infer<typeof SetRoleRequest>;
export type DeletionRequestBody = z.infer<typeof DeletionRequestBody>;
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;
export type ReviewRequest = z.infer<typeof ReviewRequest>;
export type UpdatePlanRequest = z.infer<typeof UpdatePlanRequest>;
