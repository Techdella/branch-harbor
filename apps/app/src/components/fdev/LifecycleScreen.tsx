'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, cx } from '@bh/ui';
import { DEFAULT_CURE_DAYS, NOTICE_REASONS, RENEWAL_CONDITIONS, TRANSFER_APPROVAL_STEPS, TRANSFER_STEPS } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { download, fdevApi, useAction, useLoad, type AgreementPick, type NoticeVM, type OverviewVM, type TransferVM } from './api';
import { ActionError, KeyValue, PillTabs, StatusBadge, Tiles, useFmt } from './ui';

type Tab = 'transfers' | 'notices' | 'amendments' | 'renewals';
const TABS: Tab[] = ['transfers', 'notices', 'amendments', 'renewals'];

/**
 * Legal & compliance → Agreement lifecycle: transfers between owners, notices of default (counsel review before
 * issuing, cure periods, escalation and termination), amendments and renewals with option windows.
 */
export function LifecycleScreen() {
  const t = useTranslations('fdev');
  const app = useApp();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'transfers') as Tab;
  const ov = useLoad(() => fdevApi.overview(), [app.org.id]);
  const ags = useLoad(() => fdevApi.agreements(), [app.org.id]);
  const setTab = (k: Tab) => router.replace(`/franchise/lifecycle?tab=${k}`);
  return (
    <>
      <PageHeader icon="scale" title={t('lifecycle.title')} description={t('lifecycle.description')} scope={false} />
      <Banner tone="warning" icon="scale" title={t('lifecycle.counselTitle')}>{t('lifecycle.counselBody')}</Banner>
      <Async res={ov} loading={<LoadingBlock variant="cards" rows={1} />}>
        {(o) => (
          <>
            <Tiles items={[
              { label: t('lifecycle.tile.transfers'), value: o.transfersOpen },
              { label: t('lifecycle.tile.notices'), value: o.noticesOpen, sub: o.curePeriodsEnding ? t('lifecycle.tile.ending', { count: o.curePeriodsEnding }) : undefined },
              { label: t('lifecycle.tile.overdue'), value: o.curesOverdue, tone: o.curesOverdue ? 'danger' : undefined },
              { label: t('lifecycle.tile.renewals'), value: o.renewalWindowsOpen },
              { label: t('lifecycle.tile.behind'), value: o.developmentBehind, tone: o.developmentBehind ? 'danger' : undefined },
            ]} />
            <PillTabs items={TABS.map((k) => [k, t(`lifecycle.tab.${k}`)] as [Tab, string])} value={tab} onChange={setTab} />
            {tab === 'transfers' && <Transfers o={o} agreements={ags.data?.items ?? []} />}
            {tab === 'notices' && <Notices o={o} agreements={ags.data?.items ?? []} />}
            {tab === 'amendments' && <Amendments o={o} agreements={ags.data?.items ?? []} />}
            {tab === 'renewals' && <Renewals o={o} />}
          </>
        )}
      </Async>
    </>
  );
}

const agreementLabel = (a: AgreementPick) => `${a.ownerGroupName ?? '—'}${a.territory ? ` · ${a.territory}` : ''}`;

/* ------------------------------- transfers ------------------------------- */

