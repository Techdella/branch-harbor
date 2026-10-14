/**
 * Deliverect client and mappers. BranchHarbor plays two Deliverect roles per location:
 *
 *  (a) ORDERING CHANNEL → POS: an accepted BranchHarbor order is injected into the location's POS through
 *      Deliverect's Channel API: POST {base}/{channelName}/order/{channelLinkId}.
 *  (b) POS for MARKETPLACES: Deliverect forwards Uber Eats / Deliveroo / DoorDash / Just Eat orders to our order
 *      webhook (/v1/webhooks/deliverect); we push status updates back (POST {base}/orderStatus/{orderId}),
 *      publish the location menu (POST {base}/productAndCategories), snooze sold-out items and set busy mode.
 *
 * Documented (developers.deliverect.com, retrieved 2026-10):
 *  - OAuth: POST {base}/oauth/token JSON { client_id, client_secret, audience: base, grant_type: "client_credentials" }
 *    → { access_token, expires_at (epoch s), expires_in }. Cache until expiry; never fetch a token per call.
 *  - Staging base https://api.staging.deliverect.com, production https://api.deliverect.com (after certification).
 *  - Webhook HMAC: header `x-server-authorization-hmac-sha256` = hex HMAC-SHA256 of the raw body. Staging signs with
 *    the channelLink id (or locationId); production uses the secret generated in the partner integration settings.
 *  - POS order fields: _id, channelOrderId, channelOrderDisplayId, channel (int), channelLink, location, status,
 *    orderType (1 pickup, 2 delivery, 3 eat-in), items[{plu,name,price,quantity,remark,subItems}], decimalDigits,
 *    payment{amount,type,due}, orderIsAlreadyPaid, taxes[{name,taxClassId,total}], taxTotal, deliveryCost,
 *    serviceCharge, bagFee, smallOrderFee, tip, driverTip, discountTotal (negative), customer, deliveryAddress,
 *    pickupTime, deliveryTime, note. Channel orders + `channel` are unique for 48 h. Cancellations arrive as a new
 *    order with status 100 and the original _id.
 *  - POS statuses: 10 new, 20 accepted, 40 printed, 50 preparing, 60 prepared, 70 pickup ready, 90 finalized,
 *    110 canceled (POS void), 120 failed. Allergen product tags: 100 celery … 113 sulphites, 105 lupin.
 *
 * ASSUMPTIONS (confirm during Deliverect certification): the exact paths for snooze
 * (POST /locations/{locationId}/snooze) and busy mode (POST /locations/{locationId}/busyMode), the channel-order
 * cancel shape (same endpoint with status 100), and the marketplace channel id table below.
 */
import type { FoodAllergen } from '@bh/shared';
import { PartnerHttpError, requestJson, TokenCache, verifyHmacHex, type FetchLike } from './http.ts';

export const DELIVERECT_BASE = { staging: 'https://api.staging.deliverect.com', production: 'https://api.deliverect.com' } as const;
export type DeliverectEnv = keyof typeof DELIVERECT_BASE;

export interface DeliverectCredentials { clientId: string; clientSecret: string; webhookSecret?: string }
export interface DeliverectConfig {
  environment?: DeliverectEnv;
  /** Deliverect account + location ids (POS role, marketplace orders). */
  accountId?: string;
  deliverectLocationId?: string;
  /** Channel role (POS injection): channel name assigned to BranchHarbor by Deliverect and the location's channel link. */
  channelName?: string;
  channelLinkId?: string;
  posInjection?: boolean;
  marketplaceOrders?: boolean;
  autoAccept?: boolean;
}

/** Deliverect marketplace channel ids (assumed; Deliverect lists them via GET Integrated Channels). */
export const DELIVERECT_CHANNELS: Record<number, { key: string; name: string }> = {
  1: { key: 'deliveroo', name: 'Deliveroo' },
  7: { key: 'uber_eats', name: 'Uber Eats' },
  12: { key: 'doordash', name: 'DoorDash' },
  15: { key: 'just_eat', name: 'Just Eat' },
};
export const channelInfo = (id: unknown) => DELIVERECT_CHANNELS[Number(id)] ?? { key: `deliverect_channel_${String(id)}`, name: `Deliverect channel ${String(id)}` };

/** Our food order state → Deliverect POS status sent back to the marketplace. */
export const OUR_TO_DELIVERECT_STATUS: Record<string, number> = {
  accepted: 20, preparing: 50, ready: 70, out_for_delivery: 90, collected: 90, delivered: 90, served: 90, rejected: 110, cancelled: 110,
};

