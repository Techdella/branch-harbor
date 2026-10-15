import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { helpdeskCategories, helpdeskSettings, ticketMessages, tickets, type Attachment } from '../db/schema/index.ts';
import { randomToken } from '../lib/crypto.ts';
import { conflict, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { orgViewers, type Viewer } from './network-access.ts';
import { networkNotify } from './network-notify.ts';

export type Ticket = typeof tickets.$inferSelect;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ['open', 'pending', 'on_hold', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof STATUSES)[number];

/** SLA targets scale with priority: urgent is four times faster than normal, low is half as fast. */
export const PRIORITY_FACTOR: Record<Priority, number> = { urgent: 0.25, high: 0.5, normal: 1, low: 2 };
export const DEFAULT_SLA = { firstResponseMinutes: 240, resolutionMinutes: 2880 };
const PAUSED: TicketStatus[] = ['pending', 'on_hold'];
const DONE: TicketStatus[] = ['resolved', 'closed'];

export function slaTargets(priority: Priority, cat?: { firstResponseMinutes: number; resolutionMinutes: number } | null, from = new Date()) {
  const base = cat ?? DEFAULT_SLA;
  const f = PRIORITY_FACTOR[priority];
  return {
    firstResponseDueAt: new Date(from.getTime() + Math.round(base.firstResponseMinutes * f) * 60_000),
    resolutionDueAt: new Date(from.getTime() + Math.round(base.resolutionMinutes * f) * 60_000),
  };
}

type ClockState = 'met' | 'missed' | 'on_track' | 'at_risk' | 'breached' | 'paused';
/** Where each SLA clock stands right now. "At risk" = less than a quarter of the window left. */
export function slaState(t: Ticket, now = new Date()) {
  const clock = (due: Date | null, doneAt: Date | null): { dueAt: string | null; state: ClockState; minutesLeft: number | null } => {
    if (!due) return { dueAt: null, state: 'on_track', minutesLeft: null };
    if (doneAt) return { dueAt: due.toISOString(), state: doneAt <= due ? 'met' : 'missed', minutesLeft: null };
    const ref = t.pausedAt ?? now;
    const left = Math.round((due.getTime() - ref.getTime()) / 60_000);
    if (t.pausedAt) return { dueAt: due.toISOString(), state: 'paused', minutesLeft: left };
    const window = (due.getTime() - t.createdAt.getTime()) / 60_000;
    return { dueAt: due.toISOString(), state: left < 0 ? 'breached' : left < window * 0.25 ? 'at_risk' : 'on_track', minutesLeft: left };
  };
  return { firstResponse: clock(t.firstResponseDueAt, t.firstRespondedAt), resolution: clock(t.resolutionDueAt, t.resolvedAt) };
}

export const isAgent = (v: Viewer) => v.orgPerms.has('helpdesk.agent');

/** Agents see every ticket; requesters their own; franchise owners / managers the tickets of their locations. */
export function canSeeTicket(t: Ticket, v: Viewer) {
  if (isAgent(v)) return true;
  if (t.requesterId === v.userId) return true;
  const manager = v.roles.has('franchise_owner') || v.roles.has('location_manager') || v.roles.has('regional_manager');
  return manager && !!t.locationId && v.locationIds.has(t.locationId);
}

export async function agentIds(db: Exec, organizationId: string) {
  return (await orgViewers(db, organizationId)).filter((v) => v.orgPerms.has('helpdesk.agent')).map((v) => v.userId);
}

/** Least-loaded agent (open tickets), the category's default assignee first. */
async function autoAssignee(db: Exec, organizationId: string, categoryDefault: string | null) {
  const agents = await agentIds(db, organizationId);
  if (categoryDefault && agents.includes(categoryDefault)) return categoryDefault;
  if (!agents.length) return null;
  const load = await db.select({ id: tickets.assigneeId, n: sql<number>`count(*)::int` }).from(tickets)
    .where(and(eq(tickets.organizationId, organizationId), inArray(tickets.assigneeId, agents), inArray(tickets.status, ['open', 'pending', 'on_hold']))).groupBy(tickets.assigneeId);
  const m = new Map(load.map((l) => [l.id, l.n]));
  return [...agents].sort((a, b) => (m.get(a) ?? 0) - (m.get(b) ?? 0) || a.localeCompare(b))[0]!;
}

export async function ensureSettings(db: Exec, organizationId: string) {
  const [row] = await db.select().from(helpdeskSettings).where(eq(helpdeskSettings.organizationId, organizationId));
  if (row) return row;
  const [created] = await db.insert(helpdeskSettings).values({ organizationId, inboundToken: randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, 'x') }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(helpdeskSettings).where(eq(helpdeskSettings.organizationId, organizationId)))[0]!;
}

