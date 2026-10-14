/**
 * Sample-mode commerce backend: same paths and response shapes as /v1/orgs/:orgId/commerce/*, in memory.
 * Fieldnote Goods sample stores (Portland, San Francisco, Montréal, Amsterdam, Austin) from the shared fixtures.
 * Rules mirrored from the server: price bounds, stock ledger, transfer and return state machines, per-currency money.
 */
import { ApiError } from '../errors';
import type { Query } from '../http/client';
import { FIXTURES, unsplash } from '../mock/orgs';
import type {
  Alert, AssortmentItem, CatalogueItem, Collection, CountDetail, Distribution, GiftCard, Movement, PlanItem, ProductDetail, PurchaseOrderView, ReturnView, SalesOrder, StoreSettings, Supplier, TransferView,
} from './types';

const LOCS = FIXTURES.commerce.locations.map((l) => ({ id: l.id, name: l.name, currency: l.currency as string, country: l.address.country, timeZone: l.timeZone }));
const now = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let seq = 100;
const id = (p: string) => `${p}_${++seq}`;
const m = (amount: number, currency: string) => ({ amount, currency });
const fail = (status: number, code: string, message: string, fields?: Record<string, string>) => { throw new ApiError(code, message, status, fields); };
const locName = (lid: string) => LOCS.find((l) => l.id === lid)?.name ?? lid;
const cur = (lid: string) => LOCS.find((l) => l.id === lid)?.currency ?? 'USD';

type P = ProductDetail;
const PRODUCTS: P[] = [];
const mkProduct = (sku: string, name: string, type: string, img: string, options: P['options'], vs: Array<[string, string, Record<string, string>, number, number, number]>, specs: Record<string, string>, extra: Partial<P> = {}): P => ({
  id: `p_${sku.toLowerCase()}`, sku, name, description: `${name}. ${Object.values(specs)[0] ?? ''}`.trim(), slug: sku.toLowerCase(), vendor: 'Fieldnote Goods', productType: type, tags: [], status: 'active', options, specs,
  eligibility: { mode: 'all', locationIds: [] }, priceBounds: { USD: { minPct: -10, maxPct: 10 }, CAD: { minPct: -10, maxPct: 10 } }, allowBackorder: false, returnable: true, contentVersion: 1,
  variants: vs.map(([vsku, vname, opts, usd, cad, eur]) => ({ id: `v_${vsku.toLowerCase()}`, sku: vsku, name: vname, options: opts, prices: { USD: usd, CAD: cad, EUR: eur }, barcode: null, imageUrl: null, status: 'active' })),
  images: [{ url: unsplash(img, 900), alt: name, variantId: null }], translations: {}, collectionIds: [], lockedFields: ['sku', 'name', 'description', 'images', 'options', 'variants.sku', 'translations'], listings: [], ...extra,
});
PRODUCTS.push(
  mkProduct('FN-NB', 'Field notebook', 'Notebooks', '1531346878377-a5be20888e57', [{ name: 'Ruling', values: ['Dot grid', 'Ruled', 'Blank'] }], [['FN-NB-DOT', 'Dot grid', { Ruling: 'Dot grid' }, 1800, 2400, 1700], ['FN-NB-RUL', 'Ruled', { Ruling: 'Ruled' }, 1800, 2400, 1700], ['FN-NB-BLK', 'Blank', { Ruling: 'Blank' }, 1800, 2400, 1700]], { Paper: '100 gsm, 100% recycled', Pages: '192 numbered pages', Binding: 'Lay-flat' }, { translations: { fr: { name: 'Carnet de terrain', description: 'Papier recyclé, reliure à plat.' }, nl: { name: 'Veldnotitieboek' } } }),
  mkProduct('FN-PEN', 'Brass rollerball', 'Pens', '1583485088034-697b5bc54ccd', [{ name: 'Finish', values: ['Raw brass', 'Black'] }], [['FN-PEN-RAW', 'Raw brass', { Finish: 'Raw brass' }, 4800, 6400, 4500], ['FN-PEN-BLK', 'Black', { Finish: 'Black' }, 4800, 6400, 4500]], { Body: 'Solid brass', Length: '138 mm' }, { contentVersion: 2 }),
  mkProduct('FN-TOTE', 'Waxed canvas tote', 'Bags', '1544816155-12df9643f363', [{ name: 'Colour', values: ['Olive', 'Sand'] }], [['FN-TOTE-OLV', 'Olive', { Colour: 'Olive' }, 6800, 8900, 6200], ['FN-TOTE-SND', 'Sand', { Colour: 'Sand' }, 6800, 8900, 6200]], { Fabric: '18 oz waxed canvas' }),
  mkProduct('FN-INK', 'Fountain pen ink', 'Ink', '1585336261022-680e295ce3fe', [{ name: 'Colour', values: ['Harbour blue', 'Kelp green'] }], [['FN-INK-BLU', 'Harbour blue', { Colour: 'Harbour blue' }, 2200, 2900, 2000], ['FN-INK-GRN', 'Kelp green', { Colour: 'Kelp green' }, 2200, 2900, 2000]], { Volume: '50 ml' }),
  mkProduct('FN-JRN', 'Linen journal', 'Notebooks', '1544947950-fa07a98d237f', [{ name: 'Colour', values: ['Rust', 'Sage'] }], [['FN-JRN-RST', 'Rust', { Colour: 'Rust' }, 3200, 4200, 3000], ['FN-JRN-SGE', 'Sage', { Colour: 'Sage' }, 3200, 4200, 3000]], { Cover: 'Linen', Pages: '240' }),
  mkProduct('FN-PCL', 'Graphite pencils, set of 6', 'Pencils', '1452860606245-08befc0ff44b', [{ name: 'Grade', values: ['HB', '2B'] }], [['FN-PCL-HB', 'HB', { Grade: 'HB' }, 1200, 1600, 1100], ['FN-PCL-2B', '2B', { Grade: '2B' }, 1200, 1600, 1100]], { Wood: 'Cedar' }),
  mkProduct('FN-DSK', 'Oak desk organiser', 'Desk', '1593062096033-9a26b09da705', [], [['FN-DSK-1', 'Oak', {}, 5800, 7600, 5400]], { Wood: 'Solid oak' }),
  mkProduct('FN-REF', 'Rollerball refills, pack of 2', 'Refills', '1612886652368-ed74e0ba6d22', [{ name: 'Colour', values: ['Black', 'Blue'] }], [['FN-REF-BLK', 'Black', { Colour: 'Black' }, 800, 1100, 750], ['FN-REF-BLU', 'Blue', { Colour: 'Blue' }, 800, 1100, 750]], { Tip: '0.5 mm' }, { allowBackorder: true }),
  mkProduct('FN-CAL', 'Desk calendar 2027', 'Planners', '1506784365847-bbad939e9335', [], [['FN-CAL-1', 'Standard', {}, 1800, 2400, 1700]], { Layout: 'Month to view' }, { status: 'draft' }),
);
const variants = () => PRODUCTS.flatMap((p) => p.variants.map((v) => ({ p, v })));
const vById = (vid: string) => variants().find((x) => x.v.id === vid);

