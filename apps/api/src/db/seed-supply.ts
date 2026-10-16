/**
 * Demo data for the supplier network and audits phase 2 (demo site only, never `db:seed`). Called from seed-demo.ts
 * after seed-quality.ts.
 *
 * - Maple & Ember (foods): approved suppliers per country with catalogues linked to the ingredient inventory, the HQ
 *   approval threshold, five months of received orders (with a late delivery and damaged cases for the scorecards),
 *   an order waiting for HQ approval, one waiting for the supplier's confirmation (magic link printed), one confirmed
 *   and due tomorrow at Ballard (to receive on the phone), a partial delivery in London, off-contract purchases, two
 *   rebate programmes with a claim for last quarter, and a daily food-safety temperature log.
 * - Northlight Yoga (studios): recurring brand visits and quarterly cleanliness audits are assigned through the field
 *   consultant's portfolio (Isabel: the West Coast studios); Toronto, outside it, falls back to Jordan as the North
 *   America account manager. Visits are planned by distance; a failed item recommends a refresher
 *   course; locations run opening and closing self-checks every day (two weeks of history with a few misses and fails).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { SELF_CHECK_STARTERS, auditTemplateBodySchema, scoreAudit, type AuditAnswers, type PoLine } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { nextNumber } from '../services/commerce-stock.ts';
import { checklistOf } from '../services/audits.ts';
import { createClaim } from '../services/supply.ts';
import { runAuditSchedules } from '../services/audit-programmes.ts';

type User = typeof t.users.$inferSelect;
export interface SupplySeedInput { db: Db; today: string; upsertUser: (email: string, name: string, locale?: string) => Promise<User>; appUrl: string }

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const ev = (at: string, event: string, by?: string | null, note?: string | null) => ({ at, event, by: by ?? null, note: note ?? null });

export async function seedSupply({ db, today, appUrl, upsertUser }: SupplySeedInput) {
  const out = { suppliers: 0, orders: 0, selfChecks: 0, visits: 0, confirmLink: '', logins: [] as string[] };
  const s = { db, jobs: { enqueue: async () => {} }, cfg: { APP_URL: appUrl } } as unknown as Services;
  const d = (n: number) => addDays(today, n);
  const at = (day: string, hh = '10:00') => new Date(`${day}T${hh}:00Z`);

  /* ================================================================== */
  /* Maple & Ember: suppliers                                           */
  /* ================================================================== */
  const [me] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'maple-and-ember'));
  if (me) {
    const orgId = me.id;
    const [owner] = await db.select().from(t.users).where(eq(t.users.email, 'demo@branchharbor.com'));
    const [ren] = await db.select().from(t.users).where(eq(t.users.email, 'ren.ito@demo.branchharbor.com'));
    const [amelia] = await db.select().from(t.users).where(eq(t.users.email, 'amelia.hart@demo.branchharbor.com'));
    const [tiago] = await db.select().from(t.users).where(eq(t.users.email, 'tiago.santos@demo.branchharbor.com'));
    const [dee] = await db.select().from(t.users).where(eq(t.users.email, 'dee.walker@demo.branchharbor.com'));
    const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
    const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;
    const ings = await db.select().from(t.foodIngredients).where(eq(t.foodIngredients.organizationId, orgId));
    const ing = (n: string) => ings.find((i) => i.name === n)?.id ?? null;
    const by = owner?.id ?? null;

    await db.insert(t.supplySettings).values({ organizationId: orgId, approvalThresholds: { USD: 150_000, CAD: 200_000, GBP: 120_000, EUR: 130_000 }, updatedBy: by });

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const certFile = async (name: string) => (await db.insert(t.opsFiles).values({ organizationId: orgId, purpose: 'supplier_certificate', name, mime: 'application/pdf', size: pdf.length, sha256: sha(name), storage: 'db', storageKey: `${orgId}/private/supplier_certificate/${randomBytes(6).toString('hex')}.pdf`, data: pdf, uploadedBy: by }).returning())[0]!.id;

    const [cascadia, bermondsey, lisboa, pacificPack] = await db.insert(t.supplySuppliers).values([
      {
        organizationId: orgId, name: 'Cascadia Foodservice', code: 'CASC', countries: ['US', 'CA'], currency: 'USD', orderEmail: 'orders@cascadia-foodservice.example', orderFormat: 'both',
        contacts: [{ name: 'Dana Ruiz', role: 'Account manager', email: 'dana.ruiz@cascadia-foodservice.example', phone: '+1 206 555 0144', primary: true }, { name: 'Order desk', role: 'Orders', email: 'orders@cascadia-foodservice.example', phone: '+1 206 555 0100', primary: false }],
        contract: { reference: 'CASC-ME-2026', startsOn: `${today.slice(0, 4)}-01-01`, endsOn: `${Number(today.slice(0, 4)) + 1}-12-31`, paymentTerms: 'Net 30', notes: 'Proteins, dairy, dough and packaging. Delivery Tue/Thu/Sat before 9am. Rebate: proteins & dairy volume programme.' },
        notes: 'Primary broadline supplier for North America.', createdBy: by,
      },
      {
        organizationId: orgId, name: 'Bermondsey Provisions', code: 'BERM', countries: ['GB'], currency: 'GBP', orderEmail: 'orders@bermondsey-provisions.example', orderFormat: 'pdf',
        contacts: [{ name: 'Priya Patel', role: 'Trade sales', email: 'priya@bermondsey-provisions.example', phone: '+44 20 7946 0331', primary: true }],
        contract: { reference: 'BP-2026-14', startsOn: `${today.slice(0, 4)}-03-01`, endsOn: `${Number(today.slice(0, 4)) + 2}-02-28`, paymentTerms: 'Net 14', notes: 'Daily delivery except Sunday.' }, notes: '', createdBy: by,
      },
      {
        organizationId: orgId, name: 'Lisboa Hortícola', code: 'LISH', countries: ['PT'], currency: 'EUR', orderEmail: 'encomendas@lisboa-horticola.example', orderFormat: 'csv',
        contacts: [{ name: 'Inês Carvalho', role: 'Comercial', email: 'ines@lisboa-horticola.example', phone: '+351 21 555 0188', primary: true }],
        contract: { reference: 'LH-ME-07', startsOn: `${today.slice(0, 4)}-01-01`, endsOn: null, paymentTerms: '30 dias', notes: '' }, notes: 'Produce, eggs and dairy for Lisbon.', createdBy: by,
      },
      {
        organizationId: orgId, name: 'Pacific Packaging Co.', code: 'PPC', countries: ['US', 'CA'], status: 'suspended', currency: 'USD', orderEmail: 'sales@pacificpack.example', orderFormat: 'pdf',
        contacts: [{ name: 'Sam Lowe', role: 'Sales', email: 'sam@pacificpack.example', phone: null, primary: true }], contract: null, notes: 'Suspended after repeated short deliveries; use Cascadia packaging.', createdBy: by,
      },
    ]).returning();
    out.suppliers = 4;

    await db.insert(t.supplySupplierCertifications).values([
      { organizationId: orgId, supplierId: cascadia!.id, name: 'SQF food safety certificate', issuer: 'SQFI', reference: 'SQF-88231', expiresOn: d(240), fileId: await certFile('cascadia-sqf.pdf'), createdBy: by },
      { organizationId: orgId, supplierId: cascadia!.id, name: 'Organic handler certificate', issuer: 'Oregon Tilth', reference: 'OT-4471', expiresOn: d(18), fileId: await certFile('cascadia-organic.pdf'), createdBy: by },
      { organizationId: orgId, supplierId: cascadia!.id, name: 'Liability insurance', required: true, createdBy: by },
      { organizationId: orgId, supplierId: bermondsey!.id, name: 'Food hygiene rating 5', issuer: 'Southwark Council', reference: 'FHRS-5', expiresOn: d(400), fileId: await certFile('bermondsey-fhrs.pdf'), createdBy: by },
      { organizationId: orgId, supplierId: lisboa!.id, name: 'HACCP', issuer: 'ASAE', reference: 'HACCP-PT-1192', expiresOn: d(-6), fileId: await certFile('lisboa-haccp.pdf'), createdBy: by },
    ]);

    const item = (supplierId: string, sku: string, name: string, category: string, packLabel: string, unitsPerPack: number, prices: Record<string, number>, o: { moq?: number; lead?: number; ingredient?: string } = {}) => ({
      organizationId: orgId, supplierId, sku, name, category, packLabel, unitsPerPack, prices, moq: o.moq ?? 1, leadTimeDays: o.lead ?? 2, ingredientId: o.ingredient ? ing(o.ingredient) : null,
    });
    const items = await db.insert(t.supplyCatalogueItems).values([
      item(cascadia!.id, 'CASC-BRK-10', 'Brisket, choice, whole packer', 'Proteins', 'Case of 4 × 2.5 kg', 10_000, { USD: 11_900, CAD: 16_200 }, { moq: 2, lead: 3, ingredient: 'Brisket' }),
      item(cascadia!.id, 'CASC-CHK-10', 'Chicken thigh, boneless', 'Proteins', 'Case of 10 kg', 10_000, { USD: 6_400, CAD: 8_700 }, { moq: 2, lead: 2, ingredient: 'Chicken thigh' }),
      item(cascadia!.id, 'CASC-MOZ-6', 'Fior di latte mozzarella', 'Dairy', 'Case of 6 × 1 kg', 6_000, { USD: 5_850, CAD: 7_900 }, { lead: 2, ingredient: 'Mozzarella' }),
      item(cascadia!.id, 'CASC-OAT-12', 'Barista oat milk', 'Dairy', 'Case of 12 × 1 L', 12_000, { USD: 3_420, CAD: 4_560 }, { lead: 2, ingredient: 'Oat milk' }),
      item(cascadia!.id, 'CASC-EGG-180', 'Free-range eggs, large', 'Dairy', 'Case of 180', 180, { USD: 6_300, CAD: 8_400 }, { lead: 2, ingredient: 'Eggs' }),
      item(cascadia!.id, 'CASC-DGH-60', 'Pizza dough balls, 250 g', 'Bakery', 'Case of 60', 60, { USD: 4_800, CAD: 6_500 }, { moq: 2, lead: 4, ingredient: 'Pizza dough ball' }),
      item(cascadia!.id, 'CASC-TRT-48', 'Sweet tart shells, 10 cm', 'Bakery', 'Case of 48', 48, { USD: 3_100, CAD: 4_200 }, { lead: 5, ingredient: 'Tart shells' }),
      item(cascadia!.id, 'CASC-LEM-115', 'Lemons, fancy', 'Produce', 'Case of 115', 115, { USD: 5_200, CAD: 6_900 }, { lead: 1, ingredient: 'Lemons' }),
      item(cascadia!.id, 'CASC-BOX-200', 'Kraft bowl with lid, 32 oz', 'Packaging', 'Case of 200', 200, { USD: 7_600, CAD: 10_100 }, { lead: 5 }),
      item(cascadia!.id, 'CASC-GLV-1000', 'Nitrile gloves, black, L', 'Cleaning & safety', 'Case of 10 × 100', 1000, { USD: 6_900, CAD: 9_200 }, { lead: 3 }),
      item(bermondsey!.id, 'BP-BRK-5', 'Beef brisket, rolled', 'Proteins', '5 kg', 5_000, { GBP: 6_450 }, { lead: 1, ingredient: 'Brisket' }),
      item(bermondsey!.id, 'BP-EGG-360', 'Burford Brown eggs', 'Dairy', 'Tray case of 360', 360, { GBP: 9_800 }, { lead: 1, ingredient: 'Eggs' }),
      item(bermondsey!.id, 'BP-OAT-12', 'Oat drink, barista', 'Dairy', 'Case of 12 × 1 L', 12_000, { GBP: 2_640 }, { lead: 1, ingredient: 'Oat milk' }),
      item(bermondsey!.id, 'BP-BOX-250', 'Compostable bowls 750 ml', 'Packaging', 'Case of 250', 250, { GBP: 4_900 }, { lead: 2 }),
      item(lisboa!.id, 'LH-LIM-10', 'Limões, calibre 3', 'Produce', 'Caixa 10 kg', 80, { EUR: 1_890 }, { lead: 1, ingredient: 'Lemons' }),
      item(lisboa!.id, 'LH-OVO-180', 'Ovos classe M', 'Dairy', 'Caixa 180', 180, { EUR: 3_960 }, { lead: 1, ingredient: 'Eggs' }),
      item(lisboa!.id, 'LH-MOZ-6', 'Mozzarella fior di latte', 'Dairy', 'Caixa 6 × 1 kg', 6_000, { EUR: 4_980 }, { lead: 2, ingredient: 'Mozzarella' }),
      item(pacificPack!.id, 'PPC-BOX-300', 'Paper bowl 32 oz', 'Packaging', 'Case of 300', 300, { USD: 8_100 }, { lead: 7 }),
    ]).returning();
    const I = Object.fromEntries(items.map((i) => [i.sku, i])) as Record<string, (typeof items)[number]>;

    const mkLines = (cur: string, spec: Array<[string, number]>, recv?: Record<string, [number, number]>): PoLine[] => spec.map(([sku, q]) => {
      const i = I[sku]!;
      const unit = i.prices[cur]!;
      const [got, dmg] = recv?.[sku] ?? [0, 0];
      return { itemId: i.id, sku: i.sku, name: i.name, packLabel: i.packLabel, unitsPerPack: i.unitsPerPack, quantity: q, confirmedQuantity: q, received: got, damaged: dmg, unitPriceMinor: unit, totalMinor: unit * q, variantId: null, ingredientId: i.ingredientId };
    });
    const mkPo = async (o: { loc: string; supplierId: string; status: string; spec: Array<[string, number]>; created: string; recv?: Record<string, [number, number]>; expected?: string | null; delivered?: string | null; createdBy?: string | null; approval?: Record<string, unknown>; token?: string; confirmed?: boolean; history?: ReturnType<typeof ev>[]; notes?: string; closedShort?: boolean }) => {
      const loc = L[o.loc]!;
      const lines = mkLines(loc.currency, o.spec, o.recv);
      const number = `SPO-${await nextNumber(db, orgId, 'supply_po', 1000)}`;
      const sent = !['draft', 'pending_approval', 'rejected', 'approved'].includes(o.status);
      const [po] = await db.insert(t.supplyPurchaseOrders).values({
        organizationId: orgId, locationId: loc.id, supplierId: o.supplierId, number, status: o.status, currency: loc.currency, lines, totalMinor: lines.reduce((a, l) => a + l.totalMinor, 0),
        requestedDeliveryDate: o.expected ?? null, expectedDeliveryDate: o.expected ?? null, notes: o.notes ?? '', approval: (o.approval ?? { required: false, thresholdMinor: null }) as never,
        confirmTokenHash: o.token ? sha(o.token) : sent ? sha(randomBytes(12).toString('hex')) : null, confirmTokenExpiresAt: sent ? new Date(Date.now() + 60 * 86_400_000) : null,
        sentAt: sent ? at(o.created, '16:00') : null, sentTo: sent ? 'orders@supplier.example' : null, confirmedAt: o.confirmed ? at(o.created, '18:30') : null, supplierReference: o.confirmed ? `CONF-${number.slice(4)}` : null,
        firstDeliveryOn: o.delivered ?? null, receivedAt: o.status === 'received' ? at(o.delivered ?? o.created, '08:30') : null, closedShort: !!o.closedShort,
        history: o.history ?? [ev(at(o.created, '15:00').toISOString(), 'created', o.createdBy ?? null), ...(sent ? [ev(at(o.created, '16:00').toISOString(), 'sent', o.createdBy ?? null)] : [])],
        createdBy: o.createdBy ?? null, createdAt: at(o.created, '15:00'), updatedAt: at(o.delivered ?? o.created, '09:00'),
      }).returning();
      out.orders++;
      if (o.delivered && o.recv) {
        const rl = lines.filter((l) => l.received || l.damaged).map((l) => ({ itemId: l.itemId, received: l.received, damaged: l.damaged, outstandingBefore: l.quantity, outstandingAfter: Math.max(0, l.quantity - l.received), issue: l.damaged ? 'damaged' : l.received < l.quantity ? 'short' : null, note: l.damaged ? 'Case crushed in transit' : '' }));
        await db.insert(t.supplyReceipts).values({ organizationId: orgId, purchaseOrderId: po!.id, locationId: loc.id, receivedOn: o.delivered, lines: rl, issues: rl.filter((x) => x.issue).length, note: '', inventory: [], receivedBy: o.createdBy ?? null, createdAt: at(o.delivered, '08:30') });
      }
      return po!;
    };

    // Five months of received orders from Cascadia at the Seattle stores (USD, counted for the rebate) and Vancouver (CAD).
    const regular: Array<[string, number]> = [['CASC-BRK-10', 3], ['CASC-CHK-10', 4], ['CASC-MOZ-6', 3], ['CASC-DGH-60', 2], ['CASC-OAT-12', 2], ['CASC-EGG-180', 1]];
    for (let w = 21; w >= 1; w--) {
      for (const [code, who] of [['SEA-BL', ren?.id ?? by], ['SEA-FR', by], ['YVR-GT', by]] as const) {
        if (code === 'YVR-GT' && w % 2) continue;
        const created = d(-w * 7 - (code === 'SEA-FR' ? 1 : 0));
        const expected = addDays(created, 3);
        const late = (w === 6 && code === 'SEA-FR') || (w === 13 && code === 'SEA-BL');
        const damaged = w === 9 && code === 'SEA-BL';
        const short = w === 4 && code === 'YVR-GT';
        const recv: Record<string, [number, number]> = Object.fromEntries(regular.map(([sku, q]) => [sku, [sku === 'CASC-BRK-10' && damaged ? q - 1 : sku === 'CASC-DGH-60' && short ? q - 1 : q, sku === 'CASC-BRK-10' && damaged ? 1 : 0]]));
        await mkPo({ loc: code, supplierId: cascadia!.id, status: 'received', spec: regular, created, expected, delivered: late ? addDays(expected, 2) : expected, recv, createdBy: who, confirmed: true, closedShort: short });
      }
    }
    // London and Lisbon: a few received orders from their own country's suppliers.
    for (const w of [10, 7, 4, 2]) {
      await mkPo({ loc: 'LON-SP', supplierId: bermondsey!.id, status: 'received', spec: [['BP-BRK-5', 4], ['BP-EGG-360', 1], ['BP-OAT-12', 2]], created: d(-w * 7), expected: d(-w * 7 + 1), delivered: d(-w * 7 + 1), recv: { 'BP-BRK-5': [4, 0], 'BP-EGG-360': [1, 0], 'BP-OAT-12': [2, 0] }, createdBy: amelia?.id ?? by, confirmed: true });
      await mkPo({ loc: 'LIS-PR', supplierId: lisboa!.id, status: 'received', spec: [['LH-OVO-180', 2], ['LH-MOZ-6', 2], ['LH-LIM-10', 1]], created: d(-w * 7 - 2), expected: d(-w * 7 - 1), delivered: w === 7 ? d(-w * 7 + 1) : d(-w * 7 - 1), recv: { 'LH-OVO-180': [2, 0], 'LH-MOZ-6': [2, 0], 'LH-LIM-10': [1, 0] }, createdBy: tiago?.id ?? by, confirmed: true });
    }

    // Open orders for the demo.
    // Gastown's manager orders above the CAD threshold, so HQ approves it.
    const noor = await upsertUser('noor.haddad@demo.branchharbor.com', 'Noor Haddad');
    await db.insert(t.roleAssignments).values({ organizationId: orgId, userId: noor.id, role: 'location_manager', scopeKind: 'location', scopeId: L['YVR-GT']!.id }).onConflictDoNothing();
    const big = await mkPo({
      loc: 'YVR-GT', supplierId: cascadia!.id, status: 'pending_approval', spec: [['CASC-BRK-10', 8], ['CASC-CHK-10', 10], ['CASC-MOZ-6', 6], ['CASC-DGH-60', 6], ['CASC-BOX-200', 4], ['CASC-GLV-1000', 2]], created: d(-1), expected: d(4), createdBy: noor.id,
      approval: { required: true, thresholdMinor: 200_000, decision: null }, notes: 'Stock-up for the Gastown street festival weekend.',
      history: [ev(at(d(-1), '15:00').toISOString(), 'created', noor.id), ev(at(d(-1), '15:02').toISOString(), 'submitted_for_approval', noor.id)],
    });
    void big;
    const token = `demo-${randomBytes(18).toString('base64url')}`;
    await mkPo({ loc: 'SEA-FR', supplierId: cascadia!.id, status: 'sent', spec: [['CASC-BRK-10', 3], ['CASC-CHK-10', 3], ['CASC-LEM-115', 1], ['CASC-TRT-48', 2]], created: today, expected: d(3), createdBy: by, token, notes: 'Back door delivery before 9am please.' });
    out.confirmLink = `${appUrl.replace(/\/$/, '')}/supplier/${token}`;
    await mkPo({ loc: 'SEA-BL', supplierId: cascadia!.id, status: 'confirmed', spec: [['CASC-BRK-10', 3], ['CASC-CHK-10', 4], ['CASC-MOZ-6', 3], ['CASC-OAT-12', 2], ['CASC-LEM-115', 1], ['CASC-EGG-180', 1]], created: d(-2), expected: today, createdBy: ren?.id ?? by, confirmed: true });
    await mkPo({ loc: 'LON-SP', supplierId: bermondsey!.id, status: 'partially_received', spec: [['BP-BRK-5', 4], ['BP-EGG-360', 1], ['BP-BOX-250', 2]], created: d(-3), expected: d(-1), delivered: d(-1), recv: { 'BP-BRK-5': [3, 1], 'BP-EGG-360': [1, 0] }, createdBy: amelia?.id ?? by, confirmed: true });
    await mkPo({ loc: 'LIS-PR', supplierId: lisboa!.id, status: 'draft', spec: [['LH-OVO-180', 2], ['LH-LIM-10', 2]], created: today, createdBy: tiago?.id ?? by });

    await db.insert(t.supplyOffContract).values([
      { organizationId: orgId, locationId: L['SEA-FR']!.id, vendorName: 'QFC Fremont', description: 'Lemons (2 bags), ran out during Saturday brunch', category: 'Produce', amountMinor: 2_398, currency: 'USD', purchasedOn: d(-4), reason: 'out_of_stock', note: 'Cascadia delivery was a day late.', createdBy: by },
      { organizationId: orgId, locationId: L['YVR-GT']!.id, vendorName: 'Restaurant Depot Vancouver', description: 'Takeaway bowls and lids', category: 'Packaging', amountMinor: 18_450, currency: 'CAD', purchasedOn: d(-9), reason: 'price', note: 'Cheaper per case than the catalogue.', createdBy: by },
      { organizationId: orgId, locationId: L['LON-SP']!.id, vendorName: 'Costco Croydon', description: 'Kitchen roll and bin bags', category: 'Cleaning & safety', amountMinor: 4_620, currency: 'GBP', purchasedOn: d(-16), reason: 'not_in_catalogue', status: 'accepted', reviewNote: 'Fine: Bermondsey does not stock these. Added to the next catalogue review.', reviewedBy: by, reviewedAt: at(d(-14)), createdBy: amelia?.id ?? by },
    ]);

    // Rebates: tiered on spend (USD) with Cascadia, 25 % shared into the marketing fund; per case with Lisboa.
    const year = today.slice(0, 4);
    const [casRebate] = await db.insert(t.supplyRebateProgrammes).values([
      { organizationId: orgId, supplierId: cascadia!.id, name: 'Proteins & dairy volume rebate', basis: 'percent', measure: 'spend', currency: 'USD', tiers: [{ from: 0, rate: 150 }, { from: 2_000_000, rate: 250 }, { from: 4_000_000, rate: 350 }], period: 'quarter', startsOn: `${Number(year) - 1}-01-01`, itemIds: items.filter((i) => i.supplierId === cascadia!.id && ['Proteins', 'Dairy'].includes(i.category)).map((i) => i.id), fundSharePct: 25, createdBy: by },
      { organizationId: orgId, supplierId: lisboa!.id, name: 'Ovos: desconto por caixa', basis: 'per_unit', measure: 'units', currency: 'EUR', tiers: [{ from: 6, rate: 40 }, { from: 20, rate: 75 }], period: 'quarter', startsOn: `${year}-01-01`, itemIds: [items.find((i) => i.sku === 'LH-OVO-180')!.id], fundSharePct: 0, createdBy: by },
    ]).returning();
    const { rebatePeriodOf } = await import('@bh/shared');
    const prevQ = rebatePeriodOf('quarter', addDays(rebatePeriodOf('quarter', today).start, -1));
    try {
      const claim = await createClaim(db, casRebate!, prevQ.start, today, by!);
      await db.update(t.supplyRebateClaims).set({ status: 'submitted', submittedAt: at(d(-5)) }).where(eq(t.supplyRebateClaims.id, claim.id));
    } catch { /* nothing earned last quarter */ }

    // Self-check: daily food-safety temperature log at every Maple & Ember kitchen (a week of history, one warm fridge).
    const st = SELF_CHECK_STARTERS.find((x) => x.key === 'temperature_log')!;
    const [tpl] = await db.insert(t.auditTemplates).values({ organizationId: orgId, ...auditTemplateBodySchema.parse(st), starterKey: st.key, createdBy: by, updatedBy: by }).returning();
    const [sch] = await db.insert(t.selfCheckSchedules).values({ organizationId: orgId, name: 'Morning temperature log', templateId: tpl!.id, kind: 'food_safety', target: { kind: 'all', ids: [] }, weekdays: [0, 1, 2, 3, 4, 5, 6], dueTime: '11:00', remindMinutesBefore: 30, createdBy: by }).returning();
    const goodTemps: AuditAnswers = { fridge_1: { value: 3 }, fridge_2: { value: 4 }, freezer: { value: -20 }, hot_hold: { value: 68 }, probe_cleaned: { value: 'yes' }, dates_checked: { value: 'yes' } };
    for (const loc of locs.filter((l) => l.status === 'operating')) {
      for (let n = 7; n >= 0; n--) {
        const day = d(-n);
        const warm = loc.code === 'SEA-FR' && n === 2;
        const missed = loc.code === 'LIS-PR' && n === 4;
        const pending = n === 0 && loc.code === 'SEA-BL';
        const answers: AuditAnswers = warm ? { ...goodTemps, fridge_2: { value: 8, note: 'Door seal torn; moved stock to the walk-in, engineer called.' } } : goodTemps;
        const sc = scoreAudit(tpl!, answers);
        await db.insert(t.selfCheckRuns).values({
          organizationId: orgId, scheduleId: sch!.id, locationId: loc.id, date: day, dueAt: zonedToUtc(day, '11:00', loc.timeZone), checklist: checklistOf(tpl!),
          status: pending ? 'due' : missed ? 'missed' : 'completed', answers: pending || missed ? {} : answers,
          ...(pending || missed ? {} : { scoreTenths: sc.scorePct === null ? null : Math.round(sc.scorePct * 10), passed: sc.passed, criticalFailed: sc.criticalFailed, failedItems: sc.failedItems.map((f) => ({ questionId: f.questionId, text: tpl!.sections.flatMap((s2) => s2.questions).find((q) => q.id === f.questionId)?.text ?? f.questionId, reason: f.reason, critical: f.critical })), completedBy: loc.code === 'SEA-BL' ? dee?.id ?? null : null, completedAt: zonedToUtc(day, '10:20', loc.timeZone) }),
        });
        out.selfChecks++;
      }
    }
    out.logins.push('noor.haddad@demo.branchharbor.com (Gastown manager, order waiting for HQ approval)', 'ren.ito@demo.branchharbor.com (receives deliveries at Ballard)', 'dee.walker@demo.branchharbor.com (temperature log at Ballard)');
  }

  /* ================================================================== */
  /* Northlight: audits phase 2                                         */
  /* ================================================================== */
  const [nl] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'northlight-yoga'));
  if (nl) {
    const orgId = nl.id;
    const MAIL = 'northlight.demo.branchharbor.com';
    const user = async (local: string) => (await db.select().from(t.users).where(eq(t.users.email, `${local}@${MAIL}`)))[0];
    const [ops, jordan, ceo] = [await user('grace.kim'), await user('jordan.reyes'), await user('elena.marsh')];
    const regions = await db.select().from(t.regions).where(eq(t.regions.organizationId, orgId));
    const na = regions.find((r) => r.name === 'North America');
    const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
    const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;
    const geo: Record<string, { lat: number; lng: number }> = { 'TOR-AX': { lat: 43.6655, lng: -79.4106 }, 'YVR-MS': { lat: 49.2516, lng: -123.101 }, 'YVR-KT': { lat: 49.2684, lng: -123.156 }, 'PDX-PR': { lat: 45.525, lng: -122.681 }, 'LON-HK': { lat: 51.5452, lng: -0.0553 } };
    for (const [code, g] of Object.entries(geo)) if (L[code]) await db.update(t.locations).set({ geo: g }).where(eq(t.locations.id, L[code]!.id));
    if (jordan && na) await db.insert(t.accountManagers).values({ organizationId: orgId, userId: jordan.id, scopeKind: 'region', scopeId: na.id, title: 'Field consultant, North America', phone: '+1 604 555 0101' }).onConflictDoNothing();

    const templates = await db.select().from(t.auditTemplates).where(eq(t.auditTemplates.organizationId, orgId));
    const brand = templates.find((x) => x.starterKey === 'brand_standards');
    const clean = templates.find((x) => x.starterKey === 'cleanliness_safety');
    // A refresher course the brand checklist recommends when the brand-materials item fails.
    const [course] = await db.insert(t.courses).values({ organizationId: orgId, slug: 'brand-standards-refresher', title: 'Brand standards refresher', summary: 'Twenty minutes on current campaign materials, signage and the front-desk welcome.', status: 'published' } as typeof t.courses.$inferInsert).returning();
    if (brand && course) {
      const sections = brand.sections.map((sec) => ({ ...sec, questions: sec.questions.map((q) => (q.id === 'brand_materials' || q.id === 'current_campaign' ? { ...q, trainingCourseId: course.id, trainingAutoAssign: q.id === 'brand_materials' } : q)) }));
      await db.update(t.auditTemplates).set({ sections, version: brand.version + 1 }).where(eq(t.auditTemplates.id, brand.id));
      const open = await db.select().from(t.auditActions).where(and(eq(t.auditActions.organizationId, orgId), inArray(t.auditActions.questionId, ['brand_materials', 'current_campaign'])));
      for (const x of open) {
        let assignmentId: string | null = null;
        if (x.status !== 'verified' && x.questionId === 'brand_materials') {
          const [a] = await db.insert(t.trainingAssignments).values({ organizationId: orgId, targetType: 'course', targetId: course.id, audience: { locationIds: [x.locationId] }, dueAt: at(x.dueDate, '23:00'), source: 'audit', sourceRef: x.id, assignedBy: jordan?.id ?? null }).returning();
          assignmentId = a!.id;
          const people = await db.select({ userId: t.roleAssignments.userId }).from(t.roleAssignments).where(and(eq(t.roleAssignments.organizationId, orgId), eq(t.roleAssignments.scopeKind, 'location'), eq(t.roleAssignments.scopeId, x.locationId)));
          for (const [i, p] of people.entries()) await db.insert(t.enrolments).values({ organizationId: orgId, courseId: course.id, userId: p.userId, source: 'assignment', assignmentId, status: i === 0 ? 'completed' : 'active', completedAt: i === 0 ? at(d(-1)) : null, progressPct: i === 0 ? 100 : 40, dueAt: at(x.dueDate, '23:00') }).onConflictDoNothing();
        }
        await db.update(t.auditActions).set({ trainingCourseId: course.id, trainingAssignmentId: assignmentId }).where(eq(t.auditActions.id, x.id));
      }
    }
    // Recurring schedules: monthly brand visits across North America (field consultant), quarterly cleanliness everywhere.
    if (brand && clean && na) {
      await db.insert(t.auditSchedules).values([
        { organizationId: orgId, name: 'Monthly brand visit — North America', templateId: brand.id, target: { kind: 'region', ids: [na.id] }, frequency: 'monthly', interval: 1, anchorDate: d(6), leadDays: 14, auditorRule: 'field_consultant', auditorUserId: ops?.id ?? null, createdBy: ops?.id ?? ceo?.id ?? null },
        { organizationId: orgId, name: 'Quarterly cleanliness & safety', templateId: clean.id, target: { kind: 'all', ids: [] }, frequency: 'quarterly', interval: 1, anchorDate: d(40), leadDays: 21, auditorRule: 'field_consultant', auditorUserId: ops?.id ?? null, createdBy: ops?.id ?? ceo?.id ?? null },
      ]);
      out.visits = (await runAuditSchedules(s, new Date(), { organizationId: orgId })).created;
    }

    // Self-checks: opening and closing checks every day at every studio, two weeks of history.
    const by = ops?.id ?? null;
    const staffAt: Record<string, string | undefined> = { 'TOR-AX': (await user('ethan.brown'))?.id, 'YVR-KT': (await user('chloe.martin'))?.id, 'YVR-MS': (await user('liam.oconnor'))?.id, 'PDX-PR': (await user('ava.thompson'))?.id, 'LON-HK': (await user('noah.williams'))?.id };
    for (const key of ['opening_check', 'closing_check'] as const) {
      const st = SELF_CHECK_STARTERS.find((x) => x.key === key)!;
      const [tpl] = await db.insert(t.auditTemplates).values({ organizationId: orgId, ...auditTemplateBodySchema.parse(st), starterKey: st.key, createdBy: by, updatedBy: by }).returning();
      const [sch] = await db.insert(t.selfCheckSchedules).values({ organizationId: orgId, name: st.name, templateId: tpl!.id, kind: st.kind, target: { kind: 'all', ids: [] }, weekdays: [0, 1, 2, 3, 4, 5, 6], dueTime: key === 'opening_check' ? '06:15' : '21:45', remindMinutesBefore: 20, createdBy: by }).returning();
      const qs = tpl!.sections.flatMap((x) => x.questions);
      for (const loc of locs.filter((l) => l.status === 'operating')) {
        for (let n = 13; n >= 0; n--) {
          const day = d(-n);
          const missed = (loc.code === 'PDX-PR' && key === 'closing_check' && (n === 3 || n === 8)) || (loc.code === 'LON-HK' && key === 'opening_check' && n === 6);
          const failId = loc.code === 'YVR-KT' && key === 'closing_check' && n === 3 ? 'alarm_set' : loc.code === 'TOR-AX' && key === 'opening_check' && n === 5 ? 'restrooms_stocked' : null;
          const open = n === 0 && (key === 'closing_check' || ['YVR-KT', 'PDX-PR'].includes(loc.code ?? ''));
          const answers: AuditAnswers = Object.fromEntries(qs.map((q) => [q.id, { value: q.id === failId ? 'no' : 'yes', ...(q.id === failId ? { note: failId === 'alarm_set' ? 'Keypad fault; manager came back to set it at 23:10.' : 'Paper towels ran out; restocked by 7am.' } : {}) }]));
          const sc = scoreAudit(tpl!, answers);
          await db.insert(t.selfCheckRuns).values({
            organizationId: orgId, scheduleId: sch!.id, locationId: loc.id, date: day, dueAt: zonedToUtc(day, sch!.dueTime, loc.timeZone), checklist: checklistOf(tpl!),
            status: open ? 'due' : missed ? 'missed' : 'completed', answers: open || missed ? {} : answers,
            ...(open || missed ? {} : { scoreTenths: sc.scorePct === null ? null : Math.round(sc.scorePct * 10), passed: sc.passed, criticalFailed: sc.criticalFailed, failedItems: sc.failedItems.map((f) => ({ questionId: f.questionId, text: qs.find((q) => q.id === f.questionId)?.text ?? f.questionId, reason: f.reason, critical: f.critical })), completedBy: staffAt[loc.code ?? ''] ?? by, completedAt: zonedToUtc(day, key === 'opening_check' ? '06:05' : '21:40', loc.timeZone) }),
          });
          out.selfChecks++;
        }
      }
    }
    out.logins.push('isabel.reyes@northlight.demo.branchharbor.com (portfolio field consultant, visit planner)', 'jordan.reyes@northlight.demo.branchharbor.com (account manager fallback)');
  }
  return out;
}
