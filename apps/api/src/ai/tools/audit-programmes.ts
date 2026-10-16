import { z } from 'zod';
import { defineTool, ToolError } from '../types.ts';
import { itemsOf, table } from '../present.ts';
import { addDaysYmd, orgToday, pickOne, plural, resolveLocation } from './_helpers.ts';

/**
 * Audits phase 2: score trends, the most failed checklist items, the field visit planner, self-checks and the
 * retraining link from a corrective action to a course.
 */

const auditTrends = defineTool({
  name: 'audit_trends',
  kind: 'read',
  area: 'operations',
  modules: ['operations.audits'],
  networkOnly: true,
  description: 'Audit score trends over the last 6 months: network and regional averages by month, each location’s average and change, section scores and the pass rate.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/audits/trends')),
  present: (r) => {
    const locs = (r.locations ?? []).filter((l: any) => l.audits).sort((a: any, b: any) => (a.change ?? 0) - (b.change ?? 0));
    const down = locs.filter((l: any) => (l.change ?? 0) < 0);
    return {
      summary: `${r.totals?.audits ?? 0} audit(s), average ${r.totals?.averageScorePct ?? '—'}%, pass rate ${r.totals?.passRatePct ?? '—'}%.${down.length ? ` Declining: ${down.slice(0, 3).map((l: any) => `${l.name} (${l.change} pts)`).join(', ')}.` : ''} Weakest sections: ${[...(r.sections ?? [])].sort((a: any, b: any) => (a.averageScorePct ?? 100) - (b.averageScorePct ?? 100)).slice(0, 3).map((x: any) => `${x.title} ${x.averageScorePct}%`).join(', ') || '—'}.`,
      blocks: [
        { type: 'chart', kind: 'line', title: 'Average audit score', unit: 'percent', series: [{ name: 'Network', points: (r.network ?? []).map((n: any) => ({ label: n.month, value: n.averageScorePct })) }, ...(r.regions ?? []).slice(0, 4).map((g: any) => ({ name: g.name, points: (r.months ?? []).map((m: string, idx: number) => ({ label: m, value: g.byMonth?.[idx] ?? null })) }))] },
        ...(locs.length ? [table('Audit trend by location', [{ key: 'name', label: 'Location' }, { key: 'averageScorePct', label: 'Average %', kind: 'percent' as const }, { key: 'change', label: 'Change (pts)', kind: 'number' as const }, { key: 'audits', label: 'Audits', kind: 'number' as const }], locs)] : []),
      ],
      citations: [{ id: 'audits', title: 'Audit trends', url: '/audits?tab=trends', sourceType: 'screen' }],
    };
  },
});

const mostFailedItems = defineTool({
  name: 'most_failed_items',
  kind: 'read',
  area: 'operations',
  modules: ['operations.audits'],
  networkOnly: true,
  description: 'The checklist items that fail most often across audits: fail rate, how many locations, the usual reason, whether critical, and whether a training course is linked to it.',
  input: z.object({ limit: z.number().int().min(1).max(30).default(10) }),
  async run(ctx, i) {
    const r = await ctx.api.get(ctx.o('/audits/trends'));
    return { items: (r.mostFailed ?? []).slice(0, i.limit) };
  },
  present: (r) => ({
    summary: r.items.length ? `Most failed: ${r.items.slice(0, 5).map((x: any) => `${x.title} (${x.failRatePct}% of ${x.asked}, ${x.locations} location(s)${x.critical ? ', critical' : ''})`).join('; ')}.` : 'No failed checklist items in the period.',
    blocks: r.items.length ? [table('Most failed checklist items', [{ key: 'title', label: 'Item' }, { key: 'sectionTitle', label: 'Section' }, { key: 'failRatePct', label: 'Fail rate %', kind: 'percent' }, { key: 'fails', label: 'Fails', kind: 'number' }, { key: 'locations', label: 'Locations', kind: 'number' }, { key: 'training', label: 'Training linked' }], r.items.map((x: any) => ({ ...x, training: x.trainingCourseId ? 'yes' : 'no' })))] : [],
    citations: [{ id: 'audits', title: 'Audit trends', url: '/audits?tab=trends', sourceType: 'screen' }],
  }),
});

const planVisits = defineTool({
  name: 'plan_visits',
  kind: 'read',
  area: 'operations',
  modules: ['operations.audits'],
  networkOnly: true,
  description: 'The field visit plan for the next weeks (default 4): scheduled audit visits per day grouped by area, with travel distance, plus overdue visits. For the person themselves, or another auditor they manage.',
  input: z.object({ weeks: z.number().int().min(1).max(12).default(4), auditor: z.string().max(120).optional() }),
  async run(ctx, i) {
    const today = orgToday(ctx);
    const base = await ctx.api.get(ctx.o('/audits/visits'), { from: today, to: addDaysYmd(today, i.weeks * 7) });
    if (!i.auditor) return base;
    const a = pickOne(base.auditors ?? [], i.auditor, (x: any) => x.name, (x: any) => x.id, 'auditor');
    return ctx.api.get(ctx.o('/audits/visits'), { from: today, to: addDaysYmd(today, i.weeks * 7), auditorUserId: a.id });
  },
  present: (r) => {
    const days = (r.days ?? []) as any[];
    const rows = [
      ...(r.overdue ?? []).map((v: any) => ({ date: v.dueDate, location: v.locationName, audit: v.name, status: 'overdue', km: v.legKm ?? null })),
      ...days.flatMap((d) => (d.stops ?? []).map((v: any) => ({ date: d.date, location: v.locationName, audit: v.name, status: v.status, km: v.legKm ?? null }))),
    ];
    return {
      summary: `${r.visits ?? rows.length} visit(s) from ${r.from} to ${r.to} over ${plural(days.length, 'day')}; ${(r.overdue ?? []).length} overdue${r.withoutLocation ? `, ${r.withoutLocation} without a mapped location` : ''}.`,
      blocks: rows.length ? [table('Visit plan', [{ key: 'date', label: 'Day', kind: 'date' }, { key: 'location', label: 'Location' }, { key: 'audit', label: 'Audit' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'km', label: 'km from previous stop', kind: 'number' }], rows)] : [],
      citations: [{ id: 'visits', title: 'Visit planner', url: '/audits?tab=visits', sourceType: 'screen' }],
    };
  },
});

