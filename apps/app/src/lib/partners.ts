'use client';

/**
 * Partner integrations (Uber Direct, Deliverect, property portals): /v1/orgs/:orgId/partner-connections and the
 * Deliverect location actions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { http } from './http/client';
import { orgId } from './http/workspace';
import { useLocalizeErrorRef } from './useErrorText';

export type PartnerStatus = 'not_configured' | 'disabled' | 'sandbox' | 'awaiting_portal' | 'live' | 'error';
export interface PartnerField { key: string; label: string; required: boolean; secret?: boolean; help?: string; type?: 'text' | 'select' | 'boolean'; options?: string[] }
export interface PartnerCatalogEntry { provider: string; name: string; kind: 'delivery' | 'pos' | 'portal'; industry: 'foods' | 'realty'; delivery?: 'push' | 'pull'; countries?: string[]; fields: PartnerField[]; approvals: string }
export interface PartnerLocation { id: string; name: string; country: string; currency: string; canManage: boolean; uberDirectAvailable: boolean }
export interface PartnerResult { at: string; action: string; status: string; message: string | null }
export interface PartnerConnection {
  id: string; provider: string; name: string; kind: string; locationId: string; enabled: boolean; mode: 'sandbox' | 'live'; status: PartnerStatus; statusReason: string;
  /** Stable code for `statusReason` (translated via `partners.reason.*`); `missingKeys` are the field keys behind `missing`. */
  statusReasonCode?: string; missingKeys?: string[];
  config: Record<string, unknown>; credentials: Record<string, { set: boolean; masked: string | null }>; missing: string[];
  state: string; lastSuccessAt: string | null; lastError: string | null; lastFetchedAt: string | null; busy: { paused: boolean; until?: string | null } | null;
  feedUrl: string | null; webhookUrl: string | null; canManage?: boolean; lastResult?: PartnerResult | null;
}
/** `code` + `params` (newer APIs) let the panel phrase the outcome in the user's language; `message` is the English line. */
export interface PartnerTestResult { ok: boolean; sandbox: boolean; message: string; code?: string; params?: Record<string, string | number | string[]> }
export interface PartnerOverview { catalog: PartnerCatalogEntry[]; locations: PartnerLocation[]; items: PartnerConnection[] }
export type Settings = Record<string, string | boolean | null>;

export interface PartnersApi {
  overview(industry: 'foods' | 'realty'): Promise<PartnerOverview>;
  create(provider: string, locationId: string, settings: Settings): Promise<PartnerConnection>;
  update(id: string, body: { settings?: Settings; enabled?: boolean; mode?: 'sandbox' | 'live' }): Promise<PartnerConnection>;
  test(id: string): Promise<{ result: PartnerTestResult; connection: PartnerConnection }>;
  rotateFeed(id: string): Promise<PartnerConnection>;
  disconnect(id: string): Promise<PartnerConnection>;
  menuPush(locationId: string): Promise<{ status: string; message: string; products: number; soldOut: number; unmappedAllergens: Array<{ plu: string; allergen: string }> }>;
  busy(locationId: string, paused: boolean, minutes?: number): Promise<{ status: string; message: string; paused: boolean }>;
}

const o = (p: string) => `/orgs/${orgId()}${p}`;
const live: PartnersApi = {
  overview: (industry) => http.get(o('/partner-connections'), { industry }),
  create: (provider, locationId, settings) => http.post(o('/partner-connections'), { provider, locationId, settings }),
  update: (id, body) => http.patch(o(`/partner-connections/${id}`), body),
  test: (id) => http.post(o(`/partner-connections/${id}/test`), {}),
  rotateFeed: (id) => http.post(o(`/partner-connections/${id}/rotate-feed-token`), {}),
  disconnect: (id) => http.del(o(`/partner-connections/${id}`)),
  menuPush: (locationId) => http.post(o(`/foods/locations/${locationId}/deliverect/menu-push`), {}),
  busy: (locationId, paused, minutes) => http.post(o(`/foods/locations/${locationId}/deliverect/busy`), { paused, ...(minutes ? { minutes } : {}) }),
};

async function run<T>(fn: (a: PartnersApi) => Promise<T>): Promise<T> {
  return fn(live);
}

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

export function usePartners<T>(fn: (a: PartnersApi) => Promise<T>, deps: unknown[]) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    run(fnRef.current).then((data) => { if (id === seq.current) setRes({ status: 'ready', data }); }, (e) => { if (id === seq.current) setRes({ status: 'error', error: localize.current(asErr(e)) }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...res, reload: () => load(true) };
}

export function usePartnersMutation<A extends unknown[], R>(fn: (a: PartnersApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const go = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true); setError(null);
    try { return await run((a) => fnRef.current(a, ...args)); } catch (e) { setError(localize.current(asErr(e))); return undefined; } finally { setPending(false); }
  }, []);
  return { run: go, pending, error };
}
