'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Tabs } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { SeriesInput, SeriesPreview } from '@/lib/studios/types';
import { addDays, cityOfZone, dateInZone, fmtDay, fmtTime, fmtYmd, zoneLabel } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, Pill, StudioAsync, WEEKDAY_KEYS, fmtMoney, inputCls, toMinor } from './shared';

/** Schedule builder: class type → instructor & room → recurrence (location time zone) → capacity → price/credits → preview → publish. */
export function ScheduleScreen() {
  const t = useTranslations('studiosFull.schedule');
  const tw = useTranslations('studiosFull.weekdays');
  const locale = useLocale();
  const app = useApp();
  const locs = app.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const [locId, setLocId] = useState(locs[0]?.id ?? '');
  const [tab, setTab] = useState<'series' | 'new'>('series');
  useEffect(() => { if (!locs.some((l) => l.id === locId) && locs[0]) setLocId(locs[0].id); }, [app.scopeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const loc = locs.find((l) => l.id === locId) ?? locs[0];
  const tz = loc?.timeZone ?? 'UTC';
  const seriesRes = useStudio((api) => api.series(locId || undefined), [locId, app.role]);
  const types = useStudio((api) => api.classTypes(), [app.role]);
  const rooms = useStudio((api) => api.rooms(locId), [locId]);
  const instructors = useStudio((api) => api.instructors(locId), [locId]);
  const publish = useStudioMutation((api, id: string) => api.publishSeries(id, false));

  const tomorrow = addDays(dateInZone(new Date(), tz), 1);
  const [form, setForm] = useState({ classTypeId: '', instructor: '', roomId: '', days: [1, 3] as number[], time: '07:00', startDate: tomorrow, end: 'until' as 'until' | 'count', untilDate: addDays(tomorrow, 56), count: '12', interval: '1', skip: '', capacity: '', price: '', creditCost: '', allowCredits: true, allowMembership: true, online: false });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); };
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const pv = useStudioMutation((api, input: SeriesInput) => api.previewSeries(input));
  const create = useStudioMutation((api, input: SeriesInput, publishNow: boolean, allowConflicts: boolean) => api.createSeries(input, { publish: publishNow, allowConflicts }));

  const ct = types.data?.find((x) => x.id === form.classTypeId);
  const inst = instructors.data?.find((i) => i.userId === form.instructor);
  const input = useMemo<SeriesInput | null>(() => {
    if (!loc || !form.classTypeId) return null;
    const price = form.price ? toMinor(form.price, loc.currency) : 0;
    return {
      locationId: loc.id, classTypeId: form.classTypeId, instructorUserId: inst?.userId ?? null, instructorName: inst ? inst.name : form.instructor || null, roomId: form.roomId || null,
      capacity: form.capacity ? Number(form.capacity) : undefined, priceMinor: price ?? 0, creditCost: form.creditCost ? Number(form.creditCost) : undefined,
      allowCredits: form.allowCredits, allowMembership: form.allowMembership, online: form.online,
      recurrence: { freq: 'WEEKLY', interval: Number(form.interval) || 1, byWeekday: form.days, time: form.time, startDate: form.startDate, untilDate: form.end === 'until' ? form.untilDate : null, count: form.end === 'count' ? Number(form.count) || null : null, skipDates: form.skip.split(/[\s,]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) },
    };
  }, [form, loc, inst]);

  const runPreview = async () => { if (input) setPreview((await pv.run(input)) ?? null); };
  const save = async (publishNow: boolean, allowConflicts = false) => {
    if (!input) return;
    const r = await create.run(input, publishNow, allowConflicts);
    if (r) { setDone(publishNow ? t('published', { count: r.generated }) : t('drafted')); setPreview(null); setTab('series'); seriesRes.reload(); }
  };

  return (
    <>
      <PageHeader icon="repeat" title={t('title')} description={t('description')} actions={<Tabs items={[{ key: 'series', label: t('tabSeries') }, { key: 'new', label: t('tabNew') }]} value={tab} onChange={(k) => setTab(k)} />} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-11 items-center gap-2 rounded-full border border-line-soft bg-surface px-3 text-[13px] font-semibold">
          <Icon name="pin" size={14} />
          <span className="sr-only">{t('location')}</span>
          <select value={locId} onChange={(e) => { setLocId(e.target.value); setPreview(null); }} className="bg-transparent font-bold focus:outline-none">
            {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <span className="text-xs text-stone">{t('timesIn', { zone: `${cityOfZone(tz)} (${zoneLabel(tz, locale)})`, currency: loc?.currency ?? '' })}</span>
      </div>
      {done && <Banner tone="success" live="polite">{done}</Banner>}

      {tab === 'series' ? (
        <section className="rounded-xl bg-surface p-4">
          <StudioAsync res={seriesRes} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="repeat" title={t('emptyTitle')} body={t('emptyBody')} action={<Button icon="plus" onClick={() => setTab('new')}>{t('tabNew')}</Button>} />}>
            {(rows) => (
              <ul className="flex flex-col gap-2">
                {rows.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas-raised px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm">{s.className}</strong>
                        <Badge tone={s.status === 'published' ? 'success' : s.status === 'draft' ? 'neutral' : 'warning'} icon={s.status === 'published' ? 'check-circle' : s.status === 'draft' ? 'edit' : 'clock'}>{t(`status.${s.status}`)}</Badge>
                        {s.online && <Badge tone="info" icon="video">{t('online')}</Badge>}
                      </div>
                      <div className="text-xs text-graphite">
                        {s.recurrence.byWeekday.map((d) => tw(WEEKDAY_KEYS[d]!)).join(', ')} · {s.recurrence.time} · {t('every', { n: s.recurrence.interval })} · {s.recurrence.untilDate ? t('until', { date: fmtYmd(s.recurrence.untilDate, locale, { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('countOnly', { n: s.recurrence.count ?? 0 })}
                      </div>
                      <div className="text-xs text-stone">{[s.instructorName, s.roomName, t('capacityN', { n: s.capacity }), fmtMoney(s.price.amount, s.price.currency, locale), t('credits', { n: s.creditCost })].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="text-right text-xs">
                      <div><strong className="tabular">{s.upcoming ?? '—'}</strong> {t('upcoming')}</div>
                      <div><strong className="tabular">{s.bookings ?? '—'}</strong> {t('bookings')}</div>
                    </div>
                    {s.status === 'draft' && (
                      <Button size="sm" icon="send" disabled={publish.pending} onClick={async () => { const r = await publish.run(s.id); if (r) { setDone(t('published', { count: r.generated })); seriesRes.reload(); } }}>{t('publish')}</Button>
                    )}
                  </li>
                ))}
                {publish.error && <ErrorLine message={publish.error.message} />}
              </ul>
            )}
          </StudioAsync>
        </section>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-[1fr_1.1fr]">
          <section className="flex flex-col gap-4 rounded-xl bg-surface p-5" aria-label={t('tabNew')}>
            <h2 className="text-base font-bold">1 · {t('stepClass')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label={t('classType')}>
                <select className={inputCls} value={form.classTypeId} onChange={(e) => set('classTypeId', e.target.value)}>
                  <option value="">{t('choose')}</option>
                  {(types.data ?? []).filter((x) => !x.locationId || x.locationId === locId).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.durationMinutes} min</option>)}
                </select>
              </Labeled>
              <Labeled label={t('instructor')} hint={t('instructorHint')}>
                <input list="studio-instructors" className={inputCls} value={inst?.name ?? form.instructor} onChange={(e) => { const m = instructors.data?.find((i) => i.name === e.target.value); set('instructor', m ? m.userId : e.target.value); }} />
                <datalist id="studio-instructors">{(instructors.data ?? []).map((i) => <option key={i.userId} value={i.name} />)}</datalist>
              </Labeled>
              <Labeled label={t('room')}>
                <select className={inputCls} value={form.roomId} onChange={(e) => set('roomId', e.target.value)}>
                  <option value="">{t('noRoom')}</option>
                  {(rooms.data ?? []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name} · {t('capacityN', { n: r.capacity })}</option>)}
                </select>
              </Labeled>
            </div>
            <h2 className="text-base font-bold">2 · {t('stepRepeat')}</h2>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[13px] font-bold">{t('weekdays')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_KEYS.map((k, d) => <Pill key={k} active={form.days.includes(d)} onClick={() => set('days', form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d].sort())}>{tw(k)}</Pill>)}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-3">
              <Labeled label={t('time')} hint={t('timeHint', { city: cityOfZone(tz) })}><input type="time" className={inputCls} value={form.time} onChange={(e) => set('time', e.target.value)} /></Labeled>
              <Labeled label={t('repeatEvery')}><select className={inputCls} value={form.interval} onChange={(e) => set('interval', e.target.value)}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t('every', { n })}</option>)}</select></Labeled>
              <Labeled label={t('startDate')}><input type="date" className={inputCls} value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></Labeled>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Labeled label={t('ends')}><select className={inputCls} value={form.end} onChange={(e) => set('end', e.target.value as 'until' | 'count')}><option value="until">{t('endsOn')}</option><option value="count">{t('endsAfter')}</option></select></Labeled>
              {form.end === 'until' ? <Labeled label={t('endDate')}><input type="date" className={inputCls} value={form.untilDate} onChange={(e) => set('untilDate', e.target.value)} /></Labeled> : <Labeled label={t('count')}><input type="number" min={1} max={750} className={inputCls} value={form.count} onChange={(e) => set('count', e.target.value)} /></Labeled>}
              <Labeled label={t('skip')} hint={t('skipHint')}><input className={inputCls} placeholder="2026-12-25" value={form.skip} onChange={(e) => set('skip', e.target.value)} /></Labeled>
            </div>
            <h2 className="text-base font-bold">3 · {t('stepCapacity')}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Labeled label={t('capacity')} hint={ct ? t('defaultN', { n: ct.defaultCapacity }) : undefined}><input type="number" min={1} className={inputCls} value={form.capacity} onChange={(e) => set('capacity', e.target.value)} /></Labeled>
              <Labeled label={t('price', { currency: loc?.currency ?? '' })} hint={t('priceHint')}><input inputMode="decimal" className={inputCls} value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="0" /></Labeled>
              <Labeled label={t('creditCost')} hint={ct ? t('defaultN', { n: ct.creditCost }) : undefined}><input type="number" min={0} max={20} className={inputCls} value={form.creditCost} onChange={(e) => set('creditCost', e.target.value)} /></Labeled>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {(['allowCredits', 'allowMembership', 'online'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 font-semibold"><input type="checkbox" className="size-4 accent-ink" checked={form[k]} onChange={(e) => set(k, e.target.checked)} />{t(k)}</label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon="eye" onClick={runPreview} disabled={!input || pv.pending}>{pv.pending ? t('previewing') : t('preview')}</Button>
            </div>
            <ErrorLine message={pv.error?.message} />
          </section>

          <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-live="polite">
            <h2 className="text-base font-bold">4 · {t('stepPreview')}</h2>
            {!preview ? <Empty icon="calendar" title={t('previewEmpty')} body={t('previewEmptyBody')} /> : (
              <>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded-[14px] bg-lilac p-3"><div className="text-stone">{t('classes')}</div><strong className="text-lg">{preview.summary.count}</strong></div>
                  <div className="rounded-[14px] bg-canvas p-3"><div className="text-stone">{t('first')}</div><strong>{preview.summary.first ? fmtDay(preview.summary.first, tz, locale) : '—'}</strong></div>
                  <div className="rounded-[14px] bg-canvas p-3"><div className="text-stone">{t('last')}</div><strong>{preview.summary.last ? fmtDay(preview.summary.last, tz, locale) : '—'}</strong></div>
                  <div className="rounded-[14px] bg-canvas p-3"><div className="text-stone">{t('perClass')}</div><strong>{preview.price.amount ? fmtMoney(preview.price.amount, preview.price.currency, locale) : t('free')} · {t('credits', { n: preview.creditCost })}</strong></div>
                </div>
                {preview.summary.crossesDst && <Banner tone="info" icon="clock">{t('dstNote', { time: form.time, city: cityOfZone(tz) })}</Banner>}
                {preview.summary.dstAdjusted > 0 && <Banner tone="warning">{t('dstGap', { n: preview.summary.dstAdjusted })}</Banner>}
                {preview.summary.conflicts > 0 && <Banner tone="warning" title={t('conflictsTitle', { n: preview.summary.conflicts })}>{t('conflictsBody')}</Banner>}
                <pre className="overflow-x-auto rounded-md bg-canvas p-2 text-[11px] text-graphite">{preview.rrule}</pre>
                <div className="max-h-[380px] overflow-y-auto rounded-md border border-line-soft">
                  <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-left text-[13px]">
                    <caption className="sr-only">{t('stepPreview')}</caption>
                    <thead className="sticky top-0 bg-surface text-xs text-stone"><tr><th scope="col" className="px-3 py-2">{t('date')}</th><th scope="col" className="px-3 py-2">{t('localTime')}</th><th scope="col" className="px-3 py-2">UTC</th><th scope="col" className="px-3 py-2">{t('checks')}</th></tr></thead>
                    <tbody>
                      {preview.occurrences.map((o, i) => {
                        const offsetChanged = i > 0 && preview.occurrences[i - 1]!.utcOffsetMinutes !== o.utcOffsetMinutes;
                        return (
                          <tr key={o.startsAt} className="border-t border-line-soft">
                            <td className="px-3 py-1.5">{fmtYmd(o.localDate, locale)}</td>
                            <td className="px-3 py-1.5 font-bold tabular">{fmtTime(o.startsAt, tz, locale)}</td>
                            <td className="px-3 py-1.5 tabular text-stone">{o.startsAt.slice(11, 16)}{offsetChanged && <span className="ml-1.5 rounded-full bg-info-bg px-1.5 text-[10px] font-bold text-info">{t('dstShift')}</span>}</td>
                            <td className="px-3 py-1.5">{o.conflicts.length ? <span className="flex items-center gap-1 text-xs font-bold text-warning"><Icon name="alert" size={13} />{o.conflicts.map((c) => c.message).join('; ')}</span> : <span className="flex items-center gap-1 text-xs text-success"><Icon name="check" size={13} />{t('ok')}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button icon="send" onClick={() => save(true)} disabled={create.pending}>{t('publishN', { n: preview.summary.count })}</Button>
                  {preview.summary.conflicts > 0 && <Button variant="secondary" onClick={() => save(true, true)} disabled={create.pending}>{t('publishAnyway')}</Button>}
                  <Button variant="ghost" onClick={() => save(false)} disabled={create.pending}>{t('saveDraft')}</Button>
                </div>
                <ErrorLine message={create.error?.message} />
                <p className="text-xs text-stone">{t('publishNote')}</p>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
