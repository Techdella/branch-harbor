import { minorUnitExponent } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';
import { ToolError } from '../types.ts';

export interface LocationLite { id: string; name: string; code: string | null; currency: string; status: string; country: string; timeZone: string; regionId: string | null; ownerGroupId: string | null }

/** Locations the person can see (the same list the app shows). */
export async function visibleLocations(ctx: AssistantContext): Promise<LocationLite[]> {
  const r = await ctx.api.get(ctx.o('/locations'));
  return itemsOf<LocationLite>(r).map((l) => ({ id: l.id, name: l.name, code: l.code, currency: l.currency, status: l.status, country: l.country, timeZone: l.timeZone, regionId: l.regionId, ownerGroupId: l.ownerGroupId }));
}

/** Words people add around a location name ("the Ballard store", "our Toronto studio") that are not part of it. */
const GENERIC_WORDS = new Set(['studio', 'store', 'location', 'branch', 'site', 'restaurant', 'shop', 'unit', 'club', 'gym', 'clinic', 'hotel', 'office', 'local', 'franchise', 'please', 'for', 'the', 'our']);

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
  // Word match: every distinctive word of the reference must be in the name, so "Glow Vancouver" never resolves to
  // "Glow Toronto" for someone who only sees Toronto.
  const words = n.split(' ').filter((w) => w.length > 3 && !GENERIC_WORDS.has(w));
  const partial = locs.filter((l) => norm(l.name).includes(n) || n.includes(norm(l.name)) || (words.length > 0 && words.every((w) => norm(l.name).includes(w))));
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

/** Major units (as people say them: 1500, 12.50) to integer minor units in that currency. */
export const toMinor = (major: number, currency: string) => Math.round(major * 10 ** minorUnitExponent(currency as never));

/** Resolves several location references; 'all' (or an empty list) means every location the person can see. */
export async function resolveLocations(ctx: AssistantContext, refs: string[] | undefined): Promise<LocationLite[]> {
  if (!refs?.length || refs.some((r) => /^(all|every|toutes|todas|alle)$/i.test(r.trim()))) return visibleLocations(ctx);
  const out: LocationLite[] = [];
  for (const r of refs) {
    const l = await resolveLocation(ctx, r);
    if (l && !out.some((x) => x.id === l.id)) out.push(l);
  }
  return out;
}

/** Location id → name for the locations the person can see (to label rows that only carry ids). */
export async function locationNames(ctx: AssistantContext): Promise<Map<string, string>> {
  return new Map((await visibleLocations(ctx)).map((l) => [l.id, l.name]));
}

/** Calls a read route and returns null when it is outside the person's access (403/404), so a tool can fall back. */
export async function ifAllowed<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ToolError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

/** Picks one record by id or by (part of) a label; a clear error when none or several match. */
export function pickOne<T>(items: T[], ref: string, label: (t: T) => string, id: (t: T) => string, what: string): T {
  const r = ref.trim();
  const byId = items.find((x) => id(x) === r);
  if (byId) return byId;
  const n = norm(r);
  const exact = items.filter((x) => norm(label(x)) === n);
  if (exact.length === 1) return exact[0]!;
  const partial = items.filter((x) => norm(label(x)).includes(n) || (n.length > 3 && n.includes(norm(label(x)))));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new ToolError('ambiguous', `Several ${what}s match "${ref}": ${partial.slice(0, 6).map(label).join(', ')}. Which one?`);
  throw new ToolError('not_found', `No ${what} matching "${ref}" is in your access.`, 404);
}

/** Today in the organisation's time zone (YYYY-MM-DD). */
export const orgToday = (ctx: AssistantContext) => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.org.defaultTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** YYYY-MM-DD plus n days. */
export const addDaysYmd = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
