/**
 * Monthly royalty statements per franchisee (owner group) and currency: one document per period that rolls up the
 * location statements and their invoices — gross sales and where they came from, rate, royalty, marketing fund
 * contribution, adjustments, fees, tax, amount, collection method, status and date — plus BranchHarbor's collection
 * fee, which HQ pays (shown for transparency, never added to what the franchisee owes). Issued by HQ for a closed
 * period, emailed to the franchise owners, viewable in the app and as a PDF.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Services } from '../../context.ts';
import type { Exec } from '../../db/client.ts';
import {
  financeCollectionAttempts, financeInvoices, financePaymentMethods, franchiseeStatements, organizations, ownerGroups, roleAssignments, royaltyPeriods, royaltyStatements, users,
} from '../../db/schema/index.ts';
import type { FranchiseeStatementLine } from '../../db/schema/finance.ts';
import { notFound } from '../../lib/errors.ts';
import { renderPdf, type PdfLine, type PdfText } from '../../lib/pdf.ts';
import { audit } from '../audit.ts';
import { major } from './exports.ts';
import { directory } from './statements.ts';
import { getFinanceSettings } from './terms.ts';

export type FranchiseeStatementRow = typeof franchiseeStatements.$inferSelect;

const salesSource = (gross: number, external: number): FranchiseeStatementLine['salesSource'] =>
  gross > 0 && external > 0 ? 'mixed' : external > 0 ? 'external_pos' : gross > 0 ? 'branchharbor' : 'none';

/** Builds (or refreshes) the statements of a period, one per owner group and currency; emails new ones. */
export async function issueFranchiseeStatements(s: Services, organizationId: string, periodId: string, actorUserId: string, opts: { email?: boolean } = {}) {
  const [period] = await s.db.select().from(royaltyPeriods).where(and(eq(royaltyPeriods.id, periodId), eq(royaltyPeriods.organizationId, organizationId)));
  if (!period) throw notFound('Period');
  const dir = await directory(s.db, organizationId);
  const stmts = (await s.db.select().from(royaltyStatements).where(and(eq(royaltyStatements.periodId, periodId), ne(royaltyStatements.status, 'void')))).filter((x) => x.ownerGroupId);
  const invoices = stmts.length ? await s.db.select().from(financeInvoices).where(inArray(financeInvoices.statementId, stmts.map((x) => x.id))) : [];
  const attempts = invoices.length ? await s.db.select().from(financeCollectionAttempts).where(inArray(financeCollectionAttempts.invoiceId, invoices.map((i) => i.id))).orderBy(asc(financeCollectionAttempts.attempt)) : [];
  const settings = await getFinanceSettings(s.db, organizationId);
  const groups = new Map<string, typeof stmts>();
  for (const st of stmts) groups.set(`${st.ownerGroupId}|${st.currency}`, [...(groups.get(`${st.ownerGroupId}|${st.currency}`) ?? []), st]);
  const out: FranchiseeStatementRow[] = [];
  const emailed: string[] = [];
  for (const [key, list] of groups) {
    const [ownerGroupId, currency] = key.split('|') as [string, string];
    const lines: FranchiseeStatementLine[] = list.map((st) => {
      const inv = invoices.find((i) => i.statementId === st.id) ?? null;
      const atts = inv ? attempts.filter((a) => a.invoiceId === inv.id) : [];
      const last = atts[atts.length - 1] ?? null;
      const terms = (st.terms ?? {}) as { royaltyBps?: number; marketingFundBps?: number };
      const taxMinor = inv?.taxMinor ?? 0;
      const lateFeeMinor = inv?.lateFeeMinor ?? 0;
      return {
        locationId: st.locationId, locationName: dir.locations.get(st.locationId)?.name ?? '', salesSource: salesSource(st.grossSalesMinor, st.externalSalesMinor),
        grossSalesMinor: st.grossSalesMinor + st.externalSalesMinor, basisMinor: st.basisMinor, royaltyRateBps: terms.royaltyBps ?? null, royaltyMinor: st.royaltyMinor,
        marketingFundRateBps: terms.marketingFundBps ?? null, marketingFundMinor: st.marketingFundMinor, technologyFeeMinor: st.technologyFeeMinor, adjustmentsMinor: st.adjustmentsMinor,
        taxMinor, lateFeeMinor, totalMinor: inv ? inv.totalMinor : st.totalMinor,
        invoiceId: inv?.id ?? null, invoiceNumber: inv?.number ?? null, invoiceStatus: inv?.status ?? null, dueDate: inv?.dueDate ?? null,
        collectionMethod: last?.methodType ?? (last?.method === 'manual' ? 'manual' : null), collectionStatus: last?.status ?? null,
        collectionDate: (last?.settledAt ?? last?.createdAt)?.toISOString().slice(0, 10) ?? null, collectedMinor: inv?.paidMinor ?? 0,
        collectionFeeMinor: atts.reduce((a, x) => a + x.platformFeeMinor, 0),
      };
    }).sort((a, b) => a.locationName.localeCompare(b.locationName));
    const sum = (k: keyof FranchiseeStatementLine) => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
    const [pm] = await s.db.select().from(financePaymentMethods).where(and(eq(financePaymentMethods.ownerGroupId, ownerGroupId), eq(financePaymentMethods.currency, currency), eq(financePaymentMethods.status, 'active'))).orderBy(desc(financePaymentMethods.updatedAt)).limit(1);
    const values = {
      organizationId, periodId, ownerGroupId, currency, number: `${settings.invoicePrefix}-ST-${period.startDate.slice(0, 7).replace('-', '')}-${ownerGroupId.slice(0, 4).toUpperCase()}${currency}`,
      lines, grossSalesMinor: sum('grossSalesMinor'), royaltyMinor: sum('royaltyMinor'), marketingFundMinor: sum('marketingFundMinor'), adjustmentsMinor: sum('adjustmentsMinor'),
      feesMinor: sum('technologyFeeMinor') + sum('lateFeeMinor'), taxMinor: sum('taxMinor'), totalMinor: sum('totalMinor'), collectedMinor: sum('collectedMinor'), collectionFeeMinor: sum('collectionFeeMinor'),
      paymentMethod: pm ? { methodType: pm.methodType, last4: pm.display.last4 ?? null, bankName: pm.display.bankName ?? null } : null, issuedBy: actorUserId,
    };
    const [existing] = await s.db.select().from(franchiseeStatements).where(and(eq(franchiseeStatements.periodId, periodId), eq(franchiseeStatements.ownerGroupId, ownerGroupId), eq(franchiseeStatements.currency, currency)));
    const [row] = existing
      ? await s.db.update(franchiseeStatements).set({ ...values, updatedAt: new Date() }).where(eq(franchiseeStatements.id, existing.id)).returning()
      : await s.db.insert(franchiseeStatements).values(values).returning();
    if (!existing && opts.email !== false) emailed.push(...(await emailStatement(s, row!, period)));
    out.push((await s.db.select().from(franchiseeStatements).where(eq(franchiseeStatements.id, row!.id)))[0]!);
  }
  await audit(s.db, { organizationId, actorUserId, action: 'finance.franchisee_statements_issued', scopeKind: 'organization', scopeId: organizationId, metadata: { periodId, statements: out.length, emailed: emailed.length } });
  return { items: out, emailed: emailed.length };
}

