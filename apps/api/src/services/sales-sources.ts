/**
 * Gross-sales sources and reconciliation (Network → Connections → Sales sources / Reconciliation).
 *
 * Exactly one source feeds a location's royalty statement:
 *  - `branchharbor`: payments taken through BranchHarbor (the default; with no source row, accepted external sales
 *    reports are still added, as before this feature).
 *  - `connector`: the daily sales of one POS / booking connection (gross, refunds, tax and tips in the location's
 *    currency; BranchHarbor payments are then left out and reported as a warning).
 *  - `self_reported`: the accepted sales report with evidence for the period. Where connector data exists for the same
 *    location and period, the report is compared with it and a variance above the threshold is flagged.
 * Amounts are compared per currency only.
 */
import { and, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { salesVariance, type SalesSourceKind } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { dailySales, externalSalesReports, locations, locationSalesSources, ownerGroups, royaltyStatements, salesConnections } from '../db/schema/index.ts';
import type { RevenueStream } from '../db/schema/finance.ts';
import { periodContaining, type PeriodFrequency, type StreamTotals } from '../domain/royalty.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { salesAggregate } from './finance/statements.ts';
import { getFinanceSettings } from './finance/terms.ts';

type LocationRow = typeof locations.$inferSelect;
type SourceRow = typeof locationSalesSources.$inferSelect;

export async function sourcesFor(db: Exec, organizationId: string) {
  const rows = await db.select().from(locationSalesSources).where(eq(locationSalesSources.organizationId, organizationId));
  return new Map(rows.map((r) => [r.locationId, r]));
}

export const serializeSource = (locationId: string, r: SourceRow | undefined) => ({
  locationId, source: (r?.source ?? 'branchharbor') as SalesSourceKind, explicit: !!r, connectionId: r?.connectionId ?? null, varianceThresholdBps: r?.varianceThresholdBps ?? 500, note: r?.note ?? null,
  updatedAt: r?.updatedAt.toISOString() ?? null,
});

export async function setSalesSource(s: Services, organizationId: string, locationId: string, input: { source: SalesSourceKind; connectionId?: string | null; varianceThresholdBps?: number; note?: string | null }, actorUserId: string) {
  const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  let connectionId: string | null = null;
  if (input.source === 'connector') {
    if (!input.connectionId) throw validationError('Choose the connection that feeds this location’s sales', { connectionId: 'Required' });
    const [c] = await s.db.select().from(salesConnections).where(and(eq(salesConnections.id, input.connectionId), eq(salesConnections.locationId, locationId)));
    if (!c) throw notFound('Connection');
    if (c.status === 'disconnected') throw conflict('connection_disconnected', 'This connection is disconnected; reconnect it first');
    connectionId = c.id;
  }
  const values = { organizationId, source: input.source, connectionId, varianceThresholdBps: input.varianceThresholdBps ?? 500, note: input.note ?? null, setBy: actorUserId, updatedAt: new Date() };
  const [row] = await s.db.insert(locationSalesSources).values({ locationId, ...values }).onConflictDoUpdate({ target: locationSalesSources.locationId, set: values }).returning();
  await audit(s.db, { organizationId, actorUserId, action: 'sales_source.set', scopeKind: 'location', scopeId: locationId, targetType: 'location', targetId: locationId, metadata: { source: input.source, connectionId } });
  return row!;
}

/** Totals of one connection's daily sales over local dates [from, to] in one currency. */
export async function connectorTotals(db: Exec, connectionId: string, currency: string, from: string, to: string) {
  const rows = await db.select().from(dailySales).where(and(eq(dailySales.connectionId, connectionId), gte(dailySales.businessDate, from), lte(dailySales.businessDate, to)));
  const own = rows.filter((r) => r.currency === currency);
  const sum = (k: 'grossMinor' | 'refundsMinor' | 'taxMinor' | 'tipsMinor' | 'netMinor' | 'orderCount') => own.reduce((a, r) => a + r[k], 0);
  const foreign: Record<string, number> = {};
  for (const r of rows.filter((x) => x.currency !== currency)) foreign[r.currency] = (foreign[r.currency] ?? 0) + r.grossMinor;
  const days = new Set(rows.map((r) => r.businessDate));
  return {
    grossMinor: sum('grossMinor'), refundsMinor: sum('refundsMinor'), taxMinor: sum('taxMinor'), tipsMinor: sum('tipsMinor'), netMinor: sum('netMinor'), orders: sum('orderCount'),
    daysSynced: days.size, sandbox: rows.some((r) => r.sandbox), foreign,
  };
}

const periodEnd = (frequency: PeriodFrequency, startDate: string) => (frequency === 'monthly' ? periodContaining('monthly', startDate).endDate : addDays(startDate, 7));

/**
 * The sales a statement uses when the location has an explicit source; null keeps the default (BranchHarbor payments
 * plus accepted external reports). Called by the period close (services/finance/statements.ts).
 */
export async function statementSales(db: Exec, loc: Pick<LocationRow, 'id' | 'currency' | 'organizationId'>, frequency: PeriodFrequency, startDate: string, bh: { streams: Partial<Record<RevenueStream, StreamTotals>>; paymentCount: number }) {
  const [src] = await db.select().from(locationSalesSources).where(eq(locationSalesSources.locationId, loc.id));
  if (!src) return null;
  const lastDay = addDays(periodEnd(frequency, startDate), -1);
  const warnings: string[] = [];
  const bhGross = Object.values(bh.streams).reduce((a, x) => a + (x?.grossMinor ?? 0), 0);
  const [report] = await db.select().from(externalSalesReports).where(and(eq(externalSalesReports.locationId, loc.id), eq(externalSalesReports.frequency, frequency), eq(externalSalesReports.periodStart, startDate)));
  if (src.source === 'branchharbor') {
    if (report?.status === 'accepted') warnings.push('external_sales_ignored:branchharbor_source');
    return { kind: 'branchharbor' as const, streams: bh.streams, external: null, warnings };
  }
  if (bhGross) warnings.push(`branchharbor_payments_ignored:${bhGross}`);
  if (src.source === 'connector') {
    if (!src.connectionId) return { kind: 'connector' as const, streams: {} as Partial<Record<RevenueStream, StreamTotals>>, external: null, warnings: [...warnings, 'sales_source_missing_connection'] };
    const t = await connectorTotals(db, src.connectionId, loc.currency, startDate, lastDay);
    const expected = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
    if (t.daysSynced < expected) warnings.push(`connector_days_missing:${expected - t.daysSynced}`);
    if (t.sandbox) warnings.push('connector_sandbox_data');
    for (const [cur, amt] of Object.entries(t.foreign)) warnings.push(`foreign_currency_sales:${cur}:${amt}`);
    if (report?.status === 'accepted') warnings.push('external_sales_ignored:connector_source');
    return { kind: 'connector' as const, streams: {}, external: { grossMinor: t.grossMinor, refundsMinor: t.refundsMinor, taxMinor: t.taxMinor, tipsMinor: t.tipsMinor }, warnings };
  }
  // Self-reported: the accepted report, compared with any connector data for the same period.
  if (!report) warnings.push('external_sales_missing');
  else if (report.status === 'submitted') warnings.push('external_sales_pending_review');
  const accepted = report?.status === 'accepted' && report.currency === loc.currency ? report : null;
  if (accepted) {
    const v = await selfReportedVariance(db, loc, accepted, startDate, lastDay, src.varianceThresholdBps);
    if (v?.variance.flagged) warnings.push(`self_reported_variance:${v.variance.pct ?? 'n/a'}:${v.provider}`);
  }
  return { kind: 'self_reported' as const, streams: {}, external: accepted ? { grossMinor: accepted.grossMinor, refundsMinor: accepted.refundsMinor, taxMinor: accepted.taxMinor } : null, warnings };
}

/** Self-reported vs observed: (gross − refunds − tax) on both sides, tips included as reports don't separate them. */
async function selfReportedVariance(db: Exec, loc: Pick<LocationRow, 'id' | 'currency'>, report: { grossMinor: number; refundsMinor: number; taxMinor: number }, from: string, to: string, thresholdBps: number) {
  const conns = await db.select().from(salesConnections).where(eq(salesConnections.locationId, loc.id));
  for (const c of conns) {
    const t = await connectorTotals(db, c.id, loc.currency, from, to);
    if (!t.daysSynced) continue;
    const reported = report.grossMinor - report.refundsMinor - report.taxMinor;
    const observed = t.grossMinor - t.refundsMinor - t.taxMinor;
    return { provider: c.provider, connectionId: c.id, observedMinor: observed, reportedMinor: reported, variance: salesVariance(reported, observed, thresholdBps), sandbox: t.sandbox };
  }
  return null;
}

/**
 * Reconciliation for the locations in scope over local dates [from, to]: BranchHarbor payments, each connector, and
 * self-reported periods starting in the range with their variance against connector data.
 */
export async function reconciliation(db: Exec, organizationId: string, scope: 'all' | Set<string>, from: string, to: string) {
  const settings = await getFinanceSettings(db, organizationId);
  const frequency = settings.periodFrequency as PeriodFrequency;
  const locs = (await db.select().from(locations).where(eq(locations.organizationId, organizationId))).filter((l) => !l.archivedAt && l.status !== 'draft' && (scope === 'all' || scope.has(l.id)));
  const groups = new Map((await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, organizationId))).map((g) => [g.id, g.name]));
  const sources = await sourcesFor(db, organizationId);
  const ids = locs.map((l) => l.id);
  const conns = ids.length ? await db.select().from(salesConnections).where(inArray(salesConnections.locationId, ids)) : [];
  const reports = ids.length ? await db.select().from(externalSalesReports).where(and(inArray(externalSalesReports.locationId, ids), gte(externalSalesReports.periodStart, from), lte(externalSalesReports.periodStart, to))) : [];
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const rows = [];
  for (const l of locs.sort((a, b) => a.name.localeCompare(b.name))) {
    const src = sources.get(l.id);
    const agg = await salesAggregate(db, l, zonedToUtc(from, '00:00', l.timeZone), zonedToUtc(addDays(to, 1), '00:00', l.timeZone));
    const st = Object.values(agg.streams);
    const bh = { grossMinor: st.reduce((a, x) => a + (x?.grossMinor ?? 0), 0), refundsMinor: st.reduce((a, x) => a + (x?.refundsMinor ?? 0), 0), taxMinor: st.reduce((a, x) => a + (x?.taxMinor ?? 0), 0), tipsMinor: st.reduce((a, x) => a + (x?.tipsMinor ?? 0), 0), payments: agg.paymentCount };
    const connectors = [];
    for (const c of conns.filter((x) => x.locationId === l.id && x.status !== 'disconnected')) {
      const t = await connectorTotals(db, c.id, l.currency, from, to);
      connectors.push({ connectionId: c.id, provider: c.provider, status: c.status, mode: c.mode, ...t, missingDays: Math.max(0, days - t.daysSynced), lastSyncAt: c.lastSyncAt?.toISOString() ?? null });
    }
    const selfReported = [];
    for (const r of reports.filter((x) => x.locationId === l.id)) {
      const end = addDays(periodEnd(frequency, r.periodStart), -1);
      const v = r.currency === l.currency ? await selfReportedVariance(db, l, r, r.periodStart, end, src?.varianceThresholdBps ?? 500) : null;
      selfReported.push({ id: r.id, periodStart: r.periodStart, periodEnd: end, status: r.status, currency: r.currency, grossMinor: r.grossMinor, refundsMinor: r.refundsMinor, taxMinor: r.taxMinor, comparison: v });
    }
    const source = (src?.source ?? 'branchharbor') as SalesSourceKind;
    const flags: string[] = [];
    if (selfReported.some((x) => x.comparison?.variance.flagged)) flags.push('variance');
    const active = source === 'connector' ? connectors.find((c) => c.connectionId === src?.connectionId) : null;
    if (source === 'connector' && (!active || active.missingDays > 0)) flags.push('missing_days');
    if (source === 'connector' && active?.sandbox) flags.push('sandbox');
    if (connectors.some((c) => Object.keys(c.foreign).length) || Object.keys(agg.foreignByCurrency).length) flags.push('foreign_currency');
    if (source === 'self_reported' && !selfReported.length) flags.push('no_report');
    if (source !== 'branchharbor' && bh.grossMinor > 0) flags.push('branchharbor_payments_ignored');
    if (source === 'branchharbor' && !bh.payments && connectors.length) flags.push('connector_not_source');
    rows.push({
      location: { id: l.id, name: l.name, code: l.code, currency: l.currency, ownerGroupName: l.ownerGroupId ? groups.get(l.ownerGroupId) ?? null : null },
      source: serializeSource(l.id, src), branchharbor: { ...bh, netMinor: bh.grossMinor - bh.refundsMinor - bh.taxMinor - bh.tipsMinor }, connectors, selfReported, flags,
    });
  }
  return { from, to, frequency, rows };
}

/** Daily rows for one location (all sources), for the reconciliation drill-down. */
export async function dailyRows(db: Exec, locationId: string, from: string, to: string) {
  const rows = await db.select().from(dailySales).where(and(eq(dailySales.locationId, locationId), gte(dailySales.businessDate, from), lt(dailySales.businessDate, addDays(to, 1))));
  return rows.sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.source.localeCompare(b.source) || a.channel.localeCompare(b.channel)).map((r) => ({
    date: r.businessDate, source: r.source, channel: r.channel, currency: r.currency, grossMinor: r.grossMinor, refundsMinor: r.refundsMinor, taxMinor: r.taxMinor, tipsMinor: r.tipsMinor,
    discountsMinor: r.discountsMinor, netMinor: r.netMinor, orders: r.orderCount, sandbox: r.sandbox, syncedAt: r.syncedAt.toISOString(),
  }));
}

/** Statements that would change if recalculated (draft or disputed) for a location, so HQ knows to recalculate after a source change. */
export async function openStatementsFor(db: Exec, locationId: string) {
  return db.select({ id: royaltyStatements.id }).from(royaltyStatements).where(and(eq(royaltyStatements.locationId, locationId), inArray(royaltyStatements.status, ['draft', 'disputed'])));
}
