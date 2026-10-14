'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Tabs, cx } from '@bh/ui';
import type { Appointment, RescheduleSlot, WellnessDay } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { cityOfZone, fmtDay, fmtTime, fmtWall, fmtYmd, hhmmIn, zoneLabel } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';

type View = 'practitioners' | 'rooms' | 'list';
type Phase = 'idle' | 'working' | 'failed' | 'ok';

export function CalendarScreen() {
  const t = useTranslations('wellness');
  const tOps = useTranslations('ops.wellness.calendar');
  const locale = useLocale();
  const app = useApp();
  const [view, setView] = useState<View>('practitioners');
  const [open, setOpen] = useState<Appointment | null>(null);
  const res = useApi((api) => api.wellness.day(app.ctx), [app.role, app.scopeId]);
  const locName = (d: WellnessDay) => app.locations.find((l) => l.id === d.locationId)?.name ?? '';

  return (
    <>
      <PageHeader icon="calendar" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="calendar" />}>
        {(d) => {
          const cols = view === 'rooms' ? d.rooms.map((r) => ({ id: r, name: r, pastel: '#F3F2EE' })) : d.practitioners;
          const matches = (a: Appointment, colId: string, slot: string) => hhmmIn(a.start, d.timeZone) === slot && (view === 'rooms' ? a.room === colId : a.practitionerId === colId);
          return (
            <section className="rounded-xl bg-surface p-3.5">
              <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
                <strong className="text-[15px]">{fmtYmd(d.date, locale, { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
                <span className="text-xs text-stone">
                  {locName(d)} · {t('timesIn', { zone: `${cityOfZone(d.timeZone)} (${zoneLabel(d.timeZone, locale)})` })}
                </span>
                {app.scope.locationIds.length > 1 && <span className="text-xs text-stone">· {t('oneLocationHint')}</span>}
                <Tabs className="ml-auto" items={(['practitioners', 'rooms', 'list'] as const).map((k) => ({ key: k, label: t(`view.${k}`) }))} value={view} onChange={(v) => setView(v as View)} />
              </div>
              {view === 'list' ? (
                <ul className="flex flex-col gap-1.5">
                  {[...d.appointments].sort((a, b) => a.start.localeCompare(b.start)).map((a) => (
                    <li key={a.id}>
                      <button type="button" disabled={a.status === 'cancelled'} onClick={() => setOpen(a)} className="grid w-full grid-cols-[80px_1fr_auto] items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-3 text-left enabled:hover:outline enabled:hover:outline-1">
                        <span className="tabular text-[13px] font-bold">{fmtTime(a.start, d.timeZone, locale)}</span>
                        <span>
                          <span className="block text-sm font-bold">{a.service}</span>
                          <span className="block text-xs text-stone">
                            {a.client} · {d.practitioners.find((p) => p.id === a.practitionerId)?.name} · {a.room}
                          </span>
                        </span>
                        <StatusBadge a={a} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="overflow-x-auto">
                  <div className="grid min-w-[720px] gap-2" style={{ gridTemplateColumns: `70px repeat(${cols.length}, minmax(180px, 1fr))` }}>
                    <div />
                    {cols.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 rounded-[14px] bg-canvas p-2.5">
                        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full text-[11px] font-extrabold" style={{ background: c.pastel === '#F3F2EE' ? '#fff' : c.pastel }}>
                          {c.name.split(' ').map((x) => x[0]).join('')}
                        </span>
                        <span className="text-[13px] font-bold">{c.name}</span>
                      </div>
                    ))}
                    {d.slots.map((slot) => (
                      <Row key={slot} slot={slot} cols={cols} d={d} matches={matches} onOpen={setOpen} locale={locale} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          );
        }}
      </Async>
      {open && res.status === 'ready' && (
        <RescheduleDrawer
          appt={open}
          day={res.data}
          onClose={() => setOpen(null)}
          onMoved={(nd) => {
            res.setData(nd);
            setOpen(nd.appointments.find((a) => a.id === open.id) ?? null);
          }}
        />
      )}
    </>
  );
}

function Row({ slot, cols, d, matches, onOpen, locale }: { slot: string; cols: { id: string }[]; d: WellnessDay; matches: (a: Appointment, c: string, s: string) => boolean; onOpen: (a: Appointment) => void; locale: string }) {
  const t = useTranslations('wellness');
  return (
    <>
      <div className="tabular pt-2.5 text-xs font-bold text-stone">{fmtWall(slot, locale)}</div>
      {cols.map((c) => {
        const a = d.appointments.find((x) => matches(x, c.id, slot));
        if (!a)
          return (
            <div key={c.id} className="flex min-h-[62px] items-center rounded-md border border-dashed border-line-soft bg-[#FAFAF7] px-2.5 text-[11px] text-mute">
              {t('available')}
            </div>
          );
        return (
          <button key={c.id} type="button" disabled={a.status === 'cancelled'} onClick={() => onOpen(a)} className={cx('flex min-h-[62px] flex-col gap-0.5 rounded-md p-2.5 text-left enabled:hover:outline enabled:hover:outline-1 enabled:hover:outline-ink', a.status === 'cancelled' ? 'bg-canvas text-stone line-through' : a.id === 'ap_jordan' ? 'border-[1.5px] border-ink bg-butter' : 'bg-mint')}>
            <span className="text-[13px] font-bold">{a.service}</span>
            <span className="text-[11px] text-graphite">
              {a.client} · {a.room}
            </span>
          </button>
        );
      })}
    </>
  );
}

function StatusBadge({ a }: { a: Appointment }) {
  const t = useTranslations('wellness');
  return <Badge tone={a.status === 'cancelled' ? 'danger' : a.status === 'deposit_paid' ? 'info' : 'success'}>{t(`status.${a.status}`)}</Badge>;
}

function RescheduleDrawer({ appt, day, onClose, onMoved }: { appt: Appointment; day: WellnessDay; onClose: () => void; onMoved: (d: WellnessDay) => void }) {
  const t = useTranslations('wellness');
  const locale = useLocale();
  const [slot, setSlot] = useState<RescheduleSlot | null>(null);
  const [simulate, setSimulate] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const slots = useApi((api) => api.wellness.slots(appt.id), [appt.id]);
  const move = useMutation((api, slotId: string, sim: boolean) => api.wellness.reschedule(appt.id, slotId, { simulateConflict: sim }));
  const tz = day.timeZone;
  const prac = day.practitioners.find((p) => p.id === appt.practitionerId)?.name;

  const confirm = async () => {
    if (!slot) return;
    setPhase('working');
    const r = await move.run(slot.id, simulate);
    if (r) {
      setPhase('ok');
      onMoved(r);
    } else {
      setPhase('failed');
    }
  };

  return (
    <Drawer open onClose={onClose} kicker={t('reschedule')} title={`${appt.service} · ${appt.client}`}>
      <div className="flex flex-col gap-3.5">
        <div className="rounded-lg bg-mint p-3.5 text-[13px] leading-relaxed">
          <strong>{t('current')}</strong> {fmtDay(appt.start, tz, locale)} {fmtTime(appt.start, tz, locale)} ({zoneLabel(tz, locale)}) · {prac} · {appt.room}
        </div>
        <fieldset disabled={phase === 'working' || phase === 'ok'} className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[13px] font-bold">{t('moveTo')}</legend>
          {slots.status === 'ready' &&
            slots.data.map((s) => (
              <label key={s.id} className={cx('flex cursor-pointer items-center justify-between rounded-md border-[1.5px] px-3.5 py-3 text-[13px]', slot?.id === s.id ? 'border-ink bg-canvas' : 'border-line-soft')}>
                <span className="flex items-center gap-2.5">
                  <input type="radio" name="slot" checked={slot?.id === s.id} onChange={() => (setSlot(s), setPhase('idle'))} className="h-4 w-4 accent-ink" />
                  <span>
                    <strong>
                      {fmtDay(s.start, tz, locale)} {fmtTime(s.start, tz, locale)}
                    </strong>{' '}
                    · {s.practitioner}
                  </span>
                </span>
                <span className="text-[11px] text-stone">{s.room}</span>
              </label>
            ))}
        </fieldset>
        <label className="flex items-center gap-2 text-xs text-stone">
          <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} className="h-[18px] w-[18px] accent-ink" />
          {t('simulateConflict')}
        </label>
        <p className="text-xs leading-normal text-stone">{t('policy')}</p>
        {phase === 'idle' && (
          <Button onClick={confirm} disabled={!slot}>
            {t('confirm')}
          </Button>
        )}
        {phase === 'working' && <Banner tone="info" icon="refresh" live="polite">{t('working')}</Banner>}
        {phase === 'failed' && (
          <>
            <Banner tone="danger" title={t('failedTitle')} live="assertive">
              {move.error?.message ?? t('failedBody')}
            </Banner>
            <Button variant="secondary" onClick={() => (setSlot(null), setPhase('idle'))}>
              {t('chooseAnother')}
            </Button>
          </>
        )}
        {phase === 'ok' && (
          <Banner tone="success" title={t('movedTitle')} live="polite">
            {t('movedBody')}
          </Banner>
        )}
      </div>
    </Drawer>
  );
}