function Transfers({ o, agreements }: { o: OverviewVM; agreements: AgreementPick[] }) {
  const t = useTranslations('fdev');
  const res = useLoad(() => fdevApi.transfers(), []);
  const act = useAction();
  const [v, setV] = useState({ agreementId: '', buyerName: '', fee: '', reason: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {o.can.edit && (
        <SectionCard title={t('transfers.start')}>
          <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_140px_auto] sm:items-end">
            <Field label={t('lifecycle.agreement')}>{(x) => <Select id={x.id} value={v.agreementId} onChange={(e) => setV((s) => ({ ...s, agreementId: e.target.value }))}><option value="">—</option>{agreements.map((a) => <option key={a.id} value={a.id}>{agreementLabel(a)}</option>)}</Select>}</Field>
            <Field label={t('transfers.buyer')}>{(x) => <Input id={x.id} value={v.buyerName} onChange={(e) => setV((s) => ({ ...s, buyerName: e.target.value }))} />}</Field>
            <Field label={t('transfers.fee')} optional>{(x) => <Input id={x.id} inputMode="decimal" value={v.fee} onChange={(e) => setV((s) => ({ ...s, fee: e.target.value }))} />}</Field>
            <Button icon="plus" disabled={!v.agreementId || !v.buyerName.trim()} loading={act.pending} onClick={async () => {
              const r = await act.run(() => fdevApi.createTransfer({ agreementId: v.agreementId, buyerName: v.buyerName.trim(), transferFeeMinor: Math.round((Number(v.fee) || 0) * 100), reason: v.reason || null }));
              if (r) { setV({ agreementId: '', buyerName: '', fee: '', reason: '' }); setOpenId(r.id); res.reload(); }
            }}>{t('transfers.create')}</Button>
          </div>
          <ActionError error={act.error} />
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="repeat" title={t('transfers.empty')} />}>
        {(d) => <div className="flex flex-col gap-3">{d.items.map((x) => <TransferCard key={x.id} x={x} o={o} open={openId === x.id} onToggle={() => setOpenId(openId === x.id ? null : x.id)} onChanged={res.reload} />)}</div>}
      </Async>
    </>
  );
}

function TransferCard({ x, o, open, onToggle, onChanged }: { x: TransferVM; o: OverviewVM; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const act = useAction();
  const closed = ['completed', 'rejected', 'cancelled'].includes(x.status);
  const done = new Set(x.steps.filter((s) => s.done).map((s) => s.key));
  return (
    <article className="rounded-xl bg-surface p-4" data-testid="transfer">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span>
          <h3 className="text-[15px] font-extrabold">{t('transfers.heading', { from: x.fromOwnerGroupName ?? '—', to: x.buyerName })}</h3>
          <span className="text-xs text-stone">{[x.territory, x.transferFee.amountMinor ? t('transfers.feeValue', { fee: f.money(x.transferFee.amountMinor, x.transferFee.currency) }) : null, x.feePaidAt ? t('transfers.feePaid') : null].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular text-xs text-stone">{t('transfers.progress', { done: x.progress.done, total: x.progress.total })}</span>
          <StatusBadge status={x.status} />
          <Button size="sm" variant="ghost" icon={open ? 'chevron-down' : 'chevron-right'} onClick={onToggle}>{t('transfers.steps')}</Button>
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-canvas" role="img" aria-label={t('transfers.progress', { done: x.progress.done, total: x.progress.total })}><span className="block h-full rounded-full bg-ink" style={{ width: `${(x.progress.done / x.progress.total) * 100}%` }} /></div>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <ol className="grid gap-1.5 sm:grid-cols-2">
            {TRANSFER_STEPS.map((k, i) => {
              const s = x.steps.find((y) => y.key === k);
              return (
                <li key={k} className={cx('flex items-center gap-2 rounded-md px-3 py-2 text-[13px]', s?.done ? 'bg-[#E2F5A6]' : 'bg-canvas')}>
                  <input type="checkbox" className="h-4 w-4" checked={!!s?.done} disabled={closed || !o.can.edit || act.pending} aria-label={t(`transferStep.${k}`)} onChange={async (e) => { if (await act.run(() => fdevApi.transferStep(x.id, k, e.target.checked))) onChanged(); }} />
                  <span className="tabular w-5 text-xs text-stone">{i + 1}</span>
                  <span className="flex-1">{t(`transferStep.${k}`)}{TRANSFER_APPROVAL_STEPS.includes(k) && <span className="ms-1 text-[11px] text-stone">{t('transfers.beforeApproval')}</span>}</span>
                  {s?.doneAt && <span className="text-[11px] text-stone">{f.date(s.doneAt)}</span>}
                </li>
              );
            })}
          </ol>
          <ActionError error={act.error} />
          {!closed && (
            <div className="flex flex-wrap gap-2">
              {o.can.publish && ['draft', 'in_review'].includes(x.status) && <Button size="sm" icon="check" disabled={!x.readyForApproval} onClick={async () => { if (await act.run(() => fdevApi.decideTransfer(x.id, 'approve'))) onChanged(); }}>{t('transfers.approve')}</Button>}
              {o.can.publish && ['draft', 'in_review'].includes(x.status) && <Button size="sm" variant="ghost" icon="x" onClick={async () => { if (await act.run(() => fdevApi.decideTransfer(x.id, 'reject'))) onChanged(); }}>{t('transfers.reject')}</Button>}
              {o.can.publish && x.status === 'approved' && <Button size="sm" icon="repeat" disabled={!x.readyToComplete} onClick={async () => { if (await act.run(() => fdevApi.completeTransfer(x.id))) onChanged(); }}>{t('transfers.complete')}</Button>}
              {o.can.edit && <Button size="sm" variant="ghost" onClick={async () => { if (await act.run(() => fdevApi.cancelTransfer(x.id))) onChanged(); }}>{t('transfers.cancel')}</Button>}
            </div>
          )}
          {!x.readyForApproval && ['draft', 'in_review'].includes(x.status) && <p className="text-xs text-stone">{t('transfers.approvalHint')}</p>}
          {x.status === 'completed' && <Banner tone="success" icon="check">{t('transfers.completed', { to: x.toOwnerGroupName ?? x.buyerName, date: f.date(x.completedAt) })}</Banner>}
        </div>
      )}
    </article>
  );
}

/* -------------------------------- notices -------------------------------- */

function Notices({ o, agreements }: { o: OverviewVM; agreements: AgreementPick[] }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.notices(), []);
  const act = useAction();
  const [v, setV] = useState({ agreementId: '', reason: 'non_payment', details: '', cureDays: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {o.can.edit && (
        <SectionCard title={t('notices.draft')}>
          <div className="grid gap-2 sm:grid-cols-[1.3fr_1fr_120px]">
            <Field label={t('lifecycle.agreement')}>{(x) => <Select id={x.id} value={v.agreementId} onChange={(e) => setV((s) => ({ ...s, agreementId: e.target.value }))}><option value="">—</option>{agreements.map((a) => <option key={a.id} value={a.id}>{agreementLabel(a)}</option>)}</Select>}</Field>
            <Field label={t('notices.reason')}>{(x) => <Select id={x.id} value={v.reason} onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))}>{NOTICE_REASONS.map((r) => <option key={r} value={r}>{t(`noticeReason.${r}`)}</option>)}</Select>}</Field>
            <Field label={t('notices.cureDays')} hint={t('notices.cureDaysHint', { days: DEFAULT_CURE_DAYS[v.reason as 'other'] })} optional>{(x) => <Input id={x.id} type="number" min={0} max={365} value={v.cureDays} onChange={(e) => setV((s) => ({ ...s, cureDays: e.target.value }))} />}</Field>
            <div className="sm:col-span-3"><Field label={t('notices.details')} hint={t('notices.detailsHint')}>{(x) => <Textarea id={x.id} rows={2} value={v.details} onChange={(e) => setV((s) => ({ ...s, details: e.target.value }))} />}</Field></div>
          </div>
          <ActionError error={act.error} />
          <Button className="mt-2" icon="file" disabled={!v.agreementId} loading={act.pending} onClick={async () => {
            const r = await act.run(() => fdevApi.draftNotice({ agreementId: v.agreementId, reason: v.reason, details: v.details, cureDays: v.cureDays ? Number(v.cureDays) : null }));
            if (r) { setOpenId(r.id); setV((s) => ({ ...s, details: '', cureDays: '' })); res.reload(); }
          }}>{t('notices.draftButton')}</Button>
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="file" title={t('notices.empty')} />}>
        {(d) => (
          <div className="flex flex-col gap-2">
            {d.items.map((n) => (
              <article key={n.id} className={cx('rounded-xl bg-surface p-3.5', n.cureOverdue && 'ring-2 ring-danger')}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px]">
                    <strong>{t(`noticeKind.${n.kind}` as 'noticeKind.default')}</strong> · {n.ownerGroupName} · {t(`noticeReason.${n.reason}` as 'noticeReason.other')}
                    <span className="block text-xs text-stone">{n.cureDeadline ? (n.status === 'issued' ? (n.cureOverdue ? t('notices.overdue', { date: f.date(n.cureDeadline) }) : t('notices.cureBy', { date: f.date(n.cureDeadline), days: n.daysLeft ?? 0 })) : t('notices.cureDraft', { days: n.cureDays ?? 0 })) : f.date(n.createdAt)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {n.status === 'draft' && <Badge tone={n.counselReviewed ? 'success' : 'warning'} icon="scale">{n.counselReviewed ? t('notices.reviewed') : t('notices.needsReview')}</Badge>}
                    <StatusBadge status={n.status} />
                    <Button size="sm" variant="ghost" icon={openId === n.id ? 'chevron-down' : 'chevron-right'} onClick={() => setOpenId(openId === n.id ? null : n.id)}>{t('notices.open')}</Button>
                  </span>
                </div>
                {openId === n.id && <NoticeDetail id={n.id} o={o} onChanged={res.reload} onOpen={setOpenId} />}
              </article>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}

function NoticeDetail({ id, o, onChanged, onOpen }: { id: string; o: OverviewVM; onChanged: () => void; onOpen: (id: string) => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.notice(id), [id]);
  const act = useAction();
  const [edit, setEdit] = useState<{ subject: string; body: string } | null>(null);
  const [deliveredTo, setDeliveredTo] = useState('');
  const reload = () => { res.reload(); onChanged(); };
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(n) => (
        <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]" data-testid="notice-detail">
          <div className="rounded-md border border-line-soft bg-white p-4">
            {edit ? (
              <div className="flex flex-col gap-2">
                <Field label={t('notices.subject')}>{(x) => <Input id={x.id} value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />}</Field>
                <Field label={t('notices.body')}>{(x) => <Textarea id={x.id} rows={14} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />}</Field>
                <div className="flex gap-2"><Button size="sm" icon="check" onClick={async () => { if (await act.run(() => fdevApi.editNotice(n.id, edit))) { setEdit(null); reload(); } }}>{t('common.save')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(null)}>{t('common.cancel')}</Button></div>
              </div>
            ) : (
              <>
                <h4 className="text-[15px] font-extrabold">{n.subject}</h4>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-graphite">{n.body}</pre>
                {n.status === 'draft' && <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-danger">{t('notices.draftMark')}</p>}
              </>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <KeyValue items={[
              [t('lifecycle.agreement'), `${n.agreement.territory ?? '—'} (${n.agreement.jurisdiction ?? '—'})`],
              [t('notices.term'), `${f.date(n.agreement.startDate)} – ${f.date(n.agreement.endDate)}`],
              ...(n.cureDeadline ? [[t('notices.cureDeadline'), f.date(n.cureDeadline)] as [string, string]] : []),
              ...(n.issuedAt ? [[t('notices.issued'), f.date(n.issuedAt)] as [string, string]] : []),
              ...(n.counselReviewedAt ? [[t('notices.counsel'), `${f.date(n.counselReviewedAt)}${n.counselNote ? ` · ${n.counselNote}` : ''}`] as [string, string]] : []),
            ]} />
            {n.jurisdictionNotes.map((j) => <Banner key={j.code} tone="neutral" icon="info" title={t('notices.jurisdictionNote', { code: j.code })}>{j.renewalTermination}</Banner>)}
            <ActionError error={act.error} />
            {n.status === 'draft' && (
              <div className="flex flex-col gap-2">
                {o.can.edit && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ subject: n.subject, body: n.body })}>{t('notices.edit')}</Button>}
                {o.can.publish && <Button size="sm" variant={n.counselReviewed ? 'ghost' : 'secondary'} icon="scale" onClick={async () => { if (await act.run(() => fdevApi.counselReview(n.id, !n.counselReviewed))) reload(); }}>{n.counselReviewed ? t('notices.unreview') : t('notices.markReviewed')}</Button>}
                {o.can.publish && <Field label={t('notices.deliveredTo')} optional>{(x) => <Input id={x.id} value={deliveredTo} onChange={(e) => setDeliveredTo(e.target.value)} />}</Field>}
                {o.can.publish && <Button size="sm" icon="send" disabled={!n.counselReviewed} onClick={async () => { if (await act.run(() => fdevApi.issueNotice(n.id, deliveredTo))) reload(); }}>{t('notices.issue')}</Button>}
                {!n.counselReviewed && <p className="text-xs text-stone">{t('notices.reviewFirst')}</p>}
              </div>
            )}
            {n.kind === 'default' && ['issued', 'escalated'].includes(n.status) && o.can.publish && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon="check" onClick={async () => { if (await act.run(() => fdevApi.resolveNotice(n.id, 'cured'))) reload(); }}>{t('notices.cured')}</Button>
                <Button size="sm" variant="secondary" icon="clock" onClick={async () => { const r = await act.run(() => fdevApi.resolveNotice(n.id, 'escalate', { extendDays: 10 })); if (r) { reload(); onOpen(r.id); } }}>{t('notices.escalate')}</Button>
                <Button size="sm" variant="danger" icon="alert" disabled={!n.cureOverdue && n.daysLeft !== null && n.daysLeft >= 0} onClick={async () => { const r = await act.run(() => fdevApi.resolveNotice(n.id, 'terminate')); if (r) { reload(); onOpen(r.id); } }}>{t('notices.terminate')}</Button>
                <Button size="sm" variant="ghost" onClick={async () => { const r = await act.run(() => fdevApi.resolveNotice(n.id, 'withdraw')); if (r) { reload(); onOpen(r.id); } }}>{t('notices.withdraw')}</Button>
              </div>
            )}
            <Button size="sm" variant="ghost" icon="download" onClick={() => void download(`/lifecycle/notices/${n.id}/pdf`, `notice-${n.id.slice(0, 8)}.pdf`)}>{t('notices.pdf')}</Button>
            {n.history.length > 1 && (
              <div>
                <h4 className="mb-1 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('notices.history')}</h4>
                <ol className="flex flex-col gap-1 text-[13px]">{n.history.map((h: NoticeVM) => <li key={h.id} className="flex items-center justify-between gap-2"><span>{t(`noticeKind.${h.kind}` as 'noticeKind.default')} · {f.date(h.issuedAt ?? h.createdAt)}</span><StatusBadge status={h.status} /></li>)}</ol>
              </div>
            )}
          </div>
        </div>
      )}
    </Async>
  );
}

/* ------------------------------- amendments ------------------------------ */

function Amendments({ o, agreements }: { o: OverviewVM; agreements: AgreementPick[] }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.amendments(), []);
  const act = useAction();
  const [v, setV] = useState({ agreementId: '', title: '', royalty: '', endDate: '', effectiveDate: new Date().toISOString().slice(0, 10) });
  const name = (id: string) => { const a = agreements.find((x) => x.id === id); return a ? agreementLabel(a) : '—'; };
  const fmtChange = (k: string, val: string | number | null) => (val === null ? '—' : k.endsWith('Bps') ? f.pct(Number(val) / 100) : k === 'endDate' ? f.date(String(val)) : String(val));
  return (
    <>
      {o.can.edit && (
        <SectionCard title={t('amendments.new')}>
          <div className="grid gap-2 sm:grid-cols-[1.3fr_1.2fr_120px_150px_150px]">
            <Field label={t('lifecycle.agreement')}>{(x) => <Select id={x.id} value={v.agreementId} onChange={(e) => setV((s) => ({ ...s, agreementId: e.target.value }))}><option value="">—</option>{agreements.map((a) => <option key={a.id} value={a.id}>{agreementLabel(a)}</option>)}</Select>}</Field>
            <Field label={t('amendments.titleField')}>{(x) => <Input id={x.id} value={v.title} onChange={(e) => setV((s) => ({ ...s, title: e.target.value }))} />}</Field>
            <Field label={t('amendments.royalty')} optional>{(x) => <Input id={x.id} inputMode="decimal" value={v.royalty} onChange={(e) => setV((s) => ({ ...s, royalty: e.target.value }))} />}</Field>
            <Field label={t('amendments.endDate')} optional>{(x) => <Input id={x.id} type="date" value={v.endDate} onChange={(e) => setV((s) => ({ ...s, endDate: e.target.value }))} />}</Field>
            <Field label={t('amendments.effective')}>{(x) => <Input id={x.id} type="date" value={v.effectiveDate} onChange={(e) => setV((s) => ({ ...s, effectiveDate: e.target.value }))} />}</Field>
          </div>
          <ActionError error={act.error} />
          <Button className="mt-2" icon="plus" disabled={!v.agreementId || !v.title.trim() || (!v.royalty && !v.endDate)} loading={act.pending} onClick={async () => {
            const changes: Record<string, string | number> = {};
            if (v.royalty) changes.royaltyBps = Math.round(Number(v.royalty) * 100);
            if (v.endDate) changes.endDate = v.endDate;
            if (await act.run(() => fdevApi.createAmendment({ agreementId: v.agreementId, title: v.title.trim(), changes, effectiveDate: v.effectiveDate }))) { setV((s) => ({ ...s, title: '', royalty: '', endDate: '' })); res.reload(); }
          }}>{t('amendments.create')}</Button>
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="edit" title={t('amendments.empty')} />}>
        {(d) => (
          <div className="flex flex-col gap-2">
            {d.items.map((m) => (
              <article key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface p-3.5 text-[13px]">
                <span>
                  <strong>{m.title}</strong> · {name(m.agreementId)}
                  <span className="block text-xs text-stone">{Object.entries(m.changes).map(([k, val]) => `${t(`amendmentField.${k}` as 'amendmentField.royaltyBps')}: ${m.status === 'signed' && k in m.previous ? `${fmtChange(k, m.previous[k] ?? null)} → ` : ''}${fmtChange(k, val)}`).join(' · ')} · {t('amendments.effectiveOn', { date: f.date(m.effectiveDate) })}</span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={m.status} />
                  {m.status === 'draft' && o.can.publish && <Button size="sm" icon="signature" onClick={async () => { if (await act.run(() => fdevApi.signAmendment(m.id))) res.reload(); }}>{t('amendments.sign')}</Button>}
                  {m.status === 'draft' && o.can.edit && <Button size="sm" variant="ghost" onClick={async () => { if (await act.run(() => fdevApi.cancelAmendment(m.id))) res.reload(); }}>{t('common.cancel')}</Button>}
                </span>
              </article>
            ))}
            <p className="text-xs text-stone">{t('amendments.signHint')}</p>
          </div>
        )}
      </Async>
    </>
  );
}

/* -------------------------------- renewals ------------------------------- */

function Renewals({ o }: { o: OverviewVM }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const res = useLoad(() => fdevApi.renewals(), []);
  const act = useAction();
  const [noticeOn, setNoticeOn] = useState<Record<string, string>>({});
  return (
    <>
      <ActionError error={act.error} />
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="calendar" title={t('renewals.empty')} />}>
        {(d) => (
          <div className="flex flex-col gap-3">
            {d.items.map((r) => (
              <article key={r.id} className="rounded-xl bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="text-[13px]">
                    <strong className="text-[15px]">{r.ownerGroupName ?? '—'}</strong>{r.territory ? ` · ${r.territory}` : ''}
                    <span className="block text-xs text-stone">{t('renewals.ends', { date: f.date(r.endDate) })}{r.renewalOption ? ` · ${r.renewalOption}` : ''}</span>
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="mt-3" role="img" aria-label={t('renewals.window', { from: f.date(r.windowOpensOn), to: f.date(r.windowClosesOn) })}>
                  <div className="flex justify-between text-[11px] text-stone"><span>{f.date(r.windowOpensOn)}</span><span>{f.date(r.windowClosesOn)}</span><span>{f.date(r.endDate)}</span></div>
                  <div className="relative mt-1 h-2 rounded-full bg-canvas"><span className={cx('absolute inset-y-0 start-0 w-2/3 rounded-full', r.phase === 'window_open' ? 'bg-[#D9A400]' : 'bg-line')} /></div>
                  <p className="mt-1 text-xs">{t(`renewals.phase.${r.phase}` as 'renewals.phase.upcoming', { days: r.daysToWindowClose })}</p>
                </div>
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {RENEWAL_CONDITIONS.map((k) => { const c = r.conditions.find((x) => x.key === k); return (
                    <li key={k}><button type="button" disabled={!o.can.edit || ['renewed', 'declined'].includes(r.status)} aria-pressed={!!c?.done} onClick={async () => { if (await act.run(() => fdevApi.renewalCondition(r.agreementId, k, !c?.done))) res.reload(); }} className={cx('h-8 rounded-full px-3 text-xs font-bold', c?.done ? 'bg-[#E2F5A6]' : 'bg-canvas')}>{c?.done ? '✓ ' : ''}{t(`renewalCondition.${k}`)}</button></li>
                  ); })}
                </ul>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  {o.can.edit && ['upcoming', 'window_open'].includes(r.status) && (
                    <>
                      <div className="w-44"><Field label={t('renewals.noticeOn')}>{(x) => <Input id={x.id} type="date" value={noticeOn[r.id] ?? ''} onChange={(e) => setNoticeOn((s) => ({ ...s, [r.id]: e.target.value }))} />}</Field></div>
                      <Button size="sm" variant="secondary" disabled={!noticeOn[r.id]} onClick={async () => { if (await act.run(() => fdevApi.renewalNotice(r.agreementId, noticeOn[r.id]!))) res.reload(); }}>{t('renewals.recordNotice')}</Button>
                    </>
                  )}
                  {o.can.publish && ['notice_received', 'window_open'].includes(r.status) && <Button size="sm" icon="check" onClick={async () => { if (await act.run(() => fdevApi.decideRenewal(r.agreementId, 'approve'))) res.reload(); }}>{t('renewals.approve')}</Button>}
                  {o.can.publish && ['notice_received', 'window_open'].includes(r.status) && <Button size="sm" variant="ghost" onClick={async () => { if (await act.run(() => fdevApi.decideRenewal(r.agreementId, 'decline'))) res.reload(); }}>{t('renewals.decline')}</Button>}
                  {o.can.publish && r.status === 'approved' && <Button size="sm" icon="repeat" onClick={async () => { if (await act.run(() => fdevApi.completeRenewal(r.agreementId))) res.reload(); }}>{t('renewals.renew')}</Button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
