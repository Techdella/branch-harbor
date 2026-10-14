/**
 * Foods (full product) client. Live mode calls apps/api `/v1/orgs/:orgId/foods/...` for the selected
 * organisation; mock mode serves the in-memory sample (./mock). Same selection and offline fallback rules
 * as the main client: a network failure retries against the mock and switches the app to "Offline · sample".
 */
import type { Money } from '@bh/shared';
import { ApiError } from '../errors';
import { apiMode, enterFallback } from '../api';
import { USE_MOCKS, http } from '../http/client';
import { orgId } from '../http/workspace';
import type {
  Builder, BuilderCategory, BuilderItem, BuilderModifier, BuilderModifierGroup, CateringEnquiry, CateringPackage, DayPart, Delivery, DeliveryZone, Driver, EffectiveItem,
  FoodConfig, FoodOrderLite, FoodsOverview, FoodsReport, Ingredient, IngredientMovement, KdsFeed, LocationSettings, MealPlan, MealPlanSubscription, ProductionDate,
  ProductionSummary, PublishPreview, PublishResult, Station, Tab, Table, Vocabulary,
} from './types';

export type QuoteBody = { lines?: Array<{ description: string; menuItemId?: string | null; quantity: number; unitPriceMinor: number }>; fromPackage?: boolean; deliveryFeeMinor?: number; depositBps?: number; validDays?: number; terms?: string | null };

export interface FoodsApi {
  readonly mode: 'live' | 'mock';
  overview(locationId?: string): Promise<FoodsOverview>;
  vocabulary(): Promise<Vocabulary>;
  builder(): Promise<Builder>;
  createMenu(name: string, kind?: 'standard' | 'preorder'): Promise<{ id: string }>;
  createItem(menuId: string, body: Record<string, unknown>): Promise<BuilderItem>;
  updateItem(id: string, patch: Record<string, unknown>): Promise<BuilderItem>;
  archiveItem(id: string): Promise<void>;
  createCategory(menuId: string, body: { name: string; dayPartIds?: string[] }): Promise<BuilderCategory>;
  updateCategory(id: string, patch: Record<string, unknown>): Promise<BuilderCategory>;
  addModifierGroup(itemId: string, body: { name: string; minSelect: number; maxSelect: number; modifiers: Array<{ name: string; prices: Record<string, number>; allergens?: string[] }> }): Promise<BuilderModifierGroup>;
  updateModifierGroup(id: string, patch: Record<string, unknown>): Promise<void>;
  deleteModifierGroup(id: string): Promise<void>;
  addModifier(groupId: string, body: { name: string; prices: Record<string, number>; allergens?: string[] }): Promise<BuilderModifier>;
  deleteModifier(id: string): Promise<void>;
  createDayPart(body: Omit<DayPart, 'id' | 'active' | 'translations'> & { translations?: DayPart['translations'] }): Promise<DayPart>;
  updateDayPart(id: string, patch: Partial<DayPart>): Promise<DayPart>;
  deleteDayPart(id: string): Promise<void>;
  publishPreview(menuId: string): Promise<PublishPreview>;
  publish(menuId: string, locationIds?: string[]): Promise<PublishResult>;
  retryPublish(menuId: string): Promise<PublishResult>;

  locationMenu(locationId: string): Promise<{ location: { id: string; currency: string }; items: EffectiveItem[] }>;
  setItemSoldOut(locationId: string, itemId: string, soldOut: boolean, untilClose: boolean): Promise<void>;
  setModifierSoldOut(locationId: string, modifierId: string, soldOut: boolean, untilClose: boolean): Promise<void>;
  settings(): Promise<LocationSettings[]>;
  saveSettings(locationId: string, body: Partial<FoodConfig> & { taxRateBps?: number | null }): Promise<void>;

  kds(locationId: string, stationId?: string | null): Promise<KdsFeed>;
  ticket(id: string, action: 'start' | 'bump' | 'recall', expectedStatus?: string): Promise<{ ticket: { id: string; status: string }; orderStatus: string; allStationsDone: boolean }>;
  transition(orderId: string, to: string, opts?: { note?: string; expectedFrom?: string }): Promise<{ order: { id: string; status: string } }>;
  stations(locationId: string): Promise<Station[]>;
  createStation(locationId: string, body: { key: string; name: string; prepTargetMinutes: number; isExpo?: boolean }): Promise<Station>;
  updateStation(id: string, patch: Partial<Station>): Promise<Station>;
  defaultStations(locationId: string): Promise<Station[]>;

