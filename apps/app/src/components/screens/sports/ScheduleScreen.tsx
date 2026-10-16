'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon, Tabs, cx } from '@bh/ui';
import { addDays, dateInZone, fmtTime, fmtYmd, weekStart, zoneLabel } from '@/lib/format';
import type { SProposal, SSession, STeam } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';
import { FieldLabel, inputCls, useScopeIds } from './ui';

/** Training and fixtures by week (calendar + accessible list), venue clash indicators with suggested resolutions. */
export function ScheduleScreen() {
  const t = useTranslations('sportsHub.schedule');
  const tOps = useTranslations('ops.sports.schedule');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const [week, setWeek] = useState(() => weekStart(new Date().toISOString().slice(0, 10)));
  const [view, setView] = useState<'week' | 'list'>('week');
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState<SSession | null>(null);
  const [create, setCreate] = useState<null | 'fixture' | 'recurring'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const from = new Date(`${addDays(week, -1)}T00:00:00Z`).toISOString();
  const to = new Date(`${addDays(week, 8)}T00:00:00Z`).toISOString();
  const res = useSports(async (c) => ({ sessions: await c.sessions(scope, from, to, { mine }), teams: await c.teams(scope) }), [scope.join(','), week, mine, app.role]);
  const director = app.can('customers.write');
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);

  return (
    <>
      <PageHeader icon="calendar" title={tOps('title')} description={tOps('description')} actions={(
        <>
          <Button variant="secondary" size="sm" icon="trophy" onClick={() => setCreate('fixture')}>{t('addFixture')}</Button>
          {director && <Button variant="secondary" size="sm" icon="repeat" onClick={() => setCreate('recurring')}>{t('addRecurring')}</Button>}
        </>
      )} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="secondary" size="sm" icon="chevron-left" aria-label={t('prevWeek')} onClick={() => setWeek(addDays(week, -7))} />
          <span className="min-w-0 text-center text-sm font-bold sm:min-w-44">{fmtYmd(week, locale, { day: 'numeric', month: 'short' })} – {fmtYmd(addDays(week, 6), locale, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <Button variant="secondary" size="sm" icon="chevron-right" aria-label={t('nextWeek')} onClick={() => setWeek(addDays(week, 7))} />
          <Button variant="ghost" size="sm" onClick={() => setWeek(weekStart(new Date().toISOString().slice(0, 10)))}>{t('thisWeek')}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={mine} onChange={(e) => setMine(e.target.checked)} />{t('mine')}</label>
          <Tabs items={[{ key: 'week', label: t('week') }, { key: 'list', label: t('list') }]} value={view} onChange={setView} />
        </div>
      </div>
      <Async res={res} loading={<LoadingBlock variant="calendar" />}>
        {({ sessions, teams }) => {
          const clashes = sessions.filter((s) => s.venueConflict).length;
          const dayOf = (s: SSession) => dateInZone(new Date(s.startsAt), s.location.timeZone);
          return (
            <>
              {clashes > 0 && <Banner tone="warning" icon="alert" title={t('clashBanner', { n: clashes })}>{t('clashHelp')}</Banner>}
              {view === 'week' ? (
                <div className="grid gap-2 md:grid-cols-7">
                  {days.map((d) => {
                    const list = sessions.filter((s) => dayOf(s) === d);
                    return (
                      <section key={d} className="flex min-h-32 flex-col gap-1.5 rounded-lg bg-surface p-2" aria-label={fmtYmd(d, locale)}>
                        <h3 className={cx('px-1 text-xs font-bold', d === new Date().toISOString().slice(0, 10) ? 'text-ink' : 'text-stone')}>{fmtYmd(d, locale)}</h3>
                        {list.length === 0 && <p className="px-1 text-[11px] text-mute">{t('nothing')}</p>}
                        {list.map((s) => <Chip key={s.id} s={s} locale={locale} onOpen={() => setOpen(s)} />)}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-line-soft rounded-lg bg-surface">
                  {sessions.length === 0 && <li className="p-4 text-sm text-stone">{t('nothingWeek')}</li>}
                  {sessions.map((s) => (
                    <li key={s.id}><button type="button" onClick={() => setOpen(s)} className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left hover:bg-canvas">
                      <span><strong>{fmtYmd(dayOf(s), locale)} {fmtTime(s.startsAt, s.location.timeZone, locale)}</strong> <span className="text-xs text-stone">{zoneLabel(s.location.timeZone, locale)}</span> · {s.team.name}{s.opponent ? ` ${t('vs')} ${s.opponent}` : ''} · {s.venue ?? t('venueTbc')}</span>
                      <StatusBadges s={s} />
                    </button></li>
                  ))}
                </ul>
              )}
              <SessionDrawer s={open} director={director} onClose={() => setOpen(null)} onChanged={(m) => { setMsg(m); setOpen(null); res.reload(); }} />
              <CreateDrawer kind={create} teams={teams} onClose={() => setCreate(null)} onDone={(m) => { setMsg(m); setCreate(null); res.reload(); }} />
            </>
          );
        }}
      </Async>
    </>
  );
}

function StatusBadges({ s }: { s: SSession }) {
  const t = useTranslations('sportsHub.schedule');
  return (
    <span className="flex flex-wrap gap-1">
      {s.kind === 'fixture' && <Badge tone="info" icon="trophy">{s.homeAway ? t(`ha.${s.homeAway}`) : t('fixture')}</Badge>}
      {s.status === 'cancelled' && <Badge tone="danger" icon="x">{t('cancelled')}</Badge>}
      {s.venueConflict && <Badge tone="warning" icon="alert">{t('clash')}</Badge>}
    </span>
  );
}

function Chip({ s, locale, onOpen }: { s: SSession; locale: string; onOpen: () => void }) {
  const t = useTranslations('sportsHub.schedule');
  return (
    <button type="button" onClick={onOpen} className={cx('flex flex-col gap-0.5 rounded-md p-2 text-left text-xs', s.status === 'cancelled' ? 'bg-canvas text-stone line-through' : s.venueConflict ? 'bg-warning-bg ring-1 ring-warning' : s.kind === 'fixture' ? 'bg-info-bg' : 'bg-canvas')}>
      <span className="flex items-center gap-1 font-bold"><Icon name={s.kind === 'fixture' ? 'trophy' : 'whistle'} size={12} />{fmtTime(s.startsAt, s.location.timeZone, locale)} {s.team.name}</span>
      {s.opponent && <span>{t('vs')} {s.opponent}</span>}
      <span className="text-stone">{s.venue ?? t('venueTbc')}</span>
      {s.venueConflict && <span className="flex items-center gap-1 font-bold text-warning"><Icon name="alert" size={11} />{t('clash')}</span>}
      {s.status === 'cancelled' && <span className="no-underline">{t('cancelled')}</span>}
    </button>
  );
}

function SessionDrawer({ s, director, onClose, onChanged }: { s: SSession | null; director: boolean; onClose: () => void; onChanged: (m: string) => void }) {
  const t = useTranslations('sportsHub.schedule');
  const locale = useLocale();
  const app = useApp();
  const [reason, setReason] = useState('');
  const [proposals, setProposals] = useState<SProposal[] | null>(null);
  const resolutions = useSportsAction((c, id: string) => c.resolutions(id));
  const ai = useSportsAction((c, id: string) => c.aiResolutions(id));
  const apply = useSportsAction((c, id: string) => c.applyProposal(id));
  const cancel = useSportsAction((c, id: string, r: string) => c.cancelSession(id, r));
  if (!s) return null;
  const canEdit = director || s.youCoach;
  return (
    <Drawer open onClose={() => { setProposals(null); setReason(''); onClose(); }} title={`${s.team.name}${s.opponent ? ` ${t('vs')} ${s.opponent}` : ''}`} kicker={s.kind === 'fixture' ? t('fixture') : t('training')}>
      <div className="flex flex-col gap-4 text-sm">
        <StatusBadges s={s} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-stone">{t('when')}</dt><dd>{fmtYmd(dateInZone(new Date(s.startsAt), s.location.timeZone), locale)} {fmtTime(s.startsAt, s.location.timeZone, locale)}–{fmtTime(s.endsAt, s.location.timeZone, locale)} {zoneLabel(s.location.timeZone, locale)}</dd>
          <dt className="text-stone">{t('where')}</dt><dd>{s.venue ?? t('venueTbc')} · {s.location.name}</dd>
          {s.competition && <><dt className="text-stone">{t('competition')}</dt><dd>{s.competition}</dd></>}
          <dt className="text-stone">{t('coachLabel')}</dt><dd>{s.team.coach?.name ?? '—'}</dd>
          <dt className="text-stone">{t('rosterLabel')}</dt><dd>{s.rosterCount} · {t('attendanceLine', { present: s.attendance.present, absent: s.attendance.absent, excused: s.attendance.excused })}</dd>
          {s.cancelReason && <><dt className="text-stone">{t('reason')}</dt><dd>{s.cancelReason}</dd></>}
        </dl>
        {s.status !== 'cancelled' && <Link href={`/ops/attendance?session=${s.id}`} className="inline-flex items-center gap-1 font-bold"><Icon name="check-circle" size={15} />{t('openAttendance')}</Link>}
        {s.venueConflict && (
          <section className="flex flex-col gap-2 rounded-lg bg-warning-bg p-3 text-warning">
            <h3 className="flex items-center gap-1.5 font-bold"><Icon name="alert" size={15} />{t('clashWith')}</h3>
            <ul>{s.conflicts.map((c) => <li key={c.sessionId}>{c.teamName} · {fmtTime(c.startsAt, s.location.timeZone, locale)}–{fmtTime(c.endsAt, s.location.timeZone, locale)}</li>)}</ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon="list" loading={resolutions.pending} onClick={async () => setProposals((await resolutions.run(s.id))?.proposals ?? null)}>{t('suggest')}</Button>
              {app.can('ai.use') && director && <Button size="sm" variant="ghost" icon="marina" loading={ai.pending} onClick={async () => { const r = await ai.run(s.id); if (r) setProposals((p) => [...(p ?? []), ...r]); }}>{t('askAi')}</Button>}
            </div>
            {(ai.error || resolutions.error) && <p className="text-xs">{(ai.error ?? resolutions.error)!.message}</p>}
          </section>
        )}
        {proposals && (
          <section className="flex flex-col gap-2">
            <h3 className="font-bold">{t('proposals')}</h3>
            {proposals.length === 0 && <p className="text-stone">{t('noProposals')}</p>}
            {proposals.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft p-3">
                <div>
                  <div className="flex items-center gap-1.5 font-bold">{p.source === 'ai' && <Icon name="marina" size={13} />}{p.proposal.venueName} · {fmtTime(p.proposal.startsAt, s.location.timeZone, locale)}</div>
                  <div className="text-xs text-stone">{p.rationale}</div>
                </div>
                {director && <Button size="sm" loading={apply.pending} onClick={async () => { const r = await apply.run(p.id); if (r) onChanged(t('applied', { n: r.recipients })); }}>{t('apply')}</Button>}
              </div>
            ))}
            {apply.error && <Banner tone="danger" live="assertive">{apply.error.message}</Banner>}
            <p className="text-xs text-stone">{t('proposalNote')}</p>
          </section>
        )}
        {canEdit && s.status !== 'cancelled' && (
          <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <FieldLabel htmlFor="cancel-reason">{t('cancelReason')}</FieldLabel>
            <input id="cancel-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            {cancel.error && <p className="text-xs font-bold text-danger">{cancel.error.message}</p>}
            <Button size="sm" variant="danger" disabled={reason.trim().length < 3} loading={cancel.pending} onClick={async () => { const r = await cancel.run(s.id, reason); if (r) onChanged(t('cancelledMsg', { n: r.recipients, team: s.team.name })); }}>{t('cancel')}</Button>
            <p className="text-xs text-stone">{t('cancelScope', { team: s.team.name })}</p>
          </section>
        )}
      </div>
    </Drawer>
  );
}

function CreateDrawer({ kind, teams, onClose, onDone }: { kind: null | 'fixture' | 'recurring'; teams: STeam[]; onClose: () => void; onDone: (m: string) => void }) {
  const t = useTranslations('sportsHub.schedule');
  const app = useApp();
  const usable = teams.filter((x) => app.can('customers.write') || x.youCoach);
  const [teamId, setTeamId] = useState('');
  const team = usable.find((x) => x.id === teamId) ?? usable[0];
  const venues = useSports((c) => c.venues(team!.locationId), [team?.locationId], !!team && !!kind);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ opponent: '', homeAway: 'home' as 'home' | 'away' | 'neutral', date: addDays(today, 7), kickoff: '10:00', duration: 90, venueId: '', venueName: '', competition: '', weekdays: [2, 4] as number[], start: '17:30', from: today, until: addDays(today, 56), skip: true });
  const fixture = useSportsAction((c, id: string, input: Parameters<typeof c.createFixture>[1]) => c.createFixture(id, input));
  const recurring = useSportsAction((c, id: string, input: Parameters<typeof c.createRecurring>[1]) => c.createRecurring(id, input));
  if (!kind || !team) return null;
  const tz = app.locations.find((l) => l.id === team.locationId)?.timeZone ?? 'UTC';
  const submit = async () => {
    if (kind === 'fixture') {
      const r = await fixture.run(team.id, { opponent: f.opponent, homeAway: f.homeAway, date: f.date, kickoff: f.kickoff, durationMinutes: f.duration, ...(f.homeAway === 'home' ? { venueId: f.venueId || undefined } : { venueName: f.venueName || undefined }), competition: f.competition || undefined });
      if (r) onDone(r.venueConflicts.length ? t('fixtureClash') : t('fixtureAdded'));
    } else {
      const r = await recurring.run(team.id, { weekdays: f.weekdays, startTime: f.start, durationMinutes: f.duration, from: f.from, until: f.until, venueId: f.venueId || undefined, skipConflicts: f.skip });
      if (r) onDone(t('recurringAdded', { n: r.created, skipped: r.conflicts.length }));
    }
  };
  const err = fixture.error ?? recurring.error;
  return (
    <Drawer open onClose={onClose} title={kind === 'fixture' ? t('addFixture') : t('addRecurring')} footer={<Button className="w-full" loading={fixture.pending || recurring.pending} onClick={() => void submit()}>{t('save')}</Button>}>
      <div className="flex flex-col gap-3 text-sm">
        {err && <Banner tone="danger" live="assertive" title={err.message}>{err.fields && Object.values(err.fields).join(' · ')}</Banner>}
        <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-team">{t('team')}</FieldLabel><select id="cr-team" className={inputCls} value={team.id} onChange={(e) => setTeamId(e.target.value)}>{usable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <p className="text-xs text-stone">{t('localTime', { tz })}</p>
        {kind === 'fixture' ? (
          <>
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-opp">{t('opponent')}</FieldLabel><input id="cr-opp" className={inputCls} value={f.opponent} onChange={(e) => setF({ ...f, opponent: e.target.value })} /></div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-ha">{t('homeAway')}</FieldLabel><select id="cr-ha" className={inputCls} value={f.homeAway} onChange={(e) => setF({ ...f, homeAway: e.target.value as 'home' })}>{(['home', 'away', 'neutral'] as const).map((x) => <option key={x} value={x}>{t(`ha.${x}`)}</option>)}</select></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-date">{t('date')}</FieldLabel><input id="cr-date" type="date" className={inputCls} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-ko">{t('kickoff')}</FieldLabel><input id="cr-ko" type="time" className={inputCls} value={f.kickoff} onChange={(e) => setF({ ...f, kickoff: e.target.value })} /></div>
            </div>
            {f.homeAway === 'home'
              ? <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-v">{t('venue')}</FieldLabel><select id="cr-v" className={inputCls} value={f.venueId} onChange={(e) => setF({ ...f, venueId: e.target.value })}><option value="">{t('chooseVenue')}</option>{(venues.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
              : <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-vn">{t('ground')}</FieldLabel><input id="cr-vn" className={inputCls} value={f.venueName} onChange={(e) => setF({ ...f, venueName: e.target.value })} /></div>}
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-comp">{t('competition')}</FieldLabel><input id="cr-comp" className={inputCls} value={f.competition} onChange={(e) => setF({ ...f, competition: e.target.value })} /></div>
          </>
        ) : (
          <>
            <fieldset className="flex flex-wrap gap-2"><legend className="mb-1 text-[13px] font-bold">{t('weekdays')}</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => <label key={d} className="flex items-center gap-1"><input type="checkbox" checked={f.weekdays.includes(d)} onChange={(e) => setF({ ...f, weekdays: e.target.checked ? [...f.weekdays, d] : f.weekdays.filter((x) => x !== d) })} />{t(`wd.${d}`)}</label>)}
            </fieldset>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-st">{t('start')}</FieldLabel><input id="cr-st" type="time" className={inputCls} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-from">{t('from')}</FieldLabel><input id="cr-from" type="date" className={inputCls} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-until">{t('until')}</FieldLabel><input id="cr-until" type="date" className={inputCls} value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} /></div>
            </div>
            <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-v2">{t('venue')}</FieldLabel><select id="cr-v2" className={inputCls} value={f.venueId} onChange={(e) => setF({ ...f, venueId: e.target.value })}><option value="">{t('chooseVenue')}</option>{(venues.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.skip} onChange={(e) => setF({ ...f, skip: e.target.checked })} />{t('skipClashes')}</label>
          </>
        )}
        <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="cr-dur">{t('duration')}</FieldLabel><input id="cr-dur" type="number" min={15} max={300} className={inputCls} value={f.duration} onChange={(e) => setF({ ...f, duration: Number(e.target.value) })} /></div>
      </div>
    </Drawer>
  );
}
