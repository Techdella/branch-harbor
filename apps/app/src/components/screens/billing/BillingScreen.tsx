'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { COUNTRY_CURRENCY, COUNTRY_TIER, NETWORK_INCLUDED_LOCATIONS, type Currency } from '@bh/shared';
import { Badge, Button, Field, Input, Select, type Tone } from '@bh/ui';
import { billingApi, billingCountries, type BillingView, type Interval, type Payer, type PlanKey, type Quote, type SetupInfo } from '@/lib/billing';
import { moneyWithCode } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../../ui/States';
import { CardEntry, type CardResult } from './CardEntry';

const COUNTRY_CODES = [...new Set([...Object.keys(COUNTRY_CURRENCY), ...Object.keys(COUNTRY_TIER)])];

export function fmtDate(iso: string | null | undefined, locale: string) {
  return iso ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)) : '';
}
const amt = (amount: number, currency: Currency, locale: string) => moneyWithCode({ amount, currency }, locale);
const countryName = (code: string, locale: string) => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const STATUS_TONE: Record<string, Tone> = { trialing: 'info', active: 'success', past_due: 'warning', canceled: 'neutral', checkout_required: 'warning' };

/** Settings → Billing: plan, paid trial, cancel before renewal, billing country, who pays each location, invoices. */
export function BillingScreen() {
  const t = useTranslations('billing');
  const app = useApp();
  const allowed = app.hasModule('settings.billing');
  const res = useApi(() => billingApi.view(), [app.org.id], allowed);
  return (
    <>
      <PageHeader icon="card" title={t('title')} description={t('description')} scope={false} />
      {!allowed ? (
        <DeniedState permission="billing.manage" />
      ) : (
        <Async res={res} loading={<LoadingBlock variant="detail" />}>
          {(b) => <BillingBody b={b} onChange={(v) => (v ? res.setData(v) : res.reload())} />}
        </Async>
      )}
    </>
  );
}

