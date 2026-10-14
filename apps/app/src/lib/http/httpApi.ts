/**
 * Live implementation of `BranchHarborApi` against apps/api (`/v1`, contract at `/docs/json`).
 *
 * Every method maps to real endpoints under `/v1/orgs/:orgId/...` and adapts the responses into the
 * app's view models (src/lib/types.ts) so screens stay unchanged. The organisation and the selected
 * scope come from the live workspace (`/v1/auth/me` + the org directory, see ./workspace.ts).
 *
 * Where the API has no endpoint for something the UI shows, the client derives it honestly from data the
 * API does return (notifications, search, publish plan) or reports it as unavailable — it never invents data.
 */
import { can as canDo, type Currency, type Money, type Permission, type Role } from '@bh/shared';
import type { IconName } from '@bh/icons';
import type { Tone } from '@bh/ui';
import type { BranchHarborApi, SiteAddress } from '../api';
import { ApiError } from '../errors';
import { addDays, dateInZone, fmtDay, fmtTime, moneyWithCode, zoneLabel, zonedToUtc } from '../format';
import type {
  AiAnswer,
  ApprovalItem,
  ApprovalRequest,
  AttentionItem,
  Cell,
  ClassOccurrence,
  CommerceOrder,
  Connection,
  ConnectionState,
  CoverRequest,
  DomainStatus,
  FoodOrder,
  FoodOrderStatus,
  GroupPublish,
  ImportRow,
  IndustryKey,
  Location,
  Member,
  MenuItem,
  Metric,
  OnboardingProgress,
  OnboardingStep,
  OrgSettings,
  Overview,
  PaymentAccount,
  PaymentState,
  ReconciliationItem,
  RefundState,
  Registration,
  Report,
  RequestContext,
  ShiftView,
  SportsGroup,
  TableData,
  TimelineEvent,
  Transaction,
  UpcomingItem,
  WebsiteField,
  WebsitePage,
  WellnessDay,
} from '../types';
import { ONBOARDING_STEPS } from '../types';
import { http, login, logout, resendVerification, signup, verifyEmail } from './client';
import {
  activeViewRole,
  apiScope,
  clearWorkspace,
  effectiveRole,
  loadWorkspace,
  locationById,
  orgId,
  refreshWorkspace,
  scopeLocationIds,
  scopeOptionsOf,
  sessionOf,
  workspace,
  type ApiConnection,
  type ApiLocation,
} from './workspace';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const P = { lilac: '#E9DDF8', lime: '#E2F5A6', sage: '#D4E6D9', butter: '#F7EDA8', blush: '#F8D6D8', aqua: '#CDEEEE', sand: '#EFE3D3', grey: '#F3F2EE' };
const PASTEL_CYCLE = [P.lilac, P.sage, P.butter, P.aqua, P.blush, P.lime];
const FOOD_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=700&q=70';

const o = (path = '') => `/orgs/${orgId()}${path}`;
const items = <T>(r: { items: T[] }) => r.items;
const humanise = (s: string) => s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const m = (amount: number, currency: Currency): Money => ({ amount, currency });
const now = () => new Date().toISOString();
const nameOfLoc = (id: string | null | undefined) => locationById(id)?.name ?? 'All locations';
const tzOf = (id: string | null | undefined) => locationById(id)?.timeZone ?? workspace()?.org?.defaultTimeZone ?? 'UTC';

function ws() {
  const w = workspace();
  if (!w) throw new ApiError('unauthorized', 'Sign in to continue.', 401);
  return w;
}
const role = () => activeViewRole();
const inScope = (ctx: RequestContext) => new Set(scopeLocationIds(ctx.scopeId, effectiveRole(ctx.role)));
/** Permission check for the active "Viewing as" persona (server enforces; this only avoids pointless calls). */
const allowedFor = (ctx: RequestContext, perm: Permission) => canDo(sessionOf(effectiveRole(ctx.role), ws()).assignments, perm);

/** Runs a read that may be forbidden for this role; forbidden → fallback, everything else propagates. */
async function maybe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.isForbidden || e.status === 404)) return fallback;
    throw e;
  }
}

const ROLE_LABEL: Record<string, string> = {
  org_owner: 'Organisation owner', hq_admin: 'HQ admin', regional_manager: 'Regional manager', franchise_owner: 'Franchise owner',
  location_manager: 'Location manager', staff: 'Staff', marketing_contributor: 'Marketing contributor', finance: 'Finance user', customer: 'Customer',
};

function scopeLabel(scope: { kind: string; id: string; name?: string | null }): string {
  const w = workspace();
  if (scope.kind === 'organization') return 'Organisation';
  if (scope.kind === 'region') return `Region: ${scope.name ?? w?.regions.find((r) => r.id === scope.id)?.name ?? 'Unknown'}`;
  if (scope.kind === 'owner_group') return `Owner group: ${scope.name ?? w?.ownerGroups.find((g) => g.id === scope.id)?.name ?? 'Unknown'}`;
  return scope.name ?? nameOfLoc(scope.id);
}

/* ---------------- members (names for approvals, cover, search) ---------------- */

interface ApiMember {
  user: { id: string; name: string; email: string };
  assignments: { id: string; role: string; scope: { kind: string; id: string; name: string | null }; expiresAt: string | null; createdAt: string }[];
}
let memberCache: { org: string; at: number; list: ApiMember[] } | null = null;
async function members(): Promise<ApiMember[]> {
  const id = orgId();
  if (memberCache && memberCache.org === id && Date.now() - memberCache.at < 60_000) return memberCache.list;
  const list = await maybe(http.get<{ items: ApiMember[] }>(o('/members')).then(items), [] as ApiMember[]);
  memberCache = { org: id, at: Date.now(), list };
  return list;
}
async function personName(userId: string | null | undefined): Promise<string> {
  if (!userId) return 'Someone';
  if (userId === workspace()?.user.id) return workspace()!.user.name;
  return (await members()).find((x) => x.user.id === userId)?.user.name ?? 'A teammate';
}

/* ------------------------------------------------------------------ */
/* overview, notifications                                             */
/* ------------------------------------------------------------------ */

interface ApiMetric<T> {
  value: T | null;
  unavailableReason: string | null;
  definition: string;
  freshness: { asOf: string; source: string; lastSyncAt: string | null; complete: boolean };
}
interface ApiRevenueRow {
  currency: Currency;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
  paymentCount: number;
}
interface ApiReport {
  scope: { kind: string; id: string; locationCount: number };
  period: { from: string; to: string };
  metrics: {
    revenue: ApiMetric<ApiRevenueRow[]>;
    combinedRevenue: ApiMetric<null>;
    classBookings: ApiMetric<number>;
    occupancy: ApiMetric<number>;
    foodOrders: ApiMetric<Record<string, number>>;
    appointments: ApiMetric<number>;
    registrations: ApiMetric<Record<string, number>>;
    leads: ApiMetric<number>;
  };
  revenueByLocation: { locationId: string; name: string; currency: Currency; revenue: ApiRevenueRow[] }[];
  connections: { id: string; provider: string; state: string; lastSuccessAt: string | null }[];
}

async function report(ctx: RequestContext): Promise<ApiReport> {
  const s = apiScope(ctx.scopeId, effectiveRole(ctx.role));
  return http.get<ApiReport>(o('/reports/overview'), s.kind === 'organization' ? {} : { scopeKind: s.kind, scopeId: s.id });
}

function freshnessText(f: ApiMetric<unknown>['freshness']): string {
  if (f.lastSyncAt) return `${f.source} · last sync ${new Date(f.lastSyncAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return f.source;
}

function metricOf<T>(key: string, label: string, icon: IconName, pastel: string, api: ApiMetric<T>, value: (v: T) => Metric['value'], notConnected = /no .*connected/i): Metric {
  const base = { key, label, definition: api.definition, range: 'Last 30 days', source: freshnessText(api.freshness), icon, pastel };
  if (api.value === null || api.value === undefined) {
    const reason = api.unavailableReason ?? undefined;
    return { ...base, state: reason && notConnected.test(reason) ? 'not_connected' : 'unavailable', value: null, note: reason };
  }
  return { ...base, state: 'ok', value: value(api.value), note: api.freshness.complete ? undefined : 'Partial data — some sources are behind' };
}

const sumRecord = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function overviewMetrics(ind: IndustryKey, r: ApiReport): Metric[] {
  const M = r.metrics;
  const revenue = metricOf('revenue', 'Revenue', 'wallet', P.butter, M.revenue, (rows) => ({ kind: 'money', values: rows.map((x) => m(x.netMinor, x.currency)) }));
  if (revenue.value?.kind === 'money' && revenue.value.values.length > 1) revenue.note = 'Shown per currency · not combined';
  const leads = metricOf('enquiries', 'Enquiries', 'mail', P.lime, M.leads, (v) => ({ kind: 'count', value: v }));
  const byInd: Record<IndustryKey, Metric[]> = {
    studios: [
      metricOf('bookings', 'Class bookings', 'calendar', P.lilac, M.classBookings, (v) => ({ kind: 'count', value: v })),
      metricOf('occupancy', 'Occupancy', 'users', P.aqua, M.occupancy, (v) => ({ kind: 'percent', value: v })),
    ],
    sports: [metricOf('registrations', 'Registrations', 'file', P.aqua, M.registrations, (v) => ({ kind: 'count', value: sumRecord(v) }))],
    wellness: [metricOf('appointments', 'Appointments', 'calendar', P.sage, M.appointments, (v) => ({ kind: 'count', value: v }))],
    commerce: [],
    foods: [
      metricOf('orders', 'Pickup orders', 'receipt', P.blush, M.foodOrders, (v) => ({ kind: 'count', value: sumRecord(v) })),
    ],
    // Real Estate KPIs (listings, funnel, volume per currency) live on Operations → Pulse (/v1/orgs/:id/realty/reports).
    realty: [],
  };
  const conns = r.connections;
  const sync: Metric = conns.length
    ? { key: 'sync', label: 'Connections healthy', definition: 'Connected systems currently syncing without errors', range: 'Now', source: 'Connections', icon: 'plug', pastel: P.grey, state: 'ok', value: { kind: 'ratio', value: conns.filter((c) => c.state === 'connected').length, of: conns.length } }
    : { key: 'sync', label: 'Connections', definition: 'Connected booking, commerce or POS systems', range: 'Now', source: 'Connections', icon: 'plug', pastel: P.grey, state: 'not_connected', value: null, note: 'No systems connected yet' };
  return [leads, ...byInd[ind], revenue, sync];
}

async function attentionItems(ctx: RequestContext): Promise<(AttentionItem & { at: string })[]> {
  const w = ws();
  const scope = inScope(ctx);
  const out: (AttentionItem & { at: string })[] = [];
  const inS = (lid: string | null | undefined) => !lid || scope.has(lid);
  const allowed = (p: Permission) => allowedFor(ctx, p);
  const [recon, approvals, conns, foods, cover] = await Promise.all([
    allowed('payments.read') ? maybe(http.get<ApiRecon>(o('/payments/reconciliation')), null) : null,
    allowed('locations.read') ? maybe(http.get<{ items: (ApiApproval & { canDecide?: boolean; kindLabel?: string })[] }>(o('/approvals')).then((r) => r.items.filter((a) => a.canDecide !== false)), [] as ApiApproval[]) : [],
    maybe(http.get<{ items: ApiConnection[] }>(o('/connections')).then(items), [] as ApiConnection[]),
    w.orgView?.industry === 'foods' ? maybe(http.get<{ items: ApiFoodOrder[] }>(o('/foods/orders'), { status: 'awaiting_acceptance' }).then(items), [] as ApiFoodOrder[]) : [],
    w.orgView?.industry === 'studios' ? maybe(http.get<{ items: ApiCover[] }>(o('/studios/cover-requests'), { status: 'open' }).then(items), [] as ApiCover[]) : [],
  ]);
  for (const c of conns.filter((x) => x.state !== 'connected' && inS(x.locationId)))
    out.push({ id: `conn-${c.id}`, icon: 'alert', kind: 'integration', title: `${providerName(c.provider)} ${humanise(c.state).toLowerCase()}`, detail: `${nameOfLoc(c.locationId)} · ${c.lastError ?? 'Check the connection'}`, href: '/connections', at: c.lastErrorAt ?? now() });
  const recItems = (recon?.items ?? []).filter((x) => inS(x.locationId));
  if (recItems.length)
    out.push({ id: 'recon', icon: 'card', kind: 'action', title: `${recItems.length} payment${recItems.length > 1 ? 's need' : ' needs'} reconciliation`, detail: recItems.map((x) => humanise(x.kind)).filter((v, i, a) => a.indexOf(v) === i).join(' · '), href: '/payments?tab=reconciliation', at: recon?.generatedAt ?? now() });
  const aps = approvals.filter((a) => inS(a.locationId));
  if (aps.length) out.push({ id: 'approvals', icon: 'shield', kind: 'action', title: `${aps.length} request${aps.length > 1 ? 's' : ''} awaiting approval`, detail: [...new Set(aps.map((a) => humanise(a.targetType)))].join(', ') + ' · ' + [...new Set(aps.map((a) => nameOfLoc(a.locationId)))].join(', '), href: '/approvals', at: aps[0]!.createdAt });
  const fo = foods.filter((x) => inS(x.locationId));
  if (fo.length) out.push({ id: 'food-accept', icon: 'receipt', kind: 'action', title: `${fo.length} order${fo.length > 1 ? 's' : ''} awaiting acceptance`, detail: [...new Set(fo.map((x) => nameOfLoc(x.locationId)))].join(', '), href: '/ops/orders', at: fo[0]!.createdAt });
  const cv = cover.filter((x) => inS(x.locationId));
  if (cv.length) out.push({ id: 'cover', icon: 'users', kind: 'action', title: `${cv.length} open cover request${cv.length > 1 ? 's' : ''}`, detail: [...new Set(cv.map((x) => nameOfLoc(x.locationId)))].join(', '), href: '/ops/cover', at: cv[0]!.createdAt });
  return out;
}

async function upcoming(ctx: RequestContext): Promise<{ title: string; items: UpcomingItem[] }> {
  const ind = ws().orgView?.industry;
  const scope = inScope(ctx);
  if (ind === 'studios') {
    const from = new Date();
    const occ = await maybe(http.get<{ items: ApiOccurrence[] }>(o('/studios/occurrences'), { from: from.toISOString(), to: new Date(from.getTime() + 86400_000).toISOString() }).then(items), [] as ApiOccurrence[]);
    return {
      title: 'Upcoming classes',
      items: occ.filter((x) => scope.has(x.locationId) && x.status === 'scheduled').slice(0, 8).map((x) => {
        const full = x.booked >= x.capacity;
        return { id: x.id, at: x.startsAt, timeZone: tzOf(x.locationId), title: `${x.classTypeName ?? 'Class'}${x.instructorName ? ` · ${x.instructorName}` : ''}`, detail: `${nameOfLoc(x.locationId)} · ${x.booked}/${x.capacity}${x.waitlist ? ` · ${x.waitlist} waitlisted` : ''}`, status: full ? { label: 'Full', tone: 'info' as Tone } : { label: 'Open', tone: 'success' as Tone } };
      }),
    };
  }
  if (ind === 'foods') {
    const fo = await maybe(http.get<{ items: ApiFoodOrder[] }>(o('/foods/orders'), { active: true }).then(items), [] as ApiFoodOrder[]);
    return {
      title: 'Upcoming pickups',
      items: fo.filter((x) => scope.has(x.locationId)).sort((a, b) => a.promisedAt.localeCompare(b.promisedAt)).slice(0, 8).map((x) => ({ id: x.id, at: x.promisedAt, timeZone: tzOf(x.locationId), title: `#${x.orderNumber} · ${x.contact?.name ?? 'Guest'}`, detail: `${nameOfLoc(x.locationId)} · ${x.lines.reduce((a, l) => a + l.quantity, 0)} items`, status: { label: humanise(x.status), tone: (x.status === 'awaiting_acceptance' ? 'warning' : x.status === 'ready' ? 'success' : 'info') as Tone } })),
    };
  }
  if (ind === 'realty') {
    type RV = { id: string; startsAt: string; locationId: string; status: string; agentName: string | null; listing: { title: string } | null; officeName?: string; contact: { name: string } };
    const vs = await maybe(http.get<{ items: RV[] }>(o('/realty/viewings'), { from: now(), to: new Date(Date.now() + 2 * 86400_000).toISOString(), status: 'requested,confirmed' }).then(items), [] as RV[]);
    return {
      title: 'Upcoming viewings',
      items: vs.filter((x) => scope.has(x.locationId)).slice(0, 8).map((x) => ({ id: x.id, at: x.startsAt, timeZone: tzOf(x.locationId), title: x.listing?.title ?? 'Viewing', detail: `${nameOfLoc(x.locationId)} · ${x.agentName ?? 'Agent'}`, status: x.status === 'confirmed' ? { label: 'Confirmed', tone: 'success' as Tone } : { label: 'Awaiting confirmation', tone: 'warning' as Tone } })),
    };
  }
  if (ind === 'wellness') {
    const ap = await maybe(http.get<{ items: ApiAppointment[] }>(o('/wellness/appointments'), { from: now(), to: new Date(Date.now() + 86400_000).toISOString() }).then(items), [] as ApiAppointment[]);
    return { title: 'Upcoming appointments', items: ap.filter((x) => scope.has(x.locationId) && x.status === 'confirmed').slice(0, 8).map((x) => ({ id: x.id, at: x.startsAt, timeZone: tzOf(x.locationId), title: 'Appointment', detail: nameOfLoc(x.locationId), status: { label: 'Confirmed', tone: 'success' as Tone } })) };
  }
  return { title: 'Upcoming', items: [] };
}

