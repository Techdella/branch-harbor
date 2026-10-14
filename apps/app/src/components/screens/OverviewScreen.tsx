'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, cx } from '@bh/ui';
import { useApi } from '@/lib/useApi';
import { fmtTime, zoneLabel } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, LoadingBlock, SectionCard } from '../ui/States';
import { MetricCard } from './MetricCard';

export function OverviewScreen() {
  const t = useTranslations('overview');
  const locale = useLocale();
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const res = useApi((api) => api.overview(app.ctx), [app.industry, app.role, app.scopeId]);
  const kindTone = { action: 'bg-butter', integration: 'bg-blush', info: 'bg-canvas' } as const;

  return (
    <>
      <PageHeader icon="grid" title={t('title')} />
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {(ov) => (
          <>
            <section aria-label={t('metrics')} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
              {ov.metrics.map((m) => (
                <MetricCard key={m.key} m={m} />
              ))}
            </section>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
              <SectionCard title={ov.upcomingTitle} aside={<span className="text-xs text-stone">{t('localTimes')}</span>}>
                {ov.upcoming.length === 0 ? (
                  <p className="rounded-md bg-canvas p-4 text-sm text-stone">{t('nothingUpcoming')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {ov.upcoming.map((u, i) => (
                      <li key={u.id} className={cx('flex items-center gap-3 rounded-md p-2.5', i % 2 ? 'bg-surface' : 'bg-canvas-raised')}>
                        <span className="tabular w-[72px] shrink-0 text-[13px] font-extrabold">
                          {fmtTime(u.at, u.timeZone, locale)}
                          <span className="block text-[10px] font-semibold text-stone">{zoneLabel(u.timeZone, locale, new Date(u.at))}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-bold sm:truncate">{u.title}</div>
                          <div className="truncate text-xs text-stone">{u.detail}</div>
                        </div>
                        <Badge tone={u.status.tone}>{u.status.label}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
              <div className="flex flex-col gap-3">
                <SectionCard title={t('needsAttention')}>
                  {ov.attention.length === 0 ? (
                    <p className="flex items-center gap-2 rounded-md bg-success-bg p-4 text-sm font-semibold text-success">
                      <Icon name="check-circle" size={16} />
                      {t('allClear')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {ov.attention.map((a) => (
                        <li key={a.id}>
                          <Link href={a.href} className={cx('flex items-center gap-3 rounded-md p-3 hover:outline hover:outline-1 hover:outline-ink', kindTone[a.kind])}>
                            <Icon name={a.icon} size={18} />
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-graphite">{t(`kind.${a.kind}`)}</div>
                              <div className="text-sm font-bold">{a.title}</div>
                              <div className="text-xs text-graphite">{a.detail}</div>
                            </div>
                            <Icon name="chevron-right" size={16} />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionCard>
                <div className="flex flex-wrap items-center gap-3.5 rounded-xl bg-ink p-5 text-white">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#7B4FD6,#E8835A)]">
                    <Icon name="sparkles" size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-bold">{ov.aiPrompt}</div>
                    <div className="text-xs text-[#B9B9B3]">{t('aiNote', { scope: scopeLabel })}</div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => app.setAiOpen(true)} className="border-0">
                    {t('ask')}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
