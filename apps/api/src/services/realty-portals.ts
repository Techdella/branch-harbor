/**
 * Property-portal syndication: per-listing opt-in, per-portal validation, per-office delivery.
 *  - Push portals (Rightmove RTDF): send on export / listing change, remove on withdrawn / sold / let.
 *  - Pull portals (idealista, Zillow/RESO XML, REAXML): a signed per-office feed URL the portal fetches; listings leave
 *    the feed when withdrawn/sold (REAXML keeps them for 30 days with their final status so portals remove them).
 * Each office has its own connection (credentials encrypted) and an honest status: not configured / sandbox / live.
 * In sandbox nothing is transmitted — results are recorded as "sandbox_exported" / "sandbox_removed".
 */
import { and, eq, inArray } from 'drizzle-orm';
import { PUBLIC_LISTING_STATUSES } from '@bh/shared';
import type { Services } from '../context.ts';
import { connections, locations, organizations, realtyListingPortalFields, realtyListings, realtyOffices, realtySyndication } from '../db/schema/index.ts';
import { createRightmoveClient } from '../integrations/partners/rightmove.ts';
import { normalizePortalId, PORTAL_ADAPTERS, rightmoveRemoveProperty, rightmoveSendProperty, type FeedListing, type PortalId, type RemovedListing } from '../integrations/realty-portals.ts';
import { listingAgentRows } from './realty.ts';
import { callsAllowed, errInfo, feedToken, logSync, partnerConnection, partnerCredentials, partnerStatus } from './partner-connections.ts';

type Connection = typeof connections.$inferSelect;
const REMOVED_STATUSES = ['withdrawn', 'sold', 'let'];
const REMOVED_FEED_DAYS = 30;

export async function feedListings(s: Pick<Services, 'db'>, orgId: string, listingIds: string[]): Promise<FeedListing[]> {
  if (!listingIds.length) return [];
  const rows = await s.db.select({ l: realtyListings, loc: locations }).from(realtyListings).innerJoin(locations, eq(locations.id, realtyListings.locationId)).where(and(eq(realtyListings.organizationId, orgId), inArray(realtyListings.id, listingIds)));
  const offices = await s.db.select().from(realtyOffices).where(inArray(realtyOffices.locationId, [...new Set(rows.map((r) => r.loc.id))]));
  const agents = await listingAgentRows(s.db, listingIds);
  const fields = await s.db.select().from(realtyListingPortalFields).where(inArray(realtyListingPortalFields.listingId, listingIds));
  return rows.map(({ l, loc }) => {
    const office = offices.find((o) => o.locationId === loc.id);
    const lead = agents.find((x) => x.la.listingId === l.id && x.la.role === 'lead')?.agent ?? agents.find((x) => x.la.listingId === l.id)?.agent;
    const pf = fields.find((f) => f.listingId === l.id);
    return {
      id: l.id, reference: l.reference, transaction: l.transaction as 'sale' | 'rent', propertyType: l.propertyType, status: l.status, title: l.title, description: l.description,
      address: { line1: l.addressLine1, line2: l.addressLine2, city: l.city, region: l.region, postalCode: l.postalCode, country: l.country }, hideStreet: l.hideStreet, geo: l.geo ?? null,
      price: { amount: l.priceMinor, currency: l.currency }, rentPeriod: l.rentPeriod, bedrooms: l.bedrooms, bathrooms: l.bathrooms, areaSqm: l.areaSqm, lotSqm: l.lotSqm, yearBuilt: l.yearBuilt,
      photos: l.photos, floorPlans: l.floorPlans, virtualTourUrl: l.virtualTourUrl, features: l.features,
      agent: lead ? { name: lead.name, email: lead.email, phone: lead.phone, licence: lead.licenceNumber } : null,
      office: { name: loc.name, phone: loc.phone, email: loc.email, brokerageLicence: office?.brokerageLicence ?? null },
      disclosures: [...(office?.disclosures ?? []), ...l.disclosures].map((d) => ({ label: d.label, text: d.text })),
      portalFields: pf ? { priceQualifier: pf.priceQualifier, tenure: pf.tenure, councilTaxBand: pf.councilTaxBand, energyRating: pf.energyRating, availableFrom: pf.availableFrom } : undefined,
      createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString(),
    };
  });
}

