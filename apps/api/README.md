# @bh/api — BranchHarbor backend

Fastify 5 + Zod 4 (fastify-type-provider-zod) + Drizzle ORM on Postgres 16. Multi-tenant API for
multi-location businesses and franchise networks (HQ → regions → owner groups → locations) across
Studios, Sports, Wellness, Commerce and Foods, built for an international market (multi-currency,
IANA timezones, locales, data-residency region per organisation, GDPR-style consent/export/delete).

OpenAPI: **`/docs`** (UI) and **`/docs/json`**. Health + integration status: **`/health`**.

## Run it

```bash
# from the repo root
pnpm install
docker compose up -d postgres redis mailpit     # or a local Postgres 16 with role bh/bh and db branchharbor
cp apps/api/.env.example apps/api/.env          # optional — every value has a dev default
pnpm --filter @bh/api db:migrate                # applies apps/api/drizzle/*.sql
pnpm --filter @bh/api db:seed                   # production-safe: no businesses (optional platform admin)
pnpm --filter @bh/api db:seed:demo              # demo data — demo site / local development only
pnpm --filter @bh/api dev                       # http://localhost:4000, docs at /docs
```

**Production has no sample data.** `db:seed` creates nothing but, when `PLATFORM_ADMIN_EMAIL` and
`PLATFORM_ADMIN_PASSWORD` are set, one BranchHarbor platform admin (the only account allowed on `/v1/platform/*`).
Businesses are created by signing up. All demo data lives in `db:seed:demo` (`src/db/seed-demo.ts`, which orchestrates
the `seed-*.ts` files) and must only run against a demo or development database.

**Demo site** (e.g. `demo.branchharbor.com`): the same code against its own database seeded with `db:seed:demo`, with
`DEMO_MODE=true` on the API (and `NEXT_PUBLIC_DEMO_MODE=true` / `EXPO_PUBLIC_DEMO_MODE=true` on the clients). Demo mode
adds a "Demo environment" ribbon and a sign-in picker listing every demo account by business and role
(`GET /v1/demo/accounts`, one-click `POST /v1/demo/login` for demo accounts only); both return 404 when `DEMO_MODE` is off.

Demo logins after `db:seed:demo` (password printed by the seed, or `SEED_DEMO_PASSWORD`): `demo@branchharbor.com` holds
`org_owner` in the demo organisations — Stillwater Yoga (studios), Maple & Ember (foods), North Shore Football Academy
(sports: Toronto CAD, Manchester GBP, Austin USD), Harbourline Wellness (wellness, administrative records only: Toronto
CAD, Dublin EUR, Melbourne AUD), Fieldnote Goods (commerce: Portland USD, Montréal CAD, Amsterdam EUR) and Keystone Realty
— so it shows the account switcher (one industry per business account). Also seeded: `maya.rao@demo.branchharbor.com`
(location manager, Queen West), `priya.anand@demo.branchharbor.com` (regional manager, Europe),
`carlos.ortega@demo.branchharbor.com` (staff, Ballard) and the staff/manager accounts the seed prints.

**Northlight Yoga International** (studios franchisor, `*@northlight.demo.branchharbor.com`) shows the access model, one
login per role: Elena Marsh (CEO, owner), Daniel Okafor (VP Franchise), Sofia Lindqvist and Marcus Bell
(instructor-trainers), Hannah Cho (CMO), Théo Laurent (brand lead), Priyanka Shah (digital marketer), Grace Kim
(operations manager, plus a per-person grant of brand templates), Liam O'Connor / Ava Thompson / Oliver Grant (franchise
owners of three owner groups), Mia Rossi and Noah Williams (location managers), Chloe Martin and Ethan Brown (staff) and
Zara Ahmed (custom role "Front desk lead").

| Script | What it does |
|---|---|
| `dev` | `tsx watch` with `.env` if present |
| `start` | run the server with `tsx` (production entrypoint, see below) |
| `typecheck` / `build` | `tsc -p tsconfig.json` (no emit) |
| `test` | vitest (unit + integration) |
| `db:generate` | `drizzle-kit generate` after schema changes |
| `db:migrate` / `db:seed` / `db:seed:demo` / `db:reset` | migrate; production-safe seed (no businesses, optional platform admin); demo data (demo site only); drop+recreate (non-production only) |

### Build decision

`@bh/shared` is consumed as TypeScript source with `.ts` extension imports. Emitting a `dist` that
re-resolves workspace TS sources is brittle, so **`build` = typecheck** and production runs the
server with `tsx` (`pnpm --filter @bh/api start`). tsconfig uses `allowImportingTsExtensions` +
`noEmit`. If a compiled artefact is later required, bundle with esbuild/tsup (which inline
`@bh/shared`) rather than `tsc` emit.

## Tests

```bash
pnpm --filter @bh/api test
```

`test/setup/global.ts` drops and recreates a **separate** database (`TEST_DATABASE_URL`, default
`postgres://bh:bh@localhost:5432/branchharbor_test`; the name must contain `test`) and migrates it.
If Postgres is unreachable, DB-backed suites are skipped with a clear message and pure unit tests
still run. Coverage includes: the access model (`test/access.int.test.ts`: catalogue, location manager refused owner/HQ data,
marketing-only user refused operations/finance, custom roles grant exactly what was ticked, no granting beyond your own
access, HQ-private modules, franchisee A vs B isolation, immediate revocation, industry lock + audited platform change,
multi-account `/auth/me`, demo endpoints only in demo mode), permission/scope resolution, money per currency in reports, domain
state machine, Stripe webhook idempotency (duplicate + concurrent deliveries processed once),
signature rejection, partial refunds, reconciliation + "recreate record", food-order state machine
with refund on rejection, studio capacity/holds/waitlist/concurrency, wellness reschedule
preserving the original on failure, auth (refresh rotation + reuse detection), invitations and
immediate revocation, CSV import row errors, group publishing partial failure + retry, AI scoping
and proposed-action approval, privacy export/deletion, connector mapping errors, staff shifts/swaps/time clock,
the approvals inbox (execute-on-approve, rollback to pending on failed execution, no self-approval, per-kind
permissions, refund thresholds), leaving a waitlist (guest token and `/me`), sports schedule/attendance with venue
conflicts and coach scoping, sports full product (age boundaries, capacity/approval across payment retries, instalments + reminders,
guardian authorisation/invitations/disputes, transfers, coach-scoped care data, notification scoping, AI context exclusion), offer eligibility rules, intake form validation/consent versions/AI exclusion, pickup
settings → slot generation (pure planner incl. DST), inventory history with reservations, push sandbox/preferences/
Expo adapter, org policies and per-location billing.

## Environment

Every variable is documented in [`.env.example`](./.env.example) and validated by `src/config.ts`
(zod). All integrations are optional; missing keys put the adapter into a logged
**disabled/sandbox** mode and `/health` reports each one:

| Integration | Without keys |
|---|---|
| Postmark / Resend email | logged to console, not sent (dev tokens returned in responses when `EXPOSE_DEV_TOKENS`) |
| Twilio SMS, WhatsApp Cloud | logged only |
| Stripe Connect | sandbox: fake `pi_sandbox_*` intents, accounts enabled immediately; `POST /v1/public/payments/:id/sandbox-confirm` simulates the provider through the same webhook processor |
| Stripe webhooks | rejected (503) unless `STRIPE_WEBHOOK_SECRET` (platform, `/v1/webhooks/stripe`) / `STRIPE_CONNECT_WEBHOOK_SECRET` (connected accounts, `/v1/webhooks/stripe/connect`) is set — never processed unsigned |
| Saved cards / off-session | sandbox: fake `cus_/pm_/seti_/sub_sandbox_*`; `POST /v1/public/payments/setup/:id/sandbox-complete` saves a test card (`card: ok/decline/sca` drives later automatic charges) |
| Anthropic (BranchHarbor AI) | AI routes return `503 ai_unavailable`; nothing else is affected |
| Expo Push (`EXPO_ACCESS_TOKEN` or `ENABLE_EXPO_PUSH=true`) | sandbox: notifications are logged and recorded in `push_notifications` with status `sandbox`, never sent |
| Cloudflare for SaaS | sandbox provider; `DOMAINS_SANDBOX_AUTO_VERIFY=true` skips real DNS lookups |
| Google Maps, Open Exchange Rates, S3/R2, Sentry, PostHog | disabled |
| Mindbody, Square, Shopify, WooCommerce, WordPress | sandbox sample data for sync/mapping UX |
| Redis | jobs run inline in-process (no retries/persistence) |

