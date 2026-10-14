import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { locationVariants, orders, stockMovements } from '../src/db/schema/index.ts';
import { guardClaims } from '../src/services/commerce-insights.ts';
import { computeTax } from '../src/services/commerce-orders.ts';
import { validateVariantMatrix } from '../src/services/commerce-catalogue.ts';
import type { AiProvider } from '../src/integrations/ai.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

describe('commerce pure rules', () => {
  it('computes only configured taxes: exclusive added, inclusive extracted, none assumed', () => {
    expect(computeTax([], 10000, 500)).toEqual({ lines: [], addedMinor: 0 });
    const qc = computeTax([{ name: 'GST', rateBps: 500, inclusive: false, appliesToFulfilment: true }, { name: 'QST', rateBps: 998, inclusive: false, appliesToFulfilment: true }], 10000, 0);
    expect(qc.lines.map((l) => l.amountMinor)).toEqual([500, 998]);
    expect(qc.addedMinor).toBe(1498);
    const nl = computeTax([{ name: 'BTW', rateBps: 2100, inclusive: true, appliesToFulfilment: true }], 12100, 0);
    expect(nl).toEqual({ lines: [{ name: 'BTW', rateBps: 2100, inclusive: true, amountMinor: 2100 }], addedMinor: 0 });
  });

  it('rejects variant mismatches in the option matrix', () => {
    const options = [{ name: 'Size', values: ['A5', 'Pocket'] }];
    expect(() => validateVariantMatrix(options, [{ sku: 'A', options: { Size: 'A5' } }, { sku: 'B', options: { Size: 'A5' } }])).toThrow(/variant options/);
    expect(() => validateVariantMatrix(options, [{ sku: 'A', options: { Size: 'A4' } }])).toThrow();
    expect(() => validateVariantMatrix(options, [{ sku: 'A', options: { Colour: 'Red' } }])).toThrow();
    expect(() => validateVariantMatrix(options, [{ sku: 'A', options: { Size: 'A5' } }, { sku: 'B', options: { Size: 'Pocket' } }])).not.toThrow();
  });

  it('removes copy claims that the supplied specifications do not support', () => {
    const r = guardClaims('Lay-flat binding for sketching. Compatible with every fountain pen. Made from recycled paper. Ships tomorrow.', { Binding: 'Lay-flat', Paper: '100% recycled, 90 gsm' });
    expect(r.text).toBe('Lay-flat binding for sketching. Made from recycled paper.');
    expect(r.removed.map((x) => x.term)).toEqual(['compatib', 'ships']);
  });
});

