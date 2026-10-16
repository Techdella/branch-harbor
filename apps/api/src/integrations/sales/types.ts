/**
 * POS / booking sales connector contract. Every adapter speaks the vendor's documented API through an injected
 * `fetch` (tests use recorded fixtures, never the network) and returns sale records; the service buckets them into
 * `daily_sales` by the location's local business date, channel and currency.
 */
import type { SalesChannel, SalesConnectorProvider } from '@bh/shared';
import type { Config } from '../../config.ts';
import type { FetchLike } from '../partners/http.ts';

export type SalesCredentials = Record<string, string>;

/** One sale (or one refund) as the vendor reports it, in integer minor units of `currency`. */
export interface SaleRecord {
  /** When the sale closed (UTC). Bucketed by the location's local date unless `businessDate` is given. */
  at: Date | null;
  /** Vendor business date (YYYY-MM-DD) when the vendor has one (Toast). */
  businessDate?: string;
  channel: SalesChannel;
  currency: string;
  grossMinor: number;
  refundsMinor: number;
  taxMinor: number;
  tipsMinor: number;
  discountsMinor: number;
  /** 1 for a sale, 0 for a refund-only record. */
  orders: number;
}

export interface FetchSalesInput {
  creds: SalesCredentials;
  config: Record<string, unknown>;
  /** Local business dates, inclusive. */
  fromDate: string;
  toDate: string;
  /** The same window as UTC instants [fromUtc, toUtc). */
  fromUtc: Date;
  toUtc: Date;
  /** The location's currency (used when the vendor does not send one per amount). */
  currency: string;
  timeZone: string;
}

export interface ExternalLocation { id: string; name: string; currency?: string | null; timeZone?: string | null }

export interface ExchangeResult {
  creds: SalesCredentials;
  /** Non-secret settings learned during the exchange (merchant id, domain prefix, …). */
  config?: Record<string, unknown>;
  accountName?: string | null;
}

export interface SalesAdapter {
  provider: SalesConnectorProvider;
  /** Platform app credentials are configured (otherwise connections stay in sandbox). */
  platformReady(cfg: Config): boolean;
  /** OAuth providers: where the merchant authorises BranchHarbor. */
  authorizeUrl?(cfg: Config, a: { state: string; redirectUri: string; config: Record<string, unknown> }): string;
  /** OAuth providers: authorisation code → tokens. */
  exchangeCode?(cfg: Config, f: FetchLike, a: { code: string; redirectUri: string; config: Record<string, unknown>; query: Record<string, string> }): Promise<ExchangeResult>;
  /** Non-OAuth providers (partner grant / activation): verifies access and returns credentials to store. */
  activate?(cfg: Config, f: FetchLike, a: { config: Record<string, unknown> }): Promise<ExchangeResult & { activationUrl?: string | null }>;
  /** Refreshes expiring tokens; returns null when nothing changed. */
  refresh?(cfg: Config, f: FetchLike, creds: SalesCredentials, config: Record<string, unknown>, now: number): Promise<SalesCredentials | null>;
  listLocations(cfg: Config, f: FetchLike, creds: SalesCredentials, config: Record<string, unknown>): Promise<ExternalLocation[]>;
  fetchSales(cfg: Config, f: FetchLike, input: FetchSalesInput): Promise<SaleRecord[]>;
}

export const sale = (r: Partial<SaleRecord> & Pick<SaleRecord, 'currency'>): SaleRecord => ({
  at: null, channel: 'in_store', grossMinor: 0, refundsMinor: 0, taxMinor: 0, tipsMinor: 0, discountsMinor: 0, orders: 1, ...r,
});

/** `epoch seconds` / ISO strings → Date. */
export const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
