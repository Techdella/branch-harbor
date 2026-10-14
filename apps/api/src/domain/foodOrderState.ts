import type { foodOrderStatesAll } from '@bh/shared';

export type FoodOrderState = (typeof foodOrderStatesAll)[number];

/** Allowed restaurant-side transitions. Rejection/cancellation trigger refund or void. */
export const FOOD_ORDER_TRANSITIONS: Record<FoodOrderState, readonly FoodOrderState[]> = {
  awaiting_acceptance: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['collected', 'out_for_delivery', 'served'],
  out_for_delivery: ['delivered', 'cancelled'],
  collected: [],
  delivered: [],
  served: [],
  cancelled: [],
  rejected: [],
};

/** How an order that is ready leaves the kitchen, per channel. */
const READY_EXIT: Record<string, FoodOrderState> = {
  pickup: 'collected', preorder: 'collected', catering: 'collected', meal_plan: 'collected', delivery: 'out_for_delivery', dine_in: 'served',
};

export function canTransition(from: FoodOrderState, to: FoodOrderState, channel?: string): boolean {
  if (!FOOD_ORDER_TRANSITIONS[from]?.includes(to)) return false;
  if (from === 'ready' && channel) {
    const exit = READY_EXIT[channel] ?? 'collected';
    // Meal-plan and catering deliveries may also be handed to a driver.
    if (to === 'out_for_delivery') return channel === 'delivery' || channel === 'meal_plan' || channel === 'catering';
    return to === exit;
  }
  return true;
}

/** The next "happy path" state for a channel (used by kitchen buttons). */
export function nextState(from: FoodOrderState, channel = 'pickup'): FoodOrderState | null {
  switch (from) {
    case 'awaiting_acceptance': return 'accepted';
    case 'accepted': return 'preparing';
    case 'preparing': return 'ready';
    case 'ready': return READY_EXIT[channel] ?? 'collected';
    case 'out_for_delivery': return 'delivered';
    default: return null;
  }
}

/** Transitions that must return the customer's money. */
export function requiresRefund(to: FoodOrderState): boolean {
  return to === 'rejected' || to === 'cancelled';
}

export const ACTIVE_FOOD_STATES: FoodOrderState[] = ['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'out_for_delivery'];
