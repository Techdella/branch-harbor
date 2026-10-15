'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, Tabs, Textarea, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock } from '../ui/States';
import { ErrorNote, Panel, Pill, useNet, useNetAction, useNetMe, type NetMe } from '../community/net';
import { LibraryPanel } from '../community/Library';

type Clock = { dueAt: string | null; state: 'met' | 'missed' | 'on_track' | 'at_risk' | 'breached' | 'paused'; minutesLeft: number | null };
interface TicketRow {
  id: string; number: number; subject: string; priority: string; status: string; channel: string; category: { id: string; name: string } | null; location: { id: string; name: string } | null;
  requester: { id: string | null; name: string }; assignee: { id: string; name: string } | null; sla: { firstResponse: Clock; resolution: Clock } | null; satisfaction: number | null; createdAt: string; updatedAt: string;
}
interface TicketDetail { ticket: TicketRow & { satisfactionComment: string | null }; messages: { id: string; body: string; internal: boolean; author: { id: string | null; name: string; hq: boolean }; mine: boolean; createdAt: string }[]; canManage: boolean; canRate: boolean; suggestions: { id: string; title: string }[] }
interface Overview { agent: boolean; categories: { id: string; name: string; firstResponseMinutes: number; resolutionMinutes: number }[]; agents: { id: string; name: string }[]; inboundAddress: string | null; counts: Record<string, number>; sla: { breached: number; atRisk: number } | null; satisfaction: { average: number; responses: number } | null; myLocations: { id: string; name: string }[] }

const PRIORITY_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = { low: 'neutral', normal: 'info', high: 'warning', urgent: 'danger' };
const STATUS_TONE: Record<string, 'warning' | 'info' | 'neutral' | 'success'> = { open: 'warning', pending: 'info', on_hold: 'neutral', resolved: 'success', closed: 'neutral' };
const SLA_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = { met: 'success', on_track: 'info', at_risk: 'warning', breached: 'danger', missed: 'danger', paused: 'neutral' };

/** Help desk: franchisees and staff raise tickets to HQ; HQ works the queue with SLAs, notes and canned replies. */
export function HelpdeskScreen() {
  return <Helpdesk />;
}

function Helpdesk() {
  const t = useTranslations('helpdesk');
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const me = useNetMe();
  const ov = useNet<Overview>('/helpdesk/overview');
  const go = useCallback((q: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) next.set(k, v);
    router.replace(`${path}${next.size ? `?${next}` : ''}`, { scroll: false });
  }, [router, path]);
  const ticketId = params.get('ticket');
  const o = ov.data;
  const tabs = o?.agent ? (['queue', 'mine', 'new', 'kb', 'settings'] as const) : (['mine', 'new', 'kb'] as const);
  const tab = (tabs as readonly string[]).includes(params.get('tab') ?? '') ? params.get('tab')! : tabs[0];

  return (
    <>
      <PageHeader icon="help" title={t('title')} description={o?.agent ? t('descriptionHq') : t('description')} scope={false} />
      <ErrorNote error={ov.error ?? me.error} />
      {!o || !me.data ? <LoadingBlock variant="cards" rows={3} /> : ticketId ? (
        <TicketView id={ticketId} overview={o} onBack={() => go({ tab })} />
      ) : (
        <>
          {o.agent && o.sla && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[[t('stats.open'), (o.counts.open ?? 0) + (o.counts.pending ?? 0) + (o.counts.on_hold ?? 0), 'help'], [t('stats.breached'), o.sla.breached, 'alert'], [t('stats.atRisk'), o.sla.atRisk, 'clock'], [t('stats.csat'), o.satisfaction ? `${o.satisfaction.average} / 5` : '—', 'star']].map(([label, value, icon]) => (
                <div key={String(label)} className="flex items-center gap-3 rounded-xl bg-surface p-4"><Icon name={icon as 'help'} size={20} /><div><p className="text-xs text-stone">{label}</p><p className="text-2xl font-extrabold">{value}</p></div></div>
              ))}
            </div>
          )}
          <Tabs items={tabs.map((k) => ({ key: k, label: t(`tabs.${k}`) }))} value={tab as (typeof tabs)[number]} onChange={(k) => go({ tab: k })} />
          {tab === 'queue' && <TicketList scope="queue" onOpen={(id) => go({ ticket: id, tab })} />}
          {tab === 'mine' && <TicketList scope="mine" onOpen={(id) => go({ ticket: id, tab })} />}
          {tab === 'new' && <NewTicket overview={o} onDone={(id) => go({ ticket: id, tab: 'mine' })} />}
          {tab === 'kb' && <LibraryPanel me={me.data} helpOnly />}
          {tab === 'settings' && o.agent && <Settings overview={o} me={me.data} onChanged={() => void ov.reload()} />}
        </>
      )}
    </>
  );
}

