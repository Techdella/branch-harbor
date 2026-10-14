# @bh/app — BranchHarbor business app

The dashboard at `app.branchharbor.com` for headquarters, franchise owners, location managers and staff.
Next.js 16 (App Router) · React 19 · next-intl 4 · Tailwind 4 · `@bh/ui`, `@bh/shared`, `@bh/tokens`, `@bh/icons`.

```bash
pnpm install                   # from the repo root
cp apps/app/.env.example apps/app/.env.local
pnpm dev:app                   # http://localhost:3001
pnpm --filter @bh/app typecheck
pnpm --filter @bh/app build && pnpm --filter @bh/app start
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend base URL (`apps/api`). All routes are under `/v1`. |
| `NEXT_PUBLIC_USE_MOCKS` | `true` | Use the built-in sample data layer (zero setup). Set to `false` to use the API. |

Both are inlined at build time, so rebuild after changing them for `next start`.

### Run against the API

```bash
# 1. Backend (see apps/api/README.md): Postgres 16 with role bh/bh and db branchharbor
cp apps/api/.env.example apps/api/.env
pnpm --filter @bh/api db:migrate && SEED_DEMO_PASSWORD='HarborDemo2026!' pnpm --filter @bh/api db:seed
pnpm --filter @bh/api dev                                   # http://localhost:4000 (CORS allows :3001)

