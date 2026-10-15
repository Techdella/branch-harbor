# @bh/ui-audit — responsive, accessibility and cross-browser checks

Two tools that run against **production builds** of the four front ends:

| Tool | What it does |
|---|---|
| `audit.mjs` + `report.mjs` | Visits every route of every app (enumerated from the file-system routers) across viewports, devices, light/dark and 200 % zoom, records layout and accessibility problems, writes full-page screenshots and a markdown summary. Chromium only. |
| `playwright.config.mjs` + `tests/` | Smoke tests: key pages render and nothing overflows horizontally at 360 / 768 / 1440 px, in Chromium, Firefox, WebKit, Mobile Safari (WebKit iPhone 15) and Mobile Chrome (Pixel 7). Runs in CI (`.github/workflows/ui-cross-browser.yml`). |

## Setup

```bash
pnpm install                                   # from the repo root
# Postgres 16 with role bh/bh, then a seeded API
DATABASE_URL=postgres://bh:bh@localhost:5432/bh_ui pnpm --filter @bh/api db:migrate
DATABASE_URL=postgres://bh:bh@localhost:5432/bh_ui SEED_DEMO_PASSWORD='HarborDemo2026!' pnpm --filter @bh/api db:seed
(cd apps/api && DATABASE_URL=… PORT=6400 CORS_ORIGINS=http://localhost:6401,http://localhost:6402,http://localhost:6403,http://localhost:6404 pnpm start)

# production builds (NEXT_PUBLIC_* are inlined at build time)
NEXT_PUBLIC_API_URL=http://localhost:6400 NEXT_PUBLIC_APP_URL=http://localhost:6402 pnpm --filter @bh/web build
NEXT_PUBLIC_API_URL=http://localhost:6400 NEXT_PUBLIC_USE_MOCKS=true pnpm --filter @bh/app build
NEXT_PUBLIC_API_URL=http://localhost:6400 SITES_BASE_URL=http://localhost:6403 pnpm --filter @bh/sites build
(cd apps/mobile && EXPO_PUBLIC_USE_MOCKS=true npx expo export --platform web --output-dir dist)

# serve
(cd apps/web && npx next start -p 6401) & (cd apps/app && npx next start -p 6402) &
(cd apps/sites && SITES_BASE_URL=http://localhost:6403 API_URL=http://localhost:6400 npx next start -p 6403) &
node tools/ui-audit/serve-static.mjs apps/mobile/dist 6404 &
```

Ports and URLs are overridable: `UI_AUDIT_WEB_URL`, `UI_AUDIT_APP_URL`, `UI_AUDIT_SITES_URL`, `UI_AUDIT_MOBILE_URL`,
`UI_AUDIT_API_URL`, `UI_AUDIT_SITE_BRANDS` (comma-separated seeded brand slugs). Chromium resolves from the
Playwright install (`PLAYWRIGHT_BROWSERS_PATH`, e.g. `/opt/pw-browsers`); `npx playwright install` otherwise.

## Audit

```bash
cd tools/ui-audit
node audit.mjs --label=before                   # all apps, standard mode (~35 min, ~2 000 page loads)
node audit.mjs --apps=app --only=/ops/kitchen --label=dev   # one app, routes whose label contains a string
node report.mjs --label=after --baseline=before # → report/SUMMARY-after.md with a before/after table
```

Options: `--apps=web,app,sites,mobile`, `--mode=standard|full|smoke`, `--concurrency=4`, `--no-shots`.

Committed results: `report/SUMMARY-before.md` (baseline, before the responsive/a11y pass) and `report/SUMMARY-after.md`
(after, with the before/after table). Raw JSON and screenshots stay local (git-ignored).

Notes on method: every route × configuration gets a fresh page (Chromium loses touch emulation — `pointer: coarse` —
after a full-page screenshot on a reused page). The large-text configuration injects its style after load; the audit
excludes that self-inflicted re-layout from CLS (runs before this fix count it).

**Routes.** `lib/routes.mjs` reads each router (`apps/*/app/**/page.tsx`, `apps/mobile/app/**/*.tsx`) and resolves dynamic
segments: the marketing site in `en` (plus `de`, `fr`, `ar` on a subset); the dashboard in sample mode for all six industries'
ops screens and every shared screen, plus the location-manager, staff and independent-business personas (seeded through the
`bh_app_state` localStorage key); customer sites for every seeded brand and every public location, each module page linked
from a location, one detail page per pattern (crawled from the server-rendered HTML) and the token pages (with an
unknown id, i.e. their error state); the Expo web export for every screen of the customer (studio and food brand), staff and
owner experiences (session seeded via `bh.token` / `bh.experience` / `bh.brand`). The summary lists file-system routes that
were not visited.

**Configurations** (`lib/config.mjs`):

* every route: 360, 768, 1440 px light and 390 px dark;
* key routes (5–8 per app): every width (320, 390, 414, 834, 1024, 1280, 1920), landscape phone 844×390, iPhone 15,
  Pixel 8 (412×915), iPad Air (820×1180), iPad landscape (1180×820), Galaxy Fold folded (280×653) in light and dark,
  360/1440 dark, 200 % browser zoom (1280×800 window → 640×400 CSS px) and large text (root font size 200 %);
* `--mode=full` runs every configuration on every route.

**Checks** (`lib/checks.mjs`):

| Check | Rule |
|---|---|
| Horizontal overflow | `scrollWidth > clientWidth` on the document, plus the outermost visible elements extending past the viewport that no scrolling/clipping ancestor contains |
| Clipped text | elements with direct text, `overflow: hidden/clip`, content larger than the box and no `text-overflow: ellipsis` / line clamp |
| Tap targets | touch viewports: interactive elements < 44 px (design rule) and < 24 px (WCAG 2.5.8); inline links in sentences and controls wrapped in a large enough label are exempt |
| Images | `<img>` without width/height attributes, aspect-ratio or a fixed box; cumulative layout shift > 0.1 with its source nodes |
| Console | `console.error`, uncaught exceptions and hydration warnings (failed resource loads are recorded separately) |
| axe-core | `@axe-core/playwright`, tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` (1440 light, 390 dark) |
| Focus | Tab through the first 20 stops; flags elements whose focused style is identical to the blurred style (1440) |
| Screenshots | full-page JPEG per route × configuration under `report/screenshots/<label>/` (git-ignored) with `index.html` / `index.md` |

Counts in the summary are unique issues (same selector / message / rule+target collapse into one) plus the number of page
loads they appeared on. The Expo web export renders inside a fixed-height scroll view, so its "full-page" screenshots show
the first viewport; React Native Web is a proxy for native layout (flexbox, safe areas, widths), not for native font
rendering or platform controls.

## Smoke tests

```bash
cd tools/ui-audit
pnpm smoke:chromium                       # what runs locally (only Chromium installed)
npx playwright test                                              # all five projects (CI)
SMOKE_APPS=sites npx playwright test                             # one app
```
