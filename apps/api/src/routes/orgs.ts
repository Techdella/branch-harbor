import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOrganizationSchema, onboardingStepUpdateSchema, ONBOARDING_STEPS, apiError, DATA_REGIONS, currency, locale, timeZone, isValidTimeZone,
  firstLocationSchema, soloPrice, priceListForCountry, priceListCurrency, listPriceMinor, NETWORK_INCLUDED_LOCATIONS, upgradeToNetworkSchema, UPGRADE_CONSEQUENCES, WEBSITE_APPROVAL_MODES, asBusinessModel, SCOPE_KINDS,
} from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, organizations, ownerGroups, regions, roleAssignments, subscriptions, users } from '../db/schema/index.ts';
import { AppError, badRequest, forbidden, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireMember, requirePerm, permissionsAt } from '../services/authz.ts';
import { onboardingState } from '../services/onboarding.ts';
import { activeLocations, businessModeView, isIndependent, loadOrg, networkPrice, planView, requireNetwork, upgradeToNetwork } from '../services/businessMode.ts';
import { hqTotal, locationBilling, quoteFor, subPlan, subPriceList } from '../services/billing.ts';
import { CUSTOMER_DATA_SHARING } from '../services/orgSettings.ts';
import { serializeLocation, serializeOrg } from '../services/serializers.ts';
import { orgParams, secured } from './_common.ts';

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.post('/orgs', {
    schema: {
      tags: ['orgs'], security: secured, summary: 'Create an organisation (onboarding). Creator becomes org_owner.',
      description: 'model "independent" is a single-location business: pass `firstLocation` to create its (only) location in the same step. Independent businesses start on the Solo plan.',
      body: createOrganizationSchema.extend({ firstLocation: firstLocationSchema.optional() }),
    },
  }, async (req, reply) => {
    const me = requireUser(req);
    const b = req.body;
    if (s.cfg.REQUIRE_EMAIL_VERIFICATION) {
      const [u] = await s.db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, me.id));
      if (!u?.v) throw new AppError(403, 'email_unverified', 'Verify your email address before creating an organisation');
    }
    if (!isValidTimeZone(b.defaultTimeZone)) throw validationError('Unknown timezone', { defaultTimeZone: 'Use an IANA timezone such as Europe/London' });
    const fl = b.firstLocation;
    if (fl?.timeZone && !isValidTimeZone(fl.timeZone)) throw validationError('Unknown timezone', { 'firstLocation.timeZone': 'Use an IANA timezone such as Europe/Lisbon' });
    const geo = fl ? await s.geocoder.geocode(`${fl.address.line1}, ${fl.address.city}, ${fl.address.country}`) : null;
    const independent = b.model === 'independent';
    // The plan is billed in the currency and price list of the billing country (provisionally the organisation's
    // country; locked at checkout against the card) from the shared price book — never a currency the client picks.
    const priceList = priceListForCountry(b.country);
    const solo = independent ? soloPrice(priceList.key) : null;
    const { org, location } = await s.db.transaction(async (tx) => {
      let slug = slugify(b.name);
      const [{ c } = { c: 0 }] = await tx.select({ c: count() }).from(organizations).where(eq(organizations.slug, slug));
      if (c > 0) slug = `${slug}-${crypto.randomUUID().slice(0, 6)}`;
      const now = new Date().toISOString();
      const [org] = await tx.insert(organizations).values({
        slug, name: b.name, industry: b.industry, model: b.model, country: b.country, defaultCurrency: b.defaultCurrency,
        defaultLocale: b.defaultLocale, defaultTimeZone: b.defaultTimeZone, dataRegion: b.dataRegion,
        applicationFeeBps: s.cfg.STRIPE_APPLICATION_FEE_BPS,
        onboarding: {
          industry: { status: 'complete', updatedAt: now }, business_details: { status: 'complete', updatedAt: now },
          ...(fl ? { first_location: { status: 'complete' as const, updatedAt: now } } : {}),
        },
      }).returning();
      await tx.insert(roleAssignments).values({ organizationId: org!.id, userId: me.id, role: 'org_owner', scopeKind: 'organization', scopeId: org!.id, createdBy: me.id });
      // No free plan and no free trial: the subscription waits for the paid 14-day trial checkout (Settings → Billing).
      // Independent businesses are on Solo (one location, flat price); networks on the Network plan by default.
      await tx.insert(subscriptions).values({
        organizationId: org!.id, currency: priceList.currency, priceList: priceList.key, billingCountry: b.country.toUpperCase(),
        plan: independent ? 'solo' : 'network', status: 'checkout_required',
        pricePerLocationMinor: solo?.amount ?? null, billedLocationCount: 0, currentPeriodEnd: null,
      });
      await audit(tx, { organizationId: org!.id, ...actor(req), action: 'org.created', scopeKind: 'organization', scopeId: org!.id, targetType: 'organization', targetId: org!.id, metadata: { model: b.model, withFirstLocation: !!fl } });
      let location: typeof locations.$inferSelect | null = null;
      if (fl) {
        // The business's one location is named after where it is (e.g. "Alfama"); the business name stays on the organisation.
        const name = fl.name?.trim() || fl.address.city;
        const [l] = await tx.insert(locations).values({
          organizationId: org!.id, name, code: (fl.code ?? 'MAIN').toUpperCase(), slug: slugify(name) || 'main',
          address: fl.address, country: fl.address.country, timeZone: fl.timeZone ?? b.defaultTimeZone, currency: fl.currency ?? b.defaultCurrency,
          locale: b.defaultLocale, phone: fl.phone ?? null, email: fl.email ?? null, hours: fl.hours ?? null, status: 'onboarding', geo,
        }).returning();
        location = l!;
        await audit(tx, { organizationId: org!.id, ...actor(req), action: 'location.created', scopeKind: 'location', scopeId: l!.id, targetType: 'location', targetId: l!.id, metadata: { via: 'org_create' } });
      }
      return { org: org!, location };
    });
    return reply.code(201).send({
      ...serializeOrg(org),
      businessMode: businessModeView(org, location?.id ?? null),
      firstLocation: location ? serializeLocation(location) : null,
    });
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
    const locs = await activeLocations(s.db, org.id);
    return { ...serializeOrg(org), myOrgPermissions: permissions, locationCount: locs.length, businessMode: businessModeView(org, locs[0]?.id ?? null) };
  });

  app.patch('/orgs/:orgId', {
    schema: {
      tags: ['orgs'], security: secured, params: orgParams,
      body: z.object({
        name: z.string().min(1).optional(), defaultCurrency: currency.optional(), defaultLocale: locale.optional(), defaultTimeZone: timeZone.optional(),
        paymentAccountMode: z.enum(['per_location', 'shared']).optional(), applicationFeeBps: z.number().int().min(0).max(3000).optional(),
        dataRegion: z.enum(DATA_REGIONS).optional(),
        customerDataSharing: z.enum(CUSTOMER_DATA_SHARING).optional().describe('off (default) | totals_only | shared'),
        aiTrainingOptOut: z.boolean().optional().describe('true (default): business data is never used to train AI models'),
        refundApprovalThresholds: z.partialRecord(currency, z.number().int().min(0)).optional().describe('Refunds above this amount (minor units, per currency) need approval'),
        websiteApprovals: z.enum(WEBSITE_APPROVAL_MODES).optional().describe('Independent businesses only. off (default): edits apply and publish directly. staff: edits by people without approval rights need the owner\'s approval.'),
        industry: z.string().optional().describe('Read-only. The industry is fixed when the business account is created (one industry per account); sending a different value returns 409 industry_locked.'),
      }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'org.manage', { organizationId: orgId, kind: 'organization', id: orgId });
    const { customerDataSharing, aiTrainingOptOut, refundApprovalThresholds, websiteApprovals, industry, ...orgFields } = req.body;
    if (req.body.defaultTimeZone && !isValidTimeZone(req.body.defaultTimeZone)) throw validationError('Unknown timezone', { defaultTimeZone: 'Invalid IANA timezone' });
    const [before] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!before) throw notFound('Organisation');
    if (industry !== undefined && industry !== before.industry) {
      throw new AppError(409, 'industry_locked', 'The industry is fixed when a business account is created. To run another industry, create a second business account under the same login.');
    }
    if (req.body.dataRegion && req.body.dataRegion !== before.dataRegion) {
      throw new AppError(409, 'data_region_locked', 'Data region cannot be changed after creation without a migration. Contact support.');
    }
    // Policies are merged into settings so other keys (e.g. the hosted-site theme) are preserved.
    if (websiteApprovals !== undefined && !isIndependent(before)) {
      throw validationError('Networks control approvals with template field policies', { websiteApprovals: 'Only available to independent businesses' });
    }
    const policyChanges = Object.fromEntries(Object.entries({ customerDataSharing, aiTrainingOptOut, refundApprovalThresholds, websiteApprovals }).filter(([, v]) => v !== undefined));
    const settings = Object.keys(policyChanges).length ? { ...before.settings, ...policyChanges } : before.settings;
    const [org] = await s.db.update(organizations).set({ ...orgFields, settings, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'org.updated', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId, metadata: { changes: { ...req.body, industry: undefined } } });
    const locs = await activeLocations(s.db, orgId);
    return { ...serializeOrg(org!), businessMode: businessModeView(org!, locs[0]?.id ?? null) };
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
    app.get(`/orgs/:orgId/${path}`, { schema: { tags: ['orgs'], security: secured, params: orgParams, description: 'Independent businesses have none: the list is empty with `hidden: true` until they upgrade to a network.' } }, async (req) => {
      await requireMember(req, s.db, req.params.orgId);
      const org = await loadOrg(s.db, req.params.orgId);
      if (org && isIndependent(org)) return { items: [], hidden: true, reason: 'independent_business' };
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
      const org = await loadOrg(s.db, orgId);
      if (org) requireNetwork(org, path === 'regions' ? 'Regions' : 'Owner groups');
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
    const locs = await s.db.select({ id: locations.id, name: locations.name, status: locations.status, archivedAt: locations.archivedAt }).from(locations).where(eq(locations.organizationId, orgId));
    const org = await loadOrg(s.db, orgId);
    const model = asBusinessModel(org?.model);
    const plan = planView(sub, model);
    if (plan.key === 'solo') {
      // Solo: one flat price for the single location, whatever its status.
      const price = plan.price;
      return {
        ...sub, plan: 'solo', businessModel: model, planDetails: plan, activeLocationCount: c, billingProvider: s.payments.mode === 'live' ? 'stripe' : 'sandbox',
        pricePerLocation: null,
        estimatedTotal: price ? { amount: price.amount, currency: price.currency, interval: price.interval } : null,
        locations: locs.filter((l) => !l.archivedAt).map((l) => ({ id: l.id, name: l.name, status: l.status, billed: true, price })),
        upgrade: { available: true, path: `/v1/orgs/${orgId}/upgrade-to-network`, note: 'Adding a second location moves you to per-location network pricing.' },
      };
    }
    // Network: the HQ platform fee (includes 3 locations) + the per-location fee beyond; other plans per location.
    const rows = await locationBilling(s.db, orgId, sub, model);
    const quote = quoteFor(sub, subPlan(sub, model), sub.billingInterval === 'year' ? 'year' : 'month', rows.length);
    const perLoc = plan.price;
    return {
      ...sub, businessModel: model, planDetails: plan, activeLocationCount: c, billingProvider: s.payments.mode === 'live' ? 'stripe' : 'sandbox',
      pricePerLocation: perLoc,
      platformFee: plan.platformFee,
      estimatedTotal: { amount: hqTotal(quote, rows), currency: quote.currency, interval: quote.interval },
      locations: locs.map((l) => {
        const r = rows.find((x) => x.id === l.id);
        return { id: l.id, name: l.name, status: l.status, billed: !!r && !r.included, included: !!r?.included, payer: r?.payer ?? null, price: r && !r.included && perLoc ? perLoc : null };
      }),
    };
  });

  // ── Business mode: independent → network ──
  const requireOwner = async (req: Parameters<typeof requireMember>[0], orgId: string) => {
    const mine = await requireMember(req, s.db, orgId);
    if (!mine.some((a) => a.role === 'org_owner' && a.scopeKind === 'organization')) throw forbidden('Only the business owner can change the business model');
  };

  app.get('/orgs/:orgId/upgrade-to-network', {
    schema: { tags: ['orgs'], security: secured, params: orgParams, summary: 'Preview what upgrading an independent business to a network changes (owner only)' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireOwner(req, orgId);
    const org = await loadOrg(s.db, orgId);
    if (!org) throw notFound('Organisation');
    const [sub] = await s.db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    const locs = await activeLocations(s.db, orgId);
    const list = sub ? subPriceList(sub) : priceListForCountry(org.country).key;
    const per = networkPrice(list);
    return {
      model: org.model, canUpgrade: isIndependent(org), consequences: UPGRADE_CONSEQUENCES, locationCount: locs.length,
      currentPlan: sub ? planView(sub, asBusinessModel(org.model)) : null,
      nextPlan: {
        key: 'network', name: 'Network', pricing: 'per_location', price: per != null ? { amount: per, currency: priceListCurrency(list), interval: 'month' } : null,
        platformFee: { amount: listPriceMinor(list, 'platform'), currency: priceListCurrency(list), interval: 'month', includedLocations: NETWORK_INCLUDED_LOCATIONS },
      },
      keeps: ['locations', 'customers', 'websites', 'pages', 'team', 'payments', 'bookings', 'orders', 'reports'],
    };
  });

  app.post('/orgs/:orgId/upgrade-to-network', {
    schema: {
      tags: ['orgs'], security: secured, params: orgParams, body: upgradeToNetworkSchema,
      summary: 'Upgrade an independent business to a network (owner only, audited). Keeps all data; enables regions, owner groups, template policies, group publishing and network roles.',
    },
  }, async (req) => {
    const { orgId } = req.params;
    await requireOwner(req, orgId);
    const org = await loadOrg(s.db, orgId);
    if (!org) throw notFound('Organisation');
    if (!isIndependent(org)) throw new AppError(409, 'already_network', 'This organisation is already a network.');
    const updated = await s.db.transaction((tx) => upgradeToNetwork(tx, org, { actorUserId: requireUser(req).id, ip: req.ip, reason: req.body.reason ?? null, trigger: 'explicit' }, s.cfg.SITES_BASE_URL));
    const locs = await activeLocations(s.db, orgId);
    return { ...serializeOrg(updated), businessMode: businessModeView(updated, locs[0]?.id ?? null), upgraded: true };
  });

  app.get('/orgs/:orgId/permissions', {
    schema: { tags: ['orgs'], security: secured, params: orgParams, querystring: z.object({ scopeKind: z.enum(SCOPE_KINDS).default('organization'), scopeId: z.uuid().optional() }), summary: 'Effective permissions in a scope (for hiding controls; enforcement is server-side)' },
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
