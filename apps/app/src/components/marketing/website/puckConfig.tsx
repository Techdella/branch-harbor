'use client';

/**
 * Puck configuration generated from the shared section library (SECTION_DEFS): one component per section type,
 * fields from the field specs (inline-editable text, links, images from the asset library, lists), style options
 * constrained to theme tokens, and per-section governance (locked / editable / approval) as Puck permissions.
 * Rendering uses the same SectionView as the public sites, so the canvas is WYSIWYG for the chosen theme.
 */
import type { ComponentConfig, Config, Data, Field, Fields } from '@puckeditor/core';
import {
  DEFAULT_STYLE, LOCK_MODES, SECTION_ALIGN, SECTION_BACKGROUNDS, SECTION_DEFS, SECTION_SPACING, type FieldSpec, type PageDocument, type ResolvedTheme, type Section, type SectionDef,
} from '@bh/shared';
import { SectionView, SiteThemeRoot, type SiteContext, type SiteLabels } from '@bh/ui/site';
import { ImageField } from '../assets/AssetPicker';

type T = (key: string, values?: Record<string, string | number>) => string;
type Props = Record<string, unknown> & { id: string };

const STYLE_KEYS = ['bg', 'spacing', 'align', 'focalX', 'focalY'] as const;
const META = '_meta';
const LOCK = '_lock';

export interface SectionMeta { origin?: Section['origin']; masterId?: string; hq?: Section['hq']; pending?: Section['pending']; hidden?: boolean }

export const CATEGORIES: Record<string, Array<keyof typeof SECTION_DEFS>> = {
  hero: ['hero', 'hero_split', 'hero_video'],
  content: ['text', 'image_text', 'features', 'faq', 'blog_list'],
  media: ['gallery', 'logos', 'testimonials', 'team'],
  conversion: ['cta', 'pricing', 'form', 'newsletter'],
  location: ['contact_map', 'hours', 'footer'],
  industry: ['class_schedule', 'programmes', 'services', 'product_grid', 'menu', 'listings', 'rooms'],
};

/** Section → Puck item. Style and governance travel as extra props. */
export function toPuck(doc: PageDocument): Data {
  return {
    root: { props: {} },
    content: doc.sections.map((s) => {
      const st = { ...DEFAULT_STYLE, ...(s.style ?? {}) };
      const meta: SectionMeta = { origin: s.origin, masterId: s.masterId, hq: s.hq, pending: s.pending, hidden: s.hidden };
      return { type: s.type, props: { id: s.id, ...s.props, bg: st.background, spacing: st.spacing, align: st.align, focalX: st.focalX, focalY: st.focalY, [LOCK]: s.lock ?? 'editable', [META]: meta } };
    }),
  };
}

/** Puck data → page document (drops editor-only values). */
export function fromPuck(data: Data, opts: { master: boolean }): PageDocument {
  return {
    schemaVersion: 1,
    sections: (data.content ?? []).map((item) => {
      const p = item.props as Props;
      const def = (SECTION_DEFS as Record<string, SectionDef>)[item.type];
      const props: Record<string, unknown> = {};
      for (const k of Object.keys(def?.fields ?? {})) if (k in p) props[k] = p[k];
      const meta = (p[META] ?? {}) as SectionMeta;
      const s: Section = {
        id: p.id, type: item.type, props,
        style: { background: (p.bg as never) ?? 'default', spacing: (p.spacing as never) ?? 'normal', align: (p.align as never) ?? 'start', focalX: Number(p.focalX ?? 50), focalY: Number(p.focalY ?? 50) },
        ...(meta.hidden ? { hidden: true } : {}),
        ...(meta.origin ? { origin: meta.origin } : {}), ...(meta.masterId ? { masterId: meta.masterId } : {}), ...(meta.hq ? { hq: meta.hq } : {}), ...(meta.pending ? { pending: meta.pending } : {}),
        ...(opts.master ? { lock: (p[LOCK] as Section['lock']) ?? 'editable' } : {}),
      };
      return s;
    }),
  };
}

function fieldFor(name: string, spec: FieldSpec, t: T, forms: Array<{ id: string; name: string }>, orgId: string): Field {
  const label = t(`fields.${name}`);
  switch (spec.kind) {
    case 'text': return { type: 'text', label, contentEditable: spec.inline };
    case 'textarea': return { type: 'textarea', label, contentEditable: spec.inline };
    case 'url': return { type: 'text', label, placeholder: 'https://' };
    case 'image': return { type: 'custom', label, render: ({ value, onChange, readOnly }) => <ImageField orgId={orgId} label={label} value={typeof value === 'string' ? value : ''} onChange={onChange} readOnly={readOnly} /> };
    case 'select': return { type: 'select', label, options: spec.options.map((o) => ({ label: /^\d+$/.test(o) ? o : t(`opt.${o}`), value: o })) };
    case 'number': return { type: 'number', label, min: spec.min, max: spec.max };
    case 'boolean': return { type: 'radio', label, options: [{ label: t('opt.yes'), value: true }, { label: t('opt.no'), value: false }] };
    case 'form': return { type: 'select', label, options: [{ label: t('builder.chooseForm'), value: '' }, ...forms.map((f) => ({ label: f.name, value: f.id }))] };
    case 'list': {
      const arrayFields: Record<string, Field> = {};
      for (const [k, s] of Object.entries(spec.item)) arrayFields[k] = fieldFor(k, s.kind === 'text' || s.kind === 'textarea' ? { ...s, inline: false } : s, t, forms, orgId);
      const first = Object.keys(spec.item)[0]!;
      return { type: 'array', label, max: spec.max, arrayFields, defaultItemProps: Object.fromEntries(Object.entries(spec.item).map(([k, s]) => [k, s.kind === 'boolean' ? false : s.kind === 'select' ? s.options[0] : ''])), getItemSummary: (item: Record<string, unknown>, i?: number) => (typeof item[first] === 'string' && item[first] ? String(item[first]).slice(0, 40) : t('builder.item', { n: (i ?? 0) + 1 })) } as Field;
    }
  }
}

