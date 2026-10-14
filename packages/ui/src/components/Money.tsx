import { formatMoney, totalsByCurrency, type Money as MoneyT } from '@bh/shared';

export function Money({ value, locale = 'en' }: { value: MoneyT; locale?: string }) {
  return <span className="tabular">{formatMoney(value, locale)}</span>;
}

/** Mixed-currency totals are listed per currency; no combined figure without a defined conversion. */
export function MoneyTotals({ values, locale = 'en' }: { values: MoneyT[]; locale?: string }) {
  const totals = totalsByCurrency(values);
  return (
    <span className="tabular inline-flex flex-wrap gap-x-3">
      {totals.map((t) => (
        <span key={t.currency}>{formatMoney(t, locale)}</span>
      ))}
    </span>
  );
}
