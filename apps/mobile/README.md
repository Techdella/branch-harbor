# BranchHarbor mobile (`@bh/mobile`)

One Expo app for iOS and Android (plus a web preview) with three role-based experiences:

| Experience | Who | Tabs |
|---|---|---|
| **Customer** (white-label: *Stillwater Yoga* studio, *Maple & Ember* foods) | Members, guests | Home · Book (studios) / Order (foods) · Bookings · Inbox · Profile |
| **Staff** | Instructors, coaches, kitchen leads, associates | Today · Check-in · Kitchen · Messages · Cover |
| **Owner / HQ** | Franchise owners, HQ admins | Pulse · Approvals · Locations · Alerts |

Against the real API the available experiences come from `GET /v1/auth/me`: every account gets **Customer**; **Staff** when a role grants
`operations.read`; **Owner / HQ** when a role grants `reports.read` or `website.approve` (roles → permissions from `@bh/shared`).
The mock lets any signed-in user switch between all three.

**Sports** (`app/sports/*`, `src/features/sports/`): guardian portal (schedule + absence reporting, balances + instalment payment, messages) from Profile; coach roster & attendance from Staff → Today; enrolment pulse from Owner → Pulse. Live: `/v1/me/sports*`, `/v1/orgs/:orgId/sports/*`.

## Stack

Expo SDK 57 (`expo@57.0.28`, React Native 0.86.3, React 19.2.3), Expo Router 57 (file-based routes in `app/`), TypeScript 5.9.3 (strict),
`react-native-svg` (icons from `@bh/icons` via `SvgXml`), `expo-notifications` (push), `@expo-google-fonts/plus-jakarta-sans`, `expo-localization` + `i18n-js`,
`expo-secure-store` (bearer token), `@react-native-community/netinfo` (offline detection), `@stripe/stripe-react-native` (PaymentSheet integration point).

Design tokens come from `@bh/tokens` and money/locale/time/permission helpers + zod contracts from `@bh/shared` (both TypeScript source, consumed directly by Metro).

## Run

```bash
pnpm install                 # from the repo root
cp apps/mobile/.env.example apps/mobile/.env   # optional
pnpm --filter @bh/mobile start      # Expo dev server (press i / a / w)
pnpm --filter @bh/mobile ios        # or: android, web
pnpm --filter @bh/mobile typecheck
cd apps/mobile && npx expo export --platform web      # static web build in dist/
```

Demo sign-in (mock mode): any email + any 6+ character password (`wrongpass` shows the invalid-credentials error). "Continue as guest" gives the customer experience only.

### Against the real API (`apps/api`)

```bash
# 1. backend (see apps/api/README.md): Postgres 16, then
pnpm --filter @bh/api db:migrate && pnpm --filter @bh/api db:seed   # prints the demo password
pnpm --filter @bh/api dev                                            # http://localhost:4000
# 2. app
EXPO_PUBLIC_USE_MOCKS=false EXPO_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @bh/mobile start
```

Sign in as `demo@branchharbor.com` (org owner of both demo brands → Customer, Staff and Owner) with the seeded password, or
`carlos.ortega@demo.branchharbor.com` (staff, Ballard kitchen). "Continue as guest" uses only public endpoints.

- **Physical device / Android emulator:** `localhost` is the phone itself. Use your machine's LAN IP —
  `EXPO_PUBLIC_API_URL=http://192.168.1.20:4000` — (the API listens on `HOST=0.0.0.0`). The Android emulator can also use `http://10.0.2.2:4000`.
- **Web preview / CORS:** the API allows `http://localhost:8081` and `http://localhost:19006` (Expo dev server) by default. If you
  serve a static `expo export` build from another origin, add it to `CORS_ORIGINS` in `apps/api/.env`. Native apps send no `Origin` and are not affected.
