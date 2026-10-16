/**
 * Bulk location launch (Network → Bulk launch, module `network.bulk_launch`): "launch your first 10 location sites in
 * a day". A spreadsheet (or rows from the import wizard) creates many locations from the brand template; each item
 * runs four steps, recorded on the progress board:
 *   1. location   — created with the launch's status (onboarding / opening soon / operating), never silently public
 *                   unless the launch publishes sites;
 *   2. website    — the hosted site from the brand template (master page or locked fields), published or left as a draft;
 *   3. listing    — listings data prepared from the location (name, address, phone, hours, categories, description,
 *                   site URL) and stored on the location for listings sync (Google Business Profile when connected);
 *   4. staff      — invitations for the manager (location manager) and staff emails (role chosen per launch).
 * Items are independent: one failure never stops the others, and failed items can be retried.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { createLocationSchema, isValidTimeZone, normalizeHeader, LAUNCH_STEPS, autoDetectMapping, type LaunchStep, type Role } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { bulkLaunchItems, bulkLaunches, fieldOverrides, invitations, locations, organizations, ownerGroups, pages, regions, templates, websites } from '../db/schema/index.ts';
import type { LaunchStepState } from '../db/schema/data-platform.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { uniqueSlug } from '../routes/locations.ts';
import { originFor } from '../routes/websites.ts';
import { audit } from './audit.ts';
import { parseUpload } from './imports.ts';
import { publishPage } from './publish.ts';
import { applyMasterToLocation } from './site-builder.ts';

export const LAUNCH_MAX_ROWS = 200;
const DAY = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LaunchRow {
  name: string; code: string; address_line1: string; address_line2?: string | null; city: string; state_region?: string | null; postal_code?: string | null; country: string;
  time_zone: string; currency: string; phone?: string | null; email?: string | null; region?: string | null; owner_group?: string | null;
  manager_email?: string | null; staff_emails?: string | null; listing_description?: string | null; listing_categories?: string | null; opening_date?: string | null;
}
const LAUNCH_KEYS = ['name', 'code', 'address_line1', 'address_line2', 'city', 'state_region', 'postal_code', 'country', 'time_zone', 'currency', 'phone', 'email', 'region', 'owner_group', 'manager_email', 'staff_emails', 'listing_description', 'listing_categories', 'opening_date'] as const;

/** Spreadsheet → launch rows (location columns are matched like the import wizard; launch columns by name). */
export function parseLaunchSheet(filename: string, dataBase64: string): LaunchRow[] {
  const { headers, rows } = parseUpload(filename, dataBase64);
  if (rows.length > LAUNCH_MAX_ROWS) throw validationError(`At most ${LAUNCH_MAX_ROWS} locations per launch`, { file: `Max ${LAUNCH_MAX_ROWS} rows` });
  const { mapping } = autoDetectMapping('locations', headers);
  const norm = headers.map(normalizeHeader);
  for (const k of ['manager_email', 'staff_emails', 'listing_description', 'listing_categories', 'opening_date']) {
    const i = norm.findIndex((h) => h === k || h === k.replace('_emails', '') || (k === 'manager_email' && h === 'manager'));
    mapping[k] = i >= 0 ? i : null;
  }
  return rows.map((r) => Object.fromEntries(LAUNCH_KEYS.map((k) => [k, mapping[k] !== null && mapping[k] !== undefined ? (r[mapping[k]!] ?? '').trim() : ''])) as unknown as LaunchRow);
}

