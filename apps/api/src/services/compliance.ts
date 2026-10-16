/**
 * Compliance documents (Legal & compliance → Compliance documents, capability `legal.compliance_documents`).
 *
 * HQ (publish) defines requirements, e.g. "General liability ≥ 2,000,000 USD" for locations in some jurisdictions,
 * reviews uploads and sees the compliance matrix (locations × requirements). Franchisees (edit at their locations)
 * upload certificates of insurance, licences, permits, health certificates and their own documents, from the web or
 * the phone. Reminders go out 60, 30 and 7 days before expiry and on the day it expires; on expiry HQ is told too
 * (the same pattern as the franchise agreement renewals tracker).
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { complianceState, daysUntil, dueReminderStep, type AccessAction, type ComplianceState } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { complianceDocuments, complianceMissingReminders, complianceRequirements, locations, organizations, ownerGroups, users } from '../db/schema/index.ts';
import { localDateParts } from '../lib/tz.ts';
import { notFound } from '../lib/errors.ts';
import { capabilityLocations, hasCapability, requireMember } from './authz.ts';
import { usersWithCapability } from './audits.ts';
import { signedFileUrl } from './ops-files.ts';

export const COMPLIANCE_MODULE = 'legal.compliance_documents';
export type Requirement = typeof complianceRequirements.$inferSelect;
export type ComplianceDoc = typeof complianceDocuments.$inferSelect;
type Loc = { id: string; name: string; code: string; country: string; address: { region?: string | null }; regionId: string | null; ownerGroupId: string | null; status: string; currency: string };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const canOrgCompliance = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) =>
  hasCapability(req, db, COMPLIANCE_MODULE, action, { organizationId, kind: 'organization', id: organizationId });
export const complianceLocations = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction = 'view') => capabilityLocations(req, db, organizationId, COMPLIANCE_MODULE, action);
const inAllowed = (allowed: 'all' | Set<string>, id: string | null | undefined) => allowed === 'all' || (!!id && allowed.has(id));

export async function orgDay(db: Exec, organizationId: string, now = new Date()) {
  const [o] = await db.select({ tz: organizations.defaultTimeZone }).from(organizations).where(eq(organizations.id, organizationId));
  return localDateParts(now, o?.tz ?? 'UTC').date;
}

/** Does a requirement apply to a location (jurisdiction codes `CA` or `CA-ON`)? */
export function appliesTo(r: Pick<Requirement, 'jurisdictions'>, l: Pick<Loc, 'country' | 'address'>): boolean {
  if (!r.jurisdictions.length) return true;
  const region = (l.address?.region ?? '').toUpperCase().replace(/^[A-Z]{2}-/, '');
  return r.jurisdictions.some((j) => { const [c, rg] = j.toUpperCase().split('-'); return c === l.country.toUpperCase() && (!rg || rg === region); });
}

/** Can the viewer see a document? Location documents: the location in scope; owner-group documents: any of the group's locations in scope. */
export function docVisible(d: Pick<ComplianceDoc, 'locationId' | 'ownerGroupId'>, allowed: 'all' | Set<string>, locs: Array<Pick<Loc, 'id' | 'ownerGroupId'>>): boolean {
  if (allowed === 'all') return true;
  if (d.locationId) return allowed.has(d.locationId);
  return locs.some((l) => l.ownerGroupId === d.ownerGroupId && allowed.has(l.id));
}

export async function orgLocationsFull(db: Exec, organizationId: string): Promise<Loc[]> {
  return (await db.select({ id: locations.id, name: locations.name, code: locations.code, country: locations.country, address: locations.address, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, status: locations.status, currency: locations.currency, archivedAt: locations.archivedAt })
    .from(locations).where(eq(locations.organizationId, organizationId))).filter((l) => !l.archivedAt && l.status !== 'closed') as Loc[];
}

export async function loadDocument(req: FastifyRequest, db: Exec, organizationId: string, id: string) {
  await requireMember(req, db, organizationId);
  const [d] = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organizationId, organizationId)));
  if (!d) throw notFound('Document');
  const allowed = await complianceLocations(req, db, organizationId);
  if (!docVisible(d, allowed, await orgLocationsFull(db, organizationId))) throw notFound('Document');
  return d;
}

