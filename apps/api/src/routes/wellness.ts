import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Services } from '../context.ts';
import { appointments, consentRecords, customers, locations, practitioners, resources, services, wellnessServiceVariants, wellnessVariantPrices, wellnessPractitionerLocations } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { createPaymentForTarget } from '../services/payments.ts';
import { applyCancellation, redeemPackage, redeemVoucher } from '../services/wellness-commerce.ts';
import { offerFreedTime, REMINDER_PURPOSES } from '../services/wellness-ops.ts';
import {
  availability, cancellationPreview, groupMembers, policyOf, practitionersAt, rescheduleAppointment, reserveAppointment, resolvePricing, serializeAppointment, type AppointmentRow,
} from '../services/wellness.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

const weekly = z.array(z.object({ weekday: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^(\d{2}:\d{2}|24:00)$/) }));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const policySchema = z.object({ freeCancelHours: z.number().int().min(0).max(24 * 14), lateCancelFeePercent: z.number().int().min(0).max(100), noShowFeePercent: z.number().int().min(0).max(100), depositRefundable: z.boolean() });
export const depositRuleSchema = z.object({ kind: z.enum(['none', 'fixed', 'percent']), value: z.number().min(0) });
const consentsSchema = z.object({ smsReminders: z.boolean().optional(), emailReminders: z.boolean().optional() }).optional();

/** Services a location offers, with variants priced in the location currency. */
export async function serviceMenu(db: Services['db'], loc: typeof locations.$inferSelect, opts: { onlineOnly: boolean }) {
  const rows = (await db.select().from(services).where(and(eq(services.organizationId, loc.organizationId), eq(services.active, true), or(isNull(services.locationId), eq(services.locationId, loc.id))))).filter((r) => !opts.onlineOnly || r.onlineBookable);
  const variants = rows.length ? await db.select().from(wellnessServiceVariants).where(and(inArray(wellnessServiceVariants.serviceId, rows.map((r) => r.id)), eq(wellnessServiceVariants.active, true))).orderBy(asc(wellnessServiceVariants.sortOrder)) : [];
  const prices = variants.length ? await db.select().from(wellnessVariantPrices).where(and(inArray(wellnessVariantPrices.variantId, variants.map((v) => v.id)), eq(wellnessVariantPrices.locationId, loc.id))) : [];
  const pracs = await practitionersAt(db, loc.organizationId, loc.id);
  const out = [];
  for (const r of rows) {
    const base = await resolvePricing(db, r, loc).catch(() => null);
    if (!base) continue;
    const vs = variants.filter((v) => v.serviceId === r.id).map((v) => ({ v, price: prices.find((p) => p.variantId === v.id) })).filter((x) => !!x.price);
    out.push({
      id: r.id, name: r.name, description: r.description, category: r.category, durationMinutes: base.durationMinutes, onlineBookable: r.onlineBookable,
      price: { amount: base.priceMinor, currency: base.currency }, deposit: { amount: base.depositMinor, currency: base.currency },
      variants: vs.map(({ v, price }) => ({ id: v.id, name: v.name, durationMinutes: v.durationMinutes, price: { amount: price!.priceMinor, currency: price!.currency }, deposit: { amount: price!.depositMinor ?? (base.variantId === v.id ? base.depositMinor : Math.round(base.depositMinor * (price!.priceMinor / Math.max(1, base.priceMinor)))), currency: price!.currency } })),
      practitionersRequired: r.practitionersRequired, cancellationPolicy: r.cancellationPolicy, policy: policyOf(r),
      practitioners: pracs.filter((p) => p.p.serviceIds.includes(r.id)).map((p) => ({ id: p.p.id, name: p.p.name })),
    });
  }
  return out;
}

export interface BookInput {
  loc: typeof locations.$inferSelect;
  serviceId: string;
  variantId?: string | null;
  practitionerId?: string | null;
  practitionerIds?: string[] | null;
  customerId: string;
  partnerCustomerId?: string | null;
  startsAt: Date;
  voucherCode?: string | null;
  packageId?: string | null;
  source: string;
  online: boolean;
  enforceAvailability?: boolean;
  actorUserId: string | null;
  collectDeposit: boolean;
}

