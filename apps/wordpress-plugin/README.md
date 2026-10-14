# BranchHarbor WordPress connector

The WordPress plugin for the **WordPress connector** delivery model (product spec §1, §16, §17).
Customers keep their WordPress hosting and theme and add BranchHarbor blocks, forms and connections.

- Slug / text domain: `branchharbor` · License: GPL-2.0-or-later
- Requires PHP 8.1+, WordPress 6.4+ (smoke-tested on 6.7.1 and 7.1.3; WooCommerce 9.3.3 and 11.2.1)
- No build step: plain PHP, plain JS using `wp.*` globals, `block.json` per block.
- Not a pnpm workspace package on purpose (no `package.json`), so it doesn't touch the lockfile.

```
apps/wordpress-plugin/
  branchharbor/                 ← the distributable plugin (this folder is what ships in the zip)
    branchharbor.php            plugin header, constants, bootstrap, WooCommerce feature declarations
    uninstall.php               always removes credentials/queued enquiries/cache; settings unless "keep data"
    readme.txt                  WordPress.org readme incl. "External services" disclosure
    includes/
      class-plugin.php          hook wiring, privacy-policy text, activation/deactivation
      class-settings.php        options (settings, sealed connection, consent), data directions
      class-api-client.php      every outbound call: consent gate, timeouts, state tracking, fallbacks
      class-connect.php         redirect (PKCE) / connection code / public-only flows, disconnect, role
      class-connection-status.php  pure state model + status panel copy and recovery actions
      class-connection-tests.php   "Test connection" (reachability, auth, mapping, content, events, Woo)
      class-detector.php        local plugin detection (never changes other plugins)
      class-compat.php          published compatibility matrix + evaluation (pure)
      class-mapping.php         site/subsite → location validation, timezone mismatch (pure)
      class-network.php         Multisite: per-site mapping, new-site defaults
      class-admin.php           Settings → BranchHarbor (+ Network Admin page)
      class-blocks.php          block + shortcode registration, attribute sanitising
      class-renderer.php        escaped HTML for all blocks/shortcodes (cache-only on page requests)
      class-cache.php           stale-while-revalidate content cache, webhook invalidation
      class-rest.php            /wp-json/branchharbor/v1: webhook, render, site, woocommerce pull
      class-signature.php       HMAC webhook signature verification (pure)
      class-idempotency.php     at-most-once event processing (atomic add_option claim)
      class-leads.php           enquiry/demo form handler, signed form config, queue + retry
      class-lead-mapper.php     field mapping/validation/duplicate keys (pure)
      class-woocommerce.php     HPOS-safe read-only export (wc_get_orders/wc_get_products)
      class-jobs.php            Action Scheduler when present, WP-Cron otherwise
      class-format.php          minor-unit money + local time helpers (pure)
      class-secret.php          token sealing with libsodium (pure)
      class-activity.php        recent activity log (no customer data)
    blocks/<name>/block.json    6 dynamic blocks; blocks/editor.js registers their editor UI
    assets/css/{admin,blocks}.css, assets/js/{admin,blocks-view}.js
  docs/API_CONTRACT.md          existing vs proposed BranchHarbor endpoints used by the plugin
  tests/run.php                 standalone unit tests for the pure classes (php tests/run.php)
  tests/integration-smoke.php   WP-CLI smoke test against a real WordPress (API mocked)
  tests/multisite-smoke.php     WP-CLI smoke test for Multisite mapping
  bin/build-zip.sh              lint + tests + dist/branchharbor.zip
  bin/lint.sh                   php -l + WordPress Coding Standards (if composer deps installed)
  phpcs.xml.dist, composer.json, .wp-env.json
```

## What it does

