/**
 * DEMO SITE ONLY — Finance workspace demo data for the demo franchisor accounts (called from seed-demo.ts after
 * seed-northlight.ts). Sample data only, sandbox payments only.
 *
 * Northlight Yoga International:
 * - a finance lead login (Finance role) and royalty terms: organisation defaults in CAD and USD, Thames Hot Yoga's own
 *   GBP terms with a minimum and a late fee; no tax lines (HQ has not configured any — BranchHarbor never invents tax);
 * - four months of class sales at the franchised studios; the three oldest closed monthly in each studio's time zone,
 *   the last full month left open for HQ to close;
 * - the oldest month invoiced and collected (card and bank debit mandates), the next month invoiced with one overdue
 *   invoice (declined bank debit, late fee and dunning history), the last month with one disputed statement;
 * - an accepted external-POS sales report with evidence, network campaigns with fund spend and receipts, sandbox payouts.
 * Stillwater Yoga Collective: terms per currency and one closed, approved month.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import type { Services } from '../context.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { renderPdf } from '../lib/pdf.ts';
import { DEFAULT_BASIS, periodContaining } from '../domain/royalty.ts';
import { approveStatement, closePeriod, raiseDispute, reviewExternalSales, submitExternalSales } from '../services/finance/statements.ts';
import { confirmSandboxMethod, issueInvoice, runDunning, settleSandboxCollection, startPaymentMethodSetup } from '../services/finance/invoices.ts';
import { createCampaign, fundBalances, recordSpend } from '../services/finance/fund.ts';
import { syncPayouts } from '../services/finance/payouts.ts';
import { getFinanceSettings } from '../services/finance/terms.ts';

type User = typeof t.users.$inferSelect;

export interface FinanceSeedInput {
  db: Db;
  today: string;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
}

/** The services the finance functions need, in sandbox mode (no Stripe, no email). */
function sandboxServices(db: Db): Services {
  const noop = () => {};
  return {
    db,
    payments: { mode: 'sandbox', client: null, publishableKey: null },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    mailer: { mode: 'log', outbox: [], send: async () => ({ id: null, delivered: false }) },
  } as unknown as Services;
}

const receiptPdf = (lines: string[]) => renderPdf([{ texts: lines.map((text, i) => ({ x: 50, y: 790 - i * 16, text, size: i === 0 ? 14 : 10, bold: i === 0 })) }], { title: lines[0] ?? 'Receipt' }).toString('base64');

/** Past class sales for a location in [from, to) local dates: real occurrences, bookings and settled payments. */
async function seedSales(db: Db, orgId: string, loc: typeof t.locations.$inferSelect, from: string, to: string, perClass: number) {
  const [type] = await db.select().from(t.classTypes).where(eq(t.classTypes.organizationId, orgId)).limit(1);
  const custs = await db.select().from(t.customers).where(and(eq(t.customers.organizationId, orgId), eq(t.customers.locationId, loc.id)));
  if (!type || !custs.length) return 0;
  const price: Record<string, number> = { CAD: 2600, USD: 2400, GBP: 1700, EUR: 1900, AUD: 2900 };
  let n = 0;
  for (let day = from, i = 0; day < to; day = addDays(day, 1), i++) {
    if (i % 2 === 1) continue; // every other day keeps the demo light
    const startsAt = zonedToUtc(day, '18:00', loc.timeZone);
    const [occ] = await db.insert(t.classOccurrences).values({
      organizationId: orgId, locationId: loc.id, classTypeId: type.id, startsAt, endsAt: new Date(startsAt.getTime() + type.durationMinutes * 60_000), capacity: type.defaultCapacity,
      priceMinor: price[loc.currency] ?? 2000, currency: loc.currency, instructorName: 'Sofia Lindqvist', room: 'Hot room',
    }).returning();
    for (const c of custs.slice(0, perClass + (i % 3))) {
      const paidAt = new Date(startsAt.getTime() - 26 * 3600_000);
      const [b] = await db.insert(t.classBookings).values({ organizationId: orgId, locationId: loc.id, occurrenceId: occ!.id, customerId: c.id, status: 'attended', confirmedAt: paidAt, source: 'web' }).returning();
      const [p] = await db.insert(t.paymentReferences).values({
        organizationId: orgId, locationId: loc.id, provider: 'stripe', externalId: `pi_seed_fin_${randomBytes(8).toString('hex')}`, connectedAccountId: loc.stripeAccountId, amountMinor: occ!.priceMinor,
        currency: loc.currency, applicationFeeMinor: Math.floor(occ!.priceMinor / 100), state: 'succeeded', succeededAt: paidAt, createdAt: paidAt, targetType: 'class_booking', targetId: b!.id, sandbox: 1,
      }).returning();
      await db.update(t.classBookings).set({ paymentId: p!.id }).where(eq(t.classBookings.id, b!.id));
      n++;
    }
  }
  return n;
}