export async function officeConnections(s: Pick<Services, 'db'>, orgId: string, portal: PortalId) {
  return s.db.select().from(connections).where(and(eq(connections.organizationId, orgId), eq(connections.provider, portal)));
}

/** Opted-in rows for a portal (all statuses: removal needs withdrawn/sold ones too). */
async function optIns(s: Pick<Services, 'db'>, orgId: string, portal: PortalId, locationIds?: string[]) {
  const rows = await s.db.select({ x: realtySyndication, l: realtyListings }).from(realtySyndication).innerJoin(realtyListings, eq(realtyListings.id, realtySyndication.listingId))
    .where(and(eq(realtySyndication.organizationId, orgId), eq(realtySyndication.portal, portal), eq(realtySyndication.optedIn, true)));
  return rows.filter((r) => !locationIds || locationIds.includes(r.l.locationId));
}

function rightmoveClient(s: Services, c: Connection) {
  const creds = partnerCredentials(s, c);
  return createRightmoveClient({ fetch: s.rightmoveFetch(creds.certificatePfxBase64 ?? '', creds.certificatePassword), baseUrl: (c.config.baseUrl as string) || undefined });
}

const setRow = (s: Pick<Services, 'db'>, listingId: string, portal: PortalId, v: Partial<typeof realtySyndication.$inferInsert>) =>
  s.db.update(realtySyndication).set({ ...v, updatedAt: new Date() }).where(and(eq(realtySyndication.listingId, listingId), eq(realtySyndication.portal, portal)));

export interface ExportResult { listingId: string; reference: string; locationId: string; status: string; issues: string[]; message?: string | null }

/**
 * Validate and deliver one portal's opted-in listings for the given offices. Push portals send/remove each listing
 * when live (sandbox otherwise); pull portals record whether each listing is in the feed.
 */
