'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Textarea, Toggle, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { AudiencePicker, ErrorNote, Pill, PersonBadge, canDo, useAudienceText, useNet, useNetAction, type Audience, type NetMe } from './net';
import { LoadingBlock } from '../ui/States';

export interface Attachment { name: string; url: string }
export interface AnnouncementT {
  id: string; title: string; body: string; audience: Audience & { everyone: boolean }; requiredRead: boolean; dueAt: string | null; pinned: boolean; status: string; publishAt: string | null;
  attachments: Attachment[]; author: { id: string; name: string; badge: string } | null; createdAt: string; readAt: string | null; acknowledgedAt: string | null; overdue: boolean;
  stats?: { targeted: number; acknowledged: number; read: number };
}
interface Receipt { userId: string; name: string; email: string; readAt: string | null; acknowledgedAt: string | null; remindedAt: string | null }

export function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {items.map((a) => (
        <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-[13px] font-semibold underline-offset-2 hover:underline"><Icon name="file" size={14} />{a.name}</a></li>
      ))}
    </ul>
  );
}

export function AnnouncementsPanel({ me, focusId, onChanged }: { me: NetMe; focusId?: string | null; onChanged: () => void }) {
  const t = useTranslations('community.ann');
  const [filter, setFilter] = useState<'all' | 'required' | 'unread'>('all');
  const [manage, setManage] = useState(false);
  const [compose, setCompose] = useState(false);
  const [receiptsFor, setReceiptsFor] = useState<AnnouncementT | null>(null);
  const announcer = canDo(me, 'community.announce');
  const res = useNet<{ items: AnnouncementT[] }>(`/community/announcements?filter=${filter}${manage ? '&manage=true' : ''}`, [filter, manage]);
  const items = res.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t('filter')} className="flex flex-wrap gap-1.5">
          {(['all', 'required', 'unread'] as const).map((f) => <Pill key={f} active={!manage && filter === f} onClick={() => { setManage(false); setFilter(f); }} count={f === 'required' ? me.counters.requiredReadsPending : undefined}>{t(`filters.${f}`)}</Pill>)}
          {announcer && <Pill active={manage} onClick={() => { setManage(true); setFilter('all'); }}>{t('filters.sent')}</Pill>}
        </div>
        {announcer && <Button className="ml-auto" size="sm" variant="signal" icon="megaphone" onClick={() => setCompose(true)}>{t('new')}</Button>}
      </div>
      <ErrorNote error={res.error} />
      {res.loading && !res.data ? <LoadingBlock variant="table" rows={3} /> : items.length === 0 ? (
        <p className="rounded-xl bg-surface p-6 text-sm text-stone">{manage ? t('emptySent') : t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((a) => <AnnouncementCard key={a.id} a={a} me={me} manage={manage} focus={a.id === focusId} onReceipts={() => setReceiptsFor(a)} onChanged={() => { void res.reload(); onChanged(); }} />)}
        </ul>
      )}
      {compose && <Composer me={me} onClose={() => setCompose(false)} onDone={() => { setCompose(false); setManage(true); void res.reload(); onChanged(); }} />}
      {receiptsFor && <ReceiptsDrawer a={receiptsFor} onClose={() => setReceiptsFor(null)} />}
    </div>
  );
}

