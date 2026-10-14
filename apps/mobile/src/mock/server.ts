/**
 * In-process mock of the BranchHarbor /v1 API. Used when EXPO_PUBLIC_USE_MOCKS=true so the app runs
 * without apps/api. It honours the same contracts and error shape ({ error: { code, message, fields } })
 * and simulates latency, holds that expire, slot exhaustion, and server-acknowledged status changes.
 */
import { totalsByCurrency } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { addDaysKey, localDateKey, zonedToUtcIso } from '@/lib/format';
import type {
  Approval, AppNotification, AttendanceStatus, Booking, ClassOccurrence, CoverRequest, FoodOrder, FoodOrderStatus,
  KitchenOrder, Location, Me, Message, OrderLine, OrderLineInput, PickupSlot, Preferences, Pulse, RosterEntry, Shift,
  StaffMessage, StaffSession, Money,
} from '@/lib/types';
import { BRANDS, CLASS_PRICE, CLASS_TEMPLATES, IMG, LOCATIONS, menuFor } from './data';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const iso = (t: number) => new Date(t).toISOString();
const MIN = 60_000;
const HOLD_MS = 5 * MIN;
let idSeq = 100;
const nid = (p: string) => `${p}_${++idSeq}`;

const fail = (status: number, code: string, message: string, fields?: Record<string, string>): never => {
  throw new ApiError(status, code, message, fields);
};
const loc = (id: string): Location => LOCATIONS.find((l) => l.id === id) ?? fail(404, 'not_found', 'Location not found');

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ---------------- state ----------------
const state = {
  me: null as Me | null,
  bookings: [] as Booking[],
  bookedDelta: new Map<string, number>(),
  orders: [] as FoodOrder[],
  slotsTaken: new Map<string, number>(),
  messages: [] as Message[],
  prefs: {
    locale: 'en',
    channels: { push: { reminders: true, marketing: false }, email: { reminders: true, marketing: true }, sms: { reminders: false, marketing: false } },
  } as Preferences,
  roster: new Map<string, RosterEntry[]>(),
  kitchen: [] as KitchenOrder[],
  lastKitchenSpawn: now(),
  shifts: [] as Shift[],
  cover: [] as CoverRequest[],
  approvals: [] as Approval[],
  seeded: false,
};

function occurrence(locationId: string, dateKey: string, idx: number): ClassOccurrence {
  const l = loc(locationId);
  const t = CLASS_TEMPLATES[idx] ?? fail(404, 'not_found', 'Class not found');
  const id = `${locationId}~${dateKey}~${idx}`;
  // Slow Flow (idx 1) is always full so the waitlist path is visible.
  const base = idx === 1 ? t.capacity : Math.min(t.capacity, hash(id) % (t.capacity + 3));
  const booked = Math.min(t.capacity, base + (state.bookedDelta.get(id) ?? 0));
  return {
    id, locationId, name: t.name, instructor: t.instructor, room: t.room, durationMin: t.durationMin, capacity: t.capacity, booked,
    startsAt: zonedToUtcIso(dateKey, t.time, l.timeZone), price: { amount: CLASS_PRICE[l.currency] ?? 2500, currency: l.currency }, image: t.image,
  };
}
function occurrenceById(id: string) {
  const [locationId, dateKey, idx] = id.split('~');
  if (!locationId || !dateKey || idx === undefined) return fail(404, 'not_found', 'Class not found');
  return occurrence(locationId, dateKey, Number(idx));
}
function bookingFrom(o: ClassOccurrence, status: Booking['status'], extra: Partial<Booking> = {}): Booking {
  return { id: nid('bkg'), occurrenceId: o.id, className: o.name, instructor: o.instructor, locationId: o.locationId, startsAt: o.startsAt, durationMin: o.durationMin, status, price: o.price, ...extra };
}

