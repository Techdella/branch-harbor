'use client';

/**
 * Marketing workspace data layer: live API only (no sample data). Every call is scoped to the signed-in
 * organisation; the API enforces permissions per location.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationGraph, EmailDocument, FormField, FormSettings, PageDocument, SegmentRules } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { API_URL, getAccessToken, http, refreshAccessToken } from '@/lib/http/client';
import { useLocalizeError } from '@/lib/useErrorText';
import { useApp } from '@/components/shell/AppContext';

/** Context the marketing screens need (one place to adapt when the access model changes). */
export function useMkt() {
  const app = useApp();
  const orgId = app.ready && app.live ? app.org.id : null;
  return { ready: app.ready, live: app.live, orgId, org: app.org, locations: app.locations, can: app.can, locale: app.org.defaultLocale };
}

const O = (orgId: string, p: string) => `/orgs/${orgId}${p}`;

export type Load<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };

/** Load once `orgId` is known; `reload()` keeps showing current data while refreshing. */
export function useLoad<T>(orgId: string | null, fn: (orgId: string) => Promise<T>, deps: unknown[] = []) {
  const [res, setRes] = useState<Load<T>>({ status: 'loading' });
  const localize = useLocalizeError();
  const ref = useRef({ fn, localize });
  ref.current = { fn, localize };
  const seq = useRef(0);
  const run = useCallback((keep: boolean) => {
    if (!orgId) return;
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    ref.current.fn(orgId).then(
      (data) => id === seq.current && setRes({ status: 'ready', data }),
      (e: unknown) => id === seq.current && setRes({ status: 'error', error: ref.current.localize(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, ...deps]);
  useEffect(() => { run(false); }, [run]);
  return { ...res, reload: () => run(true), set: (data: T) => setRes({ status: 'ready', data }) };
}

/** Run a mutation and surface a localized error. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeError();
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(localize(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))));
      return undefined;
    } finally {
      setPending(false);
    }
  }, [localize]);
  return { run, pending, error, clear: () => setError(null) };
}

// ───────── Types (subset of the API responses) ─────────

export interface ThemeSettings { themeId: string; colorMode: 'theme' | 'brand'; primaryColor: string; accentColor: string | null; headingFont: string | null; bodyFont: string | null; logoUrl: string | null }
export interface PageMeta {
  id: string; websiteId: string; locationId: string | null; templateId: string | null; slug: string; title: string; status: string;
  seo: { title?: string; description?: string; socialImage?: string; noindex?: boolean };
  navLabel: string | null; showInNav: boolean; navOrder: number; revision: number; builder: boolean;
  publishedAt: string | null; publishedVersionId: string | null; scheduledPublishAt: string | null; updatedAt: string; pendingApprovals?: number;
}
export interface SiteRow { id: string; kind: string; status: string; locationId: string | null; includedAddress: string; navLinks: Array<{ label: string; href: string }>; location: { id: string; name: string; slug: string } | null; pages: PageMeta[] }
export interface SitesResponse { theme: ThemeSettings; independent: boolean; industry: string; items: SiteRow[] }
export interface BuilderData {
  page: PageMeta; document: PageDocument; independent: boolean; industry: string; brandName: string; defaultLocale: string;
  website: { id: string; kind: string; includedAddress: string; navLinks: Array<{ label: string; href: string }>; pages: Array<{ id: string; slug: string; title: string; navLabel: string | null; showInNav: boolean; navOrder: number }> };
  location: { id: string; name: string; address: { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string }; country: string; phone: string | null; email: string | null; hours: Record<string, unknown> | null; geo: { lat: number; lng: number } | null; locale: string; timeZone: string } | null;
  theme: ThemeSettings;
  permissions: { canHq: boolean; canApprove: boolean; canPublish: boolean; canDesign: boolean; governed: boolean };
  publicUrl: string;
}
export interface SaveResult { revision: number; document: PageDocument; rejected: Array<{ sectionId: string; reason: string }>; pendingApprovals: Array<{ sectionId: string; approvalId: string }>; overridden: string[] }
export interface Master { id: string; name: string; pageSlug: string; document: PageDocument; version: number; updatedAt: string; pageCount: number }
export interface MasterDetail extends Master { theme: ThemeSettings; brandName: string; industry: string; defaultLocale: string; linked: Array<{ id: string; locationId: string | null; status: string; publishedAt: string | null }> }
export interface History { revisions: Array<{ id: string; revision: number; reason: string; createdAt: string }>; versions: Array<{ id: string; version: number; createdAt: string; live: boolean }> }
export interface PublishJob { id: string; status: string; summary: { total: number; succeeded: number; failed: number; skipped: number; pending: number }; results: Array<{ locationId: string; status: string; error: string | null; warnings: string[] }> }

export interface EmailTemplate { id: string; name: string; subject: string; preheader: string; document: EmailDocument; category: string; locationId: string | null; updatedAt: string; warnings: string[] }
export interface Segment { id: string; name: string; scopeKind: string; scopeId: string; rules: SegmentRules }
export interface CampaignStats { total: number; sent: number; sandbox: number; skipped: number; failed: number; opened: number; clicked: number; unsubscribed: number }
export interface Campaign { id: string; name: string; status: string; scope: { kind: string; id: string }; startsAt: string | null; subject: string; segmentId: string | null; recipientCount: number | null; stats: CampaignStats; createdAt: string; content?: { subject: string; preheader: string; document: EmailDocument } }
export interface MarketingSettingsResponse { settings: { tracking: { opens: boolean; clicks: boolean }; postalAddress: string; fromName: string; quietHours: { start: string; end: string } }; emailMode: string; smsEnabled: boolean; whatsappEnabled: boolean; storageMode: string; jobsMode: string }
export interface Automation { id: string; name: string; status: string; triggerEvent: string; scope: { kind: string; id: string }; graph: AutomationGraph; version: number; activatedAt: string | null; updatedAt: string; stats: { total: number; active: number; completed: number }; issues?: Array<{ nodeId: string | null; code: string }> }
export interface AutomationRun { id: string; test: boolean; status: string; customer: { id: string; name: string | null } | null; currentNodeId: string | null; nextRunAt: string | null; startedAt: string; finishedAt: string | null; error: string | null; steps: Array<{ nodeId: string; nodeType: string; status: string; result: Record<string, unknown>; at: string }> }
export interface FormRow { id: string; name: string; locationId: string | null; fields: FormField[]; settings: FormSettings; status: string; submissions: number; updatedAt: string; publicPath: string }
export interface Asset { id: string; locationId: string | null; folder: string; name: string; mime: string; size: number; url: string; alt: string; usageRights: string; rightsExpireAt: string | null; expired: boolean; shareMode: string; sharedLocationIds: string[]; createdAt: string }

// ───────── Calls ─────────

export const mkt = {
  sites: (o: string) => http.get<SitesResponse>(O(o, '/builder/sites')),
  addPage: (o: string, websiteId: string, body: { title: string; slug?: string; document?: PageDocument; showInNav?: boolean }) => http.post<PageMeta>(O(o, `/websites/${websiteId}/builder-pages`), body),
  builder: (o: string, pageId: string) => http.get<BuilderData>(O(o, `/pages/${pageId}/builder`)),
  saveDocument: (o: string, pageId: string, document: PageDocument, baseRevision: number, checkpoint = false) => http.put<SaveResult>(O(o, `/pages/${pageId}/document`), { document, baseRevision, checkpoint }),
  pageMeta: (o: string, pageId: string, body: Partial<Pick<PageMeta, 'title' | 'slug' | 'seo' | 'navLabel' | 'showInNav' | 'navOrder'>>) => http.patch<PageMeta>(O(o, `/pages/${pageId}/meta`), body),
  archivePage: (o: string, pageId: string) => http.del<{ archived: boolean }>(O(o, `/pages/${pageId}`)),
  history: (o: string, pageId: string) => http.get<History>(O(o, `/pages/${pageId}/history`)),
  restore: (o: string, pageId: string, body: { revisionId?: string; versionId?: string; baseRevision: number }) => http.post<SaveResult>(O(o, `/pages/${pageId}/restore`), body),
  resetSection: (o: string, pageId: string, sectionId: string, baseRevision: number) => http.post<{ revision: number; document: PageDocument }>(O(o, `/pages/${pageId}/sections/${sectionId}/reset`), { baseRevision }),
  publish: (o: string, pageId: string) => http.post<{ version: { version: number } }>(O(o, `/pages/${pageId}/publish`), {}),
  submitPage: (o: string, pageId: string, comment?: string) => http.post(O(o, `/pages/${pageId}/submit`), { comment }),
  schedule: (o: string, pageId: string, at: string | null) => http.post<PageMeta>(O(o, `/pages/${pageId}/schedule`), { at }),
  nav: (o: string, websiteId: string, body: { pages: Array<{ id: string; navLabel: string | null; showInNav: boolean; navOrder: number }>; links: Array<{ label: string; href: string }> }) => http.put(O(o, `/websites/${websiteId}/nav`), body),
  setTheme: (o: string, body: Omit<ThemeSettings, 'primaryColor' | 'logoUrl'> & { primaryColor?: string; logoUrl?: string | null }) => http.put<{ theme: ThemeSettings }>(O(o, '/builder/theme'), body),
  masters: (o: string) => http.get<{ items: Master[] }>(O(o, '/builder/masters')),
  createMaster: (o: string, body: { name: string; pageSlug: string; document?: PageDocument }) => http.post<Master>(O(o, '/builder/masters'), body),
  master: (o: string, id: string) => http.get<MasterDetail>(O(o, `/builder/masters/${id}`)),
  saveMaster: (o: string, id: string, document: PageDocument, version: number) => http.put<{ master: Master; affected: Record<string, number> }>(O(o, `/builder/masters/${id}/document`), { document, version }),
  applyMaster: (o: string, id: string, locationIds: string[]) => http.post<{ pageSlug: string; results: Array<{ locationId: string; status: string; reason: string | null; pageId: string | null }> }>(O(o, `/builder/masters/${id}/apply`), { locationIds }),
  groupPublish: (o: string, pageSlug: string, locationIds: string[]) => http.post<PublishJob>(O(o, '/publish-jobs'), { pageSlug, locationIds }),
  retryJob: (o: string, id: string) => http.post<PublishJob>(O(o, `/publish-jobs/${id}/retry`), {}),

  settings: (o: string) => http.get<MarketingSettingsResponse>(O(o, '/marketing/settings')),
  saveSettings: (o: string, body: MarketingSettingsResponse['settings']) => http.put(O(o, '/marketing/settings'), body),
  templates: (o: string) => http.get<{ items: EmailTemplate[] }>(O(o, '/email/templates')),
  template: (o: string, id: string) => http.get<EmailTemplate>(O(o, `/email/templates/${id}`)),
  createTemplate: (o: string, body: { name: string; subject: string; preheader?: string; document: EmailDocument; locationId?: string | null }) => http.post<EmailTemplate>(O(o, '/email/templates'), body),
  saveTemplate: (o: string, id: string, body: { name: string; subject: string; preheader: string; document: EmailDocument; category: string }) => http.put<EmailTemplate>(O(o, `/email/templates/${id}`), body),
  archiveTemplate: (o: string, id: string) => http.del(O(o, `/email/templates/${id}`)),
  render: (o: string, body: { document: EmailDocument; subject: string; preheader?: string; locationId?: string | null }) => http.post<{ html: string; text: string; warnings: string[] }>(O(o, '/email/render'), body),
  testSend: (o: string, body: { document: EmailDocument; subject: string; preheader?: string; locationId?: string | null }) => http.post<{ to: string; status: string; sandbox: boolean }>(O(o, '/email/test'), body),
  segments: (o: string) => http.get<{ items: Segment[] }>(O(o, '/segments')),
  createSegment: (o: string, body: { name: string; scope: { kind: string; id: string }; rules: Partial<SegmentRules> }) => http.post<Segment>(O(o, '/segments'), body),
  previewSegment: (o: string, body: { scope: { kind: string; id: string }; rules: Partial<SegmentRules> }) => http.post<{ matching: number; emailable: number }>(O(o, '/segments/preview'), body),
  tags: (o: string) => http.get<{ items: Array<{ tag: string; n: number }> }>(O(o, '/tags')),
  campaigns: (o: string) => http.get<{ items: Campaign[] }>(O(o, '/email/campaigns')),
  campaign: (o: string, id: string) => http.get<Campaign>(O(o, `/email/campaigns/${id}`)),
  createCampaign: (o: string, body: { name: string; scope: { kind: string; id: string }; subject: string; preheader?: string; document: EmailDocument; segmentId: string | null }) => http.post<Campaign>(O(o, '/email/campaigns'), body),
  saveCampaign: (o: string, id: string, body: { name: string; subject: string; preheader: string; document: EmailDocument; segmentId: string | null }) => http.put<Campaign>(O(o, `/email/campaigns/${id}`), body),
  sendCampaign: (o: string, id: string, at: string | null) => http.post<Campaign>(O(o, `/email/campaigns/${id}/send`), { at }),
  recipients: (o: string, id: string) => http.get<{ items: Array<{ id: string; email: string; status: string; skipReason: string | null; sentAt: string | null }> }>(O(o, `/email/campaigns/${id}/recipients`)),

  automations: (o: string) => http.get<{ items: Automation[] }>(O(o, '/automations')),
  automation: (o: string, id: string) => http.get<Automation>(O(o, `/automations/${id}`)),
  createAutomation: (o: string, body: { name: string; scope: { kind: string; id: string }; graph: AutomationGraph }) => http.post<Automation>(O(o, '/automations'), body),
  saveAutomation: (o: string, id: string, body: { name: string; graph: AutomationGraph; version: number }) => http.put<Automation>(O(o, `/automations/${id}`), body),
  automationStatus: (o: string, id: string, status: 'active' | 'paused' | 'archived') => http.post<Automation>(O(o, `/automations/${id}/status`), { status }),
  testRun: (o: string, id: string, locationId: string | null) => http.post<{ runId: string; status: string; steps: AutomationRun['steps'] }>(O(o, `/automations/${id}/test-run`), { locationId }),
  runs: (o: string, id: string) => http.get<{ items: AutomationRun[] }>(O(o, `/automations/${id}/runs`)),

  forms: (o: string) => http.get<{ items: FormRow[] }>(O(o, '/forms')),
  form: (o: string, id: string) => http.get<FormRow>(O(o, `/forms/${id}`)),
  createForm: (o: string, body: { name: string; fields: FormField[]; settings?: Partial<FormSettings>; locationId?: string | null }) => http.post<FormRow>(O(o, '/forms'), body),
  saveForm: (o: string, id: string, body: { name: string; fields: FormField[]; settings: FormSettings; status?: 'draft' | 'published' }) => http.put<FormRow>(O(o, `/forms/${id}`), body),
  archiveForm: (o: string, id: string) => http.del(O(o, `/forms/${id}`)),
  submissions: (o: string, id: string) => http.get<{ items: Array<{ id: string; createdAt: string; locationId: string | null; consents: Record<string, boolean>; data: Record<string, unknown> | null }> }>(O(o, `/forms/${id}/submissions`)),

  assets: (o: string, q: { folder?: string; q?: string; type?: string } = {}) => http.get<{ items: Asset[]; folders: string[]; storageMode: string }>(O(o, '/assets'), q),
  updateAsset: (o: string, id: string, body: Partial<Pick<Asset, 'name' | 'folder' | 'alt' | 'usageRights' | 'rightsExpireAt' | 'shareMode' | 'sharedLocationIds'>>) => http.patch<Asset>(O(o, `/assets/${id}`), body),
  archiveAsset: (o: string, id: string) => http.del(O(o, `/assets/${id}`)),
};

/** Binary upload (the JSON client cannot send files). Refreshes the session once on 401. */
export async function uploadAsset(orgId: string, file: File, opts: { folder?: string; locationId?: string | null } = {}): Promise<Asset> {
  const q = new URLSearchParams({ name: file.name, folder: opts.folder ?? '' });
  if (opts.locationId) q.set('locationId', opts.locationId);
  const send = (token: string | null) => fetch(`${API_URL}/v1/orgs/${orgId}/assets/upload?${q}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file });
  let res = await send(getAccessToken());
  if (res.status === 401) res = await send(await refreshAccessToken());
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; fields?: Record<string, string> } } & Asset;
  if (!res.ok) throw new ApiError(json.error?.code ?? 'upload_failed', json.error?.message ?? 'Upload failed', res.status, json.error?.fields);
  return json;
}
