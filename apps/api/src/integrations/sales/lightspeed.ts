/**
 * Lightspeed (developers.lightspeedhq.com, retrieved 2026-10). Two products, chosen per connection (`config.series`):
 *
 * Retail X-Series (formerly Vend):
 *  - OAuth: https://secure.retail.lightspeed.app/connect?response_type=code&client_id&redirect_uri&state; the callback adds
 *    `domain_prefix`. Token: POST https://{prefix}.retail.lightspeed.app/api/1.0/token (form: code, client_id, client_secret,
 *    grant_type=authorization_code, redirect_uri) → { access_token, refresh_token, expires, domain_prefix }.
 *  - Outlets: GET /api/2.0/outlets → { data: [{ id, name }] }.
 *  - Sales: GET /api/2.0/search?type=sales&date_from&date_to&outlet_id&page_size=1000&offset → { data: [{ id, outlet_id, sale_date,
 *    status, total_price (tax exclusive), total_tax, line_items: [{ discount_total }] }] }. Returns are sales with negative totals;
 *    VOIDED sales are skipped. Amounts are decimal in the retailer currency.
 *
 * Restaurant K-Series:
 *  - OAuth: {host}/oauth/authorize?response_type=code&client_id&scope=financial-api&redirect_uri&state; token: POST {host}/oauth/token
 *    (form, HTTP Basic client credentials) → { access_token, refresh_token, expires_in }. Hosts: https://api.trial.lsk.lightspeed.app
 *    (trial) and https://api.lsk.lightspeed.app (production).
 *  - Business locations: GET /f/data/businesses → [{ businessName, businessLocations: [{ blId, blName }] }].
 *  - Financials: GET /f/finance/{blId}/financials/{fromIso}/{toIso} → { sales: [{ receiptId, timeClosed, cancelled, type: SALE | REFUND,
 *    salesLines: [{ totalNetAmountWithTax, taxAmount, discountAmount }], payments: [{ netAmountWithTax, tip }], deliveryType }] }.
 *
 * ASSUMPTIONS (confirm during partner onboarding): the K-Series financials field names above and the X-Series search
 * `status` values (CLOSED, ONACCOUNT_CLOSED, LAYBY_CLOSED, VOIDED).
 */
import { decimalToMinor } from '@bh/shared';
import type { Config } from '../../config.ts';
import { PartnerHttpError, requestJson, type FetchLike } from '../partners/http.ts';
import { sale, str, toDate, type SaleRecord, type SalesAdapter } from './types.ts';

const kHost = (cfg: Config) => (cfg.LIGHTSPEED_K_ENVIRONMENT === 'production' ? 'https://api.lsk.lightspeed.app' : 'https://api.trial.lsk.lightspeed.app');
const xHost = (prefix: string) => {
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new PartnerHttpError('Lightspeed', 400, 'Lightspeed did not return a store domain prefix');
  return `https://${prefix}.retail.lightspeed.app`;
};
const series = (config: Record<string, unknown>) => (config.series === 'k_series' ? 'k_series' : 'x_series');

interface XSale { id: string; sale_date?: string; status?: string; outlet_id?: string; total_price?: number | string; total_tax?: number | string; line_items?: Array<{ discount_total?: number | string }> }
export function lightspeedXSaleToRecord(s: XSale, currency: string): SaleRecord | null {
  if (s.status === 'VOIDED' || s.status === 'SAVED' || s.status === 'OPEN') return null;
  const m = (v: unknown) => decimalToMinor(v ?? 0, currency) ?? 0;
  const total = m(s.total_price) + m(s.total_tax);
  const disc = (s.line_items ?? []).reduce((a, li) => a + m(li.discount_total), 0);
  if (total < 0) return sale({ at: toDate(s.sale_date), currency, refundsMinor: -total, taxMinor: m(s.total_tax), orders: 0 });
  return sale({ at: toDate(s.sale_date), currency, grossMinor: total, taxMinor: m(s.total_tax), discountsMinor: disc, orders: 1 });
}

