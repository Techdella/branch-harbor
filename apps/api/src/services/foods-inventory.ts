/**
 * Basic ingredient inventory: per-location stock in integer base units, recipes per menu item (and
 * modifier), depletion when an order is placed, reversal when it is cancelled/rejected, low-stock alerts
 * and optional automatic sold-out when an ingredient cannot cover one more portion.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Exec, Tx } from '../db/client.ts';
import { foodIngredientMovements, foodIngredients, foodIngredientStock, foodRecipeLines, foodSoldOutEvents, menuItems } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { recordSoldOut } from './foods-menu.ts';

type Line = { menuItemId: string; quantity: number; modifiers: Array<{ id: string }>; name: string };

/** Items/modifiers that cannot be made at this location because an auto-sold-out ingredient is short. */
export async function ingredientShortages(db: Exec, locationId: string, menuItemIds: string[]) {
  const shortItems = new Set<string>();
  const shortModifiers = new Set<string>();
  if (!menuItemIds.length) return { shortItems, shortModifiers };
  const recipe = await db.select().from(foodRecipeLines).where(inArray(foodRecipeLines.menuItemId, menuItemIds));
  if (!recipe.length) return { shortItems, shortModifiers };
  const stock = await db.select().from(foodIngredientStock).where(and(eq(foodIngredientStock.locationId, locationId), inArray(foodIngredientStock.ingredientId, [...new Set(recipe.map((r) => r.ingredientId))])));
  const byIng = new Map(stock.map((s) => [s.ingredientId, s]));
  for (const r of recipe) {
    const s = byIng.get(r.ingredientId);
    if (!s || !s.autoSoldOut || s.onHand >= r.quantity) continue;
    if (r.modifierId) shortModifiers.add(r.modifierId);
    else shortItems.add(r.menuItemId);
  }
  return { shortItems, shortModifiers };
}

/** Ingredient needs for a set of order lines (base recipe × quantity, plus chosen modifiers' additions). */
async function needsFor(db: Exec, lines: Line[]) {
  const itemIds = [...new Set(lines.map((l) => l.menuItemId))];
  if (!itemIds.length) return new Map<string, number>();
  const recipe = await db.select().from(foodRecipeLines).where(inArray(foodRecipeLines.menuItemId, itemIds));
  const need = new Map<string, number>();
  for (const l of lines) {
    const modIds = new Set(l.modifiers.map((m) => m.id));
    for (const r of recipe) {
      if (r.menuItemId !== l.menuItemId) continue;
      if (r.modifierId && !modIds.has(r.modifierId)) continue;
      need.set(r.ingredientId, (need.get(r.ingredientId) ?? 0) + r.quantity * l.quantity);
    }
  }
  return need;
}

/**
 * Deplete stock for a new order inside the order transaction. An auto-sold-out ingredient that cannot cover
 * the order refuses it (the customer sees the item as sold out); other tracked ingredients may go negative
 * (recorded, and visible as a count discrepancy) rather than blocking service.
 */
export async function depleteForOrder(tx: Tx, input: { organizationId: string; locationId: string; orderId: string; lines: Line[] }) {
  const need = await needsFor(tx, input.lines);
  if (!need.size) return { lowStock: [] as string[], exhausted: [] as string[] };
  const stock = await tx.select().from(foodIngredientStock)
    .where(and(eq(foodIngredientStock.locationId, input.locationId), inArray(foodIngredientStock.ingredientId, [...need.keys()]))).for('update');
  const lowStock: string[] = [];
  const exhausted: string[] = [];
  for (const s of stock) {
    const n = need.get(s.ingredientId)!;
    if (s.autoSoldOut && s.onHand < n) {
      const [ing] = await tx.select({ name: foodIngredients.name }).from(foodIngredients).where(eq(foodIngredients.id, s.ingredientId));
      const affected = input.lines.filter((l) => l.quantity > 0).map((l) => l.name);
      throw new AppError(409, 'menu_check_failed', `Sold out: not enough ${ing?.name ?? 'stock'} for this order`, { lines: 'Sold out' }, { unavailable: affected.map((name) => ({ name, code: 'sold_out', source: 'ingredient' })) });
    }
    const after = s.onHand - n;
    await tx.update(foodIngredientStock).set({ onHand: after, updatedAt: new Date() }).where(eq(foodIngredientStock.id, s.id));
    await tx.insert(foodIngredientMovements).values({ organizationId: input.organizationId, locationId: input.locationId, ingredientId: s.ingredientId, delta: -n, reason: 'order', orderId: input.orderId, balanceAfter: after });
    if (s.onHand > s.lowStockThreshold && after <= s.lowStockThreshold) lowStock.push(s.ingredientId);
    if (s.autoSoldOut) exhausted.push(s.ingredientId);
  }
  if (lowStock.length) await audit(tx, { organizationId: input.organizationId, actorUserId: null, actorType: 'system', action: 'food_ingredient.low_stock', scopeKind: 'location', scopeId: input.locationId, targetType: 'food_order', targetId: input.orderId, metadata: { ingredientIds: lowStock } });
  await syncIngredientSoldOut(tx, input.organizationId, input.locationId);
  return { lowStock, exhausted };
}

