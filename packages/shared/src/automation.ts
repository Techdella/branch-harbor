/**
 * Marketing automation flows (Marketing workspace → automations): one trigger → conditions → delays → actions.
 * Stored as a graph (React Flow compatible: nodes with positions, edges with an optional yes/no handle).
 * Executed server-side by a durable engine: one run per contact per trigger event, one step per node, so a retried
 * or duplicated job never repeats an action.
 */
import { z } from 'zod';

export const AUTOMATION_TRIGGERS = [
  'lead.created', 'form.submitted', 'booking.created', 'booking.cancelled', 'class.missed', 'order.completed',
  'membership.expiring', 'location.opening_soon', 'tag.added', 'customer.birthday',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTIONS = ['send_email', 'send_sms', 'send_whatsapp', 'add_tag', 'remove_tag', 'create_task', 'notify_staff', 'webhook'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const CONDITION_KINDS = ['field', 'segment', 'location', 'consent', 'tag'] as const;
export const FIELD_OPS = ['eq', 'neq', 'contains', 'exists', 'not_exists', 'gt', 'lt'] as const;
export const CONDITION_FIELDS = ['contact.email', 'contact.phone', 'contact.locale', 'contact.name', 'event.source', 'event.formId', 'event.tag', 'event.total', 'event.status'] as const;
export const CONSENT_PURPOSES = ['marketing_email', 'marketing_sms', 'marketing_whatsapp'] as const;

const tag = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u);

export const triggerConfigSchema = z.object({
  event: z.enum(AUTOMATION_TRIGGERS),
  /** form.submitted: only this form. tag.added: only this tag. membership.expiring / location.opening_soon: days before. */
  formId: z.uuid().optional(),
  tag: tag.optional(),
  daysBefore: z.number().int().min(0).max(120).optional(),
});

export const conditionConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), field: z.enum(CONDITION_FIELDS), op: z.enum(FIELD_OPS), value: z.string().max(200).default('') }),
  z.object({ kind: z.literal('segment'), segmentId: z.uuid() }),
  z.object({ kind: z.literal('location'), locationIds: z.array(z.uuid()).min(1).max(500) }),
  z.object({ kind: z.literal('consent'), purpose: z.enum(CONSENT_PURPOSES) }),
  z.object({ kind: z.literal('tag'), tag }),
]);

export const delayConfigSchema = z.object({ amount: z.number().int().min(1).max(365), unit: z.enum(['minutes', 'hours', 'days']) });

const https = z.url().refine((u) => u.startsWith('https://'), 'Webhooks must use https');

export const actionConfigSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send_email'), templateId: z.uuid().optional(), subject: z.string().max(200).optional() }),
  z.object({ action: z.literal('send_sms'), body: z.string().min(1).max(640) }),
  z.object({ action: z.literal('send_whatsapp'), body: z.string().min(1).max(1000) }),
  z.object({ action: z.literal('add_tag'), tag }),
  z.object({ action: z.literal('remove_tag'), tag }),
  z.object({ action: z.literal('create_task'), title: z.string().min(1).max(200), dueInDays: z.number().int().min(0).max(90).default(1) }),
  z.object({ action: z.literal('notify_staff'), message: z.string().min(1).max(500) }),
  z.object({ action: z.literal('webhook'), url: https }),
]);
export type ActionConfig = z.infer<typeof actionConfigSchema>;
export type ConditionConfig = z.infer<typeof conditionConfigSchema>;

const pos = z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 });
const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const automationNodeSchema = z.discriminatedUnion('type', [
  z.object({ id: nodeId, type: z.literal('trigger'), position: pos, config: triggerConfigSchema }),
  z.object({ id: nodeId, type: z.literal('condition'), position: pos, config: conditionConfigSchema }),
  z.object({ id: nodeId, type: z.literal('delay'), position: pos, config: delayConfigSchema }),
  z.object({ id: nodeId, type: z.literal('action'), position: pos, config: actionConfigSchema }),
]);
export type AutomationNode = z.infer<typeof automationNodeSchema>;

export const automationEdgeSchema = z.object({ id: z.string().max(80), source: nodeId, target: nodeId, sourceHandle: z.enum(['yes', 'no']).nullable().optional() });
export type AutomationEdge = z.infer<typeof automationEdgeSchema>;

export const automationGraphSchema = z.object({ nodes: z.array(automationNodeSchema).min(1).max(60), edges: z.array(automationEdgeSchema).max(120) });
export type AutomationGraph = z.infer<typeof automationGraphSchema>;

export interface GraphIssue { nodeId: string | null; code: 'no_trigger' | 'many_triggers' | 'dangling_edge' | 'cycle' | 'unreachable' | 'branch_missing' | 'multiple_next' | 'invalid' }

