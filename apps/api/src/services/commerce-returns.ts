import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { approvals, giftCardLedger, giftCards, orders, products, returns, variants, type ReturnLine } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { hasPerm } from './authz.ts';
import { insertApproval, notifyApprovers, refundNeedsApproval } from './approvals.ts';
import { refundCommerceOrder } from './commerce.ts';
import { applyMovement, historyEntry, nextNumber, reserveLines, sellHeld } from './commerce-stock.ts';
import { fulfilmentConfig, normaliseCode, type OrderRow } from './commerce-orders.ts';

type ReturnRow = typeof returns.$inferSelect;

// ───────── Gift cards & store credit ─────────

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newGiftCode(): string {
  const b = randomBytes(12);
  const chars = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export async function issueGiftCard(tx: Exec, input: { organizationId: string; kind: 'gift_card' | 'store_credit'; currency: string; amountMinor: number; customerEmail?: string | null; locationId?: string | null; reason?: string | null; by: string | null; returnId?: string | null; expiresAt?: Date | null; code?: string }) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw validationError('Amount must be a positive integer in minor units', { amountMinor: 'Must be > 0' });
  const code = input.code ?? newGiftCode();
  const norm = normaliseCode(code);
  const [card] = await tx.insert(giftCards).values({
    organizationId: input.organizationId, kind: input.kind, codeHash: sha256(norm), codeLast4: norm.slice(-4), currency: input.currency, initialMinor: input.amountMinor, balanceMinor: input.amountMinor,
    customerEmail: input.customerEmail?.toLowerCase() ?? null, issuedAtLocationId: input.locationId ?? null, issuedReason: input.reason ?? null, issuedBy: input.by, expiresAt: input.expiresAt ?? null,
  }).returning();
  await tx.insert(giftCardLedger).values({ organizationId: input.organizationId, giftCardId: card!.id, kind: 'issue', amountMinor: input.amountMinor, balanceAfterMinor: input.amountMinor, returnId: input.returnId ?? null, note: input.reason ?? null, createdBy: input.by });
  await audit(tx, { organizationId: input.organizationId, actorUserId: input.by, action: `${input.kind}.issued`, scopeKind: input.locationId ? 'location' : 'organization', scopeId: input.locationId ?? input.organizationId, targetType: 'gift_card', targetId: card!.id, metadata: { amountMinor: input.amountMinor, currency: input.currency } });
  return { card: card!, code };
}

export async function adjustGiftCard(s: Services, cardId: string, amountMinor: number, note: string, by: string) {
  return s.db.transaction(async (tx) => {
    const [c] = await tx.select().from(giftCards).where(eq(giftCards.id, cardId)).for('update');
    if (!c) throw notFound('Gift card');
    const bal = c.balanceMinor + amountMinor;
    if (bal < 0) throw conflict('insufficient_balance', `Balance is ${c.balanceMinor} ${c.currency} minor units`);
    const [u] = await tx.update(giftCards).set({ balanceMinor: bal, updatedAt: new Date() }).where(eq(giftCards.id, c.id)).returning();
    await tx.insert(giftCardLedger).values({ organizationId: c.organizationId, giftCardId: c.id, kind: 'adjust', amountMinor, balanceAfterMinor: bal, note, createdBy: by });
    await audit(tx, { organizationId: c.organizationId, actorUserId: by, action: 'gift_card.adjusted', targetType: 'gift_card', targetId: c.id, metadata: { amountMinor, note } });
    return u!;
  });
}

export function serializeGiftCard(c: typeof giftCards.$inferSelect, ledger?: Array<typeof giftCardLedger.$inferSelect>) {
  return {
    id: c.id, kind: c.kind, code: `••••-${c.codeLast4}`, last4: c.codeLast4, status: c.status, customerEmail: c.customerEmail,
    initial: { amount: c.initialMinor, currency: c.currency }, balance: { amount: c.balanceMinor, currency: c.currency },
    issuedReason: c.issuedReason, issuedAtLocationId: c.issuedAtLocationId, expiresAt: c.expiresAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
    ledger: ledger?.map((l) => ({ id: l.id, kind: l.kind, amount: { amount: l.amountMinor, currency: c.currency }, balanceAfter: { amount: l.balanceAfterMinor, currency: c.currency }, orderId: l.orderId, returnId: l.returnId, note: l.note, createdAt: l.createdAt.toISOString() })),
  };
}

