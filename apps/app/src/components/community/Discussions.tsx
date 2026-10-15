'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Textarea, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { ErrorNote, Panel, PersonBadge, Pill, useAudienceText, useNet, useNetAction, type Audience, type NetMe } from './net';
import { Attachments, type Attachment } from './Announcements';
import { LoadingBlock } from '../ui/States';

interface Space { id: string; name: string; description: string | null; kind: 'discussion' | 'qa'; audience: Audience; postingPolicy: string; canPost: boolean; canModerate: boolean; threads: number; lastActivityAt: string | null }
type Reactions = { counts: Record<string, number>; mine: string[] };
interface ThreadRow { id: string; title: string; excerpt: string; author: { id: string; name: string; badge: string } | null; pinned: boolean; locked: boolean; hidden: boolean; answered: boolean; replyCount: number; lastActivityAt: string; reactions: Reactions }
interface ThreadView {
  space: Space;
  thread: { id: string; title: string; body: string; attachments: Attachment[]; author: ThreadRow['author']; pinned: boolean; locked: boolean; hidden: boolean; hiddenReason: string | null; acceptedReplyId: string | null; createdAt: string; reactions: Reactions; canAccept: boolean; canReply: boolean; canEdit: boolean };
  replies: { id: string; body: string; attachments: Attachment[]; author: ThreadRow['author']; hidden: boolean; hiddenReason: string | null; accepted: boolean; createdAt: string; reactions: Reactions }[];
  canModerate: boolean;
}

const REACTIONS: Record<string, string> = { like: '👍', love: '❤️', celebrate: '🎉', thanks: '🙏', insight: '💡' };

export function DiscussionsPanel({ me, threadId, onOpenThread }: { me: NetMe; threadId: string | null; onOpenThread: (id: string | null) => void }) {
  const t = useTranslations('community.disc');
  const spaces = useNet<{ items: Space[] }>('/community/spaces');
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const list = spaces.data?.items ?? [];
  const active = list.find((s) => s.id === spaceId) ?? list[0] ?? null;
  const audienceText = useAudienceText(me.directory);

  if (threadId) return <ThreadDetail id={threadId} me={me} onBack={() => onOpenThread(null)} />;
  return (
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
      <nav aria-label={t('spaces')} className="flex flex-col gap-1 rounded-xl bg-surface p-2">
        <ErrorNote error={spaces.error} />
        {spaces.loading && !spaces.data && <LoadingBlock variant="table" rows={2} />}
        {list.map((s) => (
          <button key={s.id} type="button" aria-current={active?.id === s.id ? 'true' : undefined} onClick={() => setSpaceId(s.id)} className={cx('flex flex-col items-start rounded-lg px-3 py-2.5 text-left', active?.id === s.id ? 'bg-lime' : 'hover:bg-canvas')}>
            <span className="flex items-center gap-1.5 text-sm font-bold"><Icon name={s.kind === 'qa' ? 'help' : s.audience.hqOnly ? 'lock' : 'hash'} size={15} />{s.name}</span>
            <span className="text-xs text-stone">{audienceText(s.audience)} · {t('threadCount', { count: s.threads })}</span>
          </button>
        ))}
        {!spaces.loading && !list.length && <p className="p-3 text-sm text-stone">{t('noSpaces')}</p>}
      </nav>
      {active ? <SpaceThreads key={active.id} space={active} me={me} onOpen={onOpenThread} /> : <span />}
    </div>
  );
}

