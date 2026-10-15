import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { financeDunningEvents, locations, marketingFundEntries, paymentReferences, refunds } from '../src/db/schema/index.ts';
import { agreementTermsProviders, registerAgreementTermsProvider } from '../src/services/finance/terms.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Finance workspace end to end (sandbox payments): terms, period close in each location's time zone, statements,
 * disputes, approval, invoice numbering and tax, collection success and failure with dunning, the marketing fund,
 * payouts and reconciliation, exports, reports, and franchisee isolation.
 */
describe.skipIf(!hasDb)('finance workspace (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let finance: Awaited<ReturnType<typeof verifiedUser>>;
  let fo1: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let lm: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let g1: string;
  let g2: string;
  let tor: string;
  let van: string;
  let lon: string;
  let hqLoc: string;
  const SEP = '2026-09-01';
  const AUG = '2026-08-01';
  const base = () => `/v1/orgs/${orgId}/finance`;

  const pay = async (locationId: string, currency: string, amountMinor: number, at: string, targetType = 'class_booking') => {
    const [p] = await app.ctx.db.insert(paymentReferences).values({
      organizationId: orgId, locationId, provider: 'stripe', externalId: `pi_test_${uid()}${uid()}`, connectedAccountId: 'acct_sandbox_test', amountMinor, currency,
      applicationFeeMinor: Math.floor(amountMinor / 100), state: 'succeeded', succeededAt: new Date(at), targetType, targetId: randomUUID(), sandbox: 1,
    }).returning();
    return p!;
  };
  const statementFor = async (token: string, locationId: string, periodStart = SEP): Promise<any> => {
    const list = await call(app, 'GET', `${base()}/statements`, { token });
    const s = list.body.items.find((x: any) => x.location.id === locationId && x.period.startDate === periodStart);
    return s ? (await call(app, 'GET', `${base()}/statements/${s.id}`, { token })).body : null;
  };
  const pdfB64 = Buffer.from('%PDF-1.4 evidence').toString('base64');

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Franchisor CEO');
    orgId = (await createOrg(app, owner.token, { name: `Northlight ${uid()}` })).id;
    g1 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Pacific Heat', legalName: 'Pacific Heat Studios Inc.' } })).body.id;
    g2 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Thames Hot Yoga' } })).body.id;
    tor = (await createLocation(app, owner.token, orgId, { name: 'Toronto Annex', ownerGroupId: g1 })).id;
    van = (await createLocation(app, owner.token, orgId, { name: 'Vancouver Main', ownerGroupId: g1, timeZone: 'America/Vancouver', address: { line1: '1 Main', city: 'Vancouver', country: 'CA' } })).id;
    lon = (await createLocation(app, owner.token, orgId, { name: 'London Hackney', ownerGroupId: g2, timeZone: 'Europe/London', currency: 'GBP', address: { line1: '1 Mare St', city: 'London', country: 'GB' } })).id;
    hqLoc = (await createLocation(app, owner.token, orgId, { name: 'HQ studio (company-owned)' })).id;
    await app.ctx.db.update(locations).set({ paymentsEnabled: true, stripeAccountId: 'acct_sandbox_test' }).where(eq(locations.organizationId, orgId));
    finance = await memberWithRole(app, owner.token, orgId, 'finance', { kind: 'organization', id: orgId }, 'Finance Lead');
    fo1 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g1 }, 'Owner Pacific');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'Owner Thames');
    lm = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor }, 'Manager Toronto');

    // September sales. Toronto: one sale on 31 Aug 23:00 local (excluded) and one on 30 Sep 23:30 local (included).
    await pay(tor, 'CAD', 10_000, '2026-09-15T12:00:00Z');
    const refunded = await pay(tor, 'CAD', 4_000, '2026-09-16T12:00:00Z');
    await app.ctx.db.insert(refunds).values({ organizationId: orgId, paymentId: refunded.id, amountMinor: 2_000, currency: 'CAD', state: 'complete', updatedAt: new Date('2026-09-20T12:00:00Z') });
    await pay(tor, 'CAD', 7_000, '2026-10-01T03:30:00Z');
    await pay(tor, 'CAD', 9_000, '2026-09-01T03:00:00Z');
    // Vancouver: 30 Sep 23:30 local is 1 Oct 06:30 UTC; a USD payment is never added to CAD.
    await pay(van, 'CAD', 5_000, '2026-10-01T06:30:00Z');
    await pay(van, 'USD', 3_000, '2026-09-10T18:00:00Z');
    // London: a gift voucher (excluded by default) and a royalty-invoice payment (never sales).
    await pay(lon, 'GBP', 400_000, '2026-09-10T10:00:00Z');
    await pay(lon, 'GBP', 50_000, '2026-09-11T10:00:00Z', 'wellness_voucher');
    await pay(lon, 'GBP', 12_345, '2026-09-12T10:00:00Z', 'royalty_invoice');
    await pay(hqLoc, 'CAD', 99_999, '2026-09-12T10:00:00Z');
  });
  afterAll(async () => { await app?.close(); });

  it('lets only HQ finance configure terms and settings', async () => {
    expect((await call(app, 'GET', `${base()}/settings`, { token: fo1.token })).status).toBe(403);
    const basis = { streams: ['bookings', 'memberships', 'retail', 'food', 'other'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: true };
    expect((await call(app, 'POST', `${base()}/terms`, { token: fo1.token, body: { currency: 'CAD', effectiveFrom: '2026-01-01', royaltyBps: 1, basis } })).status).toBe(403);
    const cad = await call(app, 'POST', `${base()}/terms`, { token: finance.token, body: { currency: 'CAD', effectiveFrom: '2026-01-01', royaltyBps: 600, marketingFundBps: 200, technologyFeeMinor: 14_900, basis } });
    expect(cad.status).toBe(201);
    const gbp = await call(app, 'POST', `${base()}/terms`, {
      token: finance.token,
      body: { ownerGroupId: g2, currency: 'GBP', effectiveFrom: '2026-01-01', royaltyBps: 500, minimumRoyaltyMinor: 30_000, marketingFundBps: 150, basis, lateFee: { kind: 'flat', flatMinor: 2_500, graceDays: 3 } },
    });
    expect(gbp.status).toBe(201);
    const st = await call(app, 'PUT', `${base()}/settings`, { token: finance.token, body: { invoicePrefix: 'NL', paymentTermsDays: 10, taxLines: [{ name: 'GST', rateBps: 500, country: 'CA', appliesTo: ['royalty', 'technology_fee'] }], dunning: { retryDays: [3, 7], reminderDaysBefore: 3, finalNoticeAfterDays: 14 } } });
    expect(st.status).toBe(200);
    expect(st.body.invoicePrefix).toBe('NL');
  });

  it('refuses to close a period that has not ended everywhere, and franchisees cannot close', async () => {
    expect((await call(app, 'POST', `${base()}/periods/close`, { token: fo1.token, body: { startDate: SEP } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/periods/close`, { token: finance.token, body: { startDate: '2099-01-01' } })).body.error.code).toBe('period_not_ended');
    expect((await call(app, 'POST', `${base()}/periods/close`, { token: finance.token, body: { startDate: '2026-09-02' } })).status).toBe(400);
  });

  it('closes a period: one statement per franchised location, in local time and in its own currency', async () => {
    const r = await call(app, 'POST', `${base()}/periods/close`, { token: finance.token, body: { startDate: SEP } });
    expect(r.status).toBe(200);
    expect(r.body.statements).toBe(3);
    const t = await statementFor(finance.token, tor);
    expect(t.currency).toBe('CAD');
    expect(t.grossSalesMinor).toBe(10_000 + 4_000 + 7_000);
    expect(t.refundsMinor).toBe(2_000);
    expect(t.basisMinor).toBe(19_000);
    expect(t.royaltyMinor).toBe(1_140);
    expect(t.marketingFundMinor).toBe(380);
    expect(t.totalMinor).toBe(1_140 + 380 + 14_900);
    expect(t.termsSource).toBe('organization');
    const v = await statementFor(finance.token, van);
    expect(v.grossSalesMinor).toBe(5_000);
    expect(v.warnings).toContain('foreign_currency_payments:USD:3000');
    const l = await statementFor(finance.token, lon);
    expect(l.currency).toBe('GBP');
    expect(l.grossSalesMinor).toBe(400_000);
    expect(l.lines.find((x: any) => x.description === 'excluded:gift_vouchers').amountMinor).toBe(50_000);
    expect(l.royaltyMinor).toBe(30_000); // 5% = 20,000, topped up to the 30,000 minimum
    expect(l.lines.find((x: any) => x.kind === 'royalty_minimum').amountMinor).toBe(10_000);
    expect(l.termsSource).toBe('owner_group');
    expect((await statementFor(finance.token, hqLoc))).toBeNull();
  });

  it('keeps franchisees to their own statements (and hides HQ terms)', async () => {
    const mine = await call(app, 'GET', `${base()}/statements`, { token: fo1.token });
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((s: any) => s.location.id).sort()).toEqual([tor, van].sort());
    const lonId = (await statementFor(finance.token, lon)).id;
    expect((await call(app, 'GET', `${base()}/statements/${lonId}`, { token: fo1.token })).status).toBe(404);
    const own = await statementFor(fo1.token, tor);
    expect(own.terms).toBeNull();
    expect(own.lines.length).toBeGreaterThan(0);
    expect((await call(app, 'GET', `${base()}/terms`, { token: fo1.token })).status).toBe(403);
    expect((await call(app, 'GET', `${base()}/statements`, { token: lm.token })).status).toBe(403);
    expect((await call(app, 'GET', `${base()}/reports`, { token: fo2.token })).status).toBe(403);
  });

  it('runs the dispute workflow: franchisee raises, HQ resolves, then finance approves', async () => {
    const st = await statementFor(finance.token, lon);
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/invoice`, { token: finance.token })).body.error.code).toBe('statement_not_approved');
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/disputes`, { token: fo1.token, body: { reason: 'Not our studio at all' } })).status).toBe(404);
    const d = await call(app, 'POST', `${base()}/statements/${st.id}/disputes`, { token: fo2.token, body: { reason: 'The minimum should be prorated for our September opening', lineId: st.lines.find((x: any) => x.kind === 'royalty_minimum').id } });
    expect(d.status).toBe(201);
    expect((await statementFor(fo2.token, lon)).status).toBe('disputed');
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/approve`, { token: finance.token })).body.error.code).toBe('statement_disputed');
    expect((await call(app, 'POST', `${base()}/disputes/${d.body.id}/resolve`, { token: fo2.token, body: { decision: 'accepted', resolution: 'self-approve' } })).status).toBe(403);
    const res = await call(app, 'POST', `${base()}/disputes/${d.body.id}/resolve`, { token: finance.token, body: { decision: 'accepted', resolution: 'Prorated minimum agreed', adjustmentMinor: -5_000 } });
    expect(res.status).toBe(200);
    const after = await statementFor(fo2.token, lon);
    expect(after.status).toBe('draft');
    expect(after.adjustmentsMinor).toBe(-5_000);
    expect(after.totalMinor).toBe(st.totalMinor - 5_000);
    expect(after.disputes[0]).toMatchObject({ status: 'accepted', adjustmentMinor: -5_000 });
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/approve`, { token: fo2.token })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/statements/${st.id}/approve`, { token: finance.token })).body.status).toBe('approved');
  });

  it('collects automatically with a card mandate and numbers invoices per organisation', async () => {
    const setup = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: fo1.token, body: { ownerGroupId: g1, currency: 'CAD', methodType: 'card', acceptMandate: true } });
    expect(setup.status).toBe(201);
    expect(setup.body.mode).toBe('sandbox');
    expect(setup.body.mandateText).toContain('Pacific Heat Studios Inc.');
    expect((await call(app, 'POST', `${base()}/payment-methods/setup`, { token: fo1.token, body: { ownerGroupId: g2, currency: 'GBP', methodType: 'card', acceptMandate: true } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/payment-methods/${setup.body.id}/sandbox-confirm`, { token: fo1.token, body: { outcome: 'ok' } })).body.status).toBe('active');

    const t = await statementFor(finance.token, tor);
    const v = await statementFor(finance.token, van);
    for (const s of [t, v]) expect((await call(app, 'POST', `${base()}/statements/${s.id}/approve`, { token: finance.token })).status).toBe(200);
    const i1 = await call(app, 'POST', `${base()}/statements/${t.id}/invoice`, { token: finance.token });
    expect(i1.status).toBe(201);
    expect(i1.body.invoice.number).toBe('NL-000001');
    // GST 5% on royalty + technology fee only (HQ-configured), not on the fund contribution.
    expect(i1.body.invoice.taxMinor).toBe(Math.round((1_140 + 14_900) * 0.05));
    expect(i1.body.collection.status).toBe('succeeded');
    const paid = await call(app, 'GET', `${base()}/invoices/${i1.body.invoice.id}`, { token: fo1.token });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.attempts[0]).toMatchObject({ status: 'succeeded', method: 'debit' });
    const i2 = await call(app, 'POST', `${base()}/statements/${v.id}/invoice`, { token: finance.token });
    expect(i2.body.invoice.number).toBe('NL-000002');
    expect((await call(app, 'POST', `${base()}/statements/${t.id}/invoice`, { token: finance.token })).body.error.code).toBe('statement_not_approved');
    const pdf = await call(app, 'GET', `${base()}/invoices/${i1.body.invoice.id}/pdf`, { token: fo1.token });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.raw.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(pdf.raw.rawPayload.toString('latin1')).toContain('NL-000001');
    // The fund contribution is credited once the invoice is paid.
    const fund = await app.ctx.db.select().from(marketingFundEntries).where(eq(marketingFundEntries.invoiceId, i1.body.invoice.id));
    expect(fund).toHaveLength(1);
    expect(fund[0]).toMatchObject({ kind: 'contribution', amountMinor: 380, currency: 'CAD' });
  });

  it('handles a failed debit with dunning: late fee, retries, final notice, then payment', async () => {
    const setup = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: fo2.token, body: { ownerGroupId: g2, currency: 'GBP', methodType: 'bacs_debit', acceptMandate: true } });
    await call(app, 'POST', `${base()}/payment-methods/${setup.body.id}/sandbox-confirm`, { token: fo2.token, body: { outcome: 'decline' } });
    const st = await statementFor(finance.token, lon);
    const issued = await call(app, 'POST', `${base()}/statements/${st.id}/invoice`, { token: finance.token });
    expect(issued.body.invoice.number).toBe('NL-000003');
    expect(issued.body.invoice.taxMinor).toBe(0); // GST is configured for Canada only
    expect(issued.body.collection.status).toBe('failed');
    const id = issued.body.invoice.id;
    const due = issued.body.invoice.dueDate as string;
    const shift = (d: number) => new Date(Date.parse(`${due}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    expect((await call(app, 'GET', `${base()}/invoices/${id}`, { token: fo2.token })).body.status).toBe('open');

    const r0 = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: shift(-2) } });
    expect(r0.body.reminders).toBe(1);
    const r1 = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: shift(4) } });
    expect(r1.body).toMatchObject({ lateFees: 1, retries: 1, retriesFailed: 1 });
    const withFee = (await call(app, 'GET', `${base()}/invoices/${id}`, { token: fo2.token })).body;
    expect(withFee.lateFeeMinor).toBe(2_500);
    expect(withFee.totalMinor).toBe(issued.body.invoice.totalMinor + 2_500);
    expect(withFee.dunningStage).toBe('retrying');
    expect(withFee.attempts.map((a: any) => a.status)).toEqual(['failed', 'failed']);
    const r2 = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: shift(15) } });
    expect(r2.body).toMatchObject({ lateFees: 0, retries: 1, finalNotices: 1 });
    const again = await call(app, 'POST', `${base()}/dunning/run`, { token: finance.token, body: { today: shift(15) } });
    expect(again.body).toMatchObject({ reminders: 0, lateFees: 0, retries: 0, finalNotices: 0 });
    const events = await app.ctx.db.select().from(financeDunningEvents).where(eq(financeDunningEvents.invoiceId, id));
    expect(events.map((e) => `${e.action}:${e.dayOffset}`).sort()).toEqual(['final_notice:14', 'late_fee:4', 'reminder:-3', 'retry:3', 'retry:7']);

    // A new, working bank debit: the franchisee pays; the debit processes, then settles.
    const ok = await call(app, 'POST', `${base()}/payment-methods/setup`, { token: fo2.token, body: { ownerGroupId: g2, currency: 'GBP', methodType: 'bacs_debit', acceptMandate: true } });
    await call(app, 'POST', `${base()}/payment-methods/${ok.body.id}/sandbox-confirm`, { token: fo2.token, body: { outcome: 'ok' } });
    const methods = await call(app, 'GET', `${base()}/payment-methods`, { token: fo2.token });
    expect(methods.body.items.filter((m: any) => m.status === 'active')).toHaveLength(1);
    expect(methods.body.items.every((m: any) => m.ownerGroupId === g2)).toBe(true);
    const p = await call(app, 'POST', `${base()}/invoices/${id}/pay`, { token: fo2.token });
    expect(p.body.status).toBe('processing');
    expect((await call(app, 'POST', `${base()}/invoices/${id}/pay`, { token: fo2.token })).body.error.code).toBe('collection_in_progress');
    expect((await call(app, 'POST', `${base()}/invoices/${id}/sandbox-settle`, { token: finance.token, body: { outcome: 'succeeded' } })).body.invoice.status).toBe('paid');
  });

  it('keeps invoices, payment methods and fund contributions per franchisee', async () => {
    const a = await call(app, 'GET', `${base()}/invoices`, { token: fo1.token });
    expect(a.body.items.map((i: any) => i.number).sort()).toEqual(['NL-000001', 'NL-000002']);
    const b = await call(app, 'GET', `${base()}/invoices`, { token: fo2.token });
    expect(b.body.items.map((i: any) => i.number)).toEqual(['NL-000003']);
    expect((await call(app, 'GET', `${base()}/invoices/${a.body.items[0].id}`, { token: fo2.token })).status).toBe(404);
    expect((await call(app, 'GET', `${base()}/invoices/${a.body.items[0].id}/pdf`, { token: fo2.token })).status).toBe(404);
    expect((await call(app, 'GET', `${base()}/payment-methods`, { token: fo1.token })).body.items.every((m: any) => m.ownerGroupId === g1)).toBe(true);
    const ledger = await call(app, 'GET', `${base()}/fund/ledger`, { token: fo2.token });
    expect(ledger.body.items.filter((e: any) => e.kind === 'contribution').every((e: any) => e.currency === 'GBP')).toBe(true);
    const all = await call(app, 'GET', `${base()}/invoices`, { token: finance.token });
    expect(all.body.items).toHaveLength(3);
  });

  it('keeps a marketing fund ledger per currency with receipts and a transparency report', async () => {
    const camp = await call(app, 'POST', `${base()}/fund/campaigns`, { token: finance.token, body: { name: 'Autumn network campaign' } });
    expect(camp.status).toBe(201);
    expect((await call(app, 'POST', `${base()}/fund/campaigns`, { token: fo1.token, body: { name: 'Mine' } })).status).toBe(403);
    const receipt = { filename: 'receipt.pdf', contentType: 'application/pdf', dataBase64: pdfB64 };
    const over = await call(app, 'POST', `${base()}/fund/spend`, { token: finance.token, body: { currency: 'CAD', amountMinor: 1_000, campaignId: camp.body.id, description: 'Social ads', occurredOn: '2026-10-02', receipt } });
    expect(over.body.error.code).toBe('fund_insufficient');
    const noReceipt = await call(app, 'POST', `${base()}/fund/spend`, { token: finance.token, body: { currency: 'CAD', amountMinor: 200, campaignId: camp.body.id, description: 'Social ads', occurredOn: '2026-10-02' } });
    expect(noReceipt.status).toBe(400);
    const spend = await call(app, 'POST', `${base()}/fund/spend`, { token: finance.token, body: { currency: 'CAD', amountMinor: 200, campaignId: camp.body.id, description: 'Social ads', vendor: 'Ad network', occurredOn: '2026-10-02', receipt } });
    expect(spend.status).toBe(201);
    const ledger = await call(app, 'GET', `${base()}/fund/ledger`, { token: finance.token });
    expect(ledger.body.balances).toEqual(expect.arrayContaining([
      // Toronto (380) and Vancouver (100) invoices were collected automatically.
      expect.objectContaining({ currency: 'CAD', contributionsMinor: 480, spendMinor: 200, balanceMinor: 280 }),
      expect.objectContaining({ currency: 'GBP', contributionsMinor: 6_000, balanceMinor: 6_000 }),
    ]));
    const t1 = await call(app, 'GET', `${base()}/fund/transparency?year=2026`, { token: fo1.token });
    const cad1 = t1.body.currencies.find((c: any) => c.currency === 'CAD');
    expect(cad1).toMatchObject({ contributionsMinor: 480, spendMinor: 200, closingBalanceMinor: 280, yourContributionsMinor: 480 });
    expect(cad1.spendByCampaign[0]).toMatchObject({ name: 'Autumn network campaign', amountMinor: 200 });
    const t2 = await call(app, 'GET', `${base()}/fund/transparency?year=2026`, { token: fo2.token });
    expect(t2.body.currencies.find((c: any) => c.currency === 'CAD').yourContributionsMinor).toBe(0);
    const fo2Ledger = await call(app, 'GET', `${base()}/fund/ledger?currency=CAD`, { token: fo2.token });
    expect(fo2Ledger.body.items.map((e: any) => e.kind)).toEqual(['spend']);
    const receiptId = fo2Ledger.body.items[0].receiptDocumentId;
    expect((await call(app, 'GET', `${base()}/documents/${receiptId}`, { token: fo2.token })).status).toBe(200);
    expect((await call(app, 'GET', `${base()}/fund/ledger`, { token: lm.token })).status).toBe(403);
    const annual = await call(app, 'GET', `${base()}/fund/annual-statement?year=2026`, { token: fo1.token });
    expect(annual.raw.body).toContain('2026,CAD,closing_balance,,2.80');
    expect(annual.raw.body).toContain('2026,CAD,your_contributions,,4.80');
  });

  it('counts accepted external sales with evidence for locations on an external POS', async () => {
    const bad = await call(app, 'POST', `${base()}/external-sales`, { token: fo1.token, body: { locationId: lon, periodStart: AUG, grossMinor: 100, evidence: { filename: 'x.pdf', contentType: 'application/pdf', dataBase64: pdfB64 } } });
    expect(bad.status).toBe(403);
    const sub = await call(app, 'POST', `${base()}/external-sales`, { token: fo1.token, body: { locationId: van, periodStart: AUG, grossMinor: 250_000, refundsMinor: 10_000, taxMinor: 12_000, note: 'Square export', evidence: { filename: 'z-report.pdf', contentType: 'application/pdf', dataBase64: pdfB64 } } });
    expect(sub.status).toBe(201);
    expect((await call(app, 'POST', `${base()}/external-sales`, { token: fo1.token, body: { locationId: van, periodStart: AUG, grossMinor: 1, evidence: { filename: 'x.exe', contentType: 'application/x-msdownload', dataBase64: pdfB64 } } })).status).toBe(400);
    await call(app, 'POST', `${base()}/periods/close`, { token: finance.token, body: { startDate: AUG } });
    let v = await statementFor(finance.token, van, AUG);
    expect(v.warnings).toContain('external_sales_pending_review');
    expect(v.externalSalesMinor).toBe(0);
    expect((await call(app, 'POST', `${base()}/external-sales/${sub.body.id}/review`, { token: fo1.token, body: { decision: 'accepted' } })).status).toBe(403);
    expect((await call(app, 'POST', `${base()}/external-sales/${sub.body.id}/review`, { token: finance.token, body: { decision: 'accepted' } })).body.status).toBe('accepted');
    await call(app, 'POST', `${base()}/statements/${v.id}/recalculate`, { token: finance.token });
    v = await statementFor(finance.token, van, AUG);
    expect(v.externalSalesMinor).toBe(228_000);
    expect(v.basisMinor).toBe(228_000);
    const list = await call(app, 'GET', `${base()}/external-sales`, { token: fo2.token });
    expect(list.body.items).toHaveLength(0);
  });

  it('builds payouts, reconciles them against payments and royalties, and exports for accounting', async () => {
    expect((await call(app, 'POST', `${base()}/payouts/sync`, { token: fo1.token })).status).toBe(403);
    const sync = await call(app, 'POST', `${base()}/payouts/sync`, { token: finance.token });
    expect(sync.body.mode).toBe('sandbox');
    const payouts = await call(app, 'GET', `${base()}/payouts`, { token: finance.token });
    expect(payouts.body.items.length).toBeGreaterThan(0);
    const torPayouts = payouts.body.items.filter((p: any) => p.location.id === tor);
    expect(torPayouts.every((p: any) => p.currency === 'CAD')).toBe(true);
    expect(torPayouts.reduce((a: number, p: any) => a + p.refundsMinor, 0)).toBe(2_000);
    const lmView = await call(app, 'GET', `${base()}/payouts`, { token: lm.token });
    expect(lmView.body.items.every((p: any) => p.location.id === tor)).toBe(true);
    // A late payment event after the close puts the statement out of date.
    await pay(tor, 'CAD', 1_500, '2026-09-29T15:00:00Z');
    const periods = await call(app, 'GET', `${base()}/periods`, { token: finance.token });
    const sep = periods.body.items.find((p: any) => p.startDate === SEP);
    const rec = await call(app, 'GET', `${base()}/reconciliation?periodId=${sep.id}`, { token: finance.token });
    const row = rec.body.items.find((r: any) => r.locationId === tor);
    expect(row.paymentsMinor).toBe(10_000 + 4_000 + 7_000 + 1_500);
    expect(row.paidOutMinor).toBe(10_000 + 4_000 + 7_000);
    expect(row.issues.map((i: any) => i.kind)).toContain('statement_out_of_date');
    expect(row.invoice).toMatchObject({ number: 'NL-000001', status: 'paid' });
    expect(rec.body.items.some((r: any) => r.locationId === hqLoc && r.statement === null)).toBe(true);
    expect((await call(app, 'GET', `${base()}/reconciliation?periodId=${sep.id}`, { token: fo1.token })).status).toBe(403);

    const csv = await call(app, 'GET', `${base()}/exports/invoices`, { token: finance.token });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw.body.split('\r\n')[0]).toBe('number,location,franchisee,currency,issue_date,due_date,subtotal,tax,late_fee,total,paid,outstanding,status');
    expect(csv.raw.body).toContain('NL-000003');
    const xero = await call(app, 'GET', `${base()}/exports/invoices?format=xero`, { token: finance.token });
    expect(xero.raw.body.split('\r\n')[0]).toContain('*InvoiceNumber');
    expect(xero.raw.body).toContain('Pacific Heat Studios Inc.,,NL-000001');
    const qbo = await call(app, 'GET', `${base()}/exports/invoices?format=quickbooks`, { token: finance.token });
    expect(qbo.raw.body.split('\r\n')[0]).toBe('InvoiceNo,Customer,InvoiceDate,DueDate,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,ItemTaxAmount,Currency');
    expect((await call(app, 'GET', `${base()}/exports/payouts?format=quickbooks`, { token: finance.token })).status).toBe(400);
    const qboCad = await call(app, 'GET', `${base()}/exports/payouts?format=quickbooks&currency=CAD`, { token: finance.token });
    expect(qboCad.raw.body.split('\r\n')[0]).toBe('Date,Description,Amount');
    const mine = await call(app, 'GET', `${base()}/exports/invoices`, { token: fo1.token });
    expect(mine.raw.body).toContain('NL-000001');
    expect(mine.raw.body).not.toContain('NL-000003');
    expect((await call(app, 'GET', `${base()}/exports/payouts`, { token: fo1.token })).status).toBe(200);
  });

  it('reports royalty revenue, collection rate, arrears and the fund per currency', async () => {
    const r = await call(app, 'GET', `${base()}/reports?from=2026-01-01&to=2027-01-01`, { token: finance.token });
    expect(r.status).toBe(200);
    const torRow = r.body.royaltyByLocation.find((x: any) => x.key === tor);
    // September (1,140) plus August (540 on the 31 Aug 23:00 local sale).
    expect(torRow).toMatchObject({ currency: 'CAD', royaltyMinor: 1_140 + 540, statements: 2 });
    expect(new Set(r.body.royaltyByLocation.map((x: any) => x.currency))).toEqual(new Set(['CAD', 'GBP']));
    const cad = r.body.collectionRate.find((c: any) => c.currency === 'CAD');
    expect(cad).toMatchObject({ invoices: 2, paidInvoices: 2, rate: 1 });
    const gbp = r.body.collectionRate.find((c: any) => c.currency === 'GBP');
    expect(gbp.rate).toBe(1);
    expect(r.body.arrearsAgeing).toEqual([]);
    expect(r.body.fundBalance.map((f: any) => f.currency).sort()).toEqual(['CAD', 'GBP']);
  });
  it('takes rates from a franchise agreement provider first, falling back to owner-group and organisation terms', async () => {
    registerAgreementTermsProvider({ name: 'test_agreements', async find(_db, q) { return q.ownerGroupId === g1 ? { sourceId: 'agr-1', royaltyBps: 800, marketingFundBps: 250 } : null; } });
    try {
      const r = await call(app, 'GET', `${base()}/terms/resolve?locationId=${tor}&date=2026-10-01`, { token: finance.token });
      expect(r.body.terms).toMatchObject({ source: 'agreement', sourceId: 'agr-1', royaltyBps: 800, marketingFundBps: 250, technologyFeeMinor: 14_900, currency: 'CAD' });
      const other = await call(app, 'GET', `${base()}/terms/resolve?locationId=${lon}&date=2026-10-01`, { token: finance.token });
      expect(other.body.terms).toMatchObject({ source: 'owner_group', royaltyBps: 500, minimumRoyaltyMinor: 30_000 });
      expect((await call(app, 'GET', `${base()}/terms/resolve?locationId=${tor}&date=2025-06-01`, { token: finance.token })).body.terms).toMatchObject({ source: 'agreement', technologyFeeMinor: 0 });
    } finally {
      agreementTermsProviders.splice(agreementTermsProviders.findIndex((p) => p.name === 'test_agreements'), 1);
    }
  });
});
