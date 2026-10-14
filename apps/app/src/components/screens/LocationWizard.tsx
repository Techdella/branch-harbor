'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import { LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES } from '@bh/shared';
import { countryName, currencyName, fmtTime, zoneLabel } from '@/lib/format';

export const COUNTRY_ZONES: Record<string, string[]> = {
  US: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
  CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns'],
  GB: ['Europe/London'], IE: ['Europe/Dublin'], DE: ['Europe/Berlin'], FR: ['Europe/Paris'], ES: ['Europe/Madrid', 'Atlantic/Canary'], NL: ['Europe/Amsterdam'], IT: ['Europe/Rome'],
  AU: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth'], NZ: ['Pacific/Auckland'], SG: ['Asia/Singapore'], AE: ['Asia/Dubai'],
  BR: ['America/Sao_Paulo', 'America/Manaus'], MX: ['America/Mexico_City', 'America/Tijuana', 'America/Cancun'],
};

const OVERRIDES = ['hours', 'prices', 'offers', 'images', 'staff'] as const;
const SHARED = ['brand', 'nav', 'legal', 'descriptions'] as const;

export interface LocationDraft {
  name: string;
  code: string;
  ownerGroup: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  timeZone: string;
  currency: string;
  phone: string;
  email: string;
  hours: string;
  template: string;
  overrides: Record<string, boolean>;
}

export const EMPTY_LOCATION: LocationDraft = {
  name: '', code: '', ownerGroup: 'Company-owned', line1: '', city: '', region: '', postalCode: '', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', phone: '', email: '', hours: '', template: 'Standard location · v15',
  overrides: { hours: true, prices: true, offers: true, images: false, staff: true },
};

export function validateLocation(d: LocationDraft, t: (k: string) => string) {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = t('errors.name');
  if (!d.code.trim()) e.code = t('errors.code');
  else if (!/^[A-Z0-9-]{2,24}$/.test(d.code)) e.code = t('errors.codeFormat');
  if (!d.line1.trim()) e.line1 = t('errors.line1');
  if (!d.city.trim()) e.city = t('errors.city');
  if (!d.timeZone) e.timeZone = t('errors.timeZone');
  if (d.email && !/^\S+@\S+\.\S+$/.test(d.email)) e.email = t('errors.email');
  return e;
}

