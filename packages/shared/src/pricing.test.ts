import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_CURRENCIES, minorUnitExponent } from './money.ts';
import {
  COUNTRY_TIER, FEE_PRICE_KEYS, LIST_PRICES_MINOR, NETWORK_INCLUDED_LOCATIONS, PLAN_PRICE_KEYS, PRICE_BOOK, PRICE_LISTS, PRICE_LIST_KEYS, PRICED_CURRENCIES,
  REFERENCE_USD_RATES, SOLO_PLAN, TIER_MULTIPLIERS, annualMonthlyPrice, assertBillingCurrency, collectionFee, countryFromHeaders, currencyForCountry,
  extraBrandFee, listPriceMinor, planQuote, priceListCurrency, priceListForCountry, priceListTier, regionFromAcceptLanguage, soloPrice, splitLocationFee, taxIdCountry,
  tierForCountry, trialPrice,
} from './pricing.ts';

const REQUIRED = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'SGD', 'AED', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'ZAR', 'NGN', 'KES', 'GHS', 'EGP', 'SAR', 'HKD', 'PHP', 'MYR', 'IDR', 'PLN', 'CZK', 'TRY'];

test('price book covers every required currency, and every priced currency is supported', () => {
  for (const c of REQUIRED) assert.ok((PRICED_CURRENCIES as string[]).includes(c), `missing ${c}`);
  for (const c of PRICED_CURRENCIES) assert.ok((SUPPORTED_CURRENCIES as readonly string[]).includes(c), `${c} not in SUPPORTED_CURRENCIES`);
});

test('every price list keeps the plan order (connector < solo < hosted < network < platform) with positive prices and a trial fee below Solo', () => {
  for (const k of PRICE_LIST_KEYS) {
    const p = PRICE_LISTS[k];
    for (const item of [...PLAN_PRICE_KEYS, ...FEE_PRICE_KEYS]) assert.ok(p[item] > 0, `${k}.${item}`);
    for (const item of PLAN_PRICE_KEYS) assert.ok(Number.isInteger(p[item]), `${k}.${item} whole`);
    assert.ok(p.connector < p.solo && p.solo < p.hosted && p.hosted < p.network && p.network < p.platform, `${k} plan order`);
    assert.ok(p.trial < p.solo / 2, `${k} trial is a small fee`);
    assert.ok(p.collectionCap >= p.collection * 5, `${k} collection cap`);
    // Trial in minor units is whole (e.g. 4.99 → 499).
    assert.ok(Number.isInteger(listPriceMinor(k, 'trial')));
  }
});

test('each price list stays within its regional tier multiplier band (proposal, reference rates)', () => {
  const usd = PRICE_LISTS.USD;
  const outside: string[] = [];
  for (const k of PRICE_LIST_KEYS) {
    const rate = REFERENCE_USD_RATES[priceListCurrency(k)]!;
    const band = TIER_MULTIPLIERS[priceListTier(k)];
    for (const item of [...PLAN_PRICE_KEYS, 'platform', 'collection', 'collectionCap', 'extraBrand'] as const) {
      const ratio = PRICE_LISTS[k][item] / rate / usd[item];
      if (ratio < band.min || ratio > band.max) outside.push(`${k}.${item} ${ratio.toFixed(3)} (tier ${priceListTier(k)} ${band.min}–${band.max})`);
    }
  }
  assert.deepEqual(outside, []);
});

