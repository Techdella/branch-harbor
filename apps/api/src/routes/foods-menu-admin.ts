/**
 * Foods menu builder (HQ) and per-location menu operations: categories, items, modifier groups with
 * min/max, business-supplied allergens/dietary labels, per-locale text, day-parts, publish preview and
 * per-location results, modifier sold-out (with auto-reset at close) and location ordering settings.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ALLERGEN_LABELS, ALLERGEN_REGIMES, DIETARY_LABELS, FOOD_ALLERGENS, FOOD_CHANNELS, currency, defaultAllergenRegime,
} from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  foodDayParts, foodLocationSettings, foodMenuCategories, locationMenuOverrides, locations, menuItems, menus, modifierGroups, modifiers,
} from '../db/schema/index.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { cleanAllergens, cleanDietary, loadFoodConfig, mergeFoodConfig, recordSoldOut, regimeFor, soldOutUntilClose } from '../services/foods-menu.ts';
import { latestPublications, previewPublish, publishMenu } from '../services/foods-publish.ts';
import { effectiveMenu } from '../services/foods.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const prices = z.partialRecord(currency, z.number().int().min(0));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const translations = z.record(z.string().min(2).max(10), z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() }));
const windows = z.array(z.object({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).max(50);
const locParams = orgParams.extend({ locationId: z.uuid() });

const configSchema = z.object({
  channels: z.object({ pickup: z.boolean(), delivery: z.boolean(), dineIn: z.boolean(), preorder: z.boolean(), catering: z.boolean(), mealPlans: z.boolean() }).partial().optional(),
  tips: z.object({ enabled: z.boolean(), presetsBps: z.array(z.number().int().min(0).max(5000)).max(5), allowCustom: z.boolean(), channels: z.array(z.enum(FOOD_CHANNELS)) }).partial().optional(),
  serviceCharge: z.object({ bps: z.number().int().min(0).max(3000), label: z.string().min(1).max(60), channels: z.array(z.enum(FOOD_CHANNELS)) }).partial().optional(),
  allergenRegime: z.enum(['eu14', 'us9', 'ca']).nullable().optional(),
  delivery: z.object({
    provider: z.enum(['own', 'uber_direct', 'deliverect']), hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), open: hhmm, close: hhmm })).max(50),
    slotMinutes: z.number().int().min(10).max(120), slotCapacity: z.number().int().min(1).max(200), leadMinutes: z.number().int().min(0).max(600), cutoffMinutes: z.number().int().min(0).max(600), horizonDays: z.number().int().min(1).max(14),
  }).partial().optional(),
  kds: z.object({ audibleDefault: z.boolean(), defaultPrepMinutes: z.number().int().min(1).max(240) }).partial().optional(),
  autoSoldOutOnIngredients: z.boolean().optional(),
  /** Business-configured sales tax/VAT rate for the location (basis points); null removes it. Never assumed. */
  taxRateBps: z.number().int().min(0).max(5000).nullable().optional(),
  /** Location coordinates for radius delivery zones (when geocoding is not configured). */
  coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
});

