import { sql } from 'drizzle-orm';
import { bigint, boolean, char, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, orgId, pk, ts, updatedAt } from './_shared.ts';

export type OnboardingStepState = { status: 'not_started' | 'in_progress' | 'complete' | 'skipped'; data?: Record<string, unknown>; updatedAt?: string };

export const organizations = pgTable('organizations', {
  id: pk(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  industry: text('industry').notNull(),
  model: text('model').notNull().default('network'), // independent | network
  country: char('country', { length: 2 }).notNull(),
  defaultCurrency: currencyCol('default_currency').notNull(),
  defaultLocale: text('default_locale').notNull().default('en'),
  defaultTimeZone: text('default_time_zone').notNull(),
  /** Data residency region (us | eu | apac). Determines where tenant data is stored/processed. */
  dataRegion: text('data_region').notNull(),
  status: text('status').notNull().default('active'),
  onboarding: jsonb('onboarding').$type<Record<string, OnboardingStepState>>().notNull().default({}),
  /** per_location: each location has its own connected account; shared: one org account. */
  paymentAccountMode: text('payment_account_mode').notNull().default('per_location'),
  stripeAccountId: text('stripe_account_id'),
  applicationFeeBps: integer('application_fee_bps'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts('deleted_at'),
});

export const regions = pgTable('regions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, (t) => [index('regions_org_idx').on(t.organizationId)]);

export const ownerGroups = pgTable('owner_groups', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  createdAt: createdAt(),
}, (t) => [index('owner_groups_org_idx').on(t.organizationId)]);

/** Brand-level settings that sit between the organisation default and a location. */
export type BrandSettings = {
  /** Review-request overrides (merged: organisation default → brand → location). */
  reviews?: Record<string, unknown>;
  /** Brand templates: website builder template, email theme and asset-library folder of the brand. */
  siteTemplateId?: string | null;
  emailTemplateId?: string | null;
  assetFolder?: string | null;
};

/**
 * Brands (access scope `brand`). Every business has one default brand; locations without a brand belong to it.
 * A franchisor HQ can run several brands of the SAME industry (one industry per business account). Each brand has its
 * own identity (logo, colours, fonts, theme, domain, languages, currency), email sender, hosted site, franchise terms
 * and onboarding checklist. Identity fields left empty fall back to the business's site settings.
 */
export const brands = pgTable('brands', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  /** Address segment of the hosted sites (/{slug}/{location}); the default brand answers on the business slug too. */
  slug: text('slug'),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color'),
  accentColor: text('accent_color'),
  headingFont: text('heading_font'),
  bodyFont: text('body_font'),
  /** Website builder theme (SITE_THEMES id) of the brand's sites. */
  themeId: text('theme_id'),
  tagline: text('tagline'),
  /** The brand's own web address (e.g. barre.example.com), verified through the domains flow before it serves. */
  domain: text('domain'),
  /** Languages the brand's sites and emails offer. */
  locales: text('locales').array().notNull().default(sql`'{}'::text[]`),
  defaultCurrency: currencyCol('default_currency'),
  /** Email sender identity for email sent on behalf of the brand's locations. */
  emailFromName: text('email_from_name'),
  emailReplyTo: text('email_reply_to'),
  /** Onboarding checklist template (franchise project template key) for the brand's new locations. */
  onboardingTemplateKey: text('onboarding_template_key'),
  settings: jsonb('settings').$type<BrandSettings>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: ts('archived_at'),
}, (t) => [
  index('brands_org_idx').on(t.organizationId),
  uniqueIndex('brands_default_uq').on(t.organizationId).where(sql`${t.isDefault}`),
  uniqueIndex('brands_slug_uq').on(t.slug),
]);

/**
 * Territories (access scope `territory`): a sub-network that holds locations and franchise pipeline entries — a
 * country run by a master franchisee, or the development area of an area developer. Not the same as the franchise
 * pipeline's sales territories (`franchise_territories`), which can sit inside one.
 */
export const territories = pgTable('territories', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** master | development | support */
  kind: text('kind').notNull().default('master'),
  country: char('country', { length: 2 }),
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('territories_org_idx').on(t.organizationId)]);

/** Portfolios (access scope `portfolio`): any named set of locations, across regions and owners (field consultants). */
export const portfolios = pgTable('portfolios', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('portfolios_org_idx').on(t.organizationId)]);

export type Address = { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string };

export const locations = pgTable('locations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  regionId: uuid('region_id').references(() => regions.id, { onDelete: 'set null' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  slug: text('slug').notNull(),
  address: jsonb('address').$type<Address>().notNull(),
  country: char('country', { length: 2 }).notNull(),
  timeZone: text('time_zone').notNull(),
  currency: currencyCol().notNull(),
  locale: text('locale').notNull().default('en'),
  phone: text('phone'),
  email: text('email'),
  /** draft | onboarding | opening_soon | operating | paused | closed */
  status: text('status').notNull().default('draft'),
  /** Adding a location never makes it visible to customers automatically. */
  publiclyVisible: boolean('publicly_visible').notNull().default(false),
  hours: jsonb('hours').$type<Record<string, unknown>>(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  templateId: uuid('template_id'),
  stripeAccountId: text('stripe_account_id'),
  paymentsEnabled: boolean('payments_enabled').notNull().default(false),
  geo: jsonb('geo').$type<{ lat: number; lng: number }>(),
  /** Sub-network the location belongs to (access scope `territory`). */
  territoryId: uuid('territory_id').references(() => territories.id, { onDelete: 'set null' }),
  /** Brand (access scope `brand`); null = the business's default brand. */
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: ts('archived_at'),
}, (t) => [
  uniqueIndex('locations_org_code_uq').on(t.organizationId, t.code),
  uniqueIndex('locations_org_slug_uq').on(t.organizationId, t.slug),
  index('locations_region_idx').on(t.regionId),
  index('locations_owner_group_idx').on(t.ownerGroupId),
  index('locations_territory_idx').on(t.territoryId),
]);

