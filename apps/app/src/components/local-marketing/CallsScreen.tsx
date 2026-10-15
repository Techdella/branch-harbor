'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Tabs, Toggle, type Tone } from '@bh/ui';
import { DEFAULT_RECORDING_DISCLOSURE, formatE164, type Locale } from '@bh/shared';
import { fmtDateTime } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { NotAvailable } from '../screens/NotAvailable';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { callsApi, settingsApi, type CallVM, type NumberVM, type ReportGroup } from './api';
import { Kpi, KpiRow } from './ui';

type Tab = 'log' | 'numbers' | 'report' | 'recording';
const M = 'marketing.call_tracking';
const STATUS_TONE: Record<string, Tone> = { answered: 'success', missed: 'danger', busy: 'warning', voicemail: 'warning', failed: 'danger', ringing: 'info' };
const SOURCES = ['website', 'google_ads', 'meta_ads', 'google_business', 'print', 'radio', 'tv', 'outdoor', 'directory', 'email', 'other'] as const;

/**
 * Marketing → Call tracking: tracking numbers per campaign or location that forward to the location (Twilio; sandbox
 * until credentials), the call log with source and campaign attribution, missed-call alerts that become leads, call
 * reports, recording rules per jurisdiction (off by default) and dynamic number insertion on hosted sites.
 */
export function CallsScreen() {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'log';
  if (!app.hasModule(M)) return <NotAvailable />;
  const tabs: Array<{ key: Tab; label: string }> = [{ key: 'log', label: t('tab.log') }, { key: 'numbers', label: t('tab.numbers') }, { key: 'report', label: t('tab.report') }, { key: 'recording', label: t('tab.recording') }];
  return (
    <>
      <PageHeader icon="phone" title={t('title')} description={t('description')} />
      <Tabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'log' && <CallLog />}
      {tab === 'numbers' && <Numbers />}
      {tab === 'report' && <Report />}
      {tab === 'recording' && <Recording />}
    </>
  );
}

const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function CallLog() {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const locale = useLocale();
  const [status, setStatus] = useState('');
  const res = useApi(() => callsApi.calls({ status: status || undefined }), [app.org.id, status]);
  const report = useApi(() => callsApi.report(), [app.org.id]);
  const follow = useMutation((_a, id: string) => callsApi.updateCall(id, { followedUp: true }));
  const locName = (id: string) => app.locations.find((l) => l.id === id)?.name ?? '—';
  const fmt = useFormatter();
  return (
    <>
      {report.data && (
        <KpiRow>
          <Kpi label={t('kpi.calls')} value={report.data.totals.calls} sub={t('kpi.last30')} testId="kpi-calls" />
          <Kpi label={t('kpi.answerRate')} value={report.data.totals.answerRate === null ? '—' : fmt.number(report.data.totals.answerRate, { style: 'percent', maximumFractionDigits: 0 })} sub={t('kpi.answered', { n: report.data.totals.answered })} />
          <Kpi label={t('kpi.missed')} value={report.data.totals.missed} sub={t('kpi.leads', { n: report.data.totals.leads })} />
          <Kpi label={t('kpi.firstTime')} value={report.data.totals.firstTimeCallers} sub={report.data.totals.avgDurationSeconds ? t('kpi.avgDuration', { d: duration(report.data.totals.avgDurationSeconds) }) : undefined} />
        </KpiRow>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('filter.status')}>{(f) => (
          <Select id={f.id} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('filter.all')}</option>
            <option value="answered">{t('status.answered')}</option>
            <option value="unanswered">{t('filter.unanswered')}</option>
          </Select>
        )}</Field>
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (
          <SectionCard>
            <DataTable<CallVM>
              rows={d.items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.callerName ?? r.callerNumber}
              empty={<Empty icon="phone" title={t('noCalls')} body={t('noCallsBody')} />}
              columns={[
                { key: 'w', header: t('col.when'), render: (r) => fmtDateTime(r.startedAt, app.locations.find((l) => l.id === r.locationId)?.timeZone ?? 'UTC', locale) },
                { key: 'c', header: t('col.caller'), render: (r) => <span><strong>{r.callerName ?? formatE164(r.callerNumber)}</strong>{r.callerName && <span className="block text-xs text-stone">{formatE164(r.callerNumber)}</span>}{r.firstTimeCaller && <Badge tone="info">{t('firstTime')}</Badge>}</span> },
                { key: 'l', header: t('col.location'), render: (r) => locName(r.locationId) },
                { key: 's', header: t('col.source'), render: (r) => t(`source.${r.source}`) },
                { key: 'st', header: t('col.status'), render: (r) => <span className="flex flex-wrap gap-1"><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{t(`status.${r.status}`)}</Badge>{r.recorded && <Badge icon="mic">{t('recorded')}</Badge>}{r.sandbox && <Badge>{t('sandbox')}</Badge>}</span> },
                { key: 'd', header: t('col.duration'), align: 'right', render: (r) => <span className="tabular">{r.status === 'answered' ? duration(r.durationSeconds) : '—'}</span> },
                { key: 'f', header: t('col.followUp'), render: (r) => (r.leadId ? <Badge tone="signal" icon="trending">{t('leadCreated')}</Badge> : r.status !== 'answered' && !r.followedUpAt ? <Button size="sm" variant="ghost" onClick={async () => { if (await follow.run(r.id)) res.reload(); }}>{t('markFollowedUp')}</Button> : r.followedUpAt ? <Badge tone="success" icon="check">{t('followedUp')}</Badge> : null) },
              ]}
            />
          </SectionCard>
        )}
      </Async>
    </>
  );
}

