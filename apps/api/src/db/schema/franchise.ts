import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Demographics, JurisdictionRule, ScorePart, TerritoryGeometry } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { brands, locations, organizations, ownerGroups, territories } from './core.ts';

/**
 * Jurisdiction rules. Platform rows (organization_id null) ship with BranchHarbor; an organisation can add its own
 * version of a rule (organization_id set), which wins over the platform row. Versions are never edited in place.
 */
export const franchiseJurisdictionRules = pgTable('franchise_jurisdiction_rules', {
  id: pk(),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  country: text('country').notNull(),
  region: text('region'),
  version: text('version').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  data: jsonb('data').$type<JurisdictionRule>().notNull(),
  reviewedByCounsel: boolean('reviewed_by_counsel').notNull().default(false),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  reviewNote: text('review_note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('franchise_rules_platform_uq').on(t.code, t.version).where(sql`${t.organizationId} is null`),
  uniqueIndex('franchise_rules_org_uq').on(t.organizationId, t.code, t.version).where(sql`${t.organizationId} is not null`),
]);

/** The franchisor's registration / filing status per jurisdiction (e.g. US-CA registered until a date). */
export const franchiseRegistrations = pgTable('franchise_registrations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  jurisdiction: text('jurisdiction').notNull(),
  status: text('status').notNull().default('not_filed'), // not_filed | pending | registered | exempt | expired
  fileNumber: text('file_number'),
  effectiveFrom: ts('effective_from'),
  expiresAt: ts('expires_at'),
  notes: text('notes'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('franchise_registrations_uq').on(t.organizationId, t.jurisdiction)]);

export const franchiseTerritories = pgTable('franchise_territories', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  country: text('country').notNull(),
  region: text('region'),
  description: text('description'),
  status: text('status').notNull().default('available'), // available | reserved | sold | unavailable
  /** Prospect holding a reservation, or the owner group that bought it. */
  reservedForProspectId: uuid('reserved_for_prospect_id'),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  /** Public on the brand site's "Own a franchise" form. */
  showOnSite: boolean('show_on_site').notNull().default(true),
  /** Sub-network (access scope territory) this sales territory belongs to. */
  scopeTerritoryId: uuid('scope_territory_id').references(() => territories.id, { onDelete: 'set null' }),
  /** Brand whose availability map the territory is on (null = the default brand). */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  // Territory map (franchise-dev): drawn area and/or postcode list, exclusivity, demographics and score.
  /** GeoJSON Polygon / MultiPolygon (WGS84 lng/lat). */
  geometry: jsonb('geometry').$type<TerritoryGeometry>(),
  /** Postcodes / ZIP codes (normalised: upper case, no spaces). */
  postcodes: text('postcodes').array().notNull().default(sql`'{}'::text[]`),
  /** exclusive | protected | non_exclusive */
  exclusivity: text('exclusivity').notNull().default('exclusive'),
  centroid: jsonb('centroid').$type<{ lat: number; lng: number }>(),
  demographics: jsonb('demographics').$type<Demographics>(),
  score: integer('score'),
  scoreParts: jsonb('score_parts').$type<ScorePart[]>(),
  /** The agreement that holds the territory (set when signed). */
  agreementId: uuid('agreement_id'),
  /** Master franchise agreement whose master develops this territory. */
  masterAgreementId: uuid('master_agreement_id'),
  statusChangedAt: ts('status_changed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_territories_org_idx').on(t.organizationId)]);

