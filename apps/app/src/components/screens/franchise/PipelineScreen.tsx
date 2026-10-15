'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Textarea, cx } from '@bh/ui';
import { FRANCHISE_STAGES, PROSPECT_SOURCES, type FranchiseStage } from '@bh/shared';
import { franchiseApi, useFranchise, useFranchiseAction, type Prospect, type Task } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { FAsync, NetworkOnly, STAGE_UI, useFmt } from './common';

const BOARD: FranchiseStage[] = FRANCHISE_STAGES.filter((s) => s !== 'lost');

export function PipelineScreen() {
  return <NetworkOnly><Pipeline /></NetworkOnly>;
}

function Pipeline() {
  const t = useTranslations('franchise');
  const app = useApp();
  const [view, setView] = useState<'board' | 'tasks' | 'lost'>('board');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const res = useFranchise(() => franchiseApi.prospects(), [app.org.id]);
  const canEdit = app.can('franchise.pipeline.edit');
  return (
    <>
      <PageHeader icon="flag" title={t('pipeline.title')} description={t('pipeline.description')} scope={false}
        actions={canEdit ? <Button icon="plus" onClick={() => setAdding(true)}>{t('pipeline.add')}</Button> : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs items={[{ key: 'board', label: t('pipeline.board') }, { key: 'tasks', label: t('pipeline.tasks') }, { key: 'lost', label: t('stage.lost') }]} value={view} onChange={setView} />
        {view !== 'tasks' && (
          <div className="ml-auto w-full sm:w-64">
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pipeline.search')} aria-label={t('pipeline.search')} />
          </div>
        )}
      </div>
      {view === 'tasks' ? <TaskList /> : (
        <FAsync res={res}>
          {(items) => {
            const ql = q.trim().toLowerCase();
            const list = items.filter((p) => !ql || [p.name, p.email, p.city, p.territoryName].filter(Boolean).join(' ').toLowerCase().includes(ql));
            if (view === 'lost') {
              const lost = list.filter((p) => p.stage === 'lost');
              return lost.length ? <div className="grid gap-2 md:grid-cols-2">{lost.map((p) => <ProspectCard key={p.id} p={p} />)}</div> : <Empty icon="check-circle" title={t('pipeline.noLost')} />;
            }
            if (!items.length) return <Empty icon="flag" title={t('pipeline.emptyTitle')} body={t('pipeline.emptyBody')} />;
            return (
              <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2" role="list" aria-label={t('pipeline.board')}>
                {BOARD.map((stage) => {
                  const cards = list.filter((p) => p.stage === stage);
                  return (
                    <section key={stage} role="listitem" aria-labelledby={`col-${stage}`} className="flex min-h-[320px] w-[250px] shrink-0 flex-col gap-2 rounded-xl bg-surface p-3">
                      <h2 id={`col-${stage}`} className="flex items-center gap-2 px-1 text-[13px] font-extrabold">
                        <span className={cx('h-2.5 w-2.5 rounded-full', STAGE_UI[stage].dot)} aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{t(`stage.${stage}`)}</span>
                        <span className="text-xs font-bold text-stone">{cards.length}</span>
                      </h2>
                      {cards.map((p) => <ProspectCard key={p.id} p={p} />)}
                    </section>
                  );
                })}
              </div>
            );
          }}
        </FAsync>
      )}
      <NewProspect open={adding} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); res.reload(); }} />
    </>
  );
}

function ProspectCard({ p }: { p: Prospect }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const waiting = p.signing && !p.signing.canSign && p.signing.blocker;
  return (
    <Link href={`/franchise/prospect?id=${p.id}`} className="flex flex-col gap-1.5 rounded-lg border-[1.5px] border-transparent bg-canvas-raised p-3 text-ink hover:border-ink focus-visible:border-ink">
      <span className="text-[13px] font-bold">{p.name}</span>
      <span className="text-xs text-graphite">{p.territoryName ?? p.desiredTerritory ?? [p.city, f.place(p.country, p.region)].filter(Boolean).join(' · ')}</span>
      <span className="flex flex-wrap gap-1">
        <Badge tone="neutral">{p.jurisdiction}</Badge>
        {p.units > 1 && <Badge tone="neutral">{t('pipeline.units', { count: p.units })}</Badge>}
        {waiting && (
          <Badge tone="warning" icon={p.signing!.blocker!.code === 'waiting_period' ? 'clock' : 'lock'}>
            {p.signing!.blocker!.code === 'waiting_period' && p.signing!.blocker!.until ? t('pipeline.waitingUntil', { date: f.date(p.signing!.blocker!.until, { day: 'numeric', month: 'short' }) }) : t(`blockerShort.${p.signing!.blocker!.code}` as 'blockerShort.registration_required')}
          </Badge>
        )}
        {p.signing?.canSign && <Badge tone="success" icon="signature">{t('pipeline.readyToSign')}</Badge>}
        {!!p.overdueTasks && <Badge tone="danger" icon="clock">{t('pipeline.overdue', { count: p.overdueTasks })}</Badge>}
        {p.stage === 'lost' && p.lostReason && <Badge tone="neutral">{p.lostReason}</Badge>}
      </span>
    </Link>
  );
}

