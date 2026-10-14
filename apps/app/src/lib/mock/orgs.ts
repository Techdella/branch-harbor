import type { Currency, Money } from '@bh/shared';
import type { IndustryKey, Location, Organization, ScopeOptionT, Session, ViewRole } from '../types';
import { addDays, dateInZone, zonedToUtc } from '../format';

export const PASTEL = { lilac: '#E9DDF8', lime: '#E2F5A6', sage: '#D4E6D9', butter: '#F7EDA8', blush: '#F8D6D8', aqua: '#CDEEEE', sand: '#EFE3D3', grey: '#F3F2EE' } as const;

export const unsplash = (id: string, w = 700) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=70`;

const REGIONS = [
  { id: 'na', name: 'North America' },
  { id: 'eu', name: 'Europe' },
  { id: 'apac', name: 'Asia-Pacific' },
];

type L = [id: string, code: string, name: string, line1: string, city: string, region: string | undefined, country: string, regionId: string, ownerGroupId: string, ownership: 'company' | 'franchise', currency: Currency, tz: string, locale: string, phone: string, hours: string, site: 'live' | 'unpublished', sync: 'ok' | 'attention', pastel: string, revenue7d: number];

const mk = (template: string) => (l: L): Location & { revenue7d: Money } => ({
  id: l[0], code: l[1], name: l[2], address: { line1: l[3], city: l[4], region: l[5], country: l[6] }, regionId: l[7], ownerGroupId: l[8], ownership: l[9], currency: l[10], timeZone: l[11], locale: l[12], phone: l[13], hours: l[14], site: l[15], sync: l[16], pastel: l[17], template, revenue7d: { amount: l[18], currency: l[10] },
});

export interface IndustryFixture {
  org: Organization;
  locations: (Location & { revenue7d: Money })[];
  /** Location assigned to the "Location manager" persona. */
  localLocationId: string;
  /** Location assigned to the "Staff" persona. */
  staffLocationId: string;
  people: { hq: string; local: string; staff: string };
  /** Locations a staff/location persona may NOT see — used for scoping demos. */
}

const P = PASTEL;

export const FIXTURES: Record<IndustryKey, IndustryFixture> = {
  studios: {
    org: { id: 'org_stillwater', name: 'Stillwater Yoga Collective', brand: 'Stillwater Yoga', industry: 'studios', sample: true, defaultCurrency: 'CAD', defaultTimeZone: 'America/Toronto', defaultLocale: 'en', dataRegion: 'us', regions: REGIONS,
      ownerGroups: [{ id: 'og_lakeshore', name: 'Lakeshore Holdings' }, { id: 'og_northbound', name: 'Northbound Studios LLC' }, { id: 'og_thames', name: 'Thames Wellbeing Ltd' }, { id: 'og_company', name: 'Company-owned' }] },
    locations: ([
      ['qw', 'TOR-QW', 'Toronto – Queen West', '812 Queen St W', 'Toronto', 'ON', 'CA', 'na', 'og_lakeshore', 'franchise', 'CAD', 'America/Toronto', 'en-CA', '+1 416 555 0142', 'Mon–Fri 06:30–21:00 · Sat–Sun 08:00–18:00', 'live', 'ok', P.lilac, 412000],
      ['ls', 'TOR-LS', 'Toronto – Leslieville', '1104 Queen St E', 'Toronto', 'ON', 'CA', 'na', 'og_lakeshore', 'franchise', 'CAD', 'America/Toronto', 'en-CA', '+1 416 555 0177', 'Daily 07:00–20:00', 'live', 'ok', P.butter, 318050],
      ['kt', 'VAN-KT', 'Vancouver – Kitsilano', '2210 W 4th Ave', 'Vancouver', 'BC', 'CA', 'na', 'og_company', 'company', 'CAD', 'America/Vancouver', 'en-CA', '+1 604 555 0119', 'Daily 06:00–21:00', 'live', 'attention', P.aqua, 0],
      ['ch', 'SEA-CH', 'Seattle – Capitol Hill', '1520 E Pine St', 'Seattle', 'WA', 'US', 'na', 'og_northbound', 'franchise', 'USD', 'America/Los_Angeles', 'en-US', '+1 206 555 0163', 'Daily 06:00–20:00', 'live', 'ok', P.blush, 396050],
      ['sh', 'LDN-SH', 'London – Shoreditch', '41 Great Eastern St', 'London', undefined, 'GB', 'eu', 'og_thames', 'franchise', 'GBP', 'Europe/London', 'en-GB', '+44 20 7946 0321', 'Mon–Sun 07:00–21:00', 'live', 'ok', P.sage, 284500],
      ['pb', 'BER-PB', 'Berlin – Prenzlauer Berg', 'Kastanienallee 12', 'Berlin', undefined, 'DE', 'eu', 'og_company', 'company', 'EUR', 'Europe/Berlin', 'de-DE', '+49 30 901820', 'Opens 4 Nov', 'unpublished', 'attention', P.lime, 0],
      ['sy', 'SYD-SH', 'Sydney – Surry Hills', '388 Crown St', 'Sydney', 'NSW', 'AU', 'apac', 'og_company', 'company', 'AUD', 'Australia/Sydney', 'en-AU', '+61 2 5550 1934', 'Daily 06:00–20:30', 'live', 'ok', P.sand, 361200],
    ] as L[]).map(mk('Studio location · v15')),
    localLocationId: 'ls', staffLocationId: 'qw', people: { hq: 'Jamie Morgan', local: 'Kim Lau', staff: 'Sam Tran' },
  },
  sports: {
    org: { id: 'org_northshore', name: 'North Shore Football Academy', brand: 'North Shore FA', industry: 'sports', sample: true, defaultCurrency: 'CAD', defaultTimeZone: 'America/Vancouver', defaultLocale: 'en', dataRegion: 'us', regions: REGIONS.slice(0, 2),
      ownerGroups: [{ id: 'og_goalline', name: 'Goalline Group' }, { id: 'og_westpitch', name: 'West Pitch Ltd' }, { id: 'og_company', name: 'Academy-run' }] },
    locations: ([
      ['rp', 'VAN-RP', 'Vancouver – Riverside Park', '45 Riverside Dr', 'Vancouver', 'BC', 'CA', 'na', 'og_company', 'company', 'CAD', 'America/Vancouver', 'en-CA', '+1 604 555 0190', 'Sessions Mon–Sat', 'live', 'ok', P.lime, 1104000],
      ['hc', 'TOR-HC', 'Toronto – Hillcrest Dome', '2 Hillcrest Ave', 'Toronto', 'ON', 'CA', 'na', 'og_goalline', 'franchise', 'CAD', 'America/Toronto', 'en-CA', '+1 416 555 0151', 'Sessions daily', 'live', 'ok', P.aqua, 862000],
      ['mc', 'MAN-DB', 'Manchester – Didsbury', '18 School Ln', 'Manchester', undefined, 'GB', 'eu', 'og_westpitch', 'franchise', 'GBP', 'Europe/London', 'en-GB', '+44 161 496 0723', 'Sessions Tue–Sun', 'live', 'ok', P.butter, 512000],
      ['dn', 'DUB-RS', 'Dublin – Ringsend', 'Irishtown Rd', 'Dublin', undefined, 'IE', 'eu', 'og_westpitch', 'franchise', 'EUR', 'Europe/Dublin', 'en-IE', '+353 1 555 0182', 'Sessions Wed–Sun', 'unpublished', 'attention', P.blush, 0],
    ] as L[]).map(mk('Academy venue · v6')),
    localLocationId: 'rp', staffLocationId: 'rp', people: { hq: 'Jamie Morgan', local: 'Marcus Bell', staff: 'Coach Ortiz' },
  },
  wellness: {
    org: { id: 'org_tidewater', name: 'Tidewater Wellness', brand: 'Tidewater Wellness', industry: 'wellness', sample: true, defaultCurrency: 'CAD', defaultTimeZone: 'America/Toronto', defaultLocale: 'en', dataRegion: 'us', regions: REGIONS,
      ownerGroups: [{ id: 'og_company', name: 'Company-owned' }, { id: 'og_harbour', name: 'Harbour Spa Partners' }] },
    locations: ([
      ['hf', 'TOR-HF', 'Toronto – Harbourfront', '207 Queens Quay W', 'Toronto', 'ON', 'CA', 'na', 'og_company', 'company', 'CAD', 'America/Toronto', 'en-CA', '+1 416 555 0185', 'Daily 09:00–21:00', 'live', 'ok', P.sage, 1288000],
      ['yv', 'TOR-YV', 'Toronto – Yorkville', '120 Bloor St W', 'Toronto', 'ON', 'CA', 'na', 'og_company', 'company', 'CAD', 'America/Toronto', 'en-CA', '+1 416 555 0133', 'Mon–Sat 09:00–20:00', 'live', 'ok', P.lilac, 941500],
      ['mb', 'LDN-MB', 'London – Marylebone', '64 Marylebone High St', 'London', undefined, 'GB', 'eu', 'og_harbour', 'franchise', 'GBP', 'Europe/London', 'en-GB', '+44 20 7946 0874', 'Daily 08:00–20:00', 'live', 'ok', P.butter, 702000],
      ['fz', 'MEL-FZ', 'Melbourne – Fitzroy', '310 Brunswick St', 'Melbourne', 'VIC', 'AU', 'apac', 'og_harbour', 'franchise', 'AUD', 'Australia/Melbourne', 'en-AU', '+61 3 5550 2290', 'Daily 09:00–19:00', 'live', 'attention', P.aqua, 655000],
      ['lx', 'LIS-CH', 'Lisbon – Chiado', 'Rua Garrett 88', 'Lisbon', undefined, 'PT', 'eu', 'og_company', 'company', 'EUR', 'Europe/Lisbon', 'pt-PT', '+351 21 555 0144', 'Opens January', 'unpublished', 'ok', P.blush, 0],
    ] as L[]).map(mk('Wellness location · v9')),
    localLocationId: 'hf', staffLocationId: 'hf', people: { hq: 'Jamie Morgan', local: 'Rina Kapoor', staff: 'Tom Becker' },
  },
  commerce: {
    org: { id: 'org_fieldnote', name: 'Fieldnote Goods Co.', brand: 'Fieldnote Goods', industry: 'commerce', sample: true, defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles', defaultLocale: 'en', dataRegion: 'us', regions: REGIONS.slice(0, 2),
      ownerGroups: [{ id: 'og_company', name: 'Company-owned' }, { id: 'og_bayside', name: 'Bayside Retail LLC' }, { id: 'og_nord', name: 'Maison Nord Inc.' }] },
    locations: ([
      ['pd', 'PDX-01', 'Portland store', '415 SW 10th Ave', 'Portland', 'OR', 'US', 'na', 'og_company', 'company', 'USD', 'America/Los_Angeles', 'en-US', '+1 503 555 0161', 'Daily 10:00–19:00', 'live', 'ok', P.butter, 941200],
      ['sf', 'SFO-HV', 'San Francisco – Hayes Valley', '520 Hayes St', 'San Francisco', 'CA', 'US', 'na', 'og_bayside', 'franchise', 'USD', 'America/Los_Angeles', 'en-US', '+1 415 555 0193', 'Daily 10:00–20:00', 'live', 'ok', P.aqua, 788000],
      ['me', 'MTL-ME', 'Montréal – Mile End', '5300 Boul. Saint-Laurent', 'Montréal', 'QC', 'CA', 'na', 'og_nord', 'franchise', 'CAD', 'America/Toronto', 'fr-CA', '+1 514 555 0170', 'Daily 11:00–19:00', 'live', 'ok', P.lilac, 520500],
      ['am', 'AMS-DP', 'Amsterdam – De Pijp', 'Ferdinand Bolstraat 40', 'Amsterdam', undefined, 'NL', 'eu', 'og_company', 'company', 'EUR', 'Europe/Amsterdam', 'nl-NL', '+31 20 555 0119', 'Tue–Sun 10:00–18:00', 'live', 'ok', P.sage, 433000],
      ['au', 'AUS-01', 'Austin store', '1800 E 6th St', 'Austin', 'TX', 'US', 'na', 'og_bayside', 'franchise', 'USD', 'America/Chicago', 'en-US', '+1 512 555 0102', 'Daily 10:00–19:00', 'live', 'attention', P.blush, 0],
    ] as L[]).map(mk('Store · v4')),
    localLocationId: 'pd', staffLocationId: 'pd', people: { hq: 'Jamie Morgan', local: 'Leah Park', staff: 'Kim Lau' },
  },
  foods: {
    org: { id: 'org_maple', name: 'Maple & Ember Restaurants', brand: 'Maple & Ember', industry: 'foods', sample: true, defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles', defaultLocale: 'en', dataRegion: 'us', regions: REGIONS.slice(0, 2),
      ownerGroups: [{ id: 'og_company', name: 'Company-owned' }, { id: 'og_embernw', name: 'Ember NW Group' }, { id: 'og_borough', name: 'Borough Kitchens Ltd' }] },
    locations: ([
      ['bl', 'SEA-BL', 'Seattle – Ballard', '5410 22nd Ave NW', 'Seattle', 'WA', 'US', 'na', 'og_embernw', 'franchise', 'USD', 'America/Los_Angeles', 'en-US', '+1 206 555 0154', 'Daily 11:00–22:00', 'live', 'ok', P.blush, 1462500],
      ['fr', 'SEA-FR', 'Seattle – Fremont', '3500 Fremont Ave N', 'Seattle', 'WA', 'US', 'na', 'og_embernw', 'franchise', 'USD', 'America/Los_Angeles', 'en-US', '+1 206 555 0182', 'Daily 11:00–21:00', 'live', 'attention', P.butter, 1098000],
      ['gv', 'VAN-GT', 'Vancouver – Gastown', '12 Water St', 'Vancouver', 'BC', 'CA', 'na', 'og_company', 'company', 'CAD', 'America/Vancouver', 'en-CA', '+1 604 555 0166', 'Daily 11:00–23:00', 'live', 'ok', P.lime, 1210000],
      ['bo', 'LDN-BO', 'London – Borough', '9 Stoney St', 'London', undefined, 'GB', 'eu', 'og_borough', 'franchise', 'GBP', 'Europe/London', 'en-GB', '+44 20 7946 0555', 'Tue–Sun 12:00–22:00', 'live', 'ok', P.aqua, 803000],
      ['kr', 'BER-KR', 'Berlin – Kreuzberg', 'Oranienstraße 22', 'Berlin', undefined, 'DE', 'eu', 'og_company', 'company', 'EUR', 'Europe/Berlin', 'de-DE', '+49 30 555 0178', 'Opens 15 Nov', 'unpublished', 'ok', P.sage, 0],
    ] as L[]).map(mk('Restaurant · v11')),
    localLocationId: 'bl', staffLocationId: 'bl', people: { hq: 'Jamie Morgan', local: 'Carlos Ortega', staff: 'Mei Lin' },
  },
};

export function fixture(ind: IndustryKey): IndustryFixture {
  return FIXTURES[ind];
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function sessionFor(ind: IndustryKey, role: ViewRole): Session {
  const f = FIXTURES[ind];
  const name = f.people[role];
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${f.org.brand.toLowerCase().replace(/[^a-z]+/g, '')}-sample.com`;
  const org = { kind: 'organization' as const, id: f.org.id };
  if (role === 'hq') return { user: { id: 'u_hq', name, email, initials: initialsOf(name) }, role, assignments: [{ role: 'org_owner', scope: org }], locationIds: [] };
  if (role === 'local') return { user: { id: 'u_local', name, email, initials: initialsOf(name) }, role, assignments: [{ role: 'location_manager', scope: { kind: 'location', id: f.localLocationId } }], locationIds: [f.localLocationId] };
  return { user: { id: 'u_staff', name, email, initials: initialsOf(name) }, role, assignments: [{ role: 'staff', scope: { kind: 'location', id: f.staffLocationId } }], locationIds: [f.staffLocationId] };
}

