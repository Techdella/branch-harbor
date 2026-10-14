import { Image, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Card, DataStatus, Icon, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { regionName } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { fmtTime, fmtZone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { color, radius } from '@/theme';

export default function Locations() {
  const { t, intlLocale } = useI18n();
  const { setLocation } = useSession();
  const { brand, locations, location, locationsQ } = useCatalog();
  const now = new Date().toISOString();
  return (
    <Screen tabs={false}>
      <ScreenHeader title={t('customer.chooseLocation')} back />
      <Text tone="muted">{t('customer.chooseLocationSub')}</Text>
      <DataStatus q={locationsQ} />
      {locationsQ.loading ? <SkeletonCard /> : null}
      {locations.map((l) => {
        const selected = l.id === location?.id;
        const soon = l.status !== 'operating';
        return (
          <Card
            key={l.id}
            padding={10}
            onPress={() => {
              if (brand) setLocation(brand.id, l.id);
              router.back();
            }}
            accessibilityLabel={`${brand?.name ?? ''} ${l.name}, ${l.city}, ${regionName(l.country, intlLocale)}. ${l.currency}. ${soon ? t('customer.openingSoon') : ''}`}
            style={selected ? { borderWidth: 2, borderColor: color.ink } : undefined}
          >
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Image source={{ uri: l.image }} style={{ width: 64, height: 64, borderRadius: radius.md }} accessibilityIgnoresInvertColors />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="h3">{l.name}</Text>
                <Text variant="small" tone="muted">{l.city}, {regionName(l.country, intlLocale)}</Text>
                <Text variant="small" tone="muted">{fmtTime(now, l.timeZone, intlLocale)} {fmtZone(l.timeZone, intlLocale)} · {l.currency}</Text>
                {soon ? <Badge label={t('customer.openingSoon')} tone="info" icon="calendar" /> : null}
              </View>
              {selected ? <Icon name="check-circle" size={22} accessibilityLabel={t('common.confirm')} /> : null}
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