// Listings & stock
const LISTINGS = new Map<string, { version: number; status: string }>();
type LV = { onHand: number; reserved: number; priceMinor: number | null; available: boolean; reorderPoint: number | null; reorderQty: number | null; priceSetBy: string | null; allowBackorder: boolean | null };
const LV = new Map<string, LV>();
const key = (a: string, b: string) => `${a}:${b}`;
const MOVES: Movement[] = [];
const lvOf = (lid: string, vid: string): LV => { let x = LV.get(key(lid, vid)); if (!x) { x = { onHand: 0, reserved: 0, priceMinor: null, available: true, reorderPoint: 4, reorderQty: 12, priceSetBy: null, allowBackorder: null }; LV.set(key(lid, vid), x); } return x; };
function move(lid: string, vid: string, q: number, reason: string, note: string | null = null, ref: string | null = null, at = now()) {
  const x = lvOf(lid, vid);
  const res = reason === 'reservation' || reason === 'release';
  if (res) x.reserved = Math.max(0, x.reserved - q); else x.onHand += q;
  const pv = vById(vid)!;
  MOVES.unshift({ id: id('mv'), locationId: lid, variantId: vid, quantity: q, reason, reasonLabel: LABEL[reason] ?? reason, note, reference: ref, affectsOnHand: !res, balanceAfter: res ? null : x.onHand, createdAt: at, createdByName: 'Leah Park', variant: { sku: pv.v.sku, name: pv.v.name, productName: pv.p.name }, location: { name: locName(lid), timeZone: LOCS.find((l) => l.id === lid)!.timeZone } });
}
const LABEL: Record<string, string> = { adjustment: 'Adjustment', count: 'Stock count', received: 'Received', sale: 'Sale', return: 'Return', damage: 'Damaged / write-off', transfer_in: 'Transfer in', transfer_out: 'Transfer out', reservation: 'Reserved for unpaid order', release: 'Reservation released', shrinkage: 'Shrinkage (loss/theft)', found: 'Found stock', correction: 'Correction', supplier_return: 'Returned to supplier' };
let n = 0;
for (const l of LOCS) for (const p of PRODUCTS) {
  if (p.status !== 'active') continue;
  LISTINGS.set(key(l.id, p.id), { version: p.sku === 'FN-PEN' ? 1 : p.contentVersion, status: 'listed' });
  for (const v of p.variants) { n++; move(l.id, v.id, 4 + ((n * 7) % 21), 'received', 'PO-2300', 'PO-2300', ago(500)); }
}
move('pd', 'v_fn-ref-blu', -lvOf('pd', 'v_fn-ref-blu').onHand + 1, 'sale', null, null, ago(30));
lvOf('pd', 'v_fn-nb-dot').priceMinor = 1900; lvOf('pd', 'v_fn-nb-dot').priceSetBy = 'Leah Park';
lvOf('me', 'v_fn-tote-snd').available = false;

// Orders
const ORDERS: SalesOrder[] = [];
function mkOrder(lid: string, lines: Array<[string, number]>, state: { status: string; payment: string; fulfilment: string; method?: SalesOrder['fulfilmentMethod']; hours: number; who: string; source?: string; attention?: string | null; collect?: string }): SalesOrder {
  const c = cur(lid);
  const ls = lines.map(([vid, q]) => { const pv = vById(vid)!; const unit = lvOf(lid, vid).priceMinor ?? pv.v.prices[c]!; return { variantId: vid, sku: pv.v.sku, name: `${pv.p.name} — ${pv.v.name}`, quantity: q, unitPrice: m(unit, c), lineTotal: m(unit * q, c), allocated: state.fulfilment === 'backordered' ? q - 1 : q, backordered: state.fulfilment === 'backordered' ? 1 : 0 }; });
  const sub = ls.reduce((a, l) => a + l.lineTotal.amount, 0);
  const tax = c === 'CAD' ? [{ name: 'GST/TPS', rateBps: 500, inclusive: false, amount: m(Math.round(sub * 0.05), c) }, { name: 'QST/TVQ', rateBps: 998, inclusive: false, amount: m(Math.round(sub * 0.0998), c) }] : c === 'EUR' ? [{ name: 'BTW', rateBps: 2100, inclusive: true, amount: m(Math.round((sub * 2100) / 12100), c) }] : [];
  const total = sub + tax.filter((t) => !t.inclusive).reduce((a, t) => a + t.amount.amount, 0);
  const no = `${lid.toUpperCase()}-${1000 + ORDERS.length + 1}`;
  const o: SalesOrder = {
    id: id('ord'), number: state.source === 'woocommerce' ? `WC-${4100 + ORDERS.length}` : no, source: state.source ?? 'native', externalId: state.source === 'woocommerce' ? String(4100 + ORDERS.length) : null, authoritativeSystem: state.source === 'woocommerce' ? 'woocommerce' : 'branchharbor',
    locationId: lid, locationName: locName(lid), timeZone: LOCS.find((l) => l.id === lid)!.timeZone, fulfilmentLocationId: state.collect ?? lid, fulfilmentLocationName: locName(state.collect ?? lid), crossLocation: !!state.collect,
    status: state.status, paymentStatus: state.payment, fulfilmentStatus: state.fulfilment, fulfilmentMethod: state.method ?? 'pickup', externalStatus: state.source === 'woocommerce' ? 'processing' : null,
    currency: c, lines: ls, subtotal: m(sub, c), fulfilmentFee: m(0, c), taxLines: tax, total: m(total, c), creditApplied: m(0, c), amountDue: m(total, c), refunded: m(0, c),
    reservationExpiresAt: state.status === 'pending_payment' ? new Date(Date.now() + 11 * 60_000).toISOString() : null, attention: state.attention ?? null,
    customer: { name: state.who, email: `${state.who.split(' ')[0]!.toLowerCase()}@example.com`, phone: null }, shippingAddress: null, notes: null,
    history: [{ at: ago(state.hours), event: 'placed' }, ...(state.payment === 'paid' ? [{ at: ago(state.hours - 0.01), event: 'paid', note: state.attention ? 'Paid after the reservation expired and the stock was sold meanwhile — choose a recovery action' : 'Payment confirmed' }] : [])],
    createdAt: ago(state.hours), paidAt: state.payment === 'paid' ? ago(state.hours) : null, fulfilledAt: state.fulfilment === 'fulfilled' ? ago(state.hours - 2) : null, fulfilments: [], transfer: null,
  };
  for (const l of ls) {
    if (state.status === 'pending_payment' || state.collect) move(lid, l.variantId, -l.quantity, 'reservation', `Checkout ${o.number}`, o.id, o.createdAt);
    else if (state.payment === 'paid' && !state.attention) move(lid, l.variantId, -(l.allocated ?? l.quantity), 'sale', null, o.id, o.createdAt);
  }
  if (['picking', 'packed', 'ready_for_pickup'].includes(state.fulfilment)) o.fulfilments.push({ id: id('ful'), locationId: lid, method: o.fulfilmentMethod, status: state.fulfilment === 'ready_for_pickup' ? 'ready' : state.fulfilment, lines: ls.map((l) => ({ variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.quantity, picked: state.fulfilment === 'picking' ? 0 : l.quantity })), carrier: null, trackingNumber: null, next: [], createdAt: ago(state.hours - 1), completedAt: null });
  ORDERS.push(o);
  return o;
}
mkOrder('me', [['v_fn-nb-rul', 1], ['v_fn-pcl-2b', 1]], { status: 'pending_payment', payment: 'pending', fulfilment: 'unfulfilled', hours: 0.05, who: 'Mathieu Roy' });
mkOrder('me', [['v_fn-jrn-sge', 1]], { status: 'paid', payment: 'paid', fulfilment: 'unfulfilled', hours: 2, who: 'Claire Dubois' });
mkOrder('me', [['v_fn-ink-blu', 1]], { status: 'paid', payment: 'paid', fulfilment: 'ready_for_pickup', hours: 5, who: 'Julie Tremblay' });
mkOrder('me', [['v_fn-pen-blk', 1]], { status: 'paid', payment: 'paid', fulfilment: 'stock_conflict', hours: 1, who: 'Fatima El Idrissi', attention: 'paid_after_expiry_no_stock' });
mkOrder('am', [['v_fn-nb-blk', 2]], { status: 'paid', payment: 'paid', fulfilment: 'picking', hours: 1.5, who: 'Lotte de Wit' });
mkOrder('am', [['v_fn-tote-olv', 1]], { status: 'fulfilled', payment: 'paid', fulfilment: 'fulfilled', method: 'shipping', hours: 30, who: 'Jesse Visser' });
mkOrder('pd', [['v_fn-ref-blu', 3]], { status: 'paid', payment: 'paid', fulfilment: 'backordered', hours: 8, who: 'Noah Smit' });
mkOrder('pd', [['v_fn-tote-snd', 1]], { status: 'fulfilled', payment: 'external', fulfilment: 'fulfilled', hours: 50, who: 'Robin Hale', source: 'woocommerce' });
const cross = mkOrder('pd', [['v_fn-dsk-1', 1]], { status: 'paid', payment: 'paid', fulfilment: 'awaiting_transfer', hours: 6, who: 'Emma Bakker', collect: 'sf' });
for (let i = 0; i < 14; i++) mkOrder(LOCS[i % LOCS.length]!.id, [[variants()[(i * 5) % 16]!.v.id, 1 + (i % 2)]], { status: 'fulfilled', payment: 'paid', fulfilment: 'fulfilled', hours: 24 * (1 + (i % 20)), who: ['Ana Silva', 'Kai Lee', 'Sam Ortiz'][i % 3]! });

