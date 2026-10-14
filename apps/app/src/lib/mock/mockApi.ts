/**
 * In-memory implementation of `BranchHarborApi` with sample, internationalised data.
 * It behaves like the backend: it enforces permissions (throws `forbidden`), simulates latency,
 * keeps state across calls, and supports `?demo=loading|empty|error` for state reviews.
 */
import { can, isValidTimeZone, LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES, type Currency, type Money, type Permission } from '@bh/shared';
import { ApiError, type BranchHarborApi } from '../api';
import type {
  ApprovalItem,
  ApprovalRequest,
  ShiftView,
  ClassOccurrence,
  CommerceOrder,
  Connection,
  CoverRequest,
  DomainStatus,
  FoodOrder,
  GroupPublish,
  ImportRow,
  IndustryKey,
  Member,
  MenuItem,
  OnboardingProgress,
  OrgSettings,
  ReconciliationItem,
  Registration,
  Report,
  RequestContext,
  SportsGroup,
  TableData,
  Transaction,
  WebsitePage,
  WellnessDay,
} from '../types';
import { addDays, dateInZone, zonedToUtc } from '../format';
import { AI, buildOverview, buildTable } from './content';
import { FIXTURES, PASTEL as P, at, loc, minutesAgo, scopeLocationIds, scopeOptions, sessionFor, unsplash, visibleLocations } from './orgs';

/* ---------------- helpers ---------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

function demo(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('demo');
}

/** Simulated read: honours ?demo=loading|error|empty. */
async function read<T>(value: () => T, empty?: () => T, ms = 320): Promise<T> {
  const d = demo();
  if (d === 'loading') await new Promise(() => {});
  await sleep(ms);
  if (d === 'error') throw new ApiError('server_error', 'The service returned an error while loading this data.', 500);
  if (d === 'empty' && empty) return empty();
  return clone(value());
}
async function write<T>(fn: () => T, ms = 700): Promise<T> {
  await sleep(ms);
  return clone(fn());
}

function requirePerm(ctx: RequestContext, perm: Permission) {
  const s = sessionFor(ctx.industry, ctx.role);
  if (!can(s.assignments, perm)) throw new ApiError('forbidden', `Your role doesn't include ${perm}.`, 403);
}
const scopeIds = (ctx: RequestContext) => scopeLocationIds(ctx.industry, ctx.role, ctx.scopeId);
const m = (major: number, currency: Currency): Money => ({ amount: Math.round(major * 100), currency });
const now = () => new Date().toISOString();

/* Last request context (used by write calls that do not carry one). */
let lastCtx: RequestContext = { industry: 'studios', scopeId: 'all', role: 'hq' };
const remember = (ctx: RequestContext) => (lastCtx = ctx);

/* ---------------- Studios ---------------- */

const INSTRUCTORS: Record<string, string[]> = {
  qw: ['Maya Rao', 'Sam Tran', 'Ana Silva'], ls: ['Ana Silva', 'Jordan Lee', 'Kim Lau'], kt: ['Jordan Lee', 'Noah Fraser', 'Lia Park'], ch: ['Ruth Osei', 'Dev Patel', 'Mara Quinn'],
  sh: ['Priya Shah', 'Tom Hughes', 'Isla Grant'], pb: ['Lena Vogel', 'Jonas Becker', 'Mia Krause'], sy: ['Ella Wright', 'Kai Tanaka', 'Zoe Bell'],
};
const CLASS_TEMPLATES: [string, string, number, string][] = [
  ['07:00', 'Morning Vinyasa', 60, P.lilac],
  ['09:00', 'Slow Flow', 75, P.sage],
  ['12:15', 'Lunchtime Pilates', 45, P.butter],
  ['18:30', 'Yin & Restore', 60, P.aqua],
];
function classesFor(locId: string, weekStartYmd: string): ClassOccurrence[] {
  const l = loc('studios', locId);
  const inst = INSTRUCTORS[locId] ?? ['Instructor'];
  const out: ClassOccurrence[] = [];
  for (let d = 0; d < 7; d++) {
    const ymd = addDays(weekStartYmd, d);
    CLASS_TEMPLATES.forEach(([hhmm, name, minutes, pastel], ti) => {
      if ((d + ti) % 4 === 3) return;
      const booked = Math.min(20, 11 + ((d * 3 + ti * 5 + locId.length) % 10));
      const isCover = locId === 'qw' && d === 5 && ti === 0;
      out.push({ id: `${locId}-${ymd}-${ti}`, name, instructor: inst[ti % inst.length]!, locationId: locId, room: ti % 2 ? 'Studio B' : 'Studio A', start: zonedToUtc(ymd, hhmm, l.timeZone), minutes, booked, capacity: 20, waitlist: booked >= 20 ? 3 : 0, source: l.sync === 'attention' ? 'Booking connection' : 'BranchHarbor', coverRequested: isCover, pastel: isCover ? P.blush : pastel });
    });
  }
  return out;
}

function freshCover(): CoverRequest {
  const l = loc('studios', 'qw');
  const today = dateInZone(new Date(), l.timeZone);
  const sat = addDays(today, (6 - new Date(`${today}T12:00:00Z`).getUTCDay() + 7) % 7 || 7);
  return {
    id: 'cov_1', classId: `qw-${sat}-0`, className: 'Morning Vinyasa', start: zonedToUtc(sat, '07:00', l.timeZone), timeZone: l.timeZone, locationName: l.name, requestedBy: 'Maya Rao', reason: 'Unavailable — family commitment', bookedCustomers: 16, status: 'open',
    candidates: [
      { id: 'st', name: 'Sam Tran', note: 'Available · teaches Vinyasa', available: true, state: 'notified' },
      { id: 'as', name: 'Ana Silva', note: 'Available', available: true, state: 'notified' },
      { id: 'jl', name: 'Jordan Lee', note: 'Teaching at Leslieville at that time', available: false, state: 'unavailable' },
    ],
    history: [{ at: minutesAgo(180), text: 'Maya Rao requested cover' }, { at: minutesAgo(179), text: '2 eligible instructors notified' }],
  };
}

/* ---------------- Sports ---------------- */

function freshRegs(): { items: Registration[]; groups: SportsGroup[] } {
  return {
    groups: [{ id: 'u10b', name: 'U10 Blue', roster: 14, capacity: 16 }, { id: 'u10g', name: 'U10 Green', roster: 16, capacity: 16 }, { id: 'u12c', name: 'U12 Camp', roster: 22, capacity: 24 }],
    items: [
      { id: 'r1', participant: 'Ella M.', age: 9, programme: 'U10 Autumn', guardian: 'Sara M.', guardianVerified: true, payment: { label: 'Paid', amount: m(240, 'CAD'), tone: 'success' }, formsComplete: true, formsNote: 'Medical + consent complete', status: 'awaiting_review' },
      { id: 'r2', participant: 'Leo R.', age: 9, programme: 'U10 Autumn', guardian: 'Kim R.', guardianVerified: false, payment: { label: 'Not taken', tone: 'neutral' }, formsComplete: false, formsNote: 'Consent form missing', status: 'awaiting_review' },
      { id: 'r3', participant: 'Aya N.', age: 10, programme: 'U10 Autumn', guardian: 'Hiro N.', guardianVerified: true, payment: { label: 'Paid', amount: m(240, 'CAD'), tone: 'success' }, formsComplete: true, formsNote: 'Complete', status: 'awaiting_review' },
      { id: 'r4', participant: 'Jonah P.', age: 11, programme: 'U12 Camp', guardian: 'Dev P.', guardianVerified: true, payment: { label: 'Paid', amount: m(180, 'CAD'), tone: 'success' }, formsComplete: true, formsNote: 'Complete', status: 'accepted', groupId: 'u12c' },
      { id: 'r5', participant: 'Freddie W.', age: 13, programme: 'U14 Development', guardian: 'Claire W.', guardianVerified: true, payment: { label: 'Paid', amount: m(165, 'GBP'), tone: 'success' }, formsComplete: true, formsNote: 'Complete', status: 'awaiting_review' },
    ],
  };
}
const ROSTER = ['Ella M.', 'Sam K.', 'Ivy T.', 'Noah B.', 'Ari P.', 'Mila J.', 'Owen C.', 'Zoe W.', 'Kai R.', 'Lena H.', 'Theo S.', 'Ruby A.', 'Max D.', 'Isla F.'];

/* ---------------- Wellness ---------------- */

function freshDay(locId: string): WellnessDay {
  const l = loc('wellness', locId);
  const date = dateInZone(new Date(), l.timeZone);
  const t = (hhmm: string) => zonedToUtc(date, hhmm, l.timeZone);
  return {
    date, locationId: locId, timeZone: l.timeZone, slots: ['09:00', '10:00', '11:30', '13:00', '14:00', '15:30', '17:00'], rooms: ['Room A', 'Room B', 'Room C'],
    practitioners: [{ id: 'rk', name: 'Rina K.', pastel: P.sage }, { id: 'tb', name: 'Tom B.', pastel: P.lilac }, { id: 'al', name: 'Ana L.', pastel: P.butter }],
    appointments: [
      { id: 'ap_jordan', service: 'Deep tissue · 60 min', client: 'Jordan P.', practitionerId: 'rk', room: 'Room A', start: t('10:00'), minutes: 60, status: 'confirmed' },
      { id: 'ap_kai', service: 'Hot stone · 90 min', client: 'Kai S.', practitionerId: 'rk', room: 'Room B', start: t('11:30'), minutes: 90, status: 'deposit_paid' },
      { id: 'ap_mira', service: 'Facial · 45 min', client: 'Mira D.', practitionerId: 'tb', room: 'Room C', start: t('13:00'), minutes: 45, status: 'confirmed' },
      { id: 'ap_cx', service: 'Facial · 45 min', client: 'Pat G.', practitionerId: 'tb', room: 'Room C', start: t('14:00'), minutes: 45, status: 'cancelled' },
      { id: 'ap_lou', service: 'Deep tissue · 60 min', client: 'Lou F.', practitionerId: 'al', room: 'Room B', start: t('10:00'), minutes: 60, status: 'confirmed' },
      { id: 'ap_pat', service: 'Deep tissue · 60 min', client: 'Sam G.', practitionerId: 'al', room: 'Room A', start: t('14:00'), minutes: 60, status: 'confirmed' },
    ],
  };
}

