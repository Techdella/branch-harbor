'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, cx } from '@bh/ui';
import { SITE_FONT_FAMILIES, SITE_FONT_KEYS, SITE_THEMES, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES } from '@bh/shared';
import { brandsApi, type ApiBrand, type BrandFranchiseTerms, type BrandInput } from '@/lib/http/brands';
import { ApiError } from '@/lib/errors';
import { currencyName } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Banner, DeniedState, SectionCard } from '../ui/States';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Settings → Brands: each brand's identity, sender, templates and franchise terms (multi-brand HQ). */
export function BrandsScreen() {
  const t = useTranslations('brands');
  const app = useApp();
  const [selected, setSelected] = useState<string | null>(app.brandId ?? app.brands[0]?.id ?? null);
  const [adding, setAdding] = useState(false);
  const canEditAny = app.canManageBrands || app.hasModule('network.templates');
  if (!app.brands.length || (!app.orgMultiBrand && !app.canManageBrands)) return <DeniedState detail={t('settings.denied')} />;
  const brand = app.brands.find((b) => b.id === selected) ?? app.brands[0]!;
  return (
    <>
      <PageHeader
        icon="layers"
        title={t('settings.title')}
        description={t('settings.description')}
        scope={false}
        actions={
          app.canManageBrands && (
            <Button icon="plus" onClick={() => setAdding(true)}>
              {t('settings.add')}
            </Button>
          )
        }
      />
      {adding && <AddBrand onDone={(id) => (setAdding(false), id && setSelected(id))} />}
      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label={t('settings.list')} className="flex flex-col gap-2 rounded-xl bg-surface p-3" data-testid="brand-list">
          {app.brands.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected(b.id)}
              aria-current={b.id === brand.id ? 'true' : undefined}
              className={cx('flex items-center gap-3 rounded-lg p-3 text-left', b.id === brand.id ? 'bg-ink text-white' : 'hover:bg-canvas')}
            >
              <BrandMark brand={b} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{b.name}</span>
                <span className={cx('block text-xs', b.id === brand.id ? 'text-white/70' : 'text-stone')}>
                  {t('settings.locationCount', { count: b.locationCount })}
                  {b.isDefault ? ` · ${t('settings.main')}` : ''}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-col gap-3">
          <BrandForm key={brand.id} brand={brand} canEdit={canEditAny} canRename={app.canManageBrands} />
          <FranchiseTerms brandId={brand.id} />
        </div>
      </div>
    </>
  );
}

