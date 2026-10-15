/**
 * Hospitality demo (sample data only): Tidewater Stays — a small group with a hotel in Lisbon (EUR, restaurant outlet),
 * serviced apartments in Vancouver (CAD), a B&B in London (GBP) and a hostel with dorm beds in Sydney (AUD).
 * Room types, rooms, rate plans (flexible, non-refundable, bed & breakfast), seasons, weekday prices, policies, taxes
 * (labelled sample values — real amounts are entered by the business), reservations across the stay lifecycle with
 * room assignments, folios and housekeeping tasks. Inventory counters are written through the same service as bookings.
 * Re-running replaces the organisation.
 */
import { eq, inArray } from 'drizzle-orm';
import { addDaysIso, stayNights } from '@bh/shared';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { localDateParts } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { adjustInventory, dailyRowsFor, quoteRoom, rateContext } from '../services/hospitality.ts';
import { generateTasks } from '../services/hospitality-ops.ts';

export const HOSPITALITY_DEMO_SLUG = 'tidewater-stays';
type User = typeof t.users.$inferSelect;
const img = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1400&q=70`;
const IMG = {
  lobby: img('1566073771259-6a8506099945'), room: img('1611892440504-42a792e24d32'), room2: img('1590490360182-c33d57733427'), suite: img('1578683010236-d716f9a3f461'),
  apt: img('1522708323590-d24dbb6b0267'), apt2: img('1502672260266-1c1ef2d93688'), bnb: img('1505693416388-ac5ce068fe85'), dorm: img('1555854877-bab0e564b8d5'), hostel: img('1520277739336-7bf67edfa768'),
};

export async function clearHospitalityDemo(db: Db) {
  const old = await db.select({ id: t.organizations.id }).from(t.organizations).where(eq(t.organizations.slug, HOSPITALITY_DEMO_SLUG));
  if (!old.length) return;
  const ids = old.map((o) => o.id);
  for (const tbl of [t.auditEvents, t.consentRecords] as const) await db.delete(tbl).where(inArray((tbl as typeof t.auditEvents).organizationId, ids));
  await db.delete(t.organizations).where(inArray(t.organizations.id, ids));
}

export async function seedHospitality(c: { db: Db; upsertUser: (email: string, name: string, locale?: string) => Promise<User>; demo: User }) {
  const { db } = c;
  await clearHospitalityDemo(db);
  const done = Object.fromEntries(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'invite_staff'].map((k) => [k, { status: 'complete' as const, updatedAt: new Date().toISOString() }]));
  const [org] = await db.insert(t.organizations).values({
    slug: HOSPITALITY_DEMO_SLUG, name: 'Tidewater Stays', industry: 'hospitality', model: 'network', country: 'PT', defaultCurrency: 'EUR', defaultLocale: 'en', defaultTimeZone: 'Europe/Lisbon',
    dataRegion: 'eu', onboarding: done, settings: { site: { tagline: 'Small hotels, big welcomes.', primaryColor: '#1F5F7A', font: 'plus-jakarta-sans', enabledLocales: ['en', 'fr', 'es', 'de'] } },
  }).returning();
  const orgId = org!.id;
  const L = (o: Partial<typeof t.locations.$inferInsert> & Pick<typeof t.locations.$inferInsert, 'name' | 'code' | 'slug' | 'address' | 'country' | 'timeZone' | 'currency'>) => ({ organizationId: orgId, status: 'operating', publiclyVisible: true, paymentsEnabled: true, ...o });
  const locs = await db.insert(t.locations).values([
    L({ name: 'Tidewater Alfama', code: 'LIS', slug: 'lisbon-alfama', address: { line1: 'Rua de São Miguel 18', city: 'Lisboa', postalCode: '1100-544', country: 'PT' }, country: 'PT', timeZone: 'Europe/Lisbon', currency: 'EUR', locale: 'pt-PT', phone: '+351 21 555 0118', email: 'alfama@tidewater-demo.example', stripeAccountId: 'acct_sandbox_tw_lis', geo: { lat: 38.7116, lng: -9.1300 } }),
    L({ name: 'Tidewater Gastown Suites', code: 'VAN', slug: 'vancouver-gastown', address: { line1: '12 Water St', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A4', country: 'CA' }, country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', locale: 'en', phone: '+1 604 555 0112', email: 'gastown@tidewater-demo.example', stripeAccountId: 'acct_sandbox_tw_van', geo: { lat: 49.2843, lng: -123.1065 } }),
    L({ name: 'Tidewater House Islington', code: 'LON', slug: 'london-islington', address: { line1: '41 Canonbury Square', city: 'London', postalCode: 'N1 2AN', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', phone: '+44 20 7946 0141', email: 'islington@tidewater-demo.example', stripeAccountId: 'acct_sandbox_tw_lon', geo: { lat: 51.5432, lng: -0.1006 } }),
    L({ name: 'Tidewater Bondi Hostel', code: 'SYD', slug: 'sydney-bondi', address: { line1: '75 Hall St', city: 'Bondi Beach', region: 'NSW', postalCode: '2026', country: 'AU' }, country: 'AU', timeZone: 'Australia/Sydney', currency: 'AUD', locale: 'en-GB', phone: '+61 2 5550 0175', email: 'bondi@tidewater-demo.example', stripeAccountId: 'acct_sandbox_tw_syd', geo: { lat: -33.8915, lng: 151.2767 } }),
  ]).returning();
  const by = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<'LIS' | 'VAN' | 'LON' | 'SYD', typeof locs[number]>;
  const todayAt = (code: keyof typeof by) => localDateParts(new Date(), by[code].timeZone).date;

  await db.insert(t.hospProperties).values([
    { organizationId: orgId, locationId: by.LIS.id, kind: 'hotel', description: 'A 12-room townhouse hotel above the river in Alfama, with a small tasca on the ground floor.', amenities: ['Wi-Fi', 'Air conditioning', 'Roof terrace', 'Restaurant', 'Luggage storage'], photos: [{ url: IMG.lobby, alt: 'Lobby' }], checkInTime: '15:00', checkOutTime: '11:00', requireInspected: true, registrationFields: [{ key: 'nationality', label: 'Nationality', kind: 'country', required: true }, { key: 'document_number', label: 'Passport or ID number', kind: 'document_number', required: true }, { key: 'date_of_birth', label: 'Date of birth', kind: 'date', required: true }], registrationRetentionDays: 365, houseRules: 'Quiet hours 23:00–08:00. No smoking indoors.', arrivalInstructions: 'Reception is open 24 hours; ring the bell after midnight.', outletEnabled: true, outletName: 'Tasca do Largo' },
    { organizationId: orgId, locationId: by.VAN.id, kind: 'serviced_apartments', description: 'Studio and one-bedroom apartments with kitchens in a restored Gastown warehouse.', amenities: ['Wi-Fi', 'Kitchen', 'Washer/dryer', 'Gym', 'Self check-in'], photos: [{ url: IMG.apt, alt: 'Apartment living room' }], checkInTime: '16:00', checkOutTime: '11:00', registrationFields: [], houseRules: 'No parties. Quiet hours after 22:00.', arrivalInstructions: 'Your door code is sent on the morning of arrival.' },
    { organizationId: orgId, locationId: by.LON.id, kind: 'guesthouse', description: 'A five-room Georgian B&B on a garden square, breakfast cooked to order.', amenities: ['Wi-Fi', 'Breakfast', 'Garden'], photos: [{ url: IMG.bnb, alt: 'Guest room' }], checkInTime: '14:00', checkOutTime: '10:30', registrationFields: [], houseRules: 'Breakfast 7:30–10:00.' },
    { organizationId: orgId, locationId: by.SYD.id, kind: 'hostel', description: 'Beach hostel with mixed and female dorms plus private doubles, two minutes from the sand.', amenities: ['Wi-Fi', 'Lockers', 'Shared kitchen', 'Surfboard storage'], photos: [{ url: IMG.hostel, alt: 'Hostel common room' }], checkInTime: '14:00', checkOutTime: '10:00', registrationFields: [{ key: 'nationality', label: 'Nationality', kind: 'country', required: false }], houseRules: 'Lockers need your own padlock. No alcohol in dorms.' },
  ]);

  // Room types and rooms.
  const RT = (loc: keyof typeof by, o: Omit<typeof t.hospRoomTypes.$inferInsert, 'organizationId' | 'locationId'>) => ({ organizationId: orgId, locationId: by[loc].id, ...o });
  const types = await db.insert(t.hospRoomTypes).values([
    RT('LIS', { code: 'CLS', name: 'Classic Double', kind: 'room', beds: [{ type: 'double', count: 1 }], baseOccupancy: 2, maxOccupancy: 2, sizeSqm: 16, amenities: ['Shower', 'Air conditioning', 'Safe'], photos: [{ url: IMG.room }], sortOrder: 1, description: 'Quiet room facing the courtyard.' }),
    RT('LIS', { code: 'RIV', name: 'River View Double', kind: 'room', beds: [{ type: 'queen', count: 1 }], baseOccupancy: 2, maxOccupancy: 3, sizeSqm: 22, amenities: ['River view', 'Bathtub', 'Air conditioning'], photos: [{ url: IMG.room2 }], sortOrder: 2, description: 'Tagus views from the window seat.' }),
    RT('LIS', { code: 'STE', name: 'Terrace Suite', kind: 'room', beds: [{ type: 'king', count: 1 }, { type: 'sofa_bed', count: 1 }], baseOccupancy: 2, maxOccupancy: 4, sizeSqm: 34, amenities: ['Private terrace', 'Bathtub', 'Coffee machine'], photos: [{ url: IMG.suite }], sortOrder: 3, description: 'Top-floor suite with a private terrace.' }),
    RT('VAN', { code: 'STU', name: 'Studio Apartment', kind: 'apartment', beds: [{ type: 'queen', count: 1 }], baseOccupancy: 2, maxOccupancy: 2, sizeSqm: 32, amenities: ['Kitchenette', 'Washer/dryer'], photos: [{ url: IMG.apt2 }], sortOrder: 1 }),
    RT('VAN', { code: '1BR', name: 'One-Bedroom Apartment', kind: 'apartment', beds: [{ type: 'king', count: 1 }, { type: 'sofa_bed', count: 1 }], baseOccupancy: 2, maxOccupancy: 4, sizeSqm: 55, amenities: ['Full kitchen', 'Washer/dryer', 'Balcony'], photos: [{ url: IMG.apt }], sortOrder: 2 }),
    RT('LON', { code: 'DBL', name: 'Garden Double', kind: 'room', beds: [{ type: 'double', count: 1 }], baseOccupancy: 2, maxOccupancy: 2, sizeSqm: 15, amenities: ['En-suite shower'], photos: [{ url: IMG.bnb }], sortOrder: 1 }),
    RT('LON', { code: 'TWN', name: 'Twin Room', kind: 'room', beds: [{ type: 'single', count: 2 }], baseOccupancy: 2, maxOccupancy: 2, sizeSqm: 14, amenities: ['En-suite shower'], photos: [{ url: IMG.room }], sortOrder: 2 }),
    RT('SYD', { code: 'MIX6', name: 'Bed in 6-bed mixed dorm', kind: 'dorm', beds: [{ type: 'bunk', count: 3 }], baseOccupancy: 1, maxOccupancy: 1, amenities: ['Locker', 'Reading light'], photos: [{ url: IMG.dorm }], sortOrder: 1 }),
    RT('SYD', { code: 'FEM4', name: 'Bed in 4-bed female dorm', kind: 'dorm', beds: [{ type: 'bunk', count: 2 }], baseOccupancy: 1, maxOccupancy: 1, amenities: ['Locker', 'En-suite'], photos: [{ url: IMG.dorm }], sortOrder: 2 }),
    RT('SYD', { code: 'PRV', name: 'Private Double', kind: 'room', beds: [{ type: 'double', count: 1 }], baseOccupancy: 2, maxOccupancy: 2, amenities: ['Shared bathroom'], photos: [{ url: IMG.room2 }], sortOrder: 3 }),
  ]).returning();
  const T = Object.fromEntries(types.map((x) => [`${locs.find((l) => l.id === x.locationId)!.code}.${x.code}`, x]));
  const roomRows: Array<typeof t.hospRooms.$inferInsert> = [];
  const add = (key: string, numbers: string[], floor?: string) => numbers.forEach((n, i) => roomRows.push({ organizationId: orgId, locationId: T[key]!.locationId, roomTypeId: T[key]!.id, number: n, floor: floor ?? n.slice(0, 1), sortOrder: i }));
  add('LIS.CLS', ['101', '102', '103', '104', '201', '202']);
  add('LIS.RIV', ['203', '301', '302', '303']);
  add('LIS.STE', ['401', '402']);
  add('VAN.STU', ['2A', '2B', '3A', '3B']);
  add('VAN.1BR', ['4A', '4B', '5A']);
  add('LON.DBL', ['1', '2', '3'], 'G');
  add('LON.TWN', ['4', '5'], '1');
  add('SYD.MIX6', ['D1', 'D2'], '1');
  add('SYD.FEM4', ['D3'], '1');
  add('SYD.PRV', ['P1', 'P2'], '2');
  const rooms = await db.insert(t.hospRooms).values(roomRows).returning();
  const R = (code: string, number: string) => rooms.find((r) => r.locationId === by[code as 'LIS'].id && r.number === number)!;
  const bedRows = rooms.filter((r) => r.number.startsWith('D')).flatMap((r) => Array.from({ length: r.number === 'D3' ? 4 : 6 }, (_, i) => ({ organizationId: orgId, roomId: r.id, label: String.fromCharCode(65 + i) })));
  const beds = await db.insert(t.hospBeds).values(bedRows).returning();
  // Housekeeping state: a couple of dirty rooms, one inspected, one out of order (maintenance).
  await db.update(t.hospRooms).set({ hkStatus: 'inspected' }).where(inArray(t.hospRooms.id, [R('LIS', '101').id, R('LIS', '203').id, R('LIS', '401').id]));
  await db.update(t.hospRooms).set({ hkStatus: 'dirty' }).where(inArray(t.hospRooms.id, [R('LIS', '104').id, R('VAN', '3A').id, R('LON', '2').id]));
  await db.update(t.hospRooms).set({ hkStatus: 'out_of_order' }).where(eq(t.hospRooms.id, R('LIS', '202').id));
  await db.insert(t.hospRoomBlocks).values({ organizationId: orgId, locationId: by.LIS.id, roomId: R('LIS', '202').id, startDate: todayAt('LIS'), endDate: addDaysIso(todayAt('LIS'), 3), reason: 'Shower leak — plumber booked' });

  // Policies, plans, seasons, prices and (sample) taxes per property.
  const plans: Record<string, { bar: string; nr: string; bb?: string }> = {};
  const setup = async (code: keyof typeof by, cfg: { prices: Record<string, number>; weekend: number; season?: { name: string; from: number; to: number; uplift: number; minStay: number }; bb?: number; taxes: Array<Omit<typeof t.hospTaxes.$inferInsert, 'organizationId' | 'locationId' | 'currency'>> }) => {
    const loc = by[code];
    const [flex, nrp] = await db.insert(t.hospCancellationPolicies).values([
      { organizationId: orgId, locationId: loc.id, name: 'Flexible — free until 48 hours before arrival', nonRefundable: false, freeUntilHours: 48, lateFee: { type: 'first_night' }, noShowFee: { type: 'first_night' } },
      { organizationId: orgId, locationId: loc.id, name: 'Non-refundable', nonRefundable: true, freeUntilHours: null, lateFee: { type: 'full' }, noShowFee: { type: 'full' } },
    ]).returning();
    const [bar] = await db.insert(t.hospRatePlans).values({ organizationId: orgId, locationId: loc.id, code: 'BAR', name: 'Flexible rate', kind: 'bar', currency: loc.currency, depositRule: 'first_night', cancellationPolicyId: flex!.id, sortOrder: 1, description: 'Free cancellation until 48 hours before arrival.' }).returning();
    const [nr] = await db.insert(t.hospRatePlans).values({ organizationId: orgId, locationId: loc.id, code: 'NR', name: 'Advance saver (non-refundable)', kind: 'non_refundable', currency: loc.currency, derivedFromId: bar!.id, adjustmentBps: -1200, depositRule: 'full', cancellationPolicyId: nrp!.id, sortOrder: 2, description: '12% off, paid in full at booking.' }).returning();
    plans[code] = { bar: bar!.id, nr: nr!.id };
    if (cfg.bb !== undefined) {
      const [bb] = await db.insert(t.hospRatePlans).values({ organizationId: orgId, locationId: loc.id, code: 'BB', name: 'Bed & breakfast', kind: 'package', currency: loc.currency, includesBreakfast: true, inclusions: ['Breakfast for all guests'], derivedFromId: bar!.id, adjustmentBps: cfg.bb, depositRule: 'first_night', cancellationPolicyId: flex!.id, sortOrder: 3 }).returning();
      plans[code]!.bb = bb!.id;
    }
    let seasonId: string | null = null;
    const today = todayAt(code);
    if (cfg.season) {
      const [se] = await db.insert(t.hospSeasons).values({ organizationId: orgId, locationId: loc.id, name: cfg.season.name, startDate: addDaysIso(today, cfg.season.from), endDate: addDaysIso(today, cfg.season.to), minStay: cfg.season.minStay, priority: 1 }).returning();
      seasonId = se!.id;
    }
    const priceRows: Array<typeof t.hospRatePrices.$inferInsert> = [];
    for (const [typeCode, amount] of Object.entries(cfg.prices)) {
      const rt = T[`${code}.${typeCode}`]!;
      const weekendAmt = Math.round(amount * (1 + cfg.weekend));
      priceRows.push({ organizationId: orgId, ratePlanId: bar!.id, roomTypeId: rt.id, seasonId: null, currency: loc.currency, amountMinor: amount, weekdayAmounts: { '5': weekendAmt, '6': weekendAmt }, extraAdultMinor: rt.maxOccupancy > 2 ? Math.round(amount * 0.2) : null, extraChildMinor: rt.maxOccupancy > 2 ? Math.round(amount * 0.1) : null });
      if (seasonId && cfg.season) priceRows.push({ organizationId: orgId, ratePlanId: bar!.id, roomTypeId: rt.id, seasonId, currency: loc.currency, amountMinor: Math.round(amount * (1 + cfg.season.uplift)), weekdayAmounts: {}, extraAdultMinor: rt.maxOccupancy > 2 ? Math.round(amount * 0.2) : null });
    }
    await db.insert(t.hospRatePrices).values(priceRows);
    if (cfg.taxes.length) await db.insert(t.hospTaxes).values(cfg.taxes.map((x) => ({ organizationId: orgId, locationId: loc.id, currency: loc.currency, ...x })));
  };
  const SAMPLE = 'Sample value for the demo — the business enters its own rates.';
  await setup('LIS', { prices: { CLS: 11_500, RIV: 15_500, STE: 24_000 }, weekend: 0.15, bb: 1200, season: { name: 'Santo António festival', from: 20, to: 34, uplift: 0.35, minStay: 2 }, taxes: [{ name: 'VAT (included)', kind: 'percent', rateBps: 600, inclusive: true, note: SAMPLE }, { name: 'City tourist tax', kind: 'per_person_per_night', amountMinor: 400, maxNights: 7, appliesToChildren: false, note: SAMPLE }] });
  await setup('VAN', { prices: { STU: 21_900, '1BR': 31_900 }, weekend: 0.1, season: { name: 'Summer', from: 30, to: 90, uplift: 0.25, minStay: 3 }, taxes: [{ name: 'Accommodation taxes', kind: 'percent', rateBps: 1600, inclusive: false, note: SAMPLE }] });
  await setup('LON', { prices: { DBL: 14_500, TWN: 13_500 }, weekend: 0.12, bb: 0, taxes: [{ name: 'VAT (included)', kind: 'percent', rateBps: 2000, inclusive: true, note: SAMPLE }] });
  await setup('SYD', { prices: { MIX6: 4_900, FEM4: 5_500, PRV: 13_900 }, weekend: 0.2, taxes: [] });
  // London is B&B only: the package costs the same as the room rate.
  await db.update(t.hospRatePlans).set({ bookableOnline: false }).where(eq(t.hospRatePlans.id, plans.LON!.bar));

  // People.
  const ines = await c.upsertUser('ines.costa@demo.branchharbor.com', 'Inês Costa', 'pt-BR');
  const rui = await c.upsertUser('rui.matos@demo.branchharbor.com', 'Rui Matos', 'en');
  const chloe = await c.upsertUser('chloe.martin@demo.branchharbor.com', 'Chloé Martin', 'fr');
  await db.insert(t.roleAssignments).values([
    { organizationId: orgId, userId: c.demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: orgId },
    { organizationId: orgId, userId: ines.id, role: 'location_manager', scopeKind: 'location', scopeId: by.LIS.id },
    { organizationId: orgId, userId: rui.id, role: 'staff', scopeKind: 'location', scopeId: by.LIS.id },
    { organizationId: orgId, userId: chloe.id, role: 'staff', scopeKind: 'location', scopeId: by.LON.id },
  ]).onConflictDoNothing();
  await db.insert(t.subscriptions).values({ organizationId: orgId, plan: 'network', status: 'active', billedLocationCount: 4, currency: 'EUR' });

  // Reservations across the lifecycle. Inventory goes through the same counters as live bookings.
  let n = 0;
  const stay = async (code: keyof typeof by, o: { type: string; plan?: 'bar' | 'nr' | 'bb'; from: number; nights: number; status: 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled'; guest: string; adults?: number; room?: string; bed?: string; group?: string; rooms?: number; source?: string }) => {
    const loc = by[code];
    const today = todayAt(code);
    const arrival = addDaysIso(today, o.from);
    const departure = addDaysIso(arrival, o.nights);
    const ctx = await rateContext(db, loc.id);
    const daily = await dailyRowsFor(db, ctx.plans.map((p) => p.id), arrival, departure);
    const rt = T[`${code}.${o.type}`]!;
    const planId = plans[code]![o.plan ?? 'bar']!;
    const adults = rt.kind === 'dorm' ? 1 : o.adults ?? 2;
    const q = quoteRoom(ctx, daily, { roomTypeId: rt.id, ratePlanId: planId, arrival, departure, adults, children: 0 });
    if (!q.ok) throw new Error(`seed quote failed for ${code} ${o.type}: ${q.reason}`);
    const count = o.rooms ?? 1;
    const policy = ctx.policies.find((p) => p.id === q.plan!.cancellationPolicyId)!;
    n += 1;
    const email = `${o.guest.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
    const [cust] = await db.insert(t.customers).values({ organizationId: orgId, locationId: loc.id, name: o.guest, email }).returning();
    const deposit = q.depositMinor * count;
    const paid = o.status === 'cancelled' ? 0 : deposit;
    const [r] = await db.insert(t.hospReservations).values({
      organizationId: orgId, locationId: loc.id, code: `${code}-${String(10_000 + n * 37).slice(-5)}`, status: o.status, source: o.source ?? 'website', arrival, departure, adults: adults * count, children: 0, groupName: o.group ?? null,
      customerId: cust!.id, guestName: o.guest, guestEmail: email, currency: loc.currency, roomTotalMinor: q.roomTotalMinor * count, taxAddedMinor: q.taxAddedMinor * count, totalMinor: q.totalMinor * count,
      depositRequiredMinor: deposit, depositPaidMinor: paid, cancellationPolicy: { name: policy.name, nonRefundable: policy.nonRefundable, freeUntilHours: policy.freeUntilHours, lateFee: policy.lateFee, noShowFee: policy.noShowFee },
      messageConsent: { email: n % 2 === 0, sms: false }, manageTokenHash: sha256(`seed-stay-${n}`), cancelledAt: o.status === 'cancelled' ? new Date() : null, cancellationFeeMinor: o.status === 'cancelled' ? 0 : null,
      checkedInAt: ['checked_in', 'checked_out'].includes(o.status) ? new Date() : null, checkedOutAt: o.status === 'checked_out' ? new Date() : null,
      registration: o.status === 'checked_in' && code === 'LIS' ? { nationality: 'FR', document_number: 'SAMPLE-0000', date_of_birth: '1990-01-01' } : null,
      timeline: [{ at: new Date().toISOString(), by: null, action: o.status, note: 'Demo data' }],
    }).returning();
    for (let i = 0; i < count; i += 1) {
      const [rr] = await db.insert(t.hospReservationRooms).values({ organizationId: orgId, reservationId: r!.id, roomTypeId: rt.id, ratePlanId: planId, adults, children: 0, nights: q.nights, taxes: q.taxes, roomTotalMinor: q.roomTotalMinor, taxAddedMinor: q.taxAddedMinor, totalMinor: q.totalMinor }).returning();
      if (o.status !== 'cancelled') {
        await db.transaction((tx) => adjustInventory(tx, orgId, loc.id, stayNights(arrival, departure).map((d) => ({ roomTypeId: rt.id, date: d, delta: 1 }))));
        if (o.room && i === 0) {
          const room = R(code, o.room);
          const bed = o.bed ? beds.find((b) => b.roomId === room.id && b.label === o.bed) : undefined;
          await db.insert(t.hospAssignments).values(stayNights(arrival, departure).map((d) => ({ organizationId: orgId, locationId: loc.id, reservationRoomId: rr!.id, roomId: room.id, bedId: bed?.id ?? null, date: d })));
          await db.update(t.hospReservationRooms).set({ roomId: room.id, bedId: bed?.id ?? null }).where(eq(t.hospReservationRooms.id, rr!.id));
          if (['checked_in', 'checked_out'].includes(o.status)) {
            await db.insert(t.hospFolioLines).values([
              ...q.nights.map((x) => ({ organizationId: orgId, locationId: loc.id, reservationId: r!.id, kind: 'room', description: `Room ${room.number}${bed ? ` bed ${bed.label}` : ''} — night of ${x.date}`, serviceDate: x.date, amountMinor: x.amountMinor, currency: loc.currency, sourceType: 'room_night', sourceId: `${rr!.id}:${x.date}` })),
              ...q.taxes.filter((x) => !x.inclusive && x.amountMinor > 0).map((x, j) => ({ organizationId: orgId, locationId: loc.id, reservationId: r!.id, kind: 'tax', description: `${x.name} — room ${room.number}`, serviceDate: arrival, amountMinor: x.amountMinor, currency: loc.currency, sourceType: 'room_tax', sourceId: `${rr!.id}:${j}` })),
            ]);
          }
        }
      }
    }
    if (paid > 0) await db.insert(t.hospFolioLines).values({ organizationId: orgId, locationId: loc.id, reservationId: r!.id, kind: 'payment', description: 'Deposit (card, online) — demo', amountMinor: -paid, currency: loc.currency, method: 'card_online', sourceType: 'seed_payment', sourceId: r!.id });
    if (o.status === 'checked_out') {
      const bal = q.totalMinor * count - paid;
      if (bal > 0) await db.insert(t.hospFolioLines).values({ organizationId: orgId, locationId: loc.id, reservationId: r!.id, kind: 'payment', description: 'Card terminal at check-out — demo', amountMinor: -bal, currency: loc.currency, method: 'card_terminal' });
    }
    return r!;
  };

  // Lisbon: in-house guests, arrivals today (one unassigned), departures, a group, future bookings and a cancellation.
  await stay('LIS', { type: 'RIV', from: -2, nights: 4, status: 'checked_in', guest: 'Camille Dubois', room: '301' });
  await stay('LIS', { type: 'CLS', from: -1, nights: 3, status: 'checked_in', guest: 'Jonas Becker', room: '102', plan: 'bb' });
  await stay('LIS', { type: 'STE', from: -3, nights: 3, status: 'checked_in', guest: 'Priya Natarajan', room: '402' });
  await stay('LIS', { type: 'CLS', from: 0, nights: 2, status: 'confirmed', guest: 'Lucía Fernández', room: '101' });
  await stay('LIS', { type: 'RIV', from: 0, nights: 3, status: 'confirmed', guest: 'Tom Okafor' });
  await stay('LIS', { type: 'CLS', from: 2, nights: 2, status: 'confirmed', guest: 'Sofia Rossi', group: 'Rossi wedding party', rooms: 3, source: 'email' });
  await stay('LIS', { type: 'STE', from: 5, nights: 4, status: 'confirmed', guest: 'Hannah Schmidt', plan: 'nr' });
  await stay('LIS', { type: 'RIV', from: 9, nights: 2, status: 'confirmed', guest: 'Mateo García' });
  await stay('LIS', { type: 'CLS', from: 22, nights: 3, status: 'confirmed', guest: 'Aiko Tanaka' });
  await stay('LIS', { type: 'CLS', from: 6, nights: 2, status: 'cancelled', guest: 'Ben Carter' });
  await stay('LIS', { type: 'CLS', from: -5, nights: 3, status: 'checked_out', guest: 'Olivia Brown', room: '103' });
  // Vancouver
  await stay('VAN', { type: '1BR', from: -4, nights: 7, status: 'checked_in', guest: 'Ethan Walker', room: '4A' });
  await stay('VAN', { type: 'STU', from: 0, nights: 5, status: 'confirmed', guest: 'Grace Liu', room: '2A' });
  await stay('VAN', { type: 'STU', from: 3, nights: 14, status: 'confirmed', guest: 'Noah Tremblay', plan: 'nr' });
  await stay('VAN', { type: '1BR', from: 1, nights: 3, status: 'confirmed', guest: 'Maya Singh' });
  // London (B&B)
  await stay('LON', { type: 'DBL', from: -1, nights: 2, status: 'checked_in', guest: 'Oliver Hughes', room: '1', plan: 'bb' });
  await stay('LON', { type: 'TWN', from: 0, nights: 1, status: 'confirmed', guest: 'Amelia Clarke', plan: 'bb', room: '4' });
  await stay('LON', { type: 'DBL', from: 4, nights: 3, status: 'confirmed', guest: 'Isla Murray', plan: 'bb' });
  // Sydney (dorm beds and privates)
  await stay('SYD', { type: 'MIX6', from: -1, nights: 4, status: 'checked_in', guest: 'Lukas Weber', room: 'D1', bed: 'A' });
  await stay('SYD', { type: 'MIX6', from: -1, nights: 4, status: 'checked_in', guest: 'Emma Johansson', room: 'D1', bed: 'B' });
  await stay('SYD', { type: 'FEM4', from: 0, nights: 3, status: 'confirmed', guest: 'Chloe Nguyen', room: 'D3', bed: 'A' });
  await stay('SYD', { type: 'PRV', from: 2, nights: 2, status: 'confirmed', guest: 'Jack Wilson' });

  for (const code of ['LIS', 'VAN', 'LON', 'SYD'] as const) await generateTasks(db, by[code], todayAt(code));
  await db.insert(t.hospHkTasks).values({ organizationId: orgId, locationId: by.LIS.id, roomId: R('LIS', '202').id, date: todayAt('LIS'), kind: 'maintenance', priority: 2, notes: 'Shower leak — plumber booked' });
  await db.update(t.hospHkTasks).set({ assigneeUserId: rui.id }).where(eq(t.hospHkTasks.locationId, by.LIS.id));

  // Restaurant outlet (Foods engine) for the Lisbon hotel.
  const [menu] = await db.insert(t.menus).values({ organizationId: orgId, name: 'Tasca do Largo', status: 'published', publishedAt: new Date(), description: 'Hotel restaurant — charge to your room.' }).returning();
  await db.insert(t.menuItems).values([
    { organizationId: orgId, menuId: menu!.id, category: 'Breakfast', name: 'Pastel de nata & coffee', prices: { EUR: 450 }, sortOrder: 1 },
    { organizationId: orgId, menuId: menu!.id, category: 'Mains', name: 'Bacalhau à Brás', prices: { EUR: 1650 }, sortOrder: 2, allergens: ['fish', 'eggs'], allergensDeclared: true },
    { organizationId: orgId, menuId: menu!.id, category: 'Mains', name: 'Grilled sardines', prices: { EUR: 1450 }, sortOrder: 3, allergens: ['fish'], allergensDeclared: true },
    { organizationId: orgId, menuId: menu!.id, category: 'Drinks', name: 'Vinho verde (glass)', prices: { EUR: 600 }, sortOrder: 4, dietary: ['contains-alcohol'] },
  ]);

  return { orgId, slug: HOSPITALITY_DEMO_SLUG, users: [ines.email, rui.email, chloe.email], properties: locs.length, rooms: rooms.length };
}
