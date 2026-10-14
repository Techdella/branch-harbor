import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  approvals, connections, giftCardLedger, giftCards, locations, orderFulfilments, orders, paymentReferences, products, purchaseOrders, returns, stockCountLines, stockCounts,
  stockTransfers, suppliers, syncRuns, variants,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, locationAllowed, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { serializePayment } from '../services/payments.ts';
import {
  advanceFulfilment, allocateBackorders, expireOrder, expireReservations, fulfilmentNext, locationMap, orderTransfer, pickLines, resolveStockConflict, serializeOrder, startFulfilment,
} from '../services/commerce-orders.ts';
import {
  applyCount, backorderDemand, cancelTransfer, createCount, createPurchaseOrder, decideTransfer, latestCounts, receivePurchaseOrder, receiveTransfer, recordCounts, reorderAlerts,
  requestTransfer, serializeTransfer, shipTransfer,
} from '../services/commerce-inventory.ts';
import { adjustGiftCard, createReturn, creditBalances, issueGiftCard, receiveReturn, resolveReturn, serializeGiftCard, serializeReturn, transitionReturn } from '../services/commerce-returns.ts';
import { commerceReport, draftProductCopy, explainStock, merchandisingSuggestions } from '../services/commerce-insights.ts';
import { syncWooOrders } from '../services/commerce-woo.ts';
import { requireManager } from './commerce-catalogue.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const tags = ['commerce'];
const lineQty = z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(0) }));

