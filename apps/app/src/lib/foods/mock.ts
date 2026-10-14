/**
 * In-memory sample implementation of `FoodsApi` (NEXT_PUBLIC_USE_MOCKS=true, or offline fallback).
 * Sample data only: Maple & Ember with Seattle (USD), Vancouver (CAD), London (GBP) and Berlin (EUR, not yet
 * open). It keeps state between calls, applies the same rules the server applies where it matters for the
 * screens (status flows, skip cut-offs, sold-out until close, per-currency totals) and honours ?demo=error.
 */
import type { Money } from '@bh/shared';
import { ApiError } from '../errors';
import { FIXTURES, at, minutesAgo } from '../mock/orgs';
import type { FoodsApi } from './api';
import type {
  Builder, BuilderItem, CateringEnquiry, CateringPackage, DayPart, Delivery, DeliveryZone, Driver, EffectiveItem, FoodConfig, FoodOrderLite, Ingredient, KdsTicket,
  LocationSettings, MealPlan, MealPlanSubscription, ProductionDate, Station, Tab, Table,
} from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => structuredClone(v);
const demo = () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('demo'));
async function read<T>(v: () => T, ms = 250): Promise<T> {
  if (demo() === 'loading') await new Promise(() => {});
  await sleep(ms);
  if (demo() === 'error') throw new ApiError('server_error', 'The service returned an error while loading this data.', 500);
  return clone(v());
}
async function write<T>(v: () => T, ms = 450): Promise<T> {
  await sleep(ms);
  return clone(v());
}
let n = 0;
const id = (p: string) => `${p}_${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const conflict = (code: string, message: string) => new ApiError(code, message, 409);
const money = (amount: number, currency: string) => ({ amount, currency }) as Money;
const now = () => new Date().toISOString();
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const today = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400_000).toISOString().slice(0, 10);
const monday = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

const LOCS = FIXTURES.foods.locations;
const live = LOCS.filter((l) => l.site !== 'unpublished');
const L = (lid: string) => LOCS.find((l) => l.id === lid)!;

/* ---------------- sample state ---------------- */

const dayParts: DayPart[] = [
  { id: 'dp_bfast', name: 'Breakfast', translations: { fr: { name: 'Petit-déjeuner' } }, windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '07:00', end: '11:00' })), sortOrder: 1, active: true },
  { id: 'dp_dinner', name: 'Dinner', translations: {}, windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '16:00', end: '22:30' })), sortOrder: 2, active: true },
];
const P = (usd: number, cad: number, gbp: number, eur: number) => ({ USD: usd, CAD: cad, GBP: gbp, EUR: eur });
const item = (o: Partial<BuilderItem> & Pick<BuilderItem, 'id' | 'name' | 'category' | 'categoryId' | 'prices'>): BuilderItem => ({
  menuId: 'menu_all', description: null, dietary: [], allergens: [], allergensDeclared: true, translations: {}, dayPartIds: [], stationKey: 'grill', prepMinutes: 10, imageUrl: null,
  localOverridable: ['price', 'available'], sortOrder: 0, active: true, modifierGroups: [], ...o,
});
const builder: Builder = {
  dayParts,
  locations: LOCS.map((l) => ({ id: l.id, name: l.name, currency: l.currency, country: l.address.country, timeZone: l.timeZone, status: l.site === 'unpublished' ? 'opening_soon' : 'operating', defaultAllergenRegime: l.address.country === 'US' ? 'us9' : l.address.country === 'CA' ? 'ca' : 'eu14' })),
  menus: [
    {
      id: 'menu_all', name: 'All-day menu', kind: 'standard', status: 'published', description: 'Served all day; breakfast until 11:00 local time.', dayPartIds: [], publishedAt: minutesAgo(2880),
      categories: ['Breakfast', 'Bowls', 'Sandwiches', 'Pizza', 'Sides', 'Desserts', 'Drinks'].map((name, i) => ({ id: `cat_${name.toLowerCase()}`, menuId: 'menu_all', name, description: null, translations: {}, dayPartIds: name === 'Breakfast' ? ['dp_bfast'] : name === 'Pizza' ? ['dp_dinner'] : [], sortOrder: i + 1, active: true })),
      items: [
        item({ id: 'mi_bfast', name: 'Ember breakfast sandwich', category: 'Breakfast', categoryId: 'cat_breakfast', description: 'Fried egg, cheddar, maple bacon on brioche', prices: P(1100, 1450, 850, 800), allergens: ['eggs', 'milk', 'cereals_gluten', 'wheat'], prepMinutes: 7 }),
        item({ id: 'mi_bowl', name: 'Ember chicken bowl', category: 'Bowls', categoryId: 'cat_bowls', description: 'Rice, greens, charred corn', prices: P(1600, 2100, 1250, 1350), translations: { fr: { name: 'Bol au poulet braisé' } }, prepMinutes: 12,
          modifierGroups: [
            { id: 'mg_size', name: 'Size', minSelect: 1, maxSelect: 1, translations: {}, modifiers: [{ id: 'mod_reg', name: 'Regular', prices: P(0, 0, 0, 0), allergens: [], available: true, translations: {}, sortOrder: 0 }, { id: 'mod_large', name: 'Large', prices: P(300, 400, 250, 250), allergens: [], available: true, translations: {}, sortOrder: 1 }] },
            { id: 'mg_sauce', name: 'Sauce', minSelect: 1, maxSelect: 1, translations: {}, modifiers: [{ id: 'mod_chimi', name: 'Chimichurri', prices: P(0, 0, 0, 0), allergens: [], available: true, translations: {}, sortOrder: 0 }, { id: 'mod_yog', name: 'Garlic yoghurt', prices: P(0, 0, 0, 0), allergens: ['milk'], available: true, translations: {}, sortOrder: 1 }] },
          ] }),
        item({ id: 'mi_veg', name: 'Charred veg grain bowl', category: 'Bowls', categoryId: 'cat_bowls', prices: P(1450, 1900, 1150, 1200), dietary: ['vegan'], allergens: ['sesame', 'cereals_gluten', 'wheat'], stationKey: 'cold' }),
        item({ id: 'mi_brisket', name: 'Smoked brisket sandwich', category: 'Sandwiches', categoryId: 'cat_sandwiches', description: 'Pickles, slaw, brioche', prices: P(1500, 1950, 1150, 1250), allergens: ['cereals_gluten', 'wheat', 'eggs', 'mustard'],
          modifierGroups: [{ id: 'mg_addons', name: 'Add-ons', minSelect: 0, maxSelect: 2, translations: {}, modifiers: [{ id: 'mod_pickles', name: 'Extra pickles', prices: P(100, 150, 80, 80), allergens: [], available: true, translations: {}, sortOrder: 0 }, { id: 'mod_egg', name: 'Fried egg', prices: P(200, 250, 150, 150), allergens: ['eggs'], available: true, translations: {}, sortOrder: 1 }] }] }),
        item({ id: 'mi_pizza', name: 'Margherita, wood-fired', category: 'Pizza', categoryId: 'cat_pizza', description: '12-inch', prices: P(1800, 2350, 1300, 1100), dietary: ['vegetarian'], allergens: ['cereals_gluten', 'wheat', 'milk'], prepMinutes: 14 }),
        item({ id: 'mi_fries', name: 'House fries', category: 'Sides', categoryId: 'cat_sides', prices: P(600, 750, 450, 450), dietary: ['vegan'] }),
        item({ id: 'mi_tart', name: 'Burnt honey tart', category: 'Desserts', categoryId: 'cat_desserts', prices: P(800, 1050, 650, 600), dietary: ['vegetarian'], allergens: ['milk', 'eggs', 'cereals_gluten', 'wheat'], stationKey: 'cold' }),
        item({ id: 'mi_lemonade', name: 'Maple lemonade', category: 'Drinks', categoryId: 'cat_drinks', prices: P(500, 650, 400, 400), dietary: ['vegan'], stationKey: 'bar', localOverridable: ['available'] }),
        item({ id: 'mi_coldbrew', name: 'Cold brew', category: 'Drinks', categoryId: 'cat_drinks', prices: P(550, 700, 400, 350), allergensDeclared: false, stationKey: 'bar' }),
      ],
      publications: live.map((l) => ({ menuId: 'menu_all', locationId: l.id, status: 'succeeded' as const, publishedAt: minutesAgo(2880), detail: { available: 9, unavailable: [] } })),
    },
    {
      id: 'menu_pre', name: 'Weekend preorders', kind: 'preorder', status: 'published', description: 'Order by the cut-off, collect on the cooking date.', dayPartIds: [], publishedAt: minutesAgo(4000),
      categories: [{ id: 'cat_feasts', menuId: 'menu_pre', name: 'Feasts', description: null, translations: {}, dayPartIds: [], sortOrder: 1, active: true }],
      items: [item({ id: 'mi_whole', menuId: 'menu_pre', name: 'Whole smoked brisket (serves 6)', category: 'Feasts', categoryId: 'cat_feasts', prices: { USD: 9500, CAD: 12500, GBP: 7500 }, allergens: ['mustard'], prepMinutes: 30 })],
      publications: live.map((l) => ({ menuId: 'menu_pre', locationId: l.id, status: l.currency === 'EUR' ? 'failed' as const : 'succeeded' as const, publishedAt: minutesAgo(4000), detail: { available: l.currency === 'EUR' ? 0 : 1, unavailable: [], reason: l.currency === 'EUR' ? 'No item has a price in EUR' : undefined } })),
    },
  ],
};
const soldOut = new Map<string, string | null>([[`fr:mi_pizza`, inMin(240)], [`gv:mod_large`, inMin(300)]]);

const cfgFor = (lid: string): FoodConfig => {
  const l = L(lid);
  const us = l.currency === 'USD' || l.currency === 'CAD';
  return {
    channels: { pickup: true, delivery: lid === 'bl' || lid === 'fr' || lid === 'bo', dineIn: lid !== 'fr', preorder: lid === 'bl', catering: lid === 'bl' || lid === 'bo' || lid === 'gv', mealPlans: lid === 'bl' || lid === 'bo' },
    tips: { enabled: true, presetsBps: us ? [1500, 1800, 2000] : [1000, 1250], allowCustom: true, channels: us ? ['pickup', 'delivery', 'dine_in'] : ['dine_in'] },
    serviceCharge: { bps: lid === 'bo' ? 1250 : 0, label: 'Service charge', channels: lid === 'bo' ? ['dine_in', 'catering'] : [] },
    allergenRegime: null,
    delivery: { provider: lid === 'fr' ? 'uber_direct' : 'own', hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '11:00', close: '21:30' })), slotMinutes: 30, slotCapacity: 4, leadMinutes: 45, cutoffMinutes: 30, horizonDays: 2 },
    kds: { audibleDefault: true, defaultPrepMinutes: 12 },
    autoSoldOutOnIngredients: us,
  };
};
const settings: LocationSettings[] = LOCS.map((l) => ({ locationId: l.id, name: l.name, currency: l.currency, country: l.address.country, timeZone: l.timeZone, taxRateBps: l.currency === 'USD' ? 1035 : null, config: cfgFor(l.id), allergenRegime: l.address.country === 'US' ? 'us9' : l.address.country === 'CA' ? 'ca' : 'eu14' }));

const stations: Station[] = live.flatMap((l) => [
  { key: 'grill', name: 'Grill', prepTargetMinutes: 14, isExpo: false, sortOrder: 1 }, { key: 'cold', name: 'Cold', prepTargetMinutes: 8, isExpo: false, sortOrder: 2 },
  { key: 'bar', name: 'Bar', prepTargetMinutes: 4, isExpo: false, sortOrder: 3 }, { key: 'expo', name: 'Expo / pass', prepTargetMinutes: 2, isExpo: true, sortOrder: 9 },
].map((s) => ({ ...s, id: `st_${l.id}_${s.key}`, locationId: l.id, active: true })));

type MockOrder = FoodOrderLite & { notes: string | null; lineDetail: Array<{ name: string; quantity: number; modifiers: string[]; station: string }> };
const FIRST = ['Jamie', 'Ren', 'Sam', 'Ava', 'Noor', 'Theo', 'Isla', 'Kai'];
let seq = 1040;
const mkOrder = (lid: string, channel: string, status: string, promisedIn: number, lines: Array<[string, number, string[]?]>, extra: Partial<MockOrder> = {}): MockOrder => {
  const l = L(lid);
  const detail = lines.map(([iid, q, mods]) => { const it = builder.menus[0]!.items.find((x) => x.id === iid)!; return { name: it.name, quantity: q, modifiers: mods ?? [], station: it.stationKey ?? 'grill', price: (it.prices[l.currency] ?? 0) * q }; });
  return {
    id: id('fo'), orderNumber: `${l.code}-${seq++}`, locationId: lid, status, paymentStatus: 'paid', channel, total: money(detail.reduce((a, d) => a + d.price, 0), l.currency), promisedAt: inMin(promisedIn),
    contact: { name: FIRST[seq % FIRST.length]! }, fulfilment: {}, lines: detail.map((d) => ({ name: d.name, quantity: d.quantity })), createdAt: inMin(-15), notes: null,
    lineDetail: detail.map(({ name, quantity, modifiers, station }) => ({ name, quantity, modifiers, station })), ...extra,
  };
};
const orders: MockOrder[] = [
  mkOrder('bl', 'pickup', 'awaiting_acceptance', 25, [['mi_bowl', 1, ['Regular', 'Chimichurri']], ['mi_lemonade', 1]]),
  mkOrder('bl', 'pickup', 'accepted', 12, [['mi_brisket', 2, ['Fried egg']], ['mi_fries', 1]]),
  mkOrder('bl', 'dine_in', 'preparing', 6, [['mi_veg', 1], ['mi_coldbrew', 2]], { fulfilment: { tableLabel: 'Table 3' }, notes: 'No onions please' }),
  mkOrder('bl', 'delivery', 'preparing', -3, [['mi_pizza', 1], ['mi_tart', 1]], { fulfilment: { zoneName: 'Ballard & Crown Hill', address: { city: 'Seattle', postalCode: '98107' } } }),
  mkOrder('bl', 'delivery', 'ready', 8, [['mi_bowl', 2, ['Large', 'Garlic yoghurt']]], { fulfilment: { zoneName: 'Within 5 km', address: { city: 'Seattle', postalCode: '98117' } } }),
  mkOrder('bo', 'dine_in', 'accepted', 10, [['mi_tart', 2], ['mi_coldbrew', 2]], { fulfilment: { tableLabel: 'Table 4' }, paymentStatus: 'on_tab' }),
  mkOrder('bo', 'pickup', 'awaiting_acceptance', 30, [['mi_pizza', 1]]),
  mkOrder('gv', 'pickup', 'preparing', 15, [['mi_bowl', 1, ['Regular', 'Chimichurri']]]),
];
const tickets: Array<KdsTicket> = [];
const ensureTickets = () => {
  for (const o of orders.filter((x) => ['accepted', 'preparing', 'ready'].includes(x.status))) {
    const byStation = new Map<string, MockOrder['lineDetail']>();
    o.lineDetail.forEach((d) => byStation.set(d.station, [...(byStation.get(d.station) ?? []), d]));
    for (const [key, ls] of byStation) {
      const st = stations.find((s) => s.locationId === o.locationId && s.key === key) ?? stations.find((s) => s.locationId === o.locationId && !s.isExpo)!;
      if (tickets.some((t) => t.orderId === o.id && t.stationId === st.id)) continue;
      const done = o.status === 'ready';
      tickets.push({
        id: id('tk'), orderId: o.id, orderNumber: o.orderNumber, firstName: o.contact.name, channel: o.channel, tableLabel: o.fulfilment.tableLabel ?? null, stationId: st.id, stationName: st.name,
        status: done ? 'done' : o.status === 'preparing' && key === 'bar' ? 'done' : 'queued', orderStatus: o.status, lines: ls.map((d, index) => ({ index, name: d.name, quantity: d.quantity, modifiers: d.modifiers })),
        orderNotes: o.notes, promisedAt: o.promisedAt, targetAt: o.promisedAt ?? inMin(st.prepTargetMinutes), createdAt: o.createdAt, startedAt: null, bumpedAt: done ? minutesAgo(2) : null, ageMinutes: 15, overdue: false, overdueMinutes: 0, recalledCount: 0,
      });
    }
  }
};

const zones: DeliveryZone[] = [
  { id: 'z1', locationId: 'bl', name: 'Ballard & Crown Hill', kind: 'postcode', radiusMeters: null, postcodes: ['98107', '98117'], fee: money(399, 'USD'), minimumOrder: money(2000, 'USD'), freeDeliveryAbove: money(6000, 'USD'), active: true, sortOrder: 1 },
  { id: 'z2', locationId: 'bl', name: 'Within 5 km', kind: 'radius', radiusMeters: 5000, postcodes: [], fee: money(599, 'USD'), minimumOrder: money(2500, 'USD'), freeDeliveryAbove: null, active: true, sortOrder: 2 },
  { id: 'z3', locationId: 'fr', name: 'Fremont & Wallingford', kind: 'postcode', radiusMeters: null, postcodes: ['98103'], fee: money(449, 'USD'), minimumOrder: money(2000, 'USD'), freeDeliveryAbove: null, active: true, sortOrder: 1 },
  { id: 'z4', locationId: 'bo', name: 'South London', kind: 'postcode', radiusMeters: null, postcodes: ['SE1', 'SE11', 'SE17'], fee: money(250, 'GBP'), minimumOrder: money(1500, 'GBP'), freeDeliveryAbove: money(4000, 'GBP'), active: true, sortOrder: 1 },
];
const drivers: Driver[] = [
  { id: 'dr1', locationId: 'bl', userId: null, name: 'Carlos Ortega', phone: '+1 206 555 0177', active: true },
  { id: 'dr2', locationId: 'bl', userId: null, name: 'Dee Walker', phone: '+1 206 555 0178', active: true },
  { id: 'dr3', locationId: 'bo', userId: null, name: 'Priya Shah', phone: '+44 7700 900123', active: true },
];
const deliveries: Delivery[] = [];
const tables: Table[] = ['bl', 'gv', 'bo'].flatMap((lid) => Array.from({ length: 6 }, (_, i) => ({ id: `tb_${lid}_${i + 1}`, locationId: lid, label: `Table ${i + 1}`, code: `${L(lid).code.replace('-', '')}${i + 1}`, seats: i % 3 ? 4 : 2, area: 'Dining room', active: true, openTabId: lid === 'bo' && i === 3 ? 'tab_bo' : null })));
const tabs: Tab[] = [{ id: 'tab_bo', tableId: 'tb_bo_4', tableLabel: 'Table 4', locationId: 'bo', status: 'open', guestName: 'Oliver', paidVia: null, openedAt: minutesAgo(30), closedAt: null, orders: [{ id: orders[5]!.id, orderNumber: orders[5]!.orderNumber, status: 'accepted', total: orders[5]!.total }], subtotal: money(2100, 'GBP'), serviceCharge: money(263, 'GBP'), tax: money(0, 'GBP'), tip: money(0, 'GBP'), total: money(2363, 'GBP'), amountDue: money(2363, 'GBP') }];

const prodDates: ProductionDate[] = [6, 7].map((k, i) => {
  const d = addDays(today('America/Los_Angeles'), k);
  return { id: `pd${i}`, locationId: 'bl', date: d, cutoffAt: at('America/Los_Angeles', '18:00', k - 2), collectionWindows: ['10:00-12:00', '14:00-17:00'], capacity: 30, booked: 4 - i * 3, remaining: 26 + i * 3, status: 'open', note: i ? null : 'Brisket comes off the smoker at 09:30', cutoffPassed: false, menuId: 'menu_pre' };
});
const packages: CateringPackage[] = [
  { id: 'pk1', name: 'Office lunch', description: 'Bowls, sandwiches and salads delivered ready to serve.', pricesPerGuest: { USD: 1800, CAD: 2300, GBP: 1500, EUR: 1600 }, minGuests: 10, maxGuests: 120, leadDays: 2, includes: ['Choice of 3 bowls', 'Sandwich platter', 'Seasonal salad'], dietary: [], allergens: ['cereals_gluten', 'wheat', 'milk', 'eggs', 'mustard', 'sesame'], allergensDeclared: true, locationIds: [], active: true },
  { id: 'pk2', name: 'Smokehouse feast', description: 'Whole smoked brisket and chicken, sides and desserts.', pricesPerGuest: { USD: 3200, CAD: 4100, GBP: 2600 }, minGuests: 20, maxGuests: null, leadDays: 5, includes: ['Brisket & chicken', '3 sides', 'Burnt honey tart'], dietary: [], allergens: ['cereals_gluten', 'wheat', 'milk', 'eggs', 'mustard'], allergensDeclared: true, locationIds: [], active: true },
];
const enq = (lid: string, ref: string, name: string, days: number, guests: number, pkg: string, status: string, quoted: boolean): CateringEnquiry => {
  const l = L(lid);
  const p = packages.find((x) => x.id === pkg)!;
  const sub = (p.pricesPerGuest[l.currency] ?? 0) * guests;
  const service = lid === 'bo' ? Math.round(sub * 0.125) : 0;
  const tax = l.currency === 'USD' ? Math.round(sub * 0.1035) : 0;
  const total = sub + service + tax;
  return {
    id: id('ce'), reference: ref, locationId: lid, status, eventDate: addDays(today(l.timeZone), days), eventTime: '12:30', guests, packageId: pkg, packageName: p.name, fulfilment: 'delivery', notes: status === 'new' ? 'Quarterly all-hands' : null, dietaryNotes: status === 'new' ? '6 vegetarian, 2 vegan (guest-reported)' : null,
    contact: { name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com` },
    quote: quoted ? { version: 1, lines: [{ description: `${p.name} — per guest`, quantity: guests, unitPrice: money(p.pricesPerGuest[l.currency] ?? 0, l.currency), total: money(sub, l.currency) }], subtotal: money(sub, l.currency), serviceCharge: service ? money(service, l.currency) : null, deliveryFee: null, tax: tax ? money(tax, l.currency) : null, taxRateBps: tax ? 1035 : null, total: money(total, l.currency), deposit: money(Math.round(total * 0.3), l.currency), validUntil: inMin(6 * 1440), terms: 'Deposit secures the date.', sentAt: minutesAgo(1440) } : null,
    depositPaymentId: null, acceptedAt: null, depositPaidAt: status === 'deposit_paid' || status === 'confirmed' ? minutesAgo(600) : null, confirmedAt: status === 'confirmed' ? minutesAgo(500) : null, declinedReason: null,
    statusHistory: [{ at: minutesAgo(4000), from: null, to: 'new' }], createdAt: minutesAgo(4000),
  };
};
const enquiries: CateringEnquiry[] = [
  enq('bl', 'CAT-7Q2LM', 'Taylor Brooks', 9, 40, 'pk1', 'new', false), enq('bl', 'CAT-3HZ8D', 'Jamie Rivera', 12, 25, 'pk2', 'quoted', true),
  enq('bl', 'CAT-9KD2A', 'Casey Morgan', 4, 30, 'pk1', 'deposit_paid', true), enq('bl', 'CAT-1MXT4', 'Robin Shah', 2, 18, 'pk1', 'confirmed', true),
  enq('gv', 'CAT-5TRB2', 'Léa Gagnon', 14, 60, 'pk2', 'new', false), enq('bo', 'CAT-8PLW3', 'Freya Collins', 8, 24, 'pk1', 'quoted', true),
];
const plans: MealPlan[] = [
  { id: 'mp1', name: 'Weekly prep box — 5 meals', description: 'Five chef-selected bowls for the week.', mealsPerBox: 5, pricesPerWeek: { USD: 6900, CAD: 8900, GBP: 5500, EUR: 5900 }, fulfilment: 'pickup', fulfilmentWeekday: 1, cutoffDaysBefore: 3, cutoffTime: '18:00', menuItemIds: ['mi_bowl', 'mi_veg'], locationIds: ['bl', 'bo'], active: true, subscribers: { active: 3, paused: 1 } },
  { id: 'mp2', name: 'Family box — 10 meals', description: 'Ten meals delivered on Sundays.', mealsPerBox: 10, pricesPerWeek: { USD: 12900, GBP: 9900 }, fulfilment: 'delivery', fulfilmentWeekday: 0, cutoffDaysBefore: 3, cutoffTime: '12:00', menuItemIds: ['mi_bowl', 'mi_brisket', 'mi_veg'], locationIds: ['bl', 'bo'], active: true, subscribers: { active: 2 } },
];
const weeks = (tz: string, skipped: string[], plan: MealPlan) => {
  const base = monday(today(tz));
  return [0, 1, 2, 3].map((k) => {
    const w = addDays(base, 7 * k);
    const ful = addDays(w, (plan.fulfilmentWeekday + 6) % 7);
    const cutoff = new Date(Date.parse(`${addDays(ful, -plan.cutoffDaysBefore)}T${plan.cutoffTime}:00Z`));
    return { weekStart: w, fulfilmentDate: ful, cutoffAt: cutoff.toISOString(), skipped: skipped.includes(w), canChange: cutoff.getTime() > Date.now() };
  });
};
const sub = (lid: string, planId: string, name: string, status: string, skipNext = false): MealPlanSubscription => {
  const l = L(lid);
  const plan = plans.find((p) => p.id === planId)!;
  const skipped = skipNext ? [addDays(monday(today(l.timeZone)), 7)] : [];
  return { id: id('sub'), planId, planName: plan.name, locationId: lid, locationName: l.name, status, price: money(plan.pricesPerWeek[l.currency]!, l.currency), startWeek: addDays(monday(today(l.timeZone)), -14), skippedWeeks: skipped, sandbox: true, fulfilment: plan.fulfilment, contact: { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com` }, upcoming: weeks(l.timeZone, skipped, plan), createdAt: minutesAgo(20000) };
};
const subs: MealPlanSubscription[] = [sub('bl', 'mp1', 'Morgan Lee', 'active'), sub('bl', 'mp1', 'Priya Nair', 'active', true), sub('bl', 'mp2', 'The Okafor family', 'active'), sub('bo', 'mp1', 'Harriet Cole', 'active'), sub('bo', 'mp1', 'Amara Okoye', 'paused')];
const ingredients = new Map<string, Ingredient[]>(live.map((l) => [l.id, [
  { id: 'ing_brisket', name: 'Brisket', unit: 'g' as const, sku: 'MT-BRISKET', stock: { onHand: 5400, lowStockThreshold: 1800, autoSoldOut: true, lowStock: false, exhausted: false, updatedAt: minutesAgo(60) }, usedBy: [{ menuItemId: 'mi_brisket', name: 'Smoked brisket sandwich', quantity: 180, viaModifier: false }] },
  { id: 'ing_lemons', name: 'Lemons', unit: 'each' as const, sku: 'PR-LEMON', stock: { onHand: l.id === 'bl' ? 6 : 30, lowStockThreshold: 10, autoSoldOut: true, lowStock: l.id === 'bl', exhausted: false, updatedAt: minutesAgo(180) }, usedBy: [{ menuItemId: 'mi_lemonade', name: 'Maple lemonade', quantity: 2, viaModifier: false }] },
  { id: 'ing_tart', name: 'Tart shells', unit: 'each' as const, sku: 'BK-TART', stock: { onHand: l.id === 'fr' ? 0 : 9, lowStockThreshold: 4, autoSoldOut: true, lowStock: l.id === 'fr', exhausted: l.id === 'fr', updatedAt: minutesAgo(120) }, usedBy: [{ menuItemId: 'mi_tart', name: 'Burnt honey tart', quantity: 1, viaModifier: false }] },
  { id: 'ing_eggs', name: 'Eggs', unit: 'each' as const, sku: 'DY-EGG', stock: null, usedBy: [{ menuItemId: 'mi_bfast', name: 'Ember breakfast sandwich', quantity: 1, viaModifier: false }, { menuItemId: 'mi_brisket', name: 'Smoked brisket sandwich', quantity: 1, viaModifier: true }] },
]]));

const effective = (lid: string): EffectiveItem[] => {
  const l = L(lid);
  const regime = settings.find((s) => s.locationId === lid)!.allergenRegime;
  const ings = ingredients.get(lid) ?? [];
  return builder.menus[0]!.items.filter((i) => i.active).map((it) => {
    const price = it.prices[l.currency];
    const so = soldOut.has(`${lid}:${it.id}`);
    const ingShort = ings.some((g) => g.stock?.exhausted && g.usedBy.some((u) => u.menuItemId === it.id && !u.viaModifier));
    return {
      id: it.id, name: it.name, category: it.category, price: price === undefined ? null : money(price, l.currency), available: price !== undefined && !so && !ingShort,
      unavailableReason: price === undefined ? `No price set in ${l.currency}` : so || ingShort ? 'Sold out' : null, unavailableCode: price === undefined ? 'no_price' : so || ingShort ? 'sold_out' : null,
      soldOutSource: so ? 'manual' : ingShort ? 'ingredient' : null, soldOutUntil: so ? soldOut.get(`${lid}:${it.id}`) ?? null : null, dietary: it.dietary,
      allergenInfo: { regime, status: it.allergensDeclared || it.allergens.length ? 'declared' : 'not_provided', items: it.allergens.map((k) => ({ key: k, label: k.replace(/_/g, ' '), inRegime: true })) },
      modifierGroups: it.modifierGroups.map((g) => ({ id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, required: g.minSelect > 0, modifiers: g.modifiers.map((m) => ({ id: m.id, name: m.name, price: m.prices[l.currency] === undefined ? null : money(m.prices[l.currency]!, l.currency), available: !soldOut.has(`${lid}:${m.id}`), soldOut: soldOut.has(`${lid}:${m.id}`) })) })),
    };
  });
};
const closeAt = (lid: string) => at(L(lid).timeZone, '22:00');
const findItem = (iid: string) => builder.menus.flatMap((m) => m.items).find((i) => i.id === iid);

const NEXT: Record<string, string> = { awaiting_acceptance: 'accepted', accepted: 'preparing', preparing: 'ready' };

export const mockFoodsApi: FoodsApi = {
  mode: 'mock',
  overview: (locationId) => read(() => ({
    refreshedAt: now(), integrations: [{ key: 'uber_direct', name: 'Uber Direct', mode: 'sandbox' }, { key: 'deliverect', name: 'Deliverect', mode: 'sandbox' }],
    locations: live.filter((l) => !locationId || l.id === locationId).map((l) => {
      const mine = orders.filter((o) => o.locationId === l.id);
      return {
        locationId: l.id, name: l.name, timeZone: l.timeZone, currency: l.currency, orders: Object.fromEntries(['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'out_for_delivery'].map((s) => [s, mine.filter((o) => o.status === s).length])),
        overdue: mine.filter((o) => o.promisedAt && o.promisedAt < now() && ['accepted', 'preparing'].includes(o.status)).length, byChannel: mine.reduce<Record<string, number>>((a, o) => ({ ...a, [o.channel]: (a[o.channel] ?? 0) + 1 }), {}),
        pickupCapacityToday: l.id === 'kr' ? null : { capacity: 96, booked: 21 + mine.length, remaining: 75 - mine.length, slots: 16 }, pickupCapacityUnavailableReason: null,
        soldOut: effective(l.id).filter((i) => i.unavailableCode === 'sold_out').map((i) => ({ id: i.id, name: i.name, source: i.soldOutSource, until: i.soldOutUntil })),
        lowStock: (ingredients.get(l.id) ?? []).filter((g) => g.stock?.lowStock).map((g) => ({ name: g.name, onHand: g.stock!.onHand, unit: g.unit, threshold: g.stock!.lowStockThreshold })),
        catering: { new: enquiries.filter((e) => e.locationId === l.id && e.status === 'new').length, depositPaid: enquiries.filter((e) => e.locationId === l.id && e.status === 'deposit_paid').length, awaitingDeposit: enquiries.filter((e) => e.locationId === l.id && e.status === 'accepted').length },
        mealPlansActive: subs.filter((s) => s.locationId === l.id && s.status === 'active').length,
        deliveries: { active: deliveries.filter((d) => d.locationId === l.id && ['pending', 'assigned', 'picked_up'].includes(d.status)).length, ordersAwaitingDispatch: mine.filter((o) => o.channel === 'delivery' && !deliveries.some((d) => d.orderId === o.id)).length },
      };
    }),
  })),
  vocabulary: () => read(() => ({
    allergens: ['cereals_gluten', 'wheat', 'crustaceans', 'molluscs', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'tree_nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin'].map((k) => ({ key: k, label: k === 'cereals_gluten' ? 'Cereals containing gluten' : k === 'tree_nuts' ? 'Tree nuts' : k === 'soybeans' ? 'Soy' : k[0]!.toUpperCase() + k.slice(1) })),
    regimes: [{ key: 'eu14', label: 'EU/UK 14 allergens', allergens: [] }, { key: 'us9', label: 'US major food allergens', allergens: [] }, { key: 'ca', label: 'Canada priority allergens', allergens: [] }],
    dietary: ['vegan', 'vegetarian', 'pescatarian', 'gluten-free', 'dairy-free', 'halal', 'kosher', 'spicy', 'contains-alcohol'], note: 'Labels are only ever what the business declares.',
  })),
  builder: () => read(() => builder),
  createMenu: (name, kind = 'standard') => write(() => { const m = { id: id('menu'), name, kind, status: 'draft', description: null, dayPartIds: [], publishedAt: null, categories: [], items: [], publications: [] }; builder.menus.push(m); return { id: m.id }; }),
  createItem: (menuId, body) => write(() => { const m = builder.menus.find((x) => x.id === menuId)!; const it = item({ id: id('mi'), menuId, name: String(body.name), category: String(body.category ?? 'Other'), categoryId: (body.categoryId as string) ?? null, prices: (body.prices as Record<string, number>) ?? {}, allergens: (body.allergens as string[]) ?? [], dietary: (body.dietary as string[]) ?? [], allergensDeclared: !!body.allergensDeclared, description: (body.description as string) ?? null }); m.items.push(it); return it; }),
  updateItem: (iid, patch) => write(() => { const it = findItem(iid)!; Object.assign(it, patch, patch.allergens ? { allergensDeclared: true } : {}); if (patch.categoryId) it.category = builder.menus.flatMap((m) => m.categories).find((c) => c.id === patch.categoryId)?.name ?? it.category; return it; }),
  archiveItem: (iid) => write(() => { findItem(iid)!.active = false; }),
  createCategory: (menuId, body) => write(() => { const m = builder.menus.find((x) => x.id === menuId)!; const c = { id: id('cat'), menuId, name: body.name, description: null, translations: {}, dayPartIds: body.dayPartIds ?? [], sortOrder: m.categories.length + 1, active: true }; m.categories.push(c); return c; }),
  updateCategory: (cid, patch) => write(() => { const c = builder.menus.flatMap((m) => m.categories).find((x) => x.id === cid)!; Object.assign(c, patch); return c; }),
  addModifierGroup: (itemId, body) => write(() => { const g = { id: id('mg'), name: body.name, minSelect: body.minSelect, maxSelect: body.maxSelect, translations: {}, modifiers: body.modifiers.map((m, i) => ({ id: id('mod'), name: m.name, prices: m.prices, allergens: m.allergens ?? [], available: true, translations: {}, sortOrder: i })) }; findItem(itemId)!.modifierGroups.push(g); return g; }),
  updateModifierGroup: (gid, patch) => write(() => { const g = builder.menus.flatMap((m) => m.items).flatMap((i) => i.modifierGroups).find((x) => x.id === gid)!; Object.assign(g, patch); }),
  deleteModifierGroup: (gid) => write(() => { for (const it of builder.menus.flatMap((m) => m.items)) it.modifierGroups = it.modifierGroups.filter((g) => g.id !== gid); }),
  addModifier: (gid, body) => write(() => { const g = builder.menus.flatMap((m) => m.items).flatMap((i) => i.modifierGroups).find((x) => x.id === gid)!; const m = { id: id('mod'), name: body.name, prices: body.prices, allergens: body.allergens ?? [], available: true, translations: {}, sortOrder: g.modifiers.length }; g.modifiers.push(m); return m; }),
  deleteModifier: (mid) => write(() => { for (const g of builder.menus.flatMap((m) => m.items).flatMap((i) => i.modifierGroups)) { if (g.modifiers.some((m) => m.id === mid) && g.modifiers.length - 1 < g.minSelect) throw conflict('group_needs_options', `"${g.name}" requires at least ${g.minSelect} option(s)`); g.modifiers = g.modifiers.filter((m) => m.id !== mid); } }),
  createDayPart: (body) => write(() => { const d = { id: id('dp'), translations: {}, active: true, ...body }; dayParts.push(d); return d; }),
  updateDayPart: (did, patch) => write(() => { const d = dayParts.find((x) => x.id === did)!; Object.assign(d, patch); return d; }),
  deleteDayPart: (did) => write(() => { const i = dayParts.findIndex((x) => x.id === did); if (i >= 0) dayParts.splice(i, 1); }),
  publishPreview: (menuId) => read(() => {
    const m = builder.menus.find((x) => x.id === menuId)!;
    return { menu: { id: m.id, name: m.name, kind: m.kind, status: m.status, activeItems: m.items.filter((i) => i.active).length }, locations: builder.locations.map((l) => {
      const priced = m.items.filter((i) => i.active && i.prices[l.currency] !== undefined);
      const wouldBe = !priced.length ? 'failed' as const : priced.length < m.items.filter((i) => i.active).length ? 'partial' as const : 'succeeded' as const;
      const last = m.publications.find((p) => p.locationId === l.id);
      return { locationId: l.id, name: l.name, currency: l.currency, status: l.status, wouldBe, sellable: priced.length, available: priced.length, unavailable: m.items.filter((i) => i.active && i.prices[l.currency] === undefined).map((i) => ({ id: i.id, name: i.name, reason: `No price set in ${l.currency}` })), reason: wouldBe === 'failed' ? `No item has a price in ${l.currency}` : null, lastPublish: last ? { status: last.status, at: last.publishedAt } : null };
    }) };
  }),
  publish: async (menuId, locationIds) => {
    const pv = await mockFoodsApi.publishPreview(menuId);
    await sleep(400);
    const m = builder.menus.find((x) => x.id === menuId)!;
    m.status = 'published'; m.publishedAt = now();
    const res = pv.locations.map((l) => ({ locationId: l.locationId, name: l.name, currency: l.currency, status: locationIds && !locationIds.includes(l.locationId) ? 'skipped' as const : l.wouldBe, available: l.available, unavailable: l.unavailable, reason: l.reason }));
    m.publications = res.map((r) => ({ menuId, locationId: r.locationId, status: r.status, publishedAt: now(), detail: { available: r.available, unavailable: r.unavailable, reason: r.reason ?? undefined } }));
    return { locations: res, summary: { succeeded: res.filter((r) => r.status === 'succeeded').length, partial: res.filter((r) => r.status === 'partial').length, failed: res.filter((r) => r.status === 'failed').length, skipped: res.filter((r) => r.status === 'skipped').length } };
  },
  retryPublish: (menuId) => mockFoodsApi.publish(menuId),

  locationMenu: (lid) => read(() => ({ location: { id: lid, currency: L(lid).currency }, items: effective(lid) })),
  setItemSoldOut: (lid, iid, so, untilClose) => write(() => { if (so) soldOut.set(`${lid}:${iid}`, untilClose ? closeAt(lid) : null); else soldOut.delete(`${lid}:${iid}`); }),
  setModifierSoldOut: (lid, mid, so, untilClose) => write(() => { if (so) soldOut.set(`${lid}:${mid}`, untilClose ? closeAt(lid) : null); else soldOut.delete(`${lid}:${mid}`); }),
  settings: () => read(() => settings),
  saveSettings: (lid, body) => write(() => { const s = settings.find((x) => x.locationId === lid)!; const { taxRateBps, ...cfg } = body; if (taxRateBps !== undefined) s.taxRateBps = taxRateBps; s.config = { ...s.config, ...cfg, channels: { ...s.config.channels, ...(cfg.channels ?? {}) }, tips: { ...s.config.tips, ...(cfg.tips ?? {}) }, serviceCharge: { ...s.config.serviceCharge, ...(cfg.serviceCharge ?? {}) }, delivery: { ...s.config.delivery, ...(cfg.delivery ?? {}) }, kds: { ...s.config.kds, ...(cfg.kds ?? {}) } }; }),

  kds: (lid, stationId) => read(() => {
    ensureTickets();
    const l = L(lid);
    const st = stations.filter((s) => s.locationId === lid);
    const mine = orders.filter((o) => o.locationId === lid && ['awaiting_acceptance', 'accepted', 'preparing', 'ready'].includes(o.status));
    const station = stationId ? st.find((s) => s.id === stationId) ?? null : null;
    const nowMs = Date.now();
    const tks = tickets.filter((t) => mine.some((o) => o.id === t.orderId)).map((t) => { const o = mine.find((x) => x.id === t.orderId)!; const over = Math.floor((nowMs - Date.parse(t.targetAt)) / 60000); return { ...t, orderStatus: o.status, overdue: t.status !== 'done' && over > 0, overdueMinutes: t.status !== 'done' ? Math.max(0, over) : 0 }; });
    return {
      location: { id: l.id, name: l.name, timeZone: l.timeZone }, refreshedAt: now(), audibleDefault: true, view: station && !station.isExpo ? 'station' as const : 'expo' as const,
      stations: st.map((s) => ({ id: s.id, key: s.key, name: s.name, prepTargetMinutes: s.prepTargetMinutes, isExpo: s.isExpo, open: tks.filter((t) => t.stationId === s.id && t.status !== 'done').length })),
      station: station ? { id: station.id, name: station.name, key: station.key } : null,
      tickets: station && !station.isExpo ? tks.filter((t) => t.stationId === station.id && ['accepted', 'preparing', 'ready'].includes(t.orderStatus)) : [],
      orders: station && !station.isExpo ? [] : mine.map((o) => { const ts = tks.filter((t) => t.orderId === o.id); const over = o.promisedAt ? Math.floor((nowMs - Date.parse(o.promisedAt)) / 60000) : 0; return { id: o.id, orderNumber: o.orderNumber, firstName: o.contact.name, channel: o.channel, tableLabel: o.fulfilment.tableLabel ?? null, status: o.status, promisedAt: o.promisedAt, createdAt: o.createdAt, notes: o.notes, lines: o.lineDetail.map((d) => ({ name: d.name, quantity: d.quantity, modifiers: d.modifiers })), stations: ts.map((t) => ({ ticketId: t.id, stationId: t.stationId, name: t.stationName, status: t.status })), allStationsDone: ts.length > 0 && ts.every((t) => t.status === 'done'), overdue: ['accepted', 'preparing'].includes(o.status) && over > 0, overdueMinutes: Math.max(0, over) }; }),
    };
  }, 200),
  ticket: (tid, action, expected) => write(() => {
    const t = tickets.find((x) => x.id === tid)!;
    if (expected && expected !== t.status) throw conflict('stale_status', `Ticket is now ${t.status.replace('_', ' ')}. Refresh and try again.`);
    const o = orders.find((x) => x.id === t.orderId)!;
    if (action === 'recall') { if (!['accepted', 'preparing'].includes(o.status)) throw conflict('order_already_ready', `Order is ${o.status}; it can no longer be recalled`); t.status = 'in_progress'; t.bumpedAt = null; t.recalledCount++; }
    else if (action === 'start') t.status = 'in_progress';
    else { t.status = 'done'; t.bumpedAt = now(); }
    if (action !== 'recall' && o.status === 'accepted') o.status = 'preparing';
    const all = tickets.filter((x) => x.orderId === o.id);
    return { ticket: { id: t.id, status: t.status }, orderStatus: o.status, allStationsDone: all.every((x) => x.status === 'done') };
  }, 350),
  transition: (oid, to, opts) => write(() => {
    const o = orders.find((x) => x.id === oid);
    if (!o) throw new ApiError('not_found', 'Order not found', 404);
    if (opts?.expectedFrom && opts.expectedFrom !== o.status) throw conflict('stale_status', `Order is now ${o.status}. Refresh and try again.`);
    const okNext = NEXT[o.status] === to || (o.status === 'ready' && to === (o.channel === 'delivery' ? 'out_for_delivery' : o.channel === 'dine_in' ? 'served' : 'collected')) || (o.status === 'out_for_delivery' && to === 'delivered') || (['awaiting_acceptance', 'accepted', 'preparing'].includes(o.status) && (to === 'cancelled' || (to === 'rejected' && o.status === 'awaiting_acceptance')));
    if (!okNext) throw conflict('invalid_transition', `Cannot move a ${o.channel.replace('_', '-')} order from ${o.status} to ${to}`);
    o.status = to;
    return { order: { id: o.id, status: o.status } };
  }),
  stations: (lid) => read(() => stations.filter((s) => s.locationId === lid)),
  createStation: (lid, body) => write(() => { if (stations.some((s) => s.locationId === lid && s.key === body.key)) throw conflict('duplicate', 'A station with this key already exists here'); const s = { id: id('st'), locationId: lid, sortOrder: 5, active: true, isExpo: false, ...body }; stations.push(s); return s; }),
  updateStation: (sid, patch) => write(() => { const s = stations.find((x) => x.id === sid)!; Object.assign(s, patch); return s; }),
  defaultStations: (lid) => read(() => stations.filter((s) => s.locationId === lid)),

  orders: (p) => read(() => orders.filter((o) => (!p.locationId || o.locationId === p.locationId) && (!p.channel || o.channel === p.channel) && (!p.status || o.status === p.status) && (p.active === false || ['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'out_for_delivery'].includes(o.status))).map(({ lineDetail: _l, notes: _n, ...o }) => o)),
  zones: (lid) => read(() => ({ items: zones.filter((z) => z.locationId === lid), geocoding: 'disabled', location: { geo: lid === 'kr' ? null : { lat: 47.67, lng: -122.38 } } })),
  createZone: (lid, body) => write(() => { const cur = L(lid).currency; const z: DeliveryZone = { id: id('z'), locationId: lid, name: String(body.name), kind: body.kind as 'radius', radiusMeters: (body.radiusMeters as number) ?? null, postcodes: (body.postcodes as string[]) ?? [], fee: money(Number(body.feeMinor ?? 0), cur), minimumOrder: money(Number(body.minimumOrderMinor ?? 0), cur), freeDeliveryAbove: body.freeDeliveryAboveMinor ? money(Number(body.freeDeliveryAboveMinor), cur) : null, active: true, sortOrder: zones.length + 1 }; zones.push(z); return z; }),
  updateZone: (zid, patch) => write(() => { const z = zones.find((x) => x.id === zid)!; if (patch.active !== undefined) z.active = !!patch.active; return z; }),
  deleteZone: (zid) => write(() => { const i = zones.findIndex((x) => x.id === zid); if (i >= 0) zones.splice(i, 1); }),
  drivers: (lid) => read(() => drivers.filter((d) => d.locationId === lid)),
  createDriver: (lid, body) => write(() => { const d = { id: id('dr'), locationId: lid, userId: null, name: body.name, phone: body.phone ?? null, active: true }; drivers.push(d); return d; }),
  deliveries: (lid) => read(() => deliveries.filter((d) => (!lid || d.locationId === lid) && ['pending', 'assigned', 'picked_up'].includes(d.status))),
  dispatch: (oid, provider, driverId) => write(() => {
    const o = orders.find((x) => x.id === oid)!;
    if (deliveries.some((d) => d.orderId === oid && !['cancelled', 'failed'].includes(d.status))) throw conflict('already_dispatched', 'This order already has an active delivery');
    const dr = drivers.find((d) => d.id === driverId);
    deliveries.push({ id: id('del'), orderId: oid, locationId: o.locationId, provider, status: provider === 'own' ? 'assigned' : 'pending', externalId: provider === 'own' ? null : `del_sandbox_${id('x')}`, trackingUrl: provider === 'own' ? null : 'https://sandbox.branchharbor.com/track', sandbox: provider !== 'own', feeQuote: provider === 'own' ? null : money(599, o.total.currency), driver: dr ? { id: dr.id, name: dr.name, phone: dr.phone } : null, events: [{ at: now(), status: provider === 'own' ? 'assigned' : 'pending', by: null }], updatedAt: now(), order: { id: o.id, orderNumber: o.orderNumber, status: o.status, promisedAt: o.promisedAt, address: o.fulfilment.address ? { line1: '—', ...o.fulfilment.address } : null, zoneName: o.fulfilment.zoneName ?? null, customerFirstName: o.contact.name, total: o.total } });
  }),
  deliveryStatus: (did, status) => write(() => {
    const d = deliveries.find((x) => x.id === did)!;
    const o = orders.find((x) => x.id === d.orderId)!;
    if (status === 'picked_up') { if (o.status !== 'ready') throw conflict('order_not_ready', 'Mark the order ready before the driver picks it up'); o.status = 'out_for_delivery'; }
    if (status === 'delivered') o.status = 'delivered';
    d.status = status; d.order.status = o.status; d.updatedAt = now(); d.events.push({ at: now(), status, by: null });
  }),
  sandboxAdvance: (did) => mockFoodsApi.deliveryStatus(did, ((d) => (d.status === 'pending' || d.status === 'assigned' ? 'picked_up' : 'delivered'))(deliveries.find((x) => x.id === did)!)),
  providers: () => read(() => [{ key: 'own', name: 'Own drivers', mode: 'live' }, { key: 'uber_direct', name: 'Uber Direct', mode: 'sandbox' }, { key: 'deliverect', name: 'Deliverect', mode: 'sandbox' }]),

  tables: (lid) => read(() => tables.filter((t) => t.locationId === lid)),
  createTable: (lid, body) => write(() => { if (tables.some((t) => t.locationId === lid && t.label === body.label)) throw conflict('duplicate', 'A table with this label already exists here'); const t = { id: id('tb'), locationId: lid, label: body.label, seats: body.seats, area: body.area ?? null, active: true, openTabId: null, code: `${L(lid).code.replace('-', '')}${tables.length + 1}` }; tables.push(t); return t; }),
  updateTable: (tid, patch) => write(() => { const t = tables.find((x) => x.id === tid)!; if (patch.active !== undefined) t.active = patch.active; if (patch.seats) t.seats = patch.seats; if (patch.regenerateCode) t.code = Math.random().toString(36).slice(2, 8).toUpperCase(); return t; }),
  tabs: (lid) => read(() => tabs.filter((t) => t.locationId === lid && t.status === 'open')),
  closeTab: (tid, how) => write(() => { const t = tabs.find((x) => x.id === tid)!; if (how === 'void' && t.orders.length) throw conflict('tab_not_empty', 'Cancel the orders on this tab before voiding it'); t.status = how === 'void' ? 'void' : 'paid'; t.paidVia = how === 'counter' ? 'counter' : null; t.closedAt = now(); const tb = tables.find((x) => x.id === t.tableId); if (tb) tb.openTabId = null; return t; }),

  productionDates: (lid) => read(() => ({ timeZone: L(lid).timeZone, items: prodDates.filter((d) => d.locationId === lid) })),
  createProductionDate: (lid, body) => write(() => { if (prodDates.some((d) => d.locationId === lid && d.date === body.date)) throw conflict('duplicate', 'This date is already open for preorders'); const d = { id: id('pd'), locationId: lid, date: body.date, cutoffAt: at(L(lid).timeZone, body.cutoffTime, -body.cutoffDaysBefore), collectionWindows: body.collectionWindows, capacity: body.capacity, booked: 0, remaining: body.capacity, status: 'open', note: body.note ?? null, cutoffPassed: false, menuId: 'menu_pre' }; prodDates.push(d); return d; }),
  updateProductionDate: (pid, patch) => write(() => { const d = prodDates.find((x) => x.id === pid)!; Object.assign(d, patch); return d; }),
  production: (lid, date) => read(() => ({
    location: { id: lid, name: L(lid).name, timeZone: L(lid).timeZone }, date: date ?? today(L(lid).timeZone), generatedAt: now(),
    counts: { orders: 7, byChannel: { pickup: 4, delivery: 2, preorder: 1 }, cateringEvents: 1, guests: 18, mealPlanBoxes: 3 },
    stations: [{ key: 'grill', name: 'Grill', items: [{ name: 'Ember chicken bowl', quantity: 23, modifiers: [{ name: 'Regular', quantity: 15 }, { name: 'Large', quantity: 8 }] }, { name: 'Smoked brisket sandwich', quantity: 9, modifiers: [{ name: 'Fried egg', quantity: 3 }] }] }, { key: 'cold', name: 'Cold', items: [{ name: 'Charred veg grain bowl', quantity: 12, modifiers: [] }, { name: 'Burnt honey tart', quantity: 4, modifiers: [] }] }, { key: 'bar', name: 'Bar', items: [{ name: 'Maple lemonade', quantity: 6, modifiers: [] }] }],
    catering: enquiries.filter((e) => e.locationId === lid && e.status === 'confirmed').map((e) => ({ id: e.id, reference: e.reference, guests: e.guests, eventTime: e.eventTime, status: e.status, fulfilment: e.fulfilment, dietaryNotes: e.dietaryNotes })),
  })),
  packages: () => read(() => packages),
  createPackage: (body) => write(() => { const p = { id: id('pk'), name: String(body.name), description: (body.description as string) ?? null, pricesPerGuest: (body.pricesPerGuest as Record<string, number>) ?? {}, minGuests: Number(body.minGuests ?? 10), maxGuests: null, leadDays: Number(body.leadDays ?? 3), includes: (body.includes as string[]) ?? [], dietary: [], allergens: [], allergensDeclared: false, locationIds: [], active: true }; packages.push(p); return p; }),
  enquiries: (p = {}) => read(() => enquiries.filter((e) => (!p.locationId || e.locationId === p.locationId) && (!p.status || p.status.split(',').includes(e.status)))),
  enquiry: (eid) => read(() => enquiries.find((e) => e.id === eid)!),
  quote: (eid, body) => write(() => {
    const e = enquiries.find((x) => x.id === eid)!;
    if (!['new', 'quoted', 'expired'].includes(e.status)) throw conflict('invalid_state', `A ${e.status.replace('_', ' ')} enquiry cannot be re-quoted`);
    const cur = L(e.locationId).currency;
    const pkg = packages.find((p) => p.id === e.packageId);
    const lines = [...(body.fromPackage && pkg ? [{ description: `${pkg.name} — per guest`, quantity: e.guests, unitPriceMinor: pkg.pricesPerGuest[cur] ?? 0 }] : []), ...(body.lines ?? [])];
    const sub = lines.reduce((a, l) => a + l.quantity * l.unitPriceMinor, 0);
    const total = sub + (body.deliveryFeeMinor ?? 0);
    e.quote = { version: (e.quote?.version ?? 0) + 1, lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: money(l.unitPriceMinor, cur), total: money(l.quantity * l.unitPriceMinor, cur) })), subtotal: money(sub, cur), serviceCharge: null, deliveryFee: body.deliveryFeeMinor ? money(body.deliveryFeeMinor, cur) : null, tax: null, taxRateBps: null, total: money(total, cur), deposit: money(Math.round((total * (body.depositBps ?? 2500)) / 10000), cur), validUntil: inMin((body.validDays ?? 7) * 1440), terms: body.terms ?? null, sentAt: now() };
    e.status = 'quoted'; e.statusHistory.push({ at: now(), from: 'new', to: 'quoted' });
    return e;
  }),
  enquiryStatus: (eid, to, note) => write(() => {
    const e = enquiries.find((x) => x.id === eid)!;
    if (to === 'confirmed' && e.status === 'accepted') throw conflict('deposit_pending', 'The deposit has not been paid yet');
    if ((to === 'declined' || to === 'cancelled') && !note) throw new ApiError('validation_failed', 'A reason is required', 400, { note: 'Required' });
    e.statusHistory.push({ at: now(), from: e.status, to, note }); e.status = to; if (to === 'confirmed') e.confirmedAt = now(); if (note) e.declinedReason = note;
    return e;
  }),

  mealPlans: () => read(() => plans),
  createMealPlan: (body) => write(() => { const p = { id: id('mp'), description: null, mealsPerBox: 5, pricesPerWeek: {}, fulfilment: 'pickup' as const, fulfilmentWeekday: 1, cutoffDaysBefore: 3, cutoffTime: '18:00', menuItemIds: [], locationIds: [], active: true, ...(body as Partial<MealPlan>), name: String(body.name) }; plans.push(p); return p; }),
  updateMealPlan: (pid, patch) => write(() => { const p = plans.find((x) => x.id === pid)!; Object.assign(p, patch); return p; }),
  subscriptions: (p = {}) => read(() => subs.filter((s) => (!p.locationId || s.locationId === p.locationId) && (!p.status || p.status.split(',').includes(s.status)))),
  skipWeek: (sid, week, skip) => write(() => {
    const s = subs.find((x) => x.id === sid)!;
    const w = s.upcoming.find((u) => u.weekStart === week);
    if (!w || !w.canChange) throw new ApiError('skip_cutoff_passed', `Changes for the week of ${week} closed at the cut-off`, 409);
    s.skippedWeeks = skip ? [...new Set([...s.skippedWeeks, week])] : s.skippedWeeks.filter((x) => x !== week);
    w.skipped = skip;
    return s;
  }),
  generateBoxes: () => write(() => ({ created: subs.filter((s) => s.status === 'active').length, skipped: subs.filter((s) => s.skippedWeeks.length).length })),
  releaseBoxes: () => write(() => ({ released: 2 })),

  ingredients: (lid) => read(() => ingredients.get(lid) ?? []),
  createIngredient: (body) => write(() => { const g: Ingredient = { id: id('ing'), name: body.name, unit: body.unit, sku: body.sku ?? null, stock: null, usedBy: [] }; for (const list of ingredients.values()) list.push(clone(g)); return g; }),
  setStock: (lid, iid, body) => write(() => { const g = ingredients.get(lid)!.find((x) => x.id === iid)!; g.stock = { onHand: g.stock?.onHand ?? 0, lowStockThreshold: body.lowStockThreshold ?? g.stock?.lowStockThreshold ?? 0, autoSoldOut: body.autoSoldOut ?? g.stock?.autoSoldOut ?? false, lowStock: false, exhausted: false, updatedAt: now() }; g.stock.lowStock = g.stock.onHand <= g.stock.lowStockThreshold; }),
  movement: (lid, iid, body) => write(() => {
    const g = ingredients.get(lid)!.find((x) => x.id === iid)!;
    const cur = g.stock?.onHand ?? 0;
    const onHand = body.reason === 'receive' ? cur + body.quantity : body.reason === 'waste' ? cur - body.quantity : body.quantity;
    const portion = Math.max(0, ...g.usedBy.filter((u) => !u.viaModifier).map((u) => u.quantity));
    g.stock = { onHand, lowStockThreshold: g.stock?.lowStockThreshold ?? 0, autoSoldOut: g.stock?.autoSoldOut ?? false, lowStock: onHand <= (g.stock?.lowStockThreshold ?? 0), exhausted: portion > 0 && onHand < portion, updatedAt: now() };
    return { onHand, soldOutItems: g.stock.exhausted && g.stock.autoSoldOut ? g.usedBy.map((u) => u.menuItemId) : [] };
  }),
  movements: () => read(() => [{ id: 'mv1', delta: 24, reason: 'receive', balanceAfter: 30, note: 'Produce delivery', createdAt: minutesAgo(3000), orderId: null }, { id: 'mv2', delta: -2, reason: 'order', balanceAfter: 28, note: null, createdAt: minutesAgo(200), orderId: 'o1' }]),
  recipe: (iid) => read(() => [...ingredients.values()][0]!.filter((g) => g.usedBy.some((u) => u.menuItemId === iid)).map((g) => ({ ingredientId: g.id, name: g.name, unit: g.unit, quantity: g.usedBy.find((u) => u.menuItemId === iid)!.quantity, modifierId: null }))),
  saveRecipe: (iid, lines) => write(() => { for (const list of ingredients.values()) for (const g of list) { g.usedBy = g.usedBy.filter((u) => u.menuItemId !== iid); const ln = lines.find((l) => l.ingredientId === g.id); if (ln) g.usedBy.push({ menuItemId: iid, name: findItem(iid)?.name ?? 'Item', quantity: ln.quantity, viaModifier: !!ln.modifierId }); } }),

  reports: () => read(() => ({
    range: { from: inMin(-30 * 1440), to: now() }, generatedAt: now(), empty: false, combinedRevenue: null, combinedRevenueReason: 'Amounts in different currencies are never added together; no conversion method is defined.',
    ordersByChannel: [{ channel: 'pickup', orders: 182, cancelledOrRejected: 6, revenue: [money(412900, 'USD'), money(98400, 'CAD'), money(51200, 'GBP')] }, { channel: 'delivery', orders: 74, cancelledOrRejected: 2, revenue: [money(231500, 'USD'), money(30100, 'GBP')] }, { channel: 'dine_in', orders: 121, cancelledOrRejected: 1, revenue: [money(190200, 'USD'), money(122000, 'CAD'), money(67700, 'GBP')] }, { channel: 'preorder', orders: 9, cancelledOrRejected: 0, revenue: [money(88500, 'USD')] }],
    revenueByCurrency: [['USD', 923100, 286], ['CAD', 220400, 97], ['GBP', 149000, 132]].map(([c, g, k]) => ({ currency: c as string, orders: k as number, gross: money(g as number, c as string), tax: money(c === 'USD' ? Math.round((g as number) * 0.094) : 0, c as string), tips: money(Math.round((g as number) * 0.06), c as string), deliveryFees: money(c === 'CAD' ? 0 : 22000, c as string), serviceCharges: money(c === 'GBP' ? 7800 : 0, c as string), averageOrder: money(Math.round((g as number) / (k as number)), c as string) })),
    prepTimes: { definition: 'Minutes from acceptance to ready (server-acknowledged status changes).', locations: live.map((l, i) => ({ locationId: l.id, name: l.name, orders: 60 + i * 9, medianMinutes: 14 + i, p90Minutes: 22 + i, onTimeRate: 0.94 - i * 0.02 })), stations: [{ stationId: 'st_bl_grill', name: 'Grill', targetMinutes: 14, tickets: 210, medianMinutes: 12, overTarget: 18 }, { stationId: 'st_bl_cold', name: 'Cold', targetMinutes: 8, tickets: 160, medianMinutes: 6, overTarget: 4 }, { stationId: 'st_bl_bar', name: 'Bar', targetMinutes: 4, tickets: 190, medianMinutes: 3, overTarget: 2 }], stationsUnavailableReason: null },
    soldOut: [{ id: 'mi_pizza', name: 'Margherita, wood-fired', kind: 'item', times: 4, minutesSoldOut: 640, sources: ['manual'], locations: 2 }, { id: 'mi_tart', name: 'Burnt honey tart', kind: 'item', times: 2, minutesSoldOut: 300, sources: ['ingredient'], locations: 1 }, { id: 'mod_large', name: 'Large', kind: 'modifier', times: 1, minutesSoldOut: 240, sources: ['manual'], locations: 1 }],
    catering: { definition: 'Catering enquiries created in the period by current status; value = latest quote total per currency.', stages: ['new', 'quoted', 'accepted', 'deposit_paid', 'confirmed', 'completed', 'declined', 'cancelled', 'expired'].map((s) => ({ status: s, count: enquiries.filter((e) => e.status === s).length, value: enquiries.filter((e) => e.status === s && e.quote).map((e) => e.quote!.total) })), conversionRate: 0.33 },
    mealPlans: [{ currency: 'USD', active: 3, paused: 0, cancelled: 1, weeklyRecurring: money(26700, 'USD') }, { currency: 'GBP', active: 1, paused: 1, cancelled: 0, weeklyRecurring: money(5500, 'GBP') }],
  })),
  aiMenuCopy: () => read(() => { throw new ApiError('ai_unavailable', 'BranchHarbor AI is not available in sample mode. Everything else keeps working.', 503); }),
  aiProductionSummary: () => read(() => { throw new ApiError('ai_unavailable', 'BranchHarbor AI is not available in sample mode. Everything else keeps working.', 503); }),
};
