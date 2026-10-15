import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { MANUAL_STAGES, PROSPECT_SOURCES, currency, evaluateFranchiseCompliance, jurisdictionCode, ruleFor, splitAmounts, splitRuleSchema, type AccessAction, type FranchiseStage } from '@bh/shared';
import {
  financeInvoices, franchiseDocuments, franchiseProspects, franchiseRegistrations, franchiseTerritories, locations, masterAgreements, masterSplitStatements, organizations, ownerGroups, royaltyPeriods,
  royaltyStatements, type SplitStatementLine,
} from '../db/schema/index.ts';
import { transferToMaster } from '../integrations/master-payouts.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { renderPdf } from '../lib/pdf.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { hasCapability, requireMember } from '../services/authz.ts';
import { major, toCsv } from '../services/finance/exports.ts';
import { addActivity, generateCadenceTasks, getProspect, loadRules, sendDisclosure, serializeProspect, setStage } from '../services/franchise.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

const tags = ['master-franchise'];
const PIPE = 'sales.master_franchise';
const SPLITS = 'finance.royalty_splits';
type Master = typeof masterAgreements.$inferSelect;
type Statement = typeof masterSplitStatements.$inferSelect;
const country = z.string().length(2).transform((s) => s.toUpperCase());

/**
 * Who sees what: organisation-wide holders of the module see every master agreement ('all'); a master franchisee
 * (owner-group scope) sees the agreements of their own owner groups. Returns null when the person holds neither.
 */
async function reach(req: FastifyRequest, organizationId: string, module: string, action: AccessAction): Promise<'all' | Set<string> | null> {
  const mine = await requireMember(req, req.server.ctx.db, organizationId);
  if (await hasCapability(req, req.server.ctx.db, module, action, { organizationId, kind: 'organization', id: organizationId })) return 'all';
  const groups = mine.filter((a) => a.scopeKind === 'owner_group' && a.capabilities?.has(`${module}:${action}` as never)).map((a) => a.scopeId);
  return groups.length ? new Set(groups) : null;
}
const sees = (r: 'all' | Set<string> | null, m: Pick<Master, 'ownerGroupId'>) => r === 'all' || (!!r && r.has(m.ownerGroupId));

const inMaster = (m: Master, l: { country: string; address: { region?: string } }) => m.countries.includes(l.country) && (!m.regions.length || (!!l.address.region && m.regions.includes(l.address.region.toUpperCase())));

/**
 * Master franchise (`/v1/orgs/:orgId/master`): master agreements and the master franchisee's own pipeline,
 * territories and disclosure for their countries (module `sales.master_franchise`), and royalty split statements
 * with payouts (module `finance.royalty_splits`).
 */