function SpaceThreads({ space, me, onOpen }: { space: Space; me: NetMe; onOpen: (id: string) => void }) {
  const t = useTranslations('community.disc');
  const locale = useLocale();
  const [filter, setFilter] = useState<'all' | 'unanswered' | 'answered'>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const res = useNet<{ items: ThreadRow[] }>(`/community/spaces/${space.id}/threads?filter=${filter}${query ? `&q=${encodeURIComponent(query)}` : ''}`, [filter, query]);
  return (
    <Panel title={space.name} actions={space.canPost && <Button size="sm" variant="signal" icon="plus" onClick={() => setComposing(true)}>{space.kind === 'qa' ? t('ask') : t('newThread')}</Button>}>
      {space.description && <p className="-mt-2 text-[13px] text-stone">{space.description}</p>}
      {!space.canPost && <p className="rounded-md bg-canvas px-3 py-2 text-[13px] text-stone">{t('readOnly')}</p>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }} role="search">
        <Input aria-label={t('search')} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        {space.kind === 'qa' && (['all', 'unanswered', 'answered'] as const).map((f) => <Pill key={f} active={filter === f} onClick={() => setFilter(f)}>{t(`filter.${f}`)}</Pill>)}
      </form>
      {composing && <NewThread space={space} me={me} onCancel={() => setComposing(false)} onDone={(id) => { setComposing(false); onOpen(id); }} />}
      <ErrorNote error={res.error} />
      {res.loading && !res.data ? <LoadingBlock variant="table" rows={3} /> : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {(res.data?.items ?? []).map((th) => (
            <li key={th.id}>
              <button type="button" onClick={() => onOpen(th.id)} className="flex w-full flex-col gap-1 py-3 text-left hover:bg-canvas/60">
                <span className="flex flex-wrap items-center gap-2">
                  {th.pinned && <Icon name="flag" size={14} label={t('pinned')} />}
                  {th.locked && <Icon name="lock" size={14} label={t('locked')} />}
                  <span className="font-bold">{th.title}</span>
                  {space.kind === 'qa' && (th.answered ? <Badge tone="success">{t('answered')}</Badge> : <Badge tone="warning">{t('unanswered')}</Badge>)}
                  {th.hidden && <Badge tone="danger">{t('hidden')}</Badge>}
                </span>
                <span className="line-clamp-2 text-[13px] text-stone">{th.excerpt}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-stone">
                  {th.author?.name}{th.author && <PersonBadge badge={th.author.badge} />} · {t('replies', { count: th.replyCount })} · {relativeTime(th.lastActivityAt, locale)}
                </span>
              </button>
            </li>
          ))}
          {!res.loading && !(res.data?.items ?? []).length && <li className="py-6 text-sm text-stone">{t('noThreads')}</li>}
        </ul>
      )}
    </Panel>
  );
}

