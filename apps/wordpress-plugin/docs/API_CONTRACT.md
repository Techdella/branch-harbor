# BranchHarbor WordPress connector — API contract

This is the contract between the WordPress plugin (`apps/wordpress-plugin/branchharbor`) and the
BranchHarbor API (`apps/api`). It lists which endpoints **exist today** and which are **proposed**
(the plugin is built against them and degrades gracefully until they ship).

- Base URL: `https://api.branchharbor.com` (override with `define( 'BRANCHHARBOR_API_URL', … )` or the
  `branchharbor_api_base` filter). App URL: `https://app.branchharbor.com` (`BRANCHHARBOR_APP_URL`,
  `branchharbor_app_base`).
- Every request carries `User-Agent: BranchHarbor-WordPress/<version>; <site url>`,
  `X-BH-Client: wordpress-plugin` and `X-BH-Version`.
- Authenticated requests carry `Authorization: Bearer <site token>` and `X-BH-Site: <siteId>`.
- Errors follow the API convention `{ "error": { "code", "message", "fields?" } }`.
- Timeouts: 5 s interactive, 15 s background. Redirects are not followed.
- **No request is made before an administrator has given consent** (enforced in `Api_Client::request`).

## How the plugin detects "not shipped yet"

A `404`, `405` or `501` whose body is *not* a resource-level `not_found` (the API's route-not-found
handler answers `{"error":{"code":"not_found","message":"Route GET /v1/... not found"}}`) is treated
as **endpoint unavailable** (`branchharbor_endpoint_unavailable`). The plugin then falls back as
described per endpoint below. Proposal for the API: use a distinct code such as `route_not_found` for
unknown routes so clients don't need to parse the message.

## Direction vocabulary

The plugin shows directions from WordPress's point of view; the API's `connections.direction` is from
BranchHarbor's point of view.

| Plugin value | Label in WordPress | API `direction` |
|---|---|---|
| `to_bh` | WordPress → BranchHarbor | `import` |
| `from_bh` | BranchHarbor → WordPress | `export` |
| `both` | Two-way (shown as "later") | `bidirectional` |
| `off` | Don't sync | — |

Data types: `forms`, `locations`, `schedule`, `menu`, `woo_products`, `woo_orders`, `customers`
(customers is `off`; "import with review" is planned). SEO owner: `wordpress` (BranchHarbor-owned SEO
is shown as "later").

Note: the existing catalogue entry for `wordpress` (`apps/api/src/integrations/connectors.ts`) allows
only `export`, and `woocommerce` allows `import`/`bidirectional`. The plugin's WooCommerce export
(`to_bh`) maps to `woocommerce` + `import`, which is consistent.

---

## Endpoints that exist today

| Method & path | Used for | Auth |
|---|---|---|
| `GET /health` | "BranchHarbor can be reached" test | none |
| `GET /v1/public/locations/{orgSlug}?country=&q=&near=` | Location finder; location list for public-content-only connections; fallback for `GET /v1/connector/wordpress/site` | none |
| `GET /v1/public/studios/{locationId}/schedule?from=&to=` | Class schedule block (times UTC, location `timeZone` for display, `status`, `action`, `spotsLeft`) | none |
| `GET /v1/public/foods/{locationId}/menu` | Menu block (`categories[].items[]`, `price {amount, currency}` in minor units, `available`, `unavailableReason`, `dietary`) | none |
| `GET /v1/public/foods/{locationId}/pickup-slots` | Supported by the cache and invalidated by webhooks; no block renders slots yet (the pickup button links to the hosted order page) | none |
| `POST /v1/public/demo-requests` | Lead form with `target="demo_request"` (fields map 1:1 to `demoRequestSchema`) | none |

The authenticated org routes (`/v1/orgs/:orgId/connections…`) are used by the BranchHarbor app, not
by the plugin. The existing WordPress adapter probes `GET /wp-json/wp/v2/users/me` with an
Application Password; the plugin's optional "BranchHarbor Connector" role + Application Password flow
is compatible with that adapter.

---

## Proposed endpoints (plugin is built against these)

All proposed routes live under `/v1/connector/wordpress`. The site token is a **scoped, revocable**
credential bound to one `connections` row (provider `wordpress`), never a user's password.

### `POST /v1/connector/wordpress/exchange` — get a site token

Unauthenticated; the grant is the credential. Rate-limited.

Request (connection code):
```json
{
  "grantType": "connection_code",
  "code": "BHC-ABCD-EFGH-JKLM",
  "site": {
    "url": "https://example.com/", "restUrl": "https://example.com/wp-json/",
    "webhookUrl": "https://example.com/wp-json/branchharbor/v1/webhook",
    "name": "Stillwater Yoga", "timeZone": "America/Vancouver", "locale": "en_CA",
    "wpVersion": "7.1.3", "pluginVersion": "1.0.0", "multisite": false
  },
  "scopes": ["site.read", "locations.read", "content.read", "leads.write", "commerce.export", "webhooks.receive"]
}
```
Request (authorisation redirect, PKCE): same, with `"grantType": "authorization_code"`, `"code"` from
the redirect and `"codeVerifier"`.

