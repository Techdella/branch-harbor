import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  approvals, fieldOverrides, locations, organizations, pageVersions, pages, publishJobResults, publishJobs, templates, websites, type FieldOrigin, type TemplateField,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireMember, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { executePublishJob, publishPage, serializeJob } from '../services/publish.ts';
import { isIndependent, websiteApprovalMode } from '../services/businessMode.ts';
import { slugify } from '../lib/slug.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

const templateField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().min(1),
  type: z.enum(['text', 'richtext', 'image', 'url', 'json']).default('text'),
  policy: z.enum(['locked', 'editable', 'approval']),
  defaultValue: z.unknown(),
});

/** Labels for the default fields of pages created without a template (independent businesses). */
const DEFAULT_FIELD_LABELS: Record<string, string> = { hero_title: 'Headline', offer: 'Offer or announcement', about: 'About your business' };

export const originFor = (policy: TemplateField['policy']): FieldOrigin => (policy === 'locked' ? 'locked' : policy === 'approval' ? 'approval' : 'hq');

export const websiteRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const pageScope = (orgId: string, locationId: string | null): ScopeTarget => (locationId ? { organizationId: orgId, kind: 'location', id: locationId } : { organizationId: orgId, kind: 'organization', id: orgId });

  async function loadPage(orgId: string, pageId: string) {
    const [page] = await s.db.select().from(pages).where(and(eq(pages.id, pageId), eq(pages.organizationId, orgId)));
    if (!page) throw notFound('Page');
    return page;
  }

  /**
   * Independent businesses have no HQ: no locked or approval-required fields. With website approvals off
   * (default) everyone who can edit applies changes directly; with approvals for staff, edits by people
   * without approval rights go to the owner first.
   */
  async function websiteMode(orgId: string) {
    const [org] = await s.db.select({ model: organizations.model, settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    const independent = !!org && isIndependent(org);
    return { independent, approvals: independent ? websiteApprovalMode(org!) : null };
  }

  async function pageView(pageId: string, mode?: { independent: boolean; approvals: 'off' | 'staff' | null }) {
    const [page] = await s.db.select().from(pages).where(eq(pages.id, pageId));
    const fields = await s.db.select().from(fieldOverrides).where(eq(fieldOverrides.pageId, pageId));
    const [tpl] = page!.templateId ? await s.db.select().from(templates).where(eq(templates.id, page!.templateId)) : [];
    const labels = new Map((tpl?.fields ?? []).map((f) => [f.key, f]));
    const m = mode ?? await websiteMode(page!.organizationId);
    return {
      id: page!.id, websiteId: page!.websiteId, locationId: page!.locationId, slug: page!.slug, title: page!.title, status: page!.status, seo: page!.seo,
      publishedVersionId: page!.publishedVersionId, publishedAt: iso(page!.publishedAt),
      businessModel: m.independent ? 'independent' : 'network',
      ...(m.independent ? { approvals: m.approvals } : {}),
      fields: fields.map((f) => ({
        key: f.fieldKey, label: labels.get(f.fieldKey)?.label ?? DEFAULT_FIELD_LABELS[f.fieldKey] ?? f.fieldKey, type: labels.get(f.fieldKey)?.type ?? 'text',
        // Independent businesses have one owner and no HQ/local split: every field is simply the business's content.
        origin: m.independent ? 'local' : f.origin, value: f.value, hqValue: m.independent ? null : f.hqValue, isOverridden: !m.independent && f.origin === 'local',
        editableLocally: m.independent || f.origin === 'hq' || f.origin === 'local', requiresApproval: m.independent ? m.approvals === 'staff' : f.origin === 'approval',
        pendingValue: f.pendingValue ?? null, pendingApprovalId: f.pendingApprovalId,
      })),
    };
  }

  // ── Templates ──
  app.get('/orgs/:orgId/templates', { schema: { tags: ['websites'], security: secured, params: orgParams, description: 'Independent businesses: `hidden: true` — template policies (locked/approval fields) are a network tool.' } }, async (req) => {
    await requireMember(req, s.db, req.params.orgId);
    if ((await websiteMode(req.params.orgId)).independent) return { items: [], hidden: true, reason: 'independent_business' };
    return { items: await s.db.select().from(templates).where(eq(templates.organizationId, req.params.orgId)) };
  });

  app.post('/orgs/:orgId/templates', {
    schema: { tags: ['websites'], security: secured, params: orgParams, body: z.object({ name: z.string().min(1), industry: z.string().optional(), fields: z.array(templateField).min(1) }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const [t] = await s.db.insert(templates).values({ organizationId: orgId, name: req.body.name, industry: req.body.industry ?? null, fields: req.body.fields as TemplateField[] }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'template.created', targetType: 'template', targetId: t!.id });
    return reply.code(201).send(t);
  });

  app.patch('/orgs/:orgId/templates/:id', {
    schema: {
      tags: ['websites'], security: secured, params: idParams,
      summary: 'Update HQ defaults. Pages inheriting a field receive the new value; local overrides keep theirs (hqValue is updated for reset).',
      body: z.object({ name: z.string().optional(), defaults: z.record(z.string(), z.unknown()).default({}) }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const [t] = await s.db.select().from(templates).where(and(eq(templates.id, id), eq(templates.organizationId, orgId)));
    if (!t) throw notFound('Template');
    const fields = t.fields.map((f) => (f.key in req.body.defaults ? { ...f, defaultValue: req.body.defaults[f.key] } : f));
    const result = await s.db.transaction(async (tx) => {
      const [nt] = await tx.update(templates).set({ name: req.body.name ?? t.name, fields, version: t.version + 1, updatedAt: new Date() }).where(eq(templates.id, id)).returning();
      const pageRows = await tx.select({ id: pages.id }).from(pages).where(eq(pages.templateId, id));
      let inherited = 0, keptLocal = 0;
      for (const [key, value] of Object.entries(req.body.defaults)) {
        if (!pageRows.length) break;
        const rows = await tx.select().from(fieldOverrides).where(and(inArray(fieldOverrides.pageId, pageRows.map((p) => p.id)), eq(fieldOverrides.fieldKey, key)));
        for (const f of rows) {
          if (f.origin === 'local') { keptLocal++; await tx.update(fieldOverrides).set({ hqValue: value }).where(eq(fieldOverrides.id, f.id)); }
          else { inherited++; await tx.update(fieldOverrides).set({ hqValue: value, value, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id)); }
        }
      }
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'template.updated', targetType: 'template', targetId: id, metadata: { inherited, keptLocal } });
      return { template: nt!, affected: { inheritedFields: inherited, localOverridesKept: keptLocal } };
    });
    return result;
  });

  // ── Websites ──
  app.get('/orgs/:orgId/websites', { schema: { tags: ['websites'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'website.edit');
    const rows = await s.db.select().from(websites).where(eq(websites.organizationId, orgId));
    return { items: rows.filter((w) => allowed === 'all' || (w.locationId && allowed.has(w.locationId))) };
  });

  app.post('/orgs/:orgId/websites', {
    schema: {
      tags: ['websites'], security: secured, params: orgParams,
      body: z.object({ locationId: z.uuid().nullable().default(null), kind: z.enum(['hosted', 'wordpress']).default('hosted'), templateId: z.uuid().optional(), connectionId: z.uuid().optional(), pages: z.array(z.object({ slug: z.string().min(1), title: z.string().min(1) })).default([{ slug: 'home', title: 'Home' }]) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, b.locationId));
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const [loc] = b.locationId ? await s.db.select().from(locations).where(and(eq(locations.id, b.locationId), eq(locations.organizationId, orgId))) : [];
    if (b.locationId && !loc) throw notFound('Location');
    const [tpl] = b.templateId ? await s.db.select().from(templates).where(and(eq(templates.id, b.templateId), eq(templates.organizationId, orgId))) : [];
    if (b.templateId && !tpl) throw notFound('Template');
    const out = await s.db.transaction(async (tx) => {
      const [site] = await tx.insert(websites).values({
        organizationId: orgId, locationId: b.locationId, kind: b.kind, templateId: tpl?.id ?? null, connectionId: b.connectionId ?? null,
        // Independent businesses: the brand site IS the location site, served at /{brand}.
        includedAddress: `${s.cfg.SITES_BASE_URL}/${org!.slug}${loc && !isIndependent(org!) ? `/${loc.slug}` : ''}`,
      }).returning();
      for (const p of b.pages) {
        const [page] = await tx.insert(pages).values({ organizationId: orgId, websiteId: site!.id, locationId: b.locationId, templateId: tpl?.id ?? null, slug: slugify(p.slug), title: p.title }).returning();
        if (tpl?.fields.length) {
          await tx.insert(fieldOverrides).values(tpl.fields.map((f) => ({ organizationId: orgId, pageId: page!.id, fieldKey: f.key, origin: isIndependent(org!) ? 'hq' as const : originFor(f.policy), value: f.defaultValue ?? null, hqValue: f.defaultValue ?? null })));
        } else if (isIndependent(org!) && loc) {
          // Independent businesses have no templates: start every page with simple editable content.
          const defaults: Record<string, unknown> = { hero_title: p.slug === 'home' ? org!.name : p.title, offer: '', about: '' };
          await tx.insert(fieldOverrides).values(Object.entries(defaults).map(([fieldKey, value]) => ({ organizationId: orgId, pageId: page!.id, fieldKey, origin: 'hq' as const, value, hqValue: value })));
        }
      }
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'website.created', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'website', targetId: site!.id });
      return site!;
    });
    const pageRows = await s.db.select({ id: pages.id, slug: pages.slug, title: pages.title, status: pages.status }).from(pages).where(eq(pages.websiteId, out.id));
    return reply.code(201).send({ ...out, pages: pageRows, note: 'The website is a draft. Nothing is visible to customers until you publish.' });
  });

  app.get('/orgs/:orgId/websites/:id/pages', { schema: { tags: ['websites'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const [site] = await s.db.select().from(websites).where(and(eq(websites.id, id), eq(websites.organizationId, orgId)));
    if (!site) throw notFound('Website');
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, site.locationId));
    return { items: await s.db.select().from(pages).where(eq(pages.websiteId, id)) };
  });

  app.get('/orgs/:orgId/pages/:id', { schema: { tags: ['websites'], security: secured, params: idParams } }, async (req) => {
    const page = await loadPage(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.edit', pageScope(req.params.orgId, page.locationId));
    return pageView(page.id);
  });

  app.patch('/orgs/:orgId/pages/:id/fields', {
    schema: {
      tags: ['websites'], security: secured, params: idParams,
      summary: 'Edit page fields respecting origin: locked → HQ only; approval → creates an approval request; hq/local → local override',
      body: z.object({ fields: z.record(z.string(), z.unknown()), comment: z.string().max(1000).optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const me = requireUser(req);
    const page = await loadPage(orgId, id);
    const scope = pageScope(orgId, page.locationId);
    await requirePerm(req, s.db, 'website.edit', scope);
    const canHq = await hasPerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const canApprove = await hasPerm(req, s.db, 'website.approve', scope);
    const mode = await websiteMode(orgId);
    const existing = await s.db.select().from(fieldOverrides).where(eq(fieldOverrides.pageId, id));
    const results: Array<{ key: string; result: 'applied' | 'pending_approval' | 'rejected_locked' | 'unknown_field'; approvalId?: string }> = [];
    await s.db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(req.body.fields)) {
        const f = existing.find((e) => e.fieldKey === key);
        if (!f) { results.push({ key, result: 'unknown_field' }); continue; }
        if (mode.independent) {
          // No locks for independent businesses; approvals only when the owner enabled them for staff.
          if (mode.approvals === 'staff' && !canApprove) {
            const [ap] = await tx.insert(approvals).values({ organizationId: orgId, locationId: page.locationId, targetType: 'field', targetId: f.id, payload: { pageId: id, fieldKey: key, value }, requestedBy: me.id, requestComment: req.body.comment ?? null }).returning();
            await tx.update(fieldOverrides).set({ pendingValue: value, pendingApprovalId: ap!.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
            results.push({ key, result: 'pending_approval', approvalId: ap!.id });
          } else {
            await tx.update(fieldOverrides).set({ value, hqValue: value, updatedBy: me.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
            results.push({ key, result: 'applied' });
          }
          continue;
        }
        if (f.origin === 'locked') {
          if (!canHq) { results.push({ key, result: 'rejected_locked' }); continue; }
          await tx.update(fieldOverrides).set({ value, hqValue: value, updatedBy: me.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
          results.push({ key, result: 'applied' });
        } else if (f.origin === 'approval' && !canApprove) {
          const [ap] = await tx.insert(approvals).values({ organizationId: orgId, locationId: page.locationId, targetType: 'field', targetId: f.id, payload: { pageId: id, fieldKey: key, value }, requestedBy: me.id, requestComment: req.body.comment ?? null }).returning();
          await tx.update(fieldOverrides).set({ pendingValue: value, pendingApprovalId: ap!.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
          results.push({ key, result: 'pending_approval', approvalId: ap!.id });
        } else {
          await tx.update(fieldOverrides).set({ value, origin: f.origin === 'approval' ? 'approval' : 'local', updatedBy: me.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
          results.push({ key, result: 'applied' });
        }
      }
      if (results.some((r) => r.result === 'applied') && page.status === 'published') await tx.update(pages).set({ status: 'draft', updatedAt: new Date() }).where(eq(pages.id, id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'page.fields_edited', scopeKind: scope.kind, scopeId: scope.id, targetType: 'page', targetId: id, metadata: { results } });
    });
    if (results.every((r) => r.result === 'rejected_locked' || r.result === 'unknown_field')) {
      throw new AppError(403, 'fields_locked', 'These fields are controlled by headquarters', Object.fromEntries(results.map((r) => [r.key, r.result === 'unknown_field' ? 'Unknown field' : 'Locked brand content'])));
    }
    return { results, page: await pageView(id, mode) };
  });

  app.post('/orgs/:orgId/pages/:id/fields/:key/reset', {
    schema: { tags: ['websites'], security: secured, params: idParams.extend({ key: z.string() }), summary: 'Reset a local override to the HQ default' },
  }, async (req) => {
    const { orgId, id, key } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const [f] = await s.db.select().from(fieldOverrides).where(and(eq(fieldOverrides.pageId, id), eq(fieldOverrides.fieldKey, key)));
    if (!f) throw notFound('Field');
    if (f.origin !== 'local') throw conflict('not_overridden', 'This field is not locally overridden');
    await s.db.update(fieldOverrides).set({ value: f.hqValue, origin: 'hq', updatedBy: req.user!.id, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'page.field_reset', targetType: 'page', targetId: id, metadata: { key } });
    return pageView(id);
  });

  app.post('/orgs/:orgId/pages/:id/submit', {
    schema: { tags: ['websites'], security: secured, params: idParams, body: z.object({ comment: z.string().max(1000).optional() }).default({}), summary: 'Submit a page for approval' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    if (page.status === 'pending_approval') throw conflict('already_pending', 'This page is already awaiting approval');
    const ap = await s.db.transaction(async (tx) => {
      const [ap] = await tx.insert(approvals).values({ organizationId: orgId, locationId: page.locationId, targetType: 'page', targetId: id, requestedBy: req.user!.id, requestComment: req.body.comment ?? null }).returning();
      await tx.update(pages).set({ status: 'pending_approval', updatedAt: new Date() }).where(eq(pages.id, id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'page.submitted', targetType: 'page', targetId: id });
      return ap!;
    });
    return reply.code(201).send(ap);
  });

  // Approval list/decision live in routes/approvals.ts (one inbox for every kind of request).

  app.post('/orgs/:orgId/pages/:id/publish', { schema: { tags: ['websites'], security: secured, params: idParams, summary: 'Publish a single page (creates a version snapshot)' } }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    const scope = pageScope(orgId, page.locationId);
    await requirePerm(req, s.db, 'website.publish', scope);
    if (page.status === 'pending_approval') throw conflict('pending_approval', 'This page is awaiting approval');
    const mode = await websiteMode(orgId);
    if (mode.independent && mode.approvals === 'staff' && !(await hasPerm(req, s.db, 'website.approve', scope))) {
      throw conflict('approval_required', 'The owner asked to approve website changes before they go live. Submit the page for approval instead.');
    }
    const pendingFields = await s.db.select({ k: fieldOverrides.fieldKey }).from(fieldOverrides).where(and(eq(fieldOverrides.pageId, id)));
    const ver = await s.db.transaction(async (tx) => {
      const v = await publishPage(tx, id, req.user!.id);
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'page.published', targetType: 'page', targetId: id, metadata: { version: v.version } });
      return v;
    });
    return { version: ver, fieldCount: pendingFields.length, approvalRequired: false, businessModel: mode.independent ? 'independent' : 'network' };
  });

  app.get('/orgs/:orgId/pages/:id/versions', { schema: { tags: ['websites'], security: secured, params: idParams } }, async (req) => {
    const page = await loadPage(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.edit', pageScope(req.params.orgId, page.locationId));
    return { items: await s.db.select().from(pageVersions).where(eq(pageVersions.pageId, page.id)).orderBy(desc(pageVersions.version)) };
  });

  app.post('/orgs/:orgId/pages/:id/rollback', {
    schema: { tags: ['websites'], security: secured, params: idParams, body: z.object({ versionId: z.uuid() }), summary: 'Restore field values from a previous version and republish' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.publish', pageScope(orgId, page.locationId));
    const [v] = await s.db.select().from(pageVersions).where(and(eq(pageVersions.id, req.body.versionId), eq(pageVersions.pageId, id)));
    if (!v) throw notFound('Version');
    const ver = await s.db.transaction(async (tx) => {
      for (const [k, val] of Object.entries(v.content)) await tx.update(fieldOverrides).set({ value: val, updatedAt: new Date() }).where(and(eq(fieldOverrides.pageId, id), eq(fieldOverrides.fieldKey, k)));
      const nv = await publishPage(tx, id, req.user!.id);
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'page.rolled_back', targetType: 'page', targetId: id, metadata: { toVersion: v.version, newVersion: nv.version } });
      return nv;
    });
    return { restoredFrom: v.version, version: ver };
  });

  // ── Group publishing ──
  const assertPublishScope = async (req: FastifyRequest, orgId: string, locationIds: string[]) => {
    const allowed = await authorisedLocations(req, s.db, orgId, 'website.publish');
    const denied = allowed === 'all' ? [] : locationIds.filter((l) => !allowed.has(l));
    if (denied.length) throw new AppError(403, 'forbidden', 'You cannot publish to some of the selected locations', undefined, { deniedLocationIds: denied });
  };

  app.post('/orgs/:orgId/publish-jobs', {
    schema: {
      tags: ['websites'], security: secured, params: orgParams,
      summary: 'Publish a page to many locations; each location gets an independent result',
      body: z.object({ pageSlug: z.string().min(1), locationIds: z.array(z.uuid()).min(1).max(500), note: z.string().max(500).optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const ids = [...new Set(req.body.locationIds)];
    await assertPublishScope(req, orgId, ids);
    const found = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, ids)));
    if (found.length !== ids.length) throw validationError('Some locations do not belong to this organisation', { locationIds: 'Unknown location' });
    const [job] = await s.db.insert(publishJobs).values({ organizationId: orgId, requestedBy: req.user!.id, pageSlug: req.body.pageSlug, note: req.body.note ?? null }).returning();
    await s.db.insert(publishJobResults).values(ids.map((locationId) => ({ organizationId: orgId, jobId: job!.id, locationId })));
    const { job: done, results } = await executePublishJob(s, job!.id, { actorUserId: req.user!.id });
    return reply.code(201).send(serializeJob(done, results));
  });

  app.get('/orgs/:orgId/publish-jobs/:id', { schema: { tags: ['websites'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requireMember(req, s.db, orgId);
    const [job] = await s.db.select().from(publishJobs).where(and(eq(publishJobs.id, id), eq(publishJobs.organizationId, orgId)));
    if (!job) throw notFound('Publish job');
    const results = await s.db.select().from(publishJobResults).where(eq(publishJobResults.jobId, id));
    await assertPublishScope(req, orgId, results.map((r) => r.locationId));
    return serializeJob(job, results);
  });

  app.post('/orgs/:orgId/publish-jobs/:id/retry', { schema: { tags: ['websites'], security: secured, params: idParams, summary: 'Retry only the failed locations' } }, async (req) => {
    const { orgId, id } = req.params;
    const [job] = await s.db.select().from(publishJobs).where(and(eq(publishJobs.id, id), eq(publishJobs.organizationId, orgId)));
    if (!job) throw notFound('Publish job');
    const results = await s.db.select().from(publishJobResults).where(eq(publishJobResults.jobId, id));
    const failed = results.filter((r) => r.status === 'failed');
    if (!failed.length) throw conflict('nothing_to_retry', 'No failed locations to retry');
    await assertPublishScope(req, orgId, failed.map((r) => r.locationId));
    const { job: done, results: final } = await executePublishJob(s, id, { onlyFailed: true, actorUserId: req.user!.id });
    return serializeJob(done, final);
  });
};
