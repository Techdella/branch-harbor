# @bh/sites — hosted customer websites

The "Hosted" delivery model: every business on BranchHarbor gets a brand site with a location finder,
and every customer-visible location gets its own site with the module for its industry. Sites carry the
**client's** brand (colour, logo, font from a safe list). BranchHarbor only appears as an optional,
off-by-default "Powered by" line in the footer.

Next.js 16 (App Router, `proxy.ts`), React 19, Tailwind 4, next-intl 4. Port **3002**.

```bash
pnpm install                                   # from the repo root
cp apps/sites/.env.example apps/sites/.env.local
pnpm --filter @bh/api dev                      # seeded API (see apps/api/README.md)
pnpm --filter @bh/sites dev                    # http://localhost:3002/stillwater-yoga
```

Seeded examples: `/stillwater-yoga` (studios, 5 public locations; Leslieville is hidden → 404) and
`/maple-and-ember` (foods; Ballard, Fremont, Gastown).

| Env | Meaning |
|---|---|
| `NEXT_PUBLIC_API_URL` | BranchHarbor API. Inlined at build time; `API_URL` overrides it at runtime for server code. |
| `SITES_BASE_URL` | Public included address (`https://sites.branchharbor.com` in production). Used for canonicals, sitemaps and routing. |
| `SITES_EXTRA_HOSTS` | Extra hostnames treated as the included address (comma-separated). |

## Routing

* **Included address**: path-based, `/{brand}` and `/{brand}/{location}/…`.
* **Custom domains**: any other `Host` is resolved by `proxy.ts` through
  `GET /v1/public/sites/resolve-host?host=` (only domains in state `ready`; cached in memory for 60 s,
  misses for 30 s). The request is rewritten onto the path routes, so a location domain serves `/`, `/classes`,
  … and a brand domain serves `/{location}/…`. Unknown hosts get a 404 page; an unreachable API gives a 503 page.
* Links and canonicals follow how the page is being served (`lib/site.ts → makeLinks`). The canonical URL is the
  ready **primary** custom domain when one exists, otherwise the included address. The included address keeps
  working (no redirect) while a domain is being set up.
* Browser calls go through the same-origin proxy `app/api/v1/[...path]` (only `/v1/public/*` is forwarded), so
  every custom domain works without CORS.

