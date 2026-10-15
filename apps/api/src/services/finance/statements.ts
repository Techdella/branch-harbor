/**
 * Period close and royalty statements: gross sales from BranchHarbor payments (succeeded in the location's local
 * period), refunds completed in the period, tax and tips from the paid records, accepted external sales reports;
 * then the royalty engine (domain/royalty.ts) with the resolved terms. One statement per location and period, in the
 * location's currency.
 */
import { and, asc, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import {
  externalSalesReports, financeDocuments, financeInvoices, foodOrders, locations, orders, ownerGroups, paymentReferences, refunds, regions, royaltyDisputes, royaltyPeriods,
  royaltyStatementLines, royaltyStatements,
} from '../../db/schema/index.ts';
import type { RevenueStream } from '../../db/schema/finance.ts';
import {
  NON_SALES_TARGETS, computeStatement, isPeriodStart, periodBoundsUtc, periodContaining, streamOf, type PeriodFrequency, type SalesAggregate, type StreamTotals,
} from '../../domain/royalty.ts';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.ts';
import { audit } from '../audit.ts';
import { getFinanceSettings, resolveTerms } from './terms.ts';

type LocationRow = typeof locations.$inferSelect;
type StatementRow = typeof royaltyStatements.$inferSelect;

const emptyTotals = (): StreamTotals => ({ grossMinor: 0, refundsMinor: 0, taxMinor: 0, tipsMinor: 0 });
const prorate = (part: number, amount: number, total: number) => (total > 0 ? Math.round((part * amount) / total) : 0);

/**
 * Sales of one location between two instants, grouped by revenue stream, in the location's currency only.
 * Payments in another currency are counted separately and reported as a warning (never converted or added).
 */
export async function salesAggregate(db: Exec, loc: Pick<LocationRow, 'id' | 'currency'>, startAt: Date, endAt: Date) {
  const pays = await db.select().from(paymentReferences).where(and(
    eq(paymentReferences.locationId, loc.id), eq(paymentReferences.state, 'succeeded'), gte(paymentReferences.succeededAt, startAt), lt(paymentReferences.succeededAt, endAt),
  ));
  const sales = pays.filter((p) => !NON_SALES_TARGETS.has(p.targetType ?? ''));
  const foreign = sales.filter((p) => p.currency !== loc.currency);
  const own = sales.filter((p) => p.currency === loc.currency);

  const refundRows = await db.select({ r: refunds, p: paymentReferences }).from(refunds).innerJoin(paymentReferences, eq(paymentReferences.id, refunds.paymentId)).where(and(
    eq(paymentReferences.locationId, loc.id), eq(refunds.state, 'complete'), gte(refunds.updatedAt, startAt), lt(refunds.updatedAt, endAt),
  ));
  const ownRefunds = refundRows.filter((x) => x.r.currency === loc.currency && !NON_SALES_TARGETS.has(x.p.targetType ?? ''));

  // Tax and tips come from the paid record (commerce orders, food orders), prorated when a payment covers part of it.
  const ids = (type: string) => [...new Set([...own.map((p) => p), ...ownRefunds.map((x) => x.p)].filter((p) => p.targetType === type && p.targetId).map((p) => p.targetId!))];
  const orderIds = ids('order');
  const foodIds = ids('food_order');
  const orderMap = new Map((orderIds.length ? await db.select({ id: orders.id, tax: orders.taxMinor, total: orders.totalMinor }).from(orders).where(inArray(orders.id, orderIds)) : []).map((o) => [o.id, { tax: o.tax, tips: 0, total: o.total }]));
  const foodMap = new Map((foodIds.length ? await db.select({ id: foodOrders.id, tax: foodOrders.taxMinor, tips: foodOrders.tipMinor, total: foodOrders.totalMinor }).from(foodOrders).where(inArray(foodOrders.id, foodIds)) : []).map((o) => [o.id, o]));
  const recordOf = (p: typeof paymentReferences.$inferSelect) => (p.targetId ? (p.targetType === 'order' ? orderMap.get(p.targetId) : p.targetType === 'food_order' ? foodMap.get(p.targetId) : undefined) : undefined);

  const streams: Partial<Record<RevenueStream, StreamTotals>> = {};
  for (const p of own) {
    const st = streamOf(p.targetType)!;
    const s = (streams[st] ??= emptyTotals());
    const amount = p.providerAmountMinor ?? p.amountMinor;
    s.grossMinor += amount;
    const rec = recordOf(p);
    if (rec) {
      s.taxMinor += prorate(rec.tax, amount, rec.total);
      s.tipsMinor += prorate(rec.tips, amount, rec.total);
    }
  }
  for (const { r, p } of ownRefunds) {
    const st = streamOf(p.targetType)!;
    const s = (streams[st] ??= emptyTotals());
    s.refundsMinor += r.amountMinor;
    const rec = recordOf(p);
    // Tax refunded with the sale is no longer owed tax: take it off the excluded tax so the basis is not reduced twice.
    if (rec) s.taxMinor -= prorate(rec.tax, r.amountMinor, rec.total);
  }
  const foreignByCurrency: Record<string, number> = {};
  for (const p of foreign) foreignByCurrency[p.currency] = (foreignByCurrency[p.currency] ?? 0) + p.amountMinor;
  return { currency: loc.currency, streams, paymentCount: own.length, foreignByCurrency };
}

/** Recomputes a draft or disputed statement's computed lines, keeping manual adjustments. */
async function computeInto(db: Exec, stmt: StatementRow, loc: LocationRow, frequency: PeriodFrequency, startDate: string) {
  const terms = await resolveTerms(db, { organizationId: stmt.organizationId, ownerGroupId: loc.ownerGroupId, locationId: loc.id, currency: loc.currency, onDate: startDate });
  const agg = await salesAggregate(db, loc, stmt.periodStartAt, stmt.periodEndAt);
  const [ext] = await db.select().from(externalSalesReports).where(and(eq(externalSalesReports.locationId, loc.id), eq(externalSalesReports.frequency, frequency), eq(externalSalesReports.periodStart, startDate)));
  const sales: SalesAggregate = { currency: loc.currency, streams: agg.streams, external: ext?.status === 'accepted' && ext.currency === loc.currency ? { grossMinor: ext.grossMinor, refundsMinor: ext.refundsMinor, taxMinor: ext.taxMinor } : null };
  const manual = await db.select().from(royaltyStatementLines).where(and(eq(royaltyStatementLines.statementId, stmt.id), eq(royaltyStatementLines.manual, true)));
  const warnings: string[] = [];
  if (ext?.status === 'submitted') warnings.push('external_sales_pending_review');
  for (const [cur, amt] of Object.entries(agg.foreignByCurrency)) warnings.push(`foreign_currency_payments:${cur}:${amt}`);
  if (!terms) warnings.push('no_terms');
  const computed = terms ? computeStatement(terms, sales, manual.map((m) => m.amountMinor)) : null;
  await db.delete(royaltyStatementLines).where(and(eq(royaltyStatementLines.statementId, stmt.id), eq(royaltyStatementLines.manual, false)));
  if (computed) {
    await db.insert(royaltyStatementLines).values(computed.lines.map((l, i) => ({
      organizationId: stmt.organizationId, statementId: stmt.id, kind: l.kind, stream: l.stream ?? null, description: l.description,
      basisMinor: l.basisMinor ?? null, rateBps: l.rateBps ?? null, amountMinor: l.amountMinor, charge: l.charge, manual: false, sortOrder: i,
    })));
  }
  const c = computed;
  const adj = manual.reduce((a, m) => a + m.amountMinor, 0);
  const [row] = await db.update(royaltyStatements).set({
    grossSalesMinor: c?.grossSalesMinor ?? 0, refundsMinor: c?.refundsMinor ?? 0, taxMinor: c?.taxMinor ?? 0, tipsMinor: c?.tipsMinor ?? 0, externalSalesMinor: c?.externalSalesMinor ?? 0,
    basisMinor: c?.basisMinor ?? 0, royaltyMinor: c?.royaltyMinor ?? 0, marketingFundMinor: c?.marketingFundMinor ?? 0, technologyFeeMinor: c?.technologyFeeMinor ?? 0,
    adjustmentsMinor: adj, totalMinor: c ? c.totalMinor : adj,
    terms: (terms ?? {}) as unknown as Record<string, unknown>, termsSource: terms?.source ?? null, warnings: [...warnings, ...(c?.warnings ?? [])],
    computedAt: new Date(), updatedAt: new Date(),
  }).where(eq(royaltyStatements.id, stmt.id)).returning();
  return row!;
}

/** Statuses that trade (or traded during the period): drafts and locations still opening never pay royalties. */
const ROYALTY_STATUSES = new Set(['operating', 'paused', 'closed']);

/** Locations that pay royalties: franchised (an owner group) and trading. Company-owned locations never do. */
export async function franchisedLocations(db: Exec, organizationId: string) {
  const rows = await db.select().from(locations).where(and(eq(locations.organizationId, organizationId), ne(locations.status, 'draft')));
  return rows.filter((l) => !!l.ownerGroupId && !l.archivedAt && ROYALTY_STATUSES.has(l.status));
}

/**
 * Closes a period: creates (or refreshes) a statement for every franchised location. The period must have ended in
 * every location's own time zone. Statements already approved or invoiced are left as they are.
 */
export async function closePeriod(s: Services, organizationId: string, startDate: string, actorUserId: string, now = new Date()) {
  const settings = await getFinanceSettings(s.db, organizationId);
  const frequency = settings.periodFrequency as PeriodFrequency;
  if (!isPeriodStart(frequency, startDate, settings.weekStartsOn)) {
    throw validationError(`${startDate} is not the start of a ${frequency} period`, { startDate: frequency === 'monthly' ? 'Use the first day of a month' : 'Use the first day of a week' });
  }
  const { endDate } = periodContaining(frequency, startDate, settings.weekStartsOn);
  const locs = await franchisedLocations(s.db, organizationId);
  const notEnded = locs.filter((l) => periodBoundsUtc(startDate, endDate, l.timeZone).endAt > now);
  if (notEnded.length) throw conflict('period_not_ended', 'This period has not ended yet in every location’s time zone', { locations: notEnded.map((l) => l.id) });

  return s.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(royaltyPeriods).where(and(eq(royaltyPeriods.organizationId, organizationId), eq(royaltyPeriods.frequency, frequency), eq(royaltyPeriods.startDate, startDate)));
    const [period] = existing
      ? await tx.update(royaltyPeriods).set({ status: 'closed', closedAt: new Date(), closedBy: actorUserId }).where(eq(royaltyPeriods.id, existing.id)).returning()
      : await tx.insert(royaltyPeriods).values({ organizationId, frequency, startDate, endDate, status: 'closed', closedAt: new Date(), closedBy: actorUserId }).returning();
    const created: string[] = [];
    const kept: string[] = [];
    const missingTerms: string[] = [];
    for (const loc of locs) {
      const { startAt, endAt } = periodBoundsUtc(startDate, endDate, loc.timeZone);
      let [stmt] = await tx.select().from(royaltyStatements).where(and(eq(royaltyStatements.periodId, period!.id), eq(royaltyStatements.locationId, loc.id)));
      if (stmt && !['draft', 'disputed'].includes(stmt.status)) { kept.push(stmt.id); continue; }
      if (!stmt) {
        [stmt] = await tx.insert(royaltyStatements).values({
          organizationId, periodId: period!.id, locationId: loc.id, ownerGroupId: loc.ownerGroupId, currency: loc.currency, timeZone: loc.timeZone, periodStartAt: startAt, periodEndAt: endAt,
        }).returning();
      }
      const row = await computeInto(tx, stmt!, loc, frequency, startDate);
      if (row.warnings.includes('no_terms')) missingTerms.push(loc.id);
      created.push(row.id);
    }
    await audit(tx, { organizationId, actorUserId, action: 'finance.period_closed', scopeKind: 'organization', scopeId: organizationId, targetType: 'royalty_period', targetId: period!.id, metadata: { startDate, endDate, frequency, statements: created.length, kept: kept.length, missingTerms } });
    return { period: period!, statementIds: [...created, ...kept], missingTerms };
  });
}

