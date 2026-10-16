/**
 * Marketing → Listings: one source of truth per location, pushed to Google Business Profile, Apple Business Connect
 * and Bing Places, with drift detection, HQ field locks, location edits with optional approval, bulk holiday hours
 * and a health score (packages/shared/src/local-marketing.ts).
 *
 * Name, address, phone, weekly hours and special hours are stored on the location (`locations.hours.weekly` /
 * `.special`), so the hosted location sites show exactly what the directories show; `listing_profiles` holds the rest.
 */
import { and, asc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  LISTING_FIELDS, PROVIDER_FIELDS, applyListingPatch, diffListing, listingHealth, mergeSpecialHours,
  type ListingField, type ListingPatch, type ListingProvider, type ListingSnapshot, type SpecialHour, type WeeklyHour,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  holidayHourSets, listingChangeRequests, listingConnections, listingDrifts, listingProfiles, listingSyncs, locations, reviewConnections, reviewListings, users,
} from '../db/schema/index.ts';
import { createListingDirectories, type ListingDirectory } from '../integrations/listings.ts';
import { decrypt } from '../lib/crypto.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { usersWithCapabilityAt } from './comms-scope.ts';
import { getLocalMarketingSettings } from './local-marketing.ts';
import { notify } from './notifications.ts';

export const LISTINGS = 'marketing.listings';
type LocationRow = typeof locations.$inferSelect;
type ProfileRow = typeof listingProfiles.$inferSelect;
type SyncRow = typeof listingSyncs.$inferSelect;

/* ── directory adapters (overridable in tests) ── */

const adapters = new WeakMap<Services, Record<ListingProvider, ListingDirectory>>();
export function listingDirectories(s: Services) {
  let a = adapters.get(s);
  if (!a) adapters.set(s, (a = createListingDirectories(s.cfg, s.partnerFetch)));
  return a;
}
export function setListingDirectories(s: Services, a: Partial<Record<ListingProvider, ListingDirectory>>) {
  adapters.set(s, { ...listingDirectories(s), ...a });
}

/* ── canonical listing ── */

const hoursOf = (l: LocationRow) => (l.hours ?? {}) as { summary?: string | null; weekly?: WeeklyHour[]; special?: SpecialHour[] };

export function canonicalListing(l: LocationRow, p: ProfileRow | null | undefined): ListingSnapshot {
  const h = hoursOf(l);
  return {
    name: l.name,
    address: { line1: l.address.line1, ...(l.address.line2 ? { line2: l.address.line2 } : {}), city: l.address.city, region: l.address.region, postalCode: l.address.postalCode, country: l.address.country },
    phone: l.phone,
    hours: Array.isArray(h.weekly) ? h.weekly : [],
    specialHours: Array.isArray(h.special) ? h.special : [],
    categories: { primary: p?.primaryCategory ?? null, additional: p?.additionalCategories ?? [] },
    description: p?.description ?? null,
    photos: p?.photos ?? [],
    websiteUrl: p?.websiteUrl ?? null,
    bookingUrl: p?.bookingUrl ?? null,
    attributes: p?.attributes ?? {},
  };
}

export async function loadLocation(db: Exec, orgId: string, locationId: string) {
  const [l] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
  if (!l) throw notFound('Location');
  const [p] = await db.select().from(listingProfiles).where(eq(listingProfiles.locationId, locationId));
  return { location: l, profile: p ?? null };
}

/**
 * Writes a patch to the location and its listing profile (no policy checks: callers decide who may change what).
 * Weekly hours edited here replace the free-text hours summary, so the hosted site shows the structured hours.
 */
