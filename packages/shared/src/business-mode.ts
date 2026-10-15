import { z } from 'zod';
import { addressSchema, currency, timeZone } from './schemas.ts';
import type { Industry } from './industries.ts';
import type { Role } from './permissions.ts';

/**
 * Business mode (product spec §6–§7): an organisation is either an independent business (one location,
 * a few staff) or a network (HQ, optional regions and owner groups, many locations).
 *
 * The data model is identical for both — an independent business is simply an organisation with one location
 * and no regions/owner groups — so upgrading to a network never migrates data. Independent businesses skip the
 * network concepts (scope selector, regions, owner groups, locked/approval templates, group publish, franchise
 * roles) until they add a second location and upgrade.
 */
export const BUSINESS_MODELS = ['independent', 'network'] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export function asBusinessModel(v: unknown): BusinessModel {
  return v === 'independent' ? 'independent' : 'network';
}

/** Roles an independent business can grant (spec §5, without HQ/regional/franchise roles). */
export const INDEPENDENT_ROLES = ['org_owner', 'location_manager', 'staff', 'content_social', 'finance_lead', 'accountant', 'sales_rep'] as const satisfies readonly Role[];
/** Roles that only make sense in a network (franchise development, HQ teams, partners, field roles and franchisees). */
export const NETWORK_ONLY_ROLES = [
  'hq_admin', 'development_lead', 'development_rep', 'marketing_lead', 'brand_manager', 'legal_lead', 'field_consultant',
  'master_franchisee', 'area_developer', 'area_representative', 'multi_unit_operator', 'franchise_owner',
] as const satisfies readonly Role[];

/** Team-member roles offered when inviting, by business model, grouped by team (customers are never invited as team). */
export function inviteRolesFor(model: BusinessModel): Role[] {
  return model === 'independent'
    ? [...INDEPENDENT_ROLES]
    : [
        'org_owner', 'hq_admin',
        'development_lead', 'development_rep',
        'sales_lead', 'sales_rep',
        'marketing_lead', 'brand_manager', 'digital_marketer', 'content_social',
        'operations_lead', 'field_consultant',
        'finance_lead', 'accountant',
        'legal_lead',
        'training_lead', 'trainer',
        'master_franchisee', 'area_developer', 'area_representative', 'multi_unit_operator',
        'franchise_owner', 'location_manager', 'staff',
        'auditor',
      ];
}

export function roleAllowedFor(model: BusinessModel, role: Role): boolean {
  return inviteRolesFor(model).includes(role);
}

/**
 * Website approvals for independent businesses. Off by default: the owner (and managers with publish rights)
 * edit and publish directly — there are no locked or approval-required fields. `staff` makes edits by people
 * without approval rights (e.g. marketing contributors) go through the owner first.
 */
export const WEBSITE_APPROVAL_MODES = ['off', 'staff'] as const;
export type WebsiteApprovalMode = (typeof WEBSITE_APPROVAL_MODES)[number];

/** Payload for POST /v1/orgs/:id/upgrade-to-network. */
export const upgradeToNetworkSchema = z.object({
  /** Explicit acknowledgement of the consequences listed by GET …/upgrade-to-network. */
  confirm: z.literal(true, { error: 'Confirm the upgrade to continue' }),
  reason: z.string().max(500).optional(),
});

/** What changes when an independent business becomes a network (shown before the owner confirms). */
export const UPGRADE_CONSEQUENCES = [
  'Your existing location, customers, website, team and payment history stay exactly as they are.',
  'The scope selector, Locations directory, regions and owner groups become available.',
  'Website templates can lock fields or require approval, and pages can be published to several locations at once.',
  'Headquarters, field consultant, franchise partner and franchise owner roles can be invited.',
  'Billing moves from the Solo plan to per-location pricing once a second location is operating.',
  'Your customer website gets a location finder; your current address keeps working and redirects to your location.',
] as const;

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export const BILLING_PLANS = ['trial', 'solo', 'hosted', 'connector', 'network'] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

/** List prices, the Solo plan and country → currency rules live in ./pricing.ts (the price book). */

/** Every industry supports self-service sign-up (all industries launch together). */
export const SELF_SERVE_INDUSTRIES = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty', 'hospitality'] as const satisfies readonly Industry[];
export function supportsSelfServe(industry: string): boolean {
  return (SELF_SERVE_INDUSTRIES as readonly string[]).includes(industry);
}

/**
 * Independent businesses create their organisation and their (only) location in one step.
 * Hours: `{ summary?: string, weekly?: [{ day: 0-6 (Sun=0), opens: 'HH:MM', closes: 'HH:MM' }] }`.
 */
export const firstLocationSchema = z.object({
  name: z.string().min(1).max(120).optional().describe('Defaults to the business name'),
  code: z.string().min(1).max(24).optional(),
  address: addressSchema,
  timeZone: timeZone.optional().describe('Defaults to the organisation time zone'),
  currency: currency.optional().describe('Defaults to the organisation currency'),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  hours: z.record(z.string(), z.unknown()).optional(),
});
