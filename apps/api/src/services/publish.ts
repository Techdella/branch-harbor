import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { connections, fieldOverrides, locations, pageVersions, pages, publishJobResults, publishJobs, websites } from '../db/schema/index.ts';
import { audit } from './audit.ts';
import { publishableDocument } from './site-builder.ts';

export async function pageContent(db: Exec, pageId: string): Promise<Record<string, unknown>> {
  const fields = await db.select().from(fieldOverrides).where(eq(fieldOverrides.pageId, pageId));
  return Object.fromEntries(fields.map((f) => [f.fieldKey, f.value]));
}

/** Snapshot the page's current content as a new version and mark it published. */
export async function publishPage(db: Exec, pageId: string, actorUserId: string | null, publishJobId: string | null = null) {
  const content = await pageContent(db, pageId);
  // Website builder pages: the published snapshot is the validated public document (no drafts, no pending changes).
  const document = await publishableDocument(db, pageId);
  const [last] = await db.select({ v: pageVersions.version }).from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(desc(pageVersions.version)).limit(1);
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  const [ver] = await db.insert(pageVersions).values({ organizationId: page!.organizationId, pageId, version: (last?.v ?? 0) + 1, content, document, createdBy: actorUserId, publishJobId }).returning();
  await db.update(pages).set({ status: 'published', publishedVersionId: ver!.id, publishedAt: new Date(), scheduledPublishAt: null, updatedAt: new Date() }).where(eq(pages.id, pageId));
  return ver!;
}

/**
 * Publish one page slug across many locations, recording an independent result per location.
 * A partial failure is reported as `partial`, never as success; failed locations can be retried.
 */
export async function executePublishJob(s: Services, jobId: string, opts: { onlyFailed?: boolean; actorUserId: string | null }) {
  const [job] = await s.db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
  if (!job) throw new Error('job not found');
  await s.db.update(publishJobs).set({ status: 'running' }).where(eq(publishJobs.id, jobId));
  const results = await s.db.select().from(publishJobResults).where(eq(publishJobResults.jobId, jobId));
  const todo = results.filter((r) => (opts.onlyFailed ? r.status === 'failed' : r.status === 'pending'));
  const locRows = todo.length ? await s.db.select().from(locations).where(inArray(locations.id, todo.map((t) => t.locationId))) : [];

  for (const r of todo) {
    const loc = locRows.find((l) => l.id === r.locationId);
    const fail = async (error: string, status: 'failed' | 'skipped' = 'failed') =>
      s.db.update(publishJobResults).set({ status, error, attempts: r.attempts + 1, updatedAt: new Date() }).where(eq(publishJobResults.id, r.id));
    try {
      if (!loc || loc.archivedAt) { await fail('Location is archived', 'skipped'); continue; }
      const [site] = await s.db.select().from(websites).where(and(eq(websites.organizationId, job.organizationId), eq(websites.locationId, loc.id)));
      if (!site) { await fail('This location has no website yet'); continue; }
      const [page] = await s.db.select().from(pages).where(and(eq(pages.websiteId, site.id), eq(pages.slug, job.pageSlug)));
      if (!page) { await fail(`Page "${job.pageSlug}" does not exist on this location's website`); continue; }
      if (page.status === 'pending_approval') { await fail('A change on this page is awaiting approval'); continue; }
      if (page.archivedAt) { await fail('Page is archived', 'skipped'); continue; }
      const warnings: string[] = [];
      const localFields = await s.db.select({ key: fieldOverrides.fieldKey }).from(fieldOverrides).where(and(eq(fieldOverrides.pageId, page.id), eq(fieldOverrides.origin, 'local')));
      if (localFields.length) warnings.push(`Local overrides kept: ${localFields.map((f) => f.key).join(', ')}`);
      if (site.kind === 'wordpress') {
        const [conn] = site.connectionId ? await s.db.select().from(connections).where(eq(connections.id, site.connectionId)) : [];
        if (!conn || conn.state !== 'connected') { await fail(`WordPress connection is ${conn?.state ?? 'missing'} — reconnect and retry`); continue; }
      }
      const ver = await s.db.transaction(async (tx) => publishPage(tx, page.id, opts.actorUserId, job.id));
      await s.db.update(publishJobResults).set({ status: 'succeeded', error: null, warnings, pageId: page.id, versionId: ver.id, attempts: r.attempts + 1, updatedAt: new Date() }).where(eq(publishJobResults.id, r.id));
    } catch (err) {
      const e = err as Error & { code?: string };
      await fail(e.code === 'document_invalid' ? 'Some sections need attention before this page can go live' : `Unexpected error: ${e.message}`);
    }
  }

  const final = await s.db.select().from(publishJobResults).where(eq(publishJobResults.jobId, jobId));
  const ok = final.filter((r) => r.status === 'succeeded').length;
  const failed = final.filter((r) => r.status === 'failed').length;
  const status = failed === 0 ? 'completed' : ok === 0 ? 'failed' : 'partial';
  const [updated] = await s.db.update(publishJobs).set({ status, finishedAt: new Date() }).where(eq(publishJobs.id, jobId)).returning();
  await audit(s.db, { organizationId: job.organizationId, actorUserId: opts.actorUserId, action: opts.onlyFailed ? 'publish.retried' : 'publish.executed', scopeKind: 'organization', scopeId: job.organizationId, targetType: 'publish_job', targetId: jobId, metadata: { succeeded: ok, failed, total: final.length } });
  return { job: updated!, results: final };
}

export function serializeJob(job: typeof publishJobs.$inferSelect, results: Array<typeof publishJobResults.$inferSelect>) {
  return {
    id: job.id, pageSlug: job.pageSlug, status: job.status, note: job.note, createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null,
    summary: {
      total: results.length,
      succeeded: results.filter((r) => r.status === 'succeeded').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      pending: results.filter((r) => r.status === 'pending').length,
    },
    results: results.map((r) => ({ locationId: r.locationId, status: r.status, error: r.error, warnings: r.warnings, attempts: r.attempts, pageId: r.pageId, versionId: r.versionId, updatedAt: r.updatedAt.toISOString() })),
  };
}