/** Reserve + redeem package/voucher atomically; then take the deposit online when due. */
export async function bookAppointment(s: Services, input: BookInput) {
  const { loc } = input;
  const done = await s.db.transaction(async (tx) => {
    const res = await reserveAppointment(tx, {
      organizationId: loc.organizationId, locationId: loc.id, serviceId: input.serviceId, variantId: input.variantId, practitionerId: input.practitionerId, practitionerIds: input.practitionerIds,
      customerId: input.customerId, partnerCustomerId: input.partnerCustomerId, startsAt: input.startsAt, source: input.source, online: input.online, enforceAvailability: input.enforceAvailability,
    });
    let members: AppointmentRow[] = res.appointments;
    const reload = async () => (members = await tx.select().from(appointments).where(inArray(appointments.id, members.map((m) => m.id))).orderBy(asc(appointments.createdAt)));
    let pkg = null;
    let voucher = null;
    if (input.packageId) { pkg = await redeemPackage(tx, { organizationId: loc.organizationId, clientPackageId: input.packageId, members, customerId: input.customerId }); await reload(); }
    if (input.voucherCode) { voucher = await redeemVoucher(tx, { organizationId: loc.organizationId, code: input.voucherCode, members, actorUserId: input.actorUserId }); await reload(); }
    if (members.length > 1) {
      const total = members.reduce((a, m) => a + m.depositMinor, 0);
      await tx.update(appointments).set({ depositMinor: total }).where(eq(appointments.id, members[0]!.id));
      await tx.update(appointments).set({ depositMinor: 0 }).where(inArray(appointments.id, members.slice(1).map((m) => m.id)));
      await reload();
    }
    await audit(tx, { organizationId: loc.organizationId, actorUserId: input.actorUserId, actorType: input.actorUserId ? 'user' : 'system', action: 'appointment.booked', scopeKind: 'location', scopeId: loc.id, targetType: 'appointment', targetId: members[0]!.id, metadata: { source: input.source, group: members.length > 1, package: !!pkg, voucher: voucher?.applied ?? null } });
    return { res, members, pkg, voucher };
  });
  const primary = done.members[0]!;
  let payment = null;
  if (input.collectDeposit && primary.depositMinor > 0) {
    try {
      const svcName = done.res.service.name;
      const p = await createPaymentForTarget(s, { organizationId: loc.organizationId, locationId: loc.id, amountMinor: primary.depositMinor, currency: primary.currency, targetType: 'appointment', targetId: primary.id, description: `Deposit: ${svcName}` });
      payment = { id: p.payment.id, clientSecret: p.clientSecret, amount: primary.depositMinor, currency: primary.currency, sandbox: p.sandbox };
    } catch (err) {
      // Never leave a booking that needed a deposit without a way to pay: release it.
      await s.db.update(appointments).set({ status: 'cancelled', cancellationKind: 'business', cancelledAt: new Date(), updatedAt: new Date() }).where(inArray(appointments.id, done.members.map((m) => m.id)));
      throw err;
    }
  }
  const price = done.members.reduce((a, m) => a + m.priceMinor, 0);
  const voucherApplied = done.members.reduce((a, m) => a + m.voucherAppliedMinor, 0);
  return {
    appointment: serializeAppointment(primary), appointments: done.members.map(serializeAppointment), manageToken: done.res.manageToken, payment,
    summary: {
      price: { amount: price, currency: primary.currency }, voucherApplied: { amount: voucherApplied, currency: primary.currency }, packageSessionUsed: !!done.pkg,
      packageSessionsRemaining: done.pkg?.sessionsRemaining ?? null, depositDue: { amount: primary.depositMinor, currency: primary.currency },
      dueAtVisit: { amount: done.pkg ? 0 : Math.max(0, price - voucherApplied - primary.depositMinor), currency: primary.currency },
      variantName: done.res.pricing.variantName, durationMinutes: done.res.pricing.durationMinutes,
    },
    location: { timeZone: loc.timeZone, name: loc.name },
  };
}

async function recordReminderConsents(db: Services['db'], organizationId: string, customerId: string, email: string, c?: { smsReminders?: boolean; emailReminders?: boolean }) {
  if (!c) return;
  const rows = [];
  if (c.smsReminders !== undefined) rows.push({ organizationId, customerId, email, purpose: REMINDER_PURPOSES.sms, version: '2026-10', granted: c.smsReminders, source: 'booking' });
  if (c.emailReminders !== undefined) rows.push({ organizationId, customerId, email, purpose: REMINDER_PURPOSES.email, version: '2026-10', granted: c.emailReminders, source: 'booking' });
  if (rows.length) await db.insert(consentRecords).values(rows);
}

