/**
 * Opt-in network benchmarks (Network → Benchmarks, module `network.benchmarks`). Privacy approach
 * (docs/API_INTEGRATIONS.md "Network benchmarks"):
 *  - Off by default; an organisation takes part only after HQ opts in, and only participants can see benchmarks
 *    (give to get). Opting out deletes the organisation's contributions immediately.
 *  - Contributions are one number per organisation, period (calendar month), metric and currency: never location rows,
 *    names or customer data. They are never returned to anyone.
 *  - Cohort = same industry and region (falling back to the whole industry when the region is too small). A cohort is
 *    published only with at least k = 10 distinct organisations; sizes are published in bands of 5.
 *  - Published percentiles carry Laplace noise scaled to the cohort spread, seeded per cohort and period so repeated
 *    reads cannot be averaged away, and are clamped to the metric's range.
 *  - Money metrics (revenue per location) are compared within one currency only: never converted or mixed.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  BENCHMARK_METRICS, BENCHMARK_MIN_COHORT, MONEY_BENCHMARKS, benchmarkRegion, percentileOf, privatePercentiles, type BenchmarkMetric, type PercentilePoints,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { benchmarkCohorts, benchmarkContributions, dailySales, locationSalesSources, locations, organizations } from '../db/schema/index.ts';
import { audit } from './audit.ts';
import { latestScores } from './audits.ts';
import { activityCounts, revenueByLocation, reviewRatings, royaltyStatus } from './league-table.ts';

type OrgRow = typeof organizations.$inferSelect;

export interface BenchmarkSettings { optIn: boolean; optedInAt: string | null }
export function benchmarkSettings(org: Pick<OrgRow, 'settings'>): BenchmarkSettings {
  const b = (org.settings.benchmarks ?? {}) as Partial<BenchmarkSettings>;
  return { optIn: b.optIn === true, optedInAt: b.optedInAt ?? null };
}

/** Last full calendar month (YYYY-MM). */
export function lastFullMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
const monthBounds = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
};

const BOUNDS: Partial<Record<BenchmarkMetric, [number, number]>> = { occupancy_pct: [0, 100], review_rating: [1, 5], audit_pass_rate: [0, 100], royalty_on_time_rate: [0, 100] };
const DIGITS: Partial<Record<BenchmarkMetric, number>> = { review_rating: 2, revenue_per_location: 0, bookings_per_location: 1 };

/** One organisation's values for a period (per currency for money). Only trading, non-archived locations count. */
export async function computeContributions(db: Exec, org: OrgRow, period: string) {
  const { from, to } = monthBounds(period);
  const locs = (await db.select().from(locations).where(eq(locations.organizationId, org.id))).filter((l) => !l.archivedAt && (l.status === 'operating' || l.status === 'paused'));
  const out: Array<{ metric: BenchmarkMetric; currency: string; value: number; locations: number }> = [];
  if (!locs.length) return out;
  const ids = locs.map((l) => l.id);
  // Revenue: BranchHarbor payments, or connector net sales where a connector is the location's source.
  const rev = await revenueByLocation(db, org.id, locs, from, to);
  const sources = await db.select().from(locationSalesSources).where(inArray(locationSalesSources.locationId, ids));
  const fromYmd = from.toISOString().slice(0, 10);
  const toYmd = to.toISOString().slice(0, 10);
  for (const src of sources.filter((x) => x.source === 'connector' && x.connectionId)) {
    const l = locs.find((x) => x.id === src.locationId)!;
    const [r] = await db.select({ net: sql<string>`coalesce(sum(${dailySales.netMinor}),0)` }).from(dailySales)
      .where(and(eq(dailySales.connectionId, src.connectionId!), eq(dailySales.currency, l.currency), gte(dailySales.businessDate, fromYmd), lt(dailySales.businessDate, toYmd)));
    rev.set(l.id, Number(r?.net ?? 0));
  }
  for (const cur of [...new Set(locs.map((l) => l.currency))]) {
    const mine = locs.filter((l) => l.currency === cur);
    out.push({ metric: 'revenue_per_location', currency: cur, value: mine.reduce((a, l) => a + (rev.get(l.id) ?? 0), 0) / mine.length, locations: mine.length });
  }
  const act = await activityCounts(db, org.industry, ids, from, to);
  out.push({ metric: 'bookings_per_location', currency: '', value: ids.reduce((a, id) => a + (act.activity.get(id) ?? 0), 0) / ids.length, locations: ids.length });
  const occ = [...act.occupancy.values()].filter((v): v is number => v !== null);
  if (occ.length) out.push({ metric: 'occupancy_pct', currency: '', value: occ.reduce((a, b) => a + b, 0) / occ.length, locations: occ.length });
  const reviews = await reviewRatings(db, org.id, ids, from, to);
  const rated = [...reviews.values()].filter((r) => r.count > 0);
  if (rated.length) out.push({ metric: 'review_rating', currency: '', value: rated.reduce((a, r) => a + r.rating * r.count, 0) / rated.reduce((a, r) => a + r.count, 0), locations: rated.length });
  const scores = await latestScores(db, org.id, ids, to);
  const audited = [...scores.values()].filter((x) => x.passed !== null);
  if (audited.length) out.push({ metric: 'audit_pass_rate', currency: '', value: (audited.filter((x) => x.passed).length / audited.length) * 100, locations: audited.length });
  const roy = await royaltyStatus(db, org.id, ids, toYmd);
  const billed = [...roy.values()].filter((x) => x !== 'none');
  if (billed.length) out.push({ metric: 'royalty_on_time_rate', currency: '', value: (billed.filter((x) => x === 'on_time').length / billed.length) * 100, locations: billed.length });
  return out;
}

