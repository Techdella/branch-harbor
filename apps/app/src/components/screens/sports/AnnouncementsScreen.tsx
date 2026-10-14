'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button } from '@bh/ui';
import { fmtDateTime } from '@/lib/format';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock, SectionCard } from '../../ui/States';
import { FieldLabel, areaCls, inputCls, useScopeIds } from './ui';

/** Announcements to one team (its coach or a director) or one programme (directors). Never network-wide. */
export function AnnouncementsScreen() {
  const t = useTranslations('sportsHub.announcements');
  const tOps = useTranslations('ops.sports.announcements');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const director = app.can('customers.write');
  const res = useSports(async (c) => ({ list: await c.announcements(scope), teams: await c.teams(scope), programmes: director ? await c.programmes(scope) : [] }), [scope.join(','), app.role]);
  const send = useSportsAction((c, input: Parameters<typeof c.announce>[0]) => c.announce(input));
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <>
      <PageHeader icon="megaphone" title={tOps('title')} description={tOps('description')} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={2} />}>
        {({ list, teams, programmes }) => {
          const teamOpts = teams.filter((x) => director || x.youCoach);
          const [kind, id] = target.split(':') as ['team' | 'programme', string];
          const recipients = kind === 'team' ? teams.find((x) => x.id === id)?.rosterCount : kind === 'programme' ? programmes.find((p) => p.id === id)?.counts.accepted : undefined;
          return (
            <div className="grid items-start gap-3 lg:grid-cols-[1fr_1.3fr]">
              <SectionCard title={t('compose')}>
                {teamOpts.length === 0 && !programmes.length ? <p className="text-sm text-stone">{t('nothingToAnnounce')}</p> : (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="an-to">{t('to')}</FieldLabel>
                      <select id="an-to" className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)}>
                        <option value="">{t('choose')}</option>
                        <optgroup label={t('teams')}>{teamOpts.map((x) => <option key={x.id} value={`team:${x.id}`}>{x.name}</option>)}</optgroup>
                        {programmes.length > 0 && <optgroup label={t('programmes')}>{programmes.map((p) => <option key={p.id} value={`programme:${p.id}`}>{p.name}</option>)}</optgroup>}
                      </select></div>
                    <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="an-title">{t('titleLabel')}</FieldLabel><input id="an-title" className={inputCls} value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} /></div>
                    <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="an-body">{t('message')}</FieldLabel><textarea id="an-body" className={areaCls} value={body} onChange={(e) => setBody(e.target.value)} /></div>
                    {target && <p className="rounded-lg bg-canvas p-3 text-xs">{t('preview', { n: recipients ?? 0 })}</p>}
                    {send.error && <Banner tone="danger" live="assertive">{send.error.message}</Banner>}
                    <Button icon="send" disabled={!target || !title.trim() || !body.trim()} loading={send.pending} onClick={async () => {
                      const r = await send.run({ scopeKind: kind, scopeId: id, title, body });
                      if (r) { setMsg(t('sent', { n: r.recipientCount })); setTitle(''); setBody(''); res.reload(); }
                    }}>{t('send')}</Button>
                  </div>
                )}
              </SectionCard>
              <SectionCard title={t('history')}>
                {list.length === 0 ? <p className="text-sm text-stone">{t('none')}</p> : (
                  <ul className="flex flex-col gap-3">
                    {list.map((a) => (
                      <li key={a.id} className="rounded-lg bg-canvas p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2"><strong>{a.title}</strong><Badge tone="neutral" icon={a.scopeKind === 'team' ? 'users' : 'flag'}>{a.scopeName ?? t(a.scopeKind)}</Badge></div>
                        <p className="mt-1 whitespace-pre-line">{a.body}</p>
                        <p className="mt-1 text-xs text-stone">{t('meta', { n: a.recipientCount, by: a.createdByName ?? '—', at: fmtDateTime(a.createdAt, 'UTC', locale) })}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>
          );
        }}
      </Async>
    </>
  );
}
