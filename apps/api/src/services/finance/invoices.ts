/**
 * Royalty invoices and collection (docs/API_INTEGRATIONS.md "Finance: royalty collection").
 *
 * - Invoices: one per approved statement, numbered `<prefix>-<6 digits>` gapless per organisation (sequence taken under
 *   a row lock on finance_settings), tax lines only as HQ configured them.
 * - Collection: off-session debit of the franchisee's saved method (card or bank debit with mandate) as a direct charge
 *   on the franchisor's collection account. The charge is a `payment_references` row (target `royalty_invoice`), so the
 *   signed webhook path (payments.ts) settles it idempotently through the payment-target extension registered below.
 * - Dunning: reminders, retries, late fees (per agreement terms) and a final notice, each recorded once.
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Services } from '../../context.ts';
import type { Exec, Tx } from '../../db/client.ts';
import {
  financeCollectionAttempts, financeDunningEvents, financeInvoices, financePaymentMethods, financeSettings, locations, marketingFundEntries, organizations, ownerGroups,
  paymentReferences, roleAssignments, royaltyStatements, users,
} from '../../db/schema/index.ts';
import type { LateFeeTerms } from '../../db/schema/finance.ts';
import { daysBetween, formatInvoiceNumber, invoiceLinesFromStatement, invoiceTaxes, lateFeeFor } from '../../domain/royalty.ts';
import { createCollectionAdapter, methodTypesFor, type CollectionAdapter, type DebitMethodType } from '../../integrations/finance-collection.ts';
import { localDateParts, addDays } from '../../lib/tz.ts';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.ts';
import { audit } from '../audit.ts';
import { paymentFailureHooks, paymentTargetExtensions, processStripeEvent, sandboxEvent, stripeEventExtensions, type PaymentRow } from '../payments.ts';
import { getFinanceSettings } from './terms.ts';

type InvoiceRow = typeof financeInvoices.$inferSelect;

/* ------------------------------------------------------------------ */
/* Collection adapter (overridable in tests)                           */
/* ------------------------------------------------------------------ */

const adapters = new WeakMap<Services, CollectionAdapter>();
export function collectionAdapter(s: Services): CollectionAdapter {
  let a = adapters.get(s);
  if (!a) adapters.set(s, (a = createCollectionAdapter(s.payments)));
  return a;
}
export function setCollectionAdapter(s: Services, a: CollectionAdapter) {
  adapters.set(s, a);
}

/** The franchisor's account that receives royalties: finance settings, else the organisation's shared account. */
export async function collectionAccount(db: Exec, organizationId: string): Promise<string | null> {
  const st = await getFinanceSettings(db, organizationId);
  if (st.collectionAccountId) return st.collectionAccountId;
  const [org] = await db.select({ acct: organizations.stripeAccountId }).from(organizations).where(eq(organizations.id, organizationId));
  return org?.acct ?? null;
}

export const today = (timeZone: string, now = new Date()) => localDateParts(now, timeZone).date;

async function orgTimeZone(db: Exec, organizationId: string) {
  const [o] = await db.select({ tz: organizations.defaultTimeZone }).from(organizations).where(eq(organizations.id, organizationId));
  return o?.tz ?? 'UTC';
}

/* ------------------------------------------------------------------ */
/* Issue                                                               */
/* ------------------------------------------------------------------ */

