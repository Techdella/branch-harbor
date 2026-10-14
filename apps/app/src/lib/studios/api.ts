'use client';

/**
 * Studios full-product client: the live implementation calls `/v1/orgs/:orgId/studios/...`; sample mode (and the
 * offline fallback) uses `./mock`. Same view models either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiMode, enterFallback } from '../api';
import { http } from '../http/client';
import { orgId } from '../http/workspace';
import type {
  AiAttendance, AiAudience, AiDescription, ClassTypeVM, EditChanges, EditPreview, EditResult, EditScope, Instructor, MemberDetail, MemberRow, MembershipPlan, MembershipVM, NotificationRow,
  OnlineInput, OnlineItem, PackProduct, PackVM, Policies, PolicyVM, Room, Roster, SeriesInput, SeriesPreview, SeriesVM, StudioReport,
} from './types';

export interface StudioApi {
  rooms(locationId?: string): Promise<Room[]>;
  createRoom(input: { locationId: string; name: string; capacity: number; features: string[] }): Promise<Room>;
  updateRoom(id: string, patch: Partial<Pick<Room, 'name' | 'capacity' | 'features' | 'active'>>): Promise<Room>;
  classTypes(): Promise<ClassTypeVM[]>;
  updateClassType(id: string, patch: { description?: string | null }): Promise<ClassTypeVM>;
  instructors(locationId: string): Promise<Instructor[]>;
  series(locationId?: string): Promise<SeriesVM[]>;
  previewSeries(input: SeriesInput): Promise<SeriesPreview>;
  createSeries(input: SeriesInput, opts: { publish: boolean; allowConflicts: boolean }): Promise<{ series: SeriesVM; generated: number }>;
  publishSeries(id: string, allowConflicts: boolean): Promise<{ generated: number }>;
  roster(occurrenceId: string): Promise<Roster>;
  checkIn(bookingId: string, source: 'desk' | 'instructor', undo?: boolean): Promise<void>;
  markNoShow(bookingId: string): Promise<{ fee: { amount: number; currency: string } | null }>;
  closeAttendance(occurrenceId: string): Promise<{ noShows: number; feesRecorded: number }>;
  editPreview(occurrenceId: string, scope: EditScope, changes: EditChanges): Promise<EditPreview>;
  applyEdit(occurrenceId: string, scope: EditScope, changes: EditChanges, opts: { notify: boolean; reason?: string; allowConflicts: boolean; allowOverCapacity: boolean }): Promise<EditResult>;
  notifications(occurrenceId: string): Promise<NotificationRow[]>;
  packProducts(): Promise<PackProduct[]>;
  createPackProduct(input: Omit<PackProduct, 'id' | 'scope' | 'sellableAt' | 'missingCurrencies' | 'active' | 'status'>): Promise<void>;
  updatePackProduct(id: string, patch: { status?: string; prices?: Record<string, number> }): Promise<void>;
  membershipPlans(): Promise<MembershipPlan[]>;
  createMembershipPlan(input: Omit<MembershipPlan, 'id' | 'scope' | 'sellableAt' | 'missingCurrencies' | 'active' | 'status'>): Promise<void>;
  updateMembershipPlan(id: string, patch: { status?: string; prices?: Record<string, number> }): Promise<void>;
  policies(): Promise<Policies>;
  savePolicy(locationId: string | null, p: PolicyVM): Promise<void>;
  members(q: { search?: string; filter: string; locationId?: string; offset: number }): Promise<{ items: MemberRow[]; total: number }>;
  member(id: string): Promise<MemberDetail>;
  pauseMembership(id: string, from: string, until: string): Promise<MembershipVM>;
  resumeMembership(id: string): Promise<MembershipVM>;
  cancelMembership(id: string, immediate: boolean): Promise<MembershipVM>;
  sandboxRenewal(id: string, outcome: 'succeeded' | 'failed'): Promise<void>;
  grantCredits(customerId: string, input: { locationId: string; credits: number; reason: string }): Promise<PackVM>;
  waiveFee(id: string, reason: string): Promise<void>;
  sell(customerId: string, input: { locationId: string; kind: 'pack' | 'membership'; productId: string }): Promise<{ paymentId: string | null; sandbox: boolean; amount: { amount: number; currency: string } }>;
  confirmSandboxPayment(paymentId: string): Promise<void>;
  online(): Promise<OnlineItem[]>;
  createOnline(input: OnlineInput): Promise<OnlineItem>;
  updateOnline(id: string, patch: Partial<OnlineInput>): Promise<OnlineItem>;
  registrations(id: string): Promise<Array<{ customer: string; kind: string; basis: string; joinedAt: string | null }>>;
  reports(locationId: string | undefined, weeks: number): Promise<StudioReport>;
  aiDescription(classTypeId: string, tone: 'warm' | 'energetic' | 'calm'): Promise<AiDescription>;
  aiAttendance(weeks: number, locationId?: string): Promise<AiAttendance>;
  aiAudiences(locationId?: string): Promise<{ proposals: AiAudience[]; notes: string[] }>;
}

const o = (p: string) => `/orgs/${orgId()}/studios${p}`;
const items = <T,>(r: { items: T[] }) => r.items;

const liveApi: StudioApi = {
  rooms: (locationId) => http.get<{ items: Room[] }>(o('/rooms'), { locationId }).then(items),
  createRoom: (input) => http.post<Room>(o('/rooms'), input),
  updateRoom: (id, patch) => http.patch<Room>(o(`/rooms/${id}`), patch),
  classTypes: () => http.get<{ items: ClassTypeVM[] }>(o('/class-types')).then((r) => r.items.filter((x) => !(x as { archivedAt?: string | null }).archivedAt)),
  updateClassType: (id, patch) => http.patch<ClassTypeVM>(o(`/class-types/${id}`), patch),
  instructors: (locationId) => http.get<{ items: Instructor[] }>(o('/instructors'), { locationId }).then(items),
  series: (locationId) => http.get<{ items: SeriesVM[] }>(o('/series'), { locationId }).then(items),
  previewSeries: (input) => http.post<SeriesPreview>(o('/series/preview'), input),
  createSeries: (input, opts) => http.post<{ series: SeriesVM; generated: number }>(o('/series'), { ...input, ...opts }),
  publishSeries: (id, allowConflicts) => http.post<{ generated: number }>(o(`/series/${id}/publish`), { allowConflicts }),
  roster: (id) => http.get<Roster>(o(`/occurrences/${id}/roster`)),
  checkIn: async (bookingId, source, undo) => { await http.post(o(`/bookings/${bookingId}/check-in`), { source, undo: !!undo }); },
  markNoShow: async (bookingId) => {
    const r = await http.post<{ fee: { amount: number; currency: string } | null }>(o(`/bookings/${bookingId}/attendance`), { status: 'no_show' });
    return { fee: r.fee };
  },
  closeAttendance: (id) => http.post(o(`/occurrences/${id}/close-attendance`)),
  editPreview: (id, scope, changes) => http.post<EditPreview>(o(`/occurrences/${id}/edit-preview`), { scope, changes }),
  applyEdit: (id, scope, changes, opts) => http.post<EditResult>(o(`/occurrences/${id}/edit`), { scope, changes, ...opts }),
  notifications: (id) => http.get<{ items: NotificationRow[] }>(o(`/occurrences/${id}/notifications`)).then(items),
  packProducts: () => http.get<{ items: PackProduct[] }>(o('/pack-products')).then(items),
  createPackProduct: async (input) => { await http.post(o('/pack-products'), input); },
  updatePackProduct: async (id, patch) => { await http.patch(o(`/pack-products/${id}`), patch); },
  membershipPlans: () => http.get<{ items: MembershipPlan[] }>(o('/membership-plans')).then(items),
  createMembershipPlan: async (input) => { await http.post(o('/membership-plans'), input); },
  updateMembershipPlan: async (id, patch) => { await http.patch(o(`/membership-plans/${id}`), patch); },
  policies: () => http.get<Policies>(o('/policies')),
  savePolicy: async (locationId, p) => { const { source: _s, ...rest } = p; await http.put(o('/policies'), { ...rest, locationId }); },
  members: (q) => http.get<{ items: MemberRow[]; total: number }>(o('/members'), { q: q.search || undefined, filter: q.filter, locationId: q.locationId, offset: q.offset, limit: 25 }),
  member: (id) => http.get<MemberDetail>(o(`/members/${id}`)),
  pauseMembership: (id, from, until) => http.post<MembershipVM>(o(`/memberships/${id}/pause`), { from, until }),
  resumeMembership: (id) => http.post<MembershipVM>(o(`/memberships/${id}/resume`)),
  cancelMembership: (id, immediate) => http.post<MembershipVM>(o(`/memberships/${id}/cancel`), { immediate }),
  sandboxRenewal: async (id, outcome) => { await http.post(o(`/memberships/${id}/sandbox-renewal`), { outcome }); },
  grantCredits: (customerId, input) => http.post<PackVM>(o(`/members/${customerId}/credits`), input),
  waiveFee: async (id, reason) => { await http.post(o(`/fees/${id}/waive`), { reason }); },
  sell: async (customerId, input) => {
    const r = await http.post<{ purchase: { amount: { amount: number; currency: string } }; payment: { id: string; sandbox: boolean } | null }>(o(`/members/${customerId}/purchases`), input);
    return { paymentId: r.payment?.id ?? null, sandbox: r.payment?.sandbox ?? false, amount: r.purchase.amount };
  },
  confirmSandboxPayment: async (paymentId) => { await http.post(`/public/payments/${paymentId}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false }); },
  online: () => http.get<{ items: OnlineItem[] }>(o('/online')).then(items),
  createOnline: (input) => http.post<OnlineItem>(o('/online'), input),
  updateOnline: (id, patch) => http.patch<OnlineItem>(o(`/online/${id}`), patch),
  registrations: (id) => http.get<{ items: Array<{ customer: string; kind: string; basis: string; joinedAt: string | null }> }>(o(`/online/${id}/registrations`)).then(items),
  reports: (locationId, weeks) => {
    const to = new Date(Date.now() + 7 * 86400_000);
    return http.get<StudioReport>(o('/reports'), { locationId, to: to.toISOString(), from: new Date(to.getTime() - (weeks + 1) * 7 * 86400_000).toISOString() });
  },
  aiDescription: (classTypeId, tone) => http.post<AiDescription>(o('/ai/class-description'), { classTypeId, tone }),
  aiAttendance: (weeks, locationId) => http.get<AiAttendance>(o('/ai/attendance-summary'), { weeks, locationId }),
  aiAudiences: (locationId) => http.post<{ proposals: AiAudience[]; notes: string[] }>(o('/ai/follow-up-audiences'), { locationId }),
};

let mockInstance: StudioApi | null = null;
async function mock(): Promise<StudioApi> {
  if (!mockInstance) mockInstance = (await import('./mock')).studioMockApi;
  return mockInstance;
}

/** Live API with the same offline fallback as the rest of the app. */
export async function getStudioApi(): Promise<StudioApi> {
  if (apiMode() !== 'live') return mock();
  const m = await mock();
  return new Proxy(liveApi, {
    get(target, prop) {
      const fn = Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>;
      // Not an API method (e.g. `then` when the proxy is awaited): behave like a plain object.
      if (typeof fn !== 'function') return fn;
      return async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof ApiError && e.isNetwork) {
            enterFallback();
            return (Reflect.get(m, prop) as (...a: unknown[]) => Promise<unknown>)(...args);
          }
          throw e;
        }
      };
    },
  });
}

export type StudioResource<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

export function useStudio<T>(fn: (api: StudioApi) => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<StudioResource<T>>({ status: 'loading' });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const data = await fnRef.current(await getStudioApi());
        if (id === seq.current) setRes({ status: 'ready', data });
      } catch (e) {
        if (id === seq.current) setRes({ status: 'error', error: toErr(e) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (enabled) load();
  }, [load, enabled]);
  const reload = useCallback(() => load(true), [load]);
  return { ...res, reload };
}

export function useStudioMutation<A extends unknown[], R>(fn: (api: StudioApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(await getStudioApi(), ...args);
    } catch (e) {
      setError(toErr(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clearError: () => setError(null) };
}
