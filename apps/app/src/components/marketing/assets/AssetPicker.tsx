'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Drawer, Icon, Input } from '@bh/ui';
import { mkt, uploadAsset, type Asset } from '../data';

/** Choose an image from the brand asset library (or upload one). Expired usage rights cannot be picked. */
export function AssetPickerDrawer({ orgId, open, onClose, onPick, accept = 'image' }: { orgId: string; open: boolean; onClose: () => void; onPick: (a: Asset) => void; accept?: 'image' | 'any' }) {
  const t = useTranslations('mkt');
  const [items, setItems] = useState<Asset[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    mkt.assets(orgId, { type: accept === 'image' ? 'image' : 'any' }).then((r) => setItems(r.items), (e: Error) => { setItems([]); setError(e.message); });
  }, [open, orgId, accept]);
  const visible = (items ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  async function upload(f: File) {
    setBusy(true);
    setError(null);
    try {
      const a = await uploadAsset(orgId, f);
      onPick(a);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer open={open} onClose={onClose} title={t('assets.pickTitle')} kicker={t('assets.title')}>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('assets.search')} aria-label={t('assets.search')} />
          <Button variant="secondary" icon="plus" loading={busy} onClick={() => file.current?.click()}>{t('assets.upload')}</Button>
          <input ref={file} type="file" accept={accept === 'image' ? 'image/*' : undefined} className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>
        {error && <p role="alert" className="text-sm font-bold text-danger">{error}</p>}
        {items === null ? <p className="text-sm text-stone">{t('common.loading')}</p> : visible.length === 0 ? <p className="text-sm text-stone">{t('assets.empty')}</p> : (
          <ul className="grid grid-cols-2 gap-3" role="list">
            {visible.map((a) => (
              <li key={a.id}>
                <button type="button" disabled={a.expired} onClick={() => { onPick(a); onClose(); }} className="group flex w-full flex-col gap-1 rounded-md border border-line p-2 text-start hover:border-ink disabled:opacity-50">
                  {a.mime.startsWith('image/')
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={a.url} alt={a.alt} className="aspect-[4/3] w-full rounded-sm object-cover" />
                    : <span className="grid aspect-[4/3] place-items-center rounded-sm bg-canvas"><Icon name="file" /></span>}
                  <span className="truncate text-xs font-bold">{a.name}</span>
                  {a.expired && <span className="text-[11px] font-bold text-danger">{t('assets.expired')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

/** Puck custom field: an image URL with a library picker. */
export function ImageField({ orgId, label, value, onChange, readOnly }: { orgId: string; label: string; value: string; onChange: (v: string) => void; readOnly?: boolean }) {
  const t = useTranslations('mkt');
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold">{label}</span>
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="aspect-[16/9] w-full rounded-sm border border-line object-cover" />
      )}
      <div className="flex gap-2">
        <Input value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder="https://" />
        {!readOnly && <Button type="button" size="sm" variant="secondary" icon="image" onClick={() => setOpen(true)}>{t('assets.library')}</Button>}
      </div>
      <AssetPickerDrawer orgId={orgId} open={open} onClose={() => setOpen(false)} onPick={(a) => onChange(a.url)} />
    </div>
  );
}
