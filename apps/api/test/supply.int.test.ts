import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { STARTER_AUDIT_TEMPLATES, auditTemplateBodySchema, rebatePeriodOf } from '@bh/shared';
import {
  accountManagers, auditActions, audits, courses, enrolments, foodIngredientStock, foodIngredients, locations, marketingFundEntries, selfCheckRuns, supplyReceipts,
} from '../src/db/schema/index.ts';
import { runAuditSchedules, runSelfCheckJobs } from '../src/services/audit-programmes.ts';
import { addDays } from '../src/lib/tz.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Supplier network (catalogue, purchase orders with HQ approval, the supplier's magic link, receiving into foods
 * inventory, off-contract spend, scorecards, rebates into the marketing fund) and audits phase 2 (recurring schedules
 * with the field consultant, the retraining loop, trends, the visit planner and self-checks), with franchisee
 * isolation throughout.
 */
describe.skipIf(!hasDb)('suppliers, rebates and audits phase 2 (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let fo1: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let staff2: Awaited<ReturnType<typeof verifiedUser>>;
  let consultant: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let g1: string;
  let g2: string;
  let west: string;
  let sea: string;
  let van: string;
  let lon: string;
  let supplierId: string;
  let ukSupplierId: string;
  let oilId: string;
  let flourId: string;
  let ingredientId: string;
  let poId: string;
  let bigPoId: string;
  let confirmToken: string;
  const S = () => `/v1/orgs/${orgId}/supply`;
  const A = () => `/v1/orgs/${orgId}/audits`;
  const SC = () => `/v1/orgs/${orgId}/self-checks`;
  const db = () => app.ctx.db;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Franchisor CEO');
    orgId = (await createOrg(app, owner.token, { name: `Maple ${uid()}`, industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    g1 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Cascade Eats' } })).body.id;
    g2 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Thames Kitchens' } })).body.id;
    west = (await call(app, 'POST', `/v1/orgs/${orgId}/regions`, { token: owner.token, body: { name: 'Pacific Northwest' } })).body.id;
    sea = (await createLocation(app, owner.token, orgId, { name: 'Seattle Ballard', ownerGroupId: g1, regionId: west, timeZone: 'America/Los_Angeles', currency: 'USD', address: { line1: '1 Market St', city: 'Seattle', region: 'WA', country: 'US' } })).id;
    van = (await createLocation(app, owner.token, orgId, { name: 'Vancouver Gastown', ownerGroupId: g1, regionId: west, timeZone: 'America/Vancouver', currency: 'CAD', address: { line1: '1 Water St', city: 'Vancouver', region: 'BC', country: 'CA' } })).id;
    lon = (await createLocation(app, owner.token, orgId, { name: 'London Spitalfields', ownerGroupId: g2, timeZone: 'Europe/London', currency: 'GBP', address: { line1: '12 Brushfield St', city: 'London', country: 'GB' } })).id;
    await db().update(locations).set({ geo: { lat: 47.6687, lng: -122.3847 } }).where(eq(locations.id, sea));
    await db().update(locations).set({ geo: { lat: 49.2838, lng: -123.1065 } }).where(eq(locations.id, van));
    fo1 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g1 }, 'Owner Cascade');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'Owner Thames');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: sea }, 'Cook Seattle');
    staff2 = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: lon }, 'Cook London');
    // A field consultant: HQ (organisation-wide) with Audits view + edit, account manager for the Pacific Northwest.
    const role = await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: 'Field consultant', capabilities: ['operations.audits:view', 'operations.audits:edit'] } });
    consultant = await verifiedUser(app, 'Jordan Consultant');
    const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: consultant.email, role: 'custom', customRoleId: role.body.id, scope: { kind: 'organization', id: orgId } } });
    expect((await call(app, 'POST', '/v1/invitations/accept', { token: consultant.token, body: { token: inv.body.devInvitationToken } })).status).toBe(200);
    await db().insert(accountManagers).values({ organizationId: orgId, userId: consultant.userId, scopeKind: 'region', scopeId: west, title: 'Field consultant' });
    const [ing] = await db().insert(foodIngredients).values({ organizationId: orgId, name: 'Olive oil', unit: 'ml' }).returning();
    ingredientId = ing!.id;
  });
  afterAll(async () => { await app?.close(); });

  /* ------------------------------ suppliers ------------------------------ */

  it('keeps suppliers away from people without the module, and only HQ manages them', async () => {
    expect((await call(app, 'GET', `${S()}/overview`, { token: staff.token })).body.error.code).toBe('module_not_available');
    const body = { name: 'Northwest Foodservice', countries: ['US', 'CA'], currency: 'USD', orderEmail: 'orders@nwfoods.example', orderFormat: 'both', contacts: [{ name: 'Dana Ruiz', role: 'Account manager', email: 'dana@nwfoods.example', primary: true }], contract: { reference: 'NWF-2026', startsOn: '2026-01-01', endsOn: '2027-12-31', paymentTerms: 'Net 30' } };
    expect((await call(app, 'POST', `${S()}/suppliers`, { token: fo1.token, body })).status).toBe(403);
    const r = await call(app, 'POST', `${S()}/suppliers`, { token: owner.token, body });
    expect(r.status).toBe(201);
    supplierId = r.body.id;
    ukSupplierId = (await call(app, 'POST', `${S()}/suppliers`, { token: owner.token, body: { name: 'Bermondsey Provisions', countries: ['GB'], currency: 'GBP', orderEmail: 'po@bermondsey.example' } })).body.id;
    const oil = await call(app, 'POST', `${S()}/suppliers/${supplierId}/items`, { token: owner.token, body: { sku: 'OIL-5L', name: 'Extra virgin olive oil', category: 'Pantry', packLabel: 'Case of 4 × 5 L', unitsPerPack: 20_000, prices: { USD: 9_800, CAD: 13_200 }, moq: 2, leadTimeDays: 3, ingredientId } });
    expect(oil.status).toBe(201);
    oilId = oil.body.id;
    flourId = (await call(app, 'POST', `${S()}/suppliers/${supplierId}/items`, { token: owner.token, body: { sku: 'FLR-25', name: 'Tipo 00 flour', category: 'Pantry', packLabel: '25 kg sack', prices: { USD: 4_200 }, leadTimeDays: 2 } })).body.id;
    expect((await call(app, 'POST', `${S()}/suppliers/${supplierId}/items`, { token: owner.token, body: { sku: 'OIL-5L', name: 'dup', prices: { USD: 1 } } })).body.error.code).toBe('sku_exists');
    // A certification linked to an uploaded certificate.
    const pdf = { filename: 'haccp.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 cert').toString('base64') };
    const cert = await call(app, 'POST', `${S()}/suppliers/${supplierId}/certifications`, { token: owner.token, body: { name: 'HACCP certificate', expiresOn: addDays(new Date().toISOString().slice(0, 10), 20), file: pdf } });
    expect(cert.status).toBe(201);
    expect(cert.body.state).toBe('expiring');
  });

  it('shows each franchisee only the suppliers approved for their locations, priced in the location currency', async () => {
    const mine = await call(app, 'GET', `${S()}/suppliers`, { token: fo1.token });
    expect(mine.body.items.map((x: any) => x.name)).toEqual(['Northwest Foodservice']);
    expect(mine.body.can.manage).toBe(false);
    const theirs = await call(app, 'GET', `${S()}/suppliers`, { token: fo2.token });
    expect(theirs.body.items.map((x: any) => x.name)).toEqual(['Bermondsey Provisions']);
    expect((await call(app, 'GET', `${S()}/suppliers/${supplierId}`, { token: fo2.token })).status).toBe(404);
    const cat = await call(app, 'GET', `${S()}/catalogue?locationId=${van}`, { token: fo1.token });
    expect(cat.body.location.currency).toBe('CAD');
    const oil = cat.body.items.find((i: any) => i.sku === 'OIL-5L');
    expect(oil.price).toEqual({ amountMinor: 13_200, currency: 'CAD' });
    expect(cat.body.items.find((i: any) => i.sku === 'FLR-25').price).toBeNull();
    expect((await call(app, 'GET', `${S()}/catalogue?locationId=${lon}`, { token: fo1.token })).status).toBe(403);
  });

  it('orders from the catalogue: MOQ and currency checks, HQ approval above the threshold', async () => {
    expect((await call(app, 'PUT', `${S()}/settings`, { token: fo1.token, body: { approvalThresholds: { USD: 50_000 } } })).status).toBe(403);
    expect((await call(app, 'PUT', `${S()}/settings`, { token: owner.token, body: { approvalThresholds: { USD: 50_000, CAD: 60_000 } } })).status).toBe(200);
    const moq = await call(app, 'POST', `${S()}/orders`, { token: fo1.token, body: { locationId: sea, supplierId, lines: [{ itemId: oilId, quantity: 1 }] } });
    expect(moq.status).toBe(400);
    expect((await call(app, 'POST', `${S()}/orders`, { token: fo1.token, body: { locationId: van, supplierId, lines: [{ itemId: flourId, quantity: 1 }] } })).status).toBe(400);
    expect((await call(app, 'POST', `${S()}/orders`, { token: fo2.token, body: { locationId: sea, supplierId, lines: [{ itemId: oilId, quantity: 2 }] } })).status).toBe(403);
    expect((await call(app, 'POST', `${S()}/orders`, { token: fo2.token, body: { locationId: lon, supplierId, lines: [{ itemId: oilId, quantity: 2 }] } })).body.error.code).toBe('supplier_not_approved_here');
    // Below the threshold: straight to the supplier with a magic link.
    const small = await call(app, 'POST', `${S()}/orders`, { token: fo1.token, body: { locationId: sea, supplierId, lines: [{ itemId: oilId, quantity: 3 }, { itemId: flourId, quantity: 2 }], submit: true } });
    expect(small.status).toBe(201);
    expect(small.body.status).toBe('sent');
    expect(small.body.totalMinor).toBe(3 * 9_800 + 2 * 4_200);
    expect(small.body.approvalRequired).toBe(false);
    expect(small.body.expectedDeliveryDate).toBeTruthy();
    poId = small.body.id;
    confirmToken = decodeURIComponent(small.body.confirmUrl.split('/supplier/')[1]);
    // Above the threshold: waits for HQ.
    const big = await call(app, 'POST', `${S()}/orders`, { token: fo1.token, body: { locationId: sea, supplierId, lines: [{ itemId: oilId, quantity: 6 }] } });
    bigPoId = big.body.id;
    const sub = await call(app, 'POST', `${S()}/orders/${bigPoId}/submit`, { token: fo1.token });
    expect(sub.body.status).toBe('pending_approval');
    expect(sub.body.approval).toMatchObject({ required: true, thresholdMinor: 50_000 });
    expect((await call(app, 'POST', `${S()}/orders/${bigPoId}/decision`, { token: fo1.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `${S()}/orders/${bigPoId}/decision`, { token: owner.token, body: { decision: 'reject' } })).status).toBe(400);
    const ok = await call(app, 'POST', `${S()}/orders/${bigPoId}/decision`, { token: owner.token, body: { decision: 'approve', note: 'Fine for the opening weekend' } });
    expect(ok.body.status).toBe('sent');
    expect(ok.body.confirmUrl).toContain('/supplier/');
    // Other franchisees never see these orders.
    expect((await call(app, 'GET', `${S()}/orders/${poId}`, { token: fo2.token })).status).toBe(404);
    expect((await call(app, 'GET', `${S()}/orders`, { token: fo2.token })).body.items).toEqual([]);
    expect((await call(app, 'GET', `${S()}/orders?status=all`, { token: fo1.token })).body.items.length).toBe(2);
  });

  it('lets the supplier view, download and confirm the order through the magic link (no login)', async () => {
    const view = await call(app, 'GET', `/v1/public/supply/po/${confirmToken}`);
    expect(view.status).toBe(200);
    expect(view.body.deliverTo.name).toBe('Seattle Ballard');
    expect(view.body.canConfirm).toBe(true);
    const pdf = await app.inject({ method: 'GET', url: `/v1/public/supply/po/${confirmToken}/order.pdf` });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    const csv = await app.inject({ method: 'GET', url: `/v1/public/supply/po/${confirmToken}/order.csv` });
    expect(csv.body).toContain('OIL-5L');
    expect((await call(app, 'GET', '/v1/public/supply/po/not-a-real-token-123456')).status).toBe(404);
    const due = addDays(new Date().toISOString().slice(0, 10), 2);
    const conf = await call(app, 'POST', `/v1/public/supply/po/${confirmToken}/confirm`, { body: { expectedDeliveryDate: due, reference: 'NWF-88123', lines: [{ itemId: flourId, confirmedQuantity: 1 }] } });
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('confirmed');
    expect(conf.body.lines.find((l: any) => l.itemId === flourId).confirmedQuantity).toBe(1);
    const po = await call(app, 'GET', `${S()}/orders/${poId}`, { token: fo1.token });
    expect(po.body.expectedDeliveryDate).toBe(due);
    expect(po.body.supplierReference).toBe('NWF-88123');
  });

  it('receives partial deliveries with discrepancies and restocks the linked ingredient', async () => {
    expect((await call(app, 'POST', `${S()}/orders/${poId}/receive`, { token: fo2.token, body: { lines: [{ itemId: oilId, received: 1 }] } })).status).toBe(404);
    const first = await call(app, 'POST', `${S()}/orders/${poId}/receive`, { token: staff.token, body: { lines: [{ itemId: oilId, received: 1 }] } });
    expect(first.status).toBe(403); // staff hold no Suppliers module (granted by name)
    const r1 = await call(app, 'POST', `${S()}/orders/${poId}/receive`, { token: fo1.token, body: { lines: [{ itemId: oilId, received: 2, damaged: 1, note: 'One case leaking' }, { itemId: flourId, received: 1 }] } });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('partially_received');
    expect(r1.body.inventory).toEqual([{ itemId: oilId, kind: 'ingredient', targetId: ingredientId, units: 40_000 }]);
    const [stock] = await db().select().from(foodIngredientStock).where(and(eq(foodIngredientStock.locationId, sea), eq(foodIngredientStock.ingredientId, ingredientId)));
    expect(stock!.onHand).toBe(40_000);
    expect(r1.body.receipts[0].issues).toBe(1);
    const r2 = await call(app, 'POST', `${S()}/orders/${poId}/receive`, { token: fo1.token, body: { lines: [{ itemId: flourId, received: 0, issue: 'short', note: 'Second sack never came' }], closeShort: true } });
    expect(r2.body.status).toBe('received');
    expect(r2.body.closedShort).toBe(true);
    expect((await call(app, 'POST', `${S()}/orders/${poId}/receive`, { token: fo1.token, body: { lines: [{ itemId: oilId, received: 1 }] } })).status).toBe(409);
    const cards = await call(app, 'GET', `${S()}/scorecards`, { token: owner.token });
    const nw = cards.body.items.find((x: any) => x.supplierId === supplierId);
    expect(nw.delivered).toBe(1);
    expect(nw.fillRatePct).toBe(60); // 3 of 5 packs ordered arrived in good condition
    expect(nw.issues).toBe(3); // damaged oil, short flour, oil closed short
  });

  it('flags off-contract purchases for HQ', async () => {
    const log = await call(app, 'POST', `${S()}/off-contract`, { token: fo1.token, body: { locationId: sea, vendorName: 'Corner cash & carry', description: 'Olive oil, ran out on Saturday', amountMinor: 6_400, currency: 'USD', purchasedOn: new Date().toISOString().slice(0, 10), reason: 'out_of_stock' } });
    expect(log.status).toBe(201);
    expect(log.body.status).toBe('flagged');
    expect((await call(app, 'GET', `${S()}/off-contract`, { token: fo2.token })).body.items).toEqual([]);
    expect((await call(app, 'POST', `${S()}/off-contract/${log.body.id}/review`, { token: fo1.token, body: { status: 'accepted' } })).status).toBe(403);
    expect((await call(app, 'POST', `${S()}/off-contract/${log.body.id}/review`, { token: owner.token, body: { status: 'action_required' } })).status).toBe(400);
    const rev = await call(app, 'POST', `${S()}/off-contract/${log.body.id}/review`, { token: owner.token, body: { status: 'action_required', note: 'Order oil from Northwest with a 3-day lead time', suggestedSupplierId: supplierId } });
    expect(rev.body.status).toBe('action_required');
    const ov = await call(app, 'GET', `${S()}/overview`, { token: owner.token });
    expect(ov.body.compliance.find((c: any) => c.currency === 'USD').offContractMinor).toBe(6_400);
  });

  it('accrues tiered rebates from received goods, raises a claim with a statement and books the fund share', async () => {
    const body = { supplierId, name: 'Pantry volume rebate', basis: 'percent', measure: 'spend', currency: 'USD', tiers: [{ from: 0, rate: 200 }, { from: 40_000, rate: 500 }], period: 'quarter', startsOn: '2025-01-01', fundSharePct: 50 };
    expect((await call(app, 'POST', `${S()}/rebates`, { token: fo1.token, body })).status).toBe(403);
    const p = await call(app, 'POST', `${S()}/rebates`, { token: owner.token, body });
    expect(p.status).toBe(201);
    let list = await call(app, 'GET', `${S()}/rebates`, { token: owner.token });
    const cur = list.body.items[0].current;
    expect(cur.spendMinor).toBe(2 * 9_800 + 4_200);
    expect(cur.tierIndex).toBe(0);
    expect(cur.accruedMinor).toBe(Math.round((23_800 * 200) / 10_000));
    expect(cur.next).toEqual({ from: 40_000, rate: 500, remaining: 40_000 - 23_800 });
    const today = new Date().toISOString().slice(0, 10);
    expect((await call(app, 'POST', `${S()}/rebates/${p.body.id}/claims`, { token: owner.token, body: { periodStart: today } })).body.error.code).toBe('period_open');
    // Move the deliveries into the previous quarter, then claim it.
    const prev = rebatePeriodOf('quarter', addDays(rebatePeriodOf('quarter', today).start, -1));
    await db().update(supplyReceipts).set({ receivedOn: addDays(prev.end, -3) }).where(eq(supplyReceipts.organizationId, orgId));
    list = await call(app, 'GET', `${S()}/rebates`, { token: owner.token });
    expect(list.body.items[0].claimable).toMatchObject({ start: prev.start, accruedMinor: 476 });
    const c = await call(app, 'POST', `${S()}/rebates/${p.body.id}/claims`, { token: owner.token, body: { periodStart: prev.start } });
    expect(c.status).toBe(201);
    expect(c.body.amountMinor).toBe(476);
    expect(c.body.lines).toEqual([expect.objectContaining({ locationId: sea, spendMinor: 23_800, shareMinor: 476 })]);
    expect((await call(app, 'POST', `${S()}/rebates/${p.body.id}/claims`, { token: owner.token, body: { periodStart: prev.start } })).body.error.code).toBe('claim_exists');
    expect((await call(app, 'POST', `${S()}/rebates/claims/${c.body.id}/submit`, { token: owner.token })).body.status).toBe('submitted');
    const got = await call(app, 'POST', `${S()}/rebates/claims/${c.body.id}/received`, { token: owner.token, body: { amountMinor: 476, receivedOn: today } });
    expect(got.body.status).toBe('received');
    expect(got.body.fundShareMinor).toBe(238);
    const [entry] = await db().select().from(marketingFundEntries).where(eq(marketingFundEntries.id, got.body.fundEntryId));
    expect(entry).toMatchObject({ amountMinor: 238, currency: 'USD', kind: 'adjustment' });
    const pdf = await app.inject({ method: 'GET', url: `${S()}/rebates/claims/${c.body.id}/statement?format=pdf`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(pdf.body.startsWith('%PDF')).toBe(true);
    const csv = await app.inject({ method: 'GET', url: `${S()}/rebates/claims/${c.body.id}/statement?format=csv`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(csv.body).toContain('Seattle Ballard');
  });

  /* ---------------------------- audits phase 2 ---------------------------- */

  let templateId: string;
  let courseId: string;
  let scheduledAuditId: string;

  it('creates recurring audits for the field consultant, once per due date', async () => {
    const [c] = await db().insert(courses).values({ organizationId: orgId, slug: `food-safety-${uid()}`, title: 'Food safety refresher', status: 'published' }).returning();
    courseId = c!.id;
    const st = auditTemplateBodySchema.parse(STARTER_AUDIT_TEMPLATES.find((x) => x.key === 'kitchen_food_safety'));
    st.sections[0]!.questions[0] = { ...st.sections[0]!.questions[0]!, trainingCourseId: courseId, trainingAutoAssign: true };
    const t = await call(app, 'POST', `${A()}/templates`, { token: owner.token, body: st });
    expect(t.status).toBe(201);
    templateId = t.body.id;
    const today = new Date().toISOString().slice(0, 10);
    const body = { name: 'Monthly food safety visit', templateId, target: { kind: 'region', ids: [west] }, frequency: 'monthly', anchorDate: addDays(today, 3), leadDays: 7, auditorRule: 'field_consultant' };
    expect((await call(app, 'POST', `${A()}/schedules`, { token: fo1.token, body })).status).toBe(403);
    const sch = await call(app, 'POST', `${A()}/schedules`, { token: owner.token, body });
    expect(sch.status).toBe(201);
    expect(sch.body.locationCount).toBe(2);
    const prev = await call(app, 'GET', `${A()}/schedules/${sch.body.id}/preview`, { token: owner.token });
    expect(prev.body.locations.every((l: any) => l.auditorUserId === consultant.userId && l.source === 'field_consultant')).toBe(true);
    const run = await call(app, 'POST', `${A()}/schedules/${sch.body.id}/run`, { token: owner.token });
    expect(run.body.created).toBe(2);
    expect((await runAuditSchedules(app.ctx, new Date(), { organizationId: orgId })).created).toBe(0);
    const created = await db().select().from(audits).where(eq(audits.scheduleId, sch.body.id));
    expect(created.map((a) => a.auditorUserId)).toEqual([consultant.userId, consultant.userId]);
    expect(created.every((a) => a.dueDate === addDays(today, 3))).toBe(true);
    scheduledAuditId = created.find((a) => a.locationId === sea)!.id;
  });

  it('plans the consultant’s visits in nearest-neighbour order', async () => {
    const plan = await call(app, 'GET', `${A()}/visits?lat=49.2827&lng=-123.1207`, { token: consultant.token });
    expect(plan.status).toBe(200);
    expect(plan.body.days).toHaveLength(1);
    expect(plan.body.days[0].stops.map((x: any) => x.locationName)).toEqual(['Vancouver Gastown', 'Seattle Ballard']);
    expect(plan.body.days[0].totalKm).toBeGreaterThan(150);
    expect((await call(app, 'GET', `${A()}/visits?auditorUserId=${consultant.userId}`, { token: fo1.token })).status).toBe(403);
    const hq = await call(app, 'GET', `${A()}/visits?auditorUserId=${consultant.userId}`, { token: owner.token });
    expect(hq.body.auditors.map((x: any) => x.id)).toContain(consultant.userId);
  });

  it('a failed item auto-assigns retraining to the location team (finding → task → retraining → verified fix)', async () => {
    const a = await call(app, 'GET', `${A()}/${scheduledAuditId}`, { token: consultant.token });
    const answers: Record<string, any> = {};
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e0005fe02fea7d1d5f30000000049454e44ae426082', 'hex').toString('base64');
    const photo = await call(app, 'POST', `${A()}/${scheduledAuditId}/photos`, { token: consultant.token, body: { filename: 'p.png', contentType: 'image/png', dataBase64: png } });
    for (const sec of a.body.checklist.sections) for (const q of sec.questions) {
      const ph = q.photoRequired || q.type === 'photo' ? { photoIds: [photo.body.id] } : {};
      answers[q.id] = q.type === 'number' ? { value: q.id === 'fridge_temp' ? 9 : q.max !== undefined ? q.max - 1 : (q.min ?? 0) + 1, ...ph } : q.type === 'scale' ? { value: 4, ...ph } : q.type === 'text' ? { value: 'ok' } : { value: 'yes', ...ph };
    }
    const done = await call(app, 'POST', `${A()}/${scheduledAuditId}/complete`, { token: consultant.token, body: { answers } });
    expect(done.status).toBe(200);
    expect(done.body.criticalFailed).toBe(true);
    expect(done.body.actions.find((x: any) => x.questionId === 'fridge_temp').training).toMatchObject({ courseId, assigned: true });
    const report = await call(app, 'GET', `${A()}/${scheduledAuditId}`, { token: fo1.token });
    const action = report.body.actions.find((x: any) => x.questionId === 'fridge_temp');
    expect(action.training).toMatchObject({ courseId, courseTitle: 'Food safety refresher', assigned: true });
    const [row] = await db().select().from(auditActions).where(eq(auditActions.id, action.id));
    const enr = await db().select().from(enrolments).where(eq(enrolments.assignmentId, row!.trainingAssignmentId!));
    expect(enr.map((e) => e.userId)).toContain(staff.userId);
    expect(action.training.enrolled).toBe(enr.length);
    // Manual assignment is refused once assigned.
    expect((await call(app, 'POST', `${A()}/actions/${action.id}/training`, { token: owner.token, body: { courseId } })).body.error.code).toBe('training_assigned');
  });

  it('reports trends per location, region and section with the most-failed items', async () => {
    const tr = await call(app, 'GET', `${A()}/trends?months=3`, { token: owner.token });
    expect(tr.status).toBe(200);
    expect(tr.body.totals.audits).toBe(1);
    expect(tr.body.sections.find((x: any) => x.title === 'Temperatures').averageScorePct).toBeLessThan(100);
    expect(tr.body.mostFailed[0]).toMatchObject({ questionId: 'fridge_temp', fails: 1, critical: true, trainingCourseId: courseId });
    expect(tr.body.regions[0]).toMatchObject({ regionId: west, audits: 1 });
    const theirs = await call(app, 'GET', `${A()}/trends?months=3`, { token: fo2.token });
    expect(theirs.body.totals.audits).toBe(0);
  });

  /* ------------------------------ self-checks ----------------------------- */

  it('runs self-checks at the location with reminders, kept apart from HQ audits', async () => {
    const st = await call(app, 'GET', `${SC()}/starters`, { token: owner.token });
    expect(st.body.items.map((x: any) => x.key)).toContain('temperature_log');
    expect((await call(app, 'POST', `${SC()}/templates`, { token: fo1.token, body: { starterKey: 'temperature_log' } })).status).toBe(403);
    const tpl = await call(app, 'POST', `${SC()}/templates`, { token: owner.token, body: { starterKey: 'temperature_log' } });
    expect(tpl.status).toBe(201);
    const body = { name: 'Morning temperature log', templateId: tpl.body.id, kind: 'food_safety', target: { kind: 'all', ids: [] }, dueTime: '00:01', remindMinutesBefore: 0 };
    expect((await call(app, 'POST', `${SC()}/schedules`, { token: fo1.token, body })).status).toBe(403);
    expect((await call(app, 'POST', `${SC()}/schedules`, { token: fo1.token, body: { ...body, name: 'Cascade closing', target: { kind: 'locations', ids: [sea, lon] } } })).status).toBe(403);
    expect((await call(app, 'POST', `${SC()}/schedules`, { token: fo1.token, body: { ...body, name: 'Cascade log', target: { kind: 'owner_group', ids: [g1] } } })).status).toBe(201);
    expect((await call(app, 'POST', `${SC()}/schedules`, { token: owner.token, body })).status).toBe(201);
    const today = await call(app, 'GET', `${SC()}/today`, { token: staff.token });
    expect(today.status).toBe(200);
    expect(today.body.items.every((x: any) => x.locationId === sea)).toBe(true);
    const run = today.body.items.find((x: any) => x.scheduleName === 'Morning temperature log');
    expect(run.canFill).toBe(true);
    expect((await call(app, 'GET', `${SC()}/runs/${run.id}`, { token: staff2.token })).status).toBe(404);
    const detail = await call(app, 'GET', `${SC()}/runs/${run.id}`, { token: staff.token });
    expect(detail.body.checklist.sections[0].questions[0].id).toBe('fridge_1');
    expect((await call(app, 'POST', `${SC()}/runs/${run.id}/complete`, { token: staff.token, body: { answers: { fridge_1: { value: 3 } } } })).body.error.code).toBe('audit_incomplete');
    const done = await call(app, 'POST', `${SC()}/runs/${run.id}/complete`, { token: staff.token, body: { answers: { fridge_1: { value: 3 }, fridge_2: { value: 8 }, freezer: { value: -20 }, hot_hold: { value: 70 }, probe_cleaned: { value: 'yes' }, dates_checked: { value: 'yes' } } } });
    expect(done.status).toBe(200);
    expect(done.body.criticalFailed).toBe(true);
    expect(done.body.failedItems.map((f: any) => f.questionId)).toEqual(['fridge_2']);
    // Reminders go to the location teams for the runs still open; yesterday's open runs become missed.
    const jobs = await runSelfCheckJobs(app.ctx, new Date(), orgId);
    expect(jobs.reminded).toBeGreaterThan(0);
    const open = await db().select().from(selfCheckRuns).where(and(eq(selfCheckRuns.organizationId, orgId), eq(selfCheckRuns.locationId, lon)));
    await db().update(selfCheckRuns).set({ date: '2026-01-01' }).where(eq(selfCheckRuns.id, open[0]!.id));
    expect((await runSelfCheckJobs(app.ctx, new Date(), orgId)).missed).toBeGreaterThanOrEqual(1);
    const dash = await call(app, 'GET', `${SC()}/dashboard?days=7`, { token: owner.token });
    expect(dash.body.totals.failed).toBe(1);
    expect(dash.body.failures[0].locationName).toBe('Seattle Ballard');
    const fo2dash = await call(app, 'GET', `${SC()}/dashboard?days=7`, { token: fo2.token });
    expect(fo2dash.body.failures).toEqual([]);
    // Self-checks never show up in HQ audit trends.
    expect((await call(app, 'GET', `${A()}/trends?months=3`, { token: owner.token })).body.totals.audits).toBe(1);
  });
});
