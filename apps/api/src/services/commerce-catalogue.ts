import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import {
  catalogueDistributions, collectionProducts, collections, commerceTranslations, distributionResults, locationListings, locationVariants, locations,
  productImages, products, stockTransfers, users, variants, type ListingSnapshot,
} from '../db/schema/index.ts';
import { conflict, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';

type Product = typeof products.$inferSelect;
type Variant = typeof variants.$inferSelect;
type Location = typeof locations.$inferSelect;

// ───────── Option matrix ─────────

/** Every variant must use exactly the product's options with allowed values, and no two variants may share a combination. */
export function validateVariantMatrix(options: Array<{ name: string; values: string[] }>, vs: Array<{ sku: string; options: Record<string, string> }>) {
  const fields: Record<string, string> = {};
  const names = options.map((o) => o.name);
  if (new Set(names).size !== names.length) fields.options = 'Option names must be unique';
  options.forEach((o, i) => { if (new Set(o.values).size !== o.values.length || !o.values.length) fields[`options.${i}.values`] = 'Values must be unique and not empty'; });
  const seen = new Map<string, string>();
  vs.forEach((v, i) => {
    const keys = Object.keys(v.options);
    if (options.length && (keys.length !== names.length || !names.every((n) => keys.includes(n)))) fields[`variants.${i}.options`] = `Set ${names.join(', ')}`;
    for (const o of options) if (v.options[o.name] !== undefined && !o.values.includes(v.options[o.name]!)) fields[`variants.${i}.options.${o.name}`] = `“${v.options[o.name]}” is not a ${o.name} value`;
    const combo = names.map((n) => v.options[n] ?? '').join('|');
    if (seen.has(combo)) fields[`variants.${i}.options`] = `Same options as ${seen.get(combo)}`;
    seen.set(combo, v.sku);
  });
  const skus = vs.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) fields.variants = 'Variant SKUs must be unique';
  if (Object.keys(fields).length) throw validationError('Check the variant options', fields);
}

/** All combinations of the option matrix (for "generate variants"). */
export function optionCombinations(options: Array<{ name: string; values: string[] }>): Array<Record<string, string>> {
  return options.reduce<Array<Record<string, string>>>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v }))), [{}]);
}

// ───────── Price bounds ─────────

export function boundsFor(p: Pick<Product, 'priceBounds'>, v: Pick<Variant, 'prices'>, currency: string): { hq: number | null; min: number | null; max: number | null; overridable: boolean } {
  const hq = v.prices[currency] ?? null;
  const b = p.priceBounds[currency];
  if (hq === null || !b) return { hq, min: null, max: null, overridable: false };
  return { hq, min: Math.max(0, Math.round((hq * (100 + b.minPct)) / 100)), max: Math.round((hq * (100 + b.maxPct)) / 100), overridable: true };
}

export function assertWithinBounds(p: Pick<Product, 'priceBounds' | 'name'>, v: Pick<Variant, 'prices' | 'name'>, currency: string, priceMinor: number) {
  const b = boundsFor(p, v, currency);
  if (!b.overridable) throw conflict('price_locked', `${p.name} (${v.name}) has no local price range for ${currency}; the HQ price applies`, { currency, hqMinor: b.hq });
  if (priceMinor < b.min! || priceMinor > b.max!) {
    throw conflict('price_out_of_bounds', `Local price must be between ${b.min} and ${b.max} ${currency} minor units`, { currency, minMinor: b.min, maxMinor: b.max, hqMinor: b.hq });
  }
}

// ───────── Snapshot / product view ─────────

