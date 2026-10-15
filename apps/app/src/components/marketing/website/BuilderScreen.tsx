'use client';

import '@puckeditor/core/puck.css';
import '@bh/ui/site.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Puck, createUsePuck, type Config, type Data, type Dictionary } from '@puckeditor/core';
import { googleFontsHref, resolveTheme, type PageDocument, type SiteFont } from '@bh/shared';
import { Badge, Button, Icon } from '@bh/ui';
import { Banner, ErrorState, LoadingBlock } from '@/components/ui/States';
import { ApiError } from '@/lib/errors';
import { useLocalizeError } from '@/lib/useErrorText';
import { mkt, useLoad, useMkt, type BuilderData, type MasterDetail } from '../data';
import { buildConfig, fromPuck, toPuck, type SectionMeta } from './puckConfig';
import { previewContext, useSiteLabels } from './siteLabels';
import { HistoryDrawer, PageSettingsDrawer, PublishDrawer, ApplyMasterDrawer } from './BuilderDrawers';

const usePuck = createUsePuck();

type Mode = { kind: 'page'; data: BuilderData } | { kind: 'master'; data: MasterDetail };
type SaveState = 'saved' | 'saving' | 'dirty' | 'conflict' | 'error';

export function BuilderScreen({ pageId, masterId }: { pageId?: string; masterId?: string }) {
  const { orgId } = useMkt();
  const t = useTranslations('mkt');
  const res = useLoad<{ mode: Mode; forms: Array<{ id: string; name: string }> }>(orgId, async (o) => {
    const [mode, forms] = await Promise.all([
      pageId ? mkt.builder(o, pageId).then((data) => ({ kind: 'page' as const, data })) : mkt.master(o, masterId!).then((data) => ({ kind: 'master' as const, data })),
      mkt.forms(o).then((r) => r.items.filter((f) => f.status === 'published').map((f) => ({ id: f.id, name: f.name }))).catch(() => []),
    ]);
    return { mode, forms };
  }, [pageId, masterId]);

  if (res.status === 'error') return <div className="p-4"><ErrorState error={res.error} onRetry={res.reload} /></div>;
  if (!res.data || !orgId) return <div className="p-4"><LoadingBlock variant="detail" label={t('common.loading')} /></div>;
  return <Editor key={res.data.mode.kind === 'page' ? res.data.mode.data.page.revision : res.data.mode.data.version} orgId={orgId} mode={res.data.mode} forms={res.data.forms} reload={res.reload} />;
}

function Editor({ orgId, mode, forms, reload }: { orgId: string; mode: Mode; forms: Array<{ id: string; name: string }>; reload: () => void }) {
  const t = useTranslations('mkt');
  const locale = useLocale();
  const labels = useSiteLabels();
  const master = mode.kind === 'master';
  const themeSettings = mode.data.theme;
  const theme = useMemo(() => resolveTheme(themeSettings.themeId, { colorMode: themeSettings.colorMode, primaryColor: themeSettings.primaryColor, accentColor: themeSettings.accentColor, headingFont: themeSettings.headingFont as SiteFont | null, bodyFont: themeSettings.bodyFont as SiteFont | null }), [themeSettings]);
  const ctx = useMemo(() => previewContext(mode.kind === 'page' ? mode.data : { brandName: mode.data.brandName, location: null }, mode.kind === 'page' ? mode.data.location?.locale ?? mode.data.defaultLocale : mode.data.defaultLocale), [mode]);
  const canHq = master || (mode.kind === 'page' && mode.data.permissions.canHq);
  const config = useMemo<Config>(() => buildConfig({ t: (k, v) => t(k as never, v as never), theme, ctx, labels, forms, orgId, master, canHq, industry: mode.data.industry }), [t, theme, ctx, labels, forms, orgId, master, canHq, mode.data.industry]);
  const initial = useMemo(() => toPuck(mode.kind === 'page' ? mode.data.document : mode.data.document), [mode]);
  const dictionary = usePuckDictionary();

  // Theme fonts for the canvas (the iframe copies stylesheets from this document).
  useEffect(() => {
    const href = googleFontsHref([theme.fonts.heading, theme.fonts.body]);
    if (!href) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.bhBuilderFonts = '1';
    document.head.appendChild(link);
    return () => link.remove();
  }, [theme.fonts.heading, theme.fonts.body]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas" data-builder>
      <Puck
        config={config}
        data={initial}
        dictionary={dictionary}
        iframe={{ enabled: true, waitForStyles: true }}
        viewports={[{ width: 390, label: t('builder.phone'), icon: 'Smartphone' }, { width: 834, label: t('builder.tablet'), icon: 'Tablet' }, { width: 1440, label: t('builder.desktop'), icon: 'Monitor' }]}
        overrides={{ header: () => <Toolbar orgId={orgId} mode={mode} reload={reload} /> }}
        height="100%"
      />
    </div>
  );
}

