# Pricing: price book, paid trial, regional tiers and checkout

**Status: proposal — to be validated with pricing tests.** Price book version `2026-11` (`PRICE_BOOK_VERSION` in
`packages/shared/src/pricing.ts`). The model follows the founder's decisions of 15 Oct 2026 and the competitive
research (§8 localised pricing, §10 pricing models).

The price book lives in one place — `packages/shared/src/pricing.ts` — and is read by:

- the marketing site (`apps/web/content/pricing.ts`, `/[locale]/pricing`),
- the app (Settings → Billing, the trial banner, franchisee billing), and
- the API (`apps/api/src/services/billing.ts`, `routes/billing.ts`, `routes/orgs.ts`).

Change a number there and all three update. `packages/shared/src/pricing.test.ts` checks that every required currency
is priced, the plan order (Connector < Solo < Hosted < Network per location < platform fee) holds in every price list,
the trial fee is small, and **every price list stays within its tier's multiplier band** at the reference rates.

## Model

| What | How it is priced |
|---|---|
| **Solo** | One independent location: flat monthly price |
| **Connector** | Keep your WordPress site: per location per month |
| **Hosted** | BranchHarbor-hosted site: per location per month |
| **Network** | A monthly **HQ platform fee** (covers Franchise development, Legal, Finance, Training and Community; **includes 3 locations**, `NETWORK_INCLUDED_LOCATIONS`) + the Network per-location fee for every further location. **Unlimited users.** |
| **Paid trial** | Every plan starts with a **14-day trial for a small fee** (USD 4.99 or the local price point). The chosen plan starts automatically on day 15 unless the customer cancels before. No free plan, no free trial. |
| **Royalty & marketing-fund collection** | A **flat fee per collection, capped per location per month** (USD 1.00, max USD 10). Never a percentage of royalties (`collectionFee`). |
| **Online customer payments** | Stripe Connect application fee of **1 %** (`DEFAULT_PAYMENT_APPLICATION_FEE_BPS` = `STRIPE_APPLICATION_FEE_BPS` default, per org `applicationFeeBps`), plus Stripe's own processing fee. Shown on the pricing page. |
| **Terms** | Monthly by default; annual = 10 × monthly (2 months included, `annualMonthlyPrice`); no cancellation fees; free data export at any time. |
| **Tax** | Prices are **tax-exclusive outside the US** (and exclude US sales tax); VAT/GST/sales tax is added at checkout via Stripe Tax (`STRIPE_TAX_ENABLED`). |

**Who pays a Network location's fee.** HQ always pays the platform fee. For each location beyond the 3 included, HQ
chooses per location or per owner group: **HQ**, **the franchisee** (billed to the franchisee's own billing account, in
the currency and price list of the franchisee's billing country) or a **split** percentage. A location setting wins
over its owner group's; neither → HQ. Included locations are the oldest billable ones (operating, opening soon or in
onboarding). Stored in `location_fee_payers`; shown in Settings → Billing; franchisees see their share at
`/franchisee-billing`.

## Regional tiers

Multiplier = local price ÷ reference exchange rate ÷ USD price. Every list must stay inside its band
(`TIER_MULTIPLIERS`, checked by the tests). Country → tier: `COUNTRY_TIER`; unknown countries are tier A in USD.

| Tier | Target × USD | Band | Countries |
|---|---:|---|---|
| A | 1.00 | 0.90–1.12 | US, CA, UK, IE, AU, NZ, Nordics (SE, NO, DK, FI, IS), CH, LI (+ territories) |
| B | ~0.95 | 0.85–1.07 | Rest of Western Europe, Gulf (AE, SA, QA, KW, BH, OM), SG, HK, JP (+ KR, TW, IL, MO) |
| C | ~0.68 | 0.60–0.75 | Central/Eastern Europe, Latin America, TR, MY |
| D | ~0.50 | 0.45–0.60 | IN and South Asia, Southeast Asia (PH, ID, VN, TH…), Africa (NG, KE, GH, ZA…), EG |

