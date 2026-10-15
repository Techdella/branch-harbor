/**
 * Partner connections (Uber Direct, Deliverect, property portals) stored in the shared `connections` table:
 * one row per provider and location/office, non-secret settings in `config`, secrets AES-GCM encrypted in
 * `credentialsEncrypted` (never returned — only masked). Status is computed honestly:
 *   not_configured → no row; disabled → switched off; sandbox → missing credentials/settings or mode "sandbox"
 *   (nothing is sent); awaiting_portal → pull feed configured but the portal has not fetched it yet;
 *   live → enabled, complete, mode "live", last test passed (and, for pull feeds, fetched by the portal).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Services } from '../context.ts';
import { connections, partnerSyncLog } from '../db/schema/index.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { maskSecret, PartnerHttpError } from '../integrations/partners/http.ts';
import { PORTAL_ADAPTERS, type PortalId } from '../integrations/realty-portals.ts';

type Connection = typeof connections.$inferSelect;

export const PARTNER_PROVIDERS = ['uber_direct', 'deliverect', 'rightmove', 'idealista', 'reso_xml', 'reaxml'] as const;
export type PartnerProvider = (typeof PARTNER_PROVIDERS)[number];
export const isPartnerProvider = (p: string): p is PartnerProvider => (PARTNER_PROVIDERS as readonly string[]).includes(p);

export interface PartnerField { key: string; label: string; required: boolean; secret?: boolean; help?: string; type?: 'text' | 'select' | 'boolean'; options?: string[] }
export interface PartnerCatalogEntry {
  provider: PartnerProvider; name: string; kind: 'delivery' | 'pos' | 'portal'; industry: 'foods' | 'realty';
  delivery?: 'push' | 'pull'; countries?: string[]; fields: PartnerField[]; approvals: string;
}

export const PARTNER_CATALOG: PartnerCatalogEntry[] = [
  {
    provider: 'uber_direct', name: 'Uber Direct', kind: 'delivery', industry: 'foods',
    approvals: 'Requires an Uber Direct business account (Uber Direct dashboard → Developer) with API access for your country.',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true, secret: true },
      { key: 'clientSecret', label: 'Client secret', required: true, secret: true },
      { key: 'customerId', label: 'Customer ID', required: true, help: 'Shown in the Uber Direct dashboard (Developer tab)' },
      { key: 'webhookSigningKey', label: 'Webhook signing key', required: true, secret: true, help: 'Uber Direct dashboard → Webhooks; the webhook URL is shown below' },
      { key: 'feeMode', label: 'Delivery fee', required: true, type: 'select', options: ['absorb', 'pass_through'], help: 'absorb: customers pay your zone fee and you pay Uber; pass_through: customers pay the Uber quote' },
      { key: 'externalStoreId', label: 'Store id (optional)', required: false },
    ],
  },
  {
    provider: 'deliverect', name: 'Deliverect', kind: 'pos', industry: 'foods',
    approvals: 'Requires Deliverect partner credentials (staging first; production after Deliverect certification) and the customer’s Deliverect account/location.',
    fields: [
      { key: 'clientId', label: 'Client ID', required: true, secret: true },
      { key: 'clientSecret', label: 'Client secret', required: true, secret: true },
      { key: 'webhookSecret', label: 'Webhook HMAC secret (production)', required: false, secret: true, help: 'In staging Deliverect signs with the channel link id' },
      { key: 'environment', label: 'Environment', required: true, type: 'select', options: ['staging', 'production'] },
      { key: 'accountId', label: 'Deliverect account id', required: true },
      { key: 'deliverectLocationId', label: 'Deliverect location id', required: true },
      { key: 'channelName', label: 'Channel name (POS injection)', required: false },
      { key: 'channelLinkId', label: 'Channel link id (POS injection)', required: false },
      { key: 'posInjection', label: 'Send accepted BranchHarbor orders to the POS', required: false, type: 'boolean' },
      { key: 'marketplaceOrders', label: 'Receive marketplace orders (Uber Eats, Deliveroo, DoorDash, Just Eat)', required: false, type: 'boolean' },
      { key: 'autoAccept', label: 'Auto-accept marketplace orders', required: false, type: 'boolean' },
    ],
  },
  ...(Object.values(PORTAL_ADAPTERS).map((p): PartnerCatalogEntry => ({
    provider: p.id, name: p.name, kind: 'portal', industry: 'realty', delivery: p.delivery, countries: p.countries,
    approvals: p.id === 'rightmove' ? 'Rightmove must set up a Real Time Datafeed network for BranchHarbor and issue the network id and client certificate.'
      : p.id === 'idealista' ? 'idealista must enable feed import for your professional account and be given the feed URL below.'
      : p.id === 'reso_xml' ? 'The portal (e.g. Zillow Listing Feeds) must approve the feed for your brokerage and be given the feed URL below.'
      : 'realestate.com.au / Domain must enable REAXML import for your agency and be given the feed URL below.',
    fields: p.configFields,
  }))),
];
export const catalogEntry = (p: PartnerProvider) => PARTNER_CATALOG.find((c) => c.provider === p)!;

export function partnerCredentials(s: Pick<Services, 'cfg'>, c: Connection): Record<string, string> {
  if (!c.credentialsEncrypted) return {};
  try { return JSON.parse(decrypt(c.credentialsEncrypted, s.cfg.ENCRYPTION_KEY)); } catch { return {}; }
}
export const encryptCredentials = (s: Pick<Services, 'cfg'>, creds: Record<string, string>) => (Object.keys(creds).length ? encrypt(JSON.stringify(creds), s.cfg.ENCRYPTION_KEY) : null);

const missingFieldDefs = (provider: PartnerProvider, config: Record<string, unknown>, creds: Record<string, string>) =>
  catalogEntry(provider).fields.filter((f) => f.required && !(f.secret ? creds[f.key] : config[f.key] !== undefined && config[f.key] !== ''));
export function missingFields(provider: PartnerProvider, config: Record<string, unknown>, creds: Record<string, string>) {
  return missingFieldDefs(provider, config, creds).map((f) => f.label);
}
/** Field keys of the missing required settings (same order as `missingFields`), for apps that translate the labels. */
export function missingFieldKeys(provider: PartnerProvider, config: Record<string, unknown>, creds: Record<string, string>) {
  return missingFieldDefs(provider, config, creds).map((f) => f.key);
}