/** Structural checks: exactly one trigger, edges point at real nodes, no cycles, conditions branch yes/no, others have ≤ 1 next. */
export function validateAutomationGraph(input: unknown): { ok: boolean; graph: AutomationGraph | null; issues: GraphIssue[] } {
  const parsed = automationGraphSchema.safeParse(input);
  if (!parsed.success) return { ok: false, graph: null, issues: parsed.error.issues.map(() => ({ nodeId: null, code: 'invalid' as const })) };
  const g = parsed.data;
  const issues: GraphIssue[] = [];
  const ids = new Set(g.nodes.map((n) => n.id));
  const triggers = g.nodes.filter((n) => n.type === 'trigger');
  if (!triggers.length) issues.push({ nodeId: null, code: 'no_trigger' });
  if (triggers.length > 1) issues.push({ nodeId: triggers[1]!.id, code: 'many_triggers' });
  for (const e of g.edges) if (!ids.has(e.source) || !ids.has(e.target)) issues.push({ nodeId: e.source, code: 'dangling_edge' });
  for (const n of g.nodes) {
    const out = g.edges.filter((e) => e.source === n.id);
    if (n.type === 'condition') {
      if (out.filter((e) => e.sourceHandle === 'yes').length > 1 || out.filter((e) => e.sourceHandle === 'no').length > 1) issues.push({ nodeId: n.id, code: 'multiple_next' });
      if (out.some((e) => !e.sourceHandle)) issues.push({ nodeId: n.id, code: 'branch_missing' });
    } else if (out.length > 1) issues.push({ nodeId: n.id, code: 'multiple_next' });
  }
  // cycle + reachability from the trigger
  const trig = triggers[0];
  if (trig) {
    const seen = new Set<string>();
    const stack = new Set<string>();
    const visit = (id: string): boolean => {
      if (stack.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id); stack.add(id);
      const cyc = g.edges.filter((e) => e.source === id).some((e) => ids.has(e.target) && visit(e.target));
      stack.delete(id);
      return cyc;
    };
    if (visit(trig.id)) issues.push({ nodeId: null, code: 'cycle' });
    for (const n of g.nodes) if (!seen.has(n.id)) issues.push({ nodeId: n.id, code: 'unreachable' });
  }
  return { ok: issues.length === 0, graph: g, issues };
}

/** The next node from `nodeId` (conditions follow the `yes` / `no` handle). */
export function nextNode(g: AutomationGraph, nodeId: string, branch?: 'yes' | 'no'): AutomationNode | null {
  const e = g.edges.find((x) => x.source === nodeId && (branch ? x.sourceHandle === branch : true));
  return e ? g.nodes.find((n) => n.id === e.target) ?? null : null;
}

export const delayMs = (c: z.infer<typeof delayConfigSchema>) => c.amount * (c.unit === 'minutes' ? 60_000 : c.unit === 'hours' ? 3_600_000 : 86_400_000);

/** Ready-made flows. Copy (subjects, texts) is supplied by the dashboard in the user's language. */
export const AUTOMATION_TEMPLATES = ['welcome_series', 'trial_follow_up', 'win_back', 'birthday', 'review_request', 'coming_soon_launch'] as const;
export type AutomationTemplate = (typeof AUTOMATION_TEMPLATES)[number];

export function automationTemplate(kind: AutomationTemplate, copy: { sms: string; task: string; tag: string }): AutomationGraph {
  const n = (id: string, x: number, y: number) => ({ id, position: { x, y } });
  const line = (...ids: string[]) => ids.slice(1).map((t, i) => ({ id: `e${i}`, source: ids[i]!, target: t, sourceHandle: null }));
  switch (kind) {
    case 'welcome_series':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'lead.created' } },
        { ...n('c', 0, 120), type: 'condition', config: { kind: 'consent', purpose: 'marketing_email' } },
        { ...n('a1', -160, 240), type: 'action', config: { action: 'send_email' } },
        { ...n('d1', -160, 360), type: 'delay', config: { amount: 2, unit: 'days' } },
        { ...n('a2', -160, 480), type: 'action', config: { action: 'send_email' } },
        { ...n('a3', 160, 240), type: 'action', config: { action: 'create_task', title: copy.task, dueInDays: 1 } },
      ], edges: [{ id: 'e1', source: 't', target: 'c' }, { id: 'e2', source: 'c', target: 'a1', sourceHandle: 'yes' }, { id: 'e3', source: 'a1', target: 'd1' }, { id: 'e4', source: 'd1', target: 'a2' }, { id: 'e5', source: 'c', target: 'a3', sourceHandle: 'no' }] };
    case 'trial_follow_up':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'booking.created' } },
        { ...n('d1', 0, 120), type: 'delay', config: { amount: 1, unit: 'days' } },
        { ...n('a1', 0, 240), type: 'action', config: { action: 'send_email' } },
        { ...n('d2', 0, 360), type: 'delay', config: { amount: 3, unit: 'days' } },
        { ...n('a2', 0, 480), type: 'action', config: { action: 'send_sms', body: copy.sms } },
      ], edges: line('t', 'd1', 'a1', 'd2', 'a2') };
    case 'win_back':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'class.missed' } },
        { ...n('d1', 0, 120), type: 'delay', config: { amount: 2, unit: 'days' } },
        { ...n('a1', 0, 240), type: 'action', config: { action: 'send_email' } },
        { ...n('a2', 0, 360), type: 'action', config: { action: 'add_tag', tag: copy.tag } },
      ], edges: line('t', 'd1', 'a1', 'a2') };
    case 'birthday':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'customer.birthday' } },
        { ...n('a1', 0, 120), type: 'action', config: { action: 'send_email' } },
      ], edges: line('t', 'a1') };
    case 'review_request':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'order.completed' } },
        { ...n('d1', 0, 120), type: 'delay', config: { amount: 1, unit: 'days' } },
        { ...n('a1', 0, 240), type: 'action', config: { action: 'send_email' } },
      ], edges: line('t', 'd1', 'a1') };
    case 'coming_soon_launch':
      return { nodes: [
        { ...n('t', 0, 0), type: 'trigger', config: { event: 'location.opening_soon', daysBefore: 14 } },
        { ...n('a1', 0, 120), type: 'action', config: { action: 'send_email' } },
        { ...n('a2', 0, 240), type: 'action', config: { action: 'notify_staff', message: copy.task } },
      ], edges: line('t', 'a1', 'a2') };
  }
}
