/**
 * Email builder document (Marketing workspace → email). Block-based and brand-aware; the API renders it to
 * email-safe HTML with MJML plus a plain-text part. Every marketing email gets a footer with the sender's postal
 * address and an unsubscribe link: the renderer adds them even when the footer block is missing.
 *
 * Personalisation tokens: `{{first_name|there}}` (fallback after the bar), `{{name}}`, `{{email}}`,
 * `{{location_name}}`, `{{business_name}}`. Unknown tokens render their fallback (or nothing).
 */
import { z } from 'zod';
import { isSafeHref, isSafeImage } from './site-document.ts';

export const EMAIL_TOKENS = ['first_name', 'name', 'email', 'location_name', 'business_name'] as const;
export type EmailToken = (typeof EMAIL_TOKENS)[number];

const href = z.string().max(2048).refine((v) => !v || (isSafeHref(v) && !v.startsWith('/') && !v.startsWith('#')), 'Use an https, mailto or tel link');
const img = z.string().max(2048).refine((v) => !v || isSafeImage(v), 'Use an https image');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const align = z.enum(['left', 'center']).default('left');

const column = z.object({ text: z.string().max(2000).default(''), image: img.default(''), imageAlt: z.string().max(160).default('') });

export const emailBlockSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('header'), showLogo: z.boolean().default(true), title: z.string().max(120).default('') }),
  z.object({ id, type: z.literal('text'), text: z.string().max(5000).default(''), align, size: z.enum(['body', 'heading', 'small']).default('body') }),
  z.object({ id, type: z.literal('image'), src: img.default(''), alt: z.string().max(160).default(''), href: href.default(''), width: z.number().int().min(80).max(600).default(600) }),
  z.object({ id, type: z.literal('button'), label: z.string().max(60).default(''), href: href.default(''), align: z.enum(['left', 'center']).default('center') }),
  z.object({ id, type: z.literal('columns'), left: column, right: column }),
  z.object({ id, type: z.literal('divider') }),
  z.object({ id, type: z.literal('spacer'), height: z.number().int().min(8).max(80).default(24) }),
  z.object({ id, type: z.literal('social'), links: z.array(z.object({ network: z.string().max(20), href })).max(8).default([]) }),
  z.object({ id, type: z.literal('footer'), text: z.string().max(600).default(''), address: z.string().max(300).default('') }),
]);
export type EmailBlock = z.infer<typeof emailBlockSchema>;
export const EMAIL_BLOCK_TYPES = ['header', 'text', 'image', 'button', 'columns', 'divider', 'spacer', 'social', 'footer'] as const;
export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number];

export const emailDocumentSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  blocks: z.array(emailBlockSchema).max(60),
  /** Brand-aware styling: colours come from the site theme / brand overrides. */
  style: z.object({ background: z.enum(['light', 'tinted']).default('light'), buttonShape: z.enum(['pill', 'rounded', 'square']).default('pill') }).default({ background: 'light', buttonShape: 'pill' }),
});
export type EmailDocument = z.infer<typeof emailDocumentSchema>;

export function newEmailBlock(type: EmailBlockType): EmailBlock {
  const bid = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return emailBlockSchema.parse({ id: bid, type, ...(type === 'columns' ? { left: {}, right: {} } : {}) });
}

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/g;

/** Replace personalisation tokens. `escape` is applied to substituted values (HTML output). */
export function personalise(text: string, values: Partial<Record<EmailToken, string | null | undefined>>, escape: (s: string) => string = (s) => s): string {
  return text.replace(TOKEN_RE, (_m, key: string, fallback?: string) => {
    const v = (values as Record<string, string | null | undefined>)[key];
    return escape(v && v.trim() ? v : (fallback ?? '').trim());
  });
}

export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[1]!);
}

