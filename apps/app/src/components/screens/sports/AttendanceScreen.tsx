'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, cx } from '@bh/ui';
import { sportsAbsenceReasons } from '@bh/shared';
import { fmtDateTime, fmtTime, zoneLabel } from '@/lib/format';
import type { SRosterEntry } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { useScopeIds } from './ui';

type Mark = 'present' | 'absent' | 'late' | 'excused';
const MARKS: Mark[] = ['present', 'late', 'absent', 'excused'];

/** Fast check-in for an assigned session: authorised roster, absence reasons, guardian alerts (consent-aware). */
export function AttendanceScreen() {
  const t = useTranslations('sportsHub.attendance');
  const tOps = useTranslations('ops.sports.attendance');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const params = useSearchParams();
  const now = Date.now();
  const from = new Date(now - 2 * 86400_000).toISOString();
  const to = new Date(now + 4 * 86400_000).toISOString();
  const coachOnly = !app.can('locations.read');
  const sessions = useSports((c) => c.sessions(scope, from, to, { mine: coachOnly }), [scope.join(','), app.role]);
  const [sessionId, setSessionId] = useState<string | null>(params.get('session'));
  useEffect(() => {
    if (sessionId || !sessions.data?.length) return;
    const live = sessions.data.filter((s) => s.status !== 'cancelled');
    const current = live.find((s) => Date.parse(s.startsAt) <= now && Date.parse(s.endsAt) >= now) ?? live.find((s) => Date.parse(s.startsAt) > now) ?? live.filter((s) => s.attendance.recorded === 0).at(-1) ?? live[0];
    if (current) setSessionId(current.id);
  }, [sessions.data, sessionId, now]);
  const roster = useSports((c) => c.roster(sessionId!), [sessionId], !!sessionId);
  const [marks, setMarks] = useState<Record<string, { status: Mark; reason?: string }>>({});
  const [result, setResult] = useState<{ recorded: number; notifiedGuardians: number; skippedNoConsent: number } | null>(null);
  const save = useSportsAction((c, id: string, m: { participantId: string; status: string; absenceReason?: string }[]) => c.markAttendance(id, m));
  useEffect(() => { setMarks({}); setResult(null); }, [sessionId]);

  const effective = (r: SRosterEntry) => marks[r.id]?.status ?? r.attendance ?? null;
  const submit = async () => {
    const list = Object.entries(marks).map(([participantId, m]) => ({ participantId, status: m.status, ...(m.reason ? { absenceReason: m.reason } : {}) }));
    if (!list.length || !sessionId) return;
    const r = await save.run(sessionId, list);
    if (r) { setResult(r); setMarks({}); roster.reload(); }
  };

  return (
    <>
      <PageHeader icon="check-circle" title={tOps('title')} description={tOps('description')} />
      <Async res={sessions} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="calendar" title={t('noSessions')} body={coachOnly ? t('noSessionsCoach') : undefined} />}>
        {(list) => (
          <>
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label={t('sessions')}>
              {list.map((s) => (
                <button key={s.id} type="button" role="tab" aria-selected={s.id === sessionId} onClick={() => setSessionId(s.id)} className={cx('flex shrink-0 flex-col rounded-lg px-3 py-2 text-left text-xs', s.id === sessionId ? 'bg-ink text-white' : 'bg-surface', s.status === 'cancelled' && 'opacity-60')}>
                  <span className="font-bold">{s.team.name}</span>
                  <span>{fmtDateTime(s.startsAt, s.location.timeZone, locale)}</span>
                  {s.status === 'cancelled' && <span>{t('cancelled')}</span>}
                </button>
              ))}
            </div>
            {!sessionId ? null : (
              <Async res={roster} loading={<LoadingBlock variant="table" rows={6} />}>
                {(r) => {
                  const counts = MARKS.map((m) => [m, r.roster.filter((x) => effective(x) === m).length] as const);
                  const unmarked = r.roster.filter((x) => !effective(x)).length;
                  const cancelled = r.session.status === 'cancelled';
                  return (
                    <div className="grid items-start gap-3 lg:grid-cols-[1fr_1.6fr]">
                      <section className="flex flex-col gap-3 rounded-xl bg-ink p-5 text-white lg:sticky lg:top-3">
                        <div className="flex items-center gap-3">
                          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-lime text-ink"><Icon name={r.session.kind === 'fixture' ? 'trophy' : 'whistle'} size={22} /></span>
                          <div>
                            <h2 className="text-lg font-bold">{r.team.name}</h2>
                            <div className="text-[13px] text-[#B9B9B3]">{fmtTime(r.session.startsAt, r.session.timeZone, locale)} {zoneLabel(r.session.timeZone, locale)} · {r.session.venue ?? '—'}</div>
                          </div>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5" aria-live="polite">
                          {[...counts, ['unmarked', unmarked] as const].map(([l, v]) => (
                            <div key={l} className="rounded-md bg-[#262626] p-2"><div className="text-[10px] text-[#B9B9B3]">{t(`mark.${l}`)}</div><div className="text-xl font-extrabold">{v}</div></div>
                          ))}
                        </div>
                        <p className="text-xs leading-normal text-[#B9B9B3]">{t('scopedNote')}</p>
                        {cancelled ? <p className="font-bold">{t('cancelledSession')}</p> : (
                          <>
                            <Button variant="signal" icon="check" disabled={!Object.keys(marks).length} loading={save.pending} onClick={() => void submit()}>{t('save', { n: Object.keys(marks).length })}</Button>
                            <button type="button" className="text-left text-xs font-bold underline" onClick={() => setMarks((m) => ({ ...Object.fromEntries(r.roster.filter((x) => !effective(x)).map((x) => [x.id, { status: 'present' as Mark }])), ...m }))}>{t('markRestPresent')}</button>
                          </>
                        )}
                        {result && <p role="status" className="rounded-md bg-[#262626] p-2 text-xs">{t('saved', { n: result.recorded, notified: result.notifiedGuardians, skipped: result.skippedNoConsent })}</p>}
                        {save.error && <p role="alert" className="text-xs font-bold text-[#FFB4A8]">{save.error.message}</p>}
                      </section>
                      <ul className="flex flex-col gap-2">
                        {r.roster.length === 0 && <li className="rounded-lg bg-surface p-4 text-sm text-stone">{t('emptyRoster')}</li>}
                        {r.roster.map((p) => {
                          const cur = effective(p);
                          const reason = marks[p.id]?.reason ?? p.absenceReason ?? '';
                          return (
                            <li key={p.id} className="flex flex-col gap-2 rounded-lg bg-surface p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <div className="font-bold">{p.name}</div>
                                  <div className="flex flex-wrap gap-1.5 text-xs text-stone">
                                    {p.reportedBy === 'guardian' && <Badge tone="info" icon="message">{t('guardianReported', { reason: p.absenceReason ? t(`reason.${p.absenceReason}`) : '' })}</Badge>}
                                    {p.care.actionPlan && <Badge tone="warning" icon="heart">{t('actionPlan')}</Badge>}
                                    {p.care.medicalInfoOnFile && !p.care.actionPlan && <Badge tone="neutral" icon="lock">{t('infoOnFile')}</Badge>}
                                  </div>
                                </div>
                                <div className="flex gap-1" role="radiogroup" aria-label={p.name}>
                                  {MARKS.map((m) => (
                                    <button key={m} type="button" role="radio" aria-checked={cur === m} disabled={cancelled} onClick={() => setMarks((s) => ({ ...s, [p.id]: { status: m, reason: m === 'absent' || m === 'excused' ? s[p.id]?.reason : undefined } }))}
                                      className={cx('h-10 min-w-10 rounded-full px-3 text-xs font-bold', cur === m ? (m === 'present' ? 'bg-success text-white' : m === 'absent' ? 'bg-danger text-white' : m === 'late' ? 'bg-warning text-white' : 'bg-info text-white') : 'bg-canvas')}>
                                      {t(`markShort.${m}`)}
                                    </button>
                                  ))}
                                </div>
                              </div>
                              {(cur === 'absent' || cur === 'excused') && (
                                <div className="flex items-center gap-2 text-xs">
                                  <label htmlFor={`rs-${p.id}`} className="text-stone">{t('reasonLabel')}</label>
                                  <select id={`rs-${p.id}`} className="h-9 rounded-xs border border-line px-2" value={reason} onChange={(e) => setMarks((s) => ({ ...s, [p.id]: { status: cur, reason: e.target.value || undefined } }))}>
                                    <option value="">{t('reasonUnknown')}</option>{sportsAbsenceReasons.map((x) => <option key={x} value={x}>{t(`reason.${x}`)}</option>)}
                                  </select>
                                </div>
                              )}
                              {(p.care.emergencyContact || p.care.actionPlan) && (
                                <details className="text-xs"><summary className="cursor-pointer font-bold text-stone">{t('careSummary')}</summary>
                                  {p.care.emergencyContact && <p className="mt-1"><Icon name="phone" size={12} className="mr-1 inline" />{p.care.emergencyContact.name} · {p.care.emergencyContact.phone ?? '—'}</p>}
                                  {p.care.actionPlan && <p className="mt-1"><Icon name="heart" size={12} className="mr-1 inline" />{p.care.actionPlan}</p>}
                                </details>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                }}
              </Async>
            )}
            {result && <Banner tone="success" live="polite">{t('saved', { n: result.recorded, notified: result.notifiedGuardians, skipped: result.skippedNoConsent })}</Banner>}
          </>
        )}
      </Async>
    </>
  );
}