function AnnouncementCard({ a, me, manage, focus, onReceipts, onChanged }: { a: AnnouncementT; me: NetMe; manage: boolean; focus: boolean; onReceipts: () => void; onChanged: () => void }) {
  const t = useTranslations('community.ann');
  const locale = useLocale();
  const audienceText = useAudienceText(me.directory);
  const act = useNetAction();
  const [open, setOpen] = useState(focus || a.pinned);
  const [ack, setAck] = useState(a.acknowledgedAt);
  const [read, setRead] = useState(a.readAt);
  const live = a.status === 'published';

  useEffect(() => {
    if (open && live && !read && !manage) void act.run<{ readAt: string }>('post', `/community/announcements/${a.id}/read`).then((r) => r && setRead(r.readAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <li id={`ann-${a.id}`} className={cx('flex flex-col gap-2.5 rounded-xl bg-surface p-4 md:p-5', focus && 'ring-2 ring-ink', a.overdue && 'border-l-4 border-danger')}>
      <div className="flex flex-wrap items-center gap-2">
        {a.pinned && <Badge tone="signal" icon="flag">{t('pinned')}</Badge>}
        {a.requiredRead && <Badge tone={ack ? 'success' : a.overdue ? 'danger' : 'warning'}>{ack ? t('confirmed') : a.overdue ? t('overdue') : t('required')}</Badge>}
        {a.status === 'scheduled' && <Badge tone="info" icon="clock">{t('scheduledFor', { when: new Date(a.publishAt!).toLocaleString(locale) })}</Badge>}
        {a.status === 'draft' && <Badge tone="neutral">{t('draft')}</Badge>}
        <span className="ml-auto text-xs text-stone">{relativeTime(a.publishAt ?? a.createdAt, locale)}</span>
      </div>
      <button type="button" className="text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h3 className="text-[17px] font-bold leading-snug">{a.title}</h3>
      </button>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-stone">
        {a.author && <><span className="font-semibold text-ink">{a.author.name}</span><PersonBadge badge={a.author.badge} /></>}
        <span>· {t('to', { audience: audienceText(a.audience) })}</span>
        {a.dueAt && a.requiredRead && <span>· {t('due', { date: new Date(a.dueAt).toLocaleDateString(locale) })}</span>}
      </div>
      {open && (
        <>
          <p className="whitespace-pre-line text-sm leading-relaxed">{a.body}</p>
          <Attachments items={a.attachments} />
        </>
      )}
      <ErrorNote error={act.error} />
      <div className="flex flex-wrap items-center gap-2">
        {!open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{t('read')}</Button>}
        {live && a.requiredRead && !ack && !manage && (
          <Button size="sm" icon="check" loading={act.pending} onClick={async () => {
            const r = await act.run<{ acknowledgedAt: string }>('post', `/community/announcements/${a.id}/acknowledge`);
            if (r) { setAck(r.acknowledgedAt); setOpen(true); onChanged(); }
          }}>{t('acknowledge')}</Button>
        )}
        {manage && a.stats && <span className="text-[13px] font-semibold">{a.requiredRead ? t('statsRequired', { done: a.stats.acknowledged, total: a.stats.targeted }) : t('statsRead', { done: a.stats.read, total: a.stats.targeted })}</span>}
        {manage && live && <Button size="sm" variant="secondary" icon="users" onClick={onReceipts}>{t('receipts')}</Button>}
        {manage && live && a.requiredRead && (a.stats?.acknowledged ?? 0) < (a.stats?.targeted ?? 0) && (
          <Button size="sm" variant="ghost" icon="bell" loading={act.pending} onClick={async () => { const r = await act.run<{ reminded: number }>('post', `/community/announcements/${a.id}/remind`); if (r) onChanged(); }}>{t('remind')}</Button>
        )}
        {manage && (a.author?.id === me.userId || canDo(me, 'community.announce', true)) && (
          <Button size="sm" variant="ghost" icon={a.pinned ? 'x' : 'flag'} onClick={async () => { if (await act.run('patch', `/community/announcements/${a.id}`, { pinned: !a.pinned })) onChanged(); }}>{a.pinned ? t('unpin') : t('pin')}</Button>
        )}
      </div>
    </li>
  );
}

function Composer({ me, onClose, onDone }: { me: NetMe; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('community.ann');
  const act = useNetAction();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>(me.hq ? {} : { regionIds: me.scope.regionIds.slice(0, 1) });
  const [requiredRead, setRequiredRead] = useState(false);
  const [due, setDue] = useState('');
  const [pinned, setPinned] = useState(false);
  const [schedule, setSchedule] = useState('');
  const [attName, setAttName] = useState('');
  const [attUrl, setAttUrl] = useState('');
  const f = act.error?.fields ?? {};
  const submit = async (status: 'published' | 'draft') => {
    const r = await act.run('post', '/community/announcements', {
      title, body, audience, requiredRead, pinned, status,
      dueAt: requiredRead && due ? new Date(due).toISOString() : null,
      publishAt: schedule ? new Date(schedule).toISOString() : null,
      attachments: attName && attUrl ? [{ name: attName, url: attUrl }] : [],
    });
    if (r) onDone();
  };
  return (
    <Drawer open onClose={onClose} title={t('composeTitle')} kicker={t('composeKicker')} footer={
      <div className="flex flex-wrap gap-2">
        <Button loading={act.pending} disabled={!title.trim() || !body.trim()} onClick={() => submit('published')} icon={schedule ? 'clock' : 'send'}>{schedule ? t('schedule') : t('publish')}</Button>
        <Button variant="secondary" disabled={act.pending || !title.trim() || !body.trim()} onClick={() => submit('draft')}>{t('saveDraft')}</Button>
      </div>
    }>
      <div className="flex flex-col gap-4">
        <ErrorNote error={act.error && !Object.keys(f).length ? act.error : null} />
        <Field label={t('title')} error={f.title}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
        <Field label={t('body')} error={f.body}>{(p) => <Textarea id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold">{t('audience')}</span>
          <AudiencePicker value={audience} onChange={setAudience} directory={me.directory} allowEveryone={me.hq} />
          {!me.hq && <p className="text-xs text-stone">{t('scopeHint')}</p>}
        </div>
        <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{t('requiredRead')}</span><Toggle checked={requiredRead} onChange={setRequiredRead} label={t('requiredRead')} /></div>
        {requiredRead && <Field label={t('dueAt')} error={f.dueAt} optional>{(p) => <Input id={p.id} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>}
        <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{t('pinToTop')}</span><Toggle checked={pinned} onChange={setPinned} label={t('pinToTop')} /></div>
        <Field label={t('publishAt')} hint={t('publishAtHint')} optional>{(p) => <Input id={p.id} type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />}</Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('attachmentName')} optional>{(p) => <Input id={p.id} value={attName} onChange={(e) => setAttName(e.target.value)} />}</Field>
          <Field label={t('attachmentUrl')} error={f.url} optional>{(p) => <Input id={p.id} type="url" value={attUrl} onChange={(e) => setAttUrl(e.target.value)} />}</Field>
        </div>
      </div>
    </Drawer>
  );
}

function ReceiptsDrawer({ a, onClose }: { a: AnnouncementT; onClose: () => void }) {
  const t = useTranslations('community.ann');
  const locale = useLocale();
  const res = useNet<{ items: Receipt[]; totals: { targeted: number; read: number; acknowledged: number } }>(`/community/announcements/${a.id}/receipts`);
  const [show, setShow] = useState<'all' | 'pending'>('pending');
  const rows = (res.data?.items ?? []).filter((r) => show === 'all' || (a.requiredRead ? !r.acknowledgedAt : !r.readAt));
  return (
    <Drawer open onClose={onClose} title={t('receiptsTitle')} kicker={a.title}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={res.error} />
        {res.data && <p className="text-sm font-semibold">{t('receiptTotals', { targeted: res.data.totals.targeted, read: res.data.totals.read, acknowledged: res.data.totals.acknowledged })}</p>}
        <div className="flex gap-1.5"><Pill active={show === 'pending'} onClick={() => setShow('pending')}>{t('notYet')}</Pill><Pill active={show === 'all'} onClick={() => setShow('all')}>{t('everyone')}</Pill></div>
        <ul className="flex flex-col divide-y divide-line-soft">
          {rows.map((r) => (
            <li key={r.userId} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="font-semibold">{r.name}</span>
              <span className="text-xs text-stone">{r.email}</span>
              <span className="ml-auto">
                {r.acknowledgedAt ? <Badge tone="success">{t('confirmedAt', { when: relativeTime(r.acknowledgedAt, locale) })}</Badge>
                  : r.readAt ? <Badge tone="info">{t('openedAt', { when: relativeTime(r.readAt, locale) })}</Badge>
                    : <Badge tone="warning">{t('notOpened')}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Drawer>
  );
}
