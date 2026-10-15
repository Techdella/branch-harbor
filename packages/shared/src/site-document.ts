/**
 * Website builder page document (Marketing workspace → website builder).
 *
 * A page is an ordered list of sections. Each section has a `type` from the section library, `props` (content the
 * business types: plain text, links, images — never raw HTML), `style` (options constrained to the theme's brand
 * tokens) and governance metadata for franchise networks:
 *
 * - `lock` (on HQ master documents): `editable` · `locked` · `approval`.
 * - `origin` (on location pages, mirrors the website field-origin model): `hq` = inherited HQ content (editable
 *   locally), `local` = a local override or a section the location added, `locked` = brand-locked (HQ only),
 *   `approval` = local changes need approval before they apply.
 * - `masterId` links a location section to its HQ master section; `hq` keeps HQ's content for "reset to HQ".
 * - `pending` holds a change waiting for approval (never rendered publicly).
 *
 * The document is separate from the theme: switching theme never touches it.
 */
import { z } from 'zod';

export const PAGE_DOCUMENT_VERSION = 1 as const;

export type FieldSpec =
  | { kind: 'text'; max: number; required?: boolean; inline?: boolean }
  | { kind: 'textarea'; max: number; required?: boolean; inline?: boolean }
  | { kind: 'url' }
  | { kind: 'image' }
  | { kind: 'select'; options: readonly string[] }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'list'; max: number; item: Record<string, FieldSpec> }
  | { kind: 'form' };

export type SectionFamily = 'hero' | 'content' | 'media' | 'social' | 'conversion' | 'location' | 'footer' | 'industry';
/** Industry blocks pull live data from the business's own modules. `hospitality` data comes from the Hospitality workspace. */
export type BlockIndustry = 'studios' | 'sports' | 'wellness' | 'commerce' | 'foods' | 'realty' | 'hospitality';

export interface SectionDef {
  family: SectionFamily;
  industry?: BlockIndustry;
  fields: Record<string, FieldSpec>;
  defaults: Record<string, unknown>;
  /** Sections whose style supports an image focal point. */
  hasImage?: boolean;
}

const t = (max: number, o: { required?: boolean; inline?: boolean } = {}): FieldSpec => ({ kind: 'text', max, inline: true, ...o });
const ta = (max: number, o: { required?: boolean; inline?: boolean } = {}): FieldSpec => ({ kind: 'textarea', max, inline: true, ...o });
const url: FieldSpec = { kind: 'url' };
const image: FieldSpec = { kind: 'image' };
const bool: FieldSpec = { kind: 'boolean' };
const num = (min: number, max: number): FieldSpec => ({ kind: 'number', min, max });
const sel = (options: readonly string[]): FieldSpec => ({ kind: 'select', options });
const list = (max: number, item: Record<string, FieldSpec>): FieldSpec => ({ kind: 'list', max, item });

