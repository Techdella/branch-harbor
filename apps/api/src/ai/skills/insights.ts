import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { InsightEvidence, InsightKind, SuggestedAction } from '@bh/shared';
import type { Services } from '../../context.ts';
import { aiInsights, audits, classBookings, complianceDocuments, complianceRequirements, financeInvoices, locations, organizations, reviews } from '../../db/schema/index.ts';
import { notFound } from '../../lib/errors.ts';
import { activityCounts, revenueByLocation } from '../../services/league-table.ts';
import type { AssistantContext } from '../context.ts';
import { proposeAction } from '../engine.ts';
import { fmtMoney } from '../present.ts';
import { detectModuleInsights } from './insights-modules.ts';

/**
 * Proactive insights: anomaly detection on KPIs, run per organisation by the scheduler (a system job; nothing is shown
 * until someone with access to the insight's module and location opens the feed). Every insight is deterministic:
 * a plain-language explanation with the numbers behind it (evidence) and suggested actions that become action cards.
 */

const DAY = 86_400_000;

interface Detected {
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

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const week = (d: Date) => `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)).padStart(2, '0')}`;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

export async function detectInsights(s: Services, orgId: string, now = new Date()): Promise<Detected[]> {
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) return [];
  const locs = (await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt)))).filter((l) => l.status === 'operating' || l.status === 'paused');
  const out: Detected[] = [];
  const wk = week(now);
  const end = new Date(Math.floor(now.getTime() / DAY) * DAY);
  const last7 = new Date(end.getTime() - 7 * DAY);
  const prior = new Date(last7.getTime() - 28 * DAY);

  // Revenue drop: last 7 days vs the weekly average of the 4 weeks before (same currency, the location's own).
  if (locs.length) {
    const [cur, before] = await Promise.all([revenueByLocation(s.db, orgId, locs, last7, end), revenueByLocation(s.db, orgId, locs, prior, last7)]);
    for (const l of locs) {
      const now7 = cur.get(l.id) ?? 0;
      const avg = Math.round((before.get(l.id) ?? 0) / 4);
      if (avg >= 5_000 && now7 < avg * 0.75) {
        const change = pct(now7, avg);
        out.push({
          kind: 'revenue_drop', locationId: l.id, severity: change <= -40 ? 'critical' : 'warning', module: 'finance.payments', currency: l.currency, periodLabel: 'last 7 days',
          title: `${l.name}: revenue down ${Math.abs(change)}% this week`,
          explanation: `${l.name} took ${fmtMoney(now7, l.currency)} in the last 7 days, against a weekly average of ${fmtMoney(avg, l.currency)} over the 4 weeks before (${change}%). Payments in BranchHarbor only; external sales are not included.`,
          evidence: [{ label: 'Last 7 days', value: fmtMoney(now7, l.currency) }, { label: 'Previous weekly average', value: fmtMoney(avg, l.currency) }, { label: 'Change', value: `${change}%` }],
          suggestedActions: [
            { label: 'Draft a win-back email', tool: 'create_email_campaign_draft', input: { name: `${l.name} win-back`, subject: `We miss you at ${l.name}`, brief: `Invite customers of ${l.name} back; no new offers unless HQ adds one.`, location: l.name } },
            { label: 'Remind me to call the location', tool: 'remind_me', input: { title: `Call ${l.name} about this week’s revenue drop`, remindAt: inDays(1), link: '/league-table' } },
          ],
          fingerprint: `revenue_drop:${l.id}:${wk}`,
        });
      }
    }
    // Activity drop (bookings, orders, appointments…): same comparison.
    const ids = locs.map((l) => l.id);
    const [a1, a0] = await Promise.all([activityCounts(s.db, org.industry, ids, last7, end), activityCounts(s.db, org.industry, ids, prior, last7)]);
    for (const l of locs) {
      const n = a1.activity.get(l.id) ?? 0;
      const avg = (a0.activity.get(l.id) ?? 0) / 4;
      if (avg >= 10 && n < avg * 0.7) {
        const change = pct(n, avg);
        out.push({
          kind: 'activity_drop', locationId: l.id, severity: 'warning', module: 'network.league_table', periodLabel: 'last 7 days',
          title: `${l.name}: bookings down ${Math.abs(change)}%`,
          explanation: `${n} bookings or orders at ${l.name} in the last 7 days, against a weekly average of ${Math.round(avg)} over the 4 weeks before (${change}%).`,
          evidence: [{ label: 'Last 7 days', value: String(n) }, { label: 'Previous weekly average', value: String(Math.round(avg)) }],
          suggestedActions: [{ label: 'Draft a social post for the location', tool: 'create_social_post_draft', input: { brief: `Encourage people to book at ${l.name} this week.`, location: l.name } }],
          fingerprint: `activity_drop:${l.id}:${wk}`,
        });
      }
    }
    // Churn risk (studios): regulars (3+ bookings in the 60 days before) with no booking in the last 30 days.
    if (org.industry === 'studios') {
      const d30 = new Date(end.getTime() - 30 * DAY);
      const d90 = new Date(end.getTime() - 90 * DAY);
      const rows = (await s.db.execute(sql`
        select b.location_id as id, count(*)::int as n from (
          select location_id, customer_id from class_bookings
          where organization_id = ${orgId} and created_at >= ${d90.toISOString()}::timestamptz and created_at < ${d30.toISOString()}::timestamptz and status in ('confirmed','attended')
          group by location_id, customer_id having count(*) >= 3
        ) b
        where not exists (select 1 from class_bookings c where c.customer_id = b.customer_id and c.created_at >= ${d30.toISOString()}::timestamptz and c.status in ('confirmed','attended','held'))
        group by b.location_id`)) as unknown as Array<{ id: string; n: number }>;
      for (const r of rows) {
        const l = locs.find((x) => x.id === r.id);
        if (!l || r.n < 3) continue;
        out.push({
          kind: 'churn_risk', locationId: l.id, severity: r.n >= 10 ? 'warning' : 'info', module: 'sales.customers', periodLabel: 'last 30 days',
          title: `${l.name}: ${r.n} regulars have stopped booking`,
          explanation: `${r.n} customers who booked at least 3 times between 90 and 30 days ago have not booked at ${l.name} in the last 30 days.`,
          evidence: [{ label: 'Lapsed regulars', value: String(r.n) }],
          suggestedActions: [{ label: 'Draft a "we miss you" email', tool: 'create_email_campaign_draft', input: { name: `${l.name} lapsed regulars`, subject: `We miss you at ${l.name}`, brief: `A warm check-in for regulars who have not visited ${l.name} for a month.`, location: l.name } }],
          fingerprint: `churn_risk:${l.id}:${wk}`,
        });
      }
      void classBookings;
    }
  }

  // Royalty invoices overdue.
  const today = now.toISOString().slice(0, 10);
  const overdue = await s.db.select().from(financeInvoices).where(and(eq(financeInvoices.organizationId, orgId), inArray(financeInvoices.status, ['open', 'processing']), lt(financeInvoices.dueDate, today)));
  for (const inv of overdue.filter((i) => i.paidMinor < i.totalMinor)) {
    const l = (await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, inv.locationId)))[0];
    const days = Math.floor((Date.parse(today) - Date.parse(inv.dueDate)) / DAY);
    out.push({
      kind: 'royalty_overdue', locationId: inv.locationId, severity: days > 30 || inv.dunningStage === 'final_notice' ? 'critical' : 'warning', module: 'finance.invoices', currency: inv.currency,
      title: `${l?.name ?? 'A location'}: royalty invoice ${inv.number} is ${days} days overdue`,
      explanation: `Invoice ${inv.number} (${fmtMoney(inv.totalMinor - inv.paidMinor, inv.currency)} outstanding) was due on ${inv.dueDate}. Dunning stage: ${inv.dunningStage.replace('_', ' ')}.`,
      evidence: [{ label: 'Outstanding', value: fmtMoney(inv.totalMinor - inv.paidMinor, inv.currency) }, { label: 'Due date', value: inv.dueDate }, { label: 'Days overdue', value: String(days) }],
      suggestedActions: [{ label: 'Remind me to follow up', tool: 'remind_me', input: { title: `Follow up invoice ${inv.number} with ${l?.name ?? 'the location'}`, remindAt: inDays(1), link: '/finance/statements' } }],
      fingerprint: `royalty_overdue:${inv.id}`,
    });
  }

  // Review rating drop: last 30 days vs the 90 days before (at least 3 reviews in each window).
  const r30 = new Date(now.getTime() - 30 * DAY);
  const r120 = new Date(now.getTime() - 120 * DAY);
  const rr = await s.db.select({ id: reviews.locationId, recent: sql<number>`avg(${reviews.rating}) filter (where ${reviews.reviewedAt} >= ${r30.toISOString()}::timestamptz)`, nRecent: sql<number>`count(*) filter (where ${reviews.reviewedAt} >= ${r30.toISOString()}::timestamptz)::int`, before: sql<number>`avg(${reviews.rating}) filter (where ${reviews.reviewedAt} < ${r30.toISOString()}::timestamptz)`, nBefore: sql<number>`count(*) filter (where ${reviews.reviewedAt} < ${r30.toISOString()}::timestamptz)::int` })
    .from(reviews).where(and(eq(reviews.organizationId, orgId), gte(reviews.reviewedAt, r120))).groupBy(reviews.locationId);
  for (const r of rr) {
    const recent = Number(r.recent);
    const before = Number(r.before);
    if (r.nRecent >= 3 && r.nBefore >= 3 && before - recent >= 0.5) {
      const l = locs.find((x) => x.id === r.id);
      if (!l) continue;
      out.push({
        kind: 'rating_drop', locationId: l.id, severity: recent < 3.5 ? 'warning' : 'info', module: 'marketing.reviews', periodLabel: 'last 30 days',
        title: `${l.name}: rating down to ${recent.toFixed(1)}★`,
        explanation: `Average rating at ${l.name} was ${recent.toFixed(1)} over the last 30 days (${r.nRecent} reviews), down from ${before.toFixed(1)} in the 90 days before (${r.nBefore} reviews).`,
        evidence: [{ label: 'Last 30 days', value: `${recent.toFixed(1)}★ (${r.nRecent})` }, { label: '90 days before', value: `${before.toFixed(1)}★ (${r.nBefore})` }],
        suggestedActions: [{ label: 'Open the reviews', tool: 'remind_me', input: { title: `Read and answer recent reviews for ${l.name}`, remindAt: inDays(0.05), link: '/marketing/reviews' } }],
        fingerprint: `rating_drop:${l.id}:${wk}`,
      });
    }
  }

  // Audit score decline: the latest completed audit vs the one before (10+ points lower, or failed).
  const done = await s.db.select({ id: audits.id, locationId: audits.locationId, score: audits.scoreTenths, passed: audits.passed, completedAt: audits.completedAt }).from(audits)
    .where(and(eq(audits.organizationId, orgId), eq(audits.status, 'completed'))).orderBy(desc(audits.completedAt));
  for (const l of locs) {
    const [latest, prev] = done.filter((a) => a.locationId === l.id);
    if (!latest || latest.score === null) continue;
    const drop = prev?.score !== null && prev?.score !== undefined ? (prev.score - latest.score) / 10 : 0;
    if (drop >= 10 || latest.passed === false) {
      out.push({
        kind: 'audit_decline', locationId: l.id, severity: latest.passed === false ? 'critical' : 'warning', module: 'operations.audits',
        title: latest.passed === false ? `${l.name}: failed its latest audit (${latest.score / 10}%)` : `${l.name}: audit score down ${drop} points`,
        explanation: `The latest audit at ${l.name} scored ${latest.score / 10}%${prev?.score != null ? `, after ${prev.score / 10}% the time before` : ''}.${latest.passed === false ? ' It did not pass.' : ''}`,
        evidence: [{ label: 'Latest score', value: `${latest.score / 10}%` }, ...(prev?.score != null ? [{ label: 'Previous score', value: `${prev.score / 10}%` }] : [])],
        suggestedActions: [{ label: 'Schedule a re-audit in 30 days', tool: 'schedule_audit', input: { location: l.name, dueDate: inDays(30).slice(0, 10) } }],
        fingerprint: `audit_decline:${latest.id}`,
      });
    }
  }

  // Compliance gaps: approved required documents that have expired.
  const expired = await s.db.select({ d: complianceDocuments, req: complianceRequirements.name }).from(complianceDocuments).leftJoin(complianceRequirements, eq(complianceRequirements.id, complianceDocuments.requirementId))
    .where(and(eq(complianceDocuments.organizationId, orgId), eq(complianceDocuments.status, 'approved'), isNull(complianceDocuments.supersededAt), lt(complianceDocuments.expiresOn, today), ne(complianceDocuments.category, 'franchisee_document')));
  for (const { d, req } of expired) {
    const l = d.locationId ? locs.find((x) => x.id === d.locationId) : null;
    out.push({
      kind: 'compliance_gap', locationId: d.locationId, severity: 'critical', module: 'legal.compliance_documents',
      title: `${l?.name ?? 'Owner group'}: ${req ?? d.title} expired on ${d.expiresOn}`,
      explanation: `"${d.title}"${d.issuer ? ` from ${d.issuer}` : ''} expired on ${d.expiresOn} and no newer approved document replaces it.`,
      evidence: [{ label: 'Document', value: d.title }, { label: 'Expired', value: String(d.expiresOn) }],
      suggestedActions: [{ label: 'Remind me to chase the renewal', tool: 'remind_me', input: { title: `Chase renewal: ${d.title}${l ? ` (${l.name})` : ''}`, remindAt: inDays(1), link: '/compliance' } }],
      fingerprint: `compliance_gap:${d.id}`,
    });
  }
  // Local marketing, data platform, supply, self-checks, franchise development and benchmarks.
  out.push(...(await detectModuleInsights(s, orgId, now)));
  return out;
}

