/**
 * Marketing fund link. Campaign spend paid from the network marketing fund (network, coming-soon and course
 * campaigns — not a location's own local ads) is published as a spend event. The fund ledger (built separately)
 * consumes them either:
 *  - in-process: `onMarketingFundSpend(listener)` is called after each event is stored, or
 *  - by polling: `GET /v1/orgs/:orgId/ad-campaigns/fund-events?pending=true`, then
 *    `POST /v1/orgs/:orgId/ad-campaigns/fund-events/consume` with the ids it booked.
 * Events are deltas: correcting a day's spend downwards emits a negative amount, so the sum is always the spend.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { marketingFundSpendEvents } from '../db/schema/index.ts';

export interface MarketingFundSpendEvent {
  id: string;
  organizationId: string;
  campaignId: string;
  locationId: string;
  amountMinor: number;
  currency: string;
  occurredOn: string;
  source: string;
}
export type MarketingFundListener = (e: MarketingFundSpendEvent) => void | Promise<void>;

const listeners = new Set<MarketingFundListener>();
export function onMarketingFundSpend(fn: MarketingFundListener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const FUNDED_KINDS = new Set(['network', 'coming_soon', 'course']);

export async function recordFundSpend(db: Exec, e: Omit<MarketingFundSpendEvent, 'id'> & { resultId: string }) {
  if (!e.amountMinor) return null;
  const [row] = await db.insert(marketingFundSpendEvents).values(e).returning();
  const out: MarketingFundSpendEvent = { id: row!.id, organizationId: e.organizationId, campaignId: e.campaignId, locationId: e.locationId, amountMinor: e.amountMinor, currency: e.currency, occurredOn: e.occurredOn, source: e.source };
  for (const l of listeners) await Promise.resolve(l(out)).catch(() => {});
  return out;
}

export async function markConsumed(db: Exec, orgId: string, ids: string[]) {
  if (!ids.length) return 0;
  const r = await db.update(marketingFundSpendEvents).set({ consumedAt: new Date() }).where(and(eq(marketingFundSpendEvents.organizationId, orgId), inArray(marketingFundSpendEvents.id, ids), isNull(marketingFundSpendEvents.consumedAt))).returning({ id: marketingFundSpendEvents.id });
  return r.length;
}
