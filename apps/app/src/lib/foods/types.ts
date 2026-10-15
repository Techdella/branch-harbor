/**
 * Foods (full product) view models. They mirror the apps/api response shapes (see apps/api README,
 * "foods — full product"), so the client passes responses through.
 */
import type { Money } from '@bh/shared';

export type Translations = Record<string, { name?: string; description?: string }>;
export interface DayPartWindow { weekday: number; start: string; end: string }
export interface DayPart { id: string; name: string; translations: Translations; windows: DayPartWindow[]; sortOrder: number; active: boolean }

export interface BuilderModifier { id: string; name: string; prices: Record<string, number>; allergens: string[]; available: boolean; translations: Translations; sortOrder: number }
export interface BuilderModifierGroup { id: string; name: string; minSelect: number; maxSelect: number; translations: Translations; modifiers: BuilderModifier[] }
export interface BuilderItem {
  id: string; menuId: string; categoryId: string | null; category: string; name: string; description: string | null; prices: Record<string, number>;
  dietary: string[]; allergens: string[]; allergensDeclared: boolean; translations: Translations; dayPartIds: string[]; stationKey: string | null; prepMinutes: number | null;
  imageUrl: string | null; localOverridable: string[]; sortOrder: number; active: boolean; modifierGroups: BuilderModifierGroup[];
}
export interface BuilderCategory { id: string; menuId: string; name: string; description: string | null; translations: Translations; dayPartIds: string[]; sortOrder: number; active: boolean }
export interface Publication { menuId: string; locationId: string; status: 'succeeded' | 'partial' | 'failed' | 'skipped'; publishedAt: string; detail: { available: number; unavailable: Array<{ id: string; name: string; reason: string | null }>; reason?: string } }
export interface BuilderMenu { id: string; name: string; kind: 'standard' | 'preorder' | 'catering'; status: string; description: string | null; dayPartIds: string[]; publishedAt: string | null; categories: BuilderCategory[]; items: BuilderItem[]; publications: Publication[] }
export interface BuilderLocation { id: string; name: string; currency: string; country: string; timeZone: string; status: string; defaultAllergenRegime: string }
export interface Builder { menus: BuilderMenu[]; dayParts: DayPart[]; locations: BuilderLocation[] }
export interface Vocabulary { allergens: Array<{ key: string; label: string }>; regimes: Array<{ key: string; label: string; allergens: string[] }>; dietary: string[]; note: string }

export interface PublishPreview {
  menu: { id: string; name: string; kind: string; status: string; activeItems: number };
  locations: Array<{ locationId: string; name: string; currency: string; status: string; wouldBe: 'succeeded' | 'partial' | 'failed'; sellable: number; available: number; unavailable: Array<{ id: string; name: string; reason: string | null }>; reason: string | null; lastPublish: { status: string; at: string } | null }>;
}
export interface PublishResult { locations: Array<{ locationId: string; name: string; currency: string; status: 'succeeded' | 'partial' | 'failed' | 'skipped'; available: number; unavailable: Array<{ id: string; name: string; reason: string | null }>; reason: string | null }>; summary: Record<'succeeded' | 'partial' | 'failed' | 'skipped', number> }

export interface EffectiveItem {
  id: string; name: string; category: string; price: Money | null; available: boolean; unavailableReason: string | null; unavailableCode: string | null;
  soldOutSource: 'manual' | 'ingredient' | null; soldOutUntil: string | null; dietary: string[];
  allergenInfo: { regime: string; status: 'declared' | 'not_provided'; items: Array<{ key: string; label: string; inRegime: boolean }> };
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; required: boolean; modifiers: Array<{ id: string; name: string; price: Money | null; available: boolean; soldOut: boolean }> }>;
}

export interface FoodConfig {
  channels: { pickup: boolean; delivery: boolean; dineIn: boolean; preorder: boolean; catering: boolean; mealPlans: boolean };
  tips: { enabled: boolean; presetsBps: number[]; allowCustom: boolean; channels: string[] };
  serviceCharge: { bps: number; label: string; channels: string[] };
  allergenRegime: string | null;
  delivery: { provider: 'own' | 'uber_direct' | 'deliverect'; hours: Array<{ weekday: number; open: string; close: string }>; slotMinutes: number; slotCapacity: number; leadMinutes: number; cutoffMinutes: number; horizonDays: number };
  kds: { audibleDefault: boolean; defaultPrepMinutes: number };
  autoSoldOutOnIngredients: boolean;
}
export interface LocationSettings { locationId: string; name: string; currency: string; country: string; timeZone: string; taxRateBps: number | null; config: FoodConfig; allergenRegime: string }

