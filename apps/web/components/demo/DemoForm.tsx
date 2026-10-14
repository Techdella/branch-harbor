'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { INDUSTRIES as INDUSTRY_LIST, apiError, demoRequestSchema, type Locale } from '@bh/shared';
import { Input, Select, Textarea } from '@bh/ui';
import { Icon, cx } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { isIndustryKey } from '@/content/industries';
import { countryOptions } from './countries';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const FIELDS = ['name', 'email', 'business', 'industry', 'locationCount', 'country', 'existingWebsite', 'primaryDifficulty', 'phone', 'existingSystems'] as const;
type FieldName = (typeof FIELDS)[number];
type Values = Record<FieldName, string> & { marketingConsent: boolean; size: 'single' | 'network' };
type Errors = Partial<Record<FieldName, string>>;
type Status = 'idle' | 'sending' | 'success' | 'network' | 'server';

const fieldId = (f: FieldName) => `demo-${f}`;

/** Accept "yourbusiness.com" by assuming https://. Empty stays empty. */
function normalizeUrl(v: string): string {
  const s = v.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

function FormField({ name, label, hint, error, optional, optionalLabel, children }: { name: FieldName; label: string; hint?: string; error?: string; optional?: boolean; optionalLabel: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId(name)} className="text-[13px] font-bold text-ink">
        {label} {optional && <span className="font-medium text-stone">({optionalLabel})</span>}
      </label>
      {children}
      {hint && (
        <p id={`${fieldId(name)}-hint`} className="text-xs text-stone">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${fieldId(name)}-error`} className="flex items-center gap-1 text-xs font-bold text-danger">
          <Icon name="alert" size={13} stroke={2.2} />
          {error}
        </p>
      )}
    </div>
  );
}

export function DemoForm() {
  const t = useTranslations('demo');
  const tm = useTranslations('industryMeta');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const search = useSearchParams();
  const countries = useMemo(() => countryOptions(locale), [locale]);

  const [v, setV] = useState<Values>({
    name: '',
    email: '',
    business: '',
    industry: '',
    locationCount: '',
    country: '',
    existingWebsite: '',
    primaryDifficulty: '',
    phone: '',
    existingSystems: '',
    marketingConsent: false,
    size: 'network',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const summaryRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  // Prefill from links such as /demo?industry=foods or /demo?plan=network.
  useEffect(() => {
    const ind = search.get('industry');
    const plan = search.get('plan');
    setV((s) => ({
      ...s,
      industry: ind && (isIndustryKey(ind) || ind === 'realty') ? ind : s.industry,
      size: plan === 'network' ? 'network' : s.size,
    }));
  }, [search]);

  const validate = (vals: Values): { errors: Errors; data?: ReturnType<typeof demoRequestSchema.parse> } => {
    const payload = {
      name: vals.name.trim(),
      email: vals.email.trim(),
      business: vals.business.trim(),
      industry: vals.industry || undefined,
      locationCount: vals.locationCount.trim() === '' ? Number.NaN : Number(vals.locationCount),
      country: vals.country || undefined,
      existingWebsite: normalizeUrl(vals.existingWebsite),
      primaryDifficulty: vals.primaryDifficulty.trim(),
      phone: vals.phone.trim() || undefined,
      existingSystems: vals.existingSystems.trim() || undefined,
      locale,
      marketingConsent: vals.marketingConsent,
    };
    const errs: Errors = {};
    const parsed = demoRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const f = issue.path[0];
        if (typeof f === 'string' && (FIELDS as readonly string[]).includes(f) && !errs[f as FieldName]) {
          errs[f as FieldName] = t(`errors.${f}` as 'errors.name');
        }
      }
    }
    // The spec asks for the primary difficulty on every enquiry.
    if (!payload.primaryDifficulty) errs.primaryDifficulty = t('errors.primaryDifficulty');
    return { errors: errs, data: parsed.success && !Object.keys(errs).length ? parsed.data : undefined };
  };

  const set = <K extends keyof Values>(k: K, val: Values[K]) => {
    const next = { ...v, [k]: val };
    setV(next);
    if (attempted) setErrors(validate(next).errors);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (status === 'sending') return;
    setAttempted(true);
    const { errors: errs, data } = validate(v);
    setErrors(errs);
    if (!data) {
      setStatus('idle');
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(`${API_URL}/v1/public/demo-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        setStatus('success');
        requestAnimationFrame(() => {
          successRef.current?.focus();
          successRef.current?.scrollIntoView({ block: 'center' });
        });
        return;
      }
      if (res.status === 400 || res.status === 422) {
        const body = apiError.safeParse(await res.json().catch(() => null));
        const fields = body.success ? body.data.error.fields : undefined;
        if (fields && Object.keys(fields).length) {
          const mapped: Errors = {};
          for (const f of Object.keys(fields)) {
            if ((FIELDS as readonly string[]).includes(f)) mapped[f as FieldName] = t(`errors.${f}` as 'errors.name');
          }
          if (Object.keys(mapped).length) {
            setErrors(mapped);
            setStatus('idle');
            requestAnimationFrame(() => summaryRef.current?.focus());
            return;
          }
        }
      }
      setStatus('server');
    } catch {
      setStatus('network');
    }
    requestAnimationFrame(() => failureRef.current?.focus());
  };

  if (status === 'success') {
    const ind = v.industry && isIndustryKey(v.industry) ? v.industry : null;
    return (
      <div className="flex flex-col items-start gap-5 py-6" role="status">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-lime">
          <Icon name="check" size={28} stroke={2.4} />
        </span>
        <h2 ref={successRef} tabIndex={-1} className="text-[32px] leading-tight font-extrabold tracking-[-0.035em] outline-none">
          {t('success.title', { name: v.name.trim().split(/\s+/)[0] ?? '' })}
        </h2>
        <p className="max-w-xl text-base leading-relaxed text-graphite">{t('success.body', { business: v.business.trim(), email: v.email.trim() })}</p>
        <p className="max-w-xl text-base leading-relaxed text-stone">{t('success.next')}</p>
        <div className="flex flex-wrap gap-2.5">
          {ind && (
            <Link href={`/industries/${ind}`} className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white">
              {t('success.explore', { industry: tm(`${ind}.name`) })}
              <Icon name="arrow-right" size={16} className="rtl:-scale-x-100" />
            </Link>
          )}
          <Link href="/" className="inline-flex h-11 items-center rounded-full border-[1.5px] border-ink px-5 text-sm font-bold">
            {t('success.home')}
          </Link>
        </div>
      </div>
    );
  }

  const errorList = FIELDS.filter((f) => errors[f]);
  const describedBy = (f: FieldName, hint?: boolean) => [hint ? `${fieldId(f)}-hint` : null, errors[f] ? `${fieldId(f)}-error` : null].filter(Boolean).join(' ') || undefined;
  const common = (f: FieldName, hint = false) => ({
    id: fieldId(f),
    name: f,
    'aria-invalid': errors[f] ? true : undefined,
    'aria-describedby': describedBy(f, hint),
  });
  const optional = tc('optional');

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6" aria-labelledby="demo-form-title">
      <h2 id="demo-form-title" className="text-[26px] font-extrabold tracking-[-0.03em]">
        {t('form.title')}
      </h2>

      {errorList.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} role="alert" aria-labelledby="demo-error-summary" className="rounded-[20px] border-[1.5px] border-danger bg-danger-bg p-5 outline-none">
          <h3 id="demo-error-summary" className="flex items-center gap-2 text-[15px] font-extrabold text-danger">
            <Icon name="alert" size={18} stroke={2.2} />
            {t('errors.summaryTitle', { count: errorList.length })}
          </h3>
          <ul className="mt-2 flex list-disc flex-col gap-1 ps-9 text-sm">
            {errorList.map((f) => (
              <li key={f}>
                <a href={`#${fieldId(f)}`} className="font-bold text-danger underline underline-offset-2">
                  {errors[f]}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(status === 'network' || status === 'server') && (
        <div ref={failureRef} tabIndex={-1} role="alert" className="flex flex-col items-start gap-3 rounded-[20px] bg-warning-bg p-5 text-warning outline-none sm:flex-row sm:items-center">
          <Icon name="wifi-off" size={20} className="shrink-0" />
          <p className="flex-1 text-sm font-bold">{status === 'network' ? t('errors.network') : t('errors.server')}</p>
          <button type="submit" className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-bold text-white">
            <Icon name="refresh" size={15} />
            {t('errors.retry')}
          </button>
        </div>
      )}

      <fieldset>
        <legend className="mb-2 text-[13px] font-bold">{t('form.sizeLegend')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['single', 'network'] as const).map((s) => (
            <label key={s} className={cx('flex cursor-pointer items-center gap-3 rounded-[18px] border-[1.5px] p-4 transition has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-focus', v.size === s ? 'border-ink bg-canvas' : 'border-line bg-surface')}>
              <input
                type="radio"
                name="size"
                value={s}
                checked={v.size === s}
                onChange={() => {
                  setV((x) => ({ ...x, size: s, locationCount: s === 'single' ? '1' : x.locationCount === '1' ? '' : x.locationCount }));
                }}
                className="sr-only"
              />
              <Icon name={s === 'single' ? 'store' : 'building'} size={20} />
              <span className="flex flex-col">
                <span className="text-sm font-bold">{t(`form.${s}`)}</span>
                <span className="text-xs text-stone">{t(`form.${s}Desc`)}</span>
              </span>
              {v.size === s && <Icon name="check-circle" size={18} className="ms-auto" />}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField name="name" label={t('form.name')} error={errors.name} optionalLabel={optional}>
          <Input {...common('name')} autoComplete="name" value={v.name} onChange={(e) => set('name', e.target.value)} required />
        </FormField>
        <FormField name="email" label={t('form.email')} hint={t('form.emailHint')} error={errors.email} optionalLabel={optional}>
          <Input {...common('email', true)} type="email" autoComplete="email" value={v.email} onChange={(e) => set('email', e.target.value)} required />
        </FormField>
        <FormField name="business" label={t('form.business')} error={errors.business} optionalLabel={optional}>
          <Input {...common('business')} autoComplete="organization" value={v.business} onChange={(e) => set('business', e.target.value)} required />
        </FormField>
        <FormField name="industry" label={t('form.industry')} error={errors.industry} optionalLabel={optional}>
          <Select {...common('industry')} value={v.industry} onChange={(e) => set('industry', e.target.value)} required>
            <option value="">{t('form.industryPlaceholder')}</option>
            {INDUSTRY_LIST.map((k) => (
              <option key={k} value={k}>
                {k === 'realty' ? t('form.realtyOption') : tm(`${k}.name`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField name="locationCount" label={t('form.locationCount')} error={errors.locationCount} optionalLabel={optional}>
          <Input {...common('locationCount')} type="number" inputMode="numeric" min={1} max={10000} value={v.locationCount} onChange={(e) => set('locationCount', e.target.value)} required />
        </FormField>
        <FormField name="country" label={t('form.country')} error={errors.country} optionalLabel={optional}>
          <Select {...common('country')} autoComplete="country" value={v.country} onChange={(e) => set('country', e.target.value)} required>
            <option value="">{t('form.countryPlaceholder')}</option>
            <optgroup label={t('form.countryGroupLaunch')}>
              {countries.launch.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('form.countryGroupOther')}>
              {countries.other.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </FormField>
      </div>

      <FormField name="existingWebsite" label={t('form.website')} hint={t('form.websiteHint')} error={errors.existingWebsite} optional optionalLabel={optional}>
        <Input {...common('existingWebsite', true)} type="url" inputMode="url" autoComplete="url" placeholder="https://" value={v.existingWebsite} onChange={(e) => set('existingWebsite', e.target.value)} />
      </FormField>

      <FormField name="primaryDifficulty" label={t('form.difficulty')} hint={t('form.difficultyHint')} error={errors.primaryDifficulty} optionalLabel={optional}>
        <Textarea {...common('primaryDifficulty', true)} value={v.primaryDifficulty} maxLength={2000} onChange={(e) => set('primaryDifficulty', e.target.value)} required />
      </FormField>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField name="phone" label={t('form.phone')} error={errors.phone} optional optionalLabel={optional}>
          <Input {...common('phone')} type="tel" autoComplete="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} />
        </FormField>
        <FormField name="existingSystems" label={t('form.systems')} hint={t('form.systemsHint')} error={errors.existingSystems} optional optionalLabel={optional}>
          <Input {...common('existingSystems', true)} value={v.existingSystems} onChange={(e) => set('existingSystems', e.target.value)} />
        </FormField>
      </div>

      <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
        <input type="checkbox" name="marketingConsent" checked={v.marketingConsent} onChange={(e) => set('marketingConsent', e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-ink" />
        {t('form.consent')}
      </label>

      <div className="flex flex-col gap-3 border-t border-line-soft pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-xs leading-relaxed text-stone">
          {t('privacyNote')}{' '}
          <Link href="/privacy" className="font-bold underline">
            {tc('learnMore')}
          </Link>
        </p>
        <button type="submit" disabled={status === 'sending'} aria-busy={status === 'sending' || undefined} className="inline-flex h-[54px] items-center justify-center gap-2.5 rounded-full bg-ink ps-6 pe-1.5 text-[15px] font-bold text-white disabled:opacity-60">
          {status === 'sending' ? t('form.sending') : t('form.submit')}
          <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-lime text-ink">
            <Icon name={status === 'sending' ? 'clock' : 'arrow-up-right'} size={18} />
          </span>
        </button>
      </div>
    </form>
  );
}
