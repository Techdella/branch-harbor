/**
 * Multi-brand HQ (Settings → Brands, the top-bar brand switcher and the brand comparison report).
 *
 * One business account = one industry; a franchisor can run several brands of that industry under one HQ. Each brand
 * has its identity (logo, colours, fonts, theme, domain, languages, currency), email sender, review settings, brand
 * templates (site template, email theme, asset folder), franchise terms and onboarding checklist, and its locations.
 *
 * Access: anyone in the business lists the brands they cover (the switcher). Creating, renaming and archiving brands
 * needs Business settings (edit) organisation-wide; a brand's identity and templates can also be edited by someone
 * holding Brand templates (edit) on that brand. The comparison needs Reports (view); revenue there also needs Payments.
 */
import { and, count, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { FRANCHISE_STAGES, SITE_FONT_KEYS, SITE_THEMES, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES, type SiteFont } from '@bh/shared';
import {
  brands, emailTemplates, franchiseAgreements, franchiseDocuments, franchiseProspects, franchiseTerritories, locations, organizations, paymentReferences, royaltyTerms, templates,
} from '../db/schema/index.ts';
import { revenueByCurrency } from '../domain/reports.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { capabilityLocationIds } from '../domain/scope.ts';
import { defaultBrandId, hasCapability, requireCapability, requireMember, scopedLocations } from '../services/authz.ts';
import { brandFilterIds, brandInOrg, coveredBrandIds, orgBrands, serializeBrand } from '../services/brands.ts';
import { serializeTerms } from '../services/finance/terms.ts';
import { syncBillingQuietly } from '../services/billing.ts';
import { idParams, orgParams, secured } from './_common.ts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #2F6B3A');
const httpsUrl = z.url().refine((u) => u.startsWith('https://'), 'Must be an https:// URL');
const hostname = z.string().trim().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Use a host name like barre.example.com');
const font = z.enum(SITE_FONT_KEYS as [SiteFont, ...SiteFont[]]);

const identity = z.object({
  logoUrl: httpsUrl.nullable().optional(),
  primaryColor: hex.nullable().optional(),
  accentColor: hex.nullable().optional(),
  headingFont: font.nullable().optional(),
  bodyFont: font.nullable().optional(),
  themeId: z.enum(SITE_THEMES.map((t) => t.id) as [string, ...string[]]).nullable().optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  domain: hostname.nullable().optional(),
  locales: z.array(z.enum(SUPPORTED_LOCALES as unknown as [string, ...string[]])).max(SUPPORTED_LOCALES.length).optional(),
  defaultCurrency: z.enum(SUPPORTED_CURRENCIES as unknown as [string, ...string[]]).nullable().optional(),
  emailFromName: z.string().trim().min(1).max(80).nullable().optional(),
  emailReplyTo: z.email().max(200).nullable().optional(),
  onboardingTemplateKey: z.string().trim().max(60).nullable().optional(),
  siteTemplateId: z.uuid().nullable().optional(),
  emailTemplateId: z.uuid().nullable().optional(),
  assetFolder: z.string().trim().max(120).nullable().optional(),
  reviews: z.record(z.string(), z.unknown()).optional(),
});
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/, 'Lower-case letters, numbers and dashes');
const createBody = identity.extend({ name: z.string().trim().min(1).max(120), slug: slug.optional() });
const patchBody = identity.extend({ name: z.string().trim().min(1).max(120).optional(), slug: slug.optional() });