export function BrandMark({ brand, size = 40 }: { brand: Pick<ApiBrand, 'name' | 'logoUrl' | 'primaryColor' | 'accentColor'>; size?: number }) {
  return brand.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={brand.logoUrl} alt="" width={size} height={size} className="shrink-0 rounded-[12px] bg-white object-contain" />
  ) : (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-[12px] text-sm font-extrabold text-white" style={{ width: size, height: size, background: brand.primaryColor ?? '#141414' }}>
      {brand.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function AddBrand({ onDone }: { onDone: (id?: string) => void }) {
  const t = useTranslations('brands');
  const app = useApp();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SectionCard title={t('settings.addTitle')}>
      <p className="mb-3 text-sm text-stone">{t('settings.addHint')}</p>
      {error && <Banner tone="danger" live="assertive">{error}</Banner>}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            const b = await brandsApi.create(app.org.id, { name: name.trim() });
            await app.reloadWorkspace();
            onDone(b.id);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t('settings.error'));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="min-w-[240px] flex-1">
          <Field label={t('fields.name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />}</Field>
        </div>
        <Button type="submit" loading={pending} disabled={!name.trim()}>
          {t('settings.create')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone()}>
          {t('settings.cancel')}
        </Button>
      </form>
    </SectionCard>
  );
}

function BrandForm({ brand, canEdit, canRename }: { brand: ApiBrand; canEdit: boolean; canRename: boolean }) {
  const t = useTranslations('brands');
  const tm = useTranslations('mkt');
  const locale = useLocale();
  const app = useApp();
  const [form, setForm] = useState<ApiBrand>(brand);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  useEffect(() => setForm(brand), [brand]);
  const set = <K extends keyof ApiBrand>(k: K, v: ApiBrand[K]) => (setSaved(false), setForm((f) => ({ ...f, [k]: v })));
  const languageName = (l: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(l) ?? l;
    } catch {
      return l;
    }
  };
  const colour = (k: 'primaryColor' | 'accentColor', label: string) => (
    <Field label={label} error={error?.fields?.[k]}>
      {(p) => (
        <span className="flex items-center gap-2">
          <input type="color" aria-label={label} value={form[k] && HEX.test(form[k]!) ? form[k]! : '#141414'} onChange={(e) => set(k, e.target.value.toUpperCase())} disabled={!canEdit} className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1" />
          <Input id={p.id} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value || null)} placeholder="#2F6B3A" disabled={!canEdit} />
        </span>
      )}
    </Field>
  );
  const save = async () => {
    setPending(true);
    setError(null);
    const input: BrandInput = {
      logoUrl: form.logoUrl || null, primaryColor: form.primaryColor || null, accentColor: form.accentColor || null, headingFont: form.headingFont || null, bodyFont: form.bodyFont || null,
      themeId: form.themeId || null, tagline: form.tagline || null, domain: form.domain || null, locales: form.locales, defaultCurrency: form.defaultCurrency || null,
      emailFromName: form.emailFromName || null, emailReplyTo: form.emailReplyTo || null,
      ...(canRename ? { name: form.name, ...(brand.isDefault ? {} : { slug: form.slug ?? undefined }) } : {}),
    };
    try {
      await brandsApi.update(app.org.id, brand.id, input);
      await app.reloadWorkspace();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? { message: err.message, fields: err.fields } : { message: t('settings.error') });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {saved && <Banner tone="success" live="polite">{t('settings.saved')}</Banner>}
      {error && <Banner tone="danger" live="assertive">{error.message}</Banner>}
      <SectionCard title={t('sections.identity')} aside={brand.isDefault ? <Badge tone="neutral">{t('settings.main')}</Badge> : null}>
        <div className="grid gap-3.5 md:grid-cols-2">
          <Field label={t('fields.name')} error={error?.fields?.name}>{(p) => <Input id={p.id} value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!canRename} />}</Field>
          <Field label={t('fields.slug')} hint={t('fields.slugHint')} error={error?.fields?.slug}>
            {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={form.slug ?? ''} onChange={(e) => set('slug', e.target.value)} disabled={!canRename || brand.isDefault} />}
          </Field>
          <Field label={t('fields.logoUrl')} error={error?.fields?.logoUrl}>{(p) => <Input id={p.id} type="url" value={form.logoUrl ?? ''} onChange={(e) => set('logoUrl', e.target.value || null)} placeholder="https://" disabled={!canEdit} />}</Field>
          <Field label={t('fields.tagline')}>{(p) => <Input id={p.id} value={form.tagline ?? ''} onChange={(e) => set('tagline', e.target.value || null)} maxLength={160} disabled={!canEdit} />}</Field>
          {colour('primaryColor', t('fields.primaryColor'))}
          {colour('accentColor', t('fields.accentColor'))}
          <Field label={t('fields.headingFont')}>
            {(p) => (
              <Select id={p.id} value={form.headingFont ?? ''} onChange={(e) => set('headingFont', e.target.value || null)} disabled={!canEdit}>
                <option value="">{t('fields.inherit')}</option>
                {SITE_FONT_KEYS.map((f) => <option key={f} value={f}>{SITE_FONT_FAMILIES[f].family}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('fields.bodyFont')}>
            {(p) => (
              <Select id={p.id} value={form.bodyFont ?? ''} onChange={(e) => set('bodyFont', e.target.value || null)} disabled={!canEdit}>
                <option value="">{t('fields.inherit')}</option>
                {SITE_FONT_KEYS.map((f) => <option key={f} value={f}>{SITE_FONT_FAMILIES[f].family}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('fields.theme')} hint={t('fields.themeHint')}>
            {(p) => (
              <Select id={p.id} aria-describedby={p.describedBy} value={form.themeId ?? ''} onChange={(e) => set('themeId', e.target.value || null)} disabled={!canEdit}>
                <option value="">{t('fields.inherit')}</option>
                {SITE_THEMES.map((th) => <option key={th.id} value={th.id}>{tm(`themeNames.${th.id}` as never)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('fields.domain')} hint={t('fields.domainHint')} error={error?.fields?.domain}>
            {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={form.domain ?? ''} onChange={(e) => set('domain', e.target.value || null)} placeholder="www.yourbusiness.example" disabled={!canEdit} />}
          </Field>
          <Field label={t('fields.currency')}>
            {(p) => (
              <Select id={p.id} value={form.defaultCurrency ?? ''} onChange={(e) => set('defaultCurrency', (e.target.value || null) as ApiBrand['defaultCurrency'])} disabled={!canEdit}>
                <option value="">{t('fields.inherit')}</option>
                {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c, locale)}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="mt-4">
          <legend className="mb-2 text-sm font-bold">{t('fields.locales')}</legend>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_LOCALES.map((l) => {
              const on = form.locales.includes(l);
              return (
                <label key={l} className={cx('flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm font-semibold', on ? 'border-ink bg-ink text-white' : 'border-line bg-surface')}>
                  <input type="checkbox" className="sr-only" checked={on} disabled={!canEdit} onChange={() => set('locales', on ? form.locales.filter((x) => x !== l) : [...form.locales, l])} />
                  {languageName(l)}
                </label>
              );
            })}
          </div>
        </fieldset>
        <BrandPreview brand={form} />
      </SectionCard>
      <SectionCard title={t('sections.email')}>
        <p className="mb-3 text-sm text-stone">{t('fields.senderHint')}</p>
        <div className="grid gap-3.5 md:grid-cols-2">
          <Field label={t('fields.fromName')}>{(p) => <Input id={p.id} value={form.emailFromName ?? ''} onChange={(e) => set('emailFromName', e.target.value || null)} maxLength={80} disabled={!canEdit} />}</Field>
          <Field label={t('fields.replyTo')} error={error?.fields?.emailReplyTo}>{(p) => <Input id={p.id} type="email" value={form.emailReplyTo ?? ''} onChange={(e) => set('emailReplyTo', e.target.value || null)} disabled={!canEdit} />}</Field>
        </div>
      </SectionCard>
      <SectionCard title={t('sections.templates')}>
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('templates.site')}</span>
            <Link className="font-bold underline" href="/marketing/websites">{t('templates.open')}</Link>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('templates.email')}</span>
            <Link className="font-bold underline" href="/marketing/email">{t('templates.open')}</Link>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('templates.assets')}</span>
            <Link className="font-bold underline" href="/marketing/assets">{t('templates.open')}</Link>
          </li>
        </ul>
        <p className="mt-3 text-xs text-stone">{t('templates.hint')}</p>
      </SectionCard>
      {canEdit && (
        <div className="flex justify-end">
          <Button loading={pending} onClick={save}>
            {t('settings.save')}
          </Button>
        </div>
      )}
    </>
  );
}

/** How the brand's identity looks on its sites (colours, fonts, logo). */
function BrandPreview({ brand }: { brand: ApiBrand }) {
  const t = useTranslations('brands');
  const primary = brand.primaryColor && HEX.test(brand.primaryColor) ? brand.primaryColor : '#141414';
  const accent = brand.accentColor && HEX.test(brand.accentColor) ? brand.accentColor : '#F3F1EC';
  const heading = brand.headingFont ? SITE_FONT_FAMILIES[brand.headingFont as keyof typeof SITE_FONT_FAMILIES]?.family : undefined;
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-line" aria-label={t('preview.label')} data-testid="brand-preview">
      <div className="flex items-center gap-3 px-4 py-3" style={{ background: accent }}>
        <BrandMark brand={brand} size={32} />
        <span className="text-lg font-bold" style={{ fontFamily: heading }}>{brand.name}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface px-4 py-4">
        <span className="text-sm text-stone">{brand.tagline ?? t('preview.tagline')}</span>
        <span className="rounded-full px-4 py-2 text-sm font-bold text-white" style={{ background: primary }}>{t('preview.button')}</span>
      </div>
    </div>
  );
}

function FranchiseTerms({ brandId }: { brandId: string }) {
  const t = useTranslations('brands');
  const app = useApp();
  const [data, setData] = useState<BrandFranchiseTerms | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    brandsApi.franchiseTerms(app.org.id, brandId).then((d) => live && setData(d)).catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [app.org.id, brandId]);
  if (!data || (!data.disclosureDocuments && !data.royaltyTerms)) return null;
  const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return (
    <SectionCard title={t('sections.franchise')} aside={<span className="text-xs text-stone">{t('franchise.hint')}</span>}>
      <div className="grid gap-4 md:grid-cols-3">
        {data.disclosureDocuments && (
          <div>
            <h3 className="mb-2 text-sm font-bold">{t('franchise.disclosure')}</h3>
            <DocList items={data.disclosureDocuments} />
          </div>
        )}
        {data.agreementTemplates && (
          <div>
            <h3 className="mb-2 text-sm font-bold">{t('franchise.agreements')}</h3>
            <DocList items={data.agreementTemplates} />
          </div>
        )}
        {data.royaltyTerms && (
          <div>
            <h3 className="mb-2 text-sm font-bold">{t('franchise.royalties')}</h3>
            {data.royaltyTerms.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {data.royaltyTerms.map((r) => (
                  <li key={r.id}>{t('franchise.rate', { currency: r.currency, royalty: pct(r.royaltyBps), fund: pct(r.marketingFundBps) })}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone">{t('franchise.networkTerms')}</p>
            )}
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-stone">{t('franchise.onboarding', { key: data.onboardingTemplateKey })}</p>
    </SectionCard>
  );
}

function DocList({ items }: { items: { id: string; title: string; version: string; status: string; shared: boolean }[] }) {
  const t = useTranslations('brands');
  const current = items.filter((d) => d.status === 'current');
  if (!current.length) return <p className="text-sm text-stone">{t('franchise.none')}</p>;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {current.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold">{d.title}</span>
          <span className="text-stone">v{d.version}</span>
          {d.shared && <Badge tone="neutral">{t('franchise.shared')}</Badge>}
        </li>
      ))}
    </ul>
  );
}
