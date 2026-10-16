import type { BriefingItem, BriefingSection } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';

/**
 * Briefing items from the modules added after the first release. Like the rest of the briefing, everything is read
 * through the REST routes as the person (and their brand filter), so a section simply stays empty without access.
 * Each item carries the evidence (title and detail) and a one-line suggested action.
 */

const DAY = 86_400_000;
const safe = async <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export async function moduleBriefingItems(ctx: AssistantContext, want: Set<BriefingSection>): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];
  const { api, o } = { api: ctx.api, o: ctx.o };

  if (want.has('local_marketing')) {
    if (ctx.can('marketing.listings')) {
      const d = await safe(api.get(o('/listings/drifts')), { items: [], canResolve: false });
      const drifts = itemsOf(d);
      if (drifts.length) {
        const locs = [...new Set(drifts.map((x) => x.locationName))];
        items.push({ section: 'local_marketing', severity: drifts.some((x) => ['phone', 'name', 'address', 'hours'].includes(x.field)) ? 'warning' : 'info', title: `${n(drifts.length, 'listing field')} changed on Google, Apple or Bing outside BranchHarbor`, detail: drifts.slice(0, 3).map((x) => `${x.locationName}: ${x.field} on ${x.provider}`).join(' · '), link: '/marketing/listings', count: drifts.length, suggestion: d.canResolve ? `Accept or overwrite each edit on Listings (${locs.slice(0, 3).join(', ')}).` : 'Check the edits and ask HQ to accept or overwrite them.' });
      }
    }
    if (ctx.can('marketing.coop')) {
      const ov = await safe(api.get(o('/coop/overview')), null as any);
      if (ov?.canDecide && (ov.queue?.requests || ov.queue?.claims || ov.queue?.toPay)) {
        const q = ov.queue;
        items.push({ section: 'local_marketing', severity: q.claims > 3 ? 'warning' : 'info', title: `Co-op: ${[q.requests ? n(q.requests, 'request') : '', q.claims ? n(q.claims, 'claim') : '', q.toPay ? `${q.toPay} to pay` : ''].filter(Boolean).join(', ')} waiting`, detail: `Period ${ov.periodKey}`, link: '/marketing/coop', count: (q.requests ?? 0) + (q.claims ?? 0), suggestion: 'Review them against the brand checklist and the allowance left.' });
      } else if (ov && !ov.canDecide) {
        const back = itemsOf(await safe(api.get(o('/coop/requests'), { status: 'changes_requested' }), { items: [] }));
        if (back.length) items.push({ section: 'local_marketing', severity: 'info', title: `${n(back.length, 'co-op request')} sent back for changes`, detail: back.slice(0, 3).map((x) => `${x.locationName}: ${x.title}`).join(' · '), link: '/marketing/coop', count: back.length, suggestion: 'Fix the failed checklist items and resubmit.' });
      }
    }
    if (ctx.can('marketing.call_tracking')) {
      const from = new Date(Date.now() - 6 * DAY).toISOString().slice(0, 10);
      const missed = itemsOf(await safe(api.get(o('/call-tracking/calls'), { status: 'missed', from, limit: 500 }), { items: [] })).filter((c) => !c.followedUpAt);
      if (missed.length) {
        const names = new Map((itemsOf(await safe(api.get(o('/locations')), { items: [] }))).map((l: any) => [l.id, l.name]));
        const by = missed.reduce((a: Record<string, number>, c) => ({ ...a, [names.get(c.locationId) ?? 'Other']: (a[names.get(c.locationId) ?? 'Other'] ?? 0) + 1 }), {});
        items.push({ section: 'local_marketing', severity: missed.length >= 5 ? 'warning' : 'info', title: `${n(missed.length, 'missed call')} this week without a follow-up`, detail: Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(' · '), link: '/marketing/calls?status=missed', count: missed.length, suggestion: 'Call them back from the call log and mark them followed up.' });
      }
    }
  }

  if (want.has('sales_data') && ctx.can('network.sales_connectors')) {
    const sc = await safe(api.get(o('/sales-connectors')), null as any);
    const failing = (sc?.locations ?? []).flatMap((l: any) => (l.connections ?? []).filter((c: any) => c.status === 'authorization_expired' || c.lastSyncStatus === 'failed').map((c: any) => ({ location: l.name, provider: c.name ?? c.provider, status: c.status })));
    if (failing.length) items.push({ section: 'sales_data', severity: 'warning', title: `${n(failing.length, 'sales connector')} not syncing`, detail: failing.slice(0, 3).map((f: any) => `${f.location}: ${f.provider} (${String(f.status).replace(/_/g, ' ')})`).join(' · '), link: '/sales-connectors', count: failing.length, suggestion: 'Reconnect expired connections; resync the rest before royalties close.' });
    const rec = await safe(api.get(o('/sales-connectors/reconciliation')), null as any);
    const flagged = (rec?.rows ?? []).filter((r: any) => (r.selfReported ?? []).some((x: any) => x.comparison?.variance?.flagged));
    if (flagged.length) items.push({ section: 'sales_data', severity: 'warning', title: `${n(flagged.length, 'location')} with a sales variance flag (${rec.from} to ${rec.to})`, detail: flagged.slice(0, 3).map((r: any) => `${r.location.name}: ${r.selfReported.find((x: any) => x.comparison?.variance?.flagged).comparison.variance.pct}%`).join(' · '), link: '/sales-connectors/reconciliation', count: flagged.length, suggestion: 'Compare the self-reported figures with connector data before invoicing royalties.' });
  }

  if (want.has('supply') && ctx.can('operations.suppliers')) {
    const ov = await safe(api.get(o('/supply/overview')), null as any);
    if (ov?.totals?.late) {
      const late = (ov.deliveries ?? []).filter((d: any) => d.late);
      items.push({ section: 'supply', severity: 'warning', title: `${n(ov.totals.late, 'late delivery', 'late deliveries')}`, detail: late.slice(0, 3).map((d: any) => `${d.number} ${d.supplierName} → ${d.locationName} (due ${d.expectedDeliveryDate})`).join(' · '), link: '/suppliers?tab=orders', count: ov.totals.late, suggestion: 'Chase the supplier, or receive the order if it has arrived.' });
    }
    if (ov?.totals?.pendingApproval && ov.can?.approve) items.push({ section: 'supply', severity: 'info', title: `${n(ov.totals.pendingApproval, 'purchase order')} waiting for your approval`, detail: `${ov.totals.dueThisWeek} deliveries due this week`, link: '/suppliers?tab=orders', count: ov.totals.pendingApproval, suggestion: 'Approve or reject so the supplier gets the order in time.' });
  }

  if (want.has('self_checks') && ctx.can('operations.self_checks')) {
    const d = await safe(api.get(o('/self-checks/dashboard')), null as any);
    if (d) {
      const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
      const missedWeek = (d.byDay ?? []).filter((x: any) => x.date >= since).reduce((a: number, x: any) => a + (x.missed ?? 0), 0);
      const critical = (d.failures ?? []).filter((f: any) => f.criticalFailed && f.date >= since);
      if (missedWeek || critical.length) items.push({ section: 'self_checks', severity: critical.length ? 'critical' : 'warning', title: [missedWeek ? `${n(missedWeek, 'self-check')} missed this week` : '', critical.length ? `${n(critical.length, 'critical failure')}` : ''].filter(Boolean).join(', '), detail: [...(d.locations ?? []).filter((l: any) => l.missed).map((l: any) => `${l.name}: ${l.missed} missed in 2 weeks`), ...critical.slice(0, 2).map((f: any) => `${f.locationName}: ${(f.failedItems ?? []).map((x: any) => x.text).join(', ')}`)].slice(0, 4).join(' · '), link: '/self-checks', count: missedWeek + critical.length, suggestion: critical.length ? 'Check the critical items with the location today.' : 'Ask the location why the checks were missed.' });
    }
  }

  if (want.has('agreements') && (ctx.can('legal.lifecycle') || ctx.can('network.onboarding'))) {
    const hq = ctx.can('legal.lifecycle');
    const [notices, renewals] = hq
      ? [itemsOf(await safe(api.get(o('/lifecycle/notices')), { items: [] })), itemsOf(await safe(api.get(o('/lifecycle/renewals')), { items: [] }))]
      : await safe(api.get(o('/lifecycle/mine')).then((m: any) => [m.notices ?? [], m.renewals ?? []] as [any[], any[]]), [[], []] as [any[], any[]]);
    const cures = notices.filter((x: any) => x.status === 'issued' && x.cureDeadline && (x.cureOverdue || (x.daysLeft ?? 99) <= 7));
    if (cures.length) items.push({ section: 'agreements', severity: cures.some((x: any) => x.cureOverdue) ? 'critical' : 'warning', title: `${n(cures.length, 'cure period')} ending or overdue`, detail: cures.slice(0, 3).map((x: any) => `${x.ownerGroupName}: ${x.cureOverdue ? 'overdue' : `${x.daysLeft} day(s) left`} (${x.cureDeadline})`).join(' · '), link: hq ? '/franchise/lifecycle' : '/overview', count: cures.length, suggestion: hq ? 'Review with franchise counsel whether each default is cured.' : 'Send HQ evidence that the default is cured before the deadline.' });
    const windows = renewals.filter((r: any) => r.phase === 'window_open' && (r.daysToWindowClose ?? 999) <= 60);
    if (windows.length) items.push({ section: 'agreements', severity: windows.some((r: any) => r.daysToWindowClose <= 14) ? 'warning' : 'info', title: `${n(windows.length, 'renewal window')} closing within 60 days`, detail: windows.slice(0, 3).map((r: any) => `${r.ownerGroupName}: closes ${r.windowClosesOn}`).join(' · '), link: hq ? '/franchise/lifecycle' : '/overview', count: windows.length, suggestion: hq ? 'Contact the franchisee about renewal before the window closes.' : 'Give notice of renewal before the window closes.' });
  }
  return items;
}
