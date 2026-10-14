import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  connections, fulfilmentSettings, giftCardLedger, giftCards, locationListings, locationVariants, locations, orderFulfilments, orders, organizations,
  paymentReferences, products, stockTransfers, taxRates, variants, type OrderLine,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { findOrCreateCustomer } from './customers.ts';
import { assertPaymentsEnabled, createPaymentForTarget, type PaymentRow } from './payments.ts';
import { applyMovement, availableOf, backorderPolicy, historyEntry, lockStock, nextNumber, releaseHeld, reserveLines, sellHeld } from './commerce-stock.ts';

type Location = typeof locations.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
type FulfilmentRow = typeof orderFulfilments.$inferSelect;
export type FulfilmentMethod = 'pickup' | 'local_delivery' | 'shipping';
const money = (amount: number, currency: string) => ({ amount, currency });

// ───────── Settings ─────────

export const FULFILMENT_DEFAULTS = {
  storefrontEnabled: true, pickupEnabled: true, pickupInstructions: null as string | null, pickupReadyMinutes: 120,
  localDeliveryEnabled: false, deliveryFeeMinor: 0, freeDeliveryOverMinor: null as number | null, deliveryPostcodes: [] as string[],
  shippingEnabled: false, shippingFeeMinor: 0, shippingCountries: [] as string[], crossLocationPickup: false, reservationMinutes: 15, returnWindowDays: 30,
};
export type FulfilmentConfig = typeof FULFILMENT_DEFAULTS & { configured: boolean };

export async function fulfilmentConfig(db: Exec, locationId: string): Promise<FulfilmentConfig> {
  const [row] = await db.select().from(fulfilmentSettings).where(eq(fulfilmentSettings.locationId, locationId));
  if (!row) return { ...FULFILMENT_DEFAULTS, configured: false };
  const { id: _i, organizationId: _o, locationId: _l, updatedBy: _u, updatedAt: _t, ...rest } = row;
  return { ...rest, configured: true };
}

/** An authoritative external commerce system (e.g. WooCommerce) for this location, if any. */
export async function externalCommerce(db: Exec, organizationId: string, locationId: string) {
  const rows = await db.select().from(connections).where(and(
    eq(connections.organizationId, organizationId), or(isNull(connections.locationId), eq(connections.locationId, locationId)),
    eq(connections.kind, 'commerce'), eq(connections.authoritative, 'external'), ne(connections.state, 'disconnected'),
  ));
  const c = rows.find((r) => r.locationId === locationId) ?? rows[0] ?? null;
  if (!c) return null;
  const url = typeof c.config.siteUrl === 'string' && c.config.siteUrl.startsWith('https://') ? c.config.siteUrl : null;
  return { connectionId: c.id, provider: c.provider, url };
}

// ───────── Tax ─────────

export interface TaxLine { name: string; rateBps: number; inclusive: boolean; amountMinor: number }

/**
 * Taxes from the location's configured rates only. Exclusive rates are added; inclusive rates are already in the
 * price and are shown as "includes". With no configured rate there is no tax line (never an assumed rate).
 */
export function computeTax(rates: Array<Pick<typeof taxRates.$inferSelect, 'name' | 'rateBps' | 'inclusive' | 'appliesToFulfilment'>>, merchandiseMinor: number, fulfilmentMinor: number) {
  const lines: TaxLine[] = [];
  const inclusive = rates.filter((r) => r.inclusive);
  const inclusiveBps = inclusive.reduce((a, r) => a + r.rateBps, 0);
  for (const r of rates) {
    const base = merchandiseMinor + (r.appliesToFulfilment ? fulfilmentMinor : 0);
    const amount = r.inclusive
      ? Math.round((base * r.rateBps) / (10_000 + inclusiveBps))
      : Math.round((base * r.rateBps) / 10_000);
    lines.push({ name: r.name, rateBps: r.rateBps, inclusive: r.inclusive, amountMinor: amount });
  }
  return { lines, addedMinor: lines.filter((l) => !l.inclusive).reduce((a, l) => a + l.amountMinor, 0) };
}

export async function activeTaxRates(db: Exec, locationId: string) {
  return db.select().from(taxRates).where(and(eq(taxRates.locationId, locationId), eq(taxRates.active, true))).orderBy(asc(taxRates.position), asc(taxRates.createdAt));
}

// ───────── Gift cards (lookup only; ledger lives in commerce-returns) ─────────

export const normaliseCode = (code: string) => code.trim().toUpperCase().replace(/[\s-]/g, '');

export async function findGiftCard(db: Exec, organizationId: string, code: string, lock = false) {
  const q = db.select().from(giftCards).where(and(eq(giftCards.organizationId, organizationId), eq(giftCards.codeHash, sha256(normaliseCode(code)))));
  const [card] = lock ? await q.for('update') : await q;
  return card ?? null;
}

export function giftCardUsable(card: typeof giftCards.$inferSelect | null, currency: string): { ok: true } | { ok: false; reason: string } {
  if (!card || card.status !== 'active') return { ok: false, reason: 'This gift card or credit code is not valid' };
  if (card.expiresAt && card.expiresAt < new Date()) return { ok: false, reason: 'This gift card has expired' };
  if (card.currency !== currency) return { ok: false, reason: `This balance is in ${card.currency} and can only be used at ${card.currency} stores` };
  if (card.balanceMinor <= 0) return { ok: false, reason: 'This gift card has no balance left' };
  return { ok: true };
}

// ───────── Pricing ─────────

export interface CartLineInput { variantId: string; quantity: number }
export interface FulfilmentInput {
  method: FulfilmentMethod;
  /** Pickup at another store of the same brand and currency (stock is transferred there). */
  collectLocationId?: string;
  address?: { line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string };
}

export interface PricedLine {
  variantId: string; productId: string; sku: string; name: string; productName: string; variantName: string; options: Record<string, string>;
  quantity: number; unitPriceMinor: number; lineTotalMinor: number; availability: 'in_stock' | 'backorder' | 'unavailable'; message: string | null;
}

