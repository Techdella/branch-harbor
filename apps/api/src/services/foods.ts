import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { FoodCheckoutInput, foodOrderCreateSchema } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  foodDayParts, foodDeliveries, foodDeliverySlots, foodMenuCategories, foodMenuPublications, foodOrders, foodProductionDates, foodTables, foodTabs,
  locationMenuOverrides, locations, menuItems, menus, modifierGroups, modifiers, paymentReferences, pickupSlots, type FoodOrderFulfilment, type FoodOrderLine,
} from '../db/schema/index.ts';
import { canTransition, requiresRefund, type FoodOrderState } from '../domain/foodOrderState.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { localDateParts, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { findOrCreateCustomer } from './customers.ts';
import { createPaymentForTarget, paymentFailureHooks, refundPayment, reverseTargetPayment } from './payments.ts';
import { notify, userIdsForCustomer } from './notifications.ts';
import { configOf, loadPickupSettings } from './pickup.ts';
import { allergenView, currentClose, inWindows, loadFoodConfig, localized, regimeFor, windowsSummary, type AllergenView } from './foods-menu.ts';
import { depleteForOrder, ingredientShortages, restoreForOrder } from './foods-inventory.ts';
import { deliveryFeeFor, resolveDeliveryZone } from './foods-delivery.ts';
import { providerDeliveryQuote } from './foods-partners.ts';
import { cancelKdsTickets, createKdsTickets } from './foods-kitchen.ts';
import type { FoodLocationConfig } from '../db/schema/index.ts';

type Location = typeof locations.$inferSelect;
type FoodOrderRow = typeof foodOrders.$inferSelect;
type Money = { amount: number; currency: string };

export interface EffectiveModifier { id: string; name: string; price: Money | null; available: boolean; soldOut: boolean; allergens: string[] }
export interface EffectiveItem {
  id: string; menuId: string; menuKind: string; categoryId: string | null; category: string; categorySortOrder: number;
  name: string; description: string | null; dietary: string[]; allergens: string[]; allergenInfo: AllergenView; imageUrl: string | null; images: string[];
  price: Money | null; available: boolean; unavailableReason: string | null;
  /** no_price | not_offered | sold_out | outside_day_part */
  unavailableCode: string | null; soldOutSource: 'manual' | 'ingredient' | null; soldOutUntil: string | null;
  dayParts: Array<{ id: string; name: string; summary: string; windows: Array<{ weekday: number; start: string; end: string }> }>;
  priceOrigin: 'hq' | 'local' | null; stationKey: string | null; prepMinutes: number | null;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; required: boolean; modifiers: EffectiveModifier[] }>;
}

export interface EffectiveMenuOptions {
  includeDrafts?: boolean;
  /** Time the food is for (pickup/delivery/collection time); day-parts are evaluated at this instant in the location's time zone. */
  at?: Date;
  lang?: string | null;
  /** Menu kinds to include (default: standard). */
  kinds?: string[];
  menuIds?: string[];
}

