/**
 * Toast (doc.toasttab.com, retrieved 2026-10). Toast is a partner integration, not merchant OAuth: BranchHarbor is
 * approved as a Toast partner, the restaurant enables the BranchHarbor integration in Toast Web (Integrations), and
 * we read with machine-client credentials scoped to the restaurants that enabled us.
 *  - Auth: POST {host}/authentication/v1/authentication/login { clientId, clientSecret, userAccessType: "TOAST_MACHINE_CLIENT" }
 *    → { token: { accessToken, expiresIn } }.
 *  - Restaurant access check: GET {host}/restaurants/v1/restaurants/{guid} with header `Toast-Restaurant-External-ID`.
 *  - Orders: GET {host}/orders/v2/ordersBulk?businessDate=YYYYMMDD&pageSize=100&page=N (header Toast-Restaurant-External-ID)
 *    → [{ guid, businessDate, voided, deleted, diningOption: { behavior: DINE_IN | TAKE_OUT | DELIVERY }, source,
 *    checks: [{ voided, amount, taxAmount, totalAmount, payments: [{ amount, tipAmount, refundStatus, refund: { refundAmount, tipRefundAmount } }],
 *    appliedDiscounts: [{ discountAmount }] }] }]. Amounts are decimal in the restaurant's currency.
 *  - Hosts: sandbox https://ws-sandbox-api.eng.toasttab.com, production https://ws-api.toasttab.com.
 */
import { datesBetween, decimalToMinor, type SalesChannel } from '@bh/shared';
import type { Config } from '../../config.ts';
import { PartnerHttpError, requestJson, TokenCache } from '../partners/http.ts';
import { sale, str, type SaleRecord, type SalesAdapter } from './types.ts';

const host = (cfg: Config) => (cfg.TOAST_ENVIRONMENT === 'production' ? 'https://ws-api.toasttab.com' : 'https://ws-sandbox-api.eng.toasttab.com');
const tokens = new TokenCache();

async function token(cfg: Config, f: Parameters<SalesAdapter['listLocations']>[1], now = Date.now()) {
  const key = `toast:${cfg.TOAST_CLIENT_ID}`;
  const hit = tokens.get(key, now);
  if (hit) return hit;
  const { data } = await requestJson<{ token?: { accessToken?: string; expiresIn?: number } }>('Toast', f, `${host(cfg)}/authentication/v1/authentication/login`, {
    body: { clientId: cfg.TOAST_CLIENT_ID, clientSecret: cfg.TOAST_CLIENT_SECRET, userAccessType: 'TOAST_MACHINE_CLIENT' },
  });
  const t = data.token?.accessToken;
  if (!t) throw new PartnerHttpError('Toast', 502, 'Toast did not return an access token');
  tokens.set(key, t, now + (data.token?.expiresIn ?? 3600) * 1000);
  return t;
}
export const clearToastTokens = () => tokens.clear();

interface ToastPayment { amount?: number; tipAmount?: number; refundStatus?: string; refund?: { refundAmount?: number; tipRefundAmount?: number } | null }
interface ToastCheck { voided?: boolean; deleted?: boolean; amount?: number; taxAmount?: number; totalAmount?: number; payments?: ToastPayment[]; appliedDiscounts?: Array<{ discountAmount?: number }> }
interface ToastOrder { guid: string; businessDate?: number; voided?: boolean; deleted?: boolean; source?: string; diningOption?: { behavior?: string } | null; checks?: ToastCheck[] }

function channelOf(o: ToastOrder): SalesChannel {
  if (o.diningOption?.behavior === 'DELIVERY') return 'delivery';
  if (/online|api|app/i.test(o.source ?? '')) return 'online';
  return 'in_store';
}

/** One Toast order → sale record (voided / deleted orders and checks are skipped). */
export function toastOrderToSale(o: ToastOrder, currency: string): SaleRecord | null {
  if (o.voided || o.deleted) return null;
  const m = (v: unknown) => decimalToMinor(v ?? 0, currency) ?? 0;
  let gross = 0, tax = 0, tips = 0, refunds = 0, disc = 0;
  for (const c of o.checks ?? []) {
    if (c.voided || c.deleted) continue;
    const tipsOnCheck = (c.payments ?? []).reduce((a, p) => a + m(p.tipAmount), 0);
    gross += m(c.totalAmount) + tipsOnCheck;
    tax += m(c.taxAmount);
    tips += tipsOnCheck;
    disc += (c.appliedDiscounts ?? []).reduce((a, d) => a + m(d.discountAmount), 0);
    for (const p of c.payments ?? []) if (p.refund) { refunds += m(p.refund.refundAmount) + m(p.refund.tipRefundAmount); tips -= m(p.refund.tipRefundAmount); }
  }
  const bd = String(o.businessDate ?? '');
  return sale({
    at: null, businessDate: /^\d{8}$/.test(bd) ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}` : undefined, channel: channelOf(o), currency,
    grossMinor: gross, refundsMinor: refunds, taxMinor: tax, tipsMinor: tips, discountsMinor: disc, orders: gross > 0 ? 1 : 0,
  });
}

export const toastAdapter: SalesAdapter = {
  provider: 'toast',
  platformReady: (cfg) => !!(cfg.TOAST_CLIENT_ID && cfg.TOAST_CLIENT_SECRET),
  async activate(cfg, f, a) {
    const guid = str(a.config.restaurantGuid);
    if (!/^[0-9a-f-]{36}$/i.test(guid)) throw new PartnerHttpError('Toast', 400, 'Enter the Toast restaurant GUID (Toast Web → Restaurant info)');
    const t = await token(cfg, f);
    const { data } = await requestJson<{ general?: { name?: string } ; name?: string }>('Toast', f, `${host(cfg)}/restaurants/v1/restaurants/${guid}`, {
      headers: { Authorization: `Bearer ${t}`, 'Toast-Restaurant-External-ID': guid },
    });
    return { creds: { restaurantGuid: guid }, accountName: data.general?.name ?? data.name ?? null };
  },
  async listLocations(cfg, f, creds) {
    const guid = creds.restaurantGuid ?? '';
    return guid ? [{ id: guid, name: guid }] : [];
  },
  async fetchSales(cfg, f, input) {
    const guid = str(input.creds.restaurantGuid ?? input.config.restaurantGuid);
    if (!guid) throw new Error('Enter the Toast restaurant GUID');
    const t = await token(cfg, f);
    const out: SaleRecord[] = [];
    for (const day of datesBetween(input.fromDate, input.toDate)) {
      for (let page = 1; page < 100; page++) {
        const { data } = await requestJson<ToastOrder[]>('Toast', f, `${host(cfg)}/orders/v2/ordersBulk?businessDate=${day.replace(/-/g, '')}&pageSize=100&page=${page}`, {
          headers: { Authorization: `Bearer ${t}`, 'Toast-Restaurant-External-ID': guid },
        });
        const list = Array.isArray(data) ? data : [];
        for (const o of list) { const r = toastOrderToSale(o, input.currency); if (r) out.push(r); }
        if (list.length < 100) break;
      }
    }
    return out;
  },
};
