import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  catalogueDistributions, collectionProducts, collections, commerceTranslations, distributionResults, fulfilmentSettings, locationListings, locationVariants, locations,
  productImages, products, taxRates, users, variants,
} from '../db/schema/index.ts';
import type { Exec } from '../db/client.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { assertWithinBounds, assortmentFor, boundsFor, loadProductBundle, optionCombinations, planDistribution, runDistribution, snapshotOf, snapshotDiff, validateVariantMatrix } from '../services/commerce-catalogue.ts';
import { activeTaxRates, fulfilmentConfig, locationMap } from '../services/commerce-orders.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['commerce'];
const httpsUrl = z.url().refine((u) => u.startsWith('https://'), 'Must be an https:// URL');
const slug = z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, numbers and dashes');
const localeKey = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Locale like fr or fr-CA');
const prices = z.partialRecord(currency, z.number().int().min(0));
const optionsSchema = z.array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(60)).min(1).max(30) })).max(3).default([]);
const variantInput = z.object({
  id: z.uuid().optional(), sku: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(120), options: z.record(z.string(), z.string()).default({}),
  prices, barcode: z.string().trim().max(64).nullable().optional(), imageUrl: httpsUrl.nullable().optional(), status: z.enum(['active', 'archived']).default('active'),
});
const productBody = z.object({
  sku: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(160), description: z.string().max(5000).nullable().default(null), slug: slug.nullable().default(null),
  vendor: z.string().trim().max(80).nullable().default(null), productType: z.string().trim().max(80).nullable().default(null), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  status: z.enum(['draft', 'active', 'archived']).default('draft'), options: optionsSchema, specs: z.record(z.string().max(60), z.string().max(400)).default({}),
  eligibility: z.object({ mode: z.enum(['all', 'selected']), locationIds: z.array(z.uuid()).default([]) }).default({ mode: 'all', locationIds: [] }),
  priceBounds: z.partialRecord(currency, z.object({ minPct: z.number().min(-90).max(0), maxPct: z.number().min(0).max(200) })).default({}),
  allowBackorder: z.boolean().default(false), returnable: z.boolean().default(true),
  images: z.array(z.object({ url: httpsUrl, alt: z.string().max(200).default(''), variantId: z.uuid().nullable().optional() })).max(20).default([]),
  variants: z.array(variantInput).min(1).max(100),
});

/** Manager-level: operations.write AND locations.read at the location (store associates cannot set prices or apply counts). */
export async function requireManager(req: FastifyRequest, db: Exec, orgId: string, locationId: string) {
  const loc = await requireLocationPerm(req, db, orgId, locationId, 'operations.write');
  if (!(await hasPerm(req, db, 'locations.read', { organizationId: orgId, kind: 'location', id: locationId }))) throw forbidden('A store manager must do this');
  return loc;
}

const orgScope = (orgId: string) => ({ organizationId: orgId, kind: 'organization' as const, id: orgId });

