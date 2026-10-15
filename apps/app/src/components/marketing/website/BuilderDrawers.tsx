'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { DocumentIssue, PageDocument } from '@bh/shared';
import { Badge, Button, Drawer, Field, Input, Textarea, Toggle } from '@bh/ui';
import { Banner } from '@/components/ui/States';
import { ApiError } from '@/lib/errors';
import { mkt, useAction, useMkt, type BuilderData, type History, type MasterDetail, type PageMeta, type PublishJob } from '../data';
import { AssetPickerDrawer } from '../assets/AssetPicker';

export function PageSettingsDrawer({ open, onClose, orgId, page, onSaved }: { open: boolean; onClose: () => void; orgId: string; page: PageMeta; onSaved: (p: PageMeta) => void }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [f, setF] = useState({ title: page.title, slug: page.slug, seoTitle: page.seo.title ?? '', seoDescription: page.seo.description ?? '', socialImage: page.seo.socialImage ?? '', noindex: !!page.seo.noindex, navLabel: page.navLabel ?? '', showInNav: page.showInNav });
  const [pick, setPick] = useState(false);
  useEffect(() => { if (open) setF({ title: page.title, slug: page.slug, seoTitle: page.seo.title ?? '', seoDescription: page.seo.description ?? '', socialImage: page.seo.socialImage ?? '', noindex: !!page.seo.noindex, navLabel: page.navLabel ?? '', showInNav: page.showInNav }); }, [open, page]);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    const r = await a.run(() => mkt.pageMeta(orgId, page.id, { title: f.title, ...(page.slug !== 'home' ? { slug: f.slug } : {}), seo: { title: f.seoTitle || undefined, description: f.seoDescription || undefined, socialImage: f.socialImage || undefined, noindex: f.noindex }, navLabel: f.navLabel || null, showInNav: f.showInNav }));
    if (r) { onSaved(r); onClose(); }
  }
  return (
    <Drawer open={open} onClose={onClose} title={t('settings.title')} kicker={page.title} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} onClick={save}>{t('common.save')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('settings.pageTitle')} error={a.error?.fields?.title}>{(p) => <Input id={p.id} value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={80} />}</Field>
        <Field label={t('settings.address')} hint={page.slug === 'home' ? t('settings.homeAddress') : t('settings.addressHint')} error={a.error?.fields?.slug}>{(p) => <Input id={p.id} value={f.slug} disabled={page.slug === 'home'} onChange={(e) => set('slug', e.target.value)} maxLength={60} />}</Field>
        <h3 className="mt-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('settings.seo')}</h3>
        <Field label={t('settings.seoTitle')} hint={t('settings.chars', { n: f.seoTitle.length, max: 70 })}>{(p) => <Input id={p.id} value={f.seoTitle} onChange={(e) => set('seoTitle', e.target.value)} maxLength={70} />}</Field>
        <Field label={t('settings.seoDescription')} hint={t('settings.chars', { n: f.seoDescription.length, max: 170 })}>{(p) => <Textarea id={p.id} value={f.seoDescription} onChange={(e) => set('seoDescription', e.target.value)} maxLength={170} />}</Field>
        <Field label={t('settings.socialImage')} error={a.error?.fields?.socialImage}>{(p) => <div className="flex gap-2"><Input id={p.id} value={f.socialImage} onChange={(e) => set('socialImage', e.target.value)} placeholder="https://" /><Button variant="secondary" icon="image" onClick={() => setPick(true)}>{t('assets.library')}</Button></div>}</Field>
        <Toggle checked={f.noindex} onChange={(v) => set('noindex', v)} label={t('settings.noindex')} />
        <p className="-mt-2 text-xs text-stone">{t('settings.noindexHint')}</p>
        <h3 className="mt-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('settings.navigation')}</h3>
        <Field label={t('settings.navLabel')} optional>{(p) => <Input id={p.id} value={f.navLabel} onChange={(e) => set('navLabel', e.target.value)} maxLength={40} />}</Field>
        <Toggle checked={f.showInNav} onChange={(v) => set('showInNav', v)} label={t('settings.showInNav')} />
      </div>
      <AssetPickerDrawer orgId={orgId} open={pick} onClose={() => setPick(false)} onPick={(x) => set('socialImage', x.url)} />
    </Drawer>
  );
}

