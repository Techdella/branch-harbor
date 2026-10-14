/**
 * Sample fixtures for the mock API (EXPO_PUBLIC_USE_MOCKS=true). Brands, people and images follow
 * design/prototype/bh-data.js; locations are international to exercise currency/timezone handling.
 * All amounts are integer minor units with an explicit currency.
 */
import type { Brand, Currency, Location, MenuItem } from '@/lib/types';

const u = (id: string, w = 900) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

export const IMG = {
  yogaGroup: u('1677741447985-da1d90c00742'),
  yogaStudio: u('1761035190790-aa1a3472f7fc', 600),
  yogaStretch: u('1761035005546-62b8018b212a', 600),
  yogaFloor: u('1644612105654-b6b0a941ecde', 600),
  yogaRoom: u('1676496962536-d8ef110ff6f0', 600),
  yogaHands: u('1608405059861-b21a68ae76a2', 600),
  yogaPink: u('1588286840104-8957b019727f', 500),
  yogaMeditate: u('1697274834392-04ff3b76ef20', 500),
  yogaRed: u('1625865020971-581242d0ead6', 500),
  foodTeam: u('1651977560788-98792cd34da0'),
  foodChef: u('1622021142947-da7dedc7c39a', 600),
  foodCook: u('1640583342012-4622f31b650d', 600),
  foodPizza: u('1651981075280-9a9e01acbff0', 600),
  foodTomato: u('1554997433-8e233c02c751', 600),
  foodOven: u('1682071308247-04c65c28bba5', 600),
  pW1: u('1573496359142-b8d87734a5a2', 200),
  pM1: u('1507003211169-0a1dd7228f2d', 200),
  pW2: u('1494790108377-be9c29b29330', 200),
  pW3: u('1438761681033-6461ffad8d80', 200),
  pM2: u('1500648767791-00dcc994a43e', 200),
  pW4: u('1534528741775-53994a69daeb', 200),
  pM4: u('1539571696357-5a69c17a67c6', 200),
};

export const BRANDS: Brand[] = [
  { id: 'stillwater', name: 'Stillwater Yoga', industry: 'studios', tagline: 'Yoga, Pilates and breathwork for every body.', hero: IMG.yogaGroup, offer: 'First week unlimited for new members' },
  { id: 'maple', name: 'Maple & Ember', industry: 'foods', tagline: 'Wood-fired food, ready when you are.', hero: IMG.foodTeam, offer: 'Lunch ready when you are — order ahead for pickup' },
];