/** Sellable variants at a location: product active and listed there, variant active, location toggle on, price in the location currency. */
export async function sellableVariants(db: Exec, organizationId: string, loc: Location, variantIds: string[]) {
  if (!variantIds.length) return new Map<string, { v: typeof variants.$inferSelect; p: typeof products.$inferSelect; lv: typeof locationVariants.$inferSelect | null; listed: boolean; price: number | null }>();
  const rows = await db.select({ v: variants, p: products }).from(variants).innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.organizationId, organizationId), inArray(variants.id, variantIds)));
  const lvs = await db.select().from(locationVariants).where(and(eq(locationVariants.locationId, loc.id), inArray(locationVariants.variantId, variantIds)));
  const listings = rows.length ? await db.select().from(locationListings).where(and(eq(locationListings.locationId, loc.id), inArray(locationListings.productId, [...new Set(rows.map((r) => r.p.id))]))) : [];
  const out = new Map();
  for (const { v, p } of rows) {
    const lv = lvs.find((x) => x.variantId === v.id) ?? null;
    const listed = listings.some((l) => l.productId === p.id && l.status === 'listed' && l.snapshot.variants.some((sv) => sv.id === v.id));
    out.set(v.id, { v, p, lv, listed, price: lv?.priceMinor ?? v.prices[loc.currency] ?? null });
  }
  return out;
}

export async function priceCart(db: Exec, organizationId: string, loc: Location, input: { lines: CartLineInput[]; fulfilment: FulfilmentInput; giftCardCode?: string | null }) {
  if (!input.lines.length) throw validationError('Your cart is empty', { lines: 'Add at least one item' });
  const cfg = await fulfilmentConfig(db, loc.id);
  const sell = await sellableVariants(db, organizationId, loc, [...new Set(input.lines.map((l) => l.variantId))]);
  const policy = await backorderPolicy(db, [...sell.keys()]);
  const issues: Array<{ field: string; message: string }> = [];
  const collect = await validateFulfilment(db, organizationId, loc, cfg, input.fulfilment, issues);

  const demand = new Map<string, number>();
  for (const l of input.lines) demand.set(l.variantId, (demand.get(l.variantId) ?? 0) + l.quantity);
  const lines: PricedLine[] = input.lines.map((l, i) => {
    const s = sell.get(l.variantId);
    if (!s || s.p.status !== 'active' || !s.listed || s.v.status !== 'active' || (s.lv && !s.lv.available) || s.price === null) {
      issues.push({ field: `lines.${i}.variantId`, message: s ? `${s.p.name} (${s.v.name}) is not available at ${loc.name}` : 'This item no longer exists' });
      return { variantId: l.variantId, productId: s?.p.id ?? '', sku: s?.v.sku ?? '', name: s ? `${s.p.name} — ${s.v.name}` : 'Unavailable item', productName: s?.p.name ?? '', variantName: s?.v.name ?? '', options: s?.v.options ?? {}, quantity: l.quantity, unitPriceMinor: 0, lineTotalMinor: 0, availability: 'unavailable', message: 'Not available at this store' };
    }
    const free = s.lv ? Math.max(0, availableOf(s.lv)) : 0;
    const need = demand.get(l.variantId)!;
    const backorder = s.lv?.allowBackorder ?? policy.get(l.variantId) ?? false;
    let availability: PricedLine['availability'] = 'in_stock';
    let message: string | null = null;
    if (free < need) {
      if (backorder && !collect.transfer) { availability = 'backorder'; message = free > 0 ? `${free} ready now, ${need - free} on backorder` : 'On backorder — ships when restocked'; }
      else {
        availability = 'unavailable'; message = free > 0 ? `Only ${free} left` : 'Out of stock';
        issues.push({ field: `lines.${i}.quantity`, message: `${s.p.name} (${s.v.name}): ${message}` });
      }
    }
    return { variantId: l.variantId, productId: s.p.id, sku: s.v.sku, name: `${s.p.name} — ${s.v.name}`, productName: s.p.name, variantName: s.v.name, options: s.v.options, quantity: l.quantity, unitPriceMinor: s.price, lineTotalMinor: s.price * l.quantity, availability, message };
  });

  const subtotal = lines.reduce((a, l) => a + l.lineTotalMinor, 0);
  let fee = 0;
  if (input.fulfilment.method === 'local_delivery') fee = cfg.freeDeliveryOverMinor !== null && subtotal >= cfg.freeDeliveryOverMinor ? 0 : cfg.deliveryFeeMinor;
  if (input.fulfilment.method === 'shipping') fee = cfg.shippingFeeMinor;
  const rates = await activeTaxRates(db, loc.id);
  const tax = computeTax(rates, subtotal, fee);
  const total = subtotal + fee + tax.addedMinor;

  let credit: { appliedMinor: number; balanceMinor: number; currency: string; last4: string } | null = null;
  if (input.giftCardCode) {
    const card = await findGiftCard(db, organizationId, input.giftCardCode);
    const ok = giftCardUsable(card, loc.currency);
    if (!ok.ok) issues.push({ field: 'giftCardCode', message: ok.reason });
    else credit = { appliedMinor: Math.min(card!.balanceMinor, total), balanceMinor: card!.balanceMinor, currency: card!.currency, last4: card!.codeLast4 };
  }
  return {
    location: { id: loc.id, name: loc.name, currency: loc.currency },
    lines, subtotalMinor: subtotal, fulfilmentFeeMinor: fee, taxLines: tax.lines, taxAddedMinor: tax.addedMinor, taxConfigured: rates.length > 0, totalMinor: total,
    credit, amountDueMinor: total - (credit?.appliedMinor ?? 0),
    fulfilment: { method: input.fulfilment.method, collectLocation: collect.location ? { id: collect.location.id, name: collect.location.name } : null, transfer: collect.transfer, readyEstimateMinutes: input.fulfilment.method === 'pickup' ? (collect.transfer ? null : cfg.pickupReadyMinutes) : null },
    reservationMinutes: cfg.reservationMinutes, issues, config: cfg,
  };
}

export type Quote = Awaited<ReturnType<typeof priceCart>>;

export function serializeQuote(q: Quote) {
  const c = q.location.currency;
  return {
    location: q.location,
    lines: q.lines.map((l) => ({ variantId: l.variantId, productId: l.productId, sku: l.sku, name: l.name, productName: l.productName, variantName: l.variantName, options: l.options, quantity: l.quantity, unitPrice: money(l.unitPriceMinor, c), lineTotal: money(l.lineTotalMinor, c), availability: l.availability, message: l.message })),
    subtotal: money(q.subtotalMinor, c), fulfilmentFee: money(q.fulfilmentFeeMinor, c),
    taxLines: q.taxLines.map((t) => ({ name: t.name, rateBps: t.rateBps, inclusive: t.inclusive, amount: money(t.amountMinor, c) })),
    taxConfigured: q.taxConfigured, total: money(q.totalMinor, c),
    credit: q.credit ? { applied: money(q.credit.appliedMinor, c), balance: money(q.credit.balanceMinor, c), last4: q.credit.last4 } : null,
    amountDue: money(q.amountDueMinor, c), fulfilment: q.fulfilment, reservationMinutes: q.reservationMinutes,
    issues: q.issues, ok: q.issues.length === 0,
  };
}

