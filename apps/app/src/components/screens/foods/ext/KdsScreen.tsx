'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { Button, Icon, Toggle, cx } from '@bh/ui';
import type { KdsFeed, KdsOrder, KdsTicket } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtTime, relativeTime } from '@/lib/format';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../../ui/States';
import { ChannelTag, LocationSelect, NoLocations, StatusBadge, useFx, useLocationPick } from './common';

const REFRESH_MS = 10_000;
const STALE_MS = 35_000;

/** Short, accessible chime for new tickets (Web Audio; off when audible alerts are disabled). */
function chime() {
  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch {
    /* audio unavailable */
  }
}

/**
 * KDS by station: tickets routed by item station, start/bump/recall acknowledged by the server, prep-time
 * targets with overdue markers, audible alerts that can be turned off and a stale banner when refreshes fail.
 */
export function KdsScreen() {
  const t = useFx();
  const locale = useLocale();
  const pick = useLocationPick();
  const [stationId, setStationId] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const [full, setFull] = useState(false);
  const [lastOk, setLastOk] = useState<number>(Date.now());
  const [, tick] = useState(0);
  const res = useFoods((api) => api.kds(pick.locationId, stationId), [pick.locationId, stationId], !!pick.locationId);
  const seen = useRef<Set<string>>(new Set());
  const act = useFoodsMutation((api, id: string, action: 'start' | 'bump' | 'recall', expected?: string) => api.ticket(id, action, expected));
  const move = useFoodsMutation((api, id: string, to: string, from: string) => api.transition(id, to, { expectedFrom: from }));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (res.status === 'ready') {
      setLastOk(Date.now());
      const ids = [...res.data.tickets.map((x) => x.id), ...res.data.orders.map((o) => o.id)];
      const fresh = ids.filter((x) => !seen.current.has(x));
      if (seen.current.size && fresh.length && sound) chime();
      ids.forEach((x) => seen.current.add(x));
      if (res.data.audibleDefault === false && seen.current.size === ids.length) setSound(false);
    }
  }, [res.status, res.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = setInterval(() => {
      tick((x) => x + 1);
      res.reload();
    }, REFRESH_MS);
    return () => clearInterval(h);
  }, [pick.locationId, stationId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pick.loc) return <NoLocations />;
  const stale = res.status === 'error' || Date.now() - lastOk > STALE_MS;
  const doTicket = async (tk: KdsTicket, action: 'start' | 'bump' | 'recall') => {
    setBusy(tk.id);
    await act.run(tk.id, action, action === 'recall' ? 'done' : tk.status);
    setBusy(null);
    res.reload();
  };
  const doOrder = async (o: KdsOrder, to: string) => {
    setBusy(o.id);
    await move.run(o.id, to, o.status);
    setBusy(null);
    res.reload();
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3">
      <LocationSelect pick={pick} />
      {res.data && (
        <div role="group" aria-label={t('kds.stations')} className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={!stationId} onClick={() => setStationId(null)} className={cx('h-10 rounded-full px-4 text-[13px] font-bold', !stationId ? 'bg-ink text-white' : 'bg-canvas')}>
            {t('kds.expo')}
          </button>
          {res.data.stations.filter((s) => !s.isExpo).map((s) => (
            <button key={s.id} type="button" aria-pressed={stationId === s.id} onClick={() => setStationId(s.id)} className={cx('h-10 rounded-full px-4 text-[13px] font-bold', stationId === s.id ? 'bg-ink text-white' : 'bg-canvas')}>
              {s.name} <span className="opacity-70">({s.open})</span>
            </button>
          ))}
        </div>
      )}
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name={sound ? 'volume' : 'volume-off'} size={16} />
        {t('kds.sound')}
        <Toggle checked={sound} onChange={setSound} label={t('kds.sound')} />
      </span>
      <Button size="sm" variant="secondary" icon={full ? 'x' : 'arrow-up-right'} className="ml-auto" onClick={() => setFull((f) => !f)}>
        {full ? t('kds.exitFull') : t('kds.fullScreen')}
      </Button>
    </div>
  );

  const body = (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
      {(k: KdsFeed) => (
        <>
          {stale ? (
            <Banner tone="danger" icon="wifi-off" title={t('kds.staleTitle')} live="assertive">
              {t('kds.staleBody', { time: fmtTime(new Date(lastOk).toISOString(), k.location.timeZone, locale), ago: relativeTime(new Date(lastOk).toISOString(), locale) })}
            </Banner>
          ) : (
            <p className="flex items-center gap-1.5 text-xs font-semibold text-success" role="status">
              <Icon name="check-circle" size={13} />
              {t('kds.live', { time: fmtTime(k.refreshedAt, k.location.timeZone, locale) })}
            </p>
          )}
          {(act.error || move.error) && <Banner tone="danger" live="assertive" title={t('common.notSaved')}>{(act.error ?? move.error)!.message}</Banner>}
          {!k.stations.length && <Banner tone="info" title={t('kds.noStations')}>{t('kds.noStationsBody')}</Banner>}
          <div className={cx('grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr))]', stale && 'opacity-60 grayscale')} aria-disabled={stale || undefined}>
            {k.view === 'station'
              ? k.tickets.length === 0
                ? <Empty icon="chef" title={t('kds.emptyStation')} />
                : k.tickets.map((tk) => <TicketCard key={tk.id} tk={tk} tz={k.location.timeZone} disabled={stale || busy === tk.id} busy={busy === tk.id} onAct={(a) => doTicket(tk, a)} />)
              : k.orders.length === 0
                ? <Empty icon="chef" title={t('kds.empty')} />
                : k.orders.map((o) => <ExpoCard key={o.id} o={o} tz={k.location.timeZone} disabled={stale || busy === o.id} busy={busy === o.id} onMove={(to) => doOrder(o, to)} />)}
          </div>
        </>
      )}
    </Async>
  );

  if (full)
    return (
      <div className="fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto bg-canvas p-3" role="dialog" aria-modal="true" aria-label={t('kds.title')}>
        {controls}
        {body}
      </div>
    );
  return (
    <>
      <PageHeader icon="chef" title={t('kds.title')} description={t('kds.description')} />
      {controls}
      {body}
    </>
  );
}

