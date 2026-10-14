/**
 * Demo data for operations features and the remaining verticals (sample data only):
 *  - North Shore Football Academy (sports): Toronto CAD, Manchester GBP, Austin USD
 *  - Harbourline Wellness (wellness, administrative records only — no clinical data): Toronto CAD, Dublin EUR, Melbourne AUD
 *  - Fieldnote Goods (commerce): Portland USD, Montréal CAD, Amsterdam EUR
 *  - plus shifts, offers, intake forms, pickup settings, stock movements and pending approvals for every org.
 * Called by seed.ts after the Stillwater and Maple & Ember organisations exist. Re-running replaces it all.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { configOf, syncPickupSlots } from '../services/pickup.ts';

export const OPERATIONS_DEMO_SLUGS = ['north-shore-football', 'harbourline-wellness', 'fieldnote-goods'];

type User = typeof t.users.$inferSelect;
type Loc = typeof t.locations.$inferSelect;
export interface SeedCtx {
  db: Db;
  today: string;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
  demo: User;
  maya: User;
  carlos: User;
  priya: User;
  swId: string;
  meId: string;
}

const onboardingDone = (): Record<string, t.OnboardingStepState> => Object.fromEntries(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'invite_staff'].map((k) => [k, { status: 'complete' as const, updatedAt: new Date().toISOString() }]));
const pi = (prefix = 'pi_seed') => `${prefix}_${randomBytes(8).toString('hex')}`;
const at = (loc: Loc, date: string, time: string) => zonedToUtc(date, time, loc.timeZone);
const hours = (n: number) => n * 3600_000;

export async function seedOperations(c: SeedCtx) {
  const { db, today } = c;
  const userIds: Record<string, User> = {};
  const user = async (key: string, email: string, name: string, locale = 'en') => (userIds[key] = await c.upsertUser(email, name, locale));

  // Extra demo staff (same password as the other demo users).
  const sam = await user('sam', 'sam.tran@demo.branchharbor.com', 'Sam Tran');
  const jordan = await user('jordan', 'jordan.lee@demo.branchharbor.com', 'Jordan Lee');
  const ren = await user('ren', 'ren.ito@demo.branchharbor.com', 'Ren Ito');
  const ava = await user('ava', 'ava.diaz@demo.branchharbor.com', 'Ava Diaz');

  // ───────────── Stillwater: staff, shifts, offers, thresholds, approvals ─────────────
  const swLocs = await db.select().from(t.locations).where(eq(t.locations.organizationId, c.swId));
  const qw = swLocs.find((l) => l.code === 'TOR-QW')!;
  const ch = swLocs.find((l) => l.code === 'SEA-CH')!;
  await db.insert(t.roleAssignments).values([
    { organizationId: c.swId, userId: sam.id, role: 'staff', scopeKind: 'location', scopeId: qw.id },
    { organizationId: c.swId, userId: jordan.id, role: 'staff', scopeKind: 'location', scopeId: qw.id },
    { organizationId: c.swId, userId: ava.id, role: 'staff', scopeKind: 'location', scopeId: ch.id },
  ]).onConflictDoNothing();
  await db.update(t.organizations).set({ settings: sql`${t.organizations.settings} || ${JSON.stringify({ customerDataSharing: 'off', aiTrainingOptOut: true, refundApprovalThresholds: { CAD: 5000, USD: 5000, GBP: 3000, EUR: 3500, AUD: 6000 } })}::jsonb` }).where(eq(t.organizations.id, c.swId));
  await db.update(t.subscriptions).set({ pricePerLocationMinor: 8900, billingInterval: 'month' }).where(eq(t.subscriptions.organizationId, c.swId));

  const swShifts = await scheduleWeek(db, c.swId, qw, today, [
    { user: c.maya, role: 'Studio manager', start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5] },
    { user: sam, role: 'Front desk', start: '06:30', end: '13:00', days: [1, 2, 3, 4, 5, 6] },
    { user: jordan, role: 'Front desk', start: '13:00', end: '21:00', days: [0, 1, 2, 3, 4, 5] },
  ]);
  await scheduleWeek(db, c.swId, ch, today, [{ user: ava, role: 'Front desk', start: '07:00', end: '15:00', days: [1, 2, 3, 4, 5] }], true);
  // The demo owner has a shift running now at Queen West so the mobile clock-in can be tried straight away.
  const nowHour = new Date(Math.floor(Date.now() / hours(1)) * hours(1));
  const [demoShift] = await db.insert(t.shifts).values({ organizationId: c.swId, locationId: qw.id, userId: c.demo.id, role: 'Manager on duty', startsAt: new Date(nowHour.getTime() - hours(1)), endsAt: new Date(nowHour.getTime() + hours(7)), createdBy: c.demo.id }).returning();
  // A completed clock-in/out for Sam earlier today, so timesheets have data.
  const samToday = swShifts.find((s) => s.userId === sam.id && s.startsAt < new Date() && s.endsAt > new Date(Date.now() - hours(24)));
  if (samToday) {
    await db.insert(t.timeClockEvents).values([
      { organizationId: c.swId, locationId: qw.id, userId: sam.id, shiftId: samToday.id, kind: 'clock_in', at: new Date(samToday.startsAt.getTime() - 4 * 60_000), source: 'mobile' },
      ...(samToday.endsAt < new Date() ? [{ organizationId: c.swId, locationId: qw.id, userId: sam.id, shiftId: samToday.id, kind: 'clock_out', at: new Date(samToday.endsAt.getTime() + 6 * 60_000), source: 'mobile' }] : []),
    ]);
  }
  void demoShift;

  // Pending shift swap: Sam gives a future front-desk shift to Jordan.
  const samFuture = swShifts.filter((s) => s.userId === sam.id && s.startsAt > new Date(Date.now() + hours(24)))[0];
  if (samFuture) await swapRequest(db, c.swId, qw, samFuture, sam, jordan, 'Exam that morning — Jordan has offered to cover');

  await db.insert(t.studioOffers).values([
    { organizationId: c.swId, name: 'Intro week — 3 classes', description: 'Three classes in your first seven days, any level.', kind: 'intro_pass', prices: { CAD: 2500, USD: 2500, GBP: 1500, EUR: 1700, AUD: 2900 }, credits: 3, validDays: 7, eligibility: { newCustomersOnly: true, maxPerCustomer: 1 }, status: 'active', createdBy: c.demo.id },
    { organizationId: c.swId, locationId: qw.id, name: 'Queen West student 5-pack', description: 'Five classes for students with a valid card.', kind: 'class_pack', prices: { CAD: 9000 }, credits: 5, validDays: 60, eligibility: { maxPerCustomer: 2, minAge: 16 }, status: 'active', createdBy: c.maya.id },
    { organizationId: c.swId, name: 'Summer unlimited trial', description: 'Two weeks unlimited.', kind: 'trial_membership', prices: { CAD: 4900, USD: 4900, GBP: 3500, EUR: 3900 }, validDays: 14, eligibility: { newCustomersOnly: true }, status: 'ended', endsAt: new Date(`${addDays(today, -40)}T00:00:00Z`), createdBy: c.demo.id },
    { organizationId: c.swId, name: 'Bring a friend', description: 'Members bring a friend for free.', kind: 'intro_pass', prices: { CAD: 0, USD: 0, GBP: 0, EUR: 0, AUD: 0 }, credits: 1, validDays: 30, eligibility: { newCustomersOnly: true, maxPerCustomer: 1 }, status: 'draft', createdBy: c.demo.id },
  ]);

  // Refund request (Maya → owner) for a Queen West class payment, and a local ad spend request.
  const [qwPay] = await db.select().from(t.paymentReferences).where(and(eq(t.paymentReferences.locationId, qw.id), eq(t.paymentReferences.state, 'succeeded'), eq(t.paymentReferences.targetType, 'class_booking'))).limit(1);
  if (qwPay) await refundApproval(db, c.swId, qw, { paymentId: qwPay.id }, qwPay.amountMinor, 'CAD', c.maya, 'Class cancelled after the heating failed — full refund for the member', `Refund for payment ${qwPay.externalId.slice(-8)}`);
  await adSpendApproval(db, c.swId, qw, c.maya, { amountMinor: 40000, channel: 'meta_ads', durationDays: 14, title: 'Queen West spring intro offer', description: 'Instagram + Facebook, 5 km radius, targeting the intro week offer.' }, today);

  // ───────────── Maple & Ember: pickup settings, shifts, approvals ─────────────
  const meLocs = await db.select().from(t.locations).where(eq(t.locations.organizationId, c.meId));
  const ballard = meLocs.find((l) => l.code === 'SEA-BL')!;
  await db.insert(t.roleAssignments).values([{ organizationId: c.meId, userId: ren.id, role: 'location_manager', scopeKind: 'location', scopeId: ballard.id }]).onConflictDoNothing();
  await db.update(t.organizations).set({ settings: sql`${t.organizations.settings} || ${JSON.stringify({ customerDataSharing: 'totals_only', aiTrainingOptOut: true, refundApprovalThresholds: { USD: 1500, CAD: 2000 } })}::jsonb` }).where(eq(t.organizations.id, c.meId));
  await db.update(t.subscriptions).set({ pricePerLocationMinor: 7900, billingInterval: 'month' }).where(eq(t.subscriptions.organizationId, c.meId));
  const lunchDinner = [1, 2, 3, 4, 5].flatMap((weekday) => [{ weekday, open: '11:00', close: '14:30' }, { weekday, open: '16:30', close: '21:00' }]);
  const weekend = [0, 6].map((weekday) => ({ weekday, open: '11:00', close: '21:00' }));
  for (const l of meLocs.filter((x) => x.status === 'operating')) {
    const cfg = { hours: [...lunchDinner, ...weekend], slotMinutes: 15, slotCapacity: l.code === 'YVR-GT' ? 8 : 6, prepBufferMinutes: 25, cutoffMinutes: 20, horizonDays: 3, closedDates: [addDays(today, 10)], acceptingOrders: true };
    const [row] = await db.insert(t.pickupSettings).values({ organizationId: c.meId, locationId: l.id, ...cfg, updatedBy: c.demo.id }).returning();
    await syncPickupSlots(db, l, configOf(row!));
  }
  const meShifts = await scheduleWeek(db, c.meId, ballard, today, [
    { user: c.carlos, role: 'Kitchen lead', start: '10:00', end: '18:00', days: [2, 3, 4, 5, 6] },
    { user: ren, role: 'Shift manager', start: '14:00', end: '22:00', days: [0, 1, 4, 5, 6] },
  ]);
  // Carlos (staff) also has a shift right now so the staff clock-in works for him too.
  await db.insert(t.shifts).values({ organizationId: c.meId, locationId: ballard.id, userId: c.carlos.id, role: 'Kitchen lead', startsAt: new Date(nowHour.getTime() - hours(2)), endsAt: new Date(nowHour.getTime() + hours(5)), createdBy: c.demo.id });
  const carlosFuture = meShifts.find((s) => s.userId === c.carlos.id && s.startsAt > new Date(Date.now() + hours(30)));
  if (carlosFuture) await swapRequest(db, c.meId, ballard, carlosFuture, c.carlos, ren, 'Family event — Ren can take the kitchen');
  const [foodPay] = await db.select().from(t.paymentReferences).where(and(eq(t.paymentReferences.locationId, ballard.id), eq(t.paymentReferences.targetType, 'food_order'))).limit(1);
  if (foodPay) await refundApproval(db, c.meId, ballard, { paymentId: foodPay.id }, foodPay.amountMinor, 'USD', ren, 'Order arrived cold — customer asked for a refund', `Refund for pickup order ${foodPay.externalId.slice(-8)}`);

  // ───────────── North Shore Football Academy (sports) ─────────────
  const coachKim = await user('kim', 'kim.osei@demo.branchharbor.com', 'Kim Osei');
  const coachTom = await user('tom', 'tom.hughes@demo.branchharbor.com', 'Tom Hughes', 'en-GB');
  const coachMaria = await user('maria', 'maria.garza@demo.branchharbor.com', 'Maria Garza');
  const aisha = await user('aisha', 'aisha.khan@demo.branchharbor.com', 'Aisha Khan', 'en-GB');
  const [ns] = await db.insert(t.organizations).values({
    slug: 'north-shore-football', name: 'North Shore Football Academy', industry: 'sports', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en',
    defaultTimeZone: 'America/Toronto', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'per_location', onboarding: onboardingDone(),
    settings: { customerDataSharing: 'off', aiTrainingOptOut: true, refundApprovalThresholds: { CAD: 10000, GBP: 6000, USD: 10000 } },
  }).returning();
  const nsId = ns!.id;
  const [nsNa, nsEu] = await db.insert(t.regions).values([{ organizationId: nsId, name: 'North America' }, { organizationId: nsId, name: 'United Kingdom' }]).returning();
  const nsLocs = await db.insert(t.locations).values([
    { organizationId: nsId, regionId: nsNa!.id, name: 'Toronto Lakeshore', code: 'NS-TOR', slug: 'toronto', address: { line1: '1 Lakeshore Blvd W', city: 'Toronto', region: 'ON', postalCode: 'M6K 3C1', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_ns_tor', hours: { summary: 'Mon–Fri 4pm–9pm · Sat–Sun 8am–6pm' } },
    { organizationId: nsId, regionId: nsEu!.id, name: 'Manchester Etihad Campus', code: 'NS-MAN', slug: 'manchester', address: { line1: '400 Ashton New Rd', city: 'Manchester', postalCode: 'M11 4TQ', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_ns_man', hours: { summary: 'Mon–Fri 4pm–9pm · Sat 9am–5pm' } },
    { organizationId: nsId, regionId: nsNa!.id, name: 'Austin Mueller Fields', code: 'NS-AUS', slug: 'austin', address: { line1: '4550 Mueller Blvd', city: 'Austin', region: 'TX', postalCode: '78723', country: 'US' }, country: 'US', timeZone: 'America/Chicago', currency: 'USD', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_ns_aus', hours: { summary: 'Mon–Fri 5pm–9pm · Sat–Sun 8am–4pm' } },
  ]).returning();
  const [nsTor, nsMan, nsAus] = nsLocs as [Loc, Loc, Loc];
  await db.insert(t.roleAssignments).values([
    { organizationId: nsId, userId: c.demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: nsId },
    { organizationId: nsId, userId: aisha.id, role: 'location_manager', scopeKind: 'location', scopeId: nsMan.id },
    { organizationId: nsId, userId: coachKim.id, role: 'staff', scopeKind: 'location', scopeId: nsTor.id },
    { organizationId: nsId, userId: coachTom.id, role: 'staff', scopeKind: 'location', scopeId: nsMan.id },
    { organizationId: nsId, userId: coachMaria.id, role: 'staff', scopeKind: 'location', scopeId: nsAus.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: nsId, plan: 'network', status: 'active', billedLocationCount: 3, currency: 'CAD', pricePerLocationMinor: 9900 });

  const nsPlan: Array<{ loc: Loc; coach: User; fee: number; venues: [string, string]; fixtureVenue: string; teams: string[] }> = [
    { loc: nsTor, coach: coachKim, fee: 42000, venues: ['Lakeshore Pitch 1', 'Lakeshore Pitch 2'], fixtureVenue: 'Lamport Stadium', teams: ['U10 Blue', 'U12 Blue', 'U14 Navy'] },
    { loc: nsMan, coach: coachTom, fee: 24000, venues: ['Campus Pitch A', 'Campus Pitch B'], fixtureVenue: 'Platt Fields', teams: ['U11 Sky', 'U13 Sky'] },
    { loc: nsAus, coach: coachMaria, fee: 38000, venues: ['Mueller Field 3', 'Mueller Field 4'], fixtureVenue: 'Q2 Stadium Training Ground', teams: ['U10 Orange', 'U12 Orange'] },
  ];
  const kidNames = ['Leo Park', 'Ava Singh', 'Noah Williams', 'Maya Chen', 'Ethan Brown', 'Zara Ahmed', 'Lucas Silva', 'Chloe Martin', 'Omar Haddad', 'Isla Murphy', 'Theo Rossi', 'Amara Okafor', 'Jack Wilson', 'Sofia García', 'Ben Taylor', 'Nina Kowalski'];
  const nsPrices: Record<string, number> = {};
  for (const [pi_, p] of nsPlan.entries()) {
    const [prog] = await db.insert(t.programmes).values({ organizationId: nsId, locationId: p.loc.id, name: 'Youth Academy — Fall 2026', description: 'Two training sessions a week plus weekend fixtures.', ageMin: 8, ageMax: 14, ageCutoffDate: '2026-12-31', capacity: 60, feeMinor: p.fee, currency: p.loc.currency, requiresApproval: true, refundPolicy: 'Full refund before the first session; pro-rated afterwards.', status: 'published' }).returning();
    nsPrices[p.loc.currency] = p.fee;
    await db.insert(t.seasons).values({ organizationId: nsId, programmeId: prog!.id, name: 'Fall 2026', startsOn: '2026-09-07', endsOn: '2026-12-13' });
    const teams = await db.insert(t.teams).values(p.teams.map((name, i) => ({ organizationId: nsId, locationId: p.loc.id, programmeId: prog!.id, name, coachUserId: i === 0 || p.loc.id !== nsTor.id ? p.coach.id : null, capacity: 18 }))).returning();
    for (const [ti, team] of teams.entries()) {
      const kids = kidNames.slice((ti * 5 + pi_ * 3) % 10, (ti * 5 + pi_ * 3) % 10 + 6);
      for (const [ki, kid] of kids.entries()) {
        const age = 9 + ti * 2;
        const [child] = await db.insert(t.customers).values({ organizationId: nsId, locationId: p.loc.id, name: kid, dateOfBirth: `${2026 - age}-0${(ki % 9) + 1}-1${ki % 9}` }).returning();
        const [guardian] = await db.insert(t.customers).values({ organizationId: nsId, locationId: p.loc.id, name: `${['Sam', 'Alex', 'Jamie', 'Robin', 'Chris', 'Taylor'][ki]} ${kid.split(' ')[1]}`, email: `guardian.${kid.toLowerCase().replace(/\s+/g, '.')}+${p.loc.code.toLowerCase()}@example.com` }).returning();
        await db.insert(t.guardianRelationships).values({ organizationId: nsId, guardianCustomerId: guardian!.id, participantCustomerId: child!.id, status: ki === 5 ? 'pending_verification' : 'verified', verifiedAt: ki === 5 ? null : new Date() });
        const status = ki < 5 ? 'accepted' : ti === 0 ? 'awaiting_review' : 'waitlisted';
        await db.insert(t.registrations).values({ organizationId: nsId, locationId: p.loc.id, programmeId: prog!.id, participantCustomerId: child!.id, guardianCustomerId: guardian!.id, status, teamId: status === 'accepted' ? team.id : null, forms: status === 'accepted' ? { emergencyContact: true, photoConsent: ki % 2 === 0 } : {} });
      }
      // Sessions: last week and the next two weeks — training Tue/Thu, fixture Saturday.
      for (let d = -7; d <= 14; d++) {
        const date = addDays(today, d);
        const wd = weekdayOf(date);
        const isTraining = wd === 2 || wd === 4;
        const isFixture = wd === 6;
        if (!isTraining && !isFixture) continue;
        const startTime = isFixture ? `${String(9 + ti * 2).padStart(2, '0')}:00` : ['17:00', '18:00', '19:30'][ti]!;
        const startsAt = at(p.loc, date, startTime);
        // Toronto U10 and U12 share Pitch 1 on Thursdays — a deliberate venue clash for the conflict indicator.
        const venue = isFixture ? p.fixtureVenue : p.loc.id === nsTor.id && wd === 4 && ti < 2 ? p.venues[0] : p.venues[ti % 2];
        const [sess] = await db.insert(t.trainingSessions).values({ organizationId: nsId, locationId: p.loc.id, teamId: team.id, startsAt, endsAt: new Date(startsAt.getTime() + (isFixture ? 105 : 90) * 60_000), venue, kind: isFixture ? 'fixture' : 'training' }).returning();
        if (d < 0) {
          const roster = await db.select({ id: t.registrations.participantCustomerId }).from(t.registrations).where(and(eq(t.registrations.teamId, team.id), eq(t.registrations.status, 'accepted')));
          await db.insert(t.attendance).values(roster.map((r, i) => ({ organizationId: nsId, locationId: p.loc.id, sessionId: sess!.id, participantCustomerId: r.id, status: i === 2 && d % 2 === 0 ? 'absent' : i === 4 ? 'late' : 'present', recordedBy: p.coach.id })));
        }
      }
    }
  }
  await scheduleWeek(db, nsId, nsTor, today, [{ user: coachKim, role: 'Head coach', start: '16:00', end: '21:00', days: [1, 2, 3, 4, 5] }]);
  await scheduleWeek(db, nsId, nsMan, today, [{ user: coachTom, role: 'Coach', start: '16:00', end: '21:00', days: [1, 2, 4] }, { user: aisha, role: 'Site manager', start: '12:00', end: '20:00', days: [1, 2, 3, 4, 5] }]);
  await adSpendApproval(db, nsId, nsMan, aisha, { amountMinor: 75000, channel: 'google_ads', durationDays: 21, title: 'Manchester spring trials', description: 'Search ads for "kids football academy Manchester" ahead of open trials.' }, today);

  // ───────────── Harbourline Wellness (administrative only) ─────────────
  const niamh = await user('niamh', 'niamh.byrne@demo.branchharbor.com', 'Niamh Byrne', 'en-GB');
  const liam = await user('liam', 'liam.chen@demo.branchharbor.com', 'Liam Chen');
  const [hw] = await db.insert(t.organizations).values({
    slug: 'harbourline-wellness', name: 'Harbourline Wellness', industry: 'wellness', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en',
    defaultTimeZone: 'America/Toronto', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'per_location', onboarding: onboardingDone(),
    settings: { customerDataSharing: 'off', aiTrainingOptOut: true, refundApprovalThresholds: { CAD: 8000, EUR: 6000, AUD: 9000 } },
  }).returning();
  const hwId = hw!.id;
  const hwLocs = await db.insert(t.locations).values([
    { organizationId: hwId, name: 'Harbourline Yorkville', code: 'HW-TOR', slug: 'yorkville', address: { line1: '55 Avenue Rd', city: 'Toronto', region: 'ON', postalCode: 'M5R 3L2', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_hw_tor', hours: { summary: 'Mon–Sat 9am–7pm' } },
    { organizationId: hwId, name: 'Harbourline Dublin 2', code: 'HW-DUB', slug: 'dublin', address: { line1: '22 Merrion Square N', city: 'Dublin', postalCode: 'D02 XE80', country: 'IE' }, country: 'IE', timeZone: 'Europe/Dublin', currency: 'EUR', locale: 'en-IE', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_hw_dub', hours: { summary: 'Mon–Fri 8am–8pm · Sat 9am–5pm' } },
    { organizationId: hwId, name: 'Harbourline Fitzroy', code: 'HW-MEL', slug: 'melbourne', address: { line1: '210 Gertrude St', city: 'Fitzroy', region: 'VIC', postalCode: '3065', country: 'AU' }, country: 'AU', timeZone: 'Australia/Melbourne', currency: 'AUD', locale: 'en-AU', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_hw_mel', hours: { summary: 'Tue–Sun 9am–6pm' } },
  ]).returning();
  const [hwTor, hwDub, hwMel] = hwLocs as [Loc, Loc, Loc];
  await db.insert(t.roleAssignments).values([
    { organizationId: hwId, userId: c.demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: hwId },
    { organizationId: hwId, userId: niamh.id, role: 'location_manager', scopeKind: 'location', scopeId: hwDub.id },
    { organizationId: hwId, userId: liam.id, role: 'staff', scopeKind: 'location', scopeId: hwTor.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: hwId, plan: 'network', status: 'active', billedLocationCount: 3, currency: 'CAD', pricePerLocationMinor: 9900 });
  const svcDefs = [
    { name: 'Restorative massage', duration: 60, after: 15, room: true, price: { CAD: 11000, EUR: 8500, AUD: 13000 } },
    { name: 'Reflexology', duration: 45, after: 10, room: true, price: { CAD: 8500, EUR: 6500, AUD: 9500 } },
    { name: 'Guided breathwork (1:1)', duration: 30, after: 5, room: false, price: { CAD: 5500, EUR: 4000, AUD: 6000 } },
  ];
  const allSvc: Array<typeof t.services.$inferSelect> = [];
  const pracNames: Record<string, string[]> = { [hwTor.id]: ['Priya Shah', 'Daniel Moreau'], [hwDub.id]: ['Niamh Byrne', 'Cian Walsh'], [hwMel.id]: ['Grace Nguyen', 'Oliver Hart'] };
  for (const l of hwLocs) {
    const svcs = await db.insert(t.services).values(svcDefs.map((s) => ({ organizationId: hwId, locationId: l.id, name: s.name, description: `${s.name} — appointment details are administrative only.`, durationMinutes: s.duration, bufferAfterMinutes: s.after, priceMinor: s.price[l.currency as 'CAD' | 'EUR' | 'AUD'], depositMinor: 0, currency: l.currency, requiredResourceType: s.room ? 'room' : null, cancellationPolicy: 'Free cancellation up to 24 hours before.' }))).returning();
    allSvc.push(...svcs);
    await db.insert(t.resources).values([{ organizationId: hwId, locationId: l.id, name: 'Treatment room 1', type: 'room' }, { organizationId: hwId, locationId: l.id, name: 'Treatment room 2', type: 'room' }]);
    const pracs = await db.insert(t.practitioners).values(pracNames[l.id]!.map((name, i) => ({ organizationId: hwId, locationId: l.id, userId: name === 'Niamh Byrne' ? niamh.id : null, name, serviceIds: svcs.map((s) => s.id).filter((_, si) => i === 0 || si !== 1), availability: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: i === 0 ? '09:00' : '12:00', end: i === 0 ? '15:00' : '19:00' })) }))).returning();
    const rooms = await db.select().from(t.resources).where(eq(t.resources.locationId, l.id));
    const clients = await db.insert(t.customers).values(['Clara Byrne', 'Hugo Lambert', 'Mei Tanaka', 'Rosa Alvarez', 'Finn O’Brien'].map((n) => ({ organizationId: hwId, locationId: l.id, name: n, email: `${n.toLowerCase().replace(/[^a-z]+/g, '.')}+${l.code.toLowerCase()}@example.com` }))).returning();
    for (let d = 0; d < 4; d++) {
      const date = addDays(today, d + 1);
      if (weekdayOf(date) === 0) continue;
      for (let k = 0; k < 2; k++) {
        const svc = svcs[(d + k) % svcs.length]!;
        const startsAt = at(l, date, k === 0 ? '10:00' : '13:30');
        const endsAt = new Date(startsAt.getTime() + svc.durationMinutes * 60_000);
        await db.insert(t.appointments).values({ organizationId: hwId, locationId: l.id, serviceId: svc.id, practitionerId: pracs[k === 0 ? 0 : 1]!.id, resourceId: svc.requiredResourceType ? rooms[k]!.id : null, customerId: clients[(d + k) % clients.length]!.id, startsAt, endsAt, blockedFrom: startsAt, blockedUntil: new Date(endsAt.getTime() + svc.bufferAfterMinutes * 60_000), priceMinor: svc.priceMinor, currency: l.currency, manageTokenHash: sha256(`seed-appt-${l.code}-${d}-${k}`) });
      }
    }
  }
  const [intake] = await db.insert(t.intakeForms).values({
    organizationId: hwId, name: 'New client intake', description: 'Administrative details that help us prepare your visit. Please do not include medical history — share anything clinical with your practitioner in person.',
    serviceIds: [], status: 'active', consentVersion: '2026-10', consentText: 'I agree that Harbourline Wellness may store these answers to prepare my appointments. They are visible only to staff at my location and are never used for marketing or AI.',
    questions: [
      { id: 'goals', label: 'What would you like to get from your visit?', type: 'longtext', required: true },
      { id: 'pressure', label: 'Preferred massage pressure', type: 'choice', required: false, options: ['Light', 'Medium', 'Firm', 'No preference'] },
      { id: 'access_needs', label: 'Any access needs we should plan for (e.g. step-free access, interpreter)?', type: 'text', required: false },
      { id: 'reminders', label: 'Would you like appointment reminders by text?', type: 'yes_no', required: true },
      { id: 'heard_from', label: 'How did you hear about us?', type: 'choice', required: false, options: ['Friend', 'Search', 'Social media', 'Walked past', 'Other'] },
    ],
    createdBy: c.demo.id,
  }).returning();
  await db.insert(t.intakeForms).values({
    organizationId: hwId, locationId: hwMel.id, name: 'Fitzroy arrival & accessibility', description: 'Helps the Fitzroy team plan your arrival.', serviceIds: [], status: 'draft', consentVersion: '2026-09',
    consentText: 'I agree that Harbourline Fitzroy may store these answers to plan my visit.', questions: [{ id: 'arrival', label: 'How will you get here?', type: 'choice', required: false, options: ['Tram', 'Car', 'Bike', 'Walking'] }, { id: 'parking', label: 'Do you need an accessible parking space?', type: 'yes_no', required: false }], createdBy: c.demo.id,
  });
  const someAppts = await db.select().from(t.appointments).where(eq(t.appointments.organizationId, hwId)).limit(4);
  for (const [i, a] of someAppts.entries()) {
    await db.insert(t.intakeResponses).values({ organizationId: hwId, locationId: a.locationId, formId: intake!.id, formVersion: 1, customerId: a.customerId, appointmentId: a.id, answers: { goals: ['Unwind after a busy month', 'Ease desk-work shoulder tension', 'Try something new', 'Sleep better'][i], pressure: ['Medium', 'Firm', 'Light', 'No preference'][i], reminders: i % 2 === 0, heard_from: ['Friend', 'Search', 'Social media', 'Walked past'][i] }, consentVersion: '2026-10', consentGivenAt: new Date(Date.now() - hours(20 + i)) });
  }
  await scheduleWeek(db, hwId, hwTor, today, [{ user: liam, role: 'Reception', start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5, 6] }]);
  await scheduleWeek(db, hwId, hwDub, today, [{ user: niamh, role: 'Clinic manager', start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5] }]);
  await adSpendApproval(db, hwId, hwDub, niamh, { amountMinor: 30000, channel: 'meta_ads', durationDays: 10, title: 'Dublin 2 lunchtime breathwork', description: 'Promote 30-minute lunchtime sessions to nearby offices.' }, today);

  // ───────────── Fieldnote Goods (commerce) ─────────────
  const olivia = await user('olivia', 'olivia.martin@demo.branchharbor.com', 'Olivia Martin');
  const luc = await user('luc', 'luc.tremblay@demo.branchharbor.com', 'Luc Tremblay', 'fr');
  const sanne = await user('sanne', 'sanne.devries@demo.branchharbor.com', 'Sanne de Vries', 'nl');
  const [fg] = await db.insert(t.organizations).values({
    slug: 'fieldnote-goods', name: 'Fieldnote Goods', industry: 'commerce', model: 'network', country: 'US', defaultCurrency: 'USD', defaultLocale: 'en',
    defaultTimeZone: 'America/Los_Angeles', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'per_location', onboarding: onboardingDone(),
    settings: { customerDataSharing: 'shared', aiTrainingOptOut: true, refundApprovalThresholds: { USD: 10000, CAD: 13000, EUR: 9000 } },
  }).returning();
  const fgId = fg!.id;
  const fgLocs = await db.insert(t.locations).values([
    { organizationId: fgId, name: 'Portland Pearl', code: 'FG-PDX', slug: 'portland', address: { line1: '1122 NW Glisan St', city: 'Portland', region: 'OR', postalCode: '97209', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_fg_pdx', hours: { summary: 'Daily 10am–7pm' } },
    { organizationId: fgId, name: 'Montréal Mile End', code: 'FG-YUL', slug: 'montreal', address: { line1: '5345 Boul. Saint-Laurent', city: 'Montréal', region: 'QC', postalCode: 'H2T 1S5', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'fr-CA', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_fg_yul', hours: { summary: 'Tous les jours 10 h–18 h' } },
    { organizationId: fgId, name: 'Amsterdam Jordaan', code: 'FG-AMS', slug: 'amsterdam', address: { line1: 'Westerstraat 87', city: 'Amsterdam', postalCode: '1015 LX', country: 'NL' }, country: 'NL', timeZone: 'Europe/Amsterdam', currency: 'EUR', locale: 'nl', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_fg_ams', hours: { summary: 'Ma–Za 10–18 uur' } },
  ]).returning();
  const [pdx, yul, ams] = fgLocs as [Loc, Loc, Loc];
  await db.insert(t.roleAssignments).values([
    { organizationId: fgId, userId: c.demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: fgId },
    { organizationId: fgId, userId: olivia.id, role: 'location_manager', scopeKind: 'location', scopeId: pdx.id },
    { organizationId: fgId, userId: luc.id, role: 'staff', scopeKind: 'location', scopeId: yul.id },
    { organizationId: fgId, userId: sanne.id, role: 'location_manager', scopeKind: 'location', scopeId: ams.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: fgId, plan: 'network', status: 'active', billedLocationCount: 3, currency: 'USD', pricePerLocationMinor: 7900 });
  const catalogue = [
    { sku: 'FN-NB', name: 'Field notebook', desc: 'Recycled paper, lay-flat binding.', variants: [['FN-NB-DOT', 'A5 · Dot grid', { USD: 1800, CAD: 2400, EUR: 1700 }], ['FN-NB-RUL', 'A5 · Ruled', { USD: 1800, CAD: 2400, EUR: 1700 }], ['FN-NB-PKT', 'Pocket · Blank', { USD: 1200, CAD: 1600, EUR: 1100 }]] },
    { sku: 'FN-PEN', name: 'Brass rollerball', desc: 'Machined brass, refillable.', variants: [['FN-PEN-RAW', 'Raw brass', { USD: 4800, CAD: 6400, EUR: 4500 }], ['FN-PEN-BLK', 'Black', { USD: 4800, CAD: 6400, EUR: 4500 }]] },
    { sku: 'FN-TOTE', name: 'Waxed canvas tote', desc: 'Heavyweight waxed canvas.', variants: [['FN-TOTE-OLV', 'Olive', { USD: 6800, CAD: 8900, EUR: 6200 }], ['FN-TOTE-SND', 'Sand', { USD: 6800, CAD: 8900, EUR: 6200 }]] },
    { sku: 'FN-INK', name: 'Fountain pen ink', desc: '50 ml bottle.', variants: [['FN-INK-BLU', 'Harbour blue', { USD: 2200, CAD: 2900, EUR: 2000 }]] },
  ] as const;
  const allVariants: Array<typeof t.variants.$inferSelect> = [];
  for (const p of catalogue) {
    const [prod] = await db.insert(t.products).values({ organizationId: fgId, sku: p.sku, name: p.name, description: p.desc, status: 'active' }).returning();
    allVariants.push(...(await db.insert(t.variants).values(p.variants.map(([sku, name, prices]) => ({ organizationId: fgId, productId: prod!.id, sku, name, prices: { ...prices } }))).returning()));
  }
  const by = { [pdx.id]: olivia, [yul.id]: luc, [ams.id]: sanne };
  for (const [li, l] of fgLocs.entries()) {
    for (const [vi, v] of allVariants.entries()) {
      const received = 18 + ((vi * 7 + li * 5) % 22);
      const moves: Array<{ q: number; reason: string; note?: string; ref?: string; daysAgo: number }> = [
        { q: received, reason: 'received', note: `PO-${2400 + li * 10 + vi}`, daysAgo: 21 },
        ...(vi % 3 === 0 ? [{ q: -1, reason: 'damage', note: 'Scuffed in transit — written off', daysAgo: 12 }] : []),
        ...(vi % 4 === 1 ? [{ q: -2, reason: 'count', note: 'Cycle count: 2 fewer than expected', daysAgo: 6 }] : []),
        ...(li === 0 && vi === 0 ? [{ q: -4, reason: 'transfer_out', note: 'Transfer to Montréal', ref: 'TR-0042', daysAgo: 9 }] : []),
        ...(li === 1 && vi === 0 ? [{ q: 4, reason: 'transfer_in', note: 'Transfer from Portland', ref: 'TR-0042', daysAgo: 8 }] : []),
      ];
      let onHand = 0;
      for (const m of moves) {
        onHand += m.q;
        await db.insert(t.stockMovements).values({ organizationId: fgId, locationId: l.id, variantId: v.id, quantity: m.q, reason: m.reason, note: m.note ?? null, reference: m.ref ?? null, createdBy: by[l.id]!.id, createdAt: new Date(Date.now() - m.daysAgo * 86400_000) });
      }
      await db.insert(t.locationVariants).values({ organizationId: fgId, locationId: l.id, variantId: v.id, currency: l.currency, stockOnHand: onHand, reorderPoint: 6, available: true });
    }
    // Paid native orders (sales) and one unpaid order holding a reservation.
    for (let k = 0; k < 4; k++) {
      const v = allVariants[(k * 3 + li) % allVariants.length]!;
      const qty = 1 + (k % 3);
      const price = v.prices[l.currency]!;
      const status = k === 3 ? 'pending_payment' : 'paid';
      const [o] = await db.insert(t.orders).values({ organizationId: fgId, locationId: l.id, source: k === 2 ? 'shopify' : 'native', externalId: k === 2 ? `#${1040 + li * 10 + k}` : null, status, currency: l.currency, subtotalMinor: price * qty, totalMinor: price * qty, lines: [{ variantId: v.id, sku: v.sku, name: v.name, quantity: qty, unitPriceMinor: price }], createdAt: new Date(Date.now() - (k + 1) * 86400_000) }).returning();
      if (status === 'paid' && k !== 2) {
        const [p] = await db.insert(t.paymentReferences).values({ organizationId: fgId, locationId: l.id, provider: 'stripe', externalId: pi(), connectedAccountId: l.stripeAccountId, amountMinor: price * qty, currency: l.currency, state: 'succeeded', succeededAt: new Date(), targetType: 'order', targetId: o!.id, sandbox: 1 }).returning();
        await db.update(t.orders).set({ paymentId: p!.id }).where(eq(t.orders.id, o!.id));
      }
      await db.insert(t.stockMovements).values({ organizationId: fgId, locationId: l.id, variantId: v.id, quantity: -qty, reason: status === 'paid' ? 'sale' : 'reservation', reference: o!.id, createdAt: new Date(Date.now() - (k + 1) * 86400_000 + 60_000) });
      await db.update(t.locationVariants).set(status === 'paid' ? { stockOnHand: sql`${t.locationVariants.stockOnHand} - ${qty}` } : { reserved: sql`${t.locationVariants.reserved} + ${qty}` }).where(and(eq(t.locationVariants.locationId, l.id), eq(t.locationVariants.variantId, v.id)));
    }
  }
  // One item running low in Amsterdam.
  const lowV = allVariants[3]!;
  await db.insert(t.stockMovements).values({ organizationId: fgId, locationId: ams.id, variantId: lowV.id, quantity: -14, reason: 'adjustment', note: 'Display units moved to the window', createdBy: sanne.id });
  await db.update(t.locationVariants).set({ stockOnHand: sql`greatest(${t.locationVariants.stockOnHand} - 14, 0)` }).where(and(eq(t.locationVariants.locationId, ams.id), eq(t.locationVariants.variantId, lowV.id)));
  await db.insert(t.connections).values({ organizationId: fgId, locationId: pdx.id, provider: 'shopify', kind: 'commerce', direction: 'import', authoritative: 'external', state: 'connected', config: { shop: 'fieldnote-demo.myshopify.com' }, lastSuccessAt: new Date(Date.now() - hours(1)) });
  // Large refund for a Portland order (above the USD 100 threshold) requested by the store manager.
  const [bigOrder] = await db.select().from(t.orders).where(and(eq(t.orders.locationId, pdx.id), eq(t.orders.status, 'paid'), sql`${t.orders.paymentId} is not null`)).limit(1);
  if (bigOrder?.paymentId) await refundApproval(db, fgId, pdx, { paymentId: bigOrder.paymentId }, Math.min(bigOrder.totalMinor, 12500), 'USD', olivia, 'Pen nib arrived damaged — customer returned the item', `Refund for order ${bigOrder.id.slice(0, 8)}`);
  await adSpendApproval(db, fgId, ams, sanne, { amountMinor: 45000, channel: 'meta_ads', durationDays: 14, title: 'Amsterdam back-to-school notebooks', description: 'Instagram carousel for students within 3 km.' }, today);
  await scheduleWeek(db, fgId, pdx, today, [{ user: olivia, role: 'Store manager', start: '09:30', end: '17:30', days: [1, 2, 3, 4, 5] }]);
  await scheduleWeek(db, fgId, yul, today, [{ user: luc, role: 'Vendeur', start: '10:00', end: '18:00', days: [0, 3, 4, 5, 6] }]);
  await scheduleWeek(db, fgId, ams, today, [{ user: sanne, role: 'Store manager', start: '09:30', end: '18:00', days: [2, 3, 4, 5, 6] }]);

  return {
    orgs: { northShore: nsId, harbourline: hwId, fieldnote: fgId },
    users: Object.values(userIds).map((u) => u.email),
    prices: nsPrices,
  };
}

/** One week of recurring shifts (local wall time) starting yesterday, so "today" always has shifts. */
async function scheduleWeek(db: Db, orgId: string, loc: Loc, today: string, plan: Array<{ user: User; role: string; start: string; end: string; days: number[] }>, includeYesterday = true) {
  const values: Array<typeof t.shifts.$inferInsert> = [];
  for (let d = includeYesterday ? -1 : 0; d < 8; d++) {
    const date = addDays(today, d);
    const wd = weekdayOf(date);
    for (const p of plan) {
      if (!p.days.includes(wd)) continue;
      values.push({ organizationId: orgId, locationId: loc.id, userId: p.user.id, role: p.role, startsAt: at(loc, date, p.start), endsAt: at(loc, date, p.end), breakMinutes: 30 });
    }
  }
  return values.length ? db.insert(t.shifts).values(values).returning() : [];
}