function SlaBadge({ clock, label }: { clock: Clock; label: string }) {
  const t = useTranslations('helpdesk.sla');
  const left = clock.minutesLeft;
  const time = left === null ? '' : Math.abs(left) >= 120 ? t('hours', { count: Math.round(Math.abs(left) / 60) }) : t('minutes', { count: Math.abs(left) });
  return <Badge tone={SLA_TONE[clock.state] ?? 'neutral'}>{label}: {t(`state.${clock.state}`)}{(clock.state === 'on_track' || clock.state === 'at_risk') && time ? ` · ${t('left', { time })}` : clock.state === 'breached' && time ? ` · ${t('over', { time })}` : ''}</Badge>;
}

function TicketList({ scope, onOpen }: { scope: 'queue' | 'mine'; onOpen: (id: string) => void }) {
  const t = useTranslations('helpdesk');
  const locale = useLocale();
  const [status, setStatus] = useState<'active' | 'resolved' | 'all'>('active');
  const [assignee, setAssignee] = useState<'any' | 'me' | 'unassigned'>('any');
  const res = useNet<{ items: TicketRow[] }>(`/helpdesk/tickets?status=${status}${scope === 'mine' ? '&mine=true' : `&assignee=${assignee}`}`, [status, assignee, scope]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {(['active', 'resolved', 'all'] as const).map((s) => <Pill key={s} active={status === s} onClick={() => setStatus(s)}>{t(`filters.${s}`)}</Pill>)}
        {scope === 'queue' && (['any', 'me', 'unassigned'] as const).map((s) => <Pill key={s} active={assignee === s} onClick={() => setAssignee(s)}>{t(`assignee.${s}`)}</Pill>)}
      </div>
      <ErrorNote error={res.error} />
      {res.loading && !res.data ? <LoadingBlock variant="table" rows={4} /> : (
        <ul className="flex flex-col gap-2">
          {(res.data?.items ?? []).map((tk) => (
            <li key={tk.id}>
              <button type="button" onClick={() => onOpen(tk.id)} className="flex w-full flex-col gap-1.5 rounded-xl bg-surface p-4 text-left hover:ring-2 hover:ring-ink">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-stone">#{tk.number}</span>
                  <span className="font-bold">{tk.subject}</span>
                  <Badge tone={PRIORITY_TONE[tk.priority] ?? 'neutral'}>{t(`priority.${tk.priority}`)}</Badge>
                  <Badge tone={STATUS_TONE[tk.status] ?? 'neutral'}>{t(`status.${tk.status}`)}</Badge>
                </span>
                <span className="text-[13px] text-stone">{[tk.requester.name, tk.location?.name, tk.category?.name, tk.assignee ? t('assignedTo', { name: tk.assignee.name }) : t('unassigned')].filter(Boolean).join(' · ')} · {relativeTime(tk.updatedAt, locale)}</span>
                {tk.sla && !['resolved', 'closed'].includes(tk.status) && <span className="flex flex-wrap gap-1.5"><SlaBadge clock={tk.sla.firstResponse} label={t('sla.first')} /><SlaBadge clock={tk.sla.resolution} label={t('sla.resolution')} /></span>}
              </button>
            </li>
          ))}
          {!res.loading && !(res.data?.items ?? []).length && <li className="rounded-xl bg-surface p-6 text-sm text-stone">{t('empty')}</li>}
        </ul>
      )}
    </div>
  );
}

