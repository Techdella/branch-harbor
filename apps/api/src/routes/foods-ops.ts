/**
 * Foods staff operations: food overview, KDS with stations (bump/recall), delivery zones, drivers and
 * handoff (own drivers or Uber Direct / Deliverect adapters), dine-in tables/QR codes and tabs, and the
 * driver's own deliveries (/me).
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  foodCateringEnquiries, foodDeliveries, foodKdsTickets, foodDeliveryZones, foodDrivers, foodIngredients, foodIngredientStock, foodMealPlanSubscriptions, foodOrders, foodStations, foodTables, foodTabs,
  locations, pickupSlots,
} from '../db/schema/index.ts';
import { ACTIVE_FOOD_STATES } from '../domain/foodOrderState.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { deliveryProvider, deliveryProvidersStatus } from '../integrations/foods-delivery.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm } from '../services/authz.ts';
import { dispatchOrder, serializeDelivery, serializeZone } from '../services/foods-delivery.ts';
import { closeTab, newTableCode, tabSummary } from '../services/foods-dinein.ts';
import { actOnTicket, ensureDefaultStations, KITCHEN_PAYMENT_STATES, kdsFeed } from '../services/foods-kitchen.ts';
import { effectiveMenu, transitionFoodOrder } from '../services/foods.ts';
import { idParams, orgParams, secured } from './_common.ts';

const locParams = orgParams.extend({ locationId: z.uuid() });

export const foodOpsRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const scopedLocations = async (req: Parameters<typeof authorisedLocations>[0], orgId: string, perm: 'operations.read' | 'reports.read', locationId?: string) => {
    const allowed = await authorisedLocations(req, s.db, orgId, perm);
    const locs = await s.db.select().from(locations).where(eq(locations.organizationId, orgId));
    return locs.filter((l) => !l.archivedAt && (allowed === 'all' || allowed.has(l.id)) && (!locationId || l.id === locationId));
  };

  // ───────── Food overview ─────────
  app.get('/orgs/:orgId/foods/overview', {
    schema: { tags: ['foods'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Current orders, pickup capacity today, sold-out items, low stock, catering to action, deliveries waiting and integration status per location' },
  }, async (req) => {
    const { orgId } = req.params;
    const locs = await scopedLocations(req, orgId, 'operations.read', req.query.locationId);
    const ids = locs.map((l) => l.id);
    const now = new Date();
    const [orders, cateringRows, lowRows, subs, deliveries] = ids.length ? await Promise.all([
      s.db.select({ locationId: foodOrders.locationId, status: foodOrders.status, channel: foodOrders.channel, promisedAt: foodOrders.promisedAt }).from(foodOrders).where(and(inArray(foodOrders.locationId, ids), inArray(foodOrders.status, ACTIVE_FOOD_STATES), inArray(foodOrders.paymentStatus, KITCHEN_PAYMENT_STATES))),
      s.db.select({ locationId: foodCateringEnquiries.locationId, status: foodCateringEnquiries.status }).from(foodCateringEnquiries).where(and(inArray(foodCateringEnquiries.locationId, ids), inArray(foodCateringEnquiries.status, ['new', 'deposit_paid', 'accepted']))),
      s.db.select({ locationId: foodIngredientStock.locationId, name: foodIngredients.name, unit: foodIngredients.unit, onHand: foodIngredientStock.onHand, threshold: foodIngredientStock.lowStockThreshold }).from(foodIngredientStock).innerJoin(foodIngredients, eq(foodIngredients.id, foodIngredientStock.ingredientId)).where(and(inArray(foodIngredientStock.locationId, ids), sql`${foodIngredientStock.onHand} <= ${foodIngredientStock.lowStockThreshold}`)),
      s.db.select({ locationId: foodMealPlanSubscriptions.locationId, status: foodMealPlanSubscriptions.status }).from(foodMealPlanSubscriptions).where(and(inArray(foodMealPlanSubscriptions.locationId, ids), eq(foodMealPlanSubscriptions.status, 'active'))),
      s.db.select({ locationId: foodDeliveries.locationId, status: foodDeliveries.status }).from(foodDeliveries).where(and(inArray(foodDeliveries.locationId, ids), inArray(foodDeliveries.status, ['pending', 'assigned', 'picked_up']))),
    ]) : [[], [], [], [], []];
    const out = [];
    for (const l of locs) {
      const local = localDateParts(now, l.timeZone).date;
      const dayEnd = zonedToUtc(addDays(local, 1), '00:00', l.timeZone);
      const [cap] = await s.db.select({ capacity: sql<number>`coalesce(sum(${pickupSlots.capacity}),0)::int`, booked: sql<number>`coalesce(sum(${pickupSlots.booked}),0)::int`, slots: sql<number>`count(*)::int` }).from(pickupSlots).where(and(eq(pickupSlots.locationId, l.id), gte(pickupSlots.startsAt, now), lt(pickupSlots.startsAt, dayEnd)));
      const menu = await effectiveMenu(s.db, orgId, l);
      const mine = orders.filter((o) => o.locationId === l.id);
      const deliveryOrdersReady = mine.filter((o) => o.channel === 'delivery' && ['accepted', 'preparing', 'ready'].includes(o.status)).length;
      out.push({
        locationId: l.id, name: l.name, timeZone: l.timeZone, currency: l.currency,
        orders: Object.fromEntries(ACTIVE_FOOD_STATES.map((st) => [st, mine.filter((o) => o.status === st).length])),
        overdue: mine.filter((o) => o.promisedAt && o.promisedAt < now && ['accepted', 'preparing'].includes(o.status)).length,
        byChannel: mine.reduce<Record<string, number>>((a, o) => ({ ...a, [o.channel]: (a[o.channel] ?? 0) + 1 }), {}),
        pickupCapacityToday: cap && cap.slots > 0 ? { capacity: cap.capacity, booked: cap.booked, remaining: Math.max(0, cap.capacity - cap.booked), slots: cap.slots } : null,
        pickupCapacityUnavailableReason: cap && cap.slots > 0 ? null : 'No pickup slots left today',
        soldOut: menu.filter((i) => i.unavailableCode === 'sold_out').map((i) => ({ id: i.id, name: i.name, source: i.soldOutSource, until: i.soldOutUntil })),
        lowStock: lowRows.filter((r) => r.locationId === l.id).map((r) => ({ name: r.name, onHand: r.onHand, unit: r.unit, threshold: r.threshold })),
        catering: { new: cateringRows.filter((c) => c.locationId === l.id && c.status === 'new').length, depositPaid: cateringRows.filter((c) => c.locationId === l.id && c.status === 'deposit_paid').length, awaitingDeposit: cateringRows.filter((c) => c.locationId === l.id && c.status === 'accepted').length },
        mealPlansActive: subs.filter((x) => x.locationId === l.id).length,
        deliveries: { active: deliveries.filter((d) => d.locationId === l.id).length, ordersAwaitingDispatch: deliveryOrdersReady },
      });
    }
    return { refreshedAt: now.toISOString(), locations: out, integrations: deliveryProvidersStatus() };
  });

  // ───────── Stations & KDS ─────────
  app.get('/orgs/:orgId/foods/locations/:locationId/stations', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    return { items: await s.db.select().from(foodStations).where(eq(foodStations.locationId, req.params.locationId)).orderBy(asc(foodStations.sortOrder)) };
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/stations', {
    schema: { tags: ['foods'], security: secured, params: locParams, body: z.object({ key: z.string().regex(/^[a-z0-9_-]{2,30}$/), name: z.string().min(1).max(60), prepTargetMinutes: z.number().int().min(1).max(240).default(12), isExpo: z.boolean().default(false), sortOrder: z.number().int().default(0) }) },
  }, async (req, reply) => {
    const { orgId, locationId } = req.params;
    await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [st] = await s.db.insert(foodStations).values({ organizationId: orgId, locationId, ...req.body }).onConflictDoNothing().returning();
    if (!st) throw conflict('duplicate', 'A station with this key already exists here');
    return reply.code(201).send(st);
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/stations/defaults', { schema: { tags: ['foods'], security: secured, params: locParams, summary: 'Create the default grill / cold / bar / expo stations' } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    return { items: await ensureDefaultStations(s.db, req.params.orgId, req.params.locationId) };
  });
  app.patch('/orgs/:orgId/foods/stations/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(60).optional(), prepTargetMinutes: z.number().int().min(1).max(240).optional(), isExpo: z.boolean().optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }) } }, async (req) => {
    const [st] = await s.db.select().from(foodStations).where(and(eq(foodStations.id, req.params.id), eq(foodStations.organizationId, req.params.orgId)));
    if (!st) throw notFound('Station');
    await requireLocationPerm(req, s.db, req.params.orgId, st.locationId, 'operations.write');
    const [u] = await s.db.update(foodStations).set(req.body).where(eq(foodStations.id, st.id)).returning();
    return u;
  });

  app.get('/orgs/:orgId/foods/kds', {
    schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Kitchen display: one station\'s tickets (routed by item station) or the expo view with station progress. No customer details beyond first name.', querystring: z.object({ locationId: z.uuid(), stationId: z.uuid().optional() }) },
  }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'operations.read');
    return kdsFeed(s.db, req.params.orgId, req.query.locationId, req.query.stationId);
  });

  for (const action of ['start', 'bump', 'recall'] as const) {
    app.post(`/orgs/:orgId/foods/kds/tickets/:id/${action}`, {
      schema: { tags: ['foods'], security: secured, params: idParams, summary: `${action[0]!.toUpperCase()}${action.slice(1)} a station ticket (server-acknowledged; expectedStatus guards stale screens)`, body: z.object({ expectedStatus: z.enum(['queued', 'in_progress', 'done']).optional() }).optional() },
    }, async (req) => {
      const { orgId, id } = req.params;
      const [t] = await s.db.select({ locationId: foodKdsTickets.locationId }).from(foodKdsTickets).where(and(eq(foodKdsTickets.id, id), eq(foodKdsTickets.organizationId, orgId)));
      if (!t) throw notFound('Ticket');
      await requireLocationPerm(req, s.db, orgId, t.locationId, 'operations.write');
      return actOnTicket(s, orgId, id, action, { expectedStatus: req.body?.expectedStatus, actorUserId: req.user!.id });
    });
  }

  // ───────── Delivery zones ─────────
  const zoneBody = z.object({
    name: z.string().min(1).max(80), kind: z.enum(['radius', 'postcode']), radiusMeters: z.number().int().min(100).max(100_000).optional(), postcodes: z.array(z.string().min(1).max(12)).max(500).default([]),
    feeMinor: z.number().int().min(0), minimumOrderMinor: z.number().int().min(0).default(0), freeDeliveryAboveMinor: z.number().int().min(0).nullable().optional(), active: z.boolean().default(true), sortOrder: z.number().int().default(0),
  });
  const checkZone = (b: { kind?: string; radiusMeters?: number; postcodes?: string[] }) => {
    if (b.kind === 'radius' && !b.radiusMeters) throw validationError('Enter a radius', { radiusMeters: 'Required for a radius zone' });
    if (b.kind === 'postcode' && !b.postcodes?.length) throw validationError('Add at least one postcode', { postcodes: 'Required for a postcode zone' });
  };
  app.get('/orgs/:orgId/foods/locations/:locationId/delivery-zones', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const rows = await s.db.select().from(foodDeliveryZones).where(eq(foodDeliveryZones.locationId, loc.id)).orderBy(asc(foodDeliveryZones.sortOrder));
    return { location: { id: loc.id, currency: loc.currency, geo: loc.geo ?? null }, items: rows.map(serializeZone), geocoding: s.geocoder.enabled ? 'enabled' : 'disabled' };
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/delivery-zones', { schema: { tags: ['foods'], security: secured, params: locParams, body: zoneBody } }, async (req, reply) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    checkZone(req.body);
    if (req.body.kind === 'radius' && !loc.geo) throw validationError('This location has no map coordinates, so a radius zone cannot be measured. Use postcodes or add coordinates.', { kind: 'Location has no coordinates' });
    const [z0] = await s.db.insert(foodDeliveryZones).values({ organizationId: req.params.orgId, locationId: loc.id, currency: loc.currency, ...req.body, radiusMeters: req.body.radiusMeters ?? null, freeDeliveryAboveMinor: req.body.freeDeliveryAboveMinor ?? null }).returning();
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'delivery_zone.created', scopeKind: 'location', scopeId: loc.id, targetType: 'delivery_zone', targetId: z0!.id });
    return reply.code(201).send(serializeZone(z0!));
  });
  app.patch('/orgs/:orgId/foods/delivery-zones/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: zoneBody.partial() } }, async (req) => {
    const [z0] = await s.db.select().from(foodDeliveryZones).where(and(eq(foodDeliveryZones.id, req.params.id), eq(foodDeliveryZones.organizationId, req.params.orgId)));
    if (!z0) throw notFound('Zone');
    await requireLocationPerm(req, s.db, req.params.orgId, z0.locationId, 'operations.write');
    checkZone({ kind: req.body.kind ?? z0.kind, radiusMeters: req.body.radiusMeters ?? z0.radiusMeters ?? undefined, postcodes: req.body.postcodes ?? z0.postcodes });
    const [u] = await s.db.update(foodDeliveryZones).set(req.body).where(eq(foodDeliveryZones.id, z0.id)).returning();
    return serializeZone(u!);
  });
  app.delete('/orgs/:orgId/foods/delivery-zones/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    const [z0] = await s.db.select().from(foodDeliveryZones).where(and(eq(foodDeliveryZones.id, req.params.id), eq(foodDeliveryZones.organizationId, req.params.orgId)));
    if (!z0) throw notFound('Zone');
    await requireLocationPerm(req, s.db, req.params.orgId, z0.locationId, 'operations.write');
    await s.db.delete(foodDeliveryZones).where(eq(foodDeliveryZones.id, z0.id));
    return { deleted: true };
  });

  // ───────── Drivers & deliveries ─────────
  app.get('/orgs/:orgId/foods/locations/:locationId/drivers', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    return { items: await s.db.select().from(foodDrivers).where(eq(foodDrivers.locationId, req.params.locationId)).orderBy(asc(foodDrivers.name)) };
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/drivers', { schema: { tags: ['foods'], security: secured, params: locParams, body: z.object({ name: z.string().min(1).max(120), phone: z.string().max(40).optional(), userId: z.uuid().optional() }) } }, async (req, reply) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    const [d] = await s.db.insert(foodDrivers).values({ organizationId: req.params.orgId, locationId: req.params.locationId, name: req.body.name, phone: req.body.phone ?? null, userId: req.body.userId ?? null }).returning();
    return reply.code(201).send(d);
  });
  app.patch('/orgs/:orgId/foods/drivers/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), phone: z.string().max(40).nullable().optional(), active: z.boolean().optional(), userId: z.uuid().nullable().optional() }) } }, async (req) => {
    const [d] = await s.db.select().from(foodDrivers).where(and(eq(foodDrivers.id, req.params.id), eq(foodDrivers.organizationId, req.params.orgId)));
    if (!d) throw notFound('Driver');
    await requireLocationPerm(req, s.db, req.params.orgId, d.locationId, 'operations.write');
    const [u] = await s.db.update(foodDrivers).set(req.body).where(eq(foodDrivers.id, d.id)).returning();
    return u;
  });

  app.get('/orgs/:orgId/foods/delivery-providers', { schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Delivery provider adapters and their mode (sandbox without credentials)' } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return { items: [{ key: 'own', name: 'Own drivers', mode: 'live' }, ...deliveryProvidersStatus()] };
  });

  app.get('/orgs/:orgId/foods/deliveries', { schema: { tags: ['foods'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), active: z.enum(['true', 'false']).default('true') }) } }, async (req) => {
    const locs = await scopedLocations(req, req.params.orgId, 'operations.read', req.query.locationId);
    if (!locs.length) return { items: [] };
    const conds = [inArray(foodDeliveries.locationId, locs.map((l) => l.id))];
    if (req.query.active === 'true') conds.push(inArray(foodDeliveries.status, ['pending', 'assigned', 'picked_up']));
    const rows = await s.db.select({ d: foodDeliveries, o: foodOrders, dr: foodDrivers }).from(foodDeliveries).innerJoin(foodOrders, eq(foodOrders.id, foodDeliveries.orderId)).leftJoin(foodDrivers, eq(foodDrivers.id, foodDeliveries.driverId)).where(and(...conds)).orderBy(desc(foodDeliveries.updatedAt)).limit(200);
    return { items: rows.map((r) => ({ ...serializeDelivery(r.d, r.dr ? { id: r.dr.id, name: r.dr.name, phone: r.dr.phone } : null), order: { id: r.o.id, orderNumber: r.o.orderNumber, status: r.o.status, promisedAt: r.o.promisedAt?.toISOString() ?? null, address: r.o.fulfilment.address ?? null, zoneName: r.o.fulfilment.zoneName ?? null, customerFirstName: r.o.contact.name.split(' ')[0] ?? '', total: { amount: r.o.totalMinor, currency: r.o.currency } } })) };
  });

  app.post('/orgs/:orgId/foods/orders/:id/dispatch', {
    schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Hand a delivery order to an own driver or a delivery provider (sandbox without credentials)', body: z.object({ provider: z.enum(['own', 'uber_direct', 'deliverect']), driverId: z.uuid().optional() }) },
  }, async (req) => {
    const [o] = await s.db.select({ locationId: foodOrders.locationId }).from(foodOrders).where(and(eq(foodOrders.id, req.params.id), eq(foodOrders.organizationId, req.params.orgId)));
    if (!o) throw notFound('Order');
    await requireLocationPerm(req, s.db, req.params.orgId, o.locationId, 'operations.write');
    return dispatchOrder(s, req.params.orgId, req.params.id, { provider: req.body.provider, driverId: req.body.driverId, actorUserId: req.user!.id });
  });

  /** Delivery status change; picked up → order out for delivery, delivered → order delivered (server-acknowledged). */
  const updateDelivery = async (orgId: string, id: string, to: 'assigned' | 'picked_up' | 'delivered' | 'failed', actorUserId: string, note?: string) => {
    const [d] = await s.db.select().from(foodDeliveries).where(and(eq(foodDeliveries.id, id), eq(foodDeliveries.organizationId, orgId)));
    if (!d) throw notFound('Delivery');
    const allowed: Record<string, string[]> = { assigned: ['pending'], picked_up: ['assigned', 'pending'], delivered: ['picked_up'], failed: ['assigned', 'picked_up', 'pending'] };
    if (!allowed[to]!.includes(d.status)) throw new AppError(409, 'invalid_transition', `Delivery is ${d.status.replace('_', ' ')}; cannot mark it ${to.replace('_', ' ')}`, undefined, { currentStatus: d.status });
    const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, d.orderId));
    if (to === 'picked_up') {
      if (o!.status !== 'ready') throw conflict('order_not_ready', 'Mark the order ready before the driver picks it up');
      await transitionFoodOrder(s, o!.id, 'out_for_delivery', { organizationId: orgId, actorUserId, expectedFrom: 'ready', note: 'Driver picked up' });
    }
    if (to === 'delivered') await transitionFoodOrder(s, o!.id, 'delivered', { organizationId: orgId, actorUserId, expectedFrom: 'out_for_delivery' });
    if (to === 'failed' && note === undefined) throw validationError('Say why the delivery failed', { note: 'Required' });
    const [u] = await s.db.update(foodDeliveries).set({ status: to, events: [...d.events, { at: new Date().toISOString(), status: to, by: actorUserId, note }], updatedAt: new Date() }).where(eq(foodDeliveries.id, d.id)).returning();
    await audit(s.db, { organizationId: orgId, actorUserId, action: `food_delivery.${to}`, scopeKind: 'location', scopeId: d.locationId, targetType: 'food_order', targetId: d.orderId, metadata: { note } });
    return serializeDelivery(u!);
  };

  app.post('/orgs/:orgId/foods/deliveries/:id/status', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ status: z.enum(['picked_up', 'delivered', 'failed']), note: z.string().max(300).optional() }) } }, async (req) => {
    const [d] = await s.db.select({ locationId: foodDeliveries.locationId }).from(foodDeliveries).where(and(eq(foodDeliveries.id, req.params.id), eq(foodDeliveries.organizationId, req.params.orgId)));
    if (!d) throw notFound('Delivery');
    await requireLocationPerm(req, s.db, req.params.orgId, d.locationId, 'operations.write');
    return updateDelivery(req.params.orgId, req.params.id, req.body.status, req.user!.id, req.body.note);
  });

  app.post('/orgs/:orgId/foods/deliveries/:id/sandbox-advance', { schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Sandbox provider: apply the next status the provider would report' } }, async (req) => {
    const [d] = await s.db.select().from(foodDeliveries).where(and(eq(foodDeliveries.id, req.params.id), eq(foodDeliveries.organizationId, req.params.orgId)));
    if (!d) throw notFound('Delivery');
    await requireLocationPerm(req, s.db, req.params.orgId, d.locationId, 'operations.write');
    if (d.provider === 'own' || !d.sandbox) throw conflict('not_sandbox', 'Only sandbox provider deliveries can be simulated');
    const next = deliveryProvider(d.provider as 'uber_direct' | 'deliverect').advance(d.status as 'pending');
    if (!next) throw conflict('invalid_transition', `Delivery is ${d.status}`);
    return updateDelivery(req.params.orgId, d.id, next as 'assigned' | 'picked_up' | 'delivered', req.user!.id, 'Sandbox provider update');
  });

  // Driver experience (mobile): deliveries assigned to drivers linked to me.
  app.get('/me/foods/deliveries', { schema: { tags: ['me'], security: secured, summary: 'Deliveries assigned to me as a driver (active first)' } }, async (req) => {
    const me = requireUser(req);
    const rows = await s.db.select({ d: foodDeliveries, o: foodOrders, dr: foodDrivers, l: locations }).from(foodDeliveries).innerJoin(foodDrivers, eq(foodDrivers.id, foodDeliveries.driverId)).innerJoin(foodOrders, eq(foodOrders.id, foodDeliveries.orderId)).innerJoin(locations, eq(locations.id, foodDeliveries.locationId))
      .where(and(eq(foodDrivers.userId, me.id), eq(foodDrivers.active, true))).orderBy(desc(foodDeliveries.updatedAt)).limit(50);
    return {
      items: rows.map((r) => ({
        ...serializeDelivery(r.d, { id: r.dr.id, name: r.dr.name, phone: r.dr.phone }), organizationId: r.d.organizationId,
        location: { id: r.l.id, name: r.l.name, timeZone: r.l.timeZone, address: r.l.address, phone: r.l.phone },
        order: { id: r.o.id, orderNumber: r.o.orderNumber, status: r.o.status, promisedAt: r.o.promisedAt?.toISOString() ?? null, customerName: r.o.contact.name, customerPhone: r.o.contact.phone ?? null, address: r.o.fulfilment.address ?? null, items: r.o.lines.reduce((a, l) => a + l.quantity, 0) },
      })),
    };
  });
  app.post('/me/foods/deliveries/:id/status', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ status: z.enum(['picked_up', 'delivered', 'failed']), note: z.string().max(300).optional() }) } }, async (req) => {
    const me = requireUser(req);
    const [r] = await s.db.select({ d: foodDeliveries, dr: foodDrivers }).from(foodDeliveries).innerJoin(foodDrivers, eq(foodDrivers.id, foodDeliveries.driverId)).where(eq(foodDeliveries.id, req.params.id));
    if (!r || r.dr.userId !== me.id) throw notFound('Delivery');
    return updateDelivery(r.d.organizationId, r.d.id, req.body.status, me.id, req.body.note);
  });

  // ───────── Dine-in tables & tabs ─────────
  app.get('/orgs/:orgId/foods/locations/:locationId/tables', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const rows = await s.db.select().from(foodTables).where(eq(foodTables.locationId, req.params.locationId)).orderBy(asc(foodTables.label));
    const open = rows.length ? await s.db.select({ tableId: foodTabs.tableId, id: foodTabs.id }).from(foodTabs).where(and(inArray(foodTabs.tableId, rows.map((t) => t.id)), eq(foodTabs.status, 'open'))) : [];
    return { items: rows.map((t) => ({ ...t, openTabId: open.find((o) => o.tableId === t.id)?.id ?? null })) };
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/tables', { schema: { tags: ['foods'], security: secured, params: locParams, body: z.object({ label: z.string().min(1).max(40), seats: z.number().int().min(1).max(40).default(2), area: z.string().max(60).optional() }) } }, async (req, reply) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    for (let attempt = 0; attempt < 5; attempt++) {
      const [t] = await s.db.insert(foodTables).values({ organizationId: req.params.orgId, locationId: req.params.locationId, label: req.body.label, seats: req.body.seats, area: req.body.area ?? null, code: newTableCode() }).onConflictDoNothing().returning();
      if (t) return reply.code(201).send(t);
      const [dup] = await s.db.select().from(foodTables).where(and(eq(foodTables.locationId, req.params.locationId), eq(foodTables.label, req.body.label)));
      if (dup) throw conflict('duplicate', 'A table with this label already exists here');
    }
    throw conflict('code_collision', 'Could not create a unique table code; try again');
  });
  app.patch('/orgs/:orgId/foods/tables/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ label: z.string().min(1).max(40).optional(), seats: z.number().int().min(1).max(40).optional(), area: z.string().max(60).nullable().optional(), active: z.boolean().optional(), regenerateCode: z.boolean().optional() }) } }, async (req) => {
    const [t] = await s.db.select().from(foodTables).where(and(eq(foodTables.id, req.params.id), eq(foodTables.organizationId, req.params.orgId)));
    if (!t) throw notFound('Table');
    await requireLocationPerm(req, s.db, req.params.orgId, t.locationId, 'operations.write');
    const { regenerateCode, ...rest } = req.body;
    const [u] = await s.db.update(foodTables).set({ ...rest, ...(regenerateCode ? { code: newTableCode() } : {}) }).where(eq(foodTables.id, t.id)).returning();
    if (regenerateCode) await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'food_table.code_regenerated', scopeKind: 'location', scopeId: t.locationId, targetType: 'food_table', targetId: t.id });
    return u;
  });
  app.get('/orgs/:orgId/foods/locations/:locationId/tabs', { schema: { tags: ['foods'], security: secured, params: locParams, querystring: z.object({ status: z.enum(['open', 'paid', 'void', 'all']).default('open') }) } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const rows = await s.db.select().from(foodTabs).where(and(eq(foodTabs.locationId, req.params.locationId), ...(req.query.status === 'all' ? [] : [eq(foodTabs.status, req.query.status)]))).orderBy(desc(foodTabs.openedAt)).limit(100);
    return { items: await Promise.all(rows.map((t) => tabSummary(s.db, t))) };
  });
  app.post('/orgs/:orgId/foods/tabs/:id/close', { schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Settle a tab at the counter or void an empty one', body: z.object({ how: z.enum(['counter', 'void']) }) } }, async (req) => {
    const [t] = await s.db.select().from(foodTabs).where(and(eq(foodTabs.id, req.params.id), eq(foodTabs.organizationId, req.params.orgId)));
    if (!t) throw notFound('Tab');
    await requireLocationPerm(req, s.db, req.params.orgId, t.locationId, 'operations.write');
    return tabSummary(s.db, await closeTab(s, req.params.orgId, t.id, req.body.how, req.user!.id));
  });

};
