'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs } from '@bh/ui';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock } from '../ui/States';
import { AnnouncementsPanel } from './Announcements';
import { CoachingPanel } from './Coaching';
import { DiscussionsPanel } from './Discussions';
import { EventsPanel } from './Events';
import { InboxPanel, ModerationPanel } from './Inbox';
import { LibraryPanel } from './Library';
import { ErrorNote, canDo, useNetMe, useNetUpdates } from './net';

const TABS = ['feed', 'discussions', 'library', 'events', 'contact', 'inbox', 'moderation'] as const;
type Tab = (typeof TABS)[number];

/**
 * Community workspace: HQ announcements (required reads), discussion spaces, the resource library, events, the
 * franchisee's HQ contact with private coaching threads, notifications and moderation. Deep links:
 * ?announcement=…, ?thread=…, ?coaching=…, ?tab=….
 */
export function CommunityScreen() {
  return <Community />;
}

function Community() {
  const t = useTranslations('community');
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const me = useNetMe();
  const threadId = params.get('thread');
  const coachingId = params.get('coaching');
  const annId = params.get('announcement');
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : threadId ? 'discussions' : coachingId ? 'contact' : 'feed';
  const go = useCallback((q: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) next.set(k, v);
    router.replace(`${path}${next.size ? `?${next}` : ''}`, { scroll: false });
  }, [router, path]);
  useNetUpdates(() => void me.reload());

  if (!me.data) return <>{me.error ? <ErrorNote error={me.error} /> : <LoadingBlock variant="cards" rows={3} />}</>;
  const m = me.data;
  const moderator = canDo(m, 'community.moderate');
  const tabs = TABS.filter((k) => k !== 'moderation' || moderator).map((k) => ({
    key: k, label: t(`tabs.${k}`),
    count: k === 'feed' ? m.counters.requiredReadsPending || undefined : k === 'inbox' ? m.counters.unreadNotifications || undefined : undefined,
  }));
  const openLink = (link: string) => {
    const u = new URL(link, window.location.origin);
    if (u.pathname === path) go(Object.fromEntries(u.searchParams.entries()));
    else router.push(link);
  };

  return (
    <>
      <PageHeader icon="message" title={t('title')} description={m.hq ? t('descriptionHq') : t('description')} scope={false} />
      <Tabs items={tabs} value={tab} onChange={(k) => go({ tab: k })} />
      {tab === 'feed' && <AnnouncementsPanel me={m} focusId={annId} onChanged={() => void me.reload()} />}
      {tab === 'discussions' && <DiscussionsPanel me={m} threadId={threadId} onOpenThread={(id) => go({ tab: 'discussions', thread: id })} />}
      {tab === 'library' && <LibraryPanel me={m} />}
      {tab === 'events' && <EventsPanel me={m} />}
      {tab === 'contact' && <CoachingPanel me={m} focusId={coachingId} />}
      {tab === 'inbox' && <InboxPanel onNavigate={openLink} onChanged={() => void me.reload()} />}
      {tab === 'moderation' && moderator && <ModerationPanel onOpenThread={(id) => go({ tab: 'discussions', thread: id })} />}
    </>
  );
}
