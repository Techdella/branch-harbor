import { z } from 'zod';
import { defineTool, ToolError } from '../types.ts';
import { itemsOf, table } from '../present.ts';

/** App screens the assistant may open, with the modules that make them available (as in the app's navigation). */
export const SCREENS: Array<{ path: string; label: string; modules: string[] | null }> = [
  { path: '/overview', label: 'Home', modules: null },
  { path: '/marina', label: 'Assistant: briefing and insights', modules: ['ai.assistant'] },
  { path: '/marina/visit-brief', label: 'Visit brief', modules: ['ai.assistant'] },
  { path: '/marina/studio', label: 'Content studio', modules: ['ai.assistant'] },
  { path: '/locations', label: 'Locations', modules: ['network.locations'] },
  { path: '/approvals', label: 'Approvals', modules: ['network.approvals'] },
  { path: '/reports', label: 'Reports', modules: ['network.reports'] },
  { path: '/league-table', label: 'League table', modules: ['network.league_table'] },
  { path: '/franchise/onboarding', label: 'New locations', modules: ['network.onboarding'] },
  { path: '/franchise/pipeline', label: 'Franchise pipeline', modules: ['sales.franchise_pipeline'] },
  { path: '/franchise/territories', label: 'Territories', modules: ['sales.franchise_pipeline'] },
  { path: '/franchise/agreements', label: 'Agreements', modules: ['legal.agreements', 'legal.disclosure', 'sales.franchise_pipeline', 'network.onboarding'] },
  { path: '/schedule', label: 'Staff schedule', modules: ['operations.schedule'] },
  { path: '/audits', label: 'Audits', modules: ['operations.audits'] },
  { path: '/compliance', label: 'Compliance documents', modules: ['legal.compliance_documents'] },
  { path: '/customers', label: 'Customers', modules: ['sales.customers'] },
  { path: '/sales/leads', label: 'Leads', modules: ['sales.customer_pipeline', 'sales.course_leads'] },
  { path: '/marketing', label: 'Marketing', modules: ['marketing.campaigns'] },
  { path: '/marketing/websites', label: 'Website builder', modules: ['marketing.website_builder'] },
  { path: '/marketing/email', label: 'Email', modules: ['marketing.email'] },
  { path: '/marketing/automations', label: 'Automations', modules: ['marketing.automations'] },
  { path: '/marketing/social', label: 'Social', modules: ['marketing.social'] },
  { path: '/marketing/reviews', label: 'Reviews', modules: ['marketing.reviews'] },
  { path: '/marketing/inbox', label: 'Inbox', modules: ['marketing.inbox'] },
  { path: '/marketing/campaigns', label: 'Ad campaigns', modules: ['marketing.ads', 'marketing.network_campaigns'] },
  { path: '/payments', label: 'Payments', modules: ['finance.payments'] },
  { path: '/finance/royalties', label: 'Royalties', modules: ['finance.royalties'] },
  { path: '/finance/statements', label: 'Statements & invoices', modules: ['finance.invoices'] },
  { path: '/finance/marketing-fund', label: 'Marketing fund', modules: ['finance.marketing_fund'] },
  { path: '/finance/payouts', label: 'Payouts', modules: ['finance.payouts'] },
  { path: '/training', label: 'Training academy', modules: ['training.academy', 'training.assignments'] },
  { path: '/community', label: 'Community', modules: ['community.announcements', 'community.discussions', 'community.library'] },
  { path: '/help', label: 'Help desk', modules: ['community.help_desk'] },
  { path: '/team', label: 'Team & access', modules: ['settings.team'] },
  { path: '/settings', label: 'Settings', modules: ['settings.business', 'settings.billing', 'ai.assistant'] },
];

