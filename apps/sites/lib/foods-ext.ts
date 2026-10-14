import type { Money } from './types';
import type { MenuItem, Slot } from './foods';

/** Full-product foods shapes (apps/api foods-public routes). */
export interface AllergenInfo { regime: string; status: 'declared' | 'not_provided'; items: Array<{ key: string; label: string; inRegime: boolean }> }
export type MenuItemX = MenuItem & {
  allergenInfo: AllergenInfo; unavailableCode: string | null; dayParts: Array<{ id: string; name: string; summary: string }>;
  modifierGroups: Array<MenuItem['modifierGroups'][number] & { required?: boolean; modifiers: Array<MenuItem['modifierGroups'][number]['modifiers'][number] & { soldOut?: boolean; allergens?: string[] }> }>;
};
export interface MenuX {
  location: { id: string; name: string; timeZone: string; currency: string; country: string; acceptingOrders: boolean };
  at: string; allergenRegime: string;
  channels: { pickup: boolean; delivery: boolean; dineIn: boolean; preorder: boolean; catering: boolean; mealPlans: boolean };
  tips: { presetsBps: number[]; allowCustom: boolean; channels: string[] } | null;
  serviceCharge: { bps: number; label: string; channels: string[] } | null;
  categories: Array<{ name: string; items: MenuItemX[] }>;
}
export interface CheckoutQuote {
  channel: string; currency: string;
  lines: Array<{ menuItemId: string; name: string; quantity: number; modifiers: string[]; unitPrice: Money; lineTotal: Money }>;
  subtotal: Money; serviceCharge: (Money & { label: string | null }) | null; deliveryFee: Money | null; tax: Money | null; taxRateBps: number | null; tip: Money | null; total: Money;
  zone: { id: string; name: string; minimumOrder: Money; freeDeliveryAbove: Money | null } | null;
  tips: { presetsBps: number[]; allowCustom: boolean } | null; table: { label: string } | null; promisedAt: string | null; orderBy: string | null;
}
export interface DeliveryCheck { deliverable: boolean; reason: string | null; zone: null | { name: string; fee: Money; minimumOrder: Money; freeDeliveryAbove: Money | null } }
export interface ProductionDateX { id: string; date: string; cutoffAt: string; collectionWindows: string[]; remaining: number; available: boolean; menuId: string | null; note: string | null }
export type { Slot };
export interface TableInfo {
  table: { code: string; label: string; seats: number; area: string | null };
  location: { id: string; name: string; slug: string; orgSlug: string; brand: string; timeZone: string; currency: string };
  dineInEnabled: boolean; kitchenOpen: boolean; closesAt: string | null; openTab: boolean; payments: boolean;
}
export interface TabX { id: string; tableLabel: string | null; status: string; orders: Array<{ id: string; orderNumber: string; status: string; total: Money }>; subtotal: Money; serviceCharge: Money; tax: Money; tip: Money; total: Money; amountDue: Money }
export interface CateringPackageX { id: string; name: string; description: string | null; pricePerGuest: Money | null; minGuests: number; maxGuests: number | null; leadDays: number; includes: string[]; dietary: string[]; allergens: string[]; allergenStatus: string }
export interface CateringEnquiryX {
  id: string; reference: string; status: string; eventDate: string; eventTime: string | null; guests: number; fulfilment: string; packageName: string | null;
  quote: null | { version: number; lines: Array<{ description: string; quantity: number; unitPrice: Money; total: Money }>; subtotal: Money; serviceCharge: Money | null; deliveryFee: Money | null; tax: Money | null; total: Money; deposit: Money; validUntil: string; terms: string | null };
  location?: { name: string; timeZone: string };
}
export interface MealPlanX { id: string; name: string; description: string | null; price: Money | null; mealsPerBox: number; fulfilment: string; fulfilmentWeekday: number; firstWeek: string; firstFulfilmentDate: string; firstCutoffAt: string }
export interface SubscriptionX {
  id: string; planName: string; status: string; price: Money; startWeek: string; skippedWeeks: string[]; sandbox: boolean; locationName: string;
  upcoming: Array<{ weekStart: string; fulfilmentDate: string; cutoffAt: string; skipped: boolean; canChange: boolean }>;
}
export interface TrackedOrder {
  id: string; orderNumber: string; status: string; paymentStatus: string; channel: string; locationId: string;
  lines: Array<{ name: string; quantity: number; modifiers: Array<{ name: string }>; lineTotalMinor: number }>;
  subtotal: Money; tax: Money; serviceCharge: Money; deliveryFee: Money; tip: Money; total: Money; promisedAt: string | null; rejectionReason: string | null; updatedAt: string;
  fulfilment: { tableLabel?: string; zoneName?: string; address?: { line1?: string; city: string; postalCode: string }; serviceChargeLabel?: string; productionDate?: string; collectionWindow?: string };
  delivery?: { status: string; provider: string; trackingUrl: string | null; driverFirstName: string | null } | null;
}
