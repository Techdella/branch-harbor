import { and, eq, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { locationVariants, orders, stockMovements } from '../db/schema/index.ts';

/**
 * Inventory history. On-hand stock changes only with physical movements (adjustment, count, received, sale,
 * return, damage, transfers). Reservations hold units for unpaid orders without touching on-hand stock;
 * a release gives them back. Both are recorded so the history explains every number.
 */
export const RESERVATION_REASONS = ['reservation', 'release'] as const;
export const affectsOnHand = (reason: string) => !(RESERVATION_REASONS as readonly string[]).includes(reason);

export const REASON_LABEL: Record<string, string> = {
  adjustment: 'Adjustment', count: 'Stock count', received: 'Received', sale: 'Sale', return: 'Return', damage: 'Damaged / write-off',
  transfer_in: 'Transfer in', transfer_out: 'Transfer out', reservation: 'Reserved for unpaid order', release: 'Reservation released',
};

type OrderRow = typeof orders.$inferSelect;

/** Hold stock for an unpaid order. */
export async function reserveForOrder(tx: Exec, o: OrderRow, actorUserId: string | null) {
  for (const l of o.lines) {
    await tx.insert(stockMovements).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, quantity: -l.quantity, reason: 'reservation', reference: o.id, createdBy: actorUserId });
    await tx.insert(locationVariants).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, reserved: l.quantity })
      .onConflictDoUpdate({ target: [locationVariants.locationId, locationVariants.variantId], set: { reserved: sql`${locationVariants.reserved} + ${l.quantity}`, updatedAt: new Date() } });
  }
}

/** Payment confirmed: release the reservation and record the sale (on-hand goes down once). */
export async function convertReservationToSale(tx: Exec, o: OrderRow) {
  const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockMovements).where(and(eq(stockMovements.reference, o.id), eq(stockMovements.reason, 'reservation')));
  for (const l of o.lines) {
    if ((held?.n ?? 0) > 0) {
      await tx.insert(stockMovements).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, quantity: l.quantity, reason: 'release', reference: o.id });
      await tx.update(locationVariants).set({ reserved: sql`greatest(${locationVariants.reserved} - ${l.quantity}, 0)` }).where(and(eq(locationVariants.locationId, o.locationId), eq(locationVariants.variantId, l.variantId)));
    }
    await tx.insert(stockMovements).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, quantity: -l.quantity, reason: 'sale', reference: o.id });
    await tx.insert(locationVariants).values({ organizationId: o.organizationId, locationId: o.locationId, variantId: l.variantId, stockOnHand: -l.quantity })
      .onConflictDoUpdate({ target: [locationVariants.locationId, locationVariants.variantId], set: { stockOnHand: sql`${locationVariants.stockOnHand} - ${l.quantity}`, updatedAt: new Date() } });
  }
}
