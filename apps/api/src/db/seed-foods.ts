/**
 * Foods demo data (sample data only) for Maple & Ember Restaurants: richer menu with categories,
 * day-parts, business-supplied allergens and translations; London (GBP) and Lisbon (EUR) locations next
 * to Seattle (USD) and Vancouver (CAD); delivery zones, tables/QR codes and tabs, KDS stations, drivers,
 * preorder dates, catering packages and enquiries, meal plans and subscriptions, ingredients and
 * recipes, order history across channels and two payment recovery cases.
 * Called by seed.ts after the Maple & Ember organisation exists. Re-running seed.ts replaces it all.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { configOf, syncPickupSlots } from '../services/pickup.ts';
import { DEFAULT_STATIONS } from '../services/foods-kitchen.ts';
import { DEFAULT_FOOD_CONFIG, mergeFoodConfig } from '../services/foods-menu.ts';
import { fulfilmentDateOf, mondayOf } from '../services/foods-mealplans.ts';

type User = typeof t.users.$inferSelect;
type Loc = typeof t.locations.$inferSelect;
export interface FoodsSeedCtx { db: Db; today: string; meId: string; demo: User; carlos: User; upsertUser: (email: string, name: string, locale?: string) => Promise<User> }

const pi = () => `pi_seed_${randomBytes(8).toString('hex')}`;
const token = (s: string) => sha256(`seed-${s}`);
const H = 3600_000;
const all = (open: string, close: string) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open, close }));

export async function seedFoods(c: FoodsSeedCtx) {
  const { db, meId } = c;
  const [org] = await db.select().from(t.organizations).where(eq(t.organizations.id, meId));
  const [europe] = await db.insert(t.regions).values({ organizationId: meId, name: 'Europe' }).returning();
  const [northAmerica] = await db.insert(t.regions).values({ organizationId: meId, name: 'North America' }).returning();
  const [lisbonGroup] = await db.insert(t.ownerGroups).values({ organizationId: meId, name: 'Brasa Lisboa Lda', legalName: 'Brasa Lisboa, Lda.' }).returning();
  await db.update(t.locations).set({ regionId: northAmerica!.id }).where(eq(t.locations.organizationId, meId));
  const [london, lisbon] = await db.insert(t.locations).values([
    { organizationId: meId, regionId: europe!.id, name: 'Spitalfields', code: 'LON-SP', slug: 'spitalfields', address: { line1: '12 Brushfield St', city: 'London', postalCode: 'E1 6AN', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', phone: '+44 20 7946 0188', status: 'operating', publiclyVisible: true, paymentsEnabled: true, hours: { summary: 'Daily 8am–10pm' }, geo: { lat: 51.5196, lng: -0.075 } },
    { organizationId: meId, regionId: europe!.id, ownerGroupId: lisbonGroup!.id, name: 'Príncipe Real', code: 'LIS-PR', slug: 'principe-real', address: { line1: 'Rua da Escola Politécnica 42', city: 'Lisboa', postalCode: '1250-102', country: 'PT' }, country: 'PT', timeZone: 'Europe/Lisbon', currency: 'EUR', locale: 'pt-PT', phone: '+351 21 555 0142', status: 'operating', publiclyVisible: true, paymentsEnabled: true, hours: { summary: 'Todos os dias 8h–23h' }, geo: { lat: 38.7166, lng: -9.1489 } },
  ]).returning();
  const coords: Record<string, { lat: number; lng: number }> = { 'SEA-BL': { lat: 47.6687, lng: -122.3843 }, 'SEA-FR': { lat: 47.651, lng: -122.35 }, 'YVR-GT': { lat: 49.2838, lng: -123.1065 } };
  for (const [code, geo] of Object.entries(coords)) await db.update(t.locations).set({ geo }).where(and(eq(t.locations.organizationId, meId), eq(t.locations.code, code)));
  await db.update(t.subscriptions).set({ billedLocationCount: 5 }).where(eq(t.subscriptions.organizationId, meId));
  const locs = (await db.select().from(t.locations).where(eq(t.locations.organizationId, meId))).filter((l) => l.status === 'operating');
  const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<'SEA-BL' | 'SEA-FR' | 'YVR-GT' | 'LON-SP' | 'LIS-PR', Loc>;

  // London & Lisbon staff.
  const amelia = await c.upsertUser('amelia.hart@demo.branchharbor.com', 'Amelia Hart', 'en-GB');
  const tiago = await c.upsertUser('tiago.santos@demo.branchharbor.com', 'Tiago Santos', 'pt-BR');
  const dee = await c.upsertUser('dee.walker@demo.branchharbor.com', 'Dee Walker');
  await db.insert(t.roleAssignments).values([
    { organizationId: meId, userId: amelia.id, role: 'location_manager', scopeKind: 'location', scopeId: london!.id },
    { organizationId: meId, userId: tiago.id, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: lisbonGroup!.id },
    { organizationId: meId, userId: dee.id, role: 'staff', scopeKind: 'location', scopeId: L['SEA-BL'].id },
  ]).onConflictDoNothing();

  // Pickup / kitchen hours for the new locations.
  for (const l of [london!, lisbon!]) {
    const cfg = { hours: all('08:00', '22:00'), slotMinutes: 15, slotCapacity: 6, prepBufferMinutes: 20, cutoffMinutes: 15, horizonDays: 3, closedDates: [], acceptingOrders: true };
    const [row] = await db.insert(t.pickupSettings).values({ organizationId: meId, locationId: l.id, ...cfg, updatedBy: c.demo.id }).returning();
    await syncPickupSlots(db, l, configOf(row!));
  }

  // ───────── Menu: categories, day-parts, allergens, translations ─────────
  const [breakfast, lunch, dinner] = await db.insert(t.foodDayParts).values([
    { organizationId: meId, name: 'Breakfast', translations: { fr: { name: 'Petit-déjeuner' }, pt: { name: 'Pequeno-almoço' } }, windows: all('07:00', '11:00').map((w) => ({ weekday: w.weekday, start: w.open, end: w.close })), sortOrder: 1 },
    { organizationId: meId, name: 'Lunch', translations: { fr: { name: 'Déjeuner' }, pt: { name: 'Almoço' } }, windows: all('11:00', '16:00').map((w) => ({ weekday: w.weekday, start: w.open, end: w.close })), sortOrder: 2 },
    { organizationId: meId, name: 'Dinner', translations: { fr: { name: 'Dîner' }, pt: { name: 'Jantar' } }, windows: all('16:00', '22:30').map((w) => ({ weekday: w.weekday, start: w.open, end: w.close })), sortOrder: 3 },
  ]).returning();
  void lunch;
  const [menu] = await db.select().from(t.menus).where(eq(t.menus.organizationId, meId));
  await db.update(t.menus).set({ description: 'Served all day across the network; breakfast until 11:00 local time.' }).where(eq(t.menus.id, menu!.id));
  const catDefs: Array<{ name: string; sortOrder: number; dayPartIds?: string[]; translations: Record<string, { name?: string }> }> = [
    { name: 'Breakfast', sortOrder: 1, dayPartIds: [breakfast!.id], translations: { fr: { name: 'Petit-déjeuner' }, pt: { name: 'Pequeno-almoço' } } },
    { name: 'Bowls', sortOrder: 2, translations: { fr: { name: 'Bols' }, pt: { name: 'Taças' } } },
    { name: 'Sandwiches', sortOrder: 3, translations: { fr: { name: 'Sandwichs' }, pt: { name: 'Sandes' } } },
    { name: 'Pizza', sortOrder: 4, dayPartIds: [dinner!.id], translations: { pt: { name: 'Pizza' } } },
    { name: 'Sides', sortOrder: 5, translations: { fr: { name: 'Accompagnements' }, pt: { name: 'Acompanhamentos' } } },
    { name: 'Desserts', sortOrder: 6, translations: { fr: { name: 'Desserts' }, pt: { name: 'Sobremesas' } } },
    { name: 'Drinks', sortOrder: 7, translations: { fr: { name: 'Boissons' }, pt: { name: 'Bebidas' } } },
  ];
  const cats = await db.insert(t.foodMenuCategories).values(catDefs.map((d) => ({ organizationId: meId, menuId: menu!.id, dayPartIds: [], ...d }))).returning();
  const cat = (n: string) => cats.find((x) => x.name === n)!;
  const existing = await db.select().from(t.menuItems).where(eq(t.menuItems.menuId, menu!.id));
  const ex = (n: string) => existing.find((i) => i.name === n)!;
  // Existing items: full prices, categories, stations, declared allergens and translations (all business-supplied sample data).
  const upd: Array<[string, Partial<typeof t.menuItems.$inferInsert>]> = [
    ['Ember chicken bowl', { prices: { USD: 1600, CAD: 2100, GBP: 1250, EUR: 1350 }, categoryId: cat('Bowls').id, stationKey: 'grill', prepMinutes: 12, allergens: [], allergensDeclared: true, translations: { fr: { name: 'Bol au poulet braisé', description: 'Riz, verdures, maïs grillé' }, pt: { name: 'Taça de frango na brasa', description: 'Arroz, verdes, milho grelhado' } } }],
    ['Smoked brisket sandwich', { prices: { USD: 1500, CAD: 1950, GBP: 1150, EUR: 1250 }, categoryId: cat('Sandwiches').id, stationKey: 'grill', prepMinutes: 10, allergens: ['cereals_gluten', 'wheat', 'eggs', 'mustard'], allergensDeclared: true, translations: { fr: { name: 'Sandwich à la poitrine fumée' }, pt: { name: 'Sande de peito fumado', description: 'Pickles, salada de couve, brioche' } } }],
    ['Margherita, wood-fired', { prices: { USD: 1800, CAD: 2350, GBP: 1300, EUR: 1100 }, categoryId: cat('Pizza').id, stationKey: 'grill', prepMinutes: 14, allergens: ['cereals_gluten', 'wheat', 'milk'], allergensDeclared: true, translations: { fr: { name: 'Margherita au feu de bois' }, pt: { name: 'Margherita em forno a lenha', description: '30 cm' } } }],
    ['Maple lemonade', { prices: { USD: 500, CAD: 650, GBP: 400, EUR: 400 }, categoryId: cat('Drinks').id, stationKey: 'bar', prepMinutes: 2, allergens: [], allergensDeclared: true, translations: { fr: { name: 'Limonade à l’érable' }, pt: { name: 'Limonada de ácer' } } }],
  ];
  for (const [name, patch] of upd) await db.update(t.menuItems).set(patch).where(eq(t.menuItems.id, ex(name).id));
  const newItems = await db.insert(t.menuItems).values([
    { organizationId: meId, menuId: menu!.id, category: 'Breakfast', categoryId: cat('Breakfast').id, name: 'Ember breakfast sandwich', description: 'Fried egg, cheddar, maple bacon on a brioche bun', prices: { USD: 1100, CAD: 1450, GBP: 850, EUR: 800 }, allergens: ['eggs', 'milk', 'cereals_gluten', 'wheat'], allergensDeclared: true, stationKey: 'grill', prepMinutes: 7, sortOrder: 1, translations: { fr: { name: 'Sandwich du matin Ember' }, pt: { name: 'Sande de pequeno-almoço Ember', description: 'Ovo estrelado, cheddar, bacon de ácer em brioche' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Breakfast', categoryId: cat('Breakfast').id, name: 'Maple granola bowl', description: 'Toasted oats, yoghurt, seasonal fruit', prices: { USD: 900, CAD: 1200, GBP: 700, EUR: 650 }, dietary: ['vegetarian'], allergens: ['milk', 'tree_nuts', 'cereals_gluten'], allergensDeclared: true, stationKey: 'cold', prepMinutes: 3, sortOrder: 2, translations: { pt: { name: 'Taça de granola com ácer', description: 'Aveia tostada, iogurte, fruta da época' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Bowls', categoryId: cat('Bowls').id, name: 'Charred veg grain bowl', description: 'Farro, charred squash, herbs, tahini', prices: { USD: 1450, CAD: 1900, GBP: 1150, EUR: 1200 }, dietary: ['vegan'], allergens: ['sesame', 'cereals_gluten', 'wheat'], allergensDeclared: true, stationKey: 'cold', prepMinutes: 6, sortOrder: 2, translations: { pt: { name: 'Taça de cereais com legumes grelhados' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Sides', categoryId: cat('Sides').id, name: 'House fries', description: 'Sea salt, rosemary', prices: { USD: 600, CAD: 750, GBP: 450, EUR: 450 }, dietary: ['vegan'], allergens: [], allergensDeclared: true, stationKey: 'grill', prepMinutes: 6, sortOrder: 1, translations: { pt: { name: 'Batatas fritas da casa' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Sides', categoryId: cat('Sides').id, name: 'Charred corn', description: 'Lime, chili butter', prices: { USD: 650, CAD: 850, GBP: 500, EUR: 500 }, dietary: ['vegetarian'], allergens: ['milk'], allergensDeclared: true, stationKey: 'grill', prepMinutes: 5, sortOrder: 2 },
    { organizationId: meId, menuId: menu!.id, category: 'Desserts', categoryId: cat('Desserts').id, name: 'Burnt honey tart', description: 'Crème fraîche', prices: { USD: 800, CAD: 1050, GBP: 650, EUR: 600 }, dietary: ['vegetarian'], allergens: ['milk', 'eggs', 'cereals_gluten', 'wheat'], allergensDeclared: true, stationKey: 'cold', prepMinutes: 2, sortOrder: 1, translations: { pt: { name: 'Tarte de mel queimado' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Drinks', categoryId: cat('Drinks').id, name: 'Cold brew', description: 'Single origin, 16 h steep', prices: { USD: 550, CAD: 700, GBP: 400, EUR: 350 }, allergens: [], allergensDeclared: false, stationKey: 'bar', prepMinutes: 2, sortOrder: 2, translations: { pt: { name: 'Café cold brew' } } },
    { organizationId: meId, menuId: menu!.id, category: 'Drinks', categoryId: cat('Drinks').id, name: 'Sparkling water', description: '500 ml', prices: { USD: 350, CAD: 450, GBP: 250, EUR: 250 }, dietary: ['vegan'], allergens: [], allergensDeclared: true, stationKey: 'bar', prepMinutes: 1, sortOrder: 3, translations: { pt: { name: 'Água com gás' } } },
  ]).returning();
  const item = (n: string) => [...existing, ...newItems].find((i) => i.name === n)!;
  // Modifier groups (required and optional with min/max).
  const grp = async (itemName: string, name: string, minSelect: number, maxSelect: number, mods: Array<{ name: string; prices: Record<string, number>; allergens?: string[] }>) => {
    const [g] = await db.insert(t.modifierGroups).values({ organizationId: meId, menuItemId: item(itemName).id, name, minSelect, maxSelect }).returning();
    return db.insert(t.modifiers).values(mods.map((m, i) => ({ organizationId: meId, groupId: g!.id, name: m.name, prices: m.prices, allergens: m.allergens ?? [], sortOrder: i }))).returning();
  };
  const zero = { USD: 0, CAD: 0, GBP: 0, EUR: 0 };
  await db.update(t.modifiers).set({ prices: { ...zero } }).where(sql`${t.modifiers.name} = 'Regular' and ${t.modifiers.organizationId} = ${meId}`);
  await db.update(t.modifiers).set({ prices: { USD: 300, CAD: 400, GBP: 250, EUR: 250 } }).where(sql`${t.modifiers.name} = 'Large' and ${t.modifiers.organizationId} = ${meId}`);
  await grp('Ember chicken bowl', 'Sauce', 1, 1, [{ name: 'Chimichurri', prices: zero }, { name: 'Smoked chili', prices: zero }, { name: 'Garlic yoghurt', prices: zero, allergens: ['milk'] }]);
  const addons = await grp('Smoked brisket sandwich', 'Add-ons', 0, 2, [{ name: 'Extra pickles', prices: { USD: 100, CAD: 150, GBP: 80, EUR: 80 } }, { name: 'Fried egg', prices: { USD: 200, CAD: 250, GBP: 150, EUR: 150 }, allergens: ['eggs'] }, { name: 'Smoked cheddar', prices: { USD: 200, CAD: 250, GBP: 150, EUR: 150 }, allergens: ['milk'] }]);
  await grp('Margherita, wood-fired', 'Crust', 1, 1, [{ name: 'Classic crust', prices: zero }, { name: 'Thin crust', prices: zero }]);
  const milk = await grp('Cold brew', 'Milk', 0, 1, [{ name: 'Whole milk', prices: zero, allergens: ['milk'] }, { name: 'Oat milk', prices: { USD: 75, CAD: 100, GBP: 50, EUR: 50 }, allergens: ['cereals_gluten'] }]);
  await grp('Ember breakfast sandwich', 'Make it', 0, 1, [{ name: 'No bacon', prices: zero }, { name: 'Add hash brown', prices: { USD: 250, CAD: 300, GBP: 200, EUR: 200 } }]);

  // Preorder menu (holiday cooking dates).
  const [pre] = await db.insert(t.menus).values({ organizationId: meId, name: 'Weekend preorders', kind: 'preorder', status: 'published', publishedAt: new Date(), description: 'Order by the cut-off, collect on the cooking date.' }).returning();
  const [preCat] = await db.insert(t.foodMenuCategories).values({ organizationId: meId, menuId: pre!.id, name: 'Feasts', sortOrder: 1 }).returning();
  const preItems = await db.insert(t.menuItems).values([
    { organizationId: meId, menuId: pre!.id, category: 'Feasts', categoryId: preCat!.id, name: 'Whole smoked brisket (serves 6)', description: '12-hour smoke, sauces and pickles', prices: { USD: 9500, CAD: 12500, GBP: 7500, EUR: 8000 }, allergens: ['mustard'], allergensDeclared: true, stationKey: 'grill', prepMinutes: 30 },
    { organizationId: meId, menuId: pre!.id, category: 'Feasts', categoryId: preCat!.id, name: 'Maple pecan pie (whole)', description: '23 cm, serves 8', prices: { USD: 3200, CAD: 4200, GBP: 2600, EUR: 2800 }, dietary: ['vegetarian'], allergens: ['tree_nuts', 'eggs', 'milk', 'cereals_gluten', 'wheat'], allergensDeclared: true, stationKey: 'cold', prepMinutes: 10 },
  ]).returning();

  // Publish results per location for both menus.
  for (const m of [menu!, pre!]) for (const l of locs) {
    await db.insert(t.foodMenuPublications).values({ organizationId: meId, menuId: m.id, locationId: l.id, status: 'succeeded', detail: { available: m.kind === 'preorder' ? 2 : 12, unavailable: [] }, publishedBy: c.demo.id, publishedAt: new Date(Date.now() - 2 * 86400_000) });
  }
  // The Margherita has a local price at Gastown (existing override) — keep it.

  // ───────── Location ordering settings ─────────
  const cfg = (o: Partial<typeof DEFAULT_FOOD_CONFIG>) => mergeFoodConfig({ ...DEFAULT_FOOD_CONFIG, ...o } as never);
  const deliveryHours = all('11:00', '21:30');
  const settingsByCode: Record<string, ReturnType<typeof cfg>> = {
    'SEA-BL': cfg({ channels: { pickup: true, delivery: true, dineIn: true, preorder: true, catering: true, mealPlans: true }, tips: { enabled: true, presetsBps: [1500, 1800, 2000], allowCustom: true, channels: ['pickup', 'delivery', 'dine_in'] }, delivery: { provider: 'own', hours: deliveryHours, slotMinutes: 30, slotCapacity: 4, leadMinutes: 45, cutoffMinutes: 30, horizonDays: 2 }, autoSoldOutOnIngredients: true }),
    'SEA-FR': cfg({ channels: { pickup: true, delivery: true, dineIn: false, preorder: false, catering: false, mealPlans: false }, tips: { enabled: true, presetsBps: [1500, 1800, 2000], allowCustom: true, channels: ['pickup', 'delivery'] }, delivery: { provider: 'uber_direct', hours: deliveryHours, slotMinutes: 30, slotCapacity: 6, leadMinutes: 40, cutoffMinutes: 30, horizonDays: 2 }, autoSoldOutOnIngredients: true }),
    'YVR-GT': cfg({ channels: { pickup: true, delivery: false, dineIn: true, preorder: false, catering: true, mealPlans: false }, tips: { enabled: true, presetsBps: [1500, 1800, 2000], allowCustom: true, channels: ['pickup', 'dine_in'] } }),
    'LON-SP': cfg({ channels: { pickup: true, delivery: true, dineIn: true, preorder: false, catering: true, mealPlans: true }, tips: { enabled: true, presetsBps: [1000, 1250], allowCustom: true, channels: ['dine_in'] }, serviceCharge: { bps: 1250, label: 'Service charge', channels: ['dine_in', 'catering'] }, delivery: { provider: 'own', hours: deliveryHours, slotMinutes: 30, slotCapacity: 5, leadMinutes: 40, cutoffMinutes: 30, horizonDays: 2 } }),
    'LIS-PR': cfg({ channels: { pickup: true, delivery: false, dineIn: true, preorder: true, catering: false, mealPlans: false }, tips: { enabled: true, presetsBps: [500, 1000], allowCustom: true, channels: ['dine_in'] } }),
  };
  for (const l of locs) await db.insert(t.foodLocationSettings).values({ organizationId: meId, locationId: l.id, config: settingsByCode[l.code]!, updatedBy: c.demo.id });
  // Partner connections in SANDBOX (no partner credentials in demo data — nothing is ever sent to Uber or Deliverect).
  await db.insert(t.connections).values([
    { organizationId: meId, locationId: L['SEA-FR'].id, provider: 'uber_direct', kind: 'delivery', direction: 'bidirectional', authoritative: 'branchharbor', state: 'disconnected', config: { enabled: true, mode: 'sandbox', feeMode: 'absorb' } },
    { organizationId: meId, locationId: london!.id, provider: 'deliverect', kind: 'pos', direction: 'bidirectional', authoritative: 'branchharbor', state: 'disconnected', config: { enabled: true, mode: 'sandbox', environment: 'staging', posInjection: true, marketplaceOrders: true, autoAccept: false } },
  ]);

  // ───────── Kitchen stations, drivers, tables ─────────
  for (const l of locs) await db.insert(t.foodStations).values(DEFAULT_STATIONS.map((d) => ({ ...d, organizationId: meId, locationId: l.id }))).onConflictDoNothing();
  const [carlosDriver, deeDriver] = await db.insert(t.foodDrivers).values([
    { organizationId: meId, locationId: L['SEA-BL'].id, userId: c.carlos.id, name: 'Carlos Ortega', phone: '+1 206 555 0177' },
    { organizationId: meId, locationId: L['SEA-BL'].id, userId: dee.id, name: 'Dee Walker', phone: '+1 206 555 0178' },
    { organizationId: meId, locationId: london!.id, name: 'Priya Shah', phone: '+44 7700 900123' },
  ]).returning();
  const tables: Record<string, Array<typeof t.foodTables.$inferSelect>> = {};
  for (const [code, n, area] of [['SEA-BL', 8, 'Dining room'], ['YVR-GT', 6, 'Patio'], ['LON-SP', 10, 'Ground floor'], ['LIS-PR', 6, 'Esplanada']] as const) {
    tables[code] = await db.insert(t.foodTables).values(Array.from({ length: n }, (_, i) => ({ organizationId: meId, locationId: L[code].id, label: `${code === 'LIS-PR' ? 'Mesa' : 'Table'} ${i + 1}`, code: `${code.replace('-', '')}${i + 1}`, seats: i % 3 === 0 ? 2 : 4, area }))).returning();
  }

  // ───────── Delivery zones ─────────
  await db.insert(t.foodDeliveryZones).values([
    { organizationId: meId, locationId: L['SEA-BL'].id, name: 'Ballard & Crown Hill', kind: 'postcode', postcodes: ['98107', '98117'], feeMinor: 399, minimumOrderMinor: 2000, freeDeliveryAboveMinor: 6000, currency: 'USD', sortOrder: 1 },
    { organizationId: meId, locationId: L['SEA-BL'].id, name: 'Within 5 km', kind: 'radius', radiusMeters: 5000, feeMinor: 599, minimumOrderMinor: 2500, currency: 'USD', sortOrder: 2 },
    { organizationId: meId, locationId: L['SEA-FR'].id, name: 'Fremont & Wallingford', kind: 'postcode', postcodes: ['98103'], feeMinor: 449, minimumOrderMinor: 2000, currency: 'USD', sortOrder: 1 },
    { organizationId: meId, locationId: london!.id, name: 'East London', kind: 'postcode', postcodes: ['E1', 'E2', 'EC2A', 'EC1V'], feeMinor: 250, minimumOrderMinor: 1500, freeDeliveryAboveMinor: 4000, currency: 'GBP', sortOrder: 1 },
    { organizationId: meId, locationId: london!.id, name: 'Within 3 km', kind: 'radius', radiusMeters: 3000, feeMinor: 350, minimumOrderMinor: 2000, currency: 'GBP', sortOrder: 2 },
  ]);

  // ───────── Ingredients & recipes ─────────
  const ings = await db.insert(t.foodIngredients).values([
    { organizationId: meId, name: 'Brisket', unit: 'g', sku: 'MT-BRISKET' },
    { organizationId: meId, name: 'Chicken thigh', unit: 'g', sku: 'MT-CHK' },
    { organizationId: meId, name: 'Pizza dough ball', unit: 'each', sku: 'BK-DOUGH' },
    { organizationId: meId, name: 'Mozzarella', unit: 'g', sku: 'DY-MOZZ' },
    { organizationId: meId, name: 'Lemons', unit: 'each', sku: 'PR-LEMON' },
    { organizationId: meId, name: 'Oat milk', unit: 'ml', sku: 'DY-OAT' },
    { organizationId: meId, name: 'Tart shells', unit: 'each', sku: 'BK-TART' },
    { organizationId: meId, name: 'Eggs', unit: 'each', sku: 'DY-EGG' },
  ]).returning();
  const ing = (n: string) => ings.find((i) => i.name === n)!.id;
  await db.insert(t.foodRecipeLines).values([
    { organizationId: meId, menuItemId: item('Smoked brisket sandwich').id, ingredientId: ing('Brisket'), quantity: 180 },
    { organizationId: meId, menuItemId: item('Ember chicken bowl').id, ingredientId: ing('Chicken thigh'), quantity: 200 },
    { organizationId: meId, menuItemId: item('Margherita, wood-fired').id, ingredientId: ing('Pizza dough ball'), quantity: 1 },
    { organizationId: meId, menuItemId: item('Margherita, wood-fired').id, ingredientId: ing('Mozzarella'), quantity: 120 },
    { organizationId: meId, menuItemId: item('Maple lemonade').id, ingredientId: ing('Lemons'), quantity: 2 },
    { organizationId: meId, menuItemId: item('Cold brew').id, modifierId: milk.find((m) => m.name === 'Oat milk')!.id, ingredientId: ing('Oat milk'), quantity: 60 },
    { organizationId: meId, menuItemId: item('Burnt honey tart').id, ingredientId: ing('Tart shells'), quantity: 1 },
    { organizationId: meId, menuItemId: item('Ember breakfast sandwich').id, ingredientId: ing('Eggs'), quantity: 1 },
    { organizationId: meId, menuItemId: item('Smoked brisket sandwich').id, modifierId: addons.find((m) => m.name === 'Fried egg')!.id, ingredientId: ing('Eggs'), quantity: 1 },
  ]);
  const stock = (code: keyof typeof L, name: string, onHand: number, low: number, auto = true) => ({ organizationId: meId, locationId: L[code].id, ingredientId: ing(name), onHand, lowStockThreshold: low, autoSoldOut: auto });
  await db.insert(t.foodIngredientStock).values([
    stock('SEA-BL', 'Brisket', 5400, 1800), stock('SEA-BL', 'Chicken thigh', 6000, 2000), stock('SEA-BL', 'Pizza dough ball', 24, 8), stock('SEA-BL', 'Mozzarella', 2600, 1000),
    stock('SEA-BL', 'Lemons', 6, 10), stock('SEA-BL', 'Oat milk', 3000, 1000), stock('SEA-BL', 'Tart shells', 9, 4), stock('SEA-BL', 'Eggs', 60, 24),
    stock('SEA-FR', 'Brisket', 3600, 1800), stock('SEA-FR', 'Pizza dough ball', 18, 8), stock('SEA-FR', 'Tart shells', 0, 4), stock('SEA-FR', 'Lemons', 30, 10),
    stock('LON-SP', 'Brisket', 4500, 1500), stock('LON-SP', 'Chicken thigh', 1500, 2000), stock('LON-SP', 'Eggs', 48, 24), stock('LON-SP', 'Oat milk', 800, 1000),
    stock('LIS-PR', 'Pizza dough ball', 30, 10), stock('LIS-PR', 'Mozzarella', 3000, 1000), stock('LIS-PR', 'Eggs', 90, 24),
  ]);
  const now = new Date();
  await db.insert(t.foodIngredientMovements).values([
    { organizationId: meId, locationId: L['SEA-BL'].id, ingredientId: ing('Lemons'), delta: 24, reason: 'receive', balanceAfter: 30, note: 'Produce delivery', createdBy: c.demo.id, createdAt: new Date(now.getTime() - 50 * H) },
    { organizationId: meId, locationId: L['SEA-BL'].id, ingredientId: ing('Lemons'), delta: -24, reason: 'order', balanceAfter: 6, createdAt: new Date(now.getTime() - 3 * H) },
    { organizationId: meId, locationId: L['SEA-FR'].id, ingredientId: ing('Tart shells'), delta: -2, reason: 'waste', balanceAfter: 0, note: 'Dropped tray', createdBy: c.demo.id, createdAt: new Date(now.getTime() - 2 * H) },
  ]);
  await db.insert(t.foodSoldOutEvents).values([
    { organizationId: meId, locationId: L['SEA-FR'].id, menuItemId: item('Burnt honey tart').id, source: 'ingredient', startedAt: new Date(now.getTime() - 2 * H) },
    { organizationId: meId, locationId: L['SEA-BL'].id, menuItemId: item('Margherita, wood-fired').id, source: 'manual', startedAt: new Date(now.getTime() - 4 * 86400_000), endedAt: new Date(now.getTime() - 4 * 86400_000 + 5 * H), createdBy: c.carlos.id },
    { organizationId: meId, locationId: L['SEA-BL'].id, menuItemId: item('Maple lemonade').id, source: 'manual', startedAt: new Date(now.getTime() - 2 * 86400_000), endedAt: new Date(now.getTime() - 2 * 86400_000 + 3 * H), createdBy: c.carlos.id },
    { organizationId: meId, locationId: london!.id, menuItemId: item('Charred veg grain bowl').id, source: 'manual', startedAt: new Date(now.getTime() - 86400_000), endedAt: new Date(now.getTime() - 86400_000 + 6 * H) },
  ]);
  // Manual sold-out right now: the Margherita at Fremont until close, "Large" bowl size at Gastown.
  const closeToday = (l: Loc) => zonedToUtc(localDateParts(now, l.timeZone).date, '22:00', l.timeZone);
  const fremontClose = closeToday(L['SEA-FR']) > now ? closeToday(L['SEA-FR']) : new Date(now.getTime() + 2 * H);
  await db.insert(t.locationMenuOverrides).values({ organizationId: meId, locationId: L['SEA-FR'].id, menuItemId: item('Margherita, wood-fired').id, soldOut: true, soldOutUntil: fremontClose, updatedBy: c.demo.id });
  await db.insert(t.foodSoldOutEvents).values({ organizationId: meId, locationId: L['SEA-FR'].id, menuItemId: item('Margherita, wood-fired').id, source: 'manual', startedAt: now, endedAt: fremontClose, createdBy: c.demo.id });
  const large = (await db.select().from(t.modifiers).where(and(eq(t.modifiers.organizationId, meId), eq(t.modifiers.name, 'Large'))))[0];
  if (large) {
    const until = closeToday(L['YVR-GT']) > now ? closeToday(L['YVR-GT']) : new Date(now.getTime() + 2 * H);
    await db.insert(t.locationMenuOverrides).values({ organizationId: meId, locationId: L['YVR-GT'].id, menuItemId: item('Ember chicken bowl').id, modifierId: large.id, soldOut: true, soldOutUntil: until });
    await db.insert(t.foodSoldOutEvents).values({ organizationId: meId, locationId: L['YVR-GT'].id, menuItemId: item('Ember chicken bowl').id, modifierId: large.id, source: 'manual', startedAt: now, endedAt: until });
  }

  // ───────── Orders across channels (history + live) ─────────
  const custByLoc = new Map<string, Array<typeof t.customers.$inferSelect>>();
  const guestNames: Record<string, string[]> = {
    'SEA-BL': ['Morgan Lee', 'Priya Nair', 'Sam Okafor'], 'SEA-FR': ['Alex Kim', 'Jordan Blake'], 'YVR-GT': ['Chloé Tremblay', 'Ethan Wong'],
    'LON-SP': ['Oliver Bennett', 'Amara Okoye', 'Harriet Cole'], 'LIS-PR': ['Inês Costa', 'João Ferreira', 'Marta Lopes'],
  };
  for (const l of locs) {
    custByLoc.set(l.id, await db.insert(t.customers).values(guestNames[l.code]!.map((n) => ({ organizationId: meId, locationId: l.id, name: n, email: `${n.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(/\s+/g, '.')}@example.com` }))).returning());
  }
  let seq = 2000;
  const mkOrder = async (l: Loc, o: { channel: string; status: string; lines: Array<{ name: string; qty: number; modifiers?: string[] }>; at: Date; promisedAt: Date; minutesToReady?: number; tipMinor?: number; deliveryFeeMinor?: number; fulfilment?: t.FoodOrderFulfilment; paymentStatus?: string; payment?: boolean; customer?: number; notes?: string }) => {
    const lines = o.lines.map((ln) => {
      const it = item(ln.name) ?? preItems.find((p) => p.name === ln.name)!;
      const unit = (it.prices as Record<string, number>)[l.currency] ?? 0;
      return { menuItemId: it.id, name: it.name, quantity: ln.qty, unitPriceMinor: unit, modifiers: (ln.modifiers ?? []).map((m) => ({ id: randomBytes(4).toString('hex'), name: m, priceMinor: 0 })), lineTotalMinor: unit * ln.qty, stationKey: it.stationKey };
    });
    const subtotal = lines.reduce((a, x) => a + x.lineTotalMinor, 0);
    const taxBps = typeof l.settings.taxRateBps === 'number' ? (l.settings.taxRateBps as number) : 0;
    const tax = Math.round((subtotal * taxBps) / 10_000);
    const sc = settingsByCode[l.code]!.serviceCharge;
    const service = sc.bps && sc.channels.includes(o.channel) ? Math.round((subtotal * sc.bps) / 10_000) : 0;
    const total = subtotal + tax + service + (o.tipMinor ?? 0) + (o.deliveryFeeMinor ?? 0);
    const flow = ['awaiting_acceptance', 'accepted', 'preparing', 'ready'];
    const endAt = o.channel === 'delivery' ? ['out_for_delivery', 'delivered'] : o.channel === 'dine_in' ? ['served'] : ['collected'];
    const path = [...flow, ...endAt];
    const upto = o.status === 'cancelled' || o.status === 'rejected' ? ['awaiting_acceptance', o.status] : path.slice(0, path.indexOf(o.status) + 1);
    const readyMin = o.minutesToReady ?? 14;
    const history = upto.map((to, i) => ({ at: new Date(o.at.getTime() + (to === 'accepted' ? 2 : to === 'preparing' ? 4 : to === 'ready' ? 2 + readyMin : i * 6) * 60_000).toISOString(), from: i ? upto[i - 1]! : null, to, by: null }));
    const cust = custByLoc.get(l.id)![(o.customer ?? seq) % custByLoc.get(l.id)!.length]!;
    const [row] = await db.insert(t.foodOrders).values({
      organizationId: meId, locationId: l.id, customerId: cust.id, orderNumber: `${l.code}-${seq++}`, status: o.status, paymentStatus: o.paymentStatus ?? 'paid', channel: o.channel,
      fulfilment: o.fulfilment ?? {}, lines, subtotalMinor: subtotal, taxMinor: tax, serviceChargeMinor: service, tipMinor: o.tipMinor ?? 0, deliveryFeeMinor: o.deliveryFeeMinor ?? 0, totalMinor: total, currency: l.currency,
      contact: { name: cust.name, email: cust.email ?? undefined }, notes: o.notes ?? null, promisedAt: o.promisedAt, statusHistory: history, manageTokenHash: token(`order-${seq}`), createdAt: o.at, updatedAt: new Date(Math.max(o.at.getTime(), Date.parse(history[history.length - 1]!.at))),
    }).returning();
    if (o.payment !== false && (o.paymentStatus ?? 'paid') === 'paid') {
      const [p] = await db.insert(t.paymentReferences).values({ organizationId: meId, locationId: l.id, provider: 'stripe', externalId: pi(), connectedAccountId: org!.stripeAccountId, amountMinor: total, currency: l.currency, applicationFeeMinor: Math.floor(total / 100), state: 'succeeded', succeededAt: o.at, targetType: 'food_order', targetId: row!.id, sandbox: 1, createdAt: o.at }).returning();
      await db.update(t.foodOrders).set({ paymentId: p!.id }).where(eq(t.foodOrders.id, row!.id));
      return { ...row!, paymentId: p!.id };
    }
    return row!;
  };
  // History: the last 14 days, every location, several channels (for reports).
  const menuMix: Record<string, Array<Array<{ name: string; qty: number; modifiers?: string[] }>>> = {
    standard: [[{ name: 'Ember chicken bowl', qty: 1, modifiers: ['Regular', 'Chimichurri'] }, { name: 'Maple lemonade', qty: 1 }], [{ name: 'Smoked brisket sandwich', qty: 2 }, { name: 'House fries', qty: 1 }], [{ name: 'Margherita, wood-fired', qty: 1, modifiers: ['Classic crust'] }, { name: 'Sparkling water', qty: 2 }], [{ name: 'Charred veg grain bowl', qty: 1 }, { name: 'Burnt honey tart', qty: 1 }]],
  };
  for (const l of locs) {
    const channels = Object.entries(settingsByCode[l.code]!.channels).filter(([k, v]) => v && ['pickup', 'delivery', 'dineIn'].includes(k)).map(([k]) => (k === 'dineIn' ? 'dine_in' : k));
    for (let d = 1; d <= 14; d++) {
      for (let n = 0; n < 2; n++) {
        const ch = channels[(d + n) % channels.length]!;
        const at = zonedToUtc(addDays(c.today, -d), n ? '18:40' : '12:15', l.timeZone);
        const lines = menuMix.standard![(d + n) % 4]!;
        await mkOrder(l, {
          channel: ch, status: ch === 'delivery' ? 'delivered' : ch === 'dine_in' ? 'served' : 'collected', lines, at, promisedAt: new Date(at.getTime() + 25 * 60_000), minutesToReady: 9 + ((d * 7 + n * 3) % 15),
          tipMinor: settingsByCode[l.code]!.tips.channels.includes(ch) && n ? 300 : 0, deliveryFeeMinor: ch === 'delivery' ? (l.currency === 'GBP' ? 250 : 399) : 0,
          fulfilment: ch === 'delivery' ? { zoneName: l.currency === 'GBP' ? 'East London' : 'Ballard & Crown Hill', address: { line1: '1 Example St', city: l.address.city, postalCode: l.currency === 'GBP' ? 'E1 6QL' : '98107' } } : ch === 'dine_in' ? { tableLabel: tables[l.code]?.[d % 5]?.label ?? 'Table 1', tableId: tables[l.code]?.[d % 5]?.id } : {},
        });
      }
      if (d === 3) await mkOrder(l, { channel: 'pickup', status: 'rejected', lines: menuMix.standard![1]!, at: zonedToUtc(addDays(c.today, -d), '20:50', l.timeZone), promisedAt: zonedToUtc(addDays(c.today, -d), '21:20', l.timeZone), paymentStatus: 'refunded', payment: false });
    }
  }
  // Live: Ballard delivery orders being prepared / out for delivery; London dine-in tab.
  const ballard = L['SEA-BL'];
  const soon = (m: number) => new Date(now.getTime() + m * 60_000);
  const del1 = await mkOrder(ballard, { channel: 'delivery', status: 'ready', lines: menuMix.standard![1]!, at: soon(-35), promisedAt: soon(10), deliveryFeeMinor: 399, tipMinor: 400, fulfilment: { zoneName: 'Ballard & Crown Hill', address: { line1: '2014 NW 63rd St', city: 'Seattle', postalCode: '98107', instructions: 'Side door' } }, customer: 0 });
  const del2 = await mkOrder(ballard, { channel: 'delivery', status: 'out_for_delivery', lines: menuMix.standard![0]!, at: soon(-50), promisedAt: soon(-5), deliveryFeeMinor: 599, fulfilment: { zoneName: 'Within 5 km', address: { line1: '7301 Greenwood Ave N', city: 'Seattle', postalCode: '98103' } }, customer: 1 });
  await mkOrder(ballard, { channel: 'delivery', status: 'accepted', lines: menuMix.standard![3]!, at: soon(-10), promisedAt: soon(40), deliveryFeeMinor: 399, fulfilment: { zoneName: 'Ballard & Crown Hill', address: { line1: '5600 24th Ave NW', city: 'Seattle', postalCode: '98107' } }, customer: 2 });
  await db.insert(t.foodDeliveries).values([
    { organizationId: meId, locationId: ballard.id, orderId: del1.id, provider: 'own', driverId: carlosDriver!.id, status: 'assigned', currency: 'USD', events: [{ at: soon(-5).toISOString(), status: 'assigned', by: c.demo.id, note: 'Assigned to Carlos Ortega' }] },
    { organizationId: meId, locationId: ballard.id, orderId: del2.id, provider: 'own', driverId: deeDriver!.id, status: 'picked_up', currency: 'USD', events: [{ at: soon(-20).toISOString(), status: 'assigned', by: c.demo.id }, { at: soon(-12).toISOString(), status: 'picked_up', by: dee.id }] },
  ]);
  await mkOrder(L['SEA-BL'], { channel: 'dine_in', status: 'preparing', lines: [{ name: 'Smoked brisket sandwich', qty: 1, modifiers: ['Fried egg'] }, { name: 'Cold brew', qty: 1, modifiers: ['Oat milk'] }], at: soon(-8), promisedAt: soon(7), fulfilment: { tableId: tables['SEA-BL']![2]!.id, tableLabel: tables['SEA-BL']![2]!.label }, notes: 'No onions please' });
  const londonTable = tables['LON-SP']![3]!;
  const [tab] = await db.insert(t.foodTabs).values({ organizationId: meId, locationId: london!.id, tableId: londonTable.id, guestName: 'Oliver', tokenHash: token('tab-london'), currency: 'GBP', openedAt: soon(-30) }).returning();
  await mkOrder(london!, { channel: 'dine_in', status: 'served', lines: [{ name: 'Ember chicken bowl', qty: 2, modifiers: ['Regular', 'Smoked chili'] }], at: soon(-30), promisedAt: soon(-15), paymentStatus: 'on_tab', payment: false, fulfilment: { tableId: londonTable.id, tableLabel: londonTable.label, tabId: tab!.id, serviceChargeLabel: 'Service charge' }, customer: 0 });
  await mkOrder(london!, { channel: 'dine_in', status: 'accepted', lines: [{ name: 'Burnt honey tart', qty: 2 }, { name: 'Cold brew', qty: 2 }], at: soon(-4), promisedAt: soon(10), paymentStatus: 'on_tab', payment: false, fulfilment: { tableId: londonTable.id, tableLabel: londonTable.label, tabId: tab!.id, serviceChargeLabel: 'Service charge' }, customer: 0 });
  await mkOrder(L['LIS-PR'], { channel: 'dine_in', status: 'awaiting_acceptance', lines: [{ name: 'Margherita, wood-fired', qty: 2, modifiers: ['Thin crust'] }, { name: 'Sparkling water', qty: 2 }], at: soon(-2), promisedAt: soon(15), fulfilment: { tableId: tables['LIS-PR']![1]!.id, tableLabel: tables['LIS-PR']![1]!.label } });
  await mkOrder(L['LIS-PR'], { channel: 'pickup', status: 'preparing', lines: menuMix.standard![0]!, at: soon(-12), promisedAt: soon(8), customer: 1 });
  await mkOrder(london!, { channel: 'pickup', status: 'awaiting_acceptance', lines: menuMix.standard![2]!, at: soon(-1), promisedAt: soon(25), customer: 2 });

  // Payment recovery cases: a paid order whose record never arrived (recreatable from the snapshot) and a duplicate payment.
  const ghostId = crypto.randomUUID();
  const snap = { organizationId: meId, locationId: ballard.id, orderNumber: 'SEA-BL-3999', status: 'awaiting_acceptance', paymentStatus: 'pending', channel: 'pickup', fulfilment: {}, lines: [{ menuItemId: item('Smoked brisket sandwich').id, name: 'Smoked brisket sandwich', quantity: 1, unitPriceMinor: 1500, modifiers: [], lineTotalMinor: 1500, stationKey: 'grill' }], subtotalMinor: 1500, taxMinor: 155, serviceChargeMinor: 0, tipMinor: 0, deliveryFeeMinor: 0, totalMinor: 1655, currency: 'USD', contact: { name: 'Riley Park', email: 'riley.park@example.com' }, notes: null, promisedAt: soon(40).toISOString(), statusHistory: [] };
  await db.insert(t.paymentReferences).values({ organizationId: meId, locationId: ballard.id, provider: 'stripe', externalId: pi(), connectedAccountId: org!.stripeAccountId, amountMinor: 1655, currency: 'USD', applicationFeeMinor: 16, state: 'succeeded', succeededAt: soon(-20), targetType: 'food_order', targetId: ghostId, recordSnapshot: snap, sandbox: 1, createdAt: soon(-22) });
  const [dupOf] = await db.select().from(t.foodOrders).where(and(eq(t.foodOrders.locationId, london!.id), eq(t.foodOrders.status, 'collected'))).limit(1);
  if (dupOf) await db.insert(t.paymentReferences).values({ organizationId: meId, locationId: london!.id, provider: 'stripe', externalId: pi(), connectedAccountId: org!.stripeAccountId, amountMinor: dupOf.totalMinor, currency: 'GBP', applicationFeeMinor: Math.floor(dupOf.totalMinor / 100), state: 'succeeded', succeededAt: new Date(dupOf.createdAt.getTime() + 60_000), targetType: 'food_order', targetId: dupOf.id, sandbox: 1, createdAt: new Date(dupOf.createdAt.getTime() + 60_000) });

  // ───────── Preorder (cooking) dates ─────────
  const nextDow = (l: Loc, dow: number) => { const d0 = localDateParts(now, l.timeZone).date; let d = addDays(d0, 1); while (weekdayOf(d) !== dow) d = addDays(d, 1); return d; };
  for (const [code, cap] of [['SEA-BL', 30], ['LIS-PR', 20]] as const) {
    const l = L[code];
    for (const dow of [6, 0]) {
      const date = nextDow(l, dow);
      await db.insert(t.foodProductionDates).values({ organizationId: meId, locationId: l.id, date, menuId: pre!.id, cutoffAt: zonedToUtc(addDays(date, -2), '18:00', l.timeZone) > now ? zonedToUtc(addDays(date, -2), '18:00', l.timeZone) : zonedToUtc(addDays(date, -1), '12:00', l.timeZone), collectionWindows: ['10:00-12:00', '14:00-17:00'], capacity: cap, booked: dow === 6 ? 4 : 1, note: dow === 6 ? 'Brisket comes off the smoker at 09:30' : null }).onConflictDoNothing();
    }
  }
  const [prodDate] = await db.select().from(t.foodProductionDates).where(eq(t.foodProductionDates.locationId, ballard.id)).limit(1);
  if (prodDate) {
    for (let i = 0; i < 2; i++) {
      await mkOrder(ballard, { channel: 'preorder', status: 'accepted', lines: [{ name: 'Whole smoked brisket (serves 6)', qty: 1 }, { name: 'Maple pecan pie (whole)', qty: i + 1 }], at: soon(-60 * (i + 2)), promisedAt: zonedToUtc(prodDate.date, '10:00', ballard.timeZone), fulfilment: { productionDateId: prodDate.id, productionDate: prodDate.date, collectionWindow: '10:00-12:00' }, customer: i });
    }
  }

  // ───────── Catering ─────────
  const [office, feast] = await db.insert(t.foodCateringPackages).values([
    { organizationId: meId, name: 'Office lunch', description: 'Bowls, sandwiches and salads delivered ready to serve.', pricesPerGuest: { USD: 1800, CAD: 2300, GBP: 1500, EUR: 1600 }, minGuests: 10, maxGuests: 120, leadDays: 2, includes: ['Choice of 3 bowls', 'Sandwich platter', 'Seasonal salad', 'Compostable serveware'], dietary: [], allergens: ['cereals_gluten', 'wheat', 'milk', 'eggs', 'mustard', 'sesame'], allergensDeclared: true, sortOrder: 1, translations: { pt: { name: 'Almoço de escritório' } } },
    { organizationId: meId, name: 'Smokehouse feast', description: 'Whole smoked brisket and chicken, sides and desserts for celebrations.', pricesPerGuest: { USD: 3200, CAD: 4100, GBP: 2600 }, minGuests: 20, leadDays: 5, includes: ['Brisket & chicken', '3 sides', 'Burnt honey tart'], allergens: ['cereals_gluten', 'wheat', 'milk', 'eggs', 'mustard'], allergensDeclared: true, sortOrder: 2, locationIds: [ballard.id, L['SEA-FR'].id, L['YVR-GT'].id, london!.id] },
  ]).returning();
  const enquiry = async (l: Loc, o: { name: string; email: string; days: number; guests: number; pkg?: typeof office; status: string; quote?: boolean; fulfilment?: string; notes?: string; dietaryNotes?: string }) => {
    const eventDate = addDays(localDateParts(now, l.timeZone).date, o.days);
    const per = o.pkg?.pricesPerGuest[l.currency] ?? 0;
    const sub = per * o.guests;
    const sc = settingsByCode[l.code]!.serviceCharge;
    const service = sc.bps && sc.channels.includes('catering') ? Math.round((sub * sc.bps) / 10_000) : 0;
    const taxBps = typeof l.settings.taxRateBps === 'number' ? (l.settings.taxRateBps as number) : 0;
    const tax = Math.round((sub * taxBps) / 10_000);
    const total = sub + service + tax;
    const quote = o.quote ? { version: 1, lines: [{ description: `${o.pkg!.name} — per guest`, menuItemId: null, quantity: o.guests, unitPriceMinor: per, totalMinor: sub }], subtotalMinor: sub, serviceChargeMinor: service, deliveryFeeMinor: 0, taxMinor: tax, taxRateBps: taxBps, totalMinor: total, depositMinor: Math.round(total * 0.3), currency: l.currency, validUntil: new Date(now.getTime() + 6 * 86400_000).toISOString(), terms: 'Deposit secures the date. Balance due on the day.', sentAt: new Date(now.getTime() - 86400_000).toISOString(), sentBy: c.demo.id } : null;
    const history = [{ at: new Date(now.getTime() - 3 * 86400_000).toISOString(), from: null, to: 'new', by: null }, ...(o.quote ? [{ at: quote!.sentAt, from: 'new', to: 'quoted', by: c.demo.id }] : []), ...(['accepted', 'deposit_paid', 'confirmed'].includes(o.status) ? [{ at: new Date(now.getTime() - 12 * H).toISOString(), from: 'quoted', to: 'accepted', by: null }] : []), ...(['deposit_paid', 'confirmed'].includes(o.status) ? [{ at: new Date(now.getTime() - 11 * H).toISOString(), from: 'accepted', to: 'deposit_paid', by: null }] : []), ...(o.status === 'confirmed' ? [{ at: new Date(now.getTime() - 10 * H).toISOString(), from: 'deposit_paid', to: 'confirmed', by: c.demo.id }] : [])];
    const [cu] = await db.insert(t.customers).values({ organizationId: meId, locationId: l.id, name: o.name, email: o.email }).returning();
    const [e] = await db.insert(t.foodCateringEnquiries).values({ organizationId: meId, locationId: l.id, customerId: cu!.id, reference: `CAT-${randomBytes(3).toString('hex').toUpperCase().slice(0, 5)}`, contact: { name: o.name, email: o.email }, eventDate, eventTime: '12:30', guests: o.guests, packageId: o.pkg?.id ?? null, fulfilment: o.fulfilment ?? 'delivery', address: o.fulfilment === 'pickup' ? null : { line1: '100 Example Plaza', city: l.address.city, postalCode: l.address.postalCode ?? '' }, notes: o.notes ?? null, dietaryNotes: o.dietaryNotes ?? null, status: o.status, quote, currency: l.currency, tokenHash: token(`catering-${o.email}`), statusHistory: history, acceptedAt: ['accepted', 'deposit_paid', 'confirmed'].includes(o.status) ? new Date(now.getTime() - 12 * H) : null, depositPaidAt: ['deposit_paid', 'confirmed'].includes(o.status) ? new Date(now.getTime() - 11 * H) : null, confirmedAt: o.status === 'confirmed' ? new Date(now.getTime() - 10 * H) : null, createdAt: new Date(now.getTime() - 3 * 86400_000) }).returning();
    if (['deposit_paid', 'confirmed'].includes(o.status) && quote) {
      const [p] = await db.insert(t.paymentReferences).values({ organizationId: meId, locationId: l.id, provider: 'stripe', externalId: pi(), connectedAccountId: org!.stripeAccountId, amountMinor: quote.depositMinor, currency: l.currency, applicationFeeMinor: Math.floor(quote.depositMinor / 100), state: 'succeeded', succeededAt: new Date(now.getTime() - 11 * H), targetType: 'catering_deposit', targetId: e!.id, sandbox: 1 }).returning();
      await db.update(t.foodCateringEnquiries).set({ depositPaymentId: p!.id }).where(eq(t.foodCateringEnquiries.id, e!.id));
    }
    return e!;
  };
  await enquiry(ballard, { name: 'Taylor Brooks', email: 'taylor.brooks@example.com', days: 9, guests: 40, pkg: office, status: 'new', notes: 'Quarterly all-hands, Ballard office', dietaryNotes: '6 vegetarian, 2 vegan (guest-reported)' });
  await enquiry(ballard, { name: 'Jamie Rivera', email: 'jamie.rivera@example.com', days: 12, guests: 25, pkg: feast, status: 'quoted', quote: true, notes: 'Birthday party' });
  await enquiry(ballard, { name: 'Casey Morgan', email: 'casey.morgan@example.com', days: 4, guests: 30, pkg: office, status: 'deposit_paid', quote: true });
  await enquiry(ballard, { name: 'Robin Shah', email: 'robin.shah@example.com', days: 2, guests: 18, pkg: office, status: 'confirmed', quote: true, fulfilment: 'pickup' });
  await enquiry(L['YVR-GT'], { name: 'Léa Gagnon', email: 'lea.gagnon@example.com', days: 14, guests: 60, pkg: feast, status: 'new', notes: 'Team offsite on the patio' });
  await enquiry(london!, { name: 'Freya Collins', email: 'freya.collins@example.com', days: 8, guests: 24, pkg: office, status: 'quoted', quote: true });
  await enquiry(london!, { name: 'Noah Price', email: 'noah.price@example.com', days: 20, guests: 80, pkg: feast, status: 'new', fulfilment: 'onsite', notes: 'Wedding rehearsal dinner' });

  // ───────── Meal plans ─────────
  const [prep, family] = await db.insert(t.foodMealPlans).values([
    { organizationId: meId, name: 'Weekly prep box — 5 meals', description: 'Five chef-selected bowls for the week, ready to reheat.', mealsPerBox: 5, pricesPerWeek: { USD: 6900, CAD: 8900, GBP: 5500, EUR: 5900 }, fulfilment: 'pickup', fulfilmentWeekday: 1, cutoffDaysBefore: 3, cutoffTime: '18:00', menuItemIds: [item('Ember chicken bowl').id, item('Charred veg grain bowl').id], locationIds: [ballard.id, london!.id], translations: { pt: { name: 'Caixa semanal — 5 refeições' } } },
    { organizationId: meId, name: 'Family box — 10 meals', description: 'Ten meals delivered on Sundays.', mealsPerBox: 10, pricesPerWeek: { USD: 12900, GBP: 9900 }, fulfilment: 'delivery', fulfilmentWeekday: 0, cutoffDaysBefore: 3, cutoffTime: '12:00', menuItemIds: [item('Ember chicken bowl').id, item('Smoked brisket sandwich').id, item('Charred veg grain bowl').id], locationIds: [ballard.id, london!.id] },
  ]).returning();
  const thisMonday = (l: Loc) => mondayOf(localDateParts(now, l.timeZone).date);
  const subRow = async (l: Loc, plan: typeof prep, who: { name: string; email: string }, status: string, skipNext = false) => {
    const price = plan!.pricesPerWeek[l.currency]!;
    const start = addDays(thisMonday(l), -14);
    const next = addDays(thisMonday(l), 7);
    const [cu] = await db.insert(t.customers).values({ organizationId: meId, locationId: l.id, name: who.name, email: who.email }).returning();
    const [sub] = await db.insert(t.foodMealPlanSubscriptions).values({ organizationId: meId, locationId: l.id, planId: plan!.id, customerId: cu!.id, contact: who, status, externalId: `sub_sandbox_seed${randomBytes(4).toString('hex')}`, sandbox: true, priceMinor: price, currency: l.currency, startWeek: start, skippedWeeks: skipNext ? [next] : [], address: plan!.fulfilment === 'delivery' ? { line1: '2200 NW Market St', city: l.address.city, postalCode: l.address.postalCode } : null, tokenHash: token(`meal-${who.email}`), createdAt: new Date(now.getTime() - 15 * 86400_000) }).returning();
    if (status === 'active') {
      for (const w of [thisMonday(l), next]) {
        const items = plan!.menuItemIds.map((id) => ({ menuItemId: id, name: [...existing, ...newItems].find((x) => x.id === id)!.name, quantity: Math.ceil(plan!.mealsPerBox / plan!.menuItemIds.length) }));
        await db.insert(t.foodMealPlanBoxes).values({ organizationId: meId, locationId: l.id, subscriptionId: sub!.id, weekStart: w, fulfilmentDate: fulfilmentDateOf(plan!, w), status: skipNext && w === next ? 'skipped' : 'scheduled', items }).onConflictDoNothing();
      }
    }
    return sub!;
  };
  await subRow(ballard, prep, { name: 'Morgan Lee', email: 'morgan.lee@example.com' }, 'active');
  await subRow(ballard, prep, { name: 'Priya Nair', email: 'priya.nair@example.com' }, 'active', true);
  await subRow(ballard, family, { name: 'The Okafor family', email: 'okafor.family@example.com' }, 'active');
  await subRow(london!, prep, { name: 'Harriet Cole', email: 'harriet.cole@example.com' }, 'active');
  await subRow(london!, prep, { name: 'Amara Okoye', email: 'amara.okoye@example.com' }, 'paused');
  await subRow(london!, family, { name: 'Bennett household', email: 'bennett.household@example.com' }, 'active', true);

  return {
    london: london!, lisbon: lisbon!,
    tableCodes: Object.fromEntries(Object.entries(tables).map(([code, rows]) => [code, rows[0]!.code])),
    users: ['amelia.hart@demo.branchharbor.com (location manager, Spitalfields)', 'tiago.santos@demo.branchharbor.com (franchise owner, Lisbon)', 'dee.walker@demo.branchharbor.com (staff/driver, Ballard)'],
    tabToken: 'seed-tab-london',
  };
}
