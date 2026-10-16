import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { SITE_FONT_KEYS, SITE_THEMES, SUPPORTED_LOCALES, locale as localeSchema, resolveTheme, type Locale, type SiteFont } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  classBookings, classOccurrences, classTypes, connections, domains, locationVariants, locations, organizations,
  pageVersions, pages, paymentReferences, products, variants, waitlistEntries, websites,
} from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { notFound } from '../lib/errors.ts';
import { localDateParts } from '../lib/tz.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requirePerm } from '../services/authz.ts';
import { orgParams, secured } from './_common.ts';
import { brandForSiteSlug, brandInOrg, brandSiteSettings, siteSlugCond } from '../services/brands.ts';

/**
 * Hosted customer-facing websites ("Hosted" delivery model) served by apps/sites at
 * {SITES_BASE_URL}/{brandSlug}/{locationSlug} and on connected custom domains.
 *
 * Rules enforced here:
 * - Only PUBLISHED page versions are returned (pages.publishedVersionId → page_versions.content). Drafts,
 *   pending approvals and unpublished field edits never leak, even when the page row itself is back in draft.
 * - Locations must be publicly visible and not archived; otherwise 404 (same as "does not exist").
 * - Host resolution only considers domains in state `ready`.
 * - Theme is the business's brand; BranchHarbor branding is limited to an optional "Powered by" (off by default).
 */

// ───────── Site settings (brand theme) ─────────

/** Fonts the site renderer can load; anything else is rejected so a theme can't break legibility. */
export const SITE_FONTS = SITE_FONT_KEYS as [SiteFont, ...SiteFont[]];
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #2F6B3A');
const httpsUrl = z.url().refine((u) => u.startsWith('https://'), 'Must be an https:// URL');

export const siteSettingsSchema = z.object({
  primaryColor: hex.default('#141414'),
  logoUrl: httpsUrl.nullable().default(null),
  heroImageUrl: httpsUrl.nullable().default(null),
  font: z.enum(SITE_FONTS).default('system'),
  tagline: z.string().max(160).nullable().default(null),
  /** Small "Powered by BranchHarbor" in the footer. Off unless the business opts in. */
  poweredBy: z.boolean().default(false),
  /** Languages the business offers on its site, in addition to each location's own locale. */
  enabledLocales: z.array(localeSchema).max(SUPPORTED_LOCALES.length).default([]),
  // Website builder theme (Marketing workspace). Optional so older clients that PUT the settings keep the theme.
  themeId: z.enum(SITE_THEMES.map((t) => t.id) as [string, ...string[]]).optional(),
  colorMode: z.enum(['theme', 'brand']).optional(),
  accentColor: hex.nullable().optional(),
  headingFont: z.enum(SITE_FONTS).nullable().optional(),
  bodyFont: z.enum(SITE_FONTS).nullable().optional(),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

function readSiteSettings(raw: unknown): SiteSettings {
  const parsed = siteSettingsSchema.safeParse((raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>);
  return parsed.success ? parsed.data : siteSettingsSchema.parse({});
}

// WCAG relative luminance / contrast.
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
function mixToward(h: string, target: number, t: number): string {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - t) + target * t).toString(16).padStart(2, '0')).join('');
}

/**
 * Derive an accessible palette from the brand colour: text on the brand colour (white or ink, whichever
 * passes), and a "primaryInk" variant darkened until it reaches 4.5:1 on white for links and text.
 */