export async function issueInvoice(s: Services, organizationId: string, statementId: string, actorUserId: string, now = new Date()) {
  const invoice = await s.db.transaction(async (tx) => {
    const [st] = await tx.select().from(royaltyStatements).where(and(eq(royaltyStatements.id, statementId), eq(royaltyStatements.organizationId, organizationId))).for('update');
    if (!st) throw notFound('Statement');
    if (st.status !== 'approved') throw conflict('statement_not_approved', `Only approved statements can be invoiced (this one is ${st.status})`);
    if (st.totalMinor <= 0) throw conflict('nothing_to_invoice', 'This statement has nothing to pay');
    const [settings] = await tx.select().from(financeSettings).where(eq(financeSettings.organizationId, organizationId)).for('update');
    const cfg = settings ?? (await getFinanceSettings(tx, organizationId));
    const [loc] = await tx.select().from(locations).where(eq(locations.id, st.locationId));
    const seq = cfg.nextInvoiceSeq;
    await tx.update(financeSettings).set({ nextInvoiceSeq: seq + 1, updatedAt: new Date() }).where(eq(financeSettings.organizationId, organizationId));
    const lines = invoiceLinesFromStatement(st);
    const taxes = invoiceTaxes(lines, cfg.taxLines, loc!.country);
    const subtotal = lines.reduce((a, l) => a + l.amountMinor, 0);
    const tax = taxes.reduce((a, t) => a + t.amountMinor, 0);
    const issueDate = today(await orgTimeZone(tx, organizationId), now);
    const [inv] = await tx.insert(financeInvoices).values({
      organizationId, statementId: st.id, locationId: st.locationId, ownerGroupId: st.ownerGroupId, number: formatInvoiceNumber(cfg.invoicePrefix, seq), seq, currency: st.currency,
      issueDate, dueDate: addDays(issueDate, cfg.paymentTermsDays), lines, taxes, subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax,
      marketingFundMinor: st.marketingFundMinor, createdBy: actorUserId,
    }).returning();
    await tx.update(royaltyStatements).set({ status: 'invoiced', invoiceId: inv!.id, updatedAt: new Date() }).where(eq(royaltyStatements.id, st.id));
    await audit(tx, { organizationId, actorUserId, action: 'finance.invoice_issued', scopeKind: 'location', scopeId: st.locationId, targetType: 'finance_invoice', targetId: inv!.id, metadata: { number: inv!.number, totalMinor: inv!.totalMinor, currency: inv!.currency } });
    return { inv: inv!, autoCollect: cfg.autoCollect };
  });
  let collection: Awaited<ReturnType<typeof collectInvoice>> | null = null;
  if (invoice.autoCollect && invoice.inv.ownerGroupId && (await activeMethod(s.db, invoice.inv.ownerGroupId, invoice.inv.currency))) {
    collection = await collectInvoice(s, organizationId, invoice.inv.id, { actorUserId, trigger: 'issue' });
  }
  const [fresh] = await s.db.select().from(financeInvoices).where(eq(financeInvoices.id, invoice.inv.id));
  return { invoice: fresh!, collection };
}

/* ------------------------------------------------------------------ */
/* Payment methods (mandates)                                          */
/* ------------------------------------------------------------------ */

export async function activeMethod(db: Exec, ownerGroupId: string, currency: string) {
  const [m] = await db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.ownerGroupId, ownerGroupId), eq(financePaymentMethods.currency, currency), eq(financePaymentMethods.status, 'active'))).orderBy(desc(financePaymentMethods.updatedAt)).limit(1);
  return m ?? null;
}

/** The mandate text the franchisee accepts; stored verbatim with who, when and from where. */
export function mandateText(orgName: string, groupName: string, methodType: DebitMethodType, currency: string) {
  const what = methodType === 'card' ? 'charge this card' : 'debit this bank account';
  return `${groupName} authorises ${orgName} to ${what} for royalty, marketing fund and fee invoices in ${currency} issued under the franchise agreement, on or after each invoice due date, until this authorisation is revoked in writing. Each invoice is available in BranchHarbor before it is collected.`;
}

