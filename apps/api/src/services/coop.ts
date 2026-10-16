/**
 * Co-op / local marketing fund (BrandMuscle-style; research §3 and §7 #6):
 *
 *  allowance (HQ: % of the location's marketing fund contributions in the period, or a fixed amount; matching ratio)
 *  → pre-approval request (owner: kind, budget, dates, creative) → HQ decision with the brand compliance checklist
 *  → claim after the spend (invoice, proof of performance, results) → HQ approves (reimbursable = eligible spend ×
 *  match, capped at the allowance left) → reimbursement recorded as spend in the Finance marketing fund ledger, paid
 *  by bank transfer (reference recorded) or marked paid by hand.
 *
 * Money stays per currency (the location's). Reimbursements are not moved through Stripe Connect: fund money sits on
 * the franchisor's collection account (integrations/finance-collection.ts), and platform transfers between connected
 * accounts would route franchisor money through BranchHarbor — so HQ pays from its own bank and records it here.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { coopAllowance, coopPeriodBounds, coopReimbursable, type CoopPeriod } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { coopAllowances, coopClaims, coopRequests, locations, marketingFundEntries, users, type CoopChecklistItem, type CoopCreative } from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { usersWithCapabilityAt } from './comms-scope.ts';
import { fundBalances } from './finance/fund.ts';
import { saveDocument } from './finance/statements.ts';
import { getLocalMarketingSettings } from './local-marketing.ts';
import { notify } from './notifications.ts';

export const COOP = 'marketing.coop';
type LocationRow = typeof locations.$inferSelect;
type RequestRow = typeof coopRequests.$inferSelect;
type ClaimRow = typeof coopClaims.$inferSelect;
type AllowanceRow = typeof coopAllowances.$inferSelect;
export interface Upload { filename: string; contentType: string; dataBase64: string }

const today = () => new Date().toISOString().slice(0, 10);

/** The location's own rule, else the organisation default, else none (no co-op programme). */
export async function allowanceRule(db: Exec, orgId: string, locationId: string): Promise<AllowanceRow | null> {
  const rows = await db.select().from(coopAllowances).where(and(eq(coopAllowances.organizationId, orgId), or(isNull(coopAllowances.locationId), eq(coopAllowances.locationId, locationId))));
  const rule = rows.find((r) => r.locationId === locationId) ?? rows.find((r) => !r.locationId) ?? null;
  return rule && rule.active ? rule : null;
}

/** Expected reimbursement of an approved, not yet claimed request (approved budget × match). */
const committedOf = (r: RequestRow, matchBps: number) => Math.floor(((r.approvedMinor ?? 0) * matchBps) / 10_000);

/**
 * Burn-down for one location and period: allowance, committed (approved requests not claimed yet), claimed
 * (approved or paid claims), paid, remaining. Fund contributions are the location's ledger contributions in the
 * period, in the location's currency.
 */
