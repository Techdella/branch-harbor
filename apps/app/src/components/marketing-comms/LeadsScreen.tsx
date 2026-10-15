'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Tabs, type Tone } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { NotAvailable } from '../screens/NotAvailable';
import { salesApi, type Lead } from './api';
import { useCan, useLocationName, useMoney } from './shared';

const LEAD_TONE: Record<string, Tone> = { new: 'info', contacted: 'neutral', qualified: 'success', converted: 'success', lost: 'neutral' };
type TabKey = 'customer' | 'course' | 'pipeline' | 'routing';

/**
 * Sales: customer leads (routed to locations and people), course leads from teacher-training campaigns (routed to
 * instructors), the customer pipeline and the routing rules. Each tab appears only with the matching module.
 */
export function LeadsScreen() {
  const t = useTranslations('comms.leads');
  const can = useCan();
  const tabs: Array<{ key: TabKey; label: string }> = [];
  if (can('sales.customer_pipeline')) tabs.push({ key: 'customer', label: t('tab.customer') }, { key: 'pipeline', label: t('tab.pipeline') });
  if (can('sales.course_leads')) tabs.push({ key: 'course', label: t('tab.course') });
  if (can('sales.customer_pipeline', 'publish') || can('sales.course_leads', 'edit')) tabs.push({ key: 'routing', label: t('tab.routing') });
  // Deep links (notifications): /sales/leads?tab=course.
  const [tab, setTab] = useState<TabKey | null>((useSearchParams().get('tab') as TabKey | null) ?? null);
  if (!tabs.length) return <NotAvailable />;
  const current = tab && tabs.some((x) => x.key === tab) ? tab : tabs[0]!.key;
  return (
    <>
      <PageHeader icon="trending" title={t('title')} description={t('description')} />
      <Tabs items={tabs} value={current} onChange={setTab} />
      {(current === 'customer' || current === 'course') && <LeadList kind={current} />}
      {current === 'pipeline' && <Pipeline />}
      {current === 'routing' && <Routing kind={can('sales.customer_pipeline', 'publish') ? 'customer' : 'course'} />}
    </>
  );
}