## Architecture

```
src/
  config.ts              env schema (zod) + integration status
  app.ts                 buildApp(): plugins, error handler, OpenAPI, /health, /v1 routes
  server.ts              listen + hold-expiry sweep + graceful shutdown
  context.ts             Services container (db, mailer, jobs, payments, domains, dns, connectors, ai…) — tests override members
  db/schema/*.ts         Drizzle schema (core, crm, websites, integrations, verticals)
  db/{client,migrate,seed,reset}.ts
  domain/*.ts            pure logic: scope coverage, domain + food-order state machines, report metrics
  services/*.ts          business logic: auth, authz, audit, payments, studios, wellness, foods, publish, domains, connections, ai
  integrations/*.ts      adapters: Stripe, Cloudflare, email, SMS/WhatsApp, BullMQ, connectors, Anthropic, FX, maps, storage
  routes/*.ts            Zod-typed route modules registered under /v1
  jobs/handlers.ts       background job handlers
drizzle/                 generated SQL migrations (+ 0001 custom constraints; 0003 shifts, approvals columns, offers, intake, pickup settings, push log; 0004 wellness full product; 0005 custom wellness resource-hold exclusion constraint + triggers; 0013 access model: custom roles, role capabilities, member access overrides, platform role)
```

**Conventions**

- Errors: `{ error: { code, message, fields?, details? } }` (`apiError` in `@bh/shared`); validation → 400 `validation_failed` with dotted field paths.
- Money: integer minor units (`bigint`) + `char(3)` currency. Amounts in different currencies are never summed — reports return per-currency rows and `combinedRevenue: null`.
- Time: `timestamptz` UTC everywhere; locations carry an IANA `timeZone`; recurrence/slots are generated in local wall time (`src/lib/tz.ts`, DST-safe).
- Tenancy: every tenant table has `organization_id`; location-scoped rows have `location_id`. Org routes are `/v1/orgs/:orgId/...`; a non-member gets 404.
- Unavailable data is `null` with an `unavailableReason`, never a fabricated 0. Metrics carry definition, source and freshness.
- Audit: consequential actions write `audit_events` (actor, action, scope, target, metadata) in the same transaction.

**Auth.** Email + password (argon2id), email verification tokens (hashed), short-lived HS256 JWT
access tokens (`Authorization: Bearer`), rotating refresh tokens in an httpOnly cookie
(`bh_refresh`, path `/v1/auth`) — mobile clients send `X-BH-Client: mobile` to also receive the
refresh token in the body. Reusing a rotated refresh token revokes the whole token family.