export async function startPaymentMethodSetup(s: Services, organizationId: string, input: { ownerGroupId: string; currency: string; methodType: DebitMethodType; acceptMandate: boolean }, actor: { userId: string; ip: string | null }) {
  if (!input.acceptMandate) throw validationError('The franchisee must accept the debit authorisation', { acceptMandate: 'Required' });
  const currency = input.currency.toUpperCase();
  if (!methodTypesFor(currency).includes(input.methodType)) throw validationError(`${input.methodType} is not available for ${currency}`, { methodType: `Use one of ${methodTypesFor(currency).join(', ')}` });
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, organizationId));
  const [group] = await s.db.select().from(ownerGroups).where(and(eq(ownerGroups.id, input.ownerGroupId), eq(ownerGroups.organizationId, organizationId)));
  if (!group) throw notFound('Owner group');
  const account = await collectionAccount(s.db, organizationId);
  const adapter = collectionAdapter(s);
  if (adapter.mode === 'live' && !account) throw new AppError(409, 'collection_account_missing', 'HQ has not connected the account that receives royalties yet');
  const [existing] = await s.db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.ownerGroupId, group.id), eq(financePaymentMethods.currency, currency))).orderBy(desc(financePaymentMethods.createdAt)).limit(1);
  const customerId = existing?.stripeCustomerId ?? (await adapter.ensureCustomer({ accountId: account, name: group.legalName ?? group.name, email: null, metadata: { bh_org: organizationId, bh_owner_group: group.id }, idempotencyKey: `fin_cus:${group.id}:${currency}:${account ?? 'sandbox'}` })).id;
  const text = mandateText(org!.name, group.legalName ?? group.name, input.methodType, currency);
  const [pm] = await s.db.insert(financePaymentMethods).values({
    organizationId, ownerGroupId: group.id, currency, collectionAccountId: account, stripeCustomerId: customerId, methodType: input.methodType, mandateText: text,
    mandateAcceptedAt: new Date(), mandateAcceptedBy: actor.userId, mandateIp: actor.ip, status: 'pending', sandbox: adapter.mode === 'sandbox',
  }).returning();
  const si = await adapter.createSetupIntent({ accountId: account, customerId, methodType: input.methodType, currency, metadata: { bh_org: organizationId, bh_owner_group: group.id, bh_finance_method: pm!.id }, idempotencyKey: `fin_seti:${pm!.id}` });
  await s.db.update(financePaymentMethods).set({ setupIntentId: si.id, updatedAt: new Date() }).where(eq(financePaymentMethods.id, pm!.id));
  await audit(s.db, { organizationId, actorUserId: actor.userId, action: 'finance.mandate_started', scopeKind: 'owner_group', scopeId: group.id, targetType: 'finance_payment_method', targetId: pm!.id, metadata: { methodType: input.methodType, currency }, ip: actor.ip });
  return { id: pm!.id, clientSecret: si.clientSecret, setupIntentId: si.id, connectedAccountId: account, publishableKey: s.payments.publishableKey, mode: adapter.mode, mandateText: text };
}

async function activate(db: Exec, pmId: string, paymentMethodId: string, display: Record<string, string | null | undefined>) {
  const [pm] = await db.select().from(financePaymentMethods).where(eq(financePaymentMethods.id, pmId));
  if (!pm) return null;
  // One active method per owner group and currency: the new one replaces the old.
  await db.update(financePaymentMethods).set({ status: 'revoked', updatedAt: new Date() }).where(and(eq(financePaymentMethods.ownerGroupId, pm.ownerGroupId), eq(financePaymentMethods.currency, pm.currency), eq(financePaymentMethods.status, 'active'), ne(financePaymentMethods.id, pm.id)));
  const [row] = await db.update(financePaymentMethods).set({ status: 'active', paymentMethodId, display, updatedAt: new Date() }).where(eq(financePaymentMethods.id, pm.id)).returning();
  return row!;
}

/** Sandbox: complete the SetupIntent as if the franchisee confirmed it (`decline` makes later debits fail). */
export async function confirmSandboxMethod(s: Services, organizationId: string, id: string, outcome: 'ok' | 'decline', actorUserId: string) {
  if (collectionAdapter(s).mode !== 'sandbox') throw notFound('Route');
  const [pm] = await s.db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.id, id), eq(financePaymentMethods.organizationId, organizationId)));
  if (!pm) throw notFound('Payment method');
  if (pm.status !== 'pending') throw conflict('method_not_pending', 'This payment method is not waiting for confirmation');
  const row = await activate(s.db, pm.id, `pm_sandbox_${pm.methodType}_${outcome}_${pm.id.slice(0, 8)}`, { brand: pm.methodType === 'card' ? 'visa' : null, last4: outcome === 'ok' ? '4242' : '0002', bankName: pm.methodType === 'card' ? null : 'Sandbox Bank' });
  await audit(s.db, { organizationId, actorUserId, action: 'finance.mandate_active', scopeKind: 'owner_group', scopeId: pm.ownerGroupId, targetType: 'finance_payment_method', targetId: pm.id, metadata: { sandbox: true } });
  return row!;
}

/** Live: read the SetupIntent and activate the method once Stripe reports it succeeded. */
export async function refreshMethod(s: Services, organizationId: string, id: string) {
  const [pm] = await s.db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.id, id), eq(financePaymentMethods.organizationId, organizationId)));
  if (!pm) throw notFound('Payment method');
  if (pm.status !== 'pending' || !pm.setupIntentId) return pm;
  const si = await collectionAdapter(s).retrieveSetupIntent({ accountId: pm.collectionAccountId, id: pm.setupIntentId });
  if (si.status === 'succeeded' && si.paymentMethodId) return (await activate(s.db, pm.id, si.paymentMethodId, si.display))!;
  return pm;
}