const TRANSFERS: TransferView[] = [];
const mkTransfer = (from: string, to: string, lines: Array<[string, number, number, number]>, status: string, reason: string, orderId: string | null = null): TransferView => {
  const ls = lines.map(([vid, q, s, r]) => { const pv = vById(vid)!; return { variantId: vid, sku: pv.v.sku, name: `${pv.p.name} — ${pv.v.name}`, quantity: q, shipped: s, received: r }; });
  const t: TransferView = { id: id('tr'), number: `TR-${1000 + TRANSFERS.length + 1}`, fromLocationId: from, toLocationId: to, fromLocationName: locName(from), toLocationName: locName(to), status, reason, orderId, lines: ls, carrier: null, trackingNumber: null, receiveNote: null, decisionNote: null, totals: { requested: 0, shipped: 0, received: 0, inTransit: 0 }, history: [{ at: ago(20), event: 'requested', note: reason }], createdAt: ago(20), shippedAt: null, receivedAt: null };
  TRANSFERS.push(totals(t));
  return t;
};
function totals(t: TransferView) { t.totals = { requested: t.lines.reduce((a, l) => a + l.quantity, 0), shipped: t.lines.reduce((a, l) => a + l.shipped, 0), received: t.lines.reduce((a, l) => a + l.received, 0), inTransit: t.status === 'in_transit' ? t.lines.reduce((a, l) => a + l.shipped - l.received, 0) : 0 }; return t; }
const tr1 = mkTransfer('pd', 'sf', [['v_fn-nb-dot', 6, 6, 0], ['v_fn-pcl-hb', 4, 4, 0]], 'in_transit', 'Weekend restock');
for (const l of tr1.lines) move('pd', l.variantId, -l.shipped, 'transfer_out', `Shipped on ${tr1.number}`, tr1.number, ago(18));
mkTransfer('sf', 'pd', [['v_fn-jrn-rst', 2, 0, 0]], 'requested', 'Portland is out of rust journals');
const tr3 = mkTransfer('pd', 'sf', [['v_fn-dsk-1', 1, 0, 0]], 'approved', `Customer collection for order ${cross.number}`, cross.id);
cross.transfer = { id: tr3.id, number: tr3.number, status: 'approved' };

const SUPPLIERS: Supplier[] = [{ id: 'sup_mill', name: 'Mill & Pulp Paper Co.', email: 'orders@millandpulp.example', phone: null, currency: 'USD', leadTimeDays: 10, notes: null }, { id: 'sup_laiton', name: 'Atelier Laiton', email: null, phone: null, currency: 'EUR', leadTimeDays: 14, notes: null }];
const POS: PurchaseOrderView[] = [{ id: 'po_1', number: 'PO-2401', locationId: 'pd', locationName: locName('pd'), supplierId: 'sup_mill', supplierName: 'Mill & Pulp Paper Co.', status: 'sent', currency: 'USD', lines: [{ variantId: 'v_fn-ref-blu', sku: 'FN-REF-BLU', name: 'Rollerball refills — Blue', quantity: 20, received: 0, unitCostMinor: 300 }], total: m(6000, 'USD'), units: { ordered: 20, received: 0 }, expectedAt: new Date(Date.now() + 3 * 86400_000).toISOString(), createdAt: ago(40) }];

const RETURNS: ReturnView[] = [];
const done = ORDERS.filter((o) => o.fulfilmentStatus === 'fulfilled' && o.source === 'native');
const mkReturn = (o: SalesOrder, status: string, extra: Partial<ReturnView> = {}): ReturnView => {
  const l = o.lines[0]!;
  const r: ReturnView = { id: id('ret'), rmaNumber: `RMA-${5000 + RETURNS.length + 1}`, orderId: o.id, orderNumber: o.number, locationId: o.locationId, locationName: o.locationName, status, requestedVia: 'customer', reason: 'Changed my mind', resolution: null, decisionNote: null, lines: [{ variantId: l.variantId, quantity: 1, unitPrice: l.unitPrice, name: l.name, sku: l.sku, ...(status === 'received' ? { receivedQty: 1, disposition: 'restock' as const } : {}) }], value: m(status === 'received' ? l.unitPrice.amount : 0, o.currency), requestedValue: m(l.unitPrice.amount, o.currency), refundAmount: null, approvalId: null, approvalStatus: null, giftCardId: null, exchangeOrderId: null, history: [{ at: ago(30), event: 'requested' }], createdAt: ago(30), ...extra };
  RETURNS.push(r); return r;
};
if (done[0]) mkReturn(done[0], 'requested');
if (done[1]) mkReturn(done[1], 'received');

const GIFT: GiftCard[] = [
  { id: 'gc_1', kind: 'gift_card', code: '••••-2026', last4: '2026', status: 'active', customerEmail: 'claire@example.com', initial: m(5000, 'CAD'), balance: m(5000, 'CAD'), issuedReason: 'Gift card sale', createdAt: ago(100), expiresAt: null },
  { id: 'gc_2', kind: 'store_credit', code: '••••-5003', last4: '5003', status: 'active', customerEmail: 'noah@example.com', initial: m(3000, 'EUR'), balance: m(1200, 'EUR'), issuedReason: 'Return RMA-5003', createdAt: ago(200), expiresAt: null },
];
const SETTINGS = new Map<string, StoreSettings>(LOCS.map((l) => [l.id, {
  location: { id: l.id, name: l.name, currency: l.currency, country: l.country },
  settings: { configured: true, storefrontEnabled: true, pickupEnabled: true, pickupInstructions: null, pickupReadyMinutes: 90, localDeliveryEnabled: l.id === 'me' || l.id === 'am', deliveryFeeMinor: 600, freeDeliveryOverMinor: 6000, deliveryPostcodes: [], shippingEnabled: l.country !== 'US' || l.id === 'pd', shippingFeeMinor: 900, shippingCountries: [l.country], crossLocationPickup: l.currency === 'USD', reservationMinutes: 15, returnWindowDays: 30 },
  taxRates: l.currency === 'CAD' ? [{ id: 't1', name: 'GST/TPS', rateBps: 500, inclusive: false, appliesToFulfilment: true }, { id: 't2', name: 'QST/TVQ', rateBps: 998, inclusive: false, appliesToFulfilment: true }] : l.currency === 'EUR' ? [{ id: 't3', name: 'BTW', rateBps: 2100, inclusive: true, appliesToFulfilment: true }] : [],
}]));
const COLLECTIONS: Collection[] = [
  { id: 'col_nb', slug: 'notebooks', title: 'Notebooks & journals', description: null, imageUrl: null, status: 'active', position: 0, productIds: ['p_fn-nb', 'p_fn-jrn'], translations: { fr: { title: 'Carnets et journaux' } } },
  { id: 'col_wr', slug: 'writing', title: 'Writing tools', description: null, imageUrl: null, status: 'active', position: 1, productIds: ['p_fn-pen', 'p_fn-ink', 'p_fn-pcl', 'p_fn-ref'], translations: {} },
];
const DISTS: Distribution[] = [{ id: 'dist_1', status: 'completed', summary: { synced: 40, skipped: 5, failed: 0 }, createdAt: ago(300), createdByName: 'Jamie Morgan', productIds: [], locationIds: [], results: [] }];

