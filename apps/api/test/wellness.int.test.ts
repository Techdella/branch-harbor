import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { appointments } from '../src/db/schema/index.ts';
import { zonedToUtc } from '../src/lib/tz.ts';
import { call, createLocation, createOrg, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('wellness: reservations and transactional reschedule (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let massage: any;
  let pracA: any;
  const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const at = (hhmm: string) => zonedToUtc(day, hhmm, 'Europe/London').toISOString();
  const allWeek = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
  const book = (startsAt: string, practitionerId?: string) =>
    call(app, 'POST', `/v1/public/wellness/${loc.id}/appointments`, { body: { serviceId: massage.id, practitionerId, startsAt, contact: { name: 'Client', email: `c-${uid()}@example.com` } } });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'wellness', country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London', dataRegion: 'eu' })).id;
    loc = await createLocation(app, token, orgId, { name: 'Shoreditch', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 Rivington St', city: 'London', country: 'GB' } });
    await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${loc.id}`, { token, body: { publiclyVisible: true } });
    massage = (await call(app, 'POST', `/v1/orgs/${orgId}/wellness/services`, { token, body: { locationId: loc.id, name: 'Deep tissue massage', durationMinutes: 60, bufferAfterMinutes: 15, priceMinor: 7500, requiredResourceType: 'room' } })).body;
    await call(app, 'POST', `/v1/orgs/${orgId}/wellness/resources`, { token, body: { locationId: loc.id, name: 'Room 1', type: 'room' } });
    pracA = (await call(app, 'POST', `/v1/orgs/${orgId}/wellness/practitioners`, { token, body: { locationId: loc.id, name: 'Ana Silva', serviceIds: [massage.id], availability: allWeek } })).body;
    await call(app, 'POST', `/v1/orgs/${orgId}/wellness/practitioners`, { token, body: { locationId: loc.id, name: 'Jordan Lee', serviceIds: [massage.id], availability: allWeek } });
  });
  afterAll(async () => { await app?.close(); });

  it('one room means two practitioners cannot both be booked at the same time (buffers enforced)', async () => {
    const first = await book(at('10:00'));
    expect(first.status).toBe(201);
    expect(first.body.appointment.price).toEqual({ amount: 7500, currency: 'GBP' });
    const clash = await book(at('10:30'));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('slot_unavailable');
    // 11:00 is inside the 15-minute buffer after the 10:00–11:00 appointment.
    expect((await book(at('11:00'))).status).toBe(409);
    expect((await book(at('11:15'))).status).toBe(201);
    const avail = await call(app, 'GET', `/v1/public/wellness/${loc.id}/availability?serviceId=${massage.id}&date=${day}`);
    const starts = avail.body.slots.map((x: any) => x.startsAt);
    expect(starts).not.toContain(at('10:00'));
    expect(starts).toContain(at('13:00'));
    expect((await book(at('08:00'))).status).toBe(409); // outside availability
  });

  it('reschedule secures the new slot before releasing the old; failure keeps the original intact', async () => {
    const mine = await book(at('14:00'), pracA.id);
    expect(mine.status).toBe(201);
    const blocker = await book(at('16:00'));
    expect(blocker.status).toBe(201);
    const before = await app.ctx.db.select().from(appointments).where(eq(appointments.organizationId, orgId));

    const fail = await call(app, 'POST', `/v1/public/wellness/appointments/${mine.body.appointment.id}/reschedule`, { body: { manageToken: mine.body.manageToken, startsAt: at('15:30') } });
    expect(fail.status).toBe(409);
    const [orig] = await app.ctx.db.select().from(appointments).where(eq(appointments.id, mine.body.appointment.id));
    expect(orig!.status).toBe('confirmed');
    expect(orig!.startsAt.toISOString()).toBe(at('14:00'));
    expect(await app.ctx.db.select().from(appointments).where(eq(appointments.organizationId, orgId))).toHaveLength(before.length);

    // Moving by 30 minutes overlaps the old reservation itself — allowed, because the swap is atomic.
    const ok = await call(app, 'POST', `/v1/public/wellness/appointments/${mine.body.appointment.id}/reschedule`, { body: { manageToken: mine.body.manageToken, startsAt: at('14:30') } });
    expect(ok.status).toBe(200);
    expect(ok.body.appointment).toMatchObject({ status: 'confirmed', startsAt: at('14:30'), rescheduledFromId: mine.body.appointment.id });
    const [old] = await app.ctx.db.select().from(appointments).where(eq(appointments.id, mine.body.appointment.id));
    expect(old!.status).toBe('rescheduled');
    expect(old!.rescheduledToId).toBe(ok.body.appointment.id);
  });
});
