import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { currency } from '@bh/shared';
import { customers, leadRoutingRules, leads, locations, salesActivities, salesDeals, salesStages, users } from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireAt, scopeFor, usersWithCapabilityAt } from '../services/comms-scope.ts';
import { createRoutedLead, decideRouting, pipelineModule, routeLead } from '../services/lead-routing.ts';
import { idParams, orgParams, secured } from './_common.ts';

const P = 'sales.customer_pipeline';
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
const kind = z.enum(['customer', 'course']);
const DEFAULT_STAGES = [
  { name: 'New', outcome: 'open', probability: 10 },
  { name: 'Contacted', outcome: 'open', probability: 25 },
  { name: 'Trial booked', outcome: 'open', probability: 50 },
  { name: 'Offer sent', outcome: 'open', probability: 70 },
  { name: 'Won', outcome: 'won', probability: 100 },
  { name: 'Lost', outcome: 'lost', probability: 0 },
] as const;

const conditions = z.object({
  sources: z.array(z.string().max(40)).max(20).optional(), locationIds: z.array(z.uuid()).max(500).optional(), countries: z.array(z.string().length(2)).max(50).optional(),
  postalPrefixes: z.array(z.string().max(10)).max(100).optional(), campaignIds: z.array(z.uuid()).max(50).optional(),
});
const action = z.object({ type: z.enum(['location', 'users', 'location_team']), locationId: z.uuid().optional(), userIds: z.array(z.uuid()).max(50).optional() })
  .refine((a) => a.type !== 'location' || !!a.locationId, { message: 'Choose a location', path: ['locationId'] })
  .refine((a) => a.type !== 'users' || !!a.userIds?.length, { message: 'Choose at least one person', path: ['userIds'] });

/**
 * Sales workspace: customer leads and course (teacher-training) leads, lead routing rules, and the customer sales
 * pipeline (stages, deals, tasks and activities). Separate from the franchise pipeline.
 */