/** Row-level validation against the organisation (codes, time zones, currencies, emails). */
export async function validateLaunchRows(db: Exec, organizationId: string, rows: LaunchRow[]) {
  const existing = new Set((await db.select({ code: locations.code }).from(locations).where(eq(locations.organizationId, organizationId))).map((l) => l.code.toLowerCase()));
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const errors: Array<{ field: string; message: string }> = [];
    const parsed = createLocationSchema.safeParse({
      name: r.name, code: r.code, timeZone: r.time_zone, currency: (r.currency ?? '').toUpperCase(),
      address: { line1: r.address_line1 ?? '', city: r.city ?? '', country: (r.country ?? '').toUpperCase(), ...(r.state_region ? { region: r.state_region } : {}), ...(r.postal_code ? { postalCode: r.postal_code } : {}) },
      ...(r.email ? { email: r.email } : {}),
    });
    if (!parsed.success) for (const iss of parsed.error.issues) errors.push({ field: iss.path.join('.'), message: iss.message });
    if (r.time_zone && !isValidTimeZone(r.time_zone)) errors.push({ field: 'time_zone', message: `Unknown time zone "${r.time_zone}"` });
    const code = (r.code ?? '').toLowerCase();
    if (code && existing.has(code)) errors.push({ field: 'code', message: `Code "${r.code}" is already used` });
    if (code && seen.has(code)) errors.push({ field: 'code', message: 'Appears twice in this launch' });
    seen.add(code);
    for (const e of [r.manager_email, ...(r.staff_emails ?? '').split(/[,;\s]+/)].filter(Boolean)) if (!EMAIL.test(e!)) errors.push({ field: 'staff_emails', message: `Invalid email "${e}"` });
    return { row: i + 1, errors };
  });
}

const pending = (): Record<LaunchStep, LaunchStepState> => Object.fromEntries(LAUNCH_STEPS.map((k) => [k, { status: 'pending' }])) as Record<LaunchStep, LaunchStepState>;

export async function createLaunch(s: Services, organizationId: string, input: { name: string; templateId?: string | null; siteMode: 'publish' | 'draft'; locationStatus: 'onboarding' | 'opening_soon' | 'operating'; inviteStaff: boolean; staffRole: Role; rows: LaunchRow[]; importBatchId?: string | null }, actorUserId: string) {
  if (!input.rows.length) throw validationError('Add at least one location', { rows: 'Empty' });
  if (input.rows.length > LAUNCH_MAX_ROWS) throw validationError(`At most ${LAUNCH_MAX_ROWS} locations per launch`, { rows: `Max ${LAUNCH_MAX_ROWS}` });
  if (input.templateId) {
    const [t] = await s.db.select({ id: templates.id }).from(templates).where(and(eq(templates.id, input.templateId), eq(templates.organizationId, organizationId)));
    if (!t) throw notFound('Template');
  }
  const checks = await validateLaunchRows(s.db, organizationId, input.rows);
  const bad = checks.filter((c) => c.errors.length);
  if (bad.length) throw validationError(`${bad.length} row(s) need fixing before launch`, Object.fromEntries(bad.slice(0, 20).map((c) => [`row_${c.row}`, c.errors.map((e) => `${e.field}: ${e.message}`).join('; ')])));
  const launch = await s.db.transaction(async (tx) => {
    const [l] = await tx.insert(bulkLaunches).values({
      organizationId, name: input.name, templateId: input.templateId ?? null, siteMode: input.siteMode, locationStatus: input.locationStatus, inviteStaff: input.inviteStaff, importBatchId: input.importBatchId ?? null,
      total: input.rows.length, createdBy: actorUserId,
    }).returning();
    await tx.insert(bulkLaunchItems).values(input.rows.map((r, i) => ({ organizationId, launchId: l!.id, rowNumber: i + 1, name: r.name, code: r.code, input: { ...r, staff_role: input.staffRole } as Record<string, unknown>, steps: pending() })));
    await audit(tx, { organizationId, actorUserId, action: 'launch.created', targetType: 'bulk_launch', targetId: l!.id, metadata: { locations: input.rows.length, siteMode: input.siteMode } });
    return l!;
  });
  await s.jobs.enqueue('launches.run', { launchId: launch.id });
  return launch;
}

async function setStep(db: Exec, itemId: string, steps: Record<string, LaunchStepState>, step: LaunchStep, state: LaunchStepState, extra: Partial<typeof bulkLaunchItems.$inferInsert> = {}) {
  steps[step] = { ...state, at: new Date().toISOString() };
  await db.update(bulkLaunchItems).set({ steps, ...extra, updatedAt: new Date() }).where(eq(bulkLaunchItems.id, itemId));
}

