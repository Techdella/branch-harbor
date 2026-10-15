/**
 * Payouts and reconciliation.
 *
 * Live mode reads each location's connected account: payouts and their balance transactions (charges, refunds,
 * disputes, fees), linked to BranchHarbor payments through the PaymentIntent id. Sandbox mode builds payouts from
 * succeeded payments (two days after the sale, a sandbox fee estimate of 2.9% + 30 minor units plus the application
 * fee) so the reconciliation can be exercised end to end; sandbox figures are labelled as such.
 *
 * Reconciliation per location and period: BranchHarbor payments ↔ payout transactions ↔ the royalty statement and
 * its invoice. Every figure stays in the location's currency.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import { financeBalanceTransactions, financeInvoices, financePayouts, locations, paymentReferences, refunds, royaltyPeriods, royaltyStatementLines, royaltyStatements } from '../../db/schema/index.ts';
import { NON_SALES_TARGETS, daysBetween, periodBoundsUtc } from '../../domain/royalty.ts';
import { addDays, localDateParts } from '../../lib/tz.ts';
import { sha256 } from '../../lib/crypto.ts';
import { audit } from '../audit.ts';
import { collectionAdapter } from './invoices.ts';

const SANDBOX_FEE_BPS = 290;
const SANDBOX_FEE_FIXED = 30;

async function recomputePayout(db: Exec, payoutId: string) {
  const txns = await db.select().from(financeBalanceTransactions).where(eq(financeBalanceTransactions.payoutId, payoutId));
  const sum = (f: (t: (typeof txns)[number]) => boolean, v: (t: (typeof txns)[number]) => number) => txns.filter(f).reduce((a, t) => a + v(t), 0);
  await db.update(financePayouts).set({
    grossMinor: sum((t) => t.type === 'charge', (t) => t.amountMinor),
    feesMinor: sum(() => true, (t) => t.feeMinor) + sum((t) => t.type === 'fee', (t) => -t.amountMinor),
    refundsMinor: sum((t) => t.type === 'refund', (t) => -t.amountMinor),
    chargebacksMinor: sum((t) => t.type === 'dispute', (t) => -t.amountMinor),
    otherMinor: sum((t) => t.type === 'adjustment' || t.type === 'other', (t) => t.amountMinor),
    amountMinor: sum(() => true, (t) => t.netMinor),
    syncedAt: new Date(),
  }).where(eq(financePayouts.id, payoutId));
}

async function sandboxSync(db: Exec, organizationId: string, loc: typeof locations.$inferSelect, now: Date) {
  const cutoff = new Date(now.getTime() - 2 * 86_400_000);
  const linked = db.select({ id: financeBalanceTransactions.paymentId }).from(financeBalanceTransactions).where(eq(financeBalanceTransactions.locationId, loc.id));
  const pays = (await db.select().from(paymentReferences).where(and(eq(paymentReferences.locationId, loc.id), eq(paymentReferences.state, 'succeeded'), lt(paymentReferences.succeededAt, cutoff))))
    .filter((p) => !NON_SALES_TARGETS.has(p.targetType ?? '') && p.currency === loc.currency);
  const already = new Set((await linked).map((r) => r.id));
  const refundRows = (await db.select({ r: refunds, p: paymentReferences }).from(refunds).innerJoin(paymentReferences, eq(paymentReferences.id, refunds.paymentId))
    .where(and(eq(paymentReferences.locationId, loc.id), eq(refunds.state, 'complete'), lt(refunds.updatedAt, cutoff)))).filter((x) => x.r.currency === loc.currency);
  const linkedRefunds = new Set((await db.select({ ext: financeBalanceTransactions.externalId }).from(financeBalanceTransactions).where(and(eq(financeBalanceTransactions.locationId, loc.id), eq(financeBalanceTransactions.type, 'refund')))).map((r) => r.ext));
  const byDay = new Map<string, Array<{ ext: string; type: string; sourceId: string; paymentId: string; amount: number; fee: number }>>();
  const push = (at: Date, t: { ext: string; type: string; sourceId: string; paymentId: string; amount: number; fee: number }) => {
    const day = localDateParts(at, loc.timeZone).date;
    byDay.set(day, [...(byDay.get(day) ?? []), t]);
  };
  for (const p of pays) {
    if (already.has(p.id)) continue;
    const fee = Math.round((p.amountMinor * SANDBOX_FEE_BPS) / 10_000) + SANDBOX_FEE_FIXED + p.applicationFeeMinor;
    push(p.succeededAt!, { ext: `txn_sandbox_${p.id.slice(0, 18)}`, type: 'charge', sourceId: p.externalId, paymentId: p.id, amount: p.amountMinor, fee });
  }
  for (const { r, p } of refundRows) {
    const ext = `txn_sandbox_re_${r.id.slice(0, 15)}`;
    if (linkedRefunds.has(ext)) continue;
    push(r.updatedAt, { ext, type: 'refund', sourceId: r.externalId ?? r.id, paymentId: p.id, amount: -r.amountMinor, fee: 0 });
  }
  let created = 0;
  for (const [day, txns] of byDay) {
    const arrival = addDays(day, 2);
    const ext = `po_sandbox_${sha256(`${loc.id}:${day}`).slice(0, 14)}`;
    const status = arrival <= localDateParts(now, loc.timeZone).date ? 'paid' : 'in_transit';
    const [po] = await db.insert(financePayouts).values({ organizationId, locationId: loc.id, connectedAccountId: loc.stripeAccountId ?? 'acct_sandbox', externalId: ext, currency: loc.currency, amountMinor: 0, status, arrivalDate: arrival, sandbox: true })
      .onConflictDoUpdate({ target: [financePayouts.connectedAccountId, financePayouts.externalId], set: { status, syncedAt: new Date() } }).returning();
    await db.insert(financeBalanceTransactions).values(txns.map((t) => ({ organizationId, payoutId: po!.id, locationId: loc.id, externalId: t.ext, type: t.type, sourceId: t.sourceId, paymentId: t.paymentId, currency: loc.currency, amountMinor: t.amount, feeMinor: t.fee, netMinor: t.amount - t.fee }))).onConflictDoNothing();
    await recomputePayout(db, po!.id);
    created++;
  }
  return created;
}

/** Syncs payouts for every location with a connected account (live: from Stripe; sandbox: generated). */
export async function syncPayouts(s: Services, organizationId: string, actorUserId: string | null, now = new Date()) {
  const locs = (await s.db.select().from(locations).where(eq(locations.organizationId, organizationId))).filter((l) => l.paymentsEnabled && l.stripeAccountId);
  const adapter = collectionAdapter(s);
  let payouts = 0;
  for (const loc of locs) {
    if (adapter.mode === 'sandbox' || loc.stripeAccountId!.includes('_sandbox_')) {
      payouts += await sandboxSync(s.db, organizationId, loc, now);
      continue;
    }
    for (const po of await adapter.listPayouts(loc.stripeAccountId!)) {
      if (po.currency !== loc.currency) continue;
      const [row] = await s.db.insert(financePayouts).values({ organizationId, locationId: loc.id, connectedAccountId: loc.stripeAccountId!, externalId: po.id, currency: po.currency, amountMinor: po.amountMinor, status: po.status, arrivalDate: po.arrivalDate })
        .onConflictDoUpdate({ target: [financePayouts.connectedAccountId, financePayouts.externalId], set: { status: po.status, arrivalDate: po.arrivalDate, syncedAt: new Date() } }).returning();
      const pis = po.transactions.map((t) => t.sourcePaymentIntent).filter((x): x is string => !!x);
      const refs = pis.length ? await s.db.select({ id: paymentReferences.id, ext: paymentReferences.externalId }).from(paymentReferences).where(inArray(paymentReferences.externalId, pis)) : [];
      const byPi = new Map(refs.map((r) => [r.ext, r.id]));
      if (po.transactions.length) {
        await s.db.insert(financeBalanceTransactions).values(po.transactions.map((t) => ({
          organizationId, payoutId: row!.id, locationId: loc.id, externalId: t.id, type: t.type, sourceId: t.sourceId, paymentId: t.sourcePaymentIntent ? byPi.get(t.sourcePaymentIntent) ?? null : null,
          currency: po.currency, amountMinor: t.amountMinor, feeMinor: t.feeMinor, netMinor: t.netMinor,
        }))).onConflictDoNothing();
      }
      await recomputePayout(s.db, row!.id);
      await s.db.update(financePayouts).set({ amountMinor: po.amountMinor }).where(eq(financePayouts.id, row!.id));
      payouts++;
    }
  }
  await audit(s.db, { organizationId, actorUserId, action: 'finance.payouts_synced', scopeKind: 'organization', scopeId: organizationId, metadata: { payouts, mode: adapter.mode } });
  return { payouts, mode: adapter.mode };
}