export async function loadProductBundle(db: Exec, organizationId: string, productIds?: string[]) {
  const conds = [eq(products.organizationId, organizationId)];
  if (productIds) {
    if (!productIds.length) return [];
    conds.push(inArray(products.id, productIds));
  }
  const ps = await db.select().from(products).where(and(...conds)).orderBy(asc(products.name));
  if (!ps.length) return [];
  const ids = ps.map((p) => p.id);
  const [vs, imgs, trs, cps] = await Promise.all([
    db.select().from(variants).where(inArray(variants.productId, ids)).orderBy(asc(variants.position), asc(variants.sku)),
    db.select().from(productImages).where(inArray(productImages.productId, ids)).orderBy(asc(productImages.position)),
    db.select().from(commerceTranslations).where(and(eq(commerceTranslations.organizationId, organizationId), inArray(commerceTranslations.entityType, ['product', 'variant']))),
    db.select().from(collectionProducts).where(inArray(collectionProducts.productId, ids)),
  ]);
  return ps.map((p) => {
    const pv = vs.filter((v) => v.productId === p.id);
    return {
      product: p, variants: pv, images: imgs.filter((i) => i.productId === p.id),
      translations: Object.fromEntries(trs.filter((t) => t.entityType === 'product' && t.entityId === p.id).map((t) => [t.locale, t.fields])),
      variantTranslations: Object.fromEntries(pv.map((v) => [v.id, Object.fromEntries(trs.filter((t) => t.entityType === 'variant' && t.entityId === v.id).map((t) => [t.locale, { name: t.fields.name }]))])),
      collectionIds: cps.filter((c) => c.productId === p.id).map((c) => c.collectionId),
    };
  });
}
export type ProductBundle = Awaited<ReturnType<typeof loadProductBundle>>[number];

export function snapshotOf(b: ProductBundle): ListingSnapshot {
  const p = b.product;
  return {
    name: p.name, description: p.description, slug: p.slug, vendor: p.vendor, productType: p.productType, options: p.options, specs: p.specs, tags: p.tags,
    images: b.images.length ? b.images.map((i) => ({ url: i.url, alt: i.alt, variantId: i.variantId })) : p.images.map((url) => ({ url, alt: '', variantId: null })),
    variants: b.variants.filter((v) => v.status === 'active').map((v) => ({ id: v.id, sku: v.sku, name: v.name, options: v.options, imageUrl: v.imageUrl })),
    translations: b.translations, variantTranslations: b.variantTranslations,
  };
}

