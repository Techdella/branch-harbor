'use client';

/**
 * Field audits, compliance documents and the league table (`/v1/orgs/:orgId/audits|compliance|league-table`). Live API
 * only: the server filters every list to the person's scope (a franchise owner only ever receives their own
 * locations, and network quartiles without names). Money is integer minor units with its currency, never combined.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditAnswer, AuditSection, AuditTemplateBody, Quartiles } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { useLocalizeErrorRef } from '@/lib/useErrorText';
import { API_URL, getAccessToken, http, refreshAccessToken, type Query } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

export interface FileRef { id: string; url: string; name?: string | null }
export interface TemplateVM extends AuditTemplateBody { id: string; starterKey: string | null; status: 'active' | 'archived'; version: number; questionCount: number; criticalCount: number; createdAt: string; updatedAt: string }
export interface StarterVM { key: string; name: string; description: string; preOpening: boolean; questionCount: number; sections: string[] }
export interface AuditVM {
  id: string; locationId: string; locationName: string | null; templateId: string | null; name: string; purpose: 'routine' | 'pre_opening' | 'reaudit'; status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  dueDate: string; overdue: boolean; auditor: { id: string; name: string | null } | null; parentAuditId: string | null; projectId: string | null; startedAt: string | null; completedAt: string | null;
  scorePct: number | null; passed: boolean | null; criticalFailed: boolean | null; passThreshold: number; reauditDueDate: string | null; revision: number; openActions: number; overdueActions: number; updatedAt: string;
}
export interface ActionVM {
  id: string; auditId: string; locationId: string; locationName: string | null; questionId: string; sectionTitle: string; title: string; reason: string; critical: boolean; auditorNote: string | null;
  dueDate: string; status: 'open' | 'submitted' | 'verified'; overdue: boolean; responseNote: string | null; evidence: FileRef[]; submittedBy: { id: string; name: string | null } | null; submittedAt: string | null;
  verifiedBy: { id: string; name: string | null } | null; verifiedAt: string | null; reviewNote: string | null; reopenedCount: number;
}
export interface AnswerVM extends AuditAnswer { photos?: FileRef[] }
export interface AuditDetailVM extends AuditVM {
  timeZone: string; summary: string | null; checklist: { name: string; sections: AuditSection[]; passThreshold: number; reauditDays: number; correctiveDays: number; version: number };
  answers: Record<string, AnswerVM>;
  breakdown: { sections: Array<{ id: string; title: string; earned: number; possible: number; scorePct: number | null }>; failed: Array<{ questionId: string; reason: string | null; critical: boolean }>; unanswered: string[]; liveScorePct: number | null; livePassed: boolean } | null;
  actions: ActionVM[]; parent: { id: string; scorePct: number | null; completedAt: string | null } | null; reaudit: { id: string; dueDate: string; status: string } | null;
  permissions: { conduct: boolean; manage: boolean; respond: boolean; verify: boolean };
}
export interface DashboardVM {
  today: string; months: string[];
  locations: Array<{ locationId: string; name: string; latest: { auditId: string; scorePct: number | null; passed: boolean | null; completedAt: string | null; name: string } | null; byMonth: Array<number | null>; audits: number; openActions: number; overdueActions: number; nextDue: string | null }>;
  network: Array<{ month: string; averageScorePct: number | null; audits: number }>;
  overdueActions: ActionVM[]; overdueAudits: AuditVM[]; upcoming: AuditVM[];
  totals: { completed: number; passed: number; openActions: number; overdueActions: number; overdueAudits: number; averageScorePct: number | null };
}

export type ComplianceCategory = 'insurance' | 'licence' | 'permit' | 'health_certificate' | 'franchisee_document';
export type CellState = 'valid' | 'expiring' | 'expired' | 'missing' | 'pending' | 'below_minimum' | 'not_applicable';
export interface RequirementVM { id: string; name: string; category: ComplianceCategory; description: string; coverageType: string | null; minAmount: { amountMinor: number; currency: string } | null; appliesTo: 'location' | 'owner_group'; jurisdictions: string[]; requiresExpiry: boolean; active: boolean }
export interface MatrixVM {
  today: string; requirements: RequirementVM[]; totals: Record<string, number>;
  rows: Array<{ location: { id: string; name: string; code: string; regionId: string | null; ownerGroupId: string | null; ownerGroupName: string | null; status: string }; cells: Array<{ requirementId: string; state: CellState; expiresOn: string | null; daysLeft: number | null; documentId: string | null }>; compliant: number; applicable: number }>;
  can: { manage: boolean; upload: boolean; export: boolean };
}
export interface DocumentVM {
  id: string; requirementId: string | null; requirementName: string | null; locationId: string | null; locationName: string | null; ownerGroupId: string | null; ownerGroupName: string | null; category: ComplianceCategory; title: string;
  issuer: string | null; reference: string | null; coverageType: string | null; coverageAmount: { amountMinor: number; currency: string } | null; issuedOn: string | null; expiresOn: string | null; daysLeft: number | null;
  expiry: 'valid' | 'expiring' | 'expired' | null; status: 'pending' | 'approved' | 'rejected'; superseded: boolean; reviewNote: string | null; reviewedAt: string | null; reviewedBy: string | null; uploadedBy: string | null; file: FileRef | null; createdAt: string;
}
export interface RequirementInput { name: string; category: ComplianceCategory; description: string; coverageType: string | null; minAmountMinor: number | null; currency: string | null; appliesTo: 'location' | 'owner_group'; jurisdictions: string[]; requiresExpiry: boolean; active?: boolean }
export interface DocumentInput { requirementId: string | null; locationId: string | null; ownerGroupId: string | null; category: ComplianceCategory; title: string; issuer: string | null; reference: string | null; coverageType: string | null; coverageAmountMinor: number | null; currency: string | null; issuedOn: string | null; expiresOn: string | null; file: Upload }

export type LeagueSort = 'revenue' | 'growth' | 'activity' | 'occupancy' | 'auditScore' | 'royaltyStatus' | 'reviewRating';
export interface LeagueRowVM {
  locationId: string; name: string; code: string; currency: string; regionId: string | null; regionName: string | null; ownerGroupId: string | null; ownerGroupName: string | null;
  revenueMinor: number | null; previousRevenueMinor: number | null; growthPct: number | null; activity: number; occupancyPct: number | null; auditScorePct: number | null; auditPassed: boolean | null; auditAt: string | null;
  royaltyStatus: 'on_time' | 'overdue' | 'none' | null; reviewRating: number | null; reviewCount: number; rank: number; rankOf: number; quartile: 1 | 2 | 3 | 4 | null;
}
export interface LeagueVM {
  period: { from: string; to: string; previousFrom: string; previousTo: string }; sort: LeagueSort; industry: string; activityKind: string | null; view: 'network' | 'own';
  columns: { revenue: boolean; occupancy: boolean; auditScore: boolean; royaltyStatus: boolean; reviewRating: boolean };
  rows: LeagueRowVM[];
  benchmarks: { locationCount: number; revenue: Array<{ currency: string; quartiles: Quartiles | null }>; growthPct: Quartiles | null; activity: Quartiles | null; occupancyPct: Quartiles | null; auditScorePct: Quartiles | null; reviewRating: Quartiles | null; royaltyOnTimePct: number | null } | null;
  networkRanks: Record<string, { position: number; of: number } | null> | null; settings: { franchiseeQuartiles: boolean }; currencies: string[];
  /** Territory and portfolio filter choices holding locations in the viewer's scope. */
  filters?: { territories: { id: string; name: string }[]; portfolios: { id: string; name: string }[] };
  can: { export: boolean; manage: boolean };
}
export interface Upload { filename: string; contentType: string; dataBase64: string }

