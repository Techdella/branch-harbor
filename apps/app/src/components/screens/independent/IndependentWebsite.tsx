'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Input, Tabs, cx } from '@bh/ui';
import type { WebsitePage } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { useBusinessMode } from '@/lib/useBusinessMode';
import { relativeTime } from '@/lib/format';
import { INDUSTRY_UI } from '@/lib/nav';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { Approvals, Domains } from '../WebsitesScreen';
import { useTxt } from '../../ui/useDataText';

type Tab = 'editor' | 'approvals' | 'domains';

/**
 * Website for an independent business: one site (the business's), plain editable content and a single
 * "Publish" button. No locked/approval fields, HQ/local origin tags or group publishing. Approvals appear only
 * when the owner turned them on for staff (Settings → Website approvals).
 */
export function IndependentWebsite() {
  const t = useTranslations('single.website');
  const tw = useTranslations('websites');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const approvals = useApi((api) => api.business.approvals(app.ctx), [app.industry, app.org.id]);
  const withApprovals = approvals.status === 'ready' && approvals.data === 'staff';
  const tabs: { key: Tab; label: string }[] = [
    { key: 'editor', label: t('tab.content') },
    ...(withApprovals ? [{ key: 'approvals' as Tab, label: tw('tab.approvals') }] : []),
    { key: 'domains', label: tw('tab.domains') },
  ];
  const requested = (params.get('tab') as Tab) || 'editor';
  const tab = tabs.some((x) => x.key === requested) ? requested : 'editor';
  return (
    <>
      <PageHeader icon="globe" title={t('title')} description={t('description')} scope={false} />
      <Tabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} className="self-start bg-surface" />
      {tab === 'approvals' ? <Approvals onOpen={() => router.replace('?tab=editor', { scroll: false })} /> : tab === 'domains' ? <Domains /> : <Editor withApprovals={withApprovals} />}
    </>
  );
}