export function serializePayout(p: typeof financePayouts.$inferSelect, locName?: string | null) {
  return {
    id: p.id, location: { id: p.locationId, name: locName ?? null }, externalId: p.externalId, currency: p.currency, amountMinor: p.amountMinor, grossMinor: p.grossMinor, feesMinor: p.feesMinor,
    refundsMinor: p.refundsMinor, chargebacksMinor: p.chargebacksMinor, otherMinor: p.otherMinor, status: p.status, arrivalDate: p.arrivalDate, sandbox: p.sandbox, syncedAt: p.syncedAt.toISOString(),
  };
}

export interface ReconciliationRow {
  locationId: string;
  currency: string;
  paymentsMinor: number;
  paymentCount: number;
  paidOutMinor: number;
  notPaidOutMinor: number;
  feesMinor: number;
  refundsMinor: number;
  chargebacksMinor: number;
  statement: { id: string; status: string; salesMinor: number; basisMinor: number; totalMinor: number } | null;
  invoice: { id: string; number: string; status: string; totalMinor: number; paidMinor: number; dueDate: string } | null;
  issues: Array<{ kind: 'statement_out_of_date' | 'not_paid_out' | 'unmatched_payout_transaction' | 'royalty_unpaid' | 'no_statement'; detail: string; amountMinor: number | null }>;
}

