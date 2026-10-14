# Architecture

```
            branchharbor.com           app.branchharbor.com         iOS / Android
           ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
           │  apps/web    │           │  apps/app    │           │ apps/mobile  │
           │  Next.js     │           │  Next.js     │           │ Expo         │
           └──────┬───────┘           └──────┬───────┘           └──────┬───────┘
                  │  demo requests            │ cookie session          │ bearer token
                  └──────────────┬────────────┴─────────────┬───────────┘
                                 ▼                          ▼
                        ┌─────────────────────────────────────────┐
                        │ apps/api — Fastify /v1 (OpenAPI /docs)  │
                        │ auth · RBAC scopes · audit · webhooks   │
                        └───┬───────────┬───────────┬─────────────┘
                            │           │           │
                      Postgres      Redis/BullMQ   Provider adapters
                   (per data region)  (jobs)      Stripe · Cloudflare · Postmark ·
                                                  Twilio · WhatsApp · Anthropic · Maps ·
                                                  Mindbody · WooCommerce · Shopify · Toast …
```

## Principles (from the spec)

- **Tenancy**: organisation → regions → owner groups → locations. Every tenant row carries `organization_id`, and location-scoped rows carry `location_id`. No cross-organisation access.
- **Permissions are enforced server-side.** Clients only hide controls. Org-level assignments cover all of the org's locations. A location assignment covers only that location. Removing an assignment revokes access immediately.
- **Money**: integer minor units plus an ISO 4217 currency. Never sum across currencies without a disclosed conversion. Reports return per-currency totals.
- **Time**: stored in UTC and presented in the location's IANA timezone. Recurrence respects the location timezone and DST.
- **Unknown is not zero.** Metrics that are missing or come from a disconnected source return `null` and render as "Unavailable" or "Not connected".
- **Idempotency**: provider webhooks are deduplicated by event ID. Sync retries never create duplicates.
- **Source of truth**: each connection declares direction (import / export / bidirectional) and who the authoritative writer is.
- **AI** reads only authorised data and *proposes* actions. Execution needs explicit approval through normal, validated endpoints. Imported content is treated as untrusted. Staff can do all core work while AI is down.
- **International**: locale per user and per location, launch countries in `packages/shared/src/locale.ts`, and a data region (`us` / `eu` / `apac`) per organisation.

## Delivery models

Hosted site, WordPress connector, or a connection to an existing system. All three share the same business records and permissions.
