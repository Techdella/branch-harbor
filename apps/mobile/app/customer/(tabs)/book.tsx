import { useMemo, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Button, Card, DataStatus, EmptyState, MoneyText, Screen, ScreenHeader, SkeletonCard, Tag, Text } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { useLocationScope } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { addDaysKey, fmtTime, fmtZone, localDateKey, zonedToUtcIso } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { ClassOccurrence } from '@/lib/types';
import { color } from '@/theme';

export default function Book() {
  const { t, intlLocale } = useI18n();
  const { brand, location, locations } = useCatalog();
  const scope = useLocationScope(location, brand?.name);
  const tz = location?.timeZone ?? 'UTC';
  const todayKey = localDateKey(new Date(), tz);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysKey(todayKey, i)), [todayKey]);
  const [day, setDay] = useState(0);
  const dateKey = days[day] ?? todayKey;
  const q = useApi(() => (location ? api.classes(location.id, dateKey) : Promise.resolve([] as ClassOccurrence[])), [location?.id, dateKey]);

  if (!location) return <Screen><SkeletonCard /></Screen>;

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('book.title', { location: location.name })} scope={scope} />
      <Text variant="small" tone="muted">{t('common.timesIn', { zone: `${fmtZone(tz, intlLocale)} (${tz})` })}</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} accessibilityRole="tablist">
        {days.map((k, i) => {
          const noon = zonedToUtcIso(k, '12:00', tz);
          const wd = new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: tz }).format(new Date(noon));
          const dn = new Intl.DateTimeFormat(intlLocale, { day: 'numeric', timeZone: tz }).format(new Date(noon));
          const full = new Intl.DateTimeFormat(intlLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(new Date(noon));
          return <Tag key={k} label={wd} sub={dn} selected={i === day} onPress={() => setDay(i)} accessibilityLabel={i === 0 ? `${t('common.today')}, ${full}` : full} />;
        })}
      </ScrollView>

      <DataStatus q={q} />
      {q.loading ? <><SkeletonCard /><SkeletonCard /></> : null}
      {!q.loading && q.data && q.data.length === 0 ? (
        <EmptyState icon="calendar" title={location.status === 'operating' ? t('book.noClasses') : t('customer.openingSoon')} body={t('book.noClassesSub')} {...(locations.length > 1 ? { action: t('customer.chooseLocation'), onAction: () => router.push('/customer/locations') } : {})} />
      ) : null}
      {(q.data ?? []).map((c) => <ClassCard key={c.id} c={c} tz={tz} />)}
    </Screen>
  );
}

function ClassCard({ c, tz }: { c: ClassOccurrence; tz: string }) {
  const { t, intlLocale } = useI18n();
  const left = c.capacity - c.booked;
  const full = left <= 0;
  const started = new Date(c.startsAt).getTime() < Date.now();
  const time = fmtTime(c.startsAt, tz, intlLocale);
  const open = () => router.push(`/customer/class/${encodeURIComponent(c.id)}`);
  return (
    <Card padding={12}>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Image source={{ uri: c.image }} style={{ width: 64, height: 64, borderRadius: 16, opacity: started ? 0.5 : 1 }} accessibilityIgnoresInvertColors />
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="h3">{c.name}</Text>
          <Text variant="small" tone="muted">{time} · {t('book.minutes', { count: c.durationMin })} · {c.instructor}</Text>
          {started ? <Badge label={t('book.started')} tone="neutral" icon="clock" /> : full ? <Badge label={t('book.full')} tone="warning" icon="users" /> : <Badge label={t('book.spotsLeft', { count: left })} tone={left <= 2 ? 'warning' : 'success'} icon="users" />}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <MoneyText value={c.price} variant="h3" />
        {!started ? (
          <Button
            label={full ? t('book.waitlistCta') : t('book.bookCta')}
            variant={full ? 'secondary' : 'primary'}
            icon={full ? 'clock' : undefined}
            onPress={open}
            accessibilityLabel={`${full ? t('book.waitlistCta') : t('book.bookCta')}: ${c.name}, ${time}`}
          />
        ) : null}
      </View>
    </Card>
  );
}