export const wellnessRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };
  const byToken = async (id: string, token: string) => {
    const [a] = await s.db.select().from(appointments).where(eq(appointments.id, id));
    if (!a || !a.manageTokenHash || a.manageTokenHash !== sha256(token)) throw notFound('Appointment');
    return a;
  };
  const releaseToWaitlist = (a: AppointmentRow) => { offerFreedTime(s, a).catch((err) => s.log.warn({ err }, 'waitlist offer failed')); };

  // ───────── Public ─────────
  app.get('/public/wellness/:locationId/services', { schema: { tags: ['wellness'], summary: 'Online-bookable service menu with variants priced in the location currency', params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    return { location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, paymentsEnabled: loc.paymentsEnabled }, items: await serviceMenu(s.db, loc, { onlineOnly: true }) };
  });

  app.get('/public/wellness/:locationId/availability', {
    schema: { tags: ['wellness'], summary: 'Open slots for a service on a local date (practitioner optional = any available)', params: z.object({ locationId: z.uuid() }), querystring: z.object({ serviceId: z.uuid(), variantId: z.uuid().optional(), date, practitionerId: z.uuid().optional() }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    return availability(s.db, { organizationId: loc.organizationId, locationId: loc.id, ...req.query });
  });

  app.post('/public/wellness/:locationId/appointments', {
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: {
      tags: ['wellness'], summary: 'Book: secures practitioner(s), room and equipment atomically; applies a package or voucher; returns the deposit payment when due',
      params: z.object({ locationId: z.uuid() }),
      body: z.object({ serviceId: z.uuid(), variantId: z.uuid().optional(), practitionerId: z.uuid().optional(), practitionerIds: z.array(z.uuid()).max(2).optional(), startsAt: isoDateTime, contact: publicContactSchema, partner: publicContactSchema.optional(), voucherCode: z.string().min(4).max(40).optional(), packageId: z.uuid().optional(), consents: consentsSchema }),
    },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const [svc] = await s.db.select().from(services).where(and(eq(services.id, req.body.serviceId), eq(services.organizationId, loc.organizationId)));
    if (!svc) throw notFound('Service');
    const pricing = await resolvePricing(s.db, svc, loc, req.body.variantId);
    if (pricing.depositMinor > 0 && !loc.paymentsEnabled && !req.body.packageId && !req.body.voucherCode) throw conflict('payments_not_enabled', 'Online booking with a deposit is not available at this location yet');
    const customer = await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.contact, 'appointment');
    await recordReminderConsents(s.db, loc.organizationId, customer.id, customer.email ?? req.body.contact.email, req.body.consents);
    const partner = req.body.partner ? await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.partner, 'appointment') : null;
    const r = await bookAppointment(s, { loc, serviceId: svc.id, variantId: req.body.variantId, practitionerId: req.body.practitionerId, practitionerIds: req.body.practitionerIds, customerId: customer.id, partnerCustomerId: partner?.id ?? null, startsAt: new Date(req.body.startsAt), voucherCode: req.body.voucherCode, packageId: req.body.packageId, source: 'web', online: true, actorUserId: null, collectDeposit: true });
    return reply.code(201).send(r);
  });

  app.get('/public/wellness/appointments/:id', {
    schema: { tags: ['wellness'], summary: 'Manage view for the customer: details and what cancelling now would mean under the policy', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req) => {
    const a = await byToken(req.params.id, req.query.token);
    const members = await groupMembers(s.db, a);
    const [row] = await s.db.select({ svc: services, p: practitioners, l: locations, c: customers }).from(services).innerJoin(practitioners, eq(practitioners.id, a.practitionerId)).innerJoin(locations, eq(locations.id, a.locationId)).innerJoin(customers, eq(customers.id, a.customerId)).where(eq(services.id, a.serviceId));
    const [variant] = a.variantId ? await s.db.select().from(wellnessServiceVariants).where(eq(wellnessServiceVariants.id, a.variantId)) : [];
    const pracNames = members.length > 1 ? await s.db.select({ id: practitioners.id, name: practitioners.name }).from(practitioners).where(inArray(practitioners.id, members.map((m) => m.practitionerId))) : [{ id: row!.p.id, name: row!.p.name }];
    const preview = a.status === 'confirmed' ? (await cancellationPreview(s.db, a.id)).preview : null;
    const policy = policyOf(row!.svc);
    const hours = (a.startsAt.getTime() - Date.now()) / 3600_000;
    return {
      appointment: serializeAppointment(a), status: a.status, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(),
      service: { id: row!.svc.id, name: row!.svc.name, variantName: variant?.name ?? null, cancellationPolicy: row!.svc.cancellationPolicy, policy },
      practitioners: pracNames, location: { id: row!.l.id, name: row!.l.name, slug: row!.l.slug, timeZone: row!.l.timeZone }, clientFirstName: row!.c.name.split(' ')[0],
      guests: members.length, cancellation: preview, canCancel: a.status === 'confirmed' && a.startsAt > new Date(),
      canReschedule: a.status === 'confirmed' && a.startsAt > new Date() && hours >= policy.freeCancelHours,
      rescheduleBlockedReason: a.status === 'confirmed' && hours < policy.freeCancelHours ? `Changes within ${policy.freeCancelHours} hours of the appointment need a call to the team` : null,
    };
  });

  app.post('/public/wellness/appointments/:id/reschedule', {
    schema: { tags: ['wellness'], summary: 'Reschedule: the new slot is secured before the old one is released; on failure the original is kept', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10), startsAt: isoDateTime, practitionerId: z.uuid().nullable().optional() }) },
  }, async (req) => {
    const a = await byToken(req.params.id, req.body.manageToken);
    const [svc] = await s.db.select().from(services).where(eq(services.id, a.serviceId));
    const policy = policyOf(svc!);
    if (a.status === 'confirmed' && (a.startsAt.getTime() - Date.now()) / 3600_000 < policy.freeCancelHours) throw conflict('late_change_not_allowed', `Changes within ${policy.freeCancelHours} hours of the appointment need a call to the team`, { freeCancelHours: policy.freeCancelHours });
    const r = await rescheduleAppointment(s.db, a.id, { startsAt: new Date(req.body.startsAt), practitionerId: req.body.practitionerId, actorUserId: null });
    releaseToWaitlist(a);
    return { appointment: serializeAppointment(r.appointment), previousAppointmentId: r.previous.id, manageToken: req.body.manageToken, priceChange: r.priceChange, note: 'Your price and any deposit, package session or voucher value moved to the new time.' };
  });

  app.post('/public/wellness/appointments/:id/cancel', {
    schema: { tags: ['wellness'], summary: 'Cancel under the service policy (fee from the deposit when late; the rest refunded)', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10), acceptPolicy: z.boolean().optional() }) },
  }, async (req) => {
    const a = await byToken(req.params.id, req.body.manageToken);
    if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
    const pre = await cancellationPreview(s.db, a.id);
    if (pre.preview.fee.amount > 0 && req.body.acceptPolicy !== true) throw conflict('policy_acceptance_required', 'Cancelling now means a late-cancellation fee. Review it and confirm.', { cancellation: pre.preview });
    const r = await applyCancellation(s, a.id, { mode: 'auto', actorUserId: null, reason: 'Cancelled by the client' });
    releaseToWaitlist(a);
    return { id: a.id, status: 'cancelled', cancellation: r.preview, payment: r.payment };
  });

  // ───────── Staff ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/wellness/services', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(services).where(eq(services.organizationId, req.params.orgId)).orderBy(asc(services.name));
      const variants = rows.length ? await s.db.select().from(wellnessServiceVariants).where(inArray(wellnessServiceVariants.serviceId, rows.map((r) => r.id))).orderBy(asc(wellnessServiceVariants.sortOrder)) : [];
      const prices = variants.length ? await s.db.select().from(wellnessVariantPrices).where(inArray(wellnessVariantPrices.variantId, variants.map((v) => v.id))) : [];
      return {
        items: rows.map((r) => ({
          ...r, policy: policyOf(r),
          variants: variants.filter((v) => v.serviceId === r.id).map((v) => ({ ...v, prices: prices.filter((p) => p.variantId === v.id).map((p) => ({ locationId: p.locationId, priceMinor: p.priceMinor, depositMinor: p.depositMinor, currency: p.currency })) })),
        })),
      };
    });

    priv.post('/orgs/:orgId/wellness/services', {
      schema: {
        tags: ['wellness'], security: secured, params: orgParams,
        body: z.object({
          locationId: z.uuid().nullable().optional(), name: z.string().min(1), description: z.string().optional(), category: z.string().max(60).optional(), durationMinutes: z.number().int().min(5).max(600),
          bufferBeforeMinutes: z.number().int().min(0).max(120).default(0), bufferAfterMinutes: z.number().int().min(0).max(120).default(0), priceMinor: z.number().int().min(0), depositMinor: z.number().int().min(0).default(0),
          currency: z.string().length(3).optional(), requiredResourceType: z.string().optional(), equipmentTypes: z.array(z.string().min(1)).max(5).default([]), cancellationPolicy: z.string().max(2000).optional(),
          onlineBookable: z.boolean().default(true), practitionersRequired: z.number().int().min(1).max(2).default(1), depositRule: depositRuleSchema.nullable().optional(), policy: policySchema.nullable().optional(), rebookAfterWeeks: z.number().int().min(1).max(52).nullable().optional(),
        }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      let currency = b.currency;
      if (b.locationId) {
        const l = await requireLocationPerm(req, s.db, orgId, b.locationId, 'operations.write');
        currency = l.currency;
      } else {
        await requirePerm(req, s.db, 'operations.write', { organizationId: orgId, kind: 'organization', id: orgId });
        if (!currency) throw validationError('Network-wide services need a base currency (prices per location are set on variants)', { currency: 'Required' });
      }
      if (b.depositMinor > b.priceMinor) throw validationError('Deposit cannot exceed price', { depositMinor: 'Too high' });
      if (b.depositRule?.kind === 'percent' && b.depositRule.value > 100) throw validationError('A percentage deposit cannot exceed 100%', { 'depositRule.value': 'Max 100' });
      const [row] = await s.db.insert(services).values({
        organizationId: orgId, locationId: b.locationId ?? null, name: b.name, description: b.description ?? null, category: b.category ?? null, durationMinutes: b.durationMinutes, bufferBeforeMinutes: b.bufferBeforeMinutes,
        bufferAfterMinutes: b.bufferAfterMinutes, priceMinor: b.priceMinor, depositMinor: b.depositMinor, currency: currency!.toUpperCase(), requiredResourceType: b.requiredResourceType ?? null, equipmentTypes: b.equipmentTypes,
        cancellationPolicy: b.cancellationPolicy ?? null, onlineBookable: b.onlineBookable, practitionersRequired: b.practitionersRequired, depositRule: b.depositRule ?? null, policy: b.policy ?? null, rebookAfterWeeks: b.rebookAfterWeeks ?? null,
      }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'wellness.service_created', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'service', targetId: row!.id });
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/wellness/practitioners', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(practitioners).where(eq(practitioners.organizationId, req.params.orgId)).orderBy(asc(practitioners.name));
      const extra = await s.db.select().from(wellnessPractitionerLocations).where(and(eq(wellnessPractitionerLocations.organizationId, req.params.orgId), eq(wellnessPractitionerLocations.active, true)));
      return {
        items: rows.map((p) => ({ ...p, locations: [{ locationId: p.locationId, home: true, availability: p.availability }, ...extra.filter((x) => x.practitionerId === p.id && x.locationId !== p.locationId).map((x) => ({ locationId: x.locationId, home: false, availability: x.availability }))] }))
          .filter((p) => allowed === 'all' || p.locations.some((l) => allowed.has(l.locationId))),
      };
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
      const rows = await s.db.select().from(resources).where(eq(resources.organizationId, req.params.orgId)).orderBy(asc(resources.name));
      return { items: rows.filter((p) => allowed === 'all' || allowed.has(p.locationId)) };
    });

    priv.get('/orgs/:orgId/wellness/appointments', {
      schema: { tags: ['wellness'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), practitionerId: z.uuid().optional(), customerId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const custAllowed = await authorisedLocations(req, s.db, req.params.orgId, 'customers.read');
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 8 * 86400_000);
      const conds = [eq(appointments.organizationId, req.params.orgId), gte(appointments.startsAt, from), lt(appointments.startsAt, to)];
      if (req.query.locationId) conds.push(eq(appointments.locationId, req.query.locationId));
      if (req.query.practitionerId) conds.push(eq(appointments.practitionerId, req.query.practitionerId));
      if (req.query.customerId) conds.push(eq(appointments.customerId, req.query.customerId));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(appointments.locationId, [...allowed]));
      }
      const rows = await s.db.select({ a: appointments, c: customers.name, pu: practitioners.userId }).from(appointments).innerJoin(customers, eq(customers.id, appointments.customerId)).innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId)).where(and(...conds)).orderBy(asc(appointments.startsAt));
      const me = req.user!.id;
      return { items: rows.map((r) => ({ ...serializeAppointment(r.a), customerName: custAllowed === 'all' || custAllowed.has(r.a.locationId) || r.pu === me ? r.c : null })) };
    });

    priv.post('/orgs/:orgId/wellness/appointments', {
      schema: {
        tags: ['wellness'], security: secured, params: orgParams,
        body: z.object({ locationId: z.uuid(), serviceId: z.uuid(), variantId: z.uuid().optional(), practitionerId: z.uuid().optional(), practitionerIds: z.array(z.uuid()).max(2).optional(), startsAt: isoDateTime, customerId: z.uuid().optional(), contact: publicContactSchema.optional(), partnerCustomerId: z.uuid().optional(), partner: publicContactSchema.optional(), outsideAvailability: z.boolean().default(false), voucherCode: z.string().min(4).max(40).optional(), packageId: z.uuid().optional(), collectDeposit: z.boolean().default(false) }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const l = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'operations.write');
      const customerId = req.body.customerId ?? (req.body.contact ? (await findOrCreateCustomer(s.db, orgId, l.id, req.body.contact, 'staff')).id : null);
      if (!customerId) throw validationError('Provide customerId or contact', { customerId: 'Required' });
      const partnerCustomerId = req.body.partnerCustomerId ?? (req.body.partner ? (await findOrCreateCustomer(s.db, orgId, l.id, req.body.partner, 'staff')).id : null);
      const r = await bookAppointment(s, { loc: l, serviceId: req.body.serviceId, variantId: req.body.variantId, practitionerId: req.body.practitionerId, practitionerIds: req.body.practitionerIds, customerId, partnerCustomerId, startsAt: new Date(req.body.startsAt), voucherCode: req.body.voucherCode, packageId: req.body.packageId, source: 'staff', online: false, enforceAvailability: !req.body.outsideAvailability, actorUserId: req.user!.id, collectDeposit: req.body.collectDeposit });
      return reply.code(201).send(r);
    });

    priv.post('/orgs/:orgId/wellness/appointments/:id/reschedule', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ startsAt: isoDateTime, practitionerId: z.uuid().nullable().optional(), resourceId: z.uuid().nullable().optional(), outsideAvailability: z.boolean().default(false) }), summary: 'Transactional reschedule; failure keeps the original appointment' },
    }, async (req) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.params.id), eq(appointments.organizationId, req.params.orgId)));
      if (!a) throw notFound('Appointment');
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      const r = await rescheduleAppointment(s.db, a.id, { organizationId: req.params.orgId, startsAt: new Date(req.body.startsAt), practitionerId: req.body.practitionerId, resourceId: req.body.resourceId, actorUserId: req.user!.id, enforceAvailability: !req.body.outsideAvailability });
      releaseToWaitlist(a);
      return { appointment: serializeAppointment(r.appointment), appointments: r.appointments.map(serializeAppointment), previousAppointmentId: r.previous.id, priceChange: r.priceChange };
    });

    priv.get('/orgs/:orgId/wellness/appointments/:id/cancellation-preview', {
      schema: { tags: ['wellness'], security: secured, params: idParams, querystring: z.object({ mode: z.enum(['auto', 'business', 'no_show']).default('auto'), waiveFee: z.coerce.boolean().default(false) }) },
    }, async (req) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.params.id), eq(appointments.organizationId, req.params.orgId)));
      if (!a) throw notFound('Appointment');
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.read');
      return (await cancellationPreview(s.db, a.id, req.query.mode, { waiveFee: req.query.waiveFee })).preview;
    });

    priv.post('/orgs/:orgId/wellness/appointments/:id/cancel', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: z.object({ refundDeposit: z.boolean().default(false), byBusiness: z.boolean().optional(), waiveFee: z.boolean().default(false), reason: z.string().max(500).optional() }) },
    }, async (req) => {
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.params.id), eq(appointments.organizationId, req.params.orgId)));
      if (!a) throw notFound('Appointment');
      await requireLocationPerm(req, s.db, a.organizationId, a.locationId, 'operations.write');
      // `refundDeposit` (older clients) = cancel on the business's behalf with a full refund.
      const mode = req.body.byBusiness || req.body.refundDeposit ? 'business' : 'auto';
      const r = await applyCancellation(s, a.id, { organizationId: req.params.orgId, mode, waiveFee: req.body.waiveFee, reason: req.body.reason, actorUserId: req.user!.id });
      releaseToWaitlist(a);
      return { id: a.id, status: 'cancelled', cancellation: r.preview, payment: r.payment };
    });
  });
};
