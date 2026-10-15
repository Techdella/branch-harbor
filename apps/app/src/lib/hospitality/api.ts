'use client';

/**
 * Hospitality data layer — live API only (/v1/orgs/:orgId/hospitality/*, see apps/api/README.md → hospitality).
 * There is no sample-data layer for this vertical: without the API the screens say so instead of inventing data.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Money } from '@bh/shared';
import { ApiError, apiMode } from '../api';
import { http, type Query } from '../http/client';
import { orgId } from '../http/workspace';
import { useLocalizeErrorRef } from '../useErrorText';

export const H = (p: string) => `/orgs/${orgId()}/hospitality${p}`;
export const hospitalityLive = () => apiMode() === 'live';

export interface Property {
  locationId: string; name: string; code: string; city: string; country: string; currency: string; timeZone: string; today: string; publiclyVisible: boolean; paymentsEnabled: boolean; roomCount: number;
  kind: string; description: string | null; amenities: string[]; checkInTime: string; checkOutTime: string; holdMinutes: number; requireInspected: boolean;
  registrationFields: RegistrationField[]; registrationRetentionDays: number; preArrivalDays: number; houseRules: string | null; arrivalInstructions: string | null; outletEnabled: boolean; outletName: string | null;
}
export interface RegistrationField { key: string; label: string; kind: 'text' | 'date' | 'country' | 'document_number'; required: boolean }
export interface Me { operations: 'all' | string[]; operationsWrite: 'all' | string[]; guests: 'all' | string[]; configure: 'all' | string[]; refunds: 'all' | string[]; reports: 'all' | string[] }
export interface PulseRow {
  locationId: string; name: string; currency: string; date: string; roomNightsAvailable: number; roomNightsSold: number; roomRevenue: Money; occupancy: number | null; adr: Money | null; revpar: Money | null;
  arrivals: number; arrivalsCheckedIn: number; departures: number; departuresCheckedOut: number; inHouse: number; dirtyRooms: number; outOfOrder: number; openTasks: number;
}
export interface GridCell { date: string; reservationId: string; reservationRoomId: string; code: string; guestName: string; status: string; arrival: string; departure: string; bedId: string | null; groupName: string | null }
export interface Grid {
  locationId: string; from: string; nights: number; dates: string[]; today: string; currency: string;
  roomTypes: Array<{ id: string; code: string; name: string; kind: string; inventory: Array<{ date: string; total: number; sold: number; available: number }> }>;
  rooms: Array<{ id: string; number: string; floor: string | null; roomTypeId: string; hkStatus: string; beds: Array<{ id: string; label: string }>; cells: GridCell[]; blocks: Array<{ id: string; startDate: string; endDate: string; reason: string }> }>;
  unassigned: Array<{ reservationId: string; reservationRoomId: string; code: string; guestName: string; status: string; arrival: string; departure: string; roomTypeId: string; adults: number; children: number }>;
}
export interface CancellationPolicy { name?: string; nonRefundable: boolean; freeUntilHours: number | null; lateFee: { type: string; percentBps?: number | null; amountMinor?: number | null }; noShowFee: { type: string; percentBps?: number | null; amountMinor?: number | null } }
export interface Reservation {
  id: string; code: string; status: string; source: string; locationId: string; arrival: string; departure: string; nights: number; adults: number; children: number; groupName: string | null; guestName: string;
  guestEmail: string | null; guestPhone: string | null; arrivalTime: string | null; specialRequests: string | null; roomTotal: Money; taxAdded: Money; total: Money; depositRequired: Money; depositPaid: Money;
  holdExpiresAt: string | null; cancellationPolicy: CancellationPolicy; cancellationFee: Money | null; cancelledAt: string | null; checkedInAt: string | null; checkedOutAt: string | null; createdAt: string;
  rooms?: Array<{ roomTypeName: string; roomNumber: string | null }>; locationName?: string;
}
export interface ReservationRoom {
  id: string; roomTypeId: string; roomTypeName: string; roomTypeKind: string; ratePlanId: string; ratePlanName: string; includesBreakfast: boolean; adults: number; children: number;
  nights: Array<{ date: string; amount: Money; source: string }>; taxes: Array<{ name: string; amount: Money; inclusive: boolean }>; roomTotal: Money; taxAdded: Money; total: Money;
  room: { id: string; number: string; hkStatus: string } | null; bed: { id: string; label: string } | null;
}
export interface FolioLine { id: string; kind: string; description: string; serviceDate: string | null; amount: Money; method: string | null; createdAt: string }
export interface Folio { currency: string; lines: FolioLine[]; charges: Money; payments: Money; refunds: Money; balance: Money; stayPosted: boolean; expectedBalance: Money }
export type ReservationFull = Omit<Reservation, 'rooms'> & {
  rooms: ReservationRoom[]; folio: Folio; timeline: Array<{ at: string; by: string | null; action: string; note?: string }>; registration: Record<string, string> | null; registrationFields: RegistrationField[];
  property: { name: string; currency: string; timeZone: string; today: string; checkInTime: string; checkOutTime: string; requireInspected: boolean }; canRefund: boolean;
};
export interface CancelQuote { fee: Money; free: boolean; freeUntil: string | null; reason: string; depositPaid: Money; refund: Money; outstanding: Money; policy: CancellationPolicy }
export interface RateOption {
  ratePlanId: string; code: string; name: string; kind: string; includesBreakfast: boolean; inclusions: string[]; policy: CancellationPolicy; ok: boolean; reason?: string; message?: string;
  total?: Money; deposit?: Money; nights?: Array<{ date: string; amountMinor: number }>; taxes?: Array<{ name: string; amountMinor: number; inclusive: boolean }>;
}
export interface AvailabilityRow { roomTypeId: string; code: string; name: string; kind: string; available: number; unitsNeeded: number; bookable: boolean; maxOccupancy: number; rates: RateOption[] }
export interface RatesGrid {
  locationId: string; currency: string; dates: string[];
  roomTypes: Array<{ id: string; code: string; name: string; kind: string; inventory: Array<{ date: string; total: number; sold: number; available: number }>; plans: Array<{ ratePlanId: string; code: string; name: string; derived: boolean; days: Array<{ date: string; price: Money | null; source: string | null; minStay: number | null; maxStay: number | null; closed: boolean; closedToArrival: boolean; closedToDeparture: boolean }> }> }>;
}
export interface RatePlan { id: string; code: string; name: string; kind: string; derivedFromId: string | null; adjustmentBps: number | null; depositRule: string; depositPercentBps: number | null; cancellationPolicyId: string | null; includesBreakfast: boolean; minStay: number | null; maxStay: number | null; bookableOnline: boolean; active: boolean }
export interface RoomType { id: string; code: string; name: string; kind: string; baseOccupancy: number; maxOccupancy: number; bookableOnline: boolean; active: boolean; roomCount?: number; amenities: string[] }
export interface RateSetup { plans: RatePlan[]; seasons: Array<{ id: string; name: string; startDate: string; endDate: string; minStay: number | null }>; prices: Array<{ ratePlanId: string; roomTypeId: string; seasonId: string | null; amountMinor: number; weekdayAmounts: Record<string, number> }>; policies: Array<{ id: string; name: string } & CancellationPolicy>; taxes: Array<{ id: string; name: string; kind: string; rateBps: number | null; amountMinor: number | null; inclusive: boolean; maxNights: number | null; appliesToChildren: boolean; note: string | null; active: boolean }>; roomTypes: RoomType[] }
export interface Room { id: string; number: string; floor: string | null; roomTypeId: string; hkStatus: string; active: boolean; beds: Array<{ id: string; label: string }> }
export interface HkTask { id: string; roomId: string; roomNumber: string; date: string; kind: string; status: string; priority: number; assignee: { id: string; name: string } | null; notes: string | null }
export interface HkBoard { locationId: string; date: string; rooms: Array<{ id: string; number: string; floor: string | null; roomType: string; hkStatus: string; occupancy: string }>; tasks: HkTask[]; counts: Record<string, number>; staff: Array<{ id: string; name: string }> }
export interface OutletData { name: string; currency: string; items: Array<{ id: string; name: string; category: string; price: Money | null; available: boolean; unavailableReason: string | null }>; inHouse: Array<{ reservationId: string; code: string; guestName: string; roomNumber: string | null }> }
export interface KpiRow { roomNightsAvailable: number; roomNightsSold: number; roomRevenue: Money; occupancy: number | null; adr: Money | null; revpar: Money | null }
export interface Report {
  from: string; to: string; nights: number; definitions: Record<string, string>;
  properties: Array<KpiRow & { locationId: string; name: string; currency: string; beds: { bedNightsAvailable: number; bedNightsSold: number; bedRevenue: Money; occupancy: number | null } | null }>;
  byCurrency: Array<KpiRow & { currency: string }>; combinedRevenue: null;
  pickup: Array<{ date: string; currency: string; bookings: number; roomNights: number; revenue: Money }>;
  cancellations: Array<{ currency: string; cancelled: number; noShows: number; roomNightsLost: number; revenueLost: Money; feesRetained: Money }>;
  generatedAt: string;
}
export interface Channels { mode: 'sandbox'; providers: Array<{ provider: string; name: string }>; exports: Array<{ id: string; locationId: string; provider: string; kind: string; createdAt: string }> }

export const hosp = {
  me: () => http.get<Me>(H('/me')),
  properties: async () => (await http.get<{ items: Property[] }>(H('/properties'))).items,
  saveProperty: (locationId: string, body: Partial<Property>) => http.put<Property>(H(`/properties/${locationId}`), body),
  pulse: async () => (await http.get<{ items: PulseRow[] }>(H('/pulse'))).items,
  grid: (locationId: string, from?: string, nights = 14) => http.get<Grid>(H('/grid'), { locationId, from, nights }),
  reservations: async (q: Query) => (await http.get<{ items: Reservation[] }>(H('/reservations'), q)).items,
  reservation: (id: string) => http.get<ReservationFull>(H(`/reservations/${id}`)),
  createReservation: (body: unknown) => http.post<ReservationFull>(H('/reservations'), body),
  modify: (id: string, body: { arrival: string; departure: string }) => http.post<ReservationFull & { priceDifference: Money }>(H(`/reservations/${id}/modify`), body),
  cancelQuote: (id: string) => http.get<CancelQuote>(H(`/reservations/${id}/cancellation-quote`)),
  cancel: (id: string, body: { reason?: string; waiveFee?: boolean }) => http.post<ReservationFull>(H(`/reservations/${id}/cancel`), body),
  noShow: (id: string, waiveFee = false) => http.post<ReservationFull>(H(`/reservations/${id}/no-show`), { waiveFee }),
  assign: (reservationRoomId: string, roomId: string, bedId?: string | null) => http.post(H(`/reservation-rooms/${reservationRoomId}/assign`), { roomId, bedId: bedId ?? null }),
  checkIn: (id: string, registration?: Record<string, string>) => http.post<ReservationFull>(H(`/reservations/${id}/check-in`), { registration }),
  checkOut: (id: string) => http.post<ReservationFull>(H(`/reservations/${id}/check-out`), {}),
  folio: (id: string, body: { kind: string; description: string; amountMinor: number; method?: string | null }) => http.post<Folio>(H(`/reservations/${id}/folio`), body),
  availability: async (q: { locationId: string; arrival: string; departure: string; adults: number; children: number; rooms: number }) => (await http.get<{ items: AvailabilityRow[] }>(H('/availability'), q)).items,
  rooms: async (locationId: string) => (await http.get<{ items: Room[] }>(H('/rooms'), { locationId })).items,
  roomStatus: (id: string, body: { status: string; reason?: string; until?: string }) => http.post<Room>(H(`/rooms/${id}/status`), body),
  addRoom: (body: { locationId: string; roomTypeId: string; number: string; beds?: number }) => http.post<Room>(H('/rooms'), body),
  roomTypes: async (locationId: string) => (await http.get<{ items: RoomType[] }>(H('/room-types'), { locationId })).items,
  addRoomType: (body: unknown) => http.post<RoomType>(H('/room-types'), body),
  rateSetup: (locationId: string) => http.get<RateSetup>(H('/rate-plans'), { locationId }),
  ratesGrid: (locationId: string, from: string, nights: number) => http.get<RatesGrid>(H('/rates-grid'), { locationId, from, nights }),
  setPrices: (planId: string, prices: unknown[]) => http.put(H(`/rate-plans/${planId}/prices`), { prices }),
  setDaily: (body: unknown) => http.put<{ updated: number }>(H('/daily-rates'), body),
  addTax: (body: unknown) => http.post(H('/taxes'), body),
  updateTax: (id: string, body: unknown) => http.patch(H(`/taxes/${id}`), body),
  housekeeping: (locationId: string, date?: string) => http.get<HkBoard>(H('/housekeeping'), { locationId, date }),
  updateTask: (id: string, body: { status?: string; assigneeUserId?: string | null }) => http.patch<HkTask>(H(`/housekeeping/tasks/${id}`), body),
  addTask: (body: unknown) => http.post<HkTask>(H('/housekeeping/tasks'), body),
  outlet: (locationId: string) => http.get<OutletData>(H(`/outlet/${locationId}`)),
  chargeToRoom: (locationId: string, body: unknown) => http.post<{ order: { orderNumber: string; total: Money } }>(H(`/outlet/${locationId}/room-charges`), body),
  report: (q: { from: string; to: string; locationId?: string }) => http.get<Report>(H('/reports'), q),
  channels: () => http.get<Channels>(H('/channels')),
  channelPreview: (provider: string, body: { locationId: string; from: string; nights: number; record: boolean }) => http.post<{ mode: string; sent: boolean; days: number; payload: unknown }>(H(`/channels/${provider}/preview`), body),
};

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads hospitality data: loading / ready / error, reload, setData. */
export function useHosp<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const data = await fnRef.current();
        if (id === seq.current) setRes({ status: 'ready', data });
      } catch (e) {
        if (id === seq.current) setRes({ status: 'error', error: localize.current(asErr(e)) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => load(), [load]);
  return { ...res, reload: useCallback(() => load(true), [load]), setData: useCallback((data: T) => setRes({ status: 'ready', data }), []) };
}

/** Runs a server action and keeps its localized error. Returns undefined on failure. */
export function useHospAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(localize.current(asErr(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, [localize]);
  return { run, pending, error, clear: useCallback(() => setError(null), []) };
}