export async function loadStatement(db: Exec, organizationId: string, id: string) {
  const [st] = await db.select().from(royaltyStatements).where(and(eq(royaltyStatements.id, id), eq(royaltyStatements.organizationId, organizationId)));
  if (!st) throw notFound('Statement');
  return st;
}

/** Recalculates a draft or disputed statement (e.g. after late payment events or an accepted sales report). */
export async function recalculateStatement(s: Services, organizationId: string, id: string, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const st = await loadStatement(tx, organizationId, id);
    if (!['draft', 'disputed'].includes(st.status)) throw conflict('statement_locked', `A ${st.status} statement cannot be recalculated`);
    const [period] = await tx.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, st.periodId));
    const [loc] = await tx.select().from(locations).where(eq(locations.id, st.locationId));
    const row = await computeInto(tx, st, loc!, period!.frequency as PeriodFrequency, period!.startDate);
    await audit(tx, { organizationId, actorUserId, action: 'finance.statement_recalculated', scopeKind: 'location', scopeId: st.locationId, targetType: 'royalty_statement', targetId: st.id, metadata: { totalMinor: row.totalMinor, currency: row.currency } });
    return row;
  });
}

/** HQ adjustment (credit or charge) on a draft/disputed statement. */
export async function addAdjustment(s: Services, organizationId: string, id: string, input: { amountMinor: number; description: string; disputeId?: string | null }, actorUserId: string, exec?: Exec) {
  const run = async (tx: Exec) => {
    const st = await loadStatement(tx, organizationId, id);
    if (!['draft', 'disputed'].includes(st.status)) throw conflict('statement_locked', `A ${st.status} statement cannot be adjusted`);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) throw validationError('Adjustment must be a non-zero integer in minor units', { amountMinor: 'Non-zero integer' });
    await tx.insert(royaltyStatementLines).values({
      organizationId, statementId: st.id, kind: 'adjustment', description: input.description, amountMinor: input.amountMinor, charge: true, manual: true, disputeId: input.disputeId ?? null, createdBy: actorUserId, sortOrder: 1000,
    });
    const [row] = await tx.update(royaltyStatements).set({ adjustmentsMinor: st.adjustmentsMinor + input.amountMinor, totalMinor: st.totalMinor + input.amountMinor, updatedAt: new Date() }).where(eq(royaltyStatements.id, st.id)).returning();
    await audit(tx, { organizationId, actorUserId, action: 'finance.statement_adjusted', scopeKind: 'location', scopeId: st.locationId, targetType: 'royalty_statement', targetId: st.id, metadata: { amountMinor: input.amountMinor, currency: st.currency, description: input.description } });
    return row!;
  };
  return exec ? run(exec) : s.db.transaction(run);
}

