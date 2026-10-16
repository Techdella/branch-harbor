/**
 * Local marketing for networks (docs/API_INTEGRATIONS.md "Listings", "Call tracking"; research §3, §7 and §12):
 *
 * - **Listings**: one source of truth per location (name, address, phone, weekly and special/holiday hours, categories,
 *   description, photos, website and booking links, attributes), pushed to Google Business Profile, Apple Business
 *   Connect and Bing Places, with drift detection, HQ field locks and a health score. Name, address, phone and hours
 *   live on the location itself (`locations`), so hosted sites and listings never disagree.
 * - **Review responses in the inbox**: Google reviews become inbox conversations; reply templates and SLA timers.
 * - **Co-op / local marketing fund**: allowances, pre-approval with a brand checklist, claims with proof, reimbursement.
 * - **Call tracking**: tracking numbers per campaign or location, forwarding, optional recording disclosure, missed
 *   call leads and dynamic number insertion on hosted sites.
 * - **Local social**: an HQ content calendar that locations localise and schedule on their own accounts.
 *
 * Pure helpers only (no I/O): shared by the API, the dashboard and the hosted sites.
 */
import { z } from 'zod';
import type { Locale } from './locale.ts';

/* ------------------------------------------------------------------ */
/* Listings                                                            */
/* ------------------------------------------------------------------ */

export const LISTING_PROVIDERS = ['google', 'apple', 'bing'] as const;
export type ListingProvider = (typeof LISTING_PROVIDERS)[number];

/** Fields of a listing. `name`, `address`, `phone`, `hours` and `specialHours` are stored on the location itself. */
export const LISTING_FIELDS = ['name', 'address', 'phone', 'hours', 'specialHours', 'categories', 'description', 'photos', 'websiteUrl', 'bookingUrl', 'attributes'] as const;
export type ListingField = (typeof LISTING_FIELDS)[number];

/** Who may change a field: HQ only (locked), the location, or the location with HQ approval. */
export const LISTING_FIELD_POLICIES = ['hq', 'location', 'location_approval'] as const;
export type ListingFieldPolicy = (typeof LISTING_FIELD_POLICIES)[number];

/** Defaults: brand identity locked; hours and photos are the location's; the description needs HQ approval. */
export const DEFAULT_LISTING_POLICY: Record<ListingField, ListingFieldPolicy> = {
  name: 'hq', address: 'hq', phone: 'hq', hours: 'location', specialHours: 'location', categories: 'hq',
  description: 'location_approval', photos: 'location', websiteUrl: 'hq', bookingUrl: 'hq', attributes: 'location',
};

/**
 * Fields each directory accepts from BranchHarbor. Google: photos go through the separate Media API and booking links
 * through Place Actions, neither of which BranchHarbor pushes yet; Bing has no attributes.
 */
export const PROVIDER_FIELDS: Record<ListingProvider, readonly ListingField[]> = {
  google: ['name', 'address', 'phone', 'hours', 'specialHours', 'categories', 'description', 'websiteUrl'],
  apple: ['name', 'address', 'phone', 'hours', 'specialHours', 'categories', 'description', 'photos', 'websiteUrl', 'bookingUrl'],
  bing: ['name', 'address', 'phone', 'hours', 'specialHours', 'categories', 'description', 'photos', 'websiteUrl'],
};

const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'HH:MM');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const httpsUrl = z.url().max(2000).refine((u) => /^https:\/\//.test(u), 'Use an https link');

export const weeklyHourSchema = z.object({ day: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm });
export type WeeklyHour = z.infer<typeof weeklyHourSchema>;

/** One date with different hours (holiday, event) — closed all day, or open between `opens` and `closes`. */
export const specialHourSchema = z.object({
  date: ymd,
  closed: z.boolean(),
  opens: hhmm.nullable().optional(),
  closes: hhmm.nullable().optional(),
  label: z.string().trim().max(80).nullable().optional(),
}).refine((s) => s.closed || (!!s.opens && !!s.closes), { message: 'Give opening and closing times, or mark the day closed', path: ['opens'] });
export type SpecialHour = z.infer<typeof specialHourSchema>;

export const LISTING_PHOTO_KINDS = ['logo', 'cover', 'exterior', 'interior', 'team', 'product', 'other'] as const;
export const listingPhotoSchema = z.object({ url: httpsUrl, kind: z.enum(LISTING_PHOTO_KINDS).default('other'), assetId: z.string().max(64).nullable().optional(), alt: z.string().max(200).default('') });
export type ListingPhoto = z.infer<typeof listingPhotoSchema>;

export const listingAddressSchema = z.object({
  line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).optional(), city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(), postalCode: z.string().trim().max(20).optional(), country: z.string().length(2),
});

