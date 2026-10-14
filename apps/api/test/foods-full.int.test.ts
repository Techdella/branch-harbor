import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { foodMealPlanSubscriptions, foodSoldOutEvents, paymentReferences, webhookEvents } from '../src/db/schema/index.ts';
import { signStripePayload } from '../src/integrations/payments.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../src/lib/tz.ts';
import { createPaymentForTarget } from '../src/services/payments.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser, WEBHOOK_SECRET } from './helpers.ts';

const SEA = 'America/Los_Angeles';
const LON = 'Europe/London';

describe.skipIf(!hasDb)('foods full product (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let sea: any;
  let lon: any;
  let menuId: string;
  const ids: Record<string, string> = {};
  const contact = () => ({ name: 'Jo Guest', email: `guest-${uid()}@example.com` });
  const org = (path: string) => `/v1/orgs/${orgId}/foods${path}`;
  const pay = (paymentId: string) => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
  const settings = (locId: string, body: unknown) => call(app, 'PUT', org(`/locations/${locId}/settings`), { token, body });
  const tomorrow = (tz: string) => addDays(localDateParts(new Date(), tz).date, 1);
  const slotsAt = async (locId: string, date: string, open: string, close: string, capacity = 5) => {
    await call(app, 'POST', org(`/locations/${locId}/pickup-slots`), { token, body: { date, open, close, intervalMinutes: 15, capacity, cutoffMinutes: 10 } });
    const r = await call(app, 'GET', `/v1/public/foods/${locId}/pickup-slots?from=${encodeURIComponent(zonedToUtc(date, '00:00', SEA).toISOString())}&to=${encodeURIComponent(zonedToUtc(addDays(date, 2), '00:00', SEA).toISOString())}`);
    return r.body.items as Array<{ id: string; startsAt: string }>;
  };
  const checkout = (locId: string, body: Record<string, unknown>) => call(app, 'POST', `/v1/public/foods/${locId}/checkout`, { body: { contact: contact(), ...body } });
  const quote = (locId: string, body: Record<string, unknown>) => call(app, 'POST', `/v1/public/foods/${locId}/checkout/quote`, { body });

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: SEA })).id;
    sea = await createLocation(app, token, orgId, { name: 'Ballard', currency: 'USD', timeZone: SEA, address: { line1: '5410 22nd Ave NW', city: 'Seattle', region: 'WA', postalCode: '98107', country: 'US' } });
    lon = await createLocation(app, token, orgId, { name: 'Shoreditch', currency: 'GBP', timeZone: LON, address: { line1: '1 Rivington St', city: 'London', postalCode: 'EC2A 3DT', country: 'GB' } });
    for (const l of [sea, lon]) await enablePublicAndPayments(app, token, orgId, l.id);
    menuId = (await call(app, 'POST', org('/menus'), { token, body: { name: 'All day' } })).body.id;
    const item = async (body: Record<string, unknown>) => (await call(app, 'POST', org(`/menus/${menuId}/items`), { token, body: { localOverridable: ['price', 'available'], ...body } })).body;
    const bowl = await item({ category: 'Bowls', name: 'Ember bowl', prices: { USD: 1600, GBP: 1200 }, stationKey: 'grill', allergens: ['gluten'], dietary: ['gluten-free'], modifierGroups: [{ name: 'Sauce', minSelect: 1, maxSelect: 1, modifiers: [{ name: 'Chimichurri', prices: { USD: 0, GBP: 0 } }, { name: 'Smoked chili', prices: { USD: 100, GBP: 80 } }] }] });
    ids.bowl = bowl.id;
    expect(bowl.allergens).toEqual(['cereals_gluten']);
    ids.salad = (await item({ category: 'Salads', name: 'Green salad', prices: { USD: 1200, GBP: 900 }, stationKey: 'cold', allergensDeclared: true })).id;
    ids.lemonade = (await item({ category: 'Drinks', name: 'Maple lemonade', prices: { USD: 500, GBP: 400 }, stationKey: 'bar' })).id;
    const dp = await call(app, 'POST', org('/day-parts'), { token, body: { name: 'Breakfast', windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '07:00', end: '11:00' })) } });
    expect(dp.status).toBe(201);
    ids.breakfast = dp.body.id;
    ids.pancakes = (await item({ category: 'Breakfast', name: 'Buttermilk pancakes', prices: { USD: 1400, GBP: 1000 }, dayPartIds: [ids.breakfast], stationKey: 'grill' })).id;
    const pub = await call(app, 'POST', org(`/menus/${menuId}/publish`), { token });
    expect(pub.status).toBe(200);
    expect(pub.body.locations.map((l: any) => l.status)).toEqual(['succeeded', 'succeeded']);
    const m = await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`);
    const b = m.body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === ids.bowl);
    ids.chimi = b.modifierGroups[0].modifiers[0].id;
    ids.chili = b.modifierGroups[0].modifiers[1].id;
  });
  afterAll(async () => { await app?.close(); });

  it('rejects allergen/dietary labels outside the controlled vocabulary and shows the location convention', async () => {
    const bad = await call(app, 'POST', org(`/menus/${menuId}/items`), { token, body: { category: 'X', name: 'Bad', prices: { USD: 100 }, allergens: ['glitter'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.allergens).toMatch(/glitter/);
    const m = await call(app, 'GET', `/v1/public/foods/${lon.id}/menu`);
    expect(m.body.allergenRegime).toBe('eu14');
    const items = m.body.categories.flatMap((c: any) => c.items);
    expect(items.find((i: any) => i.id === ids.salad).allergenInfo).toMatchObject({ status: 'declared', items: [] });
    // Never declared → "not provided", never "none".
    expect(items.find((i: any) => i.id === ids.lemonade).allergenInfo.status).toBe('not_provided');
    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`)).body.allergenRegime).toBe('us9');
  });

  it('evaluates day-part availability at the order time in each location time zone', async () => {
    const date = tomorrow(SEA);
    const breakfastSea = zonedToUtc(date, '08:00', SEA);
    const lunchSea = zonedToUtc(date, '13:00', SEA);
    const at = async (locId: string, t: Date) => (await call(app, 'GET', `/v1/public/foods/${locId}/menu?at=${encodeURIComponent(t.toISOString())}`)).body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === ids.pancakes);
    expect((await at(sea.id, breakfastSea)).available).toBe(true);
    const lunch = await at(sea.id, lunchSea);
    expect(lunch).toMatchObject({ available: false, unavailableCode: 'outside_day_part' });
    expect(lunch.unavailableReason).toMatch(/Breakfast \(07:00–11:00\)/);
    // 08:00 in Seattle is 16:00 in London: same instant, breakfast is over there.
    expect((await at(lon.id, breakfastSea)).available).toBe(false);
    expect((await at(lon.id, zonedToUtc(tomorrow(LON), '09:30', LON))).available).toBe(true);

    // Server-side: a 13:00 pickup cannot include breakfast items.
    const slots = await slotsAt(sea.id, date, '08:00', '14:00');
    const late = slots.find((x) => x.startsAt === lunchSea.toISOString())!;
    const early = slots.find((x) => x.startsAt === breakfastSea.toISOString())!;
    const refused = await checkout(sea.id, { channel: 'pickup', pickupSlotId: late.id, lines: [{ menuItemId: ids.pancakes, quantity: 1 }] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('menu_check_failed');
    const ok = await checkout(sea.id, { channel: 'pickup', pickupSlotId: early.id, lines: [{ menuItemId: ids.pancakes, quantity: 1 }] });
    expect(ok.status).toBe(201);
  });

  it('rejects a modifier that sold out mid-checkout and resets it at close', async () => {
    const date = tomorrow(SEA);
    const slots = await slotsAt(sea.id, date, '15:00', '16:00');
    const body = { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.bowl, quantity: 1, modifierIds: [ids.chili] }] };
    const q = await quote(sea.id, body);
    expect(q.status).toBe(200);
    expect(q.body.total).toEqual({ amount: 1700, currency: 'USD' });
    // Staff mark the option sold out (until close by default) while the guest is checking out.
    const so = await call(app, 'PUT', org(`/locations/${sea.id}/modifiers/${ids.chili}/sold-out`), { token, body: { soldOut: true } });
    expect(so.status).toBe(200);
    expect(so.body.soldOutUntil).toBeTruthy();
    const refused = await checkout(sea.id, { ...body, expectedTotalMinor: 1700 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('menu_check_failed');
    expect(refused.body.error.message).toMatch(/sold out/i);
    const menu = (await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`)).body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === ids.bowl);
    expect(menu.modifierGroups[0].modifiers.find((m: any) => m.id === ids.chili)).toMatchObject({ soldOut: true, available: false });
    // The other (required) option still works.
    expect((await checkout(sea.id, { ...body, lines: [{ menuItemId: ids.bowl, quantity: 1, modifierIds: [ids.chimi] }] })).status).toBe(201);
    const list = await call(app, 'GET', org(`/locations/${sea.id}/sold-out`), { token });
    expect(list.body.modifiers.map((m: any) => m.id)).toContain(ids.chili);
    const events = await app.ctx.db.select().from(foodSoldOutEvents).where(eq(foodSoldOutEvents.modifierId, ids.chili!));
    expect(events).toHaveLength(1);
    expect(events[0]!.endedAt).toBeTruthy(); // ends at close (auto-reset)
    await call(app, 'PUT', org(`/locations/${sea.id}/modifiers/${ids.chili}/sold-out`), { token, body: { soldOut: false } });
  });

  it('checks delivery zones, fees, minimum orders and delivery slot capacity on the server', async () => {
    const all = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '00:00', close: '23:30' }));
    const st = await settings(sea.id, { channels: { delivery: true }, delivery: { hours: all, slotMinutes: 30, slotCapacity: 1, leadMinutes: 0, cutoffMinutes: 0, horizonDays: 2 }, coordinates: { lat: 47.6687, lng: -122.3843 } });
    expect(st.status).toBe(200);
    const pc = await call(app, 'POST', org(`/locations/${sea.id}/delivery-zones`), { token, body: { name: 'Ballard core', kind: 'postcode', postcodes: ['98107', '98117'], feeMinor: 399, minimumOrderMinor: 2000, freeDeliveryAboveMinor: 5000 } });
    expect(pc.status).toBe(201);
    const rz = await call(app, 'POST', org(`/locations/${sea.id}/delivery-zones`), { token, body: { name: 'Within 5 km', kind: 'radius', radiusMeters: 5000, feeMinor: 599, minimumOrderMinor: 2500 } });
    expect(rz.status).toBe(201);

    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery/check?postalCode=98107`)).body).toMatchObject({ deliverable: true, zone: { name: 'Ballard core', fee: { amount: 399, currency: 'USD' } } });
    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery/check?postalCode=10001`)).body.deliverable).toBe(false);
    // Fremont (~3.4 km) by coordinates → radius zone; Tacoma → nothing.
    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery/check?lat=47.6510&lng=-122.3500`)).body.zone.name).toBe('Within 5 km');
    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery/check?lat=47.2529&lng=-122.4443`)).body.deliverable).toBe(false);

    const slots = (await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery-slots?from=${encodeURIComponent(new Date(Date.now() + 2 * 3600_000).toISOString())}`)).body.items;
    expect(slots.length).toBeGreaterThan(2);
    const slot = slots.find((x: any) => x.available)!;
    const addr = { line1: '5500 Ballard Ave NW', city: 'Seattle', postalCode: '98107' };
    const outside = await quote(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: { ...addr, postalCode: '10001' }, lines: [{ menuItemId: ids.salad, quantity: 2 }] });
    expect(outside.body.error.code).toBe('outside_delivery_area');
    const small = await quote(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 1 }] });
    expect(small.status).toBe(409);
    expect(small.body.error).toMatchObject({ code: 'below_minimum', details: { minimumMinor: 2000, subtotalMinor: 1200, currency: 'USD' } });
    const q = await quote(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 2 }] });
    expect(q.body).toMatchObject({ subtotal: { amount: 2400 }, deliveryFee: { amount: 399, currency: 'USD' }, total: { amount: 2799 } });
    const free = await quote(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 5 }] });
    expect(free.body.deliveryFee.amount).toBe(0);

    const o1 = await checkout(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 2 }], expectedTotalMinor: 2799 });
    expect(o1.status).toBe(201);
    expect(o1.body.order).toMatchObject({ channel: 'delivery', deliveryFee: { amount: 399 }, fulfilment: { zoneName: 'Ballard core' } });
    const full = await checkout(sea.id, { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 2 }] });
    expect(full.body.error.code).toBe('slot_full');
    ids.deliveryOrder = o1.body.order.id;
    ids.deliveryPayment = o1.body.payment.id;
  });

  it('hands a delivery to an own driver: out for delivery → delivered (server-acknowledged)', async () => {
    await pay(ids.deliveryPayment!);
    const drv = await call(app, 'POST', org(`/locations/${sea.id}/drivers`), { token, body: { name: 'Dee Driver', phone: '+1 206 555 0100' } });
    const t = (to: string) => call(app, 'POST', org(`/orders/${ids.deliveryOrder}/transition`), { token, body: { to } });
    expect((await t('accepted')).status).toBe(200);
    const d = await call(app, 'POST', org(`/orders/${ids.deliveryOrder}/dispatch`), { token, body: { provider: 'own', driverId: drv.body.id } });
    expect(d.body).toMatchObject({ status: 'assigned', driver: { name: 'Dee Driver' } });
    // A pickup "collected" is not valid for a delivery order.
    await t('preparing'); await t('ready');
    expect((await t('collected')).body.error.code).toBe('invalid_transition');
    expect((await call(app, 'POST', org(`/deliveries/${d.body.id}/status`), { token, body: { status: 'picked_up' } })).body.status).toBe('picked_up');
    expect((await call(app, 'POST', org(`/deliveries/${d.body.id}/status`), { token, body: { status: 'delivered' } })).body.status).toBe('delivered');
    const orders = await call(app, 'GET', org(`/orders?locationId=${sea.id}&status=delivered`), { token });
    expect(orders.body.items.map((o: any) => o.id)).toContain(ids.deliveryOrder);
    // Provider adapter (sandbox): Uber Direct integration point.
    const providers = await call(app, 'GET', org('/delivery-providers'), { token });
    expect(providers.body.items.find((p: any) => p.key === 'uber_direct').mode).toBe('sandbox');
  });

  it('routes items to KDS stations, bumps and recalls with server acknowledgement', async () => {
    await call(app, 'POST', org(`/locations/${sea.id}/stations/defaults`), { token });
    const stations = (await call(app, 'GET', org(`/locations/${sea.id}/stations`), { token })).body.items;
    const grill = stations.find((x: any) => x.key === 'grill');
    const cold = stations.find((x: any) => x.key === 'cold');
    const slots = await slotsAt(sea.id, tomorrow(SEA), '17:00', '18:00');
    const o = await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.bowl, quantity: 2, modifierIds: [ids.chimi] }, { menuItemId: ids.salad, quantity: 1 }] });
    await pay(o.body.payment.id);
    await call(app, 'POST', org(`/orders/${o.body.order.id}/transition`), { token, body: { to: 'accepted' } });
    const g = await call(app, 'GET', org(`/kds?locationId=${sea.id}&stationId=${grill.id}`), { token });
    const gt = g.body.tickets.find((x: any) => x.orderId === o.body.order.id);
    expect(gt.lines).toEqual([{ index: 0, name: 'Ember bowl', quantity: 2, modifiers: ['Chimichurri'] }]);
    expect(gt.firstName).toBe('Jo');
    const c = await call(app, 'GET', org(`/kds?locationId=${sea.id}&stationId=${cold.id}`), { token });
    const ct = c.body.tickets.find((x: any) => x.orderId === o.body.order.id);
    expect(ct.lines.map((l: any) => l.name)).toEqual(['Green salad']);

    const bump1 = await call(app, 'POST', org(`/kds/tickets/${gt.id}/bump`), { token, body: { expectedStatus: 'queued' } });
    expect(bump1.body).toMatchObject({ ticket: { status: 'done' }, orderStatus: 'preparing', allStationsDone: false });
    const stale = await call(app, 'POST', org(`/kds/tickets/${gt.id}/bump`), { token, body: { expectedStatus: 'queued' } });
    expect(stale.body.error.code).toBe('stale_status');
    expect((await call(app, 'POST', org(`/kds/tickets/${ct.id}/bump`), { token })).body.allStationsDone).toBe(true);
    const expo = await call(app, 'GET', org(`/kds?locationId=${sea.id}`), { token });
    expect(expo.body.orders.find((x: any) => x.id === o.body.order.id)).toMatchObject({ allStationsDone: true, status: 'preparing' });
    expect((await call(app, 'POST', org(`/kds/tickets/${ct.id}/recall`), { token })).body.ticket.status).toBe('in_progress');
    await call(app, 'POST', org(`/kds/tickets/${ct.id}/bump`), { token });
    await call(app, 'POST', org(`/orders/${o.body.order.id}/transition`), { token, body: { to: 'ready' } });
    expect((await call(app, 'POST', org(`/kds/tickets/${ct.id}/recall`), { token })).body.error.code).toBe('order_already_ready');
  });

  it('depletes ingredients on order and automatically sells out when stock cannot cover a portion', async () => {
    const ing = await call(app, 'POST', org('/ingredients'), { token, body: { name: `Lemons ${uid()}`, unit: 'each' } });
    await call(app, 'PUT', org(`/items/${ids.lemonade}/recipe`), { token, body: { lines: [{ ingredientId: ing.body.id, quantity: 2 }] } });
    await call(app, 'PUT', org(`/locations/${sea.id}/ingredients/${ing.body.id}`), { token, body: { lowStockThreshold: 3, autoSoldOut: true } });
    const recv = await call(app, 'POST', org(`/locations/${sea.id}/ingredients/${ing.body.id}/movements`), { token, body: { reason: 'receive', quantity: 4 } });
    expect(recv.body.onHand).toBe(4);
    const slots = await slotsAt(sea.id, tomorrow(SEA), '19:00', '20:00');
    const first = await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.lemonade, quantity: 1 }] });
    expect(first.status).toBe(201);
    let stock = (await call(app, 'GET', org(`/ingredients?locationId=${sea.id}`), { token })).body.items.find((i: any) => i.id === ing.body.id).stock;
    expect(stock).toMatchObject({ onHand: 2, lowStock: true, exhausted: false });
    const tooMany = await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.lemonade, quantity: 2 }] });
    expect(tooMany.body.error.code).toBe('menu_check_failed');
    const second = await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.lemonade, quantity: 1 }] });
    expect(second.status).toBe(201);
    stock = (await call(app, 'GET', org(`/ingredients?locationId=${sea.id}`), { token })).body.items.find((i: any) => i.id === ing.body.id).stock;
    expect(stock).toMatchObject({ onHand: 0, exhausted: true });
    const item = (await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`)).body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === ids.lemonade);
    expect(item).toMatchObject({ available: false, unavailableReason: 'Sold out', soldOutSource: 'ingredient' });
    expect((await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[1]!.id, lines: [{ menuItemId: ids.lemonade, quantity: 1 }] })).body.error.fields['lines.0.menuItemId']).toMatch(/Sold out/);
    const events = await app.ctx.db.select().from(foodSoldOutEvents).where(eq(foodSoldOutEvents.menuItemId, ids.lemonade!));
    expect(events.some((e) => e.source === 'ingredient' && !e.endedAt)).toBe(true);
    // Cancelling an order gives its stock back → available again, sold-out period closed.
    await pay(second.body.payment.id);
    await call(app, 'POST', org(`/orders/${second.body.order.id}/transition`), { token, body: { to: 'rejected', note: 'Out of ice' } });
    const back = (await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`)).body.categories.flatMap((c: any) => c.items).find((i: any) => i.id === ids.lemonade);
    expect(back.available).toBe(true);
    const after = await app.ctx.db.select().from(foodSoldOutEvents).where(eq(foodSoldOutEvents.menuItemId, ids.lemonade!));
    expect(after.every((e) => e.endedAt)).toBe(true);
  });

  it('runs catering enquiry → quote → acceptance → deposit → confirmed, and lists it in the production summary', async () => {
    await settings(lon.id, { channels: { catering: true }, serviceCharge: { bps: 1250, label: 'Service', channels: ['catering', 'dine_in'] }, taxRateBps: 2000 });
    const pkg = await call(app, 'POST', org('/catering/packages'), { token, body: { name: 'Office lunch', pricesPerGuest: { GBP: 1500, USD: 1800 }, minGuests: 10, leadDays: 2, includes: ['Bowls', 'Salads'] } });
    expect(pkg.status).toBe(201);
    const eventDate = addDays(localDateParts(new Date(), LON).date, 7);
    const tooFew = await call(app, 'POST', `/v1/public/foods/${lon.id}/catering/enquiries`, { body: { contact: contact(), eventDate, guests: 4, packageId: pkg.body.id } });
    expect(tooFew.status).toBe(400);
    const e = await call(app, 'POST', `/v1/public/foods/${lon.id}/catering/enquiries`, { body: { contact: contact(), eventDate, eventTime: '12:30', guests: 20, packageId: pkg.body.id, dietaryNotes: '2 vegetarians' } });
    expect(e.status).toBe(201);
    expect(e.body.enquiry.status).toBe('new');
    const tokenE = e.body.manageToken;
    // Nothing to accept before the business quotes.
    expect((await call(app, 'POST', `/v1/public/foods/catering/enquiries/${e.body.enquiry.id}/accept`, { body: { token: tokenE } })).body.error.code).toBe('invalid_state');
    const q = await call(app, 'POST', org(`/catering/enquiries/${e.body.enquiry.id}/quote`), { token, body: { fromPackage: true, lines: [{ description: 'Ember bowls', menuItemId: ids.bowl, quantity: 20, unitPriceMinor: 0 }], depositBps: 3000, validDays: 5 } });
    expect(q.status).toBe(200);
    // 20 × £15 = £300; service 12.5% = £37.50; VAT 20% on items = £60; total £397.50; deposit 30% = £119.25
    expect(q.body.quote).toMatchObject({ subtotal: { amount: 30000, currency: 'GBP' }, serviceCharge: { amount: 3750 }, tax: { amount: 6000 }, total: { amount: 39750 }, deposit: { amount: 11925 } });
    const view = await call(app, 'GET', `/v1/public/foods/catering/enquiries/${e.body.enquiry.id}?token=${tokenE}`);
    expect(view.body.status).toBe('quoted');
    const acc = await call(app, 'POST', `/v1/public/foods/catering/enquiries/${e.body.enquiry.id}/accept`, { body: { token: tokenE, quoteVersion: 1 } });
    expect(acc.body.enquiry.status).toBe('accepted');
    expect(acc.body.payment).toBeTruthy();
    expect((await call(app, 'POST', org(`/catering/enquiries/${e.body.enquiry.id}/status`), { token, body: { to: 'confirmed' } })).body.error.code).toBe('deposit_pending');
    await pay(acc.body.payment.id);
    const paid = await call(app, 'GET', `/v1/public/foods/catering/enquiries/${e.body.enquiry.id}?token=${tokenE}`);
    expect(paid.body.status).toBe('deposit_paid');
    const conf = await call(app, 'POST', org(`/catering/enquiries/${e.body.enquiry.id}/status`), { token, body: { to: 'confirmed' } });
    expect(conf.body.status).toBe('confirmed');
    const prod = await call(app, 'GET', org(`/locations/${lon.id}/production-summary?date=${eventDate}`), { token });
    expect(prod.body.counts).toMatchObject({ cateringEvents: 1, guests: 20 });
    expect(prod.body.catering[0]).toMatchObject({ reference: e.body.enquiry.reference, dietaryNotes: '2 vegetarians' });
    expect(prod.body.stations.flatMap((st: any) => st.items).find((i: any) => i.name === 'Ember bowl').quantity).toBe(20);
    const rec = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(rec.body.items.filter((i: any) => i.paymentId === acc.body.payment.id)).toHaveLength(0);
    const report = await call(app, 'GET', org('/reports'), { token });
    expect(report.body.catering.stages.find((s0: any) => s0.status === 'confirmed')).toMatchObject({ count: 1, value: [{ amount: 39750, currency: 'GBP' }] });
  });

  it('subscribes to a meal plan (Stripe sandbox), skips a week before the cut-off and refuses after it', async () => {
    await settings(lon.id, { channels: { mealPlans: true } });
    const plan = await call(app, 'POST', org('/meal-plans'), { token, body: { name: 'Weekly prep box', mealsPerBox: 5, pricesPerWeek: { GBP: 5500, USD: 6900 }, fulfilmentWeekday: 1, cutoffDaysBefore: 3, cutoffTime: '18:00', menuItemIds: [ids.bowl, ids.salad], locationIds: [lon.id] } });
    expect(plan.status).toBe(201);
    const list = await call(app, 'GET', `/v1/public/foods/${lon.id}/meal-plans`);
    expect(list.body.plans[0]).toMatchObject({ price: { amount: 5500, currency: 'GBP' } });
    const sub = await call(app, 'POST', `/v1/public/foods/${lon.id}/meal-plans/subscriptions`, { body: { planId: plan.body.id, contact: contact() } });
    expect(sub.status).toBe(201);
    expect(sub.body.subscription.status).toBe('pending_payment');
    expect(sub.body.payment.sandbox).toBe(true);
    const tk = sub.body.manageToken;
    const id = sub.body.subscription.id;
    const act = await call(app, 'POST', `/v1/public/foods/meal-plans/subscriptions/${id}/sandbox-activate`, { body: { token: tk } });
    expect(act.body.subscription.status).toBe('active');
    const startWeek = sub.body.subscription.startWeek as string;
    expect(weekdayOf(startWeek)).toBe(1);
    const skip = await call(app, 'POST', `/v1/public/foods/meal-plans/subscriptions/${id}/skip`, { body: { token: tk, weekStart: startWeek } });
    expect(skip.status).toBe(200);
    expect(skip.body).toMatchObject({ changed: true, subscription: { skippedWeeks: [startWeek] } });
    expect(skip.body.creditId).toMatch(/^cbtxn_sandbox_/);
    const gen = await call(app, 'POST', org('/meal-plans/generate'), { token, body: { weekStart: startWeek, locationId: lon.id } });
    expect(gen.body).toMatchObject({ skipped: 1 });
    const gen2 = await call(app, 'POST', org('/meal-plans/generate'), { token, body: { weekStart: addDays(startWeek, 7), locationId: lon.id } });
    expect(gen2.body).toMatchObject({ skipped: 0 });
    // A week whose cut-off already passed cannot be skipped.
    const thisMonday = addDays(localDateParts(new Date(), LON).date, -((weekdayOf(localDateParts(new Date(), LON).date) + 6) % 7));
    const pastWeek = addDays(thisMonday, -7);
    await app.ctx.db.update(foodMealPlanSubscriptions).set({ startWeek: pastWeek }).where(eq(foodMealPlanSubscriptions.id, id));
    const late = await call(app, 'POST', `/v1/public/foods/meal-plans/subscriptions/${id}/skip`, { body: { token: tk, weekStart: pastWeek } });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('skip_cutoff_passed');
    expect((await call(app, 'POST', `/v1/public/foods/meal-plans/subscriptions/${id}/skip`, { body: { token: tk, weekStart: addDays(startWeek, 1) } })).status).toBe(400);
  });

  it('flags duplicate payments for the same order and never double-processes a replayed event', async () => {
    const slots = await slotsAt(sea.id, tomorrow(SEA), '20:00', '21:00');
    const o = await checkout(sea.id, { channel: 'pickup', pickupSlotId: slots[0]!.id, lines: [{ menuItemId: ids.salad, quantity: 1 }] });
    const [p1] = await app.ctx.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.body.payment.id));
    const payload = JSON.stringify({ id: `evt_${uid()}`, object: 'event', type: 'payment_intent.succeeded', api_version: '2026-09-30', created: 1, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, data: { object: { id: p1!.externalId, object: 'payment_intent', amount: p1!.amountMinor, amount_received: p1!.amountMinor, currency: 'usd', status: 'succeeded', metadata: {} } } });
    const post = () => app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload, headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(payload, WEBHOOK_SECRET) } });
    expect((await post()).json()).toMatchObject({ duplicate: false });
    expect((await post()).json()).toMatchObject({ duplicate: true });
    expect(await app.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.paymentId, p1!.id))).toHaveLength(1);
    // The customer pays a second time (e.g. a retried checkout on another device): a second succeeded payment.
    const p2 = await createPaymentForTarget(app.ctx, { organizationId: orgId, locationId: sea.id, amountMinor: p1!.amountMinor, currency: 'USD', targetType: 'food_order', targetId: o.body.order.id });
    await pay(p2.payment.id);
    const rec = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    const dup = rec.body.items.filter((i: any) => i.targetId === o.body.order.id);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ kind: 'duplicate_payment', paymentId: p2.payment.id, actual: { amount: p1!.amountMinor, currency: 'USD' } });
    // The order stays linked to the original payment.
    const orders = await call(app, 'GET', org(`/orders?locationId=${sea.id}`), { token });
    expect(orders.body.items.find((x: any) => x.id === o.body.order.id).paymentStatus).toBe('paid');
    // Refunding the duplicate clears it from the queue.
    await call(app, 'POST', `/v1/orgs/${orgId}/payments/${p2.payment.id}/refunds`, { token, body: { amountMinor: p1!.amountMinor, confirmCurrency: 'USD', reason: 'Duplicate payment' } });
    const rec2 = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(rec2.body.items.filter((i: any) => i.targetId === o.body.order.id)).toHaveLength(0);
    // Paid order never received: a provider payment for an order record that does not exist lands in the queue.
    const ghost = crypto.randomUUID();
    const p3 = await createPaymentForTarget(app.ctx, { organizationId: orgId, locationId: sea.id, amountMinor: 999, currency: 'USD', targetType: 'food_order', targetId: ghost });
    await pay(p3.payment.id);
    const rec3 = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(rec3.body.items.find((i: any) => i.targetId === ghost)).toMatchObject({ kind: 'paid_without_record' });
  });

  it('takes dine-in QR orders onto a tab with service charge and tip, then settles the tab online', async () => {
    await settings(lon.id, { channels: { dineIn: true }, tips: { enabled: true, channels: ['dine_in'] } });
    // Kitchen hours cover now, so the kitchen is open.
    await call(app, 'PUT', org(`/locations/${lon.id}/pickup-settings`), { token, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '00:00', close: '23:59' })), slotMinutes: 15, slotCapacity: 5, prepBufferMinutes: 0, cutoffMinutes: 0, horizonDays: 1 } });
    const table = await call(app, 'POST', org(`/locations/${lon.id}/tables`), { token, body: { label: `T${uid().slice(0, 3)}`, seats: 4 } });
    expect(table.status).toBe(201);
    const look = await call(app, 'GET', `/v1/public/foods/tables/${table.body.code}`);
    expect(look.body).toMatchObject({ dineInEnabled: true, kitchenOpen: true, openTab: false, location: { id: lon.id } });
    const q = await quote(lon.id, { channel: 'dine_in', tableCode: table.body.code, lines: [{ menuItemId: ids.salad, quantity: 2 }] });
    // £18 + 12.5% service (£2.25) + 20% VAT on items (£3.60)
    expect(q.body).toMatchObject({ subtotal: { amount: 1800 }, serviceCharge: { amount: 225, label: 'Service' }, tax: { amount: 360 }, total: { amount: 2385 }, table: { label: table.body.label } });
    const first = await checkout(lon.id, { channel: 'dine_in', tableCode: table.body.code, payMode: 'tab', lines: [{ menuItemId: ids.salad, quantity: 2 }] });
    expect(first.status).toBe(201);
    expect(first.body.order.paymentStatus).toBe('on_tab');
    expect(first.body.tabToken).toBeTruthy();
    const other = await checkout(lon.id, { channel: 'dine_in', tableCode: table.body.code, payMode: 'tab', lines: [{ menuItemId: ids.lemonade, quantity: 1 }] });
    expect(other.body.error.code).toBe('tab_open');
    const second = await checkout(lon.id, { channel: 'dine_in', tableCode: table.body.code, payMode: 'tab', tabToken: first.body.tabToken, lines: [{ menuItemId: ids.lemonade, quantity: 1 }] });
    expect(second.status).toBe(201);
    // Tab orders reach the kitchen without an online payment and can be accepted.
    expect((await call(app, 'POST', org(`/orders/${first.body.order.id}/transition`), { token, body: { to: 'accepted' } })).status).toBe(200);
    const tabId = first.body.order.fulfilment.tabId;
    const tab = await call(app, 'GET', `/v1/public/foods/tabs/${tabId}?token=${first.body.tabToken}`);
    expect(tab.body.orders).toHaveLength(2);
    const due = tab.body.amountDue.amount;
    const paid = await call(app, 'POST', `/v1/public/foods/tabs/${tabId}/pay`, { body: { token: first.body.tabToken, tipMinor: 300 } });
    expect(paid.body.amount).toEqual({ amount: due + 300, currency: 'GBP' });
    await pay(paid.body.payment.id);
    const closed = await call(app, 'GET', `/v1/public/foods/tabs/${tabId}?token=${first.body.tabToken}`);
    expect(closed.body.status).toBe('paid');
    const rec = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token });
    expect(rec.body.items.filter((i: any) => i.paymentId === paid.body.payment.id)).toHaveLength(0);
  });

  it('publishes with a preview and honest per-location results', async () => {
    const m2 = (await call(app, 'POST', org('/menus'), { token, body: { name: 'US specials' } })).body.id;
    await call(app, 'POST', org(`/menus/${m2}/items`), { token, body: { category: 'Specials', name: 'Clam chowder', prices: { USD: 900 } } });
    const preview = await call(app, 'GET', org(`/menus/${m2}/publish-preview`), { token });
    const byLoc = Object.fromEntries(preview.body.locations.map((l: any) => [l.locationId, l]));
    expect(byLoc[sea.id].wouldBe).toBe('succeeded');
    expect(byLoc[lon.id]).toMatchObject({ wouldBe: 'failed', reason: 'No item has a price in GBP' });
    const pub = await call(app, 'POST', org(`/menus/${m2}/publish`), { token });
    expect(pub.body.summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect((await call(app, 'GET', `/v1/public/foods/${lon.id}/menu`)).body.categories.some((c: any) => c.name === 'Specials')).toBe(false);
    expect((await call(app, 'GET', `/v1/public/foods/${sea.id}/menu`)).body.categories.some((c: any) => c.name === 'Specials')).toBe(true);
  });

  it('reports orders by channel and revenue per currency without combining currencies', async () => {
    const r = await call(app, 'GET', org('/reports'), { token });
    expect(r.status).toBe(200);
    expect(r.body.combinedRevenue).toBeNull();
    expect(r.body.ordersByChannel.map((c: any) => c.channel).sort()).toEqual(expect.arrayContaining(['delivery', 'dine_in', 'pickup']));
    expect(r.body.revenueByCurrency.map((c: any) => c.currency).sort()).toEqual(['GBP', 'USD']);
    expect(r.body.soldOut.some((x: any) => x.name === 'Maple lemonade')).toBe(true);
    expect(r.body.prepTimes.locations.find((l: any) => l.locationId === sea.id).orders).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasDb)('foods AI drafts never change data and flag unsupported claims (DB)', () => {
  let app: FastifyInstance;
  afterAll(async () => { await app?.close(); });
  it('returns a reviewed draft and nothing else', async () => {
    const fake = { enabled: true, model: 'test-model', async createMessage() { return { content: [{ type: 'text', text: 'A vegan, nut-free bowl of charred corn and greens.' }] } as never; } };
    app = await makeApp({ ai: fake });
    const { token } = await verifiedUser(app);
    const orgId = (await createOrg(app, token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: SEA })).id;
    const menu = (await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus`, { token, body: { name: 'M' } })).body.id;
    const item = (await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu}/items`, { token, body: { category: 'Bowls', name: 'Corn bowl', description: 'Old copy', prices: { USD: 1000 }, dietary: ['vegetarian'] } })).body;
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/foods/ai/menu-copy`, { token, body: { menuItemId: item.id } });
    expect(r.status).toBe(200);
    expect(r.body.needsReview).toBe(true);
    expect(r.body.warnings.join(' ')).toMatch(/vegan/);
    expect(r.body.warnings.join(' ')).toMatch(/nut-free/);
    const b = await call(app, 'GET', `/v1/orgs/${orgId}/foods/builder`, { token });
    const saved = b.body.menus[0].items[0];
    expect(saved).toMatchObject({ description: 'Old copy', dietary: ['vegetarian'], prices: { USD: 1000 } });
  });
});