function seed() {
  if (state.seeded) return;
  state.seeded = true;
  const qw = loc('sw-qw');
  const today = localDateKey(new Date(), qw.timeZone);
  state.bookings.push(
    bookingFrom(occurrence('sw-qw', addDaysKey(today, 1), 0), 'confirmed'),
    bookingFrom(occurrence('sw-qw', addDaysKey(today, 3), 4), 'waitlisted', { waitlistPosition: 2 }),
    bookingFrom(occurrence('sw-qw', addDaysKey(today, -2), 2), 'attended'),
    bookingFrom(occurrence('sw-qw', addDaysKey(today, -6), 0), 'cancelled'),
  );
  // Within-policy-window booking (starts in ~5 hours) to show the late-cancellation message.
  const soon = occurrence('sw-qw', today, 3);
  state.bookings.push({ ...bookingFrom(soon, 'confirmed'), startsAt: iso(now() + 5 * 60 * MIN) });

  for (const l of LOCATIONS) {
    state.messages.push(
      { id: nid('msg'), locationId: l.id, from: 'system', kind: 'reminder', author: 'Reminder', body: l.brandId === 'maple' ? 'Pickup orders now open from 11:00 every day.' : 'Your Morning Vinyasa is tomorrow. Bring water — mats are provided.', at: iso(now() - 60 * MIN) },
      { id: nid('msg'), locationId: l.id, from: 'system', kind: 'offer', author: 'Offer', body: `${l.name}: bring a friend free this week.`, at: iso(now() - 26 * 60 * MIN) },
      { id: nid('msg'), locationId: l.id, from: 'location', kind: 'message', author: l.name, body: 'Thanks for visiting! How did we do?', at: iso(now() - 50 * 60 * MIN) },
    );
  }

  const tzStaff = qw.timeZone;
  const k = localDateKey(new Date(), tzStaff);
  state.shifts = [
    { id: 'sh1', locationId: 'sw-qw', role: 'Instructor', startsAt: zonedToUtcIso(k, '06:30', tzStaff), endsAt: zonedToUtcIso(k, '13:00', tzStaff) },
    { id: 'sh2', locationId: 'me-bl', role: 'Kitchen lead', startsAt: zonedToUtcIso(localDateKey(new Date(), 'America/Los_Angeles'), '16:00', 'America/Los_Angeles'), endsAt: zonedToUtcIso(localDateKey(new Date(), 'America/Los_Angeles'), '22:00', 'America/Los_Angeles') },
  ];

  const names: [string, string][] = [
    ['Hana S.', '10-class pack · 3 left'], ['Leo M.', 'Unlimited monthly'], ['Priya N.', 'First class · intro week'],
    ['Chris W.', 'Drop-in · paid online'], ['Grace L.', 'Waitlist → booked 6:42 am'], ['Tom R.', 'Class pass'],
  ];
  for (const s of staffSessions()) {
    state.roster.set(s.id, names.slice(0, s.rosterCount).map(([displayName, note], i) => ({ id: `${s.id}-r${i}`, displayName, note, status: 'unmarked' as AttendanceStatus })));
  }

  const t = now();
  state.kitchen = [
    kitchenOrder('1044', 'Mara', 'accepted', t - 22 * MIN, t - 4 * MIN, [{ quantity: 1, name: 'Wood-fired flatbread', options: ['Large'] }], 'No basil'),
    kitchenOrder('1045', 'Jon', 'preparing', t - 14 * MIN, t + 3 * MIN, [{ quantity: 1, name: 'Smoked brisket sandwich', options: ['Gluten-free bun'] }]),
    kitchenOrder('1046', 'Aiko', 'awaiting_acceptance', t - 2 * MIN, t + 18 * MIN, [{ quantity: 2, name: 'Ember chicken bowl', options: ['Brown rice', 'Extra chicken'] }], 'Allergy: sesame'),
    kitchenOrder('1043', 'Sam', 'ready', t - 30 * MIN, t - 1 * MIN, [{ quantity: 1, name: 'Garden tomato salad', options: [] }, { quantity: 2, name: 'Maple lemonade', options: [] }]),
  ];

  state.cover = [
    { id: 'cv1', sessionName: 'Yin & Restore', locationId: 'sw-qw', startsAt: iso(t + 2 * 24 * 60 * MIN), requestedBy: 'Jordan Lee', mine: false, status: 'open' },
    { id: 'cv2', sessionName: 'Lunchtime Pilates', locationId: 'sw-qw', startsAt: iso(t + 4 * 24 * 60 * MIN), requestedBy: 'Ana Silva', mine: false, status: 'open' },
  ];

  state.approvals = [
    { id: 'ap1', kind: 'refund', title: '10-class pack · Chris W.', locationId: 'sw-qw', locationName: 'Stillwater Yoga Queen West', requestedBy: 'Lakeshore Holdings', requestedAt: iso(t - 90 * MIN), amount: { amount: 24000, currency: 'CAD' }, reason: 'Customer relocated', status: 'pending' },
    { id: 'ap2', kind: 'ad_spend', title: 'Community open day', locationId: 'sw-sd', locationName: 'Stillwater Yoga Shoreditch', requestedBy: 'Ines Duarte', requestedAt: iso(t - 5 * 60 * MIN), amount: { amount: 45000, currency: 'GBP' }, channel: 'Meta', days: 14, status: 'pending' },
    { id: 'ap3', kind: 'shift_swap', title: 'Tue close', locationId: 'sw-qw', locationName: 'Stillwater Yoga Queen West', requestedBy: 'Sam Tran', requestedAt: iso(t - 3 * 60 * MIN), swap: { a: 'Sam Tran', b: 'Jordan Lee', session: 'Yin & Restore · Tue 6:30 pm' }, status: 'pending' },
    { id: 'ap4', kind: 'refund', title: 'Pickup order #1031', locationId: 'me-kz', locationName: 'Maple & Ember Kreuzberg', requestedBy: 'Kitchen · Kreuzberg', requestedAt: iso(t - 30 * MIN), amount: { amount: 1840, currency: 'EUR' }, reason: 'Item unavailable after payment', status: 'pending' },
    { id: 'ap5', kind: 'ad_spend', title: 'Lunch launch', locationId: 'sw-sh', locationName: 'Stillwater Yoga Surry Hills', requestedBy: 'Coastline Wellness', requestedAt: iso(t - 26 * 60 * MIN), amount: { amount: 60000, currency: 'AUD' }, channel: 'Google', days: 21, status: 'pending' },
  ];
}