Currencies used by several tiers get **tier variants**: `EUR@C` (euro countries in Central/Eastern Europe), and
`USD@B`, `USD@C`, `USD@D` for countries billed in USD outside tier A (e.g. Korea, Argentina, Vietnam).
`priceListForCountry(country)` picks the list. The euro list serves tier A (IE, FI) and tier B at ~1.05×.

Reference rates (approximate, mid-2026, 1 USD =): CAD 1.37, GBP 0.75, EUR 0.88, AUD 1.52, NZD 1.68, CHF 0.82,
SEK 9.6, NOK 10.2, DKK 6.6, JPY 148, SGD 1.30, HKD 7.8, AED 3.67, SAR 3.75, PLN 3.7, CZK 21.5, MYR 4.3, MXN 18.5,
BRL 5.5, TRY 40, ZAR 18, INR 85, PHP 57, IDR 16,300, EGP 49, NGN 1,550, KES 129, GHS 12 (`REFERENCE_USD_RATES`).

**Outliers adjusted in this version** (previous list → tier band): JPY (0.80 → 0.94), SAR (0.81 → 0.95), CHF (1.22 →
1.09), MYR (0.53 → 0.71), BRL (0.46 → 0.65), TRY (0.45 → 0.61), INR (0.36 → 0.51), PHP (0.40 → 0.49), IDR (0.39 →
0.50), EGP (0.31 → 0.47), NGN (0.30 → 0.47), KES (0.36 → 0.48), GHS (0.35 → 0.48). USD, CAD, GBP, EUR, AUD, NZD,
SEK, NOK, DKK, SGD, HKD, AED, PLN, CZK, MXN and ZAR keep their plan prices (MXN Hosted 649 → 669).

## Price book (proposal: to be validated with pricing tests)

Monthly list prices in whole currency units (trial and collection fees with decimals). Stored and charged in ISO 4217
minor units (`listPriceMinor`): × 100 except JPY. Tax is added on top.

