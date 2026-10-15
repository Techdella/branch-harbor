import { and, eq, isNull } from 'drizzle-orm';
import {
  asBusinessModel, inviteRolesFor, isPriceListKey, listPriceMinor, priceListCurrency, priceListForCountry, soloPrice, NETWORK_INCLUDED_LOCATIONS, UPGRADE_CONSEQUENCES, WEBSITE_APPROVAL_MODES,
  type PriceListKey,
  type BusinessModel, type Role, type WebsiteApprovalMode,
} from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { locations, organizations, subscriptions, websites } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { audit } from './audit.ts';

/**
 * Business mode (independent vs network). The data model is the same for both; an independent business is
 * an organisation with a single location whose network concepts (regions, owner groups, locked/approval
 * templates, group publishing, HQ/regional/franchise roles) are hidden until it upgrades.
 */

type Org = typeof organizations.$inferSelect;

export const isIndependent = (o: Pick<Org, 'model'>) => asBusinessModel(o.model) === 'independent';

export async function loadOrg(db: Exec, orgId: string): Promise<Org | null> {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return o ?? null;
}

/** Active (not archived) locations, oldest first — for an independent business the first one is *the* location. */
export async function activeLocations(db: Exec, orgId: string) {
  return db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))).orderBy(locations.createdAt);
}

export function websiteApprovalMode(o: Pick<Org, 'settings'>): WebsiteApprovalMode {
  const v = (o.settings ?? {} as Record<string, unknown>).websiteApprovals;
  return (WEBSITE_APPROVAL_MODES as readonly string[]).includes(v as string) ? (v as WebsiteApprovalMode) : 'off';
}

/** Feature flags clients use to hide network concepts. Enforcement stays server-side. */
export function businessFeatures(model: BusinessModel) {
  const network = model === 'network';
  return {
    scopeSelector: network,
    locationsDirectory: network,
    regions: network,
    ownerGroups: network,
    templatePolicies: network,
    groupPublish: network,
    locationImport: network,
    autonomyTiers: network,
    franchiseRoles: network,
  };
}

/** The business-mode block exposed on /auth/me and the organisation endpoints. */
export function businessModeView(o: Pick<Org, 'model' | 'settings'>, primaryLocationId: string | null) {
  const model = asBusinessModel(o.model);
  return {
    model,
    isSingleLocation: model === 'independent',
    primaryLocationId: model === 'independent' ? primaryLocationId : null,
    availableRoles: inviteRolesFor(model),
    websiteApprovals: model === 'independent' ? websiteApprovalMode(o) : ('template_policies' as const),
    features: businessFeatures(model),
  };
}

export function upgradeRequired(message: string, details: Record<string, unknown> = {}) {
  return new AppError(409, 'upgrade_required', message, undefined, {
    upgrade: { method: 'POST', path: 'upgrade-to-network', body: { confirm: true } },
    consequences: UPGRADE_CONSEQUENCES,
    ...details,
  });
}

/** Throw a clear 409 when an independent business uses a network-only feature. */
export function requireNetwork(o: Pick<Org, 'model' | 'id'>, feature: string) {
  if (isIndependent(o)) {
    throw upgradeRequired(`${feature} is part of the network tools. Independent businesses can use it after upgrading to a network (POST /v1/orgs/${o.id}/upgrade-to-network).`, { feature });
  }
}

export function assertRoleForModel(o: Pick<Org, 'model'>, role: Role, scopeKind: string) {
  const model = asBusinessModel(o.model);
  if (!inviteRolesFor(model).includes(role)) {
    throw new AppError(400, 'role_not_available', `The ${role.replace(/_/g, ' ')} role is only available to networks. Independent businesses can invite an owner, manager, staff, content & social, sales or finance user.`, { role: 'Not available for independent businesses' }, { availableRoles: inviteRolesFor(model) });
  }
  if (model === 'independent' && scopeKind !== 'organization' && scopeKind !== 'location') {
    throw new AppError(400, 'scope_not_available', 'Independent businesses have no regions or owner groups. Assign the business or its location.', { scope: 'Use organization or location' });
  }
}

