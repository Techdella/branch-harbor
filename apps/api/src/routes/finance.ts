import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  externalSalesReports, financeBalanceTransactions, financeDocuments, financeInvoices, financePaymentMethods, financePayouts, financeSettings, franchiseeStatements,
  marketingFundEntries, organizations, ownerGroups, royaltyDisputes, royaltyPeriods, royaltyStatements, royaltyTerms,
} from '../db/schema/index.ts';
import { isPeriodStart, periodContaining, type PeriodFrequency } from '../domain/royalty.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { capabilityLocations, hasCapability, locationAllowed, requireCapability, requireMember, type ScopeTarget } from '../services/authz.ts';
import { methodTypesFor } from '../integrations/finance-collection.ts';
import { buildExport, toCsv, major } from '../services/finance/exports.ts';
import { consumePendingSpendEvents, fundBalances, fundCampaignNames, fundCampaigns, recordSpend, serializeEntry, transparencyReport } from '../services/finance/fund.ts';
import {
  collectInvoice, collectionAccount, collectionAdapter, collectionCountry, confirmSandboxMethod, invoiceHistory, issueInvoice, mandateText, orgTimeZone, recordManualPayment, refreshMethod, revokeMethod, runDunning,
  serializeInvoice, serializeMethod, settleSandboxCollection, startPaymentMethodSetup, today,
} from '../services/finance/invoices.ts';
import { franchiseeStatementPdf, issueFranchiseeStatements, serializeFranchiseeStatement } from '../services/finance/franchisee-statements.ts';
import { invoicePdf } from '../services/finance/invoice-pdf.ts';
import { reconciliation, serializePayout, syncPayouts } from '../services/finance/payouts.ts';
import { financeReports } from '../services/finance/reports.ts';
import {
  addAdjustment, approveStatement, closePeriod, directory, loadStatement, raiseDispute, recalculateStatement, resolveDispute, reviewExternalSales, serializeStatement, statementDetail,
  submitExternalSales,
} from '../services/finance/statements.ts';
import { getFinanceSettings, resolveTerms, serializeSettings, serializeTerms } from '../services/finance/terms.ts';
import { brandInOrg, brandSharedCond } from '../services/brands.ts';
import { idParams, orgParams, secured } from './_common.ts';

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const currency = z.string().length(3).transform((c) => c.toUpperCase());
const minorInt = z.number().int();
const upload = z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(3).max(120), dataBase64: z.string().min(4) });
const UPLOAD_LIMIT = 8 * 1024 * 1024;

const basisSchema = z.object({
  streams: z.array(z.enum(['bookings', 'memberships', 'retail', 'food', 'gift_vouchers', 'other'])).min(1),
  netOfRefunds: z.boolean(), excludeTax: z.boolean(), excludeTips: z.boolean(), includeExternalSales: z.boolean(),
});
const termsBody = z.object({
  ownerGroupId: z.uuid().nullable().default(null),
  /** Brand default terms (multi-brand HQ): set with ownerGroupId null. */
  brandId: z.uuid().nullable().default(null),
  currency,
  effectiveFrom: ymd,
  effectiveTo: ymd.nullable().default(null),
  royaltyBps: z.number().int().min(0).max(10_000),
  tiers: z.array(z.object({ fromMinor: z.number().int().min(0), bps: z.number().int().min(0).max(10_000) })).max(10).default([]),
  tierMode: z.enum(['marginal', 'whole']).default('marginal'),
  minimumRoyaltyMinor: z.number().int().min(0).default(0),
  marketingFundBps: z.number().int().min(0).max(10_000).default(0),
  technologyFeeMinor: z.number().int().min(0).default(0),
  basis: basisSchema,
  lateFee: z.object({ kind: z.enum(['none', 'flat', 'percent']), flatMinor: z.number().int().min(0).optional(), bps: z.number().int().min(0).max(10_000).optional(), graceDays: z.number().int().min(0).max(365) }).default({ kind: 'none', graceDays: 0 }),
  notes: z.string().max(2000).nullable().optional(),
});
const settingsBody = z.object({
  periodFrequency: z.enum(['weekly', 'monthly']),
  weekStartsOn: z.number().int().min(1).max(7),
  invoicePrefix: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, 'Letters, digits and dashes (max 12)'),
  paymentTermsDays: z.number().int().min(0).max(120),
  taxLines: z.array(z.object({ name: z.string().min(1).max(60), rateBps: z.number().int().min(0).max(10_000), country: z.string().length(2).transform((c) => c.toUpperCase()).nullable(), appliesTo: z.array(z.enum(['royalty', 'marketing_fund', 'technology_fee', 'late_fee'])).min(1) })).max(10),
  dunning: z.object({ retryDays: z.array(z.number().int().min(1).max(120)).max(6), reminderDaysBefore: z.number().int().min(0).max(30), finalNoticeAfterDays: z.number().int().min(0).max(180) }),
  autoCollect: z.boolean(),
  issuerDetails: z.object({ legalName: z.string().max(200).optional(), address: z.string().max(400).optional(), taxNumber: z.string().max(60).optional(), email: z.string().max(200).optional() }),
}).partial();

/**
 * Finance workspace API (`/v1/orgs/:orgId/finance/...`): royalty terms, period close and statements, disputes,
 * invoices and collection, the marketing fund, payouts and reconciliation, exports and reports.
 *
 * Access: HQ actions need the module action organisation-wide (`finance.royalties`, `finance.payouts` are HQ-private).
 * Franchisees read and act through `finance.invoices` (statements & invoices) and `finance.marketing_fund` (view) in
 * their own scope; every list is filtered to the locations in scope and a record outside it answers 404.
 */
