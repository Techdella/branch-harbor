/**
 * Foods menu helpers: allergen conventions, per-locale text, day-part windows, opening/closing times and
 * the per-location ordering configuration. Allergen and dietary labels are only ever what the business
 * supplied — nothing here infers them.
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import {
  ALLERGEN_LABELS, ALLERGEN_REGIMES, DIETARY_LABELS, defaultAllergenRegime, normalizeAllergen,
  type AllergenRegime, type FoodAllergen,
} from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { foodLocationSettings, foodSoldOutEvents, locations, pickupSettings, type DayPartWindow, type FoodLocationConfig } from '../db/schema/index.ts';
import { validationError } from '../lib/errors.ts';
import { addDays, localDateParts, zonedToUtc } from '../lib/tz.ts';

type Location = typeof locations.$inferSelect;

// ───────── Location ordering configuration ─────────

export const DEFAULT_FOOD_CONFIG: FoodLocationConfig = {
  channels: { pickup: true, delivery: false, dineIn: false, preorder: false, catering: false, mealPlans: false },
  tips: { enabled: false, presetsBps: [1000, 1500, 2000], allowCustom: true, channels: ['pickup', 'delivery', 'dine_in'] },
  serviceCharge: { bps: 0, label: 'Service charge', channels: [] },
  allergenRegime: null,
  delivery: { provider: 'own', hours: [], slotMinutes: 30, slotCapacity: 4, leadMinutes: 45, cutoffMinutes: 30, horizonDays: 2 },
  kds: { audibleDefault: true, defaultPrepMinutes: 12 },
  autoSoldOutOnIngredients: false,
};

export function mergeFoodConfig(stored: Partial<FoodLocationConfig> | null | undefined): FoodLocationConfig {
  const s = stored ?? {};
  return {
    channels: { ...DEFAULT_FOOD_CONFIG.channels, ...(s.channels ?? {}) },
    tips: { ...DEFAULT_FOOD_CONFIG.tips, ...(s.tips ?? {}) },
    serviceCharge: { ...DEFAULT_FOOD_CONFIG.serviceCharge, ...(s.serviceCharge ?? {}) },
    allergenRegime: s.allergenRegime ?? null,
    delivery: { ...DEFAULT_FOOD_CONFIG.delivery, ...(s.delivery ?? {}) },
    kds: { ...DEFAULT_FOOD_CONFIG.kds, ...(s.kds ?? {}) },
    autoSoldOutOnIngredients: s.autoSoldOutOnIngredients ?? false,
  };
}

export async function loadFoodConfig(db: Exec, locationId: string): Promise<FoodLocationConfig> {
  const [row] = await db.select().from(foodLocationSettings).where(eq(foodLocationSettings.locationId, locationId));
  return mergeFoodConfig(row?.config);
}

export function regimeFor(loc: Pick<Location, 'country'>, cfg: Pick<FoodLocationConfig, 'allergenRegime'>): AllergenRegime {
  const r = cfg.allergenRegime;
  return r && r in ALLERGEN_REGIMES ? (r as AllergenRegime) : defaultAllergenRegime(loc.country);
}

// ───────── Allergens & dietary labels (business-supplied) ─────────

/** Validate and normalise allergen keys from the business. Unknown keys are rejected, never guessed. */
export function cleanAllergens(input: string[] | undefined, field = 'allergens'): FoodAllergen[] {
  if (!input) return [];
  const out: FoodAllergen[] = [];
  const bad: string[] = [];
  for (const raw of input) {
    const k = normalizeAllergen(raw);
    if (!k) bad.push(raw);
    else if (!out.includes(k)) out.push(k);
  }
  if (bad.length) throw validationError(`Unknown allergen: ${bad.join(', ')}. Choose from the allergen list.`, { [field]: `Unknown: ${bad.join(', ')}` });
  return out;
}

export function cleanDietary(input: string[] | undefined): string[] {
  if (!input) return [];
  const bad = input.filter((d) => !(DIETARY_LABELS as readonly string[]).includes(d));
  if (bad.length) throw validationError(`Unknown dietary label: ${bad.join(', ')}`, { dietary: `Unknown: ${bad.join(', ')}` });
  return [...new Set(input)];
}

export interface AllergenView {
  regime: AllergenRegime;
  /** declared = the business declared allergens (possibly none); not_provided = no information — never "none". */
  status: 'declared' | 'not_provided';
  items: Array<{ key: string; label: string; inRegime: boolean }>;
}

export function allergenView(raw: string[], declared: boolean, regime: AllergenRegime): AllergenView {
  const keys = raw.map((k) => normalizeAllergen(k) ?? k);
  const list = ALLERGEN_REGIMES[regime] as readonly string[];
  return {
    regime,
    status: declared || keys.length > 0 ? 'declared' : 'not_provided',
    items: [...new Set(keys)].map((k) => ({ key: k, label: ALLERGEN_LABELS[k as FoodAllergen] ?? k, inRegime: list.includes(k) })),
  };
}

