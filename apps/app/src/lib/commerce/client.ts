'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiMode, enterFallback } from '../api';
import { ApiError } from '../errors';
import { http, type Query } from '../http/client';
import { orgId } from '../http/workspace';
import { useLocalizeErrorRef } from '../useErrorText';

/**
 * Commerce data access. Live: `/v1/orgs/:orgId/commerce/*` (and a few shared routes). Sample mode: an in-memory
 * router with the same paths and shapes (src/lib/commerce/mock.ts). A network failure in live mode switches to the
 * sample data and the shell shows the "Offline · sample data" banner.
 */
type Method = 'GET' | 'POST' | 'PUT';

async function mock<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
  const { mockCommerce } = await import('./mock');
  return mockCommerce(method, path, body, query) as Promise<T>;
}

export async function cx<T>(method: Method, path: string, body?: unknown, query?: Query): Promise<T> {
  if (apiMode() !== 'live') return mock<T>(method, path, body, query);
  const full = path.startsWith('/~') ? path.slice(2) : `/orgs/${orgId()}/commerce${path}`;
  try {
    if (method === 'GET') return await http.get<T>(full, query);
    if (method === 'PUT') return await http.put<T>(full, body ?? {});
    return await http.post<T>(full, body ?? {});
  } catch (e) {
    if (e instanceof ApiError && e.isNetwork) {
      enterFallback();
      return mock<T>(method, path, body, query);
    }
    throw e;
  }
}

/** Shared org routes (approvals, connections) are addressed with `/~/orgs/:orgId/...`. */
export const orgPath = (p: string) => `/~/orgs/${apiMode() === 'live' ? orgId() : 'org_fieldnote'}${p}`;

export type CState<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };

const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Load commerce data; re-runs when deps change. `reload` keeps current data visible. */
export function useCommerce<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<CState<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    fnRef.current().then((data) => { if (id === seq.current) setRes({ status: 'ready', data }); }, (e) => { if (id === seq.current) setRes({ status: 'error', error: localize.current(toErr(e)) }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { if (enabled) load(); }, [load, enabled]);
  return { ...res, reload: useCallback(() => load(true), [load]), setData: useCallback((data: T) => setRes({ status: 'ready', data }), []) };
}

/** Run a mutation with pending + error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const ref = useRef(fn);
  ref.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try { return await ref.current(...args); } catch (e) { setError(localize.current(toErr(e))); return undefined; } finally { setPending(false); }
  }, []);
  return { run, pending, error, clear: () => setError(null) };
}
