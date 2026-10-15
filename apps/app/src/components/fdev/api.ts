'use client';

/**
 * Franchise development API (`/v1/orgs/:orgId/territories|surveys|validation|lifecycle|master`). Live API only; the
 * server filters by capability and scope. Money is integer minor units with its currency.
 */
import type { Demographics, ScorePart, SurveyBody, SurveyQuestion, TerritoryGeometry } from '@bh/shared';
import type { MapConfig } from '@bh/ui/map';
import { http, type Query } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

export { downloadCsv as download, readUpload, useQuality as useLoad, useQualityAction as useAction } from '../quality/api';

const o = (p: string) => `/orgs/${orgId()}${p}`;
export interface Money { amountMinor: number; currency: string }

/* ------------------------------ territories ----------------------------- */

export interface Overlap { id: string; name: string; status: string; by: Array<'area' | 'postcodes'>; sharedPostcodes: string[]; conflict: boolean }
export interface TerritoryVM {
  id: string; name: string; country: string; region: string | null; jurisdiction: string; description: string | null; status: string; derivedStatus: string; exclusivity: 'exclusive' | 'protected' | 'non_exclusive';
  showOnSite: boolean; geometry: TerritoryGeometry | null; postcodes: string[]; areaKm2: number | null; centroid: { lat: number; lng: number } | null; demographics: Demographics | null; score: number | null; scoreParts: ScorePart[] | null;
  ownerGroupId: string | null; ownerGroupName: string | null; agreementId: string | null; masterAgreementId: string | null; statusChangedAt: string | null; updatedAt: string; overlaps: Overlap[];
  links: { prospects: Array<{ id: string; name: string; stage: string }>; agreement: { id: string; ownerGroupName: string | null; startDate: string; endDate: string } | null; project: { id: string; status: string; targetOpenDate: string | null } | null; openLocations: Array<{ id: string; name: string }> } | null;
}
export interface TerritorySettingsVM { publicMap: boolean; showTaken: boolean; targets: { population: number; households: number; incomeMinor: number } }
export interface TerritoryListVM { items: TerritoryVM[]; settings: TerritorySettingsVM; map: MapConfig; brandSlug: string; homeCountry: string; locations: Array<{ id: string; name: string; status: string; lat: number; lng: number }>; demographics: { census: boolean }; can: { edit: boolean; publish: boolean; export: boolean } }
export interface TerritoryInput { name: string; country: string; region?: string | null; description?: string | null; status?: string; exclusivity?: string; showOnSite?: boolean; geometry?: TerritoryGeometry | null; postcodesText?: string }

/* -------------------------------- surveys ------------------------------- */

export interface SurveyVM extends SurveyBody { id: string; status: 'draft' | 'active' | 'archived'; nextRunOn: string | null; rounds: Array<{ id: string; label: string; opensOn: string; closesOn: string; status: 'open' | 'closed'; invited: number }>; openRoundId: string | null; createdAt: string }
export interface SurveyListVM { toAnswer: Array<{ id: string; title: string; description: string | null; anonymous: boolean; roundId: string; closesOn: string; answered: boolean }>; surveys: SurveyVM[]; can: { manage: boolean; results: boolean; export: boolean; actions: boolean }; starter: SurveyBody }
export interface Nps { n: number; promoters: number; passives: number; detractors: number; score: number | null }
export interface QuestionResult { id: string; type: SurveyQuestion['type']; label: string; theme: string | null; answered: number; average?: number | null; nps?: Nps; distribution?: number[]; options?: Array<{ option: string; count: number }> }
export interface Slice { id: string; name: string; responses: number; visible: boolean; nps: number | null; themes: Array<{ theme: string; average: number | null }> }
export interface RoundResult {
  roundId: string; label: string; opensOn: string; closesOn: string; status: string; responses: number; invited: number; responseRate: number | null; visible: boolean; minResponses: number; anonymous: boolean;
  nps: Nps | null; questions: QuestionResult[]; themes?: Array<{ theme: string; average: number | null }>; byRegion: Slice[]; byOwnerGroup: Slice[]; comments: Array<{ questionId: string; text: string }>;
}
export interface ActionPlanVM { id: string; roundId: string | null; theme: string | null; title: string; description: string | null; ownerUserId: string | null; ownerName: string | null; dueOn: string | null; status: 'open' | 'in_progress' | 'done'; shared: boolean }
export interface ResultsVM { survey: SurveyVM; scope: 'all' | 'partial'; round: RoundResult | null; trend: Array<{ roundId: string; label: string; opensOn: string; responses: number; nps: number | null; themes: Array<{ theme: string; average: number | null }> }>; actions: ActionPlanVM[] }
export interface RespondVM { id: string; title: string; description: string | null; anonymous: boolean; minResponses: number; questions: SurveyQuestion[]; round: { id: string; label: string; closesOn: string }; answered: boolean }

