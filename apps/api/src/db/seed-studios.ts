/**
 * Studios full-product demo data for Stillwater Yoga Collective (sample data only): rooms, published
 * weekly series (six weeks of history + eight weeks ahead) in each location's time zone, class packs,
 * memberships with billing history (incl. a failed renewal in grace, a suspended, a paused and a
 * cancelling membership), booking policies and fees, attendance, intro-offer redemptions, online
 * livestreams and an on-demand library, instructor availability and a cancelled class with its
 * customer notifications. Called once from seed.ts after the base Stillwater data exists.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { expandRecurrence } from '../lib/recurrence.ts';
import { addDays } from '../lib/tz.ts';
import { addMonthsUtc } from '../services/studios-entitlements.ts';

type Loc = typeof t.locations.$inferSelect;
type User = typeof t.users.$inferSelect;
const DAY = 86400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICE: Record<string, number> = { CAD: 2800, USD: 2800, GBP: 1800, EUR: 2000, AUD: 3200 };
const FIVE: Record<string, number> = { CAD: 12500, USD: 12000, GBP: 8000, EUR: 9000, AUD: 14500 };
const TEN: Record<string, number> = { CAD: 23000, USD: 22000, GBP: 15000, EUR: 16500, AUD: 27000 };
const UNLIMITED: Record<string, number> = { CAD: 18900, USD: 17900, GBP: 12900, EUR: 13900, AUD: 21900 };
const EIGHT: Record<string, number> = { CAD: 13900, USD: 12900, GBP: 9500, EUR: 10500, AUD: 15900 };
const LATE_FEE: Record<string, number> = { CAD: 1000, USD: 1000, GBP: 700, EUR: 800, AUD: 1200 };
const NO_SHOW_FEE: Record<string, number> = { CAD: 1500, USD: 1500, GBP: 1000, EUR: 1200, AUD: 1800 };

const INSTRUCTORS: Record<string, string[]> = {
  'TOR-QW': ['Maya Rao', 'Sam Tran', 'Ana Silva', 'Jordan Lee'],
  'SEA-CH': ['Ava Diaz', 'Noah Kim', 'Grace Park', 'Eli Brooks'],
  'LON-SH': ['Priya Shah', 'Tom Ellis', 'Hannah Clarke', 'Olu Adeyemi'],
  'BER-MI': ['Jonas Becker', 'Mira Hoffmann', 'Lea Schulz', 'Can Yilmaz'],
  'SYD-SH': ['Chloe Walker', 'Liam Nguyen', 'Zara Ahmed', 'Ben Taylor'],
};
const FIRST = ['Amelia', 'Ben', 'Carmen', 'Daniel', 'Elif', 'Felix', 'Gemma', 'Hugo', 'Ines', 'Jack', 'Kenji', 'Laila', 'Mateo', 'Nadia', 'Owen', 'Pia', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Umar', 'Vera', 'Wes', 'Yara'];
const LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Haddad', 'Novak', 'Fischer', 'Romero', 'Tanaka', 'Walsh', 'Dubois', 'Singh', 'Costa', 'Berg', 'Kowalski', 'Russo', 'Sato'];

export interface StudiosSeedCtx { db: Db; today: string; swId: string; demo: User; maya: User }

export async function seedStudios(c: StudiosSeedCtx) {
  const { db, today, swId } = c;
  const rand = rng(20261014);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const now = new Date();
  const users = new Map((await db.select().from(t.users).where(inArray(t.users.email, ['maya.rao@demo.branchharbor.com', 'sam.tran@demo.branchharbor.com', 'jordan.lee@demo.branchharbor.com', 'ava.diaz@demo.branchharbor.com']))).map((u) => [u.name, u]));
  const locs = (await db.select().from(t.locations).where(eq(t.locations.organizationId, swId))).filter((l) => l.status === 'operating');
  const byCode = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, Loc>;

  // ── Class types: categories, levels, descriptions; extra formats ──
  const baseTypes = await db.select().from(t.classTypes).where(eq(t.classTypes.organizationId, swId));
  const meta: Record<string, { category: string; level: string; description: string }> = {
    'Morning Vinyasa': { category: 'yoga', level: 'all_levels', description: 'A steady, breath-led flow to start the day. Options are offered throughout, so every level is welcome.' },
    'Slow Flow': { category: 'yoga', level: 'beginner', description: 'Unhurried sequences with longer holds and clear cues — a good first class.' },
    'Lunchtime Pilates': { category: 'pilates', level: 'all_levels', description: 'Forty-five minutes of mat Pilates focused on control and alignment. Mats provided.' },
    'Yin & Restore': { category: 'yoga', level: 'all_levels', description: 'Long, supported floor postures and a quiet finish to the day. Props provided.' },
  };
  for (const ct of baseTypes) if (meta[ct.name]) await db.update(t.classTypes).set(meta[ct.name]!).where(eq(t.classTypes.id, ct.id));
  const extra = await db.insert(t.classTypes).values([
    { organizationId: swId, name: 'Reformer Pilates', durationMinutes: 50, defaultCapacity: 10, creditCost: 2, category: 'pilates', level: 'intermediate', description: 'Small-group reformer class. Some Pilates experience recommended; uses two credits.', locationId: byCode['TOR-QW']!.id },
    { organizationId: swId, name: 'Barre Burn', durationMinutes: 50, defaultCapacity: 16, creditCost: 1, category: 'barre', level: 'all_levels', description: 'Ballet-barre inspired strength work with music and light weights.' },
    { organizationId: swId, name: 'Rhythm Ride', durationMinutes: 45, defaultCapacity: 20, creditCost: 1, category: 'cycling', level: 'all_levels', description: 'Indoor cycling to the beat. Bikes are set up for you on your first visit.', locationId: byCode['SEA-CH']!.id },
    { organizationId: swId, name: 'Dance Cardio', durationMinutes: 45, defaultCapacity: 20, creditCost: 1, category: 'dance', level: 'beginner', description: 'Easy-to-follow choreography, no dance background needed.' },
  ]).returning();
  const typeByName = Object.fromEntries([...baseTypes, ...extra].map((x) => [x.name, x]));

  // ── Rooms ──
  const rooms: Record<string, Record<string, typeof t.studioRooms.$inferSelect>> = {};
  for (const l of locs) {
    const defs = [{ name: 'Studio A', capacity: 22, features: ['heated floor', 'sound system'] }, { name: 'Studio B', capacity: 16, features: ['mirrors'] }];
    if (l.code === 'TOR-QW') defs.push({ name: 'Reformer Room', capacity: 10, features: ['reformers ×10'] });
    if (l.code === 'SEA-CH') defs.push({ name: 'Cycle Studio', capacity: 20, features: ['bikes ×20'] });
    const rows = await db.insert(t.studioRooms).values(defs.map((d) => ({ organizationId: swId, locationId: l.id, ...d }))).returning();
    rooms[l.id] = Object.fromEntries(rows.map((r) => [r.name, r]));
  }

  // ── Series: the base daily timetable becomes published series with six weeks of history ──
  const start = addDays(today, -42);
  const until = addDays(today, 55);
  const daily = [
    { name: 'Morning Vinyasa', time: '07:00', room: 'Studio A', cap: 20, idx: 0 },
    { name: 'Slow Flow', time: '09:00', room: 'Studio B', cap: 16, idx: 1 },
    { name: 'Lunchtime Pilates', time: '12:15', room: 'Studio B', cap: 12, idx: 2 },
    { name: 'Yin & Restore', time: '18:30', room: 'Studio A', cap: 18, idx: 3 },
  ];
  const extraSeries = [
    { code: 'TOR-QW', name: 'Reformer Pilates', days: [2, 4, 6], time: '17:30', room: 'Reformer Room', cap: 10, price: 3800, credit: 2, instructor: 'Ana Silva' },
    { code: 'SEA-CH', name: 'Rhythm Ride', days: [1, 3, 5], time: '06:15', room: 'Cycle Studio', cap: 20, price: 2600, credit: 1, instructor: 'Eli Brooks' },
    { code: 'LON-SH', name: 'Barre Burn', days: [2, 4], time: '19:00', room: 'Studio B', cap: 16, price: 1900, credit: 1, instructor: 'Hannah Clarke' },
    { code: 'BER-MI', name: 'Dance Cardio', days: [6], time: '11:00', room: 'Studio A', cap: 20, price: 1800, credit: 1, instructor: 'Lea Schulz' },
    { code: 'SYD-SH', name: 'Barre Burn', days: [0], time: '09:30', room: 'Studio B', cap: 16, price: 3000, credit: 1, instructor: 'Zara Ahmed' },
  ];
  const instructorUser = (name: string, l: Loc) => (l.code === 'TOR-QW' || (l.code === 'SEA-CH' && name === 'Ava Diaz') ? users.get(name)?.id ?? null : null);
  const seriesRows: Array<typeof t.classSeries.$inferSelect> = [];
  for (const l of locs) {
    const names = INSTRUCTORS[l.code] ?? INSTRUCTORS['TOR-QW']!;
    for (const d of daily) {
      const ct = typeByName[d.name]!;
      const room = rooms[l.id]![d.room]!;
      const [sr] = await db.insert(t.classSeries).values({
        organizationId: swId, locationId: l.id, classTypeId: ct.id, status: 'published', timeZone: l.timeZone, durationMinutes: ct.durationMinutes,
        recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: [0, 1, 2, 3, 4, 5, 6], time: d.time, startDate: start, untilDate: until, count: null, skipDates: [] },
        instructorUserId: instructorUser(names[d.idx]!, l), instructorName: names[d.idx]!, roomId: room.id, roomName: room.name, capacity: d.cap, priceMinor: PRICE[l.currency] ?? 0, currency: l.currency,
        creditCost: 1, publishedAt: new Date(now.getTime() - 50 * DAY), createdBy: c.demo.id,
      }).returning();
      seriesRows.push(sr!);
      // Attach the base week's classes (created by seed.ts) to the series.
      await db.update(t.classOccurrences).set({ seriesId: sr!.id, seriesSlotAt: sql`${t.classOccurrences.startsAt}`, roomId: room.id, room: room.name, instructorName: names[d.idx]!, instructorUserId: instructorUser(names[d.idx]!, l), creditCost: 1 })
        .where(and(eq(t.classOccurrences.locationId, l.id), eq(t.classOccurrences.classTypeId, ct.id), isNull(t.classOccurrences.seriesId)));
    }
    for (const e of extraSeries.filter((x) => x.code === l.code)) {
      const ct = typeByName[e.name]!;
      const room = rooms[l.id]![e.room]!;
      const [sr] = await db.insert(t.classSeries).values({
        organizationId: swId, locationId: l.id, classTypeId: ct.id, status: 'published', timeZone: l.timeZone, durationMinutes: ct.durationMinutes,
        recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: e.days, time: e.time, startDate: start, untilDate: until, count: null, skipDates: [] },
        instructorUserId: null, instructorName: e.instructor, roomId: room.id, roomName: room.name, capacity: e.cap, priceMinor: e.price, currency: l.currency, creditCost: e.credit,
        publishedAt: new Date(now.getTime() - 50 * DAY), createdBy: c.demo.id,
      }).returning();
      seriesRows.push(sr!);
    }
  }
  const qw = byCode['TOR-QW']!;
  await db.insert(t.classSeries).values({
    organizationId: swId, locationId: qw.id, classTypeId: typeByName['Barre Burn']!.id, status: 'draft', timeZone: qw.timeZone, durationMinutes: 50,
    recurrence: { freq: 'WEEKLY', interval: 1, byWeekday: [0], time: '10:30', startDate: addDays(today, 14), untilDate: addDays(today, 98), count: null, skipDates: [] },
    instructorName: 'Jordan Lee', instructorUserId: users.get('Jordan Lee')?.id ?? null, roomId: rooms[qw.id]!['Studio B']!.id, roomName: 'Studio B', capacity: 16, priceMinor: 2800, currency: 'CAD', creditCost: 1, createdBy: c.maya.id,
  });

  // Generate every slot of the published series (past six weeks + eight weeks ahead).
  for (const sr of seriesRows) {
    const exp = expandRecurrence(sr.recurrence, sr.timeZone, sr.durationMinutes);
    const rows = exp.map((o) => ({ organizationId: swId, locationId: sr.locationId, classTypeId: sr.classTypeId, seriesId: sr.id, seriesSlotAt: o.startsAt, startsAt: o.startsAt, endsAt: o.endsAt, capacity: sr.capacity, priceMinor: sr.priceMinor, currency: sr.currency, creditCost: sr.creditCost, instructorUserId: sr.instructorUserId, instructorName: sr.instructorName, roomId: sr.roomId, room: sr.roomName, online: sr.online }));
    for (let i = 0; i < rows.length; i += 400) await db.insert(t.classOccurrences).values(rows.slice(i, i + 400)).onConflictDoNothing();
  }

  // ── Products, plans and policies ──
  const [five, ten, reformer] = await db.insert(t.studioPackProducts).values([
    { organizationId: swId, name: '5-class pack', description: 'Five classes, valid for three months at any studio that charges in your currency.', credits: 5, validityDays: 90, prices: FIVE, transferPolicy: 'same_currency' },
    { organizationId: swId, name: '10-class pack', description: 'Ten classes, valid for six months at every Stillwater studio.', credits: 10, validityDays: 180, prices: TEN, transferPolicy: 'any_location' },
    { organizationId: swId, locationId: qw.id, name: 'Reformer 5-pack', description: 'Ten credits for five reformer classes at Queen West.', credits: 10, validityDays: 60, prices: { CAD: 17500 }, transferPolicy: 'home_only', classTypeIds: [typeByName['Reformer Pilates']!.id] },
  ]).returning();
  const [unlimited, eight, mitteFlex] = await db.insert(t.studioMembershipPlans).values([
    { organizationId: swId, name: 'Unlimited', description: 'Unlimited classes at every studio in your currency.', classesPerPeriod: null, prices: UNLIMITED, accessPolicy: 'same_currency', noticeDays: 30, maxPauseDays: 60, graceDays: 7 },
    { organizationId: swId, name: '8 classes a month', description: 'Eight classes per month at your home studio.', classesPerPeriod: 8, prices: EIGHT, accessPolicy: 'home_only', noticeDays: 30, maxPauseDays: 30, graceDays: 7 },
    { organizationId: swId, locationId: byCode['BER-MI']!.id, name: 'Mitte Flex 4', description: 'Vier Kurse im Monat in Mitte.', classesPerPeriod: 4, prices: { EUR: 6900 }, accessPolicy: 'home_only', noticeDays: 14, maxPauseDays: 30, graceDays: 5 },
  ]).returning();
  await db.insert(t.studioPolicies).values([
    { organizationId: swId, locationId: null, lateCancelMinutes: 720, lateCancelFee: LATE_FEE, noShowFee: NO_SHOW_FEE, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: true, bookingWindowDays: 30, updatedBy: c.demo.id },
    { organizationId: swId, locationId: byCode['BER-MI']!.id, lateCancelMinutes: 360, lateCancelFee: {}, noShowFee: { EUR: 1000 }, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: false, bookingWindowDays: 21, updatedBy: c.demo.id },
  ]);

  // ── Customers, memberships and packs ──
  const [introOffer] = await db.select().from(t.studioOffers).where(and(eq(t.studioOffers.organizationId, swId), eq(t.studioOffers.name, 'Intro week — 3 classes')));
  type Holding = { customerId: string; locationId: string; membershipId: string | null; packId: string | null; packCredits: number };
  const holdings: Holding[] = [];
  const payRef = async (l: Loc, amount: number, at: Date, targetType: string, targetId: string | null) => {
    if (!l.paymentsEnabled) return null;
    const [p] = await db.insert(t.paymentReferences).values({ organizationId: swId, locationId: l.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: l.stripeAccountId, amountMinor: amount, currency: l.currency, applicationFeeMinor: Math.floor(amount / 100), state: 'succeeded', succeededAt: at, createdAt: at, targetType, targetId, sandbox: 1 }).returning();
    return p!;
  };
  for (const l of locs) {
    const existing = await db.select().from(t.customers).where(and(eq(t.customers.organizationId, swId), eq(t.customers.locationId, l.id)));
    const fresh = await db.insert(t.customers).values(Array.from({ length: 24 }, (_, i) => {
      const name = `${FIRST[(i + l.code.length) % FIRST.length]} ${LAST[(i * 3 + l.code.charCodeAt(0)) % LAST.length]}`;
      return { organizationId: swId, locationId: l.id, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}+${l.code.toLowerCase()}@example.com`, phone: i % 3 === 0 ? `+1 555 01${String(i).padStart(2, '0')}` : null, createdAt: new Date(now.getTime() - (60 + i * 7) * DAY) };
    })).returning();
    const all = [...existing, ...fresh];
    if (l.code === 'TOR-QW') {
      const [me] = await db.insert(t.customers).values({ organizationId: swId, locationId: l.id, userId: c.demo.id, name: 'Demo Owner', email: 'demo@branchharbor.com' }).returning();
      all.push(me!);
    }
    // Consent: most opted into marketing email at signup; a few into SMS updates.
    await db.insert(t.consentRecords).values(all.map((cu, i) => ({ organizationId: swId, customerId: cu.id, email: cu.email, purpose: 'marketing_email', version: '2026-10', granted: i % 4 !== 0, source: 'web', recordedAt: cu.createdAt })));
    await db.insert(t.consentRecords).values(all.filter((_, i) => i % 5 === 0).map((cu) => ({ organizationId: swId, customerId: cu.id, email: cu.email, purpose: 'class_updates_sms', version: '2026-10', granted: true, source: 'web' })));

    for (const [i, cu] of all.entries()) {
      const isDemo = cu.email === 'demo@branchharbor.com';
      const role = isDemo ? 'member' : i % 10 < 3 ? 'member' : i % 10 < 6 ? 'pack' : i % 10 < 7 ? 'intro' : 'dropin';
      let membershipId: string | null = null;
      let packId: string | null = null;
      let packCredits = 0;
      if (role === 'member') {
        const plan = l.code === 'BER-MI' && i % 2 ? mitteFlex! : i % 3 === 0 ? eight! : unlimited!;
        const price = plan.prices[l.currency]!;
        const startedAt = new Date(now.getTime() - (20 + Math.floor(rand() * 140)) * DAY);
        let periodStart = startedAt;
        let periodEnd = addMonthsUtc(startedAt, 1);
        const [m] = await db.insert(t.memberships).values({
          organizationId: swId, locationId: l.id, customerId: cu.id, plan: plan.name, status: 'active', crossLocation: plan.accessPolicy !== 'home_only', priceMinor: price, currency: l.currency, startsAt: startedAt,
          planId: plan.id, classesPerPeriod: plan.classesPerPeriod, accessPolicy: plan.accessPolicy, recurring: true, currentPeriodStart: startedAt, currentPeriodEnd: periodEnd,
          stripeSubscriptionId: l.paymentsEnabled ? `sub_sandbox_${randomBytes(6).toString('hex')}` : null, createdAt: startedAt,
        }).returning();
        membershipId = m!.id;
        // Billing history: one paid invoice per elapsed month.
        while (periodStart < now) {
          const pref = await payRef(l, price, periodStart, 'membership_invoice', null);
          const [inv] = await db.insert(t.membershipInvoices).values({ organizationId: swId, membershipId: m!.id, periodStart, periodEnd, amountMinor: price, currency: l.currency, status: l.paymentsEnabled ? 'paid' : 'open', attempts: 1, paymentId: pref?.id ?? null, paidAt: l.paymentsEnabled ? periodStart : null, createdAt: periodStart }).returning();
          if (pref) await db.update(t.paymentReferences).set({ targetId: inv!.id }).where(eq(t.paymentReferences.id, pref.id));
          if (periodEnd > now) break;
          periodStart = periodEnd;
          periodEnd = addMonthsUtc(periodStart, 1);
        }
        await db.update(t.memberships).set({ currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, status: l.paymentsEnabled ? 'active' : 'pending' }).where(eq(t.memberships.id, m!.id));
      }
      if (role === 'pack' || isDemo) {
        const prod = l.code === 'TOR-QW' && i % 4 === 1 ? reformer! : i % 2 ? ten! : five!;
        const price = prod.prices[l.currency] ?? 0;
        const bought = new Date(now.getTime() - (5 + Math.floor(rand() * 50)) * DAY);
        const [pu] = await db.insert(t.studioPurchases).values({ organizationId: swId, locationId: l.id, customerId: cu.id, kind: 'pack', productId: prod.id, name: `${prod.name} (${prod.credits} credits)`, listPriceMinor: price, amountMinor: price, currency: l.currency, status: l.paymentsEnabled ? 'paid' : 'pending', paidAt: bought, createdAt: bought }).returning();
        const [p] = await db.insert(t.packs).values({ organizationId: swId, locationId: l.id, customerId: cu.id, name: prod.name, creditsTotal: prod.credits, creditsRemaining: prod.credits, expiresAt: new Date(bought.getTime() + prod.validityDays * DAY), crossLocation: prod.transferPolicy !== 'home_only', priceMinor: price, currency: l.currency, productId: prod.id, transferPolicy: prod.transferPolicy, purchaseId: pu!.id, status: 'active', createdAt: bought }).returning();
        const pref = await payRef(l, price, bought, 'studio_purchase', pu!.id);
        await db.update(t.studioPurchases).set({ paymentId: pref?.id ?? null, resultId: p!.id, status: pref ? 'paid' : 'cancelled' }).where(eq(t.studioPurchases.id, pu!.id));
        packId = p!.id;
        packCredits = prod.credits;
      }
      if (role === 'intro' && introOffer) {
        const at = new Date(now.getTime() - (16 + Math.floor(rand() * 30)) * DAY);
        await db.insert(t.offerRedemptions).values({ organizationId: swId, offerId: introOffer.id, customerId: cu.id, locationId: l.id, createdAt: at });
        const [p] = await db.insert(t.packs).values({ organizationId: swId, locationId: l.id, customerId: cu.id, name: introOffer.name, creditsTotal: 3, creditsRemaining: 3, expiresAt: new Date(at.getTime() + 7 * DAY), priceMinor: introOffer.prices[l.currency] ?? 0, currency: l.currency, offerId: introOffer.id, source: 'offer', status: 'active', createdAt: at }).returning();
        packId = p!.id;
        packCredits = 3;
      }
      holdings.push({ customerId: cu.id, locationId: l.id, membershipId, packId, packCredits });
    }
  }

  // ── Bookings: attendance history and upcoming bookings ──
  const occs = await db.select().from(t.classOccurrences).where(and(eq(t.classOccurrences.organizationId, swId), eq(t.classOccurrences.status, 'scheduled'), sql`${t.classOccurrences.startsAt} < ${new Date(now.getTime() + 7 * DAY).toISOString()}`));
  const taken = new Set((await db.select({ o: t.classBookings.occurrenceId, c: t.classBookings.customerId }).from(t.classBookings).where(eq(t.classBookings.organizationId, swId))).map((r) => `${r.o}:${r.c}`));
  const used = new Map<string, number>();
  const bookingRows: Array<typeof t.classBookings.$inferInsert> = [];
  const dropInPays: Array<{ idx: number; l: Loc; amount: number; at: Date }> = [];
  const locById = new Map(locs.map((l) => [l.id, l]));
  for (const o of occs) {
    const l = locById.get(o.locationId)!;
    const pool = holdings.filter((h) => h.locationId === o.locationId);
    const past = o.startsAt < now;
    const weeksAgo = Math.max(0, (now.getTime() - o.startsAt.getTime()) / (7 * DAY));
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: l.timeZone }).format(o.startsAt));
    const base = hour < 8 || hour >= 17 ? 0.78 : hour < 11 ? 0.55 : 0.45;
    const fill = Math.min(1, Math.max(0.15, base - weeksAgo * 0.025 + (rand() - 0.5) * 0.25 - (past ? 0 : 0.2)));
    const target = Math.round(o.capacity * fill);
    const shuffled = [...pool].sort(() => rand() - 0.5);
    let n = 0;
    for (const h of shuffled) {
      if (n >= target) break;
      if (taken.has(`${o.id}:${h.customerId}`)) continue;
      taken.add(`${o.id}:${h.customerId}`);
      const credits = o.creditCost ?? 1;
      const viaPack = !h.membershipId && h.packId && (used.get(h.packId) ?? 0) + credits <= h.packCredits;
      const method = h.membershipId ? 'membership' : viaPack ? 'credit' : 'pay_per_class';
      if (method === 'pay_per_class' && !l.paymentsEnabled) continue;
      const r = rand();
      const status = !past ? 'confirmed' : r < 0.86 ? 'attended' : r < 0.93 ? 'no_show' : 'cancelled';
      const lateCancel = status === 'cancelled' && r < 0.965;
      if (viaPack && !(status === 'cancelled' && !lateCancel)) used.set(h.packId!, (used.get(h.packId!) ?? 0) + credits);
      const createdAt = new Date(o.startsAt.getTime() - (1 + Math.floor(rand() * 6)) * DAY);
      bookingRows.push({
        organizationId: swId, locationId: o.locationId, occurrenceId: o.id, customerId: h.customerId, status, source: pick(['web', 'web', 'app', 'staff']), confirmedAt: createdAt, createdAt,
        cancelledAt: status === 'cancelled' ? new Date(o.startsAt.getTime() - (lateCancel ? 2 : 30) * 3600_000) : null, lateCancel, creditReturned: viaPack && status === 'cancelled' ? !lateCancel : null,
        paymentMethod: method, packId: viaPack ? h.packId : null, membershipId: h.membershipId, creditsUsed: viaPack ? credits : 0,
        checkedInAt: status === 'attended' ? new Date(o.startsAt.getTime() - 8 * 60_000) : null, checkInSource: status === 'attended' ? (rand() < 0.7 ? 'desk' : 'instructor') : null,
      });
      if (method === 'pay_per_class') dropInPays.push({ idx: bookingRows.length - 1, l, amount: o.priceMinor, at: createdAt });
      n++;
    }
  }
  const inserted: Array<typeof t.classBookings.$inferSelect> = [];
  for (let i = 0; i < bookingRows.length; i += 500) inserted.push(...(await db.insert(t.classBookings).values(bookingRows.slice(i, i + 500)).returning()));
  const payRows = dropInPays.filter((d) => d.amount > 0).map((d) => ({ organizationId: swId, locationId: d.l.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: d.l.stripeAccountId, amountMinor: d.amount, currency: d.l.currency, applicationFeeMinor: Math.floor(d.amount / 100), state: 'succeeded', succeededAt: d.at, createdAt: d.at, targetType: 'class_booking', targetId: inserted[d.idx]!.id, sandbox: 1, refundedMinor: 0 }));
  for (let i = 0; i < payRows.length; i += 500) {
    const refs = await db.insert(t.paymentReferences).values(payRows.slice(i, i + 500)).returning({ id: t.paymentReferences.id, targetId: t.paymentReferences.targetId });
    for (const r of refs) await db.update(t.classBookings).set({ paymentId: r.id }).where(eq(t.classBookings.id, r.targetId!));
  }
  for (const [packId, n] of used) await db.update(t.packs).set({ creditsRemaining: sql`greatest(0, ${t.packs.creditsTotal} - ${n})`, status: sql`case when ${t.packs.creditsTotal} - ${n} <= 0 then 'exhausted' else ${t.packs.status} end` }).where(eq(t.packs.id, packId));
  await db.update(t.packs).set({ status: 'expired' }).where(and(eq(t.packs.organizationId, swId), sql`${t.packs.expiresAt} <= now()`, inArray(t.packs.status, ['active', 'exhausted'])));

  // Fees for recent no-shows / late cancellations (policy: fees per currency; Berlin waives for members).
  const recent = inserted.filter((b) => (b.status === 'no_show' || b.lateCancel) && b.createdAt > new Date(now.getTime() - 21 * DAY));
  for (const [i, b] of recent.entries()) {
    const l = locById.get(b.locationId)!;
    const kind = b.status === 'no_show' ? 'no_show' : 'late_cancel';
    const amount = l.code === 'BER-MI' ? (kind === 'no_show' && b.paymentMethod === 'pay_per_class' ? 1000 : undefined) : (kind === 'no_show' ? NO_SHOW_FEE : LATE_FEE)[l.currency];
    if (!amount) continue;
    await db.insert(t.studioFees).values({ organizationId: swId, locationId: l.id, customerId: b.customerId, bookingId: b.id, kind, amountMinor: amount, currency: l.currency, status: i % 3 === 0 ? 'waived' : i % 3 === 1 ? 'due' : 'paid', waiveReason: i % 3 === 0 ? 'First time — waived as a courtesy' : null }).onConflictDoNothing();
  }

  // ── Membership states worth demonstrating ──
  const qwMembers = await db.select().from(t.memberships).where(and(eq(t.memberships.locationId, qw.id), eq(t.memberships.status, 'active'), sql`${t.memberships.customerId} <> (select id from customers where user_id = ${c.demo.id} and organization_id = ${swId} limit 1)`));
  const setState = async (m: typeof t.memberships.$inferSelect | undefined, patch: Partial<typeof t.memberships.$inferInsert>, invoice?: 'failed') => {
    if (!m) return;
    await db.update(t.memberships).set({ ...patch, updatedAt: now }).where(eq(t.memberships.id, m.id));
    if (invoice) await db.insert(t.membershipInvoices).values({ organizationId: swId, membershipId: m.id, periodStart: m.currentPeriodEnd ?? now, periodEnd: addMonthsUtc(m.currentPeriodEnd ?? now, 1), amountMinor: m.priceMinor ?? 0, currency: m.currency ?? 'CAD', status: 'failed', attempts: patch.failedAttempts ?? 1, failureReason: 'Card declined', createdAt: new Date(now.getTime() - 2 * DAY) }).onConflictDoNothing();
  };
  await setState(qwMembers[0], { status: 'grace', currentPeriodEnd: new Date(now.getTime() - 2 * DAY), graceUntil: new Date(now.getTime() + 5 * DAY), failedPaymentAt: new Date(now.getTime() - 2 * DAY), failedAttempts: 1 }, 'failed');
  await setState(qwMembers[1], { status: 'suspended', currentPeriodEnd: new Date(now.getTime() - 12 * DAY), graceUntil: new Date(now.getTime() - 5 * DAY), failedPaymentAt: new Date(now.getTime() - 12 * DAY), failedAttempts: 3 }, 'failed');
  await setState(qwMembers[2], { pausedFrom: new Date(now.getTime() - 3 * DAY), pausedUntil: new Date(now.getTime() + 18 * DAY), pauseReason: 'Travelling' });
  await setState(qwMembers[3], { cancelAt: new Date(now.getTime() + 21 * DAY), cancelRequestedAt: new Date(now.getTime() - 9 * DAY) });
  const chMembers = await db.select().from(t.memberships).where(and(eq(t.memberships.locationId, byCode['SEA-CH']!.id), eq(t.memberships.status, 'active')));
  await setState(chMembers[0], { status: 'grace', currentPeriodEnd: new Date(now.getTime() - 1 * DAY), graceUntil: new Date(now.getTime() + 6 * DAY), failedPaymentAt: new Date(now.getTime() - DAY), failedAttempts: 1 }, 'failed');
  // Two memberships that ended last month (churn).
  for (const m of [qwMembers[4], chMembers[1]]) if (m) await db.update(t.memberships).set({ status: 'cancelled', cancelAt: new Date(now.getTime() - 20 * DAY), endsAt: new Date(now.getTime() - 20 * DAY) }).where(eq(t.memberships.id, m.id));

  // ── Online classes ──
  const upcomingMorning = (await db.select().from(t.classOccurrences).where(and(eq(t.classOccurrences.locationId, qw.id), eq(t.classOccurrences.classTypeId, typeByName['Morning Vinyasa']!.id), sql`${t.classOccurrences.startsAt} > now()`)).orderBy(t.classOccurrences.startsAt).limit(3));
  for (const o of upcomingMorning) await db.update(t.classOccurrences).set({ online: true }).where(eq(t.classOccurrences.id, o.id));
  const ride = (await db.select().from(t.classOccurrences).where(and(eq(t.classOccurrences.locationId, byCode['SEA-CH']!.id), eq(t.classOccurrences.classTypeId, typeByName['Rhythm Ride']!.id), sql`${t.classOccurrences.startsAt} > now()`)).orderBy(t.classOccurrences.startsAt).limit(1))[0];
  const liveRows = [
    ...upcomingMorning.map((o, i) => ({ organizationId: swId, locationId: qw.id, kind: 'livestream', title: 'Morning Vinyasa — live from Queen West', description: 'Join the studio class from home. Camera optional.', classTypeId: o.classTypeId, occurrenceId: o.id, instructorName: o.instructorName, provider: 'zoom', providerUrl: `https://zoom.us/j/8812345${600 + i}?pwd=StillwaterDemo`, startsAt: o.startsAt, durationMinutes: 60, allowMembers: true, allowPackHolders: true, allowFree: false, prices: { CAD: 1500 }, status: 'published', publishedAt: now, createdBy: c.maya.id })),
    ...(ride ? [{ organizationId: swId, locationId: byCode['SEA-CH']!.id, kind: 'livestream', title: 'Rhythm Ride — live', description: 'Ride along on your own bike.', classTypeId: ride.classTypeId, occurrenceId: ride.id, instructorName: ride.instructorName, provider: 'youtube', providerUrl: 'https://www.youtube.com/live/demoStillwaterRide', startsAt: ride.startsAt, durationMinutes: 45, allowMembers: true, allowPackHolders: false, allowFree: false, prices: { USD: 1200 }, status: 'published', publishedAt: now, createdBy: c.demo.id }] : []),
  ];
  const library = [
    { title: '20-minute Morning Flow', minutes: 20, provider: 'youtube', url: 'https://youtu.be/stillwater-morning-flow', members: true, packs: true, prices: {}, free: false, instructor: 'Maya Rao' },
    { title: 'Hip Mobility for Desk Days', minutes: 30, provider: 'vimeo', url: 'https://vimeo.com/stillwater/hip-mobility', members: true, packs: false, prices: { CAD: 900, USD: 800, GBP: 600, EUR: 700, AUD: 1000 }, free: false, instructor: 'Priya Shah' },
    { title: 'Pilates Core Fundamentals', minutes: 40, provider: 'vimeo', url: 'https://vimeo.com/stillwater/core-fundamentals', members: true, packs: true, prices: { CAD: 1200, USD: 1100, GBP: 800, EUR: 900, AUD: 1300 }, free: false, instructor: 'Ana Silva' },
    { title: 'Yin for Better Evenings', minutes: 45, provider: 'youtube', url: 'https://youtu.be/stillwater-yin-evenings', members: true, packs: false, prices: {}, free: false, instructor: 'Jordan Lee' },
    { title: 'Breath & Stillness (free taster)', minutes: 12, provider: 'youtube', url: 'https://youtu.be/stillwater-breath-taster', members: true, packs: true, prices: {}, free: true, instructor: 'Mira Hoffmann' },
    { title: 'Barre Burn Express', minutes: 25, provider: 'vimeo', url: 'https://vimeo.com/stillwater/barre-express', members: true, packs: true, prices: { CAD: 800, USD: 700, GBP: 500, EUR: 600, AUD: 900 }, free: false, instructor: 'Hannah Clarke' },
  ];
  const contentRows: Array<typeof t.onlineContent.$inferInsert> = [
    ...liveRows,
    ...library.map((v, i) => ({ organizationId: swId, locationId: null, kind: 'on_demand', title: v.title, description: `${v.minutes}-minute recording with ${v.instructor}.`, instructorName: v.instructor, provider: v.provider, providerUrl: v.url, durationMinutes: v.minutes, allowMembers: v.members, allowPackHolders: v.packs, allowFree: v.free, prices: v.prices as Record<string, number>, status: 'published', publishedAt: new Date(now.getTime() - (i + 1) * 9 * DAY), createdBy: c.demo.id })),
    { organizationId: swId, locationId: null, kind: 'on_demand', title: 'Restorative Weekend Workshop (draft)', description: 'Edit in progress.', provider: 'vimeo', providerUrl: 'https://vimeo.com/stillwater/workshop-draft', durationMinutes: 90, allowMembers: true, allowPackHolders: false, allowFree: false, prices: {}, status: 'draft', createdBy: c.demo.id },
  ];
  const content = await db.insert(t.onlineContent).values(contentRows).returning();
  const qwHolders = holdings.filter((h) => h.locationId === qw.id && (h.membershipId || h.packId)).slice(0, 6);
  const firstLive = content.find((x) => x.kind === 'livestream' && x.locationId === qw.id);
  if (firstLive) await db.insert(t.onlineAccessGrants).values(qwHolders.map((h) => ({ organizationId: swId, contentId: firstLive.id, customerId: h.customerId, kind: 'registration', basis: h.membershipId ? 'member' : 'pack_holder' }))).onConflictDoNothing();

  // ── Instructor availability ──
  const avail: Array<typeof t.instructorAvailability.$inferInsert> = [];
  const maya = users.get('Maya Rao');
  const sam = users.get('Sam Tran');
  const jordan = users.get('Jordan Lee');
  if (maya) for (const wd of [1, 2, 3, 4, 5]) avail.push({ organizationId: swId, locationId: qw.id, userId: maya.id, kind: 'available', weekday: wd, startTime: '06:00', endTime: '14:00', timeZone: qw.timeZone });
  if (sam) for (const wd of [0, 1, 2, 3, 4, 5, 6]) avail.push({ organizationId: swId, locationId: qw.id, userId: sam.id, kind: 'available', weekday: wd, startTime: '06:00', endTime: '21:00', timeZone: qw.timeZone });
  if (sam) avail.push({ organizationId: swId, locationId: qw.id, userId: sam.id, kind: 'unavailable', onDate: addDays(today, 3), startTime: '00:00', endTime: '23:59', timeZone: qw.timeZone, note: 'Exam day' });
  if (jordan) for (const wd of [0, 1, 2, 3, 4, 5]) avail.push({ organizationId: swId, locationId: qw.id, userId: jordan.id, kind: 'available', weekday: wd, startTime: '12:00', endTime: '21:30', timeZone: qw.timeZone });
  if (avail.length) await db.insert(t.instructorAvailability).values(avail);

  // ── A cancelled class with its customer notifications (communication history) ──
  const [toCancel] = await db.select().from(t.classOccurrences).where(and(eq(t.classOccurrences.locationId, qw.id), eq(t.classOccurrences.classTypeId, typeByName['Lunchtime Pilates']!.id), sql`${t.classOccurrences.startsAt} > ${new Date(now.getTime() + 2 * DAY).toISOString()}`)).orderBy(t.classOccurrences.startsAt).limit(1);
  if (toCancel) {
    const affected = await db.update(t.classBookings).set({ status: 'cancelled', cancelledAt: now, creditReturned: sql`case when ${t.classBookings.packId} is not null then true else null end` }).where(and(eq(t.classBookings.occurrenceId, toCancel.id), inArray(t.classBookings.status, ['confirmed', 'held']))).returning();
    for (const b of affected) if (b.packId && b.creditsUsed) await db.update(t.packs).set({ creditsRemaining: sql`least(${t.packs.creditsTotal}, ${t.packs.creditsRemaining} + ${b.creditsUsed})`, status: 'active' }).where(eq(t.packs.id, b.packId));
    await db.update(t.classOccurrences).set({ status: 'cancelled', cancelReason: 'Studio B floor repair', detached: true, updatedAt: now }).where(eq(t.classOccurrences.id, toCancel.id));
    const batchId = crypto.randomUUID();
    const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: qw.timeZone }).format(toCancel.startsAt);
    if (affected.length) await db.insert(t.studioCustomerNotifications).values(affected.flatMap((b) => (['email', 'sms', 'push'] as const).map((channel) => ({
      organizationId: swId, locationId: qw.id, customerId: b.customerId, occurrenceId: toCancel.id, seriesId: toCancel.seriesId, kind: 'class_cancelled', channel,
      subject: `Cancelled: Lunchtime Pilates, ${when}`, body: `Lunchtime Pilates on ${when} at Queen West has been cancelled (Studio B floor repair). Your booking is cancelled; class pack credits are returned and single-class payments refunded.`,
      status: channel === 'email' ? 'sent' : channel === 'sms' ? 'skipped_no_consent' : 'skipped_no_contact', batchId, sentAt: channel === 'email' ? now : null,
    }))));
  }

  const counts = { series: seriesRows.length, bookings: inserted.length, content: content.length, holdings: holdings.length };
  return counts;
}
