import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { foodOrderCreateSchema } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { foodOrders, locationMenuOverrides, locations, menuItems, menus, modifierGroups, modifiers, pickupSlots, type FoodOrderLine } from '../db/schema/index.ts';
import { canTransition, requiresRefund, type FoodOrderState } from '../domain/foodOrderState.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { findOrCreateCustomer } from './customers.ts';
import { createPaymentForTarget, reverseTargetPayment } from './payments.ts';

type Location = typeof locations.$inferSelect;

export interface EffectiveItem {
  id: string; menuId: string; category: string; name: string; description: string | null; dietary: string[]; allergens: string[]; imageUrl: string | null;
  price: { amount: number; currency: string } | null; available: boolean; unavailableReason: string | null;
  priceOrigin: 'hq' | 'local' | null;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; price: { amount: number; currency: string } | null; available: boolean }> }>;
}

/** HQ menu + location overrides → what a given location actually sells, in its own currency. */
export async function effectiveMenu(db: Exec, organizationId: string, loc: Location, opts: { includeDrafts?: boolean } = {}): Promise<EffectiveItem[]> {
  const menuRows = await db.select().from(menus).where(and(eq(menus.organizationId, organizationId), opts.includeDrafts ? sql`true` : eq(menus.status, 'published')));
  if (!menuRows.length) return [];
  const items = await db.select().from(menuItems).where(and(inArray(menuItems.menuId, menuRows.map((m) => m.id)), eq(menuItems.active, true))).orderBy(menuItems.category, menuItems.sortOrder);
  if (!items.length) return [];
  const groups = await db.select().from(modifierGroups).where(inArray(modifierGroups.menuItemId, items.map((i) => i.id)));
  const mods = groups.length ? await db.select().from(modifiers).where(inArray(modifiers.groupId, groups.map((g) => g.id))) : [];
  const overrides = await db.select().from(locationMenuOverrides).where(eq(locationMenuOverrides.locationId, loc.id));
  const now = new Date();
  const soldOut = (o: (typeof overrides)[number] | undefined) => !!o && o.soldOut && (!o.soldOutUntil || o.soldOutUntil > now);

  return items.map((it) => {
    const ov = overrides.find((o) => o.menuItemId === it.id && !o.modifierId);
    const localPrice = ov?.priceMinor != null && it.localOverridable.includes('price') ? ov.priceMinor : null;
    const hqPrice = it.prices[loc.currency] ?? null;
    const amount = localPrice ?? hqPrice;
    const localAvailable = it.localOverridable.includes('available') ? ov?.available ?? true : true;
    let reason: string | null = null;
    if (amount === null) reason = `No price set in ${loc.currency}`;
    else if (!localAvailable) reason = 'Not offered at this location';
    else if (soldOut(ov)) reason = 'Sold out';
    return {
      id: it.id, menuId: it.menuId, category: it.category, name: it.name, description: it.description, dietary: it.dietary, allergens: it.allergens, imageUrl: it.imageUrl,
      price: amount === null ? null : { amount, currency: loc.currency }, available: reason === null, unavailableReason: reason,
      priceOrigin: localPrice !== null ? 'local' : hqPrice !== null ? 'hq' : null,
      modifierGroups: groups.filter((g) => g.menuItemId === it.id).map((g) => ({
        id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
        modifiers: mods.filter((m) => m.groupId === g.id).map((m) => {
          const mo = overrides.find((o) => o.menuItemId === it.id && o.modifierId === m.id);
          const p = mo?.priceMinor ?? m.prices[loc.currency] ?? (Object.keys(m.prices).length ? null : 0);
          return { id: m.id, name: m.name, price: p === null ? null : { amount: p, currency: loc.currency }, available: m.available && p !== null && !soldOut(mo) && (mo?.available ?? true) };
        }),
      })),
    };
  });
}

export type FoodOrderInput = z.infer<typeof foodOrderCreateSchema>;

