'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { downloadCsv, qualityApi, useQuality, useQualityAction, type ActionVM, type AuditVM, type TemplateVM } from './api';
import { ActionError, PillTabs, ScoreBadge, StatusBadge, Tiles, Trend, useQFmt } from './ui';
import { AuditSchedules, AuditTrends, VisitPlanner } from '../supply/AuditProgrammes';

type Tab = 'overview' | 'audits' | 'actions' | 'templates' | 'trends' | 'visits' | 'schedules';

/**
 * Operations → Audits. HQ: the dashboard (scores by location over time, overdue corrective actions), scheduling and
 * checklist templates. Auditors: the audits assigned to them. Locations: their reports and corrective actions.
 */
export function AuditsScreen() {
  const t = useTranslations('quality');
  const tp = useTranslations('auditsPlus');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const manage = app.capabilities.has('operations.audits:publish');
  const tab = (params.get('tab') as Tab) || 'overview';
  if (!app.hasModule('operations.audits')) return <DeniedState />;
  const tabs: Array<[Tab, string]> = [
    ['overview', t('audits.tab.overview')], ['audits', t('audits.tab.audits')], ['actions', t('audits.tab.actions')],
    // Audits phase 2: trends, the consultant's visit planner and (HQ) recurring schedules.
    ['trends', tp('tab.trends')], ['visits', tp('tab.visits')],
    ...(manage ? ([['schedules', tp('tab.schedules')], ['templates', t('audits.tab.templates')]] as Array<[Tab, string]>) : []),
  ];
  return (
    <>
      <PageHeader icon="check-circle" title={t('audits.title')} description={t('audits.description')} scope={false} />
      <PillTabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'audits' ? <AuditList /> : tab === 'actions' ? <ActionList /> : tab === 'templates' && manage ? <Templates /> : tab === 'trends' ? <AuditTrends /> : tab === 'visits' ? <VisitPlanner /> : tab === 'schedules' && manage ? <AuditSchedules /> : <Overview />}
    </>
  );
}

