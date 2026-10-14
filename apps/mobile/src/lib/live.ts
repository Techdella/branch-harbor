/**
 * Live adapters: map the app's screen-level calls onto the real apps/api routes and adapt the
 * responses into the app's types (src/lib/types.ts). See apps/mobile/README.md for the mapping.
 *
 * Ids the API needs more context for are composed client-side:
 *   class occurrence  `${locationId}~${occurrenceId}`   (public schedule is per location)
 *   staff session     `${orgId}~${occurrenceId}`
 *   kitchen order     `${orgId}~${orderId}`
 *   cover request     `${orgId}~${coverRequestId}`
 *   approval          `${orgId}~website~${approvalId}` | `${orgId}~cover~${coverRequestId}`
 */
import { Platform } from 'react-native';
import { paymentView, waitForPayment } from './cardPayment.shared';
import { ROLE_PERMISSIONS, type Permission, type Role, type RoleAssignment } from '@bh/shared';
import { BRANDS, IMG } from '@/mock/data';
import { env } from './env';
import { ApiError } from './errors';
import { currentLocale, tNow } from '@/i18n/current';
import { addDaysKey, localDateKey, zonedToUtcIso } from './format';
import { GUEST_TOKEN, http, refreshStore } from './http';
import { storage, tokenStore } from './storage';
import type {
  Approval, AppNotification, AttendanceStatus, Booking, Brand, ClassOccurrence, CoverRequest, DataRequest, Experience, FoodOrder,
  FoodOrderStatus, KitchenOrder, Location, Me, MenuItem, Message, Money, OrderLineInput, PaymentIntentParams, PickupSlot, Preferences,
  Pulse, PulseLocation, RosterEntry, Shift, StaffMessage, StaffSession, Currency,
} from './types';

// ───────────────────────── raw API shapes (subset) ─────────────────────────
interface RawUser { id: string; email: string; name: string; locale: string }
interface RawOrg { id: string; name: string; slug: string; industry: string; roles: { id: string; role: string; scope: { kind: string; id: string } }[]; model?: 'independent' | 'network'; primaryLocationId?: string | null }
interface RawMe { user: RawUser; organizations: RawOrg[] }
interface RawAddress { line1?: string; city?: string; region?: string; postalCode?: string; country?: string }
interface RawLocation { id: string; name: string; address: RawAddress; country: string; timeZone: string; currency: string; status: string; organizationId?: string; publiclyVisible?: boolean }
interface RawScheduleItem {
  id: string; classType: { id: string; name: string; description: string | null }; startsAt: string; endsAt: string; instructorName: string | null; room: string | null;
  online: boolean; capacity: number; spotsLeft: number; price: Money; status: 'available' | 'full' | 'unavailable' | 'cancelled'; action: 'book' | 'join_waitlist' | null;
}
interface RawPayment { id: string; clientSecret: string | null; amount?: number; currency?: string; sandbox: boolean }
type RawBookResult =
  | { outcome: 'confirmed' | 'held'; bookingId: string; manageToken: string; holdExpiresAt: string | null; payment: RawPayment | null }
  | { outcome: 'waitlisted'; waitlistEntryId: string; position: number; manageToken?: string };
interface RawFoodOrder {
  id: string; orderNumber: string; locationId: string; status: FoodOrderStatus; paymentStatus: string;
  lines: { menuItemId: string; name: string; quantity: number; unitPriceMinor: number; modifiers: { id: string; name: string }[]; lineTotalMinor: number; notes?: string }[];
  subtotal: Money; tax: Money; total: Money; promisedAt: string | null; notes: string | null; contact: { name: string }; createdAt: string;
}
interface RawMyBooking {
  id: string; kind: 'booking' | 'waitlist'; status: string; holdExpiresAt: string | null; waitlistPosition: number | null; occurrenceId: string; className: string;
  instructorName: string | null; startsAt: string; durationMinutes: number; price: Money; location: { id: string };
}
interface RawOccurrence { id: string; locationId: string; startsAt: string; endsAt: string; classTypeName: string; room: string | null; booked: number; instructorUserId: string | null }
interface RawCover { id: string; locationId: string; occurrenceId: string; requestedBy: string; status: string; substituteName: string | null; reason: string | null; createdAt: string }
interface RawApproval { id: string; locationId: string | null; targetType: string; payload: Record<string, unknown>; status: string; requestedBy: string; requestComment: string | null; createdAt: string }
interface RawApprovalFull {
  id: string; kind: 'refund' | 'ad_spend' | 'shift_swap' | 'field' | 'page'; title: string; locationId: string | null; location: { name: string } | null; amount: Money | null;
  payload: Record<string, unknown> | null; requester: { id: string; name: string | null }; requestComment: string | null; createdAt: string; canDecide: boolean;
}
interface RawShift {
  id: string; organizationId: string; locationId: string; location: { id: string; name: string; timeZone: string } | null; role: string; startsAt: string; endsAt: string;
  clockedInAt: string | null; clockedOutAt: string | null; organizationName?: string | null;
}
const CHANNEL: Record<string, string> = { google_ads: 'Google Ads', meta_ads: 'Meta (Instagram/Facebook)', local_print: 'Local print', other: 'Other' };
/** Shift ids carry the organisation and location so clock-in/out can address the right org: orgId~shiftId~locationId. */
const toShift = (x: RawShift): Shift => ({
  id: `${x.organizationId}~${x.id}~${x.locationId}`, locationId: x.locationId, role: x.role, startsAt: x.startsAt, endsAt: x.endsAt,
  clockedInAt: x.clockedInAt ?? undefined, clockedOutAt: x.clockedOutAt ?? undefined, locationName: x.location?.name, timeZone: x.location?.timeZone, organizationName: x.organizationName ?? undefined,
});
interface RawMetric<T> { value: T | null; unavailableReason: string | null; freshness: { source: string; complete: boolean } }
interface RawOverview {
  metrics: {
    revenue: RawMetric<{ currency: string; netMinor: number }[]>; classBookings: RawMetric<number>; occupancy: RawMetric<number>; foodOrders: RawMetric<Record<string, number>>;
  };
  connections: { id: string; provider: string; state: string; lastSuccessAt: string | null }[];
}

// ───────────────────────── session-scoped caches ─────────────────────────
let meCache: RawMe | null = null;
let mePromise: Promise<RawMe> | null = null;
type LocIndex = Map<string, { loc: Location; orgId: string | null; isPublic: boolean }>;
let locIndex: LocIndex | null = null;
let brandCache: Brand[] | null = null;
let catalogPromise: Promise<{ index: LocIndex; brands: Brand[] }> | null = null;
const bookingState = new Map<string, { booking: Booking; payment: RawPayment | null; manageToken?: string; merchant: string }>();
const orderPayments = new Map<string, { payment: RawPayment | null; merchant: string; total: Money }>();

export function resetLiveCaches() {
  meCache = null;
  mePromise = null;
  locIndex = null;
  brandCache = null;
  catalogPromise = null;
  bookingState.clear();
  orderPayments.clear();
}

const isGuest = async () => {
  const t = await tokenStore.get();
  return !t || t === GUEST_TOKEN;
};

