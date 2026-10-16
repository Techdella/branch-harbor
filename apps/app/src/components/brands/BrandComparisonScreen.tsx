'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Badge } from '@bh/ui';
import { brandsApi, type BrandComparison, type CurrencyRevenue } from '@/lib/http/brands';
import { ApiError } from '@/lib/errors';
import { money } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { BrandMark } from './BrandsScreen';

/**
 * Network summary across brands and the brand comparison. Revenue is always shown per currency: amounts in different
 * currencies are never added together.
 */
export function BrandComparisonScreen() {
  const t = useTranslations('brands');
  const app = useApp();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<BrandComparison | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    brandsApi.comparison(app.org.id, days).then((d) => live && setData(d)).catch((e) => live && setError(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))));
    return () => {
      live = false;
    };
  }, [app.org.id, days]);
  if (!app.orgMultiBrand) return <DeniedState detail={t('compare.singleBrand')} />;
  return (
    <>
      <PageHeader
        icon="chart"
        title={t('compare.title')}
        description={t('compare.description')}
        scope={false}
        actions={
          <label className="flex items-center gap-2 text-sm font-semibold">
            {t('compare.period')}
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-10 rounded-full border border-line bg-surface px-3 text-sm font-semibold">
              {[7, 30, 90, 365].map((d) => (
                <option key={d} value={d}>
                  {t('compare.days', { count: d })}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {error && (error.isForbidden ? <DeniedState detail={error.message} /> : <Banner tone="danger" live="assertive">{error.message}</Banner>)}
      {!data && !error && <LoadingBlock variant="cards" />}
      {data && <Comparison data={data} />}
    </>
  );
}

function RevenueList({ items }: { items: CurrencyRevenue[] | null }) {
  const t = useTranslations('brands');
  const locale = useLocale();
  if (items === null) return <span className="text-sm text-stone">{t('compare.noFinance')}</span>;
  if (!items.length) return <span className="text-sm text-stone">{t('compare.noRevenue')}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((r) => (
        <li key={r.currency} className="text-sm font-bold tabular-nums">
          {money({ amount: r.netMinor, currency: r.currency }, locale)} <span className="text-xs font-semibold text-stone">{r.currency}</span>
        </li>
      ))}
    </ul>
  );
}

function Comparison({ data }: { data: BrandComparison }) {
  const t = useTranslations('brands');
  const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  const n = data.network;
  return (
    <>
      <SectionCard title={t('compare.network')} aside={<span className="text-xs text-stone">{t('compare.neverSummed')}</span>}>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="network-summary">
          <Stat label={t('compare.brands')} value={String(n.brands)} />
          <Stat label={t('compare.locations')} value={t('compare.locationsValue', { total: n.locations, operating: n.operating })} />
          <div className="rounded-lg bg-canvas p-4">
            <dt className="text-xs font-bold uppercase tracking-[0.06em] text-stone">{t('compare.revenue')}</dt>
            <dd className="mt-1"><RevenueList items={n.revenueByCurrency} /></dd>
          </div>
          {n.openProspects !== null && <Stat label={t('compare.openProspects')} value={String(n.openProspects)} />}
        </dl>
      </SectionCard>
      <SectionCard title={t('compare.byBrand')}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="brand-comparison">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-[0.06em] text-stone">
                <th scope="col" className="py-2 pr-3">{t('compare.brand')}</th>
                <th scope="col" className="py-2 pr-3">{t('compare.locations')}</th>
                <th scope="col" className="py-2 pr-3">{t('compare.revenue')}</th>
                <th scope="col" className="py-2 pr-3">{t('compare.pipeline')}</th>
                <th scope="col" className="py-2 pr-3">{t('compare.terms')}</th>
              </tr>
            </thead>
            <tbody>
              {data.brands.map((b) => (
                <tr key={b.id} className="border-b border-line-soft align-top">
                  <th scope="row" className="py-3 pr-3">
                    <span className="flex items-center gap-2.5">
                      <BrandMark brand={{ name: b.name, logoUrl: b.logoUrl, primaryColor: b.primaryColor, accentColor: null }} size={32} />
                      <span>
                        <span className="block font-bold">{b.name}</span>
                        {b.isDefault && <Badge tone="neutral">{t('settings.main')}</Badge>}
                      </span>
                    </span>
                  </th>
                  <td className="py-3 pr-3">
                    <span className="block font-bold">{t('compare.locationsValue', { total: b.locations.total, operating: b.locations.operating })}</span>
                    {b.locations.opening > 0 && <span className="block text-xs text-stone">{t('compare.opening', { count: b.locations.opening })}</span>}
                    {b.currencies.length > 0 && <span className="block text-xs text-stone">{b.currencies.join(', ')}</span>}
                  </td>
                  <td className="py-3 pr-3"><RevenueList items={b.revenue} /></td>
                  <td className="py-3 pr-3">
                    {b.pipeline ? (
                      <>
                        <span className="block">{t('compare.openCount', { count: b.pipeline.open })}</span>
                        <span className="block text-xs text-stone">{t('compare.signedCount', { count: b.pipeline.signed })} · {t('compare.territories', { count: b.pipeline.availableTerritories })}</span>
                      </>
                    ) : (
                      <span className="text-stone">{t('compare.hidden')}</span>
                    )}
                  </td>
                  <td className="py-3 pr-3">
                    {b.terms === null ? (
                      <span className="text-stone">{t('compare.hidden')}</span>
                    ) : b.terms.length ? (
                      <ul className="flex flex-col gap-0.5">
                        {b.terms.map((x) => (
                          <li key={x.currency}>
                            {t('franchise.rate', { currency: x.currency, royalty: pct(x.royaltyBps), fund: pct(x.marketingFundBps) })}
                            {x.source === 'organization' && <span className="text-xs text-stone"> · {t('compare.networkDefault')}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-stone">{t('compare.noTerms')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-canvas p-4">
      <dt className="text-xs font-bold uppercase tracking-[0.06em] text-stone">{label}</dt>
      <dd className="mt-1 text-xl font-extrabold tabular-nums">{value}</dd>
    </div>
  );
}