| Price list | Tier | Solo | Connector / loc. | Hosted / loc. | Network / loc. | Network platform fee (incl. 3) | 14-day trial | Collection fee (cap / loc. / month) | Solo annual (per month) | × USD (Solo) |
|---|:-:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| USD | A | 39 | 29 | 59 | 89 | 299 | 4.99 | 1 (10) | 33 | 1.00 |
| CAD | A | 52 | 39 | 79 | 119 | 399 | 6.99 | 1.40 (14) | 43 | 0.97 |
| GBP | A | 31 | 23 | 47 | 71 | 239 | 3.99 | 0.80 (8) | 26 | 1.06 |
| AUD | A | 59 | 45 | 89 | 135 | 449 | 7.99 | 1.50 (15) | 49 | 1.00 |
| NZD | A | 65 | 49 | 95 | 145 | 489 | 8.49 | 1.70 (17) | 54 | 0.99 |
| CHF | A | 35 | 25 | 49 | 75 | 249 | 3.90 | 0.90 (9) | 29 | 1.09 |
| SEK | A | 379 | 279 | 579 | 849 | 2,890 | 49 | 10 (100) | 316 | 1.01 |
| NOK | A | 429 | 319 | 649 | 949 | 3,190 | 55 | 10 (100) | 358 | 1.08 |
| DKK | A | 259 | 189 | 389 | 589 | 1,990 | 35 | 7 (70) | 216 | 1.01 |
| EUR | B | 36 | 27 | 55 | 83 | 279 | 4.49 | 0.90 (9) | 30 | 1.05 |
| JPY | B | 5,400 | 4,000 | 8,200 | 12,400 | 41,000 | 700 | 140 (1,400) | 4,500 | 0.94 |
| SGD | B | 49 | 36 | 75 | 109 | 369 | 6.49 | 1.20 (12) | 41 | 0.97 |
| HKD | B | 279 | 209 | 419 | 629 | 2,090 | 39 | 7 (70) | 233 | 0.92 |
| AED | B | 129 | 99 | 199 | 299 | 999 | 18 | 3.50 (35) | 108 | 0.90 |
| SAR | B | 139 | 99 | 209 | 319 | 1,049 | 18 | 3.50 (35) | 116 | 0.95 |
| PLN | C | 99 | 69 | 149 | 219 | 729 | 14.99 | 2.50 (25) | 83 | 0.69 |
| CZK | C | 590 | 440 | 890 | 1,340 | 4,490 | 89 | 15 (150) | 492 | 0.70 |
| MYR | C | 119 | 85 | 169 | 259 | 869 | 14.90 | 3 (30) | 99 | 0.71 |
| MXN | C | 449 | 329 | 669 | 999 | 3,349 | 69 | 13 (130) | 374 | 0.62 |
| BRL | C | 139 | 99 | 209 | 319 | 1,069 | 17.90 | 3.50 (35) | 116 | 0.65 |
| TRY | C | 949 | 729 | 1,449 | 2,199 | 7,399 | 129 | 25 (250) | 791 | 0.61 |
| ZAR | D | 329 | 249 | 499 | 749 | 2,490 | 49 | 9 (90) | 274 | 0.47 |
| INR | D | 1,699 | 1,249 | 2,499 | 3,799 | 12,999 | 299 | 45 (450) | 1,416 | 0.51 |
| PHP | D | 1,099 | 829 | 1,699 | 2,499 | 8,499 | 149 | 29 (290) | 916 | 0.49 |
| IDR | D | 319,000 | 239,000 | 479,000 | 729,000 | 2,449,000 | 39,000 | 8,000 (80,000) | 265,833 | 0.50 |
| EGP | D | 899 | 679 | 1,399 | 2,099 | 6,999 | 119 | 25 (250) | 749 | 0.47 |
| NGN | D | 28,500 | 21,000 | 43,000 | 65,000 | 219,000 | 2,500 | 750 (7,500) | 23,750 | 0.47 |
| KES | D | 2,400 | 1,800 | 3,650 | 5,500 | 18,500 | 299 | 60 (600) | 2,000 | 0.48 |
| GHS | D | 225 | 165 | 339 | 509 | 1,719 | 29 | 6 (60) | 188 | 0.48 |
| EUR@C | C | 25 | 19 | 37 | 55 | 189 | 2.99 | 0.60 (6) | 21 | 0.73 |
| USD@B | B | 37 | 27 | 55 | 85 | 279 | 4.99 | 0.95 (9.50) | 31 | 0.95 |
| USD@C | C | 27 | 20 | 41 | 62 | 209 | 3.49 | 0.70 (7) | 23 | 0.69 |
| USD@D | D | 19 | 14 | 29 | 44 | 149 | 2.49 | 0.50 (5) | 16 | 0.49 |

### Billing countries per price list

| Price list | Billing countries |
|---|---|
| USD | AS GU IS MP PR UM US VI |
| CAD | CA |
| GBP | GB GG IM JE |
| AUD | AU CC CX NF |
| NZD | CK NU NZ |
| CHF | CH LI |
| SEK | SE |
| NOK | NO |
| DKK | DK FO GL |
| EUR | AD AT AX BE BL CY DE ES FI FR GF GP GR IE IT LU MC MF MQ MT NL PM PT RE SM VA YT |
| JPY | JP |
| SGD | SG |
| HKD | HK |
| AED | AE |
| SAR | SA |
| PLN | PL |
| CZK | CZ |
| MYR | MY |
| MXN | MX |
| BRL | BR |
| TRY | TR |
| ZAR | ZA |
| INR | IN |
| PHP | PH |
| IDR | ID |
| EGP | EG |
| NGN | NG |
| KES | KE |
| GHS | GH |
| EUR@C | BG EE HR LT LV ME SI SK XK |
| USD@B | BH IL KR KW MO OM QA TW |
| USD@C | AL AM AR BA BO CL CO CR DO EC GE GT HN HU JM MD MK NI PA PE PY RO RS SV TT UA UY |
| USD@D | BD BW CI CM DZ ET KH LA LK MA MM MU NA NP PK RW SN TH TN TZ UG VN ZM ZW |

