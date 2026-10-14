import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createOrganizationSchema, onboardingStepUpdateSchema, ONBOARDING_STEPS, apiError, DATA_REGIONS, currency, locale, timeZone, isValidTimeZone } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, organizations, ownerGroups, regions, roleAssignments, subscriptions, users } from '../db/schema/index.ts';
import { AppError, badRequest, forbidden, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireMember, requirePerm, permissionsAt } from '../services/authz.ts';
import { onboardingState } from '../services/onboarding.ts';
import { serializeOrg } from '../services/serializers.ts';
import { orgParams, secured } from './_common.ts';

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.post('/orgs', {
    schema: { tags: ['orgs'], security: secured, summary: 'Create an organisation (onboarding). Creator becomes org_owner.', body: createOrganizationSchema },
  }, async (req, reply) => {
    const me = requireUser(req);
    const b = req.body;
    if (s.cfg.REQUIRE_EMAIL_VERIFICATION) {
      const [u] = await s.db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, me.id));
      if (!u?.v) throw new AppError(403, 'email_unverified', 'Verify your email address before creating an organisation');
    }
    if (!isValidTimeZone(b.defaultTimeZone)) throw validationError('Unknown timezone', { defaultTimeZone: 'Use an IANA timezone such as Europe/London' });
    const org = await s.db.transaction(async (tx) => {
      let slug = slugify(b.name);
      const [{ c } = { c: 0 }] = await tx.select({ c: count() }).from(organizations).where(eq(organizations.slug, slug));
      if (c > 0) slug = `${slug}-${crypto.randomUUID().slice(0, 6)}`;
      const now = new Date().toISOString();
      const [org] = await tx.insert(organizations).values({
        slug, name: b.name, industry: b.industry, model: b.model, country: b.country, defaultCurrency: b.defaultCurrency,
        defaultLocale: b.defaultLocale, defaultTimeZone: b.defaultTimeZone, dataRegion: b.dataRegion,
        applicationFeeBps: s.cfg.STRIPE_APPLICATION_FEE_BPS,
        onboarding: { industry: { status: 'complete', updatedAt: now }, business_details: { status: 'complete', updatedAt: now } },
      }).returning();
      await tx.insert(roleAssignments).values({ organizationId: org!.id, userId: me.id, role: 'org_owner', scopeKind: 'organization', scopeId: org!.id, createdBy: me.id });
      await tx.insert(subscriptions).values({ organizationId: org!.id, currency: b.defaultCurrency, plan: 'trial', status: 'trialing', currentPeriodEnd: new Date(Date.now() + 14 * 86400_000) });
      await audit(tx, { organizationId: org!.id, ...actor(req), action: 'org.created', scopeKind: 'organization', scopeId: org!.id, targetType: 'organization', targetId: org!.id });
      return org!;
    });
    return reply.code(201).send(serializeOrg(org));
  });

  app.get('/orgs', { schema: { tags: ['orgs'], security: secured, summary: 'Organisations the current user belongs to' } }, async (req) => {
    const me = requireUser(req);
    const rows = await s.db.selectDistinct({ org: organizations }).from(organizations).innerJoin(roleAssignments, eq(roleAssignments.organizationId, organizations.id)).where(eq(roleAssignments.userId, me.id));
    return { items: rows.map((r) => serializeOrg(r.org)) };
  });

  app.get('/orgs/:orgId', { schema: { tags: ['orgs'], security: secured, params: orgParams } }, async (req) => {
    await requireMember(req, s.db, req.params.orgId);
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
    if (!org) throw notFound('Organisation');
    const permissions = await permissionsAt(req, s.db, { organizationId: org.id, kind: 'organization', id: org.id });
    return { ...serializeOrg(org), myOrgPermissions: permissions };
  });

  app.patch('/orgs/:orgId', {
    schema: {
      tags: ['orgs'], security: secured, params: orgParams,
      body: z.object({
        name: z.string().min(1).optional(), defaultCurrency: currency.optional(), defaultLocale: locale.optional(), defaultTimeZone: timeZone.optional(),
        paymentAccountMode: z.enum(['per_location', 'shared']).optional(), applicationFeeBps: z.number().int().min(0).max(3000).optional(),
        dataRegion: z.enum(DATA_REGIONS).optional(),
      }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'org.manage', { organizationId: orgId, kind: 'organization', id: orgId });
    if (req.body.defaultTimeZone && !isValidTimeZone(req.body.defaultTimeZone)) throw validationError('Unknown timezone', { defaultTimeZone: 'Invalid IANA timezone' });
    const [before] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!before) throw notFound('Organisation');
    if (req.body.dataRegion && req.body.dataRegion !== before.dataRegion) {
      throw new AppError(409, 'data_region_locked', 'Data region cannot be changed after creation without a migration. Contact support.');
    }
    const [org] = await s.db.update(organizations).set({ ...req.body, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'org.updated', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId, metadata: { changes: req.body } });
    return serializeOrg(org!);
  });

  // ── Onboarding checklist ──
  app.get('/orgs/:orgId/onboarding', { schema: { tags: ['orgs'], security: secured, params: orgParams, summary: 'Onboarding checklist (9 steps, spec §7)' } }, async (req) => {
    await requireMember(req, s.db, req.params.orgId);
    const st = await onboardingState(s.db, req.params.orgId, requireUser(req).id);
    if (!st) throw notFound('Organisation');
    return st;
  });

  app.put('/orgs/:orgId/onboarding/:step', {
    schema: { tags: ['orgs'], security: secured, params: orgParams.extend({ step: z.enum(ONBOARDING_STEPS.map((x) => x.key) as [string, ...string[]]) }), body: onboardingStepUpdateSchema },
  }, async (req) => {
    const { orgId, step } = req.params;
    await requirePerm(req, s.db, 'org.manage', { organizationId: orgId, kind: 'organization', id: orgId });
    const def = ONBOARDING_STEPS.find((x) => x.key === step)!;
    if (req.body.status === 'skipped' && !def.optional) throw badRequest(`"${def.title}" is required and cannot be skipped`);
    const [org] = await s.db.select({ onboarding: organizations.onboarding }).from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw notFound('Organisation');
    const next = { ...org.onboarding, [step]: { status: req.body.status, data: req.body.data ?? org.onboarding[step]?.data, updatedAt: new Date().toISOString() } };
    await s.db.update(organizations).set({ onboarding: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return onboardingState(s.db, orgId, requireUser(req).id);
  });

  // ── Regions & owner groups ──
  for (const [path, table, label] of [['regions', regions, 'Region'], ['owner-groups', ownerGroups, 'Owner group']] as const) {
    app.get(`/orgs/:orgId/${path}`, { schema: { tags: ['orgs'], security: secured, params: orgParams } }, async (req) => {
      await requireMember(req, s.db, req.params.orgId);
      const rows = await s.db.select().from(table).where(eq(table.organizationId, req.params.orgId));
      const counts = await s.db
        .select({ id: path === 'regions' ? locations.regionId : locations.ownerGroupId, c: count() })
        .from(locations).where(eq(locations.organizationId, req.params.orgId))
        .groupBy(path === 'regions' ? locations.regionId : locations.ownerGroupId);
      return { items: rows.map((r) => ({ ...r, locationCount: counts.find((c) => c.id === r.id)?.c ?? 0 })) };
    });
    app.post(`/orgs/:orgId/${path}`, {
      schema: { tags: ['orgs'], security: secured, params: orgParams, body: z.object({ name: z.string().min(1).max(120), legalName: z.string().max(200).optional() }) },
    }, async (req, reply) => {
      const { orgId } = req.params;
      await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'organization', id: orgId });
      const values = path === 'regions' ? { organizationId: orgId, name: req.body.name } : { organizationId: orgId, name: req.body.name, legalName: req.body.legalName ?? null };
      const [row] = await s.db.insert(table).values(values).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: `${path}.created`, targetType: label, targetId: row!.id });
      return reply.code(201).send(row);
    });
  }

  app.get('/orgs/:orgId/subscription', { schema: { tags: ['orgs'], security: secured, params: orgParams, summary: 'BranchHarbor plan billing (separate from customer payments)' } }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'billing.manage', { organizationId: orgId, kind: 'organization', id: orgId });
    const [sub] = await s.db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    const [{ c } = { c: 0 }] = await s.db.select({ c: count() }).from(locations).where(and(eq(locations.organizationId, orgId)));
    if (!sub) throw notFound('Subscription');
    return { ...sub, activeLocationCount: c, billingProvider: s.payments.mode === 'live' ? 'stripe' : 'sandbox' };
  });

  app.get('/orgs/:orgId/permissions', {
    schema: { tags: ['orgs'], security: secured, params: orgParams, querystring: z.object({ scopeKind: z.enum(['organization', 'region', 'owner_group', 'location']).default('organization'), scopeId: z.uuid().optional() }), summary: 'Effective permissions in a scope (for hiding controls; enforcement is server-side)' },
  }, async (req) => {
    const { orgId } = req.params;
    const id = req.query.scopeId ?? orgId;
    if (req.query.scopeKind !== 'organization' && !req.query.scopeId) throw badRequest('scopeId is required');
    const perms = await permissionsAt(req, s.db, { organizationId: orgId, kind: req.query.scopeKind, id }).catch((e) => {
      if (e instanceof AppError) throw e;
      throw forbidden();
    });
    return { scope: { kind: req.query.scopeKind, id }, permissions: perms };
  });
};