export async function writeListing(tx: Exec, l: LocationRow, patch: ListingPatch, userId: string | null) {
  const locSet: Partial<typeof locations.$inferInsert> = {};
  if (patch.name !== undefined) locSet.name = patch.name;
  if (patch.address !== undefined) { locSet.address = patch.address; locSet.country = patch.address.country; }
  if (patch.phone !== undefined) locSet.phone = patch.phone;
  if (patch.hours !== undefined || patch.specialHours !== undefined) {
    const h = { ...hoursOf(l) } as Record<string, unknown>;
    if (patch.hours !== undefined) { h.weekly = patch.hours; h.summary = null; }
    if (patch.specialHours !== undefined) h.special = [...patch.specialHours].sort((a, b) => a.date.localeCompare(b.date));
    locSet.hours = h;
  }
  if (Object.keys(locSet).length) await tx.update(locations).set({ ...locSet, updatedAt: new Date() }).where(eq(locations.id, l.id));
  const prof: Partial<typeof listingProfiles.$inferInsert> = {};
  if (patch.categories !== undefined) { prof.primaryCategory = patch.categories.primary; prof.additionalCategories = patch.categories.additional; }
  if (patch.description !== undefined) prof.description = patch.description;
  if (patch.photos !== undefined) prof.photos = patch.photos;
  if (patch.websiteUrl !== undefined) prof.websiteUrl = patch.websiteUrl;
  if (patch.bookingUrl !== undefined) prof.bookingUrl = patch.bookingUrl;
  if (patch.attributes !== undefined) prof.attributes = patch.attributes;
  if (Object.keys(prof).length) {
    await tx.insert(listingProfiles).values({ organizationId: l.organizationId, locationId: l.id, ...prof, updatedBy: userId })
      .onConflictDoUpdate({ target: listingProfiles.locationId, set: { ...prof, updatedBy: userId, updatedAt: new Date() } });
  }
}

const changedFields = (patch: ListingPatch) => LISTING_FIELDS.filter((f) => patch[f] !== undefined);

/* ── sync rows ── */

/**
 * Makes sure every directory the location is linked to has a sync row. Google links come from Reviews (the Google
 * Business Profile connection and its location link); Apple and Bing links are made in Listings.
 */
export async function ensureSyncs(db: Exec, orgId: string, locationIds?: string[]) {
  const links = await db.select({ l: reviewListings, c: reviewConnections }).from(reviewListings).innerJoin(reviewConnections, eq(reviewConnections.id, reviewListings.connectionId))
    .where(and(eq(reviewListings.organizationId, orgId), eq(reviewListings.provider, 'google'), ne(reviewConnections.status, 'disconnected'), locationIds ? inArray(reviewListings.locationId, locationIds.length ? locationIds : ['00000000-0000-0000-0000-000000000000']) : undefined));
  for (const { l, c } of links) {
    await db.insert(listingSyncs).values({ organizationId: orgId, locationId: l.locationId, provider: 'google', connectionId: c.id, externalId: l.externalLocationName, mode: c.mode, status: 'pending' })
      .onConflictDoUpdate({ target: [listingSyncs.locationId, listingSyncs.provider], set: { connectionId: c.id, externalId: l.externalLocationName, mode: c.mode, updatedAt: new Date() }, setWhere: sql`${listingSyncs.connectionId} is distinct from ${c.id} or ${listingSyncs.externalId} is distinct from ${l.externalLocationName}` });
  }
}

/** Credential and adapter for a sync row; `live` only when the connection holds credentials and the adapter is configured. */
async function syncCredential(s: Services, sync: SyncRow): Promise<{ live: boolean; credential: string | null; directory: ListingDirectory }> {
  const directory = listingDirectories(s)[sync.provider as ListingProvider];
  if (!sync.connectionId) return { live: false, credential: null, directory };
  if (sync.provider === 'google') {
    const [c] = await s.db.select().from(reviewConnections).where(eq(reviewConnections.id, sync.connectionId));
    const token = c && c.mode === 'live' && c.status !== 'disconnected' && c.credentialsEncrypted ? decrypt(c.credentialsEncrypted, s.cfg.ENCRYPTION_KEY) : null;
    return { live: !!token && directory.configured, credential: token, directory };
  }
  const [c] = await s.db.select().from(listingConnections).where(eq(listingConnections.id, sync.connectionId));
  const cred = c && c.mode === 'live' && c.status !== 'disconnected' && c.credentialsEncrypted ? decrypt(c.credentialsEncrypted, s.cfg.ENCRYPTION_KEY) : null;
  return { live: !!cred && directory.configured, credential: cred, directory };
}

/**
 * Pushes the location's listing to every linked directory (or one). Sandbox directories store the copy BranchHarbor
 * would have sent (never claimed as published). Open drifts on pushed fields are resolved as overwritten.
 */
