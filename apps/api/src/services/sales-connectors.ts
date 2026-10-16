/**
 * POS and booking sales connectors (Network → Connections, module `network.sales_connectors`).
 *
 * - One connection per location and provider. OAuth providers (Square, Shopify, Lightspeed, Clover) send the merchant
 *   to the vendor's consent screen with a single-use state (30 minutes); partner-grant providers (Toast) and
 *   activation-link providers (Mindbody) are verified with the platform credentials. Without platform credentials a
 *   connection runs in sandbox mode: deterministic sample sales, flagged `sandbox` everywhere.
 * - Sync: the adapter returns sale records; they are bucketed by the location's local business date, channel and
 *   currency and upserted into `daily_sales` (idempotent on location + source + date + channel + currency, with a
 *   content hash so unchanged days are counted, not rewritten). Days in the window without sales get a zero row so
 *   "no sales" is distinguishable from "not synced". Nightly: the last three local days; manual resync: up to 92 days.
 * - Currencies are never converted: rows in another currency than the location's are kept and reported, never added.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { SALES_CONNECTORS, addFigures, datesBetween, netSales, salesConnectorMeta, zeroFigures, type DailySalesFigures, type SalesChannel, type SalesConnectorProvider } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { dailySales, locations, salesConnections, salesSyncRuns } from '../db/schema/index.ts';
import { SALES_ADAPTERS, sandboxSales } from '../integrations/sales/index.ts';
import type { SaleRecord } from '../integrations/sales/types.ts';
import { PartnerHttpError } from '../integrations/partners/http.ts';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';

export type SalesConnectionRow = typeof salesConnections.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

export const OAUTH_STATE_MINUTES = 30;
export const MAX_RESYNC_DAYS = 92;
export const NIGHTLY_DAYS = 3;

export const callbackUrl = (s: Pick<Services, 'cfg'>) => `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/sales-connectors/oauth/callback`;

export function salesCredentials(s: Pick<Services, 'cfg'>, c: SalesConnectionRow): Record<string, string> {
  if (!c.credentialsEncrypted) return {};
  try { return JSON.parse(decrypt(c.credentialsEncrypted, s.cfg.ENCRYPTION_KEY)) as Record<string, string>; } catch { return {}; }
}
const sealed = (s: Pick<Services, 'cfg'>, creds: Record<string, string>) => (Object.keys(creds).length ? encrypt(JSON.stringify(creds), s.cfg.ENCRYPTION_KEY) : null);

export function serializeSalesConnection(c: SalesConnectionRow, extra: Record<string, unknown> = {}) {
  const meta = salesConnectorMeta(c.provider);
  const { activationUrl, ...config } = c.config as Record<string, unknown>;
  return {
    id: c.id, locationId: c.locationId, provider: c.provider as SalesConnectorProvider, name: meta?.name ?? c.provider, flow: meta?.flow ?? 'oauth',
    status: c.status, mode: c.mode as 'sandbox' | 'live', config, activationUrl: (activationUrl as string | undefined) ?? null, hasCredentials: !!c.credentialsEncrypted,
    externalAccountName: c.externalAccountName, lastSyncAt: c.lastSyncAt?.toISOString() ?? null, lastSyncStatus: c.lastSyncStatus, lastError: c.lastError,
    lastErrorAt: c.lastErrorAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(), ...extra,
  };
}

export async function loadConnection(db: Exec, organizationId: string, id: string) {
  const [c] = await db.select().from(salesConnections).where(and(eq(salesConnections.id, id), eq(salesConnections.organizationId, organizationId)));
  if (!c) throw notFound('Connection');
  return c;
}

async function locationOf(db: Exec, organizationId: string, locationId: string) {
  const [l] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!l) throw notFound('Location');
  return l;
}

/** Starts (or restarts) the connect flow. Returns where to send the person next, if anywhere. */
async function startConnect(s: Services, c: SalesConnectionRow, actorUserId: string) {
  const adapter = SALES_ADAPTERS[c.provider as SalesConnectorProvider];
  const meta = salesConnectorMeta(c.provider)!;
  const live = adapter.platformReady(s.cfg);
  if (meta.flow === 'oauth') {
    const state = randomToken(24);
    await s.db.update(salesConnections).set({ status: 'pending_authorisation', mode: live ? 'live' : 'sandbox', oauthStateHash: sha256(state), oauthStateExpiresAt: new Date(Date.now() + OAUTH_STATE_MINUTES * 60_000), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
    const authorizeUrl = live
      ? adapter.authorizeUrl!(s.cfg, { state, redirectUri: callbackUrl(s), config: c.config })
      // Sandbox: the same callback completes the flow without leaving BranchHarbor (no vendor is contacted).
      : `${callbackUrl(s)}?${new URLSearchParams({ state, code: 'sandbox', provider: c.provider }).toString()}`;
    return { authorizeUrl, activationUrl: null };
  }
  // Partner grant (Toast) / activation link (Mindbody): verify with the platform credentials, or sandbox.
  if (!live) {
    const [u] = await s.db.update(salesConnections).set({ status: 'connected', mode: 'sandbox', lastError: null, updatedAt: new Date() }).where(eq(salesConnections.id, c.id)).returning();
    await queueSync(s, u!, 'initial', null, null, actorUserId);
    return { authorizeUrl: null, activationUrl: null };
  }
  try {
    const r = await adapter.activate!(s.cfg, s.partnerFetch, { config: c.config });
    const pending = !!r.activationUrl;
    const [u] = await s.db.update(salesConnections).set({
      status: pending ? 'pending_authorisation' : 'connected', mode: 'live', credentialsEncrypted: sealed(s, r.creds), externalAccountName: r.accountName ?? c.externalAccountName,
      config: { ...c.config, ...(r.config ?? {}), activationUrl: r.activationUrl ?? undefined }, lastError: null, updatedAt: new Date(),
    }).where(eq(salesConnections.id, c.id)).returning();
    if (!pending) await queueSync(s, u!, 'initial', null, null, actorUserId);
    return { authorizeUrl: null, activationUrl: r.activationUrl ?? null };
  } catch (err) {
    await s.db.update(salesConnections).set({ status: 'error', lastError: (err as Error).message, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
    if (err instanceof PartnerHttpError && err.status === 400) throw validationError(err.message);
    throw new AppError(502, 'connector_unreachable', err instanceof Error ? err.message : 'The vendor could not be reached');
  }
}

export async function createSalesConnection(s: Services, organizationId: string, input: { locationId: string; provider: SalesConnectorProvider; config: Record<string, unknown> }, actorUserId: string) {
  await locationOf(s.db, organizationId, input.locationId);
  const meta = salesConnectorMeta(input.provider);
  if (!meta) throw validationError('Unknown provider', { provider: 'Unknown provider' });
  const config = Object.fromEntries(Object.entries(input.config).filter(([k]) => meta.configFields.includes(k) || k === 'includeOnline' || k === 'includeOnlineStore'));
  const [existing] = await s.db.select().from(salesConnections).where(and(eq(salesConnections.locationId, input.locationId), eq(salesConnections.provider, input.provider)));
  if (existing && existing.status !== 'disconnected') throw conflict('connection_exists', `${meta.name} is already connected for this location`, { connectionId: existing.id });
  const [row] = existing
    ? await s.db.update(salesConnections).set({ config: { ...existing.config, ...config }, status: 'pending_authorisation', lastError: null, createdBy: actorUserId, updatedAt: new Date() }).where(eq(salesConnections.id, existing.id)).returning()
    : await s.db.insert(salesConnections).values({ organizationId, locationId: input.locationId, provider: input.provider, config, createdBy: actorUserId }).returning();
  await audit(s.db, { organizationId, actorUserId, action: 'sales_connector.created', scopeKind: 'location', scopeId: input.locationId, targetType: 'sales_connection', targetId: row!.id, metadata: { provider: input.provider } });
  const next = await startConnect(s, row!, actorUserId);
  const [fresh] = await s.db.select().from(salesConnections).where(eq(salesConnections.id, row!.id));
  return { connection: fresh!, ...next };
}

/** Re-authorise (expired tokens) or re-check an activation. */
export async function reconnect(s: Services, c: SalesConnectionRow, actorUserId: string) {
  const next = await startConnect(s, c, actorUserId);
  const [fresh] = await s.db.select().from(salesConnections).where(eq(salesConnections.id, c.id));
  return { connection: fresh!, ...next };
}

/** OAuth callback: single-use state, then the code exchange (or sandbox completion). Returns the app URL to go back to. */
export async function completeOAuth(s: Services, query: Record<string, string>) {
  const appBack = (q: Record<string, string>) => `${s.cfg.APP_URL.replace(/\/$/, '')}/sales-connectors?${new URLSearchParams(q).toString()}`;
  const state = query.state ?? '';
  if (!state) return appBack({ error: 'missing_state' });
  const [c] = await s.db.select().from(salesConnections).where(eq(salesConnections.oauthStateHash, sha256(state)));
  if (!c) return appBack({ error: 'invalid_state' });
  // Single use: clear the state before anything else.
  await s.db.update(salesConnections).set({ oauthStateHash: null, oauthStateExpiresAt: null }).where(eq(salesConnections.id, c.id));
  if (!c.oauthStateExpiresAt || c.oauthStateExpiresAt < new Date()) return appBack({ error: 'state_expired', connection: c.id });
  if (query.error) {
    await s.db.update(salesConnections).set({ status: 'error', lastError: `Authorisation declined: ${query.error_description ?? query.error}`, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
    return appBack({ error: 'declined', connection: c.id });
  }
  const adapter = SALES_ADAPTERS[c.provider as SalesConnectorProvider];
  let updated: SalesConnectionRow;
  if (c.mode === 'sandbox' || !adapter.platformReady(s.cfg)) {
    if (query.code !== 'sandbox') return appBack({ error: 'invalid_code', connection: c.id });
    [updated] = (await s.db.update(salesConnections).set({ status: 'connected', mode: 'sandbox', lastError: null, externalAccountName: `${adapter.provider} sandbox`, updatedAt: new Date() }).where(eq(salesConnections.id, c.id)).returning()) as [SalesConnectionRow];
  } else {
    try {
      const r = await adapter.exchangeCode!(s.cfg, s.partnerFetch, { code: query.code ?? '', redirectUri: callbackUrl(s), config: c.config, query });
      [updated] = (await s.db.update(salesConnections).set({
        status: 'connected', mode: 'live', credentialsEncrypted: sealed(s, r.creds), config: { ...c.config, ...(r.config ?? {}) }, externalAccountName: r.accountName ?? null, lastError: null, updatedAt: new Date(),
      }).where(eq(salesConnections.id, c.id)).returning()) as [SalesConnectionRow];
    } catch (err) {
      await s.db.update(salesConnections).set({ status: 'error', lastError: (err as Error).message, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
      return appBack({ error: 'exchange_failed', connection: c.id });
    }
  }
  await audit(s.db, { organizationId: c.organizationId, actorUserId: c.createdBy, action: 'sales_connector.authorised', scopeKind: 'location', scopeId: c.locationId, targetType: 'sales_connection', targetId: c.id, metadata: { provider: c.provider, mode: updated.mode } });
  // External location mapping first when the account has several locations; otherwise start the first sync.
  if (!['square', 'shopify', 'lightspeed'].includes(c.provider) || updated.config.externalLocationId || updated.mode === 'sandbox') await queueSync(s, updated, 'initial', null, null, c.createdBy);
  return appBack({ connected: c.id });
}

/** Sync window in local dates: [from, to]. */
function windowFor(loc: Pick<LocationRow, 'timeZone'>, trigger: 'nightly' | 'manual' | 'initial', from: string | null, to: string | null, now = new Date()) {
  const today = localDateParts(now, loc.timeZone).date;
  const yesterday = addDays(today, -1);
  if (trigger === 'manual' && from && to) return { from, to };
  if (trigger === 'initial') return { from: addDays(today, -35), to: yesterday };
  return { from: addDays(today, -NIGHTLY_DAYS), to: yesterday };
}

export async function queueSync(s: Services, c: SalesConnectionRow, trigger: 'nightly' | 'manual' | 'initial', from: string | null, to: string | null, actorUserId: string | null) {
  if (c.status !== 'connected') throw conflict('connection_not_ready', 'Finish connecting before syncing', { status: c.status });
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, c.locationId));
  const w = windowFor(loc!, trigger, from, to);
  if (w.to < w.from) throw validationError('The end date must be on or after the start date', { to: 'After start' });
  if (datesBetween(w.from, w.to).length > MAX_RESYNC_DAYS) throw validationError(`Resync at most ${MAX_RESYNC_DAYS} days at a time`, { from: `Max ${MAX_RESYNC_DAYS} days` });
  const [run] = await s.db.insert(salesSyncRuns).values({ organizationId: c.organizationId, connectionId: c.id, trigger, fromDate: w.from, toDate: w.to, requestedBy: actorUserId, sandbox: c.mode === 'sandbox' }).returning();
  await s.jobs.enqueue('sales.sync', { runId: run!.id }, trigger === 'nightly' ? { jobId: `sales-nightly-${c.id}-${w.to}` } : undefined);
  return run!;
}

const hashOf = (f: DailySalesFigures) => createHash('sha256').update(JSON.stringify([f.grossMinor, f.refundsMinor, f.taxMinor, f.tipsMinor, f.discountsMinor, f.orderCount])).digest('hex').slice(0, 32);

/** Buckets sale records by local business date / channel / currency, inside the window only. */
export function bucketSales(records: SaleRecord[], timeZone: string, from: string, to: string) {
  const m = new Map<string, { date: string; channel: SalesChannel; currency: string; f: DailySalesFigures }>();
  for (const r of records) {
    const date = r.businessDate ?? (r.at ? localDateParts(r.at, timeZone).date : null);
    if (!date || date < from || date > to) continue;
    const key = `${date}|${r.channel}|${r.currency}`;
    const b = m.get(key) ?? { date, channel: r.channel, currency: r.currency.toUpperCase(), f: zeroFigures() };
    b.f = addFigures(b.f, { grossMinor: r.grossMinor, refundsMinor: r.refundsMinor, taxMinor: r.taxMinor, tipsMinor: r.tipsMinor, discountsMinor: r.discountsMinor, orderCount: r.orders });
    m.set(key, b);
  }
  return [...m.values()];
}

/** Idempotent upsert of a window of daily rows for one connection. */
export async function writeDailySales(db: Exec, c: Pick<SalesConnectionRow, 'id' | 'organizationId' | 'locationId' | 'provider' | 'mode'>, loc: Pick<LocationRow, 'currency'>, buckets: ReturnType<typeof bucketSales>, from: string, to: string) {
  const dates = datesBetween(from, to);
  // Zero rows for days without sales (in the location currency, in-store) so a quiet day is not mistaken for a gap.
  for (const d of dates) if (!buckets.some((b) => b.date === d)) buckets.push({ date: d, channel: 'in_store', currency: loc.currency, f: zeroFigures() });
  const existing = await db.select().from(dailySales).where(and(eq(dailySales.locationId, c.locationId), eq(dailySales.source, c.provider), gte(dailySales.businessDate, from), lte(dailySales.businessDate, to)));
  let written = 0, unchanged = 0;
  const keep = new Set<string>();
  for (const b of buckets) {
    const key = `${b.date}|${b.channel}|${b.currency}`;
    keep.add(key);
    const hash = hashOf(b.f);
    const prev = existing.find((e) => `${e.businessDate}|${e.channel}|${e.currency}` === key);
    if (prev && prev.contentHash === hash && prev.sandbox === (c.mode === 'sandbox')) { unchanged++; continue; }
    const values = {
      organizationId: c.organizationId, locationId: c.locationId, connectionId: c.id, source: c.provider, businessDate: b.date, channel: b.channel, currency: b.currency,
      grossMinor: b.f.grossMinor, refundsMinor: b.f.refundsMinor, taxMinor: b.f.taxMinor, tipsMinor: b.f.tipsMinor, discountsMinor: b.f.discountsMinor, orderCount: b.f.orderCount,
      netMinor: netSales(b.f), sandbox: c.mode === 'sandbox', contentHash: hash, syncedAt: new Date(), updatedAt: new Date(),
    };
    await db.insert(dailySales).values(values).onConflictDoUpdate({ target: [dailySales.locationId, dailySales.source, dailySales.businessDate, dailySales.channel, dailySales.currency], set: values });
    written++;
  }
  // Rows of this source in the window that the vendor no longer reports (e.g. a voided channel) are removed.
  const stale = existing.filter((e) => !keep.has(`${e.businessDate}|${e.channel}|${e.currency}`));
  if (stale.length) await db.delete(dailySales).where(inArray(dailySales.id, stale.map((x) => x.id)));
  return { written: written + stale.length, unchanged };
}

/** Runs one sync (job handler). */
export async function runSalesSync(s: Services, runId: string) {
  const [run] = await s.db.select().from(salesSyncRuns).where(eq(salesSyncRuns.id, runId));
  if (!run || run.status !== 'queued') return;
  const [c] = await s.db.select().from(salesConnections).where(eq(salesConnections.id, run.connectionId));
  if (!c) return;
  await s.db.update(salesSyncRuns).set({ status: 'running', startedAt: new Date() }).where(eq(salesSyncRuns.id, run.id));
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, c.locationId));
  try {
    if (c.status !== 'connected') throw new Error(`The connection is ${c.status.replace('_', ' ')}`);
    let records: SaleRecord[];
    if (c.mode === 'sandbox') {
      records = sandboxSales(c.id, datesBetween(run.fromDate, run.toDate), loc!.currency);
    } else {
      const adapter = SALES_ADAPTERS[c.provider as SalesConnectorProvider];
      let creds = salesCredentials(s, c);
      const refreshed = adapter.refresh ? await adapter.refresh(s.cfg, s.partnerFetch, creds, c.config, Date.now()) : null;
      if (refreshed) {
        creds = refreshed;
        await s.db.update(salesConnections).set({ credentialsEncrypted: sealed(s, creds), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
      }
      records = await adapter.fetchSales(s.cfg, s.partnerFetch, {
        creds, config: c.config, fromDate: run.fromDate, toDate: run.toDate, currency: loc!.currency, timeZone: loc!.timeZone,
        fromUtc: zonedToUtc(run.fromDate, '00:00', loc!.timeZone), toUtc: zonedToUtc(addDays(run.toDate, 1), '00:00', loc!.timeZone),
      });
    }
    const buckets = bucketSales(records, loc!.timeZone, run.fromDate, run.toDate);
    const r = await s.db.transaction((tx) => writeDailySales(tx, c, loc!, buckets, run.fromDate, run.toDate));
    const now = new Date();
    await s.db.update(salesSyncRuns).set({ status: 'succeeded', daysWritten: r.written, daysUnchanged: r.unchanged, ordersSeen: records.reduce((a, x) => a + x.orders, 0), finishedAt: now }).where(eq(salesSyncRuns.id, run.id));
    await s.db.update(salesConnections).set({ lastSyncAt: now, lastSyncStatus: 'succeeded', lastError: null, updatedAt: now }).where(eq(salesConnections.id, c.id));
  } catch (err) {
    const msg = (err as Error).message;
    const expired = err instanceof PartnerHttpError && (err.status === 401 || err.status === 403);
    await s.db.update(salesSyncRuns).set({ status: 'failed', error: msg, finishedAt: new Date() }).where(eq(salesSyncRuns.id, run.id));
    await s.db.update(salesConnections).set({ lastSyncStatus: 'failed', lastError: msg, lastErrorAt: new Date(), ...(expired ? { status: 'authorization_expired' } : {}), updatedAt: new Date() }).where(eq(salesConnections.id, c.id));
  }
}

/** Nightly: queue the last three local days for every connected connection (one job per connection and day). */
export async function queueNightlySync(s: Services) {
  const rows = await s.db.select().from(salesConnections).where(eq(salesConnections.status, 'connected'));
  let queued = 0;
  for (const c of rows) {
    const [loc] = await s.db.select({ timeZone: locations.timeZone }).from(locations).where(eq(locations.id, c.locationId));
    const w = windowFor(loc!, 'nightly', null, null);
    // Once per connection and local day (the sweep runs hourly; without Redis job ids are not deduplicated).
    const [done] = await s.db.select({ id: salesSyncRuns.id }).from(salesSyncRuns).where(and(eq(salesSyncRuns.connectionId, c.id), eq(salesSyncRuns.trigger, 'nightly'), eq(salesSyncRuns.toDate, w.to), ne(salesSyncRuns.status, 'failed')));
    if (done) continue;
    try { await queueSync(s, c, 'nightly', null, null, null); queued++; } catch (err) { s.log.warn({ err, connectionId: c.id }, 'nightly sales sync not queued'); }
  }
  return queued;
}

export async function disconnect(s: Services, c: SalesConnectionRow, actorUserId: string) {
  const [u] = await s.db.update(salesConnections).set({ status: 'disconnected', credentialsEncrypted: null, oauthStateHash: null, updatedAt: new Date() }).where(eq(salesConnections.id, c.id)).returning();
  await audit(s.db, { organizationId: c.organizationId, actorUserId, action: 'sales_connector.disconnected', scopeKind: 'location', scopeId: c.locationId, targetType: 'sales_connection', targetId: c.id, metadata: { provider: c.provider } });
  return u!;
}

export async function recentRuns(db: Exec, connectionId: string, limit = 10) {
  return db.select().from(salesSyncRuns).where(eq(salesSyncRuns.connectionId, connectionId)).orderBy(desc(salesSyncRuns.createdAt)).limit(limit);
}

export const serializeRun = (r: typeof salesSyncRuns.$inferSelect) => ({
  id: r.id, trigger: r.trigger, status: r.status, fromDate: r.fromDate, toDate: r.toDate, daysWritten: r.daysWritten, daysUnchanged: r.daysUnchanged, ordersSeen: r.ordersSeen,
  sandbox: r.sandbox, error: r.error, startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
});

export async function connectionsFor(db: Exec, organizationId: string, locationIds: 'all' | Set<string>) {
  const rows = await db.select().from(salesConnections).where(and(eq(salesConnections.organizationId, organizationId), ne(salesConnections.status, 'disconnected'))).orderBy(asc(salesConnections.createdAt));
  return rows.filter((c) => locationIds === 'all' || locationIds.has(c.locationId));
}

export const catalog = (s: Pick<Services, 'cfg'>) => SALES_CONNECTORS.map((m) => ({ ...m, mode: SALES_ADAPTERS[m.provider].platformReady(s.cfg) ? 'live' as const : 'sandbox' as const }));
