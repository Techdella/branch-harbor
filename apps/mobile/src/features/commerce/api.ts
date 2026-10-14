/**
 * Commerce data for the mobile app (customer shop, store associate shop floor, owner sales pulse).
 * Live (EXPO_PUBLIC_USE_MOCKS=false): /v1/public/commerce/*, /v1/me/commerce/* and /v1/orgs/:orgId/commerce/*.
 * Mock mode: a small in-memory sample so every screen works without the API.
 */
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import { storage } from '@/lib/storage';
import type { Money } from '@bh/shared';

export const SHOP_BRAND = process.env.EXPO_PUBLIC_SHOP_BRAND || 'fieldnote-goods';
type M = Money;

export interface ShopStore { id: string; slug: string; name: string; city: string; currency: string }
export interface ShopVariant { id: string; name: string; options: Record<string, string>; price: M | null; availability: 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'not_stocked' }
export interface ShopProduct { id: string; slug: string | null; name: string; description: string | null; image: string | null; priceFrom: M | null; variants: ShopVariant[]; specs: Record<string, string>; returnable: boolean }
export interface Quote { total: M; subtotal: M; taxLines: Array<{ name: string; rateBps: number; inclusive: boolean; amount: M }>; amountDue: M; ok: boolean; issues: Array<{ field: string; message: string }> }
export interface ShopOrder {
  id: string; number: string; status: string; paymentStatus: string; fulfilmentStatus: string; fulfilmentMethod: string; locationName: string | null; fulfilmentLocationName: string | null;
  lines: Array<{ variantId: string; name: string; quantity: number; lineTotal: M }>; total: M; amountDue: M; createdAt: string; reservationExpiresAt: string | null;
  payment?: { id: string; state: string; sandbox: boolean } | null; returnable?: Array<{ variantId: string; name: string; max: number }>; returns?: Array<{ id: string; rmaNumber: string | null; status: string }>;
  returnPolicy?: { open: boolean; endsAt: string };
}
export interface QueueOrder { id: string; number: string; customer: { name: string | null }; fulfilmentStatus: string; fulfilmentMethod: string; lines: Array<{ variantId: string; name: string; quantity: number }>; fulfilments: Array<{ id: string; status: string; next: string[]; lines: Array<{ variantId: string; quantity: number; picked: number }> }> }
export interface QueueTransfer { id: string; number: string; fromLocationName: string | null; toLocationName: string | null; status: string; lines: Array<{ variantId: string; name: string; quantity: number; shipped: number; received: number }> }
export interface Queue { location: { id: string; name: string }; orders: QueueOrder[]; transfersToShip: QueueTransfer[]; transfersToReceive: QueueTransfer[]; countsInProgress: Array<{ id: string; name: string }> }
export interface CountDetail { id: string; name: string; status: string; lines: Array<{ variantId: string; sku: string; name: string; countedQty: number | null; expectedQty: number | null }> }
export interface SalesPulse { asOf: string; orders: { toFulfil: number; readyForPickup: number; needsAttention: number; backordered: number }; revenueByCurrency: Array<{ currency: string; today: M; last7Days: M; orders7: number }>; sales: Array<{ locationId: string; locationName: string; currency: string; today: { orders: number; gross: M }; last7Days: { orders: number; gross: M } }> | null; stock: { low: number; out: number } }

const ORDERS_KEY = 'bh.shop.orders';

