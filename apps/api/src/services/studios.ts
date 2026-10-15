import { and, asc, eq, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Tx } from '../db/client.ts';
import { classBookings, classOccurrences, customers, locations, studioFees, waitlistEntries } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { assertPaymentsEnabled, createPaymentForTarget } from './payments.ts';
import { notify, userIdsForCustomer } from './notifications.ts';
import { consumeEntitlement, effectivePolicy, returnCredits, type Consumed, type PayWith } from './studios-entitlements.ts';

/** Seats in use = confirmed bookings + holds that have not expired. */
export async function seatsInUse(tx: Tx, occurrenceId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(classBookings)
    .where(and(eq(classBookings.occurrenceId, occurrenceId), sql`(${classBookings.status} in ('confirmed','attended') or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} > now()))`));
  return r?.n ?? 0;
}

export interface BookInput {
  organizationId: string;
  occurrenceId: string;
  customerId: string;
  joinWaitlist?: boolean;
  source?: string;
  actorUserId?: string | null;
  /** How to pay. Guests (public contact bookings) can only pay per class; credits/memberships need an identified customer. */
  payWith?: PayWith;
}

export type BookResult =
  | { outcome: 'confirmed' | 'held'; bookingId: string; manageToken: string; holdExpiresAt: string | null; paymentMethod?: string; packId?: string | null; membershipId?: string | null; creditsUsed?: number; payment: { id: string; clientSecret: string | null; amount: number; currency: string; sandbox: boolean } | null }
  | { outcome: 'waitlisted'; waitlistEntryId: string; position: number; manageToken: string };

/**
 * Book a class occurrence. Capacity is checked under a row lock on the occurrence, so concurrent
 * bookings cannot oversell. Paid classes get a time-limited hold until payment succeeds. A full
 * class offers the waitlist instead of a booking.
 */
