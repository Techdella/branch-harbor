import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { cannedReplies, helpdeskCategories, helpdeskSettings, locations, organizations, libraryResources, ticketMessages, tickets, users } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { addTicketMessage, agentIds, canSeeTicket, createTicket, ensureSettings, isAgent, PRIORITIES, slaState, slaTargets, statusPatch, STATUSES, type Ticket } from '../services/helpdesk.ts';
import { orgViewers, requireNetworkPerm, userNames, viewerFor, type Viewer } from '../services/network-access.ts';
import { networkNotify } from '../services/network-notify.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';
import { attachmentsSchema } from './network-common.ts';

const tags = ['helpdesk'];
const INBOUND_DOMAIN = 'inbound.branchharbor.com';

export const helpdeskRoutes: FastifyPluginAsyncZod = async (_root) => {
  const root = _root.withTypeProvider<ZodTypeProvider>();
  const s = root.ctx;

  /**
   * Email-in hook (sandbox): the inbound email provider (Postmark / SES / Resend inbound) posts parsed emails here.
   * The address is support+<org-slug>.<token>@inbound…; "[#1234]" in the subject threads a reply onto that ticket.
   */
  root.post('/helpdesk/inbound-email', {
    schema: {
      tags, summary: 'Inbound email → ticket (sandbox hook for the inbound email provider)',
      body: z.object({ to: z.string().min(3).max(300), from: z.email().max(200), fromName: z.string().max(200).optional(), subject: z.string().max(300).default(''), text: z.string().min(1).max(50_000) }),
    },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const m = /support\+([a-z0-9-]+)\.([a-z0-9x]+)@/i.exec(req.body.to);
    if (!m) throw notFound('Mailbox');
    const [org] = await s.db.select().from(organizations).where(eq(organizations.slug, m[1]!.toLowerCase()));
    const [settings] = org ? await s.db.select().from(helpdeskSettings).where(eq(helpdeskSettings.organizationId, org.id)) : [];
    if (!org || !settings || settings.inboundToken !== m[2]!.toLowerCase()) throw notFound('Mailbox');
    const from = req.body.from.toLowerCase();
    const [u] = await s.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${from}`);
    const member = u ? (await orgViewers(s.db, org.id)).find((v) => v.userId === u.id) : undefined;
    const num = /\[#(\d+)\]/.exec(req.body.subject);
    if (num) {
      const [t] = await s.db.select().from(tickets).where(and(eq(tickets.organizationId, org.id), eq(tickets.number, Number(num[1]))));
      const allowed = t && ((member && canSeeTicket(t, member)) || (!t.requesterId && t.requesterEmail === from));
      if (t && allowed) {
        const r = await addTicketMessage(s, t, { userId: member?.userId ?? null, email: from, agent: !!member && isAgent(member) }, { body: req.body.text, internal: false });
        reply.code(201);
        return { ticketId: t.id, number: t.number, threaded: true, messageId: r.message.id };
      }
    }
    // Only network members can open tickets by email (anyone else would let strangers into HQ's queue).
    if (!member) throw forbidden('Only members of this network can email the help desk');
    const t = await createTicket(s, { organizationId: org.id, requesterId: member.userId, requesterEmail: from, locationId: [...member.locationIds][0] ?? null, subject: req.body.subject.replace(/\[#\d+\]/, '').trim() || '(no subject)', body: req.body.text, priority: 'normal', channel: 'email' });
    reply.code(201);
    return { ticketId: t.id, number: t.number, threaded: false };
  });

  await root.register(async (_app) => {
    const app = _app.withTypeProvider<ZodTypeProvider>();
    app.addHook('preHandler', authenticate);
    const base = '/orgs/:orgId/helpdesk';
    const member = async (req: Parameters<typeof viewerFor>[0], orgId: string) => {
      const v = await viewerFor(req, s.db, orgId);
      if (!v.perms.has('helpdesk.raise') && !isAgent(v)) requireNetworkPerm(v, 'helpdesk.raise');
      return v;
    };

    async function serializeTickets(rows: Ticket[], v: Viewer) {
      const names = await userNames(s.db, rows.flatMap((t) => [t.requesterId, t.assigneeId]));
      const cats = rows.length ? await s.db.select().from(helpdeskCategories).where(inArray(helpdeskCategories.id, rows.map((t) => t.categoryId).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000']))) : [];
      const locs = rows.length ? await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, rows.map((t) => t.locationId).filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000']))) : [];
      const cm = new Map(cats.map((c) => [c.id, c.name]));
      const lm = new Map(locs.map((l) => [l.id, l.name]));
      const now = new Date();
      return rows.map((t) => ({
        id: t.id, number: t.number, subject: t.subject, priority: t.priority, status: t.status, channel: t.channel,
        category: t.categoryId ? { id: t.categoryId, name: cm.get(t.categoryId) ?? '' } : null, location: t.locationId ? { id: t.locationId, name: lm.get(t.locationId) ?? '' } : null,
        requester: { id: t.requesterId, name: t.requesterId ? names.get(t.requesterId) ?? '' : t.requesterEmail ?? '' }, assignee: t.assigneeId ? { id: t.assigneeId, name: names.get(t.assigneeId) ?? '' } : null,
        sla: isAgent(v) || t.requesterId === v.userId ? slaState(t, now) : null, satisfaction: t.satisfaction, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), resolvedAt: iso(t.resolvedAt),
      }));
    }

    app.get(`${base}/overview`, { schema: { tags, security: secured, params: orgParams, summary: 'Categories, agents, canned replies, the email-in address and queue counts' } }, async (req) => {
      const v = await member(req, req.params.orgId);
      const cats = await s.db.select().from(helpdeskCategories).where(and(eq(helpdeskCategories.organizationId, v.organizationId), sql`${helpdeskCategories.archivedAt} is null`)).orderBy(asc(helpdeskCategories.position), asc(helpdeskCategories.name));
      const agent = isAgent(v);
      const settings = agent ? await ensureSettings(s.db, v.organizationId) : null;
      const [org] = await s.db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, v.organizationId));
      const agents = agent ? await agentIds(s.db, v.organizationId) : [];
      const names = await userNames(s.db, agents);
      const counts = agent ? await s.db.select({ status: tickets.status, n: sql<number>`count(*)::int` }).from(tickets).where(eq(tickets.organizationId, v.organizationId)).groupBy(tickets.status) : [];
      const open = agent ? await s.db.select().from(tickets).where(and(eq(tickets.organizationId, v.organizationId), inArray(tickets.status, ['open', 'pending', 'on_hold']))) : [];
      const now = new Date();
      const states = open.map((t) => slaState(t, now));
      const [csat] = agent ? await s.db.select({ avg: sql<number | null>`round(avg(${tickets.satisfaction})::numeric, 1)::float`, n: sql<number>`count(${tickets.satisfaction})::int` }).from(tickets).where(eq(tickets.organizationId, v.organizationId)) : [];
      return {
        agent,
        categories: cats.map((c) => ({ id: c.id, name: c.name, firstResponseMinutes: c.firstResponseMinutes, resolutionMinutes: c.resolutionMinutes, defaultAssigneeId: c.defaultAssigneeId })),
        agents: agents.map((id) => ({ id, name: names.get(id) ?? '' })),
        inboundAddress: settings && org ? `support+${org.slug}.${settings.inboundToken}@${INBOUND_DOMAIN}` : null,
        counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        sla: agent ? { breached: states.filter((x) => x.firstResponse.state === 'breached' || x.resolution.state === 'breached').length, atRisk: states.filter((x) => x.firstResponse.state === 'at_risk' || x.resolution.state === 'at_risk').length } : null,
        satisfaction: csat?.n ? { average: csat.avg, responses: csat.n } : null,
        myLocations: (await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, v.organizationId))).filter((l) => agent || v.locationIds.has(l.id)),
      };
    });

    app.get(`${base}/tickets`, {
      schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['active', 'all', ...STATUSES]).default('active'), mine: z.coerce.boolean().default(false), assignee: z.enum(['me', 'unassigned', 'any']).default('any'), q: z.string().max(100).optional() }) },
    }, async (req) => {
      const v = await member(req, req.params.orgId);
      const st = req.query.status === 'active' ? ['open', 'pending', 'on_hold'] : req.query.status === 'all' ? [...STATUSES] : [req.query.status];
      let rows = await s.db.select().from(tickets).where(and(eq(tickets.organizationId, v.organizationId), inArray(tickets.status, st), ...(req.query.q ? [sql`(${tickets.subject} ilike ${`%${req.query.q}%`} or ${tickets.number}::text = ${req.query.q.replace('#', '')})`] : [])))
        .orderBy(desc(tickets.updatedAt)).limit(500);
      rows = rows.filter((t) => canSeeTicket(t, v));
      if (req.query.mine || !isAgent(v)) rows = req.query.mine ? rows.filter((t) => t.requesterId === v.userId) : rows;
      if (req.query.assignee === 'me') rows = rows.filter((t) => t.assigneeId === v.userId);
      if (req.query.assignee === 'unassigned') rows = rows.filter((t) => !t.assigneeId);
      const prio = { urgent: 0, high: 1, normal: 2, low: 3 } as Record<string, number>;
      if (isAgent(v)) rows.sort((a, b) => (prio[a.priority]! - prio[b.priority]!) || ((a.resolutionDueAt?.getTime() ?? 0) - (b.resolutionDueAt?.getTime() ?? 0)));
      return { items: await serializeTickets(rows, v) };
    });

    app.post(`${base}/tickets`, {
      schema: { tags, security: secured, params: orgParams, body: z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(1).max(20_000), categoryId: z.uuid().nullable().optional(), priority: z.enum(PRIORITIES).default('normal'), locationId: z.uuid().nullable().optional(), attachments: attachmentsSchema, channel: z.enum(['web', 'mobile']).default('web') }) },
    }, async (req, reply) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.raise');
      if (req.body.locationId && !v.hq && !v.locationIds.has(req.body.locationId)) throw forbidden('You can only raise tickets for your own locations');
      const locationId = req.body.locationId ?? (v.locationIds.size === 1 ? [...v.locationIds][0]! : null);
      const [u] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, v.userId));
      const t = await createTicket(s, { organizationId: v.organizationId, requesterId: v.userId, requesterEmail: u?.email ?? null, locationId, categoryId: req.body.categoryId ?? null, subject: req.body.subject, body: req.body.body, priority: req.body.priority, channel: req.body.channel, attachments: req.body.attachments });
      reply.code(201);
      return (await serializeTickets([t], v))[0];
    });

    async function load(v: Viewer, id: string) {
      const [t] = await s.db.select().from(tickets).where(and(eq(tickets.id, id), eq(tickets.organizationId, v.organizationId)));
      if (!t || !canSeeTicket(t, v)) throw notFound('Ticket');
      return t;
    }

    app.get(`${base}/tickets/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await member(req, req.params.orgId);
      const t = await load(v, req.params.id);
      const agent = isAgent(v);
      const msgs = (await s.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, t.id)).orderBy(asc(ticketMessages.createdAt))).filter((m) => agent || !m.internal);
      const names = await userNames(s.db, msgs.map((m) => m.authorId));
      const agentSet = new Set(await agentIds(s.db, v.organizationId));
      const [ticket] = await serializeTickets([t], v);
      // Suggested knowledge base articles for the subject (agents paste a link; requesters may self-serve).
      const kb = await s.db.select({ id: libraryResources.id, title: libraryResources.title }).from(libraryResources)
        .where(and(eq(libraryResources.organizationId, v.organizationId), eq(libraryResources.kind, 'kb_article'), sql`${libraryResources.archivedAt} is null`, sql`to_tsvector('simple', ${libraryResources.title} || ' ' || coalesce(${libraryResources.body}, '')) @@ websearch_to_tsquery('simple', ${t.subject.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(' or ') || t.subject})`)).limit(3);
      return {
        ticket: { ...ticket, satisfactionComment: t.satisfactionComment, firstRespondedAt: iso(t.firstRespondedAt), closedAt: iso(t.closedAt) },
        messages: msgs.map((m) => ({ id: m.id, body: m.body, internal: m.internal, attachments: m.attachments, author: m.authorId ? { id: m.authorId, name: names.get(m.authorId) ?? '', hq: agentSet.has(m.authorId) } : { id: null, name: m.authorEmail ?? '', hq: false }, mine: m.authorId === v.userId, createdAt: m.createdAt.toISOString() })),
        canManage: agent, canRate: t.requesterId === v.userId && (t.status === 'resolved' || t.status === 'closed'), suggestions: kb,
      };
    });

    app.post(`${base}/tickets/:id/messages`, { schema: { tags, security: secured, params: idParams, body: z.object({ body: z.string().trim().min(1).max(20_000), internal: z.boolean().default(false), attachments: attachmentsSchema, status: z.enum(STATUSES).optional() }) } }, async (req, reply) => {
      const v = await member(req, req.params.orgId);
      const t = await load(v, req.params.id);
      const agent = isAgent(v);
      if (!agent && t.requesterId !== v.userId && !(t.locationId && v.locationIds.has(t.locationId))) throw forbidden('You cannot reply to this ticket');
      if (req.body.status && !agent && !['resolved', 'open'].includes(req.body.status)) throw forbidden('Only HQ can change the status');
      const r = await addTicketMessage(s, t, { userId: v.userId, agent }, req.body);
      reply.code(201);
      return { id: r.message.id, ticket: (await serializeTickets([r.ticket], v))[0] };
    });

    app.patch(`${base}/tickets/:id`, {
      schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), assigneeId: z.uuid().nullable().optional(), categoryId: z.uuid().nullable().optional() }), summary: 'HQ: status, priority (recalculates SLA targets), assignment, category' },
    }, async (req) => {
      const v = await member(req, req.params.orgId);
      const t = await load(v, req.params.id);
      const agent = isAgent(v);
      const b = req.body;
      // Requesters may only close their own resolved ticket or reopen it.
      if (!agent && (b.priority || b.assigneeId !== undefined || b.categoryId !== undefined || (b.status && !(t.requesterId === v.userId && ['closed', 'open'].includes(b.status))))) throw forbidden('Only HQ can change this ticket');
      if (b.assigneeId) {
        const agents = await agentIds(s.db, v.organizationId);
        if (!agents.includes(b.assigneeId)) throw validationError('Tickets can only be assigned to HQ help desk agents', { assigneeId: 'Not an agent' });
      }
      let patch: Partial<Ticket> = { updatedAt: new Date() };
      if (b.status) patch = { ...patch, ...statusPatch(t, b.status) };
      if (b.priority && b.priority !== t.priority) {
        const [cat] = t.categoryId ? await s.db.select().from(helpdeskCategories).where(eq(helpdeskCategories.id, t.categoryId)) : [];
        const due = slaTargets(b.priority, cat ?? null, t.createdAt);
        patch = { ...patch, priority: b.priority, resolutionDueAt: due.resolutionDueAt, ...(t.firstRespondedAt ? {} : { firstResponseDueAt: due.firstResponseDueAt }), breachNotifiedAt: null };
      }
      if (b.categoryId !== undefined) {
        if (b.categoryId) {
          const [cat] = await s.db.select().from(helpdeskCategories).where(and(eq(helpdeskCategories.id, b.categoryId), eq(helpdeskCategories.organizationId, v.organizationId)));
          if (!cat) throw validationError('Unknown category', { categoryId: 'Unknown category' });
        }
        patch.categoryId = b.categoryId;
      }
      if (b.assigneeId !== undefined) patch.assigneeId = b.assigneeId;
      const [u] = await s.db.update(tickets).set(patch).where(eq(tickets.id, t.id)).returning();
      if (b.assigneeId && b.assigneeId !== t.assigneeId) await networkNotify(s, { organizationId: v.organizationId, userIds: [b.assigneeId], exclude: [v.userId], kind: 'ticket_assigned', title: `#${t.number} ${t.subject}`, body: 'Assigned to you', link: `/help?ticket=${t.id}`, data: { ticketId: t.id } });
      if (b.status && b.status !== t.status && (b.status === 'resolved') && t.requesterId) await networkNotify(s, { organizationId: v.organizationId, userIds: [t.requesterId], exclude: [v.userId], kind: 'ticket_reply', title: `Resolved: #${t.number} ${t.subject}`, body: 'Tell us how we did.', link: `/help?ticket=${t.id}`, data: { ticketId: t.id } });
      await audit(s.db, { organizationId: v.organizationId, ...actor(req), action: 'helpdesk.ticket_updated', targetType: 'ticket', targetId: t.id, metadata: b });
      return (await serializeTickets([u!], v))[0];
    });

    app.post(`${base}/tickets/:id/rating`, { schema: { tags, security: secured, params: idParams, body: z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() }), summary: 'Requester: satisfaction rating after resolution' } }, async (req) => {
      const v = await member(req, req.params.orgId);
      const t = await load(v, req.params.id);
      if (t.requesterId !== v.userId) throw forbidden('Only the person who raised the ticket can rate it');
      if (t.status !== 'resolved' && t.status !== 'closed') throw conflict('not_resolved', 'You can rate the help once the ticket is resolved');
      const [u] = await s.db.update(tickets).set({ satisfaction: req.body.score, satisfactionComment: req.body.comment ?? null, ...statusPatch(t, 'closed'), updatedAt: new Date() }).where(eq(tickets.id, t.id)).returning();
      return { satisfaction: u!.satisfaction, status: u!.status };
    });

    // ── settings: categories & canned replies (agents) ──
    const catBody = z.object({ name: z.string().trim().min(1).max(80), firstResponseMinutes: z.number().int().min(5).max(43_200).default(240), resolutionMinutes: z.number().int().min(15).max(129_600).default(2880), defaultAssigneeId: z.uuid().nullable().optional(), position: z.number().int().min(0).max(1000).default(0) });
    app.post(`${base}/categories`, { schema: { tags, security: secured, params: orgParams, body: catBody } }, async (req, reply) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.agent', { orgWide: true });
      if (req.body.defaultAssigneeId && !(await agentIds(s.db, v.organizationId)).includes(req.body.defaultAssigneeId)) throw validationError('Default assignee must be an agent', { defaultAssigneeId: 'Not an agent' });
      const [c] = await s.db.insert(helpdeskCategories).values({ organizationId: v.organizationId, ...req.body }).returning();
      reply.code(201);
      return { id: c!.id, name: c!.name };
    });
    app.patch(`${base}/categories/:id`, { schema: { tags, security: secured, params: idParams, body: catBody.partial().extend({ archived: z.boolean().optional() }) } }, async (req) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.agent', { orgWide: true });
      const { archived, ...rest } = req.body;
      const [c] = await s.db.update(helpdeskCategories).set({ ...rest, ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}) }).where(and(eq(helpdeskCategories.id, req.params.id), eq(helpdeskCategories.organizationId, v.organizationId))).returning();
      if (!c) throw notFound('Category');
      return { id: c.id, name: c.name };
    });

    app.get(`${base}/canned-replies`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.agent', { orgWide: true });
      const rows = await s.db.select().from(cannedReplies).where(eq(cannedReplies.organizationId, v.organizationId)).orderBy(asc(cannedReplies.title));
      return { items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body })) };
    });
    app.post(`${base}/canned-replies`, { schema: { tags, security: secured, params: orgParams, body: z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(10_000) }) } }, async (req, reply) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.agent', { orgWide: true });
      const [r] = await s.db.insert(cannedReplies).values({ organizationId: v.organizationId, ...req.body, createdBy: v.userId }).returning();
      reply.code(201);
      return { id: r!.id, title: r!.title, body: r!.body };
    });
    app.delete(`${base}/canned-replies/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const v = await member(req, req.params.orgId);
      requireNetworkPerm(v, 'helpdesk.agent', { orgWide: true });
      await s.db.delete(cannedReplies).where(and(eq(cannedReplies.id, req.params.id), eq(cannedReplies.organizationId, v.organizationId)));
      return { ok: true };
    });
  });
};