export async function revokeMethod(s: Services, organizationId: string, id: string, actorUserId: string) {
  const [pm] = await s.db.update(financePaymentMethods).set({ status: 'revoked', updatedAt: new Date() }).where(and(eq(financePaymentMethods.id, id), eq(financePaymentMethods.organizationId, organizationId))).returning();
  if (!pm) throw notFound('Payment method');
  await audit(s.db, { organizationId, actorUserId, action: 'finance.mandate_revoked', scopeKind: 'owner_group', scopeId: pm.ownerGroupId, targetType: 'finance_payment_method', targetId: pm.id });
  return pm;
}

export function serializeMethod(pm: typeof financePaymentMethods.$inferSelect) {
  return {
    id: pm.id, ownerGroupId: pm.ownerGroupId, currency: pm.currency, methodType: pm.methodType, status: pm.status, display: pm.display, mandateText: pm.mandateText,
    mandateAcceptedAt: pm.mandateAcceptedAt.toISOString(), sandbox: pm.sandbox, createdAt: pm.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Collect                                                             */
/* ------------------------------------------------------------------ */

const outstanding = (inv: InvoiceRow) => inv.totalMinor - inv.paidMinor;

/** Debits the franchisee's active method for the invoice's outstanding amount. */
export async function collectInvoice(s: Services, organizationId: string, invoiceId: string, opts: { actorUserId: string | null; trigger: 'issue' | 'manual' | 'dunning' | 'franchisee' }) {
  const [inv] = await s.db.select().from(financeInvoices).where(and(eq(financeInvoices.id, invoiceId), eq(financeInvoices.organizationId, organizationId)));
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'paid' || inv.status === 'void') throw conflict('invoice_closed', `This invoice is ${inv.status}`);
  if (inv.status === 'processing') throw conflict('collection_in_progress', 'A payment for this invoice is already processing');
  if (!inv.ownerGroupId) throw conflict('no_owner_group', 'This invoice has no franchisee to collect from');
  const method = await activeMethod(s.db, inv.ownerGroupId, inv.currency);
  if (!method?.paymentMethodId) throw conflict('no_mandate', `No active ${inv.currency} payment method for this franchisee`);
  const amount = outstanding(inv);
  const attemptNo = (await s.db.select({ n: sql<number>`count(*)::int` }).from(financeCollectionAttempts).where(eq(financeCollectionAttempts.invoiceId, inv.id)))[0]!.n + 1;
  const idempotencyKey = `fin_inv:${inv.id}:${attemptNo}`;
  const adapter = collectionAdapter(s);
  const result = await adapter.debit({
    accountId: method.collectionAccountId, customerId: method.stripeCustomerId, paymentMethodId: method.paymentMethodId, methodType: method.methodType as DebitMethodType,
    amountMinor: amount, currency: inv.currency, idempotencyKey, description: `Invoice ${inv.number}`,
    metadata: { bh_org: organizationId, bh_target_type: 'royalty_invoice', bh_target_id: inv.id, bh_invoice_number: inv.number },
  });
  const [p] = await s.db.insert(paymentReferences).values({
    organizationId, locationId: null, provider: 'stripe', externalId: result.id, connectedAccountId: method.collectionAccountId, amountMinor: amount, currency: inv.currency,
    state: 'processing', targetType: 'royalty_invoice', targetId: inv.id, sandbox: adapter.mode === 'sandbox' ? 1 : 0,
  }).onConflictDoUpdate({ target: [paymentReferences.provider, paymentReferences.externalId], set: { updatedAt: new Date() } }).returning();
  const status = result.status;
  const [attempt] = await s.db.insert(financeCollectionAttempts).values({
    organizationId, invoiceId: inv.id, attempt: attemptNo, method: 'debit', idempotencyKey, paymentId: p!.id, paymentIntentId: result.id, amountMinor: amount, currency: inv.currency,
    status, failureCode: result.failureCode ?? null, failureMessage: result.failureMessage ?? null, createdBy: opts.actorUserId,
  }).returning();
  if (status === 'processing' || status === 'requires_action') await s.db.update(financeInvoices).set({ status: 'processing', updatedAt: new Date() }).where(eq(financeInvoices.id, inv.id));
  await audit(s.db, { organizationId, actorUserId: opts.actorUserId, action: 'finance.collection_attempted', scopeKind: 'location', scopeId: inv.locationId, targetType: 'finance_invoice', targetId: inv.id, metadata: { attempt: attemptNo, status, amountMinor: amount, currency: inv.currency, trigger: opts.trigger } });
  // Sandbox: outcomes known now go through the same signed-event processor a real webhook uses.
  if (adapter.mode === 'sandbox' && (status === 'succeeded' || status === 'failed')) {
    await processStripeEvent(s, sandboxEvent(p!, status === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed'));
  } else if (status === 'failed') {
    await s.db.update(paymentReferences).set({ state: 'failed', updatedAt: new Date() }).where(eq(paymentReferences.id, p!.id));
  }
  const [after] = await s.db.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.id, attempt!.id));
  return after!;
}

/** Sandbox: settle a processing bank debit (as the provider would days later). */
export async function settleSandboxCollection(s: Services, organizationId: string, invoiceId: string, outcome: 'succeeded' | 'failed') {
  if (collectionAdapter(s).mode !== 'sandbox') throw notFound('Route');
  const [att] = await s.db.select().from(financeCollectionAttempts).where(and(eq(financeCollectionAttempts.invoiceId, invoiceId), eq(financeCollectionAttempts.organizationId, organizationId), eq(financeCollectionAttempts.status, 'processing'))).orderBy(desc(financeCollectionAttempts.attempt)).limit(1);
  if (!att?.paymentId) throw conflict('nothing_processing', 'No payment is processing for this invoice');
  const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, att.paymentId));
  return processStripeEvent(s, sandboxEvent(p!, outcome === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed'));
}

/** Money received outside Stripe (bank transfer, cheque): recorded by HQ finance. */
export async function recordManualPayment(s: Services, organizationId: string, invoiceId: string, input: { amountMinor: number; reference: string; receivedOn: string }, actorUserId: string) {
  return s.db.transaction(async (tx) => {
    const [inv] = await tx.select().from(financeInvoices).where(and(eq(financeInvoices.id, invoiceId), eq(financeInvoices.organizationId, organizationId))).for('update');
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'paid' || inv.status === 'void') throw conflict('invoice_closed', `This invoice is ${inv.status}`);
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > outstanding(inv)) throw validationError(`Amount must be between 1 and ${outstanding(inv)} (${inv.currency} minor units)`, { amountMinor: 'Out of range' });
    const n = (await tx.select({ n: sql<number>`count(*)::int` }).from(financeCollectionAttempts).where(eq(financeCollectionAttempts.invoiceId, inv.id)))[0]!.n + 1;
    await tx.insert(financeCollectionAttempts).values({ organizationId, invoiceId: inv.id, attempt: n, method: 'manual', idempotencyKey: `fin_manual:${inv.id}:${n}`, amountMinor: input.amountMinor, currency: inv.currency, status: 'succeeded', reference: `${input.reference} (${input.receivedOn})`, createdBy: actorUserId });
    const row = await applyPayment(tx, inv, input.amountMinor);
    await audit(tx, { organizationId, actorUserId, action: 'finance.payment_recorded', scopeKind: 'location', scopeId: inv.locationId, targetType: 'finance_invoice', targetId: inv.id, metadata: { amountMinor: input.amountMinor, currency: inv.currency, reference: input.reference } });
    return row;
  });
}

