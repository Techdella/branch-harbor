/**
 * Wellness — full product routes (staff side): service variants and prices, availability templates and exceptions
 * (impact + rebook), calendar (practitioner/room views, conflict-aware moves, check-in), recurring series, waitlist,
 * packages and vouchers, clients (history, preferences, scoped notes), reminders, reports, AI drafts.
 * Public and signed-in-customer routes are in wellness-public.ts (registered from here).
 */
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  appointments, customers, intakeResponses, locations, practitioners, resources, services, wellnessAiDrafts, wellnessAvailabilityExceptions, wellnessClientNotes,
  wellnessClientPackages, wellnessClientPreferences, wellnessGiftVouchers, wellnessLocationSettings, wellnessMessageLog, wellnessPackagePlans, wellnessPractitionerLocations,
  wellnessSeries, wellnessServiceVariants, wellnessVariantPrices, wellnessVoucherTransactions, wellnessWaitlist, wellnessAppointmentCharges,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { localDateParts } from '../lib/tz.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { draftAppointmentSummary, draftPolicyReply, draftServiceCopy, serializeDraft } from '../services/wellness-ai.ts';
import {
  applyCancellation, createClientPackage, effectivePackageStatus, expireStale, issueVoucher, loadPlanFor, redeemPackage, redeemVoucher, serializeClientPackage, serializePlan, serializeVoucher,
} from '../services/wellness-commerce.ts';
import {
  calendarDay, createSeries, exceptionImpact, joinWaitlist, noteVisible, offerFreedTime, rebookAffected, runRebookPrompts, runReminders, serializeWaitlist, templatesOf, utilisation, wellnessReport,
  type NoteViewer, type Viewer,
} from '../services/wellness-ops.ts';
import { groupMembers, reservationWindow, resolvePricing, rescheduleAppointment, scheduleClashes, serializeAppointment, templatesOverlap, withinWindows, practitionersAt, type AppointmentRow } from '../services/wellness.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';
import { bookAppointment, depositRuleSchema, policySchema } from './wellness.ts';
import { wellnessPublicRoutes } from './wellness-public.ts';

const weekly = z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^(\d{2}:\d{2}|24:00)$/) }).refine((w) => w.start < w.end, { message: 'Window must end after it starts' }));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const plain = (x: unknown) => x;