/** Runs one item through its steps (resuming after the last step that finished). */
async function runItem(s: Services, launch: typeof bulkLaunches.$inferSelect, item: typeof bulkLaunchItems.$inferSelect, org: typeof organizations.$inferSelect, tpl: typeof templates.$inferSelect | null) {
  const r = item.input as unknown as LaunchRow & { staff_role?: Role };
  const steps = { ...pending(), ...item.steps } as Record<string, LaunchStepState>;
  await s.db.update(bulkLaunchItems).set({ status: 'running', startedAt: item.startedAt ?? new Date(), error: null, updatedAt: new Date() }).where(eq(bulkLaunchItems.id, item.id));
  let locationId = item.locationId;
  let current: LaunchStep = 'location';
  try {
    // 1. Location
    if (!locationId) {
      await setStep(s.db, item.id, steps, 'location', { status: 'running' });
      locationId = await s.db.transaction(async (tx) => {
        const named = async (name: string | null | undefined, kind: 'region' | 'group') => {
          if (!name) return null;
          const tbl = kind === 'region' ? regions : ownerGroups;
          const rows = await tx.select({ id: tbl.id, name: tbl.name }).from(tbl).where(eq(tbl.organizationId, launch.organizationId));
          const hit = rows.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (hit) return hit.id;
          const [n] = await tx.insert(tbl).values({ organizationId: launch.organizationId, name }).returning({ id: tbl.id });
          return n!.id;
        };
        const geo = await s.geocoder.geocode(`${r.address_line1}, ${r.city}, ${r.country}`).catch(() => null);
        const [loc] = await tx.insert(locations).values({
          organizationId: launch.organizationId, regionId: await named(r.region, 'region'), ownerGroupId: await named(r.owner_group, 'group'), name: r.name, code: r.code, slug: await uniqueSlug(tx, launch.organizationId, r.name),
          address: { line1: r.address_line1, ...(r.address_line2 ? { line2: r.address_line2 } : {}), city: r.city, ...(r.state_region ? { region: r.state_region } : {}), ...(r.postal_code ? { postalCode: r.postal_code } : {}), country: r.country.toUpperCase() },
          country: r.country.toUpperCase(), timeZone: r.time_zone, currency: r.currency.toUpperCase(), locale: org.defaultLocale, phone: r.phone || null, email: r.email || null, templateId: tpl?.id ?? null,
          status: launch.locationStatus, publiclyVisible: launch.siteMode === 'publish' && launch.locationStatus !== 'onboarding', geo,
          settings: r.opening_date ? { openingDate: r.opening_date } : {},
        }).returning();
        await audit(tx, { organizationId: launch.organizationId, actorUserId: launch.createdBy, action: 'location.created', scopeKind: 'location', scopeId: loc!.id, targetType: 'location', targetId: loc!.id, metadata: { via: 'bulk_launch', launchId: launch.id } });
        return loc!.id;
      });
      await setStep(s.db, item.id, steps, 'location', { status: 'done' }, { locationId });
    }
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, locationId!));
    const siteUrl = `${s.cfg.SITES_BASE_URL}/${org.slug}/${loc!.slug}`;
    // 2. Website from the brand template
    current = 'website';
    if (steps.website!.status !== 'done') {
      await setStep(s.db, item.id, steps, 'website', { status: 'running' });
      const { websiteId, pageId } = await s.db.transaction(async (tx) => {
        if (tpl?.document) {
          const res = await applyMasterToLocation(tx, tpl, loc!.id, siteUrl);
          const [site] = await tx.select().from(websites).where(eq(websites.locationId, loc!.id));
          return { websiteId: site!.id, pageId: res.pageId };
        }
        let [site] = await tx.select().from(websites).where(eq(websites.locationId, loc!.id));
        if (!site) [site] = await tx.insert(websites).values({ organizationId: launch.organizationId, locationId: loc!.id, kind: 'hosted', templateId: tpl?.id ?? null, includedAddress: siteUrl }).returning();
        const [page] = await tx.insert(pages).values({ organizationId: launch.organizationId, websiteId: site!.id, locationId: loc!.id, templateId: tpl?.id ?? null, slug: slugify('home'), title: 'Home' }).returning();
        if (tpl?.fields.length) await tx.insert(fieldOverrides).values(tpl.fields.map((f) => ({ organizationId: launch.organizationId, pageId: page!.id, fieldKey: f.key, origin: originFor(f.policy), value: f.defaultValue ?? null, hqValue: f.defaultValue ?? null })));
        return { websiteId: site!.id, pageId: page!.id };
      });
      if (launch.siteMode === 'publish' && pageId) {
        await publishPage(s.db, pageId, launch.createdBy);
        await s.db.update(websites).set({ status: 'live' }).where(eq(websites.id, websiteId));
      }
      await setStep(s.db, item.id, steps, 'website', { status: 'done', detail: launch.siteMode === 'publish' ? 'published' : 'draft' }, { websiteId, pageId });
    }
    // 3. Listings data
    current = 'listing';
    if (steps.listing!.status !== 'done') {
      const listing = {
        name: loc!.name, address: loc!.address, phone: loc!.phone, email: loc!.email, websiteUrl: siteUrl, hours: loc!.hours ?? null,
        categories: (r.listing_categories ?? '').split(/[,;|]/).map((c) => c.trim()).filter(Boolean), description: r.listing_description || null,
        openingDate: r.opening_date || null, status: 'ready', preparedAt: new Date().toISOString(),
      };
      await s.db.update(locations).set({ settings: { ...loc!.settings, listing }, updatedAt: new Date() }).where(eq(locations.id, loc!.id));
      await setStep(s.db, item.id, steps, 'listing', { status: 'done', detail: 'ready' });
    }
    // 4. Staff invitations
    current = 'staff';
    if (steps.staff!.status !== 'done') {
      const people: Array<{ email: string; role: Role }> = [];
      if (launch.inviteStaff) {
        if (r.manager_email) people.push({ email: r.manager_email.toLowerCase(), role: 'location_manager' });
        for (const e of (r.staff_emails ?? '').split(/[,;\s]+/).filter(Boolean)) people.push({ email: e.toLowerCase(), role: r.staff_role ?? 'staff' });
      }
      let n = 0;
      for (const p of people) {
        const [dupe] = await s.db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.organizationId, launch.organizationId), eq(invitations.email, p.email), eq(invitations.scopeId, loc!.id), eq(invitations.status, 'pending')));
        if (dupe) continue;
        const token = randomToken();
        await s.db.insert(invitations).values({ organizationId: launch.organizationId, email: p.email, role: p.role, scopeKind: 'location', scopeId: loc!.id, tokenHash: sha256(token), invitedBy: launch.createdBy, expiresAt: new Date(Date.now() + 14 * DAY) });
        await s.jobs.enqueue('email.send', { to: p.email, subject: `You're invited to ${loc!.name} on BranchHarbor`, text: `You've been invited to join ${org.name} at ${loc!.name}.\nAccept: ${s.cfg.APP_URL}/invitations/accept?token=${encodeURIComponent(token)}\nThis invitation expires in 14 days.`, tag: 'invitation' });
        n++;
      }
      await setStep(s.db, item.id, steps, 'staff', people.length ? { status: 'done', detail: String(n) } : { status: 'skipped' }, { invitations: item.invitations + n });
    }
    await s.db.update(bulkLaunchItems).set({ status: 'done', finishedAt: new Date(), updatedAt: new Date() }).where(eq(bulkLaunchItems.id, item.id));
    return true;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    await setStep(s.db, item.id, steps, current, { status: 'failed', detail: msg }, { status: 'failed', error: msg, finishedAt: new Date(), locationId });
    return false;
  }
}

