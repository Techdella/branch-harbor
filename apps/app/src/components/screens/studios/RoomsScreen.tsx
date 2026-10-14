'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { Room } from '@/lib/studios/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, StudioAsync, inputCls } from './shared';

export function RoomsScreen() {
  const t = useTranslations('studiosFull.rooms');
  const app = useApp();
  const locs = app.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const res = useStudio((api) => api.rooms(), [app.role, app.scopeId]);
  const canWrite = app.can('operations.write');
  const [form, setForm] = useState({ locationId: locs[0]?.id ?? '', name: '', capacity: '16', features: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const create = useStudioMutation((api) => api.createRoom({ locationId: form.locationId, name: form.name.trim(), capacity: Number(form.capacity), features: form.features.split(',').map((x) => x.trim()).filter(Boolean) }));
  const update = useStudioMutation((api, id: string, patch: Partial<Room>) => api.updateRoom(id, patch));
  const nameError = form.name.trim() ? undefined : t('nameRequired');

  return (
    <>
      <PageHeader icon="room" title={t('title')} description={t('description')} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <div className="grid items-start gap-3 lg:grid-cols-[1.6fr_1fr]">
        <StudioAsync res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="room" title={t('emptyTitle')} body={t('emptyBody')} />}>
          {(rooms) => (
            <div className="flex flex-col gap-3">
              {locs.map((l) => {
                const list = rooms.filter((r) => r.locationId === l.id);
                return (
                  <section key={l.id} className="rounded-xl bg-surface p-4">
                    <h2 className="mb-2 text-sm font-bold">{l.name} <span className="font-medium text-stone">· {l.timeZone}</span></h2>
                    {list.length === 0 ? <p className="text-sm text-stone">{t('none')}</p> : (
                      <ul className="flex flex-col gap-1.5">
                        {list.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
                            <strong className="min-w-28">{r.name}</strong>
                            <span className="tabular">{t('capacityN', { n: r.capacity })}</span>
                            <span className="flex-1 text-xs text-stone">{r.features.join(' · ')}</span>
                            <span className="text-xs">{t('upcomingN', { n: r.upcomingClasses })}</span>
                            <Badge tone={r.active ? 'success' : 'neutral'} icon={r.active ? 'check-circle' : 'x'}>{r.active ? t('active') : t('inactive')}</Badge>
                            {canWrite && <Button size="sm" variant="ghost" onClick={async () => { if (await update.run(r.id, { active: !r.active })) res.reload(); }}>{r.active ? t('deactivate') : t('activate')}</Button>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
              <ErrorLine message={update.error?.message} />
            </div>
          )}
        </StudioAsync>
        {canWrite && (
          <form className="flex flex-col gap-3 rounded-xl bg-surface p-5" onSubmit={async (e) => { e.preventDefault(); if (nameError) return; const r = await create.run(); if (r) { setMsg(t('created', { name: r.name })); setForm((f) => ({ ...f, name: '', features: '' })); res.reload(); } }}>
            <h2 className="text-base font-bold">{t('add')}</h2>
            <Labeled label={t('location')}><select className={inputCls} value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Labeled>
            <Labeled label={t('name')} error={create.error?.fields?.name}><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Labeled>
            <Labeled label={t('capacity')}><input type="number" min={1} className={inputCls} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></Labeled>
            <Labeled label={t('features')} hint={t('featuresHint')}><input className={inputCls} value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} /></Labeled>
            <Button type="submit" icon="plus" disabled={create.pending || !!nameError}>{t('add')}</Button>
            <ErrorLine message={create.error?.message} />
          </form>
        )}
      </div>
    </>
  );
}