const AI_SUGGESTIONS: Record<IndustryKey, string[]> = {
  studios: ['Summarise class occupancy this month', 'Draft a multi-location campaign', 'Which locations need attention?'],
  sports: ['Summarise registrations awaiting review', 'Draft a programme announcement', 'Which teams are nearly full?'],
  wellness: ['Summarise appointments this week', 'Draft a reply using our cancellation policy', 'Which practitioners are fully booked?'],
  commerce: ['Explain this week’s order trend', 'Draft product copy', 'Which stores failed the last sync?'],
  foods: ['Summarise today’s orders by location', 'Draft menu copy', 'Plan a lunch promotion'],
  realty: ['Which offices need attention?', 'Draft a campaign for new listings', 'Summarise enquiries this week'],
};

/* ------------------------------------------------------------------ */
/* studios                                                             */
/* ------------------------------------------------------------------ */

interface ApiOccurrence {
  id: string;
  locationId: string;
  classTypeId: string;
  instructorName: string | null;
  room: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: string;
  classTypeName?: string;
  booked: number;
  held: number;
  waitlist: number;
}
interface ApiCover {
  id: string;
  locationId: string;
  occurrenceId: string;
  requestedBy: string;
  reason: string | null;
  status: string;
  substituteUserId: string | null;
  substituteName: string | null;
  history: { at: string; by: string | null; action: string; note?: string }[];
  createdAt: string;
}

async function coverView(cr: ApiCover): Promise<CoverRequest> {
  const occ = await maybe(http.get<ApiOccurrence & { bookings?: unknown[] }>(o(`/studios/occurrences/${cr.occurrenceId}`)), null);
  const occurrence = (occ && 'occurrence' in (occ as object) ? (occ as unknown as { occurrence: ApiOccurrence }).occurrence : occ) as ApiOccurrence | null;
  const status: CoverRequest['status'] = cr.status === 'approved' ? 'confirmed' : cr.status === 'accepted' ? 'accepted' : 'open';
  const history = await Promise.all(cr.history.map(async (h) => ({ at: h.at, text: `${await personName(h.by)} · ${humanise(h.action)}${h.note ? ` — ${h.note}` : ''}` })));
  return {
    id: cr.id,
    classId: cr.occurrenceId,
    className: occurrence?.classTypeName ?? 'Class',
    start: occurrence?.startsAt ?? cr.createdAt,
    timeZone: tzOf(cr.locationId),
    locationName: nameOfLoc(cr.locationId),
    requestedBy: await personName(cr.requestedBy),
    reason: cr.reason ?? '—',
    bookedCustomers: occurrence?.booked ?? 0,
    status,
    candidates: cr.substituteName ? [{ id: cr.substituteUserId ?? 'sub', name: cr.substituteName, note: status === 'confirmed' ? 'Assigned' : 'Accepted the cover', available: true, state: status === 'confirmed' ? 'assigned' : 'accepted' }] : [],
    history: history.length ? history : [{ at: cr.createdAt, text: 'Cover requested' }],
  };
}

async function currentCover(ctx: RequestContext): Promise<CoverRequest | null> {
  const scope = inScope(ctx);
  const list = (await http.get<{ items: ApiCover[] }>(o('/studios/cover-requests')).then(items)).filter((c) => scope.has(c.locationId));
  const pick = list.find((c) => c.status === 'open') ?? list.find((c) => c.status === 'accepted') ?? list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return pick ? coverView(pick) : null;
}
async function coverById(id: string): Promise<CoverRequest> {
  const list = await http.get<{ items: ApiCover[] }>(o('/studios/cover-requests')).then(items);
  const c = list.find((x) => x.id === id);
  if (!c) throw new ApiError('not_found', 'Cover request not found.', 404);
  return coverView(c);
}

/* ------------------------------------------------------------------ */
/* sports, wellness, commerce                                          */
/* ------------------------------------------------------------------ */

interface ApiRegistration {
  id: string;
  locationId: string;
  programmeId: string;
  status: string;
  teamId: string | null;
  paymentId: string | null;
  forms: Record<string, unknown>;
  participant: { id: string; name: string; dateOfBirth: string | null };
}
interface ApiProgramme {
  id: string;
  locationId: string;
  name: string;
  ageMin: number | null;
  ageMax: number | null;
  capacity: number | null;
  feeMinor: number;
  currency: Currency;
  status: string;
  registrationClosesAt: string | null;
}
interface ApiTeam {
  id: string;
  locationId: string;
  programmeId: string;
  name: string;
  capacity: number | null;
  coachUserId: string | null;
}
interface ApiAppointment {
  id: string;
  locationId: string;
  serviceId: string;
  practitionerId: string;
  resourceId: string | null;
  customerId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  paymentId: string | null;
  customerName?: string;
}
/* ---------------- operations (offers, schedule, forms, inventory, pickup, shifts, approvals) ---------------- */

interface ApiOffer {
  id: string; locationId: string | null; locationName: string | null; name: string; kind: string; prices: Record<string, number>; credits: number | null; validDays: number;
  rules: string[]; status: string; startsAt: string | null; endsAt: string | null; redemptions: number;
}
interface ApiSportsSession {
  id: string; kind: 'training' | 'fixture'; status: string; startsAt: string; endsAt: string; venue: string | null;
  location: { id: string; name: string; timeZone: string }; team: { id: string; name: string; coach: { id: string; name: string } | null }; programme: { id: string; name: string };
  rosterCount: number; attendance: { recorded: number; present: number; absent: number; late: number; excused: number };
  venueConflict: boolean; conflicts: { sessionId: string; teamName: string }[];
}
interface ApiIntakeForm { id: string; locationId: string | null; locationName: string | null; name: string; serviceIds: string[]; questions: unknown[]; consentVersion: string; version: number; status: string; responses: number }
interface ApiStockMovement {
  id: string; locationId: string; quantity: number; reason: string; reasonLabel: string; note: string | null; reference: string | null; createdAt: string; affectsOnHand: boolean; balanceAfter: number | null;
  variant: { id: string; sku: string; name: string; productName: string }; location: { id: string; name: string; timeZone: string }; createdByName: string;
}
interface ApiInventoryRow { locationId: string; locationName: string; variantId: string; sku: string; name: string; productName: string; onHand: number; reserved: number; available: number; reorderPoint: number | null; lowStock: boolean; sellable: boolean; price: { amount: number | null; currency: Currency } }
interface ApiPickupSettings {
  locationId: string; location: { id: string; name: string; timeZone: string }; configured: boolean; hours: { weekday: number; open: string; close: string }[]; slotMinutes: number; slotCapacity: number;
  prepBufferMinutes: number; cutoffMinutes: number; horizonDays: number; closedDates: string[]; acceptingOrders: boolean; next24h: { slots: number; capacity: number; booked: number };
}
interface ApiShift {
  id: string; locationId: string; location: { id: string; name: string; timeZone: string } | null; user: { id: string; name: string }; role: string; startsAt: string; endsAt: string; breakMinutes: number;
  clockedInAt: string | null; clockedOutAt: string | null; pendingSwap: { id: string; approvalId: string | null; toUser: { id: string; name: string } } | null;
}
interface ApiApprovalFull {
  id: string; kind: ApprovalRequest['kind']; title: string; status: ApprovalRequest['status']; locationId: string | null; amount: Money | null; location: { name: string } | null;
  requester: { id: string; name: string | null }; decider: { id: string; name: string | null } | null; requestComment: string | null; decisionComment: string | null;
  createdAt: string; canDecide: boolean; payload: Record<string, unknown> | null; executionResult: Record<string, unknown> | null;
}
const CHANNEL_LABEL: Record<string, string> = { google_ads: 'Google ads', meta_ads: 'Meta ads', local_print: 'Local print', other: 'Other' };
function approvalView(a: ApiApprovalFull): ApprovalRequest {
  const p = a.payload ?? {};
  const details: ApprovalRequest['details'] = [];
  if (a.kind === 'ad_spend') {
    details.push({ label: 'Channel', value: CHANNEL_LABEL[String(p.channel)] ?? humanise(String(p.channel ?? 'other')) }, { label: 'Duration', value: `${p.durationDays ?? '?'} days` });
    if (p.startsOn) details.push({ label: 'Starts', value: String(p.startsOn) });
  } else if (a.kind === 'shift_swap') {
    const sh = p.shift as { startsAt?: string; endsAt?: string; timeZone?: string } | undefined;
    details.push({ label: 'From', value: String((p.from as { name?: string })?.name ?? '—') }, { label: 'To', value: String((p.to as { name?: string })?.name ?? '—') });
    if (sh?.startsAt && sh.timeZone) details.push({ label: 'Shift', value: `${fmtDay(sh.startsAt, sh.timeZone, 'en')} ${fmtTime(sh.startsAt, sh.timeZone, 'en')}–${fmtTime(sh.endsAt ?? sh.startsAt, sh.timeZone, 'en')} ${zoneLabel(sh.timeZone, 'en')}` });
  } else if (a.kind === 'refund') {
    details.push({ label: 'Refund of', value: p.orderId ? 'Commerce order' : 'Online payment' });
  } else if (a.kind === 'field') {
    details.push({ label: 'Field', value: humanise(String(p.fieldKey ?? 'field')) }, { label: 'New value', value: str(p.value) });
  }
  const r = a.executionResult ?? {};
  const result = a.status !== 'approved' ? null : a.kind === 'refund' ? `Refund ${String(r.refundState ?? 'processed').replace(/_/g, ' ')}` : a.kind === 'ad_spend' ? 'Campaign scheduled' : a.kind === 'shift_swap' ? 'Shift reassigned' : 'Change applied';
  return {
    id: a.id, kind: a.kind, title: a.title, status: a.status, locationName: a.location?.name ?? nameOfLoc(a.locationId), amount: a.amount, requestedBy: a.requester.name ?? 'Someone', requestedAt: a.createdAt,
    reason: a.requestComment, details, canDecide: a.canDecide, decidedBy: a.decider?.name ?? null, decisionComment: a.decisionComment, result,
  };
}