export async function approveStatement(s: Services, organizationId: string, id: string, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const st = await loadStatement(tx, organizationId, id);
    if (st.status === 'disputed') throw conflict('statement_disputed', 'Resolve the open dispute before approving');
    if (st.status !== 'draft') throw conflict('statement_not_draft', `Only draft statements can be approved (this one is ${st.status})`);
    if (st.warnings.includes('no_terms')) throw conflict('statement_no_terms', 'No royalty terms apply to this location; add terms and recalculate');
    const [row] = await tx.update(royaltyStatements).set({ status: 'approved', approvedAt: new Date(), approvedBy: actorUserId, updatedAt: new Date() }).where(eq(royaltyStatements.id, st.id)).returning();
    await audit(tx, { organizationId, actorUserId, action: 'finance.statement_approved', scopeKind: 'location', scopeId: st.locationId, targetType: 'royalty_statement', targetId: st.id, metadata: { totalMinor: st.totalMinor, currency: st.currency } });
    return row!;
  });
}

/** The franchisee disputes a statement (or one of its lines) before it is invoiced. */
export async function raiseDispute(s: Services, organizationId: string, id: string, input: { reason: string; lineId?: string | null }, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const st = await loadStatement(tx, organizationId, id);
    if (!['draft', 'approved', 'disputed'].includes(st.status)) throw conflict('statement_not_disputable', `A ${st.status} statement can no longer be disputed; contact HQ finance`);
    if (input.lineId) {
      const [line] = await tx.select().from(royaltyStatementLines).where(and(eq(royaltyStatementLines.id, input.lineId), eq(royaltyStatementLines.statementId, st.id)));
      if (!line) throw notFound('Statement line');
    }
    const [d] = await tx.insert(royaltyDisputes).values({ organizationId, statementId: st.id, lineId: input.lineId ?? null, raisedBy: actorUserId, reason: input.reason }).returning();
    await tx.update(royaltyStatements).set({ status: 'disputed', approvedAt: null, approvedBy: null, updatedAt: new Date() }).where(eq(royaltyStatements.id, st.id));
    await audit(tx, { organizationId, actorUserId, action: 'finance.dispute_raised', scopeKind: 'location', scopeId: st.locationId, targetType: 'royalty_statement', targetId: st.id, metadata: { disputeId: d!.id } });
    return d!;
  });
}

