/**
 * Public (customer) Foods routes beyond first-release pickup: one checkout for pickup / delivery / dine-in /
 * preorder with a server quote, delivery zone check and slots, QR table lookup and tabs, preorder dates,
 * catering enquiries and quotes, meal-plan subscriptions and order tracking.
 */
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { cateringEnquirySchema, deliveryAddressSchema, foodCheckoutSchema, publicContactSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  foodCateringPackages, foodDeliveries, foodDrivers, foodMealPlans, foodOrders, foodProductionDates, foodTables, foodTabs, locations, organizations,
} from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, localDateParts } from '../lib/tz.ts';
import { audit } from '../services/audit.ts';
import { acceptQuote, createEnquiry, enquiryByToken, serializeEnquiry } from '../services/foods-catering.ts';
import { listDeliverySlots, resolveDeliveryZone, serializeZone } from '../services/foods-delivery.ts';
import { payTab, tabByToken, tabSummary } from '../services/foods-dinein.ts';
import {
  cutoffOf, firstOpenWeek, fulfilmentDateOf, loadSubContext, sandboxActivate, serializePlan, serializeSubscription, setSubscriptionStatus, setWeekSkipped, subscribe, subscriptionByToken,
} from '../services/foods-mealplans.ts';
import { currentClose, loadFoodConfig, localized } from '../services/foods-menu.ts';
import { placeFoodOrder, quoteCheckout, serializeFoodOrder } from '../services/foods.ts';
import { isoDateTime } from './_common.ts';
import { foodCateringEnquiries } from '../db/schema/index.ts';

const locParams = z.object({ locationId: z.uuid() });
const idParams = z.object({ id: z.uuid() });
const token = z.string().min(10).max(200);