export const franchiseProspects = pgTable('franchise_prospects', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  /** Where the prospect would operate (drives the jurisdiction rules). */
  country: text('country').notNull(),
  region: text('region'),
  city: text('city'),
  territoryId: uuid('territory_id').references(() => franchiseTerritories.id, { onDelete: 'set null' }),
  /** Sub-network (access scope territory) whose pipeline this prospect is in: a master franchisee or area developer works it. */
  scopeTerritoryId: uuid('scope_territory_id').references(() => territories.id, { onDelete: 'set null' }),
  /** The brand the prospect is buying (null = the default brand). */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  desiredTerritory: text('desired_territory'),
  /** Self-declared, minor units in `currency`. Never verified by BranchHarbor. */
  liquidCapitalMinor: minor('liquid_capital_minor'),
  netWorthMinor: minor('net_worth_minor'),
  currency: currencyCol(),
  units: integer('units').notNull().default(1),
  source: text('source').notNull().default('website'),
  campaignId: uuid('campaign_id'),
  attribution: jsonb('attribution').$type<Record<string, string>>().notNull().default({}),
  message: text('message'),
  stage: text('stage').notNull().default('enquiry'),
  stageEnteredAt: ts('stage_entered_at').notNull().defaultNow(),
  ownerUserId: uuid('owner_user_id'),
  lostReason: text('lost_reason'),
  /** Set when the agreement is signed. */
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  locale: text('locale').notNull().default('en'),
  /** Set when the prospect belongs to a master franchisee's pipeline (master_agreements). */
  masterAgreementId: uuid('master_agreement_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_prospects_org_stage_idx').on(t.organizationId, t.stage)]);

export const franchiseActivities = pgTable('franchise_activities', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  /** note | call | email | meeting | stage | disclosure_sent | receipt_signed | agreement_sent | agreement_signed | payment | blocked | task_done | enquiry */
  kind: text('kind').notNull(),
  body: text('body'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  actorUserId: uuid('actor_user_id'),
  createdAt: createdAt(),
}, (t) => [index('franchise_activities_prospect_idx').on(t.prospectId, t.createdAt)]);

export const franchiseEmailTemplates = pgTable('franchise_email_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('franchise_email_templates_uq').on(t.organizationId, t.key)]);

export type CadenceStep = { offsetDays: number; kind: 'email' | 'call' | 'task'; title: string; templateKey?: string; ownerUserId?: string | null };

export const franchiseCadences = pgTable('franchise_cadences', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  name: text('name').notNull(),
  steps: jsonb('steps').$type<CadenceStep[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_cadences_org_stage_idx').on(t.organizationId, t.stage)]);

export const franchiseProjects = pgTable('franchise_projects', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').references(() => franchiseProspects.id, { onDelete: 'set null' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  templateKey: text('template_key').notNull(),
  /** Brand of the new location (its checklist template and brand templates). */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  /** active | go_live_requested | opened | cancelled */
  status: text('status').notNull().default('active'),
  hqOwnerUserId: uuid('hq_owner_user_id'),
  ownerEmail: text('owner_email'),
  ownerInvitationId: uuid('owner_invitation_id'),
  targetOpenDate: date('target_open_date'),
  startedAt: ts('started_at').notNull().defaultNow(),
  approvalId: uuid('approval_id'),
  /** Pre-opening checks: the audit checklist whose audit must pass before HQ approves the opening (null = none). */
  preOpeningTemplateId: uuid('pre_opening_template_id'),
  openedAt: ts('opened_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_projects_org_idx').on(t.organizationId, t.status)]);

/** Pipeline tasks (cadence steps, manual) and onboarding project tasks. */
export const franchiseTasks = pgTable('franchise_tasks', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => franchiseProjects.id, { onDelete: 'cascade' }),
  cadenceId: uuid('cadence_id'),
  /** Idempotency for generated tasks: cadence step index + stage entry, or the template task key. */
  sourceKey: text('source_key'),
  section: text('section'),
  kind: text('kind').notNull().default('task'), // email | call | task
  title: text('title').notNull(),
  templateKey: text('template_key'),
  assignee: text('assignee').notNull().default('hq'), // hq | owner
  ownerUserId: uuid('owner_user_id'),
  gate: boolean('gate').notNull().default(false),
  dueAt: ts('due_at'),
  status: text('status').notNull().default('open'), // open | done | skipped
  remindedAt: ts('reminded_at'),
  completedAt: ts('completed_at'),
  completedBy: uuid('completed_by'),
  createdAt: createdAt(),
}, (t) => [
  index('franchise_tasks_org_due_idx').on(t.organizationId, t.status, t.dueAt),
  uniqueIndex('franchise_tasks_source_uq').on(t.organizationId, t.sourceKey),
]);

/**
 * Documents: disclosure documents (FDD etc.) per jurisdiction, agreement templates, executed agreements and the
 * legal vault. File bytes are stored in the database until object storage is wired (max 8 MB).
 */