test('minor units follow ISO 4217 exponents', () => {
  assert.equal(minorUnitExponent('JPY'), 0);
  assert.equal(LIST_PRICES_MINOR.JPY.solo, PRICE_BOOK.JPY.solo);
  assert.equal(LIST_PRICES_MINOR.USD.solo, 3900);
  assert.equal(LIST_PRICES_MINOR.NGN.network, 6_500_000);
  assert.equal(LIST_PRICES_MINOR.USD.trial, 499);
  assert.equal(LIST_PRICES_MINOR.USD.platform, 29_900);
  assert.equal(SOLO_PLAN.priceMinor.EUR, 3600);
  assert.deepEqual(soloPrice('INR'), { amount: 169_900, currency: 'INR', interval: 'month' });
  assert.deepEqual(trialPrice('GBP'), { amount: 399, currency: 'GBP', days: 14 });
  assert.deepEqual(trialPrice('NGN'), { amount: 250_000, currency: 'NGN', days: 14 });
  assert.deepEqual(trialPrice('JPY'), { amount: 700, currency: 'JPY', days: 14 });
  assert.equal(soloPrice('XYZ'), null);
  assert.equal(annualMonthlyPrice(39), 33);
});

test('country → currency, tier and price list; unknown → USD tier A', () => {
  assert.equal(currencyForCountry('US'), 'USD');
  assert.equal(currencyForCountry('gb'), 'GBP');
  assert.equal(currencyForCountry('DE'), 'EUR');
  assert.equal(currencyForCountry('BG'), 'EUR');
  assert.equal(currencyForCountry('NG'), 'NGN');
  assert.equal(currencyForCountry('AR'), 'USD');
  assert.equal(currencyForCountry(null), 'USD');
  assert.equal(tierForCountry('GB'), 'A');
  assert.equal(tierForCountry('FR'), 'B');
  assert.equal(tierForCountry('PL'), 'C');
  assert.equal(tierForCountry('NG'), 'D');
  assert.equal(tierForCountry('ZZ'), 'A');
  assert.equal(COUNTRY_TIER.IN, 'D');
  assert.deepEqual(priceListForCountry('IE'), { key: 'EUR', currency: 'EUR', tier: 'B' });
  assert.deepEqual(priceListForCountry('EE'), { key: 'EUR@C', currency: 'EUR', tier: 'C' });
  assert.deepEqual(priceListForCountry('VN'), { key: 'USD@D', currency: 'USD', tier: 'D' });
  assert.deepEqual(priceListForCountry('KR'), { key: 'USD@B', currency: 'USD', tier: 'B' });
  assert.deepEqual(priceListForCountry('AR'), { key: 'USD@C', currency: 'USD', tier: 'C' });
  assert.deepEqual(priceListForCountry('US'), { key: 'USD', currency: 'USD', tier: 'A' });
  assert.deepEqual(priceListForCountry('NG'), { key: 'NGN', currency: 'NGN', tier: 'D' });
});

test('plan quotes: Network = platform fee (3 locations included) + per-location beyond; annual = 10 months', () => {
  const n2 = planQuote({ priceList: 'USD', plan: 'network', locations: 2 });
  assert.equal(n2.totalMinor, 29_900);
  assert.equal(n2.includedLocations, NETWORK_INCLUDED_LOCATIONS);
  const n5 = planQuote({ priceList: 'USD', plan: 'network', locations: 5 });
  assert.deepEqual(n5.lines.map((l) => [l.kind, l.quantity, l.amountMinor]), [['platform', 1, 29_900], ['location', 2, 17_800]]);
  assert.equal(n5.totalMinor, 47_700);
  assert.equal(planQuote({ priceList: 'USD', plan: 'network', locations: 5, interval: 'year' }).totalMinor, 477_000);
  assert.equal(planQuote({ priceList: 'GBP', plan: 'solo', locations: 4 }).totalMinor, 3100);
  assert.equal(planQuote({ priceList: 'EUR', plan: 'hosted', locations: 3 }).totalMinor, 16_500);
  assert.equal(planQuote({ priceList: 'NGN', plan: 'hosted' }).trialFeeMinor, 250_000);
});

