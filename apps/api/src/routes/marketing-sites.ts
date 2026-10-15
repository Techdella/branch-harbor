/**
 * Website builder API (Marketing workspace → marketing.website_builder): page list, draft documents with autosave,
 * governance, history/restore, SEO/navigation, redirects on slug change, scheduled publishing, HQ master pages and
 * the theme library. Publishing itself uses the existing endpoints (POST /pages/:id/publish, /publish-jobs), which
 * now snapshot the page document.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { SITE_FONT_KEYS, SITE_THEMES, navLinkSchema, pageDocumentSchema, pageSeoSchema, resetSectionToHq, validatePageDocument } from '@bh/shared';
import { approvals, locations, organizations, pageRevisions, pageVersions, pages, siteRedirects, templates, websites } from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { isIndependent } from '../services/businessMode.ts';
import { applyMasterToLocation, assertValidDocument, checkpoint, documentForRestore, draftDocument, saveDraft, syncMasterToPages } from '../services/site-builder.ts';
import { iso, isoDateTime, orgParams, secured } from './_common.ts';

const tags = ['website builder'];
const pageParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const RESERVED_SLUGS = new Set(['book', 'classes', 'order', 'shop', 'pay', 'account', 'manage', 'pricing', 'online', 'packages', 'programmes', 'properties', 'catering', 'meal-plans', 'preorder', 'table', 'orders', 'f', 'pages', 'sitemap.xml', 'robots.txt']);

const themeSettingsSchema = z.object({
  themeId: z.enum(SITE_THEMES.map((t) => t.id) as [string, ...string[]]),
  colorMode: z.enum(['theme', 'brand']).default('theme'),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  headingFont: z.enum(SITE_FONT_KEYS as [string, ...string[]]).nullable().default(null),
  bodyFont: z.enum(SITE_FONT_KEYS as [string, ...string[]]).nullable().default(null),
  logoUrl: z.string().max(2048).refine((v) => /^https:\/\//.test(v) || /^\/v1\/public\/assets\//.test(v) || /^http:\/\/localhost(:\d+)?\/v1\/public\/assets\//.test(v), 'Use an https image').nullable().optional(),
});

export const marketingSiteRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const orgScope = (orgId: string): ScopeTarget => ({ organizationId: orgId, kind: 'organization', id: orgId });
  const pageScope = (orgId: string, locationId: string | null): ScopeTarget => (locationId ? { organizationId: orgId, kind: 'location', id: locationId } : orgScope(orgId));

  async function loadPage(orgId: string, id: string) {
    const [page] = await s.db.select().from(pages).where(and(eq(pages.id, id), eq(pages.organizationId, orgId)));
    if (!page) throw notFound('Page');
    return page;
  }
  async function loadOrg(orgId: string) {
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw notFound('Organisation');
    return org;
  }
  async function rights(req: FastifyRequest, orgId: string, locationId: string | null) {
    const scope = pageScope(orgId, locationId);
    const [canHq, canApprove, canPublish, canDesign] = await Promise.all([
      hasPerm(req, s.db, 'templates.write', orgScope(orgId)), hasPerm(req, s.db, 'website.approve', scope),
      hasPerm(req, s.db, 'website.publish', scope), hasPerm(req, s.db, 'website.design', orgScope(orgId)),
    ]);
    return { canHq, canApprove, canPublish, canDesign };
  }
  function pageMeta(p: typeof pages.$inferSelect) {
    return {
      id: p.id, websiteId: p.websiteId, locationId: p.locationId, templateId: p.templateId, slug: p.slug, title: p.title, status: p.status, seo: p.seo,
      navLabel: p.navLabel, showInNav: p.showInNav, navOrder: p.navOrder, revision: p.revision, builder: !!p.document,
      publishedAt: iso(p.publishedAt), publishedVersionId: p.publishedVersionId, scheduledPublishAt: iso(p.scheduledPublishAt), updatedAt: p.updatedAt.toISOString(),
    };
  }
  const siteTheme = (org: typeof organizations.$inferSelect) => {
    const site = (org.settings.site ?? {}) as Record<string, unknown>;
    return {
      themeId: typeof site.themeId === 'string' ? site.themeId : 'classic',
      colorMode: site.colorMode === 'theme' || site.colorMode === 'brand' ? site.colorMode : (typeof site.themeId === 'string' ? 'theme' : 'brand'),
      primaryColor: typeof site.primaryColor === 'string' ? site.primaryColor : '#141414',
      accentColor: typeof site.accentColor === 'string' ? site.accentColor : null,
      headingFont: typeof site.headingFont === 'string' ? site.headingFont : null,
      bodyFont: typeof site.bodyFont === 'string' ? site.bodyFont : (typeof site.font === 'string' && site.font !== 'system' ? site.font : null),
      logoUrl: typeof site.logoUrl === 'string' ? site.logoUrl : null,
    };
  };

  // ── Sites & pages ──
  app.get('/orgs/:orgId/builder/sites', { schema: { tags, security: secured, params: orgParams, summary: 'Websites you can edit with their pages (draft + publish state)' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'website.edit');
    const org = await loadOrg(orgId);
    const sites = (await s.db.select().from(websites).where(eq(websites.organizationId, orgId))).filter((w) => allowed === 'all' || (w.locationId && allowed.has(w.locationId)));
    const pageRows = sites.length ? await s.db.select().from(pages).where(and(inArray(pages.websiteId, sites.map((w) => w.id)), isNull(pages.archivedAt))).orderBy(asc(pages.navOrder), asc(pages.createdAt)) : [];
    const locs = await s.db.select({ id: locations.id, name: locations.name, slug: locations.slug }).from(locations).where(eq(locations.organizationId, orgId));
    const pending = pageRows.length ? await s.db.select({ targetId: approvals.targetId }).from(approvals).where(and(eq(approvals.organizationId, orgId), eq(approvals.status, 'pending'), inArray(approvals.targetType, ['section', 'page']))) : [];
    return {
      theme: siteTheme(org), independent: isIndependent(org), industry: org.industry,
      items: sites.map((w) => ({
        id: w.id, kind: w.kind, status: w.status, locationId: w.locationId, includedAddress: w.includedAddress, navLinks: w.navLinks,
        location: locs.find((l) => l.id === w.locationId) ?? null,
        pages: pageRows.filter((p) => p.websiteId === w.id).map((p) => ({ ...pageMeta(p), pendingApprovals: pending.filter((a) => a.targetId === p.id).length })),
      })),
    };
  });

  app.post('/orgs/:orgId/websites/:id/builder-pages', {
    schema: { tags, security: secured, params: pageParams, summary: 'Add a page to a website (optionally with a starting document)', body: z.object({ title: z.string().trim().min(1).max(80), slug: z.string().max(60).optional(), document: pageDocumentSchema.optional(), showInNav: z.boolean().default(true) }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const [site] = await s.db.select().from(websites).where(and(eq(websites.id, id), eq(websites.organizationId, orgId)));
    if (!site) throw notFound('Website');
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, site.locationId));
    const slug = slugify(req.body.slug || req.body.title);
    if (RESERVED_SLUGS.has(slug)) throw validationError('This address is used by the booking and ordering pages', { slug: 'Reserved' });
    const [dupe] = await s.db.select({ id: pages.id }).from(pages).where(and(eq(pages.websiteId, id), eq(pages.slug, slug)));
    if (dupe) throw conflict('slug_taken', 'A page with this address already exists');
    const doc = assertValidDocument(req.body.document ?? { schemaVersion: 1, sections: [] }, 'draft');
    const [maxOrder] = await s.db.select({ n: pages.navOrder }).from(pages).where(eq(pages.websiteId, id)).orderBy(desc(pages.navOrder)).limit(1);
    const [page] = await s.db.insert(pages).values({ organizationId: orgId, websiteId: id, locationId: site.locationId, slug, title: req.body.title, document: { ...doc, sections: doc.sections.map((x) => ({ ...x, origin: 'local' as const })) }, revision: 1, showInNav: req.body.showInNav, navOrder: (maxOrder?.n ?? 0) + 1 }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'page.created', scopeKind: site.locationId ? 'location' : 'organization', scopeId: site.locationId ?? orgId, targetType: 'page', targetId: page!.id });
    return reply.code(201).send(pageMeta(page!));
  });

  app.get('/orgs/:orgId/pages/:id/builder', { schema: { tags, security: secured, params: pageParams, summary: 'Everything the builder needs: draft document, rights, theme, location preview data' } }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const org = await loadOrg(orgId);
    const [site] = await s.db.select().from(websites).where(eq(websites.id, page.websiteId));
    const [loc] = page.locationId ? await s.db.select().from(locations).where(eq(locations.id, page.locationId)) : [];
    const document = await draftDocument(s.db, page);
    const r = await rights(req, orgId, page.locationId);
    const independent = isIndependent(org);
    const siblings = await s.db.select({ id: pages.id, slug: pages.slug, title: pages.title, navLabel: pages.navLabel, showInNav: pages.showInNav, navOrder: pages.navOrder }).from(pages).where(and(eq(pages.websiteId, page.websiteId), isNull(pages.archivedAt))).orderBy(asc(pages.navOrder));
    const base = site!.includedAddress.replace(/\/$/, '');
    return {
      page: pageMeta(page), document, independent, industry: org.industry, brandName: org.name, defaultLocale: org.defaultLocale,
      website: { id: site!.id, kind: site!.kind, includedAddress: site!.includedAddress, navLinks: site!.navLinks, pages: siblings },
      location: loc ? { id: loc.id, name: loc.name, address: loc.address, country: loc.country, phone: loc.phone, email: loc.email, hours: loc.hours, geo: loc.geo, locale: loc.locale, timeZone: loc.timeZone } : null,
      theme: siteTheme(org),
      permissions: { ...r, canHq: r.canHq || independent, governed: !independent && !r.canHq && !!page.templateId },
      publicUrl: page.slug === 'home' ? base : `${base}/${page.slug}`,
    };
  });

  app.put('/orgs/:orgId/pages/:id/document', {
    schema: {
      tags, security: secured, params: pageParams,
      summary: 'Save the draft (autosave). Governance: locked sections are refused, approval sections create approval requests; 409 revision_conflict when someone else saved first.',
      body: z.object({ document: z.unknown(), baseRevision: z.number().int().min(0), checkpoint: z.boolean().default(false), comment: z.string().max(1000).optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const me = requireUser(req);
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const parsed = validatePageDocument(req.body.document, 'draft');
    if (!parsed.document) throw new AppError(422, 'document_invalid', 'The page could not be saved', undefined, { issues: parsed.issues });
    const r = await rights(req, orgId, page.locationId);
    const org = await loadOrg(orgId);
    const out = await saveDraft(s.db, page, parsed.document, { baseRevision: req.body.baseRevision, userId: me.id, canHq: r.canHq, canApprove: r.canApprove, independent: isIndependent(org), comment: req.body.comment });
    if (req.body.checkpoint) await checkpoint(s.db, page, out.revision, out.document, 'manual', me.id, true);
    return out;
  });

  app.patch('/orgs/:orgId/pages/:id/meta', {
    schema: {
      tags, security: secured, params: pageParams, summary: 'Title, address (old address redirects), SEO and navigation settings',
      body: z.object({ title: z.string().trim().min(1).max(80).optional(), slug: z.string().max(60).optional(), seo: pageSeoSchema.optional(), navLabel: z.string().max(40).nullable().optional(), showInNav: z.boolean().optional(), navOrder: z.number().int().min(0).max(1000).optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const b = req.body;
    let slug = page.slug;
    if (b.slug !== undefined && slugify(b.slug) !== page.slug) {
      if (page.slug === 'home') throw validationError('The home page address cannot change', { slug: 'Home page' });
      if (page.templateId && !(await hasPerm(req, s.db, 'templates.write', orgScope(orgId)))) throw validationError('Headquarters manages the address of this page', { slug: 'Locked' });
      slug = slugify(b.slug);
      if (RESERVED_SLUGS.has(slug) || slug === 'home') throw validationError('This address is reserved', { slug: 'Reserved' });
      const [dupe] = await s.db.select({ id: pages.id }).from(pages).where(and(eq(pages.websiteId, page.websiteId), eq(pages.slug, slug)));
      if (dupe) throw conflict('slug_taken', 'A page with this address already exists');
    }
    const updated = await s.db.transaction(async (tx) => {
      const [u] = await tx.update(pages).set({
        title: b.title ?? page.title, slug, seo: b.seo ? { ...page.seo, ...b.seo } : page.seo,
        navLabel: b.navLabel === undefined ? page.navLabel : b.navLabel, showInNav: b.showInNav ?? page.showInNav, navOrder: b.navOrder ?? page.navOrder, updatedAt: new Date(),
      }).where(eq(pages.id, id)).returning();
      if (slug !== page.slug) {
        // Old address → new address (and keep earlier redirects pointing at the final page; no chains).
        await tx.update(siteRedirects).set({ toSlug: slug }).where(and(eq(siteRedirects.websiteId, page.websiteId), eq(siteRedirects.toSlug, page.slug)));
        await tx.delete(siteRedirects).where(and(eq(siteRedirects.websiteId, page.websiteId), eq(siteRedirects.fromSlug, slug)));
        await tx.insert(siteRedirects).values({ organizationId: orgId, websiteId: page.websiteId, fromSlug: page.slug, toSlug: slug }).onConflictDoUpdate({ target: [siteRedirects.websiteId, siteRedirects.fromSlug], set: { toSlug: slug } });
      }
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'page.meta_updated', targetType: 'page', targetId: id, metadata: { slugChanged: slug !== page.slug ? { from: page.slug, to: slug } : null } });
      return u!;
    });
    return pageMeta(updated);
  });

  app.delete('/orgs/:orgId/pages/:id', { schema: { tags, security: secured, params: pageParams, summary: 'Archive a page (recoverable). The home page cannot be archived.' } }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.publish', pageScope(orgId, page.locationId));
    if (page.slug === 'home') throw validationError('The home page cannot be archived', { slug: 'Home page' });
    if (page.templateId && !(await hasPerm(req, s.db, 'templates.write', orgScope(orgId)))) throw validationError('Headquarters manages this page', { page: 'Locked' });
    await s.db.update(pages).set({ status: 'archived', archivedAt: new Date(), scheduledPublishAt: null, updatedAt: new Date() }).where(eq(pages.id, id));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'page.archived', targetType: 'page', targetId: id });
    return { id, archived: true };
  });

  app.get('/orgs/:orgId/pages/:id/history', { schema: { tags, security: secured, params: pageParams, summary: 'Draft checkpoints and published versions' } }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const revs = await s.db.select({ id: pageRevisions.id, revision: pageRevisions.revision, reason: pageRevisions.reason, createdBy: pageRevisions.createdBy, createdAt: pageRevisions.createdAt }).from(pageRevisions).where(eq(pageRevisions.pageId, id)).orderBy(desc(pageRevisions.createdAt)).limit(100);
    const vers = await s.db.select({ id: pageVersions.id, version: pageVersions.version, createdBy: pageVersions.createdBy, createdAt: pageVersions.createdAt, publishJobId: pageVersions.publishJobId }).from(pageVersions).where(eq(pageVersions.pageId, id)).orderBy(desc(pageVersions.version)).limit(100);
    return {
      revisions: revs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      versions: vers.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), live: v.id === page.publishedVersionId })),
    };
  });

  app.post('/orgs/:orgId/pages/:id/restore', {
    schema: { tags, security: secured, params: pageParams, summary: 'Restore a draft checkpoint or a published version into the draft (governance applies)', body: z.object({ revisionId: z.uuid().optional(), versionId: z.uuid().optional(), baseRevision: z.number().int().min(0) }).refine((b) => !!b.revisionId !== !!b.versionId, 'Pass revisionId or versionId') },
  }, async (req) => {
    const { orgId, id } = req.params;
    const me = requireUser(req);
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    const target = req.body.revisionId
      ? (await s.db.select({ d: pageRevisions.document }).from(pageRevisions).where(and(eq(pageRevisions.id, req.body.revisionId), eq(pageRevisions.pageId, id))))[0]?.d
      : (await s.db.select({ d: pageVersions.document }).from(pageVersions).where(and(eq(pageVersions.id, req.body.versionId!), eq(pageVersions.pageId, id))))[0]?.d;
    if (!target) throw notFound('Version');
    const r = await rights(req, orgId, page.locationId);
    const org = await loadOrg(orgId);
    const current = await draftDocument(s.db, page);
    // Keep a restore point of what is being replaced.
    await checkpoint(s.db, page, page.revision, current, 'restore', me.id, true);
    const out = await saveDraft(s.db, page, documentForRestore(current, target), { baseRevision: req.body.baseRevision, userId: me.id, canHq: r.canHq, canApprove: r.canApprove, independent: isIndependent(org) });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'page.restored', targetType: 'page', targetId: id, metadata: { revisionId: req.body.revisionId ?? null, versionId: req.body.versionId ?? null } });
    return out;
  });

  app.post('/orgs/:orgId/pages/:id/sections/:sectionId/reset', {
    schema: { tags, security: secured, params: pageParams.extend({ sectionId: z.string().max(64) }), summary: 'Reset a local override to the headquarters version', body: z.object({ baseRevision: z.number().int().min(0) }) },
  }, async (req) => {
    const { orgId, id, sectionId } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, page.locationId));
    if (page.revision !== req.body.baseRevision) throw conflict('revision_conflict', 'This page was changed somewhere else. Reload to continue from the latest version.', { revision: page.revision });
    const doc = resetSectionToHq(await draftDocument(s.db, page), sectionId);
    if (!doc) throw conflict('not_overridden', 'This section is not a local override');
    await s.db.update(pages).set({ document: doc, revision: page.revision + 1, updatedAt: new Date() }).where(eq(pages.id, id));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'page.section_reset', targetType: 'page', targetId: id, metadata: { sectionId } });
    return { revision: page.revision + 1, document: doc };
  });

  app.post('/orgs/:orgId/pages/:id/schedule', {
    schema: { tags, security: secured, params: pageParams, summary: 'Schedule (or cancel with null) publishing of the current draft', body: z.object({ at: isoDateTime.nullable() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const page = await loadPage(orgId, id);
    await requirePerm(req, s.db, 'website.publish', pageScope(orgId, page.locationId));
    if (req.body.at) {
      const at = new Date(req.body.at);
      if (at.getTime() < Date.now() + 60_000) throw validationError('Choose a time at least a minute from now', { at: 'Too soon' });
      if (page.status === 'pending_approval') throw conflict('pending_approval', 'This page is awaiting approval');
      assertValidDocument(await draftDocument(s.db, page), 'publish');
    }
    const [u] = await s.db.update(pages).set({ scheduledPublishAt: req.body.at ? new Date(req.body.at) : null, scheduledBy: req.body.at ? req.user!.id : null, updatedAt: new Date() }).where(eq(pages.id, id)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: req.body.at ? 'page.publish_scheduled' : 'page.schedule_cancelled', targetType: 'page', targetId: id, metadata: { at: req.body.at } });
    return pageMeta(u!);
  });

  app.put('/orgs/:orgId/websites/:id/nav', {
    schema: { tags, security: secured, params: pageParams, summary: 'Navigation: page order/labels/visibility plus extra links', body: z.object({ pages: z.array(z.object({ id: z.uuid(), navLabel: z.string().max(40).nullable(), showInNav: z.boolean(), navOrder: z.number().int().min(0).max(1000) })).max(100), links: z.array(navLinkSchema).max(12) }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [site] = await s.db.select().from(websites).where(and(eq(websites.id, id), eq(websites.organizationId, orgId)));
    if (!site) throw notFound('Website');
    await requirePerm(req, s.db, 'website.edit', pageScope(orgId, site.locationId));
    await s.db.transaction(async (tx) => {
      for (const p of req.body.pages) await tx.update(pages).set({ navLabel: p.navLabel, showInNav: p.showInNav, navOrder: p.navOrder, updatedAt: new Date() }).where(and(eq(pages.id, p.id), eq(pages.websiteId, id)));
      await tx.update(websites).set({ navLinks: req.body.links, updatedAt: new Date() }).where(eq(websites.id, id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'website.nav_updated', targetType: 'website', targetId: id });
    });
    return { ok: true };
  });

  // ── Theme (presentation only; content is untouched) ──
  app.put('/orgs/:orgId/builder/theme', {
    schema: { tags, security: secured, params: orgParams, summary: 'Choose a theme and brand overrides. Switching theme never changes page content.', body: themeSettingsSchema },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'website.design', orgScope(orgId));
    const org = await loadOrg(orgId);
    const site = { ...((org.settings.site ?? {}) as Record<string, unknown>), ...req.body };
    if (req.body.logoUrl === undefined) delete site.logoUrl;
    await s.db.update(organizations).set({ settings: { ...org.settings, site }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'site.theme_changed', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId, metadata: { themeId: req.body.themeId, colorMode: req.body.colorMode } });
    return { theme: siteTheme({ ...org, settings: { ...org.settings, site } }) };
  });

  // ── HQ master pages ──
  const masterView = (t: typeof templates.$inferSelect, pageCount = 0) => ({ id: t.id, name: t.name, pageSlug: t.pageSlug ?? 'home', document: t.document, version: t.version, updatedAt: t.updatedAt.toISOString(), pageCount });

  app.get('/orgs/:orgId/builder/masters', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'website.edit', orgScope(orgId)).catch(async () => { await requirePerm(req, s.db, 'website.design', orgScope(orgId)); });
    const rows = await s.db.select().from(templates).where(and(eq(templates.organizationId, orgId)));
    const masters = rows.filter((t) => t.document);
    const counts = masters.length ? await s.db.select({ t: pages.templateId }).from(pages).where(and(inArray(pages.templateId, masters.map((m) => m.id)), isNull(pages.archivedAt))) : [];
    return { items: masters.map((m) => masterView(m, counts.filter((c) => c.t === m.id).length)) };
  });

  app.post('/orgs/:orgId/builder/masters', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(80), pageSlug: z.string().max(60).default('home'), document: pageDocumentSchema.optional() }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'website.design', orgScope(orgId));
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const doc = assertValidDocument(req.body.document ?? { schemaVersion: 1, sections: [] }, 'draft');
    const [org] = await s.db.select({ industry: organizations.industry }).from(organizations).where(eq(organizations.id, orgId));
    const [t] = await s.db.insert(templates).values({ organizationId: orgId, name: req.body.name, industry: org?.industry ?? null, fields: [], document: doc, pageSlug: slugify(req.body.pageSlug) }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'template.created', targetType: 'template', targetId: t!.id, metadata: { builder: true } });
    return reply.code(201).send(masterView(t!));
  });

  app.get('/orgs/:orgId/builder/masters/:id', { schema: { tags, security: secured, params: pageParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'website.design', orgScope(orgId));
    const [t] = await s.db.select().from(templates).where(and(eq(templates.id, id), eq(templates.organizationId, orgId)));
    if (!t?.document) throw notFound('Master page');
    const org = await loadOrg(orgId);
    const linked = await s.db.select({ id: pages.id, locationId: pages.locationId, status: pages.status, publishedAt: pages.publishedAt }).from(pages).where(and(eq(pages.templateId, id), isNull(pages.archivedAt)));
    return { ...masterView(t, linked.length), theme: siteTheme(org), brandName: org.name, industry: org.industry, defaultLocale: org.defaultLocale, linked: linked.map((l) => ({ ...l, publishedAt: iso(l.publishedAt) })) };
  });

  app.put('/orgs/:orgId/builder/masters/:id/document', {
    schema: { tags, security: secured, params: pageParams, summary: 'Save the master (with lock modes). Inherited content flows to every linked location draft; local overrides are kept.', body: z.object({ document: z.unknown(), version: z.number().int().min(1), name: z.string().trim().min(1).max(80).optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'website.design', orgScope(orgId));
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const doc = assertValidDocument(req.body.document, 'draft');
    return s.db.transaction(async (tx) => {
      const [t] = await tx.select().from(templates).where(and(eq(templates.id, id), eq(templates.organizationId, orgId))).for('update');
      if (!t?.document) throw notFound('Master page');
      if (t.version !== req.body.version) throw conflict('revision_conflict', 'This master page was changed somewhere else. Reload to continue.', { version: t.version });
      const [nt] = await tx.update(templates).set({ document: doc, name: req.body.name ?? t.name, version: t.version + 1, updatedAt: new Date() }).where(eq(templates.id, id)).returning();
      const affected = await syncMasterToPages(tx, id, doc);
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'template.updated', targetType: 'template', targetId: id, metadata: affected });
      return { master: masterView(nt!, affected.pages), affected };
    });
  });

  app.post('/orgs/:orgId/builder/masters/:id/apply', {
    schema: { tags, security: secured, params: pageParams, summary: 'Create or update the page on each location website from this master (drafts). Publish with /publish-jobs.', body: z.object({ locationIds: z.array(z.uuid()).min(1).max(500) }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'website.design', orgScope(orgId));
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const [t] = await s.db.select().from(templates).where(and(eq(templates.id, id), eq(templates.organizationId, orgId)));
    if (!t?.document) throw notFound('Master page');
    const org = await loadOrg(orgId);
    const ids = [...new Set(req.body.locationIds)];
    const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, ids)));
    if (locs.length !== ids.length) throw validationError('Some locations do not belong to this organisation', { locationIds: 'Unknown location' });
    const results: Array<{ locationId: string; status: string; reason: string | null; pageId: string | null }> = [];
    for (const l of locs) {
      try {
        const r = await s.db.transaction((tx) => applyMasterToLocation(tx, t, l.id, `${s.cfg.SITES_BASE_URL}/${org.slug}/${l.slug}`));
        results.push({ locationId: l.id, ...r });
      } catch (err) {
        results.push({ locationId: l.id, status: 'failed', reason: (err as Error).message.slice(0, 200), pageId: null });
      }
    }
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'template.applied', targetType: 'template', targetId: id, metadata: { results: results.map((r) => ({ locationId: r.locationId, status: r.status })) } });
    return { pageSlug: t.pageSlug ?? 'home', results };
  });
};