/** Balances per currency for a customer email (never summed across currencies). */
export async function creditBalances(db: Exec, organizationIds: string[] | null, email: string) {
  const conds = [sql`lower(${giftCards.customerEmail}) = ${email.toLowerCase()}`, eq(giftCards.status, 'active')];
  if (organizationIds) {
    if (!organizationIds.length) return { cards: [], totals: [] };
    conds.push(inArray(giftCards.organizationId, organizationIds));
  }
  const cards = await db.select().from(giftCards).where(and(...conds)).orderBy(desc(giftCards.createdAt));
  const totals = new Map<string, number>();
  for (const c of cards) totals.set(c.currency, (totals.get(c.currency) ?? 0) + c.balanceMinor);
  return { cards: cards.map((c) => serializeGiftCard(c)), totals: [...totals.entries()].map(([currency, amount]) => ({ amount, currency })) };
}

// ───────── Returns ─────────

export const RETURN_STATUSES = ['requested', 'reviewed', 'authorised', 'received', 'refund_pending_approval', 'resolved', 'rejected'] as const;

/** Units of each variant already returned (or being returned) on the order. */
async function returnedSoFar(db: Exec, orderId: string, excludeId?: string) {
  const rows = await db.select().from(returns).where(and(eq(returns.orderId, orderId), ne(returns.status, 'rejected')));
  const m = new Map<string, number>();
  for (const r of rows) if (r.id !== excludeId) for (const l of r.lines) m.set(l.variantId, (m.get(l.variantId) ?? 0) + l.quantity);
  return m;
}

export async function returnWindow(db: Exec, o: OrderRow) {
  const cfg = await fulfilmentConfig(db, o.fulfilmentLocationId ?? o.locationId);
  const from = o.fulfilledAt ?? o.paidAt ?? o.createdAt;
  const endsAt = new Date(from.getTime() + cfg.returnWindowDays * 86400_000);
  return { days: cfg.returnWindowDays, endsAt, open: endsAt > new Date() };
}

