'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Tabs, cx } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { EditChanges, EditPreview, EditScope } from '@/lib/studios/types';
import { cityOfZone, fmtDay, fmtTime, hhmmIn, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, StudioAsync, WEEKDAY_KEYS, fmtMoney, inputCls } from './shared';

type Tab = 'roster' | 'edit' | 'history';

/** Class detail drawer body: check-in roster, edit one / following / series with an impact preview, communication history. */
export function ClassPanel({ occurrenceId, locationId, start, tz, inSeries, onChanged }: { occurrenceId: string; locationId: string; start: string; tz: string; inSeries: boolean; onChanged: (message?: string) => void }) {
  const t = useTranslations('studiosFull.classPanel');
  const app = useApp();
  const [tab, setTab] = useState<Tab>('roster');
  const canWrite = app.can('operations.write');
  return (
    <div className="flex flex-col gap-4">
      <Tabs items={[{ key: 'roster', label: t('roster') }, ...(canWrite ? [{ key: 'edit' as const, label: t('edit') }] : []), { key: 'history', label: t('history') }]} value={tab} onChange={(k) => setTab(k as Tab)} />
      {tab === 'roster' && <RosterTab occurrenceId={occurrenceId} canWrite={canWrite} />}
      {tab === 'edit' && <EditTab occurrenceId={occurrenceId} locationId={locationId} start={start} tz={tz} inSeries={inSeries} onChanged={onChanged} />}
      {tab === 'history' && <HistoryTab occurrenceId={occurrenceId} />}
    </div>
  );
}

function RosterTab({ occurrenceId, canWrite }: { occurrenceId: string; canWrite: boolean }) {
  const t = useTranslations('studiosFull.classPanel');
  const locale = useLocale();
  const res = useStudio((api) => api.roster(occurrenceId), [occurrenceId]);
  const checkIn = useStudioMutation((api, id: string, undo: boolean) => api.checkIn(id, 'desk', undo));
  const noShow = useStudioMutation((api, id: string) => api.markNoShow(id));
  const close = useStudioMutation((api) => api.closeAttendance(occurrenceId));
  const [note, setNote] = useState<string | null>(null);
  return (
    <StudioAsync res={res} loading={<LoadingBlock variant="table" rows={5} />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="users" title={t('noBookings')} />}>
      {(r) => {
        const started = new Date(r.occurrence.startsAt) <= new Date();
        return (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone="neutral" icon="users">{t('bookedN', { n: r.counts.booked })}</Badge>
              <Badge tone="success" icon="check">{t('checkedInN', { n: r.counts.checkedIn })}</Badge>
              {r.counts.noShows > 0 && <Badge tone="warning" icon="alert">{t('noShowN', { n: r.counts.noShows })}</Badge>}
            </div>
            {note && <Banner tone="success" live="polite">{note}</Banner>}
            <ul className="flex flex-col">
              {r.items.map((i) => (
                <li key={i.bookingId} className="flex flex-wrap items-center gap-2.5 border-b border-canvas py-2 text-[13px]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas text-[10px] font-extrabold" aria-hidden>{i.customer.name.split(' ').map((x) => x[0]).join('')}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold">{i.customer.name}</span>
                    <span className="block text-[11px] text-stone">{i.bookedWith}{i.fee && ` · ${t('fee', { kind: t(`feeKind.${i.fee.kind}`), amount: fmtMoney(i.fee.amount, i.fee.currency, locale) ?? '' })}`}</span>
                  </span>
                  {i.status === 'attended' ? (
                    <span className="flex items-center gap-1.5">
                      <Badge tone="success" icon="check-circle">{t('checkedIn')}{i.checkedInAt ? ` · ${fmtTime(i.checkedInAt, r.occurrence.timeZone, locale)}` : ''}</Badge>
                      {canWrite && <Button size="sm" variant="ghost" onClick={async () => { await checkIn.run(i.bookingId, true); res.reload(); }}>{t('undo')}</Button>}
                    </span>
                  ) : i.status === 'no_show' ? (
                    <span className="flex items-center gap-1.5">
                      <Badge tone="warning" icon="x">{t('noShow')}</Badge>
                      {canWrite && <Button size="sm" variant="ghost" onClick={async () => { await checkIn.run(i.bookingId, false); res.reload(); }}>{t('markAttended')}</Button>}
                    </span>
                  ) : i.status === 'held' ? <Badge tone="info" icon="clock">{t('paying')}</Badge> : canWrite ? (
                    <span className="flex gap-1.5">
                      <Button size="sm" icon="check" onClick={async () => { await checkIn.run(i.bookingId, false); res.reload(); }}>{t('checkIn')}</Button>
                      {started && <Button size="sm" variant="secondary" onClick={async () => { const x = await noShow.run(i.bookingId); if (x) { setNote(x.fee ? t('noShowFee', { amount: fmtMoney(x.fee.amount, x.fee.currency, locale) ?? '' }) : t('noShowNoFee')); res.reload(); } }}>{t('noShow')}</Button>}
                    </span>
                  ) : <Badge tone="neutral">{t('booked')}</Badge>}
                </li>
              ))}
            </ul>
            <ErrorLine message={checkIn.error?.message ?? noShow.error?.message ?? close.error?.message} />
            {canWrite && started && r.items.some((i) => i.status === 'confirmed') && (
              <Button size="sm" variant="secondary" icon="check-circle" onClick={async () => { const x = await close.run(); if (x) { setNote(t('closed', { n: x.noShows, fees: x.feesRecorded })); res.reload(); } }}>{t('closeAttendance')}</Button>
            )}
            <p className="text-[11px] text-stone">{t('rosterNote')}</p>
          </div>
        );
      }}
    </StudioAsync>
  );
}