export interface FoodsOverviewLocation {
  locationId: string; name: string; timeZone: string; currency: string; orders: Record<string, number>; overdue: number; byChannel: Record<string, number>;
  pickupCapacityToday: { capacity: number; booked: number; remaining: number; slots: number } | null; pickupCapacityUnavailableReason: string | null;
  soldOut: Array<{ id: string; name: string; source: string | null; until: string | null }>; lowStock: Array<{ name: string; onHand: number; unit: string; threshold: number }>;
  catering: { new: number; depositPaid: number; awaitingDeposit: number }; mealPlansActive: number; deliveries: { active: number; ordersAwaitingDispatch: number };
}
export interface FoodsOverview { refreshedAt: string; locations: FoodsOverviewLocation[]; integrations: Array<{ key: string; name: string; mode: string }> }

export interface Station { id: string; locationId: string; key: string; name: string; prepTargetMinutes: number; isExpo: boolean; sortOrder: number; active: boolean }
export interface KdsTicket {
  id: string; orderId: string; orderNumber: string; firstName: string; channel: string; tableLabel: string | null; stationId: string; stationName: string; status: 'queued' | 'in_progress' | 'done'; orderStatus: string;
  lines: Array<{ index: number; name: string; quantity: number; modifiers: string[]; notes?: string }>; orderNotes: string | null; promisedAt: string | null; targetAt: string; createdAt: string;
  startedAt: string | null; bumpedAt: string | null; ageMinutes: number; overdue: boolean; overdueMinutes: number; recalledCount: number;
}
export interface KdsOrder {
  id: string; orderNumber: string; firstName: string; channel: string; tableLabel: string | null; status: string; promisedAt: string | null; createdAt: string; notes: string | null;
  lines: Array<{ name: string; quantity: number; modifiers: string[]; notes?: string }>; stations: Array<{ ticketId: string; stationId: string; name: string; status: string }>; allStationsDone: boolean; overdue: boolean; overdueMinutes: number;
}
export interface KdsFeed {
  location: { id: string; name: string; timeZone: string }; refreshedAt: string; audibleDefault: boolean; view: 'station' | 'expo';
  stations: Array<{ id: string; key: string; name: string; prepTargetMinutes: number; isExpo: boolean; open: number }>; station: { id: string; name: string; key: string } | null; tickets: KdsTicket[]; orders: KdsOrder[];
}

export interface DeliveryZone { id: string; locationId: string; name: string; kind: 'radius' | 'postcode'; radiusMeters: number | null; postcodes: string[]; fee: Money; minimumOrder: Money; freeDeliveryAbove: Money | null; active: boolean; sortOrder: number }
export interface Driver { id: string; locationId: string; userId: string | null; name: string; phone: string | null; active: boolean }
export interface Delivery {
  id: string; orderId: string; locationId: string; provider: string; status: string; externalId: string | null; trackingUrl: string | null; sandbox: boolean; feeQuote: Money | null;
  driver: { id: string; name: string; phone: string | null } | null; events: Array<{ at: string; status: string; by: string | null; note?: string }>; updatedAt: string;
  order: { id: string; orderNumber: string; status: string; promisedAt: string | null; address: { line1: string; city: string; postalCode: string; instructions?: string } | null; zoneName: string | null; customerFirstName: string; total: Money };
}
export interface FoodOrderLite {
  id: string; orderNumber: string; locationId: string; status: string; paymentStatus: string; channel: string; total: Money; promisedAt: string | null; contact: { name: string };
  fulfilment: { zoneName?: string; tableLabel?: string; address?: { city: string; postalCode: string }; marketplace?: { channelName: string; courier: 'channel' | 'restaurant'; channelOrderDisplayId: string }; pos?: { status: string } }; lines: Array<{ name: string; quantity: number }>; createdAt: string; overdue?: boolean;
}

export interface Table { id: string; locationId: string; label: string; code: string; seats: number; area: string | null; active: boolean; openTabId: string | null }
export interface Tab { id: string; tableId: string; tableLabel: string | null; locationId: string; status: string; guestName: string | null; paidVia: string | null; openedAt: string; closedAt: string | null; orders: Array<{ id: string; orderNumber: string; status: string; total: Money }>; subtotal: Money; serviceCharge: Money; tax: Money; tip: Money; total: Money; amountDue: Money }

