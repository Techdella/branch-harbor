'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Background, Controls, Handle, Position, ReactFlow, addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import {
  AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS, CONDITION_FIELDS, CONSENT_PURPOSES, FIELD_OPS, validateAutomationGraph,
  type AutomationGraph, type AutomationNode,
} from '@bh/shared';
import { Badge, Button, Field, Icon, Input, Select, Tabs, Textarea } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, ErrorState, LoadingBlock } from '@/components/ui/States';
import { mkt, useAction, useLoad, useMkt, type Automation, type AutomationRun, type EmailTemplate, type FormRow, type Segment } from '../data';

type NodeData = { node: AutomationNode; summary: string; title: string; issue: boolean };
type FlowNode = Node<NodeData>;

const COLORS: Record<AutomationNode['type'], string> = { trigger: '#E2F5A6', condition: '#F7EDA8', delay: '#CDEEEE', action: '#E9DDF8' };
const ICONS = { trigger: 'zap', condition: 'filter', delay: 'clock', action: 'send' } as const;

function Box({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  return (
    <div className={`w-[240px] rounded-lg border-2 bg-white text-ink shadow-sm ${selected ? 'border-ink' : data.issue ? 'border-danger' : 'border-line'}`}>
      {n.type !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wide" style={{ background: COLORS[n.type] }}>
        <Icon name={ICONS[n.type]} size={13} />{data.title}
      </div>
      <div className="px-3 py-2 text-[13px] font-semibold leading-snug">{data.summary}</div>
      {n.type === 'condition' ? (
        <>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '28%' }} />
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: '72%' }} />
          <div className="flex justify-between px-6 pb-1 text-[10px] font-bold text-stone"><span>✓</span><span>✕</span></div>
        </>
      ) : <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}
const nodeTypes = { box: Box };

export function FlowEditor({ id }: { id: string }) {
  const t = useTranslations('mkt');
  const { orgId, locations } = useMkt();
  const res = useLoad(orgId, async (o) => {
    const [a, tpls, forms, segs] = await Promise.all([mkt.automation(o, id), mkt.templates(o).catch(() => ({ items: [] as EmailTemplate[] })), mkt.forms(o).catch(() => ({ items: [] as FormRow[] })), mkt.segments(o).catch(() => ({ items: [] as Segment[] }))]);
    return { a, tpls: tpls.items, forms: forms.items, segs: segs.items };
  }, [id]);
  if (res.status === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data || !orgId) return <LoadingBlock variant="detail" />;
  return <Editor key={res.data.a.version} orgId={orgId} automation={res.data.a} templates={res.data.tpls} forms={res.data.forms} segments={res.data.segs} locations={locations} reload={res.reload} t={t} />;
}

