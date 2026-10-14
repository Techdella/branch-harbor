/**
 * Real Estate (`realty`) domain rules shared by the API, business app, customer sites and mobile app.
 * Pure functions only — no I/O. See docs/verticals/real-estate.md.
 */

// ───────── Listings ─────────

export const LISTING_TRANSACTIONS = ['sale', 'rent'] as const;
export type ListingTransaction = (typeof LISTING_TRANSACTIONS)[number];

export const PROPERTY_TYPES = ['house', 'townhouse', 'apartment', 'condo', 'land', 'commercial', 'other'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const LISTING_STATUSES = ['draft', 'coming_soon', 'active', 'under_offer', 'sold', 'let', 'withdrawn'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Statuses customers can see on websites and in the app. */
export const PUBLIC_LISTING_STATUSES: readonly ListingStatus[] = ['coming_soon', 'active', 'under_offer'];
/** Statuses that publish a listing (and therefore need HQ approval in managed/standard offices). */
export const PUBLISHING_STATUSES: readonly ListingStatus[] = ['coming_soon', 'active'];
export const CLOSED_LISTING_STATUSES: readonly ListingStatus[] = ['sold', 'let'];

const LISTING_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ['coming_soon', 'active', 'withdrawn'],
  coming_soon: ['active', 'withdrawn', 'draft'],
  active: ['under_offer', 'withdrawn', 'sold', 'let'],
  under_offer: ['active', 'sold', 'let', 'withdrawn'],
  sold: [],
  let: [],
  withdrawn: ['draft'],
};

/**
 * Whether a listing may move from `from` to `to`. Sale listings close as `sold`, rentals as `let`.
 * Returns a reason code when not allowed.
 */
export function listingTransition(from: ListingStatus, to: ListingStatus, transaction: ListingTransaction): { ok: true } | { ok: false; reason: string } {
  if (from === to) return { ok: false, reason: 'same_status' };
  if (!LISTING_TRANSITIONS[from].includes(to)) return { ok: false, reason: 'invalid_transition' };
  if (to === 'sold' && transaction !== 'sale') return { ok: false, reason: 'rentals_are_let_not_sold' };
  if (to === 'let' && transaction !== 'rent') return { ok: false, reason: 'sales_are_sold_not_let' };
  return { ok: true };
}

export function allowedListingTransitions(from: ListingStatus, transaction: ListingTransaction): ListingStatus[] {
  return LISTING_TRANSITIONS[from].filter((to) => listingTransition(from, to, transaction).ok);
}

// ───────── Office governance ─────────

/** Office governance tiers from the HQ prototypes. */
export const OFFICE_TIERS = ['managed', 'standard', 'flexible'] as const;
export type OfficeTier = (typeof OFFICE_TIERS)[number];

/** Managed and standard offices need HQ approval to publish listings or change published marketing content. */
export const tierRequiresApproval = (tier: OfficeTier): boolean => tier !== 'flexible';

export const LEAD_ROUTING_MODES = ['listing_agent', 'round_robin', 'office_pool'] as const;
export type LeadRoutingMode = (typeof LEAD_ROUTING_MODES)[number];

// ───────── Area ─────────

export const AREA_UNITS = ['sqft', 'sqm'] as const;
export type AreaUnit = (typeof AREA_UNITS)[number];
/** Exact by definition (international foot = 0.3048 m). */
export const SQM_PER_SQFT = 0.09290304;

export function toSqm(value: number, unit: AreaUnit): number {
  return unit === 'sqm' ? value : value * SQM_PER_SQFT;
}
export function fromSqm(sqm: number, unit: AreaUnit): number {
  return unit === 'sqm' ? sqm : sqm / SQM_PER_SQFT;
}
/** Display value rounded to a whole unit (areas are never shown with false precision). */
export function areaIn(sqm: number | null | undefined, unit: AreaUnit): number | null {
  if (sqm == null || !Number.isFinite(sqm)) return null;
  return Math.round(fromSqm(sqm, unit));
}
const UNIT_LABEL: Record<AreaUnit, string> = { sqft: 'sq ft', sqm: 'm²' };
export const areaUnitLabel = (unit: AreaUnit) => UNIT_LABEL[unit];
export function formatArea(sqm: number | null | undefined, unit: AreaUnit, locale = 'en'): string | null {
  const v = areaIn(sqm, unit);
  if (v == null) return null;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v)} ${UNIT_LABEL[unit]}`;
}
/** Countries that customarily advertise in square feet; everyone else defaults to m². Offices can override. */
const SQFT_COUNTRIES = new Set(['US', 'CA', 'GB', 'AE', 'IN']);
export const defaultAreaUnit = (country: string): AreaUnit => (SQFT_COUNTRIES.has(country.toUpperCase()) ? 'sqft' : 'sqm');

// ───────── Addresses ─────────

export interface ListingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country: string;
}

/**
 * Address lines in the customary order for the country. Unknown countries get a neutral
 * "street / postcode city / region" layout. `public` hides the street line when the business chose to.
 */
export function formatAddressLines(a: ListingAddress, opts: { hideStreet?: boolean } = {}): string[] {
  const street = opts.hideStreet ? [] : [a.line1, a.line2].filter((x): x is string => !!x);
  const pc = a.postalCode ?? '';
  const region = a.region ?? '';
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ').trim();
  switch (a.country.toUpperCase()) {
    case 'US':
    case 'CA':
    case 'AU':
      return [...street, join(`${a.city}${region ? ',' : ''}`, region, opts.hideStreet ? '' : pc)].filter(Boolean);
    case 'GB':
    case 'IE':
      return [...street, a.city, ...(opts.hideStreet ? [] : [pc])].filter(Boolean);
    case 'AE':
      // No postcodes in the UAE; emirate after the community/city.
      return [...street, join(a.city), region].filter(Boolean);
    case 'ES':
    case 'FR':
    case 'DE':
    case 'NL':
    case 'IT':
    case 'PT':
      return [...street, join(opts.hideStreet ? '' : pc, a.city), region].filter(Boolean);
    default:
      return [...street, join(opts.hideStreet ? '' : pc, a.city), region].filter(Boolean);
  }
}

// ───────── Enquiries, viewings, offers ─────────

export const ENQUIRY_SOURCES = ['website', 'mobile', 'phone', 'walk_in', 'email', 'portal_zillow', 'portal_realtor_ca', 'portal_rightmove', 'portal_idealista', 'other'] as const;
export type EnquirySource = (typeof ENQUIRY_SOURCES)[number];
export const ENQUIRY_KINDS = ['buyer', 'tenant', 'valuation', 'landlord', 'general'] as const;
export const ENQUIRY_STATUSES = ['new', 'contacted', 'viewing_booked', 'offer_made', 'closed', 'lost'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const VIEWING_STATUSES = ['requested', 'confirmed', 'completed', 'no_show', 'cancelled'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];
/** Viewings in these states hold the agent's time. */
export const VIEWING_BLOCKING_STATUSES: readonly ViewingStatus[] = ['requested', 'confirmed'];
export const INTEREST_LEVELS = ['none', 'low', 'medium', 'high'] as const;

export const OFFER_STATUSES = ['submitted', 'countered', 'accepted', 'rejected', 'withdrawn'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
const OFFER_TRANSITIONS: Record<OfferStatus, readonly OfferStatus[]> = {
  submitted: ['countered', 'accepted', 'rejected', 'withdrawn'],
  // A countered offer goes back to `submitted` when the buyer revises it.
  countered: ['submitted', 'accepted', 'rejected', 'withdrawn'],
  accepted: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};
export const offerTransitionAllowed = (from: OfferStatus, to: OfferStatus) => OFFER_TRANSITIONS[from].includes(to);
export const OPEN_OFFER_STATUSES: readonly OfferStatus[] = ['submitted', 'countered'];

// ───────── Fair housing ─────────

/**
 * Protected characteristics (union across common jurisdictions: US FHA, Canadian human-rights codes, UK Equality Act,
 * EU anti-discrimination directives, …). Never used as a filter, audience rule, saved-search criterion or AI target.
 */
export const PROTECTED_CHARACTERISTICS = [
  'race', 'colour', 'religion', 'national_origin', 'ethnicity', 'sex', 'gender_identity', 'sexual_orientation',
  'familial_status', 'disability', 'age', 'marital_status', 'source_of_income', 'citizenship', 'pregnancy',
] as const;

/** The only criteria a buyer search, saved search or follow-up audience may use. */
export const ALLOWED_AUDIENCE_CRITERIA = [
  'listingId', 'locationId', 'transaction', 'propertyTypes', 'minPrice', 'maxPrice', 'currency', 'minBedrooms', 'minBathrooms',
  'minArea', 'areaUnit', 'city', 'enquiryStatus', 'interestLevel', 'lastContactBeforeDays', 'savedSearchMatches',
] as const;

const PROTECTED_KEY = /^(race|racial|colou?r|religio|faith|national|nationality|origin|ethnic|citizen|immigra|sex|gender|orientation|famil|children|kids|disab|handicap|age|ageRange|birth|dob|marital|married|pregnan|income_source|sourceOfIncome|benefits)/i;

const GROUP = [
  'kids', 'children', 'child', 'families', 'family(?![- ](?:room|rooms|bathroom|kitchen|home|sized?|dining))', 'singles?', 'couples?', 'bachelors?', 'empty[- ]nesters?', 'newlyweds?',
  'christians?', 'muslims?', 'jews?', 'jewish', 'hindus?', 'sikhs?', 'catholics?', 'buddhists?', 'atheists?', 'churchgoers?',
  'whites?', 'blacks?', 'asians?', 'hispanics?', 'latinos?', 'latinas?', 'arabs?', 'immigrants?', 'foreigners?', 'expats?', 'locals only', 'natives?',
  'disabled', 'disabilit(?:y|ies)', 'wheelchair users?', 'handicapped', 'the elderly', 'elderly', 'seniors?', 'retirees?', 'pensioners?',
  'young(?: people| professionals| couples| buyers)?', 'millennials?', 'students?', 'gays?', 'lesbians?', 'lgbtq?\\+?', 'straight',
  'men', 'women', 'males?', 'females?', 'ladies', 'gentlemen', 'pregnant', 'married', 'unmarried', 'single (?:mothers?|parents?|fathers?)',
  'section 8', 'housing benefit', 'dss', 'welfare', 'benefits claimants?',
];
const TARGET_VERB = '(?:no|not|without|exclude|excluding|except|only|avoid|target|targeting|aimed at|just for|ideal for|perfect for|great for|suited to|suitable for|prefer|preferred|preferably|restricted to|reserved for|limit to|filter (?:by|on|to|out)|segment by|exclusively for|only for)';
const STEERING = new RegExp(`\\b${TARGET_VERB}\\b[^.!?\\n]{0,40}?\\b(${GROUP.join('|')})\\b`, 'i');
const POSTFIX = new RegExp(`\\b(${GROUP.join('|')})\\s+(?:only|preferred|need not apply|not welcome|not allowed)\\b`, 'i');
const ATTRIBUTE = /\b(?:by|based on|according to|filter(?:ed)? by|segment(?:ed)? by|target(?:ed|ing)? by)\s+(?:their\s+)?(race|ethnicity|religion|nationality|national origin|age|gender|sex|sexual orientation|family status|familial status|marital status|disability|citizenship|immigration status|source of income)\b/i;

export interface FairHousingFinding {
  phrase: string;
  characteristic: string;
}

/**
 * Detects language that targets, steers, excludes or prefers people by a protected characteristic
 * ("no kids", "perfect for young professionals", "target Christian families", "filter by age").
 * Returns findings; an empty list means nothing was detected (not a legal clearance).
 */
export function findProtectedTargeting(text: string): FairHousingFinding[] {
  const out: FairHousingFinding[] = [];
  if (!text) return out;
  const re1 = new RegExp(STEERING.source, 'gi');
  for (const m of text.matchAll(re1)) out.push({ phrase: m[0].trim(), characteristic: classify(m[1] ?? '') });
  const re3 = new RegExp(POSTFIX.source, 'gi');
  for (const m of text.matchAll(re3)) if (!out.some((f) => f.phrase.includes(m[0].trim()))) out.push({ phrase: m[0].trim(), characteristic: classify(m[1] ?? '') });
  const re2 = new RegExp(ATTRIBUTE.source, 'gi');
  for (const m of text.matchAll(re2)) out.push({ phrase: m[0].trim(), characteristic: classify(m[1] ?? '') });
  return out;
}

/** Keys in a criteria object that refer to protected characteristics. */
export function protectedCriteriaKeys(criteria: Record<string, unknown>): string[] {
  return Object.keys(criteria).filter((k) => PROTECTED_KEY.test(k) && !(ALLOWED_AUDIENCE_CRITERIA as readonly string[]).includes(k));
}

function classify(word: string): string {
  const w = word.toLowerCase();
  if (/kid|child|famil|single|couple|bachelor|nester|newlywed|pregnan|married|unmarried|parent|mother|father/.test(w)) return /pregnan/.test(w) ? 'pregnancy' : /married/.test(w) ? 'marital_status' : 'familial_status';
  if (/christ|muslim|jew|hindu|sikh|catholic|buddh|athe|church|religio/.test(w)) return 'religion';
  if (/white|black|asian|hispanic|latin|arab|race|ethnic/.test(w)) return 'race';
  if (/immigra|foreign|expat|local|native|national|citizen/.test(w)) return 'national_origin';
  if (/disab|wheelchair|handicap/.test(w)) return 'disability';
  if (/elder|senior|retire|pension|young|millennial|student|age/.test(w)) return 'age';
  if (/gay|lesbian|lgbt|straight|orientation/.test(w)) return 'sexual_orientation';
  if (/\bmen\b|women|male|female|lad|gentle|gender|sex/.test(w)) return 'sex';
  if (/section 8|benefit|dss|welfare|income/.test(w)) return 'source_of_income';
  return 'protected_characteristic';
}