/** Deliverect allergen product tags. Only allergens the business declared are ever sent. Wheat has no own tag. */
export const DELIVERECT_ALLERGEN_TAGS: Partial<Record<FoodAllergen, number>> = {
  celery: 100, cereals_gluten: 101, crustaceans: 102, fish: 103, eggs: 104, lupin: 105, milk: 106, molluscs: 107,
  mustard: 108, tree_nuts: 109, peanuts: 110, sesame: 111, soybeans: 112, sulphites: 113,
};

/** Stable PLUs: what we publish in the menu is what comes back on marketplace orders. */
export const itemPlu = (id: string) => `bh-${id}`;
export const modifierPlu = (id: string) => `bhm-${id}`;
export const pluToId = (plu: unknown): { kind: 'item' | 'modifier'; id: string } | null => {
  const m = /^bh(m?)-([0-9a-f-]{36})$/i.exec(String(plu ?? ''));
  return m ? { kind: m[1] ? 'modifier' : 'item', id: m[2]!.toLowerCase() } : null;
};

const sharedTokens = new TokenCache();

export function createDeliverectClient(opts: { creds: DeliverectCredentials; config: DeliverectConfig; fetch: FetchLike; baseUrl?: string; now?: () => number; tokens?: TokenCache }) {
  const env = opts.config.environment ?? 'staging';
  const base = (opts.baseUrl ?? DELIVERECT_BASE[env]).replace(/\/$/, '');
  const now = opts.now ?? Date.now;
  const tokens = opts.tokens ?? sharedTokens;
  const key = `deliverect:${env}:${opts.creds.clientId}`;

  async function token() {
    const hit = tokens.get(key, now());
    if (hit) return hit;
    const { data } = await requestJson<{ access_token: string; expires_at?: number; expires_in?: number }>('Deliverect', opts.fetch, `${base}/oauth/token`, {
      body: { client_id: opts.creds.clientId, client_secret: opts.creds.clientSecret, audience: base, grant_type: 'client_credentials' },
    });
    if (!data.access_token) throw new PartnerHttpError('Deliverect', 502, 'Deliverect did not return an access token');
    tokens.set(key, data.access_token, data.expires_at ? data.expires_at * 1000 : now() + (data.expires_in ?? 3600) * 1000);
    return data.access_token;
  }
  async function call<T>(path: string, body?: unknown, method = 'POST') {
    const t = await token();
    try {
      return (await requestJson<T>('Deliverect', opts.fetch, `${base}${path}`, { method, body, headers: { Authorization: `Bearer ${t}` } })).data;
    } catch (err) {
      if (err instanceof PartnerHttpError && err.status === 401) tokens.clear(key);
      throw err;
    }
  }
  const need = (v: string | undefined, name: string) => { if (!v) throw new PartnerHttpError('Deliverect', 400, `Deliverect ${name} is not configured for this location`); return v; };

  return {
    base, token,
    async test() { await token(); return { ok: true as const }; },
    /** (a) Inject an order into the POS as the BranchHarbor channel. */
    async injectOrder(order: Record<string, unknown>) {
      const c = opts.config;
      return call<Record<string, unknown>>(`/${encodeURIComponent(need(c.channelName, 'channel name'))}/order/${encodeURIComponent(need(c.channelLinkId, 'channel link id'))}`, order);
    },
    async cancelInjectedOrder(channelOrderId: string) {
      const c = opts.config;
      return call(`/${encodeURIComponent(need(c.channelName, 'channel name'))}/order/${encodeURIComponent(need(c.channelLinkId, 'channel link id'))}`, { channelOrderId, status: 100 });
    },
    /** (b) Report a marketplace order's status back (POS → Deliverect → channel). */
    async updateOrderStatus(deliverectOrderId: string, status: number, opt: { receiptId?: string; reason?: string; at?: Date } = {}) {
      return call(`/orderStatus/${encodeURIComponent(deliverectOrderId)}`, { orderId: deliverectOrderId, status, timeStamp: (opt.at ?? new Date(now())).toISOString().replace(/\.\d{3}Z$/, 'Z'), receiptId: opt.receiptId, reason: opt.reason });
    },
    async pushMenu(snapshot: DeliverectMenuSnapshot) {
      need(opts.config.accountId, 'account id'); need(opts.config.deliverectLocationId, 'location id');
      return call('/productAndCategories', snapshot);
    },
    async snooze(plus: string[], snoozed: boolean, until?: string | null) {
      const loc = need(opts.config.deliverectLocationId, 'location id');
      return call(`/locations/${encodeURIComponent(loc)}/snooze`, { accountId: opts.config.accountId, operations: [{ action: snoozed ? 'snooze' : 'unsnooze', data: { plus, ...(until ? { snoozeEnd: until } : {}) } }] });
    },
    async busyMode(paused: boolean, minutes?: number) {
      const loc = need(opts.config.deliverectLocationId, 'location id');
      return call(`/locations/${encodeURIComponent(loc)}/busyMode`, { accountId: opts.config.accountId, status: paused ? 'PAUSED' : 'ONLINE', ...(paused && minutes ? { delay: minutes } : {}) });
    },
  };
}
export type DeliverectClient = ReturnType<typeof createDeliverectClient>;

