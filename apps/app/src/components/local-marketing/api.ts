/**
 * Local marketing clients: Listings (`/listings`), co-op fund (`/coop`), call tracking (`/call-tracking`), the local
 * social calendar (`/social/calendar`), review reply templates and the shared settings (`/local-marketing/settings`).
 * Live API only: the server filters every list to the person's scope and checks every action.
 */
import type { ListingField, ListingFieldPolicy, ListingPatch, ListingSnapshot, LocalAssetField, LocalMarketingSettings, SpecialHour } from '@bh/shared';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

const o = (p: string) => `/orgs/${orgId()}${p}`;
export interface Person { id: string; name: string | null }
export type SyncStatus = 'synced' | 'pending' | 'drift' | 'error' | 'not_connected';
export interface ProviderState { provider: 'google' | 'apple' | 'bing'; status: SyncStatus; mode: string | null; syncId: string | null; lastPushedAt: string | null; lastCheckedAt: string | null; lastError: string | null; externalId?: string | null }
export interface Health { score: number; checks: Array<{ key: string; ok: boolean; weight: number }> }
export interface ListingRow { locationId: string; name: string; city: string; country: string; status: string; health: Health; providers: ProviderState[]; openDrifts: number; pendingChanges: number; missingHolidayDates: string[] }
export interface DriftVM { id: string; locationId: string; locationName: string | null; provider: string; field: ListingField; ourValue: unknown; theirValue: unknown; status: string; detectedAt: string; resolvedAt: string | null }
export interface ChangeVM { id: string; locationId: string; locationName?: string; status: string; fields: string[]; changes: ListingPatch; note: string | null; decisionNote: string | null; createdAt: string; requestedBy?: Person | string }
export interface ListingDetailVM {
  location: { id: string; name: string; timeZone: string; country: string; slug: string };
  listing: ListingSnapshot; policy: Record<ListingField, ListingFieldPolicy>; autoPush: boolean; providers: ProviderState[]; health: Health; missingHolidayDates: string[];
  drifts: DriftVM[]; changes: ChangeVM[]; canEdit: boolean; canManage: boolean;
}

export const listingsApi = {
  overview: () => http.get<{ items: ListingRow[]; totals: { locations: number; averageHealth: number | null; openDrifts: number; pendingChanges: number; synced: number; connected: number }; canManage: boolean }>(o('/listings')),
  detail: (locationId: string) => http.get<ListingDetailVM>(o(`/listings/${locationId}`)),
  update: (locationId: string, patch: ListingPatch & { note?: string | null }) => http.patch<{ applied: string[]; pendingApproval: string[]; requestId: string | null }>(o(`/listings/${locationId}`), patch),
  push: (locationId: string) => http.post<{ results: Array<{ provider: string; status: string; mode: string; error?: string }> }>(o(`/listings/${locationId}/push`), {}),
  check: (locationId: string) => http.post<{ results: Array<{ provider: string; drifted: string[]; created: number }> }>(o(`/listings/${locationId}/check`)),
  drifts: (status = 'open') => http.get<{ items: DriftVM[]; canResolve: boolean }>(o('/listings/drifts'), { status }),
  resolve: (id: string, action: 'accept' | 'overwrite' | 'dismiss') => http.post<DriftVM>(o(`/listings/drifts/${id}/resolve`), { action }),
  changes: (status = 'pending') => http.get<{ items: ChangeVM[]; canDecide: boolean }>(o('/listings/changes'), { status }),
  decide: (id: string, decision: 'approve' | 'reject', note?: string) => http.post(o(`/listings/changes/${id}/decision`), { decision, note }),
  holidaySets: () => http.get<{ items: Array<{ id: string; name: string; entries: SpecialHour[]; locationIds: string[]; skippedLocationIds: string[]; createdAt: string }>; canManage: boolean }>(o('/listings/holiday-hours')),
  applyHolidays: (b: { name: string; entries: SpecialHour[]; locationIds: string[]; overwrite: boolean }) => http.post<{ id: string; applied: string[]; skipped: string[]; pushed: number }>(o('/listings/holiday-hours'), b),
  connections: () => http.get<{ configured: Record<string, boolean>; google: { connections: Array<{ id: string; mode: string; status: string; accountEmail: string | null }>; linkedLocations: number }; items: Array<{ id: string; provider: string; mode: string; status: string; accountName: string | null; linkedLocations: number }>; canManage: boolean }>(o('/listings/connections')),
  connect: (provider: 'apple' | 'bing') => http.post<{ id: string; mode: string }>(o('/listings/connections'), { provider }),
  linkAll: (id: string) => http.post<{ linked: number }>(o(`/listings/connections/${id}/links`), { all: true }),
  simulateEdit: (syncId: string, patch: ListingPatch) => http.post<{ drifted: string[] }>(o(`/listings/syncs/${syncId}/simulate-edit`), patch),
};

/* ── settings and review reply templates ── */

