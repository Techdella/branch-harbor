'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Textarea, cx } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { relativeTime } from '@/lib/format';
import { AudiencePicker, ErrorNote, Pill, useAudienceText, useNet, useNetAction, type Audience, type NetMe } from './net';
import { LoadingBlock } from '../ui/States';

interface Folder { id: string; parentId: string | null; name: string; audience: Audience; count: number }
interface Resource { id: string; title: string; kind: string; folderId: string | null; summary: string | null; url: string | null; fileName: string | null; tags: string[]; audience: Audience; helpCategory: string | null; version: number; updatedAt: string; updatedBy: string | null; body?: string | null }
interface ResourceDetail extends Resource { versions: { version: number; title: string; url: string | null; note: string | null; by: string | null; at: string }[]; canManage: boolean }

const KIND_ICON: Record<string, IconName> = { document: 'file', playbook: 'book', sop: 'list', kb_article: 'help', link: 'link', video: 'video' };
export const RESOURCE_KINDS = ['document', 'playbook', 'sop', 'kb_article', 'link', 'video'] as const;

/** Resource library (documents, playbooks, SOPs) — also the help desk knowledge base (helpOnly). */
export function LibraryPanel({ me, helpOnly = false }: { me: NetMe; helpOnly?: boolean }) {
  const t = useTranslations('community.lib');
  const locale = useLocale();
  const audienceText = useAudienceText(me.directory);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<'resource' | 'folder' | null>(null);
  const folders = useNet<{ items: Folder[]; canManage: boolean }>('/resources/folders');
  const params = new URLSearchParams();
  if (folderId && !query) params.set('folderId', folderId);
  if (kind) params.set('kind', kind);
  if (query) params.set('q', query);
  if (helpOnly) params.set('helpOnly', 'true');
  const res = useNet<{ items: Resource[]; canManage: boolean }>(`/resources?${params.toString()}`, [params.toString()]);
  const canManage = !!res.data?.canManage;

  return (
    <div className="grid gap-3 lg:grid-cols-[240px_1fr]">
      {!helpOnly && (
        <nav aria-label={t('folders')} className="flex flex-col gap-1 rounded-xl bg-surface p-2">
          <button type="button" onClick={() => setFolderId(null)} className={cx('rounded-lg px-3 py-2 text-left text-sm font-bold', !folderId ? 'bg-lime' : 'hover:bg-canvas')}>{t('allFolders')}</button>
          {(folders.data?.items ?? []).map((f) => (
            <button key={f.id} type="button" onClick={() => setFolderId(f.id)} className={cx('flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm', folderId === f.id ? 'bg-lime font-bold' : 'hover:bg-canvas')}>
              <Icon name="folder" size={15} /><span className="min-w-0 flex-1 truncate">{f.name}</span><span className="text-xs text-stone">{f.count}</span>
            </button>
          ))}
          {canManage && <Button size="sm" variant="ghost" icon="plus" onClick={() => setCreating('folder')}>{t('newFolder')}</Button>}
        </nav>
      )}
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
        <form role="search" className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <Input aria-label={helpOnly ? t('searchHelp') : t('search')} placeholder={helpOnly ? t('searchHelp') : t('search')} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          <Button type="submit" size="sm" variant="secondary" icon="search">{t('searchButton')}</Button>
          {!helpOnly && (
            <Select aria-label={t('kind')} value={kind} onChange={(e) => setKind(e.target.value)} className="max-w-[180px]">
              <option value="">{t('allKinds')}</option>
              {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}
            </Select>
          )}
          {canManage && <Button type="button" size="sm" variant="signal" icon="plus" className="ml-auto" onClick={() => setCreating('resource')}>{helpOnly ? t('newArticle') : t('newResource')}</Button>}
        </form>
        <ErrorNote error={res.error} />
        {res.loading && !res.data ? <LoadingBlock variant="table" rows={3} /> : (
          <ul className="flex flex-col divide-y divide-line-soft">
            {(res.data?.items ?? []).map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-canvas/60">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas"><Icon name={KIND_ICON[r.kind] ?? 'file'} size={17} /></span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-bold">{r.title}</span>
                    {r.summary && <span className="text-[13px] text-stone">{r.summary}</span>}
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-stone">
                      <Badge tone="neutral">{t(`kinds.${r.kind}`)}</Badge>{t('version', { version: r.version })} · {relativeTime(r.updatedAt, locale)}
                      {!r.audience.everyone && <span>· {audienceText(r.audience)}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!res.loading && !(res.data?.items ?? []).length && <li className="py-6 text-sm text-stone">{query ? t('noResults', { query }) : t('empty')}</li>}
          </ul>
        )}
      </section>
      {openId && <ResourceDrawer id={openId} me={me} onClose={() => setOpenId(null)} onChanged={() => void res.reload()} />}
      {creating === 'resource' && <ResourceForm me={me} folders={folders.data?.items ?? []} defaultKind={helpOnly ? 'kb_article' : 'document'} defaultFolder={folderId} onClose={() => setCreating(null)} onDone={() => { setCreating(null); void res.reload(); void folders.reload(); }} />}
      {creating === 'folder' && <FolderForm me={me} onClose={() => setCreating(null)} onDone={() => { setCreating(null); void folders.reload(); }} />}
    </div>
  );
}

function ResourceDrawer({ id, me, onClose, onChanged }: { id: string; me: NetMe; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('community.lib');
  const locale = useLocale();
  const res = useNet<ResourceDetail>(`/resources/${id}`, [id]);
  const act = useNetAction();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const r = res.data;
  void me;
  return (
    <Drawer open onClose={onClose} title={r?.title ?? t('loading')} kicker={r ? t(`kinds.${r.kind}`) : undefined}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={res.error ?? act.error} />
        {!r ? <LoadingBlock variant="detail" /> : (
          <>
            {r.summary && <p className="text-sm text-stone">{r.summary}</p>}
            {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start rounded-full bg-ink px-4 py-2 text-sm font-bold text-white"><Icon name="download" size={16} />{r.fileName ?? t('open')}</a>}
            {r.body && !editing && <div className="whitespace-pre-line rounded-lg bg-canvas p-3 text-sm leading-relaxed">{r.body}</div>}
            {r.tags.length > 0 && <div className="flex flex-wrap gap-1">{r.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}</div>}
            {r.canManage && !editing && <Button size="sm" variant="secondary" icon="edit" className="self-start" onClick={() => { setEditing(true); setBody(r.body ?? ''); setUrl(r.url ?? ''); }}>{t('newVersion')}</Button>}
            {editing && (
              <form className="flex flex-col gap-2" onSubmit={async (e) => {
                e.preventDefault();
                if (await act.run('patch', `/resources/${r.id}`, { body: body || null, url: url || null, note: note || undefined })) { setEditing(false); void res.reload(); onChanged(); }
              }}>
                <Field label={t('text')} optional>{(p) => <Textarea id={p.id} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
                <Field label={t('fileUrl')} optional>{(p) => <Input id={p.id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
                <Field label={t('changeNote')} optional>{(p) => <Input id={p.id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                <div className="flex gap-2"><Button type="submit" size="sm" loading={act.pending}>{t('saveVersion')}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('cancel')}</Button></div>
              </form>
            )}
            <h3 className="mt-2 text-sm font-bold">{t('history')}</h3>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {r.versions.map((v) => <li key={v.version} className="flex flex-wrap gap-2"><Badge tone={v.version === r.version ? 'success' : 'neutral'}>{t('version', { version: v.version })}</Badge><span>{v.note ?? v.title}</span><span className="text-stone">{v.by ? `${v.by} · ` : ''}{relativeTime(v.at, locale)}</span></li>)}
            </ul>
          </>
        )}
      </div>
    </Drawer>
  );
}

function ResourceForm({ me, folders, defaultKind, defaultFolder, onClose, onDone }: { me: NetMe; folders: Folder[]; defaultKind: string; defaultFolder: string | null; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('community.lib');
  const act = useNetAction();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(defaultKind);
  const [folderId, setFolderId] = useState(defaultFolder ?? '');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const [audience, setAudience] = useState<Audience>({});
  const f = act.error?.fields ?? {};
  return (
    <Drawer open onClose={onClose} title={t('newResource')} footer={<Button loading={act.pending} disabled={!title.trim()} onClick={async () => {
      if (await act.run('post', '/resources', { title, kind, folderId: folderId || null, summary: summary || null, body: body || null, url: url || null, tags: tags.split(',').map((x) => x.trim()).filter(Boolean), audience })) onDone();
    }}>{t('save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={act.error && !Object.keys(f).length ? act.error : null} />
        <Field label={t('titleLabel')} error={f.title}>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('kind')}>{(p) => <Select id={p.id} value={kind} onChange={(e) => setKind(e.target.value)}>{RESOURCE_KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}</Select>}</Field>
          <Field label={t('folder')} optional>{(p) => <Select id={p.id} value={folderId} onChange={(e) => setFolderId(e.target.value)}><option value="">{t('noFolder')}</option>{folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        </div>
        <Field label={t('summary')} optional>{(p) => <Input id={p.id} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field>
        <Field label={t('text')} error={f.body} optional>{(p) => <Textarea id={p.id} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <Field label={t('fileUrl')} error={f.url} optional hint={t('fileUrlHint')}>{(p) => <Input id={p.id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
        <Field label={t('tags')} optional hint={t('tagsHint')}>{(p) => <Input id={p.id} value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
        <span className="text-[13px] font-bold">{t('whoCanSee')}</span>
        <AudiencePicker value={audience} onChange={setAudience} directory={me.directory} />
      </div>
    </Drawer>
  );
}

function FolderForm({ me, onClose, onDone }: { me: NetMe; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('community.lib');
  const act = useNetAction();
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<Audience>({});
  return (
    <Drawer open onClose={onClose} title={t('newFolder')} footer={<Button loading={act.pending} disabled={!name.trim()} onClick={async () => { if (await act.run('post', '/resources/folders', { name, audience })) onDone(); }}>{t('save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={act.error} />
        <Field label={t('folderName')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <span className="text-[13px] font-bold">{t('whoCanSee')}</span>
        <AudiencePicker value={audience} onChange={setAudience} directory={me.directory} />
        <div className="flex gap-1.5"><Pill active={!!audience.hqOnly} onClick={() => setAudience({ ...audience, hqOnly: !audience.hqOnly })}>{t('hqOnly')}</Pill></div>
      </div>
    </Drawer>
  );
}
