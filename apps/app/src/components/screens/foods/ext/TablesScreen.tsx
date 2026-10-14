'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@bh/ui';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtTime } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, LocationSelect, Money1, NoLocations, Section, StatusBadge, inputCls, useFx, useLocationPick } from './common';

const SITES_URL = (process.env.NEXT_PUBLIC_SITES_URL ?? 'https://sites.branchharbor.com').replace(/\/$/, '');

/** Dine-in: tables with QR codes (table code link), regenerate codes, open tabs settled at the counter. */
export function TablesScreen() {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const pick = useLocationPick();
  const lid = pick.locationId;
  const canWrite = app.can('operations.write');
  const tables = useFoods((api) => api.tables(lid), [lid], !!lid);
  const tabs = useFoods((api) => api.tabs(lid), [lid], !!lid);
  const create = useFoodsMutation((api, body: { label: string; seats: number; area?: string }) => api.createTable(lid, body));
  const update = useFoodsMutation((api, id: string, patch: { active?: boolean; regenerateCode?: boolean }) => api.updateTable(id, patch));
  const close = useFoodsMutation((api, id: string, how: 'counter' | 'void') => api.closeTab(id, how));
  const [label, setLabel] = useState('');
  const [seats, setSeats] = useState('4');
  if (!pick.loc) return <NoLocations />;
  const qrLink = (code: string) => `${SITES_URL}/t/${code}`;
  return (
    <>
      <PageHeader icon="grid" title={t('tables.title')} description={t('tables.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3"><LocationSelect pick={pick} /></div>
      <ErrorLine error={create.error ?? update.error ?? close.error} />
      <Section title={t('tables.openTabs')}>
        <Async res={tabs} loading={<LoadingBlock variant="table" rows={2} />}>
          {(list) => list.length === 0 ? <p className="text-sm text-stone">{t('tables.noTabs')}</p> : (
            <ul className="divide-y divide-line-soft">
              {list.map((tab) => (
                <li key={tab.id} className="flex flex-wrap items-center gap-3 py-3">
                  <strong>{tab.tableLabel}</strong><StatusBadge status={tab.status} />
                  <span className="text-xs text-stone">{t('tables.openedAt', { time: fmtTime(tab.openedAt, pick.loc!.timeZone, locale) })} · {t('tables.orders', { n: tab.orders.length })}{tab.guestName ? ` · ${tab.guestName}` : ''}</span>
                  <span className="ml-auto font-bold"><Money1 m={tab.amountDue} /></span>
                  {canWrite && <Button size="sm" icon="card" loading={close.pending} onClick={async () => { if (await close.run(tab.id, 'counter')) { tabs.reload(); tables.reload(); } }}>{t('tables.settle')}</Button>}
                  {canWrite && tab.orders.length === 0 && <Button size="sm" variant="ghost" onClick={async () => { if (await close.run(tab.id, 'void')) tabs.reload(); }}>{t('tables.void')}</Button>}
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Section>
      <Section title={t('tables.tables')}>
        <p className="mb-2 text-sm text-stone">{t('tables.qrHint')}</p>
        <Async res={tables} loading={<LoadingBlock variant="table" rows={3} />}>
          {(list) => (
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr))]">
              {list.map((tb) => (
                <article key={tb.id} className="flex flex-col gap-1.5 rounded-lg bg-canvas p-3 text-sm">
                  <div className="flex items-center justify-between"><strong>{tb.label}</strong>{tb.openTabId ? <StatusBadge status="open" label={t('tables.tabOpen')} /> : !tb.active ? <StatusBadge status="closed" label={t('tables.inactive')} /> : null}</div>
                  <span className="text-xs text-stone">{t('tables.seats', { n: tb.seats })}{tb.area ? ` · ${tb.area}` : ''}</span>
                  <span className="font-mono text-base font-bold tracking-wider">{tb.code}</span>
                  <a className="break-all text-xs font-semibold underline" href={qrLink(tb.code)} target="_blank" rel="noreferrer">{qrLink(tb.code)}</a>
                  {canWrite && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={async () => { if (window.confirm(t('tables.regenConfirm'))) { await update.run(tb.id, { regenerateCode: true }); tables.reload(); } }}>{t('tables.regenerate')}</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await update.run(tb.id, { active: !tb.active }); tables.reload(); }}>{tb.active ? t('tables.deactivate') : t('tables.activate')}</Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </Async>
        {canWrite && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await create.run({ label, seats: Number(seats) || 2 })) { setLabel(''); tables.reload(); } }}>
            <Labeled label={t('tables.label')}><input required value={label} onChange={(e) => setLabel(e.target.value)} className={inputCls} /></Labeled>
            <Labeled label={t('tables.seatsLabel')}><input inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} className={inputCls} /></Labeled>
            <Button type="submit" icon="plus" loading={create.pending}>{t('tables.add')}</Button>
          </form>
        )}
      </Section>
    </>
  );
}
