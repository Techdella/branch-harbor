import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { foodOrderCreateSchema } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  classBookings, classOccurrences, classTypes, customerMessages, customers, foodOrders, locations, pushTokens, users, waitlistEntries,
} from '../db/schema/index.ts';
import { notFound, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireLocationPerm } from '../services/authz.ts';
import { priceFoodOrderLines, serializeFoodOrder } from '../services/foods.ts';
import { reverseTargetPayment } from '../services/payments.ts';
import { cancelBooking, leaveWaitlist } from '../services/studios.ts';
import { orgParams, secured } from './_common.ts';

/**
 * Endpoints the mobile app needs that are not covered by the web routes: signed-in customer views
 * (bookings, orders, messages), an order quote, staff replies to customer messages and Expo push
 * token registration.
 */
export const mobileRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  // ───────── Public: order quote ─────────
  app.post('/public/foods/:locationId/quote', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['foods'], summary: 'Price a cart (same server checks as order creation; nothing is reserved). Tax appears only when the business configured a rate.',
      params: z.object({ locationId: z.uuid() }), body: z.object({ lines: foodOrderCreateSchema.shape.lines }),
    },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const p = await priceFoodOrderLines(s.db, loc.organizationId, loc, req.body.lines);
    const money = (amount: number) => ({ amount, currency: loc.currency });
    return {
      locationId: loc.id, currency: loc.currency,
      lines: p.lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, quantity: l.quantity, modifiers: l.modifiers.map((m) => m.name), unitPrice: money(l.unitPriceMinor), lineTotal: money(l.lineTotalMinor) })),
      subtotal: money(p.subtotal), tax: p.taxRateBps > 0 ? money(p.tax) : null, taxRateBps: p.taxRateBps || null, taxInclusive: false, total: money(p.total),
    };
  });

  // ───────── Signed-in ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const currentUser = async (req: Parameters<typeof requireUser>[0]) => {
      const me = requireUser(req);
      const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
      if (!u || u.deletedAt) throw unauthorized();
      return u;
    };
    /**
     * Customer records that belong to this user: linked by user id, or — once the account's email is verified — by
     * the same email in any organisation (public bookings/orders are keyed by email).
     */
    const ownsCustomer = (u: typeof users.$inferSelect) =>
      u.emailVerifiedAt ? or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`) : eq(customers.userId, u.id);
    const myCustomerIds = async (u: typeof users.$inferSelect) => {
      const rows = await s.db.select({ id: customers.id }).from(customers).where(and(ownsCustomer(u), isNull(customers.erasedAt)));
      return rows.map((r) => r.id);
    };

    // ── Push tokens ──
    priv.post('/me/push-tokens', {
      schema: {
        tags: ['me'], security: secured, summary: 'Register (or re-register) this device\'s Expo push token for the signed-in user',
        body: z.object({
          token: z.string().min(10).max(255).describe('Expo push token, e.g. ExponentPushToken[xxxx]'),
          platform: z.enum(['ios', 'android', 'web']),
          deviceId: z.string().max(200).optional(), appVersion: z.string().max(40).optional(), locale: z.string().max(20).optional(),
        }),
      },
    }, async (req, reply) => {
      const me = requireUser(req);
      const b = req.body;
      const values = { userId: me.id, token: b.token, platform: b.platform, deviceId: b.deviceId ?? null, appVersion: b.appVersion ?? null, locale: b.locale ?? null, lastSeenAt: new Date(), updatedAt: new Date() };
      // A token moves to whoever registered it last (shared or resold devices).
      const [row] = await s.db.insert(pushTokens).values(values).onConflictDoUpdate({ target: pushTokens.token, set: values }).returning();
      await audit(s.db, { organizationId: null, ...actor(req), action: 'push_token.registered', targetType: 'push_token', targetId: row!.id, metadata: { platform: b.platform } });
      return reply.code(201).send({ id: row!.id, platform: row!.platform, createdAt: row!.createdAt.toISOString(), updatedAt: row!.updatedAt.toISOString() });
    });

    priv.delete('/me/push-tokens', {
      schema: { tags: ['me'], security: secured, summary: 'Unregister a push token (e.g. on sign-out)', body: z.object({ token: z.string().min(10).max(255) }) },
    }, async (req, reply) => {
      const me = requireUser(req);
      await s.db.delete(pushTokens).where(and(eq(pushTokens.token, req.body.token), eq(pushTokens.userId, me.id)));
      return reply.code(204).send(null);
    });

    // ── Customer: bookings ──
    priv.get('/me/bookings', {
      schema: { tags: ['me'], security: secured, summary: 'Class bookings and waitlist places for the signed-in customer (all businesses, matched by account or email)' },
    }, async (req) => {
      const u = await currentUser(req);
      const custIds = await myCustomerIds(u);
      if (!custIds.length) return { items: [] };
      const cols = {
        o: { id: classOccurrences.id, startsAt: classOccurrences.startsAt, endsAt: classOccurrences.endsAt, instructorName: classOccurrences.instructorName, room: classOccurrences.room, priceMinor: classOccurrences.priceMinor, currency: classOccurrences.currency, status: classOccurrences.status },
        t: { name: classTypes.name },
        l: { id: locations.id, name: locations.name, timeZone: locations.timeZone, organizationId: locations.organizationId },
      };
      const bks = await s.db.select({ b: classBookings, ...cols }).from(classBookings)
        .innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId)).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).innerJoin(locations, eq(locations.id, classBookings.locationId))
        .where(and(inArray(classBookings.customerId, custIds), sql`not (${classBookings.status} = 'expired' or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} <= now()))`))
        .orderBy(desc(classOccurrences.startsAt)).limit(200);
      const wl = await s.db.select({ w: waitlistEntries, ...cols }).from(waitlistEntries)
        .innerJoin(classOccurrences, eq(classOccurrences.id, waitlistEntries.occurrenceId)).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).innerJoin(locations, eq(locations.id, waitlistEntries.locationId))
        .where(and(inArray(waitlistEntries.customerId, custIds), eq(waitlistEntries.status, 'waiting')));
      const positions = await Promise.all(wl.map(async ({ w }) => {
        const [p] = await s.db.select({ n: sql<number>`count(*)::int` }).from(waitlistEntries)
          .where(and(eq(waitlistEntries.occurrenceId, w.occurrenceId), eq(waitlistEntries.status, 'waiting'), sql`${waitlistEntries.createdAt} <= (select created_at from waitlist_entries where id = ${w.id})`));
        return p?.n ?? 1;
      }));
      const common = (o: typeof bks[number]['o'], t: typeof bks[number]['t'], l: typeof bks[number]['l']) => ({
        occurrenceId: o.id, className: t.name, instructorName: o.instructorName, room: o.room, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(),
        durationMinutes: Math.round((o.endsAt.getTime() - o.startsAt.getTime()) / 60_000), classCancelled: o.status === 'cancelled',
        price: { amount: o.priceMinor, currency: o.currency }, location: l,
      });
      return {
        items: [
          ...bks.map(({ b, o, t, l }) => ({ id: b.id, kind: 'booking' as const, status: b.status, holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null, waitlistPosition: null, ...common(o, t, l) })),
          ...wl.map(({ w, o, t, l }, i) => ({ id: w.id, kind: 'waitlist' as const, status: 'waitlisted', holdExpiresAt: null, waitlistPosition: positions[i]!, ...common(o, t, l) })),
        ].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      };
    });

    priv.post('/me/bookings/:id/cancel', {
      schema: { tags: ['me'], security: secured, summary: 'Cancel one of my class bookings (refund when the payment can be reversed; the next waiting customer is promoted)', params: z.object({ id: z.uuid() }) },
    }, async (req) => {
      const u = await currentUser(req);
      const custIds = await myCustomerIds(u);
      const [b] = await s.db.select().from(classBookings).where(eq(classBookings.id, req.params.id));
      if (!b || !custIds.includes(b.customerId)) throw notFound('Booking');
      const out = await cancelBooking(s, b.id, { actorUserId: u.id });
      const payment = out.refundEligible ? await reverseTargetPayment(s, out.booking.paymentId, u.id, 'Customer cancelled booking') : { action: 'none' };
      return { id: b.id, status: 'cancelled', payment, waitlistPromoted: !!out.promoted, lateCancel: out.lateCancel, creditReturned: out.creditReturned, fee: out.fee ? { amount: out.fee.amountMinor, currency: out.fee.currency } : null };
    });

    priv.post('/me/waitlist/:id/leave', {
      schema: { tags: ['me'], security: secured, summary: 'Leave one of my class waitlists (an offered spot is released to the next person)', params: z.object({ id: z.uuid() }) },
    }, async (req) => {
      const u = await currentUser(req);
      const custIds = await myCustomerIds(u);
      const [w] = await s.db.select().from(waitlistEntries).where(eq(waitlistEntries.id, req.params.id));
      if (!w || !custIds.includes(w.customerId)) throw notFound('Waitlist place');
      const e = await leaveWaitlist(s, w.id, { actorUserId: u.id });
      return { id: e.id, status: 'left' as const };
    });

    // ── Customer: food orders ──
    priv.get('/me/food-orders', {
      schema: { tags: ['me'], security: secured, summary: 'Pickup orders placed by the signed-in customer (matched by account or email)' },
    }, async (req) => {
      const u = await currentUser(req);
      const custIds = await myCustomerIds(u);
      if (!custIds.length) return { items: [] };
      const rows = await s.db.select({ o: foodOrders, l: { name: locations.name, timeZone: locations.timeZone } }).from(foodOrders).innerJoin(locations, eq(locations.id, foodOrders.locationId))
        .where(inArray(foodOrders.customerId, custIds)).orderBy(desc(foodOrders.createdAt)).limit(100);
      return { items: rows.map(({ o, l }) => ({ ...serializeFoodOrder(o, { includeContact: true }), location: { id: o.locationId, ...l } })) };
    });

    // ── Customer ↔ location messages ──
    const serializeMsg = (m: typeof customerMessages.$inferSelect, authorName: string | null) => ({
      id: m.id, locationId: m.locationId, direction: m.direction, authorName, body: m.body, createdAt: m.createdAt.toISOString(), readAt: m.readAt?.toISOString() ?? null,
    });

    priv.get('/me/messages', {
      schema: { tags: ['me'], security: secured, summary: 'My conversation with a location', querystring: z.object({ locationId: z.uuid() }) },
    }, async (req) => {
      const me = requireUser(req);
      const loc = await publicLocation(req.query.locationId);
      const rows = await s.db.select().from(customerMessages).where(and(eq(customerMessages.locationId, loc.id), eq(customerMessages.customerUserId, me.id))).orderBy(asc(customerMessages.createdAt)).limit(500);
      const unread = rows.filter((m) => m.direction === 'outbound' && !m.readAt).map((m) => m.id);
      if (unread.length) await s.db.update(customerMessages).set({ readAt: new Date() }).where(inArray(customerMessages.id, unread));
      return { location: { id: loc.id, name: loc.name }, items: rows.map((m) => serializeMsg(m, m.direction === 'inbound' ? null : loc.name)) };
    });

    priv.post('/me/messages', {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { tags: ['me'], security: secured, summary: 'Send a message to a location', body: z.object({ locationId: z.uuid(), body: z.string().trim().min(1).max(2000) }) },
    }, async (req, reply) => {
      const u = await currentUser(req);
      const loc = await publicLocation(req.body.locationId);
      const [cust] = await s.db.select({ id: customers.id }).from(customers)
        .where(and(eq(customers.organizationId, loc.organizationId), ownsCustomer(u), isNull(customers.erasedAt)));
      const [m] = await s.db.insert(customerMessages).values({
        organizationId: loc.organizationId, locationId: loc.id, customerUserId: u.id, customerId: cust?.id ?? null, direction: 'inbound', authorUserId: u.id, body: req.body.body,
      }).returning();
      return reply.code(201).send(serializeMsg(m!, null));
    });

    priv.get('/orgs/:orgId/messages', {
      schema: { tags: ['crm'], security: secured, summary: 'Customer conversations at a location (requires customers.read there)', params: orgParams, querystring: z.object({ locationId: z.uuid() }) },
    }, async (req) => {
      await requireLocationPerm(req, s.db, req.params.orgId, req.query.locationId, 'customers.read');
      const rows = await s.db.select({ m: customerMessages, customer: { id: users.id, name: users.name, email: users.email } }).from(customerMessages)
        .innerJoin(users, eq(users.id, customerMessages.customerUserId))
        .where(and(eq(customerMessages.organizationId, req.params.orgId), eq(customerMessages.locationId, req.query.locationId))).orderBy(desc(customerMessages.createdAt)).limit(500);
      return { items: rows.map(({ m, customer }) => ({ ...serializeMsg(m, m.direction === 'inbound' ? customer.name : null), customer })) };
    });

    priv.post('/orgs/:orgId/messages', {
      schema: {
        tags: ['crm'], security: secured, params: orgParams, summary: 'Reply to a customer conversation (requires customers.write at the location; only existing conversations)',
        body: z.object({ locationId: z.uuid(), customerUserId: z.uuid(), body: z.string().trim().min(1).max(2000) }),
      },
    }, async (req, reply) => {
      const me = requireUser(req);
      const { orgId } = req.params;
      const loc = await requireLocationPerm(req, s.db, orgId, req.body.locationId, 'customers.write');
      // Staff can only answer: a thread exists once the customer has written to this location.
      const [first] = await s.db.select().from(customerMessages)
        .where(and(eq(customerMessages.locationId, loc.id), eq(customerMessages.customerUserId, req.body.customerUserId), eq(customerMessages.direction, 'inbound'))).limit(1);
      if (!first) throw notFound('Conversation');
      const m = await s.db.transaction(async (tx) => {
        const [m] = await tx.insert(customerMessages).values({
          organizationId: orgId, locationId: loc.id, customerUserId: req.body.customerUserId, customerId: first.customerId, direction: 'outbound', authorUserId: me.id, body: req.body.body,
        }).returning();
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'customer_message.sent', scopeKind: 'location', scopeId: loc.id, targetType: 'customer_message', targetId: m!.id });
        return m!;
      });
      return reply.code(201).send(serializeMsg(m, loc.name));
    });
  });
};