export const listingCategoriesSchema = z.object({ primary: z.string().trim().max(120).nullable(), additional: z.array(z.string().trim().min(1).max(120)).max(9) });

/** Attributes are directory flags (wheelchair access, free Wi-Fi, …): yes/no or a short value. */
export const listingAttributesSchema = z.record(z.string().regex(/^[a-z0-9_]{2,60}$/), z.union([z.boolean(), z.string().max(120)]));

/** The full canonical listing of a location, as pushed to directories and compared for drift. */
export interface ListingSnapshot {
  name: string;
  address: z.infer<typeof listingAddressSchema>;
  phone: string | null;
  hours: WeeklyHour[];
  specialHours: SpecialHour[];
  categories: { primary: string | null; additional: string[] };
  description: string | null;
  photos: ListingPhoto[];
  websiteUrl: string | null;
  bookingUrl: string | null;
  attributes: Record<string, boolean | string>;
}

/** A change to a listing (any subset of fields). */
export const listingPatchSchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: listingAddressSchema,
  phone: z.string().trim().min(5).max(40).nullable(),
  hours: z.array(weeklyHourSchema).max(28),
  specialHours: z.array(specialHourSchema).max(60),
  categories: listingCategoriesSchema,
  description: z.string().trim().max(750).nullable(),
  photos: z.array(listingPhotoSchema).max(30),
  websiteUrl: httpsUrl.nullable(),
  bookingUrl: httpsUrl.nullable(),
  attributes: listingAttributesSchema,
}).partial();
export type ListingPatch = z.infer<typeof listingPatchSchema>;

