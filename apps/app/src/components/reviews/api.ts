/**
 * Client for Marketing → Reviews (`/v1/orgs/:orgId/reviews/...`). Live API only: every review, request and figure comes
 * from the server, which filters to the person's scope (franchise owners only receive their own locations).
 */
import type { ReviewSettings } from '@bh/shared';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

const o = (p = '') => `/orgs/${orgId()}/reviews${p}`;

export interface Person { id: string; name: string | null }
export interface ReviewVM {
  id: string; locationId: string; locationName: string | null; source: 'google' | 'branchharbor'; authorName: string | null; rating: number; comment: string | null; language: string | null;
  reviewedAt: string; conversationId: string | null; linksOpened: string[]; sandbox: boolean; negative: boolean;
  reply: { status: 'none' | 'draft' | 'pending_approval' | 'published' | 'rejected' | 'failed'; text: string | null; aiSuggested: boolean; external: boolean; by: Person | null; submittedAt: string | null; decidedBy: Person | null; decisionNote: string | null; repliedAt: string | null; error: string | null };
}
export interface ReviewDetailVM extends ReviewVM { needsApproval: boolean; canReply: boolean; canApprove: boolean; aiEnabled: boolean }
export interface SummaryRow { locationId: string; name?: string; reviews: number; averageRating: number | null; distribution: number[]; publicReviews: number; responseRate: number | null; avgResponseHours: number | null }
export interface DashboardVM {
  range: { from: string; to: string }; bucket: 'week' | 'month';
  totals: SummaryRow & { negative: number; pendingApproval: number };
  requests: { sent: number; sandboxed: number; opened: number; completed: number; skipped: number; scheduled: number; failed: number; conversion: number | null };
  series: Array<{ bucket: string; reviews: number; averageRating: number | null }>;
  byLocation: Array<SummaryRow & { name: string }>;
}
export interface RequestVM { id: string; locationId: string; locationName: string | null; customerId: string | null; contactName: string | null; channel: string; source: string; status: string; skipReason: string | null; sendAt: string; sentAt: string | null; openedAt: string | null; completedAt: string | null; createdAt: string }
export interface SettingsVM { locationId: string | null; organization: ReviewSettings; overrides: Partial<ReviewSettings> | null; effective: ReviewSettings; canEdit: boolean; canEditHq: boolean; enabledAt: string | null }
export interface ListingVM { id: string; locationId: string; externalLocationName: string; title: string | null; reviewUrl: string | null; lastFetchedAt: string | null }
export interface ConnectionVM { id: string; ownerKind: 'hq' | 'location'; locationId: string | null; accountEmail: string | null; mode: 'live' | 'sandbox'; status: string; lastSyncAt: string | null; lastError: string | null; listings: ListingVM[] }
export interface GoogleLocationVM { accountName: string; name: string; title: string; reviewUrl: string | null }

export const reviewsApi = {
  dashboard: (q: { bucket?: 'week' | 'month'; locationId?: string; from?: string; to?: string } = {}) => http.get<DashboardVM>(o('/dashboard'), q),
  list: (q: { source?: string; maxRating?: number; reply?: string; locationId?: string; q?: string } = {}) => http.get<{ items: ReviewVM[]; canApprove: boolean }>(o(), q),
  get: (id: string) => http.get<ReviewDetailVM>(o(`/${id}`)),
  suggest: (id: string, locale?: string | null) => http.post<{ suggestion: string; model: string }>(o(`/${id}/suggest-reply`), { locale: locale ?? null }),
  reply: (id: string, text: string, aiSuggested: boolean, publish: boolean) => http.put<ReviewVM>(o(`/${id}/reply`), { text, aiSuggested, publish }),
  decide: (id: string, decision: 'approve' | 'reject', note?: string) => http.post<ReviewVM>(o(`/${id}/reply/decision`), { decision, note }),
  requests: (q: { status?: string; locationId?: string } = {}) => http.get<{ items: RequestVM[] }>(o('/requests'), q),
  sendRequest: (b: { locationId: string; customerId: string; channel?: string }) => http.post<{ request: RequestVM; outcome: { status: string; reason?: string } }>(o('/requests'), b),
  runRequests: () => http.post<{ queued: number; sent: Record<string, number> }>(o('/requests/run')),
  settings: (locationId: string | null) => http.get<SettingsVM>(o('/settings'), { locationId: locationId ?? undefined }),
  saveSettings: (locationId: string | null, settings: Partial<ReviewSettings>, clear?: string[]) => http.put<{ effective: ReviewSettings }>(o('/settings'), { locationId, settings, clear }),
  connections: () => http.get<{ googleConfigured: boolean; items: ConnectionVM[] }>(o('/connections')),
  googleStart: (ownerKind: 'hq' | 'location', locationId?: string) => http.get<{ url: string }>(o('/connections/google/start'), { ownerKind, locationId }),
  addSandbox: (ownerKind: 'hq' | 'location', locationId: string | null) => http.post<{ id: string }>(o('/connections/sandbox'), { ownerKind, locationId }),
  googleLocations: (id: string) => http.get<{ items: GoogleLocationVM[]; sandbox: boolean }>(o(`/connections/${id}/google-locations`)),
  link: (id: string, b: { locationId: string; externalLocationName: string; accountName?: string; title?: string; reviewUrl?: string }) => http.post<{ id: string }>(o(`/connections/${id}/listings`), b),
  unlink: (listingId: string) => http.del(o(`/listings/${listingId}`)),
  sync: (listingId: string) => http.post<{ fetched: number; created: number; sandbox: boolean }>(o(`/listings/${listingId}/sync`)),
  disconnect: (id: string) => http.post(o(`/connections/${id}/disconnect`)),
};
