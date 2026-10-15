'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Toggle, cx } from '@bh/ui';
import type { Quartiles } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadCsv, qualityApi, useQuality, useQualityAction, type LeagueRowVM, type LeagueSort, type LeagueVM } from './api';
import { ActionError, ScoreBadge, useQFmt } from './ui';

type Preset = 'last_month' | 'this_month' | 'last_quarter' | 'year' | 'custom';
const ymd = (d: Date) => d.toISOString().slice(0, 10);
function presetRange(p: Preset, now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (p) {
    case 'this_month': return { from: ymd(new Date(Date.UTC(y, m, 1))), to: ymd(now) };
    case 'last_quarter': return { from: ymd(new Date(Date.UTC(y, m - 3, 1))), to: ymd(new Date(Date.UTC(y, m, 0))) };
    case 'year': return { from: ymd(new Date(Date.UTC(y, 0, 1))), to: ymd(now) };
    default: return { from: ymd(new Date(Date.UTC(y, m - 1, 1))), to: ymd(new Date(Date.UTC(y, m, 0))) };
  }
}

/**
 * Network → League table. HQ ranks every location in scope; a franchise owner sees their own locations against
 * anonymised network quartiles (never other franchisees). Revenue is ranked per currency and never added up.
 */
export function LeagueTableScreen() {
  const t = useTranslations('quality');
  const app = useApp();
  const [preset, setPreset] = useState<Preset>('last_month');
  const [custom, setCustom] = useState(presetRange('last_month'));
  const [sort, setSort] = useState<LeagueSort>('revenue');
  const [region, setRegion] = useState('');
  const [group, setGroup] = useState('');
  const range = preset === 'custom' ? custom : presetRange(preset);
  const res = useQuality(() => qualityApi.league({ ...range, sort, regionId: region || undefined, ownerGroupId: group || undefined }), [app.org.id, range.from, range.to, sort, region, group]);
  const hq = res.data?.view === 'network';
  const groups = useQuality(() => qualityApi.ownerGroups().catch(() => ({ items: [] })), [app.org.id], hq);
  const regions = useQuality(() => qualityApi.regions().catch(() => ({ items: [] })), [app.org.id], hq);
  if (!app.hasModule('network.league_table')) return <DeniedState />;
  const sorts: LeagueSort[] = ['revenue', 'growth', 'activity', ...(res.data?.columns.occupancy ? (['occupancy'] as LeagueSort[]) : []), ...(res.data?.columns.auditScore ? (['auditScore'] as LeagueSort[]) : []), ...(res.data?.columns.royaltyStatus ? (['royaltyStatus'] as LeagueSort[]) : []), ...(res.data?.columns.reviewRating ? (['reviewRating'] as LeagueSort[]) : [])];
  return (
    <>
      <PageHeader icon="trophy" title={t('league.title')} description={hq || !res.data ? t('league.description') : t('league.descriptionOwn')} scope={false}
        actions={res.data?.can.export ? <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadCsv('/league-table/export', `league-table-${range.from}-${range.to}.csv`, { ...range, sort, regionId: region || undefined, ownerGroupId: group || undefined })}>{t('common.exportCsv')}</Button> : undefined} />
      <section className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4" aria-label={t('league.filters')}>
        <div className="w-44"><Field label={t('league.period')}>{(x) => (
          <Select id={x.id} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {(['last_month', 'this_month', 'last_quarter', 'year', 'custom'] as Preset[]).map((p) => <option key={p} value={p}>{t(`league.preset.${p}`)}</option>)}
          </Select>
        )}</Field></div>
        {preset === 'custom' && (<>
          <div className="w-40"><Field label={t('league.from')}>{(x) => <Input id={x.id} type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />}</Field></div>
          <div className="w-40"><Field label={t('league.to')}>{(x) => <Input id={x.id} type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />}</Field></div>
        </>)}
        <div className="w-48"><Field label={t('league.rankBy')}>{(x) => (
          <Select id={x.id} value={sort} onChange={(e) => setSort(e.target.value as LeagueSort)}>
            {sorts.map((s) => <option key={s} value={s}>{s === 'activity' ? t(`league.activity.${res.data?.activityKind ?? 'default'}` as 'league.activity.default') : t(`league.metric.${s}`)}</option>)}
          </Select>
        )}</Field></div>
        {hq && (regions.data?.items.length ?? 0) > 0 && <div className="w-44"><Field label={t('common.region')}>{(x) => (
          <Select id={x.id} value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {regions.data!.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        )}</Field></div>}
        {hq && (groups.data?.items.length ?? 0) > 0 && <div className="w-52"><Field label={t('common.ownerGroup')}>{(x) => (
          <Select id={x.id} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {groups.data!.items.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        )}</Field></div>}
      </section>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.rows.length} empty={<Empty icon="trophy" title={t('league.empty')} />}>
        {(d) => (
          <>
            {d.currencies.length > 1 && d.sort === 'revenue' && <Banner tone="neutral" icon="info">{t('league.perCurrency', { currencies: d.currencies.join(' · ') })}</Banner>}
            {d.view === 'own' && <Benchmarks d={d} />}
            <LeagueTable d={d} />
            {d.can.manage && <Settings d={d} onSaved={res.reload} />}
          </>
        )}
      </Async>
    </>
  );
}