describe.skipIf(!hasDb)('commerce full product (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let manager: { token: string; userId: string };
  let staff: { token: string; userId: string };
  let destStaff: { token: string; userId: string };
  let orgId: string;
  let pdx: any; let sea: any; let yul: any;
  let productId: string;
  let dot: string; let ruled: string; let pocket: string;

  const org = (path: string) => `/v1/orgs/${orgId}/commerce${path}`;
  const receive = (locationId: string, variantId: string, quantity: number) => call(app, 'POST', org('/stock-movements'), { token: owner.token, body: { locationId, variantId, quantity, reason: 'received', note: 'PO test' } });
  const lv = async (locationId: string, variantId: string) => (await app.ctx.db.select().from(locationVariants).where(and(eq(locationVariants.locationId, locationId), eq(locationVariants.variantId, variantId))))[0]!;
  const checkout = (locationId: string, lines: Array<{ variantId: string; quantity: number }>, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call(app, 'POST', `/v1/public/commerce/locations/${locationId}/checkout`, { body: { lines, fulfilment: { method: 'pickup' }, contact: { name: 'Jamie Buyer', email: `jamie-${uid()}@example.com` }, ...extra }, headers });
  const pay = (paymentId: string) => call(app, 'POST', `/v1/public/payments/${paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
  const ledgerSum = async (locationId: string, variantId: string) => (await app.ctx.db.select({ q: sql<number>`coalesce(sum(${stockMovements.quantity}),0)::int` }).from(stockMovements)
    .where(and(eq(stockMovements.locationId, locationId), eq(stockMovements.variantId, variantId), sql`${stockMovements.reason} not in ('reservation','release')`)))[0]!.q;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Olivia Owner');
    orgId = (await createOrg(app, owner.token, { industry: 'commerce', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    const us = { region: 'OR', country: 'US' };
    pdx = await createLocation(app, owner.token, orgId, { name: 'Portland', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '1 Burnside', city: 'Portland', postalCode: '97209', ...us } });
    sea = await createLocation(app, owner.token, orgId, { name: 'Seattle', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '2 Pike', city: 'Seattle', postalCode: '98101', region: 'WA', country: 'US' } });
    yul = await createLocation(app, owner.token, orgId, { name: 'Montréal', currency: 'CAD', timeZone: 'America/Toronto', address: { line1: '5 St-Laurent', city: 'Montréal', region: 'QC', postalCode: 'H2T 1S5', country: 'CA' } });
    for (const l of [pdx, sea, yul]) await enablePublicAndPayments(app, owner.token, orgId, l.id);
    manager = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: pdx.id }, 'Mia Manager');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: pdx.id }, 'Sam Staff');
    destStaff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: sea.id }, 'Dee Seattle');
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { refundApprovalThresholds: { USD: 3000 } } })).status).toBe(200);

    const p = await call(app, 'POST', org('/catalogue'), {
      token: owner.token,
      body: {
        sku: 'NB', name: 'Field notebook', description: 'Lay-flat notebook.', status: 'active', slug: 'field-notebook', options: [{ name: 'Ruling', values: ['Dot', 'Ruled', 'Blank'] }],
        specs: { Paper: '90 gsm, recycled' }, priceBounds: { USD: { minPct: -10, maxPct: 10 } },
        variants: [
          { sku: 'NB-DOT', name: 'Dot', options: { Ruling: 'Dot' }, prices: { USD: 2000, CAD: 2600 } },
          { sku: 'NB-RUL', name: 'Ruled', options: { Ruling: 'Ruled' }, prices: { USD: 2000, CAD: 2600 } },
          { sku: 'NB-BLK', name: 'Blank', options: { Ruling: 'Blank' }, prices: { USD: 1500, CAD: 1900 } },
        ],
      },
    });
    expect(p.status).toBe(201);
    productId = p.body.id;
    [dot, ruled, pocket] = p.body.variants.map((v: any) => v.id);
    const d = await call(app, 'POST', org('/distributions'), { token: owner.token, body: { productIds: [productId], locationIds: [pdx.id, sea.id, yul.id] } });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: 'completed', summary: { synced: 3, failed: 0 } });
    // Seattle accepts collection of orders placed at Portland (same currency).
    const settings = { storefrontEnabled: true, pickupEnabled: true, pickupInstructions: 'Counter at the back', pickupReadyMinutes: 60, localDeliveryEnabled: false, deliveryFeeMinor: 0, freeDeliveryOverMinor: null, deliveryPostcodes: [], shippingEnabled: true, shippingFeeMinor: 800, shippingCountries: ['US'], crossLocationPickup: true, reservationMinutes: 15, returnWindowDays: 30 };
    for (const l of [pdx, sea]) expect((await call(app, 'PUT', org(`/locations/${l.id}/fulfilment-settings`), { token: owner.token, body: settings })).status).toBe(200);
  });
  afterAll(async () => { await app?.close(); });

  it('only lists distributed content; HQ edits show as pending until redistributed; master SKUs are locked', async () => {
    const list = await call(app, 'GET', `/v1/public/commerce/${(await call(app, 'GET', `/v1/orgs/${orgId}`, { token: owner.token })).body.slug}/${pdx.slug}/products`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const detail = (await call(app, 'GET', org(`/catalogue/${productId}`), { token: owner.token })).body;
    const body = { ...detail, description: 'Lay-flat notebook with numbered pages.', variants: detail.variants.map((v: any) => ({ id: v.id, sku: v.sku, name: v.name, options: v.options, prices: v.prices })), images: [], eligibility: detail.eligibility, priceBounds: detail.priceBounds };
    for (const k of ['id', 'organizationId', 'createdAt', 'updatedAt', 'listings', 'translations', 'variantTranslations', 'collectionIds', 'lockedFields', 'contentVersion', 'updatedBy']) delete body[k];
    const upd = await call(app, 'PUT', org(`/catalogue/${productId}`), { token: owner.token, body });
    expect(upd.status).toBe(200);
    expect(upd.body.listings.every((l: any) => !l.upToDate && l.pendingChanges.includes('Description updated'))).toBe(true);
    const slugRes = await call(app, 'GET', `/v1/orgs/${orgId}`, { token: owner.token });
    const store = await call(app, 'GET', `/v1/public/commerce/${slugRes.body.slug}/${pdx.slug}/products/field-notebook`);
    expect(store.body.description).toBe('Lay-flat notebook.');
    const locked = await call(app, 'PUT', org(`/catalogue/${productId}`), { token: owner.token, body: { ...body, variants: body.variants.map((v: any, i: number) => (i === 0 ? { ...v, sku: 'NB-DOT-2' } : v)) } });
    expect(locked.body.error.code).toBe('identifier_locked');
    expect((await call(app, 'PUT', org(`/catalogue/${productId}`), { token: manager.token, body })).status).toBe(403);
    const preview = await call(app, 'POST', org('/distributions/preview'), { token: owner.token, body: { productIds: [productId], locationIds: [pdx.id] } });
    expect(preview.body.items[0]).toMatchObject({ action: 'update', status: 'ready' });
    await call(app, 'POST', org('/distributions'), { token: owner.token, body: { productIds: [productId], locationIds: [pdx.id, sea.id, yul.id] } });
    expect((await call(app, 'GET', `/v1/public/commerce/${slugRes.body.slug}/${pdx.slug}/products/field-notebook`)).body.description).toBe('Lay-flat notebook with numbered pages.');
  });

  it('local price overrides stay within HQ bounds per currency; origin shown; reset to HQ', async () => {
    const put = (token: string, body: Record<string, unknown>, loc = pdx.id) => call(app, 'PUT', org(`/locations/${loc}/assortment/${dot}`), { token, body });
    expect((await put(staff.token, { priceMinor: 2100 })).status).toBe(403); // associates cannot set prices
    expect((await put(staff.token, { available: true })).status).toBe(200);
    const high = await put(manager.token, { priceMinor: 2300 });
    expect(high.status).toBe(409);
    expect(high.body.error).toMatchObject({ code: 'price_out_of_bounds', details: { minMinor: 1800, maxMinor: 2200, currency: 'USD' } });
    const ok = await put(manager.token, { priceMinor: 2150 });
    expect(ok.body).toMatchObject({ priceOrigin: 'local', localPrice: { amount: 2150, currency: 'USD' }, hqPrice: { amount: 2000 }, priceSetBy: 'Mia Manager' });
    // No CAD range configured → the HQ price is locked in Montréal.
    expect((await put(owner.token, { priceMinor: 2500 }, yul.id)).body.error.code).toBe('price_locked');
    // The legacy endpoint enforces the same bounds.
    expect((await call(app, 'PUT', org(`/locations/${pdx.id}/variants/${dot}`), { token: owner.token, body: { priceMinor: 9999 } })).body.error.code).toBe('price_out_of_bounds');
    // HQ tightens the range: the preview flags the override and distribution resets it.
    const detail = (await call(app, 'GET', org(`/catalogue/${productId}`), { token: owner.token })).body;
    const body = { sku: detail.sku, name: detail.name, description: detail.description, slug: detail.slug, status: 'active', options: detail.options, specs: detail.specs, eligibility: detail.eligibility, priceBounds: { USD: { minPct: -5, maxPct: 5 } }, variants: detail.variants.map((v: any) => ({ id: v.id, sku: v.sku, name: v.name, options: v.options, prices: v.prices })) };
    expect((await call(app, 'PUT', org(`/catalogue/${productId}`), { token: owner.token, body })).status).toBe(200);
    const pv = await call(app, 'POST', org('/distributions/preview'), { token: owner.token, body: { productIds: [productId], locationIds: [pdx.id] } });
    expect(pv.body.items[0].overridesOutOfBounds).toEqual([expect.objectContaining({ variantId: dot, priceMinor: 2150, minMinor: 1900, maxMinor: 2100 })]);
    await call(app, 'POST', org('/distributions'), { token: owner.token, body: { productIds: [productId], locationIds: [pdx.id] } });
    expect((await lv(pdx.id, dot)).priceMinor).toBeNull();
    expect((await put(manager.token, { priceMinor: 2050 })).body.priceOrigin).toBe('local');
    const reset = await call(app, 'POST', org(`/locations/${pdx.id}/assortment/reset`), { token: manager.token, body: {} });
    expect(reset.body.reset).toBeGreaterThan(0);
    expect((await lv(pdx.id, dot)).priceMinor).toBeNull();
  });

  it('concurrent checkouts for the last unit: exactly one reserves it', async () => {
    await receive(sea.id, ruled, 1);
    const [a, b] = await Promise.all([checkout(sea.id, [{ variantId: ruled, quantity: 1 }]), checkout(sea.id, [{ variantId: ruled, quantity: 1 }])]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('out_of_stock');
    expect(await lv(sea.id, ruled)).toMatchObject({ stockOnHand: 1, reserved: 1 });
    const winner = a.status === 201 ? a : b;
    expect((await pay(winner.body.payment.id)).status).toBe(200);
    expect(await lv(sea.id, ruled)).toMatchObject({ stockOnHand: 0, reserved: 0 });
    // Retrying the same checkout with the same Idempotency-Key never creates a second order.
    await receive(sea.id, ruled, 2);
    const key = `idem-${uid()}`;
    const first = await checkout(sea.id, [{ variantId: ruled, quantity: 1 }], {}, { 'idempotency-key': key });
    const again = await checkout(sea.id, [{ variantId: ruled, quantity: 1 }], {}, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, order: { id: first.body.order.id } });
    expect((await lv(sea.id, ruled)).reserved).toBe(1);
  });

  it('payment after the reservation expired: re-allocates when stock is free, otherwise needs recovery (no oversell)', async () => {
    await receive(pdx.id, pocket, 2);
    // A: expires, stock still free → paid late and re-allocated.
    const a = await checkout(pdx.id, [{ variantId: pocket, quantity: 1 }]);
    expect(a.status).toBe(201);
    expect(a.body.order.reservationExpiresAt).toBeTruthy();
    await app.ctx.db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, a.body.order.id));
    expect((await call(app, 'POST', org('/reservations/expire'), { token: owner.token })).body.expired).toBe(1);
    expect(await lv(pdx.id, pocket)).toMatchObject({ stockOnHand: 2, reserved: 0 });
    await pay(a.body.payment.id);
    let o = (await call(app, 'GET', org(`/sales-orders/${a.body.order.id}`), { token: owner.token })).body;
    expect(o).toMatchObject({ status: 'paid', paymentStatus: 'paid', fulfilmentStatus: 'unfulfilled', attention: null });
    expect(o.history.at(-1).note).toMatch(/re-allocated/);
    expect(await lv(pdx.id, pocket)).toMatchObject({ stockOnHand: 1, reserved: 0 });

    // B: expires, then someone else buys the last unit; B's late payment cannot oversell.
    const b = await checkout(pdx.id, [{ variantId: pocket, quantity: 1 }]);
    await app.ctx.db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, b.body.order.id));
    await call(app, 'POST', org('/reservations/expire'), { token: owner.token });
    const c = await checkout(pdx.id, [{ variantId: pocket, quantity: 1 }]);
    await pay(c.body.payment.id);
    expect(await lv(pdx.id, pocket)).toMatchObject({ stockOnHand: 0, reserved: 0 });
    const late = await pay(b.body.payment.id);
    expect(late.body.payment.state).toBe('succeeded');
    o = (await call(app, 'GET', org(`/sales-orders/${b.body.order.id}`), { token: owner.token })).body;
    expect(o).toMatchObject({ paymentStatus: 'paid', fulfilmentStatus: 'stock_conflict', attention: 'paid_after_expiry_no_stock' });
    expect(await lv(pdx.id, pocket)).toMatchObject({ stockOnHand: 0, reserved: 0 });
    const recon = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token: owner.token });
    expect(recon.body.items.some((i: any) => i.kind === 'paid_without_record' && i.targetId === b.body.order.id)).toBe(true);
    // Recovery: transfer a unit from Seattle for collection.
    await receive(sea.id, pocket, 3);
    expect((await call(app, 'POST', org(`/sales-orders/${b.body.order.id}/recover`), { token: staff.token, body: { kind: 'backorder' } })).status).toBe(403);
    const rec = await call(app, 'POST', org(`/sales-orders/${b.body.order.id}/recover`), { token: owner.token, body: { kind: 'transfer_from', fromLocationId: sea.id } });
    expect(rec.body).toMatchObject({ fulfilmentStatus: 'awaiting_transfer', attention: null, transfer: { status: 'approved' } });
    expect(await lv(sea.id, pocket)).toMatchObject({ stockOnHand: 3, reserved: 1 });
    const recon2 = await call(app, 'GET', `/v1/orgs/${orgId}/payments/reconciliation`, { token: owner.token });
    expect(recon2.body.items.some((i: any) => i.targetId === b.body.order.id)).toBe(false);
  });

  it('transfer stock math: request → approve → ship (in transit) → receive with a shortfall', async () => {
    await receive(pdx.id, dot, 20);
    const before = { pdx: (await lv(pdx.id, dot)).stockOnHand, sea: (await lv(sea.id, dot)).stockOnHand };
    const t = await call(app, 'POST', org('/transfers'), { token: destStaff.token, body: { fromLocationId: pdx.id, toLocationId: sea.id, lines: [{ variantId: dot, quantity: 6 }], reason: 'Weekend demand' } });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'requested', number: expect.stringMatching(/^TR-/) });
    expect((await call(app, 'POST', org(`/transfers/${t.body.id}/ship`), { token: staff.token, body: {} })).body.error.code).toBe('invalid_transition');
    expect((await call(app, 'POST', org(`/transfers/${t.body.id}/decision`), { token: staff.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', org(`/transfers/${t.body.id}/decision`), { token: manager.token, body: { decision: 'approve' } })).body.status).toBe('approved');
    const shipped = await call(app, 'POST', org(`/transfers/${t.body.id}/ship`), { token: staff.token, body: { lines: [{ variantId: dot, quantity: 5 }], carrier: 'Courier', trackingNumber: 'TRK1' } });
    expect(shipped.body).toMatchObject({ status: 'in_transit', totals: { requested: 6, shipped: 5, inTransit: 5 } });
    expect((await lv(pdx.id, dot)).stockOnHand).toBe(before.pdx - 5);
    expect((await lv(sea.id, dot)).stockOnHand).toBe(before.sea);
    const asst = await call(app, 'GET', org(`/locations/${sea.id}/assortment`), { token: destStaff.token });
    expect(asst.body.items[0].variants.find((v: any) => v.variantId === dot).inTransit).toBe(5);
    expect((await call(app, 'POST', org(`/transfers/${t.body.id}/receive`), { token: staff.token, body: {} })).status).toBe(403);
    const rec = await call(app, 'POST', org(`/transfers/${t.body.id}/receive`), { token: destStaff.token, body: { lines: [{ variantId: dot, quantity: 4 }] } });
    expect(rec.body).toMatchObject({ status: 'received', totals: { shipped: 5, received: 4, inTransit: 0 } });
    expect(rec.body.receiveNote).toMatch(/1 unit\(s\) missing/);
    expect((await lv(sea.id, dot)).stockOnHand).toBe(before.sea + 4);
    // The cached numbers always equal the ledger.
    for (const l of [pdx.id, sea.id]) expect(await ledgerSum(l, dot)).toBe((await lv(l, dot)).stockOnHand);
    const rep = await call(app, 'GET', org('/reports'), { token: owner.token });
    expect(rep.body.inventoryDrift.find((d: any) => d.locationId === sea.id).transitLossUnits).toBe(1);
  });

  it('cross-store collection: order at Portland, collect at Seattle via an automatic transfer', async () => {
    const before = { pdx: await lv(pdx.id, dot), sea: await lv(sea.id, dot) };
    const q = await call(app, 'POST', `/v1/public/commerce/locations/${pdx.id}/quote`, { body: { lines: [{ variantId: dot, quantity: 2 }], fulfilment: { method: 'pickup', collectLocationId: sea.id } } });
    expect(q.body).toMatchObject({ ok: true, fulfilment: { transfer: true, collectLocation: { id: sea.id } } });
    const co = await checkout(pdx.id, [{ variantId: dot, quantity: 2 }], { fulfilment: { method: 'pickup', collectLocationId: sea.id } });
    expect(co.status).toBe(201);
    await pay(co.body.payment.id);
    let o = (await call(app, 'GET', org(`/sales-orders/${co.body.order.id}`), { token: destStaff.token })).body;
    expect(o).toMatchObject({ fulfilmentStatus: 'awaiting_transfer', crossLocation: true, fulfilmentLocationId: sea.id });
    expect((await call(app, 'POST', org(`/sales-orders/${o.id}/fulfilments`), { token: destStaff.token, body: {} })).body.error.code).toBe('awaiting_transfer');
    expect(await lv(pdx.id, dot)).toMatchObject({ stockOnHand: before.pdx.stockOnHand, reserved: before.pdx.reserved + 2 });
    await call(app, 'POST', org(`/transfers/${o.transfer.id}/ship`), { token: staff.token, body: {} });
    await call(app, 'POST', org(`/transfers/${o.transfer.id}/receive`), { token: destStaff.token, body: {} });
    expect(await lv(pdx.id, dot)).toMatchObject({ stockOnHand: before.pdx.stockOnHand - 2, reserved: before.pdx.reserved });
    expect(await lv(sea.id, dot)).toMatchObject({ stockOnHand: before.sea.stockOnHand + 2, reserved: before.sea.reserved + 2 });
    // Pick, pack, ready, collected at Seattle.
    const f = await call(app, 'POST', org(`/sales-orders/${o.id}/fulfilments`), { token: destStaff.token, body: {} });
    expect(f.status).toBe(201);
    const fid = f.body.fulfilment.id;
    expect((await call(app, 'POST', org(`/fulfilments/${fid}/status`), { token: destStaff.token, body: { to: 'packed' } })).body.error.code).toBe('not_fully_picked');
    await call(app, 'POST', org(`/fulfilments/${fid}/pick`), { token: destStaff.token, body: { lines: [{ variantId: dot, picked: 2 }] } });
    await call(app, 'POST', org(`/fulfilments/${fid}/status`), { token: destStaff.token, body: { to: 'packed' } });
    const ready = await call(app, 'POST', org(`/fulfilments/${fid}/status`), { token: destStaff.token, body: { to: 'ready' } });
    expect(ready.body.order.fulfilmentStatus).toBe('ready_for_pickup');
    const done = await call(app, 'POST', org(`/fulfilments/${fid}/status`), { token: destStaff.token, body: { to: 'collected' } });
    expect(done.body.order).toMatchObject({ fulfilmentStatus: 'fulfilled', status: 'fulfilled' });
    expect(await lv(sea.id, dot)).toMatchObject({ stockOnHand: before.sea.stockOnHand, reserved: before.sea.reserved });
    o = (await call(app, 'GET', `/v1/public/commerce/orders/${co.body.order.id}?token=${co.body.manageToken}`)).body;
    expect(o).toMatchObject({ fulfilmentStatus: 'fulfilled', store: { name: 'Seattle' }, returnPolicy: { open: true } });
  });

  it('returns: customer request in the window → review → authorise → receive (restock + write-off) → refund; over the threshold goes to approvals', async () => {
    await receive(pdx.id, ruled, 10);
    const co = await checkout(pdx.id, [{ variantId: ruled, quantity: 3 }]);
    await pay(co.body.payment.id);
    const onHandAfterSale = (await lv(pdx.id, ruled)).stockOnHand;
    const tok = co.body.manageToken;
    expect((await call(app, 'POST', `/v1/public/commerce/orders/${co.body.order.id}/returns?token=${tok}`, { body: { lines: [{ variantId: ruled, quantity: 4 }] } })).status).toBe(400);
    const req = await call(app, 'POST', `/v1/public/commerce/orders/${co.body.order.id}/returns?token=${tok}`, { body: { lines: [{ variantId: ruled, quantity: 2, reason: 'Changed my mind' }] } });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'requested', requestedVia: 'customer', rmaNumber: expect.stringMatching(/^RMA-/) });
    const rid = req.body.id;
    expect((await call(app, 'POST', org(`/returns/${rid}/receive`), { token: staff.token, body: { lines: [{ variantId: ruled, receivedQty: 2, disposition: 'restock' }] } })).body.error.code).toBe('invalid_transition');
    await call(app, 'POST', org(`/returns/${rid}/review`), { token: staff.token, body: {} });
    expect((await call(app, 'POST', org(`/returns/${rid}/authorise`), { token: staff.token, body: {} })).status).toBe(403);
    await call(app, 'POST', org(`/returns/${rid}/authorise`), { token: manager.token, body: {} });
    const recv = await call(app, 'POST', org(`/returns/${rid}/receive`), { token: staff.token, body: { lines: [{ variantId: ruled, receivedQty: 2, disposition: 'restock' }] } });
    expect(recv.body).toMatchObject({ status: 'received', value: { amount: 4000, currency: 'USD' } });
    expect((await lv(pdx.id, ruled)).stockOnHand).toBe(onHandAfterSale + 2);
    // 40.00 USD is above the 30.00 threshold and the manager cannot refund: approval request.
    const res = await call(app, 'POST', org(`/returns/${rid}/resolve`), { token: manager.token, body: { resolution: 'refund' } });
    expect(res.body).toMatchObject({ outcome: 'approval_requested', return: { status: 'refund_pending_approval' } });
    const ap = await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${res.body.approval.id}/decision`, { token: owner.token, body: { decision: 'approve' } });
    expect(ap.body.status).toBe('approved');
    const after = await call(app, 'GET', org(`/returns/${rid}`), { token: manager.token });
    expect(after.body).toMatchObject({ status: 'resolved', resolution: 'refund', refundAmount: { amount: 4000, currency: 'USD' } });
    const ord = (await call(app, 'GET', org(`/sales-orders/${co.body.order.id}`), { token: owner.token })).body;
    expect(ord).toMatchObject({ refunded: { amount: 4000 }, paymentStatus: 'partially_refunded' });

    // Second return of the last unit: written off and resolved with store credit (balance in USD).
    const r2 = await call(app, 'POST', org(`/sales-orders/${co.body.order.id}/returns`), { token: staff.token, body: { lines: [{ variantId: ruled, quantity: 1 }] } });
    await call(app, 'POST', org(`/returns/${r2.body.id}/review`), { token: staff.token, body: {} });
    await call(app, 'POST', org(`/returns/${r2.body.id}/authorise`), { token: manager.token, body: {} });
    const before = (await lv(pdx.id, ruled)).stockOnHand;
    await call(app, 'POST', org(`/returns/${r2.body.id}/receive`), { token: staff.token, body: { lines: [{ variantId: ruled, receivedQty: 1, disposition: 'write_off' }] } });
    expect((await lv(pdx.id, ruled)).stockOnHand).toBe(before);
    const credit = await call(app, 'POST', org(`/returns/${r2.body.id}/resolve`), { token: manager.token, body: { resolution: 'store_credit' } });
    expect(credit.body).toMatchObject({ outcome: 'store_credit', giftCardCode: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/) });
    const bal = await call(app, 'POST', '/v1/public/commerce/gift-cards/balance', { body: { brandSlug: (await call(app, 'GET', `/v1/orgs/${orgId}`, { token: owner.token })).body.slug, code: credit.body.giftCardCode } });
    expect(bal.body).toMatchObject({ kind: 'store_credit', balance: { amount: 2000, currency: 'USD' } });
    // Store credit pays for a new order; the CAD store refuses a USD balance.
    const q = await call(app, 'POST', `/v1/public/commerce/locations/${yul.id}/quote`, { body: { lines: [{ variantId: ruled, quantity: 1 }], fulfilment: { method: 'pickup' }, giftCardCode: credit.body.giftCardCode } });
    expect(q.body.issues.find((i: any) => i.field === 'giftCardCode').message).toMatch(/USD/);
    const paidByCredit = await checkout(pdx.id, [{ variantId: dot, quantity: 1 }], { giftCardCode: credit.body.giftCardCode });
    expect(paidByCredit.status).toBe(201);
    expect(paidByCredit.body).toMatchObject({ payment: null, order: { paymentStatus: 'paid', creditApplied: { amount: 2000, currency: 'USD' } } });
  });

  it('a closed return window is enforced for customers', async () => {
    const co = await checkout(pdx.id, [{ variantId: dot, quantity: 1 }]);
    await pay(co.body.payment.id);
    await app.ctx.db.update(orders).set({ paidAt: new Date(Date.now() - 40 * 86400_000) }).where(eq(orders.id, co.body.order.id));
    const r = await call(app, 'POST', `/v1/public/commerce/orders/${co.body.order.id}/returns?token=${co.body.manageToken}`, { body: { lines: [{ variantId: dot, quantity: 1 }] } });
    expect(r.body.error.code).toBe('return_window_closed');
  });

  it('WooCommerce stays authoritative: orders sync idempotently (pull + signed webhooks) and native checkout is refused', async () => {
    const wooLoc = await createLocation(app, owner.token, orgId, { name: 'Woo Store', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '9 Main', city: 'Bend', region: 'OR', postalCode: '97701', country: 'US' } });
    await enablePublicAndPayments(app, owner.token, orgId, wooLoc.id);
    await call(app, 'POST', org('/distributions'), { token: owner.token, body: { productIds: [productId], locationIds: [wooLoc.id] } });
    await receive(wooLoc.id, dot, 10);
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/connections`, { token: owner.token, body: { provider: 'woocommerce', locationId: wooLoc.id, direction: 'import', authoritative: 'external', config: { siteUrl: 'https://shop.example.com' }, credentials: { webhookSecret: 'woo-secret' } } });
    expect(c.status).toBe(201);
    await call(app, 'POST', `/v1/orgs/${orgId}/connections/${c.body.id}/test`, { token: owner.token });
    expect((await checkout(wooLoc.id, [{ variantId: dot, quantity: 1 }])).body.error).toMatchObject({ code: 'external_checkout', details: { provider: 'woocommerce', url: 'https://shop.example.com' } });

    const first = await call(app, 'POST', org(`/connections/${c.body.id}/sync-orders`), { token: owner.token });
    expect(first.body).toMatchObject({ sandbox: true, created: 3, updated: 0 });
    expect(first.body.errors).toHaveLength(0);
    const movesAfterFirst = (await app.ctx.db.select().from(stockMovements).where(eq(stockMovements.locationId, wooLoc.id))).length;
    const again = await call(app, 'POST', org(`/connections/${c.body.id}/sync-orders`), { token: owner.token });
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect((await app.ctx.db.select().from(stockMovements).where(eq(stockMovements.locationId, wooLoc.id))).length).toBe(movesAfterFirst);
    const wooOrders = await app.ctx.db.select().from(orders).where(and(eq(orders.locationId, wooLoc.id), eq(orders.source, 'woocommerce')));
    expect(wooOrders).toHaveLength(3);
    expect(wooOrders.find((o) => o.externalId === '5003')!.lines[0]!.unmapped).toBe(true);

    // Signed webhook: duplicate deliveries and retries never duplicate; status changes update in place.
    const order = { id: 7001, number: '7001', status: 'processing', currency: 'USD', total: '40.00', billing: { first_name: 'Lee', email: 'lee@example.com' }, line_items: [{ name: 'Dot', sku: 'NB-DOT', quantity: 2, price: '20.00' }] };
    const send = (payload: object, delivery: string, secret = 'woo-secret') => {
      const raw = JSON.stringify(payload);
      return app.inject({ method: 'POST', url: `/v1/webhooks/woocommerce/${c.body.id}`, payload: raw, headers: { 'content-type': 'application/json', 'x-wc-webhook-topic': 'order.updated', 'x-wc-webhook-delivery-id': delivery, 'x-wc-webhook-signature': createHmac('sha256', secret).update(raw).digest('base64') } });
    };
    expect((await send(order, 'd-1', 'wrong')).statusCode).toBe(401);
    expect((await send(order, 'd-1')).json()).toMatchObject({ outcome: 'created' });
    expect((await send(order, 'd-1')).json()).toMatchObject({ duplicate: true });
    expect((await send(order, 'd-2')).json()).toMatchObject({ outcome: 'unchanged' });
    const onHand = (await lv(wooLoc.id, dot)).stockOnHand;
    expect((await send({ ...order, status: 'completed' }, 'd-3')).json()).toMatchObject({ outcome: 'updated' });
    expect((await lv(wooLoc.id, dot)).stockOnHand).toBe(onHand);
    const rows = await app.ctx.db.select().from(orders).where(and(eq(orders.source, 'woocommerce'), eq(orders.externalId, '7001')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'fulfilled', externalStatus: 'completed', paymentStatus: 'external' });
    expect(await ledgerSum(wooLoc.id, dot)).toBe((await lv(wooLoc.id, dot)).stockOnHand);
  });

  it('reports keep currencies separate and never combine them', async () => {
    const co = await checkout(yul.id, [{ variantId: dot, quantity: 1 }]);
    expect(co.body.error?.code).toBe('out_of_stock');
    await receive(yul.id, dot, 5);
    await call(app, 'PUT', org(`/locations/${yul.id}/tax-rates`), { token: owner.token, body: { rates: [{ name: 'GST', rateBps: 500, inclusive: false }, { name: 'QST', rateBps: 998, inclusive: false }] } });
    const yco = await checkout(yul.id, [{ variantId: dot, quantity: 1 }]);
    expect(yco.body.order).toMatchObject({ subtotal: { amount: 2600, currency: 'CAD' }, total: { amount: 2600 + 130 + 259, currency: 'CAD' } });
    expect(yco.body.order.taxLines.map((t: any) => t.name)).toEqual(['GST', 'QST']);
    await pay(yco.body.payment.id);
    const rep = await call(app, 'GET', org('/reports'), { token: owner.token });
    expect(rep.status).toBe(200);
    expect(rep.body.combinedRevenue).toBeNull();
    const cur = rep.body.totalsByCurrency.map((t: any) => t.currency).sort();
    expect(cur).toEqual(['CAD', 'USD']);
    const cad = rep.body.totalsByCurrency.find((t: any) => t.currency === 'CAD');
    expect(cad.gross).toEqual({ amount: 2989, currency: 'CAD' });
    for (const s of rep.body.salesByLocation) expect(s.gross.currency).toBe(s.currency);
    for (const p of rep.body.topProducts) expect(new Set(p.revenueByCurrency.map((m: any) => m.currency)).size).toBe(p.revenueByCurrency.length);
    expect(rep.body.inventoryDrift.every((d: any) => d.ledgerMismatches === 0)).toBe(true);
    const ov = await call(app, 'GET', org('/overview'), { token: owner.token });
    expect(ov.body.combinedRevenue).toBeNull();
    expect(ov.body.revenueByCurrency.map((r: any) => r.currency).sort()).toEqual(['CAD', 'USD']);
    expect((await call(app, 'GET', org('/reports'), { token: staff.token })).status).toBe(403);
  });

  it('cycle counts post variances to the ledger; backorders are allocated when stock arrives', async () => {
    const count = await call(app, 'POST', org('/stock-counts'), { token: staff.token, body: { locationId: pdx.id, name: 'Shelf A', variantIds: [dot] } });
    expect(count.status).toBe(201);
    const expected = (await lv(pdx.id, dot)).stockOnHand;
    await call(app, 'POST', org(`/stock-counts/${count.body.id}/entries`), { token: staff.token, body: { entries: [{ variantId: dot, countedQty: expected - 2 }] } });
    await call(app, 'POST', org(`/stock-counts/${count.body.id}/submit`), { token: staff.token });
    expect((await call(app, 'POST', org(`/stock-counts/${count.body.id}/apply`), { token: staff.token })).status).toBe(403);
    const applied = await call(app, 'POST', org(`/stock-counts/${count.body.id}/apply`), { token: manager.token });
    expect(applied.body).toMatchObject({ adjusted: 1, unitsVariance: -2 });
    expect((await lv(pdx.id, dot)).stockOnHand).toBe(expected - 2);

    // Backorder: product allows it, store has none.
    await call(app, 'PUT', org(`/locations/${sea.id}/assortment/${pocket}`), { token: owner.token, body: { allowBackorder: true } });
    const free = (await lv(sea.id, pocket));
    const want = free.stockOnHand - free.reserved + 2;
    const co = await checkout(sea.id, [{ variantId: pocket, quantity: want }]);
    expect(co.status).toBe(201);
    await pay(co.body.payment.id);
    let o = (await call(app, 'GET', org(`/sales-orders/${co.body.order.id}`), { token: owner.token })).body;
    expect(o.fulfilmentStatus).toBe('backordered');
    expect(o.lines[0]).toMatchObject({ backordered: 2 });
    const sup = await call(app, 'POST', org('/suppliers'), { token: owner.token, body: { name: 'Paper Mill Co', currency: 'USD', leadTimeDays: 7 } });
    const po = await call(app, 'POST', org('/purchase-orders'), { token: owner.token, body: { locationId: sea.id, supplierId: sup.body.id, lines: [{ variantId: pocket, quantity: 5, unitCostMinor: 600 }] } });
    expect(po.body).toMatchObject({ status: 'draft', number: expect.stringMatching(/^PO-/) });
    await call(app, 'POST', org(`/purchase-orders/${po.body.id}/send`), { token: owner.token });
    const rec = await call(app, 'POST', org(`/purchase-orders/${po.body.id}/receive`), { token: destStaff.token, body: {} });
    expect(rec.body.backordersWaiting).toEqual([expect.objectContaining({ orderId: co.body.order.id, backordered: 2 })]);
    const alloc = await call(app, 'POST', org(`/sales-orders/${co.body.order.id}/allocate-backorders`), { token: destStaff.token });
    expect(alloc.body.allocated).toBe(2);
    o = alloc.body.order;
    expect(o.fulfilmentStatus).toBe('unfulfilled');
    expect(await ledgerSum(sea.id, pocket)).toBe((await lv(sea.id, pocket)).stockOnHand);
  });

  it('AI copy uses supplied specs only and strips unsupported claims; AI outage is reported, not faked', async () => {
    const off = await call(app, 'POST', org('/ai/product-copy'), { token: owner.token, body: { productId } });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('ai_unavailable');
    const fake: AiProvider = {
      enabled: true, model: 'test-model',
      async createMessage() {
        return { content: [{ type: 'tool_use', id: 't1', name: 'submit_copy', input: { title: 'Field notebook', description: 'Printed on 90 gsm recycled paper. Compatible with all fountain pens. Waterproof cover.', bullets: ['90 gsm paper', 'In stock at every store'] } }] } as never;
      },
    };
    const aiApp = await makeApp({ ai: fake });
    try {
      const r = await call(aiApp, 'POST', org('/ai/product-copy'), { token: owner.token, body: { productId, locale: 'en' } });
      expect(r.status).toBe(200);
      expect(r.body.draft.description).toBe('Printed on 90 gsm recycled paper.');
      expect(r.body.draft.bullets).toEqual(['90 gsm paper']);
      expect(r.body.removedClaims.map((c: any) => c.term).sort()).toEqual(['compatib', 'in stock', 'waterproof']);
      expect(r.body.saved).toBe(false);
      const ex = await call(aiApp, 'GET', org(`/ai/stock-explainer?locationId=${pdx.id}&variantId=${dot}`), { token: owner.token });
      expect(ex.body.findings.length).toBeGreaterThan(0);
      expect(ex.body.findings[0].citations[0]).toMatchObject({ type: 'stock_movement' });
    } finally { await aiApp.close(); }
    const merch = await call(app, 'GET', org('/ai/merchandising'), { token: owner.token });
    expect(merch.status).toBe(200);
    expect(merch.body.aiAvailable).toBe(false);
    for (const sug of merch.body.suggestions) expect(sug.citations.length).toBeGreaterThan(0);
  });
});
