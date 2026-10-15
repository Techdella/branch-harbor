# Design system

Source of truth: `packages/tokens/src/index.ts` (TS) mirrored in `packages/tokens/src/theme.css` (Tailwind v4 `@theme`). Visual reference: `design/prototype/BranchHarbor Brand Sheet.dc.html`.

## Colour

| Token | Hex | Use |
|---|---|---|
| ink | `#141414` | Text, primary actions, app nav |
| stone | `#5D5D58` | Secondary text (6.6:1 on white) |
| canvas | `#F3F2EE` | App and marketing background |
| surface | `#FFFFFF` | Cards, drawers, forms |
| line | `#D8D6CF` | Borders, dividers |
| lime | `#D6F26B` | **Signal.** Use once per view. Never for text. |
| sage | `#5E7D68` | Links, hover |

Industry pastels identify a vertical and are never used as status colours: Studios lilac `#E9DDF8` · Sports lime `#E2F5A6` · Wellness sage `#D4E6D9` · Commerce butter `#F7EDA8` · Foods blush `#F8D6D8` · Real Estate aqua `#CDEEEE`.

Status (success, warning, danger, info, neutral) is always shown as **text plus an icon**, never colour alone.

## Type

Plus Jakarta Sans (400/500/700/800), JetBrains Mono for codes and DNS records. Display 72/800 −0.05em · H1 40/700 −0.035em · H2 26/700 · H3 20/700 · Body L 18/500 · Body 14/500 · Label 12/800 +0.08em uppercase. Use tabular numerals for money.

## Shape and space

4px base scale. Radii: large surfaces 28–36px, cards 20–24px, tiles 12–16px, actions and tags fully round. Controls are 44px high. Shadows are restrained.

## Components (`@bh/ui`)

Button (primary / secondary / ghost / signal / danger), Badge (status), Tag, Card, Section, Eyebrow, IconTile, StatCard ("Unavailable" / "Not connected" states), Field + Input / Select / Textarea / Toggle, Tabs, Drawer, Avatar, Logo / LogoMark, Icon, Money / MoneyTotals, DataTable (switches to cards on mobile), ScopeSelector, OriginTag (From headquarters / Set locally / Locked by HQ / Approval required).

Native equivalents live in `apps/mobile/src/components` and use the same tokens.

## Dark mode

The business app (`apps/app`) and the customer sites (`apps/sites`) follow the operating-system colour scheme
(`prefers-color-scheme`); both import `@bh/tokens/theme-dark.css` after the theme. The marketing site (`apps/web`) is
designed light-only (photography and pastel sections were art-directed for the warm canvas) and declares
`color-scheme: light`. Native (`apps/mobile`) is light-only (`userInterfaceStyle: 'light'`).

* Tokens are remapped, not duplicated: Tailwind utilities read `--color-*` variables, so components need no `dark:`
  variants. Values: `darkColor` in `packages/tokens/src/index.ts`.
* The neutral scale inverts: canvas `#141413`, surfaces `#1F1F1D`, ink text `#F3F2EE`. Ink *actions*
  (`bg-ink text-white` buttons and links) become light pills with dark text; ink *panels* (`div.bg-ink`, `.on-dark`) stay
  dark islands with white text.
* Lime and the industry pastels keep their colour (they are identity, not decoration). Anything on them —
  `.bg-lime`, `.bg-lilac` …, inline pastel backgrounds, `.on-light` — is re-scoped to light-theme ink.
* Status colours have dark pairs (`success` `#A8D99C` on `#1C2A19`, etc.), all ≥ 4.5:1.
* Customer sites: the client's brand colour is tuned for white, so in dark mode brand-coloured *text* is mixed toward
  the light ink (`--color-brand-ink`) and tints are mixed into the dark surface. Brand buttons keep the exact brand colour.
* Scrims are `bg-black/40` (not `bg-ink/…`) so they stay dark in both schemes.
* `<html data-theme="light">` opts a page out.

## Responsive and cross-browser rules

* **Widths:** layouts work from 280 px (Galaxy Fold folded) to 1920 px+. Page content is capped (`max-w-[1360px]`
  marketing, `max-w-6xl` sites, prose `max-w-xl/2xl` ≈ 60–75ch). Grid items may shrink below their content
  (`:where(.grid) > * { min-width: 0 }` in the theme), long words wrap (`overflow-wrap: break-word`, hyphenated
  headings).
* **Tables** become labelled cards below 1024 px (`DataTable`, two columns from 640 px); other tables sit in a
  focusable `overflow-x-auto` container.
* **Viewport height:** use `min-h-viewport` / `h-viewport` / `h-viewport-inset` (dvh with a vh fallback), never
  `min-h-screen` or `100vh`, so mobile browser toolbars don't hide content.
* **Safe areas:** pages are `viewport-fit=cover`; the body pads `env(safe-area-inset-left/right)` for landscape
  notches, and bottom-anchored bars use `bottom-safe` / `pb-safe`.
* **Touch targets:** controls are 44 px. Compact controls keep their visual size and get a 44 × 44 hit area
  (`hit-44`, and automatically for buttons, links, tabs and switches on `pointer: coarse`); checkboxes/radios are at
  least 24 px on touch screens.
* **Inputs** are ≥ 16 px on touch screens (prevents iOS zoom-on-focus).
* **Motion:** smooth scrolling and transitions only when `prefers-reduced-motion: no-preference`.
* **Hover** is never the only way to reach something (Tailwind v4 `hover:` only applies on hover-capable pointers).
* **Browsers:** root `browserslist` (`>0.5%, last 2 versions, Firefox ESR, iOS >= 15, Safari >= 15, not dead`);
  Lightning CSS (Tailwind) and autoprefixer add prefixes and fallbacks (`color-mix` → hex, `@property` →
  `@supports` defaults). Cascade layers, `:has()` and `dvh` need Safari/iOS 15.4+; on 15.0–15.3 Tailwind v4's layered
  CSS is not applied. `:has()` is used only for enhancements (focus rings).
* **Checks:** `tools/ui-audit` (audit + cross-browser smoke tests, see its README).

## Voice

Calm, capable, plain. Short sentences, real numbers, and the next step spelled out. "2 locations haven't confirmed the policy. Remind them?", not "Compliance alert: action required immediately."
