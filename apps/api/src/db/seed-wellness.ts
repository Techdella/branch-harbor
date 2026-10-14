/**
 * Harbourline Wellness — full product demo data (administrative records only; no clinical data):
 * variants priced per location (CAD/EUR/AUD), policies and deposits, couples and hot-stone services with rooms and
 * equipment, a practitioner linked to a staff login, leave with affected appointments, five weeks of history for
 * reports, upcoming bookings made through the booking engine, packages (active/shared/expired), gift vouchers,
 * notes (incl. confidential), preferences, consent, waitlist, a weekly series and reminder settings.
 *
 * Called from seed.ts after seed-operations created the organisation. Idempotent: the organisation is recreated
 * on every seed run and everything here hangs off it.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { reserveAppointment } from '../services/wellness.ts';
import { createSeries } from '../services/wellness-ops.ts';

type Loc = typeof t.locations.$inferSelect;
type User = typeof t.users.$inferSelect;
const DAY = 86400_000;
const round500 = (n: number) => Math.round(n / 500) * 500;
const CUR: Record<string, 'CAD' | 'EUR' | 'AUD'> = { 'HW-TOR': 'CAD', 'HW-DUB': 'EUR', 'HW-MEL': 'AUD' };
const VOUCHER_PREFIX: Record<string, string> = { 'HW-TOR': 'YORK', 'HW-DUB': 'DUBL', 'HW-MEL': 'FITZ' };

export async function seedWellness(c: { db: Db; today: string; orgId: string; demo: User; upsertUser: (email: string, name: string, locale?: string) => Promise<User> }) {
  const { db, today, orgId } = c;
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const byCode = (code: string) => locs.find((l) => l.code === code)!;
  const tor = byCode('HW-TOR');
  const dub = byCode('HW-DUB');
  const aiko = await c.upsertUser('aiko.tanaka@demo.branchharbor.com', 'Aiko Tanaka');
  const [niamh] = await db.select().from(t.users).where(eq(t.users.email, 'niamh.byrne@demo.branchharbor.com'));
  await db.insert(t.roleAssignments).values({ organizationId: orgId, userId: aiko.id, role: 'staff', scopeKind: 'location', scopeId: tor.id }).onConflictDoNothing();

  const policy = { freeCancelHours: 24, lateCancelFeePercent: 50, noShowFeePercent: 100, depositRefundable: true };
  const policyText = 'Free cancellation or changes up to 24 hours before your appointment. Later cancellations are charged 50% of the price and missed appointments 100%; any deposit is used towards that charge.';
  let seq = 0;
  const token = () => sha256(`seed-wellness-${seq++}-${randomBytes(4).toString('hex')}`);
  const at = (l: Loc, date: string, hhmm: string) => zonedToUtc(date, hhmm, l.timeZone);

  for (const l of locs) {
    const cur = CUR[l.code]!;
    const svcs = await db.select().from(t.services).where(eq(t.services.locationId, l.id));
    const massage = svcs.find((s) => s.name === 'Restorative massage')!;
    const reflex = svcs.find((s) => s.name === 'Reflexology')!;
    const breath = svcs.find((s) => s.name.startsWith('Guided breathwork'))!;
    await db.update(t.services).set({ category: 'Massage', policy, cancellationPolicy: policyText, depositRule: { kind: 'percent', value: 20 }, rebookAfterWeeks: 6, description: 'Slow, full-body massage with warm oils in a private treatment room. Choose 60 or 90 minutes.' }).where(eq(t.services.id, massage.id));
    await db.update(t.services).set({ category: 'Massage', policy, cancellationPolicy: policyText, rebookAfterWeeks: 8, description: 'Focused pressure work on the feet in a reclining chair. Comfortable clothing is fine.' }).where(eq(t.services.id, reflex.id));
    await db.update(t.services).set({ category: 'Breathwork', policy: { ...policy, freeCancelHours: 12 }, cancellationPolicy: 'Free cancellation up to 12 hours before. Later cancellations are charged 50%.', rebookAfterWeeks: 4, description: 'A guided one-to-one breathing session, seated or lying down. Nothing to bring.' }).where(eq(t.services.id, breath.id));

    // Variants priced in the location currency.
    const [v60, v90] = await db.insert(t.wellnessServiceVariants).values([
      { organizationId: orgId, serviceId: massage.id, name: '60 min', durationMinutes: 60, sortOrder: 1 },
      { organizationId: orgId, serviceId: massage.id, name: '90 min', durationMinutes: 90, bufferAfterMinutes: 20, sortOrder: 2 },
    ]).returning();
    const [b30, b50] = await db.insert(t.wellnessServiceVariants).values([
      { organizationId: orgId, serviceId: breath.id, name: '30 min', durationMinutes: 30, sortOrder: 1 },
      { organizationId: orgId, serviceId: breath.id, name: '50 min', durationMinutes: 50, bufferAfterMinutes: 10, sortOrder: 2 },
    ]).returning();
    await db.insert(t.wellnessVariantPrices).values([
      { organizationId: orgId, variantId: v60!.id, locationId: l.id, priceMinor: massage.priceMinor, currency: cur },
      { organizationId: orgId, variantId: v90!.id, locationId: l.id, priceMinor: round500(massage.priceMinor * 1.4), currency: cur },
      { organizationId: orgId, variantId: b30!.id, locationId: l.id, priceMinor: breath.priceMinor, currency: cur },
      { organizationId: orgId, variantId: b50!.id, locationId: l.id, priceMinor: round500(breath.priceMinor * 1.6), currency: cur },
    ]);

    // Couples suite + equipment, couples and hot-stone services.
    await db.insert(t.resources).values([{ organizationId: orgId, locationId: l.id, name: 'Couples suite', type: 'room' }, { organizationId: orgId, locationId: l.id, name: 'Hot stone kit A', type: 'stone_kit' }]);
    const couplePrice = { CAD: 10500, EUR: 8000, AUD: 12500 }[cur];
    const stonePrice = { CAD: 13500, EUR: 10500, AUD: 15500 }[cur];
    const [duo, stone] = await db.insert(t.services).values([
      { organizationId: orgId, locationId: l.id, name: 'Side-by-side massage', category: 'Massage', description: 'Two guests, two practitioners, one shared suite. Price is per guest.', durationMinutes: 60, bufferAfterMinutes: 15, priceMinor: couplePrice, currency: cur, requiredResourceType: 'room', practitionersRequired: 2, depositRule: { kind: 'percent', value: 25 }, policy: { ...policy, freeCancelHours: 48 }, cancellationPolicy: 'Free cancellation up to 48 hours before. Later cancellations are charged 50% per guest.', rebookAfterWeeks: 12 },
      { organizationId: orgId, locationId: l.id, name: 'Hot stone massage', category: 'Massage', description: 'Massage using smooth, heated basalt stones. Allow a few extra minutes to settle in.', durationMinutes: 75, bufferBeforeMinutes: 10, bufferAfterMinutes: 20, priceMinor: stonePrice, currency: cur, requiredResourceType: 'room', equipmentTypes: ['stone_kit'], depositRule: { kind: 'fixed', value: round500(stonePrice * 0.2) }, policy, cancellationPolicy: policyText, rebookAfterWeeks: 8 },
    ]).returning();

    // A third practitioner per location (Toronto's is linked to a staff login for the mobile/staff demo).
    const third = { 'HW-TOR': 'Aiko Tanaka', 'HW-DUB': 'Róisín Kelly', 'HW-MEL': 'Mia Russo' }[l.code]!;
    await db.insert(t.practitioners).values({ organizationId: orgId, locationId: l.id, userId: l.code === 'HW-TOR' ? aiko.id : null, name: third, serviceIds: [], availability: [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '10:00', end: '18:00' })) });
    const pracs = await db.select().from(t.practitioners).where(eq(t.practitioners.locationId, l.id));
    for (const p of pracs) await db.update(t.practitioners).set({ serviceIds: [...new Set([...p.serviceIds, duo!.id, stone!.id, ...(p.name === third ? [massage.id, breath.id] : [])])] }).where(eq(t.practitioners.id, p.id));
    await db.insert(t.wellnessLocationSettings).values({ organizationId: orgId, locationId: l.id, reminderHoursBefore: l.code === 'HW-MEL' ? 48 : 24, smsReminders: true, emailReminders: true, rebookPrompts: true });

    // More clients + consent (administrative only).
    const extra = await db.insert(t.customers).values(['Ines Duarte', 'Tom Gallagher', 'Sofia Rossi'].map((n) => ({ organizationId: orgId, locationId: l.id, name: n, email: `${n.toLowerCase().replace(/[^a-z]+/g, '.')}+${l.code.toLowerCase()}@example.com`, phone: '+15555550' + (100 + seq++) }))).returning();
    const clients = [...(await db.select().from(t.customers).where(and(eq(t.customers.organizationId, orgId), like(t.customers.email, `%+${l.code.toLowerCase()}@example.com`))))];
    await db.insert(t.consentRecords).values([
      { organizationId: orgId, customerId: clients[0]!.id, email: clients[0]!.email, purpose: 'appointment_reminders_sms', version: '2026-10', granted: true, source: 'booking' },
      { organizationId: orgId, customerId: clients[0]!.id, email: clients[0]!.email, purpose: 'marketing_email', version: '2026-10', granted: true, source: 'booking' },
      { organizationId: orgId, customerId: clients[1]!.id, email: clients[1]!.email, purpose: 'marketing_email', version: '2026-10', granted: true, source: 'booking' },
      { organizationId: orgId, customerId: clients[2]!.id, email: clients[2]!.email, purpose: 'appointment_reminders_email', version: '2026-10', granted: false, source: 'profile' },
      { organizationId: orgId, customerId: extra[0]!.id, email: extra[0]!.email, purpose: 'appointment_reminders_sms', version: '2026-10', granted: true, source: 'booking' },
    ]);

    // Five weeks of history for reports: completed, no-shows, late and free cancellations.
    const rooms = (await db.select().from(t.resources).where(and(eq(t.resources.locationId, l.id), eq(t.resources.type, 'room'))));
    const history: Array<typeof t.appointments.$inferInsert> = [];
    for (let d = 35; d >= 1; d--) {
      const date = addDays(today, -d);
      const wd = weekdayOf(date);
      if (wd === 0) continue;
      const plan = [{ p: 0, svc: massage, v: v60!, time: '10:00' }, { p: 1, svc: reflex, v: null, time: '13:00' }, { p: 2, svc: breath, v: b30!, time: '15:00' }, { p: 0, svc: massage, v: v90!, time: '12:00' }];
      for (const [k, x] of plan.entries()) {
        if ((d + k) % 3 === 0 && k > 1) continue;
        const dur = x.v?.durationMinutes ?? x.svc.durationMinutes;
        const startsAt = at(l, date, x.time);
        const endsAt = new Date(startsAt.getTime() + dur * 60_000);
        const roll = (d * 7 + k * 3) % 23;
        const status = roll === 0 ? 'no_show' : roll === 5 || roll === 11 ? 'cancelled' : 'completed';
        const price = x.v === v90 ? round500(massage.priceMinor * 1.4) : x.svc.priceMinor;
        history.push({
          organizationId: orgId, locationId: l.id, serviceId: x.svc.id, variantId: x.v?.id ?? null, practitionerId: pracs[x.p % pracs.length]!.id, resourceId: x.svc.requiredResourceType ? rooms[k % rooms.length]!.id : null,
          customerId: clients[(d + k) % clients.length]!.id, startsAt, endsAt, blockedFrom: startsAt, blockedUntil: new Date(endsAt.getTime() + x.svc.bufferAfterMinutes * 60_000),
          status, cancellationKind: status === 'no_show' ? 'no_show' : status === 'cancelled' ? (roll === 5 ? 'late' : 'free') : null, cancelledAt: status === 'completed' ? null : new Date(startsAt.getTime() - (roll === 5 ? 3 : 72) * 3600_000),
          checkedInAt: status === 'completed' ? new Date(startsAt.getTime() - 5 * 60_000) : null, priceMinor: price, currency: cur, source: k % 2 ? 'web' : 'staff', manageTokenHash: token(),
        });
      }
    }
    const past = await db.insert(t.appointments).values(history).returning();
    for (const a of past.filter((x) => x.cancellationKind === 'late' || x.status === 'no_show')) {
      const fee = Math.round((a.priceMinor * (a.status === 'no_show' ? 100 : 50)) / 100);
      await db.insert(t.wellnessAppointmentCharges).values({ organizationId: orgId, locationId: l.id, appointmentId: a.id, kind: a.status === 'no_show' ? 'no_show' : 'late_cancel', feeMinor: fee, currency: cur, outstandingMinor: fee, status: 'outstanding', createdAt: a.cancelledAt ?? a.startsAt });
    }

    // Upcoming bookings through the engine (practitioner + room + equipment secured together).
    const upcoming: Array<{ d: number; time: string; svc: typeof massage; variantId?: string; customer: number; partner?: number }> = [
      { d: 1, time: '16:00', svc: massage, variantId: v90!.id, customer: 5 }, { d: 2, time: '11:00', svc: stone!, customer: 6 }, { d: 3, time: '17:00', svc: duo!, customer: 7, partner: 0 },
      { d: 4, time: '15:30', svc: breath, variantId: b50!.id, customer: 1 }, { d: 5, time: '10:30', svc: massage, variantId: v60!.id, customer: 2 }, { d: 6, time: '14:00', svc: stone!, customer: 3 },
      { d: 8, time: '12:00', svc: massage, variantId: v90!.id, customer: 4 }, { d: 9, time: '16:30', svc: duo!, customer: 5, partner: 6 },
    ];
    const booked: Array<typeof t.appointments.$inferSelect> = [];
    for (const u of upcoming) {
      const date = addDays(today, u.d);
      try {
        const r = await db.transaction((tx) => reserveAppointment(tx, { organizationId: orgId, locationId: l.id, serviceId: u.svc.id, variantId: u.variantId, customerId: clients[u.customer % clients.length]!.id, partnerCustomerId: u.partner !== undefined ? clients[u.partner]!.id : null, startsAt: at(l, date, u.time), source: u.d % 2 ? 'web' : 'staff', enforceAvailability: false }));
        booked.push(...r.appointments);
        if (r.appointment.depositMinor > 0 && u.d % 2 === 1) {
          const amount = r.appointments.reduce((s, a) => s + a.depositMinor, 0);
          const [p] = await db.insert(t.paymentReferences).values({ organizationId: orgId, locationId: l.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: l.stripeAccountId, amountMinor: amount, currency: cur, state: 'succeeded', succeededAt: new Date(), targetType: 'appointment', targetId: r.appointment.id, sandbox: 1 }).returning();
          await db.update(t.appointments).set({ paymentId: p!.id, depositMinor: amount }).where(eq(t.appointments.id, r.appointment.id));
          if (r.appointments.length > 1) await db.update(t.appointments).set({ depositMinor: 0 }).where(inArray(t.appointments.id, r.appointments.slice(1).map((a) => a.id)));
        }
      } catch { /* slot taken by the base seed: skip */ }
    }

    // Today (for the staff/mobile demo): the third practitioner has two appointments later today and one already started.
    const thirdPrac = (await db.select().from(t.practitioners).where(and(eq(t.practitioners.locationId, l.id), eq(t.practitioners.name, third))))[0]!;
    for (const [i, h] of [1.5, 3.5].entries()) {
      const s = new Date(Date.now() + h * 3600_000);
      s.setUTCMinutes(s.getUTCMinutes() < 30 ? 30 : 60, 0, 0);
      try {
        await db.transaction((tx) => reserveAppointment(tx, { organizationId: orgId, locationId: l.id, serviceId: i ? breath.id : massage.id, variantId: i ? b30!.id : v60!.id, practitionerId: thirdPrac.id, customerId: clients[(i + 2) % clients.length]!.id, startsAt: s, source: 'staff', enforceAvailability: false }));
      } catch { /* busy */ }
    }
    {
      const s = new Date(Date.now() - 20 * 60_000);
      const e = new Date(s.getTime() + 60 * 60_000);
      await db.insert(t.appointments).values({ organizationId: orgId, locationId: l.id, serviceId: reflex.id, practitionerId: thirdPrac.id, customerId: clients[1]!.id, startsAt: s, endsAt: e, blockedFrom: s, blockedUntil: new Date(e.getTime() + 10 * 60_000), status: 'confirmed', priceMinor: reflex.priceMinor, currency: cur, source: 'staff', manageTokenHash: token() }).catch(() => undefined);
    }

    // Leave: Toronto's second practitioner is off on day +3 (affects a seeded appointment → rebook demo).
    if (l.code === 'HW-TOR') {
      const daniel = pracs.find((p) => p.name === 'Daniel Moreau')!;
      const date = addDays(today, 3);
      await db.insert(t.wellnessAvailabilityExceptions).values({ organizationId: orgId, practitionerId: daniel.id, startsAt: at(l, date, '00:00'), endsAt: at(l, addDays(date, 1), '00:00'), kind: 'leave', reason: 'Annual leave', createdBy: c.demo.id });
    }
    if (l.code === 'HW-DUB') {
      const cian = pracs.find((p) => p.name === 'Cian Walsh')!;
      const date = addDays(today, 6);
      await db.insert(t.wellnessAvailabilityExceptions).values({ organizationId: orgId, practitionerId: cian.id, locationId: l.id, startsAt: at(l, date, '12:00'), endsAt: at(l, date, '16:00'), kind: 'training', reason: 'Team training', createdBy: niamh?.id ?? c.demo.id });
    }

    // Packages: plans, active / shared / expired client packages.
    const [p5, p3] = await db.insert(t.wellnessPackagePlans).values([
      { organizationId: orgId, locationId: l.id, name: '5 × Restorative massage (60 min)', description: 'Five 60-minute sessions, valid 6 months. Personal to the buyer.', serviceId: massage.id, variantId: v60!.id, sessions: 5, priceMinor: round500(massage.priceMinor * 5 * 0.9), currency: cur, validityDays: 180 },
      { organizationId: orgId, locationId: l.id, name: '3 × Guided breathwork', description: 'Three sessions to share with one other person, valid 4 months.', serviceId: breath.id, sessions: 3, priceMinor: round500(breath.priceMinor * 3 * 0.9), currency: cur, validityDays: 120, sharing: 'shareable', maxSharedWith: 1 },
    ]).returning();
    const now = Date.now();
    const pkgRows = await db.insert(t.wellnessClientPackages).values([
      { organizationId: orgId, locationId: l.id, planId: p5!.id, customerId: clients[0]!.id, sessionsTotal: 5, sessionsUsed: 2, priceMinor: p5!.priceMinor, currency: cur, purchasedAt: new Date(now - 40 * DAY), expiresAt: new Date(now + 140 * DAY), status: 'active', paidVia: 'in_person', manageTokenHash: token() },
      { organizationId: orgId, locationId: l.id, planId: p3!.id, customerId: clients[1]!.id, sessionsTotal: 3, sessionsUsed: 1, priceMinor: p3!.priceMinor, currency: cur, purchasedAt: new Date(now - 20 * DAY), expiresAt: new Date(now + 9 * DAY), status: 'active', paidVia: 'in_person', sharedWithCustomerIds: [clients[2]!.id], manageTokenHash: token() },
      { organizationId: orgId, locationId: l.id, planId: p5!.id, customerId: clients[3]!.id, sessionsTotal: 5, sessionsUsed: 3, priceMinor: p5!.priceMinor, currency: cur, purchasedAt: new Date(now - 200 * DAY), expiresAt: new Date(now - 20 * DAY), status: 'expired', paidVia: 'in_person', manageTokenHash: token() },
      { organizationId: orgId, locationId: l.id, planId: p5!.id, customerId: clients[4]!.id, sessionsTotal: 5, sessionsUsed: 5, priceMinor: p5!.priceMinor, currency: cur, purchasedAt: new Date(now - 150 * DAY), expiresAt: new Date(now + 30 * DAY), status: 'exhausted', paidVia: 'in_person', manageTokenHash: token() },
    ]).returning();
    const usedFor = past.filter((a) => a.customerId === clients[0]!.id && a.status === 'completed' && a.serviceId === massage.id && a.variantId === v60!.id).slice(0, 2);
    for (const a of usedFor) {
      await db.insert(t.wellnessPackageRedemptions).values({ organizationId: orgId, clientPackageId: pkgRows[0]!.id, appointmentId: a.id, customerId: a.customerId, redeemedAt: a.startsAt });
      await db.update(t.appointments).set({ clientPackageId: pkgRows[0]!.id }).where(eq(t.appointments.id, a.id));
    }

    // Gift vouchers in the location currency (one partly used).
    const prefix = VOUCHER_PREFIX[l.code]!;
    const vouchers = await db.insert(t.wellnessGiftVouchers).values([
      { organizationId: orgId, code: `GV-${prefix}-4821`, locationId: l.id, initialMinor: { CAD: 15000, EUR: 10000, AUD: 15000 }[cur], balanceMinor: { CAD: 7500, EUR: 4000, AUD: 6000 }[cur], currency: cur, expiresAt: new Date(now + 300 * DAY), status: 'active', purchaserCustomerId: clients[1]!.id, recipientName: 'A friend', createdBy: c.demo.id, createdAt: new Date(now - 60 * DAY) },
      { organizationId: orgId, code: `GV-${prefix}-9050`, locationId: l.id, initialMinor: { CAD: 10000, EUR: 7500, AUD: 10000 }[cur], balanceMinor: { CAD: 10000, EUR: 7500, AUD: 10000 }[cur], currency: cur, expiresAt: new Date(now + 350 * DAY), status: 'active', purchaserCustomerId: clients[2]!.id, recipientName: 'Birthday gift', message: 'Happy birthday — enjoy a quiet hour.', createdBy: c.demo.id, createdAt: new Date(now - 10 * DAY) },
    ]).returning();
    for (const v of vouchers) {
      await db.insert(t.wellnessVoucherTransactions).values({ organizationId: orgId, voucherId: v.id, kind: 'issue', amountMinor: v.initialMinor, balanceAfterMinor: v.initialMinor, createdAt: v.createdAt });
      if (v.balanceMinor < v.initialMinor) await db.insert(t.wellnessVoucherTransactions).values({ organizationId: orgId, voucherId: v.id, kind: 'redeem', amountMinor: v.balanceMinor - v.initialMinor, balanceAfterMinor: v.balanceMinor, appointmentId: past.find((a) => a.status === 'completed')?.id ?? null });
    }

    // Preferences and administrative notes (never clinical).
    await db.insert(t.wellnessClientPreferences).values([
      { organizationId: orgId, customerId: clients[0]!.id, preferredPractitionerIds: [pracs[0]!.id], preferredLocationId: l.id, preferredChannel: 'sms', comfort: ['Quiet room', 'Prefers mornings'] },
      { organizationId: orgId, customerId: clients[1]!.id, preferredPractitionerIds: [], preferredLocationId: l.id, preferredChannel: 'email', comfort: ['Extra blanket', 'No music'] },
    ]);
    const author = l.code === 'HW-TOR' ? aiko.id : l.code === 'HW-DUB' && niamh ? niamh.id : c.demo.id;
    await db.insert(t.wellnessClientNotes).values([
      { organizationId: orgId, customerId: clients[0]!.id, locationId: l.id, authorUserId: author, body: 'Likes a 5-minute heads-up before the session ends. Parks on the street — remind about the loading zone.', confidential: false },
      { organizationId: orgId, customerId: clients[0]!.id, locationId: l.id, authorUserId: author, body: 'Asked us to keep their visits private from a family member who also books here. Do not mention visits.', confidential: true },
      { organizationId: orgId, customerId: clients[2]!.id, locationId: l.id, authorUserId: c.demo.id, body: 'Paid the outstanding late-cancellation fee at reception; agreed to waive the next one as a goodwill gesture.', confidential: true },
    ]);

    // Waitlist for a busy window, and reminder log samples.
    await db.insert(t.wellnessWaitlist).values({ organizationId: orgId, locationId: l.id, serviceId: massage.id, variantId: v60!.id, customerId: extra[1]!.id, windowStart: at(l, addDays(today, 2), '09:00'), windowEnd: at(l, addDays(today, 2), '13:00'), manageTokenHash: token(), note: 'Any practitioner' });
    for (const a of booked.slice(0, 2)) {
      await db.insert(t.wellnessMessageLog).values({ organizationId: orgId, locationId: l.id, appointmentId: a.id, customerId: a.customerId, kind: 'reminder', channel: 'email', status: 'logged', dedupeKey: `reminder:${a.id}:email` });
    }
  }

  // Weekly series (Dublin breathwork, Thursdays) through the engine.
  const dubClient = (await db.select().from(t.customers).where(and(eq(t.customers.organizationId, orgId), eq(t.customers.email, 'ines.duarte+hw-dub@example.com'))))[0];
  const breathDub = (await db.select().from(t.services).where(and(eq(t.services.locationId, dub.id), like(t.services.name, 'Guided breathwork%'))))[0];
  if (dubClient && breathDub) {
    let first = addDays(today, 1);
    while (weekdayOf(first) !== 4) first = addDays(first, 1);
    await createSeries(db, { organizationId: orgId, locationId: dub.id, serviceId: breathDub.id, customerId: dubClient.id, firstDate: first, localTime: '12:30', intervalWeeks: 1, occurrences: 6, mode: 'skip_conflicts', dryRun: false, actorUserId: niamh?.id ?? c.demo.id });
  }
  return { users: [aiko.email] };
}