/* ---------------- Commerce ---------------- */

function freshOrders(): CommerceOrder[] {
  const pd = loc('commerce', 'pd');
  const tl = (minsAgo: number, text: string, tone: 'success' | 'info' | 'neutral' | 'warning' | 'danger', icon: 'check' | 'refresh' | 'undo' | 'alert' | 'x') => ({ at: minutesAgo(minsAgo), text, tone, icon });
  return [
    { id: 'o5521', number: '5521', customer: 'Riley A.', locationId: 'pd', source: 'WooCommerce #8841', placedAt: at(pd.timeZone, '10:14'), lines: [{ id: 'l1', name: 'Linen overshirt · M', qty: 1, unit: m(99, 'USD'), refunded: false }, { id: 'l2', name: 'Linen overshirt · L', qty: 1, unit: m(99, 'USD'), refunded: false }], total: m(198, 'USD'), tax: { label: 'Sales tax (Oregon): none configured', amount: null }, payment: 'succeeded', refund: 'none', fulfilment: 'to_fulfil',
      timeline: [tl(90, 'Order created in WooCommerce', 'success', 'check'), tl(90, 'Imported to BranchHarbor (event wc_8841_created)', 'info', 'refresh'), tl(89, 'Retry received · same external ID, no duplicate created', 'neutral', 'refresh')] },
    { id: 'o5519', number: '5519', customer: 'Sam T.', locationId: 'sf', source: 'WooCommerce #8836', placedAt: minutesAgo(400), lines: [{ id: 'l1', name: 'Merino crew · S', qty: 1, unit: m(89, 'USD'), refunded: false }], total: m(89, 'USD'), tax: { label: 'Sales tax (CA) as configured', amount: m(7.79, 'USD') }, payment: 'succeeded', refund: 'none', fulfilment: 'fulfilled', timeline: [tl(400, 'Order created in WooCommerce', 'success', 'check'), tl(399, 'Imported to BranchHarbor', 'info', 'refresh'), tl(120, 'Marked fulfilled at Hayes Valley', 'success', 'check')] },
    { id: 'o5517', number: '5517', customer: 'Jo M.', locationId: 'pd', source: 'WooCommerce #8830', placedAt: minutesAgo(600), lines: [{ id: 'l1', name: 'Canvas tote', qty: 1, unit: m(34, 'USD'), refunded: false }], total: m(34, 'USD'), tax: { label: 'Sales tax (Oregon): none configured', amount: null }, payment: 'failed', refund: 'none', fulfilment: 'on_hold', timeline: [tl(600, 'Order created in WooCommerce', 'neutral', 'check'), tl(599, 'Payment failed · card declined', 'danger', 'x')] },
    { id: 'o5526', number: '5526', customer: 'Sanne de V.', locationId: 'am', source: 'WooCommerce #8850', placedAt: minutesAgo(140), lines: [{ id: 'l1', name: 'Field notebook set', qty: 2, unit: m(32, 'EUR'), refunded: false }], total: m(64, 'EUR'), tax: { label: 'VAT 21% included, as configured', amount: m(11.11, 'EUR') }, payment: 'succeeded', refund: 'none', fulfilment: 'to_fulfil', timeline: [tl(140, 'Order created in WooCommerce', 'success', 'check'), tl(140, 'Imported to BranchHarbor', 'info', 'refresh')] },
    { id: 'o5530', number: '5530', customer: 'Élise B.', locationId: 'me', source: 'WooCommerce #8853', placedAt: minutesAgo(60), lines: [{ id: 'l1', name: 'Merino crew · S', qty: 1, unit: m(109, 'CAD'), refunded: false }], total: m(125.32, 'CAD'), tax: { label: 'GST + QST as configured', amount: m(16.32, 'CAD') }, payment: 'processing', refund: 'none', fulfilment: 'to_fulfil', timeline: [tl(60, 'Order created in WooCommerce', 'success', 'check'), tl(60, 'Payment processing', 'info', 'refresh')] },
    { id: 'o5512', number: '5512', customer: 'Ren K.', locationId: 'au', source: 'WooCommerce (Austin)', placedAt: minutesAgo(1100), lines: [{ id: 'l1', name: 'Merino crew ×2', qty: 2, unit: m(89, 'USD'), refunded: false }], total: m(178, 'USD'), tax: { label: 'Unavailable while disconnected', amount: null }, payment: 'not_imported', refund: 'none', fulfilment: 'store_disconnected', timeline: [tl(1100, 'Store disconnected — order seen in last partial sync only', 'warning', 'alert')] },
  ];
}

/* ---------------- Foods ---------------- */

const MENU_BASE = [
  { id: 'bowl', name: 'Ember chicken bowl', image: unsplash('1640583342012-4622f31b650d'), status: 'published' as const, prices: { USD: 16.5, CAD: 21, GBP: 12.5, EUR: 14 }, diet: 'Gluten-free option', mods: 'Rice, sauce, extra protein' },
  { id: 'brisket', name: 'Smoked brisket sandwich', image: unsplash('1622021142947-da7dedc7c39a'), status: 'partial_failure' as const, statusNote: 'Failed at Vancouver – Gastown', prices: { USD: 18, CAD: 23, GBP: 13.5, EUR: 15 }, diet: 'Contains gluten', mods: 'Bun, pickles' },
  { id: 'flatbread', name: 'Wood-fired flatbread', image: unsplash('1651981075280-9a9e01acbff0'), status: 'published' as const, prices: { USD: 15, CAD: 19.5, GBP: 11, EUR: 12.5 }, diet: 'Vegetarian', mods: 'Toppings' },
  { id: 'salad', name: 'Garden tomato salad', image: unsplash('1554997433-8e233c02c751'), status: 'draft' as const, prices: { USD: 11, CAD: 14, GBP: 8.5, EUR: 9.5 }, diet: 'Vegan', mods: 'Dressing' },
];
/** Local price overrides (major units) by `${locId}:${itemId}`. */
const freshOverrides = (): Record<string, number> => ({ 'bl:bowl': 17.25, 'bo:flatbread': 11.5 });
const SOLD_OUT: Record<string, string[]> = { bl: ['brisket'], bo: ['salad'] };

function freshFoodOrders(): FoodOrder[] {
  const make = (locId: string, n: string, name: string, pickupOffsetMin: number, total: number, status: FoodOrder['status'], items: FoodOrder['items'], notes?: string): FoodOrder => {
    const l = loc('foods', locId);
    return { id: `fo_${locId}_${n}`, number: n, customerFirstName: name, locationId: locId, pickupAt: new Date(Date.now() + pickupOffsetMin * 60000).toISOString(), placedAt: minutesAgo(Math.max(4, 20 - pickupOffsetMin)), total: m(total, l.currency), paid: true, status, items, notes };
  };
  return [
    make('bl', '1046', 'Mei', 14, 41.2, 'awaiting_acceptance', [{ name: 'Ember chicken bowl', qty: 2, modifiers: ['Brown rice', 'Extra protein'] }, { name: 'Maple lemonade', qty: 2, modifiers: [] }]),
    make('bl', '1045', 'Daniel', 8, 22.4, 'awaiting_acceptance', [{ name: 'Wood-fired flatbread', qty: 1, modifiers: ['No olives'] }, { name: 'Maple lemonade', qty: 1, modifiers: [] }], 'Allergy noted by guest: sesame'),
    make('bl', '1044', 'Ana', 4, 47.85, 'preparing', [{ name: 'Smoked brisket sandwich', qty: 2, modifiers: ['Extra pickles'] }, { name: 'Garden tomato salad', qty: 1, modifiers: ['Dressing on side'] }]),
    make('bl', '1041', 'Priya', -6, 29.1, 'preparing', [{ name: 'Ember chicken bowl', qty: 1, modifiers: ['Spicy sauce'] }, { name: 'Wood-fired flatbread', qty: 1, modifiers: [] }]),
    make('bl', '1039', 'Tom', -2, 18.0, 'ready', [{ name: 'Smoked brisket sandwich', qty: 1, modifiers: [] }]),
    make('fr', '0877', 'Aaron', 10, 33.0, 'accepted', [{ name: 'Ember chicken bowl', qty: 2, modifiers: [] }]),
    make('gv', '3311', 'Hana', 22, 38.5, 'awaiting_acceptance', [{ name: 'Wood-fired flatbread', qty: 2, modifiers: ['Add chili oil'] }]),
    make('bo', '2207', 'Oliver', 35, 24.5, 'accepted', [{ name: 'Ember chicken bowl', qty: 1, modifiers: [] }, { name: 'Wood-fired flatbread', qty: 1, modifiers: [] }]),
  ];
}

