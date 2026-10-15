import type { Currency, Money } from '@bh/shared';
import type { IconName } from '@bh/icons';
import type { Tone } from '@bh/ui';
import type { AttentionItem, Cell, IndustryKey, Metric, MetricValue, TableData } from '../types';
import { FIXTURES, PASTEL as P, at, loc } from './orgs';
import { dateArg, dayArg, isRef, lbl, moneyArg, plain, ref, tbl, timeArg, zoneArg, type MsgParams, type MsgRef, type Txt } from '../msg';

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

interface MetricDef {
  key: string;
  label: string;
  definition: string;
  range: string;
  source: string;
  icon: IconName;
  pastel: string;
  /** Per-location values in fixture order. null = unavailable at that location. */
  perLoc?: (number | null)[];
  agg?: 'sum' | 'avg';
  kind?: 'count' | 'percent';
  revenue?: boolean;
  notConnected?: boolean;
  note?: string;
}

const OVERVIEW: Record<IndustryKey, { metrics: MetricDef[]; upcomingTitle: string; upcoming: [locId: string, hhmm: string, title: string, detail: string, status: string, tone: Tone, detailMsg?: [key: string, params: MsgParams]][]; attention: (AttentionItem & { locId?: string })[]; aiPrompt: string }> = {
  studios: {
    metrics: [
      { key: 'enquiries', label: 'Enquiries', definition: 'Website enquiry and trial forms submitted', range: 'Last 7 days', source: 'Website forms', icon: 'mail', pastel: P.lime, perLoc: [12, 9, 7, 8, 6, 0, 5], agg: 'sum', kind: 'count' },
      { key: 'classes', label: 'Classes today', definition: 'Scheduled class occurrences today, in each location’s time zone', range: 'Today', source: 'Booking connection', icon: 'calendar', pastel: P.lilac, perLoc: [8, 6, 7, 7, 6, null, 5], agg: 'sum', kind: 'count' },
      { key: 'occupancy', label: 'Occupancy', definition: 'Booked spots ÷ capacity for classes this week', range: 'This week', source: 'Booking connection', icon: 'users', pastel: P.aqua, perLoc: [0.78, 0.64, null, 0.71, 0.66, null, 0.69], agg: 'avg', kind: 'percent' },
      { key: 'revenue', label: 'Revenue', definition: 'Succeeded customer payments, refunds excluded, per currency', range: 'Last 7 days', source: 'Stripe', icon: 'wallet', pastel: P.butter, revenue: true },
      { key: 'membership', label: 'Membership activity', definition: 'New, paused and cancelled memberships', range: 'Last 30 days', source: 'Membership system', icon: 'card', pastel: P.grey, notConnected: true, note: 'No membership system connected yet' },
    ],
    upcomingTitle: 'Upcoming classes',
    upcoming: [
      ['qw', '07:00', 'Morning Vinyasa · Maya Rao', 'Queen West · 16/20', 'Cover requested', 'warning', ['upcoming.detail.class', { place: 'Queen West', booked: 16, capacity: 20, waitlist: 0 }]],
      ['qw', '09:00', 'Slow Flow · Sam Tran', 'Queen West · 20/20 · 3 waitlisted', 'Full', 'info', ['upcoming.detail.class', { place: 'Queen West', booked: 20, capacity: 20, waitlist: 3 }]],
      ['ls', '12:15', 'Lunchtime Pilates · Ana Silva', 'Leslieville · 11/20', 'Open', 'success', ['upcoming.detail.class', { place: 'Leslieville', booked: 11, capacity: 20, waitlist: 0 }]],
      ['sh', '18:30', 'Yin & Restore · Priya Shah', 'Shoreditch · 19/20', '1 spot', 'neutral', ['upcoming.detail.class', { place: 'Shoreditch', booked: 19, capacity: 20, waitlist: 0 }]],
      ['sy', '06:30', 'Sunrise Flow · Ella Wright', 'Surry Hills · 14/18', 'Open', 'success', ['upcoming.detail.class', { place: 'Surry Hills', booked: 14, capacity: 18, waitlist: 0 }]],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Kitsilano booking sync degraded', detail: 'Last successful sync 2 h ago · occupancy unavailable', titleKey: 'attention.bookingSyncDegraded', titleParams: { place: 'Kitsilano' }, detailKey: 'attention.lastSyncOccupancy', detailParams: { hours: 2 }, href: '/connections', kind: 'integration', locId: 'kt' },
      { id: 'a2', icon: 'users', title: '1 open cover request', detail: 'Morning Vinyasa, Queen West', titleKey: 'attention.openCover', titleParams: { count: 1 }, href: '/ops/cover', kind: 'action', locId: 'qw' },
      { id: 'a3', icon: 'shield', title: '1 page change awaiting approval', detail: 'Leslieville · Home hero', titleKey: 'attention.pageChanges', titleParams: { count: 1 }, href: '/websites?tab=approvals', kind: 'action', locId: 'ls' },
      { id: 'a4', icon: 'card', title: 'Payment without booking record', detail: 'Reconciliation queue · 1 item', titleKey: 'attention.paymentWithoutBooking', detailKey: 'attention.reconQueue', detailParams: { count: 1 }, href: '/payments?tab=reconciliation', kind: 'action' },
    ],
    aiPrompt: 'Summarise attendance changes this month',
  },
  sports: {
    metrics: [
      { key: 'enrolled', label: 'Enrolled', definition: 'Accepted registrations this season', range: 'Autumn season', source: 'Registrations', icon: 'users', pastel: P.lime, perLoc: [96, 64, 54, 0], agg: 'sum', kind: 'count' },
      { key: 'review', label: 'Awaiting review', definition: 'Submitted registrations not yet accepted or waitlisted', range: 'Now', source: 'Registrations', icon: 'file', pastel: P.butter, perLoc: [5, 2, 2, 0], agg: 'sum', kind: 'count' },
      { key: 'sessions', label: 'Sessions today', definition: 'Training sessions scheduled today', range: 'Today', source: 'Schedule', icon: 'calendar', pastel: P.aqua, perLoc: [5, 4, 3, null], agg: 'sum', kind: 'count' },
      { key: 'revenue', label: 'Registration payments', definition: 'Succeeded payments, refunds excluded, per currency', range: 'Last 7 days', source: 'Stripe', icon: 'wallet', pastel: P.blush, revenue: true },
    ],
    upcomingTitle: 'Today’s sessions',
    upcoming: [
      ['rp', '16:00', 'U8 Red · Coach Diaz', 'Riverside Park · Pitch 1', 'Scheduled', 'neutral'],
      ['rp', '17:00', 'U10 Blue · Coach Ortiz', 'Riverside Park · Pitch 2', 'Venue clash', 'danger'],
      ['rp', '17:00', 'U12 Camp · Coach Lee', 'Riverside Park · Pitch 2', 'Venue clash', 'danger'],
      ['mc', '18:00', 'U14 Development · Coach Hale', 'Didsbury · Main pitch', 'Scheduled', 'neutral'],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Pitch 2 double-booked at 17:00', detail: 'U10 Blue and U12 Camp · Riverside Park', titleKey: 'attention.doubleBooked', titleParams: { venue: 'Pitch 2', time: '17:00' }, detailKey: 'attention.twoGroupsAt', detailParams: { a: 'U10 Blue', b: 'U12 Camp', place: 'Riverside Park' }, href: '/ops/schedule', kind: 'action', locId: 'rp' },
      { id: 'a2', icon: 'file', title: '9 registrations awaiting review', detail: 'Autumn U10 and U12', titleKey: 'attention.registrationsReview', titleParams: { count: 9 }, detailKey: 'attention.twoNames', detailParams: { a: 'Autumn U10', b: 'U12' }, href: '/ops/registrations', kind: 'action' },
      { id: 'a3', icon: 'wifi-off', title: 'Dublin payments not set up', detail: 'Registration stays closed until the account is enabled', titleKey: 'attention.paymentsNotSetUp', titleParams: { place: 'Dublin' }, detailKey: 'attention.registrationClosedUntil', href: '/payments?tab=setup', kind: 'integration', locId: 'dn' },
    ],
    aiPrompt: 'Suggest a fix for the Pitch 2 clash',
  },
  wellness: {
    metrics: [
      { key: 'appts', label: 'Appointments today', definition: 'Confirmed appointments today', range: 'Today', source: 'Calendar', icon: 'calendar', pastel: P.sage, perLoc: [11, 9, 8, 7, null], agg: 'sum', kind: 'count' },
      { key: 'cancel', label: 'Cancellations', definition: 'Appointments cancelled today', range: 'Today', source: 'Calendar', icon: 'x', pastel: P.blush, perLoc: [1, 1, 0, 1, null], agg: 'sum', kind: 'count' },
      { key: 'util', label: 'Utilisation', definition: 'Booked practitioner hours ÷ available hours', range: 'This week', source: 'Practitioner calendars', icon: 'activity', pastel: P.aqua, perLoc: [0.84, 0.79, 0.76, null, null], agg: 'avg', kind: 'percent' },
      { key: 'revenue', label: 'Revenue', definition: 'Succeeded payments incl. deposits, refunds excluded', range: 'Last 7 days', source: 'Stripe', icon: 'wallet', pastel: P.butter, revenue: true },
    ],
    upcomingTitle: 'Next appointments',
    upcoming: [
      ['hf', '10:00', 'Deep tissue · Rina K.', 'Jordan P. · Room A', 'Confirmed', 'success'],
      ['hf', '11:30', 'Hot stone · Rina K.', 'Kai S. · Room B', 'Deposit paid', 'info'],
      ['mb', '13:00', 'Facial · Tom B.', 'Mira D. · Room C', 'Confirmed', 'success'],
      ['hf', '14:00', 'Facial · Tom B.', 'Room C', 'Cancelled', 'danger'],
    ],
    attention: [
      { id: 'a1', icon: 'refresh', title: 'Reschedule request', detail: 'Jordan P. wants the 10:00 deep tissue moved', titleKey: 'attention.rescheduleRequest', detailKey: 'attention.wantsMoved', detailParams: { name: 'Jordan P.', time: '10:00', service: 'Deep tissue' }, href: '/ops/calendar', kind: 'action', locId: 'hf' },
      { id: 'a2', icon: 'user', title: 'Ana L. absent Friday', detail: '4 appointments need reassigning', titleKey: 'attention.absentFriday', titleParams: { name: 'Ana L.' }, detailKey: 'attention.appointmentsReassign', detailParams: { count: 4 }, href: '/ops/practitioners', kind: 'action', locId: 'yv' },
      { id: 'a3', icon: 'alert', title: 'Fitzroy calendar sync degraded', detail: 'Utilisation unavailable for Melbourne', titleKey: 'attention.calendarSyncDegraded', titleParams: { place: 'Fitzroy' }, detailKey: 'attention.utilisationUnavailable', detailParams: { place: 'Melbourne' }, href: '/connections', kind: 'integration', locId: 'fz' },
    ],
    aiPrompt: 'Draft a reply using our cancellation policy',
  },
  commerce: {
    metrics: [
      { key: 'orders', label: 'Orders', definition: 'Orders imported from connected stores', range: 'Last 7 days', source: 'WooCommerce', icon: 'receipt', pastel: P.butter, perLoc: [31, 24, 17, 14, null], agg: 'sum', kind: 'count' },
      { key: 'stock', label: 'Stock warnings', definition: 'Variants at or below reorder level', range: 'Now', source: 'Inventory', icon: 'alert', pastel: P.blush, perLoc: [2, 1, 1, 1, null], agg: 'sum', kind: 'count' },
      { key: 'revenue', label: 'Revenue', definition: 'Succeeded order payments, refunds excluded, per currency', range: 'Last 7 days', source: 'WooCommerce', icon: 'wallet', pastel: P.lime, revenue: true },
      { key: 'sync', label: 'Store sync health', definition: 'Stores with a successful sync in the last hour', range: 'Now', source: 'Connections', icon: 'refresh', pastel: P.aqua, perLoc: [1, 1, 1, 1, 0], agg: 'sum', kind: 'count' },
    ],
    upcomingTitle: 'To fulfil today',
    upcoming: [
      ['pd', '10:20', '#5521 · Linen overshirt ×2', 'Portland · ship', 'To fulfil', 'info', ['upcoming.detail.ship', { place: 'Portland' }]],
      ['sf', '11:05', '#5524 · Merino crew', 'Hayes Valley · pickup', 'To fulfil', 'info', ['upcoming.detail.pickup', { place: 'Hayes Valley' }]],
      ['am', '14:10', '#5526 · Field notebook set', 'De Pijp · pickup', 'To fulfil', 'info', ['upcoming.detail.pickup', { place: 'De Pijp' }]],
      ['pd', '11:40', '#5517 · Canvas tote', 'Portland', 'Payment failed', 'danger'],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Merino crew failed to sync to 2 stores', detail: 'Variant mismatch on size XS', titleKey: 'attention.productSyncFailed', titleParams: { product: 'Merino crew', count: 2 }, detailKey: 'attention.variantMismatch', detailParams: { size: 'XS' }, href: '/ops/catalogue', kind: 'integration' },
      { id: 'a2', icon: 'box', title: 'Linen overshirt L low at Portland', detail: '1 on hand', titleKey: 'attention.lowStock', titleParams: { item: 'Linen overshirt L', place: 'Portland' }, detailKey: 'attention.onHand', detailParams: { count: 1 }, href: '/ops/inventory', kind: 'action', locId: 'pd' },
      { id: 'a3', icon: 'wifi-off', title: 'Austin store disconnected', detail: 'Orders there are not imported until it reconnects', titleKey: 'attention.storeDisconnected', titleParams: { place: 'Austin' }, detailKey: 'attention.ordersNotImported', href: '/connections', kind: 'integration', locId: 'au' },
    ],
    aiPrompt: 'Explain this week’s stock trend',
  },
  foods: {
    metrics: [
      { key: 'open', label: 'Open orders', definition: 'Orders not yet collected, cancelled or rejected', range: 'Now', source: 'Pickup ordering', icon: 'receipt', pastel: P.blush, perLoc: [5, 3, 4, 2, null], agg: 'sum', kind: 'count' },
      { key: 'capacity', label: 'Pickup capacity used', definition: 'Booked pickup slots ÷ slot capacity', range: 'Next hour', source: 'Slot settings', icon: 'clock', pastel: P.butter, perLoc: [0.62, 0.48, 0.55, 0.4, null], agg: 'avg', kind: 'percent' },
      { key: 'soldout', label: 'Sold-out items', definition: 'Menu items marked sold out locally', range: 'Now', source: 'Location menus', icon: 'x', pastel: P.grey, perLoc: [1, 0, 0, 1, null], agg: 'sum', kind: 'count' },
      { key: 'revenue', label: 'Revenue', definition: 'Succeeded pickup payments, refunds excluded, per currency', range: 'Last 7 days', source: 'Stripe', icon: 'wallet', pastel: P.lime, revenue: true },
    ],
    upcomingTitle: 'Next pickups',
    upcoming: [
      ['bl', '12:08', '#1039 · Tom', 'Ballard', 'Ready', 'success'],
      ['bl', '12:14', '#1044 · Ana', 'Ballard', 'Preparing', 'info'],
      ['bl', '12:18', '#1045 · Daniel', 'Ballard', 'Awaiting acceptance', 'warning'],
      ['bo', '19:30', '#2207 · Oliver', 'Borough', 'Accepted', 'neutral'],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Order #1041 overdue 6 min', detail: 'Ballard kitchen', titleKey: 'attention.orderOverdue', titleParams: { ref: '#1041', minutes: 6 }, detailKey: 'attention.kitchenOf', detailParams: { place: 'Ballard' }, href: '/ops/kitchen', kind: 'action', locId: 'bl' },
      { id: 'a2', icon: 'card', title: 'Payment without order', detail: 'Lena W. · $34.65 USD · recovery queue', titleKey: 'attention.paymentWithoutOrder', detailKey: 'attention.recoveryQueue', detailParams: { name: 'Lena W.', amount: moneyArg(3465, 'USD') }, href: '/payments?tab=reconciliation', kind: 'action', locId: 'bl' },
      { id: 'a3', icon: 'wifi-off', title: 'Fremont kitchen screen offline', detail: 'Orders still arrive by email', titleKey: 'attention.kitchenScreenOffline', titleParams: { place: 'Fremont' }, detailKey: 'attention.ordersByEmail', href: '/connections', kind: 'integration', locId: 'fr' },
    ],
    aiPrompt: 'Summarise today’s production by item',
  },
  realty: {
    metrics: [
      { key: 'active', label: 'Active listings', definition: 'Listings currently active or under offer', range: 'Now', source: 'BranchHarbor listings', icon: 'house', pastel: P.aqua, perLoc: [4, 2, 2, 2, 1, 2], agg: 'sum', kind: 'count' },
      { key: 'enquiries', label: 'New enquiries', definition: 'Website, portal and phone enquiries received', range: 'Last 7 days', source: 'Enquiries inbox', icon: 'mail', pastel: P.lime, perLoc: [6, 2, 2, 2, 1, 2], agg: 'sum', kind: 'count' },
      { key: 'viewings', label: 'Viewings this week', definition: 'Requested and confirmed viewings, in each office’s time zone', range: 'This week', source: 'Viewings calendar', icon: 'key', pastel: P.lilac, perLoc: [7, 1, 2, 1, 0, 1], agg: 'sum', kind: 'count' },
      { key: 'offers', label: 'Offers in negotiation', definition: 'Submitted or countered offers', range: 'Now', source: 'Offers', icon: 'receipt', pastel: P.butter, perLoc: [1, 0, 0, 0, null, 0], agg: 'sum', kind: 'count' },
    ],
    upcomingTitle: 'Upcoming viewings',
    upcoming: [
      ['tor', '11:00', '42 Birchmount Cres · Nadia Hassan', 'Toronto Midtown · Omar & Sara H.', 'Confirmed', 'success'],
      ['tor', '14:30', 'Suite 1806 – 88 Harbour St · Nadia Hassan', 'Toronto Midtown · Grace L.', 'Awaiting confirmation', 'warning'],
      ['lon', '10:30', '14 Flask Walk · James Whitfield', 'London Hampstead · Charlotte E.', 'Confirmed', 'success'],
      ['mad', '12:00', 'Piso exterior, Salamanca · Lucía Romero', 'Madrid Salamanca · Carmen D.', 'Confirmed', 'success'],
    ],
    attention: [
      { id: 'a1', icon: 'shield', title: '1 listing awaiting HQ approval', detail: 'Townhouse with rooftop terrace · Toronto Midtown', titleKey: 'attention.listingsAwaitingHq', titleParams: { count: 1 }, href: '/ops/listings', kind: 'action', locId: 'tor' },
      { id: 'a2', icon: 'mail', title: '1 enquiry in the office pool', detail: 'Valuation request · Toronto Midtown', titleKey: 'attention.enquiriesInPool', titleParams: { count: 1 }, detailKey: 'attention.valuationRequestAt', detailParams: { place: 'Toronto Midtown' }, href: '/ops/enquiries', kind: 'action', locId: 'tor' },
      { id: 'a3', icon: 'receipt', title: 'Offer countered — awaiting buyer', detail: '42 Birchmount Cres · expires in 2 days', titleKey: 'attention.offerCountered', detailKey: 'attention.expiresInDays', detailParams: { place: '42 Birchmount Cres', days: 2 }, href: '/ops/offers', kind: 'action', locId: 'tor' },
    ],
    aiPrompt: 'Summarise viewing feedback for 42 Birchmount Cres',
  }, /** Live-API only: no sample data; mirrors realty so sample mode stays type-complete. */ get hospitality() { return OVERVIEW.realty; } };