Every other country is billed from the `USD` list (tier A).

**Review cadence:** quarterly for volatile currencies (TRY, NGN, EGP, GHS, ARS-billed USD@C) and yearly for the rest.
Existing subscriptions keep the price stored at checkout until customers are told about a change.

## The paid trial

- Org creation no longer starts a free trial: `POST /v1/orgs` creates the subscription with status
  **`checkout_required`** (plan `solo` for independents, `network` otherwise; price list from the org country,
  provisional).
- `BILLING_ENFORCE` (default **on in production**, off in dev/test): without a paid trial or plan
  (`checkout_required`, `canceled`) organisation data is read-only — writes get `402 plan_required`, except billing,
  onboarding, the organisation profile, access and data export (`services/billing-gate.ts`). The app shows a banner
  linking to Settings → Billing.
- **One paid trial** per business (org), per card (Stripe card fingerprint) and per business email domain (the
  person checking out; webmail addresses count as the full address). Claims are stored hashed in
  `billing_trial_claims`. When a claim exists, checkout says so and **starts the plan straight away** (first period
  charged) instead of a trial.
- **Reminders**: the billing sweep (`runBillingSweep`, every `BILLING_SWEEP_MINUTES`, default 60) emails owners 3 days
  and 1 day before the trial ends (`TRIAL_REMINDER_DAYS`), with the plan price and how to cancel. Not sent once the
  customer has cancelled.
- **Cancel** any time (`POST /billing/cancel`): during the trial nothing more is charged; on a paid plan it runs to
  the end of the paid period. `POST /billing/resume` withdraws it. No cancellation fee.
- Terms are shown on the pricing page (how the trial works, FAQ) and at checkout (bullet list + a required
  "I agree" checkbox; the API requires `acceptTerms: true`).

### Stripe implementation

On the **platform** Stripe account (`integrations/platform-billing.ts`, never a connected account):

1. `POST /v1/orgs/:orgId/billing/checkout` `{ plan, interval, billingCountry, locations?, currency? }` — recomputes the
   quote from the **billing country entered at checkout** (`priceListForCountry`), refuses a client currency that is
   not the country's (`409 currency_mismatch`), creates the Stripe Customer (address country set for Stripe Tax) and a
   **SetupIntent** (off-session card). The locked quote is stored on the subscription (`checkout`).
2. The app confirms the card with the Stripe **Payment Element** (`confirmSetup`, same pattern as the hosted sites'
   `CardPayment`).
3. `POST …/billing/checkout/confirm` `{ setupIntentId, taxId?, acceptTerms: true }` — reads the saved card's
   **issuing country and fingerprint**, runs the country lock (below) and trial eligibility, then creates the
   subscription:
   - `items`: one recurring price per line (Solo; Connector/Hosted × locations; Network platform fee + extra
     locations), lookup-keyed per currency, interval and amount, `tax_behavior: exclusive`;
   - `trial_period_days: 14` and **`add_invoice_items: [{ price_data: trial fee }]`** — Stripe puts the trial fee on
     the first ($0) trial invoice and charges it immediately; the plan bills automatically on day 15 unless cancelled;
   - `payment_behavior: 'error_if_incomplete'`, `automatic_tax: { enabled: STRIPE_TAX_ENABLED }`,
     `trial_settings.end_behavior.missing_payment_method: cancel`.
4. The platform webhook (`/v1/webhooks/stripe`, `processPlatformBillingEvent`) keeps status, trial end and period in
   sync (`customer.subscription.*`), records invoices (`invoice.*` → `billing_invoices`), marks `past_due` on failed
   payments and **re-checks the country lock**.

**Sandbox** (no `STRIPE_SECRET_KEY`): the same endpoints with simulated ids. Payment methods are simulated by id —
`pm_sandbox_card_GB_<fingerprint>` is a card issued in GB; `pm_sandbox_decline…` is declined. The sweep does what
Stripe does live: converts ended trials (or cancels them), renews periods, invoices franchisee shares and applies
scheduled billing-country changes.