function TaskList() {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const [mine, setMine] = useState(true);
  const res = useFranchise(() => franchiseApi.tasks({ mine, status: 'open' }), [app.org.id, mine]);
  const act = useFranchiseAction();
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={t('pipeline.taskFilter')} className="flex gap-1.5">
        {([true, false] as const).map((m) => (
          <button key={String(m)} type="button" aria-pressed={mine === m} onClick={() => setMine(m)} className={cx('h-9 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', mine === m ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
            {m ? t('pipeline.myTasks') : t('pipeline.allTasks')}
          </button>
        ))}
      </div>
      {act.error && <Banner tone="danger">{act.error.message}</Banner>}
      <FAsync res={res} variant="table">
        {(items) => items.filter((x) => !x.projectId).length ? (
          <ul className="flex flex-col gap-2">
            {items.filter((x) => !x.projectId).map((task: Task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface p-3">
                <Icon name={task.kind === 'email' ? 'mail' : task.kind === 'call' ? 'phone' : 'check-circle'} size={18} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold">{task.title}</div>
                  <div className="text-xs text-stone">
                    {task.prospectId ? <Link className="underline" href={`/franchise/prospect?id=${task.prospectId}`}>{task.prospectName}</Link> : null}
                    {task.dueAt ? ` · ${t('pipeline.due', { date: f.date(task.dueAt, { day: 'numeric', month: 'short' }) })}` : ''}
                    {task.ownerName ? ` · ${task.ownerName}` : ''}
                  </div>
                </div>
                {task.overdue && <Badge tone="danger">{t('pipeline.overdueOne')}</Badge>}
                {app.can('franchise.pipeline.edit') && (
                  <Button size="sm" variant="secondary" icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.completeTask(task.id))) res.reload(); }}>{t('pipeline.done')}</Button>
                )}
              </li>
            ))}
          </ul>
        ) : <Empty icon="check-circle" title={t('pipeline.noTasks')} />}
      </FAsync>
    </div>
  );
}

function NewProspect({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('franchise');
  const app = useApp();
  const act = useFranchiseAction();
  const [v, setV] = useState({ name: '', email: '', phone: '', country: 'US', region: '', city: '', desiredTerritory: '', source: 'referral', liquid: '', netWorth: '', currency: String(app.org.defaultCurrency ?? 'USD'), message: '' });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    const r = await act.run(() => franchiseApi.createProspect({
      name: v.name, email: v.email, phone: v.phone || null, country: v.country, region: v.region || null, city: v.city || null, desiredTerritory: v.desiredTerritory || null, source: v.source,
      liquidCapitalMinor: v.liquid ? Math.round(Number(v.liquid) * 100) : null, netWorthMinor: v.netWorth ? Math.round(Number(v.netWorth) * 100) : null, currency: v.currency, message: v.message || null,
    }));
    if (r) onCreated();
  };
  return (
    <Drawer open={open} onClose={onClose} title={t('pipeline.add')} footer={<Button onClick={submit} loading={act.pending} disabled={!v.name || !v.email || v.country.length !== 2}>{t('common.save')}</Button>}>
      <div className="flex flex-col gap-3">
        {act.error && <Banner tone="danger">{act.error.message}</Banner>}
        <Field label={t('prospect.name')}>{(p) => <Input id={p.id} value={v.name} onChange={set('name')} />}</Field>
        <Field label={t('prospect.email')}>{(p) => <Input id={p.id} type="email" value={v.email} onChange={set('email')} />}</Field>
        <Field label={t('prospect.phone')} optional>{(p) => <Input id={p.id} value={v.phone} onChange={set('phone')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('prospect.country')} hint={t('prospect.countryHint')}>{(p) => <Input id={p.id} value={v.country} maxLength={2} onChange={(e) => setV((x) => ({ ...x, country: e.target.value.toUpperCase() }))} />}</Field>
          <Field label={t('prospect.region')} hint={t('prospect.regionHint')} optional>{(p) => <Input id={p.id} value={v.region} maxLength={6} onChange={(e) => setV((x) => ({ ...x, region: e.target.value.toUpperCase() }))} />}</Field>
        </div>
        <Field label={t('prospect.city')} optional>{(p) => <Input id={p.id} value={v.city} onChange={set('city')} />}</Field>
        <Field label={t('prospect.desiredTerritory')} optional>{(p) => <Input id={p.id} value={v.desiredTerritory} onChange={set('desiredTerritory')} />}</Field>
        <Field label={t('prospect.source')}>{(p) => <Select id={p.id} value={v.source} onChange={set('source')}>{PROSPECT_SOURCES.map((s) => <option key={s} value={s}>{t(`source.${s}`)}</option>)}</Select>}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('prospect.liquidCapital')} optional>{(p) => <Input id={p.id} inputMode="numeric" value={v.liquid} onChange={set('liquid')} />}</Field>
          <Field label={t('prospect.netWorth')} optional>{(p) => <Input id={p.id} inputMode="numeric" value={v.netWorth} onChange={set('netWorth')} />}</Field>
          <Field label={t('prospect.currency')}>{(p) => <Input id={p.id} value={v.currency} maxLength={3} onChange={(e) => setV((x) => ({ ...x, currency: e.target.value.toUpperCase() }))} />}</Field>
        </div>
        <p className="text-xs text-stone">{t('prospect.selfDeclared')}</p>
        <Field label={t('prospect.notes')} optional>{(p) => <Textarea id={p.id} rows={3} value={v.message} onChange={set('message')} />}</Field>
      </div>
    </Drawer>
  );
}
