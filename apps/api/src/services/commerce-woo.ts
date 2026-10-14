import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { minorUnitExponent, type Currency } from '@bh/shared';
import type { Services } from '../context.ts';
import { connections, externalMappings, locationListings, locations, orders, syncRuns, variants, type OrderLine } from '../db/schema/index.ts';
import { audit } from './audit.ts';
import { applyMovement, historyEntry } from './commerce-stock.ts';
import { credentialsOf } from './connections.ts';

type Connection = typeof connections.$inferSelect;

/** The subset of a WooCommerce REST v3 order that BranchHarbor reads. */
export interface WooOrder {
  id: number | string;
  number?: string;
  status: string;
  currency: string;
  date_created_gmt?: string;
  total: string;
  total_tax?: string;
  shipping_total?: string;
  discount_total?: string;
  billing?: { first_name?: string; last_name?: string; email?: string; phone?: string };
  line_items: Array<{ id?: number; name: string; sku?: string; quantity: number; price: number | string }>;
  refunds?: Array<{ id?: number; total: string }>;
}

const toMinor = (v: string | number | undefined, currency: string) => Math.round(Number(v ?? 0) * 10 ** minorUnitExponent(currency as Currency));

/** WooCommerce status → BranchHarbor states. WooCommerce stays authoritative: we only mirror. */
export function mapWooStatus(status: string) {
  switch (status) {
    case 'processing': return { status: 'paid', paymentStatus: 'external', fulfilmentStatus: 'unfulfilled', paid: true };
    case 'completed': return { status: 'fulfilled', paymentStatus: 'external', fulfilmentStatus: 'fulfilled', paid: true };
    case 'refunded': return { status: 'refunded', paymentStatus: 'refunded', fulfilmentStatus: 'fulfilled', paid: true };
    case 'cancelled': case 'failed': case 'trash': return { status: 'cancelled', paymentStatus: 'failed', fulfilmentStatus: 'cancelled', paid: false };
    default: return { status: 'pending_payment', paymentStatus: 'pending', fulfilmentStatus: 'unfulfilled', paid: false }; // pending, on-hold
  }
}

export type IngestOutcome = { outcome: 'created' | 'updated' | 'unchanged' | 'error'; orderId: string | null; error?: string };

/**
 * Upsert one external order. Idempotent: the (organisation, source, external id) unique key means retries and duplicate
 * webhook deliveries never create a second order, and stock is applied at most once (stock_applied_at).
 */
