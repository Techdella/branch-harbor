'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../errors';
import type { Resource } from '../useApi';
import { getSports, type SportsClient } from './client';

const toApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads sports data through the live or sample client. Same states as `useApi` (works with <Async>). */
export function useSports<T>(fn: (c: SportsClient) => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<Resource<T>>({ status: 'loading' });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const data = await fnRef.current(await getSports());
        if (id === seq.current) setRes({ status: 'ready', data });
      } catch (e) {
        if (id === seq.current) setRes({ status: 'error', error: toApiError(e) });
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

/** Runs a sports mutation, tracking pending + error (entered data stays in the form on failure). */
export function useSportsAction<A extends unknown[], R>(fn: (c: SportsClient, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(await getSports(), ...args);
    } catch (e) {
      setError(toApiError(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clear: () => setError(null) };
}