/* ---------------- Websites ---------------- */

function freshPage(ind: IndustryKey, locId: string): WebsitePage {
  const f = FIXTURES[ind];
  const l = loc(ind, locId);
  const short = l.name.split(' – ').pop() ?? l.name;
  const hq = { hours: l.hours, phone: l.phone };
  const pending = ind === 'studios' && locId === 'ls' ? { value: 'Your east-end studio, steps from Queen St E', reason: 'Local landmark helps search and new members', requestedBy: 'Kim Lau', at: minutesAgo(95) } : undefined;
  return {
    locationId: locId, locationName: l.name, page: 'Home', version: 15,
    fields: [
      { key: 'brand', label: 'Brand name', policy: 'locked', value: f.org.brand },
      { key: 'nav', label: 'Header navigation', policy: 'locked', value: ind === 'foods' ? 'Menu · Order pickup · Locations · About' : ind === 'commerce' ? 'Shop · Stores · Journal · About' : 'Classes · Offers · Locations · About' },
      { key: 'headline', label: 'Hero headline', policy: 'approval', value: `Find your place in ${short}`, pending },
      { key: 'offer', label: 'Intro offer line', policy: 'approval', value: `New here? Your first visit is on us at ${short}.` },
      { key: 'hours', label: 'Opening hours', policy: 'editable', value: hq.hours, hqValue: hq.hours },
      { key: 'phone', label: 'Phone number', policy: 'editable', value: locId === 'ls' ? '+1 416 555 0199' : hq.phone, hqValue: hq.phone },
    ],
    activity: [{ at: minutesAgo(310), text: 'Version 15 published by headquarters' }, ...(pending ? [{ at: pending.at, text: 'Kim Lau requested a change to Hero headline' }] : [])],
  };
}

function freshPlan(ind: IndustryKey): GroupPublish {
  const f = FIXTURES[ind];
  return {
    id: 'pub_16', title: 'Autumn timetable section and new brand footer', version: 16,
    targets: f.locations.map((l, i) => ({
      locationId: l.id, locationName: l.name, changedPages: ['Home', 'Schedule', 'Footer (all pages)'],
      excludedOverrides: i === 0 ? ['Opening hours (local override kept)'] : i === 1 ? ['Phone number (local override kept)'] : [],
      warnings: l.site === 'unpublished' ? ['Site not public yet — changes will be staged only'] : l.sync === 'attention' ? ['Booking sync degraded — schedule block may show cached times'] : [],
      result: 'pending',
    })),
  };
}

/* ---------------- Payments ---------------- */

function freshPayments(ind: IndustryKey) {
  const f = FIXTURES[ind];
  const L = f.locations;
  const lp = loc(ind, f.localLocationId);
  const what: Record<IndustryKey, [string, string]> = { studios: ['Class booking', 'Monthly membership'], sports: ['Registration · U10 Autumn', 'Camp registration'], wellness: ['Deposit · Hot stone', 'Deep tissue 60 min'], commerce: ['Order #5521', 'Order #5519'], foods: ['Pickup order', 'Pickup order'], realty: ['Valuation fee', 'Marketing package'] };
  const ev = (mins: number, text: string, tone: 'success' | 'info' | 'danger' | 'warning' | 'neutral', icon: 'card' | 'check' | 'x' | 'refresh' | 'undo' | 'alert') => ({ at: minutesAgo(mins), text, tone, icon });
  const tx: Transaction[] = L.filter((l) => l.site === 'live').flatMap((l, i): Transaction[] => {
    const base = l.currency === 'GBP' ? 28 : l.currency === 'EUR' ? 32 : l.currency === 'AUD' ? 45 : l.currency === 'CAD' ? 39 : 34.65;
    return [
      { id: `tx_${l.id}_1`, externalRef: `pi_3QX…${(9 + i).toString(36)}F${i}k`, createdAt: minutesAgo(20 + i * 37), description: what[ind][0], locationId: l.id, amount: m(base, l.currency), payment: 'succeeded', refund: 'none', provider: 'Stripe', linkedRecord: l.id === lp.id ? undefined : `${ind === 'foods' ? 'Order' : 'Booking'} ${l.code}-${3390 + i}`,
        timeline: [ev(20 + i * 37, `payment_intent.succeeded · signed event`, 'success', 'card'), ev(19 + i * 37, l.id === lp.id ? 'Linked record could not be created' : 'Linked record created', l.id === lp.id ? 'danger' : 'success', l.id === lp.id ? 'x' : 'check')] },
      { id: `tx_${l.id}_2`, externalRef: `pi_3QX…${(4 + i).toString(36)}E${i}f`, createdAt: minutesAgo(300 + i * 90), description: what[ind][1], locationId: l.id, amount: m(base * 4 + 13, l.currency), payment: i % 3 === 2 ? 'failed' : i % 4 === 1 ? 'processing' : 'succeeded', refund: i === 1 ? 'partial' : 'none', provider: ind === 'commerce' ? 'WooCommerce gateway' : 'Stripe', linkedRecord: `Record ${l.code}-${4100 + i}`,
        timeline: [ev(300 + i * 90, 'payment_intent.created', 'neutral', 'card'), ev(299 + i * 90, i % 3 === 2 ? 'payment_intent.payment_failed · card declined' : 'payment_intent.succeeded', i % 3 === 2 ? 'danger' : 'success', i % 3 === 2 ? 'x' : 'check'), ...(i === 1 ? [ev(120, 'Partial refund complete', 'info' as const, 'undo' as const)] : [])] },
    ];
  });
  const rec: ReconciliationItem[] = [
    { id: 'rec_1', type: 'paid_without_record', summary: `${what[ind][0]} · ${lp.name}`, transactionRef: 'pi_3QX…9Fk', amount: m(34.65, lp.currency), locationId: lp.id, customer: 'Lena W.', orderState: 'Missing', status: 'needs_action',
      timeline: [ev(42, `Stripe payment_intent.succeeded · ${lp.currency} (signed event)`, 'success', 'card'), ev(42, ind === 'foods' ? 'Order creation failed: pickup slot full at confirm' : 'Record creation failed: capacity changed during checkout', 'danger', 'x')] },
    { id: 'rec_2', type: 'unpaid_confirmed', summary: 'Confirmed record without payment', transactionRef: '—', amount: m(34, L[0]!.currency), locationId: L[0]!.id, customer: 'Jo M.', orderState: 'Confirmed', status: 'reviewing', timeline: [ev(600, 'Record confirmed by staff', 'neutral', 'check'), ev(599, 'No payment event received', 'warning', 'alert')] },
    { id: 'rec_3', type: 'amount_mismatch', summary: 'Amount mismatch', transactionRef: 'pi_3QX…2Ab', amount: m(39, L[0]!.currency), locationId: L[0]!.id, customer: 'Noor H.', orderState: 'Booked at 35.00', status: 'resolved', resolution: 'Difference refunded', timeline: [ev(1600, 'Mismatch detected', 'warning', 'alert'), ev(1500, 'Resolved: difference refunded', 'success', 'check')] },
  ];
  return { tx, rec };
}

/* ---------------- Connections ---------------- */