const navigate = defineTool({
  name: 'navigate',
  kind: 'read',
  area: 'general',
  modules: null,
  description: 'Open a screen in the BranchHarbor app for the person (deep link). Use when they ask to go somewhere, or when the screen is the best place to act. Paths: ' + SCREENS.map((s) => `${s.path} (${s.label})`).join(', ') + '. A record can be opened by appending its id, e.g. /audits/<auditId>.',
  input: z.object({ path: z.string().min(1).max(200).describe('App path, e.g. /audits or /audits/<id>'), label: z.string().max(80).optional() }),
  async run(ctx, input) {
    const path = input.path.split('?')[0]!.replace(/\/+$/, '') || '/overview';
    const screen = [...SCREENS].sort((a, b) => b.path.length - a.path.length).find((s) => path === s.path || path.startsWith(`${s.path}/`));
    if (!screen) throw new ToolError('not_found', `There is no screen at ${path}.`, 404);
    if (screen.modules && !screen.modules.some((m) => ctx.can(m))) throw new ToolError('forbidden', `${screen.label} is not part of your access.`, 403);
    if (path !== screen.path && !/^\/[a-z-]+(\/[a-z-]+)*\/[0-9a-f-]{36}$/.test(path)) throw new ToolError('not_found', `There is no screen at ${path}.`, 404);
    return { path, label: input.label ?? screen.label };
  },
  present: (r: { path: string; label: string }) => ({ summary: `Opening ${r.label}.`, navigate: r }),
});

const taskInput = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(2000).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional().describe('When it is due (ISO 8601 with offset)'),
  link: z.string().max(300).optional().describe('App path the task is about, e.g. /audits/<id>'),
});

const createTask = defineTool({
  name: 'create_task',
  kind: 'write',
  area: 'general',
  modules: null,
  risk: 'change',
  description: 'Add a task to the person’s own to-do list (visible on their assistant home). Use for follow-ups they ask you to track.',
  input: taskInput,
  async preview(_ctx, i) {
    return {
      title: `Add task: ${i.title}`,
      summary: i.dueAt ? `Due ${i.dueAt.slice(0, 16).replace('T', ' ')}` : 'No due date',
      details: [{ label: 'Task', value: i.title }, ...(i.note ? [{ label: 'Note', value: i.note }] : []), ...(i.dueAt ? [{ label: 'Due', value: i.dueAt }] : [])],
      editable: [{ key: 'title', label: 'Task', kind: 'text' }, { key: 'dueAt', label: 'Due', kind: 'date' }],
    };
  },
  async execute(ctx, i) {
    const t = await ctx.api.post(ctx.o('/ai/tasks'), { title: i.title, note: i.note ?? null, dueAt: i.dueAt ?? null, link: i.link ?? null });
    return { result: { taskId: t.id }, link: '/marina' };
  },
});

const remindMe = defineTool({
  name: 'remind_me',
  kind: 'write',
  area: 'general',
  modules: null,
  risk: 'change',
  description: 'Set a reminder for the person: at the given time they get an in-app notification (and push on mobile) with the text.',
  input: taskInput.omit({ dueAt: true }).extend({ remindAt: z.iso.datetime({ offset: true }).describe('When to remind (ISO 8601 with offset), in the future') }),
  async preview(_ctx, i) {
    if (new Date(i.remindAt).getTime() < Date.now() - 60_000) throw new ToolError('validation_failed', 'The reminder time is in the past.');
    return {
      title: `Remind me: ${i.title}`,
      summary: `On ${i.remindAt.slice(0, 16).replace('T', ' ')}`,
      details: [{ label: 'Reminder', value: i.title }, { label: 'When', value: i.remindAt }],
      editable: [{ key: 'title', label: 'Reminder', kind: 'text' }, { key: 'remindAt', label: 'When', kind: 'date' }],
    };
  },
  async execute(ctx, i) {
    const t = await ctx.api.post(ctx.o('/ai/tasks'), { title: i.title, note: i.note ?? null, remindAt: i.remindAt, link: i.link ?? null });
    return { result: { taskId: t.id, remindAt: i.remindAt }, link: '/marina' };
  },
});

const listMyTasks = defineTool({
  name: 'list_my_tasks',
  kind: 'read',
  area: 'general',
  modules: null,
  description: 'The person’s own open tasks and reminders created with the assistant.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/ai/tasks')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: items.length ? `${items.length} open task(s).` : 'No open tasks.',
      blocks: items.length ? [table('My tasks', [{ key: 'title', label: 'Task' }, { key: 'dueAt', label: 'Due', kind: 'date' }, { key: 'remindAt', label: 'Reminder', kind: 'date' }], items)] : [],
    };
  },
});

export default [navigate, createTask, remindMe, listMyTasks];
