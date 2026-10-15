'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import type { Report } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { fmtNumber } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { useTxt } from '../ui/useDataText';

function fmt(r: Report, v: number, locale: string) {
  if (r.unit === 'percent') return `${v}%`;
  if (r.unit === 'money' && r.currency) return new Intl.NumberFormat(locale, { style: 'currency', currency: r.currency, notation: 'compact', maximumFractionDigits: 1 }).format(v / 100);
  return fmtNumber(v, locale);
}

export function ReportsScreen() {
  const t = useTranslations('reports');
  const tt = useTxt();
  const locale = useLocale();
  const app = useApp();
  const scopeLabel = useScopeLabel();
  // Independent businesses: one location, so each report is a single figure rather than a per-location chart.
  const independent = app.org.model === 'independent';
  const res = useApi((api) => api.reports(app.ctx), [app.industry, app.role, app.scopeId], app.can('reports.read'));
  if (!app.can('reports.read')) return <DeniedState permission="reports.read" />;
  return (
    <>
      <PageHeader icon="chart" title={t('title')} description={t('description')} />
      <Async res={res} permission="reports.read" loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="chart" title={t('empty')} />}>
        {(reports) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
            {reports.map((r) => {
              const vals = r.bars.map((b) => b.value).filter((v): v is number => v != null);
              const max = Math.max(1, ...vals);
              const color = r.unit === 'money' ? '#D6F26B' : r.unit === 'percent' ? '#E9DDF8' : '#141414';
              return (
                <section key={r.id} className="flex flex-col gap-3 rounded-xl bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-bold">{tt(r.title, r.titleMsg)}</h2>
                    <span className={r.stale ? 'flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-bold text-warning' : 'flex items-center gap-1 text-[11px] text-stone'}>
                      <Icon name={r.stale ? 'alert' : 'clock'} size={11} />
                      {tt(r.freshness, r.freshnessMsg)}
                    </span>
                  </div>
                  {independent && r.bars.length === 1 ? (
                    <div className="flex h-[150px] flex-col justify-center gap-1 rounded-lg bg-canvas px-5" data-testid="report-total">
                      <span className="tabular text-[34px] font-extrabold tracking-[-0.02em]">{r.bars[0]!.value == null ? t('unavailable') : fmt(r, r.bars[0]!.value, locale)}</span>
                    </div>
                  ) : r.bars.length > 0 ? (
                    <figure>
                      <div className="flex h-[150px] items-end gap-2" role="img" aria-label={t('chartLabel', { title: tt(r.title, r.titleMsg), values: r.bars.map((b) => `${b.label}: ${b.value == null ? t('unavailable') : fmt(r, b.value, locale)}`).join('; ') })}>
                        {r.bars.map((b) => (
                          <div key={b.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                            <span className="tabular text-[10px] font-bold">{b.value == null ? t('na') : fmt(r, b.value, locale)}</span>
                            <div className="w-full rounded-[10px]" style={{ height: b.value == null ? 6 : `${Math.max(8, Math.round((b.value / max) * 110))}px`, background: b.value == null ? '#F3F2EE' : color, border: b.value == null ? '1px dashed #D8D6CF' : undefined }} />
                            <span className="max-w-full truncate text-[10px] text-stone">{b.label}</span>
                          </div>
                        ))}
                      </div>
                    </figure>
                  ) : (
                    <div className="flex h-[150px] flex-col items-center justify-center gap-1 rounded-lg bg-canvas text-center">
                      <strong className="text-lg">{t('notShown')}</strong>
                    </div>
                  )}
                  <p className="text-[11px] leading-normal text-stone">{tt(r.note, r.noteMsg)}</p>
                </section>
              );
            })}
          </div>
        )}
      </Async>
      <p className="text-xs text-stone">{t('scopeNote', { scope: scopeLabel })}</p>
    </>
  );
}
