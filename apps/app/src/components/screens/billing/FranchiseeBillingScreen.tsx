'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { COUNTRY_CURRENCY, COUNTRY_TIER } from '@bh/shared';
import { Badge, Button, Field, Input, Select } from '@bh/ui';
import { billingApi, billingCountries, type FranchiseeView, type SetupInfo } from '@/lib/billing';
import { moneyWithCode } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock, SectionCard } from '../../ui/States';
import { InvoicesCard } from './BillingScreen';
import { CardEntry, type CardResult } from './CardEntry';

const COUNTRY_CODES = [...new Set([...Object.keys(COUNTRY_CURRENCY), ...Object.keys(COUNTRY_TIER)])];

/**
 * Franchisee billing: the location fees headquarters passes on (all or a share), paid from the franchisee's own billing
 * account in the currency of their billing country, with the same card-country check as HQ's checkout.
 */
export function FranchiseeBillingScreen() {
  const t = useTranslations('billing.franchisee');
  const app = useApp();
  const res = useApi(() => billingApi.franchisee(), [app.org.id]);
  return (
    <>
      <PageHeader icon="card" title={t('title')} description={t('description')} scope={false} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(v) => <Body v={v} reload={res.reload} />}
      </Async>
    </>
  );
}

function Body({ v, reload }: { v: FranchiseeView; reload: () => void }) {
  const t = useTranslations('billing.franchisee');
  const tp = useTranslations('billing.payers');
  const locale = useLocale();
  const paying = v.locations.filter((l) => l.amount.amount > 0);
  const groups = v.scopes;
  return (
    <>
      <SectionCard title={t('locations')}>
        <div className="flex flex-col gap-3" data-testid="franchisee-locations">
          <p className="max-w-3xl text-sm text-graphite">{paying.length ? t('intro') : t('none')}</p>
          <ul className="flex flex-col gap-1.5">
            {v.locations.map((l) => (
              <li key={l.locationId} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
                <div>
                  <div className="font-semibold">{l.name}</div>
                  <div className="text-xs text-stone">{l.included ? t('included') : l.payer === 'hq' ? t('hqPays') : `${tp(l.payer)} · ${t('share', { pct: l.franchiseePercent })}`}</div>
                </div>
                <span className="tabular font-bold">
                  {moneyWithCode(l.amount, locale)} <span className="text-xs font-semibold text-stone">{t('perMonth')}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </SectionCard>
      {groups.map((g) => {
        const acct = v.accounts.find((a) => a.scopeKind === g.kind && a.scopeId === g.id);
        return <AccountCard key={`${g.kind}:${g.id}`} scope={g} acct={acct} onDone={reload} />;
      })}
      <InvoicesCard b={v} />
    </>
  );
}

const SUB_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = { active: 'success', trialing: 'info', scheduled: 'info', past_due: 'danger', canceled: 'neutral', none: 'neutral' };

/** The franchisee's own subscription for the fees passed on: its status, the next charge (date and amount) and period. */
function SubscriptionStatus({ acct }: { acct: FranchiseeView['accounts'][number] }) {
  const t = useTranslations('billing.franchisee.subscription');
  const locale = useLocale();
  const sub = acct.subscription;
  if (!sub) return null;
  const known = ['active', 'trialing', 'scheduled', 'past_due', 'canceled', 'none'].includes(sub.status) ? sub.status : 'active';
  const date = sub.nextChargeAt ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(sub.nextChargeAt)) : null;
  return (
    <div className="grid gap-3 rounded-md bg-canvas-raised p-4 text-sm sm:grid-cols-3" data-testid="franchisee-subscription">
      <div>
        <div className="text-xs font-bold text-stone">{t('status')}</div>
        <div className="mt-1"><Badge tone={SUB_TONE[known] ?? 'neutral'}>{t(`statuses.${known}` as 'statuses.active')}</Badge></div>
      </div>
      <div>
        <div className="text-xs font-bold text-stone">{t('nextCharge')}</div>
        <div className="tabular mt-1 text-lg font-extrabold">{sub.nextCharge.amount > 0 ? moneyWithCode(sub.nextCharge, locale) : '—'}</div>
        {sub.nextCharge.amount > 0 && <div className="text-xs text-stone">{t(`per.${sub.interval}` as 'per.month')}</div>}
      </div>
      <div>
        <div className="text-xs font-bold text-stone">{t('on')}</div>
        <div className="mt-1 font-semibold">{date ?? '—'}</div>
        {sub.startsWithHqPlan && date && <div className="text-xs text-stone">{t('startsWithHq')}</div>}
      </div>
      {sub.status === 'past_due' && <p className="text-xs font-semibold text-danger sm:col-span-3">{t('pastDueHint')}</p>}
    </div>
  );
}

function AccountCard({ scope, acct, onDone }: { scope: { kind: 'location' | 'owner_group'; id: string }; acct: FranchiseeView['accounts'][number] | undefined; onDone: () => void }) {
  const t = useTranslations('billing.franchisee');
  const tb = useTranslations('billing');
  const locale = useLocale();
  const app = useApp();
  const countries = useMemo(() => billingCountries(COUNTRY_CODES, locale), [locale]);
  const [country, setCountry] = useState(acct?.billingCountry ?? (locale.split('-')[1] ?? 'US'));
  const [taxId, setTaxId] = useState('');
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const start = useMutation(() => billingApi.franchiseeSetup({ scopeKind: scope.kind, scopeId: scope.id, billingCountry: country }));
  const confirm = useMutation((_api, r: CardResult) => billingApi.franchiseeConfirm({ scopeKind: scope.kind, scopeId: scope.id, ...r, ...(taxId.trim() ? { taxId: taxId.trim() } : {}) }));
  const name = scope.kind === 'owner_group' ? t('ownerGroupAccount') : t('locationAccount');
  return (
    <SectionCard title={name} aside={acct?.status === 'active' ? <Badge tone="success">{t('active')}</Badge> : <Badge tone="warning">{t('needsCard')}</Badge>}>
      <div className="flex flex-col gap-3" data-testid="franchisee-account">
        {acct?.status === 'active' && acct.card ? (
          <>
            <SubscriptionStatus acct={acct} />
            <p className="text-sm">{t('cardOnFile', { brand: (acct.card.brand ?? '').toUpperCase(), last4: acct.card.last4 ?? '••••', currency: acct.currency })}</p>
          </>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={tb('checkout.country')} hint={tb('checkout.countryHint')}>
                {(p) => (
                  <Select id={p.id} aria-describedby={p.describedBy} value={country} onChange={(e) => { setCountry(e.target.value); setSetup(null); }}>
                    {countries.map((c) => (
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
            {!setup ? (
              <div>
                <Button loading={start.pending} onClick={async () => { const r = await start.run(); if (r) setSetup(r.setup); }}>
                  {t('setup')}
                </Button>
              </div>
            ) : (
              <CardEntry setup={setup} country={country} countries={countries} submitLabel={t('saveCard')} onCard={async (r) => { if (await confirm.run(r)) onDone(); }} />
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
