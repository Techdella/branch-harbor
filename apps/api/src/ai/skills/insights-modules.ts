import { and, asc, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';
import { addDaysYmd, renewalPhase, renewalWindow, type InsightEvidence, type InsightKind, type SuggestedAction } from '@bh/shared';
import type { Services } from '../../context.ts';
import {
  agreementNotices, coopClaims, franchiseAgreements, franchiseSurveys, listingDrifts, locations, organizations, ownerGroups, salesConnections, selfCheckRuns, supplyPurchaseOrders,
  supplySuppliers, trackedCalls,
} from '../../db/schema/index.ts';
import { benchmarksFor, lastFullMonth } from '../../services/benchmarks.ts';
import { orgToday } from '../../services/franchise-dev/surveys.ts';
import { surveyTrend } from '../../services/franchise-dev/surveys.ts';
import { reconciliation } from '../../services/sales-sources.ts';
import { fmtMoney } from '../present.ts';

/**
 * Insights from the modules added after the first release: listing drift, co-op claims waiting, missed calls without a
 * follow-up, sales sync failures and variance, late purchase orders, missed self-checks, cure periods and renewal
 * windows, survey score drops and benchmark percentile changes. Same contract as insights.ts: deterministic, with the
 * evidence behind each one, a module and location for visibility, and suggested actions that become action cards.
 */

export interface ModuleInsight {
  kind: InsightKind;
  locationId: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  explanation: string;
  evidence: InsightEvidence[];
  suggestedActions: SuggestedAction[];
  module: string;
  fingerprint: string;
  currency?: string | null;
  periodLabel?: string | null;
}

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const remind = (label: string, title: string, link: string, days = 1): SuggestedAction => ({ label, tool: 'remind_me', input: { title, remindAt: inDays(days), link } });
const week = (d: Date) => `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)).padStart(2, '0')}`;
const LISTING_FIELDS = new Set(['phone', 'description', 'websiteUrl', 'bookingUrl']);
const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : Array.isArray(v) ? `${v.length} entr${v.length === 1 ? 'y' : 'ies'}` : v && typeof v === 'object' ? 'changed' : String(v ?? '—'));

