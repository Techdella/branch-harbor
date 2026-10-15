/**
 * Business mode: an independent (single-location) business or a network (spec §6: "Single-location customers skip
 * network concepts unless they add a location"). Types for the `business` API namespace.
 */
import type { Currency } from '@bh/shared';
import type { RequestContext } from './types';

export type BusinessModel = 'independent' | 'network';
export type WebsiteApprovalMode = 'off' | 'staff';

/** The independent business's one location, edited under Settings → Business & location. */
export interface BusinessLocation {
  id: string;
  name: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  timeZone: string;
  currency: Currency;
  phone: string;
  email: string;
  hours: string;
  status: string;
  publiclyVisible: boolean;
}

export interface PlanInfo {
  key: string;
  name: string;
  pricing: 'flat' | 'per_location';
  price: { amount: number; currency: Currency; interval: string } | null;
}

export interface SoloBilling {
  plan: PlanInfo;
  status: string;
  periodEnd: string | null;
}

export interface UpgradePreview {
  canUpgrade: boolean;
  consequences: string[];
  currentPlan: PlanInfo | null;
  nextPlan: PlanInfo;
  locationCount: number;
}

export interface NewLocationInput {
  name: string;
  code: string;
  line1: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
  timeZone: string;
  currency: Currency;
}

export interface SiteStatus {
  address: string;
  exists: boolean;
  published: boolean;
  publishedAt: string | null;
  version: number;
  visible: boolean;
}

export interface BusinessApi {
  location(ctx: RequestContext): Promise<BusinessLocation>;
  saveLocation(ctx: RequestContext, input: Partial<BusinessLocation>): Promise<BusinessLocation>;
  billing(ctx: RequestContext): Promise<SoloBilling>;
  approvals(ctx: RequestContext): Promise<WebsiteApprovalMode>;
  setApprovals(ctx: RequestContext, mode: WebsiteApprovalMode): Promise<WebsiteApprovalMode>;
  upgradePreview(ctx: RequestContext): Promise<UpgradePreview>;
  /** Upgrade to a network; optionally add the second location in the same step. */
  upgrade(ctx: RequestContext, input: { reason?: string; location?: NewLocationInput }): Promise<{ upgraded: true; locationId: string | null }>;
  site(ctx: RequestContext): Promise<SiteStatus>;
  /** Single "Publish" for an independent business: creates the website if needed, publishes it and makes the business visible. */
  publish(ctx: RequestContext): Promise<SiteStatus>;
}