export async function exportPortal(s: Services, orgId: string, portal: PortalId, locationIds: string[], listingIds?: string[]): Promise<{ results: ExportResult[]; transmitted: boolean }> {
  const adapter = PORTAL_ADAPTERS[portal];
  const rows = (await optIns(s, orgId, portal, locationIds)).filter((r) => !listingIds || listingIds.includes(r.l.id));
  const feed = await feedListings(s, orgId, rows.map((r) => r.l.id));
  const conns = await officeConnections(s, orgId, portal);
  const results: ExportResult[] = [];
  let transmitted = false;
  for (const { x, l } of rows) {
    const f = feed.find((y) => y.id === l.id)!;
    const conn = conns.find((c) => c.locationId === l.locationId);
    const creds = conn ? partnerCredentials(s, conn) : {};
    const live = !!conn && conn.config.enabled !== false && callsAllowed(conn, creds);
    const isPublic = (PUBLIC_LISTING_STATUSES as readonly string[]).includes(l.status);
    if (!isPublic) {
      if (!REMOVED_STATUSES.includes(l.status) || ['removed', 'sandbox_removed', 'not_exported'].includes(x.lastStatus)) { results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status: x.lastStatus, issues: [] }); continue; }
      const r = await removeFromPortal(s, conn, live, portal, { id: l.id, reference: l.reference, transaction: l.transaction as 'sale' | 'rent', status: l.status, at: l.updatedAt.toISOString() }, orgId, l.locationId);
      if (r.status === 'removed') transmitted = true;
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status: r.status, issues: [], message: r.message });
      continue;
    }
    const issues = adapter.validate(f);
    if (issues.length) {
      await setRow(s, l.id, portal, { lastStatus: 'invalid', lastIssues: issues });
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status: 'invalid', issues });
      continue;
    }
    if (adapter.delivery === 'pull') {
      const status = live ? 'published' : 'sandbox_exported';
      await setRow(s, l.id, portal, { lastStatus: status, lastIssues: [], lastExportedAt: new Date() });
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status, issues: [], message: live ? 'In the feed; the portal picks it up on its next fetch' : 'Sandbox: in the preview feed only' });
      continue;
    }
    // Push (Rightmove)
    if (!live) {
      await setRow(s, l.id, portal, { lastStatus: 'sandbox_exported', lastIssues: [], lastExportedAt: new Date() });
      if (conn) await logSync(s, { organizationId: orgId, connectionId: conn.id, provider: portal, locationId: l.locationId, action: 'send_property', targetType: 'realty_listing', targetId: l.id, status: 'sandbox', message: 'Sandbox: nothing sent to Rightmove', detail: { body: rightmoveSendProperty(f, conn.config) } });
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status: 'sandbox_exported', issues: [], message: 'Sandbox: nothing sent' });
      continue;
    }
    try {
      const r = await rightmoveClient(s, conn!).sendProperty(rightmoveSendProperty(f, conn!.config));
      const status = r.ok ? 'published' : 'error';
      await setRow(s, l.id, portal, { lastStatus: status, lastIssues: r.ok ? r.warnings.map((w) => `Warning: ${w}`) : r.errors, ...(r.ok ? { lastExportedAt: new Date() } : {}) });
      if (r.ok && r.rightmoveId) await rememberRemoteId(s, orgId, l.id, portal, r.rightmoveId);
      await logSync(s, { organizationId: orgId, connectionId: conn!.id, provider: portal, locationId: l.locationId, action: 'send_property', targetType: 'realty_listing', targetId: l.id, status: r.ok ? 'ok' : 'error', message: r.message ?? (r.ok ? 'Sent' : r.errors.join('; ')), detail: { rightmoveId: r.rightmoveId, url: r.url, warnings: r.warnings, errors: r.errors } });
      transmitted = transmitted || r.ok;
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status, issues: r.ok ? [] : r.errors, message: r.url });
    } catch (err) {
      await setRow(s, l.id, portal, { lastStatus: 'error', lastIssues: [(err as Error).message] });
      await logSync(s, { organizationId: orgId, connectionId: conn!.id, provider: portal, locationId: l.locationId, action: 'send_property', targetType: 'realty_listing', targetId: l.id, status: 'error', ...errInfo(err) });
      results.push({ listingId: l.id, reference: l.reference, locationId: l.locationId, status: 'error', issues: [(err as Error).message] });
    }
  }
  return { results, transmitted };
}

async function rememberRemoteId(s: Pick<Services, 'db'>, orgId: string, listingId: string, portal: string, id: string) {
  const [pf] = await s.db.select().from(realtyListingPortalFields).where(eq(realtyListingPortalFields.listingId, listingId));
  if (pf) await s.db.update(realtyListingPortalFields).set({ remoteIds: { ...pf.remoteIds, [portal]: id } }).where(eq(realtyListingPortalFields.id, pf.id));
  else await s.db.insert(realtyListingPortalFields).values({ organizationId: orgId, listingId, remoteIds: { [portal]: id } }).onConflictDoNothing();
}

