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

export type Freshness = { asOf: string; source: string; lastSyncAt: string | null; complete: boolean };

/** A metric value that is honest about missing data: `value` is null (not 0) when unavailable. */
export interface Metric<T> {
  value: T | null;
  unavailableReason: string | null;
  definition: string;
  freshness: Freshness;
}

export function metric<T>(value: T | null, definition: string, freshness: Freshness, unavailableReason: string | null = null): Metric<T> {
  return { value, unavailableReason: value === null ? unavailableReason ?? 'Unavailable' : null, definition, freshness };
}