export const settingsApi = {
  get: () => http.get<{ settings: LocalMarketingSettings; canEdit: { listings: boolean; reviews: boolean; coop: boolean; calls: boolean } }>(o('/local-marketing/settings')),
  save: (patch: Partial<LocalMarketingSettings>) => http.put<{ settings: LocalMarketingSettings }>(o('/local-marketing/settings'), patch),
  templates: () => http.get<{ items: Array<{ id: string; locationId: string | null; name: string; minRating: number; maxRating: number; locale: string | null; body: string }>; canManageHq: boolean }>(o('/reviews/templates')),
  addTemplate: (b: { locationId: string | null; name: string; minRating: number; maxRating: number; locale: string | null; body: string }) => http.post<{ id: string }>(o('/reviews/templates'), b),
  deleteTemplate: (id: string) => http.del(o(`/reviews/templates/${id}`)),
};

/* ── co-op ── */

export interface Burn { locationId: string; name?: string; currency: string; period: string; periodKey: string; hasProgramme: boolean; basis: string | null; percentBps: number; fixedMinor: number; matchRatioBps: number; contributionsMinor: number; allowanceMinor: number; committedMinor: number; claimedMinor: number; paidMinor: number; remainingMinor: number; requests: { submitted: number; approved: number; claimed: number } }
export interface ClaimVM { id: string; requestId: string; spentMinor: number; currency: string; invoiceDocumentId: string; proofDocumentIds: string[]; proofNotes: string; performance: Record<string, number>; reimbursableMinor: number | null; status: string; decisionNote: string | null; decidedBy: Person | null; fundEntryId: string | null; payoutMethod: string | null; payoutReference: string | null; paidAt: string | null; submittedBy: Person; createdAt: string }
export interface CoopRequestVM {
  id: string; locationId: string; locationName: string | null; kind: string; title: string; description: string; vendor: string | null; startsOn: string; endsOn: string | null; budgetMinor: number; approvedMinor: number | null; currency: string;
  periodKey: string; creative: Array<{ kind: string; id?: string | null; url?: string | null; name: string }>; status: string; checklist: Array<{ key: string; label?: string | null; passed: boolean; note?: string | null }>;
  requestedBy: Person; decidedBy: Person | null; decidedAt: string | null; decisionNote: string | null; createdAt: string; claim: ClaimVM | null; canDecide?: boolean; canEdit?: boolean;
}
export interface AllowanceVM { id: string; locationId: string | null; period: string; basis: string; percentBps: number; fixedMinor: number; matchRatioBps: number; active: boolean }
export interface AssetTemplateVM { id: string; name: string; kind: string; baseAssetId: string | null; baseUrl: string | null; width: number; height: number; fields: LocalAssetField[]; status: string }
export interface Upload { filename: string; contentType: string; dataBase64: string }

export const coopApi = {
  overview: (date?: string) => http.get<{ periodKey: string; items: Burn[]; totals: Array<{ currency: string; allowanceMinor: number; committedMinor: number; claimedMinor: number; paidMinor: number; remainingMinor: number; locations: number }>; paidByMonth: Array<{ month: string; currency: string; amountMinor: number }>; queue: { requests: number; claims: number; toPay: number }; canDecide: boolean }>(o('/coop/overview'), { date }),
  summary: (locationId: string, date?: string) => http.get<Burn>(o(`/coop/locations/${locationId}/summary`), { date }),
  allowances: () => http.get<{ items: AllowanceVM[]; canEdit: boolean }>(o('/coop/allowances')),
  setAllowance: (b: Omit<AllowanceVM, 'id' | 'active'> & { active?: boolean }) => http.put<{ id: string }>(o('/coop/allowances'), b),
  requests: (q: { status?: string; locationId?: string } = {}) => http.get<{ items: CoopRequestVM[]; canDecide: boolean }>(o('/coop/requests'), q),
  request: (id: string) => http.get<CoopRequestVM>(o(`/coop/requests/${id}`)),
  create: (b: { locationId: string; kind: string; title: string; description: string; vendor: string | null; startsOn: string; endsOn: string | null; budgetMinor: number; creative: CoopRequestVM['creative'] }) => http.post<CoopRequestVM>(o('/coop/requests'), b),
  decide: (id: string, b: { decision: 'approve' | 'reject' | 'changes_requested'; checklist: Array<{ key: string; passed: boolean }>; approvedMinor?: number | null; note?: string | null }) => http.post<CoopRequestVM>(o(`/coop/requests/${id}/decision`), b),
  claim: (id: string, b: { spentMinor: number; invoice: Upload; proofs: Upload[]; proofNotes: string; performance: Record<string, number> }) => http.post<CoopRequestVM>(o(`/coop/requests/${id}/claim`), b),
  decideClaim: (id: string, decision: 'approve' | 'reject', note?: string) => http.post<CoopRequestVM>(o(`/coop/claims/${id}/decision`), { decision, note }),
  pay: (id: string, b: { method: 'bank_transfer' | 'manual'; reference?: string | null }) => http.post<CoopRequestVM>(o(`/coop/claims/${id}/pay`), b),
  templates: () => http.get<{ items: AssetTemplateVM[]; canManage: boolean }>(o('/coop/asset-templates')),
  customise: (id: string, b: { locationId: string; values: Record<string, string> }) => http.post<{ id: string; values: Record<string, string> }>(o(`/coop/asset-templates/${id}/versions`), b),
};

