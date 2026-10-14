import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Exec } from '../db/client.ts';
import { classBookings, customers, locations, offerRedemptions, studioOffers, type OfferEligibility } from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { ageOn } from './sports.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { idParams, isoDateTime, orgParams, secured } from './_common.ts';

type Offer = typeof studioOffers.$inferSelect;
type Loc = typeof locations.$inferSelect;

const eligibilitySchema = z.object({
  newCustomersOnly: z.boolean().optional(),
  maxPerCustomer: z.number().int().min(1).max(100).optional(),
  minAge: z.number().int().min(0).max(120).optional(),
  locationIds: z.array(z.uuid()).max(500).optional(),
});

const offerFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  kind: z.enum(['intro_pass', 'class_pack', 'trial_membership']),
  prices: z.partialRecord(currency, z.number().int().min(0)),
  credits: z.number().int().min(1).max(500).nullable().optional(),
  validDays: z.number().int().min(1).max(730),
  eligibility: eligibilitySchema,
  status: z.enum(['draft', 'active', 'paused', 'ended']),
  startsAt: isoDateTime.nullable().optional(),
  endsAt: isoDateTime.nullable().optional(),
};
const offerBody = z.object({
  ...offerFields,
  locationId: z.uuid().nullable().optional(),
  kind: offerFields.kind.default('intro_pass'),
  validDays: offerFields.validDays.default(30),
  eligibility: eligibilitySchema.default({}),
  status: offerFields.status.default('draft'),
});
/** PATCH: every field optional and no defaults (an omitted field is left unchanged). */
const offerPatch = z.object(offerFields).partial();

/** Plain-language rules shown to customers and staff. */
export function describeEligibility(e: OfferEligibility): string[] {
  const out: string[] = [];
  if (e.newCustomersOnly) out.push('New customers only');
  if (e.maxPerCustomer) out.push(e.maxPerCustomer === 1 ? 'Once per customer' : `Up to ${e.maxPerCustomer} times per customer`);
  if (e.minAge) out.push(`Ages ${e.minAge}+`);
  if (e.locationIds?.length) out.push(`At ${e.locationIds.length} selected location${e.locationIds.length === 1 ? '' : 's'}`);
  return out;
}

export interface EligibilityResult { eligible: boolean; reasons: Array<{ code: string; message: string }>; price: { amount: number; currency: string } | null }

/** Evaluate an offer for a location (and optionally a customer). Every failed rule is reported, not just the first. */
export async function checkOfferEligibility(db: Exec, offer: Offer, loc: Loc, customerId: string | null, now = new Date()): Promise<EligibilityResult> {
  const reasons: EligibilityResult['reasons'] = [];
  const e = offer.eligibility;
  if (offer.status !== 'active') reasons.push({ code: 'offer_not_active', message: `This offer is ${offer.status}` });
  if (offer.startsAt && offer.startsAt > now) reasons.push({ code: 'offer_not_started', message: 'This offer has not started yet' });
  if (offer.endsAt && offer.endsAt <= now) reasons.push({ code: 'offer_ended', message: 'This offer has ended' });
  if ((offer.locationId && offer.locationId !== loc.id) || (e.locationIds?.length && !e.locationIds.includes(loc.id))) reasons.push({ code: 'location_not_included', message: `Not available at ${loc.name}` });
  const amount = offer.prices[loc.currency];
  if (amount === undefined) reasons.push({ code: 'no_price_in_currency', message: `No ${loc.currency} price set for this offer` });
  if (customerId) {
    const [c] = await db.select().from(customers).where(and(eq(customers.id, customerId), eq(customers.organizationId, offer.organizationId)));
    if (!c) throw notFound('Customer');
    if (e.newCustomersOnly) {
      const [[b], [r]] = await Promise.all([
        db.select({ n: count() }).from(classBookings).where(and(eq(classBookings.customerId, c.id), inArray(classBookings.status, ['confirmed', 'attended', 'no_show']))),
        db.select({ n: count() }).from(offerRedemptions).where(and(eq(offerRedemptions.customerId, c.id), eq(offerRedemptions.organizationId, offer.organizationId))),
      ]);
      if ((b?.n ?? 0) + (r?.n ?? 0) > 0) reasons.push({ code: 'not_new_customer', message: 'Only for customers who have not visited before' });
    }
    if (e.maxPerCustomer) {
      const [r] = await db.select({ n: count() }).from(offerRedemptions).where(and(eq(offerRedemptions.offerId, offer.id), eq(offerRedemptions.customerId, c.id)));
      if ((r?.n ?? 0) >= e.maxPerCustomer) reasons.push({ code: 'redemption_limit', message: `Already used ${r?.n} of ${e.maxPerCustomer}` });
    }
    if (e.minAge) {
      if (!c.dateOfBirth) reasons.push({ code: 'age_unknown', message: `Date of birth needed to confirm ages ${e.minAge}+` });
      else if (ageOn(c.dateOfBirth, now.toISOString().slice(0, 10)) < e.minAge) reasons.push({ code: 'under_age', message: `Only for ages ${e.minAge}+` });
    }
  }
  return { eligible: reasons.length === 0, reasons, price: amount !== undefined ? { amount, currency: loc.currency } : null };
}