## Billing-country lock

- The website shows prices by IP geolocation (`apps/web/lib/geo.ts`) for convenience only.
- At checkout the customer **enters the billing country**; the API recomputes the price list from it and locks it.
- `assertBillingCurrency({ billingCountry, requestedCurrency, cardCountry, taxIdCountry })` (shared): the currency must
  be the billing country's, and **the card must be issued in the billing country — or the customer gives a business
  tax ID from that country** (`taxIdCountry` validates EU VAT prefixes and common national formats; Stripe verifies
  it live). Otherwise checkout is refused with `409 card_country_mismatch`: "This card was issued in X, but your
  billing country is Y. Use a card issued in Y, or add your Y business tax ID."
- The webhook calls `assertBillingCurrency` again on every `customer.subscription.*` event (subscription currency +
  card on file); a violation cancels the subscription immediately and is audited
  (`billing.country_lock_violation`).
- **Changing the billing country** (`POST /billing/country` → card setup for the new country → `/country/confirm`)
  needs a card issued there (or a tax ID from it) and takes effect **next cycle**: the current subscription is set to
  end at the period end, and a new customer + subscription in the new currency/price list starts then (Stripe
  subscriptions cannot change currency). `DELETE /billing/country` withdraws it.
- Stored on the subscription: `billing_country`, `price_list`, `price_book_version`, `country_evidence`
  (`card` | `tax_id`), card brand/last4/country, tax ID.

## Free data export

Settings → **Export your data** (owner only). `POST /v1/orgs/:orgId/exports` queues the `data-export.build` job
(BullMQ with `REDIS_URL`, inline otherwise), which writes one CSV per core table scoped to the organisation —
organization, people (members and roles, never password hashes), locations, regions, owner groups, customers,
consent records, leads, sales deals, class bookings, appointments, registrations, memberships, orders, food orders,
hospitality reservations, products, services, form submissions, payments, refunds, invoices, royalty statements,
franchise prospects and agreements, realty listings and enquiries, BranchHarbor invoices — into a ZIP with a README.
Secret columns (passwords, tokens, hashes, encrypted credentials) are excluded; cells are guarded against
spreadsheet formula injection. The owner gets an email with a download link that works for **7 days**
(`/v1/exports/:id/download?token=…`); the export is also listed and downloadable in Settings while valid. Files go to
S3/R2 when configured, otherwise into Postgres; expired files are purged by the billing sweep.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | — | Live plan billing; without them the sandbox runs |
| `STRIPE_WEBHOOK_SECRET` | — | Platform webhook (subscription and invoice events, country-lock re-check) |
| `STRIPE_TAX_ENABLED` | `false` | Stripe Tax (`automatic_tax`) on plan invoices: VAT/GST/sales tax added to tax-exclusive prices. Register tax registrations in the Stripe Dashboard first |
| `STRIPE_APPLICATION_FEE_BPS` | `100` | Consumer payment application fee (1 %) for new organisations |
| `BILLING_ENFORCE` | on in production | Read-only without a paid trial or plan |
| `BILLING_SWEEP_MINUTES` | `60` | Trial reminders, sandbox conversions/renewals, export purge |

## Geolocation (what the visitor sees)

The pricing page is rendered per request and picks the display price list on the server (`apps/web/lib/geo.ts` →
`countryFromHeaders` + `priceListForCountry`): `x-vercel-ip-country`, then `cf-ipcountry` (ignoring `XX`, `T1`,
`A1`/`A2`, `EU`, `AP`), then the region of the highest-priority `Accept-Language` tag, else USD tier A. There is no
currency selector. Language follows the URL; currency follows location. Test locally with
`curl -H 'x-vercel-ip-country: NG' http://localhost:3000/en/pricing`.

**Founder decisions still open:** approve or edit each row and the tier bands; the platform fee level and the 3
included locations; the collection fee (USD 1, capped at USD 10 per location per month); whether franchisee-paid
shares should be charged through the franchisee's Connect account instead of a card on a platform customer.
