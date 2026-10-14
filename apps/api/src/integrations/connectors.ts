import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export const CONNECTOR_PROVIDERS = ['wordpress', 'woocommerce', 'shopify', 'square', 'mindbody', 'google_business', 'meta'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export interface ConnectorCatalogEntry {
  provider: ConnectorProvider;
  name: string;
  kind: 'website' | 'commerce' | 'booking' | 'pos' | 'marketing';
  /** Honest support status shown in the integrations catalogue. */
  support: 'tested' | 'limited' | 'requires_setup' | 'planned';
  directions: Array<'import' | 'export' | 'bidirectional'>;
  entities: string[];
}

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  { provider: 'wordpress', name: 'WordPress', kind: 'website', support: 'limited', directions: ['export'], entities: ['page', 'location'] },
  { provider: 'woocommerce', name: 'WooCommerce', kind: 'commerce', support: 'limited', directions: ['import', 'bidirectional'], entities: ['product', 'variant', 'order'] },
  { provider: 'shopify', name: 'Shopify', kind: 'commerce', support: 'requires_setup', directions: ['import'], entities: ['product', 'variant', 'order', 'location'] },
  { provider: 'square', name: 'Square', kind: 'pos', support: 'requires_setup', directions: ['import'], entities: ['location', 'order', 'catalog_item'] },
  { provider: 'mindbody', name: 'Mindbody', kind: 'booking', support: 'requires_setup', directions: ['import'], entities: ['location', 'class_type', 'class_occurrence'] },
  { provider: 'google_business', name: 'Google Business Profile', kind: 'marketing', support: 'planned', directions: ['export'], entities: ['location'] },
  { provider: 'meta', name: 'Meta (Facebook & Instagram)', kind: 'marketing', support: 'planned', directions: ['export'], entities: ['campaign'] },
];

export interface ExternalRecord { entityType: string; externalId: string; data: Record<string, unknown> }
export interface TestResult { ok: boolean; state: 'connected' | 'degraded' | 'disconnected' | 'authorization_expired'; message: string; sandbox: boolean }

export interface ConnectorAdapter {
  test(config: Record<string, unknown>, credentials: Record<string, string> | null): Promise<TestResult>;
  fetch(config: Record<string, unknown>, credentials: Record<string, string> | null, cursor: Record<string, unknown> | null): Promise<{ records: ExternalRecord[]; cursor: Record<string, unknown> | null; sandbox: boolean }>;
}

const sampleRecords = (provider: string): ExternalRecord[] => {
  switch (provider) {
    case 'woocommerce':
    case 'shopify':
      return [
        { entityType: 'product', externalId: `${provider}-p-101`, data: { name: 'Organic cotton mat strap', sku: 'STRAP-01' } },
        { entityType: 'product', externalId: `${provider}-p-102`, data: { name: 'Cork block', sku: 'BLOCK-CORK' } },
        { entityType: 'location', externalId: `${provider}-loc-9`, data: { name: 'Unknown warehouse' } },
      ];
    case 'mindbody':
      return [
        { entityType: 'location', externalId: 'mb-site-1', data: { name: 'Queen West' } },
        { entityType: 'class_type', externalId: 'mb-ct-55', data: { name: 'Hot Vinyasa' } },
      ];
    case 'square':
      return [{ entityType: 'location', externalId: 'sq-L1', data: { name: 'Ballard' } }];
    default:
      return [];
  }
};

async function probe(url: string, headers: Record<string, string>): Promise<TestResult> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, state: 'authorization_expired', message: `Authorisation rejected (${res.status})`, sandbox: false };
    if (!res.ok) return { ok: false, state: 'degraded', message: `Unexpected response ${res.status}`, sandbox: false };
    return { ok: true, state: 'connected', message: 'Connection verified', sandbox: false };
  } catch (err) {
    return { ok: false, state: 'disconnected', message: `Could not reach the service: ${(err as Error).message}`, sandbox: false };
  }
}

/**
 * Connector adapters. Each works in sandbox mode (sample data, no network) when credentials are
 * missing, so the mapping and sync-status UX can be exercised end to end.
 */
