import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { appointments, classBookings, classOccurrences, connections, foodOrders, leads, locations, menus, organizations, paymentReferences, registrations, webhookEvents } from '../db/schema/index.ts';
import { metric, revenueByCurrency, type Freshness } from '../domain/reports.ts';
import { authenticate } from '../plugins/auth.ts';
import { authorisedLocations, capabilityLocations, requirePerm } from '../services/authz.ts';
import { orgParams, secured } from './_common.ts';

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.get('/orgs/:orgId/reports/overview', {
    schema: {
      tags: ['reports'], security: secured, params: orgParams,
      summary: 'Overview metrics with definitions, data source and freshness. Revenue is per currency and never combined. Unavailable data is null, not 0.',
      querystring: z.object({
        scopeKind: z.enum(['organization', 'region', 'owner_group', 'location']).default('organization'),
        scopeId: z.uuid().optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const q = req.query;
    const scopeId = q.scopeId ?? orgId;
    await requirePerm(req, s.db, 'reports.read', { organizationId: orgId, kind: q.scopeKind, id: scopeId });
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);

    // Locations in the requested scope that the user may report on.
    const allowed = await authorisedLocations(req, s.db, orgId, 'reports.read');
    const allLocs = await s.db.select().from(locations).where(eq(locations.organizationId, orgId));
    const [orgRow] = await s.db.select({ model: organizations.model }).from(organizations).where(eq(organizations.id, orgId));
    const independent = orgRow?.model === 'independent';
    const scoped = allLocs.filter((l) =>
      (q.scopeKind === 'organization') || (q.scopeKind === 'region' && l.regionId === scopeId) || (q.scopeKind === 'owner_group' && l.ownerGroupId === scopeId) || (q.scopeKind === 'location' && l.id === scopeId))
      .filter((l) => allowed === 'all' || allowed.has(l.id) || q.scopeKind !== 'organization');
    const locIds = scoped.map((l) => l.id);
    const now = new Date().toISOString();
    const inLocs = <T>(col: T) => (locIds.length ? inArray(col as never, locIds) : sql`false`);

    const [lastWebhook] = await s.db.select({ at: webhookEvents.processedAt }).from(webhookEvents).where(eq(webhookEvents.organizationId, orgId)).orderBy(desc(webhookEvents.processedAt)).limit(1);
    const conns = await s.db.select().from(connections).where(eq(connections.organizationId, orgId));
    const fresh = (source: string, sourceCode: string, lastSyncAt: Date | null = null, complete = true): Freshness => ({ asOf: now, source, sourceCode, lastSyncAt: lastSyncAt?.toISOString() ?? null, complete });

    // Revenue is financial data: it needs Payments (view) at each location, not just Reports. Locations the person
    // can't see finances for are left out (and the metric says it is incomplete); with none, revenue is unavailable.
    const financeAllowed = await capabilityLocations(req, s.db, orgId, 'finance.payments', 'view');
    const financeLocs = scoped.filter((l) => financeAllowed === 'all' || financeAllowed.has(l.id));
    const financeIds = financeLocs.map((l) => l.id);
    const paymentsConnected = financeLocs.some((l) => l.paymentsEnabled);
    const payRows = financeIds.length
      ? await s.db.select({ amountMinor: paymentReferences.amountMinor, currency: paymentReferences.currency, state: paymentReferences.state, refundedMinor: paymentReferences.refundedMinor, locationId: paymentReferences.locationId })
        .from(paymentReferences).where(and(eq(paymentReferences.organizationId, orgId), inArray(paymentReferences.locationId, financeIds), gte(paymentReferences.createdAt, from), lt(paymentReferences.createdAt, to)))
      : [];
    const revenue = !financeIds.length && locIds.length
      ? metric<null>(null, 'Succeeded online payments in the period, grouped by currency.', fresh('BranchHarbor payments (Stripe)', 'payments', null, false), 'Revenue needs access to Payments', { code: 'no_finance_access' })
      : metric(
        paymentsConnected || payRows.length ? revenueByCurrency(payRows) : null,
        'Succeeded online payments in the period, gross and net of refunds, grouped by currency. Excludes payments taken outside BranchHarbor.',
        fresh('BranchHarbor payments (Stripe)', 'payments', lastWebhook?.at ?? null, financeIds.length === locIds.length),
        'No payment account connected for these locations',
        { code: 'no_payment_account' },
      );
    const revenueByLocation = financeLocs.map((l) => ({ locationId: l.id, name: l.name, currency: l.currency, revenue: revenueByCurrency(payRows.filter((p) => p.locationId === l.id)) }));

    // Studios
    const bookingProvider = conns.find((c) => c.kind === 'booking' && c.authoritative === 'external');
    const occRows = locIds.length ? await s.db.select({ id: classOccurrences.id, capacity: classOccurrences.capacity }).from(classOccurrences)
      .where(and(inLocs(classOccurrences.locationId), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to), eq(classOccurrences.status, 'scheduled'))) : [];
    let bookingsMetric;
    let occupancy;
    if (bookingProvider && bookingProvider.state !== 'connected') {
      const reason = `${bookingProvider.provider} is ${bookingProvider.state.replace('_', ' ')} — bookings cannot be measured`;
      const code = { code: 'booking_sync', params: { provider: bookingProvider.provider, state: bookingProvider.state } };
      bookingsMetric = metric<number>(null, 'Confirmed class bookings in the period', fresh(bookingProvider.provider, 'provider', bookingProvider.lastSuccessAt, false), reason, code);
      occupancy = metric<number>(null, 'Confirmed bookings ÷ capacity for scheduled classes', fresh(bookingProvider.provider, 'provider', bookingProvider.lastSuccessAt, false), reason, code);
    } else if (!occRows.length) {
      bookingsMetric = metric<number>(null, 'Confirmed class bookings in the period', fresh('BranchHarbor schedule', 'schedule'), 'No classes scheduled in BranchHarbor for this period', { code: 'no_classes' });
      occupancy = metric<number>(null, 'Confirmed bookings ÷ capacity for scheduled classes', fresh('BranchHarbor schedule', 'schedule'), 'No classes scheduled in BranchHarbor for this period', { code: 'no_classes' });
    } else {
      const [b] = await s.db.select({ c: count() }).from(classBookings).where(and(inArray(classBookings.occurrenceId, occRows.map((o) => o.id)), inArray(classBookings.status, ['confirmed', 'attended', 'no_show'])));
      const cap = occRows.reduce((a, o) => a + o.capacity, 0);
      bookingsMetric = metric(b?.c ?? 0, 'Confirmed class bookings in the period', fresh('BranchHarbor bookings', 'bookings'));
      occupancy = metric(cap ? Math.round(((b?.c ?? 0) / cap) * 1000) / 1000 : null, 'Confirmed bookings ÷ capacity for scheduled classes', fresh('BranchHarbor bookings', 'bookings'), 'No capacity configured', { code: 'no_capacity' });
    }

    // Foods
    const hasMenu = (await s.db.select({ c: count() }).from(menus).where(eq(menus.organizationId, orgId)))[0]?.c ?? 0;
    const foodRows = hasMenu && locIds.length ? await s.db.select({ status: foodOrders.status, c: count() }).from(foodOrders).where(and(inLocs(foodOrders.locationId), gte(foodOrders.createdAt, from), lt(foodOrders.createdAt, to))).groupBy(foodOrders.status) : [];
    const foodMetric = metric(hasMenu ? Object.fromEntries(foodRows.map((r) => [r.status, r.c])) : null, 'Pickup orders by status in the period', fresh('BranchHarbor orders', 'orders'), 'No menu configured', { code: 'no_menu' });

    // Wellness / Sports / Leads
    const appts = locIds.length ? (await s.db.select({ c: count() }).from(appointments).where(and(inLocs(appointments.locationId), eq(appointments.status, 'confirmed'), gte(appointments.startsAt, from), lt(appointments.startsAt, to))))[0]?.c ?? 0 : 0;
    const regs = locIds.length ? await s.db.select({ status: registrations.status, c: count() }).from(registrations).where(and(inLocs(registrations.locationId), gte(registrations.createdAt, from), lt(registrations.createdAt, to))).groupBy(registrations.status) : [];
    const leadCount = locIds.length ? (await s.db.select({ c: count() }).from(leads).where(and(eq(leads.organizationId, orgId), inLocs(leads.locationId), gte(leads.createdAt, from), lt(leads.createdAt, to))))[0]?.c ?? 0 : 0;

    return {
      scope: { kind: q.scopeKind, id: scopeId, locationCount: scoped.length },
      period: { from: from.toISOString(), to: to.toISOString() },
      metrics: {
        revenue,
        combinedRevenue: metric<null>(null, 'Not computed', fresh('n/a', 'none'), 'Amounts in different currencies are not combined without a defined conversion method', { code: 'not_combined' }),
        classBookings: bookingsMetric,
        occupancy,
        foodOrders: foodMetric,
        appointments: metric(appts, 'Confirmed appointments starting in the period', fresh('BranchHarbor appointments', 'appointments')),
        registrations: metric(Object.fromEntries(regs.map((r) => [r.status, r.c])), 'Programme registrations created in the period, by status', fresh('BranchHarbor registrations', 'registrations')),
        leads: metric(leadCount, 'Leads captured by BranchHarbor forms in the period. Excludes enquiries received elsewhere.', fresh('BranchHarbor forms', 'forms')),
      },
      // Independent businesses have one location: no per-location breakdown.
      revenueByLocation: independent ? [] : revenueByLocation,
      businessModel: independent ? 'independent' : 'network',
      connections: conns.map((c) => ({ id: c.id, provider: c.provider, state: c.state, lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null })),
    };
  });
};
