import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  locationVariants, locations, orders, products, purchaseOrders, stockCountLines, stockCounts, stockTransfers, suppliers, variants,
  type PurchaseOrderLine, type TransferLine,
} from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { applyMovement, availableOf, historyEntry, lockStock, nextNumber, releaseHeld, reserveLines } from './commerce-stock.ts';
import { refreshFulfilmentStatus } from './commerce-orders.ts';

type Transfer = typeof stockTransfers.$inferSelect;

async function variantLines(db: Exec, organizationId: string, lines: Array<{ variantId: string; quantity: number }>) {
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const vs = ids.length ? await db.select({ v: variants, p: { name: products.name } }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(variants.organizationId, organizationId), inArray(variants.id, ids))) : [];
  return lines.map((l, i) => {
    const v = vs.find((x) => x.v.id === l.variantId);
    if (!v) throw validationError('Unknown variant', { [`lines.${i}.variantId`]: 'Not found' });
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw validationError('Quantities must be at least 1', { [`lines.${i}.quantity`]: 'At least 1' });
    return { variantId: v.v.id, sku: v.v.sku, name: `${v.p.name} — ${v.v.name}`, quantity: l.quantity };
  });
}

// ───────── Transfers: request → approve → ship (in transit) → receive ─────────

export async function requestTransfer(db: Exec, input: { organizationId: string; fromLocationId: string; toLocationId: string; lines: Array<{ variantId: string; quantity: number }>; reason?: string | null; by: string }) {
  if (input.fromLocationId === input.toLocationId) throw validationError('Choose two different stores', { toLocationId: 'Must differ from the sending store' });
  const lines = await variantLines(db, input.organizationId, input.lines);
  return db.transaction(async (tx) => {
    const number = `TR-${await nextNumber(tx, input.organizationId, 'transfer')}`;
    const [t] = await tx.insert(stockTransfers).values({
      organizationId: input.organizationId, number, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, status: 'requested', reason: input.reason ?? null, requestedBy: input.by,
      lines: lines.map((l) => ({ ...l, shipped: 0, received: 0 })), history: [historyEntry('requested', input.by, input.reason ?? undefined)],
    }).returning();
    await audit(tx, { organizationId: input.organizationId, actorUserId: input.by, action: 'transfer.requested', scopeKind: 'location', scopeId: input.fromLocationId, targetType: 'stock_transfer', targetId: t!.id, metadata: { number, to: input.toLocationId } });
    return t!;
  });
}

export async function decideTransfer(db: Exec, t: Transfer, decision: 'approve' | 'reject', by: string, note?: string) {
  if (t.status !== 'requested') throw conflict('invalid_transition', `This transfer is ${t.status}`);
  if (decision === 'reject' && !note) throw validationError('Say why the transfer is rejected', { note: 'Required when rejecting' });
  const [u] = await db.update(stockTransfers).set({ status: decision === 'approve' ? 'approved' : 'rejected', approvedBy: by, decisionNote: note ?? null, history: [...t.history, historyEntry(decision === 'approve' ? 'approved' : 'rejected', by, note)], updatedAt: new Date() })
    .where(and(eq(stockTransfers.id, t.id), eq(stockTransfers.status, 'requested'))).returning();
  if (!u) throw conflict('already_decided', 'This transfer was already decided');
  await audit(db, { organizationId: t.organizationId, actorUserId: by, action: `transfer.${decision === 'approve' ? 'approved' : 'rejected'}`, scopeKind: 'location', scopeId: t.fromLocationId, targetType: 'stock_transfer', targetId: t.id, metadata: { note } });
  return u;
}

