/**
 * Sample data for the Studios full-product screens (no API needed). Stateful in memory, international
 * (Stillwater sample locations in CAD, USD, GBP, EUR, AUD), and honest about sandbox behaviour.
 */
import { ApiError } from '../errors';
import { FIXTURES } from '../mock/orgs';
import { addDays, dateInZone, zonedToUtc } from '../format';
import type { StudioApi } from './api';
import type {
  ClassTypeVM, EditPreview, Instructor, MemberDetail, MemberRow, MembershipPlan, MembershipStateKey, NotificationRow, OnlineItem, PackProduct, Policies, PolicyVM, Room, Roster, SeriesPreview, SeriesVM, StudioReport,
} from './types';

const LOCS = FIXTURES.studios.locations;
const loc = (id: string) => LOCS.find((l) => l.id === id) ?? LOCS[0]!;
const wait = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

const TYPES: ClassTypeVM[] = [
  { id: 'ct_vin', name: 'Morning Vinyasa', description: 'A steady, breath-led flow to start the day.', durationMinutes: 60, defaultCapacity: 20, creditCost: 1, category: 'yoga', level: 'all_levels', locationId: null },
  { id: 'ct_slow', name: 'Slow Flow', description: 'Unhurried sequences with longer holds.', durationMinutes: 75, defaultCapacity: 16, creditCost: 1, category: 'yoga', level: 'beginner', locationId: null },
  { id: 'ct_pil', name: 'Lunchtime Pilates', description: 'Mat Pilates focused on control and alignment.', durationMinutes: 45, defaultCapacity: 12, creditCost: 1, category: 'pilates', level: 'all_levels', locationId: null },
  { id: 'ct_yin', name: 'Yin & Restore', description: 'Long, supported floor postures.', durationMinutes: 60, defaultCapacity: 18, creditCost: 1, category: 'yoga', level: 'all_levels', locationId: null },
  { id: 'ct_ref', name: 'Reformer Pilates', description: null, durationMinutes: 50, defaultCapacity: 10, creditCost: 2, category: 'pilates', level: 'intermediate', locationId: 'qw' },
  { id: 'ct_barre', name: 'Barre Burn', description: null, durationMinutes: 50, defaultCapacity: 16, creditCost: 1, category: 'barre', level: 'all_levels', locationId: null },
];

const rooms: Room[] = LOCS.flatMap((l, i) => [
  { id: `rm_${l.id}_a`, locationId: l.id, name: 'Studio A', capacity: 22, features: ['heated floor'], active: true, upcomingClasses: 40 + i },
  { id: `rm_${l.id}_b`, locationId: l.id, name: 'Studio B', capacity: 16, features: ['mirrors'], active: true, upcomingClasses: 28 + i },
  ...(l.id === 'qw' ? [{ id: 'rm_qw_ref', locationId: 'qw', name: 'Reformer Room', capacity: 10, features: ['reformers ×10'], active: true, upcomingClasses: 18 }] : []),
]);

const PRICE: Record<string, number> = { CAD: 2800, USD: 2800, GBP: 1800, EUR: 2000, AUD: 3200 };
const recur = (days: number[], time: string) => ({ freq: 'WEEKLY' as const, interval: 1, byWeekday: days, time, startDate: addDays(today(), -42), untilDate: addDays(today(), 55), count: null, skipDates: [] });
const series: SeriesVM[] = LOCS.slice(0, 5).flatMap((l, i) => [
  { id: `sr_${l.id}_1`, locationId: l.id, locationName: l.name, classTypeId: 'ct_vin', className: 'Morning Vinyasa', status: 'published' as const, recurrence: recur([1, 2, 3, 4, 5], '07:00'), timeZone: l.timeZone, rrule: `DTSTART;TZID=${l.timeZone}\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR`, durationMinutes: 60, instructorName: 'Maya Rao', roomName: 'Studio A', capacity: 20, price: { amount: PRICE[l.currency]!, currency: l.currency }, creditCost: 1, allowCredits: true, allowMembership: true, online: i === 0, upcoming: 40, bookings: 312 - i * 20, splitFromId: null },
  { id: `sr_${l.id}_2`, locationId: l.id, locationName: l.name, classTypeId: 'ct_yin', className: 'Yin & Restore', status: 'published' as const, recurrence: recur([0, 3], '18:30'), timeZone: l.timeZone, rrule: `DTSTART;TZID=${l.timeZone}\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,WE`, durationMinutes: 60, instructorName: 'Jordan Lee', roomName: 'Studio A', capacity: 18, price: { amount: PRICE[l.currency]!, currency: l.currency }, creditCost: 1, allowCredits: true, allowMembership: true, online: false, upcoming: 16, bookings: 140, splitFromId: null },
]);
series.push({ ...series[0]!, id: 'sr_qw_draft', classTypeId: 'ct_barre', className: 'Barre Burn', status: 'draft', recurrence: { ...recur([0], '10:30'), startDate: addDays(today(), 14) }, upcoming: 0, bookings: 0, instructorName: 'Jordan Lee', roomName: 'Studio B' });

