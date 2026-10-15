import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  accountManagers, coachingThreads, communityAnnouncementReads, communityAnnouncements, communitySpaces, tickets, users,
  type Audience,
} from '../db/schema/index.ts';
import { audienceIncludes, audienceUserIds, orgViewers, type Viewer } from './network-access.ts';
import { networkNotify } from './network-notify.ts';

export type Announcement = typeof communityAnnouncements.$inferSelect;
export type Space = typeof communitySpaces.$inferSelect;

export const REACTIONS = ['like', 'love', 'celebrate', 'thanks', 'insight'] as const;

/** Live = published and its publish time has come. */
export const isLive = (a: Announcement, now = new Date()) => a.status === 'published' && (!a.publishAt || a.publishAt <= now);

/** Authors and HQ announcers see drafts and scheduled posts; everyone else sees live posts addressed to them. */
export function canSeeAnnouncement(a: Announcement, v: Viewer, now = new Date()): boolean {
  const manager = v.orgPerms.has('community.announce') || a.authorId === v.userId;
  if (manager) return a.status !== 'archived' || a.authorId === v.userId || v.orgPerms.has('community.announce');
  return isLive(a, now) && audienceIncludes(a.audience, v, { hqSeesAll: true });
}

export function canSeeSpace(sp: Space, v: Viewer) {
  if (sp.archivedAt && !v.orgPerms.has('community.manage')) return false;
  return audienceIncludes(sp.audience, v, { hqSeesAll: true });
}
export function canPostInSpace(sp: Space, v: Viewer) {
  if (!v.perms.has('community.post') || !canSeeSpace(sp, v) || sp.archivedAt) return false;
  return sp.postingPolicy !== 'hq_only' || v.hq;
}
/** Moderators: HQ with community.moderate, or a regional moderator for spaces addressed to their region only. */
export function canModerate(v: Viewer, sp?: Space | null) {
  if (v.orgPerms.has('community.moderate')) return true;
  if (!v.perms.has('community.moderate') || !sp) return false;
  const a = sp.audience;
  return !!a.regionIds?.length && a.regionIds.every((r) => v.regionIds.has(r)) && !a.hqOnly;
}

/** Notify the audience once the announcement is live (scheduled posts are picked up by the housekeeping sweep). */
export async function notifyAnnouncement(s: Services, a: Announcement) {
  if (!isLive(a) || a.notifiedAt) return 0;
  const [claimed] = await s.db.update(communityAnnouncements).set({ notifiedAt: new Date() })
    .where(and(eq(communityAnnouncements.id, a.id), isNull(communityAnnouncements.notifiedAt))).returning({ id: communityAnnouncements.id });
  if (!claimed) return 0;
  const ids = await audienceUserIds(s.db, a.organizationId, a.audience, 'community.read', { hqSeesAll: false });
  return networkNotify(s, {
    organizationId: a.organizationId, userIds: ids, exclude: a.authorId ? [a.authorId] : [], kind: 'announcement',
    title: a.requiredRead ? `Required read: ${a.title}` : a.title, body: a.body.slice(0, 200), link: `/community?announcement=${a.id}`, data: { announcementId: a.id, requiredRead: a.requiredRead },
  });
}

/** Everyone the announcement is addressed to, with their read / acknowledged state. */
export async function announcementReceipts(db: Exec, a: Announcement) {
  const viewers = (await orgViewers(db, a.organizationId)).filter((v) => v.perms.has('community.read') && audienceIncludes(a.audience, v, { hqSeesAll: false }) && v.userId !== a.authorId);
  const reads = await db.select().from(communityAnnouncementReads).where(eq(communityAnnouncementReads.announcementId, a.id));
  const byUser = new Map(reads.map((r) => [r.userId, r]));
  const names = viewers.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, viewers.map((v) => v.userId))) : [];
  const nameOf = new Map(names.map((n) => [n.id, n]));
  return viewers.map((v) => {
    const r = byUser.get(v.userId);
    return {
      userId: v.userId, name: nameOf.get(v.userId)?.name ?? '', email: nameOf.get(v.userId)?.email ?? '', roles: [...v.roles], locationIds: [...v.locationIds],
      readAt: r?.readAt?.toISOString() ?? null, acknowledgedAt: r?.acknowledgedAt?.toISOString() ?? null, remindedAt: r?.remindedAt?.toISOString() ?? null,
    };
  }).sort((x, y) => x.name.localeCompare(y.name));
}

/** Remind people who have not confirmed a required read. */
export async function remindRequiredRead(s: Services, a: Announcement, now = new Date()) {
  if (!a.requiredRead || !isLive(a, now)) return 0;
  const receipts = await announcementReceipts(s.db, a);
  const pending = receipts.filter((r) => !r.acknowledgedAt).map((r) => r.userId);
  if (!pending.length) return 0;
  const sent = await networkNotify(s, {
    organizationId: a.organizationId, userIds: pending, kind: 'required_read_reminder', title: `Reminder: please read and confirm “${a.title}”`,
    body: a.dueAt ? `Due ${a.dueAt.toISOString().slice(0, 10)}` : null, link: `/community?announcement=${a.id}`, data: { announcementId: a.id },
  });
  for (const userId of pending) {
    await s.db.insert(communityAnnouncementReads).values({ organizationId: a.organizationId, announcementId: a.id, userId, remindedAt: now })
      .onConflictDoUpdate({ target: [communityAnnouncementReads.announcementId, communityAnnouncementReads.userId], set: { remindedAt: now } });
  }
  await s.db.update(communityAnnouncements).set({ lastReminderAt: now }).where(eq(communityAnnouncements.id, a.id));
  return sent;
}

