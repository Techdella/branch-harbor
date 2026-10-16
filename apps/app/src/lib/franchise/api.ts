'use client';

/**
 * Franchise development, new-location onboarding and legal: live API only (/v1/orgs/:orgId/franchise/*,
 * /v1/orgs/:orgId/legal/*). There is no sample-data layer: without the API these screens say so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComplianceResult, FranchiseStage, JurisdictionRule } from '@bh/shared';
import { ApiError } from '../errors';
import { API_URL, getAccessToken, http } from '../http/client';
import { orgId } from '../http/workspace';
import { useLocalizeErrorRef } from '../useErrorText';

export interface Money { amount: number; currency: string }

export interface Prospect {
  id: string; name: string; email: string; phone: string | null; country: string; region: string | null; city: string | null; jurisdiction: string;
  territoryId: string | null; territoryName: string | null; desiredTerritory: string | null; liquidCapital: Money | null; netWorth: Money | null; selfDeclared: true; units: number;
  source: string; attribution: Record<string, string>; message: string | null; stage: FranchiseStage; stageEnteredAt: string; ownerUserId: string | null; ownerName: string | null;
  lostReason: string | null; ownerGroupId: string | null; createdAt: string; updatedAt: string;
  openTasks?: number; overdueTasks?: number; nextDueAt?: string | null;
  signing?: { canSign: boolean; earliestSigningAt: string | null; blocker: { code: string; message: string; until: string | null } | null } | null;
}

export interface Task {
  id: string; prospectId: string | null; projectId: string | null; section: string | null; kind: 'email' | 'call' | 'task'; title: string; assignee: 'hq' | 'owner';
  ownerName: string | null; gate: boolean; dueAt: string | null; status: 'open' | 'done' | 'skipped'; completedAt: string | null; overdue: boolean; prospectName?: string | null;
}

export interface ProspectDetail extends Prospect {
  compliance: ComplianceResult;
  activities: Array<{ id: string; kind: string; body: string | null; metadata: Record<string, unknown>; actorName: string | null; createdAt: string }>;
  tasks: Task[];
  deliveries: Array<{ id: string; kind: 'disclosure' | 'agreement'; document: { id: string; title: string; version: string; jurisdictions: string[] }; deliveredAt: string; openedAt: string | null; receiptSignedAt: string | null; receiptName: string | null; receiptIp: string | null; materialChange: boolean }>;
  signatures: Array<{ id: string; provider: string; status: string; sentAt: string; signedAt: string | null; signerName: string | null; signerIp: string | null; terms: Record<string, unknown> }>;
  invoices: Array<{ id: string; description: string; amount: Money; status: string; paidAt: string | null; createdAt: string }>;
  project: { id: string; name: string; status: string; locationId: string | null } | null;
}

export interface Territory { id: string; name: string; country: string; region: string | null; jurisdiction: string; description: string | null; status: 'available' | 'reserved' | 'sold' | 'unavailable'; showOnSite: boolean; activeProspects: number }
export interface FranchiseDocument { id: string; kind: 'disclosure' | 'agreement_template' | 'executed_agreement' | 'vault'; title: string; version: string; jurisdictions: string[]; status: string; issuedOn: string | null; fileName: string; contentType: string; sizeBytes: number; createdAt: string; brandId?: string | null }
export interface Project {
  id: string; name: string; status: 'active' | 'go_live_requested' | 'opened' | 'cancelled'; prospectId: string | null; prospectName: string | null; ownerGroupId: string | null; ownerEmail: string | null; ownerInvitationId: string | null;
  location: { id: string; name: string; status: string; publiclyVisible: boolean; slug: string } | null; targetOpenDate: string | null; startedAt: string; openedAt: string | null;
  progress: { done: number; total: number; overdue: number }; gates: { done: number; total: number }; canRequestGoLive: boolean; tasks?: Task[];
  /** Pre-opening checks with an audit checklist (Operations → Audits): an audit with it must pass before go-live. */
  preOpening?: { templateId: string; templateName: string | null; passed: boolean; passedAuditId: string | null; latest: { id: string; status: string; dueDate: string; scorePct: number | null; passed: boolean | null } | null } | null;
}
export interface Agreement {
  id: string; ownerGroupId: string | null; ownerGroupName: string | null; territory: string | null; jurisdiction: string | null; startDate: string; endDate: string; termYears: number | null;
  renewalOption: string | null; royaltyBps: number | null; marketingFundBps: number | null; status: string; daysToExpiry: number; expiringSoon: boolean; locationIds: string[];
}
export type Rule = JurisdictionRule & { id: string; origin: 'platform' | 'organization'; reviewedAt: string | null; reviewNote: string | null };
export interface Registration { id: string; jurisdiction: string; status: string; fileNumber: string | null; effectiveFrom: string | null; expiresAt: string | null; notes: string | null; active: boolean }
export interface FranchiseSettings {
  homeCountry: string; homeRegion: string | null; enquiryFormEnabled: boolean; defaultOwnerUserId: string | null; collectLocationId: string | null; brandSlug: string;
  esign: Array<{ key: string; mode: string }>; esignDisclaimer: string; disclaimer: string; canEdit: boolean; legal: { view: boolean; edit: boolean };
}

const F = (p: string) => `/orgs/${orgId()}/franchise${p}`;
const L = (p: string) => `/orgs/${orgId()}/legal${p}`;