const NETWORK_PRICES = (base: number) => ({ CAD: base, USD: Math.round(base * 0.95), GBP: Math.round(base * 0.65), EUR: Math.round(base * 0.72), AUD: Math.round(base * 1.15) });
const packs: PackProduct[] = [
  { id: 'pp_5', locationId: null, name: '5-class pack', description: 'Valid three months at any studio in your currency.', credits: 5, validityDays: 90, prices: NETWORK_PRICES(12500), transferPolicy: 'same_currency', status: 'active', scope: 'network', sellableAt: LOCS.map((l) => l.id), missingCurrencies: [], active: 64 },
  { id: 'pp_10', locationId: null, name: '10-class pack', description: 'Valid six months at every studio.', credits: 10, validityDays: 180, prices: NETWORK_PRICES(23000), transferPolicy: 'any_location', status: 'active', scope: 'network', sellableAt: LOCS.map((l) => l.id), missingCurrencies: [], active: 41 },
  { id: 'pp_ref', locationId: 'qw', name: 'Reformer 5-pack', description: 'Reformer classes at Queen West.', credits: 10, validityDays: 60, prices: { CAD: 17500 }, transferPolicy: 'home_only', status: 'active', scope: 'location', sellableAt: ['qw'], missingCurrencies: [], active: 9 },
];
const plans: MembershipPlan[] = [
  { id: 'mp_unl', locationId: null, name: 'Unlimited', description: 'Unlimited classes in your currency.', classesPerPeriod: null, prices: NETWORK_PRICES(18900), accessPolicy: 'same_currency', noticeDays: 30, maxPauseDays: 60, graceDays: 7, status: 'active', scope: 'network', sellableAt: LOCS.map((l) => l.id), missingCurrencies: [], active: 118 },
  { id: 'mp_8', locationId: null, name: '8 classes a month', description: 'Home studio only.', classesPerPeriod: 8, prices: NETWORK_PRICES(13900), accessPolicy: 'home_only', noticeDays: 30, maxPauseDays: 30, graceDays: 7, status: 'active', scope: 'network', sellableAt: LOCS.map((l) => l.id), missingCurrencies: [], active: 52 },
];
const LATE: Record<string, number> = { CAD: 1000, USD: 1000, GBP: 700, EUR: 800, AUD: 1200 };
const NOSHOW: Record<string, number> = { CAD: 1500, USD: 1500, GBP: 1000, EUR: 1200, AUD: 1800 };
const orgPolicy: PolicyVM & { id: string } = { id: 'pol_org', lateCancelMinutes: 720, lateCancelFee: LATE, noShowFee: NOSHOW, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: true, bookingWindowDays: 30 };
const overrides: Array<PolicyVM & { id: string; locationId: string }> = [{ id: 'pol_sh', locationId: 'sh', lateCancelMinutes: 360, lateCancelFee: {}, noShowFee: { GBP: 1000 }, forfeitCreditOnLateCancel: true, refundPaidOnLateCancel: false, feesApplyToMembers: false, bookingWindowDays: 21 }];

const NAMES = ['Ava Chen', 'Liam Ortiz', 'Noor Haddad', 'Isla Murphy', 'Lena Vogel', 'Oliver Smith', 'Mia Rossi', 'Lucas Martin', 'Chloe Nguyen', 'Kenji Tanaka', 'Rosa Costa', 'Felix Berg', 'Amelia Okafor', 'Hugo Moreau', 'Tara Singh', 'Owen Walsh'];
const STATES: Array<MembershipStateKey | null> = ['active', null, 'grace', 'active', 'paused', null, 'cancelling', 'active', null, 'suspended', 'active', null, 'active', null, 'active', null];
const members: MemberRow[] = LOCS.slice(0, 5).flatMap((l) => NAMES.map((n, i) => ({
  id: `cu_${l.id}_${i}`, name: n, email: `${n.toLowerCase().replace(' ', '.')}@example.com`, phone: i % 3 ? null : '+1 555 0142', homeLocation: { id: l.id, name: l.name },
  membership: STATES[i] ? { id: `ms_${l.id}_${i}`, name: i % 4 === 0 ? '8 classes a month' : 'Unlimited', state: STATES[i]!, graceUntil: STATES[i] === 'grace' ? daysFromNow(5) : null, cancelAt: STATES[i] === 'cancelling' ? daysFromNow(21) : null } : null,
  packs: STATES[i] ? { count: 0, credits: 0, nextExpiry: null } : { count: 1, credits: (i * 3) % 9 + 1, nextExpiry: daysFromNow(10 + i * 3) },
  attendance: { attended: 4 + ((i * 7) % 30), noShows: i % 5 === 0 ? 2 : 0, lastVisit: daysFromNow(-(i % 9) - 1) },
  consent: { marketingEmail: i % 4 !== 0, marketingSms: i % 5 === 0, classUpdatesSms: i % 5 === 0 },
})));

