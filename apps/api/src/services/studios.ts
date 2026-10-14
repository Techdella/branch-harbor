import { and, asc, eq, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Tx } from '../db/client.ts';
import { classBookings, classOccurrences, customers, waitlistEntries } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { assertPaymentsEnabled, createPaymentForTarget } from './payments.ts';

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
}

export type BookResult =
  | { outcome: 'confirmed' | 'held'; bookingId: string; manageToken: string; holdExpiresAt: string | null; payment: { id: string; clientSecret: string | null; amount: number; currency: string; sandbox: boolean } | null }
  | { outcome: 'waitlisted'; waitlistEntryId: string; position: number };

/**
 * Book a class occurrence. Capacity is checked under a row lock on the occurrence, so concurrent
 * bookings cannot oversell. Paid classes get a time-limited hold until payment succeeds. A full
 * class offers the waitlist instead of a booking.
 */
export async function bookClass(s: Services, input: BookInput): Promise<BookResult> {
  const [occPeek] = await s.db.select().from(classOccurrences).where(and(eq(classOccurrences.id, input.occurrenceId), eq(classOccurrences.organizationId, input.organizationId)));
  if (!occPeek) throw notFound('Class');
  if (occPeek.priceMinor > 0) await assertPaymentsEnabled(s.db, input.organizationId, occPeek.locationId);

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
      const [w] = await tx.insert(waitlistEntries).values({ organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: input.customerId }).returning();
      const [pos] = await tx.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(eq(waitlistEntries.occurrenceId, occ.id), eq(waitlistEntries.status, 'waiting'), sql`${waitlistEntries.createdAt} <= (select created_at from waitlist_entries where id = ${w!.id})`));
      return { kind: 'waitlisted' as const, waitlistEntryId: w!.id, position: pos?.n ?? 1, occ };
    }

    const paid = occ.priceMinor > 0;
    const holdExpiresAt = paid ? new Date(Date.now() + s.cfg.BOOKING_HOLD_MINUTES * 60_000) : null;
    const [b] = await tx.insert(classBookings).values({
      organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: input.customerId,
      status: paid ? 'held' : 'confirmed', holdExpiresAt, source: input.source ?? 'web', manageTokenHash: sha256(manageToken), confirmedAt: paid ? null : new Date(),
    }).returning();
    await audit(tx, { organizationId: occ.organizationId, actorUserId: input.actorUserId ?? null, actorType: input.actorUserId ? 'user' : 'system', action: paid ? 'booking.held' : 'booking.confirmed', scopeKind: 'location', scopeId: occ.locationId, targetType: 'class_booking', targetId: b!.id });
    return { kind: 'booked' as const, booking: b!, occ };
  });

  if (res.kind === 'waitlisted') return { outcome: 'waitlisted', waitlistEntryId: res.waitlistEntryId, position: res.position };
  const { booking, occ } = res;
  if (booking.status === 'confirmed') return { outcome: 'confirmed', bookingId: booking.id, manageToken, holdExpiresAt: null, payment: null };
  try {
    const pay = await createPaymentForTarget(s, {
      organizationId: occ.organizationId, locationId: occ.locationId, amountMinor: occ.priceMinor, currency: occ.currency,
      targetType: 'class_booking', targetId: booking.id, description: `Class booking ${booking.id}`,
      recordSnapshot: { occurrenceId: occ.id, customerId: booking.customerId },
    });
    await s.db.update(classBookings).set({ paymentId: pay.payment.id }).where(eq(classBookings.id, booking.id));
    return { outcome: 'held', bookingId: booking.id, manageToken, holdExpiresAt: booking.holdExpiresAt!.toISOString(), payment: { id: pay.payment.id, clientSecret: pay.clientSecret, amount: occ.priceMinor, currency: occ.currency, sandbox: pay.sandbox } };
  } catch (err) {
    await s.db.update(classBookings).set({ status: 'expired' }).where(eq(classBookings.id, booking.id));
    throw err;
  }
}

