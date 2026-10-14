import { View } from 'react-native';
import { Avatar, Badge, Card, DataStatus, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

export default function StaffMessages() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => api.staffMessages(), []);
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('staff.messagesTitle')} />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {(q.data ?? []).map((m) => (
        <Card key={m.id} padding={14}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Avatar name={m.author} uri={m.avatar} size={40} />
            <View style={{ flex: 1 }}>
              <Text weight={700}>{m.author}</Text>
              <Text variant="small" tone="muted">{relativeAgo(m.at, intlLocale)}</Text>
            </View>
            <Badge label={m.role === 'HQ' ? t('staff.fromHq') : m.role} tone={m.role === 'HQ' ? 'info' : 'neutral'} icon={m.role === 'HQ' ? 'building' : m.role === 'System' ? 'bell' : 'users'} />
          </View>
          <Text>{m.body}</Text>
        </Card>
      ))}
    </Screen>
  );
}
