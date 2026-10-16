'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { COUNTRY_CURRENCY, COUNTRY_TIER, type Currency } from '@bh/shared';
import { Badge, Button, Field, Input, cx } from '@bh/ui';
import { billingApi, billingCountries, type BillingView, type ChangePreview, type Interval, type PlanKey, type SetupInfo } from '@/lib/billing';
import { moneyWithCode } from '@/lib/format';
import { useMutation } from '@/lib/useApi';
import { Banner, SectionCard } from '../../ui/States';
import { CardEntry, type CardResult } from './CardEntry';

const COUNTRY_CODES = [...new Set([...Object.keys(COUNTRY_CURRENCY), ...Object.keys(COUNTRY_TIER)])];
const amt = (amount: number, currency: Currency, locale: string) => moneyWithCode({ amount, currency }, locale);
const fmtDate = (iso: string | null | undefined, locale: string) => (iso ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)) : '');

/**
 * Settings → Billing → Change plan: pick Solo / Connector / Hosted / Network (the plans this business can have) and
 * monthly or annual, see the new price and what the switch costs for the rest of this period (prorated), then confirm.
 * During the trial nothing is charged now: the new plan starts when the trial ends.
 */
export function ChangePlanCard({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const t = useTranslations('billing.change');
  const tb = useTranslations('billing');
  const locale = useLocale();
  const [plan, setPlan] = useState<PlanKey>(b.plan);
  const [interval, setInterval] = useState<Interval>(b.interval);
  const [preview, setPreview] = useState<ChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const apply = useMutation(() => billingApi.change({ plan, interval }));
  const same = plan === b.plan && interval === b.interval;

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    if (same) return;
    billingApi.previewChange({ plan, interval }).then((r) => alive && setPreview(r), (e: Error) => alive && setPreviewError(e.message));
    return () => { alive = false; };
  }, [plan, interval, same]);

  return (
    <SectionCard title={t('title')}>
      <div className="flex flex-col gap-4" data-testid="change-plan">
        <p className="max-w-3xl text-sm text-graphite">{t('body')}</p>
        {done && <Banner tone="success" live="polite">{done}</Banner>}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-bold text-stone">{t('plan')}</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup">
            {b.plans.map((p) => (
              <label key={p} className={cx('flex cursor-pointer flex-col gap-1 rounded-lg border p-3.5', plan === p ? 'border-ink bg-lime/30' : 'border-line-soft bg-surface')} data-testid={`plan-${p}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="change-plan" className="h-4 w-4 accent-ink" checked={plan === p} onChange={() => setPlan(p)} />
                  <span className="text-sm font-bold">{tb(`plans.${p}`)}</span>
                  {p === b.plan && <Badge tone="neutral" icon={null}>{t('current')}</Badge>}
                </span>
                <span className="text-xs text-stone">{tb(`planFor.${p}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 w-full text-xs font-bold text-stone">{t('billingPeriod')}</legend>
          {(['month', 'year'] as const).map((i) => (
            <label key={i} className={cx('flex h-10 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-semibold', interval === i ? 'border-ink bg-lime/30' : 'border-line-soft')} data-testid={`interval-${i}`}>
              <input type="radio" name="change-interval" className="h-4 w-4 accent-ink" checked={interval === i} onChange={() => setInterval(i)} />
              {t(`interval.${i}`)}
            </label>
          ))}
          <span className="text-xs text-stone">{t('annualNote')}</span>
        </fieldset>
        {previewError && <Banner tone="danger" live="assertive">{previewError}</Banner>}
        {preview && (
          <div className="flex flex-col gap-2 rounded-md bg-canvas-raised p-4" data-testid="change-preview" aria-live="polite">
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs font-bold text-stone">{t('now')}</div>
                <div className="tabular font-semibold">{tb(`plans.${preview.from.plan}`)} · {amt(preview.from.hqTotal.amount, preview.from.hqTotal.currency, locale)} {tb(`per.${preview.from.interval}`)}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-stone">{t('after')}</div>
                <div className="tabular font-semibold">{tb(`plans.${preview.to.plan}`)} · {amt(preview.to.hqTotal.amount, preview.to.hqTotal.currency, locale)} {tb(`per.${preview.to.interval}`)}</div>
              </div>
              <div>
                <div className="text-xs font-bold text-stone">{preview.effective === 'trial_end' ? t('dueAtTrialEnd') : preview.proration.amount < 0 ? t('credit') : t('dueNow')}</div>
                <div className="tabular text-lg font-extrabold">{amt(Math.abs(preview.proration.amount), preview.proration.currency, locale)}</div>
              </div>
            </div>
            <p className="text-xs text-stone">
              {preview.effective === 'trial_end'
                ? t('trialNote', { date: fmtDate(preview.effectiveAt, locale) })
                : preview.proration.amount < 0 ? t('creditNote') : t('prorationNote', { date: fmtDate(preview.nextChargeAt, locale) })}
              {' '}{tb('current.taxNote')}
            </p>
          </div>
        )}
        {apply.error && <Banner tone="danger" live="assertive">{apply.error.message}</Banner>}
        <div>
          <Button disabled={same || !preview} loading={apply.pending} data-testid="change-confirm" onClick={async () => {
            const r = await apply.run();
            if (r) { setDone(t('done', { plan: tb(`plans.${r.to.plan}`) })); onChange(r.billing); }
          }}>{t('confirm')}</Button>
        </div>
      </div>
    </SectionCard>
  );
}

/** Change the card on file: a card setup with the same billing-country check as at checkout. */
export function ChangeCardButton({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const t = useTranslations('billing.cardChange');
  const tb = useTranslations('billing');
  const locale = useLocale();
  const countries = useMemo(() => billingCountries(COUNTRY_CODES, locale), [locale]);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [taxId, setTaxId] = useState('');
  const [done, setDone] = useState(false);
  const start = useMutation(() => billingApi.startCardChange());
  const confirm = useMutation((_api, r: CardResult) => billingApi.confirmCardChange({ ...r, ...(taxId.trim() ? { taxId: taxId.trim() } : {}) }));
  if (!setup) {
    return (
      <div className="flex flex-col gap-2">
        {done && <Banner tone="success" live="polite">{t('done')}</Banner>}
        {start.error && <Banner tone="danger" live="assertive">{start.error.message}</Banner>}
        <div>
          <Button variant="secondary" icon="card" loading={start.pending} data-testid="change-card" onClick={async () => { const r = await start.run(); if (r) { setDone(false); setSetup(r.setup); } }}>{t('open')}</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-4" data-testid="change-card-form">
      <p className="text-sm font-bold">{t('title')}</p>
      <p className="text-sm text-graphite">{t('body', { country: countries.find((c) => c.code === b.billingCountry)?.name ?? b.billingCountry })}</p>
      <div className="max-w-md">
        <Field label={tb('checkout.taxId')} hint={tb('checkout.taxIdHint')} optional>
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={taxId} onChange={(e) => setTaxId(e.target.value)} />}
        </Field>
      </div>
      {confirm.error && <Banner tone="danger" live="assertive">{confirm.error.message}</Banner>}
      <CardEntry setup={setup} country={b.billingCountry} countries={countries} submitLabel={t('save')} onCard={async (r) => { const out = await confirm.run(r); if (out) { setSetup(null); setDone(true); onChange(out.billing); } }} />
      <div>
        <Button variant="ghost" onClick={() => setSetup(null)}>{tb('common.cancel')}</Button>
      </div>
    </div>
  );
}
