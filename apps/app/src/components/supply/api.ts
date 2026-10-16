'use client';

/**
 * Suppliers, supplier rebates, audits phase 2 and self-checks (`/v1/orgs/:orgId/supply|audits|self-checks`). Live API
 * only: the server filters every list to the person's scope (a franchise owner sees the suppliers approved for their
 * own locations and their own orders). Money is integer minor units with its currency, never combined.
 */
import type { AuditAnswer, AuditScheduleBody, AuditSection, PoLine, RebateProgrammeBody, ScheduleTarget, SelfCheckScheduleBody, SupplierBody } from '@bh/shared';
import { http, type Query } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';
import type { FileRef, Upload } from '../quality/api';

export { downloadCsv as downloadFile, readUpload, useQuality as useLoad, useQualityAction as useAction } from '../quality/api';

export interface Scorecard { orders: number; delivered: number; onTimePct: number | null; fillRatePct: number | null; issues: number; score: number | null }
export interface CertVM { id: string; name: string; required: boolean; issuer: string | null; reference: string | null; expiresOn: string | null; daysLeft: number | null; state: 'valid' | 'expiring' | 'expired' | 'missing' | 'pending'; complianceDocument: { id: string; title: string | null; status: string | null } | null; file: FileRef | null }
export interface SupplierVM extends Omit<SupplierBody, 'contract'> {
  id: string; regions: Array<{ id: string; name: string | null }>; contract: SupplierBody['contract']; certifications: CertVM[]; itemCount: number; scorecard: Scorecard | null; updatedAt: string;
}
export interface ItemVM {
  id: string; supplierId: string; supplierName?: string | null; sku: string; name: string; category: string; packLabel: string; unitsPerPack: number; prices: Record<string, number>; moq: number; leadTimeDays: number;
  active: boolean; variantId: string | null; ingredientId: string | null; stockLink: 'variant' | 'ingredient' | null; price?: { amountMinor: number; currency: string } | null;
}
export type PoStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'sent' | 'confirmed' | 'partially_received' | 'received' | 'cancelled';
export interface ReceiptVM { id: string; receivedOn: string; lines: Array<{ itemId: string; received: number; damaged: number; outstandingBefore: number; outstandingAfter: number; issue: string | null; note: string }>; issues: number; note: string; inventory: Array<{ itemId: string; kind: string; units: number }>; receivedBy: { id: string; name: string | null } | null }
export interface PoVM {
  id: string; number: string; status: PoStatus; locationId: string; locationName: string | null; supplierId: string; supplierName: string | null; currency: string; totalMinor: number; lines: PoLine[];
  requestedDeliveryDate: string | null; expectedDeliveryDate: string | null; notes: string; approval: { required: boolean; thresholdMinor: number | null; decision?: string | null; decidedBy?: string | null; decidedAt?: string | null; note?: string | null };
  sentAt: string | null; sentTo: string | null; supplierViewedAt: string | null; confirmedAt: string | null; supplierNote: string | null; supplierReference: string | null; firstDeliveryOn: string | null; receivedAt: string | null; closedShort: boolean;
  packs: { ordered: number; received: number; damaged: number }; late: boolean; createdBy: { id: string; name: string | null } | null; createdAt: string;
  history: Array<{ at: string; event: string; by: string | null; byName: string | null; note: string | null }>; receipts: ReceiptVM[];
  can?: { submit: boolean; approve: boolean; resend: boolean; receive: boolean; cancel: boolean }; confirmUrl?: string | null; approvalRequired?: boolean;
}
export interface OverviewVM {
  today: string; totals: { pendingApproval: number; open: number; late: number; dueThisWeek: number; offContractFlagged: number };
  spendBySupplier: Array<{ supplierId: string; supplier: string; currency: string; amountMinor: number; orders: number }>;
  compliance: Array<{ currency: string; onContractMinor: number; offContractMinor: number; onContractPct: number | null }>;
  deliveries: Array<{ id: string; number: string; status: PoStatus; supplierName: string; locationName: string; expectedDeliveryDate: string | null; late: boolean }>;
  can: { manage: boolean; order: boolean; approve: boolean; export: boolean; rebates: boolean }; locations: Array<{ id: string; name: string; currency: string; country: string }>;
}
export interface OffContractVM {
  id: string; locationId: string; locationName: string | null; vendorName: string; description: string; category: string; amountMinor: number; currency: string; purchasedOn: string; reason: string; note: string;
  receipt: FileRef | null; status: 'flagged' | 'accepted' | 'action_required'; reviewNote: string | null; reviewedBy: { id: string; name: string | null } | null; reviewedAt: string | null; suggestedSupplier: { id: string; name: string | null } | null;
  createdBy: { id: string; name: string | null } | null; createdAt: string;
}
export interface ClaimVM {
  id: string; programmeId: string; supplierId: string; number: string; periodStart: string; periodEnd: string; periodLabel: string; currency: string; spendMinor: number; units: number; tierIndex: number; rate: number; amountMinor: number;
  lines: Array<{ locationId: string; name: string; spendMinor: number; units: number; orders: number; shareMinor: number }>; status: 'draft' | 'submitted' | 'received' | 'void'; submittedAt: string | null; receivedAt: string | null; receivedMinor: number | null; fundShareMinor: number | null;
}
export interface ProgrammeVM extends RebateProgrammeBody {
  id: string; supplierName: string | null;
  current: { start: string; end: string; label: string; spendMinor: number; units: number; tierIndex: number; rate: number; volume: number; accruedMinor: number; next: { from: number; rate: number; remaining: number } | null; fundShareMinor: number; locations: Array<{ locationId: string; name: string; spendMinor: number; units: number; orders: number }> };
  claimable: { start: string; end: string; label: string; spendMinor: number; units: number; accruedMinor: number; tierIndex: number } | null; claims: ClaimVM[];
}

