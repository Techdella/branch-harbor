import { describe, expect, it } from 'vitest';
import { foodOrderStates } from '@bh/shared';
import { canTransition, FOOD_ORDER_TRANSITIONS, requiresRefund } from '../src/domain/foodOrderState.ts';

describe('food order transitions', () => {
  it('follows awaiting_acceptance → accepted → preparing → ready → collected', () => {
    expect(canTransition('awaiting_acceptance', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'preparing')).toBe(true);
    expect(canTransition('preparing', 'ready')).toBe(true);
    expect(canTransition('ready', 'collected')).toBe(true);
  });
  it('rejects skipping or reversing steps', () => {
    expect(canTransition('awaiting_acceptance', 'ready')).toBe(false);
    expect(canTransition('ready', 'preparing')).toBe(false);
    expect(canTransition('collected', 'cancelled')).toBe(false);
    expect(canTransition('accepted', 'rejected')).toBe(false);
  });
  it('terminal states have no exits and rejection/cancellation trigger refunds', () => {
    for (const t of ['collected', 'cancelled', 'rejected'] as const) expect(FOOD_ORDER_TRANSITIONS[t]).toHaveLength(0);
    expect(requiresRefund('rejected')).toBe(true);
    expect(requiresRefund('cancelled')).toBe(true);
    expect(requiresRefund('collected')).toBe(false);
  });
  it('covers every shared state', () => {
    for (const st of foodOrderStates) expect(FOOD_ORDER_TRANSITIONS[st]).toBeDefined();
  });
});