const digits = (p: string | null | undefined) => (p ?? '').replace(/[^0-9+]/g, '').replace(/^00/, '+');
const sortHours = (h: WeeklyHour[]) => [...h].sort((a, b) => a.day - b.day || a.opens.localeCompare(b.opens)).map((x) => `${x.day}:${x.opens}-${x.closes}`).join(',');
const sortSpecial = (h: SpecialHour[], from?: string) => [...h].filter((x) => !from || x.date >= from).sort((a, b) => a.date.localeCompare(b.date)).map((x) => (x.closed ? `${x.date}:closed` : `${x.date}:${x.opens}-${x.closes}`)).join(',');
const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Comparable form of one field (formatting differences a directory introduces never count as drift). */
export function listingFieldKey(field: ListingField, s: ListingSnapshot, today?: string): string {
  switch (field) {
    case 'name': return norm(s.name);
    case 'address': return [s.address.line1, s.address.line2, s.address.city, s.address.region, s.address.postalCode, s.address.country].map(norm).join('|');
    case 'phone': return digits(s.phone).replace(/^\+?1(?=\d{10}$)/, '');
    case 'hours': return sortHours(s.hours);
    case 'specialHours': return sortSpecial(s.specialHours, today);
    case 'categories': return [norm(s.categories.primary), ...s.categories.additional.map(norm).sort()].join('|');
    case 'description': return norm(s.description);
    case 'photos': return s.photos.map((p) => p.url).sort().join('|');
    case 'websiteUrl': return norm(s.websiteUrl).replace(/\/$/, '');
    case 'bookingUrl': return norm(s.bookingUrl).replace(/\/$/, '');
    case 'attributes': return Object.entries(s.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`).join('|');
  }
}

/**
 * Fields where the directory's copy differs from BranchHarbor's (drift: edited outside BranchHarbor, or a suggested
 * edit the directory accepted). Only fields the provider supports are compared; past special hours are ignored.
 */
export function diffListing(ours: ListingSnapshot, theirs: ListingSnapshot, provider: ListingProvider, today?: string): ListingField[] {
  return PROVIDER_FIELDS[provider].filter((f) => listingFieldKey(f, ours, today) !== listingFieldKey(f, theirs, today));
}

/** Applies a patch to a snapshot (used for "accept the directory's value" and previews). */
export function applyListingPatch(s: ListingSnapshot, p: ListingPatch): ListingSnapshot {
  return { ...s, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as ListingSnapshot;
}

/** Special hours for one date from the location, if any (for "open now" and the hosted site). */
export function specialHoursOn(special: readonly SpecialHour[] | null | undefined, date: string): SpecialHour | null {
  return special?.find((s) => s.date === date) ?? null;
}

/** Merges bulk holiday hours into a location's special hours (same date replaced, sorted, past dates kept). */
export function mergeSpecialHours(existing: readonly SpecialHour[], incoming: readonly SpecialHour[]): SpecialHour[] {
  const by = new Map(existing.map((s) => [s.date, s]));
  for (const s of incoming) by.set(s.date, s);
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface ListingHealthInput {
  listing: ListingSnapshot;
  /** Directories connected for this location, and their sync state. */
  syncs: Array<{ provider: ListingProvider; status: 'synced' | 'pending' | 'drift' | 'error' | 'not_connected' }>;
  openDrifts: number;
  pendingChanges: number;
  /** Network holiday dates in the next 60 days (from bulk holiday hours) the location has no special hours for. */
  missingHolidayDates: number;
}

export const LISTING_HEALTH_CHECKS = ['phone', 'hours', 'holidayHours', 'categories', 'description', 'photos', 'website', 'booking', 'connected', 'synced', 'noDrift'] as const;
export type ListingHealthCheck = (typeof LISTING_HEALTH_CHECKS)[number];
const HEALTH_WEIGHTS: Record<ListingHealthCheck, number> = { phone: 10, hours: 15, holidayHours: 10, categories: 10, description: 8, photos: 7, website: 5, booking: 5, connected: 10, synced: 10, noDrift: 10 };

/** Listing health 0–100 with the failing checks (each check has a fixed weight; weights sum to 100). */
export function listingHealth(input: ListingHealthInput): { score: number; checks: Array<{ key: ListingHealthCheck; ok: boolean; weight: number }> } {
  const l = input.listing;
  const connected = input.syncs.filter((s) => s.status !== 'not_connected');
  const ok: Record<ListingHealthCheck, boolean> = {
    phone: digits(l.phone).length >= 7,
    hours: l.hours.length > 0,
    holidayHours: input.missingHolidayDates === 0,
    categories: !!l.categories.primary,
    description: (l.description ?? '').trim().length >= 80,
    photos: l.photos.length >= 3,
    website: !!l.websiteUrl,
    booking: !!l.bookingUrl,
    connected: connected.length > 0,
    synced: connected.length > 0 && connected.every((s) => s.status === 'synced') && input.pendingChanges === 0,
    noDrift: input.openDrifts === 0,
  };
  const checks = LISTING_HEALTH_CHECKS.map((key) => ({ key, ok: ok[key], weight: HEALTH_WEIGHTS[key] }));
  return { score: checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0), checks };
}

/* ------------------------------------------------------------------ */
/* Review responses (inbox)                                            */
/* ------------------------------------------------------------------ */

/** Placeholders in review reply templates. */
export const REVIEW_REPLY_TOKENS = ['first_name', 'location', 'business'] as const;

export function fillReplyTemplate(text: string, values: Partial<Record<(typeof REVIEW_REPLY_TOKENS)[number], string>>): string {
  return text.replace(/\{(first_name|location|business)\}/g, (m, k: (typeof REVIEW_REPLY_TOKENS)[number]) => values[k] ?? m);
}

/** Templates that fit a rating, preferring the reviewer's language, then the location's own, then HQ's. */
export function pickReplyTemplates<T extends { minRating: number; maxRating: number; locale: string | null; locationId: string | null }>(templates: readonly T[], rating: number, locale: string | null): T[] {
  const lang = (l: string | null) => (l ?? '').split('-')[0]!.toLowerCase();
  return templates
    .filter((t) => rating >= t.minRating && rating <= t.maxRating)
    .sort((a, b) => Number(!!b.locationId) - Number(!!a.locationId) || Number(lang(b.locale) === lang(locale)) - Number(lang(a.locale) === lang(locale)));
}

/** When a reply to a review is due: negative reviews get the shorter SLA. */
export function reviewReplyDueAt(reviewedAt: Date, rating: number, sla: { positiveHours: number; negativeHours: number }, negativeMax = 2): Date {
  const h = rating <= negativeMax ? sla.negativeHours : sla.positiveHours;
  return new Date(reviewedAt.getTime() + h * 3_600_000);
}

/* ------------------------------------------------------------------ */
/* Co-op / local marketing fund                                        */
/* ------------------------------------------------------------------ */

export const COOP_PERIODS = ['month', 'quarter', 'year'] as const;
export type CoopPeriod = (typeof COOP_PERIODS)[number];
/** fund_percent: a share of what the location contributed to the marketing fund in the period; fixed: a set amount. */
export const COOP_BASES = ['fund_percent', 'fixed'] as const;
export type CoopBasis = (typeof COOP_BASES)[number];
export const COOP_SPEND_KINDS = ['ad', 'print', 'event', 'digital', 'sponsorship', 'other'] as const;
export type CoopSpendKind = (typeof COOP_SPEND_KINDS)[number];
export const COOP_REQUEST_STATUSES = ['submitted', 'changes_requested', 'approved', 'rejected', 'claimed', 'cancelled'] as const;
export const COOP_CLAIM_STATUSES = ['submitted', 'approved', 'rejected', 'paid'] as const;
export const COOP_PAYOUT_METHODS = ['bank_transfer', 'manual'] as const;
export type CoopPayoutMethod = (typeof COOP_PAYOUT_METHODS)[number];

/** Default brand compliance checklist HQ ticks when approving a pre-approval request (keys are translated in apps). */
export const DEFAULT_COOP_CHECKLIST = ['logo', 'colours_fonts', 'approved_claims', 'offer_terms', 'legal_disclaimer', 'local_details', 'placement'] as const;

/** First and last day (YYYY-MM-DD, inclusive start / exclusive end) of the co-op period containing `date`. */
export function coopPeriodBounds(period: CoopPeriod, date: string): { start: string; end: string; key: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (period === 'year') return { start: `${y}-01-01`, end: `${y + 1}-01-01`, key: `${y}` };
  if (period === 'quarter') {
    const q = Math.floor((m - 1) / 3);
    const sm = q * 3 + 1;
    const em = sm + 3;
    return { start: `${y}-${pad(sm)}-01`, end: em > 12 ? `${y + 1}-01-01` : `${y}-${pad(em)}-01`, key: `${y}-Q${q + 1}` };
  }
  return { start: `${y}-${pad(m)}-01`, end: m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`, key: `${y}-${pad(m)}` };
}

/** Allowance for a period: a percentage of the location's fund contributions in it, or the fixed amount. */
export function coopAllowance(rule: { basis: CoopBasis; percentBps: number; fixedMinor: number }, contributionsMinor: number): number {
  return rule.basis === 'fixed' ? Math.max(0, rule.fixedMinor) : Math.max(0, Math.floor((contributionsMinor * rule.percentBps) / 10_000));
}

/**
 * What HQ reimburses for a claim: the eligible spend (actual spend, capped at the pre-approved budget) times the
 * matching ratio (e.g. 5000 bps = HQ pays 50%), capped at the allowance left in the period.
 */
export function coopReimbursable(input: { spentMinor: number; approvedMinor: number; matchRatioBps: number; remainingMinor: number }): { eligibleMinor: number; reimbursableMinor: number; cappedByAllowance: boolean } {
  const eligibleMinor = Math.max(0, Math.min(input.spentMinor, input.approvedMinor));
  const matched = Math.floor((eligibleMinor * input.matchRatioBps) / 10_000);
  const reimbursableMinor = Math.max(0, Math.min(matched, input.remainingMinor));
  return { eligibleMinor, reimbursableMinor, cappedByAllowance: reimbursableMinor < matched };
}

/* ------------------------------------------------------------------ */
/* Call tracking                                                       */
/* ------------------------------------------------------------------ */

export const CALL_STATUSES = ['ringing', 'answered', 'missed', 'voicemail', 'busy', 'failed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * US states that require every party's consent to record a call (all-party consent). Elsewhere (Canada, the UK, the
 * EU, Australia…) recording needs at least a clear notice and a lawful basis. BranchHarbor keeps recording OFF by
 * default and only records where HQ switched it on for the location's jurisdiction with a disclosure message, which
 * is played to the caller before the call connects. This list is guidance, not legal advice.
 */
export const ALL_PARTY_CONSENT_US_STATES = ['CA', 'CT', 'DE', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'OR', 'PA', 'WA'] as const;

/** Jurisdiction key used for recording settings: `US-CA`, `CA-ON`, or just the country (`GB`). */
export function recordingJurisdiction(country: string, region?: string | null): string {
  const c = country.toUpperCase();
  return region && (c === 'US' || c === 'CA' || c === 'AU') ? `${c}-${region.toUpperCase()}` : c;
}

/** Recording rules for a jurisdiction: the specific key, then the country. Null = never record there. */
export function recordingRule(settings: { enabled: boolean; jurisdictions: Record<string, { message: string }> }, country: string, region?: string | null): { message: string } | null {
  if (!settings.enabled) return null;
  const rule = settings.jurisdictions[recordingJurisdiction(country, region)] ?? settings.jurisdictions[country.toUpperCase()];
  return rule && rule.message.trim().length >= 10 ? rule : null;
}

/** Default recording disclosure, played before the call connects. */
export const DEFAULT_RECORDING_DISCLOSURE: Record<Locale, string> = {
  en: 'This call may be recorded for quality and training.',
  'en-GB': 'This call may be recorded for quality and training purposes.',
  fr: 'Cet appel peut être enregistré à des fins de qualité et de formation.',
  es: 'Esta llamada puede ser grabada con fines de calidad y formación.',
  de: 'Dieser Anruf kann zu Qualitäts- und Schulungszwecken aufgezeichnet werden.',
  'pt-BR': 'Esta ligação pode ser gravada para fins de qualidade e treinamento.',
  nl: 'Dit gesprek kan worden opgenomen voor kwaliteits- en trainingsdoeleinden.',
  it: 'Questa chiamata può essere registrata per scopi di qualità e formazione.',
  ar: 'قد يتم تسجيل هذه المكالمة لأغراض الجودة والتدريب.',
};

/** What a visitor's session says about where they came from (UTM parameters and referrer host). */
export interface TrafficSource { utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; referrerHost?: string | null }

export interface DniRule { id: string; isDefault: boolean; match: { utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; referrerHost?: string | null } }

/**
 * Dynamic number insertion: the tracking number whose rule matches the visitor's source most specifically (campaign >
 * medium > source > referrer), else the location's default tracking number, else none (the site shows the real number).
 */
export function matchTrackingNumber<T extends DniRule>(rules: readonly T[], src: TrafficSource): T | null {
  const eq = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  let best: { r: T; score: number } | null = null;
  for (const r of rules) {
    const m = r.match;
    const keys = (['utmSource', 'utmMedium', 'utmCampaign', 'referrerHost'] as const).filter((k) => !!m[k]);
    if (!keys.length) continue;
    const host = (src.referrerHost ?? '').toLowerCase();
    const okAll = keys.every((k) => (k === 'referrerHost' ? !!host && (host === m.referrerHost!.toLowerCase() || host.endsWith(`.${m.referrerHost!.toLowerCase()}`)) : eq(m[k], src[k])));
    if (!okAll) continue;
    const score = (m.utmCampaign ? 8 : 0) + (m.utmMedium ? 4 : 0) + (m.utmSource ? 2 : 0) + (m.referrerHost ? 1 : 0);
    if (!best || score > best.score) best = { r, score };
  }
  return best?.r ?? rules.find((r) => r.isDefault) ?? null;
}

/** E.164 display grouping that keeps the digits (no locale guessing): +1 416 555 0142. */
export function formatE164(n: string): string {
  const d = n.replace(/[^0-9]/g, '');
  if (n.startsWith('+1') && d.length === 11) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  return n.startsWith('+') ? `+${d.slice(0, 2)} ${d.slice(2).replace(/(\d{3,4})(?=\d)/g, '$1 ')}`.trim() : n;
}

/* ------------------------------------------------------------------ */
/* Local social (content calendar)                                     */
/* ------------------------------------------------------------------ */

export const SOCIAL_TEMPLATE_TOKENS = ['location', 'city', 'phone', 'booking_link', 'website', 'brand'] as const;
export type SocialTemplateToken = (typeof SOCIAL_TEMPLATE_TOKENS)[number];

/** Fills `{location}`, `{city}`, … in a calendar post; unknown tokens are left as typed so the author notices. */
export function fillSocialTemplate(text: string, values: Partial<Record<SocialTemplateToken, string | null>>): string {
  return text.replace(/\{(location|city|phone|booking_link|website|brand)\}/g, (m, k: SocialTemplateToken) => values[k] ?? m);
}

/** Tokens in a text that have no value for this location (the post can't be localised until they are filled). */
export function missingSocialTokens(text: string, values: Partial<Record<SocialTemplateToken, string | null>>): SocialTemplateToken[] {
  const out = new Set<SocialTemplateToken>();
  for (const m of text.matchAll(/\{(location|city|phone|booking_link|website|brand)\}/g)) if (!values[m[1] as SocialTemplateToken]) out.add(m[1] as SocialTemplateToken);
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Local asset templates (brand templates locals customise)            */
/* ------------------------------------------------------------------ */

export const LOCAL_ASSET_KINDS = ['print', 'social', 'ad', 'flyer', 'poster', 'email'] as const;
export const localAssetFieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().trim().min(1).max(80),
  /** Locked fields keep HQ's text; unlocked fields are what a location may change. */
  locked: z.boolean(),
  default: z.string().max(500).default(''),
  maxLength: z.number().int().min(1).max(500).default(120),
  /** Position on the artwork, in percent of the width / height. */
  x: z.number().min(0).max(100).default(10),
  y: z.number().min(0).max(100).default(10),
  size: z.number().min(6).max(120).default(24),
});
export type LocalAssetField = z.infer<typeof localAssetFieldSchema>;

/** Values a location submits: only unlocked fields, within their length; locked fields always keep HQ's text. */
export function resolveLocalAsset(fields: readonly LocalAssetField[], values: Record<string, string>): { values: Record<string, string>; rejected: string[] } {
  const out: Record<string, string> = {};
  const rejected: string[] = [];
  for (const f of fields) {
    const v = values[f.key];
    if (f.locked || v === undefined) out[f.key] = f.default;
    else if (v.length > f.maxLength) { out[f.key] = v.slice(0, f.maxLength).trimEnd(); rejected.push(f.key); }
    else out[f.key] = v;
  }
  for (const k of Object.keys(values)) if (fields.find((f) => f.key === k)?.locked) rejected.push(k);
  return { values: out, rejected: [...new Set(rejected)] };
}

/* ------------------------------------------------------------------ */
/* Settings (organisation)                                             */
/* ------------------------------------------------------------------ */

export const localMarketingSettingsSchema = z.object({
  listingPolicy: z.partialRecord(z.enum(LISTING_FIELDS), z.enum(LISTING_FIELD_POLICIES)).default({})
    .transform((p) => ({ ...DEFAULT_LISTING_POLICY, ...p }) as Record<ListingField, ListingFieldPolicy>),
  /** Push listing changes to connected directories as soon as they are saved (otherwise HQ pushes). */
  autoPush: z.boolean().default(true),
  reviewSla: z.object({ positiveHours: z.number().int().min(1).max(24 * 14).default(48), negativeHours: z.number().int().min(1).max(24 * 7).default(12) }).default({ positiveHours: 48, negativeHours: 12 }),
  coopChecklist: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), label: z.string().trim().max(120).nullable().default(null) })).max(20)
    .default(DEFAULT_COOP_CHECKLIST.map((key) => ({ key, label: null }))),
  callRecording: z.object({
    enabled: z.boolean().default(false),
    /** Per jurisdiction (`US-CA`, `GB`, …): the disclosure played before connecting. No entry = never recorded there. */
    jurisdictions: z.record(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/), z.object({ message: z.string().trim().min(10).max(300) })).default({}),
  }).default({ enabled: false, jurisdictions: {} }),
  /** A missed call from an unknown number creates a lead (routed by the lead rules). */
  missedCallLeads: z.boolean().default(true),
});
export type LocalMarketingSettings = z.infer<typeof localMarketingSettingsSchema>;