const online: OnlineItem[] = [
  { id: 'on_1', kind: 'livestream', title: 'Morning Vinyasa — live from Queen West', description: 'Join the studio class from home.', instructorName: 'Maya Rao', provider: 'zoom', providerUrl: 'https://zoom.us/j/88123456?pwd=sample', startsAt: daysFromNow(1), durationMinutes: 60, locationId: 'qw', locationName: loc('qw').name, allowMembers: true, allowPackHolders: true, allowFree: false, prices: { CAD: 1500 }, rules: ['Included with a membership', 'Included for class pack holders', 'Available to buy'], status: 'published', registrations: 6 },
  { id: 'on_2', kind: 'on_demand', title: '20-minute Morning Flow', description: '20-minute recording.', instructorName: 'Maya Rao', provider: 'youtube', providerUrl: 'https://youtu.be/sample-morning-flow', startsAt: null, durationMinutes: 20, locationId: null, locationName: null, allowMembers: true, allowPackHolders: true, allowFree: false, prices: {}, rules: ['Included with a membership', 'Included for class pack holders'], status: 'published', registrations: 48 },
  { id: 'on_3', kind: 'on_demand', title: 'Hip Mobility for Desk Days', description: '30-minute recording.', instructorName: 'Priya Shah', provider: 'vimeo', providerUrl: 'https://vimeo.com/sample/hip-mobility', startsAt: null, durationMinutes: 30, locationId: null, locationName: null, allowMembers: true, allowPackHolders: false, allowFree: false, prices: NETWORK_PRICES(900), rules: ['Included with a membership', 'Available to buy'], status: 'published', registrations: 22 },
  { id: 'on_4', kind: 'on_demand', title: 'Restorative Weekend Workshop (draft)', description: 'Edit in progress.', instructorName: null, provider: 'vimeo', providerUrl: 'https://vimeo.com/sample/workshop', startsAt: null, durationMinutes: 90, locationId: null, locationName: null, allowMembers: true, allowPackHolders: false, allowFree: false, prices: {}, rules: ['Included with a membership'], status: 'draft', registrations: 0 },
];

function rosterFor(occId: string): Roster {
  const locId = occId.split('-')[0] ?? 'qw';
  const l = loc(locId);
  const h = hash(occId);
  const n = 6 + (h % 9);
  const start = (() => { const m = occId.match(/(\d{4}-\d{2}-\d{2})-(\d)/); return m ? zonedToUtc(m[1]!, ['07:00', '09:00', '12:15', '18:30'][Number(m[2]) % 4]!, l.timeZone) : new Date().toISOString(); })();
  const past = new Date(start) < new Date();
  return {
    occurrence: { id: occId, name: 'Class', startsAt: start, endsAt: start, timeZone: l.timeZone, locationName: l.name, instructorName: 'Maya Rao', room: 'Studio A', capacity: 20, status: 'scheduled', youTeach: false },
    counts: { booked: n, checkedIn: past ? n - 1 : 0, noShows: past ? 1 : 0 },
    items: Array.from({ length: n }, (_, i) => ({
      bookingId: `${occId}-b${i}`, status: past ? (i === n - 1 ? 'no_show' : 'attended') : i === 0 ? 'attended' : 'confirmed', customer: { id: `cu_${locId}_${i}`, name: NAMES[(h + i) % NAMES.length]! },
      bookedWith: i % 3 === 0 ? 'Membership · Unlimited' : i % 3 === 1 ? `Pack · ${(i % 5) + 1} left` : 'Paid single class', paymentMethod: i % 3 === 0 ? 'membership' : i % 3 === 1 ? 'credit' : 'pay_per_class',
      checkedInAt: past || i === 0 ? start : null, checkInSource: past || i === 0 ? 'desk' : null, fee: past && i === n - 1 ? { id: `fee_${occId}`, kind: 'no_show', amount: NOSHOW[l.currency]!, currency: l.currency, status: 'due' } : null,
    })),
  };
}
const rosterState = new Map<string, Roster>();
const roster = (id: string) => { if (!rosterState.has(id)) rosterState.set(id, rosterFor(id)); return rosterState.get(id)!; };