/** Unknown tokens in a document (shown as warnings in the editor). */
export function unknownTokens(doc: EmailDocument, subject = ''): string[] {
  const texts = [subject, ...doc.blocks.flatMap((b) => {
    switch (b.type) {
      case 'header': return [b.title];
      case 'text': return [b.text];
      case 'button': return [b.label];
      case 'columns': return [b.left.text, b.right.text];
      case 'footer': return [b.text];
      default: return [];
    }
  })];
  return [...new Set(texts.flatMap(tokensIn).filter((t) => !(EMAIL_TOKENS as readonly string[]).includes(t)))];
}

/** Built-in starting points (structure only; the business writes the words). */
export const EMAIL_STARTERS = ['blank', 'announcement', 'newsletter', 'offer', 'welcome', 'event'] as const;
export type EmailStarter = (typeof EMAIL_STARTERS)[number];

export function starterDocument(kind: EmailStarter, copy: { heading: string; body: string; button: string }): EmailDocument {
  const b = (x: Record<string, unknown>) => emailBlockSchema.parse({ id: `b${Math.random().toString(36).slice(2, 9)}`, ...x });
  const footer = b({ type: 'footer', text: '', address: '' });
  const header = b({ type: 'header', showLogo: true, title: '' });
  const blocks: EmailBlock[] = kind === 'blank'
    ? [header, b({ type: 'text', text: copy.body }), footer]
    : kind === 'newsletter'
      ? [header, b({ type: 'text', text: copy.heading, size: 'heading' }), b({ type: 'text', text: copy.body }), b({ type: 'divider' }), b({ type: 'columns', left: { text: copy.body }, right: { text: copy.body } }), b({ type: 'button', label: copy.button, href: '' }), footer]
      : [header, b({ type: 'image', src: '', alt: '' }), b({ type: 'text', text: copy.heading, size: 'heading' }), b({ type: 'text', text: copy.body }), b({ type: 'button', label: copy.button, href: '' }), footer];
  return { schemaVersion: 1, blocks, style: { background: kind === 'offer' ? 'tinted' : 'light', buttonShape: 'pill' } };
}

// ───────── Segments ─────────

/**
 * Contact segment rules — one model for inbox broadcasts, email campaigns and automations (stored in
 * contact_segments). Every rule is optional; results are always limited to the locations the viewer may see.
 */
export const segmentRulesSchema = z.object({
  /** Empty = every location in scope. */
  locationIds: z.array(z.uuid()).max(500).optional(),
  /** Contacts with ANY / ALL of these tags, and without any of `excludeTags`. */
  tagsAny: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  tagsAll: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  excludeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Booked / bought within the last N days; lapsed for at least N days; never booked or bought. */
  activeWithinDays: z.number().int().min(1).max(3650).optional(),
  lapsedForDays: z.number().int().min(1).max(3650).optional(),
  neverActive: z.boolean().optional(),
  /** Contacts created in the last N days. */
  createdWithinDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** Only contacts that came in as leads (forms, enquiries), or only those who booked or bought. */
  source: z.enum(['any', 'lead', 'customer']).optional(),
  /** Only contacts who agreed to marketing on this channel. */
  consentChannel: z.enum(['email', 'sms', 'whatsapp']).optional(),
});
export type SegmentRules = z.infer<typeof segmentRulesSchema>;

export const marketingSettingsSchema = z.object({
  /** Privacy-friendly default: no open pixel, no click redirects, unless the business turns them on. */
  tracking: z.object({ opens: z.boolean().default(false), clicks: z.boolean().default(false) }).default({ opens: false, clicks: false }),
  /** Postal address printed in every marketing email (legally required). Falls back to the location's address. */
  postalAddress: z.string().max(300).default(''),
  fromName: z.string().max(80).default(''),
  /** Quiet hours for texts and WhatsApp (location local time). */
  quietHours: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/).default('21:00'), end: z.string().regex(/^\d{2}:\d{2}$/).default('08:00') }).default({ start: '21:00', end: '08:00' }),
});
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;
