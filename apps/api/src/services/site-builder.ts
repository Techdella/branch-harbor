/**
 * Website builder (Marketing workspace): page documents, draft autosave with optimistic concurrency, franchise
 * governance (locked / editable / approval sections mapped onto the field-origin + approvals model), HQ master
 * pages, version history, scheduled publishing and the migration of classic field pages to documents.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
  applyGovernedEdit, applyLegacyField, instantiateMaster, legacyFieldsToDocument, mergeMasterIntoPage, publicDocument, validatePageDocument,
  type DocumentIssue, type PageDocument,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Db, Exec } from '../db/client.ts';
import { approvals, fieldOverrides, organizations, pageRevisions, pageVersions, pages, templates, websites } from '../db/schema/index.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';

export type PageRow = typeof pages.$inferSelect;

/** Throws 422 with per-section issues when a document cannot be saved/published. */
export function assertValidDocument(input: unknown, mode: 'draft' | 'publish'): PageDocument {
  const r = validatePageDocument(input, mode);
  if (!r.ok) {
    throw new AppError(422, 'document_invalid', mode === 'publish' ? 'Some sections need attention before this page can go live' : 'The page could not be saved', undefined, { issues: r.issues as DocumentIssue[] });
  }
  return r.document;
}

async function industryOf(db: Exec, orgId: string) {
  const [o] = await db.select({ industry: organizations.industry }).from(organizations).where(eq(organizations.id, orgId));
  return o?.industry;
}

/** The page's draft document; classic field pages are converted on the fly (and saved by the migration). */
export async function draftDocument(db: Exec, page: PageRow): Promise<PageDocument> {
  if (page.document) return page.document;
  const fields = await db.select().from(fieldOverrides).where(eq(fieldOverrides.pageId, page.id));
  return legacyFieldsToDocument(Object.fromEntries(fields.map((f) => [f.fieldKey, f.value])), { industry: await industryOf(db, page.organizationId), slug: page.slug, locationLevel: !!page.locationId });
}

/** Keep the builder document in step with classic field edits (field editor still works after migration). */
export async function syncLegacyFieldsToDocument(db: Exec, pageId: string, values: Record<string, unknown>) {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page?.document) return;
  let doc = page.document;
  for (const [k, v] of Object.entries(values)) doc = applyLegacyField(doc, k, v);
  if (doc !== page.document) await db.update(pages).set({ document: doc, revision: page.revision + 1, updatedAt: new Date() }).where(eq(pages.id, pageId));
}

const CHECKPOINT_MS = 10 * 60_000;

/** Store a draft checkpoint for version history (at most one autosave checkpoint every 10 minutes). */
export async function checkpoint(db: Exec, page: Pick<PageRow, 'id' | 'organizationId'>, revision: number, document: PageDocument, reason: string, userId: string | null, force = false) {
  if (!force) {
    const [last] = await db.select({ at: pageRevisions.createdAt }).from(pageRevisions).where(eq(pageRevisions.pageId, page.id)).orderBy(desc(pageRevisions.createdAt)).limit(1);
    if (last && Date.now() - last.at.getTime() < CHECKPOINT_MS) return;
  }
  await db.insert(pageRevisions).values({ organizationId: page.organizationId, pageId: page.id, revision, document, reason, createdBy: userId });
}

export interface SaveResult {
  revision: number;
  document: PageDocument;
  rejected: Array<{ sectionId: string; reason: string }>;
  pendingApprovals: Array<{ sectionId: string; approvalId: string }>;
  overridden: string[];
}

/**
 * Save a draft under governance. Optimistic concurrency: `baseRevision` must match the stored revision, otherwise
 * 409 `revision_conflict` (another tab or person saved meanwhile) with the latest document.
 */