function LeadList({ kind }: { kind: 'customer' | 'course' }) {
  const t = useTranslations('comms.leads');
  const app = useApp();
  const locale = useLocale();
  const locName = useLocationName();
  const can = useCan();
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(kind === 'course');
  const res = useApi(() => salesApi.leads({ kind, status, assigned: mine ? 'me' : 'any' }), [kind, status, mine, app.org.id]);
  const upd = useMutation((_api, id: string, s: string) => salesApi.updateLead(id, { status: s }));
  const convert = useMutation((_api, id: string) => salesApi.convert(id));
  const editable = can(kind === 'course' ? 'sales.course_leads' : 'sales.customer_pipeline', 'edit');
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t('statusFilter')} className="h-10 w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          {['open', 'new', 'contacted', 'qualified', 'converted', 'lost', 'all'].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />{t('mine')}</label>
      </div>
      {(upd.error || convert.error) && <Banner tone="danger">{(upd.error ?? convert.error)!.message}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" rows={5} />}>
        {(d) => {
          if (!d.items.length) return <Empty icon="trending" title={t('empty')} />;
          return (
            <ul className="flex flex-col gap-2" data-testid="lead-list">
              {d.items.map((l: Lead) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{l.name ?? l.email ?? l.phone}</span>
                      <Badge tone={LEAD_TONE[l.status] ?? 'neutral'}>{t(`status.${l.status}`)}</Badge>
                      <span className="text-xs text-stone">{t(`source.${l.source}`)}</span>
                    </div>
                    <p className="text-[13px] text-stone">{[l.email, l.phone].filter(Boolean).join(' · ')} · {locName(l.locationId)} · {relativeTime(l.createdAt, locale)}</p>
                    {l.message && <p className="mt-1 text-[13px]">“{l.message}”</p>}
                    {l.campaign && <p className="text-xs text-stone">{t('campaign', { name: l.campaign })}</p>}
                    <p className="text-xs text-stone">{l.assignedUser ? t('assignedTo', { name: l.assignedUser.name ?? '' }) : t('unassigned')}</p>
                  </div>
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      <Select aria-label={t('setStatus')} className="h-10 w-auto" value={l.status} onChange={async (e) => { if (await upd.run(l.id, e.target.value)) res.reload(); }}>
                        {['new', 'contacted', 'qualified', 'lost'].map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
                      </Select>
                      {kind === 'customer' && l.status !== 'converted' && l.locationId && <Button size="sm" variant="secondary" loading={convert.pending} onClick={async () => { if (await convert.run(l.id)) res.reload(); }}>{t('convert')}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
    </>
  );
}

function Pipeline() {
  const t = useTranslations('comms.leads');
  const app = useApp();
  const money = useMoney();
  const locName = useLocationName();
  const can = useCan();
  const res = useApi(() => salesApi.deals(), [app.org.id]);
  const move = useMutation((_api, id: string, stageId: string) => salesApi.moveDeal(id, stageId));
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />}>
      {(d) => (
        <>
          {move.error && <Banner tone="danger">{move.error.message}</Banner>}
          <div className="grid gap-3 overflow-x-auto pb-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]" data-testid="pipeline">
            {d.stages.map((st) => {
              const deals = d.items.filter((x) => x.stageId === st.id);
              return (
                <section key={st.id} className="flex flex-col gap-2 rounded-xl bg-canvas p-3" aria-label={st.name}>
                  <h2 className="flex items-center justify-between text-sm font-bold">{st.name}<span className="tabular text-xs text-stone">{deals.length}</span></h2>
                  {deals.map((x) => (
                    <article key={x.id} className="flex flex-col gap-1 rounded-lg bg-surface p-3 text-[13px]">
                      <span className="font-bold">{x.title}</span>
                      <span className="tabular">{money(x.value.amount, x.value.currency)}</span>
                      <span className="text-xs text-stone">{locName(x.locationId)}{x.owner?.name ? ` · ${x.owner.name}` : ''}{x.openTasks ? ` · ${t('openTasks', { count: x.openTasks })}` : ''}</span>
                      {can('sales.customer_pipeline', 'edit') && (
                        <Select aria-label={t('moveTo')} className="h-9 text-xs" value={x.stageId} onChange={async (e) => { if (await move.run(x.id, e.target.value)) res.reload(); }}>
                          {d.stages.map((s2) => <option key={s2.id} value={s2.id}>{s2.name}</option>)}
                        </Select>
                      )}
                    </article>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </Async>
  );
}

function Routing({ kind }: { kind: 'customer' | 'course' }) {
  const t = useTranslations('comms.leads');
  const locName = useLocationName();
  const res = useApi(() => salesApi.rules(kind), [kind]);
  const [postal, setPostal] = useState('');
  const [source, setSource] = useState('website');
  const test = useMutation(() => salesApi.testRule({ kind, postalCode: postal || null, source }));
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
      <Async res={res} loading={<LoadingBlock variant="table" rows={3} />}>
        {(d) => (
          <SectionCard title={t('routing.title')}>
            <p className="mb-3 text-sm text-stone">{t('routing.body')}</p>
            {d.items.length === 0 && <p className="text-sm text-stone">{t('routing.empty')}</p>}
            <ol className="flex flex-col gap-2">
              {d.items.map((r, i) => (
                <li key={r.id} className="rounded-lg border border-line-soft p-3 text-[13px]">
                  <span className="font-bold">{i + 1}. {r.name}</span>{!r.active && <Badge tone="neutral" className="ml-2">{t('routing.off')}</Badge>}
                  <p className="text-stone">
                    {[r.conditions.postalPrefixes?.length ? t('routing.postal', { list: r.conditions.postalPrefixes.join(', ') }) : null, r.conditions.sources?.length ? t('routing.sources', { list: r.conditions.sources.join(', ') }) : null, r.conditions.countries?.length ? t('routing.countries', { list: r.conditions.countries.join(', ') }) : null].filter(Boolean).join(' · ') || t('routing.anyLead')}
                    {' → '}
                    {r.action.type === 'location' ? locName(r.action.locationId) : r.action.type === 'users' ? t('routing.people', { count: r.action.userIds?.length ?? 0 }) : t('routing.team', { location: locName(r.action.locationId ?? null) })}
                  </p>
                </li>
              ))}
            </ol>
          </SectionCard>
        )}
      </Async>
      <SectionCard title={t('routing.testTitle')}>
        <div className="flex flex-col gap-3">
          <Field label={t('routing.postalLabel')} optional>{(f) => <Input id={f.id} value={postal} onChange={(e) => setPostal(e.target.value)} />}</Field>
          <Field label={t('routing.sourceLabel')}>{(f) => <Select id={f.id} value={source} onChange={(e) => setSource(e.target.value)}>{['website', 'instagram', 'sms', 'whatsapp', 'email', 'ad_campaign', 'course_campaign'].map((s) => <option key={s} value={s}>{t(`source.${s}`)}</option>)}</Select>}</Field>
          <div><Button loading={test.pending} onClick={async () => { const r = await test.run(); if (r) setOutcome(r.ruleName ? t('routing.result', { rule: r.ruleName, target: r.assignedUserName ?? locName(r.locationId) }) : t('routing.noMatch')); }}>{t('routing.test')}</Button></div>
          {outcome && <Banner tone="info" live="polite">{outcome}</Banner>}
          {test.error && <Banner tone="danger">{test.error.message}</Banner>}
        </div>
      </SectionCard>
    </div>
  );
}