/* Audits phase 2 */
export interface ScheduleVM extends AuditScheduleBody { id: string; templateName: string | null; auditor: { id: string; name: string | null } | null; lastRunAt: string | null; locationCount: number; nextDue: string | null }
export interface TrendsVM {
  months: string[]; network: Array<{ month: string; averageScorePct: number | null; audits: number }>;
  locations: Array<{ locationId: string; name: string; regionId: string | null; byMonth: Array<number | null>; audits: number; averageScorePct: number | null; change: number | null }>;
  regions: Array<{ regionId: string; name: string; byMonth: Array<number | null>; audits: number; averageScorePct: number | null }>;
  sections: Array<{ title: string; byMonth: Array<number | null>; averageScorePct: number | null; audits: number }>;
  mostFailed: Array<{ questionId: string; title: string; sectionTitle: string; critical: boolean; fails: number; asked: number; failRatePct: number; locations: number; topReason: string | null; trainingCourseId: string | null }>;
  totals: { audits: number; averageScorePct: number | null; passRatePct: number | null };
}
export interface VisitStop { auditId: string; name: string; status: string; dueDate: string; overdue: boolean; purpose: string; locationId: string; locationName: string; address: { line1?: string; city?: string; postalCode?: string; country?: string } | null; geo: { lat: number; lng: number } | null; legKm: number | null; order: number }
export interface VisitsVM { from: string; to: string; today: string; overdue: VisitStop[]; overdueKm: number; days: Array<{ date: string; stops: VisitStop[]; totalKm: number }>; visits: number; withoutLocation: number; auditorUserId: string; auditors: Array<{ id: string; name: string }> | null }

/* Self-checks */
export interface SelfScheduleVM extends SelfCheckScheduleBody { id: string; templateName: string | null; locationCount: number }
export interface RunVM {
  id: string; scheduleId: string; scheduleName: string; kind: string | null; locationId: string; locationName: string | null; date: string; dueAt: string; late: boolean; status: 'due' | 'in_progress' | 'completed' | 'missed'; name: string;
  scorePct: number | null; passed: boolean | null; criticalFailed: boolean | null; failedItems: Array<{ questionId: string; text: string; reason: string | null; critical: boolean }>; completedAt: string | null; completedBy: { id: string; name: string | null } | null;
  questionCount: number; answered: number; canFill?: boolean;
}
export interface RunDetailVM extends RunVM { checklist: { name: string; sections: AuditSection[]; passThreshold: number }; answers: Record<string, AuditAnswer>; note: string | null; timeZone: string; canFill: boolean }
export interface SelfDashboardVM {
  today: string; since: string; totals: { runs: number; completed: number; missed: number; failed: number; completionPct: number | null; passPct: number | null };
  locations: Array<{ locationId: string; name: string; runs: number; completionPct: number | null; passPct: number | null; missed: number; criticalFails: number }>;
  byDay: Array<{ date: string; completed: number; missed: number; failed: number; open: number }>; today_runs: RunVM[]; failures: RunVM[]; can: { export: boolean; manage: boolean };
}

