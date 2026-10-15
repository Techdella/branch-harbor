import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { addDaysIso, cancellationFee, hkTransition, hotelKpis, noShowFee, quoteStay, taxLines, type StayQuoteInput } from '@bh/shared';
import { hospHkTasks, hospInventory, hospReservations, menuItems, menus } from '../src/db/schema/index.ts';
import { localDateParts } from '../src/lib/tz.ts';
import { expireHolds } from '../src/services/hospitality.ts';
import { runGuestMessages } from '../src/services/hospitality-ops.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, verifiedUser } from './helpers.ts';

const base: StayQuoteInput = {
  arrival: '2027-03-05', departure: '2027-03-08', adults: 2, children: 0, baseOccupancy: 2, maxOccupancy: 3,
  plan: { minStay: null, maxStay: null, adjustmentBps: null, deposit: { rule: 'first_night' } },
  prices: [{ seasonId: null, amountMinor: 10_000, weekdayAmounts: { '6': 13_000 } }, { seasonId: 'hi', amountMinor: 15_000, extraAdultMinor: 2_000 }],
  seasons: [{ id: 'hi', startDate: '2027-03-07', endDate: '2027-03-31', minStay: 2 }],
  dailyPrices: [], restrictions: [], taxes: [],
};

describe('hospitality: pure rules', () => {
  it('prices each night from base, weekday, season and daily override, and applies derived-plan adjustments', () => {
    // 2027-03-05 Fri (base 100), 03-06 Sat (weekday 130), 03-07 Sun in season (150).
    const q = quoteStay(base);
    expect(q.ok && q.nights.map((n) => [n.amountMinor, n.source])).toEqual([[10_000, 'base'], [13_000, 'base'], [15_000, 'season']]);
    expect(q.ok && q.totalMinor).toBe(38_000);
    expect(q.ok && q.depositMinor).toBe(10_000);
    const over = quoteStay({ ...base, dailyPrices: [{ date: '2027-03-06', amountMinor: 9_000 }] });
    expect(over.ok && over.nights[1]!.amountMinor).toBe(9_000);
    const nr = quoteStay({ ...base, plan: { ...base.plan, adjustmentBps: -1000, deposit: { rule: 'full' } } });
    expect(nr.ok && nr.nights.map((n) => n.amountMinor)).toEqual([9_000, 11_700, 13_500]);
    expect(nr.ok && nr.depositMinor).toBe(nr.ok ? nr.totalMinor : -1);
    const three = quoteStay({ ...base, adults: 3 });
    expect(three.ok && three.nights[2]!.amountMinor).toBe(17_000); // season extra adult
  });

  it('enforces min/max stay (strictest of plan, season, arrival day), closed, CTA and CTD', () => {
    expect(quoteStay({ ...base, arrival: '2027-03-08', departure: '2027-03-09' })).toMatchObject({ ok: false, reason: 'min_stay', detail: { minStay: 2 } });
    expect(quoteStay({ ...base, plan: { ...base.plan, minStay: 4 } })).toMatchObject({ ok: false, reason: 'min_stay' });
    expect(quoteStay({ ...base, plan: { ...base.plan, maxStay: 2 } })).toMatchObject({ ok: false, reason: 'max_stay' });
    expect(quoteStay({ ...base, restrictions: [{ date: '2027-03-05', closedToArrival: true }] })).toMatchObject({ ok: false, reason: 'closed_to_arrival' });
    expect(quoteStay({ ...base, restrictions: [{ date: '2027-03-08', closedToDeparture: true }] })).toMatchObject({ ok: false, reason: 'closed_to_departure' });
    expect(quoteStay({ ...base, restrictions: [{ date: '2027-03-06', closed: true }] })).toMatchObject({ ok: false, reason: 'closed' });
    expect(quoteStay({ ...base, adults: 4 })).toMatchObject({ ok: false, reason: 'too_many_guests' });
    expect(quoteStay({ ...base, prices: [] })).toMatchObject({ ok: false, reason: 'no_price' });
  });

  it('applies only business-configured taxes: inclusive VAT, per-person-per-night city tax capped, children exempt', () => {
    const lines = taxLines([
      { name: 'VAT', kind: 'percent', rateBps: 600, inclusive: true },
      { name: 'City tax', kind: 'per_person_per_night', amountMinor: 400, maxNights: 7, appliesToChildren: false },
      { name: 'Booking fee', kind: 'per_stay', amountMinor: 500 },
    ], { roomTotalMinor: 106_000, nights: 10, adults: 2, children: 1 });
    expect(lines).toEqual([
      { name: 'VAT', kind: 'percent', amountMinor: 6_000, inclusive: true },
      { name: 'City tax', kind: 'per_person_per_night', amountMinor: 5_600, inclusive: false },
      { name: 'Booking fee', kind: 'per_stay', amountMinor: 500, inclusive: false },
    ]);
    const q = quoteStay({ ...base, taxes: [{ name: 'City tax', kind: 'per_person_per_night', amountMinor: 200 }, { name: 'VAT', kind: 'percent', rateBps: 1000, inclusive: false }] });
    expect(q.ok && q.taxAddedMinor).toBe(1_200 + 3_800);
    expect(q.ok && q.totalMinor).toBe(38_000 + 5_000);
    expect(quoteStay(base).ok && (quoteStay(base) as { taxes: unknown[] }).taxes).toEqual([]);
  });

  it('cancellation and no-show fees follow the policy', () => {
    const arrivalAt = new Date('2027-03-05T15:00:00Z');
    const policy = { nonRefundable: false, freeUntilHours: 48, lateFee: { type: 'first_night' as const }, noShowFee: { type: 'percent' as const, percentBps: 5000 } };
    const stay = { firstNightMinor: 10_000, totalMinor: 38_000 };
    expect(cancellationFee(policy, { now: new Date('2027-03-03T14:59:00Z'), arrivalAt, ...stay })).toMatchObject({ feeMinor: 0, free: true });
    expect(cancellationFee(policy, { now: new Date('2027-03-03T15:01:00Z'), arrivalAt, ...stay })).toMatchObject({ feeMinor: 10_000, free: false, reason: 'late' });
    expect(cancellationFee({ ...policy, lateFee: { type: 'fixed', amountMinor: 99_999 } }, { now: arrivalAt, arrivalAt, ...stay }).feeMinor).toBe(38_000);
    expect(cancellationFee({ ...policy, nonRefundable: true }, { now: new Date('2026-01-01'), arrivalAt, ...stay })).toMatchObject({ feeMinor: 38_000, reason: 'non_refundable' });
    expect(noShowFee(policy, stay)).toBe(19_000);
  });

  it('housekeeping transitions and KPI maths', () => {
    expect(hkTransition('dirty', 'clean').ok).toBe(true);
    expect(hkTransition('dirty', 'inspected')).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(hkTransition('clean', 'inspected').ok).toBe(true);
    expect(hkTransition('out_of_order', 'clean').ok).toBe(false);
    expect(hkTransition('out_of_order', 'dirty').ok).toBe(true);
    expect(hotelKpis({ roomNightsAvailable: 10, roomNightsSold: 4, roomRevenueMinor: 50_000 })).toEqual({ occupancy: 0.4, adrMinor: 12_500, revparMinor: 5_000 });
    expect(hotelKpis({ roomNightsAvailable: 0, roomNightsSold: 0, roomRevenueMinor: 0 })).toEqual({ occupancy: null, adrMinor: null, revparMinor: null });
  });
});

