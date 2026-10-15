'use client';
/** Wellness data layer (full product): `/v1/orgs/:orgId/wellness/...` (see apps/api/README.md). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../errors';
import { http } from '../http/client';
import { orgId } from '../http/workspace';
import type { Location } from '../types';
import type {
  BookInput, CalendarDay, CancellationPreview, ClientPackage, ClientProfile, ClientRow, Draft, ImpactItem, MoveResult, PackagePlan, RebookAction, RebookResult,
  ServiceInput, Slot, Voucher, WaitlistEntry, WException, WPractitioner, WReport, WResource, WService, Window, Policy,
} from './types';
import { useLocalizeErrorRef } from '../useErrorText';

export interface WellnessApi {
  readonly mode: 'live';
  services(): Promise<WService[]>;
  createService(input: ServiceInput): Promise<WService>;
  updateService(id: string, patch: Partial<ServiceInput> & { active?: boolean; practitionerIds?: string[]; description?: string | null }): Promise<void>;
  addVariant(serviceId: string, input: { name: string; durationMinutes: number; bufferAfterMinutes?: number | null; prices: { locationId: string; priceMinor: number }[] }): Promise<void>;
  setPrice(variantId: string, locationId: string, priceMinor: number, depositMinor: number | null): Promise<void>;
  practitioners(): Promise<WPractitioner[]>;
  resources(): Promise<WResource[]>;
  saveTemplate(practitionerId: string, locationId: string, availability: Window[]): Promise<void>;
  removeTemplate(practitionerId: string, locationId: string): Promise<void>;
  exceptions(): Promise<WException[]>;
  createException(input: { practitionerId: string; locationId?: string | null; startsAt: string; endsAt: string; kind: string; reason?: string }): Promise<{ exceptionId: string; impact: ImpactItem[] }>;
  impact(exceptionId: string): Promise<ImpactItem[]>;
  rebook(exceptionId: string, actions: RebookAction[]): Promise<RebookResult>;
  withdrawException(exceptionId: string): Promise<void>;
  calendar(locationId: string, date: string): Promise<CalendarDay>;
  slots(locationId: string, serviceId: string, date: string, variantId?: string, practitionerId?: string): Promise<Slot[]>;
  move(appointmentId: string, input: { startsAt: string; practitionerId?: string; resourceId?: string; dryRun: boolean }): Promise<MoveResult>;
  book(input: BookInput): Promise<{ appointmentId: string }>;
  cancelPreview(appointmentId: string, mode: 'auto' | 'business' | 'no_show'): Promise<CancellationPreview>;
  cancel(appointmentId: string, input: { byBusiness: boolean; waiveFee: boolean; reason?: string }): Promise<CancellationPreview>;
  checkIn(appointmentId: string): Promise<void>;
  complete(appointmentId: string): Promise<void>;
  noShow(appointmentId: string, waiveFee: boolean): Promise<CancellationPreview>;
  applyVoucher(appointmentId: string, code: string): Promise<{ applied: { amount: number; currency: string }; balance: { amount: number; currency: string } }>;
  clients(q: string): Promise<ClientRow[]>;
  client(id: string): Promise<ClientProfile>;
  savePreferences(id: string, prefs: { preferredPractitionerIds: string[]; preferredChannel: 'email' | 'sms'; comfort: string[]; preferredLocationId?: string | null }): Promise<void>;
  addNote(id: string, input: { locationId: string; body: string; confidential: boolean }): Promise<void>;
  plans(): Promise<PackagePlan[]>;
  createPlan(input: { locationId: string | null; name: string; serviceId: string; sessions: number; priceMinor: number; currency: string; validityDays: number; sharing: 'personal' | 'shareable'; maxSharedWith: number }): Promise<void>;
  clientPackages(): Promise<ClientPackage[]>;
  sellPackage(input: { planId: string; locationId: string; customerId: string }): Promise<void>;
  vouchers(): Promise<Voucher[]>;
  voucher(id: string): Promise<Voucher>;
  issueVoucher(input: { locationId: string; amountMinor: number; recipientName?: string; validityDays: number }): Promise<Voucher>;
  waitlist(): Promise<WaitlistEntry[]>;
  report(from: string, to: string, locationId?: string): Promise<WReport>;
  draftServiceCopy(serviceId: string, tone: 'calm' | 'friendly' | 'concise'): Promise<Draft>;
  draftPolicyReply(locationId: string, enquiry: string, serviceId?: string): Promise<Draft>;
  draftSummary(from: string, to: string, locationId?: string): Promise<Draft>;
  decideDraft(id: string, decision: 'apply' | 'discard', editedText?: string): Promise<void>;
  runReminders(): Promise<Record<string, unknown>>;
}

const o = (p: string) => `/orgs/${orgId()}/wellness${p}`;
const items = <T,>(r: { items: T[] }) => r.items;

export const liveWellness: WellnessApi = {
  mode: 'live',
  services: () => http.get<{ items: (WService & { policy: Policy })[] }>(o('/services')).then(items),
  createService: (input) => http.post<WService>(o('/services'), input),
  updateService: async (id, patch) => { await http.patch(o(`/services/${id}`), patch); },
  addVariant: async (serviceId, input) => { await http.post(o(`/services/${serviceId}/variants`), input); },
  setPrice: async (variantId, locationId, priceMinor, depositMinor) => { await http.put(o(`/variants/${variantId}/prices/${locationId}`), { priceMinor, depositMinor }); },
  practitioners: () => http.get<{ items: WPractitioner[] }>(o('/practitioners')).then(items),
  resources: () => http.get<{ items: WResource[] }>(o('/resources')).then(items),
  saveTemplate: async (pid, lid, availability) => { await http.put(o(`/practitioners/${pid}/templates/${lid}`), { availability }); },
  removeTemplate: async (pid, lid) => { await http.del(o(`/practitioners/${pid}/templates/${lid}`)); },
  exceptions: () => http.get<{ items: WException[] }>(o('/exceptions')).then(items),
  createException: async (input) => {
    const r = await http.post<{ exception: { id: string }; impact: ImpactItem[] }>(o('/exceptions'), input);
    return { exceptionId: r.exception.id, impact: r.impact };
  },
  impact: (id) => http.get<{ impact: ImpactItem[] }>(o(`/exceptions/${id}/impact`)).then((r) => r.impact),
  rebook: (id, actions) => http.post<RebookResult>(o(`/exceptions/${id}/rebook`), { actions }),
  withdrawException: async (id) => { await http.post(o(`/exceptions/${id}/withdraw`), {}); },
  calendar: (locationId, date) => http.get<CalendarDay>(o('/calendar'), { locationId, date }),
  slots: (locationId, serviceId, date, variantId, practitionerId) => http.get<{ slots: Slot[] }>(`/public/wellness/${locationId}/availability`, { serviceId, date, variantId, practitionerId }, { auth: false }).then((r) => r.slots),
  move: async (id, input) => {
    try {
      const r = await http.post<{ ok: boolean; conflicts?: MoveResult['conflicts']; error?: MoveResult['error'] }>(o(`/appointments/${id}/move`), input);
      return { ok: r.ok, conflicts: r.conflicts ?? [], error: r.error ?? null };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return { ok: false, conflicts: [], error: { code: e.code, message: e.message } };
      throw e;
    }
  },
  book: async (input) => ({ appointmentId: (await http.post<{ appointment: { id: string } }>(o('/appointments'), input)).appointment.id }),
  cancelPreview: (id, mode) => http.get<CancellationPreview>(o(`/appointments/${id}/cancellation-preview`), { mode }),
  cancel: async (id, input) => (await http.post<{ cancellation: CancellationPreview }>(o(`/appointments/${id}/cancel`), input)).cancellation,
  checkIn: async (id) => { await http.post(o(`/appointments/${id}/check-in`), {}); },
  complete: async (id) => { await http.post(o(`/appointments/${id}/complete`), {}); },
  noShow: async (id, waiveFee) => (await http.post<{ preview: CancellationPreview }>(o(`/appointments/${id}/no-show`), { waiveFee })).preview,
  applyVoucher: (id, code) => http.post(o(`/appointments/${id}/apply-voucher`), { code }),
  clients: (q) => http.get<{ items: ClientRow[] }>(o('/clients'), { q: q || undefined }).then(items),
  client: (id) => http.get<ClientProfile>(o(`/clients/${id}`)),
  savePreferences: async (id, prefs) => { await http.put(o(`/clients/${id}/preferences`), prefs); },
  addNote: async (id, input) => { await http.post(o(`/clients/${id}/notes`), input); },
  plans: () => http.get<{ items: PackagePlan[] }>(o('/package-plans')).then(items),
  createPlan: async (input) => { await http.post(o('/package-plans'), input); },
  clientPackages: () => http.get<{ items: ClientPackage[] }>(o('/client-packages')).then(items),
  sellPackage: async (input) => { await http.post(o('/client-packages'), input); },
  vouchers: () => http.get<{ items: Voucher[] }>(o('/vouchers')).then(items),
  voucher: (id) => http.get<Voucher>(o(`/vouchers/${id}`)),
  issueVoucher: (input) => http.post<Voucher>(o('/vouchers'), input),
  waitlist: () => http.get<{ items: WaitlistEntry[] }>(o('/waitlist')).then(items),
  report: (from, to, locationId) => http.get<WReport>(o('/reports'), { from, to, locationId }),
  draftServiceCopy: (serviceId, tone) => http.post<Draft>(o('/ai/service-copy'), { serviceId, tone }),
  draftPolicyReply: (locationId, enquiry, serviceId) => http.post<Draft>(o('/ai/policy-reply'), { locationId, enquiry, serviceId }),
  draftSummary: (from, to, locationId) => http.post<Draft>(o('/ai/appointment-summary'), { from, to, locationId }),
  decideDraft: async (id, decision, editedText) => { await http.post(o(`/ai/drafts/${id}/decision`), { decision, editedText }); },
  runReminders: () => http.post<Record<string, unknown>>(o('/reminders/run'), {}),
};

/** The live Wellness client (`locations` is kept for call-site compatibility). */
export async function getWellnessApi(_locations: Location[]): Promise<WellnessApi> {
  return liveWellness;
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.');
}

export type WRes<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };

/** Like useApi, for the wellness client. */
export function useWellness<T>(locations: Location[], fn: (api: WellnessApi) => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<WRes<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const locRef = useRef(locations);
  locRef.current = locations;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const api = await getWellnessApi(locRef.current);
        const data = await fnRef.current(api);
        if (id === seq.current) setRes({ status: 'ready', data });
      } catch (e) {
        if (id === seq.current) setRes({ status: 'error', error: localize.current(toApiError(e)) });
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

/** Mutation helper: pending + error, resolves to the result or undefined on error. */
export function useWellnessAction(locations: Location[]) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const locRef = useRef(locations);
  locRef.current = locations;
  const run = useCallback(async <R,>(fn: (api: WellnessApi) => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn(await getWellnessApi(locRef.current));
    } catch (e) {
      setError(localize.current(toApiError(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clearError: () => setError(null) };
}
