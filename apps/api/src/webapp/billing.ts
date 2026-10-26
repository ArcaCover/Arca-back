import { randomUUID } from 'node:crypto';
import type { BillingStatus } from '@arca/contracts';
import type { PlanRecord } from './types.js';

/** A provider event reduced to what the webapp acts on. Stripe's webhook will be translated into this shape. */
export type BillingEvent = {
  id: string; type: 'checkout.completed' | 'subscription.updated' | 'subscription.canceled' | 'payment.failed'; orgId: string;
  status: BillingStatus; planCode: string | null; customerId: string | null; subscriptionId: string | null; currentPeriodEnd: string | null;
};

export interface BillingProvider {
  /** The plan travels whole, so the provider charges the price in the plans table and nothing else (DN-10 §4.4). */
  createCheckout(input: { orgId: string; plan: PlanRecord; successUrl: string; cancelUrl: string }): Promise<{ sessionId: string; url: string }>;
  createPortal(input: { orgId: string; returnUrl: string }): Promise<{ url: string }>;
  cancel(orgId: string): Promise<void>;
}

const id = (prefix: string) => `${prefix}_mock_${randomUUID().replaceAll('-', '')}`;

/** Stripe stand-in for mock (DN-09): nothing leaves the process, and a checkout is paid through the debug route. */
export class MockBillingProvider implements BillingProvider {
  /** Organizations whose subscription was canceled, for the tests. */
  readonly canceled: string[] = [];
  private readonly sessions = new Map<string, { orgId: string; plan: PlanRecord; paid: boolean }>();
  private readonly appBaseUrl: string;

  constructor(appBaseUrl: string, private readonly now: () => number = Date.now) {
    this.appBaseUrl = appBaseUrl.replace(/\/+$/, '');
  }

  async createCheckout(input: { orgId: string; plan: PlanRecord; successUrl: string; cancelUrl: string }) {
    const sessionId = id('cs');
    this.sessions.set(sessionId, { orgId: input.orgId, plan: structuredClone(input.plan), paid: false });
    return { sessionId, url: `${this.appBaseUrl}/app/billing/mock-checkout?session=${encodeURIComponent(sessionId)}` };
  }
  // There is no portal in mock: the billing page is where the customer would land again.
  async createPortal(_input: { orgId: string; returnUrl: string }) { return { url: `${this.appBaseUrl}/app/billing` }; }
  async cancel(orgId: string) { this.canceled.push(orgId); }

  /** The event a completed checkout would send; null for an unknown session or one already paid. */
  pay(sessionId: string): BillingEvent | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.paid) return null;
    session.paid = true;
    const periodEnd = new Date(this.now());
    if (session.plan.interval === 'year') periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    return { id: id('evt'), type: 'checkout.completed', orgId: session.orgId, status: 'active', planCode: session.plan.code,
      customerId: `cus_mock_${session.orgId}`, subscriptionId: id('sub'), currentPeriodEnd: periodEnd.toISOString() };
  }
}
