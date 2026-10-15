'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Icon, Input, Select, Tabs, Textarea, Toggle, cx, type Tone } from '@bh/ui';
import {
  DEFAULT_REVIEW_TEMPLATES, NEGATIVE_REVIEW_MAX_RATING, REPLY_APPROVAL_MODES, REVIEW_CHANNELS, REVIEW_CONSENT_MODES, REVIEW_LINK_KINDS, REVIEW_TRIGGER_SOURCES, SUPPORTED_LOCALES,
  type Industry, type Locale, type ReviewLink, type ReviewSettings,
} from '@bh/shared';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { NotAvailable } from '../screens/NotAvailable';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { inboxApi } from '../marketing-comms/api';
import { reviewsApi, type ConnectionVM, type DashboardVM, type RequestVM, type ReviewVM } from './api';
import { ReplyTemplatesSection } from '../local-marketing/ReviewInbox';

type Tab = 'overview' | 'reviews' | 'requests' | 'templates' | 'settings' | 'connections';
const REPLY_TONE: Record<string, Tone> = { none: 'neutral', draft: 'neutral', pending_approval: 'warning', published: 'success', rejected: 'danger', failed: 'danger' };
const REQUEST_TONE: Record<string, Tone> = { scheduled: 'info', sending: 'info', sent: 'success', sandboxed: 'neutral', opened: 'info', completed: 'success', skipped: 'warning', failed: 'danger' };

/** Stars as text with an accessible label. */
export function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  const t = useTranslations('reviews');
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={t('stars', { n: rating })}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" aria-hidden className={i <= rating ? 'text-ink' : 'text-line'}>
          <path fill="currentColor" d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
        </svg>
      ))}
    </span>
  );
}

/**
 * Marketing → Reviews: dashboard (rating over time, volume, response rate and time per location), reviews with
 * replies (AI suggestions, HQ approval), review requests, request settings and Google Business Profile connections.
 */
export function ReviewsScreen() {
  const t = useTranslations('reviews');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [open, setOpen] = useState<string | null>(params.get('review'));
  if (!app.hasModule('marketing.reviews')) return <NotAvailable />;
  const canPublish = app.capabilities.has('marketing.reviews:publish');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'overview', label: t('tab.overview') },
    { key: 'reviews', label: t('tab.reviews') },
    { key: 'requests', label: t('tab.requests') },
    // Reply templates and the reply SLA (used by Google reviews in the inbox).
    { key: 'templates', label: t('tab.templates') },
    ...(canPublish ? [{ key: 'settings' as Tab, label: t('tab.settings') }, { key: 'connections' as Tab, label: t('tab.connections') }] : []),
  ];
  return (
    <>
      <PageHeader icon="star" title={t('title')} description={t('description')} />
      <Tabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'overview' && <Overview />}
      {tab === 'reviews' && <ReviewList onOpen={setOpen} />}
      {tab === 'requests' && <Requests />}
      {tab === 'templates' && <ReplyTemplatesSection />}
      {tab === 'settings' && canPublish && <Settings />}
      {tab === 'connections' && canPublish && <Connections />}
      <ReviewDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/* ------------------------------ Overview ------------------------------ */

function Overview() {
  const t = useTranslations('reviews');
  const app = useApp();
  const [bucket, setBucket] = useState<'week' | 'month'>('month');
  const [loc, setLoc] = useState('');
  const res = useApi(() => reviewsApi.dashboard({ bucket, locationId: loc || undefined }), [app.org.id, bucket, loc]);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('filter.location')}>{(p) => (
          <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">{t('filter.allLocations')}</option>
            {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('filter.bucket')}>{(p) => (
          <Select id={p.id} value={bucket} onChange={(e) => setBucket(e.target.value as 'week' | 'month')}>
            <option value="month">{t('filter.month')}</option>
            <option value="week">{t('filter.week')}</option>
          </Select>
        )}</Field>
      </div>
      <Async res={res} loading={<LoadingBlock variant="cards" />}>
        {(d) => <DashboardView d={d} />}
      </Async>
    </>
  );
}

