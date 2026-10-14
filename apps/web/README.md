# @bh/web — BranchHarbor marketing site

Public website for BranchHarbor ("One home for every location"). Next.js 16 App Router, next-intl 4, Tailwind CSS 4, shared design system from `@bh/ui` / `@bh/tokens`.

```bash
pnpm --filter @bh/web dev        # http://localhost:3000 (redirects to /en)
pnpm --filter @bh/web typecheck
pnpm --filter @bh/web build && pnpm --filter @bh/web start
```

## Environment

| Variable | Default | Use |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Demo form posts to `POST /v1/public/demo-requests` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3001` | Sign-in links go to `${APP_URL}/sign-in` |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | `metadataBase` for absolute URLs |

## Structure

- `app/[locale]/…` — every route is locale-prefixed (`/en`, `/fr`, `/pt-BR`, …). `proxy.ts` (Next 16's renamed middleware) detects the locale.
- `i18n/` — routing (locales from `@bh/shared` `SUPPORTED_LOCALES`), request config, navigation helpers.
- `messages/` — `en.json` is complete. `fr`, `es`, `de`, `pt-BR` translate the header, footer, home page and demo form; any missing key falls back to English (deep merge in `i18n/request.ts`). `en-GB`, `nl`, `it` and `ar` use English text; `ar` renders `dir="rtl"`.
- `content/` — structural data: industries (icons, sample locations in several countries), integration catalogue and statuses, per-currency list prices, image URLs. Copy lives in messages.
- `components/` — `site/` (header, footer, language switcher, layout blocks), `home/ProductPreview`, `industry/IndustryTemplate` (one template for all five industry pages), `integrations/`, `pricing/`, `demo/`, `resources/`.
- `components/ui.ts` — server-safe re-exports from `packages/ui`. The `@bh/ui` barrel also exports hook-based components without `"use client"`, so Server Components import from here; Client Components can import `@bh/ui` directly.

## Content rules

- Sample data is labelled as sample. No customer logos, testimonials or performance claims.
- Integrations carry honest statuses: Tested / Limited support / Requires setup / Planned.
- Prices are static list prices per currency (USD, CAD, GBP, EUR, AUD), not live conversions; tax may apply depending on country.
- Privacy, Terms and Security are drafts marked "Draft — pending legal review".
