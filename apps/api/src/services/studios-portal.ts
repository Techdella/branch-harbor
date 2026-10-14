import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { customers, locations, organizations, studioPortalTokens } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { unauthorized } from '../lib/errors.ts';
import { findOrCreateCustomer } from './customers.ts';

/**
 * Customer self-service on hosted sites, without a password: request a sign-in link by email (single use,
 * 20 minutes) and exchange it for a session token (30 days). Both are stored hashed. The response never
 * reveals whether an email is known.
 */
const LINK_MINUTES = 20;
const SESSION_DAYS = 30;

export async function requestPortalLink(s: Services, input: { locationId: string; email: string; name?: string; returnUrl?: string }) {
  const [loc] = await s.db.select({ l: locations, o: organizations }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId))
    .where(and(eq(locations.id, input.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
  if (!loc) return { sent: true as const, devToken: undefined };
  const email = input.email.trim();
  let [c] = await s.db.select().from(customers).where(and(eq(customers.organizationId, loc.o.id), sql`lower(${customers.email}) = ${email.toLowerCase()}`, isNull(customers.erasedAt)));
  if (!c && input.name) c = await findOrCreateCustomer(s.db, loc.o.id, loc.l.id, { name: input.name, email }, 'studio_portal');
  if (!c) return { sent: true as const, devToken: undefined };
  const token = randomToken();
  await s.db.insert(studioPortalTokens).values({ organizationId: loc.o.id, customerId: c.id, kind: 'link', tokenHash: sha256(token), expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) });
  const link = `${input.returnUrl ?? `${s.cfg.SITES_BASE_URL}/${loc.o.slug}/${loc.l.slug}/account`}?code=${encodeURIComponent(token)}`;
  await s.jobs.enqueue('email.send', { to: email, subject: `Your sign-in link for ${loc.o.name}`, text: `Hi ${c.name.split(' ')[0]},\n\nUse this link within ${LINK_MINUTES} minutes to see your bookings, credits and membership:\n${link}\n\nIf you didn't ask for it, ignore this email.`, tag: 'studio-portal-link' });
  return { sent: true as const, devToken: s.cfg.EXPOSE_DEV_TOKENS && s.cfg.NODE_ENV !== 'production' ? token : undefined };
}

export async function exchangePortalLink(s: Services, code: string) {
  return s.db.transaction(async (tx) => {
    const [t] = await tx.select().from(studioPortalTokens).where(and(eq(studioPortalTokens.tokenHash, sha256(code)), eq(studioPortalTokens.kind, 'link'))).for('update');
    if (!t || t.usedAt || t.expiresAt <= new Date()) throw unauthorized('This sign-in link has expired or was already used. Request a new one.');
    await tx.update(studioPortalTokens).set({ usedAt: new Date() }).where(eq(studioPortalTokens.id, t.id));
    const session = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
    await tx.insert(studioPortalTokens).values({ organizationId: t.organizationId, customerId: t.customerId, kind: 'session', tokenHash: sha256(session), expiresAt });
    return { session, expiresAt: expiresAt.toISOString() };
  });
}

/** Resolve a portal session to its customer (header `x-bh-customer-session`). */
export async function portalCustomer(s: Services, session: string | undefined | null) {
  if (!session || session.length < 10) throw unauthorized('Sign in to continue');
  const [row] = await s.db.select({ t: studioPortalTokens, c: customers }).from(studioPortalTokens).innerJoin(customers, eq(customers.id, studioPortalTokens.customerId))
    .where(and(eq(studioPortalTokens.tokenHash, sha256(session)), eq(studioPortalTokens.kind, 'session'), gt(studioPortalTokens.expiresAt, new Date()), isNull(studioPortalTokens.usedAt)));
  if (!row || row.c.erasedAt) throw unauthorized('Your session has ended. Sign in again.');
  return { customer: row.c, organizationId: row.t.organizationId };
}

export async function endPortalSession(s: Services, session: string) {
  await s.db.update(studioPortalTokens).set({ usedAt: new Date() }).where(and(eq(studioPortalTokens.tokenHash, sha256(session)), eq(studioPortalTokens.kind, 'session')));
}