interface ApiService {
  id: string;
  locationId: string | null;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMinor: number;
  depositMinor: number;
  currency: Currency;
  requiredResourceType: string | null;
  active: boolean;
}
interface ApiPractitioner {
  id: string;
  locationId: string;
  name: string;
  serviceIds: string[];
  availability: { weekday: number; start: string; end: string }[];
  active: boolean;
}
interface ApiCommerceOrder {
  id: string;
  locationId: string;
  source: string;
  externalId: string | null;
  status: string;
  fulfilmentStatus: string;
  currency: Currency;
  totalMinor: number;
  taxMinor: number;
  refundedMinor: number;
  lines: { variantId: string; sku: string; name: string; quantity: number; unitPriceMinor: number }[];
  createdAt: string;
  updatedAt: string;
}

const ageFrom = (dob: string | null) => (dob ? Math.floor((Date.now() - new Date(dob).getTime()) / (365.25 * 86400_000)) : 0);

function commerceView(x: ApiCommerceOrder): CommerceOrder {
  const lineTotal = (l: ApiCommerceOrder['lines'][number]) => l.unitPriceMinor * l.quantity;
  let refundedLeft = x.refundedMinor;
  const lines = x.lines.map((l, i) => {
    const refunded = refundedLeft >= lineTotal(l) && refundedLeft > 0;
    if (refunded) refundedLeft -= lineTotal(l);
    return { id: `${x.id}:${i}`, name: l.name, qty: l.quantity, unit: m(l.unitPriceMinor, x.currency), refunded };
  });
  const payment: CommerceOrder['payment'] = x.status === 'pending_payment' ? 'processing' : x.status === 'cancelled' ? 'failed' : 'succeeded';
  const refund: CommerceOrder['refund'] = x.refundedMinor <= 0 ? 'none' : x.refundedMinor >= x.totalMinor ? 'complete' : 'partial';
  return {
    id: x.id,
    number: x.externalId ?? x.id.slice(0, 8).toUpperCase(),
    customer: '—',
    locationId: x.locationId,
    source: x.source === 'native' ? 'BranchHarbor' : `${humanise(x.source)}${x.externalId ? ` #${x.externalId}` : ''}`,
    placedAt: x.createdAt,
    lines,
    total: m(x.totalMinor, x.currency),
    tax: { label: x.taxMinor ? 'Tax as configured' : 'No tax recorded', amount: x.taxMinor ? m(x.taxMinor, x.currency) : null },
    payment,
    refund,
    fulfilment: x.fulfilmentStatus === 'fulfilled' ? 'fulfilled' : x.status === 'pending_payment' ? 'on_hold' : 'to_fulfil',
    timeline: [
      { at: x.createdAt, text: `Order created (${x.source})`, tone: 'success', icon: 'check' },
      ...(x.refundedMinor ? [{ at: x.updatedAt, text: `Refunded ${(x.refundedMinor / 100).toFixed(2)} ${x.currency}`, tone: 'info' as Tone, icon: 'undo' as IconName }] : []),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* foods                                                               */
/* ------------------------------------------------------------------ */

interface ApiFoodOrder {
  id: string;
  orderNumber: string;
  locationId: string;
  status: FoodOrderStatus;
  paymentStatus: string;
  lines: { name: string; quantity: number; modifiers: (string | { name: string })[]; notes?: string }[];
  total: Money;
  promisedAt: string;
  notes: string | null;
  rejectionReason: string | null;
  contact: { name?: string } | null;
  createdAt: string;
}
interface ApiMenuItemHq {
  id: string;
  name: string;
  description: string | null;
  prices: Record<string, number>;
  dietary: string[];
  allergens: string[];
  imageUrl: string | null;
  localOverridable: string[];
  modifierGroups: { name: string; modifiers: { name: string }[] }[];
  active: boolean;
}
interface ApiMenuItemLoc {
  id: string;
  name: string;
  dietary: string[];
  allergens: string[];
  imageUrl: string | null;
  price: Money;
  available: boolean;
  unavailableReason: string | null;
  priceOrigin: 'hq' | 'local';
  modifierGroups: { name: string; modifiers: { name: string }[] }[];
}

const safeImage = (u: string | null) => (u && /^https:\/\/images\.unsplash\.com\//.test(u) ? u : FOOD_IMAGE);
const firstName = (n?: string) => (n ?? 'Guest').split(/\s+/)[0]!;

function foodView(x: ApiFoodOrder): FoodOrder {
  return {
    id: x.id,
    number: x.orderNumber,
    customerFirstName: firstName(x.contact?.name),
    locationId: x.locationId,
    pickupAt: x.promisedAt,
    placedAt: x.createdAt,
    total: x.total,
    paid: x.paymentStatus === 'paid',
    status: x.status,
    items: x.lines.map((l) => ({ name: l.name, qty: l.quantity, modifiers: (l.modifiers ?? []).map((md) => (typeof md === 'string' ? md : md.name)) })),
    notes: x.rejectionReason ? `Rejected: ${x.rejectionReason}` : (x.notes ?? undefined),
  };
}

const describeDiet = (dietary: string[], allergens: string[]) => [dietary.map(humanise).join(', '), allergens.length ? `Contains ${allergens.join(', ')}` : ''].filter(Boolean).join(' · ') || 'No dietary details';
const describeMods = (groups: { name: string; modifiers: { name: string }[] }[]) => groups.map((g) => `${g.name}: ${g.modifiers.map((x) => x.name).join(', ')}`).join(' · ') || 'None';

async function menuView(view: string): Promise<MenuItem[]> {
  if (view === 'hq') {
    const menus = await http.get<{ items: { id: string; status: string; items: ApiMenuItemHq[] }[] }>(o('/foods/menus')).then(items);
    return menus.flatMap((mn) =>
      mn.items.map((it): MenuItem => ({
        id: it.id,
        name: it.name,
        image: safeImage(it.imageUrl),
        status: mn.status === 'published' ? 'published' : 'draft',
        fields: [
          { key: 'price', label: 'Market prices', value: Object.entries(it.prices).map(([c, v]) => `${c} ${(v / 100).toFixed(2)}`).join(' · '), origin: 'hq', resettable: false },
          { key: 'dietary', label: 'Dietary details', value: describeDiet(it.dietary, it.allergens), origin: 'hq', resettable: false },
          { key: 'modifiers', label: 'Modifiers', value: describeMods(it.modifierGroups), origin: 'hq', resettable: false },
        ],
      })),
    );
  }
  const r = await http.get<{ items: ApiMenuItemLoc[] }>(o(`/foods/locations/${view}/menu`));
  return r.items.map((it) => ({
    id: it.id,
    name: it.name,
    image: safeImage(it.imageUrl),
    status: 'published',
    fields: [
      { key: 'price', label: 'Price', value: '', money: it.price, origin: it.priceOrigin === 'local' ? 'local' : 'inherited', resettable: it.priceOrigin === 'local' },
      { key: 'dietary', label: 'Dietary details', value: describeDiet(it.dietary, it.allergens), origin: 'inherited', resettable: false },
      { key: 'modifiers', label: 'Modifiers', value: describeMods(it.modifierGroups), origin: 'inherited', resettable: false },
      { key: 'availability', label: 'Availability', value: it.available ? 'Available' : (it.unavailableReason ?? 'Sold out'), origin: 'local', resettable: false },
    ],
  }));
}

/* ------------------------------------------------------------------ */
/* websites                                                            */
/* ------------------------------------------------------------------ */

interface ApiPageField {
  key: string;
  label: string;
  origin: 'hq' | 'local' | 'locked' | 'approval';
  value: unknown;
  hqValue: unknown;
  isOverridden: boolean;
  editableLocally: boolean;
  requiresApproval: boolean;
  pendingValue: unknown;
  pendingApprovalId: string | null;
}
interface ApiPage {
  id: string;
  locationId: string;
  slug: string;
  title: string;
  status: string;
  publishedAt: string | null;
  fields: ApiPageField[];
}
interface ApiApproval {
  id: string;
  locationId: string | null;
  targetType: string;
  targetId: string;
  payload: { pageId?: string; fieldKey?: string; value?: unknown } | null;
  requestedBy: string;
  requestComment: string | null;
  createdAt: string;
}
const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

async function homePageId(locationId: string): Promise<string> {
  const site = ws().websites.find((w) => w.locationId === locationId);
  if (!site) throw new ApiError('not_found', `${nameOfLoc(locationId)} has no BranchHarbor website yet.`, 404);
  const pages = await http.get<{ items: { id: string; slug: string }[] }>(o(`/websites/${site.id}/pages`)).then(items);
  const home = pages.find((p) => p.slug === 'home') ?? pages[0];
  if (!home) throw new ApiError('not_found', 'This website has no pages yet.', 404);
  return home.id;
}

async function pageView(locationId: string, page?: ApiPage): Promise<WebsitePage> {
  const id = page?.id ?? (await homePageId(locationId));
  const [p, versions, approvals] = await Promise.all([
    page ? Promise.resolve(page) : http.get<ApiPage>(o(`/pages/${id}`)),
    maybe(http.get<{ items: { id: string; version?: number; createdAt: string; publishedBy?: string | null }[] }>(o(`/pages/${id}/versions`)).then(items), []),
    maybe(http.get<{ items: ApiApproval[] }>(o('/approvals')).then(items), [] as ApiApproval[]),
  ]);
  const fields: WebsiteField[] = await Promise.all(
    p.fields.map(async (f) => {
      const ap = f.pendingApprovalId ? approvals.find((a) => a.id === f.pendingApprovalId) : undefined;
      return {
        key: f.key,
        label: f.label,
        policy: f.origin === 'locked' ? 'locked' : f.origin === 'approval' ? 'approval' : 'editable',
        value: str(f.value),
        hqValue: f.origin === 'locked' ? undefined : str(f.hqValue),
        pending: f.pendingValue != null ? { value: str(f.pendingValue), reason: ap?.requestComment ?? '—', requestedBy: await personName(ap?.requestedBy), at: ap?.createdAt ?? now() } : undefined,
      } satisfies WebsiteField;
    }),
  );
  const activity = [
    ...versions.map((v, i) => ({ at: v.createdAt, text: `Version ${v.version ?? versions.length - i} published` })),
    ...(await Promise.all(approvals.filter((a) => a.payload?.pageId === p.id).map(async (a) => ({ at: a.createdAt, text: `${await personName(a.requestedBy)} requested a change to ${p.fields.find((f) => f.key === a.payload?.fieldKey)?.label ?? a.payload?.fieldKey}` })))),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { locationId, locationName: nameOfLoc(locationId), page: p.title || 'Home', version: versions.length, fields, activity };
}

let plan: (GroupPublish & { jobId?: string }) | null = null;
interface ApiJob {
  id: string;
  status: string;
  results: { locationId: string; status: string; error: string | null; warnings: string[] | null }[];
}
function applyJob(j: ApiJob) {
  if (!plan) return;
  plan.jobId = j.id;
  for (const r of j.results) {
    const t = plan.targets.find((x) => x.locationId === r.locationId);
    if (!t) continue;
    t.result = r.status === 'succeeded' ? 'published' : r.status === 'pending' ? 'publishing' : 'failed';
    t.error = r.status === 'failed' ? (r.error ?? 'Publishing failed. The previous version is still live.') : r.status === 'skipped' ? `Skipped${r.warnings?.length ? `: ${r.warnings.join('; ')}` : ''}` : undefined;
  }
}

/* ------------------------------------------------------------------ */
/* payments                                                            */
/* ------------------------------------------------------------------ */

interface ApiPayment {
  id: string;
  locationId: string | null;
  provider: string;
  externalId: string;
  amount: Money;
  state: PaymentState;
  refundState: string | null;
  refunded: Money;
  targetType: string | null;
  targetId: string | null;
  sandbox: boolean;
  succeededAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface ApiRecon {
  items: { kind: string; paymentId: string | null; targetType: string | null; targetId: string | null; locationId: string | null; expected: Money | null; actual: Money | null; detail: string; recoverable: boolean }[];
  counts: Record<string, number>;
  generatedAt: string;
}

const TARGET_LABEL: Record<string, string> = { class_booking: 'Class booking', food_order: 'Pickup order', order: 'Order', appointment: 'Appointment', registration: 'Registration' };

function txView(p: ApiPayment): Transaction {
  const refund: RefundState = (p.refundState as RefundState | null) ?? 'none';
  const timeline: TimelineEvent[] = [{ at: p.createdAt, text: `Payment created (${p.externalId})`, tone: 'neutral', icon: 'card' }];
  if (p.succeededAt) timeline.push({ at: p.succeededAt, text: 'payment_intent.succeeded · signed event', tone: 'success', icon: 'check' });
  if (p.state === 'failed') timeline.push({ at: p.updatedAt, text: 'Payment failed', tone: 'danger', icon: 'x' });
  if (p.refunded.amount > 0) timeline.push({ at: p.updatedAt, text: `Refunded ${(p.refunded.amount / 100).toFixed(2)} ${p.refunded.currency}`, tone: 'info', icon: 'undo' });
  return {
    id: p.id,
    externalRef: p.externalId,
    createdAt: p.createdAt,
    description: TARGET_LABEL[p.targetType ?? ''] ?? 'Payment',
    locationId: p.locationId ?? '',
    amount: p.amount,
    payment: p.state,
    refund,
    provider: `${humanise(p.provider)}${p.sandbox ? ' (sandbox)' : ''}`,
    linkedRecord: p.targetId ? `${TARGET_LABEL[p.targetType ?? ''] ?? 'Record'} ${p.targetId.slice(0, 8)}` : undefined,
    timeline,
  };
}

async function reconciliationView(ctx: RequestContext): Promise<ReconciliationItem[]> {
  const scope = inScope(ctx);
  const [rec, pays] = await Promise.all([http.get<ApiRecon>(o('/payments/reconciliation')), http.get<{ items: ApiPayment[] }>(o('/payments'), { limit: 200 }).then(items)]);
  return rec.items
    .filter((x) => !x.locationId || scope.has(x.locationId))
    .map((x): ReconciliationItem => {
      const pay = pays.find((p) => p.id === x.paymentId);
      const type: ReconciliationItem['type'] = x.kind === 'unpaid_confirmed_record' ? 'unpaid_confirmed' : (x.kind as ReconciliationItem['type']);
      const amount = x.actual ?? x.expected ?? m(0, locationById(x.locationId)?.currency ?? 'USD');
      const timeline: TimelineEvent[] = [];
      if (pay) timeline.push({ at: pay.succeededAt ?? pay.createdAt, text: `${humanise(pay.provider)} payment ${pay.state} · ${amount.currency}`, tone: pay.state === 'succeeded' ? 'success' : 'neutral', icon: 'card' });
      timeline.push({ at: rec.generatedAt, text: x.detail, tone: 'danger', icon: 'x' });
      return {
        id: x.paymentId ?? `${x.kind}:${x.targetId}`,
        type,
        summary: `${TARGET_LABEL[x.targetType ?? ''] ?? 'Record'} · ${nameOfLoc(x.locationId)}`,
        transactionRef: pay?.externalId ?? '—',
        amount,
        locationId: x.locationId ?? '',
        customer: '—',
        orderState: type === 'paid_without_record' ? 'Missing' : type === 'unpaid_confirmed' ? 'Confirmed' : `Expected ${x.expected ? (x.expected.amount / 100).toFixed(2) : '—'}`,
        status: x.recoverable ? 'needs_action' : 'reviewing',
        timeline,
      };
    });
}

/* ------------------------------------------------------------------ */
/* connections                                                         */
/* ------------------------------------------------------------------ */

const PROVIDERS: Record<string, string> = { wordpress: 'WordPress', woocommerce: 'WooCommerce', shopify: 'Shopify', square: 'Square', mindbody: 'Mindbody', google_business: 'Google Business Profile', meta: 'Meta', stripe: 'Stripe' };
const providerName = (p: string) => PROVIDERS[p] ?? humanise(p);
const KIND_ROLE: Record<string, string> = { booking: 'Bookings and class schedule', commerce: 'Orders, products and stock', pos: 'Point of sale', website: 'Existing website', marketing: 'Marketing' };

function connectionView(c: ApiConnection): Connection {
  const known: ConnectionState[] = ['connected', 'initial_sync', 'degraded', 'disconnected', 'authorization_expired'];
  const state: ConnectionState = known.includes(c.state as ConnectionState) ? (c.state as ConnectionState) : 'degraded';
  const name = providerName(c.provider);
  return {
    id: c.id,
    name: c.locationId ? `${name} (${nameOfLoc(c.locationId)})` : name,
    monogram: name.slice(0, 2),
    role: KIND_ROLE[c.kind] ?? humanise(c.kind),
    state,
    lastSync: c.lastSuccessAt,
    direction: c.direction,
    authoritative: c.authoritative === 'external' ? `${name} is the source of truth` : 'BranchHarbor is the source of truth; the connection receives copies',
    locations: c.locationId ? [nameOfLoc(c.locationId)] : (workspace()?.locations.map((l) => l.name) ?? []),
    issue: state === 'connected' || state === 'initial_sync' ? undefined : (c.lastError ?? `Connection is ${humanise(state).toLowerCase()}.`),
    affected: c.mappingErrors ? `${c.mappingErrors} record${c.mappingErrors > 1 ? 's' : ''} need mapping` : undefined,
    fixAction: state === 'degraded' ? 'Retry sync' : state === 'connected' || state === 'initial_sync' ? undefined : 'Test connection',
  };
}

/* ------------------------------------------------------------------ */
/* tables                                                              */
/* ------------------------------------------------------------------ */

const tx = (v: string, sub?: string, strong?: boolean): Cell => ({ t: 'text', v, sub, strong });
const badge = (v: string, tone: Tone): Cell => ({ t: 'badge', v, tone });
const moneyCell = (v: Money, sub?: string): Cell => ({ t: 'money', v, sub });
const na = (reason?: string): Cell => ({ t: 'unavailable', reason });
const fmtDate = (iso: string | null | undefined, tz = 'UTC') => (iso ? new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: tz }).format(new Date(iso)) : '—');

function tableOf(key: string, columns: [string, string, ('left' | 'right')?][], rows: TableData['rows'], source: string, extra: Partial<TableData> = {}): TableData {
  return { key, columns: columns.map(([k, label, align]) => ({ key: k, label, align })), rows, filters: [{ key: 'all', label: 'All' }], source, ...extra };
}

const NOT_IN_API = (key: string, what: string): TableData =>
  tableOf(key, [['item', what]], [], 'BranchHarbor API', { description: `${what} aren’t available from the BranchHarbor API yet, so nothing is shown here rather than sample data.` });

async function liveTable(ctx: RequestContext, key: string): Promise<TableData> {
  const scope = inScope(ctx);
  const inS = (lid: string | null | undefined) => !lid || scope.has(lid);
  switch (key) {
    case 'customers': {
      const list = await http.get<{ items: { id: string; locationId: string | null; name: string; email: string | null; phone: string | null; createdAt: string; erasedAt: string | null }[] }>(o('/customers'), { limit: 200 }).then(items);
      return tableOf('customers', [['name', 'Name'], ['contact', 'Contact'], ['home', 'Home location'], ['since', 'Since'], ['state', 'State']],
        list.filter((c) => inS(c.locationId)).map((c) => ({ id: c.id, tags: [c.erasedAt ? 'erased' : 'active'], cells: { name: tx(c.erasedAt ? 'Erased customer' : c.name, undefined, true), contact: c.email ? tx(c.email, c.phone ?? undefined) : na('Not provided'), home: tx(nameOfLoc(c.locationId)), since: tx(fmtDate(c.createdAt, tzOf(c.locationId))), state: c.erasedAt ? badge('Erased', 'neutral') : badge('Active', 'success') } })),
        'BranchHarbor customers', { filters: [{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }] });
    }
    case 'marketing': {
      const list = await http.get<{ items: { id: string; name: string; channel: string | null; status: string; scopeKind?: string; scopeId?: string; scope?: { kind: string; id: string }; updatedAt?: string; createdAt: string }[] }>(o('/campaigns')).then(items);
      return tableOf('marketing', [['campaign', 'Campaign'], ['scope', 'Scope'], ['channel', 'Channel'], ['status', 'Status'], ['updated', 'Updated']],
        list.map((c) => {
          const sc = c.scope ?? (c.scopeKind ? { kind: c.scopeKind, id: c.scopeId ?? '' } : null);
          return { id: c.id, tags: [c.status], cells: { campaign: tx(c.name, undefined, true), scope: tx(sc ? scopeLabel(sc) : 'Organisation'), channel: tx(humanise(c.channel ?? 'email')), status: badge(humanise(c.status), c.status === 'draft' ? 'neutral' : c.status === 'scheduled' ? 'info' : 'success'), updated: tx(fmtDate(c.updatedAt ?? c.createdAt)) } };
        }),
        'BranchHarbor campaigns', { primaryAction: 'New campaign', filters: [{ key: 'all', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'scheduled', label: 'Scheduled' }] });
    }
    case 'programmes': {
      const list = await http.get<{ items: ApiProgramme[] }>(o('/sports/programmes')).then(items);
      return tableOf('programmes', [['programme', 'Programme'], ['ages', 'Ages'], ['venue', 'Venue'], ['fee', 'Fee', 'right'], ['registration', 'Registration'], ['capacity', 'Capacity', 'right']],
        list.filter((p) => inS(p.locationId)).map((p) => ({ id: p.id, tags: [p.status === 'published' ? 'open' : 'closed'], cells: { programme: tx(p.name, undefined, true), ages: tx(p.ageMin != null || p.ageMax != null ? `${p.ageMin ?? '?'}–${p.ageMax ?? '?'}` : 'All ages'), venue: tx(nameOfLoc(p.locationId)), fee: moneyCell(m(p.feeMinor, p.currency)), registration: badge(humanise(p.status), p.status === 'published' ? 'success' : 'neutral'), capacity: p.capacity != null ? tx(String(p.capacity)) : na('No limit set') } })),
        'BranchHarbor programmes');
    }
    case 'teams': {
      const [teams, progs] = await Promise.all([http.get<{ items: ApiTeam[] }>(o('/sports/teams')).then(items), http.get<{ items: ApiProgramme[] }>(o('/sports/programmes')).then(items)]);
      return tableOf('teams', [['group', 'Group'], ['coach', 'Coach'], ['programme', 'Programme'], ['roster', 'Capacity', 'right'], ['next', 'Venue']],
        await Promise.all(teams.filter((t) => inS(t.locationId)).map(async (t) => ({ id: t.id, tags: [], cells: { group: tx(t.name, undefined, true), coach: t.coachUserId ? tx(await personName(t.coachUserId)) : na('No coach assigned'), programme: tx(progs.find((p) => p.id === t.programmeId)?.name ?? '—'), roster: t.capacity != null ? tx(String(t.capacity)) : na(), next: tx(nameOfLoc(t.locationId)) } }))),
        'BranchHarbor groups');
    }
    case 'services': {
      const list = await http.get<{ items: ApiService[] }>(o('/wellness/services')).then(items);
      return tableOf('services', [['service', 'Service'], ['duration', 'Duration'], ['price', 'Price', 'right'], ['buffer', 'Buffer'], ['needs', 'Needs'], ['status', 'Status']],
        list.filter((s) => inS(s.locationId)).map((s) => ({ id: s.id, tags: [s.active ? 'active' : 'paused'], cells: { service: tx(s.name, s.locationId ? nameOfLoc(s.locationId) : 'All locations', true), duration: tx(`${s.durationMinutes} min`), price: moneyCell(m(s.priceMinor, s.currency), s.depositMinor ? `Deposit ${(s.depositMinor / 100).toFixed(2)}` : undefined), buffer: tx(`${s.bufferBeforeMinutes}/${s.bufferAfterMinutes} min`), needs: tx(s.requiredResourceType ? humanise(s.requiredResourceType) : '—'), status: badge(s.active ? 'Active' : 'Paused', s.active ? 'success' : 'neutral') } })),
        'BranchHarbor services', { primaryAction: 'New service' });
    }
    case 'practitioners': {
      const [list, services] = await Promise.all([http.get<{ items: ApiPractitioner[] }>(o('/wellness/practitioners')).then(items), maybe(http.get<{ items: ApiService[] }>(o('/wellness/services')).then(items), [] as ApiService[])]);
      return tableOf('practitioners', [['practitioner', 'Practitioner'], ['services', 'Services'], ['locations', 'Locations'], ['week', 'Weekly availability']],
        list.filter((p) => inS(p.locationId)).map((p) => ({ id: p.id, tags: [], cells: { practitioner: tx(p.name, undefined, true), services: tx(p.serviceIds.map((id) => services.find((s) => s.id === id)?.name).filter(Boolean).join(', ') || '—'), locations: tx(nameOfLoc(p.locationId)), week: tx(p.availability.length ? `${p.availability.length} windows` : 'Not set') } })),
        'Practitioner calendars');
    }
    case 'catalogue': {
      const list = await http.get<{ items: { id: string; sku: string; name: string; status: string; variants?: unknown[]; lockedFields?: string[] }[] }>(o('/commerce/products')).then(items);
      return tableOf('catalogue', [['product', 'Product'], ['variants', 'Variants', 'right'], ['editable', 'Locked fields'], ['status', 'Status']],
        list.map((p) => ({ id: p.id, tags: [p.status === 'active' ? 'published' : p.status], cells: { product: tx(p.name, p.sku, true), variants: tx(String(p.variants?.length ?? 0)), editable: tx((p.lockedFields ?? []).join(', ') || '—'), status: badge(humanise(p.status), p.status === 'active' ? 'success' : 'neutral') } })),
        'Master catalogue', { primaryAction: 'New product' });
    }
    case 'assortment': {
      const list = (await http.get<{ items: ApiInventoryRow[] }>(o('/commerce/inventory')).then(items)).filter((x) => inS(x.locationId));
      return tableOf('assortment', [['item', 'Item'], ['onhand', 'On hand', 'right'], ['reserved', 'Reserved', 'right'], ['available', 'Available', 'right'], ['price', 'Price', 'right'], ['availability', 'Availability']],
        list.map((v) => ({
          id: `${v.locationId}:${v.variantId}`, tags: [v.lowStock ? 'low' : 'ok'],
          cells: {
            item: tx(`${v.productName} · ${v.name}`, `${v.sku} · ${v.locationName}`, true), onhand: tx(String(v.onHand)), reserved: tx(String(v.reserved)), available: tx(String(v.available)),
            price: v.price.amount != null ? moneyCell(m(v.price.amount, v.price.currency)) : na('No price in this currency'),
            availability: !v.sellable ? badge('Hidden', 'neutral') : v.lowStock ? badge(`Low · reorder at ${v.reorderPoint}`, 'warning') : badge('In stock', 'success'),
          },
        })),
        'Local assortment · stock per location', { filters: [{ key: 'all', label: 'All' }, { key: 'low', label: 'Low' }] });
    }
    case 'offers': {
      const list = await http.get<{ items: ApiOffer[] }>(o('/studios/offers')).then(items);
      const prices = (p: Record<string, number>) => Object.entries(p).map(([c, a]) => moneyWithCode(m(a, c as Currency), 'en')).join(' / ');
      const tone: Record<string, Tone> = { active: 'success', draft: 'neutral', paused: 'warning', ended: 'neutral' };
      return tableOf('offers', [['offer', 'Offer'], ['eligibility', 'Eligibility'], ['locations', 'Locations'], ['valid', 'Valid'], ['status', 'Status']],
        list.filter((x) => inS(x.locationId)).map((x) => ({
          id: x.id, tags: [x.status],
          cells: {
            offer: tx(x.name, `${x.credits ? `${x.credits} class${x.credits === 1 ? '' : 'es'} · ` : ''}${prices(x.prices) || 'No price set'}`, true),
            eligibility: tx(x.rules.join(' · ') || 'Anyone', x.redemptions ? `${x.redemptions} redeemed` : undefined),
            locations: tx(x.locationId ? x.locationName ?? nameOfLoc(x.locationId) : 'All locations', x.locationId ? 'Local offer' : 'Network offer'),
            valid: tx(x.startsAt || x.endsAt ? `${x.startsAt ? fmtDate(x.startsAt) : 'Now'} – ${x.endsAt ? fmtDate(x.endsAt) : 'ongoing'}` : 'Ongoing', `Use within ${x.validDays} days`),
            status: badge(humanise(x.status), tone[x.status] ?? 'neutral'),
          },
        })),
        'BranchHarbor offers', { primaryAction: 'New offer', filters: [{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'draft', label: 'Draft' }, { key: 'ended', label: 'Ended' }] });
    }
    case 'schedule': {
      const from = new Date(Date.now() - 12 * 3600_000).toISOString();
      const to = new Date(Date.now() + 14 * 86400_000).toISOString();
      const list = await http.get<{ items: ApiSportsSession[] }>(o('/sports/sessions'), { from, to }).then(items);
      return tableOf('schedule', [['when', 'When'], ['group', 'Group'], ['venue', 'Venue'], ['coach', 'Coach'], ['check', 'Check']],
        list.filter((x) => inS(x.location.id)).map((x) => ({
          id: x.id, tags: [x.venueConflict ? 'conflict' : 'clear', x.kind],
          cells: {
            when: tx(`${fmtDay(x.startsAt, x.location.timeZone, 'en')} ${fmtTime(x.startsAt, x.location.timeZone, 'en')}`, zoneLabel(x.location.timeZone, 'en')),
            group: tx(x.team.name, x.kind === 'fixture' ? 'Fixture' : 'Training', true),
            venue: tx(x.venue ?? 'Venue not set', x.location.name),
            coach: x.team.coach ? tx(x.team.coach.name) : na('No coach assigned'),
            check: x.status === 'cancelled' ? badge('Cancelled', 'neutral') : x.venueConflict ? badge(`Venue clash · ${x.conflicts.map((c) => c.teamName).join(', ')}`, 'danger') : badge('Clear', 'success'),
          },
        })),
        'Schedule · venue bookings', { filters: [{ key: 'all', label: 'Next 2 weeks' }, { key: 'conflict', label: 'Conflicts' }, { key: 'fixture', label: 'Fixtures' }] });
    }
    case 'forms': {
      const [list, services] = await Promise.all([http.get<{ items: ApiIntakeForm[] }>(o('/wellness/intake-forms')).then(items), maybe(http.get<{ items: ApiService[] }>(o('/wellness/services')).then(items), [] as ApiService[])]);
      return tableOf('forms', [['form', 'Form'], ['used', 'Used by'], ['version', 'Consent version'], ['responses', 'Responses', 'right'], ['ai', 'AI access']],
        list.filter((f) => inS(f.locationId)).map((f) => ({
          id: f.id, tags: [f.status],
          cells: {
            form: tx(f.name, `${f.questions.length} questions · ${humanise(f.status)}`, true),
            used: tx(f.serviceIds.length ? [...new Set(f.serviceIds.map((id) => services.find((s) => s.id === id)?.name).filter(Boolean))].join(', ') : 'All services', f.locationId ? f.locationName ?? nameOfLoc(f.locationId) : 'All locations'),
            version: tx(`${f.consentVersion} · form v${f.version}`),
            responses: tx(String(f.responses)),
            ai: badge('Excluded', 'neutral'),
          },
        })),
        'BranchHarbor forms', { description: 'Administrative questions only. Responses are excluded from AI context by default.', filters: [{ key: 'all', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'draft', label: 'Draft' }] });
    }
    case 'inventory': {
      const list = await http.get<{ items: ApiStockMovement[] }>(o('/commerce/stock-movements'), { limit: 300 }).then(items);
      const sign = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);
      return tableOf('inventory', [['when', 'When'], ['item', 'Item'], ['change', 'Change', 'right'], ['reason', 'Reason'], ['balance', 'On hand after', 'right'], ['by', 'By']],
        list.filter((x) => inS(x.locationId)).map((x) => ({
          id: x.id, tags: [x.reason === 'sale' ? 'sale' : x.affectsOnHand ? 'adjust' : 'reserved'],
          cells: {
            when: tx(`${fmtDay(x.createdAt, x.location.timeZone, 'en')} ${fmtTime(x.createdAt, x.location.timeZone, 'en')}`, zoneLabel(x.location.timeZone, 'en')),
            item: tx(`${x.variant.productName} · ${x.variant.name}`, `${x.variant.sku} · ${x.location.name}`, true),
            change: tx(sign(x.quantity)),
            reason: x.affectsOnHand ? tx(x.reasonLabel, x.note ?? x.reference ?? undefined) : badge(x.reasonLabel, 'info'),
            balance: x.balanceAfter == null ? na('Not on-hand') : tx(String(x.balanceAfter)),
            by: tx(x.createdByName),
          },
        })),
        'Inventory history (movements, not just counts)', { description: 'Every change to stock with its reason. Reservations hold units for unpaid orders and do not change on-hand stock.', filters: [{ key: 'all', label: 'All' }, { key: 'adjust', label: 'Adjustments' }, { key: 'sale', label: 'Sales' }, { key: 'reserved', label: 'Reservations' }] });
    }
    case 'pickup': {
      const list = (await http.get<{ items: ApiPickupSettings[] }>(o('/foods/pickup-settings')).then(items)).filter((x) => inS(x.locationId));
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const hoursOf = (x: ApiPickupSettings) => {
        const byDay = new Map<string, string[]>();
        for (const h of [...x.hours].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.open.localeCompare(b.open))) byDay.set(days[h.weekday]!, [...(byDay.get(days[h.weekday]!) ?? []), `${h.open}–${h.close}`]);
        const groups = new Map<string, string[]>();
        for (const [d, w] of byDay) groups.set(w.join(', '), [...(groups.get(w.join(', ')) ?? []), d]);
        return [...groups.entries()].map(([w, ds]) => `${ds.length > 2 ? `${ds[0]}–${ds[ds.length - 1]}` : ds.join(', ')} ${w}`).join(' · ') || 'No pickup hours';
      };
      const settingRows: [string, string, string | undefined, (x: ApiPickupSettings) => Cell][] = [
        ['hours', 'Opening hours', 'Local time', (x) => tx(hoursOf(x), zoneLabel(x.location.timeZone, 'en'))],
        ['slot', 'Slot length', undefined, (x) => tx(`${x.slotMinutes} min`)],
        ['capacity', 'Orders per slot', undefined, (x) => tx(String(x.slotCapacity))],
        ['cutoff', 'Order cut-off', undefined, (x) => tx(`${x.cutoffMinutes} min before pickup`)],
        ['buffer', 'Prep buffer', 'Earliest pickup after ordering', (x) => tx(`${x.prepBufferMinutes} min`)],
        ['horizon', 'Days bookable ahead', undefined, (x) => tx(`${x.horizonDays} day${x.horizonDays === 1 ? '' : 's'}`)],
        ['closed', 'Closed dates', undefined, (x) => tx(x.closedDates.length ? x.closedDates.map((d) => fmtDate(`${d}T12:00:00Z`)).join(', ') : 'None')],
        ['accepting', 'Taking pickup orders', undefined, (x) => (x.acceptingOrders ? badge('Yes', 'success') : badge('Paused', 'warning'))],
        ['next', 'Next 24 h', 'Booked / capacity', (x) => tx(`${x.next24h.booked} / ${x.next24h.capacity}`, `${x.next24h.slots} slots`)],
        ['origin', 'Settings', undefined, (x) => (x.configured ? { t: 'origin', v: 'local' } : { t: 'origin', v: 'hq' })],
      ];
      return tableOf('pickup', [['setting', 'Setting'], ...list.map((x): [string, string] => [x.locationId, x.location.name])],
        settingRows.map(([id, label, sub, cell]) => ({ id, tags: [], cells: { setting: tx(label, sub, true), ...Object.fromEntries(list.map((x) => [x.locationId, cell(x)])) } })),
        'Pickup settings · slots are generated from these', { description: 'Pickup slots are generated from each location’s hours, slot length and capacity. Orders close at the cut-off and never earlier than the preparation buffer allows.' });
    }
    default:
      throw new ApiError('not_found', 'This table does not exist for this industry.', 404);
  }
}

/* ------------------------------------------------------------------ */
/* onboarding                                                          */
/* ------------------------------------------------------------------ */

const STEP_MAP: Record<OnboardingStep, string> = { account: 'account', industry: 'industry', business: 'business_details', location: 'first_location', website: 'website', data: 'industry_data', connect: 'connections', team: 'invite_staff', publish: 'preview_publish' };
const OPTIONAL_API_STEPS = ['website', 'industry_data', 'connections', 'invite_staff'];
const DRAFT_KEY = 'bh_onboarding_draft';
interface ApiOnboarding {
  steps: { key: string; status: string; data: Record<string, unknown> | null; updatedAt: string | null }[];
}
let lastOnboarding: OnboardingProgress | null = null;

function localDraft(): OnboardingProgress | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as OnboardingProgress) : null;
  } catch {
    return null;
  }
}
function saveLocalDraft(p: OnboardingProgress) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/** Creates the organisation (and first location) from the onboarding draft once the business step is done. */
async function ensureOrgFromDraft(p: OnboardingProgress) {
  if (workspace()?.org) return;
  if (!p.done.includes('business')) return;
  const d = p.data as { industry?: string; model?: string; biz?: { name: string; country: string; timeZone: string; currency: string; locale: string; dataRegion: string } };
  if (!d.biz?.name) return;
  await http.post('/orgs', {
    name: d.biz.name, industry: d.industry ?? 'studios', model: d.model ?? 'network', country: d.biz.country, defaultCurrency: d.biz.currency,
    defaultTimeZone: d.biz.timeZone, defaultLocale: d.biz.locale || 'en', dataRegion: d.biz.dataRegion || 'us',
  });
  await loadWorkspace();
}