/** Runs detection and stores new insights (repeat detections refresh the existing row; dismissed stay dismissed). */
export async function refreshInsights(s: Services, orgId: string, now = new Date()) {
  const found = await detectInsights(s, orgId, now);
  for (const d of found) {
    await s.db.insert(aiInsights).values({ organizationId: orgId, ...d, evidence: d.evidence, suggestedActions: d.suggestedActions, currency: d.currency ?? null, periodLabel: d.periodLabel ?? null, detectedAt: now })
      .onConflictDoUpdate({ target: [aiInsights.organizationId, aiInsights.fingerprint], set: { title: d.title, explanation: d.explanation, evidence: d.evidence, suggestedActions: d.suggestedActions, severity: d.severity, detectedAt: now } });
  }
  return found.length;
}

export function serializeInsight(i: typeof aiInsights.$inferSelect, locationName?: string | null) {
  return {
    id: i.id, kind: i.kind, severity: i.severity, title: i.title, explanation: i.explanation, evidence: i.evidence, suggestedActions: (i.suggestedActions as SuggestedAction[]).map((a, idx) => ({ ...a, index: idx })),
    locationId: i.locationId, locationName: locationName ?? null, status: i.status, currency: i.currency, periodLabel: i.periodLabel, detectedAt: i.detectedAt.toISOString(),
  };
}

