import type { locations, organizations } from '../db/schema/index.ts';
import { orgPolicies } from './orgSettings.ts';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function serializeOrg(o: typeof organizations.$inferSelect) {
  return {
    id: o.id, slug: o.slug, name: o.name, industry: o.industry, model: o.model, isSingleLocation: o.model === 'independent', country: o.country,
    defaultCurrency: o.defaultCurrency, defaultLocale: o.defaultLocale, defaultTimeZone: o.defaultTimeZone,
    dataRegion: o.dataRegion, status: o.status, paymentAccountMode: o.paymentAccountMode,
    paymentsConnected: !!o.stripeAccountId, applicationFeeBps: o.applicationFeeBps,
    policies: orgPolicies(o),
    createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt),
  };
}

export function serializeLocation(l: typeof locations.$inferSelect) {
  return {
    id: l.id, organizationId: l.organizationId, regionId: l.regionId, ownerGroupId: l.ownerGroupId,
    name: l.name, code: l.code, slug: l.slug, address: l.address, country: l.country, timeZone: l.timeZone,
    currency: l.currency, locale: l.locale, phone: l.phone, email: l.email, status: l.status,
    publiclyVisible: l.publiclyVisible, hours: l.hours, templateId: l.templateId,
    paymentsEnabled: l.paymentsEnabled, paymentsConnected: !!l.stripeAccountId, geo: l.geo,
    createdAt: iso(l.createdAt), updatedAt: iso(l.updatedAt), archivedAt: iso(l.archivedAt),
  };
}
