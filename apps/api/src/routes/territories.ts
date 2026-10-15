import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  TERRITORY_EXCLUSIVITY, TERRITORY_STATUSES, findOverlaps, parsePostcodeList, territoryGeometrySchema, type TerritoryExclusivity, type TerritoryGeometry,
} from '@bh/shared';
import { franchiseTerritories, locations, organizations, ownerGroups } from '../db/schema/index.ts';
import { validationError } from '../lib/errors.ts';
import { renderPdf, type PdfPage } from '../lib/pdf.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { toCsv } from '../services/finance/exports.ts';
import {
  ITEM12_DISCLAIMER, assertNoConflict, canTerritories, derivedStatus, geometryFields, item12Lines, loadTerritory, mapConfig, orgTerritories, refreshDemographics, requireTerritories,
  serializeTerritory, shapeOf, territoryLinks, territorySettings, type Territory,
} from '../services/franchise-dev/territories.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['territories'];
const country = z.string().length(2).transform((s) => s.toUpperCase());
const region = z.string().trim().min(1).max(10).transform((s) => s.toUpperCase().replace(/^[A-Z]{2}-/, ''));

const body = z.object({
  name: z.string().trim().min(1).max(120), country, region: region.nullable().optional(), description: z.string().max(4000).nullable().optional(),
  status: z.enum(TERRITORY_STATUSES).default('available'), exclusivity: z.enum(TERRITORY_EXCLUSIVITY).default('exclusive'), showOnSite: z.boolean().default(true),
  geometry: territoryGeometrySchema.nullable().optional(),
  /** Postcodes as a list, or pasted text (comma / line separated). */
  postcodes: z.array(z.string().max(12)).max(2000).optional(), postcodesText: z.string().max(40_000).optional(),
  masterAgreementId: z.uuid().nullable().optional(), scopeTerritoryId: z.uuid().nullable().optional(),
});

const featureCollection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'), id: z.union([z.string(), z.number()]).optional(),
    geometry: territoryGeometrySchema.nullable(),
    properties: z.record(z.string(), z.unknown()).nullable().default({}),
  })).min(1).max(500),
});

/**
 * Territory map (`/v1/orgs/:orgId/territories`, module `sales.territories`): polygons and postcode territories,
 * overlap and exclusivity checks, status from the pipeline, demographics and scores, Item 12 / CSV / GeoJSON exports
 * and the opt-in public map.
 */