function editPreview(occId: string, scope: 'one' | 'following' | 'series', ch: Parameters<StudioApi['editPreview']>[2]): EditPreview {
  const r = roster(occId);
  const count = scope === 'one' ? 1 : scope === 'following' ? 6 : 9;
  const items = Array.from({ length: count }, (_, i) => {
    const before = new Date(new Date(r.occurrence.startsAt).getTime() + i * 7 * 86400_000).toISOString();
    const time = ch.time ?? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: r.occurrence.timeZone }).format(new Date(before));
    const after = ch.cancel ? null : zonedToUtc(dateInZone(new Date(before), r.occurrence.timeZone), time, r.occurrence.timeZone);
    const bookings = Math.max(0, r.counts.booked - i);
    const changes = ch.cancel ? ['cancelled'] : [...(ch.time ? [`now starts ${time}`] : []), ...(ch.instructorName ? [`instructor: ${ch.instructorName}`] : []), ...(ch.roomId ? ['room changed'] : []), ...(ch.capacity ? [`capacity ${ch.capacity}`] : [])];
    return { occurrenceId: `${occId}+${i}`, detached: false, before: { startsAt: before, instructorName: r.occurrence.instructorName, room: r.occurrence.room, capacity: 20 }, after: after ? { startsAt: after, instructorName: ch.instructorName ?? r.occurrence.instructorName, room: r.occurrence.room, capacity: ch.capacity ?? 20, dstAdjusted: false } : null, bookings, waitlist: 0, overCapacity: ch.capacity ? Math.max(0, bookings - ch.capacity) : 0, conflicts: [], changes };
  });
  const bookings = items.reduce((a, i) => a + i.bookings, 0);
  return { scope, timeZone: r.occurrence.timeZone, totals: { occurrences: count, bookings, customers: Math.min(bookings, 14), waitlisted: 0, conflicts: 0 }, notify: { customers: Math.min(bookings, 14), channels: ['email (unless opted out)', 'SMS (only with SMS consent)', 'app push (if signed in, unless turned off)'] }, warnings: items.some((i) => i.overCapacity) ? ['Capacity would be below existing bookings for some classes.'] : [], items };
}

const notes = new Map<string, NotificationRow[]>();

function report(): StudioReport {
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(today(), -7 * (8 - i)));
  return {
    generatedAt: new Date().toISOString(), source: 'Sample data', definitions: { occupancy: 'Booked places ÷ capacity for scheduled classes in the range.', attendance: 'Attended ÷ booked places with attendance recorded, per week.', churn: 'Recurring memberships ending in the month ÷ active at the start of the month.', revenue: 'Succeeded payments, net of refunds, per currency. Currencies are never combined.' },
    occupancy: {
      byLocation: LOCS.map((l, i) => ({ locationId: l.id, locationName: l.name, classes: l.site === 'live' ? 120 - i * 6 : 0, capacity: l.site === 'live' ? 2200 : 0, booked: l.site === 'live' ? 1500 - i * 90 : 0, occupancyPct: l.site === 'live' ? Math.round(((1500 - i * 90) / 2200) * 1000) / 10 : null })),
      byClassType: TYPES.slice(0, 5).map((t, i) => ({ classTypeId: t.id, name: t.name, classes: 40 - i * 4, occupancyPct: [78.4, 61.2, 52.9, 81.5, 88.0][i]! })),
    },
    attendance: weeks.map((w, i) => ({ weekStart: w, attended: 610 + i * 14, noShow: 38 - i, lateCancel: 21, booked: 680 + i * 12, classes: 118, unrecorded: i === 7 ? 40 : 0, attendanceRatePct: Math.round(((610 + i * 14) / (680 + i * 12 - (i === 7 ? 40 : 0))) * 1000) / 10 })),
    churn: Array.from({ length: 3 }, (_, i) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2 + i); return { month: d.toISOString().slice(0, 7), activeAtStart: 150 + i * 6, started: 14 + i, cancelled: 6 - i, activeAtEnd: 158 + i * 7, churnRatePct: Math.round(((6 - i) / (150 + i * 6)) * 1000) / 10 }; }),
    revenue: [
      { currency: 'CAD', gross: 2_418_000, refunds: 42_000, net: 2_376_000, payments: 812, byCategory: { memberships: 1_210_000, packs: 640_000, single_classes: 420_000, intro_offers: 75_000, online: 18_000, fees: 13_000 } },
      { currency: 'USD', gross: 1_206_500, refunds: 11_000, net: 1_195_500, payments: 401, byCategory: { memberships: 690_000, packs: 280_000, single_classes: 210_500, fees: 15_000 } },
      { currency: 'GBP', gross: 702_000, refunds: 0, net: 702_000, payments: 290, byCategory: { memberships: 400_000, packs: 180_000, single_classes: 122_000 } },
      { currency: 'EUR', gross: null, refunds: null, net: null, payments: 0, byCategory: {}, unavailableReason: 'No payments in this period' },
      { currency: 'AUD', gross: 588_000, refunds: 0, net: 588_000, payments: 205, byCategory: { memberships: 330_000, packs: 160_000, single_classes: 98_000 } },
    ],
  };
}

