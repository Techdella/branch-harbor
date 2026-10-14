/**
 * Shared HTTP plumbing for partner clients. Every client takes an injected `fetch` so tests never reach a
 * real service (and production can wrap it, e.g. with mutual TLS for Rightmove).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class PartnerHttpError extends Error {
  constructor(readonly provider: string, readonly status: number, message: string, readonly body: unknown = null) {
    super(message);
  }
}

export async function requestJson<T = Record<string, unknown>>(
  provider: string,
  f: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await f(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new PartnerHttpError(provider, 0, `Could not reach ${provider}: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const d = (data ?? {}) as Record<string, unknown>;
    const msg = String(d.message ?? d.error_description ?? d.error ?? d.Message ?? `HTTP ${res.status}`);
    throw new PartnerHttpError(provider, res.status, `${provider} returned ${res.status}: ${msg}`, data);
  }
  return { status: res.status, data: (data ?? {}) as T };
}

export const hmacHex = (secret: string, payload: string | Buffer) => createHmac('sha256', secret).update(payload).digest('hex');

/** Constant-time comparison of a received hex signature against the expected HMAC-SHA256 of the raw body. */
export function verifyHmacHex(secret: string, raw: Buffer | string, received: string | undefined | null): boolean {
  if (!secret || !received) return false;
  const expected = Buffer.from(hmacHex(secret, raw), 'utf8');
  const got = Buffer.from(received.trim().toLowerCase(), 'utf8');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** "abcd••••wxyz" — enough to recognise which key is stored, never enough to use it. */
export function maskSecret(v: string | undefined | null): string | null {
  if (!v) return null;
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/** Token cache shared by client instances (keyed per credential). Tokens are refreshed 60 s before expiry. */
export class TokenCache {
  private readonly m = new Map<string, { token: string; expiresAt: number }>();
  get(key: string, now: number) {
    const e = this.m.get(key);
    return e && e.expiresAt - 60_000 > now ? e.token : null;
  }
  set(key: string, token: string, expiresAt: number) { this.m.set(key, { token, expiresAt }); }
  clear(key?: string) { if (key) this.m.delete(key); else this.m.clear(); }
}
