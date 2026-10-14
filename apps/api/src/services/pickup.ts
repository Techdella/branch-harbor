import { and, eq, gt, inArray } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { locations, pickupSettings, pickupSlots, type PickupHours } from '../db/schema/index.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';

export type PickupSettingsRow = typeof pickupSettings.$inferSelect;
type Loc = Pick<typeof locations.$inferSelect, 'id' | 'organizationId' | 'timeZone'>;

export interface PickupConfig {
  hours: PickupHours;
  slotMinutes: number;
  slotCapacity: number;
  prepBufferMinutes: number;
  cutoffMinutes: number;
  horizonDays: number;
  closedDates: string[];
  acceptingOrders: boolean;
}

export const DEFAULT_PICKUP: PickupConfig = {
  hours: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, open: '11:00', close: '21:00' })),
  slotMinutes: 15, slotCapacity: 6, prepBufferMinutes: 20, cutoffMinutes: 20, horizonDays: 2, closedDates: [], acceptingOrders: true,
};

export interface PlannedSlot { startsAt: Date; endsAt: Date; capacity: number; cutoffAt: Date }

/**
 * Pure slot planner: pickup windows in local wall time (DST-safe), one slot every `slotMinutes` that fits
 * before closing, nothing earlier than now + preparation buffer, closed dates skipped. Cut-off is
 * `cutoffMinutes` before the slot starts.
 */
export function planPickupSlots(cfg: PickupConfig, timeZone: string, now: Date, days = cfg.horizonDays): PlannedSlot[] {
  const out: PlannedSlot[] = [];
  const earliest = now.getTime() + cfg.prepBufferMinutes * 60_000;
  const today = localDateParts(now, timeZone).date;
  const step = cfg.slotMinutes * 60_000;
  for (let d = 0; d < days; d++) {
    const date = addDays(today, d);
    if (cfg.closedDates.includes(date)) continue;
    const wd = weekdayOf(date);
    for (const w of cfg.hours.filter((h) => h.weekday === wd)) {
      const open = zonedToUtc(date, w.open, timeZone).getTime();
      const close = zonedToUtc(date, w.close, timeZone).getTime();
      for (let t = open; t + step <= close; t += step) {
        if (t < earliest) continue;
        out.push({ startsAt: new Date(t), endsAt: new Date(t + step), capacity: cfg.slotCapacity, cutoffAt: new Date(t - cfg.cutoffMinutes * 60_000) });
      }
    }
  }
  return out;
}

/** Without saved settings, slots are whatever was generated manually; no extra preparation buffer applies. */
export function configOf(row: PickupSettingsRow | null | undefined): PickupConfig {
  if (!row) return { ...DEFAULT_PICKUP, prepBufferMinutes: 0 };
  return { hours: row.hours, slotMinutes: row.slotMinutes, slotCapacity: row.slotCapacity, prepBufferMinutes: row.prepBufferMinutes, cutoffMinutes: row.cutoffMinutes, horizonDays: row.horizonDays, closedDates: row.closedDates, acceptingOrders: row.acceptingOrders };
}

export async function loadPickupSettings(db: Exec, locationId: string) {
  const [row] = await db.select().from(pickupSettings).where(eq(pickupSettings.locationId, locationId));
  return row ?? null;
}

/**
 * Bring future slots in line with the settings: create missing slots, update capacity/cut-off of existing
 * future slots (never below what is already booked), and remove future slots that no longer fit and have
 * no orders. Booked slots are never deleted.
 */
export async function syncPickupSlots(db: Exec, loc: Loc, cfg: PickupConfig, now = new Date()) {
  const plan = cfg.acceptingOrders ? planPickupSlots(cfg, loc.timeZone, now) : [];
  const horizonEnd = zonedToUtc(addDays(localDateParts(now, loc.timeZone).date, cfg.horizonDays), '00:00', loc.timeZone);
  const existing = await db.select().from(pickupSlots).where(and(eq(pickupSlots.locationId, loc.id), gt(pickupSlots.startsAt, now)));
  const byStart = new Map(existing.map((e) => [e.startsAt.getTime(), e]));
  const planned = new Set(plan.map((p) => p.startsAt.getTime()));
  const toInsert = plan.filter((p) => !byStart.has(p.startsAt.getTime()));
  let updated = 0;
  for (const p of plan) {
    const e = byStart.get(p.startsAt.getTime());
    if (!e) continue;
    const capacity = Math.max(p.capacity, e.booked);
    if (e.capacity !== capacity || e.cutoffAt.getTime() !== p.cutoffAt.getTime() || e.endsAt.getTime() !== p.endsAt.getTime()) {
      await db.update(pickupSlots).set({ capacity, cutoffAt: p.cutoffAt, endsAt: p.endsAt }).where(eq(pickupSlots.id, e.id));
      updated++;
    }
  }
  const stale = existing.filter((e) => !planned.has(e.startsAt.getTime()) && e.booked === 0 && e.startsAt < horizonEnd);
  if (stale.length) await db.delete(pickupSlots).where(inArray(pickupSlots.id, stale.map((e) => e.id)));
  const created = toInsert.length
    ? (await db.insert(pickupSlots).values(toInsert.map((p) => ({ organizationId: loc.organizationId, locationId: loc.id, ...p }))).onConflictDoNothing().returning({ id: pickupSlots.id })).length
    : 0;
  return { created, updated, removed: stale.length, planned: plan.length };
}

/** Called before public slot listings: generate the horizon on demand when the location has settings. */
export async function ensurePickupSlots(db: Exec, loc: Loc, now = new Date()) {
  const row = await loadPickupSettings(db, loc.id);
  if (!row || !row.acceptingOrders) return null;
  const cfg = configOf(row);
  const plan = planPickupSlots(cfg, loc.timeZone, now);
  if (!plan.length) return { created: 0 };
  const created = (await db.insert(pickupSlots).values(plan.map((p) => ({ organizationId: loc.organizationId, locationId: loc.id, ...p }))).onConflictDoNothing().returning({ id: pickupSlots.id })).length;
  return { created };
}