export async function saveDraft(db: Db, page: PageRow, incoming: PageDocument, opts: { baseRevision: number; userId: string; canHq: boolean; canApprove: boolean; independent: boolean; comment?: string | null }): Promise<SaveResult> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(pages).where(eq(pages.id, page.id)).for('update');
    if (!cur) throw notFound('Page');
    if (cur.revision !== opts.baseRevision) {
      throw conflict('revision_conflict', 'This page was changed somewhere else. Reload to continue from the latest version.', { revision: cur.revision });
    }
    const current = await draftDocument(tx, cur);
    // Independent businesses have no HQ: no locks; everyone who can edit is the brand owner.
    const gov = applyGovernedEdit(current, incoming, { canHq: opts.canHq || opts.independent, canApprove: opts.canApprove });
    const doc = assertValidDocument(gov.document, 'draft');
    const pendingApprovals: SaveResult['pendingApprovals'] = [];
    for (const a of gov.approvals) {
      const s = doc.sections.find((x) => x.id === a.sectionId)!;
      // A newer request replaces an older pending one for the same section.
      if (s.pending?.approvalId) await tx.update(approvals).set({ status: 'cancelled', decidedAt: new Date() }).where(and(eq(approvals.id, s.pending.approvalId), eq(approvals.status, 'pending')));
      const [ap] = await tx.insert(approvals).values({
        organizationId: cur.organizationId, locationId: cur.locationId, targetType: 'section', targetId: cur.id,
        payload: { pageId: cur.id, sectionId: a.sectionId, sectionType: s.type, props: a.props, style: a.style, titleI18n: { code: 'website_section_change', params: { section: s.type, page: cur.title } } },
        title: `Website change: ${cur.title}`, requestedBy: opts.userId, requestComment: opts.comment ?? null,
      }).returning();
      s.pending = { approvalId: ap!.id, props: a.props, style: a.style, requestedBy: opts.userId };
      pendingApprovals.push({ sectionId: a.sectionId, approvalId: ap!.id });
    }
    const revision = cur.revision + 1;
    await tx.update(pages).set({ document: doc, revision, status: cur.status === 'published' ? 'draft' : cur.status, updatedAt: new Date() }).where(eq(pages.id, cur.id));
    await checkpoint(tx, cur, revision, doc, 'autosave', opts.userId);
    if (gov.rejected.length || pendingApprovals.length) {
      await audit(tx, { organizationId: cur.organizationId, actorUserId: opts.userId, action: 'page.document_governed', scopeKind: cur.locationId ? 'location' : 'organization', scopeId: cur.locationId ?? cur.organizationId, targetType: 'page', targetId: cur.id, metadata: { rejected: gov.rejected, pendingApprovals } });
    }
    return { revision, document: doc, rejected: gov.rejected, pendingApprovals, overridden: gov.overridden };
  });
}

/** Approval of a section change: apply the pending content (it may have been replaced or cancelled since). */
export async function applySectionApproval(db: Db, ap: typeof approvals.$inferSelect, approverId: string) {
  const p = ap.payload as { pageId: string; sectionId: string };
  return db.transaction(async (tx) => {
    const [page] = await tx.select().from(pages).where(eq(pages.id, p.pageId)).for('update');
    if (!page?.document) throw notFound('Page');
    const s = page.document.sections.find((x) => x.id === p.sectionId);
    if (!s || s.pending?.approvalId !== ap.id) throw conflict('section_changed', 'This section changed since the request was made');
    const doc: PageDocument = { ...page.document, sections: page.document.sections.map((x) => (x.id === s.id ? { ...x, props: s.pending!.props, style: s.pending!.style ?? x.style, pending: undefined } : x)) };
    await tx.update(pages).set({ document: doc, revision: page.revision + 1, status: page.status === 'published' ? 'draft' : page.status, updatedAt: new Date() }).where(eq(pages.id, page.id));
    await audit(tx, { organizationId: page.organizationId, actorUserId: approverId, action: 'page.section_change_applied', targetType: 'page', targetId: page.id, metadata: { sectionId: s.id, approvalId: ap.id } });
    return { applied: true, pageId: page.id, sectionId: s.id };
  });
}