function BillingBody({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const needsCheckout = b.status === 'checkout_required' || b.status === 'canceled';
  return (
    <>
      {needsCheckout ? <CheckoutCard b={b} onDone={onChange} /> : <CurrentPlanCard b={b} onChange={onChange} />}
      {b.businessModel === 'network' && b.plan === 'network' && b.status !== 'checkout_required' && <PayersCard b={b} onChange={onChange} />}
      {!needsCheckout && <CountryCard b={b} onChange={onChange} />}
      <InvoicesCard b={b} />
      <FeesCard b={b} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Checkout: paid 14-day trial                                         */
/* ------------------------------------------------------------------ */

function QuoteLines({ q }: { q: Quote }) {
  const t = useTranslations('billing.checkout');
  const locale = useLocale();
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {q.lines.map((l) => (
        <li key={l.kind} className="flex justify-between gap-3">
          <span className="text-graphite">
            {l.kind === 'platform' ? t('linePlatform', { count: q.includedLocations }) : l.kind === 'plan' ? t('linePlan') : t('lineLocations', { count: l.quantity, price: amt(l.unitMinor, q.currency, locale) })}
          </span>
          <span className="tabular font-semibold">{amt(l.amountMinor, q.currency, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

function CheckoutCard({ b, onDone }: { b: BillingView; onDone: (v?: BillingView) => void }) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const countries = useMemo(() => billingCountries(COUNTRY_CODES, locale), [locale]);
  const [plan, setPlan] = useState<PlanKey>(b.plans.includes(b.plan) ? b.plan : b.plans[0]!);
  const [interval, setInterval] = useState<Interval>(b.interval);
  const [country, setCountry] = useState(b.billingCountry);
  const [locations, setLocations] = useState(Math.max(1, b.locations.length));
  const [taxId, setTaxId] = useState('');
  const [agree, setAgree] = useState(false);
  const [agreeError, setAgreeError] = useState(false);
  const [quote, setQuote] = useState<Quote>(b.quote);
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [trialEligible, setTrialEligible] = useState(b.trialEligibility?.eligible ?? true);
  const start = useMutation(() => billingApi.start({ plan, interval, billingCountry: country, locations }));
  const confirm = useMutation((_api, r: CardResult) => billingApi.confirm({ ...r, ...(taxId.trim() ? { taxId: taxId.trim() } : {}) }));

  // The price is recomputed from the billing country (and plan, interval, locations) as the customer types.
  useEffect(() => {
    let alive = true;
    setSetup(null);
    void billingApi.quote({ plan, interval, billingCountry: country, locations }).then((r) => alive && setQuote(r.quote)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [plan, interval, country, locations]);

  const fee = amt(quote.trialFeeMinor, quote.currency, locale);
  const total = amt(quote.totalMinor, quote.currency, locale);
  const startDate = fmtDate(new Date(Date.now() + quote.trialDays * 86_400_000).toISOString(), locale);
  const per = t(`per.${interval}`);
  return (
    <SectionCard title={b.status === 'canceled' ? t('checkout.restartTitle') : t('checkout.title', { days: quote.trialDays })} aside={<Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{t(`status.${b.status}`)}</Badge>}>
      <div data-testid="checkout" className="flex flex-col gap-5">
        <p className="max-w-3xl text-sm text-graphite">{t('checkout.intro', { fee, days: quote.trialDays })}</p>
        <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-4">
          <Field label={t('checkout.plan')}>
            {(p) => (
              <Select id={p.id} value={plan} onChange={(e) => setPlan(e.target.value as PlanKey)}>
                {b.plans.map((k) => (
                  <option key={k} value={k}>
                    {t(`plans.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('checkout.interval')}>
            {(p) => (
              <Select id={p.id} value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>
                {(['month', 'year'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`interval.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('checkout.country')} hint={t('checkout.countryHint')}>
            {(p) => (
              <Select id={p.id} aria-describedby={p.describedBy} value={country} onChange={(e) => setCountry(e.target.value)} data-testid="billing-country">
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {plan !== 'solo' && (
            <Field label={t('checkout.locations')}>
              {(p) => <Input id={p.id} type="number" min={1} max={5000} value={locations} onChange={(e) => setLocations(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))} />}
            </Field>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-md bg-canvas-raised p-4" data-testid="checkout-quote">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-bold">{t('checkout.today')}</span>
              <span className="tabular text-xl font-extrabold">{trialEligible ? fee : total}</span>
            </div>
            <p className="text-xs text-stone">{trialEligible ? t('checkout.todayTrial', { days: quote.trialDays }) : t('checkout.noTrial')}</p>
            <div className="border-t border-line-soft pt-3">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <span className="text-sm font-bold">{trialEligible ? t('checkout.from', { date: startDate }) : t('checkout.then')}</span>
                <span className="tabular text-base font-extrabold">
                  {total} {per}
                </span>
              </div>
              <QuoteLines q={quote} />
            </div>
            <p className="text-xs text-stone">{b.terms.taxExclusive || country !== 'US' ? t('checkout.taxExclusive') : t('checkout.taxUs')}</p>
          </div>
          <ul className="flex flex-col gap-2 text-sm" data-testid="trial-terms">
            {(['autoStart', 'reminders', 'cancel', 'export', 'lock'] as const).map((k) => (
              <li key={k} className="flex items-start gap-2">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink" />
                {t(`checkout.terms.${k}`, { days: quote.trialDays, date: startDate, plan: t(`plans.${plan}`) })}
              </li>
            ))}
          </ul>
        </div>

        <Field label={t('checkout.taxId')} hint={t('checkout.taxIdHint')} optional>
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={taxId} onChange={(e) => setTaxId(e.target.value)} className="max-w-sm" />}
        </Field>

        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--color-ink)]" checked={agree} onChange={(e) => { setAgree(e.target.checked); setAgreeError(false); }} aria-invalid={agreeError || undefined} data-testid="agree" />
          <span>{trialEligible ? t('checkout.agree', { fee, days: quote.trialDays, date: startDate, plan: t(`plans.${plan}`), amount: `${total} ${per}` }) : t('checkout.agreeNoTrial', { amount: `${total} ${per}` })}</span>
        </label>
        {agreeError && <Banner tone="danger" live="assertive">{t('checkout.agreeRequired')}</Banner>}
        {(start.error || confirm.error) && <Banner tone="danger" live="assertive">{(confirm.error ?? start.error)!.message}</Banner>}

        {!setup ? (
          <div>
            <Button
              loading={start.pending}
              iconRight="arrow-right"
              onClick={async () => {
                if (!agree) return setAgreeError(true);
                const r = await start.run();
                if (r) {
                  setQuote(r.quote);
                  setTrialEligible(r.trial.eligible);
                  setSetup(r.setup);
                }
              }}
              data-testid="continue-to-card"
            >
              {t('checkout.continue')}
            </Button>
          </div>
        ) : (
          <CardEntry
            setup={setup}
            country={country}
            countries={countries}
            submitLabel={trialEligible ? t('checkout.payTrial', { fee }) : t('checkout.payPlan', { amount: total })}
            onCard={async (r) => {
              const out = await confirm.run(r);
              if (out) onDone(out.billing);
            }}
          />
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Current plan, cancel before renewal                                 */
/* ------------------------------------------------------------------ */

function CurrentPlanCard({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation(() => billingApi.cancel());
  const resume = useMutation(() => billingApi.resume());
  const trial = b.status === 'trialing';
  const total = amt(b.hqTotal.amount, b.hqTotal.currency, locale);
  const per = t(`per.${b.interval}`);
  const endDate = fmtDate(trial ? b.trial.endsAt : b.currentPeriodEnd, locale);
  return (
    <SectionCard title={t('current.title')} aside={<Badge tone={b.cancelAtPeriodEnd ? 'warning' : STATUS_TONE[b.status] ?? 'neutral'}>{b.cancelAtPeriodEnd ? t('current.canceling') : t(`status.${b.status}`)}</Badge>}>
      <div className="flex flex-col gap-4" data-testid="current-plan">
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-md bg-canvas-raised px-4 py-4">
          <div className="flex flex-col gap-1">
            <div className="text-xl font-extrabold">{t(`plans.${b.plan}`)}</div>
            <div className="text-sm text-stone">{t(`planFor.${b.plan}`)}</div>
            {b.platformFee && <div className="text-sm">{t('current.platformFee', { amount: amt(b.platformFee.amount, b.platformFee.currency, locale), count: b.platformFee.includedLocations })}</div>}
          </div>
          <div className="text-right">
            <div className="tabular text-2xl font-extrabold">
              {total} <span className="text-sm font-semibold text-stone">{per}</span>
            </div>
            <div className="text-xs text-stone">{t('current.taxNote')}</div>
          </div>
        </div>
        {trial && b.trial.endsAt && (
          <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="trial-status">
            <Badge tone="info" icon="clock">{t('current.daysLeft', { count: b.trial.daysLeft ?? 0 })}</Badge>
            <span>{b.cancelAtPeriodEnd ? t('current.trialCanceled', { date: endDate }) : t('current.startsOn', { plan: t(`plans.${b.plan}`), date: endDate, amount: `${total} ${per}` })}</span>
          </div>
        )}
        {!trial && b.status === 'active' && b.currentPeriodEnd && (
          <p className="text-sm">{b.cancelAtPeriodEnd ? t('current.endsOn', { date: endDate }) : t('current.nextCharge', { date: endDate, amount: `${total} ${per}` })}</p>
        )}
        {b.status === 'past_due' && <Banner tone="warning">{t('current.pastDue')}</Banner>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold text-stone">{t('current.country')}</dt>
            <dd>
              {countryName(b.billingCountry, locale)} · {b.currency}{' '}
              {b.countryEvidence && b.countryEvidence !== 'none' && <span className="text-stone">({t(`current.evidence.${b.countryEvidence}`)})</span>}
            </dd>
          </div>
          {b.card && (
            <div>
              <dt className="text-xs font-bold text-stone">{t('current.card')}</dt>
              <dd>{t('current.cardValue', { brand: (b.card.brand ?? '').toUpperCase(), last4: b.card.last4 ?? '••••', country: b.card.country ? countryName(b.card.country, locale) : '—' })}</dd>
            </div>
          )}
        </dl>
        {(cancel.error || resume.error) && <Banner tone="danger" live="assertive">{(cancel.error ?? resume.error)!.message}</Banner>}
        {b.cancelAtPeriodEnd ? (
          <div>
            <Button variant="secondary" loading={resume.pending} onClick={async () => (await resume.run()) && onChange()}>
              {t('current.resume')}
            </Button>
          </div>
        ) : confirming ? (
          <div className="flex flex-col gap-3 rounded-md border border-line p-4" role="group" aria-label={t('current.cancelTitle')}>
            <p className="text-sm font-bold">{t('current.cancelTitle')}</p>
            <p className="text-sm">{trial ? t('current.cancelTrialBody', { date: endDate }) : t('current.cancelPlanBody', { date: endDate })}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={cancel.pending} onClick={async () => { if (await cancel.run()) { setConfirming(false); onChange(); } }} data-testid="confirm-cancel">
                {t('current.confirmCancel')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('current.keep')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="secondary" icon="x" onClick={() => setConfirming(true)} data-testid="cancel-plan">
              {trial ? t('current.cancelTrial') : t('current.cancelPlan')}
            </Button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Billing country change (next cycle)                                 */
/* ------------------------------------------------------------------ */

function CountryCard({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const t = useTranslations('billing.country');
  const tb = useTranslations('billing');
  const locale = useLocale();
  const countries = useMemo(() => billingCountries(COUNTRY_CODES, locale), [locale]);
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState(b.billingCountry === 'GB' ? 'IE' : 'GB');
  const [taxId, setTaxId] = useState('');
  const [pending, setPending] = useState<{ quote: Quote; setup: SetupInfo } | null>(null);
  const start = useMutation(() => billingApi.startCountry(next));
  const confirm = useMutation((_api, r: CardResult) => billingApi.confirmCountry({ ...r, ...(taxId.trim() ? { taxId: taxId.trim() } : {}) }));
  const cancelPending = useMutation(() => billingApi.cancelCountry());
  const scheduled = b.pendingChange?.status === 'scheduled' ? b.pendingChange : null;
  return (
    <SectionCard title={t('title')}>
      <div className="flex flex-col gap-3">
        <p className="max-w-3xl text-sm text-graphite">{t('body')}</p>
        {scheduled ? (
          <Banner tone="info" action={<Button size="sm" variant="secondary" loading={cancelPending.pending} onClick={async () => { await cancelPending.run(); onChange(); }}>{t('keepCurrent')}</Button>}>
            {t('pending', { country: countryName(scheduled.billingCountry, locale), currency: scheduled.currency, date: fmtDate(scheduled.effectiveAt, locale) })}
          </Banner>
        ) : !open ? (
          <div>
            <Button variant="secondary" icon="globe" onClick={() => setOpen(true)}>
              {t('change')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('newCountry')}>
                {(p) => (
                  <Select id={p.id} value={next} onChange={(e) => { setNext(e.target.value); setPending(null); }}>
                    {countries.filter((c) => c.code !== b.billingCountry).map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={tb('checkout.taxId')} hint={tb('checkout.taxIdHint')} optional>
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={taxId} onChange={(e) => setTaxId(e.target.value)} />}
              </Field>
            </div>
            {(start.error || confirm.error) && <Banner tone="danger" live="assertive">{(confirm.error ?? start.error)!.message}</Banner>}
            {!pending ? (
              <div className="flex gap-2">
                <Button loading={start.pending} onClick={async () => { const r = await start.run(); if (r) setPending(r); }}>
                  {t('continue')}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {tb('common.cancel')}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm font-semibold">{t('newPrice', { amount: `${amt(pending.quote.totalMinor, pending.quote.currency, locale)} ${tb(`per.${pending.quote.interval}`)}` })}</p>
                <CardEntry setup={pending.setup} country={next} countries={countries} submitLabel={t('confirm')} onCard={async (r) => { if (await confirm.run(r)) { setOpen(false); setPending(null); onChange(); } }} />
              </>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Who pays each location (network)                                    */
/* ------------------------------------------------------------------ */

function PayerControl({ value, pct, onSave, label }: { value: Payer | 'inherit'; pct: number; onSave: (payer: Payer | 'inherit', pct: number) => Promise<void>; label: string }) {
  const t = useTranslations('billing.payers');
  const [payer, setPayer] = useState(value);
  const [share, setShare] = useState(pct || 50);
  const [busy, setBusy] = useState(false);
  const dirty = payer !== value || (payer === 'split' && share !== pct);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label={label} value={payer} onChange={(e) => setPayer(e.target.value as Payer | 'inherit')} className="h-9 w-auto min-w-36">
        <option value="inherit">{t('inherit')}</option>
        <option value="hq">{t('hq')}</option>
        <option value="franchisee">{t('franchisee')}</option>
        <option value="split">{t('split')}</option>
      </Select>
      {payer === 'split' && (
        <Input aria-label={t('share')} type="number" min={1} max={99} value={share} onChange={(e) => setShare(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} className="h-9 w-20" />
      )}
      {dirty && (
        <Button size="sm" loading={busy} onClick={async () => { setBusy(true); try { await onSave(payer, share); } finally { setBusy(false); } }}>
          {t('save')}
        </Button>
      )}
    </div>
  );
}

function PayersCard({ b, onChange }: { b: BillingView; onChange: (v?: BillingView) => void }) {
  const t = useTranslations('billing.payers');
  const tb = useTranslations('billing');
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const per = b.quote.lines.find((l) => l.kind === 'location')?.unitMinor;
  const save = async (scopeKind: 'location' | 'owner_group', scopeId: string, payer: Payer | 'inherit', pct: number) => {
    setError(null);
    try {
      const existing = b.payers.find((p) => p.scopeKind === scopeKind && p.scopeId === scopeId);
      if (payer === 'inherit') {
        if (existing) await billingApi.removePayer(existing.id);
      } else await billingApi.setPayer({ scopeKind, scopeId, payer, ...(payer === 'split' ? { franchiseePercent: pct } : {}) });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const franchiseeTotal = b.locations.reduce((s, l) => s + l.franchiseeMinor, 0);
  return (
    <SectionCard title={t('title')}>
      <div className="flex flex-col gap-4" data-testid="payers">
        <p className="max-w-3xl text-sm text-graphite">
          {t('intro', { count: NETWORK_INCLUDED_LOCATIONS, price: per != null ? amt(per, b.currency, locale) : amt(0, b.currency, locale) })}
        </p>
        {error && <Banner tone="danger" live="assertive">{error}</Banner>}
        <ul className="flex flex-col gap-1.5">
          {b.locations.map((l) => {
            const own = b.payers.find((p) => p.scopeKind === 'location' && p.scopeId === l.id);
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="font-semibold">{l.name}</div>
                  <div className="text-xs text-stone">
                    {l.included
                      ? t('included')
                      : [
                          l.hqMinor > 0 ? t('hqPays', { amount: amt(l.hqMinor, b.currency, locale) }) : null,
                          l.franchiseeMinor > 0 ? t('franchiseePays', { amount: amt(l.franchiseeMinor, b.currency, locale), pct: l.franchiseePercent }) : null,
                        ].filter(Boolean).join(' · ')}
                    {!l.included && l.source === 'owner_group' && ` · ${t('fromGroup')}`}
                  </div>
                </div>
                {!l.included && <PayerControl label={t('payerFor', { name: l.name })} value={own ? own.payer : 'inherit'} pct={own?.franchiseePercent ?? 50} onSave={(p, pct) => save('location', l.id, p, pct)} />}
              </li>
            );
          })}
        </ul>
        {b.ownerGroups.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">{t('ownerGroups')}</h3>
            <p className="text-xs text-stone">{t('ownerGroupHint')}</p>
            <ul className="flex flex-col gap-1.5">
              {b.ownerGroups.map((g) => {
                const own = b.payers.find((p) => p.scopeKind === 'owner_group' && p.scopeId === g.id);
                return (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-soft px-3.5 py-2.5 text-sm">
                    <span className="font-semibold">{g.name}</span>
                    <PayerControl label={t('payerFor', { name: g.name })} value={own ? own.payer : 'inherit'} pct={own?.franchiseePercent ?? 50} onSave={(p, pct) => save('owner_group', g.id, p, pct)} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <p className="text-sm font-semibold">{t('totals', { hq: `${amt(b.hqTotal.amount, b.currency, locale)} ${tb(`per.${b.interval}`)}`, franchisee: amt(franchiseeTotal, b.currency, locale) })}</p>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Invoices and fees                                                   */
/* ------------------------------------------------------------------ */

export function InvoicesCard({ b }: { b: Pick<BillingView, 'invoices'> }) {
  const t = useTranslations('billing.invoices');
  const locale = useLocale();
  return (
    <SectionCard title={t('title')}>
      {b.invoices.length === 0 ? (
        <p className="text-sm text-stone">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="invoices">
          {b.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-semibold">{t(`kinds.${i.kind}`)}</div>
                <div className="text-xs text-stone">
                  {i.number} · {fmtDate(i.createdAt, locale)}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular font-bold">{amt(i.total.amount, i.total.currency, locale)}</span>
                <Badge tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'warning' : 'neutral'}>{t(`statuses.${i.status}`)}</Badge>
                {i.hostedUrl && (
                  <a href={i.hostedUrl} target="_blank" rel="noreferrer" className="text-xs font-bold underline underline-offset-4">
                    {t('view')}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function FeesCard({ b }: { b: BillingView }) {
  const t = useTranslations('billing.fees');
  const locale = useLocale();
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(b.paymentFeeBps / 10_000);
  return (
    <SectionCard title={t('title')}>
      <ul className="flex flex-col gap-2 text-sm text-graphite">
        <li>{t('collection', { fee: amt(b.collectionFee.perCollection.amount, b.collectionFee.perCollection.currency, locale), cap: amt(b.collectionFee.monthlyCapPerLocation.amount, b.collectionFee.monthlyCapPerLocation.currency, locale) })}</li>
        <li>{t('payments', { percent })}</li>
        <li>{t('terms')}</li>
      </ul>
    </SectionCard>
  );
}