function Overview() {
  const t = useTranslations('quality');
  const app = useApp();
  const f = useQFmt();
  const res = useQuality(() => qualityApi.dashboard(6), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" />}>
      {(d) => (
        <>
          <Tiles items={[
            { label: t('dashboard.averageScore'), value: f.pct(d.totals.averageScorePct), sub: t('dashboard.lastMonths', { count: d.months.length }) },
            { label: t('dashboard.completed'), value: f.num(d.totals.completed), sub: t('dashboard.passed', { count: d.totals.passed }) },
            { label: t('dashboard.openActions'), value: f.num(d.totals.openActions) },
            { label: t('dashboard.overdueActions'), value: f.num(d.totals.overdueActions), tone: d.totals.overdueActions ? 'danger' : undefined },
            { label: t('dashboard.overdueAudits'), value: f.num(d.totals.overdueAudits), tone: d.totals.overdueAudits ? 'danger' : undefined },
          ]} />
          <SectionCard title={t('dashboard.byLocation')} aside={<span className="flex items-center gap-2 text-xs text-stone">{t('dashboard.network')} <Trend values={d.network.map((n) => n.averageScorePct)} labels={d.months.map(f.month)} /></span>}>
            {d.locations.length ? (
              <div data-testid="audit-dashboard">
                <DataTable
                  rows={d.locations}
                  rowKey={(r) => r.locationId}
                  rowLabel={(r) => r.name}
                  columns={[
                    { key: 'loc', header: t('col.location'), render: (r) => <strong>{r.name}</strong> },
                    { key: 'latest', header: t('col.latestScore'), render: (r) => (r.latest ? <Link href={`/audits/${r.latest.auditId}`} className="inline-flex items-center gap-2"><ScoreBadge score={r.latest.scorePct} passed={r.latest.passed} /><span className="text-xs text-stone">{f.shortDate(r.latest.completedAt)}</span></Link> : <span className="text-stone">{t('dashboard.noAudit')}</span>) },
                    { key: 'trend', header: t('col.trend'), render: (r) => <Trend values={r.byMonth} labels={d.months.map(f.month)} /> },
                    { key: 'actions', header: t('col.actions'), render: (r) => <span className="flex flex-wrap gap-1">{r.openActions ? <Badge tone="warning">{t('dashboard.open', { count: r.openActions })}</Badge> : <span className="text-stone">0</span>}{r.overdueActions > 0 && <Badge tone="danger">{t('dashboard.overdue', { count: r.overdueActions })}</Badge>}</span> },
                    { key: 'next', header: t('col.nextDue'), render: (r) => f.date(r.nextDue) },
                  ]}
                />
              </div>
            ) : <Empty icon="pin" title={t('dashboard.noLocations')} />}
          </SectionCard>
          <div className="grid gap-3 lg:grid-cols-2">
            <SectionCard title={t('dashboard.overdueActionsTitle')}>
              {d.overdueActions.length ? (
                <ul className="flex flex-col gap-1.5">
                  {d.overdueActions.slice(0, 12).map((x) => (
                    <li key={x.id}><Link href={`/audits/${x.auditId}#action-${x.id}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
                      <span className="min-w-0 flex-1 font-bold">{x.title}</span><span className="text-stone">{x.locationName}</span>
                      {x.critical && <Badge tone="danger" icon="alert">{t('audit.critical')}</Badge>}
                      <Badge tone="danger">{t('dashboard.dueOn', { date: f.shortDate(x.dueDate) })}</Badge>
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('dashboard.noOverdueActions')}</p>}
            </SectionCard>
            <SectionCard title={t('dashboard.upcomingTitle')}>
              {d.overdueAudits.length + d.upcoming.length ? (
                <ul className="flex flex-col gap-1.5">
                  {[...d.overdueAudits, ...d.upcoming].slice(0, 12).map((a) => (
                    <li key={a.id}><Link href={`/audits/${a.id}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
                      <span className="min-w-0 flex-1"><strong>{a.locationName}</strong> · {a.name}</span>
                      <span className="text-stone">{a.auditor?.name ?? t('audit.noAuditor')}</span>
                      <Badge tone={a.overdue ? 'danger' : 'neutral'}>{f.shortDate(a.dueDate)}</Badge>
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-stone">{t('dashboard.noUpcoming')}</p>}
            </SectionCard>
          </div>
        </>
      )}
    </Async>
  );
}

function AuditList() {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const f = useQFmt();
  const [status, setStatus] = useState<'open' | 'completed' | 'all'>('open');
  const res = useQuality(() => qualityApi.audits({ status }), [app.org.id, status]);
  const [scheduling, setScheduling] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs items={[['open', t('audits.filter.open')], ['completed', t('audits.filter.completed')], ['all', t('audits.filter.all')]]} value={status} onChange={setStatus} />
        <span className="flex-1" />
        {res.data?.can.export && <Button variant="ghost" size="sm" icon="download" onClick={() => void downloadCsv('/audits/export', 'audits.csv')}>{t('common.exportCsv')}</Button>}
        {res.data?.can.schedule && <Button icon="plus" onClick={() => setScheduling(true)}>{t('audits.schedule')}</Button>}
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="check-circle" title={t('audits.empty')} body={t('audits.emptyBody')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5" data-testid="audit-list">
            <DataTable<AuditVM>
              rows={d.items}
              rowKey={(a) => a.id}
              rowLabel={(a) => `${a.locationName} ${a.name}`}
              onRowClick={(a) => router.push(`/audits/${a.id}`)}
              columns={[
                { key: 'loc', header: t('col.location'), render: (a) => <span><strong>{a.locationName}</strong><span className="block text-xs text-stone">{a.name}{a.purpose !== 'routine' ? ` · ${t(`purpose.${a.purpose}`)}` : ''}</span></span> },
                { key: 'due', header: t('col.due'), render: (a) => <span className={a.overdue ? 'font-bold text-danger' : undefined}>{f.date(a.dueDate)}</span> },
                { key: 'auditor', header: t('col.auditor'), render: (a) => a.auditor?.name ?? <span className="text-stone">{t('audit.noAuditor')}</span> },
                { key: 'status', header: t('col.status'), render: (a) => <StatusBadge kind="audit" status={a.status} /> },
                { key: 'score', header: t('col.score'), render: (a) => (a.status === 'completed' ? <ScoreBadge score={a.scorePct} passed={a.passed} critical={a.criticalFailed} /> : '—') },
                { key: 'actions', header: t('col.actions'), render: (a) => (a.openActions ? <span className="flex gap-1"><Badge tone="warning">{a.openActions}</Badge>{a.overdueActions > 0 && <Badge tone="danger">{t('dashboard.overdue', { count: a.overdueActions })}</Badge>}</span> : '—') },
              ]}
            />
          </section>
        )}
      </Async>
      {scheduling && <ScheduleDrawer onClose={() => setScheduling(false)} onDone={(id) => router.push(`/audits/${id}`)} />}
    </>
  );
}

export function ScheduleDrawer({ onClose, onDone, preset }: { onClose: () => void; onDone: (id: string) => void; preset?: { locationId: string; projectId: string; templateId?: string } }) {
  const t = useTranslations('quality');
  const app = useApp();
  const templates = useQuality(() => qualityApi.templates(), [app.org.id]);
  const [v, setV] = useState({ locationId: preset?.locationId ?? '', templateId: preset?.templateId ?? '', dueDate: '', auditorUserId: '' });
  const auditors = useQuality(() => (v.locationId ? qualityApi.auditors(v.locationId) : Promise.resolve({ items: [] })), [app.org.id, v.locationId]);
  const act = useQualityAction();
  return (
    <Drawer open onClose={onClose} title={preset ? t('preOpening.schedule') : t('audits.schedule')} footer={
      <Button icon="calendar" disabled={!v.locationId || !v.templateId || !v.dueDate} loading={act.pending} onClick={async () => {
        const r = await act.run(() => qualityApi.schedule({ locationId: v.locationId, templateId: v.templateId, dueDate: v.dueDate, auditorUserId: v.auditorUserId || null, ...(preset ? { purpose: 'pre_opening', projectId: preset.projectId } : {}) }));
        if (r) onDone(r.id);
      }}>{t('audits.scheduleSave')}</Button>
    }>
      <div className="flex flex-col gap-3">
        <ActionError error={act.error} />
        <Field label={t('col.location')}>{(x) => (
          <Select id={x.id} value={v.locationId} disabled={!!preset} onChange={(e) => setV((s) => ({ ...s, locationId: e.target.value, auditorUserId: '' }))}>
            <option value="">{t('common.choose')}</option>
            {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('col.checklist')}>{(x) => (
          <Select id={x.id} value={v.templateId} onChange={(e) => setV((s) => ({ ...s, templateId: e.target.value }))}>
            <option value="">{t('common.choose')}</option>
            {(templates.data?.items ?? []).map((tp: TemplateVM) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('col.due')}>{(x) => <Input id={x.id} type="date" value={v.dueDate} onChange={(e) => setV((s) => ({ ...s, dueDate: e.target.value }))} />}</Field>
        <Field label={t('col.auditor')} hint={t('audits.auditorHint')} optional>{(x) => (
          <Select id={x.id} value={v.auditorUserId} disabled={!v.locationId} onChange={(e) => setV((s) => ({ ...s, auditorUserId: e.target.value }))}>
            <option value="">{t('audit.noAuditor')}</option>
            {(auditors.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}</Field>
      </div>
    </Drawer>
  );
}

function ActionList() {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const f = useQFmt();
  const [status, setStatus] = useState<'active' | 'overdue' | 'verified' | 'all'>('active');
  const res = useQuality(() => qualityApi.actions(status), [app.org.id, status]);
  return (
    <>
      <PillTabs items={[['active', t('actions.filter.active')], ['overdue', t('actions.filter.overdue')], ['verified', t('actions.filter.verified')], ['all', t('audits.filter.all')]]} value={status} onChange={setStatus} />
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="check-circle" title={t('actions.empty')} />}>
        {(d) => (
          <section className="rounded-xl bg-surface p-3.5" data-testid="action-list">
            <DataTable<ActionVM>
              rows={d.items}
              rowKey={(x) => x.id}
              rowLabel={(x) => x.title}
              onRowClick={(x) => router.push(`/audits/${x.auditId}#action-${x.id}`)}
              columns={[
                { key: 'item', header: t('col.item'), render: (x) => <span><strong>{x.title}</strong><span className="block text-xs text-stone">{x.sectionTitle}</span></span> },
                { key: 'loc', header: t('col.location'), render: (x) => x.locationName },
                { key: 'due', header: t('col.due'), render: (x) => <span className={x.overdue ? 'font-bold text-danger' : undefined}>{f.date(x.dueDate)}</span> },
                { key: 'st', header: t('col.status'), render: (x) => <span className="flex flex-wrap gap-1"><StatusBadge kind="action" status={x.status} />{x.critical && <Badge tone="danger" icon="alert">{t('audit.critical')}</Badge>}{x.overdue && <Badge tone="danger">{t('actions.overdue')}</Badge>}</span> },
              ]}
            />
          </section>
        )}
      </Async>
    </>
  );
}

function Templates() {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const res = useQuality(() => qualityApi.templates(status), [app.org.id, status]);
  const starters = useQuality(() => qualityApi.starters(), [app.org.id]);
  const act = useQualityAction();
  const [picking, setPicking] = useState(false);
  const existing = useMemo(() => new Set((res.data?.items ?? []).map((x) => x.starterKey).filter(Boolean)), [res.data]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs items={[['active', t('templates.active')], ['archived', t('templates.archived')]]} value={status} onChange={setStatus} />
        <span className="flex-1" />
        <Button variant="secondary" icon="layers" onClick={() => setPicking(true)}>{t('templates.fromStarter')}</Button>
        <Button icon="plus" onClick={() => router.push('/audits/templates/new')}>{t('templates.new')}</Button>
      </div>
      <ActionError error={act.error} />
      <Async res={res} loading={<LoadingBlock variant="cards" />} isEmpty={(d) => !d.items.length} empty={<Empty icon="list" title={t('templates.empty')} body={t('templates.emptyBody')} />}>
        {(d) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]" data-testid="templates">
            {d.items.map((tp) => (
              <Link key={tp.id} href={`/audits/templates/${tp.id}`} className="flex flex-col gap-2 rounded-xl bg-surface p-4 hover:outline hover:outline-2 hover:outline-ink">
                <span className="text-[15px] font-bold">{tp.name}</span>
                <span className="line-clamp-2 text-xs text-stone">{tp.description}</span>
                <span className="flex flex-wrap gap-1">
                  <Badge tone="neutral">{t('templates.questions', { count: tp.questionCount })}</Badge>
                  {tp.criticalCount > 0 && <Badge tone="danger" icon="alert">{t('templates.critical', { count: tp.criticalCount })}</Badge>}
                  <Badge tone="info">{t('templates.passMark', { pct: tp.passThreshold })}</Badge>
                  <Badge tone="neutral">{t('templates.version', { n: tp.version })}</Badge>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Async>
      {picking && (
        <Drawer open onClose={() => setPicking(false)} title={t('templates.fromStarter')}>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-stone">{t('templates.starterHint')}</p>
            {(starters.data?.items ?? []).map((s) => (
              <div key={s.key} className="flex flex-col gap-1.5 rounded-lg bg-canvas-raised p-3">
                <span className="flex flex-wrap items-center gap-2 text-[14px] font-bold">{s.name}{s.preOpening && <Badge tone="info" icon="flag">{t('templates.preOpening')}</Badge>}{existing.has(s.key) && <Badge tone="success">{t('templates.added')}</Badge>}</span>
                <span className="text-xs text-stone">{s.description}</span>
                <span className="text-xs text-graphite">{s.sections.join(' · ')}</span>
                <Button size="sm" variant="secondary" className="self-start" icon="plus" loading={act.pending} onClick={async () => {
                  const r = await act.run(() => qualityApi.createTemplate({ starterKey: s.key }));
                  if (r) router.push(`/audits/templates/${r.id}`);
                }}>{t('templates.useStarter')}</Button>
              </div>
            ))}
            {starters.status === 'loading' && <LoadingBlock variant="detail" />}
            {act.error && <Banner tone="danger">{act.error.message}</Banner>}
          </div>
        </Drawer>
      )}
    </>
  );
}