export interface NewTicket {
  organizationId: string;
  requesterId: string | null;
  requesterEmail?: string | null;
  locationId?: string | null;
  categoryId?: string | null;
  subject: string;
  body: string;
  priority: Priority;
  channel: 'web' | 'mobile' | 'email';
  attachments?: Attachment[];
}

export async function createTicket(s: Services, input: NewTicket) {
  const settings = await ensureSettings(s.db, input.organizationId);
  const [cat] = input.categoryId ? await s.db.select().from(helpdeskCategories).where(and(eq(helpdeskCategories.id, input.categoryId), eq(helpdeskCategories.organizationId, input.organizationId))) : [];
  if (input.categoryId && !cat) throw validationError('Unknown category', { categoryId: 'Unknown category' });
  const now = new Date();
  const due = slaTargets(input.priority, cat ?? null, now);
  const assigneeId = settings.autoAssign ? await autoAssignee(s.db, input.organizationId, cat?.defaultAssigneeId ?? null) : null;
  const t = await s.db.transaction(async (tx) => {
    // Ticket numbers are sequential per organisation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tickets:${input.organizationId}`}))`);
    const [{ next } = { next: 1 }] = await tx.select({ next: sql<number>`coalesce(max(${tickets.number}), 1000) + 1` }).from(tickets).where(eq(tickets.organizationId, input.organizationId));
    const [row] = await tx.insert(tickets).values({
      organizationId: input.organizationId, number: next, locationId: input.locationId ?? null, requesterId: input.requesterId, requesterEmail: input.requesterEmail ?? null,
      categoryId: cat?.id ?? null, subject: input.subject, priority: input.priority, status: 'open', assigneeId, channel: input.channel, ...due, createdAt: now, updatedAt: now,
    }).returning();
    await tx.insert(ticketMessages).values({ organizationId: input.organizationId, ticketId: row!.id, authorId: input.requesterId, authorEmail: input.requesterEmail ?? null, body: input.body, attachments: input.attachments ?? [] });
    await audit(tx, { organizationId: input.organizationId, actorUserId: input.requesterId, action: 'helpdesk.ticket_created', targetType: 'ticket', targetId: row!.id, metadata: { number: next, priority: input.priority, channel: input.channel } });
    return row!;
  });
  const to = assigneeId ? [assigneeId] : await agentIds(s.db, input.organizationId);
  await networkNotify(s, { organizationId: input.organizationId, userIds: to, exclude: input.requesterId ? [input.requesterId] : [], kind: assigneeId ? 'ticket_assigned' : 'ticket', title: `#${t.number} ${t.subject}`, body: input.body.slice(0, 160), link: `/help?ticket=${t.id}`, data: { ticketId: t.id, priority: t.priority } });
  // AI assistant: optional knowledge-base auto-answer (only when HQ opted in; see src/ai/skills/helpdesk.ts).
  await s.jobs.enqueue('marina.ticket_created', { ticketId: t.id }).catch(() => {});
  return t;
}

/** Apply a status change, pausing / resuming the SLA clocks (time spent waiting on the requester doesn't count). */
export function statusPatch(t: Ticket, to: TicketStatus, now = new Date()): Partial<Ticket> {
  if (t.status === to) return {};
  const patch: Partial<Ticket> = { status: to, updatedAt: now };
  const wasPaused = !!t.pausedAt;
  if (PAUSED.includes(to) && !wasPaused) patch.pausedAt = now;
  if (!PAUSED.includes(to) && wasPaused) {
    const pausedMs = now.getTime() - t.pausedAt!.getTime();
    patch.pausedAt = null;
    if (!t.firstRespondedAt && t.firstResponseDueAt) patch.firstResponseDueAt = new Date(t.firstResponseDueAt.getTime() + pausedMs);
    if (t.resolutionDueAt) patch.resolutionDueAt = new Date(t.resolutionDueAt.getTime() + pausedMs);
  }
  if (to === 'resolved') patch.resolvedAt = t.resolvedAt ?? now;
  if (to === 'closed') { patch.closedAt = now; patch.resolvedAt = t.resolvedAt ?? now; }
  if ((to === 'open' || to === 'pending' || to === 'on_hold') && DONE.includes(t.status as TicketStatus)) { patch.resolvedAt = null; patch.closedAt = null; patch.breachNotifiedAt = null; }
  return patch;
}

