import { and, asc, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { foodOrderCreateSchema, foodOrderStatesAll, FOOD_CHANNELS, currency } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { foodOrders, locationMenuOverrides, locations, menuItems, menus, modifierGroups, modifiers, pickupSlots } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, notFound, validationError } from '../lib/errors.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { createFoodOrder, effectiveMenu, serializeFoodOrder, transitionFoodOrder } from '../services/foods.ts';
import { cleanAllergens, cleanDietary, loadFoodConfig, recordSoldOut, regimeFor, soldOutUntilClose } from '../services/foods-menu.ts';
import { KITCHEN_PAYMENT_STATES } from '../services/foods-kitchen.ts';
import { publishMenu } from '../services/foods-publish.ts';
import { ACTIVE_FOOD_STATES } from '../domain/foodOrderState.ts';
import { configOf, ensurePickupSlots, loadPickupSettings } from '../services/pickup.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const prices = z.partialRecord(currency, z.number().int().min(0));

export const foodRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  // ───────── Public ─────────
  app.get('/public/foods/:locationId/menu', {
    schema: {
      tags: ['foods'], summary: 'Location menu: HQ items with local prices/availability at a time (day-parts in the location time zone). Allergen and dietary info is business-supplied.',
      params: z.object({ locationId: z.uuid() }),
      querystring: z.object({ at: isoDateTime.optional().describe('Pickup/delivery/collection time; default now'), lang: z.string().max(10).optional(), kind: z.enum(['standard', 'preorder']).default('standard'), menuId: z.uuid().optional() }),
    },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const at = req.query.at ? new Date(req.query.at) : undefined;
    const items = await effectiveMenu(s.db, loc.organizationId, loc, { at, lang: req.query.lang, kinds: [req.query.kind], menuIds: req.query.menuId ? [req.query.menuId] : undefined });
    const categories = [...new Set(items.map((i) => i.category))].map((c) => ({ name: c, items: items.filter((i) => i.category === c) }));
    const cfg = await loadFoodConfig(s.db, loc.id);
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, country: loc.country, acceptingOrders: loc.status === 'operating' && (loc.paymentsEnabled || loc.settings.payAtPickup === true) },
      at: (at ?? new Date()).toISOString(), allergenRegime: regimeFor(loc, cfg),
      channels: cfg.channels, tips: cfg.tips.enabled ? { presetsBps: cfg.tips.presetsBps, allowCustom: cfg.tips.allowCustom, channels: cfg.tips.channels } : null,
      serviceCharge: cfg.serviceCharge.bps > 0 ? { bps: cfg.serviceCharge.bps, label: cfg.serviceCharge.label, channels: cfg.serviceCharge.channels } : null,
      categories,
    };
  });

  app.get('/public/foods/:locationId/pickup-slots', {
    schema: { tags: ['foods'], params: z.object({ locationId: z.uuid() }), querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    // Locations with pickup settings get their slot horizon generated on demand.
    await ensurePickupSlots(s.db, loc);
    const settings = configOf(await loadPickupSettings(s.db, loc.id));
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 2 * 86400_000);
    const rows = await s.db.select().from(pickupSlots).where(and(eq(pickupSlots.locationId, loc.id), gte(pickupSlots.startsAt, from), lt(pickupSlots.startsAt, to))).orderBy(asc(pickupSlots.startsAt));
    const now = new Date();
    const earliest = now.getTime() + settings.prepBufferMinutes * 60_000;
    return {
      timeZone: loc.timeZone, acceptingOrders: settings.acceptingOrders, prepBufferMinutes: settings.prepBufferMinutes,
      items: rows.map((r) => ({ id: r.id, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), remaining: Math.max(0, r.capacity - r.booked), available: settings.acceptingOrders && r.booked < r.capacity && r.cutoffAt > now && r.startsAt.getTime() >= earliest, cutoffAt: r.cutoffAt.toISOString() })),
    };
  });

  app.post('/public/foods/:locationId/orders', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Create a pickup order (server-side slot & menu checks). Order awaits restaurant acceptance.', params: z.object({ locationId: z.uuid() }), body: foodOrderCreateSchema },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const r = await createFoodOrder(s, loc.organizationId, loc.id, req.body);
    return reply.code(201).send({ order: serializeFoodOrder(r.order, { includeContact: true }), manageToken: r.manageToken, payment: r.payment, nextStep: 'Your order is waiting for the restaurant to accept it.' });
  });

  app.get('/public/foods/orders/:id', {
    schema: { tags: ['foods'], summary: 'Customer order status (requires manage token)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req) => {
    const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, req.params.id));
    if (!o || o.manageTokenHash !== sha256(req.query.token)) throw notFound('Order');
    return serializeFoodOrder(o, { includeContact: true });
  });

  // ───────── Staff / HQ ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/foods/menus', { schema: { tags: ['foods'], security: secured, params: orgParams } }, async (req) => {
      const { orgId } = req.params;
      await authorisedLocations(req, s.db, orgId, 'operations.read');
      const m = await s.db.select().from(menus).where(eq(menus.organizationId, orgId));
      const items = m.length ? await s.db.select().from(menuItems).where(inArray(menuItems.menuId, m.map((x) => x.id))).orderBy(menuItems.category, menuItems.sortOrder) : [];
      const groups = items.length ? await s.db.select().from(modifierGroups).where(inArray(modifierGroups.menuItemId, items.map((i) => i.id))) : [];
      const mods = groups.length ? await s.db.select().from(modifiers).where(inArray(modifiers.groupId, groups.map((g) => g.id))) : [];
      return { items: m.map((menu) => ({ ...menu, items: items.filter((i) => i.menuId === menu.id).map((i) => ({ ...i, modifierGroups: groups.filter((g) => g.menuItemId === i.id).map((g) => ({ ...g, modifiers: mods.filter((x) => x.groupId === g.id) })) })) })) };
    });

    priv.post('/orgs/:orgId/foods/menus', { schema: { tags: ['foods'], security: secured, params: orgParams, body: z.object({ name: z.string().min(1) }) } }, async (req, reply) => {
      const { orgId } = req.params;
      await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const [m] = await s.db.insert(menus).values({ organizationId: orgId, name: req.body.name }).returning();
      return reply.code(201).send(m);
    });

    priv.post('/orgs/:orgId/foods/menus/:id/publish', {
      schema: {
        tags: ['foods'], security: secured, params: idParams, summary: 'Publish the master menu (all locations or a selection). Returns a result per location: succeeded, partial (some items unsellable there), failed or skipped. Local overrides are preserved.',
        body: z.object({ locationIds: z.array(z.uuid()).optional() }).optional(),
      },
    }, async (req) => {
      const { orgId, id } = req.params;
      await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const r = await publishMenu(s, orgId, id, { locationIds: req.body?.locationIds, actorUserId: req.user!.id });
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu.published', targetType: 'menu', targetId: id, metadata: { results: r.locations.map((l) => ({ locationId: l.locationId, status: l.status })) } });
      return r;
    });

    priv.post('/orgs/:orgId/foods/menus/:id/items', {
      schema: {
        tags: ['foods'], security: secured, params: idParams,
        body: z.object({
          category: z.string().min(1), name: z.string().min(1), description: z.string().max(2000).optional(), prices, dietary: z.array(z.string()).default([]), allergens: z.array(z.string()).default([]),
          allergensDeclared: z.boolean().optional(), categoryId: z.uuid().optional(), translations: z.record(z.string(), z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() })).default({}),
          dayPartIds: z.array(z.uuid()).default([]), stationKey: z.string().max(40).optional(), prepMinutes: z.number().int().min(0).max(240).optional(),
          imageUrl: z.url().optional(), localOverridable: z.array(z.enum(['price', 'available', 'description'])).default(['price', 'available']), sortOrder: z.number().int().default(0),
          modifierGroups: z.array(z.object({ name: z.string().min(1), minSelect: z.number().int().min(0).default(0), maxSelect: z.number().int().min(1).default(1), modifiers: z.array(z.object({ name: z.string().min(1), prices: prices.default({}), allergens: z.array(z.string()).default([]) })).min(1) })).default([]),
        }),
      },
    }, async (req, reply) => {
      const { orgId, id } = req.params;
      await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const [m] = await s.db.select().from(menus).where(and(eq(menus.id, id), eq(menus.organizationId, orgId)));
      if (!m) throw notFound('Menu');
      const b = req.body;
      for (const g of b.modifierGroups) if (g.minSelect > g.maxSelect) throw validationError('minSelect cannot exceed maxSelect', { modifierGroups: g.name });
      // Allergen and dietary labels come from the business and must use the controlled vocabulary.
      const allergens = cleanAllergens(b.allergens);
      const dietary = cleanDietary(b.dietary);
      const item = await s.db.transaction(async (tx) => {
        const [it] = await tx.insert(menuItems).values({
          organizationId: orgId, menuId: id, category: b.category, name: b.name, description: b.description ?? null, prices: b.prices, dietary, allergens, allergensDeclared: b.allergensDeclared ?? allergens.length > 0,
          categoryId: b.categoryId ?? null, translations: b.translations, dayPartIds: b.dayPartIds, stationKey: b.stationKey ?? null, prepMinutes: b.prepMinutes ?? null,
          imageUrl: b.imageUrl ?? null, localOverridable: b.localOverridable, sortOrder: b.sortOrder,
        }).returning();
        for (const [gi, g] of b.modifierGroups.entries()) {
          const [grp] = await tx.insert(modifierGroups).values({ organizationId: orgId, menuItemId: it!.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder: gi }).returning();
          await tx.insert(modifiers).values(g.modifiers.map((x, mi) => ({ organizationId: orgId, groupId: grp!.id, name: x.name, prices: x.prices, allergens: cleanAllergens(x.allergens), sortOrder: mi })));
        }
        return it!;
      });
      return reply.code(201).send(item);
    });

    priv.get('/orgs/:orgId/foods/locations/:locationId/menu', {
      schema: { tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'Location menu with origin of each value (hq vs local)' },
    }, async (req) => {
      const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
      return { location: { id: loc.id, currency: loc.currency }, items: await effectiveMenu(s.db, req.params.orgId, loc, { includeDrafts: true }) };
    });

    priv.put('/orgs/:orgId/foods/locations/:locationId/overrides/:menuItemId', {
      schema: {
        tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid(), menuItemId: z.uuid() }),
        summary: 'Set local price/availability/sold-out. Only fields HQ marked overridable can change (sold-out is always allowed).',
        body: z.object({ priceMinor: z.number().int().min(0).nullable().optional(), available: z.boolean().nullable().optional(), soldOut: z.boolean().optional(), soldOutUntil: isoDateTime.nullable().optional(), untilClose: z.boolean().optional().describe('Sold out until the location closes today (resets automatically)') }),
      },
    }, async (req) => {
      const { orgId, locationId, menuItemId } = req.params;
      const loc = await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
      const [it] = await s.db.select().from(menuItems).where(and(eq(menuItems.id, menuItemId), eq(menuItems.organizationId, orgId)));
      if (!it) throw notFound('Menu item');
      const b = req.body;
      const locked: Record<string, string> = {};
      if (b.priceMinor !== undefined && !it.localOverridable.includes('price')) locked.priceMinor = 'Price is set by headquarters';
      if (b.available !== undefined && !it.localOverridable.includes('available')) locked.available = 'Availability is set by headquarters';
      if (Object.keys(locked).length) throw new AppError(403, 'field_locked', 'Some fields are controlled by headquarters', locked);
      const until = b.soldOut && b.untilClose ? await soldOutUntilClose(s.db, loc) : b.soldOutUntil !== undefined ? (b.soldOutUntil ? new Date(b.soldOutUntil) : null) : undefined;
      const values = {
        organizationId: orgId, locationId, menuItemId, modifierId: null,
        ...(b.priceMinor !== undefined ? { priceMinor: b.priceMinor } : {}), ...(b.available !== undefined ? { available: b.available } : {}),
        ...(b.soldOut !== undefined ? { soldOut: b.soldOut } : {}), ...(until !== undefined ? { soldOutUntil: until } : b.soldOut === false ? { soldOutUntil: null } : {}),
        updatedBy: req.user!.id, updatedAt: new Date(),
      };
      const [row] = await s.db.insert(locationMenuOverrides).values(values).onConflictDoUpdate({ target: [locationMenuOverrides.locationId, locationMenuOverrides.menuItemId, locationMenuOverrides.modifierId], set: values }).returning();
      if (b.soldOut !== undefined) await recordSoldOut(s.db, { organizationId: orgId, locationId, menuItemId, soldOut: b.soldOut, until: until ?? null, source: 'manual', by: req.user!.id });
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu.local_override', scopeKind: 'location', scopeId: locationId, targetType: 'menu_item', targetId: menuItemId, metadata: b });
      return row;
    });

    priv.post('/orgs/:orgId/foods/locations/:locationId/pickup-slots', {
      schema: {
        tags: ['foods'], security: secured, params: orgParams.extend({ locationId: z.uuid() }), summary: 'Generate pickup slots for local dates (location timezone)',
        body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().min(1).max(14).default(1), open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/), intervalMinutes: z.number().int().min(5).max(120).default(15), capacity: z.number().int().min(1).max(500), cutoffMinutes: z.number().int().min(0).max(1440).default(20) }),
      },
    }, async (req, reply) => {
      const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
      const b = req.body;
      const values = [];
      for (let d = 0; d < b.days; d++) {
        const date = addDays(b.date, d);
        const open = zonedToUtc(date, b.open, loc.timeZone).getTime();
        const close = zonedToUtc(date, b.close, loc.timeZone).getTime();
        for (let t = open; t + b.intervalMinutes * 60_000 <= close; t += b.intervalMinutes * 60_000) {
          values.push({ organizationId: loc.organizationId, locationId: loc.id, startsAt: new Date(t), endsAt: new Date(t + b.intervalMinutes * 60_000), capacity: b.capacity, cutoffAt: new Date(t - b.cutoffMinutes * 60_000) });
        }
      }
      const rows = values.length ? await s.db.insert(pickupSlots).values(values).onConflictDoNothing().returning() : [];
      return reply.code(201).send({ created: rows.length, skippedExisting: values.length - rows.length });
    });

    priv.get('/orgs/:orgId/foods/orders', {
      schema: {
        tags: ['foods'], security: secured, params: orgParams, summary: 'Kitchen/order view. Shows paid (or pay-at-pickup) orders; unpaid orders are hidden until payment confirms.',
        querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(foodOrderStatesAll).optional(), channel: z.enum(FOOD_CHANNELS).optional(), active: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), from: isoDateTime.optional(), to: isoDateTime.optional() }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const conds = [eq(foodOrders.organizationId, orgId), inArray(foodOrders.paymentStatus, KITCHEN_PAYMENT_STATES)];
      if (req.query.locationId) conds.push(eq(foodOrders.locationId, req.query.locationId));
      if (req.query.channel) conds.push(eq(foodOrders.channel, req.query.channel));
      if (req.query.from) conds.push(gte(foodOrders.createdAt, new Date(req.query.from)));
      if (req.query.to) conds.push(lt(foodOrders.createdAt, new Date(req.query.to)));
      if (req.query.status) conds.push(eq(foodOrders.status, req.query.status));
      else if (req.query.active) conds.push(inArray(foodOrders.status, ACTIVE_FOOD_STATES));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [], refreshedAt: new Date().toISOString() };
        conds.push(inArray(foodOrders.locationId, [...allowed]));
      }
      const rows = await s.db.select().from(foodOrders).where(and(...conds)).orderBy(asc(foodOrders.promisedAt), desc(foodOrders.createdAt)).limit(200);
      const canContact = req.query.locationId ? await hasPerm(req, s.db, 'customers.read', { organizationId: orgId, kind: 'location', id: req.query.locationId }) : false;
      const now = Date.now();
      return { refreshedAt: new Date().toISOString(), items: rows.map((o) => ({ ...serializeFoodOrder(o, { includeContact: canContact }), overdue: !!o.promisedAt && o.promisedAt.getTime() < now && ['accepted', 'preparing'].includes(o.status) })) };
    });

    priv.post('/orgs/:orgId/foods/orders/:id/transition', {
      schema: {
        tags: ['foods'], security: secured, params: idParams,
        summary: 'Move an order through awaiting_acceptance → accepted → preparing → ready → collected (or rejected/cancelled → refund/void)',
        body: z.object({ to: z.enum(foodOrderStatesAll), expectedFrom: z.enum(foodOrderStatesAll).optional(), note: z.string().max(500).optional() }),
      },
    }, async (req) => {
      const { orgId, id } = req.params;
      const [o] = await s.db.select({ locationId: foodOrders.locationId }).from(foodOrders).where(and(eq(foodOrders.id, id), eq(foodOrders.organizationId, orgId)));
      if (!o) throw notFound('Order');
      await requireLocationPerm(req, s.db, orgId, o.locationId, 'operations.write');
      const r = await transitionFoodOrder(s, id, req.body.to, { organizationId: orgId, actorUserId: req.user!.id, note: req.body.note, expectedFrom: req.body.expectedFrom });
      return { order: serializeFoodOrder(r.order), paymentAction: r.paymentAction };
    });
  });
};