async function validateFulfilment(db: Exec, organizationId: string, loc: Location, cfg: FulfilmentConfig, f: FulfilmentInput, issues: Array<{ field: string; message: string }>) {
  let collectLoc: Location | null = null;
  let transfer = false;
  if (f.method === 'pickup') {
    if (f.collectLocationId && f.collectLocationId !== loc.id) {
      const [other] = await db.select().from(locations).where(and(eq(locations.id, f.collectLocationId), eq(locations.organizationId, organizationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
      const otherCfg = other ? await fulfilmentConfig(db, other.id) : null;
      if (!other || !otherCfg?.pickupEnabled || !otherCfg.crossLocationPickup) issues.push({ field: 'fulfilment.collectLocationId', message: 'Collection at that store is not available' });
      else if (other.currency !== loc.currency) issues.push({ field: 'fulfilment.collectLocationId', message: `${other.name} prices in ${other.currency}; choose a store that sells in ${loc.currency}` });
      else { collectLoc = other; transfer = true; }
    } else if (!cfg.pickupEnabled) issues.push({ field: 'fulfilment.method', message: `Pickup is not offered at ${loc.name}` });
    else collectLoc = loc;
  } else if (f.method === 'local_delivery') {
    if (!cfg.localDeliveryEnabled) issues.push({ field: 'fulfilment.method', message: `Local delivery is not offered by ${loc.name}` });
    else if (!f.address) issues.push({ field: 'fulfilment.address', message: 'Enter a delivery address' });
    else if (f.address.country.toUpperCase() !== loc.country) issues.push({ field: 'fulfilment.address.country', message: 'Local delivery only covers addresses near the store' });
    else if (cfg.deliveryPostcodes.length && !cfg.deliveryPostcodes.some((p) => f.address!.postalCode.replace(/\s/g, '').toUpperCase().startsWith(p.replace(/\s/g, '').toUpperCase()))) {
      issues.push({ field: 'fulfilment.address.postalCode', message: 'This postcode is outside the local delivery area' });
    }
  } else if (f.method === 'shipping') {
    if (!cfg.shippingEnabled) issues.push({ field: 'fulfilment.method', message: `${loc.name} does not ship orders` });
    else if (!f.address) issues.push({ field: 'fulfilment.address', message: 'Enter a shipping address' });
    else if (!cfg.shippingCountries.map((c) => c.toUpperCase()).includes(f.address.country.toUpperCase())) issues.push({ field: 'fulfilment.address.country', message: 'We do not ship to this country' });
  }
  return { location: collectLoc, transfer };
}

// ───────── Checkout ─────────

export interface CheckoutInput {
  lines: CartLineInput[];
  fulfilment: FulfilmentInput;
  contact: { name: string; email: string; phone?: string; marketingConsent?: boolean };
  giftCardCode?: string | null;
  notes?: string | null;
  expectedTotalMinor?: number;
  idempotencyKey?: string | null;
  userId?: string | null;
}

/** Location may take native storefront orders: visible, storefront on, and no external system is authoritative. */
export async function assertNativeStorefront(db: Exec, loc: Location) {
  const ext = await externalCommerce(db, loc.organizationId, loc.id);
  if (ext) throw new AppError(409, 'external_checkout', `Orders for ${loc.name} are taken on the store's ${ext.provider} site, the authoritative order system.`, undefined, { provider: ext.provider, url: ext.url });
  const cfg = await fulfilmentConfig(db, loc.id);
  if (!cfg.storefrontEnabled) throw conflict('storefront_disabled', `${loc.name} is not taking online orders right now`);
  return cfg;
}

export async function createCheckout(s: Services, loc: Location, input: CheckoutInput) {
  const cfg = await assertNativeStorefront(s.db, loc);
  if (input.idempotencyKey) {
    const [existing] = await s.db.select().from(orders).where(and(eq(orders.organizationId, loc.organizationId), eq(orders.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      // Retry of the same checkout: never a second order. Rotate the manage token so the caller can follow it.
      const manageToken = randomToken();
      await s.db.update(orders).set({ manageTokenHash: sha256(manageToken) }).where(eq(orders.id, existing.id));
      const [p] = existing.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, existing.paymentId)) : [];
      return { order: existing, manageToken, payment: p ? { id: p.id, clientSecret: p.clientSecret, sandbox: p.sandbox === 1 } : null, duplicate: true };
    }
  }
  const quote = await priceCart(s.db, loc.organizationId, loc, input);
  if (quote.issues.length) {
    const fields = Object.fromEntries(quote.issues.map((i) => [i.field, i.message]));
    if (quote.issues.every((i) => /^lines\.\d+\.quantity$/.test(i.field))) throw new AppError(409, 'out_of_stock', quote.issues[0]!.message, fields);
    throw validationError(quote.issues[0]!.message, fields);
  }
  if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== quote.totalMinor) {
    throw new AppError(409, 'price_changed', 'Prices or availability changed. Review your order.', undefined, { totalMinor: quote.totalMinor, currency: loc.currency });
  }
  if (quote.amountDueMinor > 0) await assertPaymentsEnabled(s.db, loc.organizationId, loc.id);
  const manageToken = randomToken();
  const collectLocationId = quote.fulfilment.collectLocation && quote.fulfilment.collectLocation.id !== loc.id ? quote.fulfilment.collectLocation.id : null;

  const order = await s.db.transaction(async (tx) => {
    const customer = await findOrCreateCustomer(tx, loc.organizationId, loc.id, input.contact, 'commerce_order');
    const number = `${loc.code}-${await nextNumber(tx, loc.organizationId, `order:${loc.id}`)}`;
    const expires = new Date(Date.now() + cfg.reservationMinutes * 60_000);
    const [o] = await tx.insert(orders).values({
      organizationId: loc.organizationId, locationId: loc.id, customerId: customer.id, userId: input.userId ?? null, source: 'native', status: 'pending_payment', paymentStatus: 'pending',
      fulfilmentStatus: 'unfulfilled', fulfilmentMethod: input.fulfilment.method, fulfilmentLocationId: collectLocationId, currency: loc.currency,
      subtotalMinor: quote.subtotalMinor, taxMinor: quote.taxAddedMinor, discountMinor: 0, totalMinor: quote.totalMinor, fulfilmentFeeMinor: quote.fulfilmentFeeMinor,
      taxLines: quote.taxLines, orderNumber: number, customerName: input.contact.name, customerEmail: input.contact.email.trim().toLowerCase(), customerPhone: input.contact.phone ?? null,
      shippingAddress: input.fulfilment.method === 'pickup' ? null : (input.fulfilment.address as Record<string, string>), notes: input.notes ?? null,
      reservationExpiresAt: expires, manageTokenHash: sha256(manageToken), idempotencyKey: input.idempotencyKey ?? null,
      lines: quote.lines.map((l) => ({ variantId: l.variantId, productId: l.productId, sku: l.sku, name: l.name, productName: l.productName, options: l.options, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      history: [historyEntry('placed', null, `Checkout on the ${loc.name} storefront`)],
    }).returning();
    const policy = await backorderPolicy(tx, o!.lines.map((l) => l.variantId));
    const alloc = await reserveLines(tx, { organizationId: loc.organizationId, locationId: loc.id, reference: o!.id, note: `Checkout ${number}` }, o!.lines,
      (variantId, lv) => !collectLocationId && (lv.allowBackorder ?? policy.get(variantId) ?? false));
    const lines: OrderLine[] = o!.lines.map((l, i) => ({ ...l, allocated: alloc[i]!.allocated, backordered: alloc[i]!.backordered }));
    let credit = 0;
    if (input.giftCardCode) {
      const card = await findGiftCard(tx, loc.organizationId, input.giftCardCode, true);
      const ok = giftCardUsable(card, loc.currency);
      if (!ok.ok) throw validationError(ok.reason, { giftCardCode: ok.reason });
      credit = Math.min(card!.balanceMinor, quote.totalMinor);
      const balance = card!.balanceMinor - credit;
      await tx.update(giftCards).set({ balanceMinor: balance, updatedAt: new Date() }).where(eq(giftCards.id, card!.id));
      await tx.insert(giftCardLedger).values({ organizationId: loc.organizationId, giftCardId: card!.id, kind: 'redeem', amountMinor: -credit, balanceAfterMinor: balance, orderId: o!.id, note: `Order ${number}` });
    }
    const [u] = await tx.update(orders).set({ lines, creditAppliedMinor: credit }).where(eq(orders.id, o!.id)).returning();
    await audit(tx, { organizationId: loc.organizationId, actorUserId: input.userId ?? null, actorType: input.userId ? 'user' : 'system', action: 'order.placed', scopeKind: 'location', scopeId: loc.id, targetType: 'order', targetId: o!.id, metadata: { totalMinor: quote.totalMinor, currency: loc.currency, method: input.fulfilment.method, collectLocationId } });
    if (quote.totalMinor - credit === 0) return markPaid(tx, u!, null, 'Paid in full with gift card / store credit');
    return u!;
  });

  if (order.paymentStatus === 'paid') return { order, manageToken, payment: null, duplicate: false };
  const p = await createPaymentForTarget(s, {
    organizationId: loc.organizationId, locationId: loc.id, amountMinor: order.totalMinor - order.creditAppliedMinor, currency: loc.currency, targetType: 'order', targetId: order.id,
    description: `${order.orderNumber} · ${loc.name}`,
  });
  const [linked] = await s.db.update(orders).set({ paymentId: p.payment.id }).where(eq(orders.id, order.id)).returning();
  return { order: linked!, manageToken, payment: { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox }, duplicate: false };
}

// ───────── Payment outcomes ─────────

/** Paid: sell the held units (or keep them held for a transfer to the collection store). */
export async function markPaid(tx: Tx, o: OrderRow, paymentId: string | null, note: string): Promise<OrderRow> {
  const ctx = { organizationId: o.organizationId, locationId: o.locationId, reference: o.id };
  const cross = !!o.fulfilmentLocationId && o.fulfilmentLocationId !== o.locationId;
  let fulfilmentStatus = o.lines.some((l) => (l.backordered ?? 0) > 0) ? 'backordered' : 'unfulfilled';
  if (cross) {
    const number = `TR-${await nextNumber(tx, o.organizationId, 'transfer')}`;
    const vs = o.lines.filter((l) => (l.allocated ?? l.quantity) > 0);
    await tx.insert(stockTransfers).values({
      organizationId: o.organizationId, number, fromLocationId: o.locationId, toLocationId: o.fulfilmentLocationId!, status: 'approved', orderId: o.id,
      reason: `Customer collection for order ${o.orderNumber ?? o.id.slice(0, 8)}`,
      lines: vs.map((l) => ({ variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.allocated ?? l.quantity, shipped: 0, received: 0 })),
      history: [historyEntry('approved', null, 'Created automatically for a paid cross-store collection order')],
    });
    fulfilmentStatus = 'awaiting_transfer';
  } else {
    await sellHeld(tx, ctx, o.lines.map((l) => ({ variantId: l.variantId, quantity: l.allocated ?? l.quantity })));
  }
  const [u] = await tx.update(orders).set({
    status: 'paid', paymentStatus: 'paid', fulfilmentStatus, paidAt: new Date(), reservationExpiresAt: null, ...(paymentId ? { paymentId } : {}),
    history: [...o.history, historyEntry('paid', null, note)], updatedAt: new Date(),
  }).where(eq(orders.id, o.id)).returning();
  return u!;
}

/**
 * Called from the payment webhook processor when a commerce order's payment succeeds.
 * Recovery path: a payment that lands after the reservation expired re-allocates stock if it is still free;
 * otherwise the order is kept as paid with fulfilment `stock_conflict` and surfaces in the reconciliation
 * queue (never silently oversold, never silently dropped).
 */
export async function fulfilCommerceOrderPayment(tx: Tx, p: PaymentRow): Promise<{ fulfilled: boolean; note: string }> {
  const [o] = await tx.select().from(orders).where(eq(orders.id, p.targetId!)).for('update');
  if (!o) return { fulfilled: false, note: 'Order record missing' };
  if (o.paymentStatus === 'paid') return { fulfilled: true, note: 'Already paid' };
  if (o.status === 'cancelled') {
    await tx.update(orders).set({ paymentStatus: 'paid', paymentId: p.id, attention: 'paid_after_cancel', history: [...o.history, historyEntry('payment_after_cancel', null, 'Payment arrived after the order was cancelled — refund it')], updatedAt: new Date() }).where(eq(orders.id, o.id));
    return { fulfilled: false, note: 'Order was cancelled before the payment arrived — needs a refund' };
  }
  // Legacy/staff-recorded unpaid orders (no reservation expiry) keep the original behaviour.
  if (o.status === 'pending_payment' && !o.reservationExpiresAt) {
    await markPaid(tx, o, p.id, 'Payment confirmed');
    return { fulfilled: true, note: 'Order paid' };
  }
  const lapsed = o.status === 'expired' || (o.status === 'pending_payment' && !!o.reservationExpiresAt && o.reservationExpiresAt < new Date());
  if (!lapsed) {
    await markPaid(tx, o, p.id, 'Payment confirmed');
    return { fulfilled: true, note: 'Order paid' };
  }
  let cur = o;
  if (o.status === 'pending_payment') cur = await expireOrder(tx, o, 'Reservation lapsed before the payment was confirmed');
  return recoverLatePayment(tx, cur, p.id);
}

async function recoverLatePayment(tx: Tx, o: OrderRow, paymentId: string): Promise<{ fulfilled: boolean; note: string }> {
  const policy = await backorderPolicy(tx, o.lines.map((l) => l.variantId));
  // Re-apply any gift-card credit that was returned when the reservation lapsed.
  if (o.creditAppliedMinor > 0) {
    const [last] = await tx.select().from(giftCardLedger).where(and(eq(giftCardLedger.orderId, o.id), eq(giftCardLedger.kind, 'reversal'))).orderBy(desc(giftCardLedger.createdAt)).limit(1);
    const [card] = last ? await tx.select().from(giftCards).where(eq(giftCards.id, last.giftCardId)).for('update') : [];
    if (!card || card.balanceMinor < o.creditAppliedMinor) return conflictOutcome(tx, o, paymentId, 'credit_unavailable', 'Paid after the reservation expired, but the gift card credit was used elsewhere — collect the difference or refund');
    const bal = card.balanceMinor - o.creditAppliedMinor;
    await tx.update(giftCards).set({ balanceMinor: bal, updatedAt: new Date() }).where(eq(giftCards.id, card.id));
    await tx.insert(giftCardLedger).values({ organizationId: o.organizationId, giftCardId: card.id, kind: 'redeem', amountMinor: -o.creditAppliedMinor, balanceAfterMinor: bal, orderId: o.id, note: 'Re-applied after late payment' });
  }
  const cross = !!o.fulfilmentLocationId && o.fulfilmentLocationId !== o.locationId;
  // The hold was released at expiry (allocated = 0); try to hold again what was originally held.
  const want = o.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity - (l.backordered ?? 0) }));
  // Check first (locks rows), then reserve only if every line can be covered.
  let feasible = true;
  for (const w of [...want].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    if (w.quantity <= 0) continue;
    const lv = await lockStock(tx, o.organizationId, o.locationId, w.variantId);
    const free = Math.max(0, availableOf(lv));
    const backorder = !cross && (lv.allowBackorder ?? policy.get(w.variantId) ?? false);
    if (free < w.quantity && !backorder) feasible = false;
  }
  if (!feasible) return conflictOutcome(tx, o, paymentId, 'paid_after_expiry_no_stock', 'Paid after the reservation expired and the stock was sold meanwhile — choose a recovery action');
  const alloc = await reserveLines(tx, { organizationId: o.organizationId, locationId: o.locationId, reference: o.id, note: 'Re-allocated after late payment' }, want.filter((w) => w.quantity > 0), () => !cross);
  const lines = o.lines.map((l) => {
    const a = alloc.find((x) => x.variantId === l.variantId);
    return a ? { ...l, allocated: a.allocated, backordered: (l.backordered ?? 0) + a.backordered } : { ...l, allocated: 0 };
  });
  const [u] = await tx.update(orders).set({ lines, status: 'pending_payment', paymentStatus: 'pending' }).where(eq(orders.id, o.id)).returning();
  await markPaid(tx, u!, paymentId, 'Paid after the reservation expired — stock was still available and has been re-allocated');
  return { fulfilled: true, note: 'Paid after reservation expired; stock re-allocated' };
}

async function conflictOutcome(tx: Tx, o: OrderRow, paymentId: string, attention: string, note: string) {
  await tx.update(orders).set({
    status: 'paid', paymentStatus: 'paid', paymentId, paidAt: new Date(), fulfilmentStatus: 'stock_conflict', attention,
    lines: o.lines.map((l) => ({ ...l, allocated: 0 })), history: [...o.history, historyEntry('needs_attention', null, note)], updatedAt: new Date(),
  }).where(eq(orders.id, o.id));
  await audit(tx, { organizationId: o.organizationId, actorUserId: null, actorType: 'system', action: 'order.payment_needs_recovery', scopeKind: 'location', scopeId: o.locationId, targetType: 'order', targetId: o.id, metadata: { attention } });
  return { fulfilled: false, note };
}

/** The payment intent was cancelled (or definitively failed): free the stock now. */
export async function commerceOrderPaymentEnded(tx: Tx, p: PaymentRow, state: string) {
  const [o] = await tx.select().from(orders).where(eq(orders.id, p.targetId!)).for('update');
  if (!o || o.status !== 'pending_payment') return;
  if (state === 'cancelled') await expireOrder(tx, o, 'Payment cancelled');
  else await tx.update(orders).set({ paymentStatus: 'failed', history: [...o.history, historyEntry('payment_failed', null, 'Card payment failed — the customer can try again until the reservation ends')], updatedAt: new Date() }).where(eq(orders.id, o.id));
}

/** Release the hold, return any gift-card credit and mark the order expired. */
export async function expireOrder(tx: Tx, o: OrderRow, note: string, status: 'expired' | 'cancelled' = 'expired'): Promise<OrderRow> {
  await releaseHeld(tx, { organizationId: o.organizationId, locationId: o.locationId, reference: o.id, note }, o.lines.map((l) => ({ variantId: l.variantId, quantity: l.allocated ?? 0 })));
  if (o.creditAppliedMinor > 0) {
    const [redeem] = await tx.select().from(giftCardLedger).where(and(eq(giftCardLedger.orderId, o.id), eq(giftCardLedger.kind, 'redeem'))).orderBy(desc(giftCardLedger.createdAt)).limit(1);
    if (redeem) {
      const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, redeem.giftCardId)).for('update');
      const bal = card!.balanceMinor + o.creditAppliedMinor;
      await tx.update(giftCards).set({ balanceMinor: bal, updatedAt: new Date() }).where(eq(giftCards.id, card!.id));
      await tx.insert(giftCardLedger).values({ organizationId: o.organizationId, giftCardId: card!.id, kind: 'reversal', amountMinor: o.creditAppliedMinor, balanceAfterMinor: bal, orderId: o.id, note });
    }
  }
  const [u] = await tx.update(orders).set({
    status, paymentStatus: o.paymentStatus === 'paid' ? 'paid' : status === 'expired' ? 'expired' : 'cancelled', fulfilmentStatus: 'cancelled',
    reservationExpiresAt: null, cancelledAt: new Date(), lines: o.lines.map((l) => ({ ...l, allocated: 0 })),
    history: [...o.history, historyEntry(status, null, note)], updatedAt: new Date(),
  }).where(eq(orders.id, o.id)).returning();
  return u!;
}

