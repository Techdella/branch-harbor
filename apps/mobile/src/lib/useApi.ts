import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './errors';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  refreshing: boolean;
  /** When `data` was last successfully fetched. */
  updatedAt: Date | null;
  /** True when a refresh failed and `data` is from an earlier fetch. */
  stale: boolean;
  refresh: () => Promise<void>;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

/** Minimal fetch hook: keeps the last good data on failure so screens can show a stale banner. */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[], opts: { pollMs?: number } = {}): ApiState<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const run = useCallback(async (mode: 'initial' | 'refresh') => {
    const my = ++seq.current;
    if (mode === 'refresh') setRefreshing(true);
    try {
      const d = await fetcherRef.current();
      if (my !== seq.current) return;
      setDataState(d);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      if (my !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String((e as Error)?.message ?? e)));
    } finally {
      if (my === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void run('initial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!opts.pollMs) return;
    const id = setInterval(() => void run('refresh'), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, run]);

  const refresh = useCallback(() => run('refresh'), [run]);
  const setData = useCallback((fn: (d: T | undefined) => T | undefined) => setDataState(fn), []);

  return { data, error, loading, refreshing, updatedAt, stale: !!error && data !== undefined, refresh, setData };
}
