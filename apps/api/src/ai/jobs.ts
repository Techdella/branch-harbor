import { and, eq, inArray, isNull, lt, lte } from 'drizzle-orm';
import { ASSISTANT_NAME } from '@bh/shared';
import type { Services } from '../context.ts';
import { aiConversations, aiOrgSettings, aiTasks, aiToolCalls, networkNotifications, organizations } from '../db/schema/index.ts';
import { syncOrgKnowledge } from './knowledge.ts';
import { loadAiSettings } from './settings.ts';
import { runBriefings } from './skills/briefing.ts';
import { autoAnswerTicket } from './skills/helpdesk.ts';
import { refreshInsights } from './skills/insights.ts';

/**
 * Scheduled work for the assistant (registered in jobs/handlers.ts, triggered from server.ts):
 * - `marina.tick` (every 5 minutes): due reminders, due briefings.
 * - `marina.daily` (hourly, one org at a time is cheap): insights detection, knowledge re-index, retention purge.
 * - `marina.ticket_created`: help desk auto-answer when the organisation opted in.
 */
export function registerAssistantJobs(s: Services) {
  s.jobs.register('marina.tick', async () => {
    await sendDueReminders(s);
    await runBriefings(s);
  });
  s.jobs.register('marina.daily', async () => {
    const orgs = await s.db.select({ id: organizations.id }).from(organizations);
    for (const o of orgs) {
      const settings = await loadAiSettings(s.db, o.id);
      if (!settings.enabled) continue;
      await refreshInsights(s, o.id).catch((err) => s.log.warn({ err, org: o.id }, '[ai] insights failed'));
      await syncOrgKnowledge(s, o.id).catch((err) => s.log.warn({ err, org: o.id }, '[ai] knowledge sync failed'));
    }
    await purgeExpired(s);
  });
  s.jobs.register('marina.ticket_created', async ({ ticketId }: { ticketId: string }) => {
    await autoAnswerTicket(s, ticketId);
  });
}

/** Reminders whose time has come: an in-app notification (push follows the notification preferences). */
export async function sendDueReminders(s: Services, now = new Date()) {
  const due = await s.db.select().from(aiTasks).where(and(eq(aiTasks.status, 'open'), isNull(aiTasks.remindedAt), lte(aiTasks.remindAt, now))).limit(500);
  for (const t of due) {
    await s.db.insert(networkNotifications).values({ organizationId: t.organizationId, userId: t.userId, kind: 'marina_reminder', title: `${ASSISTANT_NAME}: reminder`, body: t.title, link: t.link ?? '/marina', data: { taskId: t.id } });
    await s.db.update(aiTasks).set({ remindedAt: now }).where(eq(aiTasks.id, t.id));
    await s.jobs.enqueue('push.send', { userIds: [t.userId], organizationId: t.organizationId, category: 'network_update', title: `${ASSISTANT_NAME}: reminder`, body: t.title, data: { link: t.link ?? '/marina' } }).catch(() => {});
  }
  return due.length;
}

/** Data retention: conversations (with their messages and cards) and tool-call logs older than the organisation's setting. */
export async function purgeExpired(s: Services, now = new Date()) {
  const rows = await s.db.select().from(aiOrgSettings);
  const custom = new Map(rows.map((r) => [r.organizationId, Number((r.settings as { retentionDays?: number }).retentionDays ?? 365)]));
  const orgs = await s.db.select({ id: organizations.id }).from(organizations);
  let removed = 0;
  for (const o of orgs) {
    const days = custom.get(o.id) ?? 365;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const old = await s.db.select({ id: aiConversations.id }).from(aiConversations).where(and(eq(aiConversations.organizationId, o.id), lt(aiConversations.updatedAt, cutoff))).limit(1000);
    if (old.length) {
      await s.db.delete(aiConversations).where(inArray(aiConversations.id, old.map((x) => x.id)));
      removed += old.length;
    }
    await s.db.delete(aiToolCalls).where(and(eq(aiToolCalls.organizationId, o.id), lt(aiToolCalls.createdAt, cutoff)));
  }
  return removed;
}
