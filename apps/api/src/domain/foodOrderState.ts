import type { foodOrderStates } from '@bh/shared';

export type FoodOrderState = (typeof foodOrderStates)[number];

/** Allowed restaurant-side transitions. Rejection/cancellation trigger refund or void. */
export const FOOD_ORDER_TRANSITIONS: Record<FoodOrderState, readonly FoodOrderState[]> = {
  awaiting_acceptance: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['collected'],
  collected: [],
  cancelled: [],
  rejected: [],
};

export function canTransition(from: FoodOrderState, to: FoodOrderState): boolean {
  return FOOD_ORDER_TRANSITIONS[from].includes(to);
}

/** Transitions that must return the customer's money. */
export function requiresRefund(to: FoodOrderState): boolean {
  return to === 'rejected' || to === 'cancelled';
}