export async function periodSummary(db: Exec, orgId: string, l: LocationRow, date = today(), opts: { excludeRequestId?: string } = {}) {
  const rule = await allowanceRule(db, orgId, l.id);
  const period = (rule?.period ?? 'quarter') as CoopPeriod;
  const b = coopPeriodBounds(period, date);
  const [contrib] = await db.select({ total: sql<number>`coalesce(sum(${marketingFundEntries.amountMinor}), 0)::bigint` }).from(marketingFundEntries)
    .where(and(eq(marketingFundEntries.organizationId, orgId), eq(marketingFundEntries.locationId, l.id), eq(marketingFundEntries.kind, 'contribution'), eq(marketingFundEntries.currency, l.currency), gte(marketingFundEntries.occurredOn, b.start), lt(marketingFundEntries.occurredOn, b.end)));
  const contributionsMinor = Number(contrib?.total ?? 0);
  const allowanceMinor = rule ? coopAllowance({ basis: rule.basis as 'fund_percent' | 'fixed', percentBps: rule.percentBps, fixedMinor: rule.fixedMinor }, contributionsMinor) : 0;
  const reqs = await db.select().from(coopRequests).where(and(eq(coopRequests.locationId, l.id), eq(coopRequests.periodKey, b.key)));
  const claims = reqs.length ? await db.select().from(coopClaims).where(and(inArray(coopClaims.requestId, reqs.map((r) => r.id)), ne(coopClaims.status, 'rejected'))) : [];
  const match = rule?.matchRatioBps ?? 0;
  const counted = reqs.filter((r) => r.id !== opts.excludeRequestId);
  const committedMinor = counted.filter((r) => r.status === 'approved').reduce((a, r) => a + committedOf(r, match), 0);
  // A submitted claim still holds its request's commitment until HQ decides it.
  const pendingClaimMinor = counted.filter((r) => r.status === 'claimed' && claims.find((c) => c.requestId === r.id)?.status === 'submitted').reduce((a, r) => a + committedOf(r, match), 0);
  const decided = claims.filter((c) => c.requestId !== opts.excludeRequestId && (c.status === 'approved' || c.status === 'paid'));
  const claimedMinor = decided.reduce((a, c) => a + (c.reimbursableMinor ?? 0), 0);
  const paidMinor = claims.filter((c) => c.status === 'paid').reduce((a, c) => a + (c.reimbursableMinor ?? 0), 0);
  return {
    locationId: l.id, currency: l.currency, period, periodKey: b.key, periodStart: b.start, periodEnd: b.end, hasProgramme: !!rule,
    basis: rule?.basis ?? null, percentBps: rule?.percentBps ?? 0, fixedMinor: rule?.fixedMinor ?? 0, matchRatioBps: match,
    contributionsMinor, allowanceMinor, committedMinor: committedMinor + pendingClaimMinor, claimedMinor, paidMinor,
    remainingMinor: allowanceMinor - committedMinor - pendingClaimMinor - claimedMinor,
    requests: { submitted: reqs.filter((r) => r.status === 'submitted').length, approved: reqs.filter((r) => r.status === 'approved').length, claimed: reqs.filter((r) => r.status === 'claimed').length },
  };
}

/** Network and per-location burn-down for the period containing `date`, plus monthly reimbursements for the chart. */
export async function burnDown(db: Exec, orgId: string, locationIds: string[] | 'all', date = today()) {
  const conds = [eq(locations.organizationId, orgId), isNull(locations.archivedAt)];
  if (locationIds !== 'all') conds.push(locationIds.length ? inArray(locations.id, locationIds) : sql`false`);
  const locs = await db.select().from(locations).where(and(...conds)).orderBy(asc(locations.name));
  const rows = [];
  for (const l of locs) rows.push({ ...(await periodSummary(db, orgId, l, date)), name: l.name });
  const byCur = new Map<string, { currency: string; allowanceMinor: number; committedMinor: number; claimedMinor: number; paidMinor: number; remainingMinor: number; locations: number }>();
  for (const r of rows.filter((x) => x.hasProgramme)) {
    const t = byCur.get(r.currency) ?? { currency: r.currency, allowanceMinor: 0, committedMinor: 0, claimedMinor: 0, paidMinor: 0, remainingMinor: 0, locations: 0 };
    t.allowanceMinor += r.allowanceMinor; t.committedMinor += r.committedMinor; t.claimedMinor += r.claimedMinor; t.paidMinor += r.paidMinor; t.remainingMinor += r.remainingMinor; t.locations++;
    byCur.set(r.currency, t);
  }
  const ids = locs.map((l) => l.id);
  const year = date.slice(0, 4);
  const paid = ids.length ? await db.select({ month: sql<string>`to_char(${coopClaims.paidAt}, 'YYYY-MM')`, currency: coopClaims.currency, total: sql<number>`sum(${coopClaims.reimbursableMinor})::bigint` }).from(coopClaims)
    .where(and(eq(coopClaims.organizationId, orgId), inArray(coopClaims.locationId, ids), eq(coopClaims.status, 'paid'), gte(coopClaims.paidAt, new Date(`${year}-01-01T00:00:00Z`))))
    .groupBy(sql`to_char(${coopClaims.paidAt}, 'YYYY-MM')`, coopClaims.currency) : [];
  return { periodKey: rows[0]?.periodKey ?? coopPeriodBounds('quarter', date).key, items: rows, totals: [...byCur.values()].sort((a, b) => a.currency.localeCompare(b.currency)), paidByMonth: paid.map((p) => ({ month: p.month, currency: p.currency, amountMinor: Number(p.total) })).sort((a, b) => a.month.localeCompare(b.month)) };
}

