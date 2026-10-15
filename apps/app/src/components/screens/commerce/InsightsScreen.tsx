'use client';

import { useState } from 'react';
import { Icon, Tabs } from '@bh/ui';
import { cx as call, useCommerce } from '@/lib/commerce/client';
import type { Report, Suggestion } from '@/lib/commerce/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, DeniedState, SectionCard } from '../../ui/States';
import { Money, MoneyList, View, useCt } from './kit';

/** Commerce reports (per currency, never combined) and AI merchandising suggestions with cited records. */
export function InsightsScreen() {
  const t = useCt();
  const app = useApp();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const from = new Date(Date.now() - Number(days) * 86400_000).toISOString();
  const res = useCommerce(() => call<Report>('GET', '/reports', undefined, { from }), [days, app.org.id, app.apiMode], app.can('reports.read'));
  const merch = useCommerce(() => call<{ suggestions: Suggestion[]; narrative: string | null; aiAvailable: boolean; method: string }>('GET', '/ai/merchandising', undefined, { days }), [days, app.org.id, app.apiMode], app.can('ai.use'));
  if (!app.can('reports.read')) return <DeniedState permission="reports.read" />;
  const ids = app.scope.locationIds;
  const inScope = <T extends { locationId: string }>(rows: T[]) => rows.filter((r) => !ids.length || ids.includes(r.locationId));
  const pct = (n: number | null) => (n === null ? t('common.unavailable') : `${Math.round(n * 1000) / 10}%`);
  return (
    <>
      <PageHeader icon="chart" title={t('insights.title')} description={t('insights.description')} actions={<Tabs value={days} onChange={setDays} items={(['7', '30', '90'] as const).map((d) => ({ key: d, label: t('insights.days', { n: d }) }))} />} />
      <View res={res}>
        {(r) => (
          <div className="flex flex-col gap-4">
            <SectionCard title={t('insights.sales')}>
              <Banner tone="neutral" icon="info">{r.combinedRevenueReason}</Banner>
              <div className="my-3 grid gap-3 md:grid-cols-3">
                {r.totalsByCurrency.map((c) => (
                  <div key={c.currency} className="rounded-lg bg-canvas-raised p-4">
                    <div className="text-xs font-bold text-stone">{c.currency} · {t('insights.orders', { n: c.orders })}</div>
                    <Money m={c.net} className="text-xl font-bold" />
                    <div className="text-xs text-stone">{t('insights.grossRefunds')} <Money m={c.gross} /> / <Money m={c.refunds} /></div>
                  </div>
                ))}
              </div>
              <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm">
                <thead><tr className="border-b border-line-soft text-left text-xs uppercase text-stone"><th className="py-2">{t('common.store')}</th><th className="py-2 text-right">{t('insights.ordersCol')}</th><th className="py-2 text-right">{t('insights.net')}</th><th className="hidden py-2 text-right md:table-cell">{t('insights.avg')}</th></tr></thead>
                <tbody>{inScope(r.salesByLocation).map((s) => <tr key={s.locationId} className="border-b border-line-soft"><td className="py-2 font-semibold">{s.locationName}</td><td className="py-2 text-right">{s.orders}</td><td className="py-2 text-right"><Money m={s.net} /></td><td className="hidden py-2 text-right md:table-cell"><Money m={s.averageOrder} /></td></tr>)}</tbody>
              </table></div>
              <p className="mt-2 text-xs text-stone">{r.sources.map((s) => `${s.source}: ${s.note}`).join(' · ')}</p>
            </SectionCard>
            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard title={t('insights.top')}>
                <ol className="flex flex-col gap-1.5 text-sm">{r.topProducts.map((p, i) => <li key={p.name} className="flex flex-wrap items-center gap-2"><span className="w-5 text-stone">{i + 1}.</span><span className="flex-1 font-semibold">{p.name}</span><span className="text-xs text-stone">{t('insights.units', { n: p.units })}</span><MoneyList values={p.revenueByCurrency} /></li>)}</ol>
              </SectionCard>
              <SectionCard title={t('insights.turnover')}>
                <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-stone"><th className="py-1">{t('common.store')}</th><th className="py-1 text-right">{t('insights.sold')}</th><th className="py-1 text-right">{t('insights.turnoverCol')}</th><th className="py-1 text-right">{t('insights.cover')}</th></tr></thead>
                  <tbody>{inScope(r.stockTurnover).map((s) => <tr key={s.locationId} className="border-t border-line-soft"><td className="py-2">{s.locationName}</td><td className="py-2 text-right">{s.unitsSold}</td><td className="py-2 text-right" title={s.turnoverUnavailableReason ?? undefined}>{s.turnover ?? t('common.unavailable')}</td><td className="py-2 text-right">{s.daysOfCover ?? t('common.unavailable')}</td></tr>)}</tbody></table></div>
              </SectionCard>
              <SectionCard title={t('insights.drift')}>
                <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-stone"><th className="py-1">{t('common.store')}</th><th className="py-1 text-right">{t('insights.countVar')}</th><th className="py-1 text-right">{t('insights.writeOffs')}</th><th className="py-1 text-right">{t('insights.transitLoss')}</th><th className="py-1 text-right">{t('insights.mismatch')}</th></tr></thead>
                  <tbody>{inScope(r.inventoryDrift).map((s) => <tr key={s.locationId} className="border-t border-line-soft"><td className="py-2">{s.locationName}</td><td className="py-2 text-right">{s.countVarianceUnits}</td><td className="py-2 text-right">{s.writeOffUnits}</td><td className="py-2 text-right">{s.transitLossUnits}</td><td className="py-2 text-right">{s.ledgerMismatches ? <span className="font-bold text-danger">{s.ledgerMismatches}</span> : 0}</td></tr>)}</tbody></table></div>
              </SectionCard>
              <SectionCard title={t('insights.returns')}>
                <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-stone"><th className="py-1">{t('common.store')}</th><th className="py-1 text-right">{t('insights.returnsCol')}</th><th className="py-1 text-right">{t('insights.rate')}</th></tr></thead>
                  <tbody>{inScope(r.returnsRate).map((s) => <tr key={s.locationId} className="border-t border-line-soft"><td className="py-2">{s.locationName}</td><td className="py-2 text-right">{s.returnedUnits}/{s.unitsSold}</td><td className="py-2 text-right" title={s.rateUnavailableReason ?? undefined}>{pct(s.rate)}</td></tr>)}</tbody></table></div>
              </SectionCard>
            </div>
          </div>
        )}
      </View>
      {app.can('ai.use') && (
        <SectionCard title={<span className="flex items-center gap-2"><Icon name="sparkles" size={18} />{t('insights.merch')}</span>}>
          <View res={merch}>
            {(m) => (
              <div className="flex flex-col gap-2 text-sm">
                {m.narrative ? <p className="rounded-md bg-canvas-raised p-3">{m.narrative}</p> : <p className="text-xs text-stone">{m.aiAvailable ? '' : t('insights.aiOff')}</p>}
                <p className="text-xs text-stone">{m.method}</p>
                {!m.suggestions.length && <p className="text-stone">{t('insights.noSuggestions')}</p>}
                {m.suggestions.filter((s) => !s.locationId || !ids.length || ids.includes(s.locationId)).map((s, i) => (
                  <div key={i} className="rounded-md border border-line-soft p-3">
                    <div className="font-bold">{s.title}</div>
                    <div>{s.detail}</div>
                    <ul className="mt-1 text-xs text-stone">{s.citations.map((c) => <li key={c.id}>↳ {c.label}</li>)}</ul>
                  </div>
                ))}
              </div>
            )}
          </View>
        </SectionCard>
      )}
    </>
  );
}