export async function bookClass(s: Services, input: BookInput): Promise<BookResult> {
  const [occPeek] = await s.db.select().from(classOccurrences).where(and(eq(classOccurrences.id, input.occurrenceId), eq(classOccurrences.organizationId, input.organizationId)));
  if (!occPeek) throw notFound('Class');
  const payWith: PayWith = input.payWith ?? { kind: 'pay' };
  if (occPeek.priceMinor > 0 && payWith.kind === 'pay') await assertPaymentsEnabled(s.db, input.organizationId, occPeek.locationId);
  const [locRow] = await s.db.select().from(locations).where(eq(locations.id, occPeek.locationId));
  const policy = await effectivePolicy(s.db, occPeek.organizationId, occPeek.locationId);
  if (occPeek.startsAt.getTime() > Date.now() + policy.bookingWindowDays * 86400_000) throw conflict('outside_booking_window', `Booking opens ${policy.bookingWindowDays} days before the class`, { days: policy.bookingWindowDays });

  const manageToken = randomToken();
  const res = await s.db.transaction(async (tx) => {
    const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, input.occurrenceId)).for('update');
    if (!occ) throw notFound('Class');
    if (occ.status !== 'scheduled') throw conflict('class_cancelled', 'This class has been cancelled');
    if (occ.startsAt <= new Date()) throw conflict('class_started', 'This class has already started');

    const [dupe] = await tx.select({ id: classBookings.id }).from(classBookings)
      .where(and(eq(classBookings.occurrenceId, occ.id), eq(classBookings.customerId, input.customerId), sql`${classBookings.status} in ('held','confirmed')`));
    if (dupe) throw conflict('duplicate_booking', 'You already have a booking for this class', { bookingId: dupe.id });

    const used = await seatsInUse(tx, occ.id);
    if (used >= occ.capacity) {
      if (!input.joinWaitlist) throw new AppError(409, 'class_full', 'This class is full. You can join the waitlist.', undefined, { waitlistAvailable: true, capacity: occ.capacity });
      const [existing] = await tx.select().from(waitlistEntries).where(and(eq(waitlistEntries.occurrenceId, occ.id), eq(waitlistEntries.customerId, input.customerId), sql`${waitlistEntries.status} in ('waiting','offered')`));
      if (existing) throw conflict('already_waitlisted', 'You are already on the waitlist for this class');
      const [w] = await tx.insert(waitlistEntries).values({ organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: input.customerId, manageTokenHash: sha256(manageToken) }).returning();
      const [pos] = await tx.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(eq(waitlistEntries.occurrenceId, occ.id), eq(waitlistEntries.status, 'waiting'), sql`${waitlistEntries.createdAt} <= (select created_at from waitlist_entries where id = ${w!.id})`));
      return { kind: 'waitlisted' as const, waitlistEntryId: w!.id, position: pos?.n ?? 1, occ };
    }

    // Credits / memberships are validated and consumed under row locks in this transaction.
    let consumed: Consumed | null = await consumeEntitlement(tx, payWith, input.customerId, occ, locRow!);
    if (!consumed) consumed = { paymentMethod: occ.priceMinor > 0 ? 'pay_per_class' : 'free', packId: null, membershipId: null, creditsUsed: 0 };
    if (consumed.paymentMethod === 'pay_per_class' && payWith.kind !== 'pay') await assertPaymentsEnabled(tx, occ.organizationId, occ.locationId);
    const paid = consumed.paymentMethod === 'pay_per_class';
    const holdExpiresAt = paid ? new Date(Date.now() + s.cfg.BOOKING_HOLD_MINUTES * 60_000) : null;
    const [b] = await tx.insert(classBookings).values({
      organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: input.customerId,
      status: paid ? 'held' : 'confirmed', holdExpiresAt, source: input.source ?? 'web', manageTokenHash: sha256(manageToken), confirmedAt: paid ? null : new Date(),
      paymentMethod: consumed.paymentMethod, packId: consumed.packId, membershipId: consumed.membershipId, creditsUsed: consumed.creditsUsed,
    }).returning();
    await audit(tx, { organizationId: occ.organizationId, actorUserId: input.actorUserId ?? null, actorType: input.actorUserId ? 'user' : 'system', action: paid ? 'booking.held' : 'booking.confirmed', scopeKind: 'location', scopeId: occ.locationId, targetType: 'class_booking', targetId: b!.id, metadata: { paymentMethod: consumed.paymentMethod, packId: consumed.packId, membershipId: consumed.membershipId, creditsUsed: consumed.creditsUsed } });
    return { kind: 'booked' as const, booking: b!, occ };
  });

  if (res.kind === 'waitlisted') return { outcome: 'waitlisted', waitlistEntryId: res.waitlistEntryId, position: res.position, manageToken };
  const { booking, occ } = res;
  const via = { paymentMethod: booking.paymentMethod, packId: booking.packId, membershipId: booking.membershipId, creditsUsed: booking.creditsUsed };
  if (booking.status === 'confirmed') return { outcome: 'confirmed', bookingId: booking.id, manageToken, holdExpiresAt: null, ...via, payment: null };
  try {
    const pay = await createPaymentForTarget(s, {
      organizationId: occ.organizationId, locationId: occ.locationId, amountMinor: occ.priceMinor, currency: occ.currency,
      targetType: 'class_booking', targetId: booking.id, description: `Class booking ${booking.id}`,
      recordSnapshot: { occurrenceId: occ.id, customerId: booking.customerId },
    });
    await s.db.update(classBookings).set({ paymentId: pay.payment.id }).where(eq(classBookings.id, booking.id));
    return { outcome: 'held', bookingId: booking.id, manageToken, holdExpiresAt: booking.holdExpiresAt!.toISOString(), ...via, payment: { id: pay.payment.id, clientSecret: pay.clientSecret, amount: occ.priceMinor, currency: occ.currency, sandbox: pay.sandbox } };
  } catch (err) {
    await s.db.update(classBookings).set({ status: 'expired' }).where(eq(classBookings.id, booking.id));
    throw err;
  }
}

