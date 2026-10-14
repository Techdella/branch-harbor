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
pnpm db:migrate && pnpm db:seed
pnpm dev                   # web :3000 · app :3001 · api :4000 (docs at /docs)
pnpm dev:mobile            # Expo
```

No third-party accounts are needed for local development. Every integration falls back to a sandbox mode, and the web app and mobile app can run against built-in mock data (`NEXT_PUBLIC_USE_MOCKS=true`, `EXPO_PUBLIC_USE_MOCKS=true`).

## Docs

- [Product, UI/UX and brand specification](docs/product-spec.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design system](docs/DESIGN_SYSTEM.md)
- [Third-party APIs we need to connect](docs/API_INTEGRATIONS.md)