/** HQ resolves a dispute: accept (optionally with an adjustment) or reject. The statement returns to draft when no dispute is open. */
export async function resolveDispute(s: Services, organizationId: string, disputeId: string, input: { decision: 'accepted' | 'rejected'; resolution: string; adjustmentMinor?: number | null }, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const [d] = await tx.select().from(royaltyDisputes).where(and(eq(royaltyDisputes.id, disputeId), eq(royaltyDisputes.organizationId, organizationId))).for('update');
    if (!d) throw notFound('Dispute');
    if (d.status !== 'open') throw conflict('dispute_closed', 'This dispute is already resolved');
    if (input.decision === 'accepted' && input.adjustmentMinor) await addAdjustment(s, organizationId, d.statementId, { amountMinor: input.adjustmentMinor, description: `dispute:${input.resolution}`, disputeId: d.id }, actorUserId, tx);
    const [row] = await tx.update(royaltyDisputes).set({ status: input.decision, resolution: input.resolution, adjustmentMinor: input.decision === 'accepted' ? input.adjustmentMinor ?? null : null, resolvedBy: actorUserId, resolvedAt: new Date() }).where(eq(royaltyDisputes.id, d.id)).returning();
    const open = await tx.select({ id: royaltyDisputes.id }).from(royaltyDisputes).where(and(eq(royaltyDisputes.statementId, d.statementId), eq(royaltyDisputes.status, 'open')));
    const st = await loadStatement(tx, organizationId, d.statementId);
    if (!open.length && st.status === 'disputed') await tx.update(royaltyStatements).set({ status: 'draft', updatedAt: new Date() }).where(eq(royaltyStatements.id, st.id));
    await audit(tx, { organizationId, actorUserId, action: 'finance.dispute_resolved', scopeKind: 'location', scopeId: st.locationId, targetType: 'royalty_statement', targetId: st.id, metadata: { disputeId: d.id, decision: input.decision, adjustmentMinor: input.adjustmentMinor ?? null } });
    return row!;
  });
}