/** Offer the freed seat to the next waiting customer: confirm free classes, hold paid ones. */
export async function promoteFromWaitlist(s: Services, tx: Tx, occurrenceId: string): Promise<{ entryId: string; bookingId: string; status: 'confirmed' | 'held'; manageToken: string; email: string | null; customerId: string; organizationId: string } | null> {
  const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, occurrenceId)).for('update');
  if (!occ || occ.status !== 'scheduled' || occ.startsAt <= new Date()) return null;
  if ((await seatsInUse(tx, occ.id)) >= occ.capacity) return null;
  const [next] = await tx.select().from(waitlistEntries).where(and(eq(waitlistEntries.occurrenceId, occ.id), eq(waitlistEntries.status, 'waiting'))).orderBy(asc(waitlistEntries.createdAt)).limit(1).for('update', { skipLocked: true });
  if (!next) return null;
  // A waiting member / pack holder is confirmed with their entitlement; everyone else pays (paid classes) or is confirmed (free).
  const [locRow] = await tx.select().from(locations).where(eq(locations.id, occ.locationId));
  const ent = occ.priceMinor > 0 ? await tx.transaction((sp) => consumeEntitlement(sp, { kind: 'auto' }, next.customerId, occ, locRow!)).catch(() => null) : null;
  const paid = occ.priceMinor > 0 && !ent;
  const token = randomToken();
  const [b] = await tx.insert(classBookings).values({
    organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: next.customerId,
    status: paid ? 'held' : 'confirmed', holdExpiresAt: paid ? new Date(Date.now() + s.cfg.BOOKING_HOLD_MINUTES * 4 * 60_000) : null,
    source: 'waitlist', manageTokenHash: sha256(token), confirmedAt: paid ? null : new Date(),
    paymentMethod: ent?.paymentMethod ?? (paid ? 'pay_per_class' : 'free'), packId: ent?.packId ?? null, membershipId: ent?.membershipId ?? null, creditsUsed: ent?.creditsUsed ?? 0,
  }).returning();
  await tx.update(waitlistEntries).set({ status: paid ? 'offered' : 'promoted', offeredBookingId: b!.id }).where(eq(waitlistEntries.id, next.id));
  const [c] = await tx.select({ email: customers.email }).from(customers).where(eq(customers.id, next.customerId));
  await audit(tx, { organizationId: occ.organizationId, actorUserId: null, actorType: 'system', action: paid ? 'waitlist.offered' : 'waitlist.promoted', scopeKind: 'location', scopeId: occ.locationId, targetType: 'class_booking', targetId: b!.id });
  return { entryId: next.id, bookingId: b!.id, status: paid ? 'held' : 'confirmed', manageToken: token, email: c?.email ?? null, customerId: next.customerId, organizationId: occ.organizationId };
}

export interface CancelOptions {
  actorUserId: string | null;
  organizationId?: string;
  /** Staff cancellation on the customer's behalf without penalties (credits returned, no fee). */
  waivePolicy?: boolean;
}

/**
 * Cancel a booking and apply the location's late-cancellation policy: credits are returned unless a late
 * cancellation forfeits them, a late-cancel fee is recorded when configured, and `refundEligible` says
 * whether the caller should reverse a pay-per-class payment.
 */