/** Ship: units leave the sending store (transfer_out) and are in transit until received. */
export async function shipTransfer(s: Services, transferId: string, input: { lines?: Array<{ variantId: string; quantity: number }>; carrier?: string; trackingNumber?: string }, by: string) {
  return s.db.transaction(async (tx) => {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).for('update');
    if (!t) throw notFound('Transfer');
    if (t.status !== 'approved') throw conflict('invalid_transition', t.status === 'requested' ? 'This transfer needs approval before it ships' : `This transfer is ${t.status}`);
    const ctx = { organizationId: t.organizationId, locationId: t.fromLocationId, reference: t.number, createdBy: by };
    const lines: TransferLine[] = [];
    for (const l of [...t.lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      const want = input.lines ? input.lines.find((x) => x.variantId === l.variantId)?.quantity ?? 0 : l.quantity;
      if (want < 0 || want > l.quantity) throw validationError(`${l.name}: ship between 0 and ${l.quantity}`, { [`lines.${l.variantId}`]: 'Invalid quantity' });
      if (want > 0) {
        if (t.orderId) {
          // Units were held for the customer at the sending store.
          await releaseHeld(tx, { ...ctx, reference: t.orderId, note: `Shipped on ${t.number}` }, [{ variantId: l.variantId, quantity: want }]);
        } else {
          const lv = await lockStock(tx, t.organizationId, t.fromLocationId, l.variantId);
          if (availableOf(lv) < want) throw conflict('insufficient_stock', `${l.name}: only ${Math.max(0, availableOf(lv))} available to ship (reserved units stay for customers)`, { variantId: l.variantId });
        }
        await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: -want, reason: 'transfer_out', note: `Shipped on ${t.number}` });
      }
      lines.push({ ...l, shipped: want });
    }
    if (!lines.some((l) => l.shipped > 0)) throw validationError('Ship at least one unit', { lines: 'Nothing to ship' });
    const ordered = t.lines.map((l) => lines.find((x) => x.variantId === l.variantId)!);
    const [u] = await tx.update(stockTransfers).set({ status: 'in_transit', lines: ordered, shippedBy: by, shippedAt: new Date(), carrier: input.carrier ?? null, trackingNumber: input.trackingNumber ?? null, history: [...t.history, historyEntry('shipped', by, `${ordered.reduce((a, l) => a + l.shipped, 0)} unit(s)`)], updatedAt: new Date() }).where(eq(stockTransfers.id, t.id)).returning();
    await audit(tx, { organizationId: t.organizationId, actorUserId: by, action: 'transfer.shipped', scopeKind: 'location', scopeId: t.fromLocationId, targetType: 'stock_transfer', targetId: t.id });
    if (t.orderId) await refreshFulfilmentStatus(tx, t.orderId, by, 'transfer_shipped');
    return u!;
  });
}

/** Receive: units arrive (transfer_in). A shortfall is recorded as a transit loss — never added to stock. */
export async function receiveTransfer(s: Services, transferId: string, input: { lines?: Array<{ variantId: string; quantity: number }>; note?: string }, by: string) {
  return s.db.transaction(async (tx) => {
    const [t] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, transferId)).for('update');
    if (!t) throw notFound('Transfer');
    if (t.status !== 'in_transit') throw conflict('invalid_transition', `This transfer is ${t.status}`);
    const ctx = { organizationId: t.organizationId, locationId: t.toLocationId, reference: t.number, createdBy: by };
    const lines: TransferLine[] = [];
    let short = 0;
    for (const l of [...t.lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      const got = input.lines ? input.lines.find((x) => x.variantId === l.variantId)?.quantity ?? 0 : l.shipped;
      if (got < 0 || got > l.shipped) throw validationError(`${l.name}: receive between 0 and ${l.shipped}`, { [`lines.${l.variantId}`]: 'Invalid quantity' });
      if (got > 0) await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: got, reason: 'transfer_in', note: `Received on ${t.number}` });
      short += l.shipped - got;
      lines.push({ ...l, received: got });
    }
    const ordered = t.lines.map((l) => lines.find((x) => x.variantId === l.variantId)!);
    if (t.orderId) {
      // Hold the arrived units for the customer at the collection store until collection.
      await reserveLines(tx, { ...ctx, reference: t.orderId, note: `Held for collection (${t.number})` }, ordered.filter((l) => l.received > 0).map((l) => ({ variantId: l.variantId, quantity: l.received })), () => false);
    }
    const note = [input.note, short ? `${short} unit(s) missing on arrival — recorded as transit loss` : null].filter(Boolean).join(' · ') || undefined;
    const [u] = await tx.update(stockTransfers).set({ status: 'received', lines: ordered, receivedBy: by, receivedAt: new Date(), receiveNote: note ?? null, history: [...t.history, historyEntry('received', by, note)], updatedAt: new Date() }).where(eq(stockTransfers.id, t.id)).returning();
    await audit(tx, { organizationId: t.organizationId, actorUserId: by, action: 'transfer.received', scopeKind: 'location', scopeId: t.toLocationId, targetType: 'stock_transfer', targetId: t.id, metadata: { short } });
    if (t.orderId) await refreshFulfilmentStatus(tx, t.orderId, by, 'transfer_received');
    return u!;
  });
}