describe.skipIf(!hasDb)('hospitality: inventory, reservations, folio, housekeeping, outlet, reports (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let lisbon: any;
  let vancouver: any;
  const H = (p: string) => `/v1/orgs/${orgId}/hospitality${p}`;
  const today = (tz: string) => localDateParts(new Date(), tz).date;

  /** A property with one room type of `rooms` rooms, a BAR plan (first-night deposit, free until 48h) and a non-refundable plan. */
  async function setupProperty(loc: any, opts: { rooms: number; price: number; code: string; taxes?: boolean }) {
    const t = await call(app, 'POST', H('/room-types'), { token: owner.token, body: { locationId: loc.id, code: opts.code, name: `Double ${opts.code}`, kind: 'room', baseOccupancy: 2, maxOccupancy: 3, beds: [{ type: 'queen', count: 1 }] } });
    expect(t.status).toBe(201);
    const rooms: any[] = [];
    for (let i = 1; i <= opts.rooms; i += 1) {
      const r = await call(app, 'POST', H('/rooms'), { token: owner.token, body: { locationId: loc.id, roomTypeId: t.body.id, number: `${opts.code}${100 + i}` } });
      expect(r.status).toBe(201);
      rooms.push(r.body);
    }
    const flex = await call(app, 'POST', H('/policies'), { token: owner.token, body: { locationId: loc.id, name: 'Flexible 48h', nonRefundable: false, freeUntilHours: 48, lateFee: { type: 'first_night' }, noShowFee: { type: 'first_night' } } });
    const nrp = await call(app, 'POST', H('/policies'), { token: owner.token, body: { locationId: loc.id, name: 'Non-refundable', nonRefundable: true, freeUntilHours: null, lateFee: { type: 'full' }, noShowFee: { type: 'full' } } });
    const bar = await call(app, 'POST', H('/rate-plans'), { token: owner.token, body: { locationId: loc.id, code: `BAR${opts.code}`, name: 'Flexible', kind: 'bar', depositRule: 'first_night', cancellationPolicyId: flex.body.id } });
    expect(bar.status).toBe(201);
    const nr = await call(app, 'POST', H('/rate-plans'), { token: owner.token, body: { locationId: loc.id, code: `NR${opts.code}`, name: 'Non-refundable', kind: 'non_refundable', derivedFromId: bar.body.id, adjustmentBps: -1000, depositRule: 'full', cancellationPolicyId: nrp.body.id } });
    expect(nr.status).toBe(201);
    const pr = await call(app, 'PUT', H(`/rate-plans/${bar.body.id}/prices`), { token: owner.token, body: { prices: [{ roomTypeId: t.body.id, seasonId: null, amountMinor: opts.price }] } });
    expect(pr.status).toBe(200);
    if (opts.taxes) {
      const tx = await call(app, 'POST', H('/taxes'), { token: owner.token, body: { locationId: loc.id, name: 'City tax', kind: 'per_person_per_night', amountMinor: 200, maxNights: 7, appliesToChildren: false } });
      expect(tx.status).toBe(201);
    }
    return { roomTypeId: t.body.id as string, rooms, barId: bar.body.id as string, nrId: nr.body.id as string };
  }

  async function book(loc: any, p: { roomTypeId: string; barId: string }, arrival: string, departure: string, extra: Record<string, unknown> = {}) {
    return call(app, 'POST', `/v1/public/hospitality/properties/${loc.id}/reservations`, { body: { arrival, departure, rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name: 'Ana Silva', email: `ana-${Math.random().toString(36).slice(2)}@example.com` }, ...extra } });
  }
  const pay = (paymentId: string) => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
  async function inventory(roomTypeId: string, dates: string[]) {
    const rows = await app.ctx.db.select().from(hospInventory).where(and(eq(hospInventory.roomTypeId, roomTypeId), inArray(hospInventory.date, dates)));
    return Object.fromEntries(dates.map((d) => [d, rows.find((r) => r.date === d)?.sold ?? 0]));
  }

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Owner');
    const org = await createOrg(app, owner.token, { name: 'Harbour Stays', industry: 'hospitality', country: 'PT', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Lisbon', dataRegion: 'eu' });
    orgId = org.id;
    lisbon = await createLocation(app, owner.token, orgId, { name: 'Lisbon Alfama', currency: 'EUR', timeZone: 'Europe/Lisbon', address: { line1: 'Rua 1', city: 'Lisboa', postalCode: '1100-001', country: 'PT' } });
    vancouver = await createLocation(app, owner.token, orgId, { name: 'Vancouver Gastown', currency: 'CAD', timeZone: 'America/Vancouver', address: { line1: '1 Water St', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A1', country: 'CA' } });
    await enablePublicAndPayments(app, owner.token, orgId, lisbon.id);
    await enablePublicAndPayments(app, owner.token, orgId, vancouver.id);
  });
  afterAll(async () => { await app?.close(); });

  it('never overbooks the last room under concurrent bookings', async () => {
    const p = await setupProperty(lisbon, { rooms: 1, price: 12_000, code: 'C' });
    const d = addDaysIso(today('Europe/Lisbon'), 30);
    const results = await Promise.all(Array.from({ length: 8 }, () => book(lisbon, p, d, addDaysIso(d, 2))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'sold_out')).toBe(true);
    expect(await inventory(p.roomTypeId, [d, addDaysIso(d, 1)])).toEqual({ [d]: 1, [addDaysIso(d, 1)]: 1 });
    const avail = await call(app, 'GET', `/v1/public/hospitality/properties/${lisbon.id}/availability?arrival=${d}&departure=${addDaysIso(d, 1)}&adults=2`);
    expect(avail.body.items.find((t: any) => t.roomTypeId === p.roomTypeId).available).toBe(0);
    // Staff bookings use the same counters.
    const staff = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: lisbon.id, arrival: d, departure: addDaysIso(d, 1), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 1 }], guest: { name: 'Walk In', email: 'walkin@example.com' } } });
    expect(staff.status).toBe(409);
    expect(staff.body.error.code).toBe('sold_out');
  });

  it('holds inventory, confirms on deposit payment, expires unpaid holds and re-secures a late payment only if still free', async () => {
    const p = await setupProperty(lisbon, { rooms: 1, price: 10_000, code: 'H', taxes: false });
    const d = addDaysIso(today('Europe/Lisbon'), 40);
    const r = await book(lisbon, p, d, addDaysIso(d, 2));
    expect(r.status).toBe(201);
    expect(r.body.reservation.status).toBe('hold');
    expect(r.body.payment.id).toBeTruthy();
    expect(r.body.reservation.depositRequired).toEqual({ amount: 10_000, currency: 'EUR' });
    await pay(r.body.payment.id);
    const view = await call(app, 'GET', `/v1/public/hospitality/reservations/${r.body.reservation.id}?token=${r.body.manageToken}`);
    expect(view.body.reservation.status).toBe('confirmed');
    expect(view.body.reservation.depositPaid.amount).toBe(10_000);
    expect(view.body.balance).toEqual({ amount: 10_000, currency: 'EUR' }); // 20 000 stay − 10 000 deposit

    // Expired hold: inventory returns; a payment arriving later re-secures if still free.
    const d2 = addDaysIso(d, 10);
    const h = await book(lisbon, p, d2, addDaysIso(d2, 1));
    await app.ctx.db.update(hospReservations).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(hospReservations.id, h.body.reservation.id));
    await expireHolds(app.ctx, lisbon.id);
    expect((await inventory(p.roomTypeId, [d2]))[d2]).toBe(0);
    await pay(h.body.payment.id);
    const [after] = await app.ctx.db.select().from(hospReservations).where(eq(hospReservations.id, h.body.reservation.id));
    expect(after!.status).toBe('confirmed');
    expect((await inventory(p.roomTypeId, [d2]))[d2]).toBe(1);
  });

  it('modifying dates secures the new nights before releasing the old ones; failure keeps the original', async () => {
    const p = await setupProperty(lisbon, { rooms: 1, price: 10_000, code: 'M' });
    const d = addDaysIso(today('Europe/Lisbon'), 60);
    const a = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: lisbon.id, arrival: d, departure: addDaysIso(d, 2), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name: 'Guest A', email: 'a@example.com' } } });
    expect(a.status).toBe(201);
    const b = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: lisbon.id, arrival: addDaysIso(d, 4), departure: addDaysIso(d, 5), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name: 'Guest B', email: 'b@example.com' } } });
    expect(b.status).toBe(201);
    const nights = [0, 1, 2, 3, 4].map((i) => addDaysIso(d, i));
    const before = await inventory(p.roomTypeId, nights);
    // New dates include a sold-out night → nothing changes.
    const fail = await call(app, 'POST', H(`/reservations/${a.body.id}/modify`), { token: owner.token, body: { arrival: addDaysIso(d, 3), departure: addDaysIso(d, 5) } });
    expect(fail.status).toBe(409);
    expect(fail.body.error.code).toBe('sold_out');
    expect(await inventory(p.roomTypeId, nights)).toEqual(before);
    const same = await call(app, 'GET', H(`/reservations/${a.body.id}`), { token: owner.token });
    expect([same.body.arrival, same.body.departure]).toEqual([d, addDaysIso(d, 2)]);
    // Overlapping move into nights the guest already holds (room type has a single room): succeeds.
    const ok = await call(app, 'POST', H(`/reservations/${a.body.id}/modify`), { token: owner.token, body: { arrival: addDaysIso(d, 1), departure: addDaysIso(d, 4) } });
    expect(ok.status).toBe(200);
    expect(ok.body.priceDifference).toEqual({ amount: 10_000, currency: 'EUR' });
    expect(await inventory(p.roomTypeId, nights)).toEqual({ [nights[0]!]: 0, [nights[1]!]: 1, [nights[2]!]: 1, [nights[3]!]: 1, [nights[4]!]: 1 });
  });

  it('quotes seasons, weekday prices, configured taxes and enforces min stay through the API', async () => {
    const p = await setupProperty(vancouver, { rooms: 2, price: 20_000, code: 'R', taxes: true });
    const d = addDaysIso(today('America/Vancouver'), 90);
    const se = await call(app, 'POST', H('/seasons'), { token: owner.token, body: { locationId: vancouver.id, name: 'Summer', startDate: addDaysIso(d, 1), endDate: addDaysIso(d, 20), minStay: 3 } });
    expect(se.status).toBe(201);
    await call(app, 'PUT', H(`/rate-plans/${p.barId}/prices`), { token: owner.token, body: { prices: [{ roomTypeId: p.roomTypeId, seasonId: se.body.id, amountMinor: 30_000 }] } });
    const wrong = await call(app, 'PUT', H(`/rate-plans/${p.barId}/prices`), { token: owner.token, body: { prices: [{ roomTypeId: p.roomTypeId, seasonId: null, amountMinor: 1, currency: 'EUR' }] } });
    expect(wrong.status).toBe(400);
    const q = await call(app, 'GET', `/v1/public/hospitality/properties/${vancouver.id}/availability?arrival=${d}&departure=${addDaysIso(d, 4)}&adults=2`);
    const rt = q.body.items.find((t: any) => t.roomTypeId === p.roomTypeId);
    const bar = rt.rates.find((x: any) => x.ratePlanId === p.barId);
    expect(bar.ok).toBe(true);
    expect(bar.nights.map((n: any) => n.amountMinor)).toEqual([20_000, 30_000, 30_000, 30_000]);
    expect(bar.taxes).toEqual([{ name: 'City tax', kind: 'per_person_per_night', amountMinor: 1_600, inclusive: false }]);
    expect(bar.total).toEqual({ amount: 111_600, currency: 'CAD' });
    const nr = rt.rates.find((x: any) => x.ratePlanId === p.nrId);
    expect(nr.nights.map((n: any) => n.amountMinor)).toEqual([18_000, 27_000, 27_000, 27_000]);
    const short = await call(app, 'GET', `/v1/public/hospitality/properties/${vancouver.id}/availability?arrival=${addDaysIso(d, 2)}&departure=${addDaysIso(d, 4)}&adults=2`);
    expect(short.body.items.find((t: any) => t.roomTypeId === p.roomTypeId).rates.find((x: any) => x.ratePlanId === p.barId)).toMatchObject({ ok: false, reason: 'min_stay' });
    const daily = await call(app, 'PUT', H('/daily-rates'), { token: owner.token, body: { ratePlanId: p.barId, roomTypeIds: [p.roomTypeId], from: d, to: d, set: { closedToArrival: true } } });
    expect(daily.status).toBe(200);
    const cta = await book(vancouver, p, d, addDaysIso(d, 4));
    expect(cta.status).toBe(409);
    expect(cta.body.error.code).toBe('rate_closed_to_arrival');
  });

  it('charges cancellation fees per policy and refunds the rest of the deposit', async () => {
    const p = await setupProperty(lisbon, { rooms: 2, price: 15_000, code: 'X' });
    const far = addDaysIso(today('Europe/Lisbon'), 20);
    const r1 = await book(lisbon, p, far, addDaysIso(far, 2));
    await pay(r1.body.payment.id);
    const q1 = await call(app, 'GET', `/v1/public/hospitality/reservations/${r1.body.reservation.id}/cancellation-quote?token=${r1.body.manageToken}`);
    expect(q1.body).toMatchObject({ free: true, fee: { amount: 0 }, refund: { amount: 15_000 } });
    const c1 = await call(app, 'POST', `/v1/public/hospitality/reservations/${r1.body.reservation.id}/cancel`, { body: { token: r1.body.manageToken } });
    expect(c1.status).toBe(200);
    expect(c1.body.refund).toEqual({ amount: 15_000, currency: 'EUR' });
    expect(c1.body.reservation.status).toBe('cancelled');
    expect((await inventory(p.roomTypeId, [far]))[far]).toBe(0);

    // Inside the free window (arrival tomorrow): first night kept, nothing else to refund (deposit = first night).
    const soon = addDaysIso(today('Europe/Lisbon'), 1);
    const r2 = await book(lisbon, p, soon, addDaysIso(soon, 3));
    await pay(r2.body.payment.id);
    const c2 = await call(app, 'POST', `/v1/public/hospitality/reservations/${r2.body.reservation.id}/cancel`, { body: { token: r2.body.manageToken } });
    expect(c2.body.fee).toEqual({ amount: 15_000, currency: 'EUR' });
    expect(c2.body.refund).toEqual({ amount: 0, currency: 'EUR' });
    const f2 = await call(app, 'GET', H(`/reservations/${r2.body.reservation.id}`), { token: owner.token });
    expect(f2.body.folio.balance).toEqual({ amount: 0, currency: 'EUR' });

    // Non-refundable: full prepayment kept.
    const r3 = await call(app, 'POST', `/v1/public/hospitality/properties/${lisbon.id}/reservations`, { body: { arrival: far, departure: addDaysIso(far, 2), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.nrId, adults: 2 }], guest: { name: 'NR Guest', email: 'nr@example.com' } } });
    expect(r3.body.reservation.depositRequired).toEqual({ amount: 27_000, currency: 'EUR' });
    await pay(r3.body.payment.id);
    const c3 = await call(app, 'POST', `/v1/public/hospitality/reservations/${r3.body.reservation.id}/cancel`, { body: { token: r3.body.manageToken } });
    expect(c3.body.fee.amount).toBe(27_000);
    expect(c3.body.refund.amount).toBe(0);
  });

  it('runs the stay: assign, registration, check-in, folio, outlet charge-to-room with reversal, check-out at zero balance', async () => {
    const p = await setupProperty(lisbon, { rooms: 2, price: 10_000, code: 'F', taxes: true });
    await call(app, 'PUT', H(`/properties/${lisbon.id}`), { token: owner.token, body: { registrationFields: [{ key: 'nationality', label: 'Nationality', kind: 'country', required: true }], outletEnabled: true, outletName: 'Tasca' } });
    const d = today('Europe/Lisbon');
    const res = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: lisbon.id, arrival: d, departure: addDaysIso(d, 2), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name: 'Folio Guest', email: 'folio@example.com' } } });
    expect(res.status).toBe(201);
    const rr = res.body.rooms[0];
    const notAssigned = await call(app, 'POST', H(`/reservations/${res.body.id}/check-in`), { token: owner.token, body: { registration: { nationality: 'PT' } } });
    expect(notAssigned.body.error.code).toBe('room_not_assigned');
    const room = p.rooms[0];
    const as = await call(app, 'POST', H(`/reservation-rooms/${rr.id}/assign`), { token: owner.token, body: { roomId: room.id } });
    expect(as.status).toBe(200);
    // Someone else cannot get the same room those nights.
    const other = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: lisbon.id, arrival: d, departure: addDaysIso(d, 1), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 1 }], guest: { name: 'Other', email: 'other@example.com' } } });
    const taken = await call(app, 'POST', H(`/reservation-rooms/${other.body.rooms[0].id}/assign`), { token: owner.token, body: { roomId: room.id } });
    expect(taken.body.error.code).toBe('room_taken');
    // Registration: only configured fields, required ones enforced.
    const bad = await call(app, 'POST', H(`/reservations/${res.body.id}/check-in`), { token: owner.token, body: { registration: { passportPhoto: 'x' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields).toMatchObject({ passportPhoto: expect.any(String), nationality: 'Required' });
    await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'out_of_order', reason: 'x', until: addDaysIso(d, 1) } }).then((r) => expect(r.body.error.code).toBe('room_assigned'));
    const ci = await call(app, 'POST', H(`/reservations/${res.body.id}/check-in`), { token: owner.token, body: { registration: { nationality: 'PT' } } });
    expect(ci.status).toBe(200);
    expect(ci.body.status).toBe('checked_in');
    // 2 nights × 100 + city tax 2 × 2 × 2 = 208
    expect(ci.body.folio.balance).toEqual({ amount: 20_800, currency: 'EUR' });

    // Outlet (Foods engine) charge-to-room, then rejection reverses it.
    const [menu] = await app.ctx.db.insert(menus).values({ organizationId: orgId, name: 'Tasca', status: 'published', publishedAt: new Date() }).returning();
    const [item] = await app.ctx.db.insert(menuItems).values({ organizationId: orgId, menuId: menu!.id, category: 'Mains', name: 'Bacalhau', prices: { EUR: 1_800 } }).returning();
    const outlet = await call(app, 'GET', H(`/outlet/${lisbon.id}`), { token: owner.token });
    expect(outlet.body.inHouse.map((g: any) => g.reservationId)).toContain(res.body.id);
    const ch = await call(app, 'POST', H(`/outlet/${lisbon.id}/room-charges`), { token: owner.token, body: { reservationId: res.body.id, lines: [{ menuItemId: item!.id, quantity: 2 }] } });
    expect(ch.status).toBe(201);
    expect(ch.body.order.total).toEqual({ amount: 3_600, currency: 'EUR' });
    let folio = (await call(app, 'GET', H(`/reservations/${res.body.id}`), { token: owner.token })).body.folio;
    expect(folio.balance.amount).toBe(24_400);
    const rej = await call(app, 'POST', `/v1/orgs/${orgId}/foods/orders/${ch.body.order.id}/transition`, { token: owner.token, body: { to: 'rejected', note: 'Kitchen closed' } });
    expect(rej.status).toBe(200);
    folio = (await call(app, 'GET', H(`/reservations/${res.body.id}`), { token: owner.token })).body.folio;
    expect(folio.balance.amount).toBe(20_800);
    const ch2 = await call(app, 'POST', H(`/outlet/${lisbon.id}/room-charges`), { token: owner.token, body: { reservationId: res.body.id, lines: [{ menuItemId: item!.id, quantity: 1 }] } });
    expect(ch2.status).toBe(201);
    await call(app, 'POST', H(`/reservations/${res.body.id}/folio`), { token: owner.token, body: { kind: 'extra', description: 'Minibar', amountMinor: 450 } });
    const due = await call(app, 'POST', H(`/reservations/${res.body.id}/check-out`), { token: owner.token });
    expect(due.body.error.code).toBe('balance_due');
    expect(due.body.error.details).toEqual({ balanceMinor: 23_050, currency: 'EUR' });
    await call(app, 'POST', H(`/reservations/${res.body.id}/folio`), { token: owner.token, body: { kind: 'payment', description: 'Card terminal', amountMinor: 23_050, method: 'card_terminal' } });
    const co = await call(app, 'POST', H(`/reservations/${res.body.id}/check-out`), { token: owner.token });
    expect(co.status).toBe(200);
    expect(co.body.status).toBe('checked_out');
    expect(co.body.folio.balance.amount).toBe(0);
    const late = await call(app, 'POST', H(`/outlet/${lisbon.id}/room-charges`), { token: owner.token, body: { reservationId: res.body.id, lines: [{ menuItemId: item!.id, quantity: 1 }] } });
    expect(late.body.error.code).toBe('not_in_house');
    // Departure leaves the room dirty with a departure clean.
    const board = await call(app, 'GET', H(`/housekeeping?locationId=${lisbon.id}&date=${d}`), { token: owner.token });
    expect(board.body.rooms.find((r: any) => r.id === room.id).hkStatus).toBe('dirty');
    const task = board.body.tasks.find((t: any) => t.roomId === room.id && t.kind === 'departure_clean');
    expect(task).toBeTruthy();
    const done = await call(app, 'PATCH', H(`/housekeeping/tasks/${task.id}`), { token: owner.token, body: { status: 'done' } });
    expect(done.status).toBe(200);
    const board2 = await call(app, 'GET', H(`/housekeeping?locationId=${lisbon.id}&date=${d}`), { token: owner.token });
    expect(board2.body.rooms.find((r: any) => r.id === room.id).hkStatus).toBe('clean');
  });

  it('housekeeping status rules: invalid transitions, out of order reduces inventory and is refused when it would oversell', async () => {
    const p = await setupProperty(vancouver, { rooms: 2, price: 18_000, code: 'K' });
    const room = p.rooms[1];
    const d = today('America/Vancouver');
    const bad = await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'out_of_order' } });
    expect(bad.status).toBe(400);
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'dirty' } })).status).toBe(200);
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'inspected' } })).body.error.code).toBe('invalid_transition');
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'clean' } })).body.hkStatus).toBe('clean');
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'inspected' } })).body.hkStatus).toBe('inspected');
    // Sell both rooms on night +5, then try to take one out of order across it.
    const n = addDaysIso(d, 5);
    for (const name of ['One', 'Two']) await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: vancouver.id, arrival: n, departure: addDaysIso(n, 1), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name, email: `${name}@example.com` } } });
    const oversell = await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'out_of_order', reason: 'Leak', until: addDaysIso(d, 7) } });
    expect(oversell.body.error.code).toBe('would_overbook');
    const ooo = await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'out_of_order', reason: 'Leak', until: addDaysIso(d, 3) } });
    expect(ooo.status).toBe(200);
    const av = await call(app, 'GET', H(`/availability?locationId=${vancouver.id}&arrival=${addDaysIso(d, 1)}&departure=${addDaysIso(d, 2)}`), { token: owner.token });
    expect(av.body.items.find((t: any) => t.roomTypeId === p.roomTypeId).available).toBe(1);
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'clean' } })).body.error.code).toBe('invalid_transition');
    expect((await call(app, 'POST', H(`/rooms/${room.id}/status`), { token: owner.token, body: { status: 'dirty' } })).status).toBe(200);
    const av2 = await call(app, 'GET', H(`/availability?locationId=${vancouver.id}&arrival=${addDaysIso(d, 1)}&departure=${addDaysIso(d, 2)}`), { token: owner.token });
    expect(av2.body.items.find((t: any) => t.roomTypeId === p.roomTypeId).available).toBe(2);
    const tasks = await app.ctx.db.select().from(hospHkTasks).where(eq(hospHkTasks.roomId, room.id));
    expect(tasks).toHaveLength(0);
  });

  it('reports occupancy, ADR and RevPAR per property and per currency without combining currencies', async () => {
    const org2 = await createOrg(app, owner.token, { name: 'Report Stays', industry: 'hospitality', country: 'PT', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Lisbon', dataRegion: 'eu' });
    const saveOrg = orgId;
    orgId = org2.id;
    const l = await createLocation(app, owner.token, orgId, { name: 'Porto', currency: 'EUR', timeZone: 'Europe/Lisbon', address: { line1: 'Rua 2', city: 'Porto', postalCode: '4000-001', country: 'PT' } });
    const v = await createLocation(app, owner.token, orgId, { name: 'Whistler', currency: 'CAD', timeZone: 'America/Vancouver', address: { line1: '2 Main', city: 'Whistler', region: 'BC', postalCode: 'V0N 1B0', country: 'CA' } });
    const pl = await setupProperty(l, { rooms: 2, price: 10_000, code: 'P' });
    const pv = await setupProperty(v, { rooms: 1, price: 30_000, code: 'W' });
    const from = addDaysIso(today('Europe/Lisbon'), 100);
    const to = addDaysIso(from, 2);
    for (const [loc, p] of [[l, pl], [v, pv]] as const) {
      await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: loc.id, arrival: from, departure: to, rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 2 }], guest: { name: 'R', email: 'r@example.com' } } });
    }
    const c = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: l.id, arrival: from, departure: addDaysIso(from, 1), rooms: [{ roomTypeId: pl.roomTypeId, ratePlanId: pl.barId, adults: 2 }], guest: { name: 'C', email: 'c@example.com' } } });
    await call(app, 'POST', H(`/reservations/${c.body.id}/cancel`), { token: owner.token, body: { reason: 'Changed plans' } });
    const rep = await call(app, 'GET', H(`/reports?from=${from}&to=${to}`), { token: owner.token });
    expect(rep.status).toBe(200);
    expect(rep.body.combinedRevenue).toBeNull();
    const eur = rep.body.byCurrency.find((x: any) => x.currency === 'EUR');
    const cad = rep.body.byCurrency.find((x: any) => x.currency === 'CAD');
    expect(eur).toMatchObject({ roomNightsAvailable: 4, roomNightsSold: 2, occupancy: 0.5, adr: { amount: 10_000, currency: 'EUR' }, revpar: { amount: 5_000, currency: 'EUR' }, roomRevenue: { amount: 20_000, currency: 'EUR' } });
    expect(cad).toMatchObject({ roomNightsAvailable: 2, roomNightsSold: 2, occupancy: 1, adr: { amount: 30_000, currency: 'CAD' } });
    expect(rep.body.properties).toHaveLength(2);
    expect(rep.body.cancellations).toEqual([expect.objectContaining({ currency: 'EUR', cancelled: 1, roomNightsLost: 1 })]);
    expect(rep.body.pickup.map((x: any) => x.currency).sort()).toEqual(['CAD', 'EUR']);
    orgId = saveOrg;
  });

  it('scopes staff to their property and hides guest contact details without customers.read', async () => {
    const staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: lisbon.id });
    const list = await call(app, 'GET', H(`/reservations?locationId=${vancouver.id}`), { token: staff.token });
    expect(list.body.items).toEqual([]);
    const mine = await call(app, 'GET', H(`/reservations?locationId=${lisbon.id}`), { token: staff.token });
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((r: any) => r.guestEmail === null)).toBe(true);
    const anyV = (await call(app, 'GET', H(`/reservations?locationId=${vancouver.id}`), { token: owner.token })).body.items[0];
    expect((await call(app, 'GET', H(`/reservations/${anyV.id}`), { token: staff.token })).status).toBe(403);
    const cfg = await call(app, 'PUT', H(`/properties/${lisbon.id}`), { token: staff.token, body: { holdMinutes: 30 } });
    expect(cfg.status).toBe(403);
  });

  it('sends pre-arrival messages only with consent, once', async () => {
    const p = await setupProperty(vancouver, { rooms: 1, price: 10_000, code: 'G' });
    const d = addDaysIso(today('America/Vancouver'), 2);
    const yes = await call(app, 'POST', H('/reservations'), { token: owner.token, body: { locationId: vancouver.id, arrival: d, departure: addDaysIso(d, 1), rooms: [{ roomTypeId: p.roomTypeId, ratePlanId: p.barId, adults: 1 }], guest: { name: 'Yes', email: 'yes@example.com' }, consent: { email: true } } });
    expect(yes.status).toBe(201);
    const first = await runGuestMessages(app.ctx);
    const mine = first.filter((x) => x.reservationId === yes.body.id);
    expect(mine).toEqual([expect.objectContaining({ kind: 'pre_arrival', channel: 'email', status: expect.stringMatching(/sent|logged/) })]);
    const again = await runGuestMessages(app.ctx);
    expect(again.filter((x) => x.reservationId === yes.body.id)).toEqual([]);
  });
});
