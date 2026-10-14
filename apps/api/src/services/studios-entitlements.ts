import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import {
  classBookings, classOccurrences, classSeries, classTypes, locations, memberships, packs, studioFees, studioPackProducts, studioPolicies,
  type LocationAccessPolicy,
} from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';

type Occ = typeof classOccurrences.$inferSelect;
type Loc = typeof locations.$inferSelect;
type Pack = typeof packs.$inferSelect;
type Membership = typeof memberships.$inferSelect;

// ───────────── Policies ─────────────

export interface StudioPolicy {
  lateCancelMinutes: number;
  lateCancelFee: Record<string, number>;
  noShowFee: Record<string, number>;
  forfeitCreditOnLateCancel: boolean;
  refundPaidOnLateCancel: boolean;
  feesApplyToMembers: boolean;
  bookingWindowDays: number;
  /** location | organization | default */
  source: 'location' | 'organization' | 'default';
}

export const DEFAULT_POLICY: StudioPolicy = {
  lateCancelMinutes: 720, lateCancelFee: {}, noShowFee: {}, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: true, bookingWindowDays: 30, source: 'default',
};

/** The location's own policy, else the organisation default, else the built-in default. */
export async function effectivePolicy(db: Exec, organizationId: string, locationId: string): Promise<StudioPolicy> {
  const rows = await db.select().from(studioPolicies).where(and(eq(studioPolicies.organizationId, organizationId), or(eq(studioPolicies.locationId, locationId), isNull(studioPolicies.locationId))));
  const row = rows.find((r) => r.locationId === locationId) ?? rows.find((r) => r.locationId === null);
  if (!row) return DEFAULT_POLICY;
  return {
    lateCancelMinutes: row.lateCancelMinutes, lateCancelFee: row.lateCancelFee, noShowFee: row.noShowFee, forfeitCreditOnLateCancel: row.forfeitCreditOnLateCancel,
    refundPaidOnLateCancel: row.refundPaidOnLateCancel, feesApplyToMembers: row.feesApplyToMembers, bookingWindowDays: row.bookingWindowDays, source: row.locationId ? 'location' : 'organization',
  };
}

const fmtMoney = (amount: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount / 10 ** (new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2));
const fmtWindow = (m: number) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);

/** Plain-language policy shown to customers before they book. */
export function describePolicy(p: StudioPolicy, currency: string): { lines: string[]; lateCancelFee: { amount: number; currency: string } | null; noShowFee: { amount: number; currency: string } | null } {
  const late = p.lateCancelFee[currency];
  const noShow = p.noShowFee[currency];
  const lines = [
    `Cancel at least ${fmtWindow(p.lateCancelMinutes)} before the class starts to avoid a late cancellation.`,
    p.forfeitCreditOnLateCancel ? 'Late cancellations with a class pack use the credit.' : 'Class pack credits are returned even for late cancellations.',
    p.refundPaidOnLateCancel ? 'Single-class payments are refunded on late cancellation.' : 'Single-class payments are not refunded on late cancellation.',
    late ? `Late cancellation fee: ${fmtMoney(late, currency)}${p.feesApplyToMembers ? '' : ' (not charged to members)'}.` : 'No late cancellation fee.',
    noShow ? `No-show fee: ${fmtMoney(noShow, currency)}${p.feesApplyToMembers ? '' : ' (not charged to members)'}.` : 'No no-show fee.',
  ];
  return { lines, lateCancelFee: late ? { amount: late, currency } : null, noShowFee: noShow ? { amount: noShow, currency } : null };
}

// ───────────── Location access ─────────────

export function locationAccess(policy: LocationAccessPolicy | string, homeLocationId: string | null, allowed: string[], target: { id: string; currency: string }, homeCurrency: string | null): { ok: boolean; reason?: string } {
  switch (policy) {
    case 'any_location':
      return { ok: true };
    case 'same_currency':
      return homeCurrency === target.currency ? { ok: true } : { ok: false, reason: `Only valid at locations that charge in ${homeCurrency ?? 'the home currency'}` };
    case 'listed':
      return allowed.includes(target.id) || homeLocationId === target.id ? { ok: true } : { ok: false, reason: 'Not valid at this location' };
    case 'home_only':
    default:
      return !homeLocationId || homeLocationId === target.id ? { ok: true } : { ok: false, reason: 'Only valid at its home location' };
  }
}

// ───────────── Membership periods ─────────────