/** Put back what an order consumed (cancel/reject/payment failure). Idempotent per order. */
export async function restoreForOrder(tx: Tx, input: { organizationId: string; locationId: string; orderId: string }) {
  const moves = await tx.select().from(foodIngredientMovements).where(and(eq(foodIngredientMovements.orderId, input.orderId), eq(foodIngredientMovements.locationId, input.locationId)));
  if (!moves.length || moves.some((m) => m.reason === 'order_reversal')) return 0;
  const per = new Map<string, number>();
  for (const m of moves.filter((x) => x.reason === 'order')) per.set(m.ingredientId, (per.get(m.ingredientId) ?? 0) - m.delta);
  for (const [ingredientId, qty] of per) {
    const [s] = await tx.update(foodIngredientStock).set({ onHand: sql`${foodIngredientStock.onHand} + ${qty}`, updatedAt: new Date() })
      .where(and(eq(foodIngredientStock.locationId, input.locationId), eq(foodIngredientStock.ingredientId, ingredientId))).returning();
    if (s) await tx.insert(foodIngredientMovements).values({ organizationId: input.organizationId, locationId: input.locationId, ingredientId, delta: qty, reason: 'order_reversal', orderId: input.orderId, balanceAfter: s.onHand });
  }
  await syncIngredientSoldOut(tx, input.organizationId, input.locationId);
  return per.size;
}

/** Open/close "ingredient" sold-out periods so history and reports match what customers saw. */
export async function syncIngredientSoldOut(db: Exec, organizationId: string, locationId: string) {
  const items = await db.select({ id: menuItems.id }).from(menuItems).where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.active, true)));
  const { shortItems } = await ingredientShortages(db, locationId, items.map((i) => i.id));
  const open = await db.select().from(foodSoldOutEvents).where(and(eq(foodSoldOutEvents.locationId, locationId), eq(foodSoldOutEvents.source, 'ingredient'), sql`${foodSoldOutEvents.endedAt} is null`));
  const openIds = new Set(open.map((o) => o.menuItemId));
  for (const id of shortItems) if (!openIds.has(id)) await recordSoldOut(db, { organizationId, locationId, menuItemId: id, soldOut: true, source: 'ingredient' });
  for (const o of open) if (o.menuItemId && !shortItems.has(o.menuItemId)) await recordSoldOut(db, { organizationId, locationId, menuItemId: o.menuItemId, soldOut: false, source: 'ingredient' });
  return { shortItems: [...shortItems] };
}

/** Manual stock movement (receive, waste, count). `count` sets the on-hand quantity to the counted value. */
export async function recordMovement(db: Exec, input: { organizationId: string; locationId: string; ingredientId: string; reason: 'receive' | 'waste' | 'count'; quantity: number; note?: string; by: string | null }) {
  return db.transaction(async (tx) => {
    let [s] = await tx.select().from(foodIngredientStock).where(and(eq(foodIngredientStock.locationId, input.locationId), eq(foodIngredientStock.ingredientId, input.ingredientId))).for('update');
    if (!s) [s] = await tx.insert(foodIngredientStock).values({ organizationId: input.organizationId, locationId: input.locationId, ingredientId: input.ingredientId }).returning();
    const delta = input.reason === 'receive' ? input.quantity : input.reason === 'waste' ? -input.quantity : input.quantity - s!.onHand;
    const after = s!.onHand + delta;
    await tx.update(foodIngredientStock).set({ onHand: after, updatedAt: new Date() }).where(eq(foodIngredientStock.id, s!.id));
    const [m] = await tx.insert(foodIngredientMovements).values({ organizationId: input.organizationId, locationId: input.locationId, ingredientId: input.ingredientId, delta, reason: input.reason, balanceAfter: after, note: input.note ?? null, createdBy: input.by }).returning();
    await audit(tx, { organizationId: input.organizationId, actorUserId: input.by, action: `food_ingredient.${input.reason}`, scopeKind: 'location', scopeId: input.locationId, targetType: 'food_ingredient', targetId: input.ingredientId, metadata: { delta, balanceAfter: after } });
    const sync = await syncIngredientSoldOut(tx, input.organizationId, input.locationId);
    return { movement: m!, onHand: after, soldOutItems: sync.shortItems };
  });
}