export async function createReturn(db: Exec, o: OrderRow, input: { lines: Array<{ variantId: string; quantity: number; reason?: string }>; reason?: string | null; via: 'customer' | 'staff'; by: string | null }) {
  const paid = ['paid', 'partially_refunded', 'external'].includes(o.paymentStatus) || (o.source !== 'native' && ['paid', 'fulfilled', 'completed', 'partially_refunded'].includes(o.status));
  if (!paid) throw conflict('order_not_returnable', 'Only paid orders can be returned');
  if (input.via === 'customer' && o.source !== 'native') throw conflict('external_order', `Returns for this order are handled by ${o.source}, where it was placed`);
  const win = await returnWindow(db, o);
  if (input.via === 'customer' && !win.open) throw conflict('return_window_closed', `Returns were accepted until ${win.endsAt.toISOString().slice(0, 10)} (${win.days} days)`, { endsAt: win.endsAt.toISOString() });
  const already = await returnedSoFar(db, o.id);
  const pIds = [...new Set(o.lines.map((l) => l.productId).filter((x): x is string => !!x))];
  const lineVariantIds = o.lines.map((l) => l.variantId).filter(Boolean);
  const vRows = lineVariantIds.length ? await db.select({ id: variants.id, productId: variants.productId }).from(variants).where(inArray(variants.id, lineVariantIds)) : [];
  const allPids = [...new Set([...pIds, ...vRows.map((v) => v.productId)])];
  const prods = allPids.length ? await db.select({ id: products.id, returnable: products.returnable, name: products.name }).from(products).where(inArray(products.id, allPids)) : [];
  if (!input.lines.length) throw validationError('Choose at least one item to return', { lines: 'Required' });
  const lines: ReturnLine[] = input.lines.map((l, i) => {
    const ol = o.lines.find((x) => x.variantId === l.variantId);
    if (!ol) throw validationError('That item is not on this order', { [`lines.${i}.variantId`]: 'Not on order' });
    const pid = ol.productId ?? vRows.find((v) => v.id === l.variantId)?.productId;
    if (input.via === 'customer' && prods.find((p) => p.id === pid)?.returnable === false) throw validationError(`${ol.name} cannot be returned`, { [`lines.${i}.variantId`]: 'Final sale' });
    const max = ol.quantity - (already.get(l.variantId) ?? 0);
    if (l.quantity < 1 || l.quantity > max) throw validationError(`${ol.name}: you can return up to ${Math.max(0, max)}`, { [`lines.${i}.quantity`]: `Up to ${Math.max(0, max)}` });
    return { variantId: l.variantId, quantity: l.quantity, reason: l.reason, unitPriceMinor: ol.unitPriceMinor, name: ol.name, sku: ol.sku };
  });
  return db.transaction(async (tx) => {
    const rma = `RMA-${await nextNumber(tx, o.organizationId, 'rma', 5000)}`;
    const [r] = await tx.insert(returns).values({
      organizationId: o.organizationId, locationId: o.fulfilmentLocationId ?? o.locationId, orderId: o.id, status: 'requested', lines, reason: input.reason ?? null, rmaNumber: rma,
      requestedVia: input.via, customerEmail: o.customerEmail, currency: o.currency,
      history: [historyEntry('requested', input.by, input.via === 'staff' && !win.open ? 'Created by staff outside the return window' : input.reason ?? undefined)],
    }).returning();
    await audit(tx, { organizationId: o.organizationId, actorUserId: input.by, actorType: input.by ? 'user' : 'system', action: 'return.requested', scopeKind: 'location', scopeId: r!.locationId, targetType: 'return', targetId: r!.id, metadata: { via: input.via, rma } });
    return r!;
  });
}

const FLOW: Record<string, string[]> = { requested: ['reviewed', 'rejected'], reviewed: ['authorised', 'rejected'], authorised: ['received'], received: ['resolved', 'refund_pending_approval'], refund_pending_approval: ['resolved'], resolved: [], rejected: [] };

