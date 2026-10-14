import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditEvents, locations, pushTokens } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('mobile endpoints: push tokens, my bookings/orders, order quote, customer messages (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let customer: { token: string; userId: string; email: string };
  let orgId: string;
  let loc: any;
  let foodLoc: any;
  let foodOrgId: string;
  let bowlId: string;
  let largeId: string;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Owner Person');
    customer = await verifiedUser(app, 'Casey Customer');
    orgId = (await createOrg(app, owner.token)).id;
    loc = await createLocation(app, owner.token, orgId);
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);

    foodOrgId = (await createOrg(app, owner.token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    foodLoc = await createLocation(app, owner.token, foodOrgId, { currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '1 Pike St', city: 'Seattle', region: 'WA', country: 'US' } });
    await enablePublicAndPayments(app, owner.token, foodOrgId, foodLoc.id);
    const menu = await call(app, 'POST', `/v1/orgs/${foodOrgId}/foods/menus`, { token: owner.token, body: { name: 'Main' } });
    const bowl = await call(app, 'POST', `/v1/orgs/${foodOrgId}/foods/menus/${menu.body.id}/items`, {
      token: owner.token, body: { category: 'Bowls', name: 'Bowl', prices: { USD: 1600 }, modifierGroups: [{ name: 'Size', minSelect: 1, maxSelect: 1, modifiers: [{ name: 'Regular', prices: { USD: 0 } }, { name: 'Large', prices: { USD: 300 } }] }] },
    });
    bowlId = bowl.body.id;
    await call(app, 'POST', `/v1/orgs/${foodOrgId}/foods/menus/${menu.body.id}/publish`, { token: owner.token });
    const m = await call(app, 'GET', `/v1/public/foods/${foodLoc.id}/menu`);
    largeId = m.body.categories[0].items[0].modifierGroups[0].modifiers[1].id;
  });
  afterAll(async () => { await app?.close(); });

  it('registers, moves and unregisters Expo push tokens per user', async () => {
    const token = `ExponentPushToken[${uid()}${uid()}]`;
    expect((await call(app, 'POST', '/v1/me/push-tokens', { body: { token, platform: 'ios' } })).status).toBe(401);
    const bad = await call(app, 'POST', '/v1/me/push-tokens', { token: customer.token, body: { token, platform: 'blackberry' } });
    expect(bad.status).toBe(400);

    const r1 = await call(app, 'POST', '/v1/me/push-tokens', { token: customer.token, body: { token, platform: 'ios', deviceId: 'iphone-1', appVersion: '0.1.0' } });
    expect(r1.status).toBe(201);
    const again = await call(app, 'POST', '/v1/me/push-tokens', { token: customer.token, body: { token, platform: 'ios' } });
    expect(again.body.id).toBe(r1.body.id);

    // The same device token registered by someone else moves to them (one row per token).
    await call(app, 'POST', '/v1/me/push-tokens', { token: owner.token, body: { token, platform: 'ios' } });
    let rows = await app.ctx.db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(owner.userId);

    // Only the holder can unregister it.
    expect((await call(app, 'DELETE', '/v1/me/push-tokens', { token: customer.token, body: { token } })).status).toBe(204);
    expect(await app.ctx.db.select().from(pushTokens).where(eq(pushTokens.token, token))).toHaveLength(1);
    expect((await call(app, 'DELETE', '/v1/me/push-tokens', { token: owner.token, body: { token } })).status).toBe(204);
    rows = await app.ctx.db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(0);
    const audits = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.targetId, r1.body.id));
    expect(audits.map((a) => a.action)).toContain('push_token.registered');
  });

  it('lists my bookings and waitlist places (matched by email) and lets only me cancel them', async () => {
    const ct = await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token: owner.token, body: { locationId: loc.id, name: 'Slow Flow', durationMinutes: 75, defaultCapacity: 1 } });
    const occ = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token: owner.token, body: { locationId: loc.id, classTypeId: ct.body.id, startsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), capacity: 1 } })).body.items[0];
    const occ2 = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token: owner.token, body: { locationId: loc.id, classTypeId: ct.body.id, startsAt: new Date(Date.now() + 4 * 86400_000).toISOString(), capacity: 1 } })).body.items[0];

    expect((await call(app, 'GET', '/v1/me/bookings', { token: customer.token })).body.items).toEqual([]);
    const booked = await call(app, 'POST', `/v1/public/studios/occurrences/${occ.id}/bookings`, { body: { contact: { name: 'Casey Customer', email: customer.email.toUpperCase() } } });
    expect(booked.body.outcome).toBe('confirmed');
    await call(app, 'POST', `/v1/public/studios/occurrences/${occ2.id}/bookings`, { body: { contact: { name: 'Someone Else', email: `x-${uid()}@example.com` } } });
    const wl = await call(app, 'POST', `/v1/public/studios/occurrences/${occ2.id}/bookings`, { body: { contact: { name: 'Casey Customer', email: customer.email }, joinWaitlist: true } });
    expect(wl.body.outcome).toBe('waitlisted');

    const mine = await call(app, 'GET', '/v1/me/bookings', { token: customer.token });
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(2);
    expect(mine.body.items[0]).toMatchObject({ id: booked.body.bookingId, kind: 'booking', status: 'confirmed', className: 'Slow Flow', durationMinutes: 75, location: { id: loc.id, timeZone: 'America/Toronto' } });
    expect(mine.body.items[1]).toMatchObject({ kind: 'waitlist', status: 'waitlisted', waitlistPosition: 1 });

    // Someone else's account cannot see or cancel it.
    expect((await call(app, 'GET', '/v1/me/bookings', { token: owner.token })).body.items).toEqual([]);
    expect((await call(app, 'POST', `/v1/me/bookings/${booked.body.bookingId}/cancel`, { token: owner.token })).status).toBe(404);

    const c = await call(app, 'POST', `/v1/me/bookings/${booked.body.bookingId}/cancel`, { token: customer.token });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', payment: { action: 'none' } });
    const after = await call(app, 'GET', '/v1/me/bookings', { token: customer.token });
    expect(after.body.items.find((i: any) => i.id === booked.body.bookingId).status).toBe('cancelled');
    expect((await call(app, 'POST', `/v1/me/bookings/${booked.body.bookingId}/cancel`, { token: customer.token })).body.error.code).toBe('booking_not_active');
  });

  it('quotes a cart with the configured tax, applying the same checks as ordering', async () => {
    const lines = [{ menuItemId: bowlId, quantity: 2, modifierIds: [largeId] }];
    const noTax = await call(app, 'POST', `/v1/public/foods/${foodLoc.id}/quote`, { body: { lines } });
    expect(noTax.status).toBe(200);
    expect(noTax.body).toMatchObject({ subtotal: { amount: 3800, currency: 'USD' }, tax: null, total: { amount: 3800, currency: 'USD' } });
    expect(noTax.body.lines[0]).toMatchObject({ name: 'Bowl', quantity: 2, modifiers: ['Large'], unitPrice: { amount: 1900 }, lineTotal: { amount: 3800 } });

    await app.ctx.db.update(locations).set({ settings: { taxRateBps: 1035 } }).where(eq(locations.id, foodLoc.id));
    const taxed = await call(app, 'POST', `/v1/public/foods/${foodLoc.id}/quote`, { body: { lines } });
    expect(taxed.body).toMatchObject({ tax: { amount: 393, currency: 'USD' }, taxRateBps: 1035, taxInclusive: false, total: { amount: 4193 } });

    const missing = await call(app, 'POST', `/v1/public/foods/${foodLoc.id}/quote`, { body: { lines: [{ menuItemId: bowlId, quantity: 1 }] } });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('menu_check_failed');
    expect((await call(app, 'POST', `/v1/public/foods/${loc.id}/quote`, { body: { lines } })).status).toBe(409);
  });

  it('lists my pickup orders', async () => {
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await call(app, 'POST', `/v1/orgs/${foodOrgId}/foods/locations/${foodLoc.id}/pickup-slots`, { token: owner.token, body: { date: tomorrow, open: '12:00', close: '13:00', capacity: 5 } });
    const slots = (await call(app, 'GET', `/v1/public/foods/${foodLoc.id}/pickup-slots?from=${encodeURIComponent(new Date().toISOString())}`)).body.items;
    const o = await call(app, 'POST', `/v1/public/foods/${foodLoc.id}/orders`, { body: { pickupSlotId: slots[0].id, lines: [{ menuItemId: bowlId, quantity: 1, modifierIds: [largeId] }], contact: { name: 'Casey Customer', email: customer.email } } });
    expect(o.status).toBe(201);
    const mine = await call(app, 'GET', '/v1/me/food-orders', { token: customer.token });
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ id: o.body.order.id, status: 'awaiting_acceptance', location: { id: foodLoc.id, timeZone: 'America/Los_Angeles' } });
    expect((await call(app, 'GET', '/v1/me/food-orders', { token: owner.token })).body.items).toEqual([]);
  });

  it('carries customer ↔ location messages with scoped staff access', async () => {
    expect((await call(app, 'POST', '/v1/me/messages', { token: customer.token, body: { locationId: loc.id, body: '   ' } })).status).toBe(400);
    const sent = await call(app, 'POST', '/v1/me/messages', { token: customer.token, body: { locationId: loc.id, body: 'Do you have mats to borrow?' } });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ direction: 'inbound', body: 'Do you have mats to borrow?' });

    // Staff without customers.read cannot read conversations.
    const staff = await verifiedUser(app, 'Sam Staff');
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: staff.email, role: 'staff', scope: { kind: 'location', id: loc.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: staff.token, body: { token: inv.body.devInvitationToken } });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/messages?locationId=${loc.id}`, { token: staff.token })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/messages`, { token: staff.token, body: { locationId: loc.id, customerUserId: customer.userId, body: 'Hi' } })).status).toBe(403);

    const inbox = await call(app, 'GET', `/v1/orgs/${orgId}/messages?locationId=${loc.id}`, { token: owner.token });
    expect(inbox.body.items[0]).toMatchObject({ direction: 'inbound', customer: { id: customer.userId, name: 'Casey Customer' } });

    // Replies only go to existing conversations.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/messages`, { token: owner.token, body: { locationId: loc.id, customerUserId: owner.userId, body: 'Hello' } })).status).toBe(404);
    const reply = await call(app, 'POST', `/v1/orgs/${orgId}/messages`, { token: owner.token, body: { locationId: loc.id, customerUserId: customer.userId, body: 'Yes — mats are free.' } });
    expect(reply.status).toBe(201);

    const thread = await call(app, 'GET', `/v1/me/messages?locationId=${loc.id}`, { token: customer.token });
    expect(thread.body.items.map((m: any) => m.direction)).toEqual(['inbound', 'outbound']);
    expect(thread.body.items[1]).toMatchObject({ authorName: loc.name, body: 'Yes — mats are free.' });
    // Another user's thread at the same location is separate.
    expect((await call(app, 'GET', `/v1/me/messages?locationId=${loc.id}`, { token: owner.token })).body.items).toEqual([]);
    const audits = await app.ctx.db.select().from(auditEvents).where(eq(auditEvents.targetId, reply.body.id));
    expect(audits[0]?.action).toBe('customer_message.sent');
  });
});