/** Adds a payment to an invoice; when fully paid, credits the marketing-fund share to the fund ledger (once). */
async function applyPayment(tx: Exec, inv: InvoiceRow, amountMinor: number) {
  const paid = Math.min(inv.totalMinor, inv.paidMinor + amountMinor);
  const full = paid >= inv.totalMinor;
  const [row] = await tx.update(financeInvoices).set({ paidMinor: paid, status: full ? 'paid' : 'open', paidAt: full ? new Date() : null, updatedAt: new Date() }).where(eq(financeInvoices.id, inv.id)).returning();
  if (full && inv.marketingFundMinor > 0) {
    await tx.insert(marketingFundEntries).values({
      organizationId: inv.organizationId, kind: 'contribution', currency: inv.currency, amountMinor: inv.marketingFundMinor, occurredOn: new Date().toISOString().slice(0, 10),
      description: `contribution:${inv.number}`, locationId: inv.locationId, ownerGroupId: inv.ownerGroupId, invoiceId: inv.id,
    }).onConflictDoNothing();
  }
  return row!;
}

/* Settlement through the signed webhook path (services/payments.ts extension points). */
paymentTargetExtensions.royalty_invoice = {
  async fulfil(tx: Tx, p: PaymentRow) {
    const [inv] = await tx.select().from(financeInvoices).where(eq(financeInvoices.id, p.targetId!)).for('update');
    if (!inv) return { fulfilled: false, note: 'Royalty invoice missing' };
    await tx.update(financeCollectionAttempts).set({ status: 'succeeded', updatedAt: new Date() }).where(eq(financeCollectionAttempts.paymentId, p.id));
    if (inv.status === 'paid') return { fulfilled: true, note: 'Invoice already paid' };
    if (p.currency !== inv.currency) return { fulfilled: false, note: `Payment in ${p.currency} for a ${inv.currency} invoice` };
    await applyPayment(tx, inv, p.providerAmountMinor ?? p.amountMinor);
    return { fulfilled: true, note: `Invoice ${inv.number} paid` };
  },
  async isRecorded(db: Exec, p: PaymentRow) {
    const [inv] = p.targetId ? await db.select().from(financeInvoices).where(eq(financeInvoices.id, p.targetId)) : [];
    return { ok: !!inv && inv.paidMinor > 0, expected: inv ? { amount: inv.totalMinor, currency: inv.currency } : null };
  },
};