export async function ingestWooOrder(s: Services, conn: Connection, raw: WooOrder): Promise<IngestOutcome> {
  const externalId = String(raw.id);
  const locationId = conn.locationId ?? (typeof conn.config.locationId === 'string' ? conn.config.locationId : null);
  const fail = async (error: string): Promise<IngestOutcome> => {
    const values = { organizationId: conn.organizationId, connectionId: conn.id, entityType: 'order', externalId, internalId: null, status: 'error', error, externalData: { number: raw.number ?? externalId, status: raw.status, currency: raw.currency }, updatedAt: new Date() };
    await s.db.insert(externalMappings).values(values).onConflictDoUpdate({ target: [externalMappings.connectionId, externalMappings.entityType, externalMappings.externalId], set: values });
    return { outcome: 'error', orderId: null, error };
  };
  if (!locationId) return fail('Map this WooCommerce connection to a store before importing orders');
  const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, conn.organizationId)));
  if (!loc) return fail('The mapped store no longer exists');
  const currency = String(raw.currency ?? '').toUpperCase();
  if (currency !== loc.currency) return fail(`Order is in ${currency || 'an unknown currency'} but ${loc.name} sells in ${loc.currency}; not imported`);

  const skus = [...new Set(raw.line_items.map((l) => l.sku).filter((x): x is string => !!x))];
  const vs = skus.length ? await s.db.select().from(variants).where(and(eq(variants.organizationId, conn.organizationId), inArray(variants.sku, skus))) : [];
  const lines: OrderLine[] = raw.line_items.map((l) => {
    const v = vs.find((x) => x.sku === l.sku);
    return { variantId: v?.id ?? '', sku: l.sku ?? '', name: l.name, quantity: l.quantity, unitPriceMinor: toMinor(l.price, currency), productId: v?.productId, unmapped: !v };
  });
  for (const l of lines.filter((x) => x.unmapped)) {
    const values = { organizationId: conn.organizationId, connectionId: conn.id, entityType: 'variant', externalId: l.sku || `${externalId}:${l.name}`, internalId: null, status: 'error', error: `No BranchHarbor variant with SKU "${l.sku || '(none)'}" — order line imported without stock effect`, externalData: { name: l.name, sku: l.sku }, updatedAt: new Date() };
    await s.db.insert(externalMappings).values(values).onConflictDoUpdate({ target: [externalMappings.connectionId, externalMappings.entityType, externalMappings.externalId], set: values });
  }
  const st = mapWooStatus(raw.status);
  const total = toMinor(raw.total, currency);
  const tax = toMinor(raw.total_tax, currency);
  const ship = toMinor(raw.shipping_total, currency);
  const discount = toMinor(raw.discount_total, currency);
  const refunded = Math.min(total, (raw.refunds ?? []).reduce((a, r) => a + Math.abs(toMinor(r.total, currency)), 0));
  const subtotal = lines.reduce((a, l) => a + l.unitPriceMinor * l.quantity, 0);
  const name = [raw.billing?.first_name, raw.billing?.last_name].filter(Boolean).join(' ') || null;
  const status = refunded > 0 && refunded < total && st.paid && st.status !== 'refunded' ? 'partially_refunded' : st.status;

  const res = await s.db.transaction(async (tx) => {
    let [o] = await tx.select().from(orders).where(and(eq(orders.organizationId, conn.organizationId), eq(orders.source, 'woocommerce'), eq(orders.externalId, externalId))).for('update');
    let outcome: IngestOutcome['outcome'] = 'unchanged';
    if (!o) {
      const [ins] = await tx.insert(orders).values({
        organizationId: conn.organizationId, locationId: loc.id, source: 'woocommerce', externalId, orderNumber: `WC-${raw.number ?? externalId}`, status, paymentStatus: st.paymentStatus,
        fulfilmentStatus: st.fulfilmentStatus, fulfilmentMethod: ship > 0 ? 'shipping' : 'pickup', currency, subtotalMinor: subtotal, taxMinor: tax, discountMinor: discount,
        fulfilmentFeeMinor: ship, totalMinor: total, refundedMinor: refunded, lines, externalStatus: raw.status, customerName: name, customerEmail: raw.billing?.email?.toLowerCase() ?? null,
        customerPhone: raw.billing?.phone ?? null, createdAt: raw.date_created_gmt ? new Date(`${raw.date_created_gmt.replace(/Z?$/, 'Z')}`) : new Date(),
        paidAt: st.paid ? new Date() : null, history: [historyEntry('imported', null, `From WooCommerce (${raw.status})`)],
      }).onConflictDoNothing().returning();
      if (ins) { o = ins; outcome = 'created'; }
      else [o] = await tx.select().from(orders).where(and(eq(orders.organizationId, conn.organizationId), eq(orders.source, 'woocommerce'), eq(orders.externalId, externalId))).for('update');
    }
    if (!o) throw new Error('order upsert failed');
    if (outcome !== 'created' && (o.externalStatus !== raw.status || o.refundedMinor !== refunded || o.totalMinor !== total)) {
      [o] = await tx.update(orders).set({ status, paymentStatus: st.paymentStatus, fulfilmentStatus: st.fulfilmentStatus, externalStatus: raw.status, refundedMinor: refunded, totalMinor: total, taxMinor: tax, history: [...o.history, historyEntry('external_update', null, `WooCommerce status ${o.externalStatus} → ${raw.status}`)], updatedAt: new Date() }).where(eq(orders.id, o.id)).returning() as [typeof o];
      outcome = 'updated';
    }
    // Stock mirrors the authoritative order exactly once.
    const mapped = o!.lines.filter((l) => !l.unmapped && l.variantId);
    if (st.paid && !o!.stockAppliedAt && mapped.length) {
      for (const l of mapped) await applyMovement(tx, { organizationId: o!.organizationId, locationId: o!.locationId, variantId: l.variantId, quantity: -l.quantity, reason: 'sale', reference: o!.id, note: `WooCommerce order ${o!.orderNumber}` }, { allowNegative: true });
      await tx.update(orders).set({ stockAppliedAt: new Date() }).where(eq(orders.id, o!.id));
    } else if (!st.paid && st.status === 'cancelled' && o!.stockAppliedAt) {
      for (const l of mapped) await applyMovement(tx, { organizationId: o!.organizationId, locationId: o!.locationId, variantId: l.variantId, quantity: l.quantity, reason: 'return', reference: o!.id, note: `WooCommerce order ${o!.orderNumber} cancelled — restocked` });
      await tx.update(orders).set({ stockAppliedAt: null }).where(eq(orders.id, o!.id));
    }
    const mv = { organizationId: conn.organizationId, connectionId: conn.id, entityType: 'order', externalId, internalId: o!.id, status: 'mapped', error: null, externalData: { number: raw.number ?? externalId, status: raw.status }, updatedAt: new Date() };
    await tx.insert(externalMappings).values(mv).onConflictDoUpdate({ target: [externalMappings.connectionId, externalMappings.entityType, externalMappings.externalId], set: mv });
    if (outcome !== 'unchanged') await audit(tx, { organizationId: conn.organizationId, actorUserId: null, actorType: 'system', action: `order.external_${outcome}`, scopeKind: 'location', scopeId: loc.id, targetType: 'order', targetId: o!.id, metadata: { provider: 'woocommerce', externalId, status: raw.status } });
    return { outcome, orderId: o!.id };
  });
  return res;
}

