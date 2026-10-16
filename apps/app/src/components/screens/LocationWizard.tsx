'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import { LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES, type LocationIndustryField } from '@bh/shared';
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
  /** Network → Add location (live form): ids from the form options, and the industry details. */
  brandId?: string | null;
  templateId?: string;
  ownerGroupId?: string;
  regionId?: string;
  territoryId?: string;
  industry?: Record<string, string | number | boolean>;
}

/** What the Add location form offers the person (`GET /orgs/:orgId/locations/form-options`). */
export interface LocationFormOptions {
  industry: string;
  defaults: { country: string; currency: string; timeZone: string; locale: string };
  organizationWide: boolean;
  /** Several brands to choose from (the picker is hidden otherwise). */
  brandPicker: boolean;
  brands: { id: string; name: string; isDefault: boolean; defaultCurrency: string | null; primaryColor: string | null }[];
  templates: { id: string; name: string; industry: string | null; brandId: string | null; version: number }[];
  ownerGroups: { id: string; name: string }[];
  regions: { id: string; name: string }[];
  territories: { id: string; name: string; kind: string; country: string | null; brandId: string | null }[];
  industryFields: LocationIndustryField[];
}

/** Templates and territories a location of this brand can use (none = the main brand; brandless ones fit every brand). */
export function fitsBrand(o: LocationFormOptions, recordBrand: string | null, chosen: string | null | undefined) {
  const main = o.brands.find((b) => b.isDefault)?.id ?? null;
  return !recordBrand || recordBrand === (chosen ?? main);
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
export function LocationWizard({ value, onChange, errors, ownerGroups, compact, options }: { value: LocationDraft; onChange: (d: LocationDraft) => void; errors: Record<string, string>; ownerGroups: string[]; compact?: boolean; options?: LocationFormOptions }) {
  const t = useTranslations('wizard');
  const tl = useTranslations('wizard.live');
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
        {options ? (
          <LiveScopeFields value={value} onChange={onChange} options={options} errors={errors} />
        ) : (
          <>
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
          </>
        )}
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

      {options && options.industryFields.length > 0 && (
        <fieldset className="grid gap-3.5 md:grid-cols-3" data-testid="industry-fields">
          <legend className="mb-1 text-sm font-bold">{tl('industryDetails')}</legend>
          <p className="text-xs text-stone md:col-span-3">{tl('industryHint')}</p>
          {options.industryFields.map((f) => (
            <IndustryField key={f.key} f={f} value={value.industry?.[f.key]} error={errors[`ind.${f.key}`]} onChange={(v) => {
              const next = { ...(value.industry ?? {}) };
              if (v === '' || v === undefined) delete next[f.key];
              else next[f.key] = v;
              onChange({ ...value, industry: next });
            }} />
          ))}
        </fieldset>
      )}

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

/** Brand, brand template, owner group, region and territory from the business's own records (live form). */
function LiveScopeFields({ value, onChange, options: o, errors }: { value: LocationDraft; onChange: (d: LocationDraft) => void; options: LocationFormOptions; errors: Record<string, string> }) {
  const tl = useTranslations('wizard.live');
  const templates = o.templates.filter((x) => fitsBrand(o, x.brandId, value.brandId));
  const territories = o.territories.filter((x) => fitsBrand(o, x.brandId, value.brandId));
  const onBrand = (brandId: string) => {
    const b = o.brands.find((x) => x.id === brandId);
    const next: LocationDraft = { ...value, brandId, currency: b?.defaultCurrency ?? value.currency };
    // A template or territory of another brand no longer fits.
    if (next.templateId && !o.templates.some((x) => x.id === next.templateId && fitsBrand(o, x.brandId, brandId))) next.templateId = '';
    if (next.territoryId && !o.territories.some((x) => x.id === next.territoryId && fitsBrand(o, x.brandId, brandId))) next.territoryId = '';
    onChange(next);
  };
  const sel = (key: 'templateId' | 'ownerGroupId' | 'regionId' | 'territoryId', v: string) => onChange({ ...value, [key]: v });
  return (
    <>
      {o.brandPicker && (
        <Field label={tl('brand')} hint={tl('brandHint')} error={errors.brandId}>
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} value={value.brandId ?? o.brands.find((b) => b.isDefault)?.id ?? o.brands[0]?.id ?? ''} onChange={(e) => onBrand(e.target.value)} data-testid="location-brand">
              {o.brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label={tl('template')} hint={templates.length ? tl('templateHint') : tl('noTemplates')} error={errors.templateId}>
        {(p) => (
          <Select id={p.id} aria-describedby={p.describedBy} value={value.templateId ?? ''} onChange={(e) => sel('templateId', e.target.value)} data-testid="location-template">
            <option value="">{tl('noTemplate')}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>{tl('templateOption', { name: x.name, version: x.version })}</option>
            ))}
          </Select>
        )}
      </Field>
      {(o.organizationWide || o.ownerGroups.length > 0) && (
        <Field label={tl('ownerGroup')} hint={tl('ownerGroupHint')} error={errors.ownerGroupId}>
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} value={value.ownerGroupId ?? ''} onChange={(e) => sel('ownerGroupId', e.target.value)} data-testid="location-owner-group">
              <option value="">{tl('companyOwned')}</option>
              {o.ownerGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {o.regions.length > 0 && (
        <Field label={tl('networkRegion')} error={errors.regionId}>
          {(p) => (
            <Select id={p.id} value={value.regionId ?? ''} onChange={(e) => sel('regionId', e.target.value)} data-testid="location-region">
              {o.organizationWide && <option value="">{tl('noRegion')}</option>}
              {o.regions.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {territories.length > 0 && (
        <Field label={tl('territory')} hint={tl('territoryHint')} error={errors.territoryId}>
          {(p) => (
            <Select id={p.id} aria-describedby={p.describedBy} value={value.territoryId ?? ''} onChange={(e) => sel('territoryId', e.target.value)} data-testid="location-territory">
              {(o.organizationWide || o.regions.length > 0) && <option value="">{tl('noTerritory')}</option>}
              {territories.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </>
  );
}

function IndustryField({ f, value, error, onChange }: { f: LocationIndustryField; value: string | number | boolean | undefined; error?: string; onChange: (v: string | number | boolean | undefined) => void }) {
  const tl = useTranslations('wizard.live');
  const label = tl(`industryField.${f.key}` as 'industryField.seats');
  if (f.type === 'boolean') {
    return (
      <label className="flex min-h-11 items-center gap-2 self-end text-sm font-semibold">
        <input type="checkbox" className="h-4 w-4 accent-ink" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  return (
    <Field label={label} optional error={error}>
      {(p) => f.type === 'select' ? (
        <Select id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{tl('choose')}</option>
          {f.options.map((opt) => (
            <option key={opt} value={opt}>{tl(`industryOption.${f.key}.${opt}` as 'industryOption.surface.grass')}</option>
          ))}
        </Select>
      ) : f.type === 'number' ? (
        <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} type="number" inputMode="numeric" min={f.min} max={f.max} value={typeof value === 'number' ? String(value) : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      ) : (
        <Input id={p.id} aria-describedby={p.describedBy} aria-invalid={p.invalid} maxLength={f.maxLength} placeholder={f.pattern ? '15:00' : undefined} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
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