const o = (p: string) => `/orgs/${orgId()}${p}`;

export const qualityApi = {
  templates: (status: 'active' | 'archived' | 'all' = 'active') => http.get<{ items: TemplateVM[]; canManage: boolean }>(o('/audits/templates'), { status }),
  template: (id: string) => http.get<TemplateVM>(o(`/audits/templates/${id}`)),
  starters: () => http.get<{ items: StarterVM[] }>(o('/audits/starters')),
  createTemplate: (body: AuditTemplateBody | { starterKey: string }) => http.post<TemplateVM>(o('/audits/templates'), body),
  saveTemplate: (id: string, body: AuditTemplateBody) => http.put<TemplateVM>(o(`/audits/templates/${id}`), body),
  setTemplateStatus: (id: string, status: 'active' | 'archived') => http.post<TemplateVM>(o(`/audits/templates/${id}/status`), { status }),
  audits: (q: Query = {}) => http.get<{ items: AuditVM[]; today: string; can: { schedule: boolean; export: boolean } }>(o('/audits'), q),
  audit: (id: string) => http.get<AuditDetailVM>(o(`/audits/${id}`)),
  auditors: (locationId: string) => http.get<{ items: Array<{ id: string; name: string }> }>(o('/audits/auditors'), { locationId }),
  schedule: (body: { locationId: string; templateId: string; dueDate: string; auditorUserId: string | null; purpose?: string; projectId?: string | null }) => http.post<AuditVM>(o('/audits'), body),
  reschedule: (id: string, body: { dueDate?: string; auditorUserId?: string | null }) => http.patch<AuditVM>(o(`/audits/${id}`), body),
  cancel: (id: string, reason?: string) => http.post<AuditVM>(o(`/audits/${id}/cancel`), { reason }),
  saveAnswers: (id: string, answers: Record<string, AuditAnswer>) => http.put<{ id: string; status: string; revision: number; savedAt: string }>(o(`/audits/${id}/answers`), { answers }),
  uploadPhoto: (id: string, file: Upload) => http.post<FileRef>(o(`/audits/${id}/photos`), file),
  complete: (id: string, summary?: string, answers?: Record<string, AuditAnswer>) => http.post<AuditDetailVM>(o(`/audits/${id}/complete`), { summary, answers }),
  dashboard: (months = 6) => http.get<DashboardVM>(o('/audits/dashboard'), { months }),
  actions: (status = 'active') => http.get<{ items: ActionVM[]; today: string }>(o('/audits/actions'), { status }),
  uploadEvidence: (id: string, file: Upload) => http.post<FileRef>(o(`/audits/actions/${id}/evidence`), file),
  submitAction: (id: string, note: string, evidenceFileIds: string[]) => http.post<ActionVM>(o(`/audits/actions/${id}/submit`), { note, evidenceFileIds }),
  verifyAction: (id: string, decision: 'verify' | 'reopen', note?: string) => http.post<ActionVM>(o(`/audits/actions/${id}/verify`), { decision, note }),
  setPreOpening: (projectId: string, templateId: string | null) => http.put<{ projectId: string }>(o(`/audits/projects/${projectId}/pre-opening`), { templateId }),

  requirements: (includeInactive = false) => http.get<{ items: RequirementVM[]; canManage: boolean }>(o('/compliance/requirements'), { includeInactive }),
  addRequirement: (body: RequirementInput) => http.post<RequirementVM>(o('/compliance/requirements'), body),
  saveRequirement: (id: string, body: RequirementInput) => http.put<RequirementVM>(o(`/compliance/requirements/${id}`), body),
  matrix: (q: Query = {}) => http.get<MatrixVM>(o('/compliance/matrix'), q),
  documents: (q: Query = {}) => http.get<{ items: DocumentVM[]; today: string }>(o('/compliance/documents'), q),
  document: (id: string) => http.get<DocumentVM>(o(`/compliance/documents/${id}`)),
  uploadDocument: (body: DocumentInput) => http.post<DocumentVM>(o('/compliance/documents'), body),
  reviewDocument: (id: string, decision: 'approve' | 'reject', note?: string) => http.post<DocumentVM>(o(`/compliance/documents/${id}/review`), { decision, note }),

  league: (q: Query) => http.get<LeagueVM>(o('/league-table'), q),
  leagueSettings: (franchiseeQuartiles: boolean) => http.put<{ franchiseeQuartiles: boolean }>(o('/league-table/settings'), { franchiseeQuartiles }),
  ownerGroups: () => http.get<{ items: Array<{ id: string; name: string }> }>(o('/owner-groups')),
  regions: () => http.get<{ items: Array<{ id: string; name: string }> }>(o('/regions')),
};

