# Third-party APIs to connect

This is everything BranchHarbor needs to connect before it's production-ready for an international launch (US, Canada, UK, EU, Australia/NZ, Singapore, UAE, Brazil, Mexico). Every integration in the codebase is optional at boot. When a key is missing, the adapter runs in a logged **sandbox/disabled** mode, so local development works with no accounts at all.

**Priority:** P0 = needed before the first pilot goes live. P1 = needed during the pilot or for the second vertical. P2 = later, or nice to have.

Env var names match `apps/api/.env.example`, `apps/app/.env.example` and `apps/mobile/.env.example`.

---

## 1. Core platform (P0)

| # | Service | What it's for | Recommended provider | Alternatives | Env vars |
|---|---|---|---|---|---|
| 1 | **Payments: customer payments** | Bookings, orders, registrations, deposits; one connected account per location or owner group; refunds; payouts. Webhooks confirm outcomes. | **Stripe Connect** (direct charges, Express/Standard accounts). Covers 45+ countries including every launch market. | Adyen for Platforms (enterprise, strong in EU), Mollie Connect (EU), Square (US/CA/UK/AU/IE/FR/ES/JP; also a POS integration) | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID` (see [Stripe: what is live](#stripe-what-is-live-and-what-to-configure)) |
| 2 | **Payments: BranchHarbor subscription billing** | Per-location plan billing, invoices, dunning, customer portal | **Stripe Billing** (same account as #1, kept logically separate) | Paddle or Lemon Squeezy as merchant of record, if you'd rather not handle global SaaS VAT/GST yourself | `STRIPE_BILLING_PRICE_*` |
| 3 | **Tax calculation** | Sales tax / VAT / GST on customer payments and on SaaS billing. US nexus, EU OSS, UK VAT, Canadian GST/HST/PST, Australian GST. | **Stripe Tax** | Avalara, TaxJar, Anrok (SaaS tax) | Stripe key + tax registrations configured in the dashboard |
| 4 | **Transactional email** | Verification, invites, booking/order confirmations, receipts, approvals | **Postmark** | Resend, Amazon SES, SendGrid. Mailpit for local dev (already in docker-compose). | `EMAIL_PROVIDER`, `POSTMARK_SERVER_TOKEN` / `RESEND_API_KEY`, `EMAIL_FROM` |
| 5 | **AI (BranchHarbor AI)** | Drafting copy, summaries, proposed actions with approval, per spec §15 | **Anthropic Claude API** (Messages API with tool use). Check data-retention and zero-retention terms before you make privacy claims. | — | `ANTHROPIC_API_KEY`, `AI_MODEL` |
| 6 | **Custom domains + SSL for hosted sites** | Customer connects `www.theirbrand.com`. DNS verification, automatic certificates, routing to sites.branchharbor.com. | **Cloudflare for SaaS** (Custom Hostnames API) | Vercel Domains API, AWS CloudFront + ACM, Approximated.app | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `SITES_FALLBACK_ORIGIN` |
| 7 | **File / media storage** | Brand assets, menu and product images, location photos, CSV imports, data exports | **Cloudflare R2** (S3-compatible, no egress fees) | AWS S3, Google Cloud Storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` |
| 8 | **Image CDN / transforms** | Responsive images for hosted sites and apps | Cloudflare Images, or Next.js image optimisation on Vercel | imgix, Cloudinary | `IMAGE_CDN_URL` |
| 9 | **Database (managed Postgres)** | Primary datastore with separate US / EU / APAC data-residency regions | **Neon** or **AWS RDS / Aurora Postgres**, one cluster per data region | Supabase, Crunchy Bridge, Google Cloud SQL | `DATABASE_URL` (plus `DATABASE_URL_EU`, `DATABASE_URL_APAC` when residency is enabled) |
| 10 | **Redis / job queue** | Background jobs: sync, webhooks retry, publish jobs, reminders | **Upstash Redis** or AWS ElastiCache | Redis Cloud | `REDIS_URL` |
| 11 | **Error monitoring** | Errors in API, web, app and mobile | **Sentry** | Bugsnag, Datadog | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_SENTRY_DSN` |
| 12 | **Mobile push notifications** | Booking reminders, order status, approvals for owners, kitchen alerts | **Expo Push Service** (wraps APNs + FCM) | OneSignal; direct APNs/FCM | `EXPO_ACCESS_TOKEN`; Apple APNs key and Firebase FCM credentials uploaded to EAS |
| 13 | **App Store / Play Store** | Publishing the iOS and Android apps | Apple Developer Program, Google Play Console, Expo EAS Build/Submit | — | EAS project ID, store credentials (kept in EAS, not in the repo) |

## 2. Customer communication (P0–P1)

| # | Service | What it's for | Recommended | Alternatives | Env vars |
|---|---|---|---|---|---|
| 14 | **SMS** | Reminders, waitlist offers, OTP, order-ready texts. Needs international sender registration (US A2P 10DLC, Canadian short code, UK alphanumeric sender ID). | **Twilio Messaging** | Vonage, MessageBird (Bird), Sinch | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` |
| 15 | **WhatsApp** | Unified inbox and template messages. Very popular in the EU, LATAM, UAE and Singapore. | **WhatsApp Business Cloud API (Meta)** | Twilio WhatsApp, 360dialog | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` |
| 16 | **Social inbox and publishing** | Instagram/Messenger DMs, page posts, HQ-owned social accounts (prototype Marketing suite) | **Meta Graph API** (Instagram + Facebook) | — | `META_APP_ID`, `META_APP_SECRET` |
| 17 | **Email marketing** | Campaigns and newsletters per location (or build natively on #4 with a broadcast stream) | Postmark Broadcast / native | Mailchimp API, Klaviyo (commerce) | `MAILCHIMP_CLIENT_ID/SECRET` (if connector) |

## 3. Location and local presence (P0–P1)

| # | Service | What it's for | Recommended | Alternatives | Env vars |
|---|---|---|---|---|---|
| 18 | **Maps, geocoding and address autocomplete** | Location finder, address entry for any country, timezone lookup from coordinates | **Google Maps Platform** (Places Autocomplete, Geocoding, Time Zone API) | Mapbox + Mapbox Search, HERE | `GOOGLE_MAPS_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` |
| 19 | **Google Business Profile** | Review monitoring and replies per location (live, see [Reviews](#reviews-requests-and-google-business-profile)); listings sync of hours, special hours and details (see [Local marketing](#local-marketing-listings-call-tracking-co-op-fund-and-local-social)) | **Google Business Profile APIs** (requires Google approval) | — | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| 20 | **Calendar sync** | Staff schedules and appointments to Google/Outlook calendars | **Google Calendar API**, **Microsoft Graph** | Nylas (one API for both) | `GOOGLE_OAUTH_*`, `MS_GRAPH_CLIENT_ID/SECRET` |

## 4. Industry connectors: "existing-system connection" model (P1, pick per pilot)

Each connector needs a partner/developer account and a documented source-of-truth rule (spec §16–17).

| Vertical | Connectors to build first | Notes |
|---|---|---|
| Studios | **Mindbody API** (partner program, paid), **Momence**, **Glofox (ABC)**, **Arketa**, **WellnessLiving** | Mindbody is the largest worldwide; access needs partner approval and per-site activation |
| Sports | **TeamSnap**, **LeagueApps**, **Spond** (strong in Europe), **PlayHQ** (Australia) | Most of this is native in BranchHarbor. Connectors are for importing rosters. |
| Wellness | **Mindbody/Booker**, **Fresha**, **Vagaro**, **Phorest** (UK/IE), **Timely** (AU/NZ), **Jane** (CA) | Administrative data only, no clinical records (spec §11) |
| Commerce | **WooCommerce REST API** (via the WordPress connector), **Shopify Admin API**, **Lightspeed Retail**, **Square Catalog/Orders** | WooCommerce HPOS compatibility required |
| Foods | **Toast**, **Square for Restaurants**, **Lightspeed Restaurant**, **Deliverect** (aggregates Uber Eats, Deliveroo, DoorDash and Just Eat across 40+ countries), **Otter** | Deliverect is the fastest route to international delivery marketplaces |
| All | **WordPress REST API + Application Passwords** (our own plugin), **Zapier** (public app), **Make** | WordPress plugin is first-party (spec §16) |
| Finance | **Xero**, **QuickBooks Online**, **Sage** (UK/EU) | Payouts, fees and per-location revenue export |

## 5. Identity and security (P0–P1)

| # | Service | What it's for | Recommended | Notes / env vars |
|---|---|---|---|---|
| 21 | **Social / SSO sign-in** | "Continue with Google / Apple / Microsoft", SSO for enterprise franchise networks | Google, Sign in with Apple (required on iOS if other social logins exist), Microsoft Entra; **WorkOS** for SAML/SCIM | `GOOGLE_OAUTH_*`, `APPLE_*`, `WORKOS_API_KEY` |
| 22 | **Bot protection** | Demo form, signup and public booking abuse | **Cloudflare Turnstile** | hCaptcha. `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` |
| 23 | **Secrets management** | Provider tokens per tenant (OAuth refresh tokens, API keys) encrypted at rest | AWS KMS / GCP KMS envelope encryption, or Doppler / 1Password for platform secrets | `ENCRYPTION_KEY` / `KMS_KEY_ID` |
| 24 | **Consent / cookie banner** | GDPR/UK GDPR/ePrivacy cookie consent on hosted sites and marketing site | Self-built (light), or **Cookiebot** / **Osano** | Needed for the EU/UK launch |

## 6. Money and internationalisation helpers (P1)

| # | Service | What it's for | Recommended | Env vars |
|---|---|---|---|---|
| 25 | **FX rates** | Optional *disclosed* converted totals in network reports. Never silently combined (spec §6, §14). | **Open Exchange Rates** or **ECB reference rates** (free, EUR base) | `OPENEXCHANGERATES_APP_ID` |
| 26 | **Translation management** | Managing UI strings in en/fr/es/de/pt-BR/nl/it/ar | **Crowdin** or **Lokalise** (GitHub sync of `messages/*.json`) | CI token |
| 27 | **Machine translation for customer content** (optional) | Translating location pages and menus on request, always reviewed by a human | DeepL API | `DEEPL_API_KEY` |

## 7. Domains purchase (P2: "Buy a domain, later" in the spec)

| Service | Recommended | Alternatives |
|---|---|---|
| Registrar reseller API | **Cloudflare Registrar** (no public reseller API yet; check), **OpenSRS (Tucows)**, **Name.com API** | Gandi, Namecheap API |

## 8. Product analytics and ops (P1)

| # | Service | What it's for | Recommended | Env vars |
|---|---|---|---|---|
| 28 | Product analytics | Setup completion, time to publish and the other pilot measures (spec §20). EU hosting available. | **PostHog** (EU cloud) | `POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_KEY` |
| 29 | Uptime / status page | Public status for connections and outages | Better Stack, Instatus | — |
| 30 | Logs | Structured API logs | Better Stack Logs, Datadog, Axiom | `LOG_DRAIN_URL` |
| 31 | Hosting | Web + app (Next.js), API (Node), workers | **Vercel** (web/app) + **Fly.io / Render / AWS ECS** (API + workers) in US, EU and APAC regions | — |

## 9. Delivery partners, POS/marketplaces and property portals (implemented; sandbox until credentials)

All of these are configured **per location / office** in the business app: **Connections → Partner integrations** (API: `/v1/orgs/{orgId}/partner-connections`). Credentials are encrypted with `ENCRYPTION_KEY` and only ever returned masked. Every connection starts in **sandbox** (nothing is sent). It becomes **live** only when its credentials are complete, **Test connection** passes and someone with *Manage connections* switches it to live. New credentials always drop it back to sandbox. Pull-based portal feeds show **Waiting for the portal** until the portal has fetched the feed URL at least once.

Assumptions that must be confirmed during each partner's onboarding are marked `ASSUMPTION` in the code (`apps/api/src/integrations/partners/*.ts`, `apps/api/src/integrations/realty-portals.ts`).

### 9.1 Uber Direct (Foods — courier delivery)

Partner approval: an **Uber Direct business account** with API access in the location's country. Availability is checked before quoting. The default country list is in `uber-direct.ts` and can be overridden with `UBER_DIRECT_COUNTRIES`. Outside those countries orders are delivered by your own drivers, and the customer sees a notice saying so.

1. In the Uber Direct dashboard → *Developer*: copy **Client ID**, **Client secret** and **Customer ID**. The API uses OAuth client credentials (`POST https://auth.uber.com/oauth/v2/token`, scope `eats.deliveries`). Tokens are cached until 60 s before they expire.
2. Dashboard → *Webhooks*: add `https://<api-host>/v1/webhooks/uber-direct` for **Delivery status** and **Courier update**. Copy the **Webhook signing key**. Signatures are HMAC-SHA256 of the raw body, sent in `x-uber-signature` (or the legacy `x-postmates-signature`).
3. In BranchHarbor: Connections → Partner integrations → location → **Uber Direct → Set up**. Paste the values and choose the delivery fee mode:
   - **absorb**: customers pay your zone fee and you pay Uber.
   - **pass_through**: customers pay the Uber quote. This only applies when the quote is in the location currency. Otherwise the zone fee applies.
4. **Test connection** (gets a token), then **Go live**. In the location's ordering settings, set the delivery provider to *Uber Direct*.
5. Flow: checkout quote (`POST /v1/customers/{customer_id}/delivery_quotes`; pickup-ready time = now + kitchen prep, aimed at the delivery slot) → staff **Send to Uber Direct**. This creates the delivery with `external_id` = our delivery id and the same `idempotency_key`, reusing the quote while it's valid. Status webhooks then move the delivery and the order (picked up → *out for delivery*, delivered → *delivered*). The courier tracking link appears on the customer's order page. Cancelling the order cancels the courier.

### 9.2 Deliverect (Foods — POS injection and marketplaces)

Partner approval: **Deliverect partner credentials**. Staging comes first. Production requires Deliverect certification. You also need the restaurant's Deliverect account and location.

1. From Deliverect: **client_id / client_secret** (OAuth: `POST {base}/oauth/token`, `audience` = base URL), the customer's **account id** and **location id**, and for POS injection the **channel name** assigned to BranchHarbor plus the location's **channel link id**.
2. Register the order webhook `https://<api-host>/v1/webhooks/deliverect` with Deliverect. This one URL receives orders, cancellations (status 100) and busy mode. HMAC-SHA256 hex arrives in `x-server-authorization-hmac-sha256`. Staging signs with the channel link id. Production uses the secret generated in Deliverect's integration settings: paste it as **Webhook HMAC secret**, or set `DELIVERECT_WEBHOOK_SECRET`.
3. In BranchHarbor: Partner integrations → **Deliverect → Set up**. Choose the environment (staging / production) and switch on what you need:
   - **Send accepted orders to the POS** (`POST {base}/{channelName}/order/{channelLinkId}` once per order).
   - **Receive marketplace orders** (Uber Eats, Deliveroo, DoorDash, Just Eat). These are created as BranchHarbor orders with channel attribution, idempotent per channel order id. Totals come from Deliverect's integers with `decimalDigits` converted to the location currency's minor units. Tax, delivery, bag and small-order fees, tip and channel discount are recorded. Marketplace emails are not stored.
   - Optionally, **auto-accept**.
4. **Test connection**, then **Go live**. **Push menu to Deliverect** sends the location's menu at the location's prices (`POST {base}/productAndCategories`) and snoozes sold-out items. Allergen tags are sent only for allergens the business declared. "Wheat" has no Deliverect tag and is reported as not sent. **Pause marketplaces** sets busy mode.
5. Our status changes are sent back to Deliverect (`POST {base}/orderStatus/{orderId}`): 20 accepted, 50 preparing, 70 ready, 90 finalized, 110 rejected/cancelled.

### 9.3 Rightmove (UK) — Real Time Datafeed, push

Partner approval: email the **Rightmove Data Feed team** to have a new RTDF **network** set up for BranchHarbor as the feed provider. They issue:
- a **Network ID**
- a **client certificate** (ask for PKCS#12)
- test URLs for the beta phase

Each office needs its **Branch ID**.

1. Partner integrations → office → **Rightmove → Set up**. Enter the Network ID and Branch ID, paste the certificate as base64 (`base64 -w0 cert.p12`) plus its password. For beta testing, enter Rightmove's test **API base URL**. Leave it empty for production (`https://adfapi.rightmove.co.uk`).
2. **Test connection** calls `GetBranchPropertyList` over mutual TLS. Then **Go live**.
3. Listings opted into Rightmove are validated:
   - full UK postcode
   - bedrooms
   - photos at public http(s) URLs
   - description
   - price (or POA)
   - valid price qualifier (lettings: default/POA only)
   - rent frequency for lettings
   - tenure (sales) and council tax band, from the listing's *portal details* or the business's disclosures
4. **Send / publish now** sends each valid listing with `SendProperty` (`agent_ref` = listing reference). Withdrawn, sold or let listings, and listings that are opted out, are removed with `RemoveProperty`. Results and Rightmove errors/warnings appear on **Portal feeds**.

### 9.4 idealista (Spain, Portugal, Italy) — hosted JSON feed, pull

Partner approval: ask idealista (your account manager / *idealista tools* support) to enable **automatic import ("carga automática") from a feed** for your professional account.

1. Partner integrations → office → **idealista → Set up**: customer code (`ilc…`) and contact email.
2. Give idealista the **Feed URL** shown on the card. It's a signed, per-office URL. Treat it as a secret, and use **New feed URL** to rotate it. idealista can also take the same file by FTP, but BranchHarbor doesn't upload by FTP.
3. **Test connection** builds the feed. **Go live** after idealista confirms. The status reads *Waiting for the portal* until idealista fetches the URL.
4. Validation: built area (m²), postal code, an energy certificate rating supplied by the business (A–G, *in process* or *exempt*), photos, and description. Rentals are priced per month. Listings leave the feed when withdrawn or sold.

### 9.5 Zillow / RESO (US, Canada) — hosted XML feed, pull

Partner approval: apply to **Zillow Listing Feeds** for your brokerage, or to the syndicator/MLS that accepts this layout. Canadian listings normally go through your board (CREA DDF®), so confirm that the target portal accepts direct feeds.

1. Partner integrations → office → **Zillow / RESO XML → Set up**: the feed id the portal assigns and the licensed brokerage name.
2. Give the portal the **Feed URL**, run **Test connection**, then **Go live**.
3. Validation: ZIP/postal code, state/province, bedrooms and bathrooms (residential), photos, a listing agent with an email address, and, in Canada, the brokerage disclosure. Element names follow the Zillow feed layout. The equivalent RESO Data Dictionary names are noted in the file.

### 9.6 REAXML (Australia, New Zealand) — hosted XML feed, pull

Partner approval: ask **realestate.com.au** (REA) and/or **Domain** to enable REAXML import for your agency and give you the agency/agent id.

1. Partner integrations → office → **REAXML → Set up**: the portal agent id.
2. Give the portal the **Feed URL**, run **Test connection**, then **Go live**.
3. Validation: state (NSW, VIC, …), postcode, a headline of 80 characters or fewer, at most 26 photos, rentals priced per **week**, photos, and description. Withdrawn, sold and let listings stay in the file for 30 days with `status="withdrawn|sold|leased"`, so the portal archives them.

### 9.7 Testing without partners

`pnpm --filter @bh/api test` covers these integrations with an injected mock `fetch` (`Services.partnerFetch`, `Services.rightmoveFetch`), so no real service is ever called:
- token caching
- quote → create → webhook mapping
- signature failures
- idempotent create and inbound orders
- POS push on accept
- menu snapshot
- feed validation and output snapshots for every portal
- removal on withdraw

---

## Stripe: what is live and what to configure

**Live in the code (API + hosted sites + mobile app):**

- **Direct charges on connected accounts.** Every customer payment is a PaymentIntent created on the location's
  connected account (or the organisation's shared account), with the platform's application fee. Cards, Apple Pay,
  Google Pay and the local methods the account has enabled show up automatically (`automatic_payment_methods`).
- **Card entry.** Hosted sites use one shared `<CardPayment>` component (Stripe.js Payment Element, loaded with
  `loadStripe(pk, { stripeAccount })`, `redirect: 'if_required'`, 3-D Secure in place, return URL = the order/booking
  status page). The mobile app uses `@stripe/stripe-react-native` PaymentSheet with `stripeAccountId`, Apple Pay /
  Google Pay and `returnURL: branchharbor://stripe-redirect`. The API returns only the publishable key and the
  connected account id (`GET /v1/public/payments/:id`, `GET /v1/public/payments/config?locationId=`), never a secret.
- **Nothing is marked paid by a browser or a phone.** Records are fulfilled only by the signed webhook (or, without
  keys, by the sandbox endpoint that runs the same event processor). Clients poll the API.
- **Saved cards.** One Stripe Customer per (customer, connected account). The card is kept with `setup_future_usage:
  'off_session'` only after explicit consent at checkout (required for studio memberships, meal plans and sports
  instalment plans; optional otherwise), stored in `payment_consents` with the exact text shown. Customers update the
  card with a SetupIntent from their account page (studio account, guardian portal, meal-plan page, app pass screen).
- **Subscriptions.** Studio memberships: first month paid at checkout, then a Stripe Subscription on the connected
  account with the saved card as default, `trial_end` = end of the paid period, and one recurring price per
  plan/currency created once (`stripe_recurring_prices` + lookup key). Meal plans: weekly subscription with the first
  invoice confirmed in the Payment Element / PaymentSheet. Dunning: `invoice.payment_failed` / `customer.subscription.updated`
  (`past_due`) → grace; `unpaid` → suspended; `invoice.paid` → active again; a card update retries open invoices.
- **Merchant-initiated charges** (`off_session_charges`, one idempotency key per fee/instalment attempt):
  late-cancel / no-show fees (studios, wellness) when the customer agreed to fee charging at booking and has a saved
  card, after a waive window (default 24 h, organisation setting, can be turned off: `PUT /v1/orgs/:orgId/payments/automation`);
  sports instalments on their due date. Failures leave the fee/instalment unpaid, email the customer and show in
  Payments → Automatic charges. When the bank asks for 3-D Secure, the customer is emailed a signed link
  (`/{brand}/{location}/pay/{paymentId}?token=`) to confirm the payment.

**What to configure in Stripe:**

1. **Connect settings** (Dashboard → Connect → Settings): enable the platform for the connected-account countries you
   launch in; accounts are created as Standard-like accounts with the Stripe Dashboard and `fees.payer = account`
   (`controller` settings in `integrations/payments.ts`). Branding (icon, colour) is used by Stripe-hosted onboarding.
2. **API keys:** `STRIPE_SECRET_KEY` (restricted keys work if they cover PaymentIntents, SetupIntents, Customers,
   Products, Prices, Subscriptions, Invoices, Refunds, Accounts, Account Links) and `STRIPE_PUBLISHABLE_KEY`
   (returned to browsers/apps; it is public by design).
3. **Two webhook endpoints:**
   - **Platform endpoint** → `https://api.<domain>/v1/webhooks/stripe`, secret `STRIPE_WEBHOOK_SECRET`. Events:
     `account.updated`, `charge.refunded`, `payment_intent.*` for platform-account charges.
   - **Connect endpoint** ("Listen to events on Connected accounts") → `https://api.<domain>/v1/webhooks/stripe/connect`,
     secret `STRIPE_CONNECT_WEBHOOK_SECRET`. Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `payment_intent.requires_action`, `charge.refunded`, `setup_intent.succeeded`,
     `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`,
     `account.updated`. Every Connect event carries `account`; the API rejects a Connect-signed event without it and
     a platform-signed event with it. Processing is idempotent (`webhook_events` unique event id, in the same
     transaction as the side effects).
4. **Apple Pay domain verification, per domain.** Apple Pay in the Payment Element only appears on registered domains.
   For direct charges the domain must be registered **on each connected account**: `POST /v1/payment_method_domains`
   with `domain_name` and the `Stripe-Account` header, for `sites.branchharbor.com` and for every customer custom
   domain once it is `ready` (and again if the domain changes). Google Pay needs no registration. In the app, set
   `STRIPE_MERCHANT_IDENTIFIER` (Apple merchant id, also `EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER`) and upload the
   Apple Pay certificate to Stripe.
5. **Billing settings** (per connected account, Dashboard → Billing → Subscriptions and emails): Smart Retries and the
   retry schedule drive dunning; BranchHarbor's grace period (plan `graceDays`) suspends access after it.

Without `STRIPE_SECRET_KEY` everything runs in **sandbox mode**: no network calls, fake ids, "Simulate payment" buttons
clearly labelled as test mode, and `POST /v1/public/payments/:id/sandbox-confirm` / `…/setup/:id/sandbox-complete`
feed synthetic events through the same processor.

## Finance: royalty collection, payouts and accounting exports

Code: `apps/api/src/services/finance/*`, `apps/api/src/integrations/finance-collection.ts`, routes `/v1/orgs/:orgId/finance/...`.

**Collection mechanism chosen: debit mandate on the franchisor's own connected account.**

- HQ connects a **collection account** (Finance → Royalties → Settings → "Connect account": a Stripe Connect account
  for the franchisor, stored in `finance_settings.collection_account_id`; in `shared` payment mode the organisation
  account is used).
- Each franchisee (owner group) becomes a **Customer on that account**. The franchise owner accepts a written
  authorisation in BranchHarbor (text, user, time and IP are stored in `finance_payment_methods`), then a
  **SetupIntent** (`usage: off_session`) saves a card or the local bank debit for the invoice currency: ACH
  (`us_bank_account`, USD), Canadian PAD (`acss_debit`, `transaction_type: business`, sporadic), Bacs (GBP),
  SEPA Direct Debit (EUR) or BECS (AUD). Stripe collects the scheme mandate in the Payment Element (confirm the
  SetupIntent client-side with `stripeAccount` = the collection account), then `setup_intent.succeeded` on the Connect
  webhook (or `POST …/payment-methods/:id/refresh`) activates it.
- Invoices are collected with an **off-session PaymentIntent created on the collection account** (direct charge; the only
  application fee is BranchHarbor's flat collection fee, see below), one idempotency key per attempt (`fin_inv:<invoice>:<attempt>`). Each attempt is a
  `payment_references` row with target `royalty_invoice`, so the existing signed-webhook processor settles it
  idempotently (`payment_intent.succeeded` / `payment_intent.payment_failed`); bank debits stay `processing` for days
  until Stripe reports the outcome.
- Why not Connect **transfers / account debits** from the franchisee's connected account or **application fees** on
  their sales: those move money to the *platform* (BranchHarbor), not to the franchisor, only work between accounts in
  the same region, would require BranchHarbor to hold and forward franchisor funds (a money-transmission question),
  and application fees are per sale, not per approved invoice. The mandate model keeps money flowing franchisee →
  franchisor, after approval, with the franchisee's explicit authorisation.
- **Limits:** mandate-based bank debits need the collection account to have the matching capability enabled
  (`us_bank_account_ach_payments`, `acss_debit_payments`, `bacs_debit_payments`, `sepa_debit_payments`,
  `au_becs_debit_payments`); Bacs mandates take a few days to activate; ACH may require micro-deposit verification;
  card fees are higher than bank debits; a cross-border franchisee may need a card. The dashboard has no Payment
  Element for live SetupIntent confirmation yet (sandbox confirms in place); see gaps in the finance hand-off.
- Without `STRIPE_SECRET_KEY` (sandbox): methods carry their outcome (`…_decline` fails), cards settle immediately,
  bank debits stay `processing` until `POST …/finance/invoices/:id/sandbox-settle`. Nothing leaves the server.

**Bank debit by scheme and HQ's account country:** the franchisee chooses card or the local bank debit when
authorising (Finance → Statements & invoices → Debit authorisation). The bank debit offered depends on the franchisee's
currency AND the collection account's country (read from Stripe, `accounts.retrieve`): ACH `us_bank_account` (USD, US
accounts; Financial Connections with micro-deposit fallback), Canadian PAD `acss_debit` (CAD, Canadian accounts;
business, sporadic), Bacs `bacs_debit` (GBP, UK accounts), SEPA `sepa_debit` (EUR, EEA/CH/UK accounts) and BECS
`au_becs_debit` (AUD, Australian accounts). In sandbox the country is unknown, so methods follow the currency.
- **Mandate text:** `GET …/finance/payment-methods/mandate?ownerGroupId&currency&methodType` returns the exact scheme
  wording (ACH authorisation, business PAD agreement, Bacs Direct Debit Guarantee summary, SEPA mandate with the 8-week
  refund right, BECS Direct Debit Request). The app shows it before the franchisee accepts; `POST …/payment-methods/setup`
  receives the text that was shown and refuses (`409 mandate_text_changed`) when it no longer matches, so the stored
  text (`finance_payment_methods.mandate_text`, with user, time, IP and language) is exactly what was accepted.
- **Delayed outcomes:** bank debits stay `processing` until Stripe reports `payment_intent.succeeded` /
  `payment_intent.payment_failed` days later (attempt `settled_at` is set). A failure reopens the invoice; the next
  dunning run emails the franchise owners once per failed attempt (`failure_notified_at`) with the next automatic retry
  date, and retries follow the dunning policy. `setup_intent.requires_action` with `verify_with_microdeposits` moves the
  method to `verifying` (with Stripe's hosted verification link); `mandate.updated` with `status: inactive` revokes it.
  Add `setup_intent.requires_action` and `mandate.updated` to the Connect webhook endpoint's events.
- **Collection fee:** a flat BranchHarbor fee per collection attempt that is not failed — USD 1.00, at most USD 10 per
  location per calendar month, in the price-book currency (the `collection` and `collectionCap` rows in
  `packages/shared/src/pricing.ts`, exposed by `fees.ts`; currencies outside the price book: no fee). It is NOT a percentage of
  royalties. It is taken as `application_fee_amount` on the direct charge on the franchisor's collection account (HQ
  pays it), recorded on the attempt (`platform_fee_minor`) and shown on statements for transparency; a debit that later
  fails has its fee reset to 0.
- **Monthly statements per franchisee:** `POST …/finance/periods/:id/franchisee-statements` (HQ, Royalties publish)
  builds one statement per owner group and currency from the period's location statements and invoices: gross sales and
  their source (BranchHarbor payments / external POS), royalty and fund rates and amounts, adjustments, fees, tax,
  amount, collection method, status and date, collected amount and the collection fee. New statements are emailed to
  the franchise owners; re-issuing refreshes the figures without emailing again. `GET …/franchisee-statements[/:id[/pdf]]`
  (franchise owners see only their own).

**Dunning:** `POST …/finance/dunning/run` (and the `finance.dunning` job, `{ organizationId }`, to schedule daily):
reminder N days before the due date, late fee once after the agreement's grace days (flat or % of the overdue amount,
taxed only if HQ configured a tax line for late fees), automatic retries on the configured days after the due date,
final notice. Each step is recorded once per invoice and day (`finance_dunning_events`), so the run is idempotent.
Emails go to the franchise owners of the owner group.

**Tax on invoices:** none unless HQ adds tax lines (name, rate, country, which lines they apply to). BranchHarbor never
decides tax.

**Payouts:** live mode reads each location's connected account (`payouts.list`, then `balanceTransactions.list` with
`payout` and `expand: ['data.source']`), links charges/refunds/disputes to BranchHarbor payments by PaymentIntent and
stores them in `finance_payouts` / `finance_balance_transactions`. Restricted keys need Payouts and Balance read access.
Sandbox mode generates payouts from succeeded payments (2 days after the sale, estimated 2.9% + 30 fee plus the
application fee), labelled sandbox. Shared-account organisations (one account for all locations) are not split into
per-location payouts yet.

**Accounting exports (files only, no API push):** `GET …/finance/exports/{statements|invoices|payouts|fund}?format=`
- `csv`: BranchHarbor columns, every row with its currency.
- `xero`: invoices in Xero's "Import invoices" CSV layout (`*ContactName`, `*InvoiceNumber`, … `Currency`; account
  codes `ROYALTY`, `MKTFUND`, `TECHFEE`, `LATEFEE` and tax type `Tax on Sales`/`Tax Exempt` to map on import);
  payouts in Xero's bank statement CSV layout.
- `quickbooks`: invoices in the QuickBooks Online invoice import layout; payouts in the 3-column bank CSV (Date,
  Description, Amount), which has no currency column, so a `currency` filter is required.
A live Xero / QuickBooks Online API sync (OAuth apps, contact and item mapping) is not built.

**Franchise agreements:** the royalty engine reads rates through `registerAgreementTermsProvider` (services/finance/terms.ts):
an agreement's royalty / marketing-fund basis points override owner-group terms, which override the organisation
default; anything the agreement doesn't set (tiers, minimum, technology fee, revenue basis, late fee) falls back.

## Reviews: requests and Google Business Profile

Code: `apps/api/src/services/reviews.ts`, `apps/api/src/integrations/google-business.ts`, routes `/v1/orgs/:orgId/reviews/...`
(module `marketing.reviews`), hosted page `apps/sites/app/[brand]/[location]/review`.

**Review requests (no third party beyond the existing comms adapters):** after a completed class visit (studios,
sports), completed appointment (wellness), collected/delivered/served or fulfilled order (foods, commerce), hotel
checkout (hospitality) or completed property viewing (realty), one request per interaction is scheduled after the
location's delay and sent by email (Postmark/Resend), SMS (Twilio) or WhatsApp (Cloud API). Settings per location
(overriding HQ defaults): channel, delay, copy per site locale (default copy in all 9 locales), frequency cap per
customer, quiet hours for texts, consent mode (marketing consent, or a service follow-up where local law allows it) and
public review links. Opt-outs are always respected: STOP replies and unsubscribes on the channel, plus "Stop review
requests" on the hosted page. Without provider credentials messages are recorded as `sandboxed` (never claimed as
delivered). WhatsApp outside the 24-hour window needs an approved template on Meta's side before going live.

**No review gating:** the hosted page offers the location's public review links (and the linked Google listing's
"write a review" link) to every customer, before and after rating, whatever the rating. Private feedback (rating and
comment) goes to the location's inbox as a conversation. Negative reviews (≤ 2★, private or Google) alert the
location's managers and HQ marketing (push + email).

**Google Business Profile (P1):** env `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (same OAuth client as
other Google sign-ins is fine). Steps:
1. Google Cloud project → enable the **My Business Account Management API**, **My Business Business Information API**
   and the **Google My Business API** (v4, reviews and replies). These are not available by default: request access
   with the [Business Profile API access form](https://developers.google.com/my-business/content/prereqs) (approval
   typically takes days to weeks; the project must belong to a verified business, and quota starts at 0 until approved).
2. OAuth consent screen: external, scope `https://www.googleapis.com/auth/business.manage` (plus `openid email` to
   show who connected). The scope is sensitive, so Google verification of the app is required before public use.
3. OAuth client (web): authorised redirect URI `https://api.<domain>/v1/oauth/reviews/google/callback`
   (`PUBLIC_API_URL` + that path).
4. In BranchHarbor: Marketing → Reviews → Google → Connect with Google (HQ for many locations, or one location), then
   link each Google location to a BranchHarbor location. Reviews are fetched every 30 minutes (and on "Fetch now");
   replies are posted with `PUT …/reviews/{id}/reply`. The refresh token is stored encrypted (`ENCRYPTION_KEY`).

Without the OAuth client, connections can only be added in **sandbox**: nothing is fetched (no reviews are ever
invented; demo reviews exist only in `seed-demo.ts`) and replies stay in BranchHarbor, labelled as not posted.
Replies can be drafted with BranchHarbor AI (`ANTHROPIC_API_KEY`; drafts only) and, by HQ policy, need HQ approval
(none / negative reviews / all). `getLocationRatingSummary(db, orgId, locationIds, period)` exposes per-location
ratings for the network league table.

## Local marketing: listings, call tracking, co-op fund and local social

Code: `apps/api/src/services/{listings,review-inbox,coop,call-tracking,local-social,local-marketing}.ts`,
`apps/api/src/integrations/{listings,call-tracking}.ts`, routes `/v1/orgs/:orgId/{listings,coop,call-tracking,local-marketing}/…`,
`/v1/orgs/:orgId/social/calendar/…`, `/v1/orgs/:orgId/reviews/templates`; shared rules in
`packages/shared/src/local-marketing.ts`. Modules `marketing.listings`, `marketing.coop`, `marketing.call_tracking`
(plus `marketing.reviews`, `marketing.inbox` and `marketing.social` for reviews in the inbox and the content calendar).

### Listings (Google Business Profile, Apple Business Connect, Bing Places)

One source of truth per location. Name, address, phone, weekly hours and special / holiday hours are stored **on the
location itself** (`locations.hours.weekly` / `.special`), so the hosted location sites (opening hours, "open now",
schema.org) always match the directories; categories, description, photos, website and booking links and attributes
live in `listing_profiles`. HQ decides per field who may change it (HQ only / location / location with HQ approval);
changes are pushed to every linked directory when saved (`autoPush`). Drift: the directory's copy is compared with what
BranchHarbor last pushed (every `LISTINGS_DRIFT_CHECK_MINUTES` for live directories, or on "Check for changes"); a
difference opens a drift that alerts HQ and the location, and HQ accepts it (the value becomes BranchHarbor's and goes to
the other directories) or overwrites it. Bulk holiday hours set special hours at many locations at once, keeping a
location's own hours for those dates unless "overwrite" is chosen. Each location gets a health score (0–100).

**Google Business Profile:** no new credentials and no new scope. Listings reuse the Reviews OAuth connection
(`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, scope `business.manage`, which covers
`locations.patch` / `locations.get` in the **My Business Business Information API**) and the Google location linked to
each BranchHarbor location in Reviews. Pushed fields: title, storefront address, primary phone, regular and special
hours, categories (only when stored as Google category ids, `gcid:…`), description and website. Photos (Media API) and
booking links (Place Actions API) are not pushed yet. Note: Google may hold edits for review and may reject edits to
verified listings that look like spam; a rejected edit shows as drift on the next check.

**Apple Business Connect** (sandbox until approved): env `APPLE_BUSINESS_CONNECT_CLIENT_ID`,
`APPLE_BUSINESS_CONNECT_CLIENT_SECRET`, optional `APPLE_BUSINESS_CONNECT_API_URL`. Steps:
1. Enrol the BranchHarbor company in Apple Business Connect and apply for **API access as a partner** (Apple reviews the
   application; approval is not automatic).
2. After approval, create API credentials (client id and secret) in Business Connect and set the env vars; confirm the
   base URL Apple gives partners (the adapter's endpoints follow the `/v1/companies/{companyId}/locations/{id}` shape and
   must be checked against Apple's current API reference before going live).
3. Each brand authorises BranchHarbor on its Apple company; in Marketing → Listings → Directories connect Apple with the
   company id and link each location to its Apple location id.

**Bing Places for Business** (sandbox until approved): env `BING_PLACES_API_KEY`, optional `BING_PLACES_API_URL`.
Steps: apply to Microsoft's Bing Places partner programme for API access (bulk / multi-location partners), receive the
subscription key and base URL, verify the adapter's endpoints against Microsoft's reference, then connect Bing and link
locations to their Bing store ids. Without approval, brands can still upload Bing's bulk file by hand.

Without credentials, directory connections are **sandbox**: nothing leaves BranchHarbor, the "directory copy" is
simulated (`listing_syncs.remote_snapshot`) and "Simulate an edit" exercises drift detection end to end.

### Google reviews in the unified inbox

Every Google review becomes an inbox conversation of type `review` in the location's inbox (one per review), with a
reply SLA from Settings (negative reviews sooner, default 12 h; others 48 h). Replies written in the inbox are published
through the reviews service: the same HQ approval policy, the same Google reply call, the same audit. Reply templates
(`{first_name}`, `{location}`, `{business}`) per rating band, HQ-wide or per location. No extra credentials.

### Call tracking (Twilio Programmable Voice)

Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (shared with SMS), `CALL_TRACKING_LIVE` (default true; set false to keep
call tracking in sandbox while SMS is live). Steps:
1. Twilio console: upgrade the account (trial accounts can only call verified numbers) and complete **Regulatory
   Compliance** bundles for each country you buy numbers in (UK, EU and Australian numbers need an address and identity
   bundle; approval can take days).
2. Nothing to configure per number: BranchHarbor buys local numbers through the API with the voice webhook
   `https://api.<domain>/v1/webhooks/call-tracking/twilio/voice` (`PUBLIC_API_URL` + path); the outcome arrives on
   `/v1/webhooks/call-tracking/twilio/status`. Both are verified with `X-Twilio-Signature` (auth token).
3. Calls forward to the location's phone with the tracking number as caller id. Missed and busy calls alert the
   location and, for unknown callers, create a lead routed by the lead rules.

**Call recording is off by default.** Laws differ: some US states require every party's consent (California,
Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana, Nevada, New Hampshire, Oregon,
Pennsylvania, Washington); Canada, the UK, the EU and Australia require at least a clear notice and a lawful basis
(GDPR: tell callers why and how long recordings are kept). HQ switches recording on per jurisdiction (`GB`, `US-CA`, …)
with a disclosure that is played before the call connects; a number can only record where its location's jurisdiction
has a rule. Check with counsel before enabling it; recordings are stored by Twilio (`RecordingUrl`), not BranchHarbor.

**Dynamic number insertion:** hosted location sites swap the phone number by the visitor's first UTM source / referrer
(`components/TrackingNumber.tsx`, elements marked `data-bh-phone`). Other sites (e.g. WordPress) add
`<script async src="https://api.<domain>/v1/public/call-tracking/dni.js" data-brand="…" data-location="…">`.
Calls appear in ad campaign reports (`calls`, `answeredCalls` per campaign and location).

Without Twilio credentials numbers are fictional (reserved ranges: NANP 555-01xx, Ofcom 07700 900xxx, ACMA
0491 570xxx), never ring, and "Simulate a call" posts signed webhooks through the same handlers.

### Co-op / local marketing fund

No third party. HQ sets allowances per location (a share of its marketing fund contributions in the period, or a fixed
amount per month / quarter / year) with a matching ratio; owners submit pre-approval requests (budget, dates, creative
from brand assets, local templates or links); HQ approves against the brand checklist; after the spend the owner claims
with the invoice and proof of performance; HQ approves (reimbursable = min(spent, approved) × match, capped at the
allowance left) and records the reimbursement, which is booked as spend in the Finance marketing fund ledger with the
invoice as receipt. **Payout:** recorded as a bank transfer (with reference) or marked paid. Stripe Connect transfers
are deliberately not used: fund money sits on the franchisor's own collection account (see Finance: royalty
collection), and routing it through the platform balance would make BranchHarbor a money transmitter. A credit on the
next royalty invoice is a possible later option.

### Local social (content calendar)

No new credentials: posts are ordinary local social posts published by the existing dispatcher through the social
adapters (Meta live with `META_APP_ID` / `META_APP_SECRET`; LinkedIn and Google Business posts sandbox). HQ publishes
calendar items with `{location}`, `{city}`, `{phone}`, `{booking_link}`, `{website}`, `{brand}`; a location localises
and schedules in one click on its own connected accounts (or HQ accounts it was granted). Unedited posts need no
further approval (HQ wrote them); edited posts follow the location's marketing tier.

## What to set up first (shortest path to a Studios pilot)

1. Stripe account (platform) → enable Connect + Billing + Tax
2. Postmark (or Resend) with a verified sending domain
3. Anthropic API key
4. Cloudflare account → zone for `branchharbor.com` → Cloudflare for SaaS enabled
5. Cloudflare R2 bucket
6. Managed Postgres (Neon) + Upstash Redis
7. Google Maps Platform key (Places + Geocoding + Time Zone)
8. Sentry + PostHog (EU)
9. Twilio (start registering senders early, because US A2P 10DLC approval takes weeks)
10. Apple Developer + Google Play + Expo EAS
11. Mindbody partner application (if the Studios pilot uses Mindbody, apply now because approval is slow)
12. Meta developer app + WhatsApp Business Cloud API (business verification takes time)

## Decisions still open (from spec §20)

These affect which providers above you finalise:
- The legal entity's country determines Stripe platform eligibility and which connected-account countries are supported.
- Payment liability model: Standard vs Express connected accounts; who pays disputes.
- Which Studios booking provider the first pilot uses.
- AI provider data terms (zero data retention).
- Data residency: launch with US + EU from day one, or EU later.
