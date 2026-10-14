# @bh/web — BranchHarbor marketing site

Public website for BranchHarbor ("One home for every location"). Next.js 16 App Router, next-intl 4, Tailwind CSS 4, shared design system from `@bh/ui` / `@bh/tokens`.

```bash
pnpm --filter @bh/web dev        # http://localhost:3000 (redirects to /en)
pnpm --filter @bh/web typecheck
pnpm --filter @bh/web check:messages   # every locale has every key of en.json, ICU arguments intact
pnpm --filter @bh/web build && pnpm --filter @bh/web start
```

## Environment

| Variable | Default | Use |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Demo form posts to `POST /v1/public/demo-requests` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3001` | Sign-in links go to `${APP_URL}/sign-in` |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` | `metadataBase`, canonical/hreflang URLs, `sitemap.xml`, `robots.txt`, OG image URLs |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | _(unset)_ | Enables Cloudflare Turnstile on the demo form (see below) |

## Structure

- `app/[locale]/…` — every route is locale-prefixed (`/en`, `/fr`, `/pt-BR`, …). `proxy.ts` (Next 16's renamed middleware) detects the locale.
- `i18n/` — routing (locales from `@bh/shared` `SUPPORTED_LOCALES`), request config, navigation helpers.
- `messages/` — one complete file per locale: `en` (US English, the source), `en-GB` (British spelling), `fr`, `es`, `de`, `pt-BR`, `nl`, `it`, `ar`. `scripts/check-messages.mjs` (`pnpm check:messages`) fails if a locale is missing a key, has an extra or empty one, drops/changes an ICU argument (`{name}`, `{count, plural, …}`), or changes a code value. Add a key to `en.json` first, then to every locale. The deep merge over English in `i18n/request.ts` is only a safety net.
- Arabic (`ar`) renders `dir="rtl"`; layout uses logical utilities (`ps-`/`pe-`/`start-`/`end-`, `rtl:-scale-x-100` on directional icons). Numbers use Latin digits (`lib/intl.ts`, `ar-u-nu-latn`) to match the copy; plural branches in `ar.json` use `{count}` instead of `#` for the same reason. Currency symbols are wrapped in a bidi isolate (`content/pricing.ts`) so `US$` doesn't render as `$US`. Latin names followed by a period carry an LRM in `ar.json`. Noto Sans Arabic loads only when Arabic glyphs are on the page.
- `lib/seo.ts` — page registry used by every `generateMetadata` (`buildMetadata(locale, pageId)`): translated title/description, canonical + hreflang alternates for all locales (plus `x-default`), OpenGraph/Twitter cards. `app/sitemap.ts` lists every page × locale with alternates; `app/robots.ts`. `app/api/og/[locale]/[page]` prerenders a 1200×630 card per page and locale with the brand mark (Arabic cards use English copy: the image renderer can't shape Arabic script).
- `components/consent/` — cookie consent: `ConsentProvider` + `useConsent()` (`allows('analytics')`, `bh:consent` window event), first-visit banner and preferences dialog (also opened from “Cookie settings” in the footer). Essential only by default; analytics/marketing stay off until opted in. Stored in the first-party `bh_consent` cookie for 180 days. No analytics script is loaded today — gate PostHog on `useConsent().allows('analytics')`.
- `content/` — structural data: industries (icons, sample locations in several countries), integration catalogue and statuses, per-currency list prices, image URLs. Copy lives in messages.
- `components/` — `site/` (header, footer, language switcher, layout blocks), `home/ProductPreview`, `industry/IndustryTemplate` (one template for all five industry pages), `integrations/`, `pricing/`, `demo/`, `resources/`.
- `components/ui.ts` — server-safe re-exports from `packages/ui`. The `@bh/ui` barrel also exports hook-based components without `"use client"`, so Server Components import from here; Client Components can import `@bh/ui` directly.

## Demo form and bot protection

The form validates with the shared `demoRequestSchema`, then `POST`s to `${NEXT_PUBLIC_API_URL}/v1/public/demo-requests` with the visitor's `locale`. API field errors (`400 { error: { fields } }`) are shown on the matching fields in the visitor's language; `429` shows a “wait a few minutes” message and keeps the answers.

With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, a Cloudflare Turnstile widget renders above the submit button and its token is sent as `turnstileToken` (the widget resets after each attempt; tokens are single-use). **The API must verify it**: add `turnstileToken` to the accepted body and call `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `TURNSTILE_SECRET_KEY`, rejecting failures with `400` and `fields.turnstileToken` (the form maps that to its security-check message). Until then the token is ignored.

## Content rules

- Sample data is labelled as sample. No customer logos, testimonials or performance claims.
- Integrations carry honest statuses: Tested / Limited support / Requires setup / Planned.
- Prices are static list prices per currency (USD, CAD, GBP, EUR, AUD), not live conversions; tax may apply depending on country.
- Privacy, Terms and Security are drafts marked "Draft — pending legal review".
