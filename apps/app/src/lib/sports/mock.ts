/**
 * Sample sports academy for the app's mock mode (NEXT_PUBLIC_USE_MOCKS / offline fallback).
 * Locations match the mock "North Shore FA" organisation: Vancouver (CAD), Toronto (CAD), Manchester (GBP).
 * In-memory and stateful; mirrors the API's rules where screens rely on them (capacity, approval, scoping).
 */
import { ApiError } from '../errors';
import { checkAgeEligibility, eligibleBirthDates, instalmentState, splitInstalments, defaultAgeConvention } from '@bh/shared';
import type { Currency } from '@bh/shared';
import { totalsOf, type SportsClient, type ScopeIds } from './client';
import type {
  SAnnouncement, SBalanceRow, SDispute, SForm, SGuardianRel, SInstalment, SProgramme, SProposal, SQuestion, SRegistration, SSeason, SSelection, SSession, STeam, SThread, SVenue,
} from './types';

const LOCS = [
  { id: 'rp', name: 'Vancouver – Riverside Park', timeZone: 'America/Vancouver', currency: 'CAD' as Currency, country: 'CA' },
  { id: 'hc', name: 'Toronto – Hillcrest Dome', timeZone: 'America/Toronto', currency: 'CAD' as Currency, country: 'CA' },
  { id: 'mc', name: 'Manchester – Didsbury', timeZone: 'Europe/London', currency: 'GBP' as Currency, country: 'GB' },
];
const delay = <T,>(v: T, ms = 220) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const inScope = (scope: ScopeIds, id: string | null | undefined) => !scope.length || (!!id && scope.includes(id));
let seq = 0;
const nid = (p: string) => `${p}_${(++seq).toString(36)}`;

const BUILT_IN: SQuestion[] = [
  { key: 'emergency_contact_name', label: 'Emergency contact name', type: 'text', required: true, category: 'emergency', coachVisible: true },
  { key: 'emergency_contact_phone', label: 'Emergency contact phone', type: 'phone', required: true, category: 'emergency', coachVisible: true },
  { key: 'medical_notes', label: 'Medical information the club should know', type: 'textarea', required: false, category: 'medical' },
  { key: 'medical_action_plan', label: 'Action plan coaches should follow', type: 'textarea', required: false, category: 'medical', coachVisible: true },
  { key: 'photo_consent', label: 'Photo consent', type: 'yes_no', required: true, category: 'consent' },
];

interface Db {
  seasons: SSeason[]; venues: SVenue[]; programmes: SProgramme[]; teams: STeam[]; regs: SRegistration[]; inst: Record<string, SInstalment[]>;
  sessions: SSession[]; selections: SSelection[]; announcements: SAnnouncement[]; rels: SGuardianRel[]; disputes: SDispute[]; threads: SThread[]; forms: SForm[]; proposals: SProposal[];
  marks: Record<string, Record<string, { status: 'present' | 'absent' | 'late' | 'excused'; reason: string | null; by: 'coach' | 'guardian' }>>;
  restricted: Record<string, Record<string, unknown>>;
}

const KIDS = ['Leo Park', 'Ava Singh', 'Noah Williams', 'Maya Chen', 'Ethan Brown', 'Zara Ahmed', 'Lucas Silva', 'Chloe Martin', 'Omar Haddad', 'Isla Murphy', 'Theo Rossi', 'Amara Okafor'];