export const DELIVERECT_SIGNATURE_HEADER = 'x-server-authorization-hmac-sha256';
/** Verify against each candidate secret (production secret; in staging also the channel link / location id). */
export function verifyDeliverectSignature(raw: Buffer | string, header: string | undefined, secrets: Array<string | null | undefined>): boolean {
  return secrets.some((s) => !!s && verifyHmacHex(s, raw, header));
}

// ───────── Mappers ─────────

/** Deliverect amounts are integers with `decimalDigits` decimals; convert to our currency's minor units. */
export function toMinor(value: unknown, decimalDigits: number, currencyExponent: number): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10 ** (currencyExponent - decimalDigits));
}

export interface InboundOrderLine { plu: string; name: string; quantity: number; unitPriceMinor: number; remark: string | null; subItems: Array<{ plu: string; name: string; quantity: number; priceMinor: number }> }
export interface InboundOrder {
  deliverectId: string; channelOrderId: string; channelOrderDisplayId: string; channel: { id: number; key: string; name: string };
  channelLink: string | null; location: string | null; account: string | null; status: number; isCancellation: boolean;
  orderType: 'pickup' | 'delivery' | 'dine_in'; testOrder: boolean;
  lines: InboundOrderLine[]; subtotalMinor: number; taxMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; tipMinor: number;
  driverTipMinor: number; discountMinor: number; totalMinor: number; paid: boolean; dueMinor: number;
  customer: { name: string; phone: string | null; email: string | null; note: string | null };
  address: { line1: string; city: string; postalCode: string; country?: string; instructions?: string; lat?: number; lng?: number } | null;
  pickupTime: string | null; deliveryTime: string | null; note: string | null; timezone: string | null;
}

export function parseInboundOrder(p: Record<string, unknown>, currencyExponent: number): InboundOrder {
  const dd = Number(p.decimalDigits ?? 2);
  const m = (v: unknown) => toMinor(v, dd, currencyExponent);
  const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
  const lines: InboundOrderLine[] = items.map((it) => ({
    plu: String(it.plu ?? ''), name: String(it.name ?? 'Item'), quantity: Math.max(1, Number(it.quantity ?? 1)), unitPriceMinor: m(it.price), remark: typeof it.remark === 'string' ? it.remark : null,
    subItems: (Array.isArray(it.subItems) ? (it.subItems as Array<Record<string, unknown>>) : []).map((s) => ({ plu: String(s.plu ?? ''), name: String(s.name ?? ''), quantity: Math.max(1, Number(s.quantity ?? 1)), priceMinor: m(s.price) })),
  }));
  // Sub-item quantities are per parent item (Deliverect multiplies by the parent quantity).
  const subtotal = lines.reduce((a, l) => a + l.quantity * (l.unitPriceMinor + l.subItems.reduce((b, s) => b + s.quantity * s.priceMinor, 0)), 0);
  const taxes = Array.isArray(p.taxes) ? (p.taxes as Array<Record<string, unknown>>).reduce((a, t) => a + m(t.total), 0) : 0;
  const pay = (p.payment ?? {}) as Record<string, unknown>;
  const cust = (p.customer ?? {}) as Record<string, unknown>;
  const da = p.deliveryAddress as Record<string, unknown> | undefined;
  const coords = (da?.coordinates as { coordinates?: [number, number] } | undefined)?.coordinates;
  const ch = channelInfo(p.channel);
  const status = Number(p.status ?? 10);
  const orderType = Number(p.orderType ?? 2);
  const discount = Math.abs(m(p.discountTotal));
  const extras = m(p.bagFee) + m(p.smallOrderFee) + m(p.serviceCharge);
  const computedTotal = subtotal + (p.taxTotal != null ? m(p.taxTotal) : taxes) + m(p.deliveryCost) + extras + m(p.tip) - discount;
  return {
    deliverectId: String(p._id ?? ''), channelOrderId: String(p.channelOrderId ?? ''), channelOrderDisplayId: String(p.channelOrderDisplayId ?? p.channelOrderId ?? ''),
    channel: { id: Number(p.channel ?? 0), ...ch }, channelLink: (p.channelLink as string) ?? null, location: (p.location as string) ?? null, account: (p.account as string) ?? null,
    status, isCancellation: status === 100, orderType: orderType === 1 ? 'pickup' : orderType === 3 ? 'dine_in' : 'delivery', testOrder: p.testOrder === true,
    lines, subtotalMinor: subtotal, taxMinor: p.taxTotal != null ? m(p.taxTotal) : taxes, deliveryFeeMinor: m(p.deliveryCost), serviceChargeMinor: extras, tipMinor: m(p.tip),
    driverTipMinor: m(p.driverTip), discountMinor: discount, totalMinor: pay.amount != null ? m(pay.amount) : computedTotal,
    paid: p.orderIsAlreadyPaid === true, dueMinor: m(pay.due),
    customer: { name: String(cust.name ?? 'Marketplace customer').slice(0, 120), phone: (cust.phoneNumber as string) ?? null, email: (cust.email as string) ?? null, note: (cust.note as string) ?? null },
    address: da ? {
      line1: String(da.street ?? ''), city: String(da.city ?? ''), postalCode: String(da.postalCode ?? ''), country: typeof da.country === 'string' ? da.country : undefined,
      instructions: typeof da.extraAddressInfo === 'string' ? da.extraAddressInfo : undefined, ...(coords ? { lng: coords[0], lat: coords[1] } : {}),
    } : null,
    pickupTime: (p.pickupTime as string) ?? null, deliveryTime: (p.deliveryTime as string) ?? null, note: (p.note as string) ?? null, timezone: (p.timezone as string) ?? null,
  };
}