function NewTicket({ overview, onDone }: { overview: Overview; onDone: (id: string) => void }) {
  const t = useTranslations('helpdesk.form');
  const act = useNetAction();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [locationId, setLocationId] = useState(overview.myLocations.length === 1 ? overview.myLocations[0]!.id : '');
  const [attName, setAttName] = useState('');
  const [attUrl, setAttUrl] = useState('');
  const suggestions = useNet<{ items: { id: string; title: string; summary: string | null }[] }>(subject.trim().length > 3 ? `/resources?helpOnly=true&q=${encodeURIComponent(subject.trim())}&limit=3` : null, [subject]);
  const f = act.error?.fields ?? {};
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
      <Panel title={t('title')}>
        <form className="flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await act.run<TicketRow>('post', '/helpdesk/tickets', { subject, body, categoryId: categoryId || null, priority, locationId: locationId || null, attachments: attName && attUrl ? [{ name: attName, url: attUrl }] : [] });
          if (r) onDone(r.id);
        }}>
          <ErrorNote error={act.error && !Object.keys(f).length ? act.error : null} />
          <Field label={t('subject')} error={f.subject}>{(p) => <Input id={p.id} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />}</Field>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={t('category')} optional>{(p) => <Select id={p.id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">{t('other')}</option>{overview.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
            <Field label={t('priority')}>{(p) => <Select id={p.id} value={priority} onChange={(e) => setPriority(e.target.value)}>{(['low', 'normal', 'high', 'urgent'] as const).map((x) => <option key={x} value={x}>{t(`priorities.${x}`)}</option>)}</Select>}</Field>
            <Field label={t('location')} optional>{(p) => <Select id={p.id} value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">{t('noLocation')}</option>{overview.myLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
          </div>
          <Field label={t('details')} error={f.body}>{(p) => <Textarea id={p.id} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('attachmentName')} optional>{(p) => <Input id={p.id} value={attName} onChange={(e) => setAttName(e.target.value)} />}</Field>
            <Field label={t('attachmentUrl')} optional>{(p) => <Input id={p.id} type="url" value={attUrl} onChange={(e) => setAttUrl(e.target.value)} />}</Field>
          </div>
          <Button type="submit" className="self-start" icon="send" loading={act.pending} disabled={subject.trim().length < 3 || !body.trim()}>{t('submit')}</Button>
        </form>
      </Panel>
      <Panel title={t('maybeHelpful')}>
        {!(suggestions.data?.items ?? []).length ? <p className="text-sm text-stone">{t('suggestHint')}</p> : (
          <ul className="flex flex-col gap-2">{suggestions.data!.items.map((s) => <li key={s.id} className="rounded-lg bg-canvas p-3 text-sm"><p className="font-bold">{s.title}</p>{s.summary && <p className="text-[13px] text-stone">{s.summary}</p>}</li>)}</ul>
        )}
      </Panel>
    </div>
  );
}

function TicketView({ id, overview, onBack }: { id: string; overview: Overview; onBack: () => void }) {
  const t = useTranslations('helpdesk');
  const locale = useLocale();
  const res = useNet<TicketDetail>(`/helpdesk/tickets/${id}`, [id]);
  const canned = useNet<{ items: { id: string; title: string; body: string }[] }>(overview.agent ? '/helpdesk/canned-replies' : null);
  const act = useNetAction();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const d = res.data;
  const patch = async (b: Record<string, unknown>) => { if (await act.run('patch', `/helpdesk/tickets/${id}`, b)) void res.reload(); };
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant="ghost" icon="arrow-left" className="self-start" onClick={onBack}>{t('back')}</Button>
      <ErrorNote error={res.error ?? act.error} />
      {!d ? <LoadingBlock variant="detail" /> : (
        <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
          <Panel>
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-bold text-stone">#{d.ticket.number}</span><Badge tone={PRIORITY_TONE[d.ticket.priority] ?? 'neutral'}>{t(`priority.${d.ticket.priority}`)}</Badge><Badge tone={STATUS_TONE[d.ticket.status] ?? 'neutral'}>{t(`status.${d.ticket.status}`)}</Badge>{d.ticket.channel === 'email' && <Badge tone="neutral" icon="mail">{t('viaEmail')}</Badge>}</div>
            <h2 className="text-xl font-bold">{d.ticket.subject}</h2>
            <ul className="flex flex-col gap-2">
              {d.messages.map((m) => (
                <li key={m.id} className={cx('flex flex-col gap-1 rounded-xl p-3.5 text-sm', m.internal ? 'border-[1.5px] border-dashed border-warning bg-warning-bg' : m.author.hq ? 'bg-canvas' : 'bg-surface ring-1 ring-line-soft')}>
                  <span className="flex flex-wrap items-center gap-2 text-[13px]"><span className="font-bold">{m.author.name}</span>{m.author.hq && <Badge tone="info">{t('hq')}</Badge>}{m.internal && <Badge tone="warning" icon="lock">{t('internalNote')}</Badge>}<span className="text-stone">{relativeTime(m.createdAt, locale)}</span></span>
                  <p className="whitespace-pre-line">{m.body}</p>
                </li>
              ))}
            </ul>
            {d.ticket.status !== 'closed' || d.canManage ? (
              <form className="flex flex-col gap-2 border-t border-line-soft pt-3" onSubmit={async (e) => {
                e.preventDefault();
                if (await act.run('post', `/helpdesk/tickets/${id}/messages`, { body, internal })) { setBody(''); void res.reload(); }
              }}>
                {d.canManage && (canned.data?.items ?? []).length > 0 && (
                  <Select aria-label={t('canned')} value="" onChange={(e) => { const c = canned.data!.items.find((x) => x.id === e.target.value); if (c) setBody(body ? `${body}\n\n${c.body}` : c.body); }} className="max-w-xs">
                    <option value="">{t('canned')}</option>
                    {canned.data!.items.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                  </Select>
                )}
                <Field label={internal ? t('noteLabel') : t('replyLabel')}>{(p) => <Textarea id={p.id} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" icon={internal ? 'lock' : 'send'} loading={act.pending} disabled={!body.trim()}>{internal ? t('addNote') : t('send')}</Button>
                  {d.canManage && <Pill active={internal} onClick={() => setInternal(!internal)}>{t('internalToggle')}</Pill>}
                </div>
              </form>
            ) : <p className="text-[13px] text-stone">{t('closedNote')}</p>}
            {d.canRate && !d.ticket.satisfaction && (
              <form className="flex flex-col gap-2 rounded-lg bg-lime p-4" onSubmit={async (e) => { e.preventDefault(); if (await act.run('post', `/helpdesk/tickets/${id}/rating`, { score: rating, comment: comment || undefined })) void res.reload(); }}>
                <p className="font-bold">{t('rateTitle')}</p>
                <div className="flex gap-1" role="radiogroup" aria-label={t('rateTitle')}>
                  {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={t('stars', { count: n })} onClick={() => setRating(n)} className={cx('flex h-10 w-10 items-center justify-center rounded-full', rating >= n ? 'bg-ink text-white' : 'bg-white')}><Icon name="star" size={18} /></button>)}
                </div>
                <Input aria-label={t('rateComment')} placeholder={t('rateComment')} value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button type="submit" size="sm" className="self-start" disabled={!rating}>{t('rateSend')}</Button>
              </form>
            )}
            {d.ticket.satisfaction && <p className="text-sm font-semibold">{t('rated', { score: d.ticket.satisfaction })}</p>}
          </Panel>
          <Panel title={t('details')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <dt className="text-stone">{t('requester')}</dt><dd className="font-semibold">{d.ticket.requester.name}</dd>
              {d.ticket.location && <><dt className="text-stone">{t('location')}</dt><dd className="font-semibold">{d.ticket.location.name}</dd></>}
              <dt className="text-stone">{t('opened')}</dt><dd>{new Date(d.ticket.createdAt).toLocaleString(locale)}</dd>
            </dl>
            {d.ticket.sla && !['resolved', 'closed'].includes(d.ticket.status) && <div className="flex flex-wrap gap-1.5"><SlaBadge clock={d.ticket.sla.firstResponse} label={t('sla.first')} /><SlaBadge clock={d.ticket.sla.resolution} label={t('sla.resolution')} /></div>}
            {d.canManage ? (
              <div className="flex flex-col gap-2">
                <Field label={t('statusLabel')}>{(p) => <Select id={p.id} value={d.ticket.status} onChange={(e) => patch({ status: e.target.value })}>{(['open', 'pending', 'on_hold', 'resolved', 'closed'] as const).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}</Select>}</Field>
                <Field label={t('priorityLabel')}>{(p) => <Select id={p.id} value={d.ticket.priority} onChange={(e) => patch({ priority: e.target.value })}>{(['low', 'normal', 'high', 'urgent'] as const).map((s) => <option key={s} value={s}>{t(`priority.${s}`)}</option>)}</Select>}</Field>
                <Field label={t('assigneeLabel')}>{(p) => <Select id={p.id} value={d.ticket.assignee?.id ?? ''} onChange={(e) => patch({ assigneeId: e.target.value || null })}><option value="">{t('unassigned')}</option>{overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
                <Field label={t('categoryLabel')}>{(p) => <Select id={p.id} value={d.ticket.category?.id ?? ''} onChange={(e) => patch({ categoryId: e.target.value || null })}><option value="">{t('noCategory')}</option>{overview.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
              </div>
            ) : (
              <>
                {d.ticket.status === 'resolved' && <Button size="sm" variant="secondary" onClick={() => patch({ status: 'open' })}>{t('reopen')}</Button>}
              </>
            )}
            {d.suggestions.length > 0 && <><h3 className="text-sm font-bold">{t('related')}</h3><ul className="flex flex-col gap-1 text-[13px]">{d.suggestions.map((s) => <li key={s.id} className="flex items-center gap-1.5"><Icon name="book" size={14} />{s.title}</li>)}</ul></>}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Settings({ overview, me, onChanged }: { overview: Overview; me: NetMe; onChanged: () => void }) {
  const t = useTranslations('helpdesk.settings');
  const act = useNetAction();
  const canned = useNet<{ items: { id: string; title: string; body: string }[] }>('/helpdesk/canned-replies');
  const [name, setName] = useState('');
  const [fr, setFr] = useState('240');
  const [rs, setRs] = useState('2880');
  const [cTitle, setCTitle] = useState('');
  const [cBody, setCBody] = useState('');
  void me;
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title={t('emailIn')}>
        <p className="text-[13px] text-stone">{t('emailInHint')}</p>
        {overview.inboundAddress && <code className="break-all rounded-lg bg-canvas p-3 text-[13px]">{overview.inboundAddress}</code>}
      </Panel>
      <Panel title={t('categories')}>
        <ErrorNote error={act.error} />
        <ul className="flex flex-col divide-y divide-line-soft text-sm">
          {overview.categories.map((c) => <li key={c.id} className="flex flex-wrap gap-2 py-2"><span className="font-semibold">{c.name}</span><span className="text-stone">{t('targets', { first: c.firstResponseMinutes, resolve: c.resolutionMinutes })}</span></li>)}
        </ul>
        <form className="grid gap-2 sm:grid-cols-[1fr_110px_110px_auto] sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (await act.run('post', '/helpdesk/categories', { name, firstResponseMinutes: Number(fr), resolutionMinutes: Number(rs) })) { setName(''); onChanged(); } }}>
          <Field label={t('name')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('firstResponse')}>{(p) => <Input id={p.id} type="number" min={5} value={fr} onChange={(e) => setFr(e.target.value)} />}</Field>
          <Field label={t('resolution')}>{(p) => <Input id={p.id} type="number" min={15} value={rs} onChange={(e) => setRs(e.target.value)} />}</Field>
          <Button type="submit" size="sm" disabled={!name.trim()}>{t('add')}</Button>
        </form>
        <p className="text-xs text-stone">{t('priorityNote')}</p>
      </Panel>
      <Panel title={t('canned')}>
        <ul className="flex flex-col gap-2 text-sm">
          {(canned.data?.items ?? []).map((c) => <li key={c.id} className="flex flex-col gap-0.5 rounded-lg bg-canvas p-3"><span className="flex items-center gap-2 font-bold">{c.title}<Button size="sm" variant="ghost" icon="x" className="ml-auto" onClick={async () => { if (await act.run('del', `/helpdesk/canned-replies/${c.id}`)) void canned.reload(); }}>{t('delete')}</Button></span><span className="text-[13px] text-stone">{c.body}</span></li>)}
        </ul>
        <form className="flex flex-col gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run('post', '/helpdesk/canned-replies', { title: cTitle, body: cBody })) { setCTitle(''); setCBody(''); void canned.reload(); } }}>
          <Field label={t('cannedTitle')}>{(p) => <Input id={p.id} value={cTitle} onChange={(e) => setCTitle(e.target.value)} />}</Field>
          <Field label={t('cannedBody')}>{(p) => <Textarea id={p.id} rows={3} value={cBody} onChange={(e) => setCBody(e.target.value)} />}</Field>
          <Button type="submit" size="sm" className="self-start" disabled={!cTitle.trim() || !cBody.trim()}>{t('add')}</Button>
        </form>
      </Panel>
    </div>
  );
}