async function removeFromPortal(s: Services, conn: Connection | undefined, live: boolean, portal: PortalId, r: RemovedListing, orgId: string, locationId: string) {
  const adapter = PORTAL_ADAPTERS[portal];
  if (adapter.delivery === 'pull') {
    // Drops out of the feed (REAXML keeps a status entry for 30 days so the portal archives it).
    const status = live ? 'removed' : 'sandbox_removed';
    await setRow(s, r.id, portal, { lastStatus: status, lastIssues: [] });
    return { status, message: live ? 'Removed from the feed' : 'Sandbox: removed from the preview feed' };
  }
  if (!live) {
    await setRow(s, r.id, portal, { lastStatus: 'sandbox_removed', lastIssues: [] });
    if (conn) await logSync(s, { organizationId: orgId, connectionId: conn.id, provider: portal, locationId, action: 'remove_property', targetType: 'realty_listing', targetId: r.id, status: 'sandbox', message: 'Sandbox: removal not sent', detail: { body: rightmoveRemoveProperty(r, conn.config) } });
    return { status: 'sandbox_removed', message: 'Sandbox: nothing sent' };
  }
  try {
    const res = await rightmoveClient(s, conn!).removeProperty(rightmoveRemoveProperty(r, conn!.config));
    const status = res.ok ? 'removed' : 'error';
    await setRow(s, r.id, portal, { lastStatus: status, lastIssues: res.ok ? [] : res.errors });
    await logSync(s, { organizationId: orgId, connectionId: conn!.id, provider: portal, locationId, action: 'remove_property', targetType: 'realty_listing', targetId: r.id, status: res.ok ? 'ok' : 'error', message: res.message ?? res.errors.join('; ') });
    return { status, message: res.message };
  } catch (err) {
    await setRow(s, r.id, portal, { lastStatus: 'error', lastIssues: [`Removal failed: ${(err as Error).message}`] });
    await logSync(s, { organizationId: orgId, connectionId: conn!.id, provider: portal, locationId, action: 'remove_property', targetType: 'realty_listing', targetId: r.id, status: 'error', ...errInfo(err) });
    return { status: 'error', message: (err as Error).message };
  }
}

/** Job: a listing changed status — send it again (still public) or remove it (withdrawn / sold / let) on every opted-in portal. */
export async function syncListingPortals(s: Services, listingId: string) {
  const [l] = await s.db.select().from(realtyListings).where(eq(realtyListings.id, listingId));
  if (!l) return [];
  const rows = await s.db.select().from(realtySyndication).where(and(eq(realtySyndication.listingId, l.id), eq(realtySyndication.optedIn, true)));
  const out = [];
  for (const r of rows) {
    const portal = normalizePortalId(r.portal);
    if (!portal) continue;
    const { results } = await exportPortal(s, l.organizationId, portal, [l.locationId], [l.id]);
    out.push(...results.map((x) => ({ ...x, portal })));
  }
  return out;
}

/** Opting out of a portal removes the listing there too. */
export async function optOutRemoval(s: Services, orgId: string, listingId: string, portal: PortalId) {
  const [l] = await s.db.select().from(realtyListings).where(eq(realtyListings.id, listingId));
  if (!l) return null;
  const conn = await partnerConnection(s, portal, l.locationId);
  const creds = conn ? partnerCredentials(s, conn) : {};
  const live = !!conn && conn.config.enabled !== false && callsAllowed(conn, creds);
  return removeFromPortal(s, conn, live, portal, { id: l.id, reference: l.reference, transaction: l.transaction as 'sale' | 'rent', status: 'withdrawn', at: new Date().toISOString() }, orgId, l.locationId);
}

/** Feed content for one office (preview or hosted). */
export async function officeFeed(s: Services, orgId: string, portal: PortalId, locationIds: string | string[] | null, opts: { sandbox: boolean; config?: Record<string, unknown> }) {
  const adapter = PORTAL_ADAPTERS[portal];
  const rows = await optIns(s, orgId, portal, locationIds === null ? undefined : Array.isArray(locationIds) ? locationIds : [locationIds]);
  const pub = rows.filter((r) => (PUBLIC_LISTING_STATUSES as readonly string[]).includes(r.l.status));
  const feed = await feedListings(s, orgId, pub.map((r) => r.l.id));
  const checked = feed.map((f) => ({ f, issues: adapter.validate(f) }));
  const cutoff = Date.now() - REMOVED_FEED_DAYS * 86_400_000;
  const removed: RemovedListing[] = rows.filter((r) => REMOVED_STATUSES.includes(r.l.status) && r.l.updatedAt.getTime() >= cutoff)
    .map((r) => ({ id: r.l.id, reference: r.l.reference, transaction: r.l.transaction as 'sale' | 'rent', status: r.l.status, at: r.l.updatedAt.toISOString() }));
  const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const content = adapter.build(checked.filter((c) => !c.issues.length).map((c) => c.f), { generatedAt: new Date().toISOString(), organization: org?.name ?? '', config: opts.config ?? {}, sandbox: opts.sandbox }, portal === 'reaxml' || portal === 'rightmove' ? removed : []);
  return {
    content,
    included: checked.filter((c) => !c.issues.length).map((c) => ({ listingId: c.f.id, reference: c.f.reference })),
    excluded: checked.filter((c) => c.issues.length).map((c) => ({ listingId: c.f.id, reference: c.f.reference, issues: c.issues })),
    removed: removed.map((r) => ({ listingId: r.id, reference: r.reference, status: r.status })),
  };
}

