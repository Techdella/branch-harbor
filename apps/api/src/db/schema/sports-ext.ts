/**
 * Sports — full product tables (venues, fee plans, instalments, forms with restricted answers, guardian
 * invitations/disputes/portal sessions, transfers, selections, announcements, notifications, messages,
 * schedule proposals). Core sports tables (programmes, seasons, teams, registrations, training_sessions,
 * attendance) live in verticals.ts.
 */
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { customers, guardianRelationships } from './crm.ts';
import { programmes, registrations, teams, trainingSessions } from './verticals.ts';

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

/** Pitches, courts and halls are schedulable resources. A sub-venue (half pitch) clashes with its parent. */
export const sportsVenues = pgTable('sports_venues', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('pitch'), // pitch | court | hall | field | pool | other
  surface: text('surface'),
  parentVenueId: uuid('parent_venue_id'),
  capacityNote: text('capacity_note'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index('sports_venues_location_idx').on(t.locationId)]);

/** Assistant coaches (the head coach is teams.coach_user_id). */
export const sportsTeamCoaches = pgTable('sports_team_coaches', {
  id: pk(),
  organizationId: org(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull().default('assistant'), // head | assistant
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sports_team_coaches_uq').on(t.teamId, t.userId)]);

export interface SportsPlanStep { dueOn: string; shareBps: number }

/** Payment options offered for a programme: pay in full, or an instalment schedule. */
export const sportsFeePlans = pgTable('sports_fee_plans', {
  id: pk(),
  organizationId: org(),
  programmeId: uuid('programme_id').notNull().references(() => programmes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // full | instalments
  /** For instalments: due dates and shares. The first step is charged at registration. */
  schedule: jsonb('schedule').$type<SportsPlanStep[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export interface SportsFormQuestion {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'yes_no' | 'select' | 'phone' | 'date' | 'consent';
  required: boolean;
  options?: string[];
  /** general → stored with the registration; medical/emergency → restricted store (never in AI context). */
  category: 'general' | 'medical' | 'emergency' | 'consent';
  /** Restricted answers coaches may see for their own players (e.g. emergency phone, allergy action plan). */
  coachVisible?: boolean;
  help?: string;
}

/** Registration form builder. Editing questions bumps the version; answers record the version they used. */
export const sportsRegistrationForms = pgTable('sports_registration_forms', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  questions: jsonb('questions').$type<SportsFormQuestion[]>().notNull().default([]),
  status: text('status').notNull().default('active'), // active | archived
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Medical and emergency answers, kept apart from the registration so ordinary listings, exports to
 * coaches and AI context never include them. Every read is audited.
 */
export const sportsRestrictedAnswers = pgTable('sports_restricted_answers', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  formId: uuid('form_id'),
  formVersion: integer('form_version'),
  answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
  /** Keys a coach of the participant's team may see. */
  coachVisibleKeys: jsonb('coach_visible_keys').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('sports_restricted_answers_reg_uq').on(t.registrationId)]);

/** One row per instalment (a pay-in-full registration has a single instalment). */
export const sportsInstalments = pgTable('sports_instalments', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  dueOn: date('due_on').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  /** scheduled | paid | waived | cancelled (due/overdue are derived from dueOn on read) */
  status: text('status').notNull().default('scheduled'),
  paymentId: uuid('payment_id'),
  paymentAttempts: integer('payment_attempts').notNull().default(0),
  paidAt: ts('paid_at'),
  remindersSent: integer('reminders_sent').notNull().default(0),
  lastReminderStage: text('last_reminder_stage'), // upcoming | due | overdue
  lastReminderAt: ts('last_reminder_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('sports_instalments_reg_seq_uq').on(t.registrationId, t.seq), index('sports_instalments_payment_idx').on(t.paymentId), index('sports_instalments_due_idx').on(t.organizationId, t.dueOn)]);

/** Sibling discounts (automatic), financial aid and waivers (admin). Amounts reduce what is still owed. */
export const sportsFeeAdjustments = pgTable('sports_fee_adjustments', {
  id: pk(),
  organizationId: org(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // sibling_discount | financial_aid | waiver
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

/** Second-guardian invitations. Accepting with the emailed token proves the email and verifies the relationship. */
export const sportsGuardianInvitations = pgTable('sports_guardian_invitations', {
  id: pk(),
  organizationId: org(),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  invitedByCustomerId: uuid('invited_by_customer_id').references(() => customers.id, { onDelete: 'set null' }),
  invitedByUserId: uuid('invited_by_user_id'),
  name: text('name'),
  email: text('email').notNull(),
  relationship: text('relationship').notNull().default('parent'),
  tokenHash: text('token_hash').notNull(),
  status: text('status').notNull().default('pending'), // pending | accepted | revoked | expired
  expiresAt: ts('expires_at').notNull(),
  acceptedCustomerId: uuid('accepted_customer_id'),
  acceptedAt: ts('accepted_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sports_guardian_inv_token_uq').on(t.tokenHash)]);

/** A guardian (or staff) disputes someone's relationship to a participant. The relationship is suspended while open. */
export const sportsRelationshipDisputes = pgTable('sports_relationship_disputes', {
  id: pk(),
  organizationId: org(),
  relationshipId: uuid('relationship_id').notNull().references(() => guardianRelationships.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull(),
  raisedByCustomerId: uuid('raised_by_customer_id'),
  raisedByUserId: uuid('raised_by_user_id'),
  reason: text('reason').notNull(),
  /** Relationship status before the dispute, restored when dismissed. */
  previousStatus: text('previous_status').notNull(),
  status: text('status').notNull().default('open'), // open | upheld | dismissed
  resolutionNote: text('resolution_note'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
});

/** Guardian portal on customer websites: emailed sign-in links and the sessions they open (hashes only). */
export const sportsPortalTokens = pgTable('sports_portal_tokens', {
  id: pk(),
  organizationId: org(),
  guardianCustomerId: uuid('guardian_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // link | session
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sports_portal_tokens_hash_uq').on(t.tokenHash)]);

/** Group transfers with history (capacity checked at move time). */
export const sportsTeamMoves = pgTable('sports_team_moves', {
  id: pk(),
  organizationId: org(),
  registrationId: uuid('registration_id').notNull().references(() => registrations.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull(),
  fromTeamId: uuid('from_team_id'),
  toTeamId: uuid('to_team_id'),
  reason: text('reason'),
  movedBy: uuid('moved_by'),
  createdAt: createdAt(),
}, (t) => [index('sports_team_moves_reg_idx').on(t.registrationId)]);

/** Squad selection: a coach proposes, a director approves. Never automated. */
export const sportsSelections = pgTable('sports_selections', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  squadTeamId: uuid('squad_team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  notes: text('notes'),
  status: text('status').notNull().default('proposed'), // proposed | approved | rejected | withdrawn
  proposedBy: uuid('proposed_by').notNull(),
  decidedBy: uuid('decided_by'),
  decisionNote: text('decision_note'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
});

export const sportsSelectionEntries = pgTable('sports_selection_entries', {
  id: pk(),
  organizationId: org(),
  selectionId: uuid('selection_id').notNull().references(() => sportsSelections.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  /** Coach's note (observed, e.g. "attended all trials"). */
  note: text('note'),
}, (t) => [uniqueIndex('sports_selection_entries_uq').on(t.selectionId, t.participantCustomerId)]);

/** Members of squads (team kind = squad), created only by an approved selection. */
export const sportsSquadMembers = pgTable('sports_squad_members', {
  id: pk(),
  organizationId: org(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  selectionId: uuid('selection_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sports_squad_members_uq').on(t.teamId, t.participantCustomerId)]);

export const sportsAnnouncements = pgTable('sports_announcements', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  scopeKind: text('scope_kind').notNull(), // team | programme
  scopeId: uuid('scope_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdBy: uuid('created_by'),
  recipientCount: integer('recipient_count').notNull().default(0),
  createdAt: createdAt(),
});

/**
 * Guardian notifications (also the portal inbox). One row per guardian per event; `status` records
 * whether it was delivered or skipped because the guardian did not consent to that kind.
 */
export const sportsNotifications = pgTable('sports_notifications', {
  id: pk(),
  organizationId: org(),
  locationId: uuid('location_id'),
  guardianCustomerId: uuid('guardian_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id'),
  kind: text('kind').notNull(), // session_cancelled | schedule_changed | absence | announcement | instalment_reminder | registration_status | selection | guardian_invitation
  channel: text('channel').notNull().default('email'), // email | in_app
  status: text('status').notNull(), // sent | logged | skipped_consent | failed
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  refType: text('ref_type'),
  refId: uuid('ref_id'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('sports_notifications_guardian_idx').on(t.guardianCustomerId, t.createdAt), index('sports_notifications_ref_idx').on(t.refType, t.refId)]);

/** Guardian ↔ location conversation (guardians may use the portal without an app account). */
export const sportsMessages = pgTable('sports_messages', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  guardianCustomerId: uuid('guardian_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  direction: text('direction').notNull(), // inbound (guardian) | outbound (staff)
  authorUserId: uuid('author_user_id'),
  body: text('body').notNull(),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('sports_messages_thread_idx').on(t.locationId, t.guardianCustomerId, t.createdAt)]);

/** Proposed schedule changes (rules engine or AI). Nothing changes until someone applies one. */
export const sportsScheduleProposals = pgTable('sports_schedule_proposals', {
  id: pk(),
  organizationId: org(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  source: text('source').notNull(), // rules | ai
  proposal: jsonb('proposal').$type<{ kind: 'move_venue' | 'move_time' | 'move_both'; venueId: string | null; venueName: string | null; startsAt: string; endsAt: string }>().notNull(),
  rationale: text('rationale'),
  status: text('status').notNull().default('proposed'), // proposed | applied | dismissed
  createdBy: uuid('created_by'),
  decidedBy: uuid('decided_by'),
  createdAt: createdAt(),
  decidedAt: ts('decided_at'),
}, (t) => [index('sports_schedule_proposals_session_idx').on(t.sessionId)]);

/** Sessions generated together (weekly training). Times are local wall-clock in the location time zone. */
export const sportsSessionSeries = pgTable('sports_session_series', {
  id: pk(),
  organizationId: org(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  weekdays: jsonb('weekdays').$type<number[]>().notNull(),
  startTime: text('start_time').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  fromDate: date('from_date').notNull(),
  untilDate: date('until_date').notNull(),
  venueId: uuid('venue_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});
