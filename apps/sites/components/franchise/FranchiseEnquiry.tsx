'use client';

import { useEffect, useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { Checkbox, EMAIL_RE, ErrorSummary, Field } from '@/components/forms';

type Territory = { id: string; name: string; country: string; region: string | null };

/**
 * "Own a franchise" enquiry module for a franchisor's brand site. Posts to the franchisor's pipeline (same-origin
 * proxy → /v1/public/franchise/{brand}/enquiries) with the campaign attribution from the landing URL.
 */
export function FranchiseEnquiry({ brandSlug, brandName, currency, countries, territories }: { brandSlug: string; brandName: string; currency: string; countries: string[]; territories: Territory[] }) {
  const t = useTranslations('franchiseSite');
  const locale = useLocale();
  const ids = { country: useId(), territory: useId(), message: useId() };
  const [v, setV] = useState({ name: '', email: '', phone: '', country: countries[0] ?? '', region: '', city: '', territoryId: '', desiredTerritory: '', liquid: '', netWorth: '', message: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [utm, setUtm] = useState<Record<string, string>>({});
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const u: Record<string, string> = {};
    for (const k of ['source', 'medium', 'campaign']) { const x = sp.get(`utm_${k}`); if (x) u[k] = x.slice(0, 100); }
    setUtm(u);
  }, []);
  const countryName = (c: string) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c; } catch { return c; } };
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const inCountry = territories.filter((x) => !v.country || x.country === v.country);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (v.name.trim().length < 2) errs.name = t('errName');
    if (!EMAIL_RE.test(v.email)) errs.email = t('errEmail');
    if (!/^[A-Z]{2}$/.test(v.country)) errs.country = t('errCountry');
    if (!consent) errs.consent = t('errConsent');
    setErrors(errs);
    if (Object.keys(errs).length) { setSummary(t('errSummary')); return; }
    setSummary(null);
    setState('sending');
    const num = (s: string) => (s.trim() ? Math.max(0, Math.round(Number(s.replace(/[^\d.]/g, '')))) : undefined);
    const territory = territories.find((x) => x.id === v.territoryId);
    const r = await call('POST', `/public/franchise/${encodeURIComponent(brandSlug)}/enquiries`, {
      name: v.name.trim(), email: v.email.trim(), phone: v.phone.trim() || undefined, country: v.country, region: (v.region.trim() || territory?.region) ?? undefined, city: v.city.trim() || undefined,
      territoryId: v.territoryId || undefined, desiredTerritory: v.desiredTerritory.trim() || territory?.name || undefined,
      liquidCapital: num(v.liquid), netWorth: num(v.netWorth), currency, message: v.message.trim() || undefined,
      utm: Object.keys(utm).length ? utm : undefined, consent: true, marketingConsent: marketing, locale, website: v.website || undefined,
    });
    if (r.ok) { setState('done'); return; }
    setState('idle');
    setErrors(r.error.fields ?? {});
    setSummary(r.error.message);
  };

  if (state === 'done') {
    return (
      <div role="status" className="card flex flex-col items-start gap-2 p-6">
        <span className="grid size-11 place-items-center rounded-full bg-success-bg text-success"><Icon name="check" /></span>
        <h3 className="text-xl font-bold">{t('thanksTitle')}</h3>
        <p className="text-graphite">{t('thanksBody', { brand: brandName })}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-4 p-5 sm:p-6" aria-labelledby="franchise-h">
      <ErrorSummary message={summary} fields={errors} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('name')} autoComplete="name" value={v.name} onChange={set('name')} error={errors.name} required />
        <Field label={t('email')} type="email" autoComplete="email" value={v.email} onChange={set('email')} error={errors.email} required />
        <Field label={t('phone')} type="tel" autoComplete="tel" value={v.phone} onChange={set('phone')} optional />
        <div>
          <label htmlFor={ids.country} className="mb-1 block text-sm font-semibold">{t('country')}</label>
          <select id={ids.country} className="field" value={v.country} onChange={(e) => setV((x) => ({ ...x, country: e.target.value, territoryId: '' }))} aria-invalid={errors.country ? true : undefined}>
            {countries.map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
          </select>
          {errors.country && <p className="mt-1 text-sm font-semibold text-danger">{errors.country}</p>}
        </div>
        <Field label={t('region')} hint={t('regionHint')} value={v.region} onChange={(e) => setV((x) => ({ ...x, region: e.target.value.toUpperCase().slice(0, 6) }))} optional />
        <Field label={t('city')} autoComplete="address-level2" value={v.city} onChange={set('city')} optional />
      </div>
      {inCountry.length > 0 && (
        <div>
          <label htmlFor={ids.territory} className="mb-1 block text-sm font-semibold">{t('territory')}</label>
          <select id={ids.territory} className="field" value={v.territoryId} onChange={set('territoryId')}>
            <option value="">{t('territoryOther')}</option>
            {inCountry.map((x) => <option key={x.id} value={x.id}>{x.name}{x.region ? ` (${x.region})` : ''}</option>)}
          </select>
        </div>
      )}
      {!v.territoryId && <Field label={t('desiredTerritory')} value={v.desiredTerritory} onChange={set('desiredTerritory')} optional />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('liquidCapital', { currency })} inputMode="numeric" value={v.liquid} onChange={set('liquid')} optional />
        <Field label={t('netWorth', { currency })} inputMode="numeric" value={v.netWorth} onChange={set('netWorth')} optional />
      </div>
      <p className="-mt-2 text-xs text-graphite">{t('financialNote')}</p>
      <div>
        <label htmlFor={ids.message} className="mb-1 block text-sm font-semibold">{t('message')}</label>
        <textarea id={ids.message} className="field min-h-24 py-2" value={v.message} onChange={set('message')} maxLength={2000} />
      </div>
      {/* Honeypot: hidden from people and assistive technology. */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" value={v.website} onChange={set('website')} />
      <Checkbox label={t('consent', { brand: brandName })} checked={consent} onChange={setConsent} error={errors.consent} />
      <Checkbox label={t('marketing', { brand: brandName })} checked={marketing} onChange={setMarketing} />
      <button type="submit" className="btn btn-primary self-start" disabled={state === 'sending'}>
        {state === 'sending' ? t('sending') : t('submit')}<Icon name="arrow-right" size={16} />
      </button>
    </form>
  );
}