export async function pushLocation(s: Services, orgId: string, locationId: string, opts: { provider?: ListingProvider; fields?: readonly ListingField[]; actorUserId?: string | null } = {}) {
  await ensureSyncs(s.db, orgId, [locationId]);
  const { location, profile } = await loadLocation(s.db, orgId, locationId);
  const listing = canonicalListing(location, profile);
  const syncs = await s.db.select().from(listingSyncs).where(and(eq(listingSyncs.locationId, locationId), ne(listingSyncs.status, 'not_connected'), opts.provider ? eq(listingSyncs.provider, opts.provider) : undefined));
  const out: Array<{ provider: string; status: string; mode: string; error?: string }> = [];
  for (const sync of syncs) {
    const fields = PROVIDER_FIELDS[sync.provider as ListingProvider].filter((f) => !opts.fields || opts.fields.includes(f));
    if (!fields.length) continue;
    const { live, credential, directory } = await syncCredential(s, sync);
    try {
      if (live && credential && sync.externalId) await directory.push(credential, sync.externalId, listing, fields);
      // The directory now holds our values for the pushed fields (sandbox: the simulated directory copy).
      const remote = sync.remoteSnapshot ? { ...sync.remoteSnapshot, ...Object.fromEntries(fields.map((f) => [f, listing[f]])) } as ListingSnapshot : listing;
      await s.db.update(listingSyncs).set({ status: 'synced', mode: live ? 'live' : 'sandbox', lastPushedAt: new Date(), pushedSnapshot: listing, remoteSnapshot: remote, lastError: null, updatedAt: new Date() }).where(eq(listingSyncs.id, sync.id));
      await s.db.update(listingDrifts).set({ status: 'overwritten', resolvedAt: new Date(), resolvedBy: opts.actorUserId ?? null })
        .where(and(eq(listingDrifts.locationId, locationId), eq(listingDrifts.provider, sync.provider), eq(listingDrifts.status, 'open'), inArray(listingDrifts.field, fields as ListingField[])));
      out.push({ provider: sync.provider, status: 'synced', mode: live ? 'live' : 'sandbox' });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      await s.db.update(listingSyncs).set({ status: 'error', lastError: msg, updatedAt: new Date() }).where(eq(listingSyncs.id, sync.id));
      out.push({ provider: sync.provider, status: 'error', mode: live ? 'live' : 'sandbox', error: msg });
    }
  }
  await refreshSyncStatus(s.db, locationId);
  if (out.length) await audit(s.db, { organizationId: orgId, actorUserId: opts.actorUserId ?? null, action: 'listings.pushed', scopeKind: 'location', scopeId: locationId, targetType: 'location', targetId: locationId, metadata: { results: out, fields: opts.fields ?? 'all' } });
  return out;
}

/** A sync with open drifts shows `drift`; otherwise it keeps its last push status. */
async function refreshSyncStatus(db: Exec, locationId: string) {
  const open = await db.select({ provider: listingDrifts.provider }).from(listingDrifts).where(and(eq(listingDrifts.locationId, locationId), eq(listingDrifts.status, 'open')));
  const drifting = new Set(open.map((d) => d.provider));
  const syncs = await db.select().from(listingSyncs).where(eq(listingSyncs.locationId, locationId));
  for (const x of syncs) {
    const next = drifting.has(x.provider) ? 'drift' : x.status === 'drift' ? (x.lastPushedAt ? 'synced' : 'pending') : x.status;
    if (next !== x.status) await db.update(listingSyncs).set({ status: next, updatedAt: new Date() }).where(eq(listingSyncs.id, x.id));
  }
}

/**
 * Drift check: reads the directory's copy (live) or the simulated copy (sandbox) and compares it with what
 * BranchHarbor last pushed. New differences are stored as open drifts and alert HQ and the location's editors.
 */
