/**
 * Reviews (Marketing → Reviews): review requests after a completed visit or order, the hosted review page, Google
 * review monitoring and replies, and the rating dashboard. Shared by the API, the dashboard and the hosted sites.
 *
 * Policy note — no review gating: every customer who opens the hosted review page is offered the location's public
 * review links, whatever rating they gave. Showing public links only to happy customers ("review gating") breaks
 * Google's review policy (and the FTC's rule on consumer reviews), so nothing here may branch on the rating to decide
 * whether public links are shown.
 */
import { z } from 'zod';
import type { Industry } from './industries.ts';
import type { Locale } from './locale.ts';

/** What completed interaction a review request follows. */
export const REVIEW_SOURCES = ['class_visit', 'booking', 'order', 'hotel_checkout', 'property_viewing', 'manual', 'automation'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/** The completed interactions that start a review request, per industry. */
export const REVIEW_TRIGGER_SOURCES: Record<Industry, readonly ReviewSource[]> = {
  studios: ['class_visit'],
  sports: ['class_visit'],
  wellness: ['booking'],
  commerce: ['order'],
  foods: ['order'],
  realty: ['property_viewing'],
  hospitality: ['hotel_checkout'],
};

export const REVIEW_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

export const REVIEW_LINK_KINDS = ['google', 'facebook', 'tripadvisor', 'yelp', 'trustpilot', 'other'] as const;
export type ReviewLinkKind = (typeof REVIEW_LINK_KINDS)[number];

/** Reviews at or below this rating alert the location manager and HQ marketing. */
export const NEGATIVE_REVIEW_MAX_RATING = 2;

/** Reply approval: who needs HQ sign-off before a reply is published. */
export const REPLY_APPROVAL_MODES = ['none', 'negative', 'all'] as const;
export type ReplyApprovalMode = (typeof REPLY_APPROVAL_MODES)[number];

/**
 * Consent basis for review requests. `marketing`: only contacts with marketing consent for the channel (safest; the
 * default). `service`: a one-off service follow-up about a completed visit, where local law allows it; opt-outs
 * (STOP, unsubscribe, "no more review requests") are always respected either way.
 */
export const REVIEW_CONSENT_MODES = ['marketing', 'service'] as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const https = z.url().refine((u) => /^https:\/\//.test(u), 'Use an https link');

export const reviewLinkSchema = z.object({ kind: z.enum(REVIEW_LINK_KINDS), label: z.string().trim().max(60).default(''), url: https });
export type ReviewLink = z.infer<typeof reviewLinkSchema>;

export const reviewTemplateSchema = z.object({ subject: z.string().trim().max(160).default(''), body: z.string().trim().max(1000).default('') });
export type ReviewTemplate = z.infer<typeof reviewTemplateSchema>;

const settingsFields = {
  enabled: z.boolean(),
  sources: z.array(z.enum(REVIEW_SOURCES)).max(REVIEW_SOURCES.length),
  delayMinutes: z.number().int().min(0).max(14 * 24 * 60),
  channel: z.enum(REVIEW_CHANNELS),
  /** Per-locale overrides of the default copy (keys are site locales; empty fields fall back to the default). */
  templates: z.record(z.string().max(8), reviewTemplateSchema),
  /** At most one review request per customer every N days (across locations of the organisation). */
  frequencyCapDays: z.number().int().min(1).max(365),
  /** Local quiet hours for texts and WhatsApp (email is sent any time). */
  quietHours: z.object({ start: hhmm, end: hhmm }),
  consentMode: z.enum(REVIEW_CONSENT_MODES),
  /** Public review links offered on the hosted review page to EVERY customer (never gated by rating). */
  links: z.array(reviewLinkSchema).max(6),
  /** HQ approval for replies to public reviews written by location staff. */
  replyApproval: z.enum(REPLY_APPROVAL_MODES),
};

/** Review-request settings: the organisation default (HQ) and per-location overrides of the same shape. */
export const reviewSettingsSchema = z.object({
  enabled: settingsFields.enabled.default(false),
  sources: settingsFields.sources.default([]),
  delayMinutes: settingsFields.delayMinutes.default(120),
  channel: settingsFields.channel.default('email'),
  templates: settingsFields.templates.default({}),
  frequencyCapDays: settingsFields.frequencyCapDays.default(90),
  quietHours: settingsFields.quietHours.default({ start: '21:00', end: '09:00' }),
  consentMode: settingsFields.consentMode.default('marketing'),
  links: settingsFields.links.default([]),
  replyApproval: settingsFields.replyApproval.default('none'),
});
/** A change to settings: only the keys sent (no defaults filled in), so location overrides stay minimal. */
export const reviewSettingsPatchSchema = z.object(settingsFields).partial();
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

/** Placeholders in review-request copy. */
export const REVIEW_TOKENS = ['name', 'location', 'business', 'link'] as const;

/**
 * Default review-request copy in every site locale. `{name}`, `{location}`, `{business}` and `{link}` are filled at
 * send time; SMS and WhatsApp use the body only (plus the opt-out line for SMS).
 */
export const DEFAULT_REVIEW_TEMPLATES: Record<Locale, { subject: string; body: string }> = {
  en: { subject: 'How was your visit to {location}?', body: 'Hi {name}, thanks for visiting {location}. How did we do? It takes a minute: {link}' },
  'en-GB': { subject: 'How was your visit to {location}?', body: 'Hi {name}, thank you for visiting {location}. How did we do? It only takes a minute: {link}' },
  fr: { subject: 'Comment s’est passée votre visite chez {location} ?', body: 'Bonjour {name}, merci de votre visite chez {location}. Qu’en avez-vous pensé ? Cela prend une minute : {link}' },
  es: { subject: '¿Qué tal tu visita a {location}?', body: 'Hola {name}, gracias por visitar {location}. ¿Qué tal lo hicimos? Solo te llevará un minuto: {link}' },
  de: { subject: 'Wie war Ihr Besuch bei {location}?', body: 'Hallo {name}, danke für Ihren Besuch bei {location}. Wie war es? Es dauert nur eine Minute: {link}' },
  'pt-BR': { subject: 'Como foi sua visita a {location}?', body: 'Olá {name}, obrigado por visitar {location}. Como foi a sua experiência? Leva só um minuto: {link}' },
  nl: { subject: 'Hoe was je bezoek aan {location}?', body: 'Hallo {name}, bedankt voor je bezoek aan {location}. Hoe vond je het? Het duurt maar een minuut: {link}' },
  it: { subject: 'Com’è andata la tua visita da {location}?', body: 'Ciao {name}, grazie per aver visitato {location}. Com’è andata? Ci vuole solo un minuto: {link}' },
  ar: { subject: 'كيف كانت زيارتك إلى {location}؟', body: 'مرحبًا {name}، شكرًا لزيارتك {location}. كيف كانت تجربتك؟ لن يستغرق الأمر سوى دقيقة: {link}' },
};

/** Opt-out line for review requests sent by text (always appended to SMS). */
export const REVIEW_SMS_OPT_OUT: Record<Locale, string> = {
  en: 'Reply STOP to opt out.', 'en-GB': 'Reply STOP to opt out.', fr: 'Répondez STOP pour vous désabonner.', es: 'Responde STOP para darte de baja.',
  de: 'Antworten Sie STOP zum Abmelden.', 'pt-BR': 'Responda STOP para sair.', nl: 'Antwoord STOP om af te melden.', it: 'Rispondi STOP per annullare.', ar: 'أرسل STOP لإلغاء الاشتراك.',
};

/** Fills `{token}` placeholders (unknown tokens are left as typed). */
export function fillReviewTemplate(text: string, values: Partial<Record<(typeof REVIEW_TOKENS)[number], string>>): string {
  return text.replace(/\{(name|location|business|link)\}/g, (m, k: (typeof REVIEW_TOKENS)[number]) => values[k] ?? m);
}

/** The copy to send in a locale: the location's override, then the organisation's, then the default (per field). */
export function resolveReviewTemplate(locale: string, ...overrides: Array<Record<string, ReviewTemplate> | undefined>): { subject: string; body: string; locale: Locale } {
  const supported = Object.keys(DEFAULT_REVIEW_TEMPLATES) as Locale[];
  const exact = supported.find((l) => l.toLowerCase() === locale.toLowerCase());
  const loc: Locale = exact ?? supported.find((l) => l === locale.split('-')[0]) ?? 'en';
  const out = { ...DEFAULT_REVIEW_TEMPLATES[loc] };
  for (const o of [...overrides].reverse()) {
    const t = o?.[loc];
    if (t?.subject) out.subject = t.subject;
    if (t?.body) out.body = t.body;
  }
  return { ...out, locale: loc };
}

/** Average rating rounded to one decimal, or null without reviews. */
export function averageRating(ratings: readonly number[]): number | null {
  if (!ratings.length) return null;
  return Math.round((ratings.reduce((a, r) => a + r, 0) / ratings.length) * 10) / 10;
}
