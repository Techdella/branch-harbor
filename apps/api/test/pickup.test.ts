import { describe, expect, it } from 'vitest';
import { DEFAULT_PICKUP, planPickupSlots, type PickupConfig } from '../src/services/pickup.ts';

const cfg = (over: Partial<PickupConfig> = {}): PickupConfig => ({ ...DEFAULT_PICKUP, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '11:00', close: '12:00' })), slotMinutes: 30, slotCapacity: 4, prepBufferMinutes: 20, cutoffMinutes: 15, horizonDays: 2, closedDates: [], ...over });

describe('pickup slot planner (pure)', () => {
  it('generates local-time slots across the DST change, honours the prep buffer and cut-off', () => {
    // Sat 31 Oct 2026 10:50 PDT; DST ends Sun 1 Nov in Los Angeles.
    const now = new Date('2026-10-31T17:50:00Z');
    const slots = planPickupSlots(cfg(), 'America/Los_Angeles', now);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      // 11:00 PDT (18:00Z) is inside the 20-minute preparation buffer → skipped.
      '2026-10-31T18:30:00.000Z',
      '2026-11-01T19:00:00.000Z', // 11:00 PST
      '2026-11-01T19:30:00.000Z',
    ]);
    expect(slots[0]!.cutoffAt.toISOString()).toBe('2026-10-31T18:15:00.000Z');
    expect(slots.every((s) => s.capacity === 4 && s.endsAt.getTime() - s.startsAt.getTime() === 30 * 60_000)).toBe(true);
  });

  it('skips closed dates and days without hours, and never runs past closing', () => {
    const now = new Date('2026-10-12T06:00:00Z'); // Mon 12 Oct, 08:00 in Berlin
    const slots = planPickupSlots(cfg({ hours: [{ weekday: 1, open: '11:00', close: '12:10' }, { weekday: 3, open: '11:00', close: '12:00' }], closedDates: ['2026-10-14'], horizonDays: 3 }), 'Europe/Berlin', now);
    // Monday only (Tuesday has no hours, Wednesday is closed); 12:00–12:30 would end after closing.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(['2026-10-12T09:00:00.000Z', '2026-10-12T09:30:00.000Z']);
  });
});
