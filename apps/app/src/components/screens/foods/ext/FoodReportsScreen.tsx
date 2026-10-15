'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Tabs } from '@bh/ui';
import type { FoodsReport } from '@/lib/foods/types';
import { useFoods } from '@/lib/foods/useFoods';
import { fmtNumber } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock } from '../../../ui/States';
import { ChannelTag, Money1, MoneyList, Section, StatusBadge, useFx } from './common';

type Range = '7' | '30' | '90';

/** Orders by channel, prep times, sold-out frequency, revenue per currency (never combined), catering pipeline and meal plans. */
export function FoodReportsScreen() {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const [range, setRange] = useState<Range>('30');
  const single = app.scope.locationIds.length === 1 ? app.scope.locationIds[0] : undefined;
  const res = useFoods((api) => api.reports({ from: new Date(Date.now() - Number(range) * 86400_000).toISOString(), locationId: single }), [range, single, app.org.id]);
  if (!app.can('reports.read')) return <DeniedState permission="reports.read" />;
  const pct = (n: number | null) => (n === null ? t('common.unavailable') : `${Math.round(n * 100)}%`);
  const min = (n: number | null) => (n === null ? t('common.unavailable') : t('reports.minutes', { n }));
  return (
    <>
      <PageHeader icon="chart" title={t('reports.title')} description={t('reports.description')} />
      <Tabs<Range> items={[{ key: '7', label: t('reports.days', { n: 7 }) }, { key: '30', label: t('reports.days', { n: 30 }) }, { key: '90', label: t('reports.days', { n: 90 }) }]} value={range} onChange={setRange} />
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {(r: FoodsReport) => (
          <>
            <Banner tone="neutral" icon="info">{r.combinedRevenueReason ?? t('reports.noCombined')}</Banner>
            <div className="grid gap-3 xl:grid-cols-2">
              <Section title={t('reports.revenue')}>
                {r.revenueByCurrency.length === 0 ? <p className="text-sm text-stone">{t('reports.noOrders')}</p> : (
                  <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-stone"><th className="p-1.5">{t('reports.currency')}</th><th className="p-1.5">{t('reports.orders')}</th><th className="p-1.5">{t('reports.gross')}</th><th className="p-1.5">{t('reports.avg')}</th><th className="p-1.5">{t('reports.tips')}</th></tr></thead>
                    <tbody>{r.revenueByCurrency.map((c) => <tr key={c.currency} className="border-t border-line-soft"><td className="p-1.5 font-bold">{c.currency}</td><td className="p-1.5 tabular">{fmtNumber(c.orders, locale)}</td><td className="p-1.5"><Money1 m={c.gross} /></td><td className="p-1.5"><Money1 m={c.averageOrder} /></td><td className="p-1.5"><Money1 m={c.tips} /></td></tr>)}</tbody>
                  </table></div>
                )}
              </Section>
              <Section title={t('reports.byChannel')}>
                <ul className="flex flex-col gap-2 text-sm">{r.ordersByChannel.map((c) => <li key={c.channel} className="flex flex-wrap items-center gap-2"><ChannelTag channel={c.channel} /><strong className="tabular">{fmtNumber(c.orders, locale)}</strong><span className="text-xs text-stone">{t('reports.cancelled', { n: c.cancelledOrRejected })}</span><span className="ml-auto"><MoneyList values={c.revenue} /></span></li>)}</ul>
              </Section>
              <Section title={t('reports.prep')}>
                <p className="mb-2 text-xs text-stone">{r.prepTimes?.definition}</p>
                <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-stone"><th className="p-1.5">{t('common.location')}</th><th className="p-1.5">{t('reports.median')}</th><th className="p-1.5">{t('reports.p90')}</th><th className="p-1.5">{t('reports.onTime')}</th></tr></thead>
                  <tbody>{r.prepTimes?.locations.map((l) => <tr key={l.locationId} className="border-t border-line-soft"><td className="p-1.5">{l.name}</td><td className="p-1.5">{min(l.medianMinutes)}</td><td className="p-1.5">{min(l.p90Minutes)}</td><td className="p-1.5">{pct(l.onTimeRate)}</td></tr>)}</tbody>
                </table></div>
                {r.prepTimes?.stations ? <ul className="mt-2 text-xs">{r.prepTimes.stations.map((s) => <li key={s.stationId}>{s.name}: {min(s.medianMinutes)} ({t('reports.target', { n: s.targetMinutes })}, {t('reports.overTarget', { n: s.overTarget, of: s.tickets })})</li>)}</ul> : <p className="mt-2 text-xs text-stone">{r.prepTimes?.stationsUnavailableReason}</p>}
              </Section>
              <Section title={t('reports.soldOut')}>
                {r.soldOut.length === 0 ? <p className="text-sm text-stone">{t('reports.noSoldOut')}</p> : <ul className="flex flex-col gap-1 text-sm">{r.soldOut.map((s) => <li key={s.id} className="flex flex-wrap gap-2"><strong>{s.name}</strong><span>{t('reports.times', { n: s.times })}</span><span className="text-stone">{t('reports.minutes', { n: s.minutesSoldOut })} · {s.sources.map((x) => t(`reports.source.${x}`)).join(', ')}</span></li>)}</ul>}
              </Section>
              <Section title={t('reports.catering')}>
                <p className="mb-2 text-xs text-stone">{r.catering?.definition}</p>
                <ul className="flex flex-col gap-1 text-sm">{r.catering?.stages.filter((s) => s.count > 0).map((s) => <li key={s.status} className="flex flex-wrap items-center gap-2"><StatusBadge status={s.status} /><strong>{s.count}</strong><span className="ml-auto"><MoneyList values={s.value} /></span></li>)}</ul>
                <p className="mt-2 text-xs">{t('reports.conversion', { pct: pct(r.catering?.conversionRate ?? null) })}</p>
              </Section>
              <Section title={t('reports.mealPlans')}>
                {r.mealPlans.length === 0 ? <p className="text-sm text-stone">{t('reports.noMealPlans')}</p> : <ul className="flex flex-col gap-1 text-sm">{r.mealPlans.map((m) => <li key={m.currency}>{m.currency}: {t('reports.mealLine', { active: m.active, paused: m.paused })} · <Money1 m={m.weeklyRecurring} /> {t('meal.perWeek')}</li>)}</ul>}
              </Section>
            </div>
            <p className="text-xs text-stone">{t('reports.generated', { at: new Date(r.generatedAt).toLocaleString(locale) })}</p>
          </>
        )}
      </Async>
    </>
  );
}