- **Payments:** with no Stripe keys the API runs payments in **sandbox** mode (`/health` → `stripe: "sandbox"`). The app detects this and offers
  "Simulate successful payment", which calls `POST /v1/public/payments/:id/sandbox-confirm` so the booking/order is confirmed through the
  same webhook processor as a real payment (and a paid order then appears in the kitchen).
- `EXPO_PUBLIC_*` values are inlined at bundle time: restart Metro with `--clear` (or `expo export --clear`) after changing them.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:4000` | BranchHarbor API base; routes are under `/v1` |
| `EXPO_PUBLIC_USE_MOCKS` | `true` | In-app mock API so the app runs without `apps/api`. `false` = live API |
| `EXPO_PUBLIC_BRAND_SLUGS` | `stillwater-yoga,maple-and-ember` | Live mode: organisation slugs whose public locations form the customer catalogue (white-label brands) |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | *(empty)* | Enables Stripe PaymentSheet on iOS/Android. Empty → "Payments not configured" banner; dev/mock builds can simulate payment |
| `STRIPE_MERCHANT_IDENTIFIER` | `merchant.com.branchharbor.app` | Apple Pay merchant id for the Stripe config plugin |
| `APP_VARIANT` | `development` | Set by `eas.json` profiles; non-production builds get `.development` / `.preview` bundle-id suffixes |

## Structure

```
app/                         Expo Router routes
  _layout.tsx                fonts, providers (i18n, session, Stripe, toasts)
  index.tsx                  sign in / guest / choose experience → redirect
  customer/                  Stack: (tabs)/{home,book,order,bookings,inbox,profile},
                             class/[id] (hold → pay → confirm / waitlist), item/[id] (modifiers),
                             checkout (server quote, tax line, pay), orders/[id] (live status), locations (picker)
  staff/                     Tabs: today, checkin, kitchen, messages, cover
  owner/                     Tabs: pulse, approvals, locations, alerts
src/
  components/                Text, Icon, Button/IconButton, Card, Badge, Tag, Avatar, ListItem, SectionHeader,
                             EmptyState/ErrorState, Skeleton, MoneyText, ScreenHeader + ScopeChip, Banner, ToggleRow,
                             TextField, ConfirmSheet, Screen, TabBar, Toast, DataStatus, PaymentStep(.native)
  lib/api.ts                 typed client used by screens: mock client or live client (same signatures)
  lib/http.ts                live transport: bearer + refresh token (secure store), single-flight refresh on 401, X-BH-Client: mobile
  lib/live.ts                live adapters: real /v1 routes → app types (see mapping below)
  lib/errors.ts, useApi.ts   ApiError + fetch hook that keeps last-good data (stale banners)
  lib/session.tsx            auth, experience, brand + per-brand location
  lib/storage.ts             expo-secure-store (native) / localStorage (web preview)
  lib/format.ts              Intl money + location-timezone time helpers (DST-safe wall-clock → UTC)
  lib/network.ts, motion.ts  connectivity (+ simulated outage in mock mode), reduced motion, SR announcements
  mock/                      sample brands/locations/menu (from design/prototype/bh-data.js) + in-process /v1 mock
  i18n/                      en (complete), fr, es, de, pt-BR (core strings; fall back to en)
  features/                  customer catalog/cart/order-status helpers, shared hooks
