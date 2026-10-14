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
pnpm --filter @bh/api db:seed                   # demo data; prints the demo password
pnpm --filter @bh/api dev                       # http://localhost:4000, docs at /docs
```

Demo login after seeding: `demo@branchharbor.com` with the password printed by the seed
(set `SEED_DEMO_PASSWORD` to choose it). Also seeded: `maya.rao@demo.branchharbor.com` (location
manager, Queen West), `priya.anand@demo.branchharbor.com` (regional manager, Europe),
`carlos.ortega@demo.branchharbor.com` (staff, Ballard) — same password.

| Script | What it does |
|---|---|
| `dev` | `tsx watch` with `.env` if present |
| `start` | run the server with `tsx` (production entrypoint, see below) |
| `typecheck` / `build` | `tsc -p tsconfig.json` (no emit) |
| `test` | vitest (unit + integration) |
| `db:generate` | `drizzle-kit generate` after schema changes |
| `db:migrate` / `db:seed` / `db:reset` | migrate, seed demo data, drop+recreate (non-production only) |

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
still run. Coverage includes: permission/scope resolution, money per currency in reports, domain
state machine, Stripe webhook idempotency (duplicate + concurrent deliveries processed once),
signature rejection, partial refunds, reconciliation + "recreate record", food-order state machine
with refund on rejection, studio capacity/holds/waitlist/concurrency, wellness reschedule
preserving the original on failure, auth (refresh rotation + reuse detection), invitations and
immediate revocation, CSV import row errors, group publishing partial failure + retry, AI scoping
and proposed-action approval, privacy export/deletion, connector mapping errors.

## Environment

Every variable is documented in [`.env.example`](./.env.example) and validated by `src/config.ts`
(zod). All integrations are optional; missing keys put the adapter into a logged
**disabled/sandbox** mode and `/health` reports each one:

| Integration | Without keys |
|---|---|
| Postmark / Resend email | logged to console, not sent (dev tokens returned in responses when `EXPOSE_DEV_TOKENS`) |
| Twilio SMS, WhatsApp Cloud | logged only |
| Stripe Connect | sandbox: fake `pi_sandbox_*` intents, accounts enabled immediately; `POST /v1/public/payments/:id/sandbox-confirm` simulates the provider through the same webhook processor |
| Stripe webhooks | rejected (503) unless `STRIPE_WEBHOOK_SECRET` is set — never processed unsigned |
| Anthropic (BranchHarbor AI) | AI routes return `503 ai_unavailable`; nothing else is affected |
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
drizzle/                 generated SQL migrations (+ 0001 custom constraints)
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

**Authorisation.** Roles live in `role_assignments` (role + scope kind/id) and are loaded from the
DB on every request (never embedded in tokens), so revocation is immediate. `requirePerm` /
`requirePermission(permission, scopeResolver)` resolve the target's ancestry (organisation →
region → owner group → location) and check coverage: an org assignment covers all its
locations; region/owner-group assignments cover their locations; a location assignment covers only
that location. List endpoints filter by `authorisedLocations`. Inviters can only grant roles whose
permissions they hold in that scope. HQ report access does not imply customer access.

**Key flows**

- *Studios booking*: occurrence row lock (`SELECT … FOR UPDATE`) + partial unique index prevent overselling and duplicate bookings; paid classes create a timed hold and a PaymentIntent; full classes offer the waitlist; cancellation promotes the next waiting customer; payment after hold expiry confirms only if a seat is free, otherwise it lands in the reconciliation queue.
- *Wellness*: Postgres exclusion constraints (`btree_gist`, `tstzrange`) make overlapping confirmed reservations for the same practitioner or resource impossible (buffers included). Reschedule marks the original `rescheduled` and inserts the replacement in one transaction — if the new slot cannot be secured the transaction rolls back and the original is untouched.
- *Foods*: effective menu = HQ items + location overrides (only HQ-permitted fields) in the location's currency; order creation re-checks slot capacity/cut-off, availability, sold-out, modifiers and totals server-side (`expectedTotalMinor` mismatch → 409 `price_changed`). Transitions `awaiting_acceptance→accepted→preparing→ready→collected`; `rejected`/`cancelled` release the slot and refund/void the payment. Unpaid orders are hidden from the kitchen and cannot be accepted.
- *Payments*: Stripe Connect direct charges on the connected account (per-location or shared org account) with an application fee. `POST /v1/webhooks/stripe` verifies the signature on the raw body; the `webhook_events (provider, event_id)` unique row is inserted in the same transaction as the side effects, so duplicates are no-ops and failures are retried by Stripe. Refunds are partial-capable, bounded by the remaining amount, require `payments.refund` and an explicit `confirmCurrency`. The reconciliation queue reports *paid without record*, *unpaid but confirmed record* and *amount mismatch*; `recreate-record` re-runs fulfilment or rebuilds from the stored snapshot.
- *Domains*: add hostname → exact CNAME + `_bh-verify` TXT records → `verify` advances `awaiting_dns → verifying → certificate_pending → ready` (or `failed`, retry restarts) via a pure state machine fed by DNS + provider checks.
- *Websites*: template fields are `locked` / `editable` / `approval`; each page field records its origin (`hq`, `local`, `locked`, `approval`). Local edits become overrides (resettable), approval fields create approval requests (no self-approval; rejection needs a comment), HQ default changes flow to inherited fields only. Group publish creates a version snapshot per location with independent results; jobs are `completed`, `partial` or `failed` and `retry` re-runs only failures.
- *AI*: Anthropic Messages API (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`; server-side refusal fallback enabled by default) with a manual tool loop. The system prompt states the active scope and the user's permissions; tools only read data the user may see in the conversation scope or store `proposed_actions`. Tool results are wrapped as `untrustedData`. Approving a proposal executes it through the same validated services with the approver's permissions.
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

**me**

- `PATCH /v1/me`
- `DELETE /v1/me`
- `GET /v1/me/export`
- `GET /v1/me/consents`
- `POST /v1/me/consents`

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

**commerce**

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

**ai**

- `GET /v1/orgs/{orgId}/ai/status`
- `POST /v1/orgs/{orgId}/ai/conversations`
- `GET /v1/orgs/{orgId}/ai/conversations`
- `GET /v1/orgs/{orgId}/ai/conversations/{id}`
- `POST /v1/orgs/{orgId}/ai/conversations/{id}/messages`
- `POST /v1/orgs/{orgId}/ai/proposed-actions/{id}/decision`

## Stubbed / not yet implemented

- Object storage upload signing (S3/R2) — config + status only; no upload endpoint yet.
- Sentry/OpenTelemetry wiring — DSN accepted, SDK not initialised.
- Google/Meta OAuth sign-in — env vars reserved; only email+password auth is implemented.
- Connector `fetch` is real for WooCommerce products; WordPress/Shopify/Square/Mindbody probe credentials (`test`) but use sandbox sample data for sync.
- Subscription billing (BranchHarbor plans) is modelled (`subscriptions`) and readable; Stripe Billing checkout/invoices are not wired.
- Domain purchase/registration (spec "later") is not implemented.
- Refresh-token rotation has no grace window for parallel refreshes from multiple tabs (a concurrent reuse signs the user out).