function build(): Db {
  const t0 = today();
  const db: Db = { seasons: [], venues: [], programmes: [], teams: [], regs: [], inst: {}, sessions: [], selections: [], announcements: [], rels: [], disputes: [], threads: [], forms: [], proposals: [], marks: {}, restricted: {} };
  for (const [li, l] of LOCS.entries()) {
    const conv = defaultAgeConvention(l.country, addDays(t0, -40), addDays(t0, 60));
    const season: SSeason = { id: nid('season'), name: l.country === 'GB' ? '2026–27 season' : 'Fall 2026', startsOn: addDays(t0, -40), endsOn: addDays(t0, 60), locationId: l.id, ageRule: conv.rule, ageCutoffDate: conv.cutoffDate, status: 'published' };
    db.seasons.push(season);
    const pitch = (name: string, parent?: string): SVenue => ({ id: nid('venue'), locationId: l.id, name, kind: 'pitch', surface: 'Artificial turf', parentVenueId: parent ?? null, active: true });
    const p1 = pitch(`${l.name.split('–')[1]?.trim() ?? 'Main'} Pitch 1`);
    const p2 = pitch(`${l.name.split('–')[1]?.trim() ?? 'Main'} Pitch 2`);
    db.venues.push(p1, p2, pitch(`${p1.name} — half A`, p1.id));
    const fee = l.currency === 'GBP' ? 24_000 : 42_000;
    const prog: SProgramme = {
      id: nid('prog'), locationId: l.id, name: 'Youth Academy', description: 'Two training sessions a week plus weekend fixtures.', kind: 'academy', status: 'published', ageMin: 8, ageMax: 14, ageRule: conv.rule, ageCutoffDate: conv.cutoffDate,
      capacity: 40, feeMinor: fee, currency: l.currency, requiresApproval: true, refundPolicy: 'Full refund before the first session; pro rata afterwards.', registrationOpensAt: null, registrationClosesAt: null, siblingDiscountBps: 1000,
      season: { id: season.id, name: season.name, startsOn: season.startsOn, endsOn: season.endsOn }, counts: { accepted: 0, awaitingReview: 0, submitted: 0, waitlisted: 0, withdrawn: 0 },
    };
    const camp: SProgramme = { ...prog, id: nid('prog'), name: 'Holiday Camp', kind: 'camp', description: 'Four mornings of skills and small-sided games.', capacity: 24, feeMinor: l.currency === 'GBP' ? 9500 : 18_000, requiresApproval: false, status: li === 2 ? 'draft' : 'published', siblingDiscountBps: 500, counts: { ...prog.counts } };
    db.programmes.push(prog, camp);
    const teamNames = li === 2 ? ['U11 Sky', 'U13 Sky'] : ['U10 Blue', 'U12 Blue'];
    const teams: STeam[] = teamNames.map((name, ti) => ({ id: nid('team'), locationId: l.id, programmeId: prog.id, name, kind: 'team', capacity: 12, rosterCount: 0, coach: { id: `coach_${li}_${ti}`, name: ti === 0 && li === 0 ? 'Coach Ortiz' : ['Coach Ahmed', 'Coach Lee', 'Coach Hughes'][li]! }, assistants: [], youCoach: li === 0 && ti === 0 }));
    const squad: STeam = { id: nid('team'), locationId: l.id, programmeId: prog.id, name: 'Cup Squad', kind: 'squad', capacity: 10, rosterCount: 0, coach: teams[0]!.coach, assistants: [], youCoach: li === 0 };
    db.teams.push(...teams, squad);
    // Registrations.
    for (let k = 0; k < 9; k++) {
      const kid = KIDS[(k + li * 3) % KIDS.length]!;
      const team = teams[k % 2]!;
      const status: SRegistration['status'] = k < 6 ? 'accepted' : k === 6 ? 'awaiting_review' : k === 7 ? 'waitlisted' : 'submitted';
      const dob = `${2026 - (9 + (k % 2) * 2)}-0${(k % 8) + 1}-1${k % 9}`;
      const elig = checkAgeEligibility({ dateOfBirth: dob, rule: conv.rule, cutoffDate: conv.cutoffDate, ageMin: null, ageMax: null });
      const plan = k % 3 === 0 ? 'full' : 'instalments';
      const total = fee - (k === 4 ? fee / 10 : 0);
      const reg: SRegistration = {
        id: nid('reg'), locationId: l.id, status, teamId: status === 'accepted' ? team.id : null, paymentPlan: plan, listFeeMinor: fee, totalFeeMinor: total, currency: l.currency, reviewNote: null, createdAt: new Date(Date.now() - (30 - k) * 86400_000).toISOString(),
        participant: { id: nid('kid'), name: kid, dateOfBirth: dob, age: elig.age, ageGroup: elig.ageGroup }, programme: { id: prog.id, name: prog.name, requiresApproval: true },
        guardian: { id: nid('g'), name: `${['Sam', 'Alex', 'Jamie', 'Robin', 'Chris', 'Taylor'][k % 6]} ${kid.split(' ')[1]}`, email: `${kid.toLowerCase().replace(' ', '.')}@example.com`, relationshipStatus: k === 5 ? 'pending_verification' : 'verified', relationship: 'parent' },
        guardiansCount: k === 1 ? 2 : 1, balance: { currency: null, total: 0, paid: 0, outstanding: 0, overdue: 0, state: 'none', nextDue: null },
        adjustments: k === 4 ? [{ id: nid('adj'), kind: 'sibling_discount', amount: { amount: fee / 10, currency: l.currency }, reason: 'Sibling discount (10%)' }] : [], formsComplete: k !== 7, holdActive: status === 'submitted', lastPaymentState: status === 'submitted' ? 'created' : 'succeeded',
      };
      db.regs.push(reg);
      if (status !== 'waitlisted') {
        const steps = plan === 'full' ? [{ dueOn: addDays(t0, -35), shareBps: 10_000 }] : [{ dueOn: addDays(t0, -35), shareBps: 3334 }, { dueOn: addDays(t0, -5), shareBps: 3333 }, { dueOn: addDays(t0, 25), shareBps: 3333 }];
        db.inst[reg.id] = splitInstalments(total, steps).map((x) => {
          const paid = status !== 'submitted' && (x.seq === 1 || (x.seq === 2 && k % 4 !== 1));
          return { id: nid('inst'), seq: x.seq, dueOn: x.dueOn, amount: { amount: x.amountMinor, currency: l.currency }, status: paid ? 'paid' : 'scheduled', state: 'scheduled', paidAt: paid ? `${x.dueOn}T15:00:00Z` : null, remindersSent: paid ? 0 : 1, lastReminderStage: paid ? null : 'due' };
        });
      }
      db.rels.push({ id: nid('rel'), relationship: 'parent', status: reg.guardian!.relationshipStatus as SGuardianRel['status'], participant: { id: reg.participant.id, name: kid, locationId: l.id }, guardian: { id: reg.guardian!.id, name: reg.guardian!.name, email: reg.guardian!.email, phone: null, hasAccount: k % 2 === 0 } });
      db.restricted[reg.id] = { emergency_contact_name: reg.guardian!.name, emergency_contact_phone: l.currency === 'GBP' ? '+44 161 496 0100' : '+1 604 555 0100', ...(k === 2 ? { medical_notes: 'Sample: asthma — reliever inhaler in kit bag', medical_action_plan: 'Sample: allow inhaler use; call guardian if symptoms continue' } : {}) };
    }
    // Sessions: last week to next two weeks, Tue/Thu training, Sat fixtures; Thursday clash on Pitch 1 at Vancouver.
    for (let d = -7; d <= 14; d++) {
      const date = addDays(t0, d);
      const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
      for (const [ti, team] of teams.entries()) {
        const fixture = wd === 6;
        if (!(wd === 2 || wd === 4 || fixture)) continue;
        const hour = fixture ? 9 + ti * 2 : 17 + ti;
        const startsAt = localIso(date, hour, l.timeZone);
        const clash = li === 0 && wd === 4;
        const venue = clash ? p1 : ti === 0 ? p1 : p2;
        const s: SSession = {
          id: nid('ses'), kind: fixture ? 'fixture' : 'training', status: d === 3 && ti === 1 ? 'cancelled' : 'scheduled', startsAt, endsAt: new Date(Date.parse(startsAt) + (clash && ti === 1 ? 30 : 90) * 60_000).toISOString(),
          venue: fixture && ti === 1 ? 'Opponent ground' : venue.name, venueId: fixture && ti === 1 ? null : venue.id, opponent: fixture ? ['Riverside Rovers', 'Hillcrest United', 'Didsbury Juniors'][(d + ti + 21) % 3]! : null, homeAway: fixture ? (ti === 1 ? 'away' : 'home') : null,
          competition: fixture ? 'Fall League' : null, cancelReason: d === 3 && ti === 1 ? 'Pitch waterlogged' : null, location: { id: l.id, name: l.name, timeZone: l.timeZone }, team: { id: team.id, name: team.name, kind: team.kind, coach: team.coach },
          programme: { id: prog.id, name: prog.name }, youCoach: team.youCoach, rosterCount: 0, attendance: { recorded: 0, present: 0, absent: 0, late: 0, excused: 0 }, venueConflict: false, conflicts: [],
        };
        db.sessions.push(s);
        if (d < 0) {
          db.marks[s.id] = Object.fromEntries(db.regs.filter((r) => r.teamId === team.id).map((r, i) => [r.participant.id, { status: i === 2 && d % 2 === 0 ? 'absent' : i === 4 ? 'late' : 'present', reason: i === 2 && d % 2 === 0 ? 'illness' : null, by: 'coach' as const }]));
        } else if (d > 0 && d < 4) {
          const r = db.regs.find((x) => x.teamId === team.id);
          if (r) db.marks[s.id] = { [r.participant.id]: { status: 'excused', reason: 'school', by: 'guardian' } };
        }
      }
    }
    const accepted = db.regs.filter((r) => r.locationId === l.id && r.status === 'accepted');
    db.selections.push({ id: nid('sel'), locationId: l.id, squadTeamId: squad.id, squadName: squad.name, title: 'Winter indoor cup', notes: 'From the indoor cup sign-up list.', status: 'proposed', proposedByName: squad.coach?.name ?? 'Coach', decisionNote: null, canDecide: true, participants: accepted.slice(0, 4).map((r) => ({ id: r.participant.id, name: r.participant.name, note: 'Attended every September session' })), createdAt: new Date(Date.now() - 86400_000).toISOString() });
    db.announcements.push({ id: nid('ann'), locationId: l.id, scopeKind: 'team', scopeId: teams[0]!.id, scopeName: teams[0]!.name, title: 'New kit collection', body: 'Training kits are ready to collect from reception before Thursday.', recipientCount: 5, createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), createdByName: teams[0]!.coach?.name ?? null });
    const g = accepted[0]!;
    db.threads.push({ guardian: { id: g.guardian!.id, name: g.guardian!.name }, locationId: l.id, locationName: l.name, unread: 1, messages: [
      { id: nid('m'), direction: 'inbound', body: 'Is there parking near the pitch on Saturdays?', createdAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
      { id: nid('m'), direction: 'outbound', body: 'Yes — the north car park is free for families on match days.', createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
      { id: nid('m'), direction: 'inbound', body: 'Thanks! Can my child move to the earlier group next month?', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
    ] });
    db.forms.push({ id: nid('form'), name: `${l.name} registration`, version: 1, locationId: l.id, status: 'active', questions: [{ key: 'shirt_size', label: 'Training shirt size', type: 'select', required: true, options: ['YS', 'YM', 'YL'], category: 'general' }, { key: 'school', label: 'School', type: 'text', required: false, category: 'general' }] });
  }
  const mcKid = db.regs.find((r) => r.locationId === 'mc' && r.status === 'accepted')!;
  const rel: SGuardianRel = { id: nid('rel'), relationship: 'step-parent', status: 'disputed', participant: { id: mcKid.participant.id, name: mcKid.participant.name, locationId: 'mc' }, guardian: { id: nid('g'), name: 'Jordan Mills (sample)', email: 'jordan.mills.sample@example.com', phone: null, hasAccount: false } };
  db.rels.push(rel);
  db.disputes.push({ id: nid('disp'), status: 'open', reason: 'I did not authorise this person to see my child’s schedule.', createdAt: new Date(Date.now() - 86400_000).toISOString(), participant: { id: mcKid.participant.id, name: mcKid.participant.name }, relationship: { id: rel.id, relationship: rel.relationship, guardian: { id: rel.guardian!.id, name: rel.guardian!.name, email: rel.guardian!.email } }, raisedBy: mcKid.guardian!.name, resolutionNote: null });
  return db;
}

function localIso(date: string, hour: number, tz: string): string {
  const naive = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(naive));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(naive - (asUtc - naive)).toISOString();
}

let DB: Db | null = null;
const db = () => (DB ??= build());

function refresh() {
  const d = db();
  const t0 = today();
  for (const p of d.programmes) {
    const rs = d.regs.filter((r) => r.programme.id === p.id);
    p.counts = { accepted: rs.filter((r) => r.status === 'accepted').length, awaitingReview: rs.filter((r) => r.status === 'awaiting_review').length, submitted: rs.filter((r) => r.status === 'submitted').length, waitlisted: rs.filter((r) => r.status === 'waitlisted').length, withdrawn: rs.filter((r) => r.status === 'withdrawn').length };
  }
  for (const t of d.teams) t.rosterCount = t.kind === 'squad' ? d.selections.filter((s) => s.squadTeamId === t.id && s.status === 'approved').flatMap((s) => s.participants).length : d.regs.filter((r) => r.teamId === t.id && r.status === 'accepted').length;
  for (const r of d.regs) {
    const ii = (d.inst[r.id] ?? []).map((i) => ({ ...i, state: instalmentState(i, t0) }));
    d.inst[r.id] = ii;
    const unpaid = ii.filter((i) => i.status === 'scheduled');
    const paid = ii.filter((i) => i.status === 'paid').reduce((a, i) => a + i.amount.amount, 0);
    const outstanding = unpaid.reduce((a, i) => a + i.amount.amount, 0);
    const overdue = unpaid.filter((i) => i.state === 'overdue').reduce((a, i) => a + i.amount.amount, 0);
    r.balance = !ii.length ? { currency: null, total: 0, paid: 0, outstanding: 0, overdue: 0, state: 'none', nextDue: null }
      : { currency: r.currency, total: paid + outstanding, paid, outstanding, overdue, state: !unpaid.length ? (paid ? 'paid' : 'waived') : overdue ? 'overdue' : unpaid.some((i) => i.state === 'due') ? 'due' : 'on_track', nextDue: unpaid[0] ? { dueOn: unpaid[0].dueOn, amountMinor: unpaid[0].amount.amount, instalmentId: unpaid[0].id } : null };
  }
  for (const s of d.sessions) {
    const t = d.teams.find((x) => x.id === s.team.id)!;
    s.rosterCount = t.rosterCount;
    const m = Object.values(d.marks[s.id] ?? {});
    s.attendance = { recorded: m.length, present: m.filter((x) => x.status === 'present').length, absent: m.filter((x) => x.status === 'absent').length, late: m.filter((x) => x.status === 'late').length, excused: m.filter((x) => x.status === 'excused').length };
    const related = (v: string | null) => { const ven = d.venues.find((x) => x.id === v); return new Set([v, ven?.parentVenueId, ...d.venues.filter((c) => c.parentVenueId === v).map((c) => c.id)].filter(Boolean)); };
    const rel = related(s.venueId);
    s.conflicts = s.status === 'cancelled' || !s.venueId ? [] : d.sessions.filter((o) => o.id !== s.id && o.status !== 'cancelled' && o.location.id === s.location.id && o.venueId && rel.has(o.venueId) && o.startsAt < s.endsAt && o.endsAt > s.startsAt).map((o) => ({ sessionId: o.id, teamName: o.team.name, startsAt: o.startsAt, endsAt: o.endsAt }));
    s.venueConflict = s.conflicts.length > 0;
  }
}

const fail = (code: string, message: string, status = 409) => Promise.reject(new ApiError(code, message, status));

export const mockSports: SportsClient = {
  async overview(scope) {
    refresh();
    const d = db();
    const progs = d.programmes.filter((p) => inScope(scope, p.locationId) && p.status !== 'archived');
    const now = Date.now();
    const overdue = d.regs.filter((r) => inScope(scope, r.locationId)).flatMap((r) => (d.inst[r.id] ?? []).filter((i) => i.state === 'overdue'));
    return delay({
      locations: LOCS.filter((l) => inScope(scope, l.id)),
      programmes: progs.map((p) => ({ id: p.id, name: p.name, status: p.status, locationId: p.locationId, capacity: p.capacity, held: p.counts.accepted + p.counts.awaitingReview + p.counts.submitted, accepted: p.counts.accepted, awaitingReview: p.counts.awaitingReview, awaitingPayment: p.counts.submitted, waitlisted: p.counts.waitlisted })),
      work: { awaitingReview: progs.reduce((a, p) => a + p.counts.awaitingReview, 0), openDisputes: d.disputes.filter((x) => x.status === 'open').length, pendingSelections: d.selections.filter((s) => s.status === 'proposed' && inScope(scope, s.locationId)).length, overdueInstalments: overdue.length, overdueByCurrency: Object.entries(overdue.reduce<Record<string, number>>((a, i) => ({ ...a, [i.amount.currency]: (a[i.amount.currency] ?? 0) + i.amount.amount }), {})).map(([currency, amount]) => ({ currency: currency as Currency, amount })) },
      upcoming: d.sessions.filter((s) => inScope(scope, s.location.id) && Date.parse(s.startsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 8).map((s) => ({ id: s.id, kind: s.kind, status: s.status, team: s.team.name, startsAt: s.startsAt, endsAt: s.endsAt, venue: s.venue, opponent: s.opponent, location: { name: s.location.name, timeZone: s.location.timeZone } })),
    });
  },
  async reports(scope) {
    refresh();
    const d = db();
    const byCur = new Map<Currency, { outstanding: number; overdue: number; collected: number }>();
    for (const r of d.regs.filter((x) => inScope(scope, x.locationId) && x.currency)) {
      const c = byCur.get(r.currency!) ?? { outstanding: 0, overdue: 0, collected: 0 };
      c.outstanding += r.balance.outstanding; c.overdue += r.balance.overdue; c.collected += r.balance.paid;
      byCur.set(r.currency!, c);
    }
    return delay({
      asOf: new Date().toISOString(), periodDays: 60,
      enrolment: d.programmes.filter((p) => inScope(scope, p.locationId)).map((p) => ({ programmeId: p.id, programme: p.name, locationId: p.locationId, capacity: p.capacity, accepted: p.counts.accepted, awaitingReview: p.counts.awaitingReview, awaitingPayment: p.counts.submitted, waitlisted: p.counts.waitlisted, withdrawn: p.counts.withdrawn, fillRate: p.capacity ? Math.round(((p.counts.accepted + p.counts.awaitingReview) / p.capacity) * 1000) / 10 : null, fillRateUnavailableReason: p.capacity ? null : 'No capacity set' })),
      capacity: d.teams.filter((t) => inScope(scope, t.locationId)).map((t) => ({ teamId: t.id, team: t.name, kind: t.kind, locationId: t.locationId, roster: t.rosterCount, capacity: t.capacity, spaces: t.capacity === null ? null : Math.max(0, t.capacity - t.rosterCount) })),
      attendance: d.teams.filter((t) => inScope(scope, t.locationId)).map((t) => {
        const marks = d.sessions.filter((s) => s.team.id === t.id && Date.parse(s.startsAt) < Date.now()).flatMap((s) => Object.values(d.marks[s.id] ?? {}));
        const attended = marks.filter((m) => m.status === 'present' || m.status === 'late').length;
        return { teamId: t.id, team: t.name, locationId: t.locationId, recorded: marks.length, attended, excused: marks.filter((m) => m.status === 'excused').length, rate: marks.length ? Math.round((attended / marks.length) * 1000) / 10 : null, rateUnavailableReason: marks.length ? null : 'No attendance recorded in this period' };
      }),
      balances: [...byCur.entries()].map(([currency, v]) => ({ currency, ...v })), locations: LOCS.filter((l) => inScope(scope, l.id)),
    });
  },
  async programmes(scope) { refresh(); return delay(db().programmes.filter((p) => inScope(scope, p.locationId))); },
  async updateProgramme(id, patch) {
    const p = db().programmes.find((x) => x.id === id);
    if (!p) return fail('not_found', 'Programme not found', 404);
    Object.assign(p, patch);
    return delay(p);
  },
  seasons: async () => delay(db().seasons),
  venues: async (locationId) => delay(db().venues.filter((v) => !locationId || v.locationId === locationId)),
  coaches: async () => delay([{ id: 'coach_0_0', name: 'Coach Ortiz', email: 'ortiz@example.com', roles: ['staff'] }, { id: 'coach_x', name: 'Coach Ahmed', email: 'ahmed@example.com', roles: ['staff'] }, { id: 'mgr', name: 'Marcus Bell', email: 'marcus@example.com', roles: ['location_manager'] }]),
  forms: async () => delay({ builtIn: BUILT_IN, items: db().forms }),
  async createForm(input) { const f: SForm = { id: nid('form'), name: input.name, version: 1, locationId: input.locationId, questions: input.questions, status: 'active' }; db().forms.push(f); return delay(f); },
  async agePreview(q) {
    const loc = LOCS.find((l) => l.id === q.locationId) ?? LOCS[0]!;
    const conv = defaultAgeConvention(loc.country, q.startsOn, q.endsOn);
    const rule = (q.rule as 'age_on_date' | 'birth_year') ?? conv.rule;
    const cutoffDate = q.cutoffDate ?? conv.cutoffDate;
    return delay({ default: conv, rule, cutoffDate, birthDates: eligibleBirthDates(rule, cutoffDate, q.ageMin ?? null, q.ageMax ?? null) }, 80);
  },
  async setup(input) {
    const d = db();
    const loc = LOCS.find((l) => l.id === input.locationId) ?? LOCS[0]!;
    const conv = defaultAgeConvention(loc.country, input.season.startsOn, input.season.endsOn);
    const season: SSeason = { id: nid('season'), name: input.season.name, startsOn: input.season.startsOn, endsOn: input.season.endsOn, locationId: loc.id, ageRule: input.season.ageRule ?? conv.rule, ageCutoffDate: input.season.ageCutoffDate ?? conv.cutoffDate, status: input.publish ? 'published' : 'draft' };
    d.seasons.push(season);
    for (const v of input.venues) d.venues.push({ id: nid('venue'), locationId: loc.id, name: v.name, kind: v.kind, surface: v.surface ?? null, parentVenueId: null, active: true });
    const created = input.programmes.map((p) => {
      if (p.feeMinor > 0 && !p.refundPolicy) throw new ApiError('validation_failed', 'Paid programmes must show a refund/withdrawal policy before checkout', 400, { refundPolicy: 'Required' });
      const prog: SProgramme = { id: nid('prog'), locationId: loc.id, name: p.name, description: p.description ?? null, kind: p.kind, status: input.publish ? 'published' : 'draft', ageMin: p.ageMin ?? null, ageMax: p.ageMax ?? null, ageRule: p.ageRule ?? season.ageRule!, ageCutoffDate: p.ageCutoffDate ?? season.ageCutoffDate, capacity: p.capacity ?? null, feeMinor: p.feeMinor, currency: loc.currency, requiresApproval: p.requiresApproval, refundPolicy: p.refundPolicy ?? null, registrationOpensAt: p.registrationOpensAt ?? null, registrationClosesAt: p.registrationClosesAt ?? null, siblingDiscountBps: p.siblingDiscountBps, season: { id: season.id, name: season.name, startsOn: season.startsOn, endsOn: season.endsOn }, counts: { accepted: 0, awaitingReview: 0, submitted: 0, waitlisted: 0, withdrawn: 0 } };
      d.programmes.push(prog);
      for (const t of p.teams) d.teams.push({ id: nid('team'), locationId: loc.id, programmeId: prog.id, name: t.name, kind: t.kind, capacity: t.capacity ?? null, rosterCount: 0, coach: t.coachUserId ? { id: t.coachUserId, name: 'Coach' } : null, assistants: [], youCoach: false });
      return { id: prog.id, name: prog.name };
    });
    return delay({ season, programmes: created });
  },
  async registrations(scope) { refresh(); return delay(db().regs.filter((r) => inScope(scope, r.locationId))); },
  async review(id, decision, teamId, note) {
    const d = db();
    const r = d.regs.find((x) => x.id === id);
    if (!r) return fail('not_found', 'Registration not found', 404);
    if (r.status === 'submitted' && decision === 'accept') return fail('payment_pending', 'Payment for this registration has not completed');
    if (decision === 'accept' && teamId) {
      const t = d.teams.find((x) => x.id === teamId)!;
      refresh();
      if (t.capacity !== null && t.rosterCount >= t.capacity) return fail('team_full', `${t.name} is full`);
    }
    r.status = decision === 'accept' ? 'accepted' : decision === 'waitlist' ? 'waitlisted' : 'rejected';
    r.teamId = decision === 'accept' ? teamId ?? r.teamId : null;
    r.reviewNote = note ?? null;
    return delay(undefined);
  },
  async withdraw(id) { const r = db().regs.find((x) => x.id === id); if (r) { r.status = 'withdrawn'; r.teamId = null; (db().inst[r.id] ?? []).forEach((i) => { if (i.status === 'scheduled') i.status = 'cancelled'; }); } return delay(undefined); },
  async restricted(id) { return delay({ access: 'full' as const, answers: db().restricted[id] ?? {} }); },
  async teams(scope) { refresh(); return delay(db().teams.filter((t) => inScope(scope, t.locationId))); },
  async team(id) {
    refresh();
    const d = db();
    const t = d.teams.find((x) => x.id === id);
    if (!t) return fail('not_found', 'Team not found', 404);
    const roster = t.kind === 'squad' ? d.selections.filter((s) => s.squadTeamId === t.id && s.status === 'approved').flatMap((s) => s.participants).map((p) => ({ id: p.id, name: p.name, dateOfBirth: null, registrationId: null, ageGroup: null }))
      : d.regs.filter((r) => r.teamId === t.id && r.status === 'accepted').map((r) => ({ id: r.participant.id, name: r.participant.name, dateOfBirth: r.participant.dateOfBirth, registrationId: r.id, ageGroup: r.participant.ageGroup }));
    return delay({ team: t, programme: { id: t.programmeId, name: d.programmes.find((p) => p.id === t.programmeId)?.name ?? '' }, canManage: true, coach: t.coach, assistants: t.assistants.map((a) => ({ ...a, role: 'assistant' })), roster, moves: [] });
  },
  async transfer(registrationId, toTeamId) {
    refresh();
    const d = db();
    const r = d.regs.find((x) => x.id === registrationId)!;
    const t = d.teams.find((x) => x.id === toTeamId)!;
    if (t.capacity !== null && t.rosterCount >= t.capacity) return fail('team_full', `${t.name} is full (${t.capacity})`);
    r.teamId = toTeamId;
    return delay(undefined);
  },
  async setCoaches(teamId, head) { const t = db().teams.find((x) => x.id === teamId); if (t) t.coach = head ? { id: head, name: 'Coach' } : null; return delay(undefined); },
  async sessions(scope, from, to, opts) {
    refresh();
    return delay(db().sessions.filter((s) => inScope(scope, s.location.id) && s.startsAt < to && s.endsAt > from && (!opts?.mine || s.youCoach)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
  },
  async roster(sessionId) {
    const d = db();
    const s = d.sessions.find((x) => x.id === sessionId);
    if (!s) return fail('not_found', 'Session not found', 404);
    const marks = d.marks[s.id] ?? {};
    return delay({
      session: { id: s.id, startsAt: s.startsAt, endsAt: s.endsAt, venue: s.venue, kind: s.kind, status: s.status, timeZone: s.location.timeZone }, team: { id: s.team.id, name: s.team.name },
      roster: d.regs.filter((r) => r.teamId === s.team.id && r.status === 'accepted').map((r) => {
        const m = marks[r.participant.id];
        const c = d.restricted[r.id] ?? {};
        return { id: r.participant.id, name: r.participant.name, attendance: m?.status ?? null, absenceReason: m?.reason ?? null, reportedBy: m?.by ?? null, note: null, care: { emergencyContact: c.emergency_contact_name ? { name: String(c.emergency_contact_name), phone: String(c.emergency_contact_phone ?? '') } : null, actionPlan: c.medical_action_plan ? String(c.medical_action_plan) : null, medicalInfoOnFile: !!c.medical_notes } };
      }),
    });
  },
  async markAttendance(sessionId, marks) {
    const d = db();
    const prev = d.marks[sessionId] ?? {};
    let notified = 0;
    for (const m of marks) {
      if (m.status === 'absent' && prev[m.participantId]?.by !== 'guardian' && prev[m.participantId]?.status !== 'absent') notified++;
      prev[m.participantId] = { status: m.status as 'present', reason: m.absenceReason ?? prev[m.participantId]?.reason ?? null, by: 'coach' };
    }
    d.marks[sessionId] = prev;
    return delay({ recorded: marks.length, notifiedGuardians: notified, skippedNoConsent: 0 });
  },
  async cancelSession(id, reason) { refresh(); const s = db().sessions.find((x) => x.id === id)!; s.status = 'cancelled'; s.cancelReason = reason; return delay({ recipients: s.rosterCount }); },
  async resolutions(sessionId) {
    refresh();
    const d = db();
    const s = d.sessions.find((x) => x.id === sessionId)!;
    if (!s.venueConflict) return delay({ conflicts: [], proposals: [] });
    const others = d.venues.filter((v) => v.locationId === s.location.id && v.id !== s.venueId && !v.parentVenueId && v.parentVenueId !== s.venueId);
    const free = others.filter((v) => !d.sessions.some((o) => o.id !== s.id && o.venueId === v.id && o.status !== 'cancelled' && o.startsAt < s.endsAt && o.endsAt > s.startsAt));
    const later = new Date(Date.parse(s.startsAt) + 90 * 60_000).toISOString();
    d.proposals = d.proposals.filter((p) => p.sessionId !== s.id);
    const props: SProposal[] = [
      ...free.slice(0, 1).map((v) => ({ id: nid('prop'), sessionId: s.id, source: 'rules' as const, status: 'proposed', rationale: `Move to ${v.name} at the same time`, proposal: { kind: 'move_venue', venueId: v.id, venueName: v.name, startsAt: s.startsAt, endsAt: s.endsAt } })),
      { id: nid('prop'), sessionId: s.id, source: 'rules', status: 'proposed', rationale: `Keep ${s.venue}, start 90 min later`, proposal: { kind: 'move_time', venueId: s.venueId, venueName: s.venue, startsAt: later, endsAt: new Date(Date.parse(later) + (Date.parse(s.endsAt) - Date.parse(s.startsAt))).toISOString() } },
    ];
    d.proposals.push(...props);
    return delay({ conflicts: s.conflicts, proposals: props });
  },
  async applyProposal(id) {
    const d = db();
    const p = d.proposals.find((x) => x.id === id)!;
    const s = d.sessions.find((x) => x.id === p.sessionId)!;
    Object.assign(s, { venueId: p.proposal.venueId, venue: p.proposal.venueName, startsAt: p.proposal.startsAt, endsAt: p.proposal.endsAt });
    p.status = 'applied';
    refresh();
    return delay({ recipients: s.rosterCount });
  },
  aiResolutions: () => fail('ai_unavailable', 'BranchHarbor AI is unavailable in sample mode. Rule-based suggestions still work.', 503),
  async createFixture(teamId, input) {
    const d = db();
    const t = d.teams.find((x) => x.id === teamId)!;
    const l = LOCS.find((x) => x.id === t.locationId)!;
    const [h, m] = input.kickoff.split(':').map(Number) as [number, number];
    const startsAt = new Date(Date.parse(localIso(input.date, h, l.timeZone)) + m * 60_000).toISOString();
    const v = d.venues.find((x) => x.id === input.venueId);
    d.sessions.push({ id: nid('ses'), kind: 'fixture', status: 'scheduled', startsAt, endsAt: new Date(Date.parse(startsAt) + input.durationMinutes * 60_000).toISOString(), venue: v?.name ?? input.venueName ?? null, venueId: v?.id ?? null, opponent: input.opponent, homeAway: input.homeAway, competition: input.competition ?? null, cancelReason: null, location: { id: l.id, name: l.name, timeZone: l.timeZone }, team: { id: t.id, name: t.name, kind: t.kind, coach: t.coach }, programme: { id: t.programmeId, name: '' }, youCoach: t.youCoach, rosterCount: 0, attendance: { recorded: 0, present: 0, absent: 0, late: 0, excused: 0 }, venueConflict: false, conflicts: [] });
    return delay({ venueConflicts: [] });
  },
  async createRecurring(teamId, input) {
    const d = db();
    const t = d.teams.find((x) => x.id === teamId)!;
    const l = LOCS.find((x) => x.id === t.locationId)!;
    const v = d.venues.find((x) => x.id === input.venueId);
    let created = 0;
    for (let day = input.from; day <= input.until; day = addDays(day, 1)) {
      if (!input.weekdays.includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue;
      const [h, m] = input.startTime.split(':').map(Number) as [number, number];
      const startsAt = new Date(Date.parse(localIso(day, h, l.timeZone)) + m * 60_000).toISOString();
      d.sessions.push({ id: nid('ses'), kind: 'training', status: 'scheduled', startsAt, endsAt: new Date(Date.parse(startsAt) + input.durationMinutes * 60_000).toISOString(), venue: v?.name ?? null, venueId: v?.id ?? null, opponent: null, homeAway: null, competition: null, cancelReason: null, location: { id: l.id, name: l.name, timeZone: l.timeZone }, team: { id: t.id, name: t.name, kind: t.kind, coach: t.coach }, programme: { id: t.programmeId, name: '' }, youCoach: t.youCoach, rosterCount: 0, attendance: { recorded: 0, present: 0, absent: 0, late: 0, excused: 0 }, venueConflict: false, conflicts: [] });
      created++;
    }
    return delay({ created, conflicts: [] });
  },
  async selections(scope) { return delay(db().selections.filter((s) => inScope(scope, s.locationId))); },
  async proposeSelection(input) {
    const d = db();
    const t = d.teams.find((x) => x.id === input.squadTeamId)!;
    d.selections.unshift({ id: nid('sel'), locationId: t.locationId, squadTeamId: t.id, squadName: t.name, title: input.title, notes: input.notes ?? null, status: 'proposed', proposedByName: 'You', decisionNote: null, canDecide: false, participants: input.participants.map((p) => ({ id: p.id, name: d.regs.find((r) => r.participant.id === p.id)?.participant.name ?? '', note: p.note ?? null })), createdAt: new Date().toISOString() });
    return delay(undefined);
  },
  async decideSelection(id, decision, note) {
    const s = db().selections.find((x) => x.id === id)!;
    if (decision === 'reject' && !note) return fail('validation_failed', 'Add a note for the coach when rejecting', 400);
    s.status = decision === 'approve' ? 'approved' : 'rejected';
    s.decisionNote = note ?? null;
    s.canDecide = false;
    return delay(undefined);
  },
  async announcements(scope) { return delay(db().announcements.filter((a) => inScope(scope, a.locationId))); },
  async announce(input) {
    refresh();
    const d = db();
    const t = input.scopeKind === 'team' ? d.teams.find((x) => x.id === input.scopeId) : null;
    const p = input.scopeKind === 'programme' ? d.programmes.find((x) => x.id === input.scopeId) : null;
    const recipientCount = t ? t.rosterCount : p ? p.counts.accepted : 0;
    d.announcements.unshift({ id: nid('ann'), locationId: (t ?? p)!.locationId, scopeKind: input.scopeKind, scopeId: input.scopeId, scopeName: (t ?? p)!.name, title: input.title, body: input.body, recipientCount, createdAt: new Date().toISOString(), createdByName: 'You' });
    return delay({ recipientCount });
  },
  async balances(scope) {
    refresh();
    const d = db();
    const rows: SBalanceRow[] = d.regs.filter((r) => inScope(scope, r.locationId) && r.balance.state !== 'none').map((r) => {
      const l = LOCS.find((x) => x.id === r.locationId)!;
      return { registrationId: r.id, status: r.status, participant: r.participant.name, guardian: r.guardian?.name ?? null, programme: r.programme.name, location: { id: l.id, name: l.name, timeZone: l.timeZone }, plan: r.paymentPlan, listFee: { amount: r.listFeeMinor, currency: r.currency! }, balance: r.balance, instalments: d.inst[r.id] ?? [], adjustments: r.adjustments.map((a) => ({ kind: a.kind, amount: a.amount, reason: a.reason, at: r.createdAt })) };
    });
    return delay({ items: rows, totals: totalsOf(rows) });
  },
  async adjust(registrationId, input) {
    const d = db();
    const r = d.regs.find((x) => x.id === registrationId)!;
    const unpaid = (d.inst[r.id] ?? []).filter((i) => i.status === 'scheduled').sort((a, b) => b.seq - a.seq);
    const outstanding = unpaid.reduce((a, i) => a + i.amount.amount, 0);
    let left = input.waiveAll ? outstanding : input.amountMinor ?? 0;
    if (left <= 0 || left > outstanding) return fail('validation_failed', 'Amount must be between 1 and the outstanding balance', 400);
    r.adjustments.push({ id: nid('adj'), kind: input.kind, amount: { amount: left, currency: r.currency! }, reason: input.reason });
    for (const i of unpaid) { const take = Math.min(left, i.amount.amount); left -= take; i.amount = { ...i.amount, amount: i.amount.amount - take }; if (!i.amount.amount) i.status = 'waived'; }
    return delay(undefined);
  },
  runReminders: async () => delay({ sent: 3 }),
  async guardians(scope) { return delay({ items: db().rels.filter((r) => inScope(scope, r.participant.locationId)), invitations: [] }); },
  async disputes() { return delay(db().disputes.filter((x) => x.status === 'open')); },
  async resolveDispute(id, outcome, note) {
    const d = db();
    const x = d.disputes.find((y) => y.id === id)!;
    x.status = outcome === 'uphold' ? 'upheld' : 'dismissed';
    x.resolutionNote = note;
    const rel = d.rels.find((r) => r.id === x.relationship.id);
    if (rel) rel.status = outcome === 'uphold' ? 'revoked' : 'verified';
    return delay(undefined);
  },
  async verifyRelationship(id) { const r = db().rels.find((x) => x.id === id); if (r) r.status = 'verified'; return delay(undefined); },
  async threads(scope) { return delay(db().threads.filter((t) => inScope(scope, t.locationId))); },
  async reply(locationId, guardianId, body) { const t = db().threads.find((x) => x.locationId === locationId && x.guardian.id === guardianId); t?.messages.push({ id: nid('m'), direction: 'outbound', body, createdAt: new Date().toISOString() }); if (t) t.unread = 0; return delay(undefined); },
  aiDescription: () => fail('ai_unavailable', 'BranchHarbor AI is unavailable in sample mode. You can write the description yourself.', 503),
  aiEnrolment: () => fail('ai_unavailable', 'BranchHarbor AI is unavailable in sample mode. The numbers below are complete without it.', 503),
};
