/**
 * Uber Direct (Delivery-as-a-Service) client.
 *
 * Documented shapes used (developer.uber.com/docs/deliveries):
 *  - OAuth 2.0 client credentials: POST https://auth.uber.com/oauth/v2/token (form: client_id, client_secret,
 *    grant_type=client_credentials, scope=eats.deliveries) → { access_token, expires_in, token_type }. Tokens are
 *    long-lived (30 days); we cache per client id and refresh 60 s before expiry.
 *  - Quote:  POST https://api.uber.com/v1/customers/{customer_id}/delivery_quotes → { id: "dqt_…", fee, currency, expires, duration, dropoff_eta }
 *  - Create: POST https://api.uber.com/v1/customers/{customer_id}/deliveries → { id: "del_…", status, tracking_url, fee, currency, … }
 *  - Cancel: POST https://api.uber.com/v1/customers/{customer_id}/deliveries/{delivery_id}/cancel
 *  - Webhooks: `event.delivery_status` / `event.courier_update`, signed with HMAC-SHA256 (hex) of the raw body
 *    using the account's webhook signing key, header `x-uber-signature` (legacy `x-postmates-signature`).
 *  - Delivery statuses: pending, pickup, pickup_complete, dropoff, delivered, canceled, returned.
 *
 * ASSUMPTIONS (verify against the live API reference during partner onboarding):
 *  - Addresses are sent as the JSON-encoded structured form {street_address[], city, state, zip_code, country}.
 *  - `external_id` carries our delivery id and `idempotency_key` makes create safe to retry.
 *  - Amounts (`fee`, `manifest_total_value`) are integer minor units of the account currency.
 */
import { PartnerHttpError, requestJson, TokenCache, verifyHmacHex, type FetchLike } from './http.ts';

export const UBER_DIRECT_DEFAULT_AUTH_URL = 'https://auth.uber.com/oauth/v2/token';
export const UBER_DIRECT_DEFAULT_API_URL = 'https://api.uber.com';

/**
 * Countries where Uber Direct is offered (public availability as of 2026; Uber decides per account, so a quote can
 * still be refused). Overridable with UBER_DIRECT_COUNTRIES. Outside these we fall back to own drivers.
 */
export const UBER_DIRECT_COUNTRIES = ['US', 'CA', 'MX', 'GB', 'IE', 'FR', 'BE', 'NL', 'ES', 'PT', 'AU', 'NZ', 'JP', 'TW', 'BR', 'CL', 'CO', 'CR', 'PE'];

export type UberStatus = 'pending' | 'pickup' | 'pickup_complete' | 'dropoff' | 'delivered' | 'canceled' | 'returned';
export type OurDeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivered' | 'failed' | 'cancelled';

/** Uber status → our delivery state (food order follows: picked_up → out_for_delivery, delivered → delivered). */
export const UBER_STATUS_MAP: Record<UberStatus, OurDeliveryStatus> = {
  pending: 'pending',
  pickup: 'assigned',
  pickup_complete: 'picked_up',
  dropoff: 'picked_up',
  delivered: 'delivered',
  canceled: 'cancelled',
  returned: 'failed',
};

export interface UberCredentials { clientId: string; clientSecret: string; customerId: string; webhookSigningKey?: string }
export interface UberAddress { line1: string; line2?: string | null; city: string; region?: string | null; postalCode?: string | null; country: string }
export interface UberQuoteInput {
  pickup: { address: UberAddress; phone: string | null; lat?: number | null; lng?: number | null };
  dropoff: { address: UberAddress; phone: string | null; lat?: number | null; lng?: number | null };
  pickupReadyAt: Date;
  dropoffDeadlineAt?: Date | null;
  valueMinor: number;
  externalStoreId?: string;
}
export interface UberCreateInput extends UberQuoteInput {
  quoteId?: string | null;
  externalId: string;
  pickupName: string;
  dropoffName: string;
  items: Array<{ name: string; quantity: number; priceMinor: number }>;
  notes?: string | null;
}
export interface UberDelivery { id: string; status: UberStatus; trackingUrl: string | null; feeMinor: number | null; currency: string | null; liveMode: boolean | null; raw: Record<string, unknown> }

const sharedTokens = new TokenCache();

const addr = (a: UberAddress) => JSON.stringify({ street_address: [a.line1, a.line2].filter(Boolean), city: a.city, state: a.region ?? '', zip_code: a.postalCode ?? '', country: a.country });
const iso = (d: Date) => d.toISOString();

