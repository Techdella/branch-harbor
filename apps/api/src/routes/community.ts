import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  accountManagers, coachingMessages, coachingThreads, communityAnnouncementReads, communityAnnouncements, communityEventRsvps, communityEvents,
  communityReactions, communityReplies, communityReports, communitySpaces, communityThreads, locations, networkNotificationPrefs, networkNotifications,
  ownerGroups, regions, users,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import {
  announcementReceipts, audienceSummary, canModerate, canPostInSpace, canSeeAnnouncement, canSeeCoaching, canSeeSpace, franchiseeScopes, isLive,
  managersFor, notifyAnnouncement, openTicketCount, REACTIONS, remindRequiredRead, spaceAudience, type Space,
} from '../services/community.ts';
import { audienceIncludes, orgViewers, requireNetworkPerm, roleBadge, userNames, validateAudience, viewerFor, type Viewer } from '../services/network-access.ts';
import { DEFAULT_PREFS, networkNotify, updatesSummary } from '../services/network-notify.ts';
import { idParams, iso, isoDateTime, orgParams, secured } from './_common.ts';
import { attachmentsSchema, audienceSchema, httpUrl } from './network-common.ts';

const tags = ['community'];

export const communityRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const base = '/orgs/:orgId/community';
  const read = async (req: Parameters<typeof viewerFor>[0], orgId: string) => {
    const v = await viewerFor(req, s.db, orgId);
    requireNetworkPerm(v, 'community.read');
    return v;
  };

  /** Post author labels: name + badge (HQ / Account manager / Franchisee …). */
  async function authorsOf(orgId: string, ids: Array<string | null>) {
    const [names, viewers, managers] = await Promise.all([
      userNames(s.db, ids),
      orgViewers(s.db, orgId),
      s.db.selectDistinct({ userId: accountManagers.userId }).from(accountManagers).where(eq(accountManagers.organizationId, orgId)),
    ]);
    const vm = new Map(viewers.map((v) => [v.userId, v]));
    const mgr = new Set(managers.map((m) => m.userId));
    return (id: string | null) => (id ? { id, name: names.get(id) ?? '', badge: roleBadge(vm.get(id), mgr) } : null);
  }

  async function reactionsFor(viewerId: string, targetType: string, ids: string[]) {
    if (!ids.length) return () => ({ counts: {} as Record<string, number>, mine: [] as string[] });
    const rows = await s.db.select().from(communityReactions).where(and(eq(communityReactions.targetType, targetType), inArray(communityReactions.targetId, ids)));
    return (id: string) => {
      const mineRows = rows.filter((r) => r.targetId === id);
      const counts: Record<string, number> = {};
      for (const r of mineRows) counts[r.reaction] = (counts[r.reaction] ?? 0) + 1;
      return { counts, mine: mineRows.filter((r) => r.userId === viewerId).map((r) => r.reaction) };
    };
  }

  // ───────── home / me / updates ─────────

  app.get(`${base}/me`, { schema: { tags, security: secured, params: orgParams, summary: 'What the signed-in member can do in the network workspaces, their HQ contacts and counters' } }, async (req) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    const managers = await managersFor(s.db, v);
    const [unread] = await s.db.select({ n: sql<number>`count(*)::int` }).from(networkNotifications).where(and(eq(networkNotifications.organizationId, v.organizationId), eq(networkNotifications.userId, v.userId), isNull(networkNotifications.readAt)));
    const anns = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.organizationId, v.organizationId), eq(communityAnnouncements.requiredRead, true), eq(communityAnnouncements.status, 'published')));
    const visible = anns.filter((a) => isLive(a) && a.authorId !== v.userId && audienceIncludes(a.audience, v, { hqSeesAll: false }));
    const acks = visible.length ? await s.db.select().from(communityAnnouncementReads).where(and(eq(communityAnnouncementReads.userId, v.userId), inArray(communityAnnouncementReads.announcementId, visible.map((a) => a.id)))) : [];
    const ackd = new Set(acks.filter((a) => a.acknowledgedAt).map((a) => a.announcementId));
    const directory = v.orgPerms.has('community.announce') || v.perms.has('community.announce') || v.orgPerms.has('training.assign') || v.perms.has('training.assign') || v.orgPerms.has('community.manage')
      ? {
        regions: await s.db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, v.organizationId)).orderBy(asc(regions.name)),
        ownerGroups: await s.db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, v.organizationId)).orderBy(asc(ownerGroups.name)),
        locations: await s.db.select({ id: locations.id, name: locations.name, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId }).from(locations).where(eq(locations.organizationId, v.organizationId)).orderBy(asc(locations.name)),
      }
      : null;
    return {
      userId: v.userId, hq: v.hq, roles: [...v.roles],
      permissions: [...v.perms].filter((p) => /^(community|training|helpdesk)\./.test(p)),
      orgPermissions: [...v.orgPerms].filter((p) => /^(community|training|helpdesk)\./.test(p)),
      scope: { regionIds: [...v.regionIds], ownerGroupIds: [...v.ownerGroupIds], locationIds: [...v.locationIds] },
      accountManagers: managers.map((m) => ({ id: m.am.id, userId: m.am.userId, name: m.name, email: m.email, title: m.am.title, bookingUrl: m.am.bookingUrl, bio: m.am.bio, phone: m.am.phone, scopeKind: m.am.scopeKind, scopeId: m.am.scopeId })),
      counters: { unreadNotifications: unread?.n ?? 0, requiredReadsPending: visible.filter((a) => !ackd.has(a.id)).length, openTickets: await openTicketCount(s.db, v.organizationId, v.userId) },
      directory,
    };
  });

  app.get(`${base}/updates`, { schema: { tags, security: secured, params: orgParams, summary: 'Polling endpoint with ETag: send If-None-Match to get 304 when nothing changed' } }, async (req, reply) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    const { summary, etag } = await updatesSummary(s.db, v.organizationId, v.userId);
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return summary;
  });

  // ───────── announcements ─────────

  const annBody = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    audience: audienceSchema.default({}),
    requiredRead: z.boolean().default(false),
    dueAt: isoDateTime.nullable().optional(),
    pinned: z.boolean().default(false),
    status: z.enum(['draft', 'published']).default('published'),
    publishAt: isoDateTime.nullable().optional(),
    attachments: attachmentsSchema,
  });

  function serializeAnnouncement(a: typeof communityAnnouncements.$inferSelect, me: { readAt: Date | null; acknowledgedAt: Date | null } | undefined, author: ReturnType<Awaited<ReturnType<typeof authorsOf>>>, stats?: { targeted: number; acknowledged: number; read: number }) {
    const now = new Date();
    return {
      id: a.id, title: a.title, body: a.body, audience: audienceSummary(a.audience), requiredRead: a.requiredRead, dueAt: iso(a.dueAt), pinned: a.pinned,
      status: a.status === 'published' && a.publishAt && a.publishAt > now ? 'scheduled' : a.status, publishAt: iso(a.publishAt), attachments: a.attachments,
      author, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
      readAt: iso(me?.readAt), acknowledgedAt: iso(me?.acknowledgedAt), overdue: !!(a.requiredRead && a.dueAt && a.dueAt < now && !me?.acknowledgedAt),
      ...(stats ? { stats } : {}),
    };
  }

  app.get(`${base}/announcements`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ filter: z.enum(['all', 'required', 'unread']).default('all'), manage: z.coerce.boolean().default(false) }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const rows = await s.db.select().from(communityAnnouncements).where(eq(communityAnnouncements.organizationId, v.organizationId)).orderBy(desc(communityAnnouncements.pinned), desc(sql`coalesce(${communityAnnouncements.publishAt}, ${communityAnnouncements.createdAt})`));
    const managing = req.query.manage && (v.orgPerms.has('community.announce') || v.perms.has('community.announce'));
    // In the feed everyone (HQ included) sees what is live; "manage" shows drafts and scheduled posts too.
    const feedViewer: Viewer = managing ? v : { ...v, orgPerms: new Set([...v.orgPerms].filter((p) => p !== 'community.announce')) };
    const list = rows.filter((a) => (managing ? canSeeAnnouncement(a, v) && (v.orgPerms.has('community.announce') || a.authorId === v.userId) : canSeeAnnouncement(a, feedViewer) && isLive(a)));
    const reads = list.length ? await s.db.select().from(communityAnnouncementReads).where(and(eq(communityAnnouncementReads.userId, v.userId), inArray(communityAnnouncementReads.announcementId, list.map((a) => a.id)))) : [];
    const rm = new Map(reads.map((r) => [r.announcementId, r]));
    const author = await authorsOf(v.organizationId, list.map((a) => a.authorId));
    let stats = new Map<string, { targeted: number; acknowledged: number; read: number }>();
    if (managing) {
      for (const a of list.filter((x) => isLive(x))) {
        const r = await announcementReceipts(s.db, a);
        stats.set(a.id, { targeted: r.length, acknowledged: r.filter((x) => x.acknowledgedAt).length, read: r.filter((x) => x.readAt).length });
      }
    } else stats = new Map();
    let items = list.map((a) => serializeAnnouncement(a, rm.get(a.id), author(a.authorId), stats.get(a.id)));
    if (req.query.filter === 'required') items = items.filter((a) => a.requiredRead);
    if (req.query.filter === 'unread') items = items.filter((a) => !a.readAt || (a.requiredRead && !a.acknowledgedAt));
    return { items };
  });

  app.get(`${base}/announcements/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, req.params.id), eq(communityAnnouncements.organizationId, v.organizationId)));
    if (!a || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
    const [me] = await s.db.select().from(communityAnnouncementReads).where(and(eq(communityAnnouncementReads.announcementId, a.id), eq(communityAnnouncementReads.userId, v.userId)));
    return serializeAnnouncement(a, me, (await authorsOf(v.organizationId, [a.authorId]))(a.authorId));
  });

  app.post(`${base}/announcements`, { schema: { tags, security: secured, params: orgParams, body: annBody, summary: 'Post (or schedule) an announcement to an audience; required reads collect confirmations' } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.announce');
    const b = req.body;
    if (b.requiredRead && b.dueAt && new Date(b.dueAt) < new Date()) throw validationError('The due date is in the past', { dueAt: 'Choose a future date' });
    const audience = await validateAudience(s.db, v.organizationId, b.audience, v);
    const [a] = await s.db.insert(communityAnnouncements).values({
      organizationId: v.organizationId, title: b.title, body: b.body, audience, requiredRead: b.requiredRead, dueAt: b.dueAt ? new Date(b.dueAt) : null, pinned: b.pinned,
      status: b.status, publishAt: b.publishAt ? new Date(b.publishAt) : null, attachments: b.attachments, authorId: v.userId,
    }).returning();
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.announcement_created', targetType: 'announcement', targetId: a!.id, metadata: { audience, requiredRead: b.requiredRead, status: b.status } });
    const notified = await notifyAnnouncement(s, a!);
    reply.code(201);
    return { ...serializeAnnouncement(a!, undefined, (await authorsOf(v.organizationId, [v.userId]))(v.userId)), notified };
  });

  app.patch(`${base}/announcements/:id`, { schema: { tags, security: secured, params: idParams, body: annBody.partial().extend({ status: z.enum(['draft', 'published', 'archived']).optional() }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, req.params.id), eq(communityAnnouncements.organizationId, v.organizationId)));
    if (!a || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
    if (!(v.orgPerms.has('community.announce') || (a.authorId === v.userId && v.perms.has('community.announce')))) throw forbidden('Only the author or HQ can change this announcement');
    const b = req.body;
    const audience = b.audience ? await validateAudience(s.db, v.organizationId, b.audience, v) : undefined;
    const [u] = await s.db.update(communityAnnouncements).set({
      ...(b.title !== undefined ? { title: b.title } : {}), ...(b.body !== undefined ? { body: b.body } : {}), ...(audience ? { audience } : {}),
      ...(b.requiredRead !== undefined ? { requiredRead: b.requiredRead } : {}), ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
      ...(b.pinned !== undefined ? { pinned: b.pinned } : {}), ...(b.status !== undefined ? { status: b.status } : {}),
      ...(b.publishAt !== undefined ? { publishAt: b.publishAt ? new Date(b.publishAt) : null, notifiedAt: null } : {}), ...(b.attachments !== undefined ? { attachments: b.attachments } : {}),
      updatedAt: new Date(),
    }).where(eq(communityAnnouncements.id, a.id)).returning();
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.announcement_updated', targetType: 'announcement', targetId: a.id, metadata: { fields: Object.keys(b) } });
    await notifyAnnouncement(s, u!);
    return serializeAnnouncement(u!, undefined, (await authorsOf(v.organizationId, [u!.authorId]))(u!.authorId));
  });

  for (const kind of ['read', 'acknowledge'] as const) {
    app.post(`${base}/announcements/:id/${kind}`, { schema: { tags, security: secured, params: idParams, summary: kind === 'read' ? 'Mark as opened (read receipt)' : 'Confirm a required read' } }, async (req) => {
      const v = await read(req, req.params.orgId);
      const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, req.params.id), eq(communityAnnouncements.organizationId, v.organizationId)));
      if (!a || !isLive(a) || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
      const now = new Date();
      const set = kind === 'read' ? { readAt: sql`coalesce(${communityAnnouncementReads.readAt}, ${now.toISOString()}::timestamptz)` } : { readAt: sql`coalesce(${communityAnnouncementReads.readAt}, ${now.toISOString()}::timestamptz)`, acknowledgedAt: sql`coalesce(${communityAnnouncementReads.acknowledgedAt}, ${now.toISOString()}::timestamptz)` };
      const [r] = await s.db.insert(communityAnnouncementReads).values({ organizationId: v.organizationId, announcementId: a.id, userId: v.userId, readAt: now, acknowledgedAt: kind === 'acknowledge' ? now : null })
        .onConflictDoUpdate({ target: [communityAnnouncementReads.announcementId, communityAnnouncementReads.userId], set }).returning();
      if (kind === 'acknowledge') await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.required_read_confirmed', targetType: 'announcement', targetId: a.id });
      return { readAt: iso(r!.readAt), acknowledgedAt: iso(r!.acknowledgedAt) };
    });
  }

  app.get(`${base}/announcements/:id/receipts`, { schema: { tags, security: secured, params: idParams, summary: 'Who it reached, who opened it and who confirmed' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, req.params.id), eq(communityAnnouncements.organizationId, v.organizationId)));
    if (!a || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
    if (!(v.orgPerms.has('community.announce') || a.authorId === v.userId)) throw forbidden('Only the author or HQ can see read receipts');
    const items = await announcementReceipts(s.db, a);
    return { items, totals: { targeted: items.length, read: items.filter((x) => x.readAt).length, acknowledged: items.filter((x) => x.acknowledgedAt).length } };
  });

  app.post(`${base}/announcements/:id/remind`, { schema: { tags, security: secured, params: idParams, summary: 'Remind everyone who has not confirmed a required read' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, req.params.id), eq(communityAnnouncements.organizationId, v.organizationId)));
    if (!a || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
    if (!(v.orgPerms.has('community.announce') || a.authorId === v.userId)) throw forbidden('Only the author or HQ can send reminders');
    if (!a.requiredRead) throw conflict('not_required_read', 'Only required reads have reminders');
    if (a.lastReminderAt && Date.now() - a.lastReminderAt.getTime() < 60 * 60_000) throw conflict('reminded_recently', 'A reminder went out less than an hour ago');
    const reminded = await remindRequiredRead(s, a);
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.required_read_reminded', targetType: 'announcement', targetId: a.id, metadata: { reminded } });
    return { reminded };
  });

  // ───────── spaces, threads, replies ─────────

  const spaceBody = z.object({
    name: z.string().trim().min(1).max(80), description: z.string().max(500).nullable().optional(), kind: z.enum(['discussion', 'qa']).default('discussion'),
    audience: audienceSchema.default({}), postingPolicy: z.enum(['everyone', 'hq_only']).default('everyone'), icon: z.string().max(40).nullable().optional(), position: z.number().int().min(0).max(1000).default(0),
  });
  const serializeSpace = (sp: Space, v: Viewer, stats?: { threads: number; lastActivityAt: string | null }) => ({
    id: sp.id, slug: sp.slug, name: sp.name, description: sp.description, kind: sp.kind, audience: audienceSummary(sp.audience), postingPolicy: sp.postingPolicy, icon: sp.icon,
    archived: !!sp.archivedAt, canPost: canPostInSpace(sp, v), canModerate: canModerate(v, sp), threads: stats?.threads ?? 0, lastActivityAt: stats?.lastActivityAt ?? null,
  });

  app.get(`${base}/spaces`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const rows = (await s.db.select().from(communitySpaces).where(eq(communitySpaces.organizationId, v.organizationId)).orderBy(asc(communitySpaces.position), asc(communitySpaces.name))).filter((sp) => canSeeSpace(sp, v));
    const stats = rows.length ? await s.db.select({ spaceId: communityThreads.spaceId, n: sql<number>`count(*)::int`, last: sql<string | null>`max(${communityThreads.lastActivityAt})::text` }).from(communityThreads)
      .where(and(inArray(communityThreads.spaceId, rows.map((r) => r.id)), isNull(communityThreads.hiddenAt))).groupBy(communityThreads.spaceId) : [];
    const sm = new Map(stats.map((x) => [x.spaceId, { threads: x.n, lastActivityAt: x.last ? new Date(x.last).toISOString() : null }]));
    return { items: rows.map((sp) => serializeSpace(sp, v, sm.get(sp.id))) };
  });

  app.post(`${base}/spaces`, { schema: { tags, security: secured, params: orgParams, body: spaceBody } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const audience = await validateAudience(s.db, v.organizationId, req.body.audience);
    const slugBase = slugify(req.body.name) || 'space';
    const taken = await s.db.select({ slug: communitySpaces.slug }).from(communitySpaces).where(and(eq(communitySpaces.organizationId, v.organizationId), sql`${communitySpaces.slug} like ${`${slugBase}%`}`));
    const slug = taken.some((t) => t.slug === slugBase) ? `${slugBase}-${taken.length + 1}` : slugBase;
    const [sp] = await s.db.insert(communitySpaces).values({ organizationId: v.organizationId, slug, ...req.body, audience, createdBy: v.userId }).returning();
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.space_created', targetType: 'space', targetId: sp!.id, metadata: { audience } });
    reply.code(201);
    return serializeSpace(sp!, v);
  });

  app.patch(`${base}/spaces/:id`, { schema: { tags, security: secured, params: idParams, body: spaceBody.partial().extend({ archived: z.boolean().optional() }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const { archived, audience, ...rest } = req.body;
    const clean = audience ? await validateAudience(s.db, v.organizationId, audience) : undefined;
    const [sp] = await s.db.update(communitySpaces).set({ ...rest, ...(clean ? { audience: clean } : {}), ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) })
      .where(and(eq(communitySpaces.id, req.params.id), eq(communitySpaces.organizationId, v.organizationId))).returning();
    if (!sp) throw notFound('Space');
    return serializeSpace(sp, v);
  });

  async function loadSpace(v: Viewer, id: string) {
    const [sp] = await s.db.select().from(communitySpaces).where(and(eq(communitySpaces.id, id), eq(communitySpaces.organizationId, v.organizationId)));
    if (!sp || !canSeeSpace(sp, v)) throw notFound('Space');
    return sp;
  }
  async function loadThread(v: Viewer, id: string) {
    const [t] = await s.db.select().from(communityThreads).where(and(eq(communityThreads.id, id), eq(communityThreads.organizationId, v.organizationId)));
    if (!t) throw notFound('Thread');
    const sp = await loadSpace(v, t.spaceId).catch(() => null);
    if (!sp) throw notFound('Thread');
    if (t.hiddenAt && !canModerate(v, sp) && t.authorId !== v.userId) throw notFound('Thread');
    return { t, sp };
  }

  /** Mentioned people must be able to see the space; the rest are dropped silently. */
  async function validMentions(sp: Space, ids: string[]) {
    if (!ids.length) return [];
    const aud = new Set((await spaceAudience(s.db, sp)).map((x) => x.userId));
    return [...new Set(ids)].filter((id) => aud.has(id));
  }

  const threadBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20_000), attachments: attachmentsSchema, mentions: z.array(z.uuid()).max(30).default([]) });

  app.get(`${base}/spaces/:id/threads`, { schema: { tags, security: secured, params: idParams, querystring: z.object({ q: z.string().max(100).optional(), filter: z.enum(['all', 'unanswered', 'answered']).default('all') }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const sp = await loadSpace(v, req.params.id);
    const mod = canModerate(v, sp);
    let rows = await s.db.select().from(communityThreads).where(and(eq(communityThreads.spaceId, sp.id), ...(req.query.q ? [sql`(${communityThreads.title} ilike ${`%${req.query.q}%`} or ${communityThreads.body} ilike ${`%${req.query.q}%`})`] : [])))
      .orderBy(desc(communityThreads.pinned), desc(communityThreads.lastActivityAt)).limit(200);
    rows = rows.filter((t) => !t.hiddenAt || mod || t.authorId === v.userId);
    if (req.query.filter === 'unanswered') rows = rows.filter((t) => !t.acceptedReplyId);
    if (req.query.filter === 'answered') rows = rows.filter((t) => !!t.acceptedReplyId);
    const author = await authorsOf(v.organizationId, rows.map((t) => t.authorId));
    const reacts = await reactionsFor(v.userId, 'thread', rows.map((t) => t.id));
    return {
      space: serializeSpace(sp, v),
      items: rows.map((t) => ({
        id: t.id, title: t.title, excerpt: t.body.slice(0, 240), author: author(t.authorId), pinned: t.pinned, locked: !!t.lockedAt, hidden: !!t.hiddenAt, answered: !!t.acceptedReplyId,
        replyCount: t.replyCount, attachments: t.attachments.length, lastActivityAt: t.lastActivityAt.toISOString(), createdAt: t.createdAt.toISOString(), reactions: reacts(t.id),
      })),
    };
  });

  app.post(`${base}/spaces/:id/threads`, { schema: { tags, security: secured, params: idParams, body: threadBody } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    const sp = await loadSpace(v, req.params.id);
    if (!canPostInSpace(sp, v)) throw forbidden(sp.postingPolicy === 'hq_only' ? 'Only HQ posts in this space' : 'You cannot post here');
    const mentions = await validMentions(sp, req.body.mentions);
    const [t] = await s.db.insert(communityThreads).values({ organizationId: v.organizationId, spaceId: sp.id, authorId: v.userId, title: req.body.title, body: req.body.body, attachments: req.body.attachments, mentions }).returning();
    await networkNotify(s, { organizationId: v.organizationId, userIds: mentions, exclude: [v.userId], kind: 'mention', title: `You were mentioned in “${t!.title}”`, body: req.body.body.slice(0, 160), link: `/community?thread=${t!.id}`, spaceId: sp.id, data: { threadId: t!.id } });
    reply.code(201);
    return { id: t!.id, spaceId: sp.id, title: t!.title, mentions };
  });

  app.get(`${base}/threads/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const { t, sp } = await loadThread(v, req.params.id);
    const mod = canModerate(v, sp);
    const replies = (await s.db.select().from(communityReplies).where(eq(communityReplies.threadId, t.id)).orderBy(asc(communityReplies.createdAt))).filter((r) => !r.hiddenAt || mod || r.authorId === v.userId);
    const author = await authorsOf(v.organizationId, [t.authorId, ...replies.map((r) => r.authorId)]);
    const rt = await reactionsFor(v.userId, 'thread', [t.id]);
    const rr = await reactionsFor(v.userId, 'reply', replies.map((r) => r.id));
    const mentionNames = await userNames(s.db, [...t.mentions, ...replies.flatMap((r) => r.mentions)]);
    return {
      space: serializeSpace(sp, v),
      thread: {
        id: t.id, title: t.title, body: t.body, attachments: t.attachments, author: author(t.authorId), pinned: t.pinned, locked: !!t.lockedAt, hidden: !!t.hiddenAt, hiddenReason: mod ? t.hiddenReason : null,
        acceptedReplyId: t.acceptedReplyId, createdAt: t.createdAt.toISOString(), editedAt: iso(t.editedAt), reactions: rt(t.id), mentions: t.mentions.map((id) => ({ id, name: mentionNames.get(id) ?? '' })),
        canEdit: t.authorId === v.userId, canAccept: sp.kind === 'qa' && (t.authorId === v.userId || mod), canReply: canPostInSpace(sp, v) && (!t.lockedAt || mod),
      },
      replies: replies.map((r) => ({
        id: r.id, body: r.body, attachments: r.attachments, author: author(r.authorId), hidden: !!r.hiddenAt, hiddenReason: mod ? r.hiddenReason : null, accepted: t.acceptedReplyId === r.id,
        createdAt: r.createdAt.toISOString(), editedAt: iso(r.editedAt), reactions: rr(r.id), mentions: r.mentions.map((id) => ({ id, name: mentionNames.get(id) ?? '' })), canEdit: r.authorId === v.userId,
      })),
      canModerate: mod,
    };
  });

  app.patch(`${base}/threads/:id`, { schema: { tags, security: secured, params: idParams, body: z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(20_000).optional() }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const { t } = await loadThread(v, req.params.id);
    if (t.authorId !== v.userId) throw forbidden('Only the author can edit this post');
    if (t.lockedAt) throw conflict('thread_locked', 'This thread is locked');
    const [u] = await s.db.update(communityThreads).set({ ...req.body, editedAt: new Date() }).where(eq(communityThreads.id, t.id)).returning();
    return { id: u!.id, title: u!.title, body: u!.body, editedAt: iso(u!.editedAt) };
  });

  app.post(`${base}/threads/:id/replies`, { schema: { tags, security: secured, params: idParams, body: z.object({ body: z.string().trim().min(1).max(20_000), attachments: attachmentsSchema, mentions: z.array(z.uuid()).max(30).default([]) }) } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    const { t, sp } = await loadThread(v, req.params.id);
    if (!canPostInSpace(sp, v)) throw forbidden('You cannot reply here');
    if (t.lockedAt && !canModerate(v, sp)) throw conflict('thread_locked', 'This thread is locked');
    if (t.hiddenAt) throw conflict('thread_hidden', 'This thread is hidden');
    const mentions = await validMentions(sp, req.body.mentions);
    const now = new Date();
    const [r] = await s.db.insert(communityReplies).values({ organizationId: v.organizationId, threadId: t.id, authorId: v.userId, body: req.body.body, attachments: req.body.attachments, mentions, createdAt: now }).returning();
    await s.db.update(communityThreads).set({ replyCount: sql`${communityThreads.replyCount} + 1`, lastActivityAt: now }).where(eq(communityThreads.id, t.id));
    await networkNotify(s, { organizationId: v.organizationId, userIds: mentions, exclude: [v.userId], kind: 'mention', title: `You were mentioned in “${t.title}”`, body: req.body.body.slice(0, 160), link: `/community?thread=${t.id}`, spaceId: sp.id, data: { threadId: t.id } });
    if (t.authorId) await networkNotify(s, { organizationId: v.organizationId, userIds: [t.authorId], exclude: [v.userId, ...mentions], kind: 'reply', title: `New reply to “${t.title}”`, body: req.body.body.slice(0, 160), link: `/community?thread=${t.id}`, spaceId: sp.id, data: { threadId: t.id } });
    reply.code(201);
    return { id: r!.id, threadId: t.id, mentions, createdAt: r!.createdAt.toISOString() };
  });

  app.patch(`${base}/replies/:id`, { schema: { tags, security: secured, params: idParams, body: z.object({ body: z.string().trim().min(1).max(20_000) }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [r] = await s.db.select().from(communityReplies).where(and(eq(communityReplies.id, req.params.id), eq(communityReplies.organizationId, v.organizationId)));
    if (!r) throw notFound('Reply');
    await loadThread(v, r.threadId);
    if (r.authorId !== v.userId) throw forbidden('Only the author can edit this reply');
    const [u] = await s.db.update(communityReplies).set({ body: req.body.body, editedAt: new Date() }).where(eq(communityReplies.id, r.id)).returning();
    return { id: u!.id, body: u!.body, editedAt: iso(u!.editedAt) };
  });

  app.post(`${base}/threads/:id/accept`, { schema: { tags, security: secured, params: idParams, body: z.object({ replyId: z.uuid().nullable() }), summary: 'Q&A: mark (or clear) the accepted answer' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const { t, sp } = await loadThread(v, req.params.id);
    if (sp.kind !== 'qa') throw conflict('not_qa', 'Only questions in Q&A spaces have accepted answers');
    if (t.authorId !== v.userId && !canModerate(v, sp)) throw forbidden('Only the person who asked (or a moderator) can accept an answer');
    let replyAuthor: string | null = null;
    if (req.body.replyId) {
      const [r] = await s.db.select().from(communityReplies).where(and(eq(communityReplies.id, req.body.replyId), eq(communityReplies.threadId, t.id)));
      if (!r || r.hiddenAt) throw notFound('Reply');
      replyAuthor = r.authorId;
    }
    await s.db.update(communityThreads).set({ acceptedReplyId: req.body.replyId }).where(eq(communityThreads.id, t.id));
    if (replyAuthor) await networkNotify(s, { organizationId: v.organizationId, userIds: [replyAuthor], exclude: [v.userId], kind: 'answer_accepted', title: `Your answer was accepted: “${t.title}”`, link: `/community?thread=${t.id}`, spaceId: sp.id, data: { threadId: t.id } });
    return { acceptedReplyId: req.body.replyId };
  });

  // ───────── reactions & moderation ─────────

  async function targetSpace(v: Viewer, targetType: 'thread' | 'reply' | 'announcement', targetId: string): Promise<{ sp: Space | null; authorId: string | null }> {
    if (targetType === 'announcement') {
      const [a] = await s.db.select().from(communityAnnouncements).where(and(eq(communityAnnouncements.id, targetId), eq(communityAnnouncements.organizationId, v.organizationId)));
      if (!a || !canSeeAnnouncement(a, v)) throw notFound('Announcement');
      return { sp: null, authorId: a.authorId };
    }
    if (targetType === 'thread') {
      const { t, sp } = await loadThread(v, targetId);
      return { sp, authorId: t.authorId };
    }
    const [r] = await s.db.select().from(communityReplies).where(and(eq(communityReplies.id, targetId), eq(communityReplies.organizationId, v.organizationId)));
    if (!r) throw notFound('Reply');
    const { sp } = await loadThread(v, r.threadId);
    if (r.hiddenAt && !canModerate(v, sp) && r.authorId !== v.userId) throw notFound('Reply');
    return { sp, authorId: r.authorId };
  }

  const targetBody = z.object({ targetType: z.enum(['thread', 'reply', 'announcement']), targetId: z.uuid() });

  app.post(`${base}/reactions`, { schema: { tags, security: secured, params: orgParams, body: targetBody.extend({ reaction: z.enum(REACTIONS) }), summary: 'Toggle a reaction' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    await targetSpace(v, req.body.targetType, req.body.targetId);
    const where = and(eq(communityReactions.targetType, req.body.targetType), eq(communityReactions.targetId, req.body.targetId), eq(communityReactions.userId, v.userId), eq(communityReactions.reaction, req.body.reaction));
    const removed = await s.db.delete(communityReactions).where(where).returning();
    if (!removed.length) await s.db.insert(communityReactions).values({ organizationId: v.organizationId, ...req.body, userId: v.userId }).onConflictDoNothing();
    const rows = await s.db.select().from(communityReactions).where(and(eq(communityReactions.targetType, req.body.targetType), eq(communityReactions.targetId, req.body.targetId)));
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.reaction] = (counts[r.reaction] ?? 0) + 1;
    return { active: !removed.length, counts, mine: rows.filter((r) => r.userId === v.userId).map((r) => r.reaction) };
  });

  app.post(`${base}/reports`, { schema: { tags, security: secured, params: orgParams, body: targetBody.extend({ reason: z.string().trim().min(3).max(500) }), summary: 'Report a post to the moderators' } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    if (req.body.targetType === 'announcement') throw validationError('Announcements cannot be reported');
    await targetSpace(v, req.body.targetType, req.body.targetId);
    const [r] = await s.db.insert(communityReports).values({ organizationId: v.organizationId, ...req.body, reporterId: v.userId }).returning();
    const mods = (await orgViewers(s.db, v.organizationId)).filter((x) => x.orgPerms.has('community.moderate')).map((x) => x.userId);
    await networkNotify(s, { organizationId: v.organizationId, userIds: mods, exclude: [v.userId], kind: 'mention', title: 'A post was reported', body: req.body.reason, link: `/community?tab=moderation`, data: { reportId: r!.id } });
    reply.code(201);
    return { id: r!.id, status: r!.status };
  });

  app.get(`${base}/reports`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open') }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    if (!v.perms.has('community.moderate')) throw forbidden('Moderators only');
    const rows = await s.db.select().from(communityReports).where(and(eq(communityReports.organizationId, v.organizationId), eq(communityReports.status, req.query.status))).orderBy(desc(communityReports.createdAt));
    const names = await userNames(s.db, rows.map((r) => r.reporterId));
    const out = [];
    for (const r of rows) {
      const tgt = await targetSpace(v, r.targetType as 'thread' | 'reply', r.targetId).catch(() => null);
      if (!tgt || !canModerate(v, tgt.sp)) continue;
      const [content] = r.targetType === 'thread'
        ? await s.db.select({ text: communityThreads.title, threadId: communityThreads.id, hidden: communityThreads.hiddenAt }).from(communityThreads).where(eq(communityThreads.id, r.targetId))
        : await s.db.select({ text: communityReplies.body, threadId: communityReplies.threadId, hidden: communityReplies.hiddenAt }).from(communityReplies).where(eq(communityReplies.id, r.targetId));
      out.push({ id: r.id, targetType: r.targetType, targetId: r.targetId, threadId: content?.threadId ?? null, excerpt: content?.text.slice(0, 200) ?? '', hidden: !!content?.hidden, reason: r.reason, reporter: names.get(r.reporterId) ?? '', status: r.status, createdAt: r.createdAt.toISOString() });
    }
    return { items: out };
  });

  app.post(`${base}/moderation`, {
    schema: { tags, security: secured, params: orgParams, body: targetBody.extend({ action: z.enum(['hide', 'unhide', 'lock', 'unlock', 'pin', 'unpin']), reason: z.string().max(500).optional(), reportId: z.uuid().optional() }), summary: 'Hide, lock or pin content (moderators)' },
  }, async (req) => {
    const v = await read(req, req.params.orgId);
    const { targetType, targetId, action, reason } = req.body;
    if (targetType === 'announcement') throw validationError('Use the announcement editor for announcements');
    const { sp } = await targetSpace(v, targetType, targetId);
    if (!canModerate(v, sp)) throw forbidden('Moderators only');
    if ((action === 'lock' || action === 'unlock' || action === 'pin' || action === 'unpin') && targetType !== 'thread') throw validationError('Only threads can be locked or pinned');
    if (action === 'hide' && !reason) throw validationError('Give a reason for hiding', { reason: 'Required' });
    const now = new Date();
    if (targetType === 'thread') {
      const set = action === 'hide' ? { hiddenAt: now, hiddenReason: reason ?? null } : action === 'unhide' ? { hiddenAt: null, hiddenReason: null }
        : action === 'lock' ? { lockedAt: now } : action === 'unlock' ? { lockedAt: null } : { pinned: action === 'pin' };
      await s.db.update(communityThreads).set(set).where(eq(communityThreads.id, targetId));
    } else {
      await s.db.update(communityReplies).set(action === 'hide' ? { hiddenAt: now, hiddenReason: reason ?? null } : { hiddenAt: null, hiddenReason: null }).where(eq(communityReplies.id, targetId));
    }
    if (req.body.reportId) await s.db.update(communityReports).set({ status: 'actioned', resolvedBy: v.userId, resolvedAt: now }).where(and(eq(communityReports.id, req.body.reportId), eq(communityReports.organizationId, v.organizationId)));
    else if (action === 'hide') await s.db.update(communityReports).set({ status: 'actioned', resolvedBy: v.userId, resolvedAt: now }).where(and(eq(communityReports.targetId, targetId), eq(communityReports.status, 'open')));
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: `community.moderation_${action}`, targetType, targetId, metadata: { reason } });
    return { ok: true, action };
  });

  app.post(`${base}/reports/:id/dismiss`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [r] = await s.db.select().from(communityReports).where(and(eq(communityReports.id, req.params.id), eq(communityReports.organizationId, v.organizationId)));
    if (!r) throw notFound('Report');
    const { sp } = await targetSpace(v, r.targetType as 'thread' | 'reply', r.targetId);
    if (!canModerate(v, sp)) throw forbidden('Moderators only');
    await s.db.update(communityReports).set({ status: 'dismissed', resolvedBy: v.userId, resolvedAt: new Date() }).where(eq(communityReports.id, r.id));
    return { ok: true };
  });

  app.get(`${base}/people`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ spaceId: z.uuid().optional(), q: z.string().max(80).optional() }), summary: 'People to @mention (who can see the space)' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const pool = req.query.spaceId ? await spaceAudience(s.db, await loadSpace(v, req.query.spaceId)) : (await orgViewers(s.db, v.organizationId)).filter((x) => x.perms.has('community.read'));
    const names = await userNames(s.db, pool.map((p) => p.userId));
    const q = req.query.q?.toLowerCase();
    return { items: pool.map((p) => ({ id: p.userId, name: names.get(p.userId) ?? '' })).filter((p) => !q || p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50) };
  });

  // ───────── events ─────────

  const eventBody = z.object({
    title: z.string().trim().min(1).max(200), description: z.string().max(5000).nullable().optional(), kind: z.enum(['network_call', 'training', 'webinar', 'in_person', 'social']).default('network_call'),
    startsAt: isoDateTime, endsAt: isoDateTime, timeZone: z.string().min(1).max(64), joinUrl: httpUrl.nullable().optional(), place: z.string().max(300).nullable().optional(),
    capacity: z.number().int().min(1).max(100_000).nullable().optional(), audience: audienceSchema.default({}),
  });

  app.get(`${base}/events`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86_400_000);
    const rows = (await s.db.select().from(communityEvents).where(and(eq(communityEvents.organizationId, v.organizationId), sql`${communityEvents.endsAt} >= ${from.toISOString()}`, ...(req.query.to ? [sql`${communityEvents.startsAt} <= ${req.query.to}`] : [])))
      .orderBy(asc(communityEvents.startsAt))).filter((e) => (v.orgPerms.has('community.manage') ? true : canSeeSpace({ audience: e.audience, archivedAt: null } as Space, v)));
    const rsvps = rows.length ? await s.db.select().from(communityEventRsvps).where(inArray(communityEventRsvps.eventId, rows.map((e) => e.id))) : [];
    return {
      items: rows.map((e) => {
        const mine = rsvps.find((r) => r.eventId === e.id && r.userId === v.userId);
        const going = rsvps.filter((r) => r.eventId === e.id && r.status === 'going').length;
        return {
          id: e.id, title: e.title, description: e.description, kind: e.kind, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(), timeZone: e.timeZone, joinUrl: e.joinUrl, place: e.place,
          capacity: e.capacity, audience: audienceSummary(e.audience), cancelled: !!e.cancelledAt, going, maybe: rsvps.filter((r) => r.eventId === e.id && r.status === 'maybe').length, myRsvp: mine?.status ?? null,
          full: !!e.capacity && going >= e.capacity, canManage: v.orgPerms.has('community.manage'),
        };
      }),
    };
  });

  app.post(`${base}/events`, { schema: { tags, security: secured, params: orgParams, body: eventBody } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    if (new Date(req.body.endsAt) <= new Date(req.body.startsAt)) throw validationError('The event must end after it starts', { endsAt: 'After the start' });
    const audience = await validateAudience(s.db, v.organizationId, req.body.audience);
    const [e] = await s.db.insert(communityEvents).values({ organizationId: v.organizationId, ...req.body, startsAt: new Date(req.body.startsAt), endsAt: new Date(req.body.endsAt), audience, createdBy: v.userId }).returning();
    const ids = (await orgViewers(s.db, v.organizationId)).filter((x) => x.perms.has('community.read') && !x.hq && canSeeSpace({ audience, archivedAt: null } as Space, x)).map((x) => x.userId);
    await networkNotify(s, { organizationId: v.organizationId, userIds: ids, exclude: [v.userId], kind: 'event', title: `New event: ${e!.title}`, body: e!.startsAt.toISOString(), link: `/community?tab=events`, data: { eventId: e!.id } });
    reply.code(201);
    return { id: e!.id };
  });

  app.patch(`${base}/events/:id`, { schema: { tags, security: secured, params: idParams, body: eventBody.partial().extend({ cancelled: z.boolean().optional() }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const { cancelled, startsAt, endsAt, audience, ...rest } = req.body;
    const clean = audience ? await validateAudience(s.db, v.organizationId, audience) : undefined;
    const [e] = await s.db.update(communityEvents).set({ ...rest, ...(startsAt ? { startsAt: new Date(startsAt) } : {}), ...(endsAt ? { endsAt: new Date(endsAt) } : {}), ...(clean ? { audience: clean } : {}), ...(cancelled !== undefined ? { cancelledAt: cancelled ? new Date() : null } : {}) })
      .where(and(eq(communityEvents.id, req.params.id), eq(communityEvents.organizationId, v.organizationId))).returning();
    if (!e) throw notFound('Event');
    return { id: e.id, cancelled: !!e.cancelledAt };
  });

  app.post(`${base}/events/:id/rsvp`, { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['going', 'maybe', 'declined']) }) } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const [e] = await s.db.select().from(communityEvents).where(and(eq(communityEvents.id, req.params.id), eq(communityEvents.organizationId, v.organizationId)));
    if (!e || !canSeeSpace({ audience: e.audience, archivedAt: null } as Space, v)) throw notFound('Event');
    if (e.cancelledAt) throw conflict('event_cancelled', 'This event was cancelled');
    if (req.body.status === 'going' && e.capacity) {
      const [{ n } = { n: 0 }] = await s.db.select({ n: sql<number>`count(*)::int` }).from(communityEventRsvps).where(and(eq(communityEventRsvps.eventId, e.id), eq(communityEventRsvps.status, 'going'), sql`${communityEventRsvps.userId} <> ${v.userId}`));
      if (n >= e.capacity) throw conflict('event_full', 'This event is full');
    }
    await s.db.insert(communityEventRsvps).values({ organizationId: v.organizationId, eventId: e.id, userId: v.userId, status: req.body.status })
      .onConflictDoUpdate({ target: [communityEventRsvps.eventId, communityEventRsvps.userId], set: { status: req.body.status, updatedAt: new Date() } });
    return { status: req.body.status };
  });

  // ───────── account managers & coaching ─────────

  app.get(`${base}/account-managers`, { schema: { tags, security: secured, params: orgParams, summary: 'HQ: who looks after which franchisee' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const rows = await s.db.select({ am: accountManagers, name: users.name, email: users.email }).from(accountManagers).innerJoin(users, eq(users.id, accountManagers.userId)).where(eq(accountManagers.organizationId, v.organizationId)).orderBy(asc(users.name));
    return { items: rows.map((r) => ({ id: r.am.id, userId: r.am.userId, name: r.name, email: r.email, scopeKind: r.am.scopeKind, scopeId: r.am.scopeId, title: r.am.title, bookingUrl: r.am.bookingUrl, bio: r.am.bio, phone: r.am.phone })) };
  });

  app.post(`${base}/account-managers`, {
    schema: { tags, security: secured, params: orgParams, body: z.object({ userId: z.uuid(), scopeKind: z.enum(['region', 'owner_group', 'location']), scopeId: z.uuid(), title: z.string().max(80).nullable().optional(), bookingUrl: httpUrl.nullable().optional(), bio: z.string().max(1000).nullable().optional(), phone: z.string().max(40).nullable().optional() }) },
  }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const hq = (await orgViewers(s.db, v.organizationId)).find((x) => x.userId === req.body.userId);
    if (!hq?.hq) throw validationError('Account managers must be HQ team members', { userId: 'Not an HQ team member' });
    await validateAudience(s.db, v.organizationId, { [req.body.scopeKind === 'region' ? 'regionIds' : req.body.scopeKind === 'owner_group' ? 'ownerGroupIds' : 'locationIds']: [req.body.scopeId] });
    const [am] = await s.db.insert(accountManagers).values({ organizationId: v.organizationId, ...req.body }).onConflictDoUpdate({ target: [accountManagers.userId, accountManagers.scopeKind, accountManagers.scopeId], set: { title: req.body.title ?? null, bookingUrl: req.body.bookingUrl ?? null, bio: req.body.bio ?? null, phone: req.body.phone ?? null } }).returning();
    await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'community.account_manager_set', targetType: 'account_manager', targetId: am!.id, metadata: { scopeKind: am!.scopeKind, scopeId: am!.scopeId } });
    reply.code(201);
    return { id: am!.id };
  });

  app.patch(`${base}/account-managers/me`, { schema: { tags, security: secured, params: orgParams, body: z.object({ bookingUrl: httpUrl.nullable().optional(), bio: z.string().max(1000).nullable().optional(), title: z.string().max(80).nullable().optional(), phone: z.string().max(40).nullable().optional() }), summary: 'An account manager updates their own booking link and profile' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const rows = await s.db.update(accountManagers).set(req.body).where(and(eq(accountManagers.organizationId, v.organizationId), eq(accountManagers.userId, v.userId))).returning();
    if (!rows.length) throw notFound('Account manager profile');
    return { updated: rows.length };
  });

  app.delete(`${base}/account-managers/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const del = await s.db.delete(accountManagers).where(and(eq(accountManagers.id, req.params.id), eq(accountManagers.organizationId, v.organizationId))).returning();
    if (!del.length) throw notFound('Account manager');
    return { ok: true };
  });

  async function scopeName(kind: string, id: string) {
    const [r] = kind === 'owner_group' ? await s.db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, id)) : await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, id));
    return r?.name ?? '';
  }

  app.get(`${base}/coaching`, { schema: { tags, security: secured, params: orgParams, summary: 'Private 1:1 threads with HQ contacts (franchisee) or with the franchisees you look after (account manager)' } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const all = await s.db.select().from(coachingThreads).where(eq(coachingThreads.organizationId, v.organizationId)).orderBy(desc(sql`coalesce(${coachingThreads.lastMessageAt}, ${coachingThreads.createdAt})`));
    const mine = all.filter((t) => t.managerUserId === v.userId || franchiseeScopes(v).some((sc) => sc.kind === t.scopeKind && sc.id === t.scopeId));
    const names = await userNames(s.db, mine.map((t) => t.managerUserId));
    const items = [];
    for (const t of mine) {
      const [last] = await s.db.select().from(coachingMessages).where(eq(coachingMessages.threadId, t.id)).orderBy(desc(coachingMessages.createdAt)).limit(1);
      items.push({ id: t.id, scopeKind: t.scopeKind, scopeId: t.scopeId, scopeName: await scopeName(t.scopeKind, t.scopeId), manager: { id: t.managerUserId, name: names.get(t.managerUserId) ?? '' }, iAmManager: t.managerUserId === v.userId, lastMessage: last ? { body: last.body.slice(0, 160), at: last.createdAt.toISOString(), mine: last.authorId === v.userId } : null });
    }
    // Contacts the franchisee has no thread with yet.
    const managers = await managersFor(s.db, v);
    const scopes = franchiseeScopes(v);
    const available = scopes.length ? managers.filter((m) => !mine.some((t) => t.managerUserId === m.am.userId)).map((m) => ({ userId: m.am.userId, name: m.name, bookingUrl: m.am.bookingUrl })) : [];
    return { items, available };
  });

  app.post(`${base}/coaching`, { schema: { tags, security: secured, params: orgParams, body: z.object({ managerUserId: z.uuid().optional(), scopeKind: z.enum(['owner_group', 'location']).optional(), scopeId: z.uuid().optional(), body: z.string().trim().min(1).max(10_000) }), summary: 'Start (or continue) a private thread' } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    let scope: { kind: 'owner_group' | 'location'; id: string };
    let managerUserId: string;
    const myScopes = franchiseeScopes(v);
    if (req.body.managerUserId && myScopes.length) {
      // Franchisee side: one of their HQ contacts, about their own owner group / location.
      const managers = await managersFor(s.db, v);
      if (!managers.some((m) => m.am.userId === req.body.managerUserId)) throw notFound('Account manager');
      scope = req.body.scopeKind && req.body.scopeId ? { kind: req.body.scopeKind, id: req.body.scopeId } : myScopes[0]!;
      if (!myScopes.some((x) => x.kind === scope.kind && x.id === scope.id)) throw forbidden('That is not one of your businesses');
      managerUserId = req.body.managerUserId;
    } else {
      // Account manager side: a franchisee they look after.
      if (!req.body.scopeKind || !req.body.scopeId) throw validationError('Choose the franchisee', { scopeId: 'Required' });
      const own = await s.db.select().from(accountManagers).where(and(eq(accountManagers.organizationId, v.organizationId), eq(accountManagers.userId, v.userId)));
      const [loc] = req.body.scopeKind === 'location' ? await s.db.select().from(locations).where(and(eq(locations.id, req.body.scopeId), eq(locations.organizationId, v.organizationId))) : [];
      const covers = own.some((am) => (am.scopeKind === req.body.scopeKind && am.scopeId === req.body.scopeId) || (loc && ((am.scopeKind === 'region' && am.scopeId === loc.regionId) || (am.scopeKind === 'owner_group' && am.scopeId === loc.ownerGroupId))));
      if (!covers) throw forbidden('You are not the account manager for this franchisee');
      scope = { kind: req.body.scopeKind, id: req.body.scopeId };
      managerUserId = v.userId;
    }
    const now = new Date();
    const [t] = await s.db.insert(coachingThreads).values({ organizationId: v.organizationId, scopeKind: scope.kind, scopeId: scope.id, managerUserId, lastMessageAt: now })
      .onConflictDoUpdate({ target: [coachingThreads.organizationId, coachingThreads.scopeKind, coachingThreads.scopeId, coachingThreads.managerUserId], set: { lastMessageAt: now } }).returning();
    await s.db.insert(coachingMessages).values({ organizationId: v.organizationId, threadId: t!.id, authorId: v.userId, body: req.body.body });
    await notifyCoaching(t!, v, req.body.body);
    reply.code(201);
    return { id: t!.id };
  });

  async function notifyCoaching(t: typeof coachingThreads.$inferSelect, v: Viewer, body: string) {
    const others = (await orgViewers(s.db, v.organizationId)).filter((x) => x.userId !== v.userId && (x.userId === t.managerUserId || franchiseeScopes(x).some((sc) => sc.kind === t.scopeKind && sc.id === t.scopeId))).map((x) => x.userId);
    const [me] = await s.db.select({ name: users.name }).from(users).where(eq(users.id, v.userId));
    await networkNotify(s, { organizationId: v.organizationId, userIds: others, kind: 'coaching', title: `Message from ${me?.name ?? ''}`, body: body.slice(0, 160), link: `/community?coaching=${t.id}`, data: { threadId: t.id } });
  }

  async function loadCoaching(v: Viewer, id: string) {
    const [t] = await s.db.select().from(coachingThreads).where(and(eq(coachingThreads.id, id), eq(coachingThreads.organizationId, v.organizationId)));
    if (!t || !canSeeCoaching(t, v)) throw notFound('Conversation');
    return t;
  }

  app.get(`${base}/coaching/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await read(req, req.params.orgId);
    const t = await loadCoaching(v, req.params.id);
    const msgs = await s.db.select().from(coachingMessages).where(eq(coachingMessages.threadId, t.id)).orderBy(asc(coachingMessages.createdAt));
    const names = await userNames(s.db, [t.managerUserId, ...msgs.map((m) => m.authorId)]);
    const [am] = await s.db.select().from(accountManagers).where(and(eq(accountManagers.organizationId, v.organizationId), eq(accountManagers.userId, t.managerUserId))).limit(1);
    return {
      id: t.id, scopeKind: t.scopeKind, scopeId: t.scopeId, scopeName: await scopeName(t.scopeKind, t.scopeId), manager: { id: t.managerUserId, name: names.get(t.managerUserId) ?? '', bookingUrl: am?.bookingUrl ?? null, title: am?.title ?? null },
      messages: msgs.map((m) => ({ id: m.id, body: m.body, attachments: m.attachments, author: m.authorId ? { id: m.authorId, name: names.get(m.authorId) ?? '' } : null, mine: m.authorId === v.userId, createdAt: m.createdAt.toISOString() })),
    };
  });

  app.post(`${base}/coaching/:id/messages`, { schema: { tags, security: secured, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000), attachments: attachmentsSchema }) } }, async (req, reply) => {
    const v = await read(req, req.params.orgId);
    const t = await loadCoaching(v, req.params.id);
    if (t.managerUserId !== v.userId && !franchiseeScopes(v).some((sc) => sc.kind === t.scopeKind && sc.id === t.scopeId)) throw forbidden('Only the people in this conversation can write here');
    const [m] = await s.db.insert(coachingMessages).values({ organizationId: v.organizationId, threadId: t.id, authorId: v.userId, body: req.body.body, attachments: req.body.attachments }).returning();
    await s.db.update(coachingThreads).set({ lastMessageAt: m!.createdAt }).where(eq(coachingThreads.id, t.id));
    await notifyCoaching(t, v, req.body.body);
    reply.code(201);
    return { id: m!.id, createdAt: m!.createdAt.toISOString() };
  });

  // ───────── notifications & preferences ─────────

  app.get(`${base}/notifications`, { schema: { tags, security: secured, params: orgParams, querystring: z.object({ unread: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(100).default(30) }) } }, async (req) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    const rows = await s.db.select().from(networkNotifications).where(and(eq(networkNotifications.organizationId, v.organizationId), eq(networkNotifications.userId, v.userId), ...(req.query.unread ? [isNull(networkNotifications.readAt)] : [])))
      .orderBy(desc(networkNotifications.createdAt)).limit(req.query.limit);
    return { items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, data: n.data, readAt: iso(n.readAt), createdAt: n.createdAt.toISOString() })) };
  });

  app.post(`${base}/notifications/read`, { schema: { tags, security: secured, params: orgParams, body: z.object({ ids: z.array(z.uuid()).max(200).optional() }) } }, async (req) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    const rows = await s.db.update(networkNotifications).set({ readAt: new Date() })
      .where(and(eq(networkNotifications.organizationId, v.organizationId), eq(networkNotifications.userId, v.userId), isNull(networkNotifications.readAt), ...(req.body.ids?.length ? [inArray(networkNotifications.id, req.body.ids)] : []))).returning({ id: networkNotifications.id });
    return { marked: rows.length };
  });

  const prefsBody = z.object({ inApp: z.boolean(), push: z.boolean(), emailDigest: z.enum(['off', 'daily', 'weekly']), mutedKinds: z.array(z.string().max(40)).max(30), mutedSpaceIds: z.array(z.uuid()).max(200) });
  app.get(`${base}/notification-prefs`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    const [p] = await s.db.select().from(networkNotificationPrefs).where(and(eq(networkNotificationPrefs.organizationId, v.organizationId), eq(networkNotificationPrefs.userId, v.userId)));
    const { inApp, push, emailDigest, mutedKinds, mutedSpaceIds } = p ?? DEFAULT_PREFS;
    return { inApp, push, emailDigest, mutedKinds, mutedSpaceIds };
  });
  app.put(`${base}/notification-prefs`, { schema: { tags, security: secured, params: orgParams, body: prefsBody } }, async (req) => {
    const v = await viewerFor(req, s.db, req.params.orgId);
    await s.db.insert(networkNotificationPrefs).values({ organizationId: v.organizationId, userId: v.userId, ...req.body })
      .onConflictDoUpdate({ target: [networkNotificationPrefs.organizationId, networkNotificationPrefs.userId], set: { ...req.body, updatedAt: new Date() } });
    return req.body;
  });
};
