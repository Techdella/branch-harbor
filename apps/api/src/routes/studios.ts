import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema, currency } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { classBookings, classOccurrences, classTypes, coverRequests, customers, locations, users, waitlistEntries } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { reverseTargetPayment } from '../services/payments.ts';
import { bookClass, cancelBooking, seatsInUse } from '../services/studios.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

export const studioRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  // ───────── Public (customer) ─────────
  app.get('/public/studios/:locationId/schedule', {
    schema: {
      tags: ['studios'], summary: 'Public class schedule for a location (times in UTC; location timeZone included for display)',
      params: z.object({ locationId: z.uuid() }), querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }),
    },
  }, async (req) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, req.params.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86400_000);
    const rows = await s.db.select({ o: classOccurrences, t: classTypes }).from(classOccurrences).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId))
      .where(and(eq(classOccurrences.locationId, loc.id), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to))).orderBy(asc(classOccurrences.startsAt));
    const used = rows.length ? await s.db.select({ id: classBookings.occurrenceId, n: sql<number>`count(*)::int` }).from(classBookings)
      .where(and(inArray(classBookings.occurrenceId, rows.map((r) => r.o.id)), sql`(${classBookings.status} in ('confirmed','attended') or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} > now()))`)).groupBy(classBookings.occurrenceId) : [];
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, paymentsEnabled: loc.paymentsEnabled },
      items: rows.map(({ o, t }) => {
        const spotsLeft = Math.max(0, o.capacity - (used.find((u) => u.id === o.id)?.n ?? 0));
        const purchasable = o.priceMinor === 0 || loc.paymentsEnabled;
        return {
          id: o.id, classType: { id: t.id, name: t.name, description: t.description }, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(),
          instructorName: o.instructorName, room: o.room, online: o.online, capacity: o.capacity, spotsLeft, price: { amount: o.priceMinor, currency: o.currency },
          status: o.status === 'cancelled' ? 'cancelled' : !purchasable ? 'unavailable' : spotsLeft > 0 ? 'available' : 'full',
          action: o.status === 'cancelled' || !purchasable ? null : spotsLeft > 0 ? 'book' : 'join_waitlist',
        };
      }),
    };
  });

  app.post('/public/studios/occurrences/:id/bookings', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['studios'], summary: 'Book a class (holds a seat during payment) or join the waitlist when full',
      params: z.object({ id: z.uuid() }), body: z.object({ contact: publicContactSchema, joinWaitlist: z.boolean().default(false) }),
    },
  }, async (req, reply) => {
    const [occ] = await s.db.select({ o: classOccurrences, l: locations }).from(classOccurrences).innerJoin(locations, eq(locations.id, classOccurrences.locationId)).where(eq(classOccurrences.id, req.params.id));
    if (!occ || !occ.l.publiclyVisible) throw notFound('Class');
    const customer = await findOrCreateCustomer(s.db, occ.o.organizationId, occ.o.locationId, req.body.contact, 'class_booking');
    const r = await bookClass(s, { organizationId: occ.o.organizationId, occurrenceId: occ.o.id, customerId: customer.id, joinWaitlist: req.body.joinWaitlist, source: 'web' });
    return reply.code(201).send(r);
  });

  app.post('/public/studios/bookings/:id/cancel', {
    schema: { tags: ['studios'], summary: 'Customer cancels a booking with its manage token', params: z.object({ id: z.uuid() }), body: z.object({ manageToken: z.string().min(10) }) },
  }, async (req) => {
    const [b] = await s.db.select().from(classBookings).where(eq(classBookings.id, req.params.id));
    if (!b || b.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Booking');
    const out = await cancelBooking(s, b.id, { actorUserId: null });
    const refund = out.booking.status === 'confirmed' ? await reverseTargetPayment(s, out.booking.paymentId, null, 'Customer cancelled booking') : { action: 'none' };
    return { id: b.id, status: 'cancelled', payment: refund, waitlistPromoted: !!out.promoted };
  });

  // ───────── Staff / manager ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.get('/orgs/:orgId/studios/class-types', { schema: { tags: ['studios'], security: secured, params: orgParams } }, async (req) => {
      await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      return { items: await s.db.select().from(classTypes).where(eq(classTypes.organizationId, req.params.orgId)) };
    });

    priv.post('/orgs/:orgId/studios/class-types', {
      schema: { tags: ['studios'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid().nullable().default(null), name: z.string().min(1), description: z.string().max(4000).optional(), durationMinutes: z.number().int().min(5).max(600), defaultCapacity: z.number().int().min(1).max(1000), creditCost: z.number().int().min(0).default(1) }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      if (b.locationId) await requireLocationPerm(req, s.db, orgId, b.locationId, 'operations.write');
      else await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const [row] = await s.db.insert(classTypes).values({ organizationId: orgId, ...b, description: b.description ?? null }).returning();
      return reply.code(201).send(row);
    });

    priv.get('/orgs/:orgId/studios/occurrences', {
      schema: { tags: ['studios'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), instructorUserId: z.uuid().optional() }) },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400_000);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 8 * 86400_000);
      const conds = [eq(classOccurrences.organizationId, orgId), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to)];
      if (req.query.locationId) conds.push(eq(classOccurrences.locationId, req.query.locationId));
      if (req.query.instructorUserId) conds.push(eq(classOccurrences.instructorUserId, req.query.instructorUserId));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(classOccurrences.locationId, [...allowed]));
      }
      const rows = await s.db.select({ o: classOccurrences, t: classTypes }).from(classOccurrences).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).where(and(...conds)).orderBy(asc(classOccurrences.startsAt));
      const counts = rows.length ? await s.db.select({ id: classBookings.occurrenceId, status: classBookings.status, n: sql<number>`count(*)::int` }).from(classBookings).where(inArray(classBookings.occurrenceId, rows.map((r) => r.o.id))).groupBy(classBookings.occurrenceId, classBookings.status) : [];
      const wl = rows.length ? await s.db.select({ id: waitlistEntries.occurrenceId, n: sql<number>`count(*)::int` }).from(waitlistEntries).where(and(inArray(waitlistEntries.occurrenceId, rows.map((r) => r.o.id)), eq(waitlistEntries.status, 'waiting'))).groupBy(waitlistEntries.occurrenceId) : [];
      return {
        items: rows.map(({ o, t }) => ({
          ...o, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), classTypeName: t.name,
          booked: counts.filter((c) => c.id === o.id && ['confirmed', 'attended', 'no_show'].includes(c.status)).reduce((a, c) => a + c.n, 0),
          held: counts.find((c) => c.id === o.id && c.status === 'held')?.n ?? 0, waitlist: wl.find((w) => w.id === o.id)?.n ?? 0,
        })),
      };
    });

    priv.post('/orgs/:orgId/studios/occurrences', {
      schema: {
        tags: ['studios'], security: secured, params: orgParams, summary: 'Schedule a class, optionally repeating weekly (times are UTC; recurrence keeps local wall time across DST)',
        body: z.object({
          locationId: z.uuid(), classTypeId: z.uuid(), startsAt: isoDateTime, capacity: z.number().int().min(1).max(1000).optional(), priceMinor: z.number().int().min(0).default(0),
          currency: currency.optional(), instructorUserId: z.uuid().optional(), instructorName: z.string().optional(), room: z.string().optional(), online: z.boolean().default(false),
          repeatWeeks: z.number().int().min(1).max(52).default(1),
        }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      const loc = await requireLocationPerm(req, s.db, orgId, b.locationId, 'operations.write');
      const [ct] = await s.db.select().from(classTypes).where(and(eq(classTypes.id, b.classTypeId), eq(classTypes.organizationId, orgId), or(isNull(classTypes.locationId), eq(classTypes.locationId, b.locationId))));
      if (!ct) throw notFound('Class type');
      if (b.currency && b.currency !== loc.currency) throw validationError(`Prices at ${loc.name} are in ${loc.currency}`, { currency: `Must be ${loc.currency}` });
      if (b.priceMinor > 0 && !loc.paymentsEnabled) req.log.info('paid class created at location without payments; it will show as unavailable until payments are enabled');
      const first = new Date(b.startsAt);
      const local = localDateParts(first, loc.timeZone);
      const seriesId = b.repeatWeeks > 1 ? crypto.randomUUID() : null;
      const values = Array.from({ length: b.repeatWeeks }, (_, i) => {
        const startsAt = i === 0 ? first : zonedToUtc(addDays(local.date, 7 * i), local.time, loc.timeZone);
        return {
          organizationId: orgId, locationId: loc.id, classTypeId: ct.id, seriesId, startsAt, endsAt: new Date(startsAt.getTime() + ct.durationMinutes * 60_000),
          capacity: b.capacity ?? ct.defaultCapacity, priceMinor: b.priceMinor, currency: loc.currency, instructorUserId: b.instructorUserId ?? null,
          instructorName: b.instructorName ?? null, room: b.room ?? null, online: b.online,
        };
      });
      const rows = await s.db.insert(classOccurrences).values(values).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'class.scheduled', scopeKind: 'location', scopeId: loc.id, targetType: 'class_occurrence', targetId: rows[0]!.id, metadata: { count: rows.length, seriesId } });
      return reply.code(201).send({ items: rows });
    });

    const loadOcc = async (orgId: string, id: string) => {
      const [o] = await s.db.select().from(classOccurrences).where(and(eq(classOccurrences.id, id), eq(classOccurrences.organizationId, orgId)));
      if (!o) throw notFound('Class');
      return o;
    };

    priv.get('/orgs/:orgId/studios/occurrences/:id', { schema: { tags: ['studios'], security: secured, params: idParams, summary: 'Class detail: capacity, attendees, waitlist, booking source' } }, async (req) => {
      const o = await loadOcc(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.read');
      const attendees = await s.db.select({ b: classBookings, c: { id: customers.id, name: customers.name } }).from(classBookings).innerJoin(customers, eq(customers.id, classBookings.customerId)).where(eq(classBookings.occurrenceId, o.id)).orderBy(asc(classBookings.createdAt));
      const waitlist = await s.db.select({ w: waitlistEntries, c: { id: customers.id, name: customers.name } }).from(waitlistEntries).innerJoin(customers, eq(customers.id, waitlistEntries.customerId)).where(eq(waitlistEntries.occurrenceId, o.id)).orderBy(asc(waitlistEntries.createdAt));
      const canSeeContact = await hasPerm(req, s.db, 'customers.read', { organizationId: o.organizationId, kind: 'location', id: o.locationId });
      const inUse = await s.db.transaction((tx) => seatsInUse(tx, o.id));
      return {
        ...o, spotsLeft: Math.max(0, o.capacity - inUse),
        attendees: attendees.map((a) => ({ bookingId: a.b.id, status: a.b.status, source: a.b.source, holdExpiresAt: a.b.holdExpiresAt, paymentId: a.b.paymentId, customer: canSeeContact ? a.c : { id: a.c.id, name: a.c.name.split(' ')[0] } })),
        waitlist: waitlist.map((w, i) => ({ id: w.w.id, position: i + 1, status: w.w.status, customer: canSeeContact ? w.c : { id: w.c.id, name: w.c.name.split(' ')[0] } })),
      };
    });

    priv.post('/orgs/:orgId/studios/occurrences/:id/cancel', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ reason: z.string().min(1).max(500) }), summary: 'Cancel one occurrence; bookings are cancelled and paid bookings refunded' },
    }, async (req) => {
      const o = await loadOcc(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
      if (o.status === 'cancelled') throw conflict('already_cancelled', 'Class is already cancelled');
      const affected = await s.db.transaction(async (tx) => {
        await tx.update(classOccurrences).set({ status: 'cancelled' }).where(eq(classOccurrences.id, o.id));
        const bks = await tx.update(classBookings).set({ status: 'cancelled', cancelledAt: new Date() }).where(and(eq(classBookings.occurrenceId, o.id), inArray(classBookings.status, ['held', 'confirmed']))).returning();
        await tx.update(waitlistEntries).set({ status: 'removed' }).where(and(eq(waitlistEntries.occurrenceId, o.id), inArray(waitlistEntries.status, ['waiting', 'offered'])));
        await audit(tx, { organizationId: o.organizationId, ...actor(req), action: 'class.cancelled', scopeKind: 'location', scopeId: o.locationId, targetType: 'class_occurrence', targetId: o.id, metadata: { reason: req.body.reason, bookings: bks.length } });
        return bks;
      });
      const refunds = [];
      for (const b of affected) refunds.push({ bookingId: b.id, ...(await reverseTargetPayment(s, b.paymentId, req.user!.id, `Class cancelled: ${req.body.reason}`)) });
      return { id: o.id, status: 'cancelled', affectedBookings: affected.length, payments: refunds };
    });

    priv.post('/orgs/:orgId/studios/occurrences/:id/bookings', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ customerId: z.uuid().optional(), contact: publicContactSchema.optional(), joinWaitlist: z.boolean().default(false) }), summary: 'Staff books a customer into a class' },
    }, async (req, reply) => {
      const o = await loadOcc(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.write');
      let customerId = req.body.customerId;
      if (customerId) {
        const [c] = await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, o.organizationId)));
        if (!c) throw notFound('Customer');
      } else if (req.body.contact) customerId = (await findOrCreateCustomer(s.db, o.organizationId, o.locationId, req.body.contact, 'staff')).id;
      else throw validationError('Provide customerId or contact', { customerId: 'Required' });
      const r = await bookClass(s, { organizationId: o.organizationId, occurrenceId: o.id, customerId, joinWaitlist: req.body.joinWaitlist, source: 'staff', actorUserId: req.user!.id });
      return reply.code(201).send(r);
    });

    priv.post('/orgs/:orgId/studios/bookings/:id/cancel', { schema: { tags: ['studios'], security: secured, params: idParams } }, async (req) => {
      const [b] = await s.db.select().from(classBookings).where(and(eq(classBookings.id, req.params.id), eq(classBookings.organizationId, req.params.orgId)));
      if (!b) throw notFound('Booking');
      await requireLocationPerm(req, s.db, b.organizationId, b.locationId, 'operations.write');
      const out = await cancelBooking(s, b.id, { actorUserId: req.user!.id, organizationId: req.params.orgId });
      return { id: b.id, status: 'cancelled', waitlistPromoted: out.promoted ? { bookingId: out.promoted.bookingId, status: out.promoted.status } : null };
    });

    priv.post('/orgs/:orgId/studios/bookings/:id/attendance', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ status: z.enum(['attended', 'no_show']) }) },
    }, async (req) => {
      const [b] = await s.db.select().from(classBookings).where(and(eq(classBookings.id, req.params.id), eq(classBookings.organizationId, req.params.orgId)));
      if (!b) throw notFound('Booking');
      await requireLocationPerm(req, s.db, b.organizationId, b.locationId, 'operations.write');
      if (!['confirmed', 'attended', 'no_show'].includes(b.status)) throw conflict('booking_not_confirmed', `Booking is ${b.status}`);
      const [u] = await s.db.update(classBookings).set({ status: req.body.status }).where(eq(classBookings.id, b.id)).returning();
      return u;
    });

    // ── Instructor cover ──
    priv.get('/orgs/:orgId/studios/cover-requests', { schema: { tags: ['studios'], security: secured, params: orgParams, querystring: z.object({ status: z.string().optional() }) } }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'operations.read');
      const rows = await s.db.select().from(coverRequests).where(and(eq(coverRequests.organizationId, req.params.orgId), req.query.status ? eq(coverRequests.status, req.query.status) : sql`true`));
      return { items: rows.filter((r) => allowed === 'all' || allowed.has(r.locationId)) };
    });

    priv.post('/orgs/:orgId/studios/occurrences/:id/cover-requests', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ reason: z.string().max(500).optional(), requiresApproval: z.boolean().default(true) }) },
    }, async (req, reply) => {
      const me = requireUser(req);
      const o = await loadOcc(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, o.organizationId, o.locationId, 'operations.read');
      const [open] = await s.db.select({ id: coverRequests.id }).from(coverRequests).where(and(eq(coverRequests.occurrenceId, o.id), inArray(coverRequests.status, ['open', 'accepted'])));
      if (open) throw conflict('cover_already_requested', 'Cover has already been requested for this class');
      const [cr] = await s.db.insert(coverRequests).values({
        organizationId: o.organizationId, locationId: o.locationId, occurrenceId: o.id, requestedBy: me.id, reason: req.body.reason ?? null, requiresApproval: req.body.requiresApproval,
        history: [{ at: new Date().toISOString(), by: me.id, action: 'requested', note: req.body.reason }],
      }).returning();
      await audit(s.db, { organizationId: o.organizationId, ...actor(req), action: 'cover.requested', scopeKind: 'location', scopeId: o.locationId, targetType: 'cover_request', targetId: cr!.id });
      return reply.code(201).send(cr);
    });

    const loadCover = async (orgId: string, id: string) => {
      const [cr] = await s.db.select().from(coverRequests).where(and(eq(coverRequests.id, id), eq(coverRequests.organizationId, orgId)));
      if (!cr) throw notFound('Cover request');
      return cr;
    };

    const applyCover = async (cr: typeof coverRequests.$inferSelect, actorId: string, action: string) => {
      // Schedule and customer-facing instructor update together, in one transaction.
      await s.db.transaction(async (tx) => {
        await tx.update(coverRequests).set({ status: 'approved', approvedBy: actorId, history: [...cr.history, { at: new Date().toISOString(), by: actorId, action }], updatedAt: new Date() }).where(eq(coverRequests.id, cr.id));
        await tx.update(classOccurrences).set({ instructorUserId: cr.substituteUserId, instructorName: cr.substituteName }).where(eq(classOccurrences.id, cr.occurrenceId));
        await audit(tx, { organizationId: cr.organizationId, actorUserId: actorId, action: 'cover.approved', scopeKind: 'location', scopeId: cr.locationId, targetType: 'cover_request', targetId: cr.id, metadata: { substitute: cr.substituteUserId } });
      });
    };

    priv.post('/orgs/:orgId/studios/cover-requests/:id/accept', { schema: { tags: ['studios'], security: secured, params: idParams, summary: 'An eligible instructor accepts the cover' } }, async (req) => {
      const me = requireUser(req);
      const cr = await loadCover(req.params.orgId, req.params.id);
      await requireLocationPerm(req, s.db, cr.organizationId, cr.locationId, 'operations.read');
      if (cr.status !== 'open') throw conflict('cover_not_open', `Cover request is ${cr.status}`);
      if (cr.requestedBy === me.id) throw forbidden('You cannot cover your own class');
      const [u] = await s.db.select({ name: users.name }).from(users).where(eq(users.id, me.id));
      const accepted = { ...cr, status: 'accepted', substituteUserId: me.id, substituteName: u?.name ?? null };
      await s.db.update(coverRequests).set({ status: 'accepted', substituteUserId: me.id, substituteName: u?.name ?? null, history: [...cr.history, { at: new Date().toISOString(), by: me.id, action: 'accepted' }], updatedAt: new Date() }).where(eq(coverRequests.id, cr.id));
      if (!cr.requiresApproval) await applyCover(accepted, me.id, 'auto_approved');
      return loadCover(req.params.orgId, cr.id);
    });

    priv.post('/orgs/:orgId/studios/cover-requests/:id/decision', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'decline']), note: z.string().max(500).optional() }), summary: 'Manager confirms or declines the substitute' },
    }, async (req) => {
      const me = requireUser(req);
      const cr = await loadCover(req.params.orgId, req.params.id);
      const scope = { organizationId: cr.organizationId, kind: 'location' as const, id: cr.locationId };
      // Managers (not general staff) approve: operations.write + locations.read in the location.
      await requirePerm(req, s.db, 'operations.write', scope);
      if (!(await hasPerm(req, s.db, 'locations.read', scope))) throw forbidden('Only a manager can approve cover');
      if (cr.status !== 'accepted') throw new AppError(409, 'cover_not_accepted', 'No substitute has accepted this request yet');
      if (req.body.decision === 'approve') await applyCover(cr, me.id, 'approved');
      else await s.db.update(coverRequests).set({ status: 'open', substituteUserId: null, substituteName: null, history: [...cr.history, { at: new Date().toISOString(), by: me.id, action: 'declined', note: req.body.note }], updatedAt: new Date() }).where(eq(coverRequests.id, cr.id));
      return loadCover(req.params.orgId, cr.id);
    });
  });
};
