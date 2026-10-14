'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, Toggle, cx } from '@bh/ui';
import { LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES, type Currency } from '@bh/shared';
import type { BusinessLocation, NewLocationInput, PlanInfo } from '@/lib/business';
import { useApi, useMutation } from '@/lib/useApi';
import { countryName, currencyName, fmtYmd, moneyWithCode } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { Async, Banner, LoadingBlock, SectionCard } from '../../ui/States';
import { COUNTRY_ZONES } from '../LocationWizard';

/* ------------------------------------------------------------------ */
/* Settings → Business & location                                      */
/* ------------------------------------------------------------------ */

/** The independent business's one location: address, time zone, currency, contact and hours. */
export function BusinessLocationCard() {
  const t = useTranslations('single.location');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.business.location(app.ctx), [app.industry, app.org.id]);
  const [form, setForm] = useState<BusinessLocation | null>(null);
  const [ok, setOk] = useState(false);
  const save = useMutation((api, input: Partial<BusinessLocation>) => api.business.saveLocation(app.ctx, input));
  useEffect(() => {
    if (res.status === 'ready') setForm(res.data);
  }, [res.status, res.data]);
  const up = (p: Partial<BusinessLocation>) => (setOk(false), setForm((f) => (f ? { ...f, ...p } : f)));
  const zones = form ? [...new Set([...(COUNTRY_ZONES[form.country] ?? []), form.timeZone, ...Object.values(COUNTRY_ZONES).flat()])] : [];
  const fe = save.error?.fields ?? {};

  return (
    <section id="business" className="scroll-mt-24">
      <SectionCard title={t('title')} aside={<span className="text-xs text-stone">{t('hint')}</span>}>
        <Async res={res} loading={<LoadingBlock variant="detail" rows={2} />}>
          {() =>
            form && (
              <div className="flex flex-col gap-3.5">
                {ok && <Banner tone="success" live="polite">{t('saved')}</Banner>}
                {save.error && !Object.keys(fe).length && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
                <div className="grid gap-3.5 md:grid-cols-2">
                  <Field label={t('line1')} error={fe.line1 ?? fe.address}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={form.line1} onChange={(e) => up({ line1: e.target.value })} autoComplete="address-line1" />}</Field>
                  <Field label={t('city')} error={fe.city}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={form.city} onChange={(e) => up({ city: e.target.value })} autoComplete="address-level2" />}</Field>
                  <Field label={t('region')} optional>{(p) => <Input id={p.id} value={form.region} onChange={(e) => up({ region: e.target.value })} autoComplete="address-level1" />}</Field>
                  <Field label={t('postalCode')} optional>{(p) => <Input id={p.id} value={form.postalCode} onChange={(e) => up({ postalCode: e.target.value })} autoComplete="postal-code" />}</Field>
                  <Field label={t('country')}>
                    {(p) => (
                      <Select id={p.id} value={form.country} onChange={(e) => up({ country: e.target.value })}>
                        {[...new Set([form.country, ...LAUNCH_COUNTRIES.map((c) => c.code)])].map((c) => (
                          <option key={c} value={c}>{countryName(c, locale)}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('timeZone')} hint={t('timeZoneHint')} error={fe.timeZone}>
                    {(p) => (
                      <Select id={p.id} aria-describedby={p.describedBy} value={form.timeZone} onChange={(e) => up({ timeZone: e.target.value })}>
                        {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('currency')} hint={t('currencyHint')}>
                    {(p) => (
                      <Select id={p.id} aria-describedby={p.describedBy} value={form.currency} onChange={(e) => up({ currency: e.target.value as Currency })}>
                        {SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c, locale)}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('phone')} optional>{(p) => <Input id={p.id} type="tel" value={form.phone} onChange={(e) => up({ phone: e.target.value })} autoComplete="tel" />}</Field>
                  <Field label={t('email')} optional error={fe.email}>{(p) => <Input id={p.id} type="email" aria-invalid={p.invalid} value={form.email} onChange={(e) => up({ email: e.target.value })} />}</Field>
                  <Field label={t('hours')} hint={t('hoursHint')}>{(p) => <Input id={p.id} aria-describedby={p.describedBy} value={form.hours} onChange={(e) => up({ hours: e.target.value })} />}</Field>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-stone">
                    <Icon name={form.publiclyVisible ? 'eye' : 'lock'} size={13} />
                    {form.publiclyVisible ? t('visible') : t('notVisible')}
                  </span>
                  <Button
                    loading={save.pending}
                    onClick={async () => {
                      const { id: _id, status: _s, publiclyVisible: _v, ...input } = form;
                      const r = await save.run(input);
                      if (r) {
                        setForm(r);
                        setOk(true);
                        await app.reloadWorkspace();
                      }
                    }}
                  >
                    {t('save')}
                  </Button>
                </div>
              </div>
            )
          }
        </Async>
      </SectionCard>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Solo billing                                                        */
/* ------------------------------------------------------------------ */

export function priceText(p: PlanInfo['price'], locale: string, t: (k: string, v?: Record<string, string>) => string) {
  return p ? t('perMonth', { price: moneyWithCode({ amount: p.amount, currency: p.currency }, locale) }) : t('quote');
}

export function SoloBillingCard() {
  const t = useTranslations('single.billing');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.business.billing(app.ctx), [app.industry, app.org.id]);
  return (
    <SectionCard title={t('title')} aside={<Badge tone="neutral" icon="info">{t('separate')}</Badge>}>
      <Async res={res} loading={<LoadingBlock variant="detail" rows={1} />}>
        {(b) => (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-4 py-3.5" data-testid="solo-plan">
            <div>
              <div className="flex items-center gap-2 text-base font-bold">
                {b.plan.name}
                <Badge tone="success">{t(`status.${b.status === 'trialing' ? 'trialing' : 'active'}`)}</Badge>
              </div>
              <div className="text-sm text-stone">{b.plan.pricing === 'flat' ? t('soloBody') : t('perLocationBody')}</div>
            </div>
            <div className="text-right">
              <div className="tabular text-xl font-extrabold">{priceText(b.plan.price, locale, t)}</div>
              {b.periodEnd && <div className="text-xs text-stone">{t(b.status === 'trialing' ? 'trialEnds' : 'nextInvoice', { date: fmtYmd(b.periodEnd.slice(0, 10), locale, { day: 'numeric', month: 'long', year: 'numeric' }) })}</div>}
            </div>
          </div>
        )}
      </Async>
      <p className="mt-2 text-xs text-stone">{t('taxNote')}</p>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Website approvals                                                   */
/* ------------------------------------------------------------------ */

export function WebsiteApprovalsCard() {
  const t = useTranslations('single.approvals');
  const app = useApp();
  const res = useApi((api) => api.business.approvals(app.ctx), [app.industry, app.org.id]);
  const set = useMutation((api, on: boolean) => api.business.setApprovals(app.ctx, on ? 'staff' : 'off'));
  const on = res.status === 'ready' && res.data === 'staff';
  return (
    <SectionCard title={t('title')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold">{t('label')}</div>
          <div className="text-xs text-stone">{on ? t('onHint') : t('offHint')}</div>
        </div>
        <Toggle
          checked={on}
          label={t('label')}
          onChange={async (v) => {
            const r = await set.run(v);
            if (r) res.setData(r);
          }}
        />
      </div>
      {set.error && <Banner tone="danger" live="assertive">{set.error.message}</Banner>}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Add a location → upgrade to a network                               */
/* ------------------------------------------------------------------ */

export function AddLocationCard({ startOpen = false }: { startOpen?: boolean }) {
  const t = useTranslations('single.upgrade');
  const [open, setOpen] = useState(startOpen);
  return (
    <section id="add-location" className="scroll-mt-24">
      <SectionCard title={t('cardTitle')}>
        {!open ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-stone">{t('cardBody')}</p>
            <Button icon="plus" variant="secondary" onClick={() => setOpen(true)} data-testid="add-location">
              {t('addLocation')}
            </Button>
          </div>
        ) : (
          <UpgradeFlow onCancel={() => setOpen(false)} />
        )}
      </SectionCard>
    </section>
  );
}

const slug = (v: string) => v.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 12);

export function UpgradeFlow({ onCancel }: { onCancel?: () => void }) {
  const t = useTranslations('single.upgrade');
  const tb = useTranslations('single.billing');
  const tl = useTranslations('single.location');
  const locale = useLocale();
  const app = useApp();
  const router = useRouter();
  const preview = useApi((api) => api.business.upgradePreview(app.ctx), [app.industry, app.org.id]);
  const current = app.locations[0];
  const [addNow, setAddNow] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [loc, setLoc] = useState<NewLocationInput>({
    name: '', code: '', line1: '', city: '', region: '', postalCode: '',
    country: current?.address.country ?? 'US', timeZone: current?.timeZone ?? app.org.defaultTimeZone, currency: current?.currency ?? app.org.defaultCurrency,
  });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const run = useMutation((api, input: { location?: NewLocationInput }) => api.business.upgrade(app.ctx, input));
  const fe = { ...errs, ...(run.error?.fields ?? {}) };
  const zones = [...new Set([...(COUNTRY_ZONES[loc.country] ?? []), loc.timeZone, ...Object.values(COUNTRY_ZONES).flat()])];

  const submit = async () => {
    if (addNow) {
      const e: Record<string, string> = {};
      if (!loc.name.trim()) e.name = t('errors.name');
      if (!loc.line1.trim()) e.line1 = t('errors.line1');
      if (!loc.city.trim()) e.city = t('errors.city');
      setErrs(e);
      if (Object.keys(e).length) return;
    }
    const r = await run.run(addNow ? { location: { ...loc, code: loc.code.trim() || slug(loc.name) || 'LOC-2' } } : {});
    if (!r) return;
    // Keep this confirmation on screen; the workspace switches to the network view when the owner moves on.
    setDone(true);
  };
  const leave = async (href: string) => {
    if (app.live) await app.reloadWorkspace();
    else app.setSampleBusiness('network');
    router.push(href);
  };

  if (done)
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="success" title={t('doneTitle')} live="polite">{t('doneBody')}</Banner>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void leave('/locations')} iconRight="arrow-right" data-testid="upgrade-go-locations">{t('goLocations')}</Button>
          <Button variant="secondary" onClick={() => void leave('/overview')}>{t('goOverview')}</Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="upgrade-flow">
      <Banner tone="info" icon="layers" title={t('title')}>{t('intro', { name: app.org.name })}</Banner>
      <Async res={preview} loading={<LoadingBlock variant="detail" rows={2} />}>
        {(p) => (
          <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
            <div>
              <h3 className="mb-2 text-sm font-bold">{t('whatChanges')}</h3>
              <ul className="flex flex-col gap-1.5">
                {(t.raw('consequences') as string[]).map((c) => (
                  <li key={c} className="flex items-start gap-2 text-sm"><Icon name="check" size={15} className="mt-0.5 shrink-0" />{c}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2 rounded-lg bg-canvas p-4">
              <h3 className="text-sm font-bold">{t('pricing')}</h3>
              {p.currentPlan && (
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>{p.currentPlan.name}</span>
                  <span className="tabular font-semibold">{priceText(p.currentPlan.price, locale, tb)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-1"><Icon name="arrow-right" size={13} />{p.nextPlan.name}</span>
                <span className="tabular font-semibold">{p.nextPlan.price ? t('perLocation', { price: moneyWithCode({ amount: p.nextPlan.price.amount, currency: p.nextPlan.price.currency }, locale) }) : tb('quote')}</span>
              </div>
              <p className="text-xs text-stone">{t('pricingNote')}</p>
            </div>
          </div>
        )}
      </Async>

      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={addNow} onChange={(e) => setAddNow(e.target.checked)} className="h-4 w-4 accent-ink" />
        {t('addNow')}
      </label>
      {addNow && (
        <fieldset className="grid gap-3 rounded-lg border-[1.5px] border-line-soft p-4 md:grid-cols-2">
          <legend className="px-1 text-sm font-bold">{t('newLocation')}</legend>
          <Field label={t('locationName')} error={fe.name}>{(f) => <Input id={f.id} aria-invalid={f.invalid} aria-describedby={f.describedBy} value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} placeholder={t('locationNamePh')} />}</Field>
          <Field label={t('code')} hint={t('codeHint')} optional error={fe.code}>{(f) => <Input id={f.id} aria-describedby={f.describedBy} value={loc.code} onChange={(e) => setLoc({ ...loc, code: e.target.value.toUpperCase() })} placeholder={slug(loc.name) || 'LOC-2'} />}</Field>
          <Field label={tl('line1')} error={fe.line1 ?? fe.address}>{(f) => <Input id={f.id} aria-invalid={f.invalid} value={loc.line1} onChange={(e) => setLoc({ ...loc, line1: e.target.value })} />}</Field>
          <Field label={tl('city')} error={fe.city}>{(f) => <Input id={f.id} aria-invalid={f.invalid} value={loc.city} onChange={(e) => setLoc({ ...loc, city: e.target.value })} />}</Field>
          <Field label={tl('country')}>
            {(f) => (
              <Select id={f.id} value={loc.country} onChange={(e) => {
                const c = LAUNCH_COUNTRIES.find((x) => x.code === e.target.value);
                setLoc({ ...loc, country: e.target.value, currency: (c?.currency as Currency) ?? loc.currency, timeZone: COUNTRY_ZONES[e.target.value]?.[0] ?? loc.timeZone });
              }}>
                {LAUNCH_COUNTRIES.map((c) => <option key={c.code} value={c.code}>{countryName(c.code, locale)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={tl('timeZone')} error={fe.timeZone}>
            {(f) => <Select id={f.id} value={loc.timeZone} onChange={(e) => setLoc({ ...loc, timeZone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</Select>}
          </Field>
          <Field label={tl('currency')}>
            {(f) => <Select id={f.id} value={loc.currency} onChange={(e) => setLoc({ ...loc, currency: e.target.value as Currency })}>{SUPPORTED_CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c, locale)}</option>)}</Select>}
          </Field>
          <p className="self-end text-xs text-stone md:col-span-2">{t('notPublished')}</p>
        </fieldset>
      )}
      <label className={cx('flex items-start gap-2 rounded-md p-3 text-sm', confirmed ? 'bg-lime' : 'bg-canvas')}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" data-testid="upgrade-confirm" />
        {t('confirm')}
      </label>
      {run.error && !Object.keys(run.error.fields ?? {}).length && <Banner tone="danger" live="assertive">{run.error.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!confirmed} loading={run.pending} onClick={submit} data-testid="upgrade-submit">
          {addNow ? t('submitWithLocation') : t('submit')}
        </Button>
        {onCancel && <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>}
      </div>
      <p className="text-xs text-stone">{t('ownerOnly')}</p>
    </div>
  );
}