function memberDetail(id: string): MemberDetail {
  const m = members.find((x) => x.id === id);
  if (!m) throw new ApiError('not_found', 'Member not found', 404);
  const l = loc(m.homeLocation?.id ?? 'qw');
  return {
    id, name: m.name, email: m.email, phone: m.phone, locationId: l.id,
    memberships: m.membership ? [{ id: m.membership.id, name: m.membership.name, status: m.membership.state === 'cancelling' || m.membership.state === 'paused' ? 'active' : m.membership.state, state: m.membership.state, recurring: true, classesPerPeriod: m.membership.name.startsWith('8') ? 8 : null, accessPolicy: 'same_currency', price: { amount: 18900, currency: l.currency, interval: 'month' }, startsAt: daysFromNow(-120), currentPeriodEnd: daysFromNow(12), pausedFrom: m.membership.state === 'paused' ? daysFromNow(-3) : null, pausedUntil: m.membership.state === 'paused' ? daysFromNow(18) : null, cancelAt: m.membership.cancelAt, graceUntil: m.membership.graceUntil, failedAttempts: m.membership.state === 'grace' ? 1 : 0, billing: 'sandbox', usage: { used: 5, limit: m.membership.name.startsWith('8') ? 8 : null, periodEnd: daysFromNow(12) }, invoices: [{ id: 'inv1', periodStart: daysFromNow(-48), amount: { amount: 18900, currency: l.currency }, status: 'paid', attempts: 1, failureReason: null }, { id: 'inv2', periodStart: daysFromNow(-18), amount: { amount: 18900, currency: l.currency }, status: m.membership.state === 'grace' ? 'failed' : 'paid', attempts: 1, failureReason: m.membership.state === 'grace' ? 'Card declined' : null }] }] : [],
    packs: m.packs.count ? [{ id: `pk_${id}`, name: '5-class pack', locationId: l.id, creditsTotal: 5, creditsRemaining: m.packs.credits, expiresAt: m.packs.nextExpiry, status: 'active', transferPolicy: 'same_currency', source: 'purchase' }] : [],
    bookings: Array.from({ length: 6 }, (_, i) => ({ id: `bk_${id}_${i}`, className: TYPES[i % 4]!.name, locationName: l.name, timeZone: l.timeZone, startsAt: daysFromNow(i < 2 ? i + 1 : -i * 3), status: i < 2 ? 'confirmed' : i === 4 ? 'no_show' : 'attended', paymentMethod: m.membership ? 'membership' : 'credit', lateCancel: false, checkedInAt: i >= 2 && i !== 4 ? daysFromNow(-i * 3) : null })),
    attendance: { attended: m.attendance.attended, noShows: m.attendance.noShows, lateCancels: 1, upcoming: 2 },
    fees: m.attendance.noShows ? [{ id: `fee_${id}`, kind: 'no_show', amount: { amount: NOSHOW[l.currency]!, currency: l.currency }, status: 'due', waiveReason: null, createdAt: daysFromNow(-12) }] : [],
    consents: [{ purpose: 'marketing_email', granted: !!m.consent.marketingEmail, version: '2026-10', source: 'web', recordedAt: daysFromNow(-120) }, ...(m.consent.classUpdatesSms ? [{ purpose: 'class_updates_sms', granted: true, version: '2026-10', source: 'web', recordedAt: daysFromNow(-100) }] : [])],
    purchases: [{ id: `pu_${id}`, kind: m.membership ? 'membership' : 'pack', name: m.membership ? 'Unlimited (monthly)' : '5-class pack (5 credits)', status: 'paid', amount: { amount: 12500, currency: l.currency }, createdAt: daysFromNow(-60) }],
    online: [],
  };
}