function Lines({ lines }: { lines: Array<{ name: string; quantity: number; modifiers: string[]; notes?: string }> }) {
  return (
    <ul className="flex flex-col gap-1.5 text-lg">
      {lines.map((l, i) => (
        <li key={i} className="leading-snug">
          <strong>{l.quantity}×</strong> {l.name}
          {l.modifiers.map((m) => (
            <span key={m} className="block pl-7 text-base font-semibold text-graphite">+ {m}</span>
          ))}
          {l.notes && <span className="block pl-7 text-base font-bold text-warning">“{l.notes}”</span>}
        </li>
      ))}
    </ul>
  );
}

function TicketCard({ tk, tz, disabled, busy, onAct }: { tk: KdsTicket; tz: string; disabled: boolean; busy: boolean; onAct: (a: 'start' | 'bump' | 'recall') => void }) {
  const t = useFx();
  const locale = useLocale();
  return (
    <article className={cx('flex flex-col gap-3 rounded-xl border-[3px] bg-surface p-5', tk.overdue ? 'border-danger' : tk.status === 'done' ? 'border-success' : 'border-transparent')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[30px] font-extrabold leading-none tracking-tight">#{tk.orderNumber.split('-').pop()}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-stone">{tk.firstName}{tk.tableLabel && <span>· {tk.tableLabel}</span>} <ChannelTag channel={tk.channel} /></div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-stone">{t('kds.target')}</div>
          <div className="tabular text-2xl font-extrabold">{fmtTime(tk.targetAt, tz, locale)}</div>
        </div>
      </div>
      {tk.overdue && (
        <div className="flex items-center gap-2 rounded-md bg-danger px-3 py-2 text-base font-extrabold text-white"><Icon name="alert" size={20} />{t('kds.overdue', { min: tk.overdueMinutes })}</div>
      )}
      <div className="flex flex-wrap gap-1.5"><StatusBadge status={tk.status} />{tk.recalledCount > 0 && <span className="text-xs font-bold text-warning">{t('kds.recalled', { n: tk.recalledCount })}</span>}</div>
      <Lines lines={tk.lines} />
      {tk.orderNotes && <p className="rounded-md bg-butter px-3 py-2 text-base font-bold">{tk.orderNotes}</p>}
      <div className="mt-auto flex gap-2">
        {tk.status === 'queued' && <button type="button" disabled={disabled} onClick={() => onAct('start')} className="h-14 flex-1 rounded-full border-2 border-ink text-lg font-extrabold disabled:opacity-40">{t('kds.start')}</button>}
        {tk.status !== 'done' && <button type="button" disabled={disabled} onClick={() => onAct('bump')} className="h-14 flex-1 rounded-full bg-ink text-lg font-extrabold text-white disabled:opacity-40">{busy ? t('kds.waitingAck') : t('kds.bump')}</button>}
        {tk.status === 'done' && <button type="button" disabled={disabled} onClick={() => onAct('recall')} className="h-14 flex-1 rounded-full border-2 border-ink text-lg font-extrabold disabled:opacity-40">{busy ? t('kds.waitingAck') : t('kds.recall')}</button>}
      </div>
    </article>
  );
}

function ExpoCard({ o, tz, disabled, busy, onMove }: { o: KdsOrder; tz: string; disabled: boolean; busy: boolean; onMove: (to: string) => void }) {
  const t = useFx();
  const locale = useLocale();
  const next = o.status === 'awaiting_acceptance' ? 'accepted' : o.status === 'accepted' ? 'preparing' : o.status === 'preparing' ? 'ready' : o.status === 'ready' ? (o.channel === 'delivery' ? null : o.channel === 'dine_in' ? 'served' : 'collected') : null;
  return (
    <article className={cx('flex flex-col gap-3 rounded-xl border-[3px] bg-surface p-5', o.overdue ? 'border-danger' : o.status === 'ready' ? 'border-success' : 'border-transparent')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[30px] font-extrabold leading-none tracking-tight">#{o.orderNumber.split('-').pop()}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-stone">{o.firstName}{o.tableLabel && <span>· {o.tableLabel}</span>} <ChannelTag channel={o.channel} /></div>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-stone">{t('kds.promised')}</div>
          <div className="tabular text-2xl font-extrabold">{o.promisedAt ? fmtTime(o.promisedAt, tz, locale) : '—'}</div>
        </div>
      </div>
      {o.overdue && <div className="flex items-center gap-2 rounded-md bg-danger px-3 py-2 text-base font-extrabold text-white"><Icon name="alert" size={20} />{t('kds.overdue', { min: o.overdueMinutes })}</div>}
      <StatusBadge status={o.status} />
      {o.stations.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('kds.stations')}>
          {o.stations.map((s) => <li key={s.ticketId}><StatusBadge status={s.status} label={`${s.name}: ${t(`status.${s.status}`)}`} /></li>)}
        </ul>
      )}
      <Lines lines={o.lines} />
      {o.notes && <p className="rounded-md bg-butter px-3 py-2 text-base font-bold">{o.notes}</p>}
      {o.allStationsDone && o.status === 'preparing' && <p className="text-sm font-bold text-success">{t('kds.allDone')}</p>}
      {next && (
        <button type="button" disabled={disabled} onClick={() => onMove(next)} className="mt-auto h-14 rounded-full bg-ink text-lg font-extrabold text-white disabled:opacity-40">
          {busy ? t('kds.waitingAck') : t(`kds.to.${next}`)}
        </button>
      )}
      {o.status === 'ready' && o.channel === 'delivery' && <p className="text-sm font-semibold text-stone">{t('kds.awaitDriver')}</p>}
    </article>
  );
}
