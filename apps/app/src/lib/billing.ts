/**
 * BranchHarbor plan billing (Settings → Billing), franchisee billing and the free data export. Calls the API directly:
 *   GET  /orgs/:id/billing, /billing/quote            — plan, paid trial, who pays, invoices; price from a billing country
 *   POST /orgs/:id/billing/checkout (+ /confirm)      — paid 14-day trial with the billing-country lock
 *   POST /orgs/:id/billing/cancel | /resume           — cancel before renewal (no fee) or withdraw it
 *   POST /orgs/:id/billing/country (+ /confirm)       — billing country change, next cycle
 *   PUT  /orgs/:id/billing/payers                     — who pays a location's fee (network)
 *   GET  /orgs/:id/franchisee-billing (+ setup/confirm) — franchisee view
 *   POST/GET /orgs/:id/exports                        — Export your data (owner only)
 */
import type { Currency } from '@bh/shared';
import { API_URL, getAccessToken, http, refreshAccessToken } from './http/client';
import { orgId } from './http/workspace';
import { ApiError } from './errors';

export type PlanKey = 'solo' | 'connector' | 'hosted' | 'network';
export type Interval = 'month' | 'year';
export type Payer = 'hq' | 'franchisee' | 'split';
export interface Amount { amount: number; currency: Currency }

export interface Quote {
  priceList: string; currency: Currency; tier: string; plan: PlanKey; interval: Interval; locations: number; includedLocations: number;
  /** Brands the business runs: each brand beyond the first is a `brand` line (extra brand fee). */
  brands?: number;
  lines: { kind: 'plan' | 'platform' | 'location' | 'brand'; quantity: number; unitMinor: number; amountMinor: number }[];
  totalMinor: number; trialFeeMinor: number; trialDays: number;
}

export interface Terms { trialDays: number; reminderDays: number[]; autoStarts: boolean; cancelAnytime: boolean; cancellationFee: boolean; freeDataExport: boolean; annualMonthsIncluded: number; taxExclusive: boolean; taxCollected: boolean }

export interface Invoice { id: string; number: string; kind: 'trial_fee' | 'subscription' | 'franchisee_fee'; payer: string; status: string; total: Amount; tax: Amount; periodStart: string | null; periodEnd: string | null; hostedUrl: string | null; createdAt: string }

export interface LocationRow {
  id: string; name: string; status: string; ownerGroupId: string | null; country: string; included: boolean; payer: Payer; franchiseePercent: number;
  source: 'location' | 'owner_group' | 'default'; feeMinor: number; hqMinor: number; franchiseeMinor: number;
}

export interface BillingView {
  status: 'checkout_required' | 'trialing' | 'active' | 'past_due' | 'canceled' | string;
  plan: PlanKey; plans: PlanKey[]; businessModel: 'independent' | 'network'; interval: Interval;
  billingCountry: string; countryLocked: boolean; countryEvidence: 'card' | 'tax_id' | 'none' | null; currency: Currency; priceList: string; tier: string;
  trial: { days: number; fee: Amount; endsAt: string | null; daysLeft: number | null; remindersSent: number[] };
  cancelAtPeriodEnd: boolean; canceledAt: string | null; currentPeriodEnd: string | null; nextChargeAt: string | null;
  quote: Quote; hqTotal: Amount & { interval: Interval }; platformFee: (Amount & { includedLocations: number }) | null;
  card: { brand: string | null; last4: string | null; country: string | null } | null; taxId: string | null;
  pendingChange: { status: string; billingCountry: string; currency: Currency; effectiveAt: string | null } | null;
  locations: LocationRow[];
  payers: { id: string; scopeKind: 'location' | 'owner_group'; scopeId: string; payer: Payer; franchiseePercent: number }[];
  ownerGroups: { id: string; name: string }[];
  invoices: Invoice[];
  provider: 'stripe' | 'sandbox'; publishableKey: string | null;
  terms: Terms;
  collectionFee: { perCollection: Amount; monthlyCapPerLocation: Amount };
  paymentFeeBps: number;
  trialEligibility: { eligible: boolean; reason: string | null } | null;
}

/** A plan or interval switch: new price and the prorated amount for the rest of the current period. */
export interface ChangePreview {
  from: { plan: PlanKey; interval: Interval; hqTotal: Amount };
  to: { plan: PlanKey; interval: Interval; hqTotal: Amount };
  quote: Quote;
  proration: Amount;
  effective: 'now' | 'trial_end';
  /** When the prorated amount is charged: now (monthly ↔ annual starts a new period), on the next invoice, or nothing (trial). */
  charge?: 'now' | 'next_invoice' | 'none';
  effectiveAt: string | null;
  nextChargeAt: string | null;
  unchanged: boolean;
}

export interface SetupInfo { mode: 'live' | 'sandbox'; clientSecret: string | null; publishableKey: string | null; setupIntentId: string }

