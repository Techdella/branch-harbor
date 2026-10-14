import { useI18n } from '@/i18n';
import { useOnline } from '@/lib/network';
import { fmtTime } from '@/lib/format';
import type { ApiState } from '@/lib/useApi';
import { Banner } from './Banner';
import { ErrorState } from './EmptyState';

/**
 * Offline / stale-data / error banner for a fetched resource. Shows when data was last refreshed so
 * stale data is never presented as current.
 */
export function DataStatus<T>({ q }: { q: ApiState<T> }) {
  const { t, intlLocale } = useI18n();
  const online = useOnline();
  const time = q.updatedAt ? fmtTime(q.updatedAt.toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone, intlLocale) : '—';
  if (!online) return <Banner tone="warning" icon="wifi-off" title={t('common.offlineTitle')} body={t('common.offlineBody', { time })} action={t('common.retry')} onAction={q.refresh} />;
  if (q.stale) return <Banner tone="warning" icon="refresh" title={q.error?.message ?? t('common.errorTitle')} body={t('common.staleBody', { time })} action={t('common.retry')} onAction={q.refresh} />;
  if (q.error && q.data === undefined && !q.loading) return <ErrorState title={t('common.errorTitle')} body={q.error.message} retryLabel={t('common.retry')} onRetry={q.refresh} />;
  return null;
}
