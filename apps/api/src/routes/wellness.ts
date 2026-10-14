import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { appointments, locations, practitioners, resources, services } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { createPaymentForTarget, reverseTargetPayment } from '../services/payments.ts';
import { availability, rescheduleAppointment, reserveAppointment, serializeAppointment } from '../services/wellness.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const weekly = z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^(\d{2}:\d{2}|24:00)$/) }));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const wellnessRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  // ───────── Public ─────────
  app.get('/public/wellness/:locationId/services', { schema: { tags: ['wellness'], params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const rows = await s.db.select().from(services).where(and(eq(services.organizationId, loc.organizationId), eq(services.active, true)));
    const pracs = await s.db.select({ id: practitioners.id, name: practitioners.name, serviceIds: practitioners.serviceIds }).from(practitioners).where(and(eq(practitioners.locationId, loc.id), eq(practitioners.active, true)));
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency },
      items: rows.filter((r) => (!r.locationId || r.locationId === loc.id) && r.currency === loc.currency).map((r) => ({
        id: r.id, name: r.name, description: r.description, durationMinutes: r.durationMinutes, price: { amount: r.priceMinor, currency: r.currency }, deposit: { amount: r.depositMinor, currency: r.currency },
        cancellationPolicy: r.cancellationPolicy, practitioners: pracs.filter((p) => p.serviceIds.includes(r.id)).map((p) => ({ id: p.id, name: p.name })),
      })),
    };
  });

  app.get('/public/wellness/:locationId/availability', {
    schema: { tags: ['wellness'], summary: 'Open slots for a service on a local date (practitioner optional = any available)', params: z.object({ locationId: z.uuid() }), querystring: z.object({ serviceId: z.uuid(), date, practitionerId: z.uuid().optional() }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    return availability(s.db, { organizationId: loc.organizationId, locationId: loc.id, ...req.query });
  });

  app.post('/public/wellness/:locationId/appointments', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: { tags: ['wellness'], summary: 'Book an appointment: secures practitioner and required resource atomically', params: z.object({ locationId: z.uuid() }), body: z.object({ serviceId: z.uuid(), practitionerId: z.uuid().optional(), startsAt: isoDateTime, contact: publicContactSchema }) },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const [svc] = await s.db.select().from(services).where(and(eq(services.id, req.body.serviceId), eq(services.organizationId, loc.organizationId)));
    if (!svc) throw notFound('Service');
    const charge = svc.depositMinor > 0 ? svc.depositMinor : 0;
    if (charge > 0 && !loc.paymentsEnabled) throw conflict('payments_not_enabled', 'Online booking with a deposit is not available at this location yet');
    const customer = await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.contact, 'appointment');
    const r = await s.db.transaction((tx) => reserveAppointment(tx, { organizationId: loc.organizationId, locationId: loc.id, serviceId: svc.id, practitionerId: req.body.practitionerId, customerId: customer.id, startsAt: new Date(req.body.startsAt) }));
    await audit(s.db, { organizationId: loc.organizationId, actorUserId: null, actorType: 'system', action: 'appointment.booked', scopeKind: 'location', scopeId: loc.id, targetType: 'appointment', targetId: r.appointment.id });
    let payment = null;
    if (charge > 0) {
      const p = await createPaymentForTarget(s, { organizationId: loc.organizationId, locationId: loc.id, amountMinor: charge, currency: svc.currency, targetType: 'appointment', targetId: r.appointment.id, description: `Deposit: ${svc.name}` });
      payment = { id: p.payment.id, clientSecret: p.clientSecret, amount: charge, currency: svc.currency, sandbox: p.sandbox };
    }
    return reply.code(201).send({ appointment: serializeAppointment(r.appointment), manageToken: r.manageToken, payment, location: { timeZone: loc.timeZone, name: loc.name } });
  });

  app.post('/public/wellness/appointments/:id/reschedule', {
    schema: { tags: ['wellness'], summary: 'Reschedule: the new slot is secured before the old one is released; on failure the original is kept', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10), startsAt: isoDateTime, practitionerId: z.uuid().nullable().optional() }) },
  }, async (req) => {
    const [a] = await s.db.select().from(appointments).where(eq(appointments.id, req.params.id));
    if (!a || a.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Appointment');
    const r = await rescheduleAppointment(s.db, a.id, { startsAt: new Date(req.body.startsAt), practitionerId: req.body.practitionerId, actorUserId: null });
    return { appointment: serializeAppointment(r.appointment), previousAppointmentId: r.previous.id, manageToken: r.manageToken, priceChange: r.priceChange };
  });

  app.post('/public/wellness/appointments/:id/cancel', {
    schema: { tags: ['wellness'], params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) },
  }, async (req) => {
    const [a] = await s.db.select().from(appointments).where(eq(appointments.id, req.params.id));
    if (!a || a.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Appointment');
    if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
    await s.db.update(appointments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(appointments.id, a.id));
    // Deposit refunds follow the service cancellation policy; staff decide via the payments screen.
    return { id: a.id, status: 'cancelled' };
  });

  // ───────── Staff ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/wellness/services', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      return { items: await s.db.select().from(services).where(eq(services.organizationId, req.params.orgId)) };
    });

    priv.post('/orgs/:orgId/wellness/services', {
      schema: {
        tags: ['wellness'], security: secured, params: orgParams,
        body: z.object({ locationId: z.uuid(), name: z.string().min(1), description: z.string().optional(), durationMinutes: z.number().int().min(5).max(600), bufferBeforeMinutes: z.number().int().min(0).max(120).default(0), bufferAfterMinutes: z.number().int().min(0).max(120).default(0), priceMinor: z.number().int().min(0), depositMinor: z.number().int().min(0).default(0), requiredResourceType: z.string().optional(), cancellationPolicy: z.string().max(2000).optional() }),
      },
    }, async (req, reply) => {
      const l = await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
      if (req.body.depositMinor > req.body.priceMinor) throw validationError('Deposit cannot exceed price', { depositMinor: 'Too high' });
      const [row] = await s.db.insert(services).values({ organizationId: req.params.orgId, ...req.body, description: req.body.description ?? null, requiredResourceType: req.body.requiredResourceType ?? null, cancellationPolicy: req.body.cancellationPolicy ?? null, currency: l.currency }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/wellness/practitioners', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(practitioners).where(eq(practitioners.organizationId, req.params.orgId));
      return { items: rows.filter((p) => allowed === 'all' || allowed.has(p.locationId)) };
    });

    priv.post('/orgs/:orgId/wellness/practitioners', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), name: z.string().min(1), userId: z.uuid().optional(), serviceIds: z.array(z.uuid()).default([]), availability: weekly.default([]) }) },
    }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
      if (req.body.serviceIds.length) {
        const svc = await s.db.select({ id: services.id }).from(services).where(and(eq(services.organizationId, req.params.orgId), inArray(services.id, req.body.serviceIds)));
        if (svc.length !== req.body.serviceIds.length) throw validationError('Unknown service', { serviceIds: 'Some services were not found' });
      }
      const [row] = await s.db.insert(practitioners).values({ organizationId: req.params.orgId, ...req.body, userId: req.body.userId ?? null }).returning();
      return reply.code(201).send(row);
    });

    priv.post('/orgs/:orgId/wellness/resources', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), name: z.string().min(1), type: z.string().min(1).default('room') }) },
    }, async (req, reply) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.body.locationId, 'operations.write');
      const [row] = await s.db.insert(resources).values({ organizationId: req.params.orgId, ...req.body }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/wellness/resources', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(resources).where(eq(resources.organizationId, req.params.orgId));
      return { items: rows.filter((p) => allowed === 'all' || allowed.has(p.locationId)) };
    });

    priv.get('/orgs/:orgId/wellness/appointments', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), practitionerId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 8 * 86400_000);
      const conds = [eq(appointments.organizationId, req.params.orgId), gte(appointments.startsAt, from), lt(appointments.startsAt, to)];
      if (req.query.locationId) conds.push(eq(appointments.locationId, req.query.locationId));
      if (req.query.practitionerId) conds.push(eq(appointments.practitionerId, req.query.practitionerId));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(appointments.locationId, [...allowed]));
      }
      const rows = await s.db.select().from(appointments).where(and(...conds)).orderBy(asc(appointments.startsAt));
      return { items: rows.map(serializeAppointment) };
    });

    priv.post('/orgs/:orgId/wellness/appointments', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), serviceId: z.uuid(), practitionerId: z.uuid().optional(), startsAt: isoDateTime, customerId: z.uuid().optional(), contact: publicContactSchema.optional(), outsideAvailability: z.boolean().default(false) }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const l = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'operations.write');
      const customerId = req.body.customerId ?? (req.body.contact ? (await findOrCreateCustomer(s.db, orgId, l.id, req.body.contact, 'staff')).id : null);
      if (!customerId) throw validationError('Provide customerId or contact', { customerId: 'Required' });
      const r = await s.db.transaction(async (tx) => {
        const res = await reserveAppointment(tx, { organizationId: orgId, locationId: l.id, serviceId: req.body.serviceId, practitionerId: req.body.practitionerId, customerId, startsAt: new Date(req.body.startsAt), enforceAvailability: !req.body.outsideAvailability });
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'appointment.booked', scopeKind: 'location', scopeId: l.id, targetType: 'appointment', targetId: res.appointment.id });
        return res;
      });
      return reply.code(201).send({ appointment: serializeAppointment(r.appointment), manageToken: r.manageToken });
    });

    priv.post('/orgs/:orgId/wellness/appointments/:id/reschedule', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime, practitionerId: z.uuid().nullable().optional() }), summary: 'Transactional reschedule; failure keeps the original appointment' },
    }, async (req) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.params.id), eq(appointments.organizationId, req.params.orgId)));
      if (!a) throw notFound('Appointment');
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      const r = await rescheduleAppointment(s.db, a.id, { organizationId: req.params.orgId, startsAt: new Date(req.body.startsAt), practitionerId: req.body.practitionerId, actorUserId: req.user!.id });
      return { appointment: serializeAppointment(r.appointment), previousAppointmentId: r.previous.id, priceChange: r.priceChange };
    });

    priv.post('/orgs/:orgId/wellness/appointments/:id/cancel', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ refundDeposit: z.boolean().default(false), reason: z.string().max(500).optional() }) },
    }, async (req) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.params.id), eq(appointments.organizationId, req.params.orgId)));
      if (!a) throw notFound('Appointment');
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
      await s.db.update(appointments).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(appointments.id, a.id));
      await audit(s.db, { organizationId: a.organizationId, ...actor(req), action: 'appointment.cancelled', scopeKind: 'location', scopeId: a.locationId, targetType: 'appointment', targetId: a.id, metadata: { reason: req.body.reason } });
      const payment = req.body.refundDeposit ? await reverseTargetPayment(s, a.paymentId, req.user!.id, req.body.reason ?? 'Appointment cancelled') : { action: 'none' };
      return { id: a.id, status: 'cancelled', payment };
    });
  });
};