function freshConnections(ind: IndustryKey): Connection[] {
  const names = FIXTURES[ind].locations.map((l) => l.name);
  const C: Record<IndustryKey, Connection[]> = {
    studios: [
      { id: 'c_momence', name: 'Momence (booking)', monogram: 'Mm', role: 'Bookings and class schedule', state: 'degraded', lastSync: minutesAgo(124), direction: 'import', authoritative: 'Momence is the source of truth for bookings', locations: names.filter((n) => !n.includes('Berlin')), issue: 'Kitsilano: API rate limit reached. 8 class occurrences may be out of date.', affected: '8 class occurrences', fixAction: 'Retry sync' },
      { id: 'c_stripe', name: 'Stripe', monogram: 'St', role: 'Customer payments', state: 'connected', lastSync: minutesAgo(4), direction: 'import', authoritative: 'Stripe confirms payment outcomes', locations: names },
      { id: 'c_gcal', name: 'Google Calendar', monogram: 'Gc', role: 'Instructor schedules', state: 'authorization_expired', lastSync: minutesAgo(4320), direction: 'export', authoritative: 'BranchHarbor is the source; calendars receive copies', locations: names.slice(0, 2), issue: 'Instructor calendars stopped updating 3 days ago.', affected: '11 instructors', fixAction: 'Reauthorise' },
      { id: 'c_mail', name: 'Mailchimp', monogram: 'Mc', role: 'Consented contacts', state: 'initial_sync', lastSync: null, progress: 62, direction: 'export', authoritative: 'BranchHarbor consent records are authoritative', locations: names },
      { id: 'c_wp', name: 'WordPress (London site)', monogram: 'Wp', role: 'Existing website · blocks and forms', state: 'connected', lastSync: minutesAgo(12), direction: 'bidirectional', authoritative: 'Pages stay in WordPress; form submissions come to BranchHarbor', locations: names.filter((n) => n.includes('London')) },
    ],
    sports: [
      { id: 'c_stripe', name: 'Stripe', monogram: 'St', role: 'Registration payments', state: 'connected', lastSync: minutesAgo(6), direction: 'import', authoritative: 'Stripe confirms payment outcomes', locations: names.filter((n) => !n.includes('Dublin')) },
      { id: 'c_gcal', name: 'Google Calendar', monogram: 'Gc', role: 'Coach schedules', state: 'connected', lastSync: minutesAgo(60), direction: 'export', authoritative: 'BranchHarbor schedule is authoritative', locations: names },
      { id: 'c_stripe_ie', name: 'Stripe (Dublin)', monogram: 'St', role: 'Registration payments', state: 'disconnected', lastSync: null, direction: 'import', authoritative: 'Stripe confirms payment outcomes', locations: names.filter((n) => n.includes('Dublin')), issue: 'Account verification incomplete. Registration stays closed until payments are enabled.', affected: '1 programme', fixAction: 'Finish verification' },
    ],
    wellness: [
      { id: 'c_stripe', name: 'Stripe', monogram: 'St', role: 'Deposits and payments', state: 'connected', lastSync: minutesAgo(2), direction: 'import', authoritative: 'Stripe confirms payment outcomes', locations: names },
      { id: 'c_gcal', name: 'Google Calendar', monogram: 'Gc', role: 'Practitioner calendars', state: 'degraded', lastSync: minutesAgo(45), direction: 'export', authoritative: 'BranchHarbor calendar is authoritative', locations: names, issue: 'Fitzroy: 2 events rejected by Tom B.’s calendar.', affected: '2 appointments', fixAction: 'View affected and retry' },
    ],
    commerce: [
      { id: 'c_woo', name: 'WooCommerce', monogram: 'Wo', role: 'Orders, products and stock', state: 'connected', lastSync: minutesAgo(1), direction: 'bidirectional', authoritative: 'WooCommerce is the source of truth for orders', locations: names.filter((n) => !n.includes('Austin')) },
      { id: 'c_woo_aus', name: 'WooCommerce (Austin)', monogram: 'Wo', role: 'Orders, products and stock', state: 'disconnected', lastSync: minutesAgo(1100), direction: 'bidirectional', authoritative: 'WooCommerce is the source of truth for orders', locations: names.filter((n) => n.includes('Austin')), issue: 'Site unreachable. Orders placed there are not imported until it reconnects.', affected: 'Orders since yesterday 18:02', fixAction: 'Test connection' },
    ],
    foods: [
      { id: 'c_stripe', name: 'Stripe', monogram: 'St', role: 'Pickup payments', state: 'connected', lastSync: minutesAgo(0), direction: 'import', authoritative: 'Stripe confirms payment outcomes', locations: names },
      { id: 'c_kds_fr', name: 'Fremont kitchen screen', monogram: 'Kv', role: 'Kitchen display device', state: 'disconnected', lastSync: minutesAgo(28), direction: 'export', authoritative: 'Orders remain in BranchHarbor', locations: names.filter((n) => n.includes('Fremont')), issue: 'Screen offline. Orders still arrive here and by email.', affected: '1 device', fixAction: 'Send test order' },
      { id: 'c_pos', name: 'Square POS', monogram: 'Sq', role: 'Point of sale', state: 'initial_sync', lastSync: null, progress: 35, direction: 'export', authoritative: 'BranchHarbor sends orders; POS is not authoritative', locations: names.filter((n) => n.includes('London')) },
    ],
    realty: [
      { id: 'c_gcal', name: 'Google Calendar', monogram: 'Gc', role: 'Agent viewing calendars', state: 'connected', lastSync: minutesAgo(9), direction: 'export', authoritative: 'BranchHarbor viewings are authoritative; calendars receive copies', locations: names },
      { id: 'c_portal', name: 'Portal feeds (sandbox)', monogram: 'Pf', role: 'Listing syndication preview', state: 'initial_sync', lastSync: null, progress: 0, direction: 'export', authoritative: 'Sandbox only — nothing is sent to portals', locations: names },
    ],
  };
  return C[ind];
}

/* ---------------- Team ---------------- */

function freshTeam(ind: IndustryKey): Member[] {
  const f = FIXTURES[ind];
  const L = f.locations;
  return [
    { id: 'mem_hq', name: f.people.hq, email: 'jamie@…', assignments: [{ role: 'Organisation owner', scopeLabel: 'Organisation' }], lastActive: 'Now', status: 'active' },
    { id: 'mem_rm', name: 'Priya Nair', email: 'priya@…', assignments: [{ role: 'Regional manager', scopeLabel: 'Region: North America' }], lastActive: '1 h ago', status: 'active' },
    { id: 'mem_eu', name: 'Sophie Laurent', email: 'sophie@…', assignments: [{ role: 'Regional manager', scopeLabel: 'Region: Europe' }, { role: 'Marketing contributor', scopeLabel: 'Campaigns · Europe' }], lastActive: 'Today', status: 'active' },
    { id: 'mem_lm', name: f.people.local, email: 'local@…', assignments: [{ role: 'Location manager', scopeLabel: loc(ind, f.localLocationId).name }], lastActive: 'Today', status: 'active' },
    { id: 'mem_st', name: f.people.staff, email: 'staff@…', assignments: [{ role: 'Staff', scopeLabel: loc(ind, f.staffLocationId).name }, { role: 'Staff', scopeLabel: L[1]!.name }], lastActive: 'Yesterday', status: 'active' },
    { id: 'mem_fin', name: 'Olu Adeyemi', email: 'finance@…', assignments: [{ role: 'Finance user', scopeLabel: 'All authorised locations' }], lastActive: '3 days ago', status: 'active' },
    { id: 'mem_inv', name: 'new.manager@…', email: 'new.manager@…', assignments: [{ role: 'Location manager', scopeLabel: L[L.length - 1]!.name }], lastActive: 'Invitation sent 2 days ago', status: 'invited' },
    { id: 'mem_sup', name: 'BranchHarbor Support', email: 'Time-limited', assignments: [{ role: 'Support access', scopeLabel: 'Read-only · organisation' }], lastActive: 'Expires in 2 h · every action logged', status: 'support', note: 'Granted by ' + f.people.hq },
  ];
}

/* ---------------- Mutable state ---------------- */

interface IndState {
  cover: CoverRequest;
  regs: { items: Registration[]; groups: SportsGroup[] };
  attendanceSubmitted: boolean;
  days: Record<string, WellnessDay>;
  orders: CommerceOrder[];
  overrides: Record<string, number>;
  foodOrders: FoodOrder[];
  pages: Record<string, WebsitePage>;
  plan: GroupPublish;
  publishAttempts: Record<string, number>;
  payments: ReturnType<typeof freshPayments>;
  connections: Connection[];
  team: Member[];
  settings?: OrgSettings;
}
const STATE: Partial<Record<IndustryKey, IndState>> = {};
function st(ind: IndustryKey): IndState {
  return (STATE[ind] ??= {
    cover: freshCover(), regs: freshRegs(), attendanceSubmitted: false, days: {}, orders: freshOrders(), overrides: freshOverrides(), foodOrders: freshFoodOrders(), pages: {}, plan: freshPlan(ind), publishAttempts: {},
    payments: freshPayments(ind), connections: freshConnections(ind), team: freshTeam(ind),
  });
}
function page(ind: IndustryKey, locId: string) {
  const s = st(ind);
  return (s.pages[locId] ??= freshPage(ind, locId));
}
function day(locId: string) {
  const s = st('wellness');
  return (s.days[locId] ??= freshDay(locId));
}

function menuFor(ind: IndustryKey, view: string): MenuItem[] {
  const s = st(ind);
  const isHq = view === 'hq';
  const l = isHq ? null : loc(ind, view);
  return MENU_BASE.map((it) => {
    const ovKey = `${view}:${it.id}`;
    const ov = s.overrides[ovKey];
    const cur = (l?.currency ?? 'USD') as keyof typeof it.prices;
    const base = it.prices[cur] ?? it.prices.USD;
    const priceField = isHq
      ? { key: 'price' as const, label: 'Market prices', value: (Object.entries(it.prices) as [Currency, number][]).map(([c, v]) => `${c} ${v.toFixed(2)}`).join(' · '), origin: 'hq' as const, resettable: false }
      : { key: 'price' as const, label: 'Price', value: '', money: m(ov ?? base, l!.currency), origin: ov != null ? ('local' as const) : ('inherited' as const), resettable: ov != null };
    const fields: MenuItem['fields'] = [
      priceField,
      { key: 'dietary', label: 'Dietary details', value: it.diet, origin: isHq ? 'hq' : 'inherited', resettable: false },
      { key: 'modifiers', label: 'Modifiers', value: it.mods, origin: isHq ? 'hq' : 'inherited', resettable: false },
    ];
    if (!isHq) fields.push({ key: 'availability', label: 'Availability', value: (SOLD_OUT[view] ?? []).includes(it.id) ? 'Sold out' : 'Available', origin: 'local', resettable: false });
    return { id: it.id, name: it.name, image: it.image, status: it.status, statusNote: it.status === 'partial_failure' ? it.statusNote : undefined, fields };
  });
}


/* ---------------- Team schedule + approvals ---------------- */

const SHIFT_PEOPLE: Record<IndustryKey, [string, string][]> = {
  studios: [['Front desk', 'Sam Tran'], ['Front desk', 'Jordan Lee'], ['Studio manager', 'Kim Lau']],
  sports: [['Head coach', 'Coach Ortiz'], ['Coach', 'Coach Ahmed'], ['Site manager', 'Marcus Bell']],
  wellness: [['Reception', 'Tom Becker'], ['Clinic manager', 'Rina Kapoor'], ['Reception', 'Ana Lima']],
  commerce: [['Sales associate', 'Kim Lau'], ['Store manager', 'Leah Park'], ['Sales associate', 'Sanne Visser']],
  foods: [['Kitchen lead', 'Mei Lin'], ['Shift manager', 'Carlos Ortega'], ['Line cook', 'Ren Ito']],
  realty: [['Office duty agent', 'Nadia Hassan'], ['Office manager', 'Marcus Lee'], ['Office duty agent', 'Daniel Okafor']],
};
const SHIFT_TIMES: [string, string][] = [['07:00', '15:00'], ['14:00', '22:00'], ['09:00', '17:00']];