/** May the viewer act (`edit` upload / `publish` review) on a document target? Owner-group targets need the action at every location of the group. */
export async function canActOnTarget(req: FastifyRequest, db: Exec, organizationId: string, t: { locationId: string | null; ownerGroupId: string | null }, action: AccessAction) {
  const allowed = await complianceLocations(req, db, organizationId, action);
  if (allowed === 'all') return true;
  if (t.locationId) return allowed.has(t.locationId);
  const groupLocs = (await orgLocationsFull(db, organizationId)).filter((l) => l.ownerGroupId === t.ownerGroupId);
  return groupLocs.length > 0 && groupLocs.every((l) => allowed.has(l.id));
}

export function serializeRequirement(r: Requirement) {
  return {
    id: r.id, name: r.name, category: r.category, description: r.description, coverageType: r.coverageType,
    minAmount: r.minAmountMinor != null && r.currency ? { amountMinor: r.minAmountMinor, currency: r.currency } : null, appliesTo: r.appliesTo, jurisdictions: r.jurisdictions,
    requiresExpiry: r.requiresExpiry, active: r.active, createdAt: r.createdAt.toISOString(),
  };
}

export function serializeDocument(s: Services, d: ComplianceDoc, today: string, extra: { locationName?: string | null; ownerGroupName?: string | null; requirementName?: string | null; names?: Map<string, string> } = {}) {
  const daysLeft = d.expiresOn ? daysUntil(d.expiresOn, today) : null;
  return {
    id: d.id, requirementId: d.requirementId, requirementName: extra.requirementName ?? null, locationId: d.locationId, locationName: extra.locationName ?? null, ownerGroupId: d.ownerGroupId,
    ownerGroupName: extra.ownerGroupName ?? null, category: d.category, title: d.title, issuer: d.issuer, reference: d.reference, coverageType: d.coverageType,
    coverageAmount: d.coverageAmountMinor != null && d.currency ? { amountMinor: d.coverageAmountMinor, currency: d.currency } : null, issuedOn: d.issuedOn, expiresOn: d.expiresOn, daysLeft,
    expiry: d.status !== 'approved' || daysLeft === null ? null : daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'expiring' : 'valid',
    status: d.status, superseded: !!d.supersededAt, reviewNote: d.reviewNote, reviewedAt: iso(d.reviewedAt), reviewedBy: d.reviewedBy ? extra.names?.get(d.reviewedBy) ?? null : null,
    uploadedBy: d.uploadedBy ? extra.names?.get(d.uploadedBy) ?? null : null, file: d.fileId ? { id: d.fileId, url: signedFileUrl(s, d.fileId) } : null,
    remindersSent: d.remindersSent, createdAt: d.createdAt.toISOString(),
  };
}

export interface MatrixCell { requirementId: string; state: ComplianceState | 'not_applicable'; expiresOn: string | null; daysLeft: number | null; documentId: string | null }