/** Builder header: navigation, autosave, undo/redo, governance notices and publishing. */
function Toolbar({ orgId, mode, reload }: { orgId: string; mode: Mode; reload: () => void }) {
  const t = useTranslations('mkt');
  const localize = useLocalizeError();
  const data = usePuck((s) => s.appState.data);
  const dispatch = usePuck((s) => s.dispatch);
  const history = usePuck((s) => s.history);
  const selected = usePuck((s) => s.selectedItem);
  const master = mode.kind === 'master';
  const rev = useRef(mode.kind === 'page' ? mode.data.page.revision : mode.data.version);
  const last = useRef(JSON.stringify(fromPuck(data, { master })));
  const [state, setState] = useState<SaveState>('saved');
  const [notice, setNotice] = useState<{ tone: 'warning' | 'success' | 'info' | 'danger'; text: string } | null>(null);
  const [drawer, setDrawer] = useState<null | 'settings' | 'history' | 'publish' | 'apply'>(null);
  const [page, setPage] = useState(mode.kind === 'page' ? mode.data.page : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const save = useCallback(async (checkpoint = false) => {
    const doc = fromPuck(data, { master });
    const json = JSON.stringify(doc);
    if (json === last.current && !checkpoint) { setState('saved'); return; }
    setState('saving');
    try {
      if (mode.kind === 'page') {
        const r = await mkt.saveDocument(orgId, mode.data.page.id, doc, rev.current, checkpoint);
        rev.current = r.revision;
        last.current = JSON.stringify(r.document);
        if (r.rejected.length || r.pendingApprovals.length) {
          // The server kept HQ's version of locked sections and parked approval changes: show what is stored.
          dispatch({ type: 'setData', data: (prev: Data) => ({ ...prev, content: toPuck(r.document).content }) } as never);
          setNotice(r.rejected.length ? { tone: 'warning', text: t('gov.rejectedNotice', { n: r.rejected.length }) } : { tone: 'info', text: t('gov.pendingNotice', { n: r.pendingApprovals.length }) });
        }
        setPage((p) => (p ? { ...p, revision: r.revision, status: p.status === 'published' ? 'draft' : p.status } : p));
      } else {
        const r = await mkt.saveMaster(orgId, mode.data.id, doc, rev.current);
        rev.current = r.master.version;
        last.current = json;
        if (r.affected.pages) setNotice({ tone: 'info', text: t('masters.synced', { n: r.affected.pages }) });
      }
      setState('saved');
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('unknown_error', String(e));
      if (err.code === 'revision_conflict') { setState('conflict'); return; }
      setState('error');
      setNotice({ tone: 'danger', text: localize(err).message });
    }
  }, [data, dispatch, localize, master, mode, orgId, t]);

  // Autosave 1.2 s after the last change.
  useEffect(() => {
    const json = JSON.stringify(fromPuck(data, { master }));
    if (json === last.current) return;
    setState((s) => (s === 'conflict' ? s : 'dirty'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (!inflight.current) inflight.current = save().finally(() => { inflight.current = null; }); }, 1200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [data, master, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (state === 'dirty' || state === 'saving') e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  const flush = async () => { if (timer.current) clearTimeout(timer.current); await (inflight.current ?? save()); };
  const selMeta = ((selected?.props as Record<string, unknown> | undefined)?._meta ?? {}) as SectionMeta;
  const canReset = mode.kind === 'page' && !!selected && selMeta.origin === 'local' && !!selMeta.masterId;
  const status = page ? (page.scheduledPublishAt ? 'scheduled' : page.status) : null;

  return (
    <div className="flex flex-col gap-2 border-b border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={master ? '/marketing/websites?tab=masters' : '/marketing/websites'} className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-bold hover:bg-canvas" onClick={() => void flush()}>
          <Icon name="arrow-left" size={16} />{t('builder.back')}
        </Link>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold">{mode.kind === 'page' ? mode.data.page.title : mode.data.name}</div>
          <div className="truncate text-xs text-stone">{mode.kind === 'page' ? (mode.data.location?.name ?? mode.data.brandName) : t('masters.kicker')}</div>
        </div>
        {status && <Badge tone={status === 'published' ? 'success' : status === 'pending_approval' ? 'warning' : 'neutral'}>{t(`status.${status}` as never)}</Badge>}
        <span className="text-xs font-semibold text-stone" role="status" aria-live="polite">{t(`builder.save.${state}`)}</span>
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" icon="undo" disabled={!history.hasPast} onClick={() => history.back()} aria-label={t('builder.undo')}>{t('builder.undo')}</Button>
          <Button size="sm" variant="ghost" icon="refresh" disabled={!history.hasFuture} onClick={() => history.forward()} aria-label={t('builder.redo')}>{t('builder.redo')}</Button>
          {canReset && <Button size="sm" variant="secondary" icon="undo" onClick={async () => {
            await flush();
            const r = await mkt.resetSection(orgId, mode.data.page.id, selected!.props.id as string, rev.current).catch((e: ApiError) => { setNotice({ tone: 'danger', text: localize(e).message }); return null; });
            if (r) { rev.current = r.revision; last.current = JSON.stringify(r.document); dispatch({ type: 'setData', data: (prev: Data) => ({ ...prev, content: toPuck(r.document).content }) } as never); }
          }}>{t('gov.reset')}</Button>}
          {mode.kind === 'page' && <>
            <Button size="sm" variant="secondary" icon="settings" onClick={() => setDrawer('settings')}>{t('builder.pageSettings')}</Button>
            <Button size="sm" variant="secondary" icon="clock" onClick={async () => { await flush(); setDrawer('history'); }}>{t('builder.history')}</Button>
            {page?.publishedAt && <a className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-bold hover:border-ink" href={mode.data.publicUrl} target="_blank" rel="noopener">{t('builder.viewLive')}<Icon name="arrow-up-right" size={14} /></a>}
            <Button size="sm" variant="signal" icon="send" onClick={async () => { await flush(); setDrawer('publish'); }}>{t('builder.publish')}</Button>
          </>}
          {mode.kind === 'master' && <>
            <Button size="sm" variant="secondary" icon="check" onClick={() => void flush()}>{t('builder.saveNow')}</Button>
            <Button size="sm" variant="signal" icon="share" onClick={async () => { await flush(); setDrawer('apply'); }}>{t('masters.apply')}</Button>
          </>}
        </div>
      </div>
      {mode.kind === 'page' && mode.data.permissions.governed && <p className="text-xs text-stone"><Icon name="lock" size={12} className="me-1 inline" />{t('gov.explainer')}</p>}
      {master && <p className="text-xs text-stone"><Icon name="lock" size={12} className="me-1 inline" />{t('masters.explainer')}</p>}
      {state === 'conflict' && <Banner tone="warning" title={t('builder.conflictTitle')} action={<Button size="sm" variant="secondary" onClick={reload}>{t('builder.reload')}</Button>}>{t('builder.conflictBody')}</Banner>}
      {notice && <Banner tone={notice.tone} live="polite" action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)} aria-label={t('common.dismiss')}>{t('common.dismiss')}</Button>}>{notice.text}</Banner>}
      {mode.kind === 'page' && page && (
        <>
          <PageSettingsDrawer open={drawer === 'settings'} onClose={() => setDrawer(null)} orgId={orgId} page={page} onSaved={(p) => setPage(p)} />
          <HistoryDrawer open={drawer === 'history'} onClose={() => setDrawer(null)} orgId={orgId} pageId={page.id} baseRevision={() => rev.current} onRestored={(doc: PageDocument, revision: number) => { rev.current = revision; last.current = JSON.stringify(doc); dispatch({ type: 'setData', data: (prev: Data) => ({ ...prev, content: toPuck(doc).content }) } as never); }} />
          <PublishDrawer open={drawer === 'publish'} onClose={() => setDrawer(null)} orgId={orgId} page={page} permissions={mode.data.permissions} independent={mode.data.independent} onChanged={(p) => setPage(p)} />
        </>
      )}
      {mode.kind === 'master' && <ApplyMasterDrawer open={drawer === 'apply'} onClose={() => setDrawer(null)} orgId={orgId} master={mode.data} />}
    </div>
  );
}

/** Puck's own UI strings in the dashboard language. */
function usePuckDictionary(): Dictionary {
  const t = useTranslations('mkt.puck');
  return useMemo(() => ({
    'header-publish': t('publish'), 'header-undo': t('undo'), 'header-redo': t('redo'),
    'header-toggle-leftsidebar': t('toggleLeft'), 'header-toggle-rightsidebar': t('toggleRight'),
    'action-selectparent': t('selectParent'), 'action-duplicate': t('duplicate'), 'action-delete': t('delete'),
    'label-page': t('page'), 'label-component': t('section'), 'outline-empty': t('outlineEmpty'), 'outline-header-title': t('outline'),
    'outline-item-duplicate': t('duplicate'), 'outline-item-delete': t('delete'), 'drawer-category-other': t('other'),
    'field-readonly': t('readOnly'), 'field-arrayitem-duplicate': t('duplicate'), 'field-arrayitem-delete': t('delete'),
    'viewport-zoom-in': t('zoomIn'), 'viewport-zoom-out': t('zoomOut'), 'viewport-switch-default': t('switchViewport'),
    'plugin-blocks': t('blocks'), 'plugin-outline': t('outline'), 'plugin-fields': t('fields'), 'plugin-components': t('blocks'), 'loader-loading': t('loading'),
  }), [t]);
}
