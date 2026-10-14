/**
 * Foods (full product) client for the mobile app: KDS by station (kitchen staff), deliveries (drivers),
 * live orders pulse (owner), meal plans and delivery checkout (customer). Live mode calls apps/api;
 * mock mode serves a small in-app sample so every screen works without the API.
 */
import type { Money } from '@bh/shared';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { http } from '@/lib/http';
import { network } from '@/lib/network';

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
    const r = await http<{ order: { id: string; orderNumber: string }; manageToken: string; payment: { id: string; sandbox: boolean } | null }>('POST', `/public/foods/${locationId}/checkout`, {
      channel: 'delivery', deliverySlotId: body.slotId, address: body.address, lines: body.lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifierIds: l.optionIds })),
      contact: { name: body.name, email: body.email, ...(body.phone ? { phone: body.phone } : {}) }, expectedTotalMinor: body.expectedTotalMinor,
    }, { auth: false });
    if (r.payment?.sandbox) await http('POST', `/public/payments/${r.payment.id}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false });
    return { orderNumber: r.order.orderNumber, paid: !!r.payment?.sandbox };
  },
};

/* ───────── mock ───────── */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const m = (amount: number, currency = 'USD') => ({ amount, currency }) as Money;
const mockTickets: KdsTicket[] = [
  { id: 'tk1', orderNumber: 'SEA-BL-1042', firstName: 'Jamie', channel: 'pickup', tableLabel: null, status: 'queued', orderStatus: 'accepted', lines: [{ name: 'Smoked brisket sandwich', quantity: 2, modifiers: ['Fried egg'] }], orderNotes: null, targetAt: inMin(9), overdue: false, overdueMinutes: 0 },
  { id: 'tk2', orderNumber: 'SEA-BL-1043', firstName: 'Ren', channel: 'dine_in', tableLabel: 'Table 3', status: 'in_progress', orderStatus: 'preparing', lines: [{ name: 'Ember chicken bowl', quantity: 1, modifiers: ['Large', 'Chimichurri'] }], orderNotes: 'No onions', targetAt: inMin(-4), overdue: true, overdueMinutes: 4 },
  { id: 'tk3', orderNumber: 'SEA-BL-1044', firstName: 'Ava', channel: 'delivery', tableLabel: null, status: 'queued', orderStatus: 'accepted', lines: [{ name: 'Margherita, wood-fired', quantity: 1, modifiers: ['Thin crust'] }], orderNotes: null, targetAt: inMin(14), overdue: false, overdueMinutes: 0 },
];
const mockDeliveries: DriverDelivery[] = [
  { id: 'd1', organizationId: 'org_maple', status: 'assigned', provider: 'own', location: { id: 'me-bl', name: 'Seattle – Ballard', timeZone: 'America/Los_Angeles', phone: '+1 206 555 0154' }, order: { id: 'o1', orderNumber: 'SEA-BL-1050', status: 'ready', promisedAt: inMin(12), customerName: 'Morgan Lee', customerPhone: '+1 206 555 0199', address: { line1: '2014 NW 63rd St', city: 'Seattle', postalCode: '98107', instructions: 'Side door' }, items: 3 } },
];
const mockSubs: MySubscription[] = [{ id: 's1', planName: 'Weekly prep box — 5 meals', locationName: 'Seattle – Ballard', status: 'active', price: m(6900), upcoming: [0, 1, 2, 3].map((k) => ({ weekStart: inMin(k * 7 * 1440).slice(0, 10), fulfilmentDate: inMin((k * 7 + 2) * 1440).slice(0, 10), cutoffAt: inMin((k * 7 - 1) * 1440), skipped: false, canChange: k > 0 })) }];
const guard = () => { if (!network.isOnline()) throw new ApiError(0, 'network_error', 'You’re offline.'); };

const mock: typeof live = {
  kds: async (_loc, stationId) => { guard(); await sleep(250); return { location: { id: 'me-bl', name: 'Seattle – Ballard', timeZone: 'America/Los_Angeles' }, refreshedAt: new Date().toISOString(), audibleDefault: true, view: stationId ? 'station' : 'expo', stations: [{ id: 'grill', key: 'grill', name: 'Grill', isExpo: false, open: mockTickets.filter((t) => t.status !== 'done').length }, { id: 'cold', key: 'cold', name: 'Cold', isExpo: false, open: 0 }, { id: 'bar', key: 'bar', name: 'Bar', isExpo: false, open: 0 }], tickets: stationId === 'grill' ? mockTickets : [], orders: stationId ? [] : mockTickets.map((t) => ({ id: t.id, orderNumber: t.orderNumber, firstName: t.firstName, channel: t.channel, status: t.orderStatus, promisedAt: t.targetAt, overdue: t.overdue, overdueMinutes: t.overdueMinutes, allStationsDone: t.status === 'done', lines: t.lines, stations: [{ name: 'Grill', status: t.status }] })) }; },
  ticket: async (_loc, id, action, expected) => { guard(); await sleep(350); const t = mockTickets.find((x) => x.id === id)!; if (expected && expected !== t.status) throw new ApiError(409, 'stale_status', `Ticket is now ${t.status}. Refresh and try again.`); t.status = action === 'recall' ? 'in_progress' : action === 'start' ? 'in_progress' : 'done'; if (t.orderStatus === 'accepted') t.orderStatus = 'preparing'; return { orderStatus: t.orderStatus, allStationsDone: t.status === 'done' }; },
  advanceOrder: async (_loc, id, to) => { guard(); await sleep(300); const t = mockTickets.find((x) => x.id === id); if (t) t.orderStatus = to; return {}; },
  myDeliveries: async () => { guard(); await sleep(250); return structuredClone(mockDeliveries); },
  setDeliveryStatus: async (id, status) => { guard(); await sleep(350); const d = mockDeliveries.find((x) => x.id === id)!; d.status = status; d.order.status = status === 'picked_up' ? 'out_for_delivery' : status === 'delivered' ? 'delivered' : d.order.status; },
  pulse: async (): Promise<FoodsPulse> => { guard(); await sleep(250); return { refreshedAt: new Date().toISOString(), orgs: [{ orgId: 'org_maple', name: 'Maple & Ember', locations: [
    { locationId: 'bl', name: 'Seattle – Ballard', timeZone: 'America/Los_Angeles', orders: { awaiting_acceptance: 1, accepted: 2, preparing: 3, ready: 1, out_for_delivery: 1 }, overdue: 1, byChannel: { pickup: 4, delivery: 2, dine_in: 2 } as Record<string, number>, soldOut: [], lowStock: [{ name: 'Lemons' }], catering: { new: 1, depositPaid: 1 }, deliveries: { active: 2, ordersAwaitingDispatch: 1 } },
    { locationId: 'bo', name: 'London – Borough', timeZone: 'Europe/London', orders: { awaiting_acceptance: 1, accepted: 1, preparing: 0, ready: 0, out_for_delivery: 0 }, overdue: 0, byChannel: { dine_in: 2 } as Record<string, number>, soldOut: [{ name: 'Charred veg grain bowl' }], lowStock: [], catering: { new: 0, depositPaid: 0 }, deliveries: { active: 0, ordersAwaitingDispatch: 0 } },
  ] }] }; },
  mySubscriptions: async () => { guard(); await sleep(250); return structuredClone(mockSubs); },
  skipWeek: async (id, week, skip) => { guard(); await sleep(300); const s = mockSubs.find((x) => x.id === id)!; const w = s.upcoming.find((u) => u.weekStart === week)!; if (!w.canChange) throw new ApiError(409, 'skip_cutoff_passed', 'Changes for that week have closed.'); w.skipped = skip; return structuredClone(s); },
  deliverySlots: async () => { guard(); await sleep(200); return [45, 75, 105, 135].map((k, i) => ({ id: `ds${i}`, startsAt: inMin(k), remaining: 3 - (i % 2), available: true })); },
  deliveryQuote: async (_loc, body) => { guard(); await sleep(300); if (!/^98/.test(body.address.postalCode)) throw new ApiError(409, 'outside_delivery_area', 'We don’t deliver to this address yet. Check the postcode or choose pickup.'); const sub = 2400 * body.lines.reduce((a, l) => a + l.quantity, 0) / 2; return { subtotal: m(sub), deliveryFee: m(399), tax: m(Math.round(sub * 0.1035)), total: m(sub + 399 + Math.round(sub * 0.1035)), zone: { name: 'Ballard & Crown Hill', minimumOrder: m(2000) } }; },
  placeDelivery: async () => { guard(); await sleep(500); return { orderNumber: 'SEA-BL-1061', paid: true }; },
};

export const foodsApi: typeof live = env.useMocks ? mock : live;
