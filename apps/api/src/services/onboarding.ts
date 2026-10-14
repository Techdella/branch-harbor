import { count, eq } from 'drizzle-orm';
import { ONBOARDING_STEPS } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { classTypes, connections, invitations, locations, menus, organizations, products, programmes, services, users, websites, roleAssignments } from '../db/schema/index.ts';

/** Checklist state: stored progress merged with facts derived from data (never blocks navigation). */
export async function onboardingState(db: Exec, orgId: string, userId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) return null;
  const [u] = await db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
  const n = async (q: Promise<Array<{ c: number }>>) => (await q)[0]?.c ?? 0;
  const locs = await db.select({ id: locations.id, paymentsEnabled: locations.paymentsEnabled }).from(locations).where(eq(locations.organizationId, orgId));
  const industryRows =
    (await n(db.select({ c: count() }).from(classTypes).where(eq(classTypes.organizationId, orgId)))) +
    (await n(db.select({ c: count() }).from(services).where(eq(services.organizationId, orgId)))) +
    (await n(db.select({ c: count() }).from(programmes).where(eq(programmes.organizationId, orgId)))) +
    (await n(db.select({ c: count() }).from(products).where(eq(products.organizationId, orgId)))) +
    (await n(db.select({ c: count() }).from(menus).where(eq(menus.organizationId, orgId))));
  const derived: Record<string, boolean> = {
    account: !!u?.v,
    industry: true,
    business_details: true,
    first_location: locs.length > 0,
    website: (await n(db.select({ c: count() }).from(websites).where(eq(websites.organizationId, orgId)))) > 0,
    industry_data: industryRows > 0,
    connections: (await n(db.select({ c: count() }).from(connections).where(eq(connections.organizationId, orgId)))) > 0 || locs.some((l) => l.paymentsEnabled),
    invite_staff:
      (await n(db.select({ c: count() }).from(invitations).where(eq(invitations.organizationId, orgId)))) > 0 ||
      (await n(db.select({ c: count() }).from(roleAssignments).where(eq(roleAssignments.organizationId, orgId)))) > 1,
    preview_publish: false,
  };
  const blockers: Array<{ step: string; code: string; message: string; repairAction: string }> = [];
  if (!derived.account) blockers.push({ step: 'account', code: 'email_unverified', message: 'Verify your email address to publish.', repairAction: 'POST /v1/auth/resend-verification' });
  if (locs.length && !locs.some((l) => l.paymentsEnabled))
    blockers.push({ step: 'preview_publish', code: 'payments_not_enabled', message: 'Paid bookings and orders stay unavailable until a payment account is enabled.', repairAction: `POST /v1/orgs/${orgId}/payments/connect/onboarding` });
  if (!locs.length) blockers.push({ step: 'first_location', code: 'no_locations', message: 'Add a location before publishing.', repairAction: `POST /v1/orgs/${orgId}/locations` });

  // Independent businesses get a shorter checklist: business details and the location are one "Your business"
  // step, and inviting staff is left to the Team screen (still possible at any time).
  const independent = org.model === 'independent';
  const defs = independent
    ? ONBOARDING_STEPS.filter((d) => d.key !== 'business_details' && d.key !== 'invite_staff')
      .map((d) => (d.key === 'first_location' ? { ...d, title: 'Your business: address, time zone, currency and hours' } : d))
    : ONBOARDING_STEPS;
  if (independent && !locs.length) {
    const b = blockers.find((x) => x.code === 'no_locations');
    if (b) b.message = 'Add your business address, time zone and hours before publishing.';
  }
  const steps = defs.map((def) => {
    const stored = org.onboarding[def.key];
    const status = derived[def.key] ? 'complete' : stored?.status ?? 'not_started';
    return { ...def, status, data: stored?.data ?? null, updatedAt: stored?.updatedAt ?? null, derived: !!derived[def.key] };
  });
  const done = steps.filter((st) => st.status === 'complete' || st.status === 'skipped').length;
  return { model: independent ? 'independent' as const : 'network' as const, steps, completed: done, total: steps.length, blockers };
}