/** HQ menu + location overrides → what a given location actually sells, in its own currency, at a given time. */
export async function effectiveMenu(db: Exec, organizationId: string, loc: Location, opts: EffectiveMenuOptions = {}): Promise<EffectiveItem[]> {
  const kinds = opts.kinds ?? ['standard'];
  let menuRows = await db.select().from(menus).where(and(eq(menus.organizationId, organizationId), opts.includeDrafts ? sql`true` : eq(menus.status, 'published'), inArray(menus.kind, kinds)));
  if (opts.menuIds) menuRows = menuRows.filter((m) => opts.menuIds!.includes(m.id));
  if (!opts.includeDrafts && menuRows.length) {
    // A published menu reaches a location once a publish succeeded there (menus published before per-location results reach all).
    const pubs = await db.select({ menuId: foodMenuPublications.menuId, locationId: foodMenuPublications.locationId, status: foodMenuPublications.status }).from(foodMenuPublications).where(inArray(foodMenuPublications.menuId, menuRows.map((m) => m.id)));
    menuRows = menuRows.filter((m) => {
      const mine = pubs.filter((p) => p.menuId === m.id);
      return !mine.length || mine.some((p) => p.locationId === loc.id && (p.status === 'succeeded' || p.status === 'partial'));
    });
  }
  if (!menuRows.length) return [];
  const items = await db.select().from(menuItems).where(and(inArray(menuItems.menuId, menuRows.map((m) => m.id)), eq(menuItems.active, true))).orderBy(menuItems.category, menuItems.sortOrder);
  if (!items.length) return [];
  const [groups, cats, parts, overrides, cfg] = await Promise.all([
    db.select().from(modifierGroups).where(inArray(modifierGroups.menuItemId, items.map((i) => i.id))).orderBy(modifierGroups.sortOrder, modifierGroups.createdAt),
    db.select().from(foodMenuCategories).where(inArray(foodMenuCategories.menuId, menuRows.map((m) => m.id))),
    db.select().from(foodDayParts).where(and(eq(foodDayParts.organizationId, organizationId), eq(foodDayParts.active, true))),
    db.select().from(locationMenuOverrides).where(eq(locationMenuOverrides.locationId, loc.id)),
    loadFoodConfig(db, loc.id),
  ]);
  const mods = groups.length ? await db.select().from(modifiers).where(inArray(modifiers.groupId, groups.map((g) => g.id))).orderBy(modifiers.sortOrder, modifiers.createdAt) : [];
  const shortages = await ingredientShortages(db, loc.id, items.map((i) => i.id));
  const regime = regimeFor(loc, cfg);
  const now = new Date();
  const at = opts.at ?? now;
  const local = localDateParts(at, loc.timeZone);
  const soldOut = (o: (typeof overrides)[number] | undefined) => !!o && o.soldOut && (!o.soldOutUntil || o.soldOutUntil > now);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const partById = new Map(parts.map((p) => [p.id, p]));
  const menuById = new Map(menuRows.map((m) => [m.id, m]));

  const out = items.filter((it) => !it.categoryId || catById.get(it.categoryId)?.active !== false).map((it): EffectiveItem => {
    const ov = overrides.find((o) => o.menuItemId === it.id && !o.modifierId);
    const localPrice = ov?.priceMinor != null && it.localOverridable.includes('price') ? ov.priceMinor : null;
    const hqPrice = it.prices[loc.currency] ?? null;
    const amount = localPrice ?? hqPrice;
    const localAvailable = it.localOverridable.includes('available') ? ov?.available ?? true : true;
    const cat = it.categoryId ? catById.get(it.categoryId) : undefined;
    const partIds = it.dayPartIds.length ? it.dayPartIds : cat?.dayPartIds.length ? cat.dayPartIds : menuById.get(it.menuId)?.dayPartIds ?? [];
    const dayParts = partIds.map((id) => partById.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const inDayPart = !dayParts.length || dayParts.some((p) => inWindows(p.windows, local.weekday, local.time));
    const ingredientShort = shortages.shortItems.has(it.id);
    let reason: string | null = null;
    let code: string | null = null;
    if (amount === null) [reason, code] = [`No price set in ${loc.currency}`, 'no_price'];
    else if (!localAvailable) [reason, code] = ['Not offered at this location', 'not_offered'];
    else if (soldOut(ov) || ingredientShort) [reason, code] = ['Sold out', 'sold_out'];
    else if (!inDayPart) [reason, code] = [`Available ${dayParts.map((p) => `${localized(p, opts.lang).name} (${windowsSummary(p.windows)})`).join(' or ')}`, 'outside_day_part'];
    const text = localized(it, opts.lang);
    const modAllergens = new Set<string>();
    return {
      id: it.id, menuId: it.menuId, menuKind: menuById.get(it.menuId)?.kind ?? 'standard', categoryId: it.categoryId,
      category: cat ? localized(cat, opts.lang).name : it.category, categorySortOrder: cat?.sortOrder ?? 999,
      name: text.name, description: text.description, dietary: it.dietary, allergens: it.allergens, allergenInfo: allergenView(it.allergens, it.allergensDeclared, regime),
      imageUrl: it.imageUrl, images: it.images,
      price: amount === null ? null : { amount, currency: loc.currency }, available: reason === null, unavailableReason: reason, unavailableCode: code,
      soldOutSource: soldOut(ov) ? 'manual' : ingredientShort ? 'ingredient' : null, soldOutUntil: soldOut(ov) ? ov!.soldOutUntil?.toISOString() ?? null : null,
      dayParts: dayParts.map((p) => ({ id: p.id, name: localized(p, opts.lang).name, summary: windowsSummary(p.windows), windows: p.windows })),
      priceOrigin: localPrice !== null ? 'local' : hqPrice !== null ? 'hq' : null, stationKey: it.stationKey, prepMinutes: it.prepMinutes,
      modifierGroups: groups.filter((g) => g.menuItemId === it.id).map((g) => ({
        id: g.id, name: localized({ name: g.name, translations: g.translations }, opts.lang).name, minSelect: g.minSelect, maxSelect: g.maxSelect, required: g.minSelect > 0,
        modifiers: mods.filter((m) => m.groupId === g.id).map((m) => {
          const mo = overrides.find((o) => o.menuItemId === it.id && o.modifierId === m.id) ?? overrides.find((o) => o.modifierId === m.id);
          const p = mo?.priceMinor ?? m.prices[loc.currency] ?? (Object.keys(m.prices).length ? null : 0);
          const mSold = soldOut(mo) || shortages.shortModifiers.has(m.id);
          m.allergens.forEach((a) => modAllergens.add(a));
          return { id: m.id, name: localized({ name: m.name, translations: m.translations }, opts.lang).name, price: p === null ? null : { amount: p, currency: loc.currency }, available: m.available && p !== null && !mSold && (mo?.available ?? true), soldOut: mSold, allergens: m.allergens };
        }),
      })),
    };
  });
  return out.sort((a, b) => a.categorySortOrder - b.categorySortOrder || a.category.localeCompare(b.category));
}

export type FoodOrderInput = z.infer<typeof foodOrderCreateSchema>;
type InputLines = FoodOrderInput['lines'];

/**
 * Price order lines against the location's effective menu at the fulfilment time: availability (sold out,
 * day-parts), modifier rules (required/min/max, sold-out options), unit prices, and tax only when the
 * business configured a rate for the location. Shared by order creation and quotes.
 */
export async function priceFoodOrderLines(db: Exec, organizationId: string, loc: Location, inputLines: InputLines, opts: EffectiveMenuOptions = {}) {
  const menu = await effectiveMenu(db, organizationId, loc, opts);
  const lines: FoodOrderLine[] = [];
  const fieldErrors: Record<string, string> = {};
  const unavailable: Array<{ index: number; menuItemId: string; modifierId?: string; name: string; code: string }> = [];
  inputLines.forEach((l, idx) => {
    const item = menu.find((m) => m.id === l.menuItemId);
    if (!item) { fieldErrors[`lines.${idx}.menuItemId`] = 'Item is not on this location menu'; unavailable.push({ index: idx, menuItemId: l.menuItemId, name: 'Unknown item', code: 'not_on_menu' }); return; }
    if (!item.available || !item.price) {
      fieldErrors[`lines.${idx}.menuItemId`] = `${item.name}: ${item.unavailableReason ?? 'unavailable'}`;
      unavailable.push({ index: idx, menuItemId: item.id, name: item.name, code: item.unavailableCode ?? 'unavailable' });
      return;
    }
    const chosen: FoodOrderLine['modifiers'] = [];
    for (const g of item.modifierGroups) {
      const picked = g.modifiers.filter((m) => l.modifierIds.includes(m.id));
      if (picked.length < g.minSelect) fieldErrors[`lines.${idx}.modifierIds`] = `Choose at least ${g.minSelect} for "${g.name}"`;
      if (picked.length > g.maxSelect) fieldErrors[`lines.${idx}.modifierIds`] = `Choose at most ${g.maxSelect} for "${g.name}"`;
      for (const m of picked) {
        if (!m.available || !m.price) {
          fieldErrors[`lines.${idx}.modifierIds`] = m.soldOut ? `${m.name} is sold out — choose another option for "${g.name}"` : `${m.name} is unavailable`;
          unavailable.push({ index: idx, menuItemId: item.id, modifierId: m.id, name: m.name, code: m.soldOut ? 'modifier_sold_out' : 'modifier_unavailable' });
        } else chosen.push({ id: m.id, name: m.name, priceMinor: m.price.amount });
      }
    }
    const known = new Set(item.modifierGroups.flatMap((g) => g.modifiers.map((m) => m.id)));
    if (l.modifierIds.some((id) => !known.has(id))) fieldErrors[`lines.${idx}.modifierIds`] = 'Unknown modifier for this item';
    const unit = item.price.amount + chosen.reduce((a, m) => a + m.priceMinor, 0);
    lines.push({ menuItemId: item.id, name: item.name, quantity: l.quantity, unitPriceMinor: unit, modifiers: chosen, lineTotalMinor: unit * l.quantity, notes: l.notes, stationKey: item.stationKey });
  });
  if (Object.keys(fieldErrors).length) {
    const msg = unavailable.some((u) => u.code === 'modifier_sold_out') ? 'An option you chose has just sold out. Please choose another.' : 'Some items are unavailable or incomplete';
    throw new AppError(409, 'menu_check_failed', msg, fieldErrors, { unavailable });
  }

  const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
  // Tax only when the business configured a rate for this location; never a guessed universal rate.
  const taxBps = typeof loc.settings.taxRateBps === 'number' ? (loc.settings.taxRateBps as number) : 0;
  const tax = Math.round((subtotal * taxBps) / 10_000);
  return { lines, subtotal, tax, taxRateBps: taxBps, total: subtotal + tax };
}

/** Subtotal → service charge (configured channels) → delivery fee → tax (configured rate, on items) → tip. */
export function computeTotals(input: { subtotal: number; taxRateBps: number; cfg: FoodLocationConfig; channel: string; deliveryFeeMinor: number; tipMinor: number }) {
  const sc = input.cfg.serviceCharge;
  const serviceCharge = sc.bps > 0 && sc.channels.includes(input.channel) ? Math.round((input.subtotal * sc.bps) / 10_000) : 0;
  const tax = Math.round((input.subtotal * input.taxRateBps) / 10_000);
  const total = input.subtotal + serviceCharge + input.deliveryFeeMinor + tax + input.tipMinor;
  return { subtotal: input.subtotal, serviceCharge, serviceChargeLabel: serviceCharge ? sc.label : null, deliveryFee: input.deliveryFeeMinor, tax, tip: input.tipMinor, total };
}

type CheckoutInput = FoodCheckoutInput & { pickupSlotId?: string };

function slotProblem(slot: { cutoffAt: Date; startsAt: Date; booked: number; capacity: number }, prepBufferMinutes: number, kind: 'pickup' | 'delivery') {
  if (slot.cutoffAt <= new Date()) return conflict('slot_closed', `Ordering for this ${kind} time has closed. Choose a later time.`, { cutoffAt: slot.cutoffAt.toISOString() });
  if (slot.startsAt.getTime() < Date.now() + prepBufferMinutes * 60_000) return conflict('slot_closed', `The kitchen needs more preparation time for this ${kind}. Choose a later time.`);
  if (slot.booked >= slot.capacity) return conflict('slot_full', `This ${kind} time is full. Choose another time.`);
  return null;
}

/**
 * Validate a checkout against the location: channel enabled, slot/zone/table/date, menu at the fulfilment
 * time, minimum order, tips and service charges. `quote` mode runs the same checks without reserving.
 */
export async function prepareCheckout(s: Services, loc: Location, input: CheckoutInput, mode: 'quote' | 'order') {
  const cfg = await loadFoodConfig(s.db, loc.id);
  const channelOn: Record<string, boolean> = { pickup: cfg.channels.pickup, delivery: cfg.channels.delivery, dine_in: cfg.channels.dineIn, preorder: cfg.channels.preorder };
  if (!channelOn[input.channel]) throw conflict('channel_unavailable', `${input.channel === 'dine_in' ? 'Table ordering' : input.channel === 'delivery' ? 'Delivery' : input.channel === 'preorder' ? 'Preorders' : 'Pickup'} is not available at this location`);
  const fulfilment: FoodOrderFulfilment = {};
  let at = new Date();
  let promisedAt: Date | null = null;
  let deliveryFee = 0;
  let zone: Awaited<ReturnType<typeof resolveDeliveryZone>> = null;
  let table: typeof foodTables.$inferSelect | undefined;
  let orderBy: Date | null = null;
  let kinds = ['standard'];
  let menuIds: string[] | undefined;

  if (input.channel === 'pickup') {
    if (!input.pickupSlotId) throw validationError('Choose a pickup time', { pickupSlotId: 'Required' });
    const [slot] = await s.db.select().from(pickupSlots).where(and(eq(pickupSlots.id, input.pickupSlotId), eq(pickupSlots.locationId, loc.id)));
    if (!slot) throw validationError('Unknown pickup time', { pickupSlotId: 'Not a pickup time at this location' });
    at = slot.startsAt; promisedAt = slot.startsAt; orderBy = slot.cutoffAt;
    if (mode === 'quote') { const p = slotProblem(slot, configOf(await loadPickupSettings(s.db, loc.id)).prepBufferMinutes, 'pickup'); if (p) throw p; }
  } else if (input.channel === 'delivery') {
    if (!input.address) throw validationError('Enter a delivery address', { address: 'Required' });
    zone = await resolveDeliveryZone(s, loc, input.address);
    if (!zone) throw conflict('outside_delivery_area', 'We don’t deliver to this address yet. Check the postcode or choose pickup.');
    if (!input.deliverySlotId) throw validationError('Choose a delivery time', { deliverySlotId: 'Required' });
    const [slot] = await s.db.select().from(foodDeliverySlots).where(and(eq(foodDeliverySlots.id, input.deliverySlotId), eq(foodDeliverySlots.locationId, loc.id)));
    if (!slot) throw validationError('Unknown delivery time', { deliverySlotId: 'Not a delivery time at this location' });
    at = slot.startsAt; promisedAt = slot.startsAt; orderBy = slot.cutoffAt;
    if (mode === 'quote') { const p = slotProblem(slot, cfg.delivery.leadMinutes, 'delivery'); if (p) throw p; }
    Object.assign(fulfilment, { address: input.address, zoneId: zone.zone.id, zoneName: zone.zone.name, deliverySlotId: slot.id });
  } else if (input.channel === 'dine_in') {
    if (!input.tableCode) throw validationError('Scan the table code', { tableCode: 'Required' });
    [table] = await s.db.select().from(foodTables).where(and(eq(foodTables.code, input.tableCode), eq(foodTables.locationId, loc.id), eq(foodTables.active, true)));
    if (!table) throw validationError('Unknown table', { tableCode: 'This table code is not valid here' });
    const open = await currentClose(s.db, loc);
    if (!open.open) throw conflict('location_closed', 'The kitchen is closed right now, so table orders can’t be placed.');
    // Closing time during checkout: the kitchen must still be open when the order is sent.
    orderBy = open.closesAt;
    Object.assign(fulfilment, { tableId: table.id, tableLabel: table.label });
  } else if (input.channel === 'preorder') {
    if (!input.productionDateId) throw validationError('Choose a date first', { productionDateId: 'Required' });
    const [d] = await s.db.select().from(foodProductionDates).where(and(eq(foodProductionDates.id, input.productionDateId), eq(foodProductionDates.locationId, loc.id)));
    if (!d) throw validationError('Unknown date', { productionDateId: 'Not a preorder date at this location' });
    if (d.status !== 'open' || d.cutoffAt <= new Date()) throw conflict('preorder_closed', 'Preorders for this date have closed. Choose a later date.', { cutoffAt: d.cutoffAt.toISOString() });
    if (mode === 'quote' && d.booked >= d.capacity) throw conflict('date_full', 'This date is fully booked. Choose another date.');
    let window = d.collectionWindows[0] ?? null;
    if (d.collectionWindows.length) {
      window = d.collectionWindows.find((w) => w.split('-')[0] === input.collectionWindow) ?? null;
      if (!window) throw validationError('Choose a collection time', { collectionWindow: 'Choose one of the collection windows' });
    }
    const start = window ? window.split('-')[0]! : '12:00';
    at = zonedToUtc(d.date, start, loc.timeZone); promisedAt = at; orderBy = d.cutoffAt;
    kinds = ['preorder'];
    if (d.menuId) menuIds = [d.menuId];
    Object.assign(fulfilment, { productionDateId: d.id, productionDate: d.date, collectionWindow: window ?? undefined });
  }

  const priced = await priceFoodOrderLines(s.db, loc.organizationId, loc, input.lines, { at, lang: input.lang, kinds, menuIds });
  if (zone) {
    deliveryFee = deliveryFeeFor(zone.zone, priced.subtotal);
    if (priced.subtotal < zone.zone.minimumOrderMinor) {
      throw conflict('below_minimum', `The minimum order for delivery to ${zone.zone.name} is ${(zone.zone.minimumOrderMinor / 100).toFixed(2)} ${loc.currency}.`, { minimumMinor: zone.zone.minimumOrderMinor, subtotalMinor: priced.subtotal, currency: loc.currency });
    }
    // Delivery partner (Uber Direct): quote now; the customer pays the quote (pass-through) or the zone fee (absorbed).
    const slotEnd = fulfilment.deliverySlotId ? (await s.db.select({ e: foodDeliverySlots.endsAt }).from(foodDeliverySlots).where(eq(foodDeliverySlots.id, fulfilment.deliverySlotId)))[0]?.e ?? null : null;
    const pq = await providerDeliveryQuote(s, loc, cfg, { address: input.address as Record<string, unknown>, deliverBy: promisedAt, dropoffDeadline: slotEnd, subtotalMinor: priced.subtotal, zoneFeeMinor: deliveryFee, contactPhone: input.contact?.phone ?? null });
    if (pq) {
      deliveryFee = pq.customerFeeMinor;
      if (pq.quote) fulfilment.providerQuote = pq.quote;
      if (pq.notice) fulfilment.deliveryNotice = pq.notice;
    }
  }
  const tip = input.tipMinor ?? 0;
  if (tip > 0) {
    if (!cfg.tips.enabled || !cfg.tips.channels.includes(input.channel)) throw validationError('Tips are not accepted for this order', { tipMinor: 'Not accepted' });
    if (tip > priced.subtotal) throw validationError('The tip cannot be more than the order subtotal', { tipMinor: 'Too large' });
  }
  const totals = computeTotals({ subtotal: priced.subtotal, taxRateBps: priced.taxRateBps, cfg, channel: input.channel, deliveryFeeMinor: deliveryFee, tipMinor: tip });
  if (totals.serviceChargeLabel) fulfilment.serviceChargeLabel = totals.serviceChargeLabel;
  return { cfg, priced, totals, fulfilment, promisedAt, zone, table, orderBy, at };
}

/** Public quote for a checkout (same server checks as ordering; nothing is reserved). */
export async function quoteCheckout(s: Services, loc: Location, input: CheckoutInput) {
  const p = await prepareCheckout(s, loc, input, 'quote');
  const m = (amount: number) => ({ amount, currency: loc.currency });
  return {
    locationId: loc.id, channel: input.channel, currency: loc.currency,
    lines: p.priced.lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((x) => x.name), unitPrice: m(l.unitPriceMinor), lineTotal: m(l.lineTotalMinor) })),
    subtotal: m(p.totals.subtotal), serviceCharge: p.totals.serviceCharge ? { ...m(p.totals.serviceCharge), label: p.totals.serviceChargeLabel } : null,
    deliveryFee: input.channel === 'delivery' ? m(p.totals.deliveryFee) : null, tax: p.priced.taxRateBps > 0 ? m(p.totals.tax) : null, taxRateBps: p.priced.taxRateBps || null,
    tip: p.totals.tip ? m(p.totals.tip) : null, total: m(p.totals.total),
    deliveryPartner: p.fulfilment.providerQuote ? { provider: p.fulfilment.providerQuote.provider, feeMode: p.fulfilment.providerQuote.feeMode, sandbox: p.fulfilment.providerQuote.sandbox } : null,
    deliveryNotice: p.fulfilment.deliveryNotice ?? null,
    zone: p.zone ? { id: p.zone.zone.id, name: p.zone.zone.name, minimumOrder: m(p.zone.zone.minimumOrderMinor), freeDeliveryAbove: p.zone.zone.freeDeliveryAboveMinor === null ? null : m(p.zone.zone.freeDeliveryAboveMinor) } : null,
    tips: p.cfg.tips.enabled && p.cfg.tips.channels.includes(input.channel) ? { presetsBps: p.cfg.tips.presetsBps, allowCustom: p.cfg.tips.allowCustom } : null,
    table: p.table ? { label: p.table.label } : null, promisedAt: p.promisedAt?.toISOString() ?? null,
    /** Order before this time (slot cut-off, preorder cut-off or kitchen closing). */
    orderBy: p.orderBy?.toISOString() ?? null,
  };
}

