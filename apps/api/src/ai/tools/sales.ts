import { z } from 'zod';
import { FRANCHISE_STAGES, MANUAL_STAGES } from '@bh/shared';
import { defineTool, ToolError } from '../types.ts';
import { itemsOf, table } from '../present.ts';
import { scoreLead, scoreProspect } from '../skills/scoring.ts';
import { countBy, plural, resolveLocation } from './_helpers.ts';

const listCustomers = defineTool({
  name: 'list_customers',
  kind: 'read',
  area: 'sales',
  modules: ['sales.customers'],
  untrustedOutput: true,
  description: 'Customer records the person can see (name, location, created date). Optional name/email search and location. Personal data: only use what the question needs.',
  input: z.object({ query: z.string().max(80).optional(), location: z.string().max(120).optional() }),
  async run(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    return ctx.api.get(ctx.o('/customers'), { q: i.query, locationId: loc?.id, limit: 50 });
  },
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'customer')} found.`,
      blocks: items.length ? [table('Customers', [{ key: 'name', label: 'Name' }, { key: 'createdAt', label: 'Since', kind: 'date' }], items)] : [],
      citations: [{ id: 'customers', title: 'Customers', url: '/customers', sourceType: 'screen' }],
    };
  },
});

const listLeads = defineTool({
  name: 'list_leads',
  kind: 'read',
  area: 'sales',
  modules: ['sales.customer_pipeline', 'sales.course_leads'],
  untrustedOutput: true,
  description: 'Customer or course leads (enquiries) with status (new, contacted, qualified, converted, lost), source, location and age. Use to find leads to follow up. kind=course for teacher-training/course leads.',
  input: z.object({ kind: z.enum(['customer', 'course']).default('customer'), status: z.enum(['open', 'new', 'contacted', 'qualified', 'converted', 'lost', 'all']).default('open'), location: z.string().max(120).optional(), assignedToMe: z.boolean().default(false) }),
  async run(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    return ctx.api.get(ctx.o('/sales/leads'), { kind: i.kind, status: i.status, locationId: loc?.id, assigned: i.assignedToMe ? 'me' : 'any', limit: 200 });
  },
  present: (r) => {
    const items = itemsOf(r);
    const by = countBy(items, (l) => l.status);
    const stale = items.filter((l) => l.status === 'new' && Date.now() - Date.parse(l.createdAt) > 2 * 86_400_000);
    return {
      summary: `${plural(items.length, 'lead')} (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).${stale.length ? ` ${stale.length} new lead(s) older than 2 days have not been contacted.` : ''}`,
      blocks: items.length ? [table('Leads', [{ key: 'name', label: 'Name' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'source', label: 'Source' }, { key: 'createdAt', label: 'Received', kind: 'date' }, { key: 'id', label: 'Id' }], items, { max: 40 })] : [],
      citations: [{ id: 'leads', title: 'Leads', url: '/sales/leads', sourceType: 'screen' }],
    };
  },
});

const scoreLeadTool = defineTool({
  name: 'score_lead',
  kind: 'read',
  area: 'sales',
  modules: ['sales.customer_pipeline', 'sales.course_leads'],
  description: 'Explained score (0–100) for one lead with the factors behind every point (recency, source, contact details, stated intent, engagement, stage) and the next best action.',
  input: z.object({ leadId: z.uuid() }),
  async run(ctx, i) {
    const r = await scoreLead(ctx, i.leadId);
    if (!r) throw new ToolError('not_found', 'That lead is not in your access.', 404);
    return r;
  },
  present: (r) => ({
    summary: `${r.lead.name ?? 'Lead'}: ${r.score}/100 (${r.band}). Next: ${r.nextBestAction.label} — ${r.nextBestAction.reason}`,
    blocks: [table(`Why ${r.lead.name ?? 'this lead'} scores ${r.score}`, [{ key: 'label', label: 'Factor' }, { key: 'points', label: 'Points', kind: 'number' }, { key: 'max', label: 'Out of', kind: 'number' }, { key: 'reason', label: 'Reason' }], r.factors)],
  }),
});

const addLeadNote = defineTool({
  name: 'add_lead_note',
  kind: 'write',
  area: 'sales',
  modules: ['sales.customer_pipeline', 'sales.course_leads'],
  risk: 'change',
  description: 'Log a note, call, email, meeting or follow-up task on a lead (does not contact the lead).',
  input: z.object({ leadId: z.uuid(), type: z.enum(['note', 'call', 'email', 'meeting', 'task']).default('note'), body: z.string().trim().min(1).max(4000), dueAt: z.iso.datetime({ offset: true }).optional() }),
  async preview(_ctx, i) {
    return { title: `Log ${i.type} on the lead`, summary: i.body.slice(0, 140), details: [{ label: 'Type', value: i.type }, { label: 'Text', value: i.body }], link: '/sales/leads', editable: [{ key: 'body', label: 'Text', kind: 'textarea' }] };
  },
  async execute(ctx, i) {
    const r = await ctx.api.post(ctx.o(`/sales/leads/${i.leadId}/activities`), { type: i.type, body: i.body, ...(i.dueAt ? { dueAt: i.dueAt } : {}) });
    return { result: { activityId: r.id ?? null }, link: '/sales/leads' };
  },
});

const listProspects = defineTool({
  name: 'list_franchise_prospects',
  kind: 'read',
  area: 'sales',
  modules: ['sales.franchise_pipeline'],
  networkOnly: true,
  untrustedOutput: true,
  description: 'Franchise candidates in the development pipeline: stage, territory, source, owner and time in stage. Optional stage filter or name search.',
  input: z.object({ stage: z.enum(FRANCHISE_STAGES).optional(), query: z.string().max(100).optional() }),
  run: (ctx, i) => ctx.api.get(ctx.o('/franchise/prospects'), { stage: i.stage, q: i.query }),
  present: (r) => {
    const items = itemsOf(r);
    const by = countBy(items, (p) => p.stage);
    return {
      summary: `${plural(items.length, 'candidate')} (${Object.entries(by).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}).`,
      blocks: items.length ? [table('Franchise pipeline', [{ key: 'name', label: 'Candidate' }, { key: 'stage', label: 'Stage', kind: 'status' }, { key: 'territoryName', label: 'Territory' }, { key: 'source', label: 'Source' }, { key: 'ownerName', label: 'Owner' }, { key: 'stageEnteredAt', label: 'In stage since', kind: 'date' }, { key: 'id', label: 'Id' }], items)] : [],
      citations: [{ id: 'pipeline', title: 'Franchise pipeline', url: '/franchise/pipeline', sourceType: 'screen' }],
    };
  },
});

const scoreCandidate = defineTool({
  name: 'score_franchise_candidate',
  kind: 'read',
  area: 'sales',
  modules: ['sales.franchise_pipeline'],
  networkOnly: true,
  description: 'Explained score (0–100) for one franchise candidate: stage, self-declared capital, territory match, source, momentum and follow-up, with the next best action. Capital is self-declared and unverified.',
  input: z.object({ prospectId: z.uuid() }),
  run: (ctx, i) => scoreProspect(ctx, i.prospectId),
  present: (r) => ({
    summary: `${r.prospect.name}: ${r.score}/100 (${r.band}). Next: ${r.nextBestAction.label} — ${r.nextBestAction.reason}`,
    blocks: [table(`Why ${r.prospect.name} scores ${r.score}`, [{ key: 'label', label: 'Factor' }, { key: 'points', label: 'Points', kind: 'number' }, { key: 'max', label: 'Out of', kind: 'number' }, { key: 'reason', label: 'Reason' }], r.factors)],
    citations: [{ id: r.prospect.id, title: r.prospect.name, url: `/franchise/prospect/${r.prospect.id}`, sourceType: 'record' }],
  }),
});

const moveStage = defineTool({
  name: 'move_prospect_stage',
  kind: 'write',
  area: 'sales',
  modules: ['sales.franchise_pipeline'],
  networkOnly: true,
  risk: 'change',
  description: `Move a franchise candidate to ${MANUAL_STAGES.join(', ')} (later stages follow from disclosure and signing so the jurisdiction rules can check them).`,
  input: z.object({ prospectId: z.uuid(), to: z.enum(MANUAL_STAGES as unknown as [string, ...string[]]), note: z.string().max(2000).optional(), lostReason: z.string().max(500).optional() }),
  async preview(ctx, i) {
    const p = await ctx.api.get(ctx.o(`/franchise/prospects/${i.prospectId}`));
    const name = (p.prospect ?? p).name ?? 'Candidate';
    return { title: `Move ${name} to ${i.to.replace(/_/g, ' ')}`, summary: i.note ?? '', details: [{ label: 'Candidate', value: name }, { label: 'New stage', value: i.to }], link: `/franchise/prospect/${i.prospectId}`, editable: [{ key: 'note', label: 'Note', kind: 'textarea' }] };
  },
  async execute(ctx, i) {
    await ctx.api.post(ctx.o(`/franchise/prospects/${i.prospectId}/stage`), { to: i.to, ...(i.note ? { note: i.note } : {}), ...(i.lostReason ? { lostReason: i.lostReason } : {}) });
    return { result: { stage: i.to }, link: `/franchise/prospect/${i.prospectId}` };
  },
});

const listFranchiseTasks = defineTool({
  name: 'list_franchise_tasks',
  kind: 'read',
  area: 'sales',
  modules: ['sales.franchise_pipeline', 'network.onboarding'],
  networkOnly: true,
  description: 'Franchise development and onboarding tasks (cadence emails, calls, checklist items) with owner, due date and overdue flag.',
  input: z.object({ overdueOnly: z.boolean().default(false) }),
  run: (ctx) => ctx.api.get(ctx.o('/franchise/tasks')),
  present: (r, i) => {
    const items = itemsOf(r).filter((t) => t.status === 'open' && (!i.overdueOnly || t.overdue));
    return {
      summary: `${plural(items.length, 'open task')}, ${items.filter((t) => t.overdue).length} overdue.`,
      blocks: items.length ? [table('Franchise tasks', [{ key: 'title', label: 'Task' }, { key: 'prospectName', label: 'Candidate' }, { key: 'ownerName', label: 'Owner' }, { key: 'dueAt', label: 'Due', kind: 'date' }, { key: 'overdue', label: 'Overdue', kind: 'status' }], items.map((t) => ({ ...t, overdue: t.overdue ? 'overdue' : '' })))] : [],
    };
  },
});

export default [listCustomers, listLeads, scoreLeadTool, addLeadNote, listProspects, scoreCandidate, moveStage, listFranchiseTasks];
