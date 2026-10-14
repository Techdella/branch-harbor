'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Tabs, cx } from '@bh/ui';
import { fmtDateTime } from '@/lib/format';
import type { SGuardianRel } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../../ui/States';
import { inputCls, useScopeIds } from './ui';

const REL_TONE = { verified: ['success', 'check-circle'], pending_verification: ['warning', 'clock'], disputed: ['danger', 'alert'], revoked: ['neutral', 'x'] } as const;

/** Guardian relationships (verification, disputes) and guardian ↔ location messages. */
export function GuardiansScreen() {
  const t = useTranslations('sportsHub.guardians');
  const tOps = useTranslations('ops.sports.guardians');
  const app = useApp();
  const [tab, setTab] = useState<'relationships' | 'disputes' | 'messages'>('disputes');
  if (!app.can('customers.read')) return <><PageHeader icon="user" title={tOps('title')} /><DeniedState permission="customers.read" /></>;
  return (
    <>
      <PageHeader icon="user" title={tOps('title')} description={tOps('description')} />
      <Tabs items={[{ key: 'disputes', label: t('tabDisputes') }, { key: 'relationships', label: t('tabRelationships') }, { key: 'messages', label: t('tabMessages') }]} value={tab} onChange={setTab} />
      {tab === 'disputes' && <Disputes />}
      {tab === 'relationships' && <Relationships />}
      {tab === 'messages' && <Messages />}
    </>
  );
}