paymentFailureHooks.push(async (tx, p) => {
  if (p.targetType !== 'royalty_invoice' || !p.targetId) return;
  const [att] = await tx.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.paymentId, p.id));
  await tx.update(financeCollectionAttempts).set({ status: 'failed', failureCode: att?.failureCode ?? 'payment_failed', updatedAt: new Date() }).where(eq(financeCollectionAttempts.paymentId, p.id));
  await tx.update(financeInvoices).set({ status: 'open', updatedAt: new Date() }).where(and(eq(financeInvoices.id, p.targetId), eq(financeInvoices.status, 'processing')));
});

/* Live mode: activate a mandate when Stripe confirms the SetupIntent on the collection account. */
stripeEventExtensions.push(async (tx, event, s) => {
  if (event.type !== 'setup_intent.succeeded' && event.type !== 'setup_intent.setup_failed') return null;
  const si = event.data.object as { id: string; metadata?: Record<string, string>; payment_method?: string | { id: string } | null };
  const pmId = si.metadata?.bh_finance_method;
  if (!pmId) return null;
  if (event.type === 'setup_intent.setup_failed') {
    await tx.update(financePaymentMethods).set({ status: 'failed', updatedAt: new Date() }).where(eq(financePaymentMethods.id, pmId));
    return { note: 'Royalty mandate setup failed', organizationId: si.metadata?.bh_org ?? null };
  }
  const methodId = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id;
  if (!methodId) return { note: 'Setup intent without payment method', organizationId: si.metadata?.bh_org ?? null };
  const [pm] = await tx.select().from(financePaymentMethods).where(eq(financePaymentMethods.id, pmId));
  const info = pm ? await collectionAdapter(s).retrieveSetupIntent({ accountId: pm.collectionAccountId, id: si.id }).catch(() => null) : null;
  await activate(tx, pmId, methodId, info?.display ?? {});
  return { note: 'Royalty mandate active', organizationId: si.metadata?.bh_org ?? null };
});

/* ------------------------------------------------------------------ */
/* Dunning                                                             */
/* ------------------------------------------------------------------ */

async function recordStep(db: Exec, inv: InvoiceRow, action: 'reminder' | 'retry' | 'late_fee' | 'final_notice', dayOffset: number, note: string) {
  const r = await db.insert(financeDunningEvents).values({ organizationId: inv.organizationId, invoiceId: inv.id, action, dayOffset, note }).onConflictDoNothing().returning({ id: financeDunningEvents.id });
  return r.length > 0;
}

async function notifyFranchisee(s: Services, inv: InvoiceRow, subject: string, text: string) {
  if (!inv.ownerGroupId) return;
  const rows = await s.db.select({ email: users.email }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAssignments.organizationId, inv.organizationId), eq(roleAssignments.scopeKind, 'owner_group'), eq(roleAssignments.scopeId, inv.ownerGroupId)));
  for (const r of rows) await s.mailer.send({ to: r.email, subject, text, tag: 'finance-dunning' }).catch((err) => s.log.warn({ err }, '[finance] dunning email failed'));
}

const fmt = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

/**
 * Runs dunning for an organisation on `todayLocal` (the organisation's local date). Every step is recorded once per
 * invoice and day offset, so the run is safe to repeat (e.g. hourly from a scheduler).
 */