export function addMonthsUtc(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

/** The monthly allowance window (anchored on the membership start) containing `at`. */
export function periodContaining(m: Pick<Membership, 'startsAt' | 'currentPeriodStart'>, at: Date): { start: Date; end: Date } {
  const anchor = m.startsAt;
  let k = Math.max(0, (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth() - 1);
  while (addMonthsUtc(anchor, k + 1) <= at) k++;
  while (k > 0 && addMonthsUtc(anchor, k) > at) k--;
  return { start: addMonthsUtc(anchor, k), end: addMonthsUtc(anchor, k + 1) };
}

export async function membershipUsage(db: Exec, m: Membership, at: Date): Promise<{ used: number; limit: number | null; periodStart: Date; periodEnd: Date }> {
  const p = periodContaining(m, at);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(classBookings).innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId))
    .where(and(eq(classBookings.membershipId, m.id), sql`(${classBookings.status} in ('held','confirmed','attended','no_show') or (${classBookings.status} = 'cancelled' and ${classBookings.lateCancel}))`,
      sql`${classOccurrences.startsAt} >= ${p.start.toISOString()}`, sql`${classOccurrences.startsAt} < ${p.end.toISOString()}`));
  return { used: r?.n ?? 0, limit: m.classesPerPeriod, periodStart: p.start, periodEnd: p.end };
}

/** Derived display state (cancelling = notice period running). */
export function membershipState(m: Membership, now = new Date()): string {
  if (m.status === 'active' && m.pausedFrom && m.pausedUntil && m.pausedFrom <= now && now < m.pausedUntil) return 'paused';
  if (m.status === 'active' && m.cancelAt && m.cancelAt > now) return 'cancelling';
  if (m.status === 'active' && m.endsAt && m.endsAt <= now) return 'ended';
  return m.status;
}

// ───────────── Usability ─────────────

export interface CreditOption { id: string; name: string; creditsRemaining: number; creditsNeeded: number; expiresAt: string | null; usable: boolean; reason: string | null }
export interface MembershipOption { id: string; name: string; state: string; usable: boolean; reason: string | null; usage: { used: number; limit: number | null; periodEnd: string } | null }

interface SeriesFlags { allowCredits: boolean; allowMembership: boolean }

async function seriesFlags(db: Exec, occ: Occ): Promise<SeriesFlags> {
  if (!occ.seriesId) return { allowCredits: true, allowMembership: true };
  const [s] = await db.select({ allowCredits: classSeries.allowCredits, allowMembership: classSeries.allowMembership }).from(classSeries).where(eq(classSeries.id, occ.seriesId));
  return s ?? { allowCredits: true, allowMembership: true };
}

export async function creditCostOf(db: Exec, occ: Occ): Promise<number> {
  if (occ.creditCost !== null && occ.creditCost !== undefined) return occ.creditCost;
  const [t] = await db.select({ c: classTypes.creditCost }).from(classTypes).where(eq(classTypes.id, occ.classTypeId));
  return t?.c ?? 1;
}

async function homeCurrencies(db: Exec, ids: Array<string | null>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  return new Map((await db.select({ id: locations.id, currency: locations.currency }).from(locations).where(inArray(locations.id, list))).map((r) => [r.id, r.currency]));
}

export async function checkPack(db: Exec, p: Pack, occ: Occ, loc: Loc, cost: number, flags: SeriesFlags, homeCur: string | null, now = new Date()): Promise<string | null> {
  if (!flags.allowCredits) return 'This class cannot be booked with credits';
  if (p.status !== 'active') return p.status === 'exhausted' ? 'No credits left' : `Pack is ${p.status}`;
  if (p.expiresAt && p.expiresAt <= now) return 'Pack has expired';
  if (p.expiresAt && p.expiresAt <= occ.startsAt) return 'Pack expires before this class';
  if (p.creditsRemaining < cost) return `Needs ${cost} credit${cost === 1 ? '' : 's'}, ${p.creditsRemaining} left`;
  const acc = locationAccess(p.transferPolicy, p.locationId, p.allowedLocationIds ?? [], loc, homeCur);
  if (!acc.ok) return acc.reason ?? 'Not valid at this location';
  if (p.productId) {
    const [prod] = await db.select({ classTypeIds: studioPackProducts.classTypeIds }).from(studioPackProducts).where(eq(studioPackProducts.id, p.productId));
    if (prod?.classTypeIds?.length && !prod.classTypeIds.includes(occ.classTypeId)) return 'Not valid for this class type';
  }
  return null;
}

