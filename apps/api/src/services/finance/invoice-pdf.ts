/** Invoice PDF (English; amounts in the invoice currency only). */
import { renderPdf, type PdfText, type PdfLine } from '../../lib/pdf.ts';
import type { financeInvoices, royaltyPeriods, royaltyStatements } from '../../db/schema/index.ts';
import { major } from './exports.ts';
import type { FinanceSettingsRow } from './terms.ts';

const LABEL: Record<string, string> = { royalty: 'Royalty', marketing_fund: 'Marketing fund contribution', technology_fee: 'Technology fee', adjustment: 'Adjustment', late_fee: 'Late fee' };

export function invoicePdf(input: {
  invoice: typeof financeInvoices.$inferSelect;
  statement: typeof royaltyStatements.$inferSelect;
  period: typeof royaltyPeriods.$inferSelect | undefined;
  orgName: string;
  settings: FinanceSettingsRow;
  billTo: { name: string; legalName: string | null };
  locationName: string;
}): Buffer {
  const { invoice: inv, statement: st, period, settings } = input;
  const m = (v: number) => `${major(v, inv.currency)} ${inv.currency}`;
  const t: PdfText[] = [];
  const lines: PdfLine[] = [];
  let y = 790;
  const issuer = settings.issuerDetails ?? {};
  t.push({ x: 50, y, text: issuer.legalName || input.orgName, size: 16, bold: true });
  t.push({ x: 545, y, text: 'INVOICE', size: 16, bold: true, align: 'right' });
  y -= 18;
  for (const l of [issuer.address, issuer.taxNumber ? `Tax number: ${issuer.taxNumber}` : null, issuer.email].filter(Boolean) as string[]) {
    t.push({ x: 50, y, text: l, size: 9 });
    y -= 12;
  }
  let ry = 772;
  for (const [k, v] of [['Invoice number', inv.number], ['Issue date', inv.issueDate], ['Due date', inv.dueDate], ['Currency', inv.currency]] as const) {
    t.push({ x: 430, y: ry, text: k, size: 9 });
    t.push({ x: 545, y: ry, text: v, size: 9, bold: true, align: 'right' });
    ry -= 12;
  }
  y = Math.min(y, ry) - 20;
  t.push({ x: 50, y, text: 'Bill to', size: 9, bold: true });
  y -= 13;
  t.push({ x: 50, y, text: input.billTo.legalName || input.billTo.name, size: 11 });
  y -= 13;
  t.push({ x: 50, y, text: `Location: ${input.locationName}`, size: 9 });
  y -= 12;
  if (period) t.push({ x: 50, y, text: `Period: ${period.startDate} to ${period.endDate} (${st.timeZone}), ${period.frequency}`, size: 9 });
  y -= 28;
  t.push({ x: 50, y, text: 'Description', size: 9, bold: true });
  t.push({ x: 545, y, text: 'Amount', size: 9, bold: true, align: 'right' });
  y -= 6;
  lines.push({ x1: 50, y1: y, x2: 545, y2: y });
  y -= 14;
  for (const l of inv.lines) {
    const desc = l.kind === 'royalty' ? `Royalty on ${m(st.basisMinor)} net sales` : l.kind === 'marketing_fund' ? `Marketing fund on ${m(st.basisMinor)} net sales` : LABEL[l.kind] ?? l.kind;
    t.push({ x: 50, y, text: desc, size: 10 });
    t.push({ x: 545, y, text: m(l.amountMinor), size: 10, align: 'right' });
    y -= 15;
  }
  lines.push({ x1: 330, y1: y + 6, x2: 545, y2: y + 6 });
  y -= 6;
  const row = (k: string, v: string, bold = false) => {
    t.push({ x: 330, y, text: k, size: 10, bold });
    t.push({ x: 545, y, text: v, size: 10, bold, align: 'right' });
    y -= 15;
  };
  row('Subtotal', m(inv.lines.reduce((a, l) => a + l.amountMinor, 0)));
  for (const tax of inv.taxes) row(`${tax.name} (${(tax.rateBps / 100).toFixed(2)}%)`, m(tax.amountMinor));
  if (!inv.taxes.length) row('Tax', 'Not applied');
  row('Total', m(inv.totalMinor), true);
  if (inv.paidMinor) row('Paid', m(-inv.paidMinor));
  row('Amount due', m(inv.totalMinor - inv.paidMinor), true);
  y -= 20;
  t.push({ x: 50, y, text: 'Statement summary', size: 9, bold: true });
  y -= 13;
  for (const [k, v] of [['Gross sales', st.grossSalesMinor], ['Less refunds', -st.refundsMinor], ['Less tax', -st.taxMinor], ['Less tips', -st.tipsMinor], ['External sales (reported)', st.externalSalesMinor], ['Net sales (royalty basis)', st.basisMinor]] as const) {
    if (!v && k !== 'Net sales (royalty basis)') continue;
    t.push({ x: 50, y, text: k, size: 9 });
    t.push({ x: 300, y, text: m(v), size: 9, align: 'right' });
    y -= 12;
  }
  y -= 16;
  t.push({ x: 50, y, text: 'Payment is collected by debit under the authorisation on file, or pay in BranchHarbor under Finance.', size: 8 });
  y -= 11;
  t.push({ x: 50, y, text: 'Tax lines are shown only as configured by the franchisor; BranchHarbor does not determine tax.', size: 8 });
  return renderPdf([{ texts: t, lines }], { title: `Invoice ${inv.number}` });
}