function kitchenOrder(number: string, firstName: string, status: FoodOrderStatus, created: number, promised: number, lines: KitchenOrder['lines'], notes?: string): KitchenOrder {
  return { id: `ko_${number}`, number: `#${number}`, firstName, status, createdAt: iso(created), promisedAt: iso(promised), lines, notes };
}

function staffSessions(): StaffSession[] {
  const l = loc('sw-qw');
  const k = localDateKey(new Date(), l.timeZone);
  return [0, 2, 3].map((idx, i) => {
    const o = occurrence('sw-qw', k, idx);
    return { id: `ss${i}`, locationId: 'sw-qw', name: o.name, room: o.room, startsAt: o.startsAt, durationMin: o.durationMin, rosterCount: [6, 5, 4][i] ?? 4 };
  });
}

// ---------------- orders ----------------
function quote(l: Location, lines: OrderLineInput[]) {
  const menu = menuFor(l.currency);
  const out: OrderLine[] = lines.map((ln) => {
    const item = menu.find((m) => m.id === ln.itemId) ?? fail(422, 'invalid_item', 'Item not found');
    if (item.soldOut) fail(409, 'sold_out', `${item.name} just sold out.`);
    const opts = item.modifierGroups.flatMap((g) => g.options).filter((o) => ln.optionIds.includes(o.id));
    const sold = opts.find((o) => o.soldOut);
    if (sold) fail(409, 'sold_out', `${sold.name} is sold out.`);
    const unit = item.price.amount + opts.reduce((a, o) => a + o.price.amount, 0);
    return { itemId: item.id, name: item.name, quantity: ln.quantity, options: opts.map((o) => o.name), lineTotal: { amount: unit * ln.quantity, currency: l.currency } };
  });
  const subtotal = out.reduce((a, x) => a + x.lineTotal.amount, 0);
  let tax: Money | null = null;
  let total = subtotal;
  if (l.tax) {
    if (l.tax.inclusive) tax = { amount: Math.round((subtotal * l.tax.rateBps) / (10000 + l.tax.rateBps)), currency: l.currency };
    else {
      tax = { amount: Math.round((subtotal * l.tax.rateBps) / 10000), currency: l.currency };
      total = subtotal + tax.amount;
    }
  }
  return {
    lines: out, subtotal: { amount: subtotal, currency: l.currency }, tax,
    taxLabel: l.tax ? `${l.tax.label} ${(l.tax.rateBps / 100).toLocaleString('en', { maximumFractionDigits: 2 })}%` : null,
    taxInclusive: !!l.tax?.inclusive, total: { amount: total, currency: l.currency },
  };
}

