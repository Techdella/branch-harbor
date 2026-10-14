/**
 * Commerce demo data (sample data only) for Fieldnote Goods, extending seed-operations:
 *  - a fourth store (Rotterdam, EUR) so cross-store collection works in one currency (Amsterdam ↔ Rotterdam)
 *  - ~26 master products with option matrices, images, specs, fr/nl translations, collections, eligibility and
 *    local price ranges; distributed to the stores (one HQ edit left undistributed to show "update pending")
 *  - fulfilment settings and configured tax rates (Montréal GST+QST added; Amsterdam/Rotterdam BTW included; none in Portland)
 *  - WooCommerce authoritative in Portland (orders imported, native checkout off), native storefronts elsewhere
 *  - orders in every state, a transfer in transit, counts, suppliers & purchase orders, returns, gift cards
 * Idempotent: seed.ts recreates the demo organisations before this runs.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import type { Services } from '../context.ts';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { encrypt, sha256 } from '../lib/crypto.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import { runDistribution } from '../services/commerce-catalogue.ts';
import { ingestWooOrder } from '../services/commerce-woo.ts';
import { issueGiftCard } from '../services/commerce-returns.ts';

type User = typeof t.users.$inferSelect;
type Loc = typeof t.locations.$inferSelect;
type Variant = typeof t.variants.$inferSelect;

export interface CommerceSeedCtx {
  db: Db;
  orgId: string;
  demo: User;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
}

const DAY = 86400_000;
const img = (seed: string) => `https://images.unsplash.com/${seed}?w=1200&q=80&auto=format&fit=crop`;
const pi = () => `pi_seed_${randomBytes(8).toString('hex')}`;

type P = { sku: string; name: string; type: string; desc: string; options: Array<{ name: string; values: string[] }>; variants: Array<[string, string, Record<string, string>, { USD: number; CAD: number; EUR: number }]>; specs: Record<string, string>; collections: string[]; image: string; eligible?: string[]; backorder?: boolean; fr?: [string, string]; nl?: [string, string]; returnable?: boolean };

const CATALOGUE: P[] = [
  { sku: 'FN-NB', name: 'Field notebook', type: 'Notebooks', desc: 'Recycled paper, lay-flat binding.', options: [{ name: 'Format', values: ['A5', 'Pocket'] }, { name: 'Ruling', values: ['Dot grid', 'Ruled', 'Blank'] }], variants: [['FN-NB-DOT', 'A5 · Dot grid', { Format: 'A5', Ruling: 'Dot grid' }, { USD: 1800, CAD: 2400, EUR: 1700 }], ['FN-NB-RUL', 'A5 · Ruled', { Format: 'A5', Ruling: 'Ruled' }, { USD: 1800, CAD: 2400, EUR: 1700 }], ['FN-NB-PKT', 'Pocket · Blank', { Format: 'Pocket', Ruling: 'Blank' }, { USD: 1200, CAD: 1600, EUR: 1100 }]], specs: { Paper: '100 gsm, 100% recycled', Pages: '192 numbered pages', Binding: 'Lay-flat, thread-sewn', Size: 'A5: 148 × 210 mm · Pocket: 90 × 140 mm' }, collections: ['notebooks', 'gifts'], image: 'photo-1531346878377-a5be20888e57', fr: ['Carnet de terrain', 'Papier recyclé, reliure à plat.'], nl: ['Veldnotitieboek', 'Gerecycled papier, platliggende binding.'] },
  { sku: 'FN-PEN', name: 'Brass rollerball', type: 'Pens', desc: 'Machined brass, refillable.', options: [{ name: 'Finish', values: ['Raw brass', 'Black'] }], variants: [['FN-PEN-RAW', 'Raw brass', { Finish: 'Raw brass' }, { USD: 4800, CAD: 6400, EUR: 4500 }], ['FN-PEN-BLK', 'Black', { Finish: 'Black' }, { USD: 4800, CAD: 6400, EUR: 4500 }]], specs: { Body: 'Solid brass', Length: '138 mm', Weight: '34 g', Refill: 'Fieldnote rollerball refill (0.5 mm)' }, collections: ['writing', 'gifts'], image: 'photo-1583485088034-697b5bc54ccd', fr: ['Roller en laiton', 'Laiton usiné, rechargeable.'], nl: ['Messing rollerpen', 'Gefreesd messing, navulbaar.'] },
  { sku: 'FN-TOTE', name: 'Waxed canvas tote', type: 'Bags', desc: 'Heavyweight waxed canvas.', options: [{ name: 'Colour', values: ['Olive', 'Sand'] }], variants: [['FN-TOTE-OLV', 'Olive', { Colour: 'Olive' }, { USD: 6800, CAD: 8900, EUR: 6200 }], ['FN-TOTE-SND', 'Sand', { Colour: 'Sand' }, { USD: 6800, CAD: 8900, EUR: 6200 }]], specs: { Fabric: '18 oz waxed cotton canvas', Handles: 'Leather', Dimensions: '40 × 38 × 12 cm' }, collections: ['bags'], image: 'photo-1544816155-12df9643f363', fr: ['Cabas en toile cirée', 'Toile cirée épaisse.'], nl: ['Tas van gewaxt canvas', 'Zwaar gewaxt canvas.'] },
  { sku: 'FN-INK', name: 'Fountain pen ink', type: 'Ink', desc: '50 ml bottle.', options: [{ name: 'Colour', values: ['Harbour blue', 'Kelp green'] }], variants: [['FN-INK-BLU', 'Harbour blue', { Colour: 'Harbour blue' }, { USD: 2200, CAD: 2900, EUR: 2000 }], ['FN-INK-GRN', 'Kelp green', { Colour: 'Kelp green' }, { USD: 2200, CAD: 2900, EUR: 2000 }]], specs: { Volume: '50 ml', Bottle: 'Glass' }, collections: ['writing'], image: 'photo-1585336261022-680e295ce3fe', fr: ['Encre pour stylo plume', 'Flacon de 50 ml.'], nl: ['Vulpeninkt', 'Fles van 50 ml.'] },
  { sku: 'FN-SKB', name: 'Sketchbook', type: 'Notebooks', desc: 'Heavy paper for pencil, ink and light washes.', options: [{ name: 'Size', values: ['A4', 'A5'] }], variants: [['FN-SKB-A4', 'A4', { Size: 'A4' }, { USD: 2600, CAD: 3400, EUR: 2400 }], ['FN-SKB-A5', 'A5', { Size: 'A5' }, { USD: 1900, CAD: 2500, EUR: 1800 }]], specs: { Paper: '160 gsm', Pages: '80 pages', Binding: 'Lay-flat' }, collections: ['notebooks'], image: 'photo-1515023115689-589c33041d3c', fr: ['Carnet de croquis', 'Papier épais pour crayon, encre et lavis légers.'], nl: ['Schetsboek', 'Zwaar papier voor potlood, inkt en lichte washes.'] },
  { sku: 'FN-PLN', name: 'Weekly planner 2027', type: 'Planners', desc: 'Week-on-two-pages planner, January to December 2027.', options: [{ name: 'Cover', values: ['Navy', 'Rust'] }], variants: [['FN-PLN-NVY', 'Navy', { Cover: 'Navy' }, { USD: 2400, CAD: 3200, EUR: 2200 }], ['FN-PLN-RST', 'Rust', { Cover: 'Rust' }, { USD: 2400, CAD: 3200, EUR: 2200 }]], specs: { Layout: 'Week on two pages', Dates: 'January–December 2027', Language: 'English' }, collections: ['notebooks'], image: 'photo-1506784983877-45594efa4cbe', eligible: ['FG-PDX', 'FG-YUL'] },
  { sku: 'FN-PCL', name: 'Graphite pencils, set of 6', type: 'Pencils', desc: 'Cedar pencils in one grade.', options: [{ name: 'Grade', values: ['HB', '2B'] }], variants: [['FN-PCL-HB', 'HB', { Grade: 'HB' }, { USD: 1200, CAD: 1600, EUR: 1100 }], ['FN-PCL-2B', '2B', { Grade: '2B' }, { USD: 1200, CAD: 1600, EUR: 1100 }]], specs: { Wood: 'Cedar', Count: '6 pencils' }, collections: ['writing'], image: 'photo-1452860606245-08befc0ff44b', fr: ['Crayons graphite, lot de 6', 'Crayons en cèdre, une seule mine.'], nl: ['Grafietpotloden, set van 6', 'Cederhouten potloden in één hardheid.'] },
  { sku: 'FN-FPN', name: 'Steel fountain pen', type: 'Pens', desc: 'Everyday fountain pen with a steel nib.', options: [{ name: 'Nib', values: ['Fine', 'Medium'] }], variants: [['FN-FPN-F', 'Fine', { Nib: 'Fine' }, { USD: 3800, CAD: 5000, EUR: 3500 }], ['FN-FPN-M', 'Medium', { Nib: 'Medium' }, { USD: 3800, CAD: 5000, EUR: 3500 }]], specs: { Nib: 'Stainless steel', Filling: 'Converter included' }, collections: ['writing', 'gifts'], image: 'photo-1563986768609-322da13575f3', fr: ['Stylo plume acier', 'Stylo plume du quotidien, plume en acier.'], nl: ['Stalen vulpen', 'Vulpen voor elke dag met stalen penpunt.'] },
  { sku: 'FN-REF', name: 'Rollerball refills, pack of 2', type: 'Refills', desc: 'Refills for the brass rollerball.', options: [{ name: 'Colour', values: ['Black', 'Blue'] }], variants: [['FN-REF-BLK', 'Black', { Colour: 'Black' }, { USD: 800, CAD: 1100, EUR: 750 }], ['FN-REF-BLU', 'Blue', { Colour: 'Blue' }, { USD: 800, CAD: 1100, EUR: 750 }]], specs: { Tip: '0.5 mm', Count: '2 refills' }, collections: ['writing'], image: 'photo-1612886652368-ed74e0ba6d22', backorder: true },
  { sku: 'FN-ERS', name: 'Natural rubber eraser', type: 'Desk', desc: 'Soft eraser in a card sleeve.', options: [], variants: [['FN-ERS-1', 'Standard', {}, { USD: 400, CAD: 550, EUR: 350 }]], specs: { Material: 'Natural rubber' }, collections: ['desk'], image: 'photo-1589010588553-46e8e7c21788' },
  { sku: 'FN-SHP', name: 'Brass pencil sharpener', type: 'Desk', desc: 'Single-hole sharpener, solid brass.', options: [], variants: [['FN-SHP-1', 'Standard', {}, { USD: 900, CAD: 1200, EUR: 850 }]], specs: { Body: 'Solid brass', Blade: 'Replaceable steel blade' }, collections: ['desk'], image: 'photo-1588075592446-265fd1e6e76f' },
  { sku: 'FN-RUL', name: 'Aluminium ruler', type: 'Desk', desc: 'Anodised aluminium ruler.', options: [{ name: 'Length', values: ['15 cm', '30 cm'] }], variants: [['FN-RUL-15', '15 cm', { Length: '15 cm' }, { USD: 900, CAD: 1200, EUR: 850 }], ['FN-RUL-30', '30 cm', { Length: '30 cm' }, { USD: 1400, CAD: 1900, EUR: 1300 }]], specs: { Material: 'Anodised aluminium', Markings: 'Metric and inch' }, collections: ['desk'], image: 'photo-1611080626919-7cf5a9dbab5b' },
  { sku: 'FN-CLP', name: 'Binder clips, set of 12', type: 'Desk', desc: 'Black binder clips in three sizes.', options: [], variants: [['FN-CLP-12', 'Set of 12', {}, { USD: 600, CAD: 800, EUR: 550 }]], specs: { Count: '12 clips', Sizes: '15, 25 and 32 mm' }, collections: ['desk'], image: 'photo-1586281380349-632531db7ed4' },
  { sku: 'FN-DSK', name: 'Oak desk organiser', type: 'Desk', desc: 'Three compartments for pens, cards and notebooks.', options: [], variants: [['FN-DSK-1', 'Oak', {}, { USD: 5800, CAD: 7600, EUR: 5400 }]], specs: { Wood: 'Solid oak', Dimensions: '30 × 12 × 9 cm' }, collections: ['desk', 'gifts'], image: 'photo-1593062096033-9a26b09da705', fr: ['Organisateur de bureau en chêne', 'Trois compartiments pour stylos, cartes et carnets.'], nl: ['Eiken bureau-organizer', 'Drie vakken voor pennen, kaarten en notitieboeken.'] },
  { sku: 'FN-MAT', name: 'Cork desk mat', type: 'Desk', desc: 'Cork mat for writing and laptops.', options: [{ name: 'Size', values: ['Small', 'Large'] }], variants: [['FN-MAT-S', 'Small', { Size: 'Small' }, { USD: 2800, CAD: 3700, EUR: 2600 }], ['FN-MAT-L', 'Large', { Size: 'Large' }, { USD: 4200, CAD: 5500, EUR: 3900 }]], specs: { Material: 'Cork', Thickness: '3 mm', Sizes: 'Small 40 × 30 cm · Large 80 × 40 cm' }, collections: ['desk'], image: 'photo-1611269154421-4e27233ac5c7' },
  { sku: 'FN-PCS', name: 'Canvas pencil case', type: 'Bags', desc: 'Zip case for pens and pencils.', options: [{ name: 'Colour', values: ['Olive', 'Sand', 'Black'] }], variants: [['FN-PCS-OLV', 'Olive', { Colour: 'Olive' }, { USD: 2200, CAD: 2900, EUR: 2000 }], ['FN-PCS-SND', 'Sand', { Colour: 'Sand' }, { USD: 2200, CAD: 2900, EUR: 2000 }], ['FN-PCS-BLK', 'Black', { Colour: 'Black' }, { USD: 2200, CAD: 2900, EUR: 2000 }]], specs: { Fabric: 'Cotton canvas', Closure: 'Metal zip', Dimensions: '21 × 9 cm' }, collections: ['bags'], image: 'photo-1595085610978-0e0c5a5a5b3f', fr: ['Trousse en toile', 'Trousse zippée pour stylos et crayons.'], nl: ['Canvas etui', 'Etui met rits voor pennen en potloden.'] },
  { sku: 'FN-BKP', name: 'Roll-top backpack', type: 'Bags', desc: 'Roll-top backpack with laptop sleeve.', options: [{ name: 'Colour', values: ['Olive', 'Black'] }], variants: [['FN-BKP-OLV', 'Olive', { Colour: 'Olive' }, { USD: 14800, CAD: 19500, EUR: 13900 }], ['FN-BKP-BLK', 'Black', { Colour: 'Black' }, { USD: 14800, CAD: 19500, EUR: 13900 }]], specs: { Fabric: 'Waxed cotton canvas', Volume: '20 litres', 'Laptop sleeve': 'Fits devices up to 38 × 26 cm' }, collections: ['bags'], image: 'photo-1553062407-98eeb64c6a62', eligible: ['FG-AMS', 'FG-RTM', 'FG-PDX'], nl: ['Rolltop-rugzak', 'Rolltop-rugzak met laptopvak.'] },
  { sku: 'FN-WLT', name: 'Leather card wallet', type: 'Leather', desc: 'Slim wallet with four card slots.', options: [{ name: 'Colour', values: ['Tan', 'Black'] }], variants: [['FN-WLT-TAN', 'Tan', { Colour: 'Tan' }, { USD: 4400, CAD: 5800, EUR: 4100 }], ['FN-WLT-BLK', 'Black', { Colour: 'Black' }, { USD: 4400, CAD: 5800, EUR: 4100 }]], specs: { Leather: 'Vegetable-tanned leather', Slots: '4 card slots' }, collections: ['gifts'], image: 'photo-1627123424574-724758594e93', returnable: true },
  { sku: 'FN-STK', name: 'Sticky notes, recycled', type: 'Paper', desc: 'Pads of sticky notes in muted colours.', options: [], variants: [['FN-STK-6', 'Pack of 6 pads', {}, { USD: 700, CAD: 950, EUR: 650 }]], specs: { Paper: '100% recycled', Count: '6 pads of 75 sheets' }, collections: ['desk'], image: 'photo-1586953208448-b95a79798f07' },
  { sku: 'FN-LTR', name: 'Letter writing set', type: 'Paper', desc: 'Writing paper with matching envelopes.', options: [], variants: [['FN-LTR-1', '20 sheets + 10 envelopes', {}, { USD: 1600, CAD: 2100, EUR: 1500 }]], specs: { Paper: '120 gsm', Contents: '20 sheets, 10 envelopes' }, collections: ['gifts'], image: 'photo-1579541591970-e5795a602732', fr: ['Nécessaire de correspondance', 'Papier à lettres et enveloppes assorties.'] },
  { sku: 'FN-PST', name: 'Postcards, set of 10', type: 'Paper', desc: 'Illustrated postcards.', options: [{ name: 'Theme', values: ['Coast', 'City'] }], variants: [['FN-PST-CST', 'Coast', { Theme: 'Coast' }, { USD: 1400, CAD: 1800, EUR: 1300 }], ['FN-PST-CTY', 'City', { Theme: 'City' }, { USD: 1400, CAD: 1800, EUR: 1300 }]], specs: { Count: '10 postcards', Size: 'A6' }, collections: ['gifts'], image: 'photo-1566125882500-87e10f726cdc' },
  { sku: 'FN-WSH', name: 'Washi tape set', type: 'Paper', desc: 'Five rolls of paper tape.', options: [], variants: [['FN-WSH-5', 'Set of 5', {}, { USD: 1300, CAD: 1700, EUR: 1200 }]], specs: { Count: '5 rolls', Width: '15 mm' }, collections: ['desk', 'gifts'], image: 'photo-1612198188060-c7c2a3b66eae' },
  { sku: 'FN-JRN', name: 'Linen journal', type: 'Notebooks', desc: 'Linen-bound journal with ribbon marker.', options: [{ name: 'Colour', values: ['Rust', 'Sage'] }], variants: [['FN-JRN-RST', 'Rust', { Colour: 'Rust' }, { USD: 3200, CAD: 4200, EUR: 3000 }], ['FN-JRN-SGE', 'Sage', { Colour: 'Sage' }, { USD: 3200, CAD: 4200, EUR: 3000 }]], specs: { Cover: 'Linen', Pages: '240 pages', Marker: 'Ribbon' }, collections: ['notebooks', 'gifts'], image: 'photo-1544947950-fa07a98d237f', fr: ['Journal en lin', 'Journal relié en lin avec signet.'], nl: ['Linnen dagboek', 'In linnen gebonden dagboek met leeslint.'] },
  { sku: 'FN-BMK', name: 'Brass bookmark', type: 'Gifts', desc: 'Engraved brass bookmark.', options: [], variants: [['FN-BMK-1', 'Brass', {}, { USD: 1500, CAD: 2000, EUR: 1400 }]], specs: { Material: 'Brass', Length: '90 mm' }, collections: ['gifts'], image: 'photo-1592496431122-2349e0fbc666' },
  { sku: 'FN-GFT', name: 'Gift box', type: 'Gifts', desc: 'Card gift box with tissue.', options: [], variants: [['FN-GFT-1', 'Standard', {}, { USD: 500, CAD: 700, EUR: 450 }]], specs: { Material: 'Recycled card' }, collections: ['gifts'], image: 'photo-1549465220-1a8b9238cd48', returnable: false },
  { sku: 'FN-CAL', name: 'Desk calendar 2027', type: 'Planners', desc: 'Month-to-view desk calendar.', options: [], variants: [['FN-CAL-1', 'Standard', {}, { USD: 1800, CAD: 2400, EUR: 1700 }]], specs: { Layout: 'Month to view', Dates: 'January–December 2027' }, collections: [], image: 'photo-1506784365847-bbad939e9335' },
];

export async function seedCommerce(c: CommerceSeedCtx) {
  const { db, orgId } = c;
  const cfg = config();
  const now = Date.now();
  const [org] = await db.select().from(t.organizations).where(eq(t.organizations.id, orgId));
  if (!org) return;

  // ── Stores & people ──
  let locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const [rtm] = await db.insert(t.locations).values({
    organizationId: orgId, name: 'Rotterdam Witte de With', code: 'FG-RTM', slug: 'rotterdam', address: { line1: 'Witte de Withstraat 41', city: 'Rotterdam', postalCode: '3012 BM', country: 'NL' },
    country: 'NL', timeZone: 'Europe/Amsterdam', currency: 'EUR', locale: 'nl', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_fg_rtm', hours: { summary: 'Di–Za 10–18 uur' },
  }).onConflictDoNothing().returning();
  locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const by = (code: string) => locs.find((l) => l.code === code)!;
  const pdx = by('FG-PDX'); const yul = by('FG-YUL'); const ams = by('FG-AMS'); const rot = rtm ?? by('FG-RTM');
  await db.update(t.subscriptions).set({ billedLocationCount: 4 }).where(eq(t.subscriptions.organizationId, orgId));
  const noor = await c.upsertUser('noor.jansen@demo.branchharbor.com', 'Noor Jansen', 'nl');
  const daan = await c.upsertUser('daan.bakker@demo.branchharbor.com', 'Daan Bakker', 'nl');
  const claire = await c.upsertUser('claire.dubois@demo.branchharbor.com', 'Claire Dubois', 'fr');
  await db.insert(t.roleAssignments).values([
    { organizationId: orgId, userId: noor.id, role: 'staff', scopeKind: 'location', scopeId: ams.id },
    { organizationId: orgId, userId: daan.id, role: 'location_manager', scopeKind: 'location', scopeId: rot.id },
  ]).onConflictDoNothing();
  const managers = await db.select().from(t.roleAssignments).where(eq(t.roleAssignments.organizationId, orgId));
  const staffAt = (l: Loc) => managers.find((m) => m.scopeId === l.id)?.userId ?? c.demo.id;

  await db.update(t.organizations).set({ settings: sql`${t.organizations.settings} || ${JSON.stringify({ refundApprovalThresholds: { USD: 10000, CAD: 13000, EUR: 9000 } })}::jsonb` }).where(eq(t.organizations.id, orgId));

  // ── Catalogue ──
  const existing = await db.select().from(t.products).where(eq(t.products.organizationId, orgId));
  const productIds: Record<string, string> = {};
  const variantBySku: Record<string, Variant> = {};
  for (const p of CATALOGUE) {
    const eligibility = p.eligible ? { mode: 'selected' as const, locationIds: p.eligible.map((code) => by(code).id) } : { mode: 'all' as const, locationIds: [] };
    const values = {
      name: p.name, description: p.desc, slug: p.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''), vendor: 'Fieldnote Goods', productType: p.type, tags: p.collections,
      options: p.options, specs: p.specs, eligibility, priceBounds: { USD: { minPct: -10, maxPct: 10 }, CAD: { minPct: -10, maxPct: 10 }, ...(p.type === 'Notebooks' ? { EUR: { minPct: -5, maxPct: 5 } } : {}) },
      allowBackorder: !!p.backorder, returnable: p.returnable ?? true, status: p.sku === 'FN-CAL' ? 'draft' : 'active', images: [img(p.image)], updatedBy: c.demo.id, updatedAt: new Date(),
    };
    const cur = existing.find((e) => e.sku === p.sku);
    const [row] = cur ? await db.update(t.products).set(values).where(eq(t.products.id, cur.id)).returning() : await db.insert(t.products).values({ organizationId: orgId, sku: p.sku, ...values }).returning();
    productIds[p.sku] = row!.id;
    await db.delete(t.productImages).where(eq(t.productImages.productId, row!.id));
    await db.insert(t.productImages).values({ organizationId: orgId, productId: row!.id, url: img(p.image), alt: p.name, position: 0 });
    for (const [i, [sku, name, options, prices]] of p.variants.entries()) {
      const [v] = await db.insert(t.variants).values({ organizationId: orgId, productId: row!.id, sku, name, options, prices, position: i, barcode: `0${String(7_300_000_000_00 + Object.keys(variantBySku).length * 7 + i).padStart(12, '0')}` })
        .onConflictDoUpdate({ target: [t.variants.organizationId, t.variants.sku], set: { name, options, prices, position: i } }).returning();
      variantBySku[sku] = v!;
    }
    for (const [locale, tr] of [['fr', p.fr], ['nl', p.nl]] as const) {
      if (!tr) continue;
      await db.insert(t.commerceTranslations).values({ organizationId: orgId, entityType: 'product', entityId: row!.id, locale, fields: { name: tr[0], description: tr[1] } }).onConflictDoNothing();
    }
  }
  const COLL: Array<[string, string, string, string, string]> = [
    ['notebooks', 'Notebooks & journals', 'Carnets et journaux', 'Notitieboeken & dagboeken', 'Paper for every kind of note.'],
    ['writing', 'Writing tools', 'Instruments d’écriture', 'Schrijfgerei', 'Pens, pencils, ink and refills.'],
    ['bags', 'Bags & cases', 'Sacs et trousses', 'Tassen & etuis', 'Carry your kit.'],
    ['desk', 'Desk', 'Bureau', 'Bureau', 'Small things for a tidy desk.'],
    ['gifts', 'Gifts', 'Cadeaux', 'Cadeaus', 'Ideas for someone who writes things down.'],
  ];
  for (const [i, [slug, title, fr, nl, desc]] of COLL.entries()) {
    const [col] = await db.insert(t.collections).values({ organizationId: orgId, slug, title, description: desc, position: i }).returning();
    const members = CATALOGUE.filter((p) => p.collections.includes(slug)).map((p, pos) => ({ collectionId: col!.id, productId: productIds[p.sku]!, position: pos }));
    if (members.length) await db.insert(t.collectionProducts).values(members);
    await db.insert(t.commerceTranslations).values([
      { organizationId: orgId, entityType: 'collection', entityId: col!.id, locale: 'fr', fields: { title: fr } },
      { organizationId: orgId, entityType: 'collection', entityId: col!.id, locale: 'nl', fields: { title: nl } },
    ]);
  }

  // ── Storefront settings & configured taxes ──
  const settings = (l: Loc, o: Partial<typeof t.fulfilmentSettings.$inferInsert>) => db.insert(t.fulfilmentSettings).values({ organizationId: orgId, locationId: l.id, ...o }).onConflictDoNothing();
  await settings(pdx, { storefrontEnabled: false, pickupEnabled: true, pickupInstructions: 'Online orders are placed on our WooCommerce shop.' });
  await settings(yul, { pickupEnabled: true, pickupInstructions: 'Comptoir à l’entrée — apportez votre numéro de commande.', pickupReadyMinutes: 90, localDeliveryEnabled: true, deliveryFeeMinor: 800, freeDeliveryOverMinor: 7500, deliveryPostcodes: ['H2T', 'H2V', 'H2J', 'H2W'], shippingEnabled: true, shippingFeeMinor: 1200, shippingCountries: ['CA'], reservationMinutes: 15, returnWindowDays: 30 });
  await settings(ams, { pickupEnabled: true, pickupInstructions: 'Ophalen aan de kassa.', pickupReadyMinutes: 60, localDeliveryEnabled: true, deliveryFeeMinor: 495, freeDeliveryOverMinor: 5000, deliveryPostcodes: ['1013', '1015', '1016'], shippingEnabled: true, shippingFeeMinor: 695, shippingCountries: ['NL', 'BE', 'DE'], crossLocationPickup: true, reservationMinutes: 15, returnWindowDays: 30 });
  await settings(rot, { pickupEnabled: true, pickupInstructions: 'Ophalen aan de kassa.', pickupReadyMinutes: 60, crossLocationPickup: true, reservationMinutes: 15, returnWindowDays: 30 });
  await db.insert(t.taxRates).values([
    { organizationId: orgId, locationId: yul.id, name: 'GST/TPS', rateBps: 500, inclusive: false, position: 0, updatedBy: c.demo.id },
    { organizationId: orgId, locationId: yul.id, name: 'QST/TVQ', rateBps: 998, inclusive: false, position: 1, updatedBy: c.demo.id },
    { organizationId: orgId, locationId: ams.id, name: 'BTW', rateBps: 2100, inclusive: true, position: 0, updatedBy: c.demo.id },
    { organizationId: orgId, locationId: rot.id, name: 'BTW', rateBps: 2100, inclusive: true, position: 0, updatedBy: c.demo.id },
  ]);

  // ── Distribute (one HQ edit is left undistributed afterwards) ──
  const activeIds = CATALOGUE.filter((p) => p.sku !== 'FN-CAL').map((p) => productIds[p.sku]!);
  await runDistribution(db, orgId, activeIds, [pdx.id, yul.id, ams.id, rot.id], c.demo.id);
  await db.update(t.products).set({ description: 'Machined brass, refillable. Now with a knurled grip.', contentVersion: sql`${t.products.contentVersion} + 1` }).where(eq(t.products.id, productIds['FN-PEN']!));

  // ── Stock: receive new products; tidy legacy seeded orders ──
  const stores = [pdx, yul, ams, rot];
  const move = async (l: Loc, v: Variant, q: number, reason: string, o: { daysAgo?: number; note?: string; ref?: string; by?: string | null } = {}) => {
    await db.insert(t.locationVariants).values({ organizationId: orgId, locationId: l.id, variantId: v.id, currency: l.currency }).onConflictDoNothing();
    await db.insert(t.stockMovements).values({ organizationId: orgId, locationId: l.id, variantId: v.id, quantity: q, reason, note: o.note ?? null, reference: o.ref ?? null, createdBy: o.by === undefined ? staffAt(l) : o.by, createdAt: new Date(now - (o.daysAgo ?? 0) * DAY) });
    const reservation = reason === 'reservation' || reason === 'release';
    await db.update(t.locationVariants).set(reservation ? { reserved: sql`greatest(${t.locationVariants.reserved} - ${q}, 0)` } : { stockOnHand: sql`${t.locationVariants.stockOnHand} + ${q}` }).where(and(eq(t.locationVariants.locationId, l.id), eq(t.locationVariants.variantId, v.id)));
  };
  const legacy = new Set(['FN-NB-DOT', 'FN-NB-RUL', 'FN-NB-PKT', 'FN-PEN-RAW', 'FN-PEN-BLK', 'FN-TOTE-OLV', 'FN-TOTE-SND', 'FN-INK-BLU']);
  let n = 0;
  for (const [li, l] of stores.entries()) {
    for (const p of CATALOGUE) {
      if (p.sku === 'FN-CAL') continue;
      if (p.eligible && !p.eligible.includes(l.code)) continue;
      for (const [sku] of p.variants) {
        const v = variantBySku[sku]!;
        n++;
        if (!legacy.has(sku) || l.id === rot.id) {
          const qty = 6 + ((n * 7 + li * 3) % 19);
          await move(l, v, qty, 'received', { daysAgo: 24, note: `PO-${2300 + li}`, ref: `PO-${2300 + li}` });
          if (n % 9 === 0) await move(l, v, -1, 'damage', { daysAgo: 11, note: 'Corner crushed in delivery — written off' });
        }
        await db.update(t.locationVariants).set({ reorderPoint: 4, reorderQty: 12 }).where(and(eq(t.locationVariants.locationId, l.id), eq(t.locationVariants.variantId, v.id)));
      }
    }
  }
  const legacyOrders = await db.select().from(t.orders).where(eq(t.orders.organizationId, orgId));
  for (const o of legacyOrders) {
    const loc = locs.find((l) => l.id === o.locationId)!;
    const number = `${loc.code}-${900 + legacyOrders.indexOf(o)}`;
    if (o.source === 'shopify') {
      if (o.locationId === pdx.id) await db.update(t.orders).set({ source: 'woocommerce', externalId: o.externalId!.replace('#', ''), orderNumber: `WC-${o.externalId!.replace('#', '')}`, paymentStatus: 'external', externalStatus: 'processing', stockAppliedAt: o.createdAt, customerName: 'Taylor Brooks' }).where(eq(t.orders.id, o.id));
      else {
        const [p] = await db.insert(t.paymentReferences).values({ organizationId: orgId, locationId: o.locationId, provider: 'stripe', externalId: pi(), connectedAccountId: loc.stripeAccountId, amountMinor: o.totalMinor, currency: o.currency, state: 'succeeded', succeededAt: o.createdAt, targetType: 'order', targetId: o.id, sandbox: 1 }).returning();
        await db.update(t.orders).set({ source: 'native', externalId: null, orderNumber: number, paymentStatus: 'paid', paymentId: p!.id, paidAt: o.createdAt, customerName: 'Alex Moreau', customerEmail: 'alex.moreau@example.com' }).where(eq(t.orders.id, o.id));
      }
    } else if (o.status === 'pending_payment') {
      // Older unpaid order: release its hold now (it predates the reservation window).
      for (const l of o.lines) await move(loc, (await db.select().from(t.variants).where(eq(t.variants.id, l.variantId)))[0]!, l.quantity, 'release', { note: 'Payment window ended — reserved stock released', ref: o.id, by: null });
      await db.update(t.orders).set({ status: 'expired', paymentStatus: 'expired', fulfilmentStatus: 'cancelled', orderNumber: number, customerName: 'Sam Lee', cancelledAt: new Date(o.createdAt.getTime() + 15 * 60_000), lines: o.lines.map((l) => ({ ...l, allocated: 0 })), history: [{ at: o.createdAt.toISOString(), event: 'placed' }, { at: new Date(o.createdAt.getTime() + 15 * 60_000).toISOString(), event: 'expired', note: 'Payment window ended — reserved stock released' }] }).where(eq(t.orders.id, o.id));
    } else {
      await db.update(t.orders).set({ orderNumber: number, paymentStatus: 'paid', paidAt: o.createdAt, fulfilmentStatus: 'fulfilled', status: 'fulfilled', fulfilledAt: new Date(o.createdAt.getTime() + 3 * 3600_000), customerName: 'Jordan Park', customerEmail: 'jordan.park@example.com', lines: o.lines.map((l) => ({ ...l, allocated: l.quantity, backordered: 0 })) }).where(eq(t.orders.id, o.id));
    }
  }

  // ── Orders in every state ──
  const counters = new Map<string, number>();
  const nextNo = (l: Loc) => { const v = (counters.get(l.id) ?? 1000) + 1; counters.set(l.id, v); return `${l.code}-${v}`; };
  const V = (sku: string) => variantBySku[sku]!;
  const price = (l: Loc, v: Variant) => v.prices[l.currency]!;
  const taxFor = (l: Loc, subtotal: number, fee: number) => {
    if (l.id === yul.id) { const g = Math.round((subtotal + fee) * 0.05); const q = Math.round((subtotal + fee) * 0.0998); return { lines: [{ name: 'GST/TPS', rateBps: 500, inclusive: false, amountMinor: g }, { name: 'QST/TVQ', rateBps: 998, inclusive: false, amountMinor: q }], added: g + q }; }
    if (l.country === 'NL') return { lines: [{ name: 'BTW', rateBps: 2100, inclusive: true, amountMinor: Math.round(((subtotal + fee) * 2100) / 12100) }], added: 0 };
    return { lines: [], added: 0 };
  };
  const tokens: Array<{ label: string; url: string }> = [];
  interface OrderSpec { loc: Loc; lines: Array<[string, number]>; state: 'pending' | 'paid' | 'picking' | 'packed' | 'ready' | 'shipped' | 'collected' | 'delivered' | 'backordered' | 'cross' | 'conflict' | 'expired'; daysAgo: number; who: [string, string]; method?: 'pickup' | 'local_delivery' | 'shipping'; collectAt?: Loc; token?: string; refunded?: number; userId?: string | null }
  const created: Record<string, typeof t.orders.$inferSelect> = {};
  const place = async (key: string, sp: OrderSpec) => {
    const l = sp.loc;
    const at = new Date(now - sp.daysAgo * DAY);
    const method = sp.method ?? 'pickup';
    const lines = sp.lines.map(([sku, q]) => { const v = V(sku); const p = CATALOGUE.find((x) => x.variants.some((y) => y[0] === sku))!; return { variantId: v.id, sku, name: `${p.name} — ${v.name}`, productId: v.productId, productName: p.name, options: v.options, quantity: q, unitPriceMinor: price(l, v), allocated: q, backordered: 0 }; });
    if (sp.state === 'backordered') { lines[0]!.allocated = Math.max(0, lines[0]!.quantity - 2); lines[0]!.backordered = Math.min(2, lines[0]!.quantity); }
    if (sp.state === 'conflict') for (const x of lines) x.allocated = 0;
    const subtotal = lines.reduce((a, x) => a + x.unitPriceMinor * x.quantity, 0);
    const fee = method === 'shipping' ? (l.id === yul.id ? 1200 : 695) : method === 'local_delivery' ? (l.id === yul.id ? (subtotal >= 7500 ? 0 : 800) : (subtotal >= 5000 ? 0 : 495)) : 0;
    const tax = taxFor(l, subtotal, fee);
    const total = subtotal + fee + tax.added;
    const cust = await findOrCreateCustomer(db, orgId, l.id, { name: sp.who[0], email: sp.who[1] }, 'commerce_order');
    const paid = !['pending', 'expired'].includes(sp.state);
    const fulfilmentStatus: Record<OrderSpec['state'], string> = { pending: 'unfulfilled', paid: 'unfulfilled', picking: 'picking', packed: 'packed', ready: 'ready_for_pickup', shipped: 'fulfilled', collected: 'fulfilled', delivered: 'fulfilled', backordered: 'backordered', cross: 'awaiting_transfer', conflict: 'stock_conflict', expired: 'cancelled' };
    const done = ['shipped', 'collected', 'delivered'].includes(sp.state);
    const history: Array<{ at: string; event: string; note?: string }> = [{ at: at.toISOString(), event: 'placed', note: `Checkout on the ${l.name} storefront` }, ...(paid ? [{ at: new Date(at.getTime() + 60_000).toISOString(), event: 'paid', note: sp.state === 'conflict' ? 'Paid after the reservation expired and the stock was sold meanwhile — choose a recovery action' : 'Payment confirmed' }] : [])];
    if (done) history.push({ at: new Date(at.getTime() + 5 * 3600_000).toISOString(), event: 'fulfilled' });
    const [o] = await db.insert(t.orders).values({
      organizationId: orgId, locationId: l.id, customerId: cust.id, userId: sp.userId ?? null, source: 'native', orderNumber: nextNo(l),
      status: sp.state === 'expired' ? 'expired' : !paid ? 'pending_payment' : done ? (sp.refunded ? 'partially_refunded' : 'fulfilled') : 'paid',
      paymentStatus: sp.state === 'expired' ? 'expired' : !paid ? 'pending' : sp.refunded ? 'partially_refunded' : 'paid', fulfilmentStatus: fulfilmentStatus[sp.state], fulfilmentMethod: method,
      fulfilmentLocationId: sp.collectAt?.id ?? null, currency: l.currency, subtotalMinor: subtotal, taxMinor: tax.added, totalMinor: total, fulfilmentFeeMinor: fee, taxLines: tax.lines, refundedMinor: sp.refunded ?? 0,
      customerName: sp.who[0], customerEmail: sp.who[1], shippingAddress: method === 'pickup' ? null : { line1: l.country === 'CA' ? '4520 Av. du Parc' : 'Prinsengracht 300', city: l.address.city, postalCode: l.country === 'CA' ? 'H2V 4E4' : '1016 HX', country: l.country },
      lines: lines.map(({ ...x }) => x), reservationExpiresAt: sp.state === 'pending' ? new Date(now + 12 * 60_000) : null, manageTokenHash: sha256(sp.token ?? `seed-${key}-${randomBytes(6).toString('hex')}`),
      attention: sp.state === 'conflict' ? 'paid_after_expiry_no_stock' : null, history, createdAt: at, updatedAt: at, paidAt: paid ? new Date(at.getTime() + 60_000) : null, fulfilledAt: done ? new Date(at.getTime() + 5 * 3600_000) : null,
      cancelledAt: sp.state === 'expired' ? new Date(at.getTime() + 15 * 60_000) : null,
    }).returning();
    created[key] = o!;
    const state = sp.state === 'pending' ? 'created' : sp.state === 'expired' ? 'cancelled' : 'succeeded';
    const [p] = await db.insert(t.paymentReferences).values({ organizationId: orgId, locationId: l.id, provider: 'stripe', externalId: pi(), connectedAccountId: l.stripeAccountId, amountMinor: total, currency: l.currency, state, succeededAt: paid ? new Date(at.getTime() + 60_000) : null, targetType: 'order', targetId: o!.id, sandbox: 1, refundedMinor: sp.refunded ?? 0, refundState: sp.refunded ? 'partial' : 'none', clientSecret: `${pi()}_secret_sandbox` }).returning();
    await db.update(t.orders).set({ paymentId: p!.id }).where(eq(t.orders.id, o!.id));
    const days = sp.daysAgo;
    for (const x of lines) {
      const v = V(x.sku);
      if (sp.state === 'pending') await move(l, v, -x.quantity, 'reservation', { daysAgo: days, ref: o!.id, by: null, note: `Checkout ${o!.orderNumber}` });
      else if (sp.state === 'expired') { await move(l, v, -x.quantity, 'reservation', { daysAgo: days, ref: o!.id, by: null }); await move(l, v, x.quantity, 'release', { daysAgo: days - 0.01, ref: o!.id, by: null, note: 'Payment window ended — reserved stock released' }); }
      else if (sp.state === 'cross') await move(l, v, -x.quantity, 'reservation', { daysAgo: days, ref: o!.id, by: null, note: `Held for collection at ${sp.collectAt!.name}` });
      else if (sp.state === 'conflict') { /* nothing allocated */ }
      else if (x.allocated > 0) { await move(l, v, -x.allocated, 'reservation', { daysAgo: days, ref: o!.id, by: null }); await move(l, v, x.allocated, 'release', { daysAgo: days - 0.0007, ref: o!.id, by: null }); await move(l, v, -x.allocated, 'sale', { daysAgo: days - 0.0007, ref: o!.id, by: null }); }
    }
    const fStatus = sp.state === 'ready' ? 'ready' : ['picking', 'packed', 'shipped', 'collected', 'delivered'].includes(sp.state) ? sp.state : null;
    if (fStatus) {
      await db.insert(t.orderFulfilments).values({
        organizationId: orgId, orderId: o!.id, locationId: l.id, method, status: fStatus, lines: lines.map((x) => ({ variantId: x.variantId, sku: x.sku, name: x.name, quantity: x.allocated, picked: fStatus === 'picking' ? 0 : x.allocated })),
        carrier: fStatus === 'shipped' ? (l.country === 'CA' ? 'Postes Canada' : 'PostNL') : null, trackingNumber: fStatus === 'shipped' ? `3S${randomBytes(5).toString('hex').toUpperCase()}` : null,
        pickedBy: staffAt(l), createdAt: new Date(at.getTime() + 2 * 3600_000), completedAt: done ? new Date(at.getTime() + 5 * 3600_000) : null,
      });
    }
    if (sp.token) tokens.push({ label: `${o!.orderNumber} (${sp.state})`, url: `/fieldnote-goods/${l.slug}/shop/orders/${o!.id}?token=${sp.token}` });
    return o!;
  };

  const people: Array<[string, string]> = [['Claire Dubois', 'claire.dubois@demo.branchharbor.com'], ['Mathieu Roy', 'mathieu.roy@example.com'], ['Fatima El Idrissi', 'fatima@example.com'], ['Lotte de Wit', 'lotte.dewit@example.com'], ['Jesse Visser', 'jesse.visser@example.com'], ['Emma Bakker', 'emma.bakker@example.com'], ['Noah Smit', 'noah.smit@example.com'], ['Julie Tremblay', 'julie.tremblay@example.com']];
  // History for reports (fulfilled over the last four weeks).
  const hist: Array<[Loc, string, number]> = [[yul, 'FN-NB-DOT', 2], [yul, 'FN-PEN-RAW', 1], [yul, 'FN-JRN-RST', 1], [yul, 'FN-PCL-HB', 3], [yul, 'FN-SKB-A5', 1], [ams, 'FN-NB-DOT', 2], [ams, 'FN-TOTE-OLV', 1], [ams, 'FN-PCS-SND', 1], [ams, 'FN-FPN-F', 1], [ams, 'FN-STK-6', 4], [ams, 'FN-BKP-BLK', 1], [rot, 'FN-NB-RUL', 1], [rot, 'FN-WSH-5', 2], [rot, 'FN-LTR-1', 1], [ams, 'FN-JRN-SGE', 1], [yul, 'FN-DSK-1', 1], [rot, 'FN-PST-CST', 2], [ams, 'FN-PCL-2B', 2]];
  for (const [i, [l, sku, q]] of hist.entries()) await place(`h${i}`, { loc: l, lines: [[sku, q]], state: i % 3 === 0 ? 'shipped' : 'collected', method: i % 3 === 0 ? 'shipping' : 'pickup', daysAgo: 2 + ((i * 5) % 26), who: people[i % people.length]! });
  // Live states.
  await place('pending', { loc: yul, lines: [['FN-NB-RUL', 1], ['FN-PCL-2B', 1]], state: 'pending', daysAgo: 0.002, who: people[1]!, token: 'demo-order-pending-0001' });
  await place('paid', { loc: yul, lines: [['FN-SKB-A4', 1]], state: 'paid', daysAgo: 0.1, who: people[0]!, token: 'demo-order-paid-0002', userId: claire.id });
  await place('ready', { loc: yul, lines: [['FN-INK-BLU', 1], ['FN-FPN-M', 1]], state: 'ready', daysAgo: 0.3, who: people[7]!, token: 'demo-order-ready-0003' });
  await place('delivery', { loc: yul, lines: [['FN-MAT-L', 1]], state: 'packed', method: 'local_delivery', daysAgo: 0.2, who: people[2]! });
  const collected = await place('collected', { loc: yul, lines: [['FN-JRN-SGE', 1], ['FN-BMK-1', 1]], state: 'collected', daysAgo: 6, who: people[0]!, token: 'demo-order-collected-0004', userId: claire.id });
  await place('conflict', { loc: yul, lines: [['FN-PEN-BLK', 1]], state: 'conflict', daysAgo: 0.05, who: people[1]! });
  await place('picking', { loc: ams, lines: [['FN-NB-PKT', 2], ['FN-WSH-5', 1]], state: 'picking', daysAgo: 0.08, who: people[3]! });
  await place('shipped', { loc: ams, lines: [['FN-TOTE-SND', 1]], state: 'shipped', method: 'shipping', daysAgo: 1, who: people[4]!, token: 'demo-order-shipped-0005' });
  const amsReturned = await place('amsReturn', { loc: ams, lines: [['FN-PCS-BLK', 2]], state: 'collected', daysAgo: 9, who: people[5]! });
  const rotCredit = await place('rotCredit', { loc: rot, lines: [['FN-JRN-RST', 1]], state: 'collected', daysAgo: 12, who: people[6]! });
  const refOnHand = (await db.select().from(t.locationVariants).where(and(eq(t.locationVariants.locationId, rot.id), eq(t.locationVariants.variantId, V('FN-REF-BLU').id))))[0]!.stockOnHand;
  if (refOnHand > 1) await move(rot, V('FN-REF-BLU'), -(refOnHand - 1), 'supplier_return', { daysAgo: 3, note: 'Faulty batch returned to Atelier Laiton' });
  await place('backordered', { loc: rot, lines: [['FN-REF-BLU', 3]], state: 'backordered', daysAgo: 0.6, who: people[6]! });
  await place('expired', { loc: ams, lines: [['FN-DSK-1', 1]], state: 'expired', daysAgo: 2, who: people[4]! });
  await place('refunded', { loc: ams, lines: [['FN-NB-DOT', 3]], state: 'collected', daysAgo: 14, who: people[3]!, refunded: 1700 });
  const cross = await place('cross', { loc: ams, lines: [['FN-BKP-OLV', 1]], state: 'cross', collectAt: rot, daysAgo: 0.4, who: people[5]!, token: 'demo-order-collect-0006' });

  // ── Transfers ──
  const tr = (lines: Array<[string, number, number, number]>) => lines.map(([sku, q, s, r]) => ({ variantId: V(sku).id, sku, name: `${CATALOGUE.find((p) => p.variants.some((v) => v[0] === sku))!.name} — ${V(sku).name}`, quantity: q, shipped: s, received: r }));
  await db.insert(t.stockTransfers).values({ organizationId: orgId, number: 'TR-1001', fromLocationId: ams.id, toLocationId: rot.id, status: 'approved', orderId: cross.id, reason: `Customer collection for order ${cross.orderNumber}`, lines: tr([['FN-BKP-OLV', 1, 0, 0]]), history: [{ at: new Date(now - 0.4 * DAY).toISOString(), event: 'approved', note: 'Created automatically for a paid cross-store collection order' }], createdAt: new Date(now - 0.4 * DAY) });
  const transit = tr([['FN-NB-DOT', 6, 6, 0], ['FN-PCL-HB', 4, 4, 0]]);
  for (const x of transit) await move(ams, (await db.select().from(t.variants).where(eq(t.variants.id, x.variantId)))[0]!, -x.shipped, 'transfer_out', { daysAgo: 1, ref: 'TR-1002', note: 'Shipped on TR-1002', by: noor.id });
  await db.insert(t.stockTransfers).values({ organizationId: orgId, number: 'TR-1002', fromLocationId: ams.id, toLocationId: rot.id, status: 'in_transit', reason: 'Weekend restock for Rotterdam', lines: transit, requestedBy: daan.id, approvedBy: staffAt(ams), shippedBy: noor.id, carrier: 'Store van', shippedAt: new Date(now - DAY), createdAt: new Date(now - 2 * DAY), history: [{ at: new Date(now - 2 * DAY).toISOString(), event: 'requested', by: daan.id, note: 'Weekend restock for Rotterdam' }, { at: new Date(now - 1.5 * DAY).toISOString(), event: 'approved', by: staffAt(ams) }, { at: new Date(now - DAY).toISOString(), event: 'shipped', by: noor.id, note: '10 unit(s)' }] });
  await db.insert(t.stockTransfers).values({ organizationId: orgId, number: 'TR-1003', fromLocationId: rot.id, toLocationId: ams.id, status: 'requested', reason: 'Amsterdam is out of sage linen journals', lines: tr([['FN-JRN-SGE', 2, 0, 0]]), requestedBy: staffAt(ams), createdAt: new Date(now - 0.2 * DAY), history: [{ at: new Date(now - 0.2 * DAY).toISOString(), event: 'requested', note: 'Amsterdam is out of sage linen journals' }] });
  await db.insert(t.commerceCounters).values([{ organizationId: orgId, scope: 'transfer', value: 1003 }, ...stores.map((l) => ({ organizationId: orgId, scope: `order:${l.id}`, value: counters.get(l.id) ?? 1000 }))]).onConflictDoNothing();

  // ── Counts ──
  const [applied] = await db.insert(t.stockCounts).values({ organizationId: orgId, locationId: yul.id, name: 'Weekly count — writing', status: 'applied', createdBy: staffAt(yul), appliedBy: c.demo.id, createdAt: new Date(now - 5 * DAY), submittedAt: new Date(now - 5 * DAY), appliedAt: new Date(now - 5 * DAY) }).returning();
  const lvYul = async (sku: string) => (await db.select().from(t.locationVariants).where(and(eq(t.locationVariants.locationId, yul.id), eq(t.locationVariants.variantId, V(sku).id))))[0]!.stockOnHand;
  const e1 = await lvYul('FN-PCL-HB');
  await db.insert(t.stockCountLines).values([{ countId: applied!.id, variantId: V('FN-PCL-HB').id, expectedQty: e1, countedQty: e1 - 1, countedBy: staffAt(yul), countedAt: new Date(now - 5 * DAY) }, { countId: applied!.id, variantId: V('FN-PCL-2B').id, expectedQty: await lvYul('FN-PCL-2B'), countedQty: await lvYul('FN-PCL-2B'), countedBy: staffAt(yul), countedAt: new Date(now - 5 * DAY) }]);
  await move(yul, V('FN-PCL-HB'), -1, 'count', { daysAgo: 5, note: `Weekly count — writing: counted ${e1 - 1}, expected ${e1}`, ref: `COUNT-${applied!.id.slice(0, 8)}`, by: c.demo.id });
  const [inProgress] = await db.insert(t.stockCounts).values({ organizationId: orgId, locationId: ams.id, name: 'Shelf B — notebooks', createdBy: noor.id }).returning();
  const nbs = ['FN-NB-DOT', 'FN-NB-RUL', 'FN-NB-PKT', 'FN-SKB-A4', 'FN-SKB-A5', 'FN-JRN-RST', 'FN-JRN-SGE'];
  const amsStock = await db.select().from(t.locationVariants).where(and(eq(t.locationVariants.locationId, ams.id), inArray(t.locationVariants.variantId, nbs.map((s) => V(s).id))));
  await db.insert(t.stockCountLines).values(nbs.map((sku, i) => { const oh = amsStock.find((x) => x.variantId === V(sku).id)?.stockOnHand ?? 0; return { countId: inProgress!.id, variantId: V(sku).id, ...(i < 3 ? { expectedQty: oh, countedQty: i === 1 ? oh - 1 : oh, countedBy: noor.id, countedAt: new Date() } : {}) }; }));

  // ── Suppliers & purchase orders ──
  const [mill, laiton, canvas] = await db.insert(t.suppliers).values([
    { organizationId: orgId, name: 'Mill & Pulp Paper Co.', email: 'orders@millandpulp.example', currency: 'USD', leadTimeDays: 10 },
    { organizationId: orgId, name: 'Atelier Laiton', email: 'commandes@atelierlaiton.example', currency: 'EUR', leadTimeDays: 14 },
    { organizationId: orgId, name: 'Laurentian Canvas', email: 'sales@laurentiancanvas.example', currency: 'CAD', leadTimeDays: 7 },
  ]).returning();
  const poLines = (items: Array<[string, number, number, number]>) => items.map(([sku, q, r, cost]) => ({ variantId: V(sku).id, sku, name: `${CATALOGUE.find((p) => p.variants.some((v) => v[0] === sku))!.name} — ${V(sku).name}`, quantity: q, received: r, unitCostMinor: cost }));
  await db.insert(t.purchaseOrders).values([
    { organizationId: orgId, locationId: yul.id, supplierId: canvas!.id, number: 'PO-2401', status: 'sent', currency: 'CAD', lines: poLines([['FN-TOTE-OLV', 10, 0, 3600], ['FN-PCS-OLV', 12, 0, 1100]]), expectedAt: new Date(now + 3 * DAY), createdBy: c.demo.id, sentAt: new Date(now - 4 * DAY), createdAt: new Date(now - 4 * DAY) },
    { organizationId: orgId, locationId: rot.id, supplierId: laiton!.id, number: 'PO-2402', status: 'sent', currency: 'EUR', lines: poLines([['FN-REF-BLU', 20, 0, 300], ['FN-PEN-RAW', 6, 0, 1900]]), expectedAt: new Date(now + 5 * DAY), createdBy: daan.id, sentAt: new Date(now - 2 * DAY), createdAt: new Date(now - 2 * DAY) },
    { organizationId: orgId, locationId: ams.id, supplierId: mill!.id, number: 'PO-2403', status: 'draft', currency: 'USD', lines: poLines([['FN-NB-DOT', 30, 0, 650], ['FN-NB-RUL', 30, 0, 650]]), createdBy: c.demo.id },
  ]);
  await db.insert(t.commerceCounters).values({ organizationId: orgId, scope: 'po', value: 2403 }).onConflictDoNothing();

  // ── Returns ──
  const returnLine = (o: typeof t.orders.$inferSelect, q: number, extra: Record<string, unknown> = {}) => ({ variantId: o.lines[0]!.variantId, quantity: q, unitPriceMinor: o.lines[0]!.unitPriceMinor, name: o.lines[0]!.name, sku: o.lines[0]!.sku, ...extra });
  await db.insert(t.returns).values({ organizationId: orgId, locationId: yul.id, orderId: collected.id, status: 'requested', rmaNumber: 'RMA-5001', requestedVia: 'customer', customerEmail: collected.customerEmail, currency: 'CAD', reason: 'Le journal était abîmé à la livraison', lines: [returnLine(collected, 1, { reason: 'Damaged' })], history: [{ at: new Date(now - DAY).toISOString(), event: 'requested', note: 'Le journal était abîmé à la livraison' }], createdAt: new Date(now - DAY) });
  await move(ams, V('FN-PCS-BLK'), 1, 'return', { daysAgo: 1, note: 'RMA-5002: returned by customer', ref: 'RMA-5002' });
  await db.insert(t.returns).values({ organizationId: orgId, locationId: ams.id, orderId: amsReturned.id, status: 'received', rmaNumber: 'RMA-5002', requestedVia: 'customer', customerEmail: amsReturned.customerEmail, currency: 'EUR', reason: 'Bought two by mistake', lines: [returnLine(amsReturned, 1, { receivedQty: 1, disposition: 'restock' })], history: [{ at: new Date(now - 4 * DAY).toISOString(), event: 'requested' }, { at: new Date(now - 3 * DAY).toISOString(), event: 'reviewed', by: staffAt(ams) }, { at: new Date(now - 3 * DAY).toISOString(), event: 'authorised', by: staffAt(ams) }, { at: new Date(now - DAY).toISOString(), event: 'received', by: noor.id }], createdAt: new Date(now - 4 * DAY) });
  const [creditReturn] = await db.insert(t.returns).values({ organizationId: orgId, locationId: rot.id, orderId: rotCredit.id, status: 'resolved', resolution: 'store_credit', rmaNumber: 'RMA-5003', requestedVia: 'staff', customerEmail: rotCredit.customerEmail, currency: 'EUR', refundAmountMinor: rotCredit.lines[0]!.unitPriceMinor, lines: [returnLine(rotCredit, 1, { receivedQty: 1, disposition: 'write_off' })], history: [{ at: new Date(now - 6 * DAY).toISOString(), event: 'resolved', note: 'Store credit' }], createdAt: new Date(now - 7 * DAY) }).returning();
  await move(rot, V('FN-JRN-RST'), 1, 'return', { daysAgo: 6, note: 'RMA-5003: returned by customer', ref: 'RMA-5003' });
  await move(rot, V('FN-JRN-RST'), -1, 'damage', { daysAgo: 6, note: 'RMA-5003: returned item written off (not resaleable)', ref: 'RMA-5003' });
  await db.insert(t.commerceCounters).values({ organizationId: orgId, scope: 'rma', value: 5003 }).onConflictDoNothing();

  // ── Gift cards & store credit ──
  const credit = await issueGiftCard(db, { organizationId: orgId, kind: 'store_credit', currency: 'EUR', amountMinor: rotCredit.lines[0]!.unitPriceMinor, customerEmail: rotCredit.customerEmail, locationId: rot.id, reason: 'Return RMA-5003', by: daan.id, returnId: creditReturn!.id, code: 'FNSC-RTM-5003' });
  await db.update(t.returns).set({ giftCardId: credit.card.id }).where(eq(t.returns.id, creditReturn!.id));
  await issueGiftCard(db, { organizationId: orgId, kind: 'gift_card', currency: 'CAD', amountMinor: 5000, customerEmail: 'claire.dubois@demo.branchharbor.com', locationId: yul.id, reason: 'Gift card sale', by: c.demo.id, code: 'FNGT-MTL-2026' });
  await issueGiftCard(db, { organizationId: orgId, kind: 'gift_card', currency: 'EUR', amountMinor: 4000, customerEmail: null, locationId: ams.id, reason: 'Gift card sale', by: c.demo.id, code: 'FNGT-AMS-2026' });

  // ── WooCommerce stays authoritative in Portland ──
  const [conn] = await db.select().from(t.connections).where(and(eq(t.connections.organizationId, orgId), eq(t.connections.locationId, pdx.id)));
  const woo = { provider: 'woocommerce', kind: 'commerce', direction: 'import', authoritative: 'external', state: 'connected', config: { siteUrl: 'https://shop.fieldnotegoods.example' }, credentialsEncrypted: encrypt(JSON.stringify({ webhookSecret: 'fieldnote-woo-demo-secret' }), cfg.ENCRYPTION_KEY), lastSuccessAt: new Date(now - 3600_000) };
  const [wc] = conn ? await db.update(t.connections).set(woo).where(eq(t.connections.id, conn.id)).returning() : await db.insert(t.connections).values({ organizationId: orgId, locationId: pdx.id, ...woo }).returning();
  const sv = { db } as unknown as Services;
  const pdxPrice = (sku: string) => (V(sku).prices.USD! / 100).toFixed(2);
  const wooOrders = [
    { id: 4101, number: '4101', status: 'completed', currency: 'USD', date_created_gmt: new Date(now - 3 * DAY).toISOString().slice(0, 19), total: (Number(pdxPrice('FN-TOTE-SND'))).toFixed(2), billing: { first_name: 'Robin', last_name: 'Hale', email: 'robin.hale@example.com' }, line_items: [{ name: 'Waxed canvas tote — Sand', sku: 'FN-TOTE-SND', quantity: 1, price: pdxPrice('FN-TOTE-SND') }] },
    { id: 4102, number: '4102', status: 'processing', currency: 'USD', date_created_gmt: new Date(now - 0.3 * DAY).toISOString().slice(0, 19), total: (Number(pdxPrice('FN-NB-DOT')) * 2 + Number(pdxPrice('FN-INK-GRN'))).toFixed(2), billing: { first_name: 'Ana', last_name: 'Silva', email: 'ana.silva@example.com' }, line_items: [{ name: 'Field notebook — A5 · Dot grid', sku: 'FN-NB-DOT', quantity: 2, price: pdxPrice('FN-NB-DOT') }, { name: 'Fountain pen ink — Kelp green', sku: 'FN-INK-GRN', quantity: 1, price: pdxPrice('FN-INK-GRN') }] },
    { id: 4103, number: '4103', status: 'on-hold', currency: 'USD', date_created_gmt: new Date(now - 0.1 * DAY).toISOString().slice(0, 19), total: '12.00', billing: { first_name: 'Kai', email: 'kai@example.com' }, line_items: [{ name: 'Gift wrapping (WooCommerce add-on)', sku: 'WC-WRAP', quantity: 1, price: '12.00' }] },
  ];
  for (const o of wooOrders) await ingestWooOrder(sv, wc!, o);
  await db.insert(t.syncRuns).values({ organizationId: orgId, connectionId: wc!.id, status: 'partial', recordsProcessed: 3, recordsFailed: 0, startedAt: new Date(now - 3600_000), finishedAt: new Date(now - 3590_000) });

  // ── Done ──
  console.log(' Commerce:      Fieldnote Goods — 26 products, 4 stores (Rotterdam added). Portland: WooCommerce authoritative (link-out); native storefronts: Montréal, Amsterdam, Rotterdam');
  console.log('                Store associate: noor.jansen@demo.branchharbor.com (Amsterdam) · manager: daan.bakker@demo.branchharbor.com (Rotterdam) · customer: claire.dubois@demo.branchharbor.com');
  console.log('                Gift cards: FNGT-MTL-2026 (CAD 50.00), FNGT-AMS-2026 (EUR 40.00) · store credit FNSC-RTM-5003 (EUR)');
  for (const x of tokens) console.log(`                Order ${x.label}: ${x.url}`);
}