/** Text + optional @mentions picked from people who can see the space. */
function Composer({ spaceId, value, onChange, mentions, onMentions, label, rows = 4 }: { spaceId: string; value: string; onChange: (v: string) => void; mentions: { id: string; name: string }[]; onMentions: (m: { id: string; name: string }[]) => void; label: string; rows?: number }) {
  const t = useTranslations('community.disc');
  const people = useNet<{ items: { id: string; name: string }[] }>(`/community/people?spaceId=${spaceId}`);
  return (
    <div className="flex flex-col gap-2">
      <Field label={label}>{(p) => <Textarea id={p.id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />}</Field>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t('mention')} className="max-w-[220px]" value="" onChange={(e) => {
          const person = people.data?.items.find((x) => x.id === e.target.value);
          if (person && !mentions.some((m) => m.id === person.id)) { onMentions([...mentions, person]); onChange(`${value}${value.endsWith(' ') || !value ? '' : ' '}@${person.name} `); }
        }}>
          <option value="">{t('mention')}</option>
          {(people.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        {mentions.map((m) => <Badge key={m.id} tone="info">@{m.name}</Badge>)}
      </div>
    </div>
  );
}

function NewThread({ space, me, onCancel, onDone }: { space: Space; me: NetMe; onCancel: () => void; onDone: (id: string) => void }) {
  const t = useTranslations('community.disc');
  const act = useNetAction();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  void me;
  return (
    <form className="flex flex-col gap-3 rounded-lg border-[1.5px] border-line-soft p-3.5" onSubmit={async (e) => {
      e.preventDefault();
      const r = await act.run<{ id: string }>('post', `/community/spaces/${space.id}/threads`, { title, body, mentions: mentions.map((m) => m.id) });
      if (r) onDone(r.id);
    }}>
      <Field label={space.kind === 'qa' ? t('question') : t('threadTitle')} error={act.error?.fields?.title}>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
      <Composer spaceId={space.id} value={body} onChange={setBody} mentions={mentions} onMentions={setMentions} label={t('details')} />
      <ErrorNote error={act.error && !act.error.fields ? act.error : null} />
      <div className="flex gap-2"><Button type="submit" loading={act.pending} disabled={!title.trim() || !body.trim()}>{t('post')}</Button><Button type="button" variant="ghost" onClick={onCancel}>{t('cancel')}</Button></div>
    </form>
  );
}

function ReactionBar({ targetType, targetId, initial }: { targetType: 'thread' | 'reply'; targetId: string; initial: Reactions }) {
  const t = useTranslations('community.disc');
  const act = useNetAction();
  const [r, setR] = useState(initial);
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('react')}>
      {Object.entries(REACTIONS).map(([k, emoji]) => (
        <button key={k} type="button" aria-pressed={r.mine.includes(k)} aria-label={t(`reaction.${k}`)} title={t(`reaction.${k}`)} onClick={async () => {
          const out = await act.run<{ counts: Record<string, number>; mine: string[] }>('post', '/community/reactions', { targetType, targetId, reaction: k });
          if (out) setR({ counts: out.counts, mine: out.mine });
        }} className={cx('inline-flex h-8 items-center gap-1 rounded-full border px-2 text-[13px]', r.mine.includes(k) ? 'border-ink bg-canvas font-bold' : 'border-line-soft')}>
          <span aria-hidden="true">{emoji}</span>{r.counts[k] ? <span>{r.counts[k]}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ThreadDetail({ id, me, onBack }: { id: string; me: NetMe; onBack: () => void }) {
  const t = useTranslations('community.disc');
  const locale = useLocale();
  const res = useNet<ThreadView>(`/community/threads/${id}`, [id]);
  const act = useNetAction();
  const [reply, setReply] = useState('');
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  const [reporting, setReporting] = useState<{ type: 'thread' | 'reply'; id: string } | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Hiding a post asks for a reason in an in-page dialog (shown to the author and kept in the moderation log).
  const [hiding, setHiding] = useState<{ type: 'thread' | 'reply'; id: string } | null>(null);
  const [hideReason, setHideReason] = useState('');
  const v = res.data;
  void me;
  const moderate = async (targetType: 'thread' | 'reply', targetId: string, action: string, why?: string) => {
    if (action === 'hide' && !why) { setHideReason(''); setHiding({ type: targetType, id: targetId }); return; }
    if (await act.run('post', '/community/moderation', { targetType, targetId, action, reason: why })) { setHiding(null); void res.reload(); }
  };
  const ModTools = ({ type, targetId, hidden }: { type: 'thread' | 'reply'; targetId: string; hidden: boolean }) => (
    <div className="flex flex-wrap gap-1">
      {!v?.canModerate && <Button size="sm" variant="ghost" icon="flag" onClick={() => setReporting({ type, id: targetId })}>{t('report')}</Button>}
      {v?.canModerate && <Button size="sm" variant="ghost" icon={hidden ? 'eye' : 'x'} onClick={() => moderate(type, targetId, hidden ? 'unhide' : 'hide')}>{hidden ? t('unhide') : t('hide')}</Button>}
      {v?.canModerate && type === 'thread' && <Button size="sm" variant="ghost" icon={v.thread.locked ? 'unlock' : 'lock'} onClick={() => moderate('thread', targetId, v.thread.locked ? 'unlock' : 'lock')}>{v.thread.locked ? t('unlock') : t('lock')}</Button>}
      {v?.canModerate && type === 'thread' && <Button size="sm" variant="ghost" icon="flag" onClick={() => moderate('thread', targetId, v.thread.pinned ? 'unpin' : 'pin')}>{v.thread.pinned ? t('unpin') : t('pin')}</Button>}
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost" icon="arrow-left" className="self-start" onClick={onBack}>{t('back')}</Button>
      <ErrorNote error={res.error ?? act.error} />
      {notice && <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-[13px] font-semibold text-success">{notice}</p>}
      {!v ? <LoadingBlock variant="detail" /> : (
        <>
          <Panel>
            <div className="flex flex-wrap items-center gap-2 text-xs text-stone">
              <span>{v.space.name}</span>
              {v.thread.locked && <Badge tone="neutral" icon="lock">{t('locked')}</Badge>}
              {v.thread.hidden && <Badge tone="danger">{t('hiddenBecause', { reason: v.thread.hiddenReason ?? '' })}</Badge>}
            </div>
            <h2 className="text-xl font-bold">{v.thread.title}</h2>
            <p className="flex flex-wrap items-center gap-2 text-[13px] text-stone">{v.thread.author?.name}{v.thread.author && <PersonBadge badge={v.thread.author.badge} />} · {relativeTime(v.thread.createdAt, locale)}</p>
            <p className="whitespace-pre-line text-sm leading-relaxed">{v.thread.body}</p>
            <Attachments items={v.thread.attachments} />
            <div className="flex flex-wrap items-center justify-between gap-2"><ReactionBar targetType="thread" targetId={v.thread.id} initial={v.thread.reactions} /><ModTools type="thread" targetId={v.thread.id} hidden={v.thread.hidden} /></div>
          </Panel>
          <h3 className="px-1 text-sm font-bold">{t('replies', { count: v.replies.length })}</h3>
          <ul className="flex flex-col gap-2">
            {v.replies.map((r) => (
              <li key={r.id} className={cx('flex flex-col gap-2 rounded-xl bg-surface p-4', r.accepted && 'ring-2 ring-success', r.hidden && 'opacity-60')}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-bold">{r.author?.name}</span>{r.author && <PersonBadge badge={r.author.badge} />}
                  <span className="text-stone">{relativeTime(r.createdAt, locale)}</span>
                  {r.accepted && <Badge tone="success" icon="check-circle">{t('acceptedAnswer')}</Badge>}
                  {r.hidden && <Badge tone="danger">{t('hiddenBecause', { reason: r.hiddenReason ?? '' })}</Badge>}
                </div>
                <p className="whitespace-pre-line text-sm">{r.body}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <ReactionBar targetType="reply" targetId={r.id} initial={r.reactions} />
                  <div className="flex flex-wrap gap-1">
                    {v.thread.canAccept && !r.hidden && <Button size="sm" variant={r.accepted ? 'secondary' : 'ghost'} icon="check" onClick={async () => { if (await act.run('post', `/community/threads/${v.thread.id}/accept`, { replyId: r.accepted ? null : r.id })) void res.reload(); }}>{r.accepted ? t('unaccept') : t('accept')}</Button>}
                    <ModTools type="reply" targetId={r.id} hidden={r.hidden} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Drawer open={!!hiding} onClose={() => setHiding(null)} title={t('hide')}>
            <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (hiding && hideReason.trim()) void moderate(hiding.type, hiding.id, 'hide', hideReason.trim()); }}>
              <Field label={t('hideReason')}>{(p) => <Input id={p.id} value={hideReason} autoFocus onChange={(e) => setHideReason(e.target.value)} />}</Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" icon="x" loading={act.pending} disabled={!hideReason.trim()}>{t('hide')}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setHiding(null)}>{t('cancel')}</Button>
              </div>
            </form>
          </Drawer>
          {reporting && (
            <form className="flex flex-col gap-2 rounded-xl bg-surface p-4" onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run('post', '/community/reports', { targetType: reporting.type, targetId: reporting.id, reason })) { setReporting(null); setReason(''); setNotice(t('reported')); }
            }}>
              <Field label={t('reportReason')}>{(p) => <Input id={p.id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
              <div className="flex gap-2"><Button type="submit" size="sm" disabled={reason.trim().length < 3}>{t('sendReport')}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setReporting(null)}>{t('cancel')}</Button></div>
            </form>
          )}
          {v.thread.canReply ? (
            <form className="flex flex-col gap-2 rounded-xl bg-surface p-4" onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run('post', `/community/threads/${v.thread.id}/replies`, { body: reply, mentions: mentions.map((m) => m.id) })) { setReply(''); setMentions([]); void res.reload(); }
            }}>
              <Composer spaceId={v.space.id} value={reply} onChange={setReply} mentions={mentions} onMentions={setMentions} label={t('yourReply')} rows={3} />
              <Button type="submit" className="self-start" loading={act.pending} disabled={!reply.trim()} icon="send">{t('reply')}</Button>
            </form>
          ) : <p className="rounded-md bg-canvas px-3 py-2 text-[13px] text-stone">{v.thread.locked ? t('lockedNote') : t('readOnly')}</p>}
        </>
      )}
    </div>
  );
}
