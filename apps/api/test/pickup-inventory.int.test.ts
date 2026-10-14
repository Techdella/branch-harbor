import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { pickupSlots } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const allWeek = (open: string, close: string) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open, close }));

describe.skipIf(!hasDb)('foods pickup settings feed pickup slot generation (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let itemId: string;

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'foods', country: 'NL', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Amsterdam', dataRegion: 'eu' })).id;
    loc = await createLocation(app, token, orgId, { name: 'Jordaan', currency: 'EUR', timeZone: 'Europe/Amsterdam', address: { line1: 'Westerstraat 1', city: 'Amsterdam', country: 'NL' } });
    await enablePublicAndPayments(app, token, orgId, loc.id);
    const menu = await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus`, { token, body: { name: 'Main' } });
    itemId = (await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/items`, { token, body: { category: 'Soup', name: 'Pea soup', prices: { EUR: 900 } } })).body.id;
    await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/publish`, { token });
  });
  afterAll(async () => { await app?.close(); });

  it('only managers save settings; saving generates the horizon with capacity, cut-off and buffer', async () => {
    const staff = await memberWithRole(app, token, orgId, 'staff', { kind: 'location', id: loc.id });
    const body = { hours: allWeek('00:00', '23:45'), slotMinutes: 30, slotCapacity: 3, prepBufferMinutes: 45, cutoffMinutes: 30, horizonDays: 2, closedDates: [], acceptingOrders: true };
    expect((await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-settings`, { token: staff.token, body })).status).toBe(403);
    const bad = await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-settings`, { token, body: { ...body, hours: [{ weekday: 1, open: '12:00', close: '11:00' }] } });
    expect(bad.body.error.fields['hours.0.close']).toBeTruthy();

    const r = await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-settings`, { token, body });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: true, slotCapacity: 3, prepBufferMinutes: 45, location: { timeZone: 'Europe/Amsterdam' } });
    expect(r.body.slots.created).toBeGreaterThan(40);
    const slots = await app.ctx.db.select().from(pickupSlots).where(eq(pickupSlots.locationId, loc.id));
    const soonest = Math.min(...slots.map((s) => s.startsAt.getTime()));
    expect(soonest).toBeGreaterThanOrEqual(Date.now() + 44 * 60_000);
    expect(slots.every((s) => s.capacity === 3 && s.startsAt.getTime() - s.cutoffAt.getTime() === 30 * 60_000)).toBe(true);

    const list = await call(app, 'GET', `/v1/orgs/${orgId}/foods/pickup-settings`, { token: staff.token });
    expect(list.body.items[0]).toMatchObject({ configured: true, next24h: { capacity: expect.any(Number) } });
  });

  it('public slots reflect the settings; changing capacity keeps booked orders and removes nothing booked', async () => {
    const pub = await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots`);
    expect(pub.body).toMatchObject({ acceptingOrders: true, prepBufferMinutes: 45 });
    const slot = pub.body.items.find((x: any) => x.available);
    const o = await call(app, 'POST', `/v1/public/foods/${loc.id}/orders`, { body: { pickupSlotId: slot.id, lines: [{ menuItemId: itemId, quantity: 1 }], contact: { name: 'Pim', email: `p-${uid()}@example.com` } } });
    expect(o.status).toBe(201);

    const r = await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-settings`, { token, body: { hours: allWeek('00:00', '23:45'), slotMinutes: 30, slotCapacity: 1, prepBufferMinutes: 45, cutoffMinutes: 30, horizonDays: 2, closedDates: [], acceptingOrders: true } });
    expect(r.body.slots.updated).toBeGreaterThan(0);
    const [booked] = await app.ctx.db.select().from(pickupSlots).where(eq(pickupSlots.id, slot.id));
    expect(booked).toMatchObject({ capacity: 1, booked: 1 });
    expect((await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots`)).body.items.find((x: any) => x.id === slot.id).available).toBe(false);

    // Pausing pickup removes unbooked future slots but keeps the booked one; ordering is refused.
    await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-settings`, { token, body: { hours: allWeek('00:00', '23:45'), slotMinutes: 30, slotCapacity: 1, prepBufferMinutes: 45, cutoffMinutes: 30, horizonDays: 2, closedDates: [], acceptingOrders: false } });
    const left = await app.ctx.db.select().from(pickupSlots).where(and(eq(pickupSlots.locationId, loc.id), gt(pickupSlots.startsAt, new Date())));
    expect(left.map((s) => s.id)).toEqual([slot.id]);
    const pub2 = await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots`);
    expect(pub2.body.acceptingOrders).toBe(false);
    expect(pub2.body.items.every((x: any) => !x.available)).toBe(true);
  });
});

describe.skipIf(!hasDb)('commerce inventory history: adjustments with reason, reservations, sales (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let variantId: string;

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app, 'Store Owner'));
    orgId = (await createOrg(app, token, { industry: 'commerce', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    loc = await createLocation(app, token, orgId, { name: 'Portland', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '1 Burnside', city: 'Portland', region: 'OR', country: 'US' } });
    await enablePublicAndPayments(app, token, orgId, loc.id);
    const p = await call(app, 'POST', `/v1/orgs/${orgId}/commerce/products`, { token, body: { sku: 'NB-01', name: 'Field notebook', status: 'active', variants: [{ sku: 'NB-01-DOT', name: 'Dot grid', prices: { USD: 1800 } }] } });
    variantId = p.body.variants[0].id;
    await call(app, 'PUT', `/v1/orgs/${orgId}/commerce/locations/${loc.id}/variants/${variantId}`, { token, body: { reorderPoint: 5 } });
  });
  afterAll(async () => { await app?.close(); });

  it('records history with a running balance; reservations do not change on-hand stock; sales do', async () => {
    const move = (quantity: number, reason: string, note?: string) => call(app, 'POST', `/v1/orgs/${orgId}/commerce/stock-movements`, { token, body: { locationId: loc.id, variantId, quantity, reason, note } });
    expect((await move(20, 'received', 'PO-1001')).body.stockOnHand).toBe(20);
    expect((await move(-2, 'damage', 'Water damage')).body.stockOnHand).toBe(18);
    expect((await move(-30, 'adjustment')).body.error.code).toBe('insufficient_stock');

    const pending = await call(app, 'POST', `/v1/orgs/${orgId}/commerce/orders`, { token, body: { locationId: loc.id, lines: [{ variantId, quantity: 3 }] } });
    expect(pending.status).toBe(201);
    let inv = (await call(app, 'GET', `/v1/orgs/${orgId}/commerce/inventory?locationId=${loc.id}`, { token })).body.items[0];
    expect(inv).toMatchObject({ onHand: 18, reserved: 3, available: 15, lowStock: false, productName: 'Field notebook' });

    await call(app, 'POST', `/v1/orgs/${orgId}/commerce/orders`, { token, body: { locationId: loc.id, status: 'paid', lines: [{ variantId, quantity: 10 }] } });
    inv = (await call(app, 'GET', `/v1/orgs/${orgId}/commerce/inventory`, { token })).body.items[0];
    expect(inv).toMatchObject({ onHand: 8, reserved: 3, available: 5, lowStock: true });

    const hist = await call(app, 'GET', `/v1/orgs/${orgId}/commerce/stock-movements?locationId=${loc.id}`, { token });
    const rows = hist.body.items;
    expect(rows.map((r: any) => r.reason)).toEqual(['sale', 'reservation', 'damage', 'received']);
    expect(rows.map((r: any) => r.balanceAfter)).toEqual([8, null, 18, 20]);
    expect(rows.find((r: any) => r.reason === 'reservation')).toMatchObject({ affectsOnHand: false, reasonLabel: 'Reserved for unpaid order', quantity: -3 });
    expect(rows.find((r: any) => r.reason === 'damage')).toMatchObject({ note: 'Water damage', createdByName: 'Store Owner', variant: { sku: 'NB-01-DOT' }, location: { name: 'Portland' } });
    const onlyAdjust = await call(app, 'GET', `/v1/orgs/${orgId}/commerce/stock-movements?reason=damage,received`, { token });
    expect(onlyAdjust.body.items).toHaveLength(2);
  });
});
