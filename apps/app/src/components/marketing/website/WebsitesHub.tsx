'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { createSection, type PageDocument } from '@bh/shared';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Toggle } from '@bh/ui';
import { PageHeader } from '@/components/shell/PageHeader';
import { Banner, Empty, ErrorState, LoadingBlock } from '@/components/ui/States';
import { mkt, useAction, useLoad, useMkt, type PageMeta, type SiteRow } from '../data';
import { ThemeGallery } from './ThemeGallery';

type Tab = 'pages' | 'theme' | 'masters' | 'navigation';

/** Starting points for a new page; content is filled in by the business in the builder. */
function starter(kind: string, t: (k: string) => string): PageDocument {
  const s = (type: Parameters<typeof createSection>[0], props: Record<string, unknown> = {}, style = {}) => createSection(type, props, style);
  switch (kind) {
    case 'about': return { schemaVersion: 1, sections: [s('hero_split', { heading: t('starter.aboutHeading') }), s('text', { heading: t('starter.storyHeading') }), s('team', { heading: t('starter.teamHeading') }, { background: 'muted' })] };
    case 'contact': return { schemaVersion: 1, sections: [s('text', { heading: t('starter.contactHeading') }), s('contact_map'), s('hours', {}, { background: 'muted' }), s('form', { heading: t('starter.formHeading') })] };
    case 'offer': return { schemaVersion: 1, sections: [s('hero', { heading: t('starter.offerHeading') }), s('features', { heading: t('starter.featuresHeading') }), s('testimonials', {}, { background: 'muted' }), s('cta', { heading: t('starter.ctaHeading') }, { background: 'brand' })] };
    case 'blank': return { schemaVersion: 1, sections: [] };
    default: return { schemaVersion: 1, sections: [s('hero', { heading: t('starter.homeHeading') }), s('features'), s('cta', { heading: t('starter.ctaHeading') }, { background: 'brand' })] };
  }
}

