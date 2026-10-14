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
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Backend base URL. All routes are under `/v1`. |
| `NEXT_PUBLIC_USE_MOCKS` | `true` | Use the built-in mock data layer. Set to `false` to call the API. |

With `NEXT_PUBLIC_USE_MOCKS=false`, any call that fails with a **network error** (API unreachable) is retried
against the mock layer and the app shows an "Offline · sample data" banner. HTTP errors (401/403/422/5xx) are
not masked — they surface as error / permission-denied states.

## Data layer

- `src/lib/api.ts` — `BranchHarborApi` interface, typed HTTP client (`httpApi`), `ApiError`
  (normalises `{ error: { code, message, fields } }`), bearer token (`localStorage.bh_token`) **and** cookies
  (`credentials: 'include'`), `getApi()` selection + automatic fallback.
- `src/lib/mock/*` — same interface, in-memory and stateful (`orgs.ts` organisations/locations, `content.ts`
  metrics/tables/AI copy, `mockApi.ts` behaviour). It enforces permissions like the server (throws `forbidden`),
  simulates latency, and supports `?demo=loading|empty|error|ai-down` on any page to review states.
- `src/lib/types.ts` — DTOs shared by both. `src/lib/useApi.ts` — `useApi` (loading/error/ready) and `useMutation`.

Every request carries `industry` and `scope` query params. Endpoints the client expects (proposed contract for
`apps/api`): `GET /v1/auth/session`, `POST /v1/auth/{sign-in,sign-up,verify-email,forgot-password,sign-out}`,
`GET /v1/{organization,scopes,locations,overview,search,notifications,reports,settings}`, `GET /v1/tables/:key`,
`/v1/studios/*`, `/v1/sports/*`, `/v1/wellness/*`, `/v1/commerce/*`, `/v1/foods/*`, `/v1/websites/*`,
`/v1/payments/*`, `/v1/connections`, `/v1/team/*`, `/v1/onboarding`, `/v1/domains`, `/v1/ai/*` — see `httpApi`.

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
| `/team`, `/reports`, `/connections`, `/settings`, `/community` | Scoped roles + invite; freshness-labelled charts; sync health + fix; org defaults, data region, billing per location; Later |

Operations: Studios `classes` (week/list + class drawer) `cover` `offers` `online`·Later · Sports `registrations`
`attendance` `programmes` `teams` `schedule` `guardian`·Later · Wellness `calendar` (practitioner/room/list +
reschedule) `services` `practitioners` `forms` `packages`·Later · Commerce `orders` (partial refund + sync timeline)
`catalogue` `assortment` `inventory` `returns`·Later · Foods `menu` (master/location, origins, reset) `orders`
(board) `kitchen` (large cards, overdue, stale-connection banner, full screen) `pickup` `catering`·Later.

## Shell and prototype controls

Left nav (248px; icon rail on tablet; drawer on mobile), top bar with the always-visible scope selector
(all authorised locations / region / owner group / location), permission-aware search, notifications
(information / action required / integration failure), profile + language. Two prototype-only controls:
**industry switcher** (top of the nav) and **Viewing as** (HQ admin = organisation owner, Location manager = one
location, Staff = assigned work only) to demonstrate permission and scope states. The AI panel is persistent on
≥1280px and full-screen below; it shows scope, suggestions, sources, assumptions, usage, status, "Drafts only", and
proposed-action cards that need explicit approval (and the right permission).

State persists per browser in `localStorage.bh_app_state` (industry, role, scope, AI panel, nav collapsed).