export async function cancelTransfer(db: Exec, t: Transfer, by: string, note?: string) {
  if (!['requested', 'approved'].includes(t.status)) throw conflict('invalid_transition', `A ${t.status} transfer cannot be cancelled`);
  if (t.orderId) throw conflict('order_transfer', 'This transfer serves a customer order; resolve the order instead');
  const [u] = await db.update(stockTransfers).set({ status: 'cancelled', history: [...t.history, historyEntry('cancelled', by, note)], updatedAt: new Date() }).where(eq(stockTransfers.id, t.id)).returning();
  return u!;
}

export function serializeTransfer(t: Transfer, names: Map<string, { name: string; timeZone: string }>) {
  return {
    ...t, fromLocationName: names.get(t.fromLocationId)?.name ?? null, toLocationName: names.get(t.toLocationId)?.name ?? null,
    totals: { requested: t.lines.reduce((a, l) => a + l.quantity, 0), shipped: t.lines.reduce((a, l) => a + l.shipped, 0), received: t.lines.reduce((a, l) => a + l.received, 0), inTransit: t.status === 'in_transit' ? t.lines.reduce((a, l) => a + l.shipped - l.received, 0) : 0 },
    createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), shippedAt: t.shippedAt?.toISOString() ?? null, receivedAt: t.receivedAt?.toISOString() ?? null,
  };
}

// ───────── Cycle counts ─────────

export async function createCount(db: Exec, loc: typeof locations.$inferSelect, input: { name: string; variantIds?: string[] }, by: string) {
  const ids = input.variantIds?.length ? input.variantIds : (await db.select({ id: locationVariants.variantId }).from(locationVariants).where(eq(locationVariants.locationId, loc.id))).map((r) => r.id);
  if (!ids.length) throw validationError('Nothing to count at this store yet', { variantIds: 'Choose items' });
  const known = await db.select({ id: variants.id }).from(variants).where(and(eq(variants.organizationId, loc.organizationId), inArray(variants.id, ids)));
  if (known.length !== new Set(ids).size) throw validationError('Unknown item in the count', { variantIds: 'Choose items of this organisation' });
  return db.transaction(async (tx) => {
    const [c] = await tx.insert(stockCounts).values({ organizationId: loc.organizationId, locationId: loc.id, name: input.name, createdBy: by }).returning();
    await tx.insert(stockCountLines).values([...new Set(ids)].map((variantId) => ({ countId: c!.id, variantId })));
    return c!;
  });
}

/** Record counted quantities; the ledger's on-hand at that moment is kept as the expected quantity. */
export async function recordCounts(db: Exec, count: typeof stockCounts.$inferSelect, entries: Array<{ variantId: string; countedQty: number }>, by: string) {
  if (count.status !== 'in_progress') throw conflict('count_closed', `This count is ${count.status}`);
  const lvs = await db.select().from(locationVariants).where(and(eq(locationVariants.locationId, count.locationId), inArray(locationVariants.variantId, entries.map((e) => e.variantId))));
  for (const e of entries) {
    if (!Number.isInteger(e.countedQty) || e.countedQty < 0) throw validationError('Counted quantity must be 0 or more', { [`entries.${e.variantId}`]: 'Invalid' });
    const expected = lvs.find((x) => x.variantId === e.variantId)?.stockOnHand ?? 0;
    const [u] = await db.update(stockCountLines).set({ countedQty: e.countedQty, expectedQty: expected, countedBy: by, countedAt: new Date() })
      .where(and(eq(stockCountLines.countId, count.id), eq(stockCountLines.variantId, e.variantId))).returning();
    if (!u) throw validationError('That item is not part of this count', { [`entries.${e.variantId}`]: 'Not in count' });
  }
}

