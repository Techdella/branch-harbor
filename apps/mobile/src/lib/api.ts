import { useEffect, useState } from 'react';
import { ApiError } from './errors';
import { guestContact, liveApi, serverPaymentsSandbox, type GuestContact } from './live';

export { ApiError, guestContact, type GuestContact };

export type BranchHarborApi = typeof liveApi;

/**
 * Typed client used by every screen: maps each call onto the real apps/api routes (src/lib/live.ts — see the
 * endpoint table in apps/mobile/README.md). There is no sample data: when the API is unreachable, calls fail and
 * screens show their offline / error states.
 */
export const api: BranchHarborApi = liveApi;

/** Whether "simulate payment" may be offered: the API runs payments in sandbox mode (no Stripe keys). */
export function usePaymentsSandbox(): boolean {
  const [sandbox, setSandbox] = useState(false);
  useEffect(() => {
    let alive = true;
    void serverPaymentsSandbox().then((v) => alive && setSandbox(v));
    return () => {
      alive = false;
    };
  }, []);
  return sandbox;
}
