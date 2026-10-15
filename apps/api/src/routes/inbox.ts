import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { CONVERSATION_STATUSES, INBOX_CHANNELS, marketingConsentPurpose, type InboxChannelKey, segmentRulesSchema } from '@bh/shared';
import {
  commsCannedReplies, commsChannelAccounts, commsConversations, commsMessages, commsWhatsappTemplates, consentRecords, contactSegments, contactTags, customers, leads, locations, users,
} from '../db/schema/index.ts';
import { buildSandboxWebhook, channelLive } from '../integrations/comms-channels.ts';
import { encrypt, randomToken } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { addNote, handleCommsWebhook, isOptedOut, marketingConsent, replyPolicy, sendInConversation, serializeConversations, serializeMessages } from '../services/comms-inbox.ts';
import { hasAt, inScope, requireAnyAt, requireAt, scopeFor, usersWithCapabilityAt } from '../services/comms-scope.ts';
import { segmentMembers } from '../services/segments.ts';
import { idParams, orgParams, secured } from './_common.ts';

const channel = z.enum(INBOX_CHANNELS);
const M = 'marketing.inbox';
const segmentRules = segmentRulesSchema;

/**
 * Unified inbox (one per location, plus HQ), canned replies, WhatsApp templates, contacts with tags and per-channel
 * consent, segments and consent-aware broadcasts. A location sees only its own inbox; organisation-wide holders of
 * Inbox see HQ and every location, optionally narrowed to chosen locations.
 */