export interface ConfigInput {
  t: T;
  theme: ResolvedTheme;
  ctx: SiteContext;
  labels: SiteLabels;
  forms: Array<{ id: string; name: string }>;
  orgId: string;
  /** HQ master editing: lock-mode selector visible on every section. */
  master: boolean;
  /** May change HQ-locked content (brand owner / HQ). */
  canHq: boolean;
  industry: string;
}

export function buildConfig(i: ConfigInput): Config {
  const { t } = i;
  const components: Record<string, ComponentConfig> = {};
  for (const [type, def] of Object.entries(SECTION_DEFS as Record<string, SectionDef>)) {
    const fields: Fields = {};
    for (const [name, spec] of Object.entries(def.fields)) fields[name] = fieldFor(name, spec, t, i.forms, i.orgId);
    fields.bg = { type: 'select', label: t('style.background'), options: SECTION_BACKGROUNDS.map((v) => ({ label: t(`style.bg.${v}`), value: v })) };
    fields.spacing = { type: 'radio', label: t('style.spacing'), options: SECTION_SPACING.map((v) => ({ label: t(`style.sp.${v}`), value: v })) };
    fields.align = { type: 'radio', label: t('style.align'), options: SECTION_ALIGN.map((v) => ({ label: t(`style.al.${v}`), value: v })) };
    if (def.hasImage) {
      fields.focalX = { type: 'number', label: t('style.focalX'), min: 0, max: 100, step: 5 };
      fields.focalY = { type: 'number', label: t('style.focalY'), min: 0, max: 100, step: 5 };
    }
    if (i.master) fields[LOCK] = { type: 'radio', label: t('gov.lockField'), options: LOCK_MODES.map((v) => ({ label: t(`gov.lock.${v}`), value: v })) };
    components[type] = {
      label: t(`sections.${type}`),
      fields,
      defaultProps: { ...structuredClone(def.defaults), bg: 'default', spacing: 'normal', align: 'start', focalX: 50, focalY: 50, [LOCK]: 'editable', [META]: { origin: 'local' } },
      resolvePermissions: (data) => {
        const meta = ((data.props as Props)[META] ?? {}) as SectionMeta;
        if (!i.canHq && meta.origin === 'locked') return { edit: false, delete: false, drag: false, duplicate: false };
        if (!i.canHq && meta.origin === 'approval') return { delete: false, duplicate: false };
        return {};
      },
      render: (raw) => {
        const p = raw as unknown as Props;
        const meta = (p[META] ?? {}) as SectionMeta;
        const props: Record<string, unknown> = {};
        for (const k of Object.keys(def.fields)) props[k] = p[k];
        const section = { id: p.id, type, props, style: { background: p.bg as never, spacing: p.spacing as never, align: p.align as never, focalX: Number(p.focalX ?? 50), focalY: Number(p.focalY ?? 50) } };
        const badge = i.master ? (p[LOCK] !== 'editable' ? t(`gov.lock.${String(p[LOCK])}`) : null)
          : meta.pending ? t('gov.pending') : meta.origin === 'locked' ? t('gov.locked') : meta.origin === 'approval' ? t('gov.approval') : meta.origin === 'local' && meta.masterId ? t('gov.override') : null;
        return (
          <div className="relative" data-gov={meta.origin ?? 'local'}>
            {badge && <span className="pointer-events-none absolute end-3 top-3 z-10 rounded-full bg-ink px-2.5 py-1 text-[11px] font-bold text-white shadow">{badge}</span>}
            <SectionView section={section} ctx={i.ctx} labels={i.labels} preview renderForm={({ formId }) => <PreviewForm name={i.forms.find((f) => f.id === formId)?.name ?? ''} label={t('builder.formPreview')} />} renderNewsletter={({ buttonLabel }) => <PreviewForm name="" label={buttonLabel || t('builder.newsletterPreview')} />} />
          </div>
        );
      },
    };
  }
  const order = Object.values(CATEGORIES).flat();
  return {
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, list]) => [k, { title: t(`cat.${k}`), components: list as string[], defaultExpanded: true }])) as Config['categories'],
    components: Object.fromEntries(order.map((k) => [k, components[k]!])),
    // No page-level fields: title and SEO live in Page settings.
    root: { fields: {}, render: ({ children }: { children: React.ReactNode }) => <SiteThemeRoot theme={i.theme}>{children}</SiteThemeRoot> },
  } as Config;
}

function PreviewForm({ name, label }: { name: string; label: string }) {
  return (
    <div className="bhs-form" aria-hidden>
      <div className="bhs-empty">{name || label}</div>
      <span className="bhs-btn bhs-btn-primary" style={{ justifySelf: 'start' }}>{label}</span>
    </div>
  );
}

export { STYLE_KEYS };
