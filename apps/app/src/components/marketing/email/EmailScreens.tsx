'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { EMAIL_STARTERS, starterDocument, type EmailStarter } from '@bh/shared';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Toggle } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, Empty, ErrorState, LoadingBlock } from '@/components/ui/States';
import { mkt, useAction, useLoad, useMkt, type Campaign, type MarketingSettingsResponse } from '../data';
import { EmailEditor, type EmailDraft } from './EmailEditor';

type Tab = 'campaigns' | 'templates' | 'settings';

export function EmailHub() {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'campaigns';
  const { orgId, can } = useMkt();
  const templates = useLoad(tab === 'templates' ? orgId : null, (o) => mkt.templates(o), [tab]);
  const campaigns = useLoad(tab === 'campaigns' ? orgId : null, (o) => mkt.campaigns(o), [tab]);
  const settings = useLoad(tab === 'settings' ? orgId : null, (o) => mkt.settings(o), [tab]);
  const [newTpl, setNewTpl] = useState(false);
  const [newCampaign, setNewCampaign] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="mail" title={t('email.title')} description={t('email.description')} />
      <Tabs value={tab} onChange={(k) => router.replace(`/marketing/email?tab=${k}`)} items={[{ key: 'campaigns', label: t('email.tabCampaigns') }, { key: 'templates', label: t('email.tabTemplates') }, { key: 'settings', label: t('email.tabSettings') }]} />
      {tab === 'campaigns' && (
        <div className="flex flex-col gap-3">
          <div><Button icon="plus" onClick={() => setNewCampaign(true)}>{t('email.newCampaign')}</Button></div>
          {campaigns.status === 'error' && <ErrorState error={campaigns.error} onRetry={campaigns.reload} />}
          {!campaigns.data && campaigns.status === 'loading' && <LoadingBlock variant="table" />}
          {campaigns.data && (campaigns.data.items.length === 0 ? <Empty icon="mail" title={t('email.noCampaigns')} body={t('email.noCampaignsBody')} /> : (
            <ul className="divide-y divide-line-soft rounded-xl bg-surface" role="list">
              {campaigns.data.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1"><div className="font-bold">{c.name}</div><div className="text-xs text-stone">{c.subject || '—'} · {fmt.dateTime(new Date(c.createdAt), { dateStyle: 'medium' })}</div></div>
                  {c.stats.total > 0 && <span className="text-xs text-stone">{t('email.statsLine', { sent: c.stats.sent + c.stats.sandbox, skipped: c.stats.skipped })}</span>}
                  <Badge tone={c.status === 'completed' ? 'success' : c.status === 'draft' ? 'neutral' : 'info'}>{t(`email.status.${c.status}` as never)}</Badge>
                  <Link href={`/marketing/email/campaigns/${c.id}`} className="inline-flex min-h-9 items-center rounded-full bg-ink px-4 text-[13px] font-bold text-white">{t('common.open')}</Link>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
      {tab === 'templates' && (
        <div className="flex flex-col gap-3">
          <div><Button icon="plus" onClick={() => setNewTpl(true)}>{t('email.newTemplate')}</Button></div>
          {templates.status === 'error' && <ErrorState error={templates.error} onRetry={templates.reload} />}
          {templates.data && (templates.data.items.length === 0 ? <Empty icon="file" title={t('email.noTemplates')} body={t('email.noTemplatesBody')} /> : (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" role="list">
              {templates.data.items.map((x) => (
                <li key={x.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
                  <div className="flex items-start justify-between gap-2"><div className="font-bold">{x.name}</div>{x.locationId ? <Badge tone="neutral">{t('email.local')}</Badge> : <Badge tone="info">{t('email.hq')}</Badge>}</div>
                  <div className="text-sm text-stone">{x.subject || '—'}</div>
                  <div className="mt-auto"><Link href={`/marketing/email/templates/${x.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white"><Icon name="edit" size={14} />{t('websites.edit')}</Link></div>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
      {tab === 'settings' && orgId && (settings.data ? <SettingsForm orgId={orgId} data={settings.data} canEdit={can('email.send')} /> : settings.status === 'error' ? <ErrorState error={settings.error} onRetry={settings.reload} /> : <LoadingBlock variant="detail" />)}
      {newTpl && orgId && <NewTemplateDrawer orgId={orgId} onClose={() => setNewTpl(false)} onCreated={(id) => router.push(`/marketing/email/templates/${id}`)} />}
      {newCampaign && orgId && <NewCampaignDrawer orgId={orgId} onClose={() => setNewCampaign(false)} onCreated={(id) => router.push(`/marketing/email/campaigns/${id}`)} />}
    </div>
  );
}

function SettingsForm({ orgId, data, canEdit }: { orgId: string; data: MarketingSettingsResponse; canEdit: boolean }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [s, setS] = useState(data.settings);
  const [ok, setOk] = useState(false);
  return (
    <div className="grid gap-4 rounded-xl bg-surface p-5 lg:max-w-2xl">
      {data.emailMode === 'log' && <Banner tone="info" title={t('email.sandboxTitle')}>{t('email.sandboxBody')}</Banner>}
      <Field label={t('email.postalAddress')} hint={t('email.postalAddressHint')}>{(p) => <Input id={p.id} value={s.postalAddress} onChange={(e) => setS({ ...s, postalAddress: e.target.value })} maxLength={300} />}</Field>
      <Field label={t('email.fromName')} optional>{(p) => <Input id={p.id} value={s.fromName} onChange={(e) => setS({ ...s, fromName: e.target.value })} maxLength={80} />}</Field>
      <div className="grid gap-2 rounded-lg border border-line p-4">
        <h3 className="text-sm font-bold">{t('email.tracking')}</h3>
        <p className="text-xs text-stone">{t('email.trackingHint')}</p>
        <Toggle checked={s.tracking.opens} onChange={(v) => setS({ ...s, tracking: { ...s.tracking, opens: v } })} label={t('email.trackOpens')} />
        <Toggle checked={s.tracking.clicks} onChange={(v) => setS({ ...s, tracking: { ...s.tracking, clicks: v } })} label={t('email.trackClicks')} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={t('email.quietStart')}>{(p) => <Input id={p.id} type="time" value={s.quietHours.start} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, start: e.target.value } })} />}</Field>
        <Field label={t('email.quietEnd')}>{(p) => <Input id={p.id} type="time" value={s.quietHours.end} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, end: e.target.value } })} />}</Field>
      </div>
      <p className="-mt-2 text-xs text-stone">{t('email.quietHint')}</p>
      {a.error && <Banner tone="danger">{a.error.message}</Banner>}
      {ok && <Banner tone="success" live="polite">{t('common.saved')}</Banner>}
      {canEdit ? <div><Button loading={a.pending} onClick={async () => { setOk(false); if (await a.run(() => mkt.saveSettings(orgId, s))) setOk(true); }}>{t('common.save')}</Button></div> : <p className="text-xs text-stone">{t('email.settingsReadOnly')}</p>}
    </div>
  );
}

function starterCopy(t: (k: string) => string) {
  return { heading: t('email.starterHeading'), body: t('email.starterBody'), button: t('email.starterButton') };
}

function NewTemplateDrawer({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EmailStarter>('announcement');
  return (
    <Drawer open onClose={onClose} title={t('email.newTemplate')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={async () => { const r = await a.run(() => mkt.createTemplate(orgId, { name: name.trim(), subject: '', document: starterDocument(kind, starterCopy((k) => t(k as never))) })); if (r) onCreated(r.id); }}>{t('websites.create')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('email.templateName')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="mb-1 text-[13px] font-bold">{t('email.startFrom')}</legend>
          {EMAIL_STARTERS.map((k) => <label key={k} className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-[:checked]:border-ink"><input type="radio" name="starter" checked={kind === k} onChange={() => setKind(k)} />{t(`email.starter.${k}` as never)}</label>)}
        </fieldset>
      </div>
    </Drawer>
  );
}

export function TemplateScreen({ id }: { id: string }) {
  const t = useTranslations('mkt');
  const { orgId } = useMkt();
  const res = useLoad(orgId, (o) => mkt.template(o, id), [id]);
  const [draft, setDraft] = useState<(EmailDraft & { name: string }) | null>(null);
  const a = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (res.data) setDraft({ name: res.data.name, subject: res.data.subject, preheader: res.data.preheader, document: res.data.document }); }, [res.data]);
  if (res.status === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!draft || !orgId) return <LoadingBlock variant="detail" />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="mail" title={draft.name} description={t('email.templateDescription')} actions={<>
        <Link href="/marketing/email?tab=templates" className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-5 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('builder.back')}</Link>
        <Button loading={a.pending} icon="check" onClick={async () => { setSaved(false); if (await a.run(() => mkt.saveTemplate(orgId, id, { ...draft, category: res.data!.category }))) setSaved(true); }}>{t('common.save')}</Button>
      </>} />
      {a.error && <Banner tone="danger">{a.error.message}</Banner>}
      {saved && <Banner tone="success" live="polite">{t('common.saved')}</Banner>}
      <div className="rounded-xl bg-surface p-4"><Field label={t('email.templateName')}>{(p) => <Input id={p.id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field></div>
      <EmailEditor orgId={orgId} value={draft} onChange={(v) => setDraft({ ...draft, ...v })} locationId={res.data?.locationId ?? null} />
    </div>
  );
}

function NewCampaignDrawer({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('mkt');
  const { locations, can } = useMkt();
  const a = useAction();
  const tpls = useLoad(orgId, (o) => mkt.templates(o));
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(can('email.draft') ? 'org' : locations[0]?.id ?? 'org');
  const [tplId, setTplId] = useState('');
  async function create() {
    const tpl = tpls.data?.items.find((x) => x.id === tplId);
    const r = await a.run(() => mkt.createCampaign(orgId, { name: name.trim(), scope: scope === 'org' ? { kind: 'organization', id: orgId } : { kind: 'location', id: scope }, subject: tpl?.subject ?? '', preheader: tpl?.preheader ?? '', document: tpl?.document ?? starterDocument('announcement', starterCopy((k) => t(k as never))), segmentId: null }));
    if (r) onCreated(r.id);
  }
  return (
    <Drawer open onClose={onClose} title={t('email.newCampaign')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={create}>{t('websites.create')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('email.campaignName')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
        <Field label={t('email.sendFor')}>{(p) => <Select id={p.id} value={scope} onChange={(e) => setScope(e.target.value)}><option value="org">{t('email.wholeNetwork')}</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('email.startFromTemplate')} optional>{(p) => <Select id={p.id} value={tplId} onChange={(e) => setTplId(e.target.value)}><option value="">{t('email.starter.announcement')}</option>{tpls.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
      </div>
    </Drawer>
  );
}

export function CampaignScreen({ id }: { id: string }) {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const { orgId, locations } = useMkt();
  const res = useLoad(orgId, async (o) => {
    const [c, segs, tags] = await Promise.all([mkt.campaign(o, id), mkt.segments(o), mkt.tags(o).catch(() => ({ items: [] as Array<{ tag: string; n: number }> }))]);
    return { c, segs: segs.items, tags: tags.items };
  }, [id]);
  const [draft, setDraft] = useState<(EmailDraft & { name: string; segmentId: string | null }) | null>(null);
  const [segOpen, setSegOpen] = useState(false);
  const [at, setAt] = useState('');
  const a = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const recipients = useLoad(res.data && res.data.c.status !== 'draft' ? orgId : null, (o) => mkt.recipients(o, id), [res.data?.c.status]);
  // Seed the editor once; later reloads (new audience, send status) must not overwrite what is being edited.
  useEffect(() => { const c = res.data?.c; if (c?.content) setDraft((d) => d ?? { name: c.name, subject: c.content!.subject, preheader: c.content!.preheader, document: c.content!.document, segmentId: c.segmentId }); }, [res.data]);
  const scopeName = useMemo(() => (res.data ? (res.data.c.scope.kind === 'organization' ? t('email.wholeNetwork') : locations.find((l) => l.id === res.data!.c.scope.id)?.name ?? '') : ''), [res.data, locations, t]);
  if (res.status === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data || !draft || !orgId) return <LoadingBlock variant="detail" />;
  const c: Campaign = res.data.c;
  const editable = c.status === 'draft';
  const save = () => a.run(() => mkt.saveCampaign(orgId, id, { name: draft.name, subject: draft.subject, preheader: draft.preheader, document: draft.document, segmentId: draft.segmentId }));
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="mail" title={draft.name} description={`${scopeName} · ${t(`email.status.${c.status}` as never)}`} actions={<Link href="/marketing/email" className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-5 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('builder.back')}</Link>} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {a.error && <Banner tone="danger">{a.error.message}</Banner>}
      {!editable && (
        <div className="grid gap-3 sm:grid-cols-4">
          {(['total', 'sent', 'skipped', 'unsubscribed'] as const).map((k) => <div key={k} className="rounded-xl bg-surface p-4"><div className="text-xs font-bold uppercase text-stone">{t(`email.stat.${k}` as never)}</div><div className="text-2xl font-bold">{k === 'sent' ? c.stats.sent + c.stats.sandbox : c.stats[k]}</div></div>)}
        </div>
      )}
      <div className="grid gap-3 rounded-xl bg-surface p-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label={t('email.campaignName')}>{(p) => <Input id={p.id} value={draft.name} readOnly={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
        <Field label={t('email.audience')}>{(p) => <Select id={p.id} value={draft.segmentId ?? ''} disabled={!editable} onChange={(e) => setDraft({ ...draft, segmentId: e.target.value || null })}><option value="">{t('email.chooseAudience')}</option>{res.data!.segs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        {editable && <Button variant="secondary" icon="users" onClick={() => setSegOpen(true)}>{t('email.newSegment')}</Button>}
      </div>
      <EmailEditor orgId={orgId} value={draft} onChange={(v) => setDraft({ ...draft, ...v })} readOnly={!editable} locationId={c.scope.kind === 'location' ? c.scope.id : null} />
      {editable && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-surface p-4">
          <Button variant="secondary" icon="check" loading={a.pending} onClick={async () => { if (await save()) setMsg(t('common.saved')); }}>{t('common.save')}</Button>
          <Button variant="signal" icon="send" loading={a.pending} disabled={!draft.segmentId || !draft.subject.trim()} onClick={async () => { if (!(await save())) return; const r = await a.run(() => mkt.sendCampaign(orgId, id, null)); if (r) { setMsg(t('email.sending', { n: r.recipientCount ?? 0 })); res.reload(); } }}>{t('email.sendNow')}</Button>
          <Field label={t('publish.when')}>{(p) => <Input id={p.id} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
          <Button variant="secondary" icon="clock" disabled={!at || !draft.segmentId} loading={a.pending} onClick={async () => { if (!(await save())) return; const r = await a.run(() => mkt.sendCampaign(orgId, id, new Date(at).toISOString())); if (r) { setMsg(t('email.scheduled', { at: fmt.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'short' }) })); res.reload(); } }}>{t('publish.schedule')}</Button>
          <p className="w-full text-xs text-stone">{t('email.consentNote')}</p>
        </div>
      )}
      {!editable && recipients.data && (
        <section className="rounded-xl bg-surface p-4">
          <h2 className="mb-2 text-sm font-bold">{t('email.recipients')}</h2>
          <table className="w-full text-sm"><tbody>
            {recipients.data.items.map((r) => <tr key={r.id} className="border-t border-line-soft"><td className="py-2">{r.email}</td><td className="py-2 text-end"><Badge tone={r.status === 'sent' || r.status === 'sandbox' ? 'success' : r.status === 'skipped' ? 'warning' : 'danger'}>{t(`email.sendStatus.${r.status}` as never)}{r.skipReason ? ` · ${t(`email.skip.${r.skipReason}` as never)}` : ''}</Badge></td></tr>)}
          </tbody></table>
        </section>
      )}
      {segOpen && <SegmentDrawer orgId={orgId} scope={c.scope} tags={res.data.tags.map((x) => x.tag)} onClose={() => setSegOpen(false)} onCreated={(sid) => { setSegOpen(false); setDraft({ ...draft, segmentId: sid }); res.reload(); }} />}
    </div>
  );
}

function SegmentDrawer({ orgId, scope, tags, onClose, onCreated }: { orgId: string; scope: { kind: string; id: string }; tags: string[]; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('mkt');
  const { locations } = useMkt();
  const a = useAction();
  const [name, setName] = useState('');
  const [rules, setRules] = useState({ tags: [] as string[], locationIds: [] as string[], createdWithinDays: null as number | null });
  const [count, setCount] = useState<{ matching: number; emailable: number } | null>(null);
  useEffect(() => { const h = setTimeout(() => { mkt.previewSegment(orgId, { scope, rules }).then(setCount, () => setCount(null)); }, 300); return () => clearTimeout(h); }, [orgId, scope, rules]);
  const toggle = (k: 'tags' | 'locationIds', v: string) => setRules((r) => ({ ...r, [k]: r[k].includes(v) ? r[k].filter((x) => x !== v) : [...r[k], v] }));
  return (
    <Drawer open onClose={onClose} title={t('email.newSegment')} footer={<div className="flex items-center justify-between gap-2"><span className="text-sm">{count ? t('email.segmentCount', count) : ''}</span><div className="flex gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={async () => { const r = await a.run(() => mkt.createSegment(orgId, { name: name.trim(), scope, rules })); if (r) onCreated(r.id); }}>{t('websites.create')}</Button></div></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('email.segmentName')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <fieldset><legend className="mb-1 text-[13px] font-bold">{t('email.withTags')}</legend>{tags.length === 0 ? <p className="text-xs text-stone">{t('email.noTags')}</p> : <div className="flex flex-wrap gap-2">{tags.map((g) => <label key={g} className="flex min-h-9 items-center gap-2 rounded-full border border-line px-3 text-sm has-[:checked]:border-ink"><input type="checkbox" checked={rules.tags.includes(g)} onChange={() => toggle('tags', g)} />{g}</label>)}</div>}</fieldset>
        {scope.kind === 'organization' && <fieldset><legend className="mb-1 text-[13px] font-bold">{t('email.atLocations')}</legend><div className="flex flex-col gap-1">{locations.map((l) => <label key={l.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={rules.locationIds.includes(l.id)} onChange={() => toggle('locationIds', l.id)} />{l.name}</label>)}</div></fieldset>}
        <Field label={t('email.joinedWithin')} optional>{(p) => <Input id={p.id} type="number" min={1} value={rules.createdWithinDays ?? ''} onChange={(e) => setRules((r) => ({ ...r, createdWithinDays: e.target.value ? Number(e.target.value) : null }))} />}</Field>
        <p className="text-xs text-stone">{t('email.consentNote')}</p>
      </div>
    </Drawer>
  );
}