export const territoryRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const listOut = async (orgId: string, rows: Territory[]) => {
    const links = await territoryLinks(db, orgId, rows.map((r) => r.id));
    const groups = await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, orgId));
    const shapes = rows.map(shapeOf);
    return rows.map((t) => serializeTerritory(t, { links: links.get(t.id), overlaps: findOverlaps(shapeOf(t), shapes), ownerGroupName: groups.find((g) => g.id === t.ownerGroupId)?.name ?? null }));
  };

  app.get('/orgs/:orgId/territories', { schema: { tags, security: secured, params: orgParams, summary: 'Territories with geometry, postcodes, status (stored and implied by the pipeline), overlaps, demographics and score' } }, async (req) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'view');
    const rows = (await orgTerritories(db, orgId)).sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const locs = await db.select({ id: locations.id, name: locations.name, geo: locations.geo, status: locations.status }).from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
    return {
      items: await listOut(orgId, rows), settings: territorySettings(org!), map: mapConfig(s.cfg), brandSlug: org!.slug, homeCountry: org!.country,
      locations: locs.filter((l) => l.geo).map((l) => ({ id: l.id, name: l.name, status: l.status, lat: l.geo!.lat, lng: l.geo!.lng })),
      demographics: { census: !!s.cfg.CENSUS_API_KEY },
      can: { edit: await canTerritories(req, db, orgId, 'edit'), publish: await canTerritories(req, db, orgId, 'publish'), export: await canTerritories(req, db, orgId, 'export') },
    };
  });

  app.post('/orgs/:orgId/territories/check', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ id: z.uuid().optional(), geometry: territoryGeometrySchema.nullable().optional(), postcodes: z.array(z.string().max(12)).max(2000).default([]), exclusivity: z.enum(TERRITORY_EXCLUSIVITY).default('exclusive'), status: z.enum(TERRITORY_STATUSES).default('available') }), summary: 'Overlaps of a territory being drawn with the existing ones (conflict = refused by the exclusivity rules)' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'view');
    const all = await orgTerritories(db, orgId);
    const shape = { id: req.body.id ?? 'new', name: '', status: req.body.status, exclusivity: req.body.exclusivity as TerritoryExclusivity, geometry: (req.body.geometry ?? null) as TerritoryGeometry | null, postcodes: parsePostcodeList(req.body.postcodes.join('\n')) };
    return { overlaps: findOverlaps(shape, all.map(shapeOf)) };
  });

  const postcodesOf = (b: { postcodes?: string[]; postcodesText?: string }) => (b.postcodesText !== undefined ? parsePostcodeList(b.postcodesText) : b.postcodes !== undefined ? parsePostcodeList(b.postcodes.join('\n')) : undefined);

  app.post('/orgs/:orgId/territories', { schema: { tags, security: secured, params: orgParams, body, summary: 'Create a territory (drawn polygon and/or postcodes). Refused when it breaks the exclusivity rules.' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const b = req.body;
    const postcodes = postcodesOf(b) ?? [];
    const all = await orgTerritories(db, orgId);
    assertNoConflict({ id: 'new', name: b.name, status: b.status, exclusivity: b.exclusivity, geometry: (b.geometry ?? null) as TerritoryGeometry | null, postcodes }, all);
    const [t] = await db.insert(franchiseTerritories).values({
      organizationId: orgId, name: b.name, country: b.country, region: b.region ?? null, description: b.description ?? null, status: b.status, exclusivity: b.exclusivity, showOnSite: b.showOnSite,
      masterAgreementId: b.masterAgreementId ?? null, scopeTerritoryId: b.scopeTerritoryId ?? null, statusChangedAt: new Date(), ...geometryFields((b.geometry ?? null) as TerritoryGeometry | null, postcodes),
    }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.created', targetType: 'franchise_territory', targetId: t!.id, metadata: { name: b.name, postcodes: postcodes.length, drawn: !!b.geometry }, ip: req.ip });
    return reply.code(201).send((await listOut(orgId, [...all, t!])).find((x) => x.id === t!.id));
  });

  app.get('/orgs/:orgId/territories/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requireTerritories(req, db, orgId, 'view');
    await loadTerritory(db, orgId, id);
    return (await listOut(orgId, await orgTerritories(db, orgId))).find((x) => x.id === id)!;
  });

  app.patch('/orgs/:orgId/territories/:id', { schema: { tags, security: secured, params: idParams, body: body.partial(), summary: 'Change a territory. Exclusivity rules apply to the new shape and status.' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const cur = await loadTerritory(db, orgId, id);
    const b = req.body;
    const postcodes = postcodesOf(b);
    const all = await orgTerritories(db, orgId);
    const next = { ...shapeOf(cur), ...(b.status ? { status: b.status } : {}), ...(b.exclusivity ? { exclusivity: b.exclusivity } : {}), ...(b.geometry !== undefined ? { geometry: (b.geometry ?? null) as TerritoryGeometry | null } : {}), ...(postcodes ? { postcodes } : {}) };
    assertNoConflict(next, all);
    const { postcodesText: _pt, postcodes: _pc, geometry: _g, ...rest } = b;
    const [t] = await db.update(franchiseTerritories).set({
      ...rest, ...geometryFields(b.geometry === undefined ? undefined : ((b.geometry ?? null) as TerritoryGeometry | null), postcodes),
      ...(b.status && b.status !== cur.status ? { statusChangedAt: new Date() } : {}), ...(b.geometry !== undefined || postcodes ? { demographics: null, score: null, scoreParts: null } : {}), updatedAt: new Date(),
    }).where(eq(franchiseTerritories.id, id)).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.updated', targetType: 'franchise_territory', targetId: id, metadata: { changes: Object.keys(b) }, ip: req.ip });
    return (await listOut(orgId, all.map((x) => (x.id === id ? t! : x)))).find((x) => x.id === id);
  });

  app.delete('/orgs/:orgId/territories/:id', { schema: { tags, security: secured, params: idParams, summary: 'Delete a territory that has no deal (no prospect, agreement or open location)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const t = await loadTerritory(db, orgId, id);
    const l = (await territoryLinks(db, orgId, [id])).get(id)!;
    if (l.prospects.length || l.agreement || t.reservedForProspectId || t.ownerGroupId) throw validationError('This territory is part of a deal. Set it to unavailable instead.', { id: 'In use' });
    await db.delete(franchiseTerritories).where(eq(franchiseTerritories.id, id));
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.deleted', targetType: 'franchise_territory', targetId: id, metadata: { name: t.name }, ip: req.ip });
    return reply.code(204).send();
  });

  app.post('/orgs/:orgId/territories/sync-status', { schema: { tags, security: secured, params: orgParams, body: z.object({ ids: z.array(z.uuid()).max(500).optional() }).default({}), summary: 'Apply the status the pipeline and agreements imply (reserved, sold, under development, open)' } }, async (req) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const rows = (await orgTerritories(db, orgId)).filter((t) => !req.body.ids || req.body.ids.includes(t.id));
    const links = await territoryLinks(db, orgId, rows.map((r) => r.id));
    const changed: Array<{ id: string; from: string; to: string }> = [];
    for (const t of rows) {
      const to = derivedStatus(t, links.get(t.id));
      if (to === t.status) continue;
      await db.update(franchiseTerritories).set({ status: to, statusChangedAt: new Date(), ...(links.get(t.id)?.agreement ? { agreementId: links.get(t.id)!.agreement!.id, ownerGroupId: links.get(t.id)!.agreement!.ownerGroupId } : {}), updatedAt: new Date() }).where(eq(franchiseTerritories.id, t.id));
      changed.push({ id: t.id, from: t.status, to });
    }
    if (changed.length) await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.status_synced', metadata: { changed }, ip: req.ip });
    return { changed };
  });

  app.post('/orgs/:orgId/territories/:id/demographics', { schema: { tags, security: secured, params: idParams, summary: 'Fetch demographics (US Census ACS when configured, sandbox otherwise) and recompute the score' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const t = await loadTerritory(db, orgId, id);
    const { territory, performance } = await refreshDemographics(s, t);
    return { ...(await listOut(orgId, (await orgTerritories(db, orgId)).map((x) => (x.id === id ? territory : x)))).find((x) => x.id === id), performance };
  });

  app.put('/orgs/:orgId/territories/settings', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ publicMap: z.boolean().optional(), showTaken: z.boolean().optional(), targets: z.object({ population: z.number().int().min(1000).max(50_000_000), households: z.number().int().min(100).max(20_000_000), incomeMinor: z.number().int().min(1).max(10_000_000_000) }).optional() }), summary: 'Public map opt-in (publish) and scoring targets (edit)' },
  }, async (req) => {
    const { orgId } = req.params;
    const b = req.body;
    await requireTerritories(req, db, orgId, b.publicMap !== undefined || b.showTaken !== undefined ? 'publish' : 'edit');
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const fr = (org!.settings.franchise ?? {}) as Record<string, unknown>;
    const cur = territorySettings(org!);
    const next = { ...cur, ...b, targets: b.targets ?? cur.targets };
    await db.update(organizations).set({ settings: { ...org!.settings, franchise: { ...fr, territoryMap: next } }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.settings_updated', metadata: b, ip: req.ip });
    return next;
  });

  /* ------------------------------- exports ------------------------------- */

  app.get('/orgs/:orgId/territories/export.geojson', { schema: { tags, security: secured, params: orgParams, summary: 'All territories as a GeoJSON FeatureCollection (postcode-only territories have a null geometry)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'export');
    const rows = await orgTerritories(db, orgId);
    const fc = { type: 'FeatureCollection', features: rows.map((t) => ({ type: 'Feature', id: t.id, geometry: t.geometry ?? null, properties: { name: t.name, country: t.country, region: t.region, status: t.status, exclusivity: t.exclusivity, postcodes: t.postcodes, description: t.description, score: t.score, population: t.demographics?.population ?? null } })) };
    return reply.header('content-type', 'application/geo+json').header('content-disposition', 'attachment; filename="territories.geojson"').send(JSON.stringify(fc));
  });

  app.post('/orgs/:orgId/territories/import', {
    bodyLimit: 10 * 1024 * 1024,
    schema: { tags, security: secured, params: orgParams, body: z.object({ data: featureCollection, country: country.optional(), mode: z.enum(['create', 'upsert']).default('upsert') }), summary: 'Import a GeoJSON FeatureCollection: one territory per feature (properties.name, country, region, postcodes, status, exclusivity). Matching names are updated with mode upsert.' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'edit');
    const all = await orgTerritories(db, orgId);
    const created: string[] = [];
    const updated: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const [i, f] of req.body.data.features.entries()) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      const name = String(p.name ?? p.NAME ?? `Territory ${i + 1}`).slice(0, 120);
      const ctry = String(p.country ?? req.body.country ?? '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(ctry)) { skipped.push({ name, reason: 'country_missing' }); continue; }
      const postcodes = Array.isArray(p.postcodes) ? parsePostcodeList((p.postcodes as unknown[]).map(String).join('\n')) : typeof p.postcodes === 'string' ? parsePostcodeList(p.postcodes) : [];
      if (!f.geometry && !postcodes.length) { skipped.push({ name, reason: 'no_area' }); continue; }
      const exclusivity = (TERRITORY_EXCLUSIVITY as readonly string[]).includes(String(p.exclusivity)) ? (p.exclusivity as TerritoryExclusivity) : 'exclusive';
      const status = (TERRITORY_STATUSES as readonly string[]).includes(String(p.status)) ? String(p.status) : 'available';
      const existing = req.body.mode === 'upsert' ? all.find((t) => t.name.toLowerCase() === name.toLowerCase()) : undefined;
      const shape = { id: existing?.id ?? `import-${i}`, name, status: existing?.status ?? status, exclusivity, geometry: (f.geometry ?? null) as TerritoryGeometry | null, postcodes };
      if (findOverlaps(shape, all.map(shapeOf)).some((o) => o.conflict)) { skipped.push({ name, reason: 'territory_overlap' }); continue; }
      const fields = { ...geometryFields((f.geometry ?? null) as TerritoryGeometry | null, postcodes), exclusivity, region: p.region ? String(p.region).toUpperCase().replace(/^[A-Z]{2}-/, '').slice(0, 10) : null, description: p.description ? String(p.description).slice(0, 4000) : null };
      if (existing) {
        const [t] = await db.update(franchiseTerritories).set({ ...fields, demographics: null, score: null, scoreParts: null, updatedAt: new Date() }).where(eq(franchiseTerritories.id, existing.id)).returning();
        all.splice(all.indexOf(existing), 1, t!);
        updated.push(t!.id);
      } else {
        const [t] = await db.insert(franchiseTerritories).values({ organizationId: orgId, name, country: ctry, status, statusChangedAt: new Date(), ...fields }).returning();
        all.push(t!);
        created.push(t!.id);
      }
    }
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'territory.imported', metadata: { created: created.length, updated: updated.length, skipped: skipped.length }, ip: req.ip });
    return { created: created.length, updated: updated.length, skipped };
  });

  app.get('/orgs/:orgId/territories/item12.csv', { schema: { tags, security: secured, params: orgParams, summary: 'Item 12-style territory descriptions for all territories (CSV)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireTerritories(req, db, orgId, 'export');
    const rows = (await orgTerritories(db, orgId)).sort((a, b) => a.name.localeCompare(b.name));
    const csv = toCsv(['Territory', 'Jurisdiction', 'Status', 'Exclusivity', 'Area', 'Boundaries', 'Postcodes', 'Population', 'Score', 'Description'], rows.map((t) => {
      const l = item12Lines(t);
      return [l.name, l.jurisdiction, t.status, l.exclusivity, l.area ?? '', l.bounds ?? '', t.postcodes.join(' '), t.demographics?.population ?? '', t.score ?? '', t.description ?? ''];
    }));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="territories-item12.csv"').send(csv);
  });

  app.get('/orgs/:orgId/territories/:id/item12.pdf', { schema: { tags, security: secured, params: idParams, summary: 'Item 12-style territory description with the outline of the drawn area (PDF)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireTerritories(req, db, orgId, 'export');
    const t = await loadTerritory(db, orgId, id);
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const pdf = renderPdf([item12Page(org!.name, t)], { title: `${t.name} territory description` });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="territory-${t.name.replace(/[^\w-]+/g, '-').toLowerCase()}.pdf"`).send(pdf);
  });
};

/** Wraps text to lines of about `n` characters. */
function wrap(text: string, n = 92): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      if ((line + ' ' + w).trim().length > n) { out.push(line.trim()); line = w; } else line += ` ${w}`;
    }
    out.push(line.trim());
  }
  return out;
}

function item12Page(brand: string, t: Territory): PdfPage {
  const l = item12Lines(t);
  const texts: PdfPage['texts'] = [];
  const lines: NonNullable<PdfPage['lines']> = [];
  let y = 800;
  const put = (s: string, o: { size?: number; bold?: boolean; gap?: number } = {}) => { for (const w of wrap(s, o.size && o.size > 11 ? 70 : 95)) { texts.push({ x: 50, y, text: w, size: o.size ?? 10, bold: o.bold }); y -= (o.size ?? 10) + 4; } y -= o.gap ?? 4; };
  put(`${brand}: territory description`, { size: 16, bold: true });
  put('Item 12 (Territory) drafting aid', { size: 11, gap: 10 });
  put(`Territory: ${l.name} (${l.jurisdiction})`, { bold: true });
  put(l.exclusivity, { gap: 8 });
  if (l.area) put(l.area);
  if (l.bounds) put(l.bounds);
  if (l.postcodes) put(l.postcodes);
  if (l.population) put(l.population);
  if (l.description) put(l.description, { gap: 8 });
  // Outline of the drawn area, fitted into a box under the text.
  if (t.geometry) {
    const polys = t.geometry.type === 'Polygon' ? [t.geometry.coordinates] : t.geometry.coordinates;
    const pts = polys.flatMap((p) => p.flat());
    const [minX, maxX, minY, maxY] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    const box = { x: 50, y: Math.max(120, y - 300), w: 495, h: Math.min(280, y - 140) };
    const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
    const scale = Math.min(box.w / Math.max(1e-9, (maxX - minX) * k), box.h / Math.max(1e-9, maxY - minY));
    const px = (p: [number, number]) => [box.x + (p[0] - minX) * k * scale, box.y + (p[1] - minY) * scale] as const;
    for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = px(ring[i]!);
      const [x2, y2] = px(ring[i + 1]!);
      lines.push({ x1: Math.round(x1 * 10) / 10, y1: Math.round(y1 * 10) / 10, x2: Math.round(x2 * 10) / 10, y2: Math.round(y2 * 10) / 10 });
    }
    y = box.y - 20;
  }
  for (const w of wrap(ITEM12_DISCLAIMER, 100)) { texts.push({ x: 50, y: Math.min(y, 90), text: w, size: 8 }); y -= 11; }
  return { texts, lines };
}

/** Public: the brand's available territories on a map (opt-in, HQ publish). Only names, shapes and availability. */
export const territoryPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.get('/public/franchise/:brand/territories-map', { schema: { tags: ['public', 'franchise'], params: z.object({ brand: z.string().min(1).max(80) }), summary: 'Available territories map (only when the franchisor opted in)' } }, async (req) => {
    const [org] = await s.db.select().from(organizations).where(eq(organizations.slug, req.params.brand));
    if (!org || org.status !== 'active' || org.deletedAt || org.model !== 'network') return { enabled: false as const };
    const st = territorySettings(org);
    if (!st.publicMap) return { enabled: false as const };
    const rows = await s.db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.organizationId, org.id), eq(franchiseTerritories.showOnSite, true))).orderBy(asc(franchiseTerritories.name));
    const visible = rows.filter((t) => t.status !== 'unavailable' && (t.status === 'available' || st.showTaken));
    return {
      enabled: true as const, brand: { name: org.name }, map: mapConfig(s.cfg),
      territories: { type: 'FeatureCollection' as const, features: visible.map((t) => ({ type: 'Feature' as const, id: t.id, geometry: t.geometry ?? null, properties: { id: t.id, name: t.name, country: t.country, region: t.region, availability: t.status === 'available' ? 'available' : 'taken', centroid: t.centroid ?? null, postcodes: t.postcodes.length <= 30 ? t.postcodes : t.postcodes.slice(0, 30) } })) },
    };
  });
};