/** Create a pickup order. Slot capacity, cutoff, menu availability, modifiers and totals are all checked server-side. */
export async function createFoodOrder(s: Services, organizationId: string, locationId: string, input: FoodOrderInput) {
  const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc || !loc.publiclyVisible) throw notFound('Location');
  if (loc.status !== 'operating') throw conflict('location_not_accepting_orders', 'This location is not taking orders right now');
  const payAtPickup = loc.settings.payAtPickup === true;
  if (!loc.paymentsEnabled && !payAtPickup) throw new AppError(409, 'payments_not_enabled', 'Online ordering is not available at this location yet');

  const menu = await effectiveMenu(s.db, organizationId, loc);
  const lines: FoodOrderLine[] = [];
  const fieldErrors: Record<string, string> = {};
  input.lines.forEach((l, idx) => {
    const item = menu.find((m) => m.id === l.menuItemId);
    if (!item) { fieldErrors[`lines.${idx}.menuItemId`] = 'Item is not on this location menu'; return; }
    if (!item.available || !item.price) { fieldErrors[`lines.${idx}.menuItemId`] = `${item.name}: ${item.unavailableReason ?? 'unavailable'}`; return; }
    const chosen: FoodOrderLine['modifiers'] = [];
    for (const g of item.modifierGroups) {
      const picked = g.modifiers.filter((m) => l.modifierIds.includes(m.id));
      if (picked.length < g.minSelect) fieldErrors[`lines.${idx}.modifierIds`] = `Choose at least ${g.minSelect} for "${g.name}"`;
      if (picked.length > g.maxSelect) fieldErrors[`lines.${idx}.modifierIds`] = `Choose at most ${g.maxSelect} for "${g.name}"`;
      for (const m of picked) {
        if (!m.available || !m.price) fieldErrors[`lines.${idx}.modifierIds`] = `${m.name} is unavailable`;
        else chosen.push({ id: m.id, name: m.name, priceMinor: m.price.amount });
      }
    }
    const known = new Set(item.modifierGroups.flatMap((g) => g.modifiers.map((m) => m.id)));
    if (l.modifierIds.some((id) => !known.has(id))) fieldErrors[`lines.${idx}.modifierIds`] = 'Unknown modifier for this item';
    const unit = item.price.amount + chosen.reduce((a, m) => a + m.priceMinor, 0);
    lines.push({ menuItemId: item.id, name: item.name, quantity: l.quantity, unitPriceMinor: unit, modifiers: chosen, lineTotalMinor: unit * l.quantity, notes: l.notes });
  });
  if (Object.keys(fieldErrors).length) throw new AppError(409, 'menu_check_failed', 'Some items are unavailable or incomplete', fieldErrors);

  const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
  // Tax only when the business configured a rate for this location; never a guessed universal rate.
  const taxBps = typeof loc.settings.taxRateBps === 'number' ? (loc.settings.taxRateBps as number) : 0;
  const tax = Math.round((subtotal * taxBps) / 10_000);
  const total = subtotal + tax;
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== total) {
    throw new AppError(409, 'price_changed', 'Prices changed since you started. Please review your order.', undefined, { totalMinor: total, currency: loc.currency });
  }

  const manageToken = randomToken();
  const order = await s.db.transaction(async (tx) => {
    const [slot] = await tx.select().from(pickupSlots).where(and(eq(pickupSlots.id, input.pickupSlotId), eq(pickupSlots.locationId, loc.id))).for('update');
    if (!slot) throw validationError('Unknown pickup time', { pickupSlotId: 'Not a pickup time at this location' });
    if (slot.cutoffAt <= new Date()) throw conflict('slot_closed', 'Ordering for this pickup time has closed. Choose a later time.');
    if (slot.booked >= slot.capacity) throw conflict('slot_full', 'This pickup time is full. Choose another time.');
    await tx.update(pickupSlots).set({ booked: slot.booked + 1 }).where(eq(pickupSlots.id, slot.id));
    const customer = await findOrCreateCustomer(tx, organizationId, loc.id, input.contact, 'food_order');
    const [o] = await tx.insert(foodOrders).values({
      organizationId, locationId: loc.id, customerId: customer.id, pickupSlotId: slot.id, orderNumber: `${loc.code}-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 5)}`,
      status: 'awaiting_acceptance', paymentStatus: loc.paymentsEnabled ? 'pending' : 'not_required', lines, subtotalMinor: subtotal, taxMinor: tax, totalMinor: total,
      currency: loc.currency, contact: { name: input.contact.name, email: input.contact.email, phone: input.contact.phone }, notes: input.notes ?? null,
      promisedAt: slot.startsAt, manageTokenHash: sha256(manageToken), statusHistory: [{ at: new Date().toISOString(), from: null, to: 'awaiting_acceptance', by: null }],
    }).returning();
    await audit(tx, { organizationId, actorUserId: null, actorType: 'system', action: 'food_order.created', scopeKind: 'location', scopeId: loc.id, targetType: 'food_order', targetId: o!.id, metadata: { totalMinor: total, currency: loc.currency } });
    return o!;
  });

  let payment: { id: string; clientSecret: string | null; sandbox: boolean } | null = null;
  if (order.paymentStatus === 'pending') {
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, ...snapshot } = order;
      const p = await createPaymentForTarget(s, {
        organizationId, locationId: loc.id, amountMinor: total, currency: loc.currency, targetType: 'food_order', targetId: order.id,
        description: `Pickup order ${order.orderNumber}`, recordSnapshot: { ...snapshot, promisedAt: order.promisedAt?.toISOString() ?? null } as Record<string, unknown>,
      });
      await s.db.update(foodOrders).set({ paymentId: p.payment.id }).where(eq(foodOrders.id, order.id));
      payment = { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox };
    } catch (err) {
      await s.db.transaction(async (tx) => {
        await tx.update(foodOrders).set({ status: 'cancelled', paymentStatus: 'voided', updatedAt: new Date() }).where(eq(foodOrders.id, order.id));
        await tx.update(pickupSlots).set({ booked: sql`greatest(${pickupSlots.booked} - 1, 0)` }).where(eq(pickupSlots.id, input.pickupSlotId));
      });
      throw err;
    }
  }
  return { order: { ...order, paymentId: payment?.id ?? null }, manageToken, payment };
}

