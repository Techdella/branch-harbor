'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, cx } from '@bh/ui';
import { DEVELOPMENT_ITEM_STATUSES } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { fdevApi, useAction, useLoad, type DevelopmentVM } from './api';
import { ActionError, StatusBadge, useFmt } from './ui';

/** Legal & compliance → Development schedules: multi-unit development agreements for area developers. */
export function DevelopmentScreen() {
  const t = useTranslations('fdev');
  const app = useApp();
  const res = useLoad(() => fdevApi.development(), [app.org.id]);
  const ov = useLoad(() => fdevApi.overview(), [app.org.id]);
  const groups = useLoad(() => fdevApi.ownerGroups(), [app.org.id]);
  const act = useAction();
  const [v, setV] = useState({ ownerGroupId: '', name: '', units: '3', start: new Date().toISOString().slice(0, 10), interval: '12' });
  const can = ov.data?.can;
  return (
    <>
      <PageHeader icon="building" title={t('development.title')} description={t('development.description')} scope={false} />
      {can?.edit && (
        <SectionCard title={t('development.new')}>
          <div className="grid gap-2 sm:grid-cols-[1.2fr_1.2fr_90px_150px_120px_auto] sm:items-end">
            <Field label={t('development.developer')}>{(x) => <Select id={x.id} value={v.ownerGroupId} onChange={(e) => setV((s) => ({ ...s, ownerGroupId: e.target.value }))}><option value="">—</option>{(groups.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}</Field>
            <Field label={t('development.name')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}</Field>
            <Field label={t('development.units')}>{(x) => <Input id={x.id} type="number" min={1} max={200} value={v.units} onChange={(e) => setV((s) => ({ ...s, units: e.target.value }))} />}</Field>
            <Field label={t('development.start')}>{(x) => <Input id={x.id} type="date" value={v.start} onChange={(e) => setV((s) => ({ ...s, start: e.target.value }))} />}</Field>
            <Field label={t('development.interval')}>{(x) => <Input id={x.id} type="number" min={1} max={60} value={v.interval} onChange={(e) => setV((s) => ({ ...s, interval: e.target.value }))} />}</Field>
            <Button icon="plus" disabled={!v.ownerGroupId || !v.name.trim() || !Number(v.units)} loading={act.pending} onClick={async () => {
              if (await act.run(() => fdevApi.createDevelopment({ ownerGroupId: v.ownerGroupId, name: v.name.trim(), unitsTotal: Number(v.units), startDate: v.start, intervalMonths: Number(v.interval) || 12 }))) { setV((s) => ({ ...s, name: '' })); res.reload(); }
            }}>{t('development.create')}</Button>
          </div>
          <p className="mt-2 text-xs text-stone">{t('development.scheduleHint')}</p>
          <ActionError error={act.error} />
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="building" title={t('development.empty')} />}>
        {(d) => <div className="flex flex-col gap-4">{d.items.map((x) => <Schedule key={x.id} x={x} canEdit={!!can?.edit} canPublish={!!can?.publish} onChanged={res.reload} today={ov.data?.today ?? ''} />)}</div>}
      </Async>
    </>
  );
}

export function Schedule({ x, canEdit, canPublish, onChanged, today }: { x: DevelopmentVM; canEdit: boolean; canPublish: boolean; onChanged: () => void; today: string }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const act = useAction();
  const p = x.progress;
  const all = x.items.flatMap((i) => [i.signByDate, i.openByDate]).filter((s): s is string => !!s).sort();
  const [min, max] = [all[0] ?? x.startDate, all[all.length - 1] ?? x.startDate];
  const span = Math.max(1, Date.parse(max) - Date.parse(x.startDate < min ? x.startDate : min));
  const pos = (d: string) => `${Math.max(0, Math.min(100, ((Date.parse(d) - Date.parse(x.startDate < min ? x.startDate : min)) / span) * 100))}%`;
  return (
    <article className="rounded-xl bg-surface p-4" data-testid="development-schedule">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span>
          <h3 className="text-[16px] font-extrabold">{x.name}</h3>
          <span className="text-xs text-stone">{[x.ownerGroupName, t('development.unitsOf', { opened: p.opened, total: p.total }), x.territories.map((tt) => tt.name).filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="flex items-center gap-2">
          {p.behind ? <Badge tone="danger" icon="alert">{t('development.behind')}</Badge> : <Badge tone="success" icon="check">{t('development.onTrack')}</Badge>}
          {p.nextDeadline && <span className="text-xs text-stone">{t('development.next', { date: f.date(p.nextDeadline) })}</span>}
        </span>
      </div>
      {/* Timeline: each unit's sign-by (hollow) and open-by (filled) deadlines, today as a line. */}
      <div className="relative mt-4 h-[calc(28px*var(--n))] rounded-md bg-canvas" style={{ ['--n' as string]: x.items.length }} role="img" aria-label={t('development.timeline')}>
        <div className="absolute inset-y-0 start-3 end-5">
        {today && <span className="absolute inset-y-0 w-0.5 bg-danger" style={{ left: pos(today) }} title={t('development.today')} />}
        {x.items.map((i, k) => (
          <span key={i.id} className="absolute flex items-center" style={{ top: 6 + k * 28, left: i.signByDate ? pos(i.signByDate) : pos(i.openByDate), width: `calc(${pos(i.openByDate)} - ${i.signByDate ? pos(i.signByDate) : pos(i.openByDate)})` }}>
            <span className={cx('h-1.5 w-full rounded-full', i.status === 'opened' ? 'bg-[#2E9E5B]' : i.overdue ? 'bg-danger' : 'bg-line')} />
            <span className={cx('absolute -end-2 h-4 w-4 rounded-full border-2 border-white', i.status === 'opened' ? 'bg-[#2E9E5B]' : i.overdue ? 'bg-danger' : 'bg-ink')} />
          </span>
        ))}
        </div>
      </div>
      <table className="mt-3 w-full text-[13px]">
        <thead><tr className="text-left text-xs text-stone">{[t('development.unit'), t('development.signBy'), t('development.openBy'), t('development.status'), t('development.location')].map((h) => <th key={h} scope="col" className="py-1.5 pe-2">{h}</th>)}</tr></thead>
        <tbody>
          {x.items.map((i) => (
            <tr key={i.id} className={cx('border-t border-line-soft', i.overdue && 'bg-[#FDECEC]')}>
              <td className="py-2 pe-2 font-bold">{i.sequence}. {i.label}{i.territoryName ? <span className="block text-xs font-normal text-stone">{i.territoryName}</span> : null}</td>
              <td className="tabular py-2 pe-2">{f.date(i.signByDate)}{i.signedOn ? <span className="block text-xs text-stone">{t('development.signedOn', { date: f.date(i.signedOn) })}</span> : null}</td>
              <td className="tabular py-2 pe-2">{f.date(i.openByDate)}{i.openedOn ? <span className="block text-xs text-stone">{t('development.openedOn', { date: f.date(i.openedOn) })}</span> : null}</td>
              <td className="py-2 pe-2">
                {canEdit ? (
                  <Select aria-label={t('development.statusOf', { unit: i.label })} className="h-9 w-36!" value={i.status} onChange={async (e) => { if (await act.run(() => fdevApi.updateDevItem(x.id, i.id, { status: e.target.value }))) onChanged(); }}>
                    {DEVELOPMENT_ITEM_STATUSES.filter((s) => canPublish || s !== 'waived' || i.status === 'waived').map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
                  </Select>
                ) : <StatusBadge status={i.status} />}
                {i.overdue && <span className="block text-xs font-bold text-danger">{t('development.overdue')}</span>}
              </td>
              <td className="py-2 pe-2">{i.locationName ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ActionError error={act.error} />
    </article>
  );
}