function EditTab({ occurrenceId, locationId, start, tz, inSeries, onChanged }: { occurrenceId: string; locationId: string; start: string; tz: string; inSeries: boolean; onChanged: (message?: string) => void }) {
  const t = useTranslations('studiosFull.classPanel');
  const tw = useTranslations('studiosFull.weekdays');
  const locale = useLocale();
  const [scope, setScope] = useState<EditScope>('one');
  const [mode, setMode] = useState<'change' | 'cancel'>('change');
  const [f, setF] = useState({ time: hhmmIn(start, tz), weekday: '', instructor: '', roomId: '', capacity: '' });
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const rooms = useStudio((api) => api.rooms(locationId), [locationId]);
  const pv = useStudioMutation((api, c: EditChanges) => api.editPreview(occurrenceId, scope, c));
  const apply = useStudioMutation((api, c: EditChanges, over: boolean, conf: boolean) => api.applyEdit(occurrenceId, scope, c, { notify, reason: reason || undefined, allowConflicts: conf, allowOverCapacity: over }));

  const changes = (): EditChanges => {
    if (mode === 'cancel') return { cancel: true };
    const c: EditChanges = {};
    if (f.time && f.time !== hhmmIn(start, tz)) c.time = f.time;
    if (f.weekday !== '') c.weekday = Number(f.weekday);
    if (f.instructor.trim()) c.instructorName = f.instructor.trim();
    if (f.roomId) c.roomId = f.roomId;
    if (f.capacity) c.capacity = Number(f.capacity);
    return c;
  };
  const upd = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setPreview(null); };
  const empty = Object.keys(changes()).length === 0;

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label={t('scope')} className="grid gap-1.5 sm:grid-cols-3">
        {(['one', 'following', 'series'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={scope === k} disabled={k !== 'one' && !inSeries} onClick={() => { setScope(k); setPreview(null); }} className={cx('rounded-md border-[1.5px] p-2.5 text-left text-xs disabled:opacity-40', scope === k ? 'border-ink bg-canvas' : 'border-line-soft bg-surface')}>
            <strong className="block text-[13px]">{t(`scopes.${k}`)}</strong>
            {k === 'one' ? fmtDay(start, tz, locale) : k === 'following' ? t('scopes.followingDetail', { day: fmtDay(start, tz, locale) }) : t('scopes.seriesDetail')}
          </button>
        ))}
      </div>
      {!inSeries && <p className="text-xs text-stone">{t('notSeries')}</p>}
      <Tabs items={[{ key: 'change', label: t('change') }, { key: 'cancel', label: t('cancelClass') }]} value={mode} onChange={(k) => { setMode(k as 'change' | 'cancel'); setPreview(null); }} />
      {mode === 'change' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label={t('newTime')} hint={t('localHint', { city: cityOfZone(tz) })}><input type="time" className={inputCls} value={f.time} onChange={(e) => upd('time', e.target.value)} /></Labeled>
          <Labeled label={t('moveTo')}>
            <select className={inputCls} value={f.weekday} onChange={(e) => upd('weekday', e.target.value)}>
              <option value="">{t('sameDay')}</option>
              {WEEKDAY_KEYS.map((k, d) => <option key={k} value={d}>{tw(k)}</option>)}
            </select>
          </Labeled>
          <Labeled label={t('instructor')}><input className={inputCls} value={f.instructor} placeholder={t('unchanged')} onChange={(e) => upd('instructor', e.target.value)} /></Labeled>
          <Labeled label={t('room')}>
            <select className={inputCls} value={f.roomId} onChange={(e) => upd('roomId', e.target.value)}>
              <option value="">{t('unchanged')}</option>
              {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.capacity})</option>)}
            </select>
          </Labeled>
          <Labeled label={t('capacity')}><input type="number" min={1} className={inputCls} value={f.capacity} placeholder={t('unchanged')} onChange={(e) => upd('capacity', e.target.value)} /></Labeled>
        </div>
      ) : (
        <Labeled label={t('reason')} hint={t('reasonHint')}><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Labeled>
      )}
      {mode === 'change' && <Labeled label={t('messageNote')}><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('optional')} /></Labeled>}
      <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{t('notify')}</label>
      <Button icon="eye" disabled={empty || pv.pending} onClick={async () => setPreview((await pv.run(changes())) ?? null)}>{pv.pending ? t('checking') : t('previewImpact')}</Button>
      <ErrorLine message={pv.error?.message} />
      {preview && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Banner tone={mode === 'cancel' ? 'danger' : 'warning'} icon="info" title={t('impactTitle', { occurrences: preview.totals.occurrences, bookings: preview.totals.bookings, customers: preview.totals.customers })}>
            {notify ? t('impactNotify', { customers: preview.notify.customers, channels: preview.notify.channels.join(' · ') }) : t('impactSilent')}
          </Banner>
          {preview.warnings.map((w) => <Banner key={w} tone="warning">{w}</Banner>)}
          <ul className="max-h-60 overflow-y-auto rounded-md border border-line-soft text-xs">
            {preview.items.map((i) => (
              <li key={i.occurrenceId} className="flex flex-wrap gap-2 border-b border-line-soft px-3 py-2 last:border-0">
                <strong className="w-36 tabular">{fmtDay(i.before.startsAt, tz, locale)} {fmtTime(i.before.startsAt, tz, locale)}</strong>
                <span className="flex-1">{i.changes.length ? i.changes.join('; ') : t('noVisibleChange')}</span>
                <span className="text-stone">{t('bookingsN', { n: i.bookings })}{i.overCapacity ? ` · ${t('over', { n: i.overCapacity })}` : ''}</span>
                {i.conflicts.length > 0 && <span className="flex w-full items-center gap-1 font-bold text-warning"><Icon name="alert" size={12} />{i.conflicts.map((c) => c.message).join('; ')}</span>}
              </li>
            ))}
          </ul>
          <Button variant={mode === 'cancel' ? 'danger' : 'primary'} icon={mode === 'cancel' ? 'x' : 'check'} disabled={apply.pending} onClick={async () => {
            const over = preview.items.some((i) => i.overCapacity > 0);
            const r = await apply.run(changes(), over, preview.totals.conflicts > 0);
            if (r) { const m = t('applied', { occurrences: r.occurrences, notified: r.customersNotified, sent: r.delivery.sent, skipped: r.delivery.skipped }); setResult(m); setPreview(null); onChanged(m); }
          }}>{mode === 'cancel' ? t('confirmCancel', { n: preview.totals.occurrences }) : t('confirmChange', { n: preview.totals.occurrences })}</Button>
          <ErrorLine message={apply.error?.message} />
        </div>
      )}
      {result && <Banner tone="success" live="polite">{result}</Banner>}
    </div>
  );
}

function HistoryTab({ occurrenceId }: { occurrenceId: string }) {
  const t = useTranslations('studiosFull.classPanel');
  const locale = useLocale();
  const res = useStudio((api) => api.notifications(occurrenceId), [occurrenceId]);
  const statusTone = (s: string) => (s === 'sent' ? 'success' : s === 'failed' ? 'danger' : 'neutral') as 'success' | 'danger' | 'neutral';
  return (
    <StudioAsync res={res} loading={<LoadingBlock variant="table" rows={3} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="message" title={t('noHistory')} body={t('noHistoryBody')} />}>
      {(rows) => (
        <ul className="flex flex-col gap-1.5 text-xs">
          {rows.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2">
              <Icon name={n.channel === 'email' ? 'mail' : n.channel === 'sms' ? 'phone' : 'bell'} size={14} />
              <strong>{n.customer}</strong>
              <span className="min-w-0 flex-1 truncate">{n.subject}</span>
              <Badge tone={statusTone(n.status)} icon={n.status === 'sent' ? 'check' : 'info'}>{t(`delivery.${n.status}`)}</Badge>
              <span className="text-stone">{relativeTime(n.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </StudioAsync>
  );
}
