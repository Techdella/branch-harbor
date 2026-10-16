/**
 * Hospitality — public booking engine (customer websites, guest app) and signed-in guest routes.
 * Only customer-visible properties of hospitality brands are exposed. Manage links use a per-reservation token.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { customers, hospProperties, hospReservations, locations, organizations, paymentReferences, users } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { requireUser } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import {
  cancelReservation, cancellationQuote, cleanRegistration, createReservation, expireHolds, folioView, localToday, modifyReservation, propertyFor, rateContext, searchAvailability, type Location, type Reservation,
} from '../services/hospitality.ts';
import { guestReservations } from '../services/hospitality-ops.ts';
import { isoDate, reservationRoomsView, reservationView } from './hospitality-views.ts';
import { siteSlugCond } from '../services/brands.ts';

const guest = z.object({ name: z.string().min(1).max(120), email: z.email(), phone: z.string().max(40).optional() });
const roomReq = z.object({ roomTypeId: z.uuid(), ratePlanId: z.uuid(), adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20).default(0) });

export const hospitalityPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  async function brand(slug: string) {
    const [org] = await s.db.select().from(organizations).where(and(siteSlugCond(slug), isNull(organizations.deletedAt)));
    if (!org || org.industry !== 'hospitality') throw notFound('Brand');
    return org;
  }
  async function publicProperty(locationId: string) {
    const [row] = await s.db.select({ loc: locations, org: organizations }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId))
      .where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt), isNull(organizations.deletedAt)));
    if (!row || row.org.industry !== 'hospitality') throw notFound('Property');
    return { loc: row.loc, org: row.org, prop: await propertyFor(s.db, row.loc) };
  }
  const propertyCard = (loc: Location, p: typeof hospProperties.$inferSelect) => ({
    locationId: loc.id, slug: loc.slug, name: loc.name, kind: p.kind, description: p.description, city: loc.address.city, country: loc.country, address: loc.address, currency: loc.currency,
    timeZone: loc.timeZone, phone: loc.phone, email: loc.email, photos: p.photos, amenities: p.amenities, checkInTime: p.checkInTime, checkOutTime: p.checkOutTime, today: localToday(loc),
    onlinePayments: loc.paymentsEnabled,
  });
  async function byToken(id: string, token: string) {
    const [r] = await s.db.select().from(hospReservations).where(eq(hospReservations.id, id));
    if (!r || !r.manageTokenHash || r.manageTokenHash !== sha256(token)) throw notFound('Reservation');
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, r.locationId));
    return { r, loc: loc! };
  }
  async function guestView(r: Reservation, loc: Location) {
    const prop = await propertyFor(s.db, loc);
    const [pay] = r.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, r.paymentId)) : [];
    const folio = await folioView(s.db, r);
    return {
      reservation: reservationView(r, { contact: true }), rooms: await reservationRoomsView(s.db, r),
      property: propertyCard(loc, prop), houseRules: prop.houseRules,
      payment: pay ? { id: pay.id, state: pay.state, amount: { amount: pay.amountMinor, currency: pay.currency }, sandbox: pay.sandbox === 1 } : null,
      cancellation: ['hold', 'confirmed'].includes(r.status) ? await cancellationQuote(s.db, loc, r) : null,
      registrationFields: prop.registrationFields, registration: r.registration ?? {},
      balance: folio.expectedBalance,
      canModify: r.status === 'confirmed' && r.arrival > localToday(loc), canCancel: ['hold', 'confirmed'].includes(r.status),
    };
  }

  // ───────── Discovery ─────────
  app.get('/public/hospitality/:brandSlug', { schema: { tags: ['hospitality'], summary: 'Brand and its bookable properties', params: z.object({ brandSlug: z.string().min(1).max(80) }) } }, async (req) => {
    const org = await brand(req.params.brandSlug);
    const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, org.id), eq(locations.publiclyVisible, true), isNull(locations.archivedAt))).orderBy(asc(locations.name));
    const props = locs.length ? await s.db.select().from(hospProperties).where(inArray(hospProperties.locationId, locs.map((l) => l.id))) : [];
    return { brand: { name: org.name, slug: org.slug, defaultLocale: org.defaultLocale }, properties: locs.filter((l) => props.some((p) => p.locationId === l.id)).map((l) => propertyCard(l, props.find((p) => p.locationId === l.id)!)) };
  });

  app.get('/public/hospitality/properties/:locationId', { schema: { tags: ['hospitality'], params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const { loc, org, prop } = await publicProperty(req.params.locationId);
    const ctx = await rateContext(s.db, loc.id);
    return {
      brand: { name: org.name, slug: org.slug }, property: propertyCard(loc, prop), houseRules: prop.houseRules,
      roomTypes: ctx.roomTypes.filter((t) => t.active && t.bookableOnline).map((t) => ({ id: t.id, code: t.code, name: t.name, kind: t.kind, description: t.description, beds: t.beds, baseOccupancy: t.baseOccupancy, maxOccupancy: t.maxOccupancy, sizeSqm: t.sizeSqm, amenities: t.amenities, photos: t.photos })),
      taxes: ctx.taxes.map((t) => ({ name: t.name, kind: t.kind, rateBps: t.rateBps, amount: t.amountMinor === null ? null : { amount: t.amountMinor, currency: t.currency }, inclusive: t.inclusive, maxNights: t.maxNights, appliesToChildren: t.appliesToChildren })),
      outlet: prop.outletEnabled ? { name: prop.outletName } : null,
    };
  });

  app.get('/public/hospitality/properties/:locationId/availability', {
    schema: { tags: ['hospitality'], summary: 'Available room types and rate choices (totals include taxes the business configured)', params: z.object({ locationId: z.uuid() }), querystring: z.object({ arrival: isoDate, departure: isoDate, adults: z.coerce.number().int().min(1).max(40).default(2), children: z.coerce.number().int().min(0).max(40).default(0), rooms: z.coerce.number().int().min(1).max(10).default(1) }) },
  }, async (req) => {
    const { loc } = await publicProperty(req.params.locationId);
    await expireHolds(s, loc.id);
    if (req.query.arrival < localToday(loc)) return { currency: loc.currency, items: [], message: 'Check-in cannot be in the past' };
    return { currency: loc.currency, items: await searchAvailability(s.db, loc, { ...req.query, online: true }) };
  });

  // ───────── Booking ─────────
  app.post('/public/hospitality/properties/:locationId/reservations', {
    schema: {
      tags: ['hospitality'], summary: 'Hold inventory and start the deposit payment (or confirm when no deposit is due). Returns a manage token.',
      params: z.object({ locationId: z.uuid() }),
      body: z.object({ arrival: isoDate, departure: isoDate, rooms: z.array(roomReq).min(1).max(9), guest, arrivalTime: z.string().regex(/^\d{2}:\d{2}$/).nullish(), specialRequests: z.string().max(1000).nullish(), consent: z.object({ email: z.boolean(), sms: z.boolean() }).partial().optional(), expectedTotalMinor: z.number().int().optional(), source: z.enum(['website', 'mobile']).default('website') }),
    },
  }, async (req, reply) => {
    const { loc } = await publicProperty(req.params.locationId);
    const out = await createReservation(s, loc, { ...req.body, guest: { ...req.body.guest, phone: req.body.guest.phone ?? null } }, { actorUserId: null, staff: false, ip: req.ip });
    if (req.user) {
      // Signed-in guest (mobile): link the customer to the account.
      if (out.reservation.customerId) await s.db.update(customers).set({ userId: req.user.id }).where(and(eq(customers.id, out.reservation.customerId), isNull(customers.userId)));
    }
    return reply.code(201).send({
      reservation: reservationView(out.reservation, { contact: true }), manageToken: out.manageToken, payment: out.payment,
      nextStep: out.reservation.status === 'hold' ? 'Pay the deposit to confirm your stay.' : 'Your stay is confirmed.',
    });
  });

  // ───────── Manage booking ─────────
  app.get('/public/hospitality/reservations/:id', { schema: { tags: ['hospitality'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const { r, loc } = await byToken(req.params.id, req.query.token);
    return guestView(r, loc);
  });

  app.post('/public/hospitality/reservations/:id/modify', {
    schema: { tags: ['hospitality'], summary: 'Change dates. The new nights are secured before the old ones are released; if they are not available the booking stays as it was.', params: z.object({ id: z.uuid() }), body: z.object({ token: z.string().min(10), arrival: isoDate, departure: isoDate, expectedTotalMinor: z.number().int().optional() }) },
  }, async (req) => {
    const { r, loc } = await byToken(req.params.id, req.body.token);
    if (r.status !== 'confirmed') throw conflict('not_modifiable', 'Only confirmed bookings can be changed online');
    const out = await modifyReservation(s, loc, r.id, { arrival: req.body.arrival, departure: req.body.departure, expectedTotalMinor: req.body.expectedTotalMinor }, { actorUserId: null, staff: false });
    return { ...(await guestView(out.reservation, loc)), priceDifference: out.priceDifference };
  });

  app.get('/public/hospitality/reservations/:id/cancellation-quote', { schema: { tags: ['hospitality'], params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const { r, loc } = await byToken(req.params.id, req.query.token);
    return cancellationQuote(s.db, loc, r);
  });

  app.post('/public/hospitality/reservations/:id/cancel', { schema: { tags: ['hospitality'], params: z.object({ id: z.uuid() }), body: z.object({ token: z.string().min(10), reason: z.string().max(300).optional() }) } }, async (req) => {
    const { r, loc } = await byToken(req.params.id, req.body.token);
    const out = await cancelReservation(s, loc, r.id, { actorUserId: null, reason: req.body.reason ?? 'Cancelled by the guest' });
    return { ...(await guestView(out.reservation, loc)), fee: out.fee, refund: out.refund };
  });

  app.post('/public/hospitality/reservations/:id/registration', { schema: { tags: ['hospitality'], summary: 'Pre-arrival registration (only the fields the property asks for)', params: z.object({ id: z.uuid() }), body: z.object({ token: z.string().min(10), fields: z.record(z.string(), z.string().max(200)) }) } }, async (req) => {
    const { r, loc } = await byToken(req.params.id, req.body.token);
    if (!['confirmed', 'checked_in'].includes(r.status)) throw conflict('not_open', 'Registration is closed for this booking');
    const prop = await propertyFor(s.db, loc);
    const registration = cleanRegistration(prop, { ...(r.registration ?? {}), ...req.body.fields }, { requireAll: false });
    const [u] = await s.db.update(hospReservations).set({ registration, updatedAt: new Date() }).where(eq(hospReservations.id, r.id)).returning();
    await audit(s.db, { organizationId: r.organizationId, actorUserId: null, actorType: 'system', action: 'hospitality.registration.guest_updated', scopeKind: 'location', scopeId: r.locationId, targetType: 'hosp_reservation', targetId: r.id, metadata: { fields: Object.keys(req.body.fields) } });
    return guestView(u!, loc);
  });

  // ───────── Signed-in guest ─────────
  app.get('/me/hospitality/reservations', { schema: { tags: ['hospitality'], security: [{ bearerAuth: [] }], summary: 'Stays booked with my account or my verified email' } }, async (req) => {
    const u = requireUser(req);
    const [me] = await s.db.select({ email: users.email, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, u.id));
    const rows = await guestReservations(s.db, u.id, me?.verified ? me.email : `${u.id}@invalid`);
    return { items: rows.map(({ r, loc }) => ({ ...reservationView(r, { contact: true }), property: { name: loc.name, city: loc.address.city, timeZone: loc.timeZone } })) };
  });
};