export const brandRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.ctx.db;
  app.addHook('preHandler', authenticate);
  const org = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });

  /** A public site address must be free across every business and brand. */
  async function assertSlugFree(slugValue: string, exceptBrandId?: string) {
    const [o] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slugValue));
    const [b] = await db.select({ id: brands.id, organizationId: brands.organizationId, isDefault: brands.isDefault }).from(brands).where(eq(brands.slug, slugValue));
    const ownDefault = b && b.isDefault && b.id === exceptBrandId;
    if ((o && !ownDefault) || (b && b.id !== exceptBrandId)) throw validationError('That site address is already taken', { slug: 'Choose another address' });
  }

  async function checkRefs(orgId: string, b: z.infer<typeof identity>) {
    if (b.siteTemplateId) {
      const [t] = await db.select({ id: templates.id }).from(templates).where(and(eq(templates.id, b.siteTemplateId), eq(templates.organizationId, orgId)));
      if (!t) throw notFound('Website template');
    }
    if (b.emailTemplateId) {
      const [t] = await db.select({ id: emailTemplates.id }).from(emailTemplates).where(and(eq(emailTemplates.id, b.emailTemplateId), eq(emailTemplates.organizationId, orgId)));
      if (!t) throw notFound('Email template');
    }
  }

  const columns = (b: z.infer<typeof identity>) => {
    const { siteTemplateId, emailTemplateId, assetFolder, reviews, ...cols } = b;
    return { cols: Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined)), settings: Object.fromEntries(Object.entries({ siteTemplateId, emailTemplateId, assetFolder, reviews }).filter(([, v]) => v !== undefined)) };
  };

  const locationCounts = async (orgId: string) => {
    const def = await defaultBrandId(db, orgId);
    const locs = await db.select({ brandId: locations.brandId }).from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
    const m = new Map<string, number>();
    for (const l of locs) {
      const id = l.brandId ?? def!;
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  };

  app.get('/orgs/:orgId/brands', {
    schema: { tags: ['orgs'], security: secured, params: orgParams, summary: 'Brands you cover (the brand switcher). `multiBrand` is false for single-brand businesses, which show no brand UI.' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const all = await orgBrands(db, orgId);
    const covered = await coveredBrandIds(req, db, orgId);
    const counts = await locationCounts(orgId);
    const items = all.filter((b) => covered === 'all' || covered.has(b.id)).map((b) => serializeBrand(b, { locationCount: counts.get(b.id) ?? 0 }));
    return { items, multiBrand: all.length > 1, canManage: await hasCapability(req, db, 'settings.business', 'edit', org(orgId)) };
  });

  app.post('/orgs/:orgId/brands', {
    schema: { tags: ['orgs'], security: secured, params: orgParams, body: createBody, summary: 'Add a brand of the same industry (HQ, Business settings edit)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireCapability(req, db, 'settings.business', 'edit', org(orgId));
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (o?.model === 'independent') throw conflict('network_required', 'Brands are for franchise and multi-location networks. Upgrade to a network first.');
    await defaultBrandId(db, orgId);
    const s = req.body.slug ?? slugify(req.body.name);
    await assertSlugFree(s);
    await checkRefs(orgId, req.body);
    const { cols, settings } = columns(req.body);
    const [row] = await db.insert(brands).values({ ...cols, organizationId: orgId, name: req.body.name, slug: s, isDefault: false, settings }).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'brand.created', scopeKind: 'brand', scopeId: row!.id, targetType: 'brand', targetId: row!.id, metadata: { name: row!.name, slug: s } });
    // Each brand beyond the first is a subscription item (extraBrand): billing follows.
    await syncBillingQuietly(app.ctx, orgId);
    return reply.code(201).send(serializeBrand(row!));
  });

  app.patch('/orgs/:orgId/brands/:id', {
    schema: { tags: ['orgs'], security: secured, params: idParams, body: patchBody, summary: 'Update a brand: name and address (HQ), identity, sender, templates and review settings (HQ or the brand’s template editors)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const before = await brandInOrg(db, orgId, id);
    if (!before) throw notFound('Brand');
    const hq = await hasCapability(req, db, 'settings.business', 'edit', org(orgId));
    if (!hq) {
      await requireCapability(req, db, 'network.templates', 'edit', { organizationId: orgId, kind: 'brand', id });
      if (req.body.name !== undefined || req.body.slug !== undefined) throw forbidden('Only HQ can rename a brand or change its address');
    }
    if (req.body.slug && req.body.slug !== before.slug) {
      if (before.isDefault) throw validationError('The main brand uses the business address', { slug: 'Change the business address instead' });
      await assertSlugFree(req.body.slug, id);
    }
    await checkRefs(orgId, req.body);
    const { cols, settings } = columns(req.body);
    const [row] = await db.update(brands).set({ ...cols, ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.slug ? { slug: req.body.slug } : {}), settings: { ...before.settings, ...settings }, updatedAt: new Date() })
      .where(eq(brands.id, id)).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'brand.updated', scopeKind: 'brand', scopeId: id, targetType: 'brand', targetId: id, metadata: { keys: Object.keys(req.body) } });
    return serializeBrand(row!, { locationCount: (await locationCounts(orgId)).get(id) ?? 0 });
  });

  app.delete('/orgs/:orgId/brands/:id', {
    schema: { tags: ['orgs'], security: secured, params: idParams, summary: 'Archive a brand without locations (the main brand cannot be archived)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireCapability(req, db, 'settings.business', 'edit', org(orgId));
    const b = await brandInOrg(db, orgId, id);
    if (!b || b.archivedAt) throw notFound('Brand');
    if (b.isDefault) throw conflict('default_brand', 'The main brand cannot be archived.');
    if ((await locationCounts(orgId)).get(id)) throw conflict('brand_has_locations', 'Move or archive this brand’s locations first.');
    await db.update(brands).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(brands.id, id));
    await audit(db, { organizationId: orgId, ...actor(req), action: 'brand.archived', scopeKind: 'brand', scopeId: id, targetType: 'brand', targetId: id });
    await syncBillingQuietly(app.ctx, orgId);
    return { ok: true };
  });

  /** Brand-specific franchise terms: disclosure documents, agreement templates, royalty/fund terms and the checklist. */
  app.get('/orgs/:orgId/brands/:id/franchise-terms', {
    schema: { tags: ['orgs'], security: secured, params: idParams, summary: 'Disclosure documents, agreement templates, royalty and fund terms and onboarding checklist attached to a brand (shown by what you can see)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const b = await brandInOrg(db, orgId, id);
    if (!b) throw notFound('Brand');
    const covered = await coveredBrandIds(req, db, orgId);
    if (covered !== 'all' && !covered.has(id)) throw notFound('Brand');
    const legal = await hasCapability(req, db, 'legal.disclosure', 'view', org(orgId));
    const royalties = await hasCapability(req, db, 'finance.royalties', 'view', org(orgId));
    const docs = legal ? await db.select({ id: franchiseDocuments.id, kind: franchiseDocuments.kind, title: franchiseDocuments.title, version: franchiseDocuments.version, jurisdictions: franchiseDocuments.jurisdictions, status: franchiseDocuments.status, brandId: franchiseDocuments.brandId })
      .from(franchiseDocuments).where(and(eq(franchiseDocuments.organizationId, orgId), inArray(franchiseDocuments.kind, ['disclosure', 'agreement_template']), or(eq(franchiseDocuments.brandId, id), isNull(franchiseDocuments.brandId)))) : null;
    const terms = royalties ? await db.select().from(royaltyTerms).where(and(eq(royaltyTerms.organizationId, orgId), eq(royaltyTerms.brandId, id), isNull(royaltyTerms.ownerGroupId))) : null;
    return {
      brandId: id,
      disclosureDocuments: docs?.filter((d) => d.kind === 'disclosure').map((d) => ({ ...d, shared: !d.brandId })) ?? null,
      agreementTemplates: docs?.filter((d) => d.kind === 'agreement_template').map((d) => ({ ...d, shared: !d.brandId })) ?? null,
      royaltyTerms: terms?.map((t) => ({ ...serializeTerms(t), brandId: t.brandId })) ?? null,
      onboardingTemplateKey: b.onboardingTemplateKey ?? 'standard_unit',
    };
  });

  /**
   * Network summary across brands and the brand comparison. Money is grouped per currency and never summed across
   * currencies; each brand lists its own currencies.
   */
  app.get('/orgs/:orgId/brands/comparison', {
    schema: {
      tags: ['reports'], security: secured, params: orgParams,
      querystring: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }),
      summary: 'Brand comparison and network summary: locations, revenue per currency (never summed across currencies), franchise pipeline and territories per brand',
    },
  }, async (req) => {
    const { orgId } = req.params;
    const assignments = await requireMember(req, db, orgId);
    const locs = await scopedLocations(db, orgId);
    const reportable = capabilityLocationIds(assignments, 'network.reports', 'view', orgId, locs);
    if (reportable !== 'all' && !reportable.size) throw forbidden('You don’t have view access to network.reports');
    const finance = capabilityLocationIds(assignments, 'finance.payments', 'view', orgId, locs);
    const filter = await brandFilterIds(req, db, orgId);
    const all = await orgBrands(db, orgId);
    const shown = all.filter((b) => filter === 'all' || filter.has(b.id));
    const def = all.find((b) => b.isDefault)?.id ?? null;
    const brandOf = (x: string | null) => x ?? def;
    const since = new Date(Date.now() - req.query.days * 86400_000);

    const rows = await db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
    const visibleLocs = rows.filter((l) => reportable === 'all' || reportable.has(l.id));
    const finIds = visibleLocs.filter((l) => finance === 'all' || finance.has(l.id)).map((l) => l.id);
    const pays = finIds.length ? await db.select({ amountMinor: paymentReferences.amountMinor, currency: paymentReferences.currency, state: paymentReferences.state, refundedMinor: paymentReferences.refundedMinor, locationId: paymentReferences.locationId })
      .from(paymentReferences).where(and(eq(paymentReferences.organizationId, orgId), inArray(paymentReferences.locationId, finIds), gte(paymentReferences.createdAt, since))) : [];
    const pipeline = await hasCapability(req, db, 'sales.franchise_pipeline', 'view', org(orgId));
    const open = FRANCHISE_STAGES.filter((s) => s !== 'lost' && s !== 'opened');
    const prospects = pipeline ? await db.select({ brandId: franchiseProspects.brandId, stage: franchiseProspects.stage, c: count() }).from(franchiseProspects)
      .where(eq(franchiseProspects.organizationId, orgId)).groupBy(franchiseProspects.brandId, franchiseProspects.stage) : [];
    const terrs = pipeline ? await db.select({ brandId: franchiseTerritories.brandId, status: franchiseTerritories.status, c: count() }).from(franchiseTerritories)
      .where(eq(franchiseTerritories.organizationId, orgId)).groupBy(franchiseTerritories.brandId, franchiseTerritories.status) : [];
    const legal = await hasCapability(req, db, 'legal.agreements', 'view', org(orgId));
    const agreements = legal ? await db.select({ brandId: franchiseAgreements.brandId, c: count() }).from(franchiseAgreements)
      .where(and(eq(franchiseAgreements.organizationId, orgId), eq(franchiseAgreements.status, 'active'))).groupBy(franchiseAgreements.brandId) : [];
    const royalties = await hasCapability(req, db, 'finance.royalties', 'view', org(orgId));
    const terms = royalties ? await db.select().from(royaltyTerms).where(and(eq(royaltyTerms.organizationId, orgId), isNull(royaltyTerms.ownerGroupId))) : [];
    const today = new Date().toISOString().slice(0, 10);
    const currentTerms = (brandId: string | null) => terms.filter((t) => t.brandId === brandId && t.effectiveFrom <= today && (!t.effectiveTo || t.effectiveTo > today));

    const brandsOut = shown.map((b) => {
      const bl = visibleLocs.filter((l) => brandOf(l.brandId) === b.id);
      const ids = new Set(bl.map((l) => l.id));
      const brandTerms = currentTerms(b.id);
      const fallback = brandTerms.length ? brandTerms : currentTerms(null);
      return {
        id: b.id, name: b.name, slug: b.slug, isDefault: b.isDefault, primaryColor: b.primaryColor, logoUrl: b.logoUrl,
        locations: { total: bl.length, operating: bl.filter((l) => l.status === 'operating').length, opening: bl.filter((l) => ['onboarding', 'opening_soon'].includes(l.status)).length },
        currencies: [...new Set(bl.map((l) => l.currency))].sort(),
        revenue: finIds.length ? revenueByCurrency(pays.filter((p) => p.locationId && ids.has(p.locationId))) : null,
        pipeline: pipeline ? {
          open: prospects.filter((p) => brandOf(p.brandId) === b.id && (open as readonly string[]).includes(p.stage)).reduce((s, p) => s + p.c, 0),
          signed: prospects.filter((p) => brandOf(p.brandId) === b.id && ['signed', 'onboarding'].includes(p.stage)).reduce((s, p) => s + p.c, 0),
          availableTerritories: terrs.filter((t) => brandOf(t.brandId) === b.id && t.status === 'available').reduce((s, t) => s + t.c, 0),
        } : null,
        activeAgreements: legal ? agreements.filter((a) => brandOf(a.brandId) === b.id).reduce((s, a) => s + a.c, 0) : null,
        terms: royalties ? fallback.map((t) => ({ currency: t.currency, royaltyBps: t.royaltyBps, marketingFundBps: t.marketingFundBps, source: t.brandId ? 'brand' : 'organization' })) : null,
      };
    });
    // Network summary: counts add up; money stays per currency (each currency summed on its own, never converted).
    const shownIds = new Set(shown.map((b) => b.id));
    const netLocs = visibleLocs.filter((l) => shownIds.has(brandOf(l.brandId)!));
    const netIds = new Set(netLocs.map((l) => l.id));
    return {
      period: { days: req.query.days, from: since.toISOString() },
      multiBrand: all.length > 1,
      network: {
        brands: shown.length,
        locations: netLocs.length,
        operating: netLocs.filter((l) => l.status === 'operating').length,
        revenueByCurrency: finIds.length ? revenueByCurrency(pays.filter((p) => p.locationId && netIds.has(p.locationId))) : null,
        combinedRevenue: null,
        combinedRevenueNote: 'Amounts in different currencies are never added together.',
        openProspects: pipeline ? brandsOut.reduce((s, b) => s + (b.pipeline?.open ?? 0), 0) : null,
      },
      brands: brandsOut,
    };
  });

  /** Move a location to another brand (HQ: changes who can see it). */
  app.put('/orgs/:orgId/locations/:id/brand', {
    schema: { tags: ['locations'], security: secured, params: idParams, body: z.object({ brandId: z.uuid() }), summary: 'Set the brand a location belongs to (organisation-wide Locations edit)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireCapability(req, db, 'network.locations', 'edit', org(orgId));
    const b = await brandInOrg(db, orgId, req.body.brandId);
    if (!b || b.archivedAt) throw notFound('Brand');
    const [row] = await db.update(locations).set({ brandId: b.isDefault ? null : b.id, updatedAt: new Date() }).where(and(eq(locations.id, id), eq(locations.organizationId, orgId))).returning({ id: locations.id });
    if (!row) throw notFound('Location');
    await audit(db, { organizationId: orgId, ...actor(req), action: 'location.brand_changed', scopeKind: 'location', scopeId: id, targetType: 'location', targetId: id, metadata: { brandId: b.id } });
    return { id, brandId: b.id };
  });
};