/** Sandbox sample: deterministic orders from the store's listed SKUs (plus one unknown SKU to exercise mapping errors). */
async function sandboxOrders(s: Services, conn: Connection): Promise<WooOrder[]> {
  const locationId = conn.locationId;
  if (!locationId) return [];
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, locationId));
  const listed = await s.db.select().from(locationListings).where(and(eq(locationListings.locationId, locationId), eq(locationListings.status, 'listed')));
  const vIds = listed.flatMap((l) => l.snapshot.variants.map((v) => v.id)).slice(0, 6);
  const vs = vIds.length ? await s.db.select().from(variants).where(inArray(variants.id, vIds)) : [];
  if (!loc || vs.length < 2) return [];
  const price = (i: number) => ((vs[i]!.prices[loc.currency] ?? 1000) / 100).toFixed(2);
  const total = (items: Array<[number, number]>) => items.reduce((a, [i, q]) => a + Number(price(i)) * q, 0).toFixed(2);
  return [
    { id: 5001, number: '5001', status: 'processing', currency: loc.currency, total: total([[0, 1], [1, 2]]), billing: { first_name: 'Robin', last_name: 'Hale', email: 'robin.hale@example.com' }, line_items: [{ name: vs[0]!.name, sku: vs[0]!.sku, quantity: 1, price: price(0) }, { name: vs[1]!.name, sku: vs[1]!.sku, quantity: 2, price: price(1) }] },
    { id: 5002, number: '5002', status: 'completed', currency: loc.currency, total: total([[1, 1]]), billing: { first_name: 'Ana', last_name: 'Silva', email: 'ana.silva@example.com' }, line_items: [{ name: vs[1]!.name, sku: vs[1]!.sku, quantity: 1, price: price(1) }] },
    { id: 5003, number: '5003', status: 'on-hold', currency: loc.currency, total: '12.00', billing: { first_name: 'Kai', email: 'kai@example.com' }, line_items: [{ name: 'Gift wrap (WooCommerce only)', sku: 'WC-WRAP', quantity: 1, price: '12.00' }] },
  ];
}

/** Pull recent orders from WooCommerce (or sandbox sample data) and ingest them idempotently. */
export async function syncWooOrders(s: Services, conn: Connection) {
  const [run] = await s.db.insert(syncRuns).values({ organizationId: conn.organizationId, connectionId: conn.id, status: 'running', startedAt: new Date() }).returning();
  const site = String(conn.config.siteUrl ?? '');
  const creds = credentialsOf(s, conn);
  const key = creds?.consumerKey ?? s.cfg.WOOCOMMERCE_CONSUMER_KEY;
  const secret = creds?.consumerSecret ?? s.cfg.WOOCOMMERCE_CONSUMER_SECRET;
  let items: WooOrder[];
  let sandbox = false;
  try {
    if (site.startsWith('https://') && key && secret) {
      const auth = Buffer.from(`${key}:${secret}`).toString('base64');
      const since = typeof conn.syncCursor?.ordersModifiedAfter === 'string' ? `&modified_after=${encodeURIComponent(conn.syncCursor.ordersModifiedAfter)}` : '';
      const res = await fetch(`${site.replace(/\/$/, '')}/wp-json/wc/v3/orders?per_page=50&orderby=modified&order=asc${since}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`WooCommerce returned ${res.status}`);
      items = (await res.json()) as WooOrder[];
    } else {
      sandbox = true;
      items = await sandboxOrders(s, conn);
    }
  } catch (err) {
    const msg = (err as Error).message;
    await s.db.update(syncRuns).set({ status: 'failed', error: msg, finishedAt: new Date() }).where(eq(syncRuns.id, run!.id));
    await s.db.update(connections).set({ state: 'degraded', lastError: msg, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(connections.id, conn.id));
    return { run: run!.id, sandbox, created: 0, updated: 0, unchanged: 0, errors: [{ externalId: null, error: msg }] };
  }
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const errors: Array<{ externalId: string | null; error: string }> = [];
  for (const o of items) {
    try {
      const r = await ingestWooOrder(s, conn, o);
      if (r.outcome === 'error') errors.push({ externalId: String(o.id), error: r.error! });
      else counts[r.outcome]++;
    } catch (err) {
      errors.push({ externalId: String(o.id), error: (err as Error).message });
    }
  }
  const now = new Date();
  await s.db.update(syncRuns).set({ status: errors.length ? 'partial' : 'succeeded', recordsProcessed: items.length, recordsFailed: errors.length, finishedAt: now }).where(eq(syncRuns.id, run!.id));
  await s.db.update(connections).set({ state: errors.length ? 'degraded' : 'connected', lastSuccessAt: now, lastError: errors.length ? `${errors.length} order(s) need attention` : null, lastErrorAt: errors.length ? now : conn.lastErrorAt, syncCursor: { ...(conn.syncCursor ?? {}), ordersModifiedAfter: now.toISOString() }, updatedAt: now }).where(eq(connections.id, conn.id));
  return { run: run!.id, sandbox, ...counts, errors };
}

/** WooCommerce webhook signature: base64(HMAC-SHA256(raw body, webhook secret)). */
export function verifyWooSignature(raw: Buffer, signature: string | undefined, secret: string) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