/* ── requests ── */

export async function createRequest(s: Services, orgId: string, l: LocationRow, input: { kind: string; title: string; description: string; vendor?: string | null; startsOn: string; endsOn?: string | null; budgetMinor: number; creative: CoopCreative[] }, userId: string) {
  const rule = await allowanceRule(s.db, orgId, l.id);
  if (!rule) throw conflict('coop_not_set_up', 'HQ has not set a co-op allowance for this location yet');
  if (input.endsOn && input.endsOn < input.startsOn) throw validationError('The end date is before the start date', { endsOn: 'Before start' });
  const periodKey = coopPeriodBounds(rule.period as CoopPeriod, input.startsOn).key;
  const settings = await getLocalMarketingSettings(s.db, orgId);
  const [row] = await s.db.insert(coopRequests).values({
    organizationId: orgId, locationId: l.id, kind: input.kind, title: input.title, description: input.description, vendor: input.vendor ?? null, startsOn: input.startsOn, endsOn: input.endsOn ?? null,
    budgetMinor: input.budgetMinor, currency: l.currency, periodKey, creative: input.creative, requestedBy: userId,
    checklist: settings.coopChecklist.map((c) => ({ key: c.key, label: c.label, passed: false, note: null })),
  }).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: 'coop.request_submitted', scopeKind: 'location', scopeId: l.id, targetType: 'coop_request', targetId: row!.id, metadata: { budgetMinor: input.budgetMinor, currency: l.currency, kind: input.kind } });
  const hq = await usersWithCapabilityAt(s.db, orgId, null, COOP, 'publish');
  await notify(s, { userIds: hq, organizationId: orgId, category: 'approval_request', title: `${l.name}: co-op request`, body: input.title, data: { kind: 'coop_request', requestId: row!.id, locationId: l.id } });
  return row!;
}

/**
 * HQ decision. Approval needs every checklist item ticked and an approved amount within the budget whose expected
 * reimbursement fits the allowance left; "changes requested" sends it back to the owner to resubmit.
 */
export async function decideRequest(s: Services, orgId: string, id: string, input: { decision: 'approve' | 'reject' | 'changes_requested'; checklist: CoopChecklistItem[]; approvedMinor?: number | null; note?: string | null }, userId: string) {
  const r = await loadRequest(s.db, orgId, id);
  if (r.status !== 'submitted') throw conflict('not_pending', 'This request is not waiting for a decision');
  if (r.requestedBy === userId) throw forbidden('Someone else has to decide your own request');
  const [l] = await s.db.select().from(locations).where(eq(locations.id, r.locationId));
  const keys = new Set(r.checklist.map((c) => c.key));
  const checklist = r.checklist.map((c) => ({ ...c, ...(input.checklist.find((x) => x.key === c.key) ?? {}), key: c.key, label: c.label }));
  let approvedMinor: number | null = null;
  if (input.decision === 'approve') {
    if (input.checklist.some((c) => !keys.has(c.key))) throw validationError('Unknown checklist item');
    const failed = checklist.filter((c) => !c.passed);
    if (failed.length) throw conflict('checklist_incomplete', 'Tick every brand checklist item before approving (or request changes)', { items: failed.map((f) => f.key) });
    approvedMinor = input.approvedMinor ?? r.budgetMinor;
    if (approvedMinor <= 0 || approvedMinor > r.budgetMinor) throw validationError('Approve an amount up to the requested budget', { approvedMinor: 'Out of range' });
    const sum = await periodSummary(s.db, orgId, l!, r.startsOn, { excludeRequestId: r.id });
    const expected = Math.floor((approvedMinor * sum.matchRatioBps) / 10_000);
    if (expected > sum.remainingMinor) throw conflict('coop_allowance_exceeded', `Only ${sum.remainingMinor} ${sum.currency} minor units of allowance are left in ${sum.periodKey}`, { remainingMinor: sum.remainingMinor, expectedMinor: expected, currency: sum.currency });
  }
  const status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'changes_requested';
  const [u] = await s.db.update(coopRequests).set({ status, checklist, approvedMinor, decidedBy: userId, decidedAt: new Date(), decisionNote: input.note ?? null, updatedAt: new Date() }).where(eq(coopRequests.id, r.id)).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: `coop.request_${status}`, scopeKind: 'location', scopeId: r.locationId, targetType: 'coop_request', targetId: r.id, metadata: { approvedMinor, currency: r.currency } });
  await notify(s, { userIds: [r.requestedBy], organizationId: orgId, category: 'network_update', title: `Co-op request ${status.replace('_', ' ')}`, body: r.title, data: { kind: 'coop_request', requestId: r.id } });
  return u!;
}