export function createUberDirectClient(opts: { creds: UberCredentials; fetch: FetchLike; authUrl?: string; apiUrl?: string; now?: () => number; tokens?: TokenCache }) {
  const { creds } = opts;
  const now = opts.now ?? Date.now;
  const tokens = opts.tokens ?? sharedTokens;
  const api = (opts.apiUrl ?? UBER_DIRECT_DEFAULT_API_URL).replace(/\/$/, '');
  const base = `${api}/v1/customers/${encodeURIComponent(creds.customerId)}`;

  async function token(): Promise<string> {
    const key = `uber:${creds.clientId}`;
    const hit = tokens.get(key, now());
    if (hit) return hit;
    const { data } = await requestJson<{ access_token: string; expires_in: number }>('Uber Direct', opts.fetch, opts.authUrl ?? UBER_DIRECT_DEFAULT_AUTH_URL, {
      form: { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials', scope: 'eats.deliveries' },
    });
    if (!data.access_token) throw new PartnerHttpError('Uber Direct', 502, 'Uber Direct did not return an access token');
    tokens.set(key, data.access_token, now() + (data.expires_in ?? 3600) * 1000);
    return data.access_token;
  }

  async function call<T>(path: string, body?: unknown, method = 'POST') {
    const t = await token();
    try {
      return (await requestJson<T>('Uber Direct', opts.fetch, `${base}${path}`, { method, body, headers: { Authorization: `Bearer ${t}` } })).data;
    } catch (err) {
      // A revoked/expired token: drop it so the next call re-authenticates.
      if (err instanceof PartnerHttpError && err.status === 401) tokens.clear(`uber:${creds.clientId}`);
      throw err;
    }
  }

  const quoteBody = (i: UberQuoteInput) => ({
    pickup_address: addr(i.pickup.address), dropoff_address: addr(i.dropoff.address),
    ...(i.pickup.lat != null && i.pickup.lng != null ? { pickup_latitude: i.pickup.lat, pickup_longitude: i.pickup.lng } : {}),
    ...(i.dropoff.lat != null && i.dropoff.lng != null ? { dropoff_latitude: i.dropoff.lat, dropoff_longitude: i.dropoff.lng } : {}),
    pickup_ready_dt: iso(i.pickupReadyAt),
    ...(i.dropoffDeadlineAt ? { dropoff_deadline_dt: iso(i.dropoffDeadlineAt) } : {}),
    pickup_phone_number: i.pickup.phone ?? undefined, dropoff_phone_number: i.dropoff.phone ?? undefined,
    manifest_total_value: i.valueMinor,
    ...(i.externalStoreId ? { external_store_id: i.externalStoreId } : {}),
  });

  const toDelivery = (d: Record<string, unknown>): UberDelivery => ({
    id: String(d.id), status: (d.status as UberStatus) ?? 'pending', trackingUrl: safeUrl(d.tracking_url),
    feeMinor: typeof d.fee === 'number' ? d.fee : null, currency: typeof d.currency === 'string' ? d.currency.toUpperCase() : null,
    liveMode: typeof d.live_mode === 'boolean' ? d.live_mode : null, raw: d,
  });

  return {
    token,
    /** Validates credentials by obtaining a token (no delivery is created). */
    async test() { await token(); return { ok: true as const }; },
    async quote(i: UberQuoteInput) {
      const d = await call<Record<string, unknown>>('/delivery_quotes', quoteBody(i));
      return {
        id: String(d.id), feeMinor: Number(d.fee ?? 0), currency: String(d.currency_type ?? d.currency ?? '').toUpperCase(),
        expiresAt: typeof d.expires === 'string' ? d.expires : null, etaMinutes: typeof d.duration === 'number' ? d.duration : null,
        dropoffEta: typeof d.dropoff_eta === 'string' ? d.dropoff_eta : null,
      };
    },
    async createDelivery(i: UberCreateInput) {
      const d = await call<Record<string, unknown>>('/deliveries', {
        ...quoteBody(i),
        ...(i.quoteId ? { quote_id: i.quoteId } : {}),
        pickup_name: i.pickupName, dropoff_name: i.dropoffName,
        manifest_items: i.items.map((x) => ({ name: x.name, quantity: x.quantity, price: x.priceMinor, size: 'small' })),
        external_id: i.externalId, idempotency_key: i.externalId,
        ...(i.notes ? { dropoff_notes: i.notes.slice(0, 280) } : {}),
      });
      return toDelivery(d);
    },
    async getDelivery(id: string) { return toDelivery(await call<Record<string, unknown>>(`/deliveries/${encodeURIComponent(id)}`, undefined, 'GET')); },
    async cancel(id: string) { return toDelivery(await call<Record<string, unknown>>(`/deliveries/${encodeURIComponent(id)}/cancel`, {})); },
  };
}
export type UberDirectClient = ReturnType<typeof createUberDirectClient>;

/** Only https tracking links are passed on to customer pages. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try { const u = new URL(v); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

export function verifyUberSignature(raw: Buffer | string, headers: Record<string, unknown>, signingKey: string): boolean {
  const sig = (headers['x-uber-signature'] ?? headers['x-postmates-signature']) as string | undefined;
  return verifyHmacHex(signingKey, raw, sig);
}

export interface UberWebhookEvent { id: string; kind: string; deliveryId: string | null; status: UberStatus | null; customerId: string | null; trackingUrl: string | null; liveMode: boolean | null; externalId: string | null; courierName: string | null }

export function parseUberWebhook(body: Record<string, unknown>): UberWebhookEvent {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const courier = (data.courier ?? {}) as Record<string, unknown>;
  return {
    id: String(body.id ?? ''), kind: String(body.kind ?? ''), deliveryId: (body.delivery_id ?? data.id ?? null) as string | null,
    status: (body.status ?? data.status ?? null) as UberStatus | null, customerId: (body.customer_id ?? null) as string | null,
    trackingUrl: safeUrl(data.tracking_url), liveMode: typeof body.live_mode === 'boolean' ? body.live_mode : null,
    externalId: (data.external_id ?? null) as string | null, courierName: typeof courier.name === 'string' ? courier.name : null,
  };
}

export function uberAvailableIn(country: string, override?: string): boolean {
  const list = override ? override.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : UBER_DIRECT_COUNTRIES;
  return list.includes(country.toUpperCase());
}
