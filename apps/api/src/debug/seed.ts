import type { AnswerValue, AssessmentResult, RenderedQuestion } from '@arca/contracts';
import { DebugSeedResponse } from '@arca/contracts/debug';
import type { AssessmentService } from '../assessment/service.js';
import type { ScanRecord } from '../repositories/types.js';
import type { AppUser, MockAppAuth } from '../webapp/auth.js';
import type { MockBillingProvider } from '../webapp/billing.js';
import type { InMemoryWebappRepository } from '../webapp/in-memory.js';
import type { WebappService } from '../webapp/service.js';

// The demo organization of mock (DN-11 §4.6). Every address is under .example (RFC 2606), so none reaches a real inbox.
const DOMAIN = 'robust.arca.example';
const NAME = 'Robust Law (demo)';
const OWNER = 'owner@demo.arca.example';
const INVITED = [['admin@demo.arca.example', 'admin'], ['member@demo.arca.example', 'member'], ['viewer@demo.arca.example', 'viewer']] as const;
const PLATFORM_ADMIN = 'ops@demo.arca.example';
// Fewer would leave the demo little to mark, assign and filter in the action plan.
const MIN_ACTIONS = 3;
const MAX_ANSWERS = 50;

/** The real pieces the seed runs: the app's scan and assessments, and the mock webapp. Only mock builds them all. */
export type SeedDeps = {
  /** The scan POST /scan runs, without its limiter, awaited until it is stored as finished. */
  runScan(email: string, domain: string): Promise<{ scan: ScanRecord; sessionToken: string }>;
  assessments: AssessmentService;
  auth: MockAppAuth; billing: MockBillingProvider; service: WebappService; repository: InMemoryWebappRepository;
};
/** What the debug tools remember of a seed: the organization and the users it let in. */
export type SeededDemo = { orgId: string; members: AppUser[]; platformAdmin: AppUser };

const unanswerable = (question: RenderedQuestion) => new Error(`Question ${question.id} (${question.type}) has nothing to choose from`);

/** The front's Auto-answer (DN-09 §6.4), ported: the question's suggested answer, or else the first valid one for its type. */
export function chooseAnswer(question: RenderedQuestion): AnswerValue {
  if (question.suggestedAnswer) return question.suggestedAnswer;
  switch (question.type) {
    case 'single_select':
    case 'yes_no': {
      const first = question.options?.[0];
      if (!first) throw unanswerable(question);
      return { kind: 'option', optionId: first.id };
    }
    case 'multi_select': {
      // An exclusive option ("None", "Not sure") must stand alone, so it is the pick only when nothing else exists.
      const pick = question.options?.find(option => !option.exclusive) ?? question.options?.[0];
      if (!pick) throw unanswerable(question);
      return { kind: 'options', optionIds: [pick.id] };
    }
    case 'scale':
      if (!question.scale) throw unanswerable(question);
      return { kind: 'scale', value: question.scale.max };
    case 'number':
      if (!question.number) throw unanswerable(question);
      return { kind: 'number', value: question.number.min };
  }
}

/** One answer at a time, reading the follow-ups from each save, so the branch rules decide what appears, as for a person. */
async function completeAssessment(assessments: AssessmentService, scan: ScanRecord): Promise<AssessmentResult> {
  let record = await assessments.planned((await assessments.start(scan)).id);
  if (record.status !== 'READY') throw new Error(`The assessment left planning as ${record.status}`);
  for (let saved = 0; ; saved++) {
    const view = assessments.view(record);
    const pending = view.questions.find(question => !view.answers[question.id]);
    if (!pending) break;
    if (saved === MAX_ANSWERS) throw new Error(`Gave up after ${MAX_ANSWERS} answers with questions still pending`);
    record = await assessments.save(record.id, pending.id, chooseAnswer(pending));
  }
  return assessments.complete(record.id);
}

/**
 * Builds the demo organization through the real flow, with no result written by hand: the owner's scan of the robust fixture and
 * its assessment, the claim, the simulated payment and an invitation per role, each accepted by its user. The service audits all
 * of it as the system's (DN-11 §4.3).
 */
export async function seedDemo(deps: SeedDeps): Promise<SeededDemo> {
  const { scan, sessionToken } = await deps.runScan(OWNER, DOMAIN);
  const { actionPlan } = await completeAssessment(deps.assessments, scan);
  if (actionPlan.length < MIN_ACTIONS) throw new Error(`The assessment left ${actionPlan.length} actions; the demo needs ${MIN_ACTIONS}`);
  const service = deps.service.asSystem();
  // The identities the mock login gives these emails, so each user signs in to what the seed built.
  const user = async (email: string) => (await deps.auth.issue(email)).user;
  const owner = await user(OWNER);
  const { claimId } = await service.issueClaim(sessionToken);
  const org = await service.createOrganization(owner, { name: NAME, claimId });
  const [plan] = await service.listPlans();
  if (!plan) throw new Error('No active plan to pay the demo organization with');
  const { url } = await service.checkout(owner, org.id, plan.code);
  const event = deps.billing.pay(new URL(url).searchParams.get('session') ?? '');
  if (!event || await service.applyBillingEvent(event) !== 'applied') throw new Error('The simulated payment was not applied');
  const members = [owner];
  for (const [email, role] of INVITED) {
    const token = (await service.invite(owner, org.id, { email, role })).inviteUrl?.split('/app/invite/')[1];
    if (!token) throw new Error('The invitation came without its link');
    const member = await user(email);
    await service.acceptInvitation(member, token);
    members.push(member);
  }
  const platformAdmin = await user(PLATFORM_ADMIN);
  await deps.repository.grantPlatformAdmin(platformAdmin.userId, platformAdmin.userId);
  return { orgId: org.id, members, platformAdmin };
}

/**
 * The seeded organization as the demo left it: its current name, and each seeded user with the role they hold now, or left out once
 * removed. Null when it is gone or deleted. Never a token: signing in goes through the mock login.
 */
export async function describeDemo(repository: InMemoryWebappRepository, seeded: SeededDemo): Promise<DebugSeedResponse | null> {
  const org = await repository.getOrganization(seeded.orgId);
  if (!org || org.deleted_at !== null) return null;
  const users: DebugSeedResponse['users'] = [];
  for (const { userId, email } of seeded.members) {
    const membership = await repository.getMembership(org.id, userId);
    if (membership) users.push({ email, role: membership.role });
  }
  if (await repository.isPlatformAdmin(seeded.platformAdmin.userId)) users.push({ email: seeded.platformAdmin.email, role: 'platform_admin' });
  return DebugSeedResponse.parse({ organization: { id: org.id, name: org.name }, users });
}
