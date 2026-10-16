'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, Toggle } from '@bh/ui';
import { VALIDATION_SENTIMENTS } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { fdevApi, useAction, useLoad, type CallVM, type CallsVM, type ValidatorMeVM } from './api';
import { ActionError, PillTabs, StatusBadge, useFmt } from './ui';

/**
 * Sales → Validation calls. HQ (franchise pipeline) assigns validators to candidates by rotation and records
 * outcomes; franchisees opt in as validators and see their own calls.
 */
export function ValidationScreen() {
  const t = useTranslations('fdev');
  const app = useApp();
  const hq = app.hasModule('sales.franchise_pipeline');
  return (
    <>
      <PageHeader icon="phone" title={t('validation.title')} description={hq ? t('validation.description') : t('validation.descriptionOwner')} scope={false} />
      {hq ? <HqValidation /> : <MyValidation />}
    </>
  );
}

function HqValidation() {
  const t = useTranslations('fdev');
  const app = useApp();
  const [tab, setTab] = useState<'calls' | 'candidates' | 'validators'>('calls');
  const res = useLoad(() => fdevApi.calls(), [app.org.id]);
  const vals = useLoad(() => fdevApi.validators(), [app.org.id]);
  const act = useAction();
  const [link, setLink] = useState<string | null>(null);
  return (
    <>
      <PillTabs items={[['calls', t('validation.tabCalls'), res.data?.items.filter((c) => c.status === 'requested').length], ['candidates', t('validation.tabCandidates')], ['validators', t('validation.tabValidators')]]} value={tab} onChange={setTab} />
      <ActionError error={act.error} />
      {link && <Banner tone="success" icon="link" title={t('validation.linkSent')}><span className="break-all text-xs">{link}</span></Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (
          <>
            {tab === 'calls' && <CallsTable d={d} onChanged={res.reload} />}
            {tab === 'candidates' && (
              d.candidates.length ? (
                <SectionCard title={t('validation.candidates')}>
                  <ul className="flex flex-col divide-y divide-line-soft">
                    {d.candidates.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                        <span><strong>{p.name}</strong><span className="block text-xs text-stone">{[p.city, p.country].filter(Boolean).join(', ')} · {t(`stage.${p.stage}` as 'stage.discovery_call')}</span></span>
                        <span className="flex items-center gap-2">
                          {p.calls > 0 && <Badge tone="info">{t('validation.callCount', { count: p.calls })}</Badge>}
                          {d.can.edit && <Button size="sm" variant={p.calls ? 'ghost' : 'secondary'} icon="users" loading={act.pending} onClick={async () => { const r = await act.run(() => fdevApi.assign(p.id, 3)); if (r) { setLink(r.link); res.reload(); vals.reload(); setTab('calls'); } }}>{p.calls ? t('validation.assignMore') : t('validation.assign')}</Button>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              ) : <Empty icon="users" title={t('validation.noCandidates')} />
            )}
          </>
        )}
      </Async>
      {tab === 'validators' && (
        <Async res={vals} loading={<LoadingBlock variant="table" />}>
          {(v) => v.items.length ? (
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead><tr className="border-b border-line-soft text-left text-xs uppercase text-stone">{[t('validation.validator'), t('validation.location'), t('validation.load'), t('validation.limit'), t('validation.active')].map((h) => <th key={h} scope="col" className="px-2 py-2">{h}</th>)}</tr></thead>
                <tbody>
                  {v.items.map((x) => (
                    <tr key={x.id} className="border-b border-line-soft last:border-0">
                      <td className="px-2 py-2"><strong>{x.name}</strong><span className="block text-xs text-stone">{x.ownerGroupName}</span></td>
                      <td className="px-2 py-2">{x.locationName ?? '—'}{x.region ? `, ${x.region}` : ''}</td>
                      <td className="tabular px-2 py-2">{t('validation.loadValue', { month: x.callsThisMonth, quarter: x.callsLast90 })}</td>
                      <td className="tabular px-2 py-2">{x.maxCallsPerMonth}</td>
                      <td className="px-2 py-2"><Toggle checked={x.active} label={t('validation.activeOf', { name: x.name })} onChange={async (b) => { if (await act.run(() => fdevApi.updateValidator(x.id, { active: b }))) vals.reload(); }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : <Empty icon="users" title={t('validation.noValidators')} body={t('validation.noValidatorsBody')} />}
        </Async>
      )}
    </>
  );
}

function CallsTable({ d, onChanged }: { d: CallsVM; onChanged: () => void }) {
  const t = useTranslations('fdev');
  const [open, setOpen] = useState<string | null>(null);
  if (!d.items.length) return <Empty icon="phone" title={t('validation.noCalls')} body={t('validation.noCallsBody')} />;
  return (
    <section className="flex flex-col gap-2" data-testid="validation-calls">
      {d.items.map((c) => <CallRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={onChanged} canEdit={d.can.edit} />)}
    </section>
  );
}

function CallRow({ c, open, onToggle, onChanged, canEdit }: { c: CallVM; open: boolean; onToggle: () => void; onChanged: () => void; canEdit: boolean }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const act = useAction();
  const [v, setV] = useState({ scheduledAt: c.scheduledAt ? c.scheduledAt.slice(0, 16) : '', sentiment: c.sentiment ?? '', outcome: c.outcome ?? '' });
  return (
    <article className="rounded-xl bg-surface p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px]">
          <strong>{c.prospectName ?? t('validation.candidate')}</strong> ↔ <strong>{c.validatorName ?? t('validation.validator')}</strong>
          <span className="block text-xs text-stone">{[c.prospectCity, c.scheduledAt ? t('validation.scheduledFor', { date: f.date(c.scheduledAt) }) : null, c.proposedTimes ? t('validation.proposed', { times: c.proposedTimes }) : null].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="flex items-center gap-2">
          {c.sentiment && <Badge tone={c.sentiment === 'positive' ? 'success' : c.sentiment === 'negative' ? 'danger' : 'neutral'}>{t(`sentiment.${c.sentiment}`)}</Badge>}
          <StatusBadge status={c.status} />
          {canEdit && <Button size="sm" variant="ghost" icon={open ? 'chevron-down' : 'edit'} onClick={onToggle}>{t('validation.update')}</Button>}
        </span>
      </div>
      {c.outcome && !open && <p className="mt-2 text-[13px] text-graphite">{c.outcome}</p>}
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Field label={t('validation.when')}>{(x) => <Input id={x.id} type="datetime-local" value={v.scheduledAt} onChange={(e) => setV((s) => ({ ...s, scheduledAt: e.target.value }))} />}</Field>
          <Field label={t('validation.sentiment')}>{(x) => <Select id={x.id} value={v.sentiment} onChange={(e) => setV((s) => ({ ...s, sentiment: e.target.value }))}><option value="">—</option>{VALIDATION_SENTIMENTS.map((s) => <option key={s} value={s}>{t(`sentiment.${s}`)}</option>)}</Select>}</Field>
          <div className="sm:col-span-3"><Field label={t('validation.outcome')}>{(x) => <Textarea id={x.id} rows={2} value={v.outcome} onChange={(e) => setV((s) => ({ ...s, outcome: e.target.value }))} />}</Field></div>
          <ActionError error={act.error} />
          <div className="flex flex-wrap gap-2 sm:col-span-3">
            <Button size="sm" variant="secondary" icon="calendar" disabled={!v.scheduledAt} onClick={async () => { if (await act.run(() => fdevApi.updateCall(c.id, { scheduledAt: new Date(v.scheduledAt).toISOString(), status: 'scheduled' }))) onChanged(); }}>{t('validation.schedule')}</Button>
            <Button size="sm" icon="check" disabled={!v.sentiment} onClick={async () => { if (await act.run(() => fdevApi.updateCall(c.id, { status: 'completed', sentiment: v.sentiment as 'positive', outcome: v.outcome || null }))) onChanged(); }}>{t('validation.complete')}</Button>
            <Button size="sm" variant="ghost" onClick={async () => { if (await act.run(() => fdevApi.updateCall(c.id, { status: 'no_show' }))) onChanged(); }}>{t('validation.noShow')}</Button>
            <Button size="sm" variant="ghost" icon="x" onClick={async () => { if (await act.run(() => fdevApi.updateCall(c.id, { status: 'cancelled' }))) onChanged(); }}>{t('validation.cancel')}</Button>
          </div>
        </div>
      )}
    </article>
  );
}

function MyValidation() {
  const t = useTranslations('fdev');
  const app = useApp();
  const res = useLoad(() => fdevApi.validatorMe(), [app.org.id]);
  return <Async res={res} loading={<LoadingBlock variant="detail" />}>{(d) => <MyForm d={d} onSaved={res.reload} />}</Async>;
}

function MyForm({ d, onSaved }: { d: ValidatorMeVM; onSaved: () => void }) {
  const t = useTranslations('fdev');
  const act = useAction();
  const v0 = d.validator;
  const [open, setOpen] = useState<string | null>(null);
  const [v, setV] = useState({ active: v0?.active ?? true, bio: v0?.bio ?? '', schedulingUrl: v0?.schedulingUrl ?? '', phone: v0?.phone ?? '', max: v0?.maxCallsPerMonth ?? 4 });
  if (!d.eligible) return <Banner tone="neutral" icon="info">{t('validation.notEligible')}</Banner>;
  return (
    <>
      <SectionCard title={t('validation.profile')}>
        <div className="flex max-w-2xl flex-col gap-3">
          <p className="text-[13px] text-graphite">{t('validation.profileBody')}</p>
          <label className="flex items-center gap-2 text-[13px]"><Toggle checked={v.active} onChange={(b) => setV((s) => ({ ...s, active: b }))} label={t('validation.optIn')} /><span aria-hidden="true">{t('validation.optIn')}</span></label>
          <Field label={t('validation.bio')} hint={t('validation.bioHint')} optional>{(x) => <Textarea id={x.id} rows={3} value={v.bio} onChange={(e) => setV((s) => ({ ...s, bio: e.target.value }))} />}</Field>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="sm:col-span-2"><Field label={t('validation.bookingLink')} hint={t('validation.bookingLinkHint')} optional>{(x) => <Input id={x.id} type="url" value={v.schedulingUrl} onChange={(e) => setV((s) => ({ ...s, schedulingUrl: e.target.value }))} />}</Field></div>
            <Field label={t('validation.limit')}>{(x) => <Input id={x.id} type="number" min={1} max={30} value={v.max} onChange={(e) => setV((s) => ({ ...s, max: Number(e.target.value) || 4 }))} />}</Field>
          </div>
          <ActionError error={act.error} />
          <div><Button icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => fdevApi.saveValidatorMe({ active: v.active, bio: v.bio || null, schedulingUrl: v.schedulingUrl || null, phone: v.phone || null, maxCallsPerMonth: v.max }))) onSaved(); }}>{t('common.save')}</Button></div>
        </div>
      </SectionCard>
      <SectionCard title={t('validation.myCalls')}>
        {d.calls.length ? <div className="flex flex-col gap-2">{d.calls.map((c) => <CallRow key={c.id} c={{ ...c, validatorName: t('validation.you') }} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={onSaved} canEdit />)}</div> : <p className="text-[13px] text-stone">{t('validation.noMyCalls')}</p>}
      </SectionCard>
    </>
  );
}