/* ------------------------------- validation ------------------------------ */

export interface ValidatorVM { id: string; userId: string; name: string; ownerGroupName: string | null; locationName: string | null; country: string | null; region: string | null; active: boolean; maxCallsPerMonth: number; bio: string | null; schedulingUrl: string | null; callsLast90: number; callsThisMonth: number; lastCallAt: string | null }
export interface CallVM { id: string; prospectId: string; validatorId: string; status: 'requested' | 'scheduled' | 'completed' | 'no_show' | 'cancelled'; scheduledAt: string | null; proposedTimes: string | null; completedAt: string | null; sentiment: 'positive' | 'neutral' | 'negative' | null; outcome: string | null; createdAt: string; validatorName?: string | null; prospectName?: string | null; prospectCity?: string | null; prospectStage?: string }
export interface CallsVM { items: CallVM[]; candidates: Array<{ id: string; name: string; stage: string; city: string | null; country: string; calls: number }>; can: { edit: boolean } }
export interface ValidatorMeVM { eligible: boolean; validator: { id: string; active: boolean; bio: string | null; schedulingUrl: string | null; phone: string | null; maxCallsPerMonth: number; optedInAt: string } | null; calls: CallVM[] }

/* ------------------------------- lifecycle ------------------------------- */

export interface StepState { key: string; done: boolean; doneAt: string | null; doneBy: string | null; note: string | null }
export interface TransferVM { id: string; agreementId: string; territory: string | null; fromOwnerGroupName: string | null; toOwnerGroupName: string | null; buyerName: string; status: string; steps: StepState[]; transferFee: Money; feePaidAt: string | null; effectiveDate: string | null; reason: string | null; decidedAt: string | null; decisionNote: string | null; completedAt: string | null; createdAt: string; readyForApproval: boolean; readyToComplete: boolean; progress: { done: number; total: number } }
export interface NoticeVM { id: string; agreementId: string; ownerGroupName: string | null; parentId: string | null; kind: string; reason: string; details: string; subject: string; body: string; cureDays: number | null; cureDeadline: string | null; daysLeft: number | null; cureOverdue: boolean; status: string; escalationLevel: number; counselReviewed: boolean; counselReviewedAt: string | null; counselNote: string | null; issuedAt: string | null; deliveredTo: string | null; resolvedAt: string | null; resolutionNote: string | null; createdAt: string }
export interface NoticeDetailVM extends NoticeVM { agreement: { id: string; territory: string | null; jurisdiction: string | null; startDate: string; endDate: string; status: string }; jurisdictionNotes: Array<{ code: string; name: string; renewalTermination: string | null; reviewedByCounsel: boolean }>; history: NoticeVM[]; counselNotice: string }
export interface AmendmentVM { id: string; agreementId: string; title: string; summary: string | null; changes: Record<string, string | number | null>; previous: Record<string, string | number | null>; effectiveDate: string; status: string; counselReviewed: boolean; signedAt: string | null }
export interface RenewalVM { id: string; agreementId: string; ownerGroupName: string | null; territory: string | null; endDate: string; renewalOption: string | null; windowOpensOn: string; windowClosesOn: string; phase: string; status: string; daysToWindowClose: number; noticeReceivedOn: string | null; conditions: Array<{ key: string; done: boolean; doneAt: string | null }>; renewalFee: Money; newTermYears: number | null; newAgreementId: string | null; decisionNote: string | null }
export interface DevItemVM { id: string; sequence: number; label: string; territoryId: string | null; territoryName: string | null; signByDate: string | null; openByDate: string; status: string; locationId: string | null; locationName: string | null; signedOn: string | null; openedOn: string | null; note: string | null; overdue: boolean }
export interface DevelopmentVM { id: string; ownerGroupId: string; ownerGroupName: string | null; name: string; unitsTotal: number; startDate: string; status: string; territories: Array<{ id: string; name: string | null }>; developmentFee: Money; notes: string | null; progress: { total: number; opened: number; signed: number; waived: number; dueToOpen: number; dueToSign: number; behind: boolean; overdue: number[]; nextDeadline: string | null }; items: DevItemVM[] }
export interface OverviewVM { today: string; transfersOpen: number; noticesOpen: number; curePeriodsEnding: number; curesOverdue: number; renewalWindowsOpen: number; developmentBehind: number; can: { edit: boolean; publish: boolean; export: boolean }; counselNotice: string }
export interface AgreementPick { id: string; ownerGroupId: string | null; ownerGroupName: string | null; territory: string | null; jurisdiction: string | null; startDate: string; endDate: string; royaltyBps: number | null; marketingFundBps: number | null; renewalOption: string | null }

