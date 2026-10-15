import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_CURRENCIES, minorUnitExponent } from './money.ts';
import {
  LIST_PRICES_MINOR, PLAN_PRICE_KEYS, PRICE_BOOK, PRICED_CURRENCIES, SOLO_PLAN, annualMonthlyPrice, assertBillingCurrency,
  countryFromHeaders, currencyForCountry, regionFromAcceptLanguage, soloPrice,
} from './pricing.ts';

const REQUIRED = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'SGD', 'AED', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'ZAR', 'NGN', 'KES', 'GHS', 'EGP', 'SAR', 'HKD', 'PHP', 'MYR', 'IDR', 'PLN', 'CZK', 'TRY'];

test('price book covers every required currency, and every priced currency is supported', () => {
  for (const c of REQUIRED) assert.ok((PRICED_CURRENCIES as string[]).includes(c), `missing ${c}`);
  for (const c of PRICED_CURRENCIES) assert.ok((SUPPORTED_CURRENCIES as readonly string[]).includes(c), `${c} not in SUPPORTED_CURRENCIES`);
});

test('plans keep their order in every currency (connector < solo < hosted < network) with whole, positive prices', () => {
  for (const c of PRICED_CURRENCIES) {
    const p = PRICE_BOOK[c];
    for (const k of PLAN_PRICE_KEYS) assert.ok(Number.isInteger(p[k]) && p[k] > 0, `${c}.${k}`);
    assert.ok(p.connector < p.solo && p.solo < p.hosted && p.hosted < p.network, `${c} plan order`);
  }
});

test('minor units follow ISO 4217 exponents', () => {
  assert.equal(minorUnitExponent('JPY'), 0);
  assert.equal(LIST_PRICES_MINOR.JPY.solo, PRICE_BOOK.JPY.solo);
  assert.equal(LIST_PRICES_MINOR.USD.solo, 3900);
  assert.equal(LIST_PRICES_MINOR.NGN.network, 4_150_000);
  assert.equal(SOLO_PLAN.priceMinor.EUR, 3600);
  assert.deepEqual(soloPrice('INR'), { amount: 119_900, currency: 'INR', interval: 'month' });
  assert.equal(soloPrice('XYZ'), null);
  assert.equal(annualMonthlyPrice(39), 33);
});

test('country → currency, unknown → USD', () => {
  assert.equal(currencyForCountry('US'), 'USD');
  assert.equal(currencyForCountry('gb'), 'GBP');
  assert.equal(currencyForCountry('DE'), 'EUR');
  assert.equal(currencyForCountry('BG'), 'EUR');
  assert.equal(currencyForCountry('NG'), 'NGN');
  assert.equal(currencyForCountry('IN'), 'INR');
  assert.equal(currencyForCountry('BR'), 'BRL');
  assert.equal(currencyForCountry('LI'), 'CHF');
  assert.equal(currencyForCountry('AR'), 'USD');
  assert.equal(currencyForCountry(null), 'USD');
});

test('country detection: Vercel, then Cloudflare, then Accept-Language region', () => {
  const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
  assert.deepEqual(countryFromHeaders(h({ 'x-vercel-ip-country': 'NG', 'cf-ipcountry': 'GB' })), { country: 'NG', source: 'vercel' });
  assert.deepEqual(countryFromHeaders(h({ 'x-vercel-ip-country': 'XX', 'cf-ipcountry': 'gb' })), { country: 'GB', source: 'cloudflare' });
  assert.deepEqual(countryFromHeaders(h({ 'cf-ipcountry': 'T1', 'accept-language': 'fr,pt-BR;q=0.8' })), { country: 'BR', source: 'accept-language' });
  assert.deepEqual(countryFromHeaders(h({ 'accept-language': 'en' })), { country: null, source: 'none' });
  assert.equal(regionFromAcceptLanguage('zh-Hant-HK,zh;q=0.8'), 'HK');
  assert.equal(regionFromAcceptLanguage('de-CH;q=0.5,en-GB;q=0.9'), 'GB');
  assert.equal(regionFromAcceptLanguage('es-419'), null);
});

test('checkout charges the billing country currency only', () => {
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'GB' }), { ok: true, currency: 'GBP' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'GB', requestedCurrency: 'INR' }), { ok: false, expected: 'GBP', reason: 'currency_mismatch' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'IN', requestedCurrency: 'INR', cardCountry: 'US' }), { ok: false, expected: 'INR', reason: 'card_country_mismatch' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'FR', cardCountry: 'DE' }), { ok: true, currency: 'EUR' });
});
