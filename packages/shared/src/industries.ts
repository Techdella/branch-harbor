/**
 * One industry per business account (docs/PRODUCT_PLAN.md decision 1): chosen at sign-up, it fixes the screens,
 * words, reports, website modules and mobile app. It cannot be changed through the normal API (only by a platform
 * admin, audited). A group running two industries has two business accounts under one login.
 */
export const INDUSTRIES = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty', 'hospitality'] as const;
export type Industry = (typeof INDUSTRIES)[number];

/**
 * Release state. Every industry launches together and is available for self-service sign-up; the type is kept so
 * clients reading `/v1/public/industries` keep a stable field.
 */
export const INDUSTRY_RELEASES = ['available'] as const;
export type IndustryRelease = (typeof INDUSTRY_RELEASES)[number];

export interface IndustryMeta {
  key: Industry;
  name: string;
  customerNoun: string;
  staffNoun: string;
  primaryCta: string;
  workflow: string;
  /** Release state (every industry is available). */
  release: IndustryRelease;
}

export const INDUSTRY_META: Record<Industry, IndustryMeta> = {
  studios: { key: 'studios', name: 'Studios', customerNoun: 'Members', staffNoun: 'Instructor', primaryCta: 'Book a class', workflow: 'Enquiry → trial → class → membership', release: 'available' },
  sports: { key: 'sports', name: 'Sports', customerNoun: 'Participants', staffNoun: 'Coach', primaryCta: 'Register', workflow: 'Registration → group assignment → attendance', release: 'available' },
  wellness: { key: 'wellness', name: 'Health & Wellness', customerNoun: 'Clients', staffNoun: 'Practitioner', primaryCta: 'Book an appointment', workflow: 'Service → practitioner → appointment', release: 'available' },
  commerce: { key: 'commerce', name: 'Commerce', customerNoun: 'Customers', staffNoun: 'Store associate', primaryCta: 'Shop now', workflow: 'Discovery → order → fulfilment', release: 'available' },
  foods: { key: 'foods', name: 'Foods', customerNoun: 'Guests', staffNoun: 'Kitchen lead', primaryCta: 'Order pickup', workflow: 'Location → menu → order → pickup', release: 'available' },
  realty: { key: 'realty', name: 'Real Estate', customerNoun: 'Buyers & sellers', staffNoun: 'Agent', primaryCta: 'Book a viewing', workflow: 'Listing → enquiry → viewing → offer', release: 'available' },
  hospitality: { key: 'hospitality', name: 'Hospitality', customerNoun: 'Guests', staffNoun: 'Front desk', primaryCta: 'Book a stay', workflow: 'Availability → reservation → check-in → check-out', release: 'available' },
};

/* ------------------------------------------------------------------ */
/* Industry details of a location                                      */
/* ------------------------------------------------------------------ */

/**
 * Industry-specific details asked when a location is added (Network → Locations → Add location). Stored on the
 * location (`settings.industry`) and used as the starting values of the industry's own setup (rooms, seats, pitches…).
 * Labels are translated by the clients (`wizard.industryField.<key>`); option values as
 * `wizard.industryOption.<key>.<value>`.
 */
export type LocationIndustryField =
  | { key: string; type: 'number'; min: number; max: number }
  | { key: string; type: 'text'; maxLength: number; pattern?: string }
  | { key: string; type: 'select'; options: readonly string[] }
  | { key: string; type: 'boolean' };

export const LOCATION_INDUSTRY_FIELDS: Record<Industry, readonly LocationIndustryField[]> = {
  studios: [
    { key: 'studioRooms', type: 'number', min: 1, max: 50 },
    { key: 'maxClassSize', type: 'number', min: 1, max: 500 },
    { key: 'showers', type: 'boolean' },
  ],
  sports: [
    { key: 'pitches', type: 'number', min: 0, max: 100 },
    { key: 'surface', type: 'select', options: ['grass', 'artificial', 'indoor', 'mixed'] },
    { key: 'minAge', type: 'number', min: 0, max: 99 },
  ],
  wellness: [
    { key: 'treatmentRooms', type: 'number', min: 1, max: 100 },
    { key: 'clinicRegistration', type: 'text', maxLength: 80 },
    { key: 'stepFreeAccess', type: 'boolean' },
  ],
  commerce: [
    { key: 'storeType', type: 'select', options: ['store', 'outlet', 'popup', 'warehouse'] },
    { key: 'salesFloorM2', type: 'number', min: 0, max: 100_000 },
    { key: 'clickAndCollect', type: 'boolean' },
  ],
  foods: [
    { key: 'serviceStyle', type: 'select', options: ['counter', 'table', 'takeaway', 'ghost_kitchen'] },
    { key: 'seats', type: 'number', min: 0, max: 2000 },
    { key: 'alcoholLicence', type: 'boolean' },
  ],
  realty: [
    { key: 'officeLicence', type: 'text', maxLength: 80 },
    { key: 'agents', type: 'number', min: 0, max: 1000 },
    { key: 'serviceArea', type: 'text', maxLength: 200 },
  ],
  hospitality: [
    { key: 'guestRooms', type: 'number', min: 1, max: 5000 },
    { key: 'checkInTime', type: 'text', maxLength: 5, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    { key: 'checkOutTime', type: 'text', maxLength: 5, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
  ],
};

export type LocationIndustryValues = Record<string, string | number | boolean>;

/**
 * Checks industry details against the industry's fields: unknown keys and invalid values are reported per key, empty
 * values are dropped. Returns the clean values.
 */
export function validateLocationIndustryFields(industry: Industry | string, input: Record<string, unknown>): { values: LocationIndustryValues; errors: Record<string, string> } {
  const fields = LOCATION_INDUSTRY_FIELDS[industry as Industry] ?? [];
  const values: LocationIndustryValues = {};
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const f = fields.find((x) => x.key === k);
    if (!f) { errors[k] = 'Not a detail of this industry'; continue; }
    if (v === null || v === undefined || v === '') continue;
    if (f.type === 'number') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < f.min || n > f.max) errors[k] = `A whole number from ${f.min} to ${f.max}`;
      else values[k] = n;
    } else if (f.type === 'boolean') {
      if (typeof v !== 'boolean') errors[k] = 'Yes or no';
      else values[k] = v;
    } else if (f.type === 'select') {
      if (typeof v !== 'string' || !f.options.includes(v)) errors[k] = `One of: ${f.options.join(', ')}`;
      else values[k] = v;
    } else {
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s || s.length > f.maxLength || (f.pattern && !new RegExp(f.pattern).test(s))) errors[k] = f.pattern ? 'Use the format HH:MM' : `Up to ${f.maxLength} characters`;
      else values[k] = s;
    }
  }
  return { values, errors };
}