export async function checkMembership(db: Exec, m: Membership, occ: Occ, loc: Loc, flags: SeriesFlags, homeCur: string | null, now = new Date()): Promise<{ reason: string | null; usage: Awaited<ReturnType<typeof membershipUsage>> | null }> {
  if (!flags.allowMembership) return { reason: 'This class is not included in memberships', usage: null };
  if (m.status === 'pending') return { reason: 'Membership awaiting first payment', usage: null };
  if (m.status === 'suspended') return { reason: 'Membership suspended: a renewal payment failed', usage: null };
  if (m.status === 'cancelled') return { reason: 'Membership has ended', usage: null };
  if (m.status === 'grace' && m.graceUntil && m.graceUntil <= now) return { reason: 'Payment grace period has ended', usage: null };
  if (m.startsAt > occ.startsAt) return { reason: 'Membership starts after this class', usage: null };
  if (m.endsAt && m.endsAt <= occ.startsAt) return { reason: 'Membership ends before this class', usage: null };
  if (m.cancelAt && m.cancelAt <= occ.startsAt) return { reason: 'Membership ends (notice period) before this class', usage: null };
  if (m.pausedFrom && m.pausedUntil && m.pausedFrom <= occ.startsAt && occ.startsAt < m.pausedUntil) return { reason: 'Membership is paused on this date', usage: null };
  const acc = locationAccess(m.accessPolicy, m.locationId, m.allowedLocationIds ?? [], loc, homeCur);
  if (!acc.ok) return { reason: acc.reason ?? 'Not valid at this location', usage: null };
  const usage = await membershipUsage(db, m, occ.startsAt);
  if (usage.limit !== null && usage.used >= usage.limit) return { reason: `Monthly limit reached (${usage.used} of ${usage.limit})`, usage };
  return { reason: null, usage };
}

/** Every pack / membership the customer holds in this organisation, evaluated for one class. */
export async function entitlementOptions(db: Exec, customerId: string, occ: Occ, loc: Loc, now = new Date()) {
  const flags = await seriesFlags(db, occ);
  const cost = await creditCostOf(db, occ);
  const [ps, ms] = await Promise.all([
    db.select().from(packs).where(and(eq(packs.customerId, customerId), eq(packs.organizationId, occ.organizationId), inArray(packs.status, ['active', 'exhausted', 'expired']))).orderBy(asc(packs.expiresAt)),
    db.select().from(memberships).where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, occ.organizationId), inArray(memberships.status, ['active', 'grace', 'paused', 'suspended', 'pending']))),
  ]);
  const cur = await homeCurrencies(db, [...ps.map((p) => p.locationId), ...ms.map((m) => m.locationId)]);
  const credits: CreditOption[] = [];
  for (const p of ps) {
    if (p.status !== 'active' && (!p.expiresAt || p.expiresAt < new Date(now.getTime() - 30 * 86400_000))) continue;
    const reason = await checkPack(db, p, occ, loc, cost, flags, p.locationId ? cur.get(p.locationId) ?? null : null, now);
    credits.push({ id: p.id, name: p.name, creditsRemaining: p.creditsRemaining, creditsNeeded: cost, expiresAt: p.expiresAt?.toISOString() ?? null, usable: !reason, reason });
  }
  const mems: MembershipOption[] = [];
  for (const m of ms) {
    const r = await checkMembership(db, m, occ, loc, flags, m.locationId ? cur.get(m.locationId) ?? null : null, now);
    mems.push({ id: m.id, name: m.plan, state: membershipState(m, now), usable: !r.reason, reason: r.reason, usage: r.usage ? { used: r.usage.used, limit: r.usage.limit, periodEnd: r.usage.periodEnd.toISOString() } : null });
  }
  const [fee] = await db.select({ n: sql<number>`count(*)::int` }).from(studioFees).where(and(eq(studioFees.customerId, customerId), eq(studioFees.status, 'due')));
  return { creditCost: cost, flags, credits, memberships: mems, outstandingFees: fee?.n ?? 0 };
}

export type PayWith = { kind: 'pay' } | { kind: 'credit'; packId?: string } | { kind: 'membership'; membershipId?: string } | { kind: 'auto' } | { kind: 'comp' };

export interface Consumed { paymentMethod: 'pay_per_class' | 'credit' | 'membership' | 'free' | 'comp'; packId: string | null; membershipId: string | null; creditsUsed: number }