export interface ChannelOrderSource {
  id: string; orderNumber: string; channel: string; currency: string; currencyExponent: number;
  lines: Array<{ menuItemId: string; name: string; quantity: number; unitPriceMinor: number; notes?: string; modifiers: Array<{ id: string; name: string; priceMinor: number }> }>;
  subtotalMinor: number; taxMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; tipMinor: number; totalMinor: number;
  paid: boolean; contact: { name: string; email?: string; phone?: string }; notes: string | null; promisedAt: Date | null;
  address?: { line1: string; line2?: string; city: string; postalCode: string; instructions?: string; lat?: number; lng?: number } | null; tableLabel?: string | null;
}

/** BranchHarbor order → Deliverect channel order (amounts in 2-digit integers like the POS payload, or 0 for JPY). */
export function buildChannelOrder(o: ChannelOrderSource) {
  const dd = o.currencyExponent;
  const orderType = o.channel === 'delivery' || o.channel === 'meal_plan' || o.channel === 'catering' ? 2 : o.channel === 'dine_in' ? 3 : 1;
  const when = o.promisedAt?.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    channelOrderId: o.id, channelOrderDisplayId: o.orderNumber, orderType, decimalDigits: dd,
    items: o.lines.map((l) => ({
      plu: itemPlu(l.menuItemId), name: l.name, price: l.unitPriceMinor, quantity: l.quantity, ...(l.notes ? { remark: l.notes } : {}),
      subItems: l.modifiers.map((m) => ({ plu: modifierPlu(m.id), name: m.name, price: m.priceMinor, quantity: 1 })),
    })),
    payment: { amount: o.totalMinor, type: 0 }, orderIsAlreadyPaid: o.paid,
    taxes: o.taxMinor ? [{ name: 'Tax', taxClassId: 0, total: o.taxMinor }] : [], taxTotal: o.taxMinor,
    deliveryCost: o.deliveryFeeMinor, serviceCharge: o.serviceChargeMinor, tip: o.tipMinor,
    customer: { name: o.contact.name, ...(o.contact.phone ? { phoneNumber: o.contact.phone } : {}), ...(o.contact.email ? { email: o.contact.email } : {}) },
    ...(orderType === 2 && o.address ? { deliveryAddress: { street: [o.address.line1, o.address.line2].filter(Boolean).join(', '), postalCode: o.address.postalCode, city: o.address.city, extraAddressInfo: o.address.instructions, ...(o.address.lat != null && o.address.lng != null ? { coordinates: { coordinates: [o.address.lng, o.address.lat] } } : {}) } } : {}),
    ...(orderType === 2 ? { deliveryTime: when, deliveryIsAsap: !when } : { pickupTime: when }),
    ...(o.tableLabel ? { table: o.tableLabel } : {}),
    note: o.notes ?? undefined,
  };
}

