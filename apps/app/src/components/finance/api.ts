'use client';

/**
 * Finance workspace client (`/v1/orgs/:orgId/finance/...`). Live API only: every figure comes from the server, which
 * filters records to the person's scope (franchise owners only ever receive their own statements, invoices and
 * contributions). Amounts are integer minor units with their currency and are never summed across currencies.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/errors';
import { useLocalizeErrorRef } from '@/lib/useErrorText';
import { API_URL, getAccessToken, http, refreshAccessToken, type Query } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

export type StatementStatus = 'draft' | 'disputed' | 'approved' | 'invoiced' | 'void';
export type InvoiceState = 'open' | 'processing' | 'paid' | 'void' | 'overdue';

export interface PeriodVM { id: string; frequency: 'weekly' | 'monthly'; startDate: string; endDate: string; status: string; closedAt: string | null }
export interface PeriodsVM { frequency: 'weekly' | 'monthly'; current: { startDate: string; endDate: string }; suggestedClose: { startDate: string; endDate: string }; items: PeriodVM[] }
export interface StatementVM {
  id: string; periodId: string; period: { startDate: string; endDate: string; frequency: string } | null;
  location: { id: string; name: string | null; code: string | null }; ownerGroup: { id: string; name: string | null } | null;
  currency: string; timeZone: string; periodStartAt: string; periodEndAt: string; status: StatementStatus;
  grossSalesMinor: number; refundsMinor: number; taxMinor: number; tipsMinor: number; externalSalesMinor: number; basisMinor: number;
  royaltyMinor: number; marketingFundMinor: number; technologyFeeMinor: number; adjustmentsMinor: number; totalMinor: number;
  termsSource: string | null; warnings: string[]; computedAt: string; approvedAt: string | null;
  invoice: { id: string; number: string; status: string; dueDate: string; totalMinor: number; paidMinor: number } | null;
}
export interface StatementLineVM { id: string; kind: string; stream: string | null; description: string; basisMinor: number | null; rateBps: number | null; amountMinor: number; charge: boolean; manual: boolean; disputeId: string | null }
export interface DisputeVM { id: string; lineId: string | null; reason: string; status: 'open' | 'accepted' | 'rejected'; resolution: string | null; adjustmentMinor: number | null; createdAt: string; resolvedAt: string | null }
export interface StatementDetailVM extends StatementVM { terms: Record<string, unknown> | null; lines: StatementLineVM[]; disputes: DisputeVM[] }
export interface InvoiceVM {
  id: string; number: string; statementId: string; location: { id: string; name: string | null }; ownerGroup: { id: string; name: string | null } | null;
  currency: string; issueDate: string; dueDate: string; lines: Array<{ kind: string; description: string; amountMinor: number }>; taxes: Array<{ name: string; rateBps: number; baseMinor: number; amountMinor: number }>;
  subtotalMinor: number; taxMinor: number; lateFeeMinor: number; totalMinor: number; paidMinor: number; outstandingMinor: number; status: string; state: InvoiceState; daysOverdue: number; dunningStage: string; paidAt: string | null;
}
export interface InvoiceDetailVM extends InvoiceVM {
  attempts: Array<{ id: string; attempt: number; method: string; status: string; amountMinor: number; currency: string; failureCode: string | null; reference: string | null; createdAt: string }>;
  dunning: Array<{ id: string; action: string; dayOffset: number; note: string | null; createdAt: string }>;
  paymentMethod: PaymentMethodVM | null;
}
export interface PaymentMethodVM { id: string; ownerGroupId: string; currency: string; methodType: string; status: string; display: { brand?: string | null; last4?: string | null; bankName?: string | null }; mandateText: string; mandateAcceptedAt: string; sandbox: boolean }
export interface PaymentMethodsVM { mode: 'live' | 'sandbox'; ownerGroups: Array<{ id: string; name: string; currencies: Array<{ currency: string; methodTypes: string[] }> }>; items: PaymentMethodVM[] }
export interface Basis { streams: string[]; netOfRefunds: boolean; excludeTax: boolean; excludeTips: boolean; includeExternalSales: boolean }
export interface TermsVM {
  id: string; ownerGroupId: string | null; currency: string; effectiveFrom: string; effectiveTo: string | null; royaltyBps: number; tiers: Array<{ fromMinor: number; bps: number }>; tierMode: string;
  minimumRoyaltyMinor: number; marketingFundBps: number; technologyFeeMinor: number; basis: Basis; lateFee: { kind: 'none' | 'flat' | 'percent'; flatMinor?: number; bps?: number; graceDays: number }; notes: string | null;
}
export interface TermsInput extends Omit<TermsVM, 'id' | 'notes' | 'tierMode'> { tierMode: 'marginal' | 'whole'; notes?: string | null }
export interface SettingsVM {
  periodFrequency: 'weekly' | 'monthly'; weekStartsOn: number; invoicePrefix: string; nextInvoiceSeq: number; paymentTermsDays: number;
  taxLines: Array<{ name: string; rateBps: number; country: string | null; appliesTo: string[] }>;
  dunning: { retryDays: number[]; reminderDaysBefore: number; finalNoticeAfterDays: number }; autoCollect: boolean; collectionAccountId: string | null; collectionMode: 'live' | 'sandbox';
  issuerDetails: { legalName?: string; address?: string; taxNumber?: string; email?: string };
}
export interface OverviewVM { today: string; periodFrequency: string; receivables: Array<{ currency: string; openMinor: number; overdueMinor: number; open: number; overdue: number }>; statements: { draft: number; disputed: number; approved: number }; fund: FundBalance[] | null; sandbox: boolean }
export interface FundBalance { currency: string; contributionsMinor: number; spendMinor: number; adjustmentsMinor: number; balanceMinor: number }
export interface TransparencyVM { year: number; currencies: Array<{ currency: string; openingBalanceMinor: number; contributionsMinor: number; contributorCount: number; spendMinor: number; adjustmentsMinor: number; closingBalanceMinor: number; spendByCampaign: Array<{ campaignId: string | null; name: string | null; amountMinor: number }>; yourContributionsMinor: number }> }
export interface FundEntryVM { id: string; kind: string; currency: string; amountMinor: number; occurredOn: string; description: string; vendor: string | null; campaign: { id: string; name: string | null } | null; location: { id: string; name: string | null } | null; ownerGroup: { id: string; name: string | null } | null; receiptDocumentId: string | null }
export interface CampaignVM { id: string; name: string; kind: string; status: string }
export interface ExternalSalesVM { id: string; location: { id: string; name: string | null }; frequency: string; periodStart: string; currency: string; grossMinor: number; refundsMinor: number; taxMinor: number; note: string | null; evidenceDocumentId: string; status: 'submitted' | 'accepted' | 'rejected'; reviewNote: string | null }
export interface PayoutVM { id: string; location: { id: string; name: string | null }; externalId: string; currency: string; amountMinor: number; grossMinor: number; feesMinor: number; refundsMinor: number; chargebacksMinor: number; otherMinor: number; status: string; arrivalDate: string | null; sandbox: boolean }
export interface ReconRowVM {
  locationId: string; location: { id: string; name: string | null }; currency: string; paymentsMinor: number; paymentCount: number; paidOutMinor: number; notPaidOutMinor: number; feesMinor: number; refundsMinor: number; chargebacksMinor: number;
  statement: { id: string; status: string; salesMinor: number; basisMinor: number; totalMinor: number } | null; invoice: { id: string; number: string; status: string; totalMinor: number; paidMinor: number; dueDate: string } | null;
  issues: Array<{ kind: string; detail: string; amountMinor: number | null }>;
}
export interface RevenueRowVM { key: string; name: string | null; currency: string; statements: number; basisMinor: number; royaltyMinor: number; marketingFundMinor: number; technologyFeeMinor: number; totalMinor: number }
export interface ReportsVM {
  range: { from: string; to: string }; royaltyByLocation: RevenueRowVM[]; royaltyByRegion: RevenueRowVM[];
  collectionRate: Array<{ currency: string; invoices: number; invoicedMinor: number; collectedMinor: number; paidInvoices: number; paidOnTime: number; rate: number }>;
  arrearsAgeing: Array<{ currency: string; totalMinor: number; invoices: number; current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number }>;
  fundBalance: FundBalance[];
}
export interface Upload { filename: string; contentType: string; dataBase64: string }

const o = (p: string) => `/orgs/${orgId()}/finance${p}`;

export const financeApi = {
  overview: () => http.get<OverviewVM>(o('/overview')),
  settings: () => http.get<SettingsVM>(o('/settings')),
  saveSettings: (body: Partial<SettingsVM>) => http.put<SettingsVM>(o('/settings'), body),
  connectCollectionAccount: () => http.post<{ accountId: string; url: string; mode: string }>(o('/collection-account'), { returnUrl: `${window.location.origin}/finance/royalties?tab=settings`, refreshUrl: `${window.location.origin}/finance/royalties?tab=settings` }),
  terms: () => http.get<{ items: TermsVM[]; ownerGroups: Array<{ id: string; name: string }> }>(o('/terms')),
  createTerms: (body: TermsInput) => http.post<TermsVM>(o('/terms'), body),
  updateTerms: (id: string, body: TermsInput) => http.put<TermsVM>(o(`/terms/${id}`), body),
  periods: () => http.get<PeriodsVM>(o('/periods')),
  closePeriod: (startDate: string) => http.post<{ period: PeriodVM; statements: number; missingTerms: string[] }>(o('/periods/close'), { startDate }),
  invoiceApproved: (periodId: string) => http.post<{ issued: number; skipped: Array<{ statementId: string; code: string }> }>(o(`/periods/${periodId}/invoice-approved`)),
  statements: (q: Query = {}) => http.get<{ items: StatementVM[] }>(o('/statements'), q),
  statement: (id: string) => http.get<StatementDetailVM>(o(`/statements/${id}`)),
  recalculate: (id: string) => http.post<StatementDetailVM>(o(`/statements/${id}/recalculate`)),
  adjust: (id: string, amountMinor: number, description: string) => http.post<StatementDetailVM>(o(`/statements/${id}/adjustments`), { amountMinor, description }),
  approve: (id: string) => http.post<StatementDetailVM>(o(`/statements/${id}/approve`)),
  invoice: (id: string) => http.post<{ invoice: InvoiceVM; collection: { status: string; failureCode: string | null } | null }>(o(`/statements/${id}/invoice`)),
  dispute: (id: string, reason: string, lineId?: string | null) => http.post<{ id: string }>(o(`/statements/${id}/disputes`), { reason, lineId: lineId ?? null }),
  resolveDispute: (id: string, decision: 'accepted' | 'rejected', resolution: string, adjustmentMinor?: number | null) => http.post(o(`/disputes/${id}/resolve`), { decision, resolution, adjustmentMinor: adjustmentMinor ?? null }),
  invoices: (q: Query = {}) => http.get<{ items: InvoiceVM[]; today: string }>(o('/invoices'), q),
  invoiceDetail: (id: string) => http.get<InvoiceDetailVM>(o(`/invoices/${id}`)),
  collect: (id: string) => http.post<{ status: string; failureCode: string | null }>(o(`/invoices/${id}/collect`)),
  pay: (id: string) => http.post<{ status: string; failureCode: string | null }>(o(`/invoices/${id}/pay`)),
  recordPayment: (id: string, amountMinor: number, reference: string, receivedOn: string) => http.post<InvoiceVM>(o(`/invoices/${id}/record-payment`), { amountMinor, reference, receivedOn }),
  sandboxSettle: (id: string, outcome: 'succeeded' | 'failed') => http.post(o(`/invoices/${id}/sandbox-settle`), { outcome }),
  runDunning: () => http.post<{ day: string; checked: number; reminders: number; lateFees: number; retries: number; retriesFailed: number; finalNotices: number }>(o('/dunning/run'), {}),
  paymentMethods: () => http.get<PaymentMethodsVM>(o('/payment-methods')),
  setupMethod: (body: { ownerGroupId: string; currency: string; methodType: string; acceptMandate: boolean }) => http.post<{ id: string; clientSecret: string | null; mode: string; mandateText: string }>(o('/payment-methods/setup'), body),
  sandboxConfirmMethod: (id: string, outcome: 'ok' | 'decline') => http.post<PaymentMethodVM>(o(`/payment-methods/${id}/sandbox-confirm`), { outcome }),
  refreshMethod: (id: string) => http.post<PaymentMethodVM>(o(`/payment-methods/${id}/refresh`)),
  revokeMethod: (id: string) => http.post<PaymentMethodVM>(o(`/payment-methods/${id}/revoke`)),
  externalSales: () => http.get<{ items: ExternalSalesVM[] }>(o('/external-sales')),
  submitExternalSales: (body: { locationId: string; periodStart: string; grossMinor: number; refundsMinor: number; taxMinor: number; note?: string; evidence: Upload }) => http.post<{ id: string }>(o('/external-sales'), body),
  reviewExternalSales: (id: string, decision: 'accepted' | 'rejected', note?: string) => http.post(o(`/external-sales/${id}/review`), { decision, note: note ?? null }),
  transparency: (year: number) => http.get<TransparencyVM>(o('/fund/transparency'), { year }),
  ledger: (currency?: string) => http.get<{ balances: FundBalance[]; items: FundEntryVM[] }>(o('/fund/ledger'), { currency }),
  campaigns: () => http.get<{ items: CampaignVM[] }>(o('/fund/campaigns')),
  recordSpend: (body: { currency: string; amountMinor: number; campaignId: string; description: string; vendor?: string; occurredOn: string; receipt: Upload }) => http.post(o('/fund/spend'), body),
  payouts: () => http.get<{ mode: string; items: PayoutVM[] }>(o('/payouts')),
  syncPayouts: () => http.post<{ payouts: number; mode: string }>(o('/payouts/sync')),
  reconciliation: (periodId: string) => http.get<{ items: ReconRowVM[] }>(o('/reconciliation'), { periodId }),
  reports: (from: string, to: string) => http.get<ReportsVM>(o('/reports'), { from, to }),
};

/** Downloads an authenticated file (PDF, CSV, evidence) and saves it with `filename`. */
export async function downloadFile(path: string, filename: string, query: Query = {}) {
  const url = new URL(`${API_URL}/v1${o(path)}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const get = (token: string | null) => fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'include' });
  let res = await get(getAccessToken());
  if (res.status === 401) res = await get(await refreshAccessToken());
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.code ?? 'http_error', body?.error?.message ?? res.statusText, res.status);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Reads a chosen file as base64 for upload (evidence, receipts). */
export function readUpload(file: File): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new ApiError('file_unreadable', 'The file could not be read.'));
    r.readAsDataURL(file);
  });
}

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads finance data (loading / ready / error, reload). */
export function useFinance<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    fnRef.current().then(
      (data) => id === seq.current && setRes({ status: 'ready', data }),
      (e) => id === seq.current && setRes({ status: 'error', error: localize.current(toErr(e)) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (enabled) load();
  }, [load, enabled]);
  return { ...res, reload: useCallback(() => load(true), [load]) };
}

/** Runs a finance action, tracking pending + a localized error. */
export function useFinanceAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(localize.current(toErr(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { run, pending, error, clearError: () => setError(null) };
}
