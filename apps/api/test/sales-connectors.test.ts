/**
 * POS / booking sales adapters without a database: each vendor's documented response shape (fixtures under
 * test/fixtures/sales) through an injected mock fetch — never the network — plus bucketing, the XLSX reader and CSV.
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { SALES_ADAPTERS, sandboxSales } from '../src/integrations/sales/index.ts';
import { clearToastTokens } from '../src/integrations/sales/toast.ts';
import { verifyShopifyHmac } from '../src/integrations/sales/shopify.ts';
import { bucketSales } from '../src/services/sales-connectors.ts';
import { readXlsx, writeXlsx } from '../src/lib/xlsx.ts';
import { csvRecords } from '../src/lib/csv.ts';
import type { FetchLike } from '../src/integrations/partners/http.ts';

interface MockCall { url: string; method: string; headers: Record<string, string>; body: string | undefined }
/** Route table → mock fetch; records every call. */
function mockFetch(routes: Array<[RegExp, (c: MockCall) => { status?: number; body: unknown }]>) {
  const calls: MockCall[] = [];
  const f: FetchLike = async (url, init = {}) => {
    const c = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    calls.push(c);
    const r = routes.find(([re]) => re.test(url));
    if (!r) return { ok: false, status: 599, text: async () => JSON.stringify({ message: `no mock for ${url}` }) };
    const out = r[1](c);
    const status = out.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(out.body) };
  };
  return { fetch: f, calls };
}

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sales/${name}`, import.meta.url), 'utf8'));
const cfg = loadConfig({
  NODE_ENV: 'test', SQUARE_APPLICATION_ID: 'sq0idp-app', SQUARE_APPLICATION_SECRET: 'sq0csp-secret', TOAST_CLIENT_ID: 'toast-client', TOAST_CLIENT_SECRET: 'toast-secret',
  MINDBODY_API_KEY: 'mb-key', MINDBODY_SOURCE_NAME: 'BranchHarbor', MINDBODY_SOURCE_PASSWORD: 'mb-pass', SHOPIFY_API_KEY: 'shp-key', SHOPIFY_API_SECRET: 'shp-secret',
  LIGHTSPEED_X_CLIENT_ID: 'lsx', LIGHTSPEED_X_CLIENT_SECRET: 'lsx-secret', LIGHTSPEED_K_CLIENT_ID: 'lsk', LIGHTSPEED_K_CLIENT_SECRET: 'lsk-secret', CLOVER_APP_ID: 'clv', CLOVER_APP_SECRET: 'clv-secret',
} as NodeJS.ProcessEnv);
const window = (currency: string, timeZone = 'America/Toronto') => ({
  fromDate: '2026-10-12', toDate: '2026-10-13', fromUtc: new Date('2026-10-12T04:00:00Z'), toUtc: new Date('2026-10-14T04:00:00Z'), currency, timeZone,
});
const byKey = (rows: ReturnType<typeof bucketSales>) => Object.fromEntries(rows.map((r) => [`${r.date}|${r.channel}`, r.f]));

describe('Square', () => {
  it('builds the OAuth URL and exchanges the code', async () => {
    const url = new URL(SALES_ADAPTERS.square.authorizeUrl!(cfg, { state: 'st', redirectUri: 'https://api.example/cb', config: {} }));
    expect(url.host).toBe('connect.squareupsandbox.com');
    expect(url.searchParams.get('scope')).toBe('ORDERS_READ PAYMENTS_READ MERCHANT_PROFILE_READ');
    expect(url.searchParams.get('state')).toBe('st');
    const m = mockFetch([[/oauth2\/token/, () => ({ body: { access_token: 'EAAA-1', refresh_token: 'R1', expires_at: '2026-11-14T00:00:00Z', merchant_id: 'M1' } })]]);
    const r = await SALES_ADAPTERS.square.exchangeCode!(cfg, m.fetch, { code: 'c0de', redirectUri: 'https://api.example/cb', config: {}, query: {} });
    expect(r.creds.accessToken).toBe('EAAA-1');
    expect(r.config).toEqual({ merchantId: 'M1' });
    expect(JSON.parse(m.calls[0]!.body!)).toMatchObject({ client_id: 'sq0idp-app', client_secret: 'sq0csp-secret', code: 'c0de', grant_type: 'authorization_code' });
    expect(m.calls[0]!.headers['Square-Version']).toBeTruthy();
  });

  it('searches completed orders by closed_at and normalises sales, online orders and returns', async () => {
    const m = mockFetch([[/orders\/search/, () => ({ body: fx('square-orders-search.json') })]]);
    const recs = await SALES_ADAPTERS.square.fetchSales(cfg, m.fetch, { creds: { accessToken: 'EAAA-1' }, config: { externalLocationId: 'L1W8Q7A3' }, ...window('CAD') });
    const body = JSON.parse(m.calls[0]!.body!);
    expect(body.location_ids).toEqual(['L1W8Q7A3']);
    expect(body.query.filter.state_filter.states).toEqual(['COMPLETED']);
    expect(body.query.filter.date_time_filter.closed_at).toEqual({ start_at: '2026-10-12T04:00:00.000Z', end_at: '2026-10-14T04:00:00.000Z' });
    expect(m.calls[0]!.headers.Authorization).toBe('Bearer EAAA-1');
    const b = byKey(bucketSales(recs, 'America/Toronto', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toEqual({ grossMinor: 2376, refundsMinor: 0, taxMinor: 276, tipsMinor: 300, discountsMinor: 100, orderCount: 1 });
    // 03:30 UTC on the 13th is still the 12th in Toronto.
    expect(b['2026-10-12|online']).toMatchObject({ grossMinor: 1130, taxMinor: 130, orderCount: 1 });
    expect(b['2026-10-13|in_store']).toMatchObject({ grossMinor: 0, refundsMinor: 565, taxMinor: -65, orderCount: 0 });
  });

  it('refreshes tokens only close to expiry', async () => {
    const m = mockFetch([[/oauth2\/token/, () => ({ body: { access_token: 'EAAA-2', refresh_token: 'R2', expires_at: '2027-01-01T00:00:00Z' } })]]);
    expect(await SALES_ADAPTERS.square.refresh!(cfg, m.fetch, { accessToken: 'a', refreshToken: 'R1', expiresAt: '2026-12-31T00:00:00Z' }, {}, Date.parse('2026-10-14T00:00:00Z'))).toBeNull();
    const r = await SALES_ADAPTERS.square.refresh!(cfg, m.fetch, { accessToken: 'a', refreshToken: 'R1', expiresAt: '2026-10-16T00:00:00Z' }, {}, Date.parse('2026-10-14T00:00:00Z'));
    expect(r).toEqual({ accessToken: 'EAAA-2', refreshToken: 'R2', expiresAt: '2027-01-01T00:00:00Z' });
    expect(JSON.parse(m.calls[0]!.body!).grant_type).toBe('refresh_token');
  });
});

describe('Toast', () => {
  it('logs in as a machine client, checks the restaurant, and reads ordersBulk per business date', async () => {
    clearToastTokens();
    const m = mockFetch([
      [/authentication\/v1\/authentication\/login/, () => ({ body: { token: { accessToken: 'toast-tok', expiresIn: 86400 } } })],
      [/restaurants\/v1\/restaurants\//, () => ({ body: { general: { name: 'Maple & Ember Queen St' } } })],
      [/ordersBulk\?businessDate=20261012/, () => ({ body: fx('toast-orders-bulk.json') })],
      [/ordersBulk\?businessDate=20261013/, () => ({ body: [] })],
    ]);
    const guid = '0b4e1a4c-2d3f-4e5a-9b6c-7d8e9f0a1b2c';
    const act = await SALES_ADAPTERS.toast.activate!(cfg, m.fetch, { config: { restaurantGuid: guid } });
    expect(act.accountName).toBe('Maple & Ember Queen St');
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ clientId: 'toast-client', clientSecret: 'toast-secret', userAccessType: 'TOAST_MACHINE_CLIENT' });
    expect(m.calls[1]!.headers['Toast-Restaurant-External-ID']).toBe(guid);
    const recs = await SALES_ADAPTERS.toast.fetchSales(cfg, m.fetch, { creds: act.creds, config: {}, ...window('USD') });
    expect(m.calls.filter((c) => /login/.test(c.url))).toHaveLength(1); // token cached
    const b = byKey(bucketSales(recs, 'America/Toronto', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toEqual({ grossMinor: 5546, refundsMinor: 0, taxMinor: 546, tipsMinor: 800, discountsMinor: 200, orderCount: 1 });
    expect(b['2026-10-12|delivery']).toEqual({ grossMinor: 2560, refundsMinor: 565, taxMinor: 260, tipsMinor: 300, discountsMinor: 0, orderCount: 1 });
    expect(Object.keys(b)).toHaveLength(2); // the voided order is skipped
  });

  it('rejects a malformed restaurant GUID before calling Toast', async () => {
    const m = mockFetch([]);
    await expect(SALES_ADAPTERS.toast.activate!(cfg, m.fetch, { config: { restaurantGuid: 'nope' } })).rejects.toThrow(/GUID/);
    expect(m.calls).toHaveLength(0);
  });
});

describe('Mindbody', () => {
  it('returns the activation link until the owner approves, then reads sales with a staff token', async () => {
    let approved = false;
    const m = mockFetch([
      [/usertoken\/issue/, () => (approved ? { body: { AccessToken: 'mb-staff' } } : { status: 401, body: { Error: { Message: 'Site not activated' } } })],
      [/site\/activationcode/, () => ({ body: { ActivationCode: 'abc', ActivationLink: 'https://clients.mindbodyonline.com/ActivateLink?subscriberId=-99&activationCode=abc' } })],
      [/sale\/sales/, () => ({ body: fx('mindbody-sales.json') })],
    ]);
    const first = await SALES_ADAPTERS.mindbody.activate!(cfg, m.fetch, { config: { siteId: '-99' } });
    expect(first.activationUrl).toContain('ActivateLink');
    expect(m.calls[0]!.headers['Api-Key']).toBe('mb-key');
    expect(m.calls[0]!.headers.SiteId).toBe('-99');
    expect(JSON.parse(m.calls[0]!.body!)).toEqual({ Username: '_BranchHarbor', Password: 'mb-pass' });
    approved = true;
    expect((await SALES_ADAPTERS.mindbody.activate!(cfg, m.fetch, { config: { siteId: '-99' } })).activationUrl).toBeNull();
    const recs = await SALES_ADAPTERS.mindbody.fetchSales(cfg, m.fetch, { creds: { siteId: '-99' }, config: { externalLocationId: '1' }, ...window('CAD') });
    const call = m.calls.find((c) => /sale\/sales/.test(c.url))!;
    expect(call.headers.Authorization).toBe('mb-staff');
    expect(new URL(call.url).searchParams.get('StartSaleDateTime')).toBe('2026-10-12T04:00:00.000Z');
    const b = byKey(bucketSales(recs, 'America/Toronto', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toEqual({ grossMinor: 19000, refundsMinor: 0, taxMinor: 2071, tipsMinor: 1000, discountsMinor: 0, orderCount: 1 });
    expect(b['2026-10-12|online']).toMatchObject({ grossMinor: 2500, taxMinor: 288, discountsMinor: 500 }); // location 98 = online store
    expect(b['2026-10-13|in_store']).toMatchObject({ refundsMinor: 500, taxMinor: -58, orderCount: 0 });
  });
});

describe('Shopify', () => {
  it('verifies the callback HMAC, exchanges the code and filters orders to the mapped location (+ online)', async () => {
    const q: Record<string, string> = { code: 'abc', shop: 'fieldnote-goods.myshopify.com', state: 'st', timestamp: '1792900000' };
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
    q.hmac = createHmac('sha256', 'shp-secret').update(msg).digest('hex');
    expect(verifyShopifyHmac('shp-secret', q)).toBe(true);
    expect(verifyShopifyHmac('shp-secret', { ...q, code: 'tampered' })).toBe(false);
    const m = mockFetch([
      [/admin\/oauth\/access_token/, () => ({ body: { access_token: 'shpat_1', scope: 'read_orders,read_all_orders,read_locations' } })],
      [/orders\.json/, () => ({ body: fx('shopify-orders.json') })],
    ]);
    const ex = await SALES_ADAPTERS.shopify.exchangeCode!(cfg, m.fetch, { code: 'abc', redirectUri: 'https://api.example/cb', config: {}, query: q });
    expect(ex.config).toMatchObject({ shopDomain: 'fieldnote-goods.myshopify.com' });
    await expect(SALES_ADAPTERS.shopify.exchangeCode!(cfg, m.fetch, { code: 'abc', redirectUri: 'x', config: {}, query: { ...q, hmac: '00' } })).rejects.toThrow(/signature/);
    const recs = await SALES_ADAPTERS.shopify.fetchSales(cfg, m.fetch, { creds: ex.creds, config: { shopDomain: 'fieldnote-goods.myshopify.com', externalLocationId: '655441491' }, ...window('USD') });
    const call = m.calls.find((c) => /orders\.json/.test(c.url))!;
    expect(call.headers['X-Shopify-Access-Token']).toBe('shpat_1');
    expect(new URL(call.url).searchParams.get('status')).toBe('any');
    const b = byKey(bucketSales(recs, 'America/Toronto', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|online']).toMatchObject({ grossMinor: 5440, taxMinor: 440, discountsMinor: 500 });
    expect(b['2026-10-12|in_store']).toMatchObject({ grossMinor: 2160, taxMinor: 160, tipsMinor: 200 }); // the order at location 999 is left out
    expect(b['2026-10-13|in_store']).toMatchObject({ refundsMinor: 1080, taxMinor: -80 });
  });
  it('rejects a shop domain that is not myshopify.com', () => {
    expect(() => SALES_ADAPTERS.shopify.authorizeUrl!(cfg, { state: 's', redirectUri: 'r', config: { shopDomain: 'evil.example.com' } })).toThrow(/myshopify/);
  });
});

describe('Lightspeed', () => {
  it('X-Series: domain-prefix token exchange and the sales search (returns and voids)', async () => {
    const m = mockFetch([
      [/fieldnote\.retail\.lightspeed\.app\/api\/1\.0\/token/, () => ({ body: { access_token: 'lsx-tok', refresh_token: 'r', expires: 1792950000, domain_prefix: 'fieldnote' } })],
      [/api\/2\.0\/search/, () => ({ body: fx('lightspeed-x-sales.json') })],
    ]);
    const ex = await SALES_ADAPTERS.lightspeed.exchangeCode!(cfg, m.fetch, { code: 'c', redirectUri: 'r', config: { series: 'x_series' }, query: { domain_prefix: 'fieldnote' } });
    expect(ex.config).toEqual({ domainPrefix: 'fieldnote' });
    expect(m.calls[0]!.body).toContain('grant_type=authorization_code');
    const recs = await SALES_ADAPTERS.lightspeed.fetchSales(cfg, m.fetch, { creds: ex.creds, config: { series: 'x_series', domainPrefix: 'fieldnote', externalLocationId: '06bf537b' }, ...window('AUD', 'UTC') });
    expect(new URL(m.calls[1]!.url).searchParams.get('type')).toBe('sales');
    const b = byKey(bucketSales(recs, 'UTC', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toEqual({ grossMinor: 4600, refundsMinor: 0, taxMinor: 600, tipsMinor: 0, discountsMinor: 250, orderCount: 1 });
    expect(b['2026-10-13|in_store']).toMatchObject({ refundsMinor: 1150, taxMinor: -150 });
  });
  it('K-Series: basic-auth token and financials (tips, refunds, cancelled receipts)', async () => {
    const m = mockFetch([
      [/oauth\/token/, () => ({ body: { access_token: 'lsk-tok', refresh_token: 'r', expires_in: 3600 } })],
      [/\/f\/finance\/12345\/financials\//, () => ({ body: fx('lightspeed-k-financials.json') })],
    ]);
    const ex = await SALES_ADAPTERS.lightspeed.exchangeCode!(cfg, m.fetch, { code: 'c', redirectUri: 'r', config: { series: 'k_series' }, query: {} });
    expect(m.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('lsk:lsk-secret').toString('base64')}`);
    expect(m.calls[0]!.url).toContain('api.trial.lsk.lightspeed.app');
    const recs = await SALES_ADAPTERS.lightspeed.fetchSales(cfg, m.fetch, { creds: ex.creds, config: { series: 'k_series', externalLocationId: '12345' }, ...window('EUR', 'Europe/Dublin') });
    const b = byKey(bucketSales(recs, 'Europe/Dublin', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toEqual({ grossMinor: 3300, refundsMinor: 600, taxMinor: 400, tipsMinor: 300, discountsMinor: 100, orderCount: 1 });
  });
});

