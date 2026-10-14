'use client';

import type { ApiResult } from './client';

/**
 * Studio customer portal session (magic-link sign-in). Kept in this browser only; the API stores it hashed
 * and it expires after 30 days. Requests go through the same-origin proxy with the session header.
 */
const key = (brand: string) => `bh_studio_session_${brand}`;

export function getSession(brand: string): string | null {
  try { return window.localStorage.getItem(key(brand)); } catch { return null; }
}
export function setSession(brand: string, v: string | null) {
  try { if (v) window.localStorage.setItem(key(brand), v); else window.localStorage.removeItem(key(brand)); } catch { /* storage blocked: session lasts for this page only */ }
}

export async function pcall<T>(brand: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  const session = getSession(brand);
  try {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-bh-customer-session': session } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) setSession(brand, null);
    if (!res.ok) return { ok: false, status: res.status, error: (json.error as { code: string; message: string }) ?? { code: 'http_error', message: `Request failed (${res.status})` } };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, error: { code: 'network', message: 'Network error. Check your connection and try again.' } };
  }
}

export interface Money { amount: number; currency: string }
export interface Account {
  customer: { id: string; name: string; email: string | null };
  memberships: Array<{ id: string; name: string; state: string; classesPerPeriod: number | null; price: (Money & { interval: string | null }) | null; currentPeriodEnd: string | null; cancelAt: string | null; graceUntil: string | null; pausedUntil: string | null; usage: { used: number; limit: number | null } | null }>;
  packs: Array<{ id: string; name: string; creditsTotal: number; creditsRemaining: number; expiresAt: string | null; status: string }>;
  credits: { available: number };
  upcoming: Array<{ id: string; className: string; startsAt: string; location: { id: string; name: string; timeZone: string }; status: string; paymentMethod: string; online: boolean }>;
  history: Array<{ id: string; className: string; startsAt: string; location: { name: string; timeZone: string }; status: string; lateCancel: boolean }>;
  waitlist: Array<{ id: string; className: string; startsAt: string }>;
  fees: Array<{ id: string; kind: string; amount: Money; locationId: string }>;
  preferences: { marketingEmail: boolean | null; marketingSms: boolean | null; classUpdatesEmail: boolean; classUpdatesSms: boolean } | null;
}
