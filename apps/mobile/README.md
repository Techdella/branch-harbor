# BranchHarbor mobile (`@bh/mobile`)

One Expo app for iOS and Android (plus a web preview) with three role-based experiences:

| Experience | Who | Tabs |
|---|---|---|
| **Customer** (white-label: *Stillwater Yoga* studio, *Maple & Ember* foods) | Members, guests | Home · Book (studios) / Order (foods) · Bookings · Inbox · Profile |
| **Staff** | Instructors, coaches, kitchen leads, associates | Today · Check-in · Kitchen · Messages · Cover |
| **Owner / HQ** | Franchise owners, HQ admins | Pulse · Approvals · Locations · Alerts |

In production the experience comes from `GET /v1/auth/me` (`experiences`). The demo lets a signed-in user switch.

## Stack

Expo SDK 57 (`expo@57.0.28`, React Native 0.86.3, React 19.2.3), Expo Router 57 (file-based routes in `app/`), TypeScript 5.9.3 (strict),
`react-native-svg` (icons from `@bh/icons` via `SvgXml`), `@expo-google-fonts/plus-jakarta-sans`, `expo-localization` + `i18n-js`,
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

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:4000` | BranchHarbor API base; routes are under `/v1` |
| `EXPO_PUBLIC_USE_MOCKS` | `true` | In-app mock API so the app runs without `apps/api` |
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
  lib/api.ts                 typed /v1 client (bearer token, Idempotency-Key, { error: { code, message, fields } })
  lib/errors.ts, useApi.ts   ApiError + fetch hook that keeps last-good data (stale banners)
  lib/session.tsx            auth, experience, brand + per-brand location
  lib/storage.ts             expo-secure-store (native) / localStorage (web preview)
  lib/format.ts              Intl money + location-timezone time helpers (DST-safe wall-clock → UTC)
  lib/network.ts, motion.ts  connectivity (+ simulated outage in mock mode), reduced motion, SR announcements
  mock/                      sample brands/locations/menu (from design/prototype/bh-data.js) + in-process /v1 mock
  i18n/                      en (complete), fr, es, de, pt-BR (core strings; fall back to en)
  features/                  customer catalog/cart/order-status helpers, shared hooks
```

## API contract used (`/v1`)

`POST /auth/sign-in`, `POST /auth/guest`, `GET /auth/me`, `POST /auth/sign-out` ·
`GET /brands`, `GET /locations?brandId=`, `GET /locations/:id/classes?date=`, `GET /class-occurrences/:id`,
`POST /bookings` (hold), `POST /bookings/:id/confirm`, `POST /bookings/:id/cancel`, `POST /waitlist`, `GET /me/bookings` ·
`GET /locations/:id/menu`, `GET /locations/:id/pickup-slots?date=`, `POST /locations/:id/orders/quote`, `POST /orders`, `GET /orders/:id`, `GET /me/orders` ·
`POST /payments/intents` → `{ clientSecret, merchantDisplayName, customerId?, ephemeralKey? }` ·
`GET|POST /me/messages`, `GET|PUT /me/preferences`, `POST /me/data-requests` ·
`GET /staff/shifts`, `POST /staff/shifts/:id/clock-in`, `GET /staff/sessions`, `GET /staff/sessions/:id/roster`, `PUT /staff/sessions/:id/attendance/:entryId`,
`GET /kitchen/orders?locationId=`, `POST /kitchen/orders/:id/status`, `GET /staff/messages`, `GET|POST /staff/cover-requests`, `POST /staff/cover-requests/:id/accept` ·
`GET /hq/pulse`, `GET /approvals`, `POST /approvals/:id/decision`, `GET /notifications`.

Money is always `{ amount: <integer minor units>, currency }`; times are UTC ISO strings rendered in the location's IANA timezone.
The mock in `src/mock/server.ts` is the reference for request/response shapes until `apps/api` publishes them.

## Product rules implemented

- **International**: locations in Toronto (CAD), Seattle/Denver (USD), Vancouver (CAD), London (GBP), Berlin (EUR), Sydney (AUD). Every time shows the location zone; money uses `Intl.NumberFormat` in the location currency; owner Pulse shows **per-currency** totals only and "Unavailable" (never 0) for missing data.
- **Studios**: full class → *Join waitlist* (no misleading booking); spot held 5 min with countdown; expiry releases without charge and offers re-check; duplicate booking handled; cancellation shows the location's policy and whether a refund applies.
- **Foods**: pickup slot first (full slots disabled), sold-out items/modifiers disabled, required modifier validation, server quote with "Tax as configured by the business" (inclusive VAT/MwSt/GST vs added sales tax), slot-taken recovery keeps the cart; "Waiting for the restaurant to accept" vs "Accepted" are visually and textually distinct.
- **Kitchen**: large cards sorted by promised time, overdue markers, allergy notes highlighted, first names only; status buttons wait for server acknowledgement (pending label, failure keeps the server state); offline/stale banner with last refresh time and dimmed cards; actions disabled while offline. Mock mode has a "Simulate connection loss" switch.
- **Staff check-in**: present/absent per person saved individually with pending + retry; no contact/guardian data in the roster payload.
- **Approvals**: refunds show exact amount + currency + location; ad spend shows amount, channel, duration; shift swaps name both people; every decision goes through a consequence-preview sheet (reject takes an optional reason).
- **Privacy**: notification consent per channel (push/email/SMS × updates/offers); data export and deletion requests.
- **Accessibility**: labels/roles/states on all controls, ≥44pt targets, status = text + icon, live-region announcements, Dynamic Type (capped multipliers on headings), reduced-motion respected (skeleton pulse, sheet animation), start/end layout and mirrored directional icons for RTL.

## Payments

`PaymentStep.native.tsx` wraps Stripe PaymentSheet (`initPaymentSheet` / `presentPaymentSheet`) using the client secret from `POST /v1/payments/intents`; outcomes are confirmed server-side by signed Stripe webhooks. Without `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` the screen says **Payments not configured**; dev and mock builds offer "Simulate successful payment" so flows can be completed. Web (`PaymentStep.tsx`) never loads the native SDK. Stripe needs a development build (`eas build --profile development`) — not Expo Go — when the key is set.

## Builds

`eas.json` has `development` (dev client, mocks on), `preview` (internal, live API) and `production` profiles. Bundle ids: `com.branchharbor.app` (+ `.development` / `.preview`). No icon/splash images are committed yet — splash uses token colours; add `assets/icon.png` before store builds.

## Monorepo notes

- pnpm's default isolated linker is kept (root `.npmrc` untouched). Metro follows the `.pnpm` symlinks (default since SDK 53); `metro.config.js` sets `watchFolders`/`nodeModulesPaths` explicitly.
- `@bh/shared` uses `.ts`-suffixed relative imports; Metro resolves them as-is and `tsconfig.json` sets `allowImportingTsExtensions`.
- `expo.install.exclude: ["typescript"]` keeps TypeScript at the monorepo's pinned 5.9.3 (SDK 57 suggests ~6.0.3).
