import { Badge, Card, DataStatus, Screen, ScreenHeader, SkeletonCard, Text, type IconName, type Tone } from '@/components';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { AppNotification } from '@/lib/types';

export default function Alerts() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => api.notifications(), []);
  // Notifications distinguish information, required action and integration failure.
  const KIND: Record<AppNotification['kind'], { label: string; tone: Tone; icon: IconName }> = {
    info: { label: t('owner.info'), tone: 'info', icon: 'info' },
    action: { label: t('owner.actionRequired'), tone: 'warning', icon: 'flag' },
    integration: { label: t('owner.integration'), tone: 'danger', icon: 'plug' },
  };
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('owner.notificationsTitle')} />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {(q.data ?? []).map((n) => {
        const k = KIND[n.kind];
        return (
          <Card key={n.id}>
            <Badge label={k.label} tone={k.tone} icon={k.icon} />
            <Text variant="h3">{n.title}</Text>
            <Text>{n.body}</Text>
            <Text variant="small" tone="muted">{[n.locationName, relativeAgo(n.at, intlLocale)].filter(Boolean).join(' · ')}</Text>
          </Card>
        );
      })}
    </Screen>
  );
}