/** Restaurant-side status change. Server acknowledges every transition; rejection/cancellation reverses payment. */
export async function transitionFoodOrder(s: Services, orderId: string, to: FoodOrderState, opts: { organizationId: string; actorUserId: string | null; note?: string; expectedFrom?: FoodOrderState }) {
  const updated = await s.db.transaction(async (tx) => {
    const [o] = await tx.select().from(foodOrders).where(and(eq(foodOrders.id, orderId), eq(foodOrders.organizationId, opts.organizationId))).for('update');
    if (!o) throw notFound('Order');
    const from = o.status as FoodOrderState;
    if (opts.expectedFrom && opts.expectedFrom !== from) throw new AppError(409, 'stale_status', `Order is now ${from}. Refresh and try again.`, undefined, { currentStatus: from });
    if (!canTransition(from, to)) throw new AppError(409, 'invalid_transition', `Cannot move an order from ${from} to ${to}`, undefined, { currentStatus: from });
    if (to === 'accepted' && !['paid', 'not_required'].includes(o.paymentStatus)) throw conflict('payment_pending', 'Payment has not been confirmed for this order yet');
    if (to === 'rejected' && !opts.note) throw validationError('A reason is required to reject an order', { note: 'Required' });
    const history = [...o.statusHistory, { at: new Date().toISOString(), from, to, by: opts.actorUserId, note: opts.note }];
    const [u] = await tx.update(foodOrders).set({ status: to, statusHistory: history, rejectionReason: to === 'rejected' ? opts.note ?? null : o.rejectionReason, updatedAt: new Date() }).where(eq(foodOrders.id, o.id)).returning();
    if (requiresRefund(to) && o.pickupSlotId) await tx.update(pickupSlots).set({ booked: sql`greatest(${pickupSlots.booked} - 1, 0)` }).where(eq(pickupSlots.id, o.pickupSlotId));
    await audit(tx, { organizationId: o.organizationId, actorUserId: opts.actorUserId, action: `food_order.${to}`, scopeKind: 'location', scopeId: o.locationId, targetType: 'food_order', targetId: o.id, metadata: { from, to, note: opts.note } });
    return u!;
  });

  let paymentAction: string = 'none';
  if (requiresRefund(to)) {
    const r = await reverseTargetPayment(s, updated.paymentId, opts.actorUserId, `Order ${to}: ${opts.note ?? ''}`.trim());
    paymentAction = r.action;
    const paymentStatus = r.action === 'refunded' ? (r.refundState === 'complete' ? 'refunded' : 'refund_pending') : r.action === 'voided' ? 'voided' : updated.paymentStatus;
    await s.db.update(foodOrders).set({ paymentStatus }).where(eq(foodOrders.id, updated.id));
    updated.paymentStatus = paymentStatus;
  }
  if (updated.contact.email && ['accepted', 'ready', 'rejected', 'cancelled'].includes(to)) {
    const msg: Record<string, string> = {
      accepted: 'Your order has been accepted and will be ready at your pickup time.',
      ready: 'Your order is ready for pickup.',
      rejected: `Sorry — the restaurant could not accept your order${opts.note ? ` (${opts.note})` : ''}. ${paymentAction === 'refunded' ? 'A full refund has been issued.' : paymentAction === 'voided' ? 'You have not been charged.' : ''}`,
      cancelled: `Your order was cancelled. ${paymentAction === 'refunded' ? 'A full refund has been issued.' : ''}`,
    };
    await s.jobs.enqueue('email.send', { to: updated.contact.email, subject: `Order ${updated.orderNumber}: ${to}`, text: msg[to]!, tag: 'food-order' });
  }
  return { order: updated, paymentAction };
}

export function serializeFoodOrder(o: typeof foodOrders.$inferSelect, opts: { includeContact?: boolean } = {}) {
  return {
    id: o.id, orderNumber: o.orderNumber, locationId: o.locationId, status: o.status, paymentStatus: o.paymentStatus, lines: o.lines,
    subtotal: { amount: o.subtotalMinor, currency: o.currency }, tax: { amount: o.taxMinor, currency: o.currency }, total: { amount: o.totalMinor, currency: o.currency },
    pickupSlotId: o.pickupSlotId, promisedAt: o.promisedAt?.toISOString() ?? null, notes: o.notes, rejectionReason: o.rejectionReason,
    // Kitchen screens get the first name only — no unnecessary customer information on shared displays.
    contact: opts.includeContact ? o.contact : { name: o.contact.name.split(' ')[0] ?? '' },
    statusHistory: o.statusHistory, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
  };
}