function DashboardView({ d }: { d: DashboardVM }) {
  const t = useTranslations('reviews');
  const fmt = useFormatter();
  const pct = (v: number | null) => (v === null ? '—' : fmt.number(v, { style: 'percent', maximumFractionDigits: 0 }));
  const hours = (v: number | null) => (v === null ? '—' : v < 48 ? t('hours', { n: Math.round(v) }) : t('days', { n: Math.round(v / 24) }));
  const tiles: Array<{ label: string; value: string; sub?: string; testId?: string }> = [
    { label: t('kpi.average'), value: d.totals.averageRating === null ? '—' : fmt.number(d.totals.averageRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), sub: t('kpi.averageSub', { n: d.totals.reviews }), testId: 'kpi-average' },
    { label: t('kpi.volume'), value: fmt.number(d.totals.reviews), sub: t('kpi.volumeSub', { negative: d.totals.negative, public: d.totals.publicReviews }) },
    { label: t('kpi.responseRate'), value: pct(d.totals.responseRate), sub: d.totals.pendingApproval ? t('kpi.pendingApproval', { n: d.totals.pendingApproval }) : t('kpi.responseRateSub') },
    { label: t('kpi.responseTime'), value: hours(d.totals.avgResponseHours), sub: t('kpi.responseTimeSub') },
    { label: t('kpi.requests'), value: fmt.number(d.requests.sent), sub: t('kpi.requestsSub', { completed: d.requests.completed, rate: pct(d.requests.conversion) }) },
  ];
  return (
    <>
      <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))]">
        {tiles.map((x) => (
          <div key={x.label} className="rounded-xl bg-surface p-4" data-testid={x.testId}>
            <div className="text-xs font-semibold text-stone">{x.label}</div>
            <div className="tabular mt-1 text-[28px] font-extrabold leading-none">{x.value}</div>
            {x.sub && <div className="mt-1.5 text-xs text-stone">{x.sub}</div>}
          </div>
        ))}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('chart.rating')}>
          <BarChart rows={d.series.map((s) => ({ key: s.bucket, value: s.averageRating, label: s.averageRating === null ? '—' : fmt.number(s.averageRating, { maximumFractionDigits: 1 }) }))} max={5} bucket={d.bucket} empty={t('chart.empty')} caption={t('chart.ratingCaption')} />
        </SectionCard>
        <SectionCard title={t('chart.volume')}>
          <BarChart rows={d.series.map((s) => ({ key: s.bucket, value: s.reviews, label: fmt.number(s.reviews) }))} max={Math.max(1, ...d.series.map((s) => s.reviews))} bucket={d.bucket} empty={t('chart.empty')} caption={t('chart.volumeCaption')} />
        </SectionCard>
      </div>
      <SectionCard title={t('byLocation')}>
        <div className="overflow-x-auto">
          <DataTable
            rows={d.byLocation}
            rowKey={(r) => r.locationId}
            columns={[
              { key: 'n', header: t('col.location'), render: (r) => <strong>{r.name}</strong> },
              { key: 'avg', header: t('col.average'), render: (r) => (r.averageRating === null ? <span className="text-stone">—</span> : <span className="inline-flex items-center gap-2"><Stars rating={Math.round(r.averageRating)} size={13} /><span className="tabular">{fmt.number(r.averageRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span></span>) },
              { key: 'v', header: t('col.reviews'), align: 'right', render: (r) => <span className="tabular">{r.reviews}</span> },
              { key: 'rr', header: t('col.responseRate'), align: 'right', render: (r) => <span className="tabular">{pct(r.responseRate)}</span> },
              { key: 'rt', header: t('col.responseTime'), align: 'right', render: (r) => <span className="tabular">{hours(r.avgResponseHours)}</span> },
            ]}
          />
        </div>
      </SectionCard>
    </>
  );
}

