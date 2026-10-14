import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  classBookings, classOccurrences, classSeries, classTypes, consentRecords, customers, locations, memberships, onlineAccessGrants, onlineContent, packs, studioFees, studioPurchases, users,
  waitlistEntries,
} from '../db/schema/index.ts';
import { conflict, notFound, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { reverseTargetPayment } from '../services/payments.ts';
import { bookClass, cancelBooking } from '../services/studios.ts';
import { cancelMembership, chargeRenewalSandbox, createPurchase, pauseMembership, pricingFor, serializeMembership, serializePack, serializePurchase } from '../services/studios-commerce.ts';
import { describePolicy, effectivePolicy, entitlementOptions, membershipUsage, type PayWith } from '../services/studios-entitlements.ts';
import { joinOnline, onlineAccess, registerOnline, serializeContent } from '../services/studios-online.ts';
import { endPortalSession, exchangePortalLink, portalCustomer, requestPortalLink } from '../services/studios-portal.ts';
import { studioBilling } from '../integrations/studio-billing.ts';
import { isoDateTime } from './_common.ts';

const tags = ['studios-customer'];
const payWithSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pay') }), z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('credit'), packId: z.uuid().optional() }), z.object({ kind: z.literal('membership'), membershipId: z.uuid().optional() }),
]);
const purchaseBody = z.object({ locationId: z.uuid(), kind: z.enum(['pack', 'membership', 'offer', 'online', 'fee']), productId: z.uuid().optional(), offerId: z.uuid().optional() });
const SESSION_HEADER = 'x-bh-customer-session';
const TIME_OF_DAY = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] } as const;