export async function clearSectionApproval(tx: Exec, ap: typeof approvals.$inferSelect) {
  const p = ap.payload as { pageId: string; sectionId: string };
  const [page] = await tx.select().from(pages).where(eq(pages.id, p.pageId));
  if (!page?.document) return;
  const doc: PageDocument = { ...page.document, sections: page.document.sections.map((x) => (x.id === p.sectionId && x.pending?.approvalId === ap.id ? { ...x, pending: undefined } : x)) };
  await tx.update(pages).set({ document: doc, revision: page.revision + 1, updatedAt: new Date() }).where(eq(pages.id, page.id));
}

/** Published snapshot of a builder page (strict validation). Returns null for classic field pages. */
export async function publishableDocument(db: Exec, pageId: string): Promise<PageDocument | null> {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page?.document) return null;
  return publicDocument(assertValidDocument(page.document, 'publish'));
}

// ───────── HQ master pages ─────────

/** Push a master document to every page built from it (drafts; publishing stays a separate, reviewed step). */
export async function syncMasterToPages(tx: Exec, templateId: string, master: PageDocument) {
  const rows = await tx.select().from(pages).where(and(eq(pages.templateId, templateId), isNull(pages.archivedAt)));
  let inherited = 0, keptLocal = 0, added = 0, removed = 0;
  for (const p of rows) {
    const current = await draftDocument(tx, p);
    const m = mergeMasterIntoPage(master, current);
    inherited += m.inherited; keptLocal += m.keptLocal; added += m.added; removed += m.removed;
    await tx.update(pages).set({ document: m.document, revision: p.revision + 1, status: p.status === 'published' ? 'draft' : p.status, updatedAt: new Date() }).where(eq(pages.id, p.id));
    await tx.insert(pageRevisions).values({ organizationId: p.organizationId, pageId: p.id, revision: p.revision + 1, document: m.document, reason: 'template' });
  }
  return { pages: rows.length, inheritedSections: inherited, localOverridesKept: keptLocal, addedSections: added, removedSections: removed };
}

/** Create or update one location page from an HQ master. */
export async function applyMasterToLocation(tx: Exec, tpl: typeof templates.$inferSelect, locationId: string, includedAddress: string) {
  const slug = tpl.pageSlug ?? 'home';
  let [site] = await tx.select().from(websites).where(and(eq(websites.organizationId, tpl.organizationId), eq(websites.locationId, locationId)));
  if (!site) [site] = await tx.insert(websites).values({ organizationId: tpl.organizationId, locationId, kind: 'hosted', templateId: tpl.id, includedAddress }).returning();
  if (site!.kind !== 'hosted') return { status: 'skipped' as const, reason: 'wordpress_site', pageId: null };
  const [existing] = await tx.select().from(pages).where(and(eq(pages.websiteId, site!.id), eq(pages.slug, slug)));
  const master = tpl.document!;
  if (existing) {
    const current = await draftDocument(tx, existing);
    // A page not built from this master yet: start from the master, keep nothing local (HQ chose to apply it).
    const doc = existing.templateId === tpl.id ? mergeMasterIntoPage(master, current).document : instantiateMaster(master);
    await tx.update(pages).set({ document: doc, templateId: tpl.id, revision: existing.revision + 1, status: existing.status === 'published' ? 'draft' : existing.status, updatedAt: new Date() }).where(eq(pages.id, existing.id));
    await tx.insert(pageRevisions).values({ organizationId: tpl.organizationId, pageId: existing.id, revision: existing.revision + 1, document: doc, reason: 'template' });
    return { status: 'updated' as const, reason: null, pageId: existing.id };
  }
  const [page] = await tx.insert(pages).values({ organizationId: tpl.organizationId, websiteId: site!.id, locationId, templateId: tpl.id, slug, title: tpl.name, document: instantiateMaster(master), revision: 1 }).returning();
  return { status: 'created' as const, reason: null, pageId: page!.id };
}

// ───────── Scheduled publishing ─────────