export function WebsitesHub() {
  const t = useTranslations('mkt');
  const fmt = useFormatter();
  const router = useRouter();
  const params = useSearchParams();
  const { orgId, can } = useMkt();
  const tab = (params.get('tab') as Tab) || 'pages';
  const setTab = (k: Tab) => router.replace(`/marketing/websites?tab=${k}`);
  const res = useLoad(orgId, (o) => mkt.sites(o));
  const homeId = res.data?.items.flatMap((w) => w.pages).find((p) => p.slug === 'home')?.id ?? null;
  const sample = useLoad(homeId && tab === 'theme' ? orgId : null, (o) => mkt.builder(o, homeId!), [homeId, tab]);
  const masters = useLoad(tab === 'masters' ? orgId : null, (o) => mkt.masters(o), [tab]);
  const [adding, setAdding] = useState<SiteRow | null>(null);
  const [navSite, setNavSite] = useState<SiteRow | null>(null);
  const [newMaster, setNewMaster] = useState(false);
  const canDesign = can('website.design');

  const tabs = useMemo(() => [
    { key: 'pages' as const, label: t('websites.tabPages') },
    { key: 'theme' as const, label: t('websites.tabTheme') },
    ...(res.data && !res.data.independent && canDesign ? [{ key: 'masters' as const, label: t('websites.tabMasters') }] : []),
  ], [t, res.data, canDesign]);

  const statusTone = (p: PageMeta) => (p.status === 'published' ? 'success' : p.status === 'pending_approval' ? 'warning' : 'neutral');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader icon="globe" title={t('websites.title')} description={t('websites.description')} />
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {res.status === 'error' && <ErrorState error={res.error} onRetry={res.reload} />}
      {!res.data && res.status === 'loading' && <LoadingBlock variant="table" />}
      {res.data && tab === 'pages' && (
        res.data.items.length === 0 ? <Empty icon="globe" title={t('websites.emptyTitle')} body={t('websites.emptyBody')} /> : (
          <div className="flex flex-col gap-4">
            {res.data.items.map((w) => (
              <section key={w.id} className="rounded-xl bg-surface p-4 md:p-5" aria-labelledby={`site-${w.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2 id={`site-${w.id}`} className="text-lg font-bold">{w.location?.name ?? t('websites.brandSite')}</h2>
                    <a href={w.includedAddress} className="text-xs text-stone underline" target="_blank" rel="noopener">{w.includedAddress}</a>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {w.kind === 'wordpress' && <Badge tone="info">{t('websites.wordpress')}</Badge>}
                    <Button size="sm" variant="secondary" icon="list" onClick={() => setNavSite(w)}>{t('websites.navigation')}</Button>
                    <Button size="sm" icon="plus" onClick={() => setAdding(w)}>{t('websites.addPage')}</Button>
                  </div>
                </div>
                <ul className="mt-3 divide-y divide-line-soft" role="list">
                  {w.pages.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                      <Icon name={p.slug === 'home' ? 'home' : 'file'} size={18} className="text-stone" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><span className="font-bold">{p.title}</span>{p.templateId && <Badge tone="neutral" icon="lock">{t('websites.fromHq')}</Badge>}{!p.showInNav && <Badge tone="neutral">{t('websites.hiddenInNav')}</Badge>}</div>
                        <div className="text-xs text-stone">/{p.slug === 'home' ? '' : p.slug} · {t('websites.updated', { when: fmt.relativeTime(new Date(p.updatedAt)) })}{p.scheduledPublishAt ? ` · ${t('websites.scheduledFor', { at: fmt.dateTime(new Date(p.scheduledPublishAt), { dateStyle: 'medium', timeStyle: 'short' }) })}` : ''}</div>
                      </div>
                      {p.pendingApprovals ? <Badge tone="warning">{t('websites.pendingApprovals', { n: p.pendingApprovals })}</Badge> : null}
                      <Badge tone={statusTone(p)}>{t(`status.${p.status}` as never)}</Badge>
                      <Link href={`/marketing/websites/${p.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white hover:bg-ink-2"><Icon name="edit" size={14} />{t('websites.edit')}</Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )
      )}
      {res.data && tab === 'theme' && orgId && (
        sample.status === 'loading' && homeId ? <LoadingBlock variant="cards" /> :
          <ThemeGallery orgId={orgId} theme={res.data.theme} industry={res.data.industry} sample={sample.data ?? null} canDesign={canDesign} onSaved={(th) => res.set({ ...res.data!, theme: th })} />
      )}
      {res.data && tab === 'masters' && orgId && (
        <div className="flex flex-col gap-3">
          <Banner tone="info" icon="lock" title={t('masters.title')}>{t('masters.body')}</Banner>
          <div><Button icon="plus" onClick={() => setNewMaster(true)}>{t('masters.create')}</Button></div>
          {masters.status === 'error' && <ErrorState error={masters.error} onRetry={masters.reload} />}
          {masters.data && (masters.data.items.length === 0 ? <Empty icon="layers" title={t('masters.emptyTitle')} body={t('masters.emptyBody')} /> : (
            <ul className="grid gap-3 md:grid-cols-2" role="list">
              {masters.data.items.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface p-4">
                  <div><div className="font-bold">{m.name}</div><div className="text-xs text-stone">/{m.pageSlug} · {t('masters.linked', { n: m.pageCount })} · {t('masters.sections', { n: m.document.sections.length })}</div></div>
                  <Link href={`/marketing/websites/masters/${m.id}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white"><Icon name="edit" size={14} />{t('websites.edit')}</Link>
                </li>
              ))}
            </ul>
          ))}
        </div>
      )}
      {adding && orgId && <AddPageDrawer orgId={orgId} site={adding} onClose={() => setAdding(null)} onCreated={(p) => router.push(`/marketing/websites/${p.id}`)} />}
      {navSite && orgId && <NavDrawer orgId={orgId} site={navSite} onClose={() => setNavSite(null)} onSaved={() => { setNavSite(null); res.reload(); }} />}
      {newMaster && orgId && <NewMasterDrawer orgId={orgId} onClose={() => setNewMaster(false)} onCreated={(id) => router.push(`/marketing/websites/masters/${id}`)} />}
    </div>
  );
}

function AddPageDrawer({ orgId, site, onClose, onCreated }: { orgId: string; site: SiteRow; onClose: () => void; onCreated: (p: PageMeta) => void }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('home');
  return (
    <Drawer open onClose={onClose} title={t('websites.addPage')} kicker={site.location?.name ?? t('websites.brandSite')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!title.trim()} onClick={async () => { const p = await a.run(() => mkt.addPage(orgId, site.id, { title: title.trim(), document: starter(kind, (k) => t(k as never)) })); if (p) onCreated(p); }}>{t('websites.create')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('settings.pageTitle')} error={a.error?.fields?.slug}>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />}</Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-bold">{t('websites.startWith')}</legend>
          {['home', 'about', 'contact', 'offer', 'blank'].map((k) => (
            <label key={k} className="flex min-h-11 items-center gap-3 rounded-md border border-line px-3 has-[:checked]:border-ink"><input type="radio" name="starter" value={k} checked={kind === k} onChange={() => setKind(k)} />{t(`starter.${k}` as never)}</label>
          ))}
        </fieldset>
      </div>
    </Drawer>
  );
}

function NavDrawer({ orgId, site, onClose, onSaved }: { orgId: string; site: SiteRow; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [rows, setRows] = useState(site.pages.filter((p) => p.slug !== 'home').sort((x, y) => x.navOrder - y.navOrder).map((p) => ({ id: p.id, title: p.title, navLabel: p.navLabel ?? '', showInNav: p.showInNav })));
  const [links, setLinks] = useState(site.navLinks);
  const move = (i: number, d: -1 | 1) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  return (
    <Drawer open onClose={onClose} title={t('websites.navigation')} kicker={site.location?.name ?? t('websites.brandSite')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} onClick={async () => { const r = await a.run(() => mkt.nav(orgId, site.id, { pages: rows.map((x, i) => ({ id: x.id, navLabel: x.navLabel || null, showInNav: x.showInNav, navOrder: i + 1 })), links: links.filter((l) => l.label && l.href) })); if (r) onSaved(); }}>{t('common.save')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <p className="text-sm text-stone">{t('websites.navHint')}</p>
        <ul className="flex flex-col gap-2" role="list">
          {rows.map((r, i) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
              <div className="flex flex-col">
                <button type="button" className="rounded p-1 hover:bg-canvas disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('common.moveUp')}><Icon name="chevron-down" size={16} className="rotate-180" /></button>
                <button type="button" className="rounded p-1 hover:bg-canvas disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={t('common.moveDown')}><Icon name="chevron-down" size={16} /></button>
              </div>
              <Input className="min-w-0 flex-1" value={r.navLabel} placeholder={r.title} aria-label={t('settings.navLabel')} onChange={(e) => setRows((x) => x.map((y) => (y.id === r.id ? { ...y, navLabel: e.target.value } : y)))} />
              <Toggle checked={r.showInNav} label={t('settings.showInNav')} onChange={(v) => setRows((x) => x.map((y) => (y.id === r.id ? { ...y, showInNav: v } : y)))} />
            </li>
          ))}
        </ul>
        <h3 className="text-sm font-bold">{t('websites.extraLinks')}</h3>
        {links.map((l, i) => (
          <div key={i} className="flex gap-2">
            <Input value={l.label} placeholder={t('websites.linkLabel')} aria-label={t('websites.linkLabel')} onChange={(e) => setLinks((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
            <Input value={l.href} placeholder="https://" aria-label={t('websites.linkUrl')} onChange={(e) => setLinks((x) => x.map((y, j) => (j === i ? { ...y, href: e.target.value } : y)))} />
            <Button variant="ghost" icon="x" aria-label={t('common.remove')} onClick={() => setLinks((x) => x.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div><Button size="sm" variant="secondary" icon="plus" disabled={links.length >= 12} onClick={() => setLinks((x) => [...x, { label: '', href: '' }])}>{t('websites.addLink')}</Button></div>
      </div>
    </Drawer>
  );
}

function NewMasterDrawer({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('mkt');
  const a = useAction();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('home');
  return (
    <Drawer open onClose={onClose} title={t('masters.create')} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={a.pending} disabled={!name.trim()} onClick={async () => { const m = await a.run(() => mkt.createMaster(orgId, { name: name.trim(), pageSlug: slug, document: starter(slug === 'home' ? 'home' : 'about', (k) => t(k as never)) })); if (m) onCreated(m.id); }}>{t('websites.create')}</Button></div>}>
      <div className="flex flex-col gap-4">
        {a.error && <Banner tone="danger">{a.error.message}</Banner>}
        <Field label={t('masters.name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        <Field label={t('masters.pageSlug')} hint={t('masters.pageSlugHint')}>{(p) => <Select id={p.id} value={slug} onChange={(e) => setSlug(e.target.value)}>{['home', 'about', 'contact', 'offers'].map((s) => <option key={s} value={s}>/{s}</option>)}</Select>}</Field>
      </div>
    </Drawer>
  );
}
