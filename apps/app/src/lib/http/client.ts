/**
 * Low-level HTTP client for the BranchHarbor API (`NEXT_PUBLIC_API_URL`, routes under /v1).
 *
 * Auth model (matches apps/api):
 *  - Short-lived access token (JWT) sent as `Authorization: Bearer`. Kept in localStorage so tabs share it.
 *  - Rotating refresh token in the httpOnly `bh_refresh` cookie (path /v1/auth on the API origin), sent with
 *    `credentials: 'include'`.
 *  - On a 401 the client refreshes once and retries. Refreshes are single-flight within a tab and serialised
 *    across tabs with the Web Locks API, because the API revokes the whole token family when a rotated refresh
 *    token is presented twice (parallel refreshes would otherwise sign the user out).
 *  - A non-secret marker cookie `bh_session` on the app origin lets `src/proxy.ts` redirect signed-out visitors
 *    to /sign-in before rendering. It is a UX hint only; the API enforces every permission.
 */
import { ApiError } from '../errors';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export const SESSION_COOKIE = 'bh_session';
const TOKEN_KEY = 'bh_token';
const TOKEN_EXP_KEY = 'bh_token_exp';
const REFRESH_DAYS = 30;

/* ---------------- token storage ---------------- */

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getAccessToken(): string | null {
  try {
    return store()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function tokenExpiresAt(): number {
  try {
    return Number(store()?.getItem(TOKEN_EXP_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function setMarker(on: boolean) {
  if (typeof document === 'undefined') return;
  document.cookie = on
    ? `${SESSION_COOKIE}=1; path=/; max-age=${REFRESH_DAYS * 86400}; samesite=lax`
    : `${SESSION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Stores (or clears) the access token. `expiresIn` is in seconds. */
export function setAccessToken(token: string | null, expiresIn?: number) {
  try {
    const s = store();
    if (token) {
      s?.setItem(TOKEN_KEY, token);
      // Refresh 30 s early so requests don't race the expiry.
      if (expiresIn) s?.setItem(TOKEN_EXP_KEY, String(Date.now() + Math.max(0, expiresIn - 30) * 1000));
      else s?.removeItem(TOKEN_EXP_KEY);
    } else {
      s?.removeItem(TOKEN_KEY);
      s?.removeItem(TOKEN_EXP_KEY);
    }
  } catch {
    /* storage unavailable: token lives for this request only */
  }
  setMarker(!!token);
}

/* ---------------- auth-lost handling ---------------- */

type AuthLostHandler = () => void;
let onAuthLost: AuthLostHandler = () => {
  if (typeof window === 'undefined') return;
  const here = window.location.pathname + window.location.search;
  if (/^\/(sign-in|sign-up|verify-email|forgot-password)/.test(window.location.pathname)) return;
  window.location.assign(`/sign-in?next=${encodeURIComponent(here)}`);
};
export function setAuthLostHandler(fn: AuthLostHandler) {
  onAuthLost = fn;
}

/* ---------------- low-level fetch ---------------- */

export type Query = Record<string, string | number | boolean | undefined | null>;
interface ErrorBody {
  error?: { code?: string; message?: string; fields?: Record<string, string>; details?: Record<string, unknown> };
}

async function rawFetch(method: string, path: string, opts: { query?: Query; body?: unknown; token?: string | null; headers?: Record<string, string> }): Promise<Response> {
  const url = new URL(`${API_URL}/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    return await fetch(url, { method, headers, credentials: 'include', body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw new ApiError('network_error', 'The BranchHarbor service could not be reached.');
  }
}

/** Dotted validation paths ("address.city") → the last segment, which is what forms key their errors by. */
function normaliseFields(fields?: Record<string, string>): Record<string, string> | undefined {
  if (!fields) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v;
    const last = k.split('.').pop();
    if (last && !(last in out)) out[last] = v;
  }
  return out;
}

async function toError(res: Response): Promise<ApiError> {
  const json = (await res.json().catch(() => null)) as ErrorBody | null;
  const e = json?.error;
  const code = e?.code ?? (res.status === 403 ? 'forbidden' : res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : 'http_error');
  return new ApiError(code, e?.message ?? (res.statusText || 'Request failed'), res.status, normaliseFields(e?.fields), e?.details && typeof e.details === 'object' ? e.details : undefined);
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ---------------- refresh (single-flight, cross-tab) ---------------- */

interface SessionResponse {
  user: { id: string; email: string; name: string; locale: string; emailVerified: boolean };
  accessToken: string;
  accessTokenExpiresIn: number;
  devVerificationToken?: string;
}

let inflight: Promise<string | null> | null = null;

async function doRefresh(staleToken: string | null): Promise<string | null> {
  // Another tab may already have rotated the refresh token while we waited for the lock.
  const current = getAccessToken();
  if (current && current !== staleToken && tokenExpiresAt() > Date.now()) return current;
  const res = await rawFetch('POST', '/auth/refresh', { body: {} });
  if (!res.ok) {
    if (res.status === 401 || res.status === 400) {
      setAccessToken(null);
      return null;
    }
    throw await toError(res);
  }
  const s = await parse<SessionResponse>(res);
  setAccessToken(s.accessToken, s.accessTokenExpiresIn);
  return s.accessToken;
}

/** Gets a fresh access token from the refresh cookie. Resolves to null when the session is gone. */
export function refreshAccessToken(staleToken: string | null = getAccessToken()): Promise<string | null> {
  if (inflight) return inflight;
  const run = async () => {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (locks?.request) return locks.request('bh-auth-refresh', () => doRefresh(staleToken));
    return doRefresh(staleToken);
  };
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

/* ---------------- request ---------------- */

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Send the bearer token and refresh on 401 (default true). */
  auth?: boolean;
  /** Redirect to sign-in when the session can't be refreshed (default true). */
  redirectOnAuthLoss?: boolean;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth !== false;
  let token = auth ? getAccessToken() : null;
  const lost = () => {
    setAccessToken(null);
    if (opts.redirectOnAuthLoss !== false) onAuthLost();
    return new ApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  };
  if (auth && (!token || (tokenExpiresAt() && tokenExpiresAt() < Date.now()))) {
    token = await refreshAccessToken(token);
    if (!token) throw lost();
  }
  let res = await rawFetch(method, path, { query: opts.query, body: opts.body, token });
  if (res.status === 401 && auth) {
    const fresh = await refreshAccessToken(token);
    if (fresh) res = await rawFetch(method, path, { query: opts.query, body: opts.body, token: fresh });
    if (!fresh || res.status === 401) throw lost();
  }
  if (!res.ok) throw await toError(res);
  return parse<T>(res);
}

export const http = {
  get: <T>(path: string, query?: Query, opts: Omit<RequestOptions, 'query' | 'body'> = {}) => request<T>('GET', path, { ...opts, query }),
  post: <T>(path: string, body: unknown = {}, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('PATCH', path, { ...opts, body }),
  del: <T>(path: string, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('DELETE', path, opts),
};

/* ---------------- auth endpoints ---------------- */

/** Demo site only (`NEXT_PUBLIC_DEMO_MODE`, API `DEMO_MODE`): sign in as a listed demo account. */
export async function demoLogin(email: string): Promise<SessionResponse> {
  const s = await request<SessionResponse>('POST', '/demo/login', { body: { email }, auth: false });
  setAccessToken(s.accessToken, s.accessTokenExpiresIn);
  return s;
}

export async function login(email: string, password: string): Promise<SessionResponse> {
  const s = await request<SessionResponse>('POST', '/auth/login', { body: { email, password }, auth: false });
  setAccessToken(s.accessToken, s.accessTokenExpiresIn);
  return s;
}

export async function signup(input: { name: string; email: string; password: string; locale: string }): Promise<SessionResponse> {
  const s = await request<SessionResponse>('POST', '/auth/signup', { body: { ...input, acceptTerms: true }, auth: false });
  setAccessToken(s.accessToken, s.accessTokenExpiresIn);
  return s;
}

export async function verifyEmail(token: string): Promise<void> {
  const r = await request<{ verified: true; accessToken: string }>('POST', '/auth/verify-email', { body: { token }, auth: false });
  // The new access token carries the verified flag (needed to create an organisation).
  setAccessToken(r.accessToken, 15 * 60);
}

export async function resendVerification(): Promise<{ sent: boolean; devVerificationToken?: string }> {
  return request('POST', '/auth/resend-verification', { body: {}, redirectOnAuthLoss: false });
}

export async function logout(): Promise<void> {
  try {
    await request('POST', '/auth/logout', { body: {}, auth: false });
  } finally {
    setAccessToken(null);
  }
}

/** True when a session marker or token exists (the API decides whether it is still valid). */
export function hasSessionHint(): boolean {
  if (getAccessToken()) return true;
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${SESSION_COOKIE}=1`));
}
