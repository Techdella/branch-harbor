/**
 * Wellness — customer-facing routes: packages and gift vouchers (purchase, balance), waitlist for a time window,
 * and the signed-in customer's appointments/packages (mobile).
 */
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { appointments, customers, locations, organizations, practitioners, services, users, wellnessClientPackages, wellnessGiftVouchers, wellnessPackagePlans, wellnessWaitlist } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { createPaymentForTarget } from '../services/payments.ts';
import { applyCancellation, createClientPackage, effectiveVoucherStatus, issueVoucher, loadPlanFor, normaliseCode, serializeClientPackage, serializePlan, serializeVoucher } from '../services/wellness-commerce.ts';
import { joinWaitlist, offerFreedTime, serializeWaitlist } from '../services/wellness-ops.ts';
import { cancellationPreview, policyOf, rescheduleAppointment, serializeAppointment } from '../services/wellness.ts';
import { isoDateTime, secured } from './_common.ts';
import { bookAppointment } from './wellness.ts';

export const wellnessPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  // ───────── Packages ─────────
  app.get('/public/wellness/:locationId/packages', { schema: { tags: ['wellness'], summary: 'Packages on sale online at this location (location currency)', params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const rows = await s.db.select({ p: wellnessPackagePlans, svc: services.name }).from(wellnessPackagePlans).innerJoin(services, eq(services.id, wellnessPackagePlans.serviceId))
      .where(and(eq(wellnessPackagePlans.organizationId, loc.organizationId), eq(wellnessPackagePlans.active, true), eq(wellnessPackagePlans.onlinePurchasable, true), eq(wellnessPackagePlans.currency, loc.currency), or(isNull(wellnessPackagePlans.locationId), eq(wellnessPackagePlans.locationId, loc.id))))
      .orderBy(asc(wellnessPackagePlans.priceMinor));
    return { location: { id: loc.id, name: loc.name, currency: loc.currency, paymentsEnabled: loc.paymentsEnabled }, items: rows.map((r) => ({ ...serializePlan(r.p), serviceName: r.svc })), vouchers: { currency: loc.currency, minMinor: 2000, maxMinor: 100000, validityDays: 365 } };
  });

  app.post('/public/wellness/:locationId/packages', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['wellness'], summary: 'Buy a package online: pending until the payment succeeds', params: z.object({ locationId: z.uuid() }), body: z.object({ planId: z.uuid(), contact: publicContactSchema }) },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const { plan } = await loadPlanFor(s.db, loc.organizationId, req.body.planId, loc.id);
    if (!plan.onlinePurchasable) throw conflict('not_sold_online', 'This package is sold at reception');
    if (!loc.paymentsEnabled) throw conflict('payments_not_enabled', 'Online payments are not available at this location yet');
    const c = await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.contact, 'package');
    const r = await createClientPackage(s.db, { organizationId: loc.organizationId, locationId: loc.id, plan, customerId: c.id, paidVia: 'online', status: 'pending_payment' });
    const p = await createPaymentForTarget(s, { organizationId: loc.organizationId, locationId: loc.id, amountMinor: plan.priceMinor, currency: plan.currency, targetType: 'wellness_package', targetId: r.clientPackage.id, description: `Package: ${plan.name}` });
    await s.db.update(wellnessClientPackages).set({ paymentId: p.payment.id }).where(eq(wellnessClientPackages.id, r.clientPackage.id));
    return reply.code(201).send({ clientPackage: serializeClientPackage(r.clientPackage, plan), manageToken: r.manageToken, payment: { id: p.payment.id, clientSecret: p.clientSecret, amount: plan.priceMinor, currency: plan.currency, sandbox: p.sandbox } });
  });

  app.get('/public/wellness/client-packages/:id', { schema: { tags: ['wellness'], summary: 'Package balance for its owner (manage token)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const [cp] = await s.db.select().from(wellnessClientPackages).where(eq(wellnessClientPackages.id, req.params.id));
    if (!cp || cp.manageTokenHash !== sha256(req.query.token)) throw notFound('Package');
    const [plan] = await s.db.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.id, cp.planId));
    return serializeClientPackage(cp, plan);
  });

  // ───────── Gift vouchers ─────────
  app.post('/public/wellness/:locationId/vouchers', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['wellness'], summary: 'Buy a gift voucher in the location currency; the code is issued when the payment succeeds', params: z.object({ locationId: z.uuid() }), body: z.object({ amountMinor: z.number().int().min(2000).max(100000), contact: publicContactSchema, recipientName: z.string().max(120).optional(), recipientEmail: z.string().email().optional(), message: z.string().max(300).optional() }) },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    if (!loc.paymentsEnabled) throw conflict('payments_not_enabled', 'Online payments are not available at this location yet');
    const c = await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.contact, 'voucher');
    const r = await issueVoucher(s.db, { organizationId: loc.organizationId, locationId: loc.id, amountMinor: req.body.amountMinor, currency: loc.currency, purchaserCustomerId: c.id, recipientName: req.body.recipientName, recipientEmail: req.body.recipientEmail, message: req.body.message, status: 'pending_payment' });
    const p = await createPaymentForTarget(s, { organizationId: loc.organizationId, locationId: loc.id, amountMinor: req.body.amountMinor, currency: loc.currency, targetType: 'wellness_voucher', targetId: r.voucher.id, description: 'Gift voucher' });
    await s.db.update(wellnessGiftVouchers).set({ paymentId: p.payment.id }).where(eq(wellnessGiftVouchers.id, r.voucher.id));
    return reply.code(201).send({ voucher: { id: r.voucher.id, status: r.voucher.status, initial: { amount: r.voucher.initialMinor, currency: r.voucher.currency } }, manageToken: r.manageToken, payment: { id: p.payment.id, clientSecret: p.clientSecret, amount: req.body.amountMinor, currency: loc.currency, sandbox: p.sandbox } });
  });

  app.get('/public/wellness/vouchers/:id', { schema: { tags: ['wellness'], summary: 'Purchased voucher (code shown once paid) — manage token', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const [v] = await s.db.select().from(wellnessGiftVouchers).where(eq(wellnessGiftVouchers.id, req.params.id));
    if (!v || v.manageTokenHash !== sha256(req.query.token)) throw notFound('Voucher');
    const out = serializeVoucher(v, { showCode: v.status !== 'pending_payment' });
    return { ...out, code: v.status === 'pending_payment' ? null : out.code };
  });

  app.post('/public/wellness/:locationId/vouchers/check', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['wellness'], summary: 'Voucher balance check (rate-limited)', params: z.object({ locationId: z.uuid() }), body: z.object({ code: z.string().min(4).max(40) }) },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const [v] = await s.db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.organizationId, loc.organizationId), eq(wellnessGiftVouchers.code, normaliseCode(req.body.code))));
    if (!v || v.status === 'pending_payment' || v.status === 'cancelled') throw notFound('Voucher');
    const status = effectiveVoucherStatus(v);
    return { status, balance: { amount: v.balanceMinor, currency: v.currency }, expiresAt: v.expiresAt.toISOString(), usableHere: v.currency === loc.currency && status === 'active', note: v.currency !== loc.currency ? `This voucher is in ${v.currency}; ${loc.name} takes ${loc.currency}.` : null };
  });

  // ───────── Waitlist ─────────
  app.post('/public/wellness/:locationId/waitlist', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['wellness'], summary: 'Join the waitlist for a time window; you are emailed if a matching slot frees up', params: z.object({ locationId: z.uuid() }), body: z.object({ serviceId: z.uuid(), variantId: z.uuid().optional(), practitionerId: z.uuid().optional(), windowStart: isoDateTime, windowEnd: isoDateTime, contact: publicContactSchema }) },
  }, async (req, reply) => {
    const loc = await publicLocation(req.params.locationId);
    const [svc] = await s.db.select().from(services).where(and(eq(services.id, req.body.serviceId), eq(services.organizationId, loc.organizationId), eq(services.active, true)));
    if (!svc) throw notFound('Service');
    const c = await findOrCreateCustomer(s.db, loc.organizationId, loc.id, req.body.contact, 'waitlist');
    const r = await joinWaitlist(s.db, { organizationId: loc.organizationId, locationId: loc.id, serviceId: svc.id, variantId: req.body.variantId, practitionerId: req.body.practitionerId, customerId: c.id, windowStart: new Date(req.body.windowStart), windowEnd: new Date(req.body.windowEnd) });
    return reply.code(201).send({ entry: serializeWaitlist(r.entry), manageToken: r.manageToken });
  });

  const waitlistByToken = async (id: string, token: string) => {
    const [w] = await s.db.select().from(wellnessWaitlist).where(eq(wellnessWaitlist.id, id));
    if (!w || w.manageTokenHash !== sha256(token)) throw notFound('Waitlist entry');
    return w;
  };

  app.get('/public/wellness/waitlist/:id', { schema: { tags: ['wellness'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const w = await waitlistByToken(req.params.id, req.query.token);
    const [l] = await s.db.select().from(locations).where(eq(locations.id, w.locationId));
    const [svc] = await s.db.select({ name: services.name }).from(services).where(eq(services.id, w.serviceId));
    return { ...serializeWaitlist(w), serviceName: svc?.name ?? null, location: { id: l!.id, name: l!.name, timeZone: l!.timeZone } };
  });

  app.post('/public/wellness/waitlist/:id/claim', { schema: { tags: ['wellness'], summary: 'Claim the offered slot (it may have been taken in the meantime)', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) } }, async (req, reply) => {
    const w = await waitlistByToken(req.params.id, req.body.manageToken);
    if (w.status !== 'offered' || !w.offeredStartsAt) throw conflict('no_offer', 'There is no open offer on this waitlist entry');
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, w.locationId));
    try {
      const r = await bookAppointment(s, { loc: loc!, serviceId: w.serviceId, variantId: w.variantId, practitionerId: w.offeredPractitionerId ?? w.practitionerId, customerId: w.customerId, startsAt: w.offeredStartsAt, source: 'waitlist', online: true, actorUserId: null, collectDeposit: true });
      await s.db.update(wellnessWaitlist).set({ status: 'booked', appointmentId: r.appointment.id, updatedAt: new Date() }).where(eq(wellnessWaitlist.id, w.id));
      return reply.code(201).send(r);
    } catch (err) {
      await s.db.update(wellnessWaitlist).set({ status: 'waiting', offeredStartsAt: null, offeredPractitionerId: null, updatedAt: new Date() }).where(eq(wellnessWaitlist.id, w.id));
      throw err;
    }
  });

  app.post('/public/wellness/waitlist/:id/leave', { schema: { tags: ['wellness'], params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) } }, async (req) => {
    const w = await waitlistByToken(req.params.id, req.body.manageToken);
    const [row] = await s.db.update(wellnessWaitlist).set({ status: 'left', updatedAt: new Date() }).where(eq(wellnessWaitlist.id, w.id)).returning();
    return serializeWaitlist(row!);
  });

  // ───────── Signed-in customer (mobile) ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);
    const myCustomers = async (userId: string) => {
      const [u] = await s.db.select().from(users).where(eq(users.id, userId));
      if (!u) throw unauthorized();
      return s.db.select().from(customers).where(and(or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`), isNull(customers.erasedAt)));
    };

    priv.get('/me/wellness/appointments', { schema: { tags: ['me'], security: secured, summary: 'My wellness appointments (matched by account or email), with the cancellation policy preview' } }, async (req) => {
      const me = requireUser(req);
      const cs = await myCustomers(me.id);
      if (!cs.length) return { items: [] };
      const rows = await s.db.select({ a: appointments, svc: services, p: practitioners.name, l: locations, o: organizations.name }).from(appointments).innerJoin(services, eq(services.id, appointments.serviceId)).innerJoin(practitioners, eq(practitioners.id, appointments.practitionerId)).innerJoin(locations, eq(locations.id, appointments.locationId)).innerJoin(organizations, eq(organizations.id, appointments.organizationId))
        .where(and(inArray(appointments.customerId, cs.map((c) => c.id)), inArray(appointments.status, ['confirmed', 'completed', 'cancelled', 'no_show']))).orderBy(desc(appointments.startsAt)).limit(100);
      const items = [];
      for (const r of rows) {
        const upcoming = r.a.status === 'confirmed' && r.a.startsAt > new Date();
        const policy = policyOf(r.svc);
        items.push({
          ...serializeAppointment(r.a), serviceName: r.svc.name, practitionerName: r.p, businessName: r.o, location: { id: r.l.id, name: r.l.name, timeZone: r.l.timeZone },
          cancellationPolicy: r.svc.cancellationPolicy, cancellation: upcoming ? (await cancellationPreview(s.db, r.a.id)).preview : null,
          canReschedule: upcoming && (r.a.startsAt.getTime() - Date.now()) / 3600_000 >= policy.freeCancelHours,
        });
      }
      return { items };
    });

    const mine = async (userId: string, id: string) => {
      const cs = await myCustomers(userId);
      const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, id), inArray(appointments.customerId, cs.length ? cs.map((c) => c.id) : ['00000000-0000-0000-0000-000000000000'])));
      if (!a) throw notFound('Appointment');
      return a;
    };

    priv.post('/me/wellness/appointments/:id/cancel', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ acceptPolicy: z.boolean().optional() }) } }, async (req) => {
      const a = await mine(requireUser(req).id, req.params.id);
      const pre = await cancellationPreview(s.db, a.id);
      if (pre.preview.fee.amount > 0 && req.body.acceptPolicy !== true) throw conflict('policy_acceptance_required', 'Cancelling now means a late-cancellation fee. Review it and confirm.', { cancellation: pre.preview });
      const r = await applyCancellation(s, a.id, { mode: 'auto', actorUserId: null, reason: 'Cancelled by the client (app)' });
      offerFreedTime(s, a).catch(() => {});
      return { id: a.id, status: 'cancelled', cancellation: r.preview, payment: r.payment };
    });

    priv.post('/me/wellness/appointments/:id/reschedule', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ startsAt: isoDateTime, practitionerId: z.uuid().nullable().optional() }) } }, async (req) => {
      const a = await mine(requireUser(req).id, req.params.id);
      const [svc] = await s.db.select().from(services).where(eq(services.id, a.serviceId));
      const policy = policyOf(svc!);
      if ((a.startsAt.getTime() - Date.now()) / 3600_000 < policy.freeCancelHours) throw conflict('late_change_not_allowed', `Changes within ${policy.freeCancelHours} hours of the appointment need a call to the team`);
      const r = await rescheduleAppointment(s.db, a.id, { startsAt: new Date(req.body.startsAt), practitionerId: req.body.practitionerId, actorUserId: null });
      offerFreedTime(s, a).catch(() => {});
      return { appointment: serializeAppointment(r.appointment), previousAppointmentId: a.id, priceChange: r.priceChange };
    });

    priv.get('/me/wellness/packages', { schema: { tags: ['me'], security: secured, summary: 'My packages (own and shared with me) and gift vouchers I bought' } }, async (req) => {
      const cs = await myCustomers(requireUser(req).id);
      if (!cs.length) return { packages: [], vouchers: [] };
      const ids = cs.map((c) => c.id);
      const pk = await s.db.select({ cp: wellnessClientPackages, plan: wellnessPackagePlans }).from(wellnessClientPackages).innerJoin(wellnessPackagePlans, eq(wellnessPackagePlans.id, wellnessClientPackages.planId))
        .where(and(gt(wellnessClientPackages.sessionsTotal, 0), sql`${wellnessClientPackages.status} <> 'pending_payment'`, or(inArray(wellnessClientPackages.customerId, ids), sql`${wellnessClientPackages.sharedWithCustomerIds} ?| ${sql.raw(`array[${ids.map((i) => `'${i}'`).join(',')}]`)}`)));
      const vs = await s.db.select().from(wellnessGiftVouchers).where(and(inArray(wellnessGiftVouchers.purchaserCustomerId, ids), sql`${wellnessGiftVouchers.status} <> 'pending_payment'`));
      return { packages: pk.map((r) => ({ ...serializeClientPackage(r.cp, r.plan), sharedWithMe: !ids.includes(r.cp.customerId) })), vouchers: vs.map((v) => serializeVoucher(v)) };
    });
  });
};
