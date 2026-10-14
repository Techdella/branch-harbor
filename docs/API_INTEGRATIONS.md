# Third-party APIs to connect

This is everything BranchHarbor needs to connect before it's production-ready for an international launch (US, Canada, UK, EU, Australia/NZ, Singapore, UAE, Brazil, Mexico). Every integration in the codebase is optional at boot. When a key is missing, the adapter runs in a logged **sandbox/disabled** mode, so local development works with no accounts at all.

**Priority:** P0 = needed before the first pilot goes live. P1 = needed during the pilot or for the second vertical. P2 = later, or nice to have.

Env var names match `apps/api/.env.example`, `apps/app/.env.example` and `apps/mobile/.env.example`.

---

## 1. Core platform (P0)

| # | Service | What it's for | Recommended provider | Alternatives | Env vars |
|---|---|---|---|---|---|
| 1 | **Payments: customer payments** | Bookings, orders, registrations, deposits; one connected account per location or owner group; refunds; payouts. Webhooks confirm outcomes. | **Stripe Connect** (direct charges, Express/Standard accounts). Covers 45+ countries including every launch market. | Adyen for Platforms (enterprise, strong in EU), Mollie Connect (EU), Square (US/CA/UK/AU/IE/FR/ES/JP; also a POS integration) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` |
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
| 19 | **Google Business Profile** | Sync hours, posts and reviews per location | **Google Business Profile APIs** (requires Google approval) | — | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
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

---

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