/* ── call tracking ── */

export interface NumberVM { id: string; locationId: string; campaignId: string | null; label: string; source: string; number: string; mode: string; forwardTo: string; recordCalls: boolean; dniMatch: { utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; referrerHost?: string | null }; isDefault: boolean; status: string; createdAt: string }
export interface CallVM { id: string; locationId: string; trackingNumberId: string; campaignId: string | null; source: string; callerNumber: string; callerName: string | null; callerCity: string | null; status: string; startedAt: string; durationSeconds: number; recorded: boolean; sandbox: boolean; leadId: string | null; leadStatus: string | null; firstTimeCaller: boolean; notes: string | null; followedUpAt: string | null }
export interface ReportGroup { key: string | null; calls: number; answered: number; missed: number; leads: number }

export const callsApi = {
  numbers: () => http.get<{ items: NumberVM[]; live: boolean; canManage: boolean; dni: { scriptUrl: string; brand: string | null; locations: Array<{ id: string; slug: string; phone: string | null }> } }>(o('/call-tracking/numbers')),
  addNumber: (b: { locationId: string; label: string; source: string; campaignId?: string | null; forwardTo?: string | null; recordCalls: boolean; dniMatch: NumberVM['dniMatch']; isDefault: boolean }) => http.post<NumberVM>(o('/call-tracking/numbers'), b),
  release: (id: string) => http.post<NumberVM>(o(`/call-tracking/numbers/${id}/release`)),
  simulate: (id: string, b: { from: string; callerName?: string | null; outcome: 'answered' | 'missed' | 'busy'; durationSeconds: number }) => http.post<{ call: CallVM }>(o(`/call-tracking/numbers/${id}/simulate`), b),
  calls: (q: { locationId?: string; status?: string; campaignId?: string } = {}) => http.get<{ items: CallVM[] }>(o('/call-tracking/calls'), q),
  updateCall: (id: string, b: { notes?: string | null; followedUp?: boolean }) => http.patch<CallVM>(o(`/call-tracking/calls/${id}`), b),
  report: () => http.get<{ totals: { calls: number; answered: number; missed: number; firstTimeCallers: number; leads: number; answerRate: number | null; avgDurationSeconds: number | null }; bySource: ReportGroup[]; byCampaign: ReportGroup[]; byLocation: ReportGroup[] }>(o('/call-tracking/report')),
  recording: () => http.get<{ enabled: boolean; jurisdictions: Record<string, { message: string }>; allPartyConsentUsStates: string[]; locations: Array<{ id: string; name: string; jurisdiction: string; allowed: boolean }> }>(o('/call-tracking/recording')),
  campaigns: () => http.get<{ items: Array<{ id: string; name: string; kind: string }> }>(o('/ad-campaigns')),
};

/* ── local social calendar ── */

export interface CalendarItemVM {
  id: string; title: string; body: string; media: Array<{ url: string; alt?: string }>; link: string | null; networks: string[]; suggestedAt: string; allowEdits: boolean; audience: 'all' | 'selected'; locationIds: string[]; status: string;
  adoptions: Array<{ locationId: string; status: string; postId: string | null; postStatus: string | null; scheduledAt: string | null }>;
}
export const calendarApi = {
  list: (q: { from?: string; to?: string; locationId?: string } = {}) => http.get<{ items: CalendarItemVM[]; canManage: boolean }>(o('/social/calendar'), q),
  create: (b: { title: string; body: string; networks: string[]; suggestedAt: string; allowEdits: boolean; link: string | null; media: Array<{ url: string }> }) => http.post<CalendarItemVM>(o('/social/calendar'), b),
  setStatus: (id: string, status: 'draft' | 'published' | 'archived') => http.post(o(`/social/calendar/${id}/status`), { status }),
  preview: (id: string, locationId: string) => http.get<{ body: string; missing: string[]; accounts: Array<{ id: string; network: string; handle: string; mode: string }> }>(o(`/social/calendar/${id}/preview`), { locationId }),
  adopt: (id: string, b: { locationId: string; accountIds?: string[]; scheduledAt?: string | null; body?: string | null }) => http.post<{ postId: string; status: string; scheduledAt: string | null }>(o(`/social/calendar/${id}/adopt`), b),
  skip: (id: string, locationId: string) => http.post(o(`/social/calendar/${id}/skip`), { locationId }),
};

/** Reads a File as base64 for the JSON upload endpoints. */
export function fileToUpload(f: File): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ filename: f.name, contentType: f.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