export async function cancelBooking(s: Services, bookingId: string, opts: CancelOptions) {
  const out = await s.db.transaction(async (tx) => {
    const [b] = await tx.select().from(classBookings).where(eq(classBookings.id, bookingId)).for('update');
    if (!b || (opts.organizationId && b.organizationId !== opts.organizationId)) throw notFound('Booking');
    if (!['held', 'confirmed'].includes(b.status)) throw conflict('booking_not_active', `Booking is already ${b.status}`);
    const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, b.occurrenceId));
    const policy = await effectivePolicy(tx, b.organizationId, b.locationId);
    const late = !opts.waivePolicy && b.status === 'confirmed' && !!occ && occ.startsAt.getTime() - Date.now() < policy.lateCancelMinutes * 60_000;
    const creditReturned = b.packId && b.creditsUsed > 0 ? !(late && policy.forfeitCreditOnLateCancel) : null;
    if (b.packId && creditReturned) await returnCredits(tx, b.packId, b.creditsUsed);
    await tx.update(classBookings).set({ status: 'cancelled', cancelledAt: new Date(), lateCancel: late, creditReturned }).where(eq(classBookings.id, b.id));
    let fee: typeof studioFees.$inferSelect | null = null;
    const feeAmount = occ ? policy.lateCancelFee[occ.currency] : undefined;
    const member = b.paymentMethod === 'membership' || b.paymentMethod === 'credit';
    if (late && feeAmount && b.paymentMethod !== 'comp' && (policy.feesApplyToMembers || !member)) {
      const [f] = await tx.insert(studioFees).values({ organizationId: b.organizationId, locationId: b.locationId, customerId: b.customerId, bookingId: b.id, kind: 'late_cancel', amountMinor: feeAmount, currency: occ!.currency }).onConflictDoNothing().returning();
      fee = f ?? null;
    }
    await audit(tx, { organizationId: b.organizationId, actorUserId: opts.actorUserId, action: late ? 'booking.cancelled_late' : 'booking.cancelled', scopeKind: 'location', scopeId: b.locationId, targetType: 'class_booking', targetId: b.id, metadata: { creditReturned, fee: fee ? { amount: fee.amountMinor, currency: fee.currency } : null, waivePolicy: !!opts.waivePolicy } });
    const promoted = await promoteFromWaitlist(s, tx, b.occurrenceId);
    const refundEligible = b.status === 'confirmed' && b.paymentMethod === 'pay_per_class' && (!late || policy.refundPaidOnLateCancel);
    return { booking: b, promoted, lateCancel: late, creditReturned, refundEligible, fee };
  });
  if (out.promoted?.email) {
    await s.jobs.enqueue('email.send', {
      to: out.promoted.email,
      subject: out.promoted.status === 'confirmed' ? 'A spot opened up — you are booked' : 'A spot opened up — confirm your booking',
      text: out.promoted.status === 'confirmed'
        ? 'Good news: a spot opened in your class and you are now booked.'
        : `A spot opened in your class. It is held for you for a limited time. Complete payment here: ${s.cfg.WEB_URL}/bookings/${out.promoted.bookingId}?token=${out.promoted.manageToken}`,
      tag: 'waitlist',
    });
  }
  if (out.promoted) await notifyWaitlistPromotion(s, out.promoted);
  return out;
}

/** Record attendance; a no-show applies the no-show fee policy (idempotent per booking). */
export async function recordAttendance(s: Services, bookingId: string, status: 'attended' | 'no_show', opts: { actorUserId: string; source: 'desk' | 'instructor' | 'self' }) {
  return s.db.transaction(async (tx) => {
    const [b] = await tx.select().from(classBookings).where(eq(classBookings.id, bookingId)).for('update');
    if (!b) throw notFound('Booking');
    if (!['confirmed', 'attended', 'no_show'].includes(b.status)) throw conflict('booking_not_confirmed', `Booking is ${b.status}`);
    const [u] = await tx.update(classBookings).set({
      status, checkedInAt: status === 'attended' ? b.checkedInAt ?? new Date() : null, checkedInBy: status === 'attended' ? opts.actorUserId : null, checkInSource: status === 'attended' ? opts.source : null,
    }).where(eq(classBookings.id, b.id)).returning();
    let fee: typeof studioFees.$inferSelect | null = null;
    if (status === 'no_show') {
      const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, b.occurrenceId));
      const policy = await effectivePolicy(tx, b.organizationId, b.locationId);
      const amount = occ ? policy.noShowFee[occ.currency] : undefined;
      const member = b.paymentMethod === 'membership' || b.paymentMethod === 'credit';
      if (amount && b.paymentMethod !== 'comp' && (policy.feesApplyToMembers || !member)) {
        const [f] = await tx.insert(studioFees).values({ organizationId: b.organizationId, locationId: b.locationId, customerId: b.customerId, bookingId: b.id, kind: 'no_show', amountMinor: amount, currency: occ!.currency }).onConflictDoNothing().returning();
        fee = f ?? null;
        if (!f) [fee = null] = await tx.select().from(studioFees).where(and(eq(studioFees.bookingId, b.id), eq(studioFees.kind, 'no_show')));
        if (fee && fee.status === 'waived' && fee.waiveReason === 'Marked as attended') {
          [fee = null] = await tx.update(studioFees).set({ status: 'due', waivedBy: null, waiveReason: null, updatedAt: new Date() }).where(eq(studioFees.id, fee.id)).returning();
        }
      }
    } else {
      // Marked attended after a no-show by mistake: an unpaid no-show fee no longer applies.
      await tx.update(studioFees).set({ status: 'waived', waiveReason: 'Marked as attended', waivedBy: opts.actorUserId, updatedAt: new Date() }).where(and(eq(studioFees.bookingId, b.id), eq(studioFees.kind, 'no_show'), eq(studioFees.status, 'due')));
    }
    await audit(tx, { organizationId: b.organizationId, actorUserId: opts.actorUserId, action: `booking.${status}`, scopeKind: 'location', scopeId: b.locationId, targetType: 'class_booking', targetId: b.id, metadata: { source: opts.source, fee: fee ? fee.amountMinor : null } });
    return { booking: u!, fee };
  });
}

