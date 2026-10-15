/**
 * Commerce data for the mobile app (customer shop, store associate shop floor, owner sales pulse):
 * /v1/public/commerce/*, /v1/me/commerce/* and /v1/orgs/:orgId/commerce/*.
 */
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import { storage } from '@/lib/storage';
import type { Money } from '@bh/shared';
import { payPayment, type PayablePayment, type Translate } from '@/lib/cardPayment';

export const SHOP_BRAND = process.env.EXPO_PUBLIC_SHOP_BRAND || 'fieldnote-goods';
type M = Money;

export interface ShopStore { id: string; slug: string; name: string; city: string; currency: string }
export interface ShopVariant { id: string; name: string; options: Record<string, string>; price: M | null; availability: 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'not_stocked' }
export interface ShopProduct { id: string; slug: string | null; name: string; description: string | null; image: string | null; priceFrom: M | null; variants: ShopVariant[]; specs: Record<string, string>; returnable: boolean }
export interface Quote { total: M; subtotal: M; taxLines: Array<{ name: string; rateBps: number; inclusive: boolean; amount: M }>; amountDue: M; ok: boolean; issues: Array<{ field: string; message: string }> }
export interface ShopOrder {
  id: string; number: string; status: string; paymentStatus: string; fulfilmentStatus: string; fulfilmentMethod: string; locationName: string | null; fulfilmentLocationName: string | null;
  lines: Array<{ variantId: string; name: string; quantity: number; lineTotal: M }>; total: M; amountDue: M; createdAt: string; reservationExpiresAt: string | null;
  payment?: { id: string; state: string; sandbox: boolean; clientSecret?: string | null } | null; returnable?: Array<{ variantId: string; name: string; max: number }>; returns?: Array<{ id: string; rmaNumber: string | null; status: string }>;
  returnPolicy?: { open: boolean; endsAt: string };
}
export interface QueueOrder { id: string; number: string; customer: { name: string | null }; fulfilmentStatus: string; fulfilmentMethod: string; lines: Array<{ variantId: string; name: string; quantity: number }>; fulfilments: Array<{ id: string; status: string; next: string[]; lines: Array<{ variantId: string; quantity: number; picked: number }> }> }
export interface QueueTransfer { id: string; number: string; fromLocationName: string | null; toLocationName: string | null; status: string; lines: Array<{ variantId: string; name: string; quantity: number; shipped: number; received: number }> }
export interface Queue { location: { id: string; name: string }; orders: QueueOrder[]; transfersToShip: QueueTransfer[]; transfersToReceive: QueueTransfer[]; countsInProgress: Array<{ id: string; name: string }> }
export interface CountDetail { id: string; name: string; status: string; lines: Array<{ variantId: string; sku: string; name: string; countedQty: number | null; expectedQty: number | null }> }
export interface SalesPulse { asOf: string; orders: { toFulfil: number; readyForPickup: number; needsAttention: number; backordered: number }; revenueByCurrency: Array<{ currency: string; today: M; last7Days: M; orders7: number }>; sales: Array<{ locationId: string; locationName: string; currency: string; today: { orders: number; gross: M }; last7Days: { orders: number; gross: M } }> | null; stock: { low: number; out: number } }