/* --------------------------------- master -------------------------------- */

export interface SplitRuleVM { currency: string | null; royaltyShareBps: number; fundShareBps: number }
export interface MasterVM { id: string; ownerGroupId: string; ownerGroupName: string | null; kind: 'master_franchisee' | 'area_representative'; name: string; countries: string[]; regions: string[]; homeCountry: string; homeRegion: string | null; startDate: string; endDate: string | null; status: string; splits: SplitRuleVM[]; payoutMethod: 'stripe_transfer' | 'manual'; stripeAccountConnected: boolean; activeProspects?: number; units?: number }
export interface SplitLineVM { locationId: string; locationName: string; statementStatus: string; royaltyMinor: number; marketingFundMinor: number; collectedRoyaltyMinor: number; collectedFundMinor: number; masterRoyaltyMinor: number; masterFundMinor: number }
export interface SplitStatementVM {
  id: string; masterAgreementId: string; masterName: string | null; ownerGroupName: string | null; periodId: string; period: { startDate: string; endDate: string } | null; currency: string; number: string; royaltyShareBps: number; fundShareBps: number; lines: SplitLineVM[];
  royaltyMinor: number; marketingFundMinor: number; masterRoyaltyMinor: number; masterFundMinor: number; hqRoyaltyMinor: number; hqFundMinor: number; payableMinor: number; status: 'draft' | 'approved' | 'paid'; approvedAt: string | null; payoutMethod: string | null; transferId: string | null; payoutReference: string | null; paidAt: string | null; sandbox: boolean;
}
export interface MasterPipelineVM { agreement: MasterVM; map: MapConfig; prospects: Array<{ id: string; name: string; email: string; country: string; region: string | null; city: string | null; stage: string; territoryName: string | null; createdAt: string }>; territories: Array<{ id: string; name: string; country: string; region: string | null; status: string; geometry: TerritoryGeometry | null; centroid: { lat: number; lng: number } | null }>; documents: Array<{ id: string; title: string; version: string; jurisdictions: string[] }>; can: { edit: boolean; disclose: boolean } }

