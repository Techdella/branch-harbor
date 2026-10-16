'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { SURVEY_AUDIENCES, SURVEY_QUESTION_TYPES, SURVEY_RECURRENCES, type SurveyBody, type SurveyQuestion } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { download, fdevApi, useAction, useLoad, type ResultsVM, type RespondVM, type SurveyListVM, type SurveyVM } from './api';
import { ActionError, Bar, StatusBadge, Tiles, useFmt } from './ui';

/** Community → Surveys: surveys to answer, and (HQ) surveys to write, launch and read. */
export function SurveysScreen() {
  const t = useTranslations('fdev');
  const app = useApp();
  const res = useLoad(() => fdevApi.surveys(), [app.org.id]);
  const [editing, setEditing] = useState<SurveyBody | null>(null);
  const act = useAction();
  const router = useRouter();
  return (
    <>
      <PageHeader icon="chart" title={t('surveys.title')} description={t('surveys.description')} scope={false}
        actions={res.data?.can.manage ? <Button size="sm" icon="plus" onClick={() => setEditing(res.data!.starter)}>{t('surveys.new')}</Button> : undefined} />
      <ActionError error={act.error} />
      {editing && (
        <SurveyEditor value={editing} onCancel={() => setEditing(null)} onSave={async (b) => {
          const r = await act.run(() => fdevApi.createSurvey(b));
          if (r) { setEditing(null); res.reload(); }
        }} pending={act.pending} />
      )}
      <Async res={res} loading={<LoadingBlock variant="cards" />}>
        {(d) => (
          <>
            <ToAnswer d={d} />
            {d.can.results && <SurveyList d={d} onLaunch={async (id) => { if (await act.run(() => fdevApi.launchSurvey(id))) res.reload(); }} onOpen={(id) => router.push(`/surveys/${id}`)} />}
            <ValidatorInvite />
          </>
        )}
      </Async>
    </>
  );
}

