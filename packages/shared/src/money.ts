/**
 * Money is always an integer amount in the currency's minor unit plus an ISO 4217 code.
 * Never add amounts in different currencies without an explicit, disclosed conversion.
 */

export const SUPPORTED_CURRENCIES = [
  'USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'SGD', 'AED', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY',
  'INR', 'ZAR', 'NGN', 'KES', 'GHS', 'EGP', 'SAR', 'HKD', 'PHP', 'MYR', 'IDR', 'PLN', 'CZK', 'TRY',
] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Minor-unit exponent per ISO 4217. Every supported currency uses 2 decimals except JPY (0). Note that some
 * payment providers treat currencies such as IDR or HUF specially; amounts here always follow ISO 4217.
 */
const EXPONENT: Partial<Record<Currency, number>> = { JPY: 0 };
export const minorUnitExponent = (c: Currency): number => EXPONENT[c] ?? 2;

export interface Money {
  amount: number; // integer, minor units
  currency: Currency;
}

export function money(amount: number, currency: Currency): Money {
  if (!Number.isInteger(amount)) throw new Error(`Money amount must be an integer in minor units, got ${amount}`);
  return { amount, currency };
}

export function fromMajor(major: number, currency: Currency): Money {
  return money(Math.round(major * 10 ** minorUnitExponent(currency)), currency);
}

export function toMajor(m: Money): number {
  return m.amount / 10 ** minorUnitExponent(m.currency);
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return money(a.amount + b.amount, a.currency);
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/** Groups amounts by currency — the default way to total mixed-currency data. */
export function totalsByCurrency(items: Money[]): Money[] {
  const map = new Map<Currency, number>();
  for (const m of items) map.set(m.currency, (map.get(m.currency) ?? 0) + m.amount);
  return [...map.entries()].map(([currency, amount]) => ({ currency, amount }));
}

export function formatMoney(m: Money, locale = 'en', opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency, ...opts }).format(toMajor(m));
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} and ${b} without a defined conversion method`);
    this.name = 'CurrencyMismatchError';
  }
}