/* ------------------------------------------------------------------ */
/* Documents and external sales                                        */
/* ------------------------------------------------------------------ */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|heic)|text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/;

export async function saveDocument(db: Exec, input: { organizationId: string; kind: 'evidence' | 'receipt'; locationId: string | null; filename: string; contentType: string; dataBase64: string; uploadedBy: string }) {
  if (!ALLOWED_TYPES.test(input.contentType)) throw validationError('Upload a PDF, image, CSV or spreadsheet', { contentType: 'Unsupported file type' });
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (!buf.length) throw validationError('The file is empty', { dataBase64: 'Empty file' });
  if (buf.length > MAX_DOCUMENT_BYTES) throw new AppError(413, 'file_too_large', 'Files can be up to 5 MB');
  const [doc] = await db.insert(financeDocuments).values({
    organizationId: input.organizationId, kind: input.kind, locationId: input.locationId, filename: input.filename.slice(0, 200), contentType: input.contentType,
    sizeBytes: buf.length, dataBase64: buf.toString('base64'), sha256: createHash('sha256').update(buf).digest('hex'), uploadedBy: input.uploadedBy,
  }).returning({ id: financeDocuments.id, filename: financeDocuments.filename, contentType: financeDocuments.contentType, sizeBytes: financeDocuments.sizeBytes });
  return doc!;
}