export const FEATURE_ICONS = ['check', 'star', 'heart', 'clock', 'calendar', 'pin', 'users', 'leaf', 'gift', 'shield', 'sparkle', 'trophy', 'phone', 'mail', 'card', 'truck'] as const;
/** Social profile links a website footer can show (not the networks Social posts to: comms SOCIAL_NETWORKS). */
export const SITE_SOCIAL_LINKS = ['instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'x', 'pinterest', 'whatsapp'] as const;

/** The section library. Field names double as translation keys in the editor (`mkt.fields.<name>`). */
export const SECTION_DEFS = {
  hero: {
    family: 'hero', hasImage: true,
    fields: { eyebrow: t(80), heading: t(140, { required: true }), body: ta(400), ctaLabel: t(40), ctaHref: url, secondaryLabel: t(40), secondaryHref: url, image, imageAlt: t(160, { inline: false }) },
    defaults: { eyebrow: '', heading: '', body: '', ctaLabel: '', ctaHref: '', secondaryLabel: '', secondaryHref: '', image: '', imageAlt: '' },
  },
  hero_video: {
    family: 'hero', hasImage: true,
    fields: { heading: t(140, { required: true }), body: ta(400), videoUrl: url, image, imageAlt: t(160, { inline: false }), ctaLabel: t(40), ctaHref: url },
    defaults: { heading: '', body: '', videoUrl: '', image: '', imageAlt: '', ctaLabel: '', ctaHref: '' },
  },
  hero_split: {
    family: 'hero', hasImage: true,
    fields: { eyebrow: t(80), heading: t(140, { required: true }), body: ta(400), ctaLabel: t(40), ctaHref: url, image, imageAlt: t(160, { inline: false }), imageSide: sel(['end', 'start']) },
    defaults: { eyebrow: '', heading: '', body: '', ctaLabel: '', ctaHref: '', image: '', imageAlt: '', imageSide: 'end' },
  },
  text: {
    family: 'content',
    fields: { heading: t(140), body: ta(6000) },
    defaults: { heading: '', body: '' },
  },
  image_text: {
    family: 'content', hasImage: true,
    fields: { heading: t(140), body: ta(2000), image, imageAlt: t(160, { inline: false }), imageSide: sel(['start', 'end']), ctaLabel: t(40), ctaHref: url },
    defaults: { heading: '', body: '', image: '', imageAlt: '', imageSide: 'start', ctaLabel: '', ctaHref: '' },
  },
  gallery: {
    family: 'media',
    fields: { heading: t(140), columns: sel(['2', '3', '4']), items: list(24, { image, alt: t(160, { inline: false }), caption: t(140, { inline: false }) }) },
    defaults: { heading: '', columns: '3', items: [] },
  },
  logos: {
    family: 'social',
    fields: { heading: t(140), items: list(16, { image, alt: t(160, { inline: false }), href: url }) },
    defaults: { heading: '', items: [] },
  },
  features: {
    family: 'content',
    fields: { heading: t(140), intro: ta(400), columns: sel(['2', '3', '4']), items: list(12, { icon: sel(FEATURE_ICONS), title: t(80, { inline: false }), body: ta(300, { inline: false }) }) },
    defaults: { heading: '', intro: '', columns: '3', items: [] },
  },
  testimonials: {
    family: 'social',
    // Business-supplied quotes only: publishing requires confirming the customers agreed to be quoted.
    fields: { heading: t(140), confirmed: bool, items: list(12, { quote: ta(600, { required: true, inline: false }), author: t(80, { required: true, inline: false }), role: t(80, { inline: false }) }) },
    defaults: { heading: '', confirmed: false, items: [] },
  },
  faq: {
    family: 'content',
    fields: { heading: t(140), items: list(30, { question: t(200, { required: true, inline: false }), answer: ta(1500, { inline: false }) }) },
    defaults: { heading: '', items: [] },
  },
  cta: {
    family: 'conversion',
    fields: { heading: t(140, { required: true }), body: ta(400), ctaLabel: t(40), ctaHref: url, secondaryLabel: t(40), secondaryHref: url },
    defaults: { heading: '', body: '', ctaLabel: '', ctaHref: '', secondaryLabel: '', secondaryHref: '' },
  },
  contact_map: {
    family: 'location',
    fields: { heading: t(140), note: ta(400), showMap: bool, showPhone: bool, showEmail: bool },
    defaults: { heading: '', note: '', showMap: true, showPhone: true, showEmail: true },
  },
  hours: {
    family: 'location',
    fields: { heading: t(140), note: ta(400) },
    defaults: { heading: '', note: '' },
  },
  team: {
    family: 'social',
    fields: { heading: t(140), intro: ta(400), items: list(24, { name: t(80, { required: true, inline: false }), role: t(80, { inline: false }), bio: ta(400, { inline: false }), image, alt: t(160, { inline: false }) }) },
    defaults: { heading: '', intro: '', items: [] },
  },
  pricing: {
    family: 'conversion',
    fields: { heading: t(140), intro: ta(400), items: list(6, { name: t(60, { required: true, inline: false }), price: t(40, { inline: false }), period: t(30, { inline: false }), features: ta(600, { inline: false }), ctaLabel: t(40, { inline: false }), ctaHref: url, highlighted: bool }) },
    defaults: { heading: '', intro: '', items: [] },
  },
  blog_list: {
    family: 'content',
    fields: { heading: t(140), items: list(12, { title: t(140, { required: true, inline: false }), date: t(40, { inline: false }), excerpt: ta(400, { inline: false }), image, href: url }) },
    defaults: { heading: '', items: [] },
  },
  form: {
    family: 'conversion',
    fields: { heading: t(140), intro: ta(400), formId: { kind: 'form' } },
    defaults: { heading: '', intro: '', formId: '' },
  },
  newsletter: {
    family: 'conversion',
    fields: { heading: t(140), body: ta(400), buttonLabel: t(40) },
    defaults: { heading: '', body: '', buttonLabel: '' },
  },
  footer: {
    family: 'footer',
    fields: {
      variant: sel(['columns', 'simple', 'centered']), text: ta(400), showAddress: bool, showHours: bool,
      links: list(12, { label: t(40, { required: true, inline: false }), href: url }), socials: list(8, { network: sel(SITE_SOCIAL_LINKS), href: url }),
    },
    defaults: { variant: 'columns', text: '', showAddress: true, showHours: true, links: [], socials: [] },
  },
  class_schedule: { family: 'industry', industry: 'studios', fields: { heading: t(140), days: num(1, 14), limit: num(1, 30) }, defaults: { heading: '', days: 7, limit: 8 } },
  programmes: { family: 'industry', industry: 'sports', fields: { heading: t(140), limit: num(1, 24) }, defaults: { heading: '', limit: 6 } },
  services: { family: 'industry', industry: 'wellness', fields: { heading: t(140), limit: num(1, 24) }, defaults: { heading: '', limit: 6 } },
  product_grid: { family: 'industry', industry: 'commerce', fields: { heading: t(140), limit: num(1, 24) }, defaults: { heading: '', limit: 8 } },
  menu: { family: 'industry', industry: 'foods', fields: { heading: t(140), limit: num(1, 40), showOrderButton: bool }, defaults: { heading: '', limit: 12, showOrderButton: true } },
  listings: { family: 'industry', industry: 'realty', fields: { heading: t(140), limit: num(1, 24), transaction: sel(['any', 'sale', 'rent']) }, defaults: { heading: '', limit: 6, transaction: 'any' } },
  rooms: { family: 'industry', industry: 'hospitality', fields: { heading: t(140), limit: num(1, 24) }, defaults: { heading: '', limit: 6 } },
} as const satisfies Record<string, SectionDef>;

export type SectionType = keyof typeof SECTION_DEFS;
export const SECTION_TYPES = Object.keys(SECTION_DEFS) as SectionType[];
export const sectionDef = (type: string): SectionDef | undefined => (SECTION_DEFS as Record<string, SectionDef>)[type];

export const SECTION_BACKGROUNDS = ['default', 'muted', 'brand', 'contrast'] as const;
export const SECTION_SPACING = ['compact', 'normal', 'spacious'] as const;
export const SECTION_ALIGN = ['start', 'center'] as const;
export const LOCK_MODES = ['editable', 'locked', 'approval'] as const;
export const SECTION_ORIGINS = ['hq', 'local', 'locked', 'approval'] as const;
export type LockMode = (typeof LOCK_MODES)[number];
export type SectionOrigin = (typeof SECTION_ORIGINS)[number];

export const sectionStyleSchema = z.object({
  background: z.enum(SECTION_BACKGROUNDS).default('default'),
  spacing: z.enum(SECTION_SPACING).default('normal'),
  align: z.enum(SECTION_ALIGN).default('start'),
  /** Image focal point in percent (object-position). */
  focalX: z.number().min(0).max(100).default(50),
  focalY: z.number().min(0).max(100).default(50),
});
export type SectionStyle = z.infer<typeof sectionStyleSchema>;
export const DEFAULT_STYLE: SectionStyle = { background: 'default', spacing: 'normal', align: 'start', focalX: 50, focalY: 50 };

const sectionContent = z.object({ props: z.record(z.string(), z.unknown()), style: sectionStyleSchema.partial().optional() });

export const sectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.string().min(1).max(40),
  props: z.record(z.string(), z.unknown()).default({}),
  style: sectionStyleSchema.partial().optional(),
  hidden: z.boolean().optional(),
  lock: z.enum(LOCK_MODES).optional(),
  origin: z.enum(SECTION_ORIGINS).optional(),
  masterId: z.string().max(64).optional(),
  hq: sectionContent.optional(),
  pending: sectionContent.extend({ approvalId: z.string(), requestedBy: z.string().optional() }).optional(),
});
export type Section = z.infer<typeof sectionSchema>;