export function themeFrom(settings: SiteSettings) {
  const primary = settings.primaryColor.toUpperCase();
  let primaryInk = primary;
  for (let t = 0.1; contrast(primaryInk, '#FFFFFF') < 4.5 && t <= 1.01; t += 0.1) primaryInk = mixToward(primary, 0, Math.min(t, 1)).toUpperCase();
  const inkOn = contrast(primary, '#FFFFFF') >= contrast(primary, '#141414') ? '#FFFFFF' : '#141414';
  // Buttons use the brand colour when a text colour passes 4.5:1 on it; otherwise the darkened variant.
  const passes = contrast(primary, inkOn) >= 4.5;
  const buttonBg = passes ? primary : primaryInk;
  const onPrimary = passes ? inkOn : '#FFFFFF';
  return {
    primary: buttonBg, brandColor: primary, onPrimary, primaryInk,
    primaryContrast: Math.round(contrast(buttonBg, onPrimary) * 100) / 100,
    font: settings.font, logoUrl: settings.logoUrl, heroImageUrl: settings.heroImageUrl,
    /** Website builder theme (presentation only) with brand overrides applied. Sites without a theme keep the classic look in their brand colour. */
    themeId: settings.themeId ?? 'classic',
    site: resolveTheme(settings.themeId ?? 'classic', {
      colorMode: settings.colorMode ?? (settings.themeId ? 'theme' : 'brand'), primaryColor: settings.primaryColor, accentColor: settings.accentColor ?? null,
      headingFont: settings.headingFont ?? null, bodyFont: settings.bodyFont ?? (settings.font !== 'system' ? settings.font : null),
    }),
  };
}

// ───────── Hours ─────────

type WeeklyHours = Array<{ day: number; opens: string; closes: string }>;
const hhmm = /^([01]\d|2[0-4]):[0-5]\d$/;