/** Backdates an invoice as if it had been issued `issueDate` (demo history). */
async function backdate(db: Db, invoiceId: string, issueDate: string, termsDays: number) {
  await db.update(t.financeInvoices).set({ issueDate, dueDate: addDays(issueDate, termsDays), createdAt: zonedToUtc(issueDate, '09:00', 'UTC') }).where(eq(t.financeInvoices.id, invoiceId));
}

export async function seedFinance({ db, today, upsertUser }: FinanceSeedInput) {
  const s = sandboxServices(db);
  const logins: string[] = [];
  const [nl] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'northlight-yoga'));
  if (nl) logins.push(...(await seedNorthlightFinance(s, db, nl, today, upsertUser)));
  const [sw] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'stillwater-yoga'));
  if (sw) await seedStillwaterFinance(s, db, sw, today);
  return { logins };
}

async function seedNorthlightFinance(s: Services, db: Db, org: typeof t.organizations.$inferSelect, today: string, upsertUser: FinanceSeedInput['upsertUser']) {
  const orgId = org.id;
  const ceo = (await db.select().from(t.users).where(eq(t.users.email, 'elena.marsh@northlight.demo.branchharbor.com')))[0]!;
  const finance = await upsertUser('ruth.adeyemi@northlight.demo.branchharbor.com', 'Ruth Adeyemi');
  await db.insert(t.roleAssignments).values({ organizationId: orgId, userId: finance.id, role: 'finance', scopeKind: 'organization', scopeId: orgId, createdBy: ceo.id }).onConflictDoNothing();
  const groups = await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.organizationId, orgId));
  const g = (name: string) => groups.find((x) => x.name.startsWith(name))!;
  const pacific = g('Pacific'), rose = g('Rose'), thames = g('Thames');
  const owner = async (local: string) => (await db.select().from(t.users).where(eq(t.users.email, `${local}@northlight.demo.branchharbor.com`)))[0]!;
  const liam = await owner('liam.oconnor'), ava = await owner('ava.thompson'), oliver = await owner('oliver.grant');

  await getFinanceSettings(db, orgId);
  await db.update(t.financeSettings).set({
    periodFrequency: 'monthly', invoicePrefix: 'NLY', paymentTermsDays: 10, autoCollect: true, collectionAccountId: 'acct_sandbox_nl_royalties',
    dunning: { retryDays: [3, 7], reminderDaysBefore: 3, finalNoticeAfterDays: 14 },
    issuerDetails: { legalName: 'Northlight Yoga International Inc.', address: '488 Bloor St W, Toronto ON M5S 1Y2, Canada', email: 'finance@northlight.demo.branchharbor.com' },
  }).where(eq(t.financeSettings.organizationId, orgId));
  const year = today.slice(0, 4);
  await db.insert(t.royaltyTerms).values([
    { organizationId: orgId, currency: 'CAD', effectiveFrom: `${Number(year) - 1}-01-01`, royaltyBps: 600, marketingFundBps: 200, technologyFeeMinor: 14_900, basis: DEFAULT_BASIS, lateFee: { kind: 'percent', bps: 150, graceDays: 5 }, notes: 'Network standard terms', createdBy: finance.id },
    { organizationId: orgId, currency: 'USD', effectiveFrom: `${Number(year) - 1}-01-01`, royaltyBps: 600, marketingFundBps: 200, technologyFeeMinor: 12_900, basis: DEFAULT_BASIS, lateFee: { kind: 'percent', bps: 150, graceDays: 5 }, notes: 'Network standard terms (US)', createdBy: finance.id },
    { organizationId: orgId, ownerGroupId: thames.id, currency: 'GBP', effectiveFrom: `${Number(year) - 1}-01-01`, royaltyBps: 550, tiers: [{ fromMinor: 0, bps: 550 }, { fromMinor: 1_000_000, bps: 450 }], minimumRoyaltyMinor: 25_000, marketingFundBps: 200, technologyFeeMinor: 9_900, basis: DEFAULT_BASIS, lateFee: { kind: 'flat', flatMinor: 2_500, graceDays: 5 }, notes: 'UK master-franchise terms: tiered royalty with a monthly minimum', createdBy: finance.id },
  ]);

  // Four full months before the current one, in every studio's own time zone. The three oldest are closed below; the
  // last full month is left open so HQ finance can close it in the demo.
  const months: string[] = [];
  let cursor = periodContaining('monthly', today).startDate;
  for (let i = 0; i < 4; i++) {
    cursor = periodContaining('monthly', addDays(cursor, -1)).startDate;
    months.unshift(cursor);
  }
  const locs = (await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId))).filter((l) => l.status === 'operating');
  for (const loc of locs) await seedSales(db, orgId, loc, months[0]!, periodContaining('monthly', months[3]!).endDate, loc.ownerGroupId === thames.id ? 7 : 5);
  const portland = locs.find((l) => l.code === 'PDX-PR')!;
  const kits = locs.find((l) => l.code === 'YVR-KT')!;

  // Mandates: Pacific by card (CAD), Rose City by ACH (USD), Thames by Bacs (GBP) — Thames' bank declines later.
  const mandate = async (groupId: string, currency: string, methodType: 'card' | 'us_bank_account' | 'bacs_debit', userId: string, outcome: 'ok' | 'decline') => {
    const m = await startPaymentMethodSetup(s, orgId, { ownerGroupId: groupId, currency, methodType, acceptMandate: true }, { userId, ip: null });
    return confirmSandboxMethod(s, orgId, m.id, outcome, userId);
  };
  await mandate(pacific.id, 'CAD', 'card', liam.id, 'ok');
  await mandate(rose.id, 'USD', 'us_bank_account', ava.id, 'ok');
  const thamesOk = await mandate(thames.id, 'GBP', 'bacs_debit', oliver.id, 'ok');

  // Portland also runs a till outside BranchHarbor: an accepted sales report with evidence for the middle month.
  const csv = Buffer.from(`date,gross,refunds,tax\n${months[1]},1840.00,25.00,0.00\n`).toString('base64');
  const report = await submitExternalSales(s, orgId, { locationId: portland.id, periodStart: months[1]!, grossMinor: 184_000, refundsMinor: 2_500, taxMinor: 0, note: 'Retail till (Square) — monthly Z-report export', evidence: { filename: 'portland-pos-export.csv', contentType: 'text/csv', dataBase64: csv } }, ava.id);
  await reviewExternalSales(s, orgId, report.id, { decision: 'accepted', note: 'Matches the till export' }, finance.id);

  const statementsOf = async (periodId: string) => db.select().from(t.royaltyStatements).where(eq(t.royaltyStatements.periodId, periodId));
  const close = async (start: string) => (await closePeriod(s, orgId, start, finance.id)).period;

  // Month 1: approved, invoiced and collected.
  const p1 = await close(months[0]!);
  for (const st of await statementsOf(p1.id)) {
    await approveStatement(s, orgId, st.id, finance.id);
    const { invoice } = await issueInvoice(s, orgId, st.id, finance.id);
    if (invoice.status === 'processing') await settleSandboxCollection(s, orgId, invoice.id, 'succeeded');
    await backdate(db, invoice.id, addDays(p1.endDate, 2), 10);
  }

  // Month 2: invoiced; Thames' bank debit fails and the invoice goes overdue with dunning history.
  await db.update(t.financePaymentMethods).set({ status: 'revoked' }).where(eq(t.financePaymentMethods.id, thamesOk.id));
  await mandate(thames.id, 'GBP', 'bacs_debit', oliver.id, 'decline');
  const p2 = await close(months[1]!);
  for (const st of await statementsOf(p2.id)) {
    await approveStatement(s, orgId, st.id, finance.id);
    const { invoice } = await issueInvoice(s, orgId, st.id, finance.id);
    if (invoice.status === 'processing') await settleSandboxCollection(s, orgId, invoice.id, 'succeeded');
    await backdate(db, invoice.id, addDays(p2.endDate, 2), 10);
  }
  // Dunning on today's date: late fee, the latest retry (declined again) and the final notice for Thames.
  await runDunning(s, orgId, today);

  // Month 3: closed; Vancouver Main approved, Kitsilano disputed by its franchise owner, the others in draft.
  const p3 = await close(months[2]!);
  for (const st of await statementsOf(p3.id)) {
    if (st.locationId === kits.id) {
      await raiseDispute(s, orgId, st.id, { reason: 'Two classes on the 14th were community classes (pay what you can) and should not carry the full royalty.' }, liam.id);
    } else if (st.ownerGroupId === pacific.id) {
      await approveStatement(s, orgId, st.id, finance.id);
    }
  }

  // Marketing fund: network campaigns paid from contributions, each with a receipt.
  const intro = await createCampaign(s, orgId, { name: 'Autumn intro month', description: 'Paid social and search for the intro month offer across all studios.' }, finance.id);
  const video = await createCampaign(s, orgId, { name: 'Brand video', description: 'A short brand film used on every studio website.' }, finance.id);
  const balances = await fundBalances(db, orgId);
  const spendDate = addDays(months[2]!, 5);
  for (const b of balances) {
    if (b.balanceMinor < 1_000) continue;
    const first = Math.floor(b.balanceMinor * 0.4);
    const second = Math.floor(b.balanceMinor * 0.25);
    await recordSpend(s, orgId, { currency: b.currency, amountMinor: first, campaignId: intro.id, description: 'Paid social — intro month flight', vendor: 'Social ad network', occurredOn: spendDate, receipt: { filename: `receipt-social-${b.currency.toLowerCase()}.pdf`, contentType: 'application/pdf', dataBase64: receiptPdf(['Receipt — paid social', `Amount: ${(first / 100).toFixed(2)} ${b.currency}`, `Date: ${spendDate}`, 'Sample receipt (demo data)']) } }, finance.id);
    await recordSpend(s, orgId, { currency: b.currency, amountMinor: second, campaignId: video.id, description: 'Brand video edit and licences', vendor: 'Studio North Films', occurredOn: addDays(spendDate, 3), receipt: { filename: `receipt-video-${b.currency.toLowerCase()}.pdf`, contentType: 'application/pdf', dataBase64: receiptPdf(['Receipt — brand video', `Amount: ${(second / 100).toFixed(2)} ${b.currency}`, `Date: ${addDays(spendDate, 3)}`, 'Sample receipt (demo data)']) } }, finance.id);
  }

  await syncPayouts(s, orgId, finance.id);
  return [finance.email];
}