export const foodMenuAdminRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  const hq = (req: Parameters<typeof requirePerm>[0], orgId: string) => requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });

  const itemOf = async (orgId: string, id: string) => {
    const [it] = await s.db.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.organizationId, orgId)));
    if (!it) throw notFound('Menu item');
    return it;
  };
  const groupOf = async (orgId: string, id: string) => {
    const [g] = await s.db.select().from(modifierGroups).where(and(eq(modifierGroups.id, id), eq(modifierGroups.organizationId, orgId)));
    if (!g) throw notFound('Modifier group');
    return g;
  };
  const checkDayParts = async (orgId: string, ids: string[] | undefined) => {
    if (!ids?.length) return;
    const rows = await s.db.select({ id: foodDayParts.id }).from(foodDayParts).where(and(eq(foodDayParts.organizationId, orgId), inArray(foodDayParts.id, ids)));
    if (rows.length !== new Set(ids).size) throw validationError('Unknown day-part', { dayPartIds: 'Unknown day-part' });
  };

  app.get('/orgs/:orgId/foods/vocabulary', { schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Allergen conventions (EU 14, US major allergens, Canada priority allergens) and dietary labels the business can choose from' } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return {
      allergens: FOOD_ALLERGENS.map((k) => ({ key: k, label: ALLERGEN_LABELS[k] })),
      regimes: Object.entries(ALLERGEN_REGIMES).map(([key, list]) => ({ key, allergens: list, label: key === 'eu14' ? 'EU/UK 14 allergens' : key === 'us9' ? 'US major food allergens' : 'Canada priority allergens' })),
      dietary: DIETARY_LABELS, channels: FOOD_CHANNELS,
      note: 'Labels are only ever what the business declares. BranchHarbor never infers allergens or dietary suitability.',
    };
  });

  // ───────── Builder snapshot ─────────
  app.get('/orgs/:orgId/foods/builder', { schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Everything the menu builder needs: menus, categories, items, modifier groups, day-parts and latest publish result per location' } }, async (req) => {
    const { orgId } = req.params;
    await authorisedLocations(req, s.db, orgId, 'operations.read');
    const ms = await s.db.select().from(menus).where(eq(menus.organizationId, orgId)).orderBy(asc(menus.createdAt));
    const ids = ms.map((m) => m.id);
    const [cats, items, parts, locs] = await Promise.all([
      ids.length ? s.db.select().from(foodMenuCategories).where(inArray(foodMenuCategories.menuId, ids)).orderBy(asc(foodMenuCategories.sortOrder)) : [],
      ids.length ? s.db.select().from(menuItems).where(inArray(menuItems.menuId, ids)).orderBy(asc(menuItems.sortOrder)) : [],
      s.db.select().from(foodDayParts).where(eq(foodDayParts.organizationId, orgId)).orderBy(asc(foodDayParts.sortOrder)),
      s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))),
    ]);
    const groups = items.length ? await s.db.select().from(modifierGroups).where(inArray(modifierGroups.menuItemId, items.map((i) => i.id))).orderBy(asc(modifierGroups.sortOrder)) : [];
    const mods = groups.length ? await s.db.select().from(modifiers).where(inArray(modifiers.groupId, groups.map((g) => g.id))).orderBy(asc(modifiers.sortOrder)) : [];
    const pubs = await latestPublications(s.db, ids);
    return {
      menus: ms.map((m) => ({
        ...m, publishedAt: m.publishedAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
        categories: cats.filter((c) => c.menuId === m.id),
        items: items.filter((i) => i.menuId === m.id).map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), modifierGroups: groups.filter((g) => g.menuItemId === i.id).map((g) => ({ ...g, modifiers: mods.filter((x) => x.groupId === g.id) })) })),
        publications: pubs.filter((p) => p.menuId === m.id),
      })),
      dayParts: parts,
      locations: locs.map((l) => ({ id: l.id, name: l.name, currency: l.currency, country: l.country, timeZone: l.timeZone, status: l.status, defaultAllergenRegime: defaultAllergenRegime(l.country) })),
    };
  });

  // ───────── Menus & categories ─────────
  app.patch('/orgs/:orgId/foods/menus/:id', {
    schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(1000).nullable().optional(), kind: z.enum(['standard', 'preorder', 'catering']).optional(), dayPartIds: z.array(z.uuid()).optional(), status: z.enum(['draft', 'archived']).optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await checkDayParts(orgId, req.body.dayPartIds);
    const [m] = await s.db.update(menus).set(req.body).where(and(eq(menus.id, id), eq(menus.organizationId, orgId))).returning();
    if (!m) throw notFound('Menu');
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu.updated', targetType: 'menu', targetId: id, metadata: req.body });
    return m;
  });

  app.post('/orgs/:orgId/foods/menus/:id/categories', {
    schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), translations: translations.default({}), dayPartIds: z.array(z.uuid()).default([]), sortOrder: z.number().int().default(0) }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const [m] = await s.db.select().from(menus).where(and(eq(menus.id, id), eq(menus.organizationId, orgId)));
    if (!m) throw notFound('Menu');
    await checkDayParts(orgId, req.body.dayPartIds);
    const [c] = await s.db.insert(foodMenuCategories).values({ organizationId: orgId, menuId: id, ...req.body, description: req.body.description ?? null }).onConflictDoNothing().returning();
    if (!c) throw conflict('duplicate', 'A category with this name already exists on the menu');
    return reply.code(201).send(c);
  });

  app.patch('/orgs/:orgId/foods/categories/:id', {
    schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), translations: translations.optional(), dayPartIds: z.array(z.uuid()).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await checkDayParts(orgId, req.body.dayPartIds);
    const [c] = await s.db.update(foodMenuCategories).set(req.body).where(and(eq(foodMenuCategories.id, id), eq(foodMenuCategories.organizationId, orgId))).returning();
    if (!c) throw notFound('Category');
    if (req.body.name) await s.db.update(menuItems).set({ category: req.body.name }).where(eq(menuItems.categoryId, id));
    return c;
  });

  app.delete('/orgs/:orgId/foods/categories/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const [used] = await s.db.select({ id: menuItems.id }).from(menuItems).where(and(eq(menuItems.categoryId, id), eq(menuItems.active, true))).limit(1);
    if (used) throw conflict('category_not_empty', 'Move or archive the items in this category first');
    const [c] = await s.db.delete(foodMenuCategories).where(and(eq(foodMenuCategories.id, id), eq(foodMenuCategories.organizationId, orgId))).returning();
    if (!c) throw notFound('Category');
    return { deleted: true };
  });

  // ───────── Items ─────────
  app.patch('/orgs/:orgId/foods/items/:id', {
    schema: {
      tags: ['foods'], security: secured, params: idParams, summary: 'Edit an HQ menu item. Allergens/dietary labels must come from the business (controlled vocabulary).',
      body: z.object({
        name: z.string().min(1).max(200).optional(), description: z.string().max(2000).nullable().optional(), categoryId: z.uuid().nullable().optional(), category: z.string().min(1).max(80).optional(),
        prices: prices.optional(), dietary: z.array(z.string()).optional(), allergens: z.array(z.string()).optional(), allergensDeclared: z.boolean().optional(),
        translations: translations.optional(), dayPartIds: z.array(z.uuid()).optional(), stationKey: z.string().max(40).nullable().optional(), prepMinutes: z.number().int().min(0).max(240).nullable().optional(),
        imageUrl: z.url().nullable().optional(), images: z.array(z.url()).max(10).optional(), localOverridable: z.array(z.enum(['price', 'available', 'description'])).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional(),
      }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const it = await itemOf(orgId, id);
    const b = req.body;
    await checkDayParts(orgId, b.dayPartIds);
    const patch: Partial<typeof menuItems.$inferInsert> = { ...b };
    if (b.allergens) { patch.allergens = cleanAllergens(b.allergens); patch.allergensDeclared = b.allergensDeclared ?? true; }
    if (b.dietary) patch.dietary = cleanDietary(b.dietary);
    if (b.categoryId) {
      const [c] = await s.db.select().from(foodMenuCategories).where(and(eq(foodMenuCategories.id, b.categoryId), eq(foodMenuCategories.menuId, it.menuId)));
      if (!c) throw validationError('Unknown category for this menu', { categoryId: 'Unknown category' });
      patch.category = c.name;
    }
    const [u] = await s.db.update(menuItems).set(patch).where(eq(menuItems.id, id)).returning();
    const sensitive = ['allergens', 'dietary', 'prices', 'allergensDeclared'].filter((k) => k in b);
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu_item.updated', targetType: 'menu_item', targetId: id, metadata: { fields: Object.keys(b), sensitive, before: Object.fromEntries(sensitive.map((k) => [k, (it as Record<string, unknown>)[k]])) } });
    return u;
  });

  app.delete('/orgs/:orgId/foods/items/:id', { schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Archive an item (kept for order history)' } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await itemOf(orgId, id);
    await s.db.update(menuItems).set({ active: false }).where(eq(menuItems.id, id));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu_item.archived', targetType: 'menu_item', targetId: id });
    return { archived: true };
  });

  // ───────── Modifier groups & modifiers ─────────
  const groupBody = z.object({ name: z.string().min(1).max(80), minSelect: z.number().int().min(0).max(20).default(0), maxSelect: z.number().int().min(1).max(20).default(1), translations: z.record(z.string(), z.object({ name: z.string().max(120).optional() })).default({}) });
  const modBody = z.object({ name: z.string().min(1).max(120), prices: prices.default({}), allergens: z.array(z.string()).default([]), translations: z.record(z.string(), z.object({ name: z.string().max(120).optional() })).default({}), available: z.boolean().default(true) });

  app.post('/orgs/:orgId/foods/items/:id/modifier-groups', {
    schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Add a modifier group (required when minSelect ≥ 1)', body: groupBody.extend({ modifiers: z.array(modBody).min(1).max(40) }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await itemOf(orgId, id);
    const b = req.body;
    if (b.minSelect > b.maxSelect) throw validationError('Minimum cannot exceed maximum', { minSelect: 'Cannot exceed maximum' });
    if (b.minSelect > b.modifiers.length) throw validationError('Minimum is more than the number of options', { minSelect: 'Too many required' });
    const r = await s.db.transaction(async (tx) => {
      const existing = await tx.select({ id: modifierGroups.id }).from(modifierGroups).where(eq(modifierGroups.menuItemId, id));
      const [g] = await tx.insert(modifierGroups).values({ organizationId: orgId, menuItemId: id, name: b.name, minSelect: b.minSelect, maxSelect: b.maxSelect, translations: b.translations, sortOrder: existing.length }).returning();
      const ms = await tx.insert(modifiers).values(b.modifiers.map((m, i) => ({ organizationId: orgId, groupId: g!.id, name: m.name, prices: m.prices, allergens: cleanAllergens(m.allergens), translations: m.translations, available: m.available, sortOrder: i }))).returning();
      return { ...g!, modifiers: ms };
    });
    return reply.code(201).send(r);
  });

  app.patch('/orgs/:orgId/foods/modifier-groups/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: groupBody.partial().extend({ sortOrder: z.number().int().optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const g = await groupOf(orgId, id);
    const min = req.body.minSelect ?? g.minSelect;
    const max = req.body.maxSelect ?? g.maxSelect;
    if (min > max) throw validationError('Minimum cannot exceed maximum', { minSelect: 'Cannot exceed maximum' });
    const [u] = await s.db.update(modifierGroups).set(req.body).where(eq(modifierGroups.id, id)).returning();
    return u;
  });

  app.delete('/orgs/:orgId/foods/modifier-groups/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await groupOf(orgId, id);
    await s.db.delete(modifierGroups).where(eq(modifierGroups.id, id));
    return { deleted: true };
  });

  app.post('/orgs/:orgId/foods/modifier-groups/:id/modifiers', { schema: { tags: ['foods'], security: secured, params: idParams, body: modBody } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    await groupOf(orgId, id);
    const n = await s.db.select({ id: modifiers.id }).from(modifiers).where(eq(modifiers.groupId, id));
    const [m] = await s.db.insert(modifiers).values({ organizationId: orgId, groupId: id, ...req.body, allergens: cleanAllergens(req.body.allergens), sortOrder: n.length }).returning();
    return reply.code(201).send(m);
  });

  app.patch('/orgs/:orgId/foods/modifiers/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: modBody.partial().extend({ sortOrder: z.number().int().optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const patch = { ...req.body, ...(req.body.allergens ? { allergens: cleanAllergens(req.body.allergens) } : {}) };
    const [m] = await s.db.update(modifiers).set(patch).where(and(eq(modifiers.id, id), eq(modifiers.organizationId, orgId))).returning();
    if (!m) throw notFound('Modifier');
    return m;
  });

  app.delete('/orgs/:orgId/foods/modifiers/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const [m] = await s.db.select().from(modifiers).where(and(eq(modifiers.id, id), eq(modifiers.organizationId, orgId)));
    if (!m) throw notFound('Modifier');
    const g = await groupOf(orgId, m.groupId);
    const left = await s.db.select({ id: modifiers.id }).from(modifiers).where(eq(modifiers.groupId, g.id));
    if (left.length - 1 < g.minSelect) throw conflict('group_needs_options', `"${g.name}" requires at least ${g.minSelect} option(s)`);
    await s.db.delete(modifiers).where(eq(modifiers.id, id));
    return { deleted: true };
  });

  // ───────── Day-parts ─────────
  app.get('/orgs/:orgId/foods/day-parts', { schema: { tags: ['foods'], security: secured, params: orgParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return { items: await s.db.select().from(foodDayParts).where(eq(foodDayParts.organizationId, req.params.orgId)).orderBy(asc(foodDayParts.sortOrder)) };
  });
  app.post('/orgs/:orgId/foods/day-parts', {
    schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Day-part (e.g. Breakfast) with weekly windows in each location\'s local time', body: z.object({ name: z.string().min(1).max(60), translations: translations.default({}), windows: windows.min(1), sortOrder: z.number().int().default(0) }) },
  }, async (req, reply) => {
    await hq(req, req.params.orgId);
    const [d] = await s.db.insert(foodDayParts).values({ organizationId: req.params.orgId, ...req.body }).onConflictDoNothing().returning();
    if (!d) throw conflict('duplicate', 'A day-part with this name already exists');
    return reply.code(201).send(d);
  });
  app.patch('/orgs/:orgId/foods/day-parts/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(60).optional(), translations: translations.optional(), windows: windows.min(1).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }) } }, async (req) => {
    await hq(req, req.params.orgId);
    const [d] = await s.db.update(foodDayParts).set(req.body).where(and(eq(foodDayParts.id, req.params.id), eq(foodDayParts.organizationId, req.params.orgId))).returning();
    if (!d) throw notFound('Day-part');
    return d;
  });
  app.delete('/orgs/:orgId/foods/day-parts/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    await hq(req, req.params.orgId);
    const { orgId, id } = req.params;
    const [d] = await s.db.delete(foodDayParts).where(and(eq(foodDayParts.id, id), eq(foodDayParts.organizationId, orgId))).returning();
    if (!d) throw notFound('Day-part');
    // Remove references so nothing points at a deleted window.
    for (const tbl of [menus, menuItems, foodMenuCategories] as const) {
      const rows = await s.db.select({ id: tbl.id, dayPartIds: tbl.dayPartIds }).from(tbl).where(eq(tbl.organizationId, orgId));
      for (const r of rows.filter((x) => x.dayPartIds.includes(id))) await s.db.update(tbl).set({ dayPartIds: r.dayPartIds.filter((x) => x !== id) }).where(eq(tbl.id, r.id));
    }
    return { deleted: true };
  });

  // ───────── Publish preview / retry ─────────
  app.get('/orgs/:orgId/foods/menus/:id/publish-preview', { schema: { tags: ['foods'], security: secured, params: idParams, summary: 'What publishing would do at each location (sellable items, unsellable reasons) — nothing changes' } }, async (req) => {
    await hq(req, req.params.orgId);
    return previewPublish(s, req.params.orgId, req.params.id);
  });
  app.post('/orgs/:orgId/foods/menus/:id/publish/retry', { schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Re-run the publish for locations whose latest result failed' } }, async (req) => {
    await hq(req, req.params.orgId);
    const r = await publishMenu(s, req.params.orgId, req.params.id, { onlyFailed: true, actorUserId: req.user!.id });
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'menu.publish_retried', targetType: 'menu', targetId: req.params.id, metadata: r.summary });
    return r;
  });

  // ───────── Location sold-out ─────────
  app.put('/orgs/:orgId/foods/locations/:locationId/modifiers/:modifierId/sold-out', {
    schema: { tags: ['foods'], security: secured, params: locParams.extend({ modifierId: z.uuid() }), summary: 'Mark a modifier option sold out at a location (until close by default — resets automatically)', body: z.object({ soldOut: z.boolean(), untilClose: z.boolean().default(true), until: isoDateTime.nullable().optional() }) },
  }, async (req) => {
    const { orgId, locationId, modifierId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [m] = await s.db.select({ mod: modifiers, group: modifierGroups }).from(modifiers).innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId)).where(and(eq(modifiers.id, modifierId), eq(modifiers.organizationId, orgId)));
    if (!m) throw notFound('Modifier');
    const until = !req.body.soldOut ? null : req.body.until !== undefined ? (req.body.until ? new Date(req.body.until) : null) : req.body.untilClose ? await soldOutUntilClose(s.db, loc) : null;
    const values = { organizationId: orgId, locationId, menuItemId: m.group.menuItemId, modifierId, soldOut: req.body.soldOut, soldOutUntil: until, updatedBy: req.user!.id, updatedAt: new Date() };
    const [row] = await s.db.insert(locationMenuOverrides).values(values).onConflictDoUpdate({ target: [locationMenuOverrides.locationId, locationMenuOverrides.menuItemId, locationMenuOverrides.modifierId], set: values }).returning();
    await recordSoldOut(s.db, { organizationId: orgId, locationId, menuItemId: m.group.menuItemId, modifierId, soldOut: req.body.soldOut, until, source: 'manual', by: req.user!.id });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: req.body.soldOut ? 'menu.modifier_sold_out' : 'menu.modifier_back', scopeKind: 'location', scopeId: locationId, targetType: 'modifier', targetId: modifierId, metadata: { until: until?.toISOString() ?? null } });
    return { ...row, soldOutUntil: row!.soldOutUntil?.toISOString() ?? null };
  });

  app.get('/orgs/:orgId/foods/locations/:locationId/sold-out', { schema: { tags: ['foods'], security: secured, params: locParams, summary: 'What is sold out now at a location (manual or ingredient-driven) and until when' } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const items = await effectiveMenu(s.db, req.params.orgId, loc, { kinds: ['standard', 'preorder'] });
    return {
      items: items.filter((i) => i.unavailableCode === 'sold_out').map((i) => ({ id: i.id, name: i.name, source: i.soldOutSource, until: i.soldOutUntil })),
      modifiers: items.flatMap((i) => i.modifierGroups.flatMap((g) => g.modifiers.filter((m) => m.soldOut).map((m) => ({ id: m.id, name: m.name, itemId: i.id, itemName: i.name, group: g.name })))),
    };
  });

  // ───────── Location ordering settings ─────────
  app.get('/orgs/:orgId/foods/settings', { schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Ordering settings (channels, tips, service charge, allergen convention, delivery hours, KDS) per authorised location' } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const locs = (await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)))).filter((l) => allowed === 'all' || allowed.has(l.id));
    const rows = locs.length ? await s.db.select().from(foodLocationSettings).where(inArray(foodLocationSettings.locationId, locs.map((l) => l.id))) : [];
    return { items: locs.map((l) => { const cfg = mergeFoodConfig(rows.find((r) => r.locationId === l.id)?.config); return { locationId: l.id, name: l.name, currency: l.currency, country: l.country, timeZone: l.timeZone, taxRateBps: typeof l.settings.taxRateBps === 'number' ? l.settings.taxRateBps : null, config: cfg, allergenRegime: regimeFor(l, cfg) }; }) };
  });

  app.get('/orgs/:orgId/foods/locations/:locationId/settings', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const cfg = await loadFoodConfig(s.db, loc.id);
    return { locationId: loc.id, config: cfg, allergenRegime: regimeFor(loc, cfg), taxRateBps: typeof loc.settings.taxRateBps === 'number' ? loc.settings.taxRateBps : null };
  });

  app.put('/orgs/:orgId/foods/locations/:locationId/settings', {
    schema: { tags: ['foods'], security: secured, params: locParams, summary: 'Update ordering settings (partial). Tax rates are configured on the location by the business; none is assumed.', body: configSchema },
  }, async (req) => {
    const { orgId, locationId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const cur = await loadFoodConfig(s.db, loc.id);
    const b = req.body;
    const next = mergeFoodConfig({
      ...cur, channels: { ...cur.channels, ...(b.channels ?? {}) }, tips: { ...cur.tips, ...(b.tips ?? {}) }, serviceCharge: { ...cur.serviceCharge, ...(b.serviceCharge ?? {}) },
      allergenRegime: b.allergenRegime === undefined ? cur.allergenRegime : b.allergenRegime, delivery: { ...cur.delivery, ...(b.delivery ?? {}) }, kds: { ...cur.kds, ...(b.kds ?? {}) },
      autoSoldOutOnIngredients: b.autoSoldOutOnIngredients ?? cur.autoSoldOutOnIngredients,
    });
    if (next.tips.presetsBps.some((x) => x > 5000)) throw new AppError(400, 'validation_failed', 'Tip presets above 50% are not allowed');
    await s.db.insert(foodLocationSettings).values({ organizationId: orgId, locationId, config: next, updatedBy: req.user!.id })
      .onConflictDoUpdate({ target: foodLocationSettings.locationId, set: { config: next, updatedBy: req.user!.id, updatedAt: new Date() } });
    if (b.taxRateBps !== undefined || b.coordinates !== undefined) {
      const settings = { ...loc.settings };
      if (b.taxRateBps === null) delete settings.taxRateBps;
      else if (b.taxRateBps !== undefined) settings.taxRateBps = b.taxRateBps;
      await s.db.update(locations).set({ settings, ...(b.coordinates !== undefined ? { geo: b.coordinates } : {}), updatedAt: new Date() }).where(eq(locations.id, locationId));
      loc.settings = settings;
    }
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'food_settings.updated', scopeKind: 'location', scopeId: locationId, targetType: 'location', targetId: locationId, metadata: { fields: Object.keys(b) } });
    return { locationId, config: next, allergenRegime: regimeFor(loc, next), taxRateBps: typeof loc.settings.taxRateBps === 'number' ? loc.settings.taxRateBps : null };
  });
};
