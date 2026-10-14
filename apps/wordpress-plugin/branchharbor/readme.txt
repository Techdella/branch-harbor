=== BranchHarbor Connector ===
Contributors: branchharbor
Tags: locations, class schedule, restaurant menu, multi-location, woocommerce
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Keep your WordPress site and add BranchHarbor location finders, class schedules, menus, booking buttons and routed enquiry forms.

== Description ==

BranchHarbor helps independent businesses, multi-location operators and franchise networks run their locations from one place. This connector lets you keep your existing WordPress site and theme while adding BranchHarbor content and connections.

**This plugin is a connector to the BranchHarbor service.** It needs a BranchHarbor account (or, for public content only, your organisation's public BranchHarbor address). See "External services" below for exactly what is sent and when.

= What you get =

* **Blocks and shortcodes** — Location finder, Class schedule, Book button, Menu, Pickup order button and an Enquiry / demo form. They work in the block editor and, through shortcodes, in Elementor, Divi, Beaver Builder and the classic editor.
* **Guided connection** — consent, a local compatibility scan, least-privilege authorisation, location mapping, per-data-type direction choices and end-to-end connection tests.
* **Honest compatibility** — a published matrix with the labels Tested, Limited support, Requires setup, Planned and Unsupported. Nothing outside the matrix is claimed to work.
* **Multisite** — authorise the network once and map each site to a location explicitly, with clear mapping errors (for example a site in Pacific time mapped to a location in Eastern time).
* **WooCommerce (read-only)** — optionally share product and order totals with BranchHarbor for reporting, using WooCommerce APIs. Compatible with High-Performance Order Storage and cart/checkout blocks. Your checkout stays exactly as it is; no second checkout is added and customer personal details are not sent.
* **Status you can act on** — connected, initial sync, degraded, disconnected or authorisation expired, with the last successful sync, records waiting and a recovery action.

= What it never does =

* It does not contact BranchHarbor until an administrator connects and agrees to data processing.
* It does not disable, reconfigure or replace other plugins, and it does not overwrite your posts or pages.
* It does not copy your customer lists.
* It does not add ads, analytics or tracking to your site.
* It does not output SEO titles, canonical links or sitemaps — your SEO plugin stays in charge.
* The "Powered by BranchHarbor" credit is off unless you turn it on.

= Performance =

Pages never wait for BranchHarbor. Content is cached on your site and refreshed in the background (WP-Cron, or Action Scheduler when WooCommerce provides it). BranchHarbor notifies your site when schedules or menus change so the cache stays current.

== External services ==

This plugin connects to the **BranchHarbor API** (`https://api.branchharbor.com`) and, during the optional authorisation redirect, to the **BranchHarbor app** (`https://app.branchharbor.com`). Both are operated by BranchHarbor. No request is made before an administrator agrees to data processing on Settings → BranchHarbor → Connect.

What is sent, and when:

* **When you connect** (authorisation redirect or connection code): this site's address, REST API address, name, time zone, language, WordPress version, plugin version and whether it is a Multisite network, plus the one-time code. In return the site receives a site-scoped token stored in your database (encrypted with your site's salts).
* **When you save mapping, data directions or run a compatibility scan**: the chosen location mapping, data directions, SEO ownership choice and the list of detected plugin names, versions and compatibility status (not their settings).
* **When a visitor submits a BranchHarbor enquiry or demo form**: the fields the visitor filled in (for example name, email, phone, message, business name, number of locations, country, website and the marketing consent choice), the page address and the form's location. If BranchHarbor is unavailable, the submission is stored on your site for up to 7 days and retried, then deleted.
* **In the background, while connected**: requests for public content — your organisation's locations, class schedules, menus and pickup times. No visitor data is included in these requests.
* **If WooCommerce sync is turned on** (WordPress → BranchHarbor): product details (name, SKU, price, stock) and order details (number, status, totals, currency, line items, timestamps, whether the customer is registered). Customer names, emails, phone numbers and addresses are not sent.
* **When you run connection tests**: a reachability check and, with a full connection, a request for a signed test event.
* **When you disconnect**: a request to revoke this site's token.

BranchHarbor sends signed event notifications to `/wp-json/branchharbor/v1/webhook` on your site (for example "schedule updated"). They only clear cached content.

Booking and pickup buttons link visitors to pages hosted by BranchHarbor for the selected location.

* BranchHarbor terms of service: https://branchharbor.com/legal/terms
* BranchHarbor privacy policy: https://branchharbor.com/legal/privacy
* Data processing agreement: https://branchharbor.com/legal/dpa

== Installation ==

1. Install and activate the plugin from Plugins → Add New, or upload the `branchharbor` folder to `/wp-content/plugins/`.
2. Go to Settings → BranchHarbor → Connect.
3. Read what is shared and agree to data processing.
4. Scan the site, then connect with BranchHarbor (or paste a connection code, or choose "Public content only").
5. Map this site to a BranchHarbor location, choose data directions and run the tests.
6. Add BranchHarbor blocks to your pages.

On Multisite, network-activate the plugin and use Network Admin → Settings → BranchHarbor to authorise the network and map each site.

= Cache and security plugins =

Exclude `/wp-json/branchharbor/` from page caching and minification, and allow POST requests to `/wp-json/branchharbor/v1/webhook`. Pages that contain BranchHarbor blocks can stay cached. The connection test tells you if something is intercepting the route.

= Optional: Application Password =

To let BranchHarbor read WooCommerce data from your site on demand, create a user with the "BranchHarbor Connector" role (it can only read BranchHarbor endpoints) and create an Application Password for that user from the link on the Connect tab. Never use an administrator account for this.

== Frequently Asked Questions ==

= Does the plugin work without a BranchHarbor account? =

The plugin connects your site to the BranchHarbor service. Without an account you can use "Public content only" for a business that already publishes on BranchHarbor. Location enquiries, WooCommerce sync and instant updates need a full connection.

= Will it change my WooCommerce checkout? =

No. Orders are read through WooCommerce APIs and sent for reporting only. Nothing is written back and no checkout is added.

= What happens if BranchHarbor is unreachable? =

Blocks keep showing the last copy that loaded. Enquiries are queued on your site and retried. The Overview tab shows the status, the last successful sync and a recovery action.

= What happens when I disconnect or delete the plugin? =

Disconnecting revokes the site token. BranchHarbor blocks show a short "temporarily unavailable" message; your pages are untouched. Deleting the plugin always removes credentials, queued enquiries and cached content; settings are kept only if you chose to keep them.

= Which languages are supported? =

The plugin is translation-ready (text domain `branchharbor`). Blocks currently show in the site's default language; WPML and Polylang mapping is planned.

== Screenshots ==

1. Connect: consent, detection, authorisation, mapping, data direction and tests.
2. Compatibility matrix with status labels.
3. Class schedule block in the editor.
4. Overview with connection status and recent activity.

== Changelog ==

= 1.0.0 =
* First release: guided connection, compatibility scan, Multisite mapping, six blocks with shortcodes, signed webhooks, queued enquiries, read-only WooCommerce export.

== Upgrade Notice ==

= 1.0.0 =
First release.