/** Sweep: release reservations whose payment window lapsed and cancel their payment intents. */
export async function expireReservations(s: Services, opts: { organizationId?: string; locationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const conds = [eq(orders.status, 'pending_payment'), lt(orders.reservationExpiresAt, now)];
  if (opts.organizationId) conds.push(eq(orders.organizationId, opts.organizationId));
  if (opts.locationId) conds.push(eq(orders.locationId, opts.locationId));
  const due = await s.db.select({ id: orders.id }).from(orders).where(and(...conds)).limit(200);
  let expired = 0;
  for (const { id } of due) {
    const paymentId = await s.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, id)).for('update', { skipLocked: true });
      if (!o || o.status !== 'pending_payment' || !o.reservationExpiresAt || o.reservationExpiresAt >= now) return undefined;
      await expireOrder(tx, o, 'Payment window ended — reserved stock released');
      expired++;
      return o.paymentId;
    });
    if (paymentId) {
      const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, paymentId));
      if (p && ['created', 'requires_action'].includes(p.state)) {
        await s.payments.cancelPaymentIntent(p.externalId, p.connectedAccountId).catch((err) => s.log.warn({ err }, 'cancel intent failed'));
        await s.db.update(paymentReferences).set({ state: 'cancelled', updatedAt: new Date() }).where(and(eq(paymentReferences.id, p.id), inArray(paymentReferences.state, ['created', 'requires_action'])));
      }
    }
  }
  return { expired };
}