export async function submitExternalSales(s: Services, organizationId: string, input: { locationId: string; periodStart: string; grossMinor: number; refundsMinor: number; taxMinor: number; note?: string | null; evidence: { filename: string; contentType: string; dataBase64: string } }, actorUserId: string) {
  const settings = await getFinanceSettings(s.db, organizationId);
  const frequency = settings.periodFrequency as PeriodFrequency;
  if (!isPeriodStart(frequency, input.periodStart, settings.weekStartsOn)) throw validationError(`${input.periodStart} is not the start of a ${frequency} period`, { periodStart: 'Not a period start' });
  const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  if ([input.grossMinor, input.refundsMinor, input.taxMinor].some((x) => !Number.isInteger(x) || x < 0)) throw validationError('Amounts must be non-negative integers in minor units');
  return s.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(externalSalesReports).where(and(eq(externalSalesReports.locationId, loc.id), eq(externalSalesReports.frequency, frequency), eq(externalSalesReports.periodStart, input.periodStart)));
    if (existing?.status === 'accepted') throw conflict('report_accepted', 'This period’s sales report is already accepted; ask HQ finance to reopen it');
    const doc = await saveDocument(tx, { organizationId, kind: 'evidence', locationId: loc.id, ...input.evidence, uploadedBy: actorUserId });
    const values = { grossMinor: input.grossMinor, refundsMinor: input.refundsMinor, taxMinor: input.taxMinor, note: input.note ?? null, evidenceDocumentId: doc.id, status: 'submitted', submittedBy: actorUserId, reviewedBy: null, reviewedAt: null, reviewNote: null, updatedAt: new Date() };
    const [row] = existing
      ? await tx.update(externalSalesReports).set(values).where(eq(externalSalesReports.id, existing.id)).returning()
      : await tx.insert(externalSalesReports).values({ organizationId, locationId: loc.id, frequency, periodStart: input.periodStart, currency: loc.currency, ...values }).returning();
    await audit(tx, { organizationId, actorUserId, action: 'finance.external_sales_submitted', scopeKind: 'location', scopeId: loc.id, targetType: 'external_sales_report', targetId: row!.id, metadata: { periodStart: input.periodStart, grossMinor: input.grossMinor, currency: loc.currency } });
    return row!;
  });
}

