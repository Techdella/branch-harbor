'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, Icon } from '@bh/ui';
import type { CoverRequest } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { cityOfZone, fmtDay, fmtTime, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';

export function CoverScreen() {
  const t = useTranslations('cover');
  const tOps = useTranslations('ops.studios.cover');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.studios.cover(app.ctx), [app.role]);
  const accept = useMutation((api, id: string, cand: string) => api.studios.acceptCover(id, cand));
  const approve = useMutation((api, id: string) => api.studios.approveCover(id));
  const reset = useMutation((api, id: string) => api.studios.resetCover(id));
  const canApprove = app.role !== 'staff';

  const apply = (r: CoverRequest | undefined) => r && res.setData(r);

  return (
    <>
      <PageHeader icon="users" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(c) => (
          <div className="grid items-start gap-3 lg:grid-cols-[1.4fr_1fr]">
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                <div className="rounded-lg bg-aqua p-4 text-[13px] leading-normal">
                  <div className="text-[11px] font-semibold">{t('class')}</div>
                  <div className="text-base font-extrabold">{c.className}</div>
                  {fmtDay(c.start, c.timeZone, locale)} · {fmtTime(c.start, c.timeZone, locale)}
                  <div className="text-[11px]">
                    {c.locationName} · {cityOfZone(c.timeZone)}
                  </div>
                </div>
                <div className="rounded-lg bg-blush p-4 text-[13px] leading-normal">
                  <div className="text-[11px] font-semibold">{t('requestedBy')}</div>
                  <div className="text-base font-extrabold">{c.requestedBy}</div>
                  {c.reason}
                </div>
                <div className="rounded-lg bg-butter p-4 text-[13px] leading-normal">
                  <div className="text-[11px] font-semibold">{t('status')}</div>
                  <div className="text-base font-extrabold">{t(`state.${c.status}`)}</div>
                  {t('booked', { count: c.bookedCustomers })}
                </div>
              </div>
              <h2 className="pt-1 text-sm font-bold">{t('eligible')}</h2>
              <ul className="flex flex-col gap-2">
                {c.candidates.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-[24px] bg-canvas px-3.5 py-2.5 text-sm">
                    <Avatar name={p.name} size={36} pastel={p.available ? '#E2F5A6' : '#EEEDE8'} />
                    <div className="min-w-0 flex-1">
                      <strong>{p.name}</strong>
                      <div className="text-xs text-stone">{p.note}</div>
                    </div>
                    <Badge tone={p.state === 'assigned' ? 'success' : p.state === 'accepted' ? 'info' : p.state === 'unavailable' ? 'neutral' : 'neutral'} icon={p.state === 'notified' ? 'bell' : p.state === 'unavailable' ? 'minus' : undefined}>
                      {t(`candidate.${p.state}`)}
                    </Badge>
                    {c.status === 'open' && p.available && (
                      <Button size="sm" variant="secondary" loading={accept.pending} onClick={async () => apply(await accept.run(c.id, p.id))}>
                        {t('recordAcceptance')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {c.status === 'open' && <p className="text-xs text-stone">{t('simulateHint')}</p>}
              {c.status === 'accepted' &&
                (canApprove ? (
                  <Button icon="check" loading={approve.pending} onClick={async () => apply(await approve.run(c.id))} className="self-start">
                    {t('approve')}
                  </Button>
                ) : (
                  <Banner tone="neutral" icon="lock">
                    {t('managerOnly')}
                  </Banner>
                ))}
              {approve.error && <Banner tone="danger" live="assertive">{approve.error.message}</Banner>}
              {c.status === 'confirmed' && (
                <div className="flex flex-wrap items-center gap-3">
                  <Banner tone="success" live="polite">
                    {t('confirmed', { count: c.bookedCustomers })}
                  </Banner>
                  <Button size="sm" variant="secondary" icon="refresh" onClick={async () => apply(await reset.run(c.id))}>
                    {t('restart')}
                  </Button>
                </div>
              )}
            </section>
            <section className="rounded-xl bg-surface p-5">
              <h2 className="mb-2.5 text-base font-bold">{t('history')}</h2>
              <ol className="flex flex-col gap-2.5">
                {c.history.map((h, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px]">
                    <Icon name="clock" size={14} className="mt-0.5 shrink-0 text-stone" />
                    <div>
                      <div>{h.text}</div>
                      <div className="text-xs text-stone">{relativeTime(h.at, locale)}</div>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-stone">{t('historyNote')}</p>
            </section>
          </div>
        )}
      </Async>
    </>
  );
}