async function seedStillwaterFinance(s: Services, db: Db, org: typeof t.organizations.$inferSelect, today: string) {
  const orgId = org.id;
  const [owner] = await db.select().from(t.users).where(eq(t.users.email, 'demo@branchharbor.com'));
  await getFinanceSettings(db, orgId);
  await db.update(t.financeSettings).set({ invoicePrefix: 'SWY', collectionAccountId: 'acct_sandbox_sw_royalties', issuerDetails: { legalName: 'Stillwater Yoga Collective Ltd.' } }).where(eq(t.financeSettings.organizationId, orgId));
  const year = Number(today.slice(0, 4)) - 1;
  await db.insert(t.royaltyTerms).values((['CAD', 'USD', 'GBP', 'EUR', 'AUD'] as const).map((currency) => ({
    organizationId: orgId, currency, effectiveFrom: `${year}-01-01`, royaltyBps: 500, marketingFundBps: 150, technologyFeeMinor: currency === 'GBP' ? 7_900 : 9_900, basis: DEFAULT_BASIS, createdBy: owner?.id ?? null,
  })));
  const prev = periodContaining('monthly', addDays(periodContaining('monthly', today).startDate, -1)).startDate;
  const locs = (await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId))).filter((l) => l.status === 'operating' && l.ownerGroupId);
  for (const loc of locs) await seedSales(db, orgId, loc, prev, periodContaining('monthly', prev).endDate, 4);
  if (!owner) return;
  const { period } = await closePeriod(s, orgId, prev, owner.id);
  const sts = await db.select().from(t.royaltyStatements).where(and(eq(t.royaltyStatements.periodId, period.id), inArray(t.royaltyStatements.status, ['draft'])));
  for (const st of sts.slice(0, 2)) await approveStatement(s, orgId, st.id, owner.id);
}
