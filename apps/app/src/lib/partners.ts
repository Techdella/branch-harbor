'use client';

/**
 * Partner integrations (Uber Direct, Deliverect, property portals). Live: /v1/orgs/:orgId/partner-connections and
 * the Deliverect location actions. Sample mode / offline fallback: an in-memory sandbox (nothing is ever "live").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiMode, enterFallback } from './api';
import { http } from './http/client';
import { orgId } from './http/workspace';

export type PartnerStatus = 'not_configured' | 'disabled' | 'sandbox' | 'awaiting_portal' | 'live' | 'error';
export interface PartnerField { key: string; label: string; required: boolean; secret?: boolean; help?: string; type?: 'text' | 'select' | 'boolean'; options?: string[] }
export interface PartnerCatalogEntry { provider: string; name: string; kind: 'delivery' | 'pos' | 'portal'; industry: 'foods' | 'realty'; delivery?: 'push' | 'pull'; countries?: string[]; fields: PartnerField[]; approvals: string }
export interface PartnerLocation { id: string; name: string; country: string; currency: string; canManage: boolean; uberDirectAvailable: boolean }
export interface PartnerResult { at: string; action: string; status: string; message: string | null }
export interface PartnerConnection {
  id: string; provider: string; name: string; kind: string; locationId: string; enabled: boolean; mode: 'sandbox' | 'live'; status: PartnerStatus; statusReason: string;
  /** Stable code for `statusReason` (translated via `partners.reason.*`); `missingKeys` are the field keys behind `missing`. */
  statusReasonCode?: string; missingKeys?: string[];
  config: Record<string, unknown>; credentials: Record<string, { set: boolean; masked: string | null }>; missing: string[];
  state: string; lastSuccessAt: string | null; lastError: string | null; lastFetchedAt: string | null; busy: { paused: boolean; until?: string | null } | null;
  feedUrl: string | null; webhookUrl: string | null; canManage?: boolean; lastResult?: PartnerResult | null;
}
/** `code` + `params` (newer APIs) let the panel phrase the outcome in the user's language; `message` is the English line. */
export interface PartnerTestResult { ok: boolean; sandbox: boolean; message: string; code?: string; params?: Record<string, string | number | string[]> }
export interface PartnerOverview { catalog: PartnerCatalogEntry[]; locations: PartnerLocation[]; items: PartnerConnection[] }
export type Settings = Record<string, string | boolean | null>;

export interface PartnersApi {
  overview(industry: 'foods' | 'realty'): Promise<PartnerOverview>;
  create(provider: string, locationId: string, settings: Settings): Promise<PartnerConnection>;
  update(id: string, body: { settings?: Settings; enabled?: boolean; mode?: 'sandbox' | 'live' }): Promise<PartnerConnection>;
  test(id: string): Promise<{ result: PartnerTestResult; connection: PartnerConnection }>;
  rotateFeed(id: string): Promise<PartnerConnection>;
  disconnect(id: string): Promise<PartnerConnection>;
  menuPush(locationId: string): Promise<{ status: string; message: string; products: number; soldOut: number; unmappedAllergens: Array<{ plu: string; allergen: string }> }>;
  busy(locationId: string, paused: boolean, minutes?: number): Promise<{ status: string; message: string; paused: boolean }>;
}

const o = (p: string) => `/orgs/${orgId()}${p}`;
const live: PartnersApi = {
  overview: (industry) => http.get(o('/partner-connections'), { industry }),
  create: (provider, locationId, settings) => http.post(o('/partner-connections'), { provider, locationId, settings }),
  update: (id, body) => http.patch(o(`/partner-connections/${id}`), body),
  test: (id) => http.post(o(`/partner-connections/${id}/test`), {}),
  rotateFeed: (id) => http.post(o(`/partner-connections/${id}/rotate-feed-token`), {}),
  disconnect: (id) => http.del(o(`/partner-connections/${id}`)),
  menuPush: (locationId) => http.post(o(`/foods/locations/${locationId}/deliverect/menu-push`), {}),
  busy: (locationId, paused, minutes) => http.post(o(`/foods/locations/${locationId}/deliverect/busy`), { paused, ...(minutes ? { minutes } : {}) }),
};

