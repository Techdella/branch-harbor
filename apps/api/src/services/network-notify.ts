import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { communityAnnouncementReads, communityAnnouncements, networkNotificationPrefs, networkNotifications, organizations, users } from '../db/schema/index.ts';
import { notify } from './notifications.ts';

export type NetworkNotificationKind =
  | 'announcement' | 'required_read_reminder' | 'mention' | 'reply' | 'answer_accepted' | 'coaching' | 'event'
  | 'course_assigned' | 'course_approval' | 'course_reviewed' | 'course_lead' | 'certificate_expiring' | 'ticket' | 'ticket_reply' | 'ticket_assigned' | 'sla';

/** Kinds a person cannot switch off: compliance reminders and SLA breaches. */
const ALWAYS: NetworkNotificationKind[] = ['required_read_reminder', 'sla'];

export type Prefs = typeof networkNotificationPrefs.$inferSelect;
export const DEFAULT_PREFS = { inApp: true, push: true, emailDigest: 'daily' as const, mutedKinds: [] as string[], mutedSpaceIds: [] as string[] };

export async function prefsFor(db: Exec, organizationId: string, userIds: string[]): Promise<Map<string, Pick<Prefs, 'inApp' | 'push' | 'emailDigest' | 'mutedKinds' | 'mutedSpaceIds'>>> {
  const rows = userIds.length ? await db.select().from(networkNotificationPrefs).where(and(eq(networkNotificationPrefs.organizationId, organizationId), inArray(networkNotificationPrefs.userId, userIds))) : [];
  const m = new Map(rows.map((r) => [r.userId, r]));
  return new Map(userIds.map((id) => [id, m.get(id) ?? { ...DEFAULT_PREFS }]));
}

export interface NetworkNotifyInput {
  organizationId: string;
  userIds: string[];
  kind: NetworkNotificationKind;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, unknown>;
  /** Space the item belongs to (people can mute a space). */
  spaceId?: string | null;
  /** Never notify these (usually the person who did the thing). */
  exclude?: string[];
}

/**
 * In-app notification rows (the inbox, also the email digest source) plus push through the existing push service.
 * Preferences: muted kinds and spaces are skipped (except compliance and SLA alerts); push only when enabled.
 */
export async function networkNotify(s: Services, input: NetworkNotifyInput): Promise<number> {
  const ids = [...new Set(input.userIds)].filter((id) => !input.exclude?.includes(id));
  if (!ids.length) return 0;
  const prefs = await prefsFor(s.db, input.organizationId, ids);
  const forced = ALWAYS.includes(input.kind);
  const recipients = ids.filter((id) => {
    const p = prefs.get(id)!;
    if (forced) return true;
    if (p.mutedKinds.includes(input.kind)) return false;
    if (input.spaceId && p.mutedSpaceIds.includes(input.spaceId)) return false;
    return true;
  });
  if (!recipients.length) return 0;
  await s.db.insert(networkNotifications).values(recipients.map((userId) => ({
    organizationId: input.organizationId, userId, kind: input.kind, title: input.title.slice(0, 200), body: input.body?.slice(0, 500) ?? null, link: input.link ?? null, data: input.data ?? {},
  })));
  const pushTo = recipients.filter((id) => prefs.get(id)!.push);
  if (pushTo.length) await notify(s, { userIds: pushTo, organizationId: input.organizationId, category: 'network_update', title: input.title.slice(0, 120), body: (input.body ?? '').slice(0, 180), data: { kind: input.kind, link: input.link ?? null, ...(input.data ?? {}) } });
  return recipients.length;
}