function Editor({ orgId, automation, templates, forms, segments, locations, t }: { orgId: string; automation: Automation; templates: EmailTemplate[]; forms: FormRow[]; segments: Segment[]; locations: Array<{ id: string; name: string }>; reload: () => void; t: ReturnType<typeof useTranslations> }) {
  const fmt = useFormatter();
  const [name, setName] = useState(automation.name);
  const [graph, setGraph] = useState<AutomationGraph>(automation.graph);
  const [version, setVersion] = useState(automation.version);
  const [status, setStatus] = useState(automation.status);
  const [sel, setSel] = useState<string | null>(null);
  // React Flow measures each node after it renders; in controlled mode the measured size must be fed back on the
  // nodes or they stay hidden. Only the position lives in the saved graph, so the sizes are kept here.
  const [measured, setMeasured] = useState<Record<string, { width?: number; height?: number }>>({});
  const [tab, setTab] = useState<'flow' | 'runs'>('flow');
  const [test, setTest] = useState<{ status: string; steps: AutomationRun['steps'] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const a = useAction();
  const issues = useMemo(() => validateAutomationGraph(graph).issues, [graph]);
  const tr = t as unknown as (k: string, v?: Record<string, string | number>) => string;

  const summary = useCallback((n: AutomationNode): string => {
    switch (n.type) {
      case 'trigger': return tr(`auto.trigger.${n.config.event}`) + (n.config.formId ? ` · ${forms.find((f) => f.id === n.config.formId)?.name ?? ''}` : n.config.tag ? ` · ${n.config.tag}` : '');
      case 'delay': return tr('auto.waitFor', { n: n.config.amount, unit: tr(`auto.unit.${n.config.unit}`) });
      case 'condition': {
        const c = n.config;
        if (c.kind === 'consent') return tr('auto.cond.consentIs', { purpose: tr(`auto.purpose.${c.purpose}`) });
        if (c.kind === 'tag') return tr('auto.cond.hasTag', { tag: c.tag });
        if (c.kind === 'location') return tr('auto.cond.atLocations', { n: c.locationIds.length });
        if (c.kind === 'segment') return tr('auto.cond.inSegment', { name: segments.find((s) => s.id === c.segmentId)?.name ?? '' });
        return `${tr(`auto.field.${c.field}`)} ${tr(`auto.op.${c.op}`)} ${c.value}`;
      }
      case 'action': {
        const c = n.config;
        if (c.action === 'send_email') return `${tr('auto.action.send_email')}: ${templates.find((x) => x.id === c.templateId)?.name ?? tr('auto.chooseEmail')}`;
        if (c.action === 'add_tag' || c.action === 'remove_tag') return `${tr(`auto.action.${c.action}`)}: ${c.tag}`;
        if (c.action === 'create_task') return `${tr('auto.action.create_task')}: ${c.title}`;
        return tr(`auto.action.${c.action}`);
      }
    }
  }, [forms, segments, templates, tr]);

  const nodes: FlowNode[] = graph.nodes.map((n) => ({ id: n.id, type: 'box', position: n.position, measured: measured[n.id], selected: n.id === sel, data: { node: n, summary: summary(n), title: tr(`auto.node.${n.type}`), issue: issues.some((i) => i.nodeId === n.id) } }));
  const edges: Edge[] = graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, label: e.sourceHandle ? tr(`auto.branch.${e.sourceHandle}`) : undefined }));

  const onNodesChange = (all: NodeChange<FlowNode>[]) => {
    // The trigger is the start of the flow and cannot be deleted.
    const changes = all.filter((c) => !(c.type === 'remove' && graph.nodes.find((n) => n.id === c.id)?.type === 'trigger'));
    const next = applyNodeChanges(changes, nodes);
    const sc = changes.find((c) => c.type === 'select' && c.selected);
    if (sc && 'id' in sc) setSel(sc.id);
    const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (dims.length) setMeasured((m) => { const out = { ...m }; for (const c of dims) if (c.type === 'dimensions' && c.dimensions) out[c.id] = c.dimensions; return out; });
    if (!changes.some((c) => c.type === 'position' || c.type === 'remove')) return;
    setGraph((g) => ({
      nodes: next.filter((x) => g.nodes.some((n) => n.id === x.id)).map((x) => ({ ...g.nodes.find((n) => n.id === x.id)!, position: x.position })),
      edges: g.edges.filter((e) => next.some((x) => x.id === e.source) && next.some((x) => x.id === e.target)),
    }));
  };
  const onEdgesChange = (changes: EdgeChange[]) => setGraph((g) => ({ ...g, edges: applyEdgeChanges(changes, edges).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: (e.sourceHandle as 'yes' | 'no' | null) ?? null })) }));
  const onConnect = (c: Connection) => setGraph((g) => {
    // One way out per node (per branch for conditions): a new connection replaces the old one.
    const kept = g.edges.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)));
    const added = addEdge({ ...c, id: `e${Date.now().toString(36)}` } as Edge, kept.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined })));
    return { ...g, edges: added.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: (e.sourceHandle as 'yes' | 'no' | null) ?? null })) };
  });

  const addNode = (type: 'condition' | 'delay' | 'action') => {
    const from = graph.nodes.find((n) => n.id === sel) ?? graph.nodes[graph.nodes.length - 1]!;
    const id = `${type[0]}${Date.now().toString(36)}`;
    const config = type === 'delay' ? { amount: 1, unit: 'days' } : type === 'condition' ? { kind: 'consent', purpose: 'marketing_email' } : { action: 'send_email' };
    const node = { id, type, position: { x: from.position.x, y: from.position.y + 140 }, config } as AutomationNode;
    const busy = graph.edges.some((e) => e.source === from.id && (from.type !== 'condition' || e.sourceHandle === 'yes'));
    setGraph((g) => ({ nodes: [...g.nodes, node], edges: busy ? g.edges : [...g.edges, { id: `e${id}`, source: from.id, target: id, sourceHandle: from.type === 'condition' ? 'yes' : null }] }));
    setSel(id);
  };
  const update = (nodeId: string, config: Record<string, unknown>) => setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? ({ ...n, config } as AutomationNode) : n)) }));
  const remove = (nodeId: string) => { setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== nodeId), edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) })); setSel(null); };

  async function save() {
    const r = await a.run(() => mkt.saveAutomation(orgId, automation.id, { name, graph, version }));
    if (r) { setVersion(r.version); setNotice(t('common.saved')); }
    return r;
  }
  async function setState(s: 'active' | 'paused') {
    if (!(await save())) return;
    const r = await a.run(() => mkt.automationStatus(orgId, automation.id, s));
    if (r) { setStatus(r.status); setNotice(t(s === 'active' ? 'auto.activated' : 'auto.paused')); }
  }
  const selected = graph.nodes.find((n) => n.id === sel) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="workflow" title={name} description={t('auto.editorDescription')} actions={<Link href="/marketing/automations" className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-5 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('builder.back')}</Link>} />
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4">
        <Field label={t('auto.name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} className="min-w-[260px]" />}</Field>
        <Badge tone={status === 'active' ? 'success' : status === 'paused' ? 'warning' : 'neutral'}>{t(`auto.status.${status}` as never)}</Badge>
        <div className="ms-auto flex flex-wrap gap-2">
          <Button variant="secondary" icon="check" loading={a.pending} onClick={save}>{t('common.save')}</Button>
          <Button variant="secondary" icon="play" loading={a.pending} disabled={issues.length > 0} onClick={async () => { if (!(await save())) return; const r = await a.run(() => mkt.testRun(orgId, automation.id, locations[0]?.id ?? null)); if (r) setTest(r); }}>{t('auto.testRun')}</Button>
          {status === 'active'
            ? <Button variant="secondary" icon="clock" loading={a.pending} onClick={() => setState('paused')}>{t('auto.pause')}</Button>
            : <Button variant="signal" icon="zap" loading={a.pending} disabled={issues.length > 0} onClick={() => setState('active')}>{status === 'paused' ? t('auto.resume') : t('auto.activate')}</Button>}
        </div>
      </div>
      {notice && <Banner tone="success" live="polite" action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>{t('common.dismiss')}</Button>}>{notice}</Banner>}
      {a.error && <Banner tone="danger" title={a.error.message}>{Array.isArray(a.error.details?.issues) ? (a.error.details!.issues as Array<{ code: string }>).map((i) => tr(`auto.issue.${i.code}`)).join(' · ') : null}</Banner>}
      {issues.length > 0 && <Banner tone="warning">{[...new Set(issues.map((i) => tr(`auto.issue.${i.code}`)))].join(' · ')}</Banner>}
      {test && (
        <Banner tone={test.status === 'completed' ? 'success' : 'warning'} title={t('auto.testResult', { status: tr(`auto.runStatus.${test.status}`) })}>
          <ul className="mt-1 list-disc ps-5">{test.steps.map((s) => <li key={s.nodeId}>{summary(graph.nodes.find((n) => n.id === s.nodeId) ?? graph.nodes[0]!)} · {tr(`auto.stepStatus.${s.status}`)}{typeof s.result.reason === 'string' && s.result.reason ? ` (${tr(`auto.reason.${s.result.reason}`)})` : ''}</li>)}</ul>
        </Banner>
      )}
      <Tabs value={tab} onChange={setTab} items={[{ key: 'flow', label: t('auto.flow') }, { key: 'runs', label: t('auto.runs') }]} />
      {tab === 'flow' ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="h-[640px] overflow-hidden rounded-xl border border-line bg-white" aria-label={t('auto.canvas')}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onPaneClick={() => setSel(null)} fitView deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: false }}>
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <aside className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 rounded-xl bg-surface p-3">
              <Button size="sm" variant="secondary" icon="filter" onClick={() => addNode('condition')}>{t('auto.addCondition')}</Button>
              <Button size="sm" variant="secondary" icon="clock" onClick={() => addNode('delay')}>{t('auto.addDelay')}</Button>
              <Button size="sm" variant="secondary" icon="send" onClick={() => addNode('action')}>{t('auto.addAction')}</Button>
            </div>
            {selected ? (
              <NodeForm node={selected} templates={templates} forms={forms} segments={segments} locations={locations} onChange={(c) => update(selected.id, c)} onRemove={selected.type === 'trigger' ? undefined : () => remove(selected.id)} tr={tr} />
            ) : <p className="rounded-xl bg-surface p-4 text-sm text-stone">{t('auto.selectHint')}</p>}
            <p className="text-xs text-stone">{t('auto.safety')}</p>
          </aside>
        </div>
      ) : <RunsPanel orgId={orgId} id={automation.id} summary={(nodeId) => { const n = graph.nodes.find((x) => x.id === nodeId); return n ? summary(n) : nodeId; }} tr={tr} fmt={fmt} />}
    </div>
  );
}