export function HistoryDrawer({ open, onClose, orgId, pageId, baseRevision, onRestored }: { open: boolean; onClose: () => void; orgId: string; pageId: string; baseRevision: () => number; onRestored: (doc: PageDocument, revision: number) => void }) {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const [h, setH] = useState<History | null>(null);
  const a = useAction();
  useEffect(() => { if (open) { setH(null); mkt.history(orgId, pageId).then(setH, () => setH({ revisions: [], versions: [] })); } }, [open, orgId, pageId]);
  async function restore(body: { revisionId?: string; versionId?: string }) {
    const r = await a.run(() => mkt.restore(orgId, pageId, { ...body, baseRevision: baseRevision() }));
    if (r) { onRestored(r.document, r.revision); onClose(); }
  }
  const when = (iso: string) => fmt.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Drawer open={open} onClose={onClose} title={t('history.title')}>
      {a.error && <Banner tone="danger">{a.error.message}</Banner>}
      {!h ? <p className="text-sm text-stone">{t('common.loading')}</p> : (
        <div className="flex flex-col gap-6">
          <section>
            <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('history.published')}</h3>
            {h.versions.length === 0 ? <p className="text-sm text-stone">{t('history.noVersions')}</p> : (
              <ul className="flex flex-col gap-2" role="list">
                {h.versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2 rounded-md border border-line p-3">
                    <div><div className="text-sm font-bold">{t('history.version', { n: v.version })} {v.live && <Badge tone="success">{t('history.live')}</Badge>}</div><div className="text-xs text-stone">{when(v.createdAt)}</div></div>
                    <Button size="sm" variant="secondary" loading={a.pending} onClick={() => restore({ versionId: v.id })}>{t('history.restore')}</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-extrabold uppercase tracking-wide text-stone">{t('history.drafts')}</h3>
            {h.revisions.length === 0 ? <p className="text-sm text-stone">{t('history.noDrafts')}</p> : (
              <ul className="flex flex-col gap-2" role="list">
                {h.revisions.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-line p-3">
                    <div><div className="text-sm font-bold">{t(`history.reason.${r.reason}` as never)}</div><div className="text-xs text-stone">{when(r.createdAt)}</div></div>
                    <Button size="sm" variant="secondary" loading={a.pending} onClick={() => restore({ revisionId: r.id })}>{t('history.restore')}</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-xs text-stone">{t('history.hint')}</p>
        </div>
      )}
    </Drawer>
  );
}

function IssueList({ issues }: { issues: DocumentIssue[] }) {
  const t = useTranslations('mkt') as unknown as (k: string, v?: Record<string, string>) => string;
  const field = (path: string) => { const k = path.split('.').filter((x) => !/^\d+$/.test(x)).pop() ?? ''; return k && k !== 'props' ? t(`fields.${k}`) : ''; };
  return (
    <ul className="list-disc ps-5 text-sm">
      {issues.slice(0, 12).map((i, k) => <li key={k}>{t(`issues.${i.code}`, { field: field(i.path) })}</li>)}
    </ul>
  );
}

export function PublishDrawer({ open, onClose, orgId, page, permissions, independent, onChanged }: { open: boolean; onClose: () => void; orgId: string; page: PageMeta; permissions: BuilderData['permissions']; independent: boolean; onChanged: (p: PageMeta) => void }) {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const a = useAction();
  const [at, setAt] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [issues, setIssues] = useState<DocumentIssue[] | null>(null);
  useEffect(() => { if (open) { setDone(null); setIssues(null); a.clear(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const capture = (e: unknown) => { if (e instanceof ApiError && e.code === 'document_invalid') setIssues((e.details?.issues as DocumentIssue[]) ?? []); throw e; };
  async function publishNow() {
    const r = await a.run(() => mkt.publish(orgId, page.id).catch(capture));
    if (r) { setDone(t('publish.published', { n: r.version.version })); onChanged({ ...page, status: 'published', publishedAt: new Date().toISOString(), scheduledPublishAt: null }); }
  }
  async function submit() {
    const r = await a.run(() => mkt.submitPage(orgId, page.id));
    if (r) { setDone(t('publish.submitted')); onChanged({ ...page, status: 'pending_approval' }); }
  }
  async function schedule(value: string | null) {
    const r = await a.run(() => mkt.schedule(orgId, page.id, value ? new Date(value).toISOString() : null).catch(capture));
    if (r) { onChanged(r); setDone(value ? t('publish.scheduled', { at: fmt.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('publish.unscheduled')); }
  }
  const pending = page.status === 'pending_approval';
  return (
    <Drawer open={open} onClose={onClose} title={t('publish.title')} kicker={page.title}>
      <div className="flex flex-col gap-4">
        {done && <Banner tone="success" live="polite">{done}</Banner>}
        {a.error && <Banner tone="danger" title={a.error.message}>{issues && <IssueList issues={issues} />}</Banner>}
        {pending && <Banner tone="warning">{t('publish.pending')}</Banner>}
        {!permissions.canPublish ? (
          <>
            <p className="text-sm text-stone">{t('publish.needApproval')}</p>
            <Button icon="send" loading={a.pending} disabled={pending} onClick={submit}>{t('publish.submit')}</Button>
          </>
        ) : (
          <>
            <p className="text-sm text-stone">{independent ? t('publish.bodyIndependent') : t('publish.body')}</p>
            <Button variant="signal" icon="send" loading={a.pending} disabled={pending} onClick={publishNow}>{t('publish.now')}</Button>
            <div className="mt-2 rounded-lg border border-line p-4">
              <h3 className="text-sm font-bold">{t('publish.scheduleTitle')}</h3>
              {page.scheduledPublishAt && <p className="mt-1 text-sm">{t('publish.scheduledFor', { at: fmt.dateTime(new Date(page.scheduledPublishAt), { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label={t('publish.when')}>{(p) => <Input id={p.id} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}</Field>
                <Button variant="secondary" icon="clock" disabled={!at || pending} loading={a.pending} onClick={() => schedule(at)}>{t('publish.schedule')}</Button>
                {page.scheduledPublishAt && <Button variant="ghost" onClick={() => schedule(null)}>{t('publish.cancelSchedule')}</Button>}
              </div>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

export function ApplyMasterDrawer({ open, onClose, orgId, master }: { open: boolean; onClose: () => void; orgId: string; master: MasterDetail }) {
  const t = useTranslations('mkt');
  const { locations } = useMkt();
  const a = useAction();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Array<{ locationId: string; status: string; reason: string | null }> | null>(null);
  const [job, setJob] = useState<PublishJob | null>(null);
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? id;
  useEffect(() => { if (open) { setApplied(null); setJob(null); setSel(new Set(locations.map((l) => l.id))); } }, [open, locations]);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Drawer open={open} onClose={onClose} title={t('masters.applyTitle')} kicker={master.name}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-stone">{t('masters.applyBody')}</p>
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <ul className="flex flex-col gap-1" role="list">
          {locations.map((l) => (
            <li key={l.id}><label className="flex min-h-11 items-center gap-3 rounded-md px-2 hover:bg-canvas"><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} className="size-5" />{l.name}</label></li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button icon="share" loading={a.pending} disabled={!sel.size} onClick={async () => { const r = await a.run(() => mkt.applyMaster(orgId, master.id, [...sel])); if (r) setApplied(r.results); }}>{t('masters.applyDrafts', { n: sel.size })}</Button>
          {applied && <Button variant="signal" icon="send" loading={a.pending} onClick={async () => { const r = await a.run(() => mkt.groupPublish(orgId, master.pageSlug, applied.filter((x) => x.status !== 'failed' && x.status !== 'skipped').map((x) => x.locationId))); if (r) setJob(r); }}>{t('masters.publishAll')}</Button>}
        </div>
        {applied && !job && (
          <table className="w-full text-sm"><tbody>
            {applied.map((r) => <tr key={r.locationId} className="border-t border-line-soft"><td className="py-2">{name(r.locationId)}</td><td className="py-2 text-end"><Badge tone={r.status === 'failed' ? 'danger' : r.status === 'skipped' ? 'warning' : 'success'}>{t(`masters.result.${r.status}` as never)}</Badge></td></tr>)}
          </tbody></table>
        )}
        {job && (
          <div className="flex flex-col gap-2">
            <Banner tone={job.status === 'completed' ? 'success' : job.status === 'partial' ? 'warning' : 'danger'} live="polite">{(t as unknown as (k: string, v: Record<string, number>) => string)(`publish.job.${job.status}`, { ok: job.summary.succeeded, total: job.summary.total })}</Banner>
            <table className="w-full text-sm"><tbody>
              {job.results.map((r) => <tr key={r.locationId} className="border-t border-line-soft align-top"><td className="py-2">{name(r.locationId)}{r.error && <div className="text-xs text-danger">{r.error}</div>}{r.warnings.map((w) => <div key={w} className="text-xs text-stone">{w}</div>)}</td><td className="py-2 text-end"><Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{t(`publish.result.${r.status}` as never)}</Badge></td></tr>)}
            </tbody></table>
            {job.summary.failed > 0 && <Button variant="secondary" icon="refresh" loading={a.pending} onClick={async () => { const r = await a.run(() => mkt.retryJob(orgId, job.id)); if (r) setJob(r); }}>{t('publish.retryFailed')}</Button>}
          </div>
        )}
      </div>
    </Drawer>
  );
}
