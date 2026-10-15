/**
 * One industry per business account (docs/PRODUCT_PLAN.md decision 1): chosen at sign-up, it fixes the screens,
 * words, reports, website modules and mobile app. It cannot be changed through the normal API (only by a platform
 * admin, audited). A group running two industries has two business accounts under one login.
 */
export const INDUSTRIES = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty', 'hospitality'] as const;
export type Industry = (typeof INDUSTRIES)[number];

export interface IndustryMeta {
  key: Industry;
  name: string;
  customerNoun: string;
  staffNoun: string;
  primaryCta: string;
  workflow: string;
  /** Release status — never expose 'planned' modules as working features. */
  release: 'pilot' | 'next' | 'planned';
}

export const INDUSTRY_META: Record<Industry, IndustryMeta> = {
  studios: { key: 'studios', name: 'Studios', customerNoun: 'Members', staffNoun: 'Instructor', primaryCta: 'Book a class', workflow: 'Enquiry → trial → class → membership', release: 'pilot' },
  sports: { key: 'sports', name: 'Sports', customerNoun: 'Participants', staffNoun: 'Coach', primaryCta: 'Register', workflow: 'Registration → group assignment → attendance', release: 'next' },
  wellness: { key: 'wellness', name: 'Health & Wellness', customerNoun: 'Clients', staffNoun: 'Practitioner', primaryCta: 'Book an appointment', workflow: 'Service → practitioner → appointment', release: 'next' },
  commerce: { key: 'commerce', name: 'Commerce', customerNoun: 'Customers', staffNoun: 'Store associate', primaryCta: 'Shop now', workflow: 'Discovery → order → fulfilment', release: 'next' },
  foods: { key: 'foods', name: 'Foods', customerNoun: 'Guests', staffNoun: 'Kitchen lead', primaryCta: 'Order pickup', workflow: 'Location → menu → order → pickup', release: 'next' },
  realty: { key: 'realty', name: 'Real Estate', customerNoun: 'Buyers & sellers', staffNoun: 'Agent', primaryCta: 'Book a viewing', workflow: 'Listing → enquiry → viewing → offer', release: 'next' },
  hospitality: { key: 'hospitality', name: 'Hospitality', customerNoun: 'Guests', staffNoun: 'Front desk', primaryCta: 'Book a stay', workflow: 'Availability → reservation → check-in → check-out', release: 'next' },
};