export interface FranchiseeView {
  plan: PlanKey; interval: Interval; hqStatus: string;
  locations: { locationId: string; name: string; payer: Payer; franchiseePercent: number; included: boolean; amount: Amount; accountId: string | null }[];
  accounts: {
    id: string; scopeKind: 'location' | 'owner_group'; scopeId: string; billingCountry: string; currency: Currency; status: string; card: { brand: string | null; last4: string | null; country: string | null } | null;
    /** The franchisee's own subscription: status, next charge (date and amount, in the account's currency). */
    subscription?: { status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'scheduled' | 'none' | string; interval: Interval; nextChargeAt: string | null; nextCharge: Amount; startsWithHqPlan: boolean };
  }[];
  scopes: { kind: 'location' | 'owner_group'; id: string }[];
  invoices: Invoice[];
  provider: 'stripe' | 'sandbox'; publishableKey: string | null;
}

export interface DataExport { id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; fileName: string | null; sizeBytes: number | null; files: { name: string; rows: number }[]; expiresAt: string | null; createdAt: string }

const o = (path = '') => `/orgs/${orgId()}${path}`;

export const billingApi = {
  view: () => http.get<BillingView>(o('/billing')),
  quote: (q: { plan: PlanKey; interval: Interval; billingCountry: string; locations: number }) =>
    http.get<{ quote: Quote; terms: Terms }>(o('/billing/quote'), { plan: q.plan, interval: q.interval, billingCountry: q.billingCountry, locations: q.locations }),
  start: (b: { plan: PlanKey; interval: Interval; billingCountry: string; locations: number }) =>
    http.post<{ quote: Quote; trial: { eligible: boolean; reason: string | null; days: number; fee: Amount }; terms: Terms; setup: SetupInfo }>(o('/billing/checkout'), b),
  confirm: (b: { setupIntentId?: string; paymentMethodId?: string; taxId?: string }) =>
    http.post<{ status: string; trialEndsAt: string | null; trialUsed: boolean; billing: BillingView }>(o('/billing/checkout/confirm'), { ...b, acceptTerms: true }),
  cancel: () => http.post<{ cancelAtPeriodEnd: boolean; endsAt: string | null }>(o('/billing/cancel'), {}),
  startCardChange: () => http.post<{ billingCountry: string; setup: SetupInfo }>(o('/billing/payment-method'), {}),
  confirmCardChange: (b: { setupIntentId?: string; paymentMethodId?: string; taxId?: string }) => http.post<{ card: BillingView['card']; billing: BillingView }>(o('/billing/payment-method/confirm'), b),
  previewChange: (q: { plan: PlanKey; interval: Interval }) => http.get<ChangePreview>(o('/billing/change/preview'), q),
  change: (b: { plan: PlanKey; interval: Interval }) => http.post<ChangePreview & { billing: BillingView }>(o('/billing/change'), b),
  resume: () => http.post<{ cancelAtPeriodEnd: boolean }>(o('/billing/resume'), {}),
  startCountry: (billingCountry: string) => http.post<{ quote: Quote; setup: SetupInfo }>(o('/billing/country'), { billingCountry }),
  confirmCountry: (b: { setupIntentId?: string; paymentMethodId?: string; taxId?: string }) => http.post<{ pendingChange: unknown }>(o('/billing/country/confirm'), b),
  cancelCountry: () => http.del<void>(o('/billing/country')),
  setPayer: (b: { scopeKind: 'location' | 'owner_group'; scopeId: string; payer: Payer; franchiseePercent?: number }) => http.put<unknown>(o('/billing/payers'), b),
  removePayer: (id: string) => http.del<void>(o(`/billing/payers/${id}`)),
  franchisee: () => http.get<FranchiseeView>(o('/franchisee-billing')),
  franchiseeSetup: (b: { scopeKind: 'location' | 'owner_group'; scopeId: string; billingCountry: string }) => http.post<{ accountId: string; setup: SetupInfo }>(o('/franchisee-billing/setup'), b),
  franchiseeConfirm: (b: { scopeKind: 'location' | 'owner_group'; scopeId: string; setupIntentId?: string; paymentMethodId?: string; taxId?: string }) => http.post<{ status: string }>(o('/franchisee-billing/confirm'), b),
  exports: () => http.get<{ items: DataExport[] }>(o('/exports')).then((r) => r.items),
  requestExport: () => http.post<DataExport>(o('/exports'), {}),
  /** Downloads a ready export (owner, bearer-authenticated) and saves it through the browser. */
  async download(e: DataExport) {
    let token = getAccessToken();
    const get = (t: string | null) => fetch(`${API_URL}/v1${o(`/exports/${e.id}/download`)}`, { headers: t ? { authorization: `Bearer ${t}` } : {}, credentials: 'include' });
    let res = await get(token);
    if (res.status === 401) {
      token = await refreshAccessToken(token);
      res = await get(token);
    }
    if (!res.ok) throw new ApiError(res.status === 410 ? 'export_expired' : 'download_failed', res.status === 410 ? 'This export has expired. Request a new one.' : 'The download failed. Try again.', res.status);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = e.fileName ?? 'branchharbor-export.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** Countries offered as billing countries (ISO alpha-2), sorted by localized name. */
export function billingCountries(codes: readonly string[], locale: string): { code: string; name: string }[] {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    dn = null;
  }
  return [...new Set(codes)].map((code) => ({ code, name: dn?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
}