```

## API mapping (`EXPO_PUBLIC_USE_MOCKS=false`)

`src/lib/live.ts` maps every screen-level call to the real routes and adapts the responses into the app's types (`src/lib/types.ts`),
so screens are the same in both modes. The mock (`src/mock/server.ts`) keeps the original flat paths and still documents the shapes the
screens consume. Errors are always `{ error: { code, message, fields } }` → `ApiError`.

**Auth & session**

| App call | Real endpoint(s) |
|---|---|
| `signIn` | `POST /v1/auth/login` with `X-BH-Client: mobile` → access token + refresh token in the body, both stored in expo-secure-store (localStorage on web) |
| (any 401) | `POST /v1/auth/refresh` `{ refreshToken }` once, single-flight (parallel 401s share one rotation — reuse of a rotated token revokes the session family), then retry. A rejected refresh signs the user out |
| `me` | `GET /v1/auth/me` → `organizations[].roles` → assignments + experiences |
| `signOut` | `DELETE /v1/me/push-tokens` (if registered) + `POST /v1/auth/logout` `{ refreshToken }` |
| `guest` | no call — guests use public endpoints only; a `guest` marker replaces the token |
| `registerPushToken(token)` | `POST /v1/me/push-tokens` `{ token, platform, appVersion }` — called automatically after sign-in (not for guests) by `src/lib/push.ts`: asks for notification permission once, gets the Expo push token (`expo-notifications`) and registers it; tapping a notification opens the screen in its `data.url`. Web preview: no-op (`push.web.ts`) |

**Customer**

| App call | Real endpoint(s) |
|---|---|
| `brands`, `locations` | `GET /v1/public/locations/:orgSlug` for each `EXPO_PUBLIC_BRAND_SLUGS` entry, plus `GET /v1/orgs/:orgId/locations` for the signed-in user's organisations (brand id = org slug) |
| `classes(locationId, date)` | `GET /v1/public/studios/:locationId/schedule?from&to` (the local day in the location's time zone) |
| `occurrence(id)` | same schedule, id = `locationId~occurrenceId` |
| `holdBooking` / `joinWaitlist` | `POST /v1/public/studios/occurrences/:id/bookings` `{ contact, joinWaitlist }` — paid classes return a timed hold + sandbox/Stripe payment; full → `409 class_full` → waitlist. Contact = account name/email, or a guest name + email asked once |
| `createPaymentIntent` | client secret returned by the booking/order call (no separate intent endpoint) |
| `confirmBooking` | real Stripe: confirmed by the signed webhook. Sandbox: `POST /v1/public/payments/:paymentId/sandbox-confirm`. Expired hold → `hold_expired` |
| `myBookings` | signed in: `GET /v1/me/bookings` (bookings + waitlist places, matched by account or email). Guest: bookings made on this device (with manage tokens) |
| `cancelBooking` | signed in: `POST /v1/me/bookings/:id/cancel`. Guest: `POST /v1/public/studios/bookings/:id/cancel` `{ manageToken }` |
| `leaveWaitlist` (also used by `cancelBooking` for waitlist places) | signed in: `POST /v1/me/waitlist/:id/leave`. Guest: `POST /v1/public/studios/waitlist/:id/leave` `{ manageToken }` (token kept on the device when joining) |
| `menu` | `GET /v1/public/foods/:locationId/menu` (categories flattened; unavailable → sold out) |
| `pickupSlots` | `GET /v1/public/foods/:locationId/pickup-slots?from&to` (remaining slots of the day, past cut-off hidden) |
| `quoteOrder` | `POST /v1/public/foods/:locationId/quote` — same server checks as ordering; tax only when the business configured a rate |
| `placeOrder` | `POST /v1/public/foods/:locationId/orders` `{ pickupSlotId, lines, contact, notes }` (guests enter an email for the receipt) |
| `confirmOrderPayment` | sandbox: `POST /v1/public/payments/:paymentId/sandbox-confirm` (Stripe: webhook) |
| `order(id)`, `myOrders` | `GET /v1/public/foods/orders/:id?token=` (manage token kept on the device) / signed in: `GET /v1/me/food-orders` |
| `messages`, `sendMessage` | `GET /v1/me/messages?locationId=`, `POST /v1/me/messages` (signed-in customers; staff reply via `POST /v1/orgs/:orgId/messages`) |
| `preferences`, `savePreferences` | `GET`/`POST /v1/me/consents` (`marketing_email`, `marketing_sms`, `push_updates` — the push "updates" toggle; the server skips order/waitlist pushes when withdrawn) + `PATCH /v1/me` (locale). Other reminder toggles are kept on the device |
| `dataRequest('export')` | `GET /v1/me/export` |

**Staff**

| App call | Real endpoint(s) |
|---|---|
| `myShifts` | `GET /v1/me/shifts?from&to` (today in device time, all organisations; location name + time zone included). Id = `orgId~shiftId~locationId` |
| `clockIn`, `clockOut` | `POST /v1/orgs/:orgId/time-clock/clock-in` `{ locationId, shiftId, source: mobile }` (up to 60 min early) / `POST …/time-clock/clock-out` |
| `mySessions` | `GET /v1/orgs/:orgId/studios/occurrences?from&to` (today, device time zone) for studio orgs where the user has `operations.read`; own classes if they instruct, else their assigned locations. Id = `orgId~occurrenceId` |
| `roster`, `markAttendance` | `GET /v1/orgs/:orgId/studios/occurrences/:id` (attendees, display names only) / `POST /v1/orgs/:orgId/studios/bookings/:bookingId/attendance` `{ status: attended \| no_show }` |
| `kitchenLocationId` | first Foods location the user is assigned to (role scope), else the org's first operating location |
| `kitchenOrders` | `GET /v1/orgs/:orgId/foods/orders?locationId=` (paid / pay-at-pickup orders only) |
| `setKitchenStatus` | `POST /v1/orgs/:orgId/foods/orders/:id/transition` `{ to, note }` (rejection sends a reason; the server refunds/voids) |
| `coverRequests`, `requestCover`, `acceptCover` | `GET /v1/orgs/:orgId/studios/cover-requests`, `POST …/occurrences/:id/cover-requests`, `POST …/cover-requests/:id/accept` |

**Owner / HQ**

| App call | Real endpoint(s) |
|---|---|
| `pulse` | `GET /v1/orgs/:orgId/reports/overview?scopeKind=location&scopeId=…&from=` per location (last 7 days): net revenue in the location currency, bookings/occupancy or order counts, `null` → "Unavailable" |
| `approvals` | `GET /v1/orgs/:orgId/approvals?status=pending` (refunds over the threshold, local ad spend, shift swaps and website changes the user can decide) + `GET …/studios/cover-requests?status=accepted` (cover substitutions awaiting a manager) |
| `decide` | `POST /v1/orgs/:orgId/approvals/:id/decision` (approving runs the refund / schedules the campaign / reassigns the shift on the server) / `POST …/studios/cover-requests/:id/decision` |
| `notifications` | derived: connections that are not `connected` from `GET /v1/orgs/:orgId/reports/overview` + pending approvals |

**Not available from the API yet (live mode shows an empty state or a clear message, never sample data):** staff team
messages, account deletion from the app (needs the password — use the web app), location tax labels/cancellation windows
in the catalogue (the server quote applies the business-configured tax; the class cancellation window shown is a 12-hour
default).

Money is always `{ amount: <integer minor units>, currency }`; times are UTC ISO strings rendered in the location's IANA timezone.

## Product rules implemented

- **International**: locations in Toronto (CAD), Seattle/Denver (USD), Vancouver (CAD), London (GBP), Berlin (EUR), Sydney (AUD). Every time shows the location zone; money uses `Intl.NumberFormat` in the location currency; owner Pulse shows **per-currency** totals only and "Unavailable" (never 0) for missing data.
- **Studios**: full class → *Join waitlist* (no misleading booking); spot held 5 min with countdown; expiry releases without charge and offers re-check; duplicate booking handled; cancellation shows the location's policy and whether a refund applies.
- **Foods**: pickup slot first (full slots disabled), sold-out items/modifiers disabled, required modifier validation, server quote with "Tax as configured by the business" (inclusive VAT/MwSt/GST vs added sales tax), slot-taken recovery keeps the cart; "Waiting for the restaurant to accept" vs "Accepted" are visually and textually distinct.
- **Kitchen**: large cards sorted by promised time, overdue markers, allergy notes highlighted, first names only; status buttons wait for server acknowledgement (pending label, failure keeps the server state); offline/stale banner with last refresh time and dimmed cards; actions disabled while offline. Mock mode has a "Simulate connection loss" switch.
- **Staff check-in**: present/absent per person saved individually with pending + retry; no contact/guardian data in the roster payload.
- **Approvals**: refunds show exact amount + currency + location; ad spend shows amount, channel, duration; shift swaps name both people; every decision goes through a consequence-preview sheet (reject takes an optional reason).
- **Privacy**: notification consent per channel (push/email/SMS × updates/offers); data export and deletion requests.
- **Accessibility**: labels/roles/states on all controls, ≥44pt targets, status = text + icon, live-region announcements, Dynamic Type (capped multipliers on headings), reduced-motion respected (skeleton pulse, sheet animation), start/end layout and mirrored directional icons for RTL.


## Real Estate

`app/realty/*` (feature code in `src/features/realty/`): buyer search, listing detail with save and book-a-viewing, saved homes and my
viewings (`/realty`, `/realty/listing/[id]`, `/realty/saved`); agent day — today's viewings, confirm, log feedback, new enquiries, claim from
the office pool (`/realty/agent`); owner pulse — funnel and sold/let volume per currency (`/realty/pulse`). Entry rows on the customer home,
staff Today and owner Pulse. Live endpoints: `/v1/public/realty/*`, `/v1/me/realty/*`, `/v1/orgs/:orgId/realty/my-day|reports|viewings/*`
(`EXPO_PUBLIC_REALTY_BRAND`, default `keystone-realty`).
## Payments

`PaymentStep.native.tsx` wraps Stripe PaymentSheet (`initPaymentSheet` / `presentPaymentSheet`) using the client secret the API returns when the booking hold or order is created; outcomes are confirmed server-side by signed Stripe webhooks. Without `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` the screen says **Payments not configured**; mock, dev and sandbox-API builds offer "Simulate successful payment" so flows can be completed. Web (`PaymentStep.tsx`) never loads the native SDK. Stripe needs a development build (`eas build --profile development`) — not Expo Go — when the key is set.

## Builds

`eas.json` has `development` (dev client, mocks on), `preview` (internal, live API) and `production` profiles. Bundle ids: `com.branchharbor.app` (+ `.development` / `.preview`).

**Icon & splash.** `assets/` holds PNGs generated from the harbour mark (ink rounded square, white H posts, 35% stem, lime
hub — `logoSvg` in `@bh/icons`): `icon.png` (1024, full-bleed ink), `adaptive-icon.png` + `adaptive-icon-monochrome.png`
(Android adaptive foreground inside the safe zone; background `#141414`), `splash-icon.png` (rounded tile on canvas
`#F3F2EE`, ink in dark mode), `notification-icon.png` (96, white silhouette) and `favicon.png` (48, small-size variant).
Regenerate with `pnpm --filter @bh/mobile assets` (`scripts/generate-assets.mjs`, uses `sharp`). Referenced from `app.config.ts`.

**Push.** `expo-notifications` is configured as a config plugin (notification icon + lime accent, default Android channel).
Remote push needs a development/production build with an EAS project id (`extra.eas.projectId`); Expo Go and simulators
simply skip registration. The API sends through the Expo Push API when `EXPO_ACCESS_TOKEN` or `ENABLE_EXPO_PUSH` is set
and otherwise logs each notification (sandbox).

## Monorepo notes

- pnpm's default isolated linker is kept (root `.npmrc` untouched). Metro follows the `.pnpm` symlinks (default since SDK 53); `metro.config.js` sets `watchFolders`/`nodeModulesPaths` explicitly.
- `@bh/shared` uses `.ts`-suffixed relative imports; Metro resolves them as-is and `tsconfig.json` sets `allowImportingTsExtensions`.
- `expo.install.exclude: ["typescript"]` keeps TypeScript at the monorepo's pinned 5.9.3 (SDK 57 suggests ~6.0.3).
