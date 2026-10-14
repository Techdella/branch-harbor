import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, fromMajor, money, totalsByCurrency, formatMoney, CurrencyMismatchError } from './money.ts';

test('fromMajor uses currency exponent', () => {
  assert.deepEqual(fromMajor(12.34, 'USD'), { amount: 1234, currency: 'USD' });
  assert.deepEqual(fromMajor(1200, 'JPY'), { amount: 1200, currency: 'JPY' });
});

test('refuses to add mixed currencies', () => {
  assert.throws(() => add(money(100, 'USD'), money(100, 'CAD')), CurrencyMismatchError);
});

test('totals group by currency', () => {
  const t = totalsByCurrency([money(100, 'USD'), money(50, 'EUR'), money(25, 'USD')]);
  assert.deepEqual(t, [{ currency: 'USD', amount: 125 }, { currency: 'EUR', amount: 50 }]);
});

test('formats with locale', () => {
  assert.equal(formatMoney(money(123456, 'EUR'), 'de'), '1.234,56 €');
});