describe('Clover', () => {
  it('exchanges the code (merchant from the callback) and reads orders with payments and refunds', async () => {
    const m = mockFetch([
      [/oauth\/v2\/token/, () => ({ body: { access_token: 'clv-tok', refresh_token: 'r', access_token_expiration: 1792950000 } })],
      [/v3\/merchants\/MID123\/orders/, () => ({ body: fx('clover-orders.json') })],
      [/v3\/merchants\/MID123/, () => ({ body: { id: 'MID123', name: 'Maple & Ember Dundas' } })],
    ]);
    const ex = await SALES_ADAPTERS.clover.exchangeCode!(cfg, m.fetch, { code: 'c', redirectUri: 'r', config: {}, query: { merchant_id: 'MID123' } });
    expect(ex.accountName).toBe('Maple & Ember Dundas');
    expect(ex.config).toEqual({ merchantId: 'MID123' });
    const recs = await SALES_ADAPTERS.clover.fetchSales(cfg, m.fetch, { creds: ex.creds, config: { merchantId: 'MID123' }, ...window('USD', 'UTC') });
    const call = m.calls.find((c) => /orders/.test(c.url))!;
    expect(decodeURIComponent(call.url)).toContain('clientCreatedTime>=');
    expect(call.url).toContain('expand=payments,refunds');
    const b = byKey(bucketSales(recs, 'UTC', '2026-10-12', '2026-10-13'));
    expect(b['2026-10-12|in_store']).toMatchObject({ grossMinor: 1995, taxMinor: 195, tipsMinor: 300 });
    expect(b['2026-10-12|delivery']).toMatchObject({ grossMinor: 1130, taxMinor: 130, orderCount: 1 }); // the failed payment is ignored
    expect(b['2026-10-13|delivery']).toMatchObject({ refundsMinor: 565, taxMinor: -65 });
  });
});

