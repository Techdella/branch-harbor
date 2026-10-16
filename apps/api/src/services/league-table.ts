/**
 * League table (Network → League table, capability `network.league_table`): ranks the locations in the viewer's scope
 * by revenue, growth, bookings / orders / occupancy (per industry), audit score, royalty status and review rating.
 *
 * - Revenue is net online payments in each location's own currency. Amounts in different currencies are never added
 *   or ranked against each other: revenue ranks are per currency.
 * - Sensitive figures follow the access model: revenue and growth need Payments (or Royalties organisation-wide),
 *   royalty status needs Statements & invoices (or Royalties), audit scores need Audits. Hidden figures are null.
 * - People without organisation-wide access (franchise owners, location managers) see only their own locations,
 *   compared with anonymised network quartiles (never other franchisees' names or rows) when HQ allows it.
 * - Review rating is an optional metric: a provider can be registered, and a `reviews` table with `location_id` and
 *   `rating` is picked up when it exists. Without either, the column is simply absent.
 */
import { and, count, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { growthPct, quartileOf, quartiles, type Quartiles } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import {
  appointments, portfolios, territories, classBookings, classOccurrences, financeInvoices, foodOrders, franchiseTerritories, hospReservationRooms, hospReservations, hospRooms, locations, orders, organizations, ownerGroups, paymentReferences,
  realtyEnquiries, regions, registrations,
} from '../db/schema/index.ts';
import { localDateParts } from '../lib/tz.ts';
import { capabilityLocations, hasCapability, locationsInScope } from './authz.ts';
import { latestScores } from './audits.ts';

export const LEAGUE_MODULE = 'network.league_table';

export type ReviewProvider = (db: Exec, organizationId: string, locationIds: string[], from: Date, to: Date) => Promise<Map<string, { rating: number; count: number }>>;
const reviewProviders: ReviewProvider[] = [];
/** Lets the reviews module supply ratings (optional join: absent = no column). */
export function registerReviewProvider(p: ReviewProvider) { reviewProviders.push(p); }

/** Falls back to a `reviews` table (location_id, rating, created_at) when one exists; otherwise nothing. */
const tableReviews: ReviewProvider = async (db, organizationId, locationIds, from, to) => {
  const out = new Map<string, { rating: number; count: number }>();
  try {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'reviews'`);
    const names = new Set((cols as unknown as Array<{ column_name: string }>).map((c) => c.column_name));
    if (!names.has('location_id') || !names.has('rating')) return out;
    const time = names.has('created_at') ? sql` and created_at >= ${from} and created_at < ${to}` : sql``;
    const org = names.has('organization_id') ? sql` and organization_id = ${organizationId}` : sql``;
    const rows = await db.execute(sql`select location_id::text as id, avg(rating)::float as rating, count(*)::int as n from reviews where location_id = any(${locationIds}::uuid[])${org}${time} group by location_id`);
    for (const r of rows as unknown as Array<{ id: string; rating: number; n: number }>) out.set(r.id, { rating: Math.round(r.rating * 100) / 100, count: r.n });
  } catch {
    /* no reviews data: the metric is absent */
  }
  return out;
};

/** Review ratings per location from the first provider that has data (used by network benchmarks too). */
export async function reviewRatings(db: Exec, organizationId: string, locationIds: string[], from: Date, to: Date) {
  for (const p of [...reviewProviders, tableReviews]) {
    const m = await p(db, organizationId, locationIds, from, to).catch(() => new Map<string, { rating: number; count: number }>());
    if (m.size) return m;
  }
  return new Map<string, { rating: number; count: number }>();
}

export interface LeagueSettings { franchiseeQuartiles: boolean }
export function leagueSettings(org: { settings: Record<string, unknown> }): LeagueSettings {
  const l = (org.settings.leagueTable ?? {}) as Partial<LeagueSettings>;
  return { franchiseeQuartiles: l.franchiseeQuartiles ?? true };
}

export type ActivityKind = 'class_bookings' | 'registrations' | 'appointments' | 'orders' | 'food_orders' | 'enquiries' | 'room_nights';
const ACTIVITY: Record<string, ActivityKind> = { studios: 'class_bookings', sports: 'registrations', wellness: 'appointments', commerce: 'orders', foods: 'food_orders', realty: 'enquiries', hospitality: 'room_nights' };

export interface LeagueQuery { from: string; to: string; regionId?: string; ownerGroupId?: string; territoryId?: string; portfolioId?: string; sort: 'revenue' | 'growth' | 'activity' | 'occupancy' | 'auditScore' | 'royaltyStatus' | 'reviewRating' }

const DAY = 86_400_000;
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

export async function activityCounts(db: Exec, industry: string, ids: string[], from: Date, to: Date): Promise<{ activity: Map<string, number>; occupancy: Map<string, number | null> }> {
  const activity = new Map<string, number>();
  const occupancy = new Map<string, number | null>();
  if (!ids.length) return { activity, occupancy };
  const put = (rows: Array<{ id: string; c: number }>) => rows.forEach((r) => activity.set(r.id, Number(r.c)));
  switch (ACTIVITY[industry]) {
    case 'class_bookings': {
      put(await db.select({ id: classBookings.locationId, c: count() }).from(classBookings).innerJoin(classOccurrences, eq(classOccurrences.id, classBookings.occurrenceId))
        .where(and(inArray(classBookings.locationId, ids), inArray(classBookings.status, ['confirmed', 'attended', 'no_show']), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to))).groupBy(classBookings.locationId));
      const cap = await db.select({ id: classOccurrences.locationId, c: sql<number>`coalesce(sum(${classOccurrences.capacity}),0)::int` }).from(classOccurrences)
        .where(and(inArray(classOccurrences.locationId, ids), eq(classOccurrences.status, 'scheduled'), gte(classOccurrences.startsAt, from), lt(classOccurrences.startsAt, to))).groupBy(classOccurrences.locationId);
      for (const r of cap) occupancy.set(r.id, r.c ? Math.round(((activity.get(r.id) ?? 0) / r.c) * 1000) / 10 : null);
      break;
    }
    case 'registrations':
      put(await db.select({ id: registrations.locationId, c: count() }).from(registrations).where(and(inArray(registrations.locationId, ids), notInArray(registrations.status, ['cancelled', 'withdrawn', 'rejected']), gte(registrations.createdAt, from), lt(registrations.createdAt, to))).groupBy(registrations.locationId));
      break;
    case 'appointments':
      put(await db.select({ id: appointments.locationId, c: count() }).from(appointments).where(and(inArray(appointments.locationId, ids), inArray(appointments.status, ['confirmed', 'completed', 'checked_in', 'no_show']), gte(appointments.startsAt, from), lt(appointments.startsAt, to))).groupBy(appointments.locationId));
      break;
    case 'orders':
      put(await db.select({ id: orders.locationId, c: count() }).from(orders).where(and(inArray(orders.locationId, ids), notInArray(orders.status, ['pending_payment', 'cancelled']), gte(orders.createdAt, from), lt(orders.createdAt, to))).groupBy(orders.locationId));
      break;
    case 'food_orders':
      put(await db.select({ id: foodOrders.locationId, c: count() }).from(foodOrders).where(and(inArray(foodOrders.locationId, ids), notInArray(foodOrders.status, ['rejected', 'cancelled', 'awaiting_payment']), gte(foodOrders.createdAt, from), lt(foodOrders.createdAt, to))).groupBy(foodOrders.locationId));
      break;
    case 'enquiries':
      put(await db.select({ id: realtyEnquiries.locationId, c: count() }).from(realtyEnquiries).where(and(inArray(realtyEnquiries.locationId, ids), gte(realtyEnquiries.createdAt, from), lt(realtyEnquiries.createdAt, to))).groupBy(realtyEnquiries.locationId));
      break;
    case 'room_nights': {
      const fromYmd = from.toISOString().slice(0, 10);
      const toYmd = to.toISOString().slice(0, 10);
      const rr = await db.select({ id: hospReservations.locationId, nights: hospReservationRooms.nights }).from(hospReservationRooms).innerJoin(hospReservations, eq(hospReservations.id, hospReservationRooms.reservationId))
        .where(and(inArray(hospReservations.locationId, ids), inArray(hospReservations.status, ['confirmed', 'checked_in', 'checked_out']), lt(hospReservations.arrival, toYmd), gte(hospReservations.departure, fromYmd)));
      for (const r of rr) {
        const n = (r.nights as Array<{ date: string }>).filter((x) => x.date >= fromYmd && x.date < toYmd).length;
        activity.set(r.id, (activity.get(r.id) ?? 0) + n);
      }
      const rooms = await db.select({ id: hospRooms.locationId, c: count() }).from(hospRooms).where(and(inArray(hospRooms.locationId, ids), eq(hospRooms.active, true))).groupBy(hospRooms.locationId);
      const nights = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
      for (const r of rooms) occupancy.set(r.id, r.c ? Math.round(((activity.get(r.id) ?? 0) / (Number(r.c) * nights)) * 1000) / 10 : null);
      break;
    }
  }
  for (const id of ids) if (!activity.has(id)) activity.set(id, 0);
  return { activity, occupancy };
}

export async function revenueByLocation(db: Exec, organizationId: string, locs: Array<{ id: string; currency: string }>, from: Date, to: Date) {
  const out = new Map<string, number>();
  if (!locs.length) return out;
  const rows = await db.select({ id: paymentReferences.locationId, currency: paymentReferences.currency, gross: sql<string>`coalesce(sum(${paymentReferences.amountMinor}),0)`, refunded: sql<string>`coalesce(sum(${paymentReferences.refundedMinor}),0)` })
    .from(paymentReferences).where(and(eq(paymentReferences.organizationId, organizationId), inArray(paymentReferences.locationId, locs.map((l) => l.id)), eq(paymentReferences.state, 'succeeded'),
      sql`${paymentReferences.targetType} is distinct from 'royalty_invoice'`, gte(paymentReferences.createdAt, from), lt(paymentReferences.createdAt, to)))
    .groupBy(paymentReferences.locationId, paymentReferences.currency);
  // Only payments in the location's own currency count (a foreign-currency payment is never converted).
  for (const l of locs) {
    const r = rows.find((x) => x.id === l.id && x.currency === l.currency);
    out.set(l.id, r ? Number(r.gross) - Number(r.refunded) : 0);
  }
  return out;
}

export async function royaltyStatus(db: Exec, organizationId: string, ids: string[], today: string) {
  const out = new Map<string, 'on_time' | 'overdue' | 'none'>();
  if (!ids.length) return out;
  const inv = await db.select({ id: financeInvoices.locationId, status: financeInvoices.status, dueDate: financeInvoices.dueDate, total: financeInvoices.totalMinor, paid: financeInvoices.paidMinor })
    .from(financeInvoices).where(and(eq(financeInvoices.organizationId, organizationId), inArray(financeInvoices.locationId, ids), sql`${financeInvoices.status} <> 'void'`));
  for (const id of ids) {
    const mine = inv.filter((i) => i.id === id);
    if (!mine.length) out.set(id, 'none');
    else out.set(id, mine.some((i) => (i.status === 'open' || i.status === 'processing') && i.dueDate < today && i.paid < i.total) ? 'overdue' : 'on_time');
  }
  return out;
}

const some = (x: 'all' | Set<string>) => x === 'all' || x.size > 0;
const has = (x: 'all' | Set<string>, id: string) => x === 'all' || x.has(id);

/** The league table for a viewer. */
export async function leagueTable(req: FastifyRequest, db: Exec, organizationId: string, q: LeagueQuery, now = new Date()) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  const settings = leagueSettings(org!);
  const today = localDateParts(now, org!.defaultTimeZone).date;
  const orgTarget = { organizationId, kind: 'organization' as const, id: organizationId };
  const hq = await hasCapability(req, db, LEAGUE_MODULE, 'view', orgTarget);
  const allowed = await capabilityLocations(req, db, organizationId, LEAGUE_MODULE, 'view');
  const financeOrg = await hasCapability(req, db, 'finance.royalties', 'view', orgTarget);
  const payments = financeOrg ? 'all' as const : await capabilityLocations(req, db, organizationId, 'finance.payments', 'view');
  const invoices = financeOrg ? 'all' as const : await capabilityLocations(req, db, organizationId, 'finance.invoices', 'view');
  const auditsSeen = await capabilityLocations(req, db, organizationId, 'operations.audits', 'view');

  const from = dayStart(q.from);
  const to = new Date(dayStart(q.to).getTime() + DAY);
  const span = to.getTime() - from.getTime();
  // Whole calendar months compare with the same number of months before; other periods with the same number of days.
  const wholeMonths = from.getUTCDate() === 1 && to.getUTCDate() === 1;
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  const prevFrom = wholeMonths ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1)) : new Date(from.getTime() - span);

  // Territory: an access-scope territory (a sub-network: its locations), or a franchise pipeline territory (the owner
  // group that bought it). Portfolio: the locations in it (access scopes, services/authz.ts).
  let territoryGroup: string | null | undefined;
  let scopeIds: Set<string> | undefined;
  if (q.territoryId) {
    const [sub] = await db.select({ id: territories.id }).from(territories).where(and(eq(territories.id, q.territoryId), eq(territories.organizationId, organizationId)));
    if (sub) {
      const inScope = await locationsInScope(db, organizationId, 'territory', sub.id);
      scopeIds = inScope === 'all' ? undefined : inScope;
    } else {
      const [t] = await db.select({ g: franchiseTerritories.ownerGroupId }).from(franchiseTerritories).where(and(eq(franchiseTerritories.id, q.territoryId), eq(franchiseTerritories.organizationId, organizationId)));
      territoryGroup = t?.g ?? null;
    }
  }
  if (q.portfolioId) {
    const [pf] = await db.select({ id: portfolios.id }).from(portfolios).where(and(eq(portfolios.id, q.portfolioId), eq(portfolios.organizationId, organizationId)));
    const inPortfolio = pf ? await locationsInScope(db, organizationId, 'portfolio', pf.id) : new Set<string>();
    const ids = inPortfolio === 'all' ? null : inPortfolio;
    if (ids) scopeIds = scopeIds ? new Set([...scopeIds].filter((x) => ids.has(x))) : ids;
  }
  // Every operating location (for network quartiles), then the viewer's rows after filters.
  const network = (await db.select({ id: locations.id, name: locations.name, code: locations.code, currency: locations.currency, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, status: locations.status, archivedAt: locations.archivedAt })
    .from(locations).where(eq(locations.organizationId, organizationId))).filter((l) => !l.archivedAt && (l.status === 'operating' || l.status === 'paused'));
  const filtered = network.filter((l) => (!q.regionId || l.regionId === q.regionId) && (!q.ownerGroupId || l.ownerGroupId === q.ownerGroupId) && (territoryGroup === undefined || (!!territoryGroup && l.ownerGroupId === territoryGroup)) && (!scopeIds || scopeIds.has(l.id)));
  const mine = filtered.filter((l) => has(allowed, l.id));
  const computeFor = hq || settings.franchiseeQuartiles ? network : mine;
  const ids = computeFor.map((l) => l.id);

  const [rev, prev, act, scores, royalty] = await Promise.all([
    revenueByLocation(db, organizationId, computeFor, from, to),
    revenueByLocation(db, organizationId, computeFor, prevFrom, from),
    activityCounts(db, org!.industry, ids, from, to),
    latestScores(db, organizationId, ids, to),
    royaltyStatus(db, organizationId, ids, today),
  ]);
  let reviews = new Map<string, { rating: number; count: number }>();
  for (const p of [...reviewProviders, tableReviews]) {
    const m = await p(db, organizationId, ids, from, to).catch(() => new Map());
    if (m.size) { reviews = m; break; }
  }
  const hasReviews = reviews.size > 0;
  const hasOccupancy = act.occupancy.size > 0;

  const groupNames = new Map((await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, organizationId))).map((g) => [g.id, g.name]));
  const regionNames = new Map((await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, organizationId))).map((g) => [g.id, g.name]));

  const metricsOf = (l: (typeof network)[number]) => {
    const r = rev.get(l.id) ?? 0;
    const p = prev.get(l.id) ?? 0;
    const score = scores.get(l.id);
    return {
      revenueMinor: r, previousRevenueMinor: p, growthPct: growthPct(r, p), activity: act.activity.get(l.id) ?? 0, occupancyPct: act.occupancy.get(l.id) ?? null,
      auditScorePct: score?.scorePct ?? null, auditPassed: score?.passed ?? null, auditAt: score?.completedAt.toISOString() ?? null,
      royaltyStatus: royalty.get(l.id) ?? 'none', reviewRating: reviews.get(l.id)?.rating ?? null, reviewCount: reviews.get(l.id)?.count ?? 0,
    };
  };
  const all = computeFor.map((l) => ({ l, m: metricsOf(l) }));

  const rows = mine.map((l) => {
    const m = all.find((x) => x.l.id === l.id)!.m;
    const seeMoney = has(payments, l.id);
    return {
      locationId: l.id, name: l.name, code: l.code, currency: l.currency, regionId: l.regionId, regionName: l.regionId ? regionNames.get(l.regionId) ?? null : null,
      ownerGroupId: l.ownerGroupId, ownerGroupName: l.ownerGroupId ? groupNames.get(l.ownerGroupId) ?? null : null,
      revenueMinor: seeMoney ? m.revenueMinor : null, previousRevenueMinor: seeMoney ? m.previousRevenueMinor : null, growthPct: seeMoney ? m.growthPct : null,
      activity: m.activity, occupancyPct: m.occupancyPct,
      auditScorePct: has(auditsSeen, l.id) ? m.auditScorePct : null, auditPassed: has(auditsSeen, l.id) ? m.auditPassed : null, auditAt: has(auditsSeen, l.id) ? m.auditAt : null,
      royaltyStatus: has(invoices, l.id) ? m.royaltyStatus : null,
      reviewRating: hasReviews ? m.reviewRating : null, reviewCount: hasReviews ? m.reviewCount : 0,
      rank: 0, rankOf: 0, quartile: null as 1 | 2 | 3 | 4 | null,
    };
  });

  // Ranking: higher is better; royalty status on time before none before overdue; nulls last. Revenue ranks per currency.
  const val = (r: (typeof rows)[number]): number | null => {
    switch (q.sort) {
      case 'revenue': return r.revenueMinor;
      case 'growth': return r.growthPct;
      case 'activity': return r.activity;
      case 'occupancy': return r.occupancyPct;
      case 'auditScore': return r.auditScorePct;
      case 'royaltyStatus': return r.royaltyStatus === null ? null : r.royaltyStatus === 'on_time' ? 2 : r.royaltyStatus === 'none' ? 1 : 0;
      case 'reviewRating': return r.reviewRating;
    }
  };
  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    const x = val(a); const y = val(b);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || a.name.localeCompare(b.name);
  };
  const groupsOf = q.sort === 'revenue' ? [...new Set(rows.map((r) => r.currency))] : [null];
  for (const g of groupsOf) {
    const list = rows.filter((r) => g === null || r.currency === g).sort(cmp);
    list.forEach((r, i) => { r.rank = val(r) === null ? 0 : i + 1; r.rankOf = list.filter((x) => val(x) !== null).length; });
  }
  rows.sort((a, b) => (q.sort === 'revenue' ? a.currency.localeCompare(b.currency) : 0) || (a.rank || 1e9) - (b.rank || 1e9) || a.name.localeCompare(b.name));

  // Network quartiles (anonymised): per metric, and per currency for money. Only for figures the viewer may see.
  const seeMoneyAny = mine.some((l) => has(payments, l.id));
  const showBenchmarks = hq || settings.franchiseeQuartiles;
  const benchmarks = showBenchmarks ? {
    locationCount: all.length,
    revenue: seeMoneyAny ? [...new Set(rows.map((r) => r.currency))].map((c) => ({ currency: c, quartiles: quartiles(all.filter((x) => x.l.currency === c).map((x) => x.m.revenueMinor)) })) : [],
    growthPct: seeMoneyAny ? quartiles(all.map((x) => x.m.growthPct).filter((v): v is number => v !== null)) : null,
    activity: quartiles(all.map((x) => x.m.activity)),
    occupancyPct: hasOccupancy ? quartiles(all.map((x) => x.m.occupancyPct).filter((v): v is number => v !== null)) : null,
    auditScorePct: some(auditsSeen) ? quartiles(all.map((x) => x.m.auditScorePct).filter((v): v is number => v !== null)) : null,
    reviewRating: hasReviews ? quartiles(all.map((x) => x.m.reviewRating).filter((v): v is number => v !== null)) : null,
    royaltyOnTimePct: some(invoices) ? (() => { const w = all.filter((x) => x.m.royaltyStatus !== 'none'); return w.length >= 4 ? Math.round((w.filter((x) => x.m.royaltyStatus === 'on_time').length / w.length) * 1000) / 10 : null; })() : null,
  } : null;

  // Quartile of each row on the sorted metric, against the network.
  if (benchmarks) {
    for (const r of rows) {
      const v = val(r);
      let qq: Quartiles | null = null;
      if (q.sort === 'revenue') qq = benchmarks.revenue.find((b) => b.currency === r.currency)?.quartiles ?? null;
      else if (q.sort === 'growth') qq = benchmarks.growthPct;
      else if (q.sort === 'activity') qq = benchmarks.activity;
      else if (q.sort === 'occupancy') qq = benchmarks.occupancyPct;
      else if (q.sort === 'auditScore') qq = benchmarks.auditScorePct;
      else if (q.sort === 'reviewRating') qq = benchmarks.reviewRating;
      r.quartile = v !== null && qq ? quartileOf(v, qq) : null;
    }
  }
  // Where an own location sits in the whole network (anonymised position only), for people without HQ access.
  const networkRanks = !hq && settings.franchiseeQuartiles ? Object.fromEntries(rows.map((r) => {
    const v = val(r);
    if (v === null) return [r.locationId, null];
    const pool = all.filter((x) => q.sort !== 'revenue' || x.l.currency === r.currency).map((x) => {
      const m = x.m;
      switch (q.sort) {
        case 'revenue': return m.revenueMinor;
        case 'growth': return m.growthPct;
        case 'activity': return m.activity;
        case 'occupancy': return m.occupancyPct;
        case 'auditScore': return m.auditScorePct;
        case 'royaltyStatus': return m.royaltyStatus === 'on_time' ? 2 : m.royaltyStatus === 'none' ? 1 : 0;
        case 'reviewRating': return m.reviewRating;
      }
    }).filter((x): x is number => x !== null);
    return pool.length >= 4 ? [r.locationId, { position: pool.filter((x) => x > v).length + 1, of: pool.length }] : [r.locationId, null];
  })) : null;

  return {
    period: { from: q.from, to: q.to, previousFrom: prevFrom.toISOString().slice(0, 10), previousTo: new Date(from.getTime() - DAY).toISOString().slice(0, 10) },
    sort: q.sort, industry: org!.industry, activityKind: ACTIVITY[org!.industry] ?? null,
    view: hq ? 'network' as const : 'own' as const,
    columns: { revenue: rows.some((r) => r.revenueMinor !== null), occupancy: hasOccupancy, auditScore: some(auditsSeen), royaltyStatus: some(invoices), reviewRating: hasReviews },
    rows, benchmarks, networkRanks, settings: { franchiseeQuartiles: settings.franchiseeQuartiles },
    currencies: [...new Set(rows.map((r) => r.currency))].sort(),
  };
}
