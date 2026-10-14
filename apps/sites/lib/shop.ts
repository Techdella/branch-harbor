/** Commerce storefront view models and the browser client (same-origin /api/shop proxy). */
import type { Address, Money } from './types';
import { fallbackText } from './fallback-messages';

export type Band = 'in_stock' | 'low_stock' | 'out_of_stock' | 'backorder' | 'not_stocked';
export interface ShopVariant { id: string; sku: string; name: string; options: Record<string, string>; imageUrl: string | null; price: Money | null; availability: Band }
export interface ShopProduct {
  id: string; slug: string | null; name: string; description: string | null; vendor: string | null; productType: string | null;
  options: Array<{ name: string; values: string[] }>; specs: Record<string, string>; images: Array<{ url: string; alt: string; variantId: string | null }>; image: string | null;
  returnable: boolean; priceFrom: Money | null; priceVaries: boolean; variants: ShopVariant[]; availability: 'in_stock' | 'backorder' | 'out_of_stock';
  otherStores?: Array<{ id: string; name: string; slug: string; currency: string; sameCurrency: boolean; variants: Array<{ id: string; availability: Band }> }>;
}
export interface Storefront {
  brand: { name: string; slug: string };
  location: { id: string; name: string; slug: string; currency: string; locale: string; timeZone: string; country: string; address: Address };
  checkout: { mode: 'native' | 'external' | 'disabled'; provider: string | null; url: string | null };
  paymentsEnabled: boolean; sandboxPayments: boolean;
  fulfilment: {
    pickup: { enabled: boolean; instructions: string | null; readyMinutes: number };
    localDelivery: { enabled: boolean; fee: Money; freeOver: Money | null; servesPostcodes: string[] };
    shipping: { enabled: boolean; fee: Money; countries: string[] };
    collectAt: Array<{ id: string; name: string; slug: string; address: Address }>;
  };
  taxes: Array<{ name: string; rateBps: number; inclusive: boolean }>; taxConfigured: boolean;
  reservationMinutes: number; returnWindowDays: number;
  collections: Array<{ id: string; slug: string; title: string; description: string | null; imageUrl: string | null; productCount: number }>;
}
export interface Quote {
  lines: Array<{ variantId: string; name: string; quantity: number; unitPrice: Money; lineTotal: Money; availability: 'in_stock' | 'backorder' | 'unavailable'; message: string | null }>;
  subtotal: Money; fulfilmentFee: Money; taxLines: Array<{ name: string; rateBps: number; inclusive: boolean; amount: Money }>; taxConfigured: boolean; total: Money;
  credit: { applied: Money; balance: Money; last4: string } | null; amountDue: Money; issues: Array<{ field: string; message: string }>; ok: boolean;
  fulfilment: { method: string; collectLocation: { id: string; name: string } | null; transfer: boolean; readyEstimateMinutes: number | null }; reservationMinutes: number;
}
export interface PublicOrder {
  id: string; number: string; status: string; paymentStatus: string; fulfilmentStatus: string; fulfilmentMethod: 'pickup' | 'local_delivery' | 'shipping'; crossLocation: boolean;
  locationName: string | null; fulfilmentLocationName: string | null; currency: string;
  lines: Array<{ variantId: string; name: string; quantity: number; unitPrice: Money; lineTotal: Money; backordered?: number }>;
  subtotal: Money; fulfilmentFee: Money; taxLines: Array<{ name: string; rateBps: number; inclusive: boolean; amount: Money }>; total: Money; creditApplied: Money; amountDue: Money; refunded: Money;
  reservationExpiresAt: string | null; history: Array<{ at: string; event: string; note?: string }>; createdAt: string; paidAt: string | null;
  fulfilments: Array<{ id: string; method: string; status: string; carrier: string | null; trackingNumber: string | null }>; transfer: { number: string; status: string } | null;
  brand: { name: string; slug: string }; store: { name: string; slug: string; address: Address; timeZone: string; phone: string | null; pickupInstructions: string | null };
  payment: { id: string; state: string; sandbox: boolean } | null;
  returns: Array<{ id: string; rmaNumber: string | null; status: string; lines: Array<{ name?: string; quantity: number }>; resolution: string | null; createdAt: string }>;
  returnPolicy: { days: number; endsAt: string; open: boolean }; returnable: Array<{ variantId: string; name: string; max: number }>; cancellable: boolean;
}

export type ShopResult<T> = { ok: true; data: T; status: number } | { ok: false; status: number; error: { code: string; message: string; fields?: Record<string, string>; details?: Record<string, unknown> } };

/** Browser → /api/shop/<path under /v1> (public commerce, sandbox payments, auth login and /me/commerce). */
export async function shop<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { token?: string | null; idempotencyKey?: string } = {}): Promise<ShopResult<T>> {
  try {
    const res = await fetch(`/api/shop${path}`, {
      method, cache: 'no-store',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: (json.error as { code: string; message: string; fields?: Record<string, string> }) ?? { code: 'http_error', message: fallbackText('requestFailed', { status: res.status }) } };
    return { ok: true, data: json as T, status: res.status };
  } catch {
    return { ok: false, status: 0, error: { code: 'network', message: fallbackText('network') } };
  }
}

export interface CartLine { variantId: string; productId: string; productSlug: string | null; name: string; variantName: string; quantity: number; unit: Money | null; image: string | null }
const cartKey = (locationId: string) => `bh_cart_${locationId}`;
export function readCart(locationId: string): CartLine[] {
  try { return JSON.parse(localStorage.getItem(cartKey(locationId)) ?? '[]') as CartLine[]; } catch { return []; }
}
export function writeCart(locationId: string, lines: CartLine[]) {
  try { localStorage.setItem(cartKey(locationId), JSON.stringify(lines)); window.dispatchEvent(new Event('bh-cart')); } catch { /* storage unavailable */ }
}