// ───────── Fulfilment ─────────

export const COMPLETE_FULFILMENT = ['shipped', 'delivered', 'collected'];
const FULFILMENT_FLOW: Record<string, Record<FulfilmentMethod, string[]>> = {
  picking: { pickup: ['packed', 'cancelled'], local_delivery: ['packed', 'cancelled'], shipping: ['packed', 'cancelled'] },
  packed: { pickup: ['ready', 'cancelled'], local_delivery: ['out_for_delivery', 'cancelled'], shipping: ['shipped', 'cancelled'] },
  ready: { pickup: ['collected', 'cancelled'], local_delivery: [], shipping: [] },
  out_for_delivery: { pickup: [], local_delivery: ['delivered'], shipping: [] },
  shipped: { pickup: [], local_delivery: [], shipping: ['delivered'] },
};

export function fulfilmentNext(f: Pick<FulfilmentRow, 'status' | 'method'>): string[] {
  return FULFILMENT_FLOW[f.status]?.[f.method as FulfilmentMethod] ?? [];
}

/** Units of each line already in non-cancelled fulfilments. */
function inFulfilment(fs: FulfilmentRow[]) {
  const m = new Map<string, number>();
  for (const f of fs) if (f.status !== 'cancelled') for (const l of f.lines) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  return m;
}

