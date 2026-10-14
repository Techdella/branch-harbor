/** Browser-side calls go through the same-origin /api proxy (works on every custom domain). */
import { fallbackText } from './fallback-messages';
export type ApiFailure = { ok: false; status: number; error: { code: string; message: string; fields?: Record<string, string>; details?: Record<string, unknown> } };
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

export async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = (json.error as ApiFailure['error'] | undefined) ?? { code: 'http_error', message: fallbackText('requestFailed', { status: res.status }) };
      return { ok: false, status: res.status, error };
    }
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, error: { code: 'network', message: fallbackText('network') } };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