function Numbers() {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const res = useApi(() => callsApi.numbers(), [app.org.id]);
  const [adding, setAdding] = useState(false);
  const [sim, setSim] = useState<NumberVM | null>(null);
  const release = useMutation((_a, id: string) => callsApi.release(id));
  const locName = (id: string) => app.locations.find((l) => l.id === id)?.name ?? '—';
  const snippet = (d: { dni: { scriptUrl: string; brand: string | null; locations: Array<{ slug: string; phone: string | null }> } }) => {
    const site = d.dni.locations[0];
    return `<a href="tel:${site?.phone ?? ''}"><span data-bh-phone>${site?.phone ?? ''}</span></a>\n<script async src="${d.dni.scriptUrl}" data-brand="${d.dni.brand ?? ''}" data-location="${site?.slug ?? ''}"></script>`;
  };
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          {!d.live && <Banner tone="info" title={t('sandboxBanner.title')}>{t('sandboxBanner.body')}</Banner>}
          <SectionCard title={t('numbers')} aside={d.canManage ? <Button size="sm" icon="plus" onClick={() => setAdding(true)}>{t('addNumber')}</Button> : undefined}>
            <DataTable<NumberVM>
              rows={d.items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.label}
              empty={<Empty icon="phone" title={t('noNumbers')} />}
              columns={[
                { key: 'n', header: t('col.number'), render: (r) => <span><strong className="tabular">{formatE164(r.number)}</strong><span className="block text-xs text-stone">{r.label}</span></span> },
                { key: 'l', header: t('col.location'), render: (r) => locName(r.locationId) },
                { key: 's', header: t('col.source'), render: (r) => t(`source.${r.source}`) },
                { key: 'f', header: t('col.forwardsTo'), render: (r) => <span className="tabular">{formatE164(r.forwardTo)}</span> },
                { key: 'x', header: t('col.flags'), render: (r) => <span className="flex flex-wrap gap-1">{r.isDefault && <Badge tone="info">{t('websiteDefault')}</Badge>}{r.dniMatch.utmSource && <Badge>{t('dniRule', { source: r.dniMatch.utmSource })}</Badge>}{r.recordCalls && <Badge icon="mic">{t('recording')}</Badge>}<Badge>{r.mode === 'live' ? t('live') : t('sandbox')}</Badge></span> },
                { key: 'a', header: '', render: (r) => <span className="flex gap-1">{r.mode === 'sandbox' && <Button size="sm" variant="ghost" icon="phone" onClick={() => setSim(r)}>{t('simulate')}</Button>}{d.canManage && <Button size="sm" variant="ghost" icon="x" onClick={async () => { if (await release.run(r.id)) res.reload(); }}>{t('release')}</Button>}</span> },
              ]}
            />
          </SectionCard>
          <SectionCard title={t('dni.title')}>
            <p className="text-sm text-stone">{t('dni.body')}</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-canvas p-3 text-xs"><code>{snippet(d)}</code></pre>
          </SectionCard>
          <AddNumberDrawer open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); res.reload(); }} />
          <SimulateDrawer n={sim} onClose={() => setSim(null)} />
        </>
      )}
    </Async>
  );
}

