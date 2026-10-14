import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { domains, websites } from '../db/schema/index.ts';
import { normaliseHostname } from '../domain/domainState.ts';
import { randomToken } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { serializeDomain, verifyDomain } from '../services/domains.ts';
import { idParams, orgParams, secured } from './_common.ts';

export const domainRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  const scopeOf = (orgId: string, locationId: string | null): ScopeTarget => (locationId ? { organizationId: orgId, kind: 'location', id: locationId } : { organizationId: orgId, kind: 'organization', id: orgId });

  async function load(orgId: string, id: string) {
    const [d] = await s.db.select().from(domains).where(and(eq(domains.id, id), eq(domains.organizationId, orgId)));
    if (!d) throw notFound('Domain');
    return d;
  }

  app.get('/orgs/:orgId/domains', { schema: { tags: ['domains'], security: secured, params: orgParams } }, async (req) => {
    const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'website.publish');
    const rows = await s.db.select().from(domains).where(eq(domains.organizationId, req.params.orgId));
    return { items: rows.filter((d) => allowed === 'all' || (d.locationId && allowed.has(d.locationId))).map(serializeDomain) };
  });

  app.post('/orgs/:orgId/domains', {
    schema: {
      tags: ['domains'], security: secured, params: orgParams,
      summary: 'Connect a domain: returns the exact DNS records (CNAME + TXT verification) to add',
      body: z.object({ hostname: z.string().min(4).max(253), websiteId: z.uuid() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const hostname = normaliseHostname(req.body.hostname);
    if (!hostname) throw validationError('Enter a valid domain such as www.example.com', { hostname: 'Invalid hostname' });
    const [site] = await s.db.select().from(websites).where(and(eq(websites.id, req.body.websiteId), eq(websites.organizationId, orgId)));
    if (!site) throw notFound('Website');
    await requirePerm(req, s.db, 'website.publish', scopeOf(orgId, site.locationId));
    const [taken] = await s.db.select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname));
    if (taken) throw conflict('hostname_taken', 'This domain is already connected to a BranchHarbor site');
    const token = randomToken(16);
    const reg = await s.domains.register(hostname, token);
    const [d] = await s.db.insert(domains).values({
      organizationId: orgId, websiteId: site.id, locationId: site.locationId, hostname, state: 'awaiting_dns', verificationToken: token,
      dnsRecords: reg.records, provider: s.domains.mode, providerHostnameId: reg.providerHostnameId,
    }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'domain.added', scopeKind: site.locationId ? 'location' : 'organization', scopeId: site.locationId ?? orgId, targetType: 'domain', targetId: d!.id, metadata: { hostname } });
    return reply.code(201).send(serializeDomain(d!));
  });

  app.get('/orgs/:orgId/domains/:id', { schema: { tags: ['domains'], security: secured, params: idParams } }, async (req) => {
    const d = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.publish', scopeOf(req.params.orgId, d.locationId));
    return serializeDomain(d);
  });

  app.post('/orgs/:orgId/domains/:id/verify', {
    schema: { tags: ['domains'], security: secured, params: idParams, summary: 'Run verification: awaiting_dns → verifying → certificate_pending → ready (or failed). Retrying a failed domain restarts at awaiting_dns.' },
  }, async (req) => {
    const d = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.publish', scopeOf(req.params.orgId, d.locationId));
    const r = await verifyDomain(s, d, req.user!.id);
    return { ...serializeDomain(r.domain), transition: r.transition };
  });

  app.post('/orgs/:orgId/domains/:id/primary', { schema: { tags: ['domains'], security: secured, params: idParams, summary: 'Make a ready domain the primary address' } }, async (req) => {
    const d = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.publish', scopeOf(req.params.orgId, d.locationId));
    if (d.state !== 'ready') throw conflict('domain_not_ready', 'Only a ready domain can become the primary address');
    await s.db.transaction(async (tx) => {
      if (d.websiteId) {
        await tx.update(domains).set({ isPrimary: false }).where(eq(domains.websiteId, d.websiteId));
        await tx.update(websites).set({ primaryDomainId: d.id, updatedAt: new Date() }).where(eq(websites.id, d.websiteId));
      }
      await tx.update(domains).set({ isPrimary: true, updatedAt: new Date() }).where(eq(domains.id, d.id));
      await audit(tx, { organizationId: d.organizationId, ...actor(req), action: 'domain.set_primary', targetType: 'domain', targetId: d.id });
    });
    return serializeDomain((await load(req.params.orgId, d.id)));
  });

  app.delete('/orgs/:orgId/domains/:id', { schema: { tags: ['domains'], security: secured, params: idParams } }, async (req) => {
    const d = await load(req.params.orgId, req.params.id);
    await requirePerm(req, s.db, 'website.publish', scopeOf(req.params.orgId, d.locationId));
    await s.domains.remove(d.providerHostnameId).catch((err) => req.log.warn({ err }, 'provider hostname removal failed'));
    await s.db.transaction(async (tx) => {
      if (d.isPrimary && d.websiteId) await tx.update(websites).set({ primaryDomainId: null }).where(eq(websites.id, d.websiteId));
      await tx.delete(domains).where(eq(domains.id, d.id));
      await audit(tx, { organizationId: d.organizationId, ...actor(req), action: 'domain.removed', targetType: 'domain', targetId: d.id, metadata: { hostname: d.hostname } });
    });
    return { id: d.id, removed: true };
  });
};