function RoyaltyBadge({ s }: { s: LeagueRowVM['royaltyStatus'] }) {
  const t = useTranslations('quality');
  if (s === null) return <span className="text-stone">—</span>;
  return <Badge tone={s === 'on_time' ? 'success' : s === 'overdue' ? 'danger' : 'neutral'}>{t(`league.royalty.${s}`)}</Badge>;
}

function LeagueTable({ d }: { d: LeagueVM }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  const activity = t(`league.activity.${d.activityKind ?? 'default'}` as 'league.activity.default');
  const cols = useMemo(() => [
    { key: 'rank', header: t('league.col.rank'), render: (r: LeagueRowVM) => (r.rank ? <span className="tabular text-[18px] font-extrabold">{r.rank}<span className="text-xs font-medium text-stone">/{r.rankOf}</span></span> : '—') },
    { key: 'loc', header: t('col.location'), render: (r: LeagueRowVM) => <span><strong>{r.name}</strong><span className="block text-xs text-stone">{[r.ownerGroupName, r.regionName].filter(Boolean).join(' · ')}</span></span> },
    ...(d.columns.revenue ? [
      { key: 'rev', header: t('league.metric.revenue'), align: 'right' as const, render: (r: LeagueRowVM) => <span className={cx(d.sort === 'revenue' && 'font-extrabold')}>{f.money(r.revenueMinor, r.currency)}</span> },
      { key: 'growth', header: t('league.metric.growth'), align: 'right' as const, render: (r: LeagueRowVM) => (r.growthPct === null ? '—' : <span className={r.growthPct >= 0 ? 'text-success' : 'text-danger'}>{r.growthPct > 0 ? '+' : ''}{f.pct(r.growthPct)}</span>) },
    ] : []),
    { key: 'act', header: activity, align: 'right' as const, render: (r: LeagueRowVM) => f.num(r.activity) },
    ...(d.columns.occupancy ? [{ key: 'occ', header: t('league.metric.occupancy'), align: 'right' as const, render: (r: LeagueRowVM) => f.pct(r.occupancyPct) }] : []),
    ...(d.columns.auditScore ? [{ key: 'audit', header: t('league.metric.auditScore'), render: (r: LeagueRowVM) => <ScoreBadge score={r.auditScorePct} passed={r.auditPassed} /> }] : []),
    ...(d.columns.royaltyStatus ? [{ key: 'roy', header: t('league.metric.royaltyStatus'), render: (r: LeagueRowVM) => <RoyaltyBadge s={r.royaltyStatus} /> }] : []),
    ...(d.columns.reviewRating ? [{ key: 'rev', header: t('league.metric.reviewRating'), align: 'right' as const, render: (r: LeagueRowVM) => (r.reviewRating === null ? '—' : t('league.stars', { rating: f.num(r.reviewRating, 1), count: r.reviewCount })) }] : []),
    { key: 'q', header: t('league.col.quartile'), render: (r: LeagueRowVM) => (r.quartile ? <Badge tone={r.quartile === 1 ? 'success' : r.quartile === 4 ? 'danger' : 'neutral'}>{t(`league.quartile.${r.quartile}`)}</Badge> : '—') },
    ...(d.networkRanks ? [{ key: 'net', header: t('league.col.network'), render: (r: LeagueRowVM) => { const n = d.networkRanks?.[r.locationId]; return n ? t('league.networkPosition', { position: n.position, of: n.of }) : '—'; } }] : []),
  ], [d, t, f, activity]);
  return (
    <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="league-table">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-soft text-left">
            {cols.map((c) => <th key={c.key} scope="col" className={cx('px-3 py-3 text-xs font-extrabold uppercase tracking-[0.06em] text-stone', 'align' in c && c.align === 'right' && 'text-right')}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={r.locationId} className={cx('border-b border-line-soft last:border-0', d.sort === 'revenue' && i > 0 && d.rows[i - 1]!.currency !== r.currency && 'border-t-[3px] border-t-line')}>
              {cols.map((c) => <td key={c.key} className={cx('px-3 py-3 font-medium', 'align' in c && c.align === 'right' && 'tabular text-right')}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function QRow({ label, q, fmt, mine }: { label: string; q: Quartiles | null; fmt: (n: number) => string; mine: Array<{ name: string; value: number | null }> }) {
  const t = useTranslations('quality');
  if (!q) return (
    <li className="flex flex-wrap items-center gap-2 py-2 text-[13px]"><span className="w-40 font-bold">{label}</span><span className="text-stone">{t('league.tooFew')}</span></li>
  );
  const span = q.max - q.min || 1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - q.min) / span) * 100))}%`;
  return (
    <li className="flex flex-col gap-1.5 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2"><span className="font-bold">{label}</span><span className="text-xs text-stone">{t('league.quartiles', { q1: fmt(q.q1), median: fmt(q.median), q3: fmt(q.q3) })}</span></div>
      <div className="relative h-6" aria-hidden="true">
        <span className="absolute top-2.5 h-1 w-full rounded-full bg-canvas" />
        <span className="absolute top-1.5 h-3 rounded-full bg-line" style={{ left: pos(q.q1), width: `calc(${pos(q.q3)} - ${pos(q.q1)})` }} />
        <span className="absolute top-1 h-4 w-0.5 bg-ink" style={{ left: pos(q.median) }} />
        {mine.filter((m) => m.value !== null).map((m) => <span key={m.name} title={`${m.name}: ${fmt(m.value!)}`} className="absolute top-0.5 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-white bg-lime shadow" style={{ left: pos(m.value!) }} />)}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">{mine.map((m) => <span key={m.name}><strong>{m.name}</strong> {m.value === null ? '—' : fmt(m.value)}</span>)}</div>
    </li>
  );
}

/** For franchise owners: their locations on the network's quartiles (no other names, at least four locations). */
function Benchmarks({ d }: { d: LeagueVM }) {
  const t = useTranslations('quality');
  const f = useQFmt();
  if (!d.benchmarks) return <Banner tone="neutral" icon="info">{t('league.quartilesOff')}</Banner>;
  const b = d.benchmarks;
  return (
    <SectionCard title={t('league.benchmarksTitle')} aside={<span className="text-xs text-stone">{t('league.benchmarksNote', { count: b.locationCount })}</span>}>
      <ul className="flex flex-col divide-y divide-line-soft" data-testid="league-benchmarks">
        {b.revenue.map((r) => <QRow key={r.currency} label={t('league.revenueIn', { currency: r.currency })} q={r.quartiles} fmt={(n) => f.money(Math.round(n), r.currency)} mine={d.rows.filter((x) => x.currency === r.currency).map((x) => ({ name: x.name, value: x.revenueMinor }))} />)}
        {d.columns.revenue && <QRow label={t('league.metric.growth')} q={b.growthPct} fmt={(n) => f.pct(n)} mine={d.rows.map((x) => ({ name: x.name, value: x.growthPct }))} />}
        <QRow label={t(`league.activity.${d.activityKind ?? 'default'}` as 'league.activity.default')} q={b.activity} fmt={(n) => f.num(n)} mine={d.rows.map((x) => ({ name: x.name, value: x.activity }))} />
        {d.columns.occupancy && <QRow label={t('league.metric.occupancy')} q={b.occupancyPct} fmt={(n) => f.pct(n)} mine={d.rows.map((x) => ({ name: x.name, value: x.occupancyPct }))} />}
        {d.columns.auditScore && <QRow label={t('league.metric.auditScore')} q={b.auditScorePct} fmt={(n) => f.pct(n)} mine={d.rows.map((x) => ({ name: x.name, value: x.auditScorePct }))} />}
        {d.columns.reviewRating && <QRow label={t('league.metric.reviewRating')} q={b.reviewRating} fmt={(n) => f.num(n, 1)} mine={d.rows.map((x) => ({ name: x.name, value: x.reviewRating }))} />}
      </ul>
      {b.royaltyOnTimePct !== null && <p className="mt-2 text-xs text-stone">{t('league.onTimeNetwork', { pct: f.pct(b.royaltyOnTimePct) })}</p>}
    </SectionCard>
  );
}

function Settings({ d, onSaved }: { d: LeagueVM; onSaved: () => void }) {
  const t = useTranslations('quality');
  const act = useQualityAction();
  const [on, setOn] = useState(d.settings.franchiseeQuartiles);
  return (
    <SectionCard title={t('league.settingsTitle')}>
      <ActionError error={act.error} />
      <label className="flex items-center gap-3 text-[13px]">
        <Toggle checked={on} label={t('league.settingQuartiles')} onChange={async (v) => { setOn(v); if (await act.run(() => qualityApi.leagueSettings(v))) onSaved(); else setOn(!v); }} />
        <span><strong>{t('league.settingQuartiles')}</strong><span className="block text-xs text-stone">{t('league.settingQuartilesHint')}</span></span>
      </label>
    </SectionCard>
  );
}
