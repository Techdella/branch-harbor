import { seededUnit, type SalesConnectorProvider } from '@bh/shared';
import { cloverAdapter } from './clover.ts';
import { lightspeedAdapter } from './lightspeed.ts';
import { mindbodyAdapter } from './mindbody.ts';
import { shopifyAdapter } from './shopify.ts';
import { squareAdapter } from './square.ts';
import { toastAdapter } from './toast.ts';
import { sale, type SaleRecord, type SalesAdapter } from './types.ts';

export const SALES_ADAPTERS: Record<SalesConnectorProvider, SalesAdapter> = {
  square: squareAdapter, toast: toastAdapter, mindbody: mindbodyAdapter, shopify: shopifyAdapter, lightspeed: lightspeedAdapter, clover: cloverAdapter,
};

/**
 * Sandbox sales (no credentials): deterministic sample figures per connection and business date, so mapping, sync
 * status, reconciliation and royalties can be exercised end to end. Always flagged `sandbox` and never presented as
 * real sales.
 */
export function sandboxSales(seed: string, dates: string[], currency: string): Array<SaleRecord & { businessDate: string }> {
  const out: Array<SaleRecord & { businessDate: string }> = [];
  for (const d of dates) {
    const u = seededUnit(`${seed}:${d}`);
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    const scale = currency === 'JPY' ? 1 : 100;
    const base = Math.round((900 + u * 900) * (weekday === 0 || weekday === 6 ? 1.35 : 1) * scale);
    const orders = 20 + Math.round(u * 40);
    const tax = Math.round(base * 0.08);
    const tips = Math.round(base * 0.04);
    out.push({ ...sale({ currency, channel: 'in_store', grossMinor: base + tax + tips, taxMinor: tax, tipsMinor: tips, discountsMinor: Math.round(base * 0.02), refundsMinor: u > 0.8 ? Math.round(base * 0.03) : 0, orders }), businessDate: d });
    const online = Math.round(base * 0.18);
    out.push({ ...sale({ currency, channel: 'online', grossMinor: online + Math.round(online * 0.08), taxMinor: Math.round(online * 0.08), orders: Math.max(1, Math.round(orders * 0.15)) }), businessDate: d });
  }
  return out;
}

export type { SaleRecord, SalesAdapter } from './types.ts';