export const commerceCatalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  async function productDetail(orgId: string, productId: string) {
    const [b] = await loadProductBundle(s.db, orgId, [productId]);
    if (!b) throw notFound('Product');
    const listings = await s.db.select().from(locationListings).where(eq(locationListings.productId, productId));
    const names = await locationMap(s.db, orgId);
    const snap = snapshotOf(b);
    return {
      ...b.product, createdAt: b.product.createdAt.toISOString(), updatedAt: b.product.updatedAt.toISOString(),
      variants: b.variants, images: b.images, translations: b.translations, variantTranslations: b.variantTranslations, collectionIds: b.collectionIds,
      lockedFields: ['sku', 'name', 'description', 'images', 'options', 'variants.sku', 'translations'],
      listings: listings.map((l) => ({ locationId: l.locationId, locationName: names.get(l.locationId)?.name ?? null, status: l.status, contentVersion: l.contentVersion, upToDate: l.status === 'listed' && l.contentVersion === b.product.contentVersion && snapshotDiff(l.snapshot, snap).length === 0, pendingChanges: l.status === 'listed' ? snapshotDiff(l.snapshot, snap) : [], updatedAt: l.updatedAt.toISOString() })),
    };
  }

  // ───────── Catalogue ─────────

  app.get('/orgs/:orgId/commerce/catalogue', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.string().optional(), q: z.string().optional(), collectionId: z.uuid().optional() }), summary: 'Master catalogue with variants, images, collections and per-store publish status' },
  }, async (req) => {
    const { orgId } = req.params;
    await authorisedLocations(req, s.db, orgId, 'operations.read');
    let bundles = await loadProductBundle(s.db, orgId);
    if (req.query.status) bundles = bundles.filter((b) => req.query.status!.split(',').includes(b.product.status));
    if (req.query.q) { const q = req.query.q.toLowerCase(); bundles = bundles.filter((b) => b.product.name.toLowerCase().includes(q) || b.product.sku.toLowerCase().includes(q) || b.variants.some((v) => v.sku.toLowerCase().includes(q))); }
    if (req.query.collectionId) bundles = bundles.filter((b) => b.collectionIds.includes(req.query.collectionId!));
    const listings = bundles.length ? await s.db.select().from(locationListings).where(inArray(locationListings.productId, bundles.map((b) => b.product.id))) : [];
    return {
      items: bundles.map((b) => {
        const mine = listings.filter((l) => l.productId === b.product.id && l.status === 'listed');
        const snap = snapshotOf(b);
        return {
          id: b.product.id, sku: b.product.sku, name: b.product.name, status: b.product.status, vendor: b.product.vendor, productType: b.product.productType,
          image: b.images[0]?.url ?? b.product.images[0] ?? null, variantCount: b.variants.filter((v) => v.status === 'active').length, options: b.product.options,
          prices: b.variants.filter((v) => v.status === 'active').map((v) => v.prices), translations: Object.keys(b.translations), collectionIds: b.collectionIds,
          eligibility: b.product.eligibility, contentVersion: b.product.contentVersion,
          publish: { listedAt: mine.length, outdated: mine.filter((l) => l.contentVersion !== b.product.contentVersion || snapshotDiff(l.snapshot, snap).length > 0).length },
          updatedAt: b.product.updatedAt.toISOString(),
        };
      }),
    };
  });

  app.get('/orgs/:orgId/commerce/catalogue/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return productDetail(req.params.orgId, req.params.id);
  });

  app.post('/orgs/:orgId/commerce/catalogue/variant-matrix', {
    schema: { tags, security: secured, params: orgParams, summary: 'Suggest variants for an option matrix (every combination, with SKUs)', body: z.object({ sku: z.string().trim().min(1), name: z.string().trim().min(1), options: optionsSchema }) },
  }, async (req) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    const code = (v: string) => v.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
    return { variants: optionCombinations(req.body.options).map((o) => ({ sku: [req.body.sku, ...Object.values(o).map(code)].join('-'), name: Object.values(o).join(' · ') || req.body.name, options: o })) };
  });

  app.post('/orgs/:orgId/commerce/catalogue', {
    schema: { tags, security: secured, params: orgParams, summary: 'Create a master product (HQ): options matrix, variants with prices per currency, images, specs, eligibility and local price bounds', body: productBody },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const b = req.body;
    validateVariantMatrix(b.options, b.variants);
    await assertEligibleLocations(orgId, b.eligibility.locationIds);
    const id = await s.db.transaction(async (tx) => {
      const [dupe] = await tx.select({ id: products.id }).from(products).where(and(eq(products.organizationId, orgId), eq(products.sku, b.sku)));
      if (dupe) throw validationError('A product with this SKU exists', { sku: 'Already used' });
      const taken = await tx.select({ sku: variants.sku }).from(variants).where(and(eq(variants.organizationId, orgId), inArray(variants.sku, b.variants.map((v) => v.sku))));
      if (taken.length) throw validationError(`SKU already used: ${taken.map((t) => t.sku).join(', ')}`, Object.fromEntries(b.variants.map((v, i) => [v, i] as const).filter(([v]) => taken.some((t) => t.sku === v.sku)).map(([, i]) => [`variants.${i}.sku`, 'Already used'])));
      const [p] = await tx.insert(products).values({
        organizationId: orgId, sku: b.sku, name: b.name, description: b.description, slug: b.slug, vendor: b.vendor, productType: b.productType, tags: b.tags, status: b.status,
        options: b.options, specs: b.specs, eligibility: b.eligibility, priceBounds: b.priceBounds as Record<string, { minPct: number; maxPct: number }>, allowBackorder: b.allowBackorder, returnable: b.returnable,
        images: b.images.map((i) => i.url), updatedBy: req.user!.id,
      }).returning();
      await tx.insert(variants).values(b.variants.map((v, i) => ({ organizationId: orgId, productId: p!.id, sku: v.sku, name: v.name, options: v.options, prices: v.prices as Record<string, number>, barcode: v.barcode ?? null, imageUrl: v.imageUrl ?? null, status: v.status, position: i })));
      if (b.images.length) await tx.insert(productImages).values(b.images.map((im, i) => ({ organizationId: orgId, productId: p!.id, url: im.url, alt: im.alt, variantId: im.variantId ?? null, position: i })));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'product.created', scopeKind: 'organization', scopeId: orgId, targetType: 'product', targetId: p!.id, metadata: { sku: b.sku } });
      return p!.id;
    });
    return reply.code(201).send(await productDetail(orgId, id));
  });

  async function assertEligibleLocations(orgId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, ids)));
    if (rows.length !== new Set(ids).size) throw validationError('Unknown store in eligibility', { 'eligibility.locationIds': 'Choose stores of this organisation' });
  }

  app.put('/orgs/:orgId/commerce/catalogue/:id', {
    schema: { tags, security: secured, params: idParams, summary: 'Update a master product (HQ). SKUs are master identifiers: they cannot change once a product has been distributed. Removed variants are archived.', body: productBody },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const b = req.body;
    validateVariantMatrix(b.options, b.variants);
    await assertEligibleLocations(orgId, b.eligibility.locationIds);
    await s.db.transaction(async (tx) => {
      const [p] = await tx.select().from(products).where(and(eq(products.id, id), eq(products.organizationId, orgId))).for('update');
      if (!p) throw notFound('Product');
      const existing = await tx.select().from(variants).where(eq(variants.productId, p.id));
      const everListed = (await tx.select({ id: locationListings.id }).from(locationListings).where(eq(locationListings.productId, p.id)).limit(1)).length > 0;
      if (b.sku !== p.sku && everListed) throw conflict('identifier_locked', 'The product SKU is a master identifier and cannot change after distribution');
      for (const [i, v] of b.variants.entries()) {
        const cur = v.id ? existing.find((e) => e.id === v.id) : undefined;
        if (v.id && !cur) throw validationError('Unknown variant', { [`variants.${i}.id`]: 'Not part of this product' });
        if (cur && cur.sku !== v.sku && everListed) throw conflict('identifier_locked', `Variant SKU ${cur.sku} is a master identifier and cannot change after distribution`, { field: `variants.${i}.sku` });
      }
      const others = await tx.select({ sku: variants.sku }).from(variants).where(and(eq(variants.organizationId, orgId), ne(variants.productId, p.id), inArray(variants.sku, b.variants.map((v) => v.sku))));
      if (others.length) throw validationError(`SKU already used by another product: ${others.map((o) => o.sku).join(', ')}`, { variants: 'Duplicate SKU' });
      const imgs = await tx.select().from(productImages).where(eq(productImages.productId, p.id));
      const contentChanged = p.name !== b.name || (p.description ?? null) !== b.description || JSON.stringify(p.options) !== JSON.stringify(b.options) || JSON.stringify(p.specs) !== JSON.stringify(b.specs)
        || JSON.stringify(imgs.map((x) => [x.url, x.alt, x.variantId])) !== JSON.stringify(b.images.map((x) => [x.url, x.alt, x.variantId ?? null]))
        || b.variants.some((v) => { const e = v.id ? existing.find((x) => x.id === v.id) : null; return !e || e.name !== v.name || JSON.stringify(e.options) !== JSON.stringify(v.options) || e.status !== v.status || (e.imageUrl ?? null) !== (v.imageUrl ?? null); })
        || existing.some((e) => e.status === 'active' && !b.variants.some((v) => v.id === e.id));
      await tx.update(products).set({
        sku: b.sku, name: b.name, description: b.description, slug: b.slug, vendor: b.vendor, productType: b.productType, tags: b.tags, status: b.status, options: b.options, specs: b.specs,
        eligibility: b.eligibility, priceBounds: b.priceBounds as Record<string, { minPct: number; maxPct: number }>, allowBackorder: b.allowBackorder, returnable: b.returnable, images: b.images.map((i) => i.url),
        contentVersion: contentChanged ? p.contentVersion + 1 : p.contentVersion, updatedBy: req.user!.id, updatedAt: new Date(),
      }).where(eq(products.id, p.id));
      for (const [i, v] of b.variants.entries()) {
        const values = { sku: v.sku, name: v.name, options: v.options, prices: v.prices as Record<string, number>, barcode: v.barcode ?? null, imageUrl: v.imageUrl ?? null, status: v.status, position: i };
        if (v.id) await tx.update(variants).set(values).where(eq(variants.id, v.id));
        else await tx.insert(variants).values({ organizationId: orgId, productId: p.id, ...values });
      }
      const keep = new Set(b.variants.map((v) => v.id).filter(Boolean));
      const drop = existing.filter((e) => !keep.has(e.id) && e.status !== 'archived').map((e) => e.id);
      if (drop.length) await tx.update(variants).set({ status: 'archived' }).where(inArray(variants.id, drop));
      await tx.delete(productImages).where(eq(productImages.productId, p.id));
      if (b.images.length) await tx.insert(productImages).values(b.images.map((im, i) => ({ organizationId: orgId, productId: p.id, url: im.url, alt: im.alt, variantId: im.variantId ?? null, position: i })));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'product.updated', scopeKind: 'organization', scopeId: orgId, targetType: 'product', targetId: p.id, metadata: { contentChanged } });
    });
    return productDetail(orgId, id);
  });

  app.put('/orgs/:orgId/commerce/catalogue/:id/translations/:locale', {
    schema: { tags, security: secured, params: idParams.extend({ locale: localeKey }), summary: 'Per-locale product content (HQ-owned)', body: z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().max(5000).optional(), variants: z.record(z.uuid(), z.string().trim().min(1).max(120)).default({}) }) },
  }, async (req) => {
    const { orgId, id, locale } = req.params;
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const [p] = await s.db.select().from(products).where(and(eq(products.id, id), eq(products.organizationId, orgId)));
    if (!p) throw notFound('Product');
    await s.db.transaction(async (tx) => {
      const fields = { ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.description !== undefined ? { description: req.body.description } : {}) };
      await tx.insert(commerceTranslations).values({ organizationId: orgId, entityType: 'product', entityId: p.id, locale, fields, updatedBy: req.user!.id })
        .onConflictDoUpdate({ target: [commerceTranslations.entityType, commerceTranslations.entityId, commerceTranslations.locale], set: { fields, updatedBy: req.user!.id, updatedAt: new Date() } });
      const vs = await tx.select({ id: variants.id }).from(variants).where(eq(variants.productId, p.id));
      for (const [vid, name] of Object.entries(req.body.variants)) {
        if (!vs.some((v) => v.id === vid)) throw validationError('Unknown variant', { [`variants.${vid}`]: 'Not part of this product' });
        await tx.insert(commerceTranslations).values({ organizationId: orgId, entityType: 'variant', entityId: vid, locale, fields: { name }, updatedBy: req.user!.id })
          .onConflictDoUpdate({ target: [commerceTranslations.entityType, commerceTranslations.entityId, commerceTranslations.locale], set: { fields: { name }, updatedAt: new Date() } });
      }
      await tx.update(products).set({ contentVersion: p.contentVersion + 1, updatedAt: new Date() }).where(eq(products.id, p.id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'product.translation_saved', targetType: 'product', targetId: p.id, metadata: { locale } });
    });
    return productDetail(orgId, id);
  });

  app.delete('/orgs/:orgId/commerce/catalogue/:id/translations/:locale', { schema: { tags, security: secured, params: idParams.extend({ locale: localeKey }) } }, async (req) => {
    const { orgId, id, locale } = req.params;
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const [p] = await s.db.select().from(products).where(and(eq(products.id, id), eq(products.organizationId, orgId)));
    if (!p) throw notFound('Product');
    await s.db.delete(commerceTranslations).where(and(eq(commerceTranslations.entityType, 'product'), eq(commerceTranslations.entityId, id), eq(commerceTranslations.locale, locale)));
    await s.db.update(products).set({ contentVersion: p.contentVersion + 1, updatedAt: new Date() }).where(eq(products.id, id));
    return productDetail(orgId, id);
  });

  // ───────── Collections ─────────

  app.get('/orgs/:orgId/commerce/collections', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const cs = await s.db.select().from(collections).where(eq(collections.organizationId, req.params.orgId)).orderBy(asc(collections.position), asc(collections.title));
    const members = cs.length ? await s.db.select().from(collectionProducts).where(inArray(collectionProducts.collectionId, cs.map((c) => c.id))).orderBy(asc(collectionProducts.position)) : [];
    const trs = cs.length ? await s.db.select().from(commerceTranslations).where(and(eq(commerceTranslations.entityType, 'collection'), inArray(commerceTranslations.entityId, cs.map((c) => c.id)))) : [];
    return { items: cs.map((c) => ({ ...c, productIds: members.filter((m) => m.collectionId === c.id).map((m) => m.productId), translations: Object.fromEntries(trs.filter((t) => t.entityId === c.id).map((t) => [t.locale, t.fields])) })) };
  });

  const collectionBody = z.object({ slug, title: z.string().trim().min(1).max(120), description: z.string().max(2000).nullable().default(null), imageUrl: httpsUrl.nullable().default(null), status: z.enum(['draft', 'active']).default('active'), position: z.number().int().default(0), productIds: z.array(z.uuid()).max(500).default([]), translations: z.record(localeKey, z.object({ title: z.string().max(120).optional(), description: z.string().max(2000).optional() })).default({}) });

  async function saveCollection(orgId: string, id: string | null, b: z.infer<typeof collectionBody>, by: string) {
    if (b.productIds.length) {
      const ok = await s.db.select({ id: products.id }).from(products).where(and(eq(products.organizationId, orgId), inArray(products.id, b.productIds)));
      if (ok.length !== new Set(b.productIds).size) throw validationError('Unknown product in the collection', { productIds: 'Choose products of this organisation' });
    }
    return s.db.transaction(async (tx) => {
      const [dupe] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.organizationId, orgId), eq(collections.slug, b.slug)));
      if (dupe && dupe.id !== id) throw validationError('Another collection uses this address', { slug: 'Already used' });
      const values = { slug: b.slug, title: b.title, description: b.description, imageUrl: b.imageUrl, status: b.status, position: b.position, updatedAt: new Date() };
      const [c] = id ? await tx.update(collections).set(values).where(and(eq(collections.id, id), eq(collections.organizationId, orgId))).returning() : await tx.insert(collections).values({ organizationId: orgId, ...values }).returning();
      if (!c) throw notFound('Collection');
      await tx.delete(collectionProducts).where(eq(collectionProducts.collectionId, c.id));
      if (b.productIds.length) await tx.insert(collectionProducts).values([...new Set(b.productIds)].map((productId, position) => ({ collectionId: c.id, productId, position })));
      for (const [locale, fields] of Object.entries(b.translations)) {
        await tx.insert(commerceTranslations).values({ organizationId: orgId, entityType: 'collection', entityId: c.id, locale, fields, updatedBy: by })
          .onConflictDoUpdate({ target: [commerceTranslations.entityType, commerceTranslations.entityId, commerceTranslations.locale], set: { fields, updatedAt: new Date() } });
      }
      return c;
    });
  }

  app.post('/orgs/:orgId/commerce/collections', { schema: { tags, security: secured, params: orgParams, body: collectionBody } }, async (req, reply) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    return reply.code(201).send(await saveCollection(req.params.orgId, null, req.body, req.user!.id));
  });
  app.put('/orgs/:orgId/commerce/collections/:id', { schema: { tags, security: secured, params: idParams, body: collectionBody } }, async (req) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    return saveCollection(req.params.orgId, req.params.id, req.body, req.user!.id);
  });

  // ───────── Distribution: preview → distribute → results ─────────

  const distBody = z.object({ productIds: z.array(z.uuid()).min(1).max(200), locationIds: z.array(z.uuid()).min(1).max(200) });

  app.post('/orgs/:orgId/commerce/distributions/preview', {
    schema: { tags, security: secured, params: orgParams, summary: 'Publish preview: per store and product, what distribution would list, update, remove or block (with reasons)', body: distBody },
  }, async (req) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    const plan = await planDistribution(s.db, req.params.orgId, req.body.productIds, req.body.locationIds);
    return { items: plan, summary: { ready: plan.filter((p) => p.status === 'ready').length, skipped: plan.filter((p) => p.status === 'skipped').length, blocked: plan.filter((p) => p.status === 'blocked').length, overridesReset: plan.reduce((a, p) => a + p.overridesOutOfBounds.length, 0) } };
  });

  app.post('/orgs/:orgId/commerce/distributions', {
    schema: { tags, security: secured, params: orgParams, summary: 'Distribute master products to stores. Each store/product succeeds or fails independently.', body: distBody },
  }, async (req, reply) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    const d = await runDistribution(s.db, req.params.orgId, req.body.productIds, req.body.locationIds, req.user!.id, req.ip);
    return reply.code(201).send(await distributionView(req.params.orgId, d.id));
  });

  async function distributionView(orgId: string, id: string) {
    const [d] = await s.db.select().from(catalogueDistributions).where(and(eq(catalogueDistributions.id, id), eq(catalogueDistributions.organizationId, orgId)));
    if (!d) throw notFound('Distribution');
    const rs = await s.db.select({ r: distributionResults, p: { name: products.name } }).from(distributionResults).innerJoin(products, eq(products.id, distributionResults.productId)).where(eq(distributionResults.distributionId, d.id));
    const names = await locationMap(s.db, orgId);
    const [by] = d.createdBy ? await s.db.select({ name: users.name }).from(users).where(eq(users.id, d.createdBy)) : [];
    return { ...d, createdAt: d.createdAt.toISOString(), completedAt: d.completedAt?.toISOString() ?? null, createdByName: by?.name ?? null, results: rs.map(({ r, p }) => ({ ...r, productName: p.name, locationName: names.get(r.locationId)?.name ?? null, createdAt: r.createdAt.toISOString() })) };
  }

  app.get('/orgs/:orgId/commerce/distributions', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    const rows = await s.db.select().from(catalogueDistributions).where(eq(catalogueDistributions.organizationId, req.params.orgId)).orderBy(desc(catalogueDistributions.createdAt)).limit(50);
    return { items: rows.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), completedAt: d.completedAt?.toISOString() ?? null })) };
  });

  app.get('/orgs/:orgId/commerce/distributions/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    await requirePerm(req, s.db, 'templates.write', orgScope(req.params.orgId));
    return distributionView(req.params.orgId, req.params.id);
  });

  app.post('/orgs/:orgId/commerce/distributions/:id/retry', { schema: { tags, security: secured, params: idParams, summary: 'Re-run only the failed store/product pairs' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'templates.write', orgScope(orgId));
    const failed = await s.db.select().from(distributionResults).where(and(eq(distributionResults.distributionId, id), eq(distributionResults.status, 'failed'), eq(distributionResults.organizationId, orgId)));
    if (!failed.length) throw conflict('nothing_to_retry', 'No failed stores in this distribution');
    const d = await runDistribution(s.db, orgId, [...new Set(failed.map((f) => f.productId))], [...new Set(failed.map((f) => f.locationId))], req.user!.id, req.ip);
    return reply.code(201).send(await distributionView(orgId, d.id));
  });

  // ───────── Local assortment ─────────

  app.get('/orgs/:orgId/commerce/locations/:locationId/assortment', {
    schema: { tags, security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'What this store lists: HQ vs local price (origin shown), permitted range, availability, stock and in-transit units' },
  }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    return { location: { id: loc.id, name: loc.name, currency: loc.currency }, items: await assortmentFor(s.db, loc) };
  });

  app.put('/orgs/:orgId/commerce/locations/:locationId/assortment/:variantId', {
    schema: {
      tags, security: secured, params: orgParams.extend({ locationId: z.uuid(), variantId: z.uuid() }),
      summary: 'Local changes within HQ rules: price override inside the HQ range (null = reset to HQ), availability, reorder settings, backorders. Never changes master identifiers or content.',
      body: z.object({ priceMinor: z.number().int().min(0).nullable().optional(), available: z.boolean().optional(), reorderPoint: z.number().int().min(0).nullable().optional(), reorderQty: z.number().int().min(1).nullable().optional(), allowBackorder: z.boolean().nullable().optional() }),
    },
  }, async (req) => {
    const { orgId, locationId, variantId } = req.params;
    const b = req.body;
    const managerFields = b.priceMinor !== undefined || b.reorderPoint !== undefined || b.reorderQty !== undefined || b.allowBackorder !== undefined;
    const loc = managerFields ? await requireManager(req, s.db, orgId, locationId) : await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [row] = await s.db.select({ v: variants, p: products }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(variants.id, variantId), eq(variants.organizationId, orgId)));
    if (!row) throw notFound('Variant');
    if (b.priceMinor != null) assertWithinBounds(row.p, row.v, loc.currency, b.priceMinor);
    const set: Partial<typeof locationVariants.$inferInsert> = { updatedBy: req.user!.id, updatedAt: new Date() };
    if (b.priceMinor !== undefined) { set.priceMinor = b.priceMinor; set.priceSetBy = req.user!.id; set.priceSetAt = new Date(); }
    if (b.available !== undefined) set.available = b.available;
    if (b.reorderPoint !== undefined) set.reorderPoint = b.reorderPoint;
    if (b.reorderQty !== undefined) set.reorderQty = b.reorderQty;
    if (b.allowBackorder !== undefined) set.allowBackorder = b.allowBackorder;
    await s.db.insert(locationVariants).values({ organizationId: orgId, locationId, variantId, currency: loc.currency }).onConflictDoNothing();
    await s.db.update(locationVariants).set(set).where(and(eq(locationVariants.locationId, locationId), eq(locationVariants.variantId, variantId)));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'assortment.updated', scopeKind: 'location', scopeId: locationId, targetType: 'variant', targetId: variantId, metadata: b });
    const items = await assortmentFor(s.db, loc);
    const v = items.flatMap((i) => i.variants).find((x) => x.variantId === variantId);
    return v ?? { variantId, priceOrigin: b.priceMinor != null ? 'local' : 'hq', bounds: boundsFor(row.p, row.v, loc.currency) };
  });

  app.post('/orgs/:orgId/commerce/locations/:locationId/assortment/reset', {
    schema: { tags, security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'Reset local price overrides to HQ (all, or the given variants)', body: z.object({ variantIds: z.array(z.uuid()).optional() }) },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    const loc = await requireManager(req, s.db, orgId, locationId);
    const conds = [eq(locationVariants.locationId, locationId)];
    if (req.body.variantIds?.length) conds.push(inArray(locationVariants.variantId, req.body.variantIds));
    const reset = await s.db.update(locationVariants).set({ priceMinor: null, priceSetBy: req.user!.id, priceSetAt: new Date(), updatedAt: new Date() }).where(and(...conds)).returning({ id: locationVariants.id });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'assortment.reset_to_hq', scopeKind: 'location', scopeId: locationId, metadata: { count: reset.length } });
    return { reset: reset.length, items: await assortmentFor(s.db, loc) };
  });

  // ───────── Storefront settings: fulfilment & tax ─────────

  const settingsBody = z.object({
    storefrontEnabled: z.boolean(), pickupEnabled: z.boolean(), pickupInstructions: z.string().max(500).nullable(), pickupReadyMinutes: z.number().int().min(0).max(10080),
    localDeliveryEnabled: z.boolean(), deliveryFeeMinor: z.number().int().min(0), freeDeliveryOverMinor: z.number().int().min(0).nullable(), deliveryPostcodes: z.array(z.string().trim().min(1).max(12)).max(200),
    shippingEnabled: z.boolean(), shippingFeeMinor: z.number().int().min(0), shippingCountries: z.array(z.string().length(2)).max(60),
    crossLocationPickup: z.boolean(), reservationMinutes: z.number().int().min(5).max(120), returnWindowDays: z.number().int().min(0).max(365),
  });

  app.get('/orgs/:orgId/commerce/fulfilment-settings', { schema: { tags, security: secured, params: orgParams, summary: 'Storefront and fulfilment settings for every store in scope, with configured tax rates' } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const locs = await s.db.select().from(locations).where(eq(locations.organizationId, req.params.orgId)).orderBy(asc(locations.name));
    return {
      items: await Promise.all(locs.filter((l) => allowed === 'all' || allowed.has(l.id)).map(async (l) => ({
        location: { id: l.id, name: l.name, currency: l.currency, country: l.country }, settings: await fulfilmentConfig(s.db, l.id),
        taxRates: (await activeTaxRates(s.db, l.id)).map((t) => ({ id: t.id, name: t.name, rateBps: t.rateBps, inclusive: t.inclusive, appliesToFulfilment: t.appliesToFulfilment })),
      }))),
    };
  });

  app.put('/orgs/:orgId/commerce/locations/:locationId/fulfilment-settings', {
    schema: { tags, security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'Store pickup, local delivery, shipping, cross-store collection, reservation window and return window', body: settingsBody },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    await requireManager(req, s.db, orgId, locationId);
    const values = { ...req.body, shippingCountries: req.body.shippingCountries.map((c) => c.toUpperCase()), updatedBy: req.user!.id, updatedAt: new Date() };
    await s.db.insert(fulfilmentSettings).values({ organizationId: orgId, locationId, ...values }).onConflictDoUpdate({ target: fulfilmentSettings.locationId, set: values });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'storefront.settings_updated', scopeKind: 'location', scopeId: locationId });
    return fulfilmentConfig(s.db, locationId);
  });

  app.put('/orgs/:orgId/commerce/locations/:locationId/tax-rates', {
    schema: {
      tags, security: secured, params: orgParams.extend({ locationId: z.uuid() }),
      summary: 'Replace the tax rates configured for a store (business-validated; BranchHarbor never assumes a rate). Requires policies.write.',
      body: z.object({ rates: z.array(z.object({ name: z.string().trim().min(1).max(60), rateBps: z.number().int().min(0).max(10000), inclusive: z.boolean(), appliesToFulfilment: z.boolean().default(true) })).max(5) }),
    },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    await requirePerm(req, s.db, 'policies.write', { organizationId: orgId, kind: 'location', id: locationId });
    await s.db.transaction(async (tx) => {
      await tx.update(taxRates).set({ active: false }).where(eq(taxRates.locationId, locationId));
      if (req.body.rates.length) await tx.insert(taxRates).values(req.body.rates.map((r, i) => ({ organizationId: orgId, locationId, ...r, position: i, updatedBy: req.user!.id })));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'storefront.tax_rates_updated', scopeKind: 'location', scopeId: locationId, metadata: { rates: req.body.rates } });
    });
    return { items: (await activeTaxRates(s.db, locationId)).map((t) => ({ id: t.id, name: t.name, rateBps: t.rateBps, inclusive: t.inclusive, appliesToFulfilment: t.appliesToFulfilment })) };
  });
};
