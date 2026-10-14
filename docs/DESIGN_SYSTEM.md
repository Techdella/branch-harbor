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

## Voice

Calm, capable, plain. Short sentences, real numbers, and the next step spelled out. "2 locations haven't confirmed the policy. Remind them?", not "Compliance alert: action required immediately."