export async function reviewExternalSales(s: Services, organizationId: string, id: string, input: { decision: 'accepted' | 'rejected'; note?: string | null }, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const [r] = await tx.select().from(externalSalesReports).where(and(eq(externalSalesReports.id, id), eq(externalSalesReports.organizationId, organizationId)));
    if (!r) throw notFound('Sales report');
    if (r.status !== 'submitted') throw conflict('report_reviewed', 'This report was already reviewed');
    const [row] = await tx.update(externalSalesReports).set({ status: input.decision, reviewNote: input.note ?? null, reviewedBy: actorUserId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(externalSalesReports.id, r.id)).returning();
    await audit(tx, { organizationId, actorUserId, action: `finance.external_sales_${input.decision}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'external_sales_report', targetId: r.id });
    return row!;
  });
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export async function directory(db: Exec, organizationId: string) {
  const locs = await db.select({ id: locations.id, name: locations.name, code: locations.code, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, currency: locations.currency, country: locations.country, timeZone: locations.timeZone, stripeAccountId: locations.stripeAccountId })
    .from(locations).where(eq(locations.organizationId, organizationId));
  const groups = await db.select({ id: ownerGroups.id, name: ownerGroups.name, legalName: ownerGroups.legalName }).from(ownerGroups).where(eq(ownerGroups.organizationId, organizationId));
  const regs = await db.select({ id: regions.id, name: regions.name }).from(regions).where(eq(regions.organizationId, organizationId));
  return { locations: new Map(locs.map((l) => [l.id, l])), groups: new Map(groups.map((g) => [g.id, g])), regions: new Map(regs.map((r) => [r.id, r])) };
}
export type Directory = Awaited<ReturnType<typeof directory>>;

export function serializeStatement(st: StatementRow, dir: Directory, period?: { startDate: string; endDate: string; frequency: string } | null, invoice?: { id: string; number: string; status: string; dueDate: string; totalMinor: number; paidMinor: number } | null) {
  const loc = dir.locations.get(st.locationId);
  return {
    id: st.id, periodId: st.periodId, period: period ? { startDate: period.startDate, endDate: period.endDate, frequency: period.frequency } : null,
    location: { id: st.locationId, name: loc?.name ?? null, code: loc?.code ?? null }, ownerGroup: st.ownerGroupId ? { id: st.ownerGroupId, name: dir.groups.get(st.ownerGroupId)?.name ?? null } : null,
    currency: st.currency, timeZone: st.timeZone, periodStartAt: st.periodStartAt.toISOString(), periodEndAt: st.periodEndAt.toISOString(), status: st.status,
    grossSalesMinor: st.grossSalesMinor, refundsMinor: st.refundsMinor, taxMinor: st.taxMinor, tipsMinor: st.tipsMinor, externalSalesMinor: st.externalSalesMinor, basisMinor: st.basisMinor,
    royaltyMinor: st.royaltyMinor, marketingFundMinor: st.marketingFundMinor, technologyFeeMinor: st.technologyFeeMinor, adjustmentsMinor: st.adjustmentsMinor, totalMinor: st.totalMinor,
    termsSource: st.termsSource, warnings: st.warnings, computedAt: st.computedAt.toISOString(), approvedAt: st.approvedAt?.toISOString() ?? null,
    invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, dueDate: invoice.dueDate, totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor } : null,
  };
}

export async function statementDetail(db: Exec, st: StatementRow, dir: Directory) {
  const [period] = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, st.periodId));
  const lines = await db.select().from(royaltyStatementLines).where(eq(royaltyStatementLines.statementId, st.id)).orderBy(asc(royaltyStatementLines.sortOrder), asc(royaltyStatementLines.createdAt));
  const disputes = await db.select().from(royaltyDisputes).where(eq(royaltyDisputes.statementId, st.id)).orderBy(asc(royaltyDisputes.createdAt));
  const [inv] = st.invoiceId ? await db.select().from(financeInvoices).where(eq(financeInvoices.id, st.invoiceId)) : [];
  return {
    ...serializeStatement(st, dir, period, inv ?? null),
    terms: st.terms,
    lines: lines.map((l) => ({ id: l.id, kind: l.kind, stream: l.stream, description: l.description, basisMinor: l.basisMinor, rateBps: l.rateBps, amountMinor: l.amountMinor, charge: l.charge, manual: l.manual, disputeId: l.disputeId })),
    disputes: disputes.map((d) => ({ id: d.id, lineId: d.lineId, reason: d.reason, status: d.status, resolution: d.resolution, adjustmentMinor: d.adjustmentMinor, raisedBy: d.raisedBy, createdAt: d.createdAt.toISOString(), resolvedAt: d.resolvedAt?.toISOString() ?? null })),
  };
}
