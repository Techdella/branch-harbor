'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { FORM_FIELD_TYPES, formSettingsSchema, type FormField, type FormSettings } from '@bh/shared';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Textarea, Toggle } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, Empty, ErrorState, LoadingBlock } from '@/components/ui/States';
import { mkt, useAction, useLoad, useMkt, type FormRow } from '../data';
import { ImageField } from '../assets/AssetPicker';

export function FormsHub() {
  const t = useTranslations('mkt');
  const router = useRouter();
  const { orgId, locations, can } = useMkt();
  const res = useLoad(orgId, (o) => mkt.forms(o));
  const [open, setOpen] = useState(false);
  const a = useAction();
  const [name, setName] = useState('');
  const [loc, setLoc] = useState(can('forms.manage') ? '' : locations[0]?.id ?? '');
  async function create() {
    const fields: FormField[] = [
      { id: 'name', type: 'text', label: t('forms.defaults.name'), help: '', required: true, options: [], maps: 'name' },
      { id: 'email', type: 'email', label: t('forms.defaults.email'), help: '', required: true, options: [], maps: 'email' },
      { id: 'phone', type: 'phone', label: t('forms.defaults.phone'), help: '', required: false, options: [], maps: 'phone' },
      { id: 'message', type: 'textarea', label: t('forms.defaults.message'), help: '', required: false, options: [], maps: 'message' },
    ];
    const r = await a.run(() => mkt.createForm(orgId!, { name: name.trim(), fields, settings: { consents: [{ purpose: 'marketing_email', label: t('forms.defaults.consent'), version: '1' }] }, locationId: loc || null }));
    if (r) router.push(`/marketing/forms/${r.id}`);
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="file" title={t('forms.title')} description={t('forms.description')} />
      <div><Button icon="plus" onClick={() => setOpen(true)}>{t('forms.new')}</Button></div>
      {res.status === 'error' && <ErrorState error={res.error} onRetry={res.reload} />}
      {!res.data && res.status === 'loading' && <LoadingBlock variant="table" />}
      {res.data && (res.data.items.length === 0 ? <Empty icon="file" title={t('forms.emptyTitle')} body={t('forms.emptyBody')} /> : (
        <ul className="divide-y divide-line-soft rounded-xl bg-surface" role="list">
          {res.data.items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1"><div className="font-bold">{f.name}</div><div className="text-xs text-stone">{f.locationId ? locations.find((l) => l.id === f.locationId)?.name : t('email.wholeNetwork')} · {t('forms.submissions', { n: f.submissions })}{f.settings.landing.enabled ? ` · ${t('forms.landingOn')}` : ''}</div></div>
              <Badge tone={f.status === 'published' ? 'success' : 'neutral'}>{t(`forms.status.${f.status}` as never)}</Badge>
              <Link href={`/marketing/forms/${f.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white"><Icon name="edit" size={14} />{t('websites.edit')}</Link>
            </li>
          ))}
        </ul>
      ))}
      <Drawer open={open} onClose={() => setOpen(false)} title={t('forms.new')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={create}>{t('websites.create')}</Button></div>}>
        <div className="flex flex-col gap-4">
          {a.error && <Banner tone="danger">{a.error.message}</Banner>}
          <Field label={t('forms.name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('forms.leadsGoTo')}>{(p) => <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">{t('forms.hqForm')}</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        </div>
      </Drawer>
    </div>
  );
}

const fieldId = (label: string, taken: string[]) => {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 30) || 'field';
  let id = /^[a-z]/.test(base) ? base : `f_${base}`;
  let i = 2;
  while (taken.includes(id)) id = `${base}_${i++}`;
  return id;
};

export function FormEditorScreen({ id }: { id: string }) {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const { orgId } = useMkt();
  const res = useLoad(orgId, (o) => mkt.form(o, id), [id]);
  const [form, setForm] = useState<{ name: string; fields: FormField[]; settings: FormSettings; status: string } | null>(null);
  const [tab, setTab] = useState<'fields' | 'settings' | 'submissions'>('fields');
  const subs = useLoad(tab === 'submissions' ? orgId : null, (o) => mkt.submissions(o, id), [tab]);
  const a = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (res.data) setForm({ name: res.data.name, fields: res.data.fields, settings: formSettingsSchema.parse(res.data.settings), status: res.data.status }); }, [res.data]);
  if (res.status === 'error') return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!form || !orgId || !res.data) return <LoadingBlock variant="detail" />;
  const row: FormRow = res.data;
  const setField = (i: number, patch: Partial<FormField>) => setForm({ ...form, fields: form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const s = form.settings;
  const setS = (patch: Partial<FormSettings>) => setForm({ ...form, settings: { ...s, ...patch } });
  async function save(status?: 'draft' | 'published') {
    setMsg(null);
    const r = await a.run(() => mkt.saveForm(orgId!, id, { name: form!.name, fields: form!.fields, settings: form!.settings, status }));
    if (r) { setForm({ ...form!, status: r.status }); setMsg(status === 'published' ? t('forms.publishedMsg') : t('common.saved')); }
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="file" title={form.name} description={t('forms.editorDescription')} actions={<>
        <Link href="/marketing/forms" className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line px-5 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('builder.back')}</Link>
        <Button variant="secondary" icon="check" loading={a.pending} onClick={() => save()}>{t('common.save')}</Button>
        {form.status !== 'published' ? <Button variant="signal" icon="send" loading={a.pending} onClick={() => save('published')}>{t('forms.publish')}</Button> : <Button variant="ghost" loading={a.pending} onClick={() => save('draft')}>{t('forms.unpublish')}</Button>}
      </>} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {a.error && <Banner tone="danger">{a.error.message}</Banner>}
      {form.status === 'published' && <Banner tone="info">{t('forms.howToUse', { id: row.id })}</Banner>}
      <Tabs value={tab} onChange={setTab} items={[{ key: 'fields', label: t('forms.tabFields') }, { key: 'settings', label: t('forms.tabSettings') }, { key: 'submissions', label: t('forms.tabSubmissions') }]} />
      {tab === 'fields' && (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-surface p-4"><Field label={t('forms.name')}>{(p) => <Input id={p.id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field></div>
          {form.fields.map((f, i) => (
            <div key={i} className="grid gap-3 rounded-xl bg-surface p-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-end">
              <Field label={t('forms.label')}>{(p) => <Input id={p.id} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />}</Field>
              <Field label={t('forms.type')}>{(p) => <Select id={p.id} value={f.type} onChange={(e) => setField(i, { type: e.target.value as FormField['type'] })}>{FORM_FIELD_TYPES.map((k) => <option key={k} value={k}>{t(`forms.types.${k}` as never)}</option>)}</Select>}</Field>
              <Field label={t('forms.maps')}>{(p) => <Select id={p.id} value={f.maps} onChange={(e) => setField(i, { maps: e.target.value as FormField['maps'] })}>{['none', 'name', 'email', 'phone', 'message'].map((k) => <option key={k} value={k}>{t(`forms.mapsTo.${k}` as never)}</option>)}</Select>}</Field>
              <div className="flex items-center gap-2">
                <Toggle checked={f.required} onChange={(v) => setField(i, { required: v })} label={t('forms.required')} />
                <Button variant="ghost" size="sm" icon="x" aria-label={t('common.remove')} disabled={form.fields.length <= 1} onClick={() => setForm({ ...form, fields: form.fields.filter((_, j) => j !== i) })} />
              </div>
              {f.type === 'select' && <div className="md:col-span-4"><Field label={t('forms.options')} hint={t('forms.optionsHint')}>{(p) => <Textarea id={p.id} value={f.options.join('\n')} onChange={(e) => setField(i, { options: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30) })} />}</Field></div>}
              <div className="md:col-span-4"><Field label={t('forms.help')} optional>{(p) => <Input id={p.id} value={f.help} onChange={(e) => setField(i, { help: e.target.value })} />}</Field></div>
            </div>
          ))}
          <div><Button variant="secondary" icon="plus" disabled={form.fields.length >= 30} onClick={() => { const label = t('forms.newField'); setForm({ ...form, fields: [...form.fields, { id: fieldId(label, form.fields.map((x) => x.id)), type: 'text', label, help: '', required: false, options: [], maps: 'none' }] }); }}>{t('forms.addField')}</Button></div>
        </div>
      )}
      {tab === 'settings' && (
        <div className="grid gap-4 rounded-xl bg-surface p-5 lg:max-w-3xl">
          <Field label={t('forms.submitLabel')} optional>{(p) => <Input id={p.id} value={s.submitLabel} onChange={(e) => setS({ submitLabel: e.target.value })} maxLength={40} />}</Field>
          <Field label={t('forms.successMessage')} optional>{(p) => <Textarea id={p.id} value={s.successMessage} onChange={(e) => setS({ successMessage: e.target.value })} maxLength={400} />}</Field>
          <Field label={t('forms.routing')} hint={t('forms.routingHint')}>{(p) => <Select id={p.id} value={s.routing} onChange={(e) => setS({ routing: e.target.value as FormSettings['routing'] })}><option value="form_location">{t('forms.routeForm')}</option><option value="visitor_choice">{t('forms.routeVisitor')}</option></Select>}</Field>
          <Field label={t('forms.notify')} hint={t('forms.notifyHint')} optional>{(p) => <Input id={p.id} value={s.notifyEmails.join(', ')} onChange={(e) => setS({ notifyEmails: e.target.value.split(/[,\s]+/).filter(Boolean).slice(0, 10) })} />}</Field>
          <Field label={t('forms.tag')} hint={t('forms.tagHint')} optional>{(p) => <Input id={p.id} value={s.tag} onChange={(e) => setS({ tag: e.target.value })} maxLength={40} />}</Field>
          <fieldset className="grid gap-2 rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-bold">{t('forms.consents')}</legend>
            <p className="text-xs text-stone">{t('forms.consentsHint')}</p>
            {(['marketing_email', 'marketing_sms', 'marketing_whatsapp'] as const).map((purpose) => {
              const c = s.consents.find((x) => x.purpose === purpose);
              return (
                <div key={purpose} className="grid gap-2">
                  <Toggle checked={!!c} label={t(`auto.purpose.${purpose}` as never)} onChange={(v) => setS({ consents: v ? [...s.consents, { purpose, label: t(`forms.consentDefault.${purpose}` as never), version: '1' }] : s.consents.filter((x) => x.purpose !== purpose) })} />
                  {c && <Input aria-label={t('forms.consentWording')} value={c.label} onChange={(e) => setS({ consents: s.consents.map((x) => (x.purpose === purpose ? { ...x, label: e.target.value, version: new Date().toISOString().slice(0, 10) } : x)) })} />}
                </div>
              );
            })}
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-bold">{t('forms.landing')}</legend>
            <Toggle checked={s.landing.enabled} label={t('forms.landingEnable')} onChange={(v) => setS({ landing: { ...s.landing, enabled: v } })} />
            {s.landing.enabled && <>
              <Field label={t('forms.landingHeading')}>{(p) => <Input id={p.id} value={s.landing.heading} onChange={(e) => setS({ landing: { ...s.landing, heading: e.target.value } })} />}</Field>
              <Field label={t('forms.landingIntro')} optional>{(p) => <Textarea id={p.id} value={s.landing.intro} onChange={(e) => setS({ landing: { ...s.landing, intro: e.target.value } })} />}</Field>
              <ImageField orgId={orgId} label={t('forms.landingImage')} value={s.landing.image} onChange={(v) => setS({ landing: { ...s.landing, image: v } })} />
              <p className="text-xs text-stone">{t('forms.landingUrl', { path: `/f/${row.id}` })}</p>
            </>}
          </fieldset>
          <p className="text-xs text-stone">{t('forms.spam')}</p>
        </div>
      )}
      {tab === 'submissions' && (subs.status === 'error' ? <ErrorState error={subs.error} onRetry={subs.reload} /> : !subs.data ? <LoadingBlock variant="table" /> : subs.data.items.length === 0 ? <Empty icon="file" title={t('forms.noSubmissions')} /> : (
        <div className="overflow-x-auto rounded-xl bg-surface p-4">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-start text-xs uppercase text-stone"><th className="py-2 text-start">{t('forms.received')}</th>{form.fields.slice(0, 4).map((f) => <th key={f.id} className="py-2 text-start">{f.label}</th>)}<th className="py-2 text-start">{t('forms.consents')}</th></tr></thead>
            <tbody>{subs.data.items.map((r) => (
              <tr key={r.id} className="border-t border-line-soft">
                <td className="py-2">{fmt.dateTime(new Date(r.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</td>
                {form.fields.slice(0, 4).map((f) => <td key={f.id} className="py-2">{r.data ? String(r.data[f.id] ?? '') : '•••'}</td>)}
                <td className="py-2">{Object.entries(r.consents).filter(([, v]) => v).map(([k]) => t(`auto.purpose.${k}` as never)).join(', ') || '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