// ───────── Views ─────────
function detail(p: P): P {
  return { ...p, collectionIds: COLLECTIONS.filter((c) => c.productIds.includes(p.id)).map((c) => c.id), listings: LOCS.filter((l) => LISTINGS.has(key(l.id, p.id))).map((l) => { const li = LISTINGS.get(key(l.id, p.id))!; return { locationId: l.id, locationName: l.name, status: li.status, contentVersion: li.version, upToDate: li.version === p.contentVersion, pendingChanges: li.version === p.contentVersion ? [] : ['Description updated'], updatedAt: ago(48) }; }) };
}
function catalogueItem(p: P): CatalogueItem {
  const ls = LOCS.map((l) => LISTINGS.get(key(l.id, p.id))).filter((x) => x?.status === 'listed');
  return { id: p.id, sku: p.sku, name: p.name, status: p.status, vendor: p.vendor, productType: p.productType, image: p.images[0]?.url ?? null, variantCount: p.variants.filter((v) => v.status === 'active').length, options: p.options, prices: p.variants.map((v) => v.prices), translations: Object.keys(p.translations), collectionIds: COLLECTIONS.filter((c) => c.productIds.includes(p.id)).map((c) => c.id), eligibility: p.eligibility, contentVersion: p.contentVersion, publish: { listedAt: ls.length, outdated: ls.filter((x) => x!.version !== p.contentVersion).length }, updatedAt: ago(10) };
}
function bounds(p: P, vprices: Record<string, number>, c: string) {
  const hq = vprices[c] ?? null;
  const b = p.priceBounds[c];
  if (hq === null || !b) return { hq, min: null as number | null, max: null as number | null };
  return { hq, min: Math.round((hq * (100 + b.minPct)) / 100), max: Math.round((hq * (100 + b.maxPct)) / 100) };
}
function assortment(lid: string): AssortmentItem[] {
  const c = cur(lid);
  return PRODUCTS.filter((p) => LISTINGS.has(key(lid, p.id))).map((p) => {
    const li = LISTINGS.get(key(lid, p.id))!;
    return {
      productId: p.id, productName: p.name, sku: p.sku, listingStatus: li.status, distributedVersion: li.version, masterVersion: p.contentVersion, updateAvailable: li.version < p.contentVersion, productStatus: p.status, lockedFields: p.lockedFields,
      variants: p.variants.map((v) => {
        const x = lvOf(lid, v.id); const b = bounds(p, v.prices, c);
        const inTransit = TRANSFERS.filter((t) => t.toLocationId === lid && t.status === 'in_transit').reduce((a, t) => a + t.lines.filter((l) => l.variantId === v.id).reduce((s, l) => s + l.shipped - l.received, 0), 0);
        return { variantId: v.id, sku: v.sku, name: v.name, options: v.options, hqPrice: b.hq === null ? null : m(b.hq, c), localPrice: x.priceMinor === null ? null : m(x.priceMinor, c), effectivePrice: m(x.priceMinor ?? b.hq ?? 0, c), priceOrigin: x.priceMinor === null ? 'hq' as const : 'local' as const, bounds: b.min === null ? null : { min: m(b.min, c), max: m(b.max!, c) }, priceSetBy: x.priceSetBy, priceSetAt: x.priceSetBy ? ago(60) : null, available: x.available, availabilityOrigin: x.available ? 'hq' as const : 'local' as const, onHand: x.onHand, reserved: x.reserved, availableQty: x.onHand - x.reserved, inTransit, reorderPoint: x.reorderPoint, reorderQty: x.reorderQty, allowBackorder: x.allowBackorder, productAllowsBackorder: p.allowBackorder };
      }),
    };
  });
}
function alerts(): Alert[] {
  const out: Alert[] = [];
  for (const [k, x] of LV) {
    const [lid, vid] = k.split(':') as [string, string];
    if (x.reorderPoint === null || x.onHand - x.reserved > x.reorderPoint) continue;
    const pv = vById(vid); if (!pv) continue;
    const onOrder = POS.filter((p) => p.locationId === lid && ['sent', 'draft', 'partially_received'].includes(p.status)).reduce((a, p) => a + p.lines.filter((l) => l.variantId === vid).reduce((s, l) => s + l.quantity - l.received, 0), 0);
    const backordered = ORDERS.filter((o) => o.locationId === lid).reduce((a, o) => a + o.lines.filter((l) => l.variantId === vid).reduce((s, l) => s + (l.backordered ?? 0), 0), 0);
    out.push({ locationId: lid, locationName: locName(lid), variantId: vid, sku: pv.v.sku, name: `${pv.p.name} — ${pv.v.name}`, onHand: x.onHand, reserved: x.reserved, available: x.onHand - x.reserved, reorderPoint: x.reorderPoint, onOrder, incoming: 0, backordered, suggestedQty: Math.max(0, (x.reorderQty ?? 12) + backordered - onOrder), severity: x.onHand - x.reserved <= 0 ? 'out' : 'low' });
  }
  return out.sort((a, b) => a.available - b.available);
}
function refreshOrder(o: SalesOrder) {
  const all = o.lines.reduce((a, l) => a + l.quantity, 0);
  const fulfilled = o.fulfilments.filter((f) => ['shipped', 'collected', 'delivered'].includes(f.status)).reduce((a, f) => a + f.lines.reduce((s, l) => s + l.quantity, 0), 0);
  const active = o.fulfilments.filter((f) => !['shipped', 'collected', 'delivered', 'cancelled'].includes(f.status));
  o.fulfilmentStatus = fulfilled >= all ? 'fulfilled' : active.some((f) => f.status === 'ready') ? 'ready_for_pickup' : fulfilled > 0 ? 'partially_fulfilled' : active.some((f) => f.status === 'packed') ? 'packed' : active.some((f) => f.status === 'picking') ? 'picking' : o.transfer && o.transfer.status !== 'received' ? 'awaiting_transfer' : o.lines.some((l) => (l.backordered ?? 0) > 0) ? 'backordered' : 'unfulfilled';
  for (const f of o.fulfilments) f.next = NEXT[f.status]?.[f.method] ?? [];
  if (o.fulfilmentStatus === 'fulfilled') { o.status = 'fulfilled'; o.fulfilledAt = now(); }
  return o;
}
const NEXT: Record<string, Record<string, string[]>> = { picking: { pickup: ['packed'], local_delivery: ['packed'], shipping: ['packed'] }, packed: { pickup: ['ready'], local_delivery: ['out_for_delivery'], shipping: ['shipped'] }, ready: { pickup: ['collected'] }, out_for_delivery: { local_delivery: ['delivered'] }, shipped: { shipping: ['delivered'] } };
ORDERS.forEach(refreshOrder);

const delay = () => new Promise((r) => setTimeout(r, 120));
const q = (query: Query | undefined, k: string) => (query?.[k] == null ? undefined : String(query[k]));