export async function runDunning(s: Services, organizationId: string, todayLocal?: string) {
  const settings = await getFinanceSettings(s.db, organizationId);
  const day = todayLocal ?? today(await orgTimeZone(s.db, organizationId));
  const policy = settings.dunning;
  const open = await s.db.select().from(financeInvoices).where(and(eq(financeInvoices.organizationId, organizationId), inArray(financeInvoices.status, ['open', 'processing'])));
  const summary = { checked: open.length, reminders: 0, lateFees: 0, retries: 0, retriesFailed: 0, finalNotices: 0 };
  for (let inv of open) {
    if (outstanding(inv) <= 0) continue;
    const toDue = daysBetween(day, inv.dueDate);
    if (policy.reminderDaysBefore > 0 && toDue > 0 && toDue <= policy.reminderDaysBefore && inv.status === 'open') {
      if (await recordStep(s.db, inv, 'reminder', -policy.reminderDaysBefore, `Due ${inv.dueDate}`)) {
        summary.reminders++;
        await s.db.update(financeInvoices).set({ dunningStage: 'reminded' }).where(eq(financeInvoices.id, inv.id));
        await notifyFranchisee(s, inv, `Invoice ${inv.number} is due on ${inv.dueDate}`, `Invoice ${inv.number} for ${fmt(outstanding(inv), inv.currency)} is due on ${inv.dueDate}. It is available in BranchHarbor under Finance → Statements & invoices.`);
      }
    }
    const overdue = daysBetween(inv.dueDate, day);
    if (overdue <= 0) continue;
    // Late fee, once, per the agreement terms captured on the statement.
    if (!inv.lateFeeAppliedAt) {
      const [st] = await s.db.select({ terms: royaltyStatements.terms }).from(royaltyStatements).where(eq(royaltyStatements.id, inv.statementId));
      const feeTerms = ((st?.terms ?? {}) as { lateFee?: LateFeeTerms }).lateFee ?? { kind: 'none', graceDays: 0 };
      const fee = lateFeeFor(feeTerms, outstanding(inv), overdue);
      if (fee > 0 && (await recordStep(s.db, inv, 'late_fee', overdue, fmt(fee, inv.currency)))) {
        const [loc] = await s.db.select({ country: locations.country }).from(locations).where(eq(locations.id, inv.locationId));
        const feeLine = { kind: 'late_fee', description: 'late_fee', amountMinor: fee };
        const feeTaxes = invoiceTaxes([feeLine], settings.taxLines, loc?.country ?? '');
        const feeTax = feeTaxes.reduce((a, t) => a + t.amountMinor, 0);
        const mergedTaxes = [...inv.taxes];
        for (const t of feeTaxes) {
          const i = mergedTaxes.findIndex((x) => x.name === t.name && x.rateBps === t.rateBps);
          if (i >= 0) mergedTaxes[i] = { ...mergedTaxes[i]!, baseMinor: mergedTaxes[i]!.baseMinor + t.baseMinor, amountMinor: mergedTaxes[i]!.amountMinor + t.amountMinor };
          else mergedTaxes.push(t);
        }
        [inv] = await s.db.update(financeInvoices).set({
          lines: [...inv.lines, feeLine], taxes: mergedTaxes, lateFeeMinor: inv.lateFeeMinor + fee, taxMinor: inv.taxMinor + feeTax, totalMinor: inv.totalMinor + fee + feeTax,
          lateFeeAppliedAt: new Date(), updatedAt: new Date(),
        }).where(eq(financeInvoices.id, inv.id)).returning() as [InvoiceRow];
        summary.lateFees++;
        await audit(s.db, { organizationId, actorUserId: null, actorType: 'system', action: 'finance.late_fee_applied', scopeKind: 'location', scopeId: inv.locationId, targetType: 'finance_invoice', targetId: inv.id, metadata: { feeMinor: fee, taxMinor: feeTax, currency: inv.currency } });
      }
    }
    // Retries on the configured days after the due date (only the latest due step runs; earlier missed ones are recorded as skipped).
    const dueRetries = [...policy.retryDays].filter((d) => d <= overdue).sort((a, b) => a - b);
    const latest = dueRetries[dueRetries.length - 1];
    if (latest !== undefined && inv.status === 'open') {
      for (const d of dueRetries.slice(0, -1)) await recordStep(s.db, inv, 'retry', d, 'skipped (a later retry was due)');
      const method = inv.ownerGroupId ? await activeMethod(s.db, inv.ownerGroupId, inv.currency) : null;
      if (await recordStep(s.db, inv, 'retry', latest, method ? 'collection retried' : 'no active payment method')) {
        await s.db.update(financeInvoices).set({ dunningStage: 'retrying' }).where(eq(financeInvoices.id, inv.id));
        if (method) {
          summary.retries++;
          const att = await collectInvoice(s, organizationId, inv.id, { actorUserId: null, trigger: 'dunning' }).catch((err) => { s.log.warn({ err }, '[finance] dunning retry failed'); return null; });
          if (!att || att.status === 'failed') summary.retriesFailed++;
        }
      }
    }
    if (policy.finalNoticeAfterDays > 0 && overdue >= policy.finalNoticeAfterDays) {
      const [fresh] = await s.db.select().from(financeInvoices).where(eq(financeInvoices.id, inv.id));
      if (fresh && fresh.status !== 'paid' && (await recordStep(s.db, fresh, 'final_notice', policy.finalNoticeAfterDays, `Overdue ${overdue} days`))) {
        summary.finalNotices++;
        await s.db.update(financeInvoices).set({ dunningStage: 'final_notice' }).where(eq(financeInvoices.id, inv.id));
        await notifyFranchisee(s, fresh, `Final notice: invoice ${fresh.number} is overdue`, `Invoice ${fresh.number} for ${fmt(outstanding(fresh), fresh.currency)} was due on ${fresh.dueDate} and is ${overdue} days overdue. Please pay it in BranchHarbor or contact HQ finance.`);
      }
    }
  }
  await audit(s.db, { organizationId, actorUserId: null, actorType: 'system', action: 'finance.dunning_run', scopeKind: 'organization', scopeId: organizationId, metadata: { day, ...summary } });
  return { day, ...summary };
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export function invoiceState(inv: InvoiceRow, todayLocal: string): 'open' | 'processing' | 'paid' | 'void' | 'overdue' {
  if (inv.status === 'open' && daysBetween(inv.dueDate, todayLocal) > 0) return 'overdue';
  return inv.status as 'open' | 'processing' | 'paid' | 'void';
}

export function serializeInvoice(inv: InvoiceRow, todayLocal: string, dir?: { locations: Map<string, { name: string }>; groups: Map<string, { name: string }> }) {
  return {
    id: inv.id, number: inv.number, statementId: inv.statementId, location: { id: inv.locationId, name: dir?.locations.get(inv.locationId)?.name ?? null },
    ownerGroup: inv.ownerGroupId ? { id: inv.ownerGroupId, name: dir?.groups.get(inv.ownerGroupId)?.name ?? null } : null,
    currency: inv.currency, issueDate: inv.issueDate, dueDate: inv.dueDate, lines: inv.lines, taxes: inv.taxes, subtotalMinor: inv.subtotalMinor, taxMinor: inv.taxMinor,
    lateFeeMinor: inv.lateFeeMinor, totalMinor: inv.totalMinor, paidMinor: inv.paidMinor, outstandingMinor: outstanding(inv), status: inv.status, state: invoiceState(inv, todayLocal),
    daysOverdue: Math.max(0, daysBetween(inv.dueDate, todayLocal)), dunningStage: inv.dunningStage, paidAt: inv.paidAt?.toISOString() ?? null, createdAt: inv.createdAt.toISOString(),
  };
}

export async function invoiceHistory(db: Exec, invoiceId: string) {
  const attempts = await db.select().from(financeCollectionAttempts).where(eq(financeCollectionAttempts.invoiceId, invoiceId)).orderBy(asc(financeCollectionAttempts.attempt));
  const dunning = await db.select().from(financeDunningEvents).where(eq(financeDunningEvents.invoiceId, invoiceId)).orderBy(asc(financeDunningEvents.createdAt));
  return {
    attempts: attempts.map((a) => ({ id: a.id, attempt: a.attempt, method: a.method, status: a.status, amountMinor: a.amountMinor, currency: a.currency, failureCode: a.failureCode, failureMessage: a.failureMessage, reference: a.reference, createdAt: a.createdAt.toISOString() })),
    dunning: dunning.map((d) => ({ id: d.id, action: d.action, dayOffset: d.dayOffset, note: d.note, createdAt: d.createdAt.toISOString() })),
  };
}

export { orgTimeZone };