async function ensureFirstLocation(p: OnboardingProgress) {
  const w = workspace();
  if (!w?.org || w.locations.length || !p.done.includes('location')) return;
  const l = (p.data as { loc?: { name: string; code: string; line1: string; city: string; region?: string; postalCode?: string; country: string; timeZone: string; currency: string; phone?: string } }).loc;
  if (!l?.name) return;
  await http.post(o('/locations'), { name: l.name, code: l.code, address: { line1: l.line1, city: l.city, region: l.region || undefined, postalCode: l.postalCode || undefined, country: l.country }, timeZone: l.timeZone, currency: l.currency, phone: l.phone || undefined });
  await refreshWorkspace();
}

/** Without a saved draft, start the checklist from what the organisation already has (not sample data). */
async function draftFromOrg(): Promise<Record<string, unknown>> {
  const w = ws();
  const org = w.org!;
  const first = w.locations[0];
  const offerings =
    w.orgView?.industry === 'studios'
      ? (await maybe(http.get<{ items: { name: string; durationMinutes: number; defaultCapacity: number }[] }>(o('/studios/class-types')).then(items), [] as { name: string; durationMinutes: number; defaultCapacity: number }[])).map((c) => `${c.name} · ${c.durationMinutes} min · ${c.defaultCapacity} spots`)
      : w.orgView?.industry === 'foods'
        ? (await maybe(http.get<{ items: { items: { name: string }[] }[] }>(o('/foods/menus')).then(items), [] as { items: { name: string }[] }[])).flatMap((mn) => mn.items.map((i) => i.name))
        : [];
  return {
    industry: w.orgView?.industry ?? 'studios',
    model: org.model === 'independent' ? 'independent' : 'network',
    biz: { name: org.name, country: org.country, timeZone: org.defaultTimeZone, currency: org.defaultCurrency, locale: org.defaultLocale, dataRegion: org.dataRegion },
    ...(first
      ? { loc: { name: first.name, code: first.code, ownerGroup: w.ownerGroups.find((g) => g.id === first.ownerGroupId)?.name ?? 'Company-owned', line1: first.address.line1, city: first.address.city, region: first.address.region ?? '', postalCode: first.address.postalCode ?? '', country: first.address.country, timeZone: first.timeZone, currency: first.currency, phone: first.phone, email: '', hours: first.hours, template: first.template, overrides: { hours: true, prices: true, offers: true, images: false, staff: true } } }
      : {}),
    items: offerings,
    invites: [],
    pay: w.locations.some((l) => l.site === 'live') ? 'enabled' : 'not',
  };
}

