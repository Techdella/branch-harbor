'use client';

import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Textarea } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, Empty, ErrorState, LoadingBlock } from '@/components/ui/States';
import { ApiError } from '@/lib/errors';
import { mkt, uploadAsset, useAction, useLoad, useMkt, type Asset } from '../data';

/** Brand asset library: uploads (S3/R2 or sandbox storage), folders, usage rights and expiry, HQ sharing to locations. */
export function AssetsScreen() {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const { orgId, locations, can } = useMkt();
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [q, setQ] = useState('');
  const res = useLoad(orgId, (o) => mkt.assets(o, { folder, q: q || undefined }), [folder, q]);
  const [uploadFolder, setUploadFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Asset | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const canManage = can('assets.manage');

  async function upload(files: FileList) {
    if (!orgId) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) await uploadAsset(orgId, f, { folder: uploadFolder || folder || '' });
      res.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="image" title={t('assets.title')} description={t('assets.description')} />
      {res.data?.storageMode === 'db' && <Banner tone="info">{t('assets.sandbox')}</Banner>}
      <div className="flex flex-wrap items-end gap-2 rounded-xl bg-surface p-4">
        <Field label={t('assets.search')}>{(p) => <Input id={p.id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label={t('assets.folder')}>{(p) => <Select id={p.id} value={folder ?? '__all'} onChange={(e) => setFolder(e.target.value === '__all' ? undefined : e.target.value)}><option value="__all">{t('assets.allFolders')}</option>{(res.data?.folders ?? []).map((f) => <option key={f} value={f}>{f || t('assets.noFolder')}</option>)}</Select>}</Field>
        {canManage && <>
          <Field label={t('assets.uploadTo')} optional>{(p) => <Input id={p.id} value={uploadFolder} placeholder={folder ?? ''} onChange={(e) => setUploadFolder(e.target.value)} />}</Field>
          <Button icon="plus" loading={busy} onClick={() => file.current?.click()}>{t('assets.upload')}</Button>
          <input ref={file} type="file" multiple className="hidden" accept="image/*,application/pdf,video/mp4,font/woff2" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
        </>}
      </div>
      {err && <Banner tone="danger">{err}</Banner>}
      {res.status === 'error' && <ErrorState error={res.error} onRetry={res.reload} />}
      {!res.data && res.status === 'loading' && <LoadingBlock variant="cards" />}
      {res.data && (res.data.items.length === 0 ? <Empty icon="image" title={t('assets.emptyTitle')} body={t('assets.emptyBody')} /> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" role="list">
          {res.data.items.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-xl bg-surface p-2">
              <button type="button" onClick={() => setEdit(a)} className="text-start">
                {a.mime.startsWith('image/')
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={a.url} alt={a.alt} className="aspect-square w-full rounded-md object-cover" loading="lazy" />
                  : <span className="grid aspect-square place-items-center rounded-md bg-canvas"><Icon name={a.mime.startsWith('video/') ? 'video' : 'file'} size={32} /></span>}
                <span className="mt-1 block truncate text-xs font-bold">{a.name}</span>
              </button>
              <div className="flex flex-wrap gap-1">
                {a.locationId ? <Badge tone="neutral">{locations.find((l) => l.id === a.locationId)?.name ?? t('email.local')}</Badge> : <Badge tone="info">{t(`assets.share.${a.shareMode}` as never)}</Badge>}
                {a.expired ? <Badge tone="danger">{t('assets.expired')}</Badge> : a.rightsExpireAt ? <Badge tone="warning">{t('assets.expires', { at: fmt.dateTime(new Date(a.rightsExpireAt), { dateStyle: 'medium' }) })}</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
      ))}
      {edit && orgId && <AssetDrawer orgId={orgId} asset={edit} canManage={canManage} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); res.reload(); }} />}
    </div>
  );
}

function AssetDrawer({ orgId, asset, canManage, onClose, onSaved }: { orgId: string; asset: Asset; canManage: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('mkt');
  const { locations } = useMkt();
  const a = useAction();
  const [f, setF] = useState({ name: asset.name, folder: asset.folder, alt: asset.alt, usageRights: asset.usageRights, rightsExpireAt: asset.rightsExpireAt?.slice(0, 10) ?? '', shareMode: asset.shareMode, sharedLocationIds: asset.sharedLocationIds });
  const hq = !asset.locationId;
  return (
    <Drawer open onClose={onClose} title={asset.name} kicker={t('assets.title')} footer={canManage ? <div className="flex justify-between gap-2"><Button variant="ghost" icon="x" loading={a.pending} onClick={async () => { if (await a.run(() => mkt.archiveAsset(orgId, asset.id))) onSaved(); }}>{t('assets.archive')}</Button><Button loading={a.pending} onClick={async () => { const r = await a.run(() => mkt.updateAsset(orgId, asset.id, { name: f.name, folder: f.folder, alt: f.alt, usageRights: f.usageRights, rightsExpireAt: f.rightsExpireAt ? new Date(`${f.rightsExpireAt}T23:59:59Z`).toISOString() : null, ...(hq ? { shareMode: f.shareMode, sharedLocationIds: f.sharedLocationIds } : {}) })); if (r) onSaved(); }}>{t('common.save')}</Button></div> : undefined}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        {asset.mime.startsWith('image/') && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.url} alt={asset.alt} className="max-h-64 w-full rounded-md object-contain" />
        )}
        <Field label={t('assets.url')}>{(p) => <Input id={p.id} value={asset.url} readOnly onFocus={(e) => e.currentTarget.select()} />}</Field>
        <Field label={t('assets.name')}>{(p) => <Input id={p.id} value={f.name} readOnly={!canManage} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label={t('assets.folder')} optional>{(p) => <Input id={p.id} value={f.folder} readOnly={!canManage} onChange={(e) => setF({ ...f, folder: e.target.value })} />}</Field>
        <Field label={t('assets.alt')} hint={t('assets.altHint')}>{(p) => <Input id={p.id} value={f.alt} readOnly={!canManage} onChange={(e) => setF({ ...f, alt: e.target.value })} />}</Field>
        <Field label={t('assets.rights')} hint={t('assets.rightsHint')} optional>{(p) => <Textarea id={p.id} value={f.usageRights} readOnly={!canManage} onChange={(e) => setF({ ...f, usageRights: e.target.value })} />}</Field>
        <Field label={t('assets.expiry')} hint={t('assets.expiryHint')} optional>{(p) => <Input id={p.id} type="date" value={f.rightsExpireAt} readOnly={!canManage} onChange={(e) => setF({ ...f, rightsExpireAt: e.target.value })} />}</Field>
        {hq && canManage && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[13px] font-bold">{t('assets.shareWith')}</legend>
            {(['private', 'all_locations', 'selected'] as const).map((m) => <label key={m} className="flex min-h-9 items-center gap-2 text-sm"><input type="radio" name="share" checked={f.shareMode === m} onChange={() => setF({ ...f, shareMode: m })} />{t(`assets.share.${m}` as never)}</label>)}
            {f.shareMode === 'selected' && <div className="ms-6 flex flex-col gap-1">{locations.map((l) => <label key={l.id} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={f.sharedLocationIds.includes(l.id)} onChange={() => setF({ ...f, sharedLocationIds: f.sharedLocationIds.includes(l.id) ? f.sharedLocationIds.filter((x) => x !== l.id) : [...f.sharedLocationIds, l.id] })} />{l.name}</label>)}</div>}
          </fieldset>
        )}
      </div>
    </Drawer>
  );
}
