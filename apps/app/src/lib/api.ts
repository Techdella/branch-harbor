/**
 * Typed client for the BranchHarbor API (`NEXT_PUBLIC_API_URL`, routes under /v1).
 *
 * Two implementations share the `BranchHarborApi` interface:
 *  - `httpApi`  calls the backend with cookie + bearer auth and normalises errors to `ApiError`.
 *  - `mockApi`  (src/lib/mock) serves internationalised sample data in memory.
 *
 * `getApi()` returns the mock when NEXT_PUBLIC_USE_MOCKS is not "false", and falls back to it
 * automatically when the backend is unreachable (network failure), reporting that via `apiMode`.
 */
import type {
  AiAnswer,
  ApprovalItem,
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
  SportsGroup,
  TableData,
  Transaction,
  WebsitePage,
  WellnessDay,
} from './types';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isForbidden() {
    return this.status === 403 || this.code === 'forbidden';
  }
  get isNetwork() {
    return this.code === 'network_error';
  }
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
    cover(ctx: RequestContext): Promise<CoverRequest>;
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
    invite(input: { email: string; role: string; scopeId: string; scopeLabel: string }): Promise<Member>;
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
  ai: {
    suggestions(ctx: RequestContext): Promise<string[]>;
    ask(ctx: RequestContext, question: string): Promise<AiAnswer>;
  };
}

/* ------------------------------------------------------------------ */
/* HTTP implementation                                                 */
/* ------------------------------------------------------------------ */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS !== 'false';

const TOKEN_KEY = 'bh_token';
export function setAuthToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}
function authToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

function ctxQuery(ctx: RequestContext, extra: Query = {}): Query {
  return { industry: ctx.industry, scope: ctx.scopeId, ...extra };
}

