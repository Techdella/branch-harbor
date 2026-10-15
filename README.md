# BranchHarbor

**One home for every location.** BranchHarbor is a platform for independent businesses, multi-location operators and franchise networks. Headquarters gets oversight and brand controls. Each location gets autonomy within the permissions HQ defines.

It's built for an international audience from day one: multi-language, multi-currency (amounts are never mixed across currencies), timezone-correct, data-residency aware, with launch markets in North America, the UK and EU, APAC, the Middle East and LATAM.

## Monorepo

| Path | What | Stack |
|---|---|---|
| `apps/web` | Public marketing website (branchharbor.com) | Next.js 16, next-intl, Tailwind 4 |
| `apps/app` | Business web app for HQ, owners, managers and staff (app.branchharbor.com) | Next.js 16, next-intl, Tailwind 4 |
| `apps/mobile` | iOS + Android app: customer, staff and owner experiences | Expo (React Native), Expo Router |
| `apps/api` | Backend REST API, webhooks, jobs, AI | Fastify 5, Drizzle ORM, Postgres, Zod |
| `packages/tokens` | Design tokens (TS for native, CSS `@theme` for Tailwind) | — |
| `packages/icons` | BranchHarbor icon set (24px, 1.9 stroke) and logo SVG | — |
| `packages/ui` | React web component library (design system) | React 19 + Tailwind |
| `packages/shared` | Domain primitives: money, locales, timezones, roles/permissions, API schemas | Zod 4 |
| `design/prototype` | Original high-fidelity HTML prototypes and screenshots (reference only) | — |
| `docs` | Product spec, architecture, design system, **[API integrations list](docs/API_INTEGRATIONS.md)** | — |

## Getting started

```bash
corepack enable            # pnpm 10
pnpm install
pnpm db:up                 # Postgres, Redis, Mailpit via docker compose
cp apps/api/.env.example apps/api/.env
pnpm db:migrate && pnpm db:seed   # production-safe: creates no businesses
pnpm db:seed:demo          # optional, local/demo only: demo businesses and teams (prints the password)
pnpm dev                   # web :3000 · app :3001 · api :4000 (docs at /docs)
pnpm dev:mobile            # Expo
```

No third-party accounts are needed for local development: every integration falls back to a sandbox mode. The
dashboard and the mobile app always talk to the API — there is no sample-data mode in the product. A new sign-up starts
with an empty business account and the onboarding checklist.

## Access model

One app with **workspaces** (Network, Operations, Sales, Marketing, Finance, Legal & compliance, Training, Community)
built from **modules** and **actions** (`packages/shared/src/access.ts`). Role templates (Owner, HQ admin, VP Franchise,
CMO, Brand lead, Digital marketer, Instructor-trainer, Operations manager, Finance, Legal, Regional manager, Franchise
owner, Location manager, Staff, Customer) are starting points; owners create custom roles and per-person overrides in
Team & access. Each business account has one industry (fixed at sign-up); a login can belong to several accounts and
switches between them. The API enforces every module, action and scope; the clients only show what a person holds.
See [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md) and [apps/api/README.md](apps/api/README.md).

## Demo site

The demo site for prospects and investors (e.g. `demo.branchharbor.com`) is the **same code** against its **own
database**, never the production one:

1. Create a separate Postgres database and run `pnpm db:migrate` then `pnpm db:seed:demo` against it
   (`SEED_DEMO_PASSWORD` sets the shared demo password).
2. Run the API with `DEMO_MODE=true` (enables `GET /v1/demo/accounts` and one-click `POST /v1/demo/login` for demo
   accounts only; both are 404 otherwise).
3. Build the dashboard and customer sites with `NEXT_PUBLIC_DEMO_MODE=true` and the mobile app with
   `EXPO_PUBLIC_DEMO_MODE=true` (EAS profile `demo`), pointing at the demo API.

Every page then shows a slim "Demo environment" ribbon, and the sign-in screens list the demo accounts by business and
role — including the Northlight Yoga International franchisor team (CEO, VP Franchise, instructor-trainers, CMO, brand
lead, digital marketer, operations manager, franchise owners, location managers, staff and a custom role). Production
builds show neither. Hosting details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Docs

- [Product, UI/UX and brand specification](docs/product-spec.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design system](docs/DESIGN_SYSTEM.md)
- [Third-party APIs we need to connect](docs/API_INTEGRATIONS.md)
