/**
 * Square (developer.squareup.com, retrieved 2026-10):
 *  - OAuth code flow: GET {base}/oauth2/authorize?client_id&scope=ORDERS_READ+PAYMENTS_READ+MERCHANT_PROFILE_READ&session=false&state
 *    → POST {base}/oauth2/token { client_id, client_secret, code, grant_type: "authorization_code", redirect_uri }
 *    → { access_token, refresh_token, expires_at, merchant_id }. Refresh: same endpoint, grant_type "refresh_token".
 *  - Locations: GET /v2/locations → { locations: [{ id, name, currency, timezone }] }.
 *  - Orders: POST /v2/orders/search { location_ids, cursor, limit, query: { filter: { state_filter: { states: ["COMPLETED"] },
 *    date_time_filter: { closed_at: { start_at, end_at } } }, sort: { sort_field: "CLOSED_AT", sort_order: "ASC" } } }
 *    → { orders: [{ id, closed_at, source: { name }, total_money, total_tax_money, total_tip_money, total_discount_money,
 *    return_amounts: { total_money, tax_money, tip_money }, fulfillments: [{ type: PICKUP | SHIPMENT | DELIVERY }] }], cursor }.
 *    Money is { amount (minor units), currency }. Refunds of an earlier sale arrive as a separate order with `returns`.
 *  - Every call sends the `Square-Version` header. Sandbox host connect.squareupsandbox.com.
 */
import type { SalesChannel } from '@bh/shared';
import type { Config } from '../../config.ts';
import { requestJson } from '../partners/http.ts';
import { sale, str, toDate, type SaleRecord, type SalesAdapter } from './types.ts';

export const SQUARE_VERSION = '2025-07-16';
const base = (cfg: Config) => (cfg.SQUARE_ENVIRONMENT === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com');
type Money = { amount?: number; currency?: string } | undefined;
const amt = (m: Money) => Number(m?.amount ?? 0);

interface SquareOrder {
  id: string; closed_at?: string; created_at?: string; source?: { name?: string };
  total_money?: Money; total_tax_money?: Money; total_tip_money?: Money; total_discount_money?: Money;
  return_amounts?: { total_money?: Money; tax_money?: Money; tip_money?: Money };
  fulfillments?: Array<{ type?: string }>;
}

function channelOf(o: SquareOrder): SalesChannel {
  const t = o.fulfillments?.[0]?.type;
  if (t === 'DELIVERY') return 'delivery';
  if (t === 'SHIPMENT' || t === 'PICKUP' || /online|website|ecom/i.test(o.source?.name ?? '')) return 'online';
  return 'in_store';
}

/** One Square order → sale record. Returns are reported on the order that carries them. */
export function squareOrderToSale(o: SquareOrder, fallbackCurrency: string): SaleRecord {
  const currency = o.total_money?.currency ?? o.return_amounts?.total_money?.currency ?? fallbackCurrency;
  return sale({
    at: toDate(o.closed_at ?? o.created_at), channel: channelOf(o), currency,
    // total_money is the sale side; return_amounts the money given back. Tax and tips returned are no longer owed.
    grossMinor: amt(o.total_money),
    refundsMinor: amt(o.return_amounts?.total_money),
    taxMinor: amt(o.total_tax_money) - amt(o.return_amounts?.tax_money),
    tipsMinor: amt(o.total_tip_money) - amt(o.return_amounts?.tip_money),
    discountsMinor: amt(o.total_discount_money),
    orders: amt(o.total_money) > 0 ? 1 : 0,
  });
}

export const squareAdapter: SalesAdapter = {
  provider: 'square',
  platformReady: (cfg) => !!(cfg.SQUARE_APPLICATION_ID && cfg.SQUARE_APPLICATION_SECRET),
  authorizeUrl(cfg, a) {
    const q = new URLSearchParams({ client_id: cfg.SQUARE_APPLICATION_ID ?? '', scope: 'ORDERS_READ PAYMENTS_READ MERCHANT_PROFILE_READ', session: 'false', state: a.state, redirect_uri: a.redirectUri });
    return `${base(cfg)}/oauth2/authorize?${q.toString()}`;
  },
  async exchangeCode(cfg, f, a) {
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; expires_at?: string; merchant_id?: string }>('Square', f, `${base(cfg)}/oauth2/token`, {
      headers: { 'Square-Version': SQUARE_VERSION },
      body: { client_id: cfg.SQUARE_APPLICATION_ID, client_secret: cfg.SQUARE_APPLICATION_SECRET, code: a.code, grant_type: 'authorization_code', redirect_uri: a.redirectUri },
    });
    return { creds: { accessToken: data.access_token, refreshToken: data.refresh_token ?? '', expiresAt: data.expires_at ?? '' }, config: { merchantId: data.merchant_id ?? null } };
  },
  async refresh(cfg, f, creds, _config, now) {
    if (!creds.refreshToken || !creds.expiresAt || Date.parse(creds.expiresAt) - now > 7 * 86_400_000) return null;
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; expires_at?: string }>('Square', f, `${base(cfg)}/oauth2/token`, {
      headers: { 'Square-Version': SQUARE_VERSION },
      body: { client_id: cfg.SQUARE_APPLICATION_ID, client_secret: cfg.SQUARE_APPLICATION_SECRET, refresh_token: creds.refreshToken, grant_type: 'refresh_token' },
    });
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? creds.refreshToken, expiresAt: data.expires_at ?? '' };
  },
  async listLocations(cfg, f, creds) {
    const { data } = await requestJson<{ locations?: Array<{ id: string; name: string; currency?: string; timezone?: string }> }>('Square', f, `${base(cfg)}/v2/locations`, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'Square-Version': SQUARE_VERSION },
    });
    return (data.locations ?? []).map((l) => ({ id: l.id, name: l.name, currency: l.currency ?? null, timeZone: l.timezone ?? null }));
  },
  async fetchSales(cfg, f, input) {
    const locationId = str(input.config.externalLocationId);
    if (!locationId) throw new Error('Choose the Square location for this BranchHarbor location');
    const out: SaleRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const { data } = await requestJson<{ orders?: SquareOrder[]; cursor?: string }>('Square', f, `${base(cfg)}/v2/orders/search`, {
        headers: { Authorization: `Bearer ${input.creds.accessToken}`, 'Square-Version': SQUARE_VERSION },
        body: {
          location_ids: [locationId], limit: 500, ...(cursor ? { cursor } : {}),
          query: { filter: { state_filter: { states: ['COMPLETED'] }, date_time_filter: { closed_at: { start_at: input.fromUtc.toISOString(), end_at: input.toUtc.toISOString() } } }, sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' } },
        },
      });
      for (const o of data.orders ?? []) out.push(squareOrderToSale(o, input.currency));
      if (!data.cursor) break;
      cursor = data.cursor;
    }
    return out;
  },
};