/** Catalogue keys (namespace "data") for the English range/source/title strings above. Provider names have none. */
const RANGE_KEYS: Record<string, string> = {
  'Last 7 days': 'range.last7Days', 'Last 30 days': 'range.last30Days', Today: 'range.today', 'This week': 'range.thisWeek', Now: 'range.now', 'Next hour': 'range.nextHour', 'Autumn season': 'range.autumnSeason',
};
const SOURCE_KEYS: Record<string, string> = {
  'Website forms': 'source.websiteForms', 'Booking connection': 'source.bookingConnection', 'Membership system': 'source.membershipSystem', Registrations: 'source.registrations', Schedule: 'source.schedule',
  Calendar: 'source.calendar', 'Practitioner calendars': 'source.practitionerCalendars', Inventory: 'source.inventory', Connections: 'source.connections', 'Pickup ordering': 'source.pickupOrdering',
  'Slot settings': 'source.slotSettings', 'Location menus': 'source.locationMenus', 'BranchHarbor listings': 'source.bhListings', 'Enquiries inbox': 'source.enquiriesInbox', 'Viewings calendar': 'source.viewingsCalendar', Offers: 'source.offers',
};
const UPCOMING_TITLE_KEYS: Record<string, string> = {
  'Upcoming classes': 'upcoming.title.classes', 'Today’s sessions': 'upcoming.title.sessionsToday', 'Next appointments': 'upcoming.title.nextAppointments', 'To fulfil today': 'upcoming.title.toFulfilToday',
  'Next pickups': 'upcoming.title.nextPickups', 'Upcoming viewings': 'upcoming.title.viewings',
};
/** Status label → data key `upcoming.status.*` (+ arguments). */
const UPCOMING_STATUS: Record<string, [string, MsgParams?]> = {
  'Cover requested': ['cover_requested'], Full: ['full'], Open: ['open'], '1 spot': ['spots_left', { count: 1 }], Scheduled: ['scheduled'], 'Venue clash': ['venue_clash'], Confirmed: ['confirmed'],
  'Deposit paid': ['deposit_paid'], Cancelled: ['cancelled'], 'To fulfil': ['to_fulfil'], 'Payment failed': ['payment_failed'], Ready: ['ready'], Preparing: ['preparing'],
  'Awaiting acceptance': ['awaiting_acceptance'], Accepted: ['accepted'], 'Awaiting confirmation': ['awaiting_confirmation'],
};