/** Insights the person may see: the insight's module at its location (organisation-wide insights need HQ access). */
export async function listInsights(ctx: AssistantContext, opts: { status?: 'open' | 'all'; limit?: number } = {}) {
  const rows = await ctx.s.db.select().from(aiInsights).where(and(eq(aiInsights.organizationId, ctx.orgId), ...(opts.status === 'all' ? [] : [eq(aiInsights.status, 'open')]))).orderBy(desc(aiInsights.detectedAt)).limit(300);
  const cache = new Map<string, 'all' | Set<string>>();
  const out = [];
  for (const r of rows) {
    if (!cache.has(r.module)) cache.set(r.module, await ctx.locationsWith(r.module));
    const allowed = cache.get(r.module)!;
    const ok = allowed === 'all' || (r.locationId ? allowed.has(r.locationId) : false);
    if (ok) out.push(r);
  }
  const names = new Map((await ctx.s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, ctx.orgId))).map((l) => [l.id, l.name]));
  const sev = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
  return out.sort((a, b) => (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3) || b.detectedAt.getTime() - a.detectedAt.getTime()).slice(0, opts.limit ?? 50).map((r) => serializeInsight(r, r.locationId ? names.get(r.locationId) : null));
}

async function loadVisible(ctx: AssistantContext, id: string) {
  const list = await listInsights(ctx, { status: 'all', limit: 300 });
  const i = list.find((x) => x.id === id);
  if (!i) throw notFound('Insight');
  return i;
}

export async function dismissInsight(ctx: AssistantContext, id: string) {
  await loadVisible(ctx, id);
  await ctx.s.db.update(aiInsights).set({ status: 'dismissed', decidedBy: ctx.user.id, decidedAt: new Date() }).where(eq(aiInsights.id, id));
  return { id, status: 'dismissed' };
}

/** One click on a suggested action → an action card (same access checks as in chat). */
export async function actOnInsight(ctx: AssistantContext, id: string, index: number) {
  const i = await loadVisible(ctx, id);
  const a = i.suggestedActions[index];
  if (!a) throw notFound('Suggested action');
  const card = await proposeAction(ctx.s, ctx, a.tool, a.input, 'insight');
  await ctx.s.db.update(aiInsights).set({ status: 'acted', decidedBy: ctx.user.id, decidedAt: new Date() }).where(eq(aiInsights.id, id));
  return card;
}