describe('bucketing, sandbox data and spreadsheets', () => {
  it('drops records outside the window and keeps currencies apart', () => {
    const rows = bucketSales([
      { at: new Date('2026-10-11T12:00:00Z'), channel: 'in_store', currency: 'CAD', grossMinor: 1, refundsMinor: 0, taxMinor: 0, tipsMinor: 0, discountsMinor: 0, orders: 1 },
      { at: new Date('2026-10-12T12:00:00Z'), channel: 'in_store', currency: 'CAD', grossMinor: 100, refundsMinor: 0, taxMinor: 0, tipsMinor: 0, discountsMinor: 0, orders: 1 },
      { at: new Date('2026-10-12T13:00:00Z'), channel: 'in_store', currency: 'usd', grossMinor: 50, refundsMinor: 0, taxMinor: 0, tipsMinor: 0, discountsMinor: 0, orders: 1 },
    ], 'America/Toronto', '2026-10-12', '2026-10-12');
    expect(rows.map((r) => `${r.currency}:${r.f.grossMinor}`).sort()).toEqual(['CAD:100', 'USD:50']);
  });
  it('sandbox sales are deterministic per connection and date', () => {
    const a = sandboxSales('conn-1', ['2026-10-12', '2026-10-13'], 'CAD');
    expect(a).toEqual(sandboxSales('conn-1', ['2026-10-12', '2026-10-13'], 'CAD'));
    expect(a).not.toEqual(sandboxSales('conn-2', ['2026-10-12', '2026-10-13'], 'CAD'));
    expect(a.every((r) => r.grossMinor > 0 && Number.isInteger(r.grossMinor))).toBe(true);
  });
  it('reads an .xlsx workbook and semicolon CSVs', () => {
    const rows = [['Name', 'Email', 'Accepts Marketing'], ['Ana Lima', 'ana@example.com', 'yes'], ['Bo & Co', 'bo@example.com', '']];
    expect(readXlsx(writeXlsx(rows))).toEqual(rows);
    expect(csvRecords('Name;Email\r\n"Lima; Ana";ana@example.com\r\n')).toEqual([['Name', 'Email'], ['Lima; Ana', 'ana@example.com']]);
    expect(csvRecords('a,b\n1,"x ""y"""\n\n')).toEqual([['a', 'b'], ['1', 'x "y"']]);
  });
});
