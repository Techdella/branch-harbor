'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@bh/ui';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtDateTime, fmtYmd } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, LocationSelect, Money1, MoneyList, NoLocations, Section, StatusBadge, useFx, useLocationPick } from './common';

/** Recurring meal plans: plans, subscribers (Stripe subscriptions, sandbox without keys), skip a week before the cut-off, release boxes to the kitchen. */
export function MealPlansScreen() {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const pick = useLocationPick();
  const lid = pick.locationId;
  const plans = useFoods((api) => api.mealPlans(), [app.org.id]);
  const subs = useFoods((api) => api.subscriptions({ locationId: lid }), [lid], !!lid);
  const skip = useFoodsMutation((api, id: string, week: string, s: boolean) => api.skipWeek(id, week, s));
  const release = useFoodsMutation((api, date: string) => api.releaseBoxes(lid, date));
  const [note, setNote] = useState('');
  if (!pick.loc) return <NoLocations />;
  const tz = pick.loc.timeZone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return (
    <>
      <PageHeader icon="repeat" title={t('meal.title')} description={t('meal.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3">
        <LocationSelect pick={pick} />
        {app.can('operations.write') && <Button size="sm" variant="secondary" icon="chef" loading={release.pending} onClick={async () => { const r = await release.run(today); if (r) setNote(t('meal.released', { n: r.released })); }}>{t('meal.releaseToday')}</Button>}
      </div>
      {note && <Banner tone="success" live="polite">{note}</Banner>}
      <ErrorLine error={skip.error ?? release.error} />
      <Section title={t('meal.plans')}>
        <Async res={plans} loading={<LoadingBlock variant="cards" rows={2} />}>
          {(list) => (
            <div className="grid gap-3 md:grid-cols-2">
              {list.map((p) => (
                <article key={p.id} className="flex flex-col gap-1 rounded-lg bg-canvas p-4 text-sm">
                  <div className="flex items-center justify-between"><h3 className="font-bold">{p.name}</h3><StatusBadge status={p.active ? 'active' : 'paused'} /></div>
                  <p className="text-stone">{p.description}</p>
                  <p><MoneyList values={Object.entries(p.pricesPerWeek).map(([currency, amount]) => ({ amount, currency }) as never)} /> {t('meal.perWeek')}</p>
                  <p className="text-xs">{t('meal.planRule', { meals: p.mealsPerBox, how: t(`channel.${p.fulfilment}`), day: new Date(Date.UTC(2026, 0, 4 + p.fulfilmentWeekday)).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' }), days: p.cutoffDaysBefore, time: p.cutoffTime })}</p>
                  {p.subscribers && <p className="text-xs text-stone">{Object.entries(p.subscribers).map(([k, v]) => `${t(`status.${k}`)}: ${v}`).join(' · ')}</p>}
                </article>
              ))}
            </div>
          )}
        </Async>
      </Section>
      <Section title={t('meal.subscribers')}>
        <Async res={subs} loading={<LoadingBlock variant="table" rows={3} />}>
          {(list) => list.length === 0 ? <p className="text-sm text-stone">{t('meal.noSubscribers')}</p> : (
            <ul className="divide-y divide-line-soft">
              {list.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{s.contact.name}</strong><StatusBadge status={s.status} /><span className="text-stone">{s.planName}</span>{s.sandbox && <span className="text-xs text-stone">· {t('delivery.mode.sandbox')}</span>}<span className="ml-auto font-bold"><Money1 m={s.price} /> {t('meal.perWeek')}</span></div>
                  <ul className="flex flex-wrap gap-2">
                    {s.upcoming.map((w) => (
                      <li key={w.weekStart} className="flex items-center gap-2 rounded-full bg-canvas px-3 py-1 text-xs">
                        <span className="font-bold">{fmtYmd(w.fulfilmentDate, locale)}</span>
                        {w.skipped ? <StatusBadge status="skipped" /> : <StatusBadge status="active" label={t('meal.scheduled')} />}
                        {w.canChange && app.can('customers.write') ? (
                          <button type="button" className="font-bold underline" onClick={async () => { if (await skip.run(s.id, w.weekStart, !w.skipped)) subs.reload(); }}>{w.skipped ? t('meal.unskip') : t('meal.skip')}</button>
                        ) : <span className="text-stone" title={fmtDateTime(w.cutoffAt, tz, locale)}>{w.canChange ? '' : t('meal.locked')}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Section>
    </>
  );
}