/** Push to the promoted customer's devices (if they have an account with push enabled). */
export async function notifyWaitlistPromotion(s: Services, p: { bookingId: string; status: 'confirmed' | 'held'; customerId: string; organizationId: string }) {
  await notify(s, {
    userIds: await userIdsForCustomer(s.db, p.customerId), organizationId: p.organizationId, category: 'waitlist_promotion',
    title: p.status === 'confirmed' ? 'You’re in! A spot opened up' : 'A spot opened up — confirm your booking',
    body: p.status === 'confirmed' ? 'You were moved off the waitlist and are now booked.' : 'A spot is held for you for a limited time. Complete payment to confirm it.',
    data: { bookingId: p.bookingId, status: p.status, url: 'branchharbor://customer/bookings' },
  });
}

/** Background sweep: expire stale holds and pass their seats on to the waitlist. */
export async function expireHolds(s: Services) {
  const expired = await s.db.update(classBookings).set({ status: 'expired' })
    .where(and(eq(classBookings.status, 'held'), sql`${classBookings.holdExpiresAt} <= now()`))
    .returning({ id: classBookings.id, occurrenceId: classBookings.occurrenceId });
  for (const e of expired) {
    await s.db.update(waitlistEntries).set({ status: 'expired' }).where(and(eq(waitlistEntries.offeredBookingId, e.id), eq(waitlistEntries.status, 'offered')));
    const promoted = await s.db.transaction((tx) => promoteFromWaitlist(s, tx, e.occurrenceId));
    if (promoted) await notifyWaitlistPromotion(s, promoted);
  }
  return expired.length;
}

/**
 * Leave a waitlist. Only places still waiting (or offered but unpaid) can be left; an offered hold is
 * released and passed on to the next waiting customer.
 */
export async function leaveWaitlist(s: Services, entryId: string, opts: { actorUserId: string | null }) {
  const out = await s.db.transaction(async (tx) => {
    const [w] = await tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId)).for('update');
    if (!w) throw notFound('Waitlist place');
    if (!['waiting', 'offered'].includes(w.status)) throw conflict('waitlist_not_active', w.status === 'left' ? 'You already left this waitlist' : `This waitlist place is ${w.status}`);
    await tx.update(waitlistEntries).set({ status: 'left', leftAt: new Date() }).where(eq(waitlistEntries.id, w.id));
    let promoted = null;
    if (w.status === 'offered' && w.offeredBookingId) {
      await tx.update(classBookings).set({ status: 'cancelled', cancelledAt: new Date() }).where(and(eq(classBookings.id, w.offeredBookingId), eq(classBookings.status, 'held')));
      promoted = await promoteFromWaitlist(s, tx, w.occurrenceId);
    }
    await audit(tx, { organizationId: w.organizationId, actorUserId: opts.actorUserId, actorType: opts.actorUserId ? 'user' : 'system', action: 'waitlist.left', scopeKind: 'location', scopeId: w.locationId, targetType: 'waitlist_entry', targetId: w.id });
    return { entry: { ...w, status: 'left' }, promoted };
  });
  if (out.promoted) await notifyWaitlistPromotion(s, out.promoted);
  return out.entry;
}