/** The owner edits and resubmits after "changes requested". */
export async function resubmitRequest(s: Services, orgId: string, id: string, patch: Partial<{ title: string; description: string; vendor: string | null; budgetMinor: number; creative: CoopCreative[]; startsOn: string; endsOn: string | null }>, userId: string) {
  const r = await loadRequest(s.db, orgId, id);
  if (r.status !== 'changes_requested' && r.status !== 'submitted') throw conflict('not_editable', 'Only submitted requests or requests with changes requested can be edited');
  const [u] = await s.db.update(coopRequests).set({ ...patch, status: 'submitted', checklist: r.checklist.map((c) => ({ ...c, passed: false })), updatedAt: new Date() }).where(eq(coopRequests.id, r.id)).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: 'coop.request_resubmitted', scopeKind: 'location', scopeId: r.locationId, targetType: 'coop_request', targetId: r.id });
  return u!;
}

export async function loadRequest(db: Exec, orgId: string, id: string) {
  const [r] = await db.select().from(coopRequests).where(and(eq(coopRequests.id, id), eq(coopRequests.organizationId, orgId)));
  if (!r) throw notFound('Co-op request');
  return r;
}

/* ── claims ── */

export async function submitClaim(s: Services, orgId: string, requestId: string, input: { spentMinor: number; invoice: Upload; proofs: Upload[]; proofNotes: string; performance: Record<string, number> }, userId: string) {
  const r = await loadRequest(s.db, orgId, requestId);
  if (r.status !== 'approved') throw conflict('request_not_approved', 'Claims follow an approved pre-approval request');
  if (input.spentMinor <= 0) throw validationError('Enter what was spent', { spentMinor: 'Must be > 0' });
  return s.db.transaction(async (tx) => {
    const invoice = await saveDocument(tx, { organizationId: orgId, kind: 'receipt', locationId: r.locationId, ...input.invoice, uploadedBy: userId });
    const proofs = [];
    for (const p of input.proofs) proofs.push((await saveDocument(tx, { organizationId: orgId, kind: 'evidence', locationId: r.locationId, ...p, uploadedBy: userId })).id);
    const [c] = await tx.insert(coopClaims).values({
      organizationId: orgId, requestId: r.id, locationId: r.locationId, spentMinor: input.spentMinor, currency: r.currency, invoiceDocumentId: invoice.id, proofDocumentIds: proofs, proofNotes: input.proofNotes, performance: input.performance, submittedBy: userId,
    }).returning();
    await tx.update(coopRequests).set({ status: 'claimed', updatedAt: new Date() }).where(eq(coopRequests.id, r.id));
    await audit(tx, { organizationId: orgId, actorUserId: userId, action: 'coop.claim_submitted', scopeKind: 'location', scopeId: r.locationId, targetType: 'coop_claim', targetId: c!.id, metadata: { spentMinor: input.spentMinor, currency: r.currency } });
    return c!;
  }).then(async (c) => {
    const hq = await usersWithCapabilityAt(s.db, orgId, null, COOP, 'publish');
    await notify(s, { userIds: hq, organizationId: orgId, category: 'approval_request', title: 'Co-op claim to review', body: r.title, data: { kind: 'coop_claim', claimId: c.id } });
    return c;
  });
}