export const financeRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  // Scheduled dunning (BullMQ when REDIS_URL is set): enqueue `finance.dunning` with { organizationId } daily.
  s.jobs.register('finance.dunning', async ({ organizationId }: { organizationId: string }) => { await runDunning(s, organizationId); });

  const org = (orgId: string): ScopeTarget => ({ organizationId: orgId, kind: 'organization', id: orgId });
  const hq = (req: FastifyRequest, orgId: string, module: string, action: 'view' | 'edit' | 'publish' | 'export') => requireCapability(req, db, module, action, org(orgId));
  const isHq = (req: FastifyRequest, orgId: string, module = 'finance.royalties', action: 'view' | 'edit' | 'publish' | 'export' = 'view') => hasCapability(req, db, module, action, org(orgId));
  /** Locations whose statements and invoices the person may see. */
  const statementScope = async (req: FastifyRequest, orgId: string, action: 'view' | 'export' = 'view'): Promise<'all' | Set<string>> => {
    if (await isHq(req, orgId, 'finance.royalties', action)) return 'all';
    return capabilityLocations(req, db, orgId, 'finance.invoices', action);
  };
  const assertLocation = (allowed: 'all' | Set<string>, locationId: string | null, what: string) => {
    if (!locationAllowed(allowed, locationId)) throw notFound(what);
  };
  const todayFor = async (orgId: string) => today(await orgTimeZone(db, orgId));
  const loadInvoice = async (orgId: string, id: string) => {
    const [inv] = await db.select().from(financeInvoices).where(and(eq(financeInvoices.id, id), eq(financeInvoices.organizationId, orgId)));
    if (!inv) throw notFound('Invoice');
    return inv;
  };

  /* ---------------- Overview ---------------- */

  app.get('/orgs/:orgId/finance/overview', { schema: { tags: ['finance'], security: secured, params: orgParams, summary: 'Finance home: what is due, overdue and in the fund, per currency, for the person’s scope' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    const day = await todayFor(orgId);
    const invs = (await db.select().from(financeInvoices).where(and(eq(financeInvoices.organizationId, orgId), inArray(financeInvoices.status, ['open', 'processing'])))).filter((i) => locationAllowed(scope, i.locationId));
    const due = new Map<string, { currency: string; openMinor: number; overdueMinor: number; open: number; overdue: number }>();
    for (const i of invs) {
      const d = due.get(i.currency) ?? { currency: i.currency, openMinor: 0, overdueMinor: 0, open: 0, overdue: 0 };
      const owed = i.totalMinor - i.paidMinor;
      d.open++;
      d.openMinor += owed;
      if (i.dueDate < day) { d.overdue++; d.overdueMinor += owed; }
      due.set(i.currency, d);
    }
    const stmts = (await db.select({ id: royaltyStatements.id, status: royaltyStatements.status, locationId: royaltyStatements.locationId }).from(royaltyStatements).where(and(eq(royaltyStatements.organizationId, orgId), inArray(royaltyStatements.status, ['draft', 'disputed', 'approved'])))).filter((x) => locationAllowed(scope, x.locationId));
    const fundView = (await capabilityLocations(req, db, orgId, 'finance.marketing_fund', 'view').catch(() => new Set<string>()));
    const settings = await getFinanceSettings(db, orgId);
    return {
      today: day, periodFrequency: settings.periodFrequency, receivables: [...due.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      statements: { draft: stmts.filter((x) => x.status === 'draft').length, disputed: stmts.filter((x) => x.status === 'disputed').length, approved: stmts.filter((x) => x.status === 'approved').length },
      fund: fundView === 'all' || fundView.size ? await fundBalances(db, orgId) : null,
      sandbox: collectionAdapter(s).mode === 'sandbox',
    };
  });

  /* ---------------- Settings & terms (HQ) ---------------- */

  app.get('/orgs/:orgId/finance/settings', { schema: { tags: ['finance'], security: secured, params: orgParams } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'view');
    const row = await getFinanceSettings(db, req.params.orgId);
    return { ...serializeSettings(row), collectionMode: collectionAdapter(s).mode, collectionAccountId: await collectionAccount(db, req.params.orgId) };
  });

  app.put('/orgs/:orgId/finance/settings', { schema: { tags: ['finance'], security: secured, params: orgParams, body: settingsBody, summary: 'Period frequency, invoice numbering, payment terms, HQ-configured tax lines, dunning' } }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'edit');
    await getFinanceSettings(db, orgId);
    const [row] = await db.update(financeSettings).set({ ...req.body, updatedAt: new Date() }).where(eq(financeSettings.organizationId, orgId)).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'finance.settings_updated', scopeKind: 'organization', scopeId: orgId, metadata: { fields: Object.keys(req.body) } });
    return serializeSettings(row!);
  });

  app.post('/orgs/:orgId/finance/collection-account', {
    schema: { tags: ['finance'], security: secured, params: orgParams, summary: 'Connect the franchisor account that receives royalties (Stripe Connect onboarding link)', body: z.object({ returnUrl: z.url().optional(), refreshUrl: z.url().optional() }).default({}) },
  }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'edit');
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    let accountId = await collectionAccount(db, orgId);
    if (!accountId) {
      accountId = (await s.payments.createConnectedAccount({ country: o!.country, email: null, businessName: `${o!.name} — royalties` })).accountId;
      await db.update(financeSettings).set({ collectionAccountId: accountId, updatedAt: new Date() }).where(eq(financeSettings.organizationId, orgId));
    }
    const link = await s.payments.createOnboardingLink(accountId, req.body.refreshUrl ?? `${s.cfg.APP_URL}/finance/royalties`, req.body.returnUrl ?? `${s.cfg.APP_URL}/finance/royalties`);
    await audit(db, { organizationId: orgId, ...actor(req), action: 'finance.collection_account_onboarding', scopeKind: 'organization', scopeId: orgId, metadata: { accountId } });
    return { accountId, url: link.url, mode: s.payments.mode };
  });

  app.get('/orgs/:orgId/finance/terms', { schema: { tags: ['finance'], security: secured, params: orgParams } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'view');
    const rows = await db.select().from(royaltyTerms).where(and(eq(royaltyTerms.organizationId, req.params.orgId), await brandSharedCond(req, db, req.params.orgId, royaltyTerms.brandId))).orderBy(asc(royaltyTerms.currency), desc(royaltyTerms.effectiveFrom));
    const groups = await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, req.params.orgId));
    return { items: rows.map(serializeTerms), ownerGroups: groups };
  });

  const checkTerms = async (orgId: string, b: z.infer<typeof termsBody>) => {
    if (b.ownerGroupId) {
      const [g] = await db.select({ id: ownerGroups.id }).from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
      if (!g) throw notFound('Owner group');
    }
    if (b.brandId) {
      if (b.ownerGroupId) throw validationError('Brand terms are the brand’s default: leave the owner group empty', { brandId: 'Brand defaults have no owner group' });
      if (!(await brandInOrg(db, orgId, b.brandId))) throw notFound('Brand');
    }
    if (b.effectiveTo && b.effectiveTo <= b.effectiveFrom) throw validationError('The end date must be after the start date', { effectiveTo: 'After the start date' });
    if (b.lateFee.kind === 'flat' && !b.lateFee.flatMinor) throw validationError('Set the flat late fee amount', { flatMinor: 'Required' });
    if (b.lateFee.kind === 'percent' && !b.lateFee.bps) throw validationError('Set the late fee rate', { bps: 'Required' });
  };

  app.post('/orgs/:orgId/finance/terms', { schema: { tags: ['finance'], security: secured, params: orgParams, body: termsBody, summary: 'Royalty terms for an owner group (or the organisation default) in one currency' } }, async (req, reply) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'edit');
    await checkTerms(orgId, req.body);
    const [row] = await db.insert(royaltyTerms).values({ organizationId: orgId, ...req.body, notes: req.body.notes ?? null, createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'finance.terms_created', scopeKind: req.body.ownerGroupId ? 'owner_group' : 'organization', scopeId: req.body.ownerGroupId ?? orgId, targetType: 'royalty_terms', targetId: row!.id, metadata: { currency: row!.currency, royaltyBps: row!.royaltyBps, marketingFundBps: row!.marketingFundBps } });
    return reply.code(201).send(serializeTerms(row!));
  });

  app.put('/orgs/:orgId/finance/terms/:id', { schema: { tags: ['finance'], security: secured, params: idParams, body: termsBody } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId, 'finance.royalties', 'edit');
    await checkTerms(orgId, req.body);
    const [row] = await db.update(royaltyTerms).set({ ...req.body, notes: req.body.notes ?? null, updatedAt: new Date() }).where(and(eq(royaltyTerms.id, id), eq(royaltyTerms.organizationId, orgId))).returning();
    if (!row) throw notFound('Terms');
    await audit(db, { organizationId: orgId, ...actor(req), action: 'finance.terms_updated', scopeKind: 'organization', scopeId: orgId, targetType: 'royalty_terms', targetId: id });
    return serializeTerms(row);
  });

  app.get('/orgs/:orgId/finance/terms/resolve', {
    schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid(), date: ymd }), summary: 'The terms that would apply to a location on a date (agreement → owner group → organisation)' },
  }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'view');
    const dir = await directory(db, orgId);
    const loc = dir.locations.get(req.query.locationId);
    if (!loc) throw notFound('Location');
    return { terms: await resolveTerms(db, { organizationId: orgId, ownerGroupId: loc.ownerGroupId, locationId: loc.id, currency: loc.currency, onDate: req.query.date }) };
  });

  /* ---------------- Periods & statements ---------------- */

  app.get('/orgs/:orgId/finance/periods', { schema: { tags: ['finance'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    if (scope !== 'all' && !scope.size) throw new AppError(403, 'forbidden', 'You don’t have access to royalty statements');
    const settings = await getFinanceSettings(db, orgId);
    const rows = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.organizationId, orgId)).orderBy(desc(royaltyPeriods.startDate));
    const day = await todayFor(orgId);
    const current = periodContaining(settings.periodFrequency as PeriodFrequency, day, settings.weekStartsOn);
    const previous = periodContaining(settings.periodFrequency as PeriodFrequency, new Date(Date.parse(`${current.startDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10), settings.weekStartsOn);
    return { frequency: settings.periodFrequency, current, suggestedClose: previous, items: rows.map((p) => ({ id: p.id, frequency: p.frequency, startDate: p.startDate, endDate: p.endDate, status: p.status, closedAt: p.closedAt?.toISOString() ?? null })) };
  });

  app.post('/orgs/:orgId/finance/periods/close', { schema: { tags: ['finance'], security: secured, params: orgParams, body: z.object({ startDate: ymd }), summary: 'Close a period: statements for every franchised location (period end checked in each location’s time zone)' } }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'edit');
    const r = await closePeriod(s, orgId, req.body.startDate, req.user!.id);
    return { period: { id: r.period.id, startDate: r.period.startDate, endDate: r.period.endDate, frequency: r.period.frequency, status: r.period.status }, statements: r.statementIds.length, missingTerms: r.missingTerms };
  });

  app.post('/orgs/:orgId/finance/periods/:id/invoice-approved', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Issue invoices for every approved statement of the period' } }, async (req) => {
    const { orgId, id } = req.params;
    await hq(req, orgId, 'finance.royalties', 'publish');
    const approved = await db.select({ id: royaltyStatements.id }).from(royaltyStatements).where(and(eq(royaltyStatements.organizationId, orgId), eq(royaltyStatements.periodId, id), eq(royaltyStatements.status, 'approved')));
    const issued: string[] = [];
    const skipped: Array<{ statementId: string; code: string }> = [];
    for (const st of approved) {
      try { issued.push((await issueInvoice(s, orgId, st.id, req.user!.id)).invoice.id); } catch (e) { skipped.push({ statementId: st.id, code: (e as AppError).code ?? 'error' }); }
    }
    return { issued: issued.length, skipped };
  });

  app.get('/orgs/:orgId/finance/statements', {
    schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ periodId: z.uuid().optional(), status: z.string().optional(), locationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) },
  }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    if (scope !== 'all' && !scope.size) throw new AppError(403, 'forbidden', 'You don’t have access to royalty statements');
    const conds = [eq(royaltyStatements.organizationId, orgId)];
    if (req.query.periodId) conds.push(eq(royaltyStatements.periodId, req.query.periodId));
    if (req.query.status) conds.push(eq(royaltyStatements.status, req.query.status));
    if (req.query.locationId) conds.push(eq(royaltyStatements.locationId, req.query.locationId));
    if (scope !== 'all') conds.push(inArray(royaltyStatements.locationId, [...scope]));
    const rows = await db.select({ st: royaltyStatements, p: royaltyPeriods }).from(royaltyStatements).innerJoin(royaltyPeriods, eq(royaltyPeriods.id, royaltyStatements.periodId)).where(and(...conds)).orderBy(desc(royaltyPeriods.startDate)).limit(req.query.limit);
    const invIds = rows.map((r) => r.st.invoiceId).filter((x): x is string => !!x);
    const invs = new Map((invIds.length ? await db.select().from(financeInvoices).where(inArray(financeInvoices.id, invIds)) : []).map((i) => [i.id, i]));
    const dir = await directory(db, orgId);
    return { items: rows.map((r) => serializeStatement(r.st, dir, r.p, r.st.invoiceId ? invs.get(r.st.invoiceId) ?? null : null)) };
  });

  app.get('/orgs/:orgId/finance/statements/:id', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const st = await loadStatement(db, orgId, id);
    assertLocation(await statementScope(req, orgId), st.locationId, 'Statement');
    const detail = await statementDetail(db, st, await directory(db, orgId));
    // Terms snapshots are HQ data (other franchisees' rates never leave HQ); franchisees see the rates on the lines.
    return (await isHq(req, orgId)) ? detail : { ...detail, terms: null };
  });

  app.post('/orgs/:orgId/finance/statements/:id/recalculate', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const row = await recalculateStatement(s, req.params.orgId, req.params.id, req.user!.id);
    return statementDetail(db, row, await directory(db, req.params.orgId));
  });

  app.post('/orgs/:orgId/finance/statements/:id/adjustments', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ amountMinor: minorInt, description: z.string().min(2).max(300) }) } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const row = await addAdjustment(s, req.params.orgId, req.params.id, req.body, req.user!.id);
    return statementDetail(db, row, await directory(db, req.params.orgId));
  });

  app.post('/orgs/:orgId/finance/statements/:id/approve', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Finance approves a statement before invoicing' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'publish');
    const row = await approveStatement(s, req.params.orgId, req.params.id, req.user!.id);
    return statementDetail(db, row, await directory(db, req.params.orgId));
  });

  app.post('/orgs/:orgId/finance/statements/:id/invoice', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Issue the invoice for an approved statement (collects automatically when a mandate is active and auto-collect is on)' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await hq(req, orgId, 'finance.royalties', 'publish');
    const r = await issueInvoice(s, orgId, id, req.user!.id);
    return reply.code(201).send({ invoice: serializeInvoice(r.invoice, await todayFor(orgId)), collection: r.collection ? { status: r.collection.status, failureCode: r.collection.failureCode } : null });
  });

  app.post('/orgs/:orgId/finance/statements/:id/disputes', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ reason: z.string().min(5).max(2000), lineId: z.uuid().nullable().optional() }), summary: 'Franchisee disputes a statement or one of its lines' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const st = await loadStatement(db, orgId, id);
    assertLocation(await statementScope(req, orgId), st.locationId, 'Statement');
    await requireCapability(req, db, 'finance.invoices', 'edit', { organizationId: orgId, kind: 'location', id: st.locationId });
    const d = await raiseDispute(s, orgId, id, { reason: req.body.reason, lineId: req.body.lineId ?? null }, req.user!.id);
    return reply.code(201).send({ id: d.id, status: d.status });
  });

  app.post('/orgs/:orgId/finance/disputes/:id/resolve', {
    schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ decision: z.enum(['accepted', 'rejected']), resolution: z.string().min(2).max(2000), adjustmentMinor: minorInt.nullable().optional() }), summary: 'HQ finance resolves a dispute (accepted disputes can add an adjustment)' },
  }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const d = await resolveDispute(s, req.params.orgId, req.params.id, { decision: req.body.decision, resolution: req.body.resolution, adjustmentMinor: req.body.adjustmentMinor ?? null }, req.user!.id);
    return { id: d.id, status: d.status, adjustmentMinor: d.adjustmentMinor };
  });

  app.get('/orgs/:orgId/finance/disputes', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'accepted', 'rejected']).optional() }) } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    const rows = await db.select({ d: royaltyDisputes, st: royaltyStatements }).from(royaltyDisputes).innerJoin(royaltyStatements, eq(royaltyStatements.id, royaltyDisputes.statementId))
      .where(and(eq(royaltyDisputes.organizationId, orgId), req.query.status ? eq(royaltyDisputes.status, req.query.status) : undefined)).orderBy(desc(royaltyDisputes.createdAt));
    const dir = await directory(db, orgId);
    return { items: rows.filter((r) => locationAllowed(scope, r.st.locationId)).map((r) => ({ id: r.d.id, statementId: r.st.id, location: { id: r.st.locationId, name: dir.locations.get(r.st.locationId)?.name ?? null }, reason: r.d.reason, status: r.d.status, resolution: r.d.resolution, adjustmentMinor: r.d.adjustmentMinor, currency: r.st.currency, createdAt: r.d.createdAt.toISOString() })) };
  });

  /* ---------------- External sales ---------------- */

  app.get('/orgs/:orgId/finance/external-sales', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ status: z.string().optional() }) } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    const rows = await db.select().from(externalSalesReports).where(and(eq(externalSalesReports.organizationId, orgId), req.query.status ? eq(externalSalesReports.status, req.query.status) : undefined)).orderBy(desc(externalSalesReports.periodStart));
    const dir = await directory(db, orgId);
    return {
      items: rows.filter((r) => locationAllowed(scope, r.locationId)).map((r) => ({
        id: r.id, location: { id: r.locationId, name: dir.locations.get(r.locationId)?.name ?? null }, frequency: r.frequency, periodStart: r.periodStart, currency: r.currency,
        grossMinor: r.grossMinor, refundsMinor: r.refundsMinor, taxMinor: r.taxMinor, note: r.note, evidenceDocumentId: r.evidenceDocumentId, status: r.status, reviewNote: r.reviewNote, createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post('/orgs/:orgId/finance/external-sales', {
    bodyLimit: UPLOAD_LIMIT,
    schema: { tags: ['finance'], security: secured, params: orgParams, body: z.object({ locationId: z.uuid(), periodStart: ymd, grossMinor: minorInt, refundsMinor: minorInt.default(0), taxMinor: minorInt.default(0), note: z.string().max(1000).nullable().optional(), evidence: upload }), summary: 'Report sales from an external POS for a period, with evidence (PDF, image, CSV, spreadsheet up to 5 MB)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireCapability(req, db, 'finance.invoices', 'edit', { organizationId: orgId, kind: 'location', id: req.body.locationId });
    const r = await submitExternalSales(s, orgId, { ...req.body, note: req.body.note ?? null }, req.user!.id);
    return reply.code(201).send({ id: r.id, status: r.status });
  });

  app.post('/orgs/:orgId/finance/external-sales/:id/review', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ decision: z.enum(['accepted', 'rejected']), note: z.string().max(1000).nullable().optional() }) } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const r = await reviewExternalSales(s, req.params.orgId, req.params.id, { decision: req.body.decision, note: req.body.note ?? null }, req.user!.id);
    return { id: r.id, status: r.status };
  });

  app.get('/orgs/:orgId/finance/documents/:id', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Download sales evidence or a fund receipt' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const [doc] = await db.select().from(financeDocuments).where(and(eq(financeDocuments.id, id), eq(financeDocuments.organizationId, orgId)));
    if (!doc) throw notFound('Document');
    if (doc.kind === 'receipt') {
      const fund = await capabilityLocations(req, db, orgId, 'finance.marketing_fund', 'view');
      if (fund !== 'all' && !fund.size) throw notFound('Document');
    } else assertLocation(await statementScope(req, orgId), doc.locationId, 'Document');
    return reply.header('Content-Disposition', `attachment; filename="${doc.filename.replace(/[^\w.\- ]/g, '_')}"`).type(doc.contentType).send(Buffer.from(doc.dataBase64, 'base64'));
  });

  /* ---------------- Invoices ---------------- */

  app.get('/orgs/:orgId/finance/invoices', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ status: z.string().optional(), locationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const scope = await statementScope(req, orgId);
    if (scope !== 'all' && !scope.size) throw new AppError(403, 'forbidden', 'You don’t have access to invoices');
    const conds = [eq(financeInvoices.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(financeInvoices.locationId, req.query.locationId));
    if (scope !== 'all') conds.push(inArray(financeInvoices.locationId, [...scope]));
    const day = await todayFor(orgId);
    const dir = await directory(db, orgId);
    let items = (await db.select().from(financeInvoices).where(and(...conds)).orderBy(desc(financeInvoices.seq)).limit(req.query.limit)).map((i) => serializeInvoice(i, day, dir));
    if (req.query.status) items = items.filter((i) => i.state === req.query.status || i.status === req.query.status);
    return { items, today: day };
  });

  app.get('/orgs/:orgId/finance/invoices/:id', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const inv = await loadInvoice(orgId, id);
    assertLocation(await statementScope(req, orgId), inv.locationId, 'Invoice');
    const method = inv.ownerGroupId ? (await db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.ownerGroupId, inv.ownerGroupId), eq(financePaymentMethods.currency, inv.currency), eq(financePaymentMethods.status, 'active'))))[0] : undefined;
    return { ...serializeInvoice(inv, await todayFor(orgId), await directory(db, orgId)), ...(await invoiceHistory(db, inv.id)), paymentMethod: method ? serializeMethod(method) : null };
  });

  app.get('/orgs/:orgId/finance/invoices/:id/pdf', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Invoice PDF' } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const inv = await loadInvoice(orgId, id);
    assertLocation(await statementScope(req, orgId), inv.locationId, 'Invoice');
    const [st] = await db.select().from(royaltyStatements).where(eq(royaltyStatements.id, inv.statementId));
    const [period] = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, st!.periodId));
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const dir = await directory(db, orgId);
    const g = inv.ownerGroupId ? dir.groups.get(inv.ownerGroupId) : undefined;
    const pdf = invoicePdf({ invoice: inv, statement: st!, period, orgName: o!.name, settings: await getFinanceSettings(db, orgId), billTo: { name: g?.name ?? '', legalName: g?.legalName ?? null }, locationName: dir.locations.get(inv.locationId)?.name ?? '' });
    return reply.header('Content-Disposition', `inline; filename="${inv.number}.pdf"`).type('application/pdf').send(pdf);
  });

  app.post('/orgs/:orgId/finance/invoices/:id/collect', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Collect now from the franchisee’s active mandate (off-session debit on the collection account)' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const a = await collectInvoice(s, req.params.orgId, req.params.id, { actorUserId: req.user!.id, trigger: 'manual' });
    return { attempt: a.attempt, status: a.status, failureCode: a.failureCode, failureMessage: a.failureMessage };
  });

  app.post('/orgs/:orgId/finance/invoices/:id/pay', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Franchisee pays an invoice now with the saved method' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const inv = await loadInvoice(orgId, id);
    assertLocation(await statementScope(req, orgId), inv.locationId, 'Invoice');
    await requireCapability(req, db, 'finance.invoices', 'edit', { organizationId: orgId, kind: 'location', id: inv.locationId });
    const a = await collectInvoice(s, orgId, id, { actorUserId: req.user!.id, trigger: 'franchisee' });
    return { attempt: a.attempt, status: a.status, failureCode: a.failureCode, failureMessage: a.failureMessage };
  });

  app.post('/orgs/:orgId/finance/invoices/:id/record-payment', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ amountMinor: minorInt, reference: z.string().min(1).max(120), receivedOn: ymd }), summary: 'Record a payment received outside Stripe' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    const inv = await recordManualPayment(s, req.params.orgId, req.params.id, req.body, req.user!.id);
    return serializeInvoice(inv, await todayFor(req.params.orgId));
  });

  app.post('/orgs/:orgId/finance/invoices/:id/sandbox-settle', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ outcome: z.enum(['succeeded', 'failed']) }), summary: 'SANDBOX ONLY: settle a processing bank debit' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    if (s.cfg.NODE_ENV === 'production' && collectionAdapter(s).mode !== 'sandbox') throw notFound('Route');
    const outcome = await settleSandboxCollection(s, req.params.orgId, req.params.id, req.body.outcome);
    return { outcome, invoice: serializeInvoice(await loadInvoice(req.params.orgId, req.params.id), await todayFor(req.params.orgId)) };
  });

  app.post('/orgs/:orgId/finance/dunning/run', { schema: { tags: ['finance'], security: secured, params: orgParams, body: z.object({ today: ymd.optional() }).default({}), summary: 'Run dunning now: reminders, late fees, retries and final notices (each step recorded once)' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'edit');
    // A date other than today is only accepted outside production (testing dunning schedules).
    const day = req.body.today && s.cfg.NODE_ENV !== 'production' ? req.body.today : undefined;
    return runDunning(s, req.params.orgId, day);
  });

  /* ---------------- Payment methods (mandates) ---------------- */

  /** Owner groups whose payment methods the person may see / manage. */
  const groupsInScope = async (req: FastifyRequest, orgId: string, action: 'view' | 'edit'): Promise<'all' | Set<string>> => {
    if (await isHq(req, orgId, 'finance.royalties', action === 'edit' ? 'edit' : 'view')) return 'all';
    const groups = await db.select({ id: ownerGroups.id }).from(ownerGroups).where(eq(ownerGroups.organizationId, orgId));
    const out = new Set<string>();
    for (const g of groups) if (await hasCapability(req, db, 'finance.invoices', action, { organizationId: orgId, kind: 'owner_group', id: g.id })) out.add(g.id);
    return out;
  };

  app.get('/orgs/:orgId/finance/payment-methods', { schema: { tags: ['finance'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const groups = await groupsInScope(req, orgId, 'view');
    const rows = await db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.organizationId, orgId), inArray(financePaymentMethods.status, ['pending', 'verifying', 'active', 'failed']))).orderBy(desc(financePaymentMethods.createdAt));
    const dir = await directory(db, orgId);
    const country = await collectionCountry(s, orgId);
    const groupList = groups === 'all' ? [...dir.groups.values()] : [...groups].map((g) => dir.groups.get(g)!).filter(Boolean);
    const currenciesByGroup = new Map<string, Set<string>>();
    for (const l of dir.locations.values()) if (l.ownerGroupId) currenciesByGroup.set(l.ownerGroupId, (currenciesByGroup.get(l.ownerGroupId) ?? new Set()).add(l.currency));
    return {
      mode: collectionAdapter(s).mode, collectionCountry: country,
      ownerGroups: groupList.map((g) => ({ id: g.id, name: g.name, currencies: [...(currenciesByGroup.get(g.id) ?? [])].sort().map((c) => ({ currency: c, methodTypes: methodTypesFor(c, country) })) })),
      items: rows.filter((r) => groups === 'all' || groups.has(r.ownerGroupId)).map(serializeMethod),
    };
  });

  const methodInScope = async (req: FastifyRequest, orgId: string, id: string) => {
    const [pm] = await db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.id, id), eq(financePaymentMethods.organizationId, orgId)));
    if (!pm) throw notFound('Payment method');
    const groups = await groupsInScope(req, orgId, 'edit');
    if (groups !== 'all' && !groups.has(pm.ownerGroupId)) throw notFound('Payment method');
    return pm;
  };

  const methodTypeSchema = z.enum(['card', 'us_bank_account', 'acss_debit', 'bacs_debit', 'sepa_debit', 'au_becs_debit']);

  app.get('/orgs/:orgId/finance/payment-methods/mandate', {
    schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ ownerGroupId: z.uuid(), currency, methodType: methodTypeSchema }), summary: 'The exact authorisation text the franchisee is about to accept (shown before accepting; stored verbatim)' },
  }, async (req) => {
    const { orgId } = req.params;
    await requireCapability(req, db, 'finance.invoices', 'view', { organizationId: orgId, kind: 'owner_group', id: req.query.ownerGroupId });
    const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const [g] = await db.select().from(ownerGroups).where(and(eq(ownerGroups.id, req.query.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
    if (!g) throw notFound('Owner group');
    const offered = methodTypesFor(req.query.currency, await collectionCountry(s, orgId));
    if (!offered.includes(req.query.methodType)) throw validationError(`${req.query.methodType} is not available for ${req.query.currency}`, { methodType: `Use one of ${offered.join(', ')}` });
    return { methodType: req.query.methodType, currency: req.query.currency, mandateText: mandateText(o!.name, g.legalName ?? g.name, req.query.methodType, req.query.currency), methodTypes: offered };
  });

  app.post('/orgs/:orgId/finance/payment-methods/setup', {
    schema: { tags: ['finance'], security: secured, params: orgParams, body: z.object({ ownerGroupId: z.uuid(), currency, methodType: methodTypeSchema, acceptMandate: z.boolean(), mandateText: z.string().max(4000).optional(), locale: z.string().max(10).optional() }), summary: 'Start saving a debit method: accepts the mandate (the text shown is checked and stored) and returns a SetupIntent for the collection account' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireCapability(req, db, 'finance.invoices', 'edit', { organizationId: orgId, kind: 'owner_group', id: req.body.ownerGroupId });
    const r = await startPaymentMethodSetup(s, orgId, req.body, { userId: req.user!.id, ip: req.ip });
    return reply.code(201).send(r);
  });

  app.post('/orgs/:orgId/finance/payment-methods/:id/sandbox-confirm', { schema: { tags: ['finance'], security: secured, params: idParams, body: z.object({ outcome: z.enum(['ok', 'decline']).default('ok') }), summary: 'SANDBOX ONLY: complete the SetupIntent' } }, async (req) => {
    const pm = await methodInScope(req, req.params.orgId, req.params.id);
    return serializeMethod(await confirmSandboxMethod(s, req.params.orgId, pm.id, req.body.outcome, req.user!.id));
  });

  app.post('/orgs/:orgId/finance/payment-methods/:id/refresh', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Check the SetupIntent with Stripe and activate the method when it succeeded' } }, async (req) => {
    const pm = await methodInScope(req, req.params.orgId, req.params.id);
    return serializeMethod(await refreshMethod(s, req.params.orgId, pm.id));
  });

  app.post('/orgs/:orgId/finance/payment-methods/:id/revoke', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) => {
    const pm = await methodInScope(req, req.params.orgId, req.params.id);
    return serializeMethod(await revokeMethod(s, req.params.orgId, pm.id, req.user!.id));
  });

  /* ---------------- Monthly statements per franchisee ---------------- */

  app.post('/orgs/:orgId/finance/periods/:id/franchisee-statements', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Issue (or refresh) the monthly statement of every franchisee for the period, and email new ones to the franchise owners' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.royalties', 'publish');
    const r = await issueFranchiseeStatements(s, req.params.orgId, req.params.id, req.user!.id);
    return { items: await Promise.all(r.items.map((x) => serializeFranchiseeStatement(db, x))), emailed: r.emailed };
  });

  const statementGroups = async (req: FastifyRequest, orgId: string) => {
    await requireMember(req, db, orgId);
    return groupsInScope(req, orgId, 'view');
  };

  app.get('/orgs/:orgId/finance/franchisee-statements', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ periodId: z.uuid().optional(), ownerGroupId: z.uuid().optional() }), summary: 'Monthly franchisee statements in scope (franchise owners see only their own)' } }, async (req) => {
    const { orgId } = req.params;
    const groups = await statementGroups(req, orgId);
    const rows = (await db.select().from(franchiseeStatements).where(and(eq(franchiseeStatements.organizationId, orgId), req.query.periodId ? eq(franchiseeStatements.periodId, req.query.periodId) : undefined, req.query.ownerGroupId ? eq(franchiseeStatements.ownerGroupId, req.query.ownerGroupId) : undefined)).orderBy(desc(franchiseeStatements.issuedAt)))
      .filter((r) => groups === 'all' || groups.has(r.ownerGroupId));
    return { items: await Promise.all(rows.map((x) => serializeFranchiseeStatement(db, x))) };
  });

  const loadFranchiseeStatement = async (req: FastifyRequest, orgId: string, id: string) => {
    const groups = await statementGroups(req, orgId);
    const [row] = await db.select().from(franchiseeStatements).where(and(eq(franchiseeStatements.id, id), eq(franchiseeStatements.organizationId, orgId)));
    if (!row || (groups !== 'all' && !groups.has(row.ownerGroupId))) throw notFound('Statement');
    return row;
  };

  app.get('/orgs/:orgId/finance/franchisee-statements/:id', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) =>
    serializeFranchiseeStatement(db, await loadFranchiseeStatement(req, req.params.orgId, req.params.id)));

  app.get('/orgs/:orgId/finance/franchisee-statements/:id/pdf', { schema: { tags: ['finance'], security: secured, params: idParams, summary: 'Monthly statement PDF' } }, async (req, reply) => {
    const row = await loadFranchiseeStatement(req, req.params.orgId, req.params.id);
    return reply.header('Content-Disposition', `inline; filename="${row.number}.pdf"`).type('application/pdf').send(await franchiseeStatementPdf(db, row));
  });

  /* ---------------- Marketing fund ---------------- */

  const fundScope = async (req: FastifyRequest, orgId: string, action: 'view' | 'export' = 'view') => {
    await requireMember(req, db, orgId);
    const locs = await capabilityLocations(req, db, orgId, 'finance.marketing_fund', action);
    if (locs !== 'all' && !locs.size) throw new AppError(403, 'forbidden', 'You don’t have access to the marketing fund');
    return locs;
  };

  app.get('/orgs/:orgId/finance/fund/transparency', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), summary: 'Marketing fund transparency report per currency (contributions as totals, spend by campaign)' } }, async (req) => {
    const { orgId } = req.params;
    const scope = await fundScope(req, orgId);
    const year = req.query.year ?? Number((await todayFor(orgId)).slice(0, 4));
    await consumePendingSpendEvents(db, orgId);
    return { year, currencies: await transparencyReport(db, orgId, year, scope) };
  });

  app.get('/orgs/:orgId/finance/fund/annual-statement', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), summary: 'Annual marketing fund statement (CSV)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const scope = await fundScope(req, orgId);
    const rows = await transparencyReport(db, orgId, req.query.year, scope);
    const out: unknown[][] = [];
    for (const r of rows) {
      out.push([r.year, r.currency, 'opening_balance', '', major(r.openingBalanceMinor, r.currency)]);
      out.push([r.year, r.currency, 'contributions', `${r.contributorCount} contributors`, major(r.contributionsMinor, r.currency)]);
      for (const c of r.spendByCampaign) out.push([r.year, r.currency, 'spend', c.name ?? '', major(-c.amountMinor, r.currency)]);
      if (r.adjustmentsMinor) out.push([r.year, r.currency, 'adjustments', '', major(r.adjustmentsMinor, r.currency)]);
      out.push([r.year, r.currency, 'closing_balance', '', major(r.closingBalanceMinor, r.currency)]);
      if (scope !== 'all') out.push([r.year, r.currency, 'your_contributions', '', major(r.yourContributionsMinor, r.currency)]);
    }
    return reply.header('Content-Disposition', `attachment; filename="marketing_fund_${req.query.year}.csv"`).type('text/csv; charset=utf-8').send(toCsv(['year', 'currency', 'line', 'detail', 'amount'], out));
  });

  app.get('/orgs/:orgId/finance/fund/ledger', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ currency: z.string().length(3).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) } }, async (req) => {
    const { orgId } = req.params;
    const scope = await fundScope(req, orgId);
    const hqView = scope === 'all';
    const conds = [eq(marketingFundEntries.organizationId, orgId)];
    if (req.query.currency) conds.push(eq(marketingFundEntries.currency, req.query.currency.toUpperCase()));
    // Franchisees: network spend and adjustments, plus their own contributions only.
    if (!hqView) conds.push(or(inArray(marketingFundEntries.kind, ['spend', 'adjustment']), inArray(marketingFundEntries.locationId, [...scope]))!);
    const rows = await db.select().from(marketingFundEntries).where(and(...conds)).orderBy(desc(marketingFundEntries.occurredOn), desc(marketingFundEntries.createdAt)).limit(req.query.limit);
    await consumePendingSpendEvents(db, orgId);
    const campaigns = await fundCampaignNames(db, orgId);
    const dir = await directory(db, orgId);
    return { balances: await fundBalances(db, orgId), items: rows.map((e) => serializeEntry(e, { campaigns, locations: dir.locations, groups: dir.groups }, hqView || (!!e.locationId && scope.has(e.locationId)))) };
  });

  // Campaigns are Marketing's funded ad campaigns (network, coming soon, course); they are created in Marketing.
  app.get('/orgs/:orgId/finance/fund/campaigns', { schema: { tags: ['finance'], security: secured, params: orgParams } }, async (req) => {
    await fundScope(req, req.params.orgId);
    const rows = await fundCampaigns(db, req.params.orgId);
    return { items: rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind, status: c.status })) };
  });

  app.post('/orgs/:orgId/finance/fund/spend', {
    bodyLimit: UPLOAD_LIMIT,
    schema: { tags: ['finance'], security: secured, params: orgParams, body: z.object({ currency, amountMinor: minorInt, campaignId: z.uuid(), description: z.string().min(2).max(300), vendor: z.string().max(120).nullable().optional(), occurredOn: ymd, receipt: upload }), summary: 'Record fund spend on a network campaign, with its receipt' },
  }, async (req, reply) => {
    await hq(req, req.params.orgId, 'finance.marketing_fund', 'edit');
    const e = await recordSpend(s, req.params.orgId, { ...req.body, vendor: req.body.vendor ?? null }, req.user!.id);
    return reply.code(201).send({ id: e.id, amountMinor: e.amountMinor, currency: e.currency });
  });

  /* ---------------- Payouts & reconciliation ---------------- */

  const payoutScope = async (req: FastifyRequest, orgId: string, action: 'view' | 'export' = 'view'): Promise<'all' | Set<string>> => {
    await requireMember(req, db, orgId);
    if (await isHq(req, orgId, 'finance.payouts', action)) return 'all';
    // Location teams see their own payouts through Payments.
    const locs = await capabilityLocations(req, db, orgId, 'finance.payments', action);
    if (locs !== 'all' && !locs.size) throw new AppError(403, 'forbidden', 'You don’t have access to payouts');
    return locs;
  };

  app.get('/orgs/:orgId/finance/payouts', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }) } }, async (req) => {
    const { orgId } = req.params;
    const scope = await payoutScope(req, orgId);
    const conds = [eq(financePayouts.organizationId, orgId)];
    if (req.query.locationId) conds.push(eq(financePayouts.locationId, req.query.locationId));
    if (scope !== 'all') conds.push(inArray(financePayouts.locationId, scope.size ? [...scope] : ['00000000-0000-0000-0000-000000000000']));
    const rows = await db.select().from(financePayouts).where(and(...conds)).orderBy(desc(financePayouts.arrivalDate)).limit(req.query.limit);
    const dir = await directory(db, orgId);
    return { mode: collectionAdapter(s).mode, items: rows.map((p) => serializePayout(p, dir.locations.get(p.locationId)?.name)) };
  });

  app.get('/orgs/:orgId/finance/payouts/:id', { schema: { tags: ['finance'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const scope = await payoutScope(req, orgId);
    const [p] = await db.select().from(financePayouts).where(and(eq(financePayouts.id, id), eq(financePayouts.organizationId, orgId)));
    if (!p) throw notFound('Payout');
    assertLocation(scope, p.locationId, 'Payout');
    const txns = await db.select().from(financeBalanceTransactions).where(eq(financeBalanceTransactions.payoutId, p.id)).orderBy(asc(financeBalanceTransactions.createdAt));
    const dir = await directory(db, orgId);
    return { ...serializePayout(p, dir.locations.get(p.locationId)?.name), transactions: txns.map((t) => ({ id: t.id, externalId: t.externalId, type: t.type, sourceId: t.sourceId, paymentId: t.paymentId, currency: t.currency, amountMinor: t.amountMinor, feeMinor: t.feeMinor, netMinor: t.netMinor })) };
  });

  app.post('/orgs/:orgId/finance/payouts/sync', { schema: { tags: ['finance'], security: secured, params: orgParams, summary: 'Sync payouts and balance transactions from Stripe (sandbox: generated from payments)' } }, async (req) => {
    await hq(req, req.params.orgId, 'finance.payouts', 'edit');
    return syncPayouts(s, req.params.orgId, req.user!.id);
  });

  app.get('/orgs/:orgId/finance/reconciliation', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ periodId: z.uuid() }), summary: 'Payments ↔ payouts ↔ royalty statement and invoice, per location, for a period' } }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.payouts', 'view');
    const dir = await directory(db, orgId);
    const rows = await reconciliation(db, orgId, req.query.periodId, 'all', await todayFor(orgId));
    return { items: rows.map((r) => ({ ...r, location: { id: r.locationId, name: dir.locations.get(r.locationId)?.name ?? null } })) };
  });

  /* ---------------- Exports & reports ---------------- */

  app.get('/orgs/:orgId/finance/exports/:dataset', {
    schema: {
      tags: ['finance'], security: secured, params: z.object({ orgId: z.uuid(), dataset: z.enum(['statements', 'invoices', 'payouts', 'fund']) }),
      querystring: z.object({ format: z.enum(['csv', 'xero', 'quickbooks']).default('csv'), from: ymd.optional(), to: ymd.optional(), currency: z.string().length(3).optional() }),
      summary: 'CSV export for accounting: BranchHarbor columns, Xero or QuickBooks import layouts',
    },
  }, async (req, reply) => {
    const { orgId, dataset } = req.params;
    const allowed = dataset === 'payouts' ? await payoutScope(req, orgId, 'export') : dataset === 'fund' ? await fundScope(req, orgId, 'export') : await statementScope(req, orgId, 'export');
    if (allowed !== 'all' && !allowed.size) throw new AppError(403, 'forbidden', 'You don’t have export access');
    if (req.query.format !== 'csv' && dataset !== 'invoices' && dataset !== 'payouts') throw validationError('Xero and QuickBooks layouts exist for invoices and payouts', { format: 'Use csv' });
    const r = await buildExport(db, orgId, dataset, req.query.format, { from: req.query.from, to: req.query.to, currency: req.query.currency?.toUpperCase(), allowed }, await directory(db, orgId));
    await audit(db, { organizationId: orgId, ...actor(req), action: 'finance.export', scopeKind: 'organization', scopeId: orgId, metadata: { dataset, format: req.query.format } });
    return reply.header('Content-Disposition', `attachment; filename="${r.filename}"`).type('text/csv; charset=utf-8').send(r.csv);
  });

  app.get('/orgs/:orgId/finance/reports', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'Royalty revenue by location and region, collection rate, arrears ageing and fund balance — per currency' } }, async (req) => {
    const { orgId } = req.params;
    await hq(req, orgId, 'finance.royalties', 'view');
    const day = await todayFor(orgId);
    const from = req.query.from ?? `${day.slice(0, 4)}-01-01`;
    const to = req.query.to ?? `${Number(day.slice(0, 4)) + 1}-01-01`;
    return financeReports(db, orgId, { from, to }, await directory(db, orgId), day);
  });

  // Validation helper for clients: is a date a valid period start?
  app.get('/orgs/:orgId/finance/periods/check', { schema: { tags: ['finance'], security: secured, params: orgParams, querystring: z.object({ startDate: ymd }) } }, async (req) => {
    await requireMember(req, db, req.params.orgId);
    const st = await getFinanceSettings(db, req.params.orgId);
    const valid = isPeriodStart(st.periodFrequency as PeriodFrequency, req.query.startDate, st.weekStartsOn);
    if (!valid) throw conflict('not_period_start', 'Not the start of a period');
    return { valid, ...periodContaining(st.periodFrequency as PeriodFrequency, req.query.startDate, st.weekStartsOn) };
  });
};