test('who pays a location fee; royalty collection fee is flat and capped', () => {
  assert.deepEqual(splitLocationFee(8900, 'hq'), { hqMinor: 8900, franchiseeMinor: 0 });
  assert.deepEqual(splitLocationFee(8900, 'franchisee'), { hqMinor: 0, franchiseeMinor: 8900 });
  assert.deepEqual(splitLocationFee(8900, 'split', 40), { hqMinor: 5340, franchiseeMinor: 3560 });
  assert.deepEqual(collectionFee('USD', 3), { perCollectionMinor: 100, capMinor: 1000, chargedMinor: 300 });
  assert.equal(collectionFee('USD', 30).chargedMinor, 1000);
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

test('checkout charges the billing country price list; the card must be from that country unless a local tax ID is given', () => {
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'GB' }), { ok: true, currency: 'GBP', priceList: 'GBP', evidence: 'none' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'GB', requestedCurrency: 'INR' }), { ok: false, expected: 'GBP', reason: 'currency_mismatch' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'IN', requestedCurrency: 'INR', cardCountry: 'US' }), { ok: false, expected: 'INR', reason: 'card_country_mismatch' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'FR', cardCountry: 'DE' }), { ok: false, expected: 'EUR', reason: 'card_country_mismatch' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'FR', cardCountry: 'DE', taxIdCountry: 'FR' }), { ok: true, currency: 'EUR', priceList: 'EUR', evidence: 'tax_id' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'ng', cardCountry: 'NG' }), { ok: true, currency: 'NGN', priceList: 'NGN', evidence: 'card' });
  assert.deepEqual(assertBillingCurrency({ billingCountry: 'NGA' }), { ok: false, expected: 'USD', reason: 'invalid_country' });
});

test('tax ID country', () => {
  assert.equal(taxIdCountry('FR 40 303 265 045', 'FR'), 'FR');
  assert.equal(taxIdCountry('DE123456789', 'FR'), null);
  assert.equal(taxIdCountry('EL123456789', 'GR'), 'GR');
  assert.equal(taxIdCountry('GB123456789', 'GB'), 'GB');
  assert.equal(taxIdCountry('12345678-0001', 'NG'), 'NG');
  assert.equal(taxIdCountry('xx', 'US'), null);
  assert.equal(taxIdCountry('123456789', 'DE'), null);
});

test('multi-brand HQ: each brand beyond the first adds the extra-brand fee (USD 99), below the platform fee in every list', () => {
  assert.equal(LIST_PRICES_MINOR.USD.extraBrand, 9_900);
  for (const k of PRICE_LIST_KEYS) assert.ok(PRICE_LISTS[k].extraBrand < PRICE_LISTS[k].platform, `${k} extra brand below platform`);
  assert.deepEqual(extraBrandFee('USD', 1), { perBrandMinor: 9_900, extraBrands: 0, chargedMinor: 0 });
  assert.deepEqual(extraBrandFee('USD', 3), { perBrandMinor: 9_900, extraBrands: 2, chargedMinor: 19_800 });
  assert.equal(extraBrandFee('JPY', 2).chargedMinor, 13_500);
  // In the plan quote: one `brand` line per extra brand (annual = 10 months), never on Solo.
  const q = planQuote({ priceList: 'USD', plan: 'network', locations: 5, brands: 3 });
  assert.deepEqual(q.lines.find((l) => l.kind === 'brand'), { kind: 'brand', quantity: 2, unitMinor: 9_900, amountMinor: 19_800 });
  assert.equal(q.totalMinor, planQuote({ priceList: 'USD', plan: 'network', locations: 5 }).totalMinor + 19_800);
  assert.equal(planQuote({ priceList: 'USD', plan: 'network', locations: 5, brands: 2, interval: 'year' }).lines.find((l) => l.kind === 'brand')!.amountMinor, 99_000);
  assert.equal(planQuote({ priceList: 'USD', plan: 'hosted', locations: 2, brands: 1 }).lines.some((l) => l.kind === 'brand'), false);
  assert.equal(planQuote({ priceList: 'USD', plan: 'solo', brands: 4 }).lines.some((l) => l.kind === 'brand'), false);
});
