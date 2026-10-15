import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { SplitRule, SurveyAnswer, SurveyQuestion } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, ownerGroups, regions, territories, users } from './core.ts';
import { franchiseAgreements, franchiseProspects } from './franchise.ts';
import { royaltyPeriods } from './finance.ts';

/**
 * Franchise development (packages/shared/src/franchise-dev.ts): satisfaction surveys and validation calls, the
 * agreement lifecycle (transfers, notices, amendments, renewals, development schedules) and master franchise splits.
 * Territory geometry lives on `franchise_territories` (franchise.ts). Money is integer minor units with its currency.
 */

/* ------------------------------ surveys ------------------------------ */

export const franchiseSurveys = pgTable('franchise_surveys', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  questions: jsonb('questions').$type<SurveyQuestion[]>().notNull(),
  anonymous: boolean('anonymous').notNull().default(true),
  minResponses: integer('min_responses').notNull().default(5),
  /** franchise_owners | owners_and_managers */
  audience: text('audience').notNull().default('franchise_owners'),
  /** once | quarterly | semiannual | annual */
  recurrence: text('recurrence').notNull().default('once'),
  openDays: integer('open_days').notNull().default(14),
  /** draft | active | archived */
  status: text('status').notNull().default('draft'),
  /** Next scheduled round (local date); null when none. */
  nextRunOn: date('next_run_on'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_surveys_org_idx').on(t.organizationId, t.status)]);

/** One run of a survey (a quarter, a year…): responses and results belong to a round, trends compare rounds. */
export const franchiseSurveyRounds = pgTable('franchise_survey_rounds', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  surveyId: uuid('survey_id').notNull().references(() => franchiseSurveys.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  opensOn: date('opens_on').notNull(),
  closesOn: date('closes_on').notNull(),
  /** open | closed */
  status: text('status').notNull().default('open'),
  /** People invited when the round opened (for the response rate). */
  invitedCount: integer('invited_count').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('franchise_survey_rounds_uq').on(t.surveyId, t.opensOn)]);

/**
 * A response. Anonymous surveys never store who answered: `respondentKey` is an HMAC of the user and round (one
 * response per person) and only the slice keys (region, owner group) are kept for results above the threshold.
 */
export const franchiseSurveyResponses = pgTable('franchise_survey_responses', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id').notNull().references(() => franchiseSurveyRounds.id, { onDelete: 'cascade' }),
  respondentKey: text('respondent_key').notNull(),
  /** Set only for named (non-anonymous) surveys. */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  regionId: uuid('region_id').references(() => regions.id, { onDelete: 'set null' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  answers: jsonb('answers').$type<Record<string, SurveyAnswer>>().notNull(),
  npsScore: integer('nps_score'),
  submittedAt: ts('submitted_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('franchise_survey_responses_uq').on(t.roundId, t.respondentKey), index('franchise_survey_responses_round_idx').on(t.roundId)]);

/** Action plans HQ commits to after a round (by theme), with an owner and a due date. */
export const franchiseSurveyActions = pgTable('franchise_survey_actions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  surveyId: uuid('survey_id').notNull().references(() => franchiseSurveys.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id').references(() => franchiseSurveyRounds.id, { onDelete: 'set null' }),
  theme: text('theme'),
  title: text('title').notNull(),
  description: text('description'),
  ownerUserId: uuid('owner_user_id'),
  dueOn: date('due_on'),
  /** open | in_progress | done */
  status: text('status').notNull().default('open'),
  /** Shared with the network (shown to respondents with the results summary). */
  shared: boolean('shared').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_survey_actions_survey_idx').on(t.surveyId)]);

/* --------------------------- validation calls --------------------------- */

/** Existing franchisees who opted in to take validation calls from candidates. */
export const franchiseValidators = pgTable('franchise_validators', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  country: text('country'),
  region: text('region'),
  active: boolean('active').notNull().default(true),
  maxCallsPerMonth: integer('max_calls_per_month').notNull().default(4),
  /** What candidates see: a short intro and the validator's own booking link (Calendly etc.), if any. */
  bio: text('bio'),
  schedulingUrl: text('scheduling_url'),
  phone: text('phone'),
  optedInAt: ts('opted_in_at').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('franchise_validators_user_uq').on(t.organizationId, t.userId)]);

export const franchiseValidationCalls = pgTable('franchise_validation_calls', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  validatorId: uuid('validator_id').notNull().references(() => franchiseValidators.id, { onDelete: 'cascade' }),
  /** requested | scheduled | completed | no_show | cancelled */
  status: text('status').notNull().default('requested'),
  scheduledAt: ts('scheduled_at'),
  /** Times the candidate proposed on the scheduling page. */
  proposedTimes: text('proposed_times'),
  completedAt: ts('completed_at'),
  /** positive | neutral | negative: how the call went for the candidate (recorded by HQ or the validator). */
  sentiment: text('sentiment'),
  outcome: text('outcome'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_validation_calls_prospect_idx').on(t.prospectId), index('franchise_validation_calls_validator_idx').on(t.validatorId, t.createdAt)]);

/** The candidate's scheduling page link (one per prospect, single purpose, hash only). */
export const franchiseValidationLinks = pgTable('franchise_validation_links', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  openedAt: ts('opened_at'),
  createdAt: createdAt(),
});

/* ------------------------- agreement lifecycle ------------------------- */

export interface TransferStepState { key: string; done: boolean; doneAt: string | null; doneBy: string | null; note: string | null }

/** Change of franchisee owner: the agreement (and its locations) move to the buyer when the transfer completes. */
export const agreementTransfers = pgTable('agreement_transfers', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  agreementId: uuid('agreement_id').notNull().references(() => franchiseAgreements.id, { onDelete: 'cascade' }),
  fromOwnerGroupId: uuid('from_owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  /** Existing owner group buying, or a prospect who will get a new owner group on completion. */
  toOwnerGroupId: uuid('to_owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  toProspectId: uuid('to_prospect_id').references(() => franchiseProspects.id, { onDelete: 'set null' }),
  buyerName: text('buyer_name').notNull(),
  /** draft | in_review | approved | completed | rejected | cancelled */
  status: text('status').notNull().default('draft'),
  steps: jsonb('steps').$type<TransferStepState[]>().notNull().default([]),
  transferFeeMinor: minor('transfer_fee_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  feePaidAt: ts('fee_paid_at'),
  effectiveDate: date('effective_date'),
  reason: text('reason'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  completedAt: ts('completed_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('agreement_transfers_org_idx').on(t.organizationId, t.status)]);

/** Notices of default, cure reminders, terminations and withdrawals. Issuing needs counsel review recorded first. */
export const agreementNotices = pgTable('agreement_notices', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  agreementId: uuid('agreement_id').notNull().references(() => franchiseAgreements.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  /** The default notice this one follows (cure reminder, termination, withdrawal). */
  parentId: uuid('parent_id'),
  kind: text('kind').notNull(),
  reason: text('reason').notNull(),
  details: text('details').notNull().default(''),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  cureDays: integer('cure_days'),
  cureDeadline: date('cure_deadline'),
  /** draft | issued | cured | escalated | terminated | withdrawn */
  status: text('status').notNull().default('draft'),
  escalationLevel: integer('escalation_level').notNull().default(0),
  counselReviewed: boolean('counsel_reviewed').notNull().default(false),
  counselReviewedBy: uuid('counsel_reviewed_by'),
  counselReviewedAt: ts('counsel_reviewed_at'),
  counselNote: text('counsel_note'),
  issuedAt: ts('issued_at'),
  issuedBy: uuid('issued_by'),
  deliveredTo: text('delivered_to'),
  resolvedAt: ts('resolved_at'),
  resolutionNote: text('resolution_note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('agreement_notices_org_idx').on(t.organizationId, t.status), index('agreement_notices_agreement_idx').on(t.agreementId)]);

/** Amendments: field changes applied to the agreements register when signed. */
export const agreementAmendments = pgTable('agreement_amendments', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  agreementId: uuid('agreement_id').notNull().references(() => franchiseAgreements.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  summary: text('summary'),
  /** Field → new value (endDate, royaltyBps, marketingFundBps, territory, renewalOption). */
  changes: jsonb('changes').$type<Record<string, string | number | null>>().notNull().default({}),
  /** Values before the amendment was applied. */
  previous: jsonb('previous').$type<Record<string, string | number | null>>().notNull().default({}),
  effectiveDate: date('effective_date').notNull(),
  /** draft | signed | cancelled */
  status: text('status').notNull().default('draft'),
  documentId: uuid('document_id'),
  counselReviewed: boolean('counsel_reviewed').notNull().default(false),
  signedAt: ts('signed_at'),
  appliedBy: uuid('applied_by'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('agreement_amendments_agreement_idx').on(t.agreementId)]);

/** Renewal workflow per agreement: the option window, the franchisee's notice, conditions and the decision. */
export const agreementRenewals = pgTable('agreement_renewals', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  agreementId: uuid('agreement_id').notNull().references(() => franchiseAgreements.id, { onDelete: 'cascade' }),
  windowOpensOn: date('window_opens_on').notNull(),
  windowClosesOn: date('window_closes_on').notNull(),
  /** upcoming | window_open | notice_received | approved | declined | renewed | lapsed */
  status: text('status').notNull().default('upcoming'),
  noticeReceivedOn: date('notice_received_on'),
  conditions: jsonb('conditions').$type<Array<{ key: string; done: boolean; doneAt: string | null }>>().notNull().default([]),
  renewalFeeMinor: minor('renewal_fee_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  newTermYears: integer('new_term_years'),
  newAgreementId: uuid('new_agreement_id'),
  decisionNote: text('decision_note'),
  decidedBy: uuid('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('agreement_renewals_agreement_uq').on(t.agreementId)]);

/**
 * Multi-unit development agreement (area developer): open N units by deadlines in the development territories. Linked
 * to the developer's owner group (the access-model area developer scope once it exists).
 */
export const developmentAgreements = pgTable('development_agreements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').notNull().references(() => ownerGroups.id, { onDelete: 'cascade' }),
  /** The access-model territory of the area developer (people with a territory-scope role there see this schedule). */
  scopeTerritoryId: uuid('scope_territory_id').references(() => territories.id, { onDelete: 'set null' }),
  /** The signed development agreement in the register, if any. */
  agreementId: uuid('agreement_id').references(() => franchiseAgreements.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  territoryIds: uuid('territory_ids').array().notNull().default(sql`'{}'::uuid[]`),
  unitsTotal: integer('units_total').notNull(),
  startDate: date('start_date').notNull(),
  /** active | completed | in_default | terminated */
  status: text('status').notNull().default('active'),
  developmentFeeMinor: minor('development_fee_minor').notNull().default(0),
  currency: currencyCol().notNull(),
  notes: text('notes'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('development_agreements_org_idx').on(t.organizationId)]);

export const developmentScheduleItems = pgTable('development_schedule_items', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  developmentAgreementId: uuid('development_agreement_id').notNull().references(() => developmentAgreements.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  label: text('label').notNull(),
  territoryId: uuid('territory_id'),
  signByDate: date('sign_by_date'),
  openByDate: date('open_by_date').notNull(),
  /** pending | signed | opened | missed | waived */
  status: text('status').notNull().default('pending'),
  unitAgreementId: uuid('unit_agreement_id'),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  signedOn: date('signed_on'),
  openedOn: date('opened_on'),
  note: text('note'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('development_schedule_items_uq').on(t.developmentAgreementId, t.sequence)]);

/* --------------------------- master franchise --------------------------- */

/**
 * Master franchise / area representative agreement: the master (an owner group) develops `countries` (optionally
 * narrowed to regions) and receives a share of the royalties and marketing fund billed to units there.
 */
export const masterAgreements = pgTable('master_agreements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').notNull().references(() => ownerGroups.id, { onDelete: 'cascade' }),
  /** The access-model territory (sub-network) the master runs: territory-scope roles there reach this agreement. */
  scopeTerritoryId: uuid('scope_territory_id').references(() => territories.id, { onDelete: 'set null' }),
  /** master_franchisee | area_representative */
  kind: text('kind').notNull().default('master_franchisee'),
  name: text('name').notNull(),
  countries: text('countries').array().notNull(),
  /** Optional narrowing to regions (ISO 3166-2 suffixes, e.g. `ON`). Empty = the whole countries. */
  regions: text('regions').array().notNull().default(sql`'{}'::text[]`),
  /** Where the master is established (its franchisor jurisdiction for disclosure rules). */
  homeCountry: text('home_country').notNull(),
  homeRegion: text('home_region'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date'),
  /** active | suspended | terminated | expired */
  status: text('status').notNull().default('active'),
  splits: jsonb('splits').$type<SplitRule[]>().notNull().default([]),
  /** stripe_transfer | manual */
  payoutMethod: text('payout_method').notNull().default('manual'),
  /** The master's Stripe connected account (receives transfers). */
  stripeAccountId: text('stripe_account_id'),
  /** Optional: the register entry of the signed master agreement. */
  agreementId: uuid('agreement_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('master_agreements_org_idx').on(t.organizationId), index('master_agreements_group_idx').on(t.ownerGroupId)]);

export interface SplitStatementLine {
  locationId: string;
  locationName: string;
  royaltyStatementId: string;
  statementStatus: string;
  royaltyMinor: number;
  marketingFundMinor: number;
  /** Paid on the location's invoice (what the payout is based on). */
  collectedRoyaltyMinor: number;
  collectedFundMinor: number;
  masterRoyaltyMinor: number;
  masterFundMinor: number;
}

/** A split statement per master agreement, royalty period and currency. Payouts are made from collected amounts. */
export const masterSplitStatements = pgTable('master_split_statements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  masterAgreementId: uuid('master_agreement_id').notNull().references(() => masterAgreements.id, { onDelete: 'cascade' }),
  periodId: uuid('period_id').notNull().references(() => royaltyPeriods.id, { onDelete: 'cascade' }),
  currency: currencyCol().notNull(),
  number: text('number').notNull(),
  royaltyShareBps: integer('royalty_share_bps').notNull(),
  fundShareBps: integer('fund_share_bps').notNull(),
  lines: jsonb('lines').$type<SplitStatementLine[]>().notNull().default([]),
  royaltyMinor: minor('royalty_minor').notNull().default(0),
  marketingFundMinor: minor('marketing_fund_minor').notNull().default(0),
  masterRoyaltyMinor: minor('master_royalty_minor').notNull().default(0),
  masterFundMinor: minor('master_fund_minor').notNull().default(0),
  hqRoyaltyMinor: minor('hq_royalty_minor').notNull().default(0),
  hqFundMinor: minor('hq_fund_minor').notNull().default(0),
  /** The master's share of what was actually collected: the amount paid out. */
  payableMinor: minor('payable_minor').notNull().default(0),
  /** draft | approved | paid */
  status: text('status').notNull().default('draft'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  /** stripe_transfer | manual */
  payoutMethod: text('payout_method'),
  transferId: text('transfer_id'),
  payoutReference: text('payout_reference'),
  paidAt: ts('paid_at'),
  paidBy: uuid('paid_by'),
  sandbox: boolean('sandbox').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('master_split_statements_uq').on(t.masterAgreementId, t.periodId, t.currency), index('master_split_statements_org_idx').on(t.organizationId, t.status)]);