function ToAnswer({ d }: { d: SurveyListVM }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  if (!d.toAnswer.length) return d.can.results ? null : <Empty icon="chart" title={t('surveys.nothingToAnswer')} body={t('surveys.nothingToAnswerBody')} />;
  return (
    <SectionCard title={t('surveys.toAnswer')}>
      <ul className="flex flex-col divide-y divide-line-soft">
        {d.toAnswer.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span>
              <strong>{s.title}</strong>
              <span className="block text-xs text-stone">{t('surveys.closes', { date: f.date(s.closesOn) })}{s.anonymous ? ` · ${t('surveys.anonymous')}` : ''}</span>
            </span>
            {s.answered ? <Badge tone="success" icon="check">{t('surveys.answered')}</Badge> : <Link className="inline-flex h-10 items-center rounded-full bg-ink px-4 text-[13px] font-bold text-white" href={`/surveys/${s.id}/respond`}>{t('surveys.answer')}</Link>}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function SurveyList({ d, onLaunch, onOpen }: { d: SurveyListVM; onLaunch: (id: string) => void; onOpen: (id: string) => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  if (!d.surveys.length) return <Empty icon="chart" title={t('surveys.empty')} body={d.can.manage ? t('surveys.emptyBody') : undefined} />;
  return (
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
      {d.surveys.map((s) => {
        const last = s.rounds[s.rounds.length - 1];
        return (
          <article key={s.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
            <div className="flex items-start justify-between gap-2"><h3 className="text-[15px] font-extrabold">{s.title}</h3><StatusBadge status={s.status} /></div>
            <p className="text-xs text-stone">{[t(`recurrence.${s.recurrence}`), s.anonymous ? t('surveys.anonymousMin', { count: s.minResponses }) : t('surveys.named'), t('surveys.questionCount', { count: s.questions.length })].join(' · ')}</p>
            {last && <p className="text-[13px]">{t('surveys.lastRound', { label: last.label, invited: last.invited })} <StatusBadge status={last.status} /></p>}
            {s.nextRunOn && <p className="text-xs text-stone">{t('surveys.nextRound', { date: f.date(s.nextRunOn) })}</p>}
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              {s.rounds.length > 0 && <Button size="sm" variant="secondary" icon="chart" onClick={() => onOpen(s.id)}>{t('surveys.results')}</Button>}
              {d.can.manage && !s.openRoundId && s.status !== 'archived' && <Button size="sm" icon="send" onClick={() => onLaunch(s.id)}>{s.rounds.length ? t('surveys.launchAgain') : t('surveys.launch')}</Button>}
            </div>
          </article>
        );
      })}
    </section>
  );
}

/** Franchisees can volunteer for validation calls with prospective franchisees. */
function ValidatorInvite() {
  const t = useTranslations('fdev');
  const res = useLoad(() => fdevApi.validatorMe(), []);
  if (!res.data?.eligible) return null;
  return (
    <Banner tone="neutral" icon="phone" title={t('validation.inviteTitle')} action={<Link className="text-[13px] font-bold underline" href="/franchise/validation">{res.data.validator?.active ? t('validation.inviteManage') : t('validation.inviteCta')}</Link>}>
      {t('validation.inviteBody')}
    </Banner>
  );
}

export function SurveyEditor({ value, onSave, onCancel, pending }: { value: SurveyBody; onSave: (b: SurveyBody) => void; onCancel: () => void; pending: boolean }) {
  const t = useTranslations('fdev');
  const [v, setV] = useState<SurveyBody>(value);
  const setQ = (i: number, q: Partial<SurveyQuestion>) => setV((s) => ({ ...s, questions: s.questions.map((x, j) => (j === i ? { ...x, ...q } : x)) }));
  return (
    <SectionCard title={t('surveys.editor')}>
      <div className="flex flex-col gap-3">
        <Field label={t('surveys.titleField')}>{(x) => <Input id={x.id} value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} />}</Field>
        <Field label={t('surveys.intro')} optional>{(x) => <Textarea id={x.id} rows={2} value={v.description ?? ''} onChange={(e) => setV((s) => ({ ...s, description: e.target.value || null }))} />}</Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('surveys.audience')}>{(x) => <Select id={x.id} value={v.audience} onChange={(e) => setV((s) => ({ ...s, audience: e.target.value as SurveyBody['audience'] }))}>{SURVEY_AUDIENCES.map((a) => <option key={a} value={a}>{t(`audience.${a}`)}</option>)}</Select>}</Field>
          <Field label={t('surveys.recurrence')}>{(x) => <Select id={x.id} value={v.recurrence} onChange={(e) => setV((s) => ({ ...s, recurrence: e.target.value as SurveyBody['recurrence'] }))}>{SURVEY_RECURRENCES.map((a) => <option key={a} value={a}>{t(`recurrence.${a}`)}</option>)}</Select>}</Field>
          <Field label={t('surveys.openDays')}>{(x) => <Input id={x.id} type="number" min={1} max={60} value={v.openDays} onChange={(e) => setV((s) => ({ ...s, openDays: Number(e.target.value) || 14 }))} />}</Field>
          <Field label={t('surveys.minResponses')} hint={t('surveys.minResponsesHint')}>{(x) => <Input id={x.id} type="number" min={3} max={50} value={v.minResponses} onChange={(e) => setV((s) => ({ ...s, minResponses: Number(e.target.value) || 5 }))} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]"><Toggle checked={v.anonymous} onChange={(b) => setV((s) => ({ ...s, anonymous: b }))} label={t('surveys.anonymousToggle')} /><span aria-hidden="true">{t('surveys.anonymousToggle')}</span></label>
        <ol className="flex flex-col gap-2">
          {v.questions.map((q, i) => (
            <li key={q.id} className="grid gap-2 rounded-md bg-canvas p-3 sm:grid-cols-[1fr_140px_auto]">
              <Field label={t('surveys.question', { n: i + 1 })}>{(x) => <Input id={x.id} value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} />}</Field>
              <Field label={t('surveys.type')}>{(x) => <Select id={x.id} value={q.type} onChange={(e) => setQ(i, { type: e.target.value as SurveyQuestion['type'], options: e.target.value === 'choice' ? (q.options.length ? q.options : ['', '']) : [] })}>{SURVEY_QUESTION_TYPES.map((a) => <option key={a} value={a}>{t(`questionType.${a}`)}</option>)}</Select>}</Field>
              <Button className="self-end" size="sm" variant="ghost" icon="x" aria-label={t('surveys.removeQuestion', { n: i + 1 })} onClick={() => setV((s) => ({ ...s, questions: s.questions.filter((_, j) => j !== i) }))} />
              {q.type === 'choice' && <Field label={t('surveys.options')} hint={t('surveys.optionsHint')}>{(x) => <Input id={x.id} value={q.options.join(', ')} onChange={(e) => setQ(i, { options: e.target.value.split(',').map((o) => o.trim()) })} />}</Field>}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setV((s) => ({ ...s, questions: [...s.questions, { id: `q${Date.now().toString(36)}`, type: 'scale', label: '', required: true, options: [], theme: null }] }))}>{t('surveys.addQuestion')}</Button>
        </div>
        <div className="flex gap-2">
          <Button icon="check" loading={pending} disabled={!v.title.trim() || !v.questions.length || v.questions.some((q) => !q.label.trim())} onClick={() => onSave({ ...v, questions: v.questions.map((q) => ({ ...q, options: q.options.filter(Boolean) })) })}>{t('surveys.saveDraft')}</Button>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </div>
    </SectionCard>
  );
}

/* -------------------------------- results -------------------------------- */

export function SurveyResultsScreen({ id }: { id: string }) {
  const t = useTranslations('fdev');
  const app = useApp();
  const [roundId, setRoundId] = useState<string | undefined>(undefined);
  const res = useLoad(() => fdevApi.results(id, roundId), [app.org.id, id, roundId]);
  const act = useAction();
  return (
    <>
      <PageHeader icon="chart" title={res.data?.survey.title ?? t('surveys.results')} description={t('surveys.resultsDescription')} scope={false}
        actions={res.data?.round && res.data.round.visible ? <Button size="sm" variant="ghost" icon="download" onClick={() => void download(`/surveys/${id}/results.csv`, `survey-${res.data!.round!.opensOn}.csv`, { roundId: res.data!.round!.roundId })}>{t('common.exportCsv')}</Button> : undefined} />
      <ActionError error={act.error} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(d) => (
          <>
            {d.survey.rounds.length > 1 && (
              <div className="w-56"><Field label={t('surveys.round')}>{(x) => (
                <Select id={x.id} value={d.round?.roundId ?? ''} onChange={(e) => setRoundId(e.target.value)}>
                  {d.survey.rounds.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </Select>
              )}</Field></div>
            )}
            {d.scope === 'partial' && <Banner tone="neutral" icon="info">{t('surveys.partialScope')}</Banner>}
            {d.round ? <RoundView d={d} /> : <Empty icon="chart" title={t('surveys.noRounds')} />}
            <ActionPlans d={d} id={id} onChanged={res.reload} />
          </>
        )}
      </Async>
    </>
  );
}

function RoundView({ d }: { d: ResultsVM }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const r = d.round!;
  if (!r.visible) return <Banner tone="warning" icon="lock" title={t('surveys.belowThreshold', { count: r.responses, min: r.minResponses })}>{t('surveys.belowThresholdBody')}</Banner>;
  const maxTrend = 100;
  return (
    <div className="flex flex-col gap-4" data-testid="survey-results">
      <Tiles items={[
        { label: t('surveys.enps'), value: r.nps?.score ?? '—', sub: r.nps ? t('surveys.npsBreakdown', { promoters: r.nps.promoters, passives: r.nps.passives, detractors: r.nps.detractors }) : undefined, tone: r.nps && r.nps.score !== null && r.nps.score < 0 ? 'danger' : undefined },
        { label: t('surveys.responses'), value: r.responses, sub: r.responseRate !== null ? t('surveys.rate', { rate: r.responseRate, invited: r.invited }) : undefined },
        ...((r.themes ?? []).map((th) => ({ label: t('surveys.themeAvg', { theme: t(`theme.${th.theme}` as 'theme.support') }), value: th.average === null ? '—' : f.num(th.average, 1), sub: t('surveys.outOf5') }))),
      ]} />
      {d.trend.length > 1 && (
        <SectionCard title={t('surveys.trend')}>
          <ul className="flex items-end gap-3" aria-label={t('surveys.trend')}>
            {d.trend.map((x) => (
              <li key={x.roundId} className="flex flex-col items-center gap-1 text-xs">
                <span className="tabular font-bold">{x.nps ?? '—'}</span>
                <span className="flex h-24 w-8 items-end rounded-sm bg-canvas"><span className={cx('w-full rounded-sm', (x.nps ?? 0) < 0 ? 'bg-danger' : 'bg-ink')} style={{ height: `${x.nps === null ? 0 : Math.max(4, ((x.nps + 100) / 200) * 96)}px` }} /></span>
                <span className="text-stone">{x.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone">{t('surveys.trendHint', { max: maxTrend })}</p>
        </SectionCard>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('surveys.questions')}>
          <ul className="flex flex-col gap-3">
            {r.questions.filter((q) => q.type !== 'text').map((q) => (
              <li key={q.id} className="text-[13px]">
                <div className="flex justify-between gap-2"><span className="font-bold">{q.label}</span><span className="tabular whitespace-nowrap">{q.type === 'nps' ? t('surveys.npsShort', { score: q.nps?.score ?? '—' }) : q.average != null ? `${f.num(q.average, 1)} / 5` : ''}</span></div>
                {q.type === 'scale' && q.average != null && <Bar value={q.average / 5} label={`${q.average} / 5`} />}
                {q.type === 'nps' && q.distribution && (
                  <span className="mt-1 flex h-10 items-end gap-[3px]" role="img" aria-label={q.distribution.map((n, i) => `${i}: ${n}`).join(', ')}>
                    {q.distribution.map((n, i) => <span key={i} title={`${i}: ${n}`} className={cx('w-4 rounded-sm', i >= 9 ? 'bg-[#2E9E5B]' : i <= 6 ? 'bg-danger' : 'bg-line')} style={{ height: Math.max(3, (n / Math.max(1, ...q.distribution!)) * 40) }} />)}
                  </span>
                )}
                {q.options && <ul className="mt-1 flex flex-wrap gap-1.5">{q.options.map((o) => <li key={o.option}><Badge tone="neutral">{o.option} · {o.count}</Badge></li>)}</ul>}
              </li>
            ))}
          </ul>
        </SectionCard>
        <div className="flex flex-col gap-4">
          {(['byRegion', 'byOwnerGroup'] as const).map((k) => r[k].length > 0 && (
            <SectionCard key={k} title={t(`surveys.${k}`)}>
              <table className="w-full text-[13px]">
                <thead><tr className="text-left text-xs text-stone"><th className="py-1">{t('surveys.group')}</th><th className="py-1 text-end">{t('surveys.responses')}</th><th className="py-1 text-end">{t('surveys.enps')}</th></tr></thead>
                <tbody>
                  {r[k].map((g) => (
                    <tr key={g.id} className="border-t border-line-soft">
                      <td className="py-1.5 font-semibold">{g.name}</td>
                      <td className="tabular py-1.5 text-end">{g.responses}</td>
                      <td className="tabular py-1.5 text-end">{g.visible ? (g.nps ?? '—') : <span className="text-xs text-stone">{t('surveys.hiddenSlice')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          ))}
          <SectionCard title={t('surveys.comments')}>
            {r.comments.length ? <ul className="flex flex-col gap-2">{r.comments.map((c, i) => <li key={i} className="rounded-md bg-canvas p-3 text-[13px]">“{c.text}”</li>)}</ul> : <p className="text-[13px] text-stone">{t('surveys.noComments')}</p>}
            {r.anonymous && <p className="mt-2 text-xs text-stone">{t('surveys.commentsAnon')}</p>}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function ActionPlans({ d, id, onChanged }: { d: ResultsVM; id: string; onChanged: () => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const act = useAction();
  const [v, setV] = useState({ title: '', theme: '', dueOn: '' });
  const themes = [...new Set(d.survey.questions.map((q) => q.theme).filter((x): x is string => !!x))];
  return (
    <SectionCard title={t('surveys.actionPlans')}>
      <ActionError error={act.error} />
      {d.actions.length ? (
        <ul className="flex flex-col divide-y divide-line-soft">
          {d.actions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
              <span><strong>{a.title}</strong><span className="block text-xs text-stone">{[a.theme ? t(`theme.${a.theme}` as 'theme.support') : null, a.dueOn ? t('surveys.due', { date: f.date(a.dueOn) }) : null, a.ownerName].filter(Boolean).join(' · ')}</span></span>
              <Select aria-label={t('surveys.actionStatusOf', { title: a.title })} className="h-9 w-40!" value={a.status} onChange={async (e) => { if (await act.run(() => fdevApi.updateAction(id, a.id, { status: e.target.value as 'open' }))) onChanged(); }}>
                {(['open', 'in_progress', 'done'] as const).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
              </Select>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-stone">{t('surveys.noActions')}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1"><Field label={t('surveys.actionTitle')}>{(x) => <Input id={x.id} value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} />}</Field></div>
        <div className="w-40"><Field label={t('surveys.themeField')} optional>{(x) => <Select id={x.id} value={v.theme} onChange={(e) => setV((s) => ({ ...s, theme: e.target.value }))}><option value="">—</option>{themes.map((th) => <option key={th} value={th}>{t(`theme.${th}` as 'theme.support')}</option>)}</Select>}</Field></div>
        <div className="w-40"><Field label={t('surveys.dueField')} optional>{(x) => <Input id={x.id} type="date" value={v.dueOn} onChange={(e) => setV((s) => ({ ...s, dueOn: e.target.value }))} />}</Field></div>
        <Button icon="plus" disabled={!v.title.trim()} loading={act.pending} onClick={async () => { if (await act.run(() => fdevApi.addAction(id, { title: v.title.trim(), theme: v.theme || null, dueOn: v.dueOn || null, roundId: d.round?.roundId ?? null }))) { setV({ title: '', theme: '', dueOn: '' }); onChanged(); } }}>{t('surveys.addAction')}</Button>
      </div>
    </SectionCard>
  );
}

/* ------------------------------- answering ------------------------------- */

export function SurveyRespondScreen({ id }: { id: string }) {
  const t = useTranslations('fdev');
  const app = useApp();
  const res = useLoad(() => fdevApi.respondForm(id), [app.org.id, id]);
  return (
    <>
      <PageHeader icon="chart" title={res.data?.title ?? t('surveys.title')} scope={false} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>{(d) => <RespondForm d={d} id={id} />}</Async>
    </>
  );
}

function RespondForm({ d, id }: { d: RespondVM; id: string }) {
  const t = useTranslations('fdev');
  const act = useAction();
  const [a, setA] = useState<Record<string, number | string | null>>({});
  const [done, setDone] = useState(d.answered);
  if (done) return <Empty icon="check-circle" title={t('surveys.thanks')} body={d.anonymous ? t('surveys.thanksAnon', { min: d.minResponses }) : undefined} />;
  const missing = d.questions.filter((q) => q.required && (a[q.id] === undefined || a[q.id] === null || a[q.id] === ''));
  return (
    <form className="flex max-w-3xl flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => fdevApi.respond(id, a))) setDone(true); }}>
      {d.description && <p className="text-[14px] text-graphite">{d.description}</p>}
      {d.anonymous && <Banner tone="neutral" icon="lock">{t('surveys.anonNote', { min: d.minResponses })}</Banner>}
      {d.questions.map((q, i) => (
        <fieldset key={q.id} className="rounded-xl bg-surface p-4">
          <legend className="sr-only">{q.label}</legend>
          <p className="mb-2 text-[14px] font-bold">{i + 1}. {q.label}{!q.required && <span className="ms-1 text-xs font-normal text-stone">{t('surveys.optional')}</span>}</p>
          {(q.type === 'nps' || q.type === 'scale') && (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={q.label}>
              {(q.type === 'nps' ? Array.from({ length: 11 }, (_, n) => n) : [1, 2, 3, 4, 5]).map((n) => (
                <button key={n} type="button" role="radio" aria-checked={a[q.id] === n} onClick={() => setA((s) => ({ ...s, [q.id]: n }))} className={cx('h-11 w-11 rounded-full text-[14px] font-bold', a[q.id] === n ? 'bg-ink text-white' : 'bg-canvas')}>{n}</button>
              ))}
              <span className="mt-1 flex w-full justify-between text-xs text-stone"><span>{q.type === 'nps' ? t('surveys.npsLow') : t('surveys.scaleLow')}</span><span>{q.type === 'nps' ? t('surveys.npsHigh') : t('surveys.scaleHigh')}</span></span>
            </div>
          )}
          {q.type === 'choice' && (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={q.label}>
              {q.options.map((o) => <button key={o} type="button" role="radio" aria-checked={a[q.id] === o} onClick={() => setA((s) => ({ ...s, [q.id]: o }))} className={cx('h-10 rounded-full px-4 text-[13px] font-bold', a[q.id] === o ? 'bg-ink text-white' : 'bg-canvas')}>{o}</button>)}
            </div>
          )}
          {q.type === 'text' && <Textarea aria-label={q.label} rows={3} value={(a[q.id] as string) ?? ''} onChange={(e) => setA((s) => ({ ...s, [q.id]: e.target.value }))} />}
        </fieldset>
      ))}
      <ActionError error={act.error} />
      <div><Button type="submit" icon="send" disabled={missing.length > 0} loading={act.pending}>{t('surveys.submit')}</Button></div>
    </form>
  );
}

export type { SurveyVM };
