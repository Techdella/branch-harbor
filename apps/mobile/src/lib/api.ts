import { env } from './env';
import { tokenStore } from './storage';
import { network } from './network';
import { mockRequest } from '@/mock/server';
import { ApiError } from './errors';
import type {
  Approval, AppNotification, Booking, Brand, ClassOccurrence, CoverRequest, DataRequest, FoodOrder, FoodOrderStatus,
  KitchenOrder, Location, Me, MenuItem, Message, OrderLineInput, PaymentIntentParams, PickupSlot, Preferences, Pulse,
  RosterEntry, AttendanceStatus, Shift, StaffMessage, StaffSession,
} from './types';

export { ApiError };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (!network.isOnline()) throw new ApiError(0, 'network_error', 'You’re offline.');
  if (env.useMocks) return mockRequest<T>(method, path, body);

  const token = await tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Idempotency for state-changing calls: retries never create duplicates server-side.
        ...(method !== 'GET' ? { 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Can’t reach BranchHarbor. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText, e?.fields);
  }
  return json as T;
}

const q = (params: Record<string, string | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  return s ? `?${s}` : '';
};

/** Typed /v1 endpoints. Paths mirror apps/api; mocks implement the same contract. */
export const api = {
  // auth
  signIn: (email: string, password: string) => request<{ token: string; me: Me }>('POST', '/auth/sign-in', { email, password }),
  guest: () => request<{ token: string; me: Me }>('POST', '/auth/guest'),
  me: () => request<Me>('GET', '/auth/me'),
  signOut: () => request<void>('POST', '/auth/sign-out'),

  // customer
  brands: () => request<Brand[]>('GET', '/brands'),
  locations: (brandId?: string) => request<Location[]>('GET', `/locations${q({ brandId })}`),
  classes: (locationId: string, date: string) => request<ClassOccurrence[]>('GET', `/locations/${locationId}/classes${q({ date })}`),
  occurrence: (id: string) => request<ClassOccurrence>('GET', `/class-occurrences/${id}`),
  holdBooking: (occurrenceId: string) => request<Booking>('POST', '/bookings', { occurrenceId }),
  confirmBooking: (bookingId: string, paymentIntentId?: string) => request<Booking>('POST', `/bookings/${bookingId}/confirm`, { paymentIntentId }),
  joinWaitlist: (occurrenceId: string) => request<Booking>('POST', '/waitlist', { occurrenceId }),
  myBookings: () => request<Booking[]>('GET', '/me/bookings'),
  cancelBooking: (id: string) => request<Booking>('POST', `/bookings/${id}/cancel`),
  menu: (locationId: string) => request<MenuItem[]>('GET', `/locations/${locationId}/menu`),
  pickupSlots: (locationId: string, date: string) => request<PickupSlot[]>('GET', `/locations/${locationId}/pickup-slots${q({ date })}`),
  quoteOrder: (locationId: string, lines: OrderLineInput[]) => request<Pick<FoodOrder, 'lines' | 'subtotal' | 'tax' | 'taxLabel' | 'taxInclusive' | 'total'>>('POST', `/locations/${locationId}/orders/quote`, { lines }),
  placeOrder: (body: { locationId: string; slotId: string; lines: OrderLineInput[]; name: string; phone: string; notes?: string }) =>
    request<FoodOrder>('POST', '/orders', body),
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
