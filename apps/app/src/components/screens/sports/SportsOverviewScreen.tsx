'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon } from '@bh/ui';
import { fmtDateTime, zoneLabel } from '@/lib/format';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock, SectionCard } from '../../ui/States';
import { Amount, CapacityBar, Stat, useScopeIds } from './ui';

/** Programme overview: enrolment vs capacity, outstanding administrative work and upcoming sessions. */
export function SportsOverviewScreen() {
  const t = useTranslations('sportsHub.overview');
  const tOps = useTranslations('ops.sports.overview');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const res = useSports((c) => c.overview(scope), [scope.join(','), app.role]);
  const ai = useSportsAction((c, locationId?: string) => c.aiEnrolment(locationId));
  const [draft, setDraft] = useState<{ summary: string; asOf: string } | null>(null);
  const summary = async (locationId?: string) => setDraft((await ai.run(locationId)) ?? null);

  return (
    <>
      <PageHeader icon="grid" title={tOps('title')} description={tOps('description')} actions={app.can('ai.use') ? <Button variant="secondary" icon="sparkles" loading={ai.pending} onClick={() => void summary(scope.length === 1 ? scope[0] : undefined)}>{t('aiSummary')}</Button> : null} />
      {ai.error && <Banner tone={ai.error.code === 'ai_unavailable' ? 'neutral' : 'danger'} icon="sparkles">{ai.error.message}</Banner>}
      {draft && (
        <SectionCard title={t('aiSummaryTitle')} aside={<Badge tone="info" icon="sparkles">{t('draftOnly')}</Badge>}>
          <p className="whitespace-pre-line text-sm">{draft.summary}</p>
          <p className="mt-2 text-xs text-stone">{t('aiSource', { at: fmtDateTime(draft.asOf, 'UTC', locale) })}</p>
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {(d) => (
          <>
            {d.work && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Link href="/ops/registrations"><Stat icon="file" label={t('awaitingReview')} value={d.work.awaitingReview} sub={t('awaitingReviewSub')} tone={d.work.awaitingReview ? 'warning' : undefined} /></Link>
                <Link href="/ops/balances"><Stat icon="card" label={t('overdueInstalments')} value={d.work.overdueInstalments ?? t('unavailable')} sub={d.work.overdueByCurrency?.length ? d.work.overdueByCurrency.map((x) => <Amount key={x.currency} amount={x.amount} currency={x.currency} className="mr-2" />) : d.work.overdueInstalments === null ? t('noFinanceAccess') : t('nothingOverdue')} tone={d.work.overdueInstalments ? 'danger' : undefined} /></Link>
                <Link href="/ops/guardians"><Stat icon="shield" label={t('openDisputes')} value={d.work.openDisputes} sub={t('openDisputesSub')} tone={d.work.openDisputes ? 'warning' : undefined} /></Link>
                <Link href="/ops/teams"><Stat icon="trophy" label={t('pendingSelections')} value={d.work.pendingSelections} sub={t('pendingSelectionsSub')} /></Link>
              </div>
            )}
            <div className="grid items-start gap-3 lg:grid-cols-[1.4fr_1fr]">
              <SectionCard title={t('enrolment')} aside={<span className="text-xs text-stone">{t('enrolmentNote')}</span>}>
                {d.programmes.length === 0 ? <p className="text-sm text-stone">{t('noProgrammes')}</p> : (
                  <ul className="flex flex-col gap-4">
                    {d.programmes.map((p) => (
                      <li key={p.id} className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-bold">{p.name}</div>
                            <div className="text-xs text-stone">{d.locations.find((l) => l.id === p.locationId)?.name}</div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {p.status !== 'published' && <Badge tone="neutral" icon="edit">{t(`status.${p.status}`)}</Badge>}
                            {p.awaitingReview > 0 && <Badge tone="info" icon="clock">{t('reviewCount', { n: p.awaitingReview })}</Badge>}
                            {p.awaitingPayment > 0 && <Badge tone="warning" icon="card">{t('paymentCount', { n: p.awaitingPayment })}</Badge>}
                            {p.waitlisted > 0 && <Badge tone="neutral" icon="list">{t('waitlistCount', { n: p.waitlisted })}</Badge>}
                          </div>
                        </div>
                        <CapacityBar used={p.held} capacity={p.capacity} label={t('placesHeld')} />
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
              <SectionCard title={t('upcoming')}>
                {d.upcoming.length === 0 ? <p className="text-sm text-stone">{t('noUpcoming')}</p> : (
                  <ul className="flex flex-col divide-y divide-line-soft">
                    {d.upcoming.map((u) => (
                      <li key={u.id} className="flex items-start justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-bold"><Icon name={u.kind === 'fixture' ? 'trophy' : 'whistle'} size={15} />{u.team}{u.opponent ? ` ${t('vs')} ${u.opponent}` : ''}</div>
                          <div className="text-xs text-stone">{fmtDateTime(u.startsAt, u.location.timeZone, locale)} {zoneLabel(u.location.timeZone, locale)} · {u.venue ?? t('venueTbc')} · {u.location.name}</div>
                        </div>
                        {u.status === 'cancelled' ? <Badge tone="danger" icon="x">{t('cancelled')}</Badge> : <Badge tone="neutral" icon={null}>{t(`kind.${u.kind}`)}</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                <Link href="/ops/schedule" className="mt-3 inline-flex items-center gap-1 text-sm font-bold">{t('openSchedule')} <Icon name="arrow-right" size={14} /></Link>
              </SectionCard>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