// ───────── mock sample ─────────
const now = () => new Date().toISOString();
const usd = (n: number): M => ({ amount: n, currency: 'USD' });
const MOCK_PRODUCTS: ShopProduct[] = [
  { id: 'p1', slug: 'field-notebook', name: 'Field notebook', description: 'Recycled paper, lay-flat binding.', image: 'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800&q=70&auto=format&fit=crop', priceFrom: usd(1800), specs: { Paper: '100 gsm, recycled' }, returnable: true, variants: [{ id: 'v1', name: 'Dot grid', options: { Ruling: 'Dot grid' }, price: usd(1800), availability: 'in_stock' }, { id: 'v2', name: 'Ruled', options: { Ruling: 'Ruled' }, price: usd(1800), availability: 'low_stock' }] },
  { id: 'p2', slug: 'brass-rollerball', name: 'Brass rollerball', description: 'Machined brass, refillable.', image: 'https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?w=800&q=70&auto=format&fit=crop', priceFrom: usd(4800), specs: { Body: 'Solid brass' }, returnable: true, variants: [{ id: 'v3', name: 'Raw brass', options: {}, price: usd(4800), availability: 'in_stock' }] },
  { id: 'p3', slug: 'waxed-canvas-tote', name: 'Waxed canvas tote', description: 'Heavyweight waxed canvas.', image: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&q=70&auto=format&fit=crop', priceFrom: usd(6800), specs: {}, returnable: true, variants: [{ id: 'v4', name: 'Olive', options: {}, price: usd(6800), availability: 'out_of_stock' }] },
];
let mockOrders: ShopOrder[] = [];
const mockQueue: Queue = {
  location: { id: 'pd', name: 'Portland store' },
  orders: [{ id: 'o1', number: 'PD-1002', customer: { name: 'Claire Dubois' }, fulfilmentStatus: 'unfulfilled', fulfilmentMethod: 'pickup', lines: [{ variantId: 'v1', name: 'Field notebook — Dot grid', quantity: 2 }], fulfilments: [] }],
  transfersToShip: [], transfersToReceive: [{ id: 't1', number: 'TR-1002', fromLocationName: 'San Francisco', toLocationName: 'Portland store', status: 'in_transit', lines: [{ variantId: 'v1', name: 'Field notebook — Dot grid', quantity: 6, shipped: 6, received: 0 }] }],
  countsInProgress: [{ id: 'c1', name: 'Shelf B — notebooks' }],
};
const mockCount: CountDetail = { id: 'c1', name: 'Shelf B — notebooks', status: 'in_progress', lines: [{ variantId: 'v1', sku: 'FN-NB-DOT', name: 'Field notebook — Dot grid', countedQty: null, expectedQty: null }, { variantId: 'v2', sku: 'FN-NB-RUL', name: 'Field notebook — Ruled', countedQty: null, expectedQty: null }] };
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150));

// ───────── live helpers ─────────
let orgCache: { id: string } | null = null;
async function commerceOrg() {
  if (orgCache) return orgCache;
  const r = await http<{ items: Array<{ id: string; slug: string; industry: string }> }>('GET', '/orgs');
  const o = r.items.find((x) => x.industry === 'commerce');
  if (!o) throw new ApiError(404, 'no_commerce_org', 'No shop organisation on this account');
  orgCache = { id: o.id };
  return orgCache;
}
const org = async (path: string) => `/orgs/${(await commerceOrg()).id}/commerce${path}`;

