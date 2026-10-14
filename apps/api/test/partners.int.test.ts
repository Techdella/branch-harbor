/**
 * Partner integrations end to end against the DB. All partner HTTP goes to an injected mock fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { foodDeliveries, foodOrders, locations, realtySyndication } from '../src/db/schema/index.ts';
import { hmacHex, type FetchLike } from '../src/integrations/partners/http.ts';
import { addDays, localDateParts, zonedToUtc } from '../src/lib/tz.ts';
import { providerDeliveryQuote } from '../src/services/foods-partners.ts';
import { loadFoodConfig } from '../src/services/foods-menu.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
const failNext: Record<string, number> = {};
let deliveryCounter = 0;
const mock: FetchLike = async (url, init = {}) => {
  const body = init.body ? (/^[{[]/.test(init.body) ? JSON.parse(init.body) : init.body) : undefined;
  calls.push({ url, method: init.method ?? 'GET', body });
  const reply = (status: number, b: unknown) => ({ ok: status < 300, status, text: async () => JSON.stringify(b) });
  for (const [k, n] of Object.entries(failNext)) if (n > 0 && url.includes(k)) { failNext[k] = n - 1; return reply(500, { message: 'upstream unavailable' }); }
  if (url.includes('auth.uber.com')) return reply(200, { access_token: 'uber-token', expires_in: 2592000 });
  if (url.endsWith('/delivery_quotes')) return reply(200, { id: 'dqt_test', fee: 812, currency: 'usd', currency_type: 'USD', expires: new Date(Date.now() + 15 * 60_000).toISOString(), duration: 30 });
  if (/\/deliveries\/[^/]+\/cancel$/.test(url)) return reply(200, { id: 'x', status: 'canceled' });
  if (url.endsWith('/deliveries')) return reply(200, { id: `del_${++deliveryCounter}`, status: 'pending', tracking_url: `https://track.uber.example/del_${deliveryCounter}`, fee: 812, currency: 'usd', external_id: body.external_id, live_mode: false });
  if (url.endsWith('/oauth/token')) return reply(200, { access_token: 'dv-token', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  if (url.includes('deliverect.com')) return reply(200, { ok: true });
  if (url.includes('/v1/property/sendpropertydetails')) return reply(200, { success: true, message: 'ok', property: { agent_ref: body.property.agent_ref, rightmove_id: 99887766, rightmove_url: 'https://www.rightmove.co.uk/properties/99887766', change_type: 'CREATE' } });
  if (url.includes('/v1/property/removeproperty')) return reply(200, { success: true, message: 'removed', property: { agent_ref: body.property.agent_ref } });
  if (url.includes('/v1/property/getbranchpropertylist')) return reply(200, { success: true, property: [] });
  return reply(404, { message: `no mock for ${url}` });
};
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part));

describe.skipIf(!hasDb)('partner integrations (DB, mocked HTTP)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let sea: any;
  let lon: any;
  const ids: Record<string, any> = {};
  const org = (p: string) => `/v1/orgs/${orgId}${p}`;
  const pay = (paymentId: string) => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
  const transition = (id: string, to: string, note?: string) => call(app, 'POST', org(`/foods/orders/${id}/transition`), { token, body: { to, ...(note ? { note } : {}) } });
  const drain = () => app.ctx.jobs.drain();
  const addr = { line1: '5500 Ballard Ave NW', city: 'Seattle', postalCode: '98107' };

  beforeAll(async () => {
    app = await makeApp({ partnerFetch: mock, rightmoveFetch: () => mock });
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    sea = await createLocation(app, token, orgId, { name: 'Fremont', currency: 'USD', timeZone: 'America/Los_Angeles', phone: '+1 206 555 0100', address: { line1: '3416 Fremont Ave N', city: 'Seattle', region: 'WA', postalCode: '98103', country: 'US' } });
    lon = await createLocation(app, token, orgId, { name: 'Shoreditch', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 Rivington St', city: 'London', postalCode: 'EC2A 3DT', country: 'GB' } });
    for (const l of [sea, lon]) await enablePublicAndPayments(app, token, orgId, l.id);
    const menuId = (await call(app, 'POST', org('/foods/menus'), { token, body: { name: 'All day' } })).body.id;
    const item = async (b: Record<string, unknown>) => (await call(app, 'POST', org(`/foods/menus/${menuId}/items`), { token, body: { localOverridable: ['price', 'available'], ...b } })).body;
    ids.salad = (await item({ category: 'Salads', name: 'Green salad', prices: { USD: 1200, GBP: 900 }, allergens: ['mustard'], allergensDeclared: true })).id;
    ids.bowl = (await item({ category: 'Bowls', name: 'Ember bowl', prices: { USD: 1600, GBP: 1200 }, allergens: ['gluten', 'sesame'] })).id;
    expect((await call(app, 'POST', org(`/foods/menus/${menuId}/publish`), { token })).status).toBe(200);
    const all = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '00:00', close: '23:30' }));
    expect((await call(app, 'PUT', org(`/foods/locations/${sea.id}/settings`), { token, body: { channels: { delivery: true }, delivery: { provider: 'uber_direct', hours: all, slotMinutes: 30, slotCapacity: 5, leadMinutes: 0, cutoffMinutes: 0, horizonDays: 2 }, coordinates: { lat: 47.651, lng: -122.35 } } })).status).toBe(200);
    expect((await call(app, 'POST', org(`/foods/locations/${sea.id}/delivery-zones`), { token, body: { name: 'Fremont', kind: 'postcode', postcodes: ['98107', '98103'], feeMinor: 399, minimumOrderMinor: 0 } })).status).toBe(201);
  });
  afterAll(async () => { await app?.close(); });

  it('Uber Direct connection: masked credentials, sandbox until tested, live only after a passing test', async () => {
    const created = await call(app, 'POST', org('/partner-connections'), { token, body: { provider: 'uber_direct', locationId: sea.id, settings: { clientId: 'uber_client_123456', clientSecret: 'uber_secret_abcdef', customerId: 'cust-1', webhookSigningKey: 'whsec_uber_signing', feeMode: 'pass_through' } } });
    expect(created.status).toBe(201);
    ids.uberConn = created.body.id;
    expect(created.body).toMatchObject({ status: 'sandbox', mode: 'sandbox', config: { customerId: 'cust-1', feeMode: 'pass_through' }, credentials: { clientId: { set: true, masked: 'uber••••3456' }, clientSecret: { set: true, masked: 'uber••••cdef' } }, webhookUrl: expect.stringMatching(/\/v1\/webhooks\/uber-direct$/) });
    expect(JSON.stringify(created.body)).not.toContain('uber_secret_abcdef');
    expect((await call(app, 'PATCH', org(`/partner-connections/${ids.uberConn}`), { token, body: { mode: 'live' } })).body.error.code).toBe('test_required');
    const t = await call(app, 'POST', org(`/partner-connections/${ids.uberConn}/test`), { token });
    expect(t.body.result).toMatchObject({ ok: true, sandbox: false });
    const live = await call(app, 'PATCH', org(`/partner-connections/${ids.uberConn}`), { token, body: { mode: 'live' } });
    expect(live.body).toMatchObject({ status: 'live', mode: 'live' });
    const list = await call(app, 'GET', org('/partner-connections?industry=foods'), { token });
    expect(list.body.items.find((x: any) => x.id === ids.uberConn)).toMatchObject({ status: 'live', lastResult: { action: 'test', status: 'ok' } });
    expect(list.body.locations.find((l: any) => l.id === sea.id).uberDirectAvailable).toBe(true);
    // Partner connections never leak into the generic connectors list.
    expect((await call(app, 'GET', org('/connections'), { token })).body.items.some((c: any) => c.id === ids.uberConn)).toBe(false);
  });

  it('quote → create (idempotent external_id) → signed status webhooks → order out for delivery / delivered', async () => {
    const slots = (await call(app, 'GET', `/v1/public/foods/${sea.id}/delivery-slots?from=${encodeURIComponent(new Date(Date.now() + 2 * 3600_000).toISOString())}`)).body.items;
    const slot = slots.find((x: any) => x.available);
    const body = { channel: 'delivery', deliverySlotId: slot.id, address: addr, lines: [{ menuItemId: ids.salad, quantity: 2 }] };
    const q = await call(app, 'POST', `/v1/public/foods/${sea.id}/checkout/quote`, { body: { ...body, contact: { name: 'Jo Guest', email: 'jo@example.com' } } });
    expect(q.status).toBe(200);
    // pass_through: the customer pays the Uber quote, not the 3.99 zone fee.
    expect(q.body).toMatchObject({ deliveryFee: { amount: 812, currency: 'USD' }, deliveryPartner: { provider: 'uber_direct', feeMode: 'pass_through', sandbox: false } });
    const quoteBody = callsTo('/delivery_quotes')[0]!.body;
    expect(JSON.parse(quoteBody.dropoff_address)).toMatchObject({ street_address: ['5500 Ballard Ave NW'], zip_code: '98107' });
    expect(new Date(quoteBody.pickup_ready_dt).getTime()).toBeGreaterThan(Date.now());
    const o = await call(app, 'POST', `/v1/public/foods/${sea.id}/checkout`, { body: { ...body, contact: { name: 'Jo Guest', email: 'jo@example.com', phone: '+12065550111' } } });
    expect(o.status).toBe(201);
    expect(o.body.order.fulfilment.providerQuote).toMatchObject({ quoteId: 'dqt_test', feeMinor: 812, currency: 'USD' });
    ids.order = o.body.order.id;
    ids.manage = o.body.manageToken;
    await pay(o.body.payment.id);
    expect((await transition(ids.order, 'accepted')).status).toBe(200);

    // First attempt fails upstream → the reserved row keeps the same external id for the retry.
    failNext['/deliveries'] = 1;
    const fail = await call(app, 'POST', org(`/foods/orders/${ids.order}/dispatch`), { token, body: { provider: 'uber_direct' } });
    expect(fail.status).toBe(502);
    const d = await call(app, 'POST', org(`/foods/orders/${ids.order}/dispatch`), { token, body: { provider: 'uber_direct' } });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ provider: 'uber_direct', status: 'pending', sandbox: false, externalId: 'del_1', trackingUrl: 'https://track.uber.example/del_1', feeQuote: { amount: 812 } });
    const creates = callsTo('/deliveries').filter((c) => c.url.endsWith('/deliveries'));
    expect(creates).toHaveLength(2);
    expect(creates[0]!.body.external_id).toBe(d.body.id);
    expect(creates[1]!.body).toMatchObject({ external_id: d.body.id, idempotency_key: d.body.id, quote_id: 'dqt_test' });
    expect((await call(app, 'POST', org(`/foods/orders/${ids.order}/dispatch`), { token, body: { provider: 'uber_direct' } })).body.error.code).toBe('already_dispatched');
    ids.delivery = d.body.id;

    const send = (payload: Record<string, unknown>, key = 'whsec_uber_signing') => {
      const raw = JSON.stringify(payload);
      return app.inject({ method: 'POST', url: '/v1/webhooks/uber-direct', headers: { 'content-type': 'application/json', 'x-uber-signature': hmacHex(key, raw) }, payload: raw });
    };
    const ev = (id: string, status: string) => ({ id, kind: 'event.delivery_status', status, delivery_id: 'del_1', customer_id: 'cust-1', live_mode: false, created: new Date().toISOString(), data: { id: 'del_1', status, tracking_url: 'https://track.uber.example/del_1/live', courier: { name: 'Sam Rider' } } });
    const bad = await send(ev('evt_bad', 'delivered'), 'wrong-key');
    expect(bad.statusCode).toBe(401);
    const unsigned = await app.inject({ method: 'POST', url: '/v1/webhooks/uber-direct', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(ev('evt_x', 'delivered')) });
    expect(unsigned.statusCode).toBe(401);
    expect((await app.ctx.db.select().from(foodDeliveries).where(eq(foodDeliveries.id, ids.delivery)))[0]!.status).toBe('pending');

    expect((await send(ev('evt_1', 'pickup'))).json()).toMatchObject({ outcome: 'processed', detail: 'Delivery assigned' });
    const pc = await send(ev('evt_2', 'pickup_complete'));
    expect(pc.json().detail).toBe('Delivery picked_up');
    let [order] = await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.id, ids.order));
    expect(order!.status).toBe('out_for_delivery');
    expect(order!.statusHistory.map((h) => h.to)).toEqual(['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'out_for_delivery']);
    expect((await send(ev('evt_2', 'pickup_complete'))).json()).toMatchObject({ duplicate: true });
    expect((await send(ev('evt_1b', 'pickup'))).json()).toMatchObject({ outcome: 'ignored', detail: 'not newer' });
    expect((await send(ev('evt_3', 'delivered'))).json().detail).toBe('Delivery delivered');
    [order] = await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.id, ids.order));
    expect(order!.status).toBe('delivered');
    const track = await call(app, 'GET', `/v1/public/foods/orders/${ids.order}/track?token=${ids.manage}`);
    expect(track.body.delivery).toMatchObject({ status: 'delivered', provider: 'uber_direct', trackingUrl: 'https://track.uber.example/del_1/live' });
  });

  it('outside Uber Direct countries: own drivers with an honest notice; dispatch refused', async () => {
    const ae = await createLocation(app, token, orgId, { name: 'Dubai Marina', currency: 'AED', timeZone: 'Asia/Dubai', address: { line1: 'Marina Walk', city: 'Dubai', region: 'Dubai', postalCode: '00000', country: 'AE' } });
    expect((await call(app, 'POST', org('/partner-connections'), { token, body: { provider: 'uber_direct', locationId: ae.id, settings: {} } })).status).toBe(201);
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, ae.id));
    const cfg = await loadFoodConfig(app.ctx.db, ae.id);
    const r = await providerDeliveryQuote(app.ctx, loc!, { ...cfg, delivery: { ...cfg.delivery, provider: 'uber_direct' } }, { address: { line1: 'x', city: 'Dubai' }, deliverBy: null, dropoffDeadline: null, subtotalMinor: 5000, zoneFeeMinor: 1000 });
    expect(r).toMatchObject({ customerFeeMinor: 1000, quote: null, notice: expect.stringMatching(/isn’t available in AE.*own drivers/) });
  });

  it('Deliverect: POS push on accept (once), sandbox when not live', async () => {
    const c = await call(app, 'POST', org('/partner-connections'), { token, body: { provider: 'deliverect', locationId: lon.id, settings: { clientId: 'dv_client_0001', clientSecret: 'dv_secret_0001', environment: 'staging', accountId: 'acc1', deliverectLocationId: 'dloc1', channelName: 'branchharbor', channelLinkId: 'cl_pos', posInjection: true, marketplaceOrders: true } } });
    expect(c.status).toBe(201);
    ids.dvConn = c.body.id;
    // Sandbox: accepted order is recorded, not sent.
    const date = addDays(localDateParts(new Date(), 'Europe/London').date, 1);
    await call(app, 'POST', org(`/foods/locations/${lon.id}/pickup-slots`), { token, body: { date, open: '12:00', close: '14:00', intervalMinutes: 15, capacity: 5, cutoffMinutes: 10 } });
    const slots = (await call(app, 'GET', `/v1/public/foods/${lon.id}/pickup-slots?from=${encodeURIComponent(zonedToUtc(date, '00:00', 'Europe/London').toISOString())}&to=${encodeURIComponent(zonedToUtc(addDays(date, 1), '00:00', 'Europe/London').toISOString())}`)).body.items;
    const place = async () => {
      const o = await call(app, 'POST', `/v1/public/foods/${lon.id}/checkout`, { body: { channel: 'pickup', pickupSlotId: slots[0].id, contact: { name: 'Sam Guest', email: `g-${uid()}@example.com` }, lines: [{ menuItemId: ids.bowl, quantity: 1 }] } });
      await pay(o.body.payment.id);
      return o.body.order.id as string;
    };
    const o1 = await place();
    await transition(o1, 'accepted');
    await drain();
    expect(callsTo('/branchharbor/order/')).toHaveLength(0);
    expect((await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.id, o1)))[0]!.fulfilment.pos).toMatchObject({ status: 'sandbox' });

    expect((await call(app, 'POST', org(`/partner-connections/${ids.dvConn}/test`), { token })).body.result.ok).toBe(true);
    expect((await call(app, 'PATCH', org(`/partner-connections/${ids.dvConn}`), { token, body: { mode: 'live' } })).body.status).toBe('live');
    const o2 = await place();
    await transition(o2, 'accepted');
    await drain();
    const pushes = callsTo('/branchharbor/order/cl_pos');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toMatchObject({ channelOrderId: o2, orderType: 1, items: [{ plu: `bh-${ids.bowl}`, price: 1200, quantity: 1 }], payment: { amount: 1200 } });
    expect((await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.id, o2)))[0]!.fulfilment.pos).toMatchObject({ status: 'sent' });
    await (await import('../src/services/foods-partners.ts')).onFoodOrderTransition(app.ctx, o2, 'accepted');
    expect(callsTo('/branchharbor/order/cl_pos')).toHaveLength(1);
  });

  it('Deliverect marketplace orders: HMAC, idempotent per channel order, attribution, status both ways, cancellation', async () => {
    const order = (over: Record<string, unknown> = {}) => ({
      _id: 'dlv_ord_1', account: 'acc1', location: 'dloc1', channelLink: 'cl_ue', channel: 7, channelOrderId: 'UE-998877', channelOrderDisplayId: '8877', status: 10, orderType: 2, decimalDigits: 2,
      items: [{ plu: `bh-${ids.bowl}`, name: 'Ember bowl', price: 1200, quantity: 2, subItems: [] }, { plu: 'POS-404', name: 'Mystery side', price: 300, quantity: 1, subItems: [] }],
      taxTotal: 0, deliveryCost: 199, bagFee: 20, tip: 0, driverTip: 150, discountTotal: -100, payment: { amount: 2819, type: 3, due: 0 }, orderIsAlreadyPaid: true,
      customer: { name: 'Alex M', phoneNumber: '+447700900000', email: 'relay@ubereats.example' }, deliveryAddress: { street: '1 Rivington St', postalCode: 'EC2A 3DT', city: 'London' },
      deliveryTime: new Date(Date.now() + 45 * 60_000).toISOString(), ...over,
    });
    const send = (p: Record<string, unknown>, secret = String(p.channelLink)) => {
      const raw = JSON.stringify(p);
      return app.inject({ method: 'POST', url: '/v1/webhooks/deliverect', headers: { 'content-type': 'application/json', 'x-server-authorization-hmac-sha256': hmacHex(secret, raw) }, payload: raw });
    };
    expect((await send(order(), 'not-the-secret')).statusCode).toBe(401);
    const r1 = await send(order());
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ outcome: 'processed' });
    const orderId = r1.json().orderId;
    // Same webhook again, and the same channel order under a new Deliverect id: one order only.
    expect((await send(order())).json()).toMatchObject({ duplicate: true });
    expect((await send(order({ _id: 'dlv_ord_retry' }))).json()).toMatchObject({ duplicate: true, orderId });
    const rows = (await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.locationId, lon.id))).filter((o) => o.fulfilment.marketplace);
    expect(rows).toHaveLength(1);
    const o = rows[0]!;
    expect(o).toMatchObject({
      status: 'awaiting_acceptance', channel: 'delivery', paymentStatus: 'paid', currency: 'GBP', subtotalMinor: 2700, deliveryFeeMinor: 199, serviceChargeMinor: 20, totalMinor: 2819,
      fulfilment: { marketplace: { via: 'deliverect', channel: 'uber_eats', channelName: 'Uber Eats', channelOrderId: 'UE-998877', courier: 'channel', discountMinor: 100, driverTipMinor: 150, unmatchedItems: ['Mystery side (POS-404)'] } },
    });
    expect(o.orderNumber).toMatch(/-UE8877$/);
    expect(o.contact).toEqual({ name: 'Alex M', phone: '+447700900000' }); // marketplace email not stored
    expect(o.lines[0]).toMatchObject({ menuItemId: ids.bowl, quantity: 2, lineTotalMinor: 2400 });
    // The marketplace's courier delivers: no own dispatch.
    expect((await transition(orderId, 'accepted')).status).toBe(200);
    await drain();
    expect(callsTo('/orderStatus/dlv_ord_1').map((c) => c.body.status)).toEqual([20]);
    expect((await call(app, 'POST', org(`/foods/orders/${orderId}/dispatch`), { token, body: { provider: 'uber_direct' } })).body.error.code).toBe('marketplace_courier');
    // Marketplace cancels → order cancelled, status 110 reported back.
    expect((await send(order({ status: 100 }))).json()).toMatchObject({ outcome: 'processed', detail: 'Order cancelled by the marketplace' });
    await drain();
    expect((await app.ctx.db.select().from(foodOrders).where(eq(foodOrders.id, orderId)))[0]!.status).toBe('cancelled');
    expect(callsTo('/orderStatus/dlv_ord_1').map((c) => c.body.status)).toEqual([20, 110]);
    // Echo of an order we injected ourselves is ignored.
    expect((await send(order({ _id: 'echo', channelLink: 'cl_pos', channelOrderId: 'own-1' }))).json()).toMatchObject({ outcome: 'ignored' });
  });

  it('Deliverect menu snapshot, push and busy mode', async () => {
    const snap = await call(app, 'GET', org(`/foods/locations/${lon.id}/deliverect/menu-snapshot`), { token });
    expect(snap.status).toBe(200);
    const salad = snap.body.products.find((p: any) => p.plu === `bh-${ids.salad}`);
    const bowl = snap.body.products.find((p: any) => p.plu === `bh-${ids.bowl}`);
    expect(salad).toMatchObject({ price: 900, productTags: [108] });
    expect(bowl).toMatchObject({ price: 1200 });
    await call(app, 'PUT', org(`/foods/locations/${lon.id}/overrides/${ids.bowl}`), { token, body: { soldOut: true } });
    const push = await call(app, 'POST', org(`/foods/locations/${lon.id}/deliverect/menu-push`), { token });
    expect(push.body).toMatchObject({ status: 'ok', products: 2 });
    expect(callsTo('/productAndCategories')[0]!.body).toMatchObject({ accountId: 'acc1', locationId: 'dloc1' });
    expect(callsTo('/locations/dloc1/snooze')[0]!.body.operations[0]).toMatchObject({ action: 'snooze', data: { plus: [`bh-${ids.bowl}`] } });
    const busy = await call(app, 'POST', org(`/foods/locations/${lon.id}/deliverect/busy`), { token, body: { paused: true, minutes: 30 } });
    expect(busy.body).toMatchObject({ status: 'ok', paused: true });
    expect(callsTo('/locations/dloc1/busyMode')[0]!.body).toMatchObject({ status: 'PAUSED', delay: 30 });
  });
});

describe.skipIf(!hasDb)('property portals (DB, mocked HTTP)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let london: any;
  let sydney: any;
  const agents: Record<string, string> = {};
  const R = (p: string) => `/v1/orgs/${orgId}/realty${p}`;
  const listing = async (locationId: string, over: Record<string, unknown>) => {
    const r = await call(app, 'POST', R('/listings'), { token, body: {
      locationId, transaction: 'sale', propertyType: 'house', title: `House ${uid()}`, priceMinor: 245_000_000, bedrooms: 3, bathrooms: 2, area: { value: 1640, unit: 'sqft' },
      description: 'Three-bedroom Victorian terraced house with a south-facing garden and original fireplaces.', photos: [{ url: 'https://images.example.com/1.jpg' }], leadAgentId: agents[locationId], ...over,
    } });
    if (r.status !== 201) throw new Error(`listing failed ${JSON.stringify(r.body)}`);
    const st = await call(app, 'POST', R(`/listings/${r.body.id}/status`), { token, body: { to: 'active' } });
    if (st.status !== 200) throw new Error(`activate failed ${JSON.stringify(st.body)}`);
    return r.body;
  };

  beforeAll(async () => {
    app = await makeApp({ partnerFetch: mock, rightmoveFetch: () => mock });
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'realty', country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London' })).id;
    london = await createLocation(app, token, orgId, { name: 'Hampstead', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '27 Heath Street', city: 'London', postalCode: 'NW3 6TR', country: 'GB' } });
    sydney = await createLocation(app, token, orgId, { name: 'Paddington', currency: 'AUD', timeZone: 'Australia/Sydney', address: { line1: '312 Oxford St', city: 'Paddington', region: 'NSW', postalCode: '2021', country: 'AU' } });
    for (const l of [london, sydney]) agents[l.id] = (await call(app, 'POST', R('/agents'), { token, body: { locationId: l.id, name: 'James Okafor', email: 'james@example.com', availability: [] } })).body.id;
  });
  afterAll(async () => { await app?.close(); });

  it('Rightmove: validation errors, per-office status, live push and removal on withdraw', async () => {
    const l = await listing(london.id, { address: { line1: '14 Flask Walk', city: 'London', postalCode: 'NW3 1HE' } });
    const opt = await call(app, 'PUT', R(`/listings/${l.id}/syndication/rightmove`), { token, body: { optedIn: true } });
    expect(opt.body).toMatchObject({ optedIn: true, officeStatus: 'not_configured', live: false });
    expect(opt.body.issues).toEqual(expect.arrayContaining(['Tenure is required (material information supplied by the business)', 'Council tax band is required (material information supplied by the business)']));
    const issues = await call(app, 'GET', R('/syndication/listings'), { token });
    expect(issues.body.items.find((x: any) => x.listingId === l.id)).toMatchObject({ portal: 'rightmove', lastStatus: 'invalid', issues: expect.arrayContaining([expect.stringMatching(/Council tax band/)]) });
    // Sandbox export: nothing transmitted, invalid recorded.
    let exp = await call(app, 'POST', R('/syndication/rightmove/export'), { token, body: {} });
    expect(exp.body).toMatchObject({ transmitted: false, results: [{ listingId: l.id, status: 'invalid' }] });
    expect((await call(app, 'PUT', R(`/listings/${l.id}/portal-fields`), { token, body: { tenure: 'freehold', councilTaxBand: 'H', priceQualifier: 'guide_price' } })).status).toBe(200);
    exp = await call(app, 'POST', R('/syndication/rightmove/export'), { token, body: {} });
    expect(exp.body.results[0]).toMatchObject({ status: 'sandbox_exported' });
    expect(callsTo('sendpropertydetails')).toHaveLength(0);

    const conn = await call(app, 'POST', `/v1/orgs/${orgId}/partner-connections`, { token, body: { provider: 'rightmove', locationId: london.id, settings: { networkId: '1234', branchId: '5678', baseUrl: 'https://adfapi.test.example', certificatePfxBase64: Buffer.from('fake-pfx').toString('base64'), certificatePassword: 'pw' } } });
    expect(conn.status).toBe(201);
    let portals = await call(app, 'GET', R('/syndication/portals'), { token });
    expect(portals.body.items.find((p: any) => p.id === 'rightmove').offices[0]).toMatchObject({ status: 'sandbox' });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/partner-connections/${conn.body.id}/test`, { token })).body.result.ok).toBe(true);
    expect(callsTo('getbranchpropertylist')[0]!.body).toEqual({ network: { network_id: 1234 }, branch: { branch_id: 5678 } });
    await call(app, 'PATCH', `/v1/orgs/${orgId}/partner-connections/${conn.body.id}`, { token, body: { mode: 'live' } });
    exp = await call(app, 'POST', R('/syndication/rightmove/export'), { token, body: {} });
    expect(exp.body).toMatchObject({ transmitted: true, live: true, results: [{ status: 'published', message: 'https://www.rightmove.co.uk/properties/99887766' }] });
    const sent = callsTo('sendpropertydetails')[0]!;
    expect(sent.url).toBe('https://adfapi.test.example/v1/property/sendpropertydetails');
    expect(sent.body).toMatchObject({ network: { network_id: 1234 }, branch: { branch_id: 5678, channel: 1 }, property: { agent_ref: l.reference, price_information: { price: 2450000, price_qualifier: 2, tenure_type: 1 }, details: { council_tax_band: 'H' }, address: { postcode_1: 'NW3', postcode_2: '1HE' } } });
    portals = await call(app, 'GET', R('/syndication/portals'), { token });
    const rm = portals.body.items.find((p: any) => p.id === 'rightmove');
    expect(rm).toMatchObject({ live: true, offices: [{ status: 'live', lastPush: { action: 'send_property', status: 'ok' } }] });
    expect(portals.body.items.find((p: any) => p.id === 'idealista')).toMatchObject({ live: false });

    // Withdraw → removed from Rightmove (background job).
    expect((await call(app, 'POST', R(`/listings/${l.id}/status`), { token, body: { to: 'withdrawn' } })).status).toBe(200);
    await app.ctx.jobs.drain();
    expect(callsTo('removeproperty')[0]!.body).toEqual({ network: { network_id: 1234 }, branch: { branch_id: 5678, channel: 1 }, property: { agent_ref: l.reference } });
    const [row] = await app.ctx.db.select().from(realtySyndication).where(eq(realtySyndication.listingId, l.id));
    expect(row!.lastStatus).toBe('removed');
  });

  it('REAXML hosted feed: signed per-office URL, sold listings carried as removals, rotation', async () => {
    const ok = await listing(sydney.id, { title: 'Paddington terrace with courtyard', propertyType: 'townhouse', address: { line1: '21 Glenmore Rd', city: 'Paddington', region: 'NSW', postalCode: '2021' }, area: { value: 118, unit: 'sqm' } });
    const sold = await listing(sydney.id, { title: 'Woollahra family home', address: { line1: '8 Queen St', city: 'Woollahra', region: 'NSW', postalCode: '2025' }, area: { value: 265, unit: 'sqm' } });
    for (const l of [ok, sold]) await call(app, 'PUT', R(`/listings/${l.id}/syndication/reaxml`), { token, body: { optedIn: true } });
    await call(app, 'POST', R(`/listings/${sold.id}/status`), { token, body: { to: 'under_offer' } });
    await call(app, 'POST', R(`/listings/${sold.id}/status`), { token, body: { to: 'sold', closedPriceMinor: 4_250_000_00 } });
    await app.ctx.jobs.drain();
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/partner-connections`, { token, body: { provider: 'reaxml', locationId: sydney.id, settings: { agentId: 'AGENCY1' } } });
    expect(c.status).toBe(201);
    const url: string = c.body.feedUrl;
    expect(url).toMatch(/\/v1\/feeds\/realty\/[0-9a-f-]{36}\/[\w-]{32}\.xml$/);
    const path = new URL(url).pathname;
    expect((await app.inject({ method: 'GET', url: path.replace(/\/[\w-]{32}\.xml$/, '/wrongtokenwrongtokenwrongtoken12.xml') })).statusCode).toBe(404);
    const feed = await app.inject({ method: 'GET', url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers['content-type']).toMatch(/application\/xml/);
    expect(feed.body).toContain('SANDBOX PREVIEW');
    expect(feed.body).toContain(`<uniqueID>${ok.reference}</uniqueID>`);
    expect(feed.body).toMatch(new RegExp(`status="sold"><agentID>AGENCY1</agentID><uniqueID>${sold.reference}</uniqueID>`));
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/partner-connections?industry=realty`, { token });
    expect(list.body.items.find((x: any) => x.id === c.body.id).lastFetchedAt).toBeTruthy();
    const rotated = await call(app, 'POST', `/v1/orgs/${orgId}/partner-connections/${c.body.id}/rotate-feed-token`, { token });
    expect(rotated.body.feedUrl).not.toBe(url);
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });
});
