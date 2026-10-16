/**
 * Shopify Admin REST API (shopify.dev, version 2025-07, retrieved 2026-10).
 *  - OAuth (authorization code grant): https://{shop}/admin/oauth/authorize?client_id&scope=read_orders,read_locations&redirect_uri&state
 *    → POST https://{shop}/admin/oauth/access_token { client_id, client_secret, code } → { access_token, scope } (offline token).
 *    The callback's `hmac` query parameter is verified with the app secret before the code is exchanged.
 *  - Locations: GET /admin/api/2025-07/locations.json → { locations: [{ id, name }] }.
 *  - Orders: GET /admin/api/2025-07/orders.json?status=any&processed_at_min&processed_at_max&limit=250&since_id → { orders: [{
 *    id, processed_at, currency, total_price, total_tax, total_tip_received, total_discounts, cancelled_at, source_name (web | pos | …),
 *    location_id, refunds: [{ created_at, transactions: [{ kind, status, amount }], refund_line_items: [{ total_tax }] }] }] }.
 *    Amounts are decimal strings in the shop currency. Orders older than 60 days need the read_all_orders scope.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { decimalToMinor, type SalesChannel } from '@bh/shared';
import { PartnerHttpError, requestJson } from '../partners/http.ts';
import { sale, str, toDate, type SaleRecord, type SalesAdapter } from './types.ts';

export const SHOPIFY_API_VERSION = '2025-07';
const shopOf = (config: Record<string, unknown>) => {
  const s = str(config.shopDomain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) throw new PartnerHttpError('Shopify', 400, 'Enter the shop’s myshopify.com domain');
  return s;
};

/** Verifies Shopify's callback `hmac` (hex HMAC-SHA256 of the sorted query without `hmac`). */
export function verifyShopifyHmac(secret: string, query: Record<string, string>): boolean {
  const { hmac, signature: _sig, ...rest } = query;
  if (!hmac || !secret) return false;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  const expected = Buffer.from(createHmac('sha256', secret).update(msg).digest('hex'));
  const got = Buffer.from(hmac.toLowerCase());
  return expected.length === got.length && timingSafeEqual(expected, got);
}

interface ShopifyRefund { created_at?: string; transactions?: Array<{ kind?: string; status?: string; amount?: string }>; refund_line_items?: Array<{ total_tax?: string | number }> }
interface ShopifyOrder {
  id: number; processed_at?: string; created_at?: string; currency?: string; total_price?: string; total_tax?: string; total_tip_received?: string; total_discounts?: string;
  cancelled_at?: string | null; source_name?: string; location_id?: number | null; refunds?: ShopifyRefund[];
}

const channelOf = (o: ShopifyOrder): SalesChannel => (o.source_name === 'pos' ? 'in_store' : o.source_name === 'web' || o.source_name === 'shopify_draft_order' || o.source_name === 'android' || o.source_name === 'iphone' ? 'online' : 'other');

/** One order → the sale, plus one record per refund on the refund's own date. Cancelled unpaid orders are skipped. */
export function shopifyOrderToSales(o: ShopifyOrder, fallbackCurrency: string): SaleRecord[] {
  const currency = o.currency ?? fallbackCurrency;
  const m = (v: unknown) => decimalToMinor(v ?? 0, currency) ?? 0;
  const out: SaleRecord[] = [];
  const channel = channelOf(o);
  const gross = m(o.total_price);
  if (!(o.cancelled_at && !(o.refunds ?? []).length)) {
    out.push(sale({ at: toDate(o.processed_at ?? o.created_at), channel, currency, grossMinor: gross, taxMinor: m(o.total_tax), tipsMinor: m(o.total_tip_received), discountsMinor: m(o.total_discounts), orders: 1 }));
  }
  for (const r of o.refunds ?? []) {
    const amount = (r.transactions ?? []).filter((t) => t.kind === 'refund' && (t.status ?? 'success') === 'success').reduce((a, t) => a + m(t.amount), 0);
    if (!amount) continue;
    const tax = (r.refund_line_items ?? []).reduce((a, li) => a + m(li.total_tax), 0);
    out.push(sale({ at: toDate(r.created_at), channel, currency, refundsMinor: amount, taxMinor: -tax, orders: 0 }));
  }
  return out;
}

export const shopifyAdapter: SalesAdapter = {
  provider: 'shopify',
  platformReady: (cfg) => !!(cfg.SHOPIFY_API_KEY && cfg.SHOPIFY_API_SECRET),
  authorizeUrl(cfg, a) {
    const q = new URLSearchParams({ client_id: cfg.SHOPIFY_API_KEY ?? '', scope: 'read_orders,read_all_orders,read_locations', redirect_uri: a.redirectUri, state: a.state });
    return `https://${shopOf(a.config)}/admin/oauth/authorize?${q.toString()}`;
  },
  async exchangeCode(cfg, f, a) {
    if (!verifyShopifyHmac(cfg.SHOPIFY_API_SECRET ?? '', a.query)) throw new PartnerHttpError('Shopify', 401, 'The Shopify callback signature did not verify');
    const shop = shopOf({ shopDomain: a.query.shop ?? a.config.shopDomain });
    const { data } = await requestJson<{ access_token: string; scope?: string }>('Shopify', f, `https://${shop}/admin/oauth/access_token`, {
      body: { client_id: cfg.SHOPIFY_API_KEY, client_secret: cfg.SHOPIFY_API_SECRET, code: a.code },
    });
    return { creds: { accessToken: data.access_token }, config: { shopDomain: shop, scope: data.scope ?? null }, accountName: shop };
  },
  async listLocations(cfg, f, creds, config) {
    const { data } = await requestJson<{ locations?: Array<{ id: number; name: string }> }>('Shopify', f, `https://${shopOf(config)}/admin/api/${SHOPIFY_API_VERSION}/locations.json`, { headers: { 'X-Shopify-Access-Token': creds.accessToken ?? '' } });
    return (data.locations ?? []).map((l) => ({ id: String(l.id), name: l.name }));
  },
  async fetchSales(cfg, f, input) {
    const shop = shopOf(input.config);
    const only = str(input.config.externalLocationId);
    const includeOnline = input.config.includeOnline !== false;
    const out: SaleRecord[] = [];
    let since = '0';
    for (let page = 0; page < 400; page++) {
      const q = new URLSearchParams({ status: 'any', processed_at_min: input.fromUtc.toISOString(), processed_at_max: input.toUtc.toISOString(), limit: '250', since_id: since });
      const { data } = await requestJson<{ orders?: ShopifyOrder[] }>('Shopify', f, `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${q.toString()}`, { headers: { 'X-Shopify-Access-Token': input.creds.accessToken ?? '' } });
      const orders = data.orders ?? [];
      for (const o of orders) {
        if (only && String(o.location_id ?? '') !== only && !(includeOnline && !o.location_id)) continue;
        out.push(...shopifyOrderToSales(o, input.currency));
      }
      if (orders.length < 250) break;
      since = String(orders[orders.length - 1]!.id);
    }
    return out;
  },
};
