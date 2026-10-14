import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { commerceCounters, locationVariants, products, stockMovements, variants } from '../db/schema/index.ts';
import { conflict } from '../lib/errors.ts';

/**
 * Inventory ledger primitives for the full commerce product. Every number is explained by a stock movement:
 * physical movements (received, sale, return, damage, count, transfer_in/out, adjustment, shrinkage, found,
 * correction, supplier_return) change on-hand; `reservation`/`release` only change the held quantity.
 * Callers run these inside a transaction and lock rows through `lockStock` in a stable order.
 */
export const PHYSICAL_ADJUSTMENT_REASONS = ['adjustment', 'damage', 'shrinkage', 'found', 'correction', 'received', 'supplier_return', 'return', 'count', 'transfer_in', 'transfer_out'] as const;

export type LvRow = typeof locationVariants.$inferSelect;

export interface MovementInput {
  organizationId: string;
  locationId: string;
  variantId: string;
  quantity: number;
  reason: string;
  reference?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/** Ensure the location/variant row exists and lock it (SELECT … FOR UPDATE). */
export async function lockStock(tx: Exec, organizationId: string, locationId: string, variantId: string): Promise<LvRow> {
  await tx.insert(locationVariants).values({ organizationId, locationId, variantId }).onConflictDoNothing();
  const [lv] = await tx.select().from(locationVariants).where(and(eq(locationVariants.locationId, locationId), eq(locationVariants.variantId, variantId))).for('update');
  return lv!;
}

/** Record a movement and update the cached counters. Returns the updated row. */
export async function applyMovement(tx: Exec, m: MovementInput, opts: { allowNegative?: boolean } = {}): Promise<LvRow> {
  if (m.quantity === 0) throw conflict('zero_quantity', 'A stock movement needs a non-zero quantity');
  const lv = await lockStock(tx, m.organizationId, m.locationId, m.variantId);
  const reservation = m.reason === 'reservation' || m.reason === 'release';
  if (!reservation && !opts.allowNegative && lv.stockOnHand + m.quantity < 0) {
    throw conflict('insufficient_stock', `Only ${lv.stockOnHand} on hand`, { variantId: m.variantId, locationId: m.locationId, onHand: lv.stockOnHand });
  }
  await tx.insert(stockMovements).values({
    organizationId: m.organizationId, locationId: m.locationId, variantId: m.variantId, quantity: m.quantity, reason: m.reason,
    reference: m.reference ?? null, note: m.note ?? null, createdBy: m.createdBy ?? null,
  });
  const set = reservation
    ? { reserved: Math.max(0, lv.reserved - m.quantity), updatedAt: new Date() }
    : { stockOnHand: lv.stockOnHand + m.quantity, updatedAt: new Date() };
  const [u] = await tx.update(locationVariants).set(set).where(eq(locationVariants.id, lv.id)).returning();
  return u!;
}

export const availableOf = (lv: Pick<LvRow, 'stockOnHand' | 'reserved'>) => lv.stockOnHand - lv.reserved;

export interface ReserveLine { variantId: string; quantity: number }
export interface Allocation { variantId: string; quantity: number; allocated: number; backordered: number }

/**
 * Hold stock for an order. Rows are locked in variant-id order so concurrent checkouts serialise per item:
 * the second buyer of the last unit sees it held and gets `out_of_stock` (or a backorder when permitted).
 */
export async function reserveLines(
  tx: Exec,
  ctx: { organizationId: string; locationId: string; reference: string; createdBy?: string | null; note?: string },
  lines: ReserveLine[],
  backorderAllowed: (variantId: string, lv: LvRow) => boolean,
): Promise<Allocation[]> {
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
  const out = new Map<string, Allocation>();
  for (const variantId of [...merged.keys()].sort()) {
    const qty = merged.get(variantId)!;
    const lv = await lockStock(tx, ctx.organizationId, ctx.locationId, variantId);
    if (!lv.available) throw conflict('not_available', 'This item is not available at this store', { variantId });
    const free = Math.max(0, availableOf(lv));
    const allocated = Math.min(qty, free);
    const backordered = qty - allocated;
    if (backordered > 0 && !backorderAllowed(variantId, lv)) {
      throw conflict('out_of_stock', free > 0 ? `Only ${free} left at this store` : 'Out of stock at this store', { variantId, available: free });
    }
    if (allocated > 0) await applyMovement(tx, { organizationId: ctx.organizationId, locationId: ctx.locationId, variantId, quantity: -allocated, reason: 'reservation', reference: ctx.reference, createdBy: ctx.createdBy, note: ctx.note });
    out.set(variantId, { variantId, quantity: qty, allocated, backordered });
  }
  return lines.map((l) => out.get(l.variantId)!);
}

/** Give held units back (expiry, cancellation, failed payment, shipping a transfer). */
export async function releaseHeld(tx: Exec, ctx: { organizationId: string; locationId: string; reference: string; createdBy?: string | null; note?: string }, lines: Array<{ variantId: string; quantity: number }>) {
  for (const l of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    if (l.quantity > 0) await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: l.quantity, reason: 'release' });
  }
}

/** Turn held units into a sale (on-hand goes down once). */
export async function sellHeld(tx: Exec, ctx: { organizationId: string; locationId: string; reference: string; createdBy?: string | null; note?: string }, lines: Array<{ variantId: string; quantity: number }>) {
  for (const l of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    if (l.quantity <= 0) continue;
    await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: l.quantity, reason: 'release' });
    await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: -l.quantity, reason: 'sale' }, { allowNegative: true });
  }
}

/** Whether backorders are allowed for a variant at a location (location override → product default). */
export async function backorderPolicy(db: Exec, variantIds: string[]): Promise<Map<string, boolean>> {
  if (!variantIds.length) return new Map();
  const rows = await db.select({ id: variants.id, allow: products.allowBackorder }).from(variants).innerJoin(products, eq(products.id, variants.productId))
    .where(inArray(variants.id, variantIds));
  return new Map(rows.map((r) => [r.id, r.allow]));
}

/** Next number in a per-organisation sequence, e.g. nextNumber(tx, org, 'order:FG-YUL') → 1001. */
export async function nextNumber(tx: Exec, organizationId: string, scope: string, start = 1000): Promise<number> {
  const [row] = await tx.insert(commerceCounters).values({ organizationId, scope, value: start + 1 })
    .onConflictDoUpdate({ target: [commerceCounters.organizationId, commerceCounters.scope], set: { value: sql`${commerceCounters.value} + 1` } })
    .returning();
  return row!.value;
}

export const historyEntry = (event: string, by?: string | null, note?: string) => ({ at: new Date().toISOString(), event, ...(by !== undefined ? { by } : {}), ...(note ? { note } : {}) });