/** Location wizard fields + shared-vs-local preview. Used in onboarding and Locations › Add. */
export function LocationWizard({ value, onChange, errors, ownerGroups, compact }: { value: LocationDraft; onChange: (d: LocationDraft) => void; errors: Record<string, string>; ownerGroups: string[]; compact?: boolean }) {
  const t = useTranslations('wizard');
  const locale = useLocale();
  const set = <K extends keyof LocationDraft>(k: K, v: LocationDraft[K]) => onChange({ ...value, [k]: v });
  const allZones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return Object.values(COUNTRY_ZONES).flat();
    }
  }, []);
  const suggested = COUNTRY_ZONES[value.country] ?? [];
  const errCount = Object.keys(errors).length;
  const summaryRef = useRef<HTMLDivElement>(null);

  const onCountry = (code: string) => {
    const c = LAUNCH_COUNTRIES.find((x) => x.code === code);
    onChange({ ...value, country: code, currency: c?.currency ?? value.currency, timeZone: COUNTRY_ZONES[code]?.[0] ?? value.timeZone });
  };

  return (
    <div className="flex flex-col gap-5">
      {errCount > 0 && (
        <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-md bg-danger-bg p-3.5 text-sm text-danger">
          <strong>{t('errorSummary', { count: errCount })}</strong>
          <ul className="mt-1 list-disc pl-5">
            {Object.entries(errors).map(([k, v]) => (
              <li key={k}>{v}</li>
            ))}
          </ul>
        </div>
      )}
      <fieldset className="grid gap-3.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('identity')}</legend>
        <Field label={t('name')} error={errors.name}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.name} onChange={(e) => set('name', e.target.value)} placeholder={t('namePh')} />}</Field>
        <Field label={t('code')} hint={t('codeHint')} error={errors.code}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="LDN-SH" />}</Field>
        <Field label={t('ownerGroup')}>
          {(p) => (
            <Select id={p.id} value={value.ownerGroup} onChange={(e) => set('ownerGroup', e.target.value)}>
              {ownerGroups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('template')}>
          {(p) => (
            <Select id={p.id} value={value.template} onChange={(e) => set('template', e.target.value)}>
              <option value="Standard location · v15">{t('templateStandard')}</option>
              <option value="Flagship location · v3">{t('templateFlagship')}</option>
              <option value="Pop-up / seasonal · v2">{t('templatePopup')}</option>
            </Select>
          )}
        </Field>
      </fieldset>

      <fieldset className="grid gap-3.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('address')}</legend>
        <Field label={t('country')}>
          {(p) => (
            <Select id={p.id} value={value.country} onChange={(e) => onCountry(e.target.value)}>
              {LAUNCH_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {countryName(c.code, locale)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('line1')} error={errors.line1}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.line1} onChange={(e) => set('line1', e.target.value)} autoComplete="address-line1" />}</Field>
        <Field label={t('city')} error={errors.city}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.city} onChange={(e) => set('city', e.target.value)} autoComplete="address-level2" />}</Field>
        <Field label={t('region')} optional>{(p) => <Input id={p.id} value={value.region} onChange={(e) => set('region', e.target.value)} autoComplete="address-level1" />}</Field>
        <Field label={t('postalCode')} optional hint={t('postalHint')}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} value={value.postalCode} onChange={(e) => set('postalCode', e.target.value)} autoComplete="postal-code" />}</Field>
      </fieldset>

      <fieldset className="grid gap-3.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('localSettings')}</legend>
        <Field label={t('timeZone')} hint={value.timeZone ? t('localNow', { time: fmtTime(new Date().toISOString(), value.timeZone, locale), zone: zoneLabel(value.timeZone, locale) }) : undefined} error={errors.timeZone}>
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.timeZone} onChange={(e) => set('timeZone', e.target.value)}>
              <option value="">{t('choose')}</option>
              {suggested.length > 0 && (
                <optgroup label={t('suggested', { country: countryName(value.country, locale) })}>
                  {suggested.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t('allZones')}>
                {allZones.filter((z) => !suggested.includes(z)).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </optgroup>
            </Select>
          )}
        </Field>
        <Field label={t('currency')} hint={t('currencyHint')}>
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} value={value.currency} onChange={(e) => set('currency', e.target.value)}>
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c} · {currencyName(c, locale)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('phone')} optional>{(p) => <Input id={p.id} type="tel" value={value.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+44 20 7946 0321" autoComplete="tel" />}</Field>
        <Field label={t('email')} optional error={errors.email}>{(p) => <Input id={p.id} type="email" aria-describedby={p.describedBy} aria-invalid={p.invalid} value={value.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" />}</Field>
        <Field label={t('hours')} optional hint={t('hoursHint')}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} value={value.hours} onChange={(e) => set('hours', e.target.value)} placeholder={t('hoursPh')} />}</Field>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-bold">{t('overrides')}</legend>
        <p className="mb-2.5 text-xs text-stone">{t('overridesHint')}</p>
        <div className="flex flex-wrap gap-2">
          {OVERRIDES.map((k) => (
            <label key={k} className={cx('flex h-10 cursor-pointer items-center gap-2 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', value.overrides[k] ? 'border-ink bg-lime-soft' : 'border-line-soft')}>
              <input type="checkbox" checked={!!value.overrides[k]} onChange={(e) => set('overrides', { ...value.overrides, [k]: e.target.checked })} className="h-4 w-4 accent-ink" />
              {t(`override.${k}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className={cx('grid gap-3', !compact && 'md:grid-cols-2')}>
        <div className="rounded-lg bg-canvas p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Icon name="lock" size={16} />
            {t('sharedTitle')}
          </div>
          <ul className="text-[13px] leading-7">
            {SHARED.map((k) => (
              <li key={k}>{t(`shared.${k}`)}</li>
            ))}
            {OVERRIDES.filter((k) => !value.overrides[k]).map((k) => (
              <li key={k}>{t(`override.${k}`)}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg bg-lime-soft p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Icon name="edit" size={16} />
            {t('localTitle')}
          </div>
          <ul className="text-[13px] leading-7">
            <li>
              {t('timeZone')}: {value.timeZone.replace(/_/g, ' ') || '—'}
            </li>
            <li>
              {t('currency')}: {value.currency}
            </li>
            {OVERRIDES.filter((k) => value.overrides[k]).map((k) => (
              <li key={k}>{t(`override.${k}`)}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="flex items-start gap-2 rounded-md bg-canvas p-3.5 text-[13px]">
        <Icon name="eye" size={16} className="mt-0.5 shrink-0" />
        {t('notPublished')}
      </p>
    </div>
  );
}

export function WizardSaveBar({ onSave, saving, label }: { onSave: () => void; saving: boolean; label: string }) {
  return (
    <div className="sticky bottom-3 flex justify-end">
      <Button size="lg" loading={saving} onClick={onSave} className="shadow-pop">
        {label}
      </Button>
    </div>
  );
}
