'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Icon, Input, Tabs, cx } from '@bh/ui';
import type { GroupPublish, PublishTarget, WebsiteField, WebsitePage } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { relativeTime } from '@/lib/format';
import { INDUSTRY_UI } from '@/lib/nav';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { useScopeLabel } from '../shell/ScopePicker';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { IndependentWebsite } from './independent/IndependentWebsite';

type Tab = 'editor' | 'approvals' | 'publish' | 'domains';

export function WebsitesScreen() {
  const t = useTranslations('websites');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'editor';
  const setTab = (k: Tab) => router.replace(`?tab=${k}`, { scroll: false });
  if (!app.can('website.edit')) return <DeniedState permission="website.edit" />;
  // Independent businesses: one site, no templates/origin tags/group publish — a single "Publish" flow.
  if (app.org.model === 'independent') return <IndependentWebsite />;
  const tabs: { key: Tab; label: string }[] = [
    { key: 'editor', label: t('tab.editor') },
    { key: 'approvals', label: t('tab.approvals') },
    ...(app.role === 'hq' ? [{ key: 'publish' as Tab, label: t('tab.publish') }] : []),
    { key: 'domains', label: t('tab.domains') },
  ];
  return (
    <>
      <PageHeader icon="globe" title={t('title')} description={t('description')} />
      <Tabs items={tabs} value={tabs.some((x) => x.key === tab) ? tab : 'editor'} onChange={(k) => setTab(k as Tab)} className="self-start bg-surface" />
      {tab === 'approvals' ? <Approvals onOpen={() => setTab('editor')} /> : tab === 'publish' && app.role === 'hq' ? <Publish /> : tab === 'domains' ? <Domains /> : <Editor />}
    </>
  );
}

/* ------------------------------ Editor (scenario 5) ------------------------------ */