/** Price list of a subscription (set at checkout from the billing country; older rows fall back to their currency). */
function listOf(sub: Pick<typeof subscriptions.$inferSelect, 'priceList' | 'currency' | 'billingCountry'>): PriceListKey {
  if (isPriceListKey(sub.priceList)) return sub.priceList;
  if (sub.billingCountry) return priceListForCountry(sub.billingCountry).key;
  return isPriceListKey(sub.currency) ? sub.currency : 'USD';
}

const PLAN_NAMES: Record<string, string> = { solo: 'Solo', connector: 'Connector', hosted: 'Hosted', network: 'Network', trial: 'Network' };

/** Plan summary for the subscription endpoint and the upgrade preview. */
export function planView(sub: typeof subscriptions.$inferSelect, model: BusinessModel) {
  const list = listOf(sub);
  const currency = priceListCurrency(list);
  if (model === 'independent' || sub.plan === 'solo') {
    const price = soloPrice(list);
    return { key: 'solo' as const, name: 'Solo', pricing: 'flat' as const, maxLocations: 1, price: price ? { amount: price.amount, currency: price.currency, interval: price.interval } : null, platformFee: null };
  }
  const key = sub.plan === 'trial' ? 'network' : sub.plan;
  const months = sub.billingInterval === 'year' ? 10 : 1;
  // The price stored at checkout (kept until customers are told about a change), else today's list price.
  const per = sub.pricePerLocationMinor ?? (['connector', 'hosted', 'network'].includes(key) ? listPriceMinor(list, key as 'connector') * months : null);
  return {
    key, name: PLAN_NAMES[key] ?? key, pricing: 'per_location' as const, maxLocations: null,
    price: per != null ? { amount: per, currency, interval: sub.billingInterval } : null,
    platformFee: key === 'network' ? { amount: listPriceMinor(list, 'platform') * months, currency, interval: sub.billingInterval, includedLocations: NETWORK_INCLUDED_LOCATIONS } : null,
  };
}

/** Network per-location list price for a price list or currency (null = quote). */
export function networkPrice(list: string): number | null {
  return isPriceListKey(list) ? listPriceMinor(list, 'network') : null;
}

/**
 * Convert an independent business into a network. Keeps every record; only the model, the plan and the
 * customer-site addresses change. Must run inside a transaction; audited.
 */
export async function upgradeToNetwork(tx: Exec, org: Org, opts: { actorUserId: string; ip?: string | null; reason?: string | null; trigger: 'explicit' | 'add_location' }, sitesBaseUrl: string) {
  if (!isIndependent(org)) throw new AppError(409, 'already_network', 'This organisation is already a network.');
  const locs = await activeLocations(tx, org.id);
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.organizationId, org.id));
  const settings = { ...org.settings, upgradedToNetworkAt: new Date().toISOString() } as Record<string, unknown>;
  const [updated] = await tx.update(organizations).set({ model: 'network', settings, updatedAt: new Date() }).where(eq(organizations.id, org.id)).returning();
  if (sub && (sub.plan === 'solo' || sub.plan === 'trial')) {
    await tx.update(subscriptions).set({
      plan: 'network',
      pricePerLocationMinor: networkPrice(listOf(sub)),
      platformFeeMinor: networkPrice(listOf(sub)) != null ? listPriceMinor(listOf(sub), 'platform') : null,
      includedLocations: NETWORK_INCLUDED_LOCATIONS,
      updatedAt: new Date(),
    }).where(eq(subscriptions.id, sub.id));
  }
  // The location's site moves from /{brand} to /{brand}/{location}; the brand address becomes the location finder.
  const base = sitesBaseUrl.replace(/\/$/, '');
  for (const l of locs) {
    await tx.update(websites).set({ includedAddress: `${base}/${org.slug}/${l.slug}`, updatedAt: new Date() })
      .where(and(eq(websites.organizationId, org.id), eq(websites.locationId, l.id)));
  }
  await audit(tx, {
    organizationId: org.id, actorUserId: opts.actorUserId, ip: opts.ip ?? null, action: 'org.upgraded_to_network',
    scopeKind: 'organization', scopeId: org.id, targetType: 'organization', targetId: org.id,
    metadata: { from: 'independent', to: 'network', trigger: opts.trigger, reason: opts.reason ?? null, locationCount: locs.length, previousPlan: sub?.plan ?? null },
  });
  return updated!;
}