export async function addTicketMessage(s: Services, t: Ticket, author: { userId: string | null; email?: string | null; agent: boolean }, input: { body: string; internal: boolean; attachments?: Attachment[]; status?: TicketStatus }) {
  if (input.internal && !author.agent) throw validationError('Only HQ agents can add internal notes');
  if (t.status === 'closed' && !author.agent) throw conflict('ticket_closed', 'This ticket is closed. Raise a new ticket if you still need help.');
  const now = new Date();
  const out = await s.db.transaction(async (tx) => {
    const [msg] = await tx.insert(ticketMessages).values({ organizationId: t.organizationId, ticketId: t.id, authorId: author.userId, authorEmail: author.email ?? null, body: input.body, internal: input.internal, attachments: input.attachments ?? [] }).returning();
    let patch: Partial<Ticket> = { updatedAt: now };
    if (!input.internal) {
      if (author.agent && author.userId !== t.requesterId) {
        if (!t.firstRespondedAt) patch.firstRespondedAt = now;
        // An answer from HQ waits on the requester unless the agent chose otherwise.
        patch = { ...patch, ...statusPatch({ ...t, ...patch } as Ticket, input.status ?? (DONE.includes(t.status as TicketStatus) ? (t.status as TicketStatus) : 'pending'), now) };
      } else {
        patch = { ...patch, ...statusPatch(t, input.status ?? 'open', now) };
      }
    } else if (input.status) patch = { ...patch, ...statusPatch(t, input.status, now) };
    const [u] = await tx.update(tickets).set(patch).where(eq(tickets.id, t.id)).returning();
    return { message: msg!, ticket: u! };
  });
  if (!input.internal) {
    const to = author.agent ? [t.requesterId] : [t.assigneeId ?? null];
    const recipients = to.filter((x): x is string => !!x);
    const agents = !author.agent && !t.assigneeId ? await agentIds(s.db, t.organizationId) : [];
    await networkNotify(s, { organizationId: t.organizationId, userIds: [...recipients, ...agents], exclude: author.userId ? [author.userId] : [], kind: 'ticket_reply', title: `#${t.number} ${t.subject}`, body: input.body.slice(0, 160), link: `/help?ticket=${t.id}`, data: { ticketId: t.id } });
    if (author.agent && t.requesterEmail && !t.requesterId) {
      await s.mailer.send({ to: t.requesterEmail, subject: `Re: [#${t.number}] ${t.subject}`, text: `${input.body}\n\n— Reply to this email to answer. Ticket #${t.number}.`, tag: 'helpdesk-reply' });
    }
  }
  return out;
}

/** SLA breach alerts (once per ticket) for the assignee, or every agent when unassigned. */
export async function runHelpdeskSla(s: Services, now = new Date()) {
  const late = await s.db.select().from(tickets).where(and(
    inArray(tickets.status, ['open']), isNull(tickets.breachNotifiedAt), isNull(tickets.pausedAt),
    or(and(isNull(tickets.firstRespondedAt), lt(tickets.firstResponseDueAt, now)), lt(tickets.resolutionDueAt, now)),
  ));
  for (const t of late) {
    const to = t.assigneeId ? [t.assigneeId] : await agentIds(s.db, t.organizationId);
    await networkNotify(s, { organizationId: t.organizationId, userIds: to, kind: 'sla', title: `SLA breached: #${t.number} ${t.subject}`, body: !t.firstRespondedAt ? 'No first response yet' : 'Resolution target passed', link: `/help?ticket=${t.id}`, data: { ticketId: t.id } });
    await s.db.update(tickets).set({ breachNotifiedAt: now }).where(eq(tickets.id, t.id));
  }
  return late.length;
}