  orders(params: { locationId?: string; channel?: string; status?: string; active?: boolean }): Promise<FoodOrderLite[]>;
  zones(locationId: string): Promise<{ items: DeliveryZone[]; geocoding: string; location: { geo: { lat: number; lng: number } | null } }>;
  createZone(locationId: string, body: Record<string, unknown>): Promise<DeliveryZone>;
  updateZone(id: string, patch: Record<string, unknown>): Promise<DeliveryZone>;
  deleteZone(id: string): Promise<void>;
  drivers(locationId: string): Promise<Driver[]>;
  createDriver(locationId: string, body: { name: string; phone?: string }): Promise<Driver>;
  deliveries(locationId?: string, active?: boolean): Promise<Delivery[]>;
  dispatch(orderId: string, provider: 'own' | 'uber_direct' | 'deliverect', driverId?: string): Promise<void>;
  deliveryStatus(id: string, status: 'picked_up' | 'delivered' | 'failed', note?: string): Promise<void>;
  sandboxAdvance(id: string): Promise<void>;
  providers(): Promise<Array<{ key: string; name: string; mode: string }>>;

  tables(locationId: string): Promise<Table[]>;
  createTable(locationId: string, body: { label: string; seats: number; area?: string }): Promise<Table>;
  updateTable(id: string, patch: { active?: boolean; regenerateCode?: boolean; seats?: number }): Promise<Table>;
  tabs(locationId: string, status?: string): Promise<Tab[]>;
  closeTab(id: string, how: 'counter' | 'void'): Promise<Tab>;

  productionDates(locationId: string): Promise<{ timeZone: string; items: ProductionDate[] }>;
  createProductionDate(locationId: string, body: { date: string; capacity: number; cutoffDaysBefore: number; cutoffTime: string; collectionWindows: string[]; note?: string }): Promise<ProductionDate>;
  updateProductionDate(id: string, patch: { status?: 'open' | 'closed'; capacity?: number }): Promise<ProductionDate>;
  production(locationId: string, date?: string): Promise<ProductionSummary>;
  packages(): Promise<CateringPackage[]>;
  createPackage(body: Record<string, unknown>): Promise<CateringPackage>;
  enquiries(params?: { locationId?: string; status?: string }): Promise<CateringEnquiry[]>;
  enquiry(id: string): Promise<CateringEnquiry>;
  quote(id: string, body: QuoteBody): Promise<CateringEnquiry>;
  enquiryStatus(id: string, to: 'confirmed' | 'completed' | 'declined' | 'cancelled', note?: string): Promise<CateringEnquiry>;

  mealPlans(): Promise<MealPlan[]>;
  createMealPlan(body: Record<string, unknown>): Promise<MealPlan>;
  updateMealPlan(id: string, patch: Record<string, unknown>): Promise<MealPlan>;
  subscriptions(params?: { locationId?: string; status?: string }): Promise<MealPlanSubscription[]>;
  skipWeek(subscriptionId: string, weekStart: string, skip: boolean): Promise<MealPlanSubscription>;
  generateBoxes(weekStart: string, locationId?: string): Promise<{ created: number; skipped: number }>;
  releaseBoxes(locationId: string, date: string): Promise<{ released: number }>;

  ingredients(locationId: string): Promise<Ingredient[]>;
  createIngredient(body: { name: string; unit: 'g' | 'ml' | 'each'; sku?: string }): Promise<Ingredient>;
  setStock(locationId: string, ingredientId: string, body: { lowStockThreshold?: number; autoSoldOut?: boolean }): Promise<void>;
  movement(locationId: string, ingredientId: string, body: { reason: 'receive' | 'waste' | 'count'; quantity: number; note?: string }): Promise<{ onHand: number; soldOutItems: string[] }>;
  movements(locationId: string, ingredientId: string): Promise<IngredientMovement[]>;
  recipe(itemId: string): Promise<Array<{ ingredientId: string; name: string; unit: string; quantity: number; modifierId: string | null }>>;
  saveRecipe(itemId: string, lines: Array<{ ingredientId: string; quantity: number; modifierId?: string | null }>): Promise<void>;

  reports(params: { from?: string; to?: string; locationId?: string }): Promise<FoodsReport>;
  aiMenuCopy(itemId: string, locale?: string): Promise<{ draft: string; warnings: string[]; needsReview: boolean; note: string }>;
  aiProductionSummary(locationId: string, date?: string): Promise<{ summary: string; note: string }>;
}

const o = (p: string) => `/orgs/${orgId()}/foods${p}`;
const items = <T,>(p: Promise<{ items: T[] }>) => p.then((r) => r.items);
const ignore = () => undefined;

