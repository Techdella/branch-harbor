'use client';

import '@bh/ui/site.css';
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { SITE_FONT_FAMILIES, SITE_FONT_KEYS, SITE_THEMES, createSection, googleFontsHref, resolveTheme, themesForFamily, type PageDocument, type SiteFont } from '@bh/shared';
import { SiteDocument } from '@bh/ui/site';
import { Badge, Button, Field, Input, Select, Tabs } from '@bh/ui';
import { Banner } from '@/components/ui/States';
import { mkt, useAction, type BuilderData, type ThemeSettings } from '../data';
import { previewContext, useSiteLabels } from './siteLabels';

/** Sample structure (the business's own words are used whenever it has a page). */
function fallbackDoc(t: (k: string) => string): PageDocument {
  return { schemaVersion: 1, sections: [
    createSection('hero', { eyebrow: t('preview.eyebrow'), heading: t('preview.heading'), body: t('preview.body'), ctaLabel: t('preview.cta'), ctaHref: '#' }),
    createSection('features', { heading: t('preview.featuresHeading'), items: [{ icon: 'star', title: t('preview.f1'), body: '' }, { icon: 'heart', title: t('preview.f2'), body: '' }, { icon: 'clock', title: t('preview.f3'), body: '' }] }, { background: 'muted' }),
    createSection('cta', { heading: t('preview.ctaHeading'), ctaLabel: t('preview.cta'), ctaHref: '#' }, { background: 'brand' }),
  ] };
}

