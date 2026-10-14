import type { Money } from '@bh/shared';
import type { IndustryKey, Location, Organization, Session } from '../types';
import { FIXTURES, initialsOf } from './orgs';

/**
 * Sample independent businesses (one location, a few staff) for the "Independent business" persona.
 *
 * Each one reuses a location id from the industry's network fixture so the industry screens' sample content
 * (classes, orders, appointments…) stays consistent, but the organisation is its own single-location business
 * with no regions, owner groups or franchise structure.
 */
export interface IndependentFixture {
  org: Organization;
  location: Location & { revenue7d: Money };
  owner: string;
}

const make = (industry: IndustryKey, locId: string, org: Pick<Organization, 'id' | 'name' | 'defaultCurrency' | 'defaultTimeZone' | 'defaultLocale' | 'dataRegion'>, loc: Partial<Location>, owner: string): IndependentFixture => {
  const base = FIXTURES[industry].locations.find((l) => l.id === locId)!;
  return {
    org: { ...org, brand: org.name, industry, sample: true, model: 'independent', regions: [], ownerGroups: [] },
    location: { ...base, ...loc, name: loc.address?.city ?? base.address.city, code: 'MAIN', regionId: '', ownerGroupId: '', ownership: 'company', template: 'Your website', revenue7d: { amount: base.revenue7d.amount, currency: loc.currency ?? base.currency } },
    owner,
  };
};

export const INDEPENDENT: Record<IndustryKey, IndependentFixture> = {
  studios: make('studios', 'sy', { id: 'org_lumen', name: 'Lumen Pilates', defaultCurrency: 'AUD', defaultTimeZone: 'Australia/Melbourne', defaultLocale: 'en', dataRegion: 'apac' },
    { address: { line1: '214 Gertrude St', city: 'Melbourne', region: 'VIC', postalCode: '3065', country: 'AU' }, timeZone: 'Australia/Melbourne', currency: 'AUD', locale: 'en-AU', phone: '+61 3 5550 0214', hours: 'Mon–Fri 06:30–20:00 · Sat–Sun 08:00–13:00' }, 'Hana Okafor'),
  sports: make('sports', 'rp', { id: 'org_riverside', name: 'Riverside Juniors FC', defaultCurrency: 'CAD', defaultTimeZone: 'America/Vancouver', defaultLocale: 'en', dataRegion: 'us' },
    {}, 'Marcus Bell'),
  wellness: make('wellness', 'fz', { id: 'org_fitzroy_massage', name: 'Brunswick St Massage', defaultCurrency: 'AUD', defaultTimeZone: 'Australia/Melbourne', defaultLocale: 'en', dataRegion: 'apac' },
    {}, 'Rina Kapoor'),
  commerce: make('commerce', 'pd', { id: 'org_paper', name: 'Northwest Paper Co.', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles', defaultLocale: 'en', dataRegion: 'us' },
    {}, 'Leah Park'),
  foods: make('foods', 'bl', { id: 'org_ballard_corner', name: 'Ballard Corner Café', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles', defaultLocale: 'en', dataRegion: 'us' },
    {}, 'Carlos Ortega'),
  realty: make('realty', 'tor', { id: 'org_annex_homes', name: 'Annex Homes Realty', defaultCurrency: 'CAD', defaultTimeZone: 'America/Toronto', defaultLocale: 'en', dataRegion: 'us' },
    {}, 'Priya Shah'),
};

export function independentSession(ind: IndustryKey): Session {
  const f = INDEPENDENT[ind];
  const email = `${f.owner.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}@${f.org.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '')}-sample.com`;
  return {
    user: { id: 'u_owner', name: f.owner, email, initials: initialsOf(f.owner) },
    role: 'hq',
    assignments: [{ role: 'org_owner', scope: { kind: 'organization', id: f.org.id } }],
    locationIds: [],
  };
}