Response `200`:
```json
{
  "siteId": "site_…",
  "siteToken": "bhst_…",
  "webhookSecret": "whsec_…",
  "scopes": ["site.read", "leads.write", "…"],
  "expiresAt": null,
  "organization": { "id": "uuid", "slug": "stillwater", "name": "Stillwater Yoga Collective" },
  "locations": [ { "id": "uuid", "name": "…", "slug": "…", "timeZone": "America/Toronto", "currency": "CAD",
                   "address": { "city": "Toronto" },
                   "links": { "booking": "https://…", "order": "https://…", "page": "https://…" } } ]
}
```
Errors: `400 invalid_code` (expired/used), `400 validation_failed`, `403 scope_not_allowed`.

Server notes: create/attach a `connections` row (`provider: wordpress`, `state: initial_sync`), store
the token hash only, store the webhook secret encrypted, audit `connection.created`. Codes are
single-use, expire after 15 minutes and are created in the app (Connections → WordPress → Create code).

**Fallback until shipped:** the Connect tab offers **Public content only** (org slug → existing public
endpoints). Location enquiries, WooCommerce export and webhooks need the full connection.

### Authorisation redirect (app, not API)

`GET https://app.branchharbor.com/connect/wordpress?client=wordpress&site_url=…&return_url=…&state=…&code_challenge=…&code_challenge_method=S256&scope=…&multisite=0|1`

The app signs the user in, lets them choose the organisation (and confirms the scopes), then
redirects to `return_url` with `?code=…&state=…` (or `?error=access_denied&state=…`). `return_url`
is the site's `wp-admin/admin-post.php?action=branchharbor_oauth_return`. The plugin verifies `state`
(bound to the admin user, 10-minute TTL) before exchanging.

### `GET /v1/connector/wordpress/site` — site record

Bearer token. Response:
```json
{
  "organization": { "id": "…", "slug": "…", "name": "…" },
  "locations": [ /* as in exchange */ ],
  "connection": { "state": "connected|initial_sync|degraded|disconnected|authorization_expired",
                  "affectedRecords": 0, "lastSuccessAt": "ISO-8601" },
  "scopes": ["…"]
}
```
`401/403` → plugin shows **Reconnect needed**. **Fallback:** `GET /v1/public/locations/{orgSlug}`.

### `PUT /v1/connector/wordpress/site` — report configuration

Bearer token. Body:
```json
{
  "mapping": [ { "siteUrl": "https://example.com/", "blogId": 1, "target": "org|none|<locationId>", "timeZone": "America/Vancouver" } ],
  "directions": { "forms": { "direction": "to_bh", "apiDirection": "import" }, "…": {} },
  "seoOwner": "wordpress",
  "compatibility": [ { "key": "woocommerce", "version": "11.2.1", "status": "tested" } ],
  "pluginVersion": "1.0.0"
}
```
Server should validate location ids against the org, upsert `external_mappings` (`entityType:
location`) and mark timezone mismatches as `error` (same rule as the plugin: offsets must match in
January and July). **Fallback:** ignored; mapping is enforced locally.

### `DELETE /v1/connector/wordpress/site` — revoke

Bearer token. Revokes the token, clears credentials (same effect as `DELETE /v1/orgs/:orgId/connections/:id`),
audit `connection.disconnected`. **Fallback:** the plugin forgets the token locally regardless.

### `POST /v1/connector/wordpress/test-event` — deliver a test webhook

Bearer token. BranchHarbor delivers a signed `connection.ping` event to the site's `webhookUrl`
**before responding**, then returns `{ "delivered": true, "status": 200 }` (or `delivered: false` with
the HTTP status it received). **Fallback:** the plugin's loopback self-check still detects cache and
security plugins blocking the route.

### `POST /v1/connector/wordpress/leads` — location enquiry

Bearer token, `Idempotency-Key: <sha256>` (same person + form + location + message within a 10-minute
window → same key). Body:
```json
{
  "formId": "enquiry",
  "locationId": "uuid",
  "source": "wordpress",
  "pageUrl": "https://example.com/contact/",
  "contact": { "name": "Ada Lovelace", "email": "ada@example.com", "phone": "+1…" },
  "message": "…",
  "consent": { "marketing": true, "text": "Send me occasional news…" }
}
```
Responses: `201 { "id": "lead_…" }`; `200` with the original lead for a repeated key; `409` is
treated as "already received"; `400/422` → visitor sees "could not be sent"; `401/403/5xx/timeout`
→ queued on the site and retried hourly for up to 7 days.

