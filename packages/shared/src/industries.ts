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