// ───────── Per-locale text ─────────

export function localized<T extends { name: string; description?: string | null; translations?: Record<string, { name?: string; description?: string }> | null }>(row: T, lang?: string | null) {
  if (!lang) return { name: row.name, description: row.description ?? null };
  const tr = row.translations ?? {};
  const exact = tr[lang] ?? tr[lang.toLowerCase()];
  const base = tr[lang.split('-')[0]!.toLowerCase()];
  const pick = exact ?? base;
  return { name: pick?.name || row.name, description: pick?.description ?? row.description ?? null };
}

// ───────── Day-parts ─────────

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Is local (weekday, HH:MM) inside any window? Windows ending at or before their start run past midnight. */
export function inWindows(windows: DayPartWindow[], weekday: number, time: string): boolean {
  const t = toMin(time);
  return windows.some((w) => {
    const s = toMin(w.start);
    const e = toMin(w.end);
    if (e > s) return w.weekday === weekday && t >= s && t < e;
    return (w.weekday === weekday && t >= s) || ((w.weekday + 1) % 7 === weekday && t < e);
  });
}

export function windowsSummary(windows: DayPartWindow[]): string {
  const times = [...new Set(windows.map((w) => `${w.start}–${w.end}`))];
  return times.join(', ');
}

// ───────── Opening hours & closing time ─────────

/** Opening hours: the pickup hours when configured (they double as kitchen hours), else none known. */
export async function openingHours(db: Exec, locationId: string) {
  const [row] = await db.select({ hours: pickupSettings.hours }).from(pickupSettings).where(eq(pickupSettings.locationId, locationId));
  return row?.hours ?? null;
}

/** When the current open window closes (UTC). Null when the location is closed now. Unknown hours → end of local day. */
export async function currentClose(db: Exec, loc: Pick<Location, 'id' | 'timeZone'>, now = new Date()): Promise<{ open: boolean; closesAt: Date | null; hoursKnown: boolean }> {
  const hours = await openingHours(db, loc.id);
  const local = localDateParts(now, loc.timeZone);
  if (!hours || !hours.length) return { open: true, closesAt: zonedToUtc(addDays(local.date, 1), '00:00', loc.timeZone), hoursKnown: false };
  const t = toMin(local.time);
  for (const h of hours) {
    const s = toMin(h.open);
    const e = toMin(h.close);
    if (h.weekday === local.weekday && t >= s && (e > s ? t < e : true)) {
      return { open: true, closesAt: e > s ? zonedToUtc(local.date, h.close, loc.timeZone) : zonedToUtc(addDays(local.date, 1), h.close, loc.timeZone), hoursKnown: true };
    }
    if (e <= s && (h.weekday + 1) % 7 === local.weekday && t < e) return { open: true, closesAt: zonedToUtc(local.date, h.close, loc.timeZone), hoursKnown: true };
  }
  return { open: false, closesAt: null, hoursKnown: true };
}

/** "Sold out until close": the end of the current open window, or the end of the local day. */
export async function soldOutUntilClose(db: Exec, loc: Pick<Location, 'id' | 'timeZone'>, now = new Date()): Promise<Date> {
  const c = await currentClose(db, loc, now);
  return c.closesAt ?? zonedToUtc(addDays(localDateParts(now, loc.timeZone).date, 1), '00:00', loc.timeZone);
}

/** Record the start/end of a sold-out period (for the sold-out frequency report). */
export async function recordSoldOut(db: Exec, input: { organizationId: string; locationId: string; menuItemId?: string | null; modifierId?: string | null; soldOut: boolean; until?: Date | null; source: 'manual' | 'ingredient'; by?: string | null }) {
  const match = and(
    eq(foodSoldOutEvents.locationId, input.locationId),
    input.modifierId ? eq(foodSoldOutEvents.modifierId, input.modifierId) : and(isNull(foodSoldOutEvents.modifierId), eq(foodSoldOutEvents.menuItemId, input.menuItemId!)),
    eq(foodSoldOutEvents.source, input.source),
    or(isNull(foodSoldOutEvents.endedAt), gt(foodSoldOutEvents.endedAt, new Date())),
  );
  const open = await db.select().from(foodSoldOutEvents).where(match);
  const now = new Date();
  // Close any open period that already expired (auto-reset at close), so the history stays accurate.
  if (input.soldOut) {
    if (open.length) {
      if (input.until !== undefined) await db.update(foodSoldOutEvents).set({ endedAt: input.until }).where(eq(foodSoldOutEvents.id, open[0]!.id));
      return;
    }
    await db.insert(foodSoldOutEvents).values({ organizationId: input.organizationId, locationId: input.locationId, menuItemId: input.menuItemId ?? null, modifierId: input.modifierId ?? null, source: input.source, startedAt: now, endedAt: input.until ?? null, createdBy: input.by ?? null });
  } else if (open.length) {
    await db.update(foodSoldOutEvents).set({ endedAt: now }).where(match);
  }
}