Server notes: verify `locationId` belongs to the token's organisation and is mapped to this site;
reuse the customer find-or-create/dedup logic (ambiguous identities → review); write a
`consent_records` row when `consent.marketing` is true; store the idempotency key for ≥24 h.
**Fallback:** enquiries are queued locally (and delivered when the endpoint appears).

### `POST /v1/connector/wordpress/events` — WooCommerce export batch

Bearer token, `Idempotency-Key` (hash of the event ids). Body `{ "events": [ … ] }`, ≤50 per batch:
```json
{ "id": "wc.order.123.1760450000", "type": "woocommerce.order.upserted", "occurredAt": "ISO-8601",
  "data": { "externalId": "123", "number": "123", "status": "processing", "currency": "CAD",
            "total": 3998, "subtotal": 3998, "tax": 0, "shipping": 0, "discount": 0, "refunded": 0,
            "createdVia": "checkout", "createdAt": "…", "modifiedAt": "…", "paidAt": null,
            "items": [ { "productId": "45", "variationId": null, "sku": "MAT-1", "name": "Mat", "quantity": 2, "total": 3998 } ],
            "customer": { "registered": false }, "siteTarget": "<locationId|org>" } }
```
Other types: `woocommerce.product.upserted` (`externalId, parentId, type, status, sku, name,
price {amount, currency}, manageStock, stock, stockStatus, variations[], modifiedAt`),
`woocommerce.order.deleted`, `woocommerce.product.deleted` (`{ externalId }` tombstones).
Money is integer minor units + ISO currency; times are UTC. **No customer PII is sent.**

Response `202 { "accepted": n }`. Server: dedupe by event `id`, upsert `external_mappings`
(provider `woocommerce`/`wordpress`), never write back to WooCommerce.
**Fallback:** ids stay in the site's pending list (status shows "records waiting"); hourly retry.

---

## WordPress → called by BranchHarbor

### Webhook: `POST {site}/wp-json/branchharbor/v1/webhook`

Headers:
- `X-BH-Event-Id`: unique id (1–128 chars `[A-Za-z0-9_.:-]`); must equal body `id` if present.
- `X-BH-Timestamp`: unix seconds; rejected if more than 300 s from the site's clock.
- `X-BH-Signature`: `v1=<hex HMAC-SHA256(webhookSecret, "<timestamp>.<raw body>")>`; several
  comma-separated `v1=` values are accepted during secret rotation.

Body: `{ "id": "evt_…", "type": "…", "data": { … } }`

| type | data | Plugin effect |
|---|---|---|
| `schedule.updated` | `locationId?` | Mark cached schedules stale (refreshed in background; last good copy stays visible) |
| `menu.updated` | `locationId?` | Mark menus + pickup slots stale |
| `pickup_slots.updated` | `locationId?` | Mark pickup slots stale |
| `locations.updated` | — | Mark location list stale; refresh site record |
| `connection.state_changed` | `state, affectedRecords?, message?` | Update status panel |
| `connection.revoked` | — | Forget credentials; status → Reconnect needed |
| `connection.ping` | — | Record receipt (used by the test) |
| anything else | — | Acknowledged and ignored |

Responses: `200 {"received":true,"duplicate":false|true}`; `401` bad/missing signature, stale
timestamp or not connected; `400` malformed; `500` handler failure (the idempotency claim is released
so a retry is processed). Idempotency: event ids are claimed atomically with `add_option` (unique
`option_name`) and kept 7 days. Events never write posts, users or other plugins' settings. After
applying, the plugin fires `do_action( 'branchharbor_event', $type, $locationId )` for cache-plugin
purges.

### Read-only pull (optional, Application Password)

Basic auth with a user that has the `branchharbor_sync` capability (role "BranchHarbor Connector").

- `GET /wp-json/branchharbor/v1/site` → site URL, name, time zone, locale, versions, mapping,
  directions, SEO owner, WooCommerce version + HPOS flag, last compatibility scan.
- `GET /wp-json/branchharbor/v1/woocommerce/orders?modified_after=ISO&page=&per_page=≤100`
- `GET /wp-json/branchharbor/v1/woocommerce/products?modified_after=ISO&page=&per_page=≤100`

→ `{ "items": [ … same payloads as events.data … ], "page": 1, "hasMore": true }`. `403` when that
export direction is turned off on the site.

### Front-end render route (public)

`GET /wp-json/branchharbor/v1/render/{block}?<attributes>` → `{ "html": "…" }`. Used by the site's own
front-end script to refresh blocks behind page caches. Only locations of the connected organisation
are accepted; others fall back to the site's mapped location.

---

## Hosted pages linked from blocks

`locations[].links` (from exchange/site) may contain `booking`, `order` and `page`. The Class schedule
block appends `?occurrence=<occurrenceId>` to `links.booking`. When links are absent, buttons are
hidden for visitors and editors see a hint (a custom URL can be set per block). These hosted pages do
not exist yet in `apps/sites`/`apps/web`; their URL shape is up to the hosted-sites work.
