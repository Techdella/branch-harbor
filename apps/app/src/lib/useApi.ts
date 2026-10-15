'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getApi, type BranchHarborApi } from './api';
import { useLocalizeError } from './useErrorText';

export type Resource<T> =
  | { status: 'loading'; data?: T; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: T; error: ApiError };

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.');
}

/**
 * Loads data through the API. Re-runs when `deps` change.
 * Returns the resource plus `reload` and `setData` for optimistic-free local updates
 * after a server-acknowledged mutation.
 */
export function useApi<T>(fn: (api: BranchHarborApi) => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<Resource<T>>({ status: 'loading' });
  const localizeError = useLocalizeError();
  const localize = useRef(localizeError);
  localize.current = localizeError;
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    // Keep showing current data only on an explicit reload; new inputs (scope, industry) never show stale records.
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const api = await getApi();
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

  const setData = useCallback((data: T) => setRes({ status: 'ready', data }), []);
  const reload = useCallback(() => load(true), [load]);
  return { ...res, reload, setData };
}

/** Runs a mutation, tracking pending + error. Resolves to the result or undefined on error. */
export function useMutation<A extends unknown[], R>(fn: (api: BranchHarborApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeError();
  const localizeRef = useRef(localize);
  localizeRef.current = localize;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        const api = await getApi();
        return await fnRef.current(api, ...args);
      } catch (e) {
        setError(localizeRef.current(toApiError(e)));
        return undefined;
      } finally {
        setPending(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return { run, pending, error, clearError: () => setError(null) };
}