export const fdevApi = {
  territories: () => http.get<TerritoryListVM>(o('/territories')),
  createTerritory: (b: TerritoryInput) => http.post<TerritoryVM>(o('/territories'), b),
  updateTerritory: (id: string, b: Partial<TerritoryInput>) => http.patch<TerritoryVM>(o(`/territories/${id}`), b),
  deleteTerritory: (id: string) => http.del<void>(o(`/territories/${id}`)),
  checkTerritory: (b: { id?: string; geometry?: TerritoryGeometry | null; postcodes?: string[]; exclusivity?: string; status?: string }) => http.post<{ overlaps: Overlap[] }>(o('/territories/check'), b),
  syncStatus: (ids?: string[]) => http.post<{ changed: Array<{ id: string; from: string; to: string }> }>(o('/territories/sync-status'), ids ? { ids } : {}),
  refreshDemographics: (id: string) => http.post<TerritoryVM & { performance: { nearbyLocations: number; nearbyRevenueMinor: number | null; networkMedianRevenueMinor: number | null; currency: string | null } }>(o(`/territories/${id}/demographics`)),
  territorySettings: (b: Partial<TerritorySettingsVM>) => http.put<TerritorySettingsVM>(o('/territories/settings'), b),
  importGeoJson: (data: unknown, country?: string) => http.post<{ created: number; updated: number; skipped: Array<{ name: string; reason: string }> }>(o('/territories/import'), { data, country }),

  surveys: () => http.get<SurveyListVM>(o('/surveys')),
  createSurvey: (b: SurveyBody) => http.post<SurveyVM>(o('/surveys'), b),
  saveSurvey: (id: string, b: SurveyBody) => http.put<SurveyVM>(o(`/surveys/${id}`), b),
  launchSurvey: (id: string) => http.post<SurveyVM>(o(`/surveys/${id}/launch`)),
  closeSurvey: (id: string, archive = false) => http.post<SurveyVM>(o(`/surveys/${id}/close`), { archive }),
  respondForm: (id: string) => http.get<RespondVM>(o(`/surveys/${id}/respond`)),
  respond: (id: string, answers: Record<string, number | string | null>) => http.post<{ status: string }>(o(`/surveys/${id}/respond`), { answers }),
  results: (id: string, roundId?: string) => http.get<ResultsVM>(o(`/surveys/${id}/results`), roundId ? { roundId } : {}),
  addAction: (id: string, b: Partial<ActionPlanVM> & { title: string }) => http.post<{ id: string }>(o(`/surveys/${id}/actions`), b),
  updateAction: (id: string, actionId: string, b: Partial<ActionPlanVM>) => http.patch<{ id: string }>(o(`/surveys/${id}/actions/${actionId}`), b),

  validators: () => http.get<{ items: ValidatorVM[] }>(o('/validation/validators')),
  updateValidator: (id: string, b: { active?: boolean; maxCallsPerMonth?: number }) => http.patch(o(`/validation/validators/${id}`), b),
  calls: (q: Query = {}) => http.get<CallsVM>(o('/validation/calls'), q),
  assign: (prospectId: string, count = 3) => http.post<{ calls: CallVM[]; link: string }>(o(`/validation/prospects/${prospectId}/assign`), { count }),
  updateCall: (id: string, b: Partial<Pick<CallVM, 'status' | 'scheduledAt' | 'sentiment' | 'outcome'>>) => http.patch<CallVM>(o(`/validation/calls/${id}`), b),
  validatorMe: () => http.get<ValidatorMeVM>(o('/validation/me')),
  saveValidatorMe: (b: { active: boolean; bio?: string | null; schedulingUrl?: string | null; phone?: string | null; maxCallsPerMonth?: number }) => http.put<{ id: string; active: boolean }>(o('/validation/me'), b),

  overview: () => http.get<OverviewVM>(o('/lifecycle/overview')),
  agreements: () => http.get<{ items: AgreementPick[] }>(o('/lifecycle/agreements')),
  transfers: () => http.get<{ items: TransferVM[]; steps: string[]; approvalSteps: string[] }>(o('/lifecycle/transfers')),
  createTransfer: (b: { agreementId: string; buyerName?: string; toOwnerGroupId?: string | null; transferFeeMinor?: number; currency?: string; effectiveDate?: string | null; reason?: string | null }) => http.post<TransferVM>(o('/lifecycle/transfers'), b),
  transferStep: (id: string, key: string, done: boolean) => http.post<TransferVM>(o(`/lifecycle/transfers/${id}/steps/${key}`), { done }),
  decideTransfer: (id: string, decision: 'approve' | 'reject', note?: string) => http.post<TransferVM>(o(`/lifecycle/transfers/${id}/decide`), { decision, note }),
  completeTransfer: (id: string) => http.post<TransferVM>(o(`/lifecycle/transfers/${id}/complete`)),
  cancelTransfer: (id: string) => http.post<TransferVM>(o(`/lifecycle/transfers/${id}/cancel`), {}),
  notices: () => http.get<{ items: NoticeVM[]; defaultCureDays: Record<string, number>; counselNotice: string }>(o('/lifecycle/notices')),
  notice: (id: string) => http.get<NoticeDetailVM>(o(`/lifecycle/notices/${id}`)),
  draftNotice: (b: { agreementId: string; kind?: string; reason: string; details: string; cureDays?: number | null }) => http.post<NoticeVM>(o('/lifecycle/notices'), b),
  editNotice: (id: string, b: { subject?: string; body?: string; cureDays?: number }) => http.patch<NoticeVM>(o(`/lifecycle/notices/${id}`), b),
  counselReview: (id: string, reviewed: boolean, note?: string) => http.post<NoticeVM>(o(`/lifecycle/notices/${id}/counsel-review`), { reviewed, note }),
  issueNotice: (id: string, deliveredTo?: string) => http.post<NoticeVM>(o(`/lifecycle/notices/${id}/issue`), { deliveredTo: deliveredTo || null }),
  resolveNotice: (id: string, outcome: 'cured' | 'escalate' | 'terminate' | 'withdraw', b: { note?: string; extendDays?: number } = {}) => http.post<NoticeVM>(o(`/lifecycle/notices/${id}/resolve`), { outcome, ...b }),
  amendments: () => http.get<{ items: AmendmentVM[] }>(o('/lifecycle/amendments')),
  createAmendment: (b: { agreementId: string; title: string; summary?: string | null; changes: Record<string, string | number>; effectiveDate: string }) => http.post<{ id: string }>(o('/lifecycle/amendments'), b),
  signAmendment: (id: string) => http.post(o(`/lifecycle/amendments/${id}/sign`), { counselReviewed: true }),
  cancelAmendment: (id: string) => http.post(o(`/lifecycle/amendments/${id}/cancel`)),
  renewals: () => http.get<{ items: RenewalVM[]; conditions: string[] }>(o('/lifecycle/renewals')),
  renewalNotice: (agreementId: string, receivedOn: string) => http.post(o(`/lifecycle/renewals/${agreementId}/notice`), { receivedOn }),
  renewalCondition: (agreementId: string, key: string, done: boolean) => http.post(o(`/lifecycle/renewals/${agreementId}/conditions/${key}`), { done }),
  decideRenewal: (agreementId: string, decision: 'approve' | 'decline', newTermYears?: number) => http.post(o(`/lifecycle/renewals/${agreementId}/decide`), { decision, newTermYears }),
  completeRenewal: (agreementId: string) => http.post<{ newAgreementId: string }>(o(`/lifecycle/renewals/${agreementId}/complete`)),
  development: () => http.get<{ items: DevelopmentVM[] }>(o('/lifecycle/development')),
  createDevelopment: (b: { ownerGroupId: string; name: string; unitsTotal: number; startDate: string; territoryIds?: string[]; intervalMonths?: number; developmentFeeMinor?: number }) => http.post<DevelopmentVM>(o('/lifecycle/development'), b),
  updateDevItem: (id: string, itemId: string, b: Partial<Pick<DevItemVM, 'status' | 'locationId' | 'note' | 'openByDate' | 'signByDate'>>) => http.patch<DevelopmentVM>(o(`/lifecycle/development/${id}/items/${itemId}`), b),
  mine: () => http.get<{ notices: NoticeVM[]; renewals: RenewalVM[]; development: DevelopmentVM[] }>(o('/lifecycle/mine')),

  masters: () => http.get<{ view: 'hq' | 'master'; items: MasterVM[]; can: { manage: boolean; splits: boolean; pay: boolean } }>(o('/master/agreements')),
  createMaster: (b: Record<string, unknown>) => http.post<MasterVM>(o('/master/agreements'), b),
  updateMaster: (id: string, b: Record<string, unknown>) => http.patch<MasterVM>(o(`/master/agreements/${id}`), b),
  masterPipeline: (id: string) => http.get<MasterPipelineVM>(o(`/master/agreements/${id}/pipeline`)),
  masterProspect: (id: string, b: Record<string, unknown>) => http.post(o(`/master/agreements/${id}/prospects`), b),
  masterStage: (id: string, pid: string, stage: string) => http.post(o(`/master/agreements/${id}/prospects/${pid}/stage`), { stage }),
  masterDisclose: (id: string, pid: string, documentId: string) => http.post<{ link: string }>(o(`/master/agreements/${id}/prospects/${pid}/disclosure`), { documentId }),
  periods: () => http.get<{ items: Array<{ id: string; startDate: string; endDate: string; status: string }> }>(o('/master/periods')),
  statements: () => http.get<{ view: 'hq' | 'master'; items: SplitStatementVM[]; can: { generate: boolean; approve: boolean; export: boolean }; stripeMode: 'live' | 'sandbox' }>(o('/master/statements')),
  generateStatements: (periodId: string) => http.post<{ items: SplitStatementVM[]; skipped: Array<{ masterAgreementId: string; currency: string; reason: string }> }>(o('/master/statements/generate'), { periodId }),
  approveStatement: (id: string) => http.post<SplitStatementVM>(o(`/master/statements/${id}/approve`)),
  payStatement: (id: string, b: { method?: 'stripe_transfer' | 'manual'; reference?: string }) => http.post<SplitStatementVM>(o(`/master/statements/${id}/pay`), b),

  ownerGroups: () => http.get<{ items: Array<{ id: string; name: string }> }>(o('/owner-groups')),
};