export const inboxRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const loadConv = async (orgId: string, id: string) => {
    const [c] = await s.db.select().from(commsConversations).where(and(eq(commsConversations.id, id), eq(commsConversations.organizationId, orgId)));
    if (!c) throw notFound('Conversation');
    return c;
  };
  const loadAccount = async (orgId: string, id: string) => {
    const [a] = await s.db.select().from(commsChannelAccounts).where(and(eq(commsChannelAccounts.id, id), eq(commsChannelAccounts.organizationId, orgId)));
    if (!a) throw notFound('Channel');
    return a;
  };
  const checkLocation = async (orgId: string, locationId: string | null | undefined) => {
    if (!locationId) return null;
    const [l] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
    if (!l) throw notFound('Location');
    return l;
  };
  const serializeAccount = (a: typeof commsChannelAccounts.$inferSelect) => ({ id: a.id, locationId: a.locationId, channel: a.channel, address: a.address, displayName: a.displayName, mode: a.mode, active: a.active, createdAt: a.createdAt.toISOString() });

  /* ── channels ── */

  app.get('/orgs/:orgId/inbox/channels', { schema: { tags: ['inbox'], security: secured, params: orgParams, summary: 'Inbox channels (numbers, pages, addresses) you can see' } }, async (req) => {
    const scope = await scopeFor(req, s.db, req.params.orgId, M);
    const rows = await s.db.select().from(commsChannelAccounts).where(eq(commsChannelAccounts.organizationId, req.params.orgId)).orderBy(asc(commsChannelAccounts.channel));
    return { items: rows.filter((a) => inScope(scope, a.locationId)).map(serializeAccount), hq: scope.hq };
  });

  app.post('/orgs/:orgId/inbox/channels', {
    schema: {
      tags: ['inbox'], security: secured, params: orgParams,
      summary: 'Connect a channel to a location inbox (or HQ when locationId is null). Live when provider credentials exist; otherwise sandbox.',
      body: z.object({ channel, locationId: z.uuid().nullable().default(null), address: z.string().trim().min(2).max(200), displayName: z.string().trim().min(1).max(120), pageToken: z.string().min(10).max(1000).optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await checkLocation(orgId, b.locationId);
    await requireAt(req, s.db, orgId, b.locationId, M, 'edit');
    const address = b.channel === 'email' ? b.address.toLowerCase() : b.address;
    const [dup] = await s.db.select({ id: commsChannelAccounts.id }).from(commsChannelAccounts).where(and(eq(commsChannelAccounts.channel, b.channel), eq(commsChannelAccounts.address, address)));
    if (dup) throw conflict('channel_in_use', 'This address is already connected to an inbox');
    const live = channelLive(s, b.channel, !!b.pageToken);
    const [a] = await s.db.insert(commsChannelAccounts).values({
      organizationId: orgId, locationId: b.locationId, channel: b.channel, address, displayName: b.displayName, mode: live ? 'live' : 'sandbox',
      credentialsEncrypted: b.pageToken ? encrypt(b.pageToken, s.cfg.ENCRYPTION_KEY) : null, createdBy: req.user!.id,
    }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'inbox.channel_connected', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'channel', targetId: a!.id, metadata: { channel: b.channel, mode: a!.mode } });
    return reply.code(201).send(serializeAccount(a!));
  });

  app.post('/orgs/:orgId/inbox/channels/:id/simulate', {
    schema: {
      tags: ['inbox'], security: secured, params: idParams,
      summary: 'Sandbox only: simulate an inbound message. It is signed like the provider would and goes through the same webhook verification and idempotency.',
      body: z.object({ from: z.string().trim().min(2).max(200), name: z.string().trim().max(120).optional(), body: z.string().trim().min(1).max(4000), subject: z.string().max(200).optional(), messageId: z.string().max(120).optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const a = await loadAccount(orgId, id);
    await requireAt(req, s.db, orgId, a.locationId, M, 'edit');
    if (a.mode !== 'sandbox') throw conflict('channel_live', 'Simulation is only available on sandbox channels');
    const w = buildSandboxWebhook(s.cfg, { channel: a.channel, to: a.address, from: a.channel === 'email' ? req.body.from.toLowerCase() : req.body.from, name: req.body.name ?? null, subject: req.body.subject ?? null, body: req.body.body, id: req.body.messageId ?? `sim_${randomToken(12)}` });
    return handleCommsWebhook(s, w.provider, w.raw, w.headers);
  });

  /* ── conversations ── */

  app.get('/orgs/:orgId/inbox/conversations', {
    schema: {
      tags: ['inbox'], security: secured, params: orgParams,
      summary: 'Conversations in the inboxes you can see. `inbox=hq` for HQ only; `locationIds` to choose locations.',
      querystring: z.object({
        status: z.enum([...CONVERSATION_STATUSES, 'all']).default('open'), channel: channel.optional(), inbox: z.enum(['all', 'hq']).default('all'),
        locationIds: z.string().optional(), assigned: z.enum(['me', 'unassigned', 'any']).default('any'), q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    const scope = await scopeFor(req, s.db, orgId, M);
    const q = req.query;
    const conds: SQL[] = [eq(commsConversations.organizationId, orgId)];
    const chosen = q.locationIds ? q.locationIds.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)) : null;
    if (q.inbox === 'hq') {
      if (!scope.hq) return { items: [], hq: false };
      conds.push(isNull(commsConversations.locationId));
    } else if (chosen) {
      const allowed = scope.all ? chosen : chosen.filter((x) => scope.locationIds!.includes(x));
      conds.push(allowed.length ? inArray(commsConversations.locationId, allowed) : sql`false`);
    } else if (!scope.all) {
      conds.push(scope.locationIds!.length ? inArray(commsConversations.locationId, scope.locationIds!) : sql`false`);
    }
    if (q.channel) conds.push(eq(commsConversations.channel, q.channel));
    if (q.assigned === 'me') conds.push(eq(commsConversations.assignedUserId, me.id));
    if (q.assigned === 'unassigned') conds.push(isNull(commsConversations.assignedUserId));
    if (q.q) conds.push(sql`(${commsConversations.contactName} ilike ${'%' + q.q + '%'} or ${commsConversations.handle} ilike ${'%' + q.q + '%'} or ${commsConversations.lastMessagePreview} ilike ${'%' + q.q + '%'})`);
    const counts = await s.db.select({ status: commsConversations.status, n: sql<number>`count(*)::int`, overdue: sql<number>`(count(*) filter (where ${commsConversations.replyDueAt} < now()))::int` })
      .from(commsConversations).where(and(...conds)).groupBy(commsConversations.status);
    if (q.status !== 'all') conds.push(eq(commsConversations.status, q.status));
    const rows = await s.db.select().from(commsConversations).where(and(...conds)).orderBy(desc(commsConversations.lastMessageAt)).limit(q.limit);
    return { items: await serializeConversations(s.db, rows), hq: scope.hq, counts };
  });

  app.get('/orgs/:orgId/inbox/conversations/:id', { schema: { tags: ['inbox'], security: secured, params: idParams, summary: 'A conversation with its messages, notes and what a reply needs (window, template, consent)' } }, async (req) => {
    const { orgId, id } = req.params;
    const c = await loadConv(orgId, id);
    await requireAt(req, s.db, orgId, c.locationId, M, 'view');
    const msgs = await s.db.select().from(commsMessages).where(eq(commsMessages.conversationId, id)).orderBy(asc(commsMessages.createdAt)).limit(500);
    const [customer] = c.customerId ? await s.db.select({ id: customers.id, name: customers.name, email: customers.email, phone: customers.phone, locationId: customers.locationId }).from(customers).where(eq(customers.id, c.customerId)) : [];
    const [lead] = c.leadId ? await s.db.select({ id: leads.id, name: leads.name, status: leads.status, source: leads.source, assignedUserId: leads.assignedUserId }).from(leads).where(eq(leads.id, c.leadId)) : [];
    return {
      conversation: (await serializeConversations(s.db, [c]))[0]!, messages: await serializeMessages(s.db, msgs), policy: await replyPolicy(s.db, c),
      customer: customer ?? null, lead: lead ?? null, canReply: await hasAt(req, s.db, orgId, c.locationId, M, 'edit'),
    };
  });

  app.patch('/orgs/:orgId/inbox/conversations/:id', {
    schema: {
      tags: ['inbox'], security: secured, params: idParams, summary: 'Change status, assignee or linked customer',
      body: z.object({ status: z.enum(CONVERSATION_STATUSES).optional(), assignedUserId: z.uuid().nullable().optional(), customerId: z.uuid().nullable().optional() }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    const c = await loadConv(orgId, id);
    await requireAt(req, s.db, orgId, c.locationId, M, 'edit');
    const b = req.body;
    if (b.assignedUserId) {
      const allowed = await usersWithCapabilityAt(s.db, orgId, c.locationId, M, 'edit');
      if (!allowed.includes(b.assignedUserId)) throw validationError('This person has no inbox access here', { assignedUserId: 'Not available for this inbox' });
    }
    if (b.customerId) {
      const [cu] = await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, b.customerId), eq(customers.organizationId, orgId)));
      if (!cu) throw notFound('Customer');
    }
    const [u] = await s.db.update(commsConversations).set({
      ...(b.status ? { status: b.status, ...(b.status === 'closed' ? { replyDueAt: null } : {}) } : {}),
      ...(b.assignedUserId !== undefined ? { assignedUserId: b.assignedUserId } : {}),
      ...(b.customerId !== undefined ? { customerId: b.customerId } : {}), updatedAt: new Date(),
    }).where(eq(commsConversations.id, id)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'inbox.conversation_updated', scopeKind: c.locationId ? 'location' : 'organization', scopeId: c.locationId ?? orgId, targetType: 'conversation', targetId: id, metadata: b });
    return (await serializeConversations(s.db, [u!]))[0]!;
  });

  app.post('/orgs/:orgId/inbox/conversations/:id/read', { schema: { tags: ['inbox'], security: secured, params: idParams } }, async (req) => {
    const c = await loadConv(req.params.orgId, req.params.id);
    await requireAt(req, s.db, req.params.orgId, c.locationId, M, 'view');
    await s.db.update(commsConversations).set({ unread: 0 }).where(eq(commsConversations.id, c.id));
    return { ok: true };
  });

  app.post('/orgs/:orgId/inbox/conversations/:id/messages', {
    schema: {
      tags: ['inbox'], security: secured, params: idParams,
      summary: 'Reply (consent, opt-out, 24-hour window and WhatsApp template rules apply) or add an internal note',
      body: z.object({ kind: z.enum(['reply', 'note']).default('reply'), body: z.string().max(4000).optional(), templateId: z.uuid().optional() }),
    },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const c = await loadConv(orgId, id);
    await requireAt(req, s.db, orgId, c.locationId, M, 'edit');
    const me = requireUser(req);
    if (req.body.kind === 'note') {
      if (!req.body.body?.trim()) throw validationError('Write a note', { body: 'Required' });
      const n = await addNote(s.db, c, req.body.body.trim(), me.id);
      return reply.code(201).send((await serializeMessages(s.db, [n]))[0]!);
    }
    const m = await sendInConversation(s, c, { body: req.body.body, templateId: req.body.templateId ?? null, authorUserId: me.id, ip: req.ip });
    return reply.code(201).send((await serializeMessages(s.db, [m]))[0]!);
  });

  app.get('/orgs/:orgId/inbox/assignees', {
    schema: { tags: ['inbox'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'People who can work this inbox' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireAt(req, s.db, orgId, req.query.locationId ?? null, M, 'view');
    const ids = await usersWithCapabilityAt(s.db, orgId, req.query.locationId ?? null, M, 'edit');
    const people = ids.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)).orderBy(users.name) : [];
    return { items: people };
  });

  /* ── canned replies ── */

  app.get('/orgs/:orgId/inbox/canned-replies', { schema: { tags: ['inbox'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
    const { orgId } = req.params;
    const scope = await scopeFor(req, s.db, orgId, M);
    const rows = await s.db.select().from(commsCannedReplies).where(and(eq(commsCannedReplies.organizationId, orgId), req.query.locationId ? or(isNull(commsCannedReplies.locationId), eq(commsCannedReplies.locationId, req.query.locationId)) : undefined)).orderBy(asc(commsCannedReplies.title));
    // HQ replies are shared with every location; location replies stay local.
    return { items: rows.filter((r) => !r.locationId || inScope(scope, r.locationId)).map((r) => ({ id: r.id, locationId: r.locationId, title: r.title, body: r.body })) };
  });

  app.post('/orgs/:orgId/inbox/canned-replies', {
    schema: { tags: ['inbox'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid().nullable().default(null), title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(2000) }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await checkLocation(orgId, req.body.locationId);
    await requireAt(req, s.db, orgId, req.body.locationId, M, 'edit');
    const [r] = await s.db.insert(commsCannedReplies).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    return reply.code(201).send({ id: r!.id, locationId: r!.locationId, title: r!.title, body: r!.body });
  });

  app.delete('/orgs/:orgId/inbox/canned-replies/:id', { schema: { tags: ['inbox'], security: secured, params: idParams } }, async (req) => {
    const [r] = await s.db.select().from(commsCannedReplies).where(and(eq(commsCannedReplies.id, req.params.id), eq(commsCannedReplies.organizationId, req.params.orgId)));
    if (!r) throw notFound('Canned reply');
    await requireAt(req, s.db, req.params.orgId, r.locationId, M, 'edit');
    await s.db.delete(commsCannedReplies).where(eq(commsCannedReplies.id, r.id));
    return { id: r.id, deleted: true };
  });

  /* ── WhatsApp templates ── */

  const serializeTemplate = (t: typeof commsWhatsappTemplates.$inferSelect) => ({ id: t.id, name: t.name, language: t.language, category: t.category, body: t.body, status: t.status });
  app.get('/orgs/:orgId/inbox/whatsapp-templates', { schema: { tags: ['inbox'], security: secured, params: orgParams } }, async (req) => {
    const scope = await scopeFor(req, s.db, req.params.orgId, M);
    if (!scope.all && !scope.locationIds?.length) return { items: [] };
    const rows = await s.db.select().from(commsWhatsappTemplates).where(eq(commsWhatsappTemplates.organizationId, req.params.orgId)).orderBy(asc(commsWhatsappTemplates.name));
    return { items: rows.map(serializeTemplate) };
  });

  app.post('/orgs/:orgId/inbox/whatsapp-templates', {
    schema: {
      tags: ['inbox'], security: secured, params: orgParams, summary: 'Submit a WhatsApp template for review (HQ). It can be sent outside the 24-hour window once approved.',
      body: z.object({ name: z.string().trim().regex(/^[a-z0-9_]{1,60}$/, 'Lowercase letters, numbers and underscores'), language: z.string().min(2).max(10).default('en'), category: z.enum(['utility', 'marketing', 'authentication']).default('utility'), body: z.string().trim().min(1).max(1024) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireAt(req, s.db, orgId, null, M, 'edit');
    const [t] = await s.db.insert(commsWhatsappTemplates).values({ organizationId: orgId, ...req.body, status: 'pending', createdBy: req.user!.id }).returning();
    return reply.code(201).send(serializeTemplate(t!));
  });

  app.post('/orgs/:orgId/inbox/whatsapp-templates/:id/review', {
    schema: { tags: ['inbox'], security: secured, params: idParams, summary: 'Sandbox only: record WhatsApp’s review outcome (live accounts get it from Meta).', body: z.object({ status: z.enum(['approved', 'rejected']) }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireAt(req, s.db, orgId, null, M, 'edit');
    if (s.messaging.whatsappEnabled) throw conflict('whatsapp_live', 'Template reviews come from WhatsApp for live accounts');
    const [t] = await s.db.update(commsWhatsappTemplates).set({ status: req.body.status }).where(and(eq(commsWhatsappTemplates.id, id), eq(commsWhatsappTemplates.organizationId, orgId))).returning();
    if (!t) throw notFound('Template');
    return serializeTemplate(t);
  });

  /* ── contacts, tags, consent ── */

  const contactScope = async (orgId: string, req: Parameters<typeof scopeFor>[0]) => {
    // Contacts are visible with Customers, the Inbox or Email (segments feed broadcasts and email campaigns).
    const a = await scopeFor(req, s.db, orgId, 'sales.customers');
    const b = await scopeFor(req, s.db, orgId, M);
    const c = await scopeFor(req, s.db, orgId, 'marketing.email');
    if (a.all || b.all || c.all) return null;
    return [...new Set([...(a.locationIds ?? []), ...(b.locationIds ?? []), ...(c.locationIds ?? [])])];
  };
  const loadCustomer = async (orgId: string, id: string) => {
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId), isNull(customers.erasedAt)));
    if (!c) throw notFound('Contact');
    return c;
  };

  app.get('/orgs/:orgId/contacts', {
    schema: { tags: ['inbox'], security: secured, params: orgParams, summary: 'Contacts (customers) with tags, consent per channel and last activity', querystring: z.object({ q: z.string().max(80).optional(), locationId: z.uuid().optional(), tag: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
  }, async (req) => {
    const { orgId } = req.params;
    const visible = await contactScope(orgId, req);
    const rules = { ...(req.query.locationId ? { locationIds: [req.query.locationId] } : {}), ...(req.query.tag ? { tagsAny: [req.query.tag] } : {}) };
    const r = await segmentMembers(s.db, orgId, rules, visible, req.query.limit);
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      r.items = r.items.filter((c) => c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q) || (c.phone ?? '').includes(q));
    }
    const tags = await s.db.selectDistinct({ tag: contactTags.tag }).from(contactTags).where(eq(contactTags.organizationId, orgId)).orderBy(contactTags.tag);
    return { ...r, tags: tags.map((t) => t.tag) };
  });

  app.put('/orgs/:orgId/contacts/:id/tags', {
    schema: { tags: ['inbox'], security: secured, params: idParams, body: z.object({ tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30) }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const c = await loadCustomer(orgId, id);
    await requireAnyAt(req, s.db, orgId, c.locationId, [[M, 'edit'], ['sales.customers', 'edit']]);
    const tags = [...new Set(req.body.tags)];
    await s.db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.customerId, id));
      if (tags.length) await tx.insert(contactTags).values(tags.map((tag) => ({ organizationId: orgId, customerId: id, tag })));
    });
    return { id, tags: tags.sort() };
  });

  app.post('/orgs/:orgId/contacts/:id/consent', {
    schema: { tags: ['inbox'], security: secured, params: idParams, summary: 'Record a contact’s marketing consent for a channel (who agreed, when, how)', body: z.object({ channel: z.enum(['email', 'sms', 'whatsapp']), granted: z.boolean(), source: z.string().trim().min(1).max(60).default('staff') }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const c = await loadCustomer(orgId, id);
    await requireAnyAt(req, s.db, orgId, c.locationId, [[M, 'edit'], ['sales.customers', 'edit']]);
    const [r] = await s.db.insert(consentRecords).values({ organizationId: orgId, customerId: id, email: c.email, purpose: marketingConsentPurpose(req.body.channel), version: 'v1', granted: req.body.granted, source: req.body.source, ip: req.ip }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'consent.recorded', scopeKind: 'location', scopeId: c.locationId, targetType: 'customer', targetId: id, metadata: { channel: req.body.channel, granted: req.body.granted } });
    return reply.code(201).send({ id: r!.id, channel: req.body.channel, granted: r!.granted, recordedAt: r!.recordedAt.toISOString() });
  });

  /* ── segments ── */

  const serializeSegment = (g: typeof contactSegments.$inferSelect) => ({ id: g.id, locationId: g.locationId, name: g.name, rules: g.rules, createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString() });
  const segmentEditors: Array<[string, 'edit']> = [[M, 'edit'], ['marketing.campaigns', 'edit'], ['marketing.email', 'edit'], ['sales.customer_pipeline', 'edit']];

  app.get('/orgs/:orgId/segments', { schema: { tags: ['inbox'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    const visible = await contactScope(orgId, req);
    const rows = await s.db.select().from(contactSegments).where(eq(contactSegments.organizationId, orgId)).orderBy(asc(contactSegments.name));
    const mine = rows.filter((g) => visible === null || (g.locationId ? visible.includes(g.locationId) : true));
    return { items: await Promise.all(mine.map(async (g) => ({ ...serializeSegment(g), count: (await segmentMembers(s.db, orgId, g.rules, visible, 0)).count }))) };
  });

  app.post('/orgs/:orgId/segments/preview', { schema: { tags: ['inbox'], security: secured, params: orgParams, body: z.object({ rules: segmentRules }), summary: 'Count and sample the contacts matching rules (only those you can see)' } }, async (req) => {
    const visible = await contactScope(req.params.orgId, req);
    return segmentMembers(s.db, req.params.orgId, req.body.rules, visible, 25);
  });

  app.post('/orgs/:orgId/segments', {
    schema: { tags: ['inbox'], security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(120), locationId: z.uuid().nullable().default(null), rules: segmentRules }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await checkLocation(orgId, req.body.locationId);
    await requireAnyAt(req, s.db, orgId, req.body.locationId, segmentEditors);
    const [g] = await s.db.insert(contactSegments).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    return reply.code(201).send(serializeSegment(g!));
  });

  app.delete('/orgs/:orgId/segments/:id', { schema: { tags: ['inbox'], security: secured, params: idParams } }, async (req) => {
    const [g] = await s.db.select().from(contactSegments).where(and(eq(contactSegments.id, req.params.id), eq(contactSegments.organizationId, req.params.orgId)));
    if (!g) throw notFound('Segment');
    await requireAnyAt(req, s.db, req.params.orgId, g.locationId, segmentEditors);
    await s.db.delete(contactSegments).where(eq(contactSegments.id, g.id));
    return { id: g.id, deleted: true };
  });

  app.get('/orgs/:orgId/segments/:id/members', { schema: { tags: ['inbox'], security: secured, params: idParams } }, async (req) => {
    const [g] = await s.db.select().from(contactSegments).where(and(eq(contactSegments.id, req.params.id), eq(contactSegments.organizationId, req.params.orgId)));
    if (!g) throw notFound('Segment');
    return segmentMembers(s.db, req.params.orgId, g.rules, await contactScope(req.params.orgId, req));
  });

  /* ── broadcast to a segment (consent-aware) ── */

  app.post('/orgs/:orgId/inbox/broadcasts', {
    schema: {
      tags: ['inbox'], security: secured, params: orgParams,
      summary: 'Message every contact in a segment on one channel. Contacts without consent for that channel or who opted out are skipped; WhatsApp needs an approved template.',
      body: z.object({ segmentId: z.uuid(), channelAccountId: z.uuid(), body: z.string().trim().max(1600).optional(), templateId: z.uuid().optional() }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    const acct = await loadAccount(orgId, req.body.channelAccountId);
    await requireAt(req, s.db, orgId, acct.locationId, M, 'edit');
    if (!['sms', 'whatsapp', 'email'].includes(acct.channel)) throw validationError('Broadcasts go out by email, SMS or WhatsApp', { channelAccountId: 'Choose an email, SMS or WhatsApp channel' });
    if (acct.channel === 'whatsapp' && !req.body.templateId) throw conflict('whatsapp_template_required', 'WhatsApp broadcasts must use an approved template');
    if (acct.channel !== 'whatsapp' && !req.body.body) throw validationError('Write a message', { body: 'Required' });
    const [g] = await s.db.select().from(contactSegments).where(and(eq(contactSegments.id, req.body.segmentId), eq(contactSegments.organizationId, orgId)));
    if (!g) throw notFound('Segment');
    // A location broadcasts only to its own contacts; HQ channels reach every contact the sender can see.
    const visible = acct.locationId ? [acct.locationId] : await contactScope(orgId, req);
    const members = await segmentMembers(s.db, orgId, g.rules, visible, 5000);
    const ch = acct.channel as InboxChannelKey;
    const out = { sent: 0, sandboxed: 0, failed: 0, skippedNoConsent: 0, skippedOptedOut: 0, skippedNoAddress: 0 };
    for (const c of members.items) {
      const handle = ch === 'email' ? c.email?.toLowerCase() : c.phone?.replace(/[^0-9+]/g, '');
      if (!handle) { out.skippedNoAddress++; continue; }
      if (await isOptedOut(s.db, orgId, ch, handle)) { out.skippedOptedOut++; continue; }
      if ((await marketingConsent(s.db, c.id, ch)) !== true) { out.skippedNoConsent++; continue; }
      let [conv] = await s.db.select().from(commsConversations).where(and(eq(commsConversations.channelAccountId, acct.id), eq(commsConversations.handle, handle)));
      if (!conv) {
        [conv] = await s.db.insert(commsConversations).values({ organizationId: orgId, locationId: acct.locationId, channelAccountId: acct.id, channel: acct.channel, handle, contactName: c.name, customerId: c.id, status: 'pending', lastMessageAt: new Date() }).returning();
      }
      try {
        const m = await sendInConversation(s, conv!, { body: req.body.body, templateId: req.body.templateId ?? null, authorUserId: me.id, ip: req.ip });
        if (m.status === 'sent') out.sent++;
        else if (m.status === 'sandboxed') out.sandboxed++;
        else out.failed++;
      } catch {
        out.failed++;
      }
    }
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'inbox.broadcast', scopeKind: acct.locationId ? 'location' : 'organization', scopeId: acct.locationId ?? orgId, targetType: 'segment', targetId: g.id, metadata: { channel: ch, ...out } });
    return { segment: g.name, matched: members.count, ...out };
  });

  // SLA sweep helper for clients: overdue conversations count (cheap).
  app.get('/orgs/:orgId/inbox/overdue', { schema: { tags: ['inbox'], security: secured, params: orgParams } }, async (req) => {
    const scope = await scopeFor(req, s.db, req.params.orgId, M);
    const conds: SQL[] = [eq(commsConversations.organizationId, req.params.orgId), lt(commsConversations.replyDueAt, new Date())];
    if (!scope.all) conds.push(scope.locationIds!.length ? inArray(commsConversations.locationId, scope.locationIds!) : sql`false`);
    const [r] = await s.db.select({ n: sql<number>`count(*)::int` }).from(commsConversations).where(and(...conds));
    return { overdue: r?.n ?? 0 };
  });
};
