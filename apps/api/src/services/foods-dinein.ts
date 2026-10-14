/**
 * Dine-in QR table ordering: tables with printed codes, and an optional tab per table that collects orders
 * placed with "add to tab" until it is paid online (one payment for the whole tab, optional tip) or settled
 * at the counter by staff.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import { foodOrders, foodTables, foodTabs, locations } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { loadFoodConfig } from './foods-menu.ts';
import { createPaymentForTarget, paymentTargetExtensions, type PaymentRow } from './payments.ts';

type Tab = typeof foodTabs.$inferSelect;

/** Short, unambiguous table code for QR links. */
export const newTableCode = () => randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[01IO]/g, 'X').slice(0, 6).padEnd(6, 'X');

export async function tabOrders(db: Exec, tabId: string) {
  return db.select().from(foodOrders).where(and(eq(foodOrders.channel, 'dine_in'), sql`${foodOrders.fulfilment}->>'tabId' = ${tabId}`));
}

export async function tabSummary(db: Exec, tab: Tab) {
  const orders = (await tabOrders(db, tab.id)).filter((o) => !['cancelled', 'rejected'].includes(o.status));
  const sum = (k: 'subtotalMinor' | 'taxMinor' | 'serviceChargeMinor' | 'totalMinor') => orders.reduce((a, o) => a + o[k], 0);
  const m = (amount: number) => ({ amount, currency: tab.currency });
  const [table] = await db.select().from(foodTables).where(eq(foodTables.id, tab.tableId));
  return {
    id: tab.id, tableId: tab.tableId, tableLabel: table?.label ?? null, locationId: tab.locationId, status: tab.status, guestName: tab.guestName, paidVia: tab.paidVia,
    openedAt: tab.openedAt.toISOString(), closedAt: tab.closedAt?.toISOString() ?? null,
    orders: orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, total: m(o.totalMinor), lines: o.lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: m(l.lineTotalMinor) })) })),
    subtotal: m(sum('subtotalMinor')), serviceCharge: m(sum('serviceChargeMinor')), tax: m(sum('taxMinor')), tip: m(tab.tipMinor), total: m(sum('totalMinor') + tab.tipMinor), amountDue: m(sum('totalMinor')),
  };
}

export async function tabByToken(db: Exec, tabId: string, token: string) {
  const [tab] = await db.select().from(foodTabs).where(eq(foodTabs.id, tabId));
  if (!tab || tab.tokenHash !== sha256(token)) throw notFound('Tab');
  return tab;
}

/** Pay the whole tab online with an optional tip. Orders stay on the tab until the payment succeeds. */
export async function payTab(s: Services, tab: Tab, tipMinor: number) {
  if (tab.status !== 'open') throw conflict('tab_closed', `This tab is ${tab.status.replace('_', ' ')}`);
  const summary = await tabSummary(s.db, tab);
  if (summary.amountDue.amount <= 0) throw conflict('tab_empty', 'There is nothing to pay on this tab yet');
  const cfg = await loadFoodConfig(s.db, tab.locationId);
  if (tipMinor > 0 && (!cfg.tips.enabled || !cfg.tips.channels.includes('dine_in'))) throw validationError('Tips are not accepted here', { tipMinor: 'Not accepted' });
  if (tipMinor > summary.subtotal.amount) throw validationError('The tip cannot be more than the subtotal', { tipMinor: 'Too large' });
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, tab.locationId));
  if (!loc?.paymentsEnabled) throw conflict('payments_not_enabled', 'Online payment is not available here — please pay at the counter');
  const p = await createPaymentForTarget(s, {
    organizationId: tab.organizationId, locationId: tab.locationId, amountMinor: summary.amountDue.amount + tipMinor, currency: tab.currency, targetType: 'food_tab', targetId: `${tab.id}`,
    description: `Table ${summary.tableLabel ?? ''} tab`,
  });
  await s.db.update(foodTabs).set({ tipMinor, paymentId: p.payment.id }).where(eq(foodTabs.id, tab.id));
  return { payment: { id: p.payment.id, clientSecret: p.clientSecret, sandbox: p.sandbox }, amount: { amount: summary.amountDue.amount + tipMinor, currency: tab.currency } };
}

async function markTabPaid(tx: Tx, tab: Tab, paidVia: 'online' | 'counter', paymentId: string | null) {
  await tx.update(foodTabs).set({ status: 'paid', paidVia, paymentId, closedAt: new Date() }).where(eq(foodTabs.id, tab.id));
  const ids = (await tabOrders(tx, tab.id)).filter((o) => o.paymentStatus === 'on_tab').map((o) => o.id);
  if (ids.length) await tx.update(foodOrders).set({ paymentStatus: 'paid', paymentId, updatedAt: new Date() }).where(inArray(foodOrders.id, ids));
}

/** Staff settle a tab at the counter (cash/card terminal) or void an empty one. */
export async function closeTab(s: Services, organizationId: string, tabId: string, how: 'counter' | 'void', actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const [tab] = await tx.select().from(foodTabs).where(and(eq(foodTabs.id, tabId), eq(foodTabs.organizationId, organizationId))).for('update');
    if (!tab) throw notFound('Tab');
    if (tab.status !== 'open') throw conflict('tab_closed', `This tab is ${tab.status.replace('_', ' ')}`);
    const live = (await tabOrders(tx, tab.id)).filter((o) => !['cancelled', 'rejected'].includes(o.status));
    if (how === 'void') {
      if (live.length) throw conflict('tab_not_empty', 'Cancel the orders on this tab before voiding it');
      await tx.update(foodTabs).set({ status: 'void', closedAt: new Date() }).where(eq(foodTabs.id, tab.id));
    } else {
      await markTabPaid(tx, tab, 'counter', null);
    }
    await audit(tx, { organizationId, actorUserId, action: how === 'void' ? 'food_tab.voided' : 'food_tab.paid_at_counter', scopeKind: 'location', scopeId: tab.locationId, targetType: 'food_tab', targetId: tab.id });
    const [u] = await tx.select().from(foodTabs).where(eq(foodTabs.id, tab.id));
    return u!;
  });
}

paymentTargetExtensions.food_tab = {
  async fulfil(tx: Tx, p: PaymentRow) {
    const [tab] = await tx.select().from(foodTabs).where(eq(foodTabs.id, p.targetId!)).for('update');
    if (!tab) return { fulfilled: false, note: 'Tab missing' };
    if (tab.status === 'paid') return { fulfilled: tab.paymentId === p.id, note: tab.paymentId === p.id ? 'Tab already paid' : 'Tab already paid by another payment — duplicate flagged for refund' };
    if (tab.status !== 'open') return { fulfilled: false, note: `Tab is ${tab.status}` };
    await markTabPaid(tx, tab, 'online', p.id);
    return { fulfilled: true, note: 'Tab paid' };
  },
  async isRecorded(db: Exec, p: PaymentRow) {
    const [tab] = await db.select().from(foodTabs).where(eq(foodTabs.id, p.targetId!));
    if (!tab) return { ok: false, expected: null };
    const orders = (await tabOrders(db, tab.id)).filter((o) => !['cancelled', 'rejected'].includes(o.status));
    // Once paid, later cancellations are refunded per order, so only an unpaid tab has an expected amount.
    return { ok: tab.status === 'paid', expected: tab.status === 'paid' ? null : { amount: orders.reduce((a, o) => a + o.totalMinor, 0) + tab.tipMinor, currency: tab.currency } };
  },
};