/** Downloads an authenticated CSV and saves it with `filename`. */
export async function downloadCsv(path: string, filename: string, query: Query = {}) {
  const url = new URL(`${API_URL}/v1${o(path)}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const get = (token: string | null) => fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: 'include' });
  let res = await get(getAccessToken());
  if (res.status === 401) res = await get(await refreshAccessToken());
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.code ?? 'http_error', body?.error?.message ?? res.statusText, res.status);
  }
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Reads a chosen file as base64; photos are scaled down to 1600 px (JPEG) before upload. */
export async function readUpload(file: File, opts: { shrinkImages?: boolean } = {}): Promise<Upload> {
  if (opts.shrinkImages && /^image\/(jpeg|png|webp)$/.test(file.type)) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      return { filename: file.name.replace(/\.\w+$/, '') + '.jpg', contentType: 'image/jpeg', dataBase64: dataUrl.split(',')[1] ?? '' };
    } catch {
      /* fall back to the original bytes */
    }
  }
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1] ?? '' });
    r.onerror = () => reject(new ApiError('file_unreadable', 'The file could not be read.'));
    r.readAsDataURL(file);
  });
}

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const toErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads data (loading / ready / error, reload). */
export function useQuality<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
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

/** Runs an action, tracking pending + a localized error. */
export function useQualityAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(localize.current(toErr(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { run, pending, error, clearError: () => setError(null) };
}