function NodeForm({ node, templates, forms, segments, locations, onChange, onRemove, tr }: { node: AutomationNode; templates: EmailTemplate[]; forms: FormRow[]; segments: Segment[]; locations: Array<{ id: string; name: string }>; onChange: (c: Record<string, unknown>) => void; onRemove?: () => void; tr: (k: string, v?: Record<string, string | number>) => string }) {
  const c = node.config as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => onChange({ ...c, ...patch });
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface p-4">
      <h3 className="text-sm font-bold">{tr(`auto.node.${node.type}`)}</h3>
      {node.type === 'trigger' && <>
        <Field label={tr('auto.when')}>{(p) => <Select id={p.id} value={String(c.event)} onChange={(e) => onChange({ event: e.target.value })}>{AUTOMATION_TRIGGERS.map((k) => <option key={k} value={k}>{tr(`auto.trigger.${k}`)}</option>)}</Select>}</Field>
        {c.event === 'form.submitted' && <Field label={tr('auto.onlyForm')} optional>{(p) => <Select id={p.id} value={String(c.formId ?? '')} onChange={(e) => set({ formId: e.target.value || undefined })}><option value="">{tr('auto.anyForm')}</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</Select>}</Field>}
        {c.event === 'tag.added' && <Field label={tr('auto.tag')}>{(p) => <Input id={p.id} value={String(c.tag ?? '')} onChange={(e) => set({ tag: e.target.value || undefined })} />}</Field>}
        {(c.event === 'membership.expiring' || c.event === 'location.opening_soon') && <Field label={tr('auto.daysBefore')}>{(p) => <Input id={p.id} type="number" min={0} max={120} value={Number(c.daysBefore ?? 7)} onChange={(e) => set({ daysBefore: Number(e.target.value) })} />}</Field>}
      </>}
      {node.type === 'delay' && (
        <div className="flex gap-2">
          <Field label={tr('auto.amount')}>{(p) => <Input id={p.id} type="number" min={1} max={365} value={Number(c.amount)} onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
          <Field label={tr('auto.unitLabel')}>{(p) => <Select id={p.id} value={String(c.unit)} onChange={(e) => set({ unit: e.target.value })}>{['minutes', 'hours', 'days'].map((u) => <option key={u} value={u}>{tr(`auto.unit.${u}`)}</option>)}</Select>}</Field>
        </div>
      )}
      {node.type === 'condition' && <>
        <Field label={tr('auto.checks')}>{(p) => <Select id={p.id} value={String(c.kind)} onChange={(e) => onChange(e.target.value === 'consent' ? { kind: 'consent', purpose: 'marketing_email' } : e.target.value === 'tag' ? { kind: 'tag', tag: 'vip' } : e.target.value === 'location' ? { kind: 'location', locationIds: locations.slice(0, 1).map((l) => l.id) } : e.target.value === 'segment' ? { kind: 'segment', segmentId: segments[0]?.id ?? '' } : { kind: 'field', field: 'contact.email', op: 'exists', value: '' })}>{['consent', 'tag', 'location', 'segment', 'field'].map((k) => <option key={k} value={k}>{tr(`auto.condKind.${k}`)}</option>)}</Select>}</Field>
        {c.kind === 'consent' && <Field label={tr('auto.purposeLabel')}>{(p) => <Select id={p.id} value={String(c.purpose)} onChange={(e) => set({ purpose: e.target.value })}>{CONSENT_PURPOSES.map((k) => <option key={k} value={k}>{tr(`auto.purpose.${k}`)}</option>)}</Select>}</Field>}
        {c.kind === 'tag' && <Field label={tr('auto.tag')}>{(p) => <Input id={p.id} value={String(c.tag)} onChange={(e) => set({ tag: e.target.value })} />}</Field>}
        {c.kind === 'segment' && <Field label={tr('auto.segment')}>{(p) => <Select id={p.id} value={String(c.segmentId)} onChange={(e) => set({ segmentId: e.target.value })}>{segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>}
        {c.kind === 'location' && <fieldset className="flex flex-col gap-1"><legend className="text-[13px] font-bold">{tr('auto.locations')}</legend>{locations.map((l) => <label key={l.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={(c.locationIds as string[]).includes(l.id)} onChange={() => set({ locationIds: (c.locationIds as string[]).includes(l.id) ? (c.locationIds as string[]).filter((x) => x !== l.id) : [...(c.locationIds as string[]), l.id] })} />{l.name}</label>)}</fieldset>}
        {c.kind === 'field' && <>
          <Field label={tr('auto.fieldLabel')}>{(p) => <Select id={p.id} value={String(c.field)} onChange={(e) => set({ field: e.target.value })}>{CONDITION_FIELDS.map((k) => <option key={k} value={k}>{tr(`auto.field.${k}`)}</option>)}</Select>}</Field>
          <Field label={tr('auto.opLabel')}>{(p) => <Select id={p.id} value={String(c.op)} onChange={(e) => set({ op: e.target.value })}>{FIELD_OPS.map((k) => <option key={k} value={k}>{tr(`auto.op.${k}`)}</option>)}</Select>}</Field>
          {!['exists', 'not_exists'].includes(String(c.op)) && <Field label={tr('auto.value')}>{(p) => <Input id={p.id} value={String(c.value ?? '')} onChange={(e) => set({ value: e.target.value })} />}</Field>}
        </>}
        <p className="text-xs text-stone">{tr('auto.branchHint')}</p>
      </>}
      {node.type === 'action' && <>
        <Field label={tr('auto.do')}>{(p) => <Select id={p.id} value={String(c.action)} onChange={(e) => onChange({ action: e.target.value, ...(e.target.value === 'send_sms' || e.target.value === 'send_whatsapp' ? { body: '' } : e.target.value === 'add_tag' || e.target.value === 'remove_tag' ? { tag: '' } : e.target.value === 'create_task' ? { title: '', dueInDays: 1 } : e.target.value === 'notify_staff' ? { message: '' } : e.target.value === 'webhook' ? { url: 'https://' } : {}) })}>{AUTOMATION_ACTIONS.map((k) => <option key={k} value={k}>{tr(`auto.action.${k}`)}</option>)}</Select>}</Field>
        {c.action === 'send_email' && <Field label={tr('auto.emailTemplate')}>{(p) => <Select id={p.id} value={String(c.templateId ?? '')} onChange={(e) => set({ templateId: e.target.value || undefined })}><option value="">{tr('auto.chooseEmail')}</option>{templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
        {(c.action === 'send_sms' || c.action === 'send_whatsapp') && <Field label={tr('auto.message')} hint={tr('auto.smsHint')}>{(p) => <Textarea id={p.id} value={String(c.body ?? '')} onChange={(e) => set({ body: e.target.value })} maxLength={c.action === 'send_sms' ? 640 : 1000} />}</Field>}
        {(c.action === 'add_tag' || c.action === 'remove_tag') && <Field label={tr('auto.tag')}>{(p) => <Input id={p.id} value={String(c.tag ?? '')} onChange={(e) => set({ tag: e.target.value })} />}</Field>}
        {c.action === 'create_task' && <>
          <Field label={tr('auto.taskTitle')}>{(p) => <Input id={p.id} value={String(c.title ?? '')} onChange={(e) => set({ title: e.target.value })} />}</Field>
          <Field label={tr('auto.dueIn')}>{(p) => <Input id={p.id} type="number" min={0} max={90} value={Number(c.dueInDays ?? 1)} onChange={(e) => set({ dueInDays: Number(e.target.value) })} />}</Field>
        </>}
        {c.action === 'notify_staff' && <Field label={tr('auto.message')}>{(p) => <Textarea id={p.id} value={String(c.message ?? '')} onChange={(e) => set({ message: e.target.value })} />}</Field>}
        {c.action === 'webhook' && <Field label={tr('auto.webhookUrl')} hint={tr('auto.webhookHint')}>{(p) => <Input id={p.id} value={String(c.url ?? '')} onChange={(e) => set({ url: e.target.value })} />}</Field>}
      </>}
      {onRemove && <Button size="sm" variant="ghost" icon="x" onClick={onRemove}>{tr('auto.removeStep')}</Button>}
    </div>
  );
}

function RunsPanel({ orgId, id, summary, tr, fmt }: { orgId: string; id: string; summary: (nodeId: string) => string; tr: (k: string, v?: Record<string, string | number>) => string; fmt: ReturnType<typeof useFormatter> }) {
  const runs = useLoad(orgId, (o) => mkt.runs(o, id), [id]);
  if (runs.status === 'error') return <ErrorState error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <LoadingBlock variant="table" />;
  if (!runs.data.items.length) return <p className="rounded-xl bg-surface p-4 text-sm text-stone">{tr('auto.noRuns')}</p>;
  return (
    <ul className="flex flex-col gap-2" role="list">
      {runs.data.items.map((r) => (
        <li key={r.id} className="rounded-xl bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{r.test ? tr('auto.testContact') : r.customer?.name ?? '—'}</span>
            <Badge tone={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'info'}>{tr(`auto.runStatus.${r.status}`)}</Badge>
            <span className="text-xs text-stone">{fmt.dateTime(new Date(r.startedAt), { dateStyle: 'medium', timeStyle: 'short' })}</span>
            {r.nextRunAt && <span className="text-xs text-stone">{tr('auto.resumesAt', { at: fmt.dateTime(new Date(r.nextRunAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</span>}
          </div>
          <ol className="mt-2 flex flex-col gap-1 text-sm">
            {r.steps.map((s) => <li key={s.nodeId} className="flex items-center gap-2"><Icon name={s.status === 'done' ? 'check-circle' : s.status === 'skipped' ? 'minus' : s.status === 'failed' ? 'alert' : 'clock'} size={14} />{summary(s.nodeId)} · {tr(`auto.stepStatus.${s.status}`)}{typeof s.result.reason === 'string' && s.result.reason ? ` (${tr(`auto.reason.${s.result.reason}`)})` : ''}</li>)}
          </ol>
        </li>
      ))}
    </ul>
  );
}
