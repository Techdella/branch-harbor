import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_PRICES_MINOR, PRICED_CURRENCIES } from './pricing.ts';
import { ROYALTY_COLLECTION_FEE_CAP_PER_LOCATION_PER_MONTH, quoteCollectionFee, royaltyCollectionFee } from './fees.ts';

test('the royalty collection fee is a flat amount in every price-book currency (USD 1.00 reference)', () => {
  assert.equal(royaltyCollectionFee.USD, 100);
  for (const c of PRICED_CURRENCIES) assert.ok(Number.isInteger(royaltyCollectionFee[c]) && royaltyCollectionFee[c] > 0, c);
  for (const c of PRICED_CURRENCIES) assert.equal(royaltyCollectionFee[c], LIST_PRICES_MINOR[c].collection, c);
});

test('the fee is capped per location per month and never depends on the royalty amount', () => {
  const cap = ROYALTY_COLLECTION_FEE_CAP_PER_LOCATION_PER_MONTH;
  assert.equal(cap, 10);
  assert.deepEqual(quoteCollectionFee('usd', 0), { amountMinor: 100, currency: 'USD', chargedThisMonth: 0, cap, capped: false });
  assert.equal(quoteCollectionFee('USD', cap - 1).amountMinor, 100);
  assert.equal(quoteCollectionFee('USD', cap).amountMinor, 0);
  assert.equal(quoteCollectionFee('USD', cap).capped, true);
  // Outside the price book: no invented conversion.
  assert.equal(quoteCollectionFee('XOF', 0).amountMinor, 0);
});