export async function orderTransfer(db: Exec, orderId: string) {
  const [t] = await db.select().from(stockTransfers).where(and(eq(stockTransfers.orderId, orderId), ne(stockTransfers.status, 'cancelled'), ne(stockTransfers.status, 'rejected'))).orderBy(desc(stockTransfers.createdAt)).limit(1);
  return t ?? null;
}

export function computeFulfilmentStatus(o: OrderRow, fs: FulfilmentRow[], transfer: typeof stockTransfers.$inferSelect | null): string {
  if (o.status === 'cancelled' || o.status === 'expired') return 'cancelled';
  if (o.fulfilmentStatus === 'stock_conflict' && o.attention) return 'stock_conflict';
  if (o.paymentStatus !== 'paid' && o.paymentStatus !== 'external' && o.paymentStatus !== 'not_required') return o.fulfilmentStatus === 'cancelled' ? 'cancelled' : 'unfulfilled';
  const lines = o.lines.filter((l) => !l.unmapped);
  const total = lines.reduce((a, l) => a + l.quantity, 0);
  const done = fs.filter((f) => COMPLETE_FULFILMENT.includes(f.status)).reduce((a, f) => a + f.lines.reduce((b, l) => b + l.quantity, 0), 0);
  if (total > 0 && done >= total) return 'fulfilled';
  const active = fs.filter((f) => f.status !== 'cancelled' && !COMPLETE_FULFILMENT.includes(f.status));
  if (active.some((f) => f.status === 'ready')) return 'ready_for_pickup';
  if (active.some((f) => f.status === 'out_for_delivery')) return 'out_for_delivery';
  if (done > 0) return 'partially_fulfilled';
  if (active.some((f) => f.status === 'packed')) return 'packed';
  if (active.some((f) => f.status === 'picking')) return 'picking';
  if (transfer && transfer.status !== 'received') return 'awaiting_transfer';
  if (lines.some((l) => (l.backordered ?? 0) > 0)) return 'backordered';
  return 'unfulfilled';
}

export async function refreshFulfilmentStatus(tx: Exec, orderId: string, by: string | null, event?: string) {
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!o) return null;
  const fs = await tx.select().from(orderFulfilments).where(eq(orderFulfilments.orderId, o.id));
  const next = computeFulfilmentStatus(o, fs, await orderTransfer(tx, o.id));
  const set: Partial<typeof orders.$inferInsert> = { fulfilmentStatus: next, updatedAt: new Date() };
  if (next !== o.fulfilmentStatus) set.history = [...o.history, historyEntry(event ?? next, by)];
  if (next === 'fulfilled' && !o.fulfilledAt) { set.fulfilledAt = new Date(); if (o.status === 'paid') set.status = 'fulfilled'; }
  const [u] = await tx.update(orders).set(set).where(eq(orders.id, o.id)).returning();
  return u!;
}

