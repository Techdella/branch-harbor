'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { OnlineInput, OnlineItem } from '@/lib/studios/types';
import { fmtDateTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, StudioAsync, fmtMoney, inputCls, toMinor } from './shared';

/** Online classes: livestreams and the recordings library with access permissions. Join links are revealed only to entitled, registered customers. */
export function OnlineScreen() {
  const t = useTranslations('studiosFull.online');
  const locale = useLocale();
  const app = useApp();
  const [tab, setTab] = useState<'livestream' | 'on_demand'>('livestream');
  const [open, setOpen] = useState<OnlineItem | null>(null);
  const [showUrl, setShowUrl] = useState<string | null>(null);
  const res = useStudio((api) => api.online(), [app.role]);
  const toggle = useStudioMutation((api, id: string, status: 'draft' | 'published') => api.updateOnline(id, { status }));
  const canWrite = app.can('operations.write');
  return (
    <>
      <PageHeader icon="play" title={t('title')} description={t('description')} actions={<Tabs items={[{ key: 'livestream', label: t('livestreams') }, { key: 'on_demand', label: t('library') }]} value={tab} onChange={(k) => setTab(k as typeof tab)} />} />
      <Banner tone="info" icon="lock">{t('privacyNote')}</Banner>
      <div className="grid items-start gap-3 xl:grid-cols-[1.6fr_1fr]">
        <section className="rounded-xl bg-surface p-4">
          <StudioAsync res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.some((x) => x.kind === tab)} empty={<Empty icon="play" title={t('emptyTitle')} body={t('emptyBody')} />}>
            {(rows) => (
              <ul className="flex flex-col gap-2">
                {rows.filter((x) => x.kind === tab).map((c) => (
                  <li key={c.id} className="flex flex-col gap-1.5 rounded-md bg-canvas-raised px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon name={c.kind === 'livestream' ? 'video' : 'play'} size={16} />
                      <strong>{c.title}</strong>
                      <Badge tone={c.status === 'published' ? 'success' : 'neutral'} icon={c.status === 'published' ? 'check-circle' : 'edit'}>{t(`status.${c.status}`)}</Badge>
                      <span className="ml-auto text-xs">{t('registrationsN', { n: c.registrations ?? 0 })}</span>
                    </div>
                    <div className="text-xs text-graphite">{[c.instructorName, c.locationName ?? t('network'), c.startsAt ? fmtDateTime(c.startsAt, app.locations.find((l) => l.id === c.locationId)?.timeZone ?? 'UTC', locale) : null, c.durationMinutes ? t('minutes', { n: c.durationMinutes }) : null, t(`provider.${c.provider}`)].filter(Boolean).join(' · ')}</div>
                    <div className="flex flex-wrap gap-1.5">{c.rules.map((r) => <Badge key={r} tone="info">{r}</Badge>)}{Object.entries(c.prices).map(([cur, a]) => <Badge key={cur} tone="neutral">{fmtMoney(a, cur, locale)}</Badge>)}</div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {c.providerUrl && (showUrl === c.id ? <code className="rounded bg-canvas px-2 py-0.5">{c.providerUrl}</code> : <Button size="sm" variant="ghost" icon="eye" onClick={() => setShowUrl(c.id)}>{t('revealLink')}</Button>)}
                      <Button size="sm" variant="ghost" icon="users" onClick={() => setOpen(c)}>{t('registrations')}</Button>
                      {canWrite && <Button size="sm" variant="ghost" onClick={async () => { if (await toggle.run(c.id, c.status === 'published' ? 'draft' : 'published')) res.reload(); }}>{c.status === 'published' ? t('unpublish') : t('publish')}</Button>}
                    </div>
                  </li>
                ))}
                <ErrorLine message={toggle.error?.message} />
              </ul>
            )}
          </StudioAsync>
        </section>
        {canWrite && <OnlineForm kind={tab} onDone={() => res.reload()} />}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} kicker={t('registrations')} title={open?.title ?? ''}>
        {open && <Registrations id={open.id} />}
      </Drawer>
    </>
  );
}

