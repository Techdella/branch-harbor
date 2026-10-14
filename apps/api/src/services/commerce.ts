import { and, eq, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { locationVariants, orders, returns, stockMovements } from '../db/schema/index.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { refundPayment, serializePayment } from './payments.ts';

export interface CommerceRefundInput {
  amountMinor: number;
  reason?: string;
  restock?: Array<{ variantId: string; quantity: number }>;
  actorUserId: string;
  ip?: string;
  /** Return being resolved by this refund (marked resolved in the same transaction). */
  returnId?: string | null;
}

/**
 * Partial refund of a commerce order. BranchHarbor payments are refunded at the provider; external
 * orders are recorded only. Restocked units are written as `return` movements (inventory history).
 */
export async function refundCommerceOrder(s: Services, orderId: string, input: CommerceRefundInput) {
  const [o] = await s.db.select().from(orders).where(eq(orders.id, orderId));
  if (!o) throw notFound('Order');
  const remaining = o.totalMinor - o.refundedMinor;
  if (input.amountMinor > remaining) throw new AppError(409, 'refund_exceeds_remaining', `Only ${remaining} ${o.currency} minor units remain refundable`, undefined, { remainingMinor: remaining, currency: o.currency });
  let payment = null;
  let refundState: string = 'recorded_only';
  if (o.paymentId) {
    const r = await refundPayment(s, o.paymentId, input.amountMinor, { actorUserId: input.actorUserId, reason: input.reason, ip: input.ip });
    payment = serializePayment(r.payment);
    refundState = r.refund.state;
    if (refundState === 'failed') throw new AppError(502, 'refund_failed', 'The payment provider could not process the refund');
  }
  const refunded = o.refundedMinor + input.amountMinor;
  const [u] = await s.db.transaction(async (tx) => {
    for (const l of input.restock ?? []) {
      await tx.insert(stockMovements).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, quantity: l.quantity, reason: 'return', reference: o.id, createdBy: input.actorUserId });
      await tx.update(locationVariants).set({ stockOnHand: sql`${locationVariants.stockOnHand} + ${l.quantity}` }).where(and(eq(locationVariants.locationId, o.locationId), eq(locationVariants.variantId, l.variantId)));
    }
    await audit(tx, { organizationId: o.organizationId, actorUserId: input.actorUserId, action: 'order.refunded', scopeKind: 'location', scopeId: o.locationId, targetType: 'order', targetId: o.id, metadata: { amountMinor: input.amountMinor, currency: o.currency, refundState }, ip: input.ip ?? null });
    if (input.returnId) {
      const [r] = await tx.select().from(returns).where(and(eq(returns.id, input.returnId), eq(returns.orderId, o.id)));
      if (r && r.status !== 'resolved') {
        await tx.update(returns).set({ status: 'resolved', resolution: 'refund', refundAmountMinor: input.amountMinor, currency: o.currency, history: [...r.history, { at: new Date().toISOString(), event: 'resolved', by: input.actorUserId, note: `Refunded ${input.amountMinor} ${o.currency} minor units (${refundState})` }], updatedAt: new Date() }).where(eq(returns.id, r.id));
      }
    }
    const full = refunded >= o.totalMinor;
    return tx.update(orders).set({ refundedMinor: refunded, status: full ? 'refunded' : 'partially_refunded', paymentStatus: o.paymentId || o.paymentStatus === 'paid' ? (full ? 'refunded' : 'partially_refunded') : o.paymentStatus, updatedAt: new Date() }).where(eq(orders.id, o.id)).returning();
  });
  return { order: u!, payment, refundState, note: o.paymentId ? null : `Recorded in BranchHarbor only. Issue the refund in ${o.source}, the authoritative order system.` };
}