**Authorisation — the access model** (`packages/shared/src/access.ts`, docs/PRODUCT_PLAN.md "Access model").
Access is built from **workspaces → modules → actions**: workspaces Network, Operations, Sales, Marketing, Finance,
Legal & compliance, Training and Community (plus Settings under every workspace); modules such as
`marketing.website_builder` or `finance.payments` (Operations modules come from the organisation's industry); actions
`view`, `edit`, `publish` (publish / approve) and `export`. A capability is `<module>:<action>`.

- *Roles* are capability sets: system role templates (Owner, HQ admin, VP Franchise, CMO, Brand lead, Digital marketer,
  Instructor-trainer, Operations manager, Finance, Legal, Regional manager, Franchise owner, Location manager, Staff,
  Customer) or **custom roles** an organisation creates (`custom_roles` + `role_capabilities`).
- *Assignments* (`role_assignments`: role or `custom` + `custom_role_id`, scope kind/id) can carry **per-person
  overrides** (`member_access_overrides`: grant or revoke a capability; revoking `view` removes the module).
- *Scope*: organisation → region → owner group → location, as before. HQ-private modules (franchise pipeline, legal,
  royalties, payouts, billing) only take effect on organisation-wide assignments, so a franchise owner never gets them.
- *Enforcement*: assignments, custom roles and overrides are loaded from the DB on every request (never in tokens), so
  changes apply immediately. (1) A module guard (`services/module-guard.ts`) refuses organisation routes whose modules
  the member holds nowhere — 403 `module_not_available` (no empty padlocked lists). (2) Every route still checks its
  permission in the target scope: the legacy `PERMISSIONS` (`requirePerm`, `authorisedLocations`) are derived from
  capabilities (`PERMISSION_CAPABILITIES`), and new code can call `requireCapability(req, db, module, action, target)` /
  `capabilityLocations(...)`. List endpoints filter by scope. (3) Sensitive fields are filtered by capability: revenue in
  reports needs `finance.payments:view` at each location (otherwise `null` with `no_finance_access`), customer records
  need `sales.customers`.
- *Granting*: nobody can grant (or change) access they don't hold in that scope; only owners grant ownership; every
  change is audited (`access.role_created|updated|deleted`, `access.assignment_created|updated`, `member.*`).
- *Industry*: fixed at creation — `PATCH /orgs/:id` with a different `industry` returns 409 `industry_locked`; only a
  platform admin can change it (`PUT /v1/platform/orgs/:orgId/industry`, audited `platform.org_industry_changed`).

**Key flows**

- *Studios booking*: occurrence row lock (`SELECT … FOR UPDATE`) + partial unique index prevent overselling and duplicate bookings; paid classes create a timed hold and a PaymentIntent; full classes offer the waitlist; cancellation promotes the next waiting customer; payment after hold expiry confirms only if a seat is free, otherwise it lands in the reconciliation queue.
- *Wellness (full product)*: services with variants (30/60/90 min) priced per location in that location's currency, buffers before/after, deposit rules (none/fixed/percent), structured cancellation/no-show policy, eligible practitioners, required room + equipment types, online-bookable flag, couples (2 practitioners, 1 room). Availability = weekly templates per location (home template on the practitioner, other locations in `wellness_practitioner_locations`; templates may not overlap — compared as real instants across time zones) minus leave/absence exceptions, existing reservations at ANY location, rooms and equipment. All resource holds live in `wellness_resource_reservations` with an exclusion constraint; room holds are created by a trigger from `appointments.resource_id` and `active` follows the appointment status (trigger), so every cancel/reschedule path releases rooms and equipment. A booking secures practitioner(s) + room + equipment in one savepoint per candidate combination (both secured or neither); "any available" picks the least-loaded practitioner that day. Recurring series (weekly, local wall-clock, dry run / all-or-nothing / skip conflicts), waitlist for a time window (freed time is offered FIFO by email; claim books it), packages (sessions, expiry, sharing; free cancellation returns the session, late cancellation forfeits it), gift vouchers (code, balance in one currency, CHECK balance ≥ 0), policy cancellation (fee from the deposit, then voucher value; the rest refunded via Stripe sandbox; outstanding fee recorded), no-show fees, consent-aware reminders (email unless withdrawn, SMS opt-in) and rebooking prompts (marketing consent) with idempotent message log, scoped notes (confidential = author + `customers.write` managers; staff see clients they work with), calendar with conflict-aware drag moves (dry run explains conflicts), utilisation and reports per currency + package/voucher liability, AI drafts (service copy, approved-policy replies, appointment summaries) built only from configuration/aggregates — never client data, notes or intake answers — with health-claim screening; drafts are proposals until applied.
- *Wellness*: Postgres exclusion constraints (`btree_gist`, `tstzrange`) make overlapping confirmed reservations for the same practitioner or resource impossible (buffers included). Reschedule marks the original `rescheduled` and inserts the replacement in one transaction — if the new slot cannot be secured the transaction rolls back and the original is untouched.
- *Foods*: effective menu = HQ items + location overrides (only HQ-permitted fields) in the location's currency; order creation re-checks slot capacity/cut-off, availability, sold-out, modifiers and totals server-side (`expectedTotalMinor` mismatch → 409 `price_changed`). Transitions `awaiting_acceptance→accepted→preparing→ready→collected`; `rejected`/`cancelled` release the slot and refund/void the payment. Unpaid orders are hidden from the kitchen and cannot be accepted.
- *Payments*: Stripe Connect direct charges on the connected account (per-location or shared org account) with an application fee. `POST /v1/webhooks/stripe` verifies the signature on the raw body; the `webhook_events (provider, event_id)` unique row is inserted in the same transaction as the side effects, so duplicates are no-ops and failures are retried by Stripe. Refunds are partial-capable, bounded by the remaining amount, require `payments.refund` and an explicit `confirmCurrency`. The reconciliation queue reports *paid without record*, *unpaid but confirmed record* and *amount mismatch*; `recreate-record` re-runs fulfilment or rebuilds from the stored snapshot.
- *Card entry, saved cards and automatic charges* (`services/payments-saved.ts`, `routes/payments-customer.ts`): `GET /v1/public/payments/:id` (state + publishable key + connected account + save-card options; never the client secret), `GET /v1/public/payments/config?locationId=`, `POST /v1/public/payments/:id/save-card` (consent → Stripe Customer per customer/account + `setup_future_usage`), `GET|POST /v1/public/payments/fee-policy|fee-consent`, `GET /v1/public/payments/:id/action?token=` (signed SCA link), card update via SetupIntent (`/public/studios/account/payment-method*`, `/public/sports/portal/payment-method*`, `/public/foods/meal-plans/subscriptions/:id/payment-method*`, `/me/payment-methods*`). Studio memberships get a Stripe Subscription with the saved card (one recurring price per plan/currency, idempotent); `/webhooks/stripe/connect` handles `invoice.*`, `customer.subscription.updated|deleted`, `setup_intent.succeeded` (dunning → grace/suspended/active). Late-cancel/no-show fees (with consent at booking, after the waive window, org switch `PUT /orgs/:orgId/payments/automation`) and sports instalments (on the due date) are charged off-session every 10 minutes (`off_session_charges`, idempotency key per fee/instalment); failures stay unpaid, email the customer and are listed at `GET /orgs/:orgId/payments/off-session-charges`.
- *Domains*: add hostname → exact CNAME + `_bh-verify` TXT records → `verify` advances `awaiting_dns → verifying → certificate_pending → ready` (or `failed`, retry restarts) via a pure state machine fed by DNS + provider checks.
- *Websites*: template fields are `locked` / `editable` / `approval`; each page field records its origin (`hq`, `local`, `locked`, `approval`). Local edits become overrides (resettable), approval fields create approval requests (no self-approval; rejection needs a comment), HQ default changes flow to inherited fields only. Group publish creates a version snapshot per location with independent results; jobs are `completed`, `partial` or `failed` and `retry` re-runs only failures.
- *AI*: Anthropic Messages API (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`; server-side refusal fallback enabled by default) with a manual tool loop. The system prompt states the active scope and the user's permissions; tools only read data the user may see in the conversation scope or store `proposed_actions`. Tool results are wrapped as `untrustedData`. Approving a proposal executes it through the same validated services with the approver's permissions.
- *Approvals*: one inbox (`approvals` table, `target_type` = `field` | `page` | `refund` | `ad_spend` | `shift_swap`). Deciders per kind: website → `website.approve`; refund → `payments.refund`; ad spend → `marketing.publish`; shift swap → `operations.write` **and** `locations.read` (managers, never general staff). No self-approval. Approve atomically claims the request (`pending → executing`), runs the underlying action (refund at the provider / commerce refund, campaign scheduled, shifts reassigned, website field applied) and only then marks it `approved` with `executionResult`; a failed execution returns it to `pending` and is audited as `approval.execution_failed`. Refunds above `settings.refundApprovalThresholds[currency]` are blocked on the direct refund endpoints (`409 approval_required`) unless the caller refunds organisation-wide.
- *Shifts*: shifts per location and person (UTC + location time zone, weekly repeat keeps local wall time), overlap protection, swap requests that create a `shift_swap` approval, append-only clock-in/out events (up to 60 minutes early, one open clock-in per person).
- *Pickup settings*: per-location hours/slot length/capacity/cut-off/prep buffer/horizon/closed dates. Saving regenerates future slots (booked slots are kept, capacity never drops below bookings); public slot listings generate the horizon on demand; ordering enforces the prep buffer.
- *Inventory*: physical movements change on-hand stock; `reservation`/`release` movements hold units for unpaid native orders (`location_variants.reserved`) and are converted into a `sale` when the payment succeeds. Listings return the running on-hand balance after each physical movement.
- *Push*: `services/notifications.ts` queues `push.send`; delivery checks the user's latest consent for `push_updates` (order status, waitlist) or `push_work` (approvals, cover), sends to every registered device via the Expo Push API (or logs in sandbox), prunes `DeviceNotRegistered` tokens and records one `push_notifications` row per user. Triggers: food order accepted/ready (customer), new approval request (everyone who can decide it), cover request (staff at the location), waitlist promotion (customer).
- *Privacy*: `GET /v1/me/export` (JSON download of personal data), `DELETE /v1/me` (password + `confirm: "DELETE"`; revokes sessions and access, erases PII, keeps tombstones for financial integrity), append-only consent records with purpose/version/timestamp, customer erasure for businesses.

## Endpoints

All routes are under `/v1` (see `/docs` for request/response schemas). Public routes need no auth;
everything under `/v1/orgs/:orgId` requires a bearer token and a role assignment in that org.


**public**

- `GET /health`
- `POST /v1/public/demo-requests`
- `GET /v1/public/industries`
- `GET /v1/public/integrations`
- `GET /v1/public/locations/{orgSlug}`

**auth**

- `POST /v1/auth/signup`
- `POST /v1/auth/verify-email`
- `POST /v1/auth/resend-verification`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`

**webhooks**

- `POST /v1/webhooks/stripe`
- `POST /v1/webhooks/uber-direct` — Uber Direct `event.delivery_status` / `event.courier_update`; HMAC-SHA256 of the raw body in `x-uber-signature` (or `x-postmates-signature`) with the location's webhook signing key; idempotent per event id (`partner_webhook_events`); statuses pending→pending, pickup→assigned, pickup_complete/dropoff→picked_up (order → out for delivery), delivered→delivered (order → delivered), canceled→cancelled, returned→failed
- `POST /v1/webhooks/deliverect` — Deliverect orders / cancellations (status 100) / busy mode; HMAC-SHA256 hex in `x-server-authorization-hmac-sha256` (production partner secret; in staging the channel link id); marketplace orders are idempotent per `channel` + `channelOrderId`
- `GET /v1/feeds/realty/{connectionId}/{token}.(xml|json)` — signed per-office hosted property feed for pull portals (idealista, Zillow/RESO XML, REAXML); token rotatable; 404 on a wrong token, 410 when switched off

**studios**

- `GET /v1/public/studios/{locationId}/schedule`
- `POST /v1/public/studios/occurrences/{id}/bookings`
- `POST /v1/public/studios/bookings/{id}/cancel`
- `GET /v1/orgs/{orgId}/studios/class-types`
- `POST /v1/orgs/{orgId}/studios/class-types`
- `GET /v1/orgs/{orgId}/studios/occurrences`
- `POST /v1/orgs/{orgId}/studios/occurrences`
- `GET /v1/orgs/{orgId}/studios/occurrences/{id}`
- `POST /v1/orgs/{orgId}/studios/occurrences/{id}/cancel`
- `POST /v1/orgs/{orgId}/studios/occurrences/{id}/bookings`
- `POST /v1/orgs/{orgId}/studios/bookings/{id}/cancel`
- `POST /v1/orgs/{orgId}/studios/bookings/{id}/attendance`
- `GET /v1/orgs/{orgId}/studios/cover-requests`
- `POST /v1/orgs/{orgId}/studios/occurrences/{id}/cover-requests`
- `POST /v1/orgs/{orgId}/studios/cover-requests/{id}/accept`
- `POST /v1/orgs/{orgId}/studios/cover-requests/{id}/decision`

**foods**

- `GET /v1/public/foods/{locationId}/menu`
- `GET /v1/public/foods/{locationId}/pickup-slots`
- `POST /v1/public/foods/{locationId}/quote`
- `POST /v1/public/foods/{locationId}/orders`
- `GET /v1/public/foods/orders/{id}`
- `GET /v1/orgs/{orgId}/foods/menus`
- `POST /v1/orgs/{orgId}/foods/menus`
- `POST /v1/orgs/{orgId}/foods/menus/{id}/publish`
- `POST /v1/orgs/{orgId}/foods/menus/{id}/items`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/menu`
- `PUT /v1/orgs/{orgId}/foods/locations/{locationId}/overrides/{menuItemId}`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/pickup-slots`
- `GET /v1/orgs/{orgId}/foods/orders`
- `POST /v1/orgs/{orgId}/foods/orders/{id}/transition`

Full foods product (routes/foods-ext.ts: foods-public, foods-menu-admin, foods-ops, foods-plans). Ordering checks run server side on every checkout (day-part in location time zone, sold-out items and modifiers, closing time, delivery zone/minimum/slot capacity, expected total):

- `POST /v1/public/foods/{locationId}/checkout/quote`
- `POST /v1/public/foods/{locationId}/checkout`
- `GET /v1/public/foods/orders/{id}/track`
- `GET /v1/public/foods/{locationId}/delivery/check`
- `GET /v1/public/foods/{locationId}/delivery-slots`
- `GET /v1/public/foods/tables/{code}`
- `GET /v1/public/foods/tabs/{id}`
- `POST /v1/public/foods/tabs/{id}/pay`
- `GET /v1/public/foods/{locationId}/preorder-dates`
- `GET /v1/public/foods/{locationId}/catering`
- `POST /v1/public/foods/{locationId}/catering/enquiries`
- `GET /v1/public/foods/catering/enquiries/{id}`
- `POST /v1/public/foods/catering/enquiries/{id}/accept`
- `POST /v1/public/foods/catering/enquiries/{id}/decline`
- `GET /v1/public/foods/{locationId}/meal-plans`
- `POST /v1/public/foods/{locationId}/meal-plans/subscriptions`
- `GET /v1/public/foods/meal-plans/subscriptions/{id}`
- `POST /v1/public/foods/meal-plans/subscriptions/{id}/skip`
- `POST /v1/public/foods/meal-plans/subscriptions/{id}/status`
- `POST /v1/public/foods/meal-plans/subscriptions/{id}/sandbox-activate`
- `GET /v1/orgs/{orgId}/foods/vocabulary`
- `GET /v1/orgs/{orgId}/foods/builder`
- `PATCH /v1/orgs/{orgId}/foods/menus/{id}`
- `POST /v1/orgs/{orgId}/foods/menus/{id}/categories`
- `PATCH /v1/orgs/{orgId}/foods/categories/{id}`
- `DELETE /v1/orgs/{orgId}/foods/categories/{id}`
- `PATCH /v1/orgs/{orgId}/foods/items/{id}`
- `DELETE /v1/orgs/{orgId}/foods/items/{id}`
- `POST /v1/orgs/{orgId}/foods/items/{id}/modifier-groups`
- `PATCH /v1/orgs/{orgId}/foods/modifier-groups/{id}`
- `DELETE /v1/orgs/{orgId}/foods/modifier-groups/{id}`
- `POST /v1/orgs/{orgId}/foods/modifier-groups/{id}/modifiers`
- `PATCH /v1/orgs/{orgId}/foods/modifiers/{id}`
- `DELETE /v1/orgs/{orgId}/foods/modifiers/{id}`
- `GET /v1/orgs/{orgId}/foods/day-parts`
- `POST /v1/orgs/{orgId}/foods/day-parts`
- `PATCH /v1/orgs/{orgId}/foods/day-parts/{id}`
- `DELETE /v1/orgs/{orgId}/foods/day-parts/{id}`
- `GET /v1/orgs/{orgId}/foods/menus/{id}/publish-preview`
- `POST /v1/orgs/{orgId}/foods/menus/{id}/publish/retry`
- `PUT /v1/orgs/{orgId}/foods/locations/{locationId}/modifiers/{modifierId}/sold-out`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/sold-out`
- `GET /v1/orgs/{orgId}/foods/settings`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/settings`
- `PUT /v1/orgs/{orgId}/foods/locations/{locationId}/settings`
- `GET /v1/orgs/{orgId}/foods/overview`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/stations`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/stations`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/stations/defaults`
- `PATCH /v1/orgs/{orgId}/foods/stations/{id}`
- `GET /v1/orgs/{orgId}/foods/kds`
- `POST /v1/orgs/{orgId}/foods/kds/tickets/{id}/start` · `…/bump` · `…/recall` (server-acknowledged; stale `expectedStatus` → 409)
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/delivery-zones`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/delivery-zones`
- `PATCH /v1/orgs/{orgId}/foods/delivery-zones/{id}`
- `DELETE /v1/orgs/{orgId}/foods/delivery-zones/{id}`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/drivers`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/drivers`
- `PATCH /v1/orgs/{orgId}/foods/drivers/{id}`
- `GET /v1/orgs/{orgId}/foods/delivery-providers`
- `GET /v1/orgs/{orgId}/foods/deliveries`
- `POST /v1/orgs/{orgId}/foods/orders/{id}/dispatch`
- `POST /v1/orgs/{orgId}/foods/deliveries/{id}/status`
- `POST /v1/orgs/{orgId}/foods/deliveries/{id}/sandbox-advance`
- `GET /v1/me/foods/deliveries`
- `POST /v1/me/foods/deliveries/{id}/status`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/tables`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/tables`
- `PATCH /v1/orgs/{orgId}/foods/tables/{id}`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/tabs`
- `POST /v1/orgs/{orgId}/foods/tabs/{id}/close`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/production-dates`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/production-dates`
- `PATCH /v1/orgs/{orgId}/foods/production-dates/{id}`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/production-summary`
- `GET /v1/orgs/{orgId}/foods/catering/packages`
- `POST /v1/orgs/{orgId}/foods/catering/packages`
- `PATCH /v1/orgs/{orgId}/foods/catering/packages/{id}`
- `GET /v1/orgs/{orgId}/foods/catering/enquiries`
- `GET /v1/orgs/{orgId}/foods/catering/enquiries/{id}`
- `POST /v1/orgs/{orgId}/foods/catering/enquiries/{id}/quote`
- `POST /v1/orgs/{orgId}/foods/catering/enquiries/{id}/status`
- `GET /v1/orgs/{orgId}/foods/meal-plans`
- `POST /v1/orgs/{orgId}/foods/meal-plans`
- `PATCH /v1/orgs/{orgId}/foods/meal-plans/{id}`
- `GET /v1/orgs/{orgId}/foods/meal-plans/subscriptions`
- `POST /v1/orgs/{orgId}/foods/meal-plans/subscriptions/{id}/skip`
- `POST /v1/orgs/{orgId}/foods/meal-plans/generate`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/meal-plans/release`
- `GET /v1/me/foods/meal-plans`
- `POST /v1/me/foods/meal-plans/{id}/skip`
- `POST /v1/me/foods/meal-plans/{id}/status`
- `GET /v1/orgs/{orgId}/foods/ingredients`
- `POST /v1/orgs/{orgId}/foods/ingredients`
- `PUT /v1/orgs/{orgId}/foods/locations/{locationId}/ingredients/{ingredientId}`
- `POST /v1/orgs/{orgId}/foods/locations/{locationId}/ingredients/{ingredientId}/movements`
- `GET /v1/orgs/{orgId}/foods/locations/{locationId}/ingredients/{ingredientId}/movements`
- `GET /v1/orgs/{orgId}/foods/items/{id}/recipe`
- `PUT /v1/orgs/{orgId}/foods/items/{id}/recipe`
- `GET /v1/orgs/{orgId}/foods/reports`
- `POST /v1/orgs/{orgId}/foods/ai/menu-copy`
- `POST /v1/orgs/{orgId}/foods/ai/campaign-draft`
- `POST /v1/orgs/{orgId}/foods/ai/production-summary`

**wellness**

- `GET /v1/public/wellness/{locationId}/services`
- `GET /v1/public/wellness/{locationId}/availability`
- `POST /v1/public/wellness/{locationId}/appointments`
- `POST /v1/public/wellness/appointments/{id}/reschedule`
- `POST /v1/public/wellness/appointments/{id}/cancel`
- `GET /v1/orgs/{orgId}/wellness/services`
- `POST /v1/orgs/{orgId}/wellness/services`
- `GET /v1/orgs/{orgId}/wellness/practitioners`
- `POST /v1/orgs/{orgId}/wellness/practitioners`
- `POST /v1/orgs/{orgId}/wellness/resources`
- `GET /v1/orgs/{orgId}/wellness/resources`
- `GET /v1/orgs/{orgId}/wellness/appointments`
- `POST /v1/orgs/{orgId}/wellness/appointments`
- `POST /v1/orgs/{orgId}/wellness/appointments/{id}/reschedule`
- `POST /v1/orgs/{orgId}/wellness/appointments/{id}/cancel`
- Full product (`routes/wellness-ext.ts`, `routes/wellness-public.ts`):
  - public: `GET /v1/public/wellness/appointments/{id}?token` (manage view + cancellation preview), `GET|POST /v1/public/wellness/{locationId}/packages`, `GET /v1/public/wellness/client-packages/{id}?token`, `POST /v1/public/wellness/{locationId}/vouchers`, `GET /v1/public/wellness/vouchers/{id}?token`, `POST /v1/public/wellness/{locationId}/vouchers/check`, `POST /v1/public/wellness/{locationId}/waitlist`, `GET /v1/public/wellness/waitlist/{id}?token`, `POST …/waitlist/{id}/claim`, `POST …/waitlist/{id}/leave`; booking accepts `variantId`, `partner`, `voucherCode`, `packageId`, `consents`
  - me: `GET /v1/me/wellness/appointments`, `POST /v1/me/wellness/appointments/{id}/cancel|reschedule`, `GET /v1/me/wellness/packages`
  - services: `PATCH …/wellness/services/{id}` (incl. `practitionerIds`), `POST …/services/{id}/variants`, `PATCH …/variants/{id}`, `PUT …/variants/{id}/prices/{locationId}`
  - practitioners/resources: `PATCH …/practitioners/{id}`, `GET …/practitioners/{id}/templates`, `PUT|DELETE …/practitioners/{id}/templates/{locationId}`, `PATCH …/resources/{id}`, `GET|PUT …/wellness/locations/{id}/settings`
  - exceptions: `GET|POST …/wellness/exceptions`, `GET …/exceptions/{id}/impact`, `POST …/exceptions/{id}/rebook` (`reassign` / `reschedule` / `cancel`, per-appointment results), `POST …/exceptions/{id}/withdraw`
  - calendar: `GET …/wellness/calendar?locationId&date`, `POST …/appointments/{id}/move` (`dryRun`), `GET …/appointments/{id}/cancellation-preview`, `POST …/appointments/{id}/check-in|complete|no-show|apply-voucher|apply-package`, `GET …/wellness/my-day`
  - series & waitlist: `POST …/wellness/series`, `GET …/series/{id}`, `POST …/series/{id}/cancel`, `GET|POST …/wellness/waitlist`, `POST …/waitlist/{id}/book|remove`
  - packages & vouchers: `GET|POST …/wellness/package-plans`, `PATCH …/package-plans/{id}`, `GET|POST …/wellness/client-packages`, `POST …/client-packages/{id}/share|cancel`, `GET|POST …/wellness/vouchers`, `GET …/vouchers/{id}`, `POST …/vouchers/{id}/cancel`
  - clients: `GET …/wellness/clients`, `GET …/clients/{id}`, `PUT …/clients/{id}/preferences`, `POST …/clients/{id}/notes`
  - reminders & reports: `POST …/wellness/reminders/run`, `GET …/wellness/messages`, `GET …/wellness/reports?from&to&locationId`, `GET …/wellness/utilisation`
  - AI drafts: `POST …/wellness/ai/service-copy|policy-reply|appointment-summary`, `GET …/wellness/ai/drafts`, `POST …/ai/drafts/{id}/decision`

**sports**

- `GET /v1/public/sports/{locationId}/programmes`
- `POST /v1/public/sports/programmes/{id}/registrations`
- `GET /v1/orgs/{orgId}/sports/programmes`
- `POST /v1/orgs/{orgId}/sports/programmes`
- `POST /v1/orgs/{orgId}/sports/programmes/{id}/seasons`
- `GET /v1/orgs/{orgId}/sports/teams`
- `POST /v1/orgs/{orgId}/sports/teams`
- `GET /v1/orgs/{orgId}/sports/registrations`
- `POST /v1/orgs/{orgId}/sports/registrations/{id}/review`
- `POST /v1/orgs/{orgId}/sports/teams/{id}/sessions`
- `GET /v1/orgs/{orgId}/sports/sessions/{id}/roster`
- `POST /v1/orgs/{orgId}/sports/sessions/{id}/attendance`

**sports (full product)** — services in `src/services/sports-*.ts`, tables in `src/db/schema/sports-ext.ts`

- Setup wizard: `POST /v1/orgs/{orgId}/sports/setup` (season → programmes with age rule/cut-off per country convention, venues, fee plans, groups + coaches, form, publish) · `GET …/sports/age-preview` · `GET|POST /seasons` (list) · `GET|POST|PATCH …/sports/venues` · `GET …/sports/coaches?locationId` · `GET|POST|PATCH …/sports/forms` (medical/emergency answers go to a restricted store) · `GET|PATCH …/sports/programmes/{id}` · `POST …/programmes/{id}/fee-plans`
- Registration: `GET /v1/public/sports/{locationId}/programmes?dob=` (age filter, birth-date ranges, payment options with instalment amounts, questions, refund policy) · `POST /v1/public/sports/programmes/{id}/registrations` (place held while paying, sibling discount, instalments, first payment) · `POST /v1/public/sports/registrations/{id}/pay` `{ manageToken }` (retry; capacity re-checked) · `GET /v1/public/sports/registrations/{id}?token=`
- Review & money: `POST …/registrations/{id}/review` (programme + team capacity under lock; guardian notified) · `POST …/registrations/{id}/withdraw` · `POST …/registrations/{id}/fee-adjustments` (financial aid / waiver) · `GET …/sports/balances` (per currency) · `POST …/sports/instalments/run-reminders` (also hourly) · `GET …/registrations/{id}/restricted` (audited; coaches see coach-visible keys only)
- Teams: `GET …/sports/teams/{id}` · `PATCH …/teams/{id}` · `PUT …/teams/{id}/coaches` · `POST …/registrations/{id}/transfer` (capacity + history) · `GET|POST …/sports/selections` · `POST …/selections/{id}/decision` (coach proposes, a different director approves)
- Schedule: `POST …/teams/{id}/recurring-sessions` · `POST …/teams/{id}/fixtures` (local kick-off) · `PATCH …/sessions/{id}` · `POST …/sessions/{id}/cancel` (only that group's guardians) · `GET …/sessions/{id}/resolutions` · `POST …/schedule-proposals/{id}/apply|dismiss`
- Communication: `GET|POST …/sports/announcements` (team or programme) · `GET …/sports/notifications?refType&refId` · `GET|POST …/sports/messages` · `GET …/sports/guardians` · `POST …/relationships/{id}/verify|dispute` · `GET …/sports/disputes` · `POST …/disputes/{id}/resolve` · `POST …/participants/{id}/invitations`
- Reports/overview: `GET …/sports/overview` · `GET …/sports/reports` (enrolment, capacity, attendance rate or null, balances per currency)
- AI (drafts/proposals only; no names, contacts or care data in context): `POST …/sports/ai/programme-description` · `…/ai/enrolment-summary` · `…/ai/conflict-resolutions`
- Guardian portal (sites; token in body): `POST /v1/public/sports/portal/request-link|session|overview|absences|messages|messages/send|invitations|disputes` · `POST …/portal/instalments/{id}/pay` · `POST …/portal/registrations/{id}/withdraw` · `POST /v1/public/sports/invitations/accept`
- App guardians: `GET /v1/me/sports` · `POST /v1/me/sports/absences|messages|invitations|invitations/accept|disputes` · `GET /v1/me/sports/messages` · `POST /v1/me/sports/instalments/{id}/pay` · `POST /v1/me/sports/programmes/{id}/registrations`

**me**

- `PATCH /v1/me`
- `DELETE /v1/me`
- `GET /v1/me/export`
- `GET /v1/me/consents`
- `POST /v1/me/consents`
- `POST /v1/me/push-tokens` / `DELETE /v1/me/push-tokens` (Expo push token registry; sending: see *Push* above)
- `POST /v1/me/consents` purposes also include `push_updates` and `push_work` (withdraw to stop those pushes)
- `POST /v1/me/waitlist/{id}/leave` (signed-in customer) · `POST /v1/public/studios/waitlist/{id}/leave` `{ manageToken }` (guest; the token is returned when joining)
- `GET /v1/me/shifts` (my shifts across organisations + open clock-in)
- `GET /v1/me/bookings`, `POST /v1/me/bookings/{id}/cancel` (signed-in customer, matched by account or email)
- `GET /v1/me/food-orders`
- `GET /v1/me/messages?locationId=`, `POST /v1/me/messages` (customer ↔ location conversation)
- `GET /v1/orgs/{orgId}/messages?locationId=` (`customers.read`), `POST /v1/orgs/{orgId}/messages` (`customers.write`, replies only)

**orgs**

- `POST /v1/orgs`
- `GET /v1/orgs`
- `GET /v1/orgs/{orgId}`
- `PATCH /v1/orgs/{orgId}`
- `GET /v1/orgs/{orgId}/onboarding`
- `PUT /v1/orgs/{orgId}/onboarding/{step}`
- `GET /v1/orgs/{orgId}/regions`
- `POST /v1/orgs/{orgId}/regions`
- `GET /v1/orgs/{orgId}/owner-groups`
- `POST /v1/orgs/{orgId}/owner-groups`
- `GET /v1/orgs/{orgId}/subscription`
- `GET /v1/orgs/{orgId}/permissions`
- `GET /v1/orgs/{orgId}/customers`
- `GET /v1/orgs/{orgId}/customers/{id}`
- `DELETE /v1/orgs/{orgId}/customers/{id}`
- `POST /v1/orgs/{orgId}/customers/{id}/consents`
- `GET /v1/orgs/{orgId}/leads`
- `GET /v1/orgs/{orgId}/campaigns`
- `POST /v1/orgs/{orgId}/campaigns`

**locations**

- `GET /v1/orgs/{orgId}/locations`
- `POST /v1/orgs/{orgId}/locations`
- `GET /v1/orgs/{orgId}/locations/{id}`
- `PATCH /v1/orgs/{orgId}/locations/{id}`
- `DELETE /v1/orgs/{orgId}/locations/{id}`
- `POST /v1/orgs/{orgId}/locations/import`

**members**

- `GET /v1/orgs/{orgId}/members`
- `POST /v1/orgs/{orgId}/invitations`
- `GET /v1/orgs/{orgId}/invitations`
- `DELETE /v1/orgs/{orgId}/invitations/{id}`
- `DELETE /v1/orgs/{orgId}/role-assignments/{id}`
- `POST /v1/invitations/accept`

**access** (access model — see Architecture)

- `GET /v1/access/catalogue?industry=&model=` — workspaces, modules (with `status`, `hqOnly`), actions, role templates
- `GET /v1/orgs/{orgId}/access/me` — my workspaces, settings modules, landing workspace, capabilities per assignment
- `GET /v1/orgs/{orgId}/roles` · `POST /v1/orgs/{orgId}/roles` · `PATCH|DELETE /v1/orgs/{orgId}/roles/{id}` — templates + custom roles
- `GET /v1/orgs/{orgId}/access/assignments` — assignments you manage with role names and workspaces
- `GET /v1/orgs/{orgId}/members/{userId}/access` — "What can this person see?"
- `PUT /v1/orgs/{orgId}/role-assignments/{id}/access` — role (system/custom) + per-person grants/revokes
- `POST /v1/orgs/{orgId}/role-assignments` — give an existing member another role in a scope
- `POST /v1/orgs/{orgId}/access/preview` — workspaces and navigation a role or ticked set would give
- `GET /v1/auth/me` — each organisation now carries `access` (capabilities, workspaces, settings, primaryWorkspace); `user.platformAdmin`; `demoMode`

**platform** (platform admins only, audited)

- `PUT /v1/platform/orgs/{orgId}/industry`

**demo** (404 unless `DEMO_MODE=true`)

- `GET /v1/demo/accounts`
- `POST /v1/demo/login`

**websites**

- `GET /v1/orgs/{orgId}/templates`
- `POST /v1/orgs/{orgId}/templates`
- `PATCH /v1/orgs/{orgId}/templates/{id}`
- `GET /v1/orgs/{orgId}/websites`
- `POST /v1/orgs/{orgId}/websites`
- `GET /v1/orgs/{orgId}/websites/{id}/pages`
- `GET /v1/orgs/{orgId}/pages/{id}`
- `PATCH /v1/orgs/{orgId}/pages/{id}/fields`
- `POST /v1/orgs/{orgId}/pages/{id}/fields/{key}/reset`
- `POST /v1/orgs/{orgId}/pages/{id}/submit`
- `GET /v1/orgs/{orgId}/approvals`
- `POST /v1/orgs/{orgId}/approvals/{id}/decision`
- `POST /v1/orgs/{orgId}/pages/{id}/publish`
- `GET /v1/orgs/{orgId}/pages/{id}/versions`
- `POST /v1/orgs/{orgId}/pages/{id}/rollback`
- `POST /v1/orgs/{orgId}/publish-jobs`
- `GET /v1/orgs/{orgId}/publish-jobs/{id}`
- `POST /v1/orgs/{orgId}/publish-jobs/{id}/retry`

**domains**

- `GET /v1/orgs/{orgId}/domains`
- `POST /v1/orgs/{orgId}/domains`
- `GET /v1/orgs/{orgId}/domains/{id}`
- `DELETE /v1/orgs/{orgId}/domains/{id}`
- `POST /v1/orgs/{orgId}/domains/{id}/verify`
- `POST /v1/orgs/{orgId}/domains/{id}/primary`

**connections**

- `GET /v1/orgs/{orgId}/connections`
- `POST /v1/orgs/{orgId}/connections`
- `POST /v1/orgs/{orgId}/connections/{id}/test`
- `POST /v1/orgs/{orgId}/connections/{id}/sync`
- `GET /v1/orgs/{orgId}/connections/{id}/status`
- `GET /v1/orgs/{orgId}/connections/{id}/mappings`
- `POST /v1/orgs/{orgId}/connections/{id}/mappings/{mappingId}/resolve`
- `DELETE /v1/orgs/{orgId}/connections/{id}`

**partner integrations** (Uber Direct, Deliverect, Rightmove, idealista, Zillow/RESO XML, REAXML — per location/office; credentials encrypted and only returned masked; `connections.manage` to change, `operations.read` to view)

- `GET /v1/orgs/{orgId}/partner-connections?industry=foods|realty` — catalogue, locations (with `canManage`, `uberDirectAvailable`) and connections with `status` (`not_configured` · `disabled` · `sandbox` · `awaiting_portal` · `live` · `error`), `statusReason`, masked credentials, last result, webhook/feed URL
- `POST /v1/orgs/{orgId}/partner-connections` `{ provider, locationId, settings }` (starts in sandbox) · `PATCH …/{id}` `{ settings?, enabled?, mode? }` (live needs complete credentials and a passing test; new credentials drop back to sandbox) · `POST …/{id}/test` · `POST …/{id}/rotate-feed-token` · `GET …/{id}/log` · `DELETE …/{id}` (credentials removed, switched off)
- Deliverect: `GET /v1/orgs/{orgId}/foods/locations/{locationId}/deliverect/menu-snapshot` · `POST …/deliverect/menu-push` (sandbox: snapshot only; live: products + sold-out snoozes) · `POST …/deliverect/busy` `{ paused, minutes? }`
- Side effects (background job `foods.partner_order_event`): accepted BranchHarbor order → POS via Deliverect (once); status changes on marketplace orders → Deliverect (`20` accepted, `50` preparing, `70` ready, `90` finalized, `110` rejected/cancelled); cancelled order → Uber courier cancelled. Checkout quotes use Uber Direct when the location's delivery provider is `uber_direct` (`feeMode` `pass_through` shows the quote to the customer, `absorb` keeps the zone fee); outside Uber Direct countries orders fall back to own drivers with `deliveryNotice`.

**payments**

- `POST /v1/public/payments/{paymentId}/sandbox-confirm`
- `POST /v1/orgs/{orgId}/payments/connect/onboarding`
- `GET /v1/orgs/{orgId}/payments/connect/status`
- `GET /v1/orgs/{orgId}/payments`
- `GET /v1/orgs/{orgId}/payments/{id}`
- `POST /v1/orgs/{orgId}/payments/{id}/refunds`
- `GET /v1/orgs/{orgId}/payments/reconciliation`
- `POST /v1/orgs/{orgId}/payments/{id}/recreate-record`

**reports**

- `GET /v1/orgs/{orgId}/reports/overview`

**audit**

- `GET /v1/orgs/{orgId}/audit-events`

**commerce (full product — routes/commerce-*.ts, services/commerce-*.ts, schema/commerce-ext.ts)**

- Catalogue (HQ, `templates.write`): `GET/POST /orgs/{orgId}/commerce/catalogue`, `GET/PUT …/catalogue/{id}` (option matrix validated, SKUs locked after distribution, removed variants archived), `POST …/catalogue/variant-matrix`, `PUT/DELETE …/catalogue/{id}/translations/{locale}`, `GET/POST/PUT …/collections`
- Distribution: `POST …/distributions/preview` (per store/product: list/update/delist/blocked + local prices outside new bounds), `POST …/distributions`, `GET …/distributions[/{id}]`, `POST …/distributions/{id}/retry`. Stores show the distributed **snapshot**, never undistributed edits.
- Local assortment: `GET …/locations/{locationId}/assortment`, `PUT …/assortment/{variantId}` (price within HQ % bounds per currency — managers only; availability; reorder point/qty; backorders), `POST …/assortment/reset`
- Storefront settings: `GET …/fulfilment-settings`, `PUT …/locations/{id}/fulfilment-settings`, `PUT …/locations/{id}/tax-rates` (`policies.write`; only configured rates are applied)
- Orders: `GET …/overview`, `GET …/sales-orders[/{id}]`, `POST …/sales-orders/{id}/fulfilments`, `POST …/fulfilments/{id}/pick`, `POST …/fulfilments/{id}/status`, `GET …/fulfilment-queue?locationId`, `POST …/sales-orders/{id}/allocate-backorders`, `POST …/sales-orders/{id}/recover` (stock conflict), `POST …/sales-orders/{id}/cancel`, `POST …/reservations/expire`
- Inventory: `GET …/inventory/alerts`, `GET/POST …/stock-counts`, `GET …/stock-counts/{id}`, `POST …/stock-counts/{id}/entries|submit|apply`, `GET/POST …/transfers`, `GET …/transfers/{id}`, `POST …/transfers/{id}/decision|ship|receive|cancel`, `GET/POST …/suppliers`, `GET/POST …/purchase-orders`, `POST …/purchase-orders/{id}/send|receive|cancel`, `GET …/variants/lookup?code`
- Returns: `GET …/returns[/{id}]`, `POST …/sales-orders/{id}/returns`, `POST …/returns/{id}/review|authorise|reject|receive|resolve` (refund — above threshold → approvals inbox; store credit; exchange)
- Gift cards / store credit: `GET/POST …/gift-cards`, `GET …/gift-cards/{id}`, `POST …/gift-cards/{id}/adjust`, `GET …/store-credit?email`
- Reports & AI: `GET …/reports` (per currency; `combinedRevenue: null`), `POST …/ai/product-copy`, `GET …/ai/merchandising`, `GET …/ai/stock-explainer`
- External orders: `POST …/connections/{id}/sync-orders` (WooCommerce, idempotent), `POST /v1/webhooks/woocommerce/{connectionId}` (HMAC `X-WC-Webhook-Signature`, `credentials.webhookSecret`)
- Storefront (public): `GET /v1/public/commerce/{brand}/{location}/storefront|products|products/{slugOrId}`, `POST /v1/public/commerce/locations/{id}/quote|checkout` (`Idempotency-Key`), `GET /v1/public/commerce/orders/{id}?token`, `POST …/orders/{id}/cancel|returns?token`, `POST /v1/public/commerce/gift-cards/balance`
- Signed-in customer: `GET /v1/me/commerce/orders[/{id}]`, `POST /v1/me/commerce/orders/{id}/returns`, `GET /v1/me/commerce/credit`
- Rules: reservations lock `location_variants` rows (`FOR UPDATE`) so the last unit sells once; unpaid checkouts hold stock for `reservationMinutes` and the sweep (60 s, plus lazily) releases it and cancels the payment intent; a payment landing after expiry re-allocates if stock is free, otherwise the order is kept paid with `fulfilmentStatus: stock_conflict` and appears in the reconciliation queue. Cross-store collection reserves at the selling store, creates an approved transfer, and sells at the collection store on handover.

**commerce (first release)**

- `GET /v1/orgs/{orgId}/commerce/products`
- `POST /v1/orgs/{orgId}/commerce/products`
- `PUT /v1/orgs/{orgId}/commerce/locations/{locationId}/variants/{variantId}`
- `GET /v1/orgs/{orgId}/commerce/locations/{locationId}/stock`
- `POST /v1/orgs/{orgId}/commerce/stock-movements`
- `GET /v1/orgs/{orgId}/commerce/stock-movements`
- `GET /v1/orgs/{orgId}/commerce/orders`
- `POST /v1/orgs/{orgId}/commerce/orders`
- `POST /v1/orgs/{orgId}/commerce/orders/{id}/refunds`
- `POST /v1/orgs/{orgId}/commerce/orders/{id}/returns`
- `POST /v1/orgs/{orgId}/commerce/returns/{id}/status`
- `GET /v1/orgs/{orgId}/commerce/orders/{id}`

**approvals**

- `GET /v1/orgs/{orgId}/approvals?status=pending|approved|rejected|cancelled|all&kind=` (requests the caller can decide or requested; `kind`, `title`, `amount`, `location`, `requester`, `canDecide`)
- `POST /v1/orgs/{orgId}/approvals/{id}/decision` `{ decision: approve|reject, comment }` (approve runs the action)
- `POST /v1/orgs/{orgId}/approvals/{id}/cancel` (requester withdraws)
- `POST /v1/orgs/{orgId}/refund-requests` `{ paymentId | orderId, amountMinor, currency, reason }` (runs immediately within threshold for refunders, else `202` pending approval)
- `POST /v1/orgs/{orgId}/ad-spend-requests` `{ locationId, amountMinor, currency, channel, durationDays, startsOn?, title }`

**shifts & time clock**

- `GET /v1/orgs/{orgId}/shifts?locationId&userId&from&to` · `POST /v1/orgs/{orgId}/shifts` · `PATCH /v1/orgs/{orgId}/shifts/{id}` · `POST /v1/orgs/{orgId}/shifts/{id}/cancel`
- `POST /v1/orgs/{orgId}/shifts/{id}/swap-requests` `{ toUserId, toShiftId?, reason }` · `GET /v1/orgs/{orgId}/shift-swaps`
- `POST /v1/orgs/{orgId}/time-clock/clock-in` `{ locationId, shiftId? }` · `POST /v1/orgs/{orgId}/time-clock/clock-out` · `GET /v1/orgs/{orgId}/time-clock` (timesheet pairs)

**studios offers · wellness intake · sports schedule · pickup settings · inventory**

- `GET /v1/public/studios/{locationId}/offers` · `GET|POST /v1/orgs/{orgId}/studios/offers` · `PATCH /v1/orgs/{orgId}/studios/offers/{id}` · `POST …/offers/{id}/eligibility` · `POST …/offers/{id}/redemptions`
- `GET /v1/public/wellness/{locationId}/intake-forms?serviceId` · `POST /v1/public/wellness/intake-forms/{id}/responses` `{ appointmentId, manageToken, answers, consent: { accepted: true, version } }`
- `GET|POST /v1/orgs/{orgId}/wellness/intake-forms` · `PATCH …/intake-forms/{id}` (new version when questions/consent change) · `GET|POST …/intake-forms/{id}/responses`
- `GET /v1/orgs/{orgId}/sports/sessions?from&to&teamId&locationId&kind` (attendance summary, `venueConflict` + `conflicts`; coaches see the teams they coach)
- `GET /v1/orgs/{orgId}/foods/pickup-settings` · `GET|PUT /v1/orgs/{orgId}/foods/locations/{locationId}/pickup-settings` · `POST …/pickup-slots/generate`
- `GET /v1/orgs/{orgId}/commerce/stock-movements?locationId&variantId&reason&from&to` (history with `balanceAfter`) · `GET /v1/orgs/{orgId}/commerce/inventory`

**orgs (policies & billing)**

- `PATCH /v1/orgs/{orgId}` also accepts `customerDataSharing` (`off` default | `totals_only` | `shared`), `aiTrainingOptOut` (default `true`) and `refundApprovalThresholds` (`{ "CAD": 5000 }`); `GET /v1/orgs/{orgId}` returns them as `policies`
- `GET /v1/orgs/{orgId}/subscription` adds `pricePerLocation`, `estimatedTotal` and `locations[]` (billed or not, with the per-location price)

**ai**

- `GET /v1/orgs/{orgId}/ai/status`
- `POST /v1/orgs/{orgId}/ai/conversations`
- `GET /v1/orgs/{orgId}/ai/conversations`
- `GET /v1/orgs/{orgId}/ai/conversations/{id}`
- `POST /v1/orgs/{orgId}/ai/conversations/{id}/messages`
- `POST /v1/orgs/{orgId}/ai/proposed-actions/{id}/decision`


**realty** (Real Estate — see [docs/verticals/real-estate.md](../../docs/verticals/real-estate.md); Keystone Realty Network demo: `elena.vargas@` HQ admin, `marcus.lee@` Toronto manager, `nadia.hassan@` / `james.whitfield@` agents, same password)

- Public: `GET /v1/public/realty/{brandSlug}/listings?transaction&type&minPrice&maxPrice&currency&minBeds&minBaths&minArea&areaUnit&city&office&sort` (price range needs a currency — never converted; other-currency count reported) · `GET /v1/public/realty/listings/{id}?areaUnit` · `GET /v1/public/realty/{brandSlug}/offices/{officeSlug}` · `GET /v1/public/realty/agencies/{brandSlug}`
- Public: `GET /v1/public/realty/listings/{id}/viewing-slots?date` · `POST /v1/public/realty/listings/{id}/viewings` (requested; agent confirms) · `GET /v1/public/realty/viewings/{id}?token` · `POST …/viewings/{id}/cancel` · `POST /v1/public/realty/{brandSlug}/enquiries` (routing: listing agent → co-listing agent → round-robin → office pool) · `POST /v1/public/realty/{brandSlug}/saved-searches` (strict criteria, alerts only with consent) · `GET /v1/public/realty/saved-searches/{id}?token` · `POST …/saved-searches/{id}/unsubscribe`
- Buyer: `GET|POST /v1/me/realty/favourites`, `DELETE /v1/me/realty/favourites/{listingId}`, `GET /v1/me/realty/viewings`, `POST /v1/me/realty/viewings/{id}/cancel`, `GET /v1/me/realty/saved-searches`, `POST /v1/me/realty/saved-searches/{id}/unsubscribe`
- Staff: `GET /v1/orgs/{orgId}/realty/me` · `GET /realty/offices` · `PUT /realty/offices/{locationId}` (tier needs `policies.write`) · `GET|POST /realty/agents` · `PATCH /realty/agents/{id}` · `GET|POST /realty/listings` · `GET|PATCH /realty/listings/{id}` (governed edits → pending) · `PUT /realty/listings/{id}/agents` · `POST /realty/listings/{id}/status` (202 = waiting for HQ) · `POST /realty/listings/{id}/approval` (`website.approve`, no self-approval) · `POST /realty/listings/{id}/open-houses` · `POST /realty/open-houses/{id}/cancel` · `GET|POST /realty/contacts`
- Staff: `GET|POST /realty/enquiries` (portal leads idempotent on `externalRef`) · `POST /realty/enquiries/{id}/assign|status` · `GET /realty/viewings` · `GET /realty/viewing-slots` · `POST /realty/viewings` · `POST /realty/viewings/{id}/confirm|cancel|feedback`
- Offers: `GET /realty/listings/{id}/offers` · `GET /realty/offers` · `GET /realty/offers/{id}` · `POST /realty/listings/{id}/offers` · `POST /realty/offers/{id}/actions` (counter/revise/accept/reject/withdraw/note; one accepted offer per listing)
- `GET /realty/reports` (no client data; volumes per currency, `combinedVolume: null`) · `GET /realty/my-day`
- Syndication (portals `rightmove` · `idealista` · `reso_xml` · `reaxml`; legacy `*_style` ids accepted): `GET /realty/syndication/portals` (status per office + last push) · `GET /realty/syndication/listings` (fresh validation errors + last result per opted-in listing) · `PUT /realty/listings/{id}/syndication/{portal}` (opt-out removes it from the portal) · `PUT /realty/listings/{id}/portal-fields` (price qualifier, tenure, council tax band, energy rating, available from — supplied by the business) · `GET /realty/syndication/{portal}/feed?locationId=` · `POST /realty/syndication/{portal}/export` (live push or sandbox record; withdrawn/sold/let are removed). Listing status changes queue `realty.portal_sync` (re-send / remove).
- AI (proposals only, fair-housing guardrails): `POST /realty/listings/{id}/ai/description` · `POST /realty/listings/{id}/ai/feedback-summary` · `POST /realty/ai/follow-ups` · `GET /realty/ai/proposals` · `POST /realty/ai/proposals/{id}/decision`
- `POST /realty/jobs/run` `{ job: viewing_reminders | saved_search_alerts }` (also every 5 minutes from `server.ts`)

**finance** (Finance workspace — royalties, statements & invoices, marketing fund, payouts; collection mechanism and exports in [docs/API_INTEGRATIONS.md](../../docs/API_INTEGRATIONS.md#finance-royalty-collection-payouts-and-accounting-exports); demo: `ruth.adeyemi@northlight.demo.branchharbor.com` finance lead, franchise owners `liam.oconnor@` / `ava.thompson@` / `oliver.grant@`)

- Access: HQ actions need the module action organisation-wide (`finance.royalties`, `finance.payouts` are HQ-private); franchisees use `finance.invoices` (their statements, invoices, disputes, mandate, sales reports) and `finance.marketing_fund` (transparency report) in their own scope. Lists are filtered by scope; records outside it answer 404. Money is per currency, never summed across currencies.
- Settings & terms: `GET|PUT /v1/orgs/{orgId}/finance/settings` (period weekly/monthly, invoice prefix, payment terms, HQ tax lines, dunning, auto-collect) · `POST /finance/collection-account` · `GET|POST /finance/terms`, `PUT /finance/terms/{id}` (owner group or default, per currency, effective dates, royalty bps, tiers marginal/whole, minimum, fund bps, technology fee, revenue basis, late fee) · `GET /finance/terms/resolve?locationId&date` (agreement → owner group → organisation)
- Periods & statements: `GET /finance/periods` · `POST /finance/periods/close {startDate}` (period must have ended in every location's time zone) · `POST /finance/periods/{id}/invoice-approved` · `GET /finance/statements` · `GET /finance/statements/{id}` · `POST /finance/statements/{id}/recalculate|adjustments|approve|invoice` · `POST /finance/statements/{id}/disputes` (franchisee) · `GET /finance/disputes` · `POST /finance/disputes/{id}/resolve`
- External sales: `GET|POST /finance/external-sales` (with evidence, ≤ 5 MB) · `POST /finance/external-sales/{id}/review` · `GET /finance/documents/{id}`
- Invoices & collection: `GET /finance/invoices` · `GET /finance/invoices/{id}` (attempts, dunning) · `GET /finance/invoices/{id}/pdf` · `POST /finance/invoices/{id}/collect` (HQ) · `POST /finance/invoices/{id}/pay` (franchisee) · `POST /finance/invoices/{id}/record-payment` · `POST /finance/invoices/{id}/sandbox-settle` (sandbox) · `POST /finance/dunning/run` · `GET /finance/payment-methods` · `POST /finance/payment-methods/setup` · `POST /finance/payment-methods/{id}/sandbox-confirm|refresh|revoke`
- Marketing fund: `GET /finance/fund/transparency?year` · `GET /finance/fund/annual-statement?year` (CSV) · `GET /finance/fund/ledger` · `GET|POST /finance/fund/campaigns` · `POST /finance/fund/spend` (receipt required, never above the balance)
- Payouts & reports: `GET /finance/payouts` · `GET /finance/payouts/{id}` · `POST /finance/payouts/sync` · `GET /finance/reconciliation?periodId` · `GET /finance/exports/{statements|invoices|payouts|fund}?format=csv|xero|quickbooks&from&to&currency` · `GET /finance/reports?from&to` · `GET /finance/overview`

## Stubbed / not yet implemented

- Partner integrations follow the partners' published shapes, but some details are assumptions until partner onboarding (marked in code): Deliverect snooze/busy-mode paths and marketplace channel ids; Rightmove single-select codes; idealista `featuresType` values; REAXML category names. idealista/REA FTP upload is not automated (hosted feed URL only).

- Object storage upload signing (S3/R2) — config + status only; no upload endpoint yet.
- Sentry/OpenTelemetry wiring — DSN accepted, SDK not initialised.
- Google/Meta OAuth sign-in — env vars reserved; only email+password auth is implemented.
- Connector `fetch` is real for WooCommerce products; WordPress/Shopify/Square/Mindbody probe credentials (`test`) but use sandbox sample data for sync.
- Subscription billing (BranchHarbor plans) is modelled (`subscriptions`, incl. the per-location price) and readable; Stripe Billing checkout/invoices are not wired.
- `customerDataSharing` and `aiTrainingOptOut` are persisted and returned; customer listings do not yet change behaviour by sharing policy (records stay scoped by role as before), and BranchHarbor sends no data for model training either way.
- Push receipts (Expo's second "getReceipts" step) are not polled; ticket errors are recorded and `DeviceNotRegistered` tokens are pruned.
- Domain purchase/registration (spec "later") is not implemented.
- Refresh-token rotation has no grace window for parallel refreshes from multiple tabs (a concurrent reuse signs the user out).