async function rawMe(): Promise<RawMe | null> {
  if (await isGuest()) return null;
  if (meCache) return meCache;
  mePromise ??= http<RawMe>('GET', '/auth/me').finally(() => {
    mePromise = null;
  });
  meCache = await mePromise;
  return meCache;
}

const has = (org: RawOrg, p: Permission) => org.roles.some((r) => (ROLE_PERMISSIONS[r.role as Role] ?? []).includes(p));
const staffOrgs = (m: RawMe | null) => (m?.organizations ?? []).filter((o) => has(o, 'operations.read'));
const ownerOrgs = (m: RawMe | null) => (m?.organizations ?? []).filter((o) => has(o, 'reports.read') || has(o, 'website.approve'));

function toMe(m: RawMe): Me {
  const experiences: Experience[] = ['customer'];
  if (staffOrgs(m).length) experiences.push('staff');
  if (ownerOrgs(m).length) experiences.push('owner');
  const assignments: RoleAssignment[] = m.organizations.flatMap((o) => o.roles.map((r) => ({ role: r.role as Role, scope: { kind: r.scope.kind as RoleAssignment['scope']['kind'], id: r.scope.id } })));
  // An owner whose only business is independent (one location) gets the single-business owner experience.
  const owned = ownerOrgs(m);
  const single = owned.length === 1 && owned[0]!.model === 'independent' ? owned[0]! : null;
  return {
    user: { id: m.user.id, name: m.user.name, email: m.user.email }, assignments, experiences,
    ...(single ? { business: { model: 'independent' as const, name: single.name, locationId: single.primaryLocationId ?? null } } : {}),
  };
}

const guestMe = (): Me => ({ user: { id: 'guest', name: 'Guest', email: null }, assignments: [], experiences: ['customer'], guest: true });

const notSupported = (what: string): never => {
  throw new ApiError(501, 'not_available', `${what} isn’t available from the BranchHarbor API yet.`);
};
const split = (composite: string, parts: number) => {
  const p = decodeURIComponent(composite).split('~');
  if (p.length !== parts || p.some((x) => !x)) throw new ApiError(404, 'not_found', 'Not found');
  return p;
};

// ───────────────────────── guest contact + remembered references ─────────────────────────
export interface GuestContact { name: string; email: string; phone?: string }
const K = { contact: 'bh.guest.contact', bookings: 'bh.live.bookings', orders: 'bh.live.orders' };
async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await storage.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const writeJson = (key: string, v: unknown) => storage.set(key, JSON.stringify(v));

export const guestContact = {
  get: () => readJson<GuestContact | null>(K.contact, null),
  set: (c: GuestContact) => writeJson(K.contact, c),
};

/** Contact sent with public bookings/orders: the account for signed-in users, the saved guest contact otherwise. */
async function contactFor(extra?: Partial<GuestContact>): Promise<GuestContact> {
  const m = await rawMe();
  if (m) return { name: extra?.name?.trim() || m.user.name, email: m.user.email, phone: extra?.phone };
  const saved = await guestContact.get();
  const c = { name: extra?.name?.trim() || saved?.name || '', email: extra?.email?.trim() || saved?.email || '', phone: extra?.phone || saved?.phone };
  if (!c.name || !/\S+@\S+\.\S+/.test(c.email)) {
    throw new ApiError(400, 'contact_required', 'Add your name and email so the business can send your confirmation.', {
      ...(!c.name ? { name: 'Required' } : {}), ...(!/\S+@\S+\.\S+/.test(c.email) ? { email: 'Enter a valid email address.' } : {}),
    });
  }
  if (!m) await guestContact.set(c);
  return c;
}

// Guests have no account to list from, so the app remembers what this device booked/ordered (with manage tokens).
type StoredBooking = Booking & { manageToken?: string };
const rememberBooking = async (b: StoredBooking) => {
  const list = await readJson<StoredBooking[]>(K.bookings, []);
  await writeJson(K.bookings, [b, ...list.filter((x) => x.id !== b.id)].slice(0, 50));
};
const rememberOrder = async (id: string, token: string) => {
  const list = await readJson<{ id: string; token: string }[]>(K.orders, []);
  await writeJson(K.orders, [{ id, token }, ...list.filter((x) => x.id !== id)].slice(0, 30));
};