export const commerceOperationsRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  /** Orders are visible to staff of the selling store and of the collection store. */
  async function loadOrder(req: FastifyRequest, orgId: string, id: string, perm: 'operations.read' | 'operations.write' = 'operations.read') {
    const [o] = await s.db.select().from(orders).where(and(eq(orders.id, id), eq(orders.organizationId, orgId)));
    if (!o) throw notFound('Order');
    const allowed = await authorisedLocations(req, s.db, orgId, perm);
    if (!locationAllowed(allowed, o.locationId) && !locationAllowed(allowed, o.fulfilmentLocationId)) {
      if (!locationAllowed(await authorisedLocations(req, s.db, orgId, 'operations.read'), o.locationId)) throw notFound('Order');
      throw forbidden(`Missing permission ${perm} for this order's store`);
    }
    return o;
  }

  async function orderDetail(orgId: string, o: typeof orders.$inferSelect) {
    const [fs, transfer, rs, names] = await Promise.all([
      s.db.select().from(orderFulfilments).where(eq(orderFulfilments.orderId, o.id)).orderBy(asc(orderFulfilments.createdAt)),
      orderTransfer(s.db, o.id), s.db.select().from(returns).where(eq(returns.orderId, o.id)).orderBy(desc(returns.createdAt)), locationMap(s.db, orgId),
    ]);
    const [p] = o.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.paymentId)) : [];
    return { ...serializeOrder(o, { staff: true, locations: names, fulfilments: fs, transfer }), payment: p ? serializePayment(p) : null, returns: rs.map((r) => serializeReturn(r, { orderNumber: o.orderNumber })) };
  }

  // ───────── Overview / pulse ─────────

  app.get('/orgs/:orgId/commerce/overview', {
    schema: { tags, security: secured, params: orgParams, summary: 'Commerce overview: orders needing action, stock warnings, revenue by currency (today / 7 days) and connection health' },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    await expireReservations(s, { organizationId: orgId }).catch(() => {});
    const locs = (await s.db.select().from(locations).where(eq(locations.organizationId, orgId))).filter((l) => allowed === 'all' || allowed.has(l.id));
    const ids = locs.map((l) => l.id);
    const canReports = await authorisedLocations(req, s.db, orgId, 'reports.read');
    const since7 = new Date(Date.now() - 7 * 86400_000);
    const recent = ids.length ? await s.db.select().from(orders).where(and(inArray(orders.locationId, ids), gte(orders.createdAt, since7))) : [];
    const open = ids.length ? await s.db.select().from(orders).where(and(or(inArray(orders.locationId, ids), inArray(orders.fulfilmentLocationId, ids)), inArray(orders.paymentStatus, ['paid', 'external', 'not_required', 'partially_refunded']), sql`${orders.fulfilmentStatus} not in ('fulfilled','cancelled')`)) : [];
    const sales = locs.filter((l) => locationAllowed(canReports, l.id)).map((l) => {
      const mine = recent.filter((o) => o.locationId === l.id && !['pending_payment', 'expired', 'cancelled'].includes(o.status) && o.source !== 'exchange');
      // "Today" is the store's local calendar day.
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: l.timeZone });
      const todayKey = day.format(new Date());
      const today = mine.filter((o) => day.format(o.createdAt) === todayKey);
      return {
        locationId: l.id, locationName: l.name, currency: l.currency, timeZone: l.timeZone,
        today: { orders: today.length, gross: { amount: today.reduce((a, o) => a + o.totalMinor, 0), currency: l.currency } },
        last7Days: { orders: mine.length, gross: { amount: mine.reduce((a, o) => a + o.totalMinor, 0), currency: l.currency }, refunds: { amount: mine.reduce((a, o) => a + o.refundedMinor, 0), currency: l.currency } },
      };
    });
    const byCurrency = new Map<string, { currency: string; today: number; last7Days: number; orders7: number }>();
    for (const x of sales) {
      const e = byCurrency.get(x.currency) ?? { currency: x.currency, today: 0, last7Days: 0, orders7: 0 };
      e.today += x.today.gross.amount; e.last7Days += x.last7Days.gross.amount; e.orders7 += x.last7Days.orders;
      byCurrency.set(x.currency, e);
    }
    const alerts = await reorderAlerts(s.db, orgId, allowed);
    const conns = await s.db.select().from(connections).where(and(eq(connections.organizationId, orgId), eq(connections.kind, 'commerce')));
    const lastRuns = conns.length ? await s.db.select().from(syncRuns).where(inArray(syncRuns.connectionId, conns.map((c) => c.id))).orderBy(desc(syncRuns.createdAt)).limit(20) : [];
    const transfers = await s.db.select().from(stockTransfers).where(and(eq(stockTransfers.organizationId, orgId), inArray(stockTransfers.status, ['requested', 'approved', 'in_transit'])));
    const rs = ids.length ? await s.db.select().from(returns).where(and(inArray(returns.locationId, ids), inArray(returns.status, ['requested', 'reviewed', 'authorised', 'received', 'refund_pending_approval']))) : [];
    return {
      asOf: new Date().toISOString(),
      orders: {
        toFulfil: open.filter((o) => ['unfulfilled', 'picking', 'packed', 'partially_fulfilled'].includes(o.fulfilmentStatus)).length,
        readyForPickup: open.filter((o) => o.fulfilmentStatus === 'ready_for_pickup').length,
        backordered: open.filter((o) => o.fulfilmentStatus === 'backordered').length,
        awaitingTransfer: open.filter((o) => o.fulfilmentStatus === 'awaiting_transfer').length,
        needsAttention: open.filter((o) => o.attention).length,
        awaitingPayment: recent.filter((o) => o.status === 'pending_payment').length,
      },
      sales: canReports === 'all' || (canReports instanceof Set && canReports.size) ? sales : null,
      salesUnavailableReason: canReports === 'all' || (canReports instanceof Set && canReports.size) ? null : 'Requires report access',
      revenueByCurrency: [...byCurrency.values()].map((x) => ({ currency: x.currency, today: { amount: x.today, currency: x.currency }, last7Days: { amount: x.last7Days, currency: x.currency }, orders7: x.orders7 })),
      combinedRevenue: null, combinedRevenueReason: 'Different currencies are never added together.',
      stock: { low: alerts.filter((a) => a.severity === 'low').length, out: alerts.filter((a) => a.severity === 'out').length, top: alerts.slice(0, 5) },
      transfers: { requested: transfers.filter((t) => t.status === 'requested').length, toShip: transfers.filter((t) => t.status === 'approved').length, inTransit: transfers.filter((t) => t.status === 'in_transit').length },
      returns: { open: rs.length, awaitingApproval: rs.filter((r) => r.status === 'refund_pending_approval').length },
      connections: conns.filter((c) => !c.locationId || locationAllowed(allowed, c.locationId)).map((c) => ({ id: c.id, provider: c.provider, locationId: c.locationId, authoritative: c.authoritative, state: c.state, lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null, lastError: c.lastError, lastRun: lastRuns.find((r) => r.connectionId === c.id) ?? null })),
    };
  });

  // ───────── Orders ─────────

  app.get('/orgs/:orgId/commerce/sales-orders', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Orders with payment and fulfilment states, source and authoritative system',
      querystring: z.object({ locationId: z.uuid().optional(), status: z.string().optional(), paymentStatus: z.string().optional(), fulfilmentStatus: z.string().optional(), source: z.string().optional(), attention: z.coerce.boolean().optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    await expireReservations(s, { organizationId: orgId }).catch(() => {});
    const q = req.query;
    const conds = [eq(orders.organizationId, orgId)];
    if (q.locationId) conds.push(or(eq(orders.locationId, q.locationId), eq(orders.fulfilmentLocationId, q.locationId))!);
    if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(or(inArray(orders.locationId, [...allowed]), inArray(orders.fulfilmentLocationId, [...allowed]))!);
    }
    if (q.status) conds.push(inArray(orders.status, q.status.split(',')));
    if (q.paymentStatus) conds.push(inArray(orders.paymentStatus, q.paymentStatus.split(',')));
    if (q.fulfilmentStatus) conds.push(inArray(orders.fulfilmentStatus, q.fulfilmentStatus.split(',')));
    if (q.source) conds.push(inArray(orders.source, q.source.split(',')));
    if (q.attention) conds.push(sql`${orders.attention} is not null`);
    if (q.q) conds.push(sql`(${orders.orderNumber} ilike ${'%' + q.q + '%'} or ${orders.customerName} ilike ${'%' + q.q + '%'} or ${orders.customerEmail} ilike ${'%' + q.q + '%'} or ${orders.externalId} = ${q.q})`);
    const rows = await s.db.select().from(orders).where(and(...conds)).orderBy(desc(orders.createdAt)).limit(q.limit);
    const names = await locationMap(s.db, orgId);
    return { items: rows.map((o) => serializeOrder(o, { staff: true, locations: names })) };
  });

  app.get('/orgs/:orgId/commerce/sales-orders/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id);
    return orderDetail(req.params.orgId, o);
  });

  app.post('/orgs/:orgId/commerce/sales-orders/:id/fulfilments', {
    schema: { tags, security: secured, params: idParams, summary: 'Start picking (all open units, or the given quantities for a partial fulfilment)', body: z.object({ lines: lineQty.optional() }) },
  }, async (req, reply) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id, 'operations.write');
    await requireLocationPerm(req, s.db, o.organizationId, o.fulfilmentLocationId ?? o.locationId, 'operations.write');
    const f = await startFulfilment(s, o, req.user!.id, req.body.lines);
    const [fresh] = await s.db.select().from(orders).where(eq(orders.id, o.id));
    return reply.code(201).send({ fulfilment: { ...f, next: fulfilmentNext(f) }, order: await orderDetail(o.organizationId, fresh!) });
  });

  async function loadFulfilment(req: FastifyRequest, orgId: string, id: string) {
    const [f] = await s.db.select().from(orderFulfilments).where(and(eq(orderFulfilments.id, id), eq(orderFulfilments.organizationId, orgId)));
    if (!f) throw notFound('Fulfilment');
    await requireLocationPerm(req, s.db, orgId, f.locationId, 'operations.write');
    return f;
  }

  app.post('/orgs/:orgId/commerce/fulfilments/:id/pick', {
    schema: { tags, security: secured, params: idParams, summary: 'Record picked units (scan or tap). Reduce quantity for a short pick.', body: z.object({ lines: z.array(z.object({ variantId: z.uuid(), picked: z.number().int().min(0), quantity: z.number().int().min(0).optional() })).min(1) }) },
  }, async (req) => {
    const f = await loadFulfilment(req, req.params.orgId, req.params.id);
    const u = await pickLines(s, f, req.body.lines, req.user!.id);
    return { ...u, next: fulfilmentNext(u) };
  });

  app.post('/orgs/:orgId/commerce/fulfilments/:id/status', {
    schema: { tags, security: secured, params: idParams, summary: 'picking → packed → ready → collected (pickup) | out_for_delivery → delivered | shipped → delivered', body: z.object({ to: z.enum(['packed', 'ready', 'collected', 'out_for_delivery', 'shipped', 'delivered', 'cancelled']), carrier: z.string().max(60).optional(), trackingNumber: z.string().max(80).optional() }) },
  }, async (req) => {
    const f = await loadFulfilment(req, req.params.orgId, req.params.id);
    const r = await advanceFulfilment(s, f, req.body.to, req.user!.id, { carrier: req.body.carrier, trackingNumber: req.body.trackingNumber });
    return { fulfilment: { ...r.fulfilment, next: fulfilmentNext(r.fulfilment) }, order: await orderDetail(f.organizationId, r.order) };
  });

  app.get('/orgs/:orgId/commerce/fulfilment-queue', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid() }), summary: 'Store associate queue: orders to pick/pack/hand over, transfers to ship or receive, counts in progress' },
  }, async (req) => {
    const { orgId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, req.query.locationId, 'operations.read');
    const os = await s.db.select().from(orders).where(and(eq(orders.organizationId, orgId), or(and(eq(orders.locationId, loc.id), sql`${orders.fulfilmentLocationId} is null`), eq(orders.fulfilmentLocationId, loc.id)),
      inArray(orders.paymentStatus, ['paid', 'external', 'not_required', 'partially_refunded']), sql`${orders.fulfilmentStatus} not in ('fulfilled','cancelled')`, sql`${orders.source} in ('native','exchange')`)).orderBy(asc(orders.paidAt)).limit(100);
    const fs = os.length ? await s.db.select().from(orderFulfilments).where(inArray(orderFulfilments.orderId, os.map((o) => o.id))) : [];
    const names = await locationMap(s.db, orgId);
    const ts = await s.db.select().from(stockTransfers).where(and(eq(stockTransfers.organizationId, orgId), or(and(eq(stockTransfers.fromLocationId, loc.id), eq(stockTransfers.status, 'approved')), and(eq(stockTransfers.toLocationId, loc.id), eq(stockTransfers.status, 'in_transit')))));
    const counts = await s.db.select().from(stockCounts).where(and(eq(stockCounts.locationId, loc.id), eq(stockCounts.status, 'in_progress')));
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency },
      orders: os.map((o) => serializeOrder(o, { staff: true, locations: names, fulfilments: fs.filter((f) => f.orderId === o.id) })),
      transfersToShip: ts.filter((t) => t.fromLocationId === loc.id).map((t) => serializeTransfer(t, names)),
      transfersToReceive: ts.filter((t) => t.toLocationId === loc.id).map((t) => serializeTransfer(t, names)),
      countsInProgress: counts.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.toISOString() })),
    };
  });

  app.post('/orgs/:orgId/commerce/sales-orders/:id/allocate-backorders', { schema: { tags, security: secured, params: idParams, summary: 'Allocate newly received stock to backordered lines' } }, async (req) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id, 'operations.write');
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    const r = await allocateBackorders(s, o.id, req.user!.id);
    return { allocated: r.allocated, order: await orderDetail(o.organizationId, r.order) };
  });

  app.post('/orgs/:orgId/commerce/sales-orders/:id/recover', {
    schema: {
      tags, security: secured, params: idParams, summary: 'Recover an order paid after its reservation expired (stock conflict): re-allocate, accept as backorder or transfer from another store. To refund instead, use the refund endpoint.',
      body: z.discriminatedUnion('kind', [z.object({ kind: z.literal('retry_allocation') }), z.object({ kind: z.literal('backorder') }), z.object({ kind: z.literal('transfer_from'), fromLocationId: z.uuid() })]),
    },
  }, async (req) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id, 'operations.write');
    await requireManager(req, s.db, o.organizationId, o.locationId);
    if (req.body.kind === 'transfer_from') await requireLocationPerm(req, s.db, o.organizationId, req.body.fromLocationId, 'operations.read');
    const u = await resolveStockConflict(s, o.id, req.body, req.user!.id);
    return orderDetail(o.organizationId, u);
  });

  app.post('/orgs/:orgId/commerce/sales-orders/:id/cancel', { schema: { tags, security: secured, params: idParams, summary: 'Cancel an unpaid order (releases reserved stock and voids the payment intent)', body: z.object({ note: z.string().max(500).optional() }) } }, async (req) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id, 'operations.write');
    if (o.status !== 'pending_payment') throw conflict('order_not_cancellable', 'Only unpaid orders can be cancelled here; refund paid orders instead');
    const u = await s.db.transaction(async (tx) => expireOrder(tx, o, req.body.note ?? 'Cancelled by staff', 'cancelled'));
    if (o.paymentId) {
      const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.paymentId));
      if (p && ['created', 'requires_action'].includes(p.state)) {
        await s.payments.cancelPaymentIntent(p.externalId, p.connectedAccountId).catch(() => {});
        await s.db.update(paymentReferences).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(paymentReferences.id, p.id));
      }
    }
    await audit(s.db, { organizationId: o.organizationId, ...actor(req), action: 'order.cancelled', scopeKind: 'location', scopeId: o.locationId, targetType: 'order', targetId: o.id });
    return orderDetail(o.organizationId, u);
  });

  app.post('/orgs/:orgId/commerce/reservations/expire', { schema: { tags, security: secured, params: orgParams, summary: 'Release reservations whose payment window ended (also runs automatically)' } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.write');
    return expireReservations(s, { organizationId: req.params.orgId });
  });

  // ───────── Inventory: alerts, counts ─────────

  app.get('/orgs/:orgId/commerce/inventory/alerts', { schema: { tags, security: secured, params: orgParams, summary: 'Reorder alerts: at or below the reorder point, with on-order, incoming transfers, backorders and a suggested quantity' } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return { items: await reorderAlerts(s.db, req.params.orgId, allowed), backorders: (await backorderDemand(s.db, req.params.orgId, null)).filter((b) => locationAllowed(allowed, b.locationId)) };
  });

  app.get('/orgs/:orgId/commerce/stock-counts', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const rows = await latestCounts(s.db, req.params.orgId, allowed);
    const lines = rows.length ? await s.db.select().from(stockCountLines).where(inArray(stockCountLines.countId, rows.map((r) => r.id))) : [];
    const names = await locationMap(s.db, req.params.orgId);
    return { items: rows.map((c) => { const ls = lines.filter((l) => l.countId === c.id); return { ...c, locationName: names.get(c.locationId)?.name ?? null, lines: ls.length, counted: ls.filter((l) => l.countedQty !== null).length, varianceUnits: ls.reduce((a, l) => a + (l.countedQty !== null && l.expectedQty !== null ? l.countedQty - l.expectedQty : 0), 0) }; }) };
  });

  app.post('/orgs/:orgId/commerce/stock-counts', { schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), name: z.string().trim().min(1).max(80), variantIds: z.array(z.uuid()).optional() }) } }, async (req, reply) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    const c = await createCount(s.db, loc, req.body, req.user!.id);
    return reply.code(201).send(await countView(req.params.orgId, c.id));
  });

  async function countView(orgId: string, id: string) {
    const [c] = await s.db.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.organizationId, orgId)));
    if (!c) throw notFound('Count');
    const lines = await s.db.select({ l: stockCountLines, v: { sku: variants.sku, name: variants.name, barcode: variants.barcode }, p: { name: products.name } }).from(stockCountLines)
      .innerJoin(variants, eq(variants.id, stockCountLines.variantId)).innerJoin(products, eq(products.id, variants.productId)).where(eq(stockCountLines.countId, c.id)).orderBy(asc(products.name), asc(variants.sku));
    return { ...c, lines: lines.map(({ l, v, p }) => ({ variantId: l.variantId, sku: v.sku, barcode: v.barcode, name: `${p.name} — ${v.name}`, expectedQty: l.expectedQty, countedQty: l.countedQty, variance: l.countedQty !== null && l.expectedQty !== null ? l.countedQty - l.expectedQty : null, countedAt: l.countedAt?.toISOString() ?? null })) };
  }

  async function loadCount(req: FastifyRequest, orgId: string, id: string) {
    const [c] = await s.db.select().from(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.organizationId, orgId)));
    if (!c) throw notFound('Count');
    await requireLocationPerm(req, s.db, orgId, c.locationId, 'operations.write');
    return c;
  }

  app.get('/orgs/:orgId/commerce/stock-counts/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const [c] = await s.db.select().from(stockCounts).where(and(eq(stockCounts.id, req.params.id), eq(stockCounts.organizationId, req.params.orgId)));
    if (!c) throw notFound('Count');
    await requireLocationPerm(req, s.db, req.params.orgId, c.locationId, 'operations.read');
    return countView(req.params.orgId, c.id);
  });
  app.post('/orgs/:orgId/commerce/stock-counts/:id/entries', { schema: { tags, security: secured, params: idParams, summary: 'Record counted quantities (the ledger on-hand at that moment is kept as expected)', body: z.object({ entries: z.array(z.object({ variantId: z.uuid(), countedQty: z.number().int().min(0) })).min(1) }) } }, async (req) => {
    const c = await loadCount(req, req.params.orgId, req.params.id);
    await recordCounts(s.db, c, req.body.entries, req.user!.id);
    return countView(req.params.orgId, c.id);
  });
  app.post('/orgs/:orgId/commerce/stock-counts/:id/submit', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const c = await loadCount(req, req.params.orgId, req.params.id);
    if (c.status !== 'in_progress') throw conflict('invalid_transition', `This count is ${c.status}`);
    await s.db.update(stockCounts).set({ status: 'submitted', submittedBy: req.user!.id, submittedAt: new Date() }).where(eq(stockCounts.id, c.id));
    return countView(req.params.orgId, c.id);
  });
  app.post('/orgs/:orgId/commerce/stock-counts/:id/apply', { schema: { tags, security: secured, params: idParams, summary: 'Apply variances as `count` movements (manager)' } }, async (req) => {
    const c = await loadCount(req, req.params.orgId, req.params.id);
    await requireManager(req, s.db, req.params.orgId, c.locationId);
    const r = await applyCount(s, c.id, req.user!.id);
    return { adjusted: r.adjusted, unitsVariance: r.unitsVariance, count: await countView(req.params.orgId, c.id) };
  });

  // ───────── Transfers ─────────

  async function loadTransfer(orgId: string, id: string) {
    const [t] = await s.db.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId)));
    if (!t) throw notFound('Transfer');
    return t;
  }

  app.get('/orgs/:orgId/commerce/transfers', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.string().optional(), locationId: z.uuid().optional() }) } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    let rows = await s.db.select().from(stockTransfers).where(eq(stockTransfers.organizationId, req.params.orgId)).orderBy(desc(stockTransfers.createdAt)).limit(200);
    rows = rows.filter((t) => locationAllowed(allowed, t.fromLocationId) || locationAllowed(allowed, t.toLocationId));
    if (req.query.status) rows = rows.filter((t) => req.query.status!.split(',').includes(t.status));
    if (req.query.locationId) rows = rows.filter((t) => t.fromLocationId === req.query.locationId || t.toLocationId === req.query.locationId);
    const names = await locationMap(s.db, req.params.orgId);
    return { items: rows.map((t) => serializeTransfer(t, names)) };
  });

  app.post('/orgs/:orgId/commerce/transfers', {
    schema: { tags, security: secured, params: orgParams, summary: 'Request an inter-store transfer (needs approval by a manager of the sending store)', body: z.object({ fromLocationId: z.uuid(), toLocationId: z.uuid(), lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1) })).min(1).max(100), reason: z.string().max(500).optional() }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.write');
    if (!locationAllowed(allowed, b.fromLocationId) && !locationAllowed(allowed, b.toLocationId)) throw forbidden('You can request transfers for your own stores');
    for (const id of [b.fromLocationId, b.toLocationId]) {
      const [l] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
      if (!l) throw validationError('Unknown store', { [id === b.fromLocationId ? 'fromLocationId' : 'toLocationId']: 'Not found' });
    }
    const t = await requestTransfer(s.db, { organizationId: orgId, ...b, by: req.user!.id });
    return reply.code(201).send(serializeTransfer(t, await locationMap(s.db, orgId)));
  });

  app.get('/orgs/:orgId/commerce/transfers/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const t = await loadTransfer(req.params.orgId, req.params.id);
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    if (!locationAllowed(allowed, t.fromLocationId) && !locationAllowed(allowed, t.toLocationId)) throw notFound('Transfer');
    return serializeTransfer(t, await locationMap(s.db, req.params.orgId));
  });

  app.post('/orgs/:orgId/commerce/transfers/:id/decision', { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }) } }, async (req) => {
    const t = await loadTransfer(req.params.orgId, req.params.id);
    await requireManager(req, s.db, req.params.orgId, t.fromLocationId);
    return serializeTransfer(await decideTransfer(s.db, t, req.body.decision, req.user!.id, req.body.note), await locationMap(s.db, req.params.orgId));
  });

  app.post('/orgs/:orgId/commerce/transfers/:id/ship', { schema: { tags, security: secured, params: idParams, summary: 'Ship from the sending store: transfer_out movements; units are in transit', body: z.object({ lines: lineQty.optional(), carrier: z.string().max(60).optional(), trackingNumber: z.string().max(80).optional() }) } }, async (req) => {
    const t = await loadTransfer(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, req.params.orgId, t.fromLocationId, 'operations.write');
    return serializeTransfer(await shipTransfer(s, t.id, req.body, req.user!.id), await locationMap(s.db, req.params.orgId));
  });

  app.post('/orgs/:orgId/commerce/transfers/:id/receive', { schema: { tags, security: secured, params: idParams, summary: 'Receive at the destination: transfer_in for units that arrived; shortfalls are recorded as transit loss', body: z.object({ lines: lineQty.optional(), note: z.string().max(500).optional() }) } }, async (req) => {
    const t = await loadTransfer(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, req.params.orgId, t.toLocationId, 'operations.write');
    return serializeTransfer(await receiveTransfer(s, t.id, req.body, req.user!.id), await locationMap(s.db, req.params.orgId));
  });

  app.post('/orgs/:orgId/commerce/transfers/:id/cancel', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().max(500).optional() }) } }, async (req) => {
    const t = await loadTransfer(req.params.orgId, req.params.id);
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.write');
    if (!locationAllowed(allowed, t.fromLocationId) && !locationAllowed(allowed, t.toLocationId)) throw forbidden();
    return serializeTransfer(await cancelTransfer(s.db, t, req.user!.id, req.body.note), await locationMap(s.db, req.params.orgId));
  });

  // ───────── Suppliers & purchase orders ─────────

  app.get('/orgs/:orgId/commerce/suppliers', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return { items: await s.db.select().from(suppliers).where(eq(suppliers.organizationId, req.params.orgId)).orderBy(asc(suppliers.name)) };
  });
  app.post('/orgs/:orgId/commerce/suppliers', { schema: { tags, security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(120), email: z.email().nullable().default(null), phone: z.string().max(40).nullable().default(null), currency, leadTimeDays: z.number().int().min(0).max(365).nullable().default(null), notes: z.string().max(1000).nullable().default(null) }) } }, async (req, reply) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.write');
    if (allowed !== 'all' && !allowed.size) throw forbidden();
    const [row] = await s.db.insert(suppliers).values({ organizationId: req.params.orgId, ...req.body }).returning();
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'supplier.created', targetType: 'supplier', targetId: row!.id });
    return reply.code(201).send(row);
  });

  app.get('/orgs/:orgId/commerce/purchase-orders', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.string().optional() }) } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    let rows = await s.db.select({ po: purchaseOrders, sup: { name: suppliers.name } }).from(purchaseOrders).innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).where(eq(purchaseOrders.organizationId, req.params.orgId)).orderBy(desc(purchaseOrders.createdAt)).limit(200);
    rows = rows.filter((r) => locationAllowed(allowed, r.po.locationId) && (!req.query.locationId || r.po.locationId === req.query.locationId) && (!req.query.status || req.query.status.split(',').includes(r.po.status)));
    const names = await locationMap(s.db, req.params.orgId);
    return { items: rows.map(({ po, sup }) => ({ ...po, supplierName: sup.name, locationName: names.get(po.locationId)?.name ?? null, total: { amount: po.lines.reduce((a, l) => a + l.unitCostMinor * l.quantity, 0), currency: po.currency }, units: { ordered: po.lines.reduce((a, l) => a + l.quantity, 0), received: po.lines.reduce((a, l) => a + l.received, 0) } })) };
  });

  app.post('/orgs/:orgId/commerce/purchase-orders', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), supplierId: z.uuid(), lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1), unitCostMinor: z.number().int().min(0) })).min(1).max(200), expectedAt: isoDateTime.nullable().optional(), notes: z.string().max(1000).nullable().optional() }) },
  }, async (req, reply) => {
    await requireManager(req, s.db, req.params.orgId, req.body.locationId);
    return reply.code(201).send(await createPurchaseOrder(s.db, { organizationId: req.params.orgId, ...req.body, by: req.user!.id }));
  });

  async function loadPo(orgId: string, id: string) {
    const [po] = await s.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, orgId)));
    if (!po) throw notFound('Purchase order');
    return po;
  }
  app.post('/orgs/:orgId/commerce/purchase-orders/:id/send', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const po = await loadPo(req.params.orgId, req.params.id);
    await requireManager(req, s.db, req.params.orgId, po.locationId);
    if (po.status !== 'draft') throw conflict('invalid_transition', `This purchase order is ${po.status}`);
    const [u] = await s.db.update(purchaseOrders).set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() }).where(eq(purchaseOrders.id, po.id)).returning();
    return u;
  });
  app.post('/orgs/:orgId/commerce/purchase-orders/:id/receive', { schema: { tags, security: secured, params: idParams, summary: 'Receive goods (all open units or the given quantities); returns backorders that can now be allocated', body: z.object({ lines: lineQty.optional() }) } }, async (req) => {
    const po = await loadPo(req.params.orgId, req.params.id);
    await requireLocationPerm(req, s.db, req.params.orgId, po.locationId, 'operations.write');
    return receivePurchaseOrder(s, po.id, req.body, req.user!.id);
  });
  app.post('/orgs/:orgId/commerce/purchase-orders/:id/cancel', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const po = await loadPo(req.params.orgId, req.params.id);
    await requireManager(req, s.db, req.params.orgId, po.locationId);
    if (!['draft', 'sent'].includes(po.status)) throw conflict('invalid_transition', `A ${po.status} purchase order cannot be cancelled`);
    const [u] = await s.db.update(purchaseOrders).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(purchaseOrders.id, po.id)).returning();
    return u;
  });

  // ───────── Returns ─────────

  app.get('/orgs/:orgId/commerce/returns', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.string().optional(), locationId: z.uuid().optional() }) } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    let rows = await s.db.select({ r: returns, o: { number: orders.orderNumber, externalId: orders.externalId } }).from(returns).innerJoin(orders, eq(orders.id, returns.orderId)).where(eq(returns.organizationId, req.params.orgId)).orderBy(desc(returns.createdAt)).limit(300);
    rows = rows.filter((x) => locationAllowed(allowed, x.r.locationId) && (!req.query.locationId || x.r.locationId === req.query.locationId) && (!req.query.status || req.query.status.split(',').includes(x.r.status)));
    const names = await locationMap(s.db, req.params.orgId);
    const apIds = rows.map((x) => x.r.approvalId).filter((x): x is string => !!x);
    const aps = apIds.length ? await s.db.select({ id: approvals.id, status: approvals.status }).from(approvals).where(inArray(approvals.id, apIds)) : [];
    return { items: rows.map(({ r, o }) => serializeReturn(r, { orderNumber: o.number ?? o.externalId, locationName: names.get(r.locationId)?.name ?? null, approvalStatus: aps.find((a) => a.id === r.approvalId)?.status ?? null })) };
  });

  async function loadReturn(req: FastifyRequest, orgId: string, id: string, manager = false) {
    const [r] = await s.db.select().from(returns).where(and(eq(returns.id, id), eq(returns.organizationId, orgId)));
    if (!r) throw notFound('Return');
    if (manager) await requireManager(req, s.db, orgId, r.locationId);
    else await requireLocationPerm(req, s.db, orgId, r.locationId, 'operations.write');
    return r;
  }
  async function returnView(orgId: string, id: string) {
    const [r] = await s.db.select().from(returns).where(eq(returns.id, id));
    const [o] = await s.db.select().from(orders).where(eq(orders.id, r!.orderId));
    const [ap] = r!.approvalId ? await s.db.select().from(approvals).where(eq(approvals.id, r!.approvalId)) : [];
    return serializeReturn(r!, { orderNumber: o?.orderNumber ?? o?.externalId ?? null, locationName: (await locationMap(s.db, orgId)).get(r!.locationId)?.name ?? null, approvalStatus: ap?.status ?? null });
  }

  app.get('/orgs/:orgId/commerce/returns/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const [r] = await s.db.select().from(returns).where(and(eq(returns.id, req.params.id), eq(returns.organizationId, req.params.orgId)));
    if (!r) throw notFound('Return');
    await requireLocationPerm(req, s.db, req.params.orgId, r.locationId, 'operations.read');
    return returnView(req.params.orgId, r.id);
  });

  app.post('/orgs/:orgId/commerce/sales-orders/:id/returns', {
    schema: { tags, security: secured, params: idParams, summary: 'Create a return for a customer at the counter (staff may create outside the window; it is noted)', body: z.object({ lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1), reason: z.string().max(200).optional() })).min(1), reason: z.string().max(500).optional() }) },
  }, async (req, reply) => {
    const o = await loadOrder(req, req.params.orgId, req.params.id, 'operations.write');
    const r = await createReturn(s.db, o, { ...req.body, via: 'staff', by: req.user!.id });
    return reply.code(201).send(await returnView(req.params.orgId, r.id));
  });

  app.post('/orgs/:orgId/commerce/returns/:id/review', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().max(500).optional() }) } }, async (req) => {
    const r = await loadReturn(req, req.params.orgId, req.params.id);
    await transitionReturn(s.db, r, 'reviewed', req.user!.id, req.body.note);
    return returnView(req.params.orgId, r.id);
  });
  app.post('/orgs/:orgId/commerce/returns/:id/authorise', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().max(500).optional() }) } }, async (req) => {
    const r = await loadReturn(req, req.params.orgId, req.params.id, true);
    await transitionReturn(s.db, r, 'authorised', req.user!.id, req.body.note);
    return returnView(req.params.orgId, r.id);
  });
  app.post('/orgs/:orgId/commerce/returns/:id/reject', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().min(1).max(500) }) } }, async (req) => {
    const r = await loadReturn(req, req.params.orgId, req.params.id, true);
    await transitionReturn(s.db, r, 'rejected', req.user!.id, req.body.note);
    return returnView(req.params.orgId, r.id);
  });
  app.post('/orgs/:orgId/commerce/returns/:id/receive', {
    schema: { tags, security: secured, params: idParams, summary: 'Receive returned goods: restock (back to sellable stock) or write off', body: z.object({ lines: z.array(z.object({ variantId: z.uuid(), receivedQty: z.number().int().min(0), disposition: z.enum(['restock', 'write_off']) })).min(1), note: z.string().max(500).optional() }) },
  }, async (req) => {
    const r = await loadReturn(req, req.params.orgId, req.params.id);
    await receiveReturn(s, r.id, req.body, req.user!.id);
    return returnView(req.params.orgId, r.id);
  });
  app.post('/orgs/:orgId/commerce/returns/:id/resolve', {
    schema: {
      tags, security: secured, params: idParams, summary: 'Resolve: refund (partial allowed; above the threshold it goes to the approvals inbox), store credit, or exchange for another variant',
      body: z.discriminatedUnion('resolution', [
        z.object({ resolution: z.literal('refund'), amountMinor: z.number().int().positive().optional(), reason: z.string().max(500).optional() }),
        z.object({ resolution: z.literal('store_credit'), amountMinor: z.number().int().positive().optional(), reason: z.string().max(500).optional() }),
        z.object({ resolution: z.literal('exchange'), lines: z.array(z.object({ fromVariantId: z.uuid(), toVariantId: z.uuid(), quantity: z.number().int().min(1) })).min(1), reason: z.string().max(500).optional() }),
      ]),
    },
  }, async (req) => {
    const r = await loadReturn(req, req.params.orgId, req.params.id, true);
    const out = await resolveReturn(s, req, r.id, req.body, req.user!.id);
    return { ...out, return: await returnView(req.params.orgId, r.id) };
  });

  // ───────── Gift cards & store credit ─────────

  app.get('/orgs/:orgId/commerce/gift-cards', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ email: z.string().optional(), kind: z.enum(['gift_card', 'store_credit']).optional() }) } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'payments.read');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Missing permission payments.read');
    const conds = [eq(giftCards.organizationId, req.params.orgId)];
    if (req.query.email) conds.push(sql`lower(${giftCards.customerEmail}) = ${req.query.email.toLowerCase()}`);
    if (req.query.kind) conds.push(eq(giftCards.kind, req.query.kind));
    const rows = await s.db.select().from(giftCards).where(and(...conds)).orderBy(desc(giftCards.createdAt)).limit(300);
    const totals = new Map<string, number>();
    for (const c of rows) if (c.status === 'active') totals.set(c.currency, (totals.get(c.currency) ?? 0) + c.balanceMinor);
    return { items: rows.filter((c) => !c.issuedAtLocationId || locationAllowed(allowed, c.issuedAtLocationId)).map((c) => serializeGiftCard(c)), outstandingByCurrency: [...totals.entries()].map(([currency, amount]) => ({ amount, currency })) };
  });

  app.post('/orgs/:orgId/commerce/gift-cards', {
    schema: { tags, security: secured, params: orgParams, summary: 'Issue a gift card or store credit (balance in one currency). The code is returned once.', body: z.object({ kind: z.enum(['gift_card', 'store_credit']), currency, amountMinor: z.number().int().positive().max(100_000_00), customerEmail: z.email().nullable().default(null), locationId: z.uuid().nullable().default(null), reason: z.string().max(200).nullable().default(null), expiresAt: isoDateTime.nullable().optional() }) },
  }, async (req, reply) => {
    const b = req.body;
    if (b.locationId) {
      const loc = await requireLocationPerm(req, s.db, req.params.orgId, b.locationId, 'payments.refund');
      if (loc.currency !== b.currency) throw validationError(`${loc.name} sells in ${loc.currency}`, { currency: `Use ${loc.currency}` });
    } else await requirePerm(req, s.db, 'payments.refund', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
    const out = await s.db.transaction(async (tx) => issueGiftCard(tx, { organizationId: req.params.orgId, kind: b.kind, currency: b.currency, amountMinor: b.amountMinor, customerEmail: b.customerEmail, locationId: b.locationId, reason: b.reason, by: req.user!.id, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null }));
    return reply.code(201).send({ ...serializeGiftCard(out.card), code: out.code });
  });

  app.get('/orgs/:orgId/commerce/gift-cards/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'payments.read');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Missing permission payments.read');
    const [c] = await s.db.select().from(giftCards).where(and(eq(giftCards.id, req.params.id), eq(giftCards.organizationId, req.params.orgId)));
    if (!c) throw notFound('Gift card');
    return serializeGiftCard(c, await s.db.select().from(giftCardLedger).where(eq(giftCardLedger.giftCardId, c.id)).orderBy(desc(giftCardLedger.createdAt)));
  });

  app.post('/orgs/:orgId/commerce/gift-cards/:id/adjust', { schema: { tags, security: secured, params: idParams, body: z.object({ amountMinor: z.number().int().refine((n) => n !== 0, 'Cannot be zero'), note: z.string().trim().min(1).max(200) }) } }, async (req) => {
    await requirePerm(req, s.db, 'payments.refund', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
    const [c] = await s.db.select().from(giftCards).where(and(eq(giftCards.id, req.params.id), eq(giftCards.organizationId, req.params.orgId)));
    if (!c) throw notFound('Gift card');
    return serializeGiftCard(await adjustGiftCard(s, c.id, req.body.amountMinor, req.body.note, req.user!.id));
  });

  app.get('/orgs/:orgId/commerce/store-credit', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ email: z.email() }), summary: 'A customer’s gift card and store credit balances, per currency' } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Missing permission customers.read');
    return creditBalances(s.db, [req.params.orgId], req.query.email);
  });

  // ───────── Reports ─────────

  app.get('/orgs/:orgId/commerce/reports', {
    schema: { tags, security: secured, params: orgParams, summary: 'Sales by store per currency, top products, stock turnover, inventory drift and returns rate (never summed across currencies)', querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), locationId: z.uuid().optional() }) },
  }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'reports.read');
    if (allowed !== 'all' && !allowed.size) throw forbidden('Missing permission reports.read');
    const locs =(await s.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, req.params.orgId))).map((l) => l.id).filter((id) => locationAllowed(allowed, id) && (!req.query.locationId || id === req.query.locationId));
    if (req.query.locationId && !locs.length) throw forbidden('Missing permission reports.read for this store');
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400_000);
    if (from >= to) throw validationError('The start must be before the end', { from: 'Before "to"' });
    return commerceReport(s.db, { organizationId: req.params.orgId, from, to, locationIds: locs });
  });

  // ───────── AI ─────────

  app.post('/orgs/:orgId/commerce/ai/product-copy', {
    schema: { tags, security: secured, params: orgParams, summary: 'Draft product copy from the supplied specifications only (unsupported claims are removed). Nothing is saved.', body: z.object({ productId: z.uuid(), locale: z.string().min(2).max(10).default('en'), tone: z.string().max(80).optional(), extraSpecs: z.record(z.string().max(60), z.string().max(400)).optional() }) },
  }, async (req) => {
    const org = { organizationId: req.params.orgId, kind: 'organization' as const, id: req.params.orgId };
    await requirePerm(req, s.db, 'ai.use', org);
    await requirePerm(req, s.db, 'templates.write', org);
    return draftProductCopy(s, req.params.orgId, req.body.productId, req.body);
  });

  app.get('/orgs/:orgId/commerce/ai/merchandising', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), days: z.coerce.number().int().min(7).max(180).default(30) }), summary: 'Merchandising suggestions computed from sales, stock and listings, each citing its records' } }, async (req) => {
    const ai = await authorisedLocations(req, s.db, req.params.orgId, 'ai.use');
    const ops = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const locs = (await s.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, req.params.orgId))).map((l) => l.id).filter((id) => locationAllowed(ai, id) && locationAllowed(ops, id) && (!req.query.locationId || id === req.query.locationId));
    if (!locs.length) throw forbidden('Missing permission ai.use for this scope');
    return merchandisingSuggestions(s, req.params.orgId, locs, req.query.days);
  });

  app.get('/orgs/:orgId/commerce/ai/stock-explainer', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), variantId: z.uuid(), days: z.coerce.number().int().min(1).max(365).default(30) }), summary: 'Explain a stock trend from ledger movements (observations cite movement ids; hypotheses are labelled)' } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'operations.read');
    await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'ai.use');
    return explainStock(s, req.params.orgId, req.query.locationId, req.query.variantId, req.query.days);
  });

  // ───────── External order sync (WooCommerce authoritative) ─────────

  app.post('/orgs/:orgId/commerce/connections/:id/sync-orders', {
    schema: { tags, security: secured, params: idParams, summary: 'Import orders from the authoritative WooCommerce store (idempotent: re-running never duplicates orders or stock movements)' },
  }, async (req) => {
    const [c] = await s.db.select().from(connections).where(and(eq(connections.id, req.params.id), eq(connections.organizationId, req.params.orgId)));
    if (!c) throw notFound('Connection');
    await requirePerm(req, s.db, 'connections.manage', c.locationId ? { organizationId: c.organizationId, kind: 'location', id: c.locationId } : { organizationId: c.organizationId, kind: 'organization', id: c.organizationId });
    if (c.provider !== 'woocommerce') throw conflict('unsupported_provider', 'Order import is available for WooCommerce connections');
    if (c.state === 'disconnected' || c.state === 'authorization_expired') throw conflict('connection_unavailable', `Connection is ${c.state}. Test or re-authorise it first.`);
    const r = await syncWooOrders(s, c);
    await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'connection.orders_synced', targetType: 'connection', targetId: c.id, metadata: { created: r.created, updated: r.updated, errors: r.errors.length } });
    return r;
  });

  // Fail fast on unknown variants in lookups used by the screens.
  app.get('/orgs/:orgId/commerce/variants/lookup', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ code: z.string().min(1).max(64) }), summary: 'Find a variant by SKU or barcode (scanning)' } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const rows = await s.db.select({ v: variants, p: { name: products.name } }).from(variants).innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.organizationId, req.params.orgId), or(eq(variants.sku, req.query.code), eq(variants.barcode, req.query.code))));
    if (!rows.length) throw notFound('Item');
    return { variantId: rows[0]!.v.id, sku: rows[0]!.v.sku, barcode: rows[0]!.v.barcode, name: `${rows[0]!.p.name} — ${rows[0]!.v.name}` };
  });

};
