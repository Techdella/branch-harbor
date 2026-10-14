import { Image, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Card, Text } from '@/components';
import { fmtMoney } from '@/lib/format';
import { radius } from '@/theme';
import type { RListing } from './api';
import { useRealtyStrings } from './strings';

/** Listing card used by the buyer search and saved homes. */
export function ListingRow({ l }: { l: RListing }) {
  const { s, intlLocale } = useRealtyStrings();
  return (
    <Card padding={0} onPress={() => router.push(`/realty/listing/${l.id}`)} accessibilityLabel={`${l.title}, ${fmtMoney(l.price as never, intlLocale)}`}>
      {l.photo ? <Image source={{ uri: l.photo.url }} style={{ height: 170, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }} accessibilityIgnoresInvertColors /> : null}
      <View style={{ padding: 14, gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Badge label={l.status === 'under_offer' ? s('underOffer') : l.status === 'coming_soon' ? s('comingSoon') : s('available')} tone={l.status === 'under_offer' ? 'warning' : l.status === 'coming_soon' ? 'info' : 'success'} />
        </View>
        <Text variant="h3">{l.title}</Text>
        <Text variant="bodyL" weight={800} tabular>{fmtMoney(l.price as never, intlLocale)} {l.rentPeriod === 'month' ? s('perMonth') : l.rentPeriod === 'week' ? s('perWeek') : ''}</Text>
        <Text variant="small" tone="muted">{[l.bedrooms != null ? `${l.bedrooms} bd` : null, l.bathrooms != null ? `${l.bathrooms} ba` : null, l.area ? `${l.area.value.toLocaleString(intlLocale)} ${l.area.label}` : s('unavailable')].filter(Boolean).join(' · ')} · {l.city}</Text>
      </View>
    </Card>
  );
}