/** Recomputes the opted-in organisations' contributions and the published cohorts for a period. */
export async function recomputeBenchmarks(s: Pick<Services, 'db' | 'cfg'>, period = lastFullMonth()) {
  const orgs = (await s.db.select().from(organizations)).filter((o) => benchmarkSettings(o).optIn && o.model !== 'independent');
  for (const o of orgs) {
    const values = await computeContributions(s.db, o, period);
    await s.db.delete(benchmarkContributions).where(and(eq(benchmarkContributions.organizationId, o.id), eq(benchmarkContributions.period, period)));
    if (values.length) {
      await s.db.insert(benchmarkContributions).values(values.map((v) => ({ organizationId: o.id, period, industry: o.industry, region: benchmarkRegion(o.country), metric: v.metric, currency: v.currency, value: v.value, locations: v.locations })));
    }
  }
  const all = await s.db.select().from(benchmarkContributions).where(eq(benchmarkContributions.period, period));
  const groups = new Map<string, { industry: string; region: string; metric: string; currency: string; values: Map<string, number> }>();
  const put = (region: string, c: (typeof all)[number]) => {
    const key = `${c.industry}|${region}|${c.metric}|${c.currency}`;
    const g = groups.get(key) ?? { industry: c.industry, region, metric: c.metric, currency: c.currency, values: new Map() };
    g.values.set(c.organizationId, c.value); // one value per organisation
    groups.set(key, g);
  };
  for (const c of all) { put(c.region, c); put('all', c); }
  let published = 0;
  for (const g of groups.values()) {
    const metric = g.metric as BenchmarkMetric;
    const p = privatePercentiles([...g.values.values()], `${period}|${g.industry}|${g.region}|${g.metric}|${g.currency}`, { k: BENCHMARK_MIN_COHORT, bounds: BOUNDS[metric], digits: DIGITS[metric] ?? 1, minScale: metric === 'review_rating' ? 0.02 : 0 });
    const where = and(eq(benchmarkCohorts.period, period), eq(benchmarkCohorts.industry, g.industry), eq(benchmarkCohorts.region, g.region), eq(benchmarkCohorts.metric, g.metric), eq(benchmarkCohorts.currency, g.currency));
    if (!p) {
      // Too few participants now: withdraw the cohort (the demo site keeps its seeded cohorts).
      if (!s.cfg.DEMO_MODE) await s.db.delete(benchmarkCohorts).where(where);
      continue;
    }
    const values = { period, industry: g.industry, region: g.region, metric: g.metric, currency: g.currency, cohortSize: p.cohortSize, p10: p.p10, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p90, computedAt: new Date() };
    await s.db.insert(benchmarkCohorts).values(values).onConflictDoUpdate({ target: [benchmarkCohorts.period, benchmarkCohorts.industry, benchmarkCohorts.region, benchmarkCohorts.metric, benchmarkCohorts.currency], set: values });
    published++;
  }
  return { organisations: orgs.length, contributions: all.length, published };
}

export async function setBenchmarkOptIn(s: Pick<Services, 'db'>, org: OrgRow, optIn: boolean, actorUserId: string) {
  const settings = { ...org.settings, benchmarks: optIn ? { optIn: true, optedInAt: new Date().toISOString(), optedInBy: actorUserId } : { optIn: false, optedInAt: null } };
  await s.db.update(organizations).set({ settings, updatedAt: new Date() }).where(eq(organizations.id, org.id));
  if (!optIn) await s.db.delete(benchmarkContributions).where(eq(benchmarkContributions.organizationId, org.id));
  await audit(s.db, { organizationId: org.id, actorUserId, action: optIn ? 'benchmarks.opted_in' : 'benchmarks.opted_out', targetType: 'organization', targetId: org.id });
  return benchmarkSettings({ settings });
}

/** "You vs similar networks" for a participant: your values with the cohort's published percentiles. */
export async function benchmarksFor(db: Exec, org: OrgRow, period = lastFullMonth()) {
  const st = benchmarkSettings(org);
  const region = benchmarkRegion(org.country);
  const base = { period, industry: org.industry, region, minCohort: BENCHMARK_MIN_COHORT, settings: st };
  if (!st.optIn) return { ...base, optedIn: false as const, metrics: [] };
  // Your own values are computed live (they are yours); the cohort is what was published for the period.
  const mine = await computeContributions(db, org, period);
  const cohorts = await db.select().from(benchmarkCohorts).where(and(eq(benchmarkCohorts.period, period), eq(benchmarkCohorts.industry, org.industry)));
  const metrics = [];
  for (const metric of BENCHMARK_METRICS) {
    const values = mine.filter((m) => m.metric === metric);
    const keys = MONEY_BENCHMARKS.has(metric) ? values.map((v) => v.currency) : [''];
    for (const currency of keys) {
      const you = values.find((v) => v.currency === currency) ?? null;
      const c = cohorts.find((x) => x.metric === metric && x.currency === currency && x.region === region) ?? cohorts.find((x) => x.metric === metric && x.currency === currency && x.region === 'all');
      const points: PercentilePoints | null = c ? { p10: c.p10, p25: c.p25, p50: c.p50, p75: c.p75, p90: c.p90 } : null;
      metrics.push({
        metric, currency: currency || null, you: you ? Math.round(you.value * 100) / 100 : null, locations: you?.locations ?? 0,
        cohort: c ? { scope: c.region === 'all' ? 'industry' as const : 'region' as const, size: c.cohortSize, ...points! } : null,
        percentile: you && points ? percentileOf(you.value, points) : null,
        status: !c ? 'cohort_too_small' as const : !you ? 'no_data' as const : 'ok' as const,
      });
    }
  }
  return { ...base, optedIn: true as const, metrics };
}