function Disputes() {
  const t = useTranslations('sportsHub.guardians');
  const locale = useLocale();
  const app = useApp();
  const res = useSports((c) => c.disputes(), [app.role]);
  const resolve = useSportsAction((c, id: string, o: 'uphold' | 'dismiss', note: string) => c.resolveDispute(id, o, note).then(() => true));
  const [note, setNote] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <p className="text-sm text-stone">{t('disputeHelp')}</p>
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {resolve.error && <Banner tone="danger" live="assertive">{resolve.error.message}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={2} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="shield" title={t('noDisputes')} />}>
        {(items) => (
          <div className="grid gap-3 md:grid-cols-2">
            {items.map((d) => (
              <article key={d.id} className="flex flex-col gap-2 rounded-lg bg-surface p-4 text-sm">
                <div className="flex items-center justify-between gap-2"><strong>{d.participant.name}</strong><Badge tone="danger" icon="alert">{t('accessSuspended')}</Badge></div>
                <p>{t('disputeLine', { guardian: d.relationship.guardian?.name ?? '—', rel: d.relationship.relationship, by: d.raisedBy ?? t('staff') })}</p>
                <blockquote className="rounded-sm bg-canvas p-2 text-graphite">{d.reason}</blockquote>
                <p className="text-xs text-stone">{fmtDateTime(d.createdAt, 'UTC', locale)}</p>
                {app.can('customers.write') && (
                  <>
                    <label className="sr-only" htmlFor={`dn-${d.id}`}>{t('resolutionNote')}</label>
                    <input id={`dn-${d.id}`} className={inputCls} placeholder={t('resolutionNote')} value={note[d.id] ?? ''} onChange={(e) => setNote((n) => ({ ...n, [d.id]: e.target.value }))} />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="danger" disabled={(note[d.id] ?? '').trim().length < 3} loading={resolve.pending} onClick={async () => { if (await resolve.run(d.id, 'uphold', note[d.id]!)) { setMsg(t('upheld')); res.reload(); } }}>{t('uphold')}</Button>
                      <Button size="sm" variant="secondary" disabled={(note[d.id] ?? '').trim().length < 3} onClick={async () => { if (await resolve.run(d.id, 'dismiss', note[d.id]!)) { setMsg(t('dismissed')); res.reload(); } }}>{t('dismiss')}</Button>
                    </div>
                    <p className="text-xs text-stone">{t('resolveNote')}</p>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}

function Relationships() {
  const t = useTranslations('sportsHub.guardians');
  const app = useApp();
  const scope = useScopeIds();
  const res = useSports((c) => c.guardians(scope), [scope.join(','), app.role]);
  const verify = useSportsAction((c, id: string, note: string) => c.verifyRelationship(id, note).then(() => true));
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {verify.error && <Banner tone="danger">{verify.error.message}</Banner>}
      <label className="self-start"><span className="sr-only">{t('search')}</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} className="h-10 w-72 rounded-full border border-line bg-surface px-4 text-sm" /></label>
      <Async res={res} loading={<LoadingBlock variant="table" rows={5} />}>
        {({ items, invitations }) => {
          const ql = q.toLowerCase();
          const rows = items.filter((r: SGuardianRel) => !ql || r.participant.name.toLowerCase().includes(ql) || r.guardian?.name.toLowerCase().includes(ql));
          return (
            <>
              <div className="overflow-x-auto rounded-lg bg-surface">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-left text-xs text-stone"><th className="p-3">{t('participant')}</th><th>{t('guardian')}</th><th>{t('relationship')}</th><th>{t('status')}</th><th /></tr></thead>
                  <tbody>
                    {rows.slice(0, 200).map((r) => {
                      const [tone, icon] = REL_TONE[r.status];
                      return (
                        <tr key={r.id} className="border-t border-line-soft">
                          <td className="p-3 font-bold">{r.participant.name}</td>
                          <td>{r.guardian?.name}<div className="text-xs text-stone">{r.guardian?.email}{r.guardian?.hasAccount ? ` · ${t('hasAccount')}` : ''}</div></td>
                          <td>{r.relationship}</td>
                          <td><Badge tone={tone} icon={icon}>{t(`rel.${r.status}`)}</Badge></td>
                          <td className="pr-3 text-right">{r.status === 'pending_verification' && app.can('customers.write') && <Button size="sm" variant="secondary" loading={verify.pending} onClick={async () => { if (await verify.run(r.id, 'Verified in person by staff')) { setMsg(t('verified', { name: r.guardian?.name ?? '' })); res.reload(); } }}>{t('verify')}</Button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {invitations.length > 0 && <p className="text-xs text-stone">{t('pendingInvites', { n: invitations.length })}</p>}
              <p className="text-xs text-stone">{t('relHelp')}</p>
            </>
          );
        }}
      </Async>
    </>
  );
}

function Messages() {
  const t = useTranslations('sportsHub.guardians');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const res = useSports((c) => c.threads(scope), [scope.join(','), app.role]);
  const reply = useSportsAction((c, l: string, g: string, b: string) => c.reply(l, g, b).then(() => true));
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState('');
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.length === 0} empty={<Empty icon="message" title={t('noThreads')} />}>
      {(threads) => {
        const cur = threads.find((x) => `${x.locationId}:${x.guardian.id}` === sel) ?? threads[0]!;
        return (
          <div className="grid items-start gap-3 md:grid-cols-[280px_1fr]">
            <ul className="flex flex-col gap-1.5">
              {threads.map((x) => {
                const k = `${x.locationId}:${x.guardian.id}`;
                const active = cur === x;
                return (
                  <li key={k}><button type="button" onClick={() => setSel(k)} className={cx('w-full rounded-lg p-3 text-left text-sm', active ? 'bg-ink text-white' : 'bg-surface')}>
                    <div className="flex justify-between gap-2"><strong>{x.guardian.name}</strong>{x.unread > 0 && <Badge tone="info" icon={null}>{t('unread', { n: x.unread })}</Badge>}</div>
                    <div className={cx('truncate text-xs', active ? 'text-[#B9B9B3]' : 'text-stone')}>{x.locationName} · {x.messages.at(-1)?.body}</div>
                  </button></li>
                );
              })}
            </ul>
            <SectionCard title={cur.guardian.name} aside={<span className="text-xs text-stone">{cur.locationName}</span>}>
              <ol className="flex flex-col gap-2">
                {cur.messages.map((m) => (
                  <li key={m.id} className={cx('max-w-[80%] rounded-lg p-2.5 text-sm', m.direction === 'inbound' ? 'self-start bg-canvas' : 'self-end bg-ink text-white')}>
                    <p>{m.body}</p><p className={cx('mt-1 text-[11px]', m.direction === 'inbound' ? 'text-stone' : 'text-[#B9B9B3]')}>{fmtDateTime(m.createdAt, 'UTC', locale)}</p>
                  </li>
                ))}
              </ol>
              {app.can('customers.write') && (
                <div className="mt-3 flex gap-2">
                  <label className="sr-only" htmlFor="reply">{t('reply')}</label>
                  <input id="reply" className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('reply')} />
                  <Button icon="send" disabled={!text.trim()} loading={reply.pending} onClick={async () => { if (await reply.run(cur.locationId, cur.guardian.id, text)) { setText(''); res.reload(); } }}>{t('send')}</Button>
                </div>
              )}
              {reply.error && <p role="alert" className="mt-2 text-xs font-bold text-danger">{reply.error.message}</p>}
            </SectionCard>
          </div>
        );
      }}
    </Async>
  );
}