export interface ProductionDate { id: string; locationId: string; date: string; cutoffAt: string; collectionWindows: string[]; capacity: number; booked: number; remaining: number; status: string; note: string | null; cutoffPassed: boolean; menuId: string | null }
export interface ProductionSummary {
  location: { id: string; name: string; timeZone: string }; date: string; generatedAt: string;
  counts: { orders: number; byChannel: Record<string, number>; cateringEvents: number; guests: number; mealPlanBoxes: number };
  stations: Array<{ key: string; name: string; items: Array<{ name: string; quantity: number; modifiers: Array<{ name: string; quantity: number }> }> }>;
  catering: Array<{ id: string; reference: string; guests: number; eventTime: string | null; status: string; fulfilment: string; dietaryNotes: string | null }>;
}
export interface CateringPackage { id: string; name: string; description: string | null; pricesPerGuest: Record<string, number>; minGuests: number; maxGuests: number | null; leadDays: number; includes: string[]; dietary: string[]; allergens: string[]; allergensDeclared: boolean; locationIds: string[]; active: boolean }
export interface CateringQuoteView {
  version: number; lines: Array<{ description: string; quantity: number; unitPrice: Money; total: Money }>; subtotal: Money; serviceCharge: Money | null; deliveryFee: Money | null; tax: Money | null; taxRateBps: number | null;
  total: Money; deposit: Money; validUntil: string; terms: string | null; sentAt: string;
}
export interface CateringEnquiry {
  id: string; reference: string; locationId: string; status: string; eventDate: string; eventTime: string | null; guests: number; packageId: string | null; packageName: string | null; fulfilment: string;
  notes: string | null; dietaryNotes: string | null; contact: { name: string; email?: string; phone?: string }; quote: CateringQuoteView | null; depositPaymentId: string | null;
  acceptedAt: string | null; depositPaidAt: string | null; confirmedAt: string | null; declinedReason: string | null; statusHistory: Array<{ at: string; from: string | null; to: string; note?: string }>; createdAt: string;
}
export interface MealPlan { id: string; name: string; description: string | null; mealsPerBox: number; pricesPerWeek: Record<string, number>; fulfilment: 'pickup' | 'delivery'; fulfilmentWeekday: number; cutoffDaysBefore: number; cutoffTime: string; menuItemIds: string[]; locationIds: string[]; active: boolean; subscribers?: Record<string, number> }
export interface MealPlanSubscription {
  id: string; planId: string; planName: string; locationId: string; locationName: string; status: string; price: Money; startWeek: string; skippedWeeks: string[]; sandbox: boolean; fulfilment: string;
  contact: { name: string; email?: string }; upcoming: Array<{ weekStart: string; fulfilmentDate: string; cutoffAt: string; skipped: boolean; canChange: boolean }>; createdAt: string;
}
export interface Ingredient {
  id: string; name: string; unit: 'g' | 'ml' | 'each'; sku: string | null;
  stock: { onHand: number; lowStockThreshold: number; autoSoldOut: boolean; lowStock: boolean; exhausted: boolean; updatedAt: string } | null;
  usedBy: Array<{ menuItemId: string; name: string; quantity: number; viaModifier: boolean }>;
}
export interface IngredientMovement { id: string; delta: number; reason: string; balanceAfter: number; note: string | null; createdAt: string; orderId: string | null }

export interface FoodsReport {
  range: { from: string; to: string }; generatedAt: string; empty: boolean; combinedRevenue: null; combinedRevenueReason?: string;
  ordersByChannel: Array<{ channel: string; orders: number; cancelledOrRejected: number; revenue: Money[] }>;
  revenueByCurrency: Array<{ currency: string; orders: number; gross: Money; tax: Money; tips: Money; deliveryFees: Money; serviceCharges: Money; averageOrder: Money }>;
  prepTimes: { definition: string; locations: Array<{ locationId: string; name: string; orders: number; medianMinutes: number | null; p90Minutes: number | null; onTimeRate: number | null }>; stations: Array<{ stationId: string; name: string; targetMinutes: number; tickets: number; medianMinutes: number | null; overTarget: number }> | null; stationsUnavailableReason: string | null } | null;
  soldOut: Array<{ id: string; name: string; kind: string; times: number; minutesSoldOut: number; sources: string[]; locations: number }>;
  catering: { definition: string; stages: Array<{ status: string; count: number; value: Money[] }>; conversionRate: number | null } | null;
  mealPlans: Array<{ currency: string; active: number; paused: number; cancelled: number; weeklyRecurring: Money }>;
}