/* ------------------------------------------------------------------ */
/* domains                                                             */
/* ------------------------------------------------------------------ */

interface ApiDomain {
  id: string;
  hostname: string;
  state: DomainStatus['state'];
  websiteId: string;
  locationId: string | null;
  isPrimary: boolean;
  dnsRecords: { type: 'TXT' | 'CNAME'; name: string; value: string }[];
  checks: Record<string, { ok?: boolean; found?: boolean } | boolean | undefined>;
  failureReason: string | null;
}
function domainView(d: ApiDomain): DomainStatus {
  const found = (type: string) => {
    const c = d.checks?.[type.toLowerCase()] ?? d.checks?.[type === 'TXT' ? 'txt' : 'cname'];
    if (typeof c === 'boolean') return c;
    return !!(c && (c.ok ?? c.found)) || d.state === 'ready' || d.state === 'certificate_pending';
  };
  return {
    hostname: d.hostname,
    state: d.state,
    records: d.dnsRecords.map((r) => ({ type: r.type, name: r.name, value: r.value, found: found(r.type) })),
    message: d.failureReason ?? (d.state === 'certificate_pending' ? 'Issuing the security certificate. Your included address keeps working meanwhile.' : undefined),
  };
}
async function findDomain(hostname: string): Promise<ApiDomain | undefined> {
  return (await http.get<{ items: ApiDomain[] }>(o('/domains')).then(items)).find((d) => d.hostname === hostname);
}