export const foodPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  // ───────── Checkout (pickup / delivery / dine-in / preorder) ─────────
  app.post('/public/foods/:locationId/checkout/quote', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Price a checkout with every server check (slot, zone + minimum, kitchen open, preorder cut-off, day-parts, sold-out, tips, service charge, configured tax). Nothing is reserved.', params: locParams, body: foodCheckoutSchema.omit({ contact: true }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    return quoteCheckout(s, loc, { ...req.body, contact: { name: 'quote', email: 'quote@example.com', marketingConsent: false } });
  });

  app.post('/public/foods/:locationId/checkout', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Place a pickup, delivery, dine-in (pay now or add to tab) or preorder order. The order awaits restaurant acceptance.', params: locParams, body: foodCheckoutSchema },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const r = await placeFoodOrder(s, loc.organizationId, loc.id, req.body);
    return reply.code(201).send({
      order: serializeFoodOrder(r.order, { includeContact: true }), manageToken: r.manageToken, payment: r.payment, tabToken: r.tabToken,
      nextStep: r.order.paymentStatus === 'on_tab' ? 'Added to your table’s tab. The kitchen will confirm your order.' : 'Your order is waiting for the restaurant to accept it.',
    });
  });

  app.get('/public/foods/orders/:id/track', {
    schema: { tags: ['foods'], summary: 'Order tracking (manage token): status, channel details and delivery progress', params: idParams, querystring: z.object({ token }) },
  }, async (req) => {
    const [o] = await s.db.select().from(foodOrders).where(eq(foodOrders.id, req.params.id));
    if (!o || o.manageTokenHash !== sha256(req.query.token)) throw notFound('Order');
    const [d] = await s.db.select().from(foodDeliveries).where(eq(foodDeliveries.orderId, o.id));
    const [driver] = d?.driverId ? await s.db.select().from(foodDrivers).where(eq(foodDrivers.id, d.driverId)) : [];
    const [loc] = await s.db.select({ name: locations.name, timeZone: locations.timeZone, phone: locations.phone }).from(locations).where(eq(locations.id, o.locationId));
    return {
      ...serializeFoodOrder(o, { includeContact: true }), location: loc,
      delivery: d ? { status: d.status, provider: d.provider, trackingUrl: d.trackingUrl, driverFirstName: driver?.name.split(' ')[0] ?? null, updatedAt: d.updatedAt.toISOString() } : null,
    };
  });

  // ───────── Delivery ─────────
  app.get('/public/foods/:locationId/delivery/check', {
    schema: { tags: ['foods'], summary: 'Does the location deliver to this address? Returns the zone, fee and minimum order.', params: locParams, querystring: z.object({ postalCode: z.string().max(20).optional(), lat: z.coerce.number().optional(), lng: z.coerce.number().optional() }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const cfg = await loadFoodConfig(s.db, loc.id);
    if (!cfg.channels.delivery) return { deliverable: false, reason: 'Delivery is not available at this location', zone: null };
    const z0 = await resolveDeliveryZone(s, loc, req.query);
    if (!z0) return { deliverable: false, reason: req.query.postalCode ? 'We don’t deliver to this postcode yet' : 'Enter a postcode to check delivery', zone: null };
    return { deliverable: true, reason: null, zone: { ...serializeZone(z0.zone), matchedBy: z0.matchedBy, distanceMeters: z0.distanceMeters } };
  });

  app.get('/public/foods/:locationId/delivery-slots', {
    schema: { tags: ['foods'], params: locParams, querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 2 * 86400_000);
    return { timeZone: loc.timeZone, items: await listDeliverySlots(s.db, loc, from, to) };
  });

  // ───────── Dine-in: tables & tabs ─────────
  app.get('/public/foods/tables/:code', {
    schema: { tags: ['foods'], summary: 'Resolve a table QR code to its location and table', params: z.object({ code: z.string().min(3).max(40) }) },
  }, async (req) => {
    const [row] = await s.db.select({ t: foodTables, l: locations, o: organizations }).from(foodTables).innerJoin(locations, eq(locations.id, foodTables.locationId)).innerJoin(organizations, eq(organizations.id, locations.organizationId))
      .where(and(eq(foodTables.code, req.params.code.toUpperCase()), eq(foodTables.active, true), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!row) throw notFound('Table');
    const cfg = await loadFoodConfig(s.db, row.l.id);
    const open = await currentClose(s.db, row.l);
    const [tab] = await s.db.select({ id: foodTabs.id }).from(foodTabs).where(and(eq(foodTabs.tableId, row.t.id), eq(foodTabs.status, 'open')));
    return {
      table: { code: row.t.code, label: row.t.label, seats: row.t.seats, area: row.t.area },
      location: { id: row.l.id, name: row.l.name, slug: row.l.slug, orgSlug: row.o.slug, brand: row.o.name, timeZone: row.l.timeZone, currency: row.l.currency },
      dineInEnabled: cfg.channels.dineIn, kitchenOpen: open.open, closesAt: open.closesAt?.toISOString() ?? null, openTab: !!tab, payments: row.l.paymentsEnabled,
    };
  });

  app.get('/public/foods/tabs/:id', { schema: { tags: ['foods'], params: idParams, querystring: z.object({ token }) } }, async (req) => tabSummary(s.db, await tabByToken(s.db, req.params.id, req.query.token)));

  app.post('/public/foods/tabs/:id/pay', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Pay the whole table tab online (optional tip)', params: idParams, body: z.object({ token, tipMinor: z.number().int().min(0).default(0) }) },
  }, async (req) => {
    const tab = await tabByToken(s.db, req.params.id, req.body.token);
    return payTab(s, tab, req.body.tipMinor);
  });

  // ───────── Preorders ─────────
  app.get('/public/foods/:locationId/preorder-dates', { schema: { tags: ['foods'], summary: 'Cooking/collection dates open for preorder (choose the date first)', params: locParams } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const cfg = await loadFoodConfig(s.db, loc.id);
    const rows = await s.db.select().from(foodProductionDates).where(and(eq(foodProductionDates.locationId, loc.id), eq(foodProductionDates.status, 'open'), gt(foodProductionDates.cutoffAt, new Date()))).orderBy(asc(foodProductionDates.date));
    return { enabled: cfg.channels.preorder, timeZone: loc.timeZone, items: rows.map((d) => ({ id: d.id, date: d.date, cutoffAt: d.cutoffAt.toISOString(), collectionWindows: d.collectionWindows, remaining: Math.max(0, d.capacity - d.booked), available: d.booked < d.capacity, menuId: d.menuId, note: d.note })) };
  });

  // ───────── Catering ─────────
  app.get('/public/foods/:locationId/catering', { schema: { tags: ['foods'], summary: 'Catering packages offered at the location (prices per guest in the location currency)', params: locParams, querystring: z.object({ lang: z.string().max(10).optional() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const cfg = await loadFoodConfig(s.db, loc.id);
    const pkgs = (await s.db.select().from(foodCateringPackages).where(and(eq(foodCateringPackages.organizationId, loc.organizationId), eq(foodCateringPackages.active, true))).orderBy(asc(foodCateringPackages.sortOrder)))
      .filter((p) => !p.locationIds.length || p.locationIds.includes(loc.id));
    return {
      enabled: cfg.channels.catering, currency: loc.currency, earliestDate: addDays(localDateParts(new Date(), loc.timeZone).date, 1),
      packages: pkgs.map((p) => ({ id: p.id, ...localized(p, req.query.lang), pricePerGuest: p.pricesPerGuest[loc.currency] === undefined ? null : { amount: p.pricesPerGuest[loc.currency]!, currency: loc.currency }, minGuests: p.minGuests, maxGuests: p.maxGuests, leadDays: p.leadDays, includes: p.includes, dietary: p.dietary, allergens: p.allergens, allergenStatus: p.allergensDeclared || p.allergens.length ? 'declared' : 'not_provided' })),
    };
  });

  app.post('/public/foods/:locationId/catering/enquiries', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Send a catering enquiry. The business reviews price and capacity, then sends a quote.', params: locParams, body: cateringEnquirySchema },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const r = await createEnquiry(s, loc, req.body);
    return reply.code(201).send({ enquiry: serializeEnquiry(r.enquiry, { includeContact: true }), manageToken: r.token, nextStep: 'The business will review your enquiry and send a quote. Nothing is booked until you accept it.' });
  });

  app.get('/public/foods/catering/enquiries/:id', { schema: { tags: ['foods'], params: idParams, querystring: z.object({ token }) } }, async (req) => {
    const e = await enquiryByToken(s.db, req.params.id, req.query.token);
    const [loc] = await s.db.select({ name: locations.name, timeZone: locations.timeZone }).from(locations).where(eq(locations.id, e.locationId));
    return { ...serializeEnquiry(e, { includeContact: true }), location: loc };
  });

  app.post('/public/foods/catering/enquiries/:id/accept', {
    schema: { tags: ['foods'], summary: 'Accept the quote; returns the deposit payment when one is required', params: idParams, body: z.object({ token, quoteVersion: z.number().int().optional() }) },
  }, async (req) => {
    const r = await acceptQuote(s, req.params.id, req.body.token, req.body.quoteVersion);
    return { enquiry: serializeEnquiry(r.enquiry, { includeContact: true }), payment: r.payment };
  });

  app.post('/public/foods/catering/enquiries/:id/decline', { schema: { tags: ['foods'], params: idParams, body: z.object({ token, reason: z.string().max(500).optional() }) } }, async (req) => {
    const e = await enquiryByToken(s.db, req.params.id, req.body.token);
    if (!['new', 'quoted'].includes(e.status)) throw conflict('invalid_state', `This enquiry is ${e.status.replace('_', ' ')}`);
    const [u] = await s.db.update(foodCateringEnquiries).set({ status: 'cancelled', declinedReason: req.body.reason ?? 'Declined by customer', statusHistory: [...e.statusHistory, { at: new Date().toISOString(), from: e.status, to: 'cancelled', by: null, note: 'Declined by customer' }], updatedAt: new Date() }).where(eq(foodCateringEnquiries.id, e.id)).returning();
    await audit(s.db, { organizationId: e.organizationId, actorUserId: null, actorType: 'system', action: 'catering.customer_declined', scopeKind: 'location', scopeId: e.locationId, targetType: 'catering_enquiry', targetId: e.id });
    return serializeEnquiry(u!, { includeContact: true });
  });

  // ───────── Meal plans ─────────
  app.get('/public/foods/:locationId/meal-plans', { schema: { tags: ['foods'], params: locParams, querystring: z.object({ lang: z.string().max(10).optional() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const cfg = await loadFoodConfig(s.db, loc.id);
    const plans = (await s.db.select().from(foodMealPlans).where(and(eq(foodMealPlans.organizationId, loc.organizationId), eq(foodMealPlans.active, true)))).filter((p) => !p.locationIds.length || p.locationIds.includes(loc.id));
    return {
      enabled: cfg.channels.mealPlans && loc.paymentsEnabled, timeZone: loc.timeZone, currency: loc.currency,
      plans: plans.map((p) => {
        const week = firstOpenWeek(p, loc.timeZone);
        return { ...serializePlan(p, loc.currency), ...localized(p, req.query.lang), firstWeek: week, firstFulfilmentDate: fulfilmentDateOf(p, week), firstCutoffAt: cutoffOf(p, week, loc.timeZone).toISOString() };
      }),
    };
  });

  app.post('/public/foods/:locationId/meal-plans/subscriptions', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['foods'], summary: 'Subscribe to a weekly meal plan (Stripe subscription; sandbox without keys)', params: locParams, body: z.object({ planId: z.uuid(), contact: publicContactSchema, address: deliveryAddressSchema.optional(), startWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const r = await subscribe(s, loc, req.body);
    return reply.code(201).send({ subscription: serializeSubscription(r.subscription, r.plan, loc, { includeContact: true }), manageToken: r.manageToken, payment: r.payment });
  });

  const subFromToken = async (id: string, t: string) => {
    const sub = await subscriptionByToken(s.db, id, t);
    const ctx = await loadSubContext(s.db, sub);
    return { sub, ...ctx };
  };

  app.get('/public/foods/meal-plans/subscriptions/:id', { schema: { tags: ['foods'], params: idParams, querystring: z.object({ token }) } }, async (req) => {
    const { sub, plan, loc } = await subFromToken(req.params.id, req.query.token);
    return serializeSubscription(sub, plan, loc, { includeContact: true });
  });

  app.post('/public/foods/meal-plans/subscriptions/:id/skip', {
    schema: { tags: ['foods'], summary: 'Skip (or un-skip) a week before its cut-off', params: idParams, body: z.object({ token, weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), skip: z.boolean().default(true) }) },
  }, async (req) => {
    const { sub, plan, loc } = await subFromToken(req.params.id, req.body.token);
    const r = await setWeekSkipped(s, sub, req.body.weekStart, req.body.skip, null);
    return { subscription: serializeSubscription(r.subscription, plan, loc, { includeContact: true }), changed: r.changed, creditId: r.creditId };
  });

  app.post('/public/foods/meal-plans/subscriptions/:id/status', {
    schema: { tags: ['foods'], params: idParams, body: z.object({ token, to: z.enum(['paused', 'active', 'cancelled']) }) },
  }, async (req) => {
    const { sub, plan, loc } = await subFromToken(req.params.id, req.body.token);
    const u = await setSubscriptionStatus(s, sub, req.body.to, null);
    return serializeSubscription(u, plan, loc, { includeContact: true });
  });

  app.post('/public/foods/meal-plans/subscriptions/:id/sandbox-activate', {
    schema: { tags: ['foods'], summary: 'Sandbox only: simulate the first invoice being paid (or failing) through the webhook processor', params: idParams, body: z.object({ token, outcome: z.enum(['paid', 'failed']).default('paid') }) },
  }, async (req) => {
    if (s.cfg.NODE_ENV === 'production' && s.payments.mode !== 'sandbox') throw validationError('Not available');
    const { sub } = await subFromToken(req.params.id, req.body.token);
    const r = await sandboxActivate(s, sub, req.body.outcome);
    const { sub: fresh, plan, loc } = await subFromToken(req.params.id, req.body.token);
    return { result: r, subscription: serializeSubscription(fresh, plan, loc, { includeContact: true }) };
  });
};
