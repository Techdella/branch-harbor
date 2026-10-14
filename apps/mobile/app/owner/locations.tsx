import { Image, View } from 'react-native';
import { Badge, Card, DataStatus, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { regionName } from '@/features/customer/useLocationScope';
import { useLocations } from '@/features/shared/useLocations';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { radius } from '@/theme';

export default function OwnerLocations() {
  const { t, intlLocale } = useI18n();
  const { q } = useLocations();
  const brands = useApi(() => api.brands(), []);
  const now = new Date().toISOString();
  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('owner.locationsTitle')} scope={{ label: t('owner.allLocations'), icon: 'building' }} />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {(brands.data ?? []).map((b) => (
        <View key={b.id} style={{ gap: 10 }}>
          <SectionHeader title={b.name} />
          {(q.data ?? []).filter((l) => l.brandId === b.id).map((l) => (
            <Card key={l.id} padding={10}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Image source={{ uri: l.image }} style={{ width: 56, height: 56, borderRadius: radius.md }} accessibilityIgnoresInvertColors />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text weight={700}>{l.name}</Text>
                  <Text variant="small" tone="muted">{l.city}, {regionName(l.country, intlLocale)}</Text>
                  <Text variant="small" tone="muted">{fmtTime(now, l.timeZone, intlLocale)} {fmtZone(l.timeZone, intlLocale)} · {l.timeZone} · {l.currency}</Text>
                </View>
                <Badge label={l.status === 'operating' ? t('owner.operating') : t('owner.openingSoon')} tone={l.status === 'operating' ? 'success' : 'info'} icon={l.status === 'operating' ? 'check-circle' : 'calendar'} />
              </View>
            </Card>
          ))}
        </View>
      ))}
    </Screen>
  );
}
