import { totalsByCurrency, type Currency } from '@bh/shared';

export interface PaymentRow { amountMinor: number; currency: string; state: string; refundedMinor: number }

export interface CurrencyRevenue {
  currency: Currency;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  paymentCount: number;
}

/**
 * Revenue per currency. Amounts in different currencies are never summed together; the caller
 * reports `combinedTotal: null` unless a disclosed conversion method is configured.
 */
export function revenueByCurrency(rows: PaymentRow[]): CurrencyRevenue[] {
  const succeeded = rows.filter((r) => r.state === 'succeeded');
  const gross = totalsByCurrency(succeeded.map((r) => ({ amount: r.amountMinor, currency: r.currency as Currency })));
  const refunded = new Map(totalsByCurrency(succeeded.map((r) => ({ amount: r.refundedMinor, currency: r.currency as Currency }))).map((m) => [m.currency, m.amount]));
  return gross
    .map((g) => {
      const ref = refunded.get(g.currency) ?? 0;
      return {
        currency: g.currency,
        grossMinor: g.amount,
        refundedMinor: ref,
        netMinor: g.amount - ref,
        paymentCount: succeeded.filter((r) => r.currency === g.currency).length,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** `sourceCode` names a BranchHarbor source (payments, bookings, …) or `provider` when `source` is a provider name. */
export type Freshness = { asOf: string; source: string; sourceCode?: string; lastSyncAt: string | null; complete: boolean };

/** Why a metric is unavailable, as a stable code plus arguments (apps translate it; `unavailableReason` is the English line). */
export interface UnavailableReason { code: string; params?: Record<string, string | number> }

/** A metric value that is honest about missing data: `value` is null (not 0) when unavailable. */
export interface Metric<T> {
  value: T | null;
  unavailableReason: string | null;
  unavailableCode: string | null;
  unavailableParams: Record<string, string | number> | null;
  definition: string;
  freshness: Freshness;
}

export function metric<T>(value: T | null, definition: string, freshness: Freshness, unavailableReason: string | null = null, reason?: UnavailableReason): Metric<T> {
  const missing = value === null;
  return {
    value,
    unavailableReason: missing ? unavailableReason ?? 'Unavailable' : null,
    unavailableCode: missing ? reason?.code ?? 'unavailable' : null,
    unavailableParams: missing ? reason?.params ?? {} : null,
    definition,
    freshness,
  };
}
