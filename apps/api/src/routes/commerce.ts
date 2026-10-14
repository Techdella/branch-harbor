import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locationVariants, locations, orders, paymentReferences, products, returns, stockMovements, users, variants } from '../db/schema/index.ts';
import { affectsOnHand, convertReservationToSale, REASON_LABEL, reserveForOrder } from '../services/inventory.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { serializePayment } from '../services/payments.ts';
import { refundCommerceOrder } from '../services/commerce.ts';
import { assertRefundWithinThreshold } from '../services/approvals.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const RETURN_FLOW: Record<string, string[]> = { requested: ['reviewed', 'rejected'], reviewed: ['authorised', 'rejected'], authorised: ['received'], received: ['resolved'], resolved: [], rejected: [] };

export const commerceRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.get('/orgs/:orgId/commerce/products', { schema: { tags: ['commerce'], security: secured, params: orgParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const ps = await s.db.select().from(products).where(eq(products.organizationId, req.params.orgId));
    const vs = ps.length ? await s.db.select().from(variants).where(inArray(variants.productId, ps.map((p) => p.id))) : [];
    return { items: ps.map((p) => ({ ...p, variants: vs.filter((v) => v.productId === p.id) })) };
  });

  app.post('/orgs/:orgId/commerce/products', {
    schema: {
      tags: ['commerce'], security: secured, params: orgParams, summary: 'Create a master product with variants (HQ). Prices per currency in minor units.',
      body: z.object({ sku: z.string().min(1), name: z.string().min(1), description: z.string().optional(), status: z.enum(['draft', 'active']).default('draft'), variants: z.array(z.object({ sku: z.string().min(1), name: z.string().min(1), options: z.record(z.string(), z.string()).default({}), prices: z.partialRecord(currency, z.number().int().min(0)) })).min(1) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const out = await s.db.transaction(async (tx) => {
      const [p] = await tx.insert(products).values({ organizationId: orgId, sku: req.body.sku, name: req.body.name, description: req.body.description ?? null, status: req.body.status }).returning();
      const vs = await tx.insert(variants).values(req.body.variants.map((v) => ({ organizationId: orgId, productId: p!.id, ...v }))).returning();
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'product.created', targetType: 'product', targetId: p!.id });
      return { ...p!, variants: vs };
    });
    return reply.code(201).send(out);
  });

  app.put('/orgs/:orgId/commerce/locations/:locationId/variants/:variantId', {
    schema: {
      tags: ['commerce'], security: secured, params: orgParams.extend({ locationId: z.uuid(), variantId: z.uuid() }),
      summary: 'Local assortment: availability, permitted local price, reorder point. Never changes master identifiers or content.',
      body: z.object({ available: z.boolean().optional(), priceMinor: z.number().int().min(0).nullable().optional(), reorderPoint: z.number().int().min(0).nullable().optional() }),
    },
  }, async (req) => {
    const { orgId, locationId, variantId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [v] = await s.db.select().from(variants).where(and(eq(variants.id, variantId), eq(variants.organizationId, orgId)));
    if (!v) throw notFound('Variant');
    const values = { organizationId: orgId, locationId, variantId, ...req.body, currency: loc.currency, updatedAt: new Date() };
    const [row] = await s.db.insert(locationVariants).values(values).onConflictDoUpdate({ target: [locationVariants.locationId, locationVariants.variantId], set: { ...req.body, updatedAt: new Date() } }).returning();
    return { ...row, effectivePrice: row!.priceMinor ?? v.prices[loc.currency] ?? null, priceOrigin: row!.priceMinor != null ? 'local' : 'hq' };
  });

  app.get('/orgs/:orgId/commerce/locations/:locationId/stock', { schema: { tags: ['commerce'], security: secured, params: orgParams.extend({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const rows = await s.db.select({ lv: locationVariants, v: variants }).from(locationVariants).innerJoin(variants, eq(variants.id, locationVariants.variantId)).where(eq(locationVariants.locationId, loc.id));
    return { items: rows.map((r) => ({ variantId: r.v.id, sku: r.v.sku, name: r.v.name, stockOnHand: r.lv.stockOnHand, available: r.lv.available, reorderPoint: r.lv.reorderPoint, lowStock: r.lv.reorderPoint !== null && r.lv.stockOnHand <= r.lv.reorderPoint, price: { amount: r.lv.priceMinor ?? r.v.prices[loc.currency] ?? null, currency: loc.currency } })) };
  });

  app.post('/orgs/:orgId/commerce/stock-movements', {
    schema: {
      tags: ['commerce'], security: secured, params: orgParams, summary: 'Record an inventory movement with a reason (history, not just a mutable number)',
      body: z.object({ locationId: z.uuid(), variantId: z.uuid(), quantity: z.number().int().refine((n) => n !== 0, 'Quantity cannot be zero'), reason: z.enum(['adjustment', 'count', 'return', 'transfer_in', 'transfer_out', 'damage', 'received']), note: z.string().max(500).optional(), reference: z.string().max(120).optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await requireLocationPerm(req, s.db, orgId, b.locationId, 'operations.write');
    const [v] = await s.db.select().from(variants).where(and(eq(variants.id, b.variantId), eq(variants.organizationId, orgId)));
    if (!v) throw notFound('Variant');
    const out = await s.db.transaction(async (tx) => {
      await tx.insert(locationVariants).values({ organizationId: orgId, locationId: b.locationId, variantId: b.variantId }).onConflictDoNothing();
      const [lv] = await tx.select().from(locationVariants).where(and(eq(locationVariants.locationId, b.locationId), eq(locationVariants.variantId, b.variantId))).for('update');
      const next = lv!.stockOnHand + b.quantity;
      if (next < 0 && b.reason !== 'count') throw conflict('insufficient_stock', `Only ${lv!.stockOnHand} in stock`);
      const [m] = await tx.insert(stockMovements).values({ organizationId: orgId, locationId: b.locationId, variantId: b.variantId, quantity: b.quantity, reason: b.reason, note: b.note ?? null, reference: b.reference ?? null, createdBy: req.user!.id }).returning();
      await tx.update(locationVariants).set({ stockOnHand: next, updatedAt: new Date() }).where(eq(locationVariants.id, lv!.id));
      return { movement: m, stockOnHand: next };
    });
    return reply.code(201).send(out);
  });

  app.get('/orgs/:orgId/commerce/stock-movements', {
    schema: {
      tags: ['commerce'], security: secured, params: orgParams,
      summary: 'Inventory history: adjustments with reason, sales, returns, reservations and releases, with the on-hand balance after each physical movement',
      querystring: z.object({ locationId: z.uuid().optional(), variantId: z.uuid().optional(), reason: z.string().optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    if (req.query.locationId) await requireLocationPerm(req, s.db, orgId, req.query.locationId, 'operations.read');
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const conds = [eq(stockMovements.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(stockMovements.locationId, req.query.locationId));
    else if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(inArray(stockMovements.locationId, [...allowed]));
    }
    if (req.query.variantId) conds.push(eq(stockMovements.variantId, req.query.variantId));
    if (req.query.reason) conds.push(inArray(stockMovements.reason, req.query.reason.split(',')));
    if (req.query.from) conds.push(gte(stockMovements.createdAt, new Date(req.query.from)));
    if (req.query.to) conds.push(lt(stockMovements.createdAt, new Date(req.query.to)));
    // Running on-hand balance per (location, variant) over physical movements only.
    const balance = sql<number>`(sum(case when ${stockMovements.reason} in ('reservation','release') then 0 else ${stockMovements.quantity} end) over (partition by ${stockMovements.locationId}, ${stockMovements.variantId} order by ${stockMovements.createdAt}, ${stockMovements.id}))::int`;
    const all = s.db.$with('all_moves').as(s.db.select({ id: stockMovements.id, balanceAfter: balance.as('balance_after') }).from(stockMovements).where(eq(stockMovements.organizationId, orgId)));
    const rows = await s.db.with(all).select({ m: stockMovements, balanceAfter: all.balanceAfter, v: { sku: variants.sku, name: variants.name }, p: { name: products.name }, l: { name: locations.name, timeZone: locations.timeZone }, by: { name: users.name } })
      .from(stockMovements).innerJoin(all, eq(all.id, stockMovements.id)).innerJoin(variants, eq(variants.id, stockMovements.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .innerJoin(locations, eq(locations.id, stockMovements.locationId)).leftJoin(users, eq(users.id, stockMovements.createdBy))
      .where(and(...conds)).orderBy(desc(stockMovements.createdAt), desc(stockMovements.id)).limit(req.query.limit);
    return {
      items: rows.map(({ m, balanceAfter, v, p, l, by }) => ({
        ...m, createdAt: m.createdAt.toISOString(), reasonLabel: REASON_LABEL[m.reason] ?? m.reason, affectsOnHand: affectsOnHand(m.reason),
        balanceAfter: affectsOnHand(m.reason) ? balanceAfter : null, variant: { id: m.variantId, sku: v.sku, name: v.name, productName: p.name }, location: { id: m.locationId, name: l.name, timeZone: l.timeZone },
        createdByName: by?.name ?? (m.createdBy ? 'Team member' : 'System'),
      })),
    };
  });

  app.get('/orgs/:orgId/commerce/inventory', {
    schema: { tags: ['commerce'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Stock per location and variant: on hand, reserved, available, low-stock and last movement' },
  }, async (req) => {
    const { orgId } = req.params;
    if (req.query.locationId) await requireLocationPerm(req, s.db, orgId, req.query.locationId, 'operations.read');
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const conds = [eq(locationVariants.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(locationVariants.locationId, req.query.locationId));
    else if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(inArray(locationVariants.locationId, [...allowed]));
    }
    const rows = await s.db.select({ lv: locationVariants, v: variants, p: { name: products.name }, l: { name: locations.name, currency: locations.currency } })
      .from(locationVariants).innerJoin(variants, eq(variants.id, locationVariants.variantId)).innerJoin(products, eq(products.id, variants.productId)).innerJoin(locations, eq(locations.id, locationVariants.locationId))
      .where(and(...conds)).orderBy(locations.name, products.name, variants.name);
    const last = rows.length ? await s.db.select({ locationId: stockMovements.locationId, variantId: stockMovements.variantId, at: sql<string>`max(${stockMovements.createdAt})` }).from(stockMovements)
      .where(eq(stockMovements.organizationId, orgId)).groupBy(stockMovements.locationId, stockMovements.variantId) : [];
    return {
      items: rows.map(({ lv, v, p, l }) => ({
        locationId: lv.locationId, locationName: l.name, variantId: v.id, sku: v.sku, name: v.name, productName: p.name,
        onHand: lv.stockOnHand, reserved: lv.reserved, available: Math.max(0, lv.stockOnHand - lv.reserved), reorderPoint: lv.reorderPoint,
        lowStock: lv.reorderPoint !== null && lv.stockOnHand - lv.reserved <= lv.reorderPoint, sellable: lv.available,
        price: { amount: lv.priceMinor ?? v.prices[l.currency] ?? null, currency: l.currency },
        lastMovementAt: (() => { const x = last.find((m) => m.locationId === lv.locationId && m.variantId === v.id)?.at; return x ? new Date(x).toISOString() : null; })(),
      })),
    };
  });

  app.get('/orgs/:orgId/commerce/orders', { schema: { tags: ['commerce'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.string().optional() }) } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const conds = [eq(orders.organizationId, req.params.orgId)];
    if (req.query.locationId) conds.push(eq(orders.locationId, req.query.locationId));
    if (req.query.status) conds.push(eq(orders.status, req.query.status));
    if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(inArray(orders.locationId, [...allowed]));
    }
    return { items: await s.db.select().from(orders).where(and(...conds)).orderBy(desc(orders.createdAt)).limit(200) };
  });

  app.post('/orgs/:orgId/commerce/orders', {
    schema: {
      tags: ['commerce'], security: secured, params: orgParams,
      summary: 'Record an order (native or synced). Idempotent on (source, externalId): retrying never duplicates an order.',
      body: z.object({ locationId: z.uuid(), source: z.enum(['native', 'woocommerce', 'shopify', 'square']).default('native'), externalId: z.string().optional(), status: z.enum(['pending_payment', 'paid', 'fulfilled']).default('pending_payment'), lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1) })).min(1), taxMinor: z.number().int().min(0).default(0), discountMinor: z.number().int().min(0).default(0) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    const loc = await requireLocationPerm(req, s.db, orgId, b.locationId, 'operations.write');
    if (b.source !== 'native' && !b.externalId) throw validationError('externalId is required for synced orders', { externalId: 'Required' });
    if (b.externalId) {
      const [existing] = await s.db.select().from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.source, b.source), eq(orders.externalId, b.externalId)));
      if (existing) return reply.code(200).send({ order: existing, duplicate: true });
    }
    const vs = await s.db.select().from(variants).where(and(eq(variants.organizationId, orgId), inArray(variants.id, b.lines.map((l) => l.variantId))));
    const lvs = await s.db.select().from(locationVariants).where(and(eq(locationVariants.locationId, loc.id), inArray(locationVariants.variantId, b.lines.map((l) => l.variantId))));
    const lines = b.lines.map((l, i) => {
      const v = vs.find((x) => x.id === l.variantId);
      if (!v) throw validationError('Unknown variant', { [`lines.${i}.variantId`]: 'Not found' });
      const price = lvs.find((x) => x.variantId === v.id)?.priceMinor ?? v.prices[loc.currency];
      if (price === undefined || price === null) throw validationError(`${v.name} has no price in ${loc.currency}`, { [`lines.${i}.variantId`]: `No ${loc.currency} price` });
      return { variantId: v.id, sku: v.sku, name: v.name, quantity: l.quantity, unitPriceMinor: price };
    });
    const subtotal = lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0);
    const order = await s.db.transaction(async (tx) => {
      const [o] = await tx.insert(orders).values({ organizationId: orgId, locationId: loc.id, source: b.source, externalId: b.externalId ?? null, status: b.status, currency: loc.currency, subtotalMinor: subtotal, taxMinor: b.taxMinor, discountMinor: b.discountMinor, totalMinor: subtotal + b.taxMinor - b.discountMinor, lines }).onConflictDoNothing().returning();
      if (!o) return null;
      // Paid/fulfilled orders are sales; unpaid native orders reserve stock until payment confirms.
      if (b.status !== 'pending_payment') await convertReservationToSale(tx, o);
      else if (b.source === 'native') await reserveForOrder(tx, o, req.user!.id);
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'order.recorded', scopeKind: 'location', scopeId: loc.id, targetType: 'order', targetId: o.id, metadata: { source: b.source } });
      return o;
    });
    if (!order) {
      const [existing] = await s.db.select().from(orders).where(and(eq(orders.organizationId, orgId), eq(orders.source, b.source), eq(orders.externalId, b.externalId!)));
      return reply.code(200).send({ order: existing, duplicate: true });
    }
    return reply.code(201).send({ order, duplicate: false });
  });

  app.post('/orgs/:orgId/commerce/orders/:id/refunds', {
    schema: {
      tags: ['commerce'], security: secured, params: idParams, summary: 'Partial refund of an order. BranchHarbor payments are refunded at the provider; external orders are recorded only.',
      body: z.object({ amountMinor: z.number().int().positive(), reason: z.string().max(500).optional(), restock: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1) })).default([]) }),
    },
  }, async (req, reply) => {
    const [o] = await s.db.select().from(orders).where(and(eq(orders.id, req.params.id), eq(orders.organizationId, req.params.orgId)));
    if (!o) throw notFound('Order');
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'payments.refund');
    await assertRefundWithinThreshold(req, s.db, o.organizationId, req.body.amountMinor, o.currency);
    const r = await refundCommerceOrder(s, o.id, { amountMinor: req.body.amountMinor, reason: req.body.reason, restock: req.body.restock, actorUserId: req.user!.id, ip: req.ip });
    return reply.code(201).send({ order: r.order, payment: r.payment, refundState: r.refundState, note: r.note });
  });

  app.post('/orgs/:orgId/commerce/orders/:id/returns', {
    schema: { tags: ['commerce'], security: secured, params: idParams, body: z.object({ lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1) })).min(1), reason: z.string().max(500).optional() }) },
  }, async (req, reply) => {
    const [o] = await s.db.select().from(orders).where(and(eq(orders.id, req.params.id), eq(orders.organizationId, req.params.orgId)));
    if (!o) throw notFound('Order');
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
    const [r] = await s.db.insert(returns).values({ organizationId: o.organizationId, locationId: o.locationId, orderId: o.id, lines: req.body.lines, reason: req.body.reason ?? null }).returning();
    return reply.code(201).send(r);
  });

  app.post('/orgs/:orgId/commerce/returns/:id/status', {
    schema: { tags: ['commerce'], security: secured, params: idParams, body: z.object({ to: z.enum(['reviewed', 'authorised', 'received', 'resolved', 'rejected']) }), summary: 'requested → reviewed → authorised → received → resolved (or rejected)' },
  }, async (req) => {
    const [r] = await s.db.select().from(returns).where(and(eq(returns.id, req.params.id), eq(returns.organizationId, req.params.orgId)));
    if (!r) throw notFound('Return');
    await requireLocationPerm(req, s.db, r.organizationId, r.locationId, 'operations.write');
    if (!RETURN_FLOW[r.status]?.includes(req.body.to)) throw conflict('invalid_transition', `Cannot move a return from ${r.status} to ${req.body.to}`);
    const [u] = await s.db.update(returns).set({ status: req.body.to, updatedAt: new Date() }).where(eq(returns.id, r.id)).returning();
    return u;
  });

  app.get('/orgs/:orgId/commerce/orders/:id', { schema: { tags: ['commerce'], security: secured, params: idParams } }, async (req) => {
    const [o] = await s.db.select().from(orders).where(and(eq(orders.id, req.params.id), eq(orders.organizationId, req.params.orgId)));
    if (!o) throw notFound('Order');
    await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.read');
    const [p] = o.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.paymentId)) : [];
    return { ...o, payment: p ? serializePayment(p) : null, returns: await s.db.select().from(returns).where(eq(returns.orderId, o.id)) };
  });
};