export async function checkDrift(s: Services, syncId: string, today = new Date().toISOString().slice(0, 10)) {
  const [sync] = await s.db.select().from(listingSyncs).where(eq(listingSyncs.id, syncId));
  if (!sync) throw notFound('Listing sync');
  const { live, credential, directory } = await syncCredential(s, sync);
  let remote = sync.remoteSnapshot;
  if (live && credential && sync.externalId) {
    try {
      remote = (await directory.fetch(credential, sync.externalId)) ?? null;
    } catch (err) {
      await s.db.update(listingSyncs).set({ status: 'error', lastError: (err as Error).message.slice(0, 300), lastCheckedAt: new Date() }).where(eq(listingSyncs.id, sync.id));
      return { drifted: [] as ListingField[], created: 0, error: (err as Error).message };
    }
  }
  const { location, profile } = await loadLocation(s.db, sync.organizationId, sync.locationId);
  const baseline = sync.pushedSnapshot ?? canonicalListing(location, profile);
  if (!remote) {
    await s.db.update(listingSyncs).set({ lastCheckedAt: new Date() }).where(eq(listingSyncs.id, sync.id));
    return { drifted: [] as ListingField[], created: 0 };
  }
  const drifted = diffListing(baseline, remote, sync.provider as ListingProvider, today);
  let created = 0;
  for (const field of drifted) {
    const [row] = await s.db.insert(listingDrifts).values({ organizationId: sync.organizationId, locationId: sync.locationId, provider: sync.provider, field, ourValue: baseline[field], theirValue: remote[field] })
      .onConflictDoNothing().returning();
    if (row) created++;
    else await s.db.update(listingDrifts).set({ theirValue: remote[field] }).where(and(eq(listingDrifts.locationId, sync.locationId), eq(listingDrifts.provider, sync.provider), eq(listingDrifts.field, field), eq(listingDrifts.status, 'open')));
  }
  // Fields that match again (fixed on the directory) close their drift.
  const fixed = PROVIDER_FIELDS[sync.provider as ListingProvider].filter((f) => !drifted.includes(f));
  if (fixed.length) await s.db.update(listingDrifts).set({ status: 'dismissed', resolvedAt: new Date() }).where(and(eq(listingDrifts.locationId, sync.locationId), eq(listingDrifts.provider, sync.provider), eq(listingDrifts.status, 'open'), inArray(listingDrifts.field, fixed)));
  await s.db.update(listingSyncs).set({ lastCheckedAt: new Date(), remoteSnapshot: remote, ...(live ? { lastError: null } : {}) }).where(eq(listingSyncs.id, sync.id));
  await refreshSyncStatus(s.db, sync.locationId);
  if (created) await alertDrift(s, sync, location, drifted);
  return { drifted, created };
}

async function alertDrift(s: Services, sync: SyncRow, l: LocationRow, fields: ListingField[]) {
  const hq = await usersWithCapabilityAt(s.db, sync.organizationId, null, LISTINGS, 'publish');
  const local = await usersWithCapabilityAt(s.db, sync.organizationId, l.id, LISTINGS, 'edit', { excludeOwners: true });
  const userIds = [...new Set([...hq, ...local])];
  const provider = { google: 'Google', apple: 'Apple Maps', bing: 'Bing' }[sync.provider] ?? sync.provider;
  await notify(s, { userIds, organizationId: sync.organizationId, category: 'network_update', title: `${l.name}: listing changed on ${provider}`, body: `Edited outside BranchHarbor: ${fields.join(', ')}. Accept the change or overwrite it.`, data: { kind: 'listing_drift', locationId: l.id, provider: sync.provider } });
  await s.db.update(listingDrifts).set({ alertedAt: new Date() }).where(and(eq(listingDrifts.locationId, l.id), eq(listingDrifts.provider, sync.provider), eq(listingDrifts.status, 'open'), sql`${listingDrifts.alertedAt} is null`));
  await audit(s.db, { organizationId: sync.organizationId, actorUserId: null, actorType: 'system', action: 'listings.drift_detected', scopeKind: 'location', scopeId: l.id, targetType: 'listing_sync', targetId: sync.id, metadata: { provider: sync.provider, fields, notified: userIds.length } });
}