export const wellnessExtRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  await app.register(wellnessPublicRoutes);

  // Background: reminders, retention prompts and expiry (not in tests; jobs are idempotent via dedupe keys).
  if (s.cfg.NODE_ENV !== 'test') {
    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      const tick = async () => {
        try {
          await expireStale(s.db);
          await runReminders(s);
          await runRebookPrompts(s);
        } catch (err) {
          s.log.warn({ err }, 'wellness sweep failed');
        }
      };
      timer = setInterval(tick, 5 * 60_000);
      timer.unref?.();
    });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  }

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const viewerFor = async (req: FastifyRequest, orgId: string): Promise<Viewer> => ({ userId: req.user!.id, customersAt: await authorisedLocations(req, s.db, orgId, 'customers.read') });
    const loadAppt = async (orgId: string, id: string) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, id), eq(appointments.organizationId, orgId)));
      if (!a) throw notFound('Appointment');
      return a;
    };
    const loadService = async (orgId: string, id: string) => {
      const [svc] = await s.db.select().from(services).where(and(eq(services.id, id), eq(services.organizationId, orgId)));
      if (!svc) throw notFound('Service');
      return svc;
    };
    /** Editing a network-wide service needs org scope; a location service needs that location. */
    const requireServiceWrite = async (req: FastifyRequest, svc: typeof services.$inferSelect) => {
      if (svc.locationId) await requireLocationPerm(req, s.db, svc.organizationId, svc.locationId, 'operations.write');
      else await requirePerm(req, s.db, 'operations.write', { organizationId: svc.organizationId, kind: 'organization', id: svc.organizationId });
    };
    const loadPractitioner = async (orgId: string, id: string) => {
      const [p] = await s.db.select().from(practitioners).where(and(eq(practitioners.id, id), eq(practitioners.organizationId, orgId)));
      if (!p) throw notFound('Practitioner');
      return p;
    };
    const release = (a: AppointmentRow) => { offerFreedTime(s, a).catch((err) => s.log.warn({ err }, 'waitlist offer failed')); };

    // ───────── Services: update, variants, prices ─────────
    priv.patch('/orgs/:orgId/wellness/services/:id', {
      schema: {
        tags: ['wellness'], security: secured, params: idParams, summary: 'Update a service (durations, buffers, deposit rule, policy, eligibility, resources, online flag)',
        body: z.object({
          name: z.string().min(1).optional(), description: z.string().max(4000).nullable().optional(), category: z.string().max(60).nullable().optional(), durationMinutes: z.number().int().min(5).max(600).optional(),
          bufferBeforeMinutes: z.number().int().min(0).max(120).optional(), bufferAfterMinutes: z.number().int().min(0).max(120).optional(), priceMinor: z.number().int().min(0).optional(), depositMinor: z.number().int().min(0).optional(),
          requiredResourceType: z.string().min(1).nullable().optional(), equipmentTypes: z.array(z.string().min(1)).max(5).optional(), cancellationPolicy: z.string().max(2000).nullable().optional(), onlineBookable: z.boolean().optional(),
          practitionersRequired: z.number().int().min(1).max(2).optional(), depositRule: depositRuleSchema.nullable().optional(), policy: policySchema.nullable().optional(), rebookAfterWeeks: z.number().int().min(1).max(52).nullable().optional(), active: z.boolean().optional(),
          practitionerIds: z.array(z.uuid()).optional(),
        }),
      },
    }, async (req) => {
      const svc = await loadService(req.params.orgId, req.params.id);
      await requireServiceWrite(req, svc);
      const { practitionerIds, ...b } = req.body;
      const price = b.priceMinor ?? svc.priceMinor;
      if ((b.depositMinor ?? svc.depositMinor) > price) throw validationError('Deposit cannot exceed price', { depositMinor: 'Too high' });
      if (b.depositRule?.kind === 'percent' && b.depositRule.value > 100) throw validationError('A percentage deposit cannot exceed 100%', { 'depositRule.value': 'Max 100' });
      const [row] = await s.db.update(services).set({ ...b, updatedAt: new Date() }).where(eq(services.id, svc.id)).returning();
      if (practitionerIds) {
        // Eligible practitioners: add the service to the chosen ones, remove it from the others.
        const all = await s.db.select().from(practitioners).where(eq(practitioners.organizationId, svc.organizationId));
        for (const p of all) {
          const has = p.serviceIds.includes(svc.id);
          const want = practitionerIds.includes(p.id);
          if (has !== want) await s.db.update(practitioners).set({ serviceIds: want ? [...p.serviceIds, svc.id] : p.serviceIds.filter((x) => x !== svc.id) }).where(eq(practitioners.id, p.id));
        }
      }
      await audit(s.db, { organizationId: svc.organizationId, ...actor(req), action: 'wellness.service_updated', scopeKind: svc.locationId ? 'location' : 'organization', scopeId: svc.locationId ?? svc.organizationId, targetType: 'service', targetId: svc.id, metadata: { fields: Object.keys(req.body) } });
      return row;
    });

    priv.post('/orgs/:orgId/wellness/services/:id/variants', {
      schema: {
        tags: ['wellness'], security: secured, params: idParams, summary: 'Add a variant (e.g. 30/60/90 min) with prices per location (each in that location’s currency)',
        body: z.object({ name: z.string().min(1).max(60), durationMinutes: z.number().int().min(5).max(600), bufferBeforeMinutes: z.number().int().min(0).max(120).nullable().optional(), bufferAfterMinutes: z.number().int().min(0).max(120).nullable().optional(), sortOrder: z.number().int().default(0), prices: z.array(z.object({ locationId: z.uuid(), priceMinor: z.number().int().min(0), depositMinor: z.number().int().min(0).nullable().optional() })).default([]) }),
      },
    }, async (req, reply) => {
      const svc = await loadService(req.params.orgId, req.params.id);
      await requireServiceWrite(req, svc);
      const b = req.body;
      const locs: Array<typeof locations.$inferSelect> = [];
      for (const p of b.prices) {
        if (svc.locationId && p.locationId !== svc.locationId) throw validationError('This service is only offered at its own location', { prices: 'Location not allowed' });
        const l = await requireLocationPerm(req, s.db, svc.organizationId, p.locationId, 'operations.write');
        if (p.depositMinor != null && p.depositMinor > p.priceMinor) throw validationError('Deposit cannot exceed price', { prices: 'Deposit too high' });
        locs.push(l);
      }
      const out = await s.db.transaction(async (tx) => {
        const [v] = await tx.insert(wellnessServiceVariants).values({ organizationId: svc.organizationId, serviceId: svc.id, name: b.name, durationMinutes: b.durationMinutes, bufferBeforeMinutes: b.bufferBeforeMinutes ?? null, bufferAfterMinutes: b.bufferAfterMinutes ?? null, sortOrder: b.sortOrder }).returning();
        const prices = b.prices.length ? await tx.insert(wellnessVariantPrices).values(b.prices.map((p, i) => ({ organizationId: svc.organizationId, variantId: v!.id, locationId: p.locationId, priceMinor: p.priceMinor, depositMinor: p.depositMinor ?? null, currency: locs[i]!.currency }))).returning() : [];
        return { ...v!, prices };
      });
      await audit(s.db, { organizationId: svc.organizationId, ...actor(req), action: 'wellness.variant_created', targetType: 'service', targetId: svc.id, metadata: { variantId: out.id } });
      return reply.code(201).send(out);
    });

    priv.patch('/orgs/:orgId/wellness/variants/:id', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(60).optional(), durationMinutes: z.number().int().min(5).max(600).optional(), bufferBeforeMinutes: z.number().int().min(0).max(120).nullable().optional(), bufferAfterMinutes: z.number().int().min(0).max(120).nullable().optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }) },
    }, async (req) => {
      const [v] = await s.db.select().from(wellnessServiceVariants).where(and(eq(wellnessServiceVariants.id, req.params.id), eq(wellnessServiceVariants.organizationId, req.params.orgId)));
      if (!v) throw notFound('Variant');
      await requireServiceWrite(req, await loadService(req.params.orgId, v.serviceId));
      const [row] = await s.db.update(wellnessServiceVariants).set(req.body).where(eq(wellnessServiceVariants.id, v.id)).returning();
      return row;
    });

    priv.put('/orgs/:orgId/wellness/variants/:id/prices/:locationId', {
      schema: { tags: ['wellness'], security: secured, params: z.object({ orgId: z.uuid(), id: z.uuid(), locationId: z.uuid() }), summary: 'Set the price of a variant at a location (location currency)', body: z.object({ priceMinor: z.number().int().min(0), depositMinor: z.number().int().min(0).nullable().optional() }) },
    }, async (req) => {
      const [v] = await s.db.select().from(wellnessServiceVariants).where(and(eq(wellnessServiceVariants.id, req.params.id), eq(wellnessServiceVariants.organizationId, req.params.orgId)));
      if (!v) throw notFound('Variant');
      const svc = await loadService(req.params.orgId, v.serviceId);
      if (svc.locationId && svc.locationId !== req.params.locationId) throw validationError('This service is only offered at its own location');
      const l = await requireLocationPerm(req, s.db, req.params.orgId, req.params.locationId, 'operations.write');
      if (req.body.depositMinor != null && req.body.depositMinor > req.body.priceMinor) throw validationError('Deposit cannot exceed price', { depositMinor: 'Too high' });
      const vals = { organizationId: req.params.orgId, variantId: v.id, locationId: l.id, priceMinor: req.body.priceMinor, depositMinor: req.body.depositMinor ?? null, currency: l.currency, updatedAt: new Date() };
      const [row] = await s.db.insert(wellnessVariantPrices).values(vals).onConflictDoUpdate({ target: [wellnessVariantPrices.variantId, wellnessVariantPrices.locationId], set: vals }).returning();
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'wellness.price_set', scopeKind: 'location', scopeId: l.id, targetType: 'service_variant', targetId: v.id, metadata: { priceMinor: req.body.priceMinor, currency: l.currency } });
      return row;
    });

    // ───────── Practitioners, templates, resources, settings ─────────
    priv.patch('/orgs/:orgId/wellness/practitioners/:id', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).optional(), serviceIds: z.array(z.uuid()).optional(), active: z.boolean().optional(), userId: z.uuid().nullable().optional() }) },
    }, async (req) => {
      const p = await loadPractitioner(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      if (req.body.serviceIds?.length) {
        const svc = await s.db.select({ id: services.id }).from(services).where(and(eq(services.organizationId, p.organizationId), inArray(services.id, req.body.serviceIds)));
        if (svc.length !== new Set(req.body.serviceIds).size) throw validationError('Unknown service', { serviceIds: 'Some services were not found' });
      }
      const [row] = await s.db.update(practitioners).set(req.body).where(eq(practitioners.id, p.id)).returning();
      return row;
    });

    priv.get('/orgs/:orgId/wellness/practitioners/:id/templates', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const p = await loadPractitioner(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.read');
      return templatesOf(s.db, p.id);
    });

    priv.put('/orgs/:orgId/wellness/practitioners/:id/templates/:locationId', {
      schema: { tags: ['wellness'], security: secured, params: z.object({ orgId: z.uuid(), id: z.uuid(), locationId: z.uuid() }), summary: 'Weekly template at one location; refused if it overlaps the practitioner’s template at another location', body: z.object({ availability: weekly }) },
    }, async (req) => {
      const p = await loadPractitioner(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, p.organizationId, req.params.locationId, 'operations.write');
      const { templates } = await templatesOf(s.db, p.id);
      const tzs = await s.db.select({ id: locations.id, tz: locations.timeZone }).from(locations).where(eq(locations.organizationId, p.organizationId));
      const tzOf = (id: string) => tzs.find((x) => x.id === id)?.tz ?? 'UTC';
      const here = tzOf(req.params.locationId);
      const clashes = scheduleClashes(req.body.availability, here, templates.filter((t) => t.locationId !== req.params.locationId).map((t) => ({ locationId: t.locationId, availability: t.availability, timeZone: tzOf(t.locationId) })), localDateParts(new Date(), here).date);
      if (clashes.length) throw conflict('schedule_overlap', 'This schedule overlaps the practitioner’s hours at another location', { clashes });
      for (let i = 0; i < req.body.availability.length; i++) for (let j = i + 1; j < req.body.availability.length; j++) {
        if (templatesOverlap([req.body.availability[i]!], [req.body.availability[j]!]).length) throw validationError('Windows on the same day overlap', { availability: 'Overlapping windows' });
      }
      if (req.params.locationId === p.locationId) await s.db.update(practitioners).set({ availability: req.body.availability }).where(eq(practitioners.id, p.id));
      else {
        const vals = { organizationId: p.organizationId, practitionerId: p.id, locationId: req.params.locationId, availability: req.body.availability, active: true, updatedAt: new Date() };
        await s.db.insert(wellnessPractitionerLocations).values(vals).onConflictDoUpdate({ target: [wellnessPractitionerLocations.practitionerId, wellnessPractitionerLocations.locationId], set: vals });
      }
      await audit(s.db, { organizationId: p.organizationId, ...actor(req), action: 'wellness.template_saved', scopeKind: 'location', scopeId: req.params.locationId, targetType: 'practitioner', targetId: p.id });
      return templatesOf(s.db, p.id);
    });

    priv.delete('/orgs/:orgId/wellness/practitioners/:id/templates/:locationId', {
      schema: { tags: ['wellness'], security: secured, params: z.object({ orgId: z.uuid(), id: z.uuid(), locationId: z.uuid() }) },
    }, async (req) => {
      const p = await loadPractitioner(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, p.organizationId, req.params.locationId, 'operations.write');
      if (req.params.locationId === p.locationId) throw conflict('home_location', 'The home location template can be emptied but not removed');
      const future = await s.db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.practitionerId, p.id), eq(appointments.locationId, req.params.locationId), eq(appointments.status, 'confirmed'), gt(appointments.startsAt, new Date())));
      if (future.length) throw conflict('has_future_appointments', `${future.length} upcoming appointment(s) at this location — move them first`, { appointmentIds: future.map((f) => f.id) });
      await s.db.update(wellnessPractitionerLocations).set({ active: false, updatedAt: new Date() }).where(and(eq(wellnessPractitionerLocations.practitionerId, p.id), eq(wellnessPractitionerLocations.locationId, req.params.locationId)));
      return templatesOf(s.db, p.id);
    });

    priv.patch('/orgs/:orgId/wellness/resources/:id', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).optional(), type: z.string().min(1).optional(), active: z.boolean().optional() }) },
    }, async (req) => {
      const [r] = await s.db.select().from(resources).where(and(eq(resources.id, req.params.id), eq(resources.organizationId, req.params.orgId)));
      if (!r) throw notFound('Resource');
      await requireLocationPerm(req, s.db, r.organizationId, r.locationId, 'operations.write');
      const [row] = await s.db.update(resources).set(req.body).where(eq(resources.id, r.id)).returning();
      return row;
    });

    priv.get('/orgs/:orgId/wellness/locations/:id/settings', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.params.id, 'operations.read');
      const [r] = await s.db.select().from(wellnessLocationSettings).where(eq(wellnessLocationSettings.locationId, req.params.id));
      return r ?? { locationId: req.params.id, reminderHoursBefore: 24, smsReminders: true, emailReminders: true, rebookPrompts: true };
    });

    priv.put('/orgs/:orgId/wellness/locations/:id/settings', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ reminderHoursBefore: z.number().int().min(1).max(72), smsReminders: z.boolean(), emailReminders: z.boolean(), rebookPrompts: z.boolean() }) },
    }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.params.id, 'operations.write');
      const vals = { organizationId: req.params.orgId, locationId: req.params.id, ...req.body, updatedAt: new Date() };
      const [r] = await s.db.insert(wellnessLocationSettings).values(vals).onConflictDoUpdate({ target: wellnessLocationSettings.locationId, set: vals }).returning();
      return r;
    });

    // ───────── Exceptions (leave/absence) ─────────
    priv.get('/orgs/:orgId/wellness/exceptions', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ practitionerId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const conds = [eq(wellnessAvailabilityExceptions.organizationId, req.params.orgId), eq(wellnessAvailabilityExceptions.status, 'active'), gt(wellnessAvailabilityExceptions.endsAt, req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400_000))];
      if (req.query.to) conds.push(lt(wellnessAvailabilityExceptions.startsAt, new Date(req.query.to)));
      if (req.query.practitionerId) conds.push(eq(wellnessAvailabilityExceptions.practitionerId, req.query.practitionerId));
      const rows = await s.db.select({ e: wellnessAvailabilityExceptions, p: practitioners }).from(wellnessAvailabilityExceptions).innerJoin(practitioners, eq(practitioners.id, wellnessAvailabilityExceptions.practitionerId)).where(and(...conds)).orderBy(asc(wellnessAvailabilityExceptions.startsAt));
      const items = [];
      for (const r of rows.filter((x) => allowed === 'all' || allowed.has(x.e.locationId ?? x.p.locationId))) items.push({ ...r.e, practitionerName: r.p.name, affected: (await exceptionImpact(s.db, r.e)).length });
      return { items };
    });

    priv.post('/orgs/:orgId/wellness/exceptions', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'Record leave/absence; returns the affected appointments with same-time alternatives', body: z.object({ practitionerId: z.uuid(), locationId: z.uuid().nullable().optional(), startsAt: isoDateTime, endsAt: isoDateTime, kind: z.enum(['leave', 'absence', 'training', 'other']).default('leave'), reason: z.string().max(300).optional() }) },
    }, async (req, reply) => {
      const p = await loadPractitioner(req.params.orgId, req.body.practitionerId);
      await requireLocationPerm(req, s.db, p.organizationId, req.body.locationId ?? p.locationId, 'operations.write');
      if (new Date(req.body.endsAt) <= new Date(req.body.startsAt)) throw validationError('The end must be after the start', { endsAt: 'Before start' });
      const [ex] = await s.db.insert(wellnessAvailabilityExceptions).values({ organizationId: p.organizationId, practitionerId: p.id, locationId: req.body.locationId ?? null, startsAt: new Date(req.body.startsAt), endsAt: new Date(req.body.endsAt), kind: req.body.kind, reason: req.body.reason ?? null, createdBy: req.user!.id }).returning();
      await audit(s.db, { organizationId: p.organizationId, ...actor(req), action: 'wellness.exception_created', scopeKind: 'location', scopeId: req.body.locationId ?? p.locationId, targetType: 'practitioner', targetId: p.id, metadata: { exceptionId: ex!.id } });
      return reply.code(201).send({ exception: ex, impact: await exceptionImpact(s.db, ex!) });
    });

    priv.get('/orgs/:orgId/wellness/exceptions/:id/impact', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [ex] = await s.db.select().from(wellnessAvailabilityExceptions).where(and(eq(wellnessAvailabilityExceptions.id, req.params.id), eq(wellnessAvailabilityExceptions.organizationId, req.params.orgId)));
      if (!ex) throw notFound('Exception');
      const p = await loadPractitioner(req.params.orgId, ex.practitionerId);
      await requireLocationPerm(req, s.db, p.organizationId, ex.locationId ?? p.locationId, 'operations.read');
      return { exception: ex, impact: await exceptionImpact(s.db, ex) };
    });

    priv.post('/orgs/:orgId/wellness/exceptions/:id/rebook', {
      schema: {
        tags: ['wellness'], security: secured, params: idParams, summary: 'Rebook affected appointments: reassign (same time, other practitioner), reschedule or cancel with a full refund. Per-appointment results.',
        body: z.object({ actions: z.array(z.discriminatedUnion('action', [z.object({ appointmentId: z.uuid(), action: z.literal('reassign'), practitionerId: z.uuid().optional() }), z.object({ appointmentId: z.uuid(), action: z.literal('reschedule'), startsAt: isoDateTime, practitionerId: z.uuid().optional() }), z.object({ appointmentId: z.uuid(), action: z.literal('cancel'), notify: z.boolean().optional() })])).min(1).max(100) }),
      },
    }, async (req) => {
      const [ex] = await s.db.select().from(wellnessAvailabilityExceptions).where(and(eq(wellnessAvailabilityExceptions.id, req.params.id), eq(wellnessAvailabilityExceptions.organizationId, req.params.orgId)));
      if (!ex) throw notFound('Exception');
      const p = await loadPractitioner(req.params.orgId, ex.practitionerId);
      await requireLocationPerm(req, s.db, p.organizationId, ex.locationId ?? p.locationId, 'operations.write');
      return rebookAffected(s, ex.id, req.params.orgId, req.body.actions, req.user!.id);
    });

    priv.post('/orgs/:orgId/wellness/exceptions/:id/withdraw', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [ex] = await s.db.select().from(wellnessAvailabilityExceptions).where(and(eq(wellnessAvailabilityExceptions.id, req.params.id), eq(wellnessAvailabilityExceptions.organizationId, req.params.orgId)));
      if (!ex) throw notFound('Exception');
      const p = await loadPractitioner(req.params.orgId, ex.practitionerId);
      await requireLocationPerm(req, s.db, p.organizationId, ex.locationId ?? p.locationId, 'operations.write');
      const [row] = await s.db.update(wellnessAvailabilityExceptions).set({ status: 'withdrawn' }).where(eq(wellnessAvailabilityExceptions.id, ex.id)).returning();
      return row;
    });

    // ───────── Calendar ─────────
    priv.get('/orgs/:orgId/wellness/calendar', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'Practitioner and room columns for one location-day, with windows, leave, utilisation; client names only where the viewer’s duties allow', querystring: z.object({ locationId: z.uuid(), date: ymd }) },
    }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'operations.read');
      return calendarDay(s.db, { organizationId: req.params.orgId, locationId: req.query.locationId, date: req.query.date, viewer: await viewerFor(req, req.params.orgId) });
    });

    priv.post('/orgs/:orgId/wellness/appointments/:id/move', {
      schema: {
        tags: ['wellness'], security: secured, params: idParams, summary: 'Drag-to-reschedule: dryRun reports conflicts (practitioner, room, equipment, hours, leave) without changing anything; otherwise moves atomically',
        body: z.object({ startsAt: isoDateTime, practitionerId: z.uuid().optional(), resourceId: z.uuid().optional(), dryRun: z.boolean().default(false), outsideAvailability: z.boolean().default(false) }),
      },
    }, async (req) => {
      const a = await loadAppt(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      const startsAt = new Date(req.body.startsAt);
      const opts = { organizationId: req.params.orgId, startsAt, practitionerIds: req.body.practitionerId ? [req.body.practitionerId] : undefined, resourceId: req.body.resourceId, actorUserId: req.user!.id, enforceAvailability: !req.body.outsideAvailability };
      if (req.body.dryRun) {
        const conflicts = await diagnoseMove(a, startsAt, req.body.practitionerId ?? a.practitionerId, req.body.resourceId ?? a.resourceId);
        let ok = true;
        let error: { code: string; message: string } | null = null;
        try {
          await s.db.transaction(async (tx) => {
            await rescheduleAppointment(tx, a.id, opts);
            throw new AppError(499, 'dry_run_ok', 'rollback');
          });
        } catch (err) {
          const e = err as AppError;
          if (e.code !== 'dry_run_ok') { ok = false; error = { code: e.code ?? 'error', message: e.message }; }
        }
        return { ok, conflicts: ok ? [] : conflicts, error, startsAt: startsAt.toISOString() };
      }
      const r = await rescheduleAppointment(s.db, a.id, opts);
      release(a);
      return { ok: true, appointment: serializeAppointment(r.appointment), appointments: r.appointments.map(serializeAppointment), previousAppointmentId: r.previous.id, priceChange: r.priceChange };
    });

    async function diagnoseMove(a: AppointmentRow, startsAt: Date, practitionerId: string, resourceId: string | null) {
      const [svc] = await s.db.select().from(services).where(eq(services.id, a.serviceId));
      const [loc] = await s.db.select().from(locations).where(eq(locations.id, a.locationId));
      const pricing = await resolvePricing(s.db, svc!, loc!, a.variantId).catch(() => null);
      const dur = pricing ?? { durationMinutes: (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000, bufferBeforeMinutes: (a.startsAt.getTime() - a.blockedFrom.getTime()) / 60_000, bufferAfterMinutes: (a.blockedUntil.getTime() - a.endsAt.getTime()) / 60_000 };
      const win = reservationWindow(dur, startsAt);
      const members = await groupMembers(s.db, a);
      const ignore = members.map((m) => m.id);
      const out: Array<{ kind: string; message: string; with?: string }> = [];
      if (startsAt <= new Date()) out.push({ kind: 'past', message: 'The new time is in the past' });
      const pr = (await practitionersAt(s.db, a.organizationId, a.locationId)).find((x) => x.p.id === practitionerId);
      if (!pr) out.push({ kind: 'not_at_location', message: 'This practitioner does not work at this location' });
      else {
        if (!pr.p.serviceIds.includes(a.serviceId)) out.push({ kind: 'not_eligible', message: `${pr.p.name} does not offer this service` });
        if (!withinWindows(pr.windows, loc!.timeZone, win.startsAt, win.endsAt)) out.push({ kind: 'outside_hours', message: `Outside ${pr.p.name}’s working hours` });
      }
      const pBusy = await s.db.select({ id: appointments.id, startsAt: appointments.startsAt }).from(appointments).where(and(eq(appointments.practitionerId, practitionerId), eq(appointments.status, 'confirmed'), lt(appointments.blockedFrom, win.blockedUntil), gt(appointments.blockedUntil, win.blockedFrom)));
      for (const b of pBusy.filter((x) => !ignore.includes(x.id))) out.push({ kind: 'practitioner_busy', message: 'Practitioner already booked (buffers included)', with: b.id });
      const exc = await s.db.select().from(wellnessAvailabilityExceptions).where(and(eq(wellnessAvailabilityExceptions.practitionerId, practitionerId), eq(wellnessAvailabilityExceptions.status, 'active'), lt(wellnessAvailabilityExceptions.startsAt, win.endsAt), gt(wellnessAvailabilityExceptions.endsAt, win.startsAt)));
      for (const e of exc) out.push({ kind: 'exception', message: `Practitioner on ${e.kind}`, with: e.id });
      if (resourceId) {
        const rBusy = await s.db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.resourceId, resourceId), eq(appointments.status, 'confirmed'), lt(appointments.blockedFrom, win.blockedUntil), gt(appointments.blockedUntil, win.blockedFrom)));
        for (const b of rBusy.filter((x) => !ignore.includes(x.id))) out.push({ kind: 'room_busy', message: 'Room already reserved (buffers included)', with: b.id });
      }
      return out;
    }

    const setStatus = async (req: FastifyRequest, params: { orgId: string; id: string }, fn: (a: AppointmentRow) => Promise<unknown>) => {
      const a = await loadAppt(params.orgId, params.id);
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      return fn(a);
    };

    priv.post('/orgs/:orgId/wellness/appointments/:id/check-in', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) =>
      setStatus(req, req.params, async (a) => {
        if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
        const [loc] = await s.db.select().from(locations).where(eq(locations.id, a.locationId));
        if (localDateParts(a.startsAt, loc!.timeZone).date !== localDateParts(new Date(), loc!.timeZone).date) throw conflict('not_today', 'Check-in opens on the day of the appointment');
        const members = await groupMembers(s.db, a);
        await s.db.update(appointments).set({ checkedInAt: new Date(), updatedAt: new Date() }).where(inArray(appointments.id, members.map((m) => m.id)));
        await audit(s.db, { organizationId: a.organizationId, ...actor(req), action: 'appointment.checked_in', scopeKind: 'location', scopeId: a.locationId, targetType: 'appointment', targetId: a.id });
        return serializeAppointment((await s.db.select().from(appointments).where(eq(appointments.id, a.id)))[0]!);
      }));

    priv.post('/orgs/:orgId/wellness/appointments/:id/complete', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) =>
      setStatus(req, req.params, async (a) => {
        if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
        if (a.startsAt > new Date()) throw conflict('not_started', 'An appointment can be completed once it has started');
        const members = await groupMembers(s.db, a);
        await s.db.update(appointments).set({ status: 'completed', checkedInAt: a.checkedInAt ?? new Date(), updatedAt: new Date() }).where(inArray(appointments.id, members.map((m) => m.id)));
        await audit(s.db, { organizationId: a.organizationId, ...actor(req), action: 'appointment.completed', scopeKind: 'location', scopeId: a.locationId, targetType: 'appointment', targetId: a.id });
        return serializeAppointment((await s.db.select().from(appointments).where(eq(appointments.id, a.id)))[0]!);
      }));

    priv.post('/orgs/:orgId/wellness/appointments/:id/no-show', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ waiveFee: z.boolean().default(false) }) } }, async (req) =>
      setStatus(req, req.params, async (a) => applyCancellation(s, a.id, { organizationId: req.params.orgId, mode: 'no_show', waiveFee: req.body.waiveFee, actorUserId: req.user!.id })));

    priv.post('/orgs/:orgId/wellness/appointments/:id/apply-voucher', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ code: z.string().min(4).max(40) }) } }, async (req) =>
      setStatus(req, req.params, async (a) => {
        if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
        return s.db.transaction(async (tx) => redeemVoucher(tx, { organizationId: a.organizationId, code: req.body.code, members: await groupMembers(tx, a), actorUserId: req.user!.id }));
      }));

    priv.post('/orgs/:orgId/wellness/appointments/:id/apply-package', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ clientPackageId: z.uuid() }) } }, async (req) =>
      setStatus(req, req.params, async (a) => {
        if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
        if (a.clientPackageId) throw conflict('package_already_applied', 'A package session is already used for this appointment');
        return s.db.transaction(async (tx) => redeemPackage(tx, { organizationId: a.organizationId, clientPackageId: req.body.clientPackageId, members: await groupMembers(tx, a), customerId: a.customerId }));
      }));

    priv.get('/orgs/:orgId/wellness/my-day', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'The signed-in practitioner’s appointments for a day (all their locations)', querystring: z.object({ date: ymd.optional() }) },
    }, async (req) => {
      const mine = await s.db.select().from(practitioners).where(and(eq(practitioners.organizationId, req.params.orgId), eq(practitioners.userId, req.user!.id)));
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      if (allowed !== 'all' && !allowed.size) throw forbidden();
      if (!mine.length) return { practitioner: null, items: [] };
      const [home] = await s.db.select().from(locations).where(eq(locations.id, mine[0]!.locationId));
      const day = req.query.date ?? localDateParts(new Date(), home!.timeZone).date;
      const from = new Date(new Date(`${day}T00:00:00Z`).getTime() - 14 * 3600_000);
      const until = new Date(new Date(`${day}T00:00:00Z`).getTime() + 38 * 3600_000);
      const rows = await s.db.select({ a: appointments, svc: services.name, c: customers.name, l: locations }).from(appointments).innerJoin(services, eq(services.id, appointments.serviceId)).innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(locations, eq(locations.id, appointments.locationId))
        .where(and(inArray(appointments.practitionerId, mine.map((p) => p.id)), inArray(appointments.status, ['confirmed', 'completed', 'no_show']), gt(appointments.startsAt, from), lt(appointments.startsAt, until))).orderBy(asc(appointments.startsAt));
      const items = rows.filter((r) => localDateParts(r.a.startsAt, r.l.timeZone).date === day).map((r) => ({ ...serializeAppointment(r.a), serviceName: r.svc, clientName: r.c, location: { id: r.l.id, name: r.l.name, timeZone: r.l.timeZone } }));
      return { practitioner: { id: mine[0]!.id, name: mine[0]!.name }, date: day, items };
    });

    // ───────── Recurring series ─────────
    priv.post('/orgs/:orgId/wellness/series', {
      schema: {
        tags: ['wellness'], security: secured, params: orgParams, summary: 'Weekly series in local wall-clock time; dryRun previews conflicts per date; all_or_nothing books nothing if any date conflicts',
        body: z.object({ locationId: z.uuid(), serviceId: z.uuid(), variantId: z.uuid().optional(), practitionerId: z.uuid().optional(), customerId: z.uuid(), firstDate: ymd, localTime: hhmm, intervalWeeks: z.number().int().min(1).max(8).default(1), occurrences: z.number().int().min(2).max(26), mode: z.enum(['all_or_nothing', 'skip_conflicts']).default('skip_conflicts'), dryRun: z.boolean().default(false) }),
      },
    }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, req.body.customerId), eq(customers.organizationId, req.params.orgId)));
      if (!c) throw notFound('Client');
      const r = await createSeries(s.db, { ...req.body, organizationId: req.params.orgId, actorUserId: req.user!.id });
      return reply.code(req.body.dryRun ? 200 : 201).send(r);
    });

    priv.get('/orgs/:orgId/wellness/series/:id', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [sr] = await s.db.select().from(wellnessSeries).where(and(eq(wellnessSeries.id, req.params.id), eq(wellnessSeries.organizationId, req.params.orgId)));
      if (!sr) throw notFound('Series');
      await requireLocationPerm(req, s.db, sr.organizationId, sr.locationId, 'operations.read');
      const rows = await s.db.select().from(appointments).where(and(eq(appointments.seriesId, sr.id), ne(appointments.status, 'rescheduled'))).orderBy(asc(appointments.startsAt));
      return { series: sr, appointments: rows.map(serializeAppointment) };
    });

    priv.post('/orgs/:orgId/wellness/series/:id/cancel', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ byBusiness: z.boolean().default(false) }) } }, async (req) => {
      const [sr] = await s.db.select().from(wellnessSeries).where(and(eq(wellnessSeries.id, req.params.id), eq(wellnessSeries.organizationId, req.params.orgId)));
      if (!sr) throw notFound('Series');
      await requireLocationPerm(req, s.db, sr.organizationId, sr.locationId, 'operations.write');
      const future = await s.db.select().from(appointments).where(and(eq(appointments.seriesId, sr.id), eq(appointments.status, 'confirmed'), gt(appointments.startsAt, new Date())));
      const results = [];
      for (const a of future) {
        try { results.push({ id: a.id, ...(await applyCancellation(s, a.id, { organizationId: req.params.orgId, mode: req.body.byBusiness ? 'business' : 'auto', actorUserId: req.user!.id, reason: 'Series cancelled' })).preview, status: 'cancelled' }); }
        catch (err) { results.push({ id: a.id, status: 'failed', error: (err as Error).message }); }
      }
      await s.db.update(wellnessSeries).set({ status: 'cancelled' }).where(eq(wellnessSeries.id, sr.id));
      return { cancelled: results.filter((r) => r.status === 'cancelled').length, results };
    });

    // ───────── Waitlist ─────────
    priv.get('/orgs/:orgId/wellness/waitlist', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.enum(['waiting', 'offered', 'booked', 'left', 'expired', 'open']).default('open') }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const conds = [eq(wellnessWaitlist.organizationId, req.params.orgId), req.query.status === 'open' ? inArray(wellnessWaitlist.status, ['waiting', 'offered']) : eq(wellnessWaitlist.status, req.query.status)];
      if (req.query.locationId) conds.push(eq(wellnessWaitlist.locationId, req.query.locationId));
      const custAllowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const rows = await s.db.select({ w: wellnessWaitlist, c: customers.name, svc: services.name }).from(wellnessWaitlist).innerJoin(customers, eq(customers.id, wellnessWaitlist.customerId)).innerJoin(services, eq(services.id, wellnessWaitlist.serviceId)).where(and(...conds)).orderBy(asc(wellnessWaitlist.createdAt));
      return { items: rows.filter((r) => allowed === 'all' || allowed.has(r.w.locationId)).map((r) => ({ ...serializeWaitlist(r.w), serviceName: r.svc, clientName: custAllowed === 'all' || custAllowed.has(r.w.locationId) ? r.c : null })) };
    });

    priv.post('/orgs/:orgId/wellness/waitlist', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), serviceId: z.uuid(), variantId: z.uuid().optional(), practitionerId: z.uuid().optional(), customerId: z.uuid().optional(), contact: publicContactSchema.optional(), windowStart: isoDateTime, windowEnd: isoDateTime, note: z.string().max(300).optional() }) },
    }, async (req, reply) => {
      const l = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
      await loadService(req.params.orgId, req.body.serviceId);
      const customerId = req.body.customerId ?? (req.body.contact ? (await findOrCreateCustomer(s.db, req.params.orgId, l.id, req.body.contact, 'staff')).id : null);
      if (!customerId) throw validationError('Provide customerId or contact', { customerId: 'Required' });
      const r = await joinWaitlist(s.db, { organizationId: req.params.orgId, locationId: l.id, serviceId: req.body.serviceId, variantId: req.body.variantId, practitionerId: req.body.practitionerId, customerId, windowStart: new Date(req.body.windowStart), windowEnd: new Date(req.body.windowEnd), note: req.body.note });
      return reply.code(201).send(serializeWaitlist(r.entry));
    });

    priv.post('/orgs/:orgId/wellness/waitlist/:id/book', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime.optional(), practitionerId: z.uuid().optional() }) } }, async (req, reply) => {
      const [w] = await s.db.select().from(wellnessWaitlist).where(and(eq(wellnessWaitlist.id, req.params.id), eq(wellnessWaitlist.organizationId, req.params.orgId)));
      if (!w) throw notFound('Waitlist entry');
      const l = await requireLocationPerm(req, s.db, w.organizationId, w.locationId, 'operations.write');
      if (!['waiting', 'offered'].includes(w.status)) throw conflict('waitlist_closed', `This entry is ${w.status}`);
      const startsAt = req.body.startsAt ? new Date(req.body.startsAt) : w.offeredStartsAt;
      if (!startsAt) throw validationError('Choose a time', { startsAt: 'Required' });
      const r = await bookAppointment(s, { loc: l, serviceId: w.serviceId, variantId: w.variantId, practitionerId: req.body.practitionerId ?? w.offeredPractitionerId ?? w.practitionerId, customerId: w.customerId, startsAt, source: 'waitlist', online: false, actorUserId: req.user!.id, collectDeposit: false });
      await s.db.update(wellnessWaitlist).set({ status: 'booked', appointmentId: r.appointment.id, updatedAt: new Date() }).where(eq(wellnessWaitlist.id, w.id));
      return reply.code(201).send(r);
    });

    priv.post('/orgs/:orgId/wellness/waitlist/:id/remove', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [w] = await s.db.select().from(wellnessWaitlist).where(and(eq(wellnessWaitlist.id, req.params.id), eq(wellnessWaitlist.organizationId, req.params.orgId)));
      if (!w) throw notFound('Waitlist entry');
      await requireLocationPerm(req, s.db, w.organizationId, w.locationId, 'operations.write');
      const [row] = await s.db.update(wellnessWaitlist).set({ status: 'left', updatedAt: new Date() }).where(eq(wellnessWaitlist.id, w.id)).returning();
      return serializeWaitlist(row!);
    });

    // ───────── Packages ─────────
    priv.get('/orgs/:orgId/wellness/package-plans', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.organizationId, req.params.orgId)).orderBy(asc(wellnessPackagePlans.name));
      const sold = rows.length ? await s.db.select({ planId: wellnessClientPackages.planId, n: sql<number>`count(*)::int` }).from(wellnessClientPackages).where(and(inArray(wellnessClientPackages.planId, rows.map((r) => r.id)), ne(wellnessClientPackages.status, 'pending_payment'))).groupBy(wellnessClientPackages.planId) : [];
      return { items: rows.filter((p) => !p.locationId || allowed === 'all' || allowed.has(p.locationId)).map((p) => ({ ...serializePlan(p), sold: sold.find((x) => x.planId === p.id)?.n ?? 0 })) };
    });

    const planBody = z.object({ locationId: z.uuid().nullable().optional(), name: z.string().min(1).max(120), description: z.string().max(1000).optional(), serviceId: z.uuid(), variantId: z.uuid().nullable().optional(), sessions: z.number().int().min(1).max(100), priceMinor: z.number().int().min(0), currency: z.string().length(3), validityDays: z.number().int().min(1).max(1825).default(365), sharing: z.enum(['personal', 'shareable']).default('personal'), maxSharedWith: z.number().int().min(0).max(5).default(0), onlinePurchasable: z.boolean().default(true) });
    priv.post('/orgs/:orgId/wellness/package-plans', { schema: { tags: ['wellness'], security: secured, params: orgParams, body: planBody } }, async (req, reply) => {
      const b = req.body;
      const svc = await loadService(req.params.orgId, b.serviceId);
      if (b.locationId) {
        const l = await requireLocationPerm(req, s.db, req.params.orgId, b.locationId, 'operations.write');
        if (l.currency !== b.currency.toUpperCase()) throw validationError(`Packages at ${l.name} are priced in ${l.currency}`, { currency: 'Must match the location currency' });
      } else await requirePerm(req, s.db, 'operations.write', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      if (b.variantId) {
        const [v] = await s.db.select().from(wellnessServiceVariants).where(and(eq(wellnessServiceVariants.id, b.variantId), eq(wellnessServiceVariants.serviceId, svc.id)));
        if (!v) throw validationError('Unknown option for this service', { variantId: 'Not found' });
      }
      const [row] = await s.db.insert(wellnessPackagePlans).values({ organizationId: req.params.orgId, ...b, locationId: b.locationId ?? null, variantId: b.variantId ?? null, description: b.description ?? null, currency: b.currency.toUpperCase(), maxSharedWith: b.sharing === 'personal' ? 0 : b.maxSharedWith }).returning();
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'wellness.package_plan_created', targetType: 'package_plan', targetId: row!.id });
      return reply.code(201).send(serializePlan(row!));
    });

    priv.patch('/orgs/:orgId/wellness/package-plans/:id', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(1000).nullable().optional(), priceMinor: z.number().int().min(0).optional(), validityDays: z.number().int().min(1).max(1825).optional(), onlinePurchasable: z.boolean().optional(), active: z.boolean().optional() }) } }, async (req) => {
      const [p] = await s.db.select().from(wellnessPackagePlans).where(and(eq(wellnessPackagePlans.id, req.params.id), eq(wellnessPackagePlans.organizationId, req.params.orgId)));
      if (!p) throw notFound('Package');
      if (p.locationId) await requireLocationPerm(req, s.db, p.organizationId, p.locationId, 'operations.write');
      else await requirePerm(req, s.db, 'operations.write', { organizationId: p.organizationId, kind: 'organization', id: p.organizationId });
      const [row] = await s.db.update(wellnessPackagePlans).set(req.body).where(eq(wellnessPackagePlans.id, p.id)).returning();
      return serializePlan(row!);
    });

    priv.get('/orgs/:orgId/wellness/client-packages', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ customerId: z.uuid().optional(), status: z.string().optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const conds = [eq(wellnessClientPackages.organizationId, req.params.orgId), ne(wellnessClientPackages.status, 'pending_payment')];
      if (req.query.customerId) conds.push(or(eq(wellnessClientPackages.customerId, req.query.customerId), sql`${wellnessClientPackages.sharedWithCustomerIds} ? ${req.query.customerId}`)!);
      const rows = await s.db.select({ cp: wellnessClientPackages, plan: wellnessPackagePlans, c: customers.name }).from(wellnessClientPackages).innerJoin(wellnessPackagePlans, eq(wellnessPackagePlans.id, wellnessClientPackages.planId)).innerJoin(customers, eq(customers.id, wellnessClientPackages.customerId)).where(and(...conds)).orderBy(desc(wellnessClientPackages.createdAt));
      return { items: rows.filter((r) => allowed === 'all' || allowed.has(r.cp.locationId)).map((r) => ({ ...serializeClientPackage(r.cp, r.plan), clientName: r.c })).filter((x) => !req.query.status || x.status === req.query.status) };
    });

    priv.post('/orgs/:orgId/wellness/client-packages', { schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'Sell a package at the desk (paid in person)', body: z.object({ planId: z.uuid(), locationId: z.uuid(), customerId: z.uuid() }) } }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'customers.write');
      const { plan } = await loadPlanFor(s.db, req.params.orgId, req.body.planId, req.body.locationId);
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, req.body.customerId), eq(customers.organizationId, req.params.orgId)));
      if (!c) throw notFound('Client');
      const r = await createClientPackage(s.db, { organizationId: req.params.orgId, locationId: req.body.locationId, plan, customerId: c.id, paidVia: 'in_person', status: 'active' });
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'wellness.package_sold', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'client_package', targetId: r.clientPackage.id, metadata: { priceMinor: plan.priceMinor, currency: plan.currency } });
      return reply.code(201).send(serializeClientPackage(r.clientPackage, plan));
    });

    priv.post('/orgs/:orgId/wellness/client-packages/:id/share', { schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ customerIds: z.array(z.uuid()).max(5) }) } }, async (req) => {
      const [cp] = await s.db.select().from(wellnessClientPackages).where(and(eq(wellnessClientPackages.id, req.params.id), eq(wellnessClientPackages.organizationId, req.params.orgId)));
      if (!cp) throw notFound('Package');
      await requireLocationPerm(req, s.db, cp.organizationId, cp.locationId, 'customers.write');
      const [plan] = await s.db.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.id, cp.planId));
      const ids = [...new Set(req.body.customerIds.filter((x) => x !== cp.customerId))];
      if (plan!.sharing !== 'shareable' && ids.length) throw conflict('package_not_shareable', 'This package is personal and cannot be shared');
      if (ids.length > plan!.maxSharedWith) throw conflict('share_limit', `This package can be shared with up to ${plan!.maxSharedWith} people`);
      if (ids.length) {
        const found = await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.organizationId, cp.organizationId), inArray(customers.id, ids)));
        if (found.length !== ids.length) throw validationError('Unknown client', { customerIds: 'Not found' });
      }
      const [row] = await s.db.update(wellnessClientPackages).set({ sharedWithCustomerIds: ids, updatedAt: new Date() }).where(eq(wellnessClientPackages.id, cp.id)).returning();
      return serializeClientPackage(row!, plan);
    });

    priv.post('/orgs/:orgId/wellness/client-packages/:id/cancel', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [cp] = await s.db.select().from(wellnessClientPackages).where(and(eq(wellnessClientPackages.id, req.params.id), eq(wellnessClientPackages.organizationId, req.params.orgId)));
      if (!cp) throw notFound('Package');
      await requireLocationPerm(req, s.db, cp.organizationId, cp.locationId, 'customers.write');
      const [row] = await s.db.update(wellnessClientPackages).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(wellnessClientPackages.id, cp.id)).returning();
      await audit(s.db, { organizationId: cp.organizationId, ...actor(req), action: 'wellness.package_cancelled', scopeKind: 'location', scopeId: cp.locationId, targetType: 'client_package', targetId: cp.id, metadata: { note: 'Refunds, if any, are made from Payments' } });
      return serializeClientPackage(row!);
    });

    // ───────── Vouchers ─────────
    priv.get('/orgs/:orgId/wellness/vouchers', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ status: z.string().optional(), q: z.string().max(40).optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      if (allowed !== 'all' && !allowed.size) throw forbidden('Missing permission customers.read');
      const conds = [eq(wellnessGiftVouchers.organizationId, req.params.orgId), ne(wellnessGiftVouchers.status, 'pending_payment')];
      if (req.query.q) conds.push(ilike(wellnessGiftVouchers.code, `%${req.query.q.trim()}%`));
      const rows = await s.db.select().from(wellnessGiftVouchers).where(and(...conds)).orderBy(desc(wellnessGiftVouchers.createdAt)).limit(200);
      return { items: rows.filter((v) => allowed === 'all' || !v.locationId || allowed.has(v.locationId)).map((v) => serializeVoucher(v)).filter((v) => !req.query.status || v.status === req.query.status) };
    });

    priv.post('/orgs/:orgId/wellness/vouchers', { schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'Issue a gift voucher sold at the desk (location currency)', body: z.object({ locationId: z.uuid(), amountMinor: z.number().int().min(100), validityDays: z.number().int().min(30).max(1825).default(365), recipientName: z.string().max(120).optional(), recipientEmail: z.string().email().optional(), message: z.string().max(300).optional() }) } }, async (req, reply) => {
      const l = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'customers.write');
      const r = await issueVoucher(s.db, { organizationId: req.params.orgId, locationId: l.id, amountMinor: req.body.amountMinor, currency: l.currency, validityDays: req.body.validityDays, recipientName: req.body.recipientName, recipientEmail: req.body.recipientEmail, message: req.body.message, status: 'active', createdBy: req.user!.id });
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'wellness.voucher_issued', scopeKind: 'location', scopeId: l.id, targetType: 'voucher', targetId: r.voucher.id, metadata: { amountMinor: req.body.amountMinor, currency: l.currency } });
      return reply.code(201).send(serializeVoucher(r.voucher));
    });

    priv.get('/orgs/:orgId/wellness/vouchers/:id', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [v] = await s.db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.id, req.params.id), eq(wellnessGiftVouchers.organizationId, req.params.orgId)));
      if (!v) throw notFound('Voucher');
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      if (!(allowed === 'all' || !v.locationId || allowed.has(v.locationId))) throw forbidden();
      const txs = await s.db.select().from(wellnessVoucherTransactions).where(eq(wellnessVoucherTransactions.voucherId, v.id)).orderBy(asc(wellnessVoucherTransactions.createdAt));
      return { ...serializeVoucher(v), transactions: txs.map((t) => ({ id: t.id, kind: t.kind, amount: { amount: t.amountMinor, currency: v.currency }, balanceAfter: { amount: t.balanceAfterMinor, currency: v.currency }, appointmentId: t.appointmentId, createdAt: t.createdAt.toISOString() })) };
    });

    priv.post('/orgs/:orgId/wellness/vouchers/:id/cancel', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const [v] = await s.db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.id, req.params.id), eq(wellnessGiftVouchers.organizationId, req.params.orgId)));
      if (!v) throw notFound('Voucher');
      if (v.locationId) await requireLocationPerm(req, s.db, v.organizationId, v.locationId, 'customers.write');
      else await requirePerm(req, s.db, 'customers.write', { organizationId: v.organizationId, kind: 'organization', id: v.organizationId });
      const [row] = await s.db.update(wellnessGiftVouchers).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(wellnessGiftVouchers.id, v.id)).returning();
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'wellness.voucher_cancelled', targetType: 'voucher', targetId: v.id });
      return serializeVoucher(row!);
    });

    // ───────── Clients ─────────
    /** Locations where the viewer may see this client: customers.read there, or they are the client's practitioner. */
    const clientAccess = async (req: FastifyRequest, orgId: string, customerId: string) => {
      const readersAt = await authorisedLocations(req, s.db, orgId, 'customers.read');
      const managersAt = await authorisedLocations(req, s.db, orgId, 'customers.write');
      const mine = await s.db.select({ locationId: appointments.locationId }).from(appointments).innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId)).where(and(eq(appointments.customerId, customerId), eq(practitioners.userId, req.user!.id)));
      const v: NoteViewer = { userId: req.user!.id, readersAt, managersAt, myClientLocations: new Set(mine.map((m) => m.locationId)) };
      return v;
    };

    priv.get('/orgs/:orgId/wellness/clients', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ q: z.string().max(80).optional(), locationId: z.uuid().optional() }) } }, async (req) => {
      const { orgId } = req.params;
      const readersAt = await authorisedLocations(req, s.db, orgId, 'customers.read');
      const myPracs = await s.db.select({ id: practitioners.id }).from(practitioners).where(and(eq(practitioners.organizationId, orgId), eq(practitioners.userId, req.user!.id)));
      if (readersAt !== 'all' && !readersAt.size && !myPracs.length) throw forbidden('Missing permission customers.read');
      const conds = [eq(customers.organizationId, orgId), isNull(customers.erasedAt)];
      if (req.query.q) conds.push(or(ilike(customers.name, `%${req.query.q}%`), ilike(customers.email, `%${req.query.q}%`))!);
      const appts = await s.db.select({ customerId: appointments.customerId, locationId: appointments.locationId, practitionerId: appointments.practitionerId, startsAt: appointments.startsAt, status: appointments.status }).from(appointments).where(eq(appointments.organizationId, orgId));
      const rows = await s.db.select().from(customers).where(and(...conds)).orderBy(asc(customers.name)).limit(500);
      const pkgs = await s.db.select({ customerId: wellnessClientPackages.customerId, status: wellnessClientPackages.status, exp: wellnessClientPackages.expiresAt }).from(wellnessClientPackages).where(eq(wellnessClientPackages.organizationId, orgId));
      const now = new Date();
      const items = rows.map((c) => {
        const xs = appts.filter((a) => a.customerId === c.id);
        const locs = new Set([...(c.locationId ? [c.locationId] : []), ...xs.map((a) => a.locationId)]);
        const visible = readersAt === 'all' || [...locs].some((l) => readersAt.has(l)) || xs.some((a) => myPracs.some((p) => p.id === a.practitionerId));
        if (!visible || (req.query.locationId && !locs.has(req.query.locationId))) return null;
        const next = xs.filter((a) => a.status === 'confirmed' && a.startsAt > now).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
        const last = xs.filter((a) => a.status === 'completed' || (a.status === 'confirmed' && a.startsAt <= now)).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
        return { id: c.id, name: c.name, email: c.email, phone: c.phone, locationId: c.locationId, visits: xs.filter((a) => a.status === 'completed').length, nextAppointmentAt: next?.startsAt.toISOString() ?? null, lastVisitAt: last?.startsAt.toISOString() ?? null, activePackages: pkgs.filter((p) => p.customerId === c.id && p.status === 'active' && (!p.exp || p.exp > now)).length };
      }).filter(Boolean);
      return { items };
    });

    priv.get('/orgs/:orgId/wellness/clients/:id', { schema: { tags: ['wellness'], security: secured, params: idParams } }, async (req) => {
      const { orgId, id } = req.params;
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
      if (!c) throw notFound('Client');
      const v = await clientAccess(req, orgId, c.id);
      const appts = await s.db.select({ a: appointments, svc: services.name, p: practitioners.name, l: locations.name, tz: locations.timeZone }).from(appointments).innerJoin(services, eq(services.id, appointments.serviceId)).innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId)).innerJoin(locations, eq(locations.id, appointments.locationId))
        .where(and(eq(appointments.customerId, c.id), ne(appointments.status, 'rescheduled'))).orderBy(desc(appointments.startsAt));
      const locs = new Set([...(c.locationId ? [c.locationId] : []), ...appts.map((a) => a.a.locationId)]);
      const canRead = v.readersAt === 'all' || [...locs].some((l) => (v.readersAt as Set<string>).has(l)) || v.myClientLocations.size > 0;
      if (!canRead) throw forbidden('You can see clients at your locations or the clients you work with');
      const fullContact = v.readersAt === 'all' || [...locs].some((l) => (v.readersAt as Set<string>).has(l));
      const [prefs] = await s.db.select().from(wellnessClientPreferences).where(eq(wellnessClientPreferences.customerId, c.id));
      const pk = await s.db.select({ cp: wellnessClientPackages, plan: wellnessPackagePlans }).from(wellnessClientPackages).innerJoin(wellnessPackagePlans, eq(wellnessPackagePlans.id, wellnessClientPackages.planId)).where(and(eq(wellnessClientPackages.organizationId, orgId), ne(wellnessClientPackages.status, 'pending_payment'), or(eq(wellnessClientPackages.customerId, c.id), sql`${wellnessClientPackages.sharedWithCustomerIds} ? ${c.id}`)));
      const vouchers = await s.db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.organizationId, orgId), eq(wellnessGiftVouchers.purchaserCustomerId, c.id)));
      const notes = (await s.db.select().from(wellnessClientNotes).where(eq(wellnessClientNotes.customerId, c.id)).orderBy(desc(wellnessClientNotes.createdAt))).filter((n) => noteVisible(n, v));
      const charges = await s.db.select().from(wellnessAppointmentCharges).where(inArray(wellnessAppointmentCharges.appointmentId, appts.length ? appts.map((a) => a.a.id) : ['00000000-0000-0000-0000-000000000000']));
      const autoCharges = await (await import('../services/payments-saved.ts')).autoChargeStates(s.db, 'wellness_fee', charges.map((x) => x.id));
      const intakeCount = (await s.db.select({ n: sql<number>`count(*)::int` }).from(intakeResponses).where(eq(intakeResponses.customerId, c.id)))[0]?.n ?? 0;
      const canIntake = (await authorisedLocations(req, s.db, orgId, 'customers.read'));
      return {
        client: { id: c.id, name: c.name, email: fullContact ? c.email : null, phone: fullContact ? c.phone : null, locationId: c.locationId, createdAt: c.createdAt.toISOString() },
        preferences: prefs ? { preferredPractitionerIds: prefs.preferredPractitionerIds, preferredLocationId: prefs.preferredLocationId, preferredChannel: prefs.preferredChannel, comfort: prefs.comfort, updatedAt: prefs.updatedAt.toISOString() } : null,
        appointments: appts.map((r) => ({ ...serializeAppointment(r.a), serviceName: r.svc, practitionerName: r.p, locationName: r.l, timeZone: r.tz })),
        packages: pk.map((r) => serializeClientPackage(r.cp, r.plan)), vouchersPurchased: vouchers.map((x) => serializeVoucher(x)),
        notes: notes.map((n) => ({ id: n.id, body: n.body, confidential: n.confidential, locationId: n.locationId, appointmentId: n.appointmentId, authorUserId: n.authorUserId, mine: n.authorUserId === req.user!.id, createdAt: n.createdAt.toISOString() })),
        charges: charges.map((x) => ({ appointmentId: x.appointmentId, kind: x.kind, fee: { amount: x.feeMinor, currency: x.currency }, outstanding: { amount: x.outstandingMinor, currency: x.currency }, status: x.status, autoCharge: autoCharges.get(x.id) ?? null })),
        intake: { responses: intakeCount, restricted: true, canView: canIntake === 'all' || [...locs].some((l) => (canIntake as Set<string>).has(l)), aiContext: 'excluded' as const },
        stats: { visits: appts.filter((a) => a.a.status === 'completed').length, noShows: appts.filter((a) => a.a.status === 'no_show').length, lateCancellations: appts.filter((a) => a.a.cancellationKind === 'late').length },
      };
    });

    priv.put('/orgs/:orgId/wellness/clients/:id/preferences', {
      schema: { tags: ['wellness'], security: secured, params: idParams, summary: 'Administrative preferences only (practitioner, location, channel, comfort) — never clinical', body: z.object({ preferredPractitionerIds: z.array(z.uuid()).max(5).default([]), preferredLocationId: z.uuid().nullable().optional(), preferredChannel: z.enum(['email', 'sms']).default('email'), comfort: z.array(z.string().min(1).max(80)).max(10).default([]) }) },
    }, async (req) => {
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, req.params.id), eq(customers.organizationId, req.params.orgId)));
      if (!c) throw notFound('Client');
      const v = await clientAccess(req, req.params.orgId, c.id);
      const canWrite = v.managersAt === 'all' || (c.locationId && (v.managersAt as Set<string>).has(c.locationId)) || v.myClientLocations.size > 0;
      if (!canWrite) throw forbidden();
      const vals = { organizationId: req.params.orgId, customerId: c.id, ...req.body, preferredLocationId: req.body.preferredLocationId ?? null, updatedBy: req.user!.id, updatedAt: new Date() };
      const [row] = await s.db.insert(wellnessClientPreferences).values(vals).onConflictDoUpdate({ target: wellnessClientPreferences.customerId, set: vals }).returning();
      return row;
    });

    priv.post('/orgs/:orgId/wellness/clients/:id/notes', {
      schema: { tags: ['wellness'], security: secured, params: idParams, summary: 'Administrative note; confidential notes are visible only to the author and managers', body: z.object({ locationId: z.uuid(), body: z.string().min(1).max(2000), confidential: z.boolean().default(false), appointmentId: z.uuid().optional() }) },
    }, async (req, reply) => {
      const [c] = await s.db.select().from(customers).where(and(eq(customers.id, req.params.id), eq(customers.organizationId, req.params.orgId)));
      if (!c) throw notFound('Client');
      const v = await clientAccess(req, req.params.orgId, c.id);
      const allowed = v.managersAt === 'all' || (v.managersAt as Set<string>).has(req.body.locationId) || v.myClientLocations.has(req.body.locationId);
      if (!allowed) throw forbidden('Only managers and the client’s practitioners can add notes');
      const [n] = await s.db.insert(wellnessClientNotes).values({ organizationId: req.params.orgId, customerId: c.id, locationId: req.body.locationId, appointmentId: req.body.appointmentId ?? null, authorUserId: req.user!.id, body: req.body.body, confidential: req.body.confidential }).returning();
      await audit(s.db, { organizationId: req.params.orgId, ...actor(req), action: 'wellness.note_added', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'customer', targetId: c.id, metadata: { confidential: req.body.confidential } });
      return reply.code(201).send({ id: n!.id, body: n!.body, confidential: n!.confidential, locationId: n!.locationId, createdAt: n!.createdAt.toISOString(), mine: true });
    });

    // ───────── Reminders, reports ─────────
    priv.post('/orgs/:orgId/wellness/reminders/run', { schema: { tags: ['wellness'], security: secured, params: orgParams, summary: 'Run reminders, retention prompts and expiry now (idempotent; consent-aware)' } }, async (req) => {
      await requirePerm(req, s.db, 'operations.write', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      const expired = await expireStale(s.db);
      return { reminders: await runReminders(s, { organizationId: req.params.orgId }), rebookPrompts: await runRebookPrompts(s, { organizationId: req.params.orgId }), expired };
    });

    priv.get('/orgs/:orgId/wellness/messages', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ customerId: z.uuid().optional(), kind: z.string().optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const conds = [eq(wellnessMessageLog.organizationId, req.params.orgId)];
      if (req.query.customerId) conds.push(eq(wellnessMessageLog.customerId, req.query.customerId));
      if (req.query.kind) conds.push(eq(wellnessMessageLog.kind, req.query.kind));
      const rows = await s.db.select().from(wellnessMessageLog).where(and(...conds)).orderBy(desc(wellnessMessageLog.createdAt)).limit(200);
      return { items: rows.filter((r) => allowed === 'all' || (r.locationId && allowed.has(r.locationId))).map((r) => ({ id: r.id, kind: r.kind, channel: r.channel, status: r.status, appointmentId: r.appointmentId, customerId: r.customerId, locationId: r.locationId, createdAt: r.createdAt.toISOString() })) };
    });

    const reportQuery = z.object({ from: ymd, to: ymd, locationId: z.uuid().optional() });
    const reportLocations = async (req: FastifyRequest, orgId: string, locationId?: string) => {
      const allowed = await authorisedLocations(req, s.db, orgId, 'reports.read');
      const locs = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
      const ids = locs.map((l) => l.id).filter((l) => (allowed === 'all' || allowed.has(l)) && (!locationId || l === locationId));
      if (!ids.length) throw forbidden('Missing permission reports.read in this scope');
      return ids;
    };

    priv.get('/orgs/:orgId/wellness/reports', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: reportQuery, summary: 'Utilisation per practitioner/room, cancellations, revenue per currency, package and voucher liability' } }, async (req) => {
      if (req.query.to < req.query.from) throw validationError('`to` must not be before `from`', { to: 'Before from' });
      const ids = await reportLocations(req, req.params.orgId, req.query.locationId);
      return wellnessReport(s.db, { organizationId: req.params.orgId, locationIds: ids, from: req.query.from, to: req.query.to, viewer: await viewerFor(req, req.params.orgId) });
    });

    priv.get('/orgs/:orgId/wellness/utilisation', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: reportQuery } }, async (req) => {
      const ids = await reportLocations(req, req.params.orgId, req.query.locationId);
      return utilisation(s.db, { organizationId: req.params.orgId, locationIds: ids, from: req.query.from, to: req.query.to, viewer: await viewerFor(req, req.params.orgId) });
    });

    // ───────── AI drafts (proposals only) ─────────
    priv.post('/orgs/:orgId/wellness/ai/service-copy', { schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ serviceId: z.uuid(), tone: z.enum(['calm', 'friendly', 'concise']).default('calm') }) } }, async (req, reply) => {
      const svc = await loadService(req.params.orgId, req.body.serviceId);
      await requirePerm(req, s.db, 'ai.use', svc.locationId ? { organizationId: svc.organizationId, kind: 'location', id: svc.locationId } : { organizationId: svc.organizationId, kind: 'organization', id: svc.organizationId });
      return reply.code(201).send(serializeDraft(await draftServiceCopy(s, { organizationId: req.params.orgId, serviceId: svc.id, tone: req.body.tone, userId: req.user!.id })));
    });

    priv.post('/orgs/:orgId/wellness/ai/policy-reply', { schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), serviceId: z.uuid().optional(), enquiry: z.string().min(3).max(2000) }) } }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'ai.use');
      return reply.code(201).send(serializeDraft(await draftPolicyReply(s, { organizationId: req.params.orgId, locationId: req.body.locationId, serviceId: req.body.serviceId, enquiry: req.body.enquiry, userId: req.user!.id })));
    });

    priv.post('/orgs/:orgId/wellness/ai/appointment-summary', { schema: { tags: ['wellness'], security: secured, params: orgParams, body: reportQuery } }, async (req, reply) => {
      const ids = await reportLocations(req, req.params.orgId, req.body.locationId);
      await requirePerm(req, s.db, 'ai.use', req.body.locationId ? { organizationId: req.params.orgId, kind: 'location', id: req.body.locationId } : { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      const report = await wellnessReport(s.db, { organizationId: req.params.orgId, locationIds: ids, from: req.body.from, to: req.body.to, viewer: { userId: req.user!.id, customersAt: new Set() } });
      // Aggregates only: utilisation rows carry practitioner/room names and minutes, never client data.
      return reply.code(201).send(serializeDraft(await draftAppointmentSummary(s, { organizationId: req.params.orgId, locationId: req.body.locationId ?? null, report: plain(report) as Record<string, unknown>, userId: req.user!.id })));
    });

    priv.get('/orgs/:orgId/wellness/ai/drafts', { schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ kind: z.string().optional() }) } }, async (req) => {
      await requirePerm(req, s.db, 'ai.use', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId }).catch(async () => { await authorisedLocations(req, s.db, req.params.orgId, 'ai.use'); });
      const conds = [eq(wellnessAiDrafts.organizationId, req.params.orgId), eq(wellnessAiDrafts.createdBy, req.user!.id)];
      if (req.query.kind) conds.push(eq(wellnessAiDrafts.kind, req.query.kind));
      return { items: (await s.db.select().from(wellnessAiDrafts).where(and(...conds)).orderBy(desc(wellnessAiDrafts.createdAt)).limit(50)).map(serializeDraft) };
    });

    priv.post('/orgs/:orgId/wellness/ai/drafts/:id/decision', { schema: { tags: ['wellness'], security: secured, params: idParams, summary: 'Apply (service copy → saved as the service description) or discard a draft. Replies are never sent automatically.', body: z.object({ decision: z.enum(['apply', 'discard']), editedText: z.string().max(4000).optional() }) } }, async (req) => {
      const [d] = await s.db.select().from(wellnessAiDrafts).where(and(eq(wellnessAiDrafts.id, req.params.id), eq(wellnessAiDrafts.organizationId, req.params.orgId)));
      if (!d) throw notFound('Draft');
      if (d.status !== 'proposed') throw conflict('already_decided', `This draft is already ${d.status}`);
      let result: Record<string, unknown> = {};
      if (req.body.decision === 'apply' && d.kind === 'service_copy' && d.targetId) {
        const svc = await loadService(req.params.orgId, d.targetId);
        await requireServiceWrite(req, svc);
        const { screenHealthClaims } = await import('../services/wellness-ai.ts');
        const text = screenHealthClaims(req.body.editedText ?? d.output);
        if (text.removed.length) throw conflict('health_claims', 'The text contains health claims. Remove them before applying.', { removed: text.removed });
        await s.db.update(services).set({ description: text.text, updatedAt: new Date() }).where(eq(services.id, svc.id));
        await audit(s.db, { organizationId: svc.organizationId, ...actor(req), actorType: 'user', action: 'wellness.ai_copy_applied', targetType: 'service', targetId: svc.id, metadata: { draftId: d.id } });
        result = { serviceId: svc.id, description: text.text };
      } else if (req.body.decision === 'apply' && d.createdBy !== req.user!.id) throw forbidden('Only the person who asked for this draft can mark it used');
      const [row] = await s.db.update(wellnessAiDrafts).set({ status: req.body.decision === 'apply' ? 'applied' : 'discarded', decidedBy: req.user!.id, decidedAt: new Date() }).where(eq(wellnessAiDrafts.id, d.id)).returning();
      return { draft: serializeDraft(row!), result };
    });

  });
};