function Editor({ withApprovals }: { withApprovals: boolean }) {
  const t = useTranslations('single.website');
  const tt = useTxt();
  const locale = useLocale();
  const app = useApp();
  const mode = useBusinessMode();
  const lid = mode.location?.id ?? '';
  const page = useApi((api) => api.websites.page(app.ctx, lid), [app.industry, app.org.id, lid], !!lid);
  const site = useApi((api) => api.business.site(app.ctx), [app.industry, app.org.id]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState('');
  const save = useMutation((api, key: string, value: string) => api.websites.saveField(lid, key, value));
  const publish = useMutation((api) => api.business.publish(app.ctx));
  const canPublish = app.can('website.publish') && (!withApprovals || app.role === 'hq');
  const isOwner = app.role === 'hq';

  const doPublish = async () => {
    setToast('');
    const s = await publish.run();
    if (s) {
      site.setData(s);
      page.reload();
      setToast(t('published', { address: s.address }));
    }
  };

  const status = site.status === 'ready' ? site.data : null;

  return (
    <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-stone">{t('yourSite')}</div>
            <div className="truncate text-lg font-bold">{mode.businessName}</div>
            {status?.address && <a href={status.address} target="_blank" rel="noreferrer" className="truncate font-mono text-xs text-stone underline">{status.address}</a>}
          </div>
          {status && (
            <Badge tone={status.published && status.visible ? 'success' : 'neutral'} icon={status.published && status.visible ? 'globe' : 'edit'}>
              {status.published && status.visible ? t('live', { version: status.version }) : t('notLive')}
            </Badge>
          )}
        </div>
        {toast && <Banner tone="success" live="polite">{toast}</Banner>}
        {[save.error, publish.error].filter(Boolean).map((e) => (
          <Banner key={e!.code} tone="danger" live="assertive">{e!.message}</Banner>
        ))}
        {withApprovals && !isOwner && <Banner tone="info" icon="shield">{t('approvalsOnStaff')}</Banner>}
        {page.status === 'error' && page.error.status === 404 ? (
          <Empty icon="globe" title={t('noSiteTitle')} body={t('noSiteBody')} action={canPublish ? <Button icon="globe" loading={publish.pending} onClick={doPublish}>{t('createAndPublish')}</Button> : undefined} />
        ) : (
        <Async res={page} loading={<LoadingBlock variant="detail" rows={3} />}>
          {(p: WebsitePage) => (
            <div className="flex flex-col gap-2.5">
              {p.fields.map((f0) => {
                const f = { ...f0, label: tt(f0.label, f0.labelMsg) };
                const isEditing = editing === f.key;
                return (
                  <div key={f.key} className={cx('flex flex-col gap-2 rounded-[20px] border-[1.5px] p-3.5', isEditing ? 'border-ink' : f.pending ? 'border-[#E7C66B]' : 'border-line-soft')}>
                    <span className="text-[13px] font-bold">{f.label}</span>
                    {isEditing ? (
                      <>
                        <Input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={f.label} className="border-ink" />
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            loading={save.pending}
                            onClick={async () => {
                              const r = await save.run(f.key, draft);
                              if (r) {
                                page.setData(r);
                                setEditing(null);
                                setToast(r.fields.find((x) => x.key === f.key)?.pending ? t('sentToOwner', { field: f.label }) : t('savedDraft', { field: f.label }));
                              }
                            }}
                          >
                            {t('save')}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>{t('cancel')}</Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={cx('text-sm', f.value ? 'text-graphite' : 'italic text-mute')}>{f.value || t('empty')}</span>
                        {!f.pending && (
                          <Button size="sm" variant="secondary" icon="edit" onClick={() => (setEditing(f.key), setDraft(f.value), setToast(''))}>
                            {t('edit')}
                          </Button>
                        )}
                      </div>
                    )}
                    {f.pending && (
                      <div className="rounded-[14px] bg-warning-bg px-3 py-2.5 text-xs leading-normal text-warning">
                        <strong>{t('pending')}</strong> “{f.pending.value}” · {f.pending.requestedBy} · {relativeTime(f.pending.at, locale)}
                      </div>
                    )}
                  </div>
                );
              })}
              {p.fields.length === 0 && <p className="rounded-md bg-canvas p-4 text-sm text-stone">{t('noFields')}</p>}
            </div>
          )}
        </Async>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          {canPublish ? (
            <Button variant="signal" icon="globe" loading={publish.pending} onClick={doPublish} data-testid="publish-site">
              {t('publish')}
            </Button>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-stone"><Icon name="lock" size={13} />{withApprovals ? t('ownerPublishes') : t('noPublishPermission')}</span>
          )}
          <span className="text-xs text-stone">{t('publishNote')}</span>
        </div>
      </section>
      <div className="flex flex-col gap-3">
        <div className="rounded-xl p-3.5" style={{ background: INDUSTRY_UI[app.industry].pastel }}>
          <div className="overflow-hidden rounded-card bg-surface">
            <div className="flex items-center gap-1.5 border-b border-line-soft px-3.5 py-2.5 text-xs text-stone">
              <Icon name="eye" size={14} />
              {t('preview')}
            </div>
            <div className="flex flex-col gap-2.5 p-5">
              <div className="text-xs font-bold text-stone">{mode.businessName}</div>
              {page.status === 'ready' && (
                <>
                  <div className="text-[26px] font-extrabold leading-tight tracking-tight">{(editing === page.data.fields[0]?.key ? draft : page.data.fields[0]?.value) || mode.businessName}</div>
                  {page.data.fields.slice(1).map((f) => (
                    <div key={f.key} className="text-sm text-graphite">{editing === f.key ? draft : f.value}</div>
                  ))}
                </>
              )}
              <div className="flex flex-wrap gap-2 text-xs">
                {mode.location?.hours && <span className="flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1.5"><Icon name="clock" size={12} />{mode.location.hours}</span>}
                {mode.location?.phone && <span className="flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1.5"><Icon name="phone" size={12} />{mode.location.phone}</span>}
              </div>
            </div>
          </div>
        </div>
        <section className="rounded-xl bg-surface p-5 text-sm">
          <h3 className="mb-1.5 text-base font-bold">{t('detailsTitle')}</h3>
          <p className="text-stone">{t('detailsBody')}</p>
          <Link href="/settings#business" className="mt-2 inline-flex items-center gap-1 text-sm font-bold underline">{t('detailsLink')}<Icon name="arrow-right" size={14} /></Link>
        </section>
        {page.status === 'ready' && page.data.activity.length > 0 && (
          <section className="rounded-xl bg-surface p-5">
            <h3 className="mb-2.5 text-base font-bold">{t('activity')}</h3>
            <ol className="flex flex-col gap-1.5">
              {page.data.activity.slice(0, 6).map((a, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
                  <span className="w-20 shrink-0 text-stone">{relativeTime(a.at, locale)}</span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
}
