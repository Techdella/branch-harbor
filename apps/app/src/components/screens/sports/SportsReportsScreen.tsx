'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@bh/ui';
import { fmtDateTime } from '@/lib/format';
import { useSports } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, DeniedState, LoadingBlock, SectionCard } from '../../ui/States';
import { Amount, CapacityBar, useScopeIds } from './ui';

/** Enrolment, capacity, attendance rates and outstanding balances per currency (never combined). */
export function SportsReportsScreen() {
  const t = useTranslations('sportsHub.reports');
  const tOps = useTranslations('ops.sports.reports');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const res = useSports((c) => c.reports(scope), [scope.join(','), app.role], app.can('reports.read'));
  if (!app.can('reports.read')) return <><PageHeader icon="chart" title={tOps('title')} /><DeniedState permission="reports.read" /></>;
  return (
    <>
      <PageHeader icon="chart" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="table" rows={6} />} permission="reports.read">
        {(r) => (
          <>
            <p className="text-xs text-stone">{t('meta', { days: r.periodDays, at: fmtDateTime(r.asOf, 'UTC', locale) })}</p>
            <SectionCard title={t('balances')} aside={<span className="text-xs text-stone">{t('noCombined')}</span>}>
              {r.balances.length === 0 ? <p className="text-sm text-stone">{t('noBalances')}</p> : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {r.balances.map((b) => (
                    <div key={b.currency} className="rounded-lg bg-canvas p-4">
                      <div className="text-xs font-bold text-stone">{b.currency}</div>
                      <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
                        <dt className="text-stone">{t('outstanding')}</dt><dd className="text-right font-bold"><Amount amount={b.outstanding} currency={b.currency} /></dd>
                        <dt className="text-stone">{t('overdue')}</dt><dd className="text-right font-bold text-danger"><Amount amount={b.overdue} currency={b.currency} /></dd>
                        <dt className="text-stone">{t('collected')}</dt><dd className="text-right"><Amount amount={b.collected} currency={b.currency} /></dd>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            <SectionCard title={t('enrolment')}>
              <div className="overflow-x-auto" tabIndex={0}>
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-left text-xs text-stone"><th className="py-2">{t('programme')}</th><th>{t('location')}</th><th className="text-right">{t('accepted')}</th><th className="text-right">{t('review')}</th><th className="text-right">{t('payment')}</th><th className="text-right">{t('waitlist')}</th><th className="text-right">{t('withdrawn')}</th><th className="text-right">{t('fill')}</th></tr></thead>
                  <tbody>
                    {r.enrolment.map((e) => (
                      <tr key={e.programmeId} className="border-t border-line-soft">
                        <td className="py-2 font-bold">{e.programme}</td>
                        <td className="text-stone">{r.locations.find((l) => l.id === e.locationId)?.name}</td>
                        <td className="text-right">{e.accepted}</td><td className="text-right">{e.awaitingReview}</td><td className="text-right">{e.awaitingPayment}</td><td className="text-right">{e.waitlisted}</td><td className="text-right">{e.withdrawn}</td>
                        <td className="text-right">{e.fillRate === null ? <span title={e.fillRateUnavailableReason ?? ''} className="text-stone">{t('unavailable')}</span> : `${e.fillRate}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
            <div className="grid items-start gap-3 lg:grid-cols-2">
              <SectionCard title={t('capacity')}>
                <ul className="flex flex-col gap-3">{r.capacity.map((c) => <li key={c.teamId}><CapacityBar used={c.roster} capacity={c.capacity} label={`${c.team}${c.kind === 'squad' ? ` · ${t('squad')}` : ''}`} /></li>)}</ul>
              </SectionCard>
              <SectionCard title={t('attendance')}>
                <ul className="flex flex-col divide-y divide-line-soft">
                  {r.attendance.map((a) => (
                    <li key={a.teamId} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="font-bold">{a.team}</span>
                      {a.rate === null ? <Badge tone="neutral" icon="info">{t('unavailable')}</Badge> : <span><strong>{a.rate}%</strong> <span className="text-xs text-stone">{t('attendedOf', { attended: a.attended, recorded: a.recorded })}</span></span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-stone">{t('attendanceDefinition')}</p>
              </SectionCard>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