function pickupSlots(l: Location): PickupSlot[] {
  const start = Math.ceil((now() + 25 * MIN) / (15 * MIN)) * 15 * MIN;
  return Array.from({ length: 8 }, (_, i) => {
    const at = start + i * 15 * MIN;
    const id = `${l.id}@${at}`;
    const capacity = i === 5 ? 0 : [8, 6, 8, 3, 1, 0, 6, 8][i] ?? 6;
    return { id, startsAt: iso(at), remaining: Math.max(0, capacity - (state.slotsTaken.get(id) ?? 0)) };
  });
}

/** Simulated restaurant progression for customer orders. */
function progressed(o: FoodOrder): FoodOrder {
  if (o.status === 'rejected' || o.status === 'cancelled' || o.status === 'collected') return o;
  const age = now() - new Date(o.createdAt).getTime();
  const status: FoodOrderStatus = age < 12_000 ? 'awaiting_acceptance' : age < 30_000 ? 'accepted' : age < 55_000 ? 'preparing' : 'ready';
  return { ...o, status };
}

// ---------------- router ----------------
type Handler = (m: RegExpMatchArray, body: any, query: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

const demoMe = (name: string, email: string | null, guest = false): Me => ({
  user: { id: guest ? 'guest' : 'usr_demo', name, email, avatar: guest ? undefined : IMG.pW4 },
  assignments: guest ? [{ role: 'customer', scope: { kind: 'organization', id: 'stillwater' } }] : [
    { role: 'customer', scope: { kind: 'organization', id: 'stillwater' } },
    { role: 'staff', scope: { kind: 'location', id: 'sw-qw' } },
    { role: 'staff', scope: { kind: 'location', id: 'me-bl' } },
    { role: 'hq_admin', scope: { kind: 'organization', id: 'stillwater' } },
  ],
  experiences: guest ? ['customer'] : ['customer', 'staff', 'owner'],
  guest,
});

on('POST', /^\/auth\/sign-in$/, (_m, b) => {
  const fields: Record<string, string> = {};
  if (!b?.email || !/\S+@\S+\.\S+/.test(b.email)) fields.email = 'Enter a valid email address.';
  if (!b?.password || String(b.password).length < 6) fields.password = 'Use at least 6 characters.';
  if (Object.keys(fields).length) fail(422, 'validation_failed', 'Check the highlighted fields.', fields);
  if (b.password === 'wrongpass') fail(401, 'invalid_credentials', 'Email or password is incorrect.');
  const raw = String(b.email).split('@')[0] ?? 'Member';
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  state.me = demoMe(name, b.email);
  return { token: `mock.${Date.now()}`, me: state.me };
});
on('POST', /^\/auth\/guest$/, () => {
  state.me = demoMe('Guest', null, true);
  return { token: `mock.guest.${Date.now()}`, me: state.me };
});
// A stored token survives app restarts; the in-memory mock resumes as the demo member.
on('GET', /^\/auth\/me$/, () => (state.me ??= demoMe('Hana', 'hana@example.com')));
on('POST', /^\/auth\/sign-out$/, () => {
  state.me = null;
  return undefined;
});

on('GET', /^\/brands$/, () => BRANDS);
on('GET', /^\/locations$/, (_m, _b, qs) => (qs.get('brandId') ? LOCATIONS.filter((l) => l.brandId === qs.get('brandId')) : LOCATIONS));
on('GET', /^\/locations\/([^/]+)\/classes$/, (m, _b, qs) => {
  const l = loc(m[1]!);
  if (l.status !== 'operating') return [];
  const date = qs.get('date') ?? localDateKey(new Date(), l.timeZone);
  return CLASS_TEMPLATES.map((_, i) => occurrence(l.id, date, i));
});
on('GET', /^\/class-occurrences\/([^/]+)$/, (m) => occurrenceById(decodeURIComponent(m[1]!)));
on('POST', /^\/bookings$/, (_m, b) => {
  const o = occurrenceById(b.occurrenceId);
  if (new Date(o.startsAt).getTime() < now()) fail(409, 'class_started', 'This class has already started.');
  if (state.bookings.some((x) => x.occurrenceId === o.id && ['confirmed', 'held'].includes(x.status)))
    fail(409, 'duplicate_booking', 'You’re already booked into this class.');
  if (o.booked >= o.capacity) fail(409, 'class_full', 'This class just filled up. You can join the waitlist.');
  state.bookedDelta.set(o.id, (state.bookedDelta.get(o.id) ?? 0) + 1);
  const bk = bookingFrom(o, 'held', { holdExpiresAt: iso(now() + HOLD_MS) });
  state.bookings.push(bk);
  return bk;
});
on('POST', /^\/bookings\/([^/]+)\/confirm$/, (m) => {
  const bk = state.bookings.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Booking not found');
  if (bk.status === 'held' && bk.holdExpiresAt && new Date(bk.holdExpiresAt).getTime() < now()) {
    bk.status = 'cancelled';
    state.bookedDelta.set(bk.occurrenceId, (state.bookedDelta.get(bk.occurrenceId) ?? 1) - 1);
    fail(409, 'hold_expired', 'Your hold expired and the spot was released. You weren’t charged.');
  }
  bk.status = 'confirmed';
  bk.holdExpiresAt = undefined;
  return bk;
});
on('POST', /^\/waitlist$/, (_m, b) => {
  const o = occurrenceById(b.occurrenceId);
  const bk = bookingFrom(o, 'waitlisted', { waitlistPosition: 3 });
  state.bookings.push(bk);
  return bk;
});
on('GET', /^\/me\/bookings$/, () => state.bookings.filter((b) => b.status !== 'held').sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
on('POST', /^\/bookings\/([^/]+)\/cancel$/, (m) => {
  const bk = state.bookings.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Booking not found');
  if (bk.status === 'cancelled') return bk;
  if (bk.status === 'confirmed' || bk.status === 'held') state.bookedDelta.set(bk.occurrenceId, (state.bookedDelta.get(bk.occurrenceId) ?? 1) - 1);
  bk.status = 'cancelled';
  return bk;
});

on('GET', /^\/locations\/([^/]+)\/menu$/, (m) => menuFor(loc(m[1]!).currency));
on('GET', /^\/locations\/([^/]+)\/pickup-slots$/, (m) => pickupSlots(loc(m[1]!)));
on('POST', /^\/locations\/([^/]+)\/orders\/quote$/, (m, b) => quote(loc(m[1]!), b.lines ?? []));
on('POST', /^\/orders$/, (_m, b) => {
  const l = loc(b.locationId);
  const fields: Record<string, string> = {};
  if (!b.name?.trim()) fields.name = 'Required';
  if (!b.phone?.trim()) fields.phone = 'Required';
  if (Object.keys(fields).length) fail(422, 'validation_failed', 'Check the highlighted fields.', fields);
  if (!b.lines?.length) fail(422, 'empty_order', 'Your order is empty.');
  const slot = pickupSlots(l).find((s) => s.id === b.slotId) ?? fail(409, 'slot_unavailable', 'That pickup time is no longer available.');
  if (slot.remaining <= 0) fail(409, 'slot_full', 'That pickup time just filled up.');
  state.slotsTaken.set(slot.id, (state.slotsTaken.get(slot.id) ?? 0) + 1);
  const qd = quote(l, b.lines);
  const order: FoodOrder = { id: nid('ord'), number: `#${1047 + state.orders.length}`, locationId: l.id, status: 'awaiting_acceptance', pickupAt: slot.startsAt, customerName: b.name, notes: b.notes, createdAt: iso(now()), ...qd };
  state.orders.unshift(order);
  return order;
});
on('GET', /^\/orders\/([^/]+)$/, (m) => progressed(state.orders.find((o) => o.id === m[1]) ?? fail(404, 'not_found', 'Order not found')));
on('GET', /^\/me\/orders$/, () => state.orders.map(progressed));
on('POST', /^\/payments\/intents$/, (_m, b) => {
  let amount: Money = { amount: 0, currency: 'USD' };
  let merchant = 'BranchHarbor';
  if (b.kind === 'booking') {
    const bk = state.bookings.find((x) => x.id === b.id) ?? fail(404, 'not_found', 'Booking not found');
    amount = bk.price;
    merchant = `Stillwater Yoga ${loc(bk.locationId).name}`;
  } else if (b.kind === 'order') {
    const o = state.orders.find((x) => x.id === b.id) ?? fail(404, 'not_found', 'Order not found');
    amount = o.total;
    merchant = `Maple & Ember ${loc(o.locationId).name}`;
  }
  return { clientSecret: `pi_mock_${Date.now()}_secret_mock`, amount, merchantDisplayName: merchant };
});

on('GET', /^\/me\/messages$/, (_m, _b, qs) => state.messages.filter((x) => x.locationId === qs.get('locationId')).sort((a, b) => b.at.localeCompare(a.at)));
on('POST', /^\/me\/messages$/, (_m, b) => {
  if (!String(b.body ?? '').trim()) fail(422, 'validation_failed', 'Write a message first.', { body: 'Required' });
  const msg: Message = { id: nid('msg'), locationId: b.locationId, from: 'customer', kind: 'message', author: 'You', body: String(b.body).trim(), at: iso(now()) };
  state.messages.push(msg);
  return msg;
});
on('GET', /^\/me\/preferences$/, () => state.prefs);
on('PUT', /^\/me\/preferences$/, (_m, b) => (state.prefs = b));
on('POST', /^\/me\/data-requests$/, (_m, b) => ({ id: nid('dr'), kind: b.kind, status: 'received', reference: `DR-${String(Date.now()).slice(-6)}` }));

// staff
on('GET', /^\/staff\/shifts$/, () => state.shifts);
on('POST', /^\/staff\/shifts\/([^/]+)\/clock-in$/, (m) => {
  const s = state.shifts.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Shift not found');
  s.clockedInAt = s.clockedInAt ?? iso(now());
  return s;
});
on('GET', /^\/staff\/sessions$/, () => staffSessions());
on('GET', /^\/staff\/sessions\/([^/]+)\/roster$/, (m) => state.roster.get(m[1]!) ?? []);
on('PUT', /^\/staff\/sessions\/([^/]+)\/attendance\/([^/]+)$/, (m, b) => {
  const r = state.roster.get(m[1]!)?.find((x) => x.id === m[2]) ?? fail(404, 'not_found', 'Not on roster');
  r.status = b.status;
  return { ...r };
});
on('GET', /^\/kitchen\/orders$/, () => {
  if (now() - state.lastKitchenSpawn > 45_000 && state.kitchen.filter((k) => !['collected', 'rejected'].includes(k.status)).length < 7) {
    state.lastKitchenSpawn = now();
    const n = String(1047 + state.kitchen.length);
    state.kitchen.push(kitchenOrder(n, ['Lena', 'Omar', 'Ruth', 'Kai'][Number(n) % 4]!, 'awaiting_acceptance', now(), now() + 20 * MIN, [{ quantity: 1, name: 'Ember chicken bowl', options: ['Jasmine rice'] }]));
  }
  return state.kitchen.filter((k) => !['collected', 'rejected', 'cancelled'].includes(k.status)).map((k) => ({ ...k }));
});
const NEXT: Partial<Record<FoodOrderStatus, FoodOrderStatus[]>> = {
  awaiting_acceptance: ['accepted', 'rejected'], accepted: ['preparing'], preparing: ['ready'], ready: ['collected'],
};
on('POST', /^\/kitchen\/orders\/([^/]+)\/status$/, (m, b) => {
  const k = state.kitchen.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Order not found');
  if (!NEXT[k.status]?.includes(b.status)) fail(409, 'invalid_transition', `Order is already ${k.status.replace('_', ' ')}.`);
  k.status = b.status;
  return { ...k };
});
on('GET', /^\/staff\/messages$/, (): StaffMessage[] => [
  { id: 'sm1', author: 'Jamie Morgan', role: 'HQ', body: 'Brand standards v4.0 is live. Please confirm you’ve read it by 31 Oct.', at: iso(now() - 26 * 60 * MIN), avatar: IMG.pW1 },
  { id: 'sm2', author: 'Lakeshore Holdings', role: 'Owner', body: 'Team huddle Thursday 8:30 am. Coffee’s on me.', at: iso(now() - 5 * 60 * MIN), avatar: IMG.pW2 },
  { id: 'sm3', author: 'Team chat', role: 'Team', body: 'Can someone swap Sunday afternoon? I’ll take Wednesday.', at: iso(now() - 50 * MIN), avatar: IMG.pM2 },
  { id: 'sm4', author: 'BranchHarbor', role: 'System', body: 'Your schedule for next week is published.', at: iso(now() - 20 * MIN) },
]);
on('GET', /^\/staff\/cover-requests$/, () => state.cover);
on('POST', /^\/staff\/cover-requests$/, (_m, b) => {
  const s = staffSessions().find((x) => x.id === b.sessionId) ?? fail(404, 'not_found', 'Session not found');
  if (state.cover.some((c) => c.mine && c.sessionName === s.name)) fail(409, 'duplicate', 'You already requested cover for this session.');
  const c: CoverRequest = { id: nid('cv'), sessionName: s.name, locationId: s.locationId, startsAt: s.startsAt, requestedBy: 'You', mine: true, status: 'open' };
  state.cover.unshift(c);
  return c;
});
on('POST', /^\/staff\/cover-requests\/([^/]+)\/accept$/, (m) => {
  const c = state.cover.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Request not found');
  c.status = 'accepted_pending_manager';
  return c;
});

// owner / HQ
on('GET', /^\/hq\/pulse$/, (): Pulse => {
  const metrics: Record<string, [number | null, number | null, number | null, 'healthy' | 'degraded' | 'not_connected', string]> = {
    'sw-qw': [1984000, 412, 86, 'healthy', 'BranchHarbor bookings'],
    'sw-ch': [1468000, 301, 74, 'healthy', 'Mindbody connection'],
    'sw-sd': [962000, 268, 81, 'healthy', 'BranchHarbor bookings'],
    'sw-pb': [884000, 233, 69, 'healthy', 'BranchHarbor bookings'],
    'sw-sh': [null, null, null, 'degraded', 'Booking connection (sync degraded)'],
    'sw-dv': [null, null, null, 'not_connected', 'Not connected — opening soon'],
  };
  const locations = LOCATIONS.filter((l) => l.brandId === 'stillwater').map((l) => {
    const [sales, bookings, occ, sync, source] = metrics[l.id] ?? [null, null, null, 'not_connected', 'Not connected'];
    return { locationId: l.id, name: l.name, city: l.city, country: l.country, currency: l.currency, timeZone: l.timeZone, sales: sales === null ? null : { amount: sales, currency: l.currency }, bookings, occupancyPct: occ, orders: null, source, sync };
  });
  return { scopeLabel: 'Stillwater Yoga Collective · 6 locations', range: 'Last 7 days', locations, updatedAt: iso(now() - 4 * MIN) };
});
on('GET', /^\/approvals$/, () => state.approvals);
on('POST', /^\/approvals\/([^/]+)\/decision$/, (m, b) => {
  const a = state.approvals.find((x) => x.id === m[1]) ?? fail(404, 'not_found', 'Approval not found');
  if (a.status !== 'pending') fail(409, 'already_decided', 'Someone already decided this request.');
  a.status = b.decision;
  return a;
});
on('GET', /^\/notifications$/, (): AppNotification[] => [
  { id: 'n1', kind: 'integration', title: 'Booking sync degraded', body: 'Surry Hills booking connection has been retrying for 47 min. Figures for this location are unavailable.', at: iso(now() - 47 * MIN), locationName: 'Surry Hills' },
  { id: 'n2', kind: 'action', title: '5 approvals waiting', body: 'Refunds, ad spend and a shift swap need a decision.', at: iso(now() - 30 * MIN) },
  { id: 'n3', kind: 'info', title: 'Queen West beat its target', body: '+12% bookings vs last week.', at: iso(now() - 3 * 60 * MIN), locationName: 'Queen West' },
  { id: 'n4', kind: 'info', title: 'LoHi opens 4 Nov', body: 'Website and booking page are scheduled to publish on opening day.', at: iso(now() - 26 * 60 * MIN), locationName: 'LoHi' },
]);

/** Exposed for the Pulse screen: per-currency totals, never a combined figure. */
export const pulseTotals = (p: Pulse) => totalsByCurrency(p.locations.flatMap((l) => (l.sales ? [l.sales] : [])));

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  seed();
  const [pathname = '', search = ''] = path.split('?');
  const isMutation = method !== 'GET';
  await sleep(isMutation ? 550 + Math.random() * 450 : 250 + Math.random() * 300);
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = pathname.match(re);
    if (match) return structuredCloneSafe(h(match, body ?? {}, new URLSearchParams(search))) as T;
  }
  return fail(404, 'not_found', `No mock for ${method} ${pathname}`);
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