/** Apply a submitted count: one `count` movement per variance (counted − expected at count time). */
export async function applyCount(s: Services, countId: string, by: string) {
  return s.db.transaction(async (tx) => {
    const [c] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).for('update');
    if (!c) throw notFound('Count');
    if (c.status !== 'submitted') throw conflict('invalid_transition', c.status === 'in_progress' ? 'Submit the count before applying it' : `This count is ${c.status}`);
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, c.id));
    let adjusted = 0;
    let unitsVariance = 0;
    for (const l of lines.sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      if (l.countedQty === null || l.expectedQty === null) continue;
      const variance = l.countedQty - l.expectedQty;
      if (variance === 0) continue;
      await applyMovement(tx, { organizationId: c.organizationId, locationId: c.locationId, variantId: l.variantId, quantity: variance, reason: 'count', reference: `COUNT-${c.id.slice(0, 8)}`, note: `${c.name}: counted ${l.countedQty}, expected ${l.expectedQty}`, createdBy: by }, { allowNegative: true });
      adjusted++;
      unitsVariance += variance;
    }
    const [u] = await tx.update(stockCounts).set({ status: 'applied', appliedBy: by, appliedAt: new Date() }).where(eq(stockCounts.id, c.id)).returning();
    await audit(tx, { organizationId: c.organizationId, actorUserId: by, action: 'stock_count.applied', scopeKind: 'location', scopeId: c.locationId, targetType: 'stock_count', targetId: c.id, metadata: { adjusted, unitsVariance } });
    return { count: u!, adjusted, unitsVariance };
  });
}

// ───────── Purchasing ─────────

export async function createPurchaseOrder(db: Exec, input: { organizationId: string; locationId: string; supplierId: string; lines: Array<{ variantId: string; quantity: number; unitCostMinor: number }>; expectedAt?: string | null; notes?: string | null; by: string }) {
  const [sup] = await db.select().from(suppliers).where(and(eq(suppliers.id, input.supplierId), eq(suppliers.organizationId, input.organizationId)));
  if (!sup) throw validationError('Choose a supplier', { supplierId: 'Not found' });
  const base = await variantLines(db, input.organizationId, input.lines);
  input.lines.forEach((l, i) => { if (!Number.isInteger(l.unitCostMinor) || l.unitCostMinor < 0) throw validationError('Unit cost must be 0 or more (minor units)', { [`lines.${i}.unitCostMinor`]: 'Invalid' }); });
  return db.transaction(async (tx) => {
    const number = `PO-${await nextNumber(tx, input.organizationId, 'po', 2400)}`;
    const [po] = await tx.insert(purchaseOrders).values({
      organizationId: input.organizationId, locationId: input.locationId, supplierId: sup.id, number, status: 'draft', currency: sup.currency,
      lines: base.map((l, i) => ({ ...l, received: 0, unitCostMinor: input.lines[i]!.unitCostMinor })), expectedAt: input.expectedAt ? new Date(input.expectedAt) : null, notes: input.notes ?? null, createdBy: input.by,
    }).returning();
    await audit(tx, { organizationId: input.organizationId, actorUserId: input.by, action: 'purchase_order.created', scopeKind: 'location', scopeId: input.locationId, targetType: 'purchase_order', targetId: po!.id, metadata: { number } });
    return po!;
  });
}

export async function receivePurchaseOrder(s: Services, poId: string, input: { lines?: Array<{ variantId: string; quantity: number }> }, by: string) {
  return s.db.transaction(async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update');
    if (!po) throw notFound('Purchase order');
    if (!['sent', 'partially_received'].includes(po.status)) throw conflict('invalid_transition', po.status === 'draft' ? 'Mark the purchase order as sent before receiving' : `This purchase order is ${po.status}`);
    const lines: PurchaseOrderLine[] = [];
    let units = 0;
    for (const l of po.lines) {
      const open = l.quantity - l.received;
      const got = input.lines ? input.lines.find((x) => x.variantId === l.variantId)?.quantity ?? 0 : open;
      if (got < 0 || got > open) throw validationError(`${l.name}: receive between 0 and ${open}`, { [`lines.${l.variantId}`]: 'Invalid quantity' });
      if (got > 0) await applyMovement(tx, { organizationId: po.organizationId, locationId: po.locationId, variantId: l.variantId, quantity: got, reason: 'received', reference: po.number, note: `Received against ${po.number}`, createdBy: by });
      units += got;
      lines.push({ ...l, received: l.received + got });
    }
    if (!units) throw validationError('Receive at least one unit', { lines: 'Nothing received' });
    const done = lines.every((l) => l.received >= l.quantity);
    const [u] = await tx.update(purchaseOrders).set({ lines, status: done ? 'received' : 'partially_received', receivedAt: done ? new Date() : po.receivedAt, updatedAt: new Date() }).where(eq(purchaseOrders.id, po.id)).returning();
    await audit(tx, { organizationId: po.organizationId, actorUserId: by, action: 'purchase_order.received', scopeKind: 'location', scopeId: po.locationId, targetType: 'purchase_order', targetId: po.id, metadata: { units } });
    const waiting = await backorderDemand(tx, po.organizationId, po.locationId, lines.map((l) => l.variantId));
    return { purchaseOrder: u!, unitsReceived: units, backordersWaiting: waiting };
  });
}