| Area | Behaviour |
|---|---|
| Consent first | Nothing contacts BranchHarbor until an admin agrees on Connect → Consent (versioned record: who, when). `Api_Client::request` refuses every call without it. No ads, tracking or analytics. "Powered by" credit is off by default. |
| Connect | (1) Redirect to `app.branchharbor.com/connect/wordpress` with PKCE + state → scoped site token; (2) paste a one-time `BHC-…` code; (3) **Public content only** (org slug; works with today's API). Token + webhook secret stored in `wp_options`, sealed with libsodium using the site's salts. Optional Application Password for a dedicated **BranchHarbor Connector** role (capability `branchharbor_sync` only) for BranchHarbor → WordPress reads. |
| Detect | Local scan of WooCommerce (+HPOS), Yoast/Rank Math (SEO ownership), Elementor/Divi/Beaver/block vs classic editor, WP Rocket/W3TC/LiteSpeed/WP Super Cache, Wordfence/Solid Security, WPML/Polylang, MemberPress, Amelia/Bookly/WooCommerce Bookings/The Events Calendar, CF7/Gravity Forms/WPForms, Multisite. Labels: Tested / Limited support / Requires setup / Planned / Unsupported, with path-exclusion guidance. Never disables or reconfigures anything. |
| Map | This site (or each subsite) → organisation, one location, or "Don't connect this site". Timezone mismatch (offsets compared in Jan and Jul) is a mapping error with suggested locations and one-click fix (prototype scenario 3). Removed locations, invalid targets → errors; duplicate location → warning. |
| Data | Per data type direction (WordPress → BranchHarbor, BranchHarbor → WordPress, Two-way "later", Don't sync). SEO stays with WordPress/SEO plugin. Customer records are not copied. |
| Test | Reachability, authorisation, mapping, content load, event delivery (loopback to the webhook route detects cache/security interception + signed ping from BranchHarbor), WooCommerce read. Each failure has a "How to fix". |
| Status | connected / initial sync / degraded / disconnected / authorisation expired; last successful sync, records waiting, queued enquiries, recovery action (Retry now / Reconnect / Connect again), recent activity. |
| Blocks + shortcodes | Location finder `[branchharbor_location_finder]`, Class schedule `[branchharbor_class_schedule]`, Book button `[branchharbor_book_button]`, Menu `[branchharbor_menu]`, Pickup order button `[branchharbor_pickup_button]`, Enquiry/demo form `[branchharbor_lead_form]`. |
| Performance | Page renders never call BranchHarbor: they use cached data (last good copy) or a placeholder filled by `blocks-view.js` from the site's own REST render route. Webhooks mark cache stale; refresh runs in the background. |
| Forms | Signed form config (location/fields can't be tampered with), honeypot, per-IP rate limit, field mapping to the lead endpoint or the existing demo-request endpoint, duplicate prevention (10-min window, also sent as `Idempotency-Key`), offline queue (7 days). |
| Webhooks | `POST /wp-json/branchharbor/v1/webhook`, HMAC-SHA256 over `timestamp.body`, 5-minute tolerance, idempotent by event id. Only invalidates caches / updates status. |
| WooCommerce | Declares `custom_order_tables` and `cart_checkout_blocks` compatibility. Hooks record ids only; a background job batches `wc_get_order`/`wc_get_product` payloads (minor units, no customer PII). Never writes to WooCommerce, never adds a checkout. |
| Multisite | Network Admin → Settings → BranchHarbor: network consent + authorisation once, per-subsite mapping table with errors/fixes. New subsites start unconnected. |
| Uninstall | Always removes token/secret, queued enquiries, pending ids, idempotency rows, cached content, cron jobs, the connector role. Settings/consent/activity removed unless "Keep settings" is on. |

See [docs/API_CONTRACT.md](docs/API_CONTRACT.md) for exactly which BranchHarbor endpoints exist today
and which are proposed, and how the plugin degrades until they ship.

## Develop

### Option A — wp-env (Docker)

```bash
cd apps/wordpress-plugin
npx @wordpress/env@10 start          # latest WordPress + WooCommerce at http://localhost:8888 (admin / password)
```

`.wp-env.json` points the plugin at a local API: `BRANCHHARBOR_API_URL=http://host.docker.internal:4000`
(run `pnpm dev:api` from the repo root) and `BRANCHHARBOR_APP_URL=http://host.docker.internal:3000`.
Remove those two constants to use production.

### Option B — any local WordPress

Symlink or copy `branchharbor/` into `wp-content/plugins/` and add to `wp-config.php` if you want the
local API:

```php
define( 'BRANCHHARBOR_API_URL', 'http://localhost:4000' );
define( 'BRANCHHARBOR_APP_URL', 'http://localhost:3000' );
```

### Option C — no Docker (how this was verified)

PHP 8.1+ with `pdo_sqlite`, WP-CLI and the SQLite Database Integration drop-in:

```bash
wp core download --path=/tmp/wp && cd /tmp/wp
unzip sqlite-database-integration.zip -d wp-content/plugins && cp wp-content/plugins/sqlite-database-integration/db.copy wp-content/db.php
# edit db.php placeholders, then:
wp config create --dbname=wp --dbuser=x --dbpass=x --skip-check
wp config set DISABLE_WP_CRON true --raw     # php -S is single-threaded; cron spawn would stall loopbacks
wp core install --url=http://localhost:8899 --title=Demo --admin_user=admin --admin_password=admin --admin_email=a@example.com
ln -s /path/to/apps/wordpress-plugin/branchharbor wp-content/plugins/branchharbor
wp plugin activate branchharbor && wp rewrite structure '/%postname%/'
php -S localhost:8899 -t . &
```

## Test

```bash
php tests/run.php                                        # pure logic: 104 assertions, no WordPress needed
bash bin/lint.sh                                         # php -l (+ WPCS when `composer install` was run)
wp eval-file tests/integration-smoke.php --url=<site>    # real WordPress, BranchHarbor API mocked (78 checks)
wp eval-file tests/multisite-smoke.php --url=<network>   # Multisite (17 checks)
wp plugin check branchharbor                             # official Plugin Check (install "plugin-check")
```

The smoke tests write options and connect/disconnect a mocked BranchHarbor — **only run them on a
disposable site**. Never use `wp plugin uninstall` on a symlinked checkout: WordPress deletes the plugin
folder, which would delete your source.

Coding standards: `composer install` here, then `vendor/bin/phpcs` (ruleset `phpcs.xml.dist`:
WordPress-Extra + PHPCompatibilityWP for PHP 8.1+, text domain and prefixes enforced).

## Release

```bash
bash bin/build-zip.sh        # → dist/branchharbor.zip (php -l, unit tests and version checks first)
```

Before releasing: bump `Version:` and `BRANCHHARBOR_VERSION` in `branchharbor.php` and `Stable tag:`
in `readme.txt` together (the build fails if they differ), update `Tested up to:` / `WC tested up to:`
after re-running the smoke tests, add a changelog entry, run Plugin Check. The zip contains only the
`branchharbor/` folder; `dist/` and `*.zip` are git-ignored. For WordPress.org SVN, copy the folder
contents to `trunk/` and tag.

## Compatibility matrix maintenance

The matrix lives in `includes/class-compat.php` (`Compat::catalogue()`) and is shown on the
Compatibility tab. A version range there is a claim that the automated tests passed for that range;
entries without a range (Elementor, Yoast, WP Rocket, Wordfence, …) are labelled by status only until
they are added to the test run. A detected version outside a Tested range is automatically shown as
"Limited support".