export function createConnectors(cfg: Config, log: FastifyBaseLogger): Record<ConnectorProvider, ConnectorAdapter> {
  const sandboxAdapter = (provider: string): ConnectorAdapter => ({
    async test() {
      return { ok: true, state: 'connected', message: `${provider}: sandbox mode (no credentials configured) — sample data only`, sandbox: true };
    },
    async fetch() {
      return { records: sampleRecords(provider), cursor: { syncedAt: new Date().toISOString() }, sandbox: true };
    },
  });

  const wp: ConnectorAdapter = {
    async test(config, creds) {
      const site = String(config.siteUrl ?? '');
      if (!site || !creds?.username || !creds?.applicationPassword) return sandboxAdapter('wordpress').test(config, creds);
      const auth = Buffer.from(`${creds.username}:${creds.applicationPassword}`).toString('base64');
      return probe(`${site.replace(/\/$/, '')}/wp-json/wp/v2/users/me?context=edit`, { Authorization: `Basic ${auth}` });
    },
    fetch: sandboxAdapter('wordpress').fetch,
  };

  const woo: ConnectorAdapter = {
    async test(config, creds) {
      const site = String(config.siteUrl ?? '');
      const key = creds?.consumerKey ?? cfg.WOOCOMMERCE_CONSUMER_KEY;
      const secret = creds?.consumerSecret ?? cfg.WOOCOMMERCE_CONSUMER_SECRET;
      if (!site || !key || !secret) return sandboxAdapter('woocommerce').test(config, creds);
      const auth = Buffer.from(`${key}:${secret}`).toString('base64');
      return probe(`${site.replace(/\/$/, '')}/wp-json/wc/v3/system_status`, { Authorization: `Basic ${auth}` });
    },
    async fetch(config, creds, cursor) {
      const site = String(config.siteUrl ?? '');
      const key = creds?.consumerKey ?? cfg.WOOCOMMERCE_CONSUMER_KEY;
      const secret = creds?.consumerSecret ?? cfg.WOOCOMMERCE_CONSUMER_SECRET;
      if (!site || !key || !secret) return sandboxAdapter('woocommerce').fetch(config, creds, cursor);
      const auth = Buffer.from(`${key}:${secret}`).toString('base64');
      const res = await fetch(`${site.replace(/\/$/, '')}/wp-json/wc/v3/products?per_page=50`, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) throw new Error(`WooCommerce returned ${res.status}`);
      const items = (await res.json()) as Array<{ id: number; name: string; sku: string }>;
      return { records: items.map((p) => ({ entityType: 'product', externalId: String(p.id), data: { name: p.name, sku: p.sku } })), cursor: { syncedAt: new Date().toISOString() }, sandbox: false };
    },
  };

  const shopify: ConnectorAdapter = {
    async test(config, creds) {
      const shop = String(config.shopDomain ?? '');
      if (!shop || !creds?.accessToken) return sandboxAdapter('shopify').test(config, creds);
      return probe(`https://${shop}/admin/api/2025-07/shop.json`, { 'X-Shopify-Access-Token': creds.accessToken });
    },
    fetch: sandboxAdapter('shopify').fetch,
  };

  const square: ConnectorAdapter = {
    async test(config, creds) {
      const token = creds?.accessToken ?? cfg.SQUARE_ACCESS_TOKEN;
      if (!token) return sandboxAdapter('square').test(config, creds);
      const host = cfg.SQUARE_ENVIRONMENT === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
      return probe(`https://${host}/v2/locations`, { Authorization: `Bearer ${token}`, 'Square-Version': '2025-07-16' });
    },
    fetch: sandboxAdapter('square').fetch,
  };

  const mindbody: ConnectorAdapter = {
    async test(config, creds) {
      const apiKey = creds?.apiKey ?? cfg.MINDBODY_API_KEY;
      const siteId = String(config.siteId ?? cfg.MINDBODY_SITE_ID ?? '');
      if (!apiKey || !siteId) return sandboxAdapter('mindbody').test(config, creds);
      return probe('https://api.mindbodyonline.com/public/v6/site/locations', { 'Api-Key': apiKey, SiteId: siteId });
    },
    fetch: sandboxAdapter('mindbody').fetch,
  };

  log.debug('[connectors] adapters initialised');
  return {
    wordpress: wp,
    woocommerce: woo,
    shopify,
    square,
    mindbody,
    google_business: sandboxAdapter('google_business'),
    meta: sandboxAdapter('meta'),
  };
}