export const studioCustomerRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;

  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };
  const publicOcc = async (id: string) => {
    const [r] = await s.db.select({ o: classOccurrences, l: locations }).from(classOccurrences).innerJoin(locations, eq(locations.id, classOccurrences.locationId)).where(eq(classOccurrences.id, id));
    if (!r || !r.l.publiclyVisible || r.l.archivedAt) throw notFound('Class');
    return r;
  };

  // ───────── Public catalogue ─────────
  app.get('/public/studios/:locationId/classes', {
    schema: {
      tags, summary: 'Schedule with filters (class type, category, level, instructor, time of day, online) and booking rules',
      params: z.object({ locationId: z.uuid() }),
      querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional(), classTypeId: z.uuid().optional(), category: z.string().max(40).optional(), level: z.string().max(40).optional(), instructor: z.string().max(120).optional(), timeOfDay: z.enum(['morning', 'afternoon', 'evening']).optional(), online: z.enum(['true', 'false']).optional() }),
    },
  }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86400_000);
    const conds = [eq(classOccurrences.locationId, loc.id), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to)];
    if (req.query.classTypeId) conds.push(eq(classOccurrences.classTypeId, req.query.classTypeId));
    if (req.query.category) conds.push(eq(classTypes.category, req.query.category));
    if (req.query.level) conds.push(eq(classTypes.level, req.query.level));
    if (req.query.instructor) conds.push(eq(classOccurrences.instructorName, req.query.instructor));
    if (req.query.online) conds.push(eq(classOccurrences.online, req.query.online === 'true'));
    const rows = await s.db.select({ o: classOccurrences, t: classTypes, allowCredits: classSeries.allowCredits, allowMembership: classSeries.allowMembership }).from(classOccurrences).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).leftJoin(classSeries, eq(classSeries.id, classOccurrences.seriesId))
      .where(and(...conds)).orderBy(asc(classOccurrences.startsAt));
    const tod = req.query.timeOfDay ? TIME_OF_DAY[req.query.timeOfDay] : null;
    const hourOf = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: loc.timeZone }).format(d));
    const items = tod ? rows.filter((r) => { const h = hourOf(r.o.startsAt); return h >= tod[0] && h < tod[1]; }) : rows;
    const used = items.length ? await s.db.select({ id: classBookings.occurrenceId, n: sql<number>`count(*)::int` }).from(classBookings)
      .where(and(inArray(classBookings.occurrenceId, items.map((r) => r.o.id)), sql`(${classBookings.status} in ('confirmed','attended') or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} > now()))`)).groupBy(classBookings.occurrenceId) : [];
    const live = items.length ? await s.db.select({ occurrenceId: onlineContent.occurrenceId, id: onlineContent.id }).from(onlineContent).where(and(inArray(onlineContent.occurrenceId, items.map((r) => r.o.id)), eq(onlineContent.status, 'published'))) : [];
    // Facets come from the whole week (unfiltered) so customers can always widen the search.
    const all = await s.db.select({ ct: classTypes.id, name: classTypes.name, category: classTypes.category, level: classTypes.level, instructor: classOccurrences.instructorName }).from(classOccurrences).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId))
      .where(and(eq(classOccurrences.locationId, loc.id), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to), eq(classOccurrences.status, 'scheduled')));
    const uniq = <T,>(xs: T[]) => [...new Set(xs.filter((x) => x !== null && x !== undefined && x !== ''))] as Array<NonNullable<T>>;
    const policy = await effectivePolicy(s.db, loc.organizationId, loc.id);
    return {
      location: { id: loc.id, name: loc.name, timeZone: loc.timeZone, currency: loc.currency, paymentsEnabled: loc.paymentsEnabled },
      facets: { classTypes: [...new Map(all.map((a) => [a.ct, { id: a.ct, name: a.name }])).values()].sort((a, b) => a.name.localeCompare(b.name)), categories: uniq(all.map((a) => a.category)).sort(), levels: uniq(all.map((a) => a.level)).sort(), instructors: uniq(all.map((a) => a.instructor)).sort() },
      policy: describePolicy(policy, loc.currency),
      items: items.map(({ o, t, allowCredits, allowMembership }) => {
        const spotsLeft = Math.max(0, o.capacity - (used.find((u) => u.id === o.id)?.n ?? 0));
        const canPayOnline = o.priceMinor === 0 || loc.paymentsEnabled;
        const creditsOk = allowCredits ?? true;
        const membershipOk = allowMembership ?? true;
        const bookable = canPayOnline || creditsOk || membershipOk;
        return {
          id: o.id, classType: { id: t.id, name: t.name, description: t.description, category: t.category, level: t.level }, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(),
          instructorName: o.instructorName, room: o.room, online: o.online, livestreamId: live.find((l) => l.occurrenceId === o.id)?.id ?? null, capacity: o.capacity, spotsLeft,
          price: { amount: o.priceMinor, currency: o.currency }, creditCost: o.creditCost ?? t.creditCost, acceptsCredits: creditsOk, acceptsMembership: membershipOk, payOnline: canPayOnline,
          status: o.status === 'cancelled' ? 'cancelled' : !bookable ? 'unavailable' : spotsLeft > 0 ? 'available' : 'full',
          action: o.status === 'cancelled' || !bookable ? null : spotsLeft > 0 ? 'book' : 'join_waitlist',
        };
      }),
    };
  });

  app.get('/public/studios/:locationId/pricing', { schema: { tags, summary: 'Class packs, memberships and intro offers sold at a location (location currency)', params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const p = await pricingFor(s.db, loc);
    const policy = await effectivePolicy(s.db, loc.organizationId, loc.id);
    return { location: { id: loc.id, name: loc.name, currency: loc.currency, paymentsEnabled: loc.paymentsEnabled }, ...p, policy: describePolicy(policy, loc.currency) };
  });
  app.get('/public/studios/:locationId/policies', { schema: { tags, params: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    return describePolicy(await effectivePolicy(s.db, loc.organizationId, loc.id), loc.currency);
  });
  app.get('/public/studios/:locationId/online', { schema: { tags, summary: 'Online class library (no join links)', params: z.object({ locationId: z.uuid() }), querystring: z.object({ kind: z.enum(['livestream', 'on_demand']).optional() }) } }, async (req) => {
    const loc = await publicLocation(req.params.locationId);
    const rows = await s.db.select().from(onlineContent).where(and(eq(onlineContent.organizationId, loc.organizationId), eq(onlineContent.status, 'published'), or(isNull(onlineContent.locationId), eq(onlineContent.locationId, loc.id)), req.query.kind ? eq(onlineContent.kind, req.query.kind) : sql`true`,
      or(eq(onlineContent.kind, 'on_demand'), sql`${onlineContent.startsAt} + make_interval(mins => coalesce(${onlineContent.durationMinutes}, 60)) > now()`))).orderBy(asc(onlineContent.startsAt), desc(onlineContent.publishedAt));
    return { location: { id: loc.id, name: loc.name, currency: loc.currency, timeZone: loc.timeZone }, items: rows.map((c) => ({ ...serializeContent(c, { includeUrl: false }), price: c.prices[loc.currency] !== undefined ? { amount: c.prices[loc.currency]!, currency: loc.currency } : null })) };
  });

  // ───────── Shared customer views ─────────
  async function accountView(customerId: string, organizationId: string) {
    const now = new Date();
    const [c] = await s.db.select().from(customers).where(eq(customers.id, customerId));
    const [ms, ps, bks, wl, fees, grants, purchases, cons] = await Promise.all([
      s.db.select().from(memberships).where(and(eq(memberships.customerId, customerId), eq(memberships.organizationId, organizationId))).orderBy(desc(memberships.startsAt)),
      s.db.select().from(packs).where(and(eq(packs.customerId, customerId), eq(packs.organizationId, organizationId))).orderBy(desc(packs.createdAt)),
      s.db.select({ b: classBookings, o: classOccurrences, name: classTypes.name, loc: { id: locations.id, name: locations.name, timeZone: locations.timeZone } }).from(classBookings).innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId)).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).innerJoin(locations, eq(locations.id, classBookings.locationId))
        .where(and(eq(classBookings.customerId, customerId), sql`not (${classBookings.status} = 'expired' or (${classBookings.status} = 'held' and ${classBookings.holdExpiresAt} <= now()))`)).orderBy(desc(classOccurrences.startsAt)).limit(100),
      s.db.select({ w: waitlistEntries, o: classOccurrences, name: classTypes.name }).from(waitlistEntries).innerJoin(classOccurrences, eq(classOccurrences.id, waitlistEntries.occurrenceId)).innerJoin(classTypes, eq(classTypes.id, classOccurrences.classTypeId)).where(and(eq(waitlistEntries.customerId, customerId), eq(waitlistEntries.status, 'waiting'))),
      s.db.select().from(studioFees).where(and(eq(studioFees.customerId, customerId), eq(studioFees.status, 'due'))),
      s.db.select({ g: onlineAccessGrants, c: onlineContent }).from(onlineAccessGrants).innerJoin(onlineContent, eq(onlineContent.id, onlineAccessGrants.contentId)).where(and(eq(onlineAccessGrants.customerId, customerId), isNull(onlineAccessGrants.revokedAt))),
      s.db.select().from(studioPurchases).where(eq(studioPurchases.customerId, customerId)).orderBy(desc(studioPurchases.createdAt)).limit(20),
      s.db.select().from(consentRecords).where(and(eq(consentRecords.customerId, customerId), inArray(consentRecords.purpose, ['marketing_email', 'marketing_sms', 'class_updates_email', 'class_updates_sms']))).orderBy(desc(consentRecords.recordedAt)),
    ]);
    const latest = (p: string) => cons.find((x) => x.purpose === p)?.granted ?? null;
    const memberOut = await Promise.all(ms.filter((m) => m.status !== 'cancelled' || (m.endsAt && m.endsAt > new Date(now.getTime() - 90 * 86400_000))).map(async (m) => ({
      ...serializeMembership(m, now), usage: ['active', 'grace'].includes(m.status) ? await membershipUsage(s.db, m, now).then((u) => ({ used: u.used, limit: u.limit, periodEnd: u.periodEnd.toISOString() })) : null,
    })));
    const booking = (r: typeof bks[number]) => ({
      id: r.b.id, occurrenceId: r.o.id, className: r.name, startsAt: r.o.startsAt.toISOString(), endsAt: r.o.endsAt.toISOString(), instructorName: r.o.instructorName, room: r.o.room, online: r.o.online,
      location: r.loc, status: r.b.status, classCancelled: r.o.status === 'cancelled', paymentMethod: r.b.paymentMethod, creditsUsed: r.b.creditsUsed, lateCancel: r.b.lateCancel, creditReturned: r.b.creditReturned, holdExpiresAt: r.b.holdExpiresAt?.toISOString() ?? null,
    });
    return {
      customer: { id: c!.id, name: c!.name, email: c!.email, phone: c!.phone },
      memberships: memberOut,
      packs: ps.filter((p) => p.status === 'active' || (p.expiresAt && p.expiresAt > new Date(now.getTime() - 60 * 86400_000))).map((p) => serializePack(p, now)),
      credits: { available: ps.filter((p) => p.status === 'active' && (!p.expiresAt || p.expiresAt > now)).reduce((a, p) => a + p.creditsRemaining, 0) },
      upcoming: bks.filter((r) => r.o.startsAt >= now && ['confirmed', 'held'].includes(r.b.status)).map(booking).reverse(),
      waitlist: wl.map((r) => ({ id: r.w.id, occurrenceId: r.o.id, className: r.name, startsAt: r.o.startsAt.toISOString() })),
      history: bks.filter((r) => r.o.startsAt < now || !['confirmed', 'held'].includes(r.b.status)).map(booking).slice(0, 50),
      fees: fees.map((f) => ({ id: f.id, kind: f.kind, amount: { amount: f.amountMinor, currency: f.currency }, locationId: f.locationId, createdAt: f.createdAt.toISOString() })),
      online: grants.map((g) => ({ contentId: g.c.id, title: g.c.title, kind: g.c.kind, startsAt: g.c.startsAt?.toISOString() ?? null, basis: g.g.basis, registeredAt: g.g.createdAt.toISOString() })),
      purchases: purchases.map(serializePurchase),
      preferences: { marketingEmail: latest('marketing_email'), marketingSms: latest('marketing_sms'), classUpdatesEmail: latest('class_updates_email') ?? true, classUpdatesSms: latest('class_updates_sms') ?? false },
    };
  }

  async function bookingOptions(customerId: string | null, occId: string) {
    const { o, l } = await publicOcc(occId);
    const policy = await effectivePolicy(s.db, o.organizationId, l.id);
    const base = { occurrenceId: o.id, price: { amount: o.priceMinor, currency: o.currency }, payOnline: o.priceMinor === 0 || l.paymentsEnabled, policy: describePolicy(policy, o.currency) };
    if (!customerId) return { ...base, signedIn: false, creditCost: null, credits: [], memberships: [], outstandingFees: 0, recommended: { kind: 'pay' as const } };
    const opts = await entitlementOptions(s.db, customerId, o, l);
    const m = opts.memberships.find((x) => x.usable);
    const p = opts.credits.find((x) => x.usable);
    return { ...base, signedIn: true, ...opts, recommended: m ? { kind: 'membership' as const, membershipId: m.id } : p ? { kind: 'credit' as const, packId: p.id } : { kind: 'pay' as const } };
  }

  async function bookAs(customerId: string, organizationId: string, occId: string, body: { payWith: PayWith; joinWaitlist: boolean }, source: string, actorUserId: string | null) {
    const { o } = await publicOcc(occId);
    if (o.organizationId !== organizationId) throw notFound('Class');
    return bookClass(s, { organizationId, occurrenceId: o.id, customerId, joinWaitlist: body.joinWaitlist, source, payWith: body.payWith, actorUserId });
  }

  async function cancelAs(customerIds: string[], bookingId: string, actorUserId: string | null) {
    const [b] = await s.db.select().from(classBookings).where(eq(classBookings.id, bookingId));
    if (!b || !customerIds.includes(b.customerId)) throw notFound('Booking');
    const out = await cancelBooking(s, b.id, { actorUserId });
    const payment = out.refundEligible ? await reverseTargetPayment(s, out.booking.paymentId, actorUserId, 'Customer cancelled booking') : { action: 'none' as const };
    return { id: b.id, status: 'cancelled' as const, lateCancel: out.lateCancel, creditReturned: out.creditReturned, fee: out.fee ? { amount: out.fee.amountMinor, currency: out.fee.currency } : null, payment, waitlistPromoted: !!out.promoted };
  }

  async function purchaseAs(customerId: string, organizationId: string, body: z.infer<typeof purchaseBody>, source: string, actorUserId: string | null) {
    const loc = await publicLocation(body.locationId);
    if (loc.organizationId !== organizationId) throw notFound('Location');
    const r = await createPurchase(s, { organizationId, loc, customerId, kind: body.kind, productId: body.productId, offerId: body.offerId, source, actorUserId });
    return { purchase: serializePurchase(r.purchase as never), payment: r.payment };
  }

  async function onlineList(customerId: string | null, locationId: string) {
    const loc = await publicLocation(locationId);
    const rows = await s.db.select().from(onlineContent).where(and(eq(onlineContent.organizationId, loc.organizationId), eq(onlineContent.status, 'published'), or(isNull(onlineContent.locationId), eq(onlineContent.locationId, loc.id)))).orderBy(asc(onlineContent.startsAt));
    const items = [];
    for (const c of rows) {
      const a = await onlineAccess(s.db, c, loc, customerId);
      items.push({ ...serializeContent(c, { includeUrl: false }), price: a.purchasable, access: a });
    }
    return { location: { id: loc.id, name: loc.name, currency: loc.currency, timeZone: loc.timeZone }, items };
  }

  async function loadContent(id: string, locationId: string, organizationId: string) {
    const loc = await publicLocation(locationId);
    const [c] = await s.db.select().from(onlineContent).where(and(eq(onlineContent.id, id), eq(onlineContent.organizationId, organizationId), eq(onlineContent.status, 'published')));
    if (!c || loc.organizationId !== organizationId || (c.locationId && c.locationId !== loc.id)) throw notFound('Online class');
    return { c, loc };
  }

  async function myMembership(customerIds: string[], id: string) {
    const [m] = await s.db.select().from(memberships).where(eq(memberships.id, id));
    if (!m || !customerIds.includes(m.customerId)) throw notFound('Membership');
    return m;
  }

  const consentBody = z.object({ purpose: z.enum(['marketing_email', 'marketing_sms', 'class_updates_email', 'class_updates_sms']), granted: z.boolean() });

  // ───────── Hosted-site customer portal (magic link → session header) ─────────
  app.post('/public/studios/account/link', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { tags, summary: 'Email a sign-in link for the customer portal (same response whether or not the email is known)', body: z.object({ locationId: z.uuid(), email: z.email(), name: z.string().trim().min(1).max(120).optional(), returnUrl: z.url().optional() }) } }, async (req) => {
    const r = await requestPortalLink(s, req.body);
    return { sent: true, ...(r.devToken ? { devCode: r.devToken } : {}) };
  });
  app.post('/public/studios/account/session', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } }, schema: { tags, body: z.object({ code: z.string().min(10).max(200) }) } }, async (req) => exchangePortalLink(s, req.body.code));

  const portal = async (req: FastifyRequest) => portalCustomer(s, req.headers[SESSION_HEADER] as string | undefined);
  app.post('/public/studios/account/sign-out', { schema: { tags } }, async (req) => {
    const h = req.headers[SESSION_HEADER] as string | undefined;
    if (h) await endPortalSession(s, h);
    return { ok: true };
  });
  app.get('/public/studios/account', { schema: { tags, summary: 'My bookings, credits, membership, fees and online classes (portal session)' } }, async (req) => {
    const p = await portal(req);
    return accountView(p.customer.id, p.organizationId);
  });
  app.get('/public/studios/account/occurrences/:id/options', { schema: { tags, params: z.object({ id: z.uuid() }), summary: 'Price, usable credits/memberships and the cancellation policy for a class' } }, async (req) => {
    const h = req.headers[SESSION_HEADER] as string | undefined;
    const p = h ? await portal(req).catch(() => null) : null;
    const { o } = await publicOcc(req.params.id);
    return bookingOptions(p && p.organizationId === o.organizationId ? p.customer.id : null, o.id);
  });
  app.post('/public/studios/account/occurrences/:id/bookings', { schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ payWith: payWithSchema.default({ kind: 'auto' }), joinWaitlist: z.boolean().default(false) }) } }, async (req, reply) => {
    const p = await portal(req);
    return reply.code(201).send(await bookAs(p.customer.id, p.organizationId, req.params.id, req.body, 'web', null));
  });
  app.post('/public/studios/account/bookings/:id/cancel', { schema: { tags, params: z.object({ id: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    return cancelAs([p.customer.id], req.params.id, null);
  });
  app.post('/public/studios/account/purchases', { schema: { tags, body: purchaseBody, summary: 'Buy a pack, membership, intro offer or online class, or pay a fee' } }, async (req, reply) => {
    const p = await portal(req);
    return reply.code(201).send(await purchaseAs(p.customer.id, p.organizationId, req.body, 'web', null));
  });
  app.get('/public/studios/account/purchases/:id', { schema: { tags, params: z.object({ id: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    const [pu] = await s.db.select().from(studioPurchases).where(and(eq(studioPurchases.id, req.params.id), eq(studioPurchases.customerId, p.customer.id)));
    if (!pu) throw notFound('Purchase');
    return serializePurchase(pu);
  });
  app.post('/public/studios/account/memberships/:id/cancel', { schema: { tags, params: z.object({ id: z.uuid() }), summary: 'Cancel my membership (notice period applies)' } }, async (req) => {
    const p = await portal(req);
    return serializeMembership(await cancelMembership(s, await myMembership([p.customer.id], req.params.id), { actorUserId: null }));
  });
  app.post('/public/studios/account/memberships/:id/pause', { schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ from: isoDateTime, until: isoDateTime }) } }, async (req) => {
    const p = await portal(req);
    return serializeMembership(await pauseMembership(s, await myMembership([p.customer.id], req.params.id), { from: new Date(req.body.from), until: new Date(req.body.until), reason: 'Requested by member', actorUserId: null }));
  });
  app.post('/public/studios/account/memberships/:id/retry-payment', { schema: { tags, params: z.object({ id: z.uuid() }), summary: 'Retry a failed renewal (sandbox: simulated success; live: handled by Stripe after updating the card)' } }, async (req) => {
    const p = await portal(req);
    const m = await myMembership([p.customer.id], req.params.id);
    if (!['grace', 'suspended'].includes(m.status)) throw conflict('nothing_to_retry', 'There is no failed payment on this membership');
    if (studioBilling(s.cfg).mode !== 'sandbox') throw conflict('update_card_at_provider', 'Update your card from the payment link in your email; we retry automatically.');
    const r = await chargeRenewalSandbox(s, m.id, 'succeeded');
    return serializeMembership(r.membership);
  });
  app.get('/public/studios/account/online', { schema: { tags, querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    return onlineList(p.customer.id, req.query.locationId);
  });
  app.post('/public/studios/account/online/:id/register', { schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    const { c, loc } = await loadContent(req.params.id, req.body.locationId, p.organizationId);
    return registerOnline(s.db, c, loc, p.customer.id, null);
  });
  app.post('/public/studios/account/online/:id/join', { schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ locationId: z.uuid() }), summary: 'Reveal the join / watch link (registered and entitled customers only)' } }, async (req) => {
    const p = await portal(req);
    const { c, loc } = await loadContent(req.params.id, req.body.locationId, p.organizationId);
    return joinOnline(s.db, c, loc, p.customer.id);
  });
  app.post('/public/studios/account/consents', { schema: { tags, body: consentBody } }, async (req) => {
    const p = await portal(req);
    await s.db.insert(consentRecords).values({ organizationId: p.organizationId, customerId: p.customer.id, email: p.customer.email, purpose: req.body.purpose, version: '2026-10', granted: req.body.granted, source: 'studio_portal', ip: req.ip });
    return { purpose: req.body.purpose, granted: req.body.granted };
  });

  // ───────── Signed-in app customers (mobile) ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const me = async (req: FastifyRequest) => {
      const u0 = requireUser(req);
      const [u] = await s.db.select().from(users).where(eq(users.id, u0.id));
      if (!u || u.deletedAt) throw unauthorized();
      return u;
    };
    const myIds = async (u: typeof users.$inferSelect, organizationId?: string) => {
      const owns = u.emailVerifiedAt ? or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`) : eq(customers.userId, u.id);
      return (await s.db.select({ id: customers.id, org: customers.organizationId }).from(customers).where(and(owns, isNull(customers.erasedAt), organizationId ? eq(customers.organizationId, organizationId) : sql`true`))).map((r) => r.id);
    };
    /** The user's customer record in an organisation (created and linked on first use). */
    const customerIn = async (u: typeof users.$inferSelect, organizationId: string, locationId: string) => {
      const ids = await myIds(u, organizationId);
      if (ids[0]) return ids[0];
      if (!u.emailVerifiedAt) throw conflict('email_not_verified', 'Verify your email to book with your account');
      const c = await findOrCreateCustomer(s.db, organizationId, locationId, { name: u.name, email: u.email }, 'app');
      await s.db.update(customers).set({ userId: u.id }).where(and(eq(customers.id, c.id), isNull(customers.userId)));
      await audit(s.db, { organizationId, actorUserId: u.id, action: 'customer.linked_account', targetType: 'customer', targetId: c.id });
      return c.id;
    };

    priv.get('/me/studios/account', { schema: { tags, security: [{ bearerAuth: [] }], querystring: z.object({ locationId: z.uuid() }), summary: 'My packs, membership, bookings and fees at this business' } }, async (req) => {
      const u = await me(req);
      const loc = await publicLocation(req.query.locationId);
      const id = (await myIds(u, loc.organizationId))[0];
      if (!id) return { customer: null, memberships: [], packs: [], credits: { available: 0 }, upcoming: [], waitlist: [], history: [], fees: [], online: [], purchases: [], preferences: null };
      return accountView(id, loc.organizationId);
    });
    priv.get('/me/studios/occurrences/:id/options', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const { o } = await publicOcc(req.params.id);
      return bookingOptions((await myIds(u, o.organizationId))[0] ?? null, o.id);
    });
    priv.post('/me/studios/occurrences/:id/bookings', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }), body: z.object({ payWith: payWithSchema.default({ kind: 'auto' }), joinWaitlist: z.boolean().default(false) }), summary: 'Book with a membership, pack credit or by paying' } }, async (req, reply) => {
      const u = await me(req);
      const { o } = await publicOcc(req.params.id);
      const cid = await customerIn(u, o.organizationId, o.locationId);
      return reply.code(201).send(await bookAs(cid, o.organizationId, o.id, req.body, 'app', u.id));
    });
    priv.post('/me/studios/bookings/:id/cancel', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      return cancelAs(await myIds(u), req.params.id, u.id);
    });
    priv.post('/me/studios/purchases', { schema: { tags, security: [{ bearerAuth: [] }], body: purchaseBody } }, async (req, reply) => {
      const u = await me(req);
      const loc = await publicLocation(req.body.locationId);
      const cid = await customerIn(u, loc.organizationId, loc.id);
      return reply.code(201).send(await purchaseAs(cid, loc.organizationId, req.body, 'app', u.id));
    });
    priv.get('/me/studios/purchases/:id', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const [pu] = await s.db.select().from(studioPurchases).where(and(eq(studioPurchases.id, req.params.id), inArray(studioPurchases.customerId, await myIds(u))));
      if (!pu) throw notFound('Purchase');
      return serializePurchase(pu);
    });
    priv.post('/me/studios/memberships/:id/cancel', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      return serializeMembership(await cancelMembership(s, await myMembership(await myIds(u), req.params.id), { actorUserId: u.id }));
    });
    priv.get('/me/studios/online', { schema: { tags, security: [{ bearerAuth: [] }], querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const loc = await publicLocation(req.query.locationId);
      return onlineList((await myIds(u, loc.organizationId))[0] ?? null, loc.id);
    });
    priv.post('/me/studios/online/:id/register', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }), body: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const loc = await publicLocation(req.body.locationId);
      const { c } = await loadContent(req.params.id, loc.id, loc.organizationId);
      return registerOnline(s.db, c, loc, await customerIn(u, loc.organizationId, loc.id), u.id);
    });
    priv.post('/me/studios/online/:id/join', { schema: { tags, security: [{ bearerAuth: [] }], params: z.object({ id: z.uuid() }), body: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const loc = await publicLocation(req.body.locationId);
      const { c } = await loadContent(req.params.id, loc.id, loc.organizationId);
      const cid = (await myIds(u, loc.organizationId))[0];
      if (!cid) throw notFound('Online class');
      return joinOnline(s.db, c, loc, cid);
    });
  });
};