function Editor() {
  const t = useTranslations('websites');
  const locale = useLocale();
  const app = useApp();
  const locs = app.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const preferred = locs.find((l) => l.id === 'ls') ?? locs[0];
  const [locId, setLocId] = useState(preferred?.id ?? '');
  const lid = locs.some((l) => l.id === locId) ? locId : (preferred?.id ?? '');
  const res = useApi((api) => api.websites.page(app.ctx, lid), [app.industry, app.role, lid]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [hqComment, setHqComment] = useState('');
  const [toast, setToast] = useState('');
  const save = useMutation((api, key: string, value: string) => api.websites.saveField(lid, key, value));
  const request = useMutation((api, key: string, value: string, why: string) => api.websites.requestChange(lid, key, value, why));
  const decide = useMutation((api, key: string, d: 'approve' | 'reject', c: string) => api.websites.decide(lid, key, d, c));
  const reset = useMutation((api, key: string) => api.websites.resetField(lid, key));
  const isHq = app.role === 'hq';
  const brand = app.org.brand;

  const apply = (p: WebsitePage | undefined, msg: string) => {
    if (!p) return;
    res.setData(p);
    setEditing(null);
    setToast(msg);
    setHqComment('');
  };

  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(page) => {
        const preview = (k: string) => (editing === k ? draft : (page.fields.find((f) => f.key === k)?.value ?? ''));
        return (
          <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
            <section className="flex flex-col gap-2.5 rounded-xl bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs text-stone">{t('pageVersion', { page: page.page, version: page.version })}</div>
                  <label className="flex items-center gap-1 text-lg font-bold">
                    <span className="sr-only">{t('location')}</span>
                    <select value={lid} onChange={(e) => (setLocId(e.target.value), setEditing(null), setToast(''))} className="max-w-[260px] appearance-none bg-transparent font-bold focus:outline-none">
                      {locs.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <Icon name="chevron-down" size={14} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1.5" aria-label={t('legend')}>
                  <PolicyPill policy="locked" />
                  <PolicyPill policy="editable" />
                  <PolicyPill policy="approval" />
                </div>
              </div>
              {toast && <Banner tone="success" live="polite">{toast}</Banner>}
              {[save.error, request.error, decide.error, reset.error].filter(Boolean).map((e) => (
                <Banner key={e!.code} tone="danger" live="assertive">
                  {e!.message}
                </Banner>
              ))}
              {page.fields.map((f) => {
                const isEditing = editing === f.key;
                const overridden = f.hqValue != null && f.value !== f.hqValue;
                const needsApproval = !isHq && f.policy === 'approval';
                const canEdit = !f.pending && (isHq || f.policy !== 'locked');
                return (
                  <div key={f.key} className={cx('flex flex-col gap-2 rounded-[20px] border-[1.5px] p-3.5', isEditing ? 'border-ink' : f.pending ? 'border-[#E7C66B]' : 'border-line-soft')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-bold">{f.label}</span>
                      <FieldOrigin f={f} overridden={overridden} />
                    </div>
                    {isEditing ? (
                      <>
                        <Input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={f.label} className="border-ink" />
                        {needsApproval && (
                          <>
                            <label htmlFor={`reason-${f.key}`} className="text-xs font-bold">
                              {t('reasonLabel')}
                            </label>
                            <Input id={`reason-${f.key}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reasonPh')} />
                          </>
                        )}
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            disabled={!draft.trim() || (needsApproval && !reason.trim())}
                            loading={save.pending || request.pending}
                            onClick={async () =>
                              needsApproval
                                ? apply(await request.run(f.key, draft, reason), t('sentForApproval', { field: f.label }))
                                : apply(await save.run(f.key, draft), t('savedDraft', { field: f.label }))
                            }
                          >
                            {needsApproval ? t('submitApproval') : t('save')}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                            {t('cancel')}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm text-graphite">{f.value}</span>
                        <span className="flex gap-1.5">
                          {canEdit && (
                            <Button size="sm" variant="secondary" icon={needsApproval ? 'shield' : 'edit'} onClick={() => (setEditing(f.key), setDraft(f.value), setReason(''), setToast(''))}>
                              {needsApproval ? t('requestChange') : t('edit')}
                            </Button>
                          )}
                          {!canEdit && f.policy === 'locked' && !isHq && (
                            <span className="flex items-center gap-1 text-xs text-stone">
                              <Icon name="lock" size={12} />
                              {t('lockedHint')}
                            </span>
                          )}
                          {overridden && !f.pending && (
                            <Button size="sm" variant="ghost" icon="undo" loading={reset.pending} onClick={async () => apply(await reset.run(f.key), t('resetDone', { field: f.label }))}>
                              {t('resetToHq')}
                            </Button>
                          )}
                        </span>
                      </div>
                    )}
                    {overridden && !isEditing && <p className="text-xs text-stone">{t('hqDefault', { value: f.hqValue ?? '' })}</p>}
                    {f.pending && (
                      <>
                        <div className="rounded-[14px] bg-warning-bg px-3 py-2.5 text-xs leading-normal text-warning">
                          <strong>{t('pendingLabel')}</strong> “{f.pending.value}”
                          <br />
                          {t('pendingReason', { reason: f.pending.reason, who: f.pending.requestedBy, when: relativeTime(f.pending.at, locale) })}
                        </div>
                        {isHq ? (
                          <div className="flex flex-wrap gap-1.5">
                            <label className="sr-only" htmlFor={`hqc-${f.key}`}>
                              {t('hqComment')}
                            </label>
                            <input id={`hqc-${f.key}`} value={hqComment} onChange={(e) => setHqComment(e.target.value)} placeholder={t('hqComment')} className="h-9 min-w-[140px] flex-1 rounded-full border-[1.5px] border-line-soft px-3.5 text-xs" />
                            <Button size="sm" loading={decide.pending} onClick={async () => apply(await decide.run(f.key, 'approve', hqComment), t('approvedMsg', { field: f.label, location: page.locationName }))}>
                              {t('approve')}
                            </Button>
                            <Button size="sm" variant="secondary" onClick={async () => apply(await decide.run(f.key, 'reject', hqComment), t('rejectedMsg', { who: f.pending!.requestedBy }))}>
                              {t('reject')}
                            </Button>
                          </div>
                        ) : (
                          <p className="text-xs text-stone">{t('liveUnchanged')}</p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </section>
            <div className="flex flex-col gap-3">
              <div className="rounded-xl p-3.5" style={{ background: INDUSTRY_UI[app.industry].pastel }}>
                <div className="overflow-hidden rounded-card bg-surface">
                  <div className="flex items-center gap-1.5 border-b border-line-soft px-3.5 py-2.5 text-xs text-stone">
                    <Icon name="eye" size={14} />
                    {t('previewDraft')}
                  </div>
                  <div className="flex flex-col gap-2.5 p-5">
                    <div className="text-xs font-bold text-stone">{preview('brand') || brand}</div>
                    <div className="text-[26px] font-extrabold leading-tight tracking-tight">{preview('headline')}</div>
                    <div className="text-sm text-graphite">{preview('offer')}</div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1.5">
                        <Icon name="clock" size={12} />
                        {preview('hours')}
                      </span>
                      <span className="flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1.5">
                        <Icon name="phone" size={12} />
                        {preview('phone')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <section className="rounded-xl bg-surface p-5">
                <h3 className="mb-2.5 text-base font-bold">{t('activity')}</h3>
                <ol className="flex flex-col gap-1.5">
                  {page.activity.slice(0, 8).map((a, i) => (
                    <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
                      <span className="w-20 shrink-0 text-stone">{relativeTime(a.at, locale)}</span>
                      <span>{a.text}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </div>
        );
      }}
    </Async>
  );
}

function PolicyPill({ policy }: { policy: 'locked' | 'editable' | 'approval' }) {
  const t = useTranslations('websites');
  const map = { locked: ['bg-ink text-white', 'lock'], editable: ['bg-lime-soft', 'edit'], approval: ['bg-butter', 'shield'] } as const;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold', map[policy][0])}>
      <Icon name={map[policy][1]} size={11} />
      {t(`policy.${policy}`)}
    </span>
  );
}

function FieldOrigin({ f, overridden }: { f: WebsiteField; overridden: boolean }) {
  const t = useTranslations('websites');
  const [cls, icon, label] =
    f.policy === 'locked' ? ['bg-ink text-white', 'lock', t('origin.locked')] : f.policy === 'approval' ? ['bg-butter', 'shield', t('origin.approval')] : overridden ? ['bg-lilac', 'edit', t('origin.local')] : ['bg-lime-soft', 'edit', t('origin.inherited')];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold', cls)}>
      <Icon name={icon as 'lock'} size={10} />
      {label}
    </span>
  );
}

/* ------------------------------ Approvals ------------------------------ */

export function Approvals({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations('websites');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.websites.approvals(app.ctx), [app.industry, app.role, app.scopeId]);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" rows={2} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="shield" title={t('approvalsEmpty')} body={t('approvalsEmptyBody')} />}>
      {(items) => (
        <section className="flex flex-col gap-2 rounded-xl bg-surface p-4">
          {items.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-canvas-raised p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-butter">
                <Icon name="shield" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold">
                  {a.locationName} · {a.field}
                </div>
                <div className="text-[13px]">“{a.value}”</div>
                <div className="text-xs text-stone">{t('pendingReason', { reason: a.reason, who: a.requestedBy, when: relativeTime(a.at, locale) })}</div>
              </div>
              <Button size="sm" variant={app.role === 'hq' ? 'primary' : 'secondary'} onClick={onOpen}>
                {app.role === 'hq' ? t('review') : t('view')}
              </Button>
            </div>
          ))}
        </section>
      )}
    </Async>
  );
}

/* ------------------------------ Group publish (scenario 4) ------------------------------ */

function Publish() {
  const t = useTranslations('websites');
  const app = useApp();
  const scopeLabel = useScopeLabel();
  const res = useApi((api) => api.websites.publishPlan(app.ctx), [app.industry, app.role]);
  const [confirming, setConfirming] = useState(false);
  const publish = useMutation((api, id: string) => api.websites.publish(id));
  const retry = useMutation((api, id: string, loc: string) => api.websites.retry(id, loc));
  const [retrying, setRetrying] = useState<string | null>(null);

  const resultBadge = (r: PublishTarget) =>
    r.result === 'published' ? <Badge tone="success">{t('result.published')}</Badge> : r.result === 'failed' ? <Badge tone="danger">{t('result.failed')}</Badge> : r.result === 'publishing' || retrying === r.locationId ? <Badge tone="info" icon="refresh">{t('result.publishing')}</Badge> : <Badge tone="neutral" icon="clock">{t('result.pending')}</Badge>;

  return (
    <Async res={res} permission="website.publish" loading={<LoadingBlock variant="table" />}>
      {(plan: GroupPublish) => {
        const inScope = plan.targets.filter((x) => app.scope.locationIds.includes(x.locationId));
        const done = inScope.filter((x) => x.result === 'published').length;
        const failed = inScope.filter((x) => x.result === 'failed').length;
        const started = inScope.some((x) => x.result !== 'pending');
        return (
          <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs text-stone">{t('versionFrom', { from: plan.version - 1, to: plan.version })}</div>
                <h2 className="text-lg font-bold">{plan.title}</h2>
                <p className="text-xs text-stone">{t('publishScope', { scope: scopeLabel })}</p>
              </div>
              {!started && !confirming && (
                <Button icon="send" onClick={() => setConfirming(true)}>
                  {t('reviewPublish', { count: inScope.length })}
                </Button>
              )}
            </div>
            {confirming && !started && (
              <div className="rounded-lg border-[1.5px] border-ink p-4 text-sm">
                <strong>{t('confirmTitle', { count: inScope.length })}</strong>
                <p className="mt-1 text-[13px] text-stone">{t('confirmBody', { version: plan.version - 1 })}</p>
                <div className="mt-3 flex gap-2">
                  <Button
                    loading={publish.pending}
                    onClick={async () => {
                      const r = await publish.run(plan.id);
                      if (r) res.setData(r);
                      setConfirming(false);
                    }}
                  >
                    {t('publishNow')}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)}>
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}
            {publish.pending && <Banner tone="info" icon="refresh" live="polite">{t('publishing')}</Banner>}
            {started && !publish.pending && (
              <Banner tone={failed ? 'warning' : 'success'} live="polite" title={failed ? t('partialTitle', { done, total: inScope.length, failed }) : t('allDone', { total: inScope.length })}>
                {failed ? t('partialBody') : t('allDoneBody')}
              </Banner>
            )}
            <div className="overflow-x-auto" tabIndex={0}>
              <DataTable<PublishTarget>
                rows={inScope}
                rowKey={(r) => r.locationId}
                columns={[
                  { key: 'loc', header: t('col.location'), render: (r) => <span className="font-bold">{r.locationName}</span> },
                  { key: 'pages', header: t('col.pages'), render: (r) => r.changedPages.join(', ') },
                  { key: 'excl', header: t('col.excluded'), render: (r) => (r.excludedOverrides.length ? r.excludedOverrides.join(', ') : <span className="text-mute">—</span>) },
                  { key: 'warn', header: t('col.warnings'), render: (r) => (r.warnings.length ? <span className="flex items-start gap-1 text-warning"><Icon name="alert" size={13} className="mt-0.5 shrink-0" />{r.warnings.join(', ')}</span> : <span className="text-mute">—</span>) },
                  {
                    key: 'result',
                    header: t('col.result'),
                    render: (r) => (
                      <span className="flex flex-col items-start gap-1.5">
                        {resultBadge(r)}
                        {r.result === 'failed' && (
                          <>
                            <span className="text-xs text-danger">{r.error}</span>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon="refresh"
                              loading={retrying === r.locationId}
                              onClick={async () => {
                                setRetrying(r.locationId);
                                const out = await retry.run(plan.id, r.locationId);
                                setRetrying(null);
                                if (out) res.setData(out);
                              }}
                            >
                              {t('retry')}
                            </Button>
                          </>
                        )}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
            <p className="text-xs text-stone">{t('rollbackNote')}</p>
          </section>
        );
      }}
    </Async>
  );
}

/* ------------------------------ Domains ------------------------------ */

export function Domains() {
  const t = useTranslations('websites');
  const app = useApp();
  const res = useApi((api) => api.websites.sites(app.ctx), [app.industry, app.role, app.scopeId]);
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-5">
      <p className="text-sm text-stone">{t('domainsIntro')}</p>
      <Async res={res} loading={<LoadingBlock variant="table" rows={3} />}>
        {(sites) => (
          <ul className="flex flex-col gap-2">
            {sites.map((s) => (
              <li key={s.locationId} className="flex flex-wrap items-center gap-3 rounded-lg bg-canvas-raised p-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold">{s.locationName}</div>
                  {s.includedAddress && <div className="truncate font-mono text-xs text-stone">{s.includedAddress}</div>}
                  {s.custom && <div className="truncate font-mono text-xs">https://{s.custom.host}</div>}
                </div>
                {s.custom ? (
                  <Badge tone={s.custom.state === 'ready' ? 'success' : s.custom.state === 'failed' ? 'danger' : 'warning'} icon={s.custom.state === 'ready' ? 'shield' : 'clock'}>
                    {t(`domainState.${s.custom.state === 'ready' ? 'ready' : 'awaiting_dns'}`)}
                  </Badge>
                ) : (
                  <Badge tone="neutral" icon="globe">
                    {t('includedOnly')}
                  </Badge>
                )}
                {!s.live && <Badge tone="neutral" icon="eye">{t('notPublic')}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <div className="flex flex-wrap gap-2">
        <Link href="/onboarding?step=website" className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white">
          <Icon name="link" size={16} />
          {t('connectDomain')}
        </Link>
        <span className="inline-flex h-11 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-semibold text-stone">
          {t('buyDomain')} <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold">{t('later')}</span>
        </span>
      </div>
    </section>
  );
}
