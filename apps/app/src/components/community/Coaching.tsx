'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Button, Field, Icon, Input, Select, Textarea, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { ErrorNote, Panel, canDo, useNet, useNetAction, type NetMe } from './net';
import { LoadingBlock } from '../ui/States';

interface ThreadRow { id: string; scopeKind: string; scopeId: string; scopeName: string; manager: { id: string; name: string }; iAmManager: boolean; lastMessage: { body: string; at: string; mine: boolean } | null }
interface ThreadDetail { id: string; scopeName: string; manager: { id: string; name: string; bookingUrl: string | null; title: string | null }; messages: { id: string; body: string; author: { id: string; name: string } | null; mine: boolean; createdAt: string }[] }
interface AmRow { id: string; userId: string; name: string; email: string; scopeKind: string; scopeId: string; title: string | null; bookingUrl: string | null }

/** "Your HQ contact": account managers with a book-a-call link, and private 1:1 threads. */
export function CoachingPanel({ me, focusId }: { me: NetMe; focusId: string | null }) {
  const t = useTranslations('community.coach');
  const list = useNet<{ items: ThreadRow[]; available: { userId: string; name: string; bookingUrl: string | null }[] }>('/community/coaching');
  const [openId, setOpenId] = useState<string | null>(focusId);
  const act = useNetAction();
  const [firstMsg, setFirstMsg] = useState('');
  const [to, setTo] = useState('');

  return (
    <div className="flex flex-col gap-3">
      {me.accountManagers.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {me.accountManagers.map((m) => (
            <section key={m.id} className="flex flex-col gap-3 rounded-xl bg-ink p-5 text-white">
              <div className="flex items-center gap-3">
                <Avatar name={m.name} size={48} />
                <div>
                  <p className="text-xs uppercase tracking-wide text-white/70">{t('yourContact')}</p>
                  <h2 className="text-lg font-bold">{m.name}</h2>
                  {m.title && <p className="text-[13px] text-white/80">{m.title}</p>}
                </div>
              </div>
              {m.bio && <p className="text-[13px] leading-relaxed text-white/85">{m.bio}</p>}
              <div className="flex flex-wrap gap-2">
                {m.bookingUrl && <a href={m.bookingUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full bg-lime px-4 text-[13px] font-extrabold text-ink"><Icon name="calendar" size={15} />{t('bookCall')}</a>}
                <a href={`mailto:${m.email}`} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/40 px-4 text-[13px] font-bold"><Icon name="mail" size={15} />{t('email')}</a>
                {m.phone && <a href={`tel:${m.phone}`} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/40 px-4 text-[13px] font-bold"><Icon name="phone" size={15} />{m.phone}</a>}
              </div>
            </section>
          ))}
        </div>
      )}
      {!me.accountManagers.length && !me.hq && <p className="rounded-xl bg-surface p-4 text-sm text-stone">{t('noContact')}</p>}
      <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
        <Panel title={t('conversations')}>
          <ErrorNote error={list.error} />
          {list.loading && !list.data && <LoadingBlock variant="table" rows={2} />}
          <ul className="flex flex-col gap-1">
            {(list.data?.items ?? []).map((th) => (
              <li key={th.id}>
                <button type="button" onClick={() => setOpenId(th.id)} className={cx('flex w-full flex-col items-start rounded-lg px-3 py-2 text-left', openId === th.id ? 'bg-lime' : 'hover:bg-canvas')}>
                  <span className="text-sm font-bold">{th.iAmManager ? th.scopeName : th.manager.name}</span>
                  {th.lastMessage && <span className="line-clamp-1 text-xs text-stone">{th.lastMessage.mine ? t('you') : ''}{th.lastMessage.body}</span>}
                </button>
              </li>
            ))}
          </ul>
          {!!list.data?.available.length && (
            <form className="flex flex-col gap-2 border-t border-line-soft pt-3" onSubmit={async (e) => {
              e.preventDefault();
              const r = await act.run<{ id: string }>('post', '/community/coaching', { managerUserId: to || list.data!.available[0]!.userId, body: firstMsg });
              if (r) { setFirstMsg(''); setOpenId(r.id); void list.reload(); }
            }}>
              {list.data.available.length > 1 && <Select aria-label={t('to')} value={to} onChange={(e) => setTo(e.target.value)}>{list.data.available.map((a) => <option key={a.userId} value={a.userId}>{a.name}</option>)}</Select>}
              <Field label={t('startWith', { name: list.data.available.find((a) => a.userId === to)?.name ?? list.data.available[0]!.name })}>{(p) => <Textarea id={p.id} rows={2} value={firstMsg} onChange={(e) => setFirstMsg(e.target.value)} />}</Field>
              <ErrorNote error={act.error} />
              <Button type="submit" size="sm" icon="send" disabled={!firstMsg.trim()} loading={act.pending}>{t('send')}</Button>
            </form>
          )}
        </Panel>
        {openId ? <Conversation key={openId} id={openId} onSent={() => void list.reload()} /> : <Panel><p className="text-sm text-stone">{t('pick')}</p></Panel>}
      </div>
      {canDo(me, 'community.manage', true) && <ManagersAdmin me={me} />}
    </div>
  );
}

function Conversation({ id, onSent }: { id: string; onSent: () => void }) {
  const t = useTranslations('community.coach');
  const locale = useLocale();
  const res = useNet<ThreadDetail>(`/community/coaching/${id}`, [id]);
  const act = useNetAction();
  const [body, setBody] = useState('');
  const d = res.data;
  return (
    <Panel title={d ? (d.manager.title ? `${d.scopeName} · ${d.manager.name}` : d.scopeName) : undefined} actions={d?.manager.bookingUrl && <a href={d.manager.bookingUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-lime px-3.5 text-[13px] font-bold"><Icon name="calendar" size={15} />{t('bookCall')}</a>}>
      <p className="-mt-1 flex items-center gap-1.5 text-xs text-stone"><Icon name="lock" size={13} />{t('private')}</p>
      <ErrorNote error={res.error ?? act.error} />
      {!d ? <LoadingBlock variant="table" rows={2} /> : (
        <ul className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
          {d.messages.map((m) => (
            <li key={m.id} className={cx('max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm', m.mine ? 'self-end bg-ink text-white' : 'self-start bg-canvas')}>
              {!m.mine && <p className="text-xs font-bold">{m.author?.name}</p>}
              <p className="whitespace-pre-line">{m.body}</p>
              <p className={cx('mt-1 text-[11px]', m.mine ? 'text-white/70' : 'text-stone')}>{relativeTime(m.createdAt, locale)}</p>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run('post', `/community/coaching/${id}/messages`, { body })) { setBody(''); void res.reload(); onSent(); } }}>
        <Input aria-label={t('message')} placeholder={t('message')} value={body} onChange={(e) => setBody(e.target.value)} />
        <Button type="submit" icon="send" disabled={!body.trim()} loading={act.pending}>{t('send')}</Button>
      </form>
    </Panel>
  );
}

/** HQ: who looks after which franchisee, with their booking links. */
function ManagersAdmin({ me }: { me: NetMe }) {
  const t = useTranslations('community.coach');
  const res = useNet<{ items: AmRow[] }>('/community/account-managers');
  const people = useNet<{ items: { id: string; name: string }[] }>('/community/people');
  const act = useNetAction();
  const [userId, setUserId] = useState('');
  const [scope, setScope] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');
  const [title, setTitle] = useState('');
  const dir = me.directory;
  const scopeName = (kind: string, id: string) => (kind === 'region' ? dir?.regions : kind === 'owner_group' ? dir?.ownerGroups : dir?.locations)?.find((x) => x.id === id)?.name ?? id;
  return (
    <Panel title={t('adminTitle')}>
      <ErrorNote error={res.error ?? act.error} />
      <ul className="flex flex-col divide-y divide-line-soft text-sm">
        {(res.data?.items ?? []).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="font-bold">{m.name}</span><span className="text-stone">→ {scopeName(m.scopeKind, m.scopeId)}</span>
            {m.bookingUrl && <a href={m.bookingUrl} target="_blank" rel="noreferrer" className="text-[13px] underline">{t('bookingLink')}</a>}
            <Button size="sm" variant="ghost" icon="x" className="ml-auto" onClick={async () => { if (await act.run('del', `/community/account-managers/${m.id}`)) void res.reload(); }}>{t('remove')}</Button>
          </li>
        ))}
      </ul>
      <form className="grid gap-2 md:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const [scopeKind, scopeId] = scope.split(':');
        if (await act.run('post', '/community/account-managers', { userId, scopeKind, scopeId, bookingUrl: bookingUrl || null, title: title || null })) { setBookingUrl(''); setTitle(''); void res.reload(); }
      }}>
        <Field label={t('hqPerson')}>{(p) => <Select id={p.id} value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">{t('choose')}</option>{(people.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label={t('looksAfter')}>{(p) => (
          <Select id={p.id} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">{t('choose')}</option>
            {dir?.regions.map((r) => <option key={r.id} value={`region:${r.id}`}>{t('regionOption', { name: r.name })}</option>)}
            {dir?.ownerGroups.map((r) => <option key={r.id} value={`owner_group:${r.id}`}>{t('groupOption', { name: r.name })}</option>)}
            {dir?.locations.map((r) => <option key={r.id} value={`location:${r.id}`}>{t('locationOption', { name: r.name })}</option>)}
          </Select>
        )}</Field>
        <Field label={t('jobTitle')} optional>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('bookingLink')} hint={t('bookingHint')} optional>{(p) => <Input id={p.id} type="url" value={bookingUrl} onChange={(e) => setBookingUrl(e.target.value)} />}</Field>
        <Button type="submit" size="sm" className="self-start" disabled={!userId || !scope} loading={act.pending}>{t('assign')}</Button>
      </form>
    </Panel>
  );
}