export const studioMockApi: StudioApi = {
  rooms: (locationId) => wait(rooms.filter((r) => !locationId || r.locationId === locationId)),
  createRoom: (input) => { const r = { id: `rm_${uid()}`, ...input, active: true, upcomingClasses: 0 }; rooms.push(r); return wait(r, 500); },
  updateRoom: (id, patch) => { const r = rooms.find((x) => x.id === id)!; Object.assign(r, patch); return wait(r, 400); },
  classTypes: () => wait(TYPES),
  updateClassType: (id, patch) => { const t = TYPES.find((x) => x.id === id)!; Object.assign(t, patch); return wait(t, 400); },
  instructors: () => wait<Instructor[]>(['Maya Rao', 'Sam Tran', 'Ana Silva', 'Jordan Lee'].map((n, i) => ({ userId: `u_${i}`, name: n, roles: ['staff'], availability: i === 0 ? [{ id: 'av1', kind: 'available' as const, weekday: 1, onDate: null, startTime: '06:00', endTime: '14:00', note: null }] : [] }))),
  series: (locationId) => wait(series.filter((s) => !locationId || s.locationId === locationId)),
  previewSeries: (input) => {
    const l = loc(input.locationId);
    const t = TYPES.find((x) => x.id === input.classTypeId) ?? TYPES[0]!;
    const out: SeriesPreview['occurrences'] = [];
    for (let d = 0; out.length < (input.recurrence.count ?? 60) && d < 400; d++) {
      const date = addDays(input.recurrence.startDate, d);
      if (input.recurrence.untilDate && date > input.recurrence.untilDate) break;
      if (!input.recurrence.byWeekday.includes(new Date(`${date}T12:00:00Z`).getUTCDay()) || input.recurrence.skipDates.includes(date)) continue;
      const startsAt = zonedToUtc(date, input.recurrence.time, l.timeZone);
      if (new Date(startsAt) < new Date()) continue;
      const off = -Math.round((new Date(`${date}T12:00:00Z`).getTime() - new Date(zonedToUtc(date, '12:00', l.timeZone)).getTime()) / 60000);
      out.push({ localDate: date, localTime: input.recurrence.time, startsAt, endsAt: new Date(new Date(startsAt).getTime() + t.durationMinutes * 60000).toISOString(), utcOffsetMinutes: -off, dstAdjusted: false, conflicts: [] });
    }
    return wait<SeriesPreview>({ classType: { id: t.id, name: t.name }, timeZone: l.timeZone, rrule: `DTSTART;TZID=${l.timeZone}:${input.recurrence.startDate.replace(/-/g, '')}T${input.recurrence.time.replace(':', '')}00\nRRULE:FREQ=WEEKLY;INTERVAL=${input.recurrence.interval}`, durationMinutes: t.durationMinutes, capacity: input.capacity ?? t.defaultCapacity, room: null, instructorName: input.instructorName ?? null, price: { amount: input.priceMinor, currency: l.currency }, creditCost: input.creditCost ?? t.creditCost,
      summary: { count: out.length, first: out[0]?.startsAt ?? null, last: out.at(-1)?.startsAt ?? null, crossesDst: new Set(out.map((o) => o.utcOffsetMinutes)).size > 1, conflicts: 0, dstAdjusted: 0 }, occurrences: out }, 500);
  },
  createSeries: async (input, opts) => {
    const pv = await studioMockApi.previewSeries(input);
    const l = loc(input.locationId);
    const s: SeriesVM = { id: `sr_${uid()}`, locationId: l.id, locationName: l.name, classTypeId: input.classTypeId, className: pv.classType.name, status: opts.publish ? 'published' : 'draft', recurrence: input.recurrence, timeZone: l.timeZone, rrule: pv.rrule, durationMinutes: pv.durationMinutes, instructorName: input.instructorName ?? null, roomName: null, capacity: pv.capacity, price: pv.price, creditCost: pv.creditCost, allowCredits: input.allowCredits, allowMembership: input.allowMembership, online: input.online, upcoming: opts.publish ? pv.summary.count : 0, bookings: 0, splitFromId: null };
    series.unshift(s);
    return wait({ series: s, generated: opts.publish ? pv.summary.count : 0 }, 600);
  },
  publishSeries: (id) => { const s = series.find((x) => x.id === id)!; s.status = 'published'; s.upcoming = 12; return wait({ generated: 12 }, 600); },
  roster: (id) => wait(roster(id)),
  checkIn: async (bookingId, source, undo) => { for (const r of rosterState.values()) for (const i of r.items) if (i.bookingId === bookingId) { i.status = undo ? 'confirmed' : 'attended'; i.checkedInAt = undo ? null : new Date().toISOString(); i.checkInSource = undo ? null : source; } await wait(null, 300); },
  markNoShow: async (bookingId) => { for (const r of rosterState.values()) for (const i of r.items) if (i.bookingId === bookingId) { i.status = 'no_show'; i.fee = { id: `fee_${bookingId}`, kind: 'no_show', amount: 1500, currency: 'CAD', status: 'due' }; } return wait({ fee: { amount: 1500, currency: 'CAD' } }, 300); },
  closeAttendance: async (id) => { const r = roster(id); let n = 0; for (const i of r.items) if (i.status === 'confirmed') { i.status = 'no_show'; n++; } return wait({ noShows: n, feesRecorded: n }); },
  editPreview: (id, scope, changes) => wait(editPreview(id, scope, changes), 500),
  applyEdit: async (id, scope, changes, opts) => {
    const pv = editPreview(id, scope, changes);
    if (changes.cancel && !opts.reason) throw new ApiError('validation_failed', 'Give a reason for the cancellation (customers see it)', 400, { reason: 'Required' });
    if (!opts.allowOverCapacity && pv.items.some((i) => i.overCapacity > 0)) throw new ApiError('capacity_below_bookings', 'Capacity is below existing bookings for some classes', 409);
    const rows: NotificationRow[] = opts.notify ? pv.items.slice(0, 3).flatMap((_, i) => (['email', 'sms', 'push'] as const).map((ch) => ({ id: uid(), kind: changes.cancel ? 'class_cancelled' : 'class_changed', channel: ch, status: ch === 'email' ? 'sent' : 'skipped_no_consent', subject: changes.cancel ? 'Cancelled: your class' : 'Changed: your class', customer: NAMES[i]!, createdAt: new Date().toISOString() }))) : [];
    notes.set(id, [...rows, ...(notes.get(id) ?? [])]);
    return wait({ occurrences: pv.totals.occurrences, bookingsAffected: pv.totals.bookings, cancelledBookings: changes.cancel ? pv.totals.bookings : 0, customersNotified: opts.notify ? pv.totals.customers : 0, newSeriesId: scope === 'following' ? `sr_${uid()}` : null, delivery: { sent: rows.filter((r) => r.status === 'sent').length, skipped: rows.filter((r) => r.status !== 'sent').length } }, 800);
  },
  notifications: (id) => wait(notes.get(id) ?? []),
  packProducts: () => wait(packs),
  createPackProduct: async (input) => { packs.push({ ...input, id: `pp_${uid()}`, status: 'active', scope: input.locationId ? 'location' : 'network', sellableAt: LOCS.filter((l) => input.prices[l.currency] !== undefined).map((l) => l.id), missingCurrencies: [...new Set(LOCS.map((l) => l.currency))].filter((c) => input.prices[c] === undefined), active: 0 }); await wait(null, 400); },
  updatePackProduct: async (id, patch) => { Object.assign(packs.find((p) => p.id === id)!, patch); await wait(null, 300); },
  membershipPlans: () => wait(plans),
  createMembershipPlan: async (input) => { plans.push({ ...input, id: `mp_${uid()}`, status: 'active', scope: input.locationId ? 'location' : 'network', sellableAt: LOCS.filter((l) => input.prices[l.currency] !== undefined).map((l) => l.id), missingCurrencies: [...new Set(LOCS.map((l) => l.currency))].filter((c) => input.prices[c] === undefined), active: 0 }); await wait(null, 400); },
  updateMembershipPlan: async (id, patch) => { Object.assign(plans.find((p) => p.id === id)!, patch); await wait(null, 300); },
  policies: () => wait<Policies>({ organizationDefault: orgPolicy, locationOverrides: overrides, effective: LOCS.map((l) => { const p = overrides.find((o) => o.locationId === l.id) ?? orgPolicy; return { locationId: l.id, locationName: l.name, currency: l.currency, policy: { ...p, source: p === orgPolicy ? 'organization' : 'location' }, text: [`Cancel at least ${p.lateCancelMinutes / 60} hours before the class starts to avoid a late cancellation.`, p.lateCancelFee[l.currency] ? `Late cancellation fee: ${new Intl.NumberFormat('en', { style: 'currency', currency: l.currency }).format(p.lateCancelFee[l.currency]! / 100)}.` : 'No late cancellation fee.', p.noShowFee[l.currency] ? `No-show fee: ${new Intl.NumberFormat('en', { style: 'currency', currency: l.currency }).format(p.noShowFee[l.currency]! / 100)}.` : 'No no-show fee.'] }; }) }),
  savePolicy: async (locationId, p) => { if (!locationId) Object.assign(orgPolicy, p); else { const o = overrides.find((x) => x.locationId === locationId); if (o) Object.assign(o, p); else overrides.push({ ...p, id: uid(), locationId }); } await wait(null, 400); },
  members: (q) => {
    let rows = members.filter((m) => !q.locationId || m.homeLocation?.id === q.locationId);
    if (q.search) rows = rows.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q.search!.toLowerCase()));
    if (q.filter === 'members') rows = rows.filter((m) => m.membership && ['active', 'grace', 'paused', 'cancelling'].includes(m.membership.state));
    if (q.filter === 'grace') rows = rows.filter((m) => m.membership && ['grace', 'suspended'].includes(m.membership.state));
    if (q.filter === 'pack_holders') rows = rows.filter((m) => m.packs.credits > 0);
    if (q.filter === 'none') rows = rows.filter((m) => !m.membership && !m.packs.credits);
    return wait({ items: rows.slice(q.offset, q.offset + 25), total: rows.length });
  },
  member: async (id) => wait(memberDetail(id)),
  pauseMembership: async (id, from, until) => { const m = members.find((x) => x.membership?.id === id); if (m?.membership) m.membership.state = 'paused'; const d = memberDetail(m!.id).memberships[0]!; return wait({ ...d, state: 'paused', pausedFrom: from, pausedUntil: until }); },
  resumeMembership: async (id) => { const m = members.find((x) => x.membership?.id === id); if (m?.membership) m.membership.state = 'active'; return wait(memberDetail(m!.id).memberships[0]!); },
  cancelMembership: async (id, immediate) => { const m = members.find((x) => x.membership?.id === id); if (m?.membership) { m.membership.state = immediate ? 'cancelled' : 'cancelling'; m.membership.cancelAt = immediate ? new Date().toISOString() : daysFromNow(30); } return wait(memberDetail(m!.id).memberships[0]!); },
  sandboxRenewal: async (id, outcome) => { const m = members.find((x) => x.membership?.id === id); if (m?.membership) { m.membership.state = outcome === 'failed' ? 'grace' : 'active'; m.membership.graceUntil = outcome === 'failed' ? daysFromNow(7) : null; } await wait(null, 400); },
  grantCredits: async (customerId, input) => { const m = members.find((x) => x.id === customerId)!; m.packs = { count: m.packs.count + 1, credits: m.packs.credits + input.credits, nextExpiry: daysFromNow(60) }; return wait({ id: uid(), name: `Complimentary credits (${input.reason})`, locationId: input.locationId, creditsTotal: input.credits, creditsRemaining: input.credits, expiresAt: daysFromNow(60), status: 'active', transferPolicy: 'home_only', source: 'comp' }); },
  waiveFee: async () => { await wait(null, 300); },
  sell: async (_c, input) => wait({ paymentId: `pay_${uid()}`, sandbox: true, amount: { amount: (input.kind === 'pack' ? packs : plans).find((p) => p.id === input.productId)?.prices[loc(input.locationId).currency] ?? 0, currency: loc(input.locationId).currency } }),
  confirmSandboxPayment: async () => { await wait(null, 500); },
  online: () => wait(online),
  createOnline: async (input) => { const item: OnlineItem = { id: `on_${uid()}`, ...input, description: input.description ?? null, instructorName: null, startsAt: input.startsAt ?? null, durationMinutes: input.durationMinutes ?? null, locationName: input.locationId ? loc(input.locationId).name : null, rules: [input.allowMembers && 'Included with a membership', input.allowPackHolders && 'Included for class pack holders', input.allowFree && 'Free with registration', Object.keys(input.prices).length && 'Available to buy'].filter(Boolean) as string[], registrations: 0 }; online.unshift(item); return wait(item, 500); },
  updateOnline: async (id, patch) => { const x = online.find((o) => o.id === id)!; Object.assign(x, patch); return wait(x, 300); },
  registrations: (id) => wait(Array.from({ length: online.find((o) => o.id === id)?.registrations ?? 0 }, (_, i) => ({ customer: NAMES[i % NAMES.length]!, kind: 'registration', basis: i % 2 ? 'pack_holder' : 'member', joinedAt: null })).slice(0, 12)),
  reports: () => wait(report(), 500),
  aiDescription: (classTypeId, tone) => { const t = TYPES.find((x) => x.id === classTypeId) ?? TYPES[0]!; return wait({ classTypeId, source: 'template' as const, draft: `${tone === 'calm' ? 'Slow down and settle in' : tone === 'energetic' ? 'Bring your energy' : 'Come as you are'} for ${t.name}: a ${t.durationMinutes}-minute ${t.category ?? 'studio'} class suitable for ${(t.level ?? 'all_levels').replace('_', ' ')}. Your instructor will guide you through each part of the class and offer options along the way.`, notes: ['Draft only — nothing is published until you save it to the class type.', 'Sample mode: drafted from a template, not a model.'] }, 700); },
  aiAttendance: (weeks) => wait({ observations: [`Classes: 236 in the last ${weeks} week(s) vs 231 before.`, 'Booked places: 3,410 vs 3,262.', 'Occupancy: 71.8% vs 69.4%.', 'Yin & Restore: occupancy 81.5% (was 74.0%, +7.5 pts).'], narrative: null, notInferred: 'Causes are not inferred: occupancy and attendance alone do not explain why numbers changed.', source: 'template' as const, current: { classes: 236, booked: 3410, occupancyPct: 71.8 }, previous: { classes: 231, booked: 3262, occupancyPct: 69.4 } }, 600),
  aiAudiences: () => wait({ notes: ['Proposals only. Nothing is sent: create a campaign from Marketing to contact an audience.', 'Only customers with marketing email consent can be contacted for promotions.'], proposals: [
    { proposalId: 'p1', key: 'intro_not_converted', title: 'Intro offer customers without a membership', rule: 'Redeemed an intro offer more than 14 days ago and have no active membership.', size: 23, emailConsented: 17, sample: ['Ava', 'Liam', 'Noor'], suggestedMessage: 'Thanks for trying us out — here is what members get.', status: 'proposed' as const },
    { proposalId: 'p2', key: 'credits_expiring', title: 'Pack credits expiring within 14 days', rule: 'Active class pack with unused credits that expires in the next 14 days.', size: 11, emailConsented: 9, sample: ['Mia', 'Owen'], suggestedMessage: 'You still have class credits that expire soon.', status: 'proposed' as const },
    { proposalId: 'p3', key: 'members_not_seen', title: 'Members not seen for 21 days', rule: 'Active membership and no class in the past 21 days.', size: 8, emailConsented: 6, sample: ['Tara'], suggestedMessage: 'We have missed you — here are a few classes this week.', status: 'proposed' as const },
  ] }, 700),
};
