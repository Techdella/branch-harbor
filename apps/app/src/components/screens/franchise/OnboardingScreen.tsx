'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, cx } from '@bh/ui';
import { franchiseApi, useFranchise, useFranchiseAction, type Project, type Task } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { FAsync, NetworkOnly, useFmt } from './common';
import { PreOpeningAudit } from '../../quality/PreOpeningAudit';

const COLUMNS: Project['status'][] = ['active', 'go_live_requested', 'opened'];
const SECTIONS = ['training', 'site_selection', 'lease', 'fit_out', 'suppliers', 'marketing', 'systems', 'pre_opening'] as const;

export function OnboardingScreen() {
  return <NetworkOnly><Onboarding /></NetworkOnly>;
}

function Onboarding() {
  const t = useTranslations('franchise');
  const app = useApp();
  const router = useRouter();
  const selected = useSearchParams().get('project');
  const res = useFranchise(() => franchiseApi.projects(), [app.org.id]);
  const f = useFmt();
  return (
    <>
      <PageHeader
        icon="building" title={t('onboarding.title')} description={t('onboarding.description')} scope={false}
        actions={!app.can('legal.view') && !app.can('franchise.pipeline.view') ? <Link href="/franchise/agreements" className="inline-flex h-10 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold hover:bg-line-soft"><Icon name="scale" size={15} />{t('nav.ownAgreement')}</Link> : undefined}
      />
      <FAsync res={res}>
        {(items) => items.length ? (
          <div className="grid gap-3 lg:grid-cols-3">
            {COLUMNS.map((col) => (
              <section key={col} aria-labelledby={`proj-${col}`} className="flex flex-col gap-2 rounded-xl bg-surface p-3">
                <h2 id={`proj-${col}`} className="px-1 text-[13px] font-extrabold">{t(`projectStatus.${col}`)} <span className="text-stone">{items.filter((p) => p.status === col).length}</span></h2>
                {items.filter((p) => p.status === col).map((p) => (
                  <button key={p.id} type="button" onClick={() => router.push(`/franchise/onboarding?project=${p.id}`)} className={cx('flex flex-col gap-1.5 rounded-lg border-[1.5px] bg-canvas-raised p-3 text-left', selected === p.id ? 'border-ink' : 'border-transparent hover:border-ink')}>
                    <span className="text-[13px] font-bold">{p.name}</span>
                    <span className="text-xs text-graphite">{p.prospectName}{p.location ? ` · ${p.location.name}` : ` · ${t('onboarding.notProvisioned')}`}</span>
                    <span className="h-1.5 w-full overflow-hidden rounded-full bg-canvas" aria-hidden="true"><span className="block h-full bg-ink" style={{ width: `${p.progress.total ? Math.round((p.progress.done / p.progress.total) * 100) : 0}%` }} /></span>
                    <span className="flex flex-wrap gap-1">
                      <Badge tone="neutral">{t('onboarding.progress', { done: p.progress.done, total: p.progress.total })}</Badge>
                      <Badge tone={p.gates.done === p.gates.total ? 'success' : 'warning'} icon="shield">{t('onboarding.gates', { done: p.gates.done, total: p.gates.total })}</Badge>
                      {p.progress.overdue > 0 && <Badge tone="danger">{t('pipeline.overdue', { count: p.progress.overdue })}</Badge>}
                      {p.targetOpenDate && <Badge tone="neutral" icon="flag">{f.date(p.targetOpenDate)}</Badge>}
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        ) : <Empty icon="building" title={t('onboarding.empty')} body={t('onboarding.emptyBody')} />}
      </FAsync>
      {selected && <ProjectDrawer id={selected} onClose={() => router.push('/franchise/onboarding')} onChanged={res.reload} />}
    </>
  );
}

function ProjectDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const res = useFranchise(() => franchiseApi.project(id), [app.org.id, id]);
  const act = useFranchiseAction();
  const [prov, setProv] = useState({ open: false, name: '', code: '', line1: '', city: '', region: '', country: 'US', postalCode: '', timeZone: 'America/New_York', currency: String(app.org.defaultCurrency ?? 'USD'), ownerEmail: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => { res.reload(); onChanged(); };
  const isHq = app.can('franchise.pipeline.edit');
  const complete = async (task: Task) => { if (await act.run(() => (task.status === 'done' ? franchiseApi.reopenTask(task.id) : franchiseApi.completeTask(task.id)))) refresh(); };
  return (
    <Drawer open onClose={onClose} title={res.data?.name ?? t('onboarding.title')} kicker={res.data ? t(`projectStatus.${res.data.status}`) : undefined}>
      <FAsync res={res} variant="detail">
        {(p) => (
          <div className="flex flex-col gap-4">
            {notice && <Banner tone="success" live="polite">{notice}</Banner>}
            {act.error && <Banner tone="danger" live="assertive">{act.error.message}</Banner>}
            <div className="flex flex-wrap gap-2 text-[13px]">
              {p.prospectId && <Link className="font-bold underline" href={`/franchise/prospect?id=${p.prospectId}`}>{p.prospectName}</Link>}
              {p.location && <Badge tone={p.location.status === 'operating' ? 'success' : 'neutral'} icon="pin">{p.location.name} · {t(`locationStatus.${p.location.status}` as 'locationStatus.onboarding')}</Badge>}
              {p.ownerInvitationId && <Badge tone="info" icon="mail">{t('onboarding.ownerInvited', { email: p.ownerEmail ?? '' })}</Badge>}
            </div>
            {!p.location && isHq && p.status === 'active' && (
              prov.open ? (
                <div className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3">
                  <span className="text-[13px] font-bold">{t('onboarding.provisionTitle')}</span>
                  <p className="text-xs text-stone">{t('onboarding.provisionHint')}</p>
                  <Field label={t('onboarding.locationName')}>{(x) => <Input id={x.id} value={prov.name} onChange={(e) => setProv((s) => ({ ...s, name: e.target.value }))} />}</Field>
                  <Field label={t('onboarding.code')}>{(x) => <Input id={x.id} value={prov.code} maxLength={24} onChange={(e) => setProv((s) => ({ ...s, code: e.target.value.toUpperCase() }))} />}</Field>
                  <Field label={t('onboarding.address')}>{(x) => <Input id={x.id} value={prov.line1} onChange={(e) => setProv((s) => ({ ...s, line1: e.target.value }))} />}</Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('prospect.city')}>{(x) => <Input id={x.id} value={prov.city} onChange={(e) => setProv((s) => ({ ...s, city: e.target.value }))} />}</Field>
                    <Field label={t('onboarding.postalCode')} optional>{(x) => <Input id={x.id} value={prov.postalCode} onChange={(e) => setProv((s) => ({ ...s, postalCode: e.target.value }))} />}</Field>
                    <Field label={t('prospect.region')} optional>{(x) => <Input id={x.id} value={prov.region} onChange={(e) => setProv((s) => ({ ...s, region: e.target.value.toUpperCase() }))} />}</Field>
                    <Field label={t('prospect.country')}>{(x) => <Input id={x.id} maxLength={2} value={prov.country} onChange={(e) => setProv((s) => ({ ...s, country: e.target.value.toUpperCase() }))} />}</Field>
                    <Field label={t('onboarding.timeZone')}>{(x) => <Input id={x.id} value={prov.timeZone} onChange={(e) => setProv((s) => ({ ...s, timeZone: e.target.value }))} />}</Field>
                    <Field label={t('prospect.currency')}>{(x) => <Input id={x.id} maxLength={3} value={prov.currency} onChange={(e) => setProv((s) => ({ ...s, currency: e.target.value.toUpperCase() }))} />}</Field>
                  </div>
                  <Field label={t('onboarding.ownerEmail')} hint={t('onboarding.ownerEmailHint')}>{(x) => <Input id={x.id} type="email" value={prov.ownerEmail || p.ownerEmail || ''} onChange={(e) => setProv((s) => ({ ...s, ownerEmail: e.target.value }))} />}</Field>
                  <Button icon="layers" disabled={!prov.name || !prov.code || !prov.line1 || !prov.city} loading={act.pending} onClick={async () => {
                    const r = await act.run(() => franchiseApi.provision(p.id, { name: prov.name, code: prov.code, address: { line1: prov.line1, city: prov.city, region: prov.region || undefined, postalCode: prov.postalCode || undefined, country: prov.country }, timeZone: prov.timeZone, currency: prov.currency, ownerEmail: prov.ownerEmail || p.ownerEmail || undefined }));
                    if (r) { setNotice(t('onboarding.provisioned')); setProv((s) => ({ ...s, open: false })); refresh(); }
                  }}>{t('onboarding.provision')}</Button>
                </div>
              ) : <Button icon="layers" variant="secondary" onClick={() => setProv((s) => ({ ...s, open: true }))}>{t('onboarding.provision')}</Button>
            )}
            <PreOpeningAudit project={p} onChanged={refresh} />
            {p.status === 'active' && (
              <div className="flex flex-col gap-1 rounded-lg bg-canvas-raised p-3">
                <span className="text-[13px] font-bold">{t('onboarding.goLiveTitle')}</span>
                <span className="text-xs text-stone">{p.canRequestGoLive ? t('onboarding.goLiveReady') : t('onboarding.goLiveNotReady', { done: p.gates.done, total: p.gates.total })}</span>
                <Button className="mt-1 self-start" variant="signal" icon="flag" disabled={!p.canRequestGoLive} loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.goLive(p.id))) { setNotice(t('onboarding.goLiveRequested')); refresh(); } }}>{t('onboarding.requestGoLive')}</Button>
              </div>
            )}
            {p.status === 'go_live_requested' && <Banner tone="info" icon="shield" action={<Link className="font-bold underline" href="/approvals">{t('onboarding.openApprovals')}</Link>}>{t('onboarding.waitingApproval')}</Banner>}
            {p.status === 'opened' && <Banner tone="success" icon="store">{t('onboarding.opened', { date: f.date(p.openedAt) })}</Banner>}
            {SECTIONS.map((sec) => {
              const tasks = (p.tasks ?? []).filter((x) => x.section === sec);
              if (!tasks.length) return null;
              return (
                <section key={sec} aria-labelledby={`sec-${sec}`}>
                  <h3 id={`sec-${sec}`} className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.04em] text-stone">{t(`section.${sec}`)}</h3>
                  <ul className="flex flex-col gap-1">
                    {tasks.map((x) => (
                      <li key={x.id} className="flex items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">
                        <button type="button" role="checkbox" aria-checked={x.status === 'done'} aria-label={x.title} disabled={act.pending || p.status !== 'active'} onClick={() => complete(x)} className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded border-[1.5px]', x.status === 'done' ? 'border-ink bg-ink text-white' : 'border-line bg-surface')}>
                          {x.status === 'done' && <Icon name="check" size={13} />}
                        </button>
                        <span className={cx('min-w-0 flex-1', x.status === 'done' && 'text-stone line-through')}>{x.title}</span>
                        {x.gate && <Badge tone="warning" icon="shield">{t('onboarding.gate')}</Badge>}
                        <Badge tone="neutral">{t(`assignee.${x.assignee}`)}</Badge>
                        <span className={cx('text-xs', x.overdue ? 'font-bold text-danger' : 'text-stone')}>{f.date(x.dueAt, { day: 'numeric', month: 'short' })}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </FAsync>
    </Drawer>
  );
}
