/**
 * Typed client for the BranchHarbor API (`NEXT_PUBLIC_API_URL`, routes under /v1).
 *
 * Two implementations share the `BranchHarborApi` interface:
 *  - `httpApi`  (src/lib/http) calls apps/api with bearer + refresh-cookie auth, maps every method to the real
 *               `/v1/orgs/:orgId/...` endpoints and adapts responses to the view models in ./types.
 *  - `mockApi`  (src/lib/mock) serves internationalised sample data in memory.
 *
 * `getApi()` returns the mock when NEXT_PUBLIC_USE_MOCKS is not "false", and falls back to it
 * automatically when the backend is unreachable (network failure), reporting that via `apiMode`.
 */
import { ApiError } from './errors';
import { USE_MOCKS, markOfflineSession } from './http/client';
import { httpApi } from './http/httpApi';
import type { BusinessApi } from './business';
import type {
  AiAnswer,
  ApprovalItem,
  ApprovalRequest,
  AttendanceSession,
  ClassOccurrence,
  CommerceOrder,
  Connection,
  CoverRequest,
  DomainStatus,
  FoodOrder,
  FoodOrderStatus,
  GroupPublish,
  ImportRow,
  KitchenFeed,
  Location,
  Member,
  MenuItem,
  OnboardingProgress,
  Organization,
  OrgSettings,
  Overview,
  PaymentAccount,
  ReconciliationItem,
  Registration,
  Report,
  RequestContext,
  RescheduleSlot,
  ScopeOptionT,
  Session,
  ShiftView,
  SportsGroup,
  TableData,
  Transaction,
  WebsitePage,
  WellnessDay,
} from './types';

export { ApiError } from './errors';
export { API_URL, USE_MOCKS, setAccessToken as setAuthToken } from './http/client';

/** Public addresses of a location's website (included address + optional custom domain). */
export interface SiteAddress {
  locationId: string;
  locationName: string;
  includedAddress: string | null;
  custom: { host: string; state: DomainStatus['state'] } | null;
  live: boolean;
}

export interface BranchHarborApi {
  readonly mode: 'live' | 'mock';

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
  search(ctx: RequestContext, q: string): Promise<{ type: string; items: { id: string; label: string; sub: string; href: string }[] }[]>;
  notifications(ctx: RequestContext): Promise<{ id: string; kind: 'info' | 'action' | 'integration'; title: string; at: string; href: string }[]>;

  studios: {
    classes(ctx: RequestContext, weekStart: string): Promise<{ timeZone: string; occurrences: ClassOccurrence[] }>;
    /** The open (or most recent) cover request in scope; null when there is none. */
    cover(ctx: RequestContext): Promise<CoverRequest | null>;
    acceptCover(id: string, candidateId: string): Promise<CoverRequest>;
    approveCover(id: string): Promise<CoverRequest>;
    resetCover(id: string): Promise<CoverRequest>;
  };
  sports: {
    registrations(ctx: RequestContext): Promise<{ items: Registration[]; groups: SportsGroup[] }>;
    decide(id: string, input: { decision: 'accept' | 'waitlist'; groupId?: string }): Promise<Registration>;
    session(ctx: RequestContext): Promise<AttendanceSession>;
    submitAttendance(sessionId: string, marks: Record<string, 'present' | 'absent'>): Promise<{ ok: true; notifiedGuardians: number }>;
  };
  wellness: {
    day(ctx: RequestContext): Promise<WellnessDay>;
    slots(appointmentId: string): Promise<RescheduleSlot[]>;
    reschedule(appointmentId: string, slotId: string, opts?: { simulateConflict?: boolean }): Promise<WellnessDay>;
  };
  commerce: {
    orders(ctx: RequestContext): Promise<CommerceOrder[]>;
    refund(orderId: string, lineIds: string[]): Promise<CommerceOrder>;
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
    suggestions(ctx: RequestContext): Promise<string[]>;
    ask(ctx: RequestContext, question: string): Promise<AiAnswer>;
  };
}

/* ------------------------------------------------------------------ */
/* Selection + automatic fallback                                      */
/* ------------------------------------------------------------------ */

type Listener = (mode: 'live' | 'mock' | 'fallback') => void;
let currentMode: 'live' | 'mock' | 'fallback' = USE_MOCKS ? 'mock' : 'live';
const listeners = new Set<Listener>();
export function apiMode() {
  return currentMode;
}
export function onApiMode(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Switches to sample data after the API proved unreachable outside a wrapped call (e.g. workspace bootstrap). */
export function enterFallback() {
  if (!USE_MOCKS) setMode('fallback');
}
function setMode(m: typeof currentMode) {
  if (m === currentMode) return;
  currentMode = m;
  // Offline sample data needs no session; let the route guard (src/proxy.ts) through while it lasts.
  if (m === 'fallback') markOfflineSession();
  listeners.forEach((l) => l(m));
}

/** Wraps every method of `live` so a network failure retries once against `mock`. */
function withFallback<T extends object>(live: T, mock: T): T {
  return new Proxy(live, {
    get(target, prop, receiver) {
      const lv = Reflect.get(target, prop, receiver) as unknown;
      const mv = Reflect.get(mock, prop) as unknown;
      if (typeof lv === 'function') {
        return async (...args: unknown[]) => {
          if (currentMode === 'fallback') return (mv as (...a: unknown[]) => unknown)(...args);
          try {
            return await (lv as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (e) {
            if (e instanceof ApiError && e.isNetwork) {
              setMode('fallback');
              return (mv as (...a: unknown[]) => unknown)(...args);
            }
            throw e;
          }
        };
      }
      if (lv && typeof lv === 'object') return withFallback(lv as object, mv as object);
      return lv;
    },
  });
}

export { httpApi };

let instance: BranchHarborApi | null = null;
export async function getApi(): Promise<BranchHarborApi> {
  if (instance) return instance;
  const { mockApi } = await import('./mock/mockApi');
  instance = USE_MOCKS ? mockApi : withFallback(httpApi, mockApi);
  return instance;
}