async function swapRequest(db: Db, orgId: string, loc: Loc, shift: typeof t.shifts.$inferSelect, from: User, to: User, reason: string) {
  const [sw] = await db.insert(t.shiftSwapRequests).values({ organizationId: orgId, locationId: loc.id, shiftId: shift.id, requestedBy: from.id, toUserId: to.id, reason }).returning();
  const when = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: loc.timeZone }).format(shift.startsAt);
  const [ap] = await db.insert(t.approvals).values({
    organizationId: orgId, locationId: loc.id, targetType: 'shift_swap', targetId: sw!.id, title: `${shift.role} · ${when}`, requestedBy: from.id, requestComment: reason, createdAt: new Date(Date.now() - hours(3)),
    payload: { shiftId: shift.id, toShiftId: null, from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, shift: { role: shift.role, startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(), timeZone: loc.timeZone } },
  }).returning();
  await db.update(t.shiftSwapRequests).set({ approvalId: ap!.id }).where(eq(t.shiftSwapRequests.id, sw!.id));
}

async function refundApproval(db: Db, orgId: string, loc: Loc, target: { paymentId: string }, amountMinor: number, currency: string, by: User, reason: string, title: string) {
  await db.insert(t.approvals).values({
    organizationId: orgId, locationId: loc.id, targetType: 'refund', targetId: target.paymentId, title, amountMinor, currency, requestedBy: by.id, requestComment: reason, createdAt: new Date(Date.now() - hours(5)),
    payload: { paymentId: target.paymentId, orderId: null, amountMinor, currency, reason, restock: [] },
  });
}

