import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { billingEnforced } from '../config.ts';
import { subscriptions } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';

/** Statuses that allow changing data. `past_due` keeps working while Stripe retries the payment. */
const WRITABLE = new Set(['trialing', 'active', 'past_due']);
/** Organisation routes that stay open without a plan: billing itself, onboarding, the organisation profile, data export, access. */
const OPEN = /^\/v1\/orgs\/:orgId(?:$|\/(?:billing|subscription|onboarding|exports|franchisee-billing|upgrade-to-network|access\/me)(?:\/|$))/;

/**
 * No free plan, no free trial: when BILLING_ENFORCE is on (default in production), an organisation must have started
 * its paid trial (or a plan) before it can change data. Reads stay open so the app can show the checkout; billing,
 * onboarding and the free data export always work.
 */
export async function billingGate(req: FastifyRequest, _reply: FastifyReply) {
  const s = req.server.ctx;
  if (!billingEnforced(s.cfg)) return;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const url = req.routeOptions.url;
  if (!url || !url.startsWith('/v1/orgs/:orgId') || OPEN.test(url)) return;
  if (req.method === 'PATCH' && url === '/v1/orgs/:orgId') return;
  const orgId = (req.params as { orgId?: string } | undefined)?.orgId;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) return;
  const [sub] = await s.db.select({ status: subscriptions.status }).from(subscriptions).where(eq(subscriptions.organizationId, orgId));
  if (!sub || WRITABLE.has(sub.status)) return;
  throw new AppError(402, 'plan_required', sub.status === 'canceled'
    ? 'Your BranchHarbor plan has ended. Restart it in Settings → Billing to make changes. You can still export your data.'
    : 'Start your 14-day trial in Settings → Billing to make changes.', undefined, { billing: { path: `/v1/orgs/${orgId}/billing`, status: sub.status } });
}