// ───────── Router ─────────
export async function mockCommerce(method: 'GET' | 'POST' | 'PUT', path: string, body: any = {}, query?: Query): Promise<unknown> {
  await delay();
  const seg = path.split('?')[0]!.split('/').filter(Boolean);
  const is = (pattern: string) => { const ps = pattern.split('/').filter(Boolean); return ps.length === seg.length && ps.every((p, i) => p.startsWith(':') || p === seg[i]); };
  const at = (i: number) => seg[i]!;
  const r = `${method} ${path}`;

  if (path.startsWith('/~/orgs/')) {
    if (seg.includes('approvals') && method === 'POST') { const ret = RETURNS.find((x) => x.approvalId === seg[4]); if (ret) { ret.status = 'resolved'; ret.approvalStatus = 'approved'; } return { status: 'approved' }; }
    if (seg.includes('sync-orders')) return { sandbox: true, created: 0, updated: 1, unchanged: 3, errors: [] };
    return {};
  }
  if (method === 'GET' && is('/overview')) {
    const a = alerts();
    const byCur = new Map<string, { today: number; week: number; n: number }>();
    const sales = LOCS.map((l) => { const os = ORDERS.filter((o) => o.locationId === l.id && o.paymentStatus !== 'pending' && Date.parse(o.createdAt) > Date.now() - 7 * 86400_000); const today = os.filter((o) => Date.parse(o.createdAt) > Date.now() - 86400_000); const e = byCur.get(l.currency) ?? { today: 0, week: 0, n: 0 }; e.today += today.reduce((s, o) => s + o.total.amount, 0); e.week += os.reduce((s, o) => s + o.total.amount, 0); e.n += os.length; byCur.set(l.currency, e); return { locationId: l.id, locationName: l.name, currency: l.currency, timeZone: l.timeZone, today: { orders: today.length, gross: m(today.reduce((s, o) => s + o.total.amount, 0), l.currency) }, last7Days: { orders: os.length, gross: m(os.reduce((s, o) => s + o.total.amount, 0), l.currency), refunds: m(0, l.currency) } }; });
    const open = ORDERS.filter((o) => o.paymentStatus === 'paid' || o.paymentStatus === 'external');
    return { asOf: now(), orders: { toFulfil: open.filter((o) => ['unfulfilled', 'picking', 'packed', 'partially_fulfilled'].includes(o.fulfilmentStatus)).length, readyForPickup: open.filter((o) => o.fulfilmentStatus === 'ready_for_pickup').length, backordered: open.filter((o) => o.fulfilmentStatus === 'backordered').length, awaitingTransfer: open.filter((o) => o.fulfilmentStatus === 'awaiting_transfer').length, needsAttention: ORDERS.filter((o) => o.attention).length, awaitingPayment: ORDERS.filter((o) => o.status === 'pending_payment').length }, sales, salesUnavailableReason: null, revenueByCurrency: [...byCur].map(([c, e]) => ({ currency: c, today: m(e.today, c), last7Days: m(e.week, c), orders7: e.n })), stock: { low: a.filter((x) => x.severity === 'low').length, out: a.filter((x) => x.severity === 'out').length, top: a.slice(0, 5) }, transfers: { requested: TRANSFERS.filter((t) => t.status === 'requested').length, toShip: TRANSFERS.filter((t) => t.status === 'approved').length, inTransit: TRANSFERS.filter((t) => t.status === 'in_transit').length }, returns: { open: RETURNS.filter((x) => !['resolved', 'rejected'].includes(x.status)).length, awaitingApproval: RETURNS.filter((x) => x.status === 'refund_pending_approval').length }, connections: [{ id: 'conn_woo', provider: 'woocommerce', locationId: 'pd', authoritative: 'external', state: 'connected', lastSuccessAt: ago(1), lastError: null }] };
  }
  // Catalogue
  if (method === 'GET' && is('/catalogue')) { const s = q(query, 'q')?.toLowerCase(); return { items: PRODUCTS.filter((p) => !s || p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s)).map(catalogueItem) }; }
  if (method === 'GET' && is('/catalogue/:id')) { const p = PRODUCTS.find((x) => x.id === at(1)) ?? fail(404, 'not_found', 'Product not found'); return detail(p); }
  if (method === 'POST' && is('/catalogue/variant-matrix')) { const combos = (body.options as Array<{ name: string; values: string[] }>).reduce<Array<Record<string, string>>>((acc, o) => acc.flatMap((c) => o.values.map((v) => ({ ...c, [o.name]: v }))), [{}]); return { variants: combos.map((o) => ({ sku: [body.sku, ...Object.values(o).map((v) => v.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase())].join('-'), name: Object.values(o).join(' · ') || body.name, options: o })) }; }
  if ((method === 'POST' && is('/catalogue')) || (method === 'PUT' && is('/catalogue/:id'))) {
    const existing = method === 'PUT' ? PRODUCTS.find((x) => x.id === at(1)) : undefined;
    if (existing && existing.sku !== body.sku && existing.listings.length) fail(409, 'identifier_locked', 'The product SKU is a master identifier and cannot change after distribution');
    const p: P = { ...(existing ?? mkProduct(body.sku, body.name, body.productType ?? '', '1531346878377-a5be20888e57', [], [], {})), ...body, id: existing?.id ?? `p_${String(body.sku).toLowerCase()}`, contentVersion: (existing?.contentVersion ?? 0) + 1, variants: body.variants.map((v: any) => ({ id: v.id ?? `v_${String(v.sku).toLowerCase()}`, barcode: null, imageUrl: null, status: 'active', ...v })), images: body.images ?? [] };
    if (existing) PRODUCTS.splice(PRODUCTS.indexOf(existing), 1, p); else PRODUCTS.push(p);
    return detail(p);
  }
  if (method === 'PUT' && is('/catalogue/:id/translations/:locale')) { const p = PRODUCTS.find((x) => x.id === at(1))!; p.translations[at(3)] = { name: body.name, description: body.description }; p.contentVersion++; return detail(p); }
  if (method === 'GET' && is('/collections')) return { items: COLLECTIONS };
  if (method === 'POST' && is('/collections')) { const c = { id: id('col'), position: COLLECTIONS.length, translations: {}, ...body }; COLLECTIONS.push(c); return c; }
  if (method === 'PUT' && is('/collections/:id')) { const c = COLLECTIONS.find((x) => x.id === at(1))!; Object.assign(c, body); return c; }
  if (method === 'POST' && is('/distributions/preview')) return { items: plan(body.productIds, body.locationIds), summary: {} };
  if (method === 'POST' && is('/distributions')) {
    const items = plan(body.productIds, body.locationIds);
    const results = items.map((i) => { if (i.status === 'ready') LISTINGS.set(key(i.locationId, i.productId), { version: PRODUCTS.find((p) => p.id === i.productId)!.contentVersion, status: i.action === 'delist' ? 'delisted' : 'listed' }); for (const o of i.overridesOutOfBounds) lvOf(i.locationId, o.variantId).priceMinor = null; return { id: id('dr'), locationId: i.locationId, locationName: i.locationName, productId: i.productId, productName: i.productName, status: i.status === 'ready' ? 'synced' as const : i.status === 'blocked' ? 'failed' as const : 'skipped' as const, action: i.action, message: i.message, changes: { changes: i.changes } }; });
    const d: Distribution = { id: id('dist'), status: results.some((x) => x.status === 'failed') ? 'partial' : 'completed', summary: { synced: results.filter((x) => x.status === 'synced').length, skipped: results.filter((x) => x.status === 'skipped').length, failed: results.filter((x) => x.status === 'failed').length }, createdAt: now(), createdByName: 'You', productIds: body.productIds, locationIds: body.locationIds, results };
    DISTS.unshift(d); return d;
  }
  if (method === 'GET' && is('/distributions')) return { items: DISTS };
  if (method === 'GET' && is('/distributions/:id')) return DISTS.find((d) => d.id === at(1));
  // Assortment & storefront settings
  if (method === 'GET' && is('/locations/:id/assortment')) return { location: { id: at(1), name: locName(at(1)), currency: cur(at(1)) }, items: assortment(at(1)) };
  if (method === 'PUT' && is('/locations/:id/assortment/:vid')) {
    const lid = at(1); const vid = at(3); const pv = vById(vid)!; const x = lvOf(lid, vid);
    if (body.priceMinor != null) { const b = bounds(pv.p, pv.v.prices, cur(lid)); if (b.min === null) fail(409, 'price_locked', `No local price range for ${cur(lid)}; the HQ price applies`); if (body.priceMinor < b.min! || body.priceMinor > b.max!) fail(409, 'price_out_of_bounds', `Local price must be between ${b.min} and ${b.max} ${cur(lid)} minor units`); }
    if (body.priceMinor !== undefined) { x.priceMinor = body.priceMinor; x.priceSetBy = 'You'; }
    for (const k of ['available', 'reorderPoint', 'reorderQty', 'allowBackorder'] as const) if (body[k] !== undefined) (x as any)[k] = body[k];
    return assortment(lid).flatMap((i) => i.variants).find((v) => v.variantId === vid);
  }
  if (method === 'POST' && is('/locations/:id/assortment/reset')) { let c = 0; for (const [k, x] of LV) if (k.startsWith(`${at(1)}:`) && x.priceMinor !== null) { x.priceMinor = null; c++; } return { reset: c, items: assortment(at(1)) }; }
  if (method === 'GET' && is('/fulfilment-settings')) return { items: [...SETTINGS.values()] };
  if (method === 'PUT' && is('/locations/:id/fulfilment-settings')) { const s = SETTINGS.get(at(1))!; s.settings = { ...s.settings, ...body }; return s.settings; }
  if (method === 'PUT' && is('/locations/:id/tax-rates')) { const s = SETTINGS.get(at(1))!; s.taxRates = body.rates.map((x: any, i: number) => ({ id: `t${i}`, appliesToFulfilment: true, ...x })); return { items: s.taxRates }; }
  // Orders
  if (method === 'GET' && is('/sales-orders')) { let os = [...ORDERS]; const st = q(query, 'fulfilmentStatus'); if (st) os = os.filter((o) => st.split(',').includes(o.fulfilmentStatus)); if (q(query, 'attention')) os = os.filter((o) => o.attention); const ps = q(query, 'paymentStatus'); if (ps) os = os.filter((o) => ps.split(',').includes(o.paymentStatus)); return { items: os.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }; }
  if (method === 'GET' && is('/sales-orders/:id')) { const o = ORDERS.find((x) => x.id === at(1)) ?? fail(404, 'not_found', 'Order not found'); return { ...o, returns: RETURNS.filter((x) => x.orderId === o.id), payment: { id: 'pay', state: 'succeeded', refundState: 'none' } }; }
  if (method === 'POST' && is('/sales-orders/:id/fulfilments')) {
    const o = ORDERS.find((x) => x.id === at(1))!;
    if (o.transfer && o.transfer.status !== 'received') fail(409, 'awaiting_transfer', `Waiting for transfer ${o.transfer.number}`);
    const used = new Map<string, number>(); for (const f of o.fulfilments) for (const l of f.lines) used.set(l.variantId, (used.get(l.variantId) ?? 0) + l.quantity);
    const lines = o.lines.map((l) => ({ variantId: l.variantId, sku: l.sku, name: l.name, quantity: l.quantity - (l.backordered ?? 0) - (used.get(l.variantId) ?? 0), picked: 0 })).filter((l) => l.quantity > 0);
    if (!lines.length) fail(409, 'nothing_to_fulfil', 'Nothing on this order can be fulfilled right now');
    const f = { id: id('ful'), locationId: o.fulfilmentLocationId, method: o.fulfilmentMethod, status: 'picking', lines, carrier: null, trackingNumber: null, next: ['packed'], createdAt: now(), completedAt: null };
    o.fulfilments.push(f); refreshOrder(o); return { fulfilment: f, order: o };
  }
  if (method === 'POST' && is('/fulfilments/:id/pick')) { const o = ORDERS.find((x) => x.fulfilments.some((f) => f.id === at(1)))!; const f = o.fulfilments.find((x) => x.id === at(1))!; for (const p of body.lines) { const l = f.lines.find((x) => x.variantId === p.variantId)!; if (p.quantity !== undefined) l.quantity = p.quantity; l.picked = p.picked; } return f; }
  if (method === 'POST' && is('/fulfilments/:id/status')) {
    const o = ORDERS.find((x) => x.fulfilments.some((f) => f.id === at(1)))!; const f = o.fulfilments.find((x) => x.id === at(1))!;
    if (!(NEXT[f.status]?.[f.method] ?? []).includes(body.to)) fail(409, 'invalid_transition', `Cannot move from ${f.status} to ${body.to}`);
    if (body.to === 'packed' && f.lines.some((l) => l.picked !== l.quantity)) fail(409, 'not_fully_picked', 'Pick every unit (or reduce the quantity) before packing');
    if (body.to === 'shipped' && !body.trackingNumber) fail(400, 'validation_failed', 'Add the tracking number', { trackingNumber: 'Required to mark as shipped' });
    f.status = body.to; f.carrier = body.carrier ?? f.carrier; f.trackingNumber = body.trackingNumber ?? f.trackingNumber; o.history.push({ at: now(), event: `fulfilment_${body.to}` });
    refreshOrder(o); return { fulfilment: f, order: o };
  }
  if (method === 'POST' && is('/sales-orders/:id/allocate-backorders')) { const o = ORDERS.find((x) => x.id === at(1))!; let a = 0; for (const l of o.lines) { const free = lvOf(o.locationId, l.variantId).onHand - lvOf(o.locationId, l.variantId).reserved; const take = Math.min(free, l.backordered ?? 0); if (take > 0) { move(o.locationId, l.variantId, -take, 'sale', 'Backorder allocated', o.id); l.backordered! -= take; l.allocated = (l.allocated ?? 0) + take; a += take; } } refreshOrder(o); return { allocated: a, order: o }; }
  if (method === 'POST' && is('/sales-orders/:id/recover')) { const o = ORDERS.find((x) => x.id === at(1))!; o.attention = null; if (body.kind === 'backorder') o.lines.forEach((l) => { l.backordered = l.quantity; l.allocated = 0; }); o.history.push({ at: now(), event: 'recovered', note: body.kind }); refreshOrder(o); return o; }
  if (method === 'POST' && is('/sales-orders/:id/cancel')) { const o = ORDERS.find((x) => x.id === at(1))!; for (const l of o.lines) move(o.locationId, l.variantId, l.quantity, 'release', 'Cancelled by staff', o.id); o.status = 'cancelled'; o.paymentStatus = 'cancelled'; o.fulfilmentStatus = 'cancelled'; return o; }
  if (method === 'POST' && seg[0] === 'orders' && seg[2] === 'refunds') { const o = ORDERS.find((x) => x.id === seg[1])!; o.refunded = m(o.refunded.amount + body.amountMinor, o.currency); o.paymentStatus = o.refunded.amount >= o.total.amount ? 'refunded' : 'partially_refunded'; return { order: o }; }
  if (method === 'POST' && is('/sales-orders/:id/returns')) { const o = ORDERS.find((x) => x.id === at(1))!; const ret = mkReturn(o, 'requested', { requestedVia: 'staff', lines: body.lines.map((l: any) => { const ol = o.lines.find((x) => x.variantId === l.variantId)!; return { variantId: l.variantId, quantity: l.quantity, unitPrice: ol.unitPrice, name: ol.name, sku: ol.sku }; }) }); return ret; }
  // Inventory
  if (method === 'GET' && is('/inventory')) return { items: [...LV].filter(([k]) => vById(k.split(':')[1]!)).map(([k, x]) => { const [lid, vid] = k.split(':') as [string, string]; const pv = vById(vid)!; return { locationId: lid, locationName: locName(lid), variantId: vid, sku: pv.v.sku, name: pv.v.name, productName: pv.p.name, onHand: x.onHand, reserved: x.reserved, available: x.onHand - x.reserved, reorderPoint: x.reorderPoint, lowStock: x.reorderPoint !== null && x.onHand - x.reserved <= x.reorderPoint, sellable: x.available, price: m(x.priceMinor ?? pv.v.prices[cur(lid)]!, cur(lid)), lastMovementAt: MOVES.find((mv) => mv.locationId === lid && mv.variantId === vid)?.createdAt ?? null }; }).filter((x) => !q(query, 'locationId') || x.locationId === q(query, 'locationId')) };
  if (method === 'GET' && is('/inventory/alerts')) return { items: alerts(), backorders: [] };
  if (method === 'GET' && is('/stock-movements')) return { items: MOVES.filter((mv) => (!q(query, 'locationId') || mv.locationId === q(query, 'locationId')) && (!q(query, 'variantId') || mv.variantId === q(query, 'variantId'))).slice(0, 200) };
  if (method === 'POST' && is('/stock-movements')) { const x = lvOf(body.locationId, body.variantId); if (x.onHand + body.quantity < 0 && body.reason !== 'count') fail(409, 'insufficient_stock', `Only ${x.onHand} in stock`); move(body.locationId, body.variantId, body.quantity, body.reason, body.note ?? null); return { stockOnHand: x.onHand }; }
  if (method === 'GET' && is('/stock-counts')) return { items: COUNTS.map((c) => ({ id: c.id, locationId: c.locationId, locationName: locName(c.locationId), name: c.name, status: c.status, lines: c.lines.length, counted: c.lines.filter((l) => l.countedQty !== null).length, varianceUnits: c.lines.reduce((a, l) => a + (l.variance ?? 0), 0), createdAt: ago(5) })) };
  if (method === 'POST' && is('/stock-counts')) { const vids = body.variantIds?.length ? body.variantIds : [...LV.keys()].filter((k) => k.startsWith(`${body.locationId}:`)).map((k) => k.split(':')[1]); const c: CountDetail = { id: id('cnt'), locationId: body.locationId, name: body.name, status: 'in_progress', lines: vids.filter((v: string) => vById(v)).map((v: string) => ({ variantId: v, sku: vById(v)!.v.sku, barcode: null, name: `${vById(v)!.p.name} — ${vById(v)!.v.name}`, expectedQty: null, countedQty: null, variance: null, countedAt: null })) }; COUNTS.unshift(c); return c; }
  if (method === 'GET' && is('/stock-counts/:id')) return COUNTS.find((c) => c.id === at(1));
  if (method === 'POST' && is('/stock-counts/:id/entries')) { const c = COUNTS.find((x) => x.id === at(1))!; for (const e of body.entries) { const l = c.lines.find((x) => x.variantId === e.variantId)!; l.expectedQty = lvOf(c.locationId, e.variantId).onHand; l.countedQty = e.countedQty; l.variance = e.countedQty - l.expectedQty; l.countedAt = now(); } return c; }
  if (method === 'POST' && is('/stock-counts/:id/submit')) { const c = COUNTS.find((x) => x.id === at(1))!; c.status = 'submitted'; return c; }
  if (method === 'POST' && is('/stock-counts/:id/apply')) { const c = COUNTS.find((x) => x.id === at(1))!; let adj = 0; let units = 0; for (const l of c.lines) if (l.variance) { move(c.locationId, l.variantId, l.variance, 'count', `${c.name}: counted ${l.countedQty}, expected ${l.expectedQty}`); adj++; units += l.variance; } c.status = 'applied'; return { adjusted: adj, unitsVariance: units, count: c }; }
  // Transfers
  if (method === 'GET' && is('/transfers')) return { items: TRANSFERS.map(totals) };
  if (method === 'POST' && is('/transfers')) return mkTransfer(body.fromLocationId, body.toLocationId, body.lines.map((l: any) => [l.variantId, l.quantity, 0, 0]), 'requested', body.reason ?? '');
  if (method === 'POST' && is('/transfers/:id/decision')) { const t = TRANSFERS.find((x) => x.id === at(1))!; if (t.status !== 'requested') fail(409, 'invalid_transition', `This transfer is ${t.status}`); t.status = body.decision === 'approve' ? 'approved' : 'rejected'; t.decisionNote = body.note ?? null; t.history.push({ at: now(), event: t.status }); return totals(t); }
  if (method === 'POST' && is('/transfers/:id/ship')) { const t = TRANSFERS.find((x) => x.id === at(1))!; if (t.status !== 'approved') fail(409, 'invalid_transition', 'This transfer needs approval before it ships'); for (const l of t.lines) { l.shipped = body.lines?.find((x: any) => x.variantId === l.variantId)?.quantity ?? l.quantity; if (t.orderId) move(t.fromLocationId, l.variantId, l.shipped, 'release', null, t.orderId); move(t.fromLocationId, l.variantId, -l.shipped, 'transfer_out', `Shipped on ${t.number}`, t.number); } t.status = 'in_transit'; t.carrier = body.carrier ?? null; t.trackingNumber = body.trackingNumber ?? null; t.shippedAt = now(); t.history.push({ at: now(), event: 'shipped' }); const o = ORDERS.find((x) => x.id === t.orderId); if (o) { o.transfer = { id: t.id, number: t.number, status: t.status }; refreshOrder(o); } return totals(t); }
  if (method === 'POST' && is('/transfers/:id/receive')) { const t = TRANSFERS.find((x) => x.id === at(1))!; if (t.status !== 'in_transit') fail(409, 'invalid_transition', `This transfer is ${t.status}`); let short = 0; for (const l of t.lines) { l.received = body.lines?.find((x: any) => x.variantId === l.variantId)?.quantity ?? l.shipped; short += l.shipped - l.received; if (l.received) move(t.toLocationId, l.variantId, l.received, 'transfer_in', `Received on ${t.number}`, t.number); } t.status = 'received'; t.receivedAt = now(); t.receiveNote = short ? `${short} unit(s) missing on arrival — recorded as transit loss` : null; t.history.push({ at: now(), event: 'received', note: t.receiveNote ?? undefined }); const o = ORDERS.find((x) => x.id === t.orderId); if (o) { o.transfer = { id: t.id, number: t.number, status: 'received' }; refreshOrder(o); } return totals(t); }
  if (method === 'POST' && is('/transfers/:id/cancel')) { const t = TRANSFERS.find((x) => x.id === at(1))!; t.status = 'cancelled'; return totals(t); }
  // Purchasing
  if (method === 'GET' && is('/suppliers')) return { items: SUPPLIERS };
  if (method === 'POST' && is('/suppliers')) { const s = { id: id('sup'), phone: null, notes: null, leadTimeDays: null, email: null, ...body }; SUPPLIERS.push(s); return s; }
  if (method === 'GET' && is('/purchase-orders')) return { items: POS };
  if (method === 'POST' && is('/purchase-orders')) { const sup = SUPPLIERS.find((s) => s.id === body.supplierId)!; const lines = body.lines.map((l: any) => { const pv = vById(l.variantId)!; return { variantId: l.variantId, sku: pv.v.sku, name: `${pv.p.name} — ${pv.v.name}`, quantity: l.quantity, received: 0, unitCostMinor: l.unitCostMinor }; }); const po: PurchaseOrderView = { id: id('po'), number: `PO-${2400 + POS.length + 1}`, locationId: body.locationId, locationName: locName(body.locationId), supplierId: sup.id, supplierName: sup.name, status: 'draft', currency: sup.currency, lines, total: m(lines.reduce((a: number, l: any) => a + l.quantity * l.unitCostMinor, 0), sup.currency), units: { ordered: lines.reduce((a: number, l: any) => a + l.quantity, 0), received: 0 }, expectedAt: null, createdAt: now() }; POS.unshift(po); return po; }
  if (method === 'POST' && is('/purchase-orders/:id/send')) { const po = POS.find((x) => x.id === at(1))!; po.status = 'sent'; return po; }
  if (method === 'POST' && is('/purchase-orders/:id/cancel')) { const po = POS.find((x) => x.id === at(1))!; po.status = 'cancelled'; return po; }
  if (method === 'POST' && is('/purchase-orders/:id/receive')) { const po = POS.find((x) => x.id === at(1))!; let units = 0; for (const l of po.lines) { const got = l.quantity - l.received; if (got > 0) { move(po.locationId, l.variantId, got, 'received', `Received against ${po.number}`, po.number); l.received += got; units += got; } } po.status = 'received'; po.units.received = po.units.ordered; return { purchaseOrder: po, unitsReceived: units, backordersWaiting: ORDERS.filter((o) => o.locationId === po.locationId && o.lines.some((l) => (l.backordered ?? 0) > 0 && po.lines.some((x) => x.variantId === l.variantId))).map((o) => ({ orderId: o.id, orderNumber: o.number, locationId: o.locationId, variantId: o.lines[0]!.variantId, sku: o.lines[0]!.sku, name: o.lines[0]!.name, backordered: o.lines[0]!.backordered ?? 0 })) }; }
  // Returns
  if (method === 'GET' && is('/returns')) return { items: RETURNS };
  if (method === 'GET' && is('/returns/:id')) return RETURNS.find((x) => x.id === at(1));
  if (method === 'POST' && seg[0] === 'returns' && seg.length === 3) {
    const ret = RETURNS.find((x) => x.id === at(1))!; const action = at(2);
    const flow: Record<string, [string, string]> = { review: ['requested', 'reviewed'], authorise: ['reviewed', 'authorised'], reject: ['', 'rejected'], receive: ['authorised', 'received'] };
    if (action === 'resolve') {
      if (ret.status !== 'received') fail(409, 'invalid_transition', 'Receive the returned goods before resolving');
      ret.resolution = body.resolution;
      if (body.resolution === 'refund' && (body.amountMinor ?? ret.value.amount) > 5000) { ret.status = 'refund_pending_approval'; ret.approvalId = id('ap'); ret.approvalStatus = 'pending'; return { outcome: 'approval_requested', return: ret, approval: { id: ret.approvalId, status: 'pending' }, giftCardCode: null }; }
      ret.status = 'resolved'; ret.refundAmount = m(body.amountMinor ?? ret.value.amount, ret.value.currency);
      if (body.resolution === 'store_credit') { const g: GiftCard = { id: id('gc'), kind: 'store_credit', code: '••••-7Q2M', last4: '7Q2M', status: 'active', customerEmail: null, initial: ret.refundAmount, balance: ret.refundAmount, issuedReason: `Return ${ret.rmaNumber}`, createdAt: now(), expiresAt: null }; GIFT.unshift(g); return { outcome: 'store_credit', return: ret, giftCardCode: 'K3PA-9XWD-7Q2M', approval: null }; }
      return { outcome: body.resolution === 'exchange' ? 'exchanged' : 'refunded', return: ret, giftCardCode: null, approval: null };
    }
    const [from, to] = flow[action] ?? fail(404, 'not_found', 'Not found');
    if (from && ret.status !== from) fail(409, 'invalid_transition', `Cannot move a return from ${ret.status} to ${to}`);
    if (action === 'receive') { ret.lines = ret.lines.map((l) => { const g = body.lines.find((x: any) => x.variantId === l.variantId); return g ? { ...l, receivedQty: g.receivedQty, disposition: g.disposition } : l; }); for (const l of ret.lines) if (l.receivedQty) { move(ret.locationId, l.variantId, l.receivedQty, 'return', `${ret.rmaNumber}: returned by customer`); if (l.disposition === 'write_off') move(ret.locationId, l.variantId, -l.receivedQty, 'damage', `${ret.rmaNumber}: written off`); } ret.value = m(ret.lines.reduce((a, l) => a + (l.receivedQty ?? 0) * (l.unitPrice?.amount ?? 0), 0), ret.value.currency); }
    ret.status = to; ret.decisionNote = body.note ?? ret.decisionNote; ret.history.push({ at: now(), event: to, note: body.note }); return ret;
  }
  // Gift cards
  if (method === 'GET' && is('/gift-cards')) { const t = new Map<string, number>(); for (const g of GIFT) t.set(g.balance.currency, (t.get(g.balance.currency) ?? 0) + g.balance.amount); return { items: GIFT, outstandingByCurrency: [...t].map(([c, a]) => m(a, c)) }; }
  if (method === 'GET' && is('/gift-cards/:id')) { const g = GIFT.find((x) => x.id === at(1))!; return { ...g, ledger: [{ id: 'l1', kind: 'issue', amount: g.initial, balanceAfter: g.initial, note: g.issuedReason, createdAt: g.createdAt }] }; }
  if (method === 'POST' && is('/gift-cards')) { const g: GiftCard = { id: id('gc'), kind: body.kind, code: '••••-H7RT', last4: 'H7RT', status: 'active', customerEmail: body.customerEmail, initial: m(body.amountMinor, body.currency), balance: m(body.amountMinor, body.currency), issuedReason: body.reason, createdAt: now(), expiresAt: null }; GIFT.unshift(g); return { ...g, code: 'B4XN-2PQE-H7RT' }; }
  if (method === 'POST' && is('/gift-cards/:id/adjust')) { const g = GIFT.find((x) => x.id === at(1))!; g.balance = m(g.balance.amount + body.amountMinor, g.balance.currency); return g; }
  // Reports & AI
  if (method === 'GET' && is('/reports')) return report();
  if (method === 'GET' && is('/ai/merchandising')) return { suggestions: alerts().slice(0, 3).map((a) => ({ kind: 'restock_best_seller', title: `Restock ${a.name} at ${a.locationName}`, detail: `${a.available} left to sell; reorder point ${a.reorderPoint}.`, locationId: a.locationId, productId: null, citations: [{ type: 'stock', id: `${a.locationId}:${a.variantId}`, label: `${a.name}: ${a.onHand} on hand, ${a.reserved} reserved` }] })), narrative: null, aiAvailable: false, periodDays: 30, method: 'Computed from sale movements, stock levels and listings; every suggestion cites its records.' };
  if (method === 'GET' && is('/ai/stock-explainer')) { const lid = q(query, 'locationId')!; const vid = q(query, 'variantId')!; const ms = MOVES.filter((x) => x.locationId === lid && x.variantId === vid && x.affectsOnHand); const by = new Map<string, { units: number; ids: string[] }>(); for (const mv of ms) { const e = by.get(mv.reason) ?? { units: 0, ids: [] }; e.units += mv.quantity; e.ids.push(mv.id); by.set(mv.reason, e); } const x = lvOf(lid, vid); return { item: { sku: vById(vid)!.v.sku, name: `${vById(vid)!.p.name} — ${vById(vid)!.v.name}` }, periodDays: 30, opening: 0, closing: x.onHand, observations: [`On hand is ${x.onHand}; ${x.reserved} reserved.`, ...[...by].map(([r, e]) => `${LABEL[r] ?? r}: ${e.units > 0 ? '+' : ''}${e.units} across ${e.ids.length} movement(s).`)], hypotheses: [], findings: [...by].map(([r, e]) => ({ reason: r, label: LABEL[r] ?? r, units: e.units, citations: e.ids.slice(0, 10).map((i) => ({ type: 'stock_movement', id: i })), more: Math.max(0, e.ids.length - 10) })), narrative: null, aiAvailable: false, source: 'Sample ledger', asOf: now() }; }
  if (method === 'POST' && is('/ai/product-copy')) fail(503, 'ai_unavailable', 'BranchHarbor AI is not available in sample mode. You can still write and publish copy manually.');
  if (method === 'POST' && is('/reservations/expire')) return { expired: 0 };
  return fail(404, 'not_found', `No sample data for ${r}`);
}