export function visibleLocations(ind: IndustryKey, role: ViewRole) {
  const f = FIXTURES[ind];
  const s = sessionFor(ind, role);
  return s.locationIds.length ? f.locations.filter((l) => s.locationIds.includes(l.id)) : f.locations;
}

export function scopeOptions(ind: IndustryKey, role: ViewRole): ScopeOptionT[] {
  const f = FIXTURES[ind];
  const locs = visibleLocations(ind, role);
  const ids = locs.map((l) => l.id);
  const out: ScopeOptionT[] = [{ id: 'all', kind: 'all', label: 'All authorised locations', locationIds: ids }];
  if (role === 'hq') {
    for (const r of f.org.regions) {
      const li = locs.filter((l) => l.regionId === r.id).map((l) => l.id);
      if (li.length) out.push({ id: `region:${r.id}`, kind: 'region', label: r.name, locationIds: li });
    }
    for (const g of f.org.ownerGroups) {
      const li = locs.filter((l) => l.ownerGroupId === g.id).map((l) => l.id);
      if (li.length > 1) out.push({ id: `group:${g.id}`, kind: 'owner_group', label: g.name, locationIds: li });
    }
  }
  for (const l of locs) out.push({ id: `loc:${l.id}`, kind: 'location', label: l.name, locationIds: [l.id] });
  return out;
}

export function scopeLocationIds(ind: IndustryKey, role: ViewRole, scopeId: string): string[] {
  const opts = scopeOptions(ind, role);
  return (opts.find((o) => o.id === scopeId) ?? opts[0]!).locationIds;
}

export function loc(ind: IndustryKey, id: string) {
  return FIXTURES[ind].locations.find((l) => l.id === id)!;
}

/** ISO instant for a local wall time at a location, `dayOffset` days from its today. */
export function at(tz: string, hhmm: string, dayOffset = 0, now: Date = new Date()): string {
  return zonedToUtc(addDays(dateInZone(now, tz), dayOffset), hhmm, tz);
}

export function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60000).toISOString();
}