export async function detectModuleInsights(s: Services, orgId: string, now = new Date()): Promise<ModuleInsight[]> {
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) return [];
  const locs = await s.db.select({ id: locations.id, name: locations.name, currency: locations.currency }).from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)));
  const name = (id: string | null) => locs.find((l) => l.id === id)?.name ?? 'A location';
  const today = await orgToday(s.db, orgId, now);
  const wk = week(now);
  const out: ModuleInsight[] = [];
  const guard = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      s.log.warn({ err, orgId, signal: label }, '[ai] insight signal failed');
    }
  };

  // Listing drift: fields edited on a directory outside BranchHarbor, per location.
  await guard('listing_drift', async () => {
    const drifts = await s.db.select().from(listingDrifts).where(and(eq(listingDrifts.organizationId, orgId), eq(listingDrifts.status, 'open')));
    for (const locationId of [...new Set(drifts.map((d) => d.locationId))]) {
      const ds = drifts.filter((d) => d.locationId === locationId);
      const loc = name(locationId);
      const restorable = ds.find((d) => LISTING_FIELDS.has(d.field) && typeof d.ourValue === 'string');
      out.push({
        kind: 'listing_drift', locationId, severity: ds.some((d) => ['phone', 'name', 'address', 'hours'].includes(d.field)) ? 'warning' : 'info', module: 'marketing.listings',
        title: `${loc}: ${ds.length} listing field${ds.length === 1 ? '' : 's'} changed outside BranchHarbor`,
        explanation: `${ds.map((d) => `${d.field} on ${d.provider}`).join(', ')} no longer match${ds.length === 1 ? 'es' : ''} what BranchHarbor publishes. Customers may see wrong details until someone accepts or overwrites the change.`,
        evidence: ds.slice(0, 4).map((d) => ({ label: `${d.field} (${d.provider})`, value: `ours “${short(d.ourValue)}”, directory “${short(d.theirValue)}”` })),
        suggestedActions: [
          ...(restorable ? [{ label: `Push our ${restorable.field} back to the directories`, tool: 'propose_listing_change', input: { location: loc, [restorable.field]: restorable.ourValue as string, note: 'Restoring the published value after a directory edit' } }] : []),
          remind('Remind me to review the listing', `Review directory edits for ${loc}`, '/marketing/listings'),
        ],
        fingerprint: `listing_drift:${locationId}:${ds.map((d) => d.id).sort().join(',').slice(0, 120)}`,
      });
    }
  });

  // Co-op claims waiting for HQ for more than two days (an organisation-wide insight: HQ decides).
  await guard('coop_claims_waiting', async () => {
    const claims = await s.db.select().from(coopClaims).where(and(eq(coopClaims.organizationId, orgId), eq(coopClaims.status, 'submitted'), lt(coopClaims.createdAt, new Date(now.getTime() - 2 * DAY))));
    if (!claims.length) return;
    const oldest = Math.max(...claims.map((c) => Math.floor((now.getTime() - c.createdAt.getTime()) / DAY)));
    const byCur = new Map<string, number>();
    for (const c of claims) byCur.set(c.currency, (byCur.get(c.currency) ?? 0) + c.spentMinor);
    out.push({
      kind: 'coop_claims_waiting', locationId: null, severity: oldest > 10 ? 'warning' : 'info', module: 'marketing.coop',
      title: `${claims.length} co-op claim${claims.length === 1 ? '' : 's'} waiting for review`,
      explanation: `Locations claimed reimbursement for local marketing; the oldest claim has waited ${oldest} days. Reviewing promptly keeps franchisees spending on approved activity.`,
      evidence: [{ label: 'Claims waiting', value: String(claims.length) }, { label: 'Oldest', value: `${oldest} days` }, ...[...byCur].map(([cur, v]) => ({ label: `Claimed (${cur})`, value: fmtMoney(v, cur) }))],
      suggestedActions: [remind('Remind me to review the claims', 'Review waiting co-op claims', '/marketing/coop', 0.05)],
      fingerprint: `coop_claims_waiting:${wk}`,
    });
  });

  // Missed calls without a follow-up in the last 7 days, per location (2 or more).
  await guard('missed_calls', async () => {
    const calls = await s.db.select().from(trackedCalls).where(and(eq(trackedCalls.organizationId, orgId), inArray(trackedCalls.status, ['missed', 'unanswered', 'voicemail']), isNull(trackedCalls.followedUpAt), gte(trackedCalls.startedAt, new Date(now.getTime() - 7 * DAY))));
    for (const locationId of [...new Set(calls.map((c) => c.locationId))]) {
      const cs = calls.filter((c) => c.locationId === locationId);
      if (cs.length < 2) continue;
      const loc = name(locationId);
      const first = cs.filter((c) => c.firstTimeCaller).length;
      out.push({
        kind: 'missed_calls', locationId, severity: cs.length >= 5 || first >= 3 ? 'warning' : 'info', module: 'marketing.call_tracking', periodLabel: 'last 7 days',
        title: `${loc}: ${cs.length} missed calls without a follow-up`,
        explanation: `${cs.length} calls to ${loc} in the last 7 days were missed and nobody has called back yet${first ? `; ${first} were first-time callers` : ''}.`,
        evidence: [{ label: 'Missed, not followed up', value: String(cs.length) }, { label: 'First-time callers', value: String(first) }, { label: 'Sources', value: [...new Set(cs.map((c) => c.source))].join(', ') }],
        suggestedActions: [remind('Remind me to call them back', `Call back missed callers at ${loc}`, '/marketing/calls?status=missed', 0.05)],
        fingerprint: `missed_calls:${locationId}:${wk}`,
      });
    }
  });

  // Sales data: connectors that stopped syncing, and reconciliation flags for the last closed month.
  await guard('sales_variance', async () => {
    const conns = await s.db.select().from(salesConnections).where(eq(salesConnections.organizationId, orgId));
    for (const c of conns.filter((x) => x.status === 'authorization_expired' || x.lastSyncStatus === 'failed')) {
      const loc = name(c.locationId);
      out.push({
        kind: 'sales_variance', locationId: c.locationId, severity: 'warning', module: 'network.sales_connectors',
        title: `${loc}: ${c.provider} sales sync ${c.status === 'authorization_expired' ? 'lost its authorisation' : 'is failing'}`,
        explanation: `The ${c.provider} connection for ${loc} ${c.status === 'authorization_expired' ? 'needs to be reconnected by someone with access to the vendor account' : 'failed its last sync'}${c.lastError ? ` (“${c.lastError.slice(0, 160)}”)` : ''}. Royalty reconciliation will miss days until it syncs again.`,
        evidence: [{ label: 'Status', value: c.status.replace(/_/g, ' ') }, { label: 'Last sync', value: c.lastSyncAt ? c.lastSyncAt.toISOString().slice(0, 16).replace('T', ' ') : '—' }],
        suggestedActions: c.status === 'authorization_expired'
          ? [remind('Remind me to reconnect it', `Reconnect ${c.provider} for ${loc}`, '/sales-connectors')]
          : [{ label: 'Resync the last three days', tool: 'propose_resync', input: { location: loc, provider: c.provider } }, remind('Remind me to check the connector', `Check the ${c.provider} connector for ${loc}`, '/sales-connectors')],
        fingerprint: `sales_sync:${c.id}:${wk}`,
      });
    }
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const rec = await reconciliation(s.db, orgId, 'all', first, last);
    for (const row of rec.rows as any[]) {
      const self = (row.selfReported ?? []).find((x: any) => x.comparison?.variance?.flagged);
      if (!self) continue;
      const v = self.comparison;
      out.push({
        kind: 'sales_variance', locationId: row.location.id, severity: Math.abs(v.variance.pct) >= 20 ? 'critical' : 'warning', module: 'network.sales_connectors', currency: row.location.currency, periodLabel: `${first} to ${last}`,
        title: `${row.location.name}: reported sales ${v.variance.pct > 0 ? 'above' : 'below'} connector data by ${Math.abs(v.variance.pct)}%`,
        explanation: `${row.location.name} self-reported ${fmtMoney(v.reportedMinor, row.location.currency)} for ${first} to ${last}; ${v.provider} recorded ${fmtMoney(v.observedMinor, row.location.currency)}. That is beyond the location’s variance threshold, so check it before royalties are invoiced.`,
        evidence: [{ label: 'Self-reported', value: fmtMoney(v.reportedMinor, row.location.currency) }, { label: `${v.provider} data`, value: fmtMoney(v.observedMinor, row.location.currency) }, { label: 'Difference', value: `${fmtMoney(v.variance.diffMinor, row.location.currency)} (${v.variance.pct}%)` }],
        suggestedActions: [remind('Remind me to review the reconciliation', `Review the sales variance at ${row.location.name}`, '/sales-connectors/reconciliation', 0.05)],
        fingerprint: `sales_variance:${row.location.id}:${first}`,
      });
    }
  });

  // Late purchase orders (sent, confirmed or partly received, past the expected delivery date).
  await guard('late_deliveries', async () => {
    const pos = await s.db.select({ p: supplyPurchaseOrders, sup: supplySuppliers.name }).from(supplyPurchaseOrders).innerJoin(supplySuppliers, eq(supplySuppliers.id, supplyPurchaseOrders.supplierId))
      .where(and(eq(supplyPurchaseOrders.organizationId, orgId), inArray(supplyPurchaseOrders.status, ['sent', 'confirmed', 'partially_received']), lt(supplyPurchaseOrders.expectedDeliveryDate, today)));
    for (const locationId of [...new Set(pos.map((x) => x.p.locationId))]) {
      const ps = pos.filter((x) => x.p.locationId === locationId);
      const loc = name(locationId);
      const worst = Math.max(...ps.map((x) => Math.floor((Date.parse(today) - Date.parse(x.p.expectedDeliveryDate!)) / DAY)));
      out.push({
        kind: 'late_deliveries', locationId, severity: worst >= 3 ? 'warning' : 'info', module: 'operations.suppliers',
        title: `${loc}: ${ps.length} late deliver${ps.length === 1 ? 'y' : 'ies'}`,
        explanation: `${ps.map((x) => `${x.p.number} from ${x.sup} (expected ${x.p.expectedDeliveryDate})`).join('; ')} ${ps.length === 1 ? 'has' : 'have'} not been received.`,
        evidence: ps.slice(0, 4).map((x) => ({ label: x.p.number, value: `${x.sup}, expected ${x.p.expectedDeliveryDate}, ${x.p.status.replace(/_/g, ' ')}` })),
        suggestedActions: [remind('Remind me to chase the supplier', `Chase ${ps[0]!.sup} about ${ps[0]!.p.number} for ${loc}`, `/suppliers/orders/${ps[0]!.p.id}`, 0.05)],
        fingerprint: `late_deliveries:${locationId}:${ps.map((x) => x.p.id).sort().join(',').slice(0, 120)}`,
      });
    }
  });

  // Missed self-checks (and critical failures) in the last 7 days.
  await guard('missed_self_checks', async () => {
    const runs = await s.db.select().from(selfCheckRuns).where(and(eq(selfCheckRuns.organizationId, orgId), gte(selfCheckRuns.date, addDaysYmd(today, -7)), lte(selfCheckRuns.date, today)));
    for (const locationId of [...new Set(runs.map((r) => r.locationId))]) {
      const rs = runs.filter((r) => r.locationId === locationId);
      const missed = rs.filter((r) => r.status === 'missed');
      const critical = rs.filter((r) => r.criticalFailed);
      if (!missed.length && !critical.length) continue;
      const loc = name(locationId);
      out.push({
        kind: 'missed_self_checks', locationId, severity: critical.length ? 'critical' : missed.length >= 3 ? 'warning' : 'info', module: 'operations.self_checks', periodLabel: 'last 7 days',
        title: `${loc}: ${missed.length ? `${missed.length} self-check${missed.length === 1 ? '' : 's'} missed` : ''}${missed.length && critical.length ? ', ' : ''}${critical.length ? `${critical.length} critical failure${critical.length === 1 ? '' : 's'}` : ''}`,
        explanation: `In the last 7 days ${loc} completed ${rs.filter((r) => r.status === 'completed').length} of ${rs.length} scheduled self-checks.${critical.length ? ` Critical items failed: ${[...new Set(critical.flatMap((r) => r.failedItems.filter((f) => f.critical).map((f) => f.text)))].slice(0, 3).join(', ')}.` : ''}`,
        evidence: [{ label: 'Scheduled', value: String(rs.length) }, { label: 'Missed', value: String(missed.length) }, { label: 'Critical failures', value: String(critical.length) }],
        suggestedActions: [remind('Remind me to check in with the location', `Check self-checks with ${loc}`, '/self-checks')],
        fingerprint: `missed_self_checks:${locationId}:${wk}`,
      });
    }
  });

  // Agreements: cure periods ending within 7 days (or overdue) and renewal windows closing within 60 days.
  await guard('agreement_deadline', async () => {
    const notices = await s.db.select({ n: agreementNotices, g: ownerGroups.name }).from(agreementNotices).leftJoin(ownerGroups, eq(ownerGroups.id, agreementNotices.ownerGroupId))
      .where(and(eq(agreementNotices.organizationId, orgId), eq(agreementNotices.status, 'issued'), lte(agreementNotices.cureDeadline, addDaysYmd(today, 7))));
    for (const { n, g } of notices) {
      const left = Math.round((Date.parse(n.cureDeadline!) - Date.parse(today)) / DAY);
      out.push({
        kind: 'agreement_deadline', locationId: null, severity: left < 0 ? 'critical' : 'warning', module: 'legal.lifecycle',
        title: left < 0 ? `${g ?? 'A franchisee'}: cure period ended ${-left} day${left === -1 ? '' : 's'} ago` : `${g ?? 'A franchisee'}: cure period ends in ${left} day${left === 1 ? '' : 's'}`,
        explanation: `The notice of default (${n.reason.replace(/_/g, ' ')}) gave until ${n.cureDeadline} to cure. Decide with franchise counsel whether it is cured or needs the next step. General information, not legal advice.`,
        evidence: [{ label: 'Reason', value: n.reason.replace(/_/g, ' ') }, { label: 'Cure deadline', value: n.cureDeadline! }, { label: 'Issued', value: n.issuedAt?.toISOString().slice(0, 10) ?? '—' }],
        suggestedActions: [remind('Remind me to review it with counsel', `Review the cure period for ${g ?? 'the franchisee'} with counsel`, '/franchise/lifecycle', 0.05)],
        fingerprint: `cure:${n.id}:${left < 0 ? 'overdue' : 'ending'}`,
      });
    }
    const ags = await s.db.select({ a: franchiseAgreements, g: ownerGroups.name }).from(franchiseAgreements).leftJoin(ownerGroups, eq(ownerGroups.id, franchiseAgreements.ownerGroupId))
      .where(and(eq(franchiseAgreements.organizationId, orgId), eq(franchiseAgreements.status, 'active')));
    for (const { a, g } of ags) {
      if (!a.endDate) continue;
      const wm = (a.terms as { renewalWindowMonths?: [number, number] } | null)?.renewalWindowMonths;
      const w = renewalWindow(a.endDate, wm?.[0] ?? 12, wm?.[1] ?? 6);
      if (renewalPhase(today, w, a.endDate) !== 'window_open') continue;
      const left = Math.round((Date.parse(w.closesOn) - Date.parse(today)) / DAY);
      if (left > 60) continue;
      out.push({
        kind: 'agreement_deadline', locationId: null, severity: left <= 14 ? 'warning' : 'info', module: 'legal.lifecycle',
        title: `${g ?? 'A franchisee'}: renewal window closes in ${left} day${left === 1 ? '' : 's'}`,
        explanation: `The agreement${a.territory ? ` for ${a.territory}` : ''} ends on ${a.endDate}; the renewal option window runs from ${w.opensOn} to ${w.closesOn}. General information from your records, not legal advice.`,
        evidence: [{ label: 'Agreement ends', value: a.endDate }, { label: 'Window closes', value: w.closesOn }, { label: 'Renewal option', value: a.renewalOption ?? '—' }],
        suggestedActions: [remind('Remind me to contact the franchisee', `Discuss renewal with ${g ?? 'the franchisee'}`, '/franchise/lifecycle')],
        fingerprint: `renewal_window:${a.id}:${w.closesOn}`,
      });
    }
  });

  // Survey score drop: eNPS down 10+ points, or a theme down 0.3+, between the last two rounds with results.
  await guard('survey_drop', async () => {
    const surveys = await s.db.select().from(franchiseSurveys).where(and(eq(franchiseSurveys.organizationId, orgId), inArray(franchiseSurveys.status, ['active', 'closed']))).orderBy(asc(franchiseSurveys.createdAt));
    for (const sv of surveys) {
      const trend = (await surveyTrend(s.db, sv, 'all')).filter((t) => t.nps !== null || t.themes.length);
      if (trend.length < 2) continue;
      const [prev, cur] = trend.slice(-2) as [(typeof trend)[number], (typeof trend)[number]];
      const npsDrop = prev.nps !== null && cur.nps !== null ? prev.nps - cur.nps : 0;
      const themeDrops = cur.themes.map((t) => ({ theme: t.theme, now: t.average, before: prev.themes.find((p) => p.theme === t.theme)?.average ?? null })).filter((t): t is { theme: string; now: number; before: number } => t.now !== null && t.before !== null && t.before - t.now >= 0.3);
      if (npsDrop < 10 && !themeDrops.length) continue;
      out.push({
        kind: 'survey_drop', locationId: null, severity: npsDrop >= 20 ? 'warning' : 'info', module: 'community.surveys', periodLabel: `${prev.label} → ${cur.label}`,
        title: `${sv.title}: ${npsDrop >= 10 ? `eNPS down ${npsDrop} points` : `${themeDrops.map((t) => t.theme).join(', ')} score down`}`,
        explanation: `Between ${prev.label} and ${cur.label}${npsDrop >= 10 ? ` eNPS fell from ${prev.nps} to ${cur.nps}` : ''}${themeDrops.length ? `${npsDrop >= 10 ? ', and' : ''} ${themeDrops.map((t) => `${t.theme} fell from ${t.before} to ${t.now}`).join(', ')}` : ''}. Only rounds above the anonymity threshold are compared.`,
        evidence: [...(prev.nps !== null && cur.nps !== null ? [{ label: 'eNPS', value: `${prev.nps} → ${cur.nps}`, series: trend.map((t) => ({ label: t.label, value: t.nps })) }] : []), ...themeDrops.map((t) => ({ label: t.theme, value: `${t.before} → ${t.now}` }))],
        suggestedActions: [remind('Remind me to plan follow-up actions', `Plan follow-up actions for ${sv.title}`, '/surveys')],
        fingerprint: `survey_drop:${sv.id}:${cur.roundId}`,
      });
    }
  });

  // Benchmark percentile changes of 10+ points between the last two months (opted-in networks only).
  await guard('benchmark_change', async () => {
    const period = lastFullMonth(now);
    const [cur, prevP] = [period, lastFullMonth(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 15)))];
    const a = await benchmarksFor(s.db, org, cur);
    if (!a.optedIn) return;
    const b = await benchmarksFor(s.db, org, prevP);
    for (const m of a.metrics) {
      const p = b.metrics.find((x) => x.metric === m.metric && x.currency === m.currency);
      if (m.percentile === null || !p || p.percentile === null) continue;
      const change = m.percentile - p.percentile;
      if (Math.abs(change) < 10) continue;
      const label = `${m.metric.replace(/_/g, ' ')}${m.currency ? ` (${m.currency})` : ''}`;
      out.push({
        kind: 'benchmark_change', locationId: null, severity: change <= -20 ? 'warning' : 'info', module: 'network.benchmarks', periodLabel: `${prevP} → ${cur}`, currency: m.currency,
        title: `Benchmark: ${label} ${change > 0 ? 'up' : 'down'} ${Math.abs(change)} percentile points`,
        explanation: `Against similar networks, ${label} moved from the ${p.percentile}th to the ${m.percentile}th percentile between ${prevP} and ${cur} (anonymised cohort of ${m.cohort?.size ?? '—'}).`,
        evidence: [{ label: prevP, value: `${p.percentile}th percentile` }, { label: cur, value: `${m.percentile}th percentile` }, { label: 'Cohort size', value: String(m.cohort?.size ?? '—') }],
        suggestedActions: [remind('Remind me to look into it', `Look into the ${label} benchmark`, '/benchmarks')],
        fingerprint: `benchmark_change:${m.metric}:${m.currency ?? ''}:${cur}`,
      });
    }
  });

  return out;
}