function Registrations({ id }: { id: string }) {
  const t = useTranslations('studiosFull.online');
  const res = useStudio((api) => api.registrations(id), [id]);
  return (
    <StudioAsync res={res} loading={<LoadingBlock variant="table" rows={4} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="users" title={t('noRegistrations')} />}>
      {(rows) => <ul className="text-sm">{rows.map((r, i) => <li key={i} className="flex gap-2 border-b border-canvas py-1.5"><strong className="flex-1">{r.customer}</strong><span className="text-xs">{t(`basis.${r.basis}`)}</span><span className="text-xs text-stone">{r.joinedAt ? t('joined') : t('notJoined')}</span></li>)}</ul>}
    </StudioAsync>
  );
}

function OnlineForm({ kind, onDone }: { kind: 'livestream' | 'on_demand'; onDone: () => void }) {
  const t = useTranslations('studiosFull.online');
  const app = useApp();
  const [f, setF] = useState({ title: '', description: '', locationId: '', provider: 'zoom', url: '', startsAt: '', duration: '60', members: true, packs: false, free: false, price: '', publish: true });
  const [ok, setOk] = useState<string | null>(null);
  const loc = app.locations.find((l) => l.id === f.locationId);
  const currency = loc?.currency ?? app.org.defaultCurrency;
  const save = useStudioMutation((api) => {
    const minor = f.price ? toMinor(f.price, currency) : null;
    const input: OnlineInput = { kind, title: f.title.trim(), description: f.description || undefined, locationId: f.locationId || null, provider: f.provider, providerUrl: f.url.trim(), startsAt: kind === 'livestream' && f.startsAt ? new Date(f.startsAt).toISOString() : null, durationMinutes: Number(f.duration) || null, allowMembers: f.members, allowPackHolders: f.packs, allowFree: f.free, prices: minor ? { [currency]: minor } : {}, status: f.publish ? 'published' : 'draft' };
    return api.createOnline(input);
  });
  return (
    <form className="flex flex-col gap-3 rounded-xl bg-surface p-5" onSubmit={async (e) => { e.preventDefault(); if (await save.run()) { setOk(t('saved')); setF((x) => ({ ...x, title: '', url: '', description: '' })); onDone(); } }}>
      <h2 className="text-base font-bold">{kind === 'livestream' ? t('newLivestream') : t('newRecording')}</h2>
      <Labeled label={t('titleLabel')}><input required className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Labeled>
      <Labeled label={t('descriptionLabel')}><input className={inputCls} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Labeled>
      <Labeled label={t('where')}><select className={inputCls} value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">{t('network')}</option>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Labeled>
      <div className="grid grid-cols-2 gap-3">
        <Labeled label={t('providerLabel')}><select className={inputCls} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{['zoom', 'youtube', 'vimeo', 'other'].map((p) => <option key={p} value={p}>{t(`provider.${p}`)}</option>)}</select></Labeled>
        <Labeled label={t('duration')}><input type="number" min={1} className={inputCls} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} /></Labeled>
      </div>
      <Labeled label={t('url')} hint={t('urlHint')} error={save.error?.fields?.providerUrl}><input required type="url" className={inputCls} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Labeled>
      {kind === 'livestream' && <Labeled label={t('startsAt')} hint={t('startsHint')} error={save.error?.fields?.startsAt}><input type="datetime-local" className={inputCls} value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Labeled>}
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1 text-[13px] font-bold">{t('access')}</legend>
        {(['members', 'packs', 'free'] as const).map((k) => <label key={k} className="flex items-center gap-2 font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />{t(`allow.${k}`)}</label>)}
      </fieldset>
      <Labeled label={t('price', { currency })} hint={t('priceHint')}><input inputMode="decimal" className={inputCls} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Labeled>
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={f.publish} onChange={(e) => setF({ ...f, publish: e.target.checked })} />{t('publishNow')}</label>
      <Button type="submit" icon="plus" disabled={save.pending}>{t('add')}</Button>
      <ErrorLine message={save.error?.message} />
      {ok && <Banner tone="success" live="polite">{ok}</Banner>}
    </form>
  );
}