export const masterRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const masterOut = (m: Master, groupName: string | null) => ({
    id: m.id, ownerGroupId: m.ownerGroupId, ownerGroupName: groupName, kind: m.kind, name: m.name, countries: m.countries, regions: m.regions, homeCountry: m.homeCountry, homeRegion: m.homeRegion,
    startDate: m.startDate, endDate: m.endDate, status: m.status, splits: m.splits, payoutMethod: m.payoutMethod, stripeAccountConnected: !!m.stripeAccountId, agreementId: m.agreementId, createdAt: m.createdAt.toISOString(),
  });

  async function loadMaster(req: FastifyRequest, orgId: string, id: string, module: string, action: AccessAction) {
    const [m] = await db.select().from(masterAgreements).where(and(eq(masterAgreements.id, id), eq(masterAgreements.organizationId, orgId)));
    const r = await reach(req, orgId, module, action);
    if (!m || !sees(r, m)) {
      if (m && (sees(await reach(req, orgId, module, 'view'), m))) throw forbidden(`You don't have ${action} access here`);
      throw notFound('Master agreement');
    }
    return m;
  }

  /* ----------------------------- agreements ------------------------------ */

  app.get('/orgs/:orgId/master/agreements', { schema: { tags, security: secured, params: orgParams, summary: 'Master franchise agreements: all for HQ, their own for a master franchisee' } }, async (req) => {
    const { orgId } = req.params;
    const r = (await reach(req, orgId, PIPE, 'view')) ?? (await reach(req, orgId, SPLITS, 'view'));
    if (!r) throw forbidden('Master franchise is not part of your access');
    const rows = await db.select({ m: masterAgreements, g: ownerGroups.name }).from(masterAgreements).innerJoin(ownerGroups, eq(ownerGroups.id, masterAgreements.ownerGroupId)).where(eq(masterAgreements.organizationId, orgId)).orderBy(asc(masterAgreements.name));
    const items = rows.filter(({ m }) => sees(r, m));
    const counts = items.length ? await db.select({ id: franchiseProspects.masterAgreementId, n: sql<number>`count(*)::int` }).from(franchiseProspects).where(and(inArray(franchiseProspects.masterAgreementId, items.map((x) => x.m.id)), sql`${franchiseProspects.stage} not in ('lost','opened')`)).groupBy(franchiseProspects.masterAgreementId) : [];
    const locs = await db.select({ id: locations.id, country: locations.country, address: locations.address, status: locations.status }).from(locations).where(eq(locations.organizationId, orgId));
    return {
      view: r === 'all' ? 'hq' : 'master',
      items: items.map(({ m, g }) => ({ ...masterOut(m, g), activeProspects: counts.find((c) => c.id === m.id)?.n ?? 0, units: locs.filter((l) => inMaster(m, l) && l.status === 'operating').length })),
      can: { manage: (await reach(req, orgId, PIPE, 'edit')) === 'all', splits: (await reach(req, orgId, SPLITS, 'edit')) === 'all', pay: (await reach(req, orgId, SPLITS, 'publish')) === 'all' },
    };
  });

  const masterBody = z.object({
    ownerGroupId: z.uuid(), kind: z.enum(['master_franchisee', 'area_representative']).default('master_franchisee'), name: z.string().trim().min(1).max(200),
    countries: z.array(country).min(1).max(30), regions: z.array(z.string().trim().min(1).max(10).transform((x) => x.toUpperCase())).max(100).default([]), homeCountry: country, homeRegion: z.string().max(10).nullable().optional(),
    startDate: z.iso.date(), endDate: z.iso.date().nullable().optional(), status: z.enum(['active', 'suspended', 'terminated', 'expired']).default('active'),
    splits: z.array(splitRuleSchema).max(20).default([]).refine((x) => new Set(x.map((r) => r.currency)).size === x.length, 'One split per currency'),
    payoutMethod: z.enum(['stripe_transfer', 'manual']).default('manual'), stripeAccountId: z.string().regex(/^acct_[A-Za-z0-9_]+$/).nullable().optional(), agreementId: z.uuid().nullable().optional(),
  });

  app.post('/orgs/:orgId/master/agreements', { schema: { tags, security: secured, params: orgParams, body: masterBody, summary: 'Add a master franchise or area representative agreement (HQ, master franchise edit)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if ((await reach(req, orgId, PIPE, 'edit')) !== 'all') throw forbidden('Only HQ can add master agreements');
    const b = req.body;
    const [g] = await db.select().from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
    if (!g) throw notFound('Owner group');
    if (b.payoutMethod === 'stripe_transfer' && !b.stripeAccountId) throw validationError('Connect the master’s Stripe account for transfers', { stripeAccountId: 'Required for Stripe transfers' });
    const others = await db.select().from(masterAgreements).where(and(eq(masterAgreements.organizationId, orgId), eq(masterAgreements.status, 'active')));
    const clash = others.find((o) => o.countries.some((c) => b.countries.includes(c)) && (!o.regions.length || !b.regions.length || o.regions.some((r) => b.regions.includes(r))));
    if (clash && b.status === 'active') throw conflict('master_overlap', `${clash.name} already covers ${clash.countries.filter((c) => b.countries.includes(c)).join(', ')}`);
    const [m] = await db.insert(masterAgreements).values({ organizationId: orgId, ...b, homeRegion: b.homeRegion ?? null, endDate: b.endDate ?? null, stripeAccountId: b.stripeAccountId ?? null, agreementId: b.agreementId ?? null, createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.agreement_added', targetType: 'master_agreement', targetId: m!.id, metadata: { countries: b.countries }, ip: req.ip });
    return reply.code(201).send(masterOut(m!, g.name));
  });

  app.patch('/orgs/:orgId/master/agreements/:id', { schema: { tags, security: secured, params: idParams, body: masterBody.partial() } }, async (req) => {
    const { orgId, id } = req.params;
    const needSplits = req.body.splits !== undefined || req.body.payoutMethod !== undefined || req.body.stripeAccountId !== undefined;
    if ((await reach(req, orgId, needSplits ? SPLITS : PIPE, 'edit')) !== 'all') throw forbidden('Only HQ can change master agreements');
    const [m] = await db.update(masterAgreements).set({ ...req.body, updatedAt: new Date() }).where(and(eq(masterAgreements.id, id), eq(masterAgreements.organizationId, orgId))).returning();
    if (!m) throw notFound('Master agreement');
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.agreement_updated', targetType: 'master_agreement', targetId: id, metadata: { changes: Object.keys(req.body) }, ip: req.ip });
    const [g] = await db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, m.ownerGroupId));
    return masterOut(m, g?.name ?? null);
  });

  /* ------------------------ the master's own pipeline ----------------------- */

  app.get('/orgs/:orgId/master/agreements/:id/pipeline', { schema: { tags, security: secured, params: idParams, summary: 'The master’s pipeline (prospects in their countries), territories and disclosure documents for their jurisdictions' } }, async (req) => {
    const { orgId, id } = req.params;
    const m = await loadMaster(req, orgId, id, PIPE, 'view');
    const pros = await db.select().from(franchiseProspects).where(and(eq(franchiseProspects.organizationId, orgId), eq(franchiseProspects.masterAgreementId, id))).orderBy(desc(franchiseProspects.updatedAt));
    const terr = await db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.organizationId, orgId), inArray(franchiseTerritories.country, m.countries)));
    const docs = await db.select().from(franchiseDocuments).where(and(eq(franchiseDocuments.organizationId, orgId), eq(franchiseDocuments.kind, 'disclosure'), eq(franchiseDocuments.status, 'current')));
    const myDocs = docs.filter((d) => d.jurisdictions.some((j) => m.countries.includes(j.slice(0, 2))));
    return {
      agreement: masterOut(m, null),
      prospects: pros.map((p) => serializeProspect(p, { territoryName: terr.find((t) => t.id === p.territoryId)?.name ?? null })),
      territories: terr.filter((t) => !m.regions.length || (t.region && m.regions.includes(t.region))).map((t) => ({ id: t.id, name: t.name, country: t.country, region: t.region, status: t.status, geometry: t.geometry ?? null, postcodes: t.postcodes, centroid: t.centroid ?? null })),
      documents: myDocs.map((d) => ({ id: d.id, title: d.title, version: d.version, jurisdictions: d.jurisdictions, issuedOn: d.issuedOn })),
      can: { edit: sees(await reach(req, orgId, PIPE, 'edit'), m), disclose: sees(await reach(req, orgId, PIPE, 'publish'), m) },
    };
  });

  app.get('/orgs/:orgId/master/agreements/:id/rules', { schema: { tags, security: secured, params: idParams, querystring: z.object({ country, region: z.string().max(10).optional() }), summary: 'Jurisdiction rules for a prospect in the master’s territory, with the master as franchisor (compliance aid, not legal advice)' } }, async (req) => {
    const { orgId, id } = req.params;
    const m = await loadMaster(req, orgId, id, PIPE, 'view');
    if (!m.countries.includes(req.query.country)) throw validationError('Outside this master’s countries', { country: 'Not covered' });
    const regs = await db.select().from(franchiseRegistrations).where(eq(franchiseRegistrations.organizationId, orgId));
    return {
      ...evaluateFranchiseCompliance({ franchisor: { country: m.homeCountry, region: m.homeRegion }, prospect: { country: req.query.country, region: req.query.region?.toUpperCase() ?? null }, rules: await loadRules(db, orgId), registrations: regs.map((r) => ({ jurisdiction: r.jurisdiction, status: r.status as 'registered', effectiveFrom: r.effectiveFrom, expiresAt: r.expiresAt })) }),
    };
  });

  app.post('/orgs/:orgId/master/agreements/:id/prospects', {
    schema: { tags, security: secured, params: idParams, body: z.object({ name: z.string().trim().min(1).max(120), email: z.email(), phone: z.string().max(40).nullable().optional(), country, region: z.string().max(10).nullable().optional(), city: z.string().max(120).nullable().optional(), territoryId: z.uuid().nullable().optional(), source: z.enum(PROSPECT_SOURCES).default('other'), message: z.string().max(4000).nullable().optional() }), summary: 'Add a prospect to the master’s pipeline (country must be one of theirs)' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    const m = await loadMaster(req, orgId, id, PIPE, 'edit');
    const b = req.body;
    if (!m.countries.includes(b.country)) throw validationError('Outside this master’s countries', { country: 'Not covered' });
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const p = await db.transaction(async (tx) => {
      const [p] = await tx.insert(franchiseProspects).values({ organizationId: orgId, name: b.name, email: b.email.toLowerCase(), phone: b.phone ?? null, country: b.country, region: b.region?.toUpperCase().replace(/^[A-Z]{2}-/, '') ?? null, city: b.city ?? null, territoryId: b.territoryId ?? null, source: b.source, message: b.message ?? null, currency: o!.defaultCurrency, ownerUserId: req.user!.id, masterAgreementId: m.id }).returning();
      await addActivity(tx, p!, 'enquiry', b.message ?? null, req.user!.id, { source: b.source, masterAgreementId: m.id });
      await generateCadenceTasks(tx, p!);
      return p!;
    });
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.prospect_added', targetType: 'franchise_prospect', targetId: p.id, metadata: { masterAgreementId: m.id }, ip: req.ip });
    return reply.code(201).send(serializeProspect(p));
  });

  const masterProspect = async (orgId: string, m: Master, pid: string) => {
    const p = await getProspect(db, orgId, pid);
    if (p.masterAgreementId !== m.id) throw notFound('Prospect');
    return p;
  };

  app.post('/orgs/:orgId/master/agreements/:id/prospects/:prospectId/stage', { schema: { tags, security: secured, params: idParams.extend({ prospectId: z.uuid() }), body: z.object({ stage: z.enum(MANUAL_STAGES as unknown as [FranchiseStage, ...FranchiseStage[]]), note: z.string().max(2000).nullable().optional() }) } }, async (req) => {
    const { orgId, id, prospectId } = req.params;
    const m = await loadMaster(req, orgId, id, PIPE, 'edit');
    const p = await masterProspect(orgId, m, prospectId);
    return serializeProspect(await setStage(db, p, req.body.stage, req.user!.id, req.body.note ?? null));
  });

  app.post('/orgs/:orgId/master/agreements/:id/prospects/:prospectId/disclosure', { schema: { tags, security: secured, params: idParams.extend({ prospectId: z.uuid() }), body: z.object({ documentId: z.uuid() }), summary: 'Send a disclosure document for the master’s jurisdiction (master franchise publish). Waiting periods use the master as franchisor.' } }, async (req, reply) => {
    const { orgId, id, prospectId } = req.params;
    const m = await loadMaster(req, orgId, id, PIPE, 'publish');
    const p = await masterProspect(orgId, m, prospectId);
    const [doc] = await db.select().from(franchiseDocuments).where(and(eq(franchiseDocuments.id, req.body.documentId), eq(franchiseDocuments.organizationId, orgId)));
    if (!doc || !doc.jurisdictions.some((j) => m.countries.includes(j.slice(0, 2)))) throw validationError('Choose a disclosure document for this master’s countries', { documentId: 'Not for these countries' });
    const out = await sendDisclosure(s, req, p, doc.id);
    return reply.code(201).send({ deliveryId: out.delivery.id, link: out.link, warnings: out.warnings, devToken: out.devToken, jurisdiction: jurisdictionCode(p.country, p.region) });
  });

  /* --------------------------- split statements --------------------------- */

  const stmtOut = (x: Statement, m?: Master | null, groupName?: string | null, period?: { startDate: string; endDate: string } | null) => ({
    id: x.id, masterAgreementId: x.masterAgreementId, masterName: m?.name ?? null, ownerGroupName: groupName ?? null, periodId: x.periodId, period: period ?? null, currency: x.currency, number: x.number,
    royaltyShareBps: x.royaltyShareBps, fundShareBps: x.fundShareBps, lines: x.lines, royaltyMinor: x.royaltyMinor, marketingFundMinor: x.marketingFundMinor, masterRoyaltyMinor: x.masterRoyaltyMinor, masterFundMinor: x.masterFundMinor,
    hqRoyaltyMinor: x.hqRoyaltyMinor, hqFundMinor: x.hqFundMinor, payableMinor: x.payableMinor, status: x.status, approvedAt: iso(x.approvedAt), payoutMethod: x.payoutMethod, transferId: x.transferId, payoutReference: x.payoutReference, paidAt: iso(x.paidAt), sandbox: x.sandbox,
  });

  app.get('/orgs/:orgId/master/periods', { schema: { tags, security: secured, params: orgParams, summary: 'Closed royalty periods (to generate split statements for)' } }, async (req) => {
    const { orgId } = req.params;
    if ((await reach(req, orgId, SPLITS, 'edit')) !== 'all') throw forbidden('Only HQ finance prepares split statements');
    const rows = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.organizationId, orgId)).orderBy(desc(royaltyPeriods.startDate)).limit(36);
    return { items: rows.map((p) => ({ id: p.id, startDate: p.startDate, endDate: p.endDate, frequency: p.frequency, status: p.status })) };
  });

  app.get('/orgs/:orgId/master/statements', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ masterAgreementId: z.uuid().optional() }), summary: 'Split statements: all for HQ finance, their own for a master franchisee' } }, async (req) => {
    const { orgId } = req.params;
    const r = await reach(req, orgId, SPLITS, 'view');
    if (!r) throw forbidden('Royalty splits are not part of your access');
    const masters = (await db.select({ m: masterAgreements, g: ownerGroups.name }).from(masterAgreements).innerJoin(ownerGroups, eq(ownerGroups.id, masterAgreements.ownerGroupId)).where(eq(masterAgreements.organizationId, orgId))).filter(({ m }) => sees(r, m));
    const ids = masters.map((x) => x.m.id).filter((x) => !req.query.masterAgreementId || x === req.query.masterAgreementId);
    const rows = ids.length ? await db.select({ x: masterSplitStatements, p: royaltyPeriods }).from(masterSplitStatements).innerJoin(royaltyPeriods, eq(royaltyPeriods.id, masterSplitStatements.periodId)).where(inArray(masterSplitStatements.masterAgreementId, ids)).orderBy(desc(royaltyPeriods.startDate), asc(masterSplitStatements.currency)) : [];
    return {
      view: r === 'all' ? 'hq' : 'master',
      items: rows.map(({ x, p }) => { const mm = masters.find((y) => y.m.id === x.masterAgreementId)!; return stmtOut(x, mm.m, mm.g, { startDate: p.startDate, endDate: p.endDate }); }),
      can: { generate: (await reach(req, orgId, SPLITS, 'edit')) === 'all', approve: (await reach(req, orgId, SPLITS, 'publish')) === 'all', export: !!(await reach(req, orgId, SPLITS, 'export')) },
      stripeMode: s.payments.mode,
    };
  });

  app.post('/orgs/:orgId/master/statements/generate', { schema: { tags, security: secured, params: orgParams, body: z.object({ periodId: z.uuid(), masterAgreementId: z.uuid().optional() }), summary: 'Build (or refresh draft) split statements for a period from the approved / invoiced royalty statements of units in each master’s countries' } }, async (req) => {
    const { orgId } = req.params;
    if ((await reach(req, orgId, SPLITS, 'edit')) !== 'all') throw forbidden('Only HQ finance prepares split statements');
    const [period] = await db.select().from(royaltyPeriods).where(and(eq(royaltyPeriods.id, req.body.periodId), eq(royaltyPeriods.organizationId, orgId)));
    if (!period) throw notFound('Period');
    const masters = await db.select().from(masterAgreements).where(and(eq(masterAgreements.organizationId, orgId), eq(masterAgreements.status, 'active'), ...(req.body.masterAgreementId ? [eq(masterAgreements.id, req.body.masterAgreementId)] : [])));
    const locs = await db.select().from(locations).where(eq(locations.organizationId, orgId));
    const stmts = await db.select({ st: royaltyStatements, inv: financeInvoices }).from(royaltyStatements).leftJoin(financeInvoices, eq(financeInvoices.id, royaltyStatements.invoiceId))
      .where(and(eq(royaltyStatements.periodId, period.id), inArray(royaltyStatements.status, ['approved', 'invoiced'])));
    const out: Statement[] = [];
    const skipped: Array<{ masterAgreementId: string; currency: string; reason: string }> = [];
    for (const m of masters) {
      const mine = stmts.filter(({ st }) => { const l = locs.find((x) => x.id === st.locationId); return !!l && inMaster(m, l); });
      for (const cur of [...new Set(mine.map(({ st }) => st.currency))]) {
        const rule = ruleFor(m.splits, cur);
        if (!rule) { skipped.push({ masterAgreementId: m.id, currency: cur, reason: 'no_split_for_currency' }); continue; }
        const lines: SplitStatementLine[] = mine.filter(({ st }) => st.currency === cur).map(({ st, inv }) => {
          const share = splitAmounts(st.royaltyMinor, st.marketingFundMinor, rule);
          // Collected part, prorated when the invoice is part paid (the fund share of a payment follows the invoice).
          const paidRatio = inv ? (inv.status === 'paid' ? 1 : inv.totalMinor > 0 ? Math.min(1, inv.paidMinor / inv.totalMinor) : 0) : 0;
          return {
            locationId: st.locationId, locationName: locs.find((l) => l.id === st.locationId)!.name, royaltyStatementId: st.id, statementStatus: inv?.status === 'paid' ? 'paid' : st.status,
            royaltyMinor: st.royaltyMinor, marketingFundMinor: st.marketingFundMinor, collectedRoyaltyMinor: Math.round(st.royaltyMinor * paidRatio), collectedFundMinor: Math.round(st.marketingFundMinor * paidRatio),
            masterRoyaltyMinor: share.masterRoyaltyMinor, masterFundMinor: share.masterFundMinor,
          };
        }).sort((a, b) => a.locationName.localeCompare(b.locationName));
        const royalty = lines.reduce((a, l) => a + l.royaltyMinor, 0);
        const fund = lines.reduce((a, l) => a + l.marketingFundMinor, 0);
        const total = splitAmounts(royalty, fund, rule);
        const collected = splitAmounts(lines.reduce((a, l) => a + l.collectedRoyaltyMinor, 0), lines.reduce((a, l) => a + l.collectedFundMinor, 0), rule);
        const vals = {
          royaltyShareBps: rule.royaltyShareBps, fundShareBps: rule.fundShareBps, lines, royaltyMinor: royalty, marketingFundMinor: fund, masterRoyaltyMinor: total.masterRoyaltyMinor, masterFundMinor: total.masterFundMinor,
          hqRoyaltyMinor: total.hqRoyaltyMinor, hqFundMinor: total.hqFundMinor, payableMinor: collected.masterRoyaltyMinor + collected.masterFundMinor, updatedAt: new Date(),
        };
        const [existing] = await db.select().from(masterSplitStatements).where(and(eq(masterSplitStatements.masterAgreementId, m.id), eq(masterSplitStatements.periodId, period.id), eq(masterSplitStatements.currency, cur)));
        if (existing && existing.status !== 'draft') { skipped.push({ masterAgreementId: m.id, currency: cur, reason: `statement_${existing.status}` }); continue; }
        const [row] = existing
          ? await db.update(masterSplitStatements).set(vals).where(eq(masterSplitStatements.id, existing.id)).returning()
          : await db.insert(masterSplitStatements).values({ organizationId: orgId, masterAgreementId: m.id, periodId: period.id, currency: cur, number: `MS-${period.startDate.slice(0, 7).replace('-', '')}-${m.id.slice(0, 4).toUpperCase()}-${cur}`, ...vals }).returning();
        out.push(row!);
      }
    }
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.statements_generated', metadata: { periodId: period.id, statements: out.length, skipped: skipped.length }, ip: req.ip });
    return { items: out.map((x) => stmtOut(x, masters.find((m) => m.id === x.masterAgreementId), null, { startDate: period.startDate, endDate: period.endDate })), skipped };
  });

  async function loadStatement(req: FastifyRequest, orgId: string, id: string, action: AccessAction) {
    const [x] = await db.select().from(masterSplitStatements).where(and(eq(masterSplitStatements.id, id), eq(masterSplitStatements.organizationId, orgId)));
    if (!x) throw notFound('Statement');
    const [m] = await db.select().from(masterAgreements).where(eq(masterAgreements.id, x.masterAgreementId));
    const r = await reach(req, orgId, SPLITS, action);
    if (!sees(r, m!)) { if (sees(await reach(req, orgId, SPLITS, 'view'), m!)) throw forbidden(`You don't have ${action} access to split statements`); throw notFound('Statement'); }
    return { x, m: m! };
  }

  app.get('/orgs/:orgId/master/statements/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const { x, m } = await loadStatement(req, orgId, id, 'view');
    const [p] = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, x.periodId));
    const [g] = await db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, m.ownerGroupId));
    return { ...stmtOut(x, m, g?.name ?? null, p ? { startDate: p.startDate, endDate: p.endDate } : null), payout: { method: m.payoutMethod, stripeAccountConnected: !!m.stripeAccountId, stripeMode: s.payments.mode } };
  });

  app.post('/orgs/:orgId/master/statements/:id/approve', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const { x, m } = await loadStatement(req, orgId, id, 'publish');
    if ((await reach(req, orgId, SPLITS, 'publish')) !== 'all') throw forbidden('Only HQ finance approves split statements');
    if (x.status !== 'draft') throw conflict('statement_not_draft', `This statement is ${x.status}`);
    const [row] = await db.update(masterSplitStatements).set({ status: 'approved', approvedBy: req.user!.id, approvedAt: new Date(), updatedAt: new Date() }).where(eq(masterSplitStatements.id, id)).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.statement_approved', targetType: 'master_split_statement', targetId: id, ip: req.ip });
    return stmtOut(row!, m);
  });

  app.post('/orgs/:orgId/master/statements/:id/pay', {
    schema: { tags, security: secured, params: idParams, body: z.object({ method: z.enum(['stripe_transfer', 'manual']).optional(), reference: z.string().max(200).nullable().optional() }).default({}), summary: 'Pay the master’s share of what was collected: Stripe Connect transfer (from the platform balance; see limits) or a recorded bank payment' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const { x, m } = await loadStatement(req, orgId, id, 'publish');
    if ((await reach(req, orgId, SPLITS, 'publish')) !== 'all') throw forbidden('Only HQ finance pays out');
    if (x.status !== 'approved') throw conflict('statement_not_approved', x.status === 'paid' ? 'This statement is already paid' : 'Approve the statement first');
    if (x.payableMinor <= 0) throw conflict('nothing_collected', 'Nothing has been collected for this statement yet');
    const method = req.body.method ?? m.payoutMethod;
    let transfer: { id: string; sandbox: boolean } | null = null;
    if (method === 'stripe_transfer') {
      if (!m.stripeAccountId) throw conflict('no_connected_account', 'The master has no connected Stripe account');
      try {
        transfer = await transferToMaster(s.payments, { amountMinor: x.payableMinor, currency: x.currency, destinationAccountId: m.stripeAccountId, statementId: x.id, description: `${m.name} ${x.number}` });
      } catch (err) {
        throw conflict('transfer_failed', `Stripe refused the transfer: ${(err as Error).message}. Pay by bank transfer and record it instead.`);
      }
    } else if (!req.body.reference) throw validationError('Add the bank payment reference', { reference: 'Required' });
    const [row] = await db.update(masterSplitStatements).set({ status: 'paid', payoutMethod: method, transferId: transfer?.id ?? null, payoutReference: req.body.reference ?? null, sandbox: transfer?.sandbox ?? false, paidAt: new Date(), paidBy: req.user!.id, updatedAt: new Date() }).where(eq(masterSplitStatements.id, id)).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'master.statement_paid', targetType: 'master_split_statement', targetId: id, metadata: { method, transferId: transfer?.id ?? null, amountMinor: x.payableMinor, currency: x.currency }, ip: req.ip });
    return stmtOut(row!, m);
  });

  app.get('/orgs/:orgId/master/statements/:id/export', { schema: { tags, security: secured, params: idParams, querystring: z.object({ format: z.enum(['csv', 'pdf']).default('pdf') }) } }, async (req, reply) => {
    const { orgId, id } = req.params;
    const { x, m } = await loadStatement(req, orgId, id, 'view');
    const [p] = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, x.periodId));
    const [o] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const M = (n: number) => `${major(n, x.currency)} ${x.currency}`;
    if (req.query.format === 'csv') {
      const csv = toCsv(['Location', 'Royalty', 'Marketing fund', 'Royalty collected', 'Fund collected', 'Master royalty share', 'Master fund share'], x.lines.map((l) => [l.locationName, major(l.royaltyMinor, x.currency), major(l.marketingFundMinor, x.currency), major(l.collectedRoyaltyMinor, x.currency), major(l.collectedFundMinor, x.currency), major(l.masterRoyaltyMinor, x.currency), major(l.masterFundMinor, x.currency)]));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${x.number}.csv"`).send(csv);
    }
    const texts: Array<{ x: number; y: number; text: string; size?: number; bold?: boolean; align?: 'left' | 'right' }> = [];
    let y = 800;
    texts.push({ x: 50, y, text: `${o!.name}: royalty split statement`, size: 15, bold: true }); y -= 22;
    texts.push({ x: 50, y, text: `${x.number} · ${m.name} · ${p?.startDate} to ${p?.endDate} · ${x.currency}` }); y -= 16;
    texts.push({ x: 50, y, text: `Master share: royalties ${(x.royaltyShareBps / 100).toFixed(2)}%, marketing fund ${(x.fundShareBps / 100).toFixed(2)}%` }); y -= 26;
    const cols = [50, 270, 360, 450, 545];
    ['Location', 'Royalty', 'Fund', 'Master share'].forEach((h, i) => texts.push({ x: i === 0 ? cols[0]! : cols[i + 1]!, y, text: h, bold: true, align: i === 0 ? 'left' : 'right' })); y -= 16;
    for (const l of x.lines) { texts.push({ x: cols[0]!, y, text: l.locationName }); texts.push({ x: cols[2]!, y, text: M(l.royaltyMinor), align: 'right' }); texts.push({ x: cols[3]!, y, text: M(l.marketingFundMinor), align: 'right' }); texts.push({ x: cols[4]!, y, text: M(l.masterRoyaltyMinor + l.masterFundMinor), align: 'right' }); y -= 14; }
    y -= 10;
    for (const [k, v] of [['Royalties billed', x.royaltyMinor], ['Marketing fund billed', x.marketingFundMinor], ['Master royalty share', x.masterRoyaltyMinor], ['Master fund share', x.masterFundMinor], ['HQ royalty share', x.hqRoyaltyMinor], ['HQ fund share', x.hqFundMinor], ['Payable to master (collected)', x.payableMinor]] as const) { texts.push({ x: 300, y, text: k, bold: k.startsWith('Payable') }); texts.push({ x: 545, y, text: M(v), align: 'right', bold: k.startsWith('Payable') }); y -= 14; }
    y -= 10;
    texts.push({ x: 50, y, text: `Status: ${x.status}${x.paidAt ? ` (paid ${x.paidAt.toISOString().slice(0, 10)}${x.transferId ? `, transfer ${x.transferId}` : x.payoutReference ? `, ref ${x.payoutReference}` : ''})` : ''}`, size: 9 });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${x.number}.pdf"`).send(renderPdf([{ texts }], { title: x.number }));
  });
};