/** HQ approves (reimbursable fixed now) or rejects (the request goes back to approved so a corrected claim can follow). */
export async function decideClaim(s: Services, orgId: string, id: string, input: { decision: 'approve' | 'reject'; note?: string | null }, userId: string) {
  const c = await loadClaim(s.db, orgId, id);
  if (c.status !== 'submitted') throw conflict('not_pending', 'This claim is not waiting for a decision');
  if (c.submittedBy === userId) throw forbidden('Someone else has to decide your own claim');
  const r = await loadRequest(s.db, orgId, c.requestId);
  if (input.decision === 'reject') {
    const [u] = await s.db.transaction(async (tx) => {
      const out = await tx.update(coopClaims).set({ status: 'rejected', decidedBy: userId, decidedAt: new Date(), decisionNote: input.note ?? null, updatedAt: new Date() }).where(eq(coopClaims.id, c.id)).returning();
      await tx.update(coopRequests).set({ status: 'approved', updatedAt: new Date() }).where(eq(coopRequests.id, r.id));
      await audit(tx, { organizationId: orgId, actorUserId: userId, action: 'coop.claim_rejected', scopeKind: 'location', scopeId: c.locationId, targetType: 'coop_claim', targetId: c.id });
      return out;
    });
    await notify(s, { userIds: [c.submittedBy], organizationId: orgId, category: 'network_update', title: 'Co-op claim not approved', body: input.note ?? r.title, data: { kind: 'coop_claim', claimId: c.id } });
    return u!;
  }
  const [l] = await s.db.select().from(locations).where(eq(locations.id, c.locationId));
  const sum = await periodSummary(s.db, orgId, l!, r.startsOn, { excludeRequestId: r.id });
  const calc = coopReimbursable({ spentMinor: c.spentMinor, approvedMinor: r.approvedMinor ?? 0, matchRatioBps: sum.matchRatioBps, remainingMinor: Math.max(0, sum.remainingMinor) });
  const [u] = await s.db.update(coopClaims).set({ status: 'approved', reimbursableMinor: calc.reimbursableMinor, decidedBy: userId, decidedAt: new Date(), decisionNote: input.note ?? null, updatedAt: new Date() }).where(eq(coopClaims.id, c.id)).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: userId, action: 'coop.claim_approved', scopeKind: 'location', scopeId: c.locationId, targetType: 'coop_claim', targetId: c.id, metadata: { ...calc, currency: c.currency } });
  await notify(s, { userIds: [c.submittedBy], organizationId: orgId, category: 'network_update', title: 'Co-op claim approved', body: r.title, data: { kind: 'coop_claim', claimId: c.id } });
  return u!;
}

/**
 * Records the reimbursement: books it as spend in the marketing fund ledger (with the invoice as receipt; never more
 * than the fund holds in that currency) and marks the claim paid (bank transfer with its reference, or manual).
 */
