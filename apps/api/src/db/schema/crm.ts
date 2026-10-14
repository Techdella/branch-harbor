import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';

export const customers = pgTable('customers', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  /** Home location. Cross-location sharing requires an explicit business policy. */
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  userId: uuid('user_id'),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  locale: text('locale'),
  dateOfBirth: text('date_of_birth'),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /** Tombstone: erased records keep an id for referential integrity, PII is cleared. */
  erasedAt: ts('erased_at'),
}, (t) => [index('customers_org_email_idx').on(t.organizationId, t.email), index('customers_location_idx').on(t.locationId)]);

export const consentRecords = pgTable('consent_records', {
  id: pk(),
  organizationId: uuid('organization_id'),
  customerId: uuid('customer_id'),
  userId: uuid('user_id'),
  email: text('email'),
  /** e.g. marketing_email, marketing_sms, terms, privacy_policy, data_processing_ai */
  purpose: text('purpose').notNull(),
  version: text('version').notNull(),
  granted: boolean('granted').notNull(),
  source: text('source').notNull(),
  ip: text('ip'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
}, (t) => [index('consent_customer_idx').on(t.customerId), index('consent_user_idx').on(t.userId)]);

export const guardianRelationships = pgTable('guardian_relationships', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  guardianCustomerId: uuid('guardian_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  participantCustomerId: uuid('participant_customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  relationship: text('relationship').notNull().default('parent'),
  status: text('status').notNull().default('pending_verification'), // pending_verification | verified | disputed | revoked
  verifiedAt: ts('verified_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('guardian_rel_uq').on(t.guardianCustomerId, t.participantCustomerId)]);

export const campaigns = pgTable('campaigns', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  scopeKind: text('scope_kind').notNull().default('organization'),
  scopeId: uuid('scope_id').notNull(),
  name: text('name').notNull(),
  channel: text('channel').notNull().default('email'),
  status: text('status').notNull().default('draft'), // draft | pending_approval | scheduled | active | completed | archived
  content: jsonb('content').$type<Record<string, unknown>>().notNull().default({}),
  startsAt: ts('starts_at'),
  endsAt: ts('ends_at'),
  budgetMinor: minor('budget_minor'),
  currency: currencyCol(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const leads = pgTable('leads', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id'),
  customerId: uuid('customer_id'),
  source: text('source').notNull().default('website'),
  name: text('name'),
  email: text('email'),
  phone: text('phone'),
  message: text('message'),
  status: text('status').notNull().default('new'),
  createdAt: createdAt(),
}, (t) => [index('leads_org_created_idx').on(t.organizationId, t.createdAt)]);

/** Marketing-site demo enquiries. Not tenant-scoped. */
export const demoRequests = pgTable('demo_requests', {
  id: pk(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  business: text('business').notNull(),
  industry: text('industry').notNull(),
  locationCount: integer('location_count').notNull(),
  country: text('country').notNull(),
  existingWebsite: text('existing_website'),
  primaryDifficulty: text('primary_difficulty'),
  phone: text('phone'),
  existingSystems: text('existing_systems'),
  locale: text('locale').notNull().default('en'),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  status: text('status').notNull().default('new'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  notifiedAt: ts('notified_at'),
  createdAt: createdAt(),
});
