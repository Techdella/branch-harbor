'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EMAIL_BLOCK_TYPES, EMAIL_TOKENS, newEmailBlock, type EmailBlock, type EmailBlockType, type EmailDocument } from '@bh/shared';
import { Button, Field, Icon, Input, Select, Tabs, Textarea } from '@bh/ui';
import { Banner } from '@/components/ui/States';
import { mkt, useAction } from '../data';
import { ImageField } from '../assets/AssetPicker';

export interface EmailDraft { subject: string; preheader: string; document: EmailDocument }

/**
 * Block-based email editor: drag (or move) blocks, edit the selected block, and see the MJML-rendered email (the
 * same HTML recipients get) with its plain-text part. Personalisation tokens are inserted with a fallback.
 */
export function EmailEditor({ orgId, value, onChange, locationId = null, readOnly = false }: { orgId: string; value: EmailDraft; onChange: (v: EmailDraft) => void; locationId?: string | null; readOnly?: boolean }) {
  const t = useTranslations('mkt');
  const [sel, setSel] = useState<string | null>(value.document.blocks[0]?.id ?? null);
  const [preview, setPreview] = useState<{ html: string; text: string; warnings: string[] } | null>(null);
  const [view, setView] = useState<'desktop' | 'mobile' | 'text'>('desktop');
  const [drag, setDrag] = useState<number | null>(null);
  const test = useAction();
  const [sent, setSent] = useState<string | null>(null);
  const blocks = value.document.blocks;
  const setBlocks = (b: EmailBlock[]) => onChange({ ...value, document: { ...value.document, blocks: b } });
  const update = (id: string, patch: Partial<EmailBlock>) => setBlocks(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as EmailBlock) : b)));
  const move = (from: number, to: number) => { if (to < 0 || to >= blocks.length) return; const n = [...blocks]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); setBlocks(n); };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      mkt.render(orgId, { document: value.document, subject: value.subject, preheader: value.preheader, locationId }).then(setPreview, () => undefined);
    }, 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [orgId, value, locationId]);

  const selected = blocks.find((b) => b.id === sel) ?? null;
  const add = (type: EmailBlockType) => { const b = newEmailBlock(type); const at = selected ? blocks.indexOf(selected) + 1 : blocks.length; const n = [...blocks]; n.splice(at, 0, b); setBlocks(n); setSel(b.id); };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="grid gap-3 rounded-xl bg-surface p-4">
          <Field label={t('email.subject')}>{(p) => <Input id={p.id} value={value.subject} readOnly={readOnly} onChange={(e) => onChange({ ...value, subject: e.target.value })} maxLength={200} />}</Field>
          <Field label={t('email.preheader')} hint={t('email.preheaderHint')} optional>{(p) => <Input id={p.id} value={value.preheader} readOnly={readOnly} onChange={(e) => onChange({ ...value, preheader: e.target.value })} maxLength={200} />}</Field>
          <p className="text-xs text-stone">{t('email.tokensHint')} {EMAIL_TOKENS.map((k) => <code key={k} className="me-1 rounded bg-canvas px-1">{`{{${k}|…}}`}</code>)}</p>
        </div>
        <div className="rounded-xl bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold">{t('email.blocks')}</h3>
            {!readOnly && (
              <Select aria-label={t('email.addBlock')} value="" onChange={(e) => e.target.value && add(e.target.value as EmailBlockType)} className="w-auto">
                <option value="">{t('email.addBlock')}</option>
                {EMAIL_BLOCK_TYPES.map((k) => <option key={k} value={k}>{t(`email.block.${k}` as never)}</option>)}
              </Select>
            )}
          </div>
          <ol className="mt-3 flex flex-col gap-1.5">
            {blocks.map((b, i) => (
              <li key={b.id} draggable={!readOnly} onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${sel === b.id ? 'border-ink bg-canvas' : 'border-line'}`}>
                <Icon name="menu" size={14} className="cursor-grab text-stone" aria-hidden />
                <button type="button" className="min-h-9 min-w-0 flex-1 truncate text-start text-sm" onClick={() => setSel(b.id)}>
                  <span className="font-bold">{t(`email.block.${b.type}` as never)}</span>
                  <span className="ms-2 text-stone">{summary(b)}</span>
                </button>
                {!readOnly && <>
                  <button type="button" className="rounded p-1.5 hover:bg-surface disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t('common.moveUp')}><Icon name="chevron-down" size={14} className="rotate-180" /></button>
                  <button type="button" className="rounded p-1.5 hover:bg-surface disabled:opacity-30" disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)} aria-label={t('common.moveDown')}><Icon name="chevron-down" size={14} /></button>
                  <button type="button" className="rounded p-1.5 hover:bg-surface" onClick={() => { const c = { ...structuredClone(b), id: newEmailBlock(b.type).id }; const n = [...blocks]; n.splice(i + 1, 0, c); setBlocks(n); }} aria-label={t('common.duplicate')}><Icon name="copy" size={14} /></button>
                  <button type="button" className="rounded p-1.5 hover:bg-surface" onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))} aria-label={t('common.remove')}><Icon name="x" size={14} /></button>
                </>}
              </li>
            ))}
          </ol>
          {!blocks.some((b) => b.type === 'footer') && <p className="mt-2 text-xs text-stone">{t('email.autoFooter')}</p>}
        </div>
        {selected && !readOnly && <BlockForm orgId={orgId} block={selected} onChange={(patch) => update(selected.id, patch)} />}
      </div>
      <div className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-3 xl:self-start">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs value={view} onChange={setView} items={[{ key: 'desktop', label: t('email.desktop') }, { key: 'mobile', label: t('email.mobile') }, { key: 'text', label: t('email.plainText') }]} />
          <Button size="sm" variant="secondary" icon="send" loading={test.pending} disabled={!value.subject.trim()} onClick={async () => { setSent(null); const r = await test.run(() => mkt.testSend(orgId, { ...value, locationId })); if (r) setSent(r.sandbox ? t('email.testSandbox', { to: r.to }) : t('email.testSent', { to: r.to })); }}>{t('email.sendTest')}</Button>
        </div>
        {sent && <Banner tone="success" live="polite">{sent}</Banner>}
        {test.error && <Banner tone="danger">{test.error.message}</Banner>}
        {preview?.warnings.length ? <Banner tone="warning">{preview.warnings.map((w) => (t as unknown as (k: string, v?: Record<string, string>) => string)(`email.warn.${w.split(':')[0]}`, { token: w.split(':')[1] ?? '' })).join(' · ')}</Banner> : null}
        <div className="overflow-hidden rounded-xl border border-line bg-[#F4F4F2]">
          {view === 'text' ? <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap p-4 text-sm">{preview?.text ?? ''}</pre> : (
            <iframe title={t('email.previewTitle')} sandbox="" srcDoc={preview?.html ?? ''} className="mx-auto block h-[720px] bg-white" style={{ width: view === 'mobile' ? 390 : '100%' }} />
          )}
        </div>
      </div>
    </div>
  );
}

const summary = (b: EmailBlock) => {
  switch (b.type) {
    case 'text': return b.text.slice(0, 40);
    case 'button': return b.label;
    case 'header': return b.title;
    case 'image': return b.alt;
    default: return '';
  }
};

function BlockForm({ orgId, block: b, onChange }: { orgId: string; block: EmailBlock; onChange: (p: Partial<EmailBlock>) => void }) {
  const t = useTranslations('mkt');
  return (
    <div className="grid gap-3 rounded-xl bg-surface p-4">
      <h3 className="text-sm font-bold">{t(`email.block.${b.type}` as never)}</h3>
      {b.type === 'header' && <>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={b.showLogo} onChange={(e) => onChange({ showLogo: e.target.checked })} />{t('email.showLogo')}</label>
        <Field label={t('email.headerTitle')} optional>{(p) => <Input id={p.id} value={b.title} onChange={(e) => onChange({ title: e.target.value })} />}</Field>
      </>}
      {b.type === 'text' && <>
        <Field label={t('email.text')}>{(p) => <Textarea id={p.id} value={b.text} onChange={(e) => onChange({ text: e.target.value })} />}</Field>
        <div className="flex flex-wrap gap-3">
          <Field label={t('email.size')}>{(p) => <Select id={p.id} value={b.size} onChange={(e) => onChange({ size: e.target.value as 'body' })}>{['heading', 'body', 'small'].map((k) => <option key={k} value={k}>{t(`email.sizeOpt.${k}` as never)}</option>)}</Select>}</Field>
          <Field label={t('email.align')}>{(p) => <Select id={p.id} value={b.align} onChange={(e) => onChange({ align: e.target.value as 'left' })}>{['left', 'center'].map((k) => <option key={k} value={k}>{t(`email.alignOpt.${k}` as never)}</option>)}</Select>}</Field>
        </div>
      </>}
      {b.type === 'image' && <>
        <ImageField orgId={orgId} label={t('email.image')} value={b.src} onChange={(v) => onChange({ src: v })} />
        <Field label={t('email.alt')} hint={t('email.altHint')}>{(p) => <Input id={p.id} value={b.alt} onChange={(e) => onChange({ alt: e.target.value })} />}</Field>
        <Field label={t('email.link')} optional>{(p) => <Input id={p.id} value={b.href} placeholder="https://" onChange={(e) => onChange({ href: e.target.value })} />}</Field>
      </>}
      {b.type === 'button' && <>
        <Field label={t('email.buttonLabel')}>{(p) => <Input id={p.id} value={b.label} onChange={(e) => onChange({ label: e.target.value })} />}</Field>
        <Field label={t('email.link')}>{(p) => <Input id={p.id} value={b.href} placeholder="https://" onChange={(e) => onChange({ href: e.target.value })} />}</Field>
      </>}
      {b.type === 'columns' && (['left', 'right'] as const).map((side) => (
        <div key={side} className="grid gap-2 rounded-md border border-line p-3">
          <span className="text-xs font-bold uppercase text-stone">{t(`email.${side}` as never)}</span>
          <Textarea aria-label={t('email.text')} value={b[side].text} onChange={(e) => onChange({ [side]: { ...b[side], text: e.target.value } } as never)} />
          <ImageField orgId={orgId} label={t('email.image')} value={b[side].image} onChange={(v) => onChange({ [side]: { ...b[side], image: v } } as never)} />
        </div>
      ))}
      {b.type === 'spacer' && <Field label={t('email.height')}>{(p) => <Input id={p.id} type="number" min={8} max={80} value={b.height} onChange={(e) => onChange({ height: Number(e.target.value) || 24 })} />}</Field>}
      {b.type === 'social' && <>
        {b.links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <Input value={l.network} aria-label={t('email.network')} placeholder={t('email.network')} onChange={(e) => onChange({ links: b.links.map((x, j) => (j === i ? { ...x, network: e.target.value } : x)) })} />
            <Input value={l.href} aria-label={t('email.link')} placeholder="https://" onChange={(e) => onChange({ links: b.links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)) })} />
          </div>
        ))}
        <div><Button size="sm" variant="secondary" icon="plus" onClick={() => onChange({ links: [...b.links, { network: '', href: '' }] })}>{t('email.addLink')}</Button></div>
      </>}
      {b.type === 'footer' && <>
        <Field label={t('email.footerText')} optional>{(p) => <Textarea id={p.id} value={b.text} onChange={(e) => onChange({ text: e.target.value })} />}</Field>
        <Field label={t('email.address')} hint={t('email.addressHint')} optional>{(p) => <Input id={p.id} value={b.address} onChange={(e) => onChange({ address: e.target.value })} />}</Field>
        <p className="text-xs text-stone">{t('email.unsubscribeAlways')}</p>
      </>}
      {b.type === 'divider' && <p className="text-xs text-stone">{t('email.dividerHint')}</p>}
    </div>
  );
}