/** Locations in a portfolio. */
export const portfolioLocations = pgTable('portfolio_locations', {
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.portfolioId, t.locationId] }), index('portfolio_locations_location_idx').on(t.locationId)]);

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  locale: text('locale').notNull().default('en'),
  timeZone: text('time_zone'),
  /** BranchHarbor staff only: `admin` may use the audited /v1/platform endpoints. Never set through the API. */
  platformRole: text('platform_role'),
  emailVerifiedAt: ts('email_verified_at'),
  deletionRequestedAt: ts('deletion_requested_at'),
  deletedAt: ts('deleted_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: pk(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  /** All tokens descending from one login share a family; reuse of a rotated token revokes the family. */
  familyId: uuid('family_id').notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  replacedById: uuid('replaced_by_id'),
  userAgent: text('user_agent'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.familyId)]);

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: pk(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: createdAt(),
});

export const roleAssignments = pgTable('role_assignments', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** A system role key (packages/shared ROLES) or `custom` with `customRoleId`. */
  role: text('role').notNull(),
  /** References custom_roles (FK in migration 0013); null for system roles. */
  customRoleId: uuid('custom_role_id'),
  scopeKind: text('scope_kind').notNull(), // organization | region | owner_group | location
  scopeId: uuid('scope_id').notNull(),
  createdBy: uuid('created_by'),
  /** Optional expiry (e.g. time-limited support access). */
  expiresAt: ts('expires_at'),
  createdAt: createdAt(),
}, (t) => [
  index('role_assignments_user_org_idx').on(t.userId, t.organizationId),
  uniqueIndex('role_assignments_uq').on(t.userId, t.role, t.scopeKind, t.scopeId, sql`coalesce(${t.customRoleId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
]);

export const invitations = pgTable('invitations', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  customRoleId: uuid('custom_role_id'),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: uuid('invited_by').notNull(),
  status: text('status').notNull().default('pending'), // pending | accepted | revoked | expired
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  acceptedBy: uuid('accepted_by'),
  createdAt: createdAt(),
}, (t) => [index('invitations_org_idx').on(t.organizationId)]);

export const auditEvents = pgTable('audit_events', {
  id: pk(),
  organizationId: uuid('organization_id'),
  actorUserId: uuid('actor_user_id'),
  actorType: text('actor_type').notNull().default('user'), // user | system | webhook | ai
  action: text('action').notNull(),
  scopeKind: text('scope_kind'),
  scopeId: uuid('scope_id'),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('audit_org_created_idx').on(t.organizationId, t.createdAt)]);

export const subscriptions = pgTable('subscriptions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }).unique(),
  /** solo | connector | hosted | network (legacy: trial). The plan that starts when the paid trial ends. */
  plan: text('plan').notNull().default('trial'),
  /**
   * checkout_required (no paid trial or plan yet) → trialing (14-day trial fee paid) → active; past_due; canceled.
   * Legacy rows created before the paid trial may still read `trialing` with no `trialEndsAt`.
   */
  status: text('status').notNull().default('checkout_required'),
  billedLocationCount: integer('billed_location_count').notNull().default(0),
  /**
   * Subscription items last synced to Stripe (HQ's own share: platform fee, plan lines and the location fees HQ pays).
   * Compared on every location or payer change, so quantities follow the network (live franchisee charging).
   */
  syncedLines: jsonb('synced_lines').$type<{ lookupKey: string; productName: string; unitAmountMinor: number; quantity: number }[]>().notNull().default([]),
  currency: currencyCol().notNull(),
  /** BranchHarbor plan price per billed location per interval, minor units in `currency`. null = not priced (trial). */
  pricePerLocationMinor: bigint('price_per_location_minor', { mode: 'number' }),
  billingInterval: text('billing_interval').notNull().default('month'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodEnd: ts('current_period_end'),
  /** Billing country locked at checkout (ISO alpha-2); decides the currency and price list. */
  billingCountry: char('billing_country', { length: 2 }),
  /** Price list key from @bh/shared (USD, EUR@C, …) and the price-book version used at checkout. */
  priceList: text('price_list'),
  priceBookVersion: text('price_book_version'),
  /** Network HQ platform fee per interval (minor units) and the locations it includes. */
  platformFeeMinor: bigint('platform_fee_minor', { mode: 'number' }),
  includedLocations: integer('included_locations').notNull().default(0),
  trialEndsAt: ts('trial_ends_at'),
  trialFeeMinor: bigint('trial_fee_minor', { mode: 'number' }),
  /** Day counts (3, 1) whose trial reminder email was sent. */
  trialRemindersSent: jsonb('trial_reminders_sent').$type<number[]>().notNull().default([]),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  canceledAt: ts('canceled_at'),
  stripePaymentMethodId: text('stripe_payment_method_id'),
  /** Card on file: brand, last4, issuing country (never the number). */
  card: jsonb('card').$type<{ brand: string | null; last4: string | null; country: string | null; expMonth: number | null; expYear: number | null } | null>(),
  taxId: text('tax_id'),
  taxIdCountry: char('tax_id_country', { length: 2 }),
  /** Evidence that locked the billing country: card | tax_id. */
  countryEvidence: text('country_evidence'),
  /** Open checkout (quote locked from the billing country, setup intent). Cleared when confirmed. */
  checkout: jsonb('checkout').$type<Record<string, unknown> | null>(),
  /** Billing-country change waiting for the next cycle. */
  pendingChange: jsonb('pending_change').$type<Record<string, unknown> | null>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