/** The compliance matrix for the locations in scope: one row per location, one cell per active requirement. */
export async function complianceMatrix(db: Exec, organizationId: string, allowed: 'all' | Set<string>, filter: { regionId?: string; ownerGroupId?: string; category?: string } = {}, now = new Date()) {
  const today = await orgDay(db, organizationId, now);
  const reqs = (await db.select().from(complianceRequirements).where(and(eq(complianceRequirements.organizationId, organizationId), eq(complianceRequirements.active, true))))
    .filter((r) => !filter.category || r.category === filter.category).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const locs = (await orgLocationsFull(db, organizationId)).filter((l) => inAllowed(allowed, l.id))
    .filter((l) => (!filter.regionId || l.regionId === filter.regionId) && (!filter.ownerGroupId || l.ownerGroupId === filter.ownerGroupId)).sort((a, b) => a.name.localeCompare(b.name));
  const docs = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.organizationId, organizationId), isNull(complianceDocuments.supersededAt), isNotNull(complianceDocuments.requirementId)));
  const groups = await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, organizationId));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const totals: Record<string, number> = { valid: 0, expiring: 0, expired: 0, missing: 0, pending: 0, below_minimum: 0 };
  const rows = locs.map((l) => {
    const cells: MatrixCell[] = reqs.map((r) => {
      if (!appliesTo(r, l)) return { requirementId: r.id, state: 'not_applicable', expiresOn: null, daysLeft: null, documentId: null };
      const mine = docs.filter((d) => d.requirementId === r.id && (r.appliesTo === 'owner_group' ? !!l.ownerGroupId && d.ownerGroupId === l.ownerGroupId : d.locationId === l.id));
      const st = complianceState(mine, { minAmountMinor: r.minAmountMinor, currency: r.currency }, today);
      totals[st.state] = (totals[st.state] ?? 0) + 1;
      const doc = mine.filter((d) => d.status === 'approved' && d.expiresOn === st.expiresOn)[0] ?? mine.find((d) => d.status === 'pending') ?? null;
      return { requirementId: r.id, state: st.state, expiresOn: st.expiresOn, daysLeft: st.daysLeft, documentId: doc?.id ?? null };
    });
    const applicable = cells.filter((c) => c.state !== 'not_applicable');
    return {
      location: { id: l.id, name: l.name, code: l.code, regionId: l.regionId, ownerGroupId: l.ownerGroupId, ownerGroupName: l.ownerGroupId ? groupName.get(l.ownerGroupId) ?? null : null, status: l.status },
      cells, compliant: applicable.filter((c) => c.state === 'valid' || c.state === 'expiring').length, applicable: applicable.length,
    };
  });
  return { today, requirements: reqs.map(serializeRequirement), rows, totals };
}

/** After approval, older approved documents for the same requirement and target stop counting. */
export async function supersedeOlder(db: Exec, d: ComplianceDoc, now = new Date()) {
  if (!d.requirementId) return;
  const target = d.locationId ? eq(complianceDocuments.locationId, d.locationId) : eq(complianceDocuments.ownerGroupId, d.ownerGroupId!);
  const older = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.requirementId, d.requirementId), target, eq(complianceDocuments.status, 'approved'), isNull(complianceDocuments.supersededAt)));
  const replace = older.filter((o) => o.id !== d.id && (o.expiresOn ?? '9999-12-31') <= (d.expiresOn ?? '9999-12-31'));
  if (replace.length) await db.update(complianceDocuments).set({ supersededAt: now, updatedAt: now }).where(inArray(complianceDocuments.id, replace.map((o) => o.id)));
}

/** People to remind about a document: those who can upload for its location (or for the group's locations). */
async function documentContacts(db: Exec, d: Pick<ComplianceDoc, 'organizationId' | 'locationId' | 'ownerGroupId'>): Promise<string[]> {
  if (d.locationId) return usersWithCapability(db, d.organizationId, d.locationId, COMPLIANCE_MODULE, 'edit');
  const locs = await db.select({ id: locations.id }).from(locations).where(eq(locations.ownerGroupId, d.ownerGroupId!));
  const out = new Set<string>();
  for (const l of locs) for (const u of await usersWithCapability(db, d.organizationId, l.id, COMPLIANCE_MODULE, 'edit')) out.add(u);
  return [...out];
}

/**
 * Expiry reminders, at most one email per step and document: 60, 30 and 7 days before, and on the day it expires.
 * On expiry the people with publish on Compliance documents organisation-wide (HQ, the owner) are told as well.
 */