export const liveFoodsApi: FoodsApi = {
  mode: 'live',
  overview: (locationId) => http.get(o('/overview'), { locationId }),
  vocabulary: () => http.get(o('/vocabulary')),
  builder: () => http.get(o('/builder')),
  createMenu: (name, kind) => http.post<{ id: string }>(o('/menus'), { name }).then(async (m) => { if (kind && kind !== 'standard') await http.patch(o(`/menus/${m.id}`), { kind }); return m; }),
  createItem: (menuId, body) => http.post(o(`/menus/${menuId}/items`), body),
  updateItem: (id, patch) => http.patch(o(`/items/${id}`), patch),
  archiveItem: (id) => http.del(o(`/items/${id}`)).then(ignore),
  createCategory: (menuId, body) => http.post(o(`/menus/${menuId}/categories`), body),
  updateCategory: (id, patch) => http.patch(o(`/categories/${id}`), patch),
  addModifierGroup: (itemId, body) => http.post(o(`/items/${itemId}/modifier-groups`), body),
  updateModifierGroup: (id, patch) => http.patch(o(`/modifier-groups/${id}`), patch).then(ignore),
  deleteModifierGroup: (id) => http.del(o(`/modifier-groups/${id}`)).then(ignore),
  addModifier: (groupId, body) => http.post(o(`/modifier-groups/${groupId}/modifiers`), body),
  deleteModifier: (id) => http.del(o(`/modifiers/${id}`)).then(ignore),
  createDayPart: (body) => http.post(o('/day-parts'), body),
  updateDayPart: (id, patch) => http.patch(o(`/day-parts/${id}`), patch),
  deleteDayPart: (id) => http.del(o(`/day-parts/${id}`)).then(ignore),
  publishPreview: (menuId) => http.get(o(`/menus/${menuId}/publish-preview`)),
  publish: (menuId, locationIds) => http.post(o(`/menus/${menuId}/publish`), locationIds ? { locationIds } : {}),
  retryPublish: (menuId) => http.post(o(`/menus/${menuId}/publish/retry`), {}),

  locationMenu: (locationId) => http.get(o(`/locations/${locationId}/menu`)),
  setItemSoldOut: (locationId, itemId, soldOut, untilClose) => http.put(o(`/locations/${locationId}/overrides/${itemId}`), { soldOut, untilClose }).then(ignore),
  setModifierSoldOut: (locationId, modifierId, soldOut, untilClose) => http.put(o(`/locations/${locationId}/modifiers/${modifierId}/sold-out`), { soldOut, untilClose }).then(ignore),
  settings: () => items(http.get(o('/settings'))),
  saveSettings: (locationId, body) => http.put(o(`/locations/${locationId}/settings`), body).then(ignore),

  kds: (locationId, stationId) => http.get(o('/kds'), { locationId, stationId: stationId ?? undefined }),
  ticket: (id, action, expectedStatus) => http.post(o(`/kds/tickets/${id}/${action}`), expectedStatus ? { expectedStatus } : {}),
  transition: (orderId, to, opts) => http.post(o(`/orders/${orderId}/transition`), { to, ...opts }),
  stations: (locationId) => items(http.get(o(`/locations/${locationId}/stations`))),
  createStation: (locationId, body) => http.post(o(`/locations/${locationId}/stations`), body),
  updateStation: (id, patch) => http.patch(o(`/stations/${id}`), patch),
  defaultStations: (locationId) => items(http.post(o(`/locations/${locationId}/stations/defaults`), {})),

  orders: (p) => items(http.get(o('/orders'), { locationId: p.locationId, channel: p.channel, status: p.status, active: p.active === false ? 'false' : 'true' })),
  zones: (locationId) => http.get(o(`/locations/${locationId}/delivery-zones`)),
  createZone: (locationId, body) => http.post(o(`/locations/${locationId}/delivery-zones`), body),
  updateZone: (id, patch) => http.patch(o(`/delivery-zones/${id}`), patch),
  deleteZone: (id) => http.del(o(`/delivery-zones/${id}`)).then(ignore),
  drivers: (locationId) => items(http.get(o(`/locations/${locationId}/drivers`))),
  createDriver: (locationId, body) => http.post(o(`/locations/${locationId}/drivers`), body),
  deliveries: (locationId, active = true) => items(http.get(o('/deliveries'), { locationId, active: active ? 'true' : 'false' })),
  dispatch: (orderId, provider, driverId) => http.post(o(`/orders/${orderId}/dispatch`), { provider, driverId }).then(ignore),
  deliveryStatus: (id, status, note) => http.post(o(`/deliveries/${id}/status`), { status, note }).then(ignore),
  sandboxAdvance: (id) => http.post(o(`/deliveries/${id}/sandbox-advance`), {}).then(ignore),
  providers: () => items(http.get(o('/delivery-providers'))),

  tables: (locationId) => items(http.get(o(`/locations/${locationId}/tables`))),
  createTable: (locationId, body) => http.post(o(`/locations/${locationId}/tables`), body),
  updateTable: (id, patch) => http.patch(o(`/tables/${id}`), patch),
  tabs: (locationId, status = 'open') => items(http.get(o(`/locations/${locationId}/tabs`), { status })),
  closeTab: (id, how) => http.post(o(`/tabs/${id}/close`), { how }),

  productionDates: (locationId) => http.get(o(`/locations/${locationId}/production-dates`)),
  createProductionDate: (locationId, body) => http.post(o(`/locations/${locationId}/production-dates`), body),
  updateProductionDate: (id, patch) => http.patch(o(`/production-dates/${id}`), patch),
  production: (locationId, date) => http.get(o(`/locations/${locationId}/production-summary`), { date }),
  packages: () => items(http.get(o('/catering/packages'))),
  createPackage: (body) => http.post(o('/catering/packages'), body),
  enquiries: (p = {}) => items(http.get(o('/catering/enquiries'), p)),
  enquiry: (id) => http.get(o(`/catering/enquiries/${id}`)),
  quote: (id, body) => http.post(o(`/catering/enquiries/${id}/quote`), body),
  enquiryStatus: (id, to, note) => http.post(o(`/catering/enquiries/${id}/status`), { to, note }),

  mealPlans: () => items(http.get(o('/meal-plans'))),
  createMealPlan: (body) => http.post(o('/meal-plans'), body),
  updateMealPlan: (id, patch) => http.patch(o(`/meal-plans/${id}`), patch),
  subscriptions: (p = {}) => items(http.get(o('/meal-plans/subscriptions'), p)),
  skipWeek: (id, weekStart, skip) => http.post<{ subscription: MealPlanSubscription }>(o(`/meal-plans/subscriptions/${id}/skip`), { weekStart, skip }).then((r) => r.subscription),
  generateBoxes: (weekStart, locationId) => http.post(o('/meal-plans/generate'), { weekStart, locationId }),
  releaseBoxes: (locationId, date) => http.post(o(`/locations/${locationId}/meal-plans/release`), { date }),

  ingredients: (locationId) => items(http.get(o('/ingredients'), { locationId })),
  createIngredient: (body) => http.post(o('/ingredients'), body),
  setStock: (locationId, ingredientId, body) => http.put(o(`/locations/${locationId}/ingredients/${ingredientId}`), body).then(ignore),
  movement: (locationId, ingredientId, body) => http.post(o(`/locations/${locationId}/ingredients/${ingredientId}/movements`), body),
  movements: (locationId, ingredientId) => items(http.get(o(`/locations/${locationId}/ingredients/${ingredientId}/movements`))),
  recipe: (itemId) => http.get<{ lines: Array<{ ingredientId: string; name: string; unit: string; quantity: number; modifierId: string | null }> }>(o(`/items/${itemId}/recipe`)).then((r) => r.lines),
  saveRecipe: (itemId, lines) => http.put(o(`/items/${itemId}/recipe`), { lines }).then(ignore),

  reports: (p) => http.get(o('/reports'), p),
  aiMenuCopy: (itemId, locale) => http.post(o('/ai/menu-copy'), { menuItemId: itemId, locale }),
  aiProductionSummary: (locationId, date) => http.post(o('/ai/production-summary'), { locationId, date }),
};

function withFallback(live: FoodsApi, mock: FoodsApi): FoodsApi {
  return new Proxy(live, {
    get(target, prop, receiver) {
      const lv = Reflect.get(target, prop, receiver) as unknown;
      const mv = Reflect.get(mock, prop) as unknown;
      if (typeof lv !== 'function') return lv;
      return async (...args: unknown[]) => {
        if (apiMode() === 'fallback') return (mv as (...a: unknown[]) => unknown)(...args);
        try {
          return await (lv as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (e) {
          if (e instanceof ApiError && e.isNetwork) {
            enterFallback();
            return (mv as (...a: unknown[]) => unknown)(...args);
          }
          throw e;
        }
      };
    },
  });
}

let instance: FoodsApi | null = null;
export async function getFoodsApi(): Promise<FoodsApi> {
  if (instance) return instance;
  const { mockFoodsApi } = await import('./mock');
  instance = USE_MOCKS ? mockFoodsApi : withFallback(liveFoodsApi, mockFoodsApi);
  return instance;
}

export const fmtBps = (bps: number, locale: string) => `${(bps / 100).toLocaleString(locale, { maximumFractionDigits: 2 })}%`;