/** Human-readable differences between what a store shows and the current master. */
export function snapshotDiff(before: ListingSnapshot | null, after: ListingSnapshot): string[] {
  if (!before) return ['New listing'];
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Name: “${before.name}” → “${after.name}”`);
  if ((before.description ?? '') !== (after.description ?? '')) out.push('Description updated');
  if (JSON.stringify(before.images) !== JSON.stringify(after.images)) out.push(`Images: ${before.images.length} → ${after.images.length}`);
  const bIds = new Set(before.variants.map((v) => v.id));
  const aIds = new Set(after.variants.map((v) => v.id));
  const added = after.variants.filter((v) => !bIds.has(v.id));
  const removed = before.variants.filter((v) => !aIds.has(v.id));
  if (added.length) out.push(`Variants added: ${added.map((v) => v.name).join(', ')}`);
  if (removed.length) out.push(`Variants removed: ${removed.map((v) => v.name).join(', ')}`);
  if (after.variants.some((v) => { const o = before.variants.find((x) => x.id === v.id); return o && (o.name !== v.name || JSON.stringify(o.options) !== JSON.stringify(v.options)); })) out.push('Variant names or options updated');
  const locs = new Set([...Object.keys(before.translations), ...Object.keys(after.translations)]);
  const changed = [...locs].filter((l) => JSON.stringify(before.translations[l] ?? null) !== JSON.stringify(after.translations[l] ?? null));
  if (changed.length) out.push(`Translations: ${changed.join(', ')}`);
  if (JSON.stringify(before.specs) !== JSON.stringify(after.specs)) out.push('Specifications updated');
  return out;
}

// ───────── Distribution ─────────

export interface DistributionPlanItem {
  locationId: string; locationName: string; currency: string; productId: string; productName: string;
  action: 'list' | 'update' | 'delist' | 'none'; status: 'ready' | 'skipped' | 'blocked';
  message: string | null; changes: string[];
  overridesOutOfBounds: Array<{ variantId: string; variantName: string; priceMinor: number; minMinor: number | null; maxMinor: number | null }>;
}

export function eligibleAt(p: Pick<Product, 'eligibility'>, locationId: string) {
  return p.eligibility.mode === 'all' || p.eligibility.locationIds.includes(locationId);
}

/** Publish preview: what distributing these products to these stores would do, per store and product. */
export async function planDistribution(db: Exec, organizationId: string, productIds: string[], locationIds: string[]): Promise<DistributionPlanItem[]> {
  const bundles = await loadProductBundle(db, organizationId, productIds);
  const locs = locationIds.length ? await db.select().from(locations).where(and(eq(locations.organizationId, organizationId), inArray(locations.id, locationIds), isNull(locations.archivedAt))) : [];
  if (locs.length !== new Set(locationIds).size) throw validationError('Unknown location in the selection', { locationIds: 'Choose locations of this organisation' });
  if (bundles.length !== new Set(productIds).size) throw validationError('Unknown product in the selection', { productIds: 'Choose products of this organisation' });
  const listings = await db.select().from(locationListings).where(and(inArray(locationListings.locationId, locationIds), inArray(locationListings.productId, productIds)));
  const lvs = await db.select().from(locationVariants).where(inArray(locationVariants.locationId, locationIds));
  const plan: DistributionPlanItem[] = [];
  for (const loc of locs) {
    for (const b of bundles) {
      const p = b.product;
      const listing = listings.find((l) => l.locationId === loc.id && l.productId === p.id) ?? null;
      const isListed = listing?.status === 'listed';
      const base = { locationId: loc.id, locationName: loc.name, currency: loc.currency, productId: p.id, productName: p.name, overridesOutOfBounds: [] as DistributionPlanItem['overridesOutOfBounds'] };
      if (!eligibleAt(p, loc.id) || p.status !== 'active') {
        const why = p.status !== 'active' ? `Product is ${p.status}` : 'Store is not eligible for this product';
        plan.push(isListed ? { ...base, action: 'delist', status: 'ready', message: `${why} — it will be removed from this store`, changes: ['Remove from store'] } : { ...base, action: 'none', status: 'skipped', message: why, changes: [] });
        continue;
      }
      const active = b.variants.filter((v) => v.status === 'active');
      const missing = active.filter((v) => v.prices[loc.currency] === undefined || v.prices[loc.currency] === null);
      if (!active.length) { plan.push({ ...base, action: 'none', status: 'blocked', message: 'No active variants', changes: [] }); continue; }
      if (missing.length) { plan.push({ ...base, action: 'none', status: 'blocked', message: `No ${loc.currency} price for ${missing.map((v) => v.name).join(', ')}`, changes: [] }); continue; }
      const snap = snapshotOf(b);
      const changes = snapshotDiff(isListed ? listing!.snapshot : null, snap);
      for (const v of active) {
        const lv = lvs.find((x) => x.locationId === loc.id && x.variantId === v.id);
        if (lv?.priceMinor == null) continue;
        const bd = boundsFor(p, v, loc.currency);
        if (!bd.overridable || lv.priceMinor < bd.min! || lv.priceMinor > bd.max!) base.overridesOutOfBounds.push({ variantId: v.id, variantName: v.name, priceMinor: lv.priceMinor, minMinor: bd.min, maxMinor: bd.max });
      }
      if (base.overridesOutOfBounds.length) changes.push(`${base.overridesOutOfBounds.length} local price override(s) outside the HQ range will be reset to the HQ price`);
      if (isListed && listing!.contentVersion === p.contentVersion && !changes.length) plan.push({ ...base, action: 'none', status: 'skipped', message: 'Already up to date', changes: [] });
      else plan.push({ ...base, action: isListed ? 'update' : 'list', status: 'ready', message: null, changes });
    }
  }
  return plan;
}

/** Execute a distribution. Each store/product succeeds or fails independently; results are recorded per pair. */
export async function runDistribution(db: Exec, organizationId: string, productIds: string[], locationIds: string[], actorUserId: string, ip?: string) {
  const plan = await planDistribution(db, organizationId, productIds, locationIds);
  const bundles = new Map((await loadProductBundle(db, organizationId, productIds)).map((b) => [b.product.id, b]));
  const [dist] = await db.insert(catalogueDistributions).values({ organizationId, productIds, locationIds, createdBy: actorUserId, status: 'completed' }).returning();
  const summary = { synced: 0, skipped: 0, failed: 0 };
  for (const item of plan) {
    const b = bundles.get(item.productId)!;
    let status: 'synced' | 'skipped' | 'failed' = item.status === 'ready' ? 'synced' : item.status === 'blocked' ? 'failed' : 'skipped';
    let message = item.message;
    if (item.status === 'ready') {
      try {
        await db.transaction(async (tx) => {
          if (item.action === 'delist') {
            await tx.update(locationListings).set({ status: 'delisted', distributionId: dist!.id, updatedAt: new Date() }).where(and(eq(locationListings.locationId, item.locationId), eq(locationListings.productId, item.productId)));
            return;
          }
          const snap = snapshotOf(b);
          await tx.insert(locationListings).values({ organizationId, locationId: item.locationId, productId: item.productId, status: 'listed', contentVersion: b.product.contentVersion, snapshot: snap, distributionId: dist!.id })
            .onConflictDoUpdate({ target: [locationListings.locationId, locationListings.productId], set: { status: 'listed', contentVersion: b.product.contentVersion, snapshot: snap, distributionId: dist!.id, updatedAt: new Date() } });
          for (const v of snap.variants) {
            await tx.insert(locationVariants).values({ organizationId, locationId: item.locationId, variantId: v.id, currency: item.currency }).onConflictDoNothing();
          }
          for (const o of item.overridesOutOfBounds) {
            await tx.update(locationVariants).set({ priceMinor: null, priceSetBy: actorUserId, priceSetAt: new Date(), updatedAt: new Date() }).where(and(eq(locationVariants.locationId, item.locationId), eq(locationVariants.variantId, o.variantId)));
          }
        });
      } catch (err) {
        status = 'failed';
        message = (err as Error).message;
      }
    }
    summary[status]++;
    await db.insert(distributionResults).values({ organizationId, distributionId: dist!.id, locationId: item.locationId, productId: item.productId, status, action: item.action, message, changes: { changes: item.changes, overridesReset: item.overridesOutOfBounds } });
  }
  const overall = summary.failed === 0 ? 'completed' : summary.synced === 0 ? 'failed' : 'partial';
  const [done] = await db.update(catalogueDistributions).set({ status: overall, summary, completedAt: new Date() }).where(eq(catalogueDistributions.id, dist!.id)).returning();
  await audit(db, { organizationId, actorUserId, action: 'catalogue.distributed', scopeKind: 'organization', scopeId: organizationId, targetType: 'catalogue_distribution', targetId: dist!.id, metadata: { summary, products: productIds.length, locations: locationIds.length }, ip: ip ?? null });
  return done!;
}

// ───────── Storefront view (public) ─────────

export type Band = 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'not_stocked';
export function stockBand(lv: { stockOnHand: number; reserved: number; available: boolean; allowBackorder?: boolean | null } | undefined, productBackorder: boolean): Band {
  if (!lv || !lv.available) return 'not_stocked';
  const free = lv.stockOnHand - lv.reserved;
  if (free <= 0) return (lv.allowBackorder ?? productBackorder) ? 'backorder' : 'out_of_stock';
  return free <= 3 ? 'low_stock' : 'in_stock';
}

/** Localised field from a snapshot: requested locale, its base language, then the master text. */
export function localised(snap: ListingSnapshot, locale: string | null | undefined) {
  const tr = locale ? snap.translations[locale] ?? snap.translations[locale.split('-')[0]!] : undefined;
  return { name: tr?.name || snap.name, description: tr?.description ?? snap.description, locale: tr ? locale : null };
}

export async function storefrontProducts(db: Exec, loc: Location, opts: { locale?: string | null; collectionSlug?: string | null; q?: string | null; productId?: string | null }) {
  const conds = [eq(locationListings.locationId, loc.id), eq(locationListings.status, 'listed'), eq(products.status, 'active')];
  if (opts.productId) conds.push(eq(products.id, opts.productId));
  let rows = await db.select({ l: locationListings, p: products }).from(locationListings).innerJoin(products, eq(products.id, locationListings.productId)).where(and(...conds));
  if (opts.collectionSlug) {
    const [c] = await db.select().from(collections).where(and(eq(collections.organizationId, loc.organizationId), eq(collections.slug, opts.collectionSlug), eq(collections.status, 'active')));
    const members = c ? await db.select().from(collectionProducts).where(eq(collectionProducts.collectionId, c.id)) : [];
    const pos = new Map(members.map((m) => [m.productId, m.position]));
    rows = rows.filter((r) => pos.has(r.p.id)).sort((a, b) => pos.get(a.p.id)! - pos.get(b.p.id)!);
  }
  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter((r) => [r.l.snapshot.name, localised(r.l.snapshot, opts.locale).name, r.p.sku, ...r.l.snapshot.variants.map((v) => v.sku), ...r.l.snapshot.tags].some((x) => x.toLowerCase().includes(q)));
  }
  if (!opts.collectionSlug) rows.sort((a, b) => a.l.snapshot.name.localeCompare(b.l.snapshot.name));
  const vIds = rows.flatMap((r) => r.l.snapshot.variants.map((v) => v.id));
  const lvs = vIds.length ? await db.select().from(locationVariants).where(and(eq(locationVariants.locationId, loc.id), inArray(locationVariants.variantId, vIds))) : [];
  const vrows = vIds.length ? await db.select().from(variants).where(inArray(variants.id, vIds)) : [];
  return rows.map(({ l, p }) => {
    const snap = l.snapshot;
    const text = localised(snap, opts.locale);
    const vs = snap.variants.map((sv) => {
      const v = vrows.find((x) => x.id === sv.id);
      const lv = lvs.find((x) => x.variantId === sv.id);
      const amount = lv?.priceMinor ?? v?.prices[loc.currency] ?? null;
      const vName = (opts.locale && (snap.variantTranslations[sv.id]?.[opts.locale]?.name ?? snap.variantTranslations[sv.id]?.[opts.locale.split('-')[0]!]?.name)) || sv.name;
      const band: Band = !v || v.status !== 'active' || amount === null ? 'not_stocked' : stockBand(lv, p.allowBackorder);
      return { id: sv.id, sku: sv.sku, name: vName, options: sv.options, imageUrl: sv.imageUrl, price: amount === null ? null : { amount, currency: loc.currency }, availability: band };
    });
    const prices = vs.map((v) => v.price?.amount).filter((x): x is number => x != null);
    return {
      id: p.id, slug: snap.slug, name: text.name, description: text.description, contentLocale: text.locale, vendor: snap.vendor, productType: snap.productType,
      options: snap.options, specs: snap.specs, images: snap.images, image: snap.images[0]?.url ?? null, returnable: p.returnable,
      priceFrom: prices.length ? { amount: Math.min(...prices), currency: loc.currency } : null,
      priceVaries: new Set(prices).size > 1, variants: vs,
      availability: vs.some((v) => v.availability === 'in_stock' || v.availability === 'low_stock') ? 'in_stock' : vs.some((v) => v.availability === 'backorder') ? 'backorder' : 'out_of_stock',
    };
  }).filter((p) => p.variants.some((v) => v.availability !== 'not_stocked'));
}

/** Same-currency stores that also list a product, with their stock band per variant (for "also at" and collection). */
export async function otherStoresStock(db: Exec, loc: Location, productId: string) {
  const others = await db.select().from(locations).where(and(eq(locations.organizationId, loc.organizationId), ne(locations.id, loc.id), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
  if (!others.length) return [];
  const listings = await db.select().from(locationListings).where(and(eq(locationListings.productId, productId), eq(locationListings.status, 'listed'), inArray(locationListings.locationId, others.map((o) => o.id))));
  const vIds = [...new Set(listings.flatMap((l) => l.snapshot.variants.map((v) => v.id)))];
  const lvs = vIds.length ? await db.select().from(locationVariants).where(and(inArray(locationVariants.variantId, vIds), inArray(locationVariants.locationId, others.map((o) => o.id)))) : [];
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  return others.filter((o) => listings.some((l) => l.locationId === o.id)).map((o) => ({
    id: o.id, name: o.name, slug: o.slug, currency: o.currency, sameCurrency: o.currency === loc.currency,
    variants: listings.find((l) => l.locationId === o.id)!.snapshot.variants.map((v) => ({ id: v.id, availability: stockBand(lvs.find((x) => x.locationId === o.id && x.variantId === v.id), p?.allowBackorder ?? false) })),
  }));
}

// ───────── Local assortment (staff) ─────────

export async function assortmentFor(db: Exec, loc: Location) {
  const rows = await db.select({ l: locationListings, p: products }).from(locationListings).innerJoin(products, eq(products.id, locationListings.productId))
    .where(eq(locationListings.locationId, loc.id)).orderBy(asc(products.name));
  const pIds = rows.map((r) => r.p.id);
  const vs = pIds.length ? await db.select().from(variants).where(inArray(variants.productId, pIds)).orderBy(asc(variants.position), asc(variants.sku)) : [];
  const lvs = vs.length ? await db.select().from(locationVariants).where(and(eq(locationVariants.locationId, loc.id), inArray(locationVariants.variantId, vs.map((v) => v.id)))) : [];
  const setters = [...new Set(lvs.map((x) => x.priceSetBy).filter((x): x is string => !!x))];
  const people = setters.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, setters)) : [];
  const transit = await db.select().from(stockTransfers).where(and(eq(stockTransfers.toLocationId, loc.id), eq(stockTransfers.status, 'in_transit')));
  return rows.map(({ l, p }) => ({
    productId: p.id, productName: p.name, sku: p.sku, listingStatus: l.status, distributedVersion: l.contentVersion, masterVersion: p.contentVersion,
    updateAvailable: l.status === 'listed' && l.contentVersion < p.contentVersion, productStatus: p.status,
    lockedFields: ['sku', 'name', 'description', 'images', 'options', 'translations'],
    variants: vs.filter((v) => v.productId === p.id && l.snapshot.variants.some((sv) => sv.id === v.id)).map((v) => {
      const lv = lvs.find((x) => x.variantId === v.id);
      const b = boundsFor(p, v, loc.currency);
      const inTransit = transit.reduce((a, t) => a + t.lines.filter((x) => x.variantId === v.id).reduce((s2, x) => s2 + (x.shipped - x.received), 0), 0);
      return {
        variantId: v.id, sku: v.sku, name: v.name, options: v.options,
        hqPrice: b.hq === null ? null : { amount: b.hq, currency: loc.currency },
        localPrice: lv?.priceMinor != null ? { amount: lv.priceMinor, currency: loc.currency } : null,
        effectivePrice: (lv?.priceMinor ?? b.hq) === null ? null : { amount: (lv?.priceMinor ?? b.hq)!, currency: loc.currency },
        priceOrigin: lv?.priceMinor != null ? 'local' as const : 'hq' as const,
        bounds: b.overridable ? { min: { amount: b.min!, currency: loc.currency }, max: { amount: b.max!, currency: loc.currency } } : null,
        priceSetBy: lv?.priceSetBy ? people.find((x) => x.id === lv.priceSetBy)?.name ?? 'Team member' : null, priceSetAt: lv?.priceSetAt?.toISOString() ?? null,
        available: lv?.available ?? true, availabilityOrigin: lv && !lv.available ? 'local' as const : 'hq' as const,
        onHand: lv?.stockOnHand ?? 0, reserved: lv?.reserved ?? 0, availableQty: (lv?.stockOnHand ?? 0) - (lv?.reserved ?? 0), inTransit,
        reorderPoint: lv?.reorderPoint ?? null, reorderQty: lv?.reorderQty ?? null, allowBackorder: lv?.allowBackorder ?? null, productAllowsBackorder: p.allowBackorder,
      };
    }),
  }));
}