const ORDERS_KEY = 'bh.shop.orders';

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
    const r = await http<{ items?: Array<{ id: string; slug: string; name: string; address: { city: string }; currency: string }>; locations?: Array<{ id: string; slug: string; name: string; address: { city: string }; currency: string }> }>('GET', `/public/locations/${SHOP_BRAND}`, undefined, { auth: false });
    return (r.items ?? r.locations ?? []).map((l) => ({ id: l.id, slug: l.slug, name: l.name, city: l.address.city, currency: l.currency }));
  },
  async storefront(store: ShopStore): Promise<{ checkout: { mode: string; provider: string | null; url: string | null }; sandboxPayments: boolean }> {
    return http('GET', `/public/commerce/${SHOP_BRAND}/${store.slug}/storefront`, undefined, { auth: false });
  },
  async products(store: ShopStore, locale: string): Promise<ShopProduct[]> {
    return (await http<{ items: ShopProduct[] }>('GET', `/public/commerce/${SHOP_BRAND}/${store.slug}/products?locale=${encodeURIComponent(locale)}`, undefined, { auth: false })).items;
  },
  async quote(store: ShopStore, lines: Array<{ variantId: string; quantity: number }>): Promise<Quote> {
    return http('POST', `/public/commerce/locations/${store.id}/quote`, { lines, fulfilment: { method: 'pickup' } }, { auth: false });
  },
  async checkout(store: ShopStore, lines: Array<{ variantId: string; quantity: number }>, contact: { name: string; email: string }, expectedTotalMinor: number): Promise<{ order: ShopOrder; manageToken: string; payment: { id: string; sandbox: boolean; clientSecret?: string | null } | null }> {
    const r = await http<{ order: ShopOrder; manageToken: string; payment: { id: string; sandbox: boolean; clientSecret?: string | null } | null }>('POST', `/public/commerce/locations/${store.id}/checkout`, { lines, fulfilment: { method: 'pickup' }, contact, expectedTotalMinor });
    await rememberOrder(r.order.id, r.manageToken);
    return r;
  },
  /** PaymentSheet on iOS/Android (sandbox: simulated); resolves once the API has the signed webhook. */
  async pay(payment: PayablePayment, orderId: string, t?: Translate) {
    const r = await payPayment(payment, t);
    if (!r.ok && !r.cancelled) throw new Error(r.message);
    return r.ok;
  },
  async order(id: string): Promise<ShopOrder> {
    const tokens = await storedOrders();
    const tk = tokens[id];
    if (tk) return http('GET', `/public/commerce/orders/${id}?token=${encodeURIComponent(tk)}`, undefined, { auth: false });
    return http('GET', `/me/commerce/orders/${id}`);
  },
  async myOrders(): Promise<ShopOrder[]> {
    const tokens = await storedOrders();
    const fromTokens = await Promise.all(Object.entries(tokens).map(([id, tk]) => http<ShopOrder>('GET', `/public/commerce/orders/${id}?token=${encodeURIComponent(tk)}`, undefined, { auth: false }).catch(() => null)));
    const mine = await http<{ items: ShopOrder[] }>('GET', '/me/commerce/orders').then((r) => r.items).catch(() => [] as ShopOrder[]);
    const all = new Map<string, ShopOrder>();
    for (const o of [...mine, ...fromTokens.filter((x): x is ShopOrder => !!x)]) all.set(o.id, o);
    return [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async requestReturn(id: string, lines: Array<{ variantId: string; quantity: number }>) {
    const tk = (await storedOrders())[id];
    if (tk) await http('POST', `/public/commerce/orders/${id}/returns?token=${encodeURIComponent(tk)}`, { lines }, { auth: false });
    else await http('POST', `/me/commerce/orders/${id}/returns`, { lines });
    return true;
  },
  // ── Staff ──
  async staffStores(): Promise<Array<{ id: string; name: string }>> {
    const o = await commerceOrg();
    return (await http<{ items: Array<{ id: string; name: string }> }>('GET', `/orgs/${o.id}/locations`)).items;
  },
  async queue(locationId: string): Promise<Queue> {
    return http('GET', `${await org('/fulfilment-queue')}?locationId=${locationId}`);
  },
  async startPicking(orderId: string) { await http('POST', await org(`/sales-orders/${orderId}/fulfilments`), {}); return true; },
  async pickAll(f: QueueOrder['fulfilments'][number]) { await http('POST', await org(`/fulfilments/${f.id}/pick`), { lines: f.lines.map((l) => ({ variantId: l.variantId, picked: l.quantity })) }); return true; },
  async advance(f: QueueOrder['fulfilments'][number], to: string, trackingNumber?: string) {
    await http('POST', await org(`/fulfilments/${f.id}/status`), { to, ...(trackingNumber ? { trackingNumber, carrier: 'Carrier' } : {}) }); return true;
  },
  async shipTransfer(id: string) { await http('POST', await org(`/transfers/${id}/ship`), {}); return true; },
  async receiveTransfer(t: QueueTransfer, qty: Record<string, number>) {
    await http('POST', await org(`/transfers/${t.id}/receive`), { lines: t.lines.map((l) => ({ variantId: l.variantId, quantity: qty[l.variantId] ?? l.shipped })) }); return true;
  },
  async count(id: string): Promise<CountDetail> { return http('GET', await org(`/stock-counts/${id}`)); },
  async saveCount(id: string, entries: Array<{ variantId: string; countedQty: number }>, submit: boolean) {
    if (entries.length) await http('POST', await org(`/stock-counts/${id}/entries`), { entries });
    if (submit) await http('POST', await org(`/stock-counts/${id}/submit`), {});
    return true;
  },
  // ── Owner ──
  async pulse(): Promise<SalesPulse> {
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
