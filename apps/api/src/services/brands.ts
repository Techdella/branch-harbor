/**
 * Multi-brand HQ: one franchisor business (one industry) running several brands of that industry.
 *
 * - Every business has a default brand; locations, prospects, territories and agreements without a brand belong to it.
 * - Brand-level records (franchise documents, templates, email themes, assets) with no brand are shared by every brand.
 * - The brand filter (`X-BH-Brand`, the top-bar switcher) narrows reads; a brand-scoped person only ever covers their
 *   own brand, so they see only that brand whatever they send.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import { resolveTheme, type SiteFont } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { brands, locations, organizations } from '../db/schema/index.ts';
import { assignmentCovers } from '../domain/scope.ts';
import { defaultBrandId, requestedBrandId, requireMember, scopedLocations } from './authz.ts';

export type BrandRow = typeof brands.$inferSelect;

/** Brands of the business (not archived), default first. */
export async function orgBrands(db: Exec, organizationId: string, opts: { includeArchived?: boolean } = {}): Promise<BrandRow[]> {
  await defaultBrandId(db, organizationId);
  const conds = [eq(brands.organizationId, organizationId)];
  if (!opts.includeArchived) conds.push(isNull(brands.archivedAt));
  return db.select().from(brands).where(and(...conds)).orderBy(desc(brands.isDefault), asc(brands.name));
}

/** True when the business runs more than one (active) brand. Single-brand businesses see no brand UI at all. */
export async function isMultiBrand(db: Exec, organizationId: string): Promise<boolean> {
  return (await orgBrands(db, organizationId)).length > 1;
}

/**
 * Brands the person covers: every brand for an organisation-wide assignment, otherwise the brands of their brand
 * assignments, of their territories and of the locations their other assignments cover.
 */
export async function coveredBrandIds(req: FastifyRequest, db: Exec, organizationId: string): Promise<'all' | Set<string>> {
  const assignments = await requireMember(req, db, organizationId);
  const now = new Date();
  const live = assignments.filter((a) => !(a.expiresAt && a.expiresAt <= now));
  if (live.some((a) => a.scopeKind === 'organization' && a.scopeId === organizationId)) return 'all';
  const out = new Set<string>(live.filter((a) => a.scopeKind === 'brand').map((a) => a.scopeId));
  const locs = await scopedLocations(db, organizationId);
  for (const l of locs) {
    const chain = { organizationId, kind: 'location' as const, locationId: l.id, regionId: l.regionId, ownerGroupId: l.ownerGroupId, territoryId: l.territoryId ?? null, brandId: l.brandId ?? null, portfolioIds: l.portfolioIds ?? [] };
    if (l.brandId && live.some((a) => assignmentCovers(a, chain, now))) out.add(l.brandId);
  }
  return out;
}

/**
 * Brands a read should include: the requested brand (when the person covers it) or every brand they cover.
 * An unknown or uncovered brand filter gives an empty set (nothing leaks across brands).
 */
export async function brandFilterIds(req: FastifyRequest, db: Exec, organizationId: string): Promise<'all' | Set<string>> {
  const covered = await coveredBrandIds(req, db, organizationId);
  const requested = requestedBrandId(req);
  if (!requested) return covered;
  if (covered !== 'all' && !covered.has(requested)) return new Set();
  const [b] = await db.select({ id: brands.id }).from(brands).where(and(eq(brands.id, requested), eq(brands.organizationId, organizationId)));
  return b ? new Set([b.id]) : new Set();
}

/**
 * SQL condition for records that belong to ONE brand where null means the default brand (prospects, territories,
 * agreements, projects, social accounts). Undefined = no filter.
 */
export async function brandOwnedCond(req: FastifyRequest, db: Exec, organizationId: string, column: AnyPgColumn): Promise<SQL | undefined> {
  const ids = await brandFilterIds(req, db, organizationId);
  if (ids === 'all') return undefined;
  if (!ids.size) return inArray(column, ['00000000-0000-0000-0000-000000000000']);
  const def = await defaultBrandId(db, organizationId);
  return def && ids.has(def) ? or(inArray(column, [...ids]), isNull(column)) : inArray(column, [...ids]);
}

/** SQL condition for brand-level records where null means shared by every brand (documents, templates, assets). */
export async function brandSharedCond(req: FastifyRequest, db: Exec, organizationId: string, column: AnyPgColumn): Promise<SQL | undefined> {
  const ids = await brandFilterIds(req, db, organizationId);
  if (ids === 'all') return undefined;
  return ids.size ? or(isNull(column), inArray(column, [...ids])) : isNull(column);
}

/** Verifies a brand belongs to the business (tenant boundary) and returns it. */
export async function brandInOrg(db: Exec, organizationId: string, brandId: string): Promise<BrandRow | null> {
  const [b] = await db.select().from(brands).where(and(eq(brands.id, brandId), eq(brands.organizationId, organizationId)));
  return b ?? null;
}