/** Tax configs are sample business settings, not tax advice; real values come from each business. */
export const LOCATIONS: Location[] = [
  { id: 'sw-qw', brandId: 'stillwater', name: 'Queen West', city: 'Toronto', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', address: '812 Queen St W, Toronto, ON', status: 'operating', image: IMG.yogaStudio, tax: { label: 'HST', rateBps: 1300, inclusive: false }, cancellationHours: 12 },
  { id: 'sw-ch', brandId: 'stillwater', name: 'Capitol Hill', city: 'Seattle', country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', address: '1520 E Pine St, Seattle, WA', status: 'operating', image: IMG.yogaStretch, tax: null, cancellationHours: 12 },
  { id: 'sw-sd', brandId: 'stillwater', name: 'Shoreditch', city: 'London', country: 'GB', timeZone: 'Europe/London', currency: 'GBP', address: '12 Rivington St, London EC2A 3DU', status: 'operating', image: IMG.yogaFloor, tax: { label: 'VAT', rateBps: 2000, inclusive: true }, cancellationHours: 24 },
  { id: 'sw-pb', brandId: 'stillwater', name: 'Prenzlauer Berg', city: 'Berlin', country: 'DE', timeZone: 'Europe/Berlin', currency: 'EUR', address: 'Kastanienallee 40, 10435 Berlin', status: 'operating', image: IMG.yogaRoom, tax: { label: 'MwSt.', rateBps: 1900, inclusive: true }, cancellationHours: 24 },
  { id: 'sw-sh', brandId: 'stillwater', name: 'Surry Hills', city: 'Sydney', country: 'AU', timeZone: 'Australia/Sydney', currency: 'AUD', address: '300 Crown St, Surry Hills NSW 2010', status: 'operating', image: IMG.yogaHands, tax: { label: 'GST', rateBps: 1000, inclusive: true }, cancellationHours: 12 },
  { id: 'sw-dv', brandId: 'stillwater', name: 'LoHi', city: 'Denver', country: 'US', timeZone: 'America/Denver', currency: 'USD', address: '3200 Tejon St, Denver, CO', status: 'opening_soon', image: IMG.yogaMeditate, tax: null, cancellationHours: 12 },
  { id: 'me-bl', brandId: 'maple', name: 'Ballard', city: 'Seattle', country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', address: '5410 22nd Ave NW, Seattle, WA', status: 'operating', image: IMG.foodChef, tax: { label: 'Sales tax', rateBps: 1035, inclusive: false }, cancellationHours: 0 },
  { id: 'me-gt', brandId: 'maple', name: 'Gastown', city: 'Vancouver', country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', address: '12 Water St, Vancouver, BC', status: 'operating', image: IMG.foodCook, tax: { label: 'GST', rateBps: 500, inclusive: false }, cancellationHours: 0 },
  { id: 'me-sb', brandId: 'maple', name: 'Southbank', city: 'London', country: 'GB', timeZone: 'Europe/London', currency: 'GBP', address: '45 Belvedere Rd, London SE1', status: 'operating', image: IMG.foodOven, tax: { label: 'VAT', rateBps: 2000, inclusive: true }, cancellationHours: 0 },
  { id: 'me-kz', brandId: 'maple', name: 'Kreuzberg', city: 'Berlin', country: 'DE', timeZone: 'Europe/Berlin', currency: 'EUR', address: 'Oranienstraße 18, 10999 Berlin', status: 'operating', image: IMG.foodPizza, tax: { label: 'MwSt.', rateBps: 700, inclusive: true }, cancellationHours: 0 },
];

export const CLASS_PRICE: Record<string, number> = { CAD: 2800, USD: 2600, GBP: 1800, EUR: 2000, AUD: 3200 };

export const CLASS_TEMPLATES = [
  { time: '07:00', name: 'Morning Vinyasa', instructor: 'Maya Rao', durationMin: 60, capacity: 20, room: 'Studio A', image: IMG.yogaPink },
  { time: '09:00', name: 'Slow Flow', instructor: 'Sam Tran', durationMin: 75, capacity: 16, room: 'Studio B', image: IMG.yogaMeditate },
  { time: '12:15', name: 'Lunchtime Pilates', instructor: 'Ana Silva', durationMin: 45, capacity: 14, room: 'Studio A', image: IMG.yogaStretch },
  { time: '17:30', name: 'Power Flow', instructor: 'Maya Rao', durationMin: 60, capacity: 20, room: 'Studio A', image: IMG.yogaFloor },
  { time: '18:30', name: 'Yin & Restore', instructor: 'Jordan Lee', durationMin: 60, capacity: 12, room: 'Studio B', image: IMG.yogaRed },
];

type PriceTable = Partial<Record<Currency, number>>;
const p = (USD: number, CAD: number, GBP: number, EUR: number): PriceTable => ({ USD, CAD, GBP, EUR });

interface MenuTemplate extends Omit<MenuItem, 'price' | 'modifierGroups'> {
  prices: PriceTable;
  groups: { id: string; name: string; min: number; max: number; options: { id: string; name: string; prices: PriceTable; soldOut?: boolean }[] }[];
}

export const MENU: MenuTemplate[] = [
  {
    id: 'bowl', category: 'Bowls', name: 'Ember chicken bowl', description: 'Charred chicken, greens, corn, ember sauce', prices: p(1650, 1900, 1250, 1400), image: IMG.foodCook, dietary: ['Gluten-free option'],
    groups: [
      { id: 'base', name: 'Base', min: 1, max: 1, options: [{ id: 'jasmine', name: 'Jasmine rice', prices: p(0, 0, 0, 0) }, { id: 'brown', name: 'Brown rice', prices: p(0, 0, 0, 0) }, { id: 'greens', name: 'Extra greens', prices: p(100, 125, 75, 80) }] },
      { id: 'adds', name: 'Add-ons', min: 0, max: 3, options: [{ id: 'chicken', name: 'Extra chicken', prices: p(400, 450, 300, 350) }, { id: 'avocado', name: 'Avocado', prices: p(250, 300, 200, 200), soldOut: true }, { id: 'onion', name: 'Pickled onions', prices: p(75, 100, 50, 60) }] },
    ],
  },
  { id: 'brisket', category: 'Sandwiches', name: 'Smoked brisket sandwich', description: 'Pickles, slaw, brioche', prices: p(1800, 2050, 1400, 1550), image: IMG.foodChef, dietary: [], soldOut: true, groups: [] },
  {
    id: 'flatbread', category: 'Wood-fired', name: 'Wood-fired flatbread', description: 'Seasonal toppings, basil oil', prices: p(1500, 1750, 1150, 1300), image: IMG.foodPizza, dietary: ['Vegetarian'],
    groups: [{ id: 'size', name: 'Size', min: 1, max: 1, options: [{ id: 'reg', name: 'Regular', prices: p(0, 0, 0, 0) }, { id: 'lg', name: 'Large', prices: p(400, 450, 300, 350) }] }],
  },
  { id: 'salad', category: 'Salads', name: 'Garden tomato salad', description: 'Herbs, sherry vinegar', prices: p(1100, 1300, 850, 950), image: IMG.foodTomato, dietary: ['Vegan'], groups: [] },
  { id: 'lemonade', category: 'Drinks', name: 'Maple lemonade', description: 'House-made', prices: p(500, 600, 400, 420), image: IMG.foodOven, dietary: ['Vegan'], groups: [] },
];

export function menuFor(currency: Currency): MenuItem[] {
  return MENU.map(({ prices, groups, ...m }) => ({
    ...m,
    price: { amount: prices[currency] ?? prices.USD ?? 0, currency },
    modifierGroups: groups.map((g) => ({
      ...g,
      options: g.options.map(({ prices: op, ...o }) => ({ ...o, price: { amount: op[currency] ?? op.USD ?? 0, currency } })),
    })),
  }));
}