const COUNTS: CountDetail[] = [{ id: 'cnt_1', locationId: 'pd', name: 'Shelf B — notebooks', status: 'in_progress', lines: ['v_fn-nb-dot', 'v_fn-nb-rul', 'v_fn-jrn-rst'].map((v) => ({ variantId: v, sku: vById(v)!.v.sku, barcode: null, name: `${vById(v)!.p.name} — ${vById(v)!.v.name}`, expectedQty: null, countedQty: null, variance: null, countedAt: null })) }];

function plan(productIds: string[], locationIds: string[]): PlanItem[] {
  const out: PlanItem[] = [];
  for (const lid of locationIds) for (const pid of productIds) {
    const p = PRODUCTS.find((x) => x.id === pid)!; const l = LOCS.find((x) => x.id === lid)!; const li = LISTINGS.get(key(lid, pid));
    const base = { locationId: lid, locationName: l.name, currency: l.currency, productId: pid, productName: p.name, overridesOutOfBounds: [] as PlanItem['overridesOutOfBounds'] };
    if (p.status !== 'active') { out.push({ ...base, action: li?.status === 'listed' ? 'delist' : 'none', status: li?.status === 'listed' ? 'ready' : 'skipped', message: `Product is ${p.status}`, changes: [] }); continue; }
    const missing = p.variants.filter((v) => v.prices[l.currency] == null);
    if (missing.length) { out.push({ ...base, action: 'none', status: 'blocked', message: `No ${l.currency} price for ${missing.map((v) => v.name).join(', ')}`, changes: [] }); continue; }
    if (li?.status === 'listed' && li.version === p.contentVersion) { out.push({ ...base, action: 'none', status: 'skipped', message: 'Already up to date', changes: [] }); continue; }
    out.push({ ...base, action: li ? 'update' : 'list', status: 'ready', message: null, changes: li ? [`Content v${li.version} → v${p.contentVersion}`] : ['New listing'] });
  }
  return out;
}

