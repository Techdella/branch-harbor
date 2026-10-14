import type { Currency, Money, Permission, RoleAssignment } from '@bh/shared';
import type { IconName } from '@bh/icons';
import type { Tone } from '@bh/ui';

/** The verticals demonstrated in the business app (realty: Real Estate, release "next"). */
export const APP_INDUSTRIES = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty'] as const;
export type IndustryKey = (typeof APP_INDUSTRIES)[number];

/** "Viewing as" personas used to demonstrate permission states. */
export const VIEW_ROLES = ['hq', 'local', 'staff'] as const;
export type ViewRole = (typeof VIEW_ROLES)[number];

export interface RequestContext {
  industry: IndustryKey;
  scopeId: string;
  role: ViewRole;
  /** Business mode of the selected organisation (absent = network). */
  business?: 'independent' | 'network';
}

export interface Session {
  user: { id: string; name: string; email: string; initials: string };
  role: ViewRole;
  assignments: RoleAssignment[];
  /** Location IDs this persona is assigned to (empty = whole organisation). */
  locationIds: string[];
}

export interface Region {
  id: string;
  name: string;
}
export interface OwnerGroup {
  id: string;
  name: string;
}

export interface Organization {
  id: string;
  name: string;
  brand: string;
  industry: IndustryKey;
  sample: boolean;
  defaultCurrency: Currency;
  defaultTimeZone: string;
  defaultLocale: string;
  dataRegion: 'us' | 'eu' | 'apac';
  regions: Region[];
  ownerGroups: OwnerGroup[];
  /** Business mode (spec §6–§7). Absent = network. Read it through `useBusinessMode()`. */
  model?: 'independent' | 'network';
}