/* ------------------------------------------------------------------ */
/* the API                                                             */
/* ------------------------------------------------------------------ */

const DEV_TOKEN_KEY = 'bh_dev_verification_token';
function rememberDevToken(t?: string) {
  try {
    if (t) sessionStorage.setItem(DEV_TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}
export function devVerificationToken(): string | null {
  try {
    return sessionStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
}

export const httpApi: BranchHarborApi = {
  mode: 'live',

  auth: {
    session: async (ctx) => {
      const w = workspace() ?? (await loadWorkspace());
      return sessionOf(effectiveRole(ctx.role, w), w);
    },
    signIn: async ({ email, password }) => {
      const s = await login(email, password);
      clearWorkspace();
      return { needsVerification: !s.user.emailVerified };
    },
    signUp: async (input) => {
      const s = await signup(input);
      rememberDevToken(s.devVerificationToken);
      clearWorkspace();
      return { needsVerification: !s.user.emailVerified };
    },
    verifyEmail: async ({ code }) => {
      // The API verifies with the token from the emailed link (/verify-email?token=…), pasted or followed.
      const token = code.trim().replace(/^.*[?&]token=/, '');
      if (token.length < 10) throw new ApiError('validation_error', 'Paste the link or token from the verification email.', 422, { code: 'Paste the link or token from the email.' });
      await verifyEmail(decodeURIComponent(token));
      try {
        sessionStorage.removeItem(DEV_TOKEN_KEY);
      } catch {
        /* ignore */
      }
      return { ok: true };
    },
    resendCode: async () => {
      const r = await resendVerification();
      rememberDevToken(r.devVerificationToken);
      return { ok: true };
    },
    forgotPassword: async () => {
      throw new ApiError('not_available', 'Password reset by email isn’t available yet. Ask your organisation owner to re-invite you, or contact BranchHarbor support.', 501);
    },
    signOut: async () => {
      await logout().catch(() => undefined);
      clearWorkspace();
    },
  },

  org: async () => {
    const v = ws().orgView;
    if (!v) throw new ApiError('no_organization', 'Finish setting up your business first.', 409);
    return v;
  },
  scopes: async (ctx) => scopeOptionsOf(effectiveRole(ctx.role), ws()),
  locations: async (ctx) => {
    const scope = inScope(ctx);
    const fresh = await http.get<{ items: ApiLocation[] }>(o('/locations')).then(items);
    const known = ws().locations;
    return fresh
      .filter((l) => scope.has(l.id))
      .map((l) => known.find((k) => k.id === l.id) ?? ({ ...known[0]!, id: l.id, name: l.name } as Location))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  overview: async (ctx) => {
    const ind = ws().orgView?.industry ?? ctx.industry;
    // Roles without reports.read (e.g. staff) still get their upcoming work and alerts, just no metrics.
    const [r, up, attention] = await Promise.all([allowedFor(ctx, 'reports.read') ? report(ctx) : null, upcoming(ctx), attentionItems(ctx)]);
    return { metrics: r ? overviewMetrics(ind, r) : [], upcomingTitle: up.title, upcoming: up.items, attention: attention.map(({ at: _at, ...a }) => a), aiPrompt: AI_SUGGESTIONS[ind][0]! } satisfies Overview;
  },
  table: (ctx, key) => liveTable(ctx, key),
  search: async (ctx, q) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const scope = inScope(ctx);
    const locs = ws().locations.filter((l) => scope.has(l.id) && (l.name.toLowerCase().includes(needle) || l.address.city.toLowerCase().includes(needle) || l.code.toLowerCase().includes(needle)));
    const groups: { type: string; items: { id: string; label: string; sub: string; href: string }[] }[] = [];
    if (locs.length) groups.push({ type: 'Locations', items: locs.map((l) => ({ id: l.id, label: l.name, sub: `${l.address.city} · ${l.currency} · ${l.timeZone}`, href: `/locations?open=${l.id}` })) });
    const people = (await members()).filter((p) => p.user.name.toLowerCase().includes(needle) || p.user.email.toLowerCase().includes(needle));
    if (people.length) groups.push({ type: 'Team', items: people.map((p) => ({ id: p.user.id, label: p.user.name, sub: p.assignments.map((a) => ROLE_LABEL[a.role] ?? a.role).join(', '), href: '/team' })) });
    return groups;
  },
  notifications: async (ctx) => (await attentionItems(ctx)).map((a) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at, href: a.href })),

  studios: {
    classes: async (ctx, weekStartYmd) => {
      const lid = [...inScope(ctx)][0];
      const tz = tzOf(lid);
      if (!lid) return { timeZone: tz, occurrences: [] };
      const from = zonedToUtc(weekStartYmd, '00:00', tz);
      const to = zonedToUtc(addDays(weekStartYmd, 7), '00:00', tz);
      const [occ, covers] = await Promise.all([
        http.get<{ items: ApiOccurrence[] }>(o('/studios/occurrences'), { locationId: lid, from, to }).then(items),
        maybe(http.get<{ items: ApiCover[] }>(o('/studios/cover-requests')).then(items), [] as ApiCover[]),
      ]);
      const external = ws().connections.some((c) => c.kind === 'booking' && c.authoritative === 'external' && (c.locationId === lid || !c.locationId));
      const typeIdx = new Map<string, number>();
      const occurrences = occ
        .filter((x) => x.status !== 'cancelled')
        .map((x): ClassOccurrence => {
          if (!typeIdx.has(x.classTypeId)) typeIdx.set(x.classTypeId, typeIdx.size);
          const cover = covers.some((c) => c.occurrenceId === x.id && ['open', 'accepted'].includes(c.status));
          return {
            id: x.id, name: x.classTypeName ?? 'Class', instructor: x.instructorName ?? 'Unassigned', locationId: x.locationId, room: x.room ?? '',
            start: x.startsAt, minutes: Math.round((new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime()) / 60000), booked: x.booked + x.held, capacity: x.capacity,
            waitlist: x.waitlist, source: external ? 'Booking connection' : 'BranchHarbor', coverRequested: cover, pastel: cover ? P.blush : PASTEL_CYCLE[typeIdx.get(x.classTypeId)! % PASTEL_CYCLE.length]!,
          };
        });
      return { timeZone: tz, occurrences };
    },
    cover: (ctx) => currentCover(ctx),
    acceptCover: async (id) => {
      await http.post(o(`/studios/cover-requests/${id}/accept`));
      return coverById(id);
    },
    approveCover: async (id) => {
      await http.post(o(`/studios/cover-requests/${id}/decision`), { decision: 'approve' });
      return coverById(id);
    },
    resetCover: async () => {
      throw new ApiError('not_supported', 'Cover requests can’t be reopened once decided. Request cover again from the class.', 409);
    },
  },

  sports: {
    registrations: async (ctx) => {
      const scope = inScope(ctx);
      const [regs, progs, teams] = await Promise.all([
        http.get<{ items: ApiRegistration[] }>(o('/sports/registrations')).then(items),
        http.get<{ items: ApiProgramme[] }>(o('/sports/programmes')).then(items),
        http.get<{ items: ApiTeam[] }>(o('/sports/teams')).then(items),
      ]);
      const groups: SportsGroup[] = teams.filter((t) => scope.has(t.locationId)).map((t) => ({ id: t.id, name: t.name, roster: regs.filter((r) => r.teamId === t.id && r.status === 'accepted').length, capacity: t.capacity ?? 0 }));
      const list = regs.filter((r) => scope.has(r.locationId)).map((r): Registration => {
        const p = progs.find((x) => x.id === r.programmeId);
        const formsComplete = Object.keys(r.forms ?? {}).length > 0;
        return {
          id: r.id, participant: r.participant.name, age: ageFrom(r.participant.dateOfBirth), programme: p?.name ?? 'Programme', guardian: '—', guardianVerified: false,
          payment: r.paymentId ? { label: 'Paid', amount: p ? m(p.feeMinor, p.currency) : undefined, tone: 'success' } : { label: p?.feeMinor ? 'Not taken' : 'No fee', tone: 'neutral' },
          formsComplete, formsNote: formsComplete ? 'Forms submitted' : 'No forms on record',
          status: r.status === 'accepted' ? 'accepted' : r.status === 'waitlisted' ? 'waitlisted' : r.status === 'withdrawn' || r.status === 'rejected' ? 'withdrawn' : 'awaiting_review',
          groupId: r.teamId ?? undefined,
        };
      });
      return { items: list, groups };
    },
    decide: async (id, input) => {
      await http.post(o(`/sports/registrations/${id}/review`), { decision: input.decision, teamId: input.groupId });
      const r = await httpApi.sports.registrations({ industry: 'sports', role: role(), scopeId: 'all' });
      const found = r.items.find((x) => x.id === id);
      if (!found) throw new ApiError('not_found', 'Registration not found.', 404);
      return found;
    },
    session: async (ctx) => {
      // The coach's next session: the one in progress, else the next upcoming, else the most recent one still unrecorded.
      const scope = inScope(ctx);
      const nowMs = Date.now();
      const list = (await http.get<{ items: ApiSportsSession[] }>(o('/sports/sessions'), { from: new Date(nowMs - 7 * 86400_000).toISOString(), to: new Date(nowMs + 14 * 86400_000).toISOString() }).then(items))
        .filter((x) => scope.has(x.location.id) && x.status !== 'cancelled');
      const live = list.find((x) => Date.parse(x.startsAt) <= nowMs && Date.parse(x.endsAt) >= nowMs);
      const next = list.find((x) => Date.parse(x.startsAt) > nowMs);
      const unrecorded = [...list].reverse().find((x) => Date.parse(x.endsAt) < nowMs && x.attendance.recorded < x.rosterCount);
      const sess = live ?? next ?? unrecorded;
      if (!sess) throw new ApiError('not_found', 'No training sessions or fixtures are scheduled in this scope for the next two weeks.', 404);
      const r = await http.get<{ roster: { id: string; name: string; attendance: string | null }[] }>(o(`/sports/sessions/${sess.id}/roster`));
      return {
        id: sess.id, group: `${sess.team.name} · ${sess.kind === 'fixture' ? 'Fixture' : 'Training'}`, start: sess.startsAt, timeZone: sess.location.timeZone,
        venue: `${sess.venue ?? 'Venue not set'}${sess.venueConflict ? ' (venue clash)' : ''}`, coach: sess.team.coach?.name ?? 'No coach assigned',
        roster: r.roster.map((p) => ({ id: p.id, name: p.name })), submitted: r.roster.length > 0 && r.roster.every((p) => p.attendance !== null),
      };
    },
    submitAttendance: async (sessionId, marks) => {
      await http.post(o(`/sports/sessions/${sessionId}/attendance`), { marks: Object.entries(marks).map(([participantId, status]) => ({ participantId, status })) });
      return { ok: true as const, notifiedGuardians: Object.values(marks).filter((v) => v === 'absent').length };
    },
  },

  wellness: {
    day: async (ctx) => {
      const lid = [...inScope(ctx)][0];
      if (!lid) throw new ApiError('not_found', 'No location in this scope.', 404);
      const tz = tzOf(lid);
      const date = dateInZone(new Date(), tz);
      const from = zonedToUtc(date, '00:00', tz);
      const to = zonedToUtc(addDays(date, 1), '00:00', tz);
      const [appts, pracs, services, rooms] = await Promise.all([
        http.get<{ items: ApiAppointment[] }>(o('/wellness/appointments'), { locationId: lid, from, to }).then(items),
        http.get<{ items: ApiPractitioner[] }>(o('/wellness/practitioners')).then(items),
        http.get<{ items: ApiService[] }>(o('/wellness/services')).then(items),
        maybe(http.get<{ items: { id: string; locationId: string; name: string }[] }>(o('/wellness/resources')).then(items), []),
      ]);
      const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
      const slots = [...new Set(appts.map((a) => hhmm(a.startsAt)))].sort();
      return {
        date, locationId: lid, timeZone: tz, slots,
        practitioners: pracs.filter((p) => p.locationId === lid).map((p, i) => ({ id: p.id, name: p.name, pastel: PASTEL_CYCLE[i % PASTEL_CYCLE.length]! })),
        rooms: rooms.filter((r) => r.locationId === lid).map((r) => r.name),
        appointments: appts.filter((a) => a.status !== 'rescheduled').map((a) => {
          const s = services.find((x) => x.id === a.serviceId);
          return { id: a.id, service: s ? `${s.name} · ${s.durationMinutes} min` : 'Appointment', client: a.customerName ?? 'Client', practitionerId: a.practitionerId, room: rooms.find((r) => r.id === a.resourceId)?.name ?? '—', start: a.startsAt, minutes: Math.round((new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000), status: a.status === 'cancelled' ? 'cancelled' : a.paymentId ? 'deposit_paid' : 'confirmed' };
        }),
      } satisfies WellnessDay;
    },
    slots: async (appointmentId) => {
      const appts = await http.get<{ items: ApiAppointment[] }>(o('/wellness/appointments'), { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date(Date.now() + 14 * 86400_000).toISOString() }).then(items);
      const a = appts.find((x) => x.id === appointmentId);
      if (!a) throw new ApiError('not_found', 'Appointment not found.', 404);
      const tz = tzOf(a.locationId);
      const pracs = await http.get<{ items: ApiPractitioner[] }>(o('/wellness/practitioners')).then(items);
      const out: { id: string; start: string; practitioner: string; room: string }[] = [];
      for (const d of [0, 1]) {
        const date = addDays(dateInZone(new Date(), tz), d);
        const r = await http.get<{ slots: { startsAt: string; practitionerIds: string[] }[] }>(`/public/wellness/${a.locationId}/availability`, { serviceId: a.serviceId, date }, { auth: false });
        for (const s of r.slots) {
          if (new Date(s.startsAt).getTime() < Date.now()) continue;
          const pid = s.practitionerIds.includes(a.practitionerId) ? a.practitionerId : s.practitionerIds[0];
          if (pid) out.push({ id: `${s.startsAt}|${pid}`, start: s.startsAt, practitioner: pracs.find((p) => p.id === pid)?.name ?? 'Practitioner', room: '—' });
        }
      }
      return out.slice(0, 6);
    },
    reschedule: async (appointmentId, slotId) => {
      const [startsAt, practitionerId] = slotId.split('|');
      const r = await http.post<{ appointment?: ApiAppointment }>(o(`/wellness/appointments/${appointmentId}/reschedule`), { startsAt, practitionerId });
      const lid = r.appointment?.locationId ?? [...inScope({ industry: 'wellness', role: role(), scopeId: 'all' })][0]!;
      return httpApi.wellness.day({ industry: 'wellness', role: role(), scopeId: `loc:${lid}` });
    },
  },

  commerce: {
    orders: async (ctx) => {
      const scope = inScope(ctx);
      return (await http.get<{ items: ApiCommerceOrder[] }>(o('/commerce/orders')).then(items)).filter((x) => scope.has(x.locationId)).map(commerceView);
    },
    refund: async (orderId, lineIds) => {
      const order = await http.get<ApiCommerceOrder>(o(`/commerce/orders/${orderId}`)).then((r) => ((r as unknown as { order?: ApiCommerceOrder }).order ?? r));
      const amountMinor = order.lines.reduce((s, l, i) => (lineIds.includes(`${orderId}:${i}`) ? s + l.unitPriceMinor * l.quantity : s), 0);
      await http.post(o(`/commerce/orders/${orderId}/refunds`), { amountMinor, reason: 'Partial refund from BranchHarbor' });
      const fresh = await http.get<ApiCommerceOrder>(o(`/commerce/orders/${orderId}`)).then((r) => ((r as unknown as { order?: ApiCommerceOrder }).order ?? r));
      return commerceView(fresh);
    },
  },

  foods: {
    menu: (_ctx, view) => menuView(view),
    resetMenuField: async (view, itemId) => {
      await http.put(o(`/foods/locations/${view}/overrides/${itemId}`), { priceMinor: null });
      return menuView(view);
    },
    orders: async (ctx) => {
      const scope = inScope(ctx);
      // Unpaid orders can't be accepted (the API refuses) and aren't shown to staff, as in the kitchen view.
      return (await http.get<{ items: ApiFoodOrder[] }>(o('/foods/orders')).then(items)).filter((x) => scope.has(x.locationId) && x.paymentStatus === 'paid').map(foodView);
    },
    setOrderStatus: async (id, status, reason) => {
      if (status === 'rejected' && !reason?.trim()) throw new ApiError('validation_error', 'Give a reason for rejecting.', 422, { reason: 'Required' });
      const r = await http.post<{ order: ApiFoodOrder }>(o(`/foods/orders/${id}/transition`), { to: status, note: reason || undefined });
      return foodView(r.order);
    },
    kitchen: async (ctx) => {
      const lid = [...inScope(ctx)][0];
      if (!lid) throw new ApiError('not_found', 'No location in this scope.', 404);
      const l = locationById(lid);
      const r = await http.get<{ items: ApiFoodOrder[]; refreshedAt: string }>(o('/foods/orders'), { locationId: lid, active: true });
      return { locationId: lid, locationName: l?.name ?? '', timeZone: tzOf(lid), connected: true, lastRefreshed: r.refreshedAt, orders: r.items.filter((x) => x.paymentStatus === 'paid').map(foodView) };
    },
  },

  websites: {
    page: (_ctx, locationId) => pageView(locationId),
    saveField: async (loc, key, value) => {
      const id = await homePageId(loc);
      const r = await http.patch<{ results: { key: string; result: string }[]; page: ApiPage }>(o(`/pages/${id}/fields`), { fields: { [key]: value } });
      return pageView(loc, r.page);
    },
    requestChange: async (loc, key, value, reason) => {
      if (!reason.trim()) throw new ApiError('validation_error', 'Add a reason for headquarters.', 422, { reason: 'Add a reason for headquarters.' });
      const id = await homePageId(loc);
      const r = await http.patch<{ page: ApiPage }>(o(`/pages/${id}/fields`), { fields: { [key]: value }, comment: reason });
      return pageView(loc, r.page);
    },
    decide: async (loc, key, decision, comment) => {
      const id = await homePageId(loc);
      const p = await http.get<ApiPage>(o(`/pages/${id}`));
      const f = p.fields.find((x) => x.key === key);
      if (!f?.pendingApprovalId) throw new ApiError('not_found', 'There is no pending change for this field.', 404);
      await http.post(o(`/approvals/${f.pendingApprovalId}/decision`), { decision, comment: comment || undefined });
      return pageView(loc);
    },
    resetField: async (loc, key) => {
      const id = await homePageId(loc);
      await http.post(o(`/pages/${id}/fields/${encodeURIComponent(key)}/reset`));
      return pageView(loc);
    },
    approvals: async (ctx) => {
      const scope = inScope(ctx);
      const list = (await http.get<{ items: ApiApproval[] }>(o('/approvals')).then(items)).filter((a) => (a.targetType === 'field' || a.targetType === 'page') && (!a.locationId || scope.has(a.locationId)));
      const labels = new Map<string, string>();
      return Promise.all(
        list.map(async (a): Promise<ApprovalItem> => {
          let field = a.payload?.fieldKey ? humanise(a.payload.fieldKey) : a.targetType === 'page' ? 'Whole page' : humanise(a.targetType);
          if (a.payload?.pageId && a.payload.fieldKey) {
            const k = `${a.payload.pageId}:${a.payload.fieldKey}`;
            if (!labels.has(k)) {
              const p = await maybe(http.get<ApiPage>(o(`/pages/${a.payload.pageId}`)), null);
              p?.fields.forEach((f) => labels.set(`${p.id}:${f.key}`, f.label));
            }
            field = labels.get(k) ?? field;
          }
          return { id: a.id, locationName: nameOfLoc(a.locationId), field, value: str(a.payload?.value), reason: a.requestComment ?? '—', requestedBy: await personName(a.requestedBy), at: a.createdAt };
        }),
      );
    },
    publishPlan: async (ctx) => {
      const scope = inScope(ctx);
      const w = ws();
      const sites = w.websites.filter((s) => s.locationId && scope.has(s.locationId));
      const targets = await Promise.all(
        sites.map(async (s) => {
          const lid = s.locationId!;
          const l = locationById(lid);
          const page = await maybe(homePageId(lid).then((id) => http.get<ApiPage>(o(`/pages/${id}`))), null);
          return {
            locationId: lid,
            locationName: l?.name ?? lid,
            changedPages: page ? [page.title || 'Home'] : [],
            excludedOverrides: (page?.fields ?? []).filter((f) => f.origin === 'local' || f.isOverridden).map((f) => `${f.label} (local override kept)`),
            warnings: [...(s.status !== 'live' ? ['Site not public yet — changes will be staged only'] : []), ...(l?.sync === 'attention' ? ['A connection at this location needs attention'] : []), ...(!page ? ['No home page found'] : [])],
            result: 'pending' as const,
          };
        }),
      );
      plan = { id: 'home', title: 'Publish the home page to every location in scope', version: 1, targets };
      return structuredClone(plan);
    },
    publish: async () => {
      if (!plan) throw new ApiError('not_found', 'Review the publish plan first.', 404);
      const j = await http.post<ApiJob>(o('/publish-jobs'), { pageSlug: 'home', locationIds: plan.targets.map((t) => t.locationId) });
      applyJob(j);
      await refreshWorkspace();
      return structuredClone(plan);
    },
    retry: async () => {
      if (!plan?.jobId) throw new ApiError('not_found', 'Nothing to retry.', 404);
      const j = await http.post<ApiJob>(o(`/publish-jobs/${plan.jobId}/retry`));
      applyJob(j);
      return structuredClone(plan);
    },
    sites: async (ctx) => {
      const scope = inScope(ctx);
      const w = ws();
      const domains = await maybe(http.get<{ items: ApiDomain[] }>(o('/domains')).then(items), [] as ApiDomain[]);
      return w.locations
        .filter((l) => scope.has(l.id))
        .map((l): SiteAddress => {
          const site = w.websites.find((s) => s.locationId === l.id);
          const d = domains.find((x) => x.locationId === l.id && x.isPrimary) ?? domains.find((x) => x.locationId === l.id);
          return { locationId: l.id, locationName: l.name, includedAddress: site?.includedAddress ?? null, custom: d ? { host: d.hostname, state: d.state } : null, live: l.site === 'live' };
        });
    },
  },

  payments: {
    transactions: async (ctx) => {
      const scope = inScope(ctx);
      return (await http.get<{ items: ApiPayment[] }>(o('/payments'), { limit: 200 }).then(items)).filter((p) => !p.locationId || scope.has(p.locationId)).map(txView);
    },
    reconciliation: (ctx) => reconciliationView(ctx),
    recreateOrder: async (itemId) => {
      const before = (await reconciliationView({ industry: 'studios', role: role(), scopeId: 'all' })).find((x) => x.id === itemId);
      const r = await http.post<{ fulfilled: boolean; note?: string; targetId?: string }>(o(`/payments/${itemId}/recreate-record`), {});
      const base = before ?? ({ id: itemId, type: 'paid_without_record', summary: '', transactionRef: '—', amount: m(0, 'USD'), locationId: '', customer: '—', orderState: '', status: 'needs_action', timeline: [] } as ReconciliationItem);
      return { ...base, status: 'resolved', orderState: 'Record recreated', resolution: r.note ?? 'Record recreated and linked to the payment.', timeline: [...base.timeline, { at: now(), text: r.note ?? 'Record recreated from the payment snapshot', tone: 'success', icon: 'check' }] };
    },
    refund: async (itemId, confirm) => {
      const before = (await reconciliationView({ industry: 'studios', role: role(), scopeId: 'all' })).find((x) => x.id === itemId);
      if (before && (before.amount.amount !== confirm.amount || before.amount.currency !== confirm.currency)) throw new ApiError('confirmation_mismatch', 'The confirmed amount doesn’t match. Nothing was refunded.', 409);
      await http.post(o(`/payments/${itemId}/refunds`), { amountMinor: confirm.amount, confirmCurrency: confirm.currency, reason: 'Reconciliation: paid without a record' });
      const base = before!;
      return { ...base, status: 'resolved', resolution: 'Payment refunded in full.', timeline: [...base.timeline, { at: now(), text: 'Refund requested', tone: 'warning', icon: 'undo' }] };
    },
    accounts: async (ctx) => {
      const scope = inScope(ctx);
      const r = await http.get<{ mode: string; provider: string; providerMode: string; locations: { id: string; currency: Currency; accountId: string | null; paymentsEnabled: boolean }[] }>(o('/payments/connect/status'));
      return r.locations.filter((l) => scope.has(l.id)).map((l): PaymentAccount => ({
        locationId: l.id,
        provider: `Stripe Connect${r.providerMode === 'sandbox' ? ' (sandbox)' : ''}`,
        arrangement: r.mode === 'per_location' ? 'own' : 'shared',
        status: l.paymentsEnabled ? 'enabled' : l.accountId ? 'pending_verification' : 'not_set_up',
        capabilities: l.paymentsEnabled ? ['Card payments', 'Refunds'] : [],
      }));
    },
  },

  connections: {
    list: async (ctx) => {
      const scope = inScope(ctx);
      return (await http.get<{ items: ApiConnection[] }>(o('/connections')).then(items)).filter((c) => !c.locationId || scope.has(c.locationId)).map(connectionView);
    },
    fix: async (id) => {
      const list = await http.get<{ items: ApiConnection[] }>(o('/connections')).then(items);
      const c = list.find((x) => x.id === id);
      if (!c) throw new ApiError('not_found', 'Connection not found.', 404);
      if (c.state === 'degraded' || c.state === 'connected') await http.post(o(`/connections/${id}/sync`));
      else await http.post(o(`/connections/${id}/test`));
      const fresh = (await http.get<{ items: ApiConnection[] }>(o('/connections')).then(items)).find((x) => x.id === id) ?? c;
      void refreshWorkspace();
      return connectionView(fresh);
    },
  },

  team: {
    members: async () => {
      memberCache = null;
      const [list, invites] = await Promise.all([members(), maybe(http.get<{ items: { id: string; email: string; role: string; scope?: { kind: string; id: string }; scopeKind?: string; scopeId?: string; createdAt: string; expiresAt?: string; status?: string }[] }>(o('/invitations')).then(items), [])]);
      const out: Member[] = list.map((x) => ({
        id: x.user.id, name: x.user.name, email: x.user.email,
        assignments: x.assignments.map((a) => ({ role: ROLE_LABEL[a.role] ?? humanise(a.role), scopeLabel: scopeLabel(a.scope) })),
        lastActive: `Member since ${fmtDate(x.assignments[0]?.createdAt)}`,
        status: 'active',
      }));
      for (const i of invites.filter((v) => !v.status || v.status === 'pending')) {
        const sc = i.scope ?? { kind: i.scopeKind ?? 'organization', id: i.scopeId ?? '' };
        out.push({ id: i.id, name: i.email, email: i.email, assignments: [{ role: ROLE_LABEL[i.role] ?? humanise(i.role), scopeLabel: scopeLabel(sc) }], lastActive: `Invitation sent ${fmtDate(i.createdAt)}`, status: 'invited' });
      }
      return out;
    },
    schedule: async (ctx, weekStart) => {
      const scope = inScope(ctx);
      const from = new Date(`${weekStart}T00:00:00Z`).getTime() - 14 * 3600_000;
      const list = await http.get<{ items: ApiShift[] }>(o('/shifts'), { from: new Date(from).toISOString(), to: new Date(from + 8 * 86400_000).toISOString() }).then(items);
      return list.filter((x) => scope.has(x.locationId)).map((x): ShiftView => ({
        id: x.id, locationId: x.locationId, locationName: x.location?.name ?? nameOfLoc(x.locationId), timeZone: x.location?.timeZone ?? tzOf(x.locationId), person: x.user.name, role: x.role,
        start: x.startsAt, end: x.endsAt, breakMinutes: x.breakMinutes, clockedInAt: x.clockedInAt, clockedOutAt: x.clockedOutAt,
        pendingSwap: x.pendingSwap ? { to: x.pendingSwap.toUser.name, approvalId: x.pendingSwap.approvalId } : null,
      }));
    },
    invite: async (input) => {
      const s = input.scopeId === 'all' ? { kind: 'organization', id: orgId() } : apiScope(input.scopeId);
      await http.post(o('/invitations'), { email: input.email, role: (input.roleKey ?? 'staff') as Role, scope: s });
      return { id: `inv_${Date.now()}`, name: input.email, email: input.email, assignments: [{ role: input.role, scopeLabel: input.scopeLabel }], lastActive: 'Invitation sent just now', status: 'invited' };
    },
  },

  approvals: {
    list: async (ctx, status) => {
      const scope = inScope(ctx);
      const list = await http.get<{ items: ApiApprovalFull[] }>(o('/approvals'), { status: status === 'pending' ? 'pending' : 'all', limit: 200 }).then(items);
      return list.filter((a) => (!a.locationId || scope.has(a.locationId)) && (status === 'pending' ? a.status === 'pending' : a.status !== 'pending')).map(approvalView);
    },
    decide: async (id, decision, comment) => approvalView(await http.post<ApiApprovalFull>(o(`/approvals/${id}/decision`), { decision, comment: comment || undefined })),
  },

  reports: async (ctx) => {
    const r = await report(ctx);
    const short = (n: string) => n.split(' – ').pop()!;
    const out: Report[] = [];
    const fresh = (f: ApiMetric<unknown>['freshness']) => `${f.source}${f.lastSyncAt ? ` · synced ${new Date(f.lastSyncAt).toISOString().slice(11, 16)} UTC` : ''}`;
    const currencies = [...new Set(r.revenueByLocation.map((x) => x.currency))];
    for (const cur of currencies) {
      const locs = r.revenueByLocation.filter((x) => x.currency === cur);
      out.push({
        id: `rev_${cur}`, title: `Revenue · ${cur} · 30 days`, freshness: fresh(r.metrics.revenue.freshness), unit: 'money', currency: cur,
        bars: locs.map((x) => {
          const row = x.revenue.find((v) => v.currency === cur);
          return { label: short(x.name), value: row ? row.netMinor : locationById(x.locationId)?.site === 'live' || row ? 0 : null };
        }),
        note: locs.some((x) => !x.revenue.length) ? 'Missing bars are Unavailable or Not connected — never zero. Refunds are excluded (net).' : 'Net of refunds.',
      });
    }
    out.push({ id: 'cmb', title: 'Combined revenue', freshness: 'Not calculated', unit: 'money', bars: [], note: r.metrics.combinedRevenue.unavailableReason ?? (currencies.length > 1 ? `Not shown: no conversion method is defined for ${currencies.join(' + ')}.` : 'Only one currency in this scope.') });
    const single = (id: string, title: string, mt: ApiMetric<number>, unit: Report['unit'], scale = 1) =>
      out.push({ id, title, freshness: fresh(mt.freshness), stale: !mt.freshness.complete, unit, bars: [{ label: `${r.scope.locationCount} locations`, value: mt.value == null ? null : Math.round(mt.value * scale) }], note: mt.unavailableReason ?? mt.definition });
    single('leads', 'Enquiries · 30 days', r.metrics.leads, 'count');
    const ind = ws().orgView?.industry;
    if (ind === 'studios') single('occ', 'Occupancy', r.metrics.occupancy, 'percent', 100);
    if (ind === 'wellness') single('appts', 'Appointments', r.metrics.appointments, 'count');
    return out;
  },

  settings: {
    get: async () => {
      const w = ws();
      const org = await http.get<NonNullable<typeof w.org>>(o());
      const sub = await maybe(http.get<{ plan: string; status: string; currency: Currency; currentPeriodEnd: string | null; billedLocationCount: number; pricePerLocation: (Money & { interval: string }) | null; locations?: { id: string; billed: boolean }[] }>(o('/subscription')), null);
      const policies = (org as { policies?: { customerDataSharing?: OrgSettings['customerSharing']; aiTrainingOptOut?: boolean } }).policies;
      return {
        businessName: org.name, legalName: org.name, defaultLocale: org.defaultLocale, defaultCurrency: org.defaultCurrency, defaultTimeZone: org.defaultTimeZone, dataRegion: org.dataRegion,
        customerSharing: policies?.customerDataSharing ?? 'off', aiTraining: policies ? policies.aiTrainingOptOut === false : false,
        billing: {
          plan: sub ? `${humanise(sub.plan)} · ${sub.status}` : 'Not available',
          perLocation: sub?.pricePerLocation ? m(sub.pricePerLocation.amount, sub.pricePerLocation.currency) : null,
          locations: w.locations.map((l) => {
            const billed = sub?.locations?.find((x) => x.id === l.id)?.billed;
            return { locationId: l.id, status: (billed ?? l.site === 'live') ? 'billed' : 'not_billed_until_published' };
          }),
          nextInvoice: sub?.currentPeriodEnd?.slice(0, 10) ?? null,
        },
      } satisfies OrgSettings;
    },
    save: async (ctx, input) => {
      await http.patch(o(), { name: input.businessName, defaultCurrency: input.defaultCurrency, defaultLocale: input.defaultLocale, defaultTimeZone: input.defaultTimeZone, dataRegion: input.dataRegion, customerDataSharing: input.customerSharing, aiTrainingOptOut: input.aiTraining === undefined ? undefined : !input.aiTraining });
      await refreshWorkspace();
      return httpApi.settings.get(ctx);
    },
  },

  onboarding: {
    get: async () => {
      const w = workspace() ?? (await loadWorkspace());
      if (!w.org)
        // New account: start from a blank business (never the sample organisation's details).
        return (
          localDraft() ?? {
            done: ['account'], skipped: [], current: 'industry', savedAt: now(),
            data: {
              biz: { name: '', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: w.user.locale || 'en', dataRegion: 'us' },
              loc: { name: '', code: '', ownerGroup: 'Company-owned', line1: '', city: '', region: '', postalCode: '', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', phone: '', email: '', hours: '', template: 'Standard location', overrides: { hours: true, prices: true, offers: true, images: false, staff: true } },
              items: [], invites: [],
            },
          }
        );
      const r = await http.get<ApiOnboarding>(o('/onboarding'));
      const rev = Object.fromEntries(Object.entries(STEP_MAP).map(([k, v]) => [v, k as OnboardingStep]));
      const done = r.steps.filter((s) => s.status === 'complete').map((s) => rev[s.key]!).filter(Boolean);
      const skipped = r.steps.filter((s) => s.status === 'skipped').map((s) => rev[s.key]!).filter(Boolean);
      const withDraft = [...r.steps].filter((s) => s.data && 'draft' in s.data).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
      const draft = (withDraft?.data?.draft as { current?: OnboardingStep; data?: Record<string, unknown> } | undefined) ?? undefined;
      const current = draft?.current ?? ONBOARDING_STEPS.find((s) => !done.includes(s) && !skipped.includes(s)) ?? 'publish';
      lastOnboarding = { done, skipped, current, savedAt: withDraft?.updatedAt ?? now(), data: draft?.data ?? (await draftFromOrg()) };
      return lastOnboarding;
    },
    save: async (p) => {
      const saved = { ...p, savedAt: now() };
      saveLocalDraft(saved);
      await ensureOrgFromDraft(saved);
      if (!workspace()?.org) return saved;
      await ensureFirstLocation(saved);
      const prev = lastOnboarding;
      const changed = ONBOARDING_STEPS.filter((s) => (p.done.includes(s) && !prev?.done.includes(s)) || (p.skipped.includes(s) && !prev?.skipped.includes(s) && !p.done.includes(s)));
      for (const s of changed) {
        const status = p.done.includes(s) ? 'complete' : 'skipped';
        if (status === 'skipped' && !OPTIONAL_API_STEPS.includes(STEP_MAP[s])) continue;
        await http.put(o(`/onboarding/${STEP_MAP[s]}`), { status });
      }
      const cur = p.done.includes(p.current) ? 'complete' : 'in_progress';
      await http.put(o(`/onboarding/${STEP_MAP[p.current]}`), { status: cur, data: { draft: { current: p.current, data: p.data } } });
      lastOnboarding = saved;
      return saved;
    },
    validateImport: async (csv) => {
      const lines = csv.trim().split(/\r?\n/);
      const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
      const rename: Record<string, string> = { timezone: 'time_zone', address: 'address_line1', line1: 'address_line1', state: 'state_region', region_name: 'region' };
      const apiHeader = header.map((h) => rename[h] ?? h);
      const add = ['address_line1', 'city'].filter((h) => !apiHeader.includes(h));
      const apiCsv = [[...apiHeader, ...add].join(','), ...lines.slice(1).map((l) => (add.length ? `${l}${','.repeat(add.length)}` : l))].join('\n');
      const r = await http.post<{ errors: { row: number; field: string; message: string }[] }>(o('/locations/import'), { csv: apiCsv, dryRun: true });
      const col = (name: string) => header.indexOf(name);
      const fieldOf = (f: string) => (f === 'time_zone' ? 'timeZone' : f === 'address_line1' ? 'address' : f);
      return lines.slice(1).filter(Boolean).map((line, i): ImportRow => {
        const c = line.split(',').map((x) => x.trim());
        const row = i + 2;
        return {
          row, name: c[col('name')] ?? '', code: c[col('code')] ?? '', country: (c[col('country')] ?? '').toUpperCase(), timeZone: c[col('timezone')] ?? c[col('time_zone')] ?? '', currency: (c[col('currency')] ?? '').toUpperCase(),
          errors: r.errors.filter((e) => e.row === row).map((e) => ({ field: fieldOf(e.field), message: e.message })),
        };
      });
    },
    domain: async (hostname) => {
      const existing = await findDomain(hostname);
      if (existing) return domainView(existing);
      const site = ws().websites[0];
      if (!site) throw new ApiError('not_found', 'Create a hosted website before connecting a domain.', 404);
      const d = await http.post<ApiDomain>(o('/domains'), { hostname, websiteId: site.id });
      return domainView(d);
    },
    verifyDomain: async (hostname) => {
      const d = await findDomain(hostname);
      if (!d) throw new ApiError('not_found', 'Add the domain first.', 404);
      const r = await http.post<ApiDomain | { domain: ApiDomain }>(o(`/domains/${d.id}/verify`));
      return domainView('domain' in r ? r.domain : r);
    },
  },

  ai: {
    suggestions: async (ctx) => AI_SUGGESTIONS[ws().orgView?.industry ?? ctx.industry],
    ask: async (ctx, question) => {
      const status = await http.get<{ available: boolean; message?: string }>(o('/ai/status'));
      if (!status.available) throw new ApiError('ai_unavailable', status.message ?? 'BranchHarbor AI is unavailable right now. Everything else keeps working.', 503);
      const scope = apiScope(ctx.scopeId, effectiveRole(ctx.role));
      const conv = await http.post<{ id: string }>(o('/ai/conversations'), { scope, title: question.slice(0, 120) });
      const r = await http.post<{ reply: string; scope: { label?: string }; sources: string[]; proposedActions: { id: string; kind: string; summary: string; scopeKind: string; scopeId: string }[] }>(o(`/ai/conversations/${conv.id}/messages`), { content: question });
      const a = r.proposedActions[0];
      const kind: NonNullable<AiAnswer['action']>['kind'] = a?.kind.includes('campaign') ? 'draft' : a?.kind.includes('page') ? 'publish' : 'draft';
      return {
        id: conv.id, question, answer: r.reply, assumptions: r.scope?.label ? `Scope: ${r.scope.label}.` : undefined,
        sources: r.sources.map((s) => ({ label: s, freshness: 'Live' })),
        action: a ? { id: a.id, title: a.summary, kind, affected: [scopeLabel({ kind: a.scopeKind, id: a.scopeId })], excluded: [], requires: kind === 'publish' ? 'website.publish' : 'marketing.draft' } : undefined,
      };
    },
  },
};

