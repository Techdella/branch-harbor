import { cache } from 'react';
import { API_URL } from './config';
import type { BrandSite, LocationSite } from './types';

/** API failure. 404 means "does not exist for the public" — everything else is shown as a friendly error. */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Server-side GET against the BranchHarbor API. There is deliberately no mock fallback: when the API is
 * unreachable customers get an error page, never invented data.
 */
export async function apiGet<T>(path: string, opts: { revalidate?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      headers: { accept: 'application/json' },
      ...(opts.revalidate ? { next: { revalidate: opts.revalidate } } : { cache: 'no-store' as const }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new ApiError(503, 'api_unreachable', `API unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let code = 'api_error';
    let message = `API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

/** Published content changes rarely; a short revalidate keeps sites fast without serving stale availability. */
export const getBrandSite = cache((brand: string) => apiGet<BrandSite>(`/v1/public/sites/${encodeURIComponent(brand)}`, { revalidate: 30 }));
export const getLocationSite = cache((brand: string, location: string) =>
  apiGet<LocationSite>(`/v1/public/sites/${encodeURIComponent(brand)}/${encodeURIComponent(location)}`, { revalidate: 30 }));