# 2. App in live mode
NEXT_PUBLIC_USE_MOCKS=false pnpm dev:app                    # or set it in apps/app/.env.local
# production: NEXT_PUBLIC_USE_MOCKS=false pnpm --filter @bh/app build && pnpm --filter @bh/app start
```

Sign in as `demo@branchharbor.com` (organisation owner of *Stillwater Yoga Collective* — studios —, *Maple & Ember
Restaurants* — foods —, *North Shore Football Academy* — sports —, *Harbourline Wellness* and *Fieldnote Goods* — commerce;
the industry switcher moves between them). Other seeded users with the same password:
`maya.rao@demo.branchharbor.com` (location manager, Queen West), `priya.anand@demo.branchharbor.com` (regional manager,
Europe), `carlos.ortega@demo.branchharbor.com` (staff, Ballard).

With `NEXT_PUBLIC_USE_MOCKS=false`, any call that fails with a **network error** (API unreachable) is retried
against the mock layer and the app shows an "Offline · sample data" banner. HTTP errors (401/403/422/5xx) are
not masked — they surface as error / permission-denied states.

## Auth (live mode)

- `POST /v1/auth/login` / `signup` return a short-lived access token (kept in `localStorage.bh_token`, sent as
  `Authorization: Bearer`) and set the rotating `bh_refresh` httpOnly cookie on the API origin (`credentials: 'include'`).
- On a 401 the client calls `POST /v1/auth/refresh` once and retries. Refreshes are single-flight per tab and
  serialised across tabs with the Web Locks API — the API revokes the whole token family if a rotated refresh token
  is replayed, so parallel refreshes must never happen. If refresh fails the user is sent to `/sign-in?next=…`.
- Route guard: `src/proxy.ts` (Next 16 Proxy) redirects app routes to `/sign-in` when the non-secret `bh_session`
  marker cookie (set by the client while it holds a session) is missing. `AppContext` is the second guard: it loads
  `/v1/auth/me` and redirects on 401, or to `/onboarding` when the user has no organisation yet. The API enforces
  every permission regardless; both guards are UX only. Sample mode is never guarded.
- Sign-up sends `acceptTerms: true` (the form's submit is the acceptance) and the email is verified with the token
  from the emailed link (`/verify-email?token=…` verifies automatically; the link or token can also be pasted). In
  development the API returns the token (`EXPOSE_DEV_TOKENS`) and the page offers a "Development: use the token" link.
- Sign-out calls `POST /v1/auth/logout` and clears the token and marker.

## Data layer

- `src/lib/api.ts` — the `BranchHarborApi` interface, `getApi()` selection and the automatic offline fallback.
- `src/lib/http/client.ts` — fetch wrapper: bearer + cookie auth, refresh-on-401 with the storm guard, `ApiError`
  normalisation of `{ error: { code, message, fields } }` (dotted field paths are also exposed by their last segment).
- `src/lib/http/workspace.ts` — the live workspace: `/v1/auth/me` (user, organisations, role assignments) plus the
  selected organisation's directory (`/orgs/:id`, `/locations`, `/regions`, `/owner-groups`, `/websites`,
  `/connections`, `/templates`), adapted to the app's `Location` / `Organization` view models. It derives the
  session, the scope options (all authorised locations / region / owner group / location) and the API scope
  (`scopeKind` + `scopeId`) sent to reports and AI.
- `src/lib/http/httpApi.ts` — the live implementation; adapts every response to the existing view models so screens
  don't change. Money stays integer minor units + currency and is always grouped per currency.
- `src/lib/mock/*` — same interface, in-memory and stateful (`orgs.ts` organisations/locations, `content.ts`
  metrics/tables/AI copy, `mockApi.ts` behaviour). It enforces permissions like the server (throws `forbidden`),
  simulates latency, and supports `?demo=loading|empty|error|ai-down` on any page to review states.
- `src/lib/types.ts` — view models shared by both. `src/lib/useApi.ts` — `useApi` (loading/error/ready) and `useMutation`.

### Endpoint mapping (live)

All org routes are `/v1/orgs/:orgId/…` for the selected organisation; lists are filtered client-side to the selected scope.

| App method | API |
|---|---|
| `auth.signIn` / `signUp` / `verifyEmail` / `resendCode` / `signOut` | `POST /auth/login`, `/auth/signup`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/logout` (+ `/auth/refresh`) |
| `auth.session`, `org`, `scopes` | `GET /auth/me` + workspace directory (above) |
| `locations` | `GET /locations` |
| `overview` | `GET /reports/overview?scopeKind&scopeId` (metrics, per-currency revenue) + upcoming from `/studios/occurrences`, `/foods/orders?active` or `/wellness/appointments` + "needs attention" (below) |
| `notifications` | derived: `/connections` (not connected), `/payments/reconciliation`, `/approvals` (requests you can decide, all kinds → `/approvals`), `/foods/orders?status=awaiting_acceptance`, `/studios/cover-requests?status=open` |
| `search` | client-side over the directory + `GET /members` |
| `table('customers' \| 'marketing')` | `GET /customers`, `GET /campaigns` |
| `table(programmes \| teams \| services \| practitioners \| catalogue \| assortment)` | `/sports/programmes`, `/sports/teams`, `/wellness/services`, `/wellness/practitioners`, `/commerce/products`, `/commerce/inventory` (on hand / reserved / available / low stock) |
| `table(offers \| schedule \| forms \| inventory \| pickup)` | `/studios/offers` (prices per currency, eligibility rules, redemptions); `/sports/sessions` (training + fixtures, venue clash badge); `/wellness/intake-forms` (consent version, responses, AI excluded); `/commerce/stock-movements` (reason, on-hand balance after, reservations); `/foods/pickup-settings` (one column per location) |
| `studios.classes` | `GET /studios/occurrences?locationId&from&to` (+ `/studios/cover-requests` for the cover flag) |
| `studios.cover` / `acceptCover` / `approveCover` | `GET /studios/cover-requests`, `/studios/occurrences/:id`; `POST …/cover-requests/:id/accept` (the signed-in user accepts), `POST …/:id/decision` |
| `sports.registrations` / `decide` / `submitAttendance` | `GET /sports/registrations`, `/sports/programmes`, `/sports/teams`; `POST /sports/registrations/:id/review`; `POST /sports/sessions/:id/attendance` |
| `sports.session` | `GET /sports/sessions` (the session in progress, else the next one, else the latest unrecorded) + `GET /sports/sessions/:id/roster` |
| `team.schedule` | `GET /shifts?from&to` (clock-in state, pending swaps) |
| `approvals.list` / `decide` | `GET /approvals?status=pending\|all`; `POST /approvals/:id/decision { decision, comment }` (approving runs the refund / campaign / shift reassignment / website change on the server) |
| `wellness.day` / `slots` / `reschedule` | `GET /wellness/appointments`, `/wellness/practitioners`, `/wellness/services`, `/wellness/resources`; `GET /public/wellness/:locationId/availability`; `POST /wellness/appointments/:id/reschedule` |
| `commerce.orders` / `refund` | `GET /commerce/orders`, `GET /commerce/orders/:id`, `POST /commerce/orders/:id/refunds` (amount from the selected lines) |
| `foods.menu` / `resetMenuField` | `GET /foods/menus` (master, prices per currency) or `GET /foods/locations/:id/menu`; `PUT /foods/locations/:id/overrides/:itemId { priceMinor: null }` |
| `foods.orders` / `setOrderStatus` / `kitchen` | `GET /foods/orders`; `POST /foods/orders/:id/transition { to, note }`; `GET /foods/orders?locationId&active=true` |
| `websites.page` / `saveField` / `requestChange` / `decide` / `resetField` | `GET /websites/:id/pages` → `GET /pages/:id` (+ `/versions`, `/approvals`); `PATCH /pages/:id/fields` (approval fields create a request, `comment` = reason); `POST /approvals/:id/decision`; `POST /pages/:id/fields/:key/reset` |
| `websites.approvals` | `GET /approvals` |
| `websites.publishPlan` / `publish` / `retry` | plan built from `/websites` + each home page's local overrides; `POST /publish-jobs { pageSlug: 'home', locationIds }`; `POST /publish-jobs/:id/retry` |
| `websites.sites` (Domains tab) | `/websites` (included address) + `GET /domains` |
| `payments.transactions` / `reconciliation` | `GET /payments?limit=200`, `GET /payments/reconciliation` |
| `payments.recreateOrder` / `refund` | `POST /payments/:id/recreate-record`; `POST /payments/:id/refunds { amountMinor, confirmCurrency }` |
| `payments.accounts` | `GET /payments/connect/status` |
| `connections.list` / `fix` | `GET /connections`; `POST /connections/:id/sync` (degraded) or `/test` (disconnected / expired) |
| `team.members` / `invite` | `GET /members` + `GET /invitations`; `POST /invitations { email, role, scope }` |
| `reports` | `GET /reports/overview` (revenue per currency per location; combined revenue is never computed) |
| `settings.get` / `save` | `GET /orgs/:id` (`policies`) + `/subscription` (`pricePerLocation`, billed locations); `PATCH /orgs/:id` incl. `customerDataSharing` and `aiTrainingOptOut` |
| `onboarding.get` / `save` | `GET /onboarding`; `PUT /onboarding/:step` (the draft is kept in the current step's `data.draft`). A new account creates its organisation (`POST /orgs`) when the business step is completed and its first location (`POST /locations`) after the location step. |
| `onboarding.validateImport` | `POST /locations/import { dryRun: true }` (the app's `timezone` column is sent as `time_zone`; missing `address_line1`/`city` are reported per row) |
| `onboarding.domain` / `verifyDomain` | `GET`/`POST /domains`, `POST /domains/:id/verify` |
| `ai.ask` | `GET /ai/status`, then `POST /ai/conversations { scope }` and `POST /ai/conversations/:id/messages` (503 `ai_unavailable` when no key) |

**Not available from the API (shown honestly, never as sample data):** password reset by email is not implemented in
the API (the form says so); AI suggestions are fixed prompts; creating offers, intake forms, shifts and pickup settings
from the web UI is not built yet (they are created through the API/seed — the screens list and decide them).
Location `site` is "live" when the location's hosted website is live (or, with no website, when the location is
operating and publicly listed); `sync` needs attention when one of its connections isn't healthy.

## International by default

Sample organisations have locations in Canada, the US, the UK, Ireland, Germany, the Netherlands, Portugal and
Australia. Times are stored as UTC and shown in each location's IANA time zone (with the zone label); money is
integer minor units + ISO currency, formatted with `Intl` in the viewer's locale. Mixed currencies are always shown
per currency — "Combined total: Not shown — no conversion method defined".

UI language is cookie-based (`NEXT_LOCALE`, no URL prefix), chosen from the profile menu, sign-in or Settings and
falling back to `Accept-Language`. `messages/en.json` is complete; `fr`, `es`, `de`, `pt-BR` cover navigation, shell,
common, states, overview, AI panel, auth and operations titles, and fall back to English key-by-key. Sample business
content (metric names, record text) comes from the data layer and is English.

## Routes

| Route | Screen |
|---|---|
| `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password` | Auth (mock: any 10+ char password; any 6-digit code, `000000` = expired) |
| `/onboarding` (`?step=…`) | 9-step checklist, location wizard, CSV import, website address + domain connection, publish readiness |
| `/overview` | Metrics with range/source/definition, Unavailable/Not connected, upcoming (local times), needs attention |
| `/locations`, `/locations/new` | Directory (country/currency/time zone/local time), detail drawer (inherited vs local), wizard |
| `/ops/[screen]` | Industry operations — see below; "Later" items show an honest placeholder |
| `/customers`, `/marketing` | Scoped tables (members / participants / clients / customers / guests; campaigns) |
| `/websites` (`?tab=editor|approvals|publish|domains`) | Field governance, approval queue, group publish with per-location results + retry |
| `/payments` (`?tab=transactions|reconciliation|setup`) | Per-currency totals, detail timeline, reconciliation (recreate / finance-gated refund), accounts |
| `/approvals` | One inbox: refunds over the threshold, local ad spend, shift swaps, website changes — consequence preview, approve/reject with comment, result after execution |
| `/team`, `/reports`, `/connections`, `/settings`, `/community` | Members & roles + invite, and **Schedule** (week of shifts per location in local time, clock-in state, pending swaps; staff see it too); freshness-labelled charts; sync health + fix; org defaults, data region, customer sharing + AI training (saved), billing per location (price from the subscription); Later |

Operations: Studios `classes` (week/list + class drawer) `cover` `offers` `online`·Later · Sports `registrations`
`attendance` `programmes` `teams` `schedule` `guardian`·Later · Wellness `calendar` (practitioner/room/list +
reschedule) `services` `practitioners` `forms` `packages`·Later · Commerce `orders` (partial refund + sync timeline)
`catalogue` `assortment` `inventory` `returns`·Later · Foods `menu` (master/location, origins, reset) `orders`
(board) `kitchen` (large cards, overdue, stale-connection banner, full screen) `pickup` `catering`·Later.

## Shell and prototype controls

Left nav (248px; icon rail on tablet; drawer on mobile), top bar with the always-visible scope selector
(all authorised locations / region / owner group / location), permission-aware search, notifications
(information / action required / integration failure), profile + language. Two prototype controls:
**industry switcher** (top of the nav) and **Viewing as** (HQ admin = organisation owner, Location manager = one
location, Staff = assigned work only) to demonstrate permission and scope states. With the API, the industry switcher
moves between the user's own organisations (only their industries are shown) and "Viewing as" lists only the
personas the user actually holds (organisation-wide roles → HQ admin; regional / owner-group / location roles →
Location manager; staff → Staff); with a single role it is shown as a read-only "Your role" label. The AI panel is persistent on
≥1280px and full-screen below; it shows scope, suggestions, sources, assumptions, usage, status, "Drafts only", and
proposed-action cards that need explicit approval (and the right permission).

State persists per browser in `localStorage.bh_app_state` (industry, role, scope, AI panel, nav collapsed).