// ───────── Sample mode: sandbox only ─────────
const F = (key: string, label: string, required: boolean, extra: Partial<PartnerField> = {}): PartnerField => ({ key, label, required, ...extra });
const CATALOG: PartnerCatalogEntry[] = [
  { provider: 'uber_direct', name: 'Uber Direct', kind: 'delivery', industry: 'foods', approvals: 'Requires an Uber Direct business account with API access for your country.', fields: [F('clientId', 'Client ID', true, { secret: true }), F('clientSecret', 'Client secret', true, { secret: true }), F('customerId', 'Customer ID', true), F('webhookSigningKey', 'Webhook signing key', true, { secret: true }), F('feeMode', 'Delivery fee', true, { type: 'select', options: ['absorb', 'pass_through'] }), F('externalStoreId', 'Store id (optional)', false)] },
  { provider: 'deliverect', name: 'Deliverect', kind: 'pos', industry: 'foods', approvals: 'Requires Deliverect partner credentials (staging first; production after certification).', fields: [F('clientId', 'Client ID', true, { secret: true }), F('clientSecret', 'Client secret', true, { secret: true }), F('webhookSecret', 'Webhook HMAC secret (production)', false, { secret: true }), F('environment', 'Environment', true, { type: 'select', options: ['staging', 'production'] }), F('accountId', 'Deliverect account id', true), F('deliverectLocationId', 'Deliverect location id', true), F('posInjection', 'Send accepted BranchHarbor orders to the POS', false, { type: 'boolean' }), F('marketplaceOrders', 'Receive marketplace orders', false, { type: 'boolean' })] },
  { provider: 'rightmove', name: 'Rightmove', kind: 'portal', industry: 'realty', delivery: 'push', countries: ['GB'], approvals: 'Rightmove must set up a Real Time Datafeed network and issue a client certificate.', fields: [F('networkId', 'Network ID', true), F('branchId', 'Branch ID', true), F('certificatePfxBase64', 'Client certificate (PKCS#12, base64)', true, { secret: true }), F('certificatePassword', 'Certificate password', false, { secret: true })] },
  { provider: 'idealista', name: 'idealista', kind: 'portal', industry: 'realty', delivery: 'pull', countries: ['ES', 'PT', 'IT'], approvals: 'idealista must enable feed import for your account.', fields: [F('customerCode', 'idealista customer code', true), F('contactEmail', 'Contact email', true)] },
  { provider: 'reso_xml', name: 'Zillow / RESO XML', kind: 'portal', industry: 'realty', delivery: 'pull', countries: ['US', 'CA'], approvals: 'The portal must approve the feed for your brokerage.', fields: [F('feedId', 'Portal feed / account id', true), F('brokerageName', 'Brokerage name', true)] },
  { provider: 'reaxml', name: 'REAXML (realestate.com.au / Domain)', kind: 'portal', industry: 'realty', delivery: 'pull', countries: ['AU', 'NZ'], approvals: 'realestate.com.au / Domain must enable REAXML import.', fields: [F('agentId', 'Portal agent / office id', true)] },
];
const SAMPLE_LOCS: Record<'foods' | 'realty', PartnerLocation[]> = {
  foods: [{ id: 'mock-sea', name: 'Fremont', country: 'US', currency: 'USD', canManage: true, uberDirectAvailable: true }, { id: 'mock-lon', name: 'Spitalfields', country: 'GB', currency: 'GBP', canManage: true, uberDirectAvailable: true }],
  realty: [{ id: 'mock-lon', name: 'London Hampstead', country: 'GB', currency: 'GBP', canManage: true, uberDirectAvailable: true }, { id: 'mock-syd', name: 'Sydney Paddington', country: 'AU', currency: 'AUD', canManage: true, uberDirectAvailable: true }],
};
let mockItems: PartnerConnection[] = [];
const mk = (provider: string, locationId: string, settings: Settings): PartnerConnection => {
  const entry = CATALOG.find((c) => c.provider === provider)!;
  const config: Record<string, unknown> = {};
  const credentials: PartnerConnection['credentials'] = {};
  for (const f of entry.fields) {
    const v = settings[f.key];
    if (f.secret) credentials[f.key] = { set: !!v, masked: v ? '••••' : null };
    else if (v !== undefined) config[f.key] = v;
  }
  const missingDefs = entry.fields.filter((f) => f.required && !(f.secret ? credentials[f.key]?.set : config[f.key]));
  const missing = missingDefs.map((f) => f.label);
  return {
    id: `mock-${provider}-${locationId}`, provider, name: entry.name, kind: entry.kind, locationId, enabled: true, mode: 'sandbox', status: 'sandbox',
    statusReason: missing.length ? `Sandbox — missing ${missing.join(', ')}` : 'Sandbox (sample data — never connected)', statusReasonCode: missing.length ? 'missing_credentials' : 'sample', missingKeys: missingDefs.map((f) => f.key),
    config, credentials, missing, state: 'disconnected',
    lastSuccessAt: null, lastError: null, lastFetchedAt: null, busy: null, feedUrl: entry.delivery === 'pull' ? 'https://api.example.com/v1/feeds/realty/sample/•••.xml' : null,
    webhookUrl: entry.kind !== 'portal' ? `https://api.example.com/v1/webhooks/${provider === 'uber_direct' ? 'uber-direct' : 'deliverect'}` : null, canManage: true, lastResult: null,
  };
};
const delay = () => new Promise((r) => setTimeout(r, 120));
const find = (id: string) => { const c = mockItems.find((x) => x.id === id); if (!c) throw new ApiError('not_found', 'Partner connection not found', 404); return c; };
const mock: PartnersApi = {
  async overview(industry) {
    await delay();
    if (!mockItems.length) mockItems = [mk('uber_direct', 'mock-sea', { customerId: 'sample', feeMode: 'absorb' }), mk('rightmove', 'mock-lon', { networkId: '0', branchId: '0' })];
    const catalog = CATALOG.filter((c) => c.industry === industry);
    return { catalog, locations: SAMPLE_LOCS[industry], items: mockItems.filter((i) => catalog.some((c) => c.provider === i.provider)) };
  },
  async create(provider, locationId, settings) { await delay(); const c = mk(provider, locationId, settings); mockItems.push(c); return c; },
  async update(id, body) {
    await delay();
    const c = find(id);
    if (body.mode === 'live') throw new ApiError('test_required', 'Sample data: connections can’t go live.', 409);
    Object.assign(c, mk(c.provider, c.locationId, { ...(c.config as Settings), ...(body.settings ?? {}) }), { enabled: body.enabled ?? c.enabled, id: c.id });
    if (!c.enabled) Object.assign(c, { status: 'disabled', statusReason: 'Switched off', statusReasonCode: 'disabled' });
    return c;
  },
  async test(id) { await delay(); const c = find(id); const r: PartnerTestResult = { ok: false, sandbox: true, message: 'Sample data: no partner is contacted. Connect the API to test real credentials.', code: 'sample' }; c.lastResult = { at: new Date().toISOString(), action: 'test', status: 'sandbox', message: r.message }; return { result: r, connection: c }; },
  async rotateFeed(id) { await delay(); return find(id); },
  async disconnect(id) { await delay(); const c = find(id); Object.assign(c, { enabled: false, status: 'disabled', statusReason: 'Switched off', statusReasonCode: 'disabled' }); return c; },
  async menuPush() { await delay(); return { status: 'sandbox', message: 'Sandbox: menu snapshot built, nothing sent to Deliverect', products: 12, soldOut: 1, unmappedAllergens: [] }; },
  async busy(_l, paused) { await delay(); return { status: 'sandbox', message: paused ? 'Sandbox: busy mode recorded, marketplaces not paused' : 'Sandbox: busy mode cleared', paused }; },
};

async function api(): Promise<PartnersApi> {
  return apiMode() === 'live' ? live : mock;
}
async function run<T>(fn: (a: PartnersApi) => Promise<T>): Promise<T> {
  const a = await api();
  try {
    return await fn(a);
  } catch (e) {
    if (a === live && e instanceof ApiError && e.isNetwork) { enterFallback(); return fn(mock); }
    throw e;
  }
}

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

export function usePartners<T>(fn: (a: PartnersApi) => Promise<T>, deps: unknown[]) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    run(fnRef.current).then((data) => { if (id === seq.current) setRes({ status: 'ready', data }); }, (e) => { if (id === seq.current) setRes({ status: 'error', error: asErr(e) }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...res, reload: () => load(true) };
}

export function usePartnersMutation<A extends unknown[], R>(fn: (a: PartnersApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const go = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true); setError(null);
    try { return await run((a) => fnRef.current(a, ...args)); } catch (e) { setError(asErr(e)); return undefined; } finally { setPending(false); }
  }, []);
  return { run: go, pending, error };
}