| Route | What it shows |
|---|---|
| `/{brand}` | Brand hero, location finder (search by city/name/postcode, country filter, "near me"), list + schematic map, open-now per location |
| `/{brand}/pages/{slug}` | Other published brand pages |
| `/{brand}/{location}` | Location home: hero, offer, about, hours (location timezone, today highlighted), contact, directions, LocalBusiness JSON-LD |
| `/{brand}/{location}/{slug}` | Other published location pages |
| `…/classes`, `…/classes/{id}` | Studios: schedule by day; book (seat hold with countdown → pay → confirmed) or join the waitlist when full |
| `…/order` → `…/orders/{id}?token=` | Foods: pickup slot → menu → modifiers → cart → server quote (tax only if configured) → details → pay → status page that polls and separates "awaiting acceptance" from "accepted" |
| `…/book` | Wellness: service → practitioner or any → date → slot → terms → details → book (→ deposit) |
| `…/programmes` (`?dob=`) | Sports: catalogue with age filter (birth-date ranges per age rule), registration with guardian + participant, form questions (medical/emergency restricted), payment option (full / instalments), refund policy before checkout, first payment → review-pending confirmation (payment ≠ selection) |
| `…/programmes/portal` (`?token=` / `?invite=`) | Guardian portal: emailed sign-in link, participants, schedule + absence reporting, balances + instalment payment, forms, messages, second-guardian invitation, relationship disputes, withdrawal |
| `…/book` | Wellness: service menu by category → length (variant) → practitioner or any (couples: two assigned) → date → slot → policy preview → details (+ second guest, voucher code or package reference, SMS reminder opt-in) → book (→ deposit); full day → join the waitlist for a time window |
| `…/packages` | Wellness: buy session packages and gift vouchers (location currency, sandbox payment), voucher balance check |
| `…/manage/appointment/{id}?token=` · `…/manage/package/{id}` · `…/manage/voucher/{id}` · `…/manage/wellness-waitlist/{id}` | Wellness self-service: policy preview, cancel (late fee acceptance), reschedule (new time secured first); package balance; voucher code + balance; claim an offered waitlist slot |
| `…/programmes` | Sports: guardian + participant registration → review-pending confirmation (payment ≠ selection) |
| `…/shop`, `…/shop/p/{product}`, `…/shop/cart`, `…/shop/orders/{id}?token=`, `…/shop/account` | Commerce storefront: collections, search, product page (variants, this store's stock, sibling stores), cart → pickup / collect at another store / delivery / shipping → server quote with configured taxes → order (stock held for the payment window) → pay → status page with return requests; account (sign in → orders, store credit per currency). Links out instead when an external store (e.g. WooCommerce) is authoritative. Browser calls go through `app/api/shop/[...path]` (public commerce, sandbox confirm, login, `/me/commerce`). |
| `…/manage/booking/{id}?token=` · `…/manage/waitlist/{id}?token=` · `…/manage/appointment/{id}?token=` | Manage pages: cancel booking (refund/void reported from the server), leave waitlist, cancel appointment |
| `/{brand}/sitemap.xml`, `/{brand}/robots.txt` | Per-brand sitemap (canonical URLs) and robots (manage/order pages disallowed); `/sitemap.xml` and `/robots.txt` on custom domains |

If a connected booking/commerce system is authoritative for a location (`module.mode = external`), native
booking is hidden and the page points to that system.


### Real Estate (`realty` brands, e.g. `/keystone-realty`)

| Route | What it shows |
|---|---|
| `/{brand}/properties` | Property search (sale/rent, type, office, city, price range in one currency, beds, baths, minimum area in m² or sq ft), map placeholder, save search with consent-based email alerts |
| `/{brand}/properties/{id}` | Listing: gallery, facts (area in the office unit + the other unit), features, floor plans, tour link, business-supplied disclosures, agents, open houses, book a viewing (slots in the office time zone), enquiry form, `RealEstateListing` JSON-LD |
| `/{brand}/{office}/properties` | Office page: homes, agents, enquiry / valuation form |
| `/{brand}/{office}/manage/viewing/{id}?token=` · `/{brand}/saved-search/{id}?token=` | Manage a viewing request · stop alerts |

## Behaviour rules

* **No mock data.** If the API is unreachable, customers see a friendly error page (`error.tsx`), never invented content.
* **Published content only.** The API returns `page_versions` snapshots referenced by `pages.publishedVersionId`; draft
  edits are never visible. Hidden (not-yet-public) or archived locations 404.
* **Money** is formatted with `Intl.NumberFormat` in the location currency; **times** in the location's IANA timezone
  with a zone label (`lib/format.ts`).
* **Language**: the location's locale (or brand default), switchable via `?lang=` / the switcher among the
  languages the business enabled (`PUT /v1/orgs/:orgId/sites/settings → enabledLocales`). The explicit choice is
  remembered in an essential `bh_lang` cookie. UI strings exist for en, fr, de, es; other enabled locales use English
  UI text with their own number/date formats. Business content is shown as published (not machine-translated).
* **Cookies**: only essential cookies (language choice, cookie choice). The banner says so; no analytics/ads.
* **Theme**: `primaryColor` is checked for WCAG contrast by the API, which returns the button colour/text colour pair
  and a darkened "ink" variant for links. Fonts are limited to a safe list loaded via `next/font`.
* **Payments**: every customer payment (studio bookings, purchases and fees; foods pickup/delivery/preorder, catering
  deposit, tab and meal plans; wellness deposits, packages and vouchers; sports registration and instalments; commerce
  checkout and order page) uses one component, `components/payments/CardPayment.tsx`:
  * **Live** (API with Stripe keys): Stripe.js **Payment Element** (`@stripe/stripe-js` + `@stripe/react-stripe-js`),
    loaded with `loadStripe(pk, { stripeAccount })` because charges are direct charges on the location's connected
    account. The publishable key and account id come from `GET /v1/public/payments/:id` (no secrets). Confirmation uses
    `redirect: 'if_required'` with a `return_url` back to the order/booking status or manage page, so 3-D Secure / SCA
    happens in place; Apple Pay / Google Pay appear automatically where the account and domain allow. Errors are
    localized (en/fr/de/es). The component then **polls the API**: a payment counts only once the signed webhook has
    marked it succeeded — the browser never decides.
  * **Consent**: memberships, meal plans and instalment plans show a required "save this card for renewals /
    instalments" consent; other payments offer "save this card" and, for bookings with a cancellation policy,
    "allow fee charging" with the policy shown. Bookings paid with credits or a membership show the same fee consent on
    the confirmation (`FeeConsent`).
  * **Sandbox** (API without Stripe keys): a clearly labelled "(simulated)" button calls the sandbox-confirm endpoint,
    which runs the same webhook processor as a real payment.
  * **Unavailable**: when Stripe.js can't load (offline, blocked) or the location has no card setup, a friendly
    "card payments are unavailable" message is shown instead of a broken form.
* **Saved cards** (`components/payments/SavedCard.tsx`): studio account, guardian portal (balances tab) and the meal-plan
  page show the card on file and let customers add/update it with a SetupIntent (`stripe.confirmSetup`); a failed
  renewal is retried with the new card by the server.
* **Complete payment** (`/{brand}/{location}/pay/{paymentId}?token=`): signed link emailed when an automatic fee or
  instalment charge needs the customer's bank confirmation (3-D Secure).
* Accessibility: skip link, landmarks, labelled fields with inline errors + error summary, focus moved to step
  headings, native `<dialog>` for modifiers, `aria-live` order status, text + colour for states, 44px targets,
  reduced motion respected, works at 360px.

## Known gaps

* Apple Pay on custom domains requires registering each domain on each connected account (see
  docs/API_INTEGRATIONS.md → Stripe); until then the Payment Element simply doesn't offer Apple Pay there.
* The map is a schematic SVG (no tiles); directions open OpenStreetMap.
* Waitlist offers (spot opened while waitlisted) are completed through the email link handled by the business app,
  not a dedicated page here.
* Rich text is rendered as plain paragraphs (no HTML from page content).