interface KSale { receiptId?: string; timeClosed?: string; cancelled?: boolean; type?: string; deliveryType?: string; salesLines?: Array<{ totalNetAmountWithTax?: number | string; taxAmount?: number | string; discountAmount?: number | string }>; payments?: Array<{ netAmountWithTax?: number | string; tip?: number | string }> }
export function lightspeedKSaleToRecord(s: KSale, currency: string): SaleRecord | null {
  if (s.cancelled) return null;
  const m = (v: unknown) => decimalToMinor(v ?? 0, currency) ?? 0;
  const lines = s.salesLines ?? [];
  const total = lines.reduce((a, l) => a + m(l.totalNetAmountWithTax), 0);
  const tax = lines.reduce((a, l) => a + m(l.taxAmount), 0);
  const disc = lines.reduce((a, l) => a + m(l.discountAmount), 0);
  const tips = (s.payments ?? []).reduce((a, p) => a + m(p.tip), 0);
  const channel = /deliver/i.test(s.deliveryType ?? '') ? 'delivery' as const : /online|takeaway_online|web/i.test(s.deliveryType ?? '') ? 'online' as const : 'in_store' as const;
  if (s.type === 'REFUND' || total < 0) return sale({ at: toDate(s.timeClosed), channel, currency, refundsMinor: Math.abs(total) + Math.abs(tips), taxMinor: -Math.abs(tax), tipsMinor: -Math.abs(tips), orders: 0 });
  return sale({ at: toDate(s.timeClosed), channel, currency, grossMinor: total + tips, taxMinor: tax, tipsMinor: tips, discountsMinor: disc, orders: 1 });
}

async function kToken(cfg: Config, f: FetchLike, form: Record<string, string>) {
  const basic = Buffer.from(`${cfg.LIGHTSPEED_K_CLIENT_ID}:${cfg.LIGHTSPEED_K_CLIENT_SECRET}`).toString('base64');
  const { data } = await requestJson<{ access_token: string; refresh_token?: string; expires_in?: number }>('Lightspeed', f, `${kHost(cfg)}/oauth/token`, { form, headers: { Authorization: `Basic ${basic}` } });
  return data;
}

