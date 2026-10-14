/**
 * HTTP transport for the live BranchHarbor API (EXPO_PUBLIC_USE_MOCKS=false).
 *
 * - Bearer access token + rotating refresh token, both kept in expo-secure-store (localStorage on web preview).
 * - `X-BH-Client: mobile` on every call so auth endpoints return the refresh token in the body (no cookies).
 * - On a 401 the access token is refreshed once and the request retried; concurrent 401s share one
 *   refresh (single-flight), because reusing a rotated refresh token revokes the whole session family.
 * - Errors are normalised to ApiError from `{ error: { code, message, fields } }`.
 */
import { env } from './env';
import { ApiError } from './errors';
import { network } from './network';
import { storage, tokenStore } from './storage';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Stored instead of an access token while browsing as a guest (public endpoints only). */
export const GUEST_TOKEN = 'guest';
const REFRESH_KEY = 'bh.refresh';

export const refreshStore = {
  get: () => storage.get(REFRESH_KEY),
  set: (t: string) => storage.set(REFRESH_KEY, t),
  clear: () => storage.remove(REFRESH_KEY),
};

/** Called when the session can no longer be refreshed (the user must sign in again). */
let onSessionExpired: (() => void) | null = null;
export const setSessionExpiredHandler = (fn: (() => void) | null) => {
  onSessionExpired = fn;
};

let refreshing: Promise<string | null> | null = null;

/** Rotate the refresh token. Single-flight: parallel callers await the same promise. */
export function refreshAccessToken(): Promise<string | null> {
  refreshing ??= (async () => {
    const refreshToken = await refreshStore.get();
    if (!refreshToken) return null;
    let res: Response;
    try {
      res = await fetch(`${env.apiUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-BH-Client': 'mobile' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Offline: keep the stored session and let the caller surface a network error.
      throw new ApiError(0, 'network_error', 'Can’t reach BranchHarbor. Check your connection.');
    }
    if (!res.ok) {
      await Promise.all([tokenStore.clear(), refreshStore.clear()]);
      onSessionExpired?.();
      return null;
    }
    const json = (await res.json()) as { accessToken: string; refreshToken?: string };
    await tokenStore.set(json.accessToken);
    if (json.refreshToken) await refreshStore.set(json.refreshToken);
    return json.accessToken;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const idempotencyKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function send(method: Method, path: string, body: unknown, token: string | null): Promise<Response> {
  try {
    return await fetch(`${env.apiUrl}/v1${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-BH-Client': 'mobile',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token && token !== GUEST_TOKEN ? { Authorization: `Bearer ${token}` } : {}),
        // Idempotency for state-changing calls: retries never create duplicates server-side.
        ...(method !== 'GET' ? { 'Idempotency-Key': idempotencyKey() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Can’t reach BranchHarbor. Check your connection.');
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText, e?.fields);
  }
  return json as T;
}

/** Live /v1 request. `auth: false` skips the bearer token (public endpoints, login). */
export async function http<T>(method: Method, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  if (!network.isOnline()) throw new ApiError(0, 'network_error', 'You’re offline.');
  const useAuth = opts.auth !== false;
  const token = useAuth ? await tokenStore.get() : null;
  let res = await send(method, path, body, token);
  if (res.status === 401 && useAuth && token && token !== GUEST_TOKEN) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await send(method, path, body, fresh);
  }
  return parse<T>(res);
}