/** Normalise `locations.hours`: `{ summary?, weekly?: [{ day 0=Sun, opens 'HH:MM', closes 'HH:MM' }] }`. */
export function normaliseHours(raw: Record<string, unknown> | null): { summary: string | null; weekly: WeeklyHours | null } {
  if (!raw) return { summary: null, weekly: null };
  const summary = typeof raw.summary === 'string' ? raw.summary : null;
  const weekly = Array.isArray(raw.weekly)
    ? (raw.weekly as unknown[]).filter((w): w is WeeklyHours[number] => {
      const x = w as Record<string, unknown>;
      return !!x && Number.isInteger(x.day) && (x.day as number) >= 0 && (x.day as number) <= 6 && typeof x.opens === 'string' && typeof x.closes === 'string' && hhmm.test(x.opens) && hhmm.test(x.closes);
    })
    : null;
  return { summary, weekly: weekly && weekly.length ? weekly : null };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Open-now in the location's own timezone. Handles intervals past midnight (closes <= opens).
 * Returns null when only a free-text summary exists — we never guess.
 */
export function openNow(weekly: WeeklyHours | null, timeZone: string, at = new Date()): { open: boolean; closesAt: string | null } | null {
  if (!weekly) return null;
  const { weekday, time } = localDateParts(at, timeZone);
  const now = toMin(time);
  for (const w of weekly) {
    const o = toMin(w.opens), c = toMin(w.closes);
    if (c > o) { if (w.day === weekday && now >= o && now < c) return { open: true, closesAt: w.closes }; }
    else {
      // overnight: e.g. Fri 18:00 → 02:00
      if (w.day === weekday && now >= o) return { open: true, closesAt: w.closes };
      if ((w.day + 1) % 7 === weekday && now < c) return { open: true, closesAt: w.closes };
    }
  }
  return { open: false, closesAt: null };
}

// ───────── Routes ─────────

export const siteRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const base = s.cfg.SITES_BASE_URL.replace(/\/$/, '');

  /**
   * The business behind a site address, with the brand the address names (multi-brand HQ: `/{brand}` is the business
   * slug for its main brand, or another brand's slug). `siteSlug` is the address segment to link with.
   */
  async function loadBrand(slug: string) {
    const [org] = await s.db.select().from(organizations).where(and(siteSlugCond(slug), isNull(organizations.deletedAt), ne(organizations.status, 'suspended')));
    if (!org) throw notFound('Site');
    const siteBrand = await brandForSiteSlug(s.db, org.id, slug);
    return { ...org, siteBrand, siteSlug: siteBrand?.slug ?? org.slug };
  }
  type SiteOrg = Awaited<ReturnType<typeof loadBrand>>;

  /** Locations of the brand the address names (the main brand also holds locations without a brand). */
  const inBrand = (org: SiteOrg) => {
    const b = org.siteBrand;
    if (!b) return undefined;
    return b.isDefault ? or(isNull(locations.brandId), eq(locations.brandId, b.id)) : eq(locations.brandId, b.id);
  };
  const visibleIn = (org: SiteOrg) => and(visible(org.id), inBrand(org));

  function brandView(org: SiteOrg) {
    // The brand's identity (logo, colours, fonts, theme, languages) on top of the business's site settings.
    const settings = readSiteSettings(brandSiteSettings((org.settings.site ?? {}) as Parameters<typeof brandSiteSettings>[0], org.siteBrand));
    const locales = [...new Set([org.defaultLocale, ...settings.enabledLocales])].filter((l): l is Locale => (SUPPORTED_LOCALES as readonly string[]).includes(l));
    const brandName = org.siteBrand && !org.siteBrand.isDefault ? org.siteBrand.name : org.name;
    return {
      name: brandName, slug: org.siteSlug, industry: org.industry, country: org.country, defaultLocale: org.defaultLocale, locales,
      tagline: settings.tagline, poweredBy: settings.poweredBy, theme: themeFrom(settings),
      /** independent: the brand site IS the location site (served at /{brand}, no location finder). */
      model: org.model === 'independent' ? ('independent' as const) : ('network' as const),
    };
  }

  /** Independent business: its single customer-visible location (the brand site renders it directly). */
  async function singleLocation(org: SiteOrg) {
    if (org.model !== 'independent') return null;
    const [l] = await s.db.select().from(locations).where(visibleIn(org)).orderBy(asc(locations.createdAt)).limit(1);
    return l ?? null;
  }

  /** Customer-visible location: public, not archived, in a non-deleted organisation. */
  const visible = (orgId: string) => and(eq(locations.organizationId, orgId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt));

  /** Hosted (not WordPress, not paused) website for a location (or the brand site when locationId is null). */
  async function hostedSite(orgId: string, locationId: string | null, brand: SiteOrg['siteBrand'] = null) {
    // A brand site (no location) is the site of one brand; the main brand's site may carry no brand.
    const brandCond = locationId || !brand ? undefined : brand.isDefault ? or(isNull(websites.brandId), eq(websites.brandId, brand.id)) : eq(websites.brandId, brand.id);
    const [site] = await s.db.select().from(websites).where(and(
      eq(websites.organizationId, orgId), locationId ? eq(websites.locationId, locationId) : isNull(websites.locationId), brandCond,
      eq(websites.kind, 'hosted'), ne(websites.status, 'paused'),
    ));
    return site ?? null;
  }

  /** Only the published version of each page — never the draft field values. */
  async function publishedPages(websiteId: string | null) {
    if (!websiteId) return [];
    const rows = await s.db.select({ p: pages, v: pageVersions }).from(pages)
      .innerJoin(pageVersions, eq(pageVersions.id, pages.publishedVersionId))
      .where(and(eq(pages.websiteId, websiteId), isNotNull(pages.publishedVersionId), isNull(pages.archivedAt), ne(pages.status, 'archived')))
      .orderBy(asc(pages.navOrder), asc(pages.slug));
    return rows.map(({ p, v }) => ({
      slug: p.slug, title: p.title,
      seo: { title: p.seo.title ?? null, description: p.seo.description ?? null, canonicalOwner: p.seo.canonicalOwner ?? 'branchharbor', socialImage: p.seo.socialImage ?? null, noindex: p.seo.noindex === true },
      content: v.content, version: v.version, publishedAt: (p.publishedAt ?? v.createdAt).toISOString(),
      /** Website builder document of the published version (null for classic field pages). */
      document: v.document ?? null,
      nav: { label: p.navLabel ?? p.title, show: p.showInNav, order: p.navOrder },
    }));
  }

  async function primaryHost(websiteId: string | null) {
    if (!websiteId) return null;
    const [d] = await s.db.select({ hostname: domains.hostname }).from(domains).where(and(eq(domains.websiteId, websiteId), eq(domains.state, 'ready'), eq(domains.isPrimary, true)));
    return d?.hostname ?? null;
  }

  function locationSummary(l: typeof locations.$inferSelect, brandSlug: string, single = false) {
    const hours = normaliseHours(l.hours);
    return {
      id: l.id, slug: l.slug, name: l.name, address: l.address, country: l.country, timeZone: l.timeZone, currency: l.currency, locale: l.locale,
      phone: l.phone, email: l.email, status: l.status, geo: l.geo, hours, openNow: openNow(hours.weekly, l.timeZone),
      path: single ? `/${brandSlug}` : `/${brandSlug}/${l.slug}`,
    };
  }

  /** Which customer module the location offers natively, or which external system is authoritative. */
  async function moduleFor(org: typeof organizations.$inferSelect, loc: typeof locations.$inferSelect) {
    const kindFor: Record<string, string> = { studios: 'booking', wellness: 'booking', sports: 'booking', commerce: 'commerce', foods: 'pos' };
    const conns = await s.db.select().from(connections).where(and(
      eq(connections.organizationId, org.id), or(isNull(connections.locationId), eq(connections.locationId, loc.id)),
      eq(connections.authoritative, 'external'), ne(connections.state, 'disconnected'),
    ));
    const ext = conns.find((c) => c.kind === kindFor[org.industry]) ?? null;
    const siteUrl = ext && typeof ext.config.siteUrl === 'string' && ext.config.siteUrl.startsWith('https://') ? ext.config.siteUrl : null;
    return {
      kind: org.industry,
      /** native = BranchHarbor runs the workflow; external = a connected system is authoritative (link out, no native checkout). */
      mode: ext ? ('external' as const) : ('native' as const),
      externalProvider: ext?.provider ?? null,
      externalUrl: siteUrl,
      paymentsEnabled: loc.paymentsEnabled,
      payAtPickup: loc.settings.payAtPickup === true,
      sandboxPayments: s.payments.mode === 'sandbox',
    };
  }

  // ── Host resolution (proxy.ts in apps/sites) ──
  app.get('/public/sites/resolve-host', {
    schema: {
      tags: ['sites'], summary: 'Map a custom hostname to a brand/location site. Only domains in state `ready` resolve.',
      querystring: z.object({ host: z.string().min(3).max(253) }),
    },
  }, async (req, reply) => {
    const host = req.query.host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const [row] = await s.db.select({ d: domains, w: websites, o: organizations }).from(domains)
      .innerJoin(websites, eq(websites.id, domains.websiteId))
      .innerJoin(organizations, eq(organizations.id, domains.organizationId))
      .where(and(eq(domains.hostname, host), eq(domains.state, 'ready'), isNull(organizations.deletedAt), eq(websites.kind, 'hosted'), ne(websites.status, 'paused')));
    if (!row) throw notFound('Host');
    let locationSlug: string | null = null;
    const locId = row.w.locationId ?? row.d.locationId;
    if (locId) {
      const [l] = await s.db.select().from(locations).where(and(eq(locations.id, locId), visible(row.o.id)));
      if (!l) throw notFound('Host');
      locationSlug = l.slug;
    }
    const primary = await primaryHost(row.w.id);
    reply.header('cache-control', 'public, max-age=60');
    // Multi-brand HQ: the address segment of the brand the site belongs to.
    let brandId = row.w.brandId;
    if (locId) brandId = (await s.db.select({ b: locations.brandId }).from(locations).where(eq(locations.id, locId)))[0]?.b ?? null;
    const brandSlug = brandId ? (await brandInOrg(s.db, row.o.id, brandId))?.slug ?? row.o.slug : row.o.slug;
    return { hostname: host, brandSlug, locationSlug, isPrimary: row.d.isPrimary, primaryHost: primary };
  });

  // ── Brand mode (proxy.ts in apps/sites): independent brands serve their single location at /{brand} ──
  app.get('/public/sites/resolve-brand', {
    schema: {
      tags: ['sites'], summary: 'Business mode of a brand site: independent businesses render their location at /{brand}',
      querystring: z.object({ brand: z.string().min(1).max(80) }),
    },
  }, async (req, reply) => {
    const org = await loadBrand(req.query.brand);
    const single = await singleLocation(org);
    reply.header('cache-control', 'public, max-age=60');
    return { brandSlug: org.siteSlug, model: org.model === 'independent' ? 'independent' : 'network', singleLocationSlug: single?.slug ?? null };
  });

  // ── Brand site ──
  app.get('/public/sites/:brandSlug', {
    schema: { tags: ['sites'], summary: 'Brand site: theme, published brand pages, customer-visible locations (with sitemap data)', params: z.object({ brandSlug: z.string().min(1).max(80) }) },
  }, async (req) => {
    const org = await loadBrand(req.params.brandSlug);
    const site = await hostedSite(org.id, null, org.siteBrand);
    const locs = await s.db.select().from(locations).where(visibleIn(org)).orderBy(asc(locations.name));
    const locSites = locs.length ? await s.db.select().from(websites).where(and(inArray(websites.locationId, locs.map((l) => l.id)), eq(websites.kind, 'hosted'), ne(websites.status, 'paused'))) : [];
    const locPages = locSites.length ? await s.db.select({ websiteId: pages.websiteId, slug: pages.slug, publishedAt: pages.publishedAt }).from(pages)
      .where(and(inArray(pages.websiteId, locSites.map((w) => w.id)), isNotNull(pages.publishedVersionId), isNull(pages.archivedAt), ne(pages.status, 'archived'))) : [];
    const hosts = locSites.length ? await s.db.select({ websiteId: domains.websiteId, hostname: domains.hostname }).from(domains)
      .where(and(inArray(domains.websiteId, locSites.map((w) => w.id)), eq(domains.state, 'ready'), eq(domains.isPrimary, true))) : [];
    const single = org.model === 'independent';
    return {
      brand: brandView(org),
      pages: await publishedPages(site?.id ?? null),
      site: { includedAddress: `${base}/${org.siteSlug}`, primaryHost: await primaryHost(site?.id ?? null), singleLocationSlug: single ? locs[0]?.slug ?? null : null },
      locations: (single ? locs.slice(0, 1) : locs).map((l) => {
        const w = locSites.find((x) => x.locationId === l.id);
        return {
          ...locationSummary(l, org.siteSlug, single),
          primaryHost: w ? hosts.find((h) => h.websiteId === w.id)?.hostname ?? null : null,
          pages: w ? locPages.filter((p) => p.websiteId === w.id).map((p) => ({ slug: p.slug, publishedAt: p.publishedAt?.toISOString() ?? null })) : [],
        };
      }),
    };
  });

  async function loadLocation(brandSlug: string, locationSlug: string) {
    const org = await loadBrand(brandSlug);
    // A location is only served under its own brand's address.
    const [loc] = await s.db.select().from(locations).where(and(visibleIn(org), eq(locations.slug, locationSlug)));
    if (!loc) throw notFound('Location');
    return { org, loc };
  }

  // ── Location site ──
  app.get('/public/sites/:brandSlug/:locationSlug', {
    schema: {
      tags: ['sites'], summary: 'Location site: published page content (HQ/local merge resolved at publish time), hours, contact and the industry module',
      params: z.object({ brandSlug: z.string().min(1).max(80), locationSlug: z.string().min(1).max(80) }),
    },
  }, async (req) => {
    const { org, loc } = await loadLocation(req.params.brandSlug, req.params.locationSlug);
    const site = await hostedSite(org.id, loc.id);
    const brandSite = await hostedSite(org.id, null, org.siteBrand);
    const others = await s.db.select({ n: locations.id }).from(locations).where(visibleIn(org));
    const single = org.model === 'independent';
    return {
      brand: brandView(org),
      location: locationSummary(loc, org.siteSlug, single),
      pages: await publishedPages(site?.id ?? null),
      module: await moduleFor(org, loc),
      site: {
        // Independent businesses: one address for the whole business.
        includedAddress: single ? `${base}/${org.siteSlug}` : `${base}/${org.siteSlug}/${loc.slug}`,
        singleLocation: single,
        primaryHost: await primaryHost(site?.id ?? null),
        brandPrimaryHost: await primaryHost(brandSite?.id ?? null),
        locationCount: others.length,
        navLinks: site?.navLinks ?? [],
      },
    };
  });

  // ── Commerce: products with this location's availability (no checkout when an external store is authoritative) ──
  app.get('/public/sites/:brandSlug/:locationSlug/products', {
    schema: { tags: ['sites'], summary: 'Commerce listing with local stock and price for one location', params: z.object({ brandSlug: z.string().min(1), locationSlug: z.string().min(1) }) },
  }, async (req) => {
    const { org, loc } = await loadLocation(req.params.brandSlug, req.params.locationSlug);
    const prods = await s.db.select().from(products).where(and(eq(products.organizationId, org.id), eq(products.status, 'active'))).orderBy(asc(products.name));
    const vars = prods.length ? await s.db.select().from(variants).where(inArray(variants.productId, prods.map((p) => p.id))) : [];
    const local = vars.length ? await s.db.select().from(locationVariants).where(and(eq(locationVariants.locationId, loc.id), inArray(locationVariants.variantId, vars.map((v) => v.id)))) : [];
    const module = await moduleFor(org, loc);
    return {
      location: { id: loc.id, name: loc.name, currency: loc.currency },
      checkout: module.mode === 'external' ? { mode: 'external' as const, provider: module.externalProvider, url: module.externalUrl } : { mode: 'none' as const, provider: null, url: null },
      items: prods.map((p) => ({
        id: p.id, name: p.name, description: p.description, image: p.images[0] ?? null,
        variants: vars.filter((v) => v.productId === p.id).map((v) => {
          const lv = local.find((x) => x.variantId === v.id);
          const amount = lv?.priceMinor ?? v.prices[loc.currency] ?? null;
          const stock = lv ? lv.stockOnHand : 0;
          return {
            id: v.id, name: v.name, options: v.options, price: amount === null ? null : { amount, currency: loc.currency },
            // Exact counts are not exposed publicly; bands are enough for shoppers.
            availability: !lv || !lv.available || amount === null ? 'not_stocked' : stock <= 0 ? 'out_of_stock' : stock <= 3 ? 'low_stock' : 'in_stock',
          };
        }),
      })).filter((p) => p.variants.some((v) => v.availability !== 'not_stocked')),
    };
  });

  // ── Manage pages (token-gated) ──
  app.get('/public/sites/manage/class-bookings/:id', {
    schema: { tags: ['sites'], summary: 'Class booking status for the customer (requires manage token)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req) => {
    const [row] = await s.db.select({ b: classBookings, o: classOccurrences, t: classTypes, l: locations, org: organizations }).from(classBookings)
      .innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId))
      .innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId))
      .innerJoin(locations, eq(locations.id, classBookings.locationId))
      .innerJoin(organizations, eq(organizations.id, classBookings.organizationId))
      .where(eq(classBookings.id, req.params.id));
    if (!row || row.b.manageTokenHash !== sha256(req.query.token)) throw notFound('Booking');
    const [pay] = row.b.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, row.b.paymentId)) : [];
    const heldActive = row.b.status === 'held' && !!row.b.holdExpiresAt && row.b.holdExpiresAt > new Date();
    return {
      id: row.b.id, status: row.b.status === 'held' && !heldActive ? 'expired' : row.b.status,
      holdExpiresAt: row.b.holdExpiresAt?.toISOString() ?? null,
      class: { name: row.t.name, startsAt: row.o.startsAt.toISOString(), endsAt: row.o.endsAt.toISOString(), instructorName: row.o.instructorName, room: row.o.room, status: row.o.status },
      price: { amount: row.o.priceMinor, currency: row.o.currency },
      payment: pay ? { id: pay.id, state: pay.state, refundState: pay.refundState, sandbox: pay.sandbox === 1 } : null,
      location: { name: row.l.name, slug: row.l.slug, timeZone: row.l.timeZone, address: row.l.address },
      brand: { name: row.org.name, slug: row.org.slug },
      cancellable: ['held', 'confirmed'].includes(row.b.status) && row.o.startsAt > new Date(),
      cancellationPolicy: typeof row.l.settings.cancellationPolicy === 'string' ? row.l.settings.cancellationPolicy : null,
    };
  });

  app.get('/public/sites/manage/waitlist/:id', {
    schema: { tags: ['sites'], summary: 'Waitlist place for the customer (requires the manage token from joining)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req) => {
    const [row] = await s.db.select({ w: waitlistEntries, o: classOccurrences, t: classTypes, l: locations, org: organizations }).from(waitlistEntries)
      .innerJoin(classOccurrences, eq(classOccurrences.id, waitlistEntries.occurrenceId))
      .innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId))
      .innerJoin(locations, eq(locations.id, waitlistEntries.locationId))
      .innerJoin(organizations, eq(organizations.id, waitlistEntries.organizationId))
      .where(eq(waitlistEntries.id, req.params.id));
    if (!row || !row.w.manageTokenHash || row.w.manageTokenHash !== sha256(req.query.token)) throw notFound('Waitlist place');
    return {
      id: row.w.id, status: row.w.status, offeredBookingId: row.w.offeredBookingId,
      class: { name: row.t.name, startsAt: row.o.startsAt.toISOString(), endsAt: row.o.endsAt.toISOString(), instructorName: row.o.instructorName },
      location: { name: row.l.name, slug: row.l.slug, timeZone: row.l.timeZone, address: row.l.address },
      brand: { name: row.org.name, slug: row.org.slug },
      canLeave: ['waiting', 'offered'].includes(row.w.status) && row.o.startsAt > new Date(),
    };
  });

  // ── Business-side: theme settings for the hosted site ──
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/sites/settings', { schema: { tags: ['sites'], security: secured, params: orgParams } }, async (req) => {
      const { orgId } = req.params;
      await requirePerm(req, s.db, 'website.edit', { organizationId: orgId, kind: 'organization', id: orgId });
      const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw notFound('Organisation');
      const settings = readSiteSettings(org.settings.site);
      return { settings, theme: themeFrom(settings), fonts: SITE_FONTS, includedAddress: `${base}/${org.slug}` };
    });

    priv.put('/orgs/:orgId/sites/settings', {
      schema: { tags: ['sites'], security: secured, params: orgParams, summary: 'Brand theme for hosted sites (colour, logo, font from a safe list, languages, optional Powered by)', body: siteSettingsSchema },
    }, async (req) => {
      const { orgId } = req.params;
      await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw notFound('Organisation');
      // Merge so the website builder theme (chosen elsewhere) survives a settings save from an older screen.
      const site = { ...((org.settings.site ?? {}) as Record<string, unknown>), ...req.body };
      await s.db.update(organizations).set({ settings: { ...org.settings, site }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'site.settings_updated', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId });
      return { settings: req.body, theme: themeFrom(req.body) };
    });
  });
};
