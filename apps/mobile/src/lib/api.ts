import { useEffect, useState } from 'react';
import { env } from './env';
import { network } from './network';
import { mockRequest } from '@/mock/server';
import { ApiError } from './errors';
import { guestContact, liveApi, serverPaymentsSandbox, type GuestContact } from './live';
import type {
  Approval, AppNotification, Booking, Brand, ClassOccurrence, CoverRequest, DataRequest, FoodOrder, FoodOrderStatus,
  KitchenOrder, Location, Me, MenuItem, Message, OrderLineInput, PaymentIntentParams, PickupSlot, Preferences, Pulse,
  RosterEntry, AttendanceStatus, Shift, StaffMessage, StaffSession,
} from './types';

export { ApiError, guestContact, type GuestContact };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Mock-mode transport: the in-process mock (src/mock/server.ts) with the original flat paths. */
export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (!network.isOnline()) throw new ApiError(0, 'network_error', 'You’re offline.');
  return mockRequest<T>(method, path, body);
}

const q = (params: Record<string, string | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  return s ? `?${s}` : '';
};

type PlaceOrderBody = { locationId: string; slotId: string; lines: OrderLineInput[]; name: string; phone: string; email?: string; notes?: string };

/**
 * Mock client (EXPO_PUBLIC_USE_MOCKS=true, the default): unchanged contract served by src/mock/server.ts.
 * The mock ignores fields only the live API needs (guest contact, email, payment confirmation).
 */
const mockApi = {
  // auth
  signIn: (email: string, password: string) => request<{ token: string; me: Me }>('POST', '/auth/sign-in', { email, password }),
  guest: () => request<{ token: string; me: Me }>('POST', '/auth/guest'),
  me: () => request<Me>('GET', '/auth/me'),
  signOut: () => request<void>('POST', '/auth/sign-out'),
  registerPushToken: async (_token: string): Promise<void> => undefined,

  // customer
  brands: () => request<Brand[]>('GET', '/brands'),
  locations: (brandId?: string) => request<Location[]>('GET', `/locations${q({ brandId })}`),
  classes: (locationId: string, date: string) => request<ClassOccurrence[]>('GET', `/locations/${locationId}/classes${q({ date })}`),
  occurrence: (id: string) => request<ClassOccurrence>('GET', `/class-occurrences/${id}`),
  holdBooking: (occurrenceId: string, _contact?: Partial<GuestContact>) => request<Booking>('POST', '/bookings', { occurrenceId }),
  confirmBooking: (bookingId: string, paymentIntentId?: string) => request<Booking>('POST', `/bookings/${bookingId}/confirm`, { paymentIntentId }),
  joinWaitlist: (occurrenceId: string, _contact?: Partial<GuestContact>) => request<Booking>('POST', '/waitlist', { occurrenceId }),
  myBookings: () => request<Booking[]>('GET', '/me/bookings'),
  cancelBooking: (id: string) => request<Booking>('POST', `/bookings/${id}/cancel`),
  menu: (locationId: string) => request<MenuItem[]>('GET', `/locations/${locationId}/menu`),
  pickupSlots: (locationId: string, date: string) => request<PickupSlot[]>('GET', `/locations/${locationId}/pickup-slots${q({ date })}`),
  quoteOrder: (locationId: string, lines: OrderLineInput[]) => request<Pick<FoodOrder, 'lines' | 'subtotal' | 'tax' | 'taxLabel' | 'taxInclusive' | 'total'>>('POST', `/locations/${locationId}/orders/quote`, { lines }),
  placeOrder: ({ email: _email, ...body }: PlaceOrderBody) => request<FoodOrder>('POST', '/orders', body),
  confirmOrderPayment: async (_orderId: string, _paymentIntentId?: string): Promise<void> => undefined,
  order: (id: string) => request<FoodOrder>('GET', `/orders/${id}`),
  myOrders: () => request<FoodOrder[]>('GET', '/me/orders'),
  createPaymentIntent: (body: { kind: 'booking' | 'order'; id: string }) => request<PaymentIntentParams>('POST', '/payments/intents', body),
  messages: (locationId: string) => request<Message[]>('GET', `/me/messages${q({ locationId })}`),
  sendMessage: (locationId: string, body: string) => request<Message>('POST', '/me/messages', { locationId, body }),
  preferences: () => request<Preferences>('GET', '/me/preferences'),
  savePreferences: (p: Preferences) => request<Preferences>('PUT', '/me/preferences', p),
  dataRequest: (kind: 'export' | 'delete') => request<DataRequest>('POST', '/me/data-requests', { kind }),

  // staff
  myShifts: () => request<Shift[]>('GET', '/staff/shifts?range=today'),
  clockIn: (shiftId: string) => request<Shift>('POST', `/staff/shifts/${shiftId}/clock-in`),
  mySessions: () => request<StaffSession[]>('GET', '/staff/sessions?range=today'),
  roster: (sessionId: string) => request<RosterEntry[]>('GET', `/staff/sessions/${sessionId}/roster`),
  markAttendance: (sessionId: string, entryId: string, status: AttendanceStatus) =>
    request<RosterEntry>('PUT', `/staff/sessions/${sessionId}/attendance/${entryId}`, { status }),
  kitchenLocationId: async () => 'me-bl',
  kitchenOrders: (locationId: string) => request<KitchenOrder[]>('GET', `/kitchen/orders${q({ locationId })}`),
  setKitchenStatus: (orderId: string, status: FoodOrderStatus) => request<KitchenOrder>('POST', `/kitchen/orders/${orderId}/status`, { status }),
  staffMessages: () => request<StaffMessage[]>('GET', '/staff/messages'),
  coverRequests: () => request<CoverRequest[]>('GET', '/staff/cover-requests'),
  requestCover: (sessionId: string) => request<CoverRequest>('POST', '/staff/cover-requests', { sessionId }),
  acceptCover: (id: string) => request<CoverRequest>('POST', `/staff/cover-requests/${id}/accept`),

  // owner / HQ
  pulse: () => request<Pulse>('GET', '/hq/pulse'),
  approvals: () => request<Approval[]>('GET', '/approvals'),
  decide: (id: string, decision: 'approved' | 'rejected', reason?: string) => request<Approval>('POST', `/approvals/${id}/decision`, { decision, reason }),
  notifications: () => request<AppNotification[]>('GET', '/notifications'),
};

export type BranchHarborApi = typeof mockApi;

/**
 * Typed client used by every screen. Mock mode serves the in-app mock; live mode maps each call onto
 * the real apps/api routes (src/lib/live.ts — see the endpoint table in apps/mobile/README.md).
 */
export const api: BranchHarborApi = env.useMocks ? mockApi : liveApi;

/** Whether "simulate payment" may be offered: mock/dev builds, or a live API running payments in sandbox mode. */
export function usePaymentsSandbox(): boolean {
  const [sandbox, setSandbox] = useState(false);
  useEffect(() => {
    if (env.useMocks) return;
    let alive = true;
    void serverPaymentsSandbox().then((v) => alive && setSandbox(v));
    return () => {
      alive = false;
    };
  }, []);
  return sandbox;
}