/** Cheap change token for polling: clients send If-None-Match and get 304 when nothing changed. */
export async function updatesSummary(db: Exec, organizationId: string, userId: string) {
  const [n] = await db.select({
    unread: sql<number>`count(*) filter (where ${networkNotifications.readAt} is null)::int`,
    latest: sql<string | null>`max(${networkNotifications.createdAt})::text`,
  }).from(networkNotifications).where(and(eq(networkNotifications.organizationId, organizationId), eq(networkNotifications.userId, userId)));
  const [a] = await db.select({ latest: sql<string | null>`max(greatest(${communityAnnouncements.updatedAt}, coalesce(${communityAnnouncements.publishAt}, ${communityAnnouncements.updatedAt})))::text` })
    .from(communityAnnouncements).where(and(eq(communityAnnouncements.organizationId, organizationId), eq(communityAnnouncements.status, 'published'), sql`coalesce(${communityAnnouncements.publishAt}, now()) <= now()`));
  const [r] = await db.select({ latest: sql<string | null>`max(greatest(${communityAnnouncementReads.readAt}, coalesce(${communityAnnouncementReads.acknowledgedAt}, ${communityAnnouncementReads.readAt})))::text` })
    .from(communityAnnouncementReads).where(and(eq(communityAnnouncementReads.organizationId, organizationId), eq(communityAnnouncementReads.userId, userId)));
  const summary = { unreadNotifications: n?.unread ?? 0, latestNotificationAt: n?.latest ?? null, latestAnnouncementAt: a?.latest ?? null, latestReadAt: r?.latest ?? null };
  const etag = `W/"${createHash('sha1').update(JSON.stringify(summary)).digest('hex').slice(0, 20)}"`;
  return { summary, etag };
}

/** Email digests: one email per person per cadence with their unread, not-yet-emailed notifications. */
export async function runEmailDigests(s: Services, now = new Date()) {
  const pending = await s.db.selectDistinct({ organizationId: networkNotifications.organizationId, userId: networkNotifications.userId }).from(networkNotifications)
    .where(and(isNull(networkNotifications.emailedAt), isNull(networkNotifications.readAt), lt(networkNotifications.createdAt, new Date(now.getTime() - 30 * 60_000))));
  let sent = 0;
  for (const p of pending) {
    const prefs = (await prefsFor(s.db, p.organizationId, [p.userId])).get(p.userId)!;
    if (prefs.emailDigest === 'off') continue;
    const [row] = await s.db.select().from(networkNotificationPrefs).where(and(eq(networkNotificationPrefs.organizationId, p.organizationId), eq(networkNotificationPrefs.userId, p.userId)));
    const every = prefs.emailDigest === 'weekly' ? 7 * 86_400_000 : 86_400_000;
    if (row?.lastDigestAt && now.getTime() - row.lastDigestAt.getTime() < every) continue;
    const items = await s.db.select().from(networkNotifications)
      .where(and(eq(networkNotifications.organizationId, p.organizationId), eq(networkNotifications.userId, p.userId), isNull(networkNotifications.emailedAt), isNull(networkNotifications.readAt)))
      .orderBy(desc(networkNotifications.createdAt)).limit(30);
    if (!items.length) continue;
    const [[u], [o]] = await Promise.all([
      s.db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, p.userId)),
      s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.organizationId)),
    ]);
    if (!u) continue;
    await s.mailer.send({
      to: u.email,
      subject: `${o?.name ?? 'Your network'}: ${items.length} update${items.length === 1 ? '' : 's'}`,
      text: [`Hi ${u.name},`, '', ...items.map((i) => `• ${i.title}${i.body ? ` — ${i.body}` : ''}${i.link ? `\n  ${s.cfg.APP_URL}${i.link}` : ''}`), '', `Change how often you get this email: ${s.cfg.APP_URL}/community?tab=settings`].join('\n'),
      tag: 'network-digest',
    });
    await s.db.update(networkNotifications).set({ emailedAt: now }).where(inArray(networkNotifications.id, items.map((i) => i.id)));
    await s.db.insert(networkNotificationPrefs).values({ organizationId: p.organizationId, userId: p.userId, lastDigestAt: now })
      .onConflictDoUpdate({ target: [networkNotificationPrefs.organizationId, networkNotificationPrefs.userId], set: { lastDigestAt: now } });
    sent++;
  }
  return sent;
}