export async function runScheduledPublishes(s: Services, now = new Date()) {
  const due = await s.db.select().from(pages).where(and(isNotNull(pages.scheduledPublishAt), lte(pages.scheduledPublishAt, now), isNull(pages.archivedAt)));
  const { publishPage } = await import('./publish.ts');
  const out: Array<{ pageId: string; ok: boolean; error?: string }> = [];
  for (const p of due) {
    try {
      // Claim: clear the schedule first so two workers never publish the same page.
      const [claimed] = await s.db.update(pages).set({ scheduledPublishAt: null }).where(and(eq(pages.id, p.id), eq(pages.scheduledPublishAt, p.scheduledPublishAt!))).returning();
      if (!claimed) continue;
      if (p.status === 'pending_approval') throw new Error('awaiting_approval');
      await s.db.transaction(async (tx) => {
        const v = await publishPage(tx, p.id, p.scheduledBy);
        await audit(tx, { organizationId: p.organizationId, actorUserId: p.scheduledBy, action: 'page.published_scheduled', targetType: 'page', targetId: p.id, metadata: { version: v.version } });
      });
      out.push({ pageId: p.id, ok: true });
    } catch (err) {
      await audit(s.db, { organizationId: p.organizationId, actorUserId: p.scheduledBy, action: 'page.scheduled_publish_failed', targetType: 'page', targetId: p.id, metadata: { error: (err as Error).message } });
      out.push({ pageId: p.id, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

/** A version or revision to restore, mapped onto the current draft so governance metadata (origin, HQ copy) survives. */
export function documentForRestore(current: PageDocument, target: PageDocument): PageDocument {
  const byId = new Map(current.sections.map((x) => [x.id, x]));
  return {
    schemaVersion: 1,
    sections: target.sections.map((t) => {
      const c = byId.get(t.id);
      return c ? { ...c, props: t.props, style: t.style, hidden: t.hidden } : { id: t.id, type: t.type, props: t.props, style: t.style, hidden: t.hidden };
    }),
  };
}

// ───────── Migration: classic field pages → documents ─────────

/**
 * Idempotent: converts every page without a document (draft + its published version) into the builder model.
 * Published versions get a document built from their own snapshot, so live sites render exactly the published
 * content through the new renderer. Run by `db:migrate` and `db:migrate-sites`.
 */
export async function migrateSiteDocuments(db: Db) {
  const rows = await db.select({ p: pages, industry: organizations.industry }).from(pages).innerJoin(organizations, eq(organizations.id, pages.organizationId)).where(isNull(pages.document));
  let migratedPages = 0, migratedVersions = 0;
  for (const { p, industry } of rows) {
    await db.transaction(async (tx) => {
      const fields = await tx.select().from(fieldOverrides).where(eq(fieldOverrides.pageId, p.id));
      const doc = legacyFieldsToDocument(Object.fromEntries(fields.map((f) => [f.fieldKey, f.value])), { industry, slug: p.slug, locationLevel: !!p.locationId });
      await tx.update(pages).set({ document: doc, revision: p.revision + 1 }).where(and(eq(pages.id, p.id), isNull(pages.document)));
      await tx.insert(pageRevisions).values({ organizationId: p.organizationId, pageId: p.id, revision: p.revision + 1, document: doc, reason: 'migration' });
      migratedPages++;
    });
  }
  const versions = await db.select({ v: pageVersions, slug: pages.slug, locationId: pages.locationId, industry: organizations.industry }).from(pageVersions)
    .innerJoin(pages, eq(pages.id, pageVersions.pageId)).innerJoin(organizations, eq(organizations.id, pages.organizationId))
    .where(and(isNull(pageVersions.document), inArray(pageVersions.id, db.select({ id: pages.publishedVersionId }).from(pages).where(isNotNull(pages.publishedVersionId)) as never)));
  for (const { v, slug, industry, locationId } of versions) {
    await db.update(pageVersions).set({ document: publicDocument(legacyFieldsToDocument(v.content, { industry, slug, locationLevel: !!locationId })) }).where(eq(pageVersions.id, v.id));
    migratedVersions++;
  }
  return { migratedPages, migratedVersions };
}