/** Start picking: a fulfilment for everything that can ship now (or the given quantities). */
export async function startFulfilment(s: Services, o: OrderRow, by: string, wanted?: Array<{ variantId: string; quantity: number }>) {
  return s.db.transaction(async (tx) => {
    const [cur] = await tx.select().from(orders).where(eq(orders.id, o.id)).for('update');
    if (!cur) throw notFound('Order');
    if (!['paid', 'external', 'not_required'].includes(cur.paymentStatus) && cur.paymentStatus !== 'partially_refunded') throw conflict('order_not_paid', 'Only paid orders can be fulfilled');
    if (cur.status === 'cancelled' || cur.fulfilmentStatus === 'stock_conflict') throw conflict('order_needs_attention', 'Resolve this order before fulfilling it');
    const transfer = await orderTransfer(tx, cur.id);
    if (transfer && transfer.status !== 'received') throw conflict('awaiting_transfer', `Waiting for transfer ${transfer.number} to arrive at the collection store`);
    const fs = await tx.select().from(orderFulfilments).where(eq(orderFulfilments.orderId, cur.id));
    const used = inFulfilment(fs);
    const lines = cur.lines.filter((l) => !l.unmapped).map((l) => {
      const max = l.quantity - (l.backordered ?? 0) - (used.get(l.variantId) ?? 0);
      const w = wanted ? wanted.find((x) => x.variantId === l.variantId)?.quantity ?? 0 : max;
      if (w > max) throw conflict('quantity_exceeds_open', `${l.name}: only ${Math.max(0, max)} can be fulfilled now`, { variantId: l.variantId, open: Math.max(0, max) });
      return { variantId: l.variantId, sku: l.sku, name: l.name, quantity: Math.max(0, w), picked: 0 };
    }).filter((l) => l.quantity > 0);
    if (!lines.length) throw conflict('nothing_to_fulfil', 'Nothing on this order can be fulfilled right now (backordered or already in progress)');
    const [f] = await tx.insert(orderFulfilments).values({
      organizationId: cur.organizationId, orderId: cur.id, locationId: cur.fulfilmentLocationId ?? cur.locationId, method: cur.fulfilmentMethod, status: 'picking', lines, pickedBy: by,
    }).returning();
    await refreshFulfilmentStatus(tx, cur.id, by, 'picking_started');
    await audit(tx, { organizationId: cur.organizationId, actorUserId: by, action: 'order.fulfilment_started', scopeKind: 'location', scopeId: f!.locationId, targetType: 'order', targetId: cur.id, metadata: { fulfilmentId: f!.id } });
    return f!;
  });
}

/** Record picked quantities (scan or tap). Short picks reduce the line before packing. */
export async function pickLines(s: Services, f: FulfilmentRow, picks: Array<{ variantId: string; picked: number; quantity?: number }>, by: string) {
  if (f.status !== 'picking') throw conflict('not_picking', 'This fulfilment is no longer being picked');
  const lines = f.lines.map((l) => {
    const p = picks.find((x) => x.variantId === l.variantId);
    if (!p) return l;
    const quantity = p.quantity !== undefined ? Math.min(l.quantity, p.quantity) : l.quantity;
    if (p.picked > quantity || p.picked < 0) throw validationError(`${l.name}: picked must be between 0 and ${quantity}`, { [`lines.${l.variantId}`]: 'Invalid quantity' });
    return { ...l, quantity, picked: p.picked };
  }).filter((l) => l.quantity > 0);
  const [u] = await s.db.update(orderFulfilments).set({ lines, pickedBy: by, updatedAt: new Date() }).where(eq(orderFulfilments.id, f.id)).returning();
  return u!;
}

export async function advanceFulfilment(s: Services, f: FulfilmentRow, to: string, by: string, extra: { carrier?: string; trackingNumber?: string } = {}) {
  if (!fulfilmentNext(f).includes(to)) throw conflict('invalid_transition', `Cannot move a ${f.method} fulfilment from ${f.status} to ${to}`);
  if (to === 'packed' && f.lines.some((l) => l.picked !== l.quantity)) throw conflict('not_fully_picked', 'Pick every unit (or reduce the quantity) before packing');
  if (to === 'shipped' && !extra.trackingNumber) throw validationError('Add the tracking number', { trackingNumber: 'Required to mark as shipped' });
  return s.db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, f.orderId)).for('update');
    const set: Partial<typeof orderFulfilments.$inferInsert> = { status: to, updatedAt: new Date() };
    if (to === 'packed') set.packedBy = by;
    if (to === 'shipped') { set.carrier = extra.carrier ?? null; set.trackingNumber = extra.trackingNumber ?? null; }
    if (COMPLETE_FULFILMENT.includes(to) || to === 'cancelled') { set.completedBy = by; set.completedAt = new Date(); }
    // Units held at the collection store for a transferred order are sold when they leave the store.
    if (o && COMPLETE_FULFILMENT.includes(to) && !COMPLETE_FULFILMENT.includes(f.status)) {
      const transfer = await orderTransfer(tx, o.id);
      if (transfer && transfer.status === 'received') {
        await sellHeld(tx, { organizationId: o.organizationId, locationId: f.locationId, reference: o.id, createdBy: by, note: `Collected — order ${o.orderNumber ?? ''}`.trim() }, f.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })));
      }
    }
    const [u] = await tx.update(orderFulfilments).set(set).where(eq(orderFulfilments.id, f.id)).returning();
    const order = await refreshFulfilmentStatus(tx, f.orderId, by, `fulfilment_${to}`);
    await audit(tx, { organizationId: f.organizationId, actorUserId: by, action: `order.fulfilment_${to}`, scopeKind: 'location', scopeId: f.locationId, targetType: 'order', targetId: f.orderId, metadata: { fulfilmentId: f.id, ...extra } });
    return { fulfilment: u!, order: order! };
  });
}

/** Allocate stock that arrived to backordered lines (sale recorded now). */
export async function allocateBackorders(s: Services, orderId: string, by: string) {
  return s.db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw notFound('Order');
    let moved = 0;
    const lines: OrderLine[] = [];
    for (const l of o.lines) {
      const bo = l.backordered ?? 0;
      if (bo <= 0) { lines.push(l); continue; }
      const lv = await lockStock(tx, o.organizationId, o.locationId, l.variantId);
      const take = Math.min(bo, Math.max(0, availableOf(lv)));
      if (take > 0) {
        await applyMovement(tx, { organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, quantity: -take, reason: 'sale', reference: o.id, createdBy: by, note: 'Backorder allocated' });
        moved += take;
      }
      lines.push({ ...l, allocated: (l.allocated ?? 0) + take, backordered: bo - take });
    }
    await tx.update(orders).set({ lines, history: [...o.history, historyEntry('backorder_allocated', by, `${moved} unit(s) allocated`)] }).where(eq(orders.id, o.id));
    const u = await refreshFulfilmentStatus(tx, o.id, by);
    return { order: u!, allocated: moved };
  });
}

