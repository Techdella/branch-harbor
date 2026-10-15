import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { classOccurrences, consentRecords, coverRequests, memberships, packs, studioCustomerNotifications } from '../src/db/schema/index.ts';
import { runStudioLifecycle } from '../src/services/studios-commerce.ts';
import { localDateParts, addDays } from '../src/lib/tz.ts';
import { utcOffsetMinutes } from '../src/lib/recurrence.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/** First local date (from tomorrow) on which the zone's UTC offset differs from the day before. */
function nextDstChange(tz: string): string {
  let d = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 400; i++) {
    const n = addDays(d, 1);
    if (utcOffsetMinutes(new Date(`${n}T12:00:00Z`), tz) !== utcOffsetMinutes(new Date(`${d}T12:00:00Z`), tz)) return n;
    d = n;
  }
  throw new Error('no DST change found');
}

describe.skipIf(!hasDb)('studios full product (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let loc2: any;
  let locUsd: any;
  let classTypeId: string;
  const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  const portal = async (locationId: string, email = `m-${uid()}@example.com`, name = `Member ${uid()}`) => {
    const link = await call(app, 'POST', '/v1/public/studios/account/link', { body: { locationId, email, name }, headers: { 'x-forwarded-for': ip() } });
    expect(link.status).toBe(200);
    const sess = await call(app, 'POST', '/v1/public/studios/account/session', { body: { code: link.body.devCode }, headers: { 'x-forwarded-for': ip() } });
    expect(sess.status).toBe(200);
    const headers = { 'x-bh-customer-session': sess.body.session as string };
    const acct = await call(app, 'GET', '/v1/public/studios/account', { headers });
    return { headers, customerId: acct.body.customer.id as string, email };
  };
  const pay = (paymentId: string, outcome = 'succeeded') => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome } });
  const buy = async (headers: Record<string, string>, body: any) => {
    const r = await call(app, 'POST', '/v1/public/studios/account/purchases', { headers, body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    if (r.body.payment) expect((await pay(r.body.payment.id)).status).toBe(200);
    const after = await call(app, 'GET', `/v1/public/studios/account/purchases/${r.body.purchase.id}`, { headers });
    expect(after.body.status).toBe('paid');
    return after.body;
  };
  const schedule = async (locationId: string, startsAt: Date, over: any = {}) => {
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token, body: { locationId, classTypeId, startsAt: startsAt.toISOString(), capacity: 10, priceMinor: 2500, ...over } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.items[0];
  };
  const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86400_000 + h * 3600_000);
  const bookAs = (headers: Record<string, string>, occId: string, payWith: any = { kind: 'auto' }) => call(app, 'POST', `/v1/public/studios/account/occurrences/${occId}/bookings`, { headers, body: { payWith } });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app, 'Studio Owner'));
    orgId = (await createOrg(app, token)).id;
    loc = await createLocation(app, token, orgId, { name: 'Queen West' });
    loc2 = await createLocation(app, token, orgId, { name: 'Leslieville' });
    locUsd = await createLocation(app, token, orgId, { name: 'Capitol Hill', timeZone: 'America/Los_Angeles', currency: 'USD', address: { line1: '1 Pine St', city: 'Seattle', region: 'WA', postalCode: '98122', country: 'US' } });
    for (const l of [loc, loc2, locUsd]) await enablePublicAndPayments(app, token, orgId, l.id);
    classTypeId = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token, body: { locationId: null, name: 'Vinyasa Flow', durationMinutes: 60, defaultCapacity: 16, creditCost: 1 } })).body.id;
  });
  afterAll(async () => { await app?.close(); });

  it('builds a recurring schedule in the location time zone: preview crosses DST, publish generates classes at the same local time', async () => {
    const tz = 'America/Toronto';
    const change = nextDstChange(tz);
    const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
    const start = addDays(change, -14) > tomorrow ? addDays(change, -14) : tomorrow;
    const wd = [0, 1, 2, 3, 4, 5, 6];
    const room = await call(app, 'POST', `/v1/orgs/${orgId}/studios/rooms`, { token, body: { locationId: loc.id, name: 'Studio A', capacity: 18 } });
    expect(room.status).toBe(201);
    const body = { locationId: loc.id, classTypeId, recurrence: { byWeekday: [wd[new Date(`${start}T12:00:00Z`).getUTCDay()]!], time: '07:00', startDate: start, untilDate: addDays(change, 21) }, roomId: room.body.id, priceMinor: 2500 };
    const pv = await call(app, 'POST', `/v1/orgs/${orgId}/studios/series/preview`, { token, body });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.summary.crossesDst).toBe(true);
    expect(pv.body.capacity).toBe(16);
    expect(pv.body.rrule).toContain('RRULE:FREQ=WEEKLY');
    expect(new Set(pv.body.occurrences.map((o: any) => o.localTime))).toEqual(new Set(['07:00']));
    expect(new Set(pv.body.occurrences.map((o: any) => o.utcOffsetMinutes)).size).toBe(2);

    const created = await call(app, 'POST', `/v1/orgs/${orgId}/studios/series`, { token, body: { ...body, publish: true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.generated).toBe(pv.body.summary.count);
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/studios/series/${created.body.series.id}`, { token });
    expect(detail.body.occurrences.every((o: any) => localDateParts(new Date(o.startsAt), tz).time === '07:00')).toBe(true);
    expect(detail.body.occurrences[0].room).toBe('Studio A');

    // A second series in the same room at the same time clashes; publishing is refused unless accepted explicitly.
    const clash = await call(app, 'POST', `/v1/orgs/${orgId}/studios/series`, { token, body: { ...body, publish: true } });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('schedule_conflicts');
  });

  it('edits "this and following" with an impact preview, splits the series and notifies booked customers by consent', async () => {
    const tz = 'America/Toronto';
    const first = addDays(new Date().toISOString().slice(0, 10), 2);
    const wd = new Date(`${first}T12:00:00Z`).getUTCDay();
    const sr = await call(app, 'POST', `/v1/orgs/${orgId}/studios/series`, { token, body: { locationId: loc.id, classTypeId, recurrence: { byWeekday: [wd], time: '18:30', startDate: first, count: 5 }, priceMinor: 0, publish: true } });
    expect(sr.status, JSON.stringify(sr.body)).toBe(201);
    const occ = (await call(app, 'GET', `/v1/orgs/${orgId}/studios/series/${sr.body.series.id}`, { token })).body.occurrences;
    expect(occ).toHaveLength(5);
    const a = await portal(loc.id);
    const b = await portal(loc.id);
    for (const o of [occ[0], occ[2], occ[3]]) expect((await bookAs(a.headers, o.id, { kind: 'pay' })).status).toBe(201);
    expect((await bookAs(b.headers, occ[3].id, { kind: 'pay' })).status).toBe(201);
    // Customer B withdrew class-update emails; customer A opted in to SMS (but has no phone number).
    await call(app, 'POST', '/v1/public/studios/account/consents', { headers: b.headers, body: { purpose: 'class_updates_email', granted: false } });
    await call(app, 'POST', '/v1/public/studios/account/consents', { headers: a.headers, body: { purpose: 'class_updates_sms', granted: true } });

    const preview = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${occ[2].id}/edit-preview`, { token, body: { scope: 'following', changes: { time: '19:00', instructorName: 'Sam Tran' } } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.totals).toMatchObject({ occurrences: 3, bookings: 3, customers: 2 });
    expect(preview.body.items[0].changes.join(' ')).toMatch(/now starts/);
    expect(preview.body.items.every((i: any) => localDateParts(new Date(i.after.startsAt), tz).time === '19:00')).toBe(true);

    const applied = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${occ[2].id}/edit`, { token, body: { scope: 'following', changes: { time: '19:00', instructorName: 'Sam Tran' }, reason: 'Timetable change' } });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ occurrences: 3, bookingsAffected: 3, customersNotified: 3 });
    expect(applied.body.newSeriesId).toBeTruthy();
    const old = (await call(app, 'GET', `/v1/orgs/${orgId}/studios/series/${sr.body.series.id}`, { token })).body;
    expect(old.recurrence.untilDate < localDateParts(new Date(occ[2].startsAt), tz).date).toBe(true);
    expect(old.occurrences.filter((o: any) => o.status === 'scheduled')).toHaveLength(2);
    expect(localDateParts(new Date(old.occurrences[0].startsAt), tz).time).toBe('18:30');
    const split = (await call(app, 'GET', `/v1/orgs/${orgId}/studios/series/${applied.body.newSeriesId}`, { token })).body;
    expect(split.occurrences.map((o: any) => o.instructorName)).toEqual(['Sam Tran', 'Sam Tran', 'Sam Tran']);

    const rows = await app.ctx.db.select().from(studioCustomerNotifications).where(eq(studioCustomerNotifications.occurrenceId, occ[3].id));
    const by = (cust: string, ch: string) => rows.find((r) => r.customerId === cust && r.channel === ch)?.status;
    expect(by(a.customerId, 'email')).toBe('sent');
    expect(by(b.customerId, 'email')).toBe('skipped_no_consent');
    expect(by(b.customerId, 'sms')).toBe('skipped_no_consent');
    expect(by(a.customerId, 'sms')).toBe('skipped_no_contact');
    const history = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences/${occ[3].id}/notifications`, { token });
    expect(history.body.items.length).toBeGreaterThanOrEqual(6);

    // One occurrence only: detaches it; the rest of the series is untouched.
    const one = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${split.occurrences[1].id}/edit`, { token, body: { scope: 'one', changes: { capacity: 4 } } });
    expect(one.body.occurrences).toBe(1);
    // Capacity below bookings is refused unless explicitly allowed.
    const tooSmall = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${split.occurrences[1].id}/edit`, { token, body: { scope: 'one', changes: { capacity: 1 } } });
    expect(tooSmall.body.error.code).toBe('capacity_below_bookings');

    // Cancel the rest of the series: bookings cancelled with a reason.
    const cancel = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${split.occurrences[0].id}/edit`, { token, body: { scope: 'series', changes: { cancel: true }, reason: 'Instructor leave' } });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.cancelledBookings).toBe(3);
    const acct = await call(app, 'GET', '/v1/public/studios/account', { headers: a.headers });
    expect(acct.body.upcoming).toHaveLength(1);
  });

  it('consumes pack credits, returns them on early cancellation, forfeits on late cancellation and blocks expired packs', async () => {
    const product = await call(app, 'POST', `/v1/orgs/${orgId}/studios/pack-products`, { token, body: { name: '5-class pack', credits: 5, validityDays: 60, prices: { CAD: 11000, USD: 9500 }, transferPolicy: 'home_only' } });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    await call(app, 'PUT', `/v1/orgs/${orgId}/studios/policies`, { token, body: { locationId: null, lateCancelMinutes: 720, lateCancelFee: { CAD: 1000 }, noShowFee: { CAD: 1500 }, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false } });
    const pricing = await call(app, 'GET', `/v1/public/studios/${loc.id}/pricing`);
    expect(pricing.body.packs.find((p: any) => p.id === product.body.id)).toMatchObject({ price: { amount: 11000, currency: 'CAD' }, credits: 5 });
    expect(pricing.body.policy.lines.join(' ')).toMatch(/Late cancellation fee/);
    // Access line in English plus the facts behind it for translated apps.
    expect(pricing.body.packs.find((p: any) => p.id === product.body.id)).toMatchObject({ access: `Valid at ${loc.name} only`, accessDetail: { policy: 'home_only', currency: 'CAD', locationCount: 0, locationName: loc.name } });

    const c = await portal(loc.id);
    const purchase = await buy(c.headers, { locationId: loc.id, kind: 'pack', productId: product.body.id });
    expect(purchase.resultId).toBeTruthy();
    const early = await schedule(loc.id, inDays(3));
    const opts = await call(app, 'GET', `/v1/public/studios/account/occurrences/${early.id}/options`, { headers: c.headers });
    expect(opts.body.recommended).toMatchObject({ kind: 'credit' });
    expect(opts.body.policy.lines.length).toBeGreaterThan(2);
    const bk = await bookAs(c.headers, early.id, { kind: 'credit' });
    expect(bk.status, JSON.stringify(bk.body)).toBe(201);
    expect(bk.body).toMatchObject({ outcome: 'confirmed', paymentMethod: 'credit', creditsUsed: 1, payment: null });
    let acct = await call(app, 'GET', '/v1/public/studios/account', { headers: c.headers });
    expect(acct.body.credits.available).toBe(4);
    // Duplicate booking: refused and no second credit spent.
    expect((await bookAs(c.headers, early.id, { kind: 'credit' })).body.error.code).toBe('duplicate_booking');
    const cancelEarly = await call(app, 'POST', `/v1/public/studios/account/bookings/${bk.body.bookingId}/cancel`, { headers: c.headers });
    expect(cancelEarly.body).toMatchObject({ lateCancel: false, creditReturned: true, fee: null });
    acct = await call(app, 'GET', '/v1/public/studios/account', { headers: c.headers });
    expect(acct.body.credits.available).toBe(5);

    // Late cancellation (class in 2 hours, policy 12 h): credit forfeited and the late fee recorded.
    const soon = await schedule(loc.id, inDays(0, 2));
    const late = await bookAs(c.headers, soon.id, { kind: 'credit' });
    const cancelLate = await call(app, 'POST', `/v1/public/studios/account/bookings/${late.body.bookingId}/cancel`, { headers: c.headers });
    expect(cancelLate.body).toMatchObject({ lateCancel: true, creditReturned: false, fee: { amount: 1000, currency: 'CAD' } });
    acct = await call(app, 'GET', '/v1/public/studios/account', { headers: c.headers });
    expect(acct.body.credits.available).toBe(4);
    expect(acct.body.fees).toHaveLength(1);

    // Home-only pack cannot be used at another location.
    const other = await schedule(loc2.id, inDays(3));
    const wrongLoc = await bookAs(c.headers, other.id, { kind: 'credit' });
    expect(wrongLoc.status).toBe(409);
    expect(wrongLoc.body.error.message).toMatch(/home location/);

    // Expired pack: refused for credit; "auto" falls back to paying for the class.
    await app.ctx.db.update(packs).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(packs.id, purchase.resultId));
    const later = await schedule(loc.id, inDays(4));
    const expired = await bookAs(c.headers, later.id, { kind: 'credit' });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('pack_expired');
    const fallback = await bookAs(c.headers, later.id, { kind: 'auto' });
    expect(fallback.body).toMatchObject({ outcome: 'held', paymentMethod: 'pay_per_class' });
    await runStudioLifecycle(app.ctx);
    const [p] = await app.ctx.db.select().from(packs).where(eq(packs.id, purchase.resultId));
    expect(p!.status).toBe('expired');

    // Concurrent bookings cannot spend the same last credit twice.
    const two = await buy(c.headers, { locationId: loc.id, kind: 'pack', productId: product.body.id });
    await app.ctx.db.update(packs).set({ creditsRemaining: 1 }).where(eq(packs.id, two.resultId));
    const o1 = await schedule(loc.id, inDays(5));
    const o2 = await schedule(loc.id, inDays(5, 2));
    const results = await Promise.all([bookAs(c.headers, o1.id, { kind: 'credit', packId: two.resultId }), bookAs(c.headers, o2.id, { kind: 'credit', packId: two.resultId })]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const [p2] = await app.ctx.db.select().from(packs).where(eq(packs.id, two.resultId));
    expect(p2!).toMatchObject({ creditsRemaining: 0, status: 'exhausted' });
  });

  it('enforces membership monthly limits and cross-location restrictions', async () => {
    const plan = await call(app, 'POST', `/v1/orgs/${orgId}/studios/membership-plans`, { token, body: { locationId: loc.id, name: '8 classes / month', classesPerPeriod: 2, prices: { CAD: 9900 }, accessPolicy: 'home_only', noticeDays: 30 } });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const wide = await call(app, 'POST', `/v1/orgs/${orgId}/studios/membership-plans`, { token, body: { name: 'Unlimited (CAD studios)', classesPerPeriod: null, prices: { CAD: 18900, USD: 16900 }, accessPolicy: 'same_currency' } });
    // Memberships: English access/terms lines plus their structured facts.
    const priced = (await call(app, 'GET', `/v1/public/studios/${loc.id}/pricing`)).body.memberships;
    expect(priced.find((m: any) => m.id === wide.body.id)).toMatchObject({ access: 'Valid at every CAD location', accessDetail: { policy: 'same_currency', currency: 'CAD' }, termsDetail: { billingCurrency: 'CAD', interval: 'month', classesPerPeriod: null } });
    expect(priced.find((m: any) => m.id === plan.body.id)).toMatchObject({ accessDetail: { policy: 'home_only', locationName: loc.name }, termsDetail: { noticeDays: 30, classesPerPeriod: 2 } });
    const c = await portal(loc.id);
    const m = await buy(c.headers, { locationId: loc.id, kind: 'membership', productId: plan.body.id });
    expect((await call(app, 'POST', '/v1/public/studios/account/purchases', { headers: c.headers, body: { locationId: loc.id, kind: 'membership', productId: plan.body.id } })).body.error.code).toBe('already_member');
    const occs = [await schedule(loc.id, inDays(1)), await schedule(loc.id, inDays(2)), await schedule(loc.id, inDays(3))];
    expect((await bookAs(c.headers, occs[0].id, { kind: 'membership' })).body.paymentMethod).toBe('membership');
    expect((await bookAs(c.headers, occs[1].id, { kind: 'membership' })).status).toBe(201);
    const third = await bookAs(c.headers, occs[2].id, { kind: 'membership' });
    expect(third.status).toBe(409);
    expect(third.body.error).toMatchObject({ code: 'membership_not_usable' });
    expect(third.body.error.message).toMatch(/Monthly limit reached \(2 of 2\)/);
    const elsewhere = await schedule(loc2.id, inDays(1));
    const cross = await bookAs(c.headers, elsewhere.id, { kind: 'membership' });
    expect(cross.status).toBe(409);
    expect(cross.body.error.message).toMatch(/home location/);
    const opts = await call(app, 'GET', `/v1/public/studios/account/occurrences/${elsewhere.id}/options`, { headers: c.headers });
    expect(opts.body.memberships[0]).toMatchObject({ usable: false });

    // "Same currency" membership: valid at another CAD location, not at the USD one.
    const d = await portal(loc.id);
    await buy(d.headers, { locationId: loc.id, kind: 'membership', productId: wide.body.id });
    expect((await bookAs(d.headers, elsewhere.id, { kind: 'membership' })).status).toBe(201);
    const usd = await schedule(locUsd.id, inDays(2), { priceMinor: 2200 });
    const usdTry = await bookAs(d.headers, usd.id, { kind: 'membership' });
    expect(usdTry.status).toBe(409);
    expect(usdTry.body.error.message).toMatch(/CAD/);
    void m;
  });

  it('puts a membership into grace after a failed renewal, suspends after grace, and recovers on payment', async () => {
    const plan = await call(app, 'POST', `/v1/orgs/${orgId}/studios/membership-plans`, { token, body: { locationId: loc.id, name: 'Unlimited monthly', prices: { CAD: 15900 }, graceDays: 5, maxPauseDays: 30 } });
    const c = await portal(loc.id);
    const pu = await buy(c.headers, { locationId: loc.id, kind: 'membership', productId: plan.body.id });
    const id = pu.resultId;
    const failed = await call(app, 'POST', `/v1/orgs/${orgId}/studios/memberships/${id}/sandbox-renewal`, { token, body: { outcome: 'failed' } });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.membership).toMatchObject({ status: 'grace', state: 'grace', failedAttempts: 1 });
    expect(new Date(failed.body.membership.graceUntil).getTime() - Date.now()).toBeGreaterThan(4.9 * 86400_000);
    expect(failed.body.invoice.status).toBe('failed');
    const occ = await schedule(loc.id, inDays(1));
    expect((await bookAs(c.headers, occ.id, { kind: 'membership' })).status).toBe(201); // still usable in grace
    const notice = await app.ctx.db.select().from(studioCustomerNotifications).where(and(eq(studioCustomerNotifications.customerId, c.customerId), eq(studioCustomerNotifications.kind, 'membership_payment_failed')));
    expect(notice.length).toBe(3);

    await app.ctx.db.update(memberships).set({ graceUntil: new Date(Date.now() - 1000) }).where(eq(memberships.id, id));
    await runStudioLifecycle(app.ctx);
    const occ2 = await schedule(loc.id, inDays(2));
    const blocked = await bookAs(c.headers, occ2.id, { kind: 'membership' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/suspended/);
    const retry = await call(app, 'POST', `/v1/public/studios/account/memberships/${id}/retry-payment`, { headers: c.headers });
    expect(retry.body).toMatchObject({ status: 'active', graceUntil: null });
    expect((await bookAs(c.headers, occ2.id, { kind: 'membership' })).status).toBe(201);

    // Pause blocks bookings in the pause window; cancel applies the notice period.
    const pause = await call(app, 'POST', `/v1/orgs/${orgId}/studios/memberships/${id}/pause`, { token, body: { from: inDays(5).toISOString(), until: inDays(12).toISOString() } });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    const paused = await schedule(loc.id, inDays(7));
    expect((await bookAs(c.headers, paused.id, { kind: 'membership' })).body.error.message).toMatch(/paused/);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/memberships/${id}/pause`, { token, body: { from: inDays(1).toISOString(), until: inDays(60).toISOString() } })).status).toBe(400);
    const cancel = await call(app, 'POST', `/v1/public/studios/account/memberships/${id}/cancel`, { headers: c.headers });
    expect(cancel.body.state).toBe('cancelling');
    expect(Math.round((new Date(cancel.body.cancelAt).getTime() - Date.now()) / 86400_000)).toBe(30);
  });

  it('applies the no-show fee policy at check-in and lets the customer pay it', async () => {
    const c = await portal(loc.id);
    const comp = await call(app, 'POST', `/v1/orgs/${orgId}/studios/members/${c.customerId}/credits`, { token, body: { locationId: loc.id, credits: 3, reason: 'Welcome back' } });
    expect(comp.status, JSON.stringify(comp.body)).toBe(201);
    const occ = await schedule(loc.id, inDays(1));
    const bk = await bookAs(c.headers, occ.id, { kind: 'credit' });
    const other = await portal(loc.id);
    const bk2 = await bookAs(other.headers, occ.id, { kind: 'pay' });
    await call(app, 'POST', `/v1/public/payments/${bk2.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    await app.ctx.db.update(classOccurrences).set({ startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() - 60_000) }).where(eq(classOccurrences.id, occ.id));

    const roster = await call(app, 'GET', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}/roster`, { token });
    expect(roster.body.items.map((i: any) => i.bookedWith).sort()).toEqual(['Pack · 2 left', 'Paid single class']);
    const ci = await call(app, 'POST', `/v1/orgs/${orgId}/studios/bookings/${bk2.body.bookingId}/check-in`, { token, body: { source: 'instructor' } });
    expect(ci.body).toMatchObject({ status: 'attended', checkInSource: 'instructor' });
    const ns = await call(app, 'POST', `/v1/orgs/${orgId}/studios/bookings/${bk.body.bookingId}/attendance`, { token, body: { status: 'no_show' } });
    expect(ns.body.fee).toMatchObject({ kind: 'no_show', amount: 1500, currency: 'CAD', status: 'due' });
    // Marking attended after all waives the unpaid fee; marking no-show again restores it (idempotent per booking).
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/bookings/${bk.body.bookingId}/attendance`, { token, body: { status: 'attended' } })).body.status).toBe('attended');
    const again = await call(app, 'POST', `/v1/orgs/${orgId}/studios/bookings/${bk.body.bookingId}/attendance`, { token, body: { status: 'no_show' } });
    expect(again.body.fee.status).toBe('due');
    const close = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}/close-attendance`, { token });
    expect(close.body.noShows).toBe(0);

    const acct = await call(app, 'GET', '/v1/public/studios/account', { headers: c.headers });
    const fee = acct.body.fees[0];
    expect(fee).toMatchObject({ kind: 'no_show', amount: { amount: 1500, currency: 'CAD' } });
    await buy(c.headers, { locationId: loc.id, kind: 'fee', productId: fee.id });
    expect((await call(app, 'GET', '/v1/public/studios/account', { headers: c.headers })).body.fees).toHaveLength(0);
    const queue = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(queue.body.items.filter((i: any) => i.targetType === 'studio_purchase')).toHaveLength(0);
  });

  it('controls online access: library without links; join link only for entitled, registered customers', async () => {
    const live = await call(app, 'POST', `/v1/orgs/${orgId}/studios/online`, { token, body: { locationId: loc.id, kind: 'livestream', title: 'Live Sunrise Flow', provider: 'zoom', providerUrl: 'https://zoom.us/j/123456789?pwd=secret', startsAt: inDays(1).toISOString(), durationMinutes: 45, allowMembers: true, allowPackHolders: true, status: 'published' } });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const vod = await call(app, 'POST', `/v1/orgs/${orgId}/studios/online`, { token, body: { locationId: null, kind: 'on_demand', title: 'Hip Mobility (recording)', provider: 'youtube', providerUrl: 'https://youtu.be/unlisted-abc', durationMinutes: 30, allowMembers: false, prices: { CAD: 900, USD: 700 }, status: 'published' } });
    const pub = await call(app, 'GET', `/v1/public/studios/${loc.id}/online`);
    expect(JSON.stringify(pub.body)).not.toContain('zoom.us');
    expect(JSON.stringify(pub.body)).not.toContain('youtu.be');
    expect(pub.body.items.map((i: any) => i.title)).toEqual(expect.arrayContaining(['Live Sunrise Flow', 'Hip Mobility (recording)']));

    const guest = await portal(loc.id);
    const denied = await call(app, 'POST', `/v1/public/studios/account/online/${live.body.id}/join`, { headers: guest.headers, body: { locationId: loc.id } });
    expect(denied.status).toBe(403);
    expect((await call(app, 'POST', `/v1/public/studios/account/online/${live.body.id}/register`, { headers: guest.headers, body: { locationId: loc.id } })).status).toBe(403);

    // A pack holder may register; the link appears only after registration.
    await call(app, 'POST', `/v1/orgs/${orgId}/studios/members/${guest.customerId}/credits`, { token, body: { locationId: loc.id, credits: 1, reason: 'Online trial' } });
    const early = await call(app, 'POST', `/v1/public/studios/account/online/${live.body.id}/join`, { headers: guest.headers, body: { locationId: loc.id } });
    expect(early.body.error.code).toBe('registration_required');
    const reg = await call(app, 'POST', `/v1/public/studios/account/online/${live.body.id}/register`, { headers: guest.headers, body: { locationId: loc.id } });
    expect(reg.body).toMatchObject({ registered: true, basis: 'pack_holder' });
    const join = await call(app, 'POST', `/v1/public/studios/account/online/${live.body.id}/join`, { headers: guest.headers, body: { locationId: loc.id } });
    expect(join.body).toMatchObject({ url: 'https://zoom.us/j/123456789?pwd=secret', provider: 'zoom' });

    // On-demand sold individually: buy → watch.
    const list = await call(app, 'GET', `/v1/public/studios/account/online?locationId=${loc.id}`, { headers: guest.headers });
    expect(list.body.items.find((i: any) => i.id === vod.body.id).access).toMatchObject({ access: false, purchasable: { amount: 900, currency: 'CAD' } });
    // Reasons come with stable codes (same order) so apps can translate them.
    const vodAccess = list.body.items.find((i: any) => i.id === vod.body.id).access;
    expect(vodAccess.reasonCodes).toHaveLength(vodAccess.reasons.length);
    expect(vodAccess.reasonCodes).toContain('buy_to_watch');
    expect(list.body.items.find((i: any) => i.id === vod.body.id).ruleCodes).toContain('buy');
    expect((await call(app, 'POST', `/v1/public/studios/account/online/${vod.body.id}/join`, { headers: guest.headers, body: { locationId: loc.id } })).status).toBe(403);
    await buy(guest.headers, { locationId: loc.id, kind: 'online', productId: vod.body.id });
    const watch = await call(app, 'POST', `/v1/public/studios/account/online/${vod.body.id}/join`, { headers: guest.headers, body: { locationId: loc.id } });
    expect(watch.body.url).toBe('https://youtu.be/unlisted-abc');
    const regs = await call(app, 'GET', `/v1/orgs/${orgId}/studios/online/${live.body.id}/registrations`, { token });
    expect(regs.body.items).toHaveLength(1);
  });

  it('cover approval updates the schedule and queues customer notifications atomically', async () => {
    const occ = await schedule(loc.id, inDays(2), { instructorName: 'Maya Rao', priceMinor: 0 });
    const c = await portal(loc.id);
    await bookAs(c.headers, occ.id, { kind: 'pay' });
    const sub = await memberWithRole(app, token, orgId, 'staff', { kind: 'location', id: loc.id }, 'Jordan Lee');
    const cr = await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences/${occ.id}/cover-requests`, { token, body: { reason: 'Travel' } });
    const cand = await call(app, 'GET', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/candidates`, { token });
    expect(cand.body.items.some((i: any) => i.name === 'Jordan Lee' && i.available)).toBe(true);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/accept`, { token: sub.token })).body.status).toBe('accepted');
    const ok = await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/decision`, { token, body: { decision: 'approve' } });
    expect(ok.body).toMatchObject({ status: 'approved', customersNotified: 1 });
    const [o] = await app.ctx.db.select().from(classOccurrences).where(eq(classOccurrences.id, occ.id));
    expect(o!.instructorName).toBe('Jordan Lee');
    const n = await app.ctx.db.select().from(studioCustomerNotifications).where(and(eq(studioCustomerNotifications.occurrenceId, occ.id), eq(studioCustomerNotifications.kind, 'instructor_changed')));
    expect(n.map((x) => x.channel).sort()).toEqual(['email', 'push', 'sms']);
    expect(n.find((x) => x.channel === 'email')!.status).toBe('sent');
    // A second approval cannot re-run it.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/cover-requests/${cr.body.id}/decision`, { token, body: { decision: 'approve' } })).status).toBe(409);
    const [after] = await app.ctx.db.select().from(coverRequests).where(eq(coverRequests.id, cr.body.id));
    expect(after!.history.map((h) => h.action)).toEqual(['requested', 'accepted', 'approved']);
  });

  it('members screen, reports and AI proposals respect scope and permissions', async () => {
    const staff = await memberWithRole(app, token, orgId, 'staff', { kind: 'location', id: loc.id });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/members`, { token: staff.token })).status).toBe(403);
    const manager = await memberWithRole(app, token, orgId, 'location_manager', { kind: 'location', id: loc2.id });
    const mine = await call(app, 'GET', `/v1/orgs/${orgId}/studios/members?locationId=${loc2.id}`, { token: manager.token });
    expect(mine.status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/members?locationId=${loc.id}`, { token: manager.token })).status).toBe(403);
    const all = await call(app, 'GET', `/v1/orgs/${orgId}/studios/members?filter=members`, { token });
    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.items[0].membership).toBeTruthy();
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/studios/members/${all.body.items[0].id}`, { token });
    expect(detail.body.memberships[0].invoices.length).toBeGreaterThan(0);
    const otherOwner = await verifiedUser(app);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/studios/members`, { token: otherOwner.token })).status).toBe(404);

    const rep = await call(app, 'GET', `/v1/orgs/${orgId}/studios/reports`, { token });
    expect(rep.status).toBe(200);
    expect(rep.body.combinedRevenue).toBeNull();
    expect(rep.body.revenue.map((r: any) => r.currency).sort()).toEqual(['CAD', 'USD']);
    const cad = rep.body.revenue.find((r: any) => r.currency === 'CAD');
    expect(cad.byCategory.packs).toBeGreaterThan(0);
    expect(cad.byCategory.memberships).toBeGreaterThan(0);
    expect(rep.body.revenue.find((r: any) => r.currency === 'USD').net).toBeNull();
    expect(rep.body.occupancy.byLocation.find((l: any) => l.locationId === loc.id).occupancyPct).not.toBeNull();

    const draft = await call(app, 'POST', `/v1/orgs/${orgId}/studios/ai/class-description`, { token, body: { classTypeId, tone: 'calm' } });
    expect(draft.body).toMatchObject({ source: 'template' });
    expect(draft.body.draft).toContain('Vinyasa Flow');
    expect(draft.body.draft).not.toMatch(/heal|cure|weight loss|injur/i);
    const sum = await call(app, 'GET', `/v1/orgs/${orgId}/studios/ai/attendance-summary?weeks=2`, { token });
    expect(sum.body.notInferred).toMatch(/not inferred/);
    const aud = await call(app, 'POST', `/v1/orgs/${orgId}/studios/ai/follow-up-audiences`, { token, body: {} });
    expect(aud.body.proposals.map((p: any) => p.key)).toEqual(['intro_not_converted', 'credits_expiring', 'members_not_seen', 'recently_lapsed']);
    expect(aud.body.proposals.every((p: any) => p.status === 'proposed')).toBe(true);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/ai/follow-up-audiences`, { token: staff.token, body: {} })).status).toBe(403);
    void consentRecords;
  });
});