export const franchiseApi = {
  settings: () => http.get<FranchiseSettings>(F('/settings')),
  saveSettings: (b: Partial<Pick<FranchiseSettings, 'homeRegion' | 'enquiryFormEnabled' | 'defaultOwnerUserId' | 'collectLocationId'>>) => http.put<FranchiseSettings>(F('/settings'), b),
  prospects: (q: { stage?: string; q?: string } = {}) => http.get<{ items: Prospect[] }>(F('/prospects'), q).then((r) => r.items),
  prospect: (id: string) => http.get<ProspectDetail>(F(`/prospects/${id}`)),
  createProspect: (b: Record<string, unknown>) => http.post<Prospect>(F('/prospects'), b),
  setStage: (id: string, to: FranchiseStage, extra: { note?: string; lostReason?: string } = {}) => http.post<Prospect>(F(`/prospects/${id}/stage`), { to, ...extra }),
  addActivity: (id: string, kind: string, body: string) => http.post(F(`/prospects/${id}/activities`), { kind, body }),
  sendDisclosure: (id: string, documentId: string) => http.post<{ deliveryId: string; stage: string; link: string; warnings: Array<{ code: string; message: string }>; devToken?: string }>(F(`/prospects/${id}/disclosures`), { documentId }),
  sendAgreement: (id: string, b: { documentId: string; provider: string; materialChange: boolean; terms: Record<string, unknown> }) => http.post<{ signatureId: string; link: string | null; devToken?: string }>(F(`/prospects/${id}/agreement`), b),
  recordSignature: (id: string, signatureId: string, signerName: string) => http.post<{ projectId: string }>(F(`/prospects/${id}/agreement/record-signature`), { signatureId, signerName }),
  feeInvoice: (id: string, b: { amountMinor: number; currency: string; description: string }) => http.post<{ invoiceId: string; paymentId: string }>(F(`/prospects/${id}/fee-invoices`), b),
  reserveTerritory: (id: string, territoryId: string | null) => http.post(F(`/prospects/${id}/territory-reservation`), { territoryId }),
  tasks: (q: { mine?: boolean; status?: string } = {}) => http.get<{ items: Task[] }>(F('/tasks'), q).then((r) => r.items),
  completeTask: (id: string) => http.post<Task>(F(`/tasks/${id}/complete`)),
  reopenTask: (id: string) => http.post<Task>(F(`/tasks/${id}/reopen`)),
  territories: () => http.get<{ items: Territory[] }>(F('/territories')).then((r) => r.items),
  createTerritory: (b: Record<string, unknown>) => http.post<Territory>(F('/territories'), b),
  updateTerritory: (id: string, b: Record<string, unknown>) => http.patch<Territory>(F(`/territories/${id}`), b),
  documents: (kind?: string) => http.get<{ items: FranchiseDocument[] }>(F('/documents'), { kind }).then((r) => r.items),
  uploadDocument: (b: Record<string, unknown>) => http.post<FranchiseDocument>(F('/documents'), b),
  projects: () => http.get<{ items: Project[] }>(F('/projects')).then((r) => r.items),
  project: (id: string) => http.get<Project>(F(`/projects/${id}`)),
  provision: (id: string, b: Record<string, unknown>) => http.post<{ locationId: string; invitationId: string | null }>(F(`/projects/${id}/provision`), b),
  goLive: (id: string, comment?: string) => http.post<{ approvalId: string }>(F(`/projects/${id}/go-live`), { comment }),
  rules: () => http.get<{ disclaimer: string; reviewedCount: number; items: Rule[] }>(F('/rules')),
  evaluate: (country: string, region?: string) => http.get<ComplianceResult>(F('/rules/evaluate'), { country, region: region || undefined }),
  reviewRule: (id: string, reviewed: boolean, note?: string) => http.post(F(`/rules/${id}/review`), { reviewed, note }),
  registrations: () => http.get<{ items: Registration[] }>(F('/registrations')).then((r) => r.items),
  saveRegistration: (jurisdiction: string, b: Record<string, unknown>) => http.put(F(`/registrations/${jurisdiction}`), b),
  agreements: () => http.get<{ scope: 'all' | 'own'; items: Agreement[] }>(L('/agreements')),
  createAgreement: (b: Record<string, unknown>) => http.post<Agreement>(L('/agreements'), b),
  ownerGroups: () => http.get<{ items: Array<{ id: string; name: string }> }>(F('/owner-groups')).then((r) => r.items),
};

/** Download a document with the bearer token (the browser cannot add it to a plain link). */
export async function downloadDocument(d: Pick<FranchiseDocument, 'id' | 'fileName'>) {
  const res = await fetch(`${API_URL}/v1${F(`/documents/${d.id}/download`)}`, { headers: { authorization: `Bearer ${getAccessToken() ?? ''}` }, credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status === 403 ? 'forbidden' : 'download_failed', `Download failed (${res.status})`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = d.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export type FResource<T> = { status: 'loading' | 'ready' | 'error'; data?: T; error?: ApiError; reload: () => void; setData: (d: T) => void };

/** Loads franchise data from the live API; re-runs when `deps` change. */
export function useFranchise<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): FResource<T> {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; data?: T; error?: ApiError }>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setState((s) => ({ status: 'loading', data: keep ? s.data : undefined }));
    fnRef.current().then(
      (data) => { if (id === seq.current) setState({ status: 'ready', data }); },
      (e: unknown) => { if (id === seq.current) setState({ status: 'error', error: localize.current(e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Error')) }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { if (enabled) load(); }, [load, enabled]);
  return { ...state, reload: useCallback(() => load(true), [load]), setData: useCallback((d: T) => setState({ status: 'ready', data: d }), []) };
}

/** Runs a franchise mutation and keeps its pending / error state. */
export function useFranchiseAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(localize.current(e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Error')));
      return undefined;
    } finally {
      setPending(false);
    }
  }, [localize]);
  return { run, pending, error, clear: () => setError(null) };
}
