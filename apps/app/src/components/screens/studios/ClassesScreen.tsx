'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs, cx } from '@bh/ui';
import type { ClassOccurrence } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { FIXTURES } from '@/lib/mock/orgs';
import { addDays, cityOfZone, dateInZone, fmtDay, fmtTime, fmtYmd, weekStart, zoneLabel } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';

type View = 'week' | 'list';

export function ClassesScreen() {
  const t = useTranslations('studios');
  const tOps = useTranslations('ops.studios.classes');
  const locale = useLocale();
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const locs = FIXTURES.studios.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const [locId, setLocId] = useState<string>(locs[0]?.id ?? 'qw');
  const [view, setView] = useState<View>('week');
  const loc = locs.find((l) => l.id === locId) ?? locs[0];
  const tz = loc?.timeZone ?? 'UTC';
  const [ws, setWs] = useState(() => weekStart(dateInZone(new Date(), tz)));
  const [editScope, setEditScope] = useState<'one' | 'series'>('one');
  const openId = params.get('open');

  useEffect(() => {
    if (!locs.some((l) => l.id === locId) && locs[0]) setLocId(locs[0].id);
  }, [app.scopeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const res = useApi((api) => api.studios.classes({ ...app.ctx, scopeId: `loc:${locId}` }, ws), [app.role, locId, ws]);
  const occ = res.status === 'ready' ? res.data.occurrences : [];
  const open = occ.find((o) => o.id === openId);
  const setOpen = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set('open', id);
    else sp.delete('open');
    router.replace(`?${sp.toString()}`, { scroll: false });
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(ws, i)), [ws]);
  const today = dateInZone(new Date(), tz);
  const byDay = (ymd: string) => occ.filter((o) => dateInZone(new Date(o.start), tz) === ymd).sort((a, b) => a.start.localeCompare(b.start));

  return (
    <>
      <PageHeader icon="calendar" title={tOps('title')} description={tOps('description')} actions={<Button icon="plus" onClick={() => router.push('?planned=1')}>{t('newClass')}</Button>} />
      {params.get('planned') && <Banner tone="info">{t('newClassPlanned')}</Banner>}
      <section className="rounded-xl bg-surface p-3.5">
        <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
          <label className="flex h-10 items-center gap-2 rounded-full border border-line-soft px-3 text-[13px] font-semibold">
            <Icon name="pin" size={14} />
            <span className="sr-only">{t('location')}</span>
            <select value={locId} onChange={(e) => setLocId(e.target.value)} className="bg-transparent font-bold focus:outline-none">
              {locs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setWs(addDays(ws, -7))} aria-label={t('prevWeek')} className="flex h-10 w-10 items-center justify-center rounded-full border border-line-soft hover:border-ink">
            <Icon name="chevron-left" size={16} />
          </button>
          <strong className="text-[15px]">
            {fmtYmd(ws, locale, { day: 'numeric', month: 'short' })} – {fmtYmd(addDays(ws, 6), locale, { day: 'numeric', month: 'short' })}
          </strong>
          <button type="button" onClick={() => setWs(addDays(ws, 7))} aria-label={t('nextWeek')} className="flex h-10 w-10 items-center justify-center rounded-full border border-line-soft hover:border-ink">
            <Icon name="chevron-right" size={16} />
          </button>
          <span className="text-xs text-stone">
            {t('timesIn', { zone: `${cityOfZone(tz)} (${zoneLabel(tz, locale)})` })}
          </span>
          <Tabs className="ml-auto" items={[{ key: 'week', label: t('week') }, { key: 'list', label: t('list') }]} value={view} onChange={(v) => setView(v as View)} />
        </div>
        {loc?.sync === 'attention' && (
          <div className="px-1 pb-3">
            <Banner tone="warning" title={t('staleTitle')}>
              {t('staleBody')}
            </Banner>
          </div>
        )}
        <Async res={res} loading={<LoadingBlock variant="calendar" />} isEmpty={(d) => d.occurrences.length === 0} empty={<Empty icon="calendar" title={t('emptyTitle')} body={t('emptyBody')} />}>
          {() =>
            view === 'week' ? (
              <div className="overflow-x-auto pb-1">
                <div className="grid min-w-[980px] grid-cols-7 gap-2">
                  {days.map((d) => (
                    <div key={d} className="flex flex-col gap-1.5">
                      <div className={cx('rounded-[14px] px-2.5 py-2 text-xs font-bold', d === today ? 'bg-lime' : 'bg-canvas')}>
                        {fmtYmd(d, locale)}
                        {d === today && <span className="sr-only"> ({t('today')})</span>}
                      </div>
                      {byDay(d).map((c) => (
                        <ClassCard key={c.id} c={c} tz={tz} onOpen={() => setOpen(c.id)} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {days.flatMap((d) =>
                  byDay(d).map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setOpen(c.id)} className="grid w-full grid-cols-[110px_1fr_auto] items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-3 text-left hover:outline hover:outline-1 hover:outline-ink sm:grid-cols-[160px_1fr_140px_auto]">
                        <span className="tabular text-[13px] font-bold">
                          {fmtDay(c.start, tz, locale)} · {fmtTime(c.start, tz, locale)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold">{c.name}</span>
                          <span className="block truncate text-xs text-stone">
                            {c.instructor} · {c.room}
                          </span>
                        </span>
                        <span className="hidden text-xs font-semibold sm:block">{t('booked', { booked: c.booked, capacity: c.capacity })}</span>
                        <CapBadge c={c} />
                      </button>
                    </li>
                  )),
                )}
              </ul>
            )
          }
        </Async>
      </section>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        kicker={t('classDetail')}
        title={open ? `${open.name} · ${fmtDay(open.start, tz, locale)} ${fmtTime(open.start, tz, locale)}` : ''}
        footer={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="edit" onClick={() => setOpen(null)}>
              {t('saveEdit')}
            </Button>
            {open?.coverRequested && (
              <Link href="/ops/cover" className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[13px] font-bold">
                {t('viewCover')}
              </Link>
            )}
          </div>
        }
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Info label={t('capacity')} value={t('booked', { booked: open.booked, capacity: open.capacity })} pastel="#E9DDF8" />
              <Info label={t('waitlist')} value={String(open.waitlist)} />
              <Info label={t('instructor')} value={open.instructor} />
              <Info label={t('room')} value={open.room} />
              <Info label={t('bookingSource')} value={open.source} />
              <Info label={t('timeZone')} value={`${cityOfZone(tz)} · ${zoneLabel(tz, locale, new Date(open.start))}`} />
            </div>
            {open.booked >= open.capacity && <Banner tone="info">{t('fullWaitlist')}</Banner>}
            <div>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('attendees')}</h3>
              {[['Ava Chen', 'Unlimited'], ['Liam Ortiz', 'Pack · 3 left'], ['Noor Haddad', 'Intro offer']].map(([n, s]) => (
                <div key={n} className="flex items-center gap-2.5 border-b border-canvas py-1.5 text-[13px]">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-[10px] font-extrabold">{n!.split(' ').map((x) => x[0]).join('')}</span>
                  <span className="flex-1">{n}</span>
                  <span className="text-[11px] text-stone">{s}</span>
                </div>
              ))}
              <p className="pt-1.5 text-xs text-stone">{t('more', { count: Math.max(0, open.booked - 3) })}</p>
            </div>
            <div>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('editTime')}</h3>
              <div role="radiogroup" aria-label={t('editTime')} className="flex gap-1.5">
                {(['one', 'series'] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={editScope === k} onClick={() => setEditScope(k)} className={cx('flex-1 rounded-md border-[1.5px] p-2.5 text-left text-xs', editScope === k ? 'border-ink bg-canvas' : 'border-line-soft bg-surface')}>
                    <strong className="block text-[13px]">{t(`editScope.${k}`)}</strong>
                    {k === 'one' ? fmtDay(open.start, tz, locale) : t('editScope.seriesDetail', { day: fmtDay(open.start, tz, locale, { weekday: 'long' }) })}
                  </button>
                ))}
              </div>
              <div className="mt-2">
                <Banner tone="warning" icon="info">
                  {editScope === 'one' ? t('impactOne', { count: open.booked }) : t('impactSeries', { occurrences: 9, bookings: 112 })}
                </Banner>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

function CapBadge({ c }: { c: ClassOccurrence }) {
  const t = useTranslations('studios');
  if (c.coverRequested) return <Badge tone="warning">{t('coverRequested')}</Badge>;
  if (c.booked >= c.capacity) return <Badge tone="info">{t('fullWaitlistShort', { count: c.waitlist })}</Badge>;
  return <Badge tone="success">{t('spots', { count: c.capacity - c.booked })}</Badge>;
}

function ClassCard({ c, tz, onOpen }: { c: ClassOccurrence; tz: string; onOpen: () => void }) {
  const t = useTranslations('studios');
  const locale = useLocale();
  const pct = Math.round((c.booked / c.capacity) * 100);
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-0.5 rounded-md p-2.5 text-left hover:outline hover:outline-1 hover:outline-ink" style={{ background: c.pastel }}>
      <span className="tabular text-[11px] font-bold">{fmtTime(c.start, tz, locale)}</span>
      <span className="text-[13px] font-bold leading-tight">{c.name}</span>
      <span className="text-[11px] text-graphite">{c.instructor}</span>
      <span className="mt-1 block h-[5px] overflow-hidden rounded-full bg-black/10" aria-hidden="true">
        <span className="block h-[5px] bg-ink" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[10px] font-bold text-graphite">
        {t('booked', { booked: c.booked, capacity: c.capacity })}
        {c.coverRequested && ` · ${t('coverRequested')}`}
      </span>
    </button>
  );
}

function Info({ label, value, pastel }: { label: string; value: string; pastel?: string }) {
  return (
    <div className="rounded-[14px] p-2.5" style={{ background: pastel ?? '#F3F2EE' }}>
      <div className="text-stone">{label}</div>
      <strong className="text-sm">{value}</strong>
    </div>
  );
}