export type PartnerStatus = 'not_configured' | 'disabled' | 'sandbox' | 'awaiting_portal' | 'live' | 'error';

/** Why a connection has its status, as a stable code (apps translate it; `reason` is the English line). */
export type PartnerReasonCode = 'not_configured' | 'disabled' | 'missing_credentials' | 'credentials_saved' | 'last_error' | 'test_failed' | 'awaiting_fetch' | 'live';

export function partnerStatus(c: Connection | undefined, creds: Record<string, string>): { status: PartnerStatus; reason: string; code: PartnerReasonCode } {
  if (!c) return { status: 'not_configured', reason: 'Not configured', code: 'not_configured' };
  const provider = c.provider as PartnerProvider;
  const cfg = c.config;
  if (cfg.enabled === false) return { status: 'disabled', reason: 'Switched off', code: 'disabled' };
  const missing = missingFields(provider, cfg, creds);
  if (missing.length) return { status: 'sandbox', reason: `Sandbox — missing ${missing.join(', ')}`, code: 'missing_credentials' };
  if (cfg.mode !== 'live') return { status: 'sandbox', reason: 'Sandbox — credentials saved; switch to live after a successful test', code: 'credentials_saved' };
  if (c.state !== 'connected') return c.lastError ? { status: 'error', reason: c.lastError, code: 'last_error' } : { status: 'error', reason: 'Last connection test failed — test again', code: 'test_failed' };
  if (catalogEntry(provider).delivery === 'pull' && !cfg.lastFetchedAt) return { status: 'awaiting_portal', reason: 'Feed URL ready — waiting for the portal to fetch it', code: 'awaiting_fetch' };
  return { status: 'live', reason: 'Live', code: 'live' };
}
export const isLive = (c: Connection | undefined, creds: Record<string, string>) => partnerStatus(c, creds).status === 'live';
/** Live for outbound calls: pull feeds count as live once configured (the portal fetching is what confirms them). */
export const callsAllowed = (c: Connection | undefined, creds: Record<string, string>) => ['live', 'awaiting_portal'].includes(partnerStatus(c, creds).status);