const selfCheckStatus = defineTool({
  name: 'self_check_status',
  kind: 'read',
  area: 'operations',
  modules: ['operations.self_checks'],
  description: 'Location self-checks (opening checklists, temperature logs…) over the last two weeks: completion and pass rate per location, missed checks, critical failures and today’s checks still due.',
  input: z.object({ location: z.string().max(120).optional() }),
  async run(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const r = await ctx.api.get(ctx.o('/self-checks/dashboard'));
    const keep = (x: any) => !loc || x.locationId === loc.id;
    return { since: r.since, totals: r.totals, locations: (r.locations ?? []).filter(keep), failures: (r.failures ?? []).filter(keep).map((f: any) => ({ date: f.date, locationName: f.locationName, name: f.scheduleName ?? f.name, criticalFailed: f.criticalFailed, failedItems: (f.failedItems ?? []).map((x: any) => x.text).join(', ') })), dueToday: (r.today_runs ?? []).filter(keep).filter((x: any) => x.status !== 'completed').map((x: any) => ({ locationName: x.locationName, name: x.scheduleName ?? x.name, dueAt: x.dueAt, late: x.late })) };
  },
  present: (r) => {
    const missed = r.locations.filter((l: any) => l.missed);
    return {
      summary: `Self-checks since ${r.since}: ${r.totals?.completionPct ?? '—'}% completed, ${r.totals?.passPct ?? '—'}% passed; ${r.totals?.missed ?? 0} missed${missed.length ? ` (${missed.map((l: any) => `${l.name}: ${l.missed}`).join(', ')})` : ''}; ${r.failures.filter((f: any) => f.criticalFailed).length} critical failure(s); ${r.dueToday.length} still due today.`,
      blocks: [
        table('Self-checks by location', [{ key: 'name', label: 'Location' }, { key: 'runs', label: 'Checks', kind: 'number' }, { key: 'completionPct', label: 'Completed %', kind: 'percent' }, { key: 'passPct', label: 'Passed %', kind: 'percent' }, { key: 'missed', label: 'Missed', kind: 'number' }, { key: 'criticalFails', label: 'Critical fails', kind: 'number' }], r.locations),
        ...(r.failures.length ? [table('Failed checks', [{ key: 'date', label: 'Date', kind: 'date' as const }, { key: 'locationName', label: 'Location' }, { key: 'name', label: 'Check' }, { key: 'failedItems', label: 'Failed items' }], r.failures)] : []),
      ],
      citations: [{ id: 'selfchecks', title: 'Self-checks', url: '/self-checks', sourceType: 'screen' }],
    };
  },
});

const suggestRetraining = defineTool({
  name: 'suggest_retraining',
  kind: 'write',
  area: 'operations',
  modules: ['operations.audits'],
  risk: 'change',
  description: 'Assign retraining for a corrective action: the location’s team gets a training course linked to the failed audit item. Only the auditor or HQ can assign it; each action takes one assignment.',
  input: z.object({ actionId: z.uuid(), course: z.string().min(1).max(160).describe('Course id or title') }),
  async preview(ctx, i) {
    const { action, course } = await resolveRetraining(ctx, i);
    return {
      title: `Retraining “${course.title}” for ${action.locationName}`,
      summary: `Linked to the corrective action “${action.title}” (${action.sectionTitle ?? 'audit'}).`,
      details: [{ label: 'Failed item', value: action.title }, { label: 'Due', value: String(action.dueDate ?? '—') }, { label: 'Course', value: course.title }],
      link: '/audits',
    };
  },
  async execute(ctx, i) {
    const { action, course } = await resolveRetraining(ctx, i);
    const r = await ctx.api.post(ctx.o(`/audits/actions/${action.id}/training`), { courseId: course.id });
    return { result: { assignmentId: r.training?.assignmentId ?? r.trainingAssignmentId ?? null }, link: '/audits' };
  },
});

async function resolveRetraining(ctx: Parameters<typeof resolveLocation>[0], i: { actionId: string; course: string }) {
  const actions = itemsOf(await ctx.api.get(ctx.o('/audits/actions'), { status: 'all' }));
  const action = actions.find((a) => a.id === i.actionId);
  if (!action) throw new ToolError('not_found', 'That corrective action is not in your access.', 404);
  if (action.training) throw new ToolError('training_assigned', 'Retraining is already assigned for this action.', 409);
  const courses = itemsOf(await ctx.api.get(ctx.o('/audits/courses')));
  const course = pickOne(courses, i.course, (c) => c.title, (c) => c.id, 'course');
  return { action, course };
}

export default [auditTrends, mostFailedItems, planVisits, selfCheckStatus, suggestRetraining];
