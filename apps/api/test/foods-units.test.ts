import { describe, expect, it } from 'vitest';
import { defaultAllergenRegime, normalizeAllergen } from '@bh/shared';
import { canTransition, nextState } from '../src/domain/foodOrderState.ts';
import { unsupportedClaims } from '../src/services/foods-ai.ts';
import { haversineMeters, normalizePostcode } from '../src/services/foods-delivery.ts';
import { routeLines } from '../src/services/foods-kitchen.ts';
import { cutoffOf, fulfilmentDateOf, mondayOf } from '../src/services/foods-mealplans.ts';
import { allergenView, inWindows, mergeFoodConfig } from '../src/services/foods-menu.ts';

describe('foods domain helpers', () => {
  it('ends a ready order the way its channel is fulfilled', () => {
    expect(canTransition('ready', 'collected', 'pickup')).toBe(true);
    expect(canTransition('ready', 'collected', 'delivery')).toBe(false);
    expect(canTransition('ready', 'out_for_delivery', 'delivery')).toBe(true);
    expect(canTransition('out_for_delivery', 'delivered', 'delivery')).toBe(true);
    expect(canTransition('ready', 'served', 'dine_in')).toBe(true);
    expect(canTransition('ready', 'out_for_delivery', 'dine_in')).toBe(false);
    expect(nextState('ready', 'dine_in')).toBe('served');
    expect(nextState('ready', 'delivery')).toBe('out_for_delivery');
  });

  it('evaluates day-part windows including ones that run past midnight', () => {
    const late = [{ weekday: 5, start: '22:00', end: '02:00' }];
    expect(inWindows(late, 5, '23:30')).toBe(true);
    expect(inWindows(late, 6, '01:15')).toBe(true);
    expect(inWindows(late, 6, '02:00')).toBe(false);
    expect(inWindows([{ weekday: 1, start: '07:00', end: '11:00' }], 1, '11:00')).toBe(false);
  });

  it('matches postcodes as normalised prefixes and measures radius distance', () => {
    expect(normalizePostcode('sw1a 1aa')).toBe('SW1A1AA');
    expect(normalizePostcode('SW1A1AA').startsWith(normalizePostcode('SW1A'))).toBe(true);
    const d = haversineMeters({ lat: 47.6687, lng: -122.3843 }, { lat: 47.651, lng: -122.35 });
    expect(d).toBeGreaterThan(3000);
    expect(d).toBeLessThan(4000);
  });

  it('uses the jurisdiction convention by country and keeps unknown allergens out', () => {
    expect(defaultAllergenRegime('US')).toBe('us9');
    expect(defaultAllergenRegime('PT')).toBe('eu14');
    expect(defaultAllergenRegime('GB')).toBe('eu14');
    expect(defaultAllergenRegime('CA')).toBe('ca');
    expect(normalizeAllergen('Gluten')).toBe('cereals_gluten');
    expect(normalizeAllergen('glitter')).toBeNull();
    const v = allergenView(['milk', 'mustard'], true, 'us9');
    expect(v.items).toEqual([{ key: 'milk', label: 'Milk', inRegime: true }, { key: 'mustard', label: 'Mustard', inRegime: false }]);
    expect(allergenView([], false, 'eu14').status).toBe('not_provided');
  });

  it('computes meal-plan weeks, fulfilment dates and cut-offs in local time', () => {
    expect(mondayOf('2026-10-14')).toBe('2026-10-12');
    expect(mondayOf('2026-10-18')).toBe('2026-10-12');
    expect(fulfilmentDateOf({ fulfilmentWeekday: 0 }, '2026-10-12')).toBe('2026-10-18');
    // 3 days before Monday 2026-10-26 at 18:00 London (GMT after DST ended on 25 Oct) = 2026-10-23 17:00Z (still BST)
    expect(cutoffOf({ fulfilmentWeekday: 1, cutoffDaysBefore: 3, cutoffTime: '18:00' }, '2026-10-26', 'Europe/London').toISOString()).toBe('2026-10-23T17:00:00.000Z');
  });

  it('routes order lines to stations by key with a fallback to the first station', () => {
    const st = (id: string, key: string, sortOrder: number, isExpo = false) => ({ id, key, sortOrder, isExpo, active: true }) as never;
    const routed = routeLines([{ name: 'Burger', stationKey: 'grill' }, { name: 'Soda', stationKey: 'bar' }, { name: 'Mystery', stationKey: null }] as never, [st('g', 'grill', 1), st('b', 'bar', 3), st('e', 'expo', 9, true)]);
    expect(routed.get('g')!.map((x) => x.line.name)).toEqual(['Burger', 'Mystery']);
    expect(routed.get('b')!.map((x) => x.line.name)).toEqual(['Soda']);
    expect(routed.has('e')).toBe(false);
  });

  it('flags AI drafts that claim diets or allergens the business did not supply', () => {
    expect(unsupportedClaims('Bright, vegan and gluten-free.', { dietary: ['vegan'], allergens: [] })).toEqual(['Claims "gluten-free" — not a business-supplied label for this item']);
    expect(unsupportedClaims('Slow-cooked and smoky.', { dietary: [], allergens: [] })).toEqual([]);
  });

  it('fills missing settings with safe defaults (pickup only, no tips, no service charge)', () => {
    const c = mergeFoodConfig({ channels: { delivery: true } } as never);
    expect(c.channels).toMatchObject({ pickup: true, delivery: true, dineIn: false });
    expect(c.tips.enabled).toBe(false);
    expect(c.serviceCharge.bps).toBe(0);
  });
});
