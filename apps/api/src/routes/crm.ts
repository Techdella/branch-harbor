import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auditEvents, campaigns, consentRecords, customers, guardianRelationships, leads } from '../db/schema/index.ts';
import { notFound } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { idParams, orgParams, secured } from './_common.ts';

export const crmRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.get('/orgs/:orgId/customers', {
    schema: {
      tags: ['orgs'], security: secured, params: orgParams, querystring: z.object({ q: z.string().max(80).optional(), locationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      summary: 'Customers at locations where you hold customers.read. Network reporting access does not grant customer access.',
    },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'customers.read');
    const conds = [eq(customers.organizationId, orgId), isNull(customers.erasedAt)];
    if (allowed !== 'all') {
      if (!allowed.size) return { items: [] };
      conds.push(inArray(customers.locationId, [...allowed]));
    }
    if (req.query.locationId) conds.push(eq(customers.locationId, req.query.locationId));
    if (req.query.q) conds.push(sql`(${customers.name} ilike ${'%' + req.query.q + '%'} or ${customers.email} ilike ${'%' + req.query.q + '%'})`);
    return { items: await s.db.select().from(customers).where(and(...conds)).orderBy(desc(customers.createdAt)).limit(req.query.limit) };
  });

  app.get('/orgs/:orgId/customers/:id', { schema: { tags: ['orgs'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
    if (!c || !c.locationId) throw notFound('Customer');
    await requireLocationPerm(req, s.db, orgId, c.locationId, 'customers.read');
    const consents = await s.db.select().from(consentRecords).where(eq(consentRecords.customerId, id)).orderBy(desc(consentRecords.recordedAt));
    const guardians = await s.db.select().from(guardianRelationships).where(eq(guardianRelationships.participantCustomerId, id));
    return { ...c, consents, guardians };
  });

  app.delete('/orgs/:orgId/customers/:id', {
    schema: { tags: ['orgs'], security: secured, params: idParams, summary: 'Erase a customer (right to erasure). PII is cleared; a tombstone keeps financial records consistent.' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
    if (!c || !c.locationId) throw notFound('Customer');
    await requireLocationPerm(req, s.db, orgId, c.locationId, 'customers.write');
    await s.db.transaction(async (tx) => {
      await tx.update(customers).set({ name: 'Erased customer', email: null, phone: null, dateOfBirth: null, notes: null, erasedAt: new Date(), updatedAt: new Date() }).where(eq(customers.id, id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'privacy.customer_erased', scopeKind: 'location', scopeId: c.locationId, targetType: 'customer', targetId: id });
    });
    return { id, erased: true };
  });

  app.post('/orgs/:orgId/customers/:id/consents', {
    schema: { tags: ['orgs'], security: secured, params: idParams, body: z.object({ purpose: z.string().min(1), version: z.string().min(1), granted: z.boolean(), source: z.string().default('staff') }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
    if (!c || !c.locationId) throw notFound('Customer');
    await requireLocationPerm(req, s.db, orgId, c.locationId, 'customers.write');
    const [row] = await s.db.insert(consentRecords).values({ organizationId: orgId, customerId: id, email: c.email, ...req.body, ip: req.ip }).returning();
    return reply.code(201).send(row);
  });

  app.get('/orgs/:orgId/leads', { schema: { tags: ['orgs'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'customers.read');
    const rows = await s.db.select().from(leads).where(eq(leads.organizationId, orgId)).orderBy(desc(leads.createdAt)).limit(200);
    return { items: rows.filter((l) => allowed === 'all' || (l.locationId && allowed.has(l.locationId))) };
  });

  app.get('/orgs/:orgId/campaigns', { schema: { tags: ['orgs'], security: secured, params: orgParams } }, async (req) => {
    await requirePerm(req, s.db, 'marketing.draft', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId }).catch(async () => {
      // Location-level marketers see campaigns scoped to their locations.
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'marketing.draft');
      if (allowed !== 'all' && !allowed.size) throw notFound('Campaigns');
    });
    return { items: await s.db.select().from(campaigns).where(eq(campaigns.organizationId, req.params.orgId)).orderBy(desc(campaigns.createdAt)) };
  });

  app.post('/orgs/:orgId/campaigns', {
    schema: {
      tags: ['orgs'], security: secured, params: orgParams,
      body: z.object({ name: z.string().min(1), channel: z.enum(['email', 'sms', 'social', 'ads', 'web']).default('email'), scope: z.object({ kind: z.enum(['organization', 'region', 'owner_group', 'location']), id: z.uuid() }), content: z.record(z.string(), z.unknown()).default({}) }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'marketing.draft', { organizationId: orgId, ...req.body.scope });
    const [c] = await s.db.insert(campaigns).values({ organizationId: orgId, name: req.body.name, channel: req.body.channel, scopeKind: req.body.scope.kind, scopeId: req.body.scope.id, content: req.body.content, status: 'draft', createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'campaign.drafted', scopeKind: req.body.scope.kind, scopeId: req.body.scope.id, targetType: 'campaign', targetId: c!.id });
    return reply.code(201).send(c);
  });

  app.get('/orgs/:orgId/audit-events', {
    schema: { tags: ['audit'], security: secured, params: orgParams, querystring: z.object({ action: z.string().optional(), targetId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'audit.read', { organizationId: orgId, kind: 'organization', id: orgId });
    const conds = [eq(auditEvents.organizationId, orgId)];
    if (req.query.action) conds.push(eq(auditEvents.action, req.query.action));
    if (req.query.targetId) conds.push(eq(auditEvents.targetId, req.query.targetId));
    return { items: await s.db.select().from(auditEvents).where(and(...conds)).orderBy(desc(auditEvents.createdAt)).limit(req.query.limit) };
  });
};
