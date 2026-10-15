'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Textarea, cx } from '@bh/ui';
import { INBOX_CHANNELS } from '@bh/shared';
import { relativeTime } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { inboxApi, type ConversationDetail, type Conversation } from './api';
import { CHANNEL_ICON, Chip, useCan, useLocationName, useScopeLocations } from './shared';

type StatusTab = 'open' | 'pending' | 'closed' | 'all';

/**
 * Unified inbox: email, SMS, WhatsApp, Instagram and Messenger conversations of the locations in scope (and the HQ
 * inbox for organisation-wide teams). Replies follow consent, opt-out and the 24-hour window rules enforced by the API.
 */
export function InboxScreen() {
  const t = useTranslations('comms.inbox');
  const app = useApp();
  const can = useCan();
  const scopeLocs = useScopeLocations();
  const [status, setStatus] = useState<StatusTab>('open');
  const [channel, setChannel] = useState<string>('');
  const [hqOnly, setHqOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const list = useApi(
    () => inboxApi.conversations({ status, channel: channel || undefined, inbox: hqOnly ? 'hq' : 'all', locationIds: !hqOnly && scopeLocs ? scopeLocs.join(',') : undefined }),
    [status, channel, hqOnly, scopeLocs?.join(','), app.org.id],
    can('marketing.inbox'),
  );
  const channels = useApi(() => inboxApi.channels(), [app.org.id], can('marketing.inbox'));
  if (!can('marketing.inbox')) return <DeniedState detail={t('denied')} />;
  const counts = Object.fromEntries((list.data?.counts ?? []).map((c) => [c.status, c.n]));
  const sandboxChannels = (channels.data?.items ?? []).filter((c) => c.mode === 'sandbox');

  return (
    <>
      <PageHeader
        icon="message"
        title={t('title')}
        description={t('description')}
        actions={can('marketing.inbox', 'edit') && sandboxChannels.length > 0 ? <Button variant="secondary" icon="send" onClick={() => setSimulating(true)}>{t('simulate.open')}</Button> : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          items={(['open', 'pending', 'closed', 'all'] as const).map((k) => ({ key: k, label: t(`status.${k}`), count: k === 'all' ? undefined : counts[k] ?? 0 }))}
          value={status}
          onChange={(k) => { setStatus(k); setSelected(null); }}
        />
        <div role="group" aria-label={t('channelFilter')} className="flex flex-wrap gap-1.5">
          <Chip active={!channel} onClick={() => setChannel('')}>{t('allChannels')}</Chip>
          {INBOX_CHANNELS.map((c) => <Chip key={c} active={channel === c} onClick={() => setChannel(c)}>{t(`channel.${c}`)}</Chip>)}
        </div>
        {list.data?.hq && <Chip active={hqOnly} onClick={() => setHqOnly(!hqOnly)}>{t('hqOnly')}</Chip>}
      </div>
      {channels.data && channels.data.items.length === 0 && <Banner tone="info" title={t('noChannels.title')}>{t('noChannels.body')}</Banner>}
      <Async res={list} loading={<LoadingBlock variant="table" rows={5} />}>
        {(data) => (
          <div className="grid min-h-[480px] gap-3 lg:grid-cols-[minmax(280px,380px)_1fr]">
            <ul className={cx('flex flex-col gap-1.5', selected && 'max-lg:hidden')} aria-label={t('listLabel')} data-testid="inbox-list">
              {data.items.length === 0 && <li><Empty icon="check-circle" title={t('empty')} /></li>}
              {data.items.map((c) => <ConversationRow key={c.id} c={c} active={selected === c.id} onSelect={() => setSelected(c.id)} />)}
            </ul>
            <div className={cx(!selected && 'max-lg:hidden')}>
              {selected ? (
                <Thread id={selected} onBack={() => setSelected(null)} onChanged={() => list.reload()} />
              ) : (
                <div className="hidden h-full items-center justify-center rounded-xl bg-surface p-8 text-sm text-stone lg:flex">{t('pick')}</div>
              )}
            </div>
          </div>
        )}
      </Async>
      <SimulateDrawer
        open={simulating}
        channels={sandboxChannels}
        onClose={() => setSimulating(false)}
        onDone={(convId) => { setSimulating(false); setStatus('open'); list.reload(); if (convId) setSelected(convId); }}
      />
    </>
  );
}

function ConversationRow({ c, active, onSelect }: { c: Conversation; active: boolean; onSelect: () => void }) {
  const t = useTranslations('comms.inbox');
  const locale = useLocale();
  const locName = useLocationName();
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined} className={cx('flex w-full flex-col gap-1 rounded-xl p-3.5 text-left transition', active ? 'bg-ink text-white' : 'bg-surface hover:shadow-card')}>
        <span className="flex items-center gap-2">
          <Icon name={CHANNEL_ICON[c.channel] ?? 'message'} size={15} />
          <span className="min-w-0 flex-1 truncate text-sm font-bold">{c.contactName ?? c.handle}</span>
          {c.unread > 0 && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-lime" aria-label={t('unread')} />}
          <span className={cx('shrink-0 text-xs', active ? 'text-white/80' : 'text-stone')}>{relativeTime(c.lastMessageAt, locale)}</span>
        </span>
        <span className={cx('line-clamp-2 text-[13px]', active ? 'text-white/90' : 'text-graphite')}>{c.lastMessagePreview}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={active ? 'text-white/80' : 'text-stone'}>{t(`channel.${c.channel}`)} · {locName(c.locationId)}</span>
          {c.slaBreached && <Badge tone="danger" icon="clock">{t('overdue')}</Badge>}
          {c.assignedUser && <span className={active ? 'text-white/80' : 'text-stone'}>· {c.assignedUser.name}</span>}
        </span>
      </button>
    </li>
  );
}

function Thread({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const t = useTranslations('comms.inbox');
  const locale = useLocale();
  const locName = useLocationName();
  const res = useApi(() => inboxApi.conversation(id), [id]);
  useEffect(() => { void inboxApi.read(id).catch(() => {}); }, [id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />}>
      {(d) => (
        <section className="flex h-full flex-col gap-3 rounded-xl bg-surface p-4 md:p-5" aria-label={t('threadLabel')} data-testid="inbox-thread">
          <header className="flex flex-wrap items-start gap-3">
            <button type="button" onClick={onBack} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-canvas lg:hidden" aria-label={t('back')}><Icon name="arrow-left" /></button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-bold">{d.conversation.contactName ?? d.conversation.handle}</h2>
              <p className="text-[13px] text-stone">{t(`channel.${d.conversation.channel}`)} · {d.conversation.handle} · {locName(d.conversation.locationId)}</p>
              {d.conversation.subject && <p className="text-[13px] font-semibold">{d.conversation.subject}</p>}
            </div>
            <ThreadControls d={d} onChanged={() => { res.reload(); onChanged(); }} />
          </header>
          <div className="flex flex-wrap gap-1.5">
            {d.customer && <Badge tone="info" icon="user">{t('linkedCustomer', { name: d.customer.name })}</Badge>}
            {d.lead && <Badge tone="neutral" icon="trending">{t('linkedLead', { status: t(`leadStatus.${d.lead.status}`) })}</Badge>}
            {d.conversation.channel === 'whatsapp' && (d.policy.window.open
              ? <Badge tone="success" icon="clock">{t('windowOpen', { time: relativeTime(d.policy.window.closesAt!, locale) })}</Badge>
              : <Badge tone="warning" icon="clock">{t('windowClosed')}</Badge>)}
            {d.policy.optedOut && <Badge tone="danger">{t('optedOut')}</Badge>}
          </div>
          <ol className="flex max-h-[52vh] flex-1 flex-col gap-2 overflow-y-auto pr-1" aria-label={t('messagesLabel')}>
            {d.messages.map((m) => (
              <li key={m.id} className={cx('max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm', m.direction === 'inbound' ? 'self-start bg-canvas' : m.direction === 'note' ? 'self-end border border-dashed border-warning bg-warning-bg' : 'self-end bg-ink text-white')}>
                {m.direction === 'note' && <span className="mb-1 block text-xs font-bold">{t('note')}</span>}
                <p className="whitespace-pre-wrap">{m.body}</p>
                <span className={cx('mt-1 block text-[11px]', m.direction === 'outbound' ? 'text-white/70' : 'text-stone')}>
                  {relativeTime(m.createdAt, locale)}{m.author?.name ? ` · ${m.author.name}` : ''}{m.direction === 'outbound' ? ` · ${t(`msgStatus.${m.status}`)}` : ''}
                </span>
              </li>
            ))}
          </ol>
          {d.canReply ? <Composer d={d} onSent={() => { res.reload(); onChanged(); }} /> : <Banner tone="neutral">{t('readOnly')}</Banner>}
        </section>
      )}
    </Async>
  );
}

function ThreadControls({ d, onChanged }: { d: ConversationDetail; onChanged: () => void }) {
  const t = useTranslations('comms.inbox');
  const people = useApi(() => inboxApi.assignees(d.conversation.locationId), [d.conversation.locationId], d.canReply);
  const upd = useMutation((_api, b: { status?: string; assignedUserId?: string | null }) => inboxApi.update(d.conversation.id, b));
  if (!d.canReply) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Select aria-label={t('statusLabel')} className="h-10 w-auto" value={d.conversation.status} onChange={async (e) => { if (await upd.run({ status: e.target.value })) onChanged(); }}>
        {(['open', 'pending', 'closed'] as const).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
      </Select>
      <Select aria-label={t('assignLabel')} className="h-10 w-auto" value={d.conversation.assignedUser?.id ?? ''} onChange={async (e) => { if (await upd.run({ assignedUserId: e.target.value || null })) onChanged(); }}>
        <option value="">{t('unassigned')}</option>
        {(people.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      {upd.error && <Banner tone="danger" live="assertive">{upd.error.message}</Banner>}
    </div>
  );
}

function Composer({ d, onSent }: { d: ConversationDetail; onSent: () => void }) {
  const t = useTranslations('comms.inbox');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState('');
  const canned = useApi(() => inboxApi.canned(d.conversation.locationId), [d.conversation.locationId]);
  const templates = useApi(() => inboxApi.templates(), [], d.conversation.channel === 'whatsapp');
  const approved = useMemo(() => (templates.data?.items ?? []).filter((x) => x.status === 'approved'), [templates.data]);
  const send = useMutation((_api, b: { kind: 'reply' | 'note'; body?: string; templateId?: string }) => inboxApi.send(d.conversation.id, b));
  const p = d.policy;
  const blocked = mode === 'reply' && p.blockedReason;
  const needsTemplate = mode === 'reply' && p.needsTemplate;

  const submit = async () => {
    const r = await send.run(needsTemplate ? { kind: 'reply', templateId } : { kind: mode, body });
    if (r) { setBody(''); setTemplateId(''); onSent(); }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line-soft pt-3" data-testid="inbox-composer">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs items={[{ key: 'reply', label: t('reply') }, { key: 'note', label: t('addNote') }]} value={mode} onChange={setMode} />
        {mode === 'reply' && !needsTemplate && (canned.data?.items.length ?? 0) > 0 && (
          <Select aria-label={t('canned')} className="h-10 w-auto" value="" onChange={(e) => { const c = canned.data!.items.find((x) => x.id === e.target.value); if (c) setBody((b) => (b ? `${b}\n${c.body}` : c.body)); }}>
            <option value="">{t('canned')}</option>
            {canned.data!.items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </Select>
        )}
      </div>
      {blocked && <Banner tone="warning" title={t(`blocked.${p.blockedReason}.title`)}>{t(`blocked.${p.blockedReason}.body`)}</Banner>}
      {needsTemplate && !blocked && (
        <>
          <Banner tone="info" title={t('template.title')}>{t('template.body')}</Banner>
          <Field label={t('template.pick')}>
            {(f) => (
              <Select id={f.id} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">{t('template.choose')}</option>
                {approved.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
          {templateId && <p className="rounded-md bg-canvas px-3 py-2 text-[13px]">{approved.find((x) => x.id === templateId)?.body}</p>}
        </>
      )}
      {!needsTemplate && !blocked && (
        <Field label={mode === 'note' ? t('noteLabel') : t('replyLabel')}>
          {(f) => <Textarea id={f.id} rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={mode === 'note' ? t('notePlaceholder') : t('replyPlaceholder')} className={mode === 'note' ? 'bg-warning-bg' : undefined} />}
        </Field>
      )}
      {send.error && <Banner tone="danger" live="assertive">{send.error.message}</Banner>}
      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={mode === 'note' ? 'edit' : 'send'} loading={send.pending} disabled={needsTemplate ? !templateId : !body.trim()} onClick={submit}>
            {mode === 'note' ? t('saveNote') : needsTemplate ? t('sendTemplate') : t('send')}
          </Button>
          {mode === 'reply' && <span className="text-xs text-stone">{t('sandboxNote')}</span>}
        </div>
      )}
    </div>
  );
}

function SimulateDrawer({ open, channels, onClose, onDone }: { open: boolean; channels: Array<{ id: string; channel: string; displayName: string }>; onClose: () => void; onDone: (conversationId?: string) => void }) {
  const t = useTranslations('comms.inbox');
  const [channelId, setChannelId] = useState('');
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const sim = useMutation((_api, id: string, b: { from: string; name?: string; body: string }) => inboxApi.simulate(id, b));
  const chosen = channels.find((c) => c.id === (channelId || channels[0]?.id));
  const placeholder = t(`simulate.placeholder.${chosen?.channel === 'email' ? 'email' : chosen?.channel === 'instagram' || chosen?.channel === 'messenger' ? 'meta' : 'phone'}`);
  return (
    <Drawer open={open} onClose={onClose} title={t('simulate.title')} kicker={t('simulate.kicker')}
      footer={<Button loading={sim.pending} disabled={!chosen || !from.trim() || !body.trim()} onClick={async () => { const r = await sim.run(chosen!.id, { from: from.trim(), name: name.trim() || undefined, body: body.trim() }); if (r) { setBody(''); onDone(r.results[0]?.conversationId); } }}>{t('simulate.submit')}</Button>}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-stone">{t('simulate.body')}</p>
        <Field label={t('simulate.channel')}>
          {(f) => <Select id={f.id} value={chosen?.id ?? ''} onChange={(e) => setChannelId(e.target.value)}>{channels.map((c) => <option key={c.id} value={c.id}>{c.displayName} · {t(`channel.${c.channel}`)}</option>)}</Select>}
        </Field>
        <Field label={t('simulate.from')}>{(f) => <Input id={f.id} value={from} onChange={(e) => setFrom(e.target.value)} placeholder={placeholder} />}</Field>
        <Field label={t('simulate.name')} optional>{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('simulate.message')}>{(f) => <Textarea id={f.id} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        {sim.error && <Banner tone="danger" live="assertive">{sim.error.message}</Banner>}
      </div>
    </Drawer>
  );
}