// ───────────────────────── brands + locations ─────────────────────────
const STUDIO_IMAGES = [IMG.yogaStudio, IMG.yogaStretch, IMG.yogaFloor, IMG.yogaRoom, IMG.yogaHands, IMG.yogaMeditate];
const FOOD_IMAGES = [IMG.foodChef, IMG.foodCook, IMG.foodOven, IMG.foodPizza, IMG.foodTomato];
const CLASS_IMAGES = [IMG.yogaPink, IMG.yogaMeditate, IMG.yogaStretch, IMG.yogaFloor, IMG.yogaRed];
const pick = (list: string[], key: string) => list[[...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % list.length]!;
const industryOf = (i: string): Brand['industry'] => (i === 'foods' ? 'foods' : 'studios');

/** Presentation copy the API doesn't model yet (tagline, hero, offer) comes from the sample brand of the same industry. */
function brandFrom(org: { slug: string; name: string; industry: string }): Brand {
  const industry = industryOf(org.industry);
  const sample = BRANDS.find((b) => b.industry === industry)!;
  return { id: org.slug, name: org.name, industry, tagline: sample.tagline, hero: sample.hero, offer: sample.offer };
}

function toLocation(l: RawLocation, brand: Brand): Location {
  const a = l.address ?? {};
  return {
    id: l.id, brandId: brand.id, name: l.name, city: a.city ?? '', country: l.country, timeZone: l.timeZone, currency: l.currency as Currency,
    address: [a.line1, a.city, a.region].filter(Boolean).join(', '),
    status: l.status === 'operating' ? 'operating' : 'opening_soon',
    image: pick(brand.industry === 'foods' ? FOOD_IMAGES : STUDIO_IMAGES, l.id),
    // Tax is applied by the server quote (business-configured); cancellation windows are not modelled by the API yet.
    tax: null,
    cancellationHours: brand.industry === 'foods' ? 0 : 12,
  };
}

/** Brands + locations, loaded once per session (single-flight: screens mount in parallel). */
function loadCatalog(): Promise<{ index: LocIndex; brands: Brand[] }> {
  if (locIndex && brandCache) return Promise.resolve({ index: locIndex, brands: brandCache });
  const p = catalogPromise ?? fetchCatalog().finally(() => {
    catalogPromise = null;
  });
  catalogPromise = p;
  return p;
}

async function fetchCatalog(): Promise<{ index: LocIndex; brands: Brand[] }> {
  const index: LocIndex = new Map();
  const brands = new Map<string, Brand>();
  const publicResults = await Promise.all(env.brandSlugs.map((slug) =>
    http<{ organization: { name: string; slug: string; industry: string }; items: RawLocation[] }>('GET', `/public/locations/${encodeURIComponent(slug)}`, undefined, { auth: false })
      .catch((e: ApiError) => (e.status === 404 ? null : Promise.reject(e)))));
  for (const r of publicResults) {
    if (!r) continue;
    const brand = brandFrom(r.organization);
    brands.set(brand.id, brand);
    for (const l of r.items) index.set(l.id, { loc: toLocation(l, brand), orgId: null, isPublic: true });
  }
  const m = await rawMe().catch(() => null);
  for (const org of m?.organizations ?? []) {
    const brand = brands.get(org.slug) ?? brandFrom(org);
    brands.set(brand.id, brand);
    const res = await http<{ items: RawLocation[] }>('GET', `/orgs/${org.id}/locations`).catch(() => ({ items: [] as RawLocation[] }));
    for (const l of res.items) {
      const prev = index.get(l.id);
      index.set(l.id, { loc: prev?.loc ?? toLocation(l, brand), orgId: org.id, isPublic: prev?.isPublic ?? !!l.publiclyVisible });
    }
    // Public locations of the user's own organisations also belong to that organisation.
    for (const [id, v] of index) if (v.loc.brandId === org.slug && !v.orgId) index.set(id, { ...v, orgId: org.id });
  }
  locIndex = index;
  brandCache = [...brands.values()];
  return { index, brands: brandCache };
}

const locationById = async (id: string) => (await loadCatalog()).index.get(id);
const orgForLocation = async (id: string) => {
  const v = await locationById(id);
  if (!v?.orgId) throw new ApiError(403, 'forbidden', 'You don’t have access to this location.');
  return v.orgId;
};
const merchantFor = async (locationId: string) => {
  const v = await locationById(locationId);
  const b = brandCache?.find((x) => x.id === v?.loc.brandId);
  return `${b?.name ?? 'BranchHarbor'}${v ? ` ${v.loc.name}` : ''}`;
};

// ───────────────────────── studios (customer) ─────────────────────────
async function schedule(locationId: string, from: string, to: string) {
  return http<{ location: { timeZone: string }; items: RawScheduleItem[] }>('GET', `/public/studios/${locationId}/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, { auth: false });
}

function toOccurrence(locationId: string, i: RawScheduleItem): ClassOccurrence {
  return {
    id: `${locationId}~${i.id}`, locationId, name: i.classType.name, instructor: i.instructorName ?? '', room: i.room ?? (i.online ? 'Online' : ''),
    startsAt: i.startsAt, durationMin: Math.round((Date.parse(i.endsAt) - Date.parse(i.startsAt)) / 60_000), capacity: i.capacity,
    // "unavailable" (payments not enabled) and "cancelled" classes cannot be booked: present them as full.
    booked: i.status === 'available' ? i.capacity - i.spotsLeft : i.capacity, price: i.price, image: pick(CLASS_IMAGES, i.classType.name),
  };
}

function bookingFromResult(o: ClassOccurrence, r: RawBookResult): Booking {
  const base = { occurrenceId: o.id, className: o.name, instructor: o.instructor, locationId: o.locationId, startsAt: o.startsAt, durationMin: o.durationMin, price: o.price };
  if (r.outcome === 'waitlisted') return { ...base, id: `wl:${r.waitlistEntryId}`, status: 'waitlisted', waitlistPosition: r.position };
  return { ...base, id: r.bookingId, status: r.outcome, holdExpiresAt: r.holdExpiresAt ?? undefined };
}

function toMyBooking(b: RawMyBooking): Booking {
  const status: Booking['status'] = b.kind === 'waitlist' ? 'waitlisted' : b.status === 'attended' ? 'attended' : b.status === 'held' ? 'held' : b.status === 'confirmed' ? 'confirmed' : 'cancelled';
  return {
    id: b.kind === 'waitlist' ? `wl:${b.id}` : b.id, occurrenceId: `${b.location.id}~${b.occurrenceId}`, className: b.className, instructor: b.instructorName ?? '',
    locationId: b.location.id, startsAt: b.startsAt, durationMin: b.durationMinutes, status, price: b.price,
    holdExpiresAt: b.holdExpiresAt ?? undefined, waitlistPosition: b.waitlistPosition ?? undefined,
  };
}

/** Wait for the API to mark a payment succeeded (signed webhook); never trust the device's own result. */
async function serverConfirmed(paymentId: string) {
  const r = await waitForPayment(paymentId, (k) => (k === 'pay.pending' ? 'Your payment is being processed. We’ll confirm it shortly — you won’t be charged twice.' : 'The payment didn’t go through. You weren’t charged.'));
  if (!r.ok) throw new ApiError(r.pending ? 202 : 402, r.pending ? 'payment_processing' : 'payment_failed', r.message);
}

async function sandboxConfirm(payment: RawPayment) {
  return http<{ outcome: Record<string, unknown>; payment: { state: string } }>('POST', `/public/payments/${payment.id}/sandbox-confirm`, { outcome: 'succeeded' }, { auth: false });
}

// ───────────────────────── foods (customer) ─────────────────────────
interface RawMenuItem {
  id: string; category: string; name: string; description: string | null; dietary: string[]; allergens: string[]; imageUrl: string | null; price: Money | null;
  available: boolean; unavailableReason: string | null;
  modifierGroups: { id: string; name: string; minSelect: number; maxSelect: number; modifiers: { id: string; name: string; price: Money | null; available: boolean }[] }[];
}

function toFoodOrder(o: RawFoodOrder): FoodOrder {
  const cur = o.total.currency;
  return {
    id: o.id, number: o.orderNumber, locationId: o.locationId, status: o.status, pickupAt: o.promisedAt ?? o.createdAt,
    lines: o.lines.map((l) => ({ itemId: l.menuItemId, name: l.name, quantity: l.quantity, options: l.modifiers.map((m) => m.name), lineTotal: { amount: l.lineTotalMinor, currency: cur } })),
    subtotal: o.subtotal, tax: o.tax.amount > 0 ? o.tax : null, taxLabel: o.tax.amount > 0 ? tNow('order.tax', 'Tax') : null, taxInclusive: false, total: o.total,
    customerName: o.contact.name, notes: o.notes ?? undefined, createdAt: o.createdAt,
  };
}

// ───────────────────────── staff ─────────────────────────
function localDayRange() {
  // Explicit locale: some runtimes report a default locale Intl rejects (e.g. en-US@posix).
  const tz = new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone;
  const today = localDateKey(new Date(), tz);
  return { from: zonedToUtcIso(today, '00:00', tz), to: zonedToUtcIso(addDaysKey(today, 1), '00:00', tz) };
}

const firstNameInitial = (name: string) => {
  const [first, last] = name.trim().split(/\s+/);
  return last ? `${first} ${last[0]}.` : first ?? name;
};

function toKitchenOrder(orgId: string, o: RawFoodOrder): KitchenOrder {
  const lineNotes = o.lines.map((l) => l.notes).filter(Boolean);
  return {
    id: `${orgId}~${o.id}`, number: o.orderNumber, firstName: o.contact.name.trim().split(/\s+/)[0] ?? '', status: o.status, promisedAt: o.promisedAt ?? o.createdAt, createdAt: o.createdAt,
    notes: [o.notes, ...lineNotes].filter(Boolean).join(' · ') || undefined,
    lines: o.lines.map((l) => ({ quantity: l.quantity, name: l.name, options: l.modifiers.map((m) => m.name) })),
  };
}

async function occurrencesFor(orgId: string, from: string, to: string) {
  return (await http<{ items: RawOccurrence[] }>('GET', `/orgs/${orgId}/studios/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).items;
}

async function memberNames(orgId: string): Promise<Map<string, string>> {
  try {
    const r = await http<{ items: { userId?: string; user?: { id: string; name: string } }[] }>('GET', `/orgs/${orgId}/members`);
    return new Map(r.items.flatMap((m) => (m.user ? [[m.user.id, m.user.name] as [string, string]] : [])));
  } catch {
    return new Map();
  }
}

function coverStatus(s: string): CoverRequest['status'] | null {
  if (s === 'open') return 'open';
  if (s === 'accepted') return 'accepted_pending_manager';
  if (s === 'approved') return 'approved';
  return null;
}

// ───────────────────────── owner ─────────────────────────
const sumCounts = (v: Record<string, number> | null) => (v ? Object.values(v).reduce((a, n) => a + n, 0) : null);

// ───────────────────────── the client ─────────────────────────
export const liveApi = {
  // auth
  async signIn(email: string, password: string) {
    resetLiveCaches();
    const r = await http<{ accessToken: string; refreshToken?: string }>('POST', '/auth/login', { email, password }, { auth: false });
    await tokenStore.set(r.accessToken);
    if (r.refreshToken) await refreshStore.set(r.refreshToken);
    const m = await rawMe();
    return { token: r.accessToken, me: toMe(m!) };
  },
  async guest() {
    resetLiveCaches();
    await refreshStore.clear();
    return { token: GUEST_TOKEN, me: guestMe() };
  },
  async me(): Promise<Me> {
    meCache = null;
    const m = await rawMe();
    return m ? toMe(m) : guestMe();
  },
  async signOut() {
    const refreshToken = await refreshStore.get();
    const pushToken = await storage.get('bh.pushToken');
    if (pushToken && !(await isGuest())) await http('DELETE', '/me/push-tokens', { token: pushToken }).catch(() => undefined);
    if (refreshToken) await http('POST', '/auth/logout', { refreshToken }, { auth: false }).catch(() => undefined);
    await refreshStore.clear();
    resetLiveCaches();
  },
  /** Register this device's Expo push token (call after obtaining it from expo-notifications). */
  async registerPushToken(token: string) {
    if (await isGuest()) return;
    await http('POST', '/me/push-tokens', { token, platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web', appVersion: env.appVersion });
    await storage.set('bh.pushToken', token);
  },

  // customer catalogue
  async brands(): Promise<Brand[]> {
    return (await loadCatalog()).brands;
  },
  async locations(brandId?: string): Promise<Location[]> {
    const all = [...(await loadCatalog()).index.values()].map((v) => v.loc);
    return brandId ? all.filter((l) => l.brandId === brandId) : all;
  },

  // studios
  async classes(locationId: string, date: string): Promise<ClassOccurrence[]> {
    const tz = (await locationById(locationId))?.loc.timeZone ?? 'UTC';
    const r = await schedule(locationId, zonedToUtcIso(date, '00:00', tz), zonedToUtcIso(addDaysKey(date, 1), '00:00', tz));
    return r.items.filter((i) => i.status !== 'cancelled').map((i) => toOccurrence(locationId, i));
  },
  async occurrence(id: string): Promise<ClassOccurrence> {
    const [locationId, occId] = split(id, 2) as [string, string];
    const r = await schedule(locationId, new Date(Date.now() - 12 * 3600_000).toISOString(), new Date(Date.now() + 60 * 86400_000).toISOString());
    const item = r.items.find((i) => i.id === occId);
    if (!item) throw new ApiError(404, 'not_found', 'This class is no longer on the schedule.');
    return toOccurrence(locationId, item);
  },
  async holdBooking(occurrenceId: string, contact?: Partial<GuestContact>): Promise<Booking> {
    const o = await liveApi.occurrence(occurrenceId);
    const [, occId] = split(occurrenceId, 2);
    const c = await contactFor(contact);
    const r = await http<RawBookResult>('POST', `/public/studios/occurrences/${occId}/bookings`, { contact: { name: c.name, email: c.email, phone: c.phone } }, { auth: false });
    const booking = bookingFromResult(o, r);
    const payment = r.outcome === 'waitlisted' ? null : r.payment;
    const manageToken = r.outcome === 'waitlisted' ? undefined : r.manageToken;
    bookingState.set(booking.id, { booking, payment, manageToken, merchant: await merchantFor(o.locationId) });
    if (await isGuest()) await rememberBooking({ ...booking, manageToken });
    return booking;
  },
  async joinWaitlist(occurrenceId: string, contact?: Partial<GuestContact>): Promise<Booking> {
    const o = await liveApi.occurrence(occurrenceId);
    const [, occId] = split(occurrenceId, 2);
    const c = await contactFor(contact);
    const r = await http<RawBookResult>('POST', `/public/studios/occurrences/${occId}/bookings`, { contact: { name: c.name, email: c.email, phone: c.phone }, joinWaitlist: true }, { auth: false });
    const booking = bookingFromResult(o, r);
    // The manage token lets a guest leave the waitlist later from this device.
    if (await isGuest()) await rememberBooking({ ...booking, manageToken: r.outcome === 'waitlisted' ? r.manageToken : undefined });
    return booking;
  },
  /**
   * The server confirms a held booking when the payment succeeds (signed Stripe webhook). With a
   * sandbox payment (no Stripe keys on the server) we ask the API to simulate that confirmation.
   */
  async confirmBooking(bookingId: string, paymentIntentId?: string): Promise<Booking> {
    const st = bookingState.get(bookingId);
    if (!st) throw new ApiError(404, 'not_found', 'Booking not found. Please start again.');
    if (st.booking.status === 'confirmed') return st.booking;
    if (st.booking.holdExpiresAt && Date.parse(st.booking.holdExpiresAt) < Date.now()) {
      throw new ApiError(409, 'hold_expired', 'Your hold expired and the spot was released. You weren’t charged.');
    }
    if (!paymentIntentId) {
      if (!st.payment?.sandbox) throw new ApiError(402, 'payment_required', 'Payment is required to confirm this booking.');
      const r = await sandboxConfirm(st.payment);
      if (r.payment.state !== 'succeeded') throw new ApiError(402, 'payment_failed', 'The payment didn’t go through. You weren’t charged.');
    } else if (st.payment) {
      // PaymentSheet finished: the booking is confirmed only once the API has the signed webhook.
      await serverConfirmed(st.payment.id);
    }
    const booking: Booking = { ...st.booking, status: 'confirmed', holdExpiresAt: undefined };
    bookingState.set(bookingId, { ...st, booking });
    if (await isGuest()) await rememberBooking({ ...booking, manageToken: st.manageToken });
    return booking;
  },
  async myBookings(): Promise<Booking[]> {
    if (await isGuest()) {
      const list = await readJson<StoredBooking[]>(K.bookings, []);
      return list.filter((b) => b.status !== 'held').map(({ manageToken: _t, ...b }) => b).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }
    const r = await http<{ items: RawMyBooking[] }>('GET', '/me/bookings');
    return r.items.map(toMyBooking).filter((b) => b.status !== 'held');
  },
  async cancelBooking(id: string): Promise<Booking> {
    if (id.startsWith('wl:')) return liveApi.leaveWaitlist(id);
    if (await isGuest()) {
      const list = await readJson<StoredBooking[]>(K.bookings, []);
      const b = list.find((x) => x.id === id);
      if (!b?.manageToken) throw new ApiError(404, 'not_found', 'Booking not found on this device.');
      await http('POST', `/public/studios/bookings/${id}/cancel`, { manageToken: b.manageToken }, { auth: false });
      const upd = { ...b, status: 'cancelled' as const };
      await rememberBooking(upd);
      const { manageToken: _t, ...rest } = upd;
      return rest;
    }
    await http('POST', `/me/bookings/${id}/cancel`);
    const mine = await liveApi.myBookings();
    return mine.find((b) => b.id === id) ?? notSupported('Booking');
  },

  /** Leave a class waitlist: signed in via /me, guests with the manage token kept on this device. */
  async leaveWaitlist(id: string): Promise<Booking> {
    const entryId = id.replace(/^wl:/, '');
    if (await isGuest()) {
      const list = await readJson<StoredBooking[]>(K.bookings, []);
      const b = list.find((x) => x.id === id);
      if (!b?.manageToken) throw new ApiError(404, 'not_found', 'This waitlist place was not joined on this device.');
      await http('POST', `/public/studios/waitlist/${entryId}/leave`, { manageToken: b.manageToken }, { auth: false });
      const upd = { ...b, status: 'cancelled' as const };
      await rememberBooking(upd);
      const { manageToken: _t, ...rest } = upd;
      return rest;
    }
    const before = (await liveApi.myBookings()).find((b) => b.id === id);
    await http('POST', `/me/waitlist/${entryId}/leave`);
    if (!before) throw new ApiError(404, 'not_found', 'Waitlist place not found.');
    return { ...before, status: 'cancelled', waitlistPosition: undefined };
  },

  // foods
  async menu(locationId: string): Promise<MenuItem[]> {
    const r = await http<{ location: { currency: Currency }; categories: { name: string; items: RawMenuItem[] }[] }>('GET', `/public/foods/${locationId}/menu`, undefined, { auth: false });
    const zero = (): Money => ({ amount: 0, currency: r.location.currency });
    return r.categories.flatMap((c) => c.items)
      // Items without a local price or not offered here are not on this location's menu; sold-out items stay visible.
      .filter((i) => i.price && i.unavailableReason !== 'Not offered at this location')
      .map((i) => ({
        id: i.id, category: i.category, name: i.name, description: i.description ?? '', price: i.price ?? zero(), image: i.imageUrl ?? pick(FOOD_IMAGES, i.name),
        soldOut: !i.available, dietary: i.dietary,
        modifierGroups: i.modifierGroups.map((g) => ({
          id: g.id, name: g.name, min: g.minSelect, max: g.maxSelect,
          options: g.modifiers.map((m) => ({ id: m.id, name: m.name, price: m.price ?? zero(), soldOut: !m.available })),
        })),
      }));
  },
  async pickupSlots(locationId: string, date: string): Promise<PickupSlot[]> {
    const tz = (await locationById(locationId))?.loc.timeZone ?? 'UTC';
    const from = new Date(Math.max(Date.now(), Date.parse(zonedToUtcIso(date, '00:00', tz)))).toISOString();
    const to = zonedToUtcIso(addDaysKey(date, 1), '00:00', tz);
    const r = await http<{ items: { id: string; startsAt: string; remaining: number; available: boolean; cutoffAt: string }[] }>(
      'GET', `/public/foods/${locationId}/pickup-slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, { auth: false });
    return r.items.filter((s) => Date.parse(s.cutoffAt) > Date.now()).map((s) => ({ id: s.id, startsAt: s.startsAt, remaining: s.available ? s.remaining : 0 }));
  },
  async quoteOrder(locationId: string, lines: OrderLineInput[]) {
    const r = await http<{ lines: { menuItemId: string; name: string; quantity: number; modifiers: string[]; lineTotal: Money }[]; subtotal: Money; tax: Money | null; taxRateBps: number | null; taxInclusive: boolean; total: Money }>(
      'POST', `/public/foods/${locationId}/quote`, { lines: lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifierIds: l.optionIds })) }, { auth: false });
    return {
      lines: r.lines.map((l) => ({ itemId: l.menuItemId, name: l.name, quantity: l.quantity, options: l.modifiers, lineTotal: l.lineTotal })),
      subtotal: r.subtotal, tax: r.tax,
      taxLabel: r.tax && r.taxRateBps ? `${tNow('order.tax', 'Tax')} ${new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 2 }).format(r.taxRateBps / 10000)}` : null,
      taxInclusive: r.taxInclusive, total: r.total,
    };
  },
  async placeOrder(body: { locationId: string; slotId: string; lines: OrderLineInput[]; name: string; phone: string; email?: string; notes?: string }): Promise<FoodOrder> {
    const c = await contactFor({ name: body.name, email: body.email, phone: body.phone });
    const r = await http<{ order: RawFoodOrder; manageToken: string; payment: RawPayment | null }>('POST', `/public/foods/${body.locationId}/orders`, {
      pickupSlotId: body.slotId, notes: body.notes,
      lines: body.lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, modifierIds: l.optionIds })),
      contact: { name: c.name, email: c.email, phone: c.phone || undefined },
    }, { auth: false });
    await rememberOrder(r.order.id, r.manageToken);
    const order = toFoodOrder(r.order);
    orderPayments.set(order.id, { payment: r.payment, merchant: await merchantFor(order.locationId), total: order.total });
    return order;
  },
  /** After a successful (or, in sandbox, simulated) payment. Without Stripe keys the API simulates the provider. */
  async confirmOrderPayment(orderId: string, paymentIntentId?: string) {
    const st = orderPayments.get(orderId);
    if (!st?.payment) return;
    if (paymentIntentId) { await serverConfirmed(st.payment.id); return; }
    if (!st.payment.sandbox) throw new ApiError(402, 'payment_required', 'Payment is required to send this order.');
    await sandboxConfirm(st.payment);
  },
  async order(id: string): Promise<FoodOrder> {
    const refs = await readJson<{ id: string; token: string }[]>(K.orders, []);
    const ref = refs.find((x) => x.id === id);
    if (ref) return toFoodOrder(await http<RawFoodOrder>('GET', `/public/foods/orders/${id}?token=${encodeURIComponent(ref.token)}`, undefined, { auth: false }));
    if (!(await isGuest())) {
      const mine = await http<{ items: RawFoodOrder[] }>('GET', '/me/food-orders');
      const o = mine.items.find((x) => x.id === id);
      if (o) return toFoodOrder(o);
    }
    throw new ApiError(404, 'not_found', 'Order not found.');
  },
  async myOrders(): Promise<FoodOrder[]> {
    if (!(await isGuest())) return (await http<{ items: RawFoodOrder[] }>('GET', '/me/food-orders')).items.map(toFoodOrder);
    const refs = await readJson<{ id: string; token: string }[]>(K.orders, []);
    const out = await Promise.all(refs.slice(0, 10).map((r) =>
      http<RawFoodOrder>('GET', `/public/foods/orders/${r.id}?token=${encodeURIComponent(r.token)}`, undefined, { auth: false }).then(toFoodOrder).catch(() => null)));
    return out.filter((o): o is FoodOrder => !!o);
  },
  async createPaymentIntent(body: { kind: 'booking' | 'order'; id: string }): Promise<PaymentIntentParams> {
    const st = body.kind === 'booking' ? bookingState.get(body.id) : orderPayments.get(body.id);
    if (!st?.payment?.clientSecret) throw new ApiError(409, 'payment_unavailable', body.kind === 'booking' ? 'Online payment isn’t available for this booking.' : 'Online payment isn’t available for this order.');
    // Publishable key + connected account (direct charge) come from the API for this payment; never a secret.
    const view = await paymentView(st.payment.id);
    const amount = 'booking' in st ? st.booking.price : st.total;
    return {
      clientSecret: st.payment.clientSecret, amount, merchantDisplayName: view.merchantDisplayName || st.merchant, paymentId: st.payment.id,
      publishableKey: view.publishableKey, stripeAccountId: view.stripeAccount, merchantCountry: view.merchantCountry, sandbox: view.mode === 'sandbox',
    };
  },

  // messages + preferences + privacy
  async messages(locationId: string): Promise<Message[]> {
    if (await isGuest()) throw new ApiError(401, 'sign_in_required', 'Sign in to message this location.');
    const r = await http<{ location: { name: string }; items: { id: string; locationId: string; direction: 'inbound' | 'outbound'; authorName: string | null; body: string; createdAt: string }[] }>('GET', `/me/messages?locationId=${locationId}`);
    return r.items.map((m): Message => ({
      id: m.id, locationId: m.locationId, from: m.direction === 'inbound' ? 'customer' : 'location', kind: 'message',
      author: m.direction === 'inbound' ? 'You' : m.authorName ?? r.location.name, body: m.body, at: m.createdAt,
    })).sort((a, b) => b.at.localeCompare(a.at));
  },
  async sendMessage(locationId: string, body: string): Promise<Message> {
    if (await isGuest()) throw new ApiError(401, 'sign_in_required', 'Sign in to message this location.');
    const m = await http<{ id: string; locationId: string; body: string; createdAt: string }>('POST', '/me/messages', { locationId, body });
    return { id: m.id, locationId: m.locationId, from: 'customer', kind: 'message', author: 'You', body: m.body, at: m.createdAt };
  },
  async preferences(): Promise<Preferences> {
    const local = await readJson<Preferences>('bh.prefs', {
      locale: 'en',
      channels: { push: { reminders: true, marketing: false }, email: { reminders: true, marketing: false }, sms: { reminders: false, marketing: false } },
    });
    if (await isGuest()) return local;
    const m = await rawMe();
    const c = await http<{ current: { purpose: string; granted: boolean }[] }>('GET', '/me/consents');
    const granted = (p: string) => c.current.find((x) => x.purpose === p)?.granted ?? false;
    return {
      locale: m?.user.locale ?? local.locale,
      // Push updates are transactional and on unless withdrawn (consent purpose push_updates).
      channels: { ...local.channels, push: { ...local.channels.push, reminders: c.current.find((x) => x.purpose === 'push_updates')?.granted ?? true }, email: { ...local.channels.email, marketing: granted('marketing_email') }, sms: { ...local.channels.sms, marketing: granted('marketing_sms') } },
    };
  },
  /** Marketing and push-update consent are recorded server-side (append-only); other reminder toggles stay on the device. */
  async savePreferences(p: Preferences): Promise<Preferences> {
    if (!(await isGuest())) {
      const before = await liveApi.preferences();
      const writes: Promise<unknown>[] = [];
      if (before.channels.email.marketing !== p.channels.email.marketing) writes.push(http('POST', '/me/consents', { purpose: 'marketing_email', granted: p.channels.email.marketing }));
      if (before.channels.sms.marketing !== p.channels.sms.marketing) writes.push(http('POST', '/me/consents', { purpose: 'marketing_sms', granted: p.channels.sms.marketing }));
      if (before.channels.push.reminders !== p.channels.push.reminders) writes.push(http('POST', '/me/consents', { purpose: 'push_updates', granted: p.channels.push.reminders }));
      if (before.locale !== p.locale) writes.push(http('PATCH', '/me', { locale: p.locale }));
      await Promise.all(writes);
      meCache = null;
    }
    await writeJson('bh.prefs', p);
    return p;
  },
  async dataRequest(kind: 'export' | 'delete'): Promise<DataRequest> {
    if (await isGuest()) throw new ApiError(401, 'sign_in_required', 'Sign in to request your data.');
    if (kind === 'delete') {
      throw new ApiError(400, 'password_required', 'Account deletion needs your password. Use Settings → Privacy in the BranchHarbor web app.');
    }
    const r = await http<{ exportedAt: string }>('GET', '/me/export');
    return { id: `export-${r.exportedAt}`, kind, status: 'received', reference: `EXP-${r.exportedAt.slice(0, 10)}` };
  },

  // staff
  async myShifts(): Promise<Shift[]> {
    // Today's shifts in the device's local day (plus anything still running), across every organisation.
    const { from, to } = localDayRange();
    const r = await http<{ items: RawShift[]; openClock: { organizationId: string; shiftId: string | null } | null }>('GET', `/me/shifts?from=${encodeURIComponent(new Date(Date.parse(from) - 12 * 3600_000).toISOString())}&to=${encodeURIComponent(to)}`);
    return r.items.filter((x) => Date.parse(x.endsAt) > Date.parse(from)).map(toShift);
  },
  async clockIn(shiftId: string): Promise<Shift> {
    const [orgId, id, locationId] = split(shiftId, 3);
    const r = await http<{ shift: RawShift }>('POST', `/orgs/${orgId}/time-clock/clock-in`, { locationId, shiftId: id, source: 'mobile' });
    return toShift(r.shift);
  },
  async clockOut(shiftId: string): Promise<Shift> {
    const [orgId] = split(shiftId, 3);
    const r = await http<{ shift: RawShift | null }>('POST', `/orgs/${orgId}/time-clock/clock-out`, { source: 'mobile' });
    if (!r.shift) throw new ApiError(409, 'not_clocked_in', 'You are not clocked in to this shift.');
    return toShift(r.shift);
  },
  async mySessions(): Promise<StaffSession[]> {
    const m = await rawMe();
    const { from, to } = localDayRange();
    const perOrg = await Promise.all(staffOrgs(m).filter((o) => industryOf(o.industry) === 'studios').map(async (o) => {
      const items = await occurrencesFor(o.id, from, to);
      // Instructors see their own classes; otherwise the classes at the locations the user is assigned to
      // (organisation-wide roles see every location they can access).
      const own = items.filter((i) => i.instructorUserId === m!.user.id);
      const assigned = new Set(o.roles.filter((r) => r.scope.kind === 'location').map((r) => r.scope.id));
      const atMine = assigned.size ? items.filter((i) => assigned.has(i.locationId)) : items;
      return (own.length ? own : atMine).map((i) => ({
        id: `${o.id}~${i.id}`, locationId: i.locationId, name: i.classTypeName, room: i.room ?? '', startsAt: i.startsAt,
        durationMin: Math.round((Date.parse(i.endsAt) - Date.parse(i.startsAt)) / 60_000), rosterCount: i.booked,
      }));
    }));
    return perOrg.flat().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  },
  async roster(sessionId: string): Promise<RosterEntry[]> {
    const [orgId, occId] = split(sessionId, 2);
    // Check-in roster: how each person booked (membership / pack / paid) and their check-in state.
    const r = await http<{ items: { bookingId: string; status: string; source: string; bookedWith: string; customer: { name: string } }[] }>('GET', `/orgs/${orgId}/studios/occurrences/${occId}/roster`);
    // Roster carries display names only (no contact details), first name + initial.
    return r.items.filter((a) => ['confirmed', 'attended', 'no_show'].includes(a.status)).map((a) => ({
      id: a.bookingId, displayName: firstNameInitial(a.customer.name),
      note: `${a.bookedWith}${a.source === 'waitlist' ? ' · from the waitlist' : ''}`,
      status: a.status === 'attended' ? 'present' : a.status === 'no_show' ? 'absent' : 'unmarked',
    }));
  },
  async markAttendance(sessionId: string, entryId: string, status: AttendanceStatus): Promise<RosterEntry> {
    const [orgId] = split(sessionId, 2);
    if (status === 'unmarked') notSupported('Clearing attendance');
    await http('POST', `/orgs/${orgId}/studios/bookings/${entryId}/attendance`, { status: status === 'present' ? 'attended' : 'no_show', source: 'instructor' });
    const list = await liveApi.roster(sessionId);
    return list.find((r) => r.id === entryId) ?? { id: entryId, displayName: '', note: '', status };
  },
  /** The kitchen screen's location: the first Foods location the user works at. */
  async kitchenLocationId(): Promise<string> {
    const m = await rawMe();
    const { index } = await loadCatalog();
    for (const o of staffOrgs(m).filter((x) => industryOf(x.industry) === 'foods')) {
      const scoped = o.roles.find((r) => r.scope.kind === 'location' && index.has(r.scope.id));
      if (scoped) return scoped.scope.id;
      const first = [...index.values()].find((v) => v.orgId === o.id && v.loc.status === 'operating');
      if (first) return first.loc.id;
    }
    throw new ApiError(404, 'not_found', 'No kitchen location is assigned to you.');
  },
  async kitchenOrders(locationId: string): Promise<KitchenOrder[]> {
    const orgId = await orgForLocation(locationId);
    const r = await http<{ items: RawFoodOrder[] }>('GET', `/orgs/${orgId}/foods/orders?locationId=${locationId}`);
    return r.items.map((o) => toKitchenOrder(orgId, o));
  },
  async setKitchenStatus(id: string, status: FoodOrderStatus): Promise<KitchenOrder> {
    const [orgId, orderId] = split(id, 2) as [string, string];
    const r = await http<{ order: RawFoodOrder }>('POST', `/orgs/${orgId}/foods/orders/${orderId}/transition`, {
      to: status, ...(status === 'rejected' ? { note: 'The kitchen could not accept this order' } : {}),
    });
    return toKitchenOrder(orgId, r.order);
  },
  async staffMessages(): Promise<StaffMessage[]> {
    // Team announcements / staff chat are not modelled by the API yet.
    return [];
  },
  async coverRequests(): Promise<CoverRequest[]> {
    const m = await rawMe();
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86400_000).toISOString();
    const perOrg = await Promise.all(staffOrgs(m).filter((o) => industryOf(o.industry) === 'studios').map(async (o) => {
      const [covers, occs, names] = await Promise.all([
        http<{ items: RawCover[] }>('GET', `/orgs/${o.id}/studios/cover-requests`).then((r) => r.items),
        occurrencesFor(o.id, from, to),
        memberNames(o.id),
      ]);
      return covers.flatMap((c): CoverRequest[] => {
        const status = coverStatus(c.status);
        const occ = occs.find((x) => x.id === c.occurrenceId);
        if (!status || !occ) return [];
        const mine = c.requestedBy === m!.user.id;
        return [{ id: `${o.id}~${c.id}`, sessionName: occ.classTypeName, locationId: c.locationId, startsAt: occ.startsAt, requestedBy: mine ? 'You' : names.get(c.requestedBy) ?? 'A teammate', mine, status }];
      });
    }));
    return perOrg.flat().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  },
  async requestCover(sessionId: string): Promise<CoverRequest> {
    const [orgId, occId] = split(sessionId, 2);
    const c = await http<RawCover>('POST', `/orgs/${orgId}/studios/occurrences/${occId}/cover-requests`, {});
    const sessions = await liveApi.mySessions();
    const s = sessions.find((x) => x.id === sessionId);
    return { id: `${orgId}~${c.id}`, sessionName: s?.name ?? '', locationId: c.locationId, startsAt: s?.startsAt ?? c.createdAt, requestedBy: 'You', mine: true, status: 'open' };
  },
  async acceptCover(id: string): Promise<CoverRequest> {
    const [orgId, coverId] = split(id, 2);
    await http('POST', `/orgs/${orgId}/studios/cover-requests/${coverId}/accept`);
    const all = await liveApi.coverRequests();
    return all.find((c) => c.id === id) ?? notSupported('Cover request');
  },

  // owner / HQ
  async pulse(): Promise<Pulse> {
    const m = await rawMe();
    const orgs = ownerOrgs(m).filter((o) => has(o, 'reports.read'));
    const { index } = await loadCatalog();
    const from = new Date(Date.now() - 7 * 86400_000).toISOString();
    const rows = await Promise.all(orgs.flatMap((o) => [...index.values()].filter((v) => v.orgId === o.id).map(async ({ loc }): Promise<PulseLocation> => {
      const ov = await http<RawOverview>('GET', `/orgs/${o.id}/reports/overview?scopeKind=location&scopeId=${loc.id}&from=${encodeURIComponent(from)}`);
      const mt = ov.metrics;
      const rev = mt.revenue.value;
      const net = rev ? rev.filter((r) => r.currency === loc.currency).reduce((a, r) => a + r.netMinor, 0) : null;
      const broken = ov.connections.some((c) => c.state !== 'connected');
      const anyData = rev !== null || mt.classBookings.value !== null || mt.foodOrders.value !== null;
      const studios = industryOf(o.industry) === 'studios';
      return {
        locationId: loc.id, name: loc.name, city: loc.city, country: loc.country, currency: loc.currency, timeZone: loc.timeZone,
        sales: net === null ? null : { amount: net, currency: loc.currency },
        bookings: studios ? mt.classBookings.value : null,
        occupancyPct: studios && mt.occupancy.value !== null ? Math.round(mt.occupancy.value * 100) : null,
        orders: studios ? null : sumCounts(mt.foodOrders.value),
        source: studios ? mt.classBookings.freshness.source : mt.foodOrders.freshness.source,
        sync: !anyData ? 'not_connected' : broken || (studios && !mt.classBookings.freshness.complete) ? 'degraded' : 'healthy',
      };
    })));
    const count = rows.length;
    const single = orgs.length === 1 && orgs[0]!.model === 'independent' && count <= 1;
    return {
      ...(single ? { singleLocation: { businessName: orgs[0]!.name } } : {}),
      scopeLabel: single ? orgs[0]!.name : `${orgs.map((o) => o.name).join(' · ')} · ${count} ${count === 1 ? 'location' : 'locations'}`,
      range: 'Last 7 days', locations: rows, updatedAt: new Date().toISOString(),
    };
  },
  async approvals(): Promise<Approval[]> {
    const m = await rawMe();
    const perOrg = await Promise.all(ownerOrgs(m).map(async (o) => {
      const names = await memberNames(o.id);
      const who = (id: string) => (id === m!.user.id ? 'You' : names.get(id) ?? 'Location team');
      const { index } = await loadCatalog();
      const locName = (id: string | null) => (id ? index.get(id)?.loc.name ?? '' : 'All locations');
      // One inbox: refunds over the threshold, local ad spend, shift swaps and website changes (GET /approvals),
      // plus studio cover substitutions waiting for a manager.
      const [requests, covers] = await Promise.all([
        http<{ items: RawApprovalFull[] }>('GET', `/orgs/${o.id}/approvals?status=pending`).then((r) => r.items.filter((a) => a.canDecide)),
        industryOf(o.industry) === 'studios' && has(o, 'operations.write') ? http<{ items: RawCover[] }>('GET', `/orgs/${o.id}/studios/cover-requests?status=accepted`).then((r) => r.items) : Promise.resolve([] as RawCover[]),
      ]);
      const out: Approval[] = requests.map((a) => {
        const p = a.payload ?? {};
        const base = { id: `${o.id}~approval~${a.id}`, locationId: a.locationId ?? '', locationName: a.location?.name ?? locName(a.locationId), requestedBy: a.requester.name ?? who(a.requester.id), requestedAt: a.createdAt, reason: a.requestComment ?? undefined, status: 'pending' as const };
        if (a.kind === 'refund') return { ...base, kind: 'refund' as const, title: a.title, amount: a.amount ?? undefined };
        if (a.kind === 'ad_spend') return { ...base, kind: 'ad_spend' as const, title: a.title, amount: a.amount ?? undefined, channel: CHANNEL[String(p.channel)] ?? String(p.channel ?? ''), days: Number(p.durationDays ?? 0) };
        if (a.kind === 'shift_swap') {
          const sh = p.shift as { startsAt?: string; timeZone?: string; role?: string } | undefined;
          const when = sh?.startsAt ? new Intl.DateTimeFormat(currentLocale(), { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: sh.timeZone ?? 'UTC' }).format(new Date(sh.startsAt)) : '';
          return { ...base, kind: 'shift_swap' as const, title: a.title, swap: { a: String((p.from as { name?: string })?.name ?? '—'), b: String((p.to as { name?: string })?.name ?? '—'), session: `${sh?.role ?? 'Shift'} · ${when}` } };
        }
        return { ...base, kind: 'website' as const, title: a.kind === 'field' ? `Website · ${String(p.fieldKey ?? 'field').replace(/_/g, ' ')}: “${String(p.value ?? '')}”` : 'Website page ready to publish' };
      });
      const occs = covers.length ? await occurrencesFor(o.id, new Date(Date.now() - 86400_000).toISOString(), new Date(Date.now() + 60 * 86400_000).toISOString()) : [];
      for (const c of covers) {
        const occ = occs.find((x) => x.id === c.occurrenceId);
        out.push({
          id: `${o.id}~cover~${c.id}`, kind: 'shift_swap', locationId: c.locationId, locationName: locName(c.locationId), title: occ?.classTypeName ?? 'Class cover',
          requestedBy: who(c.requestedBy), requestedAt: c.createdAt, reason: c.reason ?? undefined, status: 'pending',
          swap: { a: who(c.requestedBy), b: c.substituteName ?? '—', session: occ ? `${occ.classTypeName} · ${new Date(occ.startsAt).toUTCString().slice(0, 22)} UTC` : '' },
        });
      }
      return out;
    }));
    return perOrg.flat().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  },
  async decide(id: string, decision: 'approved' | 'rejected', reason?: string): Promise<Approval> {
    const [orgId, type, targetId] = split(id, 3);
    const current = (await liveApi.approvals()).find((a) => a.id === id);
    if (!current) throw new ApiError(409, 'already_decided', 'Someone already decided this request.');
    if (type === 'cover') {
      await http('POST', `/orgs/${orgId}/studios/cover-requests/${targetId}/decision`, { decision: decision === 'approved' ? 'approve' : 'decline', note: reason || undefined });
    } else {
      // Website rejections need a reason on the server; give a neutral default when none was typed.
      const comment = reason || (decision === 'rejected' && current.kind === 'website' ? 'Rejected from the mobile app' : undefined);
      await http('POST', `/orgs/${orgId}/approvals/${targetId}/decision`, { decision: decision === 'approved' ? 'approve' : 'reject', comment });
    }
    return { ...current, status: decision };
  },
  async notifications(): Promise<AppNotification[]> {
    const m = await rawMe();
    const out: AppNotification[] = [];
    await Promise.all(ownerOrgs(m).filter((o) => has(o, 'reports.read')).map(async (o) => {
      const ov = await http<RawOverview>('GET', `/orgs/${o.id}/reports/overview`);
      for (const c of ov.connections.filter((x) => x.state !== 'connected')) {
        out.push({
          id: `${o.id}~conn~${c.id}`, kind: 'integration', title: `${c.provider} connection ${c.state.replace(/_/g, ' ')}`,
          body: `${o.name}: figures that depend on ${c.provider} are unavailable until it reconnects.`, at: c.lastSuccessAt ?? new Date().toISOString(),
        });
      }
    }));
    const pending = await liveApi.approvals().catch(() => []);
    if (pending.length) {
      out.push({ id: 'approvals', kind: 'action', title: `${pending.length} ${pending.length === 1 ? 'approval' : 'approvals'} waiting`, body: 'Open Approvals to review and decide.', at: pending[0]!.requestedAt });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  },
};

/** Whether the server runs payments in sandbox mode (no Stripe keys) — enables "simulate payment" in the app. */
let sandboxPromise: Promise<boolean> | null = null;
export function serverPaymentsSandbox(): Promise<boolean> {
  sandboxPromise ??= fetch(`${env.apiUrl}/health`)
    .then((r) => r.json() as Promise<{ integrations?: { stripe?: string } }>)
    .then((h) => String(h.integrations?.stripe ?? '').startsWith('sandbox'))
    .catch(() => {
      sandboxPromise = null;
      return false;
    });
  return sandboxPromise;
}
