import type { AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';
import { ToolError } from '../types.ts';

export interface LocationLite { id: string; name: string; code: string | null; currency: string; status: string; country: string; timeZone: string; regionId: string | null; ownerGroupId: string | null }

/** Locations the person can see (the same list the app shows). */
export async function visibleLocations(ctx: AssistantContext): Promise<LocationLite[]> {
  const r = await ctx.api.get(ctx.o('/locations'));
  return itemsOf<LocationLite>(r).map((l) => ({ id: l.id, name: l.name, code: l.code, currency: l.currency, status: l.status, country: l.country, timeZone: l.timeZone, regionId: l.regionId, ownerGroupId: l.ownerGroupId }));
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Resolves a location id, code or (part of a) name among the locations the person can see. */
export async function resolveLocation(ctx: AssistantContext, ref: string | null | undefined): Promise<LocationLite | null> {
  if (!ref?.trim()) return null;
  const locs = await visibleLocations(ctx);
  const r = ref.trim();
  const byId = locs.find((l) => l.id === r);
  if (byId) return byId;
  const n = norm(r);
  const exact = locs.find((l) => norm(l.name) === n || (l.code && norm(l.code) === n));
  if (exact) return exact;
  const partial = locs.filter((l) => norm(l.name).includes(n) || n.includes(norm(l.name)) || n.split(' ').some((w) => w.length > 3 && norm(l.name).includes(w)));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new ToolError('ambiguous', `Several locations match "${ref}": ${partial.slice(0, 6).map((l) => l.name).join(', ')}. Which one?`);
  throw new ToolError('not_found', `No location matching "${ref}" is in your access.`, 404);
}

export const isoDay = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : null);

/** Counts by a key, e.g. statuses. */
export function countBy<T>(items: T[], key: (t: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it) ?? 'none';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
