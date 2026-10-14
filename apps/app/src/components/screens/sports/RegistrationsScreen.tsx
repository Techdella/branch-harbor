'use client';

import { Fragment, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, Drawer, Icon, Select, cx } from '@bh/ui';
import type { RegStatus, SRegistration } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { Amount, BalanceBadge, FieldLabel, RegStatusBadge, areaCls, fmtDate, useScopeIds } from './ui';

const TABS: RegStatus[] = ['awaiting_review', 'submitted', 'accepted', 'waitlisted', 'withdrawn'];

/** Submitted / awaiting review / accepted / waitlisted / withdrawn. Payment never means selection. */
export function RegistrationsScreen() {
  const t = useTranslations('sportsHub.registrations');
  const tOps = useTranslations('ops.sports.registrations');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const [tab, setTab] = useState<RegStatus>('awaiting_review');
  const [q, setQ] = useState('');
  const [groupSel, setGroupSel] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<SRegistration | null>(null);
  const res = useSports(async (c) => ({ regs: await c.registrations(scope), teams: await c.teams(scope) }), [scope.join(','), app.role]);
  const decide = useSportsAction((c, id: string, d: 'accept' | 'waitlist' | 'reject', teamId?: string, note?: string) => c.review(id, d, teamId, note).then(() => true));
  const director = app.can('customers.write');

  const act = async (r: SRegistration, d: 'accept' | 'waitlist' | 'reject', note?: string) => {
    if (await decide.run(r.id, d, groupSel[r.id] || undefined, note)) {
      setMsg(t(`decided.${d}`, { name: r.participant.name }));
      setOpen(null);
      res.reload();
    }
  };

  return (
    <>
      <PageHeader icon="file" title={tOps('title')} description={tOps('description')} />
      {!director && <Banner tone="neutral" icon="lock">{t('readOnly')}</Banner>}
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />} permission="customers.read">
        {({ regs, teams }) => {
          const ql = q.trim().toLowerCase();
          const items = regs.filter((r) => r.status === tab && (!ql || r.participant.name.toLowerCase().includes(ql) || r.guardian?.name.toLowerCase().includes(ql) || r.programme.name.toLowerCase().includes(ql)));
          return (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="tablist" aria-label={t('statusTabs')} className="flex flex-wrap gap-1.5">
                  {TABS.map((s) => (
                    <button key={s} role="tab" aria-selected={tab === s} type="button" onClick={() => setTab(s)} className={cx('h-10 rounded-full px-4 text-[13px] font-bold', tab === s ? 'bg-ink text-white' : 'bg-surface')}>
                      {t(`tab.${s}`)} · {regs.filter((r) => r.status === s).length}
                    </button>
                  ))}
                </div>
                <label className="relative"><span className="sr-only">{t('search')}</span><Icon name="search" size={16} className="absolute left-3 top-3 text-stone" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-10 w-64 rounded-full border border-line bg-surface pl-9 pr-3 text-sm" /></label>
              </div>
              {tab === 'submitted' && <Banner tone="info" icon="card">{t('submittedNote')}</Banner>}
              {items.length === 0 ? <Empty icon="file" title={t('empty')} /> : (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
                  {items.map((r) => {
                    const progTeams = teams.filter((x) => x.programmeId === r.programme.id && x.kind !== 'squad');
                    const g = groupSel[r.id] ?? '';
                    const group = progTeams.find((x) => x.id === g);
                    const full = group ? group.capacity !== null && group.rosterCount >= group.capacity : false;
                    return (
                      <article key={r.id} className="flex flex-col gap-2.5 rounded-lg bg-surface p-4">
                        <div className="flex items-start justify-between gap-2">
                          <button type="button" className="flex items-center gap-2.5 text-left" onClick={() => setOpen(r)}>
                            <Avatar name={r.participant.name} size={42} />
                            <div>
                              <h3 className="text-[15px] font-bold underline-offset-2 hover:underline">{r.participant.name}</h3>
                              <div className="text-xs text-stone">{r.participant.ageGroup ? t('ageGroup', { group: r.participant.ageGroup, age: r.participant.age ?? '—' }) : t('ageUnknown')} · {r.programme.name}</div>
                            </div>
                          </button>
                          <RegStatusBadge status={r.status} />
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <div className="rounded-sm bg-canvas px-2.5 py-2">
                            <div className="text-stone">{t('guardian')}</div>
                            <strong>{r.guardian?.name ?? t('unavailable')}</strong>
                            <div className={r.guardian?.relationshipStatus === 'verified' ? 'text-success' : 'text-warning'}>{t(`rel.${r.guardian?.relationshipStatus ?? 'unknown'}`)}{r.guardiansCount > 1 ? ` · ${t('moreGuardians', { n: r.guardiansCount - 1 })}` : ''}</div>
                          </div>
                          <div className="rounded-sm bg-canvas px-2.5 py-2">
                            <div className="text-stone">{t('payment')} · {t(`plan.${r.paymentPlan}`)}</div>
                            <strong><Amount amount={r.totalFeeMinor} currency={r.currency} /></strong>
                            <div className="mt-0.5"><BalanceBadge state={r.balance.state} /></div>
                          </div>
                        </div>
                        <div className={cx('flex items-center gap-1.5 text-xs', r.formsComplete ? 'text-success' : 'font-bold text-danger')}><Icon name={r.formsComplete ? 'check-circle' : 'alert'} size={13} />{r.formsComplete ? t('formsComplete') : t('formsMissing')}</div>
                        {r.status === 'submitted' && <div className="text-xs text-stone">{r.holdActive ? t('holdActive') : t('holdExpired')}{r.lastPaymentState ? ` · ${t('lastPayment', { state: r.lastPaymentState })}` : ''}</div>}
                        {r.reviewNote && <div className="rounded-sm bg-warning-bg px-2.5 py-2 text-xs text-warning">{r.reviewNote}</div>}
                        {r.status === 'accepted' && r.teamId && <div className="text-xs">{t('inGroup', { group: teams.find((x) => x.id === r.teamId)?.name ?? '—' })}</div>}
                        {(r.status === 'awaiting_review' || r.status === 'waitlisted') && director && (
                          <div className="flex flex-col gap-1.5">
                            <label className="sr-only" htmlFor={`grp-${r.id}`}>{t('assignGroup')}</label>
                            <Select id={`grp-${r.id}`} value={g} onChange={(e) => setGroupSel((s) => ({ ...s, [r.id]: e.target.value }))}>
                              <option value="">{t('assignGroupPlaceholder')}</option>
                              {progTeams.map((gr) => <option key={gr.id} value={gr.id} disabled={gr.capacity !== null && gr.rosterCount >= gr.capacity}>{gr.name} · {gr.capacity !== null && gr.rosterCount >= gr.capacity ? t('full') : `${gr.rosterCount}/${gr.capacity ?? '∞'}`}</option>)}
                            </Select>
                            <div className="flex gap-1.5">
                              <Button size="sm" className="flex-1" disabled={!r.formsComplete || !g || full} loading={decide.pending} onClick={() => void act(r, 'accept')}>{t('accept')}</Button>
                              {r.status !== 'waitlisted' && <Button size="sm" variant="secondary" onClick={() => void act(r, 'waitlist')}>{t('waitlist')}</Button>}
                              <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>{t('more')}</Button>
                            </div>
                            {!r.formsComplete && <p className="text-[11px] text-stone">{t('formsBlock')}</p>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-stone">{t('paymentNotSelection')}</p>
              <RegistrationDrawer reg={open} onClose={() => setOpen(null)} director={director} locale={locale} onReject={(r, note) => void act(r, 'reject', note)} onChanged={(m) => { setMsg(m); setOpen(null); res.reload(); }} />
            </>
          );
        }}
      </Async>
    </>
  );
}

function RegistrationDrawer({ reg, onClose, director, locale, onReject, onChanged }: { reg: SRegistration | null; onClose: () => void; director: boolean; locale: string; onReject: (r: SRegistration, note: string) => void; onChanged: (m: string) => void }) {
  const t = useTranslations('sportsHub.registrations');
  const [care, setCare] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState('');
  const restricted = useSportsAction((c, id: string) => c.restricted(id));
  const withdraw = useSportsAction((c, id: string, reason: string) => c.withdraw(id, reason).then(() => true));
  const key = reg?.id;
  useEffect(() => { setCare(null); setNote(''); }, [key]);
  if (!reg) return null;
  return (
    <Drawer open={!!reg} onClose={onClose} title={reg.participant.name} kicker={reg.programme.name}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-2"><RegStatusBadge status={reg.status} /><BalanceBadge state={reg.balance.state} /></div>
        <dl className="grid grid-cols-2 gap-2">
          <dt className="text-stone">{t('dob')}</dt><dd>{fmtDate(reg.participant.dateOfBirth, locale)} {reg.participant.ageGroup && `(${reg.participant.ageGroup})`}</dd>
          <dt className="text-stone">{t('guardian')}</dt><dd>{reg.guardian?.name} · {reg.guardian?.email}</dd>
          <dt className="text-stone">{t('fee')}</dt><dd><Amount amount={reg.listFeeMinor} currency={reg.currency} /> → <strong><Amount amount={reg.totalFeeMinor} currency={reg.currency} /></strong></dd>
          <dt className="text-stone">{t('outstanding')}</dt><dd><Amount amount={reg.balance.outstanding} currency={reg.balance.currency ?? reg.currency} /></dd>
          <dt className="text-stone">{t('submittedAt')}</dt><dd>{fmtDate(reg.createdAt, locale)}</dd>
        </dl>
        {reg.adjustments.length > 0 && <ul className="flex flex-col gap-1">{reg.adjustments.map((a) => <li key={a.id}><Badge tone="info" icon="gift">{t(`adj.${a.kind}`)}</Badge> <Amount amount={a.amount.amount} currency={a.amount.currency} /> · {a.reason}</li>)}</ul>}
        <section className="rounded-lg border border-line-soft p-3">
          <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 font-bold"><Icon name="lock" size={15} />{t('careTitle')}</h3>
            {!care && <Button size="sm" variant="secondary" loading={restricted.pending} onClick={async () => setCare((await restricted.run(reg.id))?.answers ?? null)}>{t('showCare')}</Button>}</div>
          <p className="mt-1 text-xs text-stone">{t('careNote')}</p>
          {restricted.error && <p className="mt-2 text-xs font-bold text-danger">{restricted.error.message}</p>}
          {care && (Object.keys(care).length ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{Object.entries(care).map(([k, v]) => <Fragment key={k}><dt className="text-stone">{t.has(`careKey.${k}`) ? t(`careKey.${k}`) : k}</dt><dd>{String(v)}</dd></Fragment>)}</dl> : <p className="mt-2 text-stone">{t('noCare')}</p>)}
        </section>
        {director && ['awaiting_review', 'waitlisted', 'submitted', 'accepted'].includes(reg.status) && (
          <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <FieldLabel htmlFor="reg-note">{t('noteLabel')}</FieldLabel>
            <textarea id="reg-note" className={areaCls} value={note} onChange={(e) => setNote(e.target.value)} />
            {withdraw.error && <p className="text-xs font-bold text-danger">{withdraw.error.message}</p>}
            <div className="flex flex-wrap gap-2">
              {reg.status !== 'accepted' && reg.status !== 'submitted' && <Button size="sm" variant="danger" disabled={note.trim().length < 3} onClick={() => onReject(reg, note)}>{t('reject')}</Button>}
              <Button size="sm" variant="secondary" disabled={note.trim().length < 3} loading={withdraw.pending} onClick={async () => { if (await withdraw.run(reg.id, note)) onChanged(t('withdrawn', { name: reg.participant.name })); }}>{t('withdraw')}</Button>
            </div>
            <p className="text-xs text-stone">{t('withdrawNote')}</p>
          </section>
        )}
      </div>
    </Drawer>
  );
}