async function refreshCounts(db: Exec, launchId: string) {
  const items = await db.select({ status: bulkLaunchItems.status }).from(bulkLaunchItems).where(eq(bulkLaunchItems.launchId, launchId));
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const finished = done + failed === items.length;
  await db.update(bulkLaunches).set({ done, failed, status: finished ? (failed ? 'completed_with_errors' : 'completed') : 'running', finishedAt: finished ? new Date() : null, updatedAt: new Date() }).where(eq(bulkLaunches.id, launchId));
}

/** Job: runs every queued item of a launch, one after another, updating the board as it goes. */
export async function runLaunch(s: Services, launchId: string) {
  const [launch] = await s.db.select().from(bulkLaunches).where(eq(bulkLaunches.id, launchId));
  if (!launch) return;
  await s.db.update(bulkLaunches).set({ status: 'running', startedAt: launch.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(bulkLaunches.id, launch.id));
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, launch.organizationId));
  const [tpl] = launch.templateId
    ? await s.db.select().from(templates).where(eq(templates.id, launch.templateId))
    : await s.db.select().from(templates).where(eq(templates.organizationId, launch.organizationId)).orderBy(asc(templates.createdAt)).limit(1);
  const items = await s.db.select().from(bulkLaunchItems).where(and(eq(bulkLaunchItems.launchId, launch.id), eq(bulkLaunchItems.status, 'queued'))).orderBy(asc(bulkLaunchItems.rowNumber));
  for (const item of items) {
    await runItem(s, launch, item, org!, tpl ?? null);
    await refreshCounts(s.db, launch.id);
  }
  await refreshCounts(s.db, launch.id);
  await audit(s.db, { organizationId: launch.organizationId, actorUserId: launch.createdBy, action: 'launch.finished', targetType: 'bulk_launch', targetId: launch.id });
}

