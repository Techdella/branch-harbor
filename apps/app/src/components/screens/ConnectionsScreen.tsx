'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { Connection, ConnectionState } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { relativeTime } from '@/lib/format';
import { useState } from 'react';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';

const STATE: Record<ConnectionState, [Tone, IconName]> = {
  connected: ['success', 'check-circle'],
  initial_sync: ['info', 'refresh'],
  degraded: ['warning', 'alert'],
  disconnected: ['danger', 'wifi-off'],
  authorization_expired: ['danger', 'key'],
};
const PASTELS = ['#E9DDF8', '#CDEEEE', '#F7EDA8', '#E2F5A6', '#F8D6D8'];

export function ConnectionsScreen() {
  const t = useTranslations('connections');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.connections.list(app.ctx), [app.industry, app.role, app.scopeId], app.can('locations.read'));
  const fix = useMutation((api, id: string) => api.connections.fix(id));
  const [fixing, setFixing] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!app.can('locations.read')) return <DeniedState permission="locations.read" detail={t('denied')} />;
  const canManage = app.can('connections.manage');

  return (
    <>
      <PageHeader icon="plug" title={t('title')} description={t('description')} />
      {!canManage && <Banner tone="neutral" icon="lock">{t('readOnly')}</Banner>}
      {done && <Banner tone="success" live="polite">{t('fixed', { name: done })}</Banner>}
      {fix.error && <Banner tone="danger" live="assertive">{fix.error.message}</Banner>}
      <Async res={res} permission="locations.read" loading={<LoadingBlock variant="cards" rows={4} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="plug" title={t('empty')} />}>
        {(list) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
            {list.map((c: Connection, i) => {
              const [tone, icon] = STATE[c.state];
              return (
                <article key={c.id} className="flex flex-col gap-2.5 rounded-lg bg-surface p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[13px] font-extrabold" style={{ background: PASTELS[i % PASTELS.length] }} aria-hidden="true">
                      {c.monogram}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[15px] font-bold">{c.name}</h2>
                      <div className="truncate text-xs text-stone">{c.role}</div>
                    </div>
                    <Badge tone={tone} icon={icon}>
                      {t(`state.${c.state}`)}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="rounded-sm bg-canvas px-2.5 py-2">
                      <div className="text-stone">{t('lastSync')}</div>
                      <strong>{c.state === 'initial_sync' ? t('inProgress', { pct: c.progress ?? 0 }) : c.lastSync ? relativeTime(c.lastSync, locale) : t('never')}</strong>
                    </div>
                    <div className="rounded-sm bg-canvas px-2.5 py-2">
                      <div className="text-stone">{t('direction')}</div>
                      <strong className="flex items-center gap-1">
                        <Icon name={c.direction === 'import' ? 'arrow-down' : c.direction === 'export' ? 'arrow-up-right' : 'repeat'} size={12} />
                        {t(`dir.${c.direction}`)}
                      </strong>
                    </div>
                  </div>
                  {c.state === 'initial_sync' && (
                    <div className="h-1.5 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t('progress')}>
                      <div className="h-full bg-ink" style={{ width: `${c.progress ?? 0}%` }} />
                    </div>
                  )}
                  <p className="text-xs text-stone">
                    <Icon name="shield" size={11} className="mr-1 inline" />
                    {c.authoritative}
                  </p>
                  <p className="text-xs text-stone">{t('locations', { list: c.locations.join(', ') || '—' })}</p>
                  {c.issue && (
                    <>
                      <div className="rounded-[14px] bg-warning-bg px-3 py-2.5 text-xs leading-normal text-warning">
                        {c.issue}
                        {c.affected && <div className="mt-1 font-bold">{t('affected', { what: c.affected })}</div>}
                      </div>
                      <Button
                        size="sm"
                        disabled={!canManage}
                        loading={fixing === c.id}
                        onClick={async () => {
                          setFixing(c.id);
                          setDone(null);
                          const r = await fix.run(c.id);
                          setFixing(null);
                          if (r && res.status === 'ready') {
                            res.setData(res.data.map((x) => (x.id === r.id ? r : x)));
                            setDone(r.name);
                          }
                        }}
                      >
                        {c.fixAction}
                      </Button>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </>
  );
}
