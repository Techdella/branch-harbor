'use client';

import { useApp } from '@/components/shell/AppContext';
import type { Location } from './types';
import type { BusinessModel } from './business';

export interface BusinessMode {
  model: BusinessModel;
  /** One location, no network concepts (no scope selector, regions, owner groups, group publish, HQ roles). */
  isIndependent: boolean;
  isNetwork: boolean;
  /** The business's single location (independent) — null for networks. */
  location: Location | null;
  /** What to show where a network shows its scope: the business name. */
  businessName: string;
  features: {
    scopeSelector: boolean;
    locationsDirectory: boolean;
    regions: boolean;
    ownerGroups: boolean;
    templatePolicies: boolean;
    groupPublish: boolean;
    locationImport: boolean;
    networkRoles: boolean;
    locationBreakdowns: boolean;
  };
}

/**
 * Business mode of the selected organisation. Industry screens can read it to drop location pickers,
 * per-location columns or network wording for independent businesses, e.g.
 *
 *   const { isIndependent, location } = useBusinessMode();
 *   const locs = isIndependent ? [location!] : app.locations;
 */
export function useBusinessMode(): BusinessMode {
  const app = useApp();
  const model: BusinessModel = app.org.model === 'independent' ? 'independent' : 'network';
  const network = model === 'network';
  return {
    model,
    isIndependent: !network,
    isNetwork: network,
    location: network ? null : (app.locations[0] ?? null),
    businessName: app.org.name,
    features: {
      scopeSelector: network,
      locationsDirectory: network,
      regions: network,
      ownerGroups: network,
      templatePolicies: network,
      groupPublish: network,
      locationImport: network,
      networkRoles: network,
      locationBreakdowns: network,
    },
  };
}