async function adSpendApproval(db: Db, orgId: string, loc: Loc, by: User, a: { amountMinor: number; channel: string; durationDays: number; title: string; description: string }, today: string) {
  const startsOn = addDays(today, 7);
  const [cmp] = await db.insert(t.campaigns).values({ organizationId: orgId, scopeKind: 'location', scopeId: loc.id, name: a.title, channel: a.channel, status: 'pending_approval', content: { adSpend: { durationDays: a.durationDays, startsOn, description: a.description } }, budgetMinor: a.amountMinor, currency: loc.currency, createdBy: by.id }).returning();
  await db.insert(t.approvals).values({
    organizationId: orgId, locationId: loc.id, targetType: 'ad_spend', targetId: cmp!.id, title: a.title, amountMinor: a.amountMinor, currency: loc.currency, requestedBy: by.id, requestComment: a.description, createdAt: new Date(Date.now() - hours(26)),
    payload: { campaignId: cmp!.id, channel: a.channel, durationDays: a.durationDays, startsOn, description: a.description },
  });
}

/** Rows without an FK cascade to organizations, cleared before the demo orgs are recreated. */
export async function clearOperationsDemo(db: Db, orgIds: string[]) {
  if (!orgIds.length) return;
  await db.delete(t.pushNotifications).where(inArray(t.pushNotifications.organizationId, orgIds));
}
