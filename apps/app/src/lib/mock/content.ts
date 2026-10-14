import type { Currency, Money } from '@bh/shared';
import type { IconName } from '@bh/icons';
import type { Tone } from '@bh/ui';
import type { AttentionItem, Cell, IndustryKey, Metric, MetricValue, TableData } from '../types';
import { FIXTURES, PASTEL as P, at, loc } from './orgs';

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

const OVERVIEW: Record<IndustryKey, { metrics: MetricDef[]; upcomingTitle: string; upcoming: [locId: string, hhmm: string, title: string, detail: string, status: string, tone: Tone][]; attention: (AttentionItem & { locId?: string })[]; aiPrompt: string }> = {
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
      ['qw', '07:00', 'Morning Vinyasa · Maya Rao', 'Queen West · 16/20', 'Cover requested', 'warning'],
      ['qw', '09:00', 'Slow Flow · Sam Tran', 'Queen West · 20/20 · 3 waitlisted', 'Full', 'info'],
      ['ls', '12:15', 'Lunchtime Pilates · Ana Silva', 'Leslieville · 11/20', 'Open', 'success'],
      ['sh', '18:30', 'Yin & Restore · Priya Shah', 'Shoreditch · 19/20', '1 spot', 'neutral'],
      ['sy', '06:30', 'Sunrise Flow · Ella Wright', 'Surry Hills · 14/18', 'Open', 'success'],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Kitsilano booking sync degraded', detail: 'Last successful sync 2 h ago · occupancy unavailable', href: '/connections', kind: 'integration', locId: 'kt' },
      { id: 'a2', icon: 'users', title: '1 open cover request', detail: 'Morning Vinyasa, Queen West', href: '/ops/cover', kind: 'action', locId: 'qw' },
      { id: 'a3', icon: 'shield', title: '1 page change awaiting approval', detail: 'Leslieville · Home hero', href: '/websites?tab=approvals', kind: 'action', locId: 'ls' },
      { id: 'a4', icon: 'card', title: 'Payment without booking record', detail: 'Reconciliation queue · 1 item', href: '/payments?tab=reconciliation', kind: 'action' },
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
      { id: 'a1', icon: 'alert', title: 'Pitch 2 double-booked at 17:00', detail: 'U10 Blue and U12 Camp · Riverside Park', href: '/ops/schedule', kind: 'action', locId: 'rp' },
      { id: 'a2', icon: 'file', title: '9 registrations awaiting review', detail: 'Autumn U10 and U12', href: '/ops/registrations', kind: 'action' },
      { id: 'a3', icon: 'wifi-off', title: 'Dublin payments not set up', detail: 'Registration stays closed until the account is enabled', href: '/payments?tab=setup', kind: 'integration', locId: 'dn' },
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
      { id: 'a1', icon: 'refresh', title: 'Reschedule request', detail: 'Jordan P. wants the 10:00 deep tissue moved', href: '/ops/calendar', kind: 'action', locId: 'hf' },
      { id: 'a2', icon: 'user', title: 'Ana L. absent Friday', detail: '4 appointments need reassigning', href: '/ops/practitioners', kind: 'action', locId: 'yv' },
      { id: 'a3', icon: 'alert', title: 'Fitzroy calendar sync degraded', detail: 'Utilisation unavailable for Melbourne', href: '/connections', kind: 'integration', locId: 'fz' },
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
      ['pd', '10:20', '#5521 · Linen overshirt ×2', 'Portland · ship', 'To fulfil', 'info'],
      ['sf', '11:05', '#5524 · Merino crew', 'Hayes Valley · pickup', 'To fulfil', 'info'],
      ['am', '14:10', '#5526 · Field notebook set', 'De Pijp · pickup', 'To fulfil', 'info'],
      ['pd', '11:40', '#5517 · Canvas tote', 'Portland', 'Payment failed', 'danger'],
    ],
    attention: [
      { id: 'a1', icon: 'alert', title: 'Merino crew failed to sync to 2 stores', detail: 'Variant mismatch on size XS', href: '/ops/catalogue', kind: 'integration' },
      { id: 'a2', icon: 'box', title: 'Linen overshirt L low at Portland', detail: '1 on hand', href: '/ops/inventory', kind: 'action', locId: 'pd' },
      { id: 'a3', icon: 'wifi-off', title: 'Austin store disconnected', detail: 'Orders there are not imported until it reconnects', href: '/connections', kind: 'integration', locId: 'au' },
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
      { id: 'a1', icon: 'alert', title: 'Order #1041 overdue 6 min', detail: 'Ballard kitchen', href: '/ops/kitchen', kind: 'action', locId: 'bl' },
      { id: 'a2', icon: 'card', title: 'Payment without order', detail: 'Lena W. · $34.65 USD · recovery queue', href: '/payments?tab=reconciliation', kind: 'action', locId: 'bl' },
      { id: 'a3', icon: 'wifi-off', title: 'Fremont kitchen screen offline', detail: 'Orders still arrive by email', href: '/connections', kind: 'integration', locId: 'fr' },
    ],
    aiPrompt: 'Summarise today’s production by item',
  },
};

