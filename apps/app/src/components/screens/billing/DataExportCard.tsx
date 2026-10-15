'use client';

import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button } from '@bh/ui';
import { billingApi, type DataExport } from '@/lib/billing';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../../shell/AppContext';
import { Banner, SectionCard } from '../../ui/States';

const TONE = { ready: 'success', queued: 'info', running: 'info', failed: 'danger', expired: 'neutral' } as const;

/** Settings → Export your data (owner only): a free ZIP of CSVs, emailed as a 7-day link and listed here. */
export function DataExportCard() {
  const t = useTranslations('billing.export');
  const locale = useLocale();
  const app = useApp();
  const owner = app.session.assignments.some((a) => a.role === 'org_owner' && a.scope.kind === 'organization');
  const list = useApi(() => billingApi.exports(), [app.org.id], owner);
  const request = useMutation(() => billingApi.requestExport());
  const download = useMutation((_api, e: DataExport) => billingApi.download(e));
  const preparing = list.status === 'ready' && list.data.some((e) => e.status === 'queued' || e.status === 'running');
  useEffect(() => {
    if (!preparing) return;
    const id = setTimeout(() => list.reload(), 3000);
    return () => clearTimeout(id);
  }, [preparing, list]);
  if (!owner) return null;
  return (
    <section id="export">
      <SectionCard title={t('title')}>
        <div className="flex flex-col gap-3" data-testid="data-export">
          <p className="max-w-3xl text-sm text-graphite">{t('body')}</p>
          {request.error && <Banner tone="danger" live="assertive">{request.error.message}</Banner>}
          {download.error && <Banner tone="danger" live="assertive">{download.error.message}</Banner>}
          {preparing && <Banner tone="info" live="polite">{t('requested')}</Banner>}
          <div>
            <Button icon="download" loading={request.pending} disabled={preparing} onClick={async () => (await request.run()) && list.reload()}>
              {t('request')}
            </Button>
          </div>
          {list.status === 'ready' && list.data.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {list.data.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(e.createdAt))}</div>
                    <div className="text-xs text-stone">
                      {e.status === 'ready' && e.expiresAt ? `${t('files', { count: e.files.length })} · ${t('expires', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(e.expiresAt)) })}` : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={TONE[e.status]}>{t(`status.${e.status}`)}</Badge>
                    {e.status === 'ready' && (
                      <Button size="sm" variant="secondary" icon="download" loading={download.pending} onClick={() => download.run(e)}>
                        {t('download')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>
    </section>
  );
}
