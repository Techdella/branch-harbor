/**
 * Hospitality data for the mobile app (guest booking/manage, staff housekeeping & arrivals, owner pulse).
 * Live API only: /v1/public/hospitality/*, /v1/me/hospitality/*, /v1/orgs/:orgId/hospitality/*
 * (EXPO_PUBLIC_HOSPITALITY_BRAND, default tidewater-stays). Sample-data builds show a "needs live account" state.
 */
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { GUEST_TOKEN, http } from '@/lib/http';
import { storage, tokenStore } from '@/lib/storage';
import type { PayablePayment } from '@/lib/cardPayment';

export const HOSPITALITY_BRAND = process.env.EXPO_PUBLIC_HOSPITALITY_BRAND || 'tidewater-stays';
export const hospitalityLive = !env.useMocks;

export interface Money { amount: number; currency: string }
export interface HPolicy { nonRefundable: boolean; freeUntilHours: number | null; lateFee: { type: string } }
export interface HProperty { locationId: string; name: string; city: string; currency: string; timeZone: string; today: string; checkInTime: string; checkOutTime: string; photos: Array<{ url: string }>; kind: string }
export interface HRate { ratePlanId: string; name: string; includesBreakfast: boolean; ok: boolean; reason?: string; policy: HPolicy; total?: Money; deposit?: Money }
export interface HRoomType { roomTypeId: string; name: string; kind: string; maxOccupancy: number; available: number; unitsNeeded: number; photos: Array<{ url: string }>; rates: HRate[] }
export interface HReservation { id: string; code: string; status: string; arrival: string; departure: string; nights: number; guestName: string; total: Money; depositPaid: Money; depositRequired: Money; property?: { name: string; city: string; timeZone: string } }
export interface HBooked { reservation: HReservation; manageToken: string; payment: PayablePayment | null }
export interface HManage { reservation: HReservation; property: HProperty; cancellation: { fee: Money; refund: Money; free: boolean } | null; balance: Money; canCancel: boolean }
export interface HTask { id: string; roomNumber: string; kind: string; status: string; roomStatus: string; mine: boolean; locationName: string; notes: string | null }
export interface HArrival { id: string; code: string; guestName: string; status: string; arrival: string; departure: string; rooms?: Array<{ roomTypeName: string; roomNumber: string | null }>; locationName?: string }
export interface HPulse { locationId: string; name: string; currency: string; occupancy: number | null; adr: Money | null; revpar: Money | null; arrivals: number; departures: number; inHouse: number; dirtyRooms: number; roomNightsSold: number; roomNightsAvailable: number }

const liveOnly = () => { if (!hospitalityLive) throw new ApiError(409, 'live_only', 'Hospitality needs the live API.'); };
const STAYS_KEY = 'bh.hospitality.stays';
type SavedStay = { id: string; token: string };
async function savedStays(): Promise<SavedStay[]> {
  try { return JSON.parse((await storage.get(STAYS_KEY)) ?? '[]') as SavedStay[]; } catch { return []; }
}
const signedIn = async () => { const t = await tokenStore.get(); return !!t && t !== GUEST_TOKEN; };

let orgIdCache: string | null = null;
async function hospOrgId(): Promise<string> {
  if (orgIdCache) return orgIdCache;
  const r = await http<{ items: Array<{ id: string; industry: string }> } | Array<{ id: string; industry: string }>>('GET', '/orgs');
  const o = (Array.isArray(r) ? r : r.items).find((x) => x.industry === 'hospitality');
  if (!o) throw new ApiError(404, 'no_hospitality_org', 'Your account isn’t part of a hospitality business.');
  orgIdCache = o.id;
  return o.id;
}
const O = async (p: string) => `/orgs/${await hospOrgId()}/hospitality${p}`;

export const hospApi = {
  async properties(): Promise<HProperty[]> {
    liveOnly();
    return (await http<{ properties: HProperty[] }>('GET', `/public/hospitality/${HOSPITALITY_BRAND}`, undefined, { auth: false })).properties;
  },
  async availability(locationId: string, q: { arrival: string; departure: string; adults: number }): Promise<HRoomType[]> {
    liveOnly();
    return (await http<{ items: HRoomType[] }>('GET', `/public/hospitality/properties/${locationId}/availability?arrival=${q.arrival}&departure=${q.departure}&adults=${q.adults}&children=0&rooms=1`, undefined, { auth: false })).items;
  },
  async book(locationId: string, body: { arrival: string; departure: string; roomTypeId: string; ratePlanId: string; adults: number; units: number; dorm: boolean; guest: { name: string; email: string }; consentEmail: boolean; expectedTotalMinor?: number }): Promise<HBooked> {
    liveOnly();
    const rooms = Array.from({ length: body.units }, () => ({ roomTypeId: body.roomTypeId, ratePlanId: body.ratePlanId, adults: body.dorm ? 1 : body.adults, children: 0 }));
    const r = await http<HBooked>('POST', `/public/hospitality/properties/${locationId}/reservations`, { arrival: body.arrival, departure: body.departure, rooms, guest: body.guest, consent: { email: body.consentEmail }, expectedTotalMinor: body.expectedTotalMinor, source: 'mobile' }, { auth: await signedIn() });
    const list = await savedStays();
    await storage.set(STAYS_KEY, JSON.stringify([{ id: r.reservation.id, token: r.manageToken }, ...list].slice(0, 30)));
    return r;
  },
  async manage(id: string, token: string): Promise<HManage> {
    return http<HManage>('GET', `/public/hospitality/reservations/${id}?token=${encodeURIComponent(token)}`, undefined, { auth: false });
  },
  async cancel(id: string, token: string) {
    return http<HManage>('POST', `/public/hospitality/reservations/${id}/cancel`, { token }, { auth: false });
  },
  /** Stays booked on this device (manage tokens) plus, when signed in, stays linked to the account. */
  async myStays(): Promise<Array<HManage & { token: string | null }>> {
    liveOnly();
    const out: Array<HManage & { token: string | null }> = [];
    for (const s of await savedStays()) {
      const m = await hospApi.manage(s.id, s.token).catch(() => null);
      if (m) out.push({ ...m, token: s.token });
    }
    if (await signedIn()) {
      const mine = await http<{ items: HReservation[] }>('GET', '/me/hospitality/reservations').catch(() => ({ items: [] as HReservation[] }));
      for (const r of mine.items) if (!out.some((x) => x.reservation.id === r.id)) out.push({ reservation: r, property: { name: r.property?.name ?? '', city: r.property?.city ?? '', timeZone: r.property?.timeZone ?? 'UTC' } as HProperty, cancellation: null, balance: { amount: 0, currency: r.total.currency }, canCancel: false, token: null });
    }
    return out.sort((a, b) => b.reservation.arrival.localeCompare(a.reservation.arrival));
  },
  async myTasks(): Promise<HTask[]> { liveOnly(); return (await http<{ items: HTask[] }>('GET', await O('/housekeeping/my-tasks'))).items; },
  async setTask(id: string, status: 'in_progress' | 'done') { return http('PATCH', await O(`/housekeeping/tasks/${id}`), { status }); },
  async arrivals(): Promise<HArrival[]> { liveOnly(); return (await http<{ items: HArrival[] }>('GET', await O('/reservations?view=arrivals'))).items; },
  async pulse(): Promise<HPulse[]> { liveOnly(); return (await http<{ items: HPulse[] }>('GET', await O('/pulse'))).items; },
};