export async function retryFailed(s: Services, organizationId: string, launchId: string) {
  const [launch] = await s.db.select().from(bulkLaunches).where(and(eq(bulkLaunches.id, launchId), eq(bulkLaunches.organizationId, organizationId)));
  if (!launch) throw notFound('Launch');
  if (launch.status === 'running' || launch.status === 'queued') throw conflict('launch_running', 'This launch is still running');
  const failed = await s.db.select({ id: bulkLaunchItems.id }).from(bulkLaunchItems).where(and(eq(bulkLaunchItems.launchId, launch.id), eq(bulkLaunchItems.status, 'failed')));
  if (!failed.length) throw conflict('nothing_to_retry', 'No failed locations to retry');
  await s.db.update(bulkLaunchItems).set({ status: 'queued', error: null, updatedAt: new Date() }).where(inArray(bulkLaunchItems.id, failed.map((f) => f.id)));
  await s.db.update(bulkLaunches).set({ status: 'queued', updatedAt: new Date() }).where(eq(bulkLaunches.id, launch.id));
  await s.jobs.enqueue('launches.run', { launchId: launch.id });
  return failed.length;
}

export function serializeLaunch(l: typeof bulkLaunches.$inferSelect, items?: Array<typeof bulkLaunchItems.$inferSelect>) {
  return {
    id: l.id, name: l.name, templateId: l.templateId, siteMode: l.siteMode, locationStatus: l.locationStatus, inviteStaff: l.inviteStaff, status: l.status, total: l.total, done: l.done, failed: l.failed,
    progressPct: l.total ? Math.round(((l.done + l.failed) / l.total) * 100) : 0, startedAt: l.startedAt?.toISOString() ?? null, finishedAt: l.finishedAt?.toISOString() ?? null, createdAt: l.createdAt.toISOString(),
    ...(items ? {
      items: items.map((i) => ({ id: i.id, row: i.rowNumber, name: i.name, code: i.code, status: i.status, steps: i.steps, locationId: i.locationId, websiteId: i.websiteId, pageId: i.pageId, invitations: i.invitations, error: i.error, finishedAt: i.finishedAt?.toISOString() ?? null })),
    } : {}),
  };
}