async function request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  const url = new URL(`${API_URL}/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'include', body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw new ApiError('network_error', 'The BranchHarbor service could not be reached.');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; fields?: Record<string, string> } } | null;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(e?.code ?? (res.status === 403 ? 'forbidden' : 'http_error'), e?.message ?? res.statusText, res.status, e?.fields);
  }
  return ((json as { data?: T } | null)?.data ?? json) as T;
}

const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query });
const post = <T>(path: string, body?: unknown, query?: Query) => request<T>('POST', path, { body: body ?? {}, query });
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { body });

export const httpApi: BranchHarborApi = {
  mode: 'live',
  auth: {
    session: (ctx) => get('/auth/session', { industry: ctx.industry }),
    signIn: async (input) => {
      const r = await post<{ token?: string; needsVerification: boolean }>('/auth/sign-in', input);
      if (r.token) setAuthToken(r.token);
      return { needsVerification: r.needsVerification };
    },
    signUp: (input) => post('/auth/sign-up', input),
    verifyEmail: (input) => post('/auth/verify-email', input),
    resendCode: (input) => post('/auth/verify-email/resend', input),
    forgotPassword: (input) => post('/auth/forgot-password', input),
    signOut: async () => {
      await post('/auth/sign-out');
      setAuthToken(null);
    },
  },
  org: (ctx) => get('/organization', ctxQuery(ctx)),
  scopes: (ctx) => get('/scopes', ctxQuery(ctx)),
  locations: (ctx) => get('/locations', ctxQuery(ctx)),
  overview: (ctx) => get('/overview', ctxQuery(ctx)),
  table: (ctx, key) => get(`/tables/${encodeURIComponent(key)}`, ctxQuery(ctx)),
  search: (ctx, q) => get('/search', ctxQuery(ctx, { q })),
  notifications: (ctx) => get('/notifications', ctxQuery(ctx)),
  studios: {
    classes: (ctx, weekStart) => get('/studios/classes', ctxQuery(ctx, { weekStart })),
    cover: (ctx) => get('/studios/cover-requests/current', ctxQuery(ctx)),
    acceptCover: (id, candidateId) => post(`/studios/cover-requests/${id}/accept`, { candidateId }),
    approveCover: (id) => post(`/studios/cover-requests/${id}/approve`),
    resetCover: (id) => post(`/studios/cover-requests/${id}/reopen`),
  },
  sports: {
    registrations: (ctx) => get('/sports/registrations', ctxQuery(ctx)),
    decide: (id, input) => post(`/sports/registrations/${id}/decision`, input),
    session: (ctx) => get('/sports/attendance/current', ctxQuery(ctx)),
    submitAttendance: (sessionId, marks) => post(`/sports/attendance/${sessionId}`, { marks }),
  },
  wellness: {
    day: (ctx) => get('/wellness/calendar', ctxQuery(ctx)),
    slots: (id) => get(`/wellness/appointments/${id}/reschedule-slots`),
    reschedule: (id, slotId) => post(`/wellness/appointments/${id}/reschedule`, { slotId }),
  },
  commerce: {
    orders: (ctx) => get('/commerce/orders', ctxQuery(ctx)),
    refund: (orderId, lineIds) => post(`/commerce/orders/${orderId}/refunds`, { lineIds }),
  },
  foods: {
    menu: (ctx, view) => get('/foods/menu', ctxQuery(ctx, { view })),
    resetMenuField: (view, itemId, field) => post(`/foods/menu/${itemId}/reset`, { view, field }),
    orders: (ctx) => get('/foods/orders', ctxQuery(ctx)),
    setOrderStatus: (id, status, reason) => post(`/foods/orders/${id}/status`, { status, reason }),
    kitchen: (ctx) => get('/foods/kitchen', ctxQuery(ctx)),
  },
  websites: {
    page: (ctx, locationId) => get(`/websites/${locationId}/pages/home`, ctxQuery(ctx)),
    saveField: (loc, key, value) => patch(`/websites/${loc}/pages/home/fields/${key}`, { value }),
    requestChange: (loc, key, value, reason) => post(`/websites/${loc}/pages/home/fields/${key}/change-requests`, { value, reason }),
    decide: (loc, key, decision, comment) => post(`/websites/${loc}/pages/home/fields/${key}/decision`, { decision, comment }),
    resetField: (loc, key) => post(`/websites/${loc}/pages/home/fields/${key}/reset`),
    approvals: (ctx) => get('/websites/approvals', ctxQuery(ctx)),
    publishPlan: (ctx) => get('/websites/group-publish/plan', ctxQuery(ctx)),
    publish: (planId) => post(`/websites/group-publish/${planId}`),
    retry: (planId, locationId) => post(`/websites/group-publish/${planId}/locations/${locationId}/retry`),
  },
  payments: {
    transactions: (ctx) => get('/payments/transactions', ctxQuery(ctx)),
    reconciliation: (ctx) => get('/payments/reconciliation', ctxQuery(ctx)),
    recreateOrder: (id) => post(`/payments/reconciliation/${id}/recreate-order`),
    refund: (id, confirm) => post(`/payments/reconciliation/${id}/refund`, { confirm }),
    accounts: (ctx) => get('/payments/accounts', ctxQuery(ctx)),
  },
  connections: {
    list: (ctx) => get('/connections', ctxQuery(ctx)),
    fix: (id) => post(`/connections/${id}/recover`),
  },
  team: {
    members: (ctx) => get('/team/members', ctxQuery(ctx)),
    invite: (input) => post('/team/invitations', input),
  },
  reports: (ctx) => get('/reports', ctxQuery(ctx)),
  settings: {
    get: (ctx) => get('/settings', ctxQuery(ctx)),
    save: (ctx, input) => patch(`/settings?industry=${ctx.industry}`, input),
  },
  onboarding: {
    get: () => get('/onboarding'),
    save: (p) => request('PUT', '/onboarding', { body: p }),
    validateImport: (csv) => post('/locations/import/validate', { csv }),
    domain: (hostname) => post('/domains', { hostname }),
    verifyDomain: (hostname) => post(`/domains/${encodeURIComponent(hostname)}/verify`),
  },
  ai: {
    suggestions: (ctx) => get('/ai/suggestions', ctxQuery(ctx)),
    ask: (ctx, question) => post('/ai/ask', { question }, ctxQuery(ctx)),
  },
};

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
function setMode(m: typeof currentMode) {
  if (m === currentMode) return;
  currentMode = m;
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

let instance: BranchHarborApi | null = null;
export async function getApi(): Promise<BranchHarborApi> {
  if (instance) return instance;
  const { mockApi } = await import('./mock/mockApi');
  instance = USE_MOCKS ? mockApi : withFallback(httpApi, mockApi);
  return instance;
}