function report() {
  const byLoc = LOCS.map((l) => { const os = ORDERS.filter((o) => o.locationId === l.id && ['paid', 'external', 'partially_refunded'].includes(o.paymentStatus)); const gross = os.reduce((a, o) => a + o.total.amount, 0); return { locationId: l.id, locationName: l.name, currency: l.currency, orders: os.length, gross: m(gross, l.currency), refunds: m(0, l.currency), net: m(gross, l.currency), averageOrder: os.length ? m(Math.round(gross / os.length), l.currency) : null, bySource: [] }; });
  const totals = new Map<string, { orders: number; gross: number }>();
  for (const s of byLoc) { const e = totals.get(s.currency) ?? { orders: 0, gross: 0 }; e.orders += s.orders; e.gross += s.gross.amount; totals.set(s.currency, e); }
  const top = new Map<string, { name: string; units: number; rev: Map<string, number> }>();
  for (const o of ORDERS) for (const l of o.lines) { const pv = vById(l.variantId)!; const e = top.get(pv.p.id) ?? { name: pv.p.name, units: 0, rev: new Map() }; e.units += l.quantity; e.rev.set(o.currency, (e.rev.get(o.currency) ?? 0) + l.lineTotal.amount); top.set(pv.p.id, e); }
  return {
    period: { from: ago(720), to: now() }, salesByLocation: byLoc, totalsByCurrency: [...totals].map(([c, e]) => ({ currency: c, orders: e.orders, gross: m(e.gross, c), refunds: m(0, c), net: m(e.gross, c) })),
    combinedRevenue: null, combinedRevenueReason: 'Currencies are reported separately; no conversion method is defined.',
    topProducts: [...top].sort((a, b) => b[1].units - a[1].units).slice(0, 8).map(([pid, e]) => ({ productId: pid, name: e.name, units: e.units, revenueByCurrency: [...e.rev].map(([c, a]) => m(a, c)), locations: 2 })),
    stockTurnover: LOCS.map((l) => ({ locationId: l.id, locationName: l.name, unitsSold: 12, averageUnits: 180, turnover: l.id === 'au' ? null : 0.07, turnoverUnavailableReason: l.id === 'au' ? 'No stock on hand in the period' : null, daysOfCover: 300 })),
    inventoryDrift: LOCS.map((l, i) => ({ locationId: l.id, locationName: l.name, countVarianceUnits: -i, countAdjustments: i ? 1 : 0, writeOffUnits: i % 2, transitLossUnits: 0, ledgerMismatches: 0 })),
    returnsRate: LOCS.map((l) => ({ locationId: l.id, locationName: l.name, returns: RETURNS.filter((r) => r.locationId === l.id).length, returnedUnits: RETURNS.filter((r) => r.locationId === l.id).length, unitsSold: 10, rate: 0.1, rateUnavailableReason: null })),
    sources: [{ source: 'native', authoritative: 'BranchHarbor', note: 'Orders placed on BranchHarbor storefronts' }, { source: 'woocommerce', authoritative: 'woocommerce', note: 'Imported from woocommerce; history before the connection may be incomplete' }],
  };
}
