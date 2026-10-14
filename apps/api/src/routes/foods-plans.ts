/**
 * Foods staff routes for planned production: preorder (cooking) dates, catering packages and the
 * enquiry → quote → acceptance → deposit pipeline, production summaries, meal plans and subscriptions,
 * ingredient inventory and recipes, reports and AI drafts (drafts only). Also the signed-in customer's
 * meal plans (/me).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  customers, foodCateringEnquiries, foodCateringPackages, foodIngredientMovements, foodIngredients, foodIngredientStock, foodMealPlans, foodMealPlanSubscriptions, foodProductionDates,
  foodRecipeLines, locations, menuItems, modifierGroups, modifiers, users,
} from '../db/schema/index.ts';
import { AppError, conflict, notFound, unauthorized, validationError } from '../lib/errors.ts';
import { localDateParts, zonedToUtc } from '../lib/tz.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { campaignDraft, menuCopy, productionNarrative } from '../services/foods-ai.ts';
import { productionSummary, quoteEnquiry, serializeEnquiry, setEnquiryStatus } from '../services/foods-catering.ts';
import { recordMovement, syncIngredientSoldOut } from '../services/foods-inventory.ts';
import { generateBoxes, loadSubContext, mondayOf, releaseBoxes, serializePlan, serializeSubscription, setSubscriptionStatus, setWeekSkipped } from '../services/foods-mealplans.ts';
import { cleanAllergens, cleanDietary } from '../services/foods-menu.ts';
import { foodsReport } from '../services/foods-reports.ts';
import { effectiveMenu } from '../services/foods.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const locParams = orgParams.extend({ locationId: z.uuid() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const prices = z.partialRecord(currency, z.number().int().min(0));
const translations = z.record(z.string().min(2).max(10), z.object({ name: z.string().max(200).optional(), description: z.string().max(2000).optional() }));

export const foodPlanRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  const hq = (req: Parameters<typeof requirePerm>[0], orgId: string) => requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });

  // ───────── Preorder dates & production ─────────
  app.get('/orgs/:orgId/foods/locations/:locationId/production-dates', { schema: { tags: ['foods'], security: secured, params: locParams } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const today = localDateParts(new Date(), loc.timeZone).date;
    const rows = await s.db.select().from(foodProductionDates).where(and(eq(foodProductionDates.locationId, loc.id), sql`${foodProductionDates.date} >= ${today}`)).orderBy(asc(foodProductionDates.date));
    return { timeZone: loc.timeZone, items: rows.map((d) => ({ ...d, cutoffAt: d.cutoffAt.toISOString(), remaining: Math.max(0, d.capacity - d.booked), cutoffPassed: d.cutoffAt <= new Date() })) };
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/production-dates', {
    schema: { tags: ['foods'], security: secured, params: locParams, summary: 'Open a cooking/collection date for preorders (local date; cut-off in local time)', body: z.object({ date, cutoffDate: date.optional(), cutoffTime: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'), cutoffDaysBefore: z.number().int().min(0).max(30).default(2), collectionWindows: z.array(z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)).max(10).default([]), capacity: z.number().int().min(1).max(10_000), menuId: z.uuid().optional(), note: z.string().max(300).optional() }) },
  }, async (req, reply) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    const b = req.body;
    const cutDate = b.cutoffDate ?? new Date(Date.parse(`${b.date}T00:00:00Z`) - b.cutoffDaysBefore * 86400_000).toISOString().slice(0, 10);
    const cutoffAt = zonedToUtc(cutDate, b.cutoffTime, loc.timeZone);
    if (cutoffAt <= new Date()) throw validationError('The cut-off is already in the past', { cutoffTime: 'In the past' });
    const [d] = await s.db.insert(foodProductionDates).values({ organizationId: req.params.orgId, locationId: loc.id, date: b.date, cutoffAt, collectionWindows: b.collectionWindows, capacity: b.capacity, menuId: b.menuId ?? null, note: b.note ?? null }).onConflictDoNothing().returning();
    if (!d) throw conflict('duplicate', 'This date is already open for preorders');
    return reply.code(201).send({ ...d, cutoffAt: d.cutoffAt.toISOString() });
  });
  app.patch('/orgs/:orgId/foods/production-dates/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ capacity: z.number().int().min(1).optional(), status: z.enum(['open', 'closed']).optional(), collectionWindows: z.array(z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)).optional(), note: z.string().max(300).nullable().optional() }) } }, async (req) => {
    const [d] = await s.db.select().from(foodProductionDates).where(and(eq(foodProductionDates.id, req.params.id), eq(foodProductionDates.organizationId, req.params.orgId)));
    if (!d) throw notFound('Date');
    await requireLocationPerm(req, s.db, req.params.orgId, d.locationId, 'operations.write');
    if (req.body.capacity !== undefined && req.body.capacity < d.booked) throw validationError(`Capacity cannot go below the ${d.booked} orders already booked`, { capacity: `At least ${d.booked}` });
    const [u] = await s.db.update(foodProductionDates).set(req.body).where(eq(foodProductionDates.id, d.id)).returning();
    return { ...u!, cutoffAt: u!.cutoffAt.toISOString() };
  });
  app.get('/orgs/:orgId/foods/locations/:locationId/production-summary', {
    schema: { tags: ['foods'], security: secured, params: locParams, querystring: z.object({ date: date.optional() }), summary: 'Production summary for a local date: items per station from orders/preorders, catering and meal-plan boxes' },
  }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    return productionSummary(s.db, req.params.orgId, loc, req.query.date ?? localDateParts(new Date(), loc.timeZone).date);
  });

  // ───────── Catering ─────────
  const pkgBody = z.object({
    name: z.string().min(1).max(120), description: z.string().max(2000).optional(), translations: translations.default({}), pricesPerGuest: prices, minGuests: z.number().int().min(1).default(10), maxGuests: z.number().int().min(1).nullable().optional(),
    leadDays: z.number().int().min(0).max(90).default(3), includes: z.array(z.string().max(200)).max(30).default([]), dietary: z.array(z.string()).default([]), allergens: z.array(z.string()).default([]), allergensDeclared: z.boolean().optional(),
    locationIds: z.array(z.uuid()).default([]), active: z.boolean().default(true), sortOrder: z.number().int().default(0),
  });
  app.get('/orgs/:orgId/foods/catering/packages', { schema: { tags: ['foods'], security: secured, params: orgParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    return { items: await s.db.select().from(foodCateringPackages).where(eq(foodCateringPackages.organizationId, req.params.orgId)).orderBy(asc(foodCateringPackages.sortOrder)) };
  });
  app.post('/orgs/:orgId/foods/catering/packages', { schema: { tags: ['foods'], security: secured, params: orgParams, body: pkgBody } }, async (req, reply) => {
    await hq(req, req.params.orgId);
    const b = req.body;
    const allergens = cleanAllergens(b.allergens);
    const [p] = await s.db.insert(foodCateringPackages).values({ organizationId: req.params.orgId, ...b, description: b.description ?? null, maxGuests: b.maxGuests ?? null, dietary: cleanDietary(b.dietary), allergens, allergensDeclared: b.allergensDeclared ?? allergens.length > 0 }).returning();
    return reply.code(201).send(p);
  });
  app.patch('/orgs/:orgId/foods/catering/packages/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: pkgBody.partial() } }, async (req) => {
    await hq(req, req.params.orgId);
    const b = req.body;
    const patch = { ...b, ...(b.allergens ? { allergens: cleanAllergens(b.allergens), allergensDeclared: b.allergensDeclared ?? true } : {}), ...(b.dietary ? { dietary: cleanDietary(b.dietary) } : {}) };
    const [p] = await s.db.update(foodCateringPackages).set(patch).where(and(eq(foodCateringPackages.id, req.params.id), eq(foodCateringPackages.organizationId, req.params.orgId))).returning();
    if (!p) throw notFound('Package');
    return p;
  });

  app.get('/orgs/:orgId/foods/catering/enquiries', {
    schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Catering pipeline (contact details need customers.read)', querystring: z.object({ locationId: z.uuid().optional(), status: z.string().optional() }) },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const conds = [eq(foodCateringEnquiries.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(foodCateringEnquiries.locationId, req.query.locationId));
    if (req.query.status) conds.push(inArray(foodCateringEnquiries.status, req.query.status.split(',')));
    const rows = (await s.db.select().from(foodCateringEnquiries).where(and(...conds)).orderBy(asc(foodCateringEnquiries.eventDate)).limit(300)).filter((e) => allowed === 'all' || allowed.has(e.locationId));
    const pkgs = new Map((await s.db.select({ id: foodCateringPackages.id, name: foodCateringPackages.name }).from(foodCateringPackages).where(eq(foodCateringPackages.organizationId, orgId))).map((p) => [p.id, p.name]));
    const contactOk = new Map<string, boolean>();
    for (const l of new Set(rows.map((r) => r.locationId))) contactOk.set(l, await hasPerm(req, s.db, 'customers.read', { organizationId: orgId, kind: 'location', id: l }));
    return { items: rows.map((e) => serializeEnquiry(e, { includeContact: contactOk.get(e.locationId), packageName: e.packageId ? pkgs.get(e.packageId) ?? null : null })) };
  });
  app.get('/orgs/:orgId/foods/catering/enquiries/:id', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    const [e] = await s.db.select().from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.id, req.params.id), eq(foodCateringEnquiries.organizationId, req.params.orgId)));
    if (!e) throw notFound('Enquiry');
    await requireLocationPerm(req, s.db, req.params.orgId, e.locationId, 'operations.read');
    const includeContact = await hasPerm(req, s.db, 'customers.read', { organizationId: req.params.orgId, kind: 'location', id: e.locationId });
    const [pkg] = e.packageId ? await s.db.select().from(foodCateringPackages).where(eq(foodCateringPackages.id, e.packageId)) : [];
    return { ...serializeEnquiry(e, { includeContact, packageName: pkg?.name ?? null }), package: pkg ?? null };
  });
  app.post('/orgs/:orgId/foods/catering/enquiries/:id/quote', {
    schema: {
      tags: ['foods'], security: secured, params: idParams, summary: 'Send (or revise) a quote: lines, optional package-based line, delivery fee, deposit, validity',
      body: z.object({ lines: z.array(z.object({ description: z.string().min(1).max(200), menuItemId: z.uuid().nullable().optional(), quantity: z.number().int().min(1).max(10_000), unitPriceMinor: z.number().int().min(0) })).max(100).optional(), fromPackage: z.boolean().optional(), deliveryFeeMinor: z.number().int().min(0).optional(), depositBps: z.number().int().min(0).max(10_000).optional(), depositMinor: z.number().int().min(0).optional(), validDays: z.number().int().min(1).max(60).optional(), terms: z.string().max(2000).nullable().optional() }),
    },
  }, async (req) => {
    const [e] = await s.db.select({ locationId: foodCateringEnquiries.locationId }).from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.id, req.params.id), eq(foodCateringEnquiries.organizationId, req.params.orgId)));
    if (!e) throw notFound('Enquiry');
    await requireLocationPerm(req, s.db, req.params.orgId, e.locationId, 'operations.write');
    return serializeEnquiry(await quoteEnquiry(s, req.params.orgId, req.params.id, req.body, req.user!.id), { includeContact: true });
  });
  app.post('/orgs/:orgId/foods/catering/enquiries/:id/status', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ to: z.enum(['confirmed', 'completed', 'declined', 'cancelled']), note: z.string().max(500).optional() }) } }, async (req) => {
    const [e] = await s.db.select({ locationId: foodCateringEnquiries.locationId }).from(foodCateringEnquiries).where(and(eq(foodCateringEnquiries.id, req.params.id), eq(foodCateringEnquiries.organizationId, req.params.orgId)));
    if (!e) throw notFound('Enquiry');
    await requireLocationPerm(req, s.db, req.params.orgId, e.locationId, 'operations.write');
    return serializeEnquiry(await setEnquiryStatus(s, req.params.orgId, req.params.id, req.body.to, req.user!.id, req.body.note), { includeContact: true });
  });

  // ───────── Meal plans ─────────
  const planBody = z.object({
    name: z.string().min(1).max(120), description: z.string().max(2000).optional(), translations: translations.default({}), mealsPerBox: z.number().int().min(1).max(50).default(5), pricesPerWeek: prices,
    fulfilment: z.enum(['pickup', 'delivery']).default('pickup'), fulfilmentWeekday: z.number().int().min(0).max(6).default(1), cutoffDaysBefore: z.number().int().min(0).max(14).default(3), cutoffTime: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
    menuItemIds: z.array(z.uuid()).default([]), locationIds: z.array(z.uuid()).default([]), active: z.boolean().default(true),
  });
  app.get('/orgs/:orgId/foods/meal-plans', { schema: { tags: ['foods'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await authorisedLocations(req, s.db, orgId, 'operations.read');
    const plans = await s.db.select().from(foodMealPlans).where(eq(foodMealPlans.organizationId, orgId)).orderBy(asc(foodMealPlans.createdAt));
    const counts = await s.db.select({ planId: foodMealPlanSubscriptions.planId, status: foodMealPlanSubscriptions.status, n: sql<number>`count(*)::int` }).from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.organizationId, orgId)).groupBy(foodMealPlanSubscriptions.planId, foodMealPlanSubscriptions.status);
    return { items: plans.map((p) => ({ ...serializePlan(p), subscribers: Object.fromEntries(counts.filter((c) => c.planId === p.id).map((c) => [c.status, c.n])) })) };
  });
  app.post('/orgs/:orgId/foods/meal-plans', { schema: { tags: ['foods'], security: secured, params: orgParams, body: planBody } }, async (req, reply) => {
    await hq(req, req.params.orgId);
    const [p] = await s.db.insert(foodMealPlans).values({ organizationId: req.params.orgId, ...req.body, description: req.body.description ?? null }).returning();
    return reply.code(201).send(serializePlan(p!));
  });
  app.patch('/orgs/:orgId/foods/meal-plans/:id', { schema: { tags: ['foods'], security: secured, params: idParams, body: planBody.partial() } }, async (req) => {
    await hq(req, req.params.orgId);
    const [p] = await s.db.update(foodMealPlans).set(req.body).where(and(eq(foodMealPlans.id, req.params.id), eq(foodMealPlans.organizationId, req.params.orgId))).returning();
    if (!p) throw notFound('Meal plan');
    return serializePlan(p);
  });
  app.get('/orgs/:orgId/foods/meal-plans/subscriptions', { schema: { tags: ['foods'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.string().optional() }) } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
    const conds = [eq(foodMealPlanSubscriptions.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(foodMealPlanSubscriptions.locationId, req.query.locationId));
    if (req.query.status) conds.push(inArray(foodMealPlanSubscriptions.status, req.query.status.split(',')));
    const subs = (await s.db.select().from(foodMealPlanSubscriptions).where(and(...conds)).orderBy(desc(foodMealPlanSubscriptions.createdAt)).limit(300)).filter((x) => allowed === 'all' || allowed.has(x.locationId));
    const out = [];
    for (const sub of subs) {
      const { plan, loc } = await loadSubContext(s.db, sub);
      const includeContact = await hasPerm(req, s.db, 'customers.read', { organizationId: orgId, kind: 'location', id: sub.locationId });
      out.push(serializeSubscription(sub, plan, loc, { includeContact }));
    }
    return { items: out };
  });
  app.post('/orgs/:orgId/foods/meal-plans/subscriptions/:id/skip', { schema: { tags: ['foods'], security: secured, params: idParams, body: z.object({ weekStart: date, skip: z.boolean().default(true) }) } }, async (req) => {
    const [sub] = await s.db.select().from(foodMealPlanSubscriptions).where(and(eq(foodMealPlanSubscriptions.id, req.params.id), eq(foodMealPlanSubscriptions.organizationId, req.params.orgId)));
    if (!sub) throw notFound('Subscription');
    await requireLocationPerm(req, s.db, req.params.orgId, sub.locationId, 'customers.write');
    const r = await setWeekSkipped(s, sub, req.body.weekStart, req.body.skip, req.user!.id);
    const { plan, loc } = await loadSubContext(s.db, r.subscription);
    return { subscription: serializeSubscription(r.subscription, plan, loc, { includeContact: true }), changed: r.changed };
  });
  app.post('/orgs/:orgId/foods/meal-plans/generate', { schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Create the boxes for a week (skipped weeks get a skipped box)', body: z.object({ weekStart: date, locationId: z.uuid().optional() }) } }, async (req) => {
    if (req.body.locationId) await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
    else await requirePerm(req, s.db, 'operations.write', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
    if (mondayOf(req.body.weekStart) !== req.body.weekStart) throw validationError('Weeks start on a Monday', { weekStart: 'Must be a Monday' });
    return generateBoxes(s.db, req.params.orgId, req.body.weekStart, req.body.locationId);
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/meal-plans/release', { schema: { tags: ['foods'], security: secured, params: locParams, summary: 'Send a date\'s meal-plan boxes to the kitchen (one accepted order per box)', body: z.object({ date }) } }, async (req) => {
    const loc = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
    const r = await releaseBoxes(s.db, req.params.orgId, loc, req.body.date, req.user!.id);
    await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'meal_plan.boxes_released', scopeKind: 'location', scopeId: loc.id, metadata: { date: req.body.date, released: r.released } });
    return r;
  });

  // Signed-in customer's meal plans (mobile "manage meal plan").
  const mySubs = async (req: Parameters<typeof requireUser>[0]) => {
    const me = requireUser(req);
    const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
    if (!u || u.deletedAt) throw unauthorized();
    const custIds = (await s.db.select({ id: customers.id }).from(customers).where(and(isNull(customers.erasedAt), u.emailVerifiedAt ? or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`) : eq(customers.userId, u.id)))).map((c) => c.id);
    return custIds.length ? s.db.select().from(foodMealPlanSubscriptions).where(inArray(foodMealPlanSubscriptions.customerId, custIds)).orderBy(desc(foodMealPlanSubscriptions.createdAt)) : [];
  };
  app.get('/me/foods/meal-plans', { schema: { tags: ['me'], security: secured } }, async (req) => {
    const subs = await mySubs(req);
    const out = [];
    for (const sub of subs) { const { plan, loc } = await loadSubContext(s.db, sub); out.push(serializeSubscription(sub, plan, loc, { includeContact: true })); }
    return { items: out };
  });
  app.post('/me/foods/meal-plans/:id/skip', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ weekStart: date, skip: z.boolean().default(true) }) } }, async (req) => {
    const sub = (await mySubs(req)).find((x) => x.id === req.params.id);
    if (!sub) throw notFound('Subscription');
    const r = await setWeekSkipped(s, sub, req.body.weekStart, req.body.skip, req.user!.id);
    const { plan, loc } = await loadSubContext(s.db, r.subscription);
    return serializeSubscription(r.subscription, plan, loc, { includeContact: true });
  });
  app.post('/me/foods/meal-plans/:id/status', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ to: z.enum(['paused', 'active', 'cancelled']) }) } }, async (req) => {
    const sub = (await mySubs(req)).find((x) => x.id === req.params.id);
    if (!sub) throw notFound('Subscription');
    const u = await setSubscriptionStatus(s, sub, req.body.to, req.user!.id);
    const { plan, loc } = await loadSubContext(s.db, u);
    return serializeSubscription(u, plan, loc, { includeContact: true });
  });

  // ───────── Ingredients & recipes ─────────
  app.get('/orgs/:orgId/foods/ingredients', { schema: { tags: ['foods'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Ingredient catalogue with stock at a location (low-stock and auto sold-out flags, items using each ingredient)' } }, async (req) => {
    const { orgId } = req.params;
    if (req.query.locationId) await requireLocationPerm(req, s.db, orgId, req.query.locationId, 'operations.read');
    else await authorisedLocations(req, s.db, orgId, 'operations.read');
    const ings = await s.db.select().from(foodIngredients).where(eq(foodIngredients.organizationId, orgId)).orderBy(asc(foodIngredients.name));
    const stock = req.query.locationId ? await s.db.select().from(foodIngredientStock).where(eq(foodIngredientStock.locationId, req.query.locationId)) : [];
    const recipe = ings.length ? await s.db.select({ r: foodRecipeLines, name: menuItems.name }).from(foodRecipeLines).innerJoin(menuItems, eq(menuItems.id, foodRecipeLines.menuItemId)).where(inArray(foodRecipeLines.ingredientId, ings.map((i) => i.id))) : [];
    return {
      items: ings.map((i) => {
        const st = stock.find((x) => x.ingredientId === i.id);
        const uses = recipe.filter((r) => r.r.ingredientId === i.id);
        const portion = uses.filter((u) => !u.r.modifierId).reduce((m, u) => Math.max(m, u.r.quantity), 0);
        return {
          id: i.id, name: i.name, unit: i.unit, sku: i.sku,
          stock: st ? { onHand: st.onHand, lowStockThreshold: st.lowStockThreshold, autoSoldOut: st.autoSoldOut, lowStock: st.onHand <= st.lowStockThreshold, exhausted: portion > 0 && st.onHand < portion, updatedAt: st.updatedAt.toISOString() } : null,
          usedBy: [...new Map(uses.map((u) => [u.r.menuItemId, { menuItemId: u.r.menuItemId, name: u.name, quantity: u.r.quantity, viaModifier: !!u.r.modifierId }])).values()],
        };
      }),
    };
  });
  app.post('/orgs/:orgId/foods/ingredients', { schema: { tags: ['foods'], security: secured, params: orgParams, body: z.object({ name: z.string().min(1).max(120), unit: z.enum(['g', 'ml', 'each']), sku: z.string().max(60).optional() }) } }, async (req, reply) => {
    await hq(req, req.params.orgId);
    const [i] = await s.db.insert(foodIngredients).values({ organizationId: req.params.orgId, ...req.body, sku: req.body.sku ?? null }).onConflictDoNothing().returning();
    if (!i) throw conflict('duplicate', 'An ingredient with this name already exists');
    return reply.code(201).send(i);
  });
  app.put('/orgs/:orgId/foods/locations/:locationId/ingredients/:ingredientId', { schema: { tags: ['foods'], security: secured, params: locParams.extend({ ingredientId: z.uuid() }), body: z.object({ lowStockThreshold: z.number().int().min(0).optional(), autoSoldOut: z.boolean().optional() }) } }, async (req) => {
    const { orgId, locationId, ingredientId } = req.params;
    await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [ing] = await s.db.select().from(foodIngredients).where(and(eq(foodIngredients.id, ingredientId), eq(foodIngredients.organizationId, orgId)));
    if (!ing) throw notFound('Ingredient');
    const [row] = await s.db.insert(foodIngredientStock).values({ organizationId: orgId, locationId, ingredientId, ...req.body }).onConflictDoUpdate({ target: [foodIngredientStock.locationId, foodIngredientStock.ingredientId], set: { ...req.body, updatedAt: new Date() } }).returning();
    await syncIngredientSoldOut(s.db, orgId, locationId);
    return row;
  });
  app.post('/orgs/:orgId/foods/locations/:locationId/ingredients/:ingredientId/movements', {
    schema: { tags: ['foods'], security: secured, params: locParams.extend({ ingredientId: z.uuid() }), summary: 'Receive, waste or count stock (count sets the on-hand quantity)', body: z.object({ reason: z.enum(['receive', 'waste', 'count']), quantity: z.number().int().min(0).max(100_000_000), note: z.string().max(300).optional() }) },
  }, async (req, reply) => {
    const { orgId, locationId, ingredientId } = req.params;
    await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
    const [ing] = await s.db.select().from(foodIngredients).where(and(eq(foodIngredients.id, ingredientId), eq(foodIngredients.organizationId, orgId)));
    if (!ing) throw notFound('Ingredient');
    if (req.body.reason !== 'count' && req.body.quantity === 0) throw validationError('Quantity must be more than zero', { quantity: 'Must be > 0' });
    return reply.code(201).send(await recordMovement(s.db, { organizationId: orgId, locationId, ingredientId, reason: req.body.reason, quantity: req.body.quantity, note: req.body.note, by: req.user!.id }));
  });
  app.get('/orgs/:orgId/foods/locations/:locationId/ingredients/:ingredientId/movements', { schema: { tags: ['foods'], security: secured, params: locParams.extend({ ingredientId: z.uuid() }) } }, async (req) => {
    await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.read');
    const rows = await s.db.select().from(foodIngredientMovements).where(and(eq(foodIngredientMovements.locationId, req.params.locationId), eq(foodIngredientMovements.ingredientId, req.params.ingredientId))).orderBy(desc(foodIngredientMovements.createdAt)).limit(200);
    return { items: rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) };
  });
  app.get('/orgs/:orgId/foods/items/:id/recipe', { schema: { tags: ['foods'], security: secured, params: idParams } }, async (req) => {
    await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
    const rows = await s.db.select({ r: foodRecipeLines, i: foodIngredients }).from(foodRecipeLines).innerJoin(foodIngredients, eq(foodIngredients.id, foodRecipeLines.ingredientId)).where(and(eq(foodRecipeLines.menuItemId, req.params.id), eq(foodRecipeLines.organizationId, req.params.orgId)));
    return { menuItemId: req.params.id, lines: rows.map((x) => ({ ingredientId: x.i.id, name: x.i.name, unit: x.i.unit, quantity: x.r.quantity, modifierId: x.r.modifierId })) };
  });
  app.put('/orgs/:orgId/foods/items/:id/recipe', {
    schema: { tags: ['foods'], security: secured, params: idParams, summary: 'Replace the recipe of an item (quantity per portion; modifier lines apply when that option is chosen)', body: z.object({ lines: z.array(z.object({ ingredientId: z.uuid(), modifierId: z.uuid().nullable().optional(), quantity: z.number().int().min(1).max(1_000_000) })).max(60) }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId);
    const [it] = await s.db.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.organizationId, orgId)));
    if (!it) throw notFound('Menu item');
    const ingIds = [...new Set(req.body.lines.map((l) => l.ingredientId))];
    const known = ingIds.length ? await s.db.select({ id: foodIngredients.id }).from(foodIngredients).where(and(eq(foodIngredients.organizationId, orgId), inArray(foodIngredients.id, ingIds))) : [];
    if (known.length !== ingIds.length) throw validationError('Unknown ingredient', { lines: 'Unknown ingredient' });
    const modIds = [...new Set(req.body.lines.map((l) => l.modifierId).filter((x): x is string => !!x))];
    if (modIds.length) {
      const ok = await s.db.select({ id: modifiers.id }).from(modifiers).innerJoin(modifierGroups, eq(modifierGroups.id, modifiers.groupId)).where(and(eq(modifierGroups.menuItemId, id), inArray(modifiers.id, modIds)));
      if (ok.length !== modIds.length) throw validationError('Modifier is not an option of this item', { lines: 'Unknown modifier' });
    }
    await s.db.transaction(async (tx) => {
      await tx.delete(foodRecipeLines).where(eq(foodRecipeLines.menuItemId, id));
      if (req.body.lines.length) await tx.insert(foodRecipeLines).values(req.body.lines.map((l) => ({ organizationId: orgId, menuItemId: id, ingredientId: l.ingredientId, modifierId: l.modifierId ?? null, quantity: l.quantity })));
    });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'menu_item.recipe_updated', targetType: 'menu_item', targetId: id, metadata: { lines: req.body.lines.length } });
    return { menuItemId: id, lines: req.body.lines };
  });

  // ───────── Reports ─────────
  app.get('/orgs/:orgId/foods/reports', {
    schema: { tags: ['foods'], security: secured, params: orgParams, summary: 'Orders by channel, prep times, sold-out frequency, revenue per currency (never combined), catering pipeline and meal plans', querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), locationId: z.uuid().optional() }) },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'reports.read');
    const locs = (await s.db.select({ id: locations.id }).from(locations).where(eq(locations.organizationId, orgId))).map((l) => l.id).filter((id) => (allowed === 'all' || allowed.has(id)) && (!req.query.locationId || id === req.query.locationId));
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86400_000);
    if (from >= to) throw validationError('The start must be before the end', { from: 'After end' });
    return foodsReport(s.db, orgId, locs, from, to);
  });

  // ───────── AI drafts (never change data) ─────────
  app.post('/orgs/:orgId/foods/ai/menu-copy', { schema: { tags: ['foods', 'ai'], security: secured, params: orgParams, summary: 'Draft a menu description. Nothing is saved; allergens, dietary labels and prices cannot be changed by AI.', body: z.object({ menuItemId: z.uuid(), locale: z.string().max(10).optional(), tone: z.string().max(60).optional() }) } }, async (req) => {
    const { orgId } = req.params;
    const aiScope = await authorisedLocations(req, s.db, orgId, 'ai.use');
    if (aiScope !== 'all' && !aiScope.size) throw new AppError(403, 'forbidden', 'Missing permission ai.use');
    const [it] = await s.db.select().from(menuItems).where(and(eq(menuItems.id, req.body.menuItemId), eq(menuItems.organizationId, orgId)));
    if (!it) throw notFound('Menu item');
    const r = await menuCopy(s, it, req.body);
    await audit(s.db, { organizationId: orgId, ...actor(req), actorType: 'ai', action: 'ai.foods_menu_copy', targetType: 'menu_item', targetId: it.id, metadata: { warnings: r.warnings.length } });
    return r;
  });
  app.post('/orgs/:orgId/foods/ai/campaign-draft', { schema: { tags: ['foods', 'ai'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), goal: z.string().min(3).max(300), channel: z.enum(['email', 'sms', 'social']).default('email'), locale: z.string().max(10).optional() }) } }, async (req) => {
    const { orgId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'marketing.draft');
    const items = (await effectiveMenu(s.db, orgId, loc)).filter((i) => i.available).slice(0, 12).map((i) => ({ name: i.name, price: i.price ? `${(i.price.amount / 100).toFixed(2)} ${i.price.currency}` : null, dietary: i.dietary }));
    return campaignDraft(s, { goal: req.body.goal, channel: req.body.channel, locationName: loc.name, items, locale: req.body.locale });
  });
  app.post('/orgs/:orgId/foods/ai/production-summary', { schema: { tags: ['foods', 'ai'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), date: date.optional() }) } }, async (req) => {
    const { orgId } = req.params;
    const loc = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'operations.read');
    if (!(await hasPerm(req, s.db, 'ai.use', { organizationId: orgId, kind: 'location', id: loc.id }))) throw new AppError(403, 'forbidden', 'Missing permission ai.use');
    const data = await productionSummary(s.db, orgId, loc, req.body.date ?? localDateParts(new Date(), loc.timeZone).date);
    const r = await productionNarrative(s, { ...data, catering: data.catering.map(({ dietaryNotes: _d, ...c }) => c) });
    return { ...r, data };
  });
};