/** Accept the directory's value (it becomes BranchHarbor's and goes to the other directories), overwrite it, or dismiss. */
export async function resolveDrift(s: Services, orgId: string, driftId: string, action: 'accept' | 'overwrite' | 'dismiss', userId: string) {
  const [d] = await s.db.select().from(listingDrifts).where(and(eq(listingDrifts.id, driftId), eq(listingDrifts.organizationId, orgId)));
  if (!d) throw notFound('Drift');
  if (d.status !== 'open') throw conflict('drift_resolved', 'This change was already handled');
  if (action === 'accept') {
    const { location } = await loadLocation(s.db, orgId, d.locationId);
    await s.db.transaction(async (tx) => writeListing(tx, location, { [d.field]: d.theirValue } as ListingPatch, userId));
    await s.db.update(listingDrifts).set({ status: 'accepted', resolvedBy: userId, resolvedAt: new Date() }).where(eq(listingDrifts.id, d.id));
    // The baseline for this directory is now its own value; the other directories get it too.
    const [sync] = await s.db.select().from(listingSyncs).where(and(eq(listingSyncs.locationId, d.locationId), eq(listingSyncs.provider, d.provider)));
    if (sync?.pushedSnapshot) await s.db.update(listingSyncs).set({ pushedSnapshot: { ...sync.pushedSnapshot, [d.field]: d.theirValue } as ListingSnapshot }).where(eq(listingSyncs.id, sync.id));
    const others = await s.db.select({ provider: listingSyncs.provider }).from(listingSyncs).where(and(eq(listingSyncs.locationId, d.locationId), ne(listingSyncs.provider, d.provider)));
    for (const o of others) await pushLocation(s, orgId, d.locationId, { provider: o.provider as ListingProvider, fields: [d.field], actorUserId: userId });
  } else if (action === 'overwrite') {
    await pushLocation(s, orgId, d.locationId, { provider: d.provider as ListingProvider, fields: [d.field], actorUserId: userId });
  } else {
    await s.db.update(listingDrifts).set({ status: 'dismissed', resolvedBy: userId, resolvedAt: new Date() }).where(eq(listingDrifts.id, d.id));
  }
  await refreshSyncStatus(s.db, d.locationId);
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: `listings.drift_${action}`, scopeKind: 'location', scopeId: d.locationId, targetType: 'listing_drift', targetId: d.id, metadata: { provider: d.provider, field: d.field } });
  const [row] = await s.db.select().from(listingDrifts).where(eq(listingDrifts.id, d.id));
  return row!;
}

/** Sandbox only: simulate an edit made on the directory (to see drift detection work). */
export async function simulateDirectoryEdit(s: Services, orgId: string, syncId: string, patch: ListingPatch) {
  const [sync] = await s.db.select().from(listingSyncs).where(and(eq(listingSyncs.id, syncId), eq(listingSyncs.organizationId, orgId)));
  if (!sync) throw notFound('Listing sync');
  const { live } = await syncCredential(s, sync);
  if (live) throw conflict('directory_live', 'Simulated edits are only available on sandbox directories');
  const { location, profile } = await loadLocation(s.db, orgId, sync.locationId);
  const base = sync.remoteSnapshot ?? sync.pushedSnapshot ?? canonicalListing(location, profile);
  await s.db.update(listingSyncs).set({ remoteSnapshot: applyListingPatch(base, patch), ...(sync.pushedSnapshot ? {} : { pushedSnapshot: base }) }).where(eq(listingSyncs.id, sync.id));
  return checkDrift(s, sync.id);
}

/* ── edits with field policy ── */

/**
 * Applies a listing change. HQ (organisation-wide publish) may change every field. A location may change fields
 * whose policy is `location`; `location_approval` fields become a change request for HQ; locked (`hq`) fields are
 * refused.
 */
