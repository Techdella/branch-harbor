/**
 * Delivery provider adapters (integration point). Uber Direct and Deliverect implement the same interface.
 * Without credentials each runs in SANDBOX mode: deterministic fake ids, a fake tracking URL and status
 * changes driven by `advance()` (exposed to staff as "simulate provider update"). Live HTTP calls are not
 * wired yet: with credentials present the adapter reports `disabled` until the live client is implemented,
 * so nothing is ever sent to a provider by accident.
 */
import { randomBytes } from 'node:crypto';

export type DeliveryProviderKey = 'uber_direct' | 'deliverect';
export type ProviderDeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'delivered' | 'failed' | 'cancelled';

export interface CreateDeliveryInput {
  reference: string;
  pickup: { name: string; address: Record<string, unknown>; phone: string | null };
  dropoff: { name: string; phone: string | null; address: Record<string, unknown> };
  readyAt: Date;
  valueMinor: number;
  currency: string;
}

export interface DeliveryProviderAdapter {
  readonly key: DeliveryProviderKey;
  readonly name: string;
  readonly mode: 'sandbox' | 'live' | 'disabled';
  quote(input: CreateDeliveryInput): Promise<{ feeMinor: number; currency: string; etaMinutes: number }>;
  createDelivery(input: CreateDeliveryInput): Promise<{ externalId: string; trackingUrl: string | null; feeMinor: number | null; sandbox: boolean }>;
  cancel(externalId: string): Promise<void>;
  /** Sandbox only: the next status the provider would report. */
  advance(current: ProviderDeliveryStatus): ProviderDeliveryStatus | null;
}

const NEXT: Partial<Record<ProviderDeliveryStatus, ProviderDeliveryStatus>> = { pending: 'assigned', assigned: 'picked_up', picked_up: 'delivered' };

function sandboxAdapter(key: DeliveryProviderKey, name: string, envKeys: string[]): DeliveryProviderAdapter {
  const configured = envKeys.every((k) => !!process.env[k]);
  const mode = configured ? 'disabled' : 'sandbox';
  return {
    key, name, mode,
    async quote(input) {
      // Sandbox quote: a flat fee in the order currency (illustrative, not a provider price).
      return { feeMinor: input.currency === 'JPY' ? 600 : 599, currency: input.currency, etaMinutes: 35 };
    },
    async createDelivery(input) {
      const id = `${key === 'uber_direct' ? 'del' : 'dlv'}_sandbox_${randomBytes(6).toString('hex')}`;
      return { externalId: id, trackingUrl: `https://sandbox.branchharbor.com/track/${id}`, feeMinor: (await this.quote(input)).feeMinor, sandbox: true };
    },
    async cancel() { /* sandbox: nothing to cancel remotely */ },
    advance: (current) => NEXT[current] ?? null,
  };
}

const adapters: Record<DeliveryProviderKey, DeliveryProviderAdapter> = {
  uber_direct: sandboxAdapter('uber_direct', 'Uber Direct', ['UBER_DIRECT_CLIENT_ID', 'UBER_DIRECT_CLIENT_SECRET', 'UBER_DIRECT_CUSTOMER_ID']),
  deliverect: sandboxAdapter('deliverect', 'Deliverect', ['DELIVERECT_CLIENT_ID', 'DELIVERECT_CLIENT_SECRET']),
};

export function deliveryProvider(key: DeliveryProviderKey): DeliveryProviderAdapter {
  return adapters[key];
}

export function deliveryProvidersStatus() {
  return Object.values(adapters).map((a) => ({ key: a.key, name: a.name, mode: a.mode }));
}