/** Single-series bars (one measure per chart; no dual axis), hover shows the value, values are also in the table. */
function BarChart({ rows, max, bucket, empty, caption }: { rows: Array<{ key: string; value: number | null; label: string }>; max: number; bucket: 'week' | 'month'; empty: string; caption: string }) {
  const fmt = useFormatter();
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return <p className="text-sm text-stone">{empty}</p>;
  const w = 560;
  const h = 180;
  const pad = { l: 28, b: 24, t: 10 };
  const bw = Math.max(6, Math.min(40, (w - pad.l) / rows.length - 6));
  const step = (w - pad.l) / rows.length;
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const tick = (k: string) => (bucket === 'month' ? fmt.dateTime(new Date(`${k}-01T12:00:00Z`), { month: 'short', timeZone: 'UTC' }) : fmt.dateTime(new Date(`${k}T12:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' }));
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label={caption}>
        {[0, 0.5, 1].map((f) => <line key={f} x1={pad.l} x2={w} y1={y(max * f)} y2={y(max * f)} className="stroke-line-soft" strokeWidth={1} />)}
        {[0, max].map((v) => <text key={v} x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="fill-stone text-[10px]">{fmt.number(v, { maximumFractionDigits: 1 })}</text>)}
        {rows.map((r, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const v = r.value ?? 0;
          const top = y(v);
          return (
            <g key={r.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={h - pad.t - pad.b} fill="transparent" />
              {r.value !== null && <path d={`M${x},${y(0)} V${top + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${y(0)} Z`} className={hover === i ? 'fill-ink' : 'fill-graphite'} />}
              {(rows.length <= 8 || i % Math.ceil(rows.length / 8) === 0) && <text x={x + bw / 2} y={h - 8} textAnchor="middle" className="fill-stone text-[10px]">{tick(r.key)}</text>}
              {hover === i && <text x={x + bw / 2} y={Math.max(12, top - 6)} textAnchor="middle" className="fill-ink text-[11px] font-bold">{r.label}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}

/* ------------------------------ Reviews ------------------------------ */

function ReviewList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations('reviews');
  const app = useApp();
  const fmt = useFormatter();
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState<'' | 'negative' | 'unanswered' | 'pending_approval'>('');
  const [q, setQ] = useState('');
  const res = useApi(() => reviewsApi.list({ source: source || undefined, maxRating: filter === 'negative' ? NEGATIVE_REVIEW_MAX_RATING : undefined, reply: filter === 'unanswered' || filter === 'pending_approval' ? filter : undefined, q: q || undefined }), [app.org.id, source, filter, q]);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('filter.source')}>{(p) => (
          <Select id={p.id} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t('filter.allSources')}</option>
            <option value="google">{t('source.google')}</option>
            <option value="branchharbor">{t('source.branchharbor')}</option>
          </Select>
        )}</Field>
        <Field label={t('filter.show')}>{(p) => (
          <Select id={p.id} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="">{t('filter.all')}</option>
            <option value="negative">{t('filter.negative')}</option>
            <option value="unanswered">{t('filter.unanswered')}</option>
            <option value="pending_approval">{t('filter.pending')}</option>
          </Select>
        )}</Field>
        <Field label={t('filter.search')}>{(p) => <Input id={p.id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
      </div>
      <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="star" title={t('empty')} body={t('emptyBody')} />}>
        {(d) => (
          <ul className="flex flex-col gap-3" role="list" data-testid="review-list">
            {d.items.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)} className={cx('w-full rounded-xl bg-surface p-4 text-left hover:ring-2 hover:ring-line', r.negative && 'border-l-4 border-danger')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Stars rating={r.rating} />
                    <strong>{r.authorName ?? t('anonymous')}</strong>
                    <Badge tone="neutral" icon={r.source === 'google' ? 'globe' : 'lock'}>{t(`source.${r.source}`)}</Badge>
                    <span className="text-xs text-stone">{r.locationName} · {fmt.dateTime(new Date(r.reviewedAt), { dateStyle: 'medium' })}</span>
                    {r.source === 'google' && <Badge tone={REPLY_TONE[r.reply.status] ?? 'neutral'}>{t(`replyStatus.${r.reply.status}`)}</Badge>}
                    {r.sandbox && r.reply.status === 'published' && !r.reply.external && <Badge tone="neutral">{t('sandboxReply')}</Badge>}
                  </div>
                  {r.comment && <p className="mt-2 line-clamp-3 text-sm">{r.comment}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </>
  );
}

function ReviewDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations('reviews');
  const fmt = useFormatter();
  const res = useApi(() => reviewsApi.get(id!), [id], !!id);
  const [text, setText] = useState('');
  const [ai, setAi] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const suggest = useMutation((_api, reviewId: string, locale: string | null) => reviewsApi.suggest(reviewId, locale));
  const save = useMutation((_api, reviewId: string, publish: boolean) => reviewsApi.reply(reviewId, text, ai, publish));
  const decide = useMutation((_api, reviewId: string, decision: 'approve' | 'reject') => reviewsApi.decide(reviewId, decision, note || undefined));
  const r = res.data;
  useEffect(() => {
    setText(r?.reply.text ?? '');
    setAi(r?.reply.aiSuggested ?? false);
    setMsg(null);
  }, [r?.id, r?.reply.text, r?.reply.aiSuggested]);
  const error = suggest.error ?? save.error ?? decide.error;
  return (
    <Drawer open={!!id} onClose={onClose} title={t('drawer.title')} kicker={r?.locationName ?? undefined}>
      {!r ? <LoadingBlock variant="detail" /> : (
        <div className="flex flex-col gap-4" data-testid="review-drawer">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Stars rating={r.rating} size={20} />
              <strong>{r.authorName ?? t('anonymous')}</strong>
              <Badge tone="neutral">{t(`source.${r.source}`)}</Badge>
            </div>
            <p className="mt-1 text-xs text-stone">{fmt.dateTime(new Date(r.reviewedAt), { dateStyle: 'long', timeStyle: 'short' })}</p>
            <blockquote className="mt-3 rounded-lg bg-canvas p-3 text-sm">{r.comment ?? <span className="text-stone">{t('noComment')}</span>}</blockquote>
          </div>
          {r.source === 'branchharbor' ? (
            <Banner tone="info" icon="message">{t('drawer.privateHint')}</Banner>
          ) : (
            <>
              {r.reply.status === 'pending_approval' && <Banner tone="warning" title={t('drawer.pendingTitle')}>{t('drawer.pendingBody', { name: r.reply.by?.name ?? '' })}</Banner>}
              {r.reply.status === 'rejected' && <Banner tone="danger" title={t('drawer.rejectedTitle')}>{r.reply.decisionNote ?? ''}</Banner>}
              {r.reply.status === 'failed' && <Banner tone="danger">{r.reply.error ?? t('replyStatus.failed')}</Banner>}
              {r.reply.status === 'published' && <Banner tone="success" title={t('drawer.publishedTitle')}>{r.reply.external ? t('drawer.externalReply') : r.sandbox ? t('sandboxReplyLong') : t('drawer.publishedBody')}</Banner>}
              {(r.canReply || r.canApprove) && r.reply.status !== 'published' && (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold">{t('drawer.reply')}</span>
                    {r.aiEnabled && <Button size="sm" variant="secondary" icon="sparkles" loading={suggest.pending} onClick={async () => { const s = await suggest.run(r.id, r.language); if (s) { setText(s.suggestion); setAi(true); } }} data-testid="suggest-reply">{t('drawer.suggest')}</Button>}
                  </div>
                  {ai && <p className="flex items-center gap-1.5 text-xs text-stone"><Icon name="sparkles" size={14} />{t('drawer.aiNote')}</p>}
                  <Field label={t('drawer.replyLabel')} hint={t('drawer.replyHint')}>{(p) => <Textarea id={p.id} rows={6} value={text} onChange={(e) => setText(e.target.value)} data-testid="reply-text" />}</Field>
                  {r.needsApproval && <p className="text-xs text-stone">{t('drawer.needsApproval')}</p>}
                  {r.canReply && (
                    <div className="flex flex-wrap gap-2">
                      <Button loading={save.pending} disabled={text.trim().length < 2} onClick={async () => { const u = await save.run(r.id, true); if (u) { setMsg(u.reply.status === 'pending_approval' ? t('drawer.sentForApproval') : t('drawer.published')); res.reload(); } }}>{r.needsApproval ? t('drawer.submit') : t('drawer.publish')}</Button>
                      <Button variant="ghost" loading={save.pending} disabled={text.trim().length < 2} onClick={async () => { if (await save.run(r.id, false)) { setMsg(t('drawer.saved')); res.reload(); } }}>{t('drawer.saveDraft')}</Button>
                    </div>
                  )}
                  {r.canApprove && r.reply.status === 'pending_approval' && (
                    <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                      <Field label={t('drawer.decisionNote')} optional>{(p) => <Input id={p.id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                      <div className="flex flex-wrap gap-2">
                        <Button icon="check" loading={decide.pending} onClick={async () => { if (await decide.run(r.id, 'approve')) { setMsg(t('drawer.published')); res.reload(); } }}>{t('drawer.approve')}</Button>
                        <Button variant="danger" loading={decide.pending} onClick={async () => { if (await decide.run(r.id, 'reject')) { setMsg(t('drawer.rejected')); res.reload(); } }}>{t('drawer.reject')}</Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {r.reply.status === 'published' && r.reply.text && <blockquote className="rounded-lg border border-line-soft p-3 text-sm">{r.reply.text}</blockquote>}
            </>
          )}
          {error && <Banner tone="danger" live="assertive">{error.message}</Banner>}
          {msg && <Banner tone="success" live="polite">{msg}</Banner>}
        </div>
      )}
    </Drawer>
  );
}

/* ------------------------------ Requests ------------------------------ */

function Requests() {
  const t = useTranslations('reviews');
  const app = useApp();
  const fmt = useFormatter();
  const canEdit = app.capabilities.has('marketing.reviews:edit');
  const canRun = app.capabilities.has('marketing.reviews:publish');
  const res = useApi(() => reviewsApi.requests(), [app.org.id]);
  const [loc, setLoc] = useState(app.locations[0]?.id ?? '');
  const [q, setQ] = useState('');
  const contacts = useApi(() => inboxApi.contacts({ q: q || undefined, locationId: loc || undefined }), [app.org.id, q, loc], canEdit && q.length >= 2);
  const [customerId, setCustomerId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const send = useMutation((_api) => reviewsApi.sendRequest({ locationId: loc, customerId }));
  const run = useMutation(() => reviewsApi.runRequests());
  return (
    <>
      {canEdit && (
        <SectionCard title={t('send.title')} aside={canRun ? <Button size="sm" variant="secondary" icon="refresh" loading={run.pending} onClick={async () => { const r = await run.run(); if (r) { setMsg(t('send.ran', { n: r.queued })); res.reload(); } }}>{t('send.run')}</Button> : undefined}>
          <p className="mb-3 text-sm text-stone">{t('send.hint')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('col.location')}>{(p) => <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
            <Field label={t('send.search')}>{(p) => <Input id={p.id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
            <Field label={t('send.customer')}>{(p) => (
              <Select id={p.id} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">{t('send.choose')}</option>
                {(contacts.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}
              </Select>
            )}</Field>
          </div>
          <div className="mt-3"><Button icon="send" loading={send.pending} disabled={!loc || !customerId} onClick={async () => { const r = await send.run(); if (r) { setMsg(t(`outcome.${r.outcome.status}`, { reason: r.outcome.reason ? t(`skip.${r.outcome.reason}`) : '' })); res.reload(); } }}>{t('send.button')}</Button></div>
          {(send.error ?? run.error) && <div className="mt-3"><Banner tone="danger" live="assertive">{(send.error ?? run.error)!.message}</Banner></div>}
          {msg && <div className="mt-3"><Banner tone="success" live="polite">{msg}</Banner></div>}
        </SectionCard>
      )}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="send" title={t('requests.empty')} body={t('requests.emptyBody')} />}>
        {(d) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<RequestVM>
              rows={d.items}
              rowKey={(r) => r.id}
              columns={[
                { key: 'c', header: t('col.customer'), render: (r) => <span><strong>{r.contactName ?? '—'}</strong><span className="block text-xs text-stone">{r.locationName}</span></span> },
                { key: 's', header: t('col.source'), render: (r) => t(`trigger.${r.source}`) },
                { key: 'ch', header: t('col.channel'), render: (r) => t(`channel.${r.channel}`) },
                { key: 'w', header: t('col.when'), render: (r) => fmt.dateTime(new Date(r.sentAt ?? r.sendAt), { dateStyle: 'medium', timeStyle: 'short' }) },
                { key: 'st', header: t('col.status'), render: (r) => <span className="flex flex-wrap items-center gap-1"><Badge tone={REQUEST_TONE[r.status] ?? 'neutral'}>{t(`requestStatus.${r.status}`)}</Badge>{r.skipReason && <span className="text-xs text-stone">{t(`skip.${r.skipReason}`)}</span>}</span> },
              ]}
            />
          </section>
        )}
      </Async>
    </>
  );
}

/* ------------------------------ Settings ------------------------------ */

function Settings() {
  const t = useTranslations('reviews');
  const app = useApp();
  const [loc, setLoc] = useState<string>('');
  const res = useApi(() => reviewsApi.settings(loc || null), [app.org.id, loc]);
  return (
    <>
      <Field label={t('settings.scope')} hint={t('settings.scopeHint')}>{(p) => (
        <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">{t('settings.hqDefaults')}</option>
          {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      )}</Field>
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(d) => <SettingsForm key={`${loc}:${d.enabledAt ?? ''}`} locationId={loc || null} initial={d.effective} hq={!loc} canEdit={d.canEdit} canEditHq={d.canEditHq} onSaved={res.reload} />}
      </Async>
    </>
  );
}

function SettingsForm({ locationId, initial, hq, canEdit, canEditHq, onSaved }: { locationId: string | null; initial: ReviewSettings; hq: boolean; canEdit: boolean; canEditHq: boolean; onSaved: () => void }) {
  const t = useTranslations('reviews');
  const app = useApp();
  const [s, setS] = useState<ReviewSettings>(initial);
  const [tplLocale, setTplLocale] = useState<Locale>((app.org.defaultLocale as Locale) ?? 'en');
  const [ok, setOk] = useState(false);
  const save = useMutation(() => reviewsApi.saveSettings(locationId, hq ? s : { enabled: s.enabled, sources: s.sources, delayMinutes: s.delayMinutes, channel: s.channel, templates: s.templates, frequencyCapDays: s.frequencyCapDays, quietHours: s.quietHours, consentMode: s.consentMode, links: s.links }));
  const sources = REVIEW_TRIGGER_SOURCES[app.org.industry as Industry] ?? [];
  const set = (patch: Partial<ReviewSettings>) => { setS({ ...s, ...patch }); setOk(false); };
  const tpl = s.templates[tplLocale] ?? { subject: '', body: '' };
  const def = DEFAULT_REVIEW_TEMPLATES[tplLocale];
  const setLink = (i: number, patch: Partial<ReviewLink>) => set({ links: s.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <div className="flex flex-col gap-4" data-testid="review-settings">
      <SectionCard title={t('settings.requests')} aside={<span className="flex items-center gap-2 text-sm font-semibold">{t('settings.enabled')}<Toggle checked={s.enabled} onChange={(v) => set({ enabled: v })} label={t('settings.enabled')} /></span>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-semibold">{t('settings.after')}</legend>
            {sources.map((src) => (
              <label key={src} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s.sources.includes(src)} onChange={(e) => set({ sources: e.target.checked ? [...s.sources, src] : s.sources.filter((x) => x !== src) })} />
                {t(`trigger.${src}`)}
              </label>
            ))}
          </fieldset>
          <Field label={t('settings.delay')} hint={t('settings.delayHint')}>{(p) => <Input id={p.id} type="number" min={0} max={336} value={Math.round(s.delayMinutes / 60)} onChange={(e) => set({ delayMinutes: Math.max(0, Number(e.target.value)) * 60 })} />}</Field>
          <Field label={t('settings.channel')}>{(p) => <Select id={p.id} value={s.channel} onChange={(e) => set({ channel: e.target.value as ReviewSettings['channel'] })}>{REVIEW_CHANNELS.map((c) => <option key={c} value={c}>{t(`channel.${c}`)}</option>)}</Select>}</Field>
          <Field label={t('settings.cap')} hint={t('settings.capHint')}>{(p) => <Input id={p.id} type="number" min={1} max={365} value={s.frequencyCapDays} onChange={(e) => set({ frequencyCapDays: Math.max(1, Number(e.target.value)) })} />}</Field>
          <Field label={t('settings.quietStart')} hint={t('settings.quietHint')}>{(p) => <Input id={p.id} type="time" value={s.quietHours.start} onChange={(e) => set({ quietHours: { ...s.quietHours, start: e.target.value } })} />}</Field>
          <Field label={t('settings.quietEnd')}>{(p) => <Input id={p.id} type="time" value={s.quietHours.end} onChange={(e) => set({ quietHours: { ...s.quietHours, end: e.target.value } })} />}</Field>
          <Field label={t('settings.consent')} hint={t(`settings.consentHint.${s.consentMode}`)}>{(p) => <Select id={p.id} value={s.consentMode} onChange={(e) => set({ consentMode: e.target.value as ReviewSettings['consentMode'] })}>{REVIEW_CONSENT_MODES.map((c) => <option key={c} value={c}>{t(`settings.consentMode.${c}`)}</option>)}</Select>}</Field>
        </div>
      </SectionCard>
      <SectionCard title={t('settings.template')}>
        <p className="mb-3 text-sm text-stone">{t('settings.templateHint')}</p>
        <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
          <Field label={t('settings.language')}>{(p) => <Select id={p.id} value={tplLocale} onChange={(e) => setTplLocale(e.target.value as Locale)}>{SUPPORTED_LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}</Select>}</Field>
          <Field label={t('settings.subject')} optional>{(p) => <Input id={p.id} value={tpl.subject} placeholder={def.subject} onChange={(e) => set({ templates: { ...s.templates, [tplLocale]: { ...tpl, subject: e.target.value } } })} />}</Field>
        </div>
        <div className="mt-3"><Field label={t('settings.body')} optional hint={t('settings.bodyHint')}>{(p) => <Textarea id={p.id} rows={3} value={tpl.body} placeholder={def.body} onChange={(e) => set({ templates: { ...s.templates, [tplLocale]: { ...tpl, body: e.target.value } } })} />}</Field></div>
      </SectionCard>
      <SectionCard title={t('settings.links')}>
        <Banner tone="info" icon="shield">{t('settings.noGating')}</Banner>
        <ul className="mt-3 flex flex-col gap-2">
          {s.links.map((l, i) => (
            <li key={i} className="grid gap-2 sm:grid-cols-[160px_1fr_1.6fr_auto] sm:items-end">
              <Field label={t('settings.linkKind')}>{(p) => <Select id={p.id} value={l.kind} onChange={(e) => setLink(i, { kind: e.target.value as ReviewLink['kind'] })}>{REVIEW_LINK_KINDS.map((k) => <option key={k} value={k}>{t(`linkKind.${k}`)}</option>)}</Select>}</Field>
              <Field label={t('settings.linkLabel')} optional>{(p) => <Input id={p.id} value={l.label} onChange={(e) => setLink(i, { label: e.target.value })} />}</Field>
              <Field label={t('settings.linkUrl')}>{(p) => <Input id={p.id} type="url" value={l.url} onChange={(e) => setLink(i, { url: e.target.value })} />}</Field>
              <Button variant="ghost" size="sm" icon="x" onClick={() => set({ links: s.links.filter((_, j) => j !== i) })}>{t('settings.remove')}</Button>
            </li>
          ))}
        </ul>
        {s.links.length < 6 && <div className="mt-2"><Button variant="secondary" size="sm" icon="plus" onClick={() => set({ links: [...s.links, { kind: 'google', label: '', url: 'https://' }] })}>{t('settings.addLink')}</Button></div>}
      </SectionCard>
      {hq && (
        <SectionCard title={t('settings.approval')}>
          <Field label={t('settings.approvalLabel')} hint={t('settings.approvalHint')}>{(p) => <Select id={p.id} value={s.replyApproval} disabled={!canEditHq} onChange={(e) => set({ replyApproval: e.target.value as ReviewSettings['replyApproval'] })}>{REPLY_APPROVAL_MODES.map((m) => <option key={m} value={m}>{t(`settings.approvalMode.${m}`)}</option>)}</Select>}</Field>
        </SectionCard>
      )}
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      {ok && <Banner tone="success" live="polite">{t('settings.saved')}</Banner>}
      {canEdit && <div><Button loading={save.pending} onClick={async () => { if (await save.run()) { setOk(true); onSaved(); } }}>{t('settings.save')}</Button></div>}
    </div>
  );
}

/* ------------------------------ Connections ------------------------------ */

function Connections() {
  const t = useTranslations('reviews');
  const app = useApp();
  const fmt = useFormatter();
  const params = useSearchParams();
  const res = useApi(() => reviewsApi.connections(), [app.org.id]);
  const [ownerKind, setOwnerKind] = useState<'hq' | 'location'>('hq');
  const [loc, setLoc] = useState(app.locations[0]?.id ?? '');
  const [msg, setMsg] = useState<string | null>(params.get('google') === 'connected' ? t('connections.connected') : null);
  const start = useMutation(async () => { const r = await reviewsApi.googleStart(ownerKind, ownerKind === 'location' ? loc : undefined); window.location.href = r.url; return r; });
  const sandbox = useMutation(() => reviewsApi.addSandbox(ownerKind, ownerKind === 'location' ? loc : null));
  const locName = useMemo(() => new Map(app.locations.map((l) => [l.id, l.name])), [app.locations]);
  return (
    <>
      <SectionCard title={t('connections.title')}>
        <p className="mb-3 text-sm text-stone">{t('connections.intro')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('connections.owner')}>{(p) => <Select id={p.id} value={ownerKind} onChange={(e) => setOwnerKind(e.target.value as 'hq' | 'location')}><option value="hq">{t('connections.hq')}</option><option value="location">{t('connections.location')}</option></Select>}</Field>
          {ownerKind === 'location' && <Field label={t('col.location')}>{(p) => <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button icon="globe" loading={start.pending} disabled={res.data ? !res.data.googleConfigured : true} onClick={() => void start.run()}>{t('connections.connectGoogle')}</Button>
          <Button variant="secondary" icon="plus" loading={sandbox.pending} onClick={async () => { if (await sandbox.run()) { setMsg(t('connections.sandboxAdded')); res.reload(); } }}>{t('connections.addSandbox')}</Button>
        </div>
        {res.data && !res.data.googleConfigured && <div className="mt-3"><Banner tone="neutral">{t('connections.notConfigured')}</Banner></div>}
        {(start.error ?? sandbox.error) && <div className="mt-3"><Banner tone="danger" live="assertive">{(start.error ?? sandbox.error)!.message}</Banner></div>}
        {msg && <div className="mt-3"><Banner tone="success" live="polite">{msg}</Banner></div>}
      </SectionCard>
      <Async res={res} loading={<LoadingBlock variant="cards" rows={2} />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="plug" title={t('connections.empty')} />}>
        {(d) => <div className="flex flex-col gap-3">{d.items.map((c) => <ConnectionCard key={c.id} c={c} locName={locName} fmt={fmt} onChanged={res.reload} />)}</div>}
      </Async>
    </>
  );
}

function ConnectionCard({ c, locName, fmt, onChanged }: { c: ConnectionVM; locName: Map<string, string>; fmt: ReturnType<typeof useFormatter>; onChanged: () => void }) {
  const t = useTranslations('reviews');
  const app = useApp();
  const glocs = useApi(() => reviewsApi.googleLocations(c.id), [c.id], c.mode === 'live' && c.status !== 'disconnected');
  const [loc, setLoc] = useState(c.locationId ?? app.locations[0]?.id ?? '');
  const [ext, setExt] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const link = useMutation(() => {
    const g = glocs.data?.items.find((x) => x.name === ext);
    return reviewsApi.link(c.id, { locationId: loc, externalLocationName: ext, accountName: g?.accountName, title: g?.title, reviewUrl: g?.reviewUrl ?? undefined });
  });
  const sync = useMutation((_api, listingId: string) => reviewsApi.sync(listingId));
  return (
    <SectionCard
      title={c.ownerKind === 'hq' ? t('connections.hqAccount') : t('connections.locationAccount', { name: locName.get(c.locationId ?? '') ?? '' })}
      aside={<span className="flex gap-1.5"><Badge tone={c.mode === 'live' ? 'success' : 'neutral'}>{t(`connections.mode.${c.mode}`)}</Badge><Badge tone={c.status === 'connected' ? 'info' : 'warning'}>{t(`connections.status.${c.status}`)}</Badge></span>}
    >
      {c.accountEmail && <p className="text-sm">{c.accountEmail}</p>}
      {c.mode === 'sandbox' && <p className="text-sm text-stone">{t('connections.sandboxNote')}</p>}
      {c.lastError && <Banner tone="danger">{c.lastError}</Banner>}
      <ul className="mt-3 flex flex-col gap-2">
        {c.listings.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas p-3 text-sm">
            <span><strong>{locName.get(l.locationId) ?? ''}</strong> · {l.title ?? l.externalLocationName}<span className="block text-xs text-stone">{l.lastFetchedAt ? t('connections.lastFetched', { at: fmt.dateTime(new Date(l.lastFetchedAt), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('connections.neverFetched')}</span></span>
            <Button size="sm" variant="secondary" icon="refresh" loading={sync.pending} onClick={async () => { const r = await sync.run(l.id); if (r) { setMsg(r.sandbox ? t('connections.syncedSandbox') : t('connections.synced', { n: r.created })); onChanged(); } }}>{t('connections.sync')}</Button>
          </li>
        ))}
      </ul>
      {c.status !== 'disconnected' && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t('col.location')}>{(p) => <Select id={p.id} value={loc} onChange={(e) => setLoc(e.target.value)}>{app.locations.filter((l) => c.ownerKind === 'hq' || l.id === c.locationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
          {c.mode === 'live' ? (
            <Field label={t('connections.googleLocation')}>{(p) => <Select id={p.id} value={ext} onChange={(e) => setExt(e.target.value)}><option value="">{t('send.choose')}</option>{(glocs.data?.items ?? []).map((g) => <option key={g.name} value={g.name}>{g.title}</option>)}</Select>}</Field>
          ) : (
            <Field label={t('connections.googleLocationId')} hint={t('connections.googleLocationIdHint')}>{(p) => <Input id={p.id} value={ext} placeholder={t('connections.placeholder')} onChange={(e) => setExt(e.target.value)} />}</Field>
          )}
          <Button size="sm" icon="link" loading={link.pending} disabled={!loc || !ext} onClick={async () => { if (await link.run()) { setMsg(t('connections.linked')); setExt(''); onChanged(); } }}>{t('connections.link')}</Button>
        </div>
      )}
      {(link.error ?? sync.error) && <div className="mt-2"><Banner tone="danger" live="assertive">{(link.error ?? sync.error)!.message}</Banner></div>}
      {msg && <div className="mt-2"><Banner tone="success" live="polite">{msg}</Banner></div>}
    </SectionCard>
  );
}

export type { ReviewVM };
