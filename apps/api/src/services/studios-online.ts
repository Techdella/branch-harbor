import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { locations, memberships, onlineAccessGrants, onlineContent, packs } from '../db/schema/index.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { locationAccess } from './studios-entitlements.ts';

type Content = typeof onlineContent.$inferSelect;
type Loc = typeof locations.$inferSelect;

export type AccessBasis = 'member' | 'pack_holder' | 'purchase' | 'free';

export interface OnlineAccess {
  access: boolean;
  basis: AccessBasis | null;
  registered: boolean;
  /** Livestreams need a registration before the link is revealed. */
  needsRegistration: boolean;
  canJoin: boolean;
  reasons: string[];
  purchasable: { amount: number; currency: string } | null;
}

export function accessRules(c: Content): string[] {
  const r: string[] = [];
  if (c.allowFree) r.push('Free with registration');
  if (c.allowMembers) r.push('Included with a membership');
  if (c.allowPackHolders) r.push('Included for class pack holders');
  if (Object.keys(c.prices).length) r.push('Available to buy');
  return r.length ? r : ['Not available yet'];
}

/**
 * Evaluate a customer's access to online content. The provider link (Zoom / YouTube unlisted / …) is only
 * ever returned by `join` after this says `canJoin`.
 */
export async function onlineAccess(db: Exec, c: Content, loc: Loc, customerId: string | null, now = new Date()): Promise<OnlineAccess> {
  const purchasable = c.prices[loc.currency] !== undefined ? { amount: c.prices[loc.currency]!, currency: loc.currency } : null;
  const needsRegistration = c.kind === 'livestream';
  if (!customerId) return { access: false, basis: null, registered: false, needsRegistration, canJoin: false, reasons: ['Sign in to access online classes'], purchasable };
  const target = { id: c.locationId ?? loc.id, currency: loc.currency };
  const reasons: string[] = [];
  let basis: AccessBasis | null = null;
  const [grant] = await db.select().from(onlineAccessGrants).where(and(eq(onlineAccessGrants.contentId, c.id), eq(onlineAccessGrants.customerId, customerId), isNull(onlineAccessGrants.revokedAt)));
  if (grant?.kind === 'purchase') basis = 'purchase';
  if (!basis && c.allowMembers) {
    const ms = await db.select().from(memberships).where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, c.organizationId), inArray(memberships.status, ['active', 'grace'])));
    const homes = new Map((ms.length ? await db.select({ id: locations.id, currency: locations.currency }).from(locations).where(inArray(locations.id, ms.map((m) => m.locationId!).filter(Boolean))) : []).map((l) => [l.id, l.currency]));
    const ok = ms.find((m) => (m.status === 'active' || (m.graceUntil && m.graceUntil > now)) && (!m.endsAt || m.endsAt > now) && (!m.cancelAt || m.cancelAt > now)
      && !(m.pausedFrom && m.pausedUntil && m.pausedFrom <= now && now < m.pausedUntil)
      && (!c.locationId || locationAccess(m.accessPolicy, m.locationId, m.allowedLocationIds, target, m.locationId ? homes.get(m.locationId) ?? null : null).ok));
    if (ok) basis = 'member';
    else reasons.push(ms.length ? 'Your membership does not include this class right now' : 'Members only');
  }
  if (!basis && c.allowPackHolders) {
    const ps = await db.select().from(packs).where(and(eq(packs.customerId, customerId), eq(packs.organizationId, c.organizationId), eq(packs.status, 'active'), gt(packs.creditsRemaining, 0), or(isNull(packs.expiresAt), sql`${packs.expiresAt} > ${now.toISOString()}`)));
    const homes = new Map((ps.length ? await db.select({ id: locations.id, currency: locations.currency }).from(locations).where(inArray(locations.id, ps.map((p) => p.locationId!).filter(Boolean))) : []).map((l) => [l.id, l.currency]));
    if (ps.some((p) => !c.locationId || locationAccess(p.transferPolicy, p.locationId, p.allowedLocationIds, target, p.locationId ? homes.get(p.locationId) ?? null : null).ok)) basis = 'pack_holder';
    else reasons.push('Class pack holders only');
  }
  if (!basis && c.allowFree) basis = 'free';
  if (!basis && purchasable) reasons.push('Buy this class to watch');
  const registered = !!grant;
  const live = c.kind === 'livestream';
  const ended = live && c.startsAt && c.durationMinutes ? new Date(c.startsAt.getTime() + c.durationMinutes * 60_000) < now : false;
  if (ended) reasons.push('This livestream has ended');
  const canJoin = !!basis && !ended && (!needsRegistration || registered);
  return { access: !!basis, basis, registered, needsRegistration, canJoin, reasons: basis ? [] : reasons, purchasable };
}

