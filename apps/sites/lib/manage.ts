import { apiGet, isNotFound } from './api';

/** Token-gated lookups; an invalid token reads as "not found" (no information leak). */
export async function manageLookup<T>(path: string, token: string | undefined): Promise<T | null> {
  if (!token || token.length < 10) return null;
  try {
    return await apiGet<T>(`${path}?token=${encodeURIComponent(token)}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
