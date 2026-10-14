'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Tabs, type Column } from '@bh/ui';
import { addDays, dateInZone, fmtDateTime, fmtNumber } from '@/lib/format';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import type { Draft, UtilRow, WReport } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../../ui/States';
import { Loadable, LocationSelect, Money, pct, useScopeLocations } from './shared';

type Range = '7' | '30' | '90';

export function InsightsView() {
  const t = useTranslations('wellnessFull.insights');
  const tw = useTranslations('wellnessFull');
  const locale = useLocale();
  const app = useApp();
  const locs = useScopeLocations();
  const [range, setRange] = useState<Range>('30');
  const [locationId, setLocationId] = useState('');
  const tz = locs[0]?.timeZone ?? 'UTC';
  const to = dateInZone(new Date(), tz);
  const from = addDays(to, -Number(range) + 1);
  const scoped = locationId || (locs.length === 1 ? locs[0]!.id : undefined);
  const res = useWellness(app.locations, (api) => api.report(from, to, scoped), [from, to, scoped, app.role, app.scopeId], app.can('reports.read'));
  const action = useWellnessAction(app.locations);
  const [draft, setDraft] = useState<Draft | null>(null);
  if (!app.can('reports.read')) return <DeniedState permission="reports.read" />;
  const utilCols: Column<UtilRow>[] = [
    { key: 'name', header: t('name'), render: (r) => <span className="font-bold">{r.name}</span> },
    { key: 'loc', header: t('location'), render: (r) => r.locationName },
    { key: 'booked', header: t('bookedHours'), align: 'right', render: (r) => fmtNumber(Math.round(r.bookedMinutes / 6) / 10, locale) },
    { key: 'avail', header: t('scheduledHours'), align: 'right', render: (r) => (r.availableMinutes ? fmtNumber(Math.round(r.availableMinutes / 6) / 10, locale) : <span className="text-stone">{tw('unavailable')}</span>) },
    { key: 'rate', header: t('utilisation'), align: 'right', render: (r) => <UtilBar rate={r.rate} /> },
  ];
  return (
    <>
      <PageHeader icon="chart" title={t('title')} description={t('description')} actions={app.can('ai.use') ? <Button variant="secondary" icon="sparkles" disabled={action.pending} onClick={async () => setDraft((await action.run((api) => api.draftSummary(from, to, scoped))) ?? null)}>{action.pending ? t('summarising') : t('summarise')}</Button> : null} />
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface p-3.5">
        <Tabs items={(['7', '30', '90'] as const).map((k) => ({ key: k, label: t('lastDays', { n: Number(k) }) }))} value={range} onChange={(k) => setRange(k as Range)} />
        <LocationSelect locations={locs} value={locationId} onChange={setLocationId} allLabel={t('allInScope')} label={tw('location')} />
        <span className="text-xs text-stone">{t('rangeNote', { from, to })}</span>
      </div>
      {action.error && <Banner tone={action.error.code === 'ai_unavailable' ? 'warning' : 'danger'} live="polite">{action.error.message}</Banner>}
      {draft && (
        <SectionCard title={t('aiSummary')} aside={<Badge tone="info" icon="file">{t('draftOnly')}</Badge>}>
          <p className="whitespace-pre-wrap text-sm">{draft.output}</p>
          <p className="mt-2 text-xs text-stone">{t('sources')}: {draft.sources.join(', ')} · {t('aiNote')}</p>
        </SectionCard>
      )}
      <Loadable res={res} loading={<LoadingBlock variant="detail" />}>
        {(r: WReport) => (
          <div className="flex flex-col gap-3">
            <p className="px-1 text-xs text-stone">{t('freshness', { source: r.source, at: fmtDateTime(r.asOf, tz, locale) })}</p>
            <div className="grid gap-3 lg:grid-cols-2">
              <SectionCard title={t('revenue')}>
                {r.revenue.length ? (
                  <div className="flex flex-col gap-3">
                    {r.revenue.map((x) => (
                      <dl key={x.currency} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg bg-canvas p-3 text-[13px]">
                        <dt className="col-span-2 mb-1 font-extrabold">{x.currency}</dt>
                        <dt>{t('appointmentValue')}</dt><dd className="text-right"><Money m={{ amount: x.appointmentValueMinor, currency: x.currency }} /></dd>
                        <dt>{t('deposits')}</dt><dd className="text-right"><Money m={{ amount: x.depositsCollectedMinor, currency: x.currency }} /></dd>
                        <dt>{t('packagesSold')}</dt><dd className="text-right"><Money m={{ amount: x.packagesSoldMinor, currency: x.currency }} /></dd>
                        <dt>{t('vouchersSold')}</dt><dd className="text-right"><Money m={{ amount: x.vouchersSoldMinor, currency: x.currency }} /></dd>
                        <dt>{t('feesRetained')}</dt><dd className="text-right"><Money m={{ amount: x.feesRetainedMinor, currency: x.currency }} /></dd>
                        <dt>{t('feesOutstanding')}</dt><dd className="text-right"><Money m={{ amount: x.feesOutstandingMinor, currency: x.currency }} /></dd>
                        <dt>{t('refunds')}</dt><dd className="text-right"><Money m={{ amount: x.refundsMinor, currency: x.currency }} /></dd>
                        <dt>{t('packageSessions')}</dt><dd className="text-right">{x.packageSessionsUsed}</dd>
                      </dl>
                    ))}
                    <p className="text-xs text-stone">{t('combined')}</p>
                    <p className="text-xs text-stone">{r.revenueDefinition}</p>
                  </div>
                ) : <Empty icon="chart" title={t('noRevenue')} />}
              </SectionCard>
              <SectionCard title={t('liability')}>
                <div className="flex flex-col gap-2 text-[13px]">
                  {r.packageLiability.map((x) => <div key={`p${x.currency}`} className="flex justify-between gap-2 rounded-md bg-canvas px-3 py-2"><span>{t('packageLiability', { n: x.packages, sessions: x.sessionsRemaining })}</span><strong><Money m={{ amount: x.valueMinor, currency: x.currency }} /></strong></div>)}
                  {r.voucherLiability.map((x) => <div key={`v${x.currency}`} className="flex justify-between gap-2 rounded-md bg-canvas px-3 py-2"><span>{t('voucherLiability', { n: x.vouchers })}</span><strong><Money m={{ amount: x.balanceMinor, currency: x.currency }} /></strong></div>)}
                  {!r.packageLiability.length && !r.voucherLiability.length && <p className="text-stone">{t('noLiability')}</p>}
                  <p className="text-xs text-stone">{r.liabilityDefinition}</p>
                </div>
              </SectionCard>
            </div>
            <SectionCard title={t('cancellations')}>
              <DataTable rowKey={(x) => x.locationId} rows={r.cancellations} columns={[
                { key: 'loc', header: t('location'), render: (x) => <span className="font-bold">{x.locationName}</span> },
                { key: 'booked', header: t('booked'), align: 'right', render: (x) => x.booked },
                { key: 'done', header: t('completed'), align: 'right', render: (x) => x.completed },
                { key: 'free', header: t('free'), align: 'right', render: (x) => x.freeCancellations },
                { key: 'late', header: t('late'), align: 'right', render: (x) => x.lateCancellations },
                { key: 'biz', header: t('business'), align: 'right', render: (x) => x.businessCancellations },
                { key: 'ns', header: t('noShows'), align: 'right', render: (x) => x.noShows },
                { key: 'rate', header: t('rate'), align: 'right', render: (x) => pct(x.cancellationRate, locale) ?? <span className="text-stone">{tw('unavailable')}</span> },
              ]} />
            </SectionCard>
            <SectionCard title={t('utilPractitioners')}><DataTable rowKey={(x) => `${x.id}${x.locationId}`} rows={r.utilisation.practitioners} columns={utilCols} empty={<Empty icon="user" title={t('noUtil')} />} /><p className="mt-2 text-xs text-stone">{r.utilisation.definition}</p></SectionCard>
            <SectionCard title={t('utilRooms')}><DataTable rowKey={(x) => x.id} rows={r.utilisation.rooms} columns={utilCols} empty={<Empty icon="room" title={t('noUtil')} />} /></SectionCard>
          </div>
        )}
      </Loadable>
    </>
  );
}

function UtilBar({ rate }: { rate: number | null }) {
  const locale = useLocale();
  const tw = useTranslations('wellnessFull');
  if (rate == null) return <span className="text-stone">{tw('unavailable')}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-canvas" aria-hidden><span className="block h-full bg-ink" style={{ width: `${Math.min(100, rate * 100)}%` }} /></span>
      <span className="tabular w-10 text-right">{pct(rate, locale)}</span>
    </span>
  );
}