function AddNumberDrawer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const campaigns = useApi(() => callsApi.campaigns(), [app.org.id], open);
  const [locationId, setLocationId] = useState('');
  const [label, setLabel] = useState('');
  const [source, setSource] = useState<string>('website');
  const [campaignId, setCampaignId] = useState('');
  const [utm, setUtm] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [record, setRecord] = useState(false);
  const loc = locationId || app.locations[0]?.id || '';
  const add = useMutation(() => callsApi.addNumber({ locationId: loc, label, source, campaignId: campaignId || null, recordCalls: record, dniMatch: utm ? { utmSource: utm } : {}, isDefault }));
  return (
    <Drawer open={open} onClose={onClose} title={t('addNumber')} kicker={t('title')} footer={<Button icon="plus" loading={add.pending} disabled={!loc || label.trim().length < 2} onClick={async () => { if (await add.run()) onDone(); }}>{t('addNumber')}</Button>}>
      <div className="flex flex-col gap-3">
        <Field label={t('col.location')}>{(f) => <Select id={f.id} value={loc} onChange={(e) => setLocationId(e.target.value)}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('label')}>{(f) => <Input id={f.id} value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>
        <Field label={t('col.source')}>{(f) => <Select id={f.id} value={source} onChange={(e) => setSource(e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{t(`source.${s}`)}</option>)}</Select>}</Field>
        <Field label={t('campaign')} optional>{(f) => <Select id={f.id} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}><option value="">{t('noCampaign')}</option>{(campaigns.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label={t('utmSource')} hint={t('utmHint')} optional>{(f) => <Input id={f.id} value={utm} onChange={(e) => setUtm(e.target.value)} />}</Field>
        <Toggle checked={isDefault} onChange={setIsDefault} label={t('makeDefault')} />
        <Toggle checked={record} onChange={setRecord} label={t('recordCalls')} />
        {record && <Banner tone="warning">{t('recordWarning')}</Banner>}
        {add.error && <Banner tone="danger" live="assertive">{add.error.message}</Banner>}
      </div>
    </Drawer>
  );
}

function SimulateDrawer({ n, onClose }: { n: NumberVM | null; onClose: () => void }) {
  const t = useTranslations('lmk.calls');
  const [from, setFrom] = useState('+1 647 555 0123');
  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState<'answered' | 'missed' | 'busy'>('answered');
  const sim = useMutation(() => callsApi.simulate(n!.id, { from, callerName: name || null, outcome, durationSeconds: 95 }));
  const [done, setDone] = useState<CallVM | null>(null);
  return (
    <Drawer open={!!n} onClose={() => { setDone(null); onClose(); }} title={t('simulateTitle')} kicker={n ? formatE164(n.number) : ''} footer={<Button icon="phone" loading={sim.pending} onClick={async () => { const r = await sim.run(); if (r) setDone(r.call); }}>{t('simulate')}</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-stone">{t('simulateBody')}</p>
        <Field label={t('from')}>{(f) => <Input id={f.id} value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={t('callerName')} optional>{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('outcome')}>{(f) => <Select id={f.id} value={outcome} onChange={(e) => setOutcome(e.target.value as 'answered' | 'missed' | 'busy')}>{(['answered', 'missed', 'busy'] as const).map((o) => <option key={o} value={o}>{t(`status.${o}`)}</option>)}</Select>}</Field>
        {sim.error && <Banner tone="danger" live="assertive">{sim.error.message}</Banner>}
        {done && <Banner tone="success" live="polite" title={t(`status.${done.status}`)}>{done.leadId ? t('leadCreated') : t('logged')}</Banner>}
      </div>
    </Drawer>
  );
}

function Report() {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const res = useApi(() => callsApi.report(), [app.org.id]);
  const camps = useApi(() => callsApi.campaigns(), [app.org.id]);
  const name = (g: ReportGroup, kind: 'source' | 'campaign' | 'location') => (kind === 'source' ? t(`source.${g.key ?? 'other'}`) : kind === 'location' ? app.locations.find((l) => l.id === g.key)?.name ?? '—' : g.key ? camps.data?.items.find((c) => c.id === g.key)?.name ?? '—' : t('noCampaign'));
  const table = (rows: ReportGroup[], kind: 'source' | 'campaign' | 'location') => (
    <DataTable<ReportGroup> rows={rows} rowKey={(r) => r.key ?? 'none'} empty={<Empty icon="chart" title={t('noCalls')} />}
      columns={[
        { key: 'n', header: t(`by.${kind}`), render: (r) => <strong>{name(r, kind)}</strong> },
        { key: 'c', header: t('col.calls'), align: 'right', render: (r) => <span className="tabular">{r.calls}</span> },
        { key: 'a', header: t('status.answered'), align: 'right', render: (r) => <span className="tabular">{r.answered}</span> },
        { key: 'm', header: t('status.missed'), align: 'right', render: (r) => <span className="tabular">{r.missed}</span> },
        { key: 'l', header: t('col.leads'), align: 'right', render: (r) => <span className="tabular">{r.leads}</span> },
      ]} />
  );
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title={t('by.source')}>{table(d.bySource, 'source')}</SectionCard>
          <SectionCard title={t('by.campaign')}>{table(d.byCampaign, 'campaign')}</SectionCard>
          <SectionCard title={t('by.location')} className="lg:col-span-2">{table(d.byLocation, 'location')}</SectionCard>
        </div>
      )}
    </Async>
  );
}

function Recording() {
  const t = useTranslations('lmk.calls');
  const app = useApp();
  const locale = useLocale() as Locale;
  const res = useApi(() => callsApi.recording(), [app.org.id]);
  const st = useApi(() => settingsApi.get(), [app.org.id]);
  const [jur, setJur] = useState('');
  const [msg, setMsg] = useState(DEFAULT_RECORDING_DISCLOSURE[locale] ?? DEFAULT_RECORDING_DISCLOSURE.en);
  const save = useMutation((_a, b: { enabled: boolean; jurisdictions: Record<string, { message: string }> }) => settingsApi.save({ callRecording: b }));
  const canEdit = !!st.data?.canEdit.calls;
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          <Banner tone="warning" title={t('rec.warningTitle')}>{t('rec.warning', { states: d.allPartyConsentUsStates.join(', ') })}</Banner>
          <SectionCard title={t('rec.title')}>
            <Toggle checked={d.enabled} onChange={async (v) => { if (canEdit && (await save.run({ enabled: v, jurisdictions: d.jurisdictions }))) res.reload(); }} label={t('rec.enabled')} />
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {Object.entries(d.jurisdictions).map(([k, v]) => (
                <li key={k} className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft p-2"><Badge>{k}</Badge><span className="flex-1">{v.message}</span>
                  {canEdit && <Button size="sm" variant="ghost" icon="x" aria-label={t('rec.remove')} onClick={async () => { const j = { ...d.jurisdictions }; delete j[k]; if (await save.run({ enabled: d.enabled, jurisdictions: j })) res.reload(); }} />}
                </li>
              ))}
            </ul>
            {canEdit && (
              <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr_auto] sm:items-end">
                <Field label={t('rec.jurisdiction')} hint={t('rec.jurisdictionHint')}>{(f) => <Input id={f.id} value={jur} onChange={(e) => setJur(e.target.value.toUpperCase())} />}</Field>
                <Field label={t('rec.message')}>{(f) => <Input id={f.id} value={msg} onChange={(e) => setMsg(e.target.value)} />}</Field>
                <Button icon="plus" loading={save.pending} disabled={!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jur) || msg.trim().length < 10} onClick={async () => { if (await save.run({ enabled: d.enabled, jurisdictions: { ...d.jurisdictions, [jur]: { message: msg.trim() } } })) { setJur(''); res.reload(); } }}>{t('rec.add')}</Button>
              </div>
            )}
            {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
          </SectionCard>
          <SectionCard title={t('rec.locations')}>
            <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
              {d.locations.map((l) => <li key={l.id} className="flex items-center gap-2"><Badge tone={l.allowed ? 'success' : 'neutral'}>{l.jurisdiction}</Badge>{l.name} · {l.allowed ? t('rec.allowed') : t('rec.off')}</li>)}
            </ul>
          </SectionCard>
        </>
      )}
    </Async>
  );
}