const o = (p: string) => `/orgs/${orgId()}${p}`;

export const supplyApi = {
  overview: () => http.get<OverviewVM>(o('/supply/overview')),
  settings: () => http.get<{ approvalThresholds: Record<string, number>; canManage: boolean }>(o('/supply/settings')),
  saveSettings: (approvalThresholds: Record<string, number>) => http.put<{ approvalThresholds: Record<string, number> }>(o('/supply/settings'), { approvalThresholds }),
  suppliers: (q: Query = {}) => http.get<{ items: SupplierVM[]; can: { manage: boolean } }>(o('/supply/suppliers'), q),
  supplier: (id: string) => http.get<SupplierVM & { items: ItemVM[]; can: { manage: boolean } }>(o(`/supply/suppliers/${id}`)),
  createSupplier: (b: SupplierBody) => http.post<SupplierVM>(o('/supply/suppliers'), b),
  saveSupplier: (id: string, b: SupplierBody) => http.put<SupplierVM>(o(`/supply/suppliers/${id}`), b),
  addCert: (id: string, b: { name: string; required: boolean; issuer: string | null; reference: string | null; expiresOn: string | null; file: Upload | null }) => http.post<CertVM>(o(`/supply/suppliers/${id}/certifications`), b),
  addItem: (supplierId: string, b: Omit<ItemVM, 'id' | 'supplierId' | 'stockLink' | 'price' | 'supplierName'>) => http.post<ItemVM>(o(`/supply/suppliers/${supplierId}/items`), b),
  saveItem: (id: string, b: Omit<ItemVM, 'id' | 'supplierId' | 'stockLink' | 'price' | 'supplierName'>) => http.put<ItemVM>(o(`/supply/items/${id}`), b),
  catalogue: (locationId: string, q: Query = {}) => http.get<{ location: { id: string; name: string; currency: string }; suppliers: Array<{ id: string; name: string }>; items: ItemVM[]; canOrder: boolean }>(o('/supply/catalogue'), { locationId, ...q }),
  orders: (q: Query = {}) => http.get<{ items: PoVM[]; today: string; can: { approve: boolean; order: boolean; export: boolean } }>(o('/supply/orders'), q),
  order: (id: string) => http.get<PoVM>(o(`/supply/orders/${id}`)),
  createOrder: (b: { locationId: string; supplierId: string; lines: Array<{ itemId: string; quantity: number }>; requestedDeliveryDate: string | null; notes: string; submit: boolean }) => http.post<PoVM>(o('/supply/orders'), b),
  submit: (id: string) => http.post<PoVM>(o(`/supply/orders/${id}/submit`), {}),
  decide: (id: string, decision: 'approve' | 'reject', note?: string) => http.post<PoVM>(o(`/supply/orders/${id}/decision`), { decision, note }),
  resend: (id: string) => http.post<PoVM>(o(`/supply/orders/${id}/send`), {}),
  receive: (id: string, b: { lines: Array<{ itemId: string; received: number; damaged: number; issue: string | null; note: string }>; note: string; closeShort: boolean }) => http.post<PoVM & { inventory: Array<{ itemId: string; kind: string; units: number }> }>(o(`/supply/orders/${id}/receive`), b),
  cancel: (id: string, reason?: string) => http.post<PoVM>(o(`/supply/orders/${id}/cancel`), { reason }),
  scorecards: () => http.get<{ items: Array<Scorecard & { supplierId: string; name: string; status: string }> }>(o('/supply/scorecards')),
  offContract: (q: Query = {}) => http.get<{ items: OffContractVM[]; can: { review: boolean; log: boolean } }>(o('/supply/off-contract'), q),
  logOffContract: (b: { locationId: string; vendorName: string; description: string; category: string; amountMinor: number; currency: string; purchasedOn: string; reason: string; note: string; receipt: Upload | null }) => http.post<OffContractVM>(o('/supply/off-contract'), b),
  reviewOffContract: (id: string, b: { status: 'accepted' | 'action_required'; note?: string; suggestedSupplierId?: string | null }) => http.post<OffContractVM>(o(`/supply/off-contract/${id}/review`), b),
  rebates: () => http.get<{ items: ProgrammeVM[]; today: string; totals: Array<{ currency: string; accruedMinor: number; claimedOpenMinor: number; receivedMinor: number; fundShareMinor: number }>; can: { edit: boolean; export: boolean } }>(o('/supply/rebates')),
  createProgramme: (b: RebateProgrammeBody) => http.post<ProgrammeVM>(o('/supply/rebates'), b),
  saveProgramme: (id: string, b: RebateProgrammeBody) => http.put<ProgrammeVM>(o(`/supply/rebates/${id}`), b),
  claim: (programmeId: string, periodStart: string) => http.post<ClaimVM>(o(`/supply/rebates/${programmeId}/claims`), { periodStart }),
  submitClaim: (id: string) => http.post<ClaimVM>(o(`/supply/rebates/claims/${id}/submit`), {}),
  claimReceived: (id: string, amountMinor: number, receivedOn: string) => http.post<ClaimVM>(o(`/supply/rebates/claims/${id}/received`), { amountMinor, receivedOn }),
  voidClaim: (id: string) => http.post<ClaimVM>(o(`/supply/rebates/claims/${id}/void`), {}),
};