export const lightspeedAdapter: SalesAdapter = {
  provider: 'lightspeed',
  platformReady: (cfg) => !!((cfg.LIGHTSPEED_X_CLIENT_ID && cfg.LIGHTSPEED_X_CLIENT_SECRET) || (cfg.LIGHTSPEED_K_CLIENT_ID && cfg.LIGHTSPEED_K_CLIENT_SECRET)),
  authorizeUrl(cfg, a) {
    if (series(a.config) === 'k_series') {
      const q = new URLSearchParams({ response_type: 'code', client_id: cfg.LIGHTSPEED_K_CLIENT_ID ?? '', scope: 'financial-api', redirect_uri: a.redirectUri, state: a.state });
      return `${kHost(cfg)}/oauth/authorize?${q.toString()}`;
    }
    const q = new URLSearchParams({ response_type: 'code', client_id: cfg.LIGHTSPEED_X_CLIENT_ID ?? '', redirect_uri: a.redirectUri, state: a.state });
    return `https://secure.retail.lightspeed.app/connect?${q.toString()}`;
  },
  async exchangeCode(cfg, f, a) {
    if (series(a.config) === 'k_series') {
      const t = await kToken(cfg, f, { grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri });
      return { creds: { accessToken: t.access_token, refreshToken: t.refresh_token ?? '', expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString() } };
    }
    const prefix = a.query.domain_prefix ?? str(a.config.domainPrefix);
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; expires?: number; domain_prefix?: string }>('Lightspeed', f, `${xHost(prefix)}/api/1.0/token`, {
      form: { code: a.code, client_id: cfg.LIGHTSPEED_X_CLIENT_ID ?? '', client_secret: cfg.LIGHTSPEED_X_CLIENT_SECRET ?? '', grant_type: 'authorization_code', redirect_uri: a.redirectUri },
    });
    return { creds: { accessToken: data.access_token, refreshToken: data.refresh_token ?? '', expiresAt: data.expires ? new Date(data.expires * 1000).toISOString() : '' }, config: { domainPrefix: data.domain_prefix ?? prefix }, accountName: data.domain_prefix ?? prefix };
  },
  async refresh(cfg, f, creds, config, now) {
    if (!creds.refreshToken || !creds.expiresAt || Date.parse(creds.expiresAt) - now > 5 * 60_000) return null;
    if (series(config) === 'k_series') {
      const t = await kToken(cfg, f, { grant_type: 'refresh_token', refresh_token: creds.refreshToken });
      return { accessToken: t.access_token, refreshToken: t.refresh_token ?? creds.refreshToken, expiresAt: new Date(now + (t.expires_in ?? 3600) * 1000).toISOString() };
    }
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; expires?: number }>('Lightspeed', f, `${xHost(str(config.domainPrefix))}/api/1.0/token`, {
      form: { refresh_token: creds.refreshToken, client_id: cfg.LIGHTSPEED_X_CLIENT_ID ?? '', client_secret: cfg.LIGHTSPEED_X_CLIENT_SECRET ?? '', grant_type: 'refresh_token' },
    });
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? creds.refreshToken, expiresAt: data.expires ? new Date(data.expires * 1000).toISOString() : '' };
  },
  async listLocations(cfg, f, creds, config) {
    const auth = { Authorization: `Bearer ${creds.accessToken}` };
    if (series(config) === 'k_series') {
      const { data } = await requestJson<Array<{ businessName?: string; businessLocations?: Array<{ blId: number | string; blName: string }> }>>('Lightspeed', f, `${kHost(cfg)}/f/data/businesses`, { headers: auth });
      return (Array.isArray(data) ? data : []).flatMap((b) => (b.businessLocations ?? []).map((l) => ({ id: String(l.blId), name: l.blName })));
    }
    const { data } = await requestJson<{ data?: Array<{ id: string; name: string }> }>('Lightspeed', f, `${xHost(str(config.domainPrefix))}/api/2.0/outlets`, { headers: auth });
    return (data.data ?? []).map((o) => ({ id: o.id, name: o.name }));
  },
  async fetchSales(cfg, f, input) {
    const auth = { Authorization: `Bearer ${input.creds.accessToken}` };
    const loc = str(input.config.externalLocationId);
    if (!loc) throw new Error('Choose the Lightspeed outlet or business location for this BranchHarbor location');
    const out: SaleRecord[] = [];
    if (series(input.config) === 'k_series') {
      const { data } = await requestJson<{ sales?: KSale[] }>('Lightspeed', f, `${kHost(cfg)}/f/finance/${encodeURIComponent(loc)}/financials/${input.fromUtc.toISOString()}/${input.toUtc.toISOString()}`, { headers: auth });
      for (const s of data.sales ?? []) { const r = lightspeedKSaleToRecord(s, input.currency); if (r) out.push(r); }
      return out;
    }
    for (let offset = 0; offset < 200_000; offset += 1000) {
      const q = new URLSearchParams({ type: 'sales', date_from: input.fromUtc.toISOString(), date_to: input.toUtc.toISOString(), outlet_id: loc, page_size: '1000', offset: String(offset) });
      const { data } = await requestJson<{ data?: XSale[] }>('Lightspeed', f, `${xHost(str(input.config.domainPrefix))}/api/2.0/search?${q.toString()}`, { headers: auth });
      for (const s of data.data ?? []) { const r = lightspeedXSaleToRecord(s, input.currency); if (r) out.push(r); }
      if ((data.data ?? []).length < 1000) break;
    }
    return out;
  },
};
