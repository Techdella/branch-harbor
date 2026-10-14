import type { Money } from './types';

export interface MenuItem {
  id: string; category: string; name: string; description: string | null; dietary: string[]; allergens: string[]; imageUrl: string | null;
  price: Money | null; available: boolean; unavailableReason: string | null;
  modifierGroups: Array<{ id: string; name: string; minSelect: number; maxSelect: number; modifiers: Array<{ id: string; name: string; price: Money | null; available: boolean }> }>;
}
export interface Menu { location: { id: string; name: string; timeZone: string; currency: string; acceptingOrders: boolean }; categories: Array<{ name: string; items: MenuItem[] }> }
export interface Slot { id: string; startsAt: string; endsAt: string; remaining: number; available: boolean; cutoffAt: string }
export interface Quote {
  currency: string;
  lines: Array<{ menuItemId: string; name: string; quantity: number; modifiers: string[]; unitPrice: Money; lineTotal: Money }>;
  subtotal: Money; tax: Money | null; taxRateBps: number | null; total: Money;
}
export interface FoodOrder {
  id: string; orderNumber: string; status: string; paymentStatus: string;
  lines: Array<{ name: string; quantity: number; modifiers: Array<{ name: string }>; lineTotalMinor: number }>;
  subtotal: Money; tax: Money; total: Money; promisedAt: string | null; rejectionReason: string | null; updatedAt: string;
}