export const salesPipelineRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const names = async (ids: Array<string | null | undefined>) => {
    const u = [...new Set(ids.filter((x): x is string => !!x))];
    return u.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, u)) : [];
  };
  const serializeLead = (l: typeof leads.$inferSelect, people: Array<{ id: string; name: string }>) => ({
    id: l.id, kind: l.kind, name: l.name, email: l.email, phone: l.phone, message: l.message, source: l.source, status: l.status, locationId: l.locationId,
    adCampaignId: l.adCampaignId, customerId: l.customerId, country: l.country, postalCode: l.postalCode, routingRuleId: l.routingRuleId,
    courseId: l.courseId, enrolmentId: l.enrolmentId, campaign: l.campaign, utm: l.utm, notes: l.notes, marketingConsent: l.marketingConsent,
    assignedUser: l.assignedUserId ? { id: l.assignedUserId, name: people.find((p) => p.id === l.assignedUserId)?.name ?? null } : null, createdAt: l.createdAt.toISOString(),
  });
  const loadLead = async (orgId: string, id: string) => {
    const [l] = await s.db.select().from(leads).where(and(eq(leads.id, id), eq(leads.organizationId, orgId)));
    if (!l) throw notFound('Lead');
    return l;
  };
  /** Course leads assigned to you are always yours to work; otherwise the module applies at the lead's location. */
  const requireLead = async (req: Parameters<typeof requireAt>[0], l: typeof leads.$inferSelect, act: 'view' | 'edit') => {
    if (l.assignedUserId === req.user?.id) {
      const sc = await scopeFor(req, s.db, l.organizationId, pipelineModule(l.kind), act);
      if (sc.all || sc.locationIds!.length) return;
    }
    await requireAt(req, s.db, l.organizationId, l.locationId, pipelineModule(l.kind), act);
  };

  /* ── leads ── */

  app.get('/orgs/:orgId/sales/leads', {
    schema: {
      tags: ['sales'], security: secured, params: orgParams, summary: 'Leads you can see: customer leads by location, course leads (instructors see those assigned to them)',
      querystring: z.object({ kind: kind.default('customer'), status: z.enum([...LEAD_STATUSES, 'open', 'all']).default('open'), locationId: z.uuid().optional(), assigned: z.enum(['me', 'unassigned', 'any']).default('any'), adCampaignId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    const q = req.query;
    const scope = await scopeFor(req, s.db, orgId, pipelineModule(q.kind));
    const conds: SQL[] = [eq(leads.organizationId, orgId), eq(leads.kind, q.kind)];
    if (!scope.all) {
      const own = eq(leads.assignedUserId, me.id);
      conds.push(scope.locationIds!.length ? or(inArray(leads.locationId, scope.locationIds!), q.kind === 'course' ? own : sql`false`)! : q.kind === 'course' ? own : sql`false`);
    }
    if (q.status === 'open') conds.push(inArray(leads.status, ['new', 'contacted', 'qualified']));
    else if (q.status !== 'all') conds.push(eq(leads.status, q.status));
    if (q.locationId) conds.push(eq(leads.locationId, q.locationId));
    if (q.assigned === 'me') conds.push(eq(leads.assignedUserId, me.id));
    if (q.assigned === 'unassigned') conds.push(isNull(leads.assignedUserId));
    if (q.adCampaignId) conds.push(eq(leads.adCampaignId, q.adCampaignId));
    const rows = await s.db.select().from(leads).where(and(...conds)).orderBy(desc(leads.createdAt)).limit(q.limit);
    const people = await names(rows.map((r) => r.assignedUserId));
    return { items: rows.map((r) => serializeLead(r, people)) };
  });

  app.post('/orgs/:orgId/sales/leads', {
    schema: {
      tags: ['sales'], security: secured, params: orgParams, summary: 'Add a lead by hand; routing rules decide who follows up',
      body: z.object({ kind: kind.default('customer'), name: z.string().trim().min(1).max(120), email: z.email().optional(), phone: z.string().max(40).optional(), source: z.string().trim().min(1).max(40).default('manual'), locationId: z.uuid().nullable().default(null), message: z.string().max(2000).optional(), country: z.string().length(2).optional(), postalCode: z.string().max(12).optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    if (b.locationId) {
      const [l] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, b.locationId), eq(locations.organizationId, orgId)));
      if (!l) throw notFound('Location');
    }
    await requireAt(req, s.db, orgId, b.locationId, pipelineModule(b.kind), 'edit');
    const lead = await createRoutedLead(s.db, { organizationId: orgId, kind: b.kind, name: b.name, email: b.email ?? null, phone: b.phone ?? null, source: b.source, locationId: b.locationId, message: b.message ?? null, country: b.country?.toUpperCase() ?? null, postalCode: b.postalCode ?? null });
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'lead.created', scopeKind: lead.locationId ? 'location' : 'organization', scopeId: lead.locationId ?? orgId, targetType: 'lead', targetId: lead.id, metadata: { kind: b.kind } });
    return reply.code(201).send(serializeLead(lead, await names([lead.assignedUserId])));
  });

  app.patch('/orgs/:orgId/sales/leads/:id', {
    schema: { tags: ['sales'], security: secured, params: idParams, body: z.object({ status: z.enum(LEAD_STATUSES).optional(), assignedUserId: z.uuid().nullable().optional(), locationId: z.uuid().optional(), notes: z.string().max(5000).nullable().optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const l = await loadLead(orgId, id);
    await requireLead(req, l, 'edit');
    const b = req.body;
    if (b.locationId) await requireAt(req, s.db, orgId, b.locationId, pipelineModule(l.kind), 'edit');
    if (b.assignedUserId) {
      const pool = await usersWithCapabilityAt(s.db, orgId, b.locationId ?? l.locationId, pipelineModule(l.kind), 'edit');
      if (!pool.includes(b.assignedUserId)) throw validationError('This person can’t work these leads', { assignedUserId: 'No access to these leads' });
    }
    const [u] = await s.db.update(leads).set({ ...b, updatedAt: new Date() }).where(eq(leads.id, id)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'lead.updated', scopeKind: u!.locationId ? 'location' : 'organization', scopeId: u!.locationId ?? orgId, targetType: 'lead', targetId: id, metadata: b });
    return serializeLead(u!, await names([u!.assignedUserId]));
  });

  app.post('/orgs/:orgId/sales/leads/:id/reroute', { schema: { tags: ['sales'], security: secured, params: idParams, summary: 'Run the routing rules again for this lead' } }, async (req) => {
    const l = await loadLead(req.params.orgId, req.params.id);
    await requireLead(req, l, 'edit');
    const u = await routeLead(s.db, l);
    return serializeLead(u, await names([u.assignedUserId]));
  });

  app.post('/orgs/:orgId/sales/leads/:id/convert', {
    schema: { tags: ['sales'], security: secured, params: idParams, summary: 'Turn a customer lead into a customer and a deal in the first pipeline stage', body: z.object({ title: z.string().trim().min(1).max(160).optional(), valueMinor: z.number().int().min(0).default(0) }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const l = await loadLead(orgId, id);
    if (l.kind !== 'customer') throw conflict('not_customer_lead', 'Course leads are followed up by instructors, not converted to deals');
    if (!l.locationId) throw validationError('Send the lead to a location first', { locationId: 'Required' });
    await requireAt(req, s.db, orgId, l.locationId, P, 'edit');
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, l.locationId));
    const stages = await ensureStages(orgId);
    const out = await s.db.transaction(async (tx) => {
      let customerId = l.customerId;
      if (!customerId) {
        const [c] = await tx.insert(customers).values({ organizationId: orgId, locationId: l.locationId, name: l.name ?? l.email ?? l.phone ?? 'New customer', email: l.email, phone: l.phone }).returning();
        customerId = c!.id;
      }
      const [d] = await tx.insert(salesDeals).values({ organizationId: orgId, locationId: l.locationId!, stageId: stages[0]!.id, title: req.body.title ?? `${l.name ?? 'Lead'} — ${loc!.name}`, customerId, leadId: l.id, valueMinor: req.body.valueMinor, currency: loc!.currency, ownerUserId: l.assignedUserId ?? req.user!.id, createdBy: req.user!.id }).returning();
      await tx.update(leads).set({ status: 'converted', customerId, updatedAt: new Date() }).where(eq(leads.id, l.id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'lead.converted', scopeKind: 'location', scopeId: l.locationId, targetType: 'lead', targetId: l.id, metadata: { dealId: d!.id, customerId } });
      return d!;
    });
    return reply.code(201).send({ dealId: out.id, customerId: out.customerId });
  });

  /* ── routing rules ── */

  const ruleEditor = (k: string): [string, 'publish' | 'edit'] => (k === 'course' ? ['sales.course_leads', 'edit'] : [P, 'publish']);
  const serializeRule = (r: typeof leadRoutingRules.$inferSelect) => ({ id: r.id, kind: r.kind, name: r.name, position: r.position, conditions: r.conditions, action: r.action, active: r.active });

  app.get('/orgs/:orgId/sales/routing-rules', { schema: { tags: ['sales'], security: secured, params: orgParams, querystring: z.object({ kind: kind.default('customer') }) } }, async (req) => {
    const { orgId } = req.params;
    await requireAt(req, s.db, orgId, null, pipelineModule(req.query.kind), 'view');
    const rows = await s.db.select().from(leadRoutingRules).where(and(eq(leadRoutingRules.organizationId, orgId), eq(leadRoutingRules.kind, req.query.kind))).orderBy(asc(leadRoutingRules.position), asc(leadRoutingRules.createdAt));
    return { items: rows.map(serializeRule) };
  });

  const validateRuleRefs = async (orgId: string, c: z.infer<typeof conditions>, a: z.infer<typeof action>) => {
    const locIds = [...(c.locationIds ?? []), ...(a.locationId ? [a.locationId] : [])];
    if (locIds.length) {
      const found = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, locIds)));
      if (found.length !== new Set(locIds).size) throw validationError('Unknown location', { locationIds: 'Not in this business' });
    }
  };

  app.post('/orgs/:orgId/sales/routing-rules', {
    schema: { tags: ['sales'], security: secured, params: orgParams, body: z.object({ kind: kind.default('customer'), name: z.string().trim().min(1).max(120), position: z.number().int().min(0).max(1000).optional(), conditions: conditions.default({}), action, active: z.boolean().default(true) }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const [m, a] = ruleEditor(req.body.kind);
    await requireAt(req, s.db, orgId, null, m, a);
    await validateRuleRefs(orgId, req.body.conditions, req.body.action);
    const [max] = await s.db.select({ p: sql<number>`coalesce(max(${leadRoutingRules.position}), -1)::int` }).from(leadRoutingRules).where(and(eq(leadRoutingRules.organizationId, orgId), eq(leadRoutingRules.kind, req.body.kind)));
    const [r] = await s.db.insert(leadRoutingRules).values({ organizationId: orgId, ...req.body, position: req.body.position ?? (max?.p ?? -1) + 1, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'lead_routing.rule_created', scopeKind: 'organization', scopeId: orgId, targetType: 'routing_rule', targetId: r!.id });
    return reply.code(201).send(serializeRule(r!));
  });

  app.patch('/orgs/:orgId/sales/routing-rules/:id', {
    schema: { tags: ['sales'], security: secured, params: idParams, body: z.object({ name: z.string().trim().min(1).max(120).optional(), position: z.number().int().min(0).max(1000).optional(), conditions: conditions.optional(), action: action.optional(), active: z.boolean().optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [r] = await s.db.select().from(leadRoutingRules).where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.organizationId, orgId)));
    if (!r) throw notFound('Routing rule');
    const [m, a] = ruleEditor(r.kind);
    await requireAt(req, s.db, orgId, null, m, a);
    await validateRuleRefs(orgId, req.body.conditions ?? {}, req.body.action ?? { type: 'location_team' });
    const [u] = await s.db.update(leadRoutingRules).set(req.body).where(eq(leadRoutingRules.id, id)).returning();
    return serializeRule(u!);
  });

  app.delete('/orgs/:orgId/sales/routing-rules/:id', { schema: { tags: ['sales'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const [r] = await s.db.select().from(leadRoutingRules).where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.organizationId, orgId)));
    if (!r) throw notFound('Routing rule');
    const [m, a] = ruleEditor(r.kind);
    await requireAt(req, s.db, orgId, null, m, a);
    await s.db.delete(leadRoutingRules).where(eq(leadRoutingRules.id, id));
    return { id, deleted: true };
  });

  app.post('/orgs/:orgId/sales/routing-rules/test', {
    schema: { tags: ['sales'], security: secured, params: orgParams, summary: 'Where would this lead go? (nothing is saved)', body: z.object({ kind: kind.default('customer'), source: z.string().max(40).default('website'), locationId: z.uuid().nullable().default(null), country: z.string().length(2).nullable().default(null), postalCode: z.string().max(12).nullable().default(null), adCampaignId: z.uuid().nullable().default(null) }) },
  }, async (req) => {
    const { orgId } = req.params;
    await requireAt(req, s.db, orgId, null, pipelineModule(req.body.kind), 'view');
    const d = await decideRouting(s.db, orgId, req.body, { dryRun: true });
    const people = await names([d.assignedUserId]);
    return { ...d, assignedUserName: people[0]?.name ?? null };
  });

  /* ── pipeline ── */

  async function ensureStages(orgId: string) {
    let rows = await s.db.select().from(salesStages).where(eq(salesStages.organizationId, orgId)).orderBy(asc(salesStages.position));
    if (!rows.length) {
      await s.db.insert(salesStages).values(DEFAULT_STAGES.map((st, i) => ({ organizationId: orgId, name: st.name, outcome: st.outcome, probability: st.probability, position: i })));
      rows = await s.db.select().from(salesStages).where(eq(salesStages.organizationId, orgId)).orderBy(asc(salesStages.position));
    }
    return rows;
  }
  const serializeStage = (st: typeof salesStages.$inferSelect) => ({ id: st.id, name: st.name, position: st.position, outcome: st.outcome, probability: st.probability });

  app.get('/orgs/:orgId/sales/stages', { schema: { tags: ['sales'], security: secured, params: orgParams } }, async (req) => {
    const scope = await scopeFor(req, s.db, req.params.orgId, P);
    if (!scope.all && !scope.locationIds?.length) throw notFound('Pipeline');
    return { items: (await ensureStages(req.params.orgId)).map(serializeStage) };
  });

  app.post('/orgs/:orgId/sales/stages', {
    schema: { tags: ['sales'], security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(60), outcome: z.enum(['open', 'won', 'lost']).default('open'), probability: z.number().int().min(0).max(100).default(50), position: z.number().int().min(0).max(100) }) },
  }, async (req, reply) => {
    await requireAt(req, s.db, req.params.orgId, null, P, 'publish');
    await ensureStages(req.params.orgId);
    await s.db.update(salesStages).set({ position: sql`${salesStages.position} + 1` }).where(and(eq(salesStages.organizationId, req.params.orgId), sql`${salesStages.position} >= ${req.body.position}`));
    const [st] = await s.db.insert(salesStages).values({ organizationId: req.params.orgId, ...req.body }).returning();
    return reply.code(201).send(serializeStage(st!));
  });

  const serializeDeal = (d: typeof salesDeals.$inferSelect, people: Array<{ id: string; name: string }>, extra: { customerName?: string | null; openTasks?: number } = {}) => ({
    id: d.id, locationId: d.locationId, stageId: d.stageId, title: d.title, customerId: d.customerId, customerName: extra.customerName ?? null, leadId: d.leadId,
    value: { amount: d.valueMinor, currency: d.currency }, owner: d.ownerUserId ? { id: d.ownerUserId, name: people.find((p) => p.id === d.ownerUserId)?.name ?? null } : null,
    expectedCloseOn: d.expectedCloseOn, closedAt: d.closedAt?.toISOString() ?? null, openTasks: extra.openTasks ?? 0, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
  });
  const loadDeal = async (orgId: string, id: string) => {
    const [d] = await s.db.select().from(salesDeals).where(and(eq(salesDeals.id, id), eq(salesDeals.organizationId, orgId)));
    if (!d) throw notFound('Deal');
    return d;
  };

  app.get('/orgs/:orgId/sales/deals', { schema: { tags: ['sales'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), mine: z.coerce.boolean().default(false) }) } }, async (req) => {
    const { orgId } = req.params;
    const scope = await scopeFor(req, s.db, orgId, P);
    const conds: SQL[] = [eq(salesDeals.organizationId, orgId)];
    if (!scope.all) conds.push(scope.locationIds!.length ? inArray(salesDeals.locationId, scope.locationIds!) : sql`false`);
    if (req.query.locationId) conds.push(eq(salesDeals.locationId, req.query.locationId));
    if (req.query.mine) conds.push(eq(salesDeals.ownerUserId, req.user!.id));
    const rows = await s.db.select({ d: salesDeals, customerName: customers.name, openTasks: sql<number>`(select count(*) from sales_activities a where a.deal_id = ${salesDeals.id} and a.type = 'task' and a.done_at is null)::int` })
      .from(salesDeals).leftJoin(customers, eq(customers.id, salesDeals.customerId)).where(and(...conds)).orderBy(desc(salesDeals.updatedAt)).limit(500);
    const people = await names(rows.map((r) => r.d.ownerUserId));
    return { stages: (await ensureStages(orgId)).map(serializeStage), items: rows.map((r) => serializeDeal(r.d, people, { customerName: r.customerName, openTasks: r.openTasks })) };
  });

  app.post('/orgs/:orgId/sales/deals', {
    schema: { tags: ['sales'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), title: z.string().trim().min(1).max(160), customerId: z.uuid().optional(), valueMinor: z.number().int().min(0).default(0), currency: currency.optional(), stageId: z.uuid().optional(), expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, b.locationId), eq(locations.organizationId, orgId)));
    if (!loc) throw notFound('Location');
    await requireAt(req, s.db, orgId, loc.id, P, 'edit');
    if (b.currency && b.currency !== loc.currency) throw validationError(`Deals at ${loc.name} are in ${loc.currency}`, { currency: `Must be ${loc.currency}` });
    const stages = await ensureStages(orgId);
    const stage = b.stageId ? stages.find((st) => st.id === b.stageId) : stages[0];
    if (!stage) throw validationError('Unknown stage', { stageId: 'Not in this pipeline' });
    if (b.customerId) {
      const [c] = await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, b.customerId), eq(customers.organizationId, orgId)));
      if (!c) throw notFound('Customer');
    }
    const [d] = await s.db.insert(salesDeals).values({ organizationId: orgId, locationId: loc.id, stageId: stage.id, title: b.title, customerId: b.customerId ?? null, valueMinor: b.valueMinor, currency: loc.currency, ownerUserId: req.user!.id, expectedCloseOn: b.expectedCloseOn ?? null, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'deal.created', scopeKind: 'location', scopeId: loc.id, targetType: 'deal', targetId: d!.id });
    return reply.code(201).send(serializeDeal(d!, await names([d!.ownerUserId])));
  });

  app.patch('/orgs/:orgId/sales/deals/:id', {
    schema: { tags: ['sales'], security: secured, params: idParams, body: z.object({ title: z.string().trim().min(1).max(160).optional(), stageId: z.uuid().optional(), valueMinor: z.number().int().min(0).optional(), ownerUserId: z.uuid().nullable().optional(), expectedCloseOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const d = await loadDeal(orgId, id);
    await requireAt(req, s.db, orgId, d.locationId, P, 'edit');
    const b = req.body;
    const patch: Partial<typeof salesDeals.$inferInsert> = { ...b, updatedAt: new Date() };
    let stageNote: string | null = null;
    if (b.stageId && b.stageId !== d.stageId) {
      const stages = await ensureStages(orgId);
      const to = stages.find((st) => st.id === b.stageId);
      const from = stages.find((st) => st.id === d.stageId);
      if (!to) throw validationError('Unknown stage', { stageId: 'Not in this pipeline' });
      patch.closedAt = to.outcome === 'open' ? null : new Date();
      stageNote = `${from?.name ?? '?'} → ${to.name}`;
    }
    if (b.ownerUserId) {
      const pool = await usersWithCapabilityAt(s.db, orgId, d.locationId, P, 'edit');
      if (!pool.includes(b.ownerUserId)) throw validationError('This person has no pipeline access here', { ownerUserId: 'No access' });
    }
    const [u] = await s.db.transaction(async (tx) => {
      const r = await tx.update(salesDeals).set(patch).where(eq(salesDeals.id, id)).returning();
      if (stageNote) await tx.insert(salesActivities).values({ organizationId: orgId, dealId: id, type: 'stage_change', body: stageNote, doneAt: new Date(), createdBy: req.user!.id });
      return r;
    });
    return serializeDeal(u!, await names([u!.ownerUserId]));
  });

  const serializeActivity = (a: typeof salesActivities.$inferSelect, people: Array<{ id: string; name: string }>) => ({
    id: a.id, dealId: a.dealId, leadId: a.leadId, type: a.type, body: a.body, dueAt: a.dueAt?.toISOString() ?? null, doneAt: a.doneAt?.toISOString() ?? null,
    assignedUser: a.assignedUserId ? { id: a.assignedUserId, name: people.find((p) => p.id === a.assignedUserId)?.name ?? null } : null,
    createdBy: a.createdBy ? { id: a.createdBy, name: people.find((p) => p.id === a.createdBy)?.name ?? null } : null, createdAt: a.createdAt.toISOString(),
  });
  const activityBody = z.object({ type: z.enum(['note', 'call', 'email', 'meeting', 'task']), body: z.string().trim().min(1).max(4000), dueAt: z.iso.datetime({ offset: true }).optional(), assignedUserId: z.uuid().optional() });

  app.get('/orgs/:orgId/sales/deals/:id/activities', { schema: { tags: ['sales'], security: secured, params: idParams } }, async (req) => {
    const d = await loadDeal(req.params.orgId, req.params.id);
    await requireAt(req, s.db, req.params.orgId, d.locationId, P, 'view');
    const rows = await s.db.select().from(salesActivities).where(eq(salesActivities.dealId, d.id)).orderBy(desc(salesActivities.createdAt));
    const people = await names(rows.flatMap((r) => [r.assignedUserId, r.createdBy]));
    return { items: rows.map((r) => serializeActivity(r, people)) };
  });

  const addActivity = async (req: Parameters<typeof requireAt>[0], orgId: string, target: { dealId?: string; leadId?: string }, b: z.infer<typeof activityBody>) => {
    const [a] = await s.db.insert(salesActivities).values({ organizationId: orgId, ...target, type: b.type, body: b.body, dueAt: b.dueAt ? new Date(b.dueAt) : null, doneAt: b.type === 'task' ? null : new Date(), assignedUserId: b.assignedUserId ?? (b.type === 'task' ? req.user!.id : null), createdBy: req.user!.id }).returning();
    return serializeActivity(a!, await names([a!.assignedUserId, a!.createdBy]));
  };

  app.post('/orgs/:orgId/sales/deals/:id/activities', { schema: { tags: ['sales'], security: secured, params: idParams, body: activityBody } }, async (req, reply) => {
    const d = await loadDeal(req.params.orgId, req.params.id);
    await requireAt(req, s.db, req.params.orgId, d.locationId, P, 'edit');
    await s.db.update(salesDeals).set({ updatedAt: new Date() }).where(eq(salesDeals.id, d.id));
    return reply.code(201).send(await addActivity(req, req.params.orgId, { dealId: d.id }, req.body));
  });

  app.get('/orgs/:orgId/sales/leads/:id/activities', { schema: { tags: ['sales'], security: secured, params: idParams } }, async (req) => {
    const l = await loadLead(req.params.orgId, req.params.id);
    await requireLead(req, l, 'view');
    const rows = await s.db.select().from(salesActivities).where(eq(salesActivities.leadId, l.id)).orderBy(desc(salesActivities.createdAt));
    const people = await names(rows.flatMap((r) => [r.assignedUserId, r.createdBy]));
    return { items: rows.map((r) => serializeActivity(r, people)) };
  });

  app.post('/orgs/:orgId/sales/leads/:id/activities', { schema: { tags: ['sales'], security: secured, params: idParams, body: activityBody } }, async (req, reply) => {
    const l = await loadLead(req.params.orgId, req.params.id);
    await requireLead(req, l, 'edit');
    if (l.status === 'new') await s.db.update(leads).set({ status: 'contacted', updatedAt: new Date() }).where(eq(leads.id, l.id));
    return reply.code(201).send(await addActivity(req, req.params.orgId, { leadId: l.id }, req.body));
  });

  app.patch('/orgs/:orgId/sales/activities/:id', { schema: { tags: ['sales'], security: secured, params: idParams, body: z.object({ done: z.boolean() }) } }, async (req) => {
    const { orgId, id } = req.params;
    const [a] = await s.db.select().from(salesActivities).where(and(eq(salesActivities.id, id), eq(salesActivities.organizationId, orgId)));
    if (!a) throw notFound('Activity');
    if (a.dealId) await requireAt(req, s.db, orgId, (await loadDeal(orgId, a.dealId)).locationId, P, 'edit');
    else if (a.leadId) await requireLead(req, await loadLead(orgId, a.leadId), 'edit');
    const [u] = await s.db.update(salesActivities).set({ doneAt: req.body.done ? new Date() : null }).where(eq(salesActivities.id, id)).returning();
    return serializeActivity(u!, await names([u!.assignedUserId, u!.createdBy]));
  });

  app.get('/orgs/:orgId/sales/tasks', { schema: { tags: ['sales'], security: secured, params: orgParams, summary: 'Open tasks assigned to you' } }, async (req) => {
    const { orgId } = req.params;
    const holds = async (m: string) => { const sc = await scopeFor(req, s.db, orgId, m); return sc.all || sc.locationIds!.length > 0; };
    const anyAccess = (await holds(P)) || (await holds('sales.course_leads'));
    if (!anyAccess) return { items: [] };
    const rows = await s.db.select().from(salesActivities).where(and(eq(salesActivities.organizationId, orgId), eq(salesActivities.type, 'task'), isNull(salesActivities.doneAt), eq(salesActivities.assignedUserId, req.user!.id))).orderBy(asc(salesActivities.dueAt)).limit(200);
    const people = await names(rows.flatMap((r) => [r.assignedUserId, r.createdBy]));
    return { items: rows.map((r) => serializeActivity(r, people)) };
  });
};
