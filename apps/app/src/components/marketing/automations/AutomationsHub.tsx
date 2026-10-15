'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AUTOMATION_TEMPLATES, automationTemplate, type AutomationGraph, type AutomationTemplate } from '@bh/shared';
import { Badge, Button, Drawer, Field, Icon, Input, Select } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, Empty, ErrorState, LoadingBlock } from '@/components/ui/States';
import { mkt, useAction, useLoad, useMkt } from '../data';

const TEMPLATE_ICONS: Record<AutomationTemplate, 'heart' | 'calendar' | 'refresh' | 'gift' | 'star' | 'flag'> = { welcome_series: 'heart', trial_follow_up: 'calendar', win_back: 'refresh', birthday: 'gift', review_request: 'star', coming_soon_launch: 'flag' };

export function AutomationsHub() {
  const t = useTranslations('mkt');
  const router = useRouter();
  const { orgId } = useMkt();
  const res = useLoad(orgId, (o) => mkt.automations(o));
  const [create, setCreate] = useState<AutomationTemplate | 'blank' | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="workflow" title={t('auto.title')} description={t('auto.description')} />
      <section aria-labelledby="auto-templates">
        <h2 id="auto-templates" className="mb-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('auto.templates')}</h2>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="list">
          {AUTOMATION_TEMPLATES.map((k) => (
            <li key={k}>
              <button type="button" onClick={() => setCreate(k)} className="flex h-full w-full flex-col gap-2 rounded-xl bg-surface p-4 text-start hover:ring-2 hover:ring-ink">
                <Icon name={TEMPLATE_ICONS[k]} />
                <span className="font-bold">{t(`auto.tpl.${k}.name` as never)}</span>
                <span className="text-sm text-stone">{t(`auto.tpl.${k}.body` as never)}</span>
              </button>
            </li>
          ))}
          <li><button type="button" onClick={() => setCreate('blank')} className="flex h-full w-full flex-col gap-2 rounded-xl border-2 border-dashed border-line p-4 text-start hover:border-ink"><Icon name="plus" /><span className="font-bold">{t('auto.blank')}</span><span className="text-sm text-stone">{t('auto.blankBody')}</span></button></li>
        </ul>
      </section>
      <section aria-labelledby="auto-list">
        <h2 id="auto-list" className="mb-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('auto.yours')}</h2>
        {res.status === 'error' && <ErrorState error={res.error} onRetry={res.reload} />}
        {!res.data && res.status === 'loading' && <LoadingBlock variant="table" />}
        {res.data && (res.data.items.length === 0 ? <Empty icon="workflow" title={t('auto.emptyTitle')} body={t('auto.emptyBody')} /> : (
          <ul className="divide-y divide-line-soft rounded-xl bg-surface" role="list">
            {res.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1"><div className="font-bold">{a.name}</div><div className="text-xs text-stone">{t(`auto.trigger.${a.triggerEvent}` as never)} · {t('auto.runsLine', { active: a.stats.active, completed: a.stats.completed })}</div></div>
                <Badge tone={a.status === 'active' ? 'success' : a.status === 'paused' ? 'warning' : 'neutral'}>{t(`auto.status.${a.status}` as never)}</Badge>
                <Link href={`/marketing/automations/${a.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white"><Icon name="edit" size={14} />{t('websites.edit')}</Link>
              </li>
            ))}
          </ul>
        ))}
      </section>
      {create && orgId && <CreateDrawer orgId={orgId} kind={create} onClose={() => setCreate(null)} onCreated={(id) => router.push(`/marketing/automations/${id}`)} />}
    </div>
  );
}

function CreateDrawer({ orgId, kind, onClose, onCreated }: { orgId: string; kind: AutomationTemplate | 'blank'; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('mkt');
  const { locations, can } = useMkt();
  const a = useAction();
  const [name, setName] = useState(kind === 'blank' ? '' : t(`auto.tpl.${kind}.name` as never));
  const [scope, setScope] = useState(can('automations.manage') ? 'org' : locations[0]?.id ?? 'org');
  async function create() {
    const graph: AutomationGraph = kind === 'blank'
      ? { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'lead.created' } }], edges: [] }
      : automationTemplate(kind, { sms: t('auto.copy.sms'), task: t('auto.copy.task'), tag: t('auto.copy.tag') });
    const r = await a.run(() => mkt.createAutomation(orgId, { name: name.trim(), scope: scope === 'org' ? { kind: 'organization', id: orgId } : { kind: 'location', id: scope }, graph }));
    if (r) onCreated(r.id);
  }
  return (
    <Drawer open onClose={onClose} title={t('auto.create')} kicker={kind === 'blank' ? t('auto.blank') : t(`auto.tpl.${kind}.name` as never)} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={create}>{t('websites.create')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('auto.name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
        <Field label={t('auto.runsFor')}>{(p) => <Select id={p.id} value={scope} onChange={(e) => setScope(e.target.value)}><option value="org">{t('email.wholeNetwork')}</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <p className="text-sm text-stone">{t('auto.createHint')}</p>
      </div>
    </Drawer>
  );
}