export function buildOverview(ind: IndustryKey, locIds: string[]) {
  const f = FIXTURES[ind];
  const cfg = OVERVIEW[ind];
  const idx = f.locations.map((l, i) => [l, i] as const).filter(([l]) => locIds.includes(l.id));
  const metrics: Metric[] = cfg.metrics.map((m) => {
    const base = {
      key: m.key, label: m.label, labelKey: `metric.${ind}.${m.key}.label`, definition: m.definition, definitionKey: `metric.${ind}.${m.key}.definition`,
      range: m.range, rangeKey: RANGE_KEYS[m.range], source: m.source, sourceKey: SOURCE_KEYS[m.source], icon: m.icon, pastel: m.pastel,
    };
    if (m.notConnected) return { ...base, state: 'not_connected', value: null, note: m.note, noteKey: 'note.noMembershipSystem' };
    if (m.revenue) {
      const avail = idx.filter(([l]) => l.revenue7d.amount > 0);
      const missing = idx.filter(([l]) => l.revenue7d.amount === 0 && l.sync === 'attention' && l.site === 'live').map(([l]) => l.name);
      if (!avail.length) return { ...base, state: 'unavailable', value: null, ...(missing.length ? { note: `Sync unavailable at ${missing.join(', ')}`, noteKey: 'note.syncUnavailableAt', noteParams: { list: missing } } : { note: 'No payments yet in this scope', noteKey: 'note.noPayments' }) };
      const map = new Map<Currency, number>();
      for (const [l] of avail) map.set(l.currency, (map.get(l.currency) ?? 0) + l.revenue7d.amount);
      const values: Money[] = [...map.entries()].map(([currency, amount]) => ({ currency, amount }));
      const note = missing.length ? { note: `Excludes ${missing.join(', ')} (sync degraded)`, noteKey: 'note.excludesDegraded', noteParams: { list: missing } } : values.length > 1 ? { note: 'Shown per currency · not combined', noteKey: 'note.perCurrency' } : {};
      return { ...base, state: 'ok', value: { kind: 'money', values }, ...note };
    }
    const vals = idx.map(([l, i]) => [l, m.perLoc?.[i] ?? null] as const);
    const ok = vals.filter(([, v]) => v != null) as (readonly [(typeof f.locations)[number], number])[];
    const missing = vals.filter(([l, v]) => v == null && l.site === 'live').map(([l]) => l.name.split(' – ').pop());
    if (!ok.length) return { ...base, state: 'unavailable', value: null, ...(missing.length ? { note: `Not available for ${missing.join(', ')}`, noteKey: 'note.notAvailableFor', noteParams: { list: missing as string[] } } : {}) };
    const total = ok.reduce((s, [, v]) => s + v, 0);
    const value: MetricValue = m.kind === 'percent' ? { kind: 'percent', value: total / ok.length } : m.key === 'sync' ? { kind: 'ratio', value: total, of: idx.length } : { kind: 'count', value: total };
    return { ...base, state: 'ok', value, ...(missing.length ? { note: `Excludes ${missing.join(', ')}`, noteKey: 'note.excludes', noteParams: { list: missing as string[] } } : {}) };
  });
  const upcoming = cfg.upcoming
    .filter(([lid]) => locIds.includes(lid))
    .map(([lid, hhmm, title, detail, label, tone, detailMsg], i) => {
      const l = loc(ind, lid);
      const st = UPCOMING_STATUS[label] ?? [label.toLowerCase().replace(/[^a-z]+/g, '_')];
      return {
        id: `u${i}`, at: at(l.timeZone, hhmm), timeZone: l.timeZone, title, detail, ...(detailMsg ? { detailKey: detailMsg[0], detailParams: detailMsg[1] } : {}),
        status: { label, labelKey: `upcoming.status.${st[0]}`, ...(st[1] ? { labelParams: st[1] } : {}), tone },
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const attention = cfg.attention.filter((a) => !a.locId || locIds.includes(a.locId)).map(({ locId: _l, ...a }) => a);
  return { metrics, upcomingTitle: cfg.upcomingTitle, upcomingTitleKey: UPCOMING_TITLE_KEYS[cfg.upcomingTitle], upcoming, attention, aiPrompt: cfg.aiPrompt, aiPromptKey: `ai.prompt.${ind}` };
}

/* ------------------------------------------------------------------ */
/* Generic tables                                                      */
/* ------------------------------------------------------------------ */

/** UI text in cells is a catalogue reference (`tbl`/`lbl`, namespace "data" → `table.*`); plain strings are sample business data. */
const tx = (v: Txt, sub?: Txt, strong?: boolean): Cell => ({
  t: 'text',
  v: plain(v),
  ...(isRef(v) ? { vMsg: v } : {}),
  ...(sub ? { sub: plain(sub), ...(isRef(sub) ? { subMsg: sub } : {}) } : {}),
  strong,
});
/** Badge labels are always UI text: plain strings are keyed by their slug (`table.badge.*`). */
const b = (v: Txt, tone: Tone, icon?: IconName): Cell => {
  const m = typeof v === 'string' ? lbl('badge', v) : v;
  return { t: 'badge', v: plain(m), vMsg: m, tone, icon };
};
const mo = (major: number, currency: Currency, sub?: Txt): Cell => ({ t: 'money', v: { amount: Math.round(major * 100), currency }, ...(sub ? { sub: plain(sub), ...(isRef(sub) ? { subMsg: sub } : {}) } : {}) });
const og = (v: 'hq' | 'local' | 'locked' | 'approval'): Cell => ({ t: 'origin', v });
const na = (reason?: string): Cell => (reason ? { t: 'unavailable', reason, reasonMsg: lbl('na', reason) } : { t: 'unavailable' });

/* Composed UI text for the sample rows. */
const c = (english: string) => lbl('cell', english);
const tzOf = (ind: IndustryKey, id: string) => loc(ind, id).timeZone;
const zone = (ind: IndustryKey, id: string) => tbl('cell.value', { value: zoneArg(tzOf(ind, id)) }, tzOf(ind, id));
const todayAt = (ind: IndustryKey, id: string, hhmm: string) => tbl('cell.todayAt', { time: timeArg(at(tzOf(ind, id), hhmm), tzOf(ind, id)) }, `Today ${hhmm}`);
const todayAtPlace = (ind: IndustryKey, id: string, hhmm: string, place: string) => tbl('cell.todayAtPlace', { time: timeArg(at(tzOf(ind, id), hhmm), tzOf(ind, id)), place }, `Today ${hhmm} · ${place}`);
const dayAtPlace = (ind: IndustryKey, id: string, days: number, hhmm: string, place: string) => tbl('cell.whenAtPlace', { when: { t: 'date', at: at(tzOf(ind, id), hhmm, days), tz: tzOf(ind, id), style: 'dayTime' }, place }, `${hhmm} · ${place}`);
const day = (iso: string) => tbl('cell.value', { value: dayArg(`${iso}T12:00:00Z`) }, iso);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const minutes = (n: number) => tbl('cell.minutes', { count: n }, `${n} min`);
const hoursRange = (ind: IndustryKey, id: string, from: string, to: string) => tbl('cell.timeRange', { from: timeArg(at(tzOf(ind, id), from), tzOf(ind, id)), to: timeArg(at(tzOf(ind, id), to), tzOf(ind, id)) }, `${from}–${to}`);

type RowSpec = [id: string, tags: string[], cells: Cell[], locId?: string];
interface TableSpec {
  /** Column headers, filter labels, source, description and primary action are UI text keyed by slug (`table.col.*`, …). */
  columns: [string, string, ('left' | 'right')?][];
  filters: [string, string][];
  source: string;
  description?: string;
  primaryAction?: string;
  rows: RowSpec[];
}

/** Built per call so relative times ("today 17:00") follow the clock. */
const tables = (): Record<string, TableSpec> => ({
  /* Studios */
  offers: { columns: [['offer', 'Offer'], ['eligibility', 'Eligibility'], ['locations', 'Locations'], ['valid', 'Valid'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['pending', 'Needs approval']], source: 'BranchHarbor offers', primaryAction: 'New offer',
    rows: [
      ['o1', ['active'], [tx('New Year Intro', tbl('cell.classesPrices', { count: 3, prices: [moneyArg(3900, 'CAD'), moneyArg(3500, 'USD'), moneyArg(2900, 'GBP'), moneyArg(3200, 'EUR'), moneyArg(4500, 'AUD')] }, '3 classes · CA$39 / US$35 / £29 / €32 / A$45'), true), tx(c('New members only')), tx(c('All locations')), tx(tbl('cell.dateRange', { from: dayArg('2027-01-02T12:00:00Z'), to: dayArg('2027-01-31T12:00:00Z') }, '2–31 Jan')), b('Active', 'success')]],
      ['o2', ['active'], [tx('First class free', c('Local override'), true), tx(c('New members')), tx('Toronto – Queen West'), tx(c('Ongoing')), b('Local', 'info')], 'qw'],
      ['o3', ['pending'], [tx('Friends week', 'Bring a friend', true), tx(c('Members')), tx('Toronto – Leslieville'), tx(tbl('cell.dateRange', { from: dayArg('2026-11-09T12:00:00Z'), to: dayArg('2026-11-15T12:00:00Z') }, '9–15 Nov')), b('Needs approval', 'warning')], 'ls'],
      ['o4', ['active'], [tx('Neujahrs-Intro', 'Berlin launch offer', true), tx(c('New members')), tx('Berlin – Prenzlauer Berg'), tx(tbl('cell.fromDate', { date: dayArg('2026-11-04T12:00:00Z') }, 'From 4 Nov')), b('Scheduled', 'neutral', 'clock')], 'pb'],
    ] },
  members: { columns: [['member', 'Member'], ['plan', 'Plan'], ['home', 'Home studio'], ['attendance', 'Attendance (30d)', 'right'], ['consent', 'Consent'], ['state', 'State']], filters: [['all', 'All'], ['active', 'Active'], ['low', 'Low balance'], ['trial', 'Trial']], source: 'Booking connection · consent from BranchHarbor',
    rows: [
      ['m1', ['active'], [tx('Ava Chen', 'ava@…', true), tx('Unlimited monthly'), tx('Toronto – Queen West'), tx('14'), b('Email', 'success'), b('Active', 'success')], 'qw'],
      ['m2', ['low'], [tx('Liam Ortiz', 'liam@…', true), tx('10-class pack', tbl('cell.creditsLeftExpires', { count: 3, date: dayArg('2026-11-30T12:00:00Z') }, '3 left · expires 30 Nov')), tx('Toronto – Queen West'), tx('6'), b('Email', 'success'), b('Low balance', 'warning')], 'qw'],
      ['m3', ['trial'], [tx('Noor Haddad', 'noor@…', true), tx('Intro offer', tbl('cell.usedOf', { used: 2, total: 3 }, '2 of 3 used')), tx('Toronto – Leslieville'), tx('2'), b('None', 'neutral', 'minus'), b('Trial', 'info')], 'ls'],
      ['m4', ['active'], [tx('Ben Ross', 'ben@…', true), tx('Unlimited monthly'), tx('Vancouver – Kitsilano'), na('Sync degraded'), b('Email', 'success'), b('Payment failed', 'danger')], 'kt'],
      ['m5', ['active'], [tx('Harriet Cole', 'harriet@…', true), tx('8-class pack', tbl('cell.creditsLeft', { count: 5 }, '5 left')), tx('London – Shoreditch'), tx('9'), b('Email + SMS', 'success'), b('Active', 'success')], 'sh'],
      ['m6', ['trial'], [tx('Jack Nguyen', 'jack@…', true), tx('Intro offer', tbl('cell.usedOf', { used: 1, total: 3 }, '1 of 3 used')), tx('Sydney – Surry Hills'), tx('1'), b('Email', 'success'), b('Trial', 'info')], 'sy'],
    ] },
  /* Sports */
  programmes: { columns: [['programme', 'Program'], ['ages', 'Ages'], ['venue', 'Venue'], ['fee', 'Fee', 'right'], ['registration', 'Registration'], ['capacity', 'Capacity', 'right']], filters: [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']], source: 'BranchHarbor programs', primaryAction: 'New program',
    rows: [
      ['p1', ['open'], [tx('U10 Autumn', tbl('cell.seasonWeeks', { count: 12 }, 'Season · 12 weeks'), true), tx(tbl('cell.born', { year: '2016' }, 'Born 2016')), tx('Vancouver – Riverside Park'), mo(240, 'CAD'), b(tbl('badge.openUntil', { date: dayArg('2026-10-25T12:00:00Z') }, 'Open to 25 Oct'), 'success'), tx('30 / 32')], 'rp'],
      ['p2', ['open'], [tx('U12 Camp', tbl('cell.halfTermDays', { count: 5 }, 'Half-term · 5 days'), true), tx(tbl('cell.born', { year: '2014' }, 'Born 2014')), tx('Vancouver – Riverside Park'), mo(180, 'CAD'), b('Open', 'success'), tx('22 / 24')], 'rp'],
      ['p3', ['closed'], [tx('U8 Fundamentals', c('Season'), true), tx(tbl('cell.born', { year: '2018' }, 'Born 2018')), tx('Toronto – Hillcrest Dome'), mo(190, 'CAD'), b('Closed', 'neutral', 'minus'), tx('20 / 20')], 'hc'],
      ['p4', ['open'], [tx('U14 Development', tbl('cell.seasonWeeks', { count: 10 }, 'Season · 10 weeks'), true), tx(tbl('cell.born', { year: '2012' }, 'Born 2012')), tx('Manchester – Didsbury'), mo(165, 'GBP'), b('Open', 'success'), tx('18 / 22')], 'mc'],
      ['p5', ['closed'], [tx('Spring Juniors', c('Season'), true), tx(tbl('cell.bornRange', { from: '2017', to: '2018' }, 'Born 2017–2018')), tx('Dublin – Ringsend'), mo(150, 'EUR'), b('Payments not enabled', 'warning'), tx('0 / 24')], 'dn'],
    ] },
  teams: { columns: [['group', 'Group'], ['coach', 'Coach'], ['programme', 'Program'], ['roster', 'Roster', 'right'], ['next', 'Next session']], filters: [['all', 'All'], ['open', 'Open'], ['full', 'Full']], source: 'BranchHarbor groups',
    rows: [
      ['t1', ['open'], [tx('U10 Blue', '', true), tx('Coach Ortiz'), tx('U10 Autumn'), tx('14 / 16'), tx(todayAtPlace('sports', 'rp', '17:00', 'Pitch 2'))], 'rp'],
      ['t2', ['full'], [tx('U10 Green', '', true), tx('Coach Ahmed'), tx('U10 Autumn'), b(tbl('badge.rosterFull', { count: 16, capacity: 16 }, '16 / 16 · Full'), 'warning'), tx(dayAtPlace('sports', 'rp', 2, '17:00', 'Pitch 1'))], 'rp'],
      ['t3', ['open'], [tx('U12 Camp', '', true), tx('Coach Lee'), tx('U12 Camp'), tx('22 / 24'), tx(todayAtPlace('sports', 'rp', '17:00', 'Pitch 2'))], 'rp'],
      ['t4', ['open'], [tx('U14 Reds', '', true), tx('Coach Hale'), tx('U14 Development'), tx('18 / 22'), tx(todayAtPlace('sports', 'mc', '18:00', 'Main pitch'))], 'mc'],
    ] },
  schedule: { columns: [['when', 'When'], ['group', 'Group'], ['venue', 'Venue'], ['coach', 'Coach'], ['check', 'Check']], filters: [['all', 'This week'], ['conflict', 'Conflicts']], source: 'Schedule · venue bookings',
    rows: [
      ['s1', [], [tx(todayAt('sports', 'rp', '16:00'), zone('sports', 'rp')), tx('U8 Red', '', true), tx('Riverside Park · Pitch 1'), tx('Coach Diaz'), b('Clear', 'success')], 'rp'],
      ['s2', ['conflict'], [tx(todayAt('sports', 'rp', '17:00'), zone('sports', 'rp')), tx('U10 Blue', '', true), tx('Riverside Park · Pitch 2'), tx('Coach Ortiz'), b('Venue clash', 'danger')], 'rp'],
      ['s3', ['conflict'], [tx(todayAt('sports', 'rp', '17:00'), zone('sports', 'rp')), tx('U12 Camp', '', true), tx('Riverside Park · Pitch 2'), tx('Coach Lee'), b('Venue clash', 'danger')], 'rp'],
      ['s4', [], [tx(todayAt('sports', 'mc', '18:00'), zone('sports', 'mc')), tx('U14 Reds', '', true), tx('Didsbury · Main pitch'), tx('Coach Hale'), b('Clear', 'success')], 'mc'],
    ] },
  participants: { columns: [['participant', 'Participant'], ['age', 'Age', 'right'], ['group', 'Group'], ['guardian', 'Guardian'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['waitlisted', 'Waitlisted']], source: 'Registrations',
    rows: [
      ['pa1', ['active'], [tx('Ella M.', '', true), tx('9'), tx('U10 Blue'), tx('Sara M.', c('Verified')), b('Active', 'success')], 'rp'],
      ['pa2', ['active'], [tx('Jonah P.', '', true), tx('11'), tx('U12 Camp'), tx('Dev P.', c('Verified')), b('Active', 'success')], 'rp'],
      ['pa3', ['waitlisted'], [tx('Leo R.', '', true), tx('9'), tx('—'), tx('Kim R.', c('Invitation pending')), b('Waitlisted', 'info')], 'rp'],
      ['pa4', ['active'], [tx('Freddie W.', '', true), tx('13'), tx('U14 Reds'), tx('Claire W.', c('Verified')), b('Active', 'success')], 'mc'],
    ] },
  /* Wellness */
  services: { columns: [['service', 'Service'], ['duration', 'Duration'], ['price', 'Price', 'right'], ['buffer', 'Buffer'], ['needs', 'Needs'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['paused', 'Paused']], source: 'BranchHarbor services', primaryAction: 'New service',
    rows: [
      ['sv1', ['active'], [tx('Deep tissue', 'Toronto', true), tx(minutes(60)), mo(120, 'CAD'), tx(minutes(15)), tx('Room A or B'), b('Active', 'success')], 'hf'],
      ['sv2', ['active'], [tx('Hot stone', 'Toronto', true), tx(minutes(90)), mo(165, 'CAD'), tx(minutes(20)), tx('Room B · stone heater'), b('Active', 'success')], 'hf'],
      ['sv3', ['paused'], [tx('Facial', 'Toronto', true), tx(minutes(45)), mo(95, 'CAD'), tx(minutes(10)), tx('Room C'), b('Paused', 'neutral', 'minus')], 'yv'],
      ['sv4', ['active'], [tx('Deep tissue', 'London', true), tx(minutes(60)), mo(85, 'GBP'), tx(minutes(15)), tx('Treatment room 1'), b('Active', 'success')], 'mb'],
      ['sv5', ['active'], [tx('Remedial massage', 'Melbourne', true), tx(minutes(60)), mo(125, 'AUD'), tx(minutes(15)), tx('Room 2'), b('Active', 'success')], 'fz'],
    ] },
  practitioners: { columns: [['practitioner', 'Practitioner'], ['services', 'Services'], ['locations', 'Locations'], ['week', 'This week']], filters: [['all', 'All'], ['today', 'Available today']], source: 'Practitioner calendars',
    rows: [
      ['pr1', ['today'], [tx('Rina K.', '', true), tx('Deep tissue, hot stone'), tx('Harbourfront'), tx(tbl('cell.hoursBooked', { count: 31 }, '31 h booked'))], 'hf'],
      ['pr2', ['today'], [tx('Tom B.', '', true), tx('Facial'), tx('Harbourfront, Yorkville'), tx(tbl('cell.hoursBooked', { count: 18 }, '18 h booked'))], 'hf'],
      ['pr3', [], [tx('Ana L.', '', true), tx('Deep tissue'), tx('Yorkville'), b(tbl('badge.absentOn', { date: dayArg(`${daysFromNow(2)}T12:00:00Z`) }, 'Absent Fri'), 'warning')], 'yv'],
      ['pr4', ['today'], [tx('Grace O.', '', true), tx('Deep tissue, facial'), tx('Marylebone'), tx(tbl('cell.hoursBooked', { count: 22 }, '22 h booked'))], 'mb'],
    ] },
  forms: { columns: [['form', 'Form'], ['used', 'Used by'], ['version', 'Consent version'], ['ai', 'AI access']], filters: [['all', 'All']], source: 'BranchHarbor forms', description: 'Administrative questions only. Responses are excluded from AI context by default.',
    rows: [
      ['f1', [], [tx('New client intake', '', true), tx(c('All services')), tx(tbl('cell.versionSince', { version: 'v3', date: { t: 'date', at: '2026-09-01T12:00:00Z', style: 'monthYear' } }, 'v3 · Sep 2026')), b('Excluded', 'neutral', 'lock')]],
      ['f2', [], [tx('Hot stone screening', '', true), tx('Hot stone'), tx('v1'), b('Excluded', 'neutral', 'lock')]],
    ] },
  clients: { columns: [['client', 'Client'], ['last', 'Last visit'], ['next', 'Next'], ['prefs', 'Preferences'], ['notes', 'Notes']], filters: [['all', 'All'], ['upcoming', 'Upcoming']], source: 'Calendar · scoped notes',
    rows: [
      ['c1', ['upcoming'], [tx('Jordan P.', '', true), tx(day('2026-10-02')), tx(todayAt('wellness', 'hf', '10:00')), tx('Medium pressure'), b('Scoped', 'info', 'lock')], 'hf'],
      ['c2', ['upcoming'], [tx('Kai S.', '', true), tx(day('2026-09-20')), tx(todayAt('wellness', 'hf', '11:30')), tx('Quiet room'), b('None', 'neutral', 'minus')], 'hf'],
      ['c3', [], [tx('Amelia F.', '', true), tx(day('2026-09-28')), tx('—'), tx('Unscented oils'), b('None', 'neutral', 'minus')], 'mb'],
    ] },
  /* Commerce */
  catalogue: { columns: [['product', 'Product'], ['variants', 'Variants', 'right'], ['editable', 'Editable locally'], ['stores', 'Stores'], ['sync', 'Sync']], filters: [['all', 'All'], ['published', 'Published'], ['draft', 'Draft'], ['failed', 'Failed']], source: 'Master catalog · WooCommerce', primaryAction: 'New product',
    rows: [
      ['pr1', ['published'], [tx('Linen overshirt', tbl('cell.sku', { sku: 'FN-LO' }, 'SKU FN-LO'), true), tx('4'), tx(c('Price ±10%, availability')), tx(tbl('cell.ofTotal', { count: 5, total: 5 }, '5 of 5')), b('Synced', 'success')]],
      ['pr2', ['failed'], [tx('Merino crew', tbl('cell.sku', { sku: 'FN-MC' }, 'SKU FN-MC'), true), tx('6'), tx(c('Availability')), tx(tbl('cell.ofTotal', { count: 3, total: 5 }, '3 of 5')), b(tbl('badge.failedSizeMismatch', { count: 2, size: 'XS' }, '2 failed · XS mismatch'), 'warning')]],
      ['pr3', ['draft'], [tx('Canvas tote', tbl('cell.sku', { sku: 'FN-CT' }, 'SKU FN-CT'), true), tx('1'), tx('—'), tx('0'), b('Draft', 'neutral', 'minus')]],
      ['pr4', ['published'], [tx('Field notebook set', tbl('cell.sku', { sku: 'FN-NB' }, 'SKU FN-NB'), true), tx('2'), tx(c('Price ±10%')), tx(tbl('cell.ofTotal', { count: 5, total: 5 }, '5 of 5')), b('Synced', 'success')]],
    ] },
  assortment: { columns: [['item', 'Item'], ['onhand', 'On hand', 'right'], ['price', 'Price', 'right'], ['origin', 'Origin'], ['availability', 'Availability']], filters: [['all', 'All'], ['low', 'Low'], ['overrides', 'Overrides']], source: 'Local assortment',
    rows: [
      ['as1', [], [tx('Linen overshirt · M', 'Portland', true), tx('12'), mo(98, 'USD'), og('hq'), b('In stock', 'success')], 'pd'],
      ['as2', ['low'], [tx('Linen overshirt · L', 'Portland', true), tx('1'), mo(98, 'USD'), og('hq'), b('Low', 'warning')], 'pd'],
      ['as3', ['overrides'], [tx('Merino crew · S', 'Montréal', true), tx('7'), mo(109, 'CAD'), og('local'), b('In stock', 'success')], 'me'],
      ['as4', [], [tx('Linen overshirt · M', 'Amsterdam', true), tx('9'), mo(92, 'EUR'), og('hq'), b('In stock', 'success')], 'am'],
    ] },
  inventory: { columns: [['when', 'When'], ['item', 'Item'], ['change', 'Change', 'right'], ['reason', 'Reason'], ['balance', 'On hand after', 'right'], ['by', 'By']], filters: [['all', 'All'], ['adjust', 'Adjustments'], ['sale', 'Sales'], ['reserved', 'Reservations']], source: 'Inventory history (movements, not just counts)',
    description: 'Every change to stock with its reason. Reservations hold units for unpaid orders and do not change on-hand stock.',
    rows: [
      ['iv1', ['sale'], [tx(todayAt('commerce', 'pd', '09:12'), zone('commerce', 'pd')), tx('Linen overshirt · L', 'Portland', true), tx('−1'), tx(lbl('reason', 'Sale'), '#5521'), tx('1'), tx('WooCommerce')], 'pd'],
      ['iv4', ['reserved'], [tx(todayAt('commerce', 'pd', '08:40'), zone('commerce', 'pd')), tx('Field notebook set', 'Portland', true), tx('−2'), b('Reserved · unpaid order', 'info', 'clock'), na('Not on-hand'), tx(c('System'))], 'pd'],
      ['iv2', ['adjust'], [tx(c('Yesterday'), zone('commerce', 'pd')), tx('Merino crew · S', 'Portland', true), tx('+12'), tx(lbl('reason', 'Received'), 'PO-2411'), tx('19'), tx('Kim L. (Portland)')], 'pd'],
      ['iv3', ['adjust'], [tx(c('Yesterday'), zone('commerce', 'am')), tx('Canvas tote', 'Amsterdam', true), tx('−2'), tx(tbl('reason.damage', undefined, 'Damaged / write-off'), 'Scuffed in transit'), tx('7'), tx('Sanne V. (Amsterdam)')], 'am'],
      ['iv5', ['adjust'], [tx(tbl('cell.daysAgo', { count: 3 }, '3 days ago'), zone('commerce', 'me')), tx('Merino crew · S', 'Montréal', true), tx('−1'), tx(tbl('reason.count', undefined, 'Stock count'), 'Cycle count'), tx('7'), tx('Luc T. (Montréal)')], 'me'],
    ] },
  shoppers: { columns: [['customer', 'Customer'], ['orders', 'Orders', 'right'], ['store', 'Store'], ['consent', 'Consent']], filters: [['all', 'All']], source: 'WooCommerce customers',
    rows: [
      ['sh1', [], [tx('Riley A.', '', true), tx('4'), tx('Portland store'), b('Email', 'success')], 'pd'],
      ['sh2', [], [tx('Sam T.', '', true), tx('1'), tx('San Francisco – Hayes Valley'), b('None', 'neutral', 'minus')], 'sf'],
      ['sh3', [], [tx('Élise B.', '', true), tx('2'), tx('Montréal – Mile End'), b('Email', 'success')], 'me'],
    ] },
  /* Foods */
  pickup: { columns: [['setting', 'Setting'], ['ballard', 'Ballard'], ['borough', 'Borough'], ['origin', 'Origin']], filters: [['all', 'All']], source: 'Pickup settings',
    rows: [
      ['pk1', [], [tx(lbl('setting', 'Opening hours'), c('Local time'), true), tx(hoursRange('foods', 'bl', '11:00', '22:00')), tx(hoursRange('foods', 'bo', '12:00', '22:00')), og('local')]],
      ['pk2', [], [tx(lbl('setting', 'Slot length'), '', true), tx(minutes(15)), tx(minutes(15)), og('hq')]],
      ['pk3', [], [tx(lbl('setting', 'Orders per slot'), '', true), tx('8'), tx('6'), og('local')]],
      ['pk4', [], [tx(lbl('setting', 'Order cutoff'), '', true), tx(tbl('cell.minBeforeClose', { count: 20 }, '20 min before close')), tx(tbl('cell.minBeforeClose', { count: 20 }, '20 min before close')), og('hq')]],
      ['pk5', [], [tx(lbl('setting', 'Prep buffer'), '', true), tx(minutes(12)), tx(minutes(15)), og('local')]],
    ] },
  guests: { columns: [['guest', 'Guest'], ['orders', 'Orders', 'right'], ['location', 'Location'], ['consent', 'Consent']], filters: [['all', 'All']], source: 'Pickup ordering',
    rows: [
      ['g1', [], [tx('Mei L.', '', true), tx('9'), tx('Seattle – Ballard'), b('SMS', 'success')], 'bl'],
      ['g2', [], [tx('Tom R.', '', true), tx('3'), tx('Seattle – Ballard'), b('None', 'neutral', 'minus')], 'bl'],
      ['g3', [], [tx('Oliver P.', '', true), tx('5'), tx('London – Borough'), b('Email', 'success')], 'bo'],
    ] },
  /* Real Estate */
  realtyClients: { columns: [['client', 'Client'], ['kind', 'Type'], ['office', 'Office'], ['agent', 'Agent'], ['consent', 'Consent']], filters: [['all', 'All']], source: 'Inquiries and contacts',
    description: 'Buyers, tenants, vendors and landlords. Agents see their own clients; office managers see their office. HQ reports never include client details.',
    rows: [
      ['rc1', [], [tx('Omar & Sara H.', '', true), tx(c('Buyer')), tx('Toronto Midtown'), tx('Nadia Hassan'), b('Email', 'success')], 'tor'],
      ['rc2', [], [tx('Margaret & Paul L.', '', true), tx(c('Vendor')), tx('Toronto Midtown'), tx('Nadia Hassan'), b('None', 'neutral', 'minus')], 'tor'],
      ['rc3', [], [tx('Charlotte E.', '', true), tx(c('Buyer')), tx('London Hampstead'), tx('James Whitfield'), b('Email', 'success')], 'lon'],
      ['rc4', [], [tx('Carmen D.', '', true), tx(c('Buyer')), tx('Madrid Salamanca'), tx('Lucía Romero'), b('None', 'neutral', 'minus')], 'mad'],
    ] },
  /* Shared */
  marketing: { columns: [['campaign', 'Campaign'], ['scope', 'Scope'], ['channel', 'Channel'], ['status', 'Status'], ['updated', 'Updated']], filters: [['all', 'All'], ['draft', 'Draft'], ['scheduled', 'Scheduled']], source: 'BranchHarbor campaigns', primaryAction: 'New campaign',
    description: 'Campaign reporting uses observed form and booking data only. Attribution beyond the form source is not measured.',
    rows: [
      ['mk1', ['draft'], [tx('New year, new practice', c('AI draft · not sent'), true), tx(tbl('cell.canadianLocations', { count: 3 }, 'Canadian locations (3)')), tx(lbl('channel', 'Web + email')), b('Draft', 'info', 'edit'), tx(c('Today'))]],
      ['mk2', ['scheduled'], [tx('Teacher training info night', '', true), tx('Toronto – Queen West'), tx(lbl('channel', 'Web')), b('Scheduled', 'success', 'clock'), tx(day('2026-10-02'))]],
      ['mk3', [], [tx('Spring open house', '', true), tx(c('All locations')), tx(lbl('channel', 'Web + email')), b('Completed', 'neutral', 'check'), tx(day('2026-04-12'))]],
      ['mk4', ['draft'], [tx('Herbst-Eröffnung Berlin', c('German copy'), true), tx('Berlin – Prenzlauer Berg'), tx(lbl('channel', 'Web')), b('Needs approval', 'warning', 'shield'), tx(c('Yesterday'))]],
    ] },
});

const CUSTOMER_TABLE: Record<IndustryKey, string> = { studios: 'members', sports: 'participants', wellness: 'clients', commerce: 'shoppers', foods: 'guests', realty: 'realtyClients', /** Live-API only: no sample data; mirrors realty so sample mode stays type-complete. */ get hospitality() { return CUSTOMER_TABLE.realty; } };

export function buildTable(ind: IndustryKey, key: string, locIds: string[]): TableData | null {
  const k = key === 'customers' ? CUSTOMER_TABLE[ind] : key;
  const spec = tables()[k];
  if (!spec) return null;
  return {
    key: k,
    ...(spec.description ? { description: spec.description, descriptionMsg: tbl(`desc.${k}`, undefined, spec.description) } : {}),
    // Pickup columns are location names (business data); every other header is UI text.
    columns: spec.columns.map(([key, label, align]) => ({ key, label, ...(k === 'pickup' && key !== 'setting' && key !== 'origin' ? {} : { labelMsg: lbl('col', label) }), align })),
    filters: spec.filters.map(([key, label]) => ({ key, label, labelMsg: lbl('filter', label) })),
    source: spec.source,
    sourceMsg: lbl('source', spec.source),
    ...(spec.primaryAction ? { primaryAction: spec.primaryAction, primaryActionMsg: lbl('action', spec.primaryAction) } : {}),
    rows: spec.rows
      .filter(([, , , lid]) => !lid || locIds.includes(lid))
      .map(([id, tags, cells]) => ({ id, tags, cells: Object.fromEntries(spec.columns.map(([ck], i) => [ck, cells[i]!])) })),
  };
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

/** Mock AI: suggested prompts and the sample answer per industry. UI text is keyed under `ai.mock.<industry>.*` (namespace
 * "data"); location and people names in `affected` are business data and stay plain. */
interface MockAi {
  suggestions: { text: MsgRef; multiLocation?: boolean; action?: boolean }[];
  answer: MsgRef;
  assumptions: MsgRef;
  sources: [MsgRef, MsgRef | string][];
  action: { title: MsgRef; kind: 'draft' | 'publish' | 'send'; affected: Txt[]; excluded: Txt[] };
}
const ai = (ind: IndustryKey, key: string, text: string, params?: MsgParams) => ref(`ai.mock.${ind}.${key}`, params, text);
const updated = (min: number) => ref('ai.fresh.updatedMinAgo', { count: min }, `Updated ${min} min ago`);

export const AI: Record<IndustryKey, MockAi> = {
  studios: {
    suggestions: [
      { text: ai('studios', 's0', 'Summarize attendance changes this month') },
      { text: ai('studios', 's1', 'Draft a multi-location New Year campaign'), multiLocation: true, action: true },
      { text: ai('studios', 's2', 'Draft a class description for Slow Flow'), action: true },
    ],
    answer: ai('studios', 'answer', 'Occupancy rose at Queen West (+6 pts) and Leslieville (+3) versus September. Shoreditch is flat and Surry Hills is down 2 pts. Kitsilano can’t be compared: its booking sync has been degraded since 09:40 local time. I can’t tell why attendance changed from occupancy alone.'),
    assumptions: ai('studios', 'assumptions', 'Compared 1–13 Oct with the same days in September, in each studio’s own time zone.'),
    sources: [[ai('studios', 'src0', 'Booking connection · class occurrences'), updated(4)], [ai('studios', 'src1', 'Kitsilano booking sync'), ref('ai.fresh.lastSuccessHoursAgo', { count: 2 }, 'Last success 2 h ago')]],
    action: { title: ai('studios', 'actionTitle', 'Draft “New year, new practice” campaign for 3 Canadian studios'), kind: 'draft', affected: ['Toronto – Queen West', 'Toronto – Leslieville', 'Vancouver – Kitsilano'], excluded: [ai('studios', 'excluded0', 'Seattle – Capitol Hill (different offer pricing)'), ai('studios', 'excluded1', 'London, Berlin, Sydney (not in campaign scope)')] },
  },
  sports: {
    suggestions: [
      { text: ai('sports', 's0', 'Suggest a fix for the Pitch 2 clash') },
      { text: ai('sports', 's1', 'Summarize U10 enrollment') },
      { text: ai('sports', 's2', 'Draft the camp announcement'), action: true },
    ],
    answer: ai('sports', 'answer', 'Move U12 Camp to Pitch 1 at 17:00 (free until 18:30), or shift U10 Blue to 16:00 at Hillcrest Dome. Both only affect those two groups. I won’t select or move participants — that stays with your coaches.'),
    assumptions: ai('sports', 'assumptions', 'Uses venue bookings for today at Riverside Park, Pacific time.'),
    sources: [[ai('sports', 'src0', 'Schedule · venue bookings'), updated(2)]],
    action: { title: ai('sports', 'actionTitle', 'Draft notice to U12 Camp guardians about the pitch change'), kind: 'send', affected: [ai('sports', 'affected0', 'U12 Camp · 22 guardians at Riverside Park')], excluded: [ai('sports', 'excluded0', 'All other groups and venues')] },
  },
  wellness: {
    suggestions: [
      { text: ai('wellness', 's0', 'Draft a reply using our cancellation policy'), action: true },
      { text: ai('wellness', 's1', 'Summarize utilization by practitioner') },
      { text: ai('wellness', 's2', 'Write copy for Hot stone') },
    ],
    answer: ai('wellness', 'answer', 'Draft: “Hi Jordan, you can move your appointment free of charge up to 24 hours before. I’ve found Thu 17:00 with Rina if that suits.” I didn’t use any intake form details.'),
    assumptions: ai('wellness', 'assumptions', 'Cancellation policy v2 applies to Harbourfront. Intake form responses are excluded from AI context.'),
    sources: [[ai('wellness', 'src0', 'Policies › Cancellation v2'), ref('ai.fresh.publishedOn', { date: dateArg('2026-09-01T12:00:00Z') }, 'Published 1 Sep 2026')], [ai('wellness', 'src1', 'Calendar · Harbourfront'), ref('ai.fresh.live', undefined, 'Live')]],
    action: { title: ai('wellness', 'actionTitle', 'Send reply to Jordan P. by email'), kind: 'send', affected: ['Jordan P. · Toronto – Harbourfront'], excluded: [] },
  },
  commerce: {
    suggestions: [
      { text: ai('commerce', 's0', 'Explain this week’s stock trend') },
      { text: ai('commerce', 's1', 'Draft copy for Canvas tote from its spec sheet'), action: true },
      { text: ai('commerce', 's2', 'Which stores failed the last sync?'), multiLocation: true },
    ],
    answer: ai('commerce', 'answer', 'Linen overshirt L sold 9 units at Portland in 7 days against 3 the week before; stock is 1. Merino crew is flat. This is based on WooCommerce orders only; in-store sales aren’t connected, and Austin is excluded while disconnected.'),
    assumptions: ai('commerce', 'assumptions', 'Revenue is reported per currency (USD, CAD, EUR) and never combined.'),
    sources: [[ai('commerce', 'src0', 'WooCommerce orders'), updated(1)], [ai('commerce', 'src1', 'Inventory history'), updated(6)]],
    action: { title: ai('commerce', 'actionTitle', 'Draft reorder note for Linen overshirt L at Portland'), kind: 'draft', affected: ['Portland store'], excluded: [ai('commerce', 'excluded0', 'Austin store (disconnected)')] },
  },
  foods: {
    suggestions: [
      { text: ai('foods', 's0', 'Summarize today’s production by item') },
      { text: ai('foods', 's1', 'Draft menu copy for the flatbread'), action: true },
      { text: ai('foods', 's2', 'Plan a lunch promotion across Seattle'), multiLocation: true, action: true },
    ],
    answer: ai('foods', 'answer', 'Ballard so far: 14 Ember bowls, 8 brisket sandwiches, 6 flatbreads, 11 lemonades. Fremont is missing because its kitchen screen is offline, though orders still arrived there. I can’t change prices, dietary labels or order acceptance.'),
    assumptions: ai('foods', 'assumptions', 'Counts orders accepted since opening, Pacific time.'),
    sources: [[ai('foods', 'src0', 'Orders · Ballard'), '11:00–12:10'], [ai('foods', 'src1', 'Fremont kitchen screen'), ref('ai.fresh.offlineSince', { time: '11:42' }, 'Offline since 11:42')]],
    action: { title: ai('foods', 'actionTitle', 'Draft “Weekday lunch” promotion for Seattle locations'), kind: 'draft', affected: ['Seattle – Ballard', 'Seattle – Fremont'], excluded: [ai('foods', 'excluded0', 'Vancouver, London, Berlin (outside requested scope)')] },
  },
  realty: {
    suggestions: [
      { text: ai('realty', 's0', 'Summarize viewing feedback for 42 Birchmount Cres') },
      { text: ai('realty', 's1', 'Draft a description for Suite 1806 from its facts'), action: true },
      { text: ai('realty', 's2', 'Who should I follow up with this week?') },
    ],
    answer: ai('realty', 'answer', 'Three viewings at 42 Birchmount Cres logged feedback: two rated it 4–5 and liked the kitchen and garden; one raised the basement ceiling height. One buyer asked about closing dates. I only used the logged feedback — buyer identities were not shared with me.'),
    assumptions: ai('realty', 'assumptions', 'Feedback from completed viewings in the last 14 days, Toronto time. No-shows are excluded.'),
    sources: [[ai('realty', 'src0', 'Viewings · feedback'), updated(6)]],
    action: { title: ai('realty', 'actionTitle', 'Draft follow-up emails for 2 interested buyers'), kind: 'draft', affected: [ai('realty', 'affected0', 'Toronto Midtown · 2 buyers')], excluded: [ai('realty', 'excluded0', 'Buyers without email consent')] },
  }, /** Live-API only: no sample data; mirrors realty so sample mode stays type-complete. */ get hospitality() { return AI.realty; } };
