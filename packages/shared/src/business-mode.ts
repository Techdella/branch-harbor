import { z } from 'zod';
import type { Currency } from './money.ts';
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
export const INDEPENDENT_ROLES = ['org_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance'] as const satisfies readonly Role[];
/** Roles that only make sense in a network. */
export const NETWORK_ONLY_ROLES = ['hq_admin', 'regional_manager', 'franchise_owner', 'instructor_trainer'] as const satisfies readonly Role[];

/** Team-member roles offered when inviting, by business model (customers are never invited as team). */
export function inviteRolesFor(model: BusinessModel): Role[] {
  return model === 'independent'
    ? [...INDEPENDENT_ROLES]
    : ['org_owner', 'hq_admin', 'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance', 'instructor_trainer'];
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
  'Headquarters, regional manager and franchise owner roles can be invited.',
  'Billing moves from the Solo plan to per-location pricing once a second location is operating.',
  'Your customer website gets a location finder; your current address keeps working and redirects to your location.',
] as const;

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export const BILLING_PLANS = ['trial', 'solo', 'hosted', 'connector', 'network'] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

/** Currencies with published list prices (set per currency, not exchange-rate conversions). */
export const PRICED_CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD'] as const satisfies readonly Currency[];
export type PricedCurrency = (typeof PRICED_CURRENCIES)[number];

/**
 * Solo: one location, hosted site and dashboard, monthly list price in minor units per currency.
 * Kept here so the API subscription and the marketing pricing page show the same numbers.
 */
export const SOLO_PLAN = {
  key: 'solo' as const,
  maxLocations: 1,
  interval: 'month' as const,
  priceMinor: { USD: 3900, CAD: 5200, GBP: 3100, EUR: 3600, AUD: 5900 } satisfies Record<PricedCurrency, number>,
};

/**
 * Per-location monthly list prices (minor units) for the multi-location plans. The marketing pricing page and
 * the API subscription both read these, so the numbers can never drift apart.
 */
export const LIST_PRICES_MINOR: Record<PricedCurrency, { connector: number; hosted: number; network: number; solo: number }> = {
  USD: { connector: 2900, hosted: 5900, network: 8900, solo: SOLO_PLAN.priceMinor.USD },
  CAD: { connector: 3900, hosted: 7900, network: 11900, solo: SOLO_PLAN.priceMinor.CAD },
  GBP: { connector: 2300, hosted: 4700, network: 7100, solo: SOLO_PLAN.priceMinor.GBP },
  EUR: { connector: 2700, hosted: 5500, network: 8300, solo: SOLO_PLAN.priceMinor.EUR },
  AUD: { connector: 4500, hosted: 8900, network: 13500, solo: SOLO_PLAN.priceMinor.AUD },
};

/** Solo list price for a currency, or null when the currency has no list price (quote). */
export function soloPrice(currency: string): { amount: number; currency: PricedCurrency; interval: 'month' } | null {
  const c = (PRICED_CURRENCIES as readonly string[]).includes(currency) ? (currency as PricedCurrency) : null;
  return c ? { amount: SOLO_PLAN.priceMinor[c], currency: c, interval: 'month' } : null;
}

/** Verticals that support self-service signup today (others stay on demo/pilot enquiry — spec §4). */
export const SELF_SERVE_INDUSTRIES = ['studios'] as const satisfies readonly Industry[];
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