function freshShifts(ind: IndustryKey): ShiftView[] {
  const out: ShiftView[] = [];
  const nowMs = Date.now();
  for (const l of FIXTURES[ind].locations) {
    if (l.site === 'unpublished') continue;
    for (let d = -1; d < 8; d++) {
      SHIFT_PEOPLE[ind].forEach(([role, person], i) => {
        if ((d + i) % 7 === 6) return; // a day off each week
        const [s, e] = SHIFT_TIMES[i]!;
        const start = at(l.timeZone, s, d);
        const end = at(l.timeZone, e, d);
        const live = new Date(start).getTime() < nowMs && new Date(end).getTime() > nowMs;
        out.push({
          id: `sh_${l.id}_${d}_${i}`, locationId: l.id, locationName: l.name, timeZone: l.timeZone, person, role, start, end, breakMinutes: 30,
          clockedInAt: live || new Date(end).getTime() < nowMs ? new Date(new Date(start).getTime() - 4 * 60000).toISOString() : null,
          clockedOutAt: new Date(end).getTime() < nowMs ? new Date(new Date(end).getTime() + 6 * 60000).toISOString() : null,
          pendingSwap: d === 2 && i === 0 ? { to: SHIFT_PEOPLE[ind][1]![1], approvalId: `ap_${ind}_swap` } : null,
        });
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function freshApprovals(ind: IndustryKey): ApprovalRequest[] {
  const f = FIXTURES[ind];
  const L = f.locations.filter((l) => l.site === 'live');
  const a = L[0]!, b = L[1] ?? L[0]!, c = L[2] ?? L[0]!;
  const base = { status: 'pending' as const, canDecide: true, decidedBy: null, decisionComment: null, result: null };
  return [
    { ...base, id: `ap_${ind}_refund`, kind: 'refund', title: `Refund for ${ind === 'foods' ? 'pickup order #1042' : ind === 'commerce' ? 'order #5521' : 'payment pi_…8f2c'}`, locationName: a.name, amount: m(ind === 'foods' ? 17.66 : 68, a.currency), requestedBy: f.people.local, requestedAt: minutesAgo(48), reason: ind === 'foods' ? 'Order arrived cold — customer asked for a refund' : 'Class cancelled after the heating failed', details: [{ label: 'Above threshold', value: `Refunds over ${a.currency} 50.00 need approval` }, { label: 'Refunded so far', value: `${a.currency} 0.00` }] },
    { ...base, id: `ap_${ind}_ads`, kind: 'ad_spend', title: `${b.name.split(' – ').pop()} spring local ads`, locationName: b.name, amount: m(400, b.currency), requestedBy: f.people.local, requestedAt: minutesAgo(26 * 60), reason: 'Instagram + Facebook, 5 km radius, promoting the intro offer.', details: [{ label: 'Channel', value: 'Meta ads' }, { label: 'Duration', value: '14 days' }, { label: 'Starts', value: 'In 7 days' }] },
    { ...base, id: `ap_${ind}_swap`, kind: 'shift_swap', title: `${SHIFT_PEOPLE[ind][0]![0]} · in 2 days`, locationName: a.name, amount: null, requestedBy: SHIFT_PEOPLE[ind][0]![1], requestedAt: minutesAgo(180), reason: 'Exam that morning', details: [{ label: 'From', value: SHIFT_PEOPLE[ind][0]![1] }, { label: 'To', value: SHIFT_PEOPLE[ind][1]![1] }] },
    { ...base, id: `ap_${ind}_web`, kind: 'field', title: 'Website change: Intro offer', locationName: c.name, amount: null, requestedBy: f.people.local, requestedAt: minutesAgo(300), reason: 'Local launch promotion', details: [{ label: 'New value', value: 'First week unlimited for new members' }] },
    { ...base, id: `ap_${ind}_done`, kind: 'ad_spend', title: 'Autumn open day', status: 'approved', locationName: a.name, amount: m(250, a.currency), requestedBy: f.people.local, requestedAt: minutesAgo(5 * 24 * 60), reason: null, details: [{ label: 'Channel', value: 'Google ads' }, { label: 'Duration', value: '7 days' }], canDecide: false, decidedBy: f.people.hq, decisionComment: 'Approved — keep it local', result: 'Campaign scheduled' },
  ];
}
const SCHEDULE: Partial<Record<IndustryKey, ShiftView[]>> = {};
const APPROVALS: Partial<Record<IndustryKey, ApprovalRequest[]>> = {};
const shiftsOf = (ind: IndustryKey) => (SCHEDULE[ind] ??= freshShifts(ind));
const approvalsOf = (ind: IndustryKey) => (APPROVALS[ind] ??= freshApprovals(ind));

/* ---------------- Onboarding ---------------- */

const ONB_KEY = 'bh_mock_onboarding';
const domains: Record<string, { attempts: number; phase: number; verifiedAt?: number }> = {};
function domainRecords(host: string, found: [boolean, boolean]): DomainStatus['records'] {
  const apex = host.replace(/^www\./, '');
  return [
    { type: 'TXT', name: `_bh-verify.${apex}`, value: 'bh-verify=7f3a9c21e8', found: found[0] },
    { type: 'CNAME', name: host, value: 'sites.branchharbor.com', found: found[1] },
  ];
}

/* ---------------- The API ---------------- */

const rawMockApi: BranchHarborApi = {
  mode: 'mock',
  auth: {
    session: (ctx) => read(() => sessionFor(ctx.industry, ctx.role)),
    signIn: async ({ email, password }) => {
      await sleep(600);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError('validation_error', 'Check the highlighted fields.', 422, { email: 'Enter a valid work email.' });
      if (password.length < 10) throw new ApiError('invalid_credentials', 'That email and password don’t match an account.', 401, { password: 'Passwords have at least 10 characters.' });
      return { needsVerification: email.startsWith('new') };
    },
    signUp: async ({ email, password, name }) => {
      await sleep(700);
      const fields: Record<string, string> = {};
      if (!name.trim()) fields.name = 'Enter your name.';
      if (!/^\S+@\S+\.\S+$/.test(email)) fields.email = 'Enter a valid work email.';
      if (password.length < 10) fields.password = 'Use at least 10 characters.';
      if (Object.keys(fields).length) throw new ApiError('validation_error', 'Check the highlighted fields.', 422, fields);
      return { needsVerification: true };
    },
    verifyEmail: async ({ code }) => {
      await sleep(600);
      if (code !== '246810' && code.length !== 6) throw new ApiError('validation_error', 'Enter the 6-digit code.', 422, { code: 'Enter the 6-digit code from the email.' });
      if (code === '000000') throw new ApiError('code_expired', 'That code has expired. Send a new one.', 410, { code: 'Code expired.' });
      return { ok: true };
    },
    resendCode: async () => (await sleep(500), { ok: true }),
    forgotPassword: async ({ email }) => {
      await sleep(600);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError('validation_error', 'Enter a valid email.', 422, { email: 'Enter a valid email.' });
      return { ok: true };
    },
    signOut: async () => sleep(200),
  },

  org: (ctx) => read(() => FIXTURES[ctx.industry].org, undefined, 150),
  scopes: (ctx) => read(() => scopeOptions(ctx.industry, ctx.role), undefined, 100),
  locations: (ctx) => {
    remember(ctx);
    if (ctx.role === 'staff') return Promise.reject(new ApiError('forbidden', 'Staff can’t view the location directory.', 403));
    return read(() => visibleLocations(ctx.industry, ctx.role).filter((l) => scopeIds(ctx).includes(l.id)).map(({ revenue7d: _r, ...l }) => l), () => []);
  },
  overview: (ctx) => {
    remember(ctx);
    return read(() => buildOverview(ctx.industry, scopeIds(ctx)), () => ({ ...buildOverview(ctx.industry, []), upcoming: [], attention: [] }));
  },
  table: (ctx, key) => {
    remember(ctx);
    if (key === 'customers') requirePerm(ctx, 'customers.read');
    else if (key === 'marketing') requirePerm(ctx, 'marketing.draft');
    else requirePerm(ctx, 'operations.read');
    const t = buildTable(ctx.industry, key, scopeIds(ctx));
    if (!t) return Promise.reject(new ApiError('not_found', 'This table does not exist for this industry.', 404));
    return read(() => t, (): TableData => ({ ...t, rows: [] }));
  },
  search: (ctx, q) =>
    read(() => {
      const needle = q.trim().toLowerCase();
      if (!needle) return [];
      const locs = visibleLocations(ctx.industry, ctx.role).filter((l) => l.name.toLowerCase().includes(needle) || l.address.city.toLowerCase().includes(needle));
      const people = st(ctx.industry).team.filter((p) => p.name.toLowerCase().includes(needle));
      const groups = [];
      if (locs.length && ctx.role !== 'staff') groups.push({ type: 'Locations', items: locs.map((l) => ({ id: l.id, label: l.name, sub: `${l.address.city} · ${l.currency} · ${l.timeZone}`, href: `/locations?open=${l.id}` })) });
      if (people.length && ctx.role === 'hq') groups.push({ type: 'Team', items: people.map((p) => ({ id: p.id, label: p.name, sub: p.assignments.map((a) => a.role).join(', '), href: '/team' })) });
      return groups;
    }, () => [], 180),
  notifications: (ctx) =>
    read(() => buildOverview(ctx.industry, scopeIds(ctx)).attention.map((a, i) => ({ id: a.id, kind: a.kind, title: a.title, at: minutesAgo(12 + i * 40), href: a.href })), () => [], 150),

  studios: {
    classes: (ctx, ws) => {
      requirePerm(ctx, 'operations.read');
      const ids = scopeIds(ctx);
      const occ = ids.flatMap((id) => classesFor(id, ws));
      return read(() => ({ timeZone: loc('studios', ids[0] ?? 'qw').timeZone, occurrences: occ }), () => ({ timeZone: 'UTC', occurrences: [] }));
    },
    cover: (ctx) => (requirePerm(ctx, 'operations.read'), read(() => st('studios').cover)),
    acceptCover: (_id, candidateId) =>
      write(() => {
        const c = st('studios').cover;
        c.status = 'accepted';
        c.candidates = c.candidates.map((x) => (x.id === candidateId ? { ...x, state: 'accepted' } : x));
        c.history.push({ at: now(), text: `${c.candidates.find((x) => x.id === candidateId)?.name} accepted the cover` });
        return c;
      }),
    approveCover: (_id) =>
      write(() => {
        if (lastCtx.role === 'staff') throw new ApiError('forbidden', 'A manager must confirm cover.', 403);
        const c = st('studios').cover;
        c.status = 'confirmed';
        c.candidates = c.candidates.map((x) => (x.state === 'accepted' ? { ...x, state: 'assigned' } : x));
        c.history.push({ at: now(), text: `Confirmed by ${sessionFor('studios', lastCtx.role).user.name}. Schedule, class page and ${c.bookedCustomers} customers updated together.` });
        return c;
      }, 1000),
    resetCover: () => write(() => (st('studios').cover = freshCover()), 200),
  },

  sports: {
    registrations: (ctx) => {
      requirePerm(ctx, 'operations.read');
      return read(() => st('sports').regs, () => ({ items: [], groups: st('sports').regs.groups }));
    },
    decide: (id, input) =>
      write(() => {
        if (lastCtx.role === 'staff') throw new ApiError('forbidden', 'Coaches can’t accept registrations.', 403);
        const s = st('sports').regs;
        const r = s.items.find((x) => x.id === id)!;
        if (input.decision === 'accept') {
          const g = s.groups.find((x) => x.id === input.groupId);
          if (!g) throw new ApiError('validation_error', 'Choose a group first.', 422, { groupId: 'Choose a group.' });
          if (g.roster >= g.capacity) throw new ApiError('group_full', `${g.name} is full. Choose another group or waitlist.`, 409);
          if (!r.formsComplete) throw new ApiError('forms_incomplete', 'Required forms are missing.', 422);
          g.roster += 1;
          r.status = 'accepted';
          r.groupId = g.id;
        } else r.status = 'waitlisted';
        return r;
      }),
    session: (ctx) =>
      (requirePerm(ctx, 'operations.read'),
      read(() => {
        const l = loc('sports', 'rp');
        return { id: 'ses_u10b', group: 'U10 Blue · Training', start: at(l.timeZone, '17:00'), timeZone: l.timeZone, venue: 'Riverside Park · Pitch 2', coach: 'Coach Ortiz', roster: ROSTER.map((n, i) => ({ id: `p${i}`, name: n })), submitted: st('sports').attendanceSubmitted };
      })),
    submitAttendance: (_sid, marks) =>
      write(() => {
        st('sports').attendanceSubmitted = true;
        return { ok: true as const, notifiedGuardians: Object.values(marks).filter((v) => v === 'absent').length };
      }, 800),
  },

  wellness: {
    day: (ctx) => {
      requirePerm(ctx, 'operations.read');
      const id = scopeIds(ctx)[0] ?? 'hf';
      return read(() => day(id), () => ({ ...day(id), appointments: [] }));
    },
    slots: async (apptId) => {
      await sleep(250);
      const d = Object.values(st('wellness').days).find((x) => x.appointments.some((a) => a.id === apptId)) ?? day('hf');
      const t = (ymd: string, hhmm: string) => zonedToUtc(ymd, hhmm, d.timeZone);
      return [
        { id: 's1', start: t(d.date, '15:30'), practitioner: 'Rina K.', room: 'Room B' },
        { id: 's2', start: t(d.date, '17:00'), practitioner: 'Rina K.', room: 'Room A' },
        { id: 's3', start: t(addDays(d.date, 1), '10:00'), practitioner: 'Rina K.', room: 'Room A' },
      ];
    },
    reschedule: async (apptId, slotId, opts) => {
      await sleep(1200);
      const d = Object.values(st('wellness').days).find((x) => x.appointments.some((a) => a.id === apptId));
      if (!d) throw new ApiError('not_found', 'Appointment not found.', 404);
      const slots = await rawMockApi.wellness.slots(apptId);
      const slot = slots.find((s) => s.id === slotId)!;
      if (opts?.simulateConflict && slot.room === 'Room B') throw new ApiError('slot_conflict', `${slot.room} was booked moments ago. The original time is unchanged and the client hasn’t been notified.`, 409);
      const a = d.appointments.find((x) => x.id === apptId)!;
      a.start = slot.start;
      a.room = slot.room;
      return clone(d);
    },
  },

  commerce: {
    orders: (ctx) => {
      requirePerm(ctx, 'operations.read');
      const ids = scopeIds(ctx);
      return read(() => st('commerce').orders.filter((o) => ids.includes(o.locationId)), () => []);
    },
    refund: async (orderId, lineIds) => {
      if (lastCtx.role !== 'hq' && lastCtx.role !== 'local') throw new ApiError('forbidden', 'You can’t refund orders.', 403);
      await sleep(1200);
      const o = st('commerce').orders.find((x) => x.id === orderId)!;
      const lines = o.lines.filter((l) => lineIds.includes(l.id));
      const amount = lines.reduce((s, l) => s + l.unit.amount * l.qty, 0);
      lines.forEach((l) => (l.refunded = true));
      o.refund = o.lines.every((l) => l.refunded) ? 'complete' : 'partial';
      const who = sessionFor('commerce', lastCtx.role).user.name;
      o.timeline.push({ at: now(), text: `Partial refund of ${(amount / 100).toFixed(2)} ${o.total.currency} requested by ${who}`, tone: 'warning', icon: 'undo' }, { at: now(), text: 'Refund complete · WooCommerce gateway confirmed (signed event)', tone: 'success', icon: 'check' });
      return clone(o);
    },
  },

  foods: {
    menu: (ctx, view) => (requirePerm(ctx, 'operations.read'), read(() => menuFor(ctx.industry, view))),
    resetMenuField: (view, itemId) =>
      write(() => {
        delete st('foods').overrides[`${view}:${itemId}`];
        return menuFor('foods', view);
      }, 500),
    orders: (ctx) => {
      requirePerm(ctx, 'operations.read');
      const ids = scopeIds(ctx);
      return read(() => st('foods').foodOrders.filter((o) => ids.includes(o.locationId)), () => []);
    },
    setOrderStatus: (id, status, reason) =>
      write(() => {
        const o = st('foods').foodOrders.find((x) => x.id === id);
        if (!o) throw new ApiError('not_found', 'Order not found.', 404);
        if (status === 'rejected' && !reason) throw new ApiError('validation_error', 'Give a reason for rejecting.', 422, { reason: 'Required' });
        o.status = status;
        if (status === 'rejected') o.notes = `Rejected: ${reason}. Refund started and customer notified.`;
        return o;
      }, 650),
    kitchen: (ctx) => {
      requirePerm(ctx, 'operations.read');
      const id = scopeIds(ctx)[0] ?? 'bl';
      const l = loc('foods', id);
      const offline = st('foods').connections === undefined ? false : st('foods').connections.some((c) => c.id === 'c_kds_fr' && c.state !== 'connected') && id === 'fr';
      return read(() => ({ locationId: id, locationName: l.name, timeZone: l.timeZone, connected: !offline, lastRefreshed: offline ? minutesAgo(28) : now(), orders: st('foods').foodOrders.filter((o) => o.locationId === id && !['collected', 'cancelled', 'rejected'].includes(o.status)) }), undefined, 250);
    },
  },

  websites: {
    page: (ctx, locationId) => {
      remember(ctx);
      requirePerm(ctx, 'website.edit');
      return read(() => page(ctx.industry, locationId));
    },
    saveField: (locId, key, value) =>
      write(() => {
        const p = page(lastCtx.industry, locId);
        const f = p.fields.find((x) => x.key === key)!;
        if (f.policy === 'locked' && lastCtx.role !== 'hq') throw new ApiError('forbidden', 'This field is locked by headquarters.', 403);
        if (f.policy === 'approval' && lastCtx.role !== 'hq') throw new ApiError('approval_required', 'This change needs headquarters approval.', 409);
        f.value = value;
        p.activity.unshift({ at: now(), text: `${sessionFor(lastCtx.industry, lastCtx.role).user.name} edited ${f.label} (draft)` });
        return p;
      }, 500),
    requestChange: (locId, key, value, reason) =>
      write(() => {
        const p = page(lastCtx.industry, locId);
        const f = p.fields.find((x) => x.key === key)!;
        if (!reason.trim()) throw new ApiError('validation_error', 'Add a reason for headquarters.', 422, { reason: 'Add a reason for headquarters.' });
        const who = sessionFor(lastCtx.industry, lastCtx.role).user.name;
        f.pending = { value, reason, requestedBy: who, at: now() };
        p.activity.unshift({ at: now(), text: `${who} requested a change to ${f.label}` });
        return p;
      }, 600),
    decide: (locId, key, decision, comment) =>
      write(() => {
        if (lastCtx.role !== 'hq') throw new ApiError('forbidden', 'Only headquarters can approve.', 403);
        const p = page(lastCtx.industry, locId);
        const f = p.fields.find((x) => x.key === key)!;
        if (decision === 'approve' && f.pending) f.value = f.pending.value;
        p.activity.unshift({ at: now(), text: `${sessionFor(lastCtx.industry, 'hq').user.name} ${decision === 'approve' ? 'approved' : 'rejected'} ${f.label}${comment ? ` · “${comment}”` : ''}` });
        f.pending = undefined;
        return p;
      }, 600),
    resetField: (locId, key) =>
      write(() => {
        const p = page(lastCtx.industry, locId);
        const f = p.fields.find((x) => x.key === key)!;
        if (f.hqValue != null) f.value = f.hqValue;
        p.activity.unshift({ at: now(), text: `${f.label} reset to the headquarters default` });
        return p;
      }, 400),
    approvals: (ctx) =>
      read((): ApprovalItem[] =>
        visibleLocations(ctx.industry, ctx.role).flatMap((l) =>
          page(ctx.industry, l.id).fields.filter((f) => f.pending).map((f) => ({ id: `${l.id}:${f.key}`, locationName: l.name, field: f.label, value: f.pending!.value, reason: f.pending!.reason, requestedBy: f.pending!.requestedBy, at: f.pending!.at })),
        ), () => []),
    publishPlan: (ctx) => {
      requirePerm(ctx, 'website.publish');
      if (ctx.role !== 'hq') return Promise.reject(new ApiError('forbidden', 'Group publishing is a headquarters action.', 403));
      return read(() => st(ctx.industry).plan);
    },
    publish: async () => {
      const s = st(lastCtx.industry);
      s.plan.targets.forEach((t) => (t.result = 'publishing'));
      await sleep(1600);
      const failIdx = s.plan.targets.length - 1;
      s.plan.targets.forEach((t, i) => {
        if (i === failIdx) {
          t.result = 'failed';
          t.error = 'Schedule block timed out after 30 s while rendering. The previous version is still live.';
          s.publishAttempts[t.locationId] = 1;
        } else t.result = 'published';
      });
      return clone(s.plan);
    },
    retry: async (_planId, locationId) => {
      const s = st(lastCtx.industry);
      const t = s.plan.targets.find((x) => x.locationId === locationId)!;
      t.result = 'publishing';
      await sleep(1300);
      t.result = 'published';
      t.error = undefined;
      return clone(s.plan);
    },
    sites: (ctx) =>
      read(() => {
        const f = FIXTURES[ctx.industry];
        const slug = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const ids = scopeIds(ctx);
        return f.locations
          .filter((l) => ids.includes(l.id))
          .map((l, i) => ({
            locationId: l.id,
            locationName: l.name,
            includedAddress: `https://sites.branchharbor.com/${slug(f.org.brand)}/${slug(l.name)}`,
            custom: i === 0 ? { host: `www.${slug(f.org.brand)}.example`, state: 'ready' as const } : i === 1 ? { host: `${slug(l.name.split(' – ').pop() ?? '')}.${slug(f.org.brand)}.example`, state: 'awaiting_dns' as const } : null,
            live: l.site === 'live',
          }));
      }, undefined, 150),
  },

  payments: {
    transactions: (ctx) => {
      requirePerm(ctx, 'payments.read');
      const ids = scopeIds(ctx);
      return read(() => st(ctx.industry).payments.tx.filter((t) => ids.includes(t.locationId)), () => []);
    },
    reconciliation: (ctx) => {
      requirePerm(ctx, 'payments.read');
      const ids = scopeIds(ctx);
      return read(() => st(ctx.industry).payments.rec.filter((t) => ids.includes(t.locationId)), () => []);
    },
    recreateOrder: async (id) => {
      await sleep(1300);
      const r = st(lastCtx.industry).payments.rec.find((x) => x.id === id)!;
      const who = sessionFor(lastCtx.industry, lastCtx.role).user.name;
      r.timeline.push({ at: now(), text: `${who} recreated the record in the next available slot`, tone: 'info', icon: 'refresh' }, { at: now(), text: 'Record #1047 created and linked to the payment · customer notified', tone: 'success', icon: 'check' });
      r.status = 'resolved';
      r.orderState = '#1047 created';
      r.resolution = 'Record #1047 created and linked to the payment.';
      return clone(r);
    },
    refund: async (id, confirm) => {
      const s = sessionFor(lastCtx.industry, lastCtx.role);
      if (!can(s.assignments, 'payments.refund')) throw new ApiError('forbidden', 'Refunds need finance permission.', 403);
      await sleep(1300);
      const r = st(lastCtx.industry).payments.rec.find((x) => x.id === id)!;
      if (confirm.amount !== r.amount.amount || confirm.currency !== r.amount.currency) throw new ApiError('confirmation_mismatch', 'The confirmed amount doesn’t match. Nothing was refunded.', 409);
      r.timeline.push({ at: now(), text: `Refund requested by ${s.user.name} (finance)`, tone: 'warning', icon: 'undo' }, { at: now(), text: 'Refund complete · customer emailed', tone: 'success', icon: 'check' });
      r.status = 'resolved';
      r.resolution = 'Payment refunded in full.';
      const t = st(lastCtx.industry).payments.tx.find((x) => x.externalRef === r.transactionRef);
      if (t) t.refund = 'complete';
      return clone(r);
    },
    accounts: (ctx) => {
      requirePerm(ctx, 'payments.read');
      return read(() =>
        visibleLocations(ctx.industry, ctx.role).map((l) => ({ locationId: l.id, provider: ctx.industry === 'commerce' ? 'WooCommerce gateway' : 'Stripe Connect', arrangement: l.ownership === 'franchise' ? ('own' as const) : ('shared' as const), status: l.site === 'unpublished' ? ('pending_verification' as const) : l.sync === 'attention' && ctx.industry === 'sports' ? ('not_set_up' as const) : ('enabled' as const), capabilities: l.site === 'unpublished' ? [] : ['Card payments', 'Refunds', ...(l.currency === 'EUR' ? ['SEPA debit'] : []), ...(l.currency === 'GBP' ? ['Bacs debit'] : [])] })),
      );
    },
  },

  connections: {
    list: (ctx) => {
      requirePerm(ctx, 'locations.read');
      return read(() => st(ctx.industry).connections, () => []);
    },
    fix: async (id) => {
      if (lastCtx.role !== 'hq') throw new ApiError('forbidden', 'Ask headquarters to manage connections.', 403);
      await sleep(1400);
      const c = st(lastCtx.industry).connections.find((x) => x.id === id)!;
      Object.assign(c, { state: 'connected', lastSync: now(), issue: undefined, affected: undefined, fixAction: undefined });
      return clone(c);
    },
  },

  team: {
    members: (ctx) => (requirePerm(ctx, 'members.manage'), read(() => st(ctx.industry).team, () => [])),
    schedule: (ctx, weekStart) => {
      requirePerm(ctx, 'operations.read');
      const ids = scopeIds(ctx);
      const from = zonedToUtc(weekStart, '00:00', 'UTC');
      const to = zonedToUtc(addDays(weekStart, 7), '00:00', 'UTC');
      return read(() => shiftsOf(ctx.industry).filter((x) => ids.includes(x.locationId) && x.end > from && x.start < to), () => []);
    },
    invite: (input) =>
      write(() => {
        if (!/^\S+@\S+\.\S+$/.test(input.email)) throw new ApiError('validation_error', 'Check the highlighted fields.', 422, { email: 'Enter a valid email.' });
        const mem: Member = { id: `mem_${Date.now()}`, name: input.email, email: input.email, assignments: [{ role: input.role, scopeLabel: input.scopeLabel }], lastActive: 'Invitation sent just now', status: 'invited' };
        st(lastCtx.industry).team.push(mem);
        return mem;
      }),
  },

  approvals: {
    list: (ctx, status) => {
      remember(ctx);
      requirePerm(ctx, 'locations.read');
      return read(() => approvalsOf(ctx.industry).filter((a) => (status === 'pending' ? a.status === 'pending' : a.status !== 'pending')), () => []);
    },
    decide: (id, decision, comment) =>
      write(() => {
        const a = approvalsOf(lastCtx.industry).find((x) => x.id === id);
        if (!a) throw new ApiError('not_found', 'Approval not found.', 404);
        if (a.status !== 'pending') throw new ApiError('already_decided', `This request was already ${a.status}.`, 409);
        if (!a.canDecide) throw new ApiError('forbidden', 'You cannot decide this request.', 403);
        if (decision === 'reject' && (a.kind === 'field' || a.kind === 'page') && !comment) throw new ApiError('validation_error', 'Explain why the change was rejected.', 400, { comment: 'Required when rejecting' });
        a.status = decision === 'approve' ? 'approved' : 'rejected';
        a.decidedBy = sessionFor(lastCtx.industry, lastCtx.role).user.name;
        a.decisionComment = comment ?? null;
        a.canDecide = false;
        a.result = decision === 'reject' ? null : a.kind === 'refund' ? 'Refund complete' : a.kind === 'ad_spend' ? 'Campaign scheduled' : a.kind === 'shift_swap' ? 'Shift reassigned' : 'Change applied';
        if (a.kind === 'shift_swap' && decision === 'approve') for (const sh of shiftsOf(lastCtx.industry)) if (sh.pendingSwap?.approvalId === a.id) Object.assign(sh, { person: sh.pendingSwap.to, pendingSwap: null });
        return a;
      }),
  },

  reports: (ctx) => {
    requirePerm(ctx, 'reports.read');
    const ids = scopeIds(ctx);
    return read((): Report[] => {
      const f = FIXTURES[ctx.industry];
      const locs = f.locations.filter((l) => ids.includes(l.id));
      const short = (n: string) => n.split(' – ').pop()!.split(' ')[0]!;
      const reports: Report[] = [
        { id: 'enq', title: 'Enquiries by location · 30 days', freshness: 'Updated 4 min ago', unit: 'count', bars: locs.map((l, i) => ({ label: short(l.name), value: [42, 31, 28, 19, 24, 9, 17][i % 7]! })), note: 'Source: website forms. Attribution beyond the form source is not measured.' },
      ];
      const byCur = new Map<Currency, typeof locs>();
      for (const l of locs) byCur.set(l.currency, [...(byCur.get(l.currency) ?? []), l]);
      for (const [cur, ls] of byCur) {
        reports.push({ id: `rev_${cur}`, title: `Revenue · ${cur} · 7 days`, freshness: 'Stripe · 6 min ago', unit: 'money', currency: cur, bars: ls.map((l) => ({ label: short(l.name), value: l.revenue7d.amount > 0 ? l.revenue7d.amount : null })), note: ls.some((l) => l.revenue7d.amount === 0) ? 'Missing bars are Unavailable or Not connected — never zero. Refunds shown separately.' : 'Refunds shown separately.' });
      }
      reports.push({ id: 'cmb', title: 'Combined revenue', freshness: 'Not calculated', unit: 'money', bars: [], note: byCur.size > 1 ? `Not shown: no conversion method is defined for ${[...byCur.keys()].join(' + ')}.` : 'Only one currency in this scope.' });
      reports.push({ id: 'occ', title: ctx.industry === 'foods' ? 'Pickup capacity used where connected' : 'Occupancy where connected', freshness: 'Booking system · some locations stale', stale: locs.some((l) => l.sync === 'attention'), unit: 'percent', bars: locs.map((l, i) => ({ label: short(l.name), value: l.sync === 'attention' || l.site === 'unpublished' ? null : [78, 64, 71, 59, 66, 70, 62][i % 7]! })), note: 'Missing bars mean Unavailable or Not connected, never zero.' });
      return reports;
    }, () => []);
  },

  settings: {
    get: (ctx) => {
      requirePerm(ctx, 'org.manage');
      const f = FIXTURES[ctx.industry];
      const s = st(ctx.industry);
      s.settings ??= {
        businessName: f.org.name, legalName: `${f.org.name} (sample)`, defaultLocale: f.org.defaultLocale, defaultCurrency: f.org.defaultCurrency, defaultTimeZone: f.org.defaultTimeZone, dataRegion: f.org.dataRegion, customerSharing: 'totals_only', aiTraining: false,
        billing: { plan: 'Network (sample pricing)', perLocation: m(79, f.org.defaultCurrency), locations: f.locations.map((l) => ({ locationId: l.id, status: l.site === 'live' ? 'billed' : 'not_billed_until_published' })), nextInvoice: addDays(dateInZone(new Date(), 'UTC'), 17) },
      };
      return read(() => s.settings!);
    },
    save: (ctx, input) =>
      write(() => {
        const s = st(ctx.industry);
        if (input.defaultTimeZone && !isValidTimeZone(input.defaultTimeZone)) throw new ApiError('validation_error', 'Check the highlighted fields.', 422, { defaultTimeZone: 'Not a recognised time zone.' });
        s.settings = { ...s.settings!, ...input };
        return s.settings;
      }),
  },

  onboarding: {
    get: async () => {
      await sleep(200);
      try {
        const raw = localStorage.getItem(ONB_KEY);
        return raw ? (JSON.parse(raw) as OnboardingProgress) : null;
      } catch {
        return null;
      }
    },
    save: async (p) => {
      await sleep(250);
      const saved = { ...p, savedAt: now() };
      try {
        localStorage.setItem(ONB_KEY, JSON.stringify(saved));
      } catch {
        /* storage unavailable: progress kept for this session only */
      }
      return saved;
    },
    validateImport: async (csv) => {
      await sleep(700);
      const lines = csv.trim().split(/\r?\n/).filter(Boolean);
      const header = (lines.shift() ?? '').split(',').map((h) => h.trim().toLowerCase());
      const col = (name: string) => header.indexOf(name);
      const codes = new Set<string>();
      return lines.map((line, i): ImportRow => {
        const c = line.split(',').map((x) => x.trim());
        const row = { row: i + 2, name: c[col('name')] ?? '', code: c[col('code')] ?? '', country: (c[col('country')] ?? '').toUpperCase(), timeZone: c[col('timezone')] ?? '', currency: (c[col('currency')] ?? '').toUpperCase(), errors: [] as ImportRow['errors'] };
        if (!row.name) row.errors.push({ field: 'name', message: 'Name is required' });
        if (!row.code) row.errors.push({ field: 'code', message: 'Internal code is required' });
        else if (codes.has(row.code)) row.errors.push({ field: 'code', message: `Duplicate code ${row.code}` });
        codes.add(row.code);
        const country = LAUNCH_COUNTRIES.find((x) => x.code === row.country);
        if (!country) row.errors.push({ field: 'country', message: row.country ? `${row.country} isn’t a supported country yet` : 'Country is required' });
        if (!row.timeZone) row.errors.push({ field: 'timeZone', message: 'Time zone missing' });
        else if (!isValidTimeZone(row.timeZone)) row.errors.push({ field: 'timeZone', message: `“${row.timeZone}” isn’t a valid time zone` });
        if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(row.currency)) row.errors.push({ field: 'currency', message: 'Currency not supported' });
        else if (country && country.currency !== row.currency) row.errors.push({ field: 'currency', message: `Expected ${country.currency} for ${country.name} — confirm before import` });
        return row;
      });
    },
    domain: async (hostname) => {
      await sleep(400);
      const d = (domains[hostname] ??= { attempts: 0, phase: 0 });
      if (d.verifiedAt) {
        const elapsed = Date.now() - d.verifiedAt;
        const state = elapsed < 1500 ? 'verifying' : elapsed < 3200 ? 'certificate_pending' : 'ready';
        return { hostname, state, records: domainRecords(hostname, [true, true]), message: state === 'certificate_pending' ? 'Issuing the security certificate. Your included address keeps working meanwhile.' : undefined };
      }
      return { hostname, state: 'awaiting_dns', records: domainRecords(hostname, [false, false]) };
    },
    verifyDomain: async (hostname) => {
      await sleep(1300);
      const d = (domains[hostname] ??= { attempts: 0, phase: 0 });
      d.attempts += 1;
      if (d.attempts === 1) return { hostname, state: 'failed', records: domainRecords(hostname, [true, false]), message: `We found the TXT record, but the CNAME for ${hostname} doesn’t point to sites.branchharbor.com yet. DNS changes can take a few hours to spread.` };
      d.verifiedAt = Date.now();
      return { hostname, state: 'verifying', records: domainRecords(hostname, [true, true]) };
    },
  },

  ai: {
    suggestions: (ctx) => read(() => AI[ctx.industry].suggestions, undefined, 120),
    ask: async (ctx, question) => {
      await sleep(1100);
      if (demo() === 'ai-down') throw new ApiError('ai_unavailable', 'BranchHarbor AI is unavailable right now. Everything else keeps working.', 503);
      const a = AI[ctx.industry];
      const label = scopeOptions(ctx.industry, ctx.role).find((o) => o.id === ctx.scopeId)?.label ?? 'All authorised locations';
      const wantsAction = /draft|campaign|plan|notice|reply|send|promotion/i.test(question);
      const perm = a.action.kind === 'draft' ? 'marketing.draft' : 'marketing.publish';
      return {
        id: `ai_${Date.now()}`, question,
        answer: a.answer,
        assumptions: `${a.assumptions} Scope: ${label}.`,
        sources: a.sources.map(([l, fr]) => ({ label: l, freshness: fr })),
        action: wantsAction ? { id: 'act_1', title: a.action.title, kind: a.action.kind, affected: a.action.affected, excluded: a.action.excluded, requires: perm } : undefined,
      };
    },
  },
};

/** Records the request context of every call (as the server would via the session), so writes act on the right tenant. */
function withContext<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const v = Reflect.get(obj, prop, recv) as unknown;
      if (typeof v === 'function')
        return (...args: unknown[]) => {
          const c = args[0] as Partial<RequestContext> | undefined;
          if (c && typeof c === 'object' && 'industry' in c && 'role' in c && 'scopeId' in c) remember(c as RequestContext);
          return (v as (...a: unknown[]) => unknown).apply(obj, args);
        };
      if (v && typeof v === 'object') return withContext(v as object);
      return v;
    },
  });
}

export const mockApi: BranchHarborApi = withContext(rawMockApi);