export function buildOverview(ind: IndustryKey, locIds: string[]) {
  const f = FIXTURES[ind];
  const cfg = OVERVIEW[ind];
  const idx = f.locations.map((l, i) => [l, i] as const).filter(([l]) => locIds.includes(l.id));
  const metrics: Metric[] = cfg.metrics.map((m) => {
    const base = { key: m.key, label: m.label, definition: m.definition, range: m.range, source: m.source, icon: m.icon, pastel: m.pastel };
    if (m.notConnected) return { ...base, state: 'not_connected', value: null, note: m.note };
    if (m.revenue) {
      const avail = idx.filter(([l]) => l.revenue7d.amount > 0);
      const missing = idx.filter(([l]) => l.revenue7d.amount === 0 && l.sync === 'attention' && l.site === 'live').map(([l]) => l.name);
      if (!avail.length) return { ...base, state: 'unavailable', value: null, note: missing.length ? `Sync unavailable at ${missing.join(', ')}` : 'No payments yet in this scope' };
      const map = new Map<Currency, number>();
      for (const [l] of avail) map.set(l.currency, (map.get(l.currency) ?? 0) + l.revenue7d.amount);
      const values: Money[] = [...map.entries()].map(([currency, amount]) => ({ currency, amount }));
      return { ...base, state: 'ok', value: { kind: 'money', values }, note: missing.length ? `Excludes ${missing.join(', ')} (sync degraded)` : values.length > 1 ? 'Shown per currency · not combined' : undefined };
    }
    const vals = idx.map(([l, i]) => [l, m.perLoc?.[i] ?? null] as const);
    const ok = vals.filter(([, v]) => v != null) as (readonly [(typeof f.locations)[number], number])[];
    const missing = vals.filter(([l, v]) => v == null && l.site === 'live').map(([l]) => l.name.split(' – ').pop());
    if (!ok.length) return { ...base, state: 'unavailable', value: null, note: missing.length ? `Not available for ${missing.join(', ')}` : undefined };
    const total = ok.reduce((s, [, v]) => s + v, 0);
    const value: MetricValue = m.kind === 'percent' ? { kind: 'percent', value: total / ok.length } : m.key === 'sync' ? { kind: 'ratio', value: total, of: idx.length } : { kind: 'count', value: total };
    return { ...base, state: 'ok', value, note: missing.length ? `Excludes ${missing.join(', ')}` : undefined };
  });
  const upcoming = cfg.upcoming
    .filter(([lid]) => locIds.includes(lid))
    .map(([lid, hhmm, title, detail, label, tone], i) => {
      const l = loc(ind, lid);
      return { id: `u${i}`, at: at(l.timeZone, hhmm), timeZone: l.timeZone, title, detail, status: { label, tone } };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const attention = cfg.attention.filter((a) => !a.locId || locIds.includes(a.locId)).map(({ locId: _l, ...a }) => a);
  return { metrics, upcomingTitle: cfg.upcomingTitle, upcoming, attention, aiPrompt: cfg.aiPrompt };
}

/* ------------------------------------------------------------------ */
/* Generic tables                                                      */
/* ------------------------------------------------------------------ */

const tx = (v: string, sub?: string, strong?: boolean): Cell => ({ t: 'text', v, sub, strong });
const b = (v: string, tone: Tone, icon?: IconName): Cell => ({ t: 'badge', v, tone, icon });
const mo = (major: number, currency: Currency, sub?: string): Cell => ({ t: 'money', v: { amount: Math.round(major * 100), currency }, sub });
const og = (v: 'hq' | 'local' | 'locked' | 'approval'): Cell => ({ t: 'origin', v });
const na = (reason?: string): Cell => ({ t: 'unavailable', reason });

type RowSpec = [id: string, tags: string[], cells: Cell[], locId?: string];
interface TableSpec {
  columns: [string, string, ('left' | 'right')?][];
  filters: [string, string][];
  source: string;
  description?: string;
  primaryAction?: string;
  rows: RowSpec[];
}

const TABLES: Record<string, TableSpec> = {
  /* Studios */
  offers: { columns: [['offer', 'Offer'], ['eligibility', 'Eligibility'], ['locations', 'Locations'], ['valid', 'Valid'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['pending', 'Needs approval']], source: 'BranchHarbor offers', primaryAction: 'New offer',
    rows: [
      ['o1', ['active'], [tx('New Year Intro', '3 classes · CA$39 / US$35 / £29 / €32 / A$45', true), tx('New members only'), tx('All locations'), tx('2–31 Jan'), b('Active', 'success')]],
      ['o2', ['active'], [tx('First class free', 'Local override', true), tx('New members'), tx('Toronto – Queen West'), tx('Ongoing'), b('Local', 'info')], 'qw'],
      ['o3', ['pending'], [tx('Friends week', 'Bring a friend', true), tx('Members'), tx('Toronto – Leslieville'), tx('9–15 Nov'), b('Needs approval', 'warning')], 'ls'],
      ['o4', ['active'], [tx('Neujahrs-Intro', 'Berlin launch offer', true), tx('New members'), tx('Berlin – Prenzlauer Berg'), tx('From 4 Nov'), b('Scheduled', 'neutral', 'clock')], 'pb'],
    ] },
  members: { columns: [['member', 'Member'], ['plan', 'Plan'], ['home', 'Home studio'], ['attendance', 'Attendance (30d)', 'right'], ['consent', 'Consent'], ['state', 'State']], filters: [['all', 'All'], ['active', 'Active'], ['low', 'Low balance'], ['trial', 'Trial']], source: 'Booking connection · consent from BranchHarbor',
    rows: [
      ['m1', ['active'], [tx('Ava Chen', 'ava@…', true), tx('Unlimited monthly'), tx('Toronto – Queen West'), tx('14'), b('Email', 'success'), b('Active', 'success')], 'qw'],
      ['m2', ['low'], [tx('Liam Ortiz', 'liam@…', true), tx('10-class pack', '3 left · expires 30 Nov'), tx('Toronto – Queen West'), tx('6'), b('Email', 'success'), b('Low balance', 'warning')], 'qw'],
      ['m3', ['trial'], [tx('Noor Haddad', 'noor@…', true), tx('Intro offer', '2 of 3 used'), tx('Toronto – Leslieville'), tx('2'), b('None', 'neutral', 'minus'), b('Trial', 'info')], 'ls'],
      ['m4', ['active'], [tx('Ben Ross', 'ben@…', true), tx('Unlimited monthly'), tx('Vancouver – Kitsilano'), na('Sync degraded'), b('Email', 'success'), b('Payment failed', 'danger')], 'kt'],
      ['m5', ['active'], [tx('Harriet Cole', 'harriet@…', true), tx('8-class pack', '5 left'), tx('London – Shoreditch'), tx('9'), b('Email + SMS', 'success'), b('Active', 'success')], 'sh'],
      ['m6', ['trial'], [tx('Jack Nguyen', 'jack@…', true), tx('Intro offer', '1 of 3 used'), tx('Sydney – Surry Hills'), tx('1'), b('Email', 'success'), b('Trial', 'info')], 'sy'],
    ] },
  /* Sports */
  programmes: { columns: [['programme', 'Programme'], ['ages', 'Ages'], ['venue', 'Venue'], ['fee', 'Fee', 'right'], ['registration', 'Registration'], ['capacity', 'Capacity', 'right']], filters: [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']], source: 'BranchHarbor programmes', primaryAction: 'New programme',
    rows: [
      ['p1', ['open'], [tx('U10 Autumn', 'Season · 12 weeks', true), tx('Born 2016'), tx('Vancouver – Riverside Park'), mo(240, 'CAD'), b('Open to 25 Oct', 'success'), tx('30 / 32')], 'rp'],
      ['p2', ['open'], [tx('U12 Camp', 'Half-term · 5 days', true), tx('Born 2014'), tx('Vancouver – Riverside Park'), mo(180, 'CAD'), b('Open', 'success'), tx('22 / 24')], 'rp'],
      ['p3', ['closed'], [tx('U8 Fundamentals', 'Season', true), tx('Born 2018'), tx('Toronto – Hillcrest Dome'), mo(190, 'CAD'), b('Closed', 'neutral', 'minus'), tx('20 / 20')], 'hc'],
      ['p4', ['open'], [tx('U14 Development', 'Season · 10 weeks', true), tx('Born 2012'), tx('Manchester – Didsbury'), mo(165, 'GBP'), b('Open', 'success'), tx('18 / 22')], 'mc'],
      ['p5', ['closed'], [tx('Spring Juniors', 'Season', true), tx('Born 2017–2018'), tx('Dublin – Ringsend'), mo(150, 'EUR'), b('Payments not enabled', 'warning'), tx('0 / 24')], 'dn'],
    ] },
  teams: { columns: [['group', 'Group'], ['coach', 'Coach'], ['programme', 'Programme'], ['roster', 'Roster', 'right'], ['next', 'Next session']], filters: [['all', 'All'], ['open', 'Open'], ['full', 'Full']], source: 'BranchHarbor groups',
    rows: [
      ['t1', ['open'], [tx('U10 Blue', '', true), tx('Coach Ortiz'), tx('U10 Autumn'), tx('14 / 16'), tx('Today 17:00 · Pitch 2')], 'rp'],
      ['t2', ['full'], [tx('U10 Green', '', true), tx('Coach Ahmed'), tx('U10 Autumn'), b('16 / 16 · Full', 'warning'), tx('Wed 17:00 · Pitch 1')], 'rp'],
      ['t3', ['open'], [tx('U12 Camp', '', true), tx('Coach Lee'), tx('U12 Camp'), tx('22 / 24'), tx('Today 17:00 · Pitch 2')], 'rp'],
      ['t4', ['open'], [tx('U14 Reds', '', true), tx('Coach Hale'), tx('U14 Development'), tx('18 / 22'), tx('Today 18:00 · Main pitch')], 'mc'],
    ] },
  schedule: { columns: [['when', 'When'], ['group', 'Group'], ['venue', 'Venue'], ['coach', 'Coach'], ['check', 'Check']], filters: [['all', 'This week'], ['conflict', 'Conflicts']], source: 'Schedule · venue bookings',
    rows: [
      ['s1', [], [tx('Today 16:00', 'Pacific time'), tx('U8 Red', '', true), tx('Riverside Park · Pitch 1'), tx('Coach Diaz'), b('Clear', 'success')], 'rp'],
      ['s2', ['conflict'], [tx('Today 17:00', 'Pacific time'), tx('U10 Blue', '', true), tx('Riverside Park · Pitch 2'), tx('Coach Ortiz'), b('Venue clash', 'danger')], 'rp'],
      ['s3', ['conflict'], [tx('Today 17:00', 'Pacific time'), tx('U12 Camp', '', true), tx('Riverside Park · Pitch 2'), tx('Coach Lee'), b('Venue clash', 'danger')], 'rp'],
      ['s4', [], [tx('Today 18:00', 'UK time'), tx('U14 Reds', '', true), tx('Didsbury · Main pitch'), tx('Coach Hale'), b('Clear', 'success')], 'mc'],
    ] },
  participants: { columns: [['participant', 'Participant'], ['age', 'Age', 'right'], ['group', 'Group'], ['guardian', 'Guardian'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['waitlisted', 'Waitlisted']], source: 'Registrations',
    rows: [
      ['pa1', ['active'], [tx('Ella M.', '', true), tx('9'), tx('U10 Blue'), tx('Sara M.', 'Verified'), b('Active', 'success')], 'rp'],
      ['pa2', ['active'], [tx('Jonah P.', '', true), tx('11'), tx('U12 Camp'), tx('Dev P.', 'Verified'), b('Active', 'success')], 'rp'],
      ['pa3', ['waitlisted'], [tx('Leo R.', '', true), tx('9'), tx('—'), tx('Kim R.', 'Invitation pending'), b('Waitlisted', 'info')], 'rp'],
      ['pa4', ['active'], [tx('Freddie W.', '', true), tx('13'), tx('U14 Reds'), tx('Claire W.', 'Verified'), b('Active', 'success')], 'mc'],
    ] },
  /* Wellness */
  services: { columns: [['service', 'Service'], ['duration', 'Duration'], ['price', 'Price', 'right'], ['buffer', 'Buffer'], ['needs', 'Needs'], ['status', 'Status']], filters: [['all', 'All'], ['active', 'Active'], ['paused', 'Paused']], source: 'BranchHarbor services', primaryAction: 'New service',
    rows: [
      ['sv1', ['active'], [tx('Deep tissue', 'Toronto', true), tx('60 min'), mo(120, 'CAD'), tx('15 min'), tx('Room A or B'), b('Active', 'success')], 'hf'],
      ['sv2', ['active'], [tx('Hot stone', 'Toronto', true), tx('90 min'), mo(165, 'CAD'), tx('20 min'), tx('Room B · stone heater'), b('Active', 'success')], 'hf'],
      ['sv3', ['paused'], [tx('Facial', 'Toronto', true), tx('45 min'), mo(95, 'CAD'), tx('10 min'), tx('Room C'), b('Paused', 'neutral', 'minus')], 'yv'],
      ['sv4', ['active'], [tx('Deep tissue', 'London', true), tx('60 min'), mo(85, 'GBP'), tx('15 min'), tx('Treatment room 1'), b('Active', 'success')], 'mb'],
      ['sv5', ['active'], [tx('Remedial massage', 'Melbourne', true), tx('60 min'), mo(125, 'AUD'), tx('15 min'), tx('Room 2'), b('Active', 'success')], 'fz'],
    ] },
  practitioners: { columns: [['practitioner', 'Practitioner'], ['services', 'Services'], ['locations', 'Locations'], ['week', 'This week']], filters: [['all', 'All'], ['today', 'Available today']], source: 'Practitioner calendars',
    rows: [
      ['pr1', ['today'], [tx('Rina K.', '', true), tx('Deep tissue, hot stone'), tx('Harbourfront'), tx('31 h booked')], 'hf'],
      ['pr2', ['today'], [tx('Tom B.', '', true), tx('Facial'), tx('Harbourfront, Yorkville'), tx('18 h booked')], 'hf'],
      ['pr3', [], [tx('Ana L.', '', true), tx('Deep tissue'), tx('Yorkville'), b('Absent Fri', 'warning')], 'yv'],
      ['pr4', ['today'], [tx('Grace O.', '', true), tx('Deep tissue, facial'), tx('Marylebone'), tx('22 h booked')], 'mb'],
    ] },
  forms: { columns: [['form', 'Form'], ['used', 'Used by'], ['version', 'Consent version'], ['ai', 'AI access']], filters: [['all', 'All']], source: 'BranchHarbor forms', description: 'Administrative questions only. Responses are excluded from AI context by default.',
    rows: [
      ['f1', [], [tx('New client intake', '', true), tx('All services'), tx('v3 · Sep 2026'), b('Excluded', 'neutral', 'lock')]],
      ['f2', [], [tx('Hot stone screening', '', true), tx('Hot stone'), tx('v1'), b('Excluded', 'neutral', 'lock')]],
    ] },
  clients: { columns: [['client', 'Client'], ['last', 'Last visit'], ['next', 'Next'], ['prefs', 'Preferences'], ['notes', 'Notes']], filters: [['all', 'All'], ['upcoming', 'Upcoming']], source: 'Calendar · scoped notes',
    rows: [
      ['c1', ['upcoming'], [tx('Jordan P.', '', true), tx('2 Oct'), tx('Today 10:00'), tx('Medium pressure'), b('Scoped', 'info', 'lock')], 'hf'],
      ['c2', ['upcoming'], [tx('Kai S.', '', true), tx('20 Sep'), tx('Today 11:30'), tx('Quiet room'), b('None', 'neutral', 'minus')], 'hf'],
      ['c3', [], [tx('Amelia F.', '', true), tx('28 Sep'), tx('—'), tx('Unscented oils'), b('None', 'neutral', 'minus')], 'mb'],
    ] },
  /* Commerce */
  catalogue: { columns: [['product', 'Product'], ['variants', 'Variants', 'right'], ['editable', 'Editable locally'], ['stores', 'Stores'], ['sync', 'Sync']], filters: [['all', 'All'], ['published', 'Published'], ['draft', 'Draft'], ['failed', 'Failed']], source: 'Master catalogue · WooCommerce', primaryAction: 'New product',
    rows: [
      ['pr1', ['published'], [tx('Linen overshirt', 'SKU FN-LO', true), tx('4'), tx('Price ±10%, availability'), tx('5 of 5'), b('Synced', 'success')]],
      ['pr2', ['failed'], [tx('Merino crew', 'SKU FN-MC', true), tx('6'), tx('Availability'), tx('3 of 5'), b('2 failed · XS mismatch', 'warning')]],
      ['pr3', ['draft'], [tx('Canvas tote', 'SKU FN-CT', true), tx('1'), tx('—'), tx('0'), b('Draft', 'neutral', 'minus')]],
      ['pr4', ['published'], [tx('Field notebook set', 'SKU FN-NB', true), tx('2'), tx('Price ±10%'), tx('5 of 5'), b('Synced', 'success')]],
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
      ['iv1', ['sale'], [tx('Today 09:12', 'Pacific time'), tx('Linen overshirt · L', 'Portland', true), tx('−1'), tx('Sale', '#5521'), tx('1'), tx('WooCommerce')], 'pd'],
      ['iv4', ['reserved'], [tx('Today 08:40', 'Pacific time'), tx('Field notebook set', 'Portland', true), tx('−2'), b('Reserved · unpaid order', 'info', 'clock'), na('Not on-hand'), tx('System')], 'pd'],
      ['iv2', ['adjust'], [tx('Yesterday', 'Pacific time'), tx('Merino crew · S', 'Portland', true), tx('+12'), tx('Received', 'PO-2411'), tx('19'), tx('Kim L. (Portland)')], 'pd'],
      ['iv3', ['adjust'], [tx('Yesterday', 'Central European time'), tx('Canvas tote', 'Amsterdam', true), tx('−2'), tx('Damaged / write-off', 'Scuffed in transit'), tx('7'), tx('Sanne V. (Amsterdam)')], 'am'],
      ['iv5', ['adjust'], [tx('3 days ago', 'Eastern time'), tx('Merino crew · S', 'Montréal', true), tx('−1'), tx('Stock count', 'Cycle count'), tx('7'), tx('Luc T. (Montréal)')], 'me'],
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
      ['pk1', [], [tx('Opening hours', 'Local time', true), tx('11:00–22:00'), tx('12:00–22:00'), og('local')]],
      ['pk2', [], [tx('Slot length', '', true), tx('15 min'), tx('15 min'), og('hq')]],
      ['pk3', [], [tx('Orders per slot', '', true), tx('8'), tx('6'), og('local')]],
      ['pk4', [], [tx('Order cutoff', '', true), tx('20 min before close'), tx('20 min before close'), og('hq')]],
      ['pk5', [], [tx('Prep buffer', '', true), tx('12 min'), tx('15 min'), og('local')]],
    ] },
  guests: { columns: [['guest', 'Guest'], ['orders', 'Orders', 'right'], ['location', 'Location'], ['consent', 'Consent']], filters: [['all', 'All']], source: 'Pickup ordering',
    rows: [
      ['g1', [], [tx('Mei L.', '', true), tx('9'), tx('Seattle – Ballard'), b('SMS', 'success')], 'bl'],
      ['g2', [], [tx('Tom R.', '', true), tx('3'), tx('Seattle – Ballard'), b('None', 'neutral', 'minus')], 'bl'],
      ['g3', [], [tx('Oliver P.', '', true), tx('5'), tx('London – Borough'), b('Email', 'success')], 'bo'],
    ] },
  /* Shared */
  marketing: { columns: [['campaign', 'Campaign'], ['scope', 'Scope'], ['channel', 'Channel'], ['status', 'Status'], ['updated', 'Updated']], filters: [['all', 'All'], ['draft', 'Draft'], ['scheduled', 'Scheduled']], source: 'BranchHarbor campaigns', primaryAction: 'New campaign',
    description: 'Campaign reporting uses observed form and booking data only. Attribution beyond the form source is not measured.',
    rows: [
      ['mk1', ['draft'], [tx('New year, new practice', 'AI draft · not sent', true), tx('Canadian locations (3)'), tx('Web + email'), b('Draft', 'info', 'edit'), tx('Today')]],
      ['mk2', ['scheduled'], [tx('Teacher training info night', '', true), tx('Toronto – Queen West'), tx('Web'), b('Scheduled', 'success', 'clock'), tx('2 Oct')]],
      ['mk3', [], [tx('Spring open house', '', true), tx('All locations'), tx('Web + email'), b('Completed', 'neutral', 'check'), tx('12 Apr')]],
      ['mk4', ['draft'], [tx('Herbst-Eröffnung Berlin', 'German copy', true), tx('Berlin – Prenzlauer Berg'), tx('Web'), b('Needs approval', 'warning', 'shield'), tx('Yesterday')]],
    ] },
};

const CUSTOMER_TABLE: Record<IndustryKey, string> = { studios: 'members', sports: 'participants', wellness: 'clients', commerce: 'shoppers', foods: 'guests' };

export function buildTable(ind: IndustryKey, key: string, locIds: string[]): TableData | null {
  const k = key === 'customers' ? CUSTOMER_TABLE[ind] : key;
  const spec = TABLES[k];
  if (!spec) return null;
  return {
    key: k,
    description: spec.description,
    columns: spec.columns.map(([key, label, align]) => ({ key, label, align })),
    filters: spec.filters.map(([key, label]) => ({ key, label })),
    source: spec.source,
    primaryAction: spec.primaryAction,
    rows: spec.rows
      .filter(([, , , lid]) => !lid || locIds.includes(lid))
      .map(([id, tags, cells]) => ({ id, tags, cells: Object.fromEntries(spec.columns.map(([ck], i) => [ck, cells[i]!])) })),
  };
}

/* ------------------------------------------------------------------ */
/* AI                                                                  */
/* ------------------------------------------------------------------ */

export const AI: Record<IndustryKey, { suggestions: string[]; answer: string; assumptions: string; sources: [string, string][]; action: { title: string; kind: 'draft' | 'publish' | 'send'; affected: string[]; excluded: string[] } }> = {
  studios: {
    suggestions: ['Summarise attendance changes this month', 'Draft a multi-location New Year campaign', 'Draft a class description for Slow Flow'],
    answer: 'Occupancy rose at Queen West (+6 pts) and Leslieville (+3) versus September. Shoreditch is flat and Surry Hills is down 2 pts. Kitsilano can’t be compared: its booking sync has been degraded since 09:40 local time. I can’t tell why attendance changed from occupancy alone.',
    assumptions: 'Compared 1–13 Oct with the same days in September, in each studio’s own time zone.',
    sources: [['Booking connection · class occurrences', 'Updated 4 min ago'], ['Kitsilano booking sync', 'Last success 2 h ago']],
    action: { title: 'Draft “New year, new practice” campaign for 3 Canadian studios', kind: 'draft', affected: ['Toronto – Queen West', 'Toronto – Leslieville', 'Vancouver – Kitsilano'], excluded: ['Seattle – Capitol Hill (different offer pricing)', 'London, Berlin, Sydney (not in campaign scope)'] },
  },
  sports: {
    suggestions: ['Suggest a fix for the Pitch 2 clash', 'Summarise U10 enrolment', 'Draft the camp announcement'],
    answer: 'Move U12 Camp to Pitch 1 at 17:00 (free until 18:30), or shift U10 Blue to 16:00 at Hillcrest Dome. Both only affect those two groups. I won’t select or move participants — that stays with your coaches.',
    assumptions: 'Uses venue bookings for today at Riverside Park, Pacific time.',
    sources: [['Schedule · venue bookings', 'Updated 2 min ago']],
    action: { title: 'Draft notice to U12 Camp guardians about the pitch change', kind: 'send', affected: ['U12 Camp · 22 guardians at Riverside Park'], excluded: ['All other groups and venues'] },
  },
  wellness: {
    suggestions: ['Draft a reply using our cancellation policy', 'Summarise utilisation by practitioner', 'Write copy for Hot stone'],
    answer: 'Draft: “Hi Jordan, you can move your appointment free of charge up to 24 hours before. I’ve found Thu 17:00 with Rina if that suits.” I didn’t use any intake form details.',
    assumptions: 'Cancellation policy v2 applies to Harbourfront. Intake form responses are excluded from AI context.',
    sources: [['Policies › Cancellation v2', 'Published 1 Sep 2026'], ['Calendar · Harbourfront', 'Live']],
    action: { title: 'Send reply to Jordan P. by email', kind: 'send', affected: ['Jordan P. · Toronto – Harbourfront'], excluded: [] },
  },
  commerce: {
    suggestions: ['Explain this week’s stock trend', 'Draft copy for Canvas tote from its spec sheet', 'Which stores failed the last sync?'],
    answer: 'Linen overshirt L sold 9 units at Portland in 7 days against 3 the week before; stock is 1. Merino crew is flat. This is based on WooCommerce orders only; in-store sales aren’t connected, and Austin is excluded while disconnected.',
    assumptions: 'Revenue is reported per currency (USD, CAD, EUR) and never combined.',
    sources: [['WooCommerce orders', 'Updated 1 min ago'], ['Inventory history', 'Updated 6 min ago']],
    action: { title: 'Draft reorder note for Linen overshirt L at Portland', kind: 'draft', affected: ['Portland store'], excluded: ['Austin store (disconnected)'] },
  },
  foods: {
    suggestions: ['Summarise today’s production by item', 'Draft menu copy for the flatbread', 'Plan a lunch promotion across Seattle'],
    answer: 'Ballard so far: 14 Ember bowls, 8 brisket sandwiches, 6 flatbreads, 11 lemonades. Fremont is missing because its kitchen screen is offline, though orders still arrived there. I can’t change prices, dietary labels or order acceptance.',
    assumptions: 'Counts orders accepted since opening, Pacific time.',
    sources: [['Orders · Ballard', '11:00–12:10'], ['Fremont kitchen screen', 'Offline since 11:42']],
    action: { title: 'Draft “Weekday lunch” promotion for Seattle locations', kind: 'draft', affected: ['Seattle – Ballard', 'Seattle – Fremont'], excluded: ['Vancouver, London, Berlin (outside requested scope)'] },
  },
};