/**
 * Inside the booking transaction: validate (under row locks) and consume the chosen entitlement.
 * Packs are locked FOR UPDATE so concurrent bookings cannot spend the same credit twice; the
 * membership row is locked so the monthly limit cannot be exceeded concurrently.
 * Returns null for `auto` when nothing usable exists (caller falls back to pay-per-class).
 */
export async function consumeEntitlement(tx: Exec, payWith: PayWith, customerId: string, occ: Occ, loc: Loc, now = new Date()): Promise<Consumed | null> {
  if (payWith.kind === 'pay') return { paymentMethod: occ.priceMinor > 0 ? 'pay_per_class' : 'free', packId: null, membershipId: null, creditsUsed: 0 };
  if (payWith.kind === 'comp') return { paymentMethod: 'comp', packId: null, membershipId: null, creditsUsed: 0 };
  const flags = await seriesFlags(tx, occ);
  const cost = await creditCostOf(tx, occ);

  const tryMembership = async (id?: string): Promise<Consumed | string> => {
    const rows = await tx.select().from(memberships).where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, occ.organizationId), id ? eq(memberships.id, id) : inArray(memberships.status, ['active', 'grace', 'paused', 'suspended', 'pending']))).for('update');
    if (!rows.length) return 'No membership found';
    let last = 'No usable membership';
    const cur = await homeCurrencies(tx, rows.map((r) => r.locationId));
    for (const m of rows) {
      const r = await checkMembership(tx, m, occ, loc, flags, m.locationId ? cur.get(m.locationId) ?? null : null, now);
      if (!r.reason) return { paymentMethod: 'membership', packId: null, membershipId: m.id, creditsUsed: 0 };
      last = r.reason;
    }
    return last;
  };
  const tryPack = async (id?: string): Promise<Consumed | string> => {
    const rows = await tx.select().from(packs).where(and(eq(packs.customerId, customerId), eq(packs.organizationId, occ.organizationId), id ? eq(packs.id, id) : inArray(packs.status, ['active', 'exhausted', 'expired']))).orderBy(asc(packs.expiresAt)).for('update');
    if (!rows.length) return 'No class pack found';
    let last = 'No usable class pack';
    const cur = await homeCurrencies(tx, rows.map((r) => r.locationId));
    for (const p of rows) {
      const reason = await checkPack(tx, p, occ, loc, cost, flags, p.locationId ? cur.get(p.locationId) ?? null : null, now);
      if (reason) { last = reason; continue; }
      const remaining = p.creditsRemaining - cost;
      await tx.update(packs).set({ creditsRemaining: remaining, status: remaining === 0 ? 'exhausted' : 'active', updatedAt: new Date() }).where(eq(packs.id, p.id));
      return { paymentMethod: 'credit', packId: p.id, membershipId: null, creditsUsed: cost };
    }
    return last;
  };

  if (payWith.kind === 'membership') {
    const r = await tryMembership(payWith.membershipId);
    if (typeof r === 'string') throw new AppError(409, 'membership_not_usable', r);
    return r;
  }
  if (payWith.kind === 'credit') {
    const r = await tryPack(payWith.packId);
    if (typeof r === 'string') throw new AppError(409, r.includes('expired') || r.includes('expires') ? 'pack_expired' : 'credit_not_usable', r);
    return r;
  }
  // auto: membership first, then the pack that expires soonest.
  const m = await tryMembership();
  if (typeof m !== 'string') return m;
  const p = await tryPack();
  if (typeof p !== 'string') return p;
  return null;
}

/** Return credits to a pack (cancellation / class cancelled). */
export async function returnCredits(tx: Exec, packId: string, credits: number) {
  if (!credits) return;
  const [p] = await tx.select().from(packs).where(eq(packs.id, packId)).for('update');
  if (!p) return;
  const remaining = Math.min(p.creditsTotal, p.creditsRemaining + credits);
  const expired = p.expiresAt && p.expiresAt <= new Date();
  await tx.update(packs).set({ creditsRemaining: remaining, status: expired ? 'expired' : remaining > 0 && p.status === 'exhausted' ? 'active' : p.status, updatedAt: new Date() }).where(eq(packs.id, p.id));
}

/** Mark packs past their expiry date as expired (remaining credits are kept for the record but cannot be used). */
export async function expirePacks(db: Exec, now = new Date()) {
  const rows = await db.update(packs).set({ status: 'expired', updatedAt: now }).where(and(inArray(packs.status, ['active', 'exhausted']), sql`${packs.expiresAt} <= ${now.toISOString()}`)).returning({ id: packs.id });
  return rows.length;
}