export async function markClaimPaid(s: Services, orgId: string, id: string, input: { method: 'bank_transfer' | 'manual'; reference?: string | null; paidOn?: string | null }, userId: string) {
  const c = await loadClaim(s.db, orgId, id);
  if (c.status !== 'approved') throw conflict('claim_not_approved', 'Only approved claims are reimbursed');
  if (input.method === 'bank_transfer' && !input.reference?.trim()) throw validationError('Add the bank transfer reference', { reference: 'Required' });
  const amount = c.reimbursableMinor ?? 0;
  const r = await loadRequest(s.db, orgId, c.requestId);
  const [l] = await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, c.locationId));
  return s.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fund:${orgId}`}))`);
    const [fresh] = await tx.select().from(coopClaims).where(eq(coopClaims.id, c.id));
    if (fresh!.status !== 'approved') throw conflict('claim_not_approved', 'Only approved claims are reimbursed');
    let entryId: string | null = null;
    if (amount > 0) {
      const bal = (await fundBalances(tx, orgId)).find((b) => b.currency === c.currency)?.balanceMinor ?? 0;
      if (amount > bal) throw conflict('fund_insufficient', `The fund holds ${bal} ${c.currency} minor units`, { balanceMinor: bal, currency: c.currency });
      const [e] = await tx.insert(marketingFundEntries).values({
        organizationId: orgId, kind: 'spend', currency: c.currency, amountMinor: -amount, occurredOn: input.paidOn ?? today(), description: `Co-op reimbursement: ${r.title} (${l?.name ?? 'location'})`,
        locationId: c.locationId, receiptDocumentId: c.invoiceDocumentId, vendor: r.vendor, createdBy: userId,
      }).returning();
      entryId = e!.id;
    }
    const [u] = await tx.update(coopClaims).set({ status: 'paid', fundEntryId: entryId, payoutMethod: input.method, payoutReference: input.reference?.trim() || null, paidAt: new Date(), paidBy: userId, updatedAt: new Date() }).where(eq(coopClaims.id, c.id)).returning();
    await audit(tx, { organizationId: orgId, actorUserId: userId, action: 'coop.claim_paid', scopeKind: 'location', scopeId: c.locationId, targetType: 'coop_claim', targetId: c.id, metadata: { amountMinor: amount, currency: c.currency, method: input.method, fundEntryId: entryId } });
    return u!;
  });
}

export async function loadClaim(db: Exec, orgId: string, id: string) {
  const [c] = await db.select().from(coopClaims).where(and(eq(coopClaims.id, id), eq(coopClaims.organizationId, orgId)));
  if (!c) throw notFound('Co-op claim');
  return c;
}

/* ── serializers ── */

export async function people(db: Exec, ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  return list.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list))).map((u) => [u.id, u.name])) : new Map<string, string>();
}

export function serializeRequest(r: RequestRow, names: Map<string, string>, locName: string | null, claim: ClaimRow | null) {
  return {
    id: r.id, locationId: r.locationId, locationName: locName, kind: r.kind, title: r.title, description: r.description, vendor: r.vendor, startsOn: r.startsOn, endsOn: r.endsOn,
    budgetMinor: r.budgetMinor, approvedMinor: r.approvedMinor, currency: r.currency, periodKey: r.periodKey, creative: r.creative, status: r.status, checklist: r.checklist,
    requestedBy: { id: r.requestedBy, name: names.get(r.requestedBy) ?? null }, decidedBy: r.decidedBy ? { id: r.decidedBy, name: names.get(r.decidedBy) ?? null } : null,
    decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote, createdAt: r.createdAt.toISOString(), claim: claim ? serializeClaim(claim, names) : null,
  };
}

export function serializeClaim(c: ClaimRow, names: Map<string, string>) {
  return {
    id: c.id, requestId: c.requestId, locationId: c.locationId, spentMinor: c.spentMinor, currency: c.currency, invoiceDocumentId: c.invoiceDocumentId, proofDocumentIds: c.proofDocumentIds,
    proofNotes: c.proofNotes, performance: c.performance, reimbursableMinor: c.reimbursableMinor, status: c.status, decisionNote: c.decisionNote,
    decidedBy: c.decidedBy ? { id: c.decidedBy, name: names.get(c.decidedBy) ?? null } : null, decidedAt: c.decidedAt?.toISOString() ?? null,
    fundEntryId: c.fundEntryId, payoutMethod: c.payoutMethod, payoutReference: c.payoutReference, paidAt: c.paidAt?.toISOString() ?? null,
    submittedBy: { id: c.submittedBy, name: names.get(c.submittedBy) ?? null }, createdAt: c.createdAt.toISOString(),
  };
}

export const latestClaims = async (db: Exec, requestIds: string[]) => (requestIds.length ? db.select().from(coopClaims).where(inArray(coopClaims.requestId, requestIds)).orderBy(desc(coopClaims.createdAt)) : []);