/** Reconciliation for a closed period: payments ↔ payouts ↔ royalty statement and invoice, per location. */
export async function reconciliation(db: Exec, organizationId: string, periodId: string, allowed: 'all' | Set<string>, todayLocal: string): Promise<ReconciliationRow[]> {
  const [period] = await db.select().from(royaltyPeriods).where(and(eq(royaltyPeriods.id, periodId), eq(royaltyPeriods.organizationId, organizationId)));
  if (!period) return [];
  const locs = (await db.select().from(locations).where(eq(locations.organizationId, organizationId))).filter((l) => (allowed === 'all' || allowed.has(l.id)) && l.status !== 'draft');
  const statements = await db.select().from(royaltyStatements).where(eq(royaltyStatements.periodId, period.id));
  const out: ReconciliationRow[] = [];
  for (const loc of locs) {
    const { startAt, endAt } = periodBoundsUtc(period.startDate, period.endDate, loc.timeZone);
    const pays = (await db.select().from(paymentReferences).where(and(eq(paymentReferences.locationId, loc.id), eq(paymentReferences.state, 'succeeded'), gte(paymentReferences.succeededAt, startAt), lt(paymentReferences.succeededAt, endAt))))
      .filter((p) => !NON_SALES_TARGETS.has(p.targetType ?? '') && p.currency === loc.currency);
    const st = statements.find((x) => x.locationId === loc.id) ?? null;
    if (!pays.length && !st) continue;
    const txns = pays.length ? await db.select().from(financeBalanceTransactions).where(inArray(financeBalanceTransactions.paymentId, pays.map((p) => p.id))) : [];
    const charged = new Map<string, number>();
    for (const t of txns.filter((x) => x.type === 'charge')) charged.set(t.paymentId!, (charged.get(t.paymentId!) ?? 0) + t.amountMinor);
    const paymentsMinor = pays.reduce((a, p) => a + p.amountMinor, 0);
    const paidOutMinor = [...charged.values()].reduce((a, x) => a + x, 0);
    const late = pays.filter((p) => !charged.has(p.id) && p.succeededAt && daysBetween(localDateParts(p.succeededAt, loc.timeZone).date, todayLocal) > 7);
    const issues: ReconciliationRow['issues'] = [];
    if (late.length) issues.push({ kind: 'not_paid_out', detail: `${late.length}`, amountMinor: late.reduce((a, p) => a + p.amountMinor, 0) });
    const unmatched = await db.select({ n: sql<number>`count(*)::int`, amt: sql<number>`coalesce(sum(${financeBalanceTransactions.amountMinor}),0)::bigint` }).from(financeBalanceTransactions).innerJoin(financePayouts, eq(financePayouts.id, financeBalanceTransactions.payoutId))
      .where(and(eq(financeBalanceTransactions.locationId, loc.id), eq(financeBalanceTransactions.type, 'charge'), isNull(financeBalanceTransactions.paymentId), gte(financePayouts.arrivalDate, period.startDate), lt(financePayouts.arrivalDate, period.endDate)));
    if (unmatched[0]!.n > 0) issues.push({ kind: 'unmatched_payout_transaction', detail: `${unmatched[0]!.n}`, amountMinor: Number(unmatched[0]!.amt) });
    let statement: ReconciliationRow['statement'] = null;
    let invoice: ReconciliationRow['invoice'] = null;
    if (st) {
      const salesLines = await db.select({ amt: royaltyStatementLines.amountMinor }).from(royaltyStatementLines).where(and(eq(royaltyStatementLines.statementId, st.id), eq(royaltyStatementLines.kind, 'sales')));
      const salesMinor = salesLines.reduce((a, l) => a + l.amt, 0);
      statement = { id: st.id, status: st.status, salesMinor, basisMinor: st.basisMinor, totalMinor: st.totalMinor };
      if (salesMinor !== pays.reduce((a, p) => a + (p.providerAmountMinor ?? p.amountMinor), 0)) issues.push({ kind: 'statement_out_of_date', detail: st.status, amountMinor: paymentsMinor - salesMinor });
      if (st.invoiceId) {
        const [inv] = await db.select().from(financeInvoices).where(eq(financeInvoices.id, st.invoiceId));
        if (inv) {
          invoice = { id: inv.id, number: inv.number, status: inv.status, totalMinor: inv.totalMinor, paidMinor: inv.paidMinor, dueDate: inv.dueDate };
          if (inv.status !== 'paid' && daysBetween(inv.dueDate, todayLocal) > 0) issues.push({ kind: 'royalty_unpaid', detail: inv.number, amountMinor: inv.totalMinor - inv.paidMinor });
        }
      }
    } else if (loc.ownerGroupId) issues.push({ kind: 'no_statement', detail: '', amountMinor: null });
    const payoutIds = [...new Set(txns.map((t) => t.payoutId))];
    const related = payoutIds.length ? await db.select().from(financeBalanceTransactions).where(and(inArray(financeBalanceTransactions.payoutId, payoutIds))) : [];
    const inPeriod = new Set(pays.map((p) => p.id));
    const mine = related.filter((t) => t.paymentId && inPeriod.has(t.paymentId));
    out.push({
      locationId: loc.id, currency: loc.currency, paymentsMinor, paymentCount: pays.length, paidOutMinor, notPaidOutMinor: paymentsMinor - paidOutMinor,
      feesMinor: mine.reduce((a, t) => a + t.feeMinor, 0), refundsMinor: -mine.filter((t) => t.type === 'refund').reduce((a, t) => a + t.amountMinor, 0),
      chargebacksMinor: -mine.filter((t) => t.type === 'dispute').reduce((a, t) => a + t.amountMinor, 0), statement, invoice, issues,
    });
  }
  return out;
}