function serializeOffer(o: Offer, extra: { redemptions?: number; locationName?: string | null } = {}) {
  return {
    ...o, startsAt: o.startsAt?.toISOString() ?? null, endsAt: o.endsAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
    scope: o.locationId ? 'location' : 'network', rules: describeEligibility(o.eligibility), redemptions: extra.redemptions ?? 0, locationName: extra.locationName ?? null,
  };
}

export const offerRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  app.get('/public/studios/:locationId/offers', {
    schema: { tags: ['studios'], summary: 'Active introductory offers at a location, priced in the location currency, with plain-language eligibility rules', params: z.object({ locationId: z.uuid() }) },
  }, async (req) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, req.params.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    const rows = await s.db.select().from(studioOffers).where(and(eq(studioOffers.organizationId, loc.organizationId), eq(studioOffers.status, 'active'), or(isNull(studioOffers.locationId), eq(studioOffers.locationId, loc.id))));
    const items = [];
    for (const o of rows) {
      const r = await checkOfferEligibility(s.db, o, loc, null);
      if (!r.eligible) continue;
      items.push({ id: o.id, name: o.name, description: o.description, kind: o.kind, price: r.price, credits: o.credits, validDays: o.validDays, rules: describeEligibility(o.eligibility), endsAt: o.endsAt?.toISOString() ?? null });
    }
    return { location: { id: loc.id, name: loc.name, currency: loc.currency }, items };
  });

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const editScope = (orgId: string, locationId: string | null | undefined) => (locationId ? { organizationId: orgId, kind: 'location' as const, id: locationId } : { organizationId: orgId, kind: 'organization' as const, id: orgId });

    priv.get('/orgs/:orgId/studios/offers', { schema: { tags: ['studios'], security: secured, params: orgParams, summary: 'Introductory offers (network and local) visible in your locations' } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const rows = (await s.db.select().from(studioOffers).where(eq(studioOffers.organizationId, orgId))).filter((o) => !o.locationId || allowed === 'all' || allowed.has(o.locationId));
      const red = rows.length ? await s.db.select({ offerId: offerRedemptions.offerId, n: count() }).from(offerRedemptions).where(inArray(offerRedemptions.offerId, rows.map((r) => r.id))).groupBy(offerRedemptions.offerId) : [];
      const locs = await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, orgId));
      return { items: rows.sort((a, b) => a.name.localeCompare(b.name)).map((o) => serializeOffer(o, { redemptions: red.find((r) => r.offerId === o.id)?.n ?? 0, locationName: locs.find((l) => l.id === o.locationId)?.name ?? null })) };
    });

    priv.post('/orgs/:orgId/studios/offers', {
      schema: { tags: ['studios'], security: secured, params: orgParams, body: offerBody, summary: 'Create an offer: network-wide (HQ) or for one location (marketing.publish in that scope)' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      await requirePerm(req, s.db, 'marketing.publish', editScope(orgId, b.locationId));
      if (b.startsAt && b.endsAt && new Date(b.endsAt) <= new Date(b.startsAt)) throw validationError('The offer must end after it starts', { endsAt: 'Invalid' });
      if (!Object.keys(b.prices).length) throw validationError('Set a price in at least one currency', { prices: 'Required' });
      const [o] = await s.db.insert(studioOffers).values({ ...b, locationId: b.locationId ?? null, description: b.description ?? null, credits: b.credits ?? null, prices: b.prices as Record<string, number>, startsAt: b.startsAt ? new Date(b.startsAt) : null, endsAt: b.endsAt ? new Date(b.endsAt) : null, organizationId: orgId, createdBy: req.user!.id }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'offer.created', scopeKind: o!.locationId ? 'location' : 'organization', scopeId: o!.locationId ?? orgId, targetType: 'offer', targetId: o!.id });
      return reply.code(201).send(serializeOffer(o!));
    });

    const loadOffer = async (orgId: string, id: string) => {
      const [o] = await s.db.select().from(studioOffers).where(and(eq(studioOffers.id, id), eq(studioOffers.organizationId, orgId)));
      if (!o) throw notFound('Offer');
      return o;
    };

    priv.patch('/orgs/:orgId/studios/offers/:id', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: offerPatch, summary: 'Change an offer (pause, end, adjust rules)' },
    }, async (req) => {
      const o = await loadOffer(req.params.orgId, req.params.id);
      await requirePerm(req, s.db, 'marketing.publish', editScope(o.organizationId, o.locationId));
      const b = req.body;
      const [u] = await s.db.update(studioOffers).set({
        ...(b.name !== undefined ? { name: b.name } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.kind ? { kind: b.kind } : {}),
        ...(b.prices ? { prices: b.prices as Record<string, number> } : {}), ...(b.credits !== undefined ? { credits: b.credits } : {}), ...(b.validDays ? { validDays: b.validDays } : {}),
        ...(b.eligibility ? { eligibility: b.eligibility } : {}), ...(b.status ? { status: b.status } : {}),
        ...(b.startsAt !== undefined ? { startsAt: b.startsAt ? new Date(b.startsAt) : null } : {}), ...(b.endsAt !== undefined ? { endsAt: b.endsAt ? new Date(b.endsAt) : null } : {}),
        updatedAt: new Date(),
      }).where(eq(studioOffers.id, o.id)).returning();
      await audit(s.db, { organizationId: o.organizationId, ...actor(req), action: 'offer.updated', targetType: 'offer', targetId: o.id, metadata: { changes: Object.keys(b) } });
      return serializeOffer(u!);
    });

    priv.post('/orgs/:orgId/studios/offers/:id/eligibility', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ locationId: z.uuid(), customerId: z.uuid().optional() }), summary: 'Check whether a customer (or anyone) can use an offer at a location, with every failed rule' },
    }, async (req) => {
      const o = await loadOffer(req.params.orgId, req.params.id);
      const loc = await requireLocationPerm(req, s.db, o.organizationId, req.body.locationId, 'operations.read');
      return checkOfferEligibility(s.db, o, loc, req.body.customerId ?? null);
    });

    priv.post('/orgs/:orgId/studios/offers/:id/redemptions', {
      schema: { tags: ['studios'], security: secured, params: idParams, body: z.object({ locationId: z.uuid(), customerId: z.uuid() }), summary: 'Record that a customer used an offer (eligibility is enforced)' },
    }, async (req, reply) => {
      const o = await loadOffer(req.params.orgId, req.params.id);
      const loc = await requireLocationPerm(req, s.db, o.organizationId, req.body.locationId, 'operations.write');
      const out = await s.db.transaction(async (tx) => {
        // Serialise redemptions per customer so a limit cannot be exceeded by concurrent requests.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`offer:${o.id}:${req.body.customerId}`}))`);
        const r = await checkOfferEligibility(tx, o, loc, req.body.customerId);
        if (!r.eligible) throw conflict('not_eligible', r.reasons.map((x) => x.message).join('; '), { reasons: r.reasons });
        const [row] = await tx.insert(offerRedemptions).values({ organizationId: o.organizationId, offerId: o.id, customerId: req.body.customerId, locationId: loc.id }).returning();
        await audit(tx, { organizationId: o.organizationId, ...actor(req), action: 'offer.redeemed', scopeKind: 'location', scopeId: loc.id, targetType: 'offer', targetId: o.id, metadata: { customerId: req.body.customerId } });
        return { redemption: row!, price: r.price };
      });
      return reply.code(201).send(out);
    });
  });
};