/** Offer the freed seat to the next waiting customer: confirm free classes, hold paid ones. */
export async function promoteFromWaitlist(s: Services, tx: Tx, occurrenceId: string): Promise<{ entryId: string; bookingId: string; status: 'confirmed' | 'held'; manageToken: string; email: string | null } | null> {
  const [occ] = await tx.select().from(classOccurrences).where(eq(classOccurrences.id, occurrenceId)).for('update');
  if (!occ || occ.status !== 'scheduled' || occ.startsAt <= new Date()) return null;
  if ((await seatsInUse(tx, occ.id)) >= occ.capacity) return null;
  const [next] = await tx.select().from(waitlistEntries).where(and(eq(waitlistEntries.occurrenceId, occ.id), eq(waitlistEntries.status, 'waiting'))).orderBy(asc(waitlistEntries.createdAt)).limit(1).for('update', { skipLocked: true });
  if (!next) return null;
  const paid = occ.priceMinor > 0;
  const token = randomToken();
  const [b] = await tx.insert(classBookings).values({
    organizationId: occ.organizationId, locationId: occ.locationId, occurrenceId: occ.id, customerId: next.customerId,
    status: paid ? 'held' : 'confirmed', holdExpiresAt: paid ? new Date(Date.now() + s.cfg.BOOKING_HOLD_MINUTES * 4 * 60_000) : null,
    source: 'waitlist', manageTokenHash: sha256(token), confirmedAt: paid ? null : new Date(),
  }).returning();
  await tx.update(waitlistEntries).set({ status: paid ? 'offered' : 'promoted', offeredBookingId: b!.id }).where(eq(waitlistEntries.id, next.id));
  const [c] = await tx.select({ email: customers.email }).from(customers).where(eq(customers.id, next.customerId));
  await audit(tx, { organizationId: occ.organizationId, actorUserId: null, actorType: 'system', action: paid ? 'waitlist.offered' : 'waitlist.promoted', scopeKind: 'location', scopeId: occ.locationId, targetType: 'class_booking', targetId: b!.id });
  return { entryId: next.id, bookingId: b!.id, status: paid ? 'held' : 'confirmed', manageToken: token, email: c?.email ?? null };
}

export async function cancelBooking(s: Services, bookingId: string, opts: { actorUserId: string | null; organizationId?: string }) {
  const out = await s.db.transaction(async (tx) => {
    const [b] = await tx.select().from(classBookings).where(eq(classBookings.id, bookingId)).for('update');
    if (!b || (opts.organizationId && b.organizationId !== opts.organizationId)) throw notFound('Booking');
    if (!['held', 'confirmed'].includes(b.status)) throw conflict('booking_not_active', `Booking is already ${b.status}`);
    await tx.update(classBookings).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(classBookings.id, b.id));
    await audit(tx, { organizationId: b.organizationId, actorUserId: opts.actorUserId, action: 'booking.cancelled', scopeKind: 'location', scopeId: b.locationId, targetType: 'class_booking', targetId: b.id });
    const promoted = await promoteFromWaitlist(s, tx, b.occurrenceId);
    return { booking: b, promoted };
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
  return out;
}

/** Background sweep: expire stale holds and pass their seats on to the waitlist. */
export async function expireHolds(s: Services) {
  const expired = await s.db.update(classBookings).set({ status: 'expired' })
    .where(and(eq(classBookings.status, 'held'), sql`${classBookings.holdExpiresAt} <= now()`))
    .returning({ id: classBookings.id, occurrenceId: classBookings.occurrenceId });
  for (const e of expired) {
    await s.db.update(waitlistEntries).set({ status: 'expired' }).where(and(eq(waitlistEntries.offeredBookingId, e.id), eq(waitlistEntries.status, 'offered')));
    await s.db.transaction((tx) => promoteFromWaitlist(s, tx, e.occurrenceId));
  }
  return expired.length;
}