/** Paid orders at a store with backordered units of these variants. */
export async function backorderDemand(db: Exec, organizationId: string, locationId: string | null, variantIds?: string[]) {
  const conds = [eq(orders.organizationId, organizationId), inArray(orders.paymentStatus, ['paid', 'partially_refunded']), ne(orders.status, 'cancelled'), sql`exists (select 1 from jsonb_array_elements(${orders.lines}) x where coalesce((x->>'backordered')::int, 0) > 0)`];
  if (locationId) conds.push(eq(orders.locationId, locationId));
  const rows = await db.select().from(orders).where(and(...conds)).orderBy(asc(orders.createdAt)).limit(200);
  return rows.flatMap((o) => o.lines.filter((l) => (l.backordered ?? 0) > 0 && (!variantIds || variantIds.includes(l.variantId))).map((l) => ({ orderId: o.id, orderNumber: o.orderNumber, locationId: o.locationId, variantId: l.variantId, sku: l.sku, name: l.name, backordered: l.backordered! })));
}

// ───────── Reorder alerts ─────────

export async function reorderAlerts(db: Exec, organizationId: string, allowed: 'all' | Set<string>) {
  const rows = await db.select({ lv: locationVariants, v: variants, p: { name: products.name }, l: { name: locations.name, currency: locations.currency } })
    .from(locationVariants).innerJoin(variants, eq(variants.id, locationVariants.variantId)).innerJoin(products, eq(products.id, variants.productId)).innerJoin(locations, eq(locations.id, locationVariants.locationId))
    .where(and(eq(locationVariants.organizationId, organizationId), sql`${locationVariants.reorderPoint} is not null`, sql`${locationVariants.stockOnHand} - ${locationVariants.reserved} <= ${locationVariants.reorderPoint}`));
  const scoped = rows.filter((r) => allowed === 'all' || allowed.has(r.lv.locationId));
  const openPos = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.organizationId, organizationId), inArray(purchaseOrders.status, ['draft', 'sent', 'partially_received'])));
  const transit = await db.select().from(stockTransfers).where(and(eq(stockTransfers.organizationId, organizationId), inArray(stockTransfers.status, ['approved', 'in_transit'])));
  const demand = await backorderDemand(db, organizationId, null);
  return scoped.map(({ lv, v, p, l }) => {
    const available = availableOf(lv);
    const onOrder = openPos.filter((po) => po.locationId === lv.locationId).reduce((a, po) => a + po.lines.filter((x) => x.variantId === v.id).reduce((b, x) => b + x.quantity - x.received, 0), 0);
    const incoming = transit.filter((t) => t.toLocationId === lv.locationId).reduce((a, t) => a + t.lines.filter((x) => x.variantId === v.id).reduce((b, x) => b + (t.status === 'in_transit' ? x.shipped - x.received : x.quantity), 0), 0);
    const backordered = demand.filter((d) => d.locationId === lv.locationId && d.variantId === v.id).reduce((a, d) => a + d.backordered, 0);
    const target = lv.reorderQty ?? Math.max(1, lv.reorderPoint! * 2 - available);
    return {
      locationId: lv.locationId, locationName: l.name, variantId: v.id, sku: v.sku, name: `${p.name} — ${v.name}`, onHand: lv.stockOnHand, reserved: lv.reserved, available,
      reorderPoint: lv.reorderPoint, onOrder, incoming, backordered, suggestedQty: Math.max(0, target + backordered - onOrder - incoming),
      severity: available <= 0 ? 'out' as const : 'low' as const,
    };
  }).sort((a, b) => a.available - b.available);
}

export async function latestCounts(db: Exec, organizationId: string, allowed: 'all' | Set<string>) {
  const rows = await db.select().from(stockCounts).where(eq(stockCounts.organizationId, organizationId)).orderBy(desc(stockCounts.createdAt)).limit(100);
  return rows.filter((r) => allowed === 'all' || allowed.has(r.locationId));
}
