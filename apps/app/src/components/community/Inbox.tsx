'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Select, Toggle, cx } from '@bh/ui';
import { relativeTime } from '@/lib/format';
import { ErrorNote, Panel, useNet, useNetAction } from './net';
import { LoadingBlock } from '../ui/States';

interface Note { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }
interface Prefs { inApp: boolean; push: boolean; emailDigest: 'off' | 'daily' | 'weekly'; mutedKinds: string[]; mutedSpaceIds: string[] }
const MUTABLE = ['announcement', 'mention', 'reply', 'event', 'coaching', 'course_assigned', 'course_lead', 'ticket_reply'] as const;

export function InboxPanel({ onNavigate, onChanged }: { onNavigate: (link: string) => void; onChanged: () => void }) {
  const t = useTranslations('community.inbox');
  const locale = useLocale();
  const res = useNet<{ items: Note[] }>('/community/notifications?limit=50');
  const act = useNetAction();
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
      <Panel title={t('title')} actions={<Button size="sm" variant="ghost" icon="check" onClick={async () => { if (await act.run('post', '/community/notifications/read', {})) { void res.reload(); onChanged(); } }}>{t('markAll')}</Button>}>
        <ErrorNote error={res.error ?? act.error} />
        {res.loading && !res.data ? <LoadingBlock variant="table" rows={3} /> : (
          <ul className="flex flex-col divide-y divide-line-soft">
            {(res.data?.items ?? []).map((n) => (
              <li key={n.id}>
                <button type="button" className={cx('flex w-full flex-col items-start gap-0.5 py-2.5 text-left', !n.readAt && 'font-semibold')} onClick={async () => {
                  if (!n.readAt) { await act.run('post', '/community/notifications/read', { ids: [n.id] }); onChanged(); }
                  if (n.link) onNavigate(n.link);
                }}>
                  <span className="flex items-center gap-2 text-sm">{!n.readAt && <span className="h-2 w-2 rounded-full bg-ink" aria-label={t('unread')} />}{n.title}</span>
                  {n.body && <span className="line-clamp-1 text-[13px] font-normal text-stone">{n.body}</span>}
                  <span className="text-xs font-normal text-stone">{t(`kinds.${n.kind}`)} · {relativeTime(n.createdAt, locale)}</span>
                </button>
              </li>
            ))}
            {!res.loading && !(res.data?.items ?? []).length && <li className="py-6 text-sm text-stone">{t('empty')}</li>}
          </ul>
        )}
      </Panel>
      <PrefsPanel />
    </div>
  );
}

function PrefsPanel() {
  const t = useTranslations('community.inbox');
  const res = useNet<Prefs>('/community/notification-prefs');
  const act = useNetAction();
  const [p, setP] = useState<Prefs | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (res.data) setP(res.data); }, [res.data]);
  const save = async (next: Prefs) => {
    setP(next);
    setSaved(false);
    if (await act.run('put', '/community/notification-prefs', next)) setSaved(true);
  };
  return (
    <Panel title={t('prefsTitle')}>
      <ErrorNote error={res.error ?? act.error} />
      {!p ? <LoadingBlock variant="table" rows={2} /> : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center justify-between gap-2"><span>{t('push')}</span><Toggle checked={p.push} onChange={(v) => save({ ...p, push: v })} label={t('push')} /></div>
          <label className="flex items-center justify-between gap-2">
            <span>{t('digest')}</span>
            <Select className="max-w-[150px]" value={p.emailDigest} onChange={(e) => save({ ...p, emailDigest: e.target.value as Prefs['emailDigest'] })}>
              {(['off', 'daily', 'weekly'] as const).map((d) => <option key={d} value={d}>{t(`digestOptions.${d}`)}</option>)}
            </Select>
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-bold">{t('notifyMeAbout')}</legend>
            {MUTABLE.map((k) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <span>{t(`kinds.${k}`)}</span>
                <Toggle checked={!p.mutedKinds.includes(k)} onChange={(on) => save({ ...p, mutedKinds: on ? p.mutedKinds.filter((x) => x !== k) : [...p.mutedKinds, k] })} label={t(`kinds.${k}`)} />
              </div>
            ))}
          </fieldset>
          <p className="text-xs text-stone">{t('alwaysOn')}</p>
          {saved && <Badge tone="success">{t('saved')}</Badge>}
        </div>
      )}
    </Panel>
  );
}

interface Report { id: string; targetType: string; targetId: string; threadId: string | null; excerpt: string; hidden: boolean; reason: string; reporter: string; createdAt: string }

export function ModerationPanel({ onOpenThread }: { onOpenThread: (id: string) => void }) {
  const t = useTranslations('community.mod');
  const locale = useLocale();
  const res = useNet<{ items: Report[] }>('/community/reports');
  const act = useNetAction();
  const [reason, setReason] = useState<Record<string, string>>({});
  return (
    <Panel title={t('title')}>
      <ErrorNote error={res.error ?? act.error} />
      {res.loading && !res.data ? <LoadingBlock variant="table" rows={2} /> : (
        <ul className="flex flex-col gap-2">
          {(res.data?.items ?? []).map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3">
              <p className="text-sm">“{r.excerpt}”</p>
              <p className="text-xs text-stone">{t('reportedBy', { name: r.reporter, when: relativeTime(r.createdAt, locale) })} · {r.reason}</p>
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={t('reason')} placeholder={t('reason')} value={reason[r.id] ?? r.reason} onChange={(e) => setReason({ ...reason, [r.id]: e.target.value })} className="h-9 min-w-[200px] flex-1 rounded-xs border border-line px-3 text-sm" />
                <Button size="sm" variant="danger" onClick={async () => { if (await act.run('post', '/community/moderation', { targetType: r.targetType, targetId: r.targetId, action: 'hide', reason: reason[r.id] ?? r.reason, reportId: r.id })) void res.reload(); }}>{t('hide')}</Button>
                <Button size="sm" variant="secondary" onClick={async () => { if (await act.run('post', `/community/reports/${r.id}/dismiss`, {})) void res.reload(); }}>{t('dismiss')}</Button>
                {r.threadId && <Button size="sm" variant="ghost" onClick={() => onOpenThread(r.threadId!)}>{t('view')}</Button>}
              </div>
            </li>
          ))}
          {!res.loading && !(res.data?.items ?? []).length && <li className="text-sm text-stone">{t('empty')}</li>}
        </ul>
      )}
    </Panel>
  );
}