/** Release capacity and stock held by an order that will not be fulfilled. Idempotent. */
export async function releaseOrderResources(tx: Tx, o: FoodOrderRow) {
  if (o.fulfilment.resourcesReleased) return;
  if (o.pickupSlotId) await tx.update(pickupSlots).set({ booked: sql`greatest(${pickupSlots.booked} - 1, 0)` }).where(eq(pickupSlots.id, o.pickupSlotId));
  if (o.fulfilment.deliverySlotId) await tx.update(foodDeliverySlots).set({ booked: sql`greatest(${foodDeliverySlots.booked} - 1, 0)` }).where(eq(foodDeliverySlots.id, o.fulfilment.deliverySlotId));
  if (o.fulfilment.productionDateId) await tx.update(foodProductionDates).set({ booked: sql`greatest(${foodProductionDates.booked} - 1, 0)` }).where(eq(foodProductionDates.id, o.fulfilment.productionDateId));
  await restoreForOrder(tx, { organizationId: o.organizationId, locationId: o.locationId, orderId: o.id });
  await tx.update(foodOrders).set({ fulfilment: { ...o.fulfilment, resourcesReleased: true } }).where(eq(foodOrders.id, o.id));
}

/**
 * Place a pickup, delivery, dine-in or preorder order. Every check (slot capacity and cut-off, delivery zone
 * and minimum, kitchen open, preorder cut-off and capacity, menu/day-part/sold-out, modifiers, ingredient
 * stock, totals) runs on the server before the order is confirmed.
 */