export async function registerOnline(db: Exec, c: Content, loc: Loc, customerId: string, actor: string | null) {
  if (c.status !== 'published') throw notFound('Online class');
  const a = await onlineAccess(db, c, loc, customerId);
  if (!a.access) throw new AppError(403, 'no_online_access', a.reasons.join('; ') || 'You do not have access to this class', undefined, { reasons: a.reasons, purchasable: a.purchasable });
  if (a.registered) return { registered: true, basis: a.basis, already: true };
  const [g] = await db.insert(onlineAccessGrants).values({ organizationId: c.organizationId, contentId: c.id, customerId, kind: 'registration', basis: a.basis! }).onConflictDoNothing().returning();
  await audit(db, { organizationId: c.organizationId, actorUserId: actor, action: 'online.registered', scopeKind: c.locationId ? 'location' : 'organization', scopeId: c.locationId ?? c.organizationId, targetType: 'online_content', targetId: c.id, metadata: { customerId, basis: a.basis } });
  return { registered: true, basis: a.basis, already: !g };
}

/** Reveal the provider link to an entitled (and, for livestreams, registered) customer. */
export async function joinOnline(db: Exec, c: Content, loc: Loc, customerId: string) {
  if (c.status !== 'published') throw notFound('Online class');
  const a = await onlineAccess(db, c, loc, customerId);
  if (!a.access) throw new AppError(403, 'no_online_access', a.reasons.join('; ') || 'You do not have access to this class', undefined, { reasons: a.reasons, purchasable: a.purchasable });
  if (a.needsRegistration && !a.registered) throw conflict('registration_required', 'Register for this livestream first');
  if (!a.canJoin) throw conflict('not_joinable', a.reasons.join('; ') || 'This class cannot be joined now');
  // On-demand access by membership/pack is logged as a registration the first time someone watches.
  if (!a.registered) await db.insert(onlineAccessGrants).values({ organizationId: c.organizationId, contentId: c.id, customerId, kind: 'registration', basis: a.basis! }).onConflictDoNothing();
  await db.update(onlineAccessGrants).set({ joinedAt: new Date() }).where(and(eq(onlineAccessGrants.contentId, c.id), eq(onlineAccessGrants.customerId, customerId), isNull(onlineAccessGrants.revokedAt)));
  const opensAt = c.kind === 'livestream' && c.startsAt ? new Date(c.startsAt.getTime() - 15 * 60_000) : null;
  return { url: c.providerUrl, provider: c.provider, basis: a.basis, opensAt: opensAt?.toISOString() ?? null, startsAt: c.startsAt?.toISOString() ?? null };
}

export function serializeContent(c: Content, opts: { includeUrl: boolean; registrations?: number; locationName?: string | null }) {
  return {
    id: c.id, kind: c.kind, title: c.title, description: c.description, classTypeId: c.classTypeId, occurrenceId: c.occurrenceId, instructorName: c.instructorName, provider: c.provider,
    ...(opts.includeUrl ? { providerUrl: c.providerUrl } : {}), startsAt: c.startsAt?.toISOString() ?? null, durationMinutes: c.durationMinutes, locationId: c.locationId, locationName: opts.locationName ?? null,
    allowMembers: c.allowMembers, allowPackHolders: c.allowPackHolders, allowFree: c.allowFree, prices: c.prices, rules: accessRules(c), status: c.status, publishedAt: c.publishedAt?.toISOString() ?? null,
    registrations: opts.registrations ?? null, createdAt: c.createdAt.toISOString(),
  };
}
