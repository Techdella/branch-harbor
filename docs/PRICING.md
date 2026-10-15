# Pricing: price book, geolocation and checkout currency

**Status: proposed — for founder approval.** Price book version `2026-10` (`PRICE_BOOK_VERSION` in
`packages/shared/src/pricing.ts`). Nothing here is charged yet: there is no BranchHarbor subscription checkout in the
API today (see [Checkout enforcement](#checkout-enforcement)).

The price book lives in one place — `packages/shared/src/pricing.ts` — and is read by:

- the marketing site (`apps/web/content/pricing.ts`, `/[locale]/pricing`), and
- the API (`soloPrice`, `LIST_PRICES_MINOR` in `apps/api/src/services/businessMode.ts` and `routes/orgs.ts`).

Change a number there and both update. `packages/shared/src/pricing.test.ts` checks that every required currency is
priced, every priced currency is in `SUPPORTED_CURRENCIES`, prices are whole and positive, and the plan order
(Connector < Solo < Hosted < Network) holds in every currency.

## Plans

| Plan | What it is | Billing |
|---|---|---|
| Solo | One independent location: hosted site, dashboard, industry workflows | Flat monthly price |
| Connector | Keep your WordPress site; connector plugin and dashboard | Per location per month |
| Hosted | BranchHarbor-hosted site with industry workflows | Per location per month |
| Network | Franchises and groups: regions, owner groups, templates, group publishing | Per location per month; quote available |

Annual billing includes two months: the monthly equivalent is `round(monthly × 10 / 12)` (`annualMonthlyPrice`).
There is no free plan and no free trial on the marketing site; visitors can **try the demo** (`NEXT_PUBLIC_DEMO_URL`,
default `https://demo.branchharbor.com`) or **start a plan** (self-service sign-up, every industry).

## Price book (monthly list prices, whole currency units)

| Currency | Solo | Connector / location | Hosted / location | Network / location | Solo, annual (per month) | Billing countries |
|---|---:|---:|---:|---:|---:|---|
| USD | 39 | 29 | 59 | 89 | 33 | US, PR, GU, VI, AS, MP, UM — and every country not listed below |
| CAD | 52 | 39 | 79 | 119 | 43 | CA |
| GBP | 31 | 23 | 47 | 71 | 26 | GB, IM, JE, GG |
| EUR | 36 | 27 | 55 | 83 | 30 | Euro area (AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES) + AD MC SM VA ME XK and French overseas territories, AX |
| AUD | 59 | 45 | 89 | 135 | 49 | AU, CX, CC, NF |
| NZD | 65 | 49 | 95 | 145 | 54 | NZ, CK, NU |
| CHF | 39 | 29 | 59 | 89 | 33 | CH, LI |
| SEK | 379 | 279 | 579 | 849 | 316 | SE |
| NOK | 429 | 319 | 649 | 949 | 358 | NO |
| DKK | 259 | 189 | 389 | 589 | 216 | DK, GL, FO |
| JPY | 4,600 | 3,400 | 7,000 | 10,500 | 3,833 | JP |
| SGD | 49 | 36 | 75 | 109 | 41 | SG |
| HKD | 279 | 209 | 419 | 629 | 233 | HK |
| AED | 129 | 99 | 199 | 299 | 108 | AE |
| SAR | 119 | 89 | 179 | 269 | 99 | SA |
| PLN | 99 | 69 | 149 | 219 | 83 | PL |
| CZK | 590 | 440 | 890 | 1,340 | 492 | CZ |
| MYR | 89 | 65 | 129 | 189 | 74 | MY |
| MXN | 449 | 329 | 649 | 999 | 374 | MX |
| BRL | 99 | 79 | 159 | 249 | 83 | BR |
| TRY | 699 | 529 | 1,049 | 1,599 | 583 | TR |
| ZAR | 329 | 249 | 499 | 749 | 274 | ZA |
| INR | 1,199 | 899 | 1,799 | 2,699 | 999 | IN |
| PHP | 899 | 649 | 1,349 | 1,999 | 749 | PH |
| IDR | 249,000 | 189,000 | 389,000 | 579,000 | 207,500 | ID |
| EGP | 599 | 449 | 899 | 1,299 | 499 | EG |
| NGN | 18,000 | 13,500 | 27,500 | 41,500 | 15,000 | NG |
| KES | 1,800 | 1,300 | 2,700 | 4,000 | 1,500 | KE |
| GHS | 165 | 120 | 250 | 375 | 138 | GH |

Amounts are stored and charged in ISO 4217 minor units (`LIST_PRICES_MINOR`): × 100 for every currency above except
JPY (exponent 0). Taxes (VAT, GST, sales tax) are added where applicable and are not included.

### How the numbers were set

`price = USD list price × reference exchange rate × purchasing-power factor`, then rounded to a local price point
(…9 / …99 endings, round hundreds or thousands for large-unit currencies). USD, CAD, GBP, EUR and AUD keep the list
prices published before this change.

| Tier | Factor (vs USD) | Currencies |
|---|---|---|
| Reference | 1.00 (published list prices) | USD, CAD, GBP, EUR, AUD |
| High income | 0.8 – 1.1 | NZD, CHF (≈1.1, Swiss price level), SEK, NOK, DKK, JPY (≈0.8), SGD, HKD, AED, SAR (≈0.8) |
| Upper-middle income | 0.45 – 0.7 | PLN, CZK, MYR, MXN, BRL, TRY, ZAR |
| Lower-middle income | 0.30 – 0.40 | INR, PHP, IDR, EGP, NGN, KES, GHS |

Reference rates used (approximate, mid-2026, 1 USD =): CAD 1.37, GBP 0.75, EUR 0.88, AUD 1.52, NZD 1.68, CHF 0.82,
SEK 9.6, NOK 10.2, DKK 6.6, JPY 148, SGD 1.30, HKD 7.8, AED 3.67, SAR 3.75, PLN 3.7, CZK 21.5, MYR 4.3, MXN 18.5,
BRL 5.5, TRY 40, ZAR 18, INR 85, PHP 57, IDR 16,300, EGP 49, NGN 1,550, KES 129, GHS 12.

**Review cadence:** quarterly for high-inflation or volatile currencies (TRY, NGN, EGP, GHS) and
yearly for the rest. Existing subscriptions keep their price until notified (the pricing page promises
advance notice).

**Founder decisions needed:** approve or edit each row; confirm USD as the fallback for unlisted countries (e.g.
Argentina, Chile, Colombia, Vietnam, Thailand, South Korea are billed in USD today); confirm the Network quote rule.

## Geolocation (what the visitor sees)

The pricing page is rendered per request (`dynamic = 'force-dynamic'`) and picks the display currency on the server
(`apps/web/lib/geo.ts` → `countryFromHeaders` + `currencyForCountry` in `@bh/shared`):

1. `x-vercel-ip-country` (Vercel), else
2. `cf-ipcountry` (Cloudflare), ignoring placeholder codes (`XX`, `T1` Tor, `A1`/`A2` proxies, `EU`, `AP`), else
3. the region of the highest-priority `Accept-Language` tag that has one (`pt-BR` → BR, `zh-Hant-HK` → HK), else
4. no country → **USD**.

Country → currency uses `COUNTRY_CURRENCY`; unknown countries → USD. There is **no currency selector**. Under the
plans the page says: "Prices shown in {currency} for {country}. You're billed in the currency of your billing country."

Language is independent: it follows the URL (`/fr/pricing`), the currency follows location. A visitor in Lagos reading
`/fr/pricing` sees naira with French copy.

Hosting without geolocation headers (self-hosted, local dev) falls back to Accept-Language, then USD. Test locally with
`curl -H 'x-vercel-ip-country: NG' http://localhost:3000/en/pricing`.

## Checkout enforcement

Showing a local price is not enough: a visitor could use a VPN to see a cheaper market. **The currency charged must
follow the billing country**, never the display currency or a client-supplied currency.

### What the API does today

There is no BranchHarbor subscription checkout yet. The only place a subscription is created is
`POST /v1/orgs` (`apps/api/src/routes/orgs.ts`): it now sets the subscription currency and the Solo price from
`currencyForCountry(org.country)` — the organisation's country is the billing country — instead of the currency the
client sent as `defaultCurrency`. The organisation's operating currency (`defaultCurrency`) is unaffected.

### Where the Stripe check must go (when checkout is built)

Use `assertBillingCurrency({ billingCountry, requestedCurrency, cardCountry })` from `@bh/shared` in two places:

1. **Creating the checkout session** — e.g. a future `POST /v1/orgs/:id/billing/checkout` in
   `apps/api/src/routes/orgs.ts` (or a new `routes/billing.ts`):
   - Billing country = the organisation's country (or the billing address on file). Reject a request whose
     `currency` doesn't match with `409 currency_mismatch`.
   - Create one Stripe Price per plan × currency from `LIST_PRICES_MINOR` (store their IDs, e.g. a `plan_prices` table
     keyed by plan + currency + price-book version) and pass only the price for `currencyForCountry(billingCountry)`.
   - Set `billing_address_collection: 'required'`, prefill the customer's address, and set
     `customer_update: { address: 'never' }` so the address can't be changed inside Checkout to another market. Turn on
     Stripe Tax (`automatic_tax`) for VAT/GST.
2. **Confirming it** — in the Stripe webhook handler for `checkout.session.completed` /
   `customer.subscription.created` (next to the existing Connect webhooks in `apps/api/src/services/payments.ts`):
   - Read `customer_details.address.country` and the payment method's `card.country`.
   - Call `assertBillingCurrency`. If `currency_mismatch` or `card_country_mismatch`, don't activate: cancel the
     subscription (or mark it `incomplete` for manual review) and ask the customer to update their billing country.
     Cards issued abroad are legitimate for some businesses, so route `card_country_mismatch` to review rather than
     an automatic refusal if support prefers.
   - Store the billing country and price-book version on the subscription.

Changing billing country later goes through support or a settings flow that re-runs the same check and moves the
subscription to the new currency's price at the next renewal.