export async function placeFoodOrder(s: Services, organizationId: string, locationId: string, input: CheckoutInput) {
  const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc || !loc.publiclyVisible) throw notFound('Location');
  if (loc.status !== 'operating') throw conflict('location_not_accepting_orders', 'This location is not taking orders right now');
  const payAtPickup = loc.settings.payAtPickup === true && input.channel === 'pickup';
  const onTab = input.channel === 'dine_in' && input.payMode === 'tab';
  if (!loc.paymentsEnabled && !payAtPickup && !onTab) throw new AppError(409, 'payments_not_enabled', 'Online ordering is not available at this location yet');

  const prep = await prepareCheckout(s, loc, input, 'order');
  const { totals, fulfilment } = prep;
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== totals.total) {
    throw new AppError(409, 'price_changed', 'Prices changed since you started. Please review your order.', undefined, { totalMinor: totals.total, currency: loc.currency });
  }

  const manageToken = randomToken();
  let tabToken: string | null = null;
  const order = await s.db.transaction(async (tx) => {
    let pickupSlotId: string | null = null;
    if (input.channel === 'pickup') {
      const [slot] = await tx.select().from(pickupSlots).where(and(eq(pickupSlots.id, input.pickupSlotId!), eq(pickupSlots.locationId, loc.id))).for('update');
      if (!slot) throw validationError('Unknown pickup time', { pickupSlotId: 'Not a pickup time at this location' });
      const pickup = configOf(await loadPickupSettings(tx, loc.id));
      if (slot.cutoffAt <= new Date()) throw conflict('slot_closed', 'Ordering for this pickup time has closed. Choose a later time.');
      if (!pickup.acceptingOrders) throw conflict('location_not_accepting_orders', 'This location is not taking pickup orders right now');
      const p = slotProblem(slot, pickup.prepBufferMinutes, 'pickup');
      if (p) throw p;
      await tx.update(pickupSlots).set({ booked: slot.booked + 1 }).where(eq(pickupSlots.id, slot.id));
      pickupSlotId = slot.id;
    } else if (input.channel === 'delivery') {
      const [slot] = await tx.select().from(foodDeliverySlots).where(eq(foodDeliverySlots.id, fulfilment.deliverySlotId!)).for('update');
      const p = slotProblem(slot!, prep.cfg.delivery.leadMinutes, 'delivery');
      if (p) throw p;
      await tx.update(foodDeliverySlots).set({ booked: slot!.booked + 1 }).where(eq(foodDeliverySlots.id, slot!.id));
    } else if (input.channel === 'preorder') {
      const [d] = await tx.select().from(foodProductionDates).where(eq(foodProductionDates.id, fulfilment.productionDateId!)).for('update');
      if (d!.status !== 'open' || d!.cutoffAt <= new Date()) throw conflict('preorder_closed', 'Preorders for this date have closed. Choose a later date.');
      if (d!.booked >= d!.capacity) throw conflict('date_full', 'This date is fully booked. Choose another date.');
      await tx.update(foodProductionDates).set({ booked: d!.booked + 1 }).where(eq(foodProductionDates.id, d!.id));
    } else if (input.channel === 'dine_in' && onTab) {
      const [open] = await tx.select().from(foodTabs).where(and(eq(foodTabs.tableId, prep.table!.id), eq(foodTabs.status, 'open'))).for('update');
      if (open) {
        if (!input.tabToken || sha256(input.tabToken) !== open.tokenHash) throw conflict('tab_open', 'This table already has an open tab. Ask the person who opened it to share it, or pay now.');
        fulfilment.tabId = open.id;
        tabToken = input.tabToken;
      } else {
        tabToken = randomToken();
        const [t] = await tx.insert(foodTabs).values({ organizationId, locationId: loc.id, tableId: prep.table!.id, guestName: input.contact.name, tokenHash: sha256(tabToken), currency: loc.currency }).returning();
        fulfilment.tabId = t!.id;
      }
    }
    const customer = await findOrCreateCustomer(tx, organizationId, loc.id, input.contact, 'food_order');
    const paymentStatus = onTab ? 'on_tab' : loc.paymentsEnabled ? 'pending' : 'not_required';
    const [o] = await tx.insert(foodOrders).values({
      organizationId, locationId: loc.id, customerId: customer.id, pickupSlotId, orderNumber: `${loc.code}-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 5)}`,
      status: 'awaiting_acceptance', paymentStatus, channel: input.channel, fulfilment, lines: prep.priced.lines,
      subtotalMinor: totals.subtotal, taxMinor: totals.tax, serviceChargeMinor: totals.serviceCharge, deliveryFeeMinor: totals.deliveryFee, tipMinor: totals.tip, totalMinor: totals.total,
      currency: loc.currency, contact: { name: input.contact.name, email: input.contact.email, phone: input.contact.phone }, notes: input.notes ?? null,
      promisedAt: prep.promisedAt, manageTokenHash: sha256(manageToken), statusHistory: [{ at: new Date().toISOString(), from: null, to: 'awaiting_acceptance', by: null }],
    }).returning();
    await depleteForOrder(tx, { organizationId, locationId: loc.id, orderId: o!.id, lines: prep.priced.lines });
    await audit(tx, { organizationId, actorUserId: null, actorType: 'system', action: 'food_order.created', scopeKind: 'location', scopeId: loc.id, targetType: 'food_order', targetId: o!.id, metadata: { totalMinor: totals.total, currency: loc.currency, channel: input.channel } });
    return o!;
  });

  let payment: { id: string; clientSecret: string | null; sandbox: boolean } | null = null;
  if (order.paymentStatus === 'pending') {
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, ...snapshot } = order;
      const p = await createPaymentForTarget(s, {
        organizationId, locationId: loc.id, amountMinor: totals.total, currency: loc.currency, targetType: 'food_order', targetId: order.id,
        description: `${input.channel === 'delivery' ? 'Delivery' : input.channel === 'dine_in' ? 'Table' : input.channel === 'preorder' ? 'Preorder' : 'Pickup'} order ${order.orderNumber}`,
        recordSnapshot: { ...snapshot, promisedAt: order.promisedAt?.toISOString() ?? null } as Record<string, unknown>,
      });
      await s.db.update(foodOrders).set({ paymentId: p.payment.id }).where(eq(foodOrders.id, order.id));
      payment = { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox };
    } catch (err) {
      await s.db.transaction(async (tx) => {
        const [o] = await tx.update(foodOrders).set({ status: 'cancelled', paymentStatus: 'voided', updatedAt: new Date() }).where(eq(foodOrders.id, order.id)).returning();
        await releaseOrderResources(tx, o!);
      });
      throw err;
    }
  }
  return { order: { ...order, paymentId: payment?.id ?? null }, manageToken, payment, tabToken };
}