const LABEL: Record<string, string> = { card: 'Card', us_bank_account: 'ACH bank debit', acss_debit: 'Pre-authorised debit (PAD)', bacs_debit: 'Bacs Direct Debit', sepa_debit: 'SEPA Direct Debit', au_becs_debit: 'BECS Direct Debit', manual: 'Bank transfer (recorded)' };
const periodLabel = (p: { startDate: string; endDate: string }) => new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${p.startDate}T12:00:00Z`));

async function emailStatement(s: Services, row: FranchiseeStatementRow, period: { startDate: string; endDate: string }) {
  const people = await s.db.select({ email: users.email }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAssignments.organizationId, row.organizationId), eq(roleAssignments.scopeKind, 'owner_group'), eq(roleAssignments.scopeId, row.ownerGroupId)));
  const to = [...new Set(people.map((p) => p.email))];
  const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, row.organizationId));
  const m = (v: number) => `${major(v, row.currency)} ${row.currency}`;
  const link = `${s.cfg.APP_URL.replace(/\/$/, '')}/finance/statements?tab=monthly&statement=${row.id}`;
  for (const email of to) {
    await s.mailer.send({
      to: email, tag: 'finance-statement',
      subject: `${org?.name ?? 'Royalty'} statement ${periodLabel(period)} (${row.number})`,
      text: [`Your royalty statement for ${periodLabel(period)} is ready.`, '', `Gross sales: ${m(row.grossSalesMinor)}`, `Royalty: ${m(row.royaltyMinor)}`, `Marketing fund: ${m(row.marketingFundMinor)}`,
        `Adjustments: ${m(row.adjustmentsMinor)}`, `Total: ${m(row.totalMinor)}`, `Collected so far: ${m(row.collectedMinor)}`, '', `View it and download the PDF: ${link}`].join('\n'),
    }).catch((err) => s.log.warn({ err }, '[finance] statement email failed'));
  }
  await s.db.update(franchiseeStatements).set({ emailedAt: to.length ? new Date() : null, emailedTo: to }).where(eq(franchiseeStatements.id, row.id));
  return to;
}

export async function serializeFranchiseeStatement(db: Exec, row: FranchiseeStatementRow) {
  const [period] = await db.select().from(royaltyPeriods).where(eq(royaltyPeriods.id, row.periodId));
  const [g] = await db.select({ name: ownerGroups.name, legalName: ownerGroups.legalName }).from(ownerGroups).where(eq(ownerGroups.id, row.ownerGroupId));
  return {
    id: row.id, number: row.number, period: period ? { startDate: period.startDate, endDate: period.endDate, frequency: period.frequency } : null, ownerGroup: { id: row.ownerGroupId, name: g?.name ?? null, legalName: g?.legalName ?? null },
    currency: row.currency, lines: row.lines, grossSalesMinor: row.grossSalesMinor, royaltyMinor: row.royaltyMinor, marketingFundMinor: row.marketingFundMinor, adjustmentsMinor: row.adjustmentsMinor,
    feesMinor: row.feesMinor, taxMinor: row.taxMinor, totalMinor: row.totalMinor, collectedMinor: row.collectedMinor, collectionFeeMinor: row.collectionFeeMinor, paymentMethod: row.paymentMethod,
    issuedAt: row.issuedAt.toISOString(), emailedAt: row.emailedAt?.toISOString() ?? null, emailedTo: row.emailedTo.length,
  };
}

/** Statement PDF (English; amounts in the statement currency only, never converted). */
export async function franchiseeStatementPdf(db: Exec, row: FranchiseeStatementRow): Promise<Buffer> {
  const v = await serializeFranchiseeStatement(db, row);
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, row.organizationId));
  const settings = await getFinanceSettings(db, row.organizationId);
  const issuer = settings.issuerDetails ?? {};
  const m = (x: number) => `${major(x, row.currency)}`;
  const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
  const t: PdfText[] = [];
  const lines: PdfLine[] = [];
  let y = 800;
  t.push({ x: 40, y, text: issuer.legalName || org?.name || '', size: 15, bold: true });
  t.push({ x: 555, y, text: 'ROYALTY STATEMENT', size: 13, bold: true, align: 'right' });
  y -= 16;
  for (const l of [issuer.address, issuer.taxNumber ? `Tax number: ${issuer.taxNumber}` : null].filter(Boolean) as string[]) { t.push({ x: 40, y, text: l, size: 8 }); y -= 11; }
  let ry = 784;
  for (const [k, val] of [['Statement', row.number], ['Period', v.period ? periodLabel(v.period) : ''], ['Currency', row.currency], ['Issued', v.issuedAt.slice(0, 10)]] as const) {
    t.push({ x: 420, y: ry, text: k, size: 8 });
    t.push({ x: 555, y: ry, text: val, size: 8, bold: true, align: 'right' });
    ry -= 11;
  }
  y = Math.min(y, ry) - 16;
  t.push({ x: 40, y, text: 'Franchisee', size: 8, bold: true });
  y -= 12;
  t.push({ x: 40, y, text: v.ownerGroup.legalName || v.ownerGroup.name || '', size: 10 });
  y -= 22;
  // Per-location table (amounts in currency units).
  const cols: Array<[string, number, 'left' | 'right']> = [['Location / source', 40, 'left'], ['Gross sales', 210, 'right'], ['Rate', 248, 'right'], ['Royalty', 300, 'right'], ['Fund', 350, 'right'], ['Adj.', 390, 'right'], ['Fees+tax', 440, 'right'], ['Amount', 495, 'right'], ['Collected', 555, 'right']];
  for (const [h, x, align] of cols) t.push({ x, y, text: h, size: 7.5, bold: true, align });
  y -= 5;
  lines.push({ x1: 40, y1: y, x2: 555, y2: y });
  y -= 11;
  for (const l of row.lines) {
    if (y < 120) break;
    const src = { branchharbor: 'BranchHarbor payments', external_pos: 'External POS (reported)', mixed: 'BranchHarbor + external POS', none: 'No sales' }[l.salesSource];
    t.push({ x: 40, y, text: l.locationName.slice(0, 34), size: 8.5 });
    t.push({ x: 210, y, text: m(l.grossSalesMinor), size: 8.5, align: 'right' });
    t.push({ x: 248, y, text: pct(l.royaltyRateBps), size: 8.5, align: 'right' });
    t.push({ x: 300, y, text: m(l.royaltyMinor), size: 8.5, align: 'right' });
    t.push({ x: 350, y, text: m(l.marketingFundMinor), size: 8.5, align: 'right' });
    t.push({ x: 390, y, text: m(l.adjustmentsMinor), size: 8.5, align: 'right' });
    t.push({ x: 440, y, text: m(l.technologyFeeMinor + l.lateFeeMinor + l.taxMinor), size: 8.5, align: 'right' });
    t.push({ x: 495, y, text: m(l.totalMinor), size: 8.5, bold: true, align: 'right' });
    t.push({ x: 555, y, text: m(l.collectedMinor), size: 8.5, align: 'right' });
    y -= 10;
    const coll = l.collectionStatus ? `${LABEL[l.collectionMethod ?? ''] ?? l.collectionMethod ?? ''} · ${l.collectionStatus}${l.collectionDate ? ` · ${l.collectionDate}` : ''}` : 'Not collected yet';
    t.push({ x: 48, y, text: `${src}${l.invoiceNumber ? ` · Invoice ${l.invoiceNumber}${l.dueDate ? ` due ${l.dueDate}` : ''}` : ''} · Fund ${pct(l.marketingFundRateBps)} · ${coll}`, size: 7 });
    y -= 14;
  }
  lines.push({ x1: 40, y1: y + 6, x2: 555, y2: y + 6 });
  y -= 6;
  const row2 = (k: string, val: string, bold = false) => { t.push({ x: 330, y, text: k, size: 9, bold }); t.push({ x: 555, y, text: val, size: 9, bold, align: 'right' }); y -= 13; };
  row2('Gross sales', `${m(row.grossSalesMinor)} ${row.currency}`);
  row2('Royalty', `${m(row.royaltyMinor)} ${row.currency}`);
  row2('Marketing fund contribution', `${m(row.marketingFundMinor)} ${row.currency}`);
  row2('Adjustments', `${m(row.adjustmentsMinor)} ${row.currency}`);
  row2('Fees', `${m(row.feesMinor)} ${row.currency}`);
  row2('Tax', row.taxMinor ? `${m(row.taxMinor)} ${row.currency}` : 'Not applied');
  row2('Total', `${m(row.totalMinor)} ${row.currency}`, true);
  row2('Collected', `${m(row.collectedMinor)} ${row.currency}`);
  row2('Outstanding', `${m(row.totalMinor - row.collectedMinor)} ${row.currency}`, true);
  y -= 10;
  const pm = row.paymentMethod;
  t.push({ x: 40, y, text: pm ? `Collection method on file: ${LABEL[pm.methodType] ?? pm.methodType}${pm.bankName ? `, ${pm.bankName}` : ''}${pm.last4 ? ` ending ${pm.last4}` : ''}.` : 'No debit authorisation on file: pay invoices in BranchHarbor under Finance.', size: 8 });
  y -= 11;
  t.push({ x: 40, y, text: `BranchHarbor collection fee for this period: ${m(row.collectionFeeMinor)} ${row.currency} — paid by the franchisor, not added to your amount due.`, size: 8 });
  y -= 11;
  t.push({ x: 40, y, text: 'Tax lines are shown only as configured by the franchisor; BranchHarbor does not determine tax. Amounts are never converted between currencies.', size: 8 });
  return renderPdf([{ texts: t, lines }], { title: `Royalty statement ${row.number}` });
}