export interface Address {
  line1: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface Location {
  id: string;
  code: string;
  name: string;
  address: Address;
  regionId: string;
  ownerGroupId: string;
  ownership: 'company' | 'franchise';
  currency: Currency;
  timeZone: string;
  locale: string;
  phone: string;
  hours: string;
  template: string;
  site: 'live' | 'unpublished';
  sync: 'ok' | 'attention';
  pastel: string;
}

export interface ScopeOptionT {
  id: string;
  kind: 'all' | 'region' | 'owner_group' | 'location';
  label: string;
  locationIds: string[];
}

/** A metric value. `null` means Unavailable — never a fabricated zero. */
export type MetricValue =
  | { kind: 'count'; value: number; unit?: string }
  | { kind: 'percent'; value: number }
  | { kind: 'money'; values: Money[] }
  | { kind: 'ratio'; value: number; of: number };

export interface Metric {
  key: string;
  label: string;
  definition: string;
  range: string;
  source: string;
  icon: IconName;
  pastel: string;
  state: 'ok' | 'unavailable' | 'not_connected';
  value: MetricValue | null;
  note?: string;
}

export interface UpcomingItem {
  id: string;
  at: string; // ISO UTC
  timeZone: string;
  title: string;
  detail: string;
  status: { label: string; tone: Tone };
}

export interface AttentionItem {
  id: string;
  icon: IconName;
  title: string;
  detail: string;
  href: string;
  kind: 'action' | 'integration' | 'info';
}

export interface Overview {
  metrics: Metric[];
  upcomingTitle: string;
  upcoming: UpcomingItem[];
  attention: AttentionItem[];
  aiPrompt: string;
}

/* ---------- Generic tables ---------- */
export type Cell =
  | { t: 'text'; v: string; sub?: string; strong?: boolean }
  | { t: 'badge'; v: string; tone: Tone; icon?: IconName }
  | { t: 'money'; v: Money; sub?: string }
  | { t: 'origin'; v: 'hq' | 'local' | 'locked' | 'approval' }
  | { t: 'unavailable'; reason?: string };

export interface TableData {
  key: string;
  description?: string;
  columns: { key: string; label: string; align?: 'left' | 'right' }[];
  rows: { id: string; tags: string[]; cells: Record<string, Cell> }[];
  filters: { key: string; label: string }[];
  source: string;
  primaryAction?: string;
}

/* ---------- Studios ---------- */
export interface ClassOccurrence {
  id: string;
  name: string;
  instructor: string;
  locationId: string;
  room: string;
  start: string; // ISO UTC
  minutes: number;
  booked: number;
  capacity: number;
  waitlist: number;
  source: 'BranchHarbor' | 'Booking connection';
  coverRequested?: boolean;
  pastel: string;
}

export interface CoverCandidate {
  id: string;
  name: string;
  note: string;
  available: boolean;
  state: 'notified' | 'accepted' | 'assigned' | 'unavailable';
}

export interface CoverRequest {
  id: string;
  classId: string;
  className: string;
  start: string;
  timeZone: string;
  locationName: string;
  requestedBy: string;
  reason: string;
  bookedCustomers: number;
  status: 'open' | 'accepted' | 'confirmed';
  candidates: CoverCandidate[];
  history: { at: string; text: string }[];
}

/* ---------- Sports ---------- */
export interface Registration {
  id: string;
  participant: string;
  age: number;
  programme: string;
  guardian: string;
  guardianVerified: boolean;
  payment: { label: string; amount?: Money; tone: Tone };
  formsComplete: boolean;
  formsNote: string;
  status: 'awaiting_review' | 'accepted' | 'waitlisted' | 'withdrawn';
  groupId?: string;
}
export interface SportsGroup {
  id: string;
  name: string;
  roster: number;
  capacity: number;
}
export interface AttendanceSession {
  id: string;
  group: string;
  start: string;
  timeZone: string;
  venue: string;
  coach: string;
  roster: { id: string; name: string }[];
  submitted: boolean;
}

/* ---------- Wellness ---------- */
export interface Appointment {
  id: string;
  service: string;
  client: string;
  practitionerId: string;
  room: string;
  start: string;
  minutes: number;
  status: 'confirmed' | 'deposit_paid' | 'cancelled';
}
export interface Practitioner {
  id: string;
  name: string;
  pastel: string;
}
export interface WellnessDay {
  date: string; // YYYY-MM-DD in location tz
  locationId: string;
  timeZone: string;
  slots: string[]; // HH:mm local
  practitioners: Practitioner[];
  rooms: string[];
  appointments: Appointment[];
}
export interface RescheduleSlot {
  id: string;
  start: string;
  practitioner: string;
  room: string;
}

/* ---------- Commerce ---------- */
export interface OrderLine {
  id: string;
  name: string;
  qty: number;
  unit: Money;
  refunded: boolean;
}
export interface CommerceOrder {
  id: string;
  number: string;
  customer: string;
  locationId: string;
  source: string;
  placedAt: string;
  lines: OrderLine[];
  total: Money;
  tax: { label: string; amount: Money | null };
  payment: 'succeeded' | 'failed' | 'processing' | 'not_imported';
  refund: 'none' | 'pending' | 'partial' | 'complete' | 'failed';
  fulfilment: 'to_fulfil' | 'fulfilled' | 'on_hold' | 'store_disconnected';
  timeline: TimelineEvent[];
}

/* ---------- Foods ---------- */
export interface MenuField {
  key: 'price' | 'dietary' | 'modifiers' | 'availability';
  label: string;
  value: string;
  money?: Money;
  origin: 'hq' | 'inherited' | 'local';
  resettable: boolean;
}
export interface MenuItem {
  id: string;
  name: string;
  image: string;
  status: 'published' | 'draft' | 'partial_failure';
  statusNote?: string;
  fields: MenuField[];
}
export type FoodOrderStatus = 'awaiting_acceptance' | 'accepted' | 'preparing' | 'ready' | 'collected' | 'cancelled' | 'rejected';
export interface FoodOrder {
  id: string;
  number: string;
  customerFirstName: string;
  locationId: string;
  pickupAt: string;
  placedAt: string;
  total: Money;
  paid: boolean;
  status: FoodOrderStatus;
  items: { name: string; qty: number; modifiers: string[] }[];
  notes?: string;
}
export interface KitchenFeed {
  locationId: string;
  locationName: string;
  timeZone: string;
  connected: boolean;
  lastRefreshed: string;
  orders: FoodOrder[];
}

/* ---------- Websites ---------- */
export type FieldPolicy = 'locked' | 'editable' | 'approval';
export interface WebsiteField {
  key: string;
  label: string;
  policy: FieldPolicy;
  value: string;
  hqValue?: string;
  pending?: { value: string; reason: string; requestedBy: string; at: string };
}
export interface WebsitePage {
  locationId: string;
  locationName: string;
  page: string;
  version: number;
  fields: WebsiteField[];
  activity: { at: string; text: string }[];
}
export interface ApprovalItem {
  id: string;
  locationName: string;
  field: string;
  value: string;
  reason: string;
  requestedBy: string;
  at: string;
}
export interface PublishTarget {
  locationId: string;
  locationName: string;
  changedPages: string[];
  excludedOverrides: string[];
  warnings: string[];
  result: 'pending' | 'publishing' | 'published' | 'failed';
  error?: string;
}
export interface GroupPublish {
  id: string;
  title: string;
  version: number;
  targets: PublishTarget[];
}

/* ---------- Payments ---------- */
export type PaymentState = 'created' | 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'cancelled';
export type RefundState = 'none' | 'requested' | 'pending' | 'partial' | 'complete' | 'failed';
export interface TimelineEvent {
  at: string;
  text: string;
  tone: Tone;
  icon: IconName;
}
export interface Transaction {
  id: string;
  externalRef: string;
  createdAt: string;
  description: string;
  locationId: string;
  amount: Money;
  payment: PaymentState;
  refund: RefundState;
  provider: string;
  linkedRecord?: string;
  timeline: TimelineEvent[];
}
export interface ReconciliationItem {
  id: string;
  type: 'paid_without_record' | 'unpaid_confirmed' | 'amount_mismatch';
  summary: string;
  transactionRef: string;
  amount: Money;
  locationId: string;
  customer: string;
  orderState: string;
  status: 'needs_action' | 'reviewing' | 'resolved';
  resolution?: string;
  timeline: TimelineEvent[];
}
export interface PaymentAccount {
  locationId: string;
  provider: string;
  arrangement: 'own' | 'shared';
  status: 'enabled' | 'pending_verification' | 'not_set_up';
  capabilities: string[];
}

/* ---------- Connections ---------- */
export type ConnectionState = 'connected' | 'initial_sync' | 'degraded' | 'disconnected' | 'authorization_expired';
export interface Connection {
  id: string;
  name: string;
  monogram: string;
  role: string;
  state: ConnectionState;
  lastSync: string | null;
  progress?: number;
  direction: 'import' | 'export' | 'bidirectional';
  authoritative: string;
  locations: string[];
  issue?: string;
  affected?: string;
  fixAction?: string;
}

/* ---------- Team ---------- */
export interface Member {
  id: string;
  name: string;
  email: string;
  assignments: { role: string; scopeLabel: string }[];
  lastActive: string;
  status: 'active' | 'invited' | 'support';
  note?: string;
}

/* ---------- Reports ---------- */
export interface ReportBar {
  label: string;
  value: number | null;
  display?: string;
}
export interface Report {
  id: string;
  title: string;
  freshness: string;
  stale?: boolean;
  unit: 'count' | 'percent' | 'money';
  currency?: Currency;
  bars: ReportBar[];
  note: string;
}

/* ---------- Settings ---------- */
export interface OrgSettings {
  businessName: string;
  legalName: string;
  defaultLocale: string;
  defaultCurrency: Currency;
  defaultTimeZone: string;
  dataRegion: 'us' | 'eu' | 'apac';
  customerSharing: 'off' | 'totals_only' | 'shared';
  aiTraining: boolean;
  /** `perLocation`/`nextInvoice` are null when the billing provider doesn't report them. */
  billing: { plan: string; perLocation: Money | null; locations: { locationId: string; status: 'billed' | 'not_billed_until_published' }[]; nextInvoice: string | null };
}

/* ---------- Onboarding ---------- */
export const ONBOARDING_STEPS = ['account', 'industry', 'business', 'location', 'website', 'data', 'connect', 'team', 'publish'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export interface OnboardingProgress {
  done: OnboardingStep[];
  skipped: OnboardingStep[];
  current: OnboardingStep;
  savedAt: string;
  data: Record<string, unknown>;
}
export interface ImportRow {
  row: number;
  name: string;
  code: string;
  country: string;
  timeZone: string;
  currency: string;
  errors: { field: string; message: string }[];
}
export type DomainState = 'awaiting_dns' | 'verifying' | 'certificate_pending' | 'ready' | 'failed';
export interface DomainStatus {
  hostname: string;
  state: DomainState;
  records: { type: 'TXT' | 'CNAME'; name: string; value: string; found: boolean }[];
  message?: string;
}

/* ---------- AI ---------- */
export interface AiProposedAction {
  id: string;
  title: string;
  kind: 'draft' | 'publish' | 'send' | 'refund';
  affected: string[];
  excluded: string[];
  requires: Permission;
}
export interface AiAnswer {
  id: string;
  question: string;
  answer: string;
  assumptions?: string;
  sources: { label: string; freshness: string }[];
  action?: AiProposedAction;
}

/* ---------- Team schedule (shifts + time clock) ---------- */
export interface ShiftView {
  id: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  person: string;
  role: string;
  start: string;
  end: string;
  breakMinutes: number;
  clockedInAt: string | null;
  clockedOutAt: string | null;
  /** Pending swap awaiting a manager, if any. */
  pendingSwap: { to: string; approvalId: string | null } | null;
}

/* ---------- Approvals inbox (all kinds) ---------- */
export type ApprovalKind = 'refund' | 'ad_spend' | 'shift_swap' | 'field' | 'page';
export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'executing';
  locationName: string;
  amount: Money | null;
  requestedBy: string;
  requestedAt: string;
  reason: string | null;
  /** Kind-specific facts shown before deciding (channel, duration, who swaps with whom, field value…). */
  details: { label: string; value: string }[];
  canDecide: boolean;
  decidedBy: string | null;
  decisionComment: string | null;
  /** What ran on approval (e.g. "Refund complete"). */
  result: string | null;
}