export const programmesApi = {
  schedules: () => http.get<{ items: ScheduleVM[]; today: string }>(o('/audits/schedules')),
  createSchedule: (b: AuditScheduleBody) => http.post<ScheduleVM>(o('/audits/schedules'), b),
  saveSchedule: (id: string, b: AuditScheduleBody) => http.put<ScheduleVM>(o(`/audits/schedules/${id}`), b),
  deleteSchedule: (id: string) => http.del<void>(o(`/audits/schedules/${id}`)),
  preview: (id: string) => http.get<{ dates: string[]; locations: Array<{ locationId: string; name: string; auditorUserId: string | null; auditorName: string | null; source: string }> }>(o(`/audits/schedules/${id}/preview`)),
  runSchedule: (id: string) => http.post<{ created: number }>(o(`/audits/schedules/${id}/run`), {}),
  trends: (q: Query = {}) => http.get<TrendsVM>(o('/audits/trends'), q),
  visits: (q: Query = {}) => http.get<VisitsVM>(o('/audits/visits'), q),
  courses: () => http.get<{ items: Array<{ id: string; title: string }> }>(o('/audits/courses')),
  assignTraining: (actionId: string, courseId: string) => http.post<unknown>(o(`/audits/actions/${actionId}/training`), { courseId }),
  selfStarters: () => http.get<{ items: Array<{ key: string; kind: string; name: string; description: string; dueTime: string; questionCount: number }> }>(o('/self-checks/starters')),
  selfTemplates: () => http.get<{ items: Array<{ id: string; name: string; starterKey: string | null; questionCount: number }> }>(o('/self-checks/templates')),
  selfTemplateFromStarter: (starterKey: string) => http.post<{ id: string; name: string }>(o('/self-checks/templates'), { starterKey }),
  selfSchedules: () => http.get<{ items: SelfScheduleVM[]; can: { manage: boolean; manageAll: boolean } }>(o('/self-checks/schedules')),
  createSelfSchedule: (b: SelfCheckScheduleBody) => http.post<SelfScheduleVM>(o('/self-checks/schedules'), b),
  saveSelfSchedule: (id: string, b: SelfCheckScheduleBody) => http.put<SelfScheduleVM>(o(`/self-checks/schedules/${id}`), b),
  deleteSelfSchedule: (id: string) => http.del<void>(o(`/self-checks/schedules/${id}`)),
  today: (q: Query = {}) => http.get<{ today: string; items: RunVM[] }>(o('/self-checks/today'), q),
  selfDashboard: (days = 14) => http.get<SelfDashboardVM>(o('/self-checks/dashboard'), { days }),
  run: (id: string) => http.get<RunDetailVM>(o(`/self-checks/runs/${id}`)),
  saveRun: (id: string, answers: Record<string, AuditAnswer>) => http.put<{ savedAt: string }>(o(`/self-checks/runs/${id}/answers`), { answers }),
  runPhoto: (id: string, file: Upload) => http.post<FileRef>(o(`/self-checks/runs/${id}/photos`), file),
  completeRun: (id: string, answers: Record<string, AuditAnswer>, note?: string) => http.post<RunDetailVM>(o(`/self-checks/runs/${id}/complete`), { answers, note }),
};

export type { ScheduleTarget };