export const commerce = {
  async stores(): Promise<ShopStore[]> {
    if (env.useMocks) return delay([{ id: 'pd', slug: 'portland', name: 'Portland store', city: 'Portland', currency: 'USD' }]);
    const r = await http<{ items?: Array<{ id: string; slug: string; name: string; address: { city: string }; currency: string }>; locations?: Array<{ id: string; slug: string; name: string; address: { city: string }; currency: string }> }>('GET', `/public/locations/${SHOP_BRAND}`, undefined, { auth: false });
    return (r.items ?? r.locations ?? []).map((l) => ({ id: l.id, slug: l.slug, name: l.name, city: l.address.city, currency: l.currency }));
  },
  async storefront(store: ShopStore): Promise<{ checkout: { mode: string; provider: string | null; url: string | null }; sandboxPayments: boolean }> {
    if (env.useMocks) return delay({ checkout: { mode: 'native', provider: null, url: null }, sandboxPayments: true });
    return http('GET', `/public/commerce/${SHOP_BRAND}/${store.slug}/storefront`, undefined, { auth: false });
  },
  async products(store: ShopStore, locale: string): Promise<ShopProduct[]> {
    if (env.useMocks) return delay(MOCK_PRODUCTS);
    return (await http<{ items: ShopProduct[] }>('GET', `/public/commerce/${SHOP_BRAND}/${store.slug}/products?locale=${encodeURIComponent(locale)}`, undefined, { auth: false })).items;
  },
  async quote(store: ShopStore, lines: Array<{ variantId: string; quantity: number }>): Promise<Quote> {
    if (env.useMocks) { const sub = lines.reduce((a, l) => a + (MOCK_PRODUCTS.flatMap((p) => p.variants).find((v) => v.id === l.variantId)?.price?.amount ?? 0) * l.quantity, 0); return delay({ subtotal: usd(sub), total: usd(sub), amountDue: usd(sub), taxLines: [], ok: true, issues: [] }); }
    return http('POST', `/public/commerce/locations/${store.id}/quote`, { lines, fulfilment: { method: 'pickup' } }, { auth: false });
  },
  async checkout(store: ShopStore, lines: Array<{ variantId: string; quantity: number }>, contact: { name: string; email: string }, expectedTotalMinor: number): Promise<{ order: ShopOrder; manageToken: string; payment: { id: string; sandbox: boolean } | null }> {
    if (env.useMocks) {
      const o: ShopOrder = { id: `mo${Date.now()}`, number: `PD-${1000 + mockOrders.length + 10}`, status: 'pending_payment', paymentStatus: 'pending', fulfilmentStatus: 'unfulfilled', fulfilmentMethod: 'pickup', locationName: store.name, fulfilmentLocationName: store.name, lines: lines.map((l) => ({ variantId: l.variantId, name: MOCK_PRODUCTS.flatMap((p) => p.variants.map((v) => ({ v, p }))).find((x) => x.v.id === l.variantId)?.p.name ?? 'Item', quantity: l.quantity, lineTotal: usd(1800 * l.quantity) })), total: usd(expectedTotalMinor), amountDue: usd(expectedTotalMinor), createdAt: now(), reservationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), payment: { id: 'pay_mock', state: 'created', sandbox: true }, returnable: [], returns: [] };
      mockOrders = [o, ...mockOrders];
      await rememberOrder(o.id, 'mock-token-0000');
      return delay({ order: o, manageToken: 'mock-token-0000', payment: { id: 'pay_mock', sandbox: true } });
    }
    const r = await http<{ order: ShopOrder; manageToken: string; payment: { id: string; sandbox: boolean } | null }>('POST', `/public/commerce/locations/${store.id}/checkout`, { lines, fulfilment: { method: 'pickup' }, contact, expectedTotalMinor });
    await rememberOrder(r.order.id, r.manageToken);
    return r;
  },
  async pay(paymentId: string, orderId: string) {
    if (env.useMocks) { mockOrders = mockOrders.map((o) => (o.id === orderId ? { ...o, status: 'paid', paymentStatus: 'paid', reservationExpiresAt: null } : o)); return delay(true); }
    const r = await http<{ payment: { state: string } }>('POST', `/public/payments/${paymentId}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false });
    return r.payment.state === 'succeeded';
  },
  async order(id: string): Promise<ShopOrder> {
    if (env.useMocks) { const o = mockOrders.find((x) => x.id === id); if (!o) throw new ApiError(404, 'not_found', 'Order not found'); return delay(o); }
    const tokens = await storedOrders();
    const tk = tokens[id];
    if (tk) return http('GET', `/public/commerce/orders/${id}?token=${encodeURIComponent(tk)}`, undefined, { auth: false });
    return http('GET', `/me/commerce/orders/${id}`);
  },
  async myOrders(): Promise<ShopOrder[]> {
    if (env.useMocks) return delay(mockOrders);
    const tokens = await storedOrders();
    const fromTokens = await Promise.all(Object.entries(tokens).map(([id, tk]) => http<ShopOrder>('GET', `/public/commerce/orders/${id}?token=${encodeURIComponent(tk)}`, undefined, { auth: false }).catch(() => null)));
    const mine = await http<{ items: ShopOrder[] }>('GET', '/me/commerce/orders').then((r) => r.items).catch(() => [] as ShopOrder[]);
    const all = new Map<string, ShopOrder>();
    for (const o of [...mine, ...fromTokens.filter((x): x is ShopOrder => !!x)]) all.set(o.id, o);
    return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async requestReturn(id: string, lines: Array<{ variantId: string; quantity: number }>) {
    if (env.useMocks) return delay(true);
    const tk = (await storedOrders())[id];
    if (tk) await http('POST', `/public/commerce/orders/${id}/returns?token=${encodeURIComponent(tk)}`, { lines }, { auth: false });
    else await http('POST', `/me/commerce/orders/${id}/returns`, { lines });
    return true;
  },
  // ── Staff ──
  async staffStores(): Promise<Array<{ id: string; name: string }>> {
    if (env.useMocks) return delay([{ id: 'pd', name: 'Portland store' }]);
    const o = await commerceOrg();
    return (await http<{ items: Array<{ id: string; name: string }> }>('GET', `/orgs/${o.id}/locations`)).items;
  },
  async queue(locationId: string): Promise<Queue> {
    if (env.useMocks) return delay(mockQueue);
    return http('GET', `${await org('/fulfilment-queue')}?locationId=${locationId}`);
  },
  async startPicking(orderId: string) { if (env.useMocks) { const o = mockQueue.orders.find((x) => x.id === orderId)!; o.fulfilments = [{ id: 'f1', status: 'picking', next: ['packed'], lines: o.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, picked: 0 })) }]; o.fulfilmentStatus = 'picking'; return delay(true); } await http('POST', await org(`/sales-orders/${orderId}/fulfilments`), {}); return true; },
  async pickAll(f: QueueOrder['fulfilments'][number]) { if (env.useMocks) { f.lines.forEach((l) => { l.picked = l.quantity; }); return delay(true); } await http('POST', await org(`/fulfilments/${f.id}/pick`), { lines: f.lines.map((l) => ({ variantId: l.variantId, picked: l.quantity })) }); return true; },
  async advance(f: QueueOrder['fulfilments'][number], to: string, trackingNumber?: string) {
    if (env.useMocks) { f.status = to; f.next = to === 'packed' ? ['ready'] : to === 'ready' ? ['collected'] : []; return delay(true); }
    await http('POST', await org(`/fulfilments/${f.id}/status`), { to, ...(trackingNumber ? { trackingNumber, carrier: 'Carrier' } : {}) }); return true;
  },
  async shipTransfer(id: string) { if (env.useMocks) return delay(true); await http('POST', await org(`/transfers/${id}/ship`), {}); return true; },
  async receiveTransfer(t: QueueTransfer, qty: Record<string, number>) {
    if (env.useMocks) { mockQueue.transfersToReceive = mockQueue.transfersToReceive.filter((x) => x.id !== t.id); return delay(true); }
    await http('POST', await org(`/transfers/${t.id}/receive`), { lines: t.lines.map((l) => ({ variantId: l.variantId, quantity: qty[l.variantId] ?? l.shipped })) }); return true;
  },
  async count(id: string): Promise<CountDetail> { if (env.useMocks) return delay(mockCount); return http('GET', await org(`/stock-counts/${id}`)); },
  async saveCount(id: string, entries: Array<{ variantId: string; countedQty: number }>, submit: boolean) {
    if (env.useMocks) { for (const e of entries) { const l = mockCount.lines.find((x) => x.variantId === e.variantId); if (l) l.countedQty = e.countedQty; } if (submit) mockCount.status = 'submitted'; return delay(true); }
    if (entries.length) await http('POST', await org(`/stock-counts/${id}/entries`), { entries });
    if (submit) await http('POST', await org(`/stock-counts/${id}/submit`), {});
    return true;
  },
  // ── Owner ──
  async pulse(): Promise<SalesPulse> {
    if (env.useMocks) return delay({ asOf: now(), orders: { toFulfil: 4, readyForPickup: 1, needsAttention: 1, backordered: 1 }, revenueByCurrency: [{ currency: 'USD', today: usd(24400), last7Days: usd(188200), orders7: 31 }, { currency: 'CAD', today: { amount: 8900, currency: 'CAD' }, last7Days: { amount: 61200, currency: 'CAD' }, orders7: 12 }, { currency: 'EUR', today: { amount: 0, currency: 'EUR' }, last7Days: { amount: 40400, currency: 'EUR' }, orders7: 9 }], sales: null, stock: { low: 3, out: 1 } });
    return http('GET', await org('/overview'));
  },
};

async function storedOrders(): Promise<Record<string, string>> {
  try { return JSON.parse((await storage.get(ORDERS_KEY)) ?? '{}') as Record<string, string>; } catch { return {}; }
}
async function rememberOrder(id: string, token: string) {
  const all = await storedOrders();
  all[id] = token;
  await storage.set(ORDERS_KEY, JSON.stringify(all));
}
