import { and, arrayContained, arrayContains, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  FRANCHISE_STAGES, MANUAL_STAGES, PROSPECT_SOURCES, REGISTRATION_STATUSES, RULES_DISCLAIMER, TERRITORY_STATUSES, addressSchema, currency, evaluateFranchiseCompliance,
  isValidTimeZone, jurisdictionCode, stageIndex, timeZone, type FranchiseStage, type JurisdictionRule,
} from '@bh/shared';
import {
  franchiseAgreements, franchiseCadences, franchiseDeliveries, franchiseDocuments, franchiseEmailTemplates, franchiseFeeInvoices, franchiseJurisdictionRules, franchiseProjects,
  franchiseProspects, franchiseRegistrations, franchiseSignatures, franchiseTasks, franchiseTerritories, locations, organizations, ownerGroups,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { brandInOrg, brandOwnedCond, brandSharedCond } from '../services/brands.ts';
import { authorisedLocations, capabilityTerritories, requireMember, resolveScopeChain } from '../services/authz.ts';
import { esignStatus, ESIGN_DISCLAIMER } from '../integrations/esign.ts';
import {
  LEGAL_ONLY_KINDS, addActivity, generateCadenceTasks, assertCanReadDocument, assertProjectAccess, completeSignature, createFeeInvoice, decodeUpload, ensureFranchiseDefaults, franchiseSettings,
  documentEditPerm, getProject, getProspect, listOrderedActivities, loadRules, orgHas, prospectCompliance, provisionLocation, requestGoLive, requireAnyOrgPerm, requireOrgPerm, runFranchiseJobs,
  sendAgreement, sendDisclosure, serializeAgreement, serializeDocument, serializeProspect, serializeTask, setStage, userNames,
} from '../services/franchise.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

const tags = ['franchise'];
const country = z.string().length(2).transform((s) => s.toUpperCase());
const region = z.string().trim().min(1).max(10).transform((s) => s.toUpperCase().replace(/^[A-Z]{2}-/, ''));
const bps = z.number().int().min(0).max(10_000);
const termsSchema = z.object({
  startDate: z.iso.date().optional(), termYears: z.number().int().min(1).max(50).optional(), renewalOption: z.string().max(500).optional(),
  royaltyBps: bps.optional(), marketingFundBps: bps.optional(), territory: z.string().max(200).optional(), units: z.number().int().min(1).max(100).optional(),
});

export const franchiseRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  // Franchise pipeline, agreements or disclosure (capabilities sales.franchise_pipeline, legal.agreements, legal.disclosure).
  const VIEW = ['franchise.pipeline.view', 'legal.view', 'disclosure.view'] as const;

  /**
   * Franchise pipeline scope: 'all' organisation-wide, or the territories (sub-networks) the person runs the pipeline
   * for — a master franchisee or area developer sees and works only their territory's prospects.
   */
  const pipeline = async (req: FastifyRequest, orgId: string, action: 'view' | 'edit') => {
    const t = await capabilityTerritories(req, s.db, orgId, 'sales.franchise_pipeline', action);
    if (t !== 'all' && !t.size) throw forbidden(`Missing permission franchise.pipeline.${action}`);
    return t;
  };
  const inPipeline = (t: 'all' | Set<string>, territoryId: string | null | undefined) => t === 'all' || (!!territoryId && t.has(territoryId));
  /** A prospect inside the person's pipeline scope (404 outside it: no enumeration). */
  const prospectIn = async (req: FastifyRequest, orgId: string, id: string, action: 'view' | 'edit') => {
    const t = await pipeline(req, orgId, action);
    const p = await getProspect(s.db, orgId, id);
    if (!inPipeline(t, p.scopeTerritoryId)) throw notFound('Prospect');
    return p;
  };
  /** Settings and rules: anyone with the pipeline (any territory), agreements or disclosure. */
  const requireFranchiseView = async (req: FastifyRequest, orgId: string) => {
    const t = await capabilityTerritories(req, s.db, orgId, 'sales.franchise_pipeline', 'view');
    if (t === 'all' || t.size) return;
    await requireAnyOrgPerm(req, s.db, orgId, [...VIEW]);
  };

  /* ------------------------------- settings ------------------------------ */

  app.get('/orgs/:orgId/franchise/settings', { schema: { tags, security: secured, params: orgParams, summary: 'Franchise development settings, e-signature providers and the compliance disclaimer' } }, async (req) => {
    const { orgId } = req.params;
    await requireFranchiseView(req, orgId);
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const editScope = await capabilityTerritories(req, s.db, orgId, 'sales.franchise_pipeline', 'edit');
    return {
      ...franchiseSettings(org!), brandSlug: org!.slug, esign: esignStatus(), esignDisclaimer: ESIGN_DISCLAIMER, disclaimer: RULES_DISCLAIMER,
      canEdit: editScope === 'all' || editScope.size > 0, territoryScoped: editScope !== 'all' && (await capabilityTerritories(req, s.db, orgId, 'sales.franchise_pipeline', 'view')) !== 'all', legal: { view: await orgHas(req, s.db, orgId, 'legal.view'), edit: await orgHas(req, s.db, orgId, 'legal.edit') },
      disclosure: { view: await orgHas(req, s.db, orgId, 'disclosure.view'), edit: await orgHas(req, s.db, orgId, 'disclosure.edit'), approve: await orgHas(req, s.db, orgId, 'disclosure.approve') },
    };
  });

  app.put('/orgs/:orgId/franchise/settings', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ homeRegion: z.string().max(10).nullable().optional(), enquiryFormEnabled: z.boolean().optional(), defaultOwnerUserId: z.uuid().nullable().optional(), collectLocationId: z.uuid().nullable().optional() }) },
  }, async (req) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const cur = (org!.settings.franchise ?? {}) as Record<string, unknown>;
    const next = { ...cur, ...req.body, ...(req.body.homeRegion ? { homeRegion: req.body.homeRegion.toUpperCase().replace(/^[A-Z]{2}-/, '') } : {}) };
    await s.db.update(organizations).set({ settings: { ...org!.settings, franchise: next }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.settings_updated', metadata: req.body, ip: req.ip });
    return franchiseSettings({ country: org!.country, settings: { ...org!.settings, franchise: next } });
  });

  /* -------------------------------- rules -------------------------------- */

  app.get('/orgs/:orgId/franchise/rules', { schema: { tags, security: secured, params: orgParams, summary: 'Jurisdiction rules (compliance aid, not legal advice): platform versions plus this organisation’s own versions' } }, async (req) => {
    const { orgId } = req.params;
    await requireFranchiseView(req, orgId);
    const items = await loadRules(s.db, orgId);
    return { disclaimer: RULES_DISCLAIMER, reviewedCount: items.filter((r) => r.reviewedByCounsel).length, items };
  });

  app.get('/orgs/:orgId/franchise/rules/evaluate', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ country, region: region.optional(), franchisorRegion: region.optional() }), summary: 'Which rules, steps and documents apply to a prospect in a given country / state / province' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireFranchiseView(req, orgId);
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const fs = franchiseSettings(org!);
    const regs = await s.db.select().from(franchiseRegistrations).where(eq(franchiseRegistrations.organizationId, orgId));
    return evaluateFranchiseCompliance({
      franchisor: { country: fs.homeCountry, region: req.query.franchisorRegion ?? fs.homeRegion }, prospect: { country: req.query.country, region: req.query.region },
      rules: await loadRules(s.db, orgId), registrations: regs.map((r) => ({ jurisdiction: r.jurisdiction, status: r.status as 'registered', effectiveFrom: r.effectiveFrom, expiresAt: r.expiresAt })),
    });
  });

  const ruleBody = z.object({
    code: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/), name: z.string().min(1).max(120), version: z.string().min(1).max(20), effectiveFrom: z.iso.date(), effectiveTo: z.iso.date().nullable().default(null),
    status: z.enum(['statute', 'no_statute', 'verify']),
    sources: z.array(z.object({ law: z.string().min(1), citation: z.string().optional(), url: z.url().optional() })).min(1),
    disclosure: z.object({ required: z.boolean(), document: z.string().nullable(), minDaysBeforeSigning: z.number().int().min(0).max(365).nullable(), minDaysBeforePayment: z.number().int().min(0).max(365).nullable(), dayCount: z.enum(['calendar', 'business']), changedTermsDays: z.number().int().min(0).max(90).nullable().optional(), note: z.string().optional() }),
    registration: z.object({ kind: z.enum(['none', 'registration', 'notice_filing', 'exemption_filing', 'voluntary', 'verify']), beforeOffer: z.boolean(), authority: z.string().optional(), note: z.string().optional() }),
    coolingOff: z.object({ days: z.number().int().min(1).max(90), from: z.enum(['agreement_or_payment', 'agreement']), note: z.string().optional() }).nullable(),
    language: z.string().nullable().default(null), renewalTermination: z.string().nullable().default(null), requiredDocuments: z.array(z.string()).default([]),
    appliesWhenFranchisorHere: z.boolean().optional(), notes: z.array(z.string()).default([]), verify: z.array(z.string()).default([]), confidence: z.enum(['high', 'medium', 'low']),
  });

  app.post('/orgs/:orgId/franchise/rules', {
    schema: { tags, security: secured, params: orgParams, body: ruleBody, summary: 'Add this organisation’s own version of a jurisdiction rule (legal.disclosure edit). Starts as not reviewed by counsel.' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'disclosure.edit');
    const b = req.body;
    const [ctry, reg] = b.code.split('-') as [string, string | undefined];
    const data: JurisdictionRule = { ...b, country: ctry, region: reg ?? null, reviewedByCounsel: false, needsCounselReview: true };
    const [dupe] = await s.db.select({ id: franchiseJurisdictionRules.id }).from(franchiseJurisdictionRules).where(and(eq(franchiseJurisdictionRules.organizationId, orgId), eq(franchiseJurisdictionRules.code, b.code), eq(franchiseJurisdictionRules.version, b.version)));
    if (dupe) throw conflict('version_exists', 'This version already exists. Add a new version instead of editing one.');
    const [row] = await s.db.insert(franchiseJurisdictionRules).values({ organizationId: orgId, code: b.code, country: ctry, region: reg ?? null, version: b.version, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo, data, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.rule_version_added', targetType: 'franchise_rule', targetId: row!.id, metadata: { code: b.code, version: b.version }, ip: req.ip });
    return reply.code(201).send({ id: row!.id, code: row!.code, version: row!.version });
  });

  app.post('/orgs/:orgId/franchise/rules/:id/review', {
    schema: { tags, security: secured, params: idParams, body: z.object({ reviewed: z.boolean(), note: z.string().max(2000).optional() }), summary: 'Record franchise counsel’s review of a rule version (legal.disclosure publish / approve). Platform rules are copied into the organisation first.' },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'disclosure.approve');
    const [r] = await s.db.select().from(franchiseJurisdictionRules).where(and(eq(franchiseJurisdictionRules.id, id), or(eq(franchiseJurisdictionRules.organizationId, orgId), sql`${franchiseJurisdictionRules.organizationId} is null`)));
    if (!r) throw notFound('Rule');
    const set = { reviewedByCounsel: req.body.reviewed, reviewedBy: req.user!.id, reviewedAt: new Date(), reviewNote: req.body.note ?? null };
    let rowId = r.id;
    if (!r.organizationId) {
      const [copy] = await s.db.insert(franchiseJurisdictionRules).values({ organizationId: orgId, code: r.code, country: r.country, region: r.region, version: r.version, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, data: r.data, createdBy: req.user!.id, ...set })
        .onConflictDoUpdate({ target: [franchiseJurisdictionRules.organizationId, franchiseJurisdictionRules.code, franchiseJurisdictionRules.version], targetWhere: sql`${franchiseJurisdictionRules.organizationId} is not null`, set }).returning();
      rowId = copy!.id;
    } else {
      await s.db.update(franchiseJurisdictionRules).set(set).where(eq(franchiseJurisdictionRules.id, r.id));
    }
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.rule_reviewed', targetType: 'franchise_rule', targetId: rowId, metadata: { code: r.code, version: r.version, reviewed: req.body.reviewed }, ip: req.ip });
    return { id: rowId, code: r.code, version: r.version, reviewedByCounsel: req.body.reviewed };
  });

  app.get('/orgs/:orgId/franchise/registrations', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireAnyOrgPerm(req, s.db, orgId, [...VIEW]);
    const rows = await s.db.select().from(franchiseRegistrations).where(eq(franchiseRegistrations.organizationId, orgId)).orderBy(asc(franchiseRegistrations.jurisdiction));
    return { items: rows.map((r) => ({ id: r.id, jurisdiction: r.jurisdiction, status: r.status, fileNumber: r.fileNumber, effectiveFrom: iso(r.effectiveFrom), expiresAt: iso(r.expiresAt), notes: r.notes, active: (r.status === 'registered' || r.status === 'exempt') && (!r.expiresAt || r.expiresAt > new Date()) })) };
  });

  app.put('/orgs/:orgId/franchise/registrations/:jurisdiction', {
    schema: {
      tags, security: secured, params: z.object({ orgId: z.uuid(), jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/) }),
      body: z.object({ status: z.enum(REGISTRATION_STATUSES), fileNumber: z.string().max(100).nullable().optional(), effectiveFrom: z.iso.datetime({ offset: true }).nullable().optional(), expiresAt: z.iso.datetime({ offset: true }).nullable().optional(), notes: z.string().max(2000).nullable().optional() }),
      summary: 'Record the franchisor’s registration / filing status in a jurisdiction (legal.disclosure edit)',
    },
  }, async (req) => {
    const { orgId, jurisdiction } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'disclosure.edit');
    const b = req.body;
    const vals = { status: b.status, fileNumber: b.fileNumber ?? null, effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : null, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null, notes: b.notes ?? null, updatedBy: req.user!.id, updatedAt: new Date() };
    const [row] = await s.db.insert(franchiseRegistrations).values({ organizationId: orgId, jurisdiction, ...vals }).onConflictDoUpdate({ target: [franchiseRegistrations.organizationId, franchiseRegistrations.jurisdiction], set: vals }).returning();
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.registration_updated', targetType: 'franchise_registration', targetId: row!.id, metadata: { jurisdiction, status: b.status }, ip: req.ip });
    return { id: row!.id, jurisdiction, status: row!.status };
  });

  /* ------------------------------ territories ----------------------------- */

  const territoryOut = (t: typeof franchiseTerritories.$inferSelect) => ({ id: t.id, name: t.name, country: t.country, region: t.region, jurisdiction: jurisdictionCode(t.country, t.region), description: t.description, status: t.status, showOnSite: t.showOnSite, reservedForProspectId: t.reservedForProspectId, ownerGroupId: t.ownerGroupId, scopeTerritoryId: t.scopeTerritoryId, brandId: t.brandId });

  /** A brand chosen for a prospect, territory or document must belong to this business. */
  const assertBrand = async (orgId: string, brandId: string | null | undefined) => {
    if (brandId && !(await brandInOrg(s.db, orgId, brandId))) throw notFound('Brand');
  };

  app.get('/orgs/:orgId/franchise/territories', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'view');
    // Availability map per brand: the brand filter (switcher) narrows it to one brand.
    const rows = (await s.db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.organizationId, orgId), await brandOwnedCond(req, s.db, orgId, franchiseTerritories.brandId))).orderBy(asc(franchiseTerritories.country), asc(franchiseTerritories.name)))
      .filter((t) => inPipeline(scope, t.scopeTerritoryId));
    const counts = await s.db.select({ territoryId: franchiseProspects.territoryId, n: sql<number>`count(*)::int` }).from(franchiseProspects)
      .where(and(eq(franchiseProspects.organizationId, orgId), sql`${franchiseProspects.stage} not in ('lost','opened')`)).groupBy(franchiseProspects.territoryId);
    return { items: rows.map((t) => ({ ...territoryOut(t), activeProspects: counts.find((c) => c.territoryId === t.id)?.n ?? 0 })) };
  });

  const territoryBody = z.object({ name: z.string().min(1).max(120), country, region: region.nullable().optional(), description: z.string().max(2000).nullable().optional(), status: z.enum(TERRITORY_STATUSES).default('available'), showOnSite: z.boolean().default(true), brandId: z.uuid().nullable().optional() });
  app.post('/orgs/:orgId/franchise/territories', { schema: { tags, security: secured, params: orgParams, body: territoryBody } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    await assertBrand(orgId, req.body.brandId);
    const [t] = await s.db.insert(franchiseTerritories).values({ organizationId: orgId, ...req.body, region: req.body.region ?? null, description: req.body.description ?? null }).returning();
    return reply.code(201).send(territoryOut(t!));
  });
  app.patch('/orgs/:orgId/franchise/territories/:id', { schema: { tags, security: secured, params: idParams, body: territoryBody.partial() } }, async (req) => {
    const { orgId, id } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    await assertBrand(orgId, req.body.brandId);
    const [t] = await s.db.update(franchiseTerritories).set({ ...req.body, updatedAt: new Date() }).where(and(eq(franchiseTerritories.id, id), eq(franchiseTerritories.organizationId, orgId))).returning();
    if (!t) throw notFound('Territory');
    return territoryOut(t);
  });

  /* ------------------------------- prospects ------------------------------ */

  app.get('/orgs/:orgId/franchise/prospects', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ stage: z.enum(FRANCHISE_STAGES).optional(), q: z.string().max(100).optional(), ownerUserId: z.uuid().optional() }), summary: 'Pipeline (franchise.pipeline.view). Prospects in the disclosure → agreement stages carry their signing status.' },
  }, async (req) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'view');
    await ensureFranchiseDefaults(s.db, orgId);
    const conds = [eq(franchiseProspects.organizationId, orgId)];
    if (scope !== 'all') conds.push(inArray(franchiseProspects.scopeTerritoryId, [...scope]));
    const byBrand = await brandOwnedCond(req, s.db, orgId, franchiseProspects.brandId);
    if (byBrand) conds.push(byBrand);
    if (req.query.stage) conds.push(eq(franchiseProspects.stage, req.query.stage));
    if (req.query.ownerUserId) conds.push(eq(franchiseProspects.ownerUserId, req.query.ownerUserId));
    if (req.query.q) conds.push(or(ilike(franchiseProspects.name, `%${req.query.q}%`), ilike(franchiseProspects.email, `%${req.query.q}%`), ilike(franchiseProspects.city, `%${req.query.q}%`))!);
    const rows = await s.db.select().from(franchiseProspects).where(and(...conds)).orderBy(desc(franchiseProspects.updatedAt)).limit(500);
    const terr = rows.some((r) => r.territoryId) ? await s.db.select({ id: franchiseTerritories.id, name: franchiseTerritories.name }).from(franchiseTerritories).where(eq(franchiseTerritories.organizationId, orgId)) : [];
    const names = await userNames(s.db, rows.map((r) => r.ownerUserId));
    const open = rows.length ? await s.db.select({ prospectId: franchiseTasks.prospectId, n: sql<number>`count(*)::int`, overdue: sql<number>`count(*) filter (where ${franchiseTasks.dueAt} < now())::int`, next: sql<Date | null>`min(${franchiseTasks.dueAt})` }).from(franchiseTasks)
      .where(and(eq(franchiseTasks.organizationId, orgId), eq(franchiseTasks.status, 'open'), inArray(franchiseTasks.prospectId, rows.map((r) => r.id)))).groupBy(franchiseTasks.prospectId) : [];
    const gated = new Set<FranchiseStage>(['disclosure_sent', 'disclosure_receipt_signed', 'waiting_period', 'agreement_sent']);
    const items = [];
    for (const p of rows) {
      const c = gated.has(p.stage as FranchiseStage) ? await prospectCompliance(s.db, p) : null;
      const t = open.find((o) => o.prospectId === p.id);
      items.push({
        ...serializeProspect(p, { territoryName: terr.find((x) => x.id === p.territoryId)?.name ?? null, ownerName: names.get(p.ownerUserId ?? '') ?? null }),
        openTasks: t?.n ?? 0, overdueTasks: t?.overdue ?? 0, nextDueAt: t?.next ? new Date(t.next).toISOString() : null,
        signing: c ? { canSign: c.canSign, earliestSigningAt: c.earliestSigningAt, blocker: c.signingBlockers[0] ?? null } : null,
      });
    }
    return { stages: FRANCHISE_STAGES, items };
  });

  const prospectBody = z.object({
    name: z.string().min(1).max(120), email: z.email(), phone: z.string().max(40).nullable().optional(), country, region: region.nullable().optional(), city: z.string().max(120).nullable().optional(),
    territoryId: z.uuid().nullable().optional(), desiredTerritory: z.string().max(200).nullable().optional(),
    liquidCapitalMinor: z.number().int().min(0).nullable().optional(), netWorthMinor: z.number().int().min(0).nullable().optional(), currency: currency.optional(),
    units: z.number().int().min(1).max(100).optional(), source: z.enum(PROSPECT_SOURCES).default('other'), campaignId: z.uuid().nullable().optional(), message: z.string().max(4000).nullable().optional(), ownerUserId: z.uuid().nullable().optional(),
    /** The sub-network (access territory) whose pipeline holds the prospect; null = HQ's own pipeline. */
    scopeTerritoryId: z.uuid().nullable().optional(),
    /** The brand the prospect is buying (multi-brand HQ); null = the main brand. */
    brandId: z.uuid().nullable().optional(),
  });

  app.post('/orgs/:orgId/franchise/prospects', { schema: { tags, security: secured, params: orgParams, body: prospectBody } }, async (req, reply) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'edit');
    await ensureFranchiseDefaults(s.db, orgId);
    const b = { ...req.body };
    // A territory's pipeline only holds its own prospects: default to (and stay inside) the person's territory.
    if (scope !== 'all') {
      b.scopeTerritoryId ??= [...scope][0]!;
      if (!scope.has(b.scopeTerritoryId)) throw forbidden('You can only add prospects to your own territory');
    }
    if (b.scopeTerritoryId) await resolveScopeChain(s.db, { organizationId: orgId, kind: 'territory', id: b.scopeTerritoryId });
    await assertBrand(orgId, b.brandId);
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const p = await s.db.transaction(async (tx) => {
      const [p] = await tx.insert(franchiseProspects).values({ ...b, organizationId: orgId, email: b.email.toLowerCase(), currency: b.currency ?? org!.defaultCurrency, ownerUserId: b.ownerUserId ?? req.user!.id, region: b.region ?? null }).returning();
      await addActivity(tx, p!, 'enquiry', b.message ?? null, req.user!.id, { source: b.source, manual: true });
      await generateCadenceTasks(tx, p!);
      return p!;
    });
    return reply.code(201).send(serializeProspect(p));
  });

  app.get('/orgs/:orgId/franchise/prospects/:id', { schema: { tags, security: secured, params: idParams, summary: 'Prospect detail: rules panel, timeline, tasks, documents, signatures, fee invoices, onboarding project' } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'view');
    const [terr] = p.territoryId ? await s.db.select().from(franchiseTerritories).where(eq(franchiseTerritories.id, p.territoryId)) : [];
    const acts = await listOrderedActivities(s.db, p.id);
    const tasks = await s.db.select().from(franchiseTasks).where(eq(franchiseTasks.prospectId, p.id)).orderBy(asc(franchiseTasks.dueAt));
    const dels = await s.db.select({ d: franchiseDeliveries, doc: franchiseDocuments }).from(franchiseDeliveries).innerJoin(franchiseDocuments, eq(franchiseDocuments.id, franchiseDeliveries.documentId)).where(eq(franchiseDeliveries.prospectId, p.id)).orderBy(desc(franchiseDeliveries.deliveredAt));
    const sigs = await s.db.select().from(franchiseSignatures).where(eq(franchiseSignatures.prospectId, p.id)).orderBy(desc(franchiseSignatures.sentAt));
    const invs = await s.db.select().from(franchiseFeeInvoices).where(eq(franchiseFeeInvoices.prospectId, p.id)).orderBy(desc(franchiseFeeInvoices.createdAt));
    const [project] = await s.db.select().from(franchiseProjects).where(eq(franchiseProjects.prospectId, p.id));
    const names = await userNames(s.db, [p.ownerUserId, ...acts.map((a) => a.actorUserId), ...tasks.map((t) => t.ownerUserId)]);
    return {
      ...serializeProspect(p, { territoryName: terr?.name ?? null, ownerName: names.get(p.ownerUserId ?? '') ?? null, compliance: await prospectCompliance(s.db, p) }),
      activities: acts.map((a) => ({ id: a.id, kind: a.kind, body: a.body, metadata: a.metadata, actorName: a.actorUserId ? names.get(a.actorUserId) ?? null : null, createdAt: a.createdAt.toISOString() })),
      tasks: tasks.map((t) => serializeTask(t, names.get(t.ownerUserId ?? ''))),
      deliveries: dels.map(({ d, doc }) => ({ id: d.id, kind: d.kind, document: { id: doc.id, title: doc.title, version: doc.version, jurisdictions: doc.jurisdictions }, deliveredAt: d.deliveredAt.toISOString(), openedAt: iso(d.openedAt), receiptSignedAt: iso(d.receiptSignedAt), receiptName: d.receiptName, receiptIp: d.receiptIp, materialChange: d.materialChange })),
      signatures: sigs.map((g) => ({ id: g.id, provider: g.provider, status: g.status, sentAt: g.sentAt.toISOString(), signedAt: iso(g.signedAt), signerName: g.signerName, signerIp: g.signerIp, terms: g.terms })),
      invoices: invs.map((i) => ({ id: i.id, description: i.description, amount: { amount: i.amountMinor, currency: i.currency }, status: i.status, paymentId: i.paymentId, paidAt: iso(i.paidAt), createdAt: i.createdAt.toISOString() })),
      project: project ? { id: project.id, name: project.name, status: project.status, locationId: project.locationId } : null,
    };
  });

  app.get('/orgs/:orgId/franchise/prospects/:id/compliance', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    return prospectCompliance(s.db, await prospectIn(req, orgId, id, 'view'));
  });

  app.patch('/orgs/:orgId/franchise/prospects/:id', { schema: { tags, security: secured, params: idParams, body: prospectBody.partial() } }, async (req) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'edit');
    await assertBrand(orgId, req.body.brandId);
    if (req.body.scopeTerritoryId !== undefined) {
      const scope = await pipeline(req, orgId, 'edit');
      if (scope !== 'all' && !(req.body.scopeTerritoryId && scope.has(req.body.scopeTerritoryId))) throw forbidden('You can only keep prospects in your own territory');
      if (req.body.scopeTerritoryId) await resolveScopeChain(s.db, { organizationId: orgId, kind: 'territory', id: req.body.scopeTerritoryId });
    }
    if ((req.body.country || req.body.region !== undefined) && stageIndex(p.stage as FranchiseStage) >= stageIndex('disclosure_sent') && p.stage !== 'lost') {
      await addActivity(s.db, p, 'note', 'Location changed after disclosure: check that the right disclosure documents were given.', req.user!.id, { from: jurisdictionCode(p.country, p.region) });
    }
    const [u] = await s.db.update(franchiseProspects).set({ ...req.body, ...(req.body.email ? { email: req.body.email.toLowerCase() } : {}), updatedAt: new Date() }).where(eq(franchiseProspects.id, p.id)).returning();
    return serializeProspect(u!);
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/stage', {
    schema: { tags, security: secured, params: idParams, body: z.object({ to: z.enum(FRANCHISE_STAGES), note: z.string().max(2000).optional(), lostReason: z.string().max(500).optional() }), summary: 'Move a prospect by hand (enquiry → qualified → discovery call, or lost). Later stages follow from actions so the rules engine can check them.' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'edit');
    const to = req.body.to;
    if (!MANUAL_STAGES.includes(to)) {
      throw conflict('stage_requires_action', to === 'disclosure_sent' ? 'Send a disclosure document to move to this stage.' : to === 'agreement_sent' ? 'Send the agreement to move to this stage.' : to === 'signed' ? 'The agreement is signed through e-signature, which checks the waiting period and registration first.' : to === 'opened' ? 'A location opens when HQ approves its go-live.' : 'This stage follows from an action (receipt, signature, onboarding).', { to });
    }
    if (['signed', 'onboarding', 'opened'].includes(p.stage) && to !== 'lost') throw conflict('invalid_stage', 'This prospect already signed');
    if (to === 'lost' && !req.body.lostReason) throw validationError('Say why the prospect was lost', { lostReason: 'Required' });
    const u = await s.db.transaction(async (tx) => {
      const u = await setStage(tx, p, to, req.user!.id, req.body.note ?? null, to === 'lost' ? { lostReason: req.body.lostReason } : {});
      if (to === 'lost' && p.territoryId) await tx.update(franchiseTerritories).set({ status: 'available', reservedForProspectId: null }).where(and(eq(franchiseTerritories.id, p.territoryId), eq(franchiseTerritories.reservedForProspectId, p.id)));
      if (to === 'lost') await tx.update(franchiseSignatures).set({ status: 'voided' }).where(and(eq(franchiseSignatures.prospectId, p.id), eq(franchiseSignatures.status, 'sent')));
      return u;
    });
    return serializeProspect(u);
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/activities', {
    schema: { tags, security: secured, params: idParams, body: z.object({ kind: z.enum(['note', 'call', 'meeting', 'email']), body: z.string().min(1).max(4000) }) },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'edit');
    await addActivity(s.db, p, req.body.kind, req.body.body, req.user!.id);
    await s.db.update(franchiseProspects).set({ updatedAt: new Date() }).where(eq(franchiseProspects.id, p.id));
    return reply.code(201).send({ ok: true });
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/territory-reservation', {
    schema: { tags, security: secured, params: idParams, body: z.object({ territoryId: z.uuid().nullable() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'edit');
    return s.db.transaction(async (tx) => {
      await tx.update(franchiseTerritories).set({ status: 'available', reservedForProspectId: null }).where(and(eq(franchiseTerritories.organizationId, orgId), eq(franchiseTerritories.reservedForProspectId, p.id), eq(franchiseTerritories.status, 'reserved')));
      if (req.body.territoryId) {
        const [t] = await tx.update(franchiseTerritories).set({ status: 'reserved', reservedForProspectId: p.id, updatedAt: new Date() })
          .where(and(eq(franchiseTerritories.id, req.body.territoryId), eq(franchiseTerritories.organizationId, orgId), eq(franchiseTerritories.status, 'available'))).returning();
        if (!t) throw conflict('territory_unavailable', 'This territory is not available');
        await tx.update(franchiseProspects).set({ territoryId: t.id, updatedAt: new Date() }).where(eq(franchiseProspects.id, p.id));
        await addActivity(tx, p, 'note', `Territory reserved: ${t.name}`, req.user!.id, { territoryId: t.id });
      }
      return { ok: true };
    });
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/disclosures', {
    schema: { tags, security: secured, params: idParams, body: z.object({ documentId: z.uuid() }), summary: 'Deliver a disclosure document by email link; the prospect signs an e-receipt (timestamp + IP) that starts the waiting period' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const out = await sendDisclosure(s, req, await prospectIn(req, orgId, id, 'edit'), req.body.documentId);
    return reply.code(201).send({ deliveryId: out.delivery.id, stage: out.prospect.stage, link: out.link, warnings: out.warnings, ...(out.devToken ? { devToken: out.devToken } : {}) });
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/agreement', {
    schema: {
      tags, security: secured, params: idParams,
      body: z.object({ documentId: z.uuid(), provider: z.enum(['builtin', 'docusign', 'dropbox_sign']).default('builtin'), materialChange: z.boolean().default(false), terms: termsSchema.default({}) }),
      summary: 'Send the agreement for e-signature. Blocked while a registration requirement is outstanding; signing itself waits for every waiting period.',
    },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const out = await sendAgreement(s, req, await prospectIn(req, orgId, id, 'edit'), req.body);
    return reply.code(201).send({ signatureId: out.signature.id, provider: out.signature.provider, stage: out.prospect.stage, link: out.link, disclaimer: ESIGN_DISCLAIMER, ...(out.devToken ? { devToken: out.devToken } : {}) });
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/agreement/record-signature', {
    schema: { tags, security: secured, params: idParams, body: z.object({ signatureId: z.uuid(), signerName: z.string().min(2).max(120) }), summary: 'Record a signature completed outside the built-in flow (provider or wet ink). Same rule checks as e-signature.' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const p = await prospectIn(req, orgId, id, 'edit');
    const [sig] = await s.db.select().from(franchiseSignatures).where(and(eq(franchiseSignatures.id, req.body.signatureId), eq(franchiseSignatures.prospectId, p.id)));
    if (!sig) throw notFound('Agreement');
    const r = await completeSignature(s, sig.id, { name: req.body.signerName, ip: req.ip, userAgent: req.headers['user-agent'] ?? null, actorUserId: req.user!.id });
    return { agreementId: r.agreement.id, ownerGroupId: r.ownerGroup.id, projectId: r.project.id, stage: r.prospect.stage, coolingOffEndsAt: r.compliance.coolingOffEndsAt };
  });

  app.post('/orgs/:orgId/franchise/prospects/:id/fee-invoices', {
    schema: { tags, security: secured, params: idParams, body: z.object({ amountMinor: z.number().int().positive(), currency, description: z.string().min(1).max(200), collectLocationId: z.uuid().optional() }), summary: 'Request a franchise fee through the existing payments (blocked until the payment waiting period ends and registrations are in effect)' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const out = await createFeeInvoice(s, req, await prospectIn(req, orgId, id, 'edit'), req.body);
    return reply.code(201).send({ invoiceId: out.invoice.id, paymentId: out.payment.id, status: out.invoice.status, sandbox: out.sandbox });
  });

  /* --------------------------------- tasks -------------------------------- */

  app.get('/orgs/:orgId/franchise/tasks', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ mine: z.coerce.boolean().default(false), status: z.enum(['open', 'done', 'skipped', 'all']).default('open'), prospectId: z.uuid().optional(), projectId: z.uuid().optional() }) },
  }, async (req) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'view');
    const conds = [eq(franchiseTasks.organizationId, orgId)];
    if (scope !== 'all') conds.push(inArray(franchiseProspects.scopeTerritoryId, [...scope]));
    if (req.query.status !== 'all') conds.push(eq(franchiseTasks.status, req.query.status));
    if (req.query.mine) conds.push(eq(franchiseTasks.ownerUserId, req.user!.id));
    if (req.query.prospectId) conds.push(eq(franchiseTasks.prospectId, req.query.prospectId));
    if (req.query.projectId) conds.push(eq(franchiseTasks.projectId, req.query.projectId));
    const rows = await s.db.select({ t: franchiseTasks, pname: franchiseProspects.name }).from(franchiseTasks).leftJoin(franchiseProspects, eq(franchiseProspects.id, franchiseTasks.prospectId)).where(and(...conds)).orderBy(asc(franchiseTasks.dueAt)).limit(500);
    const names = await userNames(s.db, rows.map((r) => r.t.ownerUserId));
    return { items: rows.map((r) => ({ ...serializeTask(r.t, names.get(r.t.ownerUserId ?? '')), prospectName: r.pname })) };
  });

  app.post('/orgs/:orgId/franchise/tasks', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ prospectId: z.uuid().optional(), projectId: z.uuid().optional(), title: z.string().min(1).max(200), kind: z.enum(['email', 'call', 'task']).default('task'), dueAt: z.iso.datetime({ offset: true }).optional(), ownerUserId: z.uuid().optional(), section: z.string().max(40).optional() }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'edit');
    const b = req.body;
    if (b.prospectId) await prospectIn(req, orgId, b.prospectId, 'edit');
    else if (scope !== 'all' && !b.projectId) throw forbidden('Tasks in your territory belong to a prospect');
    if (b.projectId) await getProject(s.db, orgId, b.projectId);
    const [t] = await s.db.insert(franchiseTasks).values({ organizationId: orgId, prospectId: b.prospectId ?? null, projectId: b.projectId ?? null, title: b.title, kind: b.kind, section: b.section ?? null, dueAt: b.dueAt ? new Date(b.dueAt) : null, ownerUserId: b.ownerUserId ?? req.user!.id }).returning();
    return reply.code(201).send(serializeTask(t!));
  });

  const taskAction = async (req: FastifyRequest, orgId: string, id: string, status: 'done' | 'open') => {
    const [t] = await s.db.select().from(franchiseTasks).where(and(eq(franchiseTasks.id, id), eq(franchiseTasks.organizationId, orgId)));
    if (!t) throw notFound('Task');
    if (t.projectId) {
      const proj = await getProject(s.db, orgId, t.projectId);
      const who = await assertProjectAccess(req, s.db, proj, true);
      if (who === 'owner' && t.assignee !== 'owner') throw forbidden('Only HQ can complete this task');
      if (proj.status !== 'active') throw conflict('project_locked', 'The checklist is locked while the opening is being approved');
    } else if (t.prospectId) {
      await prospectIn(req, orgId, t.prospectId, 'edit');
    } else {
      await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    }
    const [u] = await s.db.update(franchiseTasks).set(status === 'done' ? { status, completedAt: new Date(), completedBy: req.user!.id } : { status, completedAt: null, completedBy: null }).where(eq(franchiseTasks.id, t.id)).returning();
    if (t.prospectId && status === 'done') await addActivity(s.db, { id: t.prospectId, organizationId: orgId }, 'task_done', t.title, req.user!.id, { taskId: t.id });
    return serializeTask(u!);
  };
  app.post('/orgs/:orgId/franchise/tasks/:id/complete', { schema: { tags, security: secured, params: idParams } }, async (req) => taskAction(req, req.params.orgId, req.params.id, 'done'));
  app.post('/orgs/:orgId/franchise/tasks/:id/reopen', { schema: { tags, security: secured, params: idParams } }, async (req) => taskAction(req, req.params.orgId, req.params.id, 'open'));

  /* ---------------------------- cadences & email --------------------------- */

  const cadenceOut = (c: typeof franchiseCadences.$inferSelect) => ({ id: c.id, stage: c.stage, name: c.name, steps: c.steps, active: c.active });
  const stepSchema = z.object({ offsetDays: z.number().int().min(0).max(365), kind: z.enum(['email', 'call', 'task']), title: z.string().min(1).max(200), templateKey: z.string().max(60).optional(), ownerUserId: z.uuid().nullable().optional() });

  app.get('/orgs/:orgId/franchise/cadences', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.view');
    await ensureFranchiseDefaults(s.db, orgId);
    const rows = await s.db.select().from(franchiseCadences).where(eq(franchiseCadences.organizationId, orgId)).orderBy(asc(franchiseCadences.createdAt));
    return { items: rows.map(cadenceOut).sort((a, b) => stageIndex(a.stage as FranchiseStage) - stageIndex(b.stage as FranchiseStage)) };
  });
  app.post('/orgs/:orgId/franchise/cadences', { schema: { tags, security: secured, params: orgParams, body: z.object({ stage: z.enum(FRANCHISE_STAGES), name: z.string().min(1).max(120), steps: z.array(stepSchema).max(20), active: z.boolean().default(true) }) } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    const [c] = await s.db.insert(franchiseCadences).values({ organizationId: orgId, ...req.body }).returning();
    return reply.code(201).send(cadenceOut(c!));
  });
  app.patch('/orgs/:orgId/franchise/cadences/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ name: z.string().min(1).max(120).optional(), steps: z.array(stepSchema).max(20).optional(), active: z.boolean().optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    const [c] = await s.db.update(franchiseCadences).set({ ...req.body, updatedAt: new Date() }).where(and(eq(franchiseCadences.id, id), eq(franchiseCadences.organizationId, orgId))).returning();
    if (!c) throw notFound('Cadence');
    return cadenceOut(c);
  });
  app.get('/orgs/:orgId/franchise/email-templates', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.view');
    await ensureFranchiseDefaults(s.db, orgId);
    const rows = await s.db.select().from(franchiseEmailTemplates).where(eq(franchiseEmailTemplates.organizationId, orgId)).orderBy(asc(franchiseEmailTemplates.key));
    return { items: rows.map((t) => ({ key: t.key, name: t.name, subject: t.subject, body: t.body })) };
  });
  app.put('/orgs/:orgId/franchise/email-templates/:key', {
    schema: { tags, security: secured, params: z.object({ orgId: z.uuid(), key: z.string().regex(/^[a-z0-9_]{2,60}$/) }), body: z.object({ name: z.string().min(1).max(120), subject: z.string().min(1).max(200), body: z.string().min(1).max(10_000) }) },
  }, async (req) => {
    const { orgId, key } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    const vals = { ...req.body, updatedAt: new Date() };
    await s.db.insert(franchiseEmailTemplates).values({ organizationId: orgId, key, ...vals }).onConflictDoUpdate({ target: [franchiseEmailTemplates.organizationId, franchiseEmailTemplates.key], set: vals });
    return { key, ...req.body };
  });

  /* ------------------------------- documents ------------------------------ */

  app.get('/orgs/:orgId/franchise/documents', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ kind: z.enum(['disclosure', 'agreement_template', 'executed_agreement', 'vault']).optional(), ownerGroupId: z.uuid().optional() }), summary: 'Disclosure documents and agreement templates (pipeline or legal view); executed agreements and the legal vault need legal.view' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireAnyOrgPerm(req, s.db, orgId, [...VIEW]);
    const legal = await orgHas(req, s.db, orgId, 'legal.view');
    if (req.query.kind && LEGAL_ONLY_KINDS.has(req.query.kind) && !legal) throw forbidden('Missing permission legal.view');
    const conds = [eq(franchiseDocuments.organizationId, orgId)];
    if (req.query.kind) conds.push(eq(franchiseDocuments.kind, req.query.kind));
    if (!legal) conds.push(inArray(franchiseDocuments.kind, ['disclosure', 'agreement_template']));
    if (req.query.ownerGroupId) conds.push(eq(franchiseDocuments.ownerGroupId, req.query.ownerGroupId));
    // Disclosure documents and agreement templates are attached per brand (none = shared by every brand).
    const byBrand = await brandSharedCond(req, s.db, orgId, franchiseDocuments.brandId);
    if (byBrand) conds.push(byBrand);
    const rows = await s.db.select().from(franchiseDocuments).where(and(...conds)).orderBy(desc(franchiseDocuments.createdAt));
    return { items: rows.map(serializeDocument) };
  });

  app.post('/orgs/:orgId/franchise/documents', {
    bodyLimit: 12 * 1024 * 1024,
    schema: {
      tags, security: secured, params: orgParams,
      body: z.object({
        kind: z.enum(['disclosure', 'agreement_template', 'executed_agreement', 'vault']), title: z.string().min(1).max(200), version: z.string().min(1).max(40).default('1'),
        jurisdictions: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)).max(80).default([]), issuedOn: z.iso.date().optional(),
        fileName: z.string().min(1).max(200), contentType: z.string().min(1).max(100), contentBase64: z.string().min(4),
        ownerGroupId: z.uuid().optional(), agreementId: z.uuid().optional(), prospectId: z.uuid().optional(), supersedePrevious: z.boolean().default(true),
        /** Multi-brand HQ: the brand this disclosure document / agreement template is for (omit = every brand). */
        brandId: z.uuid().optional(),
      }),
      summary: 'Upload a document (disclosure documents: legal.disclosure edit; agreements and the vault: legal.agreements edit). A new disclosure version supersedes the previous one for the same jurisdictions.',
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    await requireOrgPerm(req, s.db, orgId, documentEditPerm(b.kind));
    if (b.kind === 'disclosure' && !b.jurisdictions.length) throw validationError('Say which jurisdictions this disclosure document covers', { jurisdictions: 'At least one' });
    if (b.ownerGroupId) {
      const [g] = await s.db.select({ id: ownerGroups.id }).from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
      if (!g) throw notFound('Owner group');
    }
    await assertBrand(orgId, b.brandId);
    const f = decodeUpload(b.contentBase64);
    const row = await s.db.transaction(async (tx) => {
      if (b.supersedePrevious && (b.kind === 'disclosure' || b.kind === 'agreement_template')) {
        await tx.update(franchiseDocuments).set({ status: 'superseded' }).where(and(eq(franchiseDocuments.organizationId, orgId), eq(franchiseDocuments.kind, b.kind), eq(franchiseDocuments.status, 'current'), b.brandId ? eq(franchiseDocuments.brandId, b.brandId) : isNull(franchiseDocuments.brandId), arrayContains(franchiseDocuments.jurisdictions, b.jurisdictions), arrayContained(franchiseDocuments.jurisdictions, b.jurisdictions)));
      }
      const [row] = await tx.insert(franchiseDocuments).values({
        organizationId: orgId, kind: b.kind, title: b.title, version: b.version, jurisdictions: b.jurisdictions, issuedOn: b.issuedOn ?? null, fileName: b.fileName, contentType: b.contentType,
        sizeBytes: f.size, sha256: f.sha, contentBase64: f.buf.toString('base64'), ownerGroupId: b.ownerGroupId ?? null, agreementId: b.agreementId ?? null, prospectId: b.prospectId ?? null, brandId: b.brandId ?? null, uploadedBy: req.user!.id,
      }).returning();
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'franchise.document_uploaded', targetType: 'franchise_document', targetId: row!.id, metadata: { kind: b.kind, title: b.title, version: b.version }, ip: req.ip });
      return row!;
    });
    return reply.code(201).send(serializeDocument(row));
  });

  app.get('/orgs/:orgId/franchise/documents/:id/download', { schema: { tags, security: secured, params: idParams } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const [d] = await s.db.select().from(franchiseDocuments).where(and(eq(franchiseDocuments.id, id), eq(franchiseDocuments.organizationId, orgId)));
    if (!d) { await requireMember(req, s.db, orgId); throw notFound('Document'); }
    await assertCanReadDocument(req, s.db, d);
    if (LEGAL_ONLY_KINDS.has(d.kind)) await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'legal.document_downloaded', targetType: 'franchise_document', targetId: d.id, ip: req.ip });
    return reply.header('content-type', d.contentType).header('content-disposition', `attachment; filename="${d.fileName.replace(/["\\\r\n]/g, '_')}"`).header('cache-control', 'private, no-store').send(Buffer.from(d.contentBase64, 'base64'));
  });

  app.patch('/orgs/:orgId/franchise/documents/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['draft', 'current', 'superseded']) }) } }, async (req) => {
    const { orgId, id } = req.params;
    const [cur] = await s.db.select({ kind: franchiseDocuments.kind }).from(franchiseDocuments).where(and(eq(franchiseDocuments.id, id), eq(franchiseDocuments.organizationId, orgId)));
    if (!cur) { await requireMember(req, s.db, orgId); throw notFound('Document'); }
    await requireOrgPerm(req, s.db, orgId, documentEditPerm(cur.kind));
    const [d] = await s.db.update(franchiseDocuments).set({ status: req.body.status }).where(and(eq(franchiseDocuments.id, id), eq(franchiseDocuments.organizationId, orgId))).returning();
    if (!d) throw notFound('Document');
    return serializeDocument(d);
  });

  /* ------------------------------- onboarding ------------------------------ */

  const projectOut = async (proj: typeof franchiseProjects.$inferSelect, withTasks: boolean) => {
    const tasks = await s.db.select().from(franchiseTasks).where(eq(franchiseTasks.projectId, proj.id)).orderBy(asc(franchiseTasks.dueAt));
    const [loc] = proj.locationId ? await s.db.select().from(locations).where(eq(locations.id, proj.locationId)) : [];
    const [p] = proj.prospectId ? await s.db.select({ name: franchiseProspects.name }).from(franchiseProspects).where(eq(franchiseProspects.id, proj.prospectId)) : [];
    const gates = tasks.filter((t) => t.gate);
    const names = withTasks ? await userNames(s.db, tasks.map((t) => t.ownerUserId)) : new Map<string, string>();
    const preOpening = await (await import('../services/audits.ts')).preOpeningState(s.db, proj);
    return {
      id: proj.id, name: proj.name, status: proj.status, prospectId: proj.prospectId, prospectName: p?.name ?? null, ownerGroupId: proj.ownerGroupId, ownerEmail: proj.ownerEmail, ownerInvitationId: proj.ownerInvitationId,
      location: loc ? { id: loc.id, name: loc.name, status: loc.status, publiclyVisible: loc.publiclyVisible, slug: loc.slug } : null,
      targetOpenDate: proj.targetOpenDate, startedAt: proj.startedAt.toISOString(), openedAt: iso(proj.openedAt), approvalId: proj.approvalId,
      progress: { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length, overdue: tasks.filter((t) => t.status === 'open' && t.dueAt && t.dueAt < new Date()).length },
      gates: { done: gates.filter((g) => g.status === 'done').length, total: gates.length },
      // Pre-opening checks can use an audit checklist (Operations → Audits): an audit with it must have passed.
      preOpening,
      canRequestGoLive: proj.status === 'active' && !!proj.locationId && gates.every((g) => g.status === 'done') && (!preOpening || preOpening.passed),
      ...(withTasks ? { tasks: tasks.map((t) => serializeTask(t, names.get(t.ownerUserId ?? ''))) } : {}),
    };
  };

  app.get('/orgs/:orgId/franchise/projects', { schema: { tags, security: secured, params: orgParams, summary: 'Onboarding projects: all for HQ (franchise pipeline, or New locations organisation-wide); a franchise owner sees the projects of their own locations (New locations)' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, s.db, orgId);
    const hq = (await orgHas(req, s.db, orgId, 'franchise.pipeline.view')) || (await orgHas(req, s.db, orgId, 'onboarding.view'));
    let rows = await s.db.select().from(franchiseProjects).where(eq(franchiseProjects.organizationId, orgId)).orderBy(desc(franchiseProjects.createdAt));
    if (!hq) {
      const allowed = await authorisedLocations(req, s.db, orgId, 'onboarding.view');
      rows = rows.filter((r) => r.locationId && (allowed === 'all' || allowed.has(r.locationId)));
    }
    return { items: await Promise.all(rows.map((r) => projectOut(r, false))) };
  });

  app.get('/orgs/:orgId/franchise/projects/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const proj = await getProject(s.db, orgId, id);
    await assertProjectAccess(req, s.db, proj, false);
    return projectOut(proj, true);
  });

  app.post('/orgs/:orgId/franchise/projects/:id/provision', {
    schema: {
      tags, security: secured, params: idParams,
      body: z.object({ name: z.string().min(1).max(120), code: z.string().min(1).max(24), address: addressSchema, timeZone, currency, locale: z.string().max(10).optional(), regionId: z.uuid().optional(), templateId: z.uuid().optional(), ownerEmail: z.email().optional() }),
      summary: 'Create the location from the brand template (draft, not public), a “coming soon” campaign draft, and invite the franchise owner to their owner group',
    },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    await requireOrgPerm(req, s.db, orgId, 'locations.write');
    if (!isValidTimeZone(req.body.timeZone)) throw validationError('Unknown timezone', { timeZone: 'Use an IANA timezone such as America/Toronto' });
    const out = await provisionLocation(s, req, await getProject(s.db, orgId, id), req.body);
    return reply.code(201).send({ project: await projectOut(out.project, false), locationId: out.location.id, websiteId: out.websiteId, campaignId: out.campaignId, invitationId: out.invitationId, ...(out.devInvitationToken ? { devInvitationToken: out.devInvitationToken } : {}) });
  });

  app.post('/orgs/:orgId/franchise/projects/:id/go-live', {
    schema: { tags, security: secured, params: idParams, body: z.object({ comment: z.string().max(1000).optional() }), summary: 'Ask HQ to approve the opening (approvals inbox, kind location_go_live). All pre-opening checks must be done.' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const proj = await getProject(s.db, orgId, id);
    await assertProjectAccess(req, s.db, proj, true);
    const ap = await requestGoLive(s, req, proj, req.body.comment);
    return reply.code(201).send({ approvalId: ap.id, status: 'go_live_requested' });
  });

  /* --------------------------------- legal -------------------------------- */

  app.get('/orgs/:orgId/legal/agreements', {
    schema: { tags: ['legal'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(['active', 'expired', 'terminated', 'renewed', 'all']).default('all'), expiringWithinDays: z.coerce.number().int().min(1).max(3650).optional() }), summary: 'Franchise agreements register (legal.agreements view, organisation-wide only). Franchise owners (New locations on their owner group) see only their own owner group’s agreements.' },
  }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, s.db, orgId);
    const legal = await orgHas(req, s.db, orgId, 'legal.view');
    const ownGroups = mine.filter((a) => a.scopeKind === 'owner_group' && a.permissions?.has('onboarding.view')).map((a) => a.scopeId);
    if (!legal && !ownGroups.length) throw forbidden('Missing permission legal.view');
    const conds = [eq(franchiseAgreements.organizationId, orgId)];
    if (req.query.status !== 'all') conds.push(eq(franchiseAgreements.status, req.query.status));
    if (!legal) conds.push(inArray(franchiseAgreements.ownerGroupId, ownGroups));
    const rows = await s.db.select({ a: franchiseAgreements, g: ownerGroups.name }).from(franchiseAgreements).leftJoin(ownerGroups, eq(ownerGroups.id, franchiseAgreements.ownerGroupId)).where(and(...conds)).orderBy(asc(franchiseAgreements.endDate));
    let items = rows.map((r) => serializeAgreement(r.a, r.g));
    if (req.query.expiringWithinDays) items = items.filter((a) => a.daysToExpiry <= req.query.expiringWithinDays!);
    return { scope: legal ? 'all' : 'own', items };
  });

  const agreementBody = z.object({
    ownerGroupId: z.uuid(), territory: z.string().max(200).nullable().optional(), territoryId: z.uuid().nullable().optional(), locationIds: z.array(z.uuid()).max(100).default([]), jurisdiction: z.string().max(10).nullable().optional(),
    startDate: z.iso.date(), endDate: z.iso.date(), termYears: z.number().int().min(1).max(50).nullable().optional(), renewalOption: z.string().max(500).nullable().optional(),
    royaltyBps: bps.nullable().optional(), marketingFundBps: bps.nullable().optional(), terms: z.record(z.string(), z.unknown()).default({}), status: z.enum(['active', 'expired', 'terminated', 'renewed']).default('active'), documentId: z.uuid().nullable().optional(),
  });

  app.post('/orgs/:orgId/legal/agreements', { schema: { tags: ['legal'], security: secured, params: orgParams, body: agreementBody, summary: 'Add an agreement to the register, e.g. for existing franchisees (legal.agreements edit)' } }, async (req, reply) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'legal.edit');
    const b = req.body;
    if (b.endDate <= b.startDate) throw validationError('The end date must be after the start date', { endDate: 'After start date' });
    const [g] = await s.db.select().from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
    if (!g) throw notFound('Owner group');
    const [a] = await s.db.insert(franchiseAgreements).values({ organizationId: orgId, ...b, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'legal.agreement_added', targetType: 'franchise_agreement', targetId: a!.id, ip: req.ip });
    return reply.code(201).send(serializeAgreement(a!, g.name));
  });

  app.patch('/orgs/:orgId/legal/agreements/:id', { schema: { tags: ['legal'], security: secured, params: idParams, body: agreementBody.partial() } }, async (req) => {
    const { orgId, id } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'legal.edit');
    const [a] = await s.db.update(franchiseAgreements).set({ ...req.body, ...(req.body.endDate ? { remindersSent: [] } : {}), updatedAt: new Date() }).where(and(eq(franchiseAgreements.id, id), eq(franchiseAgreements.organizationId, orgId))).returning();
    if (!a) throw notFound('Agreement');
    await audit(s.db, { organizationId: orgId, actorUserId: req.user!.id, action: 'legal.agreement_updated', targetType: 'franchise_agreement', targetId: a.id, metadata: { changes: Object.keys(req.body) }, ip: req.ip });
    const [g] = a.ownerGroupId ? await s.db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, a.ownerGroupId)) : [];
    return serializeAgreement(a, g?.name ?? null);
  });

  app.get('/orgs/:orgId/franchise/owner-groups', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireAnyOrgPerm(req, s.db, orgId, [...VIEW]);
    const rows = await s.db.select().from(ownerGroups).where(eq(ownerGroups.organizationId, orgId)).orderBy(asc(ownerGroups.name));
    return { items: rows.map((g) => ({ id: g.id, name: g.name, legalName: g.legalName })) };
  });

  app.get('/orgs/:orgId/franchise/team', { schema: { tags, security: secured, params: orgParams, summary: 'People who can own prospects (pipeline edit)' } }, async (req) => {
    const { orgId } = req.params;
    const scope = await pipeline(req, orgId, 'view');
    const { usersWithPermissionAt } = await import('../services/notifications.ts');
    const ids = scope === 'all'
      ? await usersWithPermissionAt(s.db, orgId, null, 'franchise.pipeline.edit')
      : [...new Set((await Promise.all([...scope].map((t) => usersWithCapabilityInTerritory(orgId, t)))).flat())];
    const names = await userNames(s.db, ids);
    return { items: ids.map((id) => ({ id, name: names.get(id) ?? '' })) };
  });

  /** People who work the pipeline of a territory (its own team; HQ's development team is not listed to them). */
  async function usersWithCapabilityInTerritory(orgId: string, territoryId: string) {
    const { loadOrgAssignments } = await import('../services/authz.ts');
    const { hasCapabilityInScope } = await import('../domain/scope.ts');
    const chain = { organizationId: orgId, kind: 'territory' as const, territoryId };
    return [...(await loadOrgAssignments(s.db, orgId)).entries()]
      .filter(([, a]) => a.some((x) => x.scopeKind === 'territory') && hasCapabilityInScope(a, 'sales.franchise_pipeline', 'edit', chain)).map(([id]) => id);
  }

  app.post('/orgs/:orgId/franchise/jobs/run', { schema: { tags, security: secured, params: orgParams, summary: 'Run due cadence emails, task reminders and agreement expiry reminders for this organisation now (also runs every 15 minutes)' } }, async (req) => {
    const { orgId } = req.params;
    await requireOrgPerm(req, s.db, orgId, 'franchise.pipeline.edit');
    return runFranchiseJobs(s, new Date(), orgId);
  });
};