export function ThemeGallery({ orgId, theme, industry, sample, canDesign, onSaved }: { orgId: string; theme: ThemeSettings; industry: string; sample: BuilderData | null; canDesign: boolean; onSaved: (t: ThemeSettings) => void }) {
  const t = useTranslations('mkt');
  const locale = useLocale();
  const labels = useSiteLabels();
  const a = useAction();
  const [draft, setDraft] = useState<ThemeSettings>(theme);
  const [filter, setFilter] = useState<'industry' | 'all'>('industry');
  const [saved, setSaved] = useState(false);
  const doc = useMemo(() => (sample?.document.sections.length ? sample.document : fallbackDoc((k) => t(`themes.${k}` as never))), [sample, t]);
  const ctx = useMemo(() => (sample ? previewContext(sample, locale) : { brandName: '', locale, location: null }), [sample, locale]);
  const list = filter === 'industry' ? themesForFamily(industry) : SITE_THEMES;
  const resolve = (id: string, d: ThemeSettings) => resolveTheme(id, { colorMode: d.colorMode, primaryColor: d.primaryColor, accentColor: d.accentColor, headingFont: d.headingFont as SiteFont | null, bodyFont: d.bodyFont as SiteFont | null });
  const current = resolve(draft.themeId, draft);

  useEffect(() => {
    const href = googleFontsHref(SITE_THEMES.flatMap((x) => [x.fonts.heading, x.fonts.body]).concat(draft.headingFont ? [draft.headingFont as SiteFont] : [], draft.bodyFont ? [draft.bodyFont as SiteFont] : []));
    if (!href) return;
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    document.head.appendChild(link);
    return () => link.remove();
  }, [draft.headingFont, draft.bodyFont]);

  async function save() {
    setSaved(false);
    const r = await a.run(() => mkt.setTheme(orgId, { themeId: draft.themeId, colorMode: draft.colorMode, primaryColor: draft.primaryColor, accentColor: draft.accentColor, headingFont: draft.headingFont, bodyFont: draft.bodyFont }));
    if (r) { setSaved(true); onSaved(r.theme); }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={filter} onChange={setFilter} items={[{ key: 'industry', label: t('themes.forYou') }, { key: 'all', label: t('themes.all') }]} />
          <span className="text-xs text-stone">{t('themes.contentKept')}</span>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" role="list">
          {list.map((th) => {
            const r = resolve(th.id, draft.themeId === th.id ? draft : { ...draft, colorMode: draft.colorMode, accentColor: null, headingFont: null, bodyFont: null });
            const active = draft.themeId === th.id;
            return (
              <li key={th.id}>
                <button type="button" onClick={() => setDraft((d) => ({ ...d, themeId: th.id, headingFont: null, bodyFont: null, accentColor: null }))} aria-pressed={active} className={`group block w-full overflow-hidden rounded-lg border-2 text-start transition ${active ? 'border-ink' : 'border-line hover:border-stone'}`}>
                  <div className="relative h-[220px] overflow-hidden bg-white" aria-hidden>
                    <div className="pointer-events-none absolute left-0 top-0 w-[1280px]" style={{ zoom: 0.25 }}>
                      <SiteDocument document={{ ...doc, sections: doc.sections.slice(0, 3) }} theme={r} ctx={ctx} labels={labels} preview />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-line-soft bg-surface px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold">{t(`themeNames.${th.id}` as never)}</div>
                      <div className="truncate text-xs text-stone">{t(`themeDesc.${th.id}` as never)}</div>
                    </div>
                    <span className="flex shrink-0 gap-1" aria-hidden>{[r.light.primary, r.light.accent, r.light.bg, r.dark.bg].map((c, i) => <span key={i} className="size-4 rounded-full border border-line" style={{ background: c }} />)}</span>
                  </div>
                  {theme.themeId === th.id && <div className="bg-ink px-3 py-1 text-[11px] font-bold text-white">{t('themes.current')}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <aside className="flex flex-col gap-3 xl:sticky xl:top-3 xl:self-start">
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="relative h-[420px] overflow-auto bg-white">
            <div className="w-[1280px]" style={{ zoom: 0.29 }}>
              <SiteDocument document={doc} theme={current} ctx={ctx} labels={labels} preview />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
          <h3 className="text-sm font-bold">{t('themes.brand')}</h3>
          <Tabs value={draft.colorMode} onChange={(v) => setDraft((d) => ({ ...d, colorMode: v }))} items={[{ key: 'theme', label: t('themes.themeColours') }, { key: 'brand', label: t('themes.brandColours') }]} />
          {draft.colorMode === 'brand' && <Field label={t('themes.primary')} hint={t('themes.primaryHint')}>{(p) => <div className="flex gap-2"><input type="color" aria-label={t('themes.primary')} value={draft.primaryColor} onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value.toUpperCase() }))} className="h-11 w-14 rounded-xs border border-line" /><Input id={p.id} value={draft.primaryColor} onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value }))} /></div>}</Field>}
          <Field label={t('themes.accent')} optional>{(p) => <div className="flex gap-2"><input type="color" aria-label={t('themes.accent')} value={draft.accentColor ?? current.light.accent} onChange={(e) => setDraft((d) => ({ ...d, accentColor: e.target.value.toUpperCase() }))} className="h-11 w-14 rounded-xs border border-line" /><Input id={p.id} value={draft.accentColor ?? ''} placeholder={current.light.accent} onChange={(e) => setDraft((d) => ({ ...d, accentColor: e.target.value || null }))} /></div>}</Field>
          <Field label={t('themes.headingFont')}>{(p) => <Select id={p.id} value={draft.headingFont ?? ''} onChange={(e) => setDraft((d) => ({ ...d, headingFont: e.target.value || null }))}><option value="">{t('themes.themeDefault', { font: SITE_FONT_FAMILIES[current.fonts.heading].family })}</option>{SITE_FONT_KEYS.map((f) => <option key={f} value={f}>{SITE_FONT_FAMILIES[f].family}</option>)}</Select>}</Field>
          <Field label={t('themes.bodyFont')}>{(p) => <Select id={p.id} value={draft.bodyFont ?? ''} onChange={(e) => setDraft((d) => ({ ...d, bodyFont: e.target.value || null }))}><option value="">{t('themes.themeDefault', { font: SITE_FONT_FAMILIES[current.fonts.body].family })}</option>{SITE_FONT_KEYS.map((f) => <option key={f} value={f}>{SITE_FONT_FAMILIES[f].family}</option>)}</Select>}</Field>
          {a.error && <Banner tone="danger">{a.error.message}</Banner>}
          {saved && <Banner tone="success" live="polite">{t('themes.saved')}</Banner>}
          {canDesign ? <Button variant="signal" icon="palette" loading={a.pending} onClick={save}>{t('themes.apply')}</Button> : <p className="text-xs text-stone">{t('themes.hqOnly')}</p>}
          {draft.themeId !== theme.themeId && <Badge tone="info">{t('themes.unsaved')}</Badge>}
        </div>
      </aside>
    </div>
  );
}
