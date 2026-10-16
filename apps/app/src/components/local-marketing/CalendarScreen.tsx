'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Textarea, cx } from '@bh/ui';
import { SOCIAL_NETWORKS, SOCIAL_TEMPLATE_TOKENS } from '@bh/shared';
import { addDays, dateInZone, fmtYmd, weekStart } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { NotAvailable } from '../screens/NotAvailable';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { calendarApi, type CalendarItemVM } from './api';
import { LabeledToggle } from './ui';

const M = 'marketing.social';

/**
 * Local social content calendar: HQ publishes approved posts; each location localises one with a click (its name,
 * city, phone and booking link fill the template) and schedules it on its own connected accounts. Publishing then
 * goes through the usual social dispatcher (sandbox until an account is connected through OAuth).
 */
export function CalendarScreen() {
  const t = useTranslations('lmk.calendar');
  const app = useApp();
  const locale = useLocale();
  const [weekOf, setWeekOf] = useState(() => weekStart(dateInZone(new Date(), app.org.defaultTimeZone)));
  const from = `${weekOf}T00:00:00Z`;
  const to = `${addDays(weekOf, 28)}T00:00:00Z`;
  const res = useApi(() => calendarApi.list({ from, to }), [app.org.id, weekOf], app.hasModule(M));
  const [open, setOpen] = useState<CalendarItemVM | null>(null);
  const [creating, setCreating] = useState(false);
  if (!app.hasModule(M)) return <NotAvailable />;
  const days = Array.from({ length: 28 }, (_, i) => addDays(weekOf, i));
  return (
    <>
      <PageHeader icon="calendar" title={t('title')} description={t('description')} actions={res.data?.canManage ? <Button icon="plus" onClick={() => setCreating(true)}>{t('newPost')}</Button> : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon="chevron-left" aria-label={t('previous')} onClick={() => setWeekOf(addDays(weekOf, -7))} />
        <span className="text-sm font-semibold">{fmtYmd(weekOf, locale, { day: 'numeric', month: 'long' })} – {fmtYmd(addDays(weekOf, 27), locale, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        <Button size="sm" variant="secondary" icon="chevron-right" aria-label={t('next')} onClick={() => setWeekOf(addDays(weekOf, 7))} />
      </div>
      <Async res={res} loading={<LoadingBlock variant="calendar" />}>
        {(d) => (
          <>
            {!d.items.length && <Empty icon="calendar" title={t('empty')} body={d.canManage ? t('emptyHq') : t('emptyLocal')} />}
            <ol className="grid gap-2 md:grid-cols-7" aria-label={t('calendarLabel')} data-testid="social-calendar">
              {days.map((day) => {
                const items = d.items.filter((i) => dateInZone(new Date(i.suggestedAt), app.org.defaultTimeZone) === day);
                return (
                  <li key={day} className={cx('min-h-[110px] rounded-xl bg-surface p-2', !items.length && 'max-md:hidden')}>
                    <div className="text-xs font-bold text-stone">{fmtYmd(day, locale, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                    <ul className="mt-1 flex flex-col gap-1.5">
                      {items.map((i) => (
                        <li key={i.id}>
                          <button type="button" onClick={() => setOpen(i)} className="w-full rounded-lg bg-canvas p-2 text-left text-xs hover:shadow-card">
                            <span className="block font-bold">{i.title}</span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              {i.status !== 'published' && <Badge tone="warning">{t(`status.${i.status}`)}</Badge>}
                              {d.canManage ? <Badge tone="info">{t('adopted', { n: i.adoptions.filter((a) => a.status === 'scheduled').length })}</Badge> : <AdoptionBadge item={i} />}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </Async>
      <ItemDrawer item={open} canManage={!!res.data?.canManage} onClose={() => setOpen(null)} onChanged={() => { res.reload(); }} />
      <NewItemDrawer open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); res.reload(); }} />
    </>
  );
}

function AdoptionBadge({ item }: { item: CalendarItemVM }) {
  const t = useTranslations('lmk.calendar');
  const a = item.adoptions[0];
  if (!a) return <Badge>{t('notScheduled')}</Badge>;
  return a.status === 'skipped' ? <Badge>{t('skipped')}</Badge> : <Badge tone="success" icon="check">{t(`postStatus.${a.postStatus ?? 'scheduled'}`)}</Badge>;
}

function ItemDrawer({ item, canManage, onClose, onChanged }: { item: CalendarItemVM | null; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('lmk.calendar');
  const app = useApp();
  const locale = useLocale();
  const [locationId, setLocationId] = useState('');
  const loc = locationId || app.locations[0]?.id || '';
  const preview = useApi(() => (item && loc ? calendarApi.preview(item.id, loc) : Promise.resolve(null)), [item?.id, loc], !!item && !!loc && item.status === 'published');
  const [body, setBody] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const adopt = useMutation(() => calendarApi.adopt(item!.id, { locationId: loc, accountIds: picked ?? undefined, body: body ?? undefined }));
  const skip = useMutation(() => calendarApi.skip(item!.id, loc));
  const status = useMutation((_a, s: 'published' | 'archived' | 'draft') => calendarApi.setStatus(item!.id, s));
  const [done, setDone] = useState<string | null>(null);
  const names = useMemo(() => new Map(app.locations.map((l) => [l.id, l.name])), [app.locations]);
  const adoption = item?.adoptions.find((a) => a.locationId === loc);
  return (
    <Drawer open={!!item} onClose={() => { setDone(null); setBody(null); setPicked(null); onClose(); }} title={item?.title ?? ''} kicker={item ? fmtYmd(item.suggestedAt.slice(0, 10), locale, { weekday: 'long', day: 'numeric', month: 'long' }) : ''}>
      {item && (
        <div className="flex flex-col gap-4" data-testid="calendar-item">
          <div className="flex flex-wrap gap-1.5">{item.networks.map((n) => <Badge key={n}>{t(`network.${n}`)}</Badge>)}{item.allowEdits ? <Badge tone="info">{t('editsAllowed')}</Badge> : <Badge icon="lock">{t('textLocked')}</Badge>}</div>
          <SectionCard title={t('template')}><p className="whitespace-pre-wrap text-sm">{item.body}</p></SectionCard>
          {canManage && (
            <SectionCard title={t('networkTitle')}>
              <p className="text-sm">{t('adoptedBy', { n: item.adoptions.filter((a) => a.status === 'scheduled').length, total: app.locations.length })}</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">{item.adoptions.map((a) => <li key={a.locationId}><Badge tone={a.status === 'scheduled' ? 'success' : 'neutral'}>{names.get(a.locationId) ?? '—'}</Badge></li>)}</ul>
              <div className="mt-3 flex gap-2">
                {item.status !== 'published' && <Button size="sm" icon="send" loading={status.pending} onClick={async () => { if (await status.run('published')) { onChanged(); onClose(); } }}>{t('publish')}</Button>}
                {item.status === 'published' && <Button size="sm" variant="secondary" onClick={async () => { if (await status.run('archived')) { onChanged(); onClose(); } }}>{t('archive')}</Button>}
              </div>
            </SectionCard>
          )}
          {item.status === 'published' && app.capabilities.has(`${M}:edit`) && (
            <SectionCard title={t('localise')}>
              <Field label={t('location')}>{(f) => <Select id={f.id} value={loc} onChange={(e) => { setLocationId(e.target.value); setBody(null); setPicked(null); setDone(null); }}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
              <Async res={preview} loading={<LoadingBlock variant="detail" />}>
                {(p) => (p ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <Field label={t('preview')} hint={item.allowEdits ? t('editHint') : t('lockedHint')}>{(f) => <Textarea id={f.id} rows={4} value={body ?? p.body} readOnly={!item.allowEdits} onChange={(e) => setBody(e.target.value)} />}</Field>
                    {p.missing.length > 0 && <Banner tone="warning" title={t('missingTitle')}>{t('missingBody', { tokens: p.missing.map((m) => t(`token.${m}`)).join(', ') })}</Banner>}
                    {p.accounts.length ? (
                      <fieldset>
                        <legend className="text-sm font-bold">{t('accounts')}</legend>
                        {p.accounts.map((a) => (
                          <label key={a.id} className="mt-1 flex items-center gap-2 text-sm"><input type="checkbox" checked={(picked ?? p.accounts.map((x) => x.id)).includes(a.id)} onChange={(e) => setPicked((x) => { const cur = x ?? p.accounts.map((y) => y.id); return e.target.checked ? [...cur, a.id] : cur.filter((y) => y !== a.id); })} /><Icon name="share" size={14} />{t(`network.${a.network}`)} · {a.handle}{a.mode === 'sandbox' ? ` · ${t('sandbox')}` : ''}</label>
                        ))}
                      </fieldset>
                    ) : <Banner tone="info">{t('noAccounts')}</Banner>}
                    {adoption?.status === 'scheduled' && <Banner tone="success" title={t('alreadyScheduled')}>{t(`postStatus.${adoption.postStatus ?? 'scheduled'}`)}</Banner>}
                    {done && <Banner tone="success" live="polite" title={t('scheduledTitle')}>{done}</Banner>}
                    {(adopt.error || skip.error) && <Banner tone="danger" live="assertive">{(adopt.error ?? skip.error)!.message}</Banner>}
                    <div className="flex flex-wrap gap-2">
                      <Button icon="calendar" loading={adopt.pending} disabled={!p.accounts.length || p.missing.length > 0 || adoption?.status === 'scheduled'} onClick={async () => { const r = await adopt.run(); if (r) { setDone(t(r.status === 'pending_approval' ? 'sentForApproval' : 'scheduledBody')); onChanged(); } }}>{t('schedule')}</Button>
                      {!adoption && <Button variant="ghost" onClick={async () => { if (await skip.run()) onChanged(); }}>{t('skip')}</Button>}
                    </div>
                  </div>
                ) : null)}
              </Async>
            </SectionCard>
          )}
        </div>
      )}
    </Drawer>
  );
}

function NewItemDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('lmk.calendar');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('10:00');
  const [networks, setNetworks] = useState<string[]>(['facebook', 'instagram']);
  const [allowEdits, setAllowEdits] = useState(false);
  const [image, setImage] = useState('');
  const create = useMutation(() => calendarApi.create({ title, body, networks, suggestedAt: new Date(`${date}T${time}:00`).toISOString(), allowEdits, link: null, media: image ? [{ url: image }] : [] }));
  return (
    <Drawer open={open} onClose={onClose} title={t('newPost')} kicker={t('title')} footer={<Button icon="plus" loading={create.pending} disabled={title.trim().length < 2 || !body.trim() || !date} onClick={async () => { if (await create.run()) onCreated(); }}>{t('saveDraft')}</Button>}>
      <div className="flex flex-col gap-3">
        <Field label={t('titleLabel')}>{(f) => <Input id={f.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('bodyLabel')} hint={t('tokensHint', { tokens: SOCIAL_TEMPLATE_TOKENS.map((x) => `{${x}}`).join(' ') })}>{(f) => <Textarea id={f.id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('date')}>{(f) => <Input id={f.id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('time')}>{(f) => <Input id={f.id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
        </div>
        <Field label={t('image')} optional>{(f) => <Input id={f.id} type="url" value={image} onChange={(e) => setImage(e.target.value)} />}</Field>
        <fieldset><legend className="text-sm font-bold">{t('networks')}</legend>
          <div className="mt-1 flex flex-wrap gap-3">{SOCIAL_NETWORKS.map((n) => <label key={n} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={networks.includes(n)} onChange={(e) => setNetworks((x) => (e.target.checked ? [...x, n] : x.filter((y) => y !== n)))} />{t(`network.${n}`)}</label>)}</div>
        </fieldset>
        <LabeledToggle checked={allowEdits} onChange={setAllowEdits} label={t('allowEdits')} />
        {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
      </div>
    </Drawer>
  );
}