/** Recovery for orders paid after their reservation lapsed (or otherwise in stock conflict). */
export async function resolveStockConflict(s: Services, orderId: string, action: { kind: 'retry_allocation' } | { kind: 'backorder' } | { kind: 'transfer_from'; fromLocationId: string }, by: string) {
  return s.db.transaction(async (tx) => {
    const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!o) throw notFound('Order');
    if (o.fulfilmentStatus !== 'stock_conflict') throw conflict('no_conflict', 'This order has no stock conflict to resolve');
    let lines = o.lines;
    let note: string;
    if (action.kind === 'retry_allocation') {
      const alloc = await reserveLines(tx, { organizationId: o.organizationId, locationId: o.locationId, reference: o.id, createdBy: by, note: 'Recovery: stock re-allocated' }, o.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), () => false);
      await sellHeld(tx, { organizationId: o.organizationId, locationId: o.locationId, reference: o.id, createdBy: by }, alloc.map((a) => ({ variantId: a.variantId, quantity: a.allocated })));
      lines = o.lines.map((l) => ({ ...l, allocated: l.quantity, backordered: 0 }));
      note = 'Stock re-allocated';
    } else if (action.kind === 'backorder') {
      lines = o.lines.map((l) => ({ ...l, allocated: 0, backordered: l.quantity }));
      note = 'Accepted as a backorder';
    } else {
      const [from] = await tx.select().from(locations).where(and(eq(locations.id, action.fromLocationId), eq(locations.organizationId, o.organizationId)));
      if (!from || from.id === (o.fulfilmentLocationId ?? o.locationId)) throw validationError('Choose another store to send the stock', { fromLocationId: 'Invalid store' });
      await reserveLines(tx, { organizationId: o.organizationId, locationId: from.id, reference: o.id, createdBy: by, note: `Recovery: held for transfer to order ${o.orderNumber ?? ''}` }, o.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), () => false);
      const number = `TR-${await nextNumber(tx, o.organizationId, 'transfer')}`;
      await tx.insert(stockTransfers).values({
        organizationId: o.organizationId, number, fromLocationId: from.id, toLocationId: o.fulfilmentLocationId ?? o.locationId, status: 'approved', orderId: o.id, requestedBy: by, approvedBy: by,
        reason: `Recovery for order ${o.orderNumber ?? o.id.slice(0, 8)}`, lines: o.lines.map((l) => ({ variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.quantity, shipped: 0, received: 0 })),
        history: [historyEntry('approved', by, 'Recovery transfer for a paid order')],
      });
      lines = o.lines.map((l) => ({ ...l, allocated: l.quantity, backordered: 0 }));
      note = `Transfer ${number} from ${from.name}`;
    }
    await tx.update(orders).set({ lines, attention: null, fulfilmentStatus: 'unfulfilled', history: [...o.history, historyEntry('recovered', by, note)], updatedAt: new Date() }).where(eq(orders.id, o.id));
    await audit(tx, { organizationId: o.organizationId, actorUserId: by, action: 'order.stock_conflict_resolved', scopeKind: 'location', scopeId: o.locationId, targetType: 'order', targetId: o.id, metadata: { action } });
    return (await refreshFulfilmentStatus(tx, o.id, by))!;
  });
}

// ───────── Views ─────────

export function serializeOrder(o: OrderRow, opts: { staff?: boolean; locations?: Map<string, { name: string; timeZone: string }>; fulfilments?: FulfilmentRow[]; transfer?: typeof stockTransfers.$inferSelect | null } = {}) {
  const c = o.currency;
  const loc = opts.locations?.get(o.locationId);
  const collect = o.fulfilmentLocationId ? opts.locations?.get(o.fulfilmentLocationId) : null;
  return {
    id: o.id, number: o.orderNumber ?? (o.externalId ? `#${o.externalId}` : o.id.slice(0, 8).toUpperCase()), source: o.source, externalId: o.externalId,
    authoritativeSystem: o.source === 'native' || o.source === 'exchange' ? 'branchharbor' : o.source,
    locationId: o.locationId, locationName: loc?.name ?? null, timeZone: loc?.timeZone ?? null,
    fulfilmentLocationId: o.fulfilmentLocationId ?? o.locationId, fulfilmentLocationName: collect?.name ?? loc?.name ?? null, crossLocation: !!o.fulfilmentLocationId && o.fulfilmentLocationId !== o.locationId,
    status: o.status, paymentStatus: o.paymentStatus, fulfilmentStatus: o.fulfilmentStatus, fulfilmentMethod: o.fulfilmentMethod, externalStatus: o.externalStatus,
    currency: c, lines: o.lines.map((l) => ({ ...l, unitPrice: money(l.unitPriceMinor, c), lineTotal: money(l.unitPriceMinor * l.quantity, c) })),
    subtotal: money(o.subtotalMinor, c), fulfilmentFee: money(o.fulfilmentFeeMinor, c),
    taxLines: o.taxLines.map((t) => ({ ...t, amount: money(t.amountMinor, c) })), total: money(o.totalMinor, c),
    creditApplied: money(o.creditAppliedMinor, c), amountDue: money(o.totalMinor - o.creditAppliedMinor, c), refunded: money(o.refundedMinor, c),
    reservationExpiresAt: o.reservationExpiresAt?.toISOString() ?? null, attention: o.attention,
    customer: opts.staff ? { name: o.customerName, email: o.customerEmail, phone: o.customerPhone } : { name: o.customerName },
    shippingAddress: o.shippingAddress, notes: opts.staff ? o.notes : null,
    history: o.history, createdAt: o.createdAt.toISOString(), paidAt: o.paidAt?.toISOString() ?? null, fulfilledAt: o.fulfilledAt?.toISOString() ?? null,
    fulfilments: (opts.fulfilments ?? []).map((f) => ({ id: f.id, locationId: f.locationId, method: f.method, status: f.status, lines: f.lines, carrier: f.carrier, trackingNumber: f.trackingNumber, next: fulfilmentNext(f), createdAt: f.createdAt.toISOString(), completedAt: f.completedAt?.toISOString() ?? null })),
    transfer: opts.transfer ? { id: opts.transfer.id, number: opts.transfer.number, status: opts.transfer.status } : null,
  };
}

export async function locationMap(db: Exec, organizationId: string) {
  const rows = await db.select({ id: locations.id, name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.organizationId, organizationId));
  return new Map(rows.map((r) => [r.id, { name: r.name, timeZone: r.timeZone }]));
}

export async function orgSlugOf(db: Exec, organizationId: string) {
  const [o] = await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, organizationId));
  return o?.slug ?? null;
}

export const sqlNow = sql`now()`;