/** Create a pickup order (first-release endpoint). Delegates to the shared checkout with channel "pickup". */
export async function createFoodOrder(s: Services, organizationId: string, locationId: string, input: FoodOrderInput) {
  return placeFoodOrder(s, organizationId, locationId, { ...input, channel: 'pickup', contact: { ...input.contact } });
}

/** Called inside the transition transaction (e.g. hospitality reverses a charge-to-room folio line on reject/cancel). */
export const foodOrderTransitionHooks: Array<(tx: Tx, order: FoodOrderRow, from: FoodOrderState, to: FoodOrderState) => Promise<void>> = [];

/** Restaurant-side status change. Server acknowledges every transition; rejection/cancellation reverses payment. */
export async function transitionFoodOrder(s: Services, orderId: string, to: FoodOrderState, opts: { organizationId: string; actorUserId: string | null; note?: string; expectedFrom?: FoodOrderState }) {
  const updated = await s.db.transaction(async (tx) => {
    const [o] = await tx.select().from(foodOrders).where(and(eq(foodOrders.id, orderId), eq(foodOrders.organizationId, opts.organizationId))).for('update');
    if (!o) throw notFound('Order');
    const from = o.status as FoodOrderState;
    if (opts.expectedFrom && opts.expectedFrom !== from) throw new AppError(409, 'stale_status', `Order is now ${from}. Refresh and try again.`, undefined, { currentStatus: from });
    if (!canTransition(from, to, o.channel)) throw new AppError(409, 'invalid_transition', `Cannot move a ${o.channel.replace('_', '-')} order from ${from} to ${to}`, undefined, { currentStatus: from });
    if (to === 'accepted' && !['paid', 'not_required', 'on_tab'].includes(o.paymentStatus)) throw conflict('payment_pending', 'Payment has not been confirmed for this order yet');
    if (to === 'rejected' && !opts.note) throw validationError('A reason is required to reject an order', { note: 'Required' });
    const history = [...o.statusHistory, { at: new Date().toISOString(), from, to, by: opts.actorUserId, note: opts.note }];
    const [u] = await tx.update(foodOrders).set({ status: to, statusHistory: history, rejectionReason: to === 'rejected' ? opts.note ?? null : o.rejectionReason, updatedAt: new Date() }).where(eq(foodOrders.id, o.id)).returning();
    if (requiresRefund(to)) {
      await releaseOrderResources(tx, u!);
      await cancelKdsTickets(tx, o.id);
      await tx.update(foodDeliveries).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(foodDeliveries.orderId, o.id), inArray(foodDeliveries.status, ['pending', 'assigned'])));
    }
    for (const h of foodOrderTransitionHooks) await h(tx, u!, from, to);
    await audit(tx, { organizationId: o.organizationId, actorUserId: opts.actorUserId, action: `food_order.${to}`, scopeKind: 'location', scopeId: o.locationId, targetType: 'food_order', targetId: o.id, metadata: { from, to, note: opts.note } });
    return u!;
  });

  if (to === 'accepted') await createKdsTickets(s.db, updated);
  // Partner side effects (POS push on accept, marketplace status, courier cancellation) run as a background job.
  if (to === 'accepted' || updated.fulfilment.marketplace || requiresRefund(to)) await s.jobs.enqueue('foods.partner_order_event', { orderId: updated.id, to });
  let paymentAction: string = 'none';
  const [tabPayment] = requiresRefund(to) && updated.paymentId ? await s.db.select().from(paymentReferences).where(and(eq(paymentReferences.id, updated.paymentId), eq(paymentReferences.targetType, 'food_tab'))) : [];
  if (requiresRefund(to)) {
    if (updated.paymentStatus === 'on_tab') {
      paymentAction = 'removed_from_tab';
      await s.db.update(foodOrders).set({ paymentStatus: 'voided' }).where(eq(foodOrders.id, updated.id));
      updated.paymentStatus = 'voided';
    } else if (tabPayment && tabPayment.state === 'succeeded') {
      // Paid as part of a table tab: refund only this order's share.
      const amount = Math.min(updated.totalMinor, tabPayment.amountMinor - tabPayment.refundedMinor);
      let paymentStatus = updated.paymentStatus;
      if (amount > 0) {
        const r = await refundPayment(s, tabPayment.id, amount, { actorUserId: opts.actorUserId, reason: `Order ${updated.orderNumber} ${to}` });
        paymentAction = 'refunded';
        paymentStatus = r.refund.state === 'complete' ? 'refunded' : 'refund_pending';
      }
      await s.db.update(foodOrders).set({ paymentStatus }).where(eq(foodOrders.id, updated.id));
      updated.paymentStatus = paymentStatus;
    } else {
      const r = await reverseTargetPayment(s, updated.paymentId, opts.actorUserId, `Order ${to}: ${opts.note ?? ''}`.trim());
      paymentAction = r.action;
      const paymentStatus = r.action === 'refunded' ? (r.refundState === 'complete' ? 'refunded' : 'refund_pending') : r.action === 'voided' ? 'voided' : updated.paymentStatus;
      await s.db.update(foodOrders).set({ paymentStatus }).where(eq(foodOrders.id, updated.id));
      updated.paymentStatus = paymentStatus;
    }
  }
  const delivery = updated.channel === 'delivery';
  if (updated.contact.email && ['accepted', 'ready', 'rejected', 'cancelled', 'out_for_delivery', 'delivered'].includes(to)) {
    const msg: Record<string, string> = {
      accepted: delivery ? 'Your order has been accepted and will be delivered at your chosen time.' : 'Your order has been accepted and will be ready at your pickup time.',
      ready: updated.channel === 'dine_in' ? 'Your order is ready and on its way to your table.' : delivery ? 'Your order is ready and waiting for the driver.' : 'Your order is ready for pickup.',
      out_for_delivery: 'Your order is on its way.',
      delivered: 'Your order has been delivered. Enjoy!',
      rejected: `Sorry — the restaurant could not accept your order${opts.note ? ` (${opts.note})` : ''}. ${paymentAction === 'refunded' ? 'A full refund has been issued.' : paymentAction === 'voided' || paymentAction === 'removed_from_tab' ? 'You have not been charged.' : ''}`,
      cancelled: `Your order was cancelled. ${paymentAction === 'refunded' ? 'A full refund has been issued.' : ''}`,
    };
    await s.jobs.enqueue('email.send', { to: updated.contact.email, subject: `Order ${updated.orderNumber}: ${to.replace(/_/g, ' ')}`, text: msg[to]!, tag: 'food-order' });
  }
  if (to === 'accepted' || to === 'ready' || to === 'out_for_delivery') {
    const [loc] = await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, updated.locationId));
    const title = to === 'ready' ? `Order ${updated.orderNumber} is ready` : to === 'out_for_delivery' ? `Order ${updated.orderNumber} is on its way` : `Order ${updated.orderNumber} accepted`;
    const body = to === 'ready' ? (delivery ? `Your order is ready at ${loc?.name ?? 'the restaurant'} and waiting for the driver.` : `Your order is ready for pickup at ${loc?.name ?? 'the restaurant'}.`)
      : to === 'out_for_delivery' ? 'A driver has picked up your order.' : `${loc?.name ?? 'The restaurant'} accepted your order. We'll let you know when it's ready.`;
    await notify(s, { userIds: await userIdsForCustomer(s.db, updated.customerId), organizationId: updated.organizationId, category: 'order_status', title, body, data: { orderId: updated.id, status: to, url: `branchharbor://customer/orders/${updated.id}` } });
  }
  return { order: updated, paymentAction };
}

