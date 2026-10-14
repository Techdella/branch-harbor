import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('foods: menus with local overrides, server-checked pickup orders and the order state machine (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let bowlId: string;
  let lemonadeId: string;
  let sizeLarge: string;
  let slots: any[];

  const contact = () => ({ name: 'Jo Guest', email: `guest-${uid()}@example.com` });
  const order = (body: any) => call(app, 'POST', `/v1/public/foods/${loc.id}/orders`, { body });
  const transition = (id: string, to: string, note?: string) => call(app, 'POST', `/v1/orgs/${orgId}/foods/orders/${id}/transition`, { token, body: { to, note } });
  const pay = (paymentId: string) => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    loc = await createLocation(app, token, orgId, { name: 'Ballard', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '5410 22nd Ave NW', city: 'Seattle', region: 'WA', country: 'US' } });
    await enablePublicAndPayments(app, token, orgId, loc.id);
    const menu = await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus`, { token, body: { name: 'Main menu' } });
    const bowl = await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/items`, {
      token, body: { category: 'Bowls', name: 'Ember chicken bowl', prices: { USD: 1600, CAD: 2100 }, dietary: ['gluten-free'], modifierGroups: [{ name: 'Size', minSelect: 1, maxSelect: 1, modifiers: [{ name: 'Regular', prices: { USD: 0 } }, { name: 'Large', prices: { USD: 300 } }] }] },
    });
    bowlId = bowl.body.id;
    lemonadeId = (await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/items`, { token, body: { category: 'Drinks', name: 'Maple lemonade', prices: { USD: 500 }, localOverridable: ['available'] } })).body.id;
    const pub = await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/publish`, { token });
    expect(pub.body.locations[0].available).toBe(2);
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const gen = await call(app, 'POST', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-slots`, { token, body: { date: tomorrow, open: '11:00', close: '12:00', intervalMinutes: 15, capacity: 2 } });
    expect(gen.body.created).toBe(4);
    slots = (await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots?from=${encodeURIComponent(new Date().toISOString())}`)).body.items;
    const menuView = await call(app, 'GET', `/v1/public/foods/${loc.id}/menu`);
    sizeLarge = menuView.body.categories[0].items[0].modifierGroups[0].modifiers[1].id;
  });
  afterAll(async () => { await app?.close(); });

  it('enforces HQ locks on local overrides and applies local prices', async () => {
    const locked = await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/overrides/${lemonadeId}`, { token, body: { priceMinor: 450 } });
    expect(locked.status).toBe(403);
    expect(locked.body.error.fields.priceMinor).toBeTruthy();
    expect((await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/overrides/${bowlId}`, { token, body: { priceMinor: 1700 } })).status).toBe(200);
    const m = await call(app, 'GET', `/v1/public/foods/${loc.id}/menu`);
    const bowl = m.body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === bowlId);
    expect(bowl).toMatchObject({ price: { amount: 1700, currency: 'USD' }, priceOrigin: 'local', dietary: ['gluten-free'] });
  });

  it('checks menu, modifiers, totals and slot capacity on the server', async () => {
    const slot = slots[0];
    const missingSize = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: bowlId, quantity: 1 }], contact: contact() });
    expect(missingSize.status).toBe(409);
    expect(missingSize.body.error.code).toBe('menu_check_failed');
    const priceChanged = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: bowlId, quantity: 1, modifierIds: [sizeLarge] }], contact: contact(), expectedTotalMinor: 1900 });
    expect(priceChanged.body.error.code).toBe('price_changed');
    expect(priceChanged.body.error.details.totalMinor).toBe(2000);

    await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/overrides/${lemonadeId}`, { token, body: { soldOut: true } });
    const sold = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: lemonadeId, quantity: 1 }], contact: contact() });
    expect(sold.body.error.fields['lines.0.menuItemId']).toMatch(/Sold out/);
    await call(app, 'PUT', `/v1/orgs/${orgId}/foods/locations/${loc.id}/overrides/${lemonadeId}`, { token, body: { soldOut: false } });

    const ok1 = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: bowlId, quantity: 1, modifierIds: [sizeLarge] }, { menuItemId: lemonadeId, quantity: 2 }], contact: contact(), expectedTotalMinor: 3000 });
    expect(ok1.status).toBe(201);
    expect(ok1.body.order).toMatchObject({ status: 'awaiting_acceptance', paymentStatus: 'pending', total: { amount: 3000, currency: 'USD' } });
    const ok2 = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: lemonadeId, quantity: 1 }], contact: contact() });
    expect(ok2.status).toBe(201);
    const full = await order({ pickupSlotId: slot.id, lines: [{ menuItemId: lemonadeId, quantity: 1 }], contact: contact() });
    expect(full.body.error.code).toBe('slot_full');
  });

  it('moves an order through the kitchen states and refunds on rejection', async () => {
    const o = await order({ pickupSlotId: slots[1].id, lines: [{ menuItemId: lemonadeId, quantity: 3 }], contact: contact() });
    // Unpaid orders are hidden from the kitchen and cannot be accepted.
    const kitchenBefore = await call(app, 'GET', `/v1/orgs/${orgId}/foods/orders?locationId=${loc.id}`, { token });
    expect(kitchenBefore.body.items.find((x: any) => x.id === o.body.order.id)).toBeUndefined();
    expect((await transition(o.body.order.id, 'accepted')).body.error.code).toBe('payment_pending');

    await pay(o.body.payment.id);
    const kitchen = await call(app, 'GET', `/v1/orgs/${orgId}/foods/orders?locationId=${loc.id}`, { token });
    expect(kitchen.body.items.find((x: any) => x.id === o.body.order.id)).toMatchObject({ status: 'awaiting_acceptance', paymentStatus: 'paid' });

    expect((await transition(o.body.order.id, 'ready')).body.error.code).toBe('invalid_transition');
    for (const to of ['accepted', 'preparing', 'ready', 'collected']) {
      const r = await transition(o.body.order.id, to);
      expect(r.status).toBe(200);
      expect(r.body.order.status).toBe(to);
    }
    const stale = await call(app, 'POST', `/v1/orgs/${orgId}/foods/orders/${o.body.order.id}/transition`, { token, body: { to: 'cancelled', expectedFrom: 'ready' } });
    expect(stale.body.error.code).toBe('stale_status');

    const r = await order({ pickupSlotId: slots[2].id, lines: [{ menuItemId: bowlId, quantity: 1, modifierIds: [sizeLarge] }], contact: contact() });
    await pay(r.body.payment.id);
    expect((await transition(r.body.order.id, 'rejected')).status).toBe(400); // reason required
    const rej = await transition(r.body.order.id, 'rejected', 'Oven out of service');
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ paymentAction: 'refunded', order: { status: 'rejected', paymentStatus: 'refunded' } });
    const p = await call(app, 'GET', `/v1/orgs/${orgId}/payments/${r.body.payment.id}`, { token });
    expect(p.body).toMatchObject({ refundState: 'complete', refunded: { amount: 2000, currency: 'USD' } });
    // The slot capacity is released.
    const slotsAfter = (await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots`)).body.items;
    expect(slotsAfter.find((x: any) => x.id === slots[2].id).remaining).toBe(2);
    await app.ctx.jobs.drain();
    expect(app.ctx.mailer.outbox.some((m) => m.subject.includes('rejected') && m.text.includes('refund'))).toBe(true);
  });
});
