'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../errors';
import type { Resource } from '../useApi';
import { getFoodsApi, type FoodsApi } from './api';
import { useLocalizeErrorRef } from '../useErrorText';

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.');
}

/** Same contract as `useApi`, against the Foods client (live or sample). */
export function useFoods<T>(fn: (api: FoodsApi) => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<Resource<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const data = await fnRef.current(await getFoodsApi());
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
  const setData = useCallback((data: T) => setRes({ status: 'ready', data }), []);
  return { ...res, reload, setData };
}

/** Server-acknowledged mutation: resolves to the result or undefined (the error is kept for display). */
export function useFoodsMutation<A extends unknown[], R>(fn: (api: FoodsApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(await getFoodsApi(), ...args);
    } catch (e) {
      setError(localize.current(toApiError(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clearError: () => setError(null) };
}