export const pageDocumentSchema = z.object({
  schemaVersion: z.literal(PAGE_DOCUMENT_VERSION).default(PAGE_DOCUMENT_VERSION),
  sections: z.array(sectionSchema).max(80),
});
export type PageDocument = z.infer<typeof pageDocumentSchema>;

export const emptyDocument = (): PageDocument => ({ schemaVersion: PAGE_DOCUMENT_VERSION, sections: [] });

export interface DocumentIssue {
  sectionId: string | null;
  path: string;
  code: 'unknown_type' | 'duplicate_id' | 'required' | 'too_long' | 'invalid_url' | 'invalid_option' | 'invalid_value' | 'too_many' | 'testimonials_unconfirmed' | 'invalid_document';
}

/**
 * Links typed by a business: https, same-site paths, anchors, mailto and tel. Never javascript:, data: or http:.
 * Images additionally allow uploaded asset paths served by the API.
 */
export function isSafeHref(v: string): boolean {
  if (!v) return true;
  if (v.length > 2048) return false;
  if (/^https:\/\/[^\s<>"']+$/i.test(v)) return true;
  if (/^\/(?!\/)[^\s<>"']*$/.test(v)) return true;
  if (/^#[A-Za-z0-9_-]*$/.test(v)) return true;
  if (/^mailto:[^\s<>"']+@[^\s<>"']+$/i.test(v)) return true;
  if (/^tel:\+?[0-9 ().-]{3,30}$/i.test(v)) return true;
  return false;
}
export function isSafeImage(v: string): boolean {
  if (!v) return true;
  if (v.length > 2048) return false;
  return /^https:\/\/[^\s<>"']+$/i.test(v) || /^\/v1\/public\/assets\/[A-Za-z0-9/_.-]+$/.test(v) || /^http:\/\/localhost(:\d+)?\/v1\/public\/assets\/[A-Za-z0-9/_.-]+$/.test(v);
}

function checkValue(spec: FieldSpec, value: unknown, path: string, sectionId: string, strict: boolean, out: DocumentIssue[]) {
  const push = (code: DocumentIssue['code']) => out.push({ sectionId, path, code });
  const empty = value === undefined || value === null || value === '';
  switch (spec.kind) {
    case 'text':
    case 'textarea':
      if (empty) { if (strict && spec.required) push('required'); return; }
      if (typeof value !== 'string') return push('invalid_value');
      if (value.length > spec.max) push('too_long');
      if (strict && spec.required && !value.trim()) push('required');
      return;
    case 'url':
      if (empty) return;
      if (typeof value !== 'string' || !isSafeHref(value)) push('invalid_url');
      return;
    case 'image':
      if (empty) return;
      if (typeof value !== 'string' || !isSafeImage(value)) push('invalid_url');
      return;
    case 'select':
      if (empty) return;
      if (typeof value !== 'string' || !spec.options.includes(value)) push('invalid_option');
      return;
    case 'number':
      if (empty) return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) push('invalid_value');
      return;
    case 'boolean':
      if (empty) return;
      if (typeof value !== 'boolean') push('invalid_value');
      return;
    case 'form':
      if (empty) { if (strict) push('required'); return; }
      if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) push('invalid_value');
      return;
    case 'list': {
      if (empty) return;
      if (!Array.isArray(value)) return push('invalid_value');
      if (value.length > spec.max) push('too_many');
      value.slice(0, spec.max).forEach((item, i) => {
        if (!item || typeof item !== 'object') { out.push({ sectionId, path: `${path}.${i}`, code: 'invalid_value' }); return; }
        for (const [k, s] of Object.entries(spec.item)) checkValue(s, (item as Record<string, unknown>)[k], `${path}.${i}.${k}`, sectionId, strict, out);
      });
    }
  }
}

/**
 * Validate a page document. `draft` accepts incomplete content (autosave); `publish` also requires required
 * fields, a chosen form for form sections and confirmed testimonials.
 */
export function validatePageDocument(input: unknown, mode: 'draft' | 'publish' = 'draft'): { ok: true; document: PageDocument; issues: [] } | { ok: false; document: PageDocument | null; issues: DocumentIssue[] } {
  const parsed = pageDocumentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, document: null, issues: parsed.error.issues.map((i) => ({ sectionId: null, path: i.path.join('.'), code: 'invalid_document' as const })) };
  const doc = parsed.data;
  const issues: DocumentIssue[] = [];
  const seen = new Set<string>();
  const strict = mode === 'publish';
  for (const s of doc.sections) {
    if (seen.has(s.id)) issues.push({ sectionId: s.id, path: 'id', code: 'duplicate_id' });
    seen.add(s.id);
    const def = sectionDef(s.type);
    if (!def) { issues.push({ sectionId: s.id, path: 'type', code: 'unknown_type' }); continue; }
    for (const [name, spec] of Object.entries(def.fields)) {
      if (strict && s.hidden) continue;
      checkValue(spec, s.props[name], `props.${name}`, s.id, strict, issues);
    }
    if (strict && !s.hidden && s.type === 'testimonials' && Array.isArray(s.props.items) && s.props.items.length && s.props.confirmed !== true) {
      issues.push({ sectionId: s.id, path: 'props.confirmed', code: 'testimonials_unconfirmed' });
    }
  }
  return issues.length ? { ok: false, document: doc, issues } : { ok: true, document: doc, issues: [] };
}

let counter = 0;
/** Short unique section id (not security sensitive). */
export function newSectionId(prefix = 's'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createSection(type: SectionType, props: Record<string, unknown> = {}, style: Partial<SectionStyle> = {}): Section {
  const def = SECTION_DEFS[type] as SectionDef;
  return { id: newSectionId(), type, props: { ...structuredClone(def.defaults), ...props }, style: { ...style } };
}

export const resolvedStyle = (s: Pick<Section, 'style'>): SectionStyle => ({ ...DEFAULT_STYLE, ...(s.style ?? {}) });

/** The document visitors see: hidden sections, pending changes and HQ reset copies removed. */
export function publicDocument(doc: PageDocument): PageDocument {
  return {
    schemaVersion: PAGE_DOCUMENT_VERSION,
    sections: doc.sections.filter((s) => !s.hidden).map((s) => ({ id: s.id, type: s.type, props: s.props, style: s.style ?? {} })),
  };
}

const sameContent = (a: { props: unknown; style?: unknown }, b: { props: unknown; style?: unknown }) => JSON.stringify(a.props ?? {}) === JSON.stringify(b.props ?? {}) && JSON.stringify(a.style ?? {}) === JSON.stringify(b.style ?? {});

// ───────── Franchise governance ─────────

export const originForLock = (lock: LockMode | undefined): SectionOrigin => (lock === 'locked' ? 'locked' : lock === 'approval' ? 'approval' : 'hq');

/** Build a location page from an HQ master document: every section inherits HQ content with its lock as origin. */
export function instantiateMaster(master: PageDocument): PageDocument {
  return {
    schemaVersion: PAGE_DOCUMENT_VERSION,
    sections: master.sections.map((m) => ({
      id: newSectionId('l'), type: m.type, props: structuredClone(m.props), style: structuredClone(m.style ?? {}), hidden: m.hidden,
      origin: originForLock(m.lock), masterId: m.id, hq: { props: structuredClone(m.props), style: structuredClone(m.style ?? {}) },
    })),
  };
}

/**
 * Apply an HQ master update to a location page.
 * - locked sections always take HQ content;
 * - inherited (`hq`) and approval sections without a local change take HQ content;
 * - local overrides keep their content (their HQ copy is refreshed for reset);
 * - new master sections are inserted after the previous master section; removed master sections disappear
 *   unless the location changed them (then they become local sections).
 */
export function mergeMasterIntoPage(master: PageDocument, page: PageDocument): { document: PageDocument; inherited: number; keptLocal: number; added: number; removed: number } {
  let inherited = 0, keptLocal = 0, added = 0, removed = 0;
  const byMaster = new Map(page.sections.filter((s) => s.masterId).map((s) => [s.masterId!, s]));
  const masterIds = new Set(master.sections.map((m) => m.id));
  const out: Section[] = [];
  // Keep the location's own ordering; walk it and splice master changes in.
  for (const s of page.sections) {
    if (s.masterId && !masterIds.has(s.masterId)) {
      if (s.origin === 'local') { out.push({ ...s, masterId: undefined, hq: undefined }); keptLocal++; } else removed++;
      continue;
    }
    if (!s.masterId) { out.push(s); continue; }
    const m = master.sections.find((x) => x.id === s.masterId)!;
    const origin = originForLock(m.lock);
    const hq = { props: structuredClone(m.props), style: structuredClone(m.style ?? {}) };
    if (origin === 'locked') { out.push({ ...s, type: m.type, props: hq.props, style: hq.style, hidden: m.hidden, origin, hq, pending: undefined }); inherited++; }
    else if (s.origin === 'local' && origin === 'hq') { out.push({ ...s, hq }); keptLocal++; }
    else if (s.origin === 'local' && origin === 'approval') { out.push({ ...s, origin: 'approval', hq }); keptLocal++; }
    else if (s.origin === 'approval' && s.hq && !sameContent(s, s.hq)) { out.push({ ...s, origin, hq }); keptLocal++; }
    else { out.push({ ...s, type: m.type, props: hq.props, style: hq.style, hidden: m.hidden, origin, hq }); inherited++; }
  }
  // Insert master sections the page does not have yet, after their predecessor in the master.
  master.sections.forEach((m, i) => {
    if (byMaster.has(m.id)) return;
    const prev = master.sections.slice(0, i).reverse().find((p) => out.some((o) => o.masterId === p.id));
    const at = prev ? out.findIndex((o) => o.masterId === prev.id) + 1 : 0;
    out.splice(at, 0, { id: newSectionId('l'), type: m.type, props: structuredClone(m.props), style: structuredClone(m.style ?? {}), hidden: m.hidden, origin: originForLock(m.lock), masterId: m.id, hq: { props: structuredClone(m.props), style: structuredClone(m.style ?? {}) } });
    added++;
  });
  return { document: { schemaVersion: PAGE_DOCUMENT_VERSION, sections: out }, inherited, keptLocal, added, removed };
}

export interface GovernanceResult {
  document: PageDocument;
  /** Sections whose change was refused (locked brand content); the stored document keeps HQ's version. */
  rejected: Array<{ sectionId: string; reason: 'locked' | 'locked_removed' | 'locked_moved' }>;
  /** Changes that need approval: the stored document keeps the current content until approved. */
  approvals: Array<{ sectionId: string; props: Record<string, unknown>; style: Partial<SectionStyle> }>;
  /** Sections that became local overrides. */
  overridden: string[];
}

/**
 * Apply an editor's save on a location page to the current stored document under franchise governance.
 * `canHq` = HQ brand rights (may change anything); `canApprove` = may apply approval-required changes directly.
 * Pure: the caller persists `document` and creates approval requests for `approvals`.
 */
export function applyGovernedEdit(current: PageDocument, incoming: PageDocument, opts: { canHq: boolean; canApprove: boolean }): GovernanceResult {
  const res: GovernanceResult = { document: incoming, rejected: [], approvals: [], overridden: [] };
  const curById = new Map(current.sections.map((s) => [s.id, s]));
  if (opts.canHq) {
    // HQ keeps governance metadata; an HQ edit of an inherited section is still HQ content.
    res.document = { schemaVersion: PAGE_DOCUMENT_VERSION, sections: incoming.sections.map((s) => {
      const cur = curById.get(s.id);
      return cur ? { ...s, origin: cur.origin ?? s.origin, masterId: cur.masterId, hq: cur.hq, pending: cur.pending } : { ...s, origin: s.origin ?? 'local' };
    }) };
    return res;
  }
  const out: Section[] = [];
  const incomingIds = new Set(incoming.sections.map((s) => s.id));
  for (const s of incoming.sections) {
    const cur = curById.get(s.id);
    if (!cur) {
      // New local section. Clients cannot smuggle governance metadata in.
      out.push({ id: s.id, type: s.type, props: s.props, style: s.style, hidden: s.hidden, origin: 'local' });
      continue;
    }
    const changed = !sameContent(s, cur) || !!s.hidden !== !!cur.hidden;
    const meta = { origin: cur.origin, masterId: cur.masterId, hq: cur.hq, pending: cur.pending, lock: cur.lock };
    if (cur.origin === 'locked') {
      if (changed) res.rejected.push({ sectionId: s.id, reason: 'locked' });
      out.push(cur);
    } else if (cur.origin === 'approval' && changed && !opts.canApprove) {
      res.approvals.push({ sectionId: s.id, props: s.props, style: s.style ?? {} });
      out.push(cur);
    } else if (changed) {
      if (cur.origin === 'hq') res.overridden.push(s.id);
      out.push({ ...s, ...meta, origin: cur.origin === 'hq' ? 'local' : cur.origin ?? 'local', pending: cur.origin === 'approval' ? undefined : cur.pending });
    } else {
      out.push({ ...s, ...meta });
    }
  }
  // Locked sections may not be removed: put them back where they were.
  current.sections.forEach((cur, i) => {
    if (incomingIds.has(cur.id)) return;
    if (cur.origin === 'locked' || cur.origin === 'approval') {
      res.rejected.push({ sectionId: cur.id, reason: 'locked_removed' });
      out.splice(Math.min(i, out.length), 0, cur);
    }
  });
  // Locked sections keep their order relative to each other.
  const lockedNow = out.filter((s) => s.origin === 'locked').map((s) => s.id);
  const lockedBefore = current.sections.filter((s) => s.origin === 'locked').map((s) => s.id);
  if (lockedNow.join('|') !== lockedBefore.filter((id) => lockedNow.includes(id)).join('|')) {
    res.rejected.push({ sectionId: lockedNow[0] ?? '', reason: 'locked_moved' });
    return { ...res, document: current };
  }
  res.document = { schemaVersion: PAGE_DOCUMENT_VERSION, sections: out };
  return res;
}

/** Reset a local override to HQ content. */
export function resetSectionToHq(doc: PageDocument, sectionId: string): PageDocument | null {
  const s = doc.sections.find((x) => x.id === sectionId);
  if (!s || !s.hq || s.origin !== 'local' || !s.masterId) return null;
  return { ...doc, sections: doc.sections.map((x) => (x.id === sectionId ? { ...x, props: structuredClone(s.hq!.props), style: structuredClone(s.hq!.style ?? {}), origin: 'hq' as const } : x)) };
}

// ───────── Legacy migration (template fields → document) ─────────

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const industryBlock: Record<string, SectionType> = { studios: 'class_schedule', sports: 'programmes', wellness: 'services', commerce: 'product_grid', foods: 'menu', realty: 'listings', hospitality: 'rooms' };

/**
 * Convert the field-based content of a page (hero_title, hero_image, offer/intro_offer, about, brand_tagline and any
 * other text fields) into a page document that renders the same information. Used by the migration script and for
 * pages that were never opened in the builder.
 */
export function legacyFieldsToDocument(content: Record<string, unknown>, opts: { industry?: string; slug?: string; locationLevel?: boolean } = {}): PageDocument {
  const sections: Section[] = [];
  const known = new Set(['hero_title', 'hero_image', 'offer', 'intro_offer', 'about', 'brand_tagline']);
  const heading = str(content.hero_title);
  const offer = str(content.intro_offer) || str(content.offer);
  if (heading || str(content.hero_image) || offer || opts.slug === 'home') {
    sections.push({ id: 'legacy-hero', type: 'hero', props: { ...SECTION_DEFS.hero.defaults, eyebrow: str(content.brand_tagline), heading, body: offer, image: isSafeImage(str(content.hero_image)) ? str(content.hero_image) : '' }, style: {} });
  }
  if (str(content.about)) sections.push({ id: 'legacy-about', type: 'text', props: { heading: '', body: str(content.about) }, style: {} });
  for (const [k, v] of Object.entries(content)) {
    if (known.has(k) || typeof v !== 'string' || !v.trim()) continue;
    if (/^https:\/\/\S+\.(png|jpe?g|webp|avif|gif)(\?\S*)?$/i.test(v)) sections.push({ id: `legacy-${k}`.slice(0, 64), type: 'gallery', props: { heading: '', columns: '2', items: [{ image: v, alt: '', caption: '' }] }, style: {} });
    else sections.push({ id: `legacy-${k}`.slice(0, 64), type: 'text', props: { heading: '', body: v.slice(0, 6000) }, style: {} });
  }
  if (opts.slug === 'home' && opts.locationLevel !== false) {
    const block = opts.industry ? industryBlock[opts.industry] : undefined;
    if (block) sections.push({ id: 'legacy-module', type: block, props: { ...structuredClone((SECTION_DEFS[block] as SectionDef).defaults) }, style: {} });
    sections.push({ id: 'legacy-hours', type: 'hours', props: { heading: '', note: '' }, style: { background: 'muted' } });
    sections.push({ id: 'legacy-contact', type: 'contact_map', props: { ...SECTION_DEFS.contact_map.defaults }, style: { background: 'muted' } });
  }
  return { schemaVersion: PAGE_DOCUMENT_VERSION, sections };
}

/** Field → section prop bindings created by the migration, so the classic field editor keeps working. */
export const LEGACY_BINDINGS: Record<string, { sectionId: string; prop: string }> = {
  hero_title: { sectionId: 'legacy-hero', prop: 'heading' },
  hero_image: { sectionId: 'legacy-hero', prop: 'image' },
  offer: { sectionId: 'legacy-hero', prop: 'body' },
  intro_offer: { sectionId: 'legacy-hero', prop: 'body' },
  brand_tagline: { sectionId: 'legacy-hero', prop: 'eyebrow' },
  about: { sectionId: 'legacy-about', prop: 'body' },
};

export function applyLegacyField(doc: PageDocument, key: string, value: unknown): PageDocument {
  const b = LEGACY_BINDINGS[key] ?? { sectionId: `legacy-${key}`.slice(0, 64), prop: 'body' };
  if (!doc.sections.some((s) => s.id === b.sectionId)) return doc;
  return { ...doc, sections: doc.sections.map((s) => (s.id === b.sectionId ? { ...s, props: { ...s.props, [b.prop]: typeof value === 'string' ? value : '' } } : s)) };
}

// ───────── Navigation & SEO ─────────

export const pageSeoSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(170).optional(),
  socialImage: z.string().max(2048).refine((v) => isSafeImage(v), 'Use an https image').optional(),
  noindex: z.boolean().optional(),
  canonicalOwner: z.enum(['branchharbor', 'external']).optional(),
});
export type PageSeo = z.infer<typeof pageSeoSchema>;

export const navLinkSchema = z.object({ label: z.string().min(1).max(40), href: z.string().max(2048).refine(isSafeHref, 'Unsafe link') });
export type NavLink = z.infer<typeof navLinkSchema>;
