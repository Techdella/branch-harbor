/**
 * Clover REST API (docs.clover.com, retrieved 2026-10).
 *  - OAuth v2 (expiring tokens): {web}/oauth/v2/authorize?client_id&redirect_uri&state; the callback adds `merchant_id`.
 *    Token: POST {api}/oauth/v2/token { client_id, client_secret, code } → { access_token, refresh_token, access_token_expiration,
 *    refresh_token_expiration }. Refresh: POST {api}/oauth/v2/refresh { client_id, refresh_token }.
 *    Sandbox: web https://sandbox.dev.clover.com, api https://apisandbox.dev.clover.com; production (North America):
 *    web https://www.clover.com, api https://api.clover.com.
 *  - Merchant: GET /v3/merchants/{mId}?expand=address → { id, name, defaultCurrency }.
 *  - Orders: GET /v3/merchants/{mId}/orders?filter=clientCreatedTime>={ms}&filter=clientCreatedTime<{ms}&expand=payments,refunds&limit=1000&offset
 *    → { elements: [{ id, state, total, clientCreatedTime, orderType: { label }, payments: { elements: [{ amount, taxAmount, tipAmount,
 *    result }] }, refunds: { elements: [{ amount, taxAmount, tipAmount, createdTime }] } }] }. Amounts are integer cents.
 */
import type { Config } from '../../config.ts';
import { requestJson } from '../partners/http.ts';
import { sale, str, toDate, type SaleRecord, type SalesAdapter } from './types.ts';

const hosts = (cfg: Config) => (cfg.CLOVER_ENVIRONMENT === 'production'
  ? { web: 'https://www.clover.com', api: 'https://api.clover.com' }
  : { web: 'https://sandbox.dev.clover.com', api: 'https://apisandbox.dev.clover.com' });

interface CloverPay { amount?: number; taxAmount?: number; tipAmount?: number; result?: string }
interface CloverRefund { amount?: number; taxAmount?: number; tipAmount?: number; createdTime?: number }
interface CloverOrder { id: string; state?: string; total?: number; clientCreatedTime?: number; createdTime?: number; orderType?: { label?: string } | null; payments?: { elements?: CloverPay[] }; refunds?: { elements?: CloverRefund[] } }

/** One Clover order → the sale (successful payments) plus a record per refund on its own date. */
export function cloverOrderToSales(o: CloverOrder, currency: string): SaleRecord[] {
  const pays = (o.payments?.elements ?? []).filter((p) => (p.result ?? 'SUCCESS') === 'SUCCESS');
  const channel = /deliver/i.test(o.orderType?.label ?? '') ? 'delivery' as const : /online|web/i.test(o.orderType?.label ?? '') ? 'online' as const : 'in_store' as const;
  const out: SaleRecord[] = [];
  const gross = pays.reduce((a, p) => a + Number(p.amount ?? 0) + Number(p.tipAmount ?? 0), 0);
  if (gross) out.push(sale({ at: toDate(o.clientCreatedTime ?? o.createdTime), channel, currency, grossMinor: gross, taxMinor: pays.reduce((a, p) => a + Number(p.taxAmount ?? 0), 0), tipsMinor: pays.reduce((a, p) => a + Number(p.tipAmount ?? 0), 0), orders: 1 }));
  for (const r of o.refunds?.elements ?? []) {
    out.push(sale({ at: toDate(r.createdTime ?? o.clientCreatedTime), channel, currency, refundsMinor: Number(r.amount ?? 0) + Number(r.tipAmount ?? 0), taxMinor: -Number(r.taxAmount ?? 0), tipsMinor: -Number(r.tipAmount ?? 0), orders: 0 }));
  }
  return out;
}

export const cloverAdapter: SalesAdapter = {
  provider: 'clover',
  platformReady: (cfg) => !!(cfg.CLOVER_APP_ID && cfg.CLOVER_APP_SECRET),
  authorizeUrl(cfg, a) {
    const q = new URLSearchParams({ client_id: cfg.CLOVER_APP_ID ?? '', redirect_uri: a.redirectUri, state: a.state });
    return `${hosts(cfg).web}/oauth/v2/authorize?${q.toString()}`;
  },
  async exchangeCode(cfg, f, a) {
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; access_token_expiration?: number }>('Clover', f, `${hosts(cfg).api}/oauth/v2/token`, {
      body: { client_id: cfg.CLOVER_APP_ID, client_secret: cfg.CLOVER_APP_SECRET, code: a.code },
    });
    const merchantId = a.query.merchant_id ?? str(a.config.merchantId);
    let name: string | null = null;
    if (merchantId) {
      const m = await requestJson<{ name?: string }>('Clover', f, `${hosts(cfg).api}/v3/merchants/${encodeURIComponent(merchantId)}`, { headers: { Authorization: `Bearer ${data.access_token}` } }).catch(() => null);
      name = m?.data.name ?? null;
    }
    return { creds: { accessToken: data.access_token, refreshToken: data.refresh_token ?? '', expiresAt: data.access_token_expiration ? new Date(data.access_token_expiration * 1000).toISOString() : '' }, config: { merchantId }, accountName: name };
  },
  async refresh(cfg, f, creds, _config, now) {
    if (!creds.refreshToken || !creds.expiresAt || Date.parse(creds.expiresAt) - now > 5 * 60_000) return null;
    const { data } = await requestJson<{ access_token: string; refresh_token?: string; access_token_expiration?: number }>('Clover', f, `${hosts(cfg).api}/oauth/v2/refresh`, { body: { client_id: cfg.CLOVER_APP_ID, refresh_token: creds.refreshToken } });
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? creds.refreshToken, expiresAt: data.access_token_expiration ? new Date(data.access_token_expiration * 1000).toISOString() : '' };
  },
  async listLocations(cfg, f, creds, config) {
    const id = str(config.merchantId);
    if (!id) return [];
    const { data } = await requestJson<{ id: string; name?: string; defaultCurrency?: string }>('Clover', f, `${hosts(cfg).api}/v3/merchants/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    return [{ id: data.id, name: data.name ?? data.id, currency: data.defaultCurrency ?? null }];
  },
  async fetchSales(cfg, f, input) {
    const mId = str(input.config.merchantId);
    if (!mId) throw new Error('Clover did not return a merchant id');
    const out: SaleRecord[] = [];
    for (let offset = 0; offset < 500_000; offset += 1000) {
      const q = `filter=${encodeURIComponent(`clientCreatedTime>=${input.fromUtc.getTime()}`)}&filter=${encodeURIComponent(`clientCreatedTime<${input.toUtc.getTime()}`)}&expand=payments,refunds&limit=1000&offset=${offset}`;
      const { data } = await requestJson<{ elements?: CloverOrder[] }>('Clover', f, `${hosts(cfg).api}/v3/merchants/${encodeURIComponent(mId)}/orders?${q}`, { headers: { Authorization: `Bearer ${input.creds.accessToken}` } });
      for (const o of data.elements ?? []) out.push(...cloverOrderToSales(o, input.currency));
      if ((data.elements ?? []).length < 1000) break;
    }
    return out;
  },
};