/**
 * Periodic sweep (server.ts, every 5 minutes): notify scheduled announcements that went live, remind people about
 * required reads due within two days (at most daily), SLA breaches, certificate expiry and email digests.
 */
export async function runNetworkHousekeeping(s: Services, now = new Date()) {
  const out = { published: 0, reminders: 0, sla: 0, expired: 0, digests: 0 };
  const due = await s.db.select().from(communityAnnouncements)
    .where(and(eq(communityAnnouncements.status, 'published'), isNull(communityAnnouncements.notifiedAt), or(isNull(communityAnnouncements.publishAt), lte(communityAnnouncements.publishAt, now))));
  for (const a of due) out.published += await notifyAnnouncement(s, a);

  const required = await s.db.select().from(communityAnnouncements)
    .where(and(eq(communityAnnouncements.status, 'published'), eq(communityAnnouncements.requiredRead, true), isNotNull(communityAnnouncements.dueAt),
      lte(communityAnnouncements.dueAt, new Date(now.getTime() + 2 * 86_400_000)), or(isNull(communityAnnouncements.lastReminderAt), lte(communityAnnouncements.lastReminderAt, new Date(now.getTime() - 86_400_000)))));
  for (const a of required) if (a.dueAt! > new Date(now.getTime() - 14 * 86_400_000)) out.reminders += await remindRequiredRead(s, a, now);

  const { runHelpdeskSla } = await import('./helpdesk.ts');
  out.sla = await runHelpdeskSla(s, now);
  const { runTrainingHousekeeping } = await import('./training.ts');
  out.expired = await runTrainingHousekeeping(s, now);
  const { runEmailDigests } = await import('./network-notify.ts');
  out.digests = await runEmailDigests(s, now);
  return out;
}

/** HQ contacts for the viewer: account managers for any of their regions, owner groups or locations. */
export async function managersFor(db: Exec, v: Viewer) {
  const rows = await db.select({ am: accountManagers, name: users.name, email: users.email }).from(accountManagers).innerJoin(users, eq(users.id, accountManagers.userId))
    .where(eq(accountManagers.organizationId, v.organizationId));
  const covers = (r: typeof accountManagers.$inferSelect) =>
    (r.scopeKind === 'region' && v.regionIds.has(r.scopeId)) || (r.scopeKind === 'owner_group' && v.ownerGroupIds.has(r.scopeId)) || (r.scopeKind === 'location' && v.locationIds.has(r.scopeId));
  const seen = new Set<string>();
  return rows.filter((r) => r.am.userId !== v.userId && covers(r.am)).filter((r) => (seen.has(r.am.userId) ? false : (seen.add(r.am.userId), true)));
}

/** The franchisee side of a coaching relationship: their owner group if they have one, else their location. */
export function franchiseeScopes(v: Viewer): Array<{ kind: 'owner_group' | 'location'; id: string }> {
  if (v.hq) return [];
  const isOwnerSide = v.roles.has('franchise_owner') || v.roles.has('location_manager');
  if (!isOwnerSide) return [];
  const out: Array<{ kind: 'owner_group' | 'location'; id: string }> = [];
  for (const a of v.assignments) {
    if (a.role !== 'franchise_owner' && a.role !== 'location_manager') continue;
    if (a.scopeKind === 'owner_group') out.push({ kind: 'owner_group', id: a.scopeId });
    if (a.scopeKind === 'location') out.push({ kind: 'location', id: a.scopeId });
  }
  return out;
}

/** Who may read a private coaching thread: its HQ contact, the franchisee side of that scope, and HQ admins. */
export function canSeeCoaching(t: typeof coachingThreads.$inferSelect, v: Viewer) {
  if (t.managerUserId === v.userId) return true;
  if (v.orgPerms.has('community.manage')) return true;
  return franchiseeScopes(v).some((sc) => sc.kind === t.scopeKind && sc.id === t.scopeId);
}

/** Members (with the person's own scope) who can see a space: for @mentions. */
export async function spaceAudience(db: Exec, sp: Space): Promise<Viewer[]> {
  return (await orgViewers(db, sp.organizationId)).filter((v) => v.perms.has('community.read') && canSeeSpace(sp, v));
}

export const audienceSummary = (a: Audience) => ({
  everyone: !a.regionIds?.length && !a.ownerGroupIds?.length && !a.locationIds?.length && !a.roles?.length && !a.hqOnly && !a.userIds?.length,
  ...a,
});

/** Open help desk tickets count for the community home (cross-workspace badge). */
export async function openTicketCount(db: Exec, organizationId: string, requesterId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets).where(and(eq(tickets.organizationId, organizationId), eq(tickets.requesterId, requesterId), inArray(tickets.status, ['open', 'pending', 'on_hold'])));
  return r?.n ?? 0;
}
