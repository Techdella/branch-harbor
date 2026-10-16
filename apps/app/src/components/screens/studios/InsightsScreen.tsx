'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Tabs } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { AiAttendance, AiAudience, AiDescription } from '@/lib/studios/types';
import { fmtYmd, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { useScopeLabel } from '../../shell/ScopePicker';
import { Banner, DeniedState, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, StudioAsync, fmtMoney, inputCls } from './shared';
import { reportSourceKey } from '@/lib/msg';
import { useDataText } from '../../ui/useDataText';

const BAR = '#141414';

/** Single-series bar list: label · bar · value. Values are text (never colour alone); missing data reads "Unavailable". */
function Bars({ rows, unit, label }: { rows: Array<{ key: string; label: string; value: number | null; sub?: string }>; unit: '%' | ''; label: string }) {
  const t = useTranslations('studiosFull.insights');
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <figure aria-label={label}>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(90px,30%)_1fr_auto] items-center gap-2 text-xs" title={`${r.label}: ${r.value === null ? t('unavailable') : `${r.value}${unit}`}`}>
            <span className="truncate font-semibold">{r.label}</span>
            <span className="h-3 rounded-full bg-canvas">
              {r.value !== null && <span className="block h-3 rounded-full" style={{ width: `${Math.max(2, (r.value / (unit === '%' ? 100 : max)) * 100)}%`, background: BAR }} />}
            </span>
            <span className="w-24 text-right tabular font-bold">{r.value === null ? t('unavailable') : `${r.value}${unit}`}{r.sub && <span className="block text-[10px] font-medium text-stone">{r.sub}</span>}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function InsightsScreen() {
  const t = useTranslations('studiosFull.insights');
  const dt = useDataText();
  const locale = useLocale();
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const [weeks, setWeeks] = useState(8);
  const single = app.scope.locationIds.length === 1 ? app.scope.locationIds[0] : undefined;
  const res = useStudio((api) => api.reports(single, weeks), [single, weeks, app.role], app.can('reports.read'));
  if (!app.can('reports.read')) return <DeniedState permission="reports.read" />;
  return (
    <>
      <PageHeader icon="chart" title={t('title')} description={t('description')} actions={<Tabs items={[4, 8, 12].map((w) => ({ key: String(w), label: t('weeksN', { n: w }) }))} value={String(weeks)} onChange={(k) => setWeeks(Number(k))} />} />
      <StudioAsync res={res} loading={<LoadingBlock variant="detail" />}>
        {(r) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <h2 className="text-base font-bold">{t('occupancyByLocation')}</h2>
              <Bars label={t('occupancyByLocation')} unit="%" rows={r.occupancy.byLocation.map((l) => ({ key: l.locationId, label: l.locationName, value: l.occupancyPct, sub: l.classes ? t('bookedOf', { booked: l.booked, capacity: l.capacity }) : t('noClasses') }))} />
              <p className="text-[11px] text-stone">{dt('studioReport.definition.occupancy', undefined, r.definitions.occupancy ?? '')}</p>
            </section>
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <h2 className="text-base font-bold">{t('occupancyByType')}</h2>
              <Bars label={t('occupancyByType')} unit="%" rows={r.occupancy.byClassType.map((c) => ({ key: c.classTypeId, label: c.name, value: c.occupancyPct, sub: t('classesN', { n: c.classes }) }))} />
            </section>
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <h2 className="text-base font-bold">{t('attendanceTrend')}</h2>
              <Bars label={t('attendanceTrend')} unit="%" rows={r.attendance.map((w) => ({ key: w.weekStart, label: t('weekOf', { date: fmtYmd(w.weekStart, locale, { day: 'numeric', month: 'short' }) }), value: w.attendanceRatePct, sub: t('attendedNoShow', { a: w.attended, n: w.noShow }) }))} />
              <details className="text-xs"><summary className="cursor-pointer font-bold">{t('table')}</summary>
                <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="mt-2 w-full text-left"><thead><tr className="text-stone"><th scope="col">{t('week')}</th><th scope="col">{t('booked')}</th><th scope="col">{t('attended')}</th><th scope="col">{t('noShows')}</th><th scope="col">{t('lateCancels')}</th><th scope="col">{t('unrecorded')}</th></tr></thead>
                  <tbody>{r.attendance.map((w) => <tr key={w.weekStart} className="border-t border-line-soft tabular"><td>{w.weekStart}</td><td>{w.booked}</td><td>{w.attended}</td><td>{w.noShow}</td><td>{w.lateCancel}</td><td>{w.unrecorded}</td></tr>)}</tbody></table></div>
              </details>
              <p className="text-[11px] text-stone">{dt('studioReport.definition.attendance', undefined, r.definitions.attendance ?? '')}</p>
            </section>
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
              <h2 className="text-base font-bold">{t('churn')}</h2>
              <div className="max-w-full overflow-x-auto" tabIndex={0}><table className="w-full text-left text-sm">
                <thead><tr className="text-xs text-stone"><th scope="col">{t('month')}</th><th scope="col">{t('activeStart')}</th><th scope="col">{t('started')}</th><th scope="col">{t('ended')}</th><th scope="col">{t('churnRate')}</th></tr></thead>
                <tbody>{r.churn.map((c) => <tr key={c.month} className="border-t border-line-soft tabular"><td className="py-1.5">{c.month}</td><td>{c.activeAtStart}</td><td>{c.started}</td><td>{c.cancelled}</td><td className="font-bold">{c.churnRatePct === null ? t('unavailable') : `${c.churnRatePct}%`}</td></tr>)}</tbody>
              </table></div>
              <p className="text-[11px] text-stone">{dt('studioReport.definition.churn', undefined, r.definitions.churn ?? '')}</p>
            </section>
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5 [grid-column:1/-1]">
              <h2 className="text-base font-bold">{t('revenue')}</h2>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
                {r.revenue.map((c) => (
                  <article key={c.currency} className="rounded-lg bg-canvas p-4">
                    <div className="text-xs font-bold text-stone">{c.currency}</div>
                    <div className="text-xl font-extrabold tabular">{c.net === null ? t('unavailable') : fmtMoney(c.net, c.currency, locale)}</div>
                    {c.net === null ? <p className="text-xs text-stone">{!c.unavailableReason || c.unavailableReason === 'No payments in this period' ? t('noPayments') : c.unavailableReason}</p> : (
                      <ul className="mt-1 text-xs">
                        {Object.entries(c.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between"><span>{t(`cat.${k}`)}</span><span className="tabular">{fmtMoney(v, c.currency, locale)}</span></li>)}
                        <li className="mt-1 flex justify-between text-stone"><span>{t('refunds')}</span><span className="tabular">{fmtMoney(c.refunds ?? 0, c.currency, locale)}</span></li>
                      </ul>
                    )}
                  </article>
                ))}
              </div>
              <p className="text-[11px] text-stone">{t('noCombined')} {dt('studioReport.definition.revenue', undefined, r.definitions.revenue ?? '')} {dt(reportSourceKey(r.source), undefined, r.source)}</p>
            </section>
          </div>
        )}
      </StudioAsync>
      <p className="text-xs text-stone">{t('scopeNote', { scope: scopeLabel })} {res.data && `· ${t('generated', { when: relativeTime(res.data.generatedAt, locale) })}`}</p>
      {app.can('ai.use') && <AiTools single={single} />}
    </>
  );
}

function AiTools({ single }: { single?: string }) {
  const t = useTranslations('studiosFull.ai');
  const app = useApp();
  const types = useStudio((api) => api.classTypes(), [app.role]);
  const [ct, setCt] = useState('');
  const [tone, setTone] = useState<'warm' | 'energetic' | 'calm'>('warm');
  const [draft, setDraft] = useState<AiDescription | null>(null);
  const [att, setAtt] = useState<AiAttendance | null>(null);
  const [aud, setAud] = useState<{ proposals: AiAudience[]; notes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const d = useStudioMutation((api) => api.aiDescription(ct, tone));
  const save = useStudioMutation((api, text: string) => api.updateClassType(ct, { description: text }));
  const a = useStudioMutation((api) => api.aiAttendance(4, single));
  const p = useStudioMutation((api) => api.aiAudiences(single));
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-labelledby="studio-ai">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="marina" size={18} />
        <h2 id="studio-ai" className="text-base font-bold">{t('title')}</h2>
        <Badge tone="info">{t('proposalsOnly')}</Badge>
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-lg bg-canvas p-4">
          <h3 className="text-sm font-bold">{t('describeTitle')}</h3>
          <Labeled label={t('classType')}><select className={inputCls} value={ct} onChange={(e) => { setCt(e.target.value); setDraft(null); setSaved(false); }}><option value="">{t('choose')}</option>{(types.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Labeled>
          <Labeled label={t('tone')}><select className={inputCls} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>{(['warm', 'energetic', 'calm'] as const).map((x) => <option key={x} value={x}>{t(`tones.${x}`)}</option>)}</select></Labeled>
          <Button size="sm" icon="marina" disabled={!ct || d.pending} onClick={async () => { setSaved(false); setDraft((await d.run()) ?? null); }}>{d.pending ? t('working') : t('draft')}</Button>
          <ErrorLine message={d.error?.message} />
          {draft && (
            <>
              <textarea className={`${inputCls} h-32 py-2`} value={draft.draft} onChange={(e) => setDraft({ ...draft, draft: e.target.value })} aria-label={t('draftLabel')} />
              <p className="text-[11px] text-stone">{t(`source.${draft.source}`)} · {draft.notes.join(' ')}</p>
              {app.can('operations.write') && <Button size="sm" variant="secondary" icon="check" disabled={save.pending} onClick={async () => { if (await save.run(draft.draft)) setSaved(true); }}>{t('saveToClass')}</Button>}
              {saved && <Banner tone="success" live="polite">{t('savedNote')}</Banner>}
              <ErrorLine message={save.error?.message} />
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-canvas p-4">
          <h3 className="text-sm font-bold">{t('attendanceTitle')}</h3>
          <Button size="sm" icon="chart" disabled={a.pending} onClick={async () => setAtt((await a.run()) ?? null)}>{a.pending ? t('working') : t('summarise')}</Button>
          <ErrorLine message={a.error?.message} />
          {att && (
            <>
              <h4 className="text-xs font-bold">{t('observations')}</h4>
              <ul className="list-disc pl-5 text-xs">{att.observations.map((o) => <li key={o}>{o}</li>)}</ul>
              {att.narrative && <p className="text-xs">{att.narrative}</p>}
              <Banner tone="neutral" icon="info">{att.notInferred}</Banner>
              <p className="text-[11px] text-stone">{t(`source.${att.source}`)}</p>
            </>
          )}
        </div>
        <div className="flex flex-col gap-2 rounded-lg bg-canvas p-4">
          <h3 className="text-sm font-bold">{t('audienceTitle')}</h3>
          {app.can('customers.read') ? <Button size="sm" icon="users" disabled={p.pending} onClick={async () => setAud((await p.run()) ?? null)}>{p.pending ? t('working') : t('propose')}</Button> : <p className="text-xs text-stone">{t('needsCustomers')}</p>}
          <ErrorLine message={p.error?.message} />
          {aud && (
            <>
              <ul className="flex flex-col gap-2">
                {aud.proposals.map((x) => (
                  <li key={x.proposalId} className="rounded-md bg-surface p-3 text-xs">
                    <div className="flex items-center gap-2"><strong className="text-sm">{x.title}</strong><Badge tone="neutral" icon="info">{t('proposed')}</Badge></div>
                    <p className="text-stone">{x.rule}</p>
                    <p className="mt-1"><strong className="tabular">{x.size}</strong> {t('people')} · <strong className="tabular">{x.emailConsented}</strong> {t('consented')}{x.sample.length ? ` · ${x.sample.join(', ')}…` : ''}</p>
                    <p className="mt-1 italic">“{x.suggestedMessage}”</p>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-stone">{aud.notes.join(' ')}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
