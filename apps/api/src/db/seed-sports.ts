/**
 * Sports full-product demo data for North Shore Football Academy (sample data only), layered on the
 * organisation created by seed-operations.ts: seasons with country age conventions (Toronto/Austin birth-year,
 * Manchester school-year), venues with half pitches, fee plans and instalments (paid, upcoming, overdue),
 * sibling discount and financial aid, a registration form with restricted medical/emergency answers,
 * assistant coaches, fixtures with opponents, a cancelled session with notices to that group only,
 * guardian absences, announcements, squad selections (approved + awaiting a director), guardian messages,
 * a second-guardian invitation, an open relationship dispute and a guardian app account.
 *
 * Re-running the main seed recreates the organisation, so this is idempotent.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { splitInstalments } from '@bh/shared';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';

type User = typeof t.users.$inferSelect;
type Loc = typeof t.locations.$inferSelect;

export interface SportsSeedCtx {
  db: Db;
  today: string;
  orgId: string;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
}

const pi = () => `pi_seed_${randomBytes(8).toString('hex')}`;

const PLAN: Record<string, {
  season: { name: string; startsOn: string; endsOn: string; ageRule: 'birth_year' | 'age_on_date'; cutoff: string };
  venues: Array<{ name: string; kind: string; surface: string; halves?: boolean }>;
  plans: Array<{ name: string; kind: 'full' | 'instalments'; schedule: Array<{ dueOn: string; shareBps: number }> }>;
  opponents: string[];
  camp: { name: string; description: string; feeMinor: number; ageMin: number; ageMax: number; capacity: number; status: 'published' | 'draft'; venue: number };
  shirt: string[];
}> = {
  'NS-TOR': {
    season: { name: 'Fall 2026', startsOn: '2026-09-07', endsOn: '2026-12-13', ageRule: 'birth_year', cutoff: '2026-12-31' },
    venues: [{ name: 'Lakeshore Pitch 1', kind: 'pitch', surface: 'Artificial turf', halves: true }, { name: 'Lakeshore Pitch 2', kind: 'pitch', surface: 'Grass' }, { name: 'Lamport Stadium', kind: 'pitch', surface: 'Artificial turf' }, { name: 'Lakeshore Dome', kind: 'hall', surface: 'Indoor turf' }],
    plans: [{ name: 'Pay in full', kind: 'full', schedule: [] }, { name: '3 monthly instalments', kind: 'instalments', schedule: [{ dueOn: '2026-09-01', shareBps: 3334 }, { dueOn: '2026-10-01', shareBps: 3333 }, { dueOn: '2026-11-01', shareBps: 3333 }] }],
    opponents: ['Etobicoke Rangers', 'Scarborough United', 'North York Hearts', 'Mississauga City'],
    camp: { name: 'Winter Futsal Camp', description: 'Five mornings of indoor futsal over the winter break.', feeMinor: 18_000, ageMin: 7, ageMax: 13, capacity: 24, status: 'published', venue: 3 },
    shirt: ['YS', 'YM', 'YL', 'AS'],
  },
  'NS-MAN': {
    season: { name: '2026–27 season', startsOn: '2026-09-01', endsOn: '2027-05-31', ageRule: 'age_on_date', cutoff: '2026-08-31' },
    venues: [{ name: 'Campus Pitch A', kind: 'pitch', surface: '3G', halves: true }, { name: 'Campus Pitch B', kind: 'pitch', surface: 'Grass' }, { name: 'Platt Fields', kind: 'pitch', surface: 'Grass' }],
    plans: [{ name: 'Pay in full', kind: 'full', schedule: [] }, { name: '4 monthly instalments', kind: 'instalments', schedule: [{ dueOn: '2026-09-01', shareBps: 2500 }, { dueOn: '2026-10-01', shareBps: 2500 }, { dueOn: '2026-11-01', shareBps: 2500 }, { dueOn: '2026-12-01', shareBps: 2500 }] }],
    opponents: ['Didsbury Juniors', 'Salford Lads', 'Stockport Town Youth', 'Trafford Rovers'],
    camp: { name: 'Easter Holiday Camp', description: 'Four days of skills, small-sided games and a mini tournament.', feeMinor: 9_500, ageMin: 6, ageMax: 12, capacity: 40, status: 'published', venue: 0 },
    shirt: ['7–8', '9–10', '11–12', 'S'],
  },
  'NS-AUS': {
    season: { name: 'Fall 2026', startsOn: '2026-08-24', endsOn: '2026-12-06', ageRule: 'birth_year', cutoff: '2026-12-31' },
    venues: [{ name: 'Mueller Field 3', kind: 'field', surface: 'Grass', halves: true }, { name: 'Mueller Field 4', kind: 'field', surface: 'Grass' }, { name: 'Q2 Stadium Training Ground', kind: 'field', surface: 'Hybrid grass' }],
    plans: [{ name: 'Pay in full', kind: 'full', schedule: [] }, { name: '2 instalments', kind: 'instalments', schedule: [{ dueOn: '2026-08-15', shareBps: 5000 }, { dueOn: '2026-10-15', shareBps: 5000 }] }],
    opponents: ['Round Rock Lonestar', 'Lonestar Austin Red', 'Hill Country FC', 'San Marcos Strikers'],
    camp: { name: 'Spring Break Camp', description: 'Half-day camp during spring break (dates to be confirmed).', feeMinor: 22_500, ageMin: 6, ageMax: 12, capacity: 30, status: 'draft', venue: 1 },
    shirt: ['YS', 'YM', 'YL', 'AS'],
  },
};

const FORM_QUESTIONS: t.SportsFormQuestion[] = [
  { key: 'shirt_size', label: 'Training shirt size', type: 'select', required: true, options: [], category: 'general' },
  { key: 'school', label: 'School', type: 'text', required: false, category: 'general' },
  { key: 'previous_club', label: 'Previous club (if any)', type: 'text', required: false, category: 'general' },
  { key: 'pickup_contacts', label: 'Who else may collect the participant after sessions?', type: 'textarea', required: false, category: 'emergency', coachVisible: true },
];

export async function seedSports(c: SportsSeedCtx) {
  const { db, today, orgId } = c;
  const now = new Date();
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const byCode = (code: string) => locs.find((l) => l.code === code)!;
  const kim = await c.upsertUser('kim.osei@demo.branchharbor.com', 'Kim Osei');
  const dev = await c.upsertUser('dev.malik@demo.branchharbor.com', 'Dev Malik');
  const tom = await c.upsertUser('tom.hughes@demo.branchharbor.com', 'Tom Hughes', 'en-GB');
  const aisha = await c.upsertUser('aisha.khan@demo.branchharbor.com', 'Aisha Khan', 'en-GB');
  const maria = await c.upsertUser('maria.garza@demo.branchharbor.com', 'Maria Garza');
  const riley = await c.upsertUser('riley.park@demo.branchharbor.com', 'Riley Park');
  const demo = (await db.select().from(t.users).where(eq(t.users.email, 'demo@branchharbor.com')))[0]!;
  await db.insert(t.roleAssignments).values([{ organizationId: orgId, userId: dev.id, role: 'staff', scopeKind: 'location', scopeId: byCode('NS-TOR').id }]).onConflictDoNothing();

  for (const [code, plan] of Object.entries(PLAN)) {
    const loc = byCode(code);
    const at = (date: string, time: string) => zonedToUtc(date, time, loc.timeZone);
    // Season (parent of programmes) with the location's age convention.
    const [season] = await db.insert(t.seasons).values({ organizationId: orgId, locationId: loc.id, name: plan.season.name, startsOn: plan.season.startsOn, endsOn: plan.season.endsOn, ageRule: plan.season.ageRule, ageCutoffDate: plan.season.cutoff, status: 'published' }).returning();
    // Venues (+ halves of the main pitch, which clash with the whole pitch).
    const venues: Array<typeof t.sportsVenues.$inferSelect> = [];
    for (const v of plan.venues) {
      const [row] = await db.insert(t.sportsVenues).values({ organizationId: orgId, locationId: loc.id, name: v.name, kind: v.kind, surface: v.surface }).returning();
      venues.push(row!);
      if (v.halves) {
        const halves = await db.insert(t.sportsVenues).values(['half A', 'half B'].map((h) => ({ organizationId: orgId, locationId: loc.id, name: `${v.name} — ${h}`, kind: v.kind, surface: v.surface, parentVenueId: row!.id }))).returning();
        venues.push(...halves);
      }
    }
    const venueByName = new Map(venues.map((v) => [v.name, v]));
    const [form] = await db.insert(t.sportsRegistrationForms).values({ organizationId: orgId, locationId: loc.id, name: `${loc.name} registration`, questions: FORM_QUESTIONS.map((q) => (q.key === 'shirt_size' ? { ...q, options: plan.shirt } : q)), createdBy: demo.id }).returning();

    const [prog] = await db.select().from(t.programmes).where(eq(t.programmes.locationId, loc.id));
    const opens = new Date(`${addDays(plan.season.startsOn, -60)}T12:00:00Z`);
    const closes = new Date(`${addDays(plan.season.endsOn, -30)}T23:00:00Z`);
    await db.update(t.programmes).set({
      seasonId: season!.id, ageRule: plan.season.ageRule, ageCutoffDate: plan.season.cutoff, kind: 'academy', venueIds: venues.filter((v) => !v.parentVenueId).map((v) => v.id), siblingDiscountBps: 1000,
      registrationFormId: form!.id, registrationOpensAt: opens, registrationClosesAt: closes, refundPolicyVersion: '2026-06-01', eligibilityNotes: 'All abilities welcome. Players are placed in groups by age; trials are not required.',
      refundPolicy: 'Full refund if you withdraw before the first session. After that, unpaid instalments are cancelled and paid amounts are refunded pro rata for unused weeks, minus a 10% administration fee.',
      description: `Two coached training sessions a week plus weekend fixtures at ${loc.name}. Places are confirmed after review.`,
    }).where(eq(t.programmes.id, prog!.id));
    const plans = await db.insert(t.sportsFeePlans).values(plan.plans.map((p) => ({ organizationId: orgId, programmeId: prog!.id, name: p.name, kind: p.kind, schedule: p.schedule }))).returning();
    const instPlan = plans.find((p) => p.kind === 'instalments')!;
    const fullPlan = plans.find((p) => p.kind === 'full')!;

    // Camp/holiday programme in the same season (catalogue variety; Austin's is still a draft).
    const [camp] = await db.insert(t.programmes).values({
      organizationId: orgId, locationId: loc.id, seasonId: season!.id, name: plan.camp.name, description: plan.camp.description, kind: 'camp', ageMin: plan.camp.ageMin, ageMax: plan.camp.ageMax, ageRule: plan.season.ageRule, ageCutoffDate: plan.season.cutoff,
      capacity: plan.camp.capacity, feeMinor: plan.camp.feeMinor, currency: loc.currency, requiresApproval: false, refundPolicy: 'Full refund up to 14 days before the camp starts; no refunds afterwards unless the camp is cancelled.', refundPolicyVersion: '2026-06-01',
      registrationOpensAt: new Date(now.getTime() - 7 * 86400_000), registrationClosesAt: new Date(now.getTime() + 60 * 86400_000), status: plan.camp.status, venueIds: [venues.filter((v) => !v.parentVenueId)[plan.camp.venue]!.id], siblingDiscountBps: 500, registrationFormId: form!.id,
    }).returning();
    await db.insert(t.sportsFeePlans).values({ organizationId: orgId, programmeId: camp!.id, name: 'Pay in full', kind: 'full', schedule: [] });
    await db.insert(t.teams).values([{ organizationId: orgId, locationId: loc.id, programmeId: camp!.id, seasonId: season!.id, name: 'Camp group A', capacity: Math.ceil(plan.camp.capacity / 2), kind: 'group' }, { organizationId: orgId, locationId: loc.id, programmeId: camp!.id, seasonId: season!.id, name: 'Camp group B', capacity: Math.floor(plan.camp.capacity / 2), kind: 'group' }]);

    // Teams: season link, home venue, assistant coaches; a squad for selections.
    const teams = await db.select().from(t.teams).where(eq(t.teams.programmeId, prog!.id));
    for (const [i, team] of teams.entries()) {
      await db.update(t.teams).set({ seasonId: season!.id, homeVenueId: venues.filter((v) => !v.parentVenueId)[i % 2]!.id }).where(eq(t.teams.id, team.id));
    }
    if (code === 'NS-TOR') {
      await db.update(t.teams).set({ coachUserId: dev.id }).where(and(eq(t.teams.programmeId, prog!.id), eq(t.teams.name, 'U12 Blue')));
      await db.insert(t.sportsTeamCoaches).values([{ organizationId: orgId, teamId: teams.find((x) => x.name === 'U10 Blue')!.id, userId: dev.id, role: 'assistant' }, { organizationId: orgId, teamId: teams.find((x) => x.name === 'U14 Navy')!.id, userId: kim.id, role: 'assistant' }]);
      // U14 Navy had no head coach in the first-release seed.
      await db.update(t.teams).set({ coachUserId: dev.id }).where(and(eq(t.teams.programmeId, prog!.id), eq(t.teams.name, 'U14 Navy')));
    }
    if (code === 'NS-MAN') await db.insert(t.sportsTeamCoaches).values({ organizationId: orgId, teamId: teams[0]!.id, userId: aisha.id, role: 'assistant' });
    const [squad] = await db.insert(t.teams).values({ organizationId: orgId, locationId: loc.id, programmeId: prog!.id, seasonId: season!.id, name: `${code === 'NS-MAN' ? 'Manchester' : code === 'NS-TOR' ? 'Toronto' : 'Austin'} Cup Squad`, kind: 'squad', capacity: 14, coachUserId: code === 'NS-TOR' ? kim.id : code === 'NS-MAN' ? tom.id : maria.id }).returning();

    // Sessions: link venues by name; fixtures get opponents; one upcoming session cancelled.
    const sessions = await db.select().from(t.trainingSessions).where(eq(t.trainingSessions.locationId, loc.id)).orderBy(t.trainingSessions.startsAt);
    let oi = 0;
    for (const s of sessions) {
      const v = s.venue ? venueByName.get(s.venue) : undefined;
      const fixture = s.kind === 'fixture';
      await db.update(t.trainingSessions).set({
        venueId: v?.id ?? null, ...(fixture ? { opponent: plan.opponents[oi++ % plan.opponents.length], homeAway: oi % 3 === 0 ? 'away' : 'home', competition: code === 'NS-MAN' ? 'Manchester Junior League' : 'Fall League' } : {}),
        ...(fixture && oi % 3 === 0 ? { venue: `${plan.opponents[(oi - 1) % plan.opponents.length]} ground`, venueId: null } : {}),
      }).where(eq(t.trainingSessions.id, s.id));
    }
    const future = sessions.filter((s) => s.startsAt > now && s.kind === 'training');
    const toCancel = future[2];
    const regs = await db.select().from(t.registrations).where(eq(t.registrations.programmeId, prog!.id));
    if (toCancel) {
      await db.update(t.trainingSessions).set({ status: 'cancelled', cancelledAt: now, cancelReason: code === 'NS-MAN' ? 'Pitch waterlogged after heavy rain' : 'Venue closed for maintenance' }).where(eq(t.trainingSessions.id, toCancel.id));
      const affected = regs.filter((r) => r.teamId === toCancel.teamId && r.status === 'accepted');
      const l = localDateParts(toCancel.startsAt, loc.timeZone);
      const teamName = teams.find((x) => x.id === toCancel.teamId)!.name;
      if (affected.length) await db.insert(t.sportsNotifications).values(affected.filter((r) => r.guardianCustomerId).map((r) => ({ organizationId: orgId, locationId: loc.id, guardianCustomerId: r.guardianCustomerId!, participantCustomerId: r.participantCustomerId, kind: 'session_cancelled', channel: 'email', status: 'logged', subject: `${teamName}: training cancelled (${l.date})`, body: `${teamName}'s training on ${l.date} at ${l.time} is cancelled.`, refType: 'training_session', refId: toCancel.id })));
    }

    // Registrations: fees, plans, instalments, payments, answers, consent.
    for (const [i, r] of regs.entries()) {
      const usesInst = i % 3 !== 0;
      const fee = prog!.feeMinor;
      const discount = i === 4 ? Math.floor(fee * 0.1) : 0;
      const total = fee - discount;
      await db.update(t.registrations).set({ paymentPlan: usesInst ? 'instalments' : 'full', feePlanId: usesInst ? instPlan.id : fullPlan.id, listFeeMinor: fee, totalFeeMinor: total, currency: loc.currency, refundPolicyAcceptedAt: new Date(`${plan.season.startsOn}T12:00:00Z`), refundPolicyVersion: '2026-06-01', forms: { shirt_size: plan.shirt[i % plan.shirt.length], school: ['Bloor CI', 'St. Mary’s', 'Lakeside PS', null][i % 4] ?? undefined, photo_consent: i % 5 !== 0, _formVersion: 1 } }).where(eq(t.registrations.id, r.id));
      if (discount) await db.insert(t.sportsFeeAdjustments).values({ organizationId: orgId, registrationId: r.id, kind: 'sibling_discount', amountMinor: discount, currency: loc.currency, reason: 'Sibling discount (10%)' });
      if (r.guardianCustomerId) await db.insert(t.consentRecords).values({ organizationId: orgId, customerId: r.guardianCustomerId, purpose: 'sports_absence_alerts', version: '2026-10', granted: i % 7 !== 3, source: 'registration' });
      if (r.status === 'accepted' || r.status === 'awaiting_review') {
        await db.insert(t.sportsRestrictedAnswers).values({
          organizationId: orgId, locationId: loc.id, registrationId: r.id, participantCustomerId: r.participantCustomerId, formId: form!.id, formVersion: 1, coachVisibleKeys: ['emergency_contact_name', 'emergency_contact_phone', 'medical_action_plan', 'pickup_contacts'],
          answers: { emergency_contact_name: ['Sam', 'Alex', 'Jamie', 'Robin', 'Chris', 'Taylor'][i % 6]!, emergency_contact_phone: code === 'NS-MAN' ? `+44 161 496 0${String(100 + i).slice(-3)}` : `+1 ${code === 'NS-AUS' ? '512' : '416'} 555 0${String(100 + i).slice(-3)}`, ...(i % 6 === 2 ? { medical_notes: 'Sample record: asthma — reliever inhaler kept in kit bag', medical_action_plan: 'Sample: allow inhaler use; call guardian if symptoms continue' } : {}), ...(i % 4 === 1 ? { pickup_contacts: 'Grandparent (sample)' } : {}) },
        });
        const lines = usesInst ? splitInstalments(total, instPlan.schedule) : splitInstalments(total, [{ dueOn: plan.season.startsOn < today ? addDays(plan.season.startsOn, -10) : today, shareBps: 10_000 }]);
        for (const l of lines) {
          // Paid: the first instalment always; later ones mostly paid when due, a few overdue (unpaid) for the balances demo.
          const due = l.dueOn <= today;
          const paid = l.seq === 1 || (due && i % 5 !== 1);
          const [inst] = await db.insert(t.sportsInstalments).values({ organizationId: orgId, locationId: loc.id, registrationId: r.id, seq: l.seq, dueOn: l.dueOn, amountMinor: l.amountMinor, currency: loc.currency, status: paid ? 'paid' : 'scheduled', paidAt: paid ? new Date(`${l.dueOn}T15:00:00Z`) : null, remindersSent: !paid && due ? 2 : 0, lastReminderStage: !paid && due ? 'due' : null, lastReminderAt: !paid && due ? now : null }).returning();
          if (paid) {
            const [p] = await db.insert(t.paymentReferences).values({ organizationId: orgId, locationId: loc.id, provider: 'stripe', externalId: pi(), connectedAccountId: loc.stripeAccountId, amountMinor: l.amountMinor, currency: loc.currency, applicationFeeMinor: Math.floor(l.amountMinor / 100), state: 'succeeded', succeededAt: new Date(`${l.dueOn}T15:00:00Z`), targetType: 'registration', targetId: r.id, sandbox: 1 }).returning();
            await db.update(t.sportsInstalments).set({ paymentId: p!.id, paymentAttempts: 1 }).where(eq(t.sportsInstalments.id, inst!.id));
            if (l.seq === 1) await db.update(t.registrations).set({ paymentId: p!.id }).where(eq(t.registrations.id, r.id));
          }
        }
        if (i === 7) {
          // Financial aid on a family's remaining balance.
          const unpaid = await db.select().from(t.sportsInstalments).where(and(eq(t.sportsInstalments.registrationId, r.id), eq(t.sportsInstalments.status, 'scheduled')));
          const last = unpaid.sort((a, b) => b.seq - a.seq)[0];
          if (last) {
            const aid = Math.min(last.amountMinor, Math.floor(fee / 4));
            await db.update(t.sportsInstalments).set({ amountMinor: last.amountMinor - aid, status: last.amountMinor - aid === 0 ? 'waived' : 'scheduled' }).where(eq(t.sportsInstalments.id, last.id));
            await db.update(t.registrations).set({ totalFeeMinor: total - aid }).where(eq(t.registrations.id, r.id));
            await db.insert(t.sportsFeeAdjustments).values({ organizationId: orgId, registrationId: r.id, kind: 'financial_aid', amountMinor: aid, currency: loc.currency, reason: 'Community access fund (sample)', createdBy: demo.id });
          }
        }
      }
    }

    // Guardian-reported absences for the next sessions, and reasons on some past absences.
    const upcoming = sessions.filter((s) => s.startsAt > now && s.id !== toCancel?.id).slice(0, 4);
    for (const [k, s] of upcoming.entries()) {
      const r = regs.find((x) => x.teamId === s.teamId && x.status === 'accepted' && regs.indexOf(x) % 4 === k % 4);
      if (r) await db.insert(t.attendance).values({ organizationId: orgId, locationId: loc.id, sessionId: s.id, participantCustomerId: r.participantCustomerId, status: 'excused', absenceReason: ['illness', 'school', 'family', 'travel'][k % 4]!, note: ['Fever since yesterday', 'School concert', 'Grandparent visiting', 'Away for the weekend'][k % 4]!, reportedBy: 'guardian' }).onConflictDoNothing();
    }
    const pastSessionIds = sessions.filter((s) => s.startsAt < now).map((s) => s.id);
    if (pastSessionIds.length) await db.update(t.attendance).set({ absenceReason: 'illness', note: 'Reported by guardian after the session' }).where(and(inArray(t.attendance.sessionId, pastSessionIds), eq(t.attendance.status, 'absent')));

    // Squad selection: one approved (members), one proposed and waiting for a director.
    const accepted = regs.filter((r) => r.status === 'accepted');
    const coachOf = code === 'NS-TOR' ? kim : code === 'NS-MAN' ? tom : maria;
    const [approved] = await db.insert(t.sportsSelections).values({ organizationId: orgId, locationId: loc.id, squadTeamId: squad!.id, title: 'Autumn invitational squad', notes: 'Players who attended every session in September and asked to play the tournament.', status: 'approved', proposedBy: coachOf.id, decidedBy: code === 'NS-MAN' ? aisha.id : demo.id, decidedAt: new Date(now.getTime() - 5 * 86400_000), decisionNote: 'Approved — families informed.' }).returning();
    const picks = accepted.slice(0, 5);
    if (picks.length) {
      await db.insert(t.sportsSelectionEntries).values(picks.map((r) => ({ organizationId: orgId, selectionId: approved!.id, participantCustomerId: r.participantCustomerId, note: 'Attended all September sessions' })));
      await db.insert(t.sportsSquadMembers).values(picks.map((r) => ({ organizationId: orgId, teamId: squad!.id, participantCustomerId: r.participantCustomerId, selectionId: approved!.id })));
    }
    const [proposed] = await db.insert(t.sportsSelections).values({ organizationId: orgId, locationId: loc.id, squadTeamId: squad!.id, title: 'Winter indoor cup', notes: 'Proposed from players who signed up for the indoor cup list.', status: 'proposed', proposedBy: coachOf.id }).returning();
    const more = accepted.slice(5, 9);
    if (more.length) await db.insert(t.sportsSelectionEntries).values(more.map((r) => ({ organizationId: orgId, selectionId: proposed!.id, participantCustomerId: r.participantCustomerId, note: 'On the indoor cup sign-up list' })));
    // Squad training on Fridays.
    for (let d = 1; d <= 14; d++) {
      const date = addDays(today, d);
      if (weekdayOf(date) !== 5) continue;
      const startsAt = at(date, '18:00');
      await db.insert(t.trainingSessions).values({ organizationId: orgId, locationId: loc.id, teamId: squad!.id, startsAt, endsAt: new Date(startsAt.getTime() + 75 * 60_000), venue: venues[0]!.name, venueId: venues[0]!.id, kind: 'training' });
    }

    // Announcements (team + programme) with delivery rows for those groups only.
    const firstTeam = teams[0]!;
    const teamRegs = accepted.filter((r) => r.teamId === firstTeam.id && r.guardianCustomerId);
    const [a1] = await db.insert(t.sportsAnnouncements).values({ organizationId: orgId, locationId: loc.id, scopeKind: 'team', scopeId: firstTeam.id, title: 'New kit collection', body: 'Training kits are ready to collect from reception before Thursday’s session.', createdBy: coachOf.id, recipientCount: teamRegs.length, createdAt: new Date(now.getTime() - 2 * 86400_000) }).returning();
    if (teamRegs.length) await db.insert(t.sportsNotifications).values(teamRegs.map((r) => ({ organizationId: orgId, locationId: loc.id, guardianCustomerId: r.guardianCustomerId!, participantCustomerId: r.participantCustomerId, kind: 'announcement', channel: 'email', status: 'logged', subject: `${firstTeam.name}: New kit collection`, body: a1!.body, refType: 'announcement', refId: a1!.id, createdAt: a1!.createdAt })));
    const progRegs = accepted.filter((r) => r.guardianCustomerId);
    const [a2] = await db.insert(t.sportsAnnouncements).values({ organizationId: orgId, locationId: loc.id, scopeKind: 'programme', scopeId: prog!.id, title: 'Half-term schedule', body: 'There is no training during the school break week. Fixtures continue as listed in the portal.', createdBy: code === 'NS-MAN' ? aisha.id : demo.id, recipientCount: progRegs.length, createdAt: new Date(now.getTime() - 6 * 86400_000) }).returning();
    if (progRegs.length) await db.insert(t.sportsNotifications).values(progRegs.map((r) => ({ organizationId: orgId, locationId: loc.id, guardianCustomerId: r.guardianCustomerId!, participantCustomerId: r.participantCustomerId, kind: 'announcement', channel: 'email', status: 'logged', subject: `${prog!.name}: Half-term schedule`, body: a2!.body, refType: 'announcement', refId: a2!.id, createdAt: a2!.createdAt })));

    // Guardian messages (one thread per location).
    const g = accepted.find((r) => r.guardianCustomerId)?.guardianCustomerId;
    if (g) {
      await db.insert(t.sportsMessages).values([
        { organizationId: orgId, locationId: loc.id, guardianCustomerId: g, direction: 'inbound', body: 'Hi — is there parking near the pitch on Saturdays?', createdAt: new Date(now.getTime() - 26 * 3600_000), readAt: new Date(now.getTime() - 25 * 3600_000) },
        { organizationId: orgId, locationId: loc.id, guardianCustomerId: g, direction: 'outbound', authorUserId: code === 'NS-MAN' ? aisha.id : demo.id, body: 'Yes, the north car park is free for families on match days.', createdAt: new Date(now.getTime() - 25 * 3600_000) },
        { organizationId: orgId, locationId: loc.id, guardianCustomerId: g, direction: 'inbound', body: 'Thanks! Also, can my child move to the earlier group next month?', createdAt: new Date(now.getTime() - 3 * 3600_000) },
      ]);
    }

    // Manchester: an open relationship dispute (a third person claims to be a guardian).
    if (code === 'NS-MAN' && accepted[1]) {
      const [claimant] = await db.insert(t.customers).values({ organizationId: orgId, locationId: loc.id, name: 'Jordan Mills (sample)', email: 'jordan.mills.sample@example.com' }).returning();
      const [rel] = await db.insert(t.guardianRelationships).values({ organizationId: orgId, guardianCustomerId: claimant!.id, participantCustomerId: accepted[1].participantCustomerId, relationship: 'step-parent', status: 'disputed' }).returning();
      await db.insert(t.sportsRelationshipDisputes).values({ organizationId: orgId, relationshipId: rel!.id, participantCustomerId: accepted[1].participantCustomerId, raisedByCustomerId: accepted[1].guardianCustomerId, reason: 'I did not authorise this person to see my child’s schedule.', previousStatus: 'verified' });
    }
  }

  // ───────────── Riley Park: guardian app account with two children in Toronto (sibling discount, instalments, one overdue) ─────────────
  const tor = byCode('NS-TOR');
  const [torProg] = await db.select().from(t.programmes).where(and(eq(t.programmes.locationId, tor.id), eq(t.programmes.kind, 'academy')));
  const torTeams = await db.select().from(t.teams).where(eq(t.teams.programmeId, torProg!.id));
  const [instPlan] = await db.select().from(t.sportsFeePlans).where(and(eq(t.sportsFeePlans.programmeId, torProg!.id), eq(t.sportsFeePlans.kind, 'instalments')));
  const [rileyC] = await db.insert(t.customers).values({ organizationId: orgId, locationId: tor.id, userId: riley.id, name: 'Riley Park', email: riley.email, phone: '+1 416 555 0142' }).returning();
  const [casey] = await db.insert(t.customers).values({ organizationId: orgId, locationId: tor.id, name: 'Casey Park', email: 'casey.park.sample@example.com' }).returning();
  await db.insert(t.consentRecords).values({ organizationId: orgId, customerId: rileyC!.id, purpose: 'sports_absence_alerts', version: '2026-10', granted: true, source: 'registration' });
  const kids = [{ name: 'Mia Park', dob: '2017-05-14', team: 'U10 Blue' }, { name: 'Owen Park', dob: '2015-02-03', team: 'U12 Blue' }];
  for (const [k, kid] of kids.entries()) {
    const [child] = await db.insert(t.customers).values({ organizationId: orgId, locationId: tor.id, name: kid.name, dateOfBirth: kid.dob }).returning();
    await db.insert(t.guardianRelationships).values([
      { organizationId: orgId, guardianCustomerId: rileyC!.id, participantCustomerId: child!.id, relationship: 'parent', status: 'verified', verifiedAt: now },
      ...(k === 0 ? [{ organizationId: orgId, guardianCustomerId: casey!.id, participantCustomerId: child!.id, relationship: 'parent', status: 'verified', verifiedAt: now }] : []),
    ]);
    const team = torTeams.find((x) => x.name === kid.team)!;
    const discount = k === 1 ? Math.floor(torProg!.feeMinor * 0.1) : 0;
    const total = torProg!.feeMinor - discount;
    const [reg] = await db.insert(t.registrations).values({ organizationId: orgId, locationId: tor.id, programmeId: torProg!.id, participantCustomerId: child!.id, guardianCustomerId: rileyC!.id, status: 'accepted', teamId: team.id, paymentPlan: 'instalments', feePlanId: instPlan!.id, listFeeMinor: torProg!.feeMinor, totalFeeMinor: total, currency: 'CAD', refundPolicyAcceptedAt: new Date('2026-08-20T14:00:00Z'), refundPolicyVersion: '2026-06-01', forms: { shirt_size: k === 0 ? 'YM' : 'YL', school: 'Lakeside PS', photo_consent: true, _formVersion: 1 }, reviewedBy: kim.id }).returning();
    if (discount) await db.insert(t.sportsFeeAdjustments).values({ organizationId: orgId, registrationId: reg!.id, kind: 'sibling_discount', amountMinor: discount, currency: 'CAD', reason: 'Sibling discount (10%)' });
    await db.insert(t.sportsRestrictedAnswers).values({ organizationId: orgId, locationId: tor.id, registrationId: reg!.id, participantCustomerId: child!.id, coachVisibleKeys: ['emergency_contact_name', 'emergency_contact_phone', 'medical_action_plan', 'pickup_contacts'], answers: { emergency_contact_name: 'Casey Park', emergency_contact_phone: '+1 416 555 0143', ...(k === 0 ? { medical_notes: 'Sample record: mild hay fever', pickup_contacts: 'Grandma Lee (sample)' } : {}) } });
    const lines = splitInstalments(total, instPlan!.schedule);
    for (const l of lines) {
      const paid = l.seq === 1 || (l.seq === 2 && k === 1);
      const [inst] = await db.insert(t.sportsInstalments).values({ organizationId: orgId, locationId: tor.id, registrationId: reg!.id, seq: l.seq, dueOn: l.dueOn, amountMinor: l.amountMinor, currency: 'CAD', status: paid ? 'paid' : 'scheduled', paidAt: paid ? new Date(`${l.dueOn}T15:00:00Z`) : null, lastReminderStage: !paid && l.dueOn <= today ? 'due' : null, remindersSent: !paid && l.dueOn <= today ? 1 : 0 }).returning();
      if (paid) {
        const [p] = await db.insert(t.paymentReferences).values({ organizationId: orgId, locationId: tor.id, provider: 'stripe', externalId: pi(), connectedAccountId: tor.stripeAccountId, amountMinor: l.amountMinor, currency: 'CAD', applicationFeeMinor: Math.floor(l.amountMinor / 100), state: 'succeeded', succeededAt: new Date(`${l.dueOn}T15:00:00Z`), targetType: 'registration', targetId: reg!.id, sandbox: 1 }).returning();
        await db.update(t.sportsInstalments).set({ paymentId: p!.id, paymentAttempts: 1 }).where(eq(t.sportsInstalments.id, inst!.id));
      }
    }
    if (k === 0) {
      await db.insert(t.sportsNotifications).values({ organizationId: orgId, locationId: tor.id, guardianCustomerId: rileyC!.id, participantCustomerId: child!.id, kind: 'instalment_reminder', channel: 'email', status: 'logged', subject: 'Due: Youth Academy — Fall 2026 instalment 2', body: 'Instalment 2 for Youth Academy — Fall 2026 at Toronto Lakeshore was due. You can pay it from the guardian portal.', refType: 'registration', refId: reg!.id, createdAt: new Date(now.getTime() - 86400_000) });
    }
  }
  await db.insert(t.sportsGuardianInvitations).values({ organizationId: orgId, participantCustomerId: (await db.select().from(t.customers).where(and(eq(t.customers.organizationId, orgId), eq(t.customers.name, 'Owen Park'))))[0]!.id, invitedByCustomerId: rileyC!.id, name: 'Casey Park', email: 'casey.park.sample@example.com', relationship: 'parent', tokenHash: sha256(`seed-invite-${randomBytes(6).toString('hex')}`), expiresAt: new Date(now.getTime() + 5 * 86400_000) });
  await db.insert(t.sportsMessages).values([
    { organizationId: orgId, locationId: tor.id, guardianCustomerId: rileyC!.id, direction: 'inbound', body: 'Mia has a school trip on the 30th — she will miss training.', createdAt: new Date(now.getTime() - 50 * 3600_000), readAt: new Date(now.getTime() - 49 * 3600_000) },
    { organizationId: orgId, locationId: tor.id, guardianCustomerId: rileyC!.id, direction: 'outbound', authorUserId: kim.id, body: 'Thanks Riley — you can also mark it in the portal so the coach sees it on the roster.', createdAt: new Date(now.getTime() - 48 * 3600_000) },
  ]);
  return { users: [dev.email, riley.email], guardianLogin: riley.email };
}
