/**
 * Mindbody Public API v6 (developers.mindbodyonline.com, retrieved 2026-10). Access is granted per site: the site owner
 * approves BranchHarbor through an activation link; afterwards our source credentials issue a staff token for the site.
 *  - Every call: headers `Api-Key` (developer key) and `SiteId`.
 *  - Activation: GET /public/v6/site/activationcode → { ActivationCode, ActivationLink } (the owner opens the link).
 *  - Staff token: POST /public/v6/usertoken/issue { Username: "_<SourceName>", Password } → { AccessToken } (Authorization header).
 *  - Locations: GET /public/v6/site/locations → { Locations: [{ Id, Name }] }. Location 98 is the online store.
 *  - Sales: GET /public/v6/sale/sales?StartSaleDateTime&EndSaleDateTime&Limit=200&Offset=N
 *    → { PaginationResponse: { TotalResults }, Sales: [{ Id, SaleDateTime, LocationId, PurchasedItems: [{ TotalAmount,
 *    TaxAmount, DiscountAmount, Returned, IsService, Description }], Payments: [{ Amount, Type }] }] }. Amounts are decimal
 *    in the site currency; TotalAmount includes tax. Tips are sold as items whose description starts with "Tip".
 */
import { decimalToMinor } from '@bh/shared';
import type { Config } from '../../config.ts';
import { PartnerHttpError, requestJson, type FetchLike } from '../partners/http.ts';
import { sale, str, toDate, type SaleRecord, type SalesAdapter, type SalesCredentials } from './types.ts';

export const MINDBODY_BASE = 'https://api.mindbodyonline.com/public/v6';
export const MINDBODY_ONLINE_STORE_LOCATION = 98;

const headers = (cfg: Config, siteId: string, token?: string) => ({ 'Api-Key': cfg.MINDBODY_API_KEY ?? '', SiteId: siteId, ...(token ? { Authorization: token } : {}) });

async function staffToken(cfg: Config, f: FetchLike, siteId: string) {
  const { data } = await requestJson<{ AccessToken?: string }>('Mindbody', f, `${MINDBODY_BASE}/usertoken/issue`, {
    headers: headers(cfg, siteId), body: { Username: `_${cfg.MINDBODY_SOURCE_NAME ?? ''}`, Password: cfg.MINDBODY_SOURCE_PASSWORD ?? '' },
  });
  if (!data.AccessToken) throw new PartnerHttpError('Mindbody', 401, 'Mindbody did not issue a staff token: the site owner has not approved BranchHarbor yet');
  return data.AccessToken;
}

interface MbItem { TotalAmount?: number; TaxAmount?: number; DiscountAmount?: number; Returned?: boolean; Description?: string }
interface MbSale { Id: number | string; SaleDateTime?: string; LocationId?: number; PurchasedItems?: MbItem[] }

/** One Mindbody sale → sale record. Returned items count as refunds; "Tip" items as tips. */
export function mindbodySaleToRecord(s: MbSale, currency: string): SaleRecord {
  const m = (v: unknown) => decimalToMinor(v ?? 0, currency) ?? 0;
  let gross = 0, refunds = 0, tax = 0, tips = 0, disc = 0;
  for (const it of s.PurchasedItems ?? []) {
    const total = m(it.TotalAmount);
    if (it.Returned || total < 0) { refunds += Math.abs(total); tax -= Math.abs(m(it.TaxAmount)); continue; }
    gross += total;
    tax += m(it.TaxAmount);
    disc += m(it.DiscountAmount);
    if (/^tip\b/i.test(it.Description ?? '')) tips += total;
  }
  return sale({ at: toDate(s.SaleDateTime), channel: Number(s.LocationId) === MINDBODY_ONLINE_STORE_LOCATION ? 'online' : 'in_store', currency, grossMinor: gross, refundsMinor: refunds, taxMinor: tax, tipsMinor: tips, discountsMinor: disc, orders: gross > 0 ? 1 : 0 });
}

export const mindbodyAdapter: SalesAdapter = {
  provider: 'mindbody',
  platformReady: (cfg) => !!(cfg.MINDBODY_API_KEY && cfg.MINDBODY_SOURCE_NAME && cfg.MINDBODY_SOURCE_PASSWORD),
  async activate(cfg, f, a) {
    const siteId = str(a.config.siteId);
    if (!/^-?\d+$/.test(siteId)) throw new PartnerHttpError('Mindbody', 400, 'Enter the Mindbody site id (Mindbody → Settings → Site id)');
    // Token first: it only works once the owner has approved the activation link.
    try {
      await staffToken(cfg, f, siteId);
      return { creds: { siteId }, activationUrl: null };
    } catch (err) {
      if (!(err instanceof PartnerHttpError) || (err.status !== 401 && err.status !== 403 && err.status !== 400)) throw err;
      const { data } = await requestJson<{ ActivationLink?: string }>('Mindbody', f, `${MINDBODY_BASE}/site/activationcode`, { headers: headers(cfg, siteId) });
      return { creds: { siteId }, activationUrl: data.ActivationLink ?? null };
    }
  },
  async listLocations(cfg, f, creds: SalesCredentials) {
    const { data } = await requestJson<{ Locations?: Array<{ Id: number; Name: string }> }>('Mindbody', f, `${MINDBODY_BASE}/site/locations`, { headers: headers(cfg, creds.siteId ?? '') });
    return (data.Locations ?? []).map((l) => ({ id: String(l.Id), name: l.Name }));
  },
  async fetchSales(cfg, f, input) {
    const siteId = str(input.creds.siteId ?? input.config.siteId);
    const token = await staffToken(cfg, f, siteId);
    const only = str(input.config.externalLocationId);
    const includeOnline = input.config.includeOnlineStore !== false;
    const out: SaleRecord[] = [];
    for (let offset = 0; offset < 100_000; offset += 200) {
      const q = new URLSearchParams({ StartSaleDateTime: input.fromUtc.toISOString(), EndSaleDateTime: input.toUtc.toISOString(), Limit: '200', Offset: String(offset) });
      const { data } = await requestJson<{ Sales?: MbSale[]; PaginationResponse?: { TotalResults?: number } }>('Mindbody', f, `${MINDBODY_BASE}/sale/sales?${q.toString()}`, { headers: headers(cfg, siteId, token) });
      for (const s of data.Sales ?? []) {
        const loc = String(s.LocationId ?? '');
        if (only && loc !== only && !(includeOnline && Number(loc) === MINDBODY_ONLINE_STORE_LOCATION)) continue;
        out.push(mindbodySaleToRecord(s, input.currency));
      }
      if ((data.Sales ?? []).length < 200 || offset + 200 >= (data.PaginationResponse?.TotalResults ?? 0)) break;
    }
    return out;
  },
};
