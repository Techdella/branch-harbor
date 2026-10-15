import type { Money, Currency, RoleAssignment } from '@bh/shared';
import type { foodOrderStates } from '@bh/shared';

export type { Money, Currency };
export type Experience = 'customer' | 'staff' | 'owner';
export type FoodOrderStatus = (typeof foodOrderStates)[number];

export interface Me {
  user: { id: string; name: string; email: string | null; avatar?: string };
  assignments: RoleAssignment[];
  /** Experiences this person holds (from their capabilities in the active business account). */
  experiences: Experience[];
  /** Business accounts with team access (account switcher; one industry each). */
  accounts?: { id: string; name: string; industry: string }[];
  /** The active business account for the Staff and Owner experiences. */
  accountId?: string | null;
  guest?: boolean;
  /** Owner of a single independent business (one location): no location switching or aggregation. */
  business?: { model: 'independent'; name: string; locationId: string | null };
}

export interface Brand {
  id: string;
  name: string;
  industry: 'studios' | 'foods';
  tagline: string;
  hero: string;
  offer: string;
}

export interface TaxConfig {
  label: string;
  /** Basis points, e.g. 1025 = 10.25%. Configured by the business — never assumed. */
  rateBps: number;
  inclusive: boolean;
}

export interface Location {
  id: string;
  brandId: string;
  name: string;
  city: string;
  country: string; // ISO 3166-1 alpha-2
  timeZone: string; // IANA
  currency: Currency;
  address: string;
  status: 'operating' | 'opening_soon';
  image: string;
  tax: TaxConfig | null;
  cancellationHours: number;
}

export interface ClassOccurrence {
  id: string;
  locationId: string;
  name: string;
  instructor: string;
  room: string;
  startsAt: string; // UTC ISO
  durationMin: number;
  capacity: number;
  booked: number;
  price: Money;
  image: string;
}

export type BookingStatus = 'held' | 'confirmed' | 'waitlisted' | 'cancelled' | 'attended';
export interface Booking {
  id: string;
  occurrenceId: string;
  className: string;
  instructor: string;
  locationId: string;
  startsAt: string;
  durationMin: number;
  status: BookingStatus;
  price: Money;
  holdExpiresAt?: string;
  waitlistPosition?: number;
}

export interface ModifierOption {
  id: string;
  name: string;
  price: Money;
  soldOut?: boolean;
}
export interface ModifierGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  options: ModifierOption[];
}
export interface MenuItem {
  id: string;
  category: string;
  name: string;
  description: string;
  price: Money;
  image: string;
  soldOut?: boolean;
  /** Supplied by the business, shown verbatim. */
  dietary: string[];
  modifierGroups: ModifierGroup[];
}
export interface PickupSlot {
  id: string;
  startsAt: string;
  remaining: number;
}
export interface OrderLineInput {
  itemId: string;
  quantity: number;
  optionIds: string[];
}
export interface OrderLine {
  itemId: string;
  name: string;
  quantity: number;
  options: string[];
  lineTotal: Money;
}
export interface FoodOrder {
  id: string;
  number: string;
  locationId: string;
  status: FoodOrderStatus;
  pickupAt: string;
  lines: OrderLine[];
  subtotal: Money;
  tax: Money | null;
  taxLabel: string | null;
  taxInclusive: boolean;
  total: Money;
  customerName: string;
  notes?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  locationId: string;
  from: 'customer' | 'location' | 'system';
  kind?: 'reminder' | 'offer' | 'message';
  author: string;
  body: string;
  at: string;
}

export type Channel = 'push' | 'email' | 'sms';
export interface Preferences {
  locale: string;
  channels: Record<Channel, { reminders: boolean; marketing: boolean }>;
}

export interface DataRequest {
  id: string;
  kind: 'export' | 'delete';
  status: 'received';
  reference: string;
}

export interface PaymentIntentParams {
  clientSecret: string;
  amount: Money;
  merchantDisplayName: string;
  customerId?: string;
  ephemeralKey?: string;
  /** BranchHarbor payment id (polled until the signed webhook marks it paid). */
  paymentId?: string;
  /** From the API: publishable key + connected account for direct charges (PaymentSheet `stripeAccountId`). */
  publishableKey?: string | null;
  stripeAccountId?: string | null;
  merchantCountry?: string | null;
  /** The API runs payments in sandbox mode: simulate instead of opening the sheet. */
  sandbox?: boolean;
}

// ---------- Staff ----------
export interface Shift {
  id: string;
  locationId: string;
  role: string;
  startsAt: string;
  endsAt: string;
  clockedInAt?: string;
  clockedOutAt?: string;
  /** Present when the location is not in the customer catalogue (e.g. another organisation). */
  locationName?: string;
  timeZone?: string;
  organizationName?: string;
}
export interface StaffSession {
  id: string;
  locationId: string;
  name: string;
  room: string;
  startsAt: string;
  durationMin: number;
  rosterCount: number;
}
export type AttendanceStatus = 'unmarked' | 'present' | 'absent';
/** Contact and guardian details are intentionally absent from the staff roster payload. */
export interface RosterEntry {
  id: string;
  displayName: string;
  note: string;
  status: AttendanceStatus;
}
export interface KitchenOrder {
  id: string;
  number: string;
  firstName: string;
  status: FoodOrderStatus;
  promisedAt: string;
  createdAt: string;
  notes?: string;
  lines: { quantity: number; name: string; options: string[] }[];
}
export interface StaffMessage {
  id: string;
  author: string;
  role: 'HQ' | 'Owner' | 'Team' | 'System';
  body: string;
  at: string;
  avatar?: string;
}
export interface CoverRequest {
  id: string;
  sessionName: string;
  locationId: string;
  startsAt: string;
  requestedBy: string;
  mine: boolean;
  status: 'open' | 'accepted_pending_manager' | 'approved';
}

// ---------- Owner / HQ ----------
export interface PulseLocation {
  locationId: string;
  name: string;
  city: string;
  country: string;
  currency: Currency;
  timeZone: string;
  /** null = Unavailable (never shown as 0). */
  sales: Money | null;
  bookings: number | null;
  occupancyPct: number | null;
  orders: number | null;
  source: string;
  sync: 'healthy' | 'degraded' | 'not_connected';
}
export interface Pulse {
  /** Independent business: the pulse is its one location (no aggregation or location list). */
  singleLocation?: { businessName: string };
  scopeLabel: string;
  range: string;
  locations: PulseLocation[];
  updatedAt: string;
}
export type ApprovalKind = 'ad_spend' | 'refund' | 'shift_swap' | 'website';
export interface Approval {
  id: string;
  kind: ApprovalKind;
  title: string;
  locationId: string;
  locationName: string;
  requestedBy: string;
  requestedAt: string;
  amount?: Money;
  channel?: string;
  days?: number;
  reason?: string;
  swap?: { a: string; b: string; session: string };
  status: 'pending' | 'approved' | 'rejected';
}
export interface AppNotification {
  id: string;
  kind: 'info' | 'action' | 'integration';
  title: string;
  body: string;
  at: string;
  locationName?: string;
}
