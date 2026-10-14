'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon, cx } from '@bh/ui';
import { useApi, useMutation } from '@/lib/useApi';
import { fmtTime, zoneLabel } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';

export function AttendanceScreen() {
  const t = useTranslations('attendance');
  const tOps = useTranslations('ops.sports.attendance');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.sports.session(app.ctx), [app.role]);
  const [marks, setMarks] = useState<Record<string, 'present' | 'absent'>>({});
  const [done, setDone] = useState<number | null>(null);
  const submit = useMutation((api, id: string, m: Record<string, 'present' | 'absent'>) => api.sports.submitAttendance(id, m));

  return (
    <>
      <PageHeader icon="check-circle" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(s) => {
          const present = Object.values(marks).filter((v) => v === 'present').length;
          const absent = Object.values(marks).filter((v) => v === 'absent').length;
          const unmarked = s.roster.length - present - absent;
          const locked = done !== null;
          return (
            <div className="grid items-start gap-3 lg:grid-cols-2">
              <section className="flex flex-col gap-3 rounded-xl bg-ink p-5 text-white lg:sticky lg:top-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-md bg-lime text-ink">
                    <Icon name="whistle" size={22} />
                  </span>
                  <div>
                    <h2 className="text-lg font-bold">{s.group}</h2>
                    <div className="text-[13px] text-[#B9B9B3]">
                      {fmtTime(s.start, s.timeZone, locale)} {zoneLabel(s.timeZone, locale)} · {s.venue} · {s.coach}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2" aria-live="polite">
                  {[
                    [t('present'), present],
                    [t('absent'), absent],
                    [t('unmarked'), unmarked],
                  ].map(([l, v]) => (
                    <div key={String(l)} className="rounded-md bg-[#262626] p-3">
                      <div className="text-[11px] text-[#B9B9B3]">{l}</div>
                      <div className="text-2xl font-extrabold">{v}</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs leading-normal text-[#B9B9B3]">{t('scopedNote')}</p>
                {!locked ? (
                  <button
                    type="button"
                    disabled={present + absent === 0 || submit.pending}
                    onClick={async () => {
                      const r = await submit.run(s.id, marks);
                      if (r) setDone(r.notifiedGuardians);
                    }}
                    className="h-[52px] rounded-full bg-lime text-[15px] font-extrabold text-ink disabled:opacity-50"
                  >
                    {submit.pending ? t('saving') : unmarked > 0 ? t('saveWithUnmarked', { count: unmarked }) : t('save')}
                  </button>
                ) : (
                  <>
                    <div role="status" className="flex items-center gap-2.5 rounded-lg bg-[#262626] p-3.5 text-sm">
                      <Icon name="check-circle" size={20} />
                      {t('saved', { count: done ?? 0 })}
                    </div>
                    <button type="button" onClick={() => (setDone(null), setMarks({}))} className="h-11 rounded-full border border-[#444] text-[13px] font-semibold">
                      {t('restart')}
                    </button>
                  </>
                )}
                {submit.error && <Banner tone="danger" live="assertive">{submit.error.message}</Banner>}
              </section>
              <section className="flex flex-col gap-1.5 rounded-xl bg-surface p-3" aria-label={t('roster')}>
                {s.roster.map((p) => {
                  const st = marks[p.id];
                  return (
                    <div key={p.id} className={cx('flex items-center gap-2.5 rounded-[18px] py-2 pl-3 pr-2', st === 'present' ? 'bg-lime-soft' : st === 'absent' ? 'bg-blush' : 'bg-canvas-raised')}>
                      <span className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-surface text-xs font-extrabold">{p.name.split(' ').map((x) => x[0]).join('')}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-bold">{p.name}</div>
                        <div className="text-xs text-graphite">{st === 'present' ? t('present') : st === 'absent' ? t('absentNote') : t('notMarked')}</div>
                      </div>
                      <button type="button" disabled={locked} aria-pressed={st === 'present'} aria-label={t('markPresent', { name: p.name })} onClick={() => setMarks((m) => ({ ...m, [p.id]: 'present' }))} className={cx('flex h-12 w-12 items-center justify-center rounded-full', st === 'present' ? 'bg-ink text-white' : 'bg-surface')}>
                        <Icon name="check" size={20} stroke={2.4} />
                      </button>
                      <button type="button" disabled={locked} aria-pressed={st === 'absent'} aria-label={t('markAbsent', { name: p.name })} onClick={() => setMarks((m) => ({ ...m, [p.id]: 'absent' }))} className={cx('flex h-12 w-12 items-center justify-center rounded-full', st === 'absent' ? 'bg-danger text-white' : 'bg-surface')}>
                        <Icon name="x" size={20} stroke={2.4} />
                      </button>
                    </div>
                  );
                })}
              </section>
            </div>
          );
        }}
      </Async>
    </>
  );
}