/** Public hosted feed: /v1/feeds/realty/:connectionId/:token(.xml|.json) — token is per office and rotatable. */
export async function hostedFeed(s: Services, connectionId: string, token: string) {
  const [c] = await s.db.select().from(connections).where(eq(connections.id, connectionId));
  const portal = c ? normalizePortalId(c.provider) : null;
  if (!c || !portal || PORTAL_ADAPTERS[portal].delivery !== 'pull' || !c.locationId) return null;
  const expected = feedToken(s, c.id, Number(c.config.feedTokenVersion ?? 1));
  if (token.length !== expected.length || token !== expected) return null;
  if (c.config.enabled === false) return { disabled: true as const };
  const creds = partnerCredentials(s, c);
  const st = partnerStatus(c, creds);
  const feed = await officeFeed(s, c.organizationId, portal, c.locationId, { sandbox: !['live', 'awaiting_portal'].includes(st.status), config: c.config });
  const now = new Date().toISOString();
  await s.db.update(connections).set({ config: { ...c.config, lastFetchedAt: now }, ...(st.status === 'awaiting_portal' || st.status === 'live' ? { lastSuccessAt: new Date() } : {}), updatedAt: new Date() }).where(eq(connections.id, c.id));
  await logSync(s, { organizationId: c.organizationId, connectionId: c.id, provider: portal, locationId: c.locationId, action: 'feed_fetch', status: st.status === 'live' || st.status === 'awaiting_portal' ? 'ok' : 'sandbox', message: `Feed fetched: ${feed.included.length} listing(s)`, detail: { included: feed.included.length, excluded: feed.excluded.length } });
  return { content: feed.content, format: PORTAL_ADAPTERS[portal].format };
}

/** Listings opted into portals with their fresh validation and last delivery result (Portal feeds screen). */
export async function syndicationIssues(s: Services, orgId: string, locationIds: string[] | 'all') {
  const rows = await s.db.select({ x: realtySyndication, l: realtyListings }).from(realtySyndication).innerJoin(realtyListings, eq(realtyListings.id, realtySyndication.listingId))
    .where(and(eq(realtySyndication.organizationId, orgId), eq(realtySyndication.optedIn, true)));
  const scoped = rows.filter((r) => locationIds === 'all' || locationIds.includes(r.l.locationId));
  const feed = await feedListings(s, orgId, [...new Set(scoped.map((r) => r.l.id))]);
  return scoped.map(({ x, l }) => {
    const portal = normalizePortalId(x.portal);
    const f = feed.find((y) => y.id === l.id)!;
    const issues = portal && (PUBLIC_LISTING_STATUSES as readonly string[]).includes(l.status) ? PORTAL_ADAPTERS[portal].validate(f) : [];
    return { listingId: l.id, reference: l.reference, title: l.title, locationId: l.locationId, listingStatus: l.status, portal: portal ?? x.portal, issues, lastStatus: x.lastStatus, lastIssues: x.lastIssues, lastExportedAt: x.lastExportedAt?.toISOString() ?? null };
  });
}

