/**
 * Delivery provider SANDBOX adapters. Live delivery goes through the real Uber Direct client
 * (integrations/partners/uber-direct.ts) when a location has a complete, live Uber Direct connection — see
 * services/foods-partners.ts. Without one, the provider runs here: deterministic fake ids, a sandbox tracking URL
 * and status changes driven by `advance()` (exposed to staff as "simulate provider update"). Nothing is sent.
 * Deliverect is used for POS injection and marketplace orders; its dispatch option stays sandbox-only.
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
  readonly mode: 'sandbox';
  quote(input: Pick<CreateDeliveryInput, 'currency'>): Promise<{ feeMinor: number; currency: string; etaMinutes: number }>;
  createDelivery(input: CreateDeliveryInput): Promise<{ externalId: string; trackingUrl: string | null; feeMinor: number | null; sandbox: boolean }>;
  cancel(externalId: string): Promise<void>;
  /** Sandbox only: the next status the provider would report. */
  advance(current: ProviderDeliveryStatus): ProviderDeliveryStatus | null;
}

const NEXT: Partial<Record<ProviderDeliveryStatus, ProviderDeliveryStatus>> = { pending: 'assigned', assigned: 'picked_up', picked_up: 'delivered' };

function sandboxAdapter(key: DeliveryProviderKey, name: string): DeliveryProviderAdapter {
  return {
    key, name, mode: 'sandbox',
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
  uber_direct: sandboxAdapter('uber_direct', 'Uber Direct'),
  deliverect: sandboxAdapter('deliverect', 'Deliverect'),
};

export function deliveryProvider(key: DeliveryProviderKey): DeliveryProviderAdapter {
  return adapters[key];
}

/** Platform-level status (per-location live status comes from the partner connections). */
export function deliveryProvidersStatus() {
  return Object.values(adapters).map((a) => ({ key: a.key, name: a.name, mode: a.mode as 'sandbox' | 'live' }));
}