/** The brand a location belongs to (the default brand when it has none). */
export async function brandOfLocation(db: Exec, organizationId: string, locationId: string | null | undefined): Promise<BrandRow | null> {
  let id: string | null = null;
  if (locationId) {
    const [l] = await db.select({ brandId: locations.brandId }).from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
    id = l?.brandId ?? null;
  }
  id ??= await defaultBrandId(db, organizationId);
  return id ? brandInOrg(db, organizationId, id) : null;
}

/** Site settings the business set (Marketing → Websites → Theme); brand fields override them. */
type SiteSettingsLike = { themeId?: string; colorMode?: 'theme' | 'brand'; primaryColor?: string; accentColor?: string | null; headingFont?: SiteFont | null; bodyFont?: SiteFont | null; logoUrl?: string | null; tagline?: string | null; enabledLocales?: string[] };

/**
 * The site settings for a brand: the business's site settings with the brand's identity on top (logo, colours, fonts,
 * theme, tagline, languages). The default brand only overrides what was set on it explicitly.
 */
export function brandSiteSettings(orgSite: SiteSettingsLike, b: BrandRow | null): SiteSettingsLike {
  if (!b) return orgSite;
  const pick = <T>(v: T | null | undefined, fallback: T | undefined) => (v === null || v === undefined || v === '' ? fallback : v);
  return {
    ...orgSite,
    themeId: pick(b.themeId, orgSite.themeId) ?? undefined,
    colorMode: b.primaryColor ? 'brand' : orgSite.colorMode,
    primaryColor: pick(b.primaryColor, orgSite.primaryColor),
    accentColor: pick(b.accentColor, orgSite.accentColor ?? null) ?? null,
    headingFont: (pick(b.headingFont, orgSite.headingFont ?? null) ?? null) as SiteFont | null,
    bodyFont: (pick(b.bodyFont, orgSite.bodyFont ?? null) ?? null) as SiteFont | null,
    logoUrl: pick(b.logoUrl, orgSite.logoUrl ?? null) ?? null,
    tagline: pick(b.tagline, orgSite.tagline ?? null) ?? null,
    enabledLocales: b.locales.length ? b.locales : orgSite.enabledLocales,
  };
}

/** Email identity of a brand: display name, logo, palette and sender (marketing and customer email). */
export async function emailIdentity(db: Exec, organizationId: string, locationId: string | null | undefined) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  const b = await brandOfLocation(db, organizationId, locationId);
  const site = brandSiteSettings((org!.settings.site ?? {}) as SiteSettingsLike, b);
  const theme = resolveTheme(site.themeId ?? 'classic', { colorMode: site.colorMode ?? (site.themeId ? 'theme' : 'brand'), primaryColor: site.primaryColor ?? null, accentColor: site.accentColor ?? null, headingFont: site.headingFont ?? null, bodyFont: site.bodyFont ?? null });
  const name = b && !b.isDefault ? b.name : org!.name;
  return {
    org: org!, brand: b,
    email: { name, logoUrl: site.logoUrl ?? null, palette: theme.light, fonts: theme.fonts },
    sender: { fromName: b?.emailFromName || name, replyTo: b?.emailReplyTo ?? null },
  };
}

/**
 * Public site address → business: `/{slug}` is the business's own slug (its main brand) or another brand's slug.
 * Used by every public endpoint that takes the site's brand segment.
 */
export function siteSlugCond(slug: string): SQL {
  return or(eq(organizations.slug, slug), sql`${organizations.id} in (select "organization_id" from "brands" where "slug" = ${slug} and "archived_at" is null)`)!;
}

/** The brand a public site address names (the business's main brand for its own slug). */
export async function brandForSiteSlug(db: Exec, organizationId: string, slug: string): Promise<BrandRow | null> {
  const [b] = await db.select().from(brands).where(and(eq(brands.organizationId, organizationId), eq(brands.slug, slug), isNull(brands.archivedAt)));
  if (b) return b;
  const def = await defaultBrandId(db, organizationId);
  return def ? brandInOrg(db, organizationId, def) : null;
}

export function serializeBrand(b: BrandRow, extra: { locationCount?: number } = {}) {
  return {
    id: b.id, name: b.name, slug: b.slug, isDefault: b.isDefault, logoUrl: b.logoUrl, primaryColor: b.primaryColor, accentColor: b.accentColor,
    headingFont: b.headingFont, bodyFont: b.bodyFont, themeId: b.themeId, tagline: b.tagline, domain: b.domain, locales: b.locales,
    defaultCurrency: b.defaultCurrency, emailFromName: b.emailFromName, emailReplyTo: b.emailReplyTo, onboardingTemplateKey: b.onboardingTemplateKey,
    siteTemplateId: b.settings.siteTemplateId ?? null, emailTemplateId: b.settings.emailTemplateId ?? null, assetFolder: b.settings.assetFolder ?? null,
    reviews: b.settings.reviews ?? {},
    locationCount: extra.locationCount ?? 0, archivedAt: b.archivedAt?.toISOString() ?? null,
  };
}