export interface MenuSnapshotItem {
  id: string; name: string; description: string | null; category: string; categoryId: string | null; price: { amount: number } | null; available: boolean; soldOut: boolean;
  imageUrl: string | null; allergens: string[]; allergensDeclared: boolean;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; price: { amount: number } | null; available: boolean; soldOut: boolean; allergens: string[] }> }>;
}
export interface DeliverectMenuSnapshot {
  accountId: string; locationId: string; priceLevels: never[];
  categories: Array<{ name: string; posCategoryId: string }>;
  products: Array<Record<string, unknown>>;
  /** Not sent to Deliverect: what we derived (sold-out PLUs to snooze, allergens we could not map). */
  _meta?: { soldOutPlus: string[]; unmappedAllergens: Array<{ plu: string; allergen: string }>; skipped: Array<{ id: string; name: string; reason: string }> };
}

/**
 * Location menu snapshot in Deliverect's POS product model. Prices are the location's prices; unavailable items are
 * sent with visible=false; sold-out items are listed for snoozing. Allergen tags only for items whose allergens were
 * declared by the business (never inferred); allergens without a Deliverect tag are reported, not guessed.
 */
export function buildMenuSnapshot(items: MenuSnapshotItem[], ids: { accountId: string; locationId: string }, taxRateBps: number): DeliverectMenuSnapshot {
  const tax = Math.round(taxRateBps * 10); // Deliverect tax: integer with 3 decimals (20% → 20000); bps → ×10
  const categories = new Map<string, string>();
  const products: Array<Record<string, unknown>> = [];
  const soldOutPlus: string[] = [];
  const unmapped: Array<{ plu: string; allergen: string }> = [];
  const skipped: Array<{ id: string; name: string; reason: string }> = [];
  const tagsFor = (plu: string, list: string[], declared: boolean) => {
    if (!declared) return [];
    const out: number[] = [];
    for (const a of list) {
      const t = DELIVERECT_ALLERGEN_TAGS[a as FoodAllergen];
      if (t) out.push(t); else unmapped.push({ plu, allergen: a });
    }
    return [...new Set(out)];
  };
  for (const it of items) {
    if (!it.price) { skipped.push({ id: it.id, name: it.name, reason: 'No price in the location currency' }); continue; }
    const catId = it.categoryId ?? `cat-${it.category}`;
    categories.set(catId, it.category);
    const plu = itemPlu(it.id);
    if (it.soldOut) soldOutPlus.push(plu);
    const groupPlus: string[] = [];
    for (const g of it.modifierGroups) {
      const gplu = `bhg-${g.id}`;
      groupPlus.push(gplu);
      const modPlus: string[] = [];
      for (const m of g.modifiers) {
        if (!m.price) continue;
        const mplu = modifierPlu(m.id);
        modPlus.push(mplu);
        if (m.soldOut) soldOutPlus.push(mplu);
        products.push({ productType: 2, plu: mplu, name: m.name, price: m.price.amount, visible: m.available || m.soldOut, deliveryTax: tax, takeawayTax: tax, eatInTax: tax, productTags: tagsFor(mplu, m.allergens, it.allergensDeclared || m.allergens.length > 0) });
      }
      products.push({ productType: 3, plu: gplu, name: g.name, min: g.minSelect, max: g.maxSelect, subProducts: modPlus });
    }
    products.push({
      productType: 1, plu, posProductId: it.id, name: it.name, description: it.description ?? undefined, price: it.price.amount,
      // Sold-out items stay visible and are snoozed; items not offered (outside day-part etc.) remain visible but
      // Deliverect day-part scheduling is out of scope — only "not offered" is hidden.
      visible: it.available || it.soldOut, imageUrl: it.imageUrl ?? undefined, posCategoryIds: [catId],
      deliveryTax: tax, takeawayTax: tax, eatInTax: tax, subProducts: groupPlus, productTags: tagsFor(plu, it.allergens, it.allergensDeclared),
    });
  }
  return {
    accountId: ids.accountId, locationId: ids.locationId, priceLevels: [],
    categories: [...categories].map(([posCategoryId, name]) => ({ name, posCategoryId })), products,
    _meta: { soldOutPlus, unmappedAllergens: unmapped, skipped },
  };
}

/** Classify an inbound Deliverect webhook body. */
export function deliverectWebhookKind(p: Record<string, unknown>): 'order' | 'busy_mode' | 'channel_status' | 'unknown' {
  if (Array.isArray(p.items) && p.channelOrderId !== undefined) return 'order';
  if (p.status === 100 && p._id && p.channelOrderId !== undefined) return 'order';
  if (typeof p.status === 'string' && /^(PAUSED|ONLINE|BUSY)$/i.test(p.status)) return 'busy_mode';
  if (p.channelOrderId !== undefined && typeof p.status === 'number') return 'channel_status';
  return 'unknown';
}
