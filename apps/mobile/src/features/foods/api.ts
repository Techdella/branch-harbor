/**
 * Foods (full product) client for the mobile app: KDS by station (kitchen staff), deliveries (drivers),
 * live orders pulse (owner), meal plans and delivery checkout (customer). Calls apps/api.
 */
import type { Money } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import { payPayment } from '@/lib/cardPayment';

export interface KdsTicket {
  id: string; orderNumber: string; firstName: string; channel: string; tableLabel: string | null; status: 'queued' | 'in_progress' | 'done'; orderStatus: string;
  lines: Array<{ name: string; quantity: number; modifiers: string[]; notes?: string }>; orderNotes: string | null; targetAt: string; overdue: boolean; overdueMinutes: number;
}
export interface KdsFeed {
  location: { id: string; name: string; timeZone: string }; refreshedAt: string; audibleDefault: boolean; view: 'station' | 'expo';
  stations: Array<{ id: string; key: string; name: string; isExpo: boolean; open: number }>; tickets: KdsTicket[];
  orders: Array<{ id: string; orderNumber: string; firstName: string; channel: string; status: string; promisedAt: string | null; overdue: boolean; overdueMinutes: number; allStationsDone: boolean; lines: Array<{ name: string; quantity: number; modifiers: string[] }>; stations: Array<{ name: string; status: string }> }>;
}
export interface DriverDelivery {
  id: string; organizationId: string; status: string; provider: string;
  location: { id: string; name: string; timeZone: string; phone: string | null };
  order: { id: string; orderNumber: string; status: string; promisedAt: string | null; customerName: string; customerPhone: string | null; address: { line1: string; city: string; postalCode: string; instructions?: string } | null; items: number };
}
export interface PulseLocation { locationId: string; name: string; timeZone: string; orders: Record<string, number>; overdue: number; byChannel: Record<string, number>; soldOut: Array<{ name: string }>; lowStock: Array<{ name: string }>; catering: { new: number; depositPaid: number }; deliveries: { active: number; ordersAwaitingDispatch: number } }
export interface FoodsPulse { refreshedAt: string; orgs: Array<{ orgId: string; name: string; locations: PulseLocation[] }> }
export interface MySubscription { id: string; planName: string; locationName: string; status: string; price: Money; upcoming: Array<{ weekStart: string; fulfilmentDate: string; cutoffAt: string; skipped: boolean; canChange: boolean }> }
export interface DeliveryQuote { subtotal: Money; deliveryFee: Money | null; tax: Money | null; total: Money; zone: { name: string; minimumOrder: Money } | null }
export interface Slot { id: string; startsAt: string; remaining: number; available: boolean }

type RawMe = { organizations: Array<{ id: string; name: string; industry: string; roles: Array<{ role: string; scope: { kind: string; id: string } }> }> };
let orgsCache: RawMe['organizations'] | null = null;
const foodsOrgs = async () => (orgsCache ??= (await http<RawMe>('GET', '/auth/me')).organizations.filter((o) => o.industry === 'foods'));
const locOrg = new Map<string, string>();
async function orgFor(locationId: string) {
  if (locOrg.has(locationId)) return locOrg.get(locationId)!;
  for (const o of await foodsOrgs()) {
    const r = await http<{ items: Array<{ id: string }> }>('GET', `/orgs/${o.id}/locations`);
    r.items.forEach((l) => locOrg.set(l.id, o.id));
  }
  const org = locOrg.get(locationId);
  if (!org) throw new ApiError(404, 'not_found', 'Location not found in your organisations.');
  return org;
}

const live = {
  kds: async (locationId: string, stationId?: string | null): Promise<KdsFeed> => http('GET', `/orgs/${await orgFor(locationId)}/foods/kds?locationId=${locationId}${stationId ? `&stationId=${stationId}` : ''}`),
  ticket: async (locationId: string, id: string, action: 'start' | 'bump' | 'recall', expectedStatus?: string) => http<{ orderStatus: string; allStationsDone: boolean }>('POST', `/orgs/${await orgFor(locationId)}/foods/kds/tickets/${id}/${action}`, expectedStatus ? { expectedStatus } : {}),
  advanceOrder: async (locationId: string, orderId: string, to: string, from: string) => http('POST', `/orgs/${await orgFor(locationId)}/foods/orders/${orderId}/transition`, { to, expectedFrom: from }),
  myDeliveries: async (): Promise<DriverDelivery[]> => (await http<{ items: DriverDelivery[] }>('GET', '/me/foods/deliveries')).items,
  setDeliveryStatus: async (id: string, status: 'picked_up' | 'delivered' | 'failed', note?: string) => { await http('POST', `/me/foods/deliveries/${id}/status`, { status, note }); },
  pulse: async (): Promise<FoodsPulse> => {
    const orgs = await foodsOrgs();
    const out = await Promise.all(orgs.map(async (o) => ({ orgId: o.id, name: o.name, locations: (await http<{ locations: PulseLocation[] }>('GET', `/orgs/${o.id}/foods/overview`)).locations })));
    return { refreshedAt: new Date().toISOString(), orgs: out };
  },
  mySubscriptions: async (): Promise<MySubscription[]> => (await http<{ items: MySubscription[] }>('GET', '/me/foods/meal-plans')).items,
  skipWeek: async (id: string, weekStart: string, skip: boolean): Promise<MySubscription> => http('POST', `/me/foods/meal-plans/${id}/skip`, { weekStart, skip }),
  deliverySlots: async (locationId: string): Promise<Slot[]> => (await http<{ items: Slot[] }>('GET', `/public/foods/${locationId}/delivery-slots`, undefined, { auth: false })).items,
  deliveryQuote: async (locationId: string, body: { slotId: string; address: { line1: string; city: string; postalCode: string }; lines: Array<{ itemId: string; quantity: number; optionIds: string[] }> }): Promise<DeliveryQuote> =>
    http('POST', `/public/foods/${locationId}/checkout/quote`, { channel: 'delivery', deliverySlotId: body.slotId, address: body.address, lines: body.lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifierIds: l.optionIds })) }, { auth: false }),
  placeDelivery: async (locationId: string, body: { slotId: string; address: { line1: string; city: string; postalCode: string }; lines: Array<{ itemId: string; quantity: number; optionIds: string[] }>; name: string; email: string; phone?: string; expectedTotalMinor: number }) => {
    const r = await http<{ order: { id: string; orderNumber: string }; manageToken: string; payment: { id: string; sandbox: boolean; clientSecret?: string | null } | null }>('POST', `/public/foods/${locationId}/checkout`, {
      channel: 'delivery', deliverySlotId: body.slotId, address: body.address, lines: body.lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifierIds: l.optionIds })),
      contact: { name: body.name, email: body.email, ...(body.phone ? { phone: body.phone } : {}) }, expectedTotalMinor: body.expectedTotalMinor,
    }, { auth: false });
    // PaymentSheet on iOS/Android (sandbox: simulated); the order is paid once the API has the signed webhook.
    const paid = r.payment ? await payPayment(r.payment) : { ok: true as const };
    if (!paid.ok && !paid.cancelled) throw new Error(paid.message);
    return { orderNumber: r.order.orderNumber, paid: paid.ok };
  },
};

export const foodsApi: typeof live = live;
