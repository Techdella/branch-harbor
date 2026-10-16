'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Toggle, cx } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { scaleApi, useScale, useScaleAction, type BenchmarkMetricVM, type BenchmarksVM } from './api';
import { ActionError, useQFmt } from './ui';

const lastMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

function useValue() {
  const f = useQFmt();
  return (m: Pick<BenchmarkMetricVM, 'metric' | 'currency'>, v: number | null) => {
    if (v === null) return '—';
    switch (m.metric) {
      case 'revenue_per_location': return f.money(Math.round(v), m.currency ?? 'USD');
      case 'bookings_per_location': return f.num(v, 1);
      case 'review_rating': return f.num(v, 2);
      default: return f.pct(v);
    }
  };
}

/** One metric: your value on the cohort's p10–p90 range, with the percentile. */
function MetricRow({ m, compact }: { m: BenchmarkMetricVM; compact?: boolean }) {
  const t = useTranslations('scale');
  const val = useValue();
  const label = m.currency ? t('bench.metricIn', { metric: t(`bench.metric.${m.metric}`), currency: m.currency }) : t(`bench.metric.${m.metric}`);
  if (m.status !== 'ok' || !m.cohort) {
    return (
      <li className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
        <span className="font-bold">{label}</span>
        <span className="text-stone">{m.status === 'no_data' ? t('bench.noData') : t('bench.tooSmall')}</span>
        {m.you !== null && <span className="ml-auto tabular">{t('bench.you')}: {val(m, m.you)}</span>}
      </li>
    );
  }
  const c = m.cohort;
  const lo = Math.min(c.p10, m.you ?? c.p10);
  const hi = Math.max(c.p90, m.you ?? c.p90);
  const span = hi - lo || 1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100))}%`;
  const pct = m.percentile ?? 0;
  return (
    <li className="flex flex-col gap-1.5 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{label}</span>
        <Badge tone={pct >= 75 ? 'success' : pct >= 50 ? 'info' : pct >= 25 ? 'neutral' : 'warning'}>{t('bench.percentile', { pct })}</Badge>
        <span className="ml-auto tabular">{t('bench.you')}: <strong>{val(m, m.you)}</strong></span>
      </div>
      <div className="relative h-6" aria-hidden="true">
        <span className="absolute top-2.5 h-1 w-full rounded-full bg-canvas" />
        <span className="absolute top-1.5 h-3 rounded-full bg-line" style={{ left: pos(c.p25), width: `calc(${pos(c.p75)} - ${pos(c.p25)})` }} />
        <span className="absolute top-1 h-4 w-0.5 bg-ink" style={{ left: pos(c.p50) }} />
        {m.you !== null && <span className="absolute top-0.5 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-white bg-lime shadow" style={{ left: pos(m.you) }} />}
      </div>
      {!compact && <span className="text-xs text-stone">{t('bench.cohortLine', { p25: val(m, c.p25), p50: val(m, c.p50), p75: val(m, c.p75), size: c.size, scope: t(`bench.scope.${c.scope}`) })}</span>}
    </li>
  );
}

/** "You vs similar networks" card for the league table and the Network home (HQ with Network benchmarks only). */
export function BenchmarksCard() {
  const t = useTranslations('scale');
  const app = useApp();
  const on = app.hasModule('network.benchmarks') && app.org.model !== 'independent';
  const res = useScale(() => scaleApi.benchmarks(), [app.org.id], on);
  if (!on || res.status === 'error') return null;
  const d = res.data;
  return (
    <SectionCard title={t('bench.cardTitle')} aside={<Link href="/benchmarks" className="text-xs font-bold underline">{t('bench.open')}</Link>}>
      {!d ? <LoadingBlock variant="table" rows={2} /> : !d.optedIn ? (
        <p className="text-[13px] text-stone">{t('bench.cardOff')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft" data-testid="benchmarks-card">
          {d.metrics.filter((m) => m.status === 'ok').slice(0, 4).map((m) => <MetricRow key={`${m.metric}${m.currency ?? ''}`} m={m} compact />)}
          {!d.metrics.some((m) => m.status === 'ok') && <li className="py-2 text-[13px] text-stone">{t('bench.cardWaiting', { k: d.minCohort })}</li>}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * Network → Benchmarks: opt-in, anonymised comparison with similar networks (same industry and region) as
 * percentiles. Cohorts need at least 10 organisations, figures are noised, and money is compared per currency.
 */
export function BenchmarksScreen() {
  const t = useTranslations('scale');
  const app = useApp();
  const allowed = app.hasModule('network.benchmarks');
  const [period, setPeriod] = useState(lastMonth());
  const res = useScale(() => scaleApi.benchmarks(period), [app.org.id, period], allowed);
  if (!allowed) return <DeniedState />;
  return (
    <>
      <PageHeader icon="activity" title={t('bench.title')} description={t('bench.description')} scope={false} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(d) => (
          <>
            <Participation d={d} onChange={res.reload} />
            {d.optedIn && (
              <SectionCard title={t('bench.youVs', { industry: t(`bench.industry.${d.industry}` as 'bench.industry.studios'), region: t(`bench.region.${d.region}` as 'bench.region.europe') })}
                aside={<div className="w-40"><Field label={t('bench.period')}>{(x) => <Input id={x.id} type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} />}</Field></div>}>
                <ul className="flex flex-col divide-y divide-line-soft" data-testid="benchmarks">
                  {d.metrics.map((m) => <MetricRow key={`${m.metric}${m.currency ?? ''}`} m={m} />)}
                </ul>
              </SectionCard>
            )}
            <Privacy k={d.minCohort} />
          </>
        )}
      </Async>
    </>
  );
}

function Participation({ d, onChange }: { d: BenchmarksVM; onChange: () => void }) {
  const t = useTranslations('scale');
  const f = useQFmt();
  const act = useScaleAction();
  return (
    <section className={cx('flex flex-wrap items-center gap-3 rounded-xl p-4', d.optedIn ? 'bg-surface' : 'bg-lime/30')}>
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-bold">{d.optedIn ? t('bench.on') : t('bench.off')}</h2>
        <p className="text-[13px] text-stone">{d.optedIn ? t('bench.onSince', { when: f.date(d.settings.optedInAt) }) : t('bench.offBody')}</p>
      </div>
      {d.can.manage ? (
        <label className="flex items-center gap-3 text-[13px] font-bold">
          <Toggle checked={d.optedIn} label={t('bench.toggle')} onChange={async (v) => { if (v || window.confirm(t('bench.optOutConfirm'))) { if (await act.run(() => scaleApi.setBenchmarks(v))) onChange(); } }} />
          {t('bench.toggle')}
        </label>
      ) : !d.optedIn && <Badge tone="neutral">{t('bench.askHq')}</Badge>}
      <div className="w-full"><ActionError error={act.error} /></div>
      {d.optedIn && !d.metrics.some((m) => m.status === 'ok') && <div className="w-full"><Banner tone="neutral">{t('bench.waiting', { k: d.minCohort })}</Banner></div>}
      {d.can.manage && !d.optedIn && <Button size="sm" icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => scaleApi.setBenchmarks(true))) onChange(); }}>{t('bench.join')}</Button>}
    </section>
  );
}

function Privacy({ k }: { k: number }) {
  const t = useTranslations('scale');
  return (
    <SectionCard title={t('bench.privacyTitle')}>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-stone">
        <li>{t('bench.privacy1')}</li>
        <li>{t('bench.privacy2', { k })}</li>
        <li>{t('bench.privacy3')}</li>
        <li>{t('bench.privacy4')}</li>
        <li>{t('bench.privacy5')}</li>
      </ul>
    </SectionCard>
  );
}