export async function updateListing(s: Services, orgId: string, locationId: string, patch: ListingPatch, actor: { userId: string; hq: boolean; note?: string | null }) {
  const { location } = await loadLocation(s.db, orgId, locationId);
  const settings = await getLocalMarketingSettings(s.db, orgId);
  const fields = changedFields(patch);
  if (!fields.length) throw validationError('Nothing to change');
  const locked = actor.hq ? [] : fields.filter((f) => settings.listingPolicy[f] === 'hq');
  if (locked.length) throw forbidden(`HQ manages these fields: ${locked.join(', ')}`);
  const needsApproval = actor.hq ? [] : fields.filter((f) => settings.listingPolicy[f] === 'location_approval');
  const direct = fields.filter((f) => !needsApproval.includes(f));
  const pick = (fs: ListingField[]) => Object.fromEntries(fs.map((f) => [f, patch[f]])) as ListingPatch;
  let request: typeof listingChangeRequests.$inferSelect | null = null;
  await s.db.transaction(async (tx) => {
    if (direct.length) await writeListing(tx, location, pick(direct), actor.userId);
    if (needsApproval.length) {
      [request] = await tx.insert(listingChangeRequests).values({ organizationId: orgId, locationId, changes: pick(needsApproval), note: actor.note ?? null, requestedBy: actor.userId }).returning() as [typeof listingChangeRequests.$inferSelect];
    }
    await audit(tx, { organizationId: orgId, actorUserId: actor.userId, action: 'listings.updated', scopeKind: 'location', scopeId: locationId, targetType: 'location', targetId: locationId, metadata: { applied: direct, pendingApproval: needsApproval } });
  });
  let pushed: Awaited<ReturnType<typeof pushLocation>> = [];
  if (direct.length && settings.autoPush) pushed = await pushLocation(s, orgId, locationId, { fields: direct, actorUserId: actor.userId });
  if (request) {
    const hq = await usersWithCapabilityAt(s.db, orgId, null, LISTINGS, 'publish');
    await notify(s, { userIds: hq, organizationId: orgId, category: 'approval_request', title: `${location.name}: listing change to approve`, body: needsApproval.join(', '), data: { kind: 'listing_change', locationId, requestId: (request as { id: string }).id } });
  }
  return { applied: direct, pendingApproval: needsApproval, requestId: (request as { id: string } | null)?.id ?? null, pushed };
}

