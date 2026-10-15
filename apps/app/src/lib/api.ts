/**
 * Typed client for the BranchHarbor API (`NEXT_PUBLIC_API_URL`, routes under /v1).
 *
 * `httpApi` (src/lib/http) calls apps/api with bearer + refresh-cookie auth, maps every method to the real
 * `/v1/orgs/:orgId/...` endpoints and adapts responses to the view models in ./types. There is no sample data:
 * when the API is unreachable, calls fail with a network `ApiError` and screens show their offline / error state.
 */
import { httpApi } from './http/httpApi';
import type { BusinessApi } from './business';
import type { AiAnswer, AiSuggestion, SearchGroup, ApprovalItem, ApprovalRequest, ClassOccurrence, Connection, CoverRequest, DomainStatus, FoodOrder, FoodOrderStatus, GroupPublish, ImportRow, KitchenFeed, Location, Member, MenuItem, OnboardingProgress, Organization, OrgSettings, Overview, PaymentAccount, PaymentAutomation, AutoChargeRow, ReconciliationItem, Report, RequestContext, ScopeOptionT, Session, ShiftView, TableData, Transaction, WebsitePage } from './types';
import type { MsgParams } from './msg';

export { ApiError } from './errors';
export { API_URL, setAccessToken as setAuthToken } from './http/client';

/** Public addresses of a location's website (included address + optional custom domain). */
export interface SiteAddress {
  locationId: string;
  locationName: string;
  includedAddress: string | null;
  custom: { host: string; state: DomainStatus['state'] } | null;
  live: boolean;
}

export interface BranchHarborApi {
  auth: {
    session(ctx: RequestContext): Promise<Session>;
    signIn(input: { email: string; password: string }): Promise<{ needsVerification: boolean }>;
    signUp(input: { name: string; email: string; password: string; locale: string }): Promise<{ needsVerification: boolean }>;
    verifyEmail(input: { email: string; code: string }): Promise<{ ok: true }>;
    resendCode(input: { email: string }): Promise<{ ok: true }>;
    forgotPassword(input: { email: string }): Promise<{ ok: true }>;
    signOut(): Promise<void>;
  };

  org(ctx: RequestContext): Promise<Organization>;
  scopes(ctx: RequestContext): Promise<ScopeOptionT[]>;
  locations(ctx: RequestContext): Promise<Location[]>;
  overview(ctx: RequestContext): Promise<Overview>;
  table(ctx: RequestContext, key: string): Promise<TableData>;
  search(ctx: RequestContext, q: string): Promise<SearchGroup[]>;
  notifications(ctx: RequestContext): Promise<{ id: string; kind: 'info' | 'action' | 'integration'; title: string; titleKey?: string; titleParams?: MsgParams; at: string; href: string }[]>;

  studios: {
    classes(ctx: RequestContext, weekStart: string): Promise<{ timeZone: string; occurrences: ClassOccurrence[] }>;
    /** The open (or most recent) cover request in scope; null when there is none. */
    cover(ctx: RequestContext): Promise<CoverRequest | null>;
    acceptCover(id: string, candidateId: string): Promise<CoverRequest>;
    approveCover(id: string): Promise<CoverRequest>;
    resetCover(id: string): Promise<CoverRequest>;
  };
  foods: {
    menu(ctx: RequestContext, view: string): Promise<MenuItem[]>;
    resetMenuField(view: string, itemId: string, field: string): Promise<MenuItem[]>;
    orders(ctx: RequestContext): Promise<FoodOrder[]>;
    setOrderStatus(id: string, status: FoodOrderStatus, reason?: string): Promise<FoodOrder>;
    kitchen(ctx: RequestContext): Promise<KitchenFeed>;
  };

  websites: {
    page(ctx: RequestContext, locationId: string): Promise<WebsitePage>;
    saveField(locationId: string, key: string, value: string): Promise<WebsitePage>;
    requestChange(locationId: string, key: string, value: string, reason: string): Promise<WebsitePage>;
    decide(locationId: string, key: string, decision: 'approve' | 'reject', comment?: string): Promise<WebsitePage>;
    resetField(locationId: string, key: string): Promise<WebsitePage>;
    approvals(ctx: RequestContext): Promise<ApprovalItem[]>;
    publishPlan(ctx: RequestContext): Promise<GroupPublish>;
    publish(planId: string): Promise<GroupPublish>;
    retry(planId: string, locationId: string): Promise<GroupPublish>;
    sites(ctx: RequestContext): Promise<SiteAddress[]>;
  };

  payments: {
    transactions(ctx: RequestContext): Promise<Transaction[]>;
    reconciliation(ctx: RequestContext): Promise<ReconciliationItem[]>;
    recreateOrder(itemId: string): Promise<ReconciliationItem>;
    refund(itemId: string, confirm: { amount: number; currency: string }): Promise<ReconciliationItem>;
    accounts(ctx: RequestContext): Promise<PaymentAccount[]>;
    automation(ctx: RequestContext): Promise<{ settings: PaymentAutomation; charges: AutoChargeRow[] }>;
    setAutomation(patch: Partial<Omit<PaymentAutomation, 'providerMode'>>): Promise<PaymentAutomation>;
  };

  connections: {
    list(ctx: RequestContext): Promise<Connection[]>;
    fix(id: string): Promise<Connection>;
  };
  team: {
    members(ctx: RequestContext): Promise<Member[]>;
    /** Shifts in scope for the 7 days from `weekStart` (YYYY-MM-DD), with clock-in state and pending swaps. */
    schedule(ctx: RequestContext, weekStart: string): Promise<ShiftView[]>;
    /** `role` is the display label; `roleKey` the API role (e.g. location_manager). */
    invite(input: { email: string; role: string; roleKey?: string; scopeId: string; scopeLabel: string }): Promise<Member>;
  };
  /** One inbox for refunds, local ad spend, shift swaps and website changes. Approving runs the action. */
  approvals: {
    list(ctx: RequestContext, status: 'pending' | 'done'): Promise<ApprovalRequest[]>;
    decide(id: string, decision: 'approve' | 'reject', comment?: string): Promise<ApprovalRequest>;
  };
  reports(ctx: RequestContext): Promise<Report[]>;
  settings: {
    get(ctx: RequestContext): Promise<OrgSettings>;
    save(ctx: RequestContext, input: Partial<OrgSettings>): Promise<OrgSettings>;
  };
  onboarding: {
    get(): Promise<OnboardingProgress | null>;
    save(progress: OnboardingProgress): Promise<OnboardingProgress>;
    validateImport(csv: string): Promise<ImportRow[]>;
    domain(hostname: string): Promise<DomainStatus>;
    verifyDomain(hostname: string): Promise<DomainStatus>;
  };
  /** Independent (single-location) businesses: location details, Solo billing, website approvals, single publish and the upgrade to a network. */
  business: BusinessApi;
  ai: {
    suggestions(ctx: RequestContext): Promise<AiSuggestion[]>;
    /** `suggestionId` when the question is a suggested prompt (shown in the viewer's language). */
    ask(ctx: RequestContext, question: string, suggestionId?: string): Promise<AiAnswer>;
  };
}

export { httpApi };

/** The API client (async for call sites written against the former mock/live selection). */
export async function getApi(): Promise<BranchHarborApi> {
  return httpApi;
}