export const franchiseDocuments = pgTable('franchise_documents', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** disclosure | agreement_template | executed_agreement | vault */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  version: text('version').notNull().default('1'),
  jurisdictions: text('jurisdictions').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('current'), // draft | current | superseded
  issuedOn: date('issued_on'),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  contentBase64: text('content_base64').notNull(),
  prospectId: uuid('prospect_id'),
  ownerGroupId: uuid('owner_group_id'),
  agreementId: uuid('agreement_id'),
  /** Brand the disclosure document / agreement template belongs to (null = every brand). */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
}, (t) => [index('franchise_documents_org_kind_idx').on(t.organizationId, t.kind)]);

/** A document given to a prospect, with the e-receipt acknowledgement (timestamp, IP, user agent, typed name). */
export const franchiseDeliveries = pgTable('franchise_deliveries', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => franchiseDocuments.id, { onDelete: 'restrict' }),
  kind: text('kind').notNull().default('disclosure'), // disclosure | agreement
  materialChange: boolean('material_change').notNull().default(false),
  method: text('method').notNull().default('email_link'),
  tokenHash: text('token_hash').notNull().unique(),
  deliveredAt: ts('delivered_at').notNull().defaultNow(),
  deliveredBy: uuid('delivered_by'),
  openedAt: ts('opened_at'),
  receiptSignedAt: ts('receipt_signed_at'),
  receiptName: text('receipt_name'),
  receiptIp: text('receipt_ip'),
  receiptUserAgent: text('receipt_user_agent'),
  createdAt: createdAt(),
}, (t) => [index('franchise_deliveries_prospect_idx').on(t.prospectId)]);

/** Agreement e-signature envelopes (built-in sandbox signature, DocuSign or Dropbox Sign). */
export const franchiseSignatures = pgTable('franchise_signatures', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => franchiseDocuments.id, { onDelete: 'restrict' }),
  deliveryId: uuid('delivery_id'),
  provider: text('provider').notNull().default('builtin'),
  providerEnvelopeId: text('provider_envelope_id'),
  status: text('status').notNull().default('sent'), // sent | signed | declined | voided
  tokenHash: text('token_hash').unique(),
  /** Terms recorded in the agreements register when signed. */
  terms: jsonb('terms').$type<Record<string, unknown>>().notNull().default({}),
  sentAt: ts('sent_at').notNull().defaultNow(),
  sentBy: uuid('sent_by'),
  signedAt: ts('signed_at'),
  signerName: text('signer_name'),
  signerIp: text('signer_ip'),
  signerUserAgent: text('signer_user_agent'),
  createdAt: createdAt(),
});

export const franchiseFeeInvoices = pgTable('franchise_fee_invoices', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  prospectId: uuid('prospect_id').notNull().references(() => franchiseProspects.id, { onDelete: 'cascade' }),
  /** Location whose payment account collects the fee (an HQ / corporate location). */
  collectLocationId: uuid('collect_location_id').notNull(),
  description: text('description').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  status: text('status').notNull().default('open'), // open | paid | void
  paymentId: uuid('payment_id'),
  paidAt: ts('paid_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

/** Legal workspace: franchise agreements register (one row per agreement). */
export const franchiseAgreements = pgTable('franchise_agreements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  prospectId: uuid('prospect_id'),
  territoryId: uuid('territory_id'),
  territory: text('territory'),
  locationIds: uuid('location_ids').array().notNull().default(sql`'{}'::uuid[]`),
  jurisdiction: text('jurisdiction'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  termYears: integer('term_years'),
  renewalOption: text('renewal_option'),
  /** Royalty / marketing fund as basis points of gross sales (500 = 5%). */
  royaltyBps: integer('royalty_bps'),
  marketingFundBps: integer('marketing_fund_bps'),
  terms: jsonb('terms').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('active'), // active | expired | terminated | renewed
  documentId: uuid('document_id'),
  /** Brand the agreement is for (null = the default brand). */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  /** Days-before-expiry reminders already sent (e.g. [180, 90]). */
  remindersSent: integer('reminders_sent').array().notNull().default(sql`'{}'::int[]`),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('franchise_agreements_org_idx').on(t.organizationId, t.endDate)]);