export async function decideChange(s: Services, orgId: string, id: string, decision: 'approve' | 'reject', userId: string, note?: string | null) {
  const [r] = await s.db.select().from(listingChangeRequests).where(and(eq(listingChangeRequests.id, id), eq(listingChangeRequests.organizationId, orgId)));
  if (!r) throw notFound('Change request');
  if (r.status !== 'pending') throw conflict('not_pending', 'This change was already decided');
  if (r.requestedBy === userId) throw forbidden('Someone else has to approve your own change');
  const { location } = await loadLocation(s.db, orgId, r.locationId);
  await s.db.transaction(async (tx) => {
    if (decision === 'approve') await writeListing(tx, location, r.changes, r.requestedBy);
    await tx.update(listingChangeRequests).set({ status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: note ?? null }).where(eq(listingChangeRequests.id, r.id));
    await audit(tx, { organizationId: orgId, actorUserId: userId, action: `listings.change_${decision === 'approve' ? 'approved' : 'rejected'}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'listing_change', targetId: r.id });
  });
  const settings = await getLocalMarketingSettings(s.db, orgId);
  if (decision === 'approve' && settings.autoPush) await pushLocation(s, orgId, r.locationId, { fields: changedFields(r.changes), actorUserId: userId });
  await notify(s, { userIds: [r.requestedBy], organizationId: orgId, category: 'network_update', title: `${location.name}: listing change ${decision === 'approve' ? 'approved' : 'not approved'}`, body: note ?? '', data: { kind: 'listing_change', locationId: r.locationId } });
  const [row] = await s.db.select().from(listingChangeRequests).where(eq(listingChangeRequests.id, r.id));
  return row!;
}

/* ── bulk holiday hours ── */

/**
 * Sets special hours for the chosen dates at many locations at once. Without `overwrite`, a location that already
 * has different special hours on one of the dates keeps its own (reported as skipped).
 */
export async function applyHolidayHours(s: Services, orgId: string, input: { name: string; entries: SpecialHour[]; locationIds: string[]; overwrite: boolean }, userId: string) {
  const dates = new Set(input.entries.map((e) => e.date));
  if (dates.size !== input.entries.length) throw validationError('Each date once', { entries: 'Duplicate date' });
  const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, input.locationIds)));
  if (locs.length !== new Set(input.locationIds).size) throw notFound('Location');
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const l of locs) {
    const current = canonicalListing(l, null).specialHours;
    const same = (a: SpecialHour, b: SpecialHour) => a.closed === b.closed && (a.closed || (a.opens === b.opens && a.closes === b.closes));
    const clash = current.some((c) => { const e = input.entries.find((x) => x.date === c.date); return !!e && !same(c, e); });
    if (clash && !input.overwrite) { skipped.push(l.id); continue; }
    await writeListing(s.db, l, { specialHours: mergeSpecialHours(current, input.entries) }, userId);
    applied.push(l.id);
  }
  const [set] = await s.db.insert(holidayHourSets).values({ organizationId: orgId, name: input.name, entries: input.entries, locationIds: applied, skippedLocationIds: skipped, createdBy: userId }).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: 'listings.holiday_hours_applied', scopeKind: 'organization', scopeId: orgId, targetType: 'holiday_hour_set', targetId: set!.id, metadata: { dates: [...dates], applied: applied.length, skipped: skipped.length } });
  const settings = await getLocalMarketingSettings(s.db, orgId);
  const pushes: Array<{ locationId: string; results: Awaited<ReturnType<typeof pushLocation>> }> = [];
  if (settings.autoPush) for (const id of applied) pushes.push({ locationId: id, results: await pushLocation(s, orgId, id, { fields: ['specialHours'], actorUserId: userId }) });
  return { set: set!, applied, skipped, pushes };
}

/** Network holiday dates in the next 60 days (from holiday hour sets) a location has no special hours for. */
export async function missingHolidayDates(db: Exec, orgId: string, today = new Date()) {
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const sets = await db.select({ entries: holidayHourSets.entries }).from(holidayHourSets).where(eq(holidayHourSets.organizationId, orgId));
  const dates = [...new Set(sets.flatMap((x) => x.entries.map((e) => e.date)).filter((d) => d >= from && d <= to))];
  return (l: LocationRow) => {
    const own = new Set(canonicalListing(l, null).specialHours.map((x) => x.date));
    return dates.filter((d) => !own.has(d));
  };
}

/* ── overview ── */

export async function listingsOverview(s: Services, orgId: string, locationIds: string[] | 'all') {
  const conds = [eq(locations.organizationId, orgId), sql`${locations.archivedAt} is null`];
  if (locationIds !== 'all') conds.push(locationIds.length ? inArray(locations.id, locationIds) : sql`false`);
  const locs = await s.db.select().from(locations).where(and(...conds)).orderBy(asc(locations.name));
  const ids = locs.map((l) => l.id);
  if (ids.length) await ensureSyncs(s.db, orgId, ids);
  const profiles = ids.length ? await s.db.select().from(listingProfiles).where(inArray(listingProfiles.locationId, ids)) : [];
  const syncs = ids.length ? await s.db.select().from(listingSyncs).where(inArray(listingSyncs.locationId, ids)) : [];
  const drifts = ids.length ? await s.db.select().from(listingDrifts).where(and(inArray(listingDrifts.locationId, ids), eq(listingDrifts.status, 'open'))) : [];
  const pending = ids.length ? await s.db.select({ locationId: listingChangeRequests.locationId }).from(listingChangeRequests).where(and(inArray(listingChangeRequests.locationId, ids), eq(listingChangeRequests.status, 'pending'))) : [];
  const missing = await missingHolidayDates(s.db, orgId);
  const items = locs.map((l) => {
    const listing = canonicalListing(l, profiles.find((p) => p.locationId === l.id));
    const ls = syncs.filter((x) => x.locationId === l.id);
    const providers = (['google', 'apple', 'bing'] as const).map((p) => {
      const x = ls.find((y) => y.provider === p);
      return { provider: p, status: (x?.status ?? 'not_connected') as 'synced' | 'pending' | 'drift' | 'error' | 'not_connected', mode: x?.mode ?? null, syncId: x?.id ?? null, lastPushedAt: x?.lastPushedAt?.toISOString() ?? null, lastCheckedAt: x?.lastCheckedAt?.toISOString() ?? null, lastError: x?.lastError ?? null };
    });
    const openDrifts = drifts.filter((d) => d.locationId === l.id).length;
    const pendingChanges = pending.filter((p) => p.locationId === l.id).length;
    const health = listingHealth({ listing, syncs: providers, openDrifts, pendingChanges, missingHolidayDates: missing(l).length });
    return { locationId: l.id, name: l.name, city: l.address.city, country: l.country, status: l.status, health, providers, openDrifts, pendingChanges, missingHolidayDates: missing(l) };
  });
  const scores = items.map((i) => i.health.score);
  return {
    items,
    totals: {
      locations: items.length, averageHealth: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      openDrifts: drifts.length, pendingChanges: pending.length, synced: syncs.filter((x) => x.status === 'synced').length, connected: syncs.filter((x) => x.status !== 'not_connected').length,
    },
  };
}

export async function listingDetail(s: Services, orgId: string, locationId: string) {
  await ensureSyncs(s.db, orgId, [locationId]);
  const { location, profile } = await loadLocation(s.db, orgId, locationId);
  const listing = canonicalListing(location, profile);
  const settings = await getLocalMarketingSettings(s.db, orgId);
  const syncs = await s.db.select().from(listingSyncs).where(eq(listingSyncs.locationId, locationId));
  const drifts = await s.db.select().from(listingDrifts).where(and(eq(listingDrifts.locationId, locationId), eq(listingDrifts.status, 'open'))).orderBy(asc(listingDrifts.detectedAt));
  const changes = await s.db.select().from(listingChangeRequests).where(eq(listingChangeRequests.locationId, locationId)).orderBy(sql`${listingChangeRequests.createdAt} desc`).limit(20);
  const missing = (await missingHolidayDates(s.db, orgId))(location);
  const providers = (['google', 'apple', 'bing'] as const).map((p) => {
    const x = syncs.find((y) => y.provider === p);
    return {
      provider: p, syncId: x?.id ?? null, status: (x?.status ?? 'not_connected') as 'synced' | 'pending' | 'drift' | 'error' | 'not_connected', mode: x?.mode ?? null, externalId: x?.externalId ?? null,
      lastPushedAt: x?.lastPushedAt?.toISOString() ?? null, lastCheckedAt: x?.lastCheckedAt?.toISOString() ?? null, lastError: x?.lastError ?? null,
    };
  });
  const ppl = [...new Set(changes.flatMap((c) => [c.requestedBy, c.decidedBy]).filter((x): x is string => !!x))];
  const names = ppl.length ? new Map((await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ppl))).map((u) => [u.id, u.name])) : new Map<string, string>();
  return {
    location: { id: location.id, name: location.name, timeZone: location.timeZone, country: location.country, slug: location.slug },
    listing, policy: settings.listingPolicy, autoPush: settings.autoPush, providers,
    health: listingHealth({ listing, syncs: providers, openDrifts: drifts.length, pendingChanges: changes.filter((c) => c.status === 'pending').length, missingHolidayDates: missing.length }),
    missingHolidayDates: missing,
    drifts: drifts.map((d) => serializeDrift(d)),
    changes: changes.map((c) => ({ id: c.id, status: c.status, fields: changedFields(c.changes), changes: c.changes, note: c.note, requestedBy: { id: c.requestedBy, name: names.get(c.requestedBy) ?? null }, decidedBy: c.decidedBy ? { id: c.decidedBy, name: names.get(c.decidedBy) ?? null } : null, decisionNote: c.decisionNote, createdAt: c.createdAt.toISOString(), decidedAt: c.decidedAt?.toISOString() ?? null })),
  };
}

export const serializeDrift = (d: typeof listingDrifts.$inferSelect, locationName?: string) => ({
  id: d.id, locationId: d.locationId, locationName: locationName ?? null, provider: d.provider, field: d.field, ourValue: d.ourValue, theirValue: d.theirValue, status: d.status, detectedAt: d.detectedAt.toISOString(), resolvedAt: d.resolvedAt?.toISOString() ?? null,
});

/** Background drift check for live directories (sandbox drift only changes through simulated edits). */
export async function listingsTick(s: Services, now = new Date()) {
  const due = new Date(now.getTime() - s.cfg.LISTINGS_DRIFT_CHECK_MINUTES * 60_000);
  const rows = await s.db.select({ id: listingSyncs.id }).from(listingSyncs).where(and(eq(listingSyncs.mode, 'live'), inArray(listingSyncs.status, ['synced', 'drift']), or(sql`${listingSyncs.lastCheckedAt} is null`, lt(listingSyncs.lastCheckedAt, due)))).limit(100);
  let checked = 0;
  for (const r of rows) {
    try { await checkDrift(s, r.id); checked++; } catch (err) { s.log.warn({ err, syncId: r.id }, '[listings] drift check failed'); }
  }
  return { checked };
}