export async function partnerConnection(s: Pick<Services, 'db'>, provider: PartnerProvider, locationId: string) {
  const [c] = await s.db.select().from(connections).where(and(eq(connections.provider, provider), eq(connections.locationId, locationId))).orderBy(desc(connections.createdAt)).limit(1);
  return c;
}

/** Feed tokens are derived (HMAC of the connection id + version) so they can be shown again and rotated. */
export function feedToken(s: Pick<Services, 'cfg'>, connectionId: string, version: number) {
  return createHmac('sha256', s.cfg.ENCRYPTION_KEY).update(`portal-feed:${connectionId}:${version}`).digest('base64url').slice(0, 32);
}
export function feedUrl(s: Pick<Services, 'cfg'>, c: Connection) {
  const p = c.provider as PortalId;
  const ext = PORTAL_ADAPTERS[p]?.format ?? 'xml';
  return `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/feeds/realty/${c.id}/${feedToken(s, c.id, Number(c.config.feedTokenVersion ?? 1))}.${ext}`;
}

export async function logSync(s: Pick<Services, 'db'>, e: { organizationId: string; connectionId: string | null; provider: string; locationId?: string | null; action: string; targetType?: string; targetId?: string; status: 'ok' | 'sandbox' | 'error' | 'skipped'; httpStatus?: number | null; message?: string | null; detail?: Record<string, unknown> }) {
  await s.db.insert(partnerSyncLog).values({ ...e, locationId: e.locationId ?? null, httpStatus: e.httpStatus ?? null, message: e.message ?? null, detail: e.detail ?? {} });
}
export const errInfo = (err: unknown) => ({ message: (err as Error).message, httpStatus: err instanceof PartnerHttpError ? err.status : null });

export async function lastSyncs(s: Pick<Services, 'db'>, connectionIds: string[]) {
  if (!connectionIds.length) return new Map<string, typeof partnerSyncLog.$inferSelect>();
  const rows = await s.db.select().from(partnerSyncLog).where(inArray(partnerSyncLog.connectionId, connectionIds)).orderBy(desc(partnerSyncLog.createdAt)).limit(500);
  const m = new Map<string, typeof partnerSyncLog.$inferSelect>();
  for (const r of rows) if (r.connectionId && !m.has(r.connectionId)) m.set(r.connectionId, r);
  return m;
}

export function serializePartnerConnection(s: Pick<Services, 'cfg'>, c: Connection, extra: Record<string, unknown> = {}) {
  const creds = partnerCredentials(s, c);
  const entry = catalogEntry(c.provider as PartnerProvider);
  const st = partnerStatus(c, creds);
  const { lastFetchedAt, feedTokenVersion, busy, ...config } = c.config as Record<string, unknown>;
  return {
    id: c.id, provider: c.provider, name: entry.name, kind: entry.kind, locationId: c.locationId,
    enabled: c.config.enabled !== false, mode: c.config.mode === 'live' ? 'live' : 'sandbox', status: st.status, statusReason: st.reason, statusReasonCode: st.code,
    config, credentials: Object.fromEntries(entry.fields.filter((f) => f.secret).map((f) => [f.key, { set: !!creds[f.key], masked: maskSecret(creds[f.key]) }])),
    missing: missingFields(c.provider as PartnerProvider, c.config, creds),
    missingKeys: missingFieldKeys(c.provider as PartnerProvider, c.config, creds),
    state: c.state, lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null, lastErrorAt: c.lastErrorAt?.toISOString() ?? null, lastError: c.lastError,
    lastFetchedAt: (lastFetchedAt as string) ?? null, busy: busy ?? null,
    feedUrl: entry.delivery === 'pull' ? feedUrl(s, c) : null,
    webhookUrl: c.provider === 'uber_direct' ? `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/uber-direct` : c.provider === 'deliverect' ? `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/deliverect` : null,
    ...extra,
  };
}