export async function runComplianceJobs(s: Services, now = new Date(), organizationId?: string) {
  const conds = [eq(complianceDocuments.status, 'approved'), isNull(complianceDocuments.supersededAt), isNotNull(complianceDocuments.expiresOn)];
  if (organizationId) conds.push(eq(complianceDocuments.organizationId, organizationId));
  const docs = await s.db.select().from(complianceDocuments).where(and(...conds));
  const today = new Map<string, string>();
  let reminders = 0;
  let escalations = 0;
  for (const d of docs) {
    if (!today.has(d.organizationId)) today.set(d.organizationId, await orgDay(s.db, d.organizationId, now));
    const daysLeft = daysUntil(d.expiresOn!, today.get(d.organizationId)!);
    const step = dueReminderStep(daysLeft, d.remindersSent);
    if (step === null) continue;
    // A replacement waiting for review: still remind, it isn't valid until approved.
    const [where] = d.locationId
      ? await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, d.locationId))
      : await s.db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, d.ownerGroupId!));
    const label = `${d.title}${where ? ` (${where.name})` : ''}`;
    const ids = await documentContacts(s.db, d);
    const emails = ids.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    const subject = step === 0 ? `Expired: ${label}` : `Expires in ${daysLeft} days: ${label}`;
    for (const e of emails) {
      await s.jobs.enqueue('email.send', { to: e.email, subject, text: `${label} ${step === 0 ? 'has expired' : `expires on ${d.expiresOn}`}.\nUpload the renewed document: ${s.cfg.APP_URL}/compliance`, tag: 'compliance_expiry' });
    }
    const sent = [...new Set([...d.remindersSent, ...[60, 30, 7, 0].filter((x) => x >= step)])].sort((a, b) => b - a);
    let escalatedAt = d.escalatedAt;
    if (step === 0 && !d.escalatedAt) {
      const hq = await usersWithCapability(s.db, d.organizationId, null, COMPLIANCE_MODULE, 'publish');
      const hqEmails = hq.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, hq)) : [];
      for (const e of hqEmails) {
        await s.jobs.enqueue('email.send', { to: e.email, subject: `Compliance: ${label} has expired`, text: `${label} expired on ${d.expiresOn} and no renewed document has been approved.\nReview the compliance matrix: ${s.cfg.APP_URL}/compliance`, tag: 'compliance_escalation' });
      }
      escalatedAt = now;
      escalations++;
    }
    await s.db.update(complianceDocuments).set({ remindersSent: sent, escalatedAt, updatedAt: now }).where(eq(complianceDocuments.id, d.id));
    reminders++;
  }
  // Required documents that were never uploaded: weekly reminders, HQ after 30 days.
  const missing = await runMissingDocumentReminders(s, now, organizationId);
  return { checked: docs.length, reminders, escalations, missing };
}

/* ------------------------------------------------------------------ */
/* Required documents that are missing                                 */
/* ------------------------------------------------------------------ */

const WEEK = 7 * 86_400_000;
export const MISSING_ESCALATE_DAYS = 30;

/**
 * Required but missing documents (nothing uploaded for a requirement that applies): the uploaders for the location
 * (or owner group) are reminded weekly; once a document has been missing for 30 days, the people with publish on
 * Compliance documents organisation-wide (HQ, the owner) are told once. A document waiting for review counts as
 * uploaded. Tracking rows are removed as soon as a document arrives.
 */