export function serializeFoodOrder(o: FoodOrderRow, opts: { includeContact?: boolean } = {}) {
  const m = (amount: number) => ({ amount, currency: o.currency });
  const { address, ...fulfilmentPublic } = o.fulfilment;
  return {
    id: o.id, orderNumber: o.orderNumber, locationId: o.locationId, status: o.status, paymentStatus: o.paymentStatus, channel: o.channel, lines: o.lines,
    subtotal: m(o.subtotalMinor), tax: m(o.taxMinor), serviceCharge: m(o.serviceChargeMinor), deliveryFee: m(o.deliveryFeeMinor), tip: m(o.tipMinor), total: m(o.totalMinor),
    pickupSlotId: o.pickupSlotId, promisedAt: o.promisedAt?.toISOString() ?? null, notes: o.notes, rejectionReason: o.rejectionReason,
    // Kitchen screens get the first name only — no unnecessary customer information on shared displays.
    contact: opts.includeContact ? o.contact : { name: o.contact.name.split(' ')[0] ?? '' },
    fulfilment: opts.includeContact ? o.fulfilment : { ...fulfilmentPublic, ...(address ? { address: { city: address.city, postalCode: address.postalCode } } : {}) },
    statusHistory: o.statusHistory, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
  };
}

/** Latest orders of a customer at a location (reorder support). */
export async function recentOrdersForCustomer(db: Exec, customerIds: string[], limit = 20) {
  if (!customerIds.length) return [];
  return db.select().from(foodOrders).where(inArray(foodOrders.customerId, customerIds)).orderBy(desc(foodOrders.createdAt)).limit(limit);
}


// A failed/cancelled payment cancels the unpaid order in the webhook: give back its slot capacity and stock.
paymentFailureHooks.push(async (tx, ref) => {
  if (ref.targetType !== 'food_order' || !ref.targetId) return;
  const [o] = await tx.select().from(foodOrders).where(eq(foodOrders.id, ref.targetId));
  if (o && o.status === 'cancelled') await releaseOrderResources(tx, o);
});