export async function transitionReturn(db: Exec, r: ReturnRow, to: 'reviewed' | 'authorised' | 'rejected', by: string, note?: string) {
  if (!FLOW[r.status]?.includes(to)) throw conflict('invalid_transition', `Cannot move a return from ${r.status} to ${to}`);
  if (to === 'rejected' && !note) throw validationError('Say why the return is rejected', { note: 'Required when rejecting' });
  const [u] = await db.update(returns).set({ status: to, decisionNote: note ?? r.decisionNote, history: [...r.history, historyEntry(to, by, note)], updatedAt: new Date() }).where(and(eq(returns.id, r.id), eq(returns.status, r.status))).returning();
  if (!u) throw conflict('already_changed', 'This return changed meanwhile; reload it');
  await audit(db, { organizationId: r.organizationId, actorUserId: by, action: `return.${to}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'return', targetId: r.id, metadata: { note } });
  return u;
}

/** Receive returned goods: restock to sellable stock or write off (both recorded in the ledger). */
export async function receiveReturn(s: Services, returnId: string, input: { lines: Array<{ variantId: string; receivedQty: number; disposition: 'restock' | 'write_off' }>; note?: string }, by: string) {
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(returns).where(eq(returns.id, returnId)).for('update');
    if (!r) throw notFound('Return');
    if (r.status !== 'authorised') throw conflict('invalid_transition', r.status === 'requested' || r.status === 'reviewed' ? 'Authorise the return before receiving goods' : `This return is ${r.status}`);
    const ctx = { organizationId: r.organizationId, locationId: r.locationId, reference: r.rmaNumber ?? r.id, createdBy: by };
    const lines = r.lines.map((l) => {
      const got = input.lines.find((x) => x.variantId === l.variantId);
      if (!got) return { ...l, receivedQty: 0 };
      if (got.receivedQty < 0 || got.receivedQty > l.quantity) throw validationError(`${l.name ?? 'Item'}: receive between 0 and ${l.quantity}`, { [`lines.${l.variantId}`]: 'Invalid quantity' });
      return { ...l, receivedQty: got.receivedQty, disposition: got.disposition };
    });
    for (const l of lines) {
      if (!l.receivedQty) continue;
      await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: l.receivedQty, reason: 'return', note: `${r.rmaNumber}: returned by customer` });
      if (l.disposition === 'write_off') await applyMovement(tx, { ...ctx, variantId: l.variantId, quantity: -l.receivedQty, reason: 'damage', note: `${r.rmaNumber}: returned item written off (not resaleable)` });
    }
    const [u] = await tx.update(returns).set({ status: 'received', lines, history: [...r.history, historyEntry('received', by, input.note)], updatedAt: new Date() }).where(eq(returns.id, r.id)).returning();
    await audit(tx, { organizationId: r.organizationId, actorUserId: by, action: 'return.received', scopeKind: 'location', scopeId: r.locationId, targetType: 'return', targetId: r.id, metadata: { lines: lines.map((l) => ({ variantId: l.variantId, receivedQty: l.receivedQty, disposition: l.disposition })) } });
    return u!;
  });
}

export type ResolveInput =
  | { resolution: 'refund'; amountMinor?: number; reason?: string }
  | { resolution: 'store_credit'; amountMinor?: number; reason?: string }
  | { resolution: 'exchange'; lines: Array<{ fromVariantId: string; toVariantId: string; quantity: number }>; reason?: string };

export function returnValue(r: ReturnRow) {
  return r.lines.reduce((a, l) => a + (l.receivedQty ?? 0) * (l.unitPriceMinor ?? 0), 0);
}

/**
 * Resolve a received return. Refunds within the organisation's threshold run immediately for people who may refund;
 * otherwise they go to the approvals inbox (and run when approved). Store credit is issued in the order currency.
 */
export async function resolveReturn(s: Services, req: FastifyRequest, returnId: string, input: ResolveInput, by: string) {
  const [r] = await s.db.select().from(returns).where(eq(returns.id, returnId));
  if (!r) throw notFound('Return');
  if (r.status === 'refund_pending_approval') {
    const [ap] = r.approvalId ? await s.db.select().from(approvals).where(eq(approvals.id, r.approvalId)) : [];
    if (ap && ap.status !== 'rejected') throw conflict('approval_pending', 'A refund for this return is waiting for approval');
  } else if (r.status !== 'received') throw conflict('invalid_transition', r.status === 'resolved' ? 'This return is already resolved' : 'Receive the returned goods before resolving');
  const [o] = await s.db.select().from(orders).where(eq(orders.id, r.orderId));
  if (!o) throw notFound('Order');
  const value = returnValue(r);
  if (value <= 0 && input.resolution !== 'exchange') throw conflict('nothing_received', 'No units were received on this return');

  if (input.resolution === 'refund') {
    const amount = input.amountMinor ?? Math.min(value, o.totalMinor - o.refundedMinor);
    if (amount <= 0 || amount > o.totalMinor - o.refundedMinor) throw new AppError(409, 'refund_exceeds_remaining', `Refund must be between 1 and ${o.totalMinor - o.refundedMinor} ${o.currency} minor units`, undefined, { remainingMinor: o.totalMinor - o.refundedMinor, currency: o.currency });
    const canRefund = await hasPerm(req, s.db, 'payments.refund', { organizationId: o.organizationId, kind: 'location', id: o.locationId });
    const gate = await refundNeedsApproval(req, s.db, o.organizationId, amount, o.currency);
    if (canRefund && !gate.required) {
      const res = await refundCommerceOrder(s, o.id, { amountMinor: amount, reason: input.reason ?? `Return ${r.rmaNumber}`, actorUserId: by, ip: req.ip, returnId: r.id });
      const [u] = await s.db.select().from(returns).where(eq(returns.id, r.id));
      return { return: u!, outcome: 'refunded' as const, refundState: res.refundState, note: res.note, approval: null, giftCardCode: null };
    }
    const ap = await s.db.transaction(async (tx) => {
      const a = await insertApproval(tx, {
        organizationId: o.organizationId, locationId: o.locationId, kind: 'refund', targetId: o.id, title: `Return ${r.rmaNumber} · order ${o.orderNumber ?? o.id.slice(0, 8)}`,
        payload: { orderId: o.id, returnId: r.id, amountMinor: amount, currency: o.currency, reason: input.reason ?? `Return ${r.rmaNumber}`, restock: [] },
        amountMinor: amount, currency: o.currency, requestedBy: by, comment: input.reason ?? null,
      }, req.ip);
      await tx.update(returns).set({ status: 'refund_pending_approval', approvalId: a.id, resolution: 'refund', refundAmountMinor: amount, history: [...r.history, historyEntry('refund_requested', by, gate.required ? `Above the ${o.currency} approval threshold` : 'Needs someone who can issue refunds')], updatedAt: new Date() }).where(eq(returns.id, r.id));
      return a;
    });
    await notifyApprovers(s, ap).catch(() => {});
    const [u] = await s.db.select().from(returns).where(eq(returns.id, r.id));
    return { return: u!, outcome: 'approval_requested' as const, refundState: null, note: 'Sent to the approvals inbox', approval: { id: ap.id, status: ap.status }, giftCardCode: null };
  }

  if (input.resolution === 'store_credit') {
    const amount = input.amountMinor ?? value;
    if (amount <= 0 || amount > value) throw validationError(`Store credit must be between 1 and ${value} ${o.currency} minor units`, { amountMinor: 'Out of range' });
    const out = await s.db.transaction(async (tx) => {
      const { card, code } = await issueGiftCard(tx, { organizationId: o.organizationId, kind: 'store_credit', currency: o.currency, amountMinor: amount, customerEmail: o.customerEmail, locationId: r.locationId, reason: `Return ${r.rmaNumber}`, by, returnId: r.id });
      const [u] = await tx.update(returns).set({ status: 'resolved', resolution: 'store_credit', giftCardId: card.id, refundAmountMinor: amount, history: [...r.history, historyEntry('resolved', by, `Store credit ${amount} ${o.currency} minor units (••••${card.codeLast4})`)], updatedAt: new Date() }).where(eq(returns.id, r.id)).returning();
      return { u: u!, code };
    });
    if (o.customerEmail) await s.jobs.enqueue('email.send', { to: o.customerEmail, subject: `Your store credit for return ${r.rmaNumber}`, text: `Your return ${r.rmaNumber} has been resolved with store credit. Code: ${out.code}. Use it at checkout in ${o.currency} stores.`, tag: 'commerce-store-credit' }).catch(() => {});
    return { return: out.u, outcome: 'store_credit' as const, refundState: null, note: null, approval: null, giftCardCode: out.code };
  }

  // Exchange: same product, other variant(s), no price increase; replacement goes out as a zero-value order.
  const ex = input.lines;
  if (!ex.length) throw validationError('Choose the replacement items', { lines: 'Required' });
  const vIds = [...new Set(ex.flatMap((l) => [l.fromVariantId, l.toVariantId]))];
  const vs = await s.db.select().from(variants).where(and(eq(variants.organizationId, o.organizationId), inArray(variants.id, vIds)));
  const lines = ex.map((l, i) => {
    const from = r.lines.find((x) => x.variantId === l.fromVariantId);
    const a = vs.find((v) => v.id === l.fromVariantId);
    const b = vs.find((v) => v.id === l.toVariantId);
    if (!from || !a || !b) throw validationError('Unknown item in the exchange', { [`lines.${i}`]: 'Not found' });
    if (a.productId !== b.productId) throw validationError('Exchanges are for another variant of the same product; refund and place a new order otherwise', { [`lines.${i}.toVariantId`]: 'Different product' });
    if (l.quantity < 1 || l.quantity > (from.receivedQty ?? 0)) throw validationError(`Exchange up to ${from.receivedQty ?? 0}`, { [`lines.${i}.quantity`]: 'Too many' });
    const price = b.prices[o.currency];
    if (price === undefined || price > (from.unitPriceMinor ?? 0)) throw validationError('The replacement costs more; refund and place a new order instead', { [`lines.${i}.toVariantId`]: 'Price difference' });
    return { variantId: b.id, sku: b.sku, name: `${from.name?.split(' — ')[0] ?? ''} — ${b.name}`, quantity: l.quantity, unitPriceMinor: 0, productId: b.productId, options: b.options };
  });
  const out = await s.db.transaction(async (tx) => {
    const number = `${o.orderNumber ?? 'EX'}-X${await nextNumber(tx, o.organizationId, `exchange:${o.id}`, 0)}`;
    const [eo] = await tx.insert(orders).values({
      organizationId: o.organizationId, locationId: r.locationId, customerId: o.customerId, userId: o.userId, source: 'exchange', status: 'paid', paymentStatus: 'not_required', fulfilmentStatus: 'unfulfilled', fulfilmentMethod: 'pickup',
      currency: o.currency, subtotalMinor: 0, totalMinor: 0, orderNumber: number, customerName: o.customerName, customerEmail: o.customerEmail, customerPhone: o.customerPhone, paidAt: new Date(),
      lines: lines.map((l) => ({ ...l, allocated: l.quantity, backordered: 0 })), history: [historyEntry('placed', by, `Exchange for return ${r.rmaNumber}`)],
    }).returning();
    await reserveLines(tx, { organizationId: o.organizationId, locationId: r.locationId, reference: eo!.id, createdBy: by, note: `Exchange ${r.rmaNumber}` }, lines, () => false);
    await sellHeld(tx, { organizationId: o.organizationId, locationId: r.locationId, reference: eo!.id, createdBy: by, note: `Exchange ${r.rmaNumber}` }, lines);
    const [u] = await tx.update(returns).set({ status: 'resolved', resolution: 'exchange', exchangeOrderId: eo!.id, history: [...r.history, historyEntry('resolved', by, `Exchange order ${number}`)], updatedAt: new Date() }).where(eq(returns.id, r.id)).returning();
    await audit(tx, { organizationId: o.organizationId, actorUserId: by, action: 'return.exchanged', scopeKind: 'location', scopeId: r.locationId, targetType: 'return', targetId: r.id, metadata: { exchangeOrderId: eo!.id } });
    return u!;
  });
  return { return: out, outcome: 'exchanged' as const, refundState: null, note: null, approval: null, giftCardCode: null };
}

export function serializeReturn(r: ReturnRow, extra: { orderNumber?: string | null; locationName?: string | null; approvalStatus?: string | null } = {}) {
  const c = r.currency ?? 'USD';
  return {
    id: r.id, rmaNumber: r.rmaNumber, orderId: r.orderId, orderNumber: extra.orderNumber ?? null, locationId: r.locationId, locationName: extra.locationName ?? null,
    status: r.status, requestedVia: r.requestedVia, reason: r.reason, resolution: r.resolution, decisionNote: r.decisionNote,
    lines: r.lines.map((l) => ({ ...l, unitPrice: l.unitPriceMinor != null ? { amount: l.unitPriceMinor, currency: c } : null })),
    value: { amount: returnValue(r), currency: c }, requestedValue: { amount: r.lines.reduce((a, l) => a + l.quantity * (l.unitPriceMinor ?? 0), 0), currency: c },
    refundAmount: r.refundAmountMinor != null ? { amount: r.refundAmountMinor, currency: c } : null,
    approvalId: r.approvalId, approvalStatus: extra.approvalStatus ?? null, giftCardId: r.giftCardId, exchangeOrderId: r.exchangeOrderId,
    history: r.history, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}