export async function runMissingDocumentReminders(s: Services, now = new Date(), organizationId?: string) {
  const reqConds = [eq(complianceRequirements.active, true)];
  if (organizationId) reqConds.push(eq(complianceRequirements.organizationId, organizationId));
  const orgIds = [...new Set((await s.db.select({ o: complianceRequirements.organizationId }).from(complianceRequirements).where(and(...reqConds))).map((r) => r.o))];
  let reminders = 0;
  let escalations = 0;
  let missing = 0;
  for (const orgId of orgIds) {
    const matrix = await complianceMatrix(s.db, orgId, 'all', {}, now);
    const reqs = await s.db.select().from(complianceRequirements).where(eq(complianceRequirements.organizationId, orgId));
    const locRows = await s.db.select({ id: locations.id, createdAt: locations.createdAt, archivedAt: locations.archivedAt }).from(locations).where(eq(locations.organizationId, orgId));
    // Missing targets: a location, or an owner group for owner-group requirements (once per group).
    const targets = new Map<string, { requirementId: string; locationId: string | null; ownerGroupId: string | null; since: Date; label: string }>();
    for (const row of matrix.rows) {
      const loc = locRows.find((l) => l.id === row.location.id);
      if (!loc || loc.archivedAt || !['operating', 'opening_soon', 'onboarding'].includes(row.location.status)) continue;
      for (const c of row.cells) {
        if (c.state !== 'missing') continue;
        const r = reqs.find((x) => x.id === c.requirementId)!;
        const group = r.appliesTo === 'owner_group' ? row.location.ownerGroupId : null;
        if (r.appliesTo === 'owner_group' && !group) continue;
        const key = group ? `${r.id}:g:${group}` : `${r.id}:l:${row.location.id}`;
        if (targets.has(key)) continue;
        const since = new Date(Math.max(r.createdAt.getTime(), group ? 0 : loc.createdAt.getTime()));
        targets.set(key, { requirementId: r.id, locationId: group ? null : row.location.id, ownerGroupId: group, since, label: `${r.name} (${group ? row.location.ownerGroupName ?? '' : row.location.name})` });
      }
    }
    const tracked = await s.db.select().from(complianceMissingReminders).where(eq(complianceMissingReminders.organizationId, orgId));
    const keyOf = (t: { requirementId: string; locationId: string | null; ownerGroupId: string | null }) => (t.ownerGroupId ? `${t.requirementId}:g:${t.ownerGroupId}` : `${t.requirementId}:l:${t.locationId}`);
    // Resolved: a document arrived (or the requirement no longer applies).
    const resolved = tracked.filter((t) => !targets.has(keyOf(t)));
    if (resolved.length) await s.db.delete(complianceMissingReminders).where(inArray(complianceMissingReminders.id, resolved.map((t) => t.id)));
    const hq = await usersWithCapability(s.db, orgId, null, COMPLIANCE_MODULE, 'publish');
    for (const [key, t] of targets) {
      missing++;
      let row = tracked.find((x) => keyOf(x) === key);
      if (!row) [row] = await s.db.insert(complianceMissingReminders).values({ organizationId: orgId, requirementId: t.requirementId, locationId: t.locationId, ownerGroupId: t.ownerGroupId, missingSince: t.since }).returning();
      const set: Partial<typeof complianceMissingReminders.$inferInsert> = {};
      if (!row!.lastRemindedAt || now.getTime() - row!.lastRemindedAt.getTime() >= WEEK) {
        const ids = await documentContacts(s.db, { organizationId: orgId, locationId: t.locationId, ownerGroupId: t.ownerGroupId });
        // The location's own uploaders; HQ only when nobody else can upload there (HQ gets the 30-day escalation).
        const local = ids.filter((id) => !hq.includes(id));
        const uploaders = local.length ? local : ids;
        const emails = uploaders.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, uploaders)) : [];
        for (const e of emails) {
          await s.jobs.enqueue('email.send', { to: e.email, subject: `Missing: ${t.label}`, text: `HQ requires ${t.label} and nothing has been uploaded yet.\nUpload it here: ${s.cfg.APP_URL}/compliance`, tag: 'compliance_missing' });
        }
        Object.assign(set, { lastRemindedAt: now, reminderCount: row!.reminderCount + 1 });
        reminders++;
      }
      const days = Math.floor((now.getTime() - row!.missingSince.getTime()) / 86_400_000);
      if (!row!.escalatedAt && days >= MISSING_ESCALATE_DAYS) {
        const hqEmails = hq.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, hq)) : [];
        for (const e of hqEmails) {
          await s.jobs.enqueue('email.send', { to: e.email, subject: `Compliance: ${t.label} missing for ${days} days`, text: `${t.label} is required and has been missing for ${days} days.\nReview the compliance matrix: ${s.cfg.APP_URL}/compliance`, tag: 'compliance_missing_escalation' });
        }
        set.escalatedAt = now;
        escalations++;
      }
      if (Object.keys(set).length) await s.db.update(complianceMissingReminders).set(set).where(eq(complianceMissingReminders.id, row!.id));
    }
  }
  return { missing, reminders, escalations };
}
